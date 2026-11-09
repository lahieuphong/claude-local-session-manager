import { useId, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateState } from '../../../shared/types'
import { useFmt } from '../i18n'
import { checkForUpdates, downloadUpdate, installUpdate, openMicrosoftStore, openReleasesPage, setView, useAppState } from '../stores/appStore'
import { AppMark, IconDownload, IconExternal, IconRefresh, IconRestore } from './Icons'
import { Modal } from './Modal'

function statusKey(u: UpdateState): string {
  if (u.status === 'store-managed') return 'updater:status.storeManaged'
  if (u.status === 'unsupported') return u.mode === 'development' ? 'updater:status.unsupportedDev' : 'updater:status.unsupported'
  return `updater:status.${u.status}`
}

/** Settings → Updates. */
export function UpdatesSection(): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  const u = useAppState((s) => s.updates)
  const appInfo = useAppState((s) => s.appInfo)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const titleId = useId()
  if (!u) return <div className="muted">{t('updater:loading')}</div>

  const store = u.mode === 'store'
  // The status line already says it; show the main-process detail only when it adds something.
  const detail =
    u.message && !['checking', 'up-to-date', 'available', 'downloading', 'downloaded', 'store-managed'].includes(u.status) ? fmt.msg(u.msg, u.message) : null
  const noRelease = u.status === 'up-to-date' && u.msg?.key === 'update.noRelease'
  // One line under the status: this version, how it was installed, when it last looked.
  const facts = [t('updater:version', { version: u.currentVersion }), t(`updater:mode.${u.mode}`)]
  if (u.checkedAt) facts.push(t('updater:checkedAt', { time: fmt.dateTime(u.checkedAt) }))

  return (
    <div className={`update-panel status-${u.status}`}>
      <div className="update-head">
        <span className={`update-dot status-${u.status}`} aria-hidden="true" />
        <div className="update-text">
          <div className="update-title" role="status">
            {noRelease ? t('updater:status.noRelease') : t(statusKey(u), { version: u.latestVersion ?? '', percent: u.progressPercent ?? 0 })}
          </div>
          <div className="update-facts">{facts.join(' · ')}</div>
        </div>
        <div className="row-actions">
          {store ? (
            <>
              <button className="btn" onClick={() => void openMicrosoftStore('updates')}>
                <IconExternal size={14} /> {t('updater:action.openStore')}
              </button>
              {appInfo?.storeListingAvailable && (
                <button className="btn" onClick={() => void openMicrosoftStore('listing')}>
                  <IconExternal size={14} /> {t('updater:action.viewInStore')}
                </button>
              )}
            </>
          ) : (
            <button className="btn" disabled={!u.canCheck} onClick={() => void checkForUpdates()}>
              <IconRefresh size={14} className={u.status === 'checking' ? 'spin' : ''} /> {t('updater:action.check')}
            </button>
          )}
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
          {u.mode === 'portable' && u.status === 'available' && (
            <button className="btn" onClick={() => void openReleasesPage()}>
              <IconExternal size={14} /> {t('updater:action.openReleases')}
            </button>
          )}
        </div>
      </div>
      {u.status === 'downloading' && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={u.progressPercent ?? 0}>
          <span className="progress-fill" style={{ width: `${u.progressPercent ?? 0}%` }} />
        </div>
      )}
      {detail && <div className="hint">{detail}</div>}
      {u.mode === 'portable' && u.status === 'available' && <p className="hint">{t('updater:portableNote')}</p>}

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} labelledBy={titleId} size="narrow">
        <header className="modal-header">
          <h2 id={titleId}>{t('updater:confirm.title')}</h2>
        </header>
        <div className="modal-body">
          <p>{t('updater:confirm.text', { appName: appInfo?.name ?? '', version: u.latestVersion ?? '' })}</p>
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

/** Settings, at the bottom: the app's name, version and that it is unofficial. */
export function AboutSection(): ReactElement {
  const { t } = useTranslation()
  const appInfo = useAppState((s) => s.appInfo)
  return (
    <footer className="about">
      <AppMark size={28} />
      <div className="about-body">
        <div className="about-line">
          <span className="about-name">{appInfo?.name}</span>
          <span className="about-version mono">{appInfo?.version ?? '…'}</span>
        </div>
        <div className="hint">{t('common:app.disclaimer')}</div>
      </div>
    </footer>
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
