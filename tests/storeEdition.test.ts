import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STORE_CAPABILITIES, storeBuilderConfig, type StoreIdentity } from '../scripts/store-config.mjs'
import { reviewManifest } from '../scripts/store-inspect.mjs'
import { STORE_APP_NAME } from '../src/shared/appIdentity'
import { SUPPORTED_LOCALES } from '../src/shared/locale'
import { RESOURCES } from '../src/shared/locales'
import { matchesSearch } from '../src/shared/sessionQuery'
import { ExportService } from '../src/main/services/exportService'
import { isolatedPlanItems, packagingPolicy, type PackagingPolicy } from '../src/main/services/packagingPolicy'
import { lstatOrNull } from '../src/main/util/fsx'
import { createFakeClaude, createHarness, DESKTOP_EXE, U, userLine, type FakeClaude, type Harness } from './helpers/fakeClaude'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8')
const PROJ = 'C--Work-demo'

let fake: FakeClaude
beforeEach(async () => {
  fake = await createFakeClaude()
})
afterEach(async () => {
  await fake.cleanup()
})

/** Every file under the fake profile with a content hash: any create, change or delete shows up. */
async function snapshot(dir = fake.home): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out[full + path.sep] = 'dir'
      Object.assign(out, await snapshot(full))
    } else {
      out[full] = createHash('sha256').update(await readFile(full)).digest('hex') + ':' + (await stat(full)).mtimeMs
    }
  }
  return out
}

interface World {
  desktop: { meta: string; transcript: string; dataDir: string; index: string }
  cli: { transcript: string; dataDir: string; fileHistory: string; sessionEnv: string }
  keep: string[]
}

/** One archived Claude Desktop session (metadata under AppData) and one transcript-only session, same project. */
async function buildWorld(): Promise<World> {
  const index = path.join(fake.orgDir, 'archived-sessions.idx')
  const desktop = {
    transcript: await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'desktop session prompt', '2026-09-29T01:00:00Z')]),
    dataDir: await fake.writeSessionData(PROJ, U.A),
    meta: await fake.writeMetadata('desk', { sessionId: 'local_desk', cliSessionId: U.A, cwd: 'C:\\Work\\demo', title: 'Desktop session', isArchived: true }),
    index
  }
  await writeFile(index, '{"v":1,"archived":["local_desk"]}')
  const cli = {
    transcript: await fake.writeTranscript(PROJ, U.B, [userLine(U.B, 'transcript only prompt about caching', '2026-09-29T02:00:00Z')]),
    dataDir: await fake.writeSessionData(PROJ, U.B),
    fileHistory: await fake.writeUuidDir('file-history', U.B),
    sessionEnv: await fake.writeUuidDir('session-env', U.B)
  }
  await mkdir(path.join(fake.projects, PROJ, 'memory'), { recursive: true })
  const memory = path.join(fake.projects, PROJ, 'memory', 'MEMORY.md')
  await writeFile(memory, '# keep')
  return { desktop, cli, keep: [memory, desktop.meta, desktop.transcript, index] }
}

async function scan(h: Harness): Promise<{ desktopId: string; cliId: string }> {
  const snap = await h.repo.scan()
  const desktop = snap.sessions.find((s) => s.hasMetadata)
  const cli = snap.sessions.find((s) => !s.hasMetadata)
  if (!desktop || !cli) throw new Error('fixture sessions not found')
  return { desktopId: desktop.id, cliId: cli.id }
}

const store = (opts: Parameters<typeof createHarness>[1] = {}): Harness => createHarness(fake, { channel: 'store', appName: STORE_APP_NAME, ...opts })

const FIXTURE_IDENTITY: StoreIdentity = {
  identityName: '12345Fixture.LocalSessionManager',
  publisher: 'CN=0A1B2C3D-0000-4000-8000-ABCDEF012345',
  publisherDisplayName: 'Fixture Publisher',
  displayName: STORE_APP_NAME,
  storeProductId: ''
}

