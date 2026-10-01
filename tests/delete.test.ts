import { appendFile, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstatOrNull } from '../src/main/util/fsx'
import {
  createFakeClaude,
  createHarness,
  DESKTOP_EXE,
  U,
  userLine,
  VSCODE_CLAUDE_EXE,
  type FakeClaude,
  type Harness
} from './helpers/fakeClaude'

let fake: FakeClaude
beforeEach(async () => {
  fake = await createFakeClaude()
})
afterEach(async () => {
  await fake.cleanup()
})

const PROJ = 'C--Work-demo'

interface World {
  target: { meta: string; transcript: string; dataDir: string; fileHistory: string; sessionEnv: string }
  keep: string[]
}

/** Two Desktop sessions + one CLI session in the same project, plus project memory. */
async function buildWorld(): Promise<World> {
  const target = {
    transcript: await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'delete me', '2026-09-29T01:00:00Z')]),
    dataDir: await fake.writeSessionData(PROJ, U.A),
    fileHistory: await fake.writeUuidDir('file-history', U.A),
    sessionEnv: await fake.writeUuidDir('session-env', U.A),
    meta: await fake.writeMetadata('target', { sessionId: 'local_target', cliSessionId: U.A, title: 'Target', isArchived: true })
  }
  await writeFile(path.join(fake.orgDir, 'archived-sessions.idx'), '{"v":1,"archived":["local_other","local_target"]}')
  const keep = [
    await fake.writeTranscript(PROJ, U.B, [userLine(U.B, 'keep me', '2026-09-29T01:00:00Z')]),
    await fake.writeSessionData(PROJ, U.B),
    await fake.writeUuidDir('file-history', U.B),
    await fake.writeMetadata('other', { sessionId: 'local_other', cliSessionId: U.B, title: 'Other', isArchived: true }),
    await fake.writeTranscript(PROJ, U.C, [userLine(U.C, 'cli keep', '2026-09-29T01:00:00Z')]),
    path.join(fake.projects, PROJ, 'memory', 'MEMORY.md'),
    path.join(fake.orgDir, 'scheduled-tasks.json')
  ]
  await mkdir(path.join(fake.projects, PROJ, 'memory'), { recursive: true })
  await writeFile(path.join(fake.projects, PROJ, 'memory', 'MEMORY.md'), '# keep')
  await writeFile(path.join(fake.orgDir, 'scheduled-tasks.json'), '{"scheduledTasks":[]}')
  return { target, keep }
}

async function scanAndFind(h: Harness, title: string): Promise<string> {
  const snap = await h.repo.scan()
  const s = snap.sessions.find((x) => x.displayTitle === title)
  if (!s) throw new Error(`session ${title} not found`)
  return s.id
}

describe('delete plan', () => {
  it('lists exactly the files of the session, nothing else', async () => {
    const { target } = await buildWorld()
    const h = createHarness(fake)
    const id = await scanAndFind(h, 'Target')
    const plan = await h.deleter.createPlan([id], false)

    expect(plan.globalBlockedReason).toBeUndefined()
    expect(plan.blocked).toEqual([])
    expect(plan.confirmationPhrases).toEqual(['DELETE', 'DELETE PERMANENTLY'])
    const items = plan.sessions[0].items.map((i) => [i.kind, i.action, i.path])
    expect(items).toEqual([
      ['metadata', 'delete-file', target.meta],
      ['archive-index', 'update-file', path.join(fake.orgDir, 'archived-sessions.idx')],
      ['tombstone', 'create-file', path.join(fake.orgDir, 'deleted_target')],
      ['tombstone', 'create-file', path.join(fake.orgDir, `deleted_${U.A}`)],
      ['transcript', 'delete-file', target.transcript],
      ['session-data', 'delete-directory', target.dataDir],
      ['file-history', 'delete-directory', target.fileHistory],
      ['session-env', 'delete-directory', target.sessionEnv],
      ['manager-record', 'remove-record', h.cache.filePath]
    ])
    const s = plan.sessions[0]
    expect(s).toMatchObject({ cliSessionId: U.A, desktopSessionId: 'local_target', projectPath: 'C:\\Work\\demo' })
    // metadata + transcript + 2 files in session data + 1 file-history + 1 session-env backup
    expect(s.totalFiles).toBe(1 + 1 + 2 + 1 + 1)
    // session-data folder (+ its 2 sub-folders) + file-history + session-env
    expect(s.totalDirs).toBe(3 + 1 + 1)
    expect(s.willNotDelete.map((k) => k.path)).toEqual(
      expect.arrayContaining(['C:\\Work\\demo', path.join(fake.projects, PROJ), path.join(fake.projects, PROJ, 'memory')])
    )
    expect(plan.totalBytes).toBeGreaterThan(0)
    expect(plan.reportText).toContain('WILL NOT DELETE')
    expect(plan.reportText).toContain(target.transcript)
  })

  it('a CLI-only session gets no tombstones or metadata items', async () => {
    await buildWorld()
    const h = createHarness(fake)
    const id = await scanAndFind(h, 'cli keep')
    const plan = await h.deleter.createPlan([id], false)
    expect(plan.sessions[0].items.map((i) => [i.kind, i.recordType])).toEqual([
      ['transcript', undefined],
      ['manager-record', 'scan-cache']
    ])
  })

  it('bulk plans require DELETE <n>', async () => {
    await buildWorld()
    const h = createHarness(fake)
    const ids = [await scanAndFind(h, 'Target'), await scanAndFind(h, 'cli keep')]
    const plan = await h.deleter.createPlan(ids, true)
    expect(plan.confirmationPhrases).toEqual(['DELETE 2'])
  })
})

