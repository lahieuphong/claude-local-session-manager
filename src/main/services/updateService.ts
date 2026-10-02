import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ActionResult, UpdateMode, UpdateState, UpdateStatus } from '../../shared/types'
import { errorMessage, logger } from '../util/logger'
import { msg } from '../util/messages'
import type { MessageRef } from '../../shared/messages'
import { STORE_UPDATES_URI, storeProductPageUri, type DistributionChannel } from '../../shared/distribution'

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

/**
 * Update mode per distribution channel. The Store channel never uses the
 * GitHub updater (the Store installs updates; running the NSIS Setup over a
 * Store package would be wrong); development never updates.
 */
export function updateModeFor(channel: DistributionChannel, detectGithubMode: () => UpdateMode): UpdateMode {
  if (channel === 'store') return 'store'
  if (channel === 'development') return 'development'
  const mode = detectGithubMode()
  return mode === 'store' ? 'portable' : mode
}

/** Only these modes load electron-updater and check GitHub Releases. */
export function usesGithubUpdater(mode: UpdateMode): boolean {
  return mode === 'installed' || mode === 'portable'
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

type Message = { message: string; msg?: MessageRef }

function friendlyError(err: unknown): Message {
  const text = errorMessage(err)
  if (NO_RELEASE_RE.test(text) || /\b404\b/.test(text)) return msg('update.noRelease')
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(text)) return msg('update.offline')
  // Unknown updater error: shown as-is (technical).
  return { message: text.split('\n')[0].slice(0, 300) }
}

export interface UpdateServiceOptions {
  mode: UpdateMode
  currentVersion: string
  releasesUrl: string
  /** null in development (no app-update.yml) and always null for the Store channel. */
  updater: UpdaterLike | null
  openExternal(url: string): Promise<void>
  /** Store builds only: the real Microsoft Store product ID, once it exists. */
  storeProductId?: string | null
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
  private message?: Message
  private busy = false

  constructor(private readonly opts: UpdateServiceOptions) {
    super()
    const u = opts.updater
    if (opts.mode === 'store') {
      // Store-managed: the GitHub updater is never wired up, even if one was passed.
      this.status = 'store-managed'
      this.message = msg('update.storeManaged')
      return
    }
    if (opts.mode === 'development' || !u) {
      this.status = 'unsupported'
      this.message = msg(opts.mode === 'development' ? 'update.devOnly' : 'update.updaterMissing')
      return
    }
    u.autoDownload = false // the user decides when to download
    u.autoInstallOnAppQuit = false // and when to install (never silently on quit)
    u.allowPrerelease = false
    u.allowDowngrade = false
    u.on('download-progress', (info) => this.set({ status: 'downloading', progressPercent: Math.round(info.percent) }))
    u.on('update-downloaded', (info) =>
      this.set({ status: 'downloaded', latestVersion: info.version, progressPercent: 100, message: msg('update.ready') })
    )
    u.on('error', (err) => {
      logger.warn(`Updater error: ${errorMessage(err)}`)
      if (this.status === 'checking' || this.status === 'downloading') this.set({ status: 'error', message: friendlyError(err) })
    })
  }

  getState(): UpdateState {
    const mode = this.opts.mode
    const supported = usesGithubUpdater(mode) && !!this.opts.updater
    return {
      mode,
      status: this.status,
      currentVersion: this.opts.currentVersion,
      latestVersion: this.latestVersion,
      progressPercent: this.progressPercent,
      checkedAt: this.checkedAt,
      message: this.message?.message,
      msg: this.message?.msg,
      canCheck: supported && !['checking', 'downloading'].includes(this.status),
      canDownload: mode === 'installed' && this.status === 'available',
      canInstall: mode === 'installed' && this.status === 'downloaded'
    }
  }

