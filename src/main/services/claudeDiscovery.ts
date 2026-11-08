import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { CandidatePath, ClaudeAccount, DesktopRootInfo, StorageRoots } from '../../shared/types'
import { isDirectory, pathKey, readdirSafe } from '../util/fsx'
import type { AllowedRoots } from '../security/pathValidator'

/**
 * Inputs for discovery. Injected so tests can point discovery at temp
 * directories and never at the real user profile.
 */
export interface DiscoveryEnv {
  homedir: string
  appData?: string
  localAppData?: string
  /** Claude Code honours CLAUDE_CONFIG_DIR as an alternative to ~/.claude. */
  claudeConfigDir?: string
  platform: NodeJS.Platform
}

export function envFromProcess(): DiscoveryEnv {
  return {
    homedir: process.env.USERPROFILE || os.homedir(),
    appData: process.env.APPDATA,
    localAppData: process.env.LOCALAPPDATA,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    platform: process.platform
  }
}

export interface DesktopRootCandidate {
  path: string
  source: DesktopRootInfo['source']
  variant: string
  packageName?: string
}

/** One Claude sign-in and its folders, each resolved to its real location (accounts may share them through links). */
export interface AccountRoots extends ClaudeAccount {
  projectsRoot: string | null
  fileHistoryRoot: string | null
  sessionEnvRoot: string | null
  liveSessionsDir: string | null
}

export interface DiscoveredRoots {
  /** Every account found, the main folder first. The fields below are those of the main account. */
  accounts: AccountRoots[]
  claudeHome: string
  projectsRoot: string | null
  fileHistoryRoot: string | null
  sessionEnvRoot: string | null
  liveSessionsDir: string | null
  desktopRoots: DesktopRootCandidate[]
  candidates: CandidatePath[]
}

/** Claude Desktop data folder names ("Claude", and the third-party-provider build "Claude-3p"). */
const DESKTOP_VARIANTS = ['Claude', 'Claude-3p']
const SESSIONS_DIR = 'claude-code-sessions'
/** Extra Claude sign-ins live here, each in its own config folder: ~/.claude-accounts/<name>/ */
const ACCOUNTS_DIR = '.claude-accounts'
/** The file is read for the account's name only; it is small unless something is wrong with it. */
const MAX_IDENTITY_FILE = 32 * 1024 * 1024
/** MSIX package folders that may belong to Claude Desktop. */
const PACKAGE_RE = /^(Claude|AnthropicClaude|Anthropic\.Claude)[_.-]/i

async function canonicalDir(p: string): Promise<string | null> {
  if (!(await isDirectory(p))) return null
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

type AccountIdentity = { email?: string; displayName?: string; plan?: string }
const identities = new Map<string, { stamp: string; identity: AccountIdentity }>()

const pick = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined)

/**
 * The plan as Claude Code's account picker shows it: "Max 20x" comes from the usage tier
 * (`default_claude_max_20x`), not from `planDisplayName`, which may say something else.
 * Only that tier format is read; anything else falls back to `planDisplayName`.
 */
function planOf(account: Record<string, unknown> | undefined): string | undefined {
  for (const tier of [account?.userRateLimitTier, account?.organizationRateLimitTier]) {
    const max = typeof tier === 'string' ? /^default_claude_max_(\d{1,3})x$/.exec(tier) : null
    if (max) return `Max ${max[1]}x`
  }
  return pick(account?.planDisplayName, 40)
}

/**
 * The email, display name and plan of a sign-in, from `oauthAccount` in `.claude.json`.
 * Only these three values leave this function. Sign-in tokens are in another file
 * (`.credentials.json`), which the app never opens.
 */
async function readIdentity(files: string[]): Promise<AccountIdentity> {
  try {
    // Of the places it may be, the one Claude Code wrote last.
    const found = await Promise.all(files.map((f) => stat(f).then((s) => ({ file: f, size: s.size, mtimeMs: s.mtimeMs }), () => null)))
    const newest = found.reduce((a, b) => (b && (!a || b.mtimeMs > a.mtimeMs) ? b : a), null)
    if (!newest) return {}
    const { file, size, mtimeMs } = newest
    if (size > MAX_IDENTITY_FILE) return {}
    // The scan runs often and parsing this file blocks the main process: only read it again when it changes.
    const stamp = `${size}|${mtimeMs}`
    const known = identities.get(file)
    if (known?.stamp === stamp) return known.identity
    const parsed = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as { oauthAccount?: Record<string, unknown> } | null
    const account = parsed?.oauthAccount
    const identity = { email: pick(account?.emailAddress), displayName: pick(account?.displayName), plan: planOf(account) }
    identities.set(file, { stamp, identity })
    return identity
  } catch {
    return {}
  }
}

