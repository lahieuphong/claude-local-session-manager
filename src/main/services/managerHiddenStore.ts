import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../util/atomicWrite'
import { errorMessage, logger } from '../util/logger'

interface StoreFile {
  format: 1
  hidden: Record<string, { hiddenAt: number }>
}

/**
 * "Hide in manager": a list kept only in this app's userData. It never
 * touches Claude's files and is NOT Claude's archive — a hidden Claude Code
 * session still appears in `claude --resume` and in Claude Desktop.
 */
export class ManagerHiddenStore {
  private data: StoreFile = { format: 1, hidden: {} }

  constructor(readonly filePath: string | null) {}

  async load(): Promise<void> {
    if (!this.filePath) return
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as StoreFile
      if (parsed?.format === 1 && parsed.hidden && typeof parsed.hidden === 'object') this.data = parsed
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn(`Ignoring unreadable hidden-sessions store: ${errorMessage(err)}`)
    }
  }

  keys(): Set<string> {
    return new Set(Object.keys(this.data.hidden))
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.hidden, key)
  }

  async set(key: string, hidden: boolean): Promise<void> {
    if (hidden) this.data.hidden[key] = { hiddenAt: Date.now() }
    else if (this.has(key)) delete this.data.hidden[key]
    else return
    await this.persist()
  }

  /** Remove records after the session itself was deleted. */
  async remove(keys: string[]): Promise<number> {
    const present = keys.filter((k) => this.has(k))
    for (const k of present) delete this.data.hidden[k]
    if (present.length) await this.persist()
    return present.length
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFileAtomic(this.filePath, JSON.stringify(this.data, null, 2))
  }
}
