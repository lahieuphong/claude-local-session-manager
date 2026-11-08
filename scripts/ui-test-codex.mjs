// Synthetic OpenAI Codex data for the tests, and a stand-in for the Codex CLI.
//
//   writeCodexProfile(home)        ~/.codex and ~/.codex-account-2 with Codex's real layout:
//                                  state_5.sqlite (threads, spawn edges), thread_history_1.sqlite
//                                  (conversation items), session files, session_index.jsonl
//   createCodexHome(dir, spec)     one Codex folder from a list of sessions (unit tests)
//   runFakeCodex(args, codexHome)  what `codex archive|unarchive|delete --force <uuid>` does to
//                                  that data, as measured against the real Codex CLI 0.162 on a
//                                  copy of real data: the session row and its sub-agents', their
//                                  conversation, their files and the index line all go
//
// Run as a program it is the Codex CLI for the UI test: CODEX_HOME is the folder,
// the arguments are Codex's. Nothing here reads or writes a real Codex folder.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

export const codexUuid = (n) => `0c0dec00-0000-4000-8000-${String(n).padStart(12, '0')}`
export const CODEX_UUID_RE = /^0c0dec00-0000-4000-8000-\d{12}$/

const STATE_SCHEMA = `
CREATE TABLE threads (
  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  source TEXT NOT NULL, model_provider TEXT, cwd TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', sandbox_policy TEXT,
  approval_mode TEXT, tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, git_sha TEXT, git_branch TEXT, git_origin_url TEXT,
  cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', model TEXT, reasoning_effort TEXT,
  created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '', name TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
CREATE TABLE thread_read_receipts (thread_id TEXT PRIMARY KEY, first_unread_turn INTEGER, revision INTEGER, last_published_turn INTEGER);
CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, description TEXT, installed_on TEXT, success INTEGER, checksum BLOB, execution_time INTEGER);
INSERT INTO _sqlx_migrations VALUES (61, 'ui test', '', 1, x'00', 0);
`
const HISTORY_SCHEMA = `
CREATE TABLE thread_items (
  thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL, updated_at_ordinal INTEGER NOT NULL,
  PRIMARY KEY (thread_id, item_id)
);
CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id, rollout_ordinal);
CREATE INDEX idx_thread_items_user_messages ON thread_items(thread_id, rollout_ordinal) WHERE item_type = 'userMessage';
CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT, started_at INTEGER, completed_at INTEGER, PRIMARY KEY (thread_id, turn_id));
CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
`

const item = (type, text, i) =>
  type === 'userMessage'
    ? { type, id: `u${i}`, content: [{ type: 'text', text, text_elements: [] }] }
    : type === 'agentMessage'
      ? { type, id: `a${i}`, text, phase: 'final' }
      : { type, id: `t${i}`, command: text, cwd: 'C:\\', status: 'completed', exitCode: 0, durationMs: 12 }

/**
 * One Codex folder. `threads`: { id, name?, title?, first?, cwd, model?, archived?, updatedAt, createdAt?,
 * source?, threadSource? ('user' by default), parent?, file? (write a session file), items?: [[type, text]],
 * turnInProgressAt? (a turn Codex still marks as running, started then) }. Items are written from createdAt on,
 * a second apart; a session file's time is the session's updatedAt, as if Codex last wrote it then.
 */
