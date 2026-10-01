import { appendFile, mkdir, readdir, readFile, rm, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildProcessStatus, type RawProcess } from '../src/main/services/processService'
import {
  ARM_DURATION_MS,
  DEV_ALLOW_ENV_ARM,
  DRY_RUN_ENV,
  resolveInitialMode,
  SafetyModeController
} from '../src/main/services/safetyMode'
import { mergeSettings, DEFAULT_SETTINGS, SettingsService } from '../src/main/services/settingsService'
import { lstatOrNull } from '../src/main/util/fsx'
import type { SafetyModeState } from '../src/shared/types'
import { createFakeClaude, createHarness, DESKTOP_EXE, U, userLine, type FakeClaude, type Harness } from './helpers/fakeClaude'

/** Stub process source: Claude Desktop running or not, or status unknown. */
function fakeProcesses(list: RawProcess[] = [], error?: string): { getStatus(): Promise<ReturnType<typeof buildProcessStatus>> } {
  return { getStatus: async () => buildProcessStatus(list, [], error) }
}

function safeController(opts: { now?: () => number; processes?: ReturnType<typeof fakeProcesses> } = {}): SafetyModeController {
  return new SafetyModeController({
    initial: resolveInitialMode({ isPackaged: true, env: {} }),
    processes: opts.processes ?? fakeProcesses(),
    now: opts.now
  })
}

describe('startup mode', () => {
  it('every fresh launch defaults to dry run (packaged and development)', () => {
    expect(resolveInitialMode({ isPackaged: true, env: {} })).toMatchObject({ dryRun: true, reason: 'startup' })
    expect(resolveInitialMode({ isPackaged: false, env: {} })).toMatchObject({ dryRun: true, reason: 'startup' })
    expect(resolveInitialMode({ isPackaged: false, env: { [DRY_RUN_ENV]: 'true' } }).dryRun).toBe(true)
    expect(safeController().isDryRun()).toBe(true)
  })

  it('a packaged production app ignores a stale real-delete environment variable', () => {
    for (const value of ['false', 'FALSE', '0', 'no', 'off']) {
      const m = resolveInitialMode({ isPackaged: true, env: { [DRY_RUN_ENV]: value, [DEV_ALLOW_ENV_ARM]: '1' } })
      expect(m.dryRun).toBe(true)
      expect(m.notice).toMatch(/ignored/)
    }
  })

  it('development needs an explicit opt-in flag before the env variable can arm at startup', () => {
    expect(resolveInitialMode({ isPackaged: false, env: { [DRY_RUN_ENV]: 'false' } })).toMatchObject({ dryRun: true })
    expect(resolveInitialMode({ isPackaged: false, env: { [DRY_RUN_ENV]: 'false', [DEV_ALLOW_ENV_ARM]: 'yes' } }).dryRun).toBe(true)
    const armed = resolveInitialMode({ isPackaged: false, env: { [DRY_RUN_ENV]: 'false', [DEV_ALLOW_ENV_ARM]: '1' } })
    expect(armed).toMatchObject({ dryRun: false, reason: 'env-dev' })
    // Even then the arm is time-limited like a UI arm.
    let t = 1_000
    const c = new SafetyModeController({ initial: armed, processes: fakeProcesses(), now: () => t })
    expect(c.isDryRun()).toBe(false)
    t += ARM_DURATION_MS
    expect(c.isDryRun()).toBe(true)
    c.dispose()
  })
})

