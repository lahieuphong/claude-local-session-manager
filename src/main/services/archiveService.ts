import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ActionResult, BulkActionResult } from '../../shared/types'
import { validateTarget, PathRejectedError, type AllowedRoots } from '../security/pathValidator'
import { writeFileAtomic } from '../util/atomicWrite'
import { errorMessage, logger } from '../util/logger'
import type { LocalArchiveStore } from './localArchiveStore'
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

export class ArchiveService {
  constructor(
    private repo: SessionRepository,
    private processes: ProcessService,
    private localArchive: LocalArchiveStore,
    private dryRun: boolean
  ) {}

  async setArchived(id: string, archived: boolean, opts: { rescan?: boolean } = {}): Promise<ActionResult> {
    const record = this.repo.getRecord(id)
    const roots = this.repo.getAllowedRoots()
    if (!record || !roots) return { ok: false, code: 'NOT_FOUND', message: 'Session not found. Refresh and try again.' }

    let result: ActionResult
    if (record.metadata) {
      const status = await this.processes.getStatus(true)
      const guard = globalGuard(status) ?? sessionGuard(status, record.guardUuids)
      if (guard) return { ok: false, ...guard }
      result = await setDesktopArchived(record.metadata, archived, roots, this.dryRun)
    } else if (record.appArchiveKey) {
      // Claude Code CLI has no archive flag: keep it in this app only.
      if (this.dryRun) {
        result = { ok: true, dryRun: true, message: `DRY RUN: would mark as ${archived ? 'archived' : 'active'} in this app.` }
      } else {
        try {
          await this.localArchive.set(record.appArchiveKey, archived)
          result = {
            ok: true,
            message: archived
              ? 'Archived in this app only (Claude Code CLI sessions have no archive flag; Claude files were not modified).'
              : 'Restored in this app.'
          }
        } catch (err) {
          result = { ok: false, code: 'IO_ERROR', message: `Could not save app archive state: ${errorMessage(err)}` }
        }
      }
    } else {
      return { ok: false, code: 'NOT_SUPPORTED', message: 'Orphan session folders cannot be archived. Delete them or leave them.' }
    }
    if (result.ok && !result.dryRun && opts.rescan !== false) await this.repo.scan(archived ? 'archive' : 'restore')
    return result
  }

  async bulk(ids: string[], archived: boolean): Promise<BulkActionResult> {
    const results: BulkActionResult['results'] = []
    for (const id of ids) {
      const title = this.repo.getRecord(id)?.session.displayTitle ?? id
      results.push({ id, title, ...(await this.setArchived(id, archived, { rescan: false })) })
    }
    if (results.some((r) => r.ok && !r.dryRun)) await this.repo.scan(archived ? 'bulk-archive' : 'bulk-restore')
    const failed = results.filter((r) => !r.ok)
    const verb = archived ? 'Archived' : 'Restored'
    return {
      ok: failed.length === 0,
      message: failed.length === 0 ? `${verb} ${results.length} session(s).` : `${verb} ${results.length - failed.length} of ${results.length}; ${failed.length} failed.`,
      results
    }
  }
}
