import { createHash, randomBytes } from 'node:crypto'
import type { ActionErrorCode, DeleteItemResult, DeletePlan, DeletePlanItem, DeleteResult, SessionDeletePlan, SessionDeleteResult } from '../../../shared/types'
import type { MessageParams, MessageRef } from '../../../shared/messages'
import { confirmationPhrases, isConfirmationValid } from '../../../shared/confirm'
import { formatBytes } from '../../../shared/format'
import { lstatOrNull, pathKey } from '../../util/fsx'
import { errorMessage, logger } from '../../util/logger'
import { msg, msgText, ref } from '../../util/messages'
import { formatPlanReport, formatResultReport } from '../deleteReport'
import { contentHashOf, staleMessage } from '../deleteService'
import type { ManagerHiddenStore } from '../managerHiddenStore'
import { codexRefusal, runCodex, type CodexRunner } from './codexActions'
import type { CodexCli } from './codexHomes'
import type { CodexRecord, CodexRepository } from './codexRepository'
import { countHistoryRows, countThreadRows, readSessionIndexIds } from './codexStore'

const DEFAULT_PLAN_TTL_MS = 15 * 60_000

const note = (key: string, params?: MessageParams): { note: string; noteMsg: MessageRef } => ({ note: msgText(key, params), noteMsg: ref(key, params) })

/**
 * What deleting one Codex session does. Codex deletes it itself
 * (`codex delete --force <uuid>`): the session's row and its sub-agents' in its
 * database, the stored conversation, the session files and the index line.
 * This app removes only its own records; it never writes Codex's data.
 */
export function codexPlanItems(record: CodexRecord, hidden?: ManagerHiddenStore): DeletePlanItem[] {
  const items: DeletePlanItem[] = []
  const { home } = record
  if (home.stateDb) {
    items.push({
      kind: 'codex-thread',
      action: 'codex-delete',
      path: home.stateDb,
      ...(record.descendants.length
        ? note('codex.noteThreadWithAgents', { id: record.threadId, count: record.descendants.length })
        : note('codex.noteThread', { id: record.threadId }))
    })
  }
  if (home.historyDb && record.historyItems > 0) {
    items.push({ kind: 'codex-history', action: 'codex-delete', path: home.historyDb, sizeBytes: record.historyBytes, ...note('codex.noteHistory', { count: record.historyItems }) })
  }
  for (const f of record.rolloutFiles) {
    const own = pathKey(f.path) === pathKey(record.session.transcriptFile ?? '')
    items.push({ kind: 'codex-rollout', action: 'codex-delete', path: f.path, sizeBytes: f.size, fileCount: 1, dirCount: 0, ...(own ? {} : note('codex.noteAgentFile')) })
  }
  if (record.inIndex) items.push({ kind: 'codex-index', action: 'codex-delete', path: home.indexFile, ...note('codex.noteIndex') })
  if (hidden?.has(record.managerKey)) {
    items.push({
      kind: 'manager-record',
      action: 'remove-record',
      recordType: 'hidden-list',
      path: hidden.filePath ?? '(manager hidden list, in memory)',
      ...note('delete.noteHiddenRecord', { key: record.managerKey })
    })
  }
  return items
}

interface StoredPlan {
  planId: string
  ids: string[]
  bulk: boolean
  contentHash: string
  threads: Map<string, string>
  targets: string[]
  expiresAt: number
  dryRun: boolean
}

export interface CodexDeleteOptions {
  dryRun: boolean | (() => boolean)
  onRealDeleteExecuted?: (result: DeleteResult) => void
  run?: CodexRunner
  planTtlMs?: number
  appName?: string
  now?: () => number
}

/**
 * Same steps and checks as the Claude delete (deleteService.ts): a single-use
 * plan that expires, the exact confirmation, a fresh scan right before acting,
 * the same Codex session IDs and the same targets as the plan the user read,
 * and Safe Mode. Only the deleting itself is left to Codex, and checked after.
 */
export class CodexDeleteService {
  private plans = new Map<string, StoredPlan>()
  private readonly isDryRun: () => boolean
  private readonly run: CodexRunner
  private readonly now: () => number

  constructor(
    private repo: CodexRepository,
    private options: CodexDeleteOptions
  ) {
    const mode = options.dryRun
    this.isDryRun = typeof mode === 'function' ? mode : () => mode
    this.run = options.run ?? runCodex
    this.now = options.now ?? Date.now
  }

