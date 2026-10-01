import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decodeProjectDirName,
  normalizeWorkspacePath,
  projectKeyFor,
  sanitizeProjectPath,
  workspaceName
} from '../src/main/services/projectResolver'
import { projectsOf } from '../src/shared/sessionQuery'
import { createFakeClaude, createHarness, U, userLine, type FakeClaude } from './helpers/fakeClaude'

let fake: FakeClaude
beforeEach(async () => {
  fake = await createFakeClaude()
})
afterEach(async () => {
  await fake.cleanup()
})

describe('workspace path normalization', () => {
  it('treats drive-letter case, slashes and trailing separators as the same workspace', () => {
    const variants = ['e:\\Phong_Nho_IT\\185', 'E:\\Phong_Nho_IT\\185\\', 'E:/Phong_Nho_IT/185', 'e:\\phong_nho_it\\185']
    const keys = new Set(variants.map(projectKeyFor))
    expect(keys.size).toBe(1)
    expect(normalizeWorkspacePath('e:\\Phong_Nho_IT\\185\\')).toBe('E:\\Phong_Nho_IT\\185')
    expect(normalizeWorkspacePath('e:')).toBe('E:\\')
    expect(workspaceName('E:\\Phong_Nho_IT\\nhahattphcm')).toBe('nhahattphcm')
    expect(projectKeyFor('/home/a/App')).not.toBe(projectKeyFor('/home/a/app')) // POSIX stays case-sensitive
  })

  it('encodes cwd the way Claude Code names its project folders', () => {
    expect(sanitizeProjectPath('E:\\Phong_Nho_IT\\nhahattphcm\\tools')).toBe('E--Phong-Nho-IT-nhahattphcm-tools')
  })
})

describe('decoding an encoded project folder name (storage locator → real path)', () => {
  const tree: Record<string, string[]> = {
    'e:\\': ['Phong_Nho_IT', 'Other'],
    'e:\\phong_nho_it': ['nhahattphcm', '185', 'nhahattphcm-old'],
    'e:\\phong_nho_it\\nhahattphcm': ['tools', 'src'],
    'e:\\phong_nho_it\\nhahattphcm\\tools': []
  }
  const listDirs = async (dir: string): Promise<string[]> => tree[dir.toLowerCase()] ?? []

  it('walks the real folder names and returns the exact path', async () => {
    expect(await decodeProjectDirName('E--Phong-Nho-IT-nhahattphcm-tools', { listDirs })).toBe('E:\\Phong_Nho_IT\\nhahattphcm\\tools')
    expect(await decodeProjectDirName('e--Phong-Nho-IT-185', { listDirs })).toBe('E:\\Phong_Nho_IT\\185')
  })

  it('returns undefined when no existing folder matches', async () => {
    expect(await decodeProjectDirName('E--Phong-Nho-IT-gone-away', { listDirs })).toBeUndefined()
    expect(await decodeProjectDirName('not-encoded', { listDirs })).toBeUndefined()
  })
})

