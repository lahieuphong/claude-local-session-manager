import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  ActionErrorCode,
  DeleteItemResult,
  DeletePlan,
  DeletePlanItem,
  DeleteResult,
  ProcessStatus,
  SessionDeletePlan,
  SessionDeleteResult
} from '../../shared/types'
import { confirmationPhrases, isConfirmationValid } from '../../shared/confirm'
import { formatBytes } from '../../shared/format'
import {
  assertNotProtected,
  PathRejectedError,
  validateTarget,
  type AllowedRoots,
  type ClaudeTargetKind
} from '../security/pathValidator'
import { writeFileAtomic } from '../util/atomicWrite'
import { SAFE_ID_RE, lstatOrNull, pathKey } from '../util/fsx'
import { errorMessage, logger } from '../util/logger'
import { msg, msgText, ref } from '../util/messages'
import type { MessageParams, MessageRef } from '../../shared/messages'
import type { ScanCache } from './cacheService'
import { formatPlanReport, formatResultReport } from './deleteReport'
import type { ManagerHiddenStore } from './managerHiddenStore'
import { ARCHIVE_INDEX_FILE, TOMBSTONE_PREFIX, parseArchiveIndex, serializeArchiveIndex } from './metadataParser'
import { globalGuard, sessionGuard, type ProcessService } from './processService'
import type { SessionRecord } from './sessionBuilder'
import type { SessionRepository } from './sessionRepository'

export interface DeleteServiceOptions {
  /** Current mode. A function lets the in-app safety switch change it at runtime. */
  dryRun: boolean | (() => boolean)
  /** Called after a real (non-dry-run) delete executed (fully or partially). */
  onRealDeleteExecuted?: (result: DeleteResult) => void
  /** Refuse to delete a transcript written to within this window (it may be in use). */
  recentWriteMs?: number
  planTtlMs?: number
}

const DEFAULT_RECENT_WRITE_MS = 30_000
const DEFAULT_PLAN_TTL_MS = 15 * 60_000

interface PlanContext {
  cache: ScanCache
  hidden: ManagerHiddenStore
}

/**
 * Exact list of what deleting one session does, in execution order. Built
 * only from the scanner registry; nothing is globbed or guessed, and the
 * source workspace is never part of it.
 */
