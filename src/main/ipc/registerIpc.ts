import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc'
import type { ActionResult, AppInfo, AppSettings, ExportFormat } from '../../shared/types'
import { isDirectory, lstatOrNull } from '../util/fsx'
import { errorMessage, logger } from '../util/logger'
import type { ArchiveService } from '../services/archiveService'
import type { ScanCache } from '../services/cacheService'
import type { DeleteService } from '../services/deleteService'
import type { ExportService } from '../services/exportService'
import type { ProcessService } from '../services/processService'
import { SESSION_ID_RE } from '../services/sessionBuilder'
import type { SessionRepository } from '../services/sessionRepository'
import type { SettingsService } from '../services/settingsService'
import { computeStorageInfo } from '../services/storageService'

export interface IpcContext {
  repo: SessionRepository
  archive: ArchiveService
  deleter: DeleteService
  exporter: ExportService
  processes: ProcessService
  settings: SettingsService
  cache: ScanCache
  appInfo: AppInfo
  onSettingsChanged(settings: AppSettings): void
  isTrustedSender(event: IpcMainInvokeEvent): boolean
}

const MAX_BULK = 5000
const FORMATS: ExportFormat[] = ['jsonl', 'info', 'markdown']

function assertId(v: unknown): string {
  if (typeof v !== 'string' || !SESSION_ID_RE.test(v)) throw new Error('Invalid session id')
  return v
}

function assertIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BULK) throw new Error('Invalid session id list')
  return [...new Set(v.map(assertId))]
}

function assertFormat(v: unknown): ExportFormat {
  if (typeof v !== 'string' || !FORMATS.includes(v as ExportFormat)) throw new Error('Invalid export format')
  return v as ExportFormat
}

function assertString(v: unknown, max = 200): string {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid argument')
  return v
}

async function reveal(p: string | undefined, label: string): Promise<ActionResult> {
  if (!p) return { ok: false, code: 'NOT_FOUND', message: `This session has no ${label}.` }
  if (!(await lstatOrNull(p))) return { ok: false, code: 'NOT_FOUND', message: `The ${label} no longer exists: ${p}` }
  shell.showItemInFolder(p)
  return { ok: true, message: `Revealed ${label} in Explorer.` }
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

  handle(IPC.getAppInfo, () => ctx.appInfo)
  handle(IPC.getLogs, () => logger.getEntries())

  handle(IPC.scanSessions, async () => ctx.repo.getSnapshot() ?? ctx.repo.scan('initial'))
  handle(IPC.refreshSessions, () => ctx.repo.scan('manual'))
  handle(IPC.getSession, (id) => ctx.repo.getDetails(assertId(id)))

  handle(IPC.archiveSession, (id) => ctx.archive.setArchived(assertId(id), true))
  handle(IPC.restoreSession, (id) => ctx.archive.setArchived(assertId(id), false))
  handle(IPC.bulkArchive, (ids) => ctx.archive.bulk(assertIds(ids), true))
  handle(IPC.bulkRestore, (ids) => ctx.archive.bulk(assertIds(ids), false))

  handle(IPC.createDeletePlan, (id) => ctx.deleter.createPlan([assertId(id)], false))
  handle(IPC.deleteSession, (id, confirmation, token) =>
    ctx.deleter.execute([assertId(id)], assertString(confirmation), assertString(token), false)
  )
  handle(IPC.createBulkDeletePlan, (ids) => ctx.deleter.createPlan(assertIds(ids), true))
  handle(IPC.bulkDelete, (ids, confirmation, token) =>
    ctx.deleter.execute(assertIds(ids), assertString(confirmation), assertString(token), true)
  )

  handle(IPC.exportSession, (id, format) => ctx.exporter.exportOne(assertId(id), assertFormat(format)))
  handle(IPC.exportSessions, (ids, formats) => {
    if (!Array.isArray(formats) || formats.length === 0) throw new Error('Choose at least one export format')
    return ctx.exporter.exportMany(assertIds(ids), [...new Set(formats.map(assertFormat))])
  })

  handle(IPC.revealMetadata, (id) => reveal(record(id)?.metadata?.filePath, 'metadata file'))
  handle(IPC.revealTranscript, (id) => reveal(record(id)?.transcript?.filePath, 'transcript'))
  handle(IPC.revealSessionData, (id) => reveal(record(id)?.dataDir?.dirPath, 'session data folder'))
  handle(IPC.openProject, async (id): Promise<ActionResult> => {
    const p = record(id)?.session.projectPath
    if (!p) return { ok: false, code: 'NOT_FOUND', message: 'Project path is unknown for this session.' }
    if (!(await isDirectory(p))) return { ok: false, code: 'NOT_FOUND', message: `Project folder does not exist: ${p}` }
    const err = await shell.openPath(p)
    return err ? { ok: false, code: 'IO_ERROR', message: err } : { ok: true, message: 'Opened project folder.' }
  })

  handle(IPC.getClaudeProcessStatus, (force) => ctx.processes.getStatus(force === true))
  handle(IPC.getStorageInfo, async () => {
    const snapshot = ctx.repo.getSnapshot() ?? (await ctx.repo.scan('storage'))
    return computeStorageInfo(snapshot, ctx.appInfo.cachePath)
  })

  handle(IPC.getSettings, () => ctx.settings.get())
  handle(IPC.updateSettings, async (patch) => {
    const next = await ctx.settings.update(patch)
    ctx.onSettingsChanged(next)
    return next
  })
  handle(IPC.clearCache, async (): Promise<ActionResult> => {
    await ctx.cache.clear()
    await ctx.repo.scan('cache-cleared')
    return { ok: true, message: 'Cache cleared and sessions rescanned.' }
  })
}
