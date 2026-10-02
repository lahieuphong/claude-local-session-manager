import path from 'node:path'
import { RELEASES_URL } from '../../shared/appIdentity'
import { confirmationPhrases } from '../../shared/confirm'
import { IPC } from '../../shared/ipc'
import { INTL_LOCALE, type SupportedLocale } from '../../shared/locale'
import type {
  ActionResult,
  AppInfo,
  AppSettings,
  ArmResult,
  BulkActionResult,
  DeletePlan,
  DeleteResult,
  ExportResult,
  LogEntry,
  SafetyModeState,
  SessionDeletePlan
} from '../../shared/types'
import { assertFormat, assertId, assertIds, assertPlanId, assertString } from '../ipc/validators'
import { formatPlanReport } from '../services/deleteReport'
import { buildPlanItems, keptPaths } from '../services/deleteService'
import { globalGuard, sessionGuard } from '../services/processService'
import { ARM_DURATION_MS } from '../services/safetyMode'
import { DEFAULT_SETTINGS, mergeSettings } from '../services/settingsService'
import { computeStorageInfo } from '../services/storageService'
import { UpdateService } from '../services/updateService'
import { msg, msgText, ref } from '../util/messages'
import { DEMO_HOME, DEMO_USER_DATA, demoHash, screenshotDetails, type ScreenshotFixture } from './fixtures'

/** main → renderer push channels; everything else in IPC is an invoke channel. */
export const PUSH_CHANNELS = [IPC.safetyModeChanged, IPC.updateStateChanged, IPC.sessionsChanged, IPC.scanStateChanged] as const
type IpcChannel = (typeof IPC)[keyof typeof IPC]
export type InvokeChannel = Exclude<IpcChannel, (typeof PUSH_CHANNELS)[number]>
export type ScreenshotHandlers = Record<InvokeChannel, (...args: unknown[]) => unknown>

export const SCREENSHOT_REFUSAL = 'Store screenshot mode shows demo data only: nothing is changed, opened or exported.'

const PLAN_TTL_MS = 15 * 60_000

/**
 * App info shown in Settings. Paths are the fixture's synthetic ones; the
 * distribution is the Microsoft Store build the screenshots are made for
 * (Store packages always carry the Partner Center product ID, see
 * scripts/dist-store.mjs, so "View in Microsoft Store" is shown as there).
 */
export function screenshotAppInfo(o: { name: string; version: string; electronVersion: string; platform: string; locale: SupportedLocale | null }): AppInfo {
  return {
    name: o.name,
    version: o.version,
    isPackaged: false,
    platform: o.platform,
    userDataPath: DEMO_USER_DATA,
    cachePath: path.win32.join(DEMO_USER_DATA, 'scan-cache', 'transcript-index.json'),
    logPath: path.win32.join(DEMO_USER_DATA, 'logs', 'main.log'),
    electronVersion: o.electronVersion,
    systemLanguages: [INTL_LOCALE[o.locale ?? 'en']],
    distribution: 'store',
    storeListingAvailable: true,
    userHome: DEMO_HOME
  }
}

/**
 * Every invoke channel of the real app, answered from the fixture. Reads
 * return demo data; every call that would change, open, export or arm
 * anything is refused. No file system, process or network access.
 */
