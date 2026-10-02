import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Every file-system and child-process function is wrapped so a test fails if
// screenshot mode touches the disk or starts a process (calls are recorded).
const { calls, trap } = vi.hoisted(() => {
  const calls: string[] = []
  const trap = (mod: Record<string, unknown>, name: string): Record<string, unknown> => {
    const wrapped: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(mod)) {
      wrapped[key] =
        typeof value === 'function' && /^[a-z]/.test(key)
          ? (...args: unknown[]) => {
              calls.push(`${name}.${key}`)
              return (value as (...a: unknown[]) => unknown)(...args)
            }
          : value
    }
    return { ...wrapped, default: wrapped }
  }
  return { calls, trap }
})
vi.mock('node:fs', async (original) => trap(await original(), 'fs'))
vi.mock('node:fs/promises', async (original) => trap(await original(), 'fs/promises'))
vi.mock('node:child_process', async (original) => trap(await original(), 'child_process'))

import { IPC } from '../src/shared/ipc'
import type { AppSettings, ArmResult, DeletePlan, DeleteResult, ScanSnapshot, SafetyModeState, UpdateState } from '../src/shared/types'
import { buildScreenshotFixture, demoUuid, DEMO_ID_RE, DEMO_PROJECTS } from '../src/main/screenshot/fixtures'
import { createScreenshotHandlers, PUSH_CHANNELS, screenshotAppInfo, type ScreenshotHandlers } from '../src/main/screenshot/screenshotIpc'
import { resolveScreenshotMode, SCREENSHOT_LOCALE_ENV, SCREENSHOT_MODE_ENV } from '../src/main/screenshot/screenshotMode'

const ROOT = path.resolve(__dirname, '..')
const NOW = Date.UTC(2026, 9, 2, 8, 0)
const ON = { [SCREENSHOT_MODE_ENV]: 'true' }

function setup(): { handlers: ScreenshotHandlers; snapshot: ScanSnapshot } {
  const appInfo = screenshotAppInfo({ name: 'Claude Local Session Manager', version: '1.2.3', electronVersion: '44.5.1', platform: 'win32 x64', locale: 'vi' })
  const handlers = createScreenshotHandlers({ appInfo, fixture: buildScreenshotFixture(NOW), now: () => NOW })
  return { handlers, snapshot: handlers[IPC.scanSessions]() as ScanSnapshot }
}
const byTitle = (snapshot: ScanSnapshot, title: string): string => snapshot.sessions.find((s) => s.displayTitle === title)!.id

