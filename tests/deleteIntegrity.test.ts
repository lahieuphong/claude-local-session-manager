import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertId, assertIds, assertPlanId } from '../src/main/ipc/validators'
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

async function oneSession(): Promise<{ h: Harness; id: string; transcript: string }> {
  const transcript = await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'target', '2026-09-29T01:00:00Z')])
  await fake.writeSessionData(PROJ, U.A)
  await fake.writeTranscript(PROJ, U.B, [userLine(U.B, 'other', '2026-09-29T01:00:00Z')])
  const h = createHarness(fake)
  const snap = await h.repo.scan()
  return { h, id: snap.sessions.find((s) => s.cliSessionId === U.A)!.id, transcript }
}

/** Every file and folder below `dir` with size, mtime and content hash. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const st = await stat(p)
      if (e.isDirectory()) {
        out[p] = `dir ${st.mtimeMs}`
        await walk(p)
      } else {
        out[p] = `file ${st.size} ${st.mtimeMs} ${createHash('sha1').update(await readFile(p)).digest('hex')}`
      }
    }
  }
  await walk(dir)
  return out
}

describe('plan ID and content hash', () => {
  it('every plan gets a unique 32-hex ID; identical content gives an identical hash', async () => {
    const { h, id } = await oneSession()
    const a = await h.deleter.createPlan([id], false)
    const b = await h.deleter.createPlan([id], false)
    expect(a.planId).toMatch(/^[a-f0-9]{32}$/)
    expect(a.planId).not.toBe(b.planId)
    expect(a.contentHash).toBe(b.contentHash)
    expect(a.reportText).toContain(a.planId)
    expect(a.reportText).toContain(`sha256:${a.contentHash}`)
  })

  it('rejects unknown, reused and expired plan IDs', async () => {
    const { h, id } = await oneSession()
    expect(await h.deleter.execute([id], 'DELETE', 'f'.repeat(32), false)).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    const plan = await h.deleter.createPlan([id], false)
    expect((await h.deleter.execute([id], 'DELETE', plan.planId, false)).ok).toBe(true)
    expect(await h.deleter.execute([id], 'DELETE', plan.planId, false)).toMatchObject({ ok: false, code: 'INVALID_INPUT' })

    const fake2 = createHarness(fake, { planTtlMs: 1 })
    const other = (await fake2.repo.scan()).sessions[0].id
    const expired = await fake2.deleter.createPlan([other], false)
    await new Promise((r) => setTimeout(r, 15))
    expect(await fake2.deleter.execute([other], 'DELETE', expired.planId, false)).toMatchObject({ ok: false, code: 'STALE_PLAN' })
  })

  it('IPC accepts only session IDs and plan IDs, never paths', () => {
    expect(() => assertId('C:\\Users\\me\\.claude\\projects')).toThrow()
    expect(() => assertId('../../etc')).toThrow()
    expect(() => assertIds(['abc', 'C:\\x'])).toThrow()
    expect(() => assertPlanId('C:\\Windows')).toThrow()
    expect(() => assertPlanId('A'.repeat(32))).toThrow()
    expect(assertId('0123456789abcdef0123')).toBe('0123456789abcdef0123')
    expect(assertPlanId('0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef')
  })
})

describe('stale plan detection', () => {
  it('refuses when an unexpected new target appears after the preview', async () => {
    const { h, id, transcript } = await oneSession()
    const plan = await h.deleter.createPlan([id], false)
    const newDir = await fake.writeUuidDir('file-history', U.A)
    const r = await h.deleter.execute([id], 'DELETE', plan.planId, false)
    expect(r).toMatchObject({ ok: false, code: 'STALE_PLAN' })
    expect(r.message).toContain('unexpected new target')
    expect(r.message).toContain(newDir)
    expect(await lstatOrNull(transcript)).not.toBeNull()
  })

  it('refuses when the Claude CLI session ID behind a Desktop session changed', async () => {
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'a', '2026-09-29T01:00:00Z')])
    await fake.writeTranscript(PROJ, U.C, [userLine(U.C, 'c', '2026-09-29T01:00:00Z')])
    const meta = await fake.writeMetadata('d1', { sessionId: 'local_d1', cliSessionId: U.A, title: 'Desktop' })
    const h = createHarness(fake)
    const id = (await h.repo.scan()).sessions.find((s) => s.kind === 'desktop')!.id
    const plan = await h.deleter.createPlan([id], false)
    await writeFile(meta, JSON.stringify({ sessionId: 'local_d1', cliSessionId: U.C, title: 'Desktop' }))
    const r = await h.deleter.execute([id], 'DELETE', plan.planId, false)
    expect(r).toMatchObject({ ok: false, code: 'STALE_PLAN' })
    expect(r.message).toMatch(/CLI session ID changed/)
    expect(await lstatOrNull(meta)).not.toBeNull()
  })
})

describe('the source workspace can never enter a delete plan', () => {
  it('no plan item equals or contains any session workspace', async () => {
    const ws = path.join(fake.root, 'workspace', 'app')
    await mkdir(ws, { recursive: true })
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'a', '2026-09-29T01:00:00Z', { cwd: ws })])
    await fake.writeSessionData(PROJ, U.A)
    await fake.writeUuidDir('file-history', U.A)
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    const plan = await h.deleter.createPlan([s.id], false)
    expect(plan.sessions).toHaveLength(1)
    const lower = (p: string): string => path.resolve(p).toLowerCase()
    for (const item of plan.sessions[0].items) {
      expect(lower(item.path)).not.toBe(lower(ws))
      expect(lower(ws).startsWith(lower(item.path) + path.sep)).toBe(false)
    }
    expect(plan.sessions[0].willNotDelete[0]).toEqual({ path: ws, reason: 'project workspace (source code)', reasonMsg: { key: 'keep.workspace' } })
    expect(plan.reportText).toMatch(/WILL NOT DELETE\s+- .*workspace/)
  })

  it('blocks a session whose workspace IS one of its Claude folders', async () => {
    const dataDir = path.join(fake.projects, PROJ, U.A)
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'weird', '2026-09-29T01:00:00Z')])
    await fake.writeSessionData(PROJ, U.A)
    await fake.writeMetadata('w', { sessionId: 'local_w', cliSessionId: U.A, cwd: dataDir, title: 'Weird' })
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    const plan = await h.deleter.createPlan([s.id], false)
    expect(plan.sessions).toEqual([])
    expect(plan.blocked[0]).toMatchObject({ blockedCode: 'PROTECTED_PATH' })
    expect(plan.blocked[0].blockedReason).toContain(dataDir)
  })

  it('a workspace that contains Claude storage does not block, and roots are never targets', async () => {
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'home ws', '2026-09-29T01:00:00Z', { cwd: fake.home })])
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    const plan = await h.deleter.createPlan([s.id], false)
    expect(plan.sessions).toHaveLength(1)
    const paths = plan.sessions[0].items.map((i) => i.path.toLowerCase())
    for (const root of [fake.home, fake.claudeHome, fake.projects, path.join(fake.projects, PROJ)]) {
      expect(paths).not.toContain(root.toLowerCase())
    }
  })
})

describe('dry run', () => {
  it('runs the full validation pipeline and changes nothing on disk (even while Claude Desktop runs)', async () => {
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'target', '2026-09-29T01:00:00Z')])
    await fake.writeSessionData(PROJ, U.A)
    await fake.writeUuidDir('file-history', U.A)
    await fake.writeMetadata('dd', { sessionId: 'local_dd', cliSessionId: U.A, title: 'Dry', isArchived: true })
    await writeFile(path.join(fake.orgDir, 'archived-sessions.idx'), '{"v":1,"archived":["local_dd"]}')
    const h = createHarness(fake, { dryRun: true })
    h.processes.push({ pid: 9, name: 'claude.exe', executablePath: DESKTOP_EXE })
    const [s] = (await h.repo.scan()).sessions
    const before = await snapshotTree(fake.home)

    const plan = await h.deleter.createPlan([s.id], false)
    expect(plan.dryRun).toBe(true)
    expect(plan.globalBlockedReason).toMatch(/Close Claude Desktop/)
    const r = await h.deleter.execute([s.id], 'DELETE', plan.planId, false)

    expect(r.dryRun).toBe(true)
    expect(r.wouldBeBlocked).toMatch(/Close Claude Desktop/)
    expect(r.sessions[0].items.length).toBe(plan.sessions[0].items.length)
    expect(r.sessions[0].items.every((i) => i.outcome === 'dry-run')).toBe(true)
    expect(r.reportText).toContain(plan.planId)
    expect(await snapshotTree(fake.home)).toEqual(before)
  })

  it('still refuses invalid targets in dry run', async () => {
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'x', '2026-09-29T01:00:00Z')])
    const dataDir = await fake.writeSessionData(PROJ, U.A)
    const h = createHarness(fake, { dryRun: true })
    const [s] = (await h.repo.scan()).sessions
    const plan = await h.deleter.createPlan([s.id], false)
    // Swap the folder for a junction after the preview.
    const outside = path.join(fake.root, 'outside')
    await mkdir(outside)
    await rm(dataDir, { recursive: true })
    await symlink(outside, dataDir, 'junction')
    const r = await h.deleter.execute([s.id], 'DELETE', plan.planId, false)
    expect(r.ok).toBe(false)
    expect(r.sessions).toEqual([])
  })
})

describe('process safety', () => {
  it.each([
    ['busy', 'running'],
    ['idle', 'idle'],
    ['waiting', 'in-use'],
    [undefined, 'in-use']
  ])('registry status %s → %s, and deletion is blocked', async (status, state) => {
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'live', '2026-09-29T01:00:00Z')])
    await fake.writeLive(777, U.A, { status })
    const h = createHarness(fake)
    h.processes.push({ pid: 777, name: 'claude.exe', executablePath: VSCODE_CLAUDE_EXE })
    const [s] = (await h.repo.scan()).sessions
    expect(s.live).toMatchObject({ pid: 777, state })
    const plan = await h.deleter.createPlan([s.id], false)
    expect(plan.sessions).toEqual([])
    expect(plan.blocked[0].blockedCode).toBe('SESSION_IN_USE')
  })

  it('a stale registry entry whose PID was reused by another process does not block', async () => {
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'old', '2026-09-29T01:00:00Z')])
    // procStart recorded 2026-09-01; the process with that PID started much later.
    const procStart = String((BigInt(Date.UTC(2026, 8, 1)) + 11644473600000n) * 10000n)
    await fake.writeLive(888, U.A, { procStart, status: 'idle' })
    const h = createHarness(fake)
    h.processes.push({ pid: 888, name: 'claude.exe', executablePath: VSCODE_CLAUDE_EXE, startMs: Date.UTC(2026, 9, 1) })
    const [s] = (await h.repo.scan()).sessions
    expect(s.live).toBeUndefined()
    const plan = await h.deleter.createPlan([s.id], false)
    expect(plan.sessions).toHaveLength(1)
  })

  it('a transcript written seconds ago is treated as possibly in use', async () => {
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'fresh', '2026-09-29T01:00:00Z')])
    const h = createHarness(fake, { recentWriteMs: 60_000 })
    const [s] = (await h.repo.scan()).sessions
    const plan = await h.deleter.createPlan([s.id], false)
    expect(plan.blocked[0].blockedCode).toBe('RECENTLY_WRITTEN')
  })
})

describe('junction inside a session folder', () => {
  it('real delete removes the link, never the files it points to', async () => {
    const outside = path.join(fake.root, 'precious')
    await mkdir(outside)
    await writeFile(path.join(outside, 'keep.txt'), 'must survive')
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'x', '2026-09-29T01:00:00Z')])
    const dataDir = await fake.writeSessionData(PROJ, U.A)
    await symlink(outside, path.join(dataDir, 'linked'), 'junction')
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    const plan = await h.deleter.createPlan([s.id], false)
    expect(plan.sessions[0].warnings.join(' ')).toMatch(/link/)
    const r = await h.deleter.execute([s.id], 'DELETE', plan.planId, false)
    expect(r.ok).toBe(true)
    expect(await lstatOrNull(dataDir)).toBeNull()
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('must survive')
  })
})
