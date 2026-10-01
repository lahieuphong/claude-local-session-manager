import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../util/atomicWrite'
import { errorMessage, logger } from '../util/logger'

interface StoreFile {
  format: 1
  archived: Record<string, { archivedAt: number }>
}

/**
 * Archive flags for Claude Code CLI sessions, which have no archive field of
 * their own. Stored only in this app's userData; Claude files are untouched,
 * so the session still appears in `claude --resume`.
 */
export class LocalArchiveStore {
  private data: StoreFile = { format: 1, archived: {} }

  constructor(readonly filePath: string | null) {}

  async load(): Promise<void> {
    if (!this.filePath) return
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as StoreFile
      if (parsed?.format === 1 && parsed.archived && typeof parsed.archived === 'object') this.data = parsed
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn(`Ignoring unreadable app archive store: ${errorMessage(err)}`)
    }
  }

  keys(): Set<string> {
    return new Set(Object.keys(this.data.archived))
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.archived, key)
  }

  async set(key: string, archived: boolean): Promise<void> {
    if (archived) this.data.archived[key] = { archivedAt: Date.now() }
    else delete this.data.archived[key]
    if (!this.filePath) return
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFileAtomic(this.filePath, JSON.stringify(this.data, null, 2))
  }
}
