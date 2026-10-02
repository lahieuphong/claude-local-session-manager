import { useId, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateState } from '../../../shared/types'
import { useFmt } from '../i18n'
import { checkForUpdates, downloadUpdate, installUpdate, openReleasesPage, setView, useAppState } from '../stores/appStore'
import { AppMark, IconDownload, IconExternal, IconRefresh, IconRestore } from './Icons'
import { Modal } from './Modal'

function statusKey(u: UpdateState): string {
  if (u.status === 'unsupported') return u.mode === 'development' ? 'updater:status.unsupportedDev' : 'updater:status.unsupported'
  return `updater:status.${u.status}`
}

/** Settings → Updates. */
export function UpdatesSection(): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  const u = useAppState((s) => s.updates)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const titleId = useId()
  if (!u) return <div className="muted">{t('updater:loading')}</div>

  // The status line already says it; show the main-process detail only when it adds something.
  const detail = u.message && !['checking', 'up-to-date', 'available', 'downloading', 'downloaded'].includes(u.status) ? fmt.msg(u.msg, u.message) : null
  const noRelease = u.status === 'up-to-date' && u.msg?.key === 'update.noRelease'

  return (
    <div className={`update-panel status-${u.status}`}>
      <div className="update-head">
        <span className={`update-dot status-${u.status}`} aria-hidden="true" />
        <span className="update-title" role="status">
          {noRelease ? t('updater:status.noRelease') : t(statusKey(u), { version: u.latestVersion ?? '', percent: u.progressPercent ?? 0 })}
        </span>
        <span className="update-mode">{t(`updater:mode.${u.mode}`)}</span>
      </div>
      {u.status === 'downloading' && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={u.progressPercent ?? 0}>
          <span className="progress-fill" style={{ width: `${u.progressPercent ?? 0}%` }} />
        </div>
      )}
      {detail && <div className="hint">{detail}</div>}
      <dl className="kv compact">
        <dt>{t('updater:current')}</dt>
        <dd className="mono">{u.currentVersion}</dd>
        {u.latestVersion && u.latestVersion !== u.currentVersion && (
          <>
            <dt>{t('updater:latest')}</dt>
            <dd className="mono">{u.latestVersion}</dd>
          </>
        )}
        {u.checkedAt && (
          <>
            <dt>{t('updater:lastChecked')}</dt>
            <dd>{fmt.dateTime(u.checkedAt)}</dd>
          </>
        )}
      </dl>
      <div className="row-actions">
        <button className="btn" disabled={!u.canCheck} onClick={() => void checkForUpdates()}>
          <IconRefresh size={14} className={u.status === 'checking' ? 'spin' : ''} /> {t('updater:action.check')}
        </button>
        {u.canDownload && (
          <button className="btn primary" onClick={() => void downloadUpdate()}>
            <IconDownload size={14} /> {t('updater:action.download')}
          </button>
        )}
        {u.canInstall && (
          <button className="btn primary" onClick={() => setConfirmOpen(true)}>
            <IconRestore size={14} /> {t('updater:action.install')}
          </button>
        )}
        {u.mode !== 'installed' && u.status === 'available' && (
          <button className="btn" onClick={() => void openReleasesPage()}>
            <IconExternal size={14} /> {t('updater:action.openReleases')}
          </button>
        )}
      </div>
      {u.mode === 'portable' && <p className="hint">{t('updater:portableNote')}</p>}

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} labelledBy={titleId} size="narrow">
        <header className="modal-header">
          <h2 id={titleId}>{t('updater:confirm.title')}</h2>
        </header>
        <div className="modal-body">
          <p>{t('updater:confirm.text', { version: u.latestVersion ?? '' })}</p>
          <p className="hint">{t('updater:confirm.safeModeNote')}</p>
        </div>
        <footer className="modal-footer">
          <div className="spacer" />
          <button className="btn quiet" onClick={() => setConfirmOpen(false)} data-autofocus>
            {t('common:action.cancel')}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              setConfirmOpen(false)
              void installUpdate()
            }}
          >
            {t('updater:action.install')}
          </button>
        </footer>
      </Modal>
    </div>
  )
}

/** Settings → About. */
export function AboutSection(): ReactElement {
  const { t } = useTranslation()
  const appInfo = useAppState((s) => s.appInfo)
  return (
    <div className="about">
      <AppMark size={40} />
      <div className="about-body">
        <div className="about-name">{t('common:app.name')}</div>
        <div className="about-version mono">{t('updater:version', { version: appInfo?.version ?? '…' })}</div>
        <p className="hint">{t('common:app.disclaimer')}</p>
        <p className="hint mono">
          Electron {appInfo?.electronVersion} · {appInfo?.platform}
        </p>
      </div>
    </div>
  )
}

/** Small sidebar hint when an update is waiting. */
export function UpdatePill(): ReactElement | null {
  const { t } = useTranslation()
  const u = useAppState((s) => s.updates)
  if (!u || (u.status !== 'available' && u.status !== 'downloaded')) return null
  return (
    <button className="update-pill" onClick={() => setView({ kind: 'settings' })} title={t('updater:pillHint')}>
      <span className="update-dot status-available" aria-hidden="true" />
      {u.status === 'downloaded' ? t('updater:status.downloaded') : t('updater:status.available', { version: u.latestVersion ?? '' })}
    </button>
  )
}
