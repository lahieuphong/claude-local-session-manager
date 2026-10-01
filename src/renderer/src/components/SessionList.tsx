import { memo, useEffect, useMemo, useRef, type ReactElement } from 'react'
import type { ClaudeSession } from '../../../shared/types'
import { formatBytes, formatRelative } from '../../../shared/format'
import {
  bulkArchive,
  bulkHideInManager,
  exportMany,
  openDelete,
  refresh,
  select,
  setChecked,
  setGroupBy,
  setSearch,
  setSort,
  toggleChecked,
  useAppState,
  type GroupBy,
  type SortKey
} from '../stores/appStore'
import { groupSessions, matchesFilter, matchesSearch, projectsOf, sortSessions } from '../../../shared/sessionQuery'
import { SessionBadges } from './Badges'
import { IconArchive, IconDownload, IconEye, IconEyeOff, IconRefresh, IconRestore, IconSearch, IconTrash, IconX } from './Icons'

const FILTER_TITLES = {
  all: 'All sessions',
  active: 'Active sessions',
  archived: 'Archived in Claude',
  hidden: 'Hidden in manager',
  'transcript-only': 'Transcript-only sessions',
  problems: 'Metadata only / Problems'
} as const

export function SessionList(): ReactElement {
  const snapshot = useAppState((s) => s.snapshot)
  const view = useAppState((s) => s.view)
  const search = useAppState((s) => s.search)
  const sort = useAppState((s) => s.sort)
  const groupBy = useAppState((s) => s.groupBy)
  const checked = useAppState((s) => s.checked)
  const selectedId = useAppState((s) => s.selectedId)
  const scanning = useAppState((s) => s.scanning)
  const busy = useAppState((s) => s.busy)
  const loadError = useAppState((s) => s.loadError)
  const searchRef = useRef<HTMLInputElement>(null)

  const filter = view.kind === 'sessions' ? view.filter : 'all'
  const project = view.kind === 'sessions' ? view.project : undefined

  const all = useMemo(() => snapshot?.sessions ?? [], [snapshot])
  const projectName = useMemo(() => (project ? projectsOf(all).find((p) => p.key === project)?.label : undefined), [all, project])
  const visible = useMemo(() => {
    const filtered = all.filter((s) => matchesFilter(s, filter) && (!project || s.projectKey === project) && matchesSearch(s, search))
    return sortSessions(filtered, sort)
  }, [all, filter, project, search, sort])
  const groups = useMemo(() => groupSessions(visible, sort.startsWith('updated') ? groupBy : groupBy === 'date' ? 'none' : groupBy), [visible, groupBy, sort])

  const checkedSet = useMemo(() => new Set(checked), [checked])
  const allVisibleChecked = visible.length > 0 && visible.every((s) => checkedSet.has(s.id))
  const checkedSessions = useMemo(() => all.filter((s) => checkedSet.has(s.id)), [all, checkedSet])
  const ids = (list: typeof checkedSessions): string[] => list.map((s) => s.id)
  const selDesktopActive = ids(checkedSessions.filter((s) => s.hasMetadata && !s.archived))
  const selDesktopArchived = ids(checkedSessions.filter((s) => s.hasMetadata && s.archived))
  const selHideable = ids(checkedSessions.filter((s) => !s.hasMetadata && !s.hiddenInManager))
  const selHidden = ids(checkedSessions.filter((s) => s.hiddenInManager))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === 'F5') {
        e.preventDefault()
        void refresh()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Keyboard navigation within the visible list.
  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const flat = groups.flatMap((g) => g.sessions)
    const i = flat.findIndex((s) => s.id === selectedId)
    const next = e.key === 'ArrowDown' ? Math.min(flat.length - 1, i + 1) : Math.max(0, i - 1)
    if (flat[next]) {
      select(flat[next].id)
      document.getElementById(`row-${flat[next].id}`)?.scrollIntoView({ block: 'nearest' })
    }
  }

  return (
    <section className="list-pane">
      <header className="list-header">
        <div className="list-title-row">
          <h1 className="page-title">{projectName ?? FILTER_TITLES[filter]}</h1>
          <span className="muted small">
            {snapshot ? `${visible.length} of ${all.length}` : ''}
          </span>
          <div className="spacer" />
          <button className="btn ghost" onClick={() => void refresh()} disabled={scanning} title="Rescan (F5)">
            <IconRefresh size={14} className={scanning ? 'spin' : ''} />
            {scanning ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
        <div className="toolbar">
          <label className="search">
            <IconSearch size={14} />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, prompt, project, path or session ID   (Ctrl+F)"
              spellCheck={false}
            />
            {search && (
              <button className="icon-btn tiny" onClick={() => setSearch('')} title="Clear search">
                <IconX size={12} />
              </button>
            )}
          </label>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} title="Sort">
            <option value="updated-desc">Recently updated</option>
            <option value="updated-asc">Oldest</option>
            <option value="title">Title A–Z</option>
            <option value="size-desc">Largest</option>
            <option value="size-asc">Smallest</option>
          </select>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} title="Group">
            <option value="date">Group by date</option>
            <option value="project">Group by project</option>
            <option value="none">No grouping</option>
          </select>
        </div>
      </header>

      {checked.length > 0 && (
        <div className="bulk-bar">
          <span className="bulk-count">{checked.length} selected</span>
          {/* Claude archive only applies to sessions with Claude Desktop metadata. */}
          {selDesktopActive.length > 0 && (
            <button className="btn small" disabled={busy} onClick={() => void bulkArchive(selDesktopActive, true)} title="Set Claude Desktop's isArchived flag">
              <IconArchive size={13} /> Archive ({selDesktopActive.length})
            </button>
          )}
          {selDesktopArchived.length > 0 && (
            <button className="btn small" disabled={busy} onClick={() => void bulkArchive(selDesktopArchived, false)}>
              <IconRestore size={13} /> Restore ({selDesktopArchived.length})
            </button>
          )}
          {/* Manager-only hiding for sessions Claude cannot archive. */}
          {selHideable.length > 0 && (
            <button
              className="btn small"
              disabled={busy}
              onClick={() => void bulkHideInManager(selHideable, true)}
              title="Hide in this manager only; Claude's files and archive state are not modified"
            >
              <IconEyeOff size={13} /> Hide in manager ({selHideable.length})
            </button>
          )}
          {selHidden.length > 0 && (
            <button className="btn small" disabled={busy} onClick={() => void bulkHideInManager(selHidden, false)}>
              <IconEye size={13} /> Show in manager ({selHidden.length})
            </button>
          )}
          <button
            className="btn small"
            disabled={busy || !checkedSessions.some((s) => s.hasTranscript)}
            onClick={() => void exportMany(checked, ['jsonl', 'info'])}
            title="Copy raw JSONL + session info JSON into a folder you choose"
          >
            <IconDownload size={13} /> Export
          </button>
          <button className="btn small danger" disabled={busy} onClick={() => openDelete(checked, true)}>
            <IconTrash size={13} /> Delete permanently
          </button>
          <div className="spacer" />
          <button className="btn small ghost" onClick={() => setChecked([])}>
            Clear
          </button>
        </div>
      )}

      <div className="list-scroll" tabIndex={0} onKeyDown={onListKey}>
        {visible.length > 0 && (
          <label className="select-all">
            <input
              type="checkbox"
              checked={allVisibleChecked}
              onChange={() => setChecked(allVisibleChecked ? checked.filter((id) => !visible.some((s) => s.id === id)) : [...checked, ...visible.map((s) => s.id)])}
            />
            Select all visible
          </label>
        )}
        {groups.map((g) => (
          <div key={g.key} className="group">
            {g.label && (
              <div className="group-label">
                {g.label} <span className="muted">{g.sessions.length}</span>
              </div>
            )}
            {g.sessions.map((s) => (
              <SessionRow key={s.id} session={s} selected={s.id === selectedId} checked={checkedSet.has(s.id)} showProject={groupBy !== 'project'} />
            ))}
          </div>
        ))}
        {snapshot && visible.length === 0 && (
          <div className="empty">
            {search ? <>No sessions match “{search}”.</> : 'No sessions in this view.'}
          </div>
        )}
        {!snapshot && !loadError && <div className="empty">Scanning Claude storage…</div>}
        {loadError && <div className="empty error-text">{loadError}</div>}
      </div>
    </section>
  )
}

