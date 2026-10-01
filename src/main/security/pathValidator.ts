import { realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  AGENT_JSONL_RE,
  LOCAL_METADATA_RE,
  UUID_JSONL_RE,
  UUID_RE,
  lstatOrNull,
  pathKey
} from '../util/fsx'
import type { PlanItemKind } from '../../shared/types'

/**
 * Canonical (realpath'd) roots that the app is allowed to modify.
 * Produced by discovery; never supplied by the renderer or by settings.
 */
export interface AllowedRoots {
  projectsRoot: string | null
  fileHistoryRoot: string | null
  sessionEnvRoot: string | null
  desktopRoots: string[]
}

export class PathRejectedError extends Error {
  readonly code = 'PATH_REJECTED'
  constructor(
    message: string,
    readonly target: string
  ) {
    super(`${message}: ${target}`)
    this.name = 'PathRejectedError'
  }
}

interface TargetRule {
  roots: (r: AllowedRoots) => Array<string | null>
  type: 'file' | 'directory'
  /** Allowed number of path segments below the root. */
  depth: number[]
  name: RegExp
}

const projects = (r: AllowedRoots): Array<string | null> => [r.projectsRoot]
const desktop = (r: AllowedRoots): Array<string | null> => r.desktopRoots

/**
 * Shape of every path the app may ever touch. Anything else is rejected,
 * which makes it impossible to delete a project folder, the projects root,
 * a claude-code-sessions root, or any file outside Claude's storage.
 *
 *   transcript    <projects>/<project-dir>/<uuid>.jsonl
 *   session-data  <projects>/<project-dir>/<uuid>/
 *   subagent-log  <projects>/<project-dir>/agent-<id>.jsonl   (legacy layout)
 *   metadata      <desktop>/<account>/<org>/[<sub>/]local_<id>.json
 *   tombstone     <desktop>/<account>/<org>/[<sub>/]deleted_<id>
 *   archive-index <desktop>/<account>/<org>/[<sub>/]archived-sessions.idx
 *   file-history  <~/.claude/file-history>/<uuid>/
 *   session-env   <~/.claude/session-env>/<uuid>/
 */
export const TARGET_RULES: Record<PlanItemKind, TargetRule> = {
  transcript: { roots: projects, type: 'file', depth: [2], name: UUID_JSONL_RE },
  'session-data': { roots: projects, type: 'directory', depth: [2], name: UUID_RE },
  'subagent-log': { roots: projects, type: 'file', depth: [2], name: AGENT_JSONL_RE },
  metadata: { roots: desktop, type: 'file', depth: [3, 4], name: LOCAL_METADATA_RE },
  tombstone: { roots: desktop, type: 'file', depth: [3, 4], name: /^deleted_[A-Za-z0-9_-]{1,128}$/ },
  'archive-index': { roots: desktop, type: 'file', depth: [3, 4], name: /^archived-sessions\.idx$/ },
  'file-history': { roots: (r) => [r.fileHistoryRoot], type: 'directory', depth: [1], name: UUID_RE },
  'session-env': { roots: (r) => [r.sessionEnvRoot], type: 'directory', depth: [1], name: UUID_RE }
}

/** True when `child` is strictly below `parent` (never equal to it). */
export function isStrictlyInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  if (rel === '' || path.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith('..' + path.sep)
}

export function isInsideOrEqual(child: string, parent: string): boolean {
  return pathKey(child) === pathKey(parent) || isStrictlyInside(child, parent)
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

/** Lexical checks that do not touch the disk. */
export function checkLexical(target: unknown, kind: PlanItemKind, roots: AllowedRoots): { resolved: string; root: string } {
  if (typeof target !== 'string' || target.length === 0) {
    throw new PathRejectedError('Path is empty or not a string', String(target))
  }
  if (target.includes('\0')) throw new PathRejectedError('Path contains a NUL byte', target)
  if (!path.isAbsolute(target)) throw new PathRejectedError('Path is not absolute', target)
  if (target.split(/[\\/]+/).some((seg) => seg === '..' || seg === '.')) {
    throw new PathRejectedError('Path contains relative segments', target)
  }
  if (/^\\\\[?.]\\/.test(target)) throw new PathRejectedError('Device/namespace paths are not allowed', target)

  const rule = TARGET_RULES[kind]
  const resolved = path.resolve(target)
  const root = rule.roots(roots).find((r): r is string => !!r && isStrictlyInside(resolved, r))
  if (!root) throw new PathRejectedError(`Path is outside the allowed ${kind} root`, target)

  const depth = path.relative(root, resolved).split(path.sep).length
  if (!rule.depth.includes(depth)) {
    throw new PathRejectedError(`Unexpected location for a ${kind} path (depth ${depth})`, target)
  }
  if (!rule.name.test(path.basename(resolved))) {
    throw new PathRejectedError(`Unexpected file name for a ${kind} path`, target)
  }
  return { resolved, root }
}

export interface ValidatedTarget {
  path: string
  exists: boolean
}

/**
 * Full validation before deleting or modifying a path:
 *  - lexical shape (absolute, no `..`, inside the right root, right depth/name),
 *  - not a symbolic link or junction itself,
 *  - right type (file vs directory),
 *  - realpath equals the lexical path, i.e. no ancestor is a link that
 *    escapes the root (symlink escape).
 *
 * A missing target is reported as `exists: false` (nothing to delete).
 */
export async function validateTarget(target: unknown, kind: PlanItemKind, roots: AllowedRoots): Promise<ValidatedTarget> {
  const { resolved, root } = checkLexical(target, kind, roots)
  const rule = TARGET_RULES[kind]

  const st = await lstatOrNull(resolved)
  if (!st) {
    // Still verify the parent chain so a later create cannot escape.
    await assertCanonical(path.dirname(resolved), root, resolved)
    return { path: resolved, exists: false }
  }
  if (st.isSymbolicLink()) throw new PathRejectedError('Target is a symbolic link or junction', resolved)
  if (rule.type === 'file' && !st.isFile()) throw new PathRejectedError('Expected a regular file', resolved)
  if (rule.type === 'directory' && !st.isDirectory()) throw new PathRejectedError('Expected a directory', resolved)

  await assertCanonical(resolved, root, resolved)
  return { path: resolved, exists: true }
}

async function assertCanonical(p: string, root: string, reported: string): Promise<void> {
  let real: string
  let realRoot: string
  try {
    real = await realpath(p)
    realRoot = await realpath(root)
  } catch (err) {
    throw new PathRejectedError(`Cannot canonicalize path (${(err as Error).message})`, reported)
  }
  if (!samePath(real, p)) throw new PathRejectedError('Path resolves through a link to a different location', reported)
  if (!isStrictlyInside(real, realRoot)) throw new PathRejectedError('Canonical path escapes the allowed root', reported)
}

/** True if `p` is inside any Claude storage root (used to refuse export targets). */
export function isInsideClaudeStorage(p: string, roots: AllowedRoots & { claudeHome?: string }): boolean {
  const all = [roots.projectsRoot, roots.fileHistoryRoot, roots.sessionEnvRoot, roots.claudeHome, ...roots.desktopRoots]
  return all.some((r) => !!r && isInsideOrEqual(p, r))
}
