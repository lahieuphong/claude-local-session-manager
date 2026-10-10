import fs from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEMO_MARKER, DEMO_PROJECTS, DEMO_SESSIONS, DEMO_UUID_RE, demoUuid, writeDemoProfile } from '../scripts/store-demo-data.mjs'
import { formatRelativeIntl } from '../src/shared/format'
import { dateBucket } from '../src/shared/sessionQuery'
import { ScanCache } from '../src/main/services/cacheService'
import type { DiscoveryEnv } from '../src/main/services/claudeDiscovery'
import { DeleteService } from '../src/main/services/deleteService'
import { ManagerHiddenStore } from '../src/main/services/managerHiddenStore'
import { packagingPolicy } from '../src/main/services/packagingPolicy'
import { ProcessService } from '../src/main/services/processService'
import { SessionRepository } from '../src/main/services/sessionRepository'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8')

let home: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), 'lhp-demo-')))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** The real services over the demo profile, as the Microsoft Store edition wires them. */
function storeServices(): { repo: SessionRepository; deleter: DeleteService } {
  const env: DiscoveryEnv = { homedir: home, appData: path.join(home, 'AppData', 'Roaming'), localAppData: path.join(home, 'AppData', 'Local'), platform: 'win32' }
  const processes = new ProcessService(null, async () => [], 0)
  const repo = new SessionRepository({
    env,
    cache: new ScanCache(path.join(home, 'manager', 'cache.json')),
    hidden: new ManagerHiddenStore(path.join(home, 'manager', 'hidden.json')),
    processService: processes,
    decodeFolderNames: false
  })
  return { repo, deleter: new DeleteService(repo, processes, { dryRun: true, recentWriteMs: 0, policy: packagingPolicy('store', env) }) }
}

describe('synthetic demo profile for Store screenshots', () => {
  it('is read by the real scanner as exactly the 12 transcript-only demo sessions', async () => {
    const written = writeDemoProfile(home, { scale: 0.02 })
    expect(written.sessions).toBe(12)
    const { repo } = storeServices()
    const snapshot = await repo.scan()
    expect(snapshot.issues).toEqual([])
    expect(snapshot.roots.desktopRoots).toEqual([]) // no Claude Desktop data at all
    expect(snapshot.sessions.map((s) => s.displayTitle).sort()).toEqual(DEMO_SESSIONS.map((s) => s.title).sort())
    for (const s of snapshot.sessions) {
      const demo = DEMO_SESSIONS.find((d) => d.title === s.displayTitle)!
      expect(s).toMatchObject({
        kind: 'cli',
        status: 'transcript-only',
        hasMetadata: false,
        archived: false,
        titleSource: 'ai-title',
        cliSessionId: demoUuid(demo.n),
        projectPath: DEMO_PROJECTS[demo.project],
        model: demo.model,
        gitBranch: demo.branch,
        userMessageCount: demo.turns,
        toolUseCount: demo.turns * demo.tools,
        problems: []
      })
      expect(s.live).toBeUndefined()
      expect(s.cliSessionId).toMatch(DEMO_UUID_RE)
      expect(s.transcriptFile!.startsWith(path.join(home, '.claude', 'projects'))).toBe(true)
    }
  })

  it('every demo session is one the Store edition can delete: no plan item under AppData or Claude Desktop data', async () => {
    writeDemoProfile(home, { scale: 0.02 })
    const { repo, deleter } = storeServices()
    const snapshot = await repo.scan()
    const plan = await deleter.createPlan(snapshot.sessions.map((s) => s.id), true)
    expect(plan.blocked).toEqual([])
    expect(plan.sessions).toHaveLength(12)
    expect(plan.dryRun).toBe(true)
    for (const s of plan.sessions) {
      for (const item of s.items.filter((i) => i.kind !== 'manager-record')) {
        expect(item.path.startsWith(path.join(home, '.claude') + path.sep), item.path).toBe(true)
        expect(['transcript', 'session-data', 'file-history', 'session-env']).toContain(item.kind)
      }
      expect(s.willNotDelete[0].path).toMatch(/^C:\\Projects\\(DemoWebApp|SampleAPI|DesignSystem)$/)
    }
  })

  it('contains only synthetic values and never writes into a real profile', async () => {
    const { claudeHome } = writeDemoProfile(home, { scale: 0.02 })
    expect(fs.existsSync(path.join(claudeHome, DEMO_MARKER))).toBe(true)
    const transcript = fs.readFileSync(path.join(claudeHome, 'projects', 'C--Projects-DemoWebApp', `${demoUuid(3)}.jsonl`), 'utf8')
    for (const own of [os.homedir(), os.userInfo().username]) expect(transcript.toLowerCase()).not.toContain(own.toLowerCase())
    expect(transcript).toContain('"cwd":"C:\\\\Projects\\\\DemoWebApp"')
    // Rewriting its own output is fine; a folder it did not create is refused, and so is the real profile.
    expect(() => writeDemoProfile(home, { scale: 0.02 })).not.toThrow()
    const foreign = path.join(home, 'someone')
    await mkdir(path.join(foreign, '.claude'), { recursive: true })
    await writeFile(path.join(foreign, '.claude', 'settings.json'), '{}')
    expect(() => writeDemoProfile(foreign)).toThrow(/was not created by this script/)
    expect(() => writeDemoProfile(process.env.USERPROFILE || os.homedir())).toThrow(/real user profile/)
  })

  it('date groups and relative labels agree at any time of day', () => {
    // Late at night and mid-afternoon: a session in "previous 7 days" is never labelled "yesterday".
    for (const now of [new Date(2026, 9, 10, 2, 6).getTime(), new Date(2026, 9, 10, 15, 30).getTime(), new Date(2026, 9, 10, 23, 58).getTime()]) {
      for (const s of DEMO_SESSIONS) {
        const last =
          s.daysAgo === undefined
            ? now - s.ageMin! * 60_000
            : new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate() - s.daysAgo, ...(s.at!.split(':').map(Number) as [number, number])).getTime()
        const bucket = dateBucket(last, new Date(now))
        const label = formatRelativeIntl(last, 'en-US', now)
        if (bucket === 'last7') expect(label, `${s.title} @ ${new Date(now).toISOString()}`).toMatch(/^\d days ago$/)
        if (bucket === 'last30') expect(label).not.toMatch(/ago|yesterday/)
        if (s.daysAgo === 1) expect(bucket).toBe('yesterday')
        if (s.daysAgo !== undefined && s.daysAgo >= 3 && s.daysAgo <= 6) expect(bucket).toBe('last7')
        if (s.daysAgo !== undefined && s.daysAgo >= 8) expect(bucket).toBe('last30')
      }
    }
  })
})

