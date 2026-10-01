import { createHash, randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  DeleteItemResult,
  DeletePlan,
  DeletePlanItem,
  DeleteResult,
  SessionDeletePlan,
  SessionDeleteResult
} from '../../shared/types'
import { confirmationPhrases, isConfirmationValid } from '../../shared/confirm'
import { formatBytes } from '../../shared/format'
import { validateTarget, type AllowedRoots } from '../security/pathValidator'
import { writeFileAtomic } from '../util/atomicWrite'
import { SAFE_ID_RE, lstatOrNull, pathKey } from '../util/fsx'
import { errorMessage, logger } from '../util/logger'
import {
  ARCHIVE_INDEX_FILE,
  TOMBSTONE_PREFIX,
  parseArchiveIndex,
  serializeArchiveIndex
} from './metadataParser'
import { globalGuard, sessionGuard, type ProcessService } from './processService'
import type { SessionRecord } from './sessionBuilder'
import type { SessionRepository } from './sessionRepository'

const PLAN_TTL_MS = 15 * 60_000

/**
 * Exact list of paths that make up one session, in execution order.
 * Built only from the scanner registry; nothing is globbed or guessed.
 */
export function buildPlanItems(record: SessionRecord): { items: DeletePlanItem[]; warnings: string[] } {
  const items: DeletePlanItem[] = []
  const warnings: string[] = []
  const meta = record.metadata

  if (meta) {
    items.push({ kind: 'metadata', action: 'delete-file', path: meta.filePath, sizeBytes: meta.size })

    const idx = record.storageDir?.archiveIndex
    if (idx?.ids?.includes(meta.sessionId)) {
      items.push({
        kind: 'archive-index',
        action: 'update-file',
        path: idx.path,
        note: `Remove "${meta.sessionId}" from Claude Desktop's archive index`
      })
    }

    // Claude Desktop writes deleted_<id> tombstones next to the metadata when
    // it deletes a session (session id without "local_" + its transcript ids)
    // so the session is not re-imported. Mirror that behaviour exactly.
    const existing = new Set(record.storageDir?.tombstones ?? [])
    const tombstoneIds = [meta.stem.replace(/^local_/, ''), ...record.ownedUuids]
    for (const id of [...new Set(tombstoneIds)]) {
      if (!SAFE_ID_RE.test(id) || existing.has(id)) continue
      items.push({
        kind: 'tombstone',
        action: 'create-file',
        path: path.join(meta.storageDir, TOMBSTONE_PREFIX + id),
        note: 'Deletion marker, as written by Claude Desktop'
      })
    }
  }

  const transcripts = [record.transcript, ...record.extraTranscripts].filter(
    (t): t is NonNullable<typeof t> => !!t && !record.sharedTranscripts.includes(t)
  )
  for (const t of [...new Set(transcripts)]) {
    items.push({ kind: 'transcript', action: 'delete-file', path: t.filePath, sizeBytes: t.size })
  }
  for (const t of record.sharedTranscripts) {
    warnings.push(`Kept: ${t.filePath} is referenced by another session.`)
  }
  for (const log of record.legacySubagentLogs) {
    items.push({ kind: 'subagent-log', action: 'delete-file', path: log.filePath, sizeBytes: log.size })
  }
  if (record.dataDir) {
    items.push({
      kind: 'session-data',
      action: 'delete-directory',
      path: record.dataDir.dirPath,
      sizeBytes: record.dataDir.bytes,
      fileCount: record.dataDir.files
    })
    if (record.dataDir.links) {
      warnings.push(`${record.dataDir.links} link(s) inside the session folder are removed as links; their targets are not touched.`)
    }
  }
  if (record.fileHistoryDir) {
    items.push({
      kind: 'file-history',
      action: 'delete-directory',
      path: record.fileHistoryDir.dirPath,
      sizeBytes: record.fileHistoryDir.bytes,
      fileCount: record.fileHistoryDir.files
    })
  }
  if (record.sessionEnvDir) {
    items.push({
      kind: 'session-env',
      action: 'delete-directory',
      path: record.sessionEnvDir.dirPath,
      sizeBytes: record.sessionEnvDir.bytes,
      fileCount: record.sessionEnvDir.files
    })
  }
  return { items, warnings }
}

