import { useEffect, type ReactElement } from 'react'
import { Banners } from './components/Banners'
import { DeleteModal } from './components/DeleteModal'
import { DetailsPanel } from './components/DetailsPanel'
import { ArmModal } from './components/SafetyMode'
import { SessionList } from './components/SessionList'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { SettingsPage } from './pages/SettingsPage'
import { StoragePage } from './pages/StoragePage'
import { init, refreshProcess, useAppState } from './stores/appStore'

const PROCESS_POLL_MS = 15_000

export default function App(): ReactElement {
  const view = useAppState((s) => s.view)
  const deleteRequest = useAppState((s) => s.deleteRequest)

  useEffect(() => {
    void init()
    const t = window.setInterval(() => void refreshProcess(false), PROCESS_POLL_MS)
    return () => window.clearInterval(t)
  }, [])

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Banners />
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
      {deleteRequest && <DeleteModal />}
      <ArmModal />
      <Toasts />
    </div>
  )
}