describe('Store screenshot capture script', () => {
  const script = read('scripts/store-screenshots.mjs')

  it('captures from the Store package binaries and proves they are the package contents', () => {
    expect(script).toMatch(/const UNPACKED = path\.join\(STORE_DIR, 'win-unpacked'\)/)
    expect(script).toMatch(/spawn\(EXE, LAUNCH_ARGS,/)
    // Only Chromium switches are passed to the app: no app option, no environment switch of the app.
    expect(script).toMatch(/const LAUNCH_ARGS = \['--remote-debugging-port=0', '--force-device-scale-factor=1', \.\.\.\(process\.argv\.includes\('--software-rendering'\) \? \['--disable-gpu'\] : \[\]\)\]/)
    expect(script).toMatch(/crc32\(local\) !== entry\.crc32/)
    expect(script).toMatch(/if \(!info\.isPackaged \|\| info\.distribution !== 'store'/)
    // Not the development screenshot mode, and no build from source.
    expect(script).not.toMatch(/SCREENSHOT_MODE|createRequire|require\('electron'\)|electron-vite/)
  })

  it('confines the app to the throw-away profile and refuses misleading states', () => {
    expect(script).toMatch(/USERPROFILE: HOME,/)
    expect(script).toMatch(/APPDATA: path\.join\(HOME, 'AppData', 'Roaming'\)/)
    expect(script).toMatch(/The app is not confined to the throw-away profile/)
    expect(script).toMatch(/The session list is not exactly the synthetic demo sessions/)
    expect(script).toMatch(/if \(safety\.dryRun !== true\) throw/)
    expect(script).toMatch(/processes\.desktopRunning && !allowDesktopRunning/)
    expect(script).toMatch(/The delete plan touches Claude Desktop metadata/)
    expect(script).toMatch(/private data on screen/)
    expect(script).toMatch(/clipped or overflowing text/)
    // It never arms deletion, never runs the plan and never exports.
    expect(script).not.toMatch(/armRealDelete|deleteSession\(|bulkDelete\(|exportSession|ENABLE DELETE/)
    expect(script).toMatch(/\.modal-footer \.btn\.quiet:not\(\.caps\)'\)\.click\(\)/) // Cancel
    expect(script).toMatch(/await removeHome\(\)/)
    // The app is closed like a user closes it; the previewed files and the whole profile are verified afterwards.
    expect(script).toMatch(/page\.evaluate\('window\.close\(\)'\)/)
    expect(script).toMatch(/audit\.deletePlan\.pathsStillExist = planPaths\.every\(\(p\) => existsSync\(p\)\)/)
    expect(script).toMatch(/if \(!report\.profileUnchanged\) throw new Error\('The synthetic profile changed during the capture'\)/)
    // One run of the app: the other languages are chosen in Settings, as a user does.
    expect(script).toMatch(/document\.querySelector\('\.segment\[lang=\$\{JSON\.stringify\(appLocale\)\}\] input'\)/)
    expect(script.match(/await launch\(\)/g)).toHaveLength(1)
  })
})