export function buildPlanItems(
  record: SessionRecord,
  ctx?: PlanContext
): { items: DeletePlanItem[]; warnings: string[]; warningMsgs: MessageRef[] } {
  const items: DeletePlanItem[] = []
  const warnings: string[] = []
  const warningMsgs: MessageRef[] = []
  const warn = (key: string, params: MessageParams): void => {
    warnings.push(msgText(key, params))
    warningMsgs.push(ref(key, params))
  }
  const note = (key: string, params?: MessageParams): { note: string; noteMsg: MessageRef } => ({
    note: msgText(key, params),
    noteMsg: ref(key, params)
  })
  const meta = record.metadata

  if (meta) {
    items.push({ kind: 'metadata', action: 'delete-file', path: meta.filePath, sizeBytes: meta.size, fileCount: 1, dirCount: 0 })

    const idx = record.storageDir?.archiveIndex
    if (idx?.ids?.includes(meta.sessionId)) {
      items.push({
        kind: 'archive-index',
        action: 'update-file',
        path: idx.path,
        ...note('delete.noteArchiveIndex', { id: meta.sessionId })
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
        ...note('delete.noteTombstone')
      })
    }
  }

  const transcripts = [record.transcript, ...record.extraTranscripts].filter(
    (t): t is NonNullable<typeof t> => !!t && !record.sharedTranscripts.includes(t)
  )
  for (const t of [...new Set(transcripts)]) {
    items.push({ kind: 'transcript', action: 'delete-file', path: t.filePath, sizeBytes: t.size, fileCount: 1, dirCount: 0 })
  }
  for (const t of record.sharedTranscripts) warn('delete.warnSharedTranscript', { path: t.filePath })
  for (const log of record.legacySubagentLogs) {
    items.push({ kind: 'subagent-log', action: 'delete-file', path: log.filePath, sizeBytes: log.size, fileCount: 1, dirCount: 0 })
  }
  for (const d of [record.dataDir, ...record.extraDataDirs]) {
    if (!d) continue
    items.push({
      kind: 'session-data',
      action: 'delete-directory',
      path: d.dirPath,
      sizeBytes: d.bytes,
      fileCount: d.files,
      dirCount: d.dirs + 1,
      ...(d === record.dataDir ? {} : note('delete.noteOtherFolder'))
    })
    if (d.links) warn('delete.warnLinks', { count: d.links, path: d.dirPath })
  }
  for (const [kind, dir] of [
    ['file-history', record.fileHistoryDir],
    ['session-env', record.sessionEnvDir]
  ] as const) {
    if (!dir) continue
    items.push({ kind, action: 'delete-directory', path: dir.dirPath, sizeBytes: dir.bytes, fileCount: dir.files, dirCount: dir.dirs + 1 })
  }

  // The manager's own records about this session (never Claude files).
  if (ctx) {
    if (record.managerKey && ctx.hidden.has(record.managerKey)) {
      items.push({
        kind: 'manager-record',
        action: 'remove-record',
        recordType: 'hidden-list',
        path: ctx.hidden.filePath ?? '(manager hidden list, in memory)',
        ...note('delete.noteHiddenRecord', { key: record.managerKey })
      })
    }
    for (const file of [...transcripts.map((t) => t.filePath), ...record.legacySubagentLogs.map((l) => l.filePath)]) {
      if (!ctx.cache.getTranscript(file) && !ctx.cache.getSubagent(file)) continue
      items.push({
        kind: 'manager-record',
        action: 'remove-record',
        recordType: 'scan-cache',
        path: ctx.cache.filePath ?? '(manager scan cache, in memory)',
        ...note('delete.noteCacheRecord', { file: path.basename(file) })
      })
    }
  }
  return { items, warnings, warningMsgs }
}

/** Paths shown under WILL NOT DELETE for a session. */
export function keptPaths(record: SessionRecord): Array<{ path: string; reason: string; reasonMsg: MessageRef }> {
  const out: Array<{ path: string; reason: string; reasonMsg: MessageRef }> = []
  const seen = new Set<string>()
  const add = (p: string | undefined, key: string): void => {
    if (!p || seen.has(pathKey(p))) return
    seen.add(pathKey(p))
    out.push({ path: p, reason: msgText(key), reasonMsg: ref(key) })
  }
  for (const w of record.workspacePaths) add(w, 'keep.workspace')
  const storage = record.transcript?.projectDir ?? record.dataDir?.projectDir
  add(storage, 'keep.projectFolder')
  if (storage) add(path.join(storage, 'memory'), 'keep.memory')
  if (record.metadata) add(record.metadata.storageDir, 'keep.desktopFolder')
  return out
}