/** The account whose own folder really holds its session store; the others reach it through a link. */
export function ownsStore(a: Pick<AccountRoots, 'path' | 'projectsRoot'>): boolean {
  return !!a.projectsRoot && pathKey(a.projectsRoot) === pathKey(path.join(a.path, 'projects'))
}

function markSharedStores(accounts: AccountRoots[]): AccountRoots[] {
  return accounts.map((a): AccountRoots => {
    const sharing = accounts.filter((b) => a.projectsRoot && b.projectsRoot && pathKey(a.projectsRoot) === pathKey(b.projectsRoot))
    return sharing.length > 1 ? { ...a, storeRole: ownsStore(a) ? 'original' : 'shared' } : a
  })
}

/** Short names for the switcher: the part of the email before @, or the folder name, made unique. */
function labelAccounts(accounts: Array<Omit<AccountRoots, 'label'>>): AccountRoots[] {
  const folder = (a: { path: string }): string => path.basename(a.path).replace(/^\./, '')
  const short = accounts.map((a) => a.email?.split('@')[0] || folder(a))
  return accounts.map((a, i) => {
    const repeated = short.filter((s) => s === short[i]).length > 1
    return { ...a, label: repeated ? `${short[i]} (${folder(a)})` : short[i] }
  })
}

/** The distinct real locations of one kind of folder across every account, the main account's first. */
export function rootsOf(roots: DiscoveredRoots, key: 'projectsRoot' | 'fileHistoryRoot' | 'sessionEnvRoot' | 'liveSessionsDir'): string[] {
  const found = new Map<string, string>()
  for (const r of [roots[key], ...roots.accounts.map((a) => a[key])]) if (r && !found.has(pathKey(r))) found.set(pathKey(r), r)
  return [...found.values()]
}

/**
 * Locate every Claude storage root on this machine. Nothing is hard-coded to
 * a user name; everything derives from USERPROFILE / APPDATA / LOCALAPPDATA.
 */
