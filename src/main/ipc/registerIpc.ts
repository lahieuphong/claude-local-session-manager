import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc'
import type { ActionResult, AppInfo, AppSettings } from '../../shared/types'
import { isDirectory, lstatOrNull } from '../util/fsx'
import { errorMessage, logger } from '../util/logger'
import { msg } from '../util/messages'
import type { ArchiveService } from '../services/archiveService'
import type { ScanCache } from '../services/cacheService'
import type { DeleteService } from '../services/deleteService'
import type { ExportService } from '../services/exportService'
import type { ProcessService } from '../services/processService'
import type { SafetyModeController } from '../services/safetyMode'
import type { UpdateService } from '../services/updateService'
import { assertFormat, assertId, assertIds, assertPlanId, assertProvider, assertString, assertAccountId } from './validators'
import type { CodexActions } from '../services/codex/codexActions'
import type { CodexDeleteService } from '../services/codex/codexDelete'
import type { CodexExportService } from '../services/codex/codexExport'
import type { CodexRepository } from '../services/codex/codexRepository'
import type { SessionRepository } from '../services/sessionRepository'
import type { SettingsService } from '../services/settingsService'
import { computeStorageInfo } from '../services/storageService'

export interface IpcContext {
  repo: SessionRepository
  archive: ArchiveService
  deleter: DeleteService
  exporter: ExportService
  processes: ProcessService
  safety: SafetyModeController
  updates: UpdateService
  settings: SettingsService
  cache: ScanCache
  appInfo: AppInfo
  /** OpenAI Codex: read from its databases, changed only through the Codex CLI. */
  codex: {
    repo: CodexRepository
    actions: CodexActions
    deleter: CodexDeleteService
    exporter: CodexExportService
  }
  onSettingsChanged(settings: AppSettings): void
  isTrustedSender(event: IpcMainInvokeEvent): boolean
}

async function reveal(p: string | undefined, what: 'metadata' | 'transcript' | 'sessionData'): Promise<ActionResult> {
  if (!p) return { ok: false, code: 'NOT_FOUND', ...msg(`reveal.${what}.none`) }
  if (!(await lstatOrNull(p))) return { ok: false, code: 'NOT_FOUND', ...msg(`reveal.${what}.gone`, { path: p }) }
  shell.showItemInFolder(p)
  return { ok: true, ...msg(`reveal.${what}.done`) }
}

