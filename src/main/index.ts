import { app, BrowserWindow, dialog, Menu, session, shell, type IpcMainInvokeEvent } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { APP_ID, APP_NAME, RELEASES_URL } from '../shared/appIdentity'
import { IPC } from '../shared/ipc'
import type { AppInfo, ExportFormat, SafetyModeState, UpdateState } from '../shared/types'
import { registerIpc } from './ipc/registerIpc'
import { ArchiveService } from './services/archiveService'
import { ScanCache } from './services/cacheService'
import { envFromProcess } from './services/claudeDiscovery'
import { DeleteService } from './services/deleteService'
import { ExportService } from './services/exportService'
import { ManagerHiddenStore } from './services/managerHiddenStore'
import { ProcessService } from './services/processService'
import { resolveInitialMode, SafetyModeController } from './services/safetyMode'
import type { AppUpdater } from 'electron-updater'
import { detectUpdateMode, UpdateService, updateModeFor, usesGithubUpdater, type UpdaterLike } from './services/updateService'
import { readDistribution } from './distribution'
import { devFakeUpdater } from './services/devFakeUpdater'
import { SessionRepository } from './services/sessionRepository'
import { SettingsService } from './services/settingsService'
import { WatchService } from './services/watchService'
import { errorMessage, logger } from './util/logger'
import { localText } from './util/messages'
import { resolveLocale, type SupportedLocale } from '../shared/locale'
import { guardWindow } from './windowGuard'

app.setName(APP_NAME)
// Separate app data (and single-instance lock) for test/verification runs.
if (process.env.CLAUDE_SESSION_MANAGER_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.CLAUDE_SESSION_MANAGER_USER_DATA))
}
// github | store | development, from the packaged metadata (see src/shared/distribution.ts).
const distribution = readDistribution({
  appPath: app.getAppPath(),
  isPackaged: app.isPackaged,
  windowsStore: process.windowsStore === true,
  env: process.env
})
// Same ID the installer writes into the shortcuts, so the running window, the
// Start Menu entry and taskbar pins are one app across upgrades. A Store
// package gets its ID from the package identity instead; overriding it would
// split the taskbar/Start entries.
if (process.platform === 'win32' && distribution.channel !== 'store') app.setAppUserModelId(APP_ID)

let mainWindow: BrowserWindow | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      // A window that never became visible would otherwise block every new launch.
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  })
  app.whenReady().then(start).catch((err) => {
    logger.error(`Startup failed: ${errorMessage(err)}`)
    dialog.showErrorBox(APP_NAME, `Startup failed: ${errorMessage(err)}`)
    app.quit()
  })
}