describe('arming and returning to Safe Mode', () => {
  it('requires exactly "ENABLE DELETE"', async () => {
    const c = safeController()
    for (const wrong of ['enable delete', 'Enable Delete', 'ENABLE  DELETE', ' ENABLE DELETE', 'ENABLE DELETE ', 'ENABLE-DELETE', 'DELETE', '', undefined, 42]) {
      const r = await c.arm(wrong)
      expect(r).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
      expect(c.isDryRun()).toBe(true)
    }
    const ok = await c.arm('ENABLE DELETE')
    expect(ok.ok).toBe(true)
    expect(c.isDryRun()).toBe(false)
    c.dispose()
  })

  it('refuses to arm while Claude Desktop runs or the process status is unknown', async () => {
    const running = safeController({ processes: fakeProcesses([{ pid: 1, name: 'claude.exe', executablePath: DESKTOP_EXE }]) })
    expect(await running.arm('ENABLE DELETE')).toMatchObject({ ok: false, code: 'CLAUDE_RUNNING' })
    expect(running.isDryRun()).toBe(true)
    const unknown = safeController({ processes: fakeProcesses([], 'Process query failed: timeout') })
    expect((await unknown.arm('ENABLE DELETE')).ok).toBe(false)
    expect(unknown.isDryRun()).toBe(true)
  })

  it('Return to Safe Mode works immediately and emits a change', async () => {
    const c = safeController()
    const events: SafetyModeState[] = []
    c.on('changed', (s: SafetyModeState) => events.push(s))
    await c.arm('ENABLE DELETE')
    const s = c.disarm('returned-by-user')
    expect(s).toMatchObject({ dryRun: true, reason: 'returned-by-user' })
    expect(c.isDryRun()).toBe(true)
    expect(events.map((e) => e.dryRun)).toEqual([false, true])
  })

  it('expires back to Safe Mode after 10 minutes', async () => {
    let t = 50_000
    const c = safeController({ now: () => t })
    await c.arm('ENABLE DELETE')
    expect(c.getState()).toMatchObject({ dryRun: false, armedAt: 50_000, expiresAt: 50_000 + ARM_DURATION_MS })
    t += ARM_DURATION_MS - 1
    expect(c.isDryRun()).toBe(false)
    t += 1
    expect(c.isDryRun()).toBe(true)
    expect(c.getState().reason).toBe('expired')
  })
})

describe('real-delete state is never persisted', () => {
  let fake: FakeClaude
  beforeEach(async () => {
    fake = await createFakeClaude()
  })
  afterEach(async () => {
    await fake.cleanup()
  })

  it('arming writes nothing to disk, settings refuse mode keys, and a restart starts in Safe Mode', async () => {
    const userData = path.join(fake.root, 'userData')
    await mkdir(userData)
    const settings = new SettingsService(path.join(userData, 'settings.json'))
    await settings.load()

    const before = await readdir(fake.root, { recursive: true })
    const first = safeController()
    await first.arm('ENABLE DELETE')
    expect(first.isDryRun()).toBe(false)
    await settings.update({ dryRun: false, realDelete: true, armed: true } as never)
    const after = await readdir(fake.root, { recursive: true })
    expect(after.filter((p) => !before.includes(p))).toEqual(['userData\\settings.json'.replace(/\\/g, path.sep)])

    const saved = await readFile(path.join(userData, 'settings.json'), 'utf8')
    expect(JSON.parse(saved)).toEqual(DEFAULT_SETTINGS)
    expect(saved).not.toMatch(/dryRun|realDelete|armed/)
    expect(mergeSettings(DEFAULT_SETTINGS, { dryRun: false })).not.toHaveProperty('dryRun')

    // "Restart": a new process builds a new controller from the same inputs.
    first.dispose()
    const restarted = safeController()
    expect(restarted.isDryRun()).toBe(true)
    expect(restarted.getState().reason).toBe('startup')
  })
})