function contentHashOf(sessions: SessionDeletePlan[]): string {
  const data = sessions.map((s) => [
    s.sessionId,
    s.cliSessionId ?? null,
    s.desktopSessionId ?? null,
    s.items.map((i) => [i.kind, i.action, pathKey(i.path), i.sizeBytes ?? -1, i.fileCount ?? -1, i.dirCount ?? -1, i.note ?? ''])
  ])
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

/** Why a plan is stale: which targets appeared or disappeared, or only their contents changed. */
function staleMessage(before: string[], after: string[]): { message: string; msg: MessageRef } {
  const a = new Set(before)
  const b = new Set(after)
  const added = [...b].filter((x) => !a.has(x)).join(', ')
  const removed = [...a].filter((x) => !b.has(x)).join(', ')
  if (!added && !removed) return msg('delete.staleContent')
  const changes = added && removed ? ref('delete.diffBoth', { added, removed }) : added ? ref('delete.diffAdded', { added }) : ref('delete.diffRemoved', { removed })
  return msg('delete.staleTargets', { changes })
}

interface StoredPlan {
  planId: string
  ids: string[]
  bulk: boolean
  contentHash: string
  identities: Map<string, { cli?: string; desktop?: string }>
  targets: string[]
  createdAt: number
  expiresAt: number
  /** Mode the plan was previewed in; execution must happen in the same mode. */
  dryRun: boolean
}

export class DeleteService {
  private plans = new Map<string, StoredPlan>()
  private readonly isDryRun: () => boolean
  private readonly recentWriteMs: number
  private readonly planTtlMs: number
  private readonly onRealDeleteExecuted?: (result: DeleteResult) => void

  constructor(
    private repo: SessionRepository,
    private processes: ProcessService,
    options: DeleteServiceOptions | boolean
  ) {
    const o: DeleteServiceOptions = typeof options === 'boolean' ? { dryRun: options } : options
    const mode = o.dryRun
    this.isDryRun = typeof mode === 'function' ? mode : () => mode
    this.recentWriteMs = o.recentWriteMs ?? DEFAULT_RECENT_WRITE_MS
    this.planTtlMs = o.planTtlMs ?? DEFAULT_PLAN_TTL_MS
    this.onRealDeleteExecuted = o.onRealDeleteExecuted
  }

  /** Workspaces, approved roots, home and drive roots: never a target, never inside a target. */
  private protectedPaths(): string[] {
    const roots = this.repo.getRoots()
    const list = [
      ...this.repo.getWorkspacePaths(),
      roots?.claudeHome,
      roots?.projectsRoot,
      roots?.fileHistoryRoot,
      roots?.sessionEnvRoot,
      roots?.liveSessionsDir,
      ...(roots?.desktopRoots.map((d) => d.path) ?? []),
      os.homedir(),
      process.env.USERPROFILE
    ]
    return list.filter((p): p is string => !!p)
  }

  private sessionPlans(ids: string[], status: ProcessStatus): { ok: SessionDeletePlan[]; blocked: SessionDeletePlan[] } {
    const ok: SessionDeletePlan[] = []
    const blocked: SessionDeletePlan[] = []
    const protectedPaths = this.protectedPaths()
    const ctx: PlanContext = { cache: this.repo.getCache(), hidden: this.repo.getHiddenStore() }
    for (const id of [...new Set(ids)]) {
      const record = this.repo.getRecord(id)
      if (!record) {
        blocked.push({
          sessionId: id,
          displayTitle: '(unknown session)',
          status: 'orphan',
          projectName: '',
          items: [],
          totalBytes: 0,
          totalFiles: 0,
          totalDirs: 0,
          willNotDelete: [],
          warnings: [],
          blockedReason: msgText('common.sessionNotFound'),
          blockedMsg: ref('common.sessionNotFound'),
          blockedCode: 'NOT_FOUND'
        })
        continue
      }
      const { items, warnings, warningMsgs } = buildPlanItems(record, ctx)
      const s = record.session
      const plan: SessionDeletePlan = {
        sessionId: id,
        displayTitle: s.displayTitle,
        status: s.status,
        cliSessionId: s.cliSessionId,
        desktopSessionId: s.desktopSessionId,
        projectName: s.projectName,
        projectPath: s.projectPath,
        items,
        totalBytes: items.reduce((n, i) => n + (i.action.startsWith('delete') ? i.sizeBytes ?? 0 : 0), 0),
        totalFiles: items.reduce((n, i) => n + (i.action.startsWith('delete') ? i.fileCount ?? 0 : 0), 0),
        totalDirs: items.reduce((n, i) => n + (i.action === 'delete-directory' ? i.dirCount ?? 1 : 0), 0),
        willNotDelete: keptPaths(record),
        warnings,
        warningMsgs
      }
      const block = (code: ActionErrorCode, reason: string, reasonMsg?: MessageRef): void => {
        blocked.push({ ...plan, blockedReason: reason, blockedMsg: reasonMsg, blockedCode: code })
      }
      const guard = sessionGuard(status, record.guardUuids)
      if (guard) {
        block(guard.code, guard.message, guard.msg)
        continue
      }
      const ageMs = record.transcript ? Date.now() - record.transcript.mtimeMs : Infinity
      if (ageMs < this.recentWriteMs) {
        const m = msg('delete.recentlyWritten', { seconds: Math.round(ageMs / 1000) })
        block('RECENTLY_WRITTEN', m.message, m.msg)
        continue
      }
      if (!items.some((i) => i.action.startsWith('delete'))) {
        const m = msg('delete.nothingOnDisk')
        block('NOT_FOUND', m.message, m.msg)
        continue
      }
      try {
        for (const i of items) if (i.kind !== 'manager-record') assertNotProtected(i.path, protectedPaths)
      } catch (err) {
        // Path validator text is technical (exact paths); shown as-is.
        block('PROTECTED_PATH', errorMessage(err))
        continue
      }
      ok.push(plan)
    }
    return { ok, blocked }
  }

  /** Build the preview shown in the confirmation modal. Read-only. */
  async createPlan(ids: string[], bulk: boolean): Promise<DeletePlan> {
    this.expirePlans()
    const dryRun = this.isDryRun()
    const status = await this.processes.getStatus(true)
    const { ok, blocked } = this.sessionPlans(ids, status)
    const global = globalGuard(status)
    const contentHash = contentHashOf(ok)
    const createdAt = Date.now()
    const expiresAt = createdAt + this.planTtlMs
    const planId = createHash('sha256').update(`${contentHash}|${createdAt}|${randomBytes(16).toString('hex')}`).digest('hex').slice(0, 32)
    this.plans.set(planId, {
      planId,
      ids: ok.map((s) => s.sessionId),
      bulk,
      contentHash,
      identities: new Map(ok.map((s) => [s.sessionId, { cli: s.cliSessionId, desktop: s.desktopSessionId }])),
      targets: ok.flatMap((s) => s.items.map((i) => i.path)),
      createdAt,
      expiresAt,
      dryRun
    })
    const plan: Omit<DeletePlan, 'reportText'> = {
      planId,
      contentHash,
      createdAt,
      expiresAt,
      dryRun,
      bulk,
      sessions: ok,
      blocked,
      globalBlockedReason: global?.message,
      globalBlockedMsg: global?.msg,
      globalBlockedCode: global?.code,
      totalBytes: ok.reduce((n, s) => n + s.totalBytes, 0),
      totalItems: ok.reduce((n, s) => n + s.items.length, 0),
      totalFiles: ok.reduce((n, s) => n + s.totalFiles, 0),
      totalDirs: ok.reduce((n, s) => n + s.totalDirs, 0),
      confirmationPhrases: confirmationPhrases(ok.length, bulk)
    }
    return { ...plan, reportText: formatPlanReport(plan) }
  }

  /**
   * Execute (or, in DRY RUN, fully validate and log) a previously created plan.
   * The renderer supplies only session IDs, the plan ID and the typed confirmation.
   */
  async execute(ids: string[], confirmation: unknown, planId: unknown, bulk: boolean): Promise<DeleteResult> {
    // The mode is read once; the whole operation runs in that mode.
    const dryRun = this.isDryRun()
    const fail = (code: ActionErrorCode, m: { message: string; msg?: MessageRef }): DeleteResult => ({
      ok: false,
      partial: false,
      dryRun,
      code,
      message: m.message,
      msg: m.msg,
      planId: typeof planId === 'string' ? planId : undefined,
      sessions: []
    })
    const stored = typeof planId === 'string' ? this.plans.get(planId) : undefined
    if (!stored) return fail('INVALID_INPUT', msg('delete.unknownPlan'))
    if (Date.now() > stored.expiresAt) {
      this.plans.delete(stored.planId)
      return fail('STALE_PLAN', msg('delete.planExpired'))
    }
    if (stored.bulk !== bulk) return fail('INVALID_INPUT', msg('delete.planTypeMismatch'))
    const sameIds = stored.ids.length === new Set(ids).size && stored.ids.every((id) => ids.includes(id))
    if (!sameIds) return fail('INVALID_INPUT', msg('delete.idsMismatch'))
    if (stored.ids.length === 0) return fail('INVALID_INPUT', msg('delete.nothingToDelete'))
    if (!isConfirmationValid(confirmation, confirmationPhrases(stored.ids.length, bulk))) {
      return fail('INVALID_INPUT', msg('delete.confirmationMismatch'))
    }
    if (stored.dryRun !== dryRun) {
      this.plans.delete(stored.planId)
      const name = (d: boolean): MessageRef => ref(d ? 'delete.modeName.safe' : 'delete.modeName.armed')
      return fail('STALE_PLAN', msg('delete.modeChanged', { from: name(stored.dryRun), to: name(dryRun) }))
    }
    this.plans.delete(stored.planId) // single use

    // 1. Process safety.
    const status = await this.processes.getStatus(true)
    const global = globalGuard(status)
    if (global && !dryRun) return fail(global.code, global)

    // 2. Re-scan and rebuild the plan from scratch.
    await this.repo.scan('pre-delete')
    const roots = this.repo.getAllowedRoots()
    if (!roots) return fail('IO_ERROR', msg('delete.rootsUnavailable'))
    const fresh = this.sessionPlans(stored.ids, status)
    if (fresh.blocked.length) {
      const b = fresh.blocked[0]
      const code = b.blockedCode === 'NOT_FOUND' ? 'STALE_PLAN' : b.blockedCode ?? 'STALE_PLAN'
      return fail(code, msg('delete.sessionBlocked', { title: b.displayTitle, reason: b.blockedMsg ?? b.blockedReason ?? '' }))
    }

    // 3. Identity: the same Claude session IDs as when the plan was shown.
    for (const s of fresh.ok) {
      const before = stored.identities.get(s.sessionId)
      if (!before || before.cli !== s.cliSessionId || before.desktop !== s.desktopSessionId) {
        return fail('STALE_PLAN', msg('delete.identityChanged', { title: s.displayTitle }))
      }
    }

    // 4. Content: exactly the targets the user reviewed — nothing new, nothing changed.
    if (contentHashOf(fresh.ok) !== stored.contentHash) {
      const after = fresh.ok.flatMap((s) => s.items.map((i) => i.path))
      return fail('STALE_PLAN', staleMessage(stored.targets, after))
    }

    // 5. Validate every target before touching anything.
    const protectedPaths = this.protectedPaths()
    for (const s of fresh.ok) {
      for (const item of s.items) {
        if (item.kind === 'manager-record') continue
        try {
          await validateTarget(item.path, item.kind as ClaudeTargetKind, roots)
          assertNotProtected(item.path, protectedPaths)
        } catch (err) {
          const code: ActionErrorCode = err instanceof PathRejectedError ? 'PATH_REJECTED' : 'IO_ERROR'
          logger.error(`Delete refused (${s.sessionId}): ${errorMessage(err)}`)
          return fail(code, msg('delete.refused', { error: errorMessage(err) }))
        }
      }
    }

    // 6. DRY RUN stops here: everything validated, nothing mutated.
    if (dryRun) {
      const sessions: SessionDeleteResult[] = fresh.ok.map((s) => ({
        sessionId: s.sessionId,
        displayTitle: s.displayTitle,
        outcome: 'dry-run',
        items: s.items.map((i) => ({ ...i, outcome: 'dry-run' }))
      }))
      const result: DeleteResult = {
        ok: !global,
        partial: false,
        dryRun: true,
        planId: stored.planId,
        wouldBeBlocked: global?.message,
        wouldBeBlockedMsg: global?.msg,
        code: global?.code,
        ...(global
          ? msg('delete.dryRunBlocked', { count: sessions.length, reason: global.msg })
          : msg('delete.dryRunPassed', { count: sessions.length })),
        sessions
      }
      result.reportText = formatResultReport(result, fresh.ok)
      logger.info(`[DRY RUN] delete plan ${stored.planId} validated; no files modified.\n${result.reportText}`)
      return result
    }

    // 7. Execute.
    const results: SessionDeleteResult[] = []
    for (const plan of fresh.ok) results.push(await this.deleteSession(plan, roots, protectedPaths))
    await this.repo.getCache().save()
    await this.repo.scan('post-delete')

    const deleted = results.filter((r) => r.outcome === 'deleted')
    const problems = results.filter((r) => r.outcome === 'partial' || r.outcome === 'failed')
    const freed = results.reduce(
      (n, r) => n + r.items.filter((i) => i.outcome === 'deleted').reduce((m, i) => m + (i.sizeBytes ?? 0), 0),
      0
    )
    const failedItems = problems.reduce((n, r) => n + r.items.filter((i) => i.outcome === 'failed').length, 0)
    const summary =
      problems.length === 0
        ? msg('delete.done', { count: deleted.length, size: formatBytes(freed) })
        : msg('delete.incomplete', { deleted: deleted.length, count: results.length, failed: failedItems })
    const message = summary.message
    const result: DeleteResult = {
      ok: problems.length === 0,
      partial: problems.some((r) => r.outcome === 'partial') || (problems.length > 0 && deleted.length > 0),
      dryRun: false,
      planId: stored.planId,
      message,
      msg: summary.msg,
      sessions: results
    }
    result.reportText = formatResultReport(result, fresh.ok)
    logger.info(`Delete plan ${stored.planId} executed: ${message}`)
    this.onRealDeleteExecuted?.(result)
    return result
  }

  private async deleteSession(plan: SessionDeletePlan, roots: AllowedRoots, protectedPaths: string[]): Promise<SessionDeleteResult> {
    const record = this.repo.getRecord(plan.sessionId)
    const meta = record?.metadata
    const results: DeleteItemResult[] = []
    let metadataGone = !plan.items.some((i) => i.kind === 'metadata')
    for (const item of plan.items) {
      if (item.kind === 'manager-record') continue // handled after the Claude files
      try {
        // Re-validate immediately before each operation (TOCTOU).
        const target = await validateTarget(item.path, item.kind as ClaudeTargetKind, roots)
        assertNotProtected(target.path, protectedPaths)
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
          results.push({ ...item, outcome: 'skipped', error: msgText('delete.itemMetadataKept'), errorMsg: ref('delete.itemMetadataKept') })
        } else if (item.action === 'update-file') {
          if (!target.exists) {
            results.push({ ...item, outcome: 'missing' })
            continue
          }
          const ids = parseArchiveIndex(await readFile(target.path, 'utf8'))
          if (!ids) throw new Error(`${ARCHIVE_INDEX_FILE} has an unrecognised format`)
          const remove = new Set([meta?.sessionId, meta?.stem].filter(Boolean))
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

    const claudeFailed = results.some((r) => r.outcome === 'failed' || r.outcome === 'skipped')
    // Manager records: drop them only once the session's Claude files are gone.
    for (const item of plan.items.filter((i) => i.kind === 'manager-record')) {
      if (claudeFailed) {
        results.push({ ...item, outcome: 'skipped', error: msgText('delete.itemRecordsKept'), errorMsg: ref('delete.itemRecordsKept') })
        continue
      }
      try {
        if (item.recordType === 'hidden-list' && record?.managerKey) {
          await this.repo.getHiddenStore().remove([record.managerKey])
        } else if (record) {
          const files = [record.transcript, ...record.extraTranscripts].map((t) => t?.filePath)
          const logs = record.legacySubagentLogs.map((l) => l.filePath)
          this.repo.getCache().forget([...files, ...logs].filter((f): f is string => !!f))
        }
        results.push({ ...item, outcome: 'deleted' })
      } catch (err) {
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
    for (const [id, plan] of this.plans) if (now > plan.expiresAt) this.plans.delete(id)
  }
}
