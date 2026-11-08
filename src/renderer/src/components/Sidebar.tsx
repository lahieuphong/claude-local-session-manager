import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../i18n'
import { setView, useAppState, visibleSessions, type SessionFilter } from '../stores/appStore'
import { UpdatePill } from './Updates'
import { appBrand } from '../../../shared/appIdentity'
import { filterCounts, projectsOf } from '../../../shared/sessionQuery'
import {
  AppMark,
  IconAlert,
  IconArchive,
  IconChevron,
  IconCircleDot,
  IconDatabase,
  IconEyeOff,
  IconFileText,
  IconFolder,
  IconLayers,
  IconSettings
} from './Icons'

const FILTERS: Array<{ id: SessionFilter; icon: (p: { size?: number }) => ReactElement }> = [
  { id: 'all', icon: IconLayers },
  { id: 'active', icon: IconCircleDot },
  { id: 'archived', icon: IconArchive },
  { id: 'hidden', icon: IconEyeOff },
  { id: 'transcript-only', icon: IconFileText },
  { id: 'problems', icon: IconAlert }
]

export function Sidebar(): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  const snapshot = useAppState((s) => s.snapshot)
  const view = useAppState((s) => s.view)
  const process = useAppState((s) => s.process)
  const appInfo = useAppState((s) => s.appInfo)
  const [projectsOpen, setProjectsOpen] = useState(true)
  // The product name depends on the distribution (the Microsoft Store edition has its own).
  const brand = appInfo ? appBrand(appInfo.distribution) : null

  const sessions = useAppState(visibleSessions)
  const counts = useMemo(() => filterCounts(sessions), [sessions])
  // One entry per canonical workspace; hidden sessions are not counted.
  const projects = useMemo(() => projectsOf(sessions.filter((s) => !s.hiddenInManager)), [sessions])
  const totalSize = useMemo(() => sessions.reduce((n, s) => n + s.totalSize, 0), [sessions])
  // With several accounts, like every other number here: the account on screen (as in its menu).
  const severalAccounts = (snapshot?.roots.accounts.length ?? 0) > 1
  const liveCount = severalAccounts ? sessions.filter((s) => s.live).length : (process?.liveSessions.filter((l) => l.alive).length ?? 0)

  const activeFilter = view.kind === 'sessions' && !view.project ? view.filter : null
  const activeProject = view.kind === 'sessions' ? view.project : undefined

  return (
    <aside className="sidebar" aria-label={t('common:nav.sidebar')}>
      <div className="identity">
        <AppMark size={28} />
        <div className="identity-text">
          <div className="identity-name">{brand?.short}</div>
          <div className="identity-sub">{brand?.sub}</div>
        </div>
      </div>
      <div className="identity-note">{t('common:app.tagline')}</div>

      <nav className="nav" aria-label={t('common:nav.sessions')}>
        <div className="nav-label">{t('common:nav.sessions')}</div>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`nav-item ${activeFilter === f.id ? 'active' : ''}`}
            aria-current={activeFilter === f.id ? 'page' : undefined}
            onClick={() => setView({ kind: 'sessions', filter: f.id })}
            title={t(`sessions:filter.${f.id}`)}
          >
            <f.icon size={16} />
            <span className="nav-text">{t(`sessions:filter.${f.id}`)}</span>
            <span className="nav-count">{snapshot ? fmt.count(counts[f.id]) : ''}</span>
          </button>
        ))}

        <button className="nav-label nav-label-button" aria-expanded={projectsOpen} onClick={() => setProjectsOpen(!projectsOpen)}>
          <IconChevron size={12} className={`chev ${projectsOpen ? 'open' : ''}`} />
          <span>{t('common:nav.projects')}</span>
          <span className="nav-label-count">{snapshot ? fmt.count(projects.length) : ''}</span>
        </button>
        {projectsOpen && (
          <div className="nav-projects">
            {projects.map((p) => {
              const label = p.key === 'unresolved' ? t('sessions:unknownProject') : p.label
              return (
                <button
                  key={p.key}
                  className={`nav-item nav-project ${activeProject === p.key ? 'active' : ''}`}
                  aria-current={activeProject === p.key ? 'page' : undefined}
                  onClick={() => setView({ kind: 'sessions', filter: 'all', project: p.key })}
                  title={`${p.path ?? t('sessions:unknownWorkspacePath')}\n${t('common:nav.projectTooltip', { count: p.count, size: fmt.bytes(p.totalSize) })}`}
                >
                  <IconFolder size={14} />
                  <span className="nav-text">{label}</span>
                  <span className="nav-count">{fmt.count(p.count)}</span>
                </button>
              )
            })}
            {snapshot && projects.length === 0 && <div className="nav-empty">{t('common:nav.noProjects')}</div>}
          </div>
        )}
      </nav>

      <div className="sidebar-bottom">
        <button
          className={`nav-item ${view.kind === 'storage' ? 'active' : ''}`}
          aria-current={view.kind === 'storage' ? 'page' : undefined}
          onClick={() => setView({ kind: 'storage' })}
        >
          <IconDatabase size={16} />
          <span className="nav-text">{t('common:nav.storage')}</span>
          <span className="nav-count">{snapshot ? fmt.bytes(totalSize) : ''}</span>
        </button>
        <button
          className={`nav-item ${view.kind === 'settings' ? 'active' : ''}`}
          aria-current={view.kind === 'settings' ? 'page' : undefined}
          onClick={() => setView({ kind: 'settings' })}
        >
          <IconSettings size={16} />
          <span className="nav-text">{t('common:nav.settings')}</span>
        </button>

        <div className="sidebar-status">
          <UpdatePill />
          {liveCount > 0 && <div className="sidebar-status-line">{t('common:status.liveSessions', { count: liveCount })}</div>}
          <div className="sidebar-version mono">{appInfo ? `v${appInfo.version}` : ''}</div>
        </div>
      </div>
    </aside>
  )
}