function fingerprint(sessions: SessionDeletePlan[]): string {
  const data = sessions.map((s) => [
    s.sessionId,
    s.items.map((i) => [i.kind, i.action, pathKey(i.path), i.sizeBytes ?? -1, i.fileCount ?? -1])
  ])
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

interface StoredPlan {
  ids: string[]
  bulk: boolean
  fingerprint: string
  createdAt: number
}

export class DeleteService {
  private plans = new Map<string, StoredPlan>()

  constructor(
    private repo: SessionRepository,
    private processes: ProcessService,
    private dryRun: boolean
  ) {}

  private sessionPlans(ids: string[], status: Awaited<ReturnType<ProcessService['getStatus']>>): {
    ok: SessionDeletePlan[]
    blocked: SessionDeletePlan[]
  } {
    const ok: SessionDeletePlan[] = []
    const blocked: SessionDeletePlan[] = []
    for (const id of [...new Set(ids)]) {
      const record = this.repo.getRecord(id)
      if (!record) {
        blocked.push({
          sessionId: id,
          displayTitle: '(unknown session)',
          status: 'orphan',
          items: [],
          totalBytes: 0,
          warnings: [],
          blockedReason: 'Session not found. Refresh and try again.',
          blockedCode: 'NOT_FOUND'
        })
        continue
      }
      const { items, warnings } = buildPlanItems(record)
      const plan: SessionDeletePlan = {
        sessionId: id,
        displayTitle: record.session.displayTitle,
        status: record.session.status,
        items,
        totalBytes: items.reduce((n, i) => n + (i.action.startsWith('delete') ? i.sizeBytes ?? 0 : 0), 0),
        warnings
      }
      const guard = sessionGuard(status, record.guardUuids)
      if (guard) {
        blocked.push({ ...plan, blockedReason: guard.message, blockedCode: guard.code })
      } else if (!items.some((i) => i.action.startsWith('delete'))) {
        blocked.push({ ...plan, blockedReason: 'Nothing on disk to delete for this session.', blockedCode: 'NOT_FOUND' })
      } else {
        ok.push(plan)
      }
    }
    return { ok, blocked }
  }

  /** Build the preview shown in the confirmation modal. Read-only. */
  async createPlan(ids: string[], bulk: boolean): Promise<DeletePlan> {
    this.expirePlans()
    const status = await this.processes.getStatus(true)
    const { ok, blocked } = this.sessionPlans(ids, status)
    const global = globalGuard(status)
    const token = randomBytes(16).toString('hex')
    this.plans.set(token, { ids: ok.map((s) => s.sessionId), bulk, fingerprint: fingerprint(ok), createdAt: Date.now() })
    return {
      token,
      createdAt: Date.now(),
      dryRun: this.dryRun,
      bulk,
      sessions: ok,
      blocked,
      globalBlockedReason: global?.message,
      globalBlockedCode: global?.code,
      totalBytes: ok.reduce((n, s) => n + s.totalBytes, 0),
      totalItems: ok.reduce((n, s) => n + s.items.length, 0),
      confirmationPhrases: confirmationPhrases(ok.length, bulk)
    }
  }

  async execute(ids: string[], confirmation: unknown, token: unknown, bulk: boolean): Promise<DeleteResult> {
    const fail = (code: DeleteResult['code'], message: string): DeleteResult => ({
      ok: false,
      partial: false,
      dryRun: this.dryRun,
      code,
      message,
      sessions: []
    })
    this.expirePlans()
    const stored = typeof token === 'string' ? this.plans.get(token) : undefined
    if (!stored || stored.bulk !== bulk) return fail('INVALID_INPUT', 'Delete preview expired or unknown. Open the delete dialog again.')
    const sameIds = stored.ids.length === new Set(ids).size && stored.ids.every((id) => ids.includes(id))
    if (!sameIds) return fail('INVALID_INPUT', 'Selected sessions differ from the previewed delete plan.')
    if (stored.ids.length === 0) return fail('INVALID_INPUT', 'Nothing to delete.')
    if (!isConfirmationValid(confirmation, confirmationPhrases(stored.ids.length, bulk))) {
      return fail('INVALID_INPUT', 'Confirmation text does not match.')
    }
    this.plans.delete(token as string) // single use

    const status = await this.processes.getStatus(true)
    const global = globalGuard(status)
    if (global) return fail(global.code, global.message)

    // Rescan and require the plan to be byte-for-byte what the user reviewed.
    await this.repo.scan('pre-delete')
    const roots = this.repo.getAllowedRoots()
    if (!roots) return fail('IO_ERROR', 'Claude storage roots are not available.')
    const fresh = this.sessionPlans(stored.ids, status)
    if (fresh.blocked.length) {
      const b = fresh.blocked[0]
      return fail(b.blockedCode ?? 'CHANGED_ON_DISK', `${b.displayTitle}: ${b.blockedReason}`)
    }
    if (fingerprint(fresh.ok) !== stored.fingerprint) {
      return fail('CHANGED_ON_DISK', 'Session files changed since the delete preview was created. Review the updated list and confirm again.')
    }

    const results: SessionDeleteResult[] = []
    for (const plan of fresh.ok) {
      results.push(this.dryRun ? this.dryRunSession(plan) : await this.deleteSession(plan, roots))
    }
    if (!this.dryRun) await this.repo.scan('post-delete')

    const deleted = results.filter((r) => r.outcome === 'deleted')
    const problems = results.filter((r) => r.outcome === 'partial' || r.outcome === 'failed')
    const freed = results.reduce(
      (n, r) => n + r.items.filter((i) => i.outcome === 'deleted').reduce((m, i) => m + (i.sizeBytes ?? 0), 0),
      0
    )
    let message: string
    if (this.dryRun) message = `DRY RUN: ${results.length} session(s) would be deleted. No files were modified.`
    else if (problems.length === 0) message = `Permanently deleted ${deleted.length} session(s), ${formatBytes(freed)} freed.`
    else {
      const failedItems = problems.reduce((n, r) => n + r.items.filter((i) => i.outcome === 'failed').length, 0)
      message = `Delete incomplete: ${deleted.length} of ${results.length} session(s) fully deleted; ${failedItems} item(s) could not be deleted. See details.`
    }
    return {
      ok: problems.length === 0,
      partial: problems.some((r) => r.outcome === 'partial') || (problems.length > 0 && deleted.length > 0),
      dryRun: this.dryRun,
      message,
      sessions: results
    }
  }

  private dryRunSession(plan: SessionDeletePlan): SessionDeleteResult {
    for (const item of plan.items) logger.info(`[DRY RUN] ${item.action} ${item.kind}: ${item.path}`)
    return {
      sessionId: plan.sessionId,
      displayTitle: plan.displayTitle,
      outcome: 'dry-run',
      items: plan.items.map((i) => ({ ...i, outcome: 'dry-run' }))
    }
  }

  private async deleteSession(plan: SessionDeletePlan, roots: AllowedRoots): Promise<SessionDeleteResult> {
    // 1. Validate every path before touching anything for this session.
    for (const item of plan.items) {
      try {
        await validateTarget(item.path, item.kind, roots)
      } catch (err) {
        logger.error(`Delete aborted for ${plan.sessionId}: ${errorMessage(err)}`)
        return {
          sessionId: plan.sessionId,
          displayTitle: plan.displayTitle,
          outcome: 'failed',
          error: errorMessage(err),
          items: plan.items.map((i) => ({ ...i, outcome: i.path === item.path ? 'failed' : 'skipped', error: i.path === item.path ? errorMessage(err) : undefined }))
        }
      }
    }

    // 2. Execute in order: metadata, its index/tombstones, then data.
    const meta = this.repo.getRecord(plan.sessionId)?.metadata
    const desktopSessionId = meta?.sessionId
    const desktopStem = meta?.stem
    const results: DeleteItemResult[] = []
    let metadataGone = !plan.items.some((i) => i.kind === 'metadata')
    for (const item of plan.items) {
      try {
        const target = await validateTarget(item.path, item.kind, roots)
        if (item.action === 'delete-file' || item.action === 'delete-directory') {
          if (!target.exists) {
            results.push({ ...item, outcome: 'missing' })
          } else {
            await rm(target.path, { recursive: item.action === 'delete-directory', force: false, maxRetries: 3, retryDelay: 150 })
            if (await lstatOrNull(target.path)) throw new Error('still exists after delete')
            results.push({ ...item, outcome: 'deleted' })
            logger.info(`Deleted ${item.kind}: ${target.path}`)
          }
          if (item.kind === 'metadata') metadataGone = true
        } else if (!metadataGone) {
          results.push({ ...item, outcome: 'skipped', error: 'Metadata file was not deleted' })
        } else if (item.action === 'update-file') {
          if (!target.exists) {
            results.push({ ...item, outcome: 'missing' })
            continue
          }
          const ids = parseArchiveIndex(await readFile(target.path, 'utf8'))
          if (!ids) throw new Error(`${ARCHIVE_INDEX_FILE} has an unrecognised format`)
          const remove = new Set([desktopSessionId, desktopStem].filter(Boolean))
          await writeFileAtomic(target.path, serializeArchiveIndex(ids.filter((id) => !remove.has(id))))
          results.push({ ...item, outcome: 'updated' })
        } else if (item.action === 'create-file') {
          await writeFileAtomic(target.path, String(Date.now()))
          results.push({ ...item, outcome: 'created' })
          logger.info(`Created tombstone: ${target.path}`)
        }
      } catch (err) {
        logger.error(`Failed ${item.action} ${item.path}: ${errorMessage(err)}`)
        results.push({ ...item, outcome: 'failed', error: errorMessage(err) })
      }
    }

    const failed = results.filter((r) => r.outcome === 'failed' || r.outcome === 'skipped')
    const done = results.filter((r) => r.outcome === 'deleted' || r.outcome === 'created' || r.outcome === 'updated')
    return {
      sessionId: plan.sessionId,
      displayTitle: plan.displayTitle,
      outcome: failed.length === 0 ? 'deleted' : done.length > 0 ? 'partial' : 'failed',
      items: results
    }
  }

  private expirePlans(): void {
    const now = Date.now()
    for (const [token, plan] of this.plans) if (now - plan.createdAt > PLAN_TTL_MS) this.plans.delete(token)
  }
}
