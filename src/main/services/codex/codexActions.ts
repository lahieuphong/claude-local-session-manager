import { execFile } from 'node:child_process'
import type { ActionErrorCode, ActionResult, BulkActionResult } from '../../../shared/types'
import type { MessageRef } from '../../../shared/messages'
import { UUID_RE } from '../../util/fsx'
import { errorMessage, logger } from '../../util/logger'
import { msg, ref } from '../../util/messages'
import type { CodexCli } from './codexHomes'
import { CODEX_RECENT_MS, type CodexRecord, type CodexRepository } from './codexRepository'
import { readThreadState } from './codexStore'

export interface CodexRun {
  /** Exit code; null when Codex could not be started or was stopped. */
  code: number | null
  output: string
}

export type CodexRunner = (cli: CodexCli, args: string[], codexHome: string) => Promise<CodexRun>

/**
 * Run the Codex CLI on one Codex folder. The executable is run directly (no
 * shell), with CODEX_HOME set to that folder, and only ever with a session UUID
 * that came from Codex's own database.
 */
export const runCodex: CodexRunner = (cli, args, codexHome) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome }
    delete env.ELECTRON_RUN_AS_NODE
    execFile(
      cli.command,
      [...cli.args, ...args],
      { cwd: codexHome, env, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = !err ? 0 : typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : null
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim() || (err ? errorMessage(err) : '')
        resolve({ code, output: output.slice(0, 2000) })
      }
    )
  })

export interface Refusal {
  code: ActionErrorCode
  message: string
  msg: MessageRef
}

/** Why Codex must not change this session now, if it must not (`live`: see CODEX_RECENT_MS). */
export function codexRefusal(record: CodexRecord, cli: CodexCli | null): Refusal | null {
  if (!cli) return { code: 'NOT_SUPPORTED', ...msg('codex.cliMissing') }
  if (!UUID_RE.test(record.threadId)) return { code: 'INVALID_INPUT', ...msg('codex.badId') }
  if (record.session.live) return { code: 'SESSION_IN_USE', ...msg('codex.recentlyActive', { minutes: Math.round(CODEX_RECENT_MS / 60_000) }) }
  return null
}

/**
 * Archive / restore through Codex's own `codex archive` and `codex unarchive`
 * (Codex moves the session file and sets its flag), and the manager's own
 * hide / show, which never touches Codex's data.
 */
export class CodexActions {
  constructor(
    private repo: CodexRepository,
    dryRun: boolean | (() => boolean),
    private run: CodexRunner = runCodex
  ) {
    this.isDryRun = typeof dryRun === 'function' ? dryRun : () => dryRun
  }

  private readonly isDryRun: () => boolean

  /**
   * `fresh: false` only when the caller has just read Codex's data (a bulk action reads it
   * once). Otherwise it is read again first: what is on screen may be minutes old, and the
   * session may have been resumed since.
   */
  async setArchived(id: string, archived: boolean, opts: { rescan?: boolean; fresh?: boolean } = {}): Promise<ActionResult> {
    if (opts.fresh !== false) await this.repo.scan('pre-archive')
    const record = this.repo.getRecord(id)
    if (!record) return { ok: false, code: 'NOT_FOUND', ...msg('common.sessionNotFound') }
    if (record.session.archived === archived) return { ok: true, ...msg(archived ? 'codex.alreadyArchived' : 'codex.alreadyActive') }
    const refusal = codexRefusal(record, this.repo.getCli())
    if (refusal) return { ok: false, ...refusal }
    if (this.isDryRun()) return { ok: true, dryRun: true, ...msg(archived ? 'codex.archiveDryRun' : 'codex.restoreDryRun') }
    const cli = this.repo.getCli() as CodexCli
    const stateDb = record.home.stateDb
    const result = await this.run(cli, [archived ? 'archive' : 'unarchive', record.threadId], record.home.path)
    logger.info(`codex ${archived ? 'archive' : 'unarchive'} ${record.threadId} (${record.home.path}): exit ${result.code} ${result.output}`)
    if (result.code !== 0) return { ok: false, code: 'IO_ERROR', ...msg('codex.commandFailed', { output: result.output || `exit ${result.code}` }) }
    // Codex said it did it: check in its database that it really did.
    try {
      if (stateDb && readThreadState(stateDb, record.threadId).archived !== archived) {
        return { ok: false, code: 'IO_ERROR', ...msg('codex.notApplied') }
      }
    } catch (err) {
      return { ok: false, code: 'IO_ERROR', ...msg('codex.commandFailed', { output: errorMessage(err) }) }
    }
    if (opts.rescan !== false) await this.repo.scan(archived ? 'archive' : 'restore')
    return { ok: true, ...msg(archived ? 'codex.archived' : 'codex.restored') }
  }

  async setHidden(id: string, hidden: boolean, opts: { rescan?: boolean } = {}): Promise<ActionResult> {
    const record = this.repo.getRecord(id)
    if (!record) return { ok: false, code: 'NOT_FOUND', ...msg('common.sessionNotFound') }
    try {
      await this.repo.getHiddenStore().set(record.managerKey, hidden)
    } catch (err) {
      return { ok: false, code: 'IO_ERROR', ...msg('hide.saveFailed', { error: errorMessage(err) }) }
    }
    if (opts.rescan !== false) await this.repo.scan(hidden ? 'hide' : 'unhide')
    return { ok: true, ...msg(hidden ? 'codex.hidden' : 'hide.shown') }
  }

  async bulk(ids: string[], archived: boolean): Promise<BulkActionResult> {
    await this.repo.scan('pre-archive')
    return this.runBulk(ids, (id) => this.setArchived(id, archived, { rescan: false, fresh: false }), archived ? 'archived' : 'restored', (r) => r.ok && !r.dryRun)
  }

  bulkHidden(ids: string[], hidden: boolean): Promise<BulkActionResult> {
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
