import { SHELL_IDS, TERMINAL_LIMITS, type ShellId, type TerminalOpenRequest } from '../../shared/terminal'
import { PROVIDERS, type ExportFormat, type Provider } from '../../shared/types'
import { SESSION_ID_RE } from '../services/sessionBuilder'

/**
 * Argument checks for every IPC call. The renderer may only send internal
 * session IDs (20 hex), plan IDs (32 hex), a typed confirmation and a few
 * enums - never a filesystem path.
 */
const MAX_BULK = 5000
const FORMATS: ExportFormat[] = ['jsonl', 'info', 'markdown']

export function assertId(v: unknown): string {
  if (typeof v !== 'string' || !SESSION_ID_RE.test(v)) throw new Error('Invalid session id')
  return v
}

export function assertIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BULK) throw new Error('Invalid session id list')
  return [...new Set(v.map(assertId))]
}

export function assertFormat(v: unknown): ExportFormat {
  if (typeof v !== 'string' || !FORMATS.includes(v as ExportFormat)) throw new Error('Invalid export format')
  return v as ExportFormat
}

/** Plan IDs are 32 lowercase hex characters; anything else (e.g. a path) is refused. */
export function assertPlanId(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-f0-9]{32}$/.test(v)) throw new Error('Invalid delete plan id')
  return v
}

/** Account IDs are 12 lowercase hex characters, or absent for every session. */
export function assertAccountId(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !/^[a-f0-9]{12}$/.test(v)) throw new Error('Invalid account id')
  return v
}

/** Which tool's sessions; Claude when absent. */
export function assertProvider(v: unknown): Provider {
  if (v === undefined || v === null) return 'claude'
  if (typeof v !== 'string' || !PROVIDERS.includes(v as Provider)) throw new Error('Invalid provider')
  return v as Provider
}

export function assertString(v: unknown, max = 200): string {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid argument')
  return v
}

// ---------------------------------------------------------------------------
// The integrated terminal (shared/terminal.ts)
// ---------------------------------------------------------------------------

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

export function assertTerminalId(v: unknown): number {
  if (!isInt(v, 1, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid terminal id')
  return v
}

export function assertTerminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const { cols: c, rows: r } = TERMINAL_LIMITS
  if (!isInt(cols, c.min, c.max) || !isInt(rows, r.min, r.max)) throw new Error('Invalid terminal size')
  return { cols, rows }
}

/** A shell by its ID and a session by its ID: never a program, a command line or a folder. */
export function assertTerminalOpen(v: unknown): TerminalOpenRequest {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid terminal request')
  const { shell, sessionId, resume, cols, rows, ...rest } = v as Record<string, unknown>
  if (Object.keys(rest).length) throw new Error('Invalid terminal request')
  if (shell !== undefined && !(SHELL_IDS as readonly unknown[]).includes(shell)) throw new Error('Invalid shell')
  // Resuming is of a session: there is nothing to resume without one.
  if (resume !== undefined && (typeof resume !== 'boolean' || (resume && sessionId === undefined))) throw new Error('Invalid terminal request')
  return {
    shell: shell as ShellId | undefined,
    sessionId: sessionId === undefined ? undefined : assertId(sessionId),
    ...(resume ? { resume: true } : {}),
    ...assertTerminalSize(cols, rows)
  }
}

export function assertTerminalInput(v: unknown): string {
  if (typeof v !== 'string' || v.length > TERMINAL_LIMITS.maxInput) throw new Error('Invalid terminal input')
  return v
}

export function assertCharCount(v: unknown): number {
  if (!isInt(v, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid character count')
  return v
}

/** A web address from the terminal's output: http or https, nothing else (no file:, no ms-settings:). */
export function assertWebLink(v: unknown): string {
  if (typeof v !== 'string' || v.length > TERMINAL_LIMITS.maxLink) throw new Error('Invalid link')
  let url: URL
  try {
    url = new URL(v)
  } catch {
    throw new Error('Invalid link')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only web links can be opened')
  return url.href
}

