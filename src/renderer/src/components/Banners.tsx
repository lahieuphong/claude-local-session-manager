import type { ReactElement } from 'react'
import { refreshProcess, useAppState } from '../stores/appStore'
import { IconAlert, IconInfo, IconRefresh } from './Icons'

export function Banners(): ReactElement | null {
  const process = useAppState((s) => s.process)
  const appInfo = useAppState((s) => s.appInfo)
  const checking = useAppState((s) => s.processChecking)
  const showClaude = !!process && (process.desktopRunning || !!process.error)
  if (!showClaude && !appInfo?.dryRun) return null
  return (
    <div className="banners">
      {showClaude && (
        <div className="banner warn">
          <IconAlert size={15} />
          <span>
            {process?.error
              ? 'Could not verify whether Claude Desktop is running — modifying actions are disabled.'
              : 'Claude Desktop is running. Close Claude Desktop before modifying session files (archive, restore, delete are disabled). Browsing and export still work.'}
          </span>
          <div className="spacer" />
          <button className="btn small" onClick={() => void refreshProcess(true)} disabled={checking}>
            <IconRefresh size={13} className={checking ? 'spin' : ''} /> Re-check
          </button>
        </div>
      )}
      {appInfo?.dryRun && (
        <div className="banner info">
          <IconInfo size={15} />
          <span>
            <strong>DRY RUN</strong> — archive, restore and delete only log the planned changes; no Claude files are modified. Set{' '}
            <code>CLAUDE_SESSION_MANAGER_DRY_RUN=false</code> to disable.
          </span>
        </div>
      )}
    </div>
  )
}
