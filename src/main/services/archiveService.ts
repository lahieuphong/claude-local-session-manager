import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ActionResult, BulkActionResult } from '../../shared/types'
import { validateTarget, PathRejectedError, type AllowedRoots } from '../security/pathValidator'
import { writeFileAtomic } from '../util/atomicWrite'
import { errorMessage, logger } from '../util/logger'
import { msg, msgText, ref } from '../util/messages'
import type { MessageRef } from '../../shared/messages'
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

function warn(warnings: string[], notes: MessageRef[], key: string, params: Record<string, string>): void {
  warnings.push(msgText(key, params))
  notes.push(ref(key, params))
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
  const notes: MessageRef[] = []
  const verb = ref(archived ? 'archive.verb.archive' : 'archive.verb.restore')
  let target
  try {
    target = await validateTarget(rec.filePath, 'metadata', roots)
  } catch (err) {
    return { ok: false, code: 'PATH_REJECTED', message: errorMessage(err), warnings }
  }
  if (!target.exists) {
    return { ok: false, code: 'NOT_FOUND', ...msg('archive.metadataGone', { path: rec.filePath }), warnings }
  }

  let obj: Record<string, unknown>
  try {
    const parsed = JSON.parse(stripBom(await readFile(target.path, 'utf8'))) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
    obj = parsed as Record<string, unknown>
  } catch (err) {
    return { ok: false, code: 'IO_ERROR', ...msg('archive.invalidJson', { verb, error: errorMessage(err) }), warnings }
  }
  if (obj.sessionId !== undefined && obj.sessionId !== rec.sessionId) {
    return { ok: false, code: 'CHANGED_ON_DISK', ...msg('archive.changedOnDisk'), warnings }
  }

  const already = (obj.isArchived === true) === archived
  if (dryRun) {
    logger.info(`[DRY RUN] would set isArchived=${archived} in ${target.path}`)
    return { ok: true, dryRun: true, ...msg('archive.dryRun', { verb, value: String(archived) }), warnings }
  }

  if (!already) {
    obj.isArchived = archived
    try {
      await writeFileAtomic(target.path, JSON.stringify(obj))
      const check = JSON.parse(stripBom(await readFile(target.path, 'utf8'))) as Record<string, unknown>
      if ((check.isArchived === true) !== archived) throw new Error('verification failed after write')
    } catch (err) {
      return { ok: false, code: 'IO_ERROR', ...msg('archive.writeFailed', { verb, error: errorMessage(err) }), warnings }
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
        warn(warnings, notes, 'archive.indexUnrecognised', { file: ARCHIVE_INDEX_FILE })
      } else {
        const set = new Set(ids)
        const had = set.has(rec.sessionId)
        if (archived) set.add(rec.sessionId)
        else set.delete(rec.sessionId)
        if (had !== archived) await writeFileAtomic(idx.path, serializeArchiveIndex(set))
      }
    }
  } catch (err) {
    const reason = err instanceof PathRejectedError ? err.message : errorMessage(err)
    warn(warnings, notes, 'archive.indexNotUpdated', { error: reason })
  }

  const done = msg(already ? (archived ? 'archive.alreadyArchived' : 'archive.alreadyActive') : archived ? 'archive.archived' : 'archive.restored')
  return {
    ok: true,
    message: warnings.length ? `${done.message} ${warnings.join(' ')}` : done.message,
    msg: done.msg,
    notes: notes.length ? notes : undefined,
    warnings
  }
}

export const NOT_ARCHIVABLE_MESSAGE = msgText('archive.notArchivable')

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
    if (!record || !roots) return { ok: false, code: 'NOT_FOUND', ...msg('common.sessionNotFound') }
    if (!record.metadata) return { ok: false, code: 'NOT_SUPPORTED', ...msg('archive.notArchivable') }

    const status = await this.processes.getStatus(true)
    const guard = globalGuard(status) ?? sessionGuard(status, record.guardUuids)
    if (guard) return { ok: false, ...guard }
    const result = await setDesktopArchived(record.metadata, archived, roots, this.isDryRun())
    if (result.ok && !result.dryRun && opts.rescan !== false) await this.repo.scan(archived ? 'archive' : 'restore')
    return result
  }

  async setHidden(id: string, hidden: boolean, opts: { rescan?: boolean } = {}): Promise<ActionResult> {
    const record = this.repo.getRecord(id)
    if (!record) return { ok: false, code: 'NOT_FOUND', ...msg('common.sessionNotFound') }
    if (!record.managerKey) return { ok: false, code: 'NOT_SUPPORTED', ...msg('hide.desktopSession') }
    try {
      await this.hidden.set(record.managerKey, hidden)
    } catch (err) {
      return { ok: false, code: 'IO_ERROR', ...msg('hide.saveFailed', { error: errorMessage(err) }) }
    }
    if (opts.rescan !== false) await this.repo.scan(hidden ? 'hide' : 'unhide')
    return { ok: true, ...msg(hidden ? 'hide.hidden' : 'hide.shown') }
  }

  async bulk(ids: string[], archived: boolean): Promise<BulkActionResult> {
    return this.runBulk(ids, (id) => this.setArchived(id, archived, { rescan: false }), archived ? 'archived' : 'restored', (r) => r.ok && !r.dryRun)
  }

  async bulkHidden(ids: string[], hidden: boolean): Promise<BulkActionResult> {
    return this.runBulk(ids, (id) => this.setHidden(id, hidden, { rescan: false }), hidden ? 'hidden' : 'shown', (r) => r.ok)
  }

  private async runBulk(
    ids: string[],
    op: (id: string) => Promise<ActionResult>,
    verb: 'archived' | 'restored' | 'hidden' | 'shown',
    changed: (r: ActionResult) => boolean
  ): Promise<BulkActionResult> {
    const results: BulkActionResult['results'] = []
    for (const id of ids) {
      const title = this.repo.getRecord(id)?.session.displayTitle ?? id
      results.push({ id, title, ...(await op(id)) })
    }
    if (results.some(changed)) await this.repo.scan(`bulk-${verb}`)
    const failed = results.filter((r) => !r.ok)
    const v = ref(`bulk.verb.${verb}`)
    return {
      ok: failed.length === 0,
      ...(failed.length === 0
        ? msg('bulk.done', { verb: v, count: results.length })
        : msg('bulk.partial', { verb: v, done: results.length - failed.length, count: results.length, failed: failed.length })),
      results
    }
  }
}
