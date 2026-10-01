import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ActionResult, BulkActionResult } from '../../shared/types'
import { validateTarget, PathRejectedError, type AllowedRoots } from '../security/pathValidator'
import { writeFileAtomic } from '../util/atomicWrite'
import { errorMessage, logger } from '../util/logger'
import type { ManagerHiddenStore } from './managerHiddenStore'
import {
  ARCHIVE_INDEX_FILE,
  parseArchiveIndex,
  serializeArchiveIndex,
  stripBom,
  type DesktopMetadataRecord
} from './metadataParser'
import { globalGuard, sessionGuard, type ProcessService } from './processService'
import type { SessionRepository } from './sessionRepository'

export interface ArchiveFileResult extends ActionResult {
  warnings: string[]
}

/**
 * Set `isArchived` in a Claude Desktop metadata file.
 *
 * Only that one field changes; every other field (known or unknown) is kept
 * as-is. The write is atomic (temp file + fsync + rename) and verified by
 * re-reading. The transcript is never touched. If an `archived-sessions.idx`
 * hint file exists next to the metadata, it is updated the same way Claude
 * Desktop does ({"v":1,"archived":[sorted ids]}); it is never created.
 */
export async function setDesktopArchived(
  rec: DesktopMetadataRecord,
  archived: boolean,
  roots: AllowedRoots,
  dryRun: boolean
): Promise<ArchiveFileResult> {
  const warnings: string[] = []
  const verb = archived ? 'archive' : 'restore'
  let target
  try {
    target = await validateTarget(rec.filePath, 'metadata', roots)
  } catch (err) {
    return { ok: false, code: 'PATH_REJECTED', message: errorMessage(err), warnings }
  }
  if (!target.exists) {
    return { ok: false, code: 'NOT_FOUND', message: `Metadata file disappeared: ${rec.filePath}`, warnings }
  }

  let obj: Record<string, unknown>
  try {
    const parsed = JSON.parse(stripBom(await readFile(target.path, 'utf8'))) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
    obj = parsed as Record<string, unknown>
  } catch (err) {
    return { ok: false, code: 'IO_ERROR', message: `Cannot ${verb}: metadata is not valid JSON (${errorMessage(err)}). File left unchanged.`, warnings }
  }
  if (obj.sessionId !== undefined && obj.sessionId !== rec.sessionId) {
    return { ok: false, code: 'CHANGED_ON_DISK', message: 'Metadata file changed on disk (session ID differs). Refresh and try again.', warnings }
  }

  const already = (obj.isArchived === true) === archived
  if (dryRun) {
    logger.info(`[DRY RUN] would set isArchived=${archived} in ${target.path}`)
    return { ok: true, dryRun: true, message: `DRY RUN: would ${verb} (set isArchived=${archived}). No files were modified.`, warnings }
  }

  if (!already) {
    obj.isArchived = archived
    try {
      await writeFileAtomic(target.path, JSON.stringify(obj))
      const check = JSON.parse(stripBom(await readFile(target.path, 'utf8'))) as Record<string, unknown>
      if ((check.isArchived === true) !== archived) throw new Error('verification failed after write')
    } catch (err) {
      return { ok: false, code: 'IO_ERROR', message: `Could not ${verb}: ${errorMessage(err)}`, warnings }
    }
    logger.info(`Set isArchived=${archived} in ${target.path}`)
  }

  // Keep Claude Desktop's archive hint in sync when it exists.
  try {
    const idxPath = path.join(rec.storageDir, ARCHIVE_INDEX_FILE)
    const idx = await validateTarget(idxPath, 'archive-index', roots)
    if (idx.exists) {
      const ids = parseArchiveIndex(await readFile(idx.path, 'utf8'))
      if (!ids) {
        warnings.push(`${ARCHIVE_INDEX_FILE} has an unrecognised format and was left unchanged.`)
      } else {
        const set = new Set(ids)
        const had = set.has(rec.sessionId)
        if (archived) set.add(rec.sessionId)
        else set.delete(rec.sessionId)
        if (had !== archived) await writeFileAtomic(idx.path, serializeArchiveIndex(set))
      }
    }
  } catch (err) {
    const msg = err instanceof PathRejectedError ? err.message : errorMessage(err)
    warnings.push(`Archive index not updated: ${msg}`)
  }

  const message = already ? `Session was already ${archived ? 'archived' : 'active'}.` : archived ? 'Session archived.' : 'Session restored.'
  return { ok: true, message: warnings.length ? `${message} ${warnings.join(' ')}` : message, warnings }
}

