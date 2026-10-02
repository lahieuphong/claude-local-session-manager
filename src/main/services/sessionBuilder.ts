import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ClaudeSession, LiveCliSession, LiveState, ProjectSource, SessionStatus } from '../../shared/types'
import { resolveDisplayTitle } from '../../shared/titles'
import { pathKey } from '../util/fsx'
import { refsFor, trackedText as problem } from '../util/messages'
import {
  transcriptIdsOf,
  type DesktopMetadataRecord,
  type DesktopRootScan,
  type DesktopStorageDir
} from './metadataParser'
import { normalizeWorkspacePath, projectKeyFor, sanitizeProjectPath, workspaceName } from './projectResolver'
import type {
  LegacySubagentLog,
  ProjectsScan,
  SessionDataDirEntry,
  TranscriptEntry,
  UuidDirEntry
} from './sessionScanner'

export { sanitizeProjectPath } from './projectResolver'

/**
 * Main-process-only view of a session: the exact files that belong to it.
 * The renderer only ever sees `session` (and refers back to it by `session.id`).
 */
export interface SessionRecord {
  session: ClaudeSession
  metadata?: DesktopMetadataRecord
  storageDir?: DesktopStorageDir
  transcript?: TranscriptEntry
  extraTranscripts: TranscriptEntry[]
  /** Transcripts shown for this session but shared with another metadata file: never deleted. */
  sharedTranscripts: TranscriptEntry[]
  dataDir?: SessionDataDirEntry
  /** Same-UUID session folders in other project folders (written from another cwd). */
  extraDataDirs: SessionDataDirEntry[]
  legacySubagentLogs: LegacySubagentLog[]
  fileHistoryDir?: UuidDirEntry
  sessionEnvDir?: UuidDirEntry
  /** Claude Code session UUIDs owned by this session. */
  ownedUuids: string[]
  /** UUIDs checked against running Claude Code processes. */
  guardUuids: string[]
  /** Key in the manager's own hidden list (sessions without Claude Desktop metadata). */
  managerKey?: string
  /** Workspace paths that must never be touched for this session. */
  workspacePaths: string[]
}

export interface BuildInput {
  desktop: DesktopRootScan[]
  projects: ProjectsScan | null
  fileHistory: Map<string, UuidDirEntry>
  sessionEnv: Map<string, UuidDirEntry>
  /** Manager-only hidden keys. */
  hidden: Set<string>
  liveSessions: LiveCliSession[]
  /** Encoded project folder name (lowercase) → real path, from decoding. */
  decodedProjectDirs?: Map<string, string>
}

export function makeSessionId(kind: string, keyPath: string): string {
  return createHash('sha1').update(`${kind}|${pathKey(keyPath)}`).digest('hex').slice(0, 20)
}

export const SESSION_ID_RE = /^[a-f0-9]{20}$/

export function managerKeyForTranscript(transcriptPath: string): string {
  return 'cli:' + pathKey(transcriptPath)
}

export function managerKeyForFolder(dirPath: string): string {
  return 'orphan:' + pathKey(dirPath)
}

export function liveStateOf(status: string | undefined): LiveState {
  if (status === 'busy') return 'running'
  if (status === 'idle') return 'idle'
  return 'in-use'
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return v.length ? Math.max(...v) : undefined
}

function dataDirKey(projectDir: string, uuid: string): string {
  return pathKey(projectDir) + '|' + uuid.toLowerCase()
}

function newRecord(partial: Partial<SessionRecord> & { problems: string[] }): SessionRecord {
  const { problems, ...rest } = partial
  return {
    session: { problems } as ClaudeSession,
    extraTranscripts: [],
    sharedTranscripts: [],
    extraDataDirs: [],
    legacySubagentLogs: [],
    ownedUuids: [],
    guardUuids: [],
    workspacePaths: [],
    ...rest
  }
}

/**
 * Join metadata, transcripts and session folders into sessions.
 *
 * Mapping rules (no guessing):
 *  - Desktop metadata → transcript by `cliSessionId` (and prior/unarchived
 *    IDs) matched exactly against `<uuid>.jsonl` file names. If several
 *    project folders contain the same UUID, the one matching the sanitized
 *    `cwd` is used; otherwise the link is reported as ambiguous.
 *  - A transcript referenced by more than one metadata file is shown but
 *    excluded from deletion for both.
 *  - Unclaimed `<uuid>.jsonl` → transcript-only session.
 *  - `<uuid>/` session folder → the transcript with the same UUID in the same
 *    project folder; else the single session owning that UUID (Claude Code
 *    writes a session's folder under the project folder of its *current*
 *    cwd, so a `cd` into a sub-folder leaves a same-UUID folder elsewhere);
 *    else an orphan entry.
 *  - file-history / session-env `<uuid>/` → only when exactly one session owns that UUID.
 */
