import type { ExportFormat } from '../../shared/types'
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

export function assertString(v: unknown, max = 200): string {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid argument')
  return v
}

