import { EventEmitter } from 'node:events'
import { isArmConfirmationValid } from '../../shared/confirm'
import type { ArmResult, ProcessStatus, SafetyModeReason, SafetyModeState } from '../../shared/types'
import { globalGuard } from './processService'

/** Real-delete mode returns to Safe Mode on its own after this long. */
export const ARM_DURATION_MS = 10 * 60_000

/** Development-only opt-in that lets CLAUDE_SESSION_MANAGER_DRY_RUN=false start the app armed. */
export const DEV_ALLOW_ENV_ARM = 'CLAUDE_SESSION_MANAGER_DEV_ALLOW_ENV_ARM'
export const DRY_RUN_ENV = 'CLAUDE_SESSION_MANAGER_DRY_RUN'

export interface InitialMode {
  dryRun: boolean
  reason: Extract<SafetyModeReason, 'startup' | 'env-dev'>
  notice?: string
}

const FALSY = /^(0|false|no|off)$/i

/**
 * Decide the mode at launch. Every launch is SAFE MODE, except a development
 * (unpackaged) run that sets BOTH CLAUDE_SESSION_MANAGER_DRY_RUN=false AND
 * CLAUDE_SESSION_MANAGER_DEV_ALLOW_ENV_ARM=1. A packaged production build
 * ignores the variable entirely, so a stale system/user variable can never
 * start it in real-delete mode.
 */
export function resolveInitialMode(opts: { isPackaged: boolean; env: Record<string, string | undefined> }): InitialMode {
  const raw = opts.env[DRY_RUN_ENV]?.trim()
  const wantsReal = raw !== undefined && FALSY.test(raw)
  if (!wantsReal) return { dryRun: true, reason: 'startup' }
  if (opts.isPackaged) {
    return {
      dryRun: true,
      reason: 'startup',
      notice: `${DRY_RUN_ENV}=${raw} was ignored: the packaged app always starts in Safe Mode.`
    }
  }
  if (opts.env[DEV_ALLOW_ENV_ARM]?.trim() !== '1') {
    return {
      dryRun: true,
      reason: 'startup',
      notice: `${DRY_RUN_ENV}=${raw} was ignored because ${DEV_ALLOW_ENV_ARM}=1 is not set.`
    }
  }
  return { dryRun: false, reason: 'env-dev', notice: `Development run armed by ${DRY_RUN_ENV}=${raw} (${DEV_ALLOW_ENV_ARM}=1).` }
}

export interface SafetyModeOptions {
  initial: InitialMode
  processes: { getStatus(force: boolean): Promise<ProcessStatus> }
  armDurationMs?: number
  now?: () => number
}

/**
 * The single source of truth for dry-run vs real delete. Lives only in
 * process memory: there is no file, setting, registry key or storage behind
 * it, so closing the app always returns to Safe Mode.
 *
 * It only flips `dryRun`. Every other guard (plan ID/hash/expiry, identity,
 * path validation, workspace protection, link checks, process guard, typed
 * DELETE confirmation) stays in the delete pipeline and is never bypassed.
 */
export class SafetyModeController extends EventEmitter {
  private state: SafetyModeState
  private timer: NodeJS.Timeout | null = null
  private readonly armDurationMs: number
  private readonly now: () => number

  constructor(private readonly opts: SafetyModeOptions) {
    super()
    this.armDurationMs = opts.armDurationMs ?? ARM_DURATION_MS
    this.now = opts.now ?? Date.now
    const t = this.now()
    this.state = { dryRun: true, reason: 'startup', changedAt: t, armDurationMs: this.armDurationMs, notice: opts.initial.notice }
    if (!opts.initial.dryRun) this.setArmed(opts.initial.reason)
  }

  getState(): SafetyModeState {
    this.expireIfDue()
    return { ...this.state }
  }

  /** Read at the start of every mutating operation. */
  isDryRun(): boolean {
    this.expireIfDue()
    return this.state.dryRun
  }

  /** Arm real deletion: exact "ENABLE DELETE" and no process condition that blocks mutations. */
  async arm(confirmation: unknown): Promise<ArmResult> {
    if (!isArmConfirmationValid(confirmation)) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Type exactly ENABLE DELETE to arm real deletion.', state: this.getState() }
    }
    const status = await this.opts.processes.getStatus(true)
    const guard = globalGuard(status)
    if (guard) return { ok: false, code: guard.code, message: `Real deletion was not armed: ${guard.message}`, state: this.getState() }
    this.setArmed('armed-in-ui')
    return {
      ok: true,
      message: `REAL DELETE ARMED for ${Math.round(this.armDurationMs / 60_000)} minutes or one delete, whichever comes first.`,
      state: this.getState()
    }
  }

  /** Return to Safe Mode immediately (no restart needed). */
  disarm(reason: Extract<SafetyModeReason, 'returned-by-user' | 'expired' | 'after-delete'>): SafetyModeState {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const wasArmed = !this.state.dryRun
    this.state = { dryRun: true, reason, changedAt: this.now(), armDurationMs: this.armDurationMs }
    if (wasArmed) this.emit('changed', this.getState())
    return this.getState()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private setArmed(reason: SafetyModeState['reason']): void {
    const t = this.now()
    this.state = { dryRun: false, reason, changedAt: t, armedAt: t, expiresAt: t + this.armDurationMs, armDurationMs: this.armDurationMs, notice: this.state.notice }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.expireIfDue(true), this.armDurationMs)
    this.timer.unref?.()
    this.emit('changed', { ...this.state })
  }

  private expireIfDue(force = false): void {
    if (this.state.dryRun || this.state.expiresAt === undefined) return
    if (force || this.now() >= this.state.expiresAt) this.disarm('expired')
  }
}
