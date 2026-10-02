import { createHash } from 'node:crypto'
import path from 'node:path'
import type { CandidatePath, LiveCliSession, ProcessStatus, ScanSnapshot, SessionDetails, StorageRoots } from '../../shared/types'
import type { DesktopMetadataRecord, DesktopRootScan, DesktopStorageDir } from '../services/metadataParser'
import { buildSessions, type SessionRecord } from '../services/sessionBuilder'
import type { SessionDataDirEntry, TranscriptEntry, UuidDirEntry } from '../services/sessionScanner'
import { sanitizeProjectPath } from '../services/projectResolver'
import { emptySummary, type TranscriptSummary } from '../services/transcriptParser'

/**
 * Static demo data for Store screenshot mode (see screenshotMode.ts).
 *
 * Every value is synthetic: a made-up user home (C:\Users\Demo), made-up
 * project folders (C:\Projects\…) and session IDs from one obviously fake
 * series (a1b2c3d4-0000-4000-8000-0000000000NN). Nothing here is read from
 * disk; the sessions are built by the app's real session builder from these
 * values, so the UI shows exactly what a scan of such files would show.
 * Deterministic for a given `now`.
 */

const win = path.win32
const KB = 1024
const MB = 1024 * KB
const MIN = 60_000

export const DEMO_HOME = 'C:\\Users\\Demo'
const CLAUDE_HOME = win.join(DEMO_HOME, '.claude')
const PROJECTS_ROOT = win.join(CLAUDE_HOME, 'projects')
const FILE_HISTORY_ROOT = win.join(CLAUDE_HOME, 'file-history')
const SESSION_ENV_ROOT = win.join(CLAUDE_HOME, 'session-env')
const LIVE_SESSIONS_DIR = win.join(CLAUDE_HOME, 'sessions')
const APPDATA = win.join(DEMO_HOME, 'AppData', 'Roaming')
const DESKTOP_ROOT = win.join(APPDATA, 'Claude', 'claude-code-sessions')
const ACCOUNT_ID = 'a1b2c3d4-0000-4000-a000-000000000001'
const ORG_ID = 'a1b2c3d4-0000-4000-b000-000000000001'
const DESKTOP_DIR = win.join(DESKTOP_ROOT, ACCOUNT_ID, ORG_ID)
export const DEMO_USER_DATA = win.join(APPDATA, 'Claude Local Session Manager')

