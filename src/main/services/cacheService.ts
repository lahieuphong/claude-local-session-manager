import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../util/atomicWrite'
import { pathKey } from '../util/fsx'
import { errorMessage, logger } from '../util/logger'
import { PARSER_VERSION, type TranscriptSummary } from './transcriptParser'

const CACHE_FORMAT = 1

export interface TranscriptCacheEntry {
  size: number
  mtimeMs: number
  headHash: string
  bytesParsed: number
  summary: TranscriptSummary
}

export interface SubagentCacheEntry {
  size: number
  mtimeMs: number
  sessionId?: string
}

interface CacheFile {
  format: number
  parserVersion: number
  transcripts: Record<string, TranscriptCacheEntry>
  subagents: Record<string, SubagentCacheEntry>
}

/**
 * Parsed-transcript index stored in the app's own userData folder (never in
 * ~/.claude). Entries are reused while a file's size and mtime are unchanged.
 */
export class ScanCache {
  private data: CacheFile = { format: CACHE_FORMAT, parserVersion: PARSER_VERSION, transcripts: {}, subagents: {} }
  private dirty = false

  /** `filePath === null` keeps the cache in memory only (tests). */
  constructor(readonly filePath: string | null) {}

  async load(): Promise<void> {
    if (!this.filePath) return
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as CacheFile
      if (parsed?.format === CACHE_FORMAT && parsed.parserVersion === PARSER_VERSION && parsed.transcripts) {
        this.data = { ...parsed, subagents: parsed.subagents ?? {} }
      } else {
        logger.info('Scan cache format changed; starting with an empty cache')
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`Ignoring unreadable scan cache: ${errorMessage(err)}`)
      }
    }
  }

  getTranscript(filePath: string): TranscriptCacheEntry | undefined {
    return this.data.transcripts[pathKey(filePath)]
  }

  setTranscript(filePath: string, entry: TranscriptCacheEntry): void {
    this.data.transcripts[pathKey(filePath)] = entry
    this.dirty = true
  }

  getSubagent(filePath: string): SubagentCacheEntry | undefined {
    return this.data.subagents[pathKey(filePath)]
  }

  setSubagent(filePath: string, entry: SubagentCacheEntry): void {
    this.data.subagents[pathKey(filePath)] = entry
    this.dirty = true
  }

  /** Drop entries for files that no longer exist. */
  prune(livePaths: Iterable<string>): void {
    const live = new Set([...livePaths].map(pathKey))
    for (const table of [this.data.transcripts, this.data.subagents] as Array<Record<string, unknown>>) {
      for (const key of Object.keys(table)) {
        if (!live.has(key)) {
          delete table[key]
          this.dirty = true
        }
      }
    }
  }

  async save(): Promise<void> {
    if (!this.filePath || !this.dirty) return
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      await writeFileAtomic(this.filePath, JSON.stringify(this.data))
      this.dirty = false
    } catch (err) {
      logger.warn(`Could not save scan cache: ${errorMessage(err)}`)
    }
  }

  async clear(): Promise<void> {
    this.data = { format: CACHE_FORMAT, parserVersion: PARSER_VERSION, transcripts: {}, subagents: {} }
    this.dirty = false
    if (this.filePath) await rm(this.filePath, { force: true })
  }
}