export function registerIpc(ctx: IpcContext): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!ctx.isTrustedSender(event)) throw new Error('Rejected IPC call from an untrusted frame')
      try {
        return await fn(...args)
      } catch (err) {
        logger.error(`IPC ${channel} failed: ${errorMessage(err)}`)
        throw new Error(errorMessage(err))
      }
    })
  }
  const record = (id: unknown) => ctx.repo.getRecord(assertId(id))
  const codex = ctx.codex
  /** A Codex session ID (never also a Claude one: both are hashes of different inputs). */
  const isCodex = (id: string): boolean => codex.repo.has(id)
  /** Every ID of one call is of the same tool. */
  const codexIds = (ids: string[]): boolean => {
    const n = ids.filter(isCodex).length
    if (n > 0 && n < ids.length) throw new Error('Claude and Codex sessions cannot be changed in one call')
    return n > 0
  }
  const snapshotOf = async (provider: unknown) =>
    assertProvider(provider) === 'codex' ? codex.repo.getSnapshot() ?? codex.repo.scan('initial') : ctx.repo.getSnapshot() ?? ctx.repo.scan('initial')

  handle(IPC.getAppInfo, () => ctx.appInfo)
  handle(IPC.getLogs, () => logger.getEntries())

  handle(IPC.scanSessions, (provider) => snapshotOf(provider))
  handle(IPC.refreshSessions, (provider) => (assertProvider(provider) === 'codex' ? codex.repo.scan('manual') : ctx.repo.scan('manual')))
  handle(IPC.getSession, (id) => {
    const sid = assertId(id)
    return isCodex(sid) ? codex.repo.getDetails(sid) : ctx.repo.getDetails(sid)
  })

  const archiveOne = (id: unknown, archived: boolean) => {
    const sid = assertId(id)
    return isCodex(sid) ? codex.actions.setArchived(sid, archived) : ctx.archive.setArchived(sid, archived)
  }
  const archiveMany = (ids: unknown, archived: boolean) => {
    const list = assertIds(ids)
    return codexIds(list) ? codex.actions.bulk(list, archived) : ctx.archive.bulk(list, archived)
  }
  const hideOne = (id: unknown, hidden: boolean) => {
    const sid = assertId(id)
    return isCodex(sid) ? codex.actions.setHidden(sid, hidden) : ctx.archive.setHidden(sid, hidden)
  }
  const hideMany = (ids: unknown, hidden: boolean) => {
    const list = assertIds(ids)
    return codexIds(list) ? codex.actions.bulkHidden(list, hidden) : ctx.archive.bulkHidden(list, hidden)
  }
  handle(IPC.archiveSession, (id) => archiveOne(id, true))
  handle(IPC.restoreSession, (id) => archiveOne(id, false))
  handle(IPC.bulkArchive, (ids) => archiveMany(ids, true))
  handle(IPC.bulkRestore, (ids) => archiveMany(ids, false))
  handle(IPC.hideSession, (id) => hideOne(id, true))
  handle(IPC.unhideSession, (id) => hideOne(id, false))
  handle(IPC.bulkHide, (ids) => hideMany(ids, true))
  handle(IPC.bulkUnhide, (ids) => hideMany(ids, false))

  const deleterFor = (ids: string[]) => (codexIds(ids) ? codex.deleter : ctx.deleter)
  handle(IPC.createDeletePlan, (id) => {
    const ids = [assertId(id)]
    return deleterFor(ids).createPlan(ids, false)
  })
  handle(IPC.deleteSession, (id, confirmation, planId) => {
    const ids = [assertId(id)]
    return deleterFor(ids).execute(ids, assertString(confirmation), assertPlanId(planId), false)
  })
  handle(IPC.createBulkDeletePlan, (ids) => {
    const list = assertIds(ids)
    return deleterFor(list).createPlan(list, true)
  })
  handle(IPC.bulkDelete, (ids, confirmation, planId) => {
    const list = assertIds(ids)
    return deleterFor(list).execute(list, assertString(confirmation), assertPlanId(planId), true)
  })

  handle(IPC.exportSession, (id, format) => {
    const sid = assertId(id)
    return isCodex(sid) ? codex.exporter.exportOne(sid, assertFormat(format)) : ctx.exporter.exportOne(sid, assertFormat(format))
  })
  handle(IPC.exportSessions, (ids, formats) => {
    if (!Array.isArray(formats) || formats.length === 0) throw new Error('Choose at least one export format')
    const list = assertIds(ids)
    const chosen = [...new Set(formats.map(assertFormat))]
    return codexIds(list) ? codex.exporter.exportMany(list, chosen) : ctx.exporter.exportMany(list, chosen)
  })

  const codexRecord = (id: unknown) => codex.repo.getRecord(assertId(id))
  handle(IPC.revealMetadata, (id) => reveal(codexRecord(id) ? undefined : record(id)?.metadata?.filePath, 'metadata'))
  handle(IPC.revealTranscript, (id) => reveal(codexRecord(id)?.session.transcriptFile ?? record(id)?.transcript?.filePath, 'transcript'))
  handle(IPC.revealSessionData, (id) => reveal(codexRecord(id) ? undefined : record(id)?.dataDir?.dirPath, 'sessionData'))
  handle(IPC.openProject, async (id): Promise<ActionResult> => {
    const p = (codexRecord(id) ?? record(id))?.session.projectPath
    if (!p) return { ok: false, code: 'NOT_FOUND', ...msg('project.unknownPath') }
    if (!(await isDirectory(p))) return { ok: false, code: 'NOT_FOUND', ...msg('project.missingFolder', { path: p }) }
    const err = await shell.openPath(p)
    return err ? { ok: false, code: 'IO_ERROR', message: err } : { ok: true, ...msg('project.opened') }
  })

  handle(IPC.getClaudeProcessStatus, (force) => ctx.processes.getStatus(force === true))
  handle(IPC.getStorageInfo, async (accountId, provider) => {
    const id = assertAccountId(accountId)
    const snapshot = await snapshotOf(provider)
    return computeStorageInfo(id ? { ...snapshot, sessions: snapshot.sessions.filter((s) => s.accountIds.includes(id)) } : snapshot, ctx.appInfo.cachePath)
  })

  handle(IPC.getSettings, () => ctx.settings.get())
  handle(IPC.updateSettings, async (patch) => {
    const next = await ctx.settings.update(patch)
    ctx.onSettingsChanged(next)
    return next
  })
  handle(IPC.getSafetyMode, () => ctx.safety.getState())
  handle(IPC.armRealDelete, (confirmation) => ctx.safety.arm(assertString(confirmation, 40)))
  handle(IPC.returnToSafeMode, () => ctx.safety.disarm('returned-by-user'))

  // Updates: argument-free; URLs and installer files come only from the build's app-update.yml.
  handle(IPC.getUpdateState, () => ctx.updates.getState())
  handle(IPC.checkForUpdates, () => ctx.updates.check('manual'))
  handle(IPC.downloadUpdate, () => ctx.updates.download())
  handle(IPC.installUpdate, () => ctx.updates.install())
  handle(IPC.openReleasesPage, () => ctx.updates.openReleasesPage())
  // Store: argument-free too; the ms-windows-store URIs are fixed in the main process.
  handle(IPC.openStoreUpdates, () => ctx.updates.openStoreUpdates())
  handle(IPC.openStoreListing, () => ctx.updates.openStoreListing())

  handle(IPC.clearCache, async (): Promise<ActionResult> => {
    await ctx.cache.clear()
    await ctx.repo.scan('cache-cleared')
    return { ok: true, ...msg('cache.cleared') }
  })
}
