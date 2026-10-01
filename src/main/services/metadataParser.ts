import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RawTitle, ScanIssue } from '../../shared/types'
import { classifyRawTitle } from '../../shared/titles'
import { LOCAL_METADATA_RE, SAFE_ID_RE, UUID_RE, lstatOrNull, readdirSafe } from '../util/fsx'
import { errorMessage } from '../util/logger'

/**
 * Claude Desktop stores one metadata file per "Code" session:
 *
 *   <claude-code-sessions>/<accountId>/<orgId>/local_<id>.json
 *
 * Fields observed in Claude Desktop 2.16120 (serializer in app.asar):
 *   sessionId ("local_…"), cliSessionId, unarchivedCliSessionId?,
 *   priorCliSessionIds?, cwd, originCwd?, userSelectedFolders, createdAt,
 *   lastActivityAt, model, permissionMode, isArchived, title, processName,
 *   importedFrom?, sshConfig?/wslConfig?, …
 *
 * Every field is treated as optional; unknown fields are preserved verbatim
 * when the file is rewritten (archive/restore).
 */
export interface DesktopMetadataRecord {
  filePath: string
  fileName: string
  /** File name without `.json`, e.g. `local_abc`. */
  stem: string
  /** Directory containing the file (where the archive index and tombstones live). */
  storageDir: string
  accountId: string
  orgId: string
  rootPath: string
  size: number
  mtimeMs: number
  parseError?: string

  sessionId: string
  rawTitle: RawTitle
  cliSessionId?: string
  unarchivedCliSessionId?: string
  priorCliSessionIds: string[]
  cwd?: string
  originCwd?: string
  createdAt?: number
  lastActivityAt?: number
  model?: string
  permissionMode?: string
  isArchived: boolean
  remoteKind?: 'ssh' | 'wsl'
  importedFrom?: string
}

export interface ArchiveIndexInfo {
  path: string
  /** null when the file exists but is not in a recognised format. */
  ids: string[] | null
  error?: string
}

export interface DesktopStorageDir {
  dir: string
  accountId: string
  orgId: string
  /** IDs from `deleted_<id>` tombstone files. */
  tombstones: string[]
  archiveIndex?: ArchiveIndexInfo
}

export interface DesktopRootScan {
  root: string
  records: DesktopMetadataRecord[]
  storageDirs: DesktopStorageDir[]
  issues: ScanIssue[]
}

/** Claude Desktop skips session files above 10 MiB; so do we. */
export const MAX_METADATA_BYTES = 10 * 1024 * 1024
export const ARCHIVE_INDEX_FILE = 'archived-sessions.idx'
export const ARCHIVE_INDEX_VERSION = 1
export const TOMBSTONE_PREFIX = 'deleted_'
const ARCHIVE_ID_RE = /^local_[A-Za-z0-9_-]+$/
/** Sub-folders of an org dir that never contain live session records. */
const SKIP_SUBDIRS = new Set(['imported-staging'])

/** Accept epoch ms, epoch seconds or an ISO string. */
export function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v)
  }
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n) && /^\d+(\.\d+)?$/.test(v.trim())) return parseTimestamp(n)
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : undefined
  }
  return undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** IDs from metadata are only trusted if they cannot smuggle path syntax. */
function safeId(v: unknown): string | undefined {
  return typeof v === 'string' && SAFE_ID_RE.test(v) ? v : undefined
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export interface MetadataFileInfo {
  filePath: string
  storageDir: string
  accountId: string
  orgId: string
  rootPath: string
  size: number
  mtimeMs: number
}

/** Parse metadata JSON text. Never throws: errors land in `parseError`. */
export function parseMetadataText(text: string, info: MetadataFileInfo): DesktopMetadataRecord {
  const fileName = path.basename(info.filePath)
  const stem = fileName.replace(/\.json$/i, '')
  const base: DesktopMetadataRecord = {
    ...info,
    fileName,
    stem,
    sessionId: stem,
    rawTitle: { kind: 'missing' },
    priorCliSessionIds: [],
    isArchived: false
  }

  let obj: unknown
  try {
    obj = JSON.parse(stripBom(text))
  } catch (err) {
    return { ...base, parseError: `Invalid JSON: ${errorMessage(err)}` }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ...base, parseError: 'Metadata is not a JSON object' }
  }
  const o = obj as Record<string, unknown>

  const declaredId = str(o.sessionId)
  const prior = Array.isArray(o.priorCliSessionIds)
    ? o.priorCliSessionIds.map(safeId).filter((x): x is string => !!x)
    : []

  const record: DesktopMetadataRecord = {
    ...base,
    sessionId: declaredId ?? stem,
    rawTitle: classifyRawTitle(o),
    cliSessionId: safeId(o.cliSessionId),
    unarchivedCliSessionId: safeId(o.unarchivedCliSessionId),
    priorCliSessionIds: [...new Set(prior)],
    cwd: str(o.cwd),
    originCwd: str(o.originCwd),
    createdAt: parseTimestamp(o.createdAt),
    lastActivityAt: parseTimestamp(o.lastActivityAt) ?? parseTimestamp(o.updatedAt),
    model: str(o.model),
    permissionMode: str(o.permissionMode),
    isArchived: o.isArchived === true,
    remoteKind: o.sshConfig ? 'ssh' : o.wslConfig ? 'wsl' : undefined,
    importedFrom: str(o.importedFrom)
  }
  if (declaredId && declaredId !== stem) {
    record.parseError = `sessionId "${declaredId}" does not match file name "${stem}"`
  }
  return record
}

