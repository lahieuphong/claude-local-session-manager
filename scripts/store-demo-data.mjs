// Synthetic session files for Microsoft Store screenshots and for testers.
//
// Writes a small, clearly fake Claude Code profile (transcripts, session
// folders, file history) in the real on-disk format, so the real app scans it
// like any other profile. Nothing here comes from a real user:
//   projects  C:\Projects\DemoWebApp, SampleAPI, DesignSystem (never created)
//   sessions  a1b2c3d4-0000-4000-8000-0000000000NN
// Every session is transcript-only (no Claude Desktop metadata), the kind the
// Microsoft Store edition supports in full.
//
//   node scripts/store-demo-data.mjs <empty-folder>      → <folder>\.claude\…
//
// It refuses to write into a real Claude profile.
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KB = 1024
const MB = 1024 * KB
const MIN = 60_000

/** Marker file: a folder with it was written by this script and may be replaced or removed by it. */
export const DEMO_MARKER = '.lhp-demo-profile'
export const demoUuid = (n) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`
/** Every session ID of the demo profile matches this. */
export const DEMO_UUID_RE = /^a1b2c3d4-0000-4000-8000-\d{12}$/

export const DEMO_PROJECTS = {
  web: 'C:\\Projects\\DemoWebApp',
  api: 'C:\\Projects\\SampleAPI',
  design: 'C:\\Projects\\DesignSystem'
}

/**
 * The demo sessions. Last activity: `ageMin` minutes ago for the recent ones,
 * otherwise `daysAgo` calendar days ago at local time `at` (so the list's date
 * groups and relative labels agree at any time of day). Sizes are the bytes
 * written to disk (padded with plain filler text).
 */
export const DEMO_SESSIONS = [
  { n: 1, title: 'Refactor authentication flow', project: 'web', ageMin: 6, durationMin: 70, model: 'claude-opus-5-5', branch: 'feature/auth-refactor', entrypoint: 'cli', prompts: ['Refactor the login flow to use the new auth service and keep existing sessions valid.', 'Run the auth tests again and summarize what changed.'], turns: 14, tools: 4, transcript: 2.8 * MB, data: [6.4 * MB, 38], history: [1.1 * MB, 12] },
  { n: 2, title: 'Review API performance', project: 'api', ageMin: 48, durationMin: 95, model: 'claude-opus-5-5', branch: 'perf/orders-endpoint', entrypoint: 'claude-vscode', prompts: ['Profile the /orders endpoint and find why p95 latency doubled after the last release.', 'Add an index for the orders query and compare the timings.'], turns: 9, tools: 4, transcript: 1.2 * MB, data: [2.2 * MB, 17] },
  { n: 3, title: 'Update dashboard layout', project: 'web', ageMin: 135, durationMin: 52, model: 'claude-opus-5-5', branch: 'feature/dashboard-layout', entrypoint: 'claude-vscode', prompts: ['Update the dashboard layout so the summary cards wrap on narrow windows.', 'Check the layout at 1280 px wide and update the snapshot tests.'], turns: 11, tools: 4, transcript: 860 * KB, data: [3.4 * MB, 24], history: [512 * KB, 12], env: 4 * KB },
  { n: 4, title: 'Fix build pipeline', project: 'design', ageMin: 290, durationMin: 34, model: 'claude-sonnet-5-5', branch: 'fix/ci-lint', entrypoint: 'cli', prompts: ['The CI build fails on the lint step. Find the cause and fix the pipeline.', 'Retry the pipeline with the new cache key.'], turns: 6, tools: 4, transcript: 420 * KB, data: [1.1 * MB, 9] },
  { n: 5, title: 'Database migration review', project: 'api', daysAgo: 1, at: '16:40', durationMin: 48, model: 'claude-opus-5-5', branch: 'main', entrypoint: 'cli', prompts: ['Review the migration that splits the customers table before we run it in staging.', 'List the rollback steps for this migration.'], turns: 8, tools: 2, transcript: 640 * KB, data: [900 * KB, 6] },
  { n: 6, title: 'Add dark mode color tokens', project: 'design', daysAgo: 1, at: '11:15', durationMin: 66, model: 'claude-sonnet-5-5', branch: 'feature/dark-mode', entrypoint: 'claude-vscode', prompts: ['Add dark mode color tokens and map them to the existing components.', 'Update the token documentation page.'], turns: 12, tools: 3, transcript: 1.5 * MB, data: [2.9 * MB, 21], history: [760 * KB, 9] },
  { n: 7, title: 'Write checkout integration tests', project: 'web', daysAgo: 3, at: '14:20', durationMin: 110, model: 'claude-opus-5-5', branch: 'test/checkout', entrypoint: 'cli', prompts: ['Write integration tests for the checkout flow, including failed payments.', 'Make the payment provider mock deterministic.'], turns: 17, tools: 5, transcript: 3.6 * MB, data: [8.2 * MB, 46], history: [1.4 * MB, 16] },
  { n: 8, title: 'Document REST endpoints', project: 'api', daysAgo: 4, at: '09:30', durationMin: 28, model: 'claude-haiku-4-5', branch: 'docs/api', entrypoint: 'cli', prompts: ['Document the REST endpoints in the README with request and response examples.'], turns: 4, tools: 3, transcript: 310 * KB },
  { n: 9, title: 'Audit color contrast', project: 'design', daysAgo: 6, at: '17:05', durationMin: 39, model: 'claude-sonnet-5-5', branch: 'main', entrypoint: 'claude-vscode', prompts: ['Audit color contrast in the design system and list components below 4.5:1.'], turns: 5, tools: 3, transcript: 540 * KB, data: [700 * KB, 5] },
  { n: 10, title: 'Set up CI build caching', project: 'web', daysAgo: 12, at: '10:45', durationMin: 44, model: 'claude-opus-5-5', branch: 'ci/cache', entrypoint: 'cli', prompts: ['Set up build caching in CI so dependency installs are reused between runs.', 'Measure the pipeline time before and after.'], turns: 7, tools: 3, transcript: 720 * KB, data: [1.6 * MB, 12] },
  { n: 11, title: 'Add rate limiting middleware', project: 'api', daysAgo: 19, at: '15:10', durationMin: 81, model: 'claude-opus-5-5', branch: 'feature/rate-limit', entrypoint: 'cli', prompts: ['Add a rate limiting middleware with per-key limits and tests.', 'Return a Retry-After header when the limit is reached.'], turns: 10, tools: 3, transcript: 1.3 * MB, data: [2.4 * MB, 15], history: [300 * KB, 6] },
  { n: 12, title: 'Upgrade component library', project: 'design', daysAgo: 27, at: '13:25', durationMin: 25, model: 'claude-sonnet-5-5', branch: 'chore/upgrade-components', entrypoint: 'claude-vscode', prompts: ['Upgrade the component library to the next major version.', 'Fix the breaking changes in the button and dialog components.'], turns: 5, tools: 3, transcript: 280 * KB }
]

const FILLER = 'Applied the change, ran the checks again and they pass. '
const filler = (bytes) => FILLER.repeat(Math.ceil(bytes / FILLER.length)).slice(0, Math.max(0, Math.round(bytes)))
/** Claude Code stores a workspace under projects/<cwd with every non-alphanumeric character as "-">. */
const projectDirName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

function assertSafeTarget(home) {
  const target = path.resolve(home)
  const real = path.resolve(process.env.USERPROFILE || os.homedir())
  if (target.toLowerCase() === real.toLowerCase()) throw new Error('Refusing to write demo data into your real user profile')
  const claudeHome = path.join(target, '.claude')
  if (existsSync(claudeHome) && !existsSync(path.join(claudeHome, DEMO_MARKER))) {
    throw new Error(`${claudeHome} already exists and was not created by this script; choose an empty folder`)
  }
}

function write(file, content, mtime) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  utimesSync(file, mtime, mtime)
}

/** One transcript in Claude Code's JSONL format: prompts, assistant steps with tool calls, an AI title. */
function transcript(s, first, last, scale) {
  const uuid = demoUuid(s.n)
  const cwd = DEMO_PROJECTS[s.project]
  const base = { sessionId: uuid, cwd, gitBranch: s.branch, version: '2.1.295', entrypoint: s.entrypoint }
  const lines = []
  const padPerTurn = (s.transcript * scale - 600 * s.turns * (s.tools + 2)) / s.turns
  for (let turn = 0; turn < s.turns; turn++) {
    const ts = new Date(first + ((last - first) * turn) / Math.max(1, s.turns - 1)).toISOString()
    const prompt = turn === 0 ? s.prompts[0] : turn === s.turns - 1 && s.prompts[1] ? s.prompts[1] : `Continue with step ${turn + 1}.`
    lines.push({ type: 'user', message: { role: 'user', content: prompt }, timestamp: ts, ...base })
    for (let k = 0; k < s.tools; k++) {
      lines.push({
        type: 'assistant',
        message: { id: `msg_demo_${s.n}_${turn}_${k}`, model: s.model, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_demo_${turn}_${k}`, name: k % 2 ? 'Edit' : 'Read', input: { file_path: `src/module-${k + 1}.ts` } }] },
        timestamp: ts,
        ...base
      })
    }
    lines.push({
      type: 'assistant',
      message: { id: `msg_demo_${s.n}_${turn}_done`, model: s.model, role: 'assistant', content: [{ type: 'text', text: filler(Math.max(200, padPerTurn)) }] },
      timestamp: ts,
      ...base
    })
  }
  lines.push({ type: 'ai-title', aiTitle: s.title, sessionId: uuid })
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

