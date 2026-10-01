import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DiscoveryEnv } from '../../src/main/services/claudeDiscovery'
import { isInsideOrEqual } from '../../src/main/security/pathValidator'
import { ScanCache } from '../../src/main/services/cacheService'
import { ManagerHiddenStore } from '../../src/main/services/managerHiddenStore'
import { ProcessService, type RawProcess } from '../../src/main/services/processService'
import { SessionRepository } from '../../src/main/services/sessionRepository'
import { ArchiveService } from '../../src/main/services/archiveService'
import { DeleteService } from '../../src/main/services/deleteService'
import type { DeleteResult } from '../../src/shared/types'

export const FIXTURES = path.resolve(__dirname, '../../fixtures')

/** Deterministic session UUIDs. A matches the fixture transcript's sessionId. */
export const U = {
  A: '11111111-1111-4111-8111-111111111111',
  B: '22222222-2222-4222-8222-222222222222',
  C: '33333333-3333-4333-8333-333333333333',
  D: '44444444-4444-4444-8444-444444444444',
  E: '55555555-5555-4555-8555-555555555555'
}

export const DESKTOP_EXE = 'C:\\Program Files\\WindowsApps\\Claude_2.16120.0.0_x64__testpkg\\app\\claude.exe'
export const VSCODE_CLAUDE_EXE = 'C:\\Users\\tester\\.vscode\\extensions\\anthropic.claude-code-2.1.285-win32-x64\\resources\\native-binary\\claude.exe'

export interface FakeClaude {
  root: string
  home: string
  claudeHome: string
  projects: string
  fileHistory: string
  sessionEnv: string
  liveDir: string
  desktopRoot: string
  orgDir: string
  env: DiscoveryEnv
  projectDir(name: string): string
  writeTranscript(projectDirName: string, uuid: string, lines: Array<Record<string, unknown>> | string): Promise<string>
  copyTranscriptFixture(projectDirName: string, uuid: string, fixture: string): Promise<string>
  writeSessionData(projectDirName: string, uuid: string, files?: Record<string, string>): Promise<string>
  writeMetadata(localId: string, obj: Record<string, unknown> | string, dir?: string): Promise<string>
  writeUuidDir(kind: 'file-history' | 'session-env', uuid: string): Promise<string>
  writeLive(pid: number, sessionId: string, extra?: Record<string, unknown>): Promise<string>
  cleanup(): Promise<void>
}

function assertNotRealClaude(p: string): void {
  const real = [path.join(os.homedir(), '.claude'), process.env.APPDATA, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Packages')]
  for (const r of real) {
    if (r && isInsideOrEqual(p, r)) throw new Error(`Refusing to run tests inside real Claude storage: ${p}`)
  }
}

export function userLine(uuid: string, text: string, ts: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'user', message: { role: 'user', content: text }, timestamp: ts, sessionId: uuid, cwd: 'C:\\Work\\demo', ...extra }
}

export function assistantLine(uuid: string, id: string, model: string, ts: string): Record<string, unknown> {
  return { type: 'assistant', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: ts, sessionId: uuid }
}