  async check(trigger: 'startup' | 'manual' = 'manual'): Promise<UpdateState> {
    const u = this.opts.updater
    if (!u || !usesGithubUpdater(this.opts.mode)) return this.getState()
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
          message: msg(this.opts.mode === 'installed' ? 'update.available' : 'update.availablePortable', { version: latest })
        })
        logger.info(`Update available: ${latest} (current ${this.opts.currentVersion}, ${trigger} check, ${this.opts.mode})`)
      } else {
        this.set({ status: 'up-to-date', latestVersion: latest ?? this.opts.currentVersion, message: msg('update.upToDate') })
      }
    } catch (err) {
      this.checkedAt = Date.now()
      if (NO_RELEASE_RE.test(errorMessage(err))) {
        // Nothing published yet: there is nothing newer, which is not a failure.
        this.set({ status: 'up-to-date', latestVersion: undefined, message: msg('update.noRelease') })
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
    if (this.opts.mode === 'store') return this.getState()
    if (!u || this.opts.mode !== 'installed') {
      this.set({ message: msg('update.cannotSelfUpdate') })
      return this.getState()
    }
    if (this.status !== 'available') return this.getState()
    this.set({ status: 'downloading', progressPercent: 0, message: msg('update.downloading') })
    try {
      await u.downloadUpdate()
      // 'update-downloaded' sets the final state; guard against a missing event.
      if ((this.status as UpdateStatus) === 'downloading') this.set({ status: 'downloaded', progressPercent: 100, message: msg('update.ready') })
    } catch (err) {
      this.set({ status: 'error', message: friendlyError(err) })
      logger.warn(`Update download failed: ${errorMessage(err)}`)
    }
    return this.getState()
  }

  /** Only after an explicit user click, only in the installed app, only when downloaded. */
  install(): ActionResult {
    const u = this.opts.updater
    if (this.opts.mode === 'store') return { ok: false, code: 'NOT_SUPPORTED', ...msg('update.storeManaged') }
    if (!u || this.opts.mode !== 'installed' || this.status !== 'downloaded') {
      return { ok: false, code: 'NOT_SUPPORTED', ...msg('update.noDownloaded') }
    }
    logger.info(`Installing update ${this.latestVersion} (user confirmed)`)
    // Runs the verified NSIS installer silently and relaunches the app. The
    // new process starts in Safe Mode like every launch.
    setImmediate(() => u.quitAndInstall(true, true))
    return { ok: true, ...msg('update.restarting') }
  }

  async openReleasesPage(): Promise<ActionResult> {
    await this.opts.openExternal(this.opts.releasesUrl)
    return { ok: true, ...msg('update.openedReleases') }
  }

  /** Store builds: the Store's own "Downloads and updates" page (official ms-windows-store URI). */
  async openStoreUpdates(): Promise<ActionResult> {
    if (this.opts.mode !== 'store') return { ok: false, code: 'NOT_SUPPORTED', ...msg('update.notStoreBuild') }
    await this.opts.openExternal(STORE_UPDATES_URI)
    return { ok: true, ...msg('update.openedStore') }
  }

  /** Store builds with a real product ID only; otherwise there is nothing to open. */
  async openStoreListing(): Promise<ActionResult> {
    const uri = this.opts.mode === 'store' ? storeProductPageUri(this.opts.storeProductId) : null
    if (!uri) return { ok: false, code: 'NOT_SUPPORTED', ...msg('update.noStoreListing') }
    await this.opts.openExternal(uri)
    return { ok: true, ...msg('update.openedStore') }
  }

  private set(patch: Partial<{ status: UpdateStatus; latestVersion: string; progressPercent: number; message: Message | undefined }>): void {
    if (patch.status !== undefined) this.status = patch.status
    if (patch.latestVersion !== undefined) this.latestVersion = patch.latestVersion
    if (patch.progressPercent !== undefined) this.progressPercent = patch.progressPercent
    if ('message' in patch) this.message = patch.message
    this.emit('changed', this.getState())
  }
}
