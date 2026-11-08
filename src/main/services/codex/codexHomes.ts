import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { CandidatePath, ClaudeAccount } from '../../../shared/types'
import { isDirectory, pathKey, readdirSafe } from '../../util/fsx'

/**
 * Where OpenAI Codex keeps its sessions. One folder is one Codex sign-in:
 * CODEX_HOME (default ~/.codex), and every ~/.codex-<name> folder that holds a
 * Codex database (people keep one per account, like ~/.codex-account-2).
 *
 * Codex keeps each session as a row in `state_<n>.sqlite` and its conversation
 * in `thread_history_<n>.sqlite`; older sessions also have a file under
 * sessions/ (archived ones under archived_sessions/), and session_index.jsonl
 * lists named sessions. `auth.json` holds the sign-in and is never opened.
 */
export interface CodexHome extends ClaudeAccount {
  main: boolean
  /** The newest state database (`state_<n>.sqlite`), when there is one. */
  stateDb: string | null
  /** The newest history database (`thread_history_<n>.sqlite`); older Codex versions have none. */
  historyDb: string | null
  sessionsDir: string
  archivedDir: string
  indexFile: string
}

export interface CodexEnv {
  homedir: string
  /** CODEX_HOME, which Codex honours instead of ~/.codex. */
  codexHome?: string
  appData?: string
  /** PATH, searched for codex.exe last. */
  searchPath?: string
  arch?: string
  /**
   * Tests only: the Codex command as a JSON array (`["node.exe", "fake-codex.mjs"]`),
   * so the UI test can stand in for Codex. Honoured only in a UI test profile. Not a Codex setting.
   */
  commandOverride?: string
}

export function codexEnvFromProcess(): CodexEnv {
  return {
    homedir: process.env.USERPROFILE || process.env.HOME || '',
    codexHome: process.env.CODEX_HOME,
    appData: process.env.APPDATA,
    searchPath: process.env.PATH,
    arch: process.arch,
    commandOverride: process.env.CLAUDE_SESSION_MANAGER_CODEX_COMMAND
  }
}

