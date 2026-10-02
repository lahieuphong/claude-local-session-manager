import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { refreshProcess, returnToSafeMode, setView, useAppState } from '../stores/appStore'
import { IconAlert, IconRefresh, IconShield, IconShieldAlert } from './Icons'
import { useArmCountdown } from './SafetyMode'

/**
 * Always-visible strip above the content: the deletion safety mode (left)
 * and whether Claude Desktop blocks modifying actions (right).
 */
export function StatusStrip(): ReactElement {
  const { t } = useTranslation()
  const safety = useAppState((s) => s.safety)
  const process = useAppState((s) => s.process)
  const checking = useAppState((s) => s.processChecking)
  const remaining = useArmCountdown(safety)
  const armed = !!safety && !safety.dryRun
  const claudeBlocks = !!process && (process.desktopRunning || !!process.error)

  return (
    <div className={`status-strip ${armed ? 'armed' : ''}`}>
      <div className="strip-safety" role={armed ? 'alert' : 'status'}>
        {!safety ? (
          <span className="strip-muted">{t('safety:strip.reading')}</span>
        ) : armed ? (
          <>
            <span className="mode-chip armed">
              <IconShieldAlert size={14} />
              {t('safety:mode.armed')}
              {remaining && <span className="mode-timer">{remaining}</span>}
            </span>
            <span className="strip-text">{t('safety:strip.armedText')}</span>
            <button className="btn small danger-outline" onClick={() => void returnToSafeMode()}>
              {t('safety:action.returnToSafe')}
            </button>
          </>
        ) : (
          <>
            <span className="mode-chip safe">
              <IconShield size={14} />
              {t('safety:mode.safe')}
            </span>
            <span className="strip-text">{t('safety:strip.safeText')}</span>
            <button className="link-btn" onClick={() => setView({ kind: 'settings' })}>
              {t('safety:strip.settingsLink')}
            </button>
          </>
        )}
      </div>

      <div className={`strip-claude ${claudeBlocks ? 'warn' : ''}`} role="status">
        {claudeBlocks ? (
          <>
            <IconAlert size={14} />
            <span className="strip-text" title={t(process?.error ? 'safety:claude.unknownHint' : 'safety:claude.runningHint')}>
              {t(process?.error ? 'safety:claude.unknown' : 'safety:claude.running')}
            </span>
          </>
        ) : (
          <>
            <span className={`dot ${process ? 'ok' : 'idle'}`} aria-hidden="true" />
            <span className="strip-muted">{t(process ? 'safety:claude.closed' : 'safety:claude.checking')}</span>
          </>
        )}
        <button
          className="icon-btn"
          onClick={() => void refreshProcess(true)}
          disabled={checking}
          title={t('safety:claude.recheck')}
          aria-label={t('safety:claude.recheck')}
        >
          <IconRefresh size={14} className={checking ? 'spin' : ''} />
        </button>
      </div>
    </div>
  )
}
