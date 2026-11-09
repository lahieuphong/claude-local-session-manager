import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import type { CandidatePath, ClaudeSession, ScanIssue, ScanSnapshot, SessionDetails, TitleSource } from '../../../shared/types'
import { UUID_RE, mapLimit, pathKey } from '../../util/fsx'
import { errorMessage, logger } from '../../util/logger'
import { msg } from '../../util/messages'
import type { ManagerHiddenStore } from '../managerHiddenStore'
import { canonicalizeProjects, normalizeWorkspacePath, projectKeyFor, workspaceName } from '../projectResolver'
import { discoverCodexHomes, findCodexCli, type CodexCli, type CodexEnv, type CodexHome } from './codexHomes'
import { lastRecordAt, readCodexHistoryStats, readCodexRolloutItems, readCodexState, readSessionIndexIds, statsFromItems, type CodexItemStats, type CodexThread } from './codexStore'

/**
 * Codex keeps no registry of running sessions: one it added to this recently may still be running.
 * Measured on what a running session writes (conversation items, its file), never on the
 * session row's update time, which `codex archive` and `codex unarchive` also set.
 */
export const CODEX_RECENT_MS = 2 * 60_000
/** A turn Codex marks as in progress counts only this long: crashed turns stay "in progress" for good. */
export const CODEX_TURN_MS = 30 * 60_000

export interface CodexRecord {
  session: ClaudeSession
  home: CodexHome
  threadId: string
  /** Sessions it started (sub-agents), which Codex deletes and archives with it. */
  descendants: string[]
  /** Files of this session and its sub-agents that exist. */
  rolloutFiles: Array<{ path: string; size: number }>
  historyItems: number
  historyBytes: number
  /** Listed in session_index.jsonl. */
  inIndex: boolean
  /** Key in the manager's own hidden list. */
  managerKey: string
}

export interface CodexRepositoryDeps {
  env: CodexEnv
  hidden: ManagerHiddenStore
  now?: () => number
}

export const codexManagerKey = (threadId: string): string => `codex:${threadId.toLowerCase()}`

const firstLine = (text: string | undefined, max = 140): string | undefined => {
  const line = text?.replace(/\s+/g, ' ').trim()
  return line ? (line.length > max ? line.slice(0, max - 1) + '…' : line) : undefined
}

/** `\\?\C:\x` → `C:\x`: Codex records the long-path form of the working folder. */
function cleanCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  return normalizeWorkspacePath(cwd.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, ''))
}

/**
 * A session file's size, and when Codex last wrote to it: its last record's time (the
 * modification time only when no record has one, which errs towards "may be running").
 */