export async function discoverRoots(env: DiscoveryEnv): Promise<DiscoveredRoots> {
  const candidates: CandidatePath[] = []
  const note = async (p: string, label: string, noteKey?: CandidatePath['noteKey']): Promise<string | null> => {
    const canonical = await canonicalDir(p)
    candidates.push({ path: p, exists: !!canonical, note: label, ...(noteKey ? { noteKey } : {}) })
    return canonical
  }

  // --- Claude Code (CLI / IDE) -------------------------------------------
  const claudeHomeRaw = env.claudeConfigDir?.trim() ? env.claudeConfigDir : path.join(env.homedir, '.claude')
  const claudeHome = (await canonicalDir(claudeHomeRaw)) ?? path.resolve(claudeHomeRaw)
  candidates.push({ path: claudeHomeRaw, exists: await isDirectory(claudeHomeRaw), note: 'Claude Code home', noteKey: 'claudeHome' })

  const projectsRoot = await note(path.join(claudeHome, 'projects'), 'Claude Code transcripts', 'transcripts')
  const fileHistoryRoot = await note(path.join(claudeHome, 'file-history'), 'Claude Code file history', 'fileHistory')
  const sessionEnvRoot = await note(path.join(claudeHome, 'session-env'), 'Claude Code session env', 'sessionEnv')
  const liveSessionsDir = await note(path.join(claudeHome, 'sessions'), 'Running Claude Code sessions', 'running')

  // --- Every Claude sign-in on this PC -----------------------------------------
  const defaultHome = path.join(env.homedir, '.claude')
  const accountsDir = path.join(env.homedir, ACCOUNTS_DIR)
  // A problem in an extra account's folder must not stop the app from showing the main one.
  const otherFolders = (await readdirSafe(accountsDir).catch(() => []))
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => path.join(accountsDir, e.name))
    .sort()
  const found: Array<Omit<AccountRoots, 'label'> & { identityFiles: string[] }> = []
  const seenAccounts = new Set<string>()
  for (const raw of [claudeHomeRaw, defaultHome, ...otherFolders]) {
    const main = pathKey(raw) === pathKey(claudeHomeRaw)
    try {
      const canonical = main ? claudeHome : await canonicalDir(raw)
      if (!canonical || seenAccounts.has(pathKey(canonical))) continue
      // Other folders count only if they really hold Claude Code data.
      if (!main && !(await isDirectory(path.join(canonical, 'projects')))) continue
      const folders = main
        ? { projectsRoot, fileHistoryRoot, sessionEnvRoot, liveSessionsDir }
        : {
            projectsRoot: await note(path.join(canonical, 'projects'), 'Claude Code transcripts', 'transcripts'),
            fileHistoryRoot: await note(path.join(canonical, 'file-history'), 'Claude Code file history', 'fileHistory'),
            sessionEnvRoot: await note(path.join(canonical, 'session-env'), 'Claude Code session env', 'sessionEnv'),
            liveSessionsDir: await note(path.join(canonical, 'sessions'), 'Running Claude Code sessions', 'running')
          }
      seenAccounts.add(pathKey(canonical))
      // The default folder keeps its `.claude.json` one level up, in the user's home.
      // Claude Code keeps `.claude.json` in the folder when CLAUDE_CONFIG_DIR names it, and for
      // the default folder one level up, in the user's home (the newest of the two is read).
      const inside = path.join(canonical, '.claude.json')
      const identityFiles = pathKey(raw) === pathKey(defaultHome) ? [path.join(env.homedir, '.claude.json'), inside] : [inside]
      found.push({ identityFiles, id: createHash('sha1').update(pathKey(canonical)).digest('hex').slice(0, 12), path: canonical, ...folders })
    } catch (err) {
      // An extra account that cannot be read is skipped; only the main one may stop the scan.
      if (main) throw err
    }
  }
  // A folder with no sessions at all is not an account to switch to, unless it is the only one.
  const usable = found.filter((a) => a.projectsRoot)
  const listed = usable.length ? usable : found
  // With one account there is nothing to tell apart, so its sign-in file is not even opened.
  const accounts = markSharedStores(
    labelAccounts(await Promise.all(listed.map(async ({ identityFiles, ...a }) => ({ ...a, ...(listed.length > 1 ? await readIdentity(identityFiles) : {}) }))))
  )

  // --- Claude Desktop ------------------------------------------------------
  const desktop: DesktopRootCandidate[] = []
  const seen = new Set<string>()
  const addDesktop = async (p: string, c: Omit<DesktopRootCandidate, 'path'>, label: string): Promise<void> => {
    const canonical = await note(p, label)
    if (!canonical || seen.has(pathKey(canonical))) return
    seen.add(pathKey(canonical))
    desktop.push({ path: canonical, ...c })
  }

  if (env.platform === 'win32') {
    if (env.appData) {
      for (const variant of DESKTOP_VARIANTS) {
        await addDesktop(path.join(env.appData, variant, SESSIONS_DIR), { source: 'appdata', variant }, `Claude Desktop (${variant}, APPDATA)`)
      }
    }
    if (env.localAppData) {
      const packagesDir = path.join(env.localAppData, 'Packages')
      for (const entry of await readdirSafe(packagesDir)) {
        if (!entry.isDirectory() || !PACKAGE_RE.test(entry.name)) continue
        for (const variant of DESKTOP_VARIANTS) {
          await addDesktop(
            path.join(packagesDir, entry.name, 'LocalCache', 'Roaming', variant, SESSIONS_DIR),
            { source: 'msix', variant, packageName: entry.name },
            `Claude Desktop (${variant}, MSIX ${entry.name})`
          )
        }
      }
    }
  } else if (env.platform === 'darwin') {
    for (const variant of DESKTOP_VARIANTS) {
      await addDesktop(
        path.join(env.homedir, 'Library', 'Application Support', variant, SESSIONS_DIR),
        { source: 'other', variant },
        `Claude Desktop (${variant})`
      )
    }
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(env.homedir, '.config')
    for (const variant of DESKTOP_VARIANTS) {
      await addDesktop(path.join(configHome, variant, SESSIONS_DIR), { source: 'other', variant }, `Claude Desktop (${variant})`)
    }
  }

  return { accounts, claudeHome, projectsRoot, fileHistoryRoot, sessionEnvRoot, liveSessionsDir, desktopRoots: desktop, candidates }
}

export function toAllowedRoots(roots: DiscoveredRoots): AllowedRoots {
  return {
    projectsRoot: roots.projectsRoot,
    fileHistoryRoot: roots.fileHistoryRoot,
    sessionEnvRoot: roots.sessionEnvRoot,
    desktopRoots: roots.desktopRoots.map((d) => d.path),
    otherRoots: {
      projects: rootsOf(roots, 'projectsRoot'),
      fileHistory: rootsOf(roots, 'fileHistoryRoot'),
      sessionEnv: rootsOf(roots, 'sessionEnvRoot'),
      homes: roots.accounts.map((a) => a.path)
    }
  }
}

export function toStorageRoots(roots: DiscoveredRoots, counts: Map<string, Omit<DesktopRootInfo, 'path' | 'source' | 'variant' | 'packageName'>>): StorageRoots {
  return {
    accounts: roots.accounts.map(({ id, label, email, displayName, plan, storeRole, path: folder }) => ({ id, label, email, displayName, plan, storeRole, path: folder })),
    claudeHome: roots.claudeHome,
    projectsRoot: roots.projectsRoot,
    fileHistoryRoot: roots.fileHistoryRoot,
    sessionEnvRoot: roots.sessionEnvRoot,
    liveSessionsDir: roots.liveSessionsDir,
    desktopRoots: roots.desktopRoots.map((d) => ({
      ...d,
      ...(counts.get(d.path) ?? { sessionFiles: 0, tombstones: 0, archiveIndexes: 0 })
    })),
    candidates: roots.candidates
  }
}
