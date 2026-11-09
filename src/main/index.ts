import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { APP_ID, APP_NAME, RELEASES_URL, appBrand } from '../shared/appIdentity'
import { IPC } from '../shared/ipc'
import type { AppInfo, AppSettings, ExportFormat, SafetyModeState, UpdateState } from '../shared/types'
import { registerIpc } from './ipc/registerIpc'
import { registerTerminalIpc } from './ipc/terminalIpc'
import { ArchiveService } from './services/archiveService'
import { ScanCache } from './services/cacheService'
import { envFromProcess } from './services/claudeDiscovery'
import { DeleteService } from './services/deleteService'
import { ExportService } from './services/exportService'
import { ManagerHiddenStore } from './services/managerHiddenStore'
import { packagingPolicy } from './services/packagingPolicy'
import { ProcessService } from './services/processService'
import { resolveInitialMode, SafetyModeController } from './services/safetyMode'
import type { AppUpdater } from 'electron-updater'
import { detectUpdateMode, UpdateService, updateModeFor, usesGithubUpdater, type UpdaterLike } from './services/updateService'
import { readDistribution } from './distribution'
import { devFakeUpdater } from './services/devFakeUpdater'
import { SessionRepository } from './services/sessionRepository'
import { SettingsService } from './services/settingsService'
import { WatchService } from './services/watchService'
import { CodexActions } from './services/codex/codexActions'
import { CodexDeleteService } from './services/codex/codexDelete'
import { CodexExportService } from './services/codex/codexExport'
import { codexEnvFromProcess } from './services/codex/codexHomes'
import { CodexRepository } from './services/codex/codexRepository'
import { loadNodePty } from './services/terminal/nodePty'
import { resumePlan } from './services/terminal/resume'
import { findShells } from './services/terminal/shells'
import { TerminalService } from './services/terminal/terminalService'
import { isDirectory } from './util/fsx'
import { errorMessage, logger } from './util/logger'
import { localText } from './util/messages'
import { resolveLocale, type SupportedLocale } from '../shared/locale'
import { guardWindow } from './windowGuard'
import { buildScreenshotFixture } from './screenshot/fixtures'
import { createScreenshotHandlers, screenshotAppInfo } from './screenshot/screenshotIpc'
import { resolveScreenshotMode, type ScreenshotModeConfig } from './screenshot/screenshotMode'

// github | store | development, from the packaged metadata (see src/shared/distribution.ts).
const distribution = readDistribution({
  appPath: app.getAppPath(),
  isPackaged: app.isPackaged,
  windowsStore: process.windowsStore === true,
  env: process.env
})
// Store screenshot mode: static demo data, development runs only (null when packaged).
const screenshotMode = resolveScreenshotMode({ isPackaged: app.isPackaged, env: process.env })
// The Microsoft Store edition has its own customer-facing name (and so its own
// app data folder); GitHub Setup/Portable and development keep APP_NAME.
const storeEdition = distribution.channel === 'store' || screenshotMode !== null
const brand = appBrand(storeEdition ? 'store' : distribution.channel)
app.setName(brand.name)
// Separate app data (and single-instance lock) for test/verification runs.
if (process.env.CLAUDE_SESSION_MANAGER_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.CLAUDE_SESSION_MANAGER_USER_DATA))
} else if (screenshotMode) {
  app.setPath('userData', path.join(os.tmpdir(), 'local-session-manager-screenshots'))
}
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
    dialog.showErrorBox(brand.name, `Startup failed: ${errorMessage(err)}`)
    app.quit()
  })
}

