import { open, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { FIVE_HOURS, ONE_WEEK, type AccountUsage, type UsageLimit } from '../../shared/types'

/**
 * How much of each account's plan limits is used, as the tools themselves
 * last recorded it; no server is asked. Claude Code keeps what its /usage
 * shows in the account's `.claude.json` (cachedUsageUtilization). Codex
 * writes its limits into the session file with each answer (a token_count
 * event). Nothing else is taken from either.
 */

/** `.claude.json` also holds project history: larger than this, it is not read for a few numbers. */
const MAX_CONFIG_FILE = 32 * 1024 * 1024
/** The end of a session file, where its newest usage event is. */
const TAIL_BYTES = 1024 * 1024
/** Codex's latest numbers are in the sessions it wrote to last, among those of its latest days. */
const CODEX_FILES = 3
const RECENT_DAYS = 2
const SESSION_FILE = /^rollout-.*\.jsonl$/

type Json = Record<string, unknown>
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() && v.length <= 80 ? v.trim() : undefined)
/** An ISO date or epoch seconds/milliseconds, as milliseconds. */
const time = (v: unknown): number | undefined => {
  const n = num(v)
  if (n !== undefined) return n < 1e12 ? n * 1000 : n
  const parsed = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function severityOf(percent: number, given?: unknown): UsageLimit['severity'] {
  if (given === 'normal' || given === 'warning' || given === 'critical') return given
  return percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal'
}

function limit(windowMinutes: number, percent: number, resetsAt: unknown, model?: string, severity?: unknown): UsageLimit {
  const p = Math.min(100, Math.max(0, Math.round(percent)))
  return { windowMinutes, ...(model ? { model } : {}), percent: p, resetsAt: time(resetsAt), severity: severityOf(p, severity) }
}

/**
 * From Claude Code's `cachedUsageUtilization`: its list of limits (with their
 * severity and model), else the named windows older versions keep. A limit
 * that is not in force (is_active false) is left out.
 */
export function claudeLimits(config: unknown): Omit<AccountUsage, 'accountId'> {
  const cached = obj(obj(config)?.cachedUsageUtilization)
  const usage = obj(cached?.utilization)
  const limits: UsageLimit[] = []
  for (const entry of Array.isArray(usage?.limits) ? usage.limits : []) {
    const l = obj(entry)
    const percent = num(l?.percent)
    const group = `${l?.group ?? ''} ${l?.kind ?? ''}`
    const window = /week/i.test(group) ? ONE_WEEK : /five_hour|session/i.test(group) ? FIVE_HOURS : undefined
    if (!l || l.is_active === false || percent === undefined || !window) continue
    limits.push(limit(window, percent, l.resets_at, text(obj(obj(l.scope)?.model)?.display_name), l.severity))
  }
  const named: Array<[string, number, string?]> = [
    ['five_hour', FIVE_HOURS],
    ['seven_day', ONE_WEEK],
    ['seven_day_opus', ONE_WEEK, 'Opus'],
    ['seven_day_sonnet', ONE_WEEK, 'Sonnet']
  ]
  for (const [key, window, model] of named) {
    const w = obj(usage?.[key])
    const percent = num(w?.utilization)
    // Only what the list did not already give.
    if (percent !== undefined && !limits.some((l) => l.windowMinutes === window && (l.model ?? '').toLowerCase() === (model ?? '').toLowerCase())) {
      limits.push(limit(window, percent, w?.resets_at, model))
    }
  }
  return { recordedAt: time(cached?.fetchedAtMs), limits: sortLimits(limits) }
}

/** From one line of a Codex session file: its token_count event's rate limits (none for an API key). */
export function codexLimits(line: unknown): Omit<AccountUsage, 'accountId'> | null {
  const event = obj(line)
  const payload = obj(event?.payload)
  if (payload?.type !== 'token_count') return null
  const rates = obj(payload.rate_limits)
  const limits: UsageLimit[] = []
  for (const key of ['primary', 'secondary']) {
    const w = obj(rates?.[key])
    const percent = num(w?.used_percent)
    const window = num(w?.window_minutes)
    if (percent !== undefined && window) limits.push(limit(window, percent, w?.resets_at ?? addSeconds(event?.timestamp, w?.resets_in_seconds)))
  }
  return { recordedAt: time(event?.timestamp), limits: sortLimits(limits) }
}

/** Older Codex versions said how long until the reset rather than when. */
function addSeconds(from: unknown, seconds: unknown): number | undefined {
  const start = time(from)
  const s = num(seconds)
  return start !== undefined && s !== undefined ? start + s * 1000 : undefined
}

/** The shorter window first, then the limits on all models before those on one. */
const sortLimits = (limits: UsageLimit[]): UsageLimit[] => [...limits].sort((a, b) => a.windowMinutes - b.windowMinutes || Number(!!a.model) - Number(!!b.model))

type Recorded = Omit<AccountUsage, 'accountId'>
interface Stamped {
  path: string
  size: number
  mtimeMs: number
}

/** Each Claude account's usage, from the `.claude.json` Claude Code wrote last (`configFiles`: where it may be). */
export async function claudeUsage(accounts: Array<{ id: string; configFiles: string[] }>): Promise<AccountUsage[]> {
  return Promise.all(
    accounts.map(async ({ id, configFiles }) => {
      const file = newestOf(await Promise.all(configFiles.map(stamped)))
      const usage = file && file.size <= MAX_CONFIG_FILE ? await cached(file, async () => claudeLimits(JSON.parse((await readFile(file.path, 'utf8')).replace(/^\uFEFF/, '')))) : null
      return { accountId: id, ...(usage ?? { limits: [] }) }
    })
  )
}

/**
 * Each Codex account's usage, from the newest usage event in the session files
 * it wrote to last: those of its latest days (a session started since the last
 * scan included), and `known`, its sessions active lately (an older one resumed).
 */
export async function codexUsage(accounts: Array<{ id: string; home: string; known: string[] }>): Promise<AccountUsage[]> {
  return Promise.all(
    accounts.map(async ({ id, home, known }) => {
      const files = await recentSessionFiles(home, known)
      const found = await Promise.all(files.map((f) => cached(f, () => lastUsage(f.path))))
      const latest = found.reduce<Recorded | null>((a, b) => (b && (!a || (b.recordedAt ?? 0) > (a.recordedAt ?? 0)) ? b : a), null)
      return { accountId: id, ...(latest ?? { limits: [] }) }
    })
  )
}

/**
 * What was read from a file, kept until the file changes: Settings asks every
 * few seconds while it shows the usage, and most files have not changed.
 */
const reads = new Map<string, { stamp: string; value: Recorded | null }>()
const MAX_READS = 200

async function cached(file: Stamped, read: () => Promise<Recorded | null>): Promise<Recorded | null> {
  const stamp = `${file.size}|${file.mtimeMs}`
  const known = reads.get(file.path)
  if (known?.stamp === stamp) return known.value
  const value = await read().catch(() => null)
  reads.delete(file.path)
  reads.set(file.path, { stamp, value })
  if (reads.size > MAX_READS) reads.delete(reads.keys().next().value as string)
  return value
}

const stamped = (file: string): Promise<Stamped | null> => stat(file).then((s) => ({ path: file, size: s.size, mtimeMs: s.mtimeMs }), () => null)

const newestOf = (files: Array<Stamped | null>): Stamped | null => files.reduce<Stamped | null>((a, b) => (b && (!a || b.mtimeMs > a.mtimeMs) ? b : a), null)

/** The session files Codex most likely wrote to last, newest first. */
async function recentSessionFiles(home: string, known: string[]): Promise<Stamped[]> {
  const days = await latestDays(path.join(home, 'sessions'), RECENT_DAYS)
  const listed = await Promise.all(days.map((d) => readdir(d).then((names) => names.filter((n) => SESSION_FILE.test(n)).map((n) => path.join(d, n)), () => [])))
  const files = await Promise.all([...new Set([...listed.flat(), ...known.slice(0, CODEX_FILES)])].map(stamped))
  return files
    .filter((f): f is Stamped => f !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, CODEX_FILES)
}

/** Codex files a session under the day it started, sessions/<yyyy>/<mm>/<dd>: the `count` latest of those folders. */
async function latestDays(root: string, count: number): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, level: number): Promise<void> => {
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n)).sort().reverse()
    for (const name of names) {
      if (found.length >= count) return
      if (level === 3) found.push(path.join(dir, name))
      else await walk(path.join(dir, name), level + 1)
    }
  }
  await walk(root, 1)
  return found
}

async function lastUsage(file: string): Promise<Recorded | null> {
  const line = await lastUsageLine(file)
  const event = line ? safeParse(line) : null
  return event ? codexLimits(event) : null
}

/** The last token_count line in the end of a session file, without reading the whole file. */
async function lastUsageLine(file: string): Promise<string | null> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    // The first line is cut unless the file starts there.
    const first = length < size ? 1 : 0
    for (let i = lines.length - 1; i >= first; i--) if (lines[i].includes('"token_count"')) return lines[i]
    return null
  } finally {
    await handle.close()
  }
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}
