import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScanCache } from '../src/main/services/cacheService'
import { scanProjects } from '../src/main/services/sessionScanner'
import { sanitizeProjectPath } from '../src/main/services/sessionBuilder'
import {
  assistantLine,
  copyFixture,
  createFakeClaude,
  createHarness,
  U,
  userLine,
  VSCODE_CLAUDE_EXE,
  type FakeClaude
} from './helpers/fakeClaude'

let fake: FakeClaude
beforeEach(async () => {
  fake = await createFakeClaude()
})
afterEach(async () => {
  await fake.cleanup()
})

const PROJ = 'C--Work-demo'

describe('scanner and metadata → transcript mapping', () => {
  it('discovers the fake MSIX root and the projects root', async () => {
    const { repo } = createHarness(fake)
    const snap = await repo.scan()
    expect(snap.roots.projectsRoot).toBe(fake.projects)
    expect(snap.roots.desktopRoots.map((d) => d.path)).toEqual([fake.desktopRoot])
    expect(snap.roots.desktopRoots[0].source).toBe('msix')
  })

  it('maps metadata to the transcript named <cliSessionId>.jsonl', async () => {
    await fake.copyTranscriptFixture(PROJ, U.A, 'vietnamese-session.jsonl')
    const dataDir = await fake.writeSessionData(PROJ, U.A)
    await copyFixture('metadata/local_6f1c2a9e-4b7d-4c1e-9a3b-2d8e5f7a1c00.json', path.join(fake.orgDir, 'local_6f1c2a9e-4b7d-4c1e-9a3b-2d8e5f7a1c00.json'))
    const { repo } = createHarness(fake)
    const snap = await repo.scan()
    expect(snap.sessions).toHaveLength(1)
    const s = snap.sessions[0]
    expect(s.kind).toBe('desktop')
    expect(s.status).toBe('active')
    expect(s.hasMetadata && s.hasTranscript).toBe(true)
    expect(s.transcriptFile).toBe(path.join(fake.projects, PROJ, `${U.A}.jsonl`))
    expect(s.sessionDataDirectory).toBe(dataDir)
    expect(s.displayTitle).toBe('Tối ưu pipeline 3D')
    expect(s.titleSource).toBe('metadata')
    expect(s.firstUserMessage).toContain('Nhà hát thành phố')
  })

  it('creates transcript-only and metadata-only sessions', async () => {
    await fake.writeTranscript(PROJ, U.B, [userLine(U.B, 'only a transcript', '2026-09-29T01:00:00Z')])
    await fake.writeMetadata('lonely', { sessionId: 'local_lonely', cliSessionId: U.C, title: '' })
    const { repo } = createHarness(fake)
    const snap = await repo.scan()
    const byStatus = Object.fromEntries(snap.sessions.map((s) => [s.status, s]))
    expect(byStatus['transcript-only'].cliSessionId).toBe(U.B)
    expect(byStatus['transcript-only'].displayTitle).toBe('only a transcript')
    expect(byStatus['metadata-only'].desktopSessionId).toBe('local_lonely')
    expect(byStatus['metadata-only'].displayTitle).toBe('Untitled')
    expect(byStatus['metadata-only'].rawTitle).toEqual({ kind: 'empty', value: '' })
    expect(byStatus['metadata-only'].problems.join(' ')).toMatch(/not found/)
  })

  it('archived metadata produces the archived status', async () => {
    await fake.writeTranscript(PROJ, U.B, [userLine(U.B, 'x', '2026-09-29T01:00:00Z')])
    await fake.writeMetadata('arch', { sessionId: 'local_arch', cliSessionId: U.B, isArchived: true, title: 'Old work' })
    const { repo } = createHarness(fake)
    const [s] = (await repo.scan()).sessions
    expect(s.status).toBe('archived')
    expect(s.archived).toBe(true)
    expect(s.archiveSource).toBe('desktop-metadata')
  })

  it('never treats agent-*.jsonl as a session (legacy root layout and subagents/)', async () => {
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'parent', '2026-09-29T01:00:00Z')])
    await copyFixture('transcripts/subagent.jsonl', path.join(fake.projects, PROJ, 'agent-a07528483165a55fc.jsonl'))
    await fake.writeSessionData(PROJ, U.A, { 'subagents/agent-x1.jsonl': '{}', 'subagents/agent-x1.meta.json': '{}' })
    await mkdir(path.join(fake.projects, PROJ, 'memory'), { recursive: true })
    await writeFile(path.join(fake.projects, PROJ, 'memory', 'MEMORY.md'), '# memory')
    const { repo } = createHarness(fake)
    const snap = await repo.scan()
    expect(snap.sessions).toHaveLength(1)
    expect(snap.sessions[0].cliSessionId).toBe(U.A)
    expect(snap.stats.subagentLogsExcluded).toBe(2)
    // The legacy log declares sessionId = U.A, so it belongs to that session.
    expect(snap.sessions[0].legacySubagentLogs).toEqual([path.join(fake.projects, PROJ, 'agent-a07528483165a55fc.jsonl')])
  })

  it('reports a session folder without transcript as an orphan', async () => {
    await fake.writeSessionData('C--Work-other', U.D)
    const { repo } = createHarness(fake)
    const [s] = (await repo.scan()).sessions
    expect(s.status).toBe('orphan')
    expect(s.kind).toBe('orphan')
    expect(s.sessionDataDirectory).toBe(path.join(fake.projects, 'C--Work-other', U.D))
  })

  it('resolves a UUID present in two project folders by the sanitized cwd, else reports ambiguity', async () => {
    await fake.writeTranscript('C--Work-demo', U.B, [userLine(U.B, 'right one', '2026-09-29T01:00:00Z')])
    await fake.writeTranscript('C--Work-copy', U.B, [userLine(U.B, 'copy', '2026-09-29T01:00:00Z')])
    await fake.writeMetadata('m1', { sessionId: 'local_m1', cliSessionId: U.B, cwd: 'C:\\Work\\demo' })
    expect(sanitizeProjectPath('C:\\Work\\demo')).toBe('C--Work-demo')
    const { repo } = createHarness(fake)
    let snap = await repo.scan()
    const desktop = snap.sessions.find((s) => s.kind === 'desktop')!
    expect(desktop.transcriptFile).toBe(path.join(fake.projects, 'C--Work-demo', `${U.B}.jsonl`))

    await fake.writeMetadata('m1', { sessionId: 'local_m1', cliSessionId: U.B, cwd: 'D:\\Elsewhere' })
    snap = await repo.scan()
    const ambiguous = snap.sessions.find((s) => s.kind === 'desktop')!
    expect(ambiguous.hasTranscript).toBe(false)
    expect(ambiguous.problems.join(' ')).toMatch(/ambiguous/)
  })

  it('attaches file-history and session-env only to the single owning session', async () => {
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'a', '2026-09-29T01:00:00Z')])
    const fh = await fake.writeUuidDir('file-history', U.A)
    const se = await fake.writeUuidDir('session-env', U.A)
    await fake.writeUuidDir('file-history', U.E) // nobody owns this one
    const { repo } = createHarness(fake)
    const [s] = (await repo.scan()).sessions
    expect(s.fileHistoryDirectory).toBe(fh)
    expect(s.sessionEnvDirectory).toBe(se)
    expect(s.totalSize).toBeGreaterThan(s.transcriptSize!)
  })

  it('marks sessions open in a running Claude Code process', async () => {
    await fake.writeTranscript(PROJ, U.A, [userLine(U.A, 'a', '2026-09-29T01:00:00Z')])
    await fake.writeLive(4242, U.A)
    const h = createHarness(fake)
    h.processes.push({ pid: 4242, name: 'claude.exe', executablePath: VSCODE_CLAUDE_EXE })
    const [s] = (await h.repo.scan()).sessions
    expect(s.live?.pid).toBe(4242)
  })

  it('uses the transcript title chain for CLI sessions', async () => {
    await fake.writeTranscript(PROJ, U.A, [
      userLine(U.A, 'first prompt', '2026-09-29T01:00:00Z'),
      assistantLine(U.A, 'm1', 'claude-opus-5-5', '2026-09-29T01:00:01Z'),
      { type: 'ai-title', aiTitle: 'AI named it', sessionId: U.A }
    ])
    const { repo } = createHarness(fake)
    let [s] = (await repo.scan()).sessions
    expect(s.displayTitle).toBe('AI named it')
    expect(s.titleSource).toBe('ai-title')
    await appendFile(path.join(fake.projects, PROJ, `${U.A}.jsonl`), JSON.stringify({ type: 'custom-title', customTitle: 'Renamed' }) + '\n')
    ;[s] = (await repo.scan()).sessions
    expect(s.displayTitle).toBe('Renamed')
  })
})

describe('scan cache', () => {
  it('reuses unchanged transcripts and parses appended data incrementally', async () => {
    const file = await fake.copyTranscriptFixture(PROJ, U.A, 'vietnamese-session.jsonl')
    await fake.copyTranscriptFixture(PROJ, U.B, 'vietnamese-session.jsonl')
    const cache = new ScanCache(null)
    const first = await scanProjects(fake.projects, cache)
    expect(first.stats).toMatchObject({ parsed: 2, fromCache: 0 })

    const second = await scanProjects(fake.projects, cache)
    expect(second.stats).toMatchObject({ parsed: 0, fromCache: 2 })

    await appendFile(file, JSON.stringify(userLine(U.A, 'thêm câu hỏi', '2026-10-01T00:00:00Z')) + '\n')
    const third = await scanProjects(fake.projects, cache)
    expect(third.stats).toMatchObject({ parsed: 0, incremental: 1, fromCache: 1 })
    const t = third.transcripts.find((x) => x.uuid === U.A)!
    expect(t.summary.lastUserMessage).toBe('thêm câu hỏi')
    expect(t.summary.userMessageCount).toBe(4)
  })
})
