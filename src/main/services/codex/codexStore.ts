import { createReadStream } from 'node:fs'
import { open as open_, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'

/**
 * Read-only access to Codex's own databases. Every query is a short read in its
 * own connection, opened read-only, so it never writes and never holds a lock
 * for long. Codex's schema changes between versions (this PC has accounts at
 * migrations 48, 59 and 61), so columns are looked up, never assumed.
 */

export interface CodexThread {
  id: string
  rolloutPath: string
  createdAtMs?: number
  updatedAtMs?: number
  cwd?: string
  /** Set by the user (rename). */
  name?: string
  /** Set by Codex. */
  title?: string
  firstUserMessage?: string
  preview?: string
  archived: boolean
  model?: string
  reasoningEffort?: string
  tokensUsed?: number
  gitBranch?: string
  gitSha?: string
  gitOrigin?: string
  cliVersion?: string
  source?: string
}

export interface CodexState {
  /** The sessions the user started (not sub-agents, not Codex's automatic reviews). */
  threads: CodexThread[]
  /** Every session's file, by id (sub-agents too), for the delete plan. */
  rolloutPaths: Map<string, string>
  /** Session id → every session it started, directly or not. */
  descendants: Map<string, string[]>
}

export interface CodexItemStats {
  items: number
  /** Bytes of the stored conversation (the JSON of each item). */
  bytes: number
  userMessages: number
  assistantMessages: number
  toolUses: number
  lastUserMessage?: string
  /** When Codex last added to the conversation (not when it last changed the session's row: archiving does that too). */
  lastActivityAt?: number
  /** Start of a turn Codex still marks as in progress (it may also be one left over from a crash). */
  turnStartedAt?: number
}

function open(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 3000')
  return db
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name))
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : undefined)

/** Seconds or milliseconds, whichever the column holds. */
const msOf = (ms: unknown, seconds: unknown): number | undefined => num(ms) ?? (num(seconds) !== undefined ? (num(seconds) as number) * 1000 : undefined)

export function readCodexState(stateDb: string): CodexState {
  const db = open(stateDb)
  try {
    const cols = columnsOf(db, 'threads')
    if (!cols.has('id') || !cols.has('rollout_path')) throw new Error(`Unrecognised Codex database (no threads table): ${stateDb}`)
    const pick = (...names: string[]): string => names.find((n) => cols.has(n)) ?? 'NULL'
    // Sub-agents and Codex's automatic reviews are not sessions of their own. Rows from before
    // Codex recorded thread_source (left NULL by its migration) are told apart by `source`.
    const bySource = cols.has('source') ? `(source IS NULL OR source NOT LIKE '{"subagent"%')` : '1'
    const isUser = cols.has('thread_source') ? `(thread_source = 'user' OR (thread_source IS NULL AND ${bySource}))` : bySource
    const rows = db
      .prepare(
        `SELECT id, rollout_path,
          ${pick('created_at_ms')} AS created_ms, ${pick('created_at')} AS created_s,
          ${pick('updated_at_ms')} AS updated_ms, ${pick('updated_at')} AS updated_s,
          ${pick('cwd')} AS cwd, ${pick('name')} AS name, ${pick('title')} AS title,
          ${pick('first_user_message')} AS first_user_message, ${pick('preview')} AS preview,
          ${pick('archived')} AS archived, ${pick('model')} AS model, ${pick('reasoning_effort')} AS reasoning_effort,
          ${pick('tokens_used')} AS tokens_used, ${pick('git_branch')} AS git_branch, ${pick('git_sha')} AS git_sha,
          ${pick('git_origin_url')} AS git_origin, ${pick('cli_version')} AS cli_version, ${pick('source')} AS source
        FROM threads WHERE ${isUser}`
      )
      .all() as Array<Record<string, unknown>>
    const threads: CodexThread[] = rows.map((r) => ({
      id: String(r.id),
      rolloutPath: str(r.rollout_path) ?? '',
      createdAtMs: msOf(r.created_ms, r.created_s),
      updatedAtMs: msOf(r.updated_ms, r.updated_s),
      cwd: str(r.cwd),
      name: str(r.name),
      title: str(r.title),
      firstUserMessage: str(r.first_user_message),
      preview: str(r.preview),
      archived: !!num(r.archived),
      model: str(r.model),
      reasoningEffort: str(r.reasoning_effort),
      tokensUsed: num(r.tokens_used),
      gitBranch: str(r.git_branch),
      gitSha: str(r.git_sha),
      gitOrigin: str(r.git_origin),
      cliVersion: str(r.cli_version),
      source: str(r.source)
    }))
    const rolloutPaths = new Map<string, string>()
    for (const r of db.prepare('SELECT id, rollout_path FROM threads').all() as Array<{ id: string; rollout_path: unknown }>) {
      const p = str(r.rollout_path)
      if (p) rolloutPaths.set(String(r.id), p)
    }
    const children = new Map<string, string[]>()
    if (hasTable(db, 'thread_spawn_edges')) {
      for (const e of db.prepare('SELECT parent_thread_id AS p, child_thread_id AS c FROM thread_spawn_edges').all() as Array<{ p: string; c: string }>) {
        const list = children.get(String(e.p)) ?? []
        list.push(String(e.c))
        children.set(String(e.p), list)
      }
    }
    const descendants = new Map<string, string[]>()
    for (const t of threads) {
      const out: string[] = []
      const seen = new Set([t.id])
      const queue = [...(children.get(t.id) ?? [])]
      while (queue.length) {
        const id = queue.shift() as string
        if (seen.has(id)) continue
        seen.add(id)
        out.push(id)
        queue.push(...(children.get(id) ?? []))
      }
      descendants.set(t.id, out)
    }
    return { threads, rolloutPaths, descendants }
  } finally {
    db.close()
  }
}