export function createScreenshotHandlers(opts: { appInfo: AppInfo; fixture: ScreenshotFixture; now?: () => number }): ScreenshotHandlers {
  const { appInfo, fixture } = opts
  const now = opts.now ?? Date.now
  let settings: AppSettings = { ...DEFAULT_SETTINGS }
  const safe: SafetyModeState = { dryRun: true, reason: 'startup', changedAt: fixture.now, armDurationMs: ARM_DURATION_MS }
  // The real Store-channel update state (the Store manages updates; no updater is created).
  const updates = new UpdateService({
    mode: 'store',
    currentVersion: appInfo.version,
    releasesUrl: RELEASES_URL,
    updater: null,
    openExternal: async () => undefined
  })

  // The manager's own records about a session (hidden list, scan cache), as a scan would leave them.
  const planContext = {
    cache: { filePath: appInfo.cachePath, getTranscript: () => ({}), getSubagent: () => undefined },
    hidden: { filePath: path.win32.join(DEMO_USER_DATA, 'manager-hidden.json'), has: () => false }
  } as unknown as NonNullable<Parameters<typeof buildPlanItems>[1]>

  const refused = (): ActionResult => ({ ok: false, code: 'NOT_SUPPORTED', message: SCREENSHOT_REFUSAL })
  const refusedBulk = (): BulkActionResult => ({ ok: false, message: SCREENSHOT_REFUSAL, results: [] })
  const refusedDelete = (): DeleteResult => ({ ok: false, partial: false, dryRun: true, code: 'NOT_SUPPORTED', message: SCREENSHOT_REFUSAL, sessions: [] })
  const refusedExport = (): ExportResult => ({ ok: false, message: SCREENSHOT_REFUSAL, files: [], errors: [] })

  /** The delete preview, built with the app's own plan rules from the demo records. Always a dry run. */
  const createPlan = (ids: string[], bulk: boolean): DeletePlan => {
    const status = fixture.processStatus
    const ok: SessionDeletePlan[] = []
    const blocked: SessionDeletePlan[] = []
    for (const id of ids) {
      const record = fixture.records.get(id)
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
      const { items, warnings, warningMsgs } = buildPlanItems(record, planContext)
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
      const guard = sessionGuard(status, record.guardUuids)
      if (guard) {
        blocked.push({ ...plan, blockedReason: guard.message, blockedMsg: guard.msg, blockedCode: guard.code })
      } else if (!items.some((i) => i.action.startsWith('delete'))) {
        const m = msg('delete.nothingOnDisk')
        blocked.push({ ...plan, blockedReason: m.message, blockedMsg: m.msg, blockedCode: 'NOT_FOUND' })
      } else {
        ok.push(plan)
      }
    }
    const global = globalGuard(status)
    const contentHash = demoHash('plan', JSON.stringify(ok.map((s) => [s.sessionId, s.items.map((i) => [i.kind, i.action, i.path, i.sizeBytes ?? -1])])))
    const createdAt = now()
    const plan: Omit<DeletePlan, 'reportText'> = {
      planId: demoHash('plan-id', contentHash).slice(0, 32),
      contentHash,
      createdAt,
      expiresAt: createdAt + PLAN_TTL_MS,
      dryRun: true,
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

  return {
    [IPC.getAppInfo]: () => appInfo,
    [IPC.getLogs]: (): LogEntry[] => [],

    [IPC.scanSessions]: () => fixture.snapshot,
    [IPC.refreshSessions]: () => fixture.snapshot,
    [IPC.getSession]: (id) => screenshotDetails(fixture, assertId(id)),

    [IPC.archiveSession]: (id) => {
      assertId(id)
      return refused()
    },
    [IPC.restoreSession]: (id) => {
      assertId(id)
      return refused()
    },
    [IPC.bulkArchive]: (ids) => {
      assertIds(ids)
      return refusedBulk()
    },
    [IPC.bulkRestore]: (ids) => {
      assertIds(ids)
      return refusedBulk()
    },
    [IPC.hideSession]: (id) => {
      assertId(id)
      return refused()
    },
    [IPC.unhideSession]: (id) => {
      assertId(id)
      return refused()
    },
    [IPC.bulkHide]: (ids) => {
      assertIds(ids)
      return refusedBulk()
    },
    [IPC.bulkUnhide]: (ids) => {
      assertIds(ids)
      return refusedBulk()
    },

    [IPC.createDeletePlan]: (id) => createPlan([assertId(id)], false),
    [IPC.createBulkDeletePlan]: (ids) => createPlan(assertIds(ids), true),
    [IPC.deleteSession]: (id, confirmation, planId) => {
      assertId(id)
      assertString(confirmation)
      assertPlanId(planId)
      return refusedDelete()
    },
    [IPC.bulkDelete]: (ids, confirmation, planId) => {
      assertIds(ids)
      assertString(confirmation)
      assertPlanId(planId)
      return refusedDelete()
    },

    [IPC.exportSession]: (id, format) => {
      assertId(id)
      assertFormat(format)
      return refusedExport()
    },
    [IPC.exportSessions]: (ids) => {
      assertIds(ids)
      return refusedExport()
    },

    [IPC.revealMetadata]: (id) => {
      assertId(id)
      return refused()
    },
    [IPC.revealTranscript]: (id) => {
      assertId(id)
      return refused()
    },
    [IPC.revealSessionData]: (id) => {
      assertId(id)
      return refused()
    },
    [IPC.openProject]: (id) => {
      assertId(id)
      return refused()
    },

    [IPC.getClaudeProcessStatus]: () => fixture.processStatus,
    [IPC.getStorageInfo]: () => computeStorageInfo(fixture.snapshot, appInfo.cachePath),

    // Kept in memory for this run only (no settings file is read or written).
    [IPC.getSettings]: () => ({ ...settings }),
    [IPC.updateSettings]: (patch) => {
      settings = mergeSettings(settings, patch)
      return { ...settings }
    },
    [IPC.clearCache]: () => refused(),

    // Always SAFE MODE: arming is refused, there is nothing to return from.
    [IPC.getSafetyMode]: () => ({ ...safe }),
    [IPC.armRealDelete]: (confirmation): ArmResult => {
      assertString(confirmation, 40)
      return { ...refused(), state: { ...safe } }
    },
    [IPC.returnToSafeMode]: () => ({ ...safe }),

    [IPC.getUpdateState]: () => updates.getState(),
    [IPC.checkForUpdates]: () => updates.getState(),
    [IPC.downloadUpdate]: () => updates.getState(),
    [IPC.installUpdate]: () => refused(),
    [IPC.openReleasesPage]: () => refused(),
    [IPC.openStoreUpdates]: () => refused(),
    [IPC.openStoreListing]: () => refused()
  }
}
