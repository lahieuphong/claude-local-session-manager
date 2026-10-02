import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  STORE_ASSETS,
  STORE_LANGUAGE_MAP,
  TEST_IDENTITY,
  identityHelp,
  loadStoreIdentity,
  packageFamilyName,
  publisherId,
  storeArtifactName,
  storeBuilderConfig,
  toStorePackageVersion,
  validateStoreIdentity,
  type StoreIdentity
} from '../scripts/store-config.mjs'
import { listZipEntries, reviewManifest } from '../scripts/store-inspect.mjs'
import { storeAsset } from '../scripts/generate-icon.mjs'
import { RELEASES_URL } from '../src/shared/appIdentity'
import {
  STORE_UPDATES_URI,
  isValidStoreProductId,
  resolveDistributionChannel,
  storeProductPageUri
} from '../src/shared/distribution'
import { SUPPORTED_LOCALES } from '../src/shared/locale'
import { RESOURCES } from '../src/shared/locales'
import { readDistribution } from '../src/main/distribution'
import { resolveInitialMode, SafetyModeController } from '../src/main/services/safetyMode'
import { UpdateService, updateModeFor, usesGithubUpdater, type UpdaterLike } from '../src/main/services/updateService'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** Values shaped like Partner Center's (fixture only — never used for a real package). */
const FIXTURE_IDENTITY: StoreIdentity = {
  identityName: '12345Fixture.ClaudeLocalSessionManager',
  publisher: 'CN=0A1B2C3D-0000-4000-8000-ABCDEF012345',
  publisherDisplayName: 'Fixture Publisher',
  displayName: 'Claude Local Session Manager',
  storeProductId: ''
}

function spyUpdater(): UpdaterLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    checkForUpdates: async () => {
      calls.push('check')
      return { updateInfo: { version: '9.9.9' } }
    },
    downloadUpdate: async () => {
      calls.push('download')
      return []
    },
    quitAndInstall: () => {
      calls.push('install')
    },
    on: () => {
      calls.push('on')
      return undefined
    }
  }
}

describe('distribution channel', () => {
  it('is decided by build metadata and the package environment, not by file names', () => {
    expect(resolveDistributionChannel({ isPackaged: true, packagedChannel: 'github', windowsStore: false })).toBe('github')
    expect(resolveDistributionChannel({ isPackaged: true, packagedChannel: 'store', windowsStore: false })).toBe('store')
    expect(resolveDistributionChannel({ isPackaged: true, packagedChannel: undefined, windowsStore: false })).toBe('github')
    // Running inside an AppX/MSIX package is always the Store channel.
    expect(resolveDistributionChannel({ isPackaged: true, packagedChannel: 'github', windowsStore: true })).toBe('store')
    expect(resolveDistributionChannel({ isPackaged: false, packagedChannel: 'store', windowsStore: false })).toBe('development')
  })

  it('the development override only affects unpackaged runs', () => {
    const env = { CLAUDE_SESSION_MANAGER_DISTRIBUTION: 'store' }
    expect(resolveDistributionChannel({ isPackaged: false, packagedChannel: null, windowsStore: false, env })).toBe('store')
    expect(resolveDistributionChannel({ isPackaged: true, packagedChannel: 'github', windowsStore: false, env })).toBe('github')
  })

  it('reads the marker and Store product ID from the packaged package.json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clsm-dist-'))
    try {
      const write = (meta: object) => writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', ...meta }))
      await write({ distributionChannel: 'store', storeProductId: '9ABCDEFGHJKL' })
      expect(readDistribution({ appPath: dir, isPackaged: true, windowsStore: false, env: {} })).toEqual({ channel: 'store', storeProductId: '9ABCDEFGHJKL' })
      await write({ distributionChannel: 'store', storeProductId: 'https://evil.example/x' })
      expect(readDistribution({ appPath: dir, isPackaged: true, windowsStore: false, env: {} }).storeProductId).toBeNull()
      await write({ distributionChannel: 'github', storeProductId: '9ABCDEFGHJKL' })
      expect(readDistribution({ appPath: dir, isPackaged: true, windowsStore: false, env: {} })).toEqual({ channel: 'github', storeProductId: null })
      expect(readDistribution({ appPath: path.join(dir, 'missing'), isPackaged: true, windowsStore: false, env: {} }).channel).toBe('github')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('GitHub builds carry the github marker; the Store build overrides it', () => {
    expect(read('electron-builder.yml')).toMatch(/extraMetadata:\s*\n\s*distributionChannel: github/)
    expect(storeBuilderConfig({ identity: FIXTURE_IDENTITY, version: '1.2.3' }).extraMetadata.distributionChannel).toBe('store')
  })
})

