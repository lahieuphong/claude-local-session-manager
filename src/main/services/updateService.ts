import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ActionResult, UpdateMode, UpdateState, UpdateStatus } from '../../shared/types'
import { errorMessage, logger } from '../util/logger'

/**
 * The part of electron-updater's AppUpdater this app uses. Injected so the
 * state machine is testable without Electron or network access.
 */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', listener: (info: { percent: number }) => void): unknown
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

/**
 * Installed (NSIS) builds have the uninstaller next to the executable.
 * Portable builds are launched with PORTABLE_EXECUTABLE_DIR set. Anything
 * else that is packaged (e.g. dist/win-unpacked) is treated like Portable:
 * it must never auto-install the Setup over itself.
 */
export function detectUpdateMode(opts: {
  isPackaged: boolean
  execPath: string
  productName: string
  env: Record<string, string | undefined>
  exists?: (p: string) => boolean
}): UpdateMode {
  if (!opts.isPackaged) return 'development'
  if (opts.env.PORTABLE_EXECUTABLE_DIR) return 'portable'
  const exists = opts.exists ?? existsSync
  const uninstaller = path.join(path.dirname(opts.execPath), `Uninstall ${opts.productName}.exe`)
  return exists(uninstaller) ? 'installed' : 'portable'
}

/** Strict MAJOR.MINOR.PATCH comparison (pre-release suffixes are not used by this project). */
export function compareVersions(a: string, b: string): number {
  const pa = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(a.trim())
  const pb = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(b.trim())
  if (!pa || !pb) throw new Error(`Invalid version: ${!pa ? a : b}`)
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

const NO_RELEASE_RE = /No published versions|Unable to find latest version/i

function friendlyError(err: unknown): string {
  const msg = errorMessage(err)
  if (NO_RELEASE_RE.test(msg) || /404/.test(msg)) return 'No release has been published on GitHub yet.'
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(msg)) return 'Could not reach GitHub. Check your internet connection.'
  return msg.split('\n')[0].slice(0, 300)
}

export interface UpdateServiceOptions {
  mode: UpdateMode
  currentVersion: string
  releasesUrl: string
  /** null in development (no app-update.yml). */
  updater: UpdaterLike | null
  openExternal(url: string): Promise<void>
}

/**
 * Update checks against GitHub Releases. Everything runs in the main
 * process; the renderer can only trigger check / download / install /
 * open-the-releases-page, never supply a URL or a file to run.
 *
 *  - installed: check → download (user click) → "Restart and install" (user click)
 *  - portable:  check only; tells the user to download the new release
 *  - development: disabled
 */
export class UpdateService extends EventEmitter {
  private status: UpdateStatus = 'idle'
  private latestVersion?: string
  private progressPercent?: number
  private checkedAt?: number
  private message?: string
  private busy = false

  constructor(private readonly opts: UpdateServiceOptions) {
    super()
    const u = opts.updater
    if (opts.mode === 'development' || !u) {
      this.status = 'unsupported'
      this.message =
        opts.mode === 'development'
          ? 'Update checks run only in the installed or portable app.'
          : 'The updater could not be loaded. Download new versions from GitHub Releases.'
      return
    }
    u.autoDownload = false // the user decides when to download
    u.autoInstallOnAppQuit = false // and when to install (never silently on quit)
    u.allowPrerelease = false
    u.allowDowngrade = false
    u.on('download-progress', (info) => this.set({ status: 'downloading', progressPercent: Math.round(info.percent) }))
    u.on('update-downloaded', (info) =>
      this.set({ status: 'downloaded', latestVersion: info.version, progressPercent: 100, message: 'Update ready to install.' })
    )
    u.on('error', (err) => {
      logger.warn(`Updater error: ${errorMessage(err)}`)
      if (this.status === 'checking' || this.status === 'downloading') this.set({ status: 'error', message: friendlyError(err) })
    })
  }

