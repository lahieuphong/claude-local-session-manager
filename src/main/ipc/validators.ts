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

