import { useEffect, useId, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ARM_CONFIRMATION_PHRASE, isArmConfirmationValid } from '../../../shared/confirm'
import type { SafetyModeState } from '../../../shared/types'
import { useFmt } from '../i18n'
import { armRealDelete, openArmModal, refreshProcess, refreshSafetyMode, returnToSafeMode, useAppState } from '../stores/appStore'
import { IconAlert, IconCheck, IconRefresh, IconShield, IconShieldAlert, IconX } from './Icons'
import { Modal } from './Modal'
import { tCode } from './RichText'

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

/** Settings → Deletion safety. */
export function DeletionSafetySection(): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  const safety = useAppState((s) => s.safety)
  const remaining = useArmCountdown(safety)
  const armed = !!safety && !safety.dryRun
  return (
    <div className={`safety-panel ${armed ? 'armed' : ''}`}>
      {!safety ? (
        <div className="muted">{t('safety:strip.reading')}</div>
      ) : armed ? (
        <>
          <div className="safety-status">
            <span className="mode-chip armed">
              <IconShieldAlert size={14} />
              {t('safety:mode.armed')}
              {remaining && <span className="mode-timer">{remaining}</span>}
            </span>
            <span>{t('safety:section.armedText')}</span>
          </div>
          <div className="row-actions">
            <button className="btn" onClick={() => void returnToSafeMode()}>
              {t('safety:action.returnToSafe')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="safety-status">
            <span className="mode-chip safe">
              <IconShield size={14} />
              {t('safety:mode.safe')}
            </span>
            <span>{t('safety:section.safeText')}</span>
          </div>
          <p className="hint">{t('safety:section.safeHint')}</p>
          <div className="row-actions">
            <button className="btn danger" onClick={() => openArmModal(true)}>
              {t('safety:action.enable')}
            </button>
          </div>
        </>
      )}
      {safety?.notice && <div className="notice subtle small">{fmt.msg(safety.noticeMsg, safety.notice)}</div>}
      <ul className="fine-print">
        <li>{t('safety:section.guardsNote')}</li>
        <li>{t('safety:section.hideNote')}</li>
      </ul>
    </div>
  )
}

/** "Enable real deletion" confirmation dialog. */
export function ArmModal(): ReactElement | null {
  const { t } = useTranslation()
  const open = useAppState((s) => s.armModalOpen)
  const process = useAppState((s) => s.process)
  const checking = useAppState((s) => s.processChecking)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const titleId = useId()
  const descId = useId()

  useEffect(() => {
    if (!open) return
    setText('')
    void refreshProcess(true)
  }, [open])

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

  const Req = ({ ok, label }: { ok: boolean; label: ReactNode }): ReactElement => (
    <li className={ok ? 'req ok' : 'req bad'}>
      {ok ? <IconCheck size={14} /> : <IconX size={14} />}
      <span>{label}</span>
    </li>
  )

  return (
    <Modal open={open} onClose={() => openArmModal(false)} locked={busy} labelledBy={titleId} describedBy={descId} size="narrow" tone="danger">
      <header className="modal-header">
        <IconAlert size={18} className="danger-text" />
        <h2 id={titleId}>{t('safety:arm.title')}</h2>
        <div className="spacer" />
        <button className="icon-btn" onClick={() => openArmModal(false)} disabled={busy} aria-label={t('common:action.closeEsc')} title={t('common:action.closeEsc')}>
          <IconX size={16} />
        </button>
      </header>
      <div className="modal-body">
        <div className="danger-box" id={descId}>
          <IconAlert size={18} />
          <div>
            <strong>{t('safety:arm.warningTitle')}</strong>
            <div className="small">{t('safety:arm.warningText')}</div>
          </div>
        </div>
        <div className="section-label">{t('safety:arm.requirements')}</div>
        <ul className="req-list">
          <Req ok={statusKnown} label={t(statusKnown ? 'safety:arm.reqStatusOk' : 'safety:arm.reqStatusUnknown')} />
          <Req ok={desktopClosed} label={t(desktopClosed ? 'safety:arm.reqClosedOk' : 'safety:arm.reqClosedBad')} />
          <Req ok={valid} label={tCode(t, 'safety:arm.reqTyped', { phrase: ARM_CONFIRMATION_PHRASE })} />
        </ul>
        <button className="btn small quiet" onClick={() => void refreshProcess(true)} disabled={checking}>
          <IconRefresh size={14} className={checking ? 'spin' : ''} /> {t('safety:arm.recheck')}
        </button>
        <label className="confirm-label">
          <span>{tCode(t, 'safety:arm.typeToConfirm', { phrase: ARM_CONFIRMATION_PHRASE })}</span>
          <input
            className={`confirm-input mono ${text && !valid ? 'invalid' : ''}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            data-autofocus
            spellCheck={false}
            autoComplete="off"
            placeholder={ARM_CONFIRMATION_PHRASE}
            aria-invalid={!!text && !valid}
          />
        </label>
      </div>
      <footer className="modal-footer">
        <div className="spacer" />
        <button className="btn quiet" onClick={() => openArmModal(false)} disabled={busy}>
          {t('common:action.cancel')}
        </button>
        <button className="btn danger solid" disabled={!canArm} onClick={() => void submit()}>
          {t('safety:arm.confirm')}
        </button>
      </footer>
    </Modal>
  )
}