async function fileOf(p: string): Promise<{ size: number; mtimeMs: number; lastAt: number } | null> {
  try {
    const s = await stat(p)
    if (!s.isFile()) return null
    return { size: s.size, mtimeMs: s.mtimeMs, lastAt: (await lastRecordAt(p)) ?? s.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Codex sessions of every Codex sign-in on this PC, in the same shape as Claude
 * sessions, plus the registry `sessionId → Codex thread` that every action uses.
 * Reading only: changes go through the Codex CLI (see codexActions.ts).
 */
export class CodexRepository extends EventEmitter {
  private snapshot: ScanSnapshot | null = null
  private records = new Map<string, CodexRecord>()
  private homes: CodexHome[] = []
  private cli: CodexCli | null = null
  private inflight: Promise<ScanSnapshot> | null = null
  private queued: Promise<ScanSnapshot> | null = null
  /** Counts read from session files (Codex versions without a history database), by size and time. */
  private fileStats = new Map<string, { size: number; mtimeMs: number; stats: CodexItemStats }>()
  /** Rescan when the earliest "may be running" mark runs out, so it does not stay on screen for good. */
  private busyTimer: NodeJS.Timeout | null = null
  private busyCheckAt: number | null = null

  constructor(private deps: CodexRepositoryDeps) {
    super()
  }

  /** When the next "may be running" mark runs out and the sessions are read again (tests). */
  getBusyCheckAt(): number | null {
    return this.busyCheckAt
  }

  dispose(): void {
    if (this.busyTimer) clearTimeout(this.busyTimer)
    this.busyTimer = null
    this.busyCheckAt = null
  }

  private scheduleBusyCheck(at: number, now: number): void {
    this.dispose()
    if (!Number.isFinite(at)) return
    this.busyCheckAt = at
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null
      this.busyCheckAt = null
      this.scan('busy-ended').catch((err) => logger.warn(`Codex rescan failed: ${errorMessage(err)}`))
    }, Math.max(1000, at - now + 1000))
    this.busyTimer.unref?.()
  }

  getSnapshot(): ScanSnapshot | null {
    return this.snapshot
  }
  getRecord(id: string): CodexRecord | undefined {
    return this.records.get(id)
  }
  has(id: string): boolean {
    return this.records.has(id)
  }
  getHomes(): CodexHome[] {
    return this.homes
  }
  getCli(): CodexCli | null {
    return this.cli
  }
  getHiddenStore(): ManagerHiddenStore {
    return this.deps.hidden
  }
  /** Every known project workspace path (never touched by any action). */
  getWorkspacePaths(): string[] {
    return [...new Set([...this.records.values()].map((r) => r.session.projectPath).filter((p): p is string => !!p))]
  }

  /** Same queueing as the Claude repository: a call during a scan gets one follow-up scan. */
  scan(reason = 'manual'): Promise<ScanSnapshot> {
    if (this.inflight) {
      this.queued ??= this.inflight
        .catch(() => undefined)
        .then(() => {
          this.queued = null
          return this.scan(reason)
        })
      return this.queued
    }
    this.emit('scan-state', { scanning: true, reason })
    this.inflight = this.doScan(reason).finally(() => {
      this.inflight = null
      this.emit('scan-state', { scanning: false })
    })
    return this.inflight
  }

  private async doScan(reason: string): Promise<ScanSnapshot> {
    const started = Date.now()
    const now = this.deps.now?.() ?? Date.now()
    const issues: ScanIssue[] = []
    const [{ homes, candidates }, cli] = await Promise.all([discoverCodexHomes(this.deps.env), findCodexCli(this.deps.env)])
    this.homes = homes
    this.cli = cli
    const hidden = this.deps.hidden.keys()
    const sessions: ClaudeSession[] = []
    const records = new Map<string, CodexRecord>()
    let busyEndsAt = Infinity
    const filesSeen = new Set<string>()

    for (const home of homes) {
      if (!home.stateDb) {
        issues.push({ path: home.path, ...msg('codex.noDatabase') })
        continue
      }
      let state: ReturnType<typeof readCodexState>
      try {
        state = readCodexState(home.stateDb)
      } catch (err) {
        issues.push({ path: home.stateDb, message: errorMessage(err) })
        continue
      }
      let stats = new Map<string, CodexItemStats>()
      if (home.historyDb) {
        try {
          stats = readCodexHistoryStats(home.historyDb, state.threads.map((t) => t.id))
        } catch (err) {
          issues.push({ path: home.historyDb, message: errorMessage(err) })
        }
      }
      const index = await readSessionIndexIds(home.indexFile)
      // Sizes of every session's file, sub-agents' included, in one parallel pass (most no longer exist).
      const wanted = new Set<string>()
      for (const t of state.threads) {
        if (t.rolloutPath) wanted.add(t.rolloutPath)
        for (const id of state.descendants.get(t.id) ?? []) {
          const p = state.rolloutPaths.get(id)
          if (p) wanted.add(p)
        }
      }
      const files = new Map<string, { size: number; mtimeMs: number; lastAt: number } | null>()
      await mapLimit([...wanted], 32, async (p) => files.set(p, await fileOf(p)))
      // Codex versions without a history database keep the conversation only in the file:
      // read each once, again only when it changes, a few at a time.
      const fromFiles = new Map<string, CodexItemStats>()
      if (!home.historyDb) {
        await mapLimit(
          state.threads.filter((t) => files.get(t.rolloutPath)),
          8,
          async (t) => {
            const f = files.get(t.rolloutPath) as { size: number; mtimeMs: number }
            filesSeen.add(t.rolloutPath)
            const known = this.fileStats.get(t.rolloutPath)
            if (known && known.size === f.size && known.mtimeMs === f.mtimeMs) {
              fromFiles.set(t.id, known.stats)
              return
            }
            const stats = statsFromItems(await readCodexRolloutItems(t.rolloutPath).catch(() => []), f.size)
            this.fileStats.set(t.rolloutPath, { size: f.size, mtimeMs: f.mtimeMs, stats })
            fromFiles.set(t.id, stats)
          }
        )
      }
      for (const t of state.threads) {
        if (!UUID_RE.test(t.id)) continue
        const descendants = state.descendants.get(t.id) ?? []
        const rolloutFiles: CodexRecord['rolloutFiles'] = []
        // Activity of the session and of the sessions it started: a running sub-agent keeps it busy too.
        let lastActivity = 0
        let turnStartedAt = 0
        for (const id of [t.id, ...descendants]) {
          const p = id === t.id ? t.rolloutPath : state.rolloutPaths.get(id)
          const file = p ? files.get(p) ?? null : null
          if (p && file) {
            rolloutFiles.push({ path: p, size: file.size })
            lastActivity = Math.max(lastActivity, file.lastAt)
          }
          lastActivity = Math.max(lastActivity, stats.get(id)?.lastActivityAt ?? 0)
          turnStartedAt = Math.max(turnStartedAt, stats.get(id)?.turnStartedAt ?? 0)
        }
        const own = rolloutFiles.find((f) => pathKey(f.path) === pathKey(t.rolloutPath))
        const s = stats.get(t.id) ?? fromFiles.get(t.id)
        lastActivity = Math.max(lastActivity, s?.lastActivityAt ?? 0)
        const childBytes = descendants.reduce((n, id) => n + (stats.get(id)?.bytes ?? 0), 0)
        const historyBytes = home.historyDb ? (s?.bytes ?? 0) + childBytes : 0
        const historyItems = home.historyDb ? (s?.items ?? 0) + descendants.reduce((n, id) => n + (stats.get(id)?.items ?? 0), 0) : 0
        const id = createHash('sha1').update(`codex|${pathKey(home.path)}|${t.id.toLowerCase()}`).digest('hex').slice(0, 20)
        const managerKey = codexManagerKey(t.id)
        // With nothing it wrote to go by, the session row's own time is all there is.
        const activeAt = lastActivity || t.updatedAtMs || 0
        const turnRunning = turnStartedAt > 0 && now - turnStartedAt < CODEX_TURN_MS
        const busy = !t.archived && (now - activeAt < CODEX_RECENT_MS || turnRunning)
        if (busy) busyEndsAt = Math.min(busyEndsAt, Math.max(activeAt + CODEX_RECENT_MS, turnRunning ? turnStartedAt + CODEX_TURN_MS : 0))
        const session = toSession({ id, thread: t, home, stats: s, rolloutFiles, own, historyBytes, descendants, hidden: hidden.has(managerKey), busy })
        sessions.push(session)
        records.set(id, { session, home, threadId: t.id, descendants, rolloutFiles, historyItems, historyBytes, inIndex: index.has(t.id.toLowerCase()), managerKey })
      }
    }
    await canonicalizeProjects(sessions)
    this.records = records
    for (const p of this.fileStats.keys()) if (!filesSeen.has(p)) this.fileStats.delete(p)
    this.scheduleBusyCheck(busyEndsAt, now)

    const main = homes.find((h) => h.main) ?? homes[0]
    const allCandidates: CandidatePath[] = [...candidates]
    const snapshot: ScanSnapshot = {
      provider: 'codex',
      sessions,
      scannedAt: Date.now(),
      durationMs: Date.now() - started,
      roots: {
        accounts: homes.map(({ id, label, path, email, plan, apiKey }) => ({ id, label, path, email, plan, apiKey })),
        claudeHome: main?.path ?? '',
        projectsRoot: null,
        fileHistoryRoot: null,
        sessionEnvRoot: null,
        liveSessionsDir: null,
        desktopRoots: [],
        candidates: allCandidates,
        codexCli: cli ? cli.command : null
      },
      stats: {
        transcripts: sessions.filter((s) => s.transcriptFile).length,
        transcriptsParsed: 0,
        transcriptsIncremental: 0,
        transcriptsFromCache: 0,
        subagentLogsExcluded: sessions.reduce((n, s) => n + (s.subagentCount ?? 0), 0),
        legacySubagentLogs: 0,
        sessionDataDirs: 0,
        orphanDirs: 0,
        metadataFiles: 0,
        metadataInvalid: 0,
        tombstones: 0,
        ignoredEntries: 0
      },
      issues
    }
    if (!homes.length) issues.push(msg('codex.noFolder'))
    this.snapshot = snapshot
    logger.info(`Codex scan (${reason}) finished in ${snapshot.durationMs} ms: ${sessions.length} sessions in ${homes.length} folders; CLI: ${cli?.command ?? 'not found'}`)
    this.emit('changed', snapshot)
    return snapshot
  }

  async getDetails(id: string): Promise<SessionDetails | null> {
    const record = this.records.get(id)
    return record ? { session: record.session, tombstones: [] } : null
  }
}

function toSession(a: {
  id: string
  thread: CodexThread
  home: CodexHome
  stats?: CodexItemStats
  rolloutFiles: CodexRecord['rolloutFiles']
  own?: { path: string; size: number }
  historyBytes: number
  descendants: string[]
  hidden: boolean
  /** It may be running: see CODEX_RECENT_MS. */
  busy: boolean
}): ClaudeSession {
  const t = a.thread
  const prompt = firstLine(t.firstUserMessage ?? t.preview)
  const [displayTitle, titleSource]: [string, TitleSource] = t.name
    ? [firstLine(t.name, 200) as string, 'custom-title']
    : t.title
      ? [firstLine(t.title, 200) as string, 'ai-title']
      : prompt
        ? [prompt, 'first-prompt']
        : ['Untitled session', 'untitled']
  const cwd = cleanCwd(t.cwd)
  const rolloutBytes = a.rolloutFiles.reduce((n, f) => n + f.size, 0)

  return {
    id: a.id,
    provider: 'codex',
    kind: 'codex',
    status: t.archived ? 'archived' : 'active',
    displayTitle,
    titleSource,
    customTitle: t.name,
    aiTitle: t.title,
    cliSessionId: t.id,
    priorCliSessionIds: [],
    projectPath: cwd,
    projectName: cwd ? workspaceName(cwd) : 'Unknown project',
    projectKey: cwd ? projectKeyFor(cwd) : 'unresolved',
    projectSource: cwd ? 'transcript-cwd' : 'unresolved',
    transcriptFile: a.own?.path,
    extraTranscriptFiles: a.rolloutFiles.filter((f) => f !== a.own).map((f) => f.path),
    extraSessionDataDirectories: [],
    extraFileHistoryDirectories: [],
    extraSessionEnvDirectories: [],
    legacySubagentLogs: [],
    accountIds: [a.home.id],
    archived: t.archived,
    hiddenInManager: a.hidden,
    createdAt: t.createdAtMs,
    updatedAt: t.updatedAtMs,
    transcriptSize: a.own?.size,
    sessionDataSize: a.historyBytes || undefined,
    otherSize: rolloutBytes - (a.own?.size ?? 0) || undefined,
    totalSize: rolloutBytes + a.historyBytes,
    model: t.model,
    models: t.model ? [t.model] : [],
    firstUserMessage: t.firstUserMessage ?? t.preview,
    lastUserMessage: a.stats?.lastUserMessage,
    userMessageCount: a.stats?.userMessages,
    assistantMessageCount: a.stats?.assistantMessages,
    toolUseCount: a.stats?.toolUses,
    gitBranch: t.gitBranch,
    claudeVersion: t.cliVersion,
    entrypoint: t.source,
    codexSource: t.source,
    subagentCount: a.descendants.length,
    hasMetadata: false,
    hasTranscript: !!a.own || (a.stats?.items ?? 0) > 0,
    live: a.busy ? { pid: 0, state: 'recent' } : undefined,
    problems: []
  }
}