export async function readMetadataFile(info: MetadataFileInfo): Promise<DesktopMetadataRecord> {
  if (info.size > MAX_METADATA_BYTES) {
    return { ...parseMetadataText('{}', info), parseError: `Metadata file is larger than ${MAX_METADATA_BYTES} bytes; not parsed` }
  }
  try {
    const text = await readFile(info.filePath, 'utf8')
    return parseMetadataText(text, info)
  } catch (err) {
    return { ...parseMetadataText('{}', info), parseError: `Cannot read file: ${errorMessage(err)}` }
  }
}

/** Transcript IDs referenced by a metadata record, primary first. */
export function transcriptIdsOf(rec: DesktopMetadataRecord): string[] {
  const ids = [rec.cliSessionId, rec.unarchivedCliSessionId, ...rec.priorCliSessionIds].filter(
    (x): x is string => !!x && UUID_RE.test(x)
  )
  return [...new Set(ids)]
}

export function parseArchiveIndex(text: string): string[] | null {
  let obj: unknown
  try {
    obj = JSON.parse(stripBom(text))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as { v?: unknown; archived?: unknown }
  if (o.v !== ARCHIVE_INDEX_VERSION || !Array.isArray(o.archived)) return null
  const ids: string[] = []
  for (const id of o.archived) {
    if (typeof id !== 'string' || !ARCHIVE_ID_RE.test(id)) return null
    ids.push(id)
  }
  return ids
}

/** Same format Claude Desktop writes: {"v":1,"archived":[sorted ids]}. */
export function serializeArchiveIndex(ids: Iterable<string>): string {
  const archived = [...new Set(ids)].filter((id) => ARCHIVE_ID_RE.test(id)).sort()
  return JSON.stringify({ v: ARCHIVE_INDEX_VERSION, archived })
}

async function scanStorageDir(
  dir: string,
  ctx: { accountId: string; orgId: string; root: string },
  out: DesktopRootScan
): Promise<void> {
  const entries = await readdirSafe(dir)
  const info: DesktopStorageDir = { dir, accountId: ctx.accountId, orgId: ctx.orgId, tombstones: [] }
  let interesting = false
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      out.issues.push({ path: full, message: 'Skipped symbolic link in Claude Desktop storage' })
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.startsWith(TOMBSTONE_PREFIX)) {
      info.tombstones.push(entry.name.slice(TOMBSTONE_PREFIX.length))
      interesting = true
    } else if (entry.name === ARCHIVE_INDEX_FILE) {
      interesting = true
      try {
        const ids = parseArchiveIndex(await readFile(full, 'utf8'))
        info.archiveIndex = ids ? { path: full, ids } : { path: full, ids: null, error: 'Unrecognised archive index format' }
      } catch (err) {
        info.archiveIndex = { path: full, ids: null, error: errorMessage(err) }
      }
    } else if (LOCAL_METADATA_RE.test(entry.name)) {
      interesting = true
      const st = await lstatOrNull(full)
      if (!st) continue
      out.records.push(
        await readMetadataFile({
          filePath: full,
          storageDir: dir,
          accountId: ctx.accountId,
          orgId: ctx.orgId,
          rootPath: ctx.root,
          size: st.size,
          mtimeMs: st.mtimeMs
        })
      )
    }
  }
  if (interesting) out.storageDirs.push(info)
}

/** Scan one `claude-code-sessions` root (read-only). */
export async function scanDesktopRoot(root: string): Promise<DesktopRootScan> {
  const out: DesktopRootScan = { root, records: [], storageDirs: [], issues: [] }
  try {
    for (const account of await readdirSafe(root)) {
      if (!account.isDirectory()) continue
      const accountDir = path.join(root, account.name)
      for (const org of await readdirSafe(accountDir)) {
        if (!org.isDirectory()) continue
        const orgDir = path.join(accountDir, org.name)
        const ctx = { accountId: account.name, orgId: org.name, root }
        await scanStorageDir(orgDir, ctx, out)
        for (const sub of await readdirSafe(orgDir)) {
          if (!sub.isDirectory() || SKIP_SUBDIRS.has(sub.name)) continue
          await scanStorageDir(path.join(orgDir, sub.name), ctx, out)
        }
      }
    }
  } catch (err) {
    out.issues.push({ path: root, message: `Cannot scan Claude Desktop storage: ${errorMessage(err)}` })
  }
  return out
}