  getState(): UpdateState {
    const mode = this.opts.mode
    const supported = mode !== 'development' && !!this.opts.updater
    return {
      mode,
      status: this.status,
      currentVersion: this.opts.currentVersion,
      latestVersion: this.latestVersion,
      progressPercent: this.progressPercent,
      checkedAt: this.checkedAt,
      message: this.message,
      canCheck: supported && !['checking', 'downloading'].includes(this.status),
      canDownload: mode === 'installed' && this.status === 'available',
      canInstall: mode === 'installed' && this.status === 'downloaded',
      releasesUrl: this.opts.releasesUrl
    }
  }

  async check(trigger: 'startup' | 'manual' = 'manual'): Promise<UpdateState> {
    const u = this.opts.updater
    if (!u || this.opts.mode === 'development') return this.getState()
    if (this.busy || this.status === 'downloading' || this.status === 'downloaded') return this.getState()
    this.busy = true
    this.set({ status: 'checking', message: undefined })
    try {
      const result = await u.checkForUpdates()
      const latest = result?.updateInfo?.version
      this.checkedAt = Date.now()
      if (latest && compareVersions(latest, this.opts.currentVersion) > 0) {
        this.set({
          status: 'available',
          latestVersion: latest,
          message:
            this.opts.mode === 'installed'
              ? `Update available: ${latest}`
              : `Update available: ${latest}. Download the new Setup or Portable build from GitHub Releases.`
        })
        logger.info(`Update available: ${latest} (current ${this.opts.currentVersion}, ${trigger} check, ${this.opts.mode})`)
      } else {
        this.set({ status: 'up-to-date', latestVersion: latest ?? this.opts.currentVersion, message: "You're up to date." })
      }
    } catch (err) {
      this.checkedAt = Date.now()
      if (NO_RELEASE_RE.test(errorMessage(err))) {
        // Nothing published yet: there is nothing newer, which is not a failure.
        this.set({ status: 'up-to-date', latestVersion: undefined, message: 'No release has been published on GitHub yet.' })
      } else {
        this.set({ status: 'error', message: friendlyError(err) })
        logger.warn(`Update check failed (${trigger}): ${errorMessage(err)}`)
      }
    } finally {
      this.busy = false
    }
    return this.getState()
  }

  async download(): Promise<UpdateState> {
    const u = this.opts.updater
    if (!u || this.opts.mode !== 'installed') {
      this.set({ message: 'This build cannot update itself. Download the new release from GitHub Releases.' })
      return this.getState()
    }
    if (this.status !== 'available') return this.getState()
    this.set({ status: 'downloading', progressPercent: 0, message: 'Downloading update…' })
    try {
      await u.downloadUpdate()
      // 'update-downloaded' sets the final state; guard against a missing event.
      if ((this.status as UpdateStatus) === 'downloading') this.set({ status: 'downloaded', progressPercent: 100, message: 'Update ready to install.' })
    } catch (err) {
      this.set({ status: 'error', message: friendlyError(err) })
      logger.warn(`Update download failed: ${errorMessage(err)}`)
    }
    return this.getState()
  }

  /** Only after an explicit user click, only in the installed app, only when downloaded. */
  install(): ActionResult {
    const u = this.opts.updater
    if (!u || this.opts.mode !== 'installed' || this.status !== 'downloaded') {
      return { ok: false, code: 'NOT_SUPPORTED', message: 'No downloaded update is ready to install.' }
    }
    logger.info(`Installing update ${this.latestVersion} (user confirmed)`)
    // Runs the verified NSIS installer silently and relaunches the app. The
    // new process starts in Safe Mode like every launch.
    setImmediate(() => u.quitAndInstall(true, true))
    return { ok: true, message: 'Restarting to install the update…' }
  }

  async openReleasesPage(): Promise<ActionResult> {
    await this.opts.openExternal(this.opts.releasesUrl)
    return { ok: true, message: 'Opened GitHub Releases.' }
  }

  private set(patch: Partial<{ status: UpdateStatus; latestVersion: string; progressPercent: number; message: string | undefined }>): void {
    if (patch.status !== undefined) this.status = patch.status
    if (patch.latestVersion !== undefined) this.latestVersion = patch.latestVersion
    if (patch.progressPercent !== undefined) this.progressPercent = patch.progressPercent
    if ('message' in patch) this.message = patch.message
    this.emit('changed', this.getState())
  }
}
