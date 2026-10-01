import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { LiveCliSession, ScanIssue } from '../../shared/types'
import {
  AGENT_JSONL_RE,
  UUID_JSONL_RE,
  UUID_RE,
  directoryUsage,
  lstatOrNull,
  mapLimit,
  readdirSafe
} from '../util/fsx'
import { errorMessage } from '../util/logger'
import type { ScanCache } from './cacheService'
import { stripBom } from './metadataParser'
import {
  emptySummary,
  parseTranscriptFile,
  readDeclaredSessionId,
  readHeadHash,
  type ParseResult,
  type TranscriptSummary
} from './transcriptParser'

/**
 * Layout of ~/.claude/projects observed on this machine (Claude Code 2.1.x):
 *
 *   projects/<sanitized-cwd>/<uuid>.jsonl          primary transcript
 *   projects/<sanitized-cwd>/<uuid>/               session data
 *        subagents/agent-<id>.jsonl (+ .meta.json)   subagent logs (NOT sessions)
 *        tool-results/*.txt, workflows/, custom-title.json
 *   projects/<sanitized-cwd>/agent-<id>.jsonl      legacy subagent log (NOT a session)
 *   projects/<sanitized-cwd>/memory/               project memory (never touched)
 */

export interface TranscriptEntry {
  uuid: string
  filePath: string
  projectDir: string
  projectDirName: string
  size: number
  mtimeMs: number
  summary: TranscriptSummary
  parseError?: string
}

export interface SessionDataDirEntry {
  uuid: string
  dirPath: string
  projectDir: string
  projectDirName: string
  bytes: number
  files: number
  links: number
  mtimeMs: number
  customTitle?: string
  subagentLogs: number
}

export interface LegacySubagentLog {
  filePath: string
  projectDir: string
  projectDirName: string
  size: number
  mtimeMs: number
  parentSessionId?: string
}

export interface UuidDirEntry {
  uuid: string
  dirPath: string
  bytes: number
  files: number
  links: number
}

export interface ProjectsScanStats {
  parsed: number
  incremental: number
  fromCache: number
  subagentLogsExcluded: number
  ignoredEntries: number
}

export interface ProjectsScan {
  transcripts: TranscriptEntry[]
  dataDirs: SessionDataDirEntry[]
  legacySubagentLogs: LegacySubagentLog[]
  stats: ProjectsScanStats
  issues: ScanIssue[]
}

export interface ScanOptions {
  concurrency?: number
  chunkSize?: number
}

async function summarizeTranscript(
  filePath: string,
  size: number,
  mtimeMs: number,
  cache: ScanCache,
  stats: ProjectsScanStats,
  opts: ScanOptions
): Promise<{ summary: TranscriptSummary; error?: string }> {
  const cached = cache.getTranscript(filePath)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    stats.fromCache++
    return { summary: cached.summary }
  }
  try {
    let resume: ParseResult | undefined
    if (cached && cached.bytesParsed > 0 && size >= cached.bytesParsed) {
      // Same prefix → the file was only appended to: parse just the new bytes.
      if ((await readHeadHash(filePath, cached.bytesParsed)) === cached.headHash) {
        resume = { summary: cached.summary, bytesParsed: cached.bytesParsed }
      }
    }
    const result = await parseTranscriptFile(filePath, { resume, chunkSize: opts.chunkSize })
    if (resume) stats.incremental++
    else stats.parsed++
    const headHash = await readHeadHash(filePath, result.bytesParsed)
    cache.setTranscript(filePath, { size, mtimeMs, headHash, bytesParsed: result.bytesParsed, summary: result.summary })
    return { summary: result.summary }
  } catch (err) {
    return { summary: cached?.summary ?? emptySummary(), error: `Cannot parse transcript: ${errorMessage(err)}` }
  }
}

async function readCustomTitleJson(dir: string): Promise<string | undefined> {
  try {
    const obj = JSON.parse(stripBom(await readFile(path.join(dir, 'custom-title.json'), 'utf8'))) as { customTitle?: unknown }
    return typeof obj?.customTitle === 'string' && obj.customTitle.trim() ? obj.customTitle : undefined
  } catch {
    return undefined
  }
}

async function countSubagentLogs(dir: string): Promise<number> {
  const entries = await readdirSafe(path.join(dir, 'subagents'))
  return entries.filter((e) => e.isFile() && AGENT_JSONL_RE.test(e.name)).length
}