/** Synthetic Claude Code session UUID number `n`. */
export const demoUuid = (n: number): string => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`
/** Synthetic Claude Desktop session ID number `n`. */
export const demoDesktopId = (n: number): string => `local_a1b2c3d4-0000-4000-9000-${String(n).padStart(12, '0')}`
/** Every ID in the fixture belongs to this series. */
export const DEMO_ID_RE = /a1b2c3d4-0000-4000-[89ab]000-\d{12}/

export const DEMO_PROJECTS = {
  web: 'C:\\Projects\\DemoWebApp',
  api: 'C:\\Projects\\SampleAPI',
  design: 'C:\\Projects\\DesignSystem'
} as const

interface DemoSession {
  n: number
  title: string
  project: keyof typeof DEMO_PROJECTS
  /** Claude Desktop session (has metadata) or a Claude Code CLI / IDE session. */
  desktop?: boolean
  /** Minutes since the last activity. */
  ageMin: number
  durationMin: number
  model: string
  prompts: [string, string?]
  stats: { user: number; assistant: number; tools: number; records: number }
  sizes: { transcript?: number; data?: number; dataFiles?: number; history?: number; env?: number }
  branch?: string
  entrypoint?: string
  archived?: boolean
  /** Status reported by a running Claude Code process for this session. */
  live?: { pid: number; status: string }
}

const SESSIONS: DemoSession[] = [
  {
    n: 1,
    title: 'Refactor authentication flow',
    project: 'web',
    ageMin: 3,
    durationMin: 70,
    model: 'claude-opus-5-5',
    prompts: ['Refactor the login flow to use the new auth service and keep existing sessions valid.', 'Run the auth tests again and summarize what changed.'],
    stats: { user: 14, assistant: 96, tools: 61, records: 248 },
    sizes: { transcript: 2.8 * MB, data: 6.4 * MB, dataFiles: 38, history: 1.1 * MB },
    branch: 'feature/auth-refactor',
    entrypoint: 'cli',
    live: { pid: 4812, status: 'busy' }
  },
  {
    n: 2,
    title: 'Review API performance',
    project: 'api',
    ageMin: 41,
    durationMin: 95,
    model: 'claude-opus-5-5',
    prompts: ['Profile the /orders endpoint and find why p95 latency doubled after the last release.', 'Add an index for the orders query and compare the timings.'],
    stats: { user: 9, assistant: 58, tools: 37, records: 151 },
    sizes: { transcript: 1.2 * MB, data: 2.2 * MB, dataFiles: 17 },
    branch: 'perf/orders-endpoint',
    entrypoint: 'claude-vscode',
    live: { pid: 5220, status: 'idle' }
  },
  {
    n: 3,
    title: 'Update dashboard layout',
    project: 'web',
    ageMin: 135,
    durationMin: 52,
    model: 'claude-opus-5-5',
    prompts: ['Update the dashboard layout so the summary cards wrap on narrow windows.', 'Check the layout at 1280 px wide and update the snapshot tests.'],
    stats: { user: 11, assistant: 72, tools: 44, records: 187 },
    sizes: { transcript: 860 * KB, data: 3.4 * MB, dataFiles: 24, history: 512 * KB, env: 4 * KB },
    branch: 'feature/dashboard-layout',
    entrypoint: 'claude-vscode'
  },
  {
    n: 4,
    title: 'Fix build pipeline',
    project: 'design',
    ageMin: 290,
    durationMin: 34,
    model: 'claude-sonnet-5-5',
    prompts: ['The CI build fails on the lint step. Find the cause and fix the pipeline.', 'Retry the pipeline with the new cache key.'],
    stats: { user: 6, assistant: 31, tools: 22, records: 84 },
    sizes: { transcript: 420 * KB, data: 1.1 * MB, dataFiles: 9 },
    branch: 'fix/ci-lint',
    entrypoint: 'cli',
    live: { pid: 6304, status: 'waiting' }
  },
  {
    n: 5,
    title: 'Database migration review',
    project: 'api',
    desktop: true,
    ageMin: 26 * 60 + 10,
    durationMin: 48,
    model: 'claude-opus-5-5',
    prompts: ['Review the migration that splits the customers table before we run it in staging.', 'List the rollback steps for this migration.'],
    stats: { user: 8, assistant: 41, tools: 19, records: 109 },
    sizes: { transcript: 640 * KB, data: 900 * KB, dataFiles: 6 },
    branch: 'main',
    entrypoint: 'claude-desktop',
    archived: true
  },
  {
    n: 6,
    title: 'Add dark mode color tokens',
    project: 'design',
    desktop: true,
    ageMin: 30 * 60 + 25,
    durationMin: 66,
    model: 'claude-sonnet-5-5',
    prompts: ['Add dark mode color tokens and map them to the existing components.', 'Update the token documentation page.'],
    stats: { user: 12, assistant: 63, tools: 40, records: 166 },
    sizes: { transcript: 1.5 * MB, data: 2.9 * MB, dataFiles: 21, history: 760 * KB },
    branch: 'feature/dark-mode',
    entrypoint: 'claude-desktop'
  },
  {
    n: 7,
    title: 'Write checkout integration tests',
    project: 'web',
    desktop: true,
    ageMin: 3 * 24 * 60 + 200,
    durationMin: 110,
    model: 'claude-opus-5-5',
    prompts: ['Write integration tests for the checkout flow, including failed payments.', 'Make the payment provider mock deterministic.'],
    stats: { user: 17, assistant: 118, tools: 83, records: 302 },
    sizes: { transcript: 3.6 * MB, data: 8.2 * MB, dataFiles: 46, history: 1.4 * MB },
    branch: 'test/checkout',
    entrypoint: 'claude-desktop'
  },
  {
    n: 8,
    title: 'Document REST endpoints',
    project: 'api',
    ageMin: 4 * 24 * 60 + 90,
    durationMin: 28,
    model: 'claude-haiku-4-5',
    prompts: ['Document the REST endpoints in the README with request and response examples.'],
    stats: { user: 4, assistant: 19, tools: 11, records: 52 },
    sizes: { transcript: 310 * KB },
    branch: 'docs/api',
    entrypoint: 'cli'
  },
  {
    n: 9,
    title: 'Audit color contrast',
    project: 'design',
    desktop: true,
    ageMin: 6 * 24 * 60 + 40,
    durationMin: 39,
    model: 'claude-sonnet-5-5',
    prompts: ['Audit color contrast in the design system and list components below 4.5:1.'],
    stats: { user: 5, assistant: 27, tools: 16, records: 71 },
    sizes: { transcript: 540 * KB, data: 700 * KB, dataFiles: 5 },
    branch: 'main',
    entrypoint: 'claude-desktop',
    archived: true
  },
  {
    n: 10,
    title: 'Set up CI build caching',
    project: 'web',
    ageMin: 12 * 24 * 60 + 300,
    durationMin: 44,
    model: 'claude-opus-5-5',
    prompts: ['Set up build caching in CI so dependency installs are reused between runs.', 'Measure the pipeline time before and after.'],
    stats: { user: 7, assistant: 35, tools: 24, records: 96 },
    sizes: { transcript: 720 * KB, data: 1.6 * MB, dataFiles: 12 },
    branch: 'ci/cache',
    entrypoint: 'cli'
  },
  {
    n: 11,
    title: 'Add rate limiting middleware',
    project: 'api',
    desktop: true,
    ageMin: 19 * 24 * 60 + 120,
    durationMin: 81,
    model: 'claude-opus-5-5',
    prompts: ['Add a rate limiting middleware with per-key limits and tests.', 'Return a Retry-After header when the limit is reached.'],
    stats: { user: 10, assistant: 54, tools: 33, records: 139 },
    sizes: { transcript: 1.3 * MB, data: 2.4 * MB, dataFiles: 15, history: 300 * KB },
    branch: 'feature/rate-limit',
    entrypoint: 'claude-desktop'
  },
  {
    n: 12,
    title: 'Upgrade component library',
    project: 'design',
    desktop: true,
    ageMin: 27 * 24 * 60 + 60,
    durationMin: 25,
    model: 'claude-sonnet-5-5',
    // The transcript was removed outside the app: a metadata-only session.
    prompts: ['Upgrade the component library to the next major version.'],
    stats: { user: 0, assistant: 0, tools: 0, records: 0 },
    sizes: {},
    entrypoint: 'claude-desktop'
  }
]

const round = (n: number): number => Math.round(n)

function summaryFor(s: DemoSession, first: number, last: number): TranscriptSummary {
  return {
    ...emptySummary(),
    sessionIds: [demoUuid(s.n)],
    firstUserMessage: s.prompts[0],
    lastUserMessage: s.prompts[1] ?? s.prompts[0],
    lastPrompt: s.prompts[1] ?? s.prompts[0],
    aiTitle: s.title,
    firstTimestamp: first,
    lastTimestamp: last,
    model: s.model,
    models: [s.model],
    userMessageCount: s.stats.user,
    assistantMessageCount: s.stats.assistant,
    toolUseCount: s.stats.tools,
    lineCount: s.stats.records,
    cwd: DEMO_PROJECTS[s.project],
    gitBranch: s.branch,
    version: '2.4.1',
    entrypoint: s.entrypoint
  }
}

function metadataJson(s: DemoSession, first: number, last: number): Record<string, unknown> {
  const cwd = DEMO_PROJECTS[s.project]
  return {
    sessionId: demoDesktopId(s.n),
    cliSessionId: demoUuid(s.n),
    cwd,
    originCwd: cwd,
    createdAt: first,
    lastActivityAt: last,
    model: s.model,
    isArchived: s.archived === true,
    title: s.title,
    permissionMode: 'default'
  }
}

export interface ScreenshotFixture {
  now: number
  snapshot: ScanSnapshot
  records: Map<string, SessionRecord>
  /** Raw metadata JSON per Desktop metadata file path (what the inspector's raw view shows). */
  rawMetadata: Map<string, string>
  processStatus: ProcessStatus
}

/** The demo data set. Pure: no file system, network or process access. */
export function buildScreenshotFixture(now: number): ScreenshotFixture {
  const transcripts: TranscriptEntry[] = []
  const dataDirs: SessionDataDirEntry[] = []
  const fileHistory = new Map<string, UuidDirEntry>()
  const sessionEnv = new Map<string, UuidDirEntry>()
  const records: DesktopMetadataRecord[] = []
  const rawMetadata = new Map<string, string>()
  const liveSessions: LiveCliSession[] = []

  for (const s of SESSIONS) {
    const uuid = demoUuid(s.n)
    const cwd = DEMO_PROJECTS[s.project]
    const projectDirName = sanitizeProjectPath(cwd)
    const projectDir = win.join(PROJECTS_ROOT, projectDirName)
    const last = now - s.ageMin * MIN
    const first = last - s.durationMin * MIN

    if (s.sizes.transcript) {
      transcripts.push({
        uuid,
        filePath: win.join(projectDir, `${uuid}.jsonl`),
        projectDir,
        projectDirName,
        size: round(s.sizes.transcript),
        mtimeMs: last,
        summary: summaryFor(s, first, last)
      })
    }
    if (s.sizes.data) {
      dataDirs.push({
        uuid,
        dirPath: win.join(projectDir, uuid),
        projectDir,
        projectDirName,
        bytes: round(s.sizes.data),
        files: s.sizes.dataFiles ?? 1,
        dirs: 2,
        links: 0,
        mtimeMs: last,
        subagentLogs: 0
      })
    }
    if (s.sizes.history) {
      fileHistory.set(uuid, { uuid, dirPath: win.join(FILE_HISTORY_ROOT, uuid), bytes: round(s.sizes.history), files: 12, dirs: 0, links: 0 })
    }
    if (s.sizes.env) {
      sessionEnv.set(uuid, { uuid, dirPath: win.join(SESSION_ENV_ROOT, uuid), bytes: round(s.sizes.env), files: 1, dirs: 0, links: 0 })
    }
    if (s.desktop) {
      const json = metadataJson(s, first, last)
      const text = JSON.stringify(json, null, 2)
      const stem = demoDesktopId(s.n)
      const filePath = win.join(DESKTOP_DIR, `${stem}.json`)
      rawMetadata.set(filePath, text)
      records.push({
        filePath,
        fileName: `${stem}.json`,
        stem,
        storageDir: DESKTOP_DIR,
        accountId: ACCOUNT_ID,
        orgId: ORG_ID,
        rootPath: DESKTOP_ROOT,
        size: Buffer.byteLength(text),
        mtimeMs: last,
        sessionId: stem,
        rawTitle: { kind: 'string', value: s.title },
        cliSessionId: uuid,
        priorCliSessionIds: [],
        cwd,
        originCwd: cwd,
        createdAt: first,
        lastActivityAt: last,
        model: s.model,
        permissionMode: 'default',
        isArchived: s.archived === true
      })
    }
    if (s.live) {
      liveSessions.push({ pid: s.live.pid, sessionId: uuid, cwd, status: s.live.status, entrypoint: s.entrypoint, alive: true })
    }
  }

  const archivedIds = SESSIONS.filter((s) => s.desktop && s.archived).map((s) => demoDesktopId(s.n))
  const storageDir: DesktopStorageDir = {
    dir: DESKTOP_DIR,
    accountId: ACCOUNT_ID,
    orgId: ORG_ID,
    tombstones: [],
    archiveIndex: { path: win.join(DESKTOP_DIR, 'archived-sessions.idx'), ids: archivedIds }
  }
  const desktop: DesktopRootScan = { root: DESKTOP_ROOT, records, storageDirs: [storageDir], issues: [] }

  const built = buildSessions({
    desktop: [desktop],
    projects: { transcripts, dataDirs, legacySubagentLogs: [], stats: { parsed: transcripts.length, incremental: 0, fromCache: 0, subagentLogsExcluded: 0, ignoredEntries: 0 }, issues: [] },
    fileHistory,
    sessionEnv,
    hidden: new Set(),
    liveSessions
  })

  const candidates: CandidatePath[] = [
    { path: CLAUDE_HOME, exists: true, note: 'Claude Code home' },
    { path: PROJECTS_ROOT, exists: true, note: 'Claude Code transcripts' },
    { path: FILE_HISTORY_ROOT, exists: true, note: 'Claude Code file history' },
    { path: SESSION_ENV_ROOT, exists: true, note: 'Claude Code session env' },
    { path: LIVE_SESSIONS_DIR, exists: true, note: 'Running Claude Code sessions' },
    { path: DESKTOP_ROOT, exists: true, note: 'Claude Desktop (Claude, APPDATA)' },
    { path: win.join(APPDATA, 'Claude-3p', 'claude-code-sessions'), exists: false, note: 'Claude Desktop (Claude-3p, APPDATA)' }
  ]
  const roots: StorageRoots = {
    claudeHome: CLAUDE_HOME,
    projectsRoot: PROJECTS_ROOT,
    fileHistoryRoot: FILE_HISTORY_ROOT,
    sessionEnvRoot: SESSION_ENV_ROOT,
    liveSessionsDir: LIVE_SESSIONS_DIR,
    desktopRoots: [{ path: DESKTOP_ROOT, source: 'appdata', variant: 'Claude', sessionFiles: records.length, tombstones: 0, archiveIndexes: 1 }],
    candidates
  }

  const snapshot: ScanSnapshot = {
    sessions: built.sessions,
    scannedAt: now,
    durationMs: 184,
    roots,
    stats: {
      transcripts: transcripts.length,
      transcriptsParsed: transcripts.length,
      transcriptsIncremental: 0,
      transcriptsFromCache: 0,
      subagentLogsExcluded: 0,
      legacySubagentLogs: 0,
      sessionDataDirs: dataDirs.length,
      orphanDirs: 0,
      metadataFiles: records.length,
      metadataInvalid: 0,
      tombstones: 0,
      ignoredEntries: 0
    },
    issues: []
  }

  const processStatus: ProcessStatus = {
    checkedAt: now,
    supported: true,
    desktopRunning: false,
    desktopProcesses: [],
    claudeCodeProcesses: liveSessions.map((l) => ({ pid: l.pid, name: 'claude.exe', kind: 'claude-code' as const })),
    unknownProcesses: [],
    liveSessions
  }

  return { now, snapshot, records: built.records, rawMetadata, processStatus }
}

/** What the inspector loads for one session (raw metadata comes from the fixture, not a file). */
export function screenshotDetails(fixture: ScreenshotFixture, id: string): SessionDetails | null {
  const record = fixture.records.get(id)
  if (!record) return null
  const meta = record.metadata
  return { session: record.session, rawMetadata: meta ? fixture.rawMetadata.get(meta.filePath) : undefined, tombstones: [] }
}

/** Stable synthetic hex IDs for plans (no randomness, so screenshots are reproducible). */
export function demoHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex')
}