/** Text of a stored item: a user message has content parts, an agent message a text. */
export function itemText(itemJson: string): string | undefined {
  try {
    const item = JSON.parse(itemJson) as { text?: unknown; content?: Array<{ text?: unknown }> }
    if (typeof item.text === 'string') return item.text
    if (Array.isArray(item.content)) {
      const text = item.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim()
      return text || undefined
    }
  } catch {
    /* not JSON */
  }
  return undefined
}

const TOOL_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView', 'collabAgentToolCall', 'dynamicToolCall'])

/** Message counts and stored size of each session in the history database. */
export function readCodexHistoryStats(historyDb: string, userThreadIds: string[]): Map<string, CodexItemStats> {
  const db = open(historyDb)
  const out = new Map<string, CodexItemStats>()
  try {
    if (!hasTable(db, 'thread_items')) return out
    const get = (id: string): CodexItemStats => {
      let s = out.get(id)
      if (!s) out.set(id, (s = { items: 0, bytes: 0, userMessages: 0, assistantMessages: 0, toolUses: 0 }))
      return s
    }
    // Sizes and counts in two queries: grouped by session alone, SQLite walks its (thread_id, …)
    // index and octet_length reads each size from the record header (35 ms on a 391 MB database).
    // Grouped by session and type as well, it would copy every item into a temporary sort (2-3 s).
    for (const r of db.prepare('SELECT thread_id AS id, SUM(octet_length(item_json)) AS b FROM thread_items GROUP BY thread_id').all() as Array<{ id: string; b: number | null }>) {
      get(String(r.id)).bytes += Number(r.b ?? 0)
    }
    const itemCols = columnsOf(db, 'thread_items')
    const newest = itemCols.has('created_at_ms') ? 'MAX(created_at_ms)' : 'NULL'
    for (const r of db.prepare(`SELECT thread_id AS id, item_type AS type, COUNT(*) AS n, ${newest} AS at FROM thread_items GROUP BY thread_id, item_type`).all() as Array<{
      id: string
      type: string
      n: number
      at: number | null
    }>) {
      const s = get(String(r.id))
      const n = Number(r.n)
      const at = num(r.at)
      if (at !== undefined && at > (s.lastActivityAt ?? 0)) s.lastActivityAt = at
      s.items += n
      if (r.type === 'userMessage') s.userMessages += n
      else if (r.type === 'agentMessage') s.assistantMessages += n
      else if (TOOL_TYPES.has(r.type)) s.toolUses += n
    }
    if (hasTable(db, 'thread_turns')) {
      const turnCols = columnsOf(db, 'thread_turns')
      if (turnCols.has('status') && turnCols.has('started_at')) {
        for (const r of db.prepare(`SELECT thread_id AS id, MAX(started_at) AS s FROM thread_turns WHERE status = 'inProgress' GROUP BY thread_id`).all() as Array<{ id: string; s: unknown }>) {
          const s = num(r.s)
          // Seconds in the Codex versions seen so far; milliseconds read as such.
          if (s !== undefined) get(String(r.id)).turnStartedAt = s < 1e12 ? s * 1000 : s
        }
      }
    }
    const order = itemCols.has('rollout_ordinal') ? 'rollout_ordinal' : 'rowid'
    const last = db.prepare(`SELECT item_json FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage' ORDER BY ${order} DESC LIMIT 1`)
    for (const id of userThreadIds) {
      const row = last.get(id) as { item_json?: string } | undefined
      if (row?.item_json) get(id).lastUserMessage = itemText(row.item_json)
    }
    return out
  } finally {
    db.close()
  }
}

