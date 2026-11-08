import { useEffect, type ReactElement } from 'react'
import { DeleteModal } from './components/DeleteModal'
import { DetailsPanel } from './components/DetailsPanel'
import { ProviderPicker } from './components/ProviderPicker'
import { ArmModal } from './components/SafetyMode'
import { SessionList } from './components/SessionList'
import { Sidebar } from './components/Sidebar'
import { StatusStrip } from './components/StatusStrip'
import { Toasts } from './components/Toasts'
import { SettingsPage } from './pages/SettingsPage'
import { StoragePage } from './pages/StoragePage'
import { init, refreshProcess, useAppState } from './stores/appStore'

const PROCESS_POLL_MS = 15_000

export default function App(): ReactElement {
  const view = useAppState((s) => s.view)
  const provider = useAppState((s) => s.provider)

  useEffect(() => {
    void init()
    const t = window.setInterval(() => void refreshProcess(false), PROCESS_POLL_MS)
    return () => window.clearInterval(t)
  }, [])

  // Every start begins with the choice of tool: Claude or Codex.
  if (!provider) {
    return (
      <div className="app picker-app">
        <ProviderPicker />
        <Toasts />
      </div>
    )
  }

  return (
    <div className="app" data-provider={provider}>
      <Sidebar />
      <main className="main">
        <StatusStrip />
        {view.kind === 'sessions' ? (
          <div className="sessions-layout">
            <SessionList />
            <DetailsPanel />
          </div>
        ) : view.kind === 'storage' ? (
          <StoragePage />
        ) : (
          <SettingsPage />
        )}
      </main>
      <DeleteModal />
      <ArmModal />
      <Toasts />
    </div>
  )
}