describe('project canonicalization in scans', () => {
  it('folds a same-UUID folder from another project folder into its session (no separate project)', async () => {
    // Real case: session b6b23bdb in e--…-nhahattphcm also wrote E--…-nhahattphcm-tools\b6b23bdb\ after cd tools.
    await fake.writeTranscript('e--Work-app', U.A, [userLine(U.A, 'hello', '2026-09-29T01:00:00Z', { cwd: 'e:\\Work\\app' })])
    await fake.writeSessionData('e--Work-app', U.A)
    const extra = await fake.writeSessionData('E--Work-app-tools', U.A, { 'workflows/scripts/wf.js': '// x' })
    const h = createHarness(fake)
    const snap = await h.repo.scan()
    expect(snap.sessions).toHaveLength(1)
    const s = snap.sessions[0]
    expect(s.status).toBe('transcript-only')
    expect(s.projectName).toBe('app')
    expect(s.projectPath).toBe('E:\\Work\\app')
    expect(s.extraSessionDataDirectories).toEqual([extra])
    expect(projectsOf(snap.sessions).map((p) => p.name)).toEqual(['app'])
    // ...and it is part of the exact delete plan.
    const plan = await h.deleter.createPlan([s.id], false)
    expect(plan.sessions[0].items.map((i) => i.path)).toContain(extra)
  })

  it('merges sessions whose cwd differs only by drive-letter case / trailing separator', async () => {
    await fake.writeTranscript('e--Work-app', U.A, [userLine(U.A, 'one', '2026-09-29T01:00:00Z', { cwd: 'e:\\Work\\app' })])
    await fake.writeTranscript('E--Work-app', U.B, [userLine(U.B, 'two', '2026-09-29T01:00:00Z', { cwd: 'E:\\Work\\app\\' })])
    const h = createHarness(fake)
    const snap = await h.repo.scan()
    expect(new Set(snap.sessions.map((s) => s.projectKey)).size).toBe(1)
    const projects = projectsOf(snap.sessions)
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ name: 'app', count: 2 })
  })

  it('canonicalizes existing workspaces to their real on-disk spelling', async () => {
    const ws = path.join(fake.root, 'Workspaces', 'My_App')
    await mkdir(ws, { recursive: true })
    const lower = ws.toLowerCase()
    await fake.writeTranscript(sanitizeProjectPath(ws), U.A, [userLine(U.A, 'x', '2026-09-29T01:00:00Z', { cwd: lower })])
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    expect(s.projectPath).toBe(normalizeWorkspacePath(ws))
    expect(s.projectName).toBe('My_App')
  })

  it('an orphan folder takes its project from records inside it, not from the encoded name', async () => {
    await fake.writeSessionData('C--Work-other-sub', U.D, {
      'subagents/agent-x.jsonl': JSON.stringify({ type: 'user', cwd: 'C:\\Work\\other\\sub', sessionId: U.D }) + '\n'
    })
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    expect(s.status).toBe('orphan')
    expect(s).toMatchObject({ projectPath: 'C:\\Work\\other\\sub', projectName: 'sub', projectSource: 'folder-records' })
  })

  it('an orphan folder in a known project folder joins that project', async () => {
    await fake.writeTranscript('C--Work-demo', U.A, [userLine(U.A, 'a', '2026-09-29T01:00:00Z', { cwd: 'C:\\Work\\demo' })])
    await fake.writeSessionData('C--Work-demo', U.E, { 'tool-results/x.txt': 'x' })
    const h = createHarness(fake)
    const snap = await h.repo.scan()
    const orphan = snap.sessions.find((s) => s.status === 'orphan')!
    expect(orphan).toMatchObject({ projectName: 'demo', projectSource: 'decoded-folder-name' })
    expect(projectsOf(snap.sessions)).toHaveLength(1)
  })

  it('never shows the encoded folder name as the project when nothing resolves it', async () => {
    await fake.writeSessionData('Z--Nowhere-at-all', U.E, { 'tool-results/x.txt': 'x' })
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    expect(s).toMatchObject({ projectName: 'Unknown project', projectKey: 'unresolved', projectSource: 'unresolved' })
    expect(s.projectDirName).toBe('Z--Nowhere-at-all') // kept only as the storage locator
  })

  it('disambiguates two different workspaces that share a folder name', () => {
    const base = { totalSize: 1 } as const
    const projects = projectsOf([
      { ...base, projectKey: 'path:c:\\a\\tools', projectName: 'tools', projectPath: 'C:\\a\\tools' },
      { ...base, projectKey: 'path:c:\\b\\tools', projectName: 'tools', projectPath: 'C:\\b\\tools' }
    ] as never)
    expect(projects.map((p) => p.label).sort()).toEqual(['tools · a', 'tools · b'])
  })
})

describe('classification', () => {
  it('transcripts without Claude Desktop metadata are transcript-only even when a Desktop root exists', async () => {
    await writeFile(path.join(fake.orgDir, 'scheduled-tasks.json'), '{"scheduledTasks":[]}') // like this machine
    await fake.writeTranscript('C--Work-demo', U.A, [userLine(U.A, 'a', '2026-09-29T01:00:00Z', { entrypoint: 'claude-vscode' })])
    await fake.writeTranscript('C--Work-demo', U.B, [userLine(U.B, 'b', '2026-09-29T01:00:00Z', { entrypoint: 'cli' })])
    const h = createHarness(fake)
    const snap = await h.repo.scan()
    expect(snap.roots.desktopRoots).toHaveLength(1)
    expect(snap.stats.metadataFiles).toBe(0)
    expect(snap.sessions.map((s) => [s.kind, s.status, s.hasMetadata])).toEqual([
      ['cli', 'transcript-only', false],
      ['cli', 'transcript-only', false]
    ])
  })

  it('maps metadata to the transcript with exactly the same CLI session ID only', async () => {
    const near = U.A.slice(0, -1) + '2' // differs in the last character
    await fake.writeTranscript('C--Work-demo', U.A, [userLine(U.A, 'exact', '2026-09-29T01:00:00Z')])
    await fake.writeTranscript('C--Work-demo', near, [userLine(near, 'near', '2026-09-29T01:00:00Z')])
    await fake.writeMetadata('m', { sessionId: 'local_m', cliSessionId: U.A, title: 'Desktop one' })
    const h = createHarness(fake)
    const snap = await h.repo.scan()
    const desktop = snap.sessions.find((s) => s.kind === 'desktop')!
    expect(desktop.transcriptFile).toBe(path.join(fake.projects, 'C--Work-demo', `${U.A}.jsonl`))
    expect(snap.sessions.find((s) => s.cliSessionId === near)?.status).toBe('transcript-only')
  })
})