describe('Store screenshot mode: activation', () => {
  it('can never activate in a packaged build, whatever the environment says', () => {
    for (const value of ['true', '1', 'yes', 'on', 'TRUE']) {
      expect(resolveScreenshotMode({ isPackaged: true, env: { [SCREENSHOT_MODE_ENV]: value, [SCREENSHOT_LOCALE_ENV]: 'vi' } })).toBeNull()
      expect(resolveScreenshotMode({ isPackaged: false, env: { [SCREENSHOT_MODE_ENV]: value } })).toEqual({ locale: null })
    }
  })

  it('is off unless explicitly enabled; the locale must be a supported one', () => {
    for (const value of [undefined, '', 'false', '0', 'store', 'please']) {
      expect(resolveScreenshotMode({ isPackaged: false, env: { [SCREENSHOT_MODE_ENV]: value } })).toBeNull()
    }
    expect(resolveScreenshotMode({ isPackaged: false, env: { ...ON, [SCREENSHOT_LOCALE_ENV]: 'zh-CN' } })).toEqual({ locale: 'zh-CN' })
    expect(resolveScreenshotMode({ isPackaged: false, env: { ...ON, [SCREENSHOT_LOCALE_ENV]: 'de' } })).toEqual({ locale: null })
  })

  it('the main process checks app.isPackaged and starts none of the real services in this mode', () => {
    const main = readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8')
    expect(main).toMatch(/resolveScreenshotMode\(\{ isPackaged: app\.isPackaged, env: process\.env \}\)/)
    const start = main.slice(main.indexOf('async function start()'))
    // The branch comes first: before the log file, settings, cache, repository, process guard or updater.
    expect(start.indexOf('if (screenshotMode) return startScreenshotMode(screenshotMode)')).toBeGreaterThan(0)
    for (const real of ['logger.setLogFile', 'new SettingsService', 'new ScanCache', 'new ProcessService', 'new SessionRepository', 'electron-updater']) {
      expect(start.indexOf('startScreenshotMode(screenshotMode)')).toBeLessThan(start.indexOf(real))
    }
    const body = main.slice(main.indexOf('function startScreenshotMode'), main.indexOf('/** OS language preferences'))
    expect(body).not.toMatch(/new (SessionRepository|ProcessService|ArchiveService|DeleteService|ExportService|SettingsService|ScanCache|ManagerHiddenStore|WatchService|UpdateService)|setLogFile|registerIpc\(|electron-updater|shell\./)
    expect(body).toMatch(/isTrustedSender\(event\)/)
  })
})

describe('Store screenshot mode: demo data', () => {
  it('is deterministic for a given clock', () => {
    expect(buildScreenshotFixture(NOW)).toEqual(buildScreenshotFixture(NOW))
    expect(JSON.stringify(buildScreenshotFixture(NOW).snapshot)).toBe(JSON.stringify(buildScreenshotFixture(NOW).snapshot))
  })

  it('contains only synthetic IDs and paths, nothing from this machine', () => {
    const json = JSON.stringify(buildScreenshotFixture(NOW).snapshot)
    for (const id of json.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []) expect(id).toMatch(DEMO_ID_RE)
    const paths = json.match(/[A-Z]:\\\\[^"]*/g) ?? []
    expect(paths.length).toBeGreaterThan(20)
    for (const p of paths) expect(p).toMatch(/^C:\\\\(Users\\\\Demo|Projects\\\\(DemoWebApp|SampleAPI|DesignSystem))/)
    for (const own of [os.homedir(), os.userInfo().username, ROOT]) expect(json.toLowerCase()).not.toContain(own.toLowerCase().replace(/\\/g, '\\\\'))
  })

  it('shows a realistic mix: three projects, Desktop and CLI sessions, archive, live states and one problem', () => {
    const { snapshot } = setup()
    const s = snapshot.sessions
    expect(s).toHaveLength(12)
    expect(new Set(s.map((x) => x.projectPath))).toEqual(new Set(Object.values(DEMO_PROJECTS)))
    expect(s.filter((x) => x.kind === 'desktop').length).toBeGreaterThan(0)
    expect(s.filter((x) => x.kind === 'cli').length).toBeGreaterThan(0)
    expect(s.filter((x) => x.archived)).toHaveLength(2)
    expect(s.map((x) => x.live?.state).filter(Boolean).sort()).toEqual(['idle', 'in-use', 'running'])
    expect(s.filter((x) => x.status === 'metadata-only')).toHaveLength(1)
    expect(s.find((x) => x.displayTitle === 'Update dashboard layout')).toMatchObject({ kind: 'cli', cliSessionId: demoUuid(3), projectPath: DEMO_PROJECTS.web })
  })
})

describe('Store screenshot mode: IPC handlers', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('control: the file-system trap does record what a real service reads', async () => {
    const { ScanCache } = await import('../src/main/services/cacheService')
    await new ScanCache(path.join(os.tmpdir(), 'clsm-trap-control-does-not-exist.json')).load()
    expect(calls).toContain('fs/promises.readFile')
  })

  it('answer exactly the invoke channels of the real app', () => {
    const { handlers } = setup()
    const invoke = Object.values(IPC).filter((c) => !(PUSH_CHANNELS as readonly string[]).includes(c))
    expect(Object.keys(handlers).sort()).toEqual([...invoke].sort())
  })

  it('never read or write a file and never start a process, for any call', async () => {
    const { handlers, snapshot } = setup()
    const id = byTitle(snapshot, 'Update dashboard layout')
    const plan = (await handlers[IPC.createDeletePlan](id)) as DeletePlan
    const args: Partial<Record<keyof typeof handlers, unknown[]>> = {
      [IPC.getSession]: [id],
      [IPC.archiveSession]: [id],
      [IPC.restoreSession]: [id],
      [IPC.bulkArchive]: [[id]],
      [IPC.bulkRestore]: [[id]],
      [IPC.hideSession]: [id],
      [IPC.unhideSession]: [id],
      [IPC.bulkHide]: [[id]],
      [IPC.bulkUnhide]: [[id]],
      [IPC.createDeletePlan]: [id],
      [IPC.createBulkDeletePlan]: [[id]],
      [IPC.deleteSession]: [id, 'DELETE', plan.planId],
      [IPC.bulkDelete]: [[id], 'DELETE 1', plan.planId],
      [IPC.exportSession]: [id, 'jsonl'],
      [IPC.exportSessions]: [[id], ['jsonl', 'markdown']],
      [IPC.revealMetadata]: [id],
      [IPC.revealTranscript]: [id],
      [IPC.revealSessionData]: [id],
      [IPC.openProject]: [id],
      [IPC.getClaudeProcessStatus]: [true],
      [IPC.updateSettings]: [{ language: 'zh-CN' }],
      [IPC.armRealDelete]: ['ENABLE DELETE']
    }
    calls.length = 0
    for (const [channel, fn] of Object.entries(handlers)) await fn(...(args[channel as keyof typeof handlers] ?? []))
    expect(calls).toEqual([])
  })

  it('refuse every call that would change, delete, export or open something', async () => {
    const { handlers, snapshot } = setup()
    const id = byTitle(snapshot, 'Update dashboard layout')
    for (const channel of [IPC.archiveSession, IPC.restoreSession, IPC.hideSession, IPC.unhideSession, IPC.revealMetadata, IPC.revealTranscript, IPC.revealSessionData, IPC.openProject]) {
      expect(await handlers[channel](id)).toMatchObject({ ok: false, code: 'NOT_SUPPORTED' })
    }
    for (const channel of [IPC.bulkArchive, IPC.bulkRestore, IPC.bulkHide, IPC.bulkUnhide]) {
      expect(await handlers[channel]([id])).toMatchObject({ ok: false, results: [] })
    }
    for (const channel of [IPC.clearCache, IPC.installUpdate, IPC.openReleasesPage, IPC.openStoreUpdates, IPC.openStoreListing]) {
      expect(await handlers[channel]()).toMatchObject({ ok: false, code: 'NOT_SUPPORTED' })
    }
    expect(await handlers[IPC.exportSession](id, 'markdown')).toMatchObject({ ok: false, files: [] })
    const plan = (await handlers[IPC.createDeletePlan](id)) as DeletePlan
    const single = (await handlers[IPC.deleteSession](id, 'DELETE', plan.planId)) as DeleteResult
    const bulk = (await handlers[IPC.bulkDelete]([id], 'DELETE 1', plan.planId)) as DeleteResult
    for (const r of [single, bulk]) expect(r).toMatchObject({ ok: false, dryRun: true, code: 'NOT_SUPPORTED', sessions: [] })
  })

  it('cannot arm real deletion: it stays in Safe Mode', async () => {
    const { handlers } = setup()
    const armed = (await handlers[IPC.armRealDelete]('ENABLE DELETE')) as ArmResult
    expect(armed.ok).toBe(false)
    expect(armed.state.dryRun).toBe(true)
    expect(((await handlers[IPC.getSafetyMode]()) as SafetyModeState).dryRun).toBe(true)
    expect(((await handlers[IPC.returnToSafeMode]()) as SafetyModeState).dryRun).toBe(true)
  })

  it('shows the delete plan as a dry run, built with the app rules: transcript deleted, workspace kept', async () => {
    const { handlers, snapshot } = setup()
    const plan = (await handlers[IPC.createDeletePlan](byTitle(snapshot, 'Update dashboard layout'))) as DeletePlan
    expect(plan.dryRun).toBe(true)
    expect(plan.confirmationPhrases).toEqual(['DELETE', 'DELETE PERMANENTLY'])
    expect(plan.globalBlockedReason).toBeUndefined()
    const [s] = plan.sessions
    expect(s.items.find((i) => i.kind === 'transcript')).toMatchObject({
      action: 'delete-file',
      path: `C:\\Users\\Demo\\.claude\\projects\\C--Projects-DemoWebApp\\${demoUuid(3)}.jsonl`
    })
    expect(s.willNotDelete[0]).toMatchObject({ path: 'C:\\Projects\\DemoWebApp' })
    expect(s.items.some((i) => i.path.startsWith('C:\\Projects'))).toBe(false)
    // Same plan for the same clock (stable IDs in screenshots).
    expect(((await handlers[IPC.createDeletePlan](s.sessionId)) as DeletePlan).planId).toBe(plan.planId)
    // A session open in a running Claude Code process is blocked, as in the real app.
    const live = (await handlers[IPC.createDeletePlan](byTitle(snapshot, 'Refactor authentication flow'))) as DeletePlan
    expect(live.sessions).toEqual([])
    expect(live.blocked[0].blockedCode).toBe('SESSION_IN_USE')
  })

  it('reports the Microsoft Store update state and keeps settings in memory only', async () => {
    const { handlers } = setup()
    expect(await handlers[IPC.getAppInfo]()).toMatchObject({ distribution: 'store', userHome: 'C:\\Users\\Demo', systemLanguages: ['vi-VN'] })
    expect(await handlers[IPC.getUpdateState]()).toMatchObject({ mode: 'store', status: 'store-managed', canCheck: false, canDownload: false, canInstall: false } satisfies Partial<UpdateState>)
    expect(((await handlers[IPC.updateSettings]({ language: 'zh-CN', showRawPaths: 'yes' })) as AppSettings).language).toBe('zh-CN')
    expect(((await handlers[IPC.getSettings]()) as AppSettings).showRawPaths).toBe(false)
    expect(calls).toEqual([])
  })

  it('still rejects malformed arguments such as paths', () => {
    const { handlers } = setup()
    expect(() => handlers[IPC.getSession]('C:\\Users\\Demo\\.claude')).toThrow(/Invalid session id/)
    expect(() => handlers[IPC.deleteSession]('0'.repeat(20), 'DELETE', '../plan')).toThrow()
  })
})
