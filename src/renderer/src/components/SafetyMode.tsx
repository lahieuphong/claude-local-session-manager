import { useEffect, useState, type ReactElement } from 'react'
import { ARM_CONFIRMATION_PHRASE, isArmConfirmationValid } from '../../../shared/confirm'
import type { SafetyModeState } from '../../../shared/types'
import {
  armRealDelete,
  openArmModal,
  refreshProcess,
  refreshSafetyMode,
  returnToSafeMode,
  setView,
  useAppState
} from '../stores/appStore'
import { IconAlert, IconCheck, IconInfo, IconRefresh, IconX } from './Icons'

/** mm:ss until the armed mode expires; ticks every second while armed. */
export function useArmCountdown(state: SafetyModeState | null): string | null {
  const [now, setNow] = useState(Date.now())
  const armed = !!state && !state.dryRun && state.expiresAt !== undefined
  useEffect(() => {
    if (!armed) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [armed])
  useEffect(() => {
    // The main process expires the mode itself; re-read when the clock runs out.
    if (armed && state?.expiresAt !== undefined && now >= state.expiresAt) void refreshSafetyMode()
  }, [armed, now, state?.expiresAt])
  if (!armed || state?.expiresAt === undefined) return null
  const left = Math.max(0, state.expiresAt - now)
  const m = Math.floor(left / 60_000)
  const s = Math.floor((left % 60_000) / 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Persistent banner: blue SAFE MODE / red REAL DELETE ARMED. */
export function SafetyBanner(): ReactElement | null {
  const safety = useAppState((s) => s.safety)
  const remaining = useArmCountdown(safety)
  if (!safety) return null
  if (safety.dryRun) {
    return (
      <div className="banner info">
        <IconInfo size={15} />
        <span>
          <strong>DRY RUN</strong> · Safe Mode — dry-run enabled. No Claude files can be deleted, archived or restored.
        </span>
        <div className="spacer" />
        <button className="btn small" onClick={() => setView({ kind: 'settings' })}>
          Deletion safety…
        </button>
      </div>
    )
  }
  return (
    <div className="banner danger" role="alert">
      <IconAlert size={15} />
      <span>
        <strong>REAL DELETE ARMED{remaining ? ` · ${remaining} remaining` : ''}</strong> — Permanent deletion is enabled for this app
        session. Closing the app will return to Safe Mode. One delete returns to Safe Mode automatically.
      </span>
      <div className="spacer" />
      <button className="btn small" onClick={() => void returnToSafeMode()}>
        Return to Safe Mode
      </button>
    </div>
  )
}

export function SafetyPill(): ReactElement | null {
  const safety = useAppState((s) => s.safety)
  const remaining = useArmCountdown(safety)
  if (!safety) return null
  return safety.dryRun ? (
    <div className="dry-pill">DRY RUN</div>
  ) : (
    <div className="armed-pill">REAL DELETE ARMED{remaining ? ` · ${remaining}` : ''}</div>
  )
}

/** Settings → Deletion Safety. */
export function DeletionSafetySection(): ReactElement {
  const safety = useAppState((s) => s.safety)
  const remaining = useArmCountdown(safety)
  return (
    <section className={`card safety-card ${safety && !safety.dryRun ? 'armed' : ''}`}>
      <h3 className="section-title">Deletion Safety</h3>
      {!safety ? (
        <div className="muted">Reading safety mode…</div>
      ) : safety.dryRun ? (
        <>
          <div className="safety-status safe">
            <span className="safety-label">SAFE MODE</span>
            <span>Dry-run enabled. No Claude files can be deleted.</span>
          </div>
          <p className="small muted">
            Every app launch starts here. Real deletion can be armed only for the current app session; it is never saved anywhere and
            returns to Safe Mode after one delete, after 10 minutes, or when the app closes.
          </p>
          <button className="btn danger" onClick={() => openArmModal(true)}>
            Enable real deletion
          </button>
        </>
      ) : (
        <>
          <div className="safety-status armed">
            <span className="safety-label">REAL DELETE ARMED</span>
            <span>
              Permanent deletion is enabled for this app session{remaining ? ` · ${remaining} remaining` : ''}. Closing the app will return
              to Safe Mode.
            </span>
          </div>
          <button className="btn" onClick={() => void returnToSafeMode()}>
            Return to Safe Mode
          </button>
        </>
      )}
      {safety?.notice && <div className="notice subtle small">{safety.notice}</div>}
      <ul className="plain-list small muted">
        <li>Arming changes only dry-run on/off. Every delete still needs a valid, unexpired, unchanged plan, exact paths inside approved Claude roots, no workspace or link escape, no running Claude Desktop or live session, and the typed DELETE confirmation.</li>
        <li>Hide in manager never touches Claude files and works in both modes.</li>
      </ul>
    </section>
  )
}

/** "Enable real deletion" confirmation modal. */
export function ArmModal(): ReactElement | null {
  const open = useAppState((s) => s.armModalOpen)
  const process = useAppState((s) => s.process)
  const checking = useAppState((s) => s.processChecking)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setText('')
    void refreshProcess(true)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') openArmModal(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  const desktopClosed = !!process && !process.error && !process.desktopRunning
  const statusKnown = !!process && !process.error
  const valid = isArmConfirmationValid(text)
  const canArm = valid && desktopClosed && statusKnown && !busy && !checking

  const submit = async (): Promise<void> => {
    if (!canArm) return
    setBusy(true)
    try {
      await armRealDelete(text)
    } finally {
      setBusy(false)
    }
  }

  const Req = ({ ok, label }: { ok: boolean; label: string }): ReactElement => (
    <li className={ok ? 'ok-text' : 'danger-text'}>
      {ok ? <IconCheck size={13} /> : <IconX size={13} />} {label}
    </li>
  )

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && openArmModal(false)}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-label="Enable real deletion">
        <header className="modal-header">
          <IconAlert size={18} className="danger-text" />
          <h2>Enable real deletion</h2>
          <div className="spacer" />
          <button className="icon-btn" onClick={() => openArmModal(false)} title="Close (Esc)">
            <IconX size={16} />
          </button>
        </header>
        <div className="modal-body">
          <div className="danger-box">
            <IconAlert size={18} />
            <div>
              <strong>Real deletion permanently removes local Claude session files.</strong>
              <div className="small">
                This mode automatically resets to Safe Mode when the application closes, after 10 minutes, or right after one delete.
              </div>
            </div>
          </div>
          <div className="plan-group-label">Requirements</div>
          <ul className="req-list small">
            <Req ok={statusKnown} label={statusKnown ? 'Claude process status verified' : 'Claude process status unknown'} />
            <Req ok={desktopClosed} label={desktopClosed ? 'Claude Desktop is closed' : 'Claude Desktop must be closed (quit it from the system tray)'} />
            <Req ok={valid} label={`You typed ${ARM_CONFIRMATION_PHRASE} exactly`} />
          </ul>
          <button className="btn small" onClick={() => void refreshProcess(true)} disabled={checking}>
            <IconRefresh size={13} className={checking ? 'spin' : ''} /> Re-check processes
          </button>
          <label className="confirm-label">
            Type <code>{ARM_CONFIRMATION_PHRASE}</code> to confirm
            <input
              className={`confirm-input ${text && !valid ? 'invalid' : ''}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              autoFocus
              spellCheck={false}
              placeholder={ARM_CONFIRMATION_PHRASE}
            />
          </label>
        </div>
        <footer className="modal-footer">
          <div className="spacer" />
          <button className="btn ghost" onClick={() => openArmModal(false)}>
            Cancel
          </button>
          <button className="btn danger solid" disabled={!canArm} onClick={() => void submit()}>
            Arm real deletion
          </button>
        </footer>
      </div>
    </div>
  )
}
