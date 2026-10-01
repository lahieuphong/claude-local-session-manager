import { readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ClaudeSession } from '../../shared/types'
import { mapLimit } from '../util/fsx'

/**
 * Claude Code stores each workspace under ~/.claude/projects/<encoded>, where
 * <encoded> is the cwd with every non-alphanumeric character replaced by "-"
 * (E:\Phong_Nho_IT\185 → E--Phong-Nho-IT-185). The encoding is lossy, so the
 * folder name is only a storage locator; the project identity is the real
 * cwd recorded in metadata/transcripts.
 */
export function sanitizeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

const WIN_DRIVE = /^[a-zA-Z]:/

/** Lexical normalization: separators, drive-letter case, trailing separators. */
export function normalizeWorkspacePath(p: string): string {
  let s = p.trim()
  const windowsLike = WIN_DRIVE.test(s) || s.startsWith('\\\\') || (s.includes('\\') && !s.startsWith('/'))
  if (windowsLike) {
    s = s.replace(/\//g, '\\')
    const unc = s.startsWith('\\\\')
    s = (unc ? '\\\\' : '') + s.slice(unc ? 2 : 0).replace(/\\{2,}/g, '\\')
    if (WIN_DRIVE.test(s)) s = s[0].toUpperCase() + s.slice(1)
    if (/^[A-Z]:$/.test(s)) s += '\\'
    if (s.length > 3) s = s.replace(/\\+$/, '')
  } else {
    s = s.replace(/\/{2,}/g, '/')
    if (s.length > 1) s = s.replace(/\/+$/, '')
  }
  return s
}

/** Grouping key: case-insensitive for Windows-style paths. */
export function projectKeyFor(workspacePath: string): string {
  const n = normalizeWorkspacePath(workspacePath)
  return 'path:' + (WIN_DRIVE.test(n) || n.startsWith('\\\\') ? n.toLowerCase() : n)
}

export function workspaceName(workspacePath: string): string {
  const parts = normalizeWorkspacePath(workspacePath).split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? workspacePath
}

export interface DecodeOptions {
  /** Upper bound on directory listings (keeps decoding cheap). */
  maxListings?: number
  listDirs?: (dir: string) => Promise<string[]>
}

async function defaultListDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Reverse the folder-name encoding by walking the real filesystem (read-only
 * directory listings): E--Phong-Nho-IT-nhahattphcm-tools → E:\Phong_Nho_IT\nhahattphcm\tools
 * if that folder exists. Returns undefined when nothing matches exactly.
 */
export async function decodeProjectDirName(encoded: string, opts: DecodeOptions = {}): Promise<string | undefined> {
  const listDirs = opts.listDirs ?? defaultListDirs
  let budget = opts.maxListings ?? 400
  let base: string
  let rest: string
  const drive = /^([A-Za-z])--(.*)$/.exec(encoded)
  if (drive) {
    base = `${drive[1].toUpperCase()}:\\`
    rest = drive[2]
  } else if (encoded.startsWith('-')) {
    base = '/'
    rest = encoded.slice(1)
  } else {
    return undefined
  }

  const walk = async (dir: string, remaining: string): Promise<string | undefined> => {
    if (remaining === '') return dir
    if (budget-- <= 0) return undefined
    const want = remaining.toLowerCase()
    const names = await listDirs(dir)
    // Exact match first, then longest prefix (fewest ambiguous splits).
    const scored = names
      .map((name) => ({ name, enc: sanitizeProjectPath(name).toLowerCase() }))
      .filter((n) => n.enc && (want === n.enc || want.startsWith(n.enc + '-')))
      .sort((a, b) => (a.enc === want ? -1 : b.enc === want ? 1 : b.enc.length - a.enc.length))
    for (const n of scored) {
      const next = path.join(dir, n.name)
      if (n.enc === want) return next
      const found = await walk(next, remaining.slice(n.enc.length + 1))
      if (found) return found
    }
    return undefined
  }
  return walk(base, rest)
}

/**
 * Replace each workspace path with its real on-disk spelling (realpath) when
 * it exists, so "e:\x" and "E:\X" (or a junction and its target) become one
 * project. Paths that no longer exist keep their normalized form.
 */
export async function canonicalizeProjects(sessions: ClaudeSession[]): Promise<void> {
  const unique = new Map<string, string>()
  for (const s of sessions) if (s.projectPath) unique.set(projectKeyFor(s.projectPath), normalizeWorkspacePath(s.projectPath))
  const real = new Map<string, string>()
  await mapLimit([...unique.entries()], 8, async ([key, p]) => {
    try {
      real.set(key, normalizeWorkspacePath(await realpath(p)))
    } catch {
      real.set(key, p)
    }
  })
  for (const s of sessions) {
    if (!s.projectPath) continue
    const canonical = real.get(projectKeyFor(s.projectPath)) ?? normalizeWorkspacePath(s.projectPath)
    s.projectPath = canonical
    s.projectKey = projectKeyFor(canonical)
    s.projectName = workspaceName(canonical)
  }
}