export interface CodexTranscriptEntry {
  role: 'user' | 'assistant' | 'tool'
  type: string
  text: string
  at?: number
  /** The stored record, as Codex wrote it (JSON Lines export). */
  raw: string
}

/** The conversation of one session, from the history database. */
export function readCodexHistoryItems(historyDb: string, threadId: string): CodexTranscriptEntry[] {
  const db = open(historyDb)
  try {
    if (!hasTable(db, 'thread_items')) return []
    const cols = columnsOf(db, 'thread_items')
    const at = cols.has('created_at_ms') ? 'created_at_ms' : 'NULL'
    const order = cols.has('rollout_ordinal') ? 'rollout_ordinal' : 'rowid'
    const rows = db.prepare(`SELECT item_type AS type, item_json AS json, ${at} AS at FROM thread_items WHERE thread_id = ? ORDER BY ${order}`).all(threadId) as Array<{
      type: string
      json: string
      at: number | null
    }>
    return rows.map((r) => {
      const type = String(r.type)
      let text = itemText(r.json) ?? ''
      if (!text && TOOL_TYPES.has(type)) {
        try {
          const item = JSON.parse(r.json) as { command?: unknown; changes?: Array<{ path?: unknown }> }
          text = typeof item.command === 'string' ? item.command : Array.isArray(item.changes) ? item.changes.map((c) => String(c?.path ?? '')).join('\n') : ''
        } catch {
          /* not JSON */
        }
      }
      const role = type === 'userMessage' ? 'user' : type === 'agentMessage' ? 'assistant' : 'tool'
      return { role, type, text, at: num(r.at), raw: r.json }
    })
  } finally {
    db.close()
  }
}