/** When the session was last active, in epoch ms. */
function lastActivity(s, now) {
  if (s.daysAgo === undefined) return now - s.ageMin * MIN
  const [hour, minute] = s.at.split(':').map(Number)
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - s.daysAgo, hour, minute).getTime()
}

/**
 * Write the demo profile under `home` (`<home>\.claude\…`). Times are relative
 * to `now`, so the list shows today / yesterday / older groups. `scale` shrinks
 * the filler (tests use small files). Returns what was written.
 */
export function writeDemoProfile(home, { now = Date.now(), scale = 1 } = {}) {
  assertSafeTarget(home)
  const claudeHome = path.join(path.resolve(home), '.claude')
  const projects = path.join(claudeHome, 'projects')
  mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true }) // registry of open sessions (empty: none is open)
  writeFileSync(path.join(claudeHome, DEMO_MARKER), 'Synthetic demo data written by scripts/store-demo-data.mjs. Safe to delete.\n')
  let bytes = 0
  let files = 0
  for (const s of DEMO_SESSIONS) {
    const uuid = demoUuid(s.n)
    const last = lastActivity(s, now)
    const first = last - s.durationMin * MIN
    const mtime = new Date(last)
    const dir = path.join(projects, projectDirName(DEMO_PROJECTS[s.project]))
    const put = (file, content) => {
      write(file, content, mtime)
      bytes += Buffer.byteLength(content)
      files++
    }
    put(path.join(dir, `${uuid}.jsonl`), transcript(s, first, last, scale))
    if (s.data) {
      const [size, count] = s.data
      for (let i = 0; i < count; i++) put(path.join(dir, uuid, 'tool-results', `result-${String(i + 1).padStart(3, '0')}.txt`), filler((size * scale) / count))
    }
    if (s.history) {
      const [size, count] = s.history
      for (let i = 0; i < count; i++) put(path.join(claudeHome, 'file-history', uuid, `file${String(i + 1).padStart(2, '0')}@v1`), filler((size * scale) / count))
    }
    if (s.env) put(path.join(claudeHome, 'session-env', uuid, 'env.json'), JSON.stringify({ note: 'synthetic demo data' }).padEnd(s.env, ' '))
  }
  return { claudeHome, sessions: DEMO_SESSIONS.length, files, bytes }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]
  if (!target) {
    console.error('Usage: node scripts/store-demo-data.mjs <empty-folder>')
    process.exit(1)
  }
  if (existsSync(target) && readdirSync(target).some((f) => f !== '.claude')) {
    console.error(`${target} is not empty; choose an empty folder`)
    process.exit(1)
  }
  const r = writeDemoProfile(target)
  console.log(`Wrote ${r.sessions} synthetic sessions (${r.files} files, ${(r.bytes / MB).toFixed(1)} MB) to ${r.claudeHome}`)
}