/** electron-builder's own AppX manifest template (the Store build uses it unchanged), filled in like the builder does. */
function manifest(caps: string[], extraProperties = ''): string {
  const values: Record<string, string> = {
    identityName: FIXTURE_IDENTITY.identityName,
    publisher: FIXTURE_IDENTITY.publisher,
    publisherDisplayName: FIXTURE_IDENTITY.publisherDisplayName,
    displayName: FIXTURE_IDENTITY.displayName,
    version: '1.2.4.0',
    arch: 'x64',
    applicationId: 'ClaudeLocalSessionManager',
    executable: `app\\${STORE_APP_NAME}.exe`,
    capabilities: `<Capabilities>${caps.map((c) => `<rescap:Capability Name="${c}"/>`).join('')}</Capabilities>`,
    resourceLanguages: ['en-US', 'vi-VN', 'zh-CN'].map((l) => `<Resource Language="${l}" />`).join(''),
    minVersion: '10.0.19041.0',
    maxVersionTested: '10.0.26100.0'
  }
  return read('node_modules/app-builder-lib/templates/appx/appxmanifest.xml')
    .replace(/\$\{(\w+)\}/g, (_m, k: string) => values[k] ?? '')
    .replace('</Properties>', `${extraProperties}</Properties>`)
}

describe('Store package capabilities', () => {
  const opts = { identity: FIXTURE_IDENTITY, storeVersion: '1.2.4.0' }

  it('requests runFullTrust only: no unvirtualizedResources, no virtualization override, no custom manifest', () => {
    const cfg = storeBuilderConfig({ identity: FIXTURE_IDENTITY, version: '1.2.4' })
    expect(STORE_CAPABILITIES).toEqual(['runFullTrust'])
    expect(cfg.appx.capabilities).toEqual([]) // electron-builder adds runFullTrust itself
    expect(cfg.appx.customManifestPath).toBeUndefined()
    expect(fs.existsSync(path.join(ROOT, 'store', 'AppxManifest.template.xml'))).toBe(false)
    expect(JSON.stringify(cfg)).not.toMatch(/unvirtualizedResources|FileSystemWriteVirtualization|broadFileSystemAccess/)
    // electron-builder always adds runFullTrust (the capability must stay).
    expect(read('node_modules/app-builder-lib/out/targets/AppxTarget.js')).toMatch(/capSet\.add\("runFullTrust"\)/)
    for (const file of ['scripts/store-config.mjs', 'scripts/dist-store.mjs']) {
      expect(read(file)).not.toMatch(/capabilities:\s*\[[^\]]*['"](unvirtualizedResources|broadFileSystemAccess)/)
    }
  })

  it('the manifest review passes with runFullTrust alone and fails on the denied declarations', () => {
    const good = manifest(['runFullTrust'])
    expect(good).toMatch(/<rescap:Capability Name="runFullTrust"\/>/)
    expect(good).not.toMatch(/unvirtualizedResources|FileSystemWriteVirtualization|desktop6/)
    expect(reviewManifest(good, opts).ok).toBe(true)
    expect(reviewManifest(manifest(['runFullTrust', 'unvirtualizedResources']), opts).ok).toBe(false)
    expect(reviewManifest(manifest(['runFullTrust', 'broadFileSystemAccess']), opts).ok).toBe(false)
    expect(reviewManifest(manifest([]), opts).ok).toBe(false) // runFullTrust must remain
    const virtualizationOff = manifest(['runFullTrust'], '<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>')
    expect(reviewManifest(virtualizationOff, opts).ok).toBe(false)
  })
})

describe('packaging policy', () => {
  it('only the Store edition isolates AppData and Claude Desktop roots; GitHub and development restrict nothing', () => {
    const env = { homedir: 'C:\\Users\\u', appData: 'C:\\Users\\u\\AppData\\Roaming', localAppData: 'C:\\Users\\u\\AppData\\Local' }
    const s = packagingPolicy('store', env)
    expect(s.isolatesAppData).toBe(true)
    expect(s.isolatedRootOf('C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code-sessions\\a\\b\\local_x.json')).toBe(env.appData)
    expect(s.isolatedRootOf('c:\\users\\U\\appdata\\local\\Packages\\Claude_x\\LocalCache\\Roaming\\Claude\\x')).toBe(env.localAppData)
    expect(s.isolatedRootOf('C:\\Users\\u\\AppData\\LocalLow\\x')).toBe('C:\\Users\\u\\AppData')
    expect(s.isolatedRootOf('D:\\ClaudeData\\claude-code-sessions\\a\\local_x.json', ['D:\\ClaudeData\\claude-code-sessions'])).toBe('D:\\ClaudeData\\claude-code-sessions')
    expect(s.isolatedRootOf('C:\\Users\\u\\.claude\\projects\\p\\x.jsonl')).toBeNull()
    expect(s.isolatedRootOf('C:\\Users\\u\\AppDataBackup\\x')).toBeNull() // a sibling name is not AppData
    expect(s.isolatedRootOf('C:\\Users\\u\\Documents\\export.md')).toBeNull()
    for (const channel of ['github', 'development'] as const) {
      const p = packagingPolicy(channel, env)
      expect(p.isolatesAppData).toBe(false)
      expect(p.isolatedRoots(['D:\\x'])).toEqual([])
      expect(p.isolatedRootOf('C:\\Users\\u\\AppData\\Roaming\\Claude\\x')).toBeNull()
    }
  })

  it('a plan is refused for any Claude file under an isolated root; the manager records never count', () => {
    const p = packagingPolicy('store', { homedir: 'C:\\Users\\u' })
    const outside = { kind: 'transcript', action: 'delete-file', path: 'C:\\Users\\u\\.claude\\projects\\p\\x.jsonl' } as const
    const record = { kind: 'manager-record', action: 'remove-record', path: 'C:\\Users\\u\\AppData\\Roaming\\LHP Local Session Manager\\scan-cache.json' } as const
    const marker = { kind: 'tombstone', action: 'create-file', path: 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code-sessions\\a\\b\\deleted_x' } as const
    expect(isolatedPlanItems([outside, record], p)).toEqual([])
    expect(isolatedPlanItems([outside, record, marker], p)).toEqual([marker])
    expect(isolatedPlanItems([marker], packagingPolicy('github', { homedir: 'C:\\Users\\u' }))).toEqual([])
    expect(isolatedPlanItems([marker], undefined)).toEqual([])
  })
})

describe('Store edition: Claude Desktop data is read-only', () => {
  it('Archive is blocked for a Desktop-backed session, before anything is read or written', async () => {
    await buildWorld()
    await writeFile(path.join(fake.orgDir, 'local_active.json'), JSON.stringify({ sessionId: 'local_active', cliSessionId: U.C, title: 'Active', isArchived: false }))
    const h = store({ dryRun: false })
    const snap = await h.repo.scan()
    const active = snap.sessions.find((s) => s.displayTitle === 'Active')!
    const before = await snapshot()

    const r = await h.archive.setArchived(active.id, true)
    expect(r).toMatchObject({ ok: false, code: 'NOT_SUPPORTED', msg: { key: 'store.archiveUnavailable' } })
    expect(r.message).toMatch(/Microsoft Store edition/)
    expect(r.message).toMatch(/Windows Store packaging isolates certain AppData writes/)
    const bulk = await h.archive.bulk([active.id], true)
    expect(bulk.ok).toBe(false)
    expect(bulk.results[0]).toMatchObject({ ok: false, code: 'NOT_SUPPORTED' })
    expect(await snapshot()).toEqual(before)
  })

  it('Restore is blocked for a Desktop-backed session; metadata and archive index stay byte-identical', async () => {
    const { desktop } = await buildWorld()
    const h = store({ dryRun: false })
    const { desktopId } = await scan(h)
    const before = await snapshot()

    expect(await h.archive.setArchived(desktopId, false)).toMatchObject({ ok: false, code: 'NOT_SUPPORTED', msg: { key: 'store.archiveUnavailable' } })
    expect(await snapshot()).toEqual(before)
    expect(JSON.parse(await readFile(desktop.meta, 'utf8')).isArchived).toBe(true)
    expect(await readFile(desktop.index, 'utf8')).toBe('{"v":1,"archived":["local_desk"]}')
    // No temp file was created next to the metadata.
    expect((await readdir(fake.orgDir)).sort()).toEqual(['archived-sessions.idx', 'local_desk.json'])
  })

  it('a delete plan that needs new deleted_<id> markers is rejected before any file system change', async () => {
    const { desktop } = await buildWorld()
    await writeFile(desktop.index, '{"v":1,"archived":[]}') // no index update needed: only markers + the metadata file
    const h = store({ dryRun: false })
    const { desktopId } = await scan(h)
    const before = await snapshot()

    const plan = await h.deleter.createPlan([desktopId], false)
    expect(plan.sessions).toEqual([])
    expect(plan.blocked).toHaveLength(1)
    expect(plan.blocked[0]).toMatchObject({ blockedCode: 'NOT_SUPPORTED', blockedMsg: { key: 'store.deleteUnavailable' } })
    expect(plan.blocked[0].blockedReason).toMatch(/Microsoft Store edition/)
    // The plan still shows what a delete would have needed, including the markers.
    const kinds = plan.blocked[0].items.map((i) => `${i.kind}:${i.action}`)
    expect(kinds).toEqual(expect.arrayContaining(['metadata:delete-file', 'tombstone:create-file']))
    expect(kinds).not.toContain('archive-index:update-file')

    const r = await h.deleter.execute([desktopId], 'DELETE', plan.planId, false)
    expect(r).toMatchObject({ ok: false, sessions: [] })
    expect(await snapshot()).toEqual(before)
    expect((await readdir(fake.orgDir)).filter((f) => f.startsWith('deleted_'))).toEqual([])
  })

  it('a delete plan that needs an AppData temp-file rewrite (archive index) is rejected', async () => {
    const { desktop } = await buildWorld()
    const h = store({ dryRun: false })
    const { desktopId } = await scan(h)
    const before = await snapshot()

    const plan = await h.deleter.createPlan([desktopId], false)
    expect(plan.sessions).toEqual([])
    expect(plan.blocked[0].items.map((i) => `${i.kind}:${i.action}`)).toContain('archive-index:update-file')
    expect(plan.blocked[0]).toMatchObject({ blockedCode: 'NOT_SUPPORTED', blockedMsg: { key: 'store.deleteUnavailable' } })
    expect((await h.deleter.execute([desktopId], 'DELETE', plan.planId, false)).ok).toBe(false)
    expect(await snapshot()).toEqual(before)
    expect(await readFile(desktop.index, 'utf8')).toBe('{"v":1,"archived":["local_desk"]}')
  })

  it('even a plan approved before the restriction applied is refused at execution, with nothing deleted', async () => {
    const { desktop } = await buildWorld()
    // A policy that turns into the Store policy after the plan was created (cannot happen in a real build).
    const strict = packagingPolicy('store', fake.env)
    let restricted = false
    const policy: PackagingPolicy = {
      channel: 'store',
      get isolatesAppData() {
        return restricted
      },
      isolatedRoots: (roots) => (restricted ? strict.isolatedRoots(roots) : []),
      isolatedRootOf: (target, roots) => (restricted ? strict.isolatedRootOf(target, roots) : null)
    }
    const h = createHarness(fake, { dryRun: false, policy })
    const { desktopId } = await scan(h)
    const plan = await h.deleter.createPlan([desktopId], false)
    expect(plan.sessions).toHaveLength(1)
    const before = await snapshot()

    restricted = true
    const r = await h.deleter.execute([desktopId], 'DELETE', plan.planId, false)
    expect(r).toMatchObject({ ok: false, code: 'NOT_SUPPORTED', sessions: [] })
    expect(r.message).toMatch(/Microsoft Store edition/)
    expect(await snapshot()).toEqual(before)
    expect(await lstatOrNull(desktop.transcript)).not.toBeNull() // not a partial delete: the transcript outside AppData is kept too
  })

  it('in a bulk delete the Desktop-backed session is skipped as a whole and only the transcript-only one is removed', async () => {
    const { desktop, cli } = await buildWorld()
    const h = store({ dryRun: false })
    const { desktopId, cliId } = await scan(h)
    const plan = await h.deleter.createPlan([desktopId, cliId], true)
    expect(plan.sessions.map((s) => s.sessionId)).toEqual([cliId])
    expect(plan.blocked.map((s) => s.sessionId)).toEqual([desktopId])
    expect(plan.confirmationPhrases).toEqual(['DELETE 1'])

    const r = await h.deleter.execute([cliId], 'DELETE 1', plan.planId, true)
    expect(r.ok).toBe(true)
    expect(await lstatOrNull(cli.transcript)).toBeNull()
    for (const p of [desktop.meta, desktop.transcript, desktop.dataDir, desktop.index]) expect(await lstatOrNull(p), p).not.toBeNull()
    expect((await readdir(fake.orgDir)).sort()).toEqual(['archived-sessions.idx', 'local_desk.json'])
  })
})

describe('Store edition: transcript-only sessions outside AppData', () => {
  it('permanent delete still works when every existing guard passes, and touches nothing else', async () => {
    const { cli, keep } = await buildWorld()
    const h = store({ dryRun: false })
    const { cliId } = await scan(h)

    const plan = await h.deleter.createPlan([cliId], false)
    expect(plan.blocked).toEqual([])
    expect(plan.dryRun).toBe(false)
    expect(plan.sessions[0].items.map((i) => [i.kind, i.action, i.path])).toEqual([
      ['transcript', 'delete-file', cli.transcript],
      ['session-data', 'delete-directory', cli.dataDir],
      ['file-history', 'delete-directory', cli.fileHistory],
      ['session-env', 'delete-directory', cli.sessionEnv],
      ['manager-record', 'remove-record', h.cache.filePath]
    ])
    expect(isolatedPlanItems(plan.sessions[0].items, h.policy, [fake.desktopRoot])).toEqual([])
    expect(plan.sessions[0].willNotDelete.map((k) => k.path)).toEqual(expect.arrayContaining(['C:\\Work\\demo', path.join(fake.projects, PROJ)]))
    expect(plan.reportText).toMatch(/^LHP LOCAL SESSION MANAGER - DELETE PLAN/)

    // Typed confirmation is still required.
    expect((await h.deleter.execute([cliId], 'delete', plan.planId, false)).ok).toBe(false)
    const again = await h.deleter.createPlan([cliId], false)
    const r = await h.deleter.execute([cliId], 'DELETE', again.planId, false)
    expect(r).toMatchObject({ ok: true, partial: false, dryRun: false })
    expect(r.sessions[0].outcome).toBe('deleted')
    for (const p of [cli.transcript, cli.dataDir, cli.fileHistory, cli.sessionEnv]) expect(await lstatOrNull(p), p).toBeNull()
    for (const p of keep) expect(await lstatOrNull(p), p).not.toBeNull()
  })

  it('Safe Mode, the process guard and plan hashing behave exactly as before', async () => {
    const { cli } = await buildWorld()
    // Safe Mode: a dry run validates and deletes nothing.
    const safe = store({ dryRun: true })
    const ids = await scan(safe)
    const dry = await safe.deleter.createPlan([ids.cliId], false)
    expect(dry.dryRun).toBe(true)
    expect(await safe.deleter.execute([ids.cliId], 'DELETE', dry.planId, false)).toMatchObject({ ok: true, dryRun: true })
    expect(await lstatOrNull(cli.transcript)).not.toBeNull()

    // Claude Desktop running blocks a real delete.
    const h = store({ dryRun: false })
    const { cliId } = await scan(h)
    h.processes.push({ pid: 77, name: 'claude.exe', executablePath: DESKTOP_EXE })
    const blocked = await h.deleter.createPlan([cliId], false)
    expect(blocked.globalBlockedCode).toBe('CLAUDE_RUNNING')
    expect((await h.deleter.execute([cliId], 'DELETE', blocked.planId, false)).ok).toBe(false)
    h.processes.length = 0

    // A session file changed after the plan was shown: stale plan, nothing deleted.
    const plan = await h.deleter.createPlan([cliId], false)
    await writeFile(path.join(cli.dataDir, 'tool-results', 'new.txt'), 'appeared after the plan')
    expect(await h.deleter.execute([cliId], 'DELETE', plan.planId, false)).toMatchObject({ ok: false, code: 'STALE_PLAN' })
    expect(await lstatOrNull(cli.transcript)).not.toBeNull()
  })

  it('Hide in manager works (it only changes this app’s own list)', async () => {
    const { cli } = await buildWorld()
    const h = store()
    const { cliId } = await scan(h)
    const before = await snapshot()
    expect(await h.archive.setHidden(cliId, true)).toMatchObject({ ok: true })
    expect(h.repo.getSnapshot()!.sessions.find((s) => s.id === cliId)!.hiddenInManager).toBe(true)
    expect(await h.archive.setHidden(cliId, false)).toMatchObject({ ok: true })
    expect(await snapshot()).toEqual(before)
    expect(await lstatOrNull(cli.transcript)).not.toBeNull()
  })
})

describe('Store edition: browse, search and export', () => {
  it('scans and inspects both kinds of session, including Claude Desktop metadata read from AppData', async () => {
    await buildWorld()
    const h = store()
    const { desktopId, cliId } = await scan(h)
    const sessions = h.repo.getSnapshot()!.sessions
    expect(sessions).toHaveLength(2)
    const desktop = sessions.find((s) => s.id === desktopId)!
    expect(desktop).toMatchObject({ kind: 'desktop', status: 'archived', displayTitle: 'Desktop session', cliSessionId: U.A, projectPath: 'C:\\Work\\demo' })
    expect(sessions.find((s) => s.id === cliId)).toMatchObject({ kind: 'cli', status: 'transcript-only', cliSessionId: U.B })
    expect(sessions.filter((s) => matchesSearch(s, 'caching')).map((s) => s.id)).toEqual([cliId])
    expect(sessions.filter((s) => matchesSearch(s, 'desktop session')).map((s) => s.id)).toEqual([desktopId])
    const details = await h.repo.getDetails(desktopId)
    expect(JSON.parse(details!.rawMetadata!)).toMatchObject({ sessionId: 'local_desk', isArchived: true })
  })

  it('exports a session to a folder outside AppData, under the Store product name', async () => {
    const { desktop } = await buildWorld()
    const h = store()
    const { desktopId } = await scan(h)
    const out = path.join(fake.root, 'exports')
    await mkdir(out)
    const exporter = new ExportService(h.repo, { chooseFile: async () => path.join(out, 'one.md'), chooseDirectory: async () => out }, { policy: h.policy, appName: STORE_APP_NAME })
    const before = await snapshot()

    expect(await exporter.exportOne(desktopId, 'markdown')).toMatchObject({ ok: true, files: [path.join(out, 'one.md')] })
    const md = await readFile(path.join(out, 'one.md'), 'utf8')
    expect(md).toContain('# Desktop session')
    expect(md).toContain('Exported by LHP Local Session Manager (unofficial)')
    expect(md).not.toContain('Claude Local Session Manager')
    const many = await exporter.exportMany([desktopId], ['jsonl', 'info'])
    expect(many.ok).toBe(true)
    expect(many.files).toHaveLength(2)
    expect(JSON.parse(await readFile(many.files.find((f) => f.endsWith('.info.json'))!, 'utf8')).exportedBy).toBe('LHP Local Session Manager (unofficial)')
    // Export only reads the session files.
    expect(await snapshot()).toEqual(before)
    expect(await readFile(desktop.transcript, 'utf8')).toContain('desktop session prompt')
  })

  it('refuses to export into AppData, where Windows would redirect the file', async () => {
    await buildWorld()
    const h = store()
    const { cliId } = await scan(h)
    const inAppData = path.join(fake.env.appData!, 'exports')
    await mkdir(inAppData, { recursive: true })
    const exporter = new ExportService(h.repo, { chooseFile: async () => path.join(inAppData, 'x.jsonl'), chooseDirectory: async () => inAppData }, { policy: h.policy })
    expect(await exporter.exportOne(cliId, 'jsonl')).toMatchObject({ ok: false, msg: { key: 'store.exportIntoAppData' }, files: [] })
    expect(await exporter.exportMany([cliId], ['jsonl'])).toMatchObject({ ok: false, msg: { key: 'store.exportIntoAppData' }, files: [] })
    expect(await readdir(inAppData)).toEqual([])
    // The GitHub builds have no such restriction.
    const github = new ExportService(h.repo, { chooseFile: async () => path.join(inAppData, 'x.jsonl'), chooseDirectory: async () => inAppData })
    expect((await github.exportOne(cliId, 'jsonl')).ok).toBe(true)
  })
})

describe('GitHub Setup / Portable keep the full feature set', () => {
  it('archive, restore and delete of a Claude Desktop session work as before', async () => {
    const { desktop } = await buildWorld()
    const h = createHarness(fake, { dryRun: false, channel: 'github' })
    expect(h.policy.isolatesAppData).toBe(false)
    const { desktopId } = await scan(h)

    expect(await h.archive.setArchived(desktopId, false)).toMatchObject({ ok: true })
    expect(JSON.parse(await readFile(desktop.meta, 'utf8')).isArchived).toBe(false)
    expect(await readFile(desktop.index, 'utf8')).toBe('{"v":1,"archived":[]}')
    expect(await h.archive.setArchived(desktopId, true)).toMatchObject({ ok: true })

    const plan = await h.deleter.createPlan([desktopId], false)
    expect(plan.blocked).toEqual([])
    expect(plan.sessions[0].items.map((i) => i.kind)).toEqual(expect.arrayContaining(['metadata', 'archive-index', 'tombstone', 'transcript']))
    expect(plan.reportText).toMatch(/^CLAUDE LOCAL SESSION MANAGER - DELETE PLAN/)
    const r = await h.deleter.execute([desktopId], 'DELETE', plan.planId, false)
    expect(r).toMatchObject({ ok: true, partial: false })
    expect(await lstatOrNull(desktop.meta)).toBeNull()
    expect(await lstatOrNull(desktop.transcript)).toBeNull()
    expect((await readdir(fake.orgDir)).sort()).toEqual(['archived-sessions.idx', `deleted_${U.A}`, 'deleted_desk'])
  })

  it('the default (no channel given) is unrestricted, so every existing test exercises the GitHub behaviour', () => {
    const h = createHarness(fake)
    expect(h.policy).toMatchObject({ channel: 'github', isolatesAppData: false })
  })
})

describe('Store edition wiring and wording', () => {
  it('the main process gives the same policy to archive, delete and export, and tells the UI', () => {
    const main = read('src/main/index.ts')
    expect(main).toMatch(/const policy = packagingPolicy\(distribution\.channel, discoveryEnv\)/)
    expect(main).toMatch(/new ArchiveService\(repo, processes, hidden, \(\) => safety\.isDryRun\(\), policy\)/)
    expect(main).toMatch(/new DeleteService\(repo, processes, \{[\s\S]*?\n {4}policy,/)
    expect(main).toMatch(/new ExportService\(repo, exportDialogs, \{ policy, appName: brand\.name \}\)/)
    expect(main).toMatch(/desktopDataReadOnly: policy\.isolatesAppData/)
  })

  it('the UI hides Archive / Restore and disables Delete for Desktop-backed sessions in the Store edition', () => {
    const details = read('src/renderer/src/components/DetailsPanel.tsx')
    expect(details).toMatch(/const storeReadOnly = s\.hasMetadata && !!appInfo\?\.desktopDataReadOnly/)
    expect(details).toMatch(/\{storeReadOnly \? null : s\.hasMetadata \? \(/)
    expect(details).toMatch(/disabled=\{busy \|\| deleteBlock \|\| storeReadOnly\}/)
    expect(details).toMatch(/inspector:note\.storeDesktop/)
    const list = read('src/renderer/src/components/SessionList.tsx')
    expect(list).toMatch(/\{canArchive && selDesktopActive\.length > 0 && \(/)
    expect(list).toMatch(/\{canArchive && selDesktopArchived\.length > 0 && \(/)
  })

  it('every language explains the limitation and never tells the user to bypass it', () => {
    for (const l of SUPPORTED_LOCALES) {
      const r = RESOURCES[l] as Record<string, Record<string, Record<string, string>>>
      const texts = [r.messages.store.archiveUnavailable, r.messages.store.deleteUnavailable, r.messages.store.exportIntoAppData, r.inspector.note.storeDesktop, r.settings.storeEdition.limits]
      for (const text of texts) {
        expect(text, l).toMatch(/Microsoft Store/)
        expect(text, l).toMatch(/AppData/)
        expect(text, l).not.toMatch(/GitHub|unvirtualized|disable|bypass|workaround/i)
      }
      expect(r.messages.window.problemDetailStore).toMatch(/Microsoft Store/)
      expect(r.messages.window.problemDetailStore).not.toMatch(/GitHub/)
    }
    const en = RESOURCES.en.messages as unknown as { store: Record<string, string> }
    expect(en.store.archiveUnavailable).toMatch(/Windows Store packaging isolates certain AppData writes/)
    expect(en.store.deleteUnavailable).toMatch(/Nothing was changed\.$/)
  })
})