export async function createFakeClaude(): Promise<FakeClaude> {
  const tmp = await realpath(os.tmpdir())
  const root = await realpath(await mkdtemp(path.join(tmp, 'clsm-test-')))
  assertNotRealClaude(root)

  const home = path.join(root, 'home')
  const appData = path.join(home, 'AppData', 'Roaming')
  const localAppData = path.join(home, 'AppData', 'Local')
  const claudeHome = path.join(home, '.claude')
  const projects = path.join(claudeHome, 'projects')
  const fileHistory = path.join(claudeHome, 'file-history')
  const sessionEnv = path.join(claudeHome, 'session-env')
  const liveDir = path.join(claudeHome, 'sessions')
  const desktopRoot = path.join(localAppData, 'Packages', 'Claude_testpkg', 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions')
  const orgDir = path.join(desktopRoot, 'acct-0001', 'org-0002')
  for (const d of [appData, projects, fileHistory, sessionEnv, liveDir, orgDir]) await mkdir(d, { recursive: true })

  const projectDir = (name: string): string => path.join(projects, name)

  return {
    root,
    home,
    claudeHome,
    projects,
    fileHistory,
    sessionEnv,
    liveDir,
    desktopRoot,
    orgDir,
    env: { homedir: home, appData, localAppData, platform: 'win32' },
    projectDir,
    async writeTranscript(projectDirName, uuid, lines) {
      await mkdir(projectDir(projectDirName), { recursive: true })
      const file = path.join(projectDir(projectDirName), `${uuid}.jsonl`)
      const text = typeof lines === 'string' ? lines : lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
      await writeFile(file, text, 'utf8')
      return file
    },
    async copyTranscriptFixture(projectDirName, uuid, fixture) {
      await mkdir(projectDir(projectDirName), { recursive: true })
      const file = path.join(projectDir(projectDirName), `${uuid}.jsonl`)
      const text = (await readFile(path.join(FIXTURES, 'transcripts', fixture), 'utf8')).replaceAll(U.A, uuid)
      await writeFile(file, text, 'utf8')
      return file
    },
    async writeSessionData(projectDirName, uuid, files = { 'tool-results/out.txt': 'tool output', 'subagents/agent-a1.jsonl': '{}' }) {
      const dir = path.join(projectDir(projectDirName), uuid)
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
        await writeFile(path.join(dir, rel), content, 'utf8')
      }
      await mkdir(dir, { recursive: true })
      return dir
    },
    async writeMetadata(localId, obj, dir = orgDir) {
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `local_${localId}.json`)
      await writeFile(file, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')
      return file
    },
    async writeUuidDir(kind, uuid) {
      const dir = path.join(kind === 'file-history' ? fileHistory : sessionEnv, uuid)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'backup@v1'), 'backup content', 'utf8')
      return dir
    },
    async writeLive(pid, sessionId, extra = {}) {
      const file = path.join(liveDir, `${pid}.json`)
      await writeFile(file, JSON.stringify({ pid, sessionId, cwd: 'C:\\Work\\demo', status: 'idle', name: 'demo-1', ...extra }), 'utf8')
      return file
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    }
  }
}

export async function copyFixture(rel: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true })
  await copyFile(path.join(FIXTURES, rel), dest)
}

export interface Harness {
  repo: SessionRepository
  processService: ProcessService
  hidden: ManagerHiddenStore
  cache: ScanCache
  archive: ArchiveService
  deleter: DeleteService
  /** Processes the stubbed process query returns (mutable). */
  processes: RawProcess[]
}

/**
 * Wire the real services against a fake Claude tree with a stubbed process
 * list. Filesystem decoding of folder names is off unless requested, so tests
 * never list directories outside their temp tree.
 */
export function createHarness(
  fake: FakeClaude,
  opts: {
    /** A boolean, or a getter such as () => safety.isDryRun() for the in-app safety switch. */
    dryRun?: boolean | (() => boolean)
    onRealDeleteExecuted?: (result: DeleteResult) => void
    recentWriteMs?: number
    decodeFolderNames?: boolean
    planTtlMs?: number
  } = {}
): Harness {
  const processes: RawProcess[] = []
  const processService = new ProcessService(null, async () => processes, 0)
  const hidden = new ManagerHiddenStore(path.join(fake.root, 'manager-data', 'manager-hidden.json'))
  const cache = new ScanCache(path.join(fake.root, 'manager-data', 'scan-cache.json'))
  const repo = new SessionRepository({
    env: fake.env,
    cache,
    hidden,
    processService,
    decodeFolderNames: opts.decodeFolderNames ?? false
  })
  return {
    repo,
    processService,
    hidden,
    cache,
    processes,
    archive: new ArchiveService(repo, processService, hidden, opts.dryRun ?? false),
    deleter: new DeleteService(repo, processService, {
      dryRun: opts.dryRun ?? false,
      onRealDeleteExecuted: opts.onRealDeleteExecuted,
      recentWriteMs: opts.recentWriteMs ?? 0,
      planTtlMs: opts.planTtlMs
    })
  }
}