export function createCodexHome(dir, threads) {
  mkdirSync(path.join(dir, 'sessions'), { recursive: true })
  mkdirSync(path.join(dir, 'archived_sessions'), { recursive: true })
  const state = new DatabaseSync(path.join(dir, 'state_5.sqlite'))
  state.exec(STATE_SCHEMA)
  const history = new DatabaseSync(path.join(dir, 'thread_history_1.sqlite'))
  history.exec(HISTORY_SCHEMA)
  const index = []
  for (const t of threads) {
    const created = t.createdAt ?? t.updatedAt - 3_600_000
    const day = new Date(created).toISOString().slice(0, 10).split('-')
    const stamp = new Date(created).toISOString().slice(0, 19).replace(/:/g, '-')
    const name = `rollout-${stamp}-${t.id}.jsonl`
    const rollout = t.archived ? path.join(dir, 'archived_sessions', name) : path.join(dir, 'sessions', ...day, name)
    if (t.file !== false) {
      mkdirSync(path.dirname(rollout), { recursive: true })
      const lines = [
        { timestamp: new Date(created).toISOString(), type: 'session_meta', payload: { id: t.id, cwd: t.cwd, cli_version: '0.162.0', source: t.source ?? 'vscode' } },
        ...(t.items ?? []).map(([type, text]) => ({
          timestamp: new Date(created).toISOString(),
          type: 'response_item',
          payload: { type: 'message', role: type === 'userMessage' ? 'user' : 'assistant', content: [{ type: type === 'userMessage' ? 'input_text' : 'output_text', text }] }
        }))
      ]
      writeFileSync(rollout, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
      utimesSync(rollout, new Date(t.updatedAt), new Date(t.updatedAt))
    }
    const source = t.parent ? JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: t.parent, depth: 1, agent_path: '/root/helper', agent_nickname: 'Helper', agent_role: null } } }) : t.source ?? 'vscode'
    state
      .prepare(
        `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, tokens_used, archived, archived_at, git_branch, cli_version,
          first_user_message, model, created_at_ms, updated_at_ms, thread_source, preview, name)
         VALUES (?, ?, ?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?, '0.162.0', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        t.id, rollout, Math.floor(created / 1000), Math.floor(t.updatedAt / 1000), source, t.cwd, t.title ?? '', 12345,
        t.archived ? 1 : 0, t.archived ? Math.floor(t.updatedAt / 1000) : null, t.branch ?? null,
        t.first ?? '', t.model ?? 'gpt-5-codex', created, t.updatedAt, t.parent ? 'subagent' : t.threadSource ?? 'user', t.first ?? '', t.name ?? null
      )
    if (t.parent) state.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(t.parent, t.id, 'completed')
    ;(t.items ?? []).forEach(([type, text], i) => {
      history
        .prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(t.id, 'turn-1', `${type}-${i}`, i + 1, created + i * 1000, JSON.stringify(item(type, text, i)), type, i + 1)
    })
    if ((t.items ?? []).length) {
      history.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)').run(t.id, 'turn-1', 1, 'completed', Math.floor(created / 1000), Math.floor(created / 1000) + 5)
      history.prepare('INSERT INTO thread_history_projection_state VALUES (?, ?, ?)').run(t.id, 0, (t.items ?? []).length + 1)
    }
    if (t.turnInProgressAt) history.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)').run(t.id, 'turn-running', 99, 'inProgress', Math.floor(t.turnInProgressAt / 1000), null)
    if (t.name) index.push(JSON.stringify({ id: t.id, thread_name: t.name, updated_at: new Date(t.updatedAt).toISOString() }))
  }
  state.close()
  history.close()
  writeFileSync(path.join(dir, 'session_index.jsonl'), index.length ? index.join('\n') + '\n' : '')
  // Codex keeps the sign-in here; the app must never open it.
  writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'CODEX-UI-TEST-SECRET' }))
  return dir
}

export const CODEX_TEST_SECRET = 'CODEX-UI-TEST-SECRET'

/** The Codex data of the UI test profile: two Codex sign-ins. */
export function writeCodexProfile(home, { now = Date.now(), cwds = ['C:\\UiTest\\185', 'C:\\UiTest\\OCR', 'C:\\UiTest\\CMS'] } = {}) {
  const H = 3_600_000
  const roles = {
    named: codexUuid(1),
    aiTitle: codexUuid(2),
    archived: codexUuid(3),
    withAgents: codexUuid(4),
    agentA: codexUuid(5),
    agentB: codexUuid(6),
    recent: codexUuid(7),
    longVi: codexUuid(8),
    guardian: codexUuid(9),
    secondActive: codexUuid(21),
    secondArchived: codexUuid(22)
  }
  const talk = (n) => [
    ['userMessage', 'Refactor the payment module and keep the public API'],
    ['agentMessage', 'I will start by reading the payment module.'],
    ['commandExecution', 'rg -n "pay" src'],
    ...Array.from({ length: n }, (_, i) => (i % 2 ? ['agentMessage', `Step ${i} done.`] : ['userMessage', `Now step ${i}`]))
  ]
  const main = createCodexHome(path.join(home, '.codex'), [
    { id: roles.named, name: 'Refactor the payment flow', first: 'Refactor the payment module and keep the public API', cwd: cwds[0], updatedAt: now - 2 * H, branch: 'feature/pay', items: talk(4) },
    { id: roles.aiTitle, title: 'Summarise the OCR error log', first: 'Why does OCR fail on scanned PDFs?', cwd: cwds[1], updatedAt: now - 26 * H, file: false, items: talk(2) },
    { id: roles.archived, name: 'Old migration notes', first: 'Write migration notes', cwd: cwds[2], updatedAt: now - 80 * H, archived: true, items: talk(0) },
    { id: roles.withAgents, name: 'Audit every service with helpers', first: 'Audit every service', cwd: cwds[0], updatedAt: now - 5 * H, items: talk(2) },
    { id: roles.agentA, title: 'helper A', cwd: cwds[0], updatedAt: now - 5 * H, parent: roles.withAgents, items: [['agentMessage', 'Service A is fine.']] },
    { id: roles.agentB, title: 'helper B', cwd: cwds[0], updatedAt: now - 5 * H, parent: roles.withAgents, items: [['agentMessage', 'Service B needs work.']] },
    { id: roles.recent, name: 'Session Codex is working in', first: 'Keep going', cwd: cwds[1], updatedAt: now - 20_000, createdAt: now - 40_000, items: talk(0) },
    { id: roles.longVi, name: 'Tối ưu hóa toàn bộ quy trình dựng mô hình ba chiều cho nhà hát thành phố và kiểm tra lại hiệu năng', first: 'Tối ưu hóa toàn bộ quy trình', cwd: cwds[2], updatedAt: now - 30 * H, items: talk(1) },
    // Codex's own automatic review: not a session of the user's.
    { id: roles.guardian, title: 'guardian', cwd: cwds[0], updatedAt: now - 3 * H, source: '{"subagent":{"other":"guardian"}}', threadSource: 'guardian_review', file: false }
  ])
  const second = createCodexHome(path.join(home, '.codex-account-2'), [
    { id: roles.secondActive, name: 'Second account: release checklist', first: 'Prepare the release', cwd: cwds[0], updatedAt: now - 10 * H, items: talk(0) },
    { id: roles.secondArchived, name: 'Second account: archived plan', first: 'Plan', cwd: cwds[1], updatedAt: now - 90 * H, archived: true, items: talk(0) }
  ])
  return { main, second, roles, userSessions: { main: 6, second: 2 } }
}

// ---------------------------------------------------------------------------
// The Codex CLI stand-in
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const newest = (dir, prefix) =>
  readdirSync(dir)
    .filter((n) => new RegExp(`^${prefix}_\\d+\\.sqlite$`).test(n))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0]

/** `codex archive|unarchive <uuid>` and `codex delete --force <uuid>`, on a test Codex folder. */
export function runFakeCodex(args, codexHome) {
  const [command, ...rest] = args
  const force = rest.includes('--force')
  const id = rest.find((a) => !a.startsWith('-'))
  if (!['archive', 'unarchive', 'delete'].includes(command) || !id) return { code: 2, output: 'error: unrecognized subcommand' }
  if (command === 'delete' && !force) return { code: 1, output: 'Error: cannot confirm session deletion without an interactive terminal; rerun with --force and a session UUID' }
  if (command === 'delete' && !UUID.test(id)) return { code: 1, output: 'Error: --force requires a session UUID; names must be confirmed interactively' }
  const stateFile = path.join(codexHome, newest(codexHome, 'state'))
  const state = new DatabaseSync(stateFile)
  try {
    const row = state.prepare('SELECT * FROM threads WHERE id = ?').get(id)
    if (!row) return { code: 1, output: `Error: No active or archived session found matching '${id}'.` }
    if (command === 'archive' || command === 'unarchive') {
      const archive = command === 'archive'
      const target = path.join(codexHome, archive ? 'archived_sessions' : path.join('sessions', 'restored'), path.basename(row.rollout_path))
      if (existsSync(row.rollout_path)) {
        mkdirSync(path.dirname(target), { recursive: true })
        renameSync(row.rollout_path, target)
      }
      // Like Codex 0.162: the session's update time becomes now (its conversation and file are untouched).
      state
        .prepare('UPDATE threads SET archived = ?, archived_at = ?, rollout_path = ?, updated_at = ?, updated_at_ms = ? WHERE id = ?')
        .run(archive ? 1 : 0, archive ? Math.floor(Date.now() / 1000) : null, target, Math.floor(Date.now() / 1000), Date.now(), id)
      return { code: 0, output: `${archive ? 'Archived' : 'Unarchived'} session ${id}.` }
    }
    // delete: the session and every session it started, with all they left.
    const ids = [id]
    for (let i = 0; i < ids.length; i++) {
      for (const e of state.prepare('SELECT child_thread_id AS c FROM thread_spawn_edges WHERE parent_thread_id = ?').all(ids[i])) ids.push(e.c)
    }
    for (const t of ids) {
      const r = state.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(t)
      if (r?.rollout_path) rmSync(r.rollout_path, { force: true })
      state.prepare('DELETE FROM threads WHERE id = ?').run(t)
      state.prepare('DELETE FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ?').run(t, t)
      state.prepare('DELETE FROM thread_read_receipts WHERE thread_id = ?').run(t)
    }
    const historyName = newest(codexHome, 'thread_history')
    if (historyName) {
      const history = new DatabaseSync(path.join(codexHome, historyName))
      for (const t of ids) for (const table of ['thread_items', 'thread_turns', 'thread_history_projection_state']) history.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(t)
      history.close()
    }
    const indexFile = path.join(codexHome, 'session_index.jsonl')
    if (existsSync(indexFile)) {
      const keep = readFileSync(indexFile, 'utf8').split('\n').filter((l) => l.trim() && !ids.some((t) => l.includes(t)))
      writeFileSync(indexFile, keep.length ? keep.join('\n') + '\n' : '')
    }
    return { code: 0, output: `Deleted session ${id}.` }
  } finally {
    state.close()
  }
}

// As a program: the Codex CLI of the UI test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = process.env.CODEX_HOME
  const r = home ? runFakeCodex(process.argv.slice(2), home) : { code: 1, output: 'CODEX_HOME is not set' }
  process.stdout.write(r.output + '\n')
  process.exit(r.code)
}
