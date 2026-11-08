import fs from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LONG_TITLE_EN, UI_UUID_RE, writeUiTestProfile } from '../scripts/ui-test-profile.mjs'
import { ScanCache } from '../src/main/services/cacheService'
import { discoverRoots, type DiscoveryEnv } from '../src/main/services/claudeDiscovery'
import { ManagerHiddenStore } from '../src/main/services/managerHiddenStore'
import { ProcessService } from '../src/main/services/processService'
import { SessionRepository } from '../src/main/services/sessionRepository'
import { SUPPORTED_LOCALES } from '../src/shared/locale'

// `yarn test:ui` drives the real app and takes minutes. These fast checks keep it honest:
// its profile must stay readable by the real scanner, or it would test nothing.
const ROOT = path.resolve(__dirname, '..')

let home: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), 'clsm-ui-')))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const envOf = (dir: string): DiscoveryEnv => ({ homedir: dir, appData: path.join(dir, 'AppData', 'Roaming'), localAppData: path.join(dir, 'AppData', 'Local'), platform: 'win32' })

describe('UI test profile', () => {
  it('gives the real scanner every kind of session the UI test needs', async () => {
    const { roles, projectCount } = writeUiTestProfile(home)
    const repo = new SessionRepository({
      env: envOf(home),
      cache: new ScanCache(path.join(home, 'manager', 'cache.json')),
      hidden: new ManagerHiddenStore(path.join(home, 'manager', 'hidden.json')),
      processService: new ProcessService(null, async () => [], 0),
      decodeFolderNames: false
    })
    const { sessions, roots } = await repo.scan()
    const byCli = new Map(sessions.map((s) => [s.cliSessionId, s]))

    expect(roots.claudeHome.startsWith(home)).toBe(true)
    expect(roots.desktopRoots.length).toBeGreaterThan(0)
    expect(roots.desktopRoots.every((d) => d.path.startsWith(home))).toBe(true)
    expect(sessions.every((s) => !s.cliSessionId || UI_UUID_RE.test(s.cliSessionId))).toBe(true)

    // More projects than any sidebar can show: the reported squeeze only happens when the list must scroll.
    expect(new Set(sessions.map((s) => s.projectKey)).size).toBeGreaterThanOrEqual(projectCount)

    expect(byCli.get(roles.longEn)).toMatchObject({ displayTitle: LONG_TITLE_EN, hasMetadata: false, hasTranscript: true })
    expect(byCli.get(roles.untitled)?.titleSource).toBe('untitled')
    expect(byCli.get(roles.noProject)?.projectKey).toBe('unresolved')
    for (const uuid of roles.desktopActive) expect(byCli.get(uuid)).toMatchObject({ hasMetadata: true, archived: false })
    for (const uuid of roles.desktopArchived) expect(byCli.get(uuid)).toMatchObject({ hasMetadata: true, archived: true })
    expect(byCli.get(roles.metadataOnly)).toMatchObject({ hasMetadata: true, hasTranscript: false })
    expect(byCli.get(roles.metadataOnly)?.problems.length).toBeGreaterThan(0)

    // Three accounts: the main one, one sharing its store through links, one with its own store.
    const [first, second, third] = roots.accounts
    expect(roots.accounts.map((a) => a.label)).toEqual(['first.account', 'second.account', 'third.account'])
    expect(byCli.get(roles.longEn)?.accountIds).toEqual([first.id])
    expect(byCli.get(roles.onlySecond)?.accountIds).toEqual([second.id])
    expect(byCli.get(roles.inBoth)?.accountIds).toEqual([first.id, second.id])
    for (const uuid of roles.third) expect(byCli.get(uuid)?.accountIds).toEqual([third.id])
  })

  it('registers a running session only when asked', () => {
    expect(writeUiTestProfile(home).roles.live).toBeUndefined()
    const { roles } = writeUiTestProfile(home, { livePid: 4242 })
    expect(JSON.parse(fs.readFileSync(roles.liveFile!, 'utf8'))).toMatchObject({ pid: 4242, sessionId: roles.live })
  })

  it('refuses to write into a real profile or a folder it did not create', async () => {
    expect(() => writeUiTestProfile(process.env.USERPROFILE || os.homedir())).toThrow(/real user profile/)
    await mkdir(path.join(home, '.claude'))
    expect(() => writeUiTestProfile(home)).toThrow(/was not created by this script/)
  })
})

describe('layout rules the UI test found', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/src/styles/global.css'), 'utf8')

  it('sidebar items never shrink when the list has to scroll', () => {
    // With overflow hidden and the default flex-shrink, flexbox squeezes them to nothing.
    expect(/\.nav-item \{[^}]*\bflex: none;/.exec(css)).not.toBeNull()
  })

  it('a message moves away from the buttons of an open dialog', () => {
    expect(css).toMatch(/body:has\(\.modal-backdrop\) \.toasts \{[^}]*\btop:/)
  })
})

describe('labels of the paths checked at startup', () => {
  it('have a translation in every language', async () => {
    const { candidates } = await discoverRoots(envOf(home))
    const keys = candidates.flatMap((c) => (c.noteKey ? [c.noteKey] : []))
    expect(keys).toEqual(['claudeHome', 'transcripts', 'fileHistory', 'sessionEnv', 'running'])
    for (const locale of SUPPORTED_LOCALES) {
      const { roots } = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/shared/locales', locale, 'settings.json'), 'utf8'))
      for (const key of keys) expect(roots[key], `${locale}: settings:roots.${key}`).toBeTruthy()
    }
  })
})
