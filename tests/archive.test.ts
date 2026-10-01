import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeClaude, createHarness, DESKTOP_EXE, U, userLine, type FakeClaude } from './helpers/fakeClaude'

let fake: FakeClaude
beforeEach(async () => {
  fake = await createFakeClaude()
})
afterEach(async () => {
  await fake.cleanup()
})

const PROJ = 'C--Work-demo'

async function setup(extra: Record<string, unknown> = {}): Promise<{ metaFile: string; transcript: string }> {
  const transcript = await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'hello', '2026-09-29T01:00:00Z')])
  const metaFile = await fake.writeMetadata('s1', {
    sessionId: 'local_s1',
    cliSessionId: U.A,
    cwd: 'C:\\Work\\demo',
    title: 'Work',
    isArchived: false,
    unknownFutureField: { keep: ['me', 1] },
    ...extra
  })
  return { metaFile, transcript }
}

describe('archive / restore of Claude Desktop sessions', () => {
  it('archive sets isArchived=true, keeps every other field and leaves the transcript alone', async () => {
    const { metaFile, transcript } = await setup()
    const before = JSON.parse(await readFile(metaFile, 'utf8'))
    const transcriptBefore = await readFile(transcript, 'utf8')
    const transcriptMtime = (await stat(transcript)).mtimeMs
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions

    const r = await h.archive.setArchived(s.id, true)
    expect(r.ok).toBe(true)
    const after = JSON.parse(await readFile(metaFile, 'utf8'))
    expect(after).toEqual({ ...before, isArchived: true })
    expect(Object.keys(after)).toEqual(Object.keys(before))
    expect(await readFile(transcript, 'utf8')).toBe(transcriptBefore)
    expect((await stat(transcript)).mtimeMs).toBe(transcriptMtime)
    // No temp files left behind.
    expect((await readdir(fake.orgDir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
    // The repository was rescanned.
    expect(h.repo.getSnapshot()!.sessions[0].status).toBe('archived')
  })

  it('restore reverses archive', async () => {
    const { metaFile } = await setup({ isArchived: true })
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    expect(s.archived).toBe(true)
    const r = await h.archive.setArchived(s.id, false)
    expect(r.ok).toBe(true)
    expect(JSON.parse(await readFile(metaFile, 'utf8')).isArchived).toBe(false)
    expect(h.repo.getSnapshot()!.sessions[0].status).toBe('active')
  })

  it('keeps archived-sessions.idx in sync when it exists', async () => {
    await setup()
    const idx = path.join(fake.orgDir, 'archived-sessions.idx')
    await writeFile(idx, '{"v":1,"archived":["local_zzz"]}')
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    await h.archive.setArchived(s.id, true)
    expect(await readFile(idx, 'utf8')).toBe('{"v":1,"archived":["local_s1","local_zzz"]}')
    await h.archive.setArchived(s.id, false)
    expect(await readFile(idx, 'utf8')).toBe('{"v":1,"archived":["local_zzz"]}')
  })

  it('does not create an archive index that did not exist', async () => {
    await setup()
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    await h.archive.setArchived(s.id, true)
    expect(await readdir(fake.orgDir)).not.toContain('archived-sessions.idx')
  })

  it('refuses to rewrite malformed metadata', async () => {
    await setup()
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    const metaFile = path.join(fake.orgDir, 'local_s1.json')
    await writeFile(metaFile, '{"sessionId":"local_s1", "isArch')
    const r = await h.archive.setArchived(s.id, true)
    expect(r.ok).toBe(false)
    expect(await readFile(metaFile, 'utf8')).toBe('{"sessionId":"local_s1", "isArch')
  })

  it('is blocked while Claude Desktop is running', async () => {
    const { metaFile } = await setup()
    const h = createHarness(fake)
    h.processes.push({ pid: 10, name: 'claude.exe', executablePath: DESKTOP_EXE })
    const [s] = (await h.repo.scan()).sessions
    const before = await readFile(metaFile, 'utf8')
    const r = await h.archive.setArchived(s.id, true)
    expect(r).toMatchObject({ ok: false, code: 'CLAUDE_RUNNING', message: 'Close Claude Desktop before modifying session files.' })
    expect(await readFile(metaFile, 'utf8')).toBe(before)
  })

  it('dry run changes nothing', async () => {
    const { metaFile } = await setup()
    const h = createHarness(fake, { dryRun: true })
    const [s] = (await h.repo.scan()).sessions
    const before = await readFile(metaFile, 'utf8')
    const r = await h.archive.setArchived(s.id, true)
    expect(r).toMatchObject({ ok: true, dryRun: true })
    expect(await readFile(metaFile, 'utf8')).toBe(before)
  })
})

describe('app-local archive for Claude Code CLI sessions', () => {
  it('archives without touching any Claude file, even while Claude Desktop runs', async () => {
    const transcript = await fake.writeTranscript(PROJ, U.B, [userLine(U.B, 'cli', '2026-09-29T01:00:00Z')])
    const before = await readFile(transcript, 'utf8')
    const h = createHarness(fake)
    h.processes.push({ pid: 10, name: 'claude.exe', executablePath: DESKTOP_EXE })
    const [s] = (await h.repo.scan()).sessions
    const r = await h.archive.setArchived(s.id, true)
    expect(r.ok).toBe(true)
    const after = h.repo.getSnapshot()!.sessions[0]
    expect(after).toMatchObject({ archived: true, archiveSource: 'app-local', status: 'transcript-only' })
    expect(await readFile(transcript, 'utf8')).toBe(before)
    await h.archive.setArchived(s.id, false)
    expect(h.repo.getSnapshot()!.sessions[0].archived).toBe(false)
  })
})