describe('delete pipeline with the in-app safety switch', () => {
  let fake: FakeClaude
  let safety: SafetyModeController
  let h: Harness
  let transcript: string
  let id: string
  let procs: RawProcess[]

  beforeEach(async () => {
    fake = await createFakeClaude()
    h = createHarness(fake, { dryRun: () => safety.isDryRun(), onRealDeleteExecuted: () => safety.disarm('after-delete') })
    procs = h.processes // one process source for both the arm check and the delete guard
    safety = new SafetyModeController({
      initial: resolveInitialMode({ isPackaged: true, env: {} }),
      processes: h.processService
    })
    transcript = await fake.writeTranscript('C--Work-demo', U.A, [userLine(U.A, 'disposable', '2026-09-29T01:00:00Z')])
    await fake.writeSessionData('C--Work-demo', U.A)
    await fake.writeTranscript('C--Work-demo', U.B, [userLine(U.B, 'keep', '2026-09-29T01:00:00Z')])
    id = (await h.repo.scan()).sessions.find((s) => s.cliSessionId === U.A)!.id
  })
  afterEach(async () => {
    safety.dispose()
    await fake.cleanup()
  })

  it('in Safe Mode, Delete permanently is a dry run and changes nothing', async () => {
    const plan = await h.deleter.createPlan([id], false)
    expect(plan.dryRun).toBe(true)
    const r = await h.deleter.execute([id], 'DELETE', plan.planId, false)
    expect(r).toMatchObject({ ok: true, dryRun: true })
    expect(await lstatOrNull(transcript)).not.toBeNull()
  })

  it('armed: one successful real delete, then Safe Mode is restored automatically', async () => {
    expect((await safety.arm('ENABLE DELETE')).ok).toBe(true)
    const plan = await h.deleter.createPlan([id], false)
    expect(plan.dryRun).toBe(false)
    const r = await h.deleter.execute([id], 'DELETE', plan.planId, false)
    expect(r).toMatchObject({ ok: true, dryRun: false })
    expect(await lstatOrNull(transcript)).toBeNull()
    expect(safety.getState()).toMatchObject({ dryRun: true, reason: 'after-delete' })
    expect(await lstatOrNull(path.join(fake.projects, 'C--Work-demo', `${U.B}.jsonl`))).not.toBeNull()

    // The next delete is a dry run again until re-armed.
    const other = h.repo.getSnapshot()!.sessions.find((s) => s.cliSessionId === U.B)!.id
    const next = await h.deleter.createPlan([other], false)
    expect(next.dryRun).toBe(true)
  })

  it('a plan previewed in Safe Mode cannot be executed after arming (and vice versa)', async () => {
    const safePlan = await h.deleter.createPlan([id], false)
    await safety.arm('ENABLE DELETE')
    expect(await h.deleter.execute([id], 'DELETE', safePlan.planId, false)).toMatchObject({ ok: false, code: 'STALE_PLAN' })
    expect(await lstatOrNull(transcript)).not.toBeNull()

    const armedPlan = await h.deleter.createPlan([id], false)
    safety.disarm('returned-by-user')
    expect(await h.deleter.execute([id], 'DELETE', armedPlan.planId, false)).toMatchObject({ ok: false, code: 'STALE_PLAN' })
    expect(await lstatOrNull(transcript)).not.toBeNull()
  })

  it('arming does not weaken any guard; a refused delete deletes nothing', async () => {
    await safety.arm('ENABLE DELETE')

    // Wrong typed confirmation.
    let plan = await h.deleter.createPlan([id], false)
    expect(await h.deleter.execute([id], 'delete', plan.planId, false)).toMatchObject({ ok: false, code: 'INVALID_INPUT' })

    // Unknown plan ID.
    expect(await h.deleter.execute([id], 'DELETE', '0'.repeat(32), false)).toMatchObject({ ok: false })

    // Stale plan: transcript changed after the preview.
    plan = await h.deleter.createPlan([id], false)
    await appendFile(transcript, JSON.stringify(userLine(U.A, 'more', '2026-09-30T00:00:00Z')) + '\n')
    expect(await h.deleter.execute([id], 'DELETE', plan.planId, false)).toMatchObject({ ok: false, code: 'STALE_PLAN' })

    // Claude Desktop started after arming: the process guard still blocks.
    procs.push({ pid: 9, name: 'claude.exe', executablePath: DESKTOP_EXE })
    plan = await h.deleter.createPlan([id], false)
    expect(plan.globalBlockedReason).toMatch(/Close Claude Desktop/)
    expect(await h.deleter.execute([id], 'DELETE', plan.planId, false)).toMatchObject({ ok: false, code: 'CLAUDE_RUNNING' })
    procs.length = 0

    // Junction swapped in after the preview: path validation still refuses.
    plan = await h.deleter.createPlan([id], false)
    const dataDir = path.join(fake.projects, 'C--Work-demo', U.A)
    const outside = path.join(fake.root, 'outside')
    await mkdir(outside)
    await rm(dataDir, { recursive: true })
    await symlink(outside, dataDir, 'junction')
    expect((await h.deleter.execute([id], 'DELETE', plan.planId, false)).ok).toBe(false)

    expect(await lstatOrNull(transcript)).not.toBeNull()
    expect((await stat(outside)).isDirectory()).toBe(true)
    // Nothing was deleted, so the single-use arm was not consumed.
    expect(safety.isDryRun()).toBe(false)
  })

  it('a plan expires with the arm: an arm that times out before execution cannot delete', async () => {
    let t = Date.now()
    const timed = new SafetyModeController({
      initial: resolveInitialMode({ isPackaged: true, env: {} }),
      processes: { getStatus: async () => buildProcessStatus([], []) },
      now: () => t
    })
    const h2 = createHarness(fake, { dryRun: () => timed.isDryRun() })
    const id2 = (await h2.repo.scan()).sessions.find((s) => s.cliSessionId === U.A)!.id
    await timed.arm('ENABLE DELETE')
    const plan = await h2.deleter.createPlan([id2], false)
    t += ARM_DURATION_MS
    expect(await h2.deleter.execute([id2], 'DELETE', plan.planId, false)).toMatchObject({ ok: false, code: 'STALE_PLAN' })
    expect(await lstatOrNull(transcript)).not.toBeNull()
    timed.dispose()
  })
})