export function buildSessions(input: BuildInput): { sessions: ClaudeSession[]; records: Map<string, SessionRecord> } {
  const transcripts = input.projects?.transcripts ?? []
  const dataDirs = input.projects?.dataDirs ?? []
  const legacyLogs = input.projects?.legacySubagentLogs ?? []

  const byUuid = new Map<string, TranscriptEntry[]>()
  for (const t of transcripts) byUuid.set(t.uuid, [...(byUuid.get(t.uuid) ?? []), t])
  const dataDirByKey = new Map<string, SessionDataDirEntry>()
  const dataDirsByUuid = new Map<string, SessionDataDirEntry[]>()
  for (const d of dataDirs) {
    dataDirByKey.set(dataDirKey(d.projectDir, d.uuid), d)
    dataDirsByUuid.set(d.uuid, [...(dataDirsByUuid.get(d.uuid) ?? []), d])
  }

  const allMeta: Array<{ rec: DesktopMetadataRecord; storageDir?: DesktopStorageDir }> = []
  for (const scan of input.desktop) {
    const dirs = new Map(scan.storageDirs.map((d) => [pathKey(d.dir), d]))
    for (const rec of scan.records) allMeta.push({ rec, storageDir: dirs.get(pathKey(rec.storageDir)) })
  }

  // How many metadata files claim each transcript UUID.
  const claims = new Map<string, number>()
  for (const { rec } of allMeta) {
    for (const id of transcriptIdsOf(rec)) claims.set(id.toLowerCase(), (claims.get(id.toLowerCase()) ?? 0) + 1)
  }

  const used = new Set<TranscriptEntry>()
  const usedDataDirs = new Set<SessionDataDirEntry>()
  const records: SessionRecord[] = []

  // 1. Claude Desktop sessions --------------------------------------------
  for (const { rec, storageDir } of allMeta) {
    const record = newRecord({ metadata: rec, storageDir, problems: rec.parseError ? [rec.parseError] : [] })
    const problems = record.session.problems
    const ids = transcriptIdsOf(rec).map((x) => x.toLowerCase())
    const primaryId = (rec.cliSessionId ?? rec.unarchivedCliSessionId)?.toLowerCase()
    const cwd = rec.originCwd ?? rec.cwd
    for (const id of ids) {
      const candidates = byUuid.get(id) ?? []
      let chosen: TranscriptEntry | undefined
      if (candidates.length === 1) chosen = candidates[0]
      else if (candidates.length > 1 && cwd) {
        const want = sanitizeProjectPath(cwd).toLowerCase()
        const matches = candidates.filter((c) => c.projectDirName.toLowerCase() === want)
        if (matches.length === 1) chosen = matches[0]
      }
      if (candidates.length > 1 && !chosen) {
        problems.push(problem('problem.ambiguousTranscript', { file: `${id}.jsonl`, count: candidates.length }))
      }
      if (!chosen) {
        if (id === primaryId && !rec.remoteKind && candidates.length === 0) {
          problems.push(problem('problem.transcriptNotFound', { file: `${id}.jsonl` }))
        }
        continue
      }
      used.add(chosen)
      if ((claims.get(id) ?? 0) > 1) {
        record.sharedTranscripts.push(chosen)
        problems.push(problem('problem.sharedTranscript', { file: `${id}.jsonl` }))
        if (id === primaryId) record.transcript = chosen
        continue
      }
      record.ownedUuids.push(id)
      if (id === primaryId && !record.transcript) record.transcript = chosen
      else record.extraTranscripts.push(chosen)
    }
    if (!record.transcript && primaryId && claims.get(primaryId) === 1 && !record.ownedUuids.includes(primaryId)) {
      // No transcript, but the UUID is still this session's (file-history etc.).
      record.ownedUuids.push(primaryId)
    }
    record.guardUuids = [...ids]
    records.push(record)
  }

  // 2. Transcript-only (Claude Code CLI / IDE) sessions -------------------
  for (const t of transcripts) {
    if (used.has(t)) continue
    used.add(t)
    const problems: string[] = []
    if ((byUuid.get(t.uuid)?.length ?? 0) > 1) problems.push(problem('problem.duplicateUuid'))
    if (t.parseError) problems.push(t.parseError)
    records.push(
      newRecord({
        transcript: t,
        ownedUuids: [t.uuid],
        guardUuids: [t.uuid],
        managerKey: managerKeyForTranscript(t.filePath),
        problems
      })
    )
  }

  // UUID → the single session that owns it (shared UUIDs map to null).
  const owners = new Map<string, SessionRecord | null>()
  for (const r of records) {
    for (const u of r.ownedUuids) owners.set(u, owners.has(u) ? null : r)
  }

  // 3. Session data folders + legacy subagent logs ------------------------
  for (const r of records) {
    const primary = r.transcript && !r.sharedTranscripts.includes(r.transcript) ? r.transcript : undefined
    if (primary) {
      const d = dataDirByKey.get(dataDirKey(primary.projectDir, primary.uuid))
      if (d && !usedDataDirs.has(d)) {
        r.dataDir = d
        usedDataDirs.add(d)
      }
    }
    for (const t of [r.transcript, ...r.extraTranscripts]) {
      if (!t || r.sharedTranscripts.includes(t)) continue
      for (const log of legacyLogs) {
        if (log.parentSessionId === t.uuid && pathKey(log.projectDir) === pathKey(t.projectDir)) r.legacySubagentLogs.push(log)
      }
    }
  }
  // Same-UUID folders elsewhere belong to the single owner of that UUID.
  for (const d of dataDirs) {
    if (usedDataDirs.has(d)) continue
    const owner = owners.get(d.uuid)
    if (!owner) continue
    if (!owner.dataDir && !owner.transcript) owner.dataDir = d
    else owner.extraDataDirs.push(d)
    usedDataDirs.add(d)
  }

  // 4. Orphan session folders ---------------------------------------------
  for (const d of dataDirs) {
    if (usedDataDirs.has(d)) continue
    const problems = [problem('problem.orphanFolder')]
    if (owners.get(d.uuid) === null) problems.push(problem('problem.ambiguousOwner'))
    records.push(newRecord({ dataDir: d, guardUuids: [d.uuid], managerKey: managerKeyForFolder(d.dirPath), problems }))
  }

  // 5. file-history / session-env: only when exactly one owner ------------
  const attach = (map: Map<string, UuidDirEntry>, assign: (r: SessionRecord, e: UuidDirEntry) => void, label: string): void => {
    for (const [uuid, entry] of map) {
      const owner = owners.get(uuid)
      if (owner) assign(owner, entry)
      else if (owner === null) {
        for (const r of records) {
          if (r.ownedUuids.includes(uuid)) r.session.problems.push(problem('problem.sharedFolder', { label, uuid }))
        }
      }
    }
  }
  attach(input.fileHistory, (r, e) => (r.fileHistoryDir = e), 'file-history')
  attach(input.sessionEnv, (r, e) => (r.sessionEnvDir = e), 'session-env')

  // 6. Normalize -----------------------------------------------------------
  const map = new Map<string, SessionRecord>()
  const sessions: ClaudeSession[] = []
  for (const r of records) {
    r.session = normalize(r, input)
    if (map.has(r.session.id)) continue
    map.set(r.session.id, r)
    sessions.push(r.session)
  }
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return { sessions, records: map }
}