const SessionRow = memo(function SessionRow({
  session: s,
  selected,
  checked,
  showProject
}: {
  session: ClaudeSession
  selected: boolean
  checked: boolean
  showProject: boolean
}): ReactElement {
  return (
    <div id={`row-${s.id}`} className={`row ${selected ? 'selected' : ''} ${checked ? 'checked' : ''}`} onClick={() => select(s.id)}>
      <input
        type="checkbox"
        className="row-check"
        checked={checked}
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleChecked(s.id)}
        aria-label="Select session"
      />
      <div className="row-main">
        <div className="row-top">
          <span className={`row-title ${s.titleSource === 'untitled' ? 'untitled' : ''}`} title={s.displayTitle}>
            {s.displayTitle}
          </span>
          <span className="row-size">{formatBytes(s.totalSize)}</span>
        </div>
        <div className="row-bottom">
          <span className="row-meta">
            {showProject && <span className="row-project">{s.projectName}</span>}
            {showProject && <span className="sep">·</span>}
            <span title={s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ''}>{formatRelative(s.updatedAt)}</span>
            {s.model && (
              <>
                <span className="sep">·</span>
                <span className="row-model">{s.model.replace(/^claude-/, '')}</span>
              </>
            )}
          </span>
          <SessionBadges session={s} compact />
        </div>
      </div>
    </div>
  )
})
