import type { ReactElement } from 'react'
import type { UpdateState } from '../../../shared/types'
import { formatDateTime } from '../../../shared/format'
import { checkForUpdates, downloadUpdate, installUpdate, openReleasesPage, setView, useAppState } from '../stores/appStore'
import { AppMark, IconDownload, IconExternal, IconRefresh } from './Icons'

const MODE_LABEL: Record<UpdateState['mode'], string> = {
  installed: 'Installed (Setup)',
  portable: 'Portable',
  development: 'Development build'
}

function statusText(u: UpdateState): string {
  switch (u.status) {
    case 'checking':
      return 'Checking for updates...'
    case 'up-to-date':
      return "You're up to date"
    case 'available':
      return `Update available: ${u.latestVersion}`
    case 'downloading':
      return `Downloading update... ${u.progressPercent ?? 0}%`
    case 'downloaded':
      return 'Update ready to install'
    case 'error':
      return 'Update failed'
    case 'unsupported':
      return u.mode === 'development' ? 'Update checks are disabled in development builds' : 'Automatic update checks are unavailable'
    default:
      return 'Not checked yet'
  }
}

/** Settings → About: version, disclaimer and update actions. */
export function AboutSection(): ReactElement {
  const appInfo = useAppState((s) => s.appInfo)
  const u = useAppState((s) => s.updates)
  return (
    <section className="card about">
      <AppMark size={40} />
      <div className="about-body">
        <div className="strong">Claude Local Session Manager</div>
        <div>Version {appInfo?.version ?? '…'}</div>
        <p className="small">Unofficial local utility · Not affiliated with Anthropic</p>
        <p className="small muted">
          Electron {appInfo?.electronVersion} · {appInfo?.platform}
          {u ? ` · ${MODE_LABEL[u.mode]}` : ''}
        </p>

        {u && (
          <div className={`update-box status-${u.status}`}>
            <div className="update-status">
              <span className="strong">{statusText(u)}</span>
              {u.status === 'downloading' && (
                <span className="bar-track update-progress">
                  <span className="bar-fill" style={{ width: `${u.progressPercent ?? 0}%` }} />
                </span>
              )}
            </div>
            {u.message && u.status !== 'checking' && u.message !== "You're up to date." && <div className="small muted">{u.message}</div>}
            {u.checkedAt && <div className="small muted">Last checked {formatDateTime(u.checkedAt)}</div>}
            <div className="row-flex gap">
              <button className="btn small" disabled={!u.canCheck} onClick={() => void checkForUpdates()}>
                <IconRefresh size={13} className={u.status === 'checking' ? 'spin' : ''} /> Check for updates
              </button>
              {u.canDownload && (
                <button className="btn small" onClick={() => void downloadUpdate()}>
                  <IconDownload size={13} /> Download update
                </button>
              )}
              {u.canInstall && (
                <button
                  className="btn small primary"
                  onClick={() => {
                    if (window.confirm('Restart Claude Local Session Manager now to install the update?')) void installUpdate()
                  }}
                >
                  Restart and install
                </button>
              )}
              {u.mode !== 'installed' && u.status === 'available' && (
                <button className="btn small" onClick={() => void openReleasesPage()}>
                  <IconExternal size={13} /> Open GitHub Releases
                </button>
              )}
            </div>
            {u.mode === 'portable' && (
              <div className="small muted">
                Portable builds are never replaced automatically. Download the new Setup (recommended) or Portable build from GitHub Releases.
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/** Small sidebar hint when an update is waiting. */
export function UpdatePill(): ReactElement | null {
  const u = useAppState((s) => s.updates)
  if (!u || (u.status !== 'available' && u.status !== 'downloaded')) return null
  return (
    <button className="update-pill" onClick={() => setView({ kind: 'settings' })} title="Open Settings → About">
      {u.status === 'downloaded' ? 'Update ready to install' : `Update available: ${u.latestVersion}`}
    </button>
  )
}