export const NOT_ARCHIVABLE_MESSAGE =
  'This Claude Code session has no Claude Desktop metadata, so Claude has no archive flag for it. ' +
  'Use "Hide in manager" instead (it only changes this app’s list).'

/**
 * Two deliberately separate operations:
 *  - Archive / Restore: Claude Desktop's own `isArchived` flag. Only for
 *    sessions with real `local_*.json` metadata. Blocked while Claude runs.
 *  - Hide / Show in manager: this app's own list. Never touches Claude files,
 *    never creates Claude metadata, and is not Claude's archive.
 */
export class ArchiveService {
  constructor(
    private repo: SessionRepository,
    private processes: ProcessService,
    private hidden: ManagerHiddenStore,
    dryRun: boolean | (() => boolean)
  ) {
    this.isDryRun = typeof dryRun === 'function' ? dryRun : () => dryRun
  }

  private readonly isDryRun: () => boolean

  async setArchived(id: string, archived: boolean, opts: { rescan?: boolean } = {}): Promise<ActionResult> {
    const record = this.repo.getRecord(id)
    const roots = this.repo.getAllowedRoots()
    if (!record || !roots) return { ok: false, code: 'NOT_FOUND', message: 'Session not found. Refresh and try again.' }
    if (!record.metadata) return { ok: false, code: 'NOT_SUPPORTED', message: NOT_ARCHIVABLE_MESSAGE }

    const status = await this.processes.getStatus(true)
    const guard = globalGuard(status) ?? sessionGuard(status, record.guardUuids)
    if (guard) return { ok: false, ...guard }
    const result = await setDesktopArchived(record.metadata, archived, roots, this.isDryRun())
    if (result.ok && !result.dryRun && opts.rescan !== false) await this.repo.scan(archived ? 'archive' : 'restore')
    return result
  }

  async setHidden(id: string, hidden: boolean, opts: { rescan?: boolean } = {}): Promise<ActionResult> {
    const record = this.repo.getRecord(id)
    if (!record) return { ok: false, code: 'NOT_FOUND', message: 'Session not found. Refresh and try again.' }
    if (!record.managerKey) {
      return {
        ok: false,
        code: 'NOT_SUPPORTED',
        message: "This is a Claude Desktop session: use Archive / Restore, which changes Claude's own archive state."
      }
    }
    try {
      await this.hidden.set(record.managerKey, hidden)
    } catch (err) {
      return { ok: false, code: 'IO_ERROR', message: `Could not save the manager's hidden list: ${errorMessage(err)}` }
    }
    if (opts.rescan !== false) await this.repo.scan(hidden ? 'hide' : 'unhide')
    return {
      ok: true,
      message: hidden
        ? "Hidden in manager. Only this app's list changed; Claude's files and archive state are untouched."
        : 'Shown in manager again.'
    }
  }

  async bulk(ids: string[], archived: boolean): Promise<BulkActionResult> {
    return this.runBulk(ids, (id) => this.setArchived(id, archived, { rescan: false }), archived ? 'Archived' : 'Restored', (r) => r.ok && !r.dryRun)
  }

  async bulkHidden(ids: string[], hidden: boolean): Promise<BulkActionResult> {
    return this.runBulk(ids, (id) => this.setHidden(id, hidden, { rescan: false }), hidden ? 'Hidden' : 'Shown', (r) => r.ok)
  }

  private async runBulk(
    ids: string[],
    op: (id: string) => Promise<ActionResult>,
    verb: string,
    changed: (r: ActionResult) => boolean
  ): Promise<BulkActionResult> {
    const results: BulkActionResult['results'] = []
    for (const id of ids) {
      const title = this.repo.getRecord(id)?.session.displayTitle ?? id
      results.push({ id, title, ...(await op(id)) })
    }
    if (results.some(changed)) await this.repo.scan(`bulk-${verb.toLowerCase()}`)
    const failed = results.filter((r) => !r.ok)
    return {
      ok: failed.length === 0,
      message:
        failed.length === 0
          ? `${verb} ${results.length} session(s).`
          : `${verb} ${results.length - failed.length} of ${results.length}; ${failed.length} skipped or failed.`,
      results
    }
  }
}