describe('delete execution', () => {
  it('deletes only the exact session and mirrors Claude Desktop tombstones', async () => {
    const { target, keep } = await buildWorld()
    const h = createHarness(fake)
    const id = await scanAndFind(h, 'Target')
    const plan = await h.deleter.createPlan([id], false)
    const before = Date.now()
    const r = await h.deleter.execute([id], 'DELETE', plan.planId, false)

    expect(r.ok).toBe(true)
    expect(r.partial).toBe(false)
    expect(r.sessions[0].outcome).toBe('deleted')
    for (const p of Object.values(target)) expect(await lstatOrNull(p)).toBeNull()
    for (const p of keep) expect(await lstatOrNull(p)).not.toBeNull()
    expect(await lstatOrNull(fake.projects)).not.toBeNull()
    expect(await lstatOrNull(path.join(fake.projects, PROJ))).not.toBeNull()

    const tomb = Number(await readFile(path.join(fake.orgDir, 'deleted_target'), 'utf8'))
    expect(tomb).toBeGreaterThanOrEqual(before)
    expect(await lstatOrNull(path.join(fake.orgDir, `deleted_${U.A}`))).not.toBeNull()
    expect(await readFile(path.join(fake.orgDir, 'archived-sessions.idx'), 'utf8')).toBe('{"v":1,"archived":["local_other"]}')
    expect((await readdir(fake.orgDir)).filter((f) => f.endsWith('.tmp'))).toEqual([])

    const after = h.repo.getSnapshot()!.sessions.map((s) => s.displayTitle).sort()
    expect(after).toEqual(['Other', 'cli keep'])
  })

  it('rejects a wrong confirmation, an unknown token and token reuse', async () => {
    const { target } = await buildWorld()
    const h = createHarness(fake)
    const id = await scanAndFind(h, 'Target')
    const plan = await h.deleter.createPlan([id], false)
    expect(await h.deleter.execute([id], 'delete', plan.planId, false)).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(await h.deleter.execute([id], 'DELETE', 'bogus', false)).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(await lstatOrNull(target.transcript)).not.toBeNull()

    expect((await h.deleter.execute([id], 'DELETE', plan.planId, false)).ok).toBe(true)
    expect(await h.deleter.execute([id], 'DELETE', plan.planId, false)).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })

  it('rejects ids that differ from the previewed plan', async () => {
    await buildWorld()
    const h = createHarness(fake)
    const id = await scanAndFind(h, 'Target')
    const other = await scanAndFind(h, 'cli keep')
    const plan = await h.deleter.createPlan([id], false)
    expect(await h.deleter.execute([other], 'DELETE', plan.planId, false)).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })

  it('aborts when files changed after the preview', async () => {
    const { target } = await buildWorld()
    const h = createHarness(fake)
    const id = await scanAndFind(h, 'Target')
    const plan = await h.deleter.createPlan([id], false)
    await appendFile(target.transcript, JSON.stringify(userLine(U.A, 'new message', '2026-09-30T00:00:00Z')) + '\n')
    const r = await h.deleter.execute([id], 'DELETE', plan.planId, false)
    expect(r).toMatchObject({ ok: false, code: 'STALE_PLAN' })
    expect(await lstatOrNull(target.transcript)).not.toBeNull()
    expect(await lstatOrNull(target.meta)).not.toBeNull()
  })

  it('refuses when the session folder was swapped for a junction after the preview', async () => {
    const { target } = await buildWorld()
    const outside = path.join(fake.root, 'precious')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'important.txt'), 'must survive')
    const h = createHarness(fake)
    const id = await scanAndFind(h, 'Target')
    const plan = await h.deleter.createPlan([id], false)
    await rm(target.dataDir, { recursive: true })
    await symlink(outside, target.dataDir, 'junction')
    const r = await h.deleter.execute([id], 'DELETE', plan.planId, false)
    expect(r.ok).toBe(false)
    expect(await readFile(path.join(outside, 'important.txt'), 'utf8')).toBe('must survive')
    expect(await lstatOrNull(target.transcript)).not.toBeNull()
  })

  it('is blocked while Claude Desktop runs', async () => {
    const { target } = await buildWorld()
    const h = createHarness(fake)
    h.processes.push({ pid: 77, name: 'claude.exe', executablePath: DESKTOP_EXE })
    const id = await scanAndFind(h, 'Target')
    const plan = await h.deleter.createPlan([id], false)
    expect(plan.globalBlockedReason).toBe('Close Claude Desktop before modifying session files.')
    const r = await h.deleter.execute([id], 'DELETE', plan.planId, false)
    expect(r).toMatchObject({ ok: false, code: 'CLAUDE_RUNNING' })
    expect(await lstatOrNull(target.transcript)).not.toBeNull()
  })

  it('skips a session that is open in a running Claude Code process', async () => {
    await buildWorld()
    await fake.writeLive(5150, U.C)
    const h = createHarness(fake)
    h.processes.push({ pid: 5150, name: 'claude.exe', executablePath: VSCODE_CLAUDE_EXE })
    const live = await scanAndFind(h, 'cli keep')
    const target = await scanAndFind(h, 'Target')
    const plan = await h.deleter.createPlan([live, target], true)
    expect(plan.blocked.map((b) => b.blockedCode)).toEqual(['SESSION_IN_USE'])
    expect(plan.sessions.map((s) => s.sessionId)).toEqual([target])
    expect(plan.confirmationPhrases).toEqual(['DELETE 1'])
    const r = await h.deleter.execute([target], 'DELETE 1', plan.planId, true)
    expect(r.ok).toBe(true)
    expect(await lstatOrNull(path.join(fake.projects, PROJ, `${U.C}.jsonl`))).not.toBeNull()
  })

  it('dry run deletes nothing but reports the plan', async () => {
    const { target } = await buildWorld()
    const h = createHarness(fake, { dryRun: true })
    const id = await scanAndFind(h, 'Target')
    const plan = await h.deleter.createPlan([id], false)
    expect(plan.dryRun).toBe(true)
    const r = await h.deleter.execute([id], 'DELETE', plan.planId, false)
    expect(r).toMatchObject({ ok: true, dryRun: true })
    expect(r.sessions[0].items.every((i) => i.outcome === 'dry-run')).toBe(true)
    for (const p of Object.values(target)) expect(await lstatOrNull(p)).not.toBeNull()
    expect(await lstatOrNull(path.join(fake.orgDir, 'deleted_target'))).toBeNull()
  })

  it('bulk deletes several sessions', async () => {
    await buildWorld()
    const h = createHarness(fake)
    const ids = [await scanAndFind(h, 'Target'), await scanAndFind(h, 'cli keep')]
    const plan = await h.deleter.createPlan(ids, true)
    expect(await h.deleter.execute(ids, 'DELETE 1', plan.planId, true)).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    const plan2 = await h.deleter.createPlan(ids, true)
    const r = await h.deleter.execute(ids, 'DELETE 2', plan2.planId, true)
    expect(r.ok).toBe(true)
    expect(h.repo.getSnapshot()!.sessions.map((s) => s.displayTitle)).toEqual(['Other'])
  })

  it('never deletes a transcript shared by two metadata files', async () => {
    const shared = await fake.writeTranscript(PROJ, U.D, [userLine(U.D, 'shared', '2026-09-29T01:00:00Z')])
    await fake.writeMetadata('x1', { sessionId: 'local_x1', cliSessionId: U.D, title: 'X1' })
    await fake.writeMetadata('x2', { sessionId: 'local_x2', cliSessionId: U.D, title: 'X2' })
    const h = createHarness(fake)
    const id = await scanAndFind(h, 'X1')
    const plan = await h.deleter.createPlan([id], false)
    expect(plan.sessions[0].items.map((i) => i.kind)).toEqual(['metadata', 'tombstone'])
    expect(plan.sessions[0].warnings.join(' ')).toMatch(/referenced by another session/)
    await h.deleter.execute([id], 'DELETE', plan.planId, false)
    expect(await lstatOrNull(shared)).not.toBeNull()
  })
})
