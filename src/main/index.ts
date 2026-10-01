import { app, BrowserWindow, dialog, Menu, session, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { IPC } from '../shared/ipc'
import type { AppInfo, ExportFormat } from '../shared/types'
import { registerIpc } from './ipc/registerIpc'
import { ArchiveService } from './services/archiveService'
import { ScanCache } from './services/cacheService'
import { envFromProcess } from './services/claudeDiscovery'
import { DeleteService } from './services/deleteService'
import { ExportService } from './services/exportService'
import { ManagerHiddenStore } from './services/managerHiddenStore'
import { ProcessService } from './services/processService'
import { SessionRepository } from './services/sessionRepository'
import { SettingsService } from './services/settingsService'
import { WatchService } from './services/watchService'
import { errorMessage, logger } from './util/logger'

const APP_NAME = 'Claude Local Session Manager'
app.setName(APP_NAME)
// Separate app data (and single-instance lock) for test/verification runs.
if (process.env.CLAUDE_SESSION_MANAGER_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.CLAUDE_SESSION_MANAGER_USER_DATA))
}
if (process.platform === 'win32') app.setAppUserModelId('local.claude-session-manager')

/**
 * DRY RUN: mutating actions only log what they would do.
 * Default: on in development (`yarn dev`), off in the packaged app.
 * Override either way with CLAUDE_SESSION_MANAGER_DRY_RUN=true|false.
 */
function resolveDryRun(): boolean {
  const v = process.env.CLAUDE_SESSION_MANAGER_DRY_RUN
  if (v !== undefined && v.trim() !== '') return /^(1|true|yes|on)$/i.test(v.trim())
  return !app.isPackaged
}

let mainWindow: BrowserWindow | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
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

  const dryRun = resolveDryRun()
  const cachePath = path.join(userData, 'scan-cache', 'transcript-index.json')
  const appInfo: AppInfo = {
    name: APP_NAME,
    version: app.getVersion(),
    dryRun,
    isPackaged: app.isPackaged,
    platform: `${process.platform} ${process.arch}`,
    userDataPath: userData,
    cachePath,
    logPath,
    electronVersion: process.versions.electron
  }
  logger.info(`${APP_NAME} ${appInfo.version} starting (dryRun=${dryRun}, packaged=${app.isPackaged})`)

  const settings = new SettingsService(path.join(userData, 'settings.json'))
  await settings.load()
  logger.debugEnabled = settings.get().debugMode

  const cache = new ScanCache(cachePath)
  await cache.load()
  const hidden = new ManagerHiddenStore(path.join(userData, 'manager-hidden.json'))
  await hidden.load()

  const processes = new ProcessService(null)
  const repo = new SessionRepository({ env: envFromProcess(), cache, hidden, processService: processes })
  const archive = new ArchiveService(repo, processes, hidden, dryRun)
  const deleter = new DeleteService(repo, processes, { dryRun })
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
      const opts = { title: 'Choose export folder', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
      const r = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    }
  })

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
  createWindow(settings)

  app.on('window-all-closed', () => {
    watcher.stop()
    void cache.save().finally(() => app.quit())
  })
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

function createWindow(settings: SettingsService): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 620,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0d0f12',
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

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // DevTools only in development or when debug mode is enabled.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const toggle = input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))
    if (toggle && (!app.isPackaged || settings.get().debugMode)) {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  const dev = rendererUrl()
  if (dev) void mainWindow.loadURL(dev)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
}
