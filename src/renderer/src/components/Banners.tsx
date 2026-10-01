import type { ReactElement } from 'react'
import { refreshProcess, useAppState } from '../stores/appStore'
import { IconAlert, IconRefresh } from './Icons'
import { SafetyBanner } from './SafetyMode'

export function Banners(): ReactElement {
  const process = useAppState((s) => s.process)
  const checking = useAppState((s) => s.processChecking)
  const showClaude = !!process && (process.desktopRunning || !!process.error)
  return (
    <div className="banners">
      <SafetyBanner />
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
    </div>
  )
}