/** Scan ~/.claude/projects (read-only). */
export async function scanProjects(root: string, cache: ScanCache, opts: ScanOptions = {}): Promise<ProjectsScan> {
  const out: ProjectsScan = {
    transcripts: [],
    dataDirs: [],
    legacySubagentLogs: [],
    stats: { parsed: 0, incremental: 0, fromCache: 0, subagentLogsExcluded: 0, ignoredEntries: 0 },
    issues: []
  }
  const transcriptJobs: Array<Omit<TranscriptEntry, 'summary'>> = []

  for (const project of await readdirSafe(root)) {
    const projectDir = path.join(root, project.name)
    if (project.isSymbolicLink()) {
      out.issues.push({ path: projectDir, message: 'Skipped symbolic link / junction in projects folder' })
      continue
    }
    if (!project.isDirectory()) {
      out.stats.ignoredEntries++
      continue
    }
    let entries
    try {
      entries = await readdirSafe(projectDir)
    } catch (err) {
      out.issues.push({ path: projectDir, message: `Cannot read project folder: ${errorMessage(err)}` })
      continue
    }
    for (const entry of entries) {
      const full = path.join(projectDir, entry.name)
      if (entry.isSymbolicLink()) {
        out.issues.push({ path: full, message: 'Skipped symbolic link / junction' })
        continue
      }
      if (entry.isFile() && UUID_JSONL_RE.test(entry.name)) {
        const st = await lstatOrNull(full)
        if (!st) continue
        transcriptJobs.push({
          uuid: entry.name.slice(0, -'.jsonl'.length).toLowerCase(),
          filePath: full,
          projectDir,
          projectDirName: project.name,
          size: st.size,
          mtimeMs: st.mtimeMs
        })
      } else if (entry.isFile() && AGENT_JSONL_RE.test(entry.name)) {
        // Legacy layout: subagent logs next to transcripts. Never a session.
        out.stats.subagentLogsExcluded++
        const st = await lstatOrNull(full)
        if (!st) continue
        const cached = cache.getSubagent(full)
        let parentSessionId = cached?.sessionId
        if (!cached || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
          parentSessionId = await readDeclaredSessionId(full).catch(() => undefined)
          cache.setSubagent(full, { size: st.size, mtimeMs: st.mtimeMs, sessionId: parentSessionId })
        }
        out.legacySubagentLogs.push({
          filePath: full,
          projectDir,
          projectDirName: project.name,
          size: st.size,
          mtimeMs: st.mtimeMs,
          parentSessionId: parentSessionId?.toLowerCase()
        })
      } else if (entry.isDirectory() && UUID_RE.test(entry.name)) {
        try {
          const usage = await directoryUsage(full)
          const st = await lstatOrNull(full)
          const subagentLogs = await countSubagentLogs(full)
          out.stats.subagentLogsExcluded += subagentLogs
          out.dataDirs.push({
            uuid: entry.name.toLowerCase(),
            dirPath: full,
            projectDir,
            projectDirName: project.name,
            bytes: usage.bytes,
            files: usage.files,
            links: usage.links,
            mtimeMs: Math.max(usage.newestMtimeMs, st?.mtimeMs ?? 0),
            customTitle: await readCustomTitleJson(full),
            subagentLogs
          })
        } catch (err) {
          out.issues.push({ path: full, message: `Cannot read session data folder: ${errorMessage(err)}` })
        }
      } else {
        // memory/, other files: project-level data, never part of a session.
        out.stats.ignoredEntries++
      }
    }
  }

  out.transcripts = await mapLimit(transcriptJobs, opts.concurrency ?? 3, async (job) => {
    const { summary, error } = await summarizeTranscript(job.filePath, job.size, job.mtimeMs, cache, out.stats, opts)
    if (error) out.issues.push({ path: job.filePath, message: error })
    return { ...job, summary, parseError: error }
  })
  return out
}

/** Scan a folder of `<uuid>/` sub-folders (file-history, session-env). */
export async function scanUuidDirs(root: string | null): Promise<Map<string, UuidDirEntry>> {
  const map = new Map<string, UuidDirEntry>()
  if (!root) return map
  for (const entry of await readdirSafe(root)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID_RE.test(entry.name)) continue
    const dirPath = path.join(root, entry.name)
    const usage = await directoryUsage(dirPath)
    map.set(entry.name.toLowerCase(), {
      uuid: entry.name.toLowerCase(),
      dirPath,
      bytes: usage.bytes,
      files: usage.files,
      links: usage.links
    })
  }
  return map
}

/**
 * Read ~/.claude/sessions/<pid>.json: Claude Code's registry of running
 * sessions. Liveness of each PID is decided by the process service.
 */
export async function readLiveSessionRegistry(dir: string | null): Promise<Array<Omit<LiveCliSession, 'alive'>>> {
  if (!dir) return []
  const out: Array<Omit<LiveCliSession, 'alive'>> = []
  for (const entry of await readdirSafe(dir)) {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue
    try {
      const obj = JSON.parse(stripBom(await readFile(path.join(dir, entry.name), 'utf8'))) as Record<string, unknown>
      const pid = typeof obj.pid === 'number' ? obj.pid : Number(entry.name.slice(0, -5))
      if (!Number.isInteger(pid) || pid <= 0 || typeof obj.sessionId !== 'string') continue
      out.push({
        pid,
        sessionId: obj.sessionId.toLowerCase(),
        cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
        status: typeof obj.status === 'string' ? obj.status : undefined,
        name: typeof obj.name === 'string' ? obj.name : undefined,
        entrypoint: typeof obj.entrypoint === 'string' ? obj.entrypoint : undefined
      })
    } catch {
      /* file may be mid-write; ignore */
    }
  }
  return out
}