/** The highest-numbered `<prefix>_<n>.sqlite` in a folder. */
async function newestDb(dir: string, prefix: string): Promise<string | null> {
  const re = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`)
  const found = (await readdirSafe(dir))
    .map((e) => ({ e, n: Number(re.exec(e.name)?.[1] ?? NaN) }))
    .filter(({ e, n }) => e.isFile() && Number.isFinite(n))
    .sort((a, b) => b.n - a.n)
  return found[0] ? path.join(dir, found[0].e.name) : null
}

const idOf = (folder: string): string => createHash('sha1').update('codex|' + pathKey(folder)).digest('hex').slice(0, 12)

/** "codex" for the main folder; "account-2" for ~/.codex-account-2. */
function labelOf(folder: string, main: boolean): string {
  const name = path.basename(folder)
  if (main && name.toLowerCase() === '.codex') return 'codex'
  return name.replace(/^\.codex[-_.]/i, '').replace(/^\./, '') || name
}

export async function discoverCodexHomes(env: CodexEnv): Promise<{ homes: CodexHome[]; candidates: CandidatePath[] }> {
  const candidates: CandidatePath[] = []
  const defaultHome = path.join(env.homedir, '.codex')
  const mainRaw = env.codexHome?.trim() ? env.codexHome : defaultHome
  const others = (await readdirSafe(env.homedir))
    .filter((e) => e.isDirectory() && /^\.codex[-_.]./i.test(e.name))
    .map((e) => path.join(env.homedir, e.name))
    .sort((a, b) => a.localeCompare(b))

  const homes: CodexHome[] = []
  const seen = new Set<string>()
  for (const raw of [mainRaw, defaultHome, ...others]) {
    const main = pathKey(raw) === pathKey(mainRaw)
    let folder: string
    try {
      folder = await realpath(raw)
    } catch {
      if (main) candidates.push({ path: raw, exists: false, note: 'Codex home', noteKey: 'codexHome' })
      continue
    }
    if (seen.has(pathKey(folder)) || !(await isDirectory(folder))) continue
    seen.add(pathKey(folder))
    const stateDb = await newestDb(folder, 'state')
    const sessionsDir = path.join(folder, 'sessions')
    // A folder is a Codex home only if Codex has stored sessions in it.
    if (!stateDb && !(await isDirectory(sessionsDir))) continue
    const historyDb = await newestDb(folder, 'thread_history')
    if (main || homes.length === 0) {
      candidates.push({ path: raw, exists: true, note: 'Codex home', noteKey: 'codexHome' })
    }
    candidates.push({ path: stateDb ?? path.join(folder, 'state_<n>.sqlite'), exists: !!stateDb, note: 'Codex sessions database', noteKey: 'codexState' })
    candidates.push({ path: historyDb ?? path.join(folder, 'thread_history_<n>.sqlite'), exists: !!historyDb, note: 'Codex conversations database', noteKey: 'codexHistory' })
    candidates.push({ path: sessionsDir, exists: await isDirectory(sessionsDir), note: 'Codex session files', noteKey: 'codexSessions' })
    homes.push({
      id: idOf(folder),
      label: labelOf(folder, main),
      path: folder,
      main,
      stateDb,
      historyDb,
      sessionsDir,
      archivedDir: path.join(folder, 'archived_sessions'),
      indexFile: path.join(folder, 'session_index.jsonl')
    })
  }
  // The main folder first, as for Claude accounts.
  homes.sort((a, b) => Number(b.main) - Number(a.main))
  return { homes, candidates }
}

// ---------------------------------------------------------------------------
// The Codex CLI
// ---------------------------------------------------------------------------

export interface CodexCli {
  command: string
  /** Arguments that come before Codex's own (only for the test stand-in). */
  args: string[]
  source: 'npm' | 'vscode' | 'path' | 'test'
}

const isFile = (p: string): Promise<boolean> => stat(p).then((s) => s.isFile(), () => false)

/** Written by scripts/ui-test-profile.mjs into the throw-away profile's ~/.claude. */
const UI_TEST_PROFILE_MARKER = '.ui-test-profile'

/** Version folders like openai.chatgpt-26.1021.22027-win32-x64, newest first. */
function byVersionDesc(a: string, b: string): number {
  const v = (s: string): number[] => (/-(\d+(?:\.\d+)*)/.exec(s)?.[1] ?? '0').split('.').map(Number)
  const [x, y] = [v(a), v(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
  return 0
}

/**
 * The Codex CLI to run for archive, unarchive and delete: the one installed with
 * npm (`npm i -g @openai/codex`), else the one the Codex extension for VS Code
 * brings, else codex.exe on PATH. Only real executables are run, never a shell.
 */
export async function findCodexCli(env: CodexEnv): Promise<CodexCli | null> {
  // The test stand-in counts only in a UI test profile (the marker its generator writes), so the
  // variable alone can never make an installed app run some other program.
  if (env.commandOverride && (await isFile(path.join(env.homedir, '.claude', UI_TEST_PROFILE_MARKER)))) {
    try {
      const parts = JSON.parse(env.commandOverride) as unknown
      if (Array.isArray(parts) && parts.length > 0 && parts.every((p) => typeof p === 'string') && (await isFile(parts[0]))) {
        return { command: parts[0], args: parts.slice(1), source: 'test' }
      }
    } catch {
      /* ignored: not a valid stand-in */
    }
  }
  const triple = env.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const pkg = env.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64'
  if (env.appData) {
    const npm = path.join(env.appData, 'npm', 'node_modules', '@openai', 'codex')
    for (const exe of [
      path.join(npm, 'node_modules', '@openai', pkg, 'vendor', triple, 'bin', 'codex.exe'),
      path.join(npm, 'vendor', triple, 'codex', 'codex.exe')
    ]) {
      if (await isFile(exe)) return { command: exe, args: [], source: 'npm' }
    }
  }
  const binDir = env.arch === 'arm64' ? 'windows-aarch64' : 'windows-x86_64'
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor']) {
    const dir = path.join(env.homedir, editor, 'extensions')
    const exts = (await readdirSafe(dir)).filter((e) => e.isDirectory() && /^openai\.chatgpt-/i.test(e.name)).map((e) => e.name).sort(byVersionDesc)
    for (const ext of exts) {
      const exe = path.join(dir, ext, 'bin', binDir, 'codex.exe')
      if (await isFile(exe)) return { command: exe, args: [], source: 'vscode' }
    }
  }
  for (const dir of (env.searchPath ?? '').split(path.delimiter).filter(Boolean)) {
    const exe = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex')
    if (await isFile(exe)) return { command: exe, args: [], source: 'path' }
  }
  return null
}
