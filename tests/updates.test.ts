import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RELEASES_URL } from '../src/shared/appIdentity'
import { compareVersions, detectUpdateMode, UpdateService, type UpdaterLike } from '../src/main/services/updateService'
import { DEV_FAKE_UPDATE_ENV, devFakeUpdater } from '../src/main/services/devFakeUpdater'

type Listener = (arg: never) => void

/** Fake electron-updater with controllable results; records every call. */
function fakeUpdater(opts: { latest?: string; checkError?: Error; downloadError?: Error } = {}) {
  const listeners = new Map<string, Listener[]>()
  const calls: string[] = []
  const u = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    async checkForUpdates() {
      calls.push('check')
      if (opts.checkError) throw opts.checkError
      return opts.latest ? { updateInfo: { version: opts.latest } } : null
    },
    async downloadUpdate() {
      calls.push('download')
      if (opts.downloadError) throw opts.downloadError
      emit('download-progress', { percent: 42.4 })
      emit('update-downloaded', { version: opts.latest })
      return []
    },
    quitAndInstall: vi.fn((isSilent?: boolean, isForceRunAfter?: boolean) => {
      calls.push(`quitAndInstall(${isSilent},${isForceRunAfter})`)
    }),
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return u
    }
  }
  const emit = (event: string, arg: unknown): void => {
    for (const l of listeners.get(event) ?? []) l(arg as never)
  }
  return { updater: u as unknown as UpdaterLike, raw: u, calls }
}

const svc = (mode: 'installed' | 'portable' | 'development', updater: UpdaterLike | null, openExternal = vi.fn(async () => {})) =>
  new UpdateService({ mode, currentVersion: '1.0.0', releasesUrl: RELEASES_URL, updater, openExternal })

describe('update mode detection', () => {
  const exe = path.join('C:\\Users\\u\\AppData\\Local\\Programs\\claude-local-session-manager', 'Claude Local Session Manager.exe')
  const base = { execPath: exe, productName: 'Claude Local Session Manager' }

  it('distinguishes development, installed (uninstaller next to exe) and portable', () => {
    expect(detectUpdateMode({ ...base, isPackaged: false, env: {} })).toBe('development')
    expect(detectUpdateMode({ ...base, isPackaged: true, env: {}, exists: (p) => p.endsWith('Uninstall Claude Local Session Manager.exe') })).toBe('installed')
    expect(detectUpdateMode({ ...base, isPackaged: true, env: { PORTABLE_EXECUTABLE_DIR: 'C:\\x' }, exists: () => true })).toBe('portable')
    // e.g. dist\win-unpacked: packaged but not installed → never auto-install over itself
    expect(detectUpdateMode({ ...base, isPackaged: true, env: {}, exists: () => false })).toBe('portable')
  })

  it('compares versions numerically', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(() => compareVersions('latest', '1.0.0')).toThrow()
  })
})

describe('installed (Setup) update flow', () => {
  it('forces manual download and no silent install-on-quit', () => {
    const f = fakeUpdater()
    svc('installed', f.updater)
    expect(f.raw).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false })
  })

  it('check → available → download → ready → restart and install (only after the user asks)', async () => {
    const f = fakeUpdater({ latest: '1.0.1' })
    const s = svc('installed', f.updater)
    expect(s.install().ok).toBe(false) // nothing downloaded yet
    let st = await s.check('manual')
    expect(st).toMatchObject({ status: 'available', latestVersion: '1.0.1', canDownload: true, canInstall: false, message: 'Update available: 1.0.1' })
    expect(f.calls).toEqual(['check']) // no automatic download
    st = await s.download()
    expect(st).toMatchObject({ status: 'downloaded', canInstall: true, progressPercent: 100 })
    expect(f.raw.quitAndInstall).not.toHaveBeenCalled()
    expect(s.install()).toMatchObject({ ok: true })
    await new Promise((r) => setImmediate(r))
    expect(f.calls).toEqual(['check', 'download', 'quitAndInstall(true,true)'])
  })

  it("reports \"You're up to date\" when the latest release is not newer", async () => {
    for (const latest of ['1.0.0', '0.9.9']) {
      const st = await svc('installed', fakeUpdater({ latest }).updater).check()
      expect(st).toMatchObject({ status: 'up-to-date', canDownload: false })
    }
  })

  it('turns errors into a failed state with a readable message', async () => {
    const none = await svc('installed', fakeUpdater({ checkError: new Error('No published versions on GitHub') }).updater).check()
    expect(none).toMatchObject({ status: 'up-to-date', message: 'No release has been published on GitHub yet.', canDownload: false })
    const offline = await svc('installed', fakeUpdater({ checkError: new Error('getaddrinfo ENOTFOUND github.com') }).updater).check()
    expect(offline.message).toMatch(/Could not reach GitHub/)
    const f = fakeUpdater({ latest: '2.0.0', downloadError: new Error('sha512 checksum mismatch') })
    const s = svc('installed', f.updater)
    await s.check()
    expect(await s.download()).toMatchObject({ status: 'error', canInstall: false })
    expect(s.install().ok).toBe(false)
    expect(f.raw.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('portable and development builds', () => {
  it('portable: detects a newer release but never downloads or replaces itself', async () => {
    const f = fakeUpdater({ latest: '1.2.0' })
    const open = vi.fn(async () => {})
    const s = svc('portable', f.updater, open)
    const st = await s.check()
    expect(st).toMatchObject({ status: 'available', canDownload: false, canInstall: false })
    expect(st.message).toMatch(/Download the new Setup or Portable build from GitHub Releases/)
    await s.download()
    expect(s.install().ok).toBe(false)
    expect(f.calls).toEqual(['check'])
    expect(f.raw.quitAndInstall).not.toHaveBeenCalled()
    await s.openReleasesPage()
    expect(open).toHaveBeenCalledWith('https://github.com/lahieuphong/claude-local-session-manager/releases')
  })

  it('development: update checks are disabled and the updater is never called', async () => {
    const f = fakeUpdater({ latest: '9.9.9' })
    const s = svc('development', f.updater)
    expect(await s.check()).toMatchObject({ status: 'unsupported', canCheck: false, canDownload: false, canInstall: false })
    expect(f.calls).toEqual([])
    expect(svc('development', null).getState().status).toBe('unsupported')
  })
})

describe('development-only fake updater (UI review)', () => {
  it('is ignored by packaged builds and invalid versions', () => {
    expect(devFakeUpdater({ isPackaged: true, env: { [DEV_FAKE_UPDATE_ENV]: '9.9.9' } })).toBeNull()
    expect(devFakeUpdater({ isPackaged: false, env: {} })).toBeNull()
    expect(devFakeUpdater({ isPackaged: false, env: { [DEV_FAKE_UPDATE_ENV]: 'latest' } })).toBeNull()
  })

  it('drives the update UI without network access and never installs anything', async () => {
    const u = devFakeUpdater({ isPackaged: false, env: { [DEV_FAKE_UPDATE_ENV]: '9.9.9' } })!
    const s = new UpdateService({ mode: 'installed', currentVersion: '1.1.0', releasesUrl: RELEASES_URL, updater: u, openExternal: async () => undefined })
    expect(await s.check()).toMatchObject({ status: 'available', latestVersion: '9.9.9', canDownload: true, msg: { key: 'update.available' } })
    expect(await s.download()).toMatchObject({ status: 'downloaded', canInstall: true })
    expect(() => u.quitAndInstall(true, true)).not.toThrow()
  })
})
