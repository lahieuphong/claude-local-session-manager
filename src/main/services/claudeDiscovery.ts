import os from 'node:os'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { CandidatePath, DesktopRootInfo, StorageRoots } from '../../shared/types'
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

export interface DiscoveredRoots {
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

/**
 * Locate every Claude storage root on this machine. Nothing is hard-coded to
 * a user name; everything derives from USERPROFILE / APPDATA / LOCALAPPDATA.
 */
export async function discoverRoots(env: DiscoveryEnv): Promise<DiscoveredRoots> {
  const candidates: CandidatePath[] = []
  const note = async (p: string, label: string): Promise<string | null> => {
    const canonical = await canonicalDir(p)
    candidates.push({ path: p, exists: !!canonical, note: label })
    return canonical
  }

  // --- Claude Code (CLI / IDE) -------------------------------------------
  const claudeHomeRaw = env.claudeConfigDir?.trim() ? env.claudeConfigDir : path.join(env.homedir, '.claude')
  const claudeHome = (await canonicalDir(claudeHomeRaw)) ?? path.resolve(claudeHomeRaw)
  candidates.push({ path: claudeHomeRaw, exists: await isDirectory(claudeHomeRaw), note: 'Claude Code home' })

  const projectsRoot = await note(path.join(claudeHome, 'projects'), 'Claude Code transcripts')
  const fileHistoryRoot = await note(path.join(claudeHome, 'file-history'), 'Claude Code file history')
  const sessionEnvRoot = await note(path.join(claudeHome, 'session-env'), 'Claude Code session env')
  const liveSessionsDir = await note(path.join(claudeHome, 'sessions'), 'Running Claude Code sessions')

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

  return { claudeHome, projectsRoot, fileHistoryRoot, sessionEnvRoot, liveSessionsDir, desktopRoots: desktop, candidates }
}

export function toAllowedRoots(roots: DiscoveredRoots): AllowedRoots {
  return {
    projectsRoot: roots.projectsRoot,
    fileHistoryRoot: roots.fileHistoryRoot,
    sessionEnvRoot: roots.sessionEnvRoot,
    desktopRoots: roots.desktopRoots.map((d) => d.path)
  }
}

export function toStorageRoots(roots: DiscoveredRoots, counts: Map<string, Omit<DesktopRootInfo, 'path' | 'source' | 'variant' | 'packageName'>>): StorageRoots {
  return {
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