async function start(): Promise<void> {
  if (screenshotMode) return startScreenshotMode(screenshotMode)
  const userData = app.getPath('userData')
  const logPath = path.join(userData, 'logs', 'main.log')
  await logger.setLogFile(logPath)

  // Store edition: every launch starts in SAFE MODE (dry run). Other builds have no arming step. See safetyMode.ts.
  const initialMode = resolveInitialMode({ channel: distribution.channel, isPackaged: app.isPackaged, env: process.env })
  const cachePath = path.join(userData, 'scan-cache', 'transcript-index.json')
  // What this build may write: the Store edition does not modify Claude Desktop's AppData files (packagingPolicy.ts).
  const discoveryEnv = envFromProcess()
  const policy = packagingPolicy(distribution.channel, discoveryEnv)
  const appInfo: AppInfo = {
    name: brand.name,
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
    desktopDataReadOnly: policy.isolatesAppData,
    userHome: os.homedir()
  }
  logger.info(
    `${brand.name} ${appInfo.version} starting (dryRun=${initialMode.dryRun}, packaged=${app.isPackaged}, distribution=${distribution.channel})`
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
  const repo = new SessionRepository({ env: discoveryEnv, cache, hidden, processService: processes })
  const archive = new ArchiveService(repo, processes, hidden, () => safety.isDryRun(), policy)
  const deleter = new DeleteService(repo, processes, {
    dryRun: () => safety.isDryRun(),
    // Store edition: arming is single-use, so a real delete returns it to Safe Mode. Does nothing in other builds.
    onRealDeleteExecuted: () => safety.disarm('after-delete'),
    policy,
    appName: brand.name
  })
  safety.on('changed', (state: SafetyModeState) => {
    logger.info(`Safety mode: ${state.dryRun ? 'SAFE MODE (dry run)' : 'REAL DELETE ARMED'} (${state.reason})`)
    mainWindow?.webContents.send(IPC.safetyModeChanged, state)
  })
  const exportDialogs = {
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
  }
  const exporter = new ExportService(repo, exportDialogs, { policy, appName: brand.name })

  // OpenAI Codex: read from its own databases; archive, restore and delete run the Codex CLI.
  const codexRepo = new CodexRepository({ env: codexEnvFromProcess(), hidden })
  const codex = {
    repo: codexRepo,
    actions: new CodexActions(codexRepo, () => safety.isDryRun()),
    deleter: new CodexDeleteService(codexRepo, {
      dryRun: () => safety.isDryRun(),
      onRealDeleteExecuted: () => safety.disarm('after-delete'),
      appName: brand.name
    }),
    exporter: new CodexExportService(codexRepo, exportDialogs, brand.name)
  }

  // The integrated terminal, in every build but the Microsoft Store edition: Windows isolates
  // that package's AppData, so a command run from it would not behave as in any other terminal.
  const terminals =
    distribution.channel === 'store'
      ? null
      : new TerminalService({
          loadPty: () => loadNodePty(app.isPackaged ? process.resourcesPath : null),
          findShells: () => findShells(process.env),
          windowsBuild: Number(os.release().split('.')[2]) || 0,
          home: os.homedir(),
          projectFolder: async (id) => {
            const folder = (codexRepo.getRecord(id) ?? repo.getRecord(id))?.session.projectPath
            return folder && (await isDirectory(folder)) ? folder : undefined
          },
          resumeOf: async (id) => {
            const codexSession = codexRepo.getRecord(id)?.session
            if (codexSession) return resumePlan(codexSession, codexRepo.getHomes())
            const session = repo.getRecord(id)?.session
            // The main Claude folder is listed first (claudeDiscovery.ts).
            const accounts = (repo.getRoots()?.accounts ?? []).map((a, i) => ({ id: a.id, path: a.path, main: i === 0 }))
            return session ? resumePlan(session, accounts) : null
          },
          env: process.env,
          log: logger
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

  const watcher = new WatchService((reason, target) => {
    if (target !== 'codex') repo.scan(reason).catch((err) => logger.error(`Auto refresh failed: ${errorMessage(err)}`))
    // Codex only once it has been opened: nobody is looking at it otherwise.
    if (target !== 'claude' && codexRepo.getSnapshot()) codexRepo.scan(reason).catch((err) => logger.error(`Codex auto refresh failed: ${errorMessage(err)}`))
  })

  repo.on('changed', (snapshot) => {
    mainWindow?.webContents.send(IPC.sessionsChanged, snapshot)
    watcher.configure(settings.get(), repo.getRoots(), codexRepo.getHomes().map((h) => h.path))
  })
  repo.on('scan-state', (state) => mainWindow?.webContents.send(IPC.scanStateChanged, { ...state, provider: 'claude' }))
  codexRepo.on('changed', (snapshot) => {
    mainWindow?.webContents.send(IPC.sessionsChanged, snapshot)
    watcher.configure(settings.get(), repo.getRoots(), codexRepo.getHomes().map((h) => h.path))
  })
  codexRepo.on('scan-state', (state) => mainWindow?.webContents.send(IPC.scanStateChanged, { ...state, provider: 'codex' }))

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
    codex,
    onSettingsChanged: (next) => {
      logger.debugEnabled = next.debugMode
      watcher.configure(next, repo.getRoots(), codexRepo.getHomes().map((h) => h.path))
    },
    isTrustedSender
  })
  registerTerminalIpc({ service: terminals, isTrustedSender, page: () => mainWindow?.webContents ?? null })

  hardenSession()
  Menu.setApplicationMenu(null)
  createWindow(settings, uiLocale, logPath)
  if (terminals && mainWindow) {
    const win = mainWindow
    // A shell belongs to the page that opened it: a reload or the window closing ends it.
    win.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) terminals.closeAll()
    })
    win.on('closed', () => terminals.closeAll())
  }

  // Non-blocking GitHub update check a little after startup (never delays the window).
  // Only the GitHub channel checks; Store builds are updated by the Store.
  if (usesGithubUpdater(updateMode) && updater) {
    setTimeout(() => void updates.check('startup'), 8000).unref?.()
  }

  app.on('window-all-closed', () => {
    watcher.stop()
    codexRepo.dispose()
    safety.dispose()
    void cache.save().finally(() => app.quit())
  })
}

