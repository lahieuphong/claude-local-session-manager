import { useMemo, useState, type ReactElement } from 'react'
import { formatBytes } from '../../../shared/format'
import { refreshProcess, setView, useAppState, type SessionFilter } from '../stores/appStore'
import { filterCounts, projectsOf } from '../utils/sessionQuery'
import {
  AppMark,
  IconAlert,
  IconArchive,
  IconChevron,
  IconCircleDot,
  IconDatabase,
  IconFileText,
  IconFolder,
  IconLayers,
  IconRefresh,
  IconSettings
} from './Icons'

const FILTERS: Array<{ id: SessionFilter; label: string; icon: (p: { size?: number }) => ReactElement }> = [
  { id: 'all', label: 'All sessions', icon: IconLayers },
  { id: 'active', label: 'Active', icon: IconCircleDot },
  { id: 'archived', label: 'Archived', icon: IconArchive },
  { id: 'transcript-only', label: 'Transcript only', icon: IconFileText },
  { id: 'problems', label: 'Metadata only / Problems', icon: IconAlert }
]

export function Sidebar(): ReactElement {
  const snapshot = useAppState((s) => s.snapshot)
  const view = useAppState((s) => s.view)
  const process = useAppState((s) => s.process)
  const checking = useAppState((s) => s.processChecking)
  const appInfo = useAppState((s) => s.appInfo)
  const [projectsOpen, setProjectsOpen] = useState(true)

  const sessions = useMemo(() => snapshot?.sessions ?? [], [snapshot])
  const counts = useMemo(() => filterCounts(sessions), [sessions])
  const projects = useMemo(() => projectsOf(sessions), [sessions])
  const totalSize = useMemo(() => sessions.reduce((n, s) => n + s.totalSize, 0), [sessions])

  const activeFilter = view.kind === 'sessions' && !view.project ? view.filter : null
  const activeProject = view.kind === 'sessions' ? view.project : undefined

  return (
    <aside className="sidebar">
      <div className="brand">
        <AppMark size={30} />
        <div className="brand-text">
          <div className="brand-name">Claude Local Session Manager</div>
          <div className="brand-sub">Unofficial · local only</div>
        </div>
      </div>

      <nav className="nav">
        <div className="nav-label">Sessions</div>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`nav-item ${activeFilter === f.id ? 'active' : ''}`}
            onClick={() => setView({ kind: 'sessions', filter: f.id })}
          >
            <f.icon size={15} />
            <span className="nav-text">{f.label}</span>
            <span className="nav-count">{snapshot ? counts[f.id] : '…'}</span>
          </button>
        ))}

        <button className="nav-label nav-label-button" onClick={() => setProjectsOpen(!projectsOpen)}>
          <IconChevron size={12} className={`chev ${projectsOpen ? 'open' : ''}`} />
          Projects
          <span className="nav-label-count">{projects.length}</span>
        </button>
        {projectsOpen && (
          <div className="nav-projects">
            {projects.map((p) => (
              <button
                key={p.key}
                className={`nav-item nav-project ${activeProject === p.key ? 'active' : ''}`}
                onClick={() => setView({ kind: 'sessions', filter: 'all', project: p.key })}
                title={`${p.path ?? p.name}\n${p.count} session(s) · ${formatBytes(p.totalSize)}`}
              >
                <IconFolder size={14} />
                <span className="nav-text">{p.name}</span>
                <span className="nav-count">{p.count}</span>
              </button>
            ))}
            {snapshot && projects.length === 0 && <div className="nav-empty">No projects found</div>}
          </div>
        )}
      </nav>

      <div className="sidebar-bottom">
        <button className={`nav-item ${view.kind === 'storage' ? 'active' : ''}`} onClick={() => setView({ kind: 'storage' })}>
          <IconDatabase size={15} />
          <span className="nav-text">Storage</span>
          <span className="nav-count">{snapshot ? formatBytes(totalSize) : ''}</span>
        </button>
        <button className={`nav-item ${view.kind === 'settings' ? 'active' : ''}`} onClick={() => setView({ kind: 'settings' })}>
          <IconSettings size={15} />
          <span className="nav-text">Settings</span>
        </button>

        <div className="status-block">
          <div className={`proc-pill ${!process ? 'unknown' : process.error ? 'warn' : process.desktopRunning ? 'warn' : 'ok'}`}>
            <span className="proc-dot" />
            <span className="proc-text">
              {!process
                ? 'Checking Claude…'
                : process.error
                  ? 'Claude status unknown'
                  : process.desktopRunning
                    ? 'Claude Desktop running'
                    : 'Claude Desktop closed'}
            </span>
            <button
              className="icon-btn tiny"
              title="Refresh process status"
              onClick={() => void refreshProcess(true)}
              disabled={checking}
            >
              <IconRefresh size={13} className={checking ? 'spin' : ''} />
            </button>
          </div>
          {process && process.liveSessions.some((l) => l.alive) && (
            <div className="proc-sub">
              {process.liveSessions.filter((l) => l.alive).length} Claude Code session(s) open
            </div>
          )}
          {appInfo?.dryRun && <div className="dry-pill">DRY RUN</div>}
        </div>
      </div>
    </aside>
  )
}
