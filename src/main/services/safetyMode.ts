import { EventEmitter } from 'node:events'
import { ARM_CONFIRMATION_PHRASE, isArmConfirmationValid } from '../../shared/confirm'
import type { ArmResult, ProcessStatus, SafetyModeReason, SafetyModeState } from '../../shared/types'
import { globalGuard } from './processService'
import { msg } from '../util/messages'
import type { MessageRef } from '../../shared/messages'

/** Real-delete mode returns to Safe Mode on its own after this long. */
export const ARM_DURATION_MS = 10 * 60_000

/** Development-only opt-in that lets CLAUDE_SESSION_MANAGER_DRY_RUN=false start the app armed. */
export const DEV_ALLOW_ENV_ARM = 'CLAUDE_SESSION_MANAGER_DEV_ALLOW_ENV_ARM'
export const DRY_RUN_ENV = 'CLAUDE_SESSION_MANAGER_DRY_RUN'

export interface InitialMode {
  dryRun: boolean
  reason: Extract<SafetyModeReason, 'startup' | 'env-dev'>
  notice?: string
  noticeMsg?: MessageRef
}

function notice(key: string, params: Record<string, string>): { notice: string; noticeMsg: MessageRef } {
  const m = msg(key, params)
  return { notice: m.message, noticeMsg: m.msg }
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
    return { dryRun: true, reason: 'startup', ...notice('safety.noticePackaged', { variable: DRY_RUN_ENV, value: raw }) }
  }
  if (opts.env[DEV_ALLOW_ENV_ARM]?.trim() !== '1') {
    return {
      dryRun: true,
      reason: 'startup',
      ...notice('safety.noticeNoDevAllow', { variable: DRY_RUN_ENV, value: raw, allow: DEV_ALLOW_ENV_ARM })
    }
  }
  return { dryRun: false, reason: 'env-dev', ...notice('safety.noticeDevArmed', { variable: DRY_RUN_ENV, value: raw, allow: DEV_ALLOW_ENV_ARM }) }
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
    this.state = {
      dryRun: true,
      reason: 'startup',
      changedAt: t,
      armDurationMs: this.armDurationMs,
      notice: opts.initial.notice,
      noticeMsg: opts.initial.noticeMsg
    }
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
      return { ok: false, code: 'INVALID_INPUT', ...msg('safety.typeExactly', { phrase: ARM_CONFIRMATION_PHRASE }), state: this.getState() }
    }
    const status = await this.opts.processes.getStatus(true)
    const guard = globalGuard(status)
    if (guard) return { ok: false, code: guard.code, ...msg('safety.notArmed', { reason: guard.msg }), state: this.getState() }
    this.setArmed('armed-in-ui')
    return { ok: true, ...msg('safety.armed', { minutes: Math.round(this.armDurationMs / 60_000) }), state: this.getState() }
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
    this.state = {
      dryRun: false,
      reason,
      changedAt: t,
      armedAt: t,
      expiresAt: t + this.armDurationMs,
      armDurationMs: this.armDurationMs,
      notice: this.state.notice,
      noticeMsg: this.state.noticeMsg
    }
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