/** The same, from a session file (Codex versions without a history database). */
export async function readCodexRolloutItems(rolloutPath: string): Promise<CodexTranscriptEntry[]> {
  const out: CodexTranscriptEntry[] = []
  const lines = createInterface({ input: createReadStream(rolloutPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let rec: { type?: string; timestamp?: string; payload?: { type?: string; role?: string; content?: Array<{ text?: unknown }>; name?: string; arguments?: unknown } }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const p = rec.payload
    if (rec.type !== 'response_item' || !p) continue
    const at = rec.timestamp ? Date.parse(rec.timestamp) : undefined
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = (p.content ?? []).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim()
      // Codex puts its own instructions in the first user messages; they are not the user's words.
      if (!text || (p.role === 'user' && /^<(environment_context|user_instructions|permissions)/.test(text))) continue
      out.push({ role: p.role, type: p.role === 'user' ? 'userMessage' : 'agentMessage', text, at: Number.isFinite(at) ? at : undefined, raw: line })
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      out.push({ role: 'tool', type: p.type, text: typeof p.arguments === 'string' ? p.arguments.slice(0, 2000) : String(p.name ?? ''), at: Number.isFinite(at) ? at : undefined, raw: line })
    }
  }
  return out
}

/**
 * When Codex last wrote a record to a session file: the timestamp of its last record.
 * Not the file's modification time: `codex unarchive` sets that without writing a record.
 */
export async function lastRecordAt(file: string): Promise<number | undefined> {
  let handle: Awaited<ReturnType<typeof open_>> | undefined
  try {
    handle = await open_(file, 'r')
    const { size } = await handle.stat()
    // Codex writes `{"timestamp":"…","type":…}` first in every record, so only the start of
    // the last record is needed. It can be megabytes back (a long tool output): read more
    // each time until it is in view.
    for (let window = 64 * 1024; ; window *= 4) {
      const start = Math.max(0, size - window)
      const buf = Buffer.alloc(size - start)
      await handle.read(buf, 0, buf.length, start)
      const text = buf.toString('utf8').replace(/\s+$/, '')
      const lineStart = text.lastIndexOf('\n') + 1
      if (lineStart === 0 && start > 0) {
        if (window >= MAX_RECORD_SEARCH) return undefined
        continue
      }
      const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(text.slice(lineStart, lineStart + 512))
      const at = m ? Date.parse(m[1]) : NaN
      return Number.isFinite(at) ? at : undefined
    }
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/** How far back to look for the start of a session file's last record. */
const MAX_RECORD_SEARCH = 64 * 1024 * 1024

/** Counts from a session file, for Codex versions without a history database. */
export function statsFromItems(items: CodexTranscriptEntry[], fileBytes: number): CodexItemStats {
  const users = items.filter((i) => i.role === 'user')
  return {
    items: items.length,
    bytes: fileBytes,
    userMessages: users.length,
    assistantMessages: items.filter((i) => i.role === 'assistant').length,
    toolUses: items.filter((i) => i.role === 'tool').length,
    lastUserMessage: users.at(-1)?.text,
    lastActivityAt: items.reduce<number | undefined>((m, i) => (i.at !== undefined && i.at > (m ?? 0) ? i.at : m), undefined)
  }
}

/** Is this session still in Codex's database, and is it archived? (After a Codex command.) */
export function readThreadState(stateDb: string, threadId: string): { exists: boolean; archived: boolean } {
  const db = open(stateDb)
  try {
    const cols = columnsOf(db, 'threads')
    const row = db.prepare(`SELECT ${cols.has('archived') ? 'archived' : '0'} AS archived FROM threads WHERE id = ?`).get(threadId) as { archived?: unknown } | undefined
    return { exists: !!row, archived: !!num(row?.archived) }
  } finally {
    db.close()
  }
}

/** Rows of these sessions left in the sessions database (a session and the ones it started). */
export function countThreadRows(stateDb: string, threadIds: string[]): number {
  if (!threadIds.length) return 0
  const db = open(stateDb)
  try {
    const q = db.prepare('SELECT COUNT(*) AS n FROM threads WHERE id = ?')
    return threadIds.reduce((n, id) => n + Number((q.get(id) as { n: number }).n), 0)
  } finally {
    db.close()
  }
}

/** The session IDs listed in session_index.jsonl (lower case). Damaged lines are skipped. */
export async function readSessionIndexIds(file: string): Promise<Set<string>> {
  const ids = new Set<string>()
  try {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line.trim()) continue
      try {
        const id = (JSON.parse(line) as { id?: unknown }).id
        if (typeof id === 'string') ids.add(id.toLowerCase())
      } catch {
        /* a damaged line */
      }
    }
  } catch {
    /* no index yet */
  }
  return ids
}

/** Rows of these sessions left in the history database. */
export function countHistoryRows(historyDb: string, threadIds: string[]): number {
  if (!threadIds.length) return 0
  const db = open(historyDb)
  try {
    if (!hasTable(db, 'thread_items')) return 0
    const q = db.prepare('SELECT COUNT(*) AS n FROM thread_items WHERE thread_id = ?')
    return threadIds.reduce((n, id) => n + Number((q.get(id) as { n: number }).n), 0)
  } finally {
    db.close()
  }
}