async function start(): Promise<void> {
  const userData = app.getPath('userData')
  const logPath = path.join(userData, 'logs', 'main.log')
  await logger.setLogFile(logPath)

  // Every launch starts in SAFE MODE (dry run); see safetyMode.ts. Kept in memory only.
  const initialMode = resolveInitialMode({ isPackaged: app.isPackaged, env: process.env })
  const cachePath = path.join(userData, 'scan-cache', 'transcript-index.json')
  const appInfo: AppInfo = {
    name: APP_NAME,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: `${process.platform} ${process.arch}`,
    userDataPath: userData,
    cachePath,
    logPath,
    electronVersion: process.versions.electron,
    systemLanguages: systemLanguages(),
    distribution: distribution.channel,
    storeListingAvailable: distribution.storeProductId != null,
    userHome: os.homedir()
  }
  logger.info(
    `${APP_NAME} ${appInfo.version} starting (dryRun=${initialMode.dryRun}, packaged=${app.isPackaged}, distribution=${distribution.channel})`
  )
  if (initialMode.notice) logger.warn(initialMode.notice)

  const settings = new SettingsService(path.join(userData, 'settings.json'))
  await settings.load()
  logger.debugEnabled = settings.get().debugMode
  /** UI language for the few texts the main process shows itself (native dialogs). */
  const uiLocale = (): SupportedLocale => resolveLocale(settings.get().language, appInfo.systemLanguages)

  const cache = new ScanCache(cachePath)
  await cache.load()
  const hidden = new ManagerHiddenStore(path.join(userData, 'manager-hidden.json'))
  await hidden.load()

  const processes = new ProcessService(null)
  const safety = new SafetyModeController({ initial: initialMode, processes })
  const repo = new SessionRepository({ env: envFromProcess(), cache, hidden, processService: processes })
  const archive = new ArchiveService(repo, processes, hidden, () => safety.isDryRun())
  const deleter = new DeleteService(repo, processes, {
    dryRun: () => safety.isDryRun(),
    // Arming is single-use: any real delete execution returns the app to Safe Mode.
    onRealDeleteExecuted: () => safety.disarm('after-delete')
  })
  safety.on('changed', (state: SafetyModeState) => {
    logger.info(`Safety mode: ${state.dryRun ? 'SAFE MODE (dry run)' : 'REAL DELETE ARMED'} (${state.reason})`)
    mainWindow?.webContents.send(IPC.safetyModeChanged, state)
  })
  const exporter = new ExportService(repo, {
    chooseFile: async (defaultName: string, format: ExportFormat) => {
      const filters =
        format === 'markdown'
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : format === 'jsonl'
            ? [{ name: 'JSON Lines', extensions: ['jsonl'] }]
            : [{ name: 'JSON', extensions: ['json'] }]
      const opts = { defaultPath: path.join(app.getPath('documents'), defaultName), filters }
      const r = mainWindow ? await dialog.showSaveDialog(mainWindow, opts) : await dialog.showSaveDialog(opts)
      return r.canceled || !r.filePath ? null : r.filePath
    },
    chooseDirectory: async () => {
      const title = localText(uiLocale(), 'export.chooseFolder')
      const opts = { title, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
      const r = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    }
  })

  // Updates. GitHub channel: electron-updater + GitHub Releases (packaged builds
  // only). Store channel: the Store manages updates; electron-updater is never
  // loaded. Development: no updater (a fake one can be enabled to review the UI).
  const fakeUpdater = distribution.channel === 'store' ? null : devFakeUpdater({ isPackaged: app.isPackaged, env: process.env })
  const updateMode = fakeUpdater
    ? 'installed'
    : updateModeFor(distribution.channel, () =>
        detectUpdateMode({ isPackaged: app.isPackaged, execPath: process.execPath, productName: APP_NAME, env: process.env })
      )
  let updater: UpdaterLike | null = fakeUpdater
  if (usesGithubUpdater(updateMode) && !fakeUpdater) {
    try {
      // electron-updater exposes autoUpdater through a getter, which a dynamic
      // import from this CommonJS bundle places under `default`.
      const mod = (await import('electron-updater')) as unknown as {
        autoUpdater?: AppUpdater
        default?: { autoUpdater?: AppUpdater }
      }
      const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
      if (!autoUpdater) throw new Error('electron-updater did not provide autoUpdater')
      autoUpdater.logger = {
        info: (m?: unknown) => logger.info(`[updater] ${String(m)}`),
        warn: (m?: unknown) => logger.warn(`[updater] ${String(m)}`),
        error: (m?: unknown) => logger.error(`[updater] ${String(m)}`),
        debug: (m: string) => logger.debug(`[updater] ${m}`)
      }
      updater = autoUpdater as unknown as UpdaterLike
    } catch (err) {
      logger.warn(`Updater unavailable: ${errorMessage(err)}`)
    }
  }
  const updates = new UpdateService({
    mode: updateMode,
    currentVersion: app.getVersion(),
    releasesUrl: RELEASES_URL,
    updater,
    openExternal: (url) => shell.openExternal(url),
    storeProductId: distribution.storeProductId
  })
  updates.on('changed', (state: UpdateState) => mainWindow?.webContents.send(IPC.updateStateChanged, state))
  logger.info(`Update mode: ${updateMode}`)

  const watcher = new WatchService((reason) => {
    repo.scan(reason).catch((err) => logger.error(`Auto refresh failed: ${errorMessage(err)}`))
  })

  repo.on('changed', (snapshot) => {
    mainWindow?.webContents.send(IPC.sessionsChanged, snapshot)
    watcher.configure(settings.get(), repo.getRoots())
  })
  repo.on('scan-state', (state) => mainWindow?.webContents.send(IPC.scanStateChanged, state))

  registerIpc({
    repo,
    archive,
    deleter,
    exporter,
    processes,
    safety,
    updates,
    settings,
    cache,
    appInfo,
    onSettingsChanged: (next) => {
      logger.debugEnabled = next.debugMode
      watcher.configure(next, repo.getRoots())
    },
    isTrustedSender
  })

  hardenSession()
  Menu.setApplicationMenu(null)
  createWindow(settings, uiLocale, logPath)

  // Non-blocking GitHub update check a little after startup (never delays the window).
  // Only the GitHub channel checks; Store builds are updated by the Store.
  if (usesGithubUpdater(updateMode) && updater) {
    setTimeout(() => void updates.check('startup'), 8000).unref?.()
  }

  app.on('window-all-closed', () => {
    watcher.stop()
    safety.dispose()
    void cache.save().finally(() => app.quit())
  })
}

/** OS language preferences (first-run UI language), with the Chromium locale as a fallback. */
function systemLanguages(): string[] {
  try {
    const list = app.getPreferredSystemLanguages()
    if (list.length) return list
  } catch {
    /* older platforms */
  }
  return [app.getLocale()]
}

function rendererUrl(): string | undefined {
  return !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false
  const url = event.senderFrame?.url ?? ''
  const dev = rendererUrl()
  return (dev !== undefined && url.startsWith(dev)) || url.startsWith('file://')
}

function hardenSession(): void {
  // Only "copy path" needs a permission; everything else is denied.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (e, url) => {
      if (url !== contents.getURL()) e.preventDefault()
    })
  })
}