describe('updater separation', () => {
  it('only the GitHub channel uses electron-updater', () => {
    expect(updateModeFor('store', () => 'installed')).toBe('store')
    expect(updateModeFor('development', () => 'installed')).toBe('development')
    expect(updateModeFor('github', () => 'installed')).toBe('installed')
    expect(updateModeFor('github', () => 'portable')).toBe('portable')
    expect(usesGithubUpdater('installed')).toBe(true)
    expect(usesGithubUpdater('portable')).toBe(true)
    expect(usesGithubUpdater('store')).toBe(false)
    expect(usesGithubUpdater('development')).toBe(false)
  })

  it('the Store mode never touches the GitHub updater, even if one is passed by mistake', async () => {
    const u = spyUpdater()
    const open = vi.fn(async () => {})
    const s = new UpdateService({ mode: 'store', currentVersion: '1.2.3', releasesUrl: RELEASES_URL, updater: u, openExternal: open })
    expect(s.getState()).toMatchObject({ mode: 'store', status: 'store-managed', canCheck: false, canDownload: false, canInstall: false, msg: { key: 'update.storeManaged' } })
    expect(s.getState().message).toBe('Updates are managed by Microsoft Store.')
    await s.check('startup')
    await s.check('manual')
    await s.download()
    expect(s.install()).toMatchObject({ ok: false, code: 'NOT_SUPPORTED' })
    expect(u.calls).toEqual([])
    expect(u.autoDownload).toBe(true) // not even configured
    expect(open).not.toHaveBeenCalled()
  })

  it('opens only fixed Microsoft Store URIs, and the product page only with a real product ID', async () => {
    const open = vi.fn(async (_url: string) => {})
    const store = new UpdateService({ mode: 'store', currentVersion: '1.2.3', releasesUrl: RELEASES_URL, updater: null, openExternal: open })
    expect(await store.openStoreUpdates()).toMatchObject({ ok: true })
    expect(open).toHaveBeenLastCalledWith(STORE_UPDATES_URI)
    expect(await store.openStoreListing()).toMatchObject({ ok: false, code: 'NOT_SUPPORTED' })
    expect(open).toHaveBeenCalledTimes(1)

    const listed = new UpdateService({ mode: 'store', currentVersion: '1.2.3', releasesUrl: RELEASES_URL, updater: null, openExternal: open, storeProductId: '9ABCDEFGHJKL' })
    expect(await listed.openStoreListing()).toMatchObject({ ok: true })
    expect(open).toHaveBeenLastCalledWith('ms-windows-store://pdp/?ProductId=9ABCDEFGHJKL')

    const github = new UpdateService({ mode: 'installed', currentVersion: '1.2.3', releasesUrl: RELEASES_URL, updater: spyUpdater(), openExternal: open, storeProductId: '9ABCDEFGHJKL' })
    expect(await github.openStoreUpdates()).toMatchObject({ ok: false })
    expect(await github.openStoreListing()).toMatchObject({ ok: false })
  })

  it('the GitHub mode keeps the existing behaviour', async () => {
    const u = spyUpdater()
    const s = new UpdateService({ mode: 'installed', currentVersion: '1.2.3', releasesUrl: RELEASES_URL, updater: u, openExternal: async () => {} })
    expect(u.autoDownload).toBe(false)
    expect(u.autoInstallOnAppQuit).toBe(false)
    expect(await s.check()).toMatchObject({ status: 'available', latestVersion: '9.9.9', canDownload: true })
    expect(u.calls).toContain('check')
  })

  it('main loads electron-updater and checks at startup only for the GitHub channel', () => {
    const main = read('src/main/index.ts')
    const importAt = main.indexOf("await import('electron-updater')")
    const gate = main.lastIndexOf('if (usesGithubUpdater(updateMode) && !fakeUpdater) {', importAt)
    expect(importAt).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(0)
    expect(main.slice(gate, importAt)).not.toMatch(/\n\s*}\s*\n/) // the import is inside that block
    expect(main).toMatch(/if \(usesGithubUpdater\(updateMode\) && updater\) \{\s*\n\s*setTimeout\(\(\) => void updates\.check\('startup'\)/)
    expect(main).toMatch(/distribution\.channel === 'store' \? null : devFakeUpdater/)
    // A Store package gets its AppUserModelID from the package identity.
    expect(main).toMatch(/if \(process\.platform === 'win32' && distribution\.channel !== 'store'\) app\.setAppUserModelId\(APP_ID\)/)
  })

  it('no update URL is sent to the renderer, and Store actions take no arguments', () => {
    const s = new UpdateService({ mode: 'installed', currentVersion: '1.2.3', releasesUrl: RELEASES_URL, updater: spyUpdater(), openExternal: async () => {} })
    const state = s.getState() as unknown as Record<string, unknown>
    expect(Object.keys(state).filter((k) => /url|uri|link/i.test(k))).toEqual([])
    expect(JSON.stringify(state)).not.toMatch(/https?:|ms-windows-store:/)
    const preload = read('src/preload/index.ts')
    expect(preload).toMatch(/openStoreUpdates: \(\) => ipcRenderer\.invoke\(IPC\.openStoreUpdates\)/)
    expect(preload).toMatch(/openStoreListing: \(\) => ipcRenderer\.invoke\(IPC\.openStoreListing\)/)
  })
})

describe('Store UI copy', () => {
  it('every language explains that the Store manages updates', () => {
    for (const l of SUPPORTED_LOCALES) {
      const r = RESOURCES[l] as Record<string, Record<string, unknown>>
      const updater = r.updater as { status: Record<string, string>; mode: Record<string, string>; action: Record<string, string> }
      const settings = r.settings as { updatesSource: Record<string, string>; distribution: Record<string, string> }
      expect(updater.status.storeManaged).toMatch(/Microsoft Store/)
      expect(updater.action.openStore).toMatch(/Microsoft Store/)
      expect(settings.updatesSource.store).toMatch(/Microsoft Store/)
      expect(settings.updatesSource.github).toBe('GitHub Releases')
      expect(Object.keys(settings.distribution).sort()).toEqual(['development', 'github', 'label', 'store'])
    }
    expect((RESOURCES.en.messages as { update: Record<string, string> }).update.storeManaged).toBe('Updates are managed by Microsoft Store.')
  })
})

describe('Safe Mode is independent of the distribution channel', () => {
  it('a Store (packaged) launch always starts in Safe Mode, whatever the environment says', () => {
    const initial = resolveInitialMode({ isPackaged: true, env: { CLAUDE_SESSION_MANAGER_DRY_RUN: 'false', CLAUDE_SESSION_MANAGER_DEV_ALLOW_ENV_ARM: '1' } })
    expect(initial.dryRun).toBe(true)
    const c = new SafetyModeController({ initial, processes: { getStatus: async () => ({}) as never } })
    expect(c.getState()).toMatchObject({ dryRun: true, reason: 'startup' })
    c.dispose()
    // Nothing about the channel or safety is persisted by the Store tooling.
    expect(JSON.stringify(storeBuilderConfig({ identity: FIXTURE_IDENTITY, version: '1.2.3' }))).not.toMatch(/dryRun|armed|safety/i)
  })
})

describe('Store package version', () => {
  it('maps package.json semver X.Y.Z to X.Y.Z.0', () => {
    expect(toStorePackageVersion('1.2.2')).toBe('1.2.2.0')
    expect(toStorePackageVersion('1.3.0')).toBe('1.3.0.0')
    expect(toStorePackageVersion('10.20.30')).toBe('10.20.30.0')
    const pkg = JSON.parse(read('package.json'))
    expect(toStorePackageVersion(pkg.version)).toBe(`${pkg.version}.0`)
    expect(storeArtifactName(toStorePackageVersion('1.2.3'))).toBe('Claude-Local-Session-Manager-1.2.3.0-x64.appx')
  })

  it('rejects versions the Store cannot accept', () => {
    expect(() => toStorePackageVersion('1.2')).toThrow()
    expect(() => toStorePackageVersion('1.2.3-beta.1')).toThrow()
    expect(() => toStorePackageVersion('1.70000.0')).toThrow()
    expect(() => toStorePackageVersion('0.9.0')).toThrow()
  })

  it('electron-builder writes the same 4-part version (no build-number suffix)', () => {
    expect(storeBuilderConfig({ identity: FIXTURE_IDENTITY, version: '1.2.3' }).appx.setBuildNumber).toBe(false)
  })
})

describe('Store identity (Partner Center values)', () => {
  it('missing values fail with the exact fields to copy, and nothing is guessed', () => {
    const empty = { identityName: '', publisher: '', publisherDisplayName: '', displayName: '', storeProductId: '' }
    const errors = validateStoreIdentity(empty)
    expect(errors).toHaveLength(4)
    const help = identityHelp(errors)
    expect(help).toMatch(/STORE BUILD BLOCKED WAITING FOR PARTNER CENTER IDENTITY/)
    expect(help).toMatch(/Package\/Identity\/Name/)
    expect(help).toMatch(/Package\/Identity\/Publisher/)
    expect(help).toMatch(/Package\/Properties\/PublisherDisplayName/)
    expect(help).toMatch(/No package was created/)
  })

  it('placeholders, electron-builder defaults and malformed values are refused', () => {
    expect(validateStoreIdentity({ ...FIXTURE_IDENTITY, publisher: 'CN=ms' }).join()).toMatch(/placeholder/)
    expect(validateStoreIdentity({ ...FIXTURE_IDENTITY, identityName: 'TODO' }).join()).toMatch(/placeholder/)
    expect(validateStoreIdentity({ ...FIXTURE_IDENTITY, publisher: 'Fixture Publisher' }).join()).toMatch(/distinguished name/)
    expect(validateStoreIdentity({ ...FIXTURE_IDENTITY, identityName: 'has space' }).join()).toMatch(/not a valid package name/)
    expect(validateStoreIdentity({ ...FIXTURE_IDENTITY, storeProductId: 'https://apps.microsoft.com/x' }).join()).toMatch(/not a Store ID/)
    expect(validateStoreIdentity({ ...TEST_IDENTITY }).join()).toMatch(/placeholder/) // the local test identity can never pass as real
    expect(validateStoreIdentity(FIXTURE_IDENTITY)).toEqual([])
  })

  it('environment variables override store/identity.json; empty variables do not', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clsm-store-'))
    try {
      await mkdir(path.join(dir, 'store'))
      await writeFile(path.join(dir, 'store', 'identity.json'), JSON.stringify({ ...FIXTURE_IDENTITY, publisherDisplayName: 'From file' }))
      const id = loadStoreIdentity({ root: dir, env: { STORE_PUBLISHER_DISPLAY_NAME: 'From env', STORE_IDENTITY_NAME: '  ' } })
      expect(id.publisherDisplayName).toBe('From env')
      expect(id.identityName).toBe(FIXTURE_IDENTITY.identityName)
      // STORE_ID is accepted as an alias of STORE_PRODUCT_ID.
      expect(loadStoreIdentity({ root: dir, env: { STORE_ID: '9ABCDEFGHJKL' } }).storeProductId).toBe('9ABCDEFGHJKL')
      expect(loadStoreIdentity({ root: dir, env: { STORE_PRODUCT_ID: '9ZZZZZZZZZZZ', STORE_ID: '9ABCDEFGHJKL' } }).storeProductId).toBe('9ZZZZZZZZZZZ')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('derives the package family name exactly like Windows / Partner Center', () => {
    // Vectors from Partner Center's package validation for this product.
    expect(packageFamilyName('LaHieuPhong.ClaudeLocalSessionManager', 'CN=CA5468D0-A735-4CDB-9F0A-A0CDD47D1EA5')).toBe(
      'LaHieuPhong.ClaudeLocalSessionManager_yh0wwvsc09w1r'
    )
    // The earlier typo (9E0A instead of 9F0A) produced a different (rejected) family name.
    expect(publisherId('CN=CA5468D0-A735-4CDB-9E0A-A0CDD47D1EA5')).toBe('tvw9vj8xdm9st')
    // Well-known reference: Microsoft's own publisher ID.
    expect(publisherId('CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US')).toBe('8wekyb3d8bbwe')
  })

  it('the checked-in identity is the Partner Center identity (or empty), never a placeholder', () => {
    const committed = JSON.parse(read('store/identity.json')) as StoreIdentity
    for (const key of ['identityName', 'publisher', 'publisherDisplayName', 'storeProductId'] as const) {
      const v = committed[key]
      // Either still empty (waiting for Partner Center) or a value that passes validation.
      if (v) expect(validateStoreIdentity({ ...FIXTURE_IDENTITY, [key]: v })).toEqual([])
    }
    expect(committed.publisher).not.toMatch(/^CN=(ms|test|local)/i)
    if (committed.identityName) {
      // Values from Partner Center → Product identity for this product.
      expect(committed).toMatchObject({
        identityName: 'LaHieuPhong.ClaudeLocalSessionManager',
        publisher: 'CN=CA5468D0-A735-4CDB-9F0A-A0CDD47D1EA5',
        publisherDisplayName: 'La Hieu Phong',
        storeProductId: '9N5XNN8H1TSZ'
      })
      expect(validateStoreIdentity(committed)).toEqual([])
      // Partner Center → Product identity → Package/Identity/PackageFamilyName.
      expect(packageFamilyName(committed.identityName, committed.publisher)).toBe('LaHieuPhong.ClaudeLocalSessionManager_yh0wwvsc09w1r')
    }
  })
})

describe('Store languages, assets and manifest', () => {
  it('maps every UI language to a Windows resource language', () => {
    expect(STORE_LANGUAGE_MAP).toEqual({ en: 'en-US', vi: 'vi-VN', 'zh-CN': 'zh-CN' })
    expect(Object.keys(STORE_LANGUAGE_MAP).sort()).toEqual([...SUPPORTED_LOCALES].sort())
    expect(storeBuilderConfig({ identity: FIXTURE_IDENTITY, version: '1.2.3' }).appx.languages).toEqual(['en-US', 'vi-VN', 'zh-CN'])
  })

  it('assets exist with exact sizes and are generated from the app mark (no Claude/Anthropic logo)', () => {
    for (const [name, [w, h]] of Object.entries(STORE_ASSETS)) {
      const buf = fs.readFileSync(path.join(ROOT, 'build', 'appx', name))
      expect([buf.readUInt32BE(16), buf.readUInt32BE(20)], name).toEqual([w, h])
      expect(buf.equals(storeAsset(w, h)), `${name} is out of date: run yarn icon`).toBe(true)
    }
    for (const required of ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png', 'Wide310x150Logo.png']) {
      expect(STORE_ASSETS[required]).toBeDefined()
    }
    expect(fs.readdirSync(path.join(ROOT, 'build', 'appx')).sort()).toEqual(Object.keys(STORE_ASSETS).sort())
  })

  it('requests only runFullTrust + unvirtualizedResources and disables AppData write virtualization', () => {
    const cfg = storeBuilderConfig({ identity: FIXTURE_IDENTITY, version: '1.2.3' })
    expect(cfg.appx.capabilities).toEqual(['unvirtualizedResources'])
    expect(cfg.appx.addAutoLaunchExtension).toBe(false)
    expect(cfg.files).toEqual(['!**/node_modules/electron-updater/**/*']) // no self-updater code in the Store package
    expect(cfg.directories.output.replace(/\\/g, '/')).toBe('dist/store')
    expect(storeBuilderConfig({ identity: FIXTURE_IDENTITY, version: '1.2.3', test: true }).directories.output.replace(/\\/g, '/')).toBe('dist/store-test')
    const template = read('store/AppxManifest.template.xml')
    expect(template).toMatch(/<desktop6:FileSystemWriteVirtualization>disabled<\/desktop6:FileSystemWriteVirtualization>/)
    expect(template).toMatch(/EntryPoint="Windows\.FullTrustApplication"/)
    expect(template).toMatch(/TargetDeviceFamily Name="Windows\.Desktop"/)
  })

  it('every requested restricted capability has a certification justification', () => {
    const notes = read('store/certification-notes.md')
    const requested = ['runFullTrust', ...(storeBuilderConfig({ identity: FIXTURE_IDENTITY, version: '1.2.3' }).appx.capabilities as string[])]
    expect(requested).toEqual(['runFullTrust', 'unvirtualizedResources'])
    for (const cap of requested) expect(notes).toMatch(new RegExp(`### \`${cap}\``))
    expect(notes).toMatch(/FileSystemWriteVirtualization=disabled/)
  })

  it('the manifest review catches identity, version, capability and language problems', () => {
    const fill = (caps: string[], langs: string[], version = '1.2.3.0') =>
      read('store/AppxManifest.template.xml').replace(/\$\{(\w+)\}/g, (_m, k: string) => {
        const v: Record<string, string> = {
          identityName: FIXTURE_IDENTITY.identityName,
          publisher: FIXTURE_IDENTITY.publisher,
          publisherDisplayName: FIXTURE_IDENTITY.publisherDisplayName,
          displayName: FIXTURE_IDENTITY.displayName,
          version,
          arch: 'x64',
          applicationId: 'ClaudeLocalSessionManager',
          executable: 'app\\Claude Local Session Manager.exe',
          capabilities: `<Capabilities>${caps.map((c) => `<rescap:Capability Name="${c}"/>`).join('')}</Capabilities>`,
          resourceLanguages: langs.map((l) => `<Resource Language="${l}" />`).join(''),
          minVersion: '10.0.19041.0',
          maxVersionTested: '10.0.26100.0'
        }
        return v[k] ?? ''
      })
    const opts = { identity: FIXTURE_IDENTITY, storeVersion: '1.2.3.0' }
    expect(reviewManifest(fill(['runFullTrust', 'unvirtualizedResources'], ['en-US', 'vi-VN', 'zh-CN']), opts).ok).toBe(true)
    expect(reviewManifest(fill(['unvirtualizedResources'], ['en-US', 'vi-VN', 'zh-CN']), opts).ok).toBe(false)
    expect(reviewManifest(fill(['runFullTrust', 'unvirtualizedResources', 'broadFileSystemAccess'], ['en-US', 'vi-VN', 'zh-CN']), opts).ok).toBe(false)
    expect(reviewManifest(fill(['runFullTrust', 'unvirtualizedResources'], ['en-US']), opts).ok).toBe(false)
    expect(reviewManifest(fill(['runFullTrust', 'unvirtualizedResources'], ['en-US', 'vi-VN', 'zh-CN'], '1.2.3.7'), opts).ok).toBe(false)
    expect(reviewManifest(fill(['runFullTrust', 'unvirtualizedResources'], ['en-US', 'vi-VN', 'zh-CN']), { ...opts, identity: { ...FIXTURE_IDENTITY, publisher: 'CN=other' } }).ok).toBe(false)
  })

  it('lists package entries without extracting anything', () => {
    // Minimal stored zip with one entry, built by hand.
    const name = Buffer.from('AppxManifest.xml')
    const data = Buffer.from('<Package/>')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(name.length, 28)
    const cdOffset = local.length + name.length + data.length
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(central.length + name.length, 12)
    eocd.writeUInt32LE(cdOffset, 16)
    const zip = Buffer.concat([local, name, data, central, name, eocd])
    expect(listZipEntries(zip)).toEqual(['AppxManifest.xml'])
    expect(() => listZipEntries(Buffer.from('not a zip at all, definitely not'))).toThrow()
  })
})

describe('no invented Store URL', () => {
  it('a product page exists only for a real-looking Store ID; nothing is hard-coded', () => {
    expect(storeProductPageUri(undefined)).toBeNull()
    expect(storeProductPageUri('')).toBeNull()
    expect(storeProductPageUri('9abc')).toBeNull()
    expect(storeProductPageUri('https://apps.microsoft.com/detail/9ABCDEFGHJKL')).toBeNull()
    expect(storeProductPageUri('9ABCDEFGHJKL')).toBe('ms-windows-store://pdp/?ProductId=9ABCDEFGHJKL')
    expect(isValidStoreProductId('9NBLGGH4NNS1')).toBe(true)
    // The real Store ID lives only in store/identity.json (from Partner Center); code never hard-codes one.
    const sources = ['src/shared/distribution.ts', 'src/main/index.ts', 'src/main/services/updateService.ts', 'src/main/distribution.ts', 'scripts/store-config.mjs']
    for (const s of sources) expect(read(s), s).not.toMatch(/9N5XNN8H1TSZ|ProductId=9[0-9A-Z]{11}|apps\.microsoft\.com\/detail\/9/)
    const id = JSON.parse(read('store/identity.json')).storeProductId as string
    expect(id === '' || isValidStoreProductId(id)).toBe(true)
  })
})

describe('Store workflow', () => {
  it('is manual, read-only, builds after test/typecheck/build and uploads only the package files', () => {
    const wf = read('.github/workflows/store-build.yml')
    expect(wf).toMatch(/on:\s*\n\s*workflow_dispatch:/)
    expect(wf).not.toMatch(/\bpush:|\btags:/)
    expect(wf).toMatch(/contents: read/)
    const order = ['yarn test', 'yarn typecheck', 'yarn build', 'yarn dist:store'].map((s) => wf.indexOf(s))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(wf).toMatch(/actions\/upload-artifact@/)
    expect(wf).not.toMatch(/win-unpacked/)
    expect(wf).not.toMatch(/\$\{\{\s*secrets\./) // no Partner Center / Azure / certificate secrets in v1
    expect(wf).not.toMatch(/action-gh-release|gh release/)
    // The GitHub release workflow is unchanged in purpose: Setup/Portable assets only.
    const release = read('.github/workflows/release.yml')
    expect(release).not.toMatch(/dist:store|appx/)
  })
})
