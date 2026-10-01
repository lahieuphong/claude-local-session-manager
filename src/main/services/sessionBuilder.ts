import { createHash } from 'node:crypto'
import type { ClaudeSession, LiveCliSession, SessionStatus } from '../../shared/types'
import { resolveDisplayTitle } from '../../shared/titles'
import { pathKey } from '../util/fsx'
import {
  transcriptIdsOf,
  type DesktopMetadataRecord,
  type DesktopRootScan,
  type DesktopStorageDir
} from './metadataParser'
import type {
  LegacySubagentLog,
  ProjectsScan,
  SessionDataDirEntry,
  TranscriptEntry,
  UuidDirEntry
} from './sessionScanner'

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
  legacySubagentLogs: LegacySubagentLog[]
  fileHistoryDir?: UuidDirEntry
  sessionEnvDir?: UuidDirEntry
  /** Claude Code session UUIDs owned by this session. */
  ownedUuids: string[]
  /** UUIDs checked against running Claude Code processes. */
  guardUuids: string[]
  /** Key in the app-local archive store (CLI sessions only). */
  appArchiveKey?: string
}

export interface BuildInput {
  desktop: DesktopRootScan[]
  projects: ProjectsScan | null
  fileHistory: Map<string, UuidDirEntry>
  sessionEnv: Map<string, UuidDirEntry>
  appArchived: Set<string>
  liveSessions: LiveCliSession[]
}

export function makeSessionId(kind: string, keyPath: string): string {
  return createHash('sha1').update(`${kind}|${pathKey(keyPath)}`).digest('hex').slice(0, 20)
}

export const SESSION_ID_RE = /^[a-f0-9]{20}$/

/** Claude Code names project folders by replacing non-alphanumerics with "-". */
export function sanitizeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function projectKeyOf(projectPath: string | undefined, projectDirName: string | undefined): string {
  if (projectPath) return 'path:' + projectPath.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return 'dir:' + (projectDirName ?? 'unknown').toLowerCase()
}

export function appArchiveKeyFor(transcriptPath: string): string {
  return 'cli:' + pathKey(transcriptPath)
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return v.length ? Math.max(...v) : undefined
}

function dataDirKey(projectDir: string, uuid: string): string {
  return pathKey(projectDir) + '|' + uuid.toLowerCase()
}

/**
 * Join metadata, transcripts and session folders into sessions.
 *
 * Mapping rules (no guessing):
 *  - Desktop metadata → transcript by `cliSessionId` (and prior/unarchived
 *    IDs) matched against `<uuid>.jsonl` file names. If several project
 *    folders contain the same UUID, the one matching the sanitized `cwd` is
 *    used; otherwise the link is reported as ambiguous and not made.
 *  - A transcript referenced by more than one metadata file is shown but
 *    excluded from deletion for both.
 *  - Unclaimed `<uuid>.jsonl` → transcript-only session.
 *  - `<uuid>/` session folder → same project folder + same UUID as a
 *    transcript; otherwise an orphan entry.
 *  - file-history / session-env `<uuid>/` → attached only when exactly one
 *    session owns that UUID.
 */
