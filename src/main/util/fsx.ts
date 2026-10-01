import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { errorCode } from './logger'

export async function statOrNull(p: string): Promise<Stats | null> {
  try {
    return await stat(p)
  } catch (err) {
    if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return null
    throw err
  }
}

export async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p)
  } catch (err) {
    if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return null
    throw err
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  const s = await statOrNull(p)
  return !!s && s.isDirectory()
}

export async function readdirSafe(p: string): Promise<Dirent[]> {
  try {
    return await readdir(p, { withFileTypes: true })
  } catch (err) {
    if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return []
    throw err
  }
}

export interface DirUsage {
  bytes: number
  files: number
  dirs: number
  /** Symlinks/junctions found inside (they are never followed). */
  links: number
  newestMtimeMs: number
}

/**
 * Recursively sum file sizes below a directory. Symbolic links and junctions
 * are counted but never followed.
 */
export async function directoryUsage(dir: string, maxEntries = 200_000): Promise<DirUsage> {
  const usage: DirUsage = { bytes: 0, files: 0, dirs: 0, links: 0, newestMtimeMs: 0 }
  const stack = [dir]
  let seen = 0
  while (stack.length) {
    const current = stack.pop()!
    const entries = await readdirSafe(current)
    for (const entry of entries) {
      if (++seen > maxEntries) return usage
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        usage.links++
        continue
      }
      if (entry.isDirectory()) {
        usage.dirs++
        stack.push(full)
        continue
      }
      if (entry.isFile()) {
        const s = await lstatOrNull(full)
        if (s) {
          usage.files++
          usage.bytes += s.size
          if (s.mtimeMs > usage.newestMtimeMs) usage.newestMtimeMs = s.mtimeMs
        }
      }
    }
  }
  return usage
}

/** Run async jobs with a concurrency limit, preserving result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const UUID_JSONL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i
export const AGENT_JSONL_RE = /^agent-[A-Za-z0-9_-]+\.jsonl$/
export const LOCAL_METADATA_RE = /^local_[A-Za-z0-9_-]+\.json$/
/** Characters allowed in IDs that are ever used to build a file name. */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Lowercase on Windows so path keys compare case-insensitively. */
export function pathKey(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