/**
 * Store screenshot mode (development only, see screenshot/screenshotMode.ts).
 * None of the real services is created: no Claude data or process is read,
 * no settings, cache or log file is written, and every IPC call is answered
 * from the static fixture. Deletion stays in Safe Mode and cannot be armed.
 */
function startScreenshotMode(config: ScreenshotModeConfig): void {
  logger.warn('STORE SCREENSHOT MODE: showing static demo data only (development build).')
  const appInfo = screenshotAppInfo({
    name: brand.name,
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: `${process.platform} ${process.arch}`,
    locale: config.locale
  })
  // Whole minutes, so relative times in the UI do not change between captures.
  const handlers = createScreenshotHandlers({ appInfo, fixture: buildScreenshotFixture(Math.floor(Date.now() / 60_000) * 60_000) })
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('Rejected IPC call from an untrusted frame')
      return fn(...args)
    })
  }
  registerTerminalIpc({ service: null, isTrustedSender, page: () => null })
  hardenSession()
  Menu.setApplicationMenu(null)
  const settings = { get: () => handlers[IPC.getSettings]() as AppSettings }
  createWindow(settings, () => resolveLocale(config.locale, appInfo.systemLanguages), appInfo.logPath)
  app.on('window-all-closed', () => app.quit())
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

function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
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

function createWindow(settings: Pick<SettingsService, 'get'>, uiLocale: () => SupportedLocale, logPath: string): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 620,
    show: false,
    title: brand.name,
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
  // The window title is this build's product name, whatever the page's <title> says.
  win.on('page-title-updated', (event) => event.preventDefault())
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
          title: brand.name,
          message: localText(locale, problem.kind === 'load-failed' ? 'window.loadFailed' : 'window.rendererGone'),
          detail: localText(locale, storeEdition ? 'window.problemDetailStore' : 'window.problemDetail', { reason, log: logPath }),
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