export function buildSessions(input: BuildInput): { sessions: ClaudeSession[]; records: Map<string, SessionRecord> } {
  const transcripts = input.projects?.transcripts ?? []
  const dataDirs = input.projects?.dataDirs ?? []
  const legacyLogs = input.projects?.legacySubagentLogs ?? []

  const byUuid = new Map<string, TranscriptEntry[]>()
  for (const t of transcripts) {
    const list = byUuid.get(t.uuid) ?? []
    list.push(t)
    byUuid.set(t.uuid, list)
  }
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
    const problems: string[] = []
    if (rec.parseError) problems.push(rec.parseError)
    const record: SessionRecord = {
      session: undefined as unknown as ClaudeSession,
      metadata: rec,
      storageDir,
      extraTranscripts: [],
      sharedTranscripts: [],
      legacySubagentLogs: [],
      ownedUuids: [],
      guardUuids: []
    }
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
        problems.push(`Transcript ${id}.jsonl exists in ${candidates.length} project folders; not linked (ambiguous).`)
      }
      if (!chosen) {
        if (id === primaryId && !rec.remoteKind && candidates.length === 0) {
          problems.push(`Transcript ${id}.jsonl not found under ~/.claude/projects.`)
        }
        continue
      }
      used.add(chosen)
      if ((claims.get(id) ?? 0) > 1) {
        record.sharedTranscripts.push(chosen)
        problems.push(`Transcript ${id}.jsonl is referenced by several metadata files; it is excluded from deletion.`)
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
    record.session = { problems } as ClaudeSession
    records.push(record)
  }

  // 2. Transcript-only (Claude Code CLI / IDE) sessions -------------------
  for (const t of transcripts) {
    if (used.has(t)) continue
    used.add(t)
    const problems: string[] = []
    if ((byUuid.get(t.uuid)?.length ?? 0) > 1) {
      problems.push(`The same session UUID also exists in another project folder.`)
    }
    if (t.parseError) problems.push(t.parseError)
    records.push({
      session: { problems } as ClaudeSession,
      transcript: t,
      extraTranscripts: [],
      sharedTranscripts: [],
      legacySubagentLogs: [],
      ownedUuids: [t.uuid],
      guardUuids: [t.uuid],
      appArchiveKey: appArchiveKeyFor(t.filePath)
    })
  }

  // 3. Session data folders + legacy subagent logs ------------------------
  for (const r of records) {
    const owned = [r.transcript, ...r.extraTranscripts].filter((x): x is TranscriptEntry => !!x)
    const primary = r.transcript && !r.sharedTranscripts.includes(r.transcript) ? r.transcript : undefined
    if (primary) {
      const d = dataDirByKey.get(dataDirKey(primary.projectDir, primary.uuid))
      if (d && !usedDataDirs.has(d)) {
        r.dataDir = d
        usedDataDirs.add(d)
      }
    } else if (r.metadata && !r.transcript && r.ownedUuids.length) {
      // Metadata-only: attach a session folder only if its UUID is unique.
      const cands = dataDirsByUuid.get(r.ownedUuids[0]) ?? []
      if (cands.length === 1 && !usedDataDirs.has(cands[0])) {
        r.dataDir = cands[0]
        usedDataDirs.add(cands[0])
      }
    }
    for (const t of owned) {
      if (r.sharedTranscripts.includes(t)) continue
      for (const log of legacyLogs) {
        if (log.parentSessionId === t.uuid && pathKey(log.projectDir) === pathKey(t.projectDir)) r.legacySubagentLogs.push(log)
      }
    }
  }

  // 4. Orphan session folders ---------------------------------------------
  for (const d of dataDirs) {
    if (usedDataDirs.has(d)) continue
    const problems = ['Session data folder without a transcript or metadata file (orphan).']
    if (byUuid.has(d.uuid)) problems.push(`A transcript with the same UUID exists in another project folder.`)
    records.push({
      session: { problems } as ClaudeSession,
      dataDir: d,
      extraTranscripts: [],
      sharedTranscripts: [],
      legacySubagentLogs: [],
      ownedUuids: [],
      guardUuids: [d.uuid]
    })
  }

  // 5. file-history / session-env: only when exactly one owner ------------
  const owners = new Map<string, SessionRecord[]>()
  for (const r of records) {
    for (const u of r.ownedUuids) owners.set(u, [...(owners.get(u) ?? []), r])
  }
  const attach = (map: Map<string, UuidDirEntry>, assign: (r: SessionRecord, e: UuidDirEntry) => void, label: string): void => {
    for (const [uuid, entry] of map) {
      const list = owners.get(uuid) ?? []
      if (list.length === 1) assign(list[0], entry)
      else if (list.length > 1) {
        for (const r of list) r.session.problems.push(`${label} folder ${uuid} is shared by ${list.length} sessions; excluded from deletion.`)
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

function normalize(r: SessionRecord, input: BuildInput): ClaudeSession {
  const problems = r.session.problems
  const meta = r.metadata
  const t = r.transcript
  const s = t?.summary
  const kind: ClaudeSession['kind'] = meta ? 'desktop' : t ? 'cli' : 'orphan'
  const keyPath = meta?.filePath ?? t?.filePath ?? r.dataDir!.dirPath
  const id = makeSessionId(kind, keyPath)

  const appArchived = !!r.appArchiveKey && input.appArchived.has(r.appArchiveKey)
  const archived = meta ? meta.isArchived : appArchived
  let status: SessionStatus
  if (meta) status = t ? (meta.isArchived ? 'archived' : 'active') : 'metadata-only'
  else if (t) status = 'transcript-only'
  else status = 'orphan'
  if (meta?.remoteKind && !t) problems.push(`Remote (${meta.remoteKind.toUpperCase()}) session: the transcript is stored on the remote host.`)

  const customTitle = s?.customTitle ?? r.dataDir?.customTitle
  const title = resolveDisplayTitle({
    metadataTitle: meta?.rawTitle,
    customTitle,
    aiTitle: s?.aiTitle,
    summary: s?.summary,
    firstUserMessage: s?.firstUserMessage,
    lastPrompt: s?.lastPrompt
  })

  const projectPath = meta?.originCwd ?? meta?.cwd ?? s?.cwd
  const projectDirName = t?.projectDirName ?? r.dataDir?.projectDirName
  const projectName = projectPath ? baseName(projectPath) : projectDirName ?? 'Unknown project'

  const transcriptSize = [t, ...r.extraTranscripts].reduce((n, x) => n + (x?.size ?? 0), 0)
  const otherSize =
    (r.fileHistoryDir?.bytes ?? 0) + (r.sessionEnvDir?.bytes ?? 0) + r.legacySubagentLogs.reduce((n, l) => n + l.size, 0)
  const sessionDataSize = r.dataDir?.bytes ?? 0
  const metadataSize = meta?.size ?? 0

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
    projectName,
    projectKey: projectKeyOf(projectPath, projectDirName),
    projectDirName,
    metadataFile: meta?.filePath,
    transcriptFile: t?.filePath,
    extraTranscriptFiles: r.extraTranscripts.map((x) => x.filePath),
    sessionDataDirectory: r.dataDir?.dirPath,
    fileHistoryDirectory: r.fileHistoryDir?.dirPath,
    sessionEnvDirectory: r.sessionEnvDir?.dirPath,
    legacySubagentLogs: r.legacySubagentLogs.map((l) => l.filePath),
    archived,
    archiveSource: archived ? (meta ? 'desktop-metadata' : 'app-local') : undefined,
    createdAt: meta?.createdAt ?? s?.firstTimestamp ?? r.dataDir?.mtimeMs,
    updatedAt: maxDefined(meta?.lastActivityAt, s?.lastTimestamp) ?? t?.mtimeMs ?? meta?.mtimeMs ?? r.dataDir?.mtimeMs,
    transcriptSize: t ? transcriptSize : undefined,
    metadataSize: meta ? metadataSize : undefined,
    sessionDataSize: r.dataDir ? sessionDataSize : undefined,
    otherSize: otherSize || undefined,
    totalSize: transcriptSize + metadataSize + sessionDataSize + otherSize,
    model: meta?.model ?? s?.model,
    models: s?.models ?? (meta?.model ? [meta.model] : []),
    firstUserMessage: s?.firstUserMessage,
    lastUserMessage: s?.lastUserMessage,
    lastPrompt: s?.lastPrompt,
    userMessageCount: s?.userMessageCount,
    assistantMessageCount: s?.assistantMessageCount,
    gitBranch: s?.gitBranch,
    claudeVersion: s?.version,
    entrypoint: s?.entrypoint,
    hasMetadata: !!meta,
    hasTranscript: !!t,
    remoteKind: meta?.remoteKind,
    live: live ? { pid: live.pid, status: live.status, name: live.name, entrypoint: live.entrypoint } : undefined,
    problems
  }
}