  private sessionPlans(ids: string[]): { ok: SessionDeletePlan[]; blocked: SessionDeletePlan[] } {
    const ok: SessionDeletePlan[] = []
    const blocked: SessionDeletePlan[] = []
    const cli = this.repo.getCli()
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
      const s = record.session
      const items = codexPlanItems(record, this.repo.getHiddenStore())
      const keep = [
        ...(s.projectPath ? [{ path: s.projectPath, reason: msgText('keep.workspace'), reasonMsg: ref('keep.workspace') }] : []),
        { path: record.home.path, reason: msgText('keep.codexHome'), reasonMsg: ref('keep.codexHome') }
      ]
      const plan: SessionDeletePlan = {
        sessionId: id,
        displayTitle: s.displayTitle,
        status: s.status,
        cliSessionId: s.cliSessionId,
        projectName: s.projectName,
        projectPath: s.projectPath,
        items,
        totalBytes: items.reduce((n, i) => n + (i.action === 'codex-delete' ? i.sizeBytes ?? 0 : 0), 0),
        totalFiles: items.filter((i) => i.kind === 'codex-rollout').length,
        totalDirs: 0,
        willNotDelete: keep,
        warnings: [],
        warningMsgs: []
      }
      const refusal = !record.home.stateDb ? { code: 'NOT_FOUND' as ActionErrorCode, ...msg('codex.noDatabase') } : codexRefusal(record, cli)
      if (refusal) blocked.push({ ...plan, blockedReason: refusal.message, blockedMsg: refusal.msg, blockedCode: refusal.code })
      else ok.push(plan)
    }
    return { ok, blocked }
  }

  async createPlan(ids: string[], bulk: boolean): Promise<DeletePlan> {
    this.expirePlans()
    const dryRun = this.isDryRun()
    // Read Codex's data first: the plan (and whether a session may be running) must be of now.
    await this.repo.scan('delete-plan')
    const { ok, blocked } = this.sessionPlans(ids)
    const contentHash = contentHashOf(ok)
    const createdAt = this.now()
    const expiresAt = createdAt + (this.options.planTtlMs ?? DEFAULT_PLAN_TTL_MS)
    const planId = createHash('sha256').update(`${contentHash}|${createdAt}|${randomBytes(16).toString('hex')}`).digest('hex').slice(0, 32)
    this.plans.set(planId, {
      planId,
      ids: ok.map((s) => s.sessionId),
      bulk,
      contentHash,
      threads: new Map(ok.map((s) => [s.sessionId, s.cliSessionId ?? ''])),
      targets: ok.flatMap((s) => s.items.map((i) => i.path)),
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
      totalBytes: ok.reduce((n, s) => n + s.totalBytes, 0),
      totalItems: ok.reduce((n, s) => n + s.items.length, 0),
      totalFiles: ok.reduce((n, s) => n + s.totalFiles, 0),
      totalDirs: 0,
      confirmationPhrases: confirmationPhrases(ok.length, bulk)
    }
    return { ...plan, reportText: formatPlanReport(plan, this.options.appName) }
  }

  async execute(ids: string[], confirmation: unknown, planId: unknown, bulk: boolean): Promise<DeleteResult> {
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
    if (this.now() > stored.expiresAt) {
      this.plans.delete(stored.planId)
      return fail('STALE_PLAN', msg('delete.planExpired'))
    }
    if (stored.bulk !== bulk) return fail('INVALID_INPUT', msg('delete.planTypeMismatch'))
    const sameIds = stored.ids.length === new Set(ids).size && stored.ids.every((id) => ids.includes(id))
    if (!sameIds) return fail('INVALID_INPUT', msg('delete.idsMismatch'))
    if (stored.ids.length === 0) return fail('INVALID_INPUT', msg('delete.nothingToDelete'))
    if (!isConfirmationValid(confirmation, confirmationPhrases(stored.ids.length, bulk))) return fail('INVALID_INPUT', msg('delete.confirmationMismatch'))
    if (stored.dryRun !== dryRun) {
      this.plans.delete(stored.planId)
      const name = (d: boolean): MessageRef => ref(d ? 'delete.modeName.safe' : 'delete.modeName.armed')
      return fail('STALE_PLAN', msg('delete.modeChanged', { from: name(stored.dryRun), to: name(dryRun) }))
    }
    this.plans.delete(stored.planId) // single use

    // Read Codex's data again and rebuild the plan: it must be the one the user read.
    await this.repo.scan('pre-delete')
    const fresh = this.sessionPlans(stored.ids)
    if (fresh.blocked.length) {
      const b = fresh.blocked[0]
      const code = b.blockedCode === 'NOT_FOUND' ? 'STALE_PLAN' : b.blockedCode ?? 'STALE_PLAN'
      return fail(code, msg('delete.sessionBlocked', { title: b.displayTitle, reason: b.blockedMsg ?? b.blockedReason ?? '' }))
    }
    for (const s of fresh.ok) {
      if (stored.threads.get(s.sessionId) !== s.cliSessionId) return fail('STALE_PLAN', msg('delete.identityChanged', { title: s.displayTitle }))
    }
    if (contentHashOf(fresh.ok) !== stored.contentHash) {
      return fail('STALE_PLAN', staleMessage(stored.targets, fresh.ok.flatMap((s) => s.items.map((i) => i.path))))
    }

    if (dryRun) {
      const sessions: SessionDeleteResult[] = fresh.ok.map((s) => ({ sessionId: s.sessionId, displayTitle: s.displayTitle, outcome: 'dry-run', items: s.items.map((i) => ({ ...i, outcome: 'dry-run' })) }))
      const result: DeleteResult = { ok: true, partial: false, dryRun: true, planId: stored.planId, ...msg('delete.dryRunPassed', { count: sessions.length }), sessions }
      result.reportText = formatResultReport(result, fresh.ok, this.options.appName)
      logger.info(`[DRY RUN] Codex delete plan ${stored.planId} validated; nothing changed.\n${result.reportText}`)
      return result
    }

    const results: SessionDeleteResult[] = []
    for (const plan of fresh.ok) results.push(await this.deleteSession(plan))
    await this.repo.scan('post-delete')

    const deleted = results.filter((r) => r.outcome === 'deleted')
    const problems = results.filter((r) => r.outcome === 'partial' || r.outcome === 'failed')
    const freed = results.reduce((n, r) => n + r.items.filter((i) => i.outcome === 'deleted').reduce((m, i) => m + (i.sizeBytes ?? 0), 0), 0)
    const failedItems = problems.reduce((n, r) => n + r.items.filter((i) => i.outcome === 'failed').length, 0)
    const summary =
      problems.length === 0
        ? msg('delete.done', { count: deleted.length, size: formatBytes(freed) })
        : msg('delete.incomplete', { deleted: deleted.length, count: results.length, failed: failedItems })
    const result: DeleteResult = {
      ok: problems.length === 0,
      partial: problems.some((r) => r.outcome === 'partial') || (problems.length > 0 && deleted.length > 0),
      dryRun: false,
      planId: stored.planId,
      ...summary,
      sessions: results
    }
    result.reportText = formatResultReport(result, fresh.ok, this.options.appName)
    logger.info(`Codex delete plan ${stored.planId} executed: ${result.message}`)
    this.options.onRealDeleteExecuted?.(result)
    return result
  }

  private async deleteSession(plan: SessionDeletePlan): Promise<SessionDeleteResult> {
    const record = this.repo.getRecord(plan.sessionId) as CodexRecord
    const cli = this.repo.getCli() as CodexCli
    const run = await this.run(cli, ['delete', '--force', record.threadId], record.home.path)
    logger.info(`codex delete --force ${record.threadId} (${record.home.path}): exit ${run.code} ${run.output}`)
    const commandError = run.code === 0 ? undefined : msgText('codex.commandFailed', { output: run.output || `exit ${run.code}` })

    // Whatever Codex said, check each part of the plan.
    const results: DeleteItemResult[] = []
    const threads = [record.threadId, ...record.descendants]
    for (const item of plan.items.filter((i) => i.action === 'codex-delete')) {
      let gone = false
      let error: string | undefined
      try {
        // The session's row and the rows of the sessions it started: the plan says all of them go.
        if (item.kind === 'codex-thread') gone = countThreadRows(item.path, threads) === 0
        else if (item.kind === 'codex-history') gone = countHistoryRows(item.path, threads) === 0
        else if (item.kind === 'codex-rollout') gone = !(await lstatOrNull(item.path))
        else if (item.kind === 'codex-index') gone = !(await readSessionIndexIds(item.path)).has(record.threadId.toLowerCase())
      } catch (err) {
        error = errorMessage(err)
      }
      if (gone) results.push({ ...item, outcome: 'deleted' })
      else {
        const reason = error ?? commandError ?? msgText('codex.stillThere')
        results.push({ ...item, outcome: 'failed', error: reason })
      }
    }
    const codexFailed = results.some((r) => r.outcome === 'failed')
    for (const item of plan.items.filter((i) => i.kind === 'manager-record')) {
      if (codexFailed) {
        results.push({ ...item, outcome: 'skipped', error: msgText('delete.itemRecordsKept'), errorMsg: ref('delete.itemRecordsKept') })
        continue
      }
      try {
        await this.repo.getHiddenStore().remove([record.managerKey])
        results.push({ ...item, outcome: 'deleted' })
      } catch (err) {
        results.push({ ...item, outcome: 'failed', error: errorMessage(err) })
      }
    }
    const failed = results.filter((r) => r.outcome === 'failed' || r.outcome === 'skipped')
    const done = results.filter((r) => r.outcome === 'deleted')
    return {
      sessionId: plan.sessionId,
      displayTitle: plan.displayTitle,
      outcome: failed.length === 0 ? 'deleted' : done.length > 0 ? 'partial' : 'failed',
      items: results,
      ...(commandError ? { error: commandError } : {})
    }
  }

  private expirePlans(): void {
    const now = this.now()
    for (const [id, plan] of this.plans) if (now > plan.expiresAt) this.plans.delete(id)
  }
}
