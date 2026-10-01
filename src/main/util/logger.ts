import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { LogEntry } from '../../shared/types'

const MAX_ENTRIES = 500

class Logger {
  private entries: LogEntry[] = []
  private logFile: string | null = null
  private writeChain: Promise<void> = Promise.resolve()
  debugEnabled = false

  /** Enable persistent logging to a file (inside the app's userData). */
  async setLogFile(filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    this.logFile = filePath
  }

  getLogFile(): string | null {
    return this.logFile
  }

  getEntries(): LogEntry[] {
    return [...this.entries]
  }

  debug(message: string, ...details: unknown[]): void {
    if (this.debugEnabled) this.push('debug', message, details)
  }

  info(message: string, ...details: unknown[]): void {
    this.push('info', message, details)
  }

  warn(message: string, ...details: unknown[]): void {
    this.push('warn', message, details)
  }

  error(message: string, ...details: unknown[]): void {
    this.push('error', message, details)
  }

  private push(level: LogEntry['level'], message: string, details: unknown[]): void {
    const suffix = details.length ? ' ' + details.map(formatDetail).join(' ') : ''
    const entry: LogEntry = { time: Date.now(), level, message: message + suffix }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)

    const line = `${new Date(entry.time).toISOString()} [${level}] ${entry.message}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else if (process.env.NODE_ENV !== 'test') console.log(line)

    const file = this.logFile
    if (file) {
      this.writeChain = this.writeChain
        .then(() => appendFile(file, line + '\n', 'utf8'))
        .catch(() => {
          /* logging must never crash the app */
        })
    }
  }
}

function formatDetail(d: unknown): string {
  if (d instanceof Error) return `${d.name}: ${d.message}`
  if (typeof d === 'string') return d
  try {
    return JSON.stringify(d)
  } catch {
    return String(d)
  }
}

export const logger = new Logger()

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code && !err.message.includes(code) ? `${code}: ${err.message}` : err.message
  }
  return String(err)
}

export function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}