function resolveProject(r: SessionRecord, input: BuildInput): { path?: string; source: ProjectSource } {
  const meta = r.metadata
  if (meta?.originCwd ?? meta?.cwd) return { path: meta.originCwd ?? meta.cwd, source: 'metadata-cwd' }
  if (r.transcript?.summary.cwd) return { path: r.transcript.summary.cwd, source: 'transcript-cwd' }
  if (r.dataDir?.declaredCwd) return { path: r.dataDir.declaredCwd, source: 'folder-records' }
  const dirName = r.transcript?.projectDirName ?? r.dataDir?.projectDirName
  const decoded = dirName ? input.decodedProjectDirs?.get(dirName.toLowerCase()) : undefined
  if (decoded) return { path: decoded, source: 'decoded-folder-name' }
  return { source: 'unresolved' }
}

function normalize(r: SessionRecord, input: BuildInput): ClaudeSession {
  const problems = r.session.problems
  const meta = r.metadata
  const t = r.transcript
  const s = t?.summary
  const kind: ClaudeSession['kind'] = meta ? 'desktop' : t ? 'cli' : 'orphan'
  const keyPath = meta?.filePath ?? t?.filePath ?? r.dataDir!.dirPath
  const id = makeSessionId(kind, keyPath)

  let status: SessionStatus
  if (meta) status = t ? (meta.isArchived ? 'archived' : 'active') : 'metadata-only'
  else if (t) status = 'transcript-only'
  else status = 'orphan'
  if (meta?.remoteKind && !t) problems.push(problem('problem.remote', { kind: meta.remoteKind.toUpperCase() }))

  const customTitle = s?.customTitle ?? r.dataDir?.customTitle
  const title = resolveDisplayTitle({
    metadataTitle: meta?.rawTitle,
    customTitle,
    aiTitle: s?.aiTitle,
    summary: s?.summary,
    firstUserMessage: s?.firstUserMessage,
    lastPrompt: s?.lastPrompt
  })

  const project = resolveProject(r, input)
  const projectPath = project.path ? normalizeWorkspacePath(project.path) : undefined
  const projectDirName = t?.projectDirName ?? r.dataDir?.projectDirName
  const projectStorageDir = t?.projectDir ?? r.dataDir?.projectDir
  if (projectPath) r.workspacePaths = [projectPath]

  const transcriptSize = [t, ...r.extraTranscripts].reduce((n, x) => n + (x?.size ?? 0), 0)
  const otherSize =
    (r.fileHistoryDir?.bytes ?? 0) + (r.sessionEnvDir?.bytes ?? 0) + r.legacySubagentLogs.reduce((n, l) => n + l.size, 0)
  const sessionDataSize = (r.dataDir?.bytes ?? 0) + r.extraDataDirs.reduce((n, d) => n + d.bytes, 0)
  const metadataSize = meta?.size ?? 0
  const hasDataDirs = !!r.dataDir || r.extraDataDirs.length > 0

  const live = input.liveSessions.find((l) => l.alive && r.guardUuids.includes(l.sessionId))

  return {
    id,
    kind,
    status,
    displayTitle: title.title,
    titleSource: title.source,
    rawTitle: meta?.rawTitle,
    customTitle,
    aiTitle: s?.aiTitle,
    summary: s?.summary,
    desktopSessionId: meta?.sessionId,
    cliSessionId: meta ? meta.cliSessionId ?? meta.unarchivedCliSessionId : t?.uuid ?? r.dataDir?.uuid,
    priorCliSessionIds: meta?.priorCliSessionIds ?? [],
    projectPath,
    projectName: projectPath ? workspaceName(projectPath) : 'Unknown project',
    projectKey: projectPath ? projectKeyFor(projectPath) : 'unresolved',
    projectSource: project.source,
    projectDirName,
    projectStorageDir,
    metadataFile: meta?.filePath,
    transcriptFile: t?.filePath,
    extraTranscriptFiles: r.extraTranscripts.map((x) => x.filePath),
    sessionDataDirectory: r.dataDir?.dirPath,
    extraSessionDataDirectories: r.extraDataDirs.map((d) => d.dirPath),
    fileHistoryDirectory: r.fileHistoryDir?.dirPath,
    sessionEnvDirectory: r.sessionEnvDir?.dirPath,
    legacySubagentLogs: r.legacySubagentLogs.map((l) => l.filePath),
    archived: meta?.isArchived === true,
    hiddenInManager: !!r.managerKey && input.hidden.has(r.managerKey),
    createdAt: meta?.createdAt ?? s?.firstTimestamp ?? r.dataDir?.mtimeMs,
    updatedAt: maxDefined(meta?.lastActivityAt, s?.lastTimestamp) ?? t?.mtimeMs ?? meta?.mtimeMs ?? r.dataDir?.mtimeMs,
    transcriptSize: t ? transcriptSize : undefined,
    metadataSize: meta ? metadataSize : undefined,
    sessionDataSize: hasDataDirs ? sessionDataSize : undefined,
    otherSize: otherSize || undefined,
    totalSize: transcriptSize + metadataSize + sessionDataSize + otherSize,
    model: meta?.model ?? s?.model,
    models: s?.models ?? (meta?.model ? [meta.model] : []),
    firstUserMessage: s?.firstUserMessage,
    lastUserMessage: s?.lastUserMessage,
    lastPrompt: s?.lastPrompt,
    userMessageCount: s?.userMessageCount,
    assistantMessageCount: s?.assistantMessageCount,
    toolUseCount: s?.toolUseCount,
    transcriptRecordCount: s?.lineCount,
    gitBranch: s?.gitBranch,
    claudeVersion: s?.version,
    entrypoint: s?.entrypoint,
    hasMetadata: !!meta,
    hasTranscript: !!t,
    remoteKind: meta?.remoteKind,
    live: live
      ? { pid: live.pid, state: liveStateOf(live.status), status: live.status, name: live.name, entrypoint: live.entrypoint }
      : undefined,
    problems,
    problemMsgs: refsFor(problems)
  }
}

/** Every project workspace path known from the sessions (used by delete guards). */
export function knownWorkspacePaths(records: Iterable<SessionRecord>): string[] {
  const out = new Map<string, string>()
  for (const r of records) {
    for (const p of r.workspacePaths) out.set(pathKey(p), p)
    const cwds = [r.metadata?.cwd, r.metadata?.originCwd, r.transcript?.summary.cwd, r.dataDir?.declaredCwd]
    for (const c of cwds) if (c && path.isAbsolute(c)) out.set(pathKey(c), c)
  }
  return [...out.values()]
}