function createWindow(settings: SettingsService, uiLocale: () => SupportedLocale, logPath: string): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 620,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0b0c0c',
    autoHideMenuBar: true,
    icon: app.isPackaged ? undefined : path.join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  const win = mainWindow
  win.on('closed', () => {
    mainWindow = null
  })
  // Never leave the window hidden: show it on ready-to-show, after a fallback
  // delay, or when the page fails to load / the renderer dies (with a dialog).
  let dialogOpen = false
  guardWindow(win, {
    log: logger,
    onProblem: (problem) => {
      if (dialogOpen || win.isDestroyed()) return
      dialogOpen = true
      const reason = problem.kind === 'load-failed' ? `${problem.description} (${problem.code})` : `${problem.reason} (${problem.exitCode})`
      const locale = uiLocale()
      void dialog
        .showMessageBox(win, {
          type: 'error',
          title: APP_NAME,
          message: localText(locale, problem.kind === 'load-failed' ? 'window.loadFailed' : 'window.rendererGone'),
          detail: localText(locale, 'window.problemDetail', { reason, log: logPath }),
          buttons: [localText(locale, 'window.retry'), localText(locale, 'window.quit')],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        })
        .then(({ response }) => {
          dialogOpen = false
          if (response === 1) app.quit()
          else if (!win.isDestroyed()) loadRenderer(win)
        })
    }
  })

  // DevTools only in development or when debug mode is enabled.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const toggle = input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))
    if (toggle && (!app.isPackaged || settings.get().debugMode)) {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  loadRenderer(win)
}

function loadRenderer(win: BrowserWindow): void {
  const dev = rendererUrl()
  // A failed load is reported through 'did-fail-load' (see guardWindow); only log the rejection here.
  const loading = dev ? win.loadURL(dev) : win.loadFile(path.join(__dirname, '../renderer/index.html'))
  loading.catch((err) => logger.warn(`Renderer load rejected: ${errorMessage(err)}`))
}
