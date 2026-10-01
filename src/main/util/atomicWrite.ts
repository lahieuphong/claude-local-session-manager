import { randomBytes } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { errorCode } from './logger'

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Crash-safe file replacement:
 *   1. write the full content to a temp file in the same directory,
 *   2. fsync it,
 *   3. rename it over the target (atomic on NTFS / POSIX same-volume).
 *
 * If the process dies at any point the target is either the old or the new
 * content, never a truncated mix. The temp name starts with "." so Claude's
 * own scanners (which look for `local_*.json` / `deleted_*`) ignore it.
 */
export async function writeFileAtomic(target: string, data: string): Promise<void> {
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(tmp, 'wx')
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** Windows can briefly lock files (antivirus, indexer); retry a few times. */
async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      if (i >= attempts - 1 || !RETRYABLE.has(errorCode(err) ?? '')) throw err
      await new Promise((r) => setTimeout(r, 40 * (i + 1)))
    }
  }
}
