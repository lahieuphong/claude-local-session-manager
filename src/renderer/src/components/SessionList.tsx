import { memo, useCallback, useEffect, useId, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClaudeSession } from '../../../shared/types'
import { useFmt, type Formatters } from '../i18n'
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
import { groupSessions, matchesFilter, matchesSearch, projectsOf, sortSessions, type SessionGroup } from '../../../shared/sessionQuery'
import { SessionBadges } from './Badges'
import { EmptyState, SkeletonRows } from './EmptyState'
import {
  IconAlert,
  IconArchive,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconLayers,
  IconRefresh,
  IconRestore,
  IconSearch,
  IconTrash,
  IconX
} from './Icons'

const SORTS: SortKey[] = ['updated-desc', 'updated-asc', 'title', 'size-desc', 'size-asc']
const GROUPS: GroupBy[] = ['date', 'project', 'none']

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/** Session title for display; the "Untitled" fallback is translated. */
export function useSessionTitle(): (s: Pick<ClaudeSession, 'displayTitle' | 'titleSource'>) => string {
  const { t } = useTranslation()
  return (s) => (s.titleSource === 'untitled' ? t('sessions:untitled') : s.displayTitle)
}

export function SessionList(): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
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
  const listRef = useRef<HTMLDivElement>(null)
  const titleOf = useSessionTitle()

  const filter = view.kind === 'sessions' ? view.filter : 'all'
  const project = view.kind === 'sessions' ? view.project : undefined

  const all = useMemo(() => snapshot?.sessions ?? [], [snapshot])
  const projectName = useMemo(() => {
    if (!project) return undefined
    return project === 'unresolved' ? t('sessions:unknownProject') : projectsOf(all).find((p) => p.key === project)?.label
  }, [all, project, t])
  const visible = useMemo(() => {
    const filtered = all.filter((s) => matchesFilter(s, filter) && (!project || s.projectKey === project) && matchesSearch(s, search))
    return sortSessions(filtered, sort)
  }, [all, filter, project, search, sort])
  const groups = useMemo(() => groupSessions(visible, sort.startsWith('updated') ? groupBy : groupBy === 'date' ? 'none' : groupBy), [visible, groupBy, sort])

  const checkedSet = useMemo(() => new Set(checked), [checked])
  const allVisibleChecked = visible.length > 0 && visible.every((s) => checkedSet.has(s.id))
  const someVisibleChecked = visible.some((s) => checkedSet.has(s.id))
  const checkedSessions = useMemo(() => all.filter((s) => checkedSet.has(s.id)), [all, checkedSet])
  const ids = (list: typeof checkedSessions): string[] => list.map((s) => s.id)
  const selDesktopActive = ids(checkedSessions.filter((s) => s.hasMetadata && !s.archived))
  const selDesktopArchived = ids(checkedSessions.filter((s) => s.hasMetadata && s.archived))
  const selHideable = ids(checkedSessions.filter((s) => !s.hasMetadata && !s.hiddenInManager))
  const selHidden = ids(checkedSessions.filter((s) => s.hiddenInManager))

  // Search shortcuts: Ctrl+K / Ctrl+F anywhere, "/" when not typing. F5 rescans.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (document.getElementById('root')?.hasAttribute('inert')) return // a dialog is open
      const key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (key === 'k' || key === 'f')) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
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

  // Arrow keys move between rows (focus follows selection).
  const onRowKey = useCallback((e: ReactKeyboardEvent<HTMLButtonElement>, id: string): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    e.preventDefault()
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.row-main') ?? [])]
    const i = rows.findIndex((r) => r.dataset.id === id)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)
    const target = rows[next]
    if (target?.dataset.id) {
      select(target.dataset.id)
      target.focus()
      target.scrollIntoView({ block: 'nearest' })
    }
  }, [])

  const pageTitle = projectName ?? t(`sessions:title.${filter}`)
  const countText = snapshot ? t('sessions:count', { shown: fmt.count(visible.length), total: fmt.count(all.length) }) : ''

  return (
    <section className="list-pane" aria-label={pageTitle}>
      <header className="list-header">
        <div className="list-title-row">
          <h1 className="page-title" title={pageTitle}>
            {pageTitle}
          </h1>
          <span className="count-label">{countText}</span>
          <div className="spacer" />
          <button className="btn quiet" onClick={() => void refresh()} disabled={scanning} title={t('sessions:refreshHint')}>
            <IconRefresh size={14} className={scanning ? 'spin' : ''} />
            {scanning ? t('sessions:scanning') : t('common:action.refresh')}
          </button>
        </div>
        <div className="command-row">
          <div className="search" role="search">
            <IconSearch size={16} />
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && search) {
                  e.preventDefault()
                  setSearch('')
                }
              }}
              placeholder={t('sessions:search.placeholder')}
              aria-label={t('sessions:search.label')}
              spellCheck={false}
              autoComplete="off"
            />
            {search ? (
              <button className="icon-btn" onClick={() => setSearch('')} title={t('sessions:search.clear')} aria-label={t('sessions:search.clear')}>
                <IconX size={14} />
              </button>
            ) : (
              <kbd className="kbd" aria-hidden="true">
                Ctrl K
              </kbd>
            )}
          </div>
          <label className="select-wrap">
            <span className="visually-hidden">{t('sessions:sort.label')}</span>
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {t(`sessions:sort.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="select-wrap">
            <span className="visually-hidden">{t('sessions:group.label')}</span>
            <select className="select" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              {GROUPS.map((g) => (
                <option key={g} value={g}>
                  {t(`sessions:group.${g}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {checked.length > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label={t('sessions:bulk.label')}>
          <span className="bulk-count">{t('sessions:bulk.selected', { count: checked.length })}</span>
          {/* Claude archive only applies to sessions with Claude Desktop metadata. */}
          {selDesktopActive.length > 0 && (
            <button className="btn small" disabled={busy} onClick={() => void bulkArchive(selDesktopActive, true)} title={t('sessions:bulk.archiveHint')}>
              <IconArchive size={14} /> {t('sessions:bulk.archive', { count: selDesktopActive.length })}
            </button>
          )}
          {selDesktopArchived.length > 0 && (
            <button className="btn small" disabled={busy} onClick={() => void bulkArchive(selDesktopArchived, false)}>
              <IconRestore size={14} /> {t('sessions:bulk.restore', { count: selDesktopArchived.length })}
            </button>
          )}
          {/* Manager-only hiding for sessions Claude cannot archive. */}
          {selHideable.length > 0 && (
            <button className="btn small" disabled={busy} onClick={() => void bulkHideInManager(selHideable, true)} title={t('sessions:bulk.hideHint')}>
              <IconEyeOff size={14} /> {t('sessions:bulk.hide', { count: selHideable.length })}
            </button>
          )}
          {selHidden.length > 0 && (
            <button className="btn small" disabled={busy} onClick={() => void bulkHideInManager(selHidden, false)}>
              <IconEye size={14} /> {t('sessions:bulk.show', { count: selHidden.length })}
            </button>
          )}
          <button
            className="btn small"
            disabled={busy || !checkedSessions.some((s) => s.hasTranscript)}
            onClick={() => void exportMany(checked, ['jsonl', 'info'])}
            title={t('sessions:bulk.exportHint')}
          >
            <IconDownload size={14} /> {t('common:action.export')}
          </button>
          <button className="btn small danger" disabled={busy} onClick={() => openDelete(checked, true)}>
            <IconTrash size={14} /> {t('common:action.deletePermanently')}
          </button>
          <div className="spacer" />
          <button className="btn small quiet" onClick={() => setChecked([])}>
            {t('sessions:bulk.clear')}
          </button>
        </div>
      )}

      <div className="list-columns">
        <input
          type="checkbox"
          className="row-check"
          checked={allVisibleChecked}
          ref={(el) => {
            if (el) el.indeterminate = !allVisibleChecked && someVisibleChecked
          }}
          disabled={visible.length === 0}
          onChange={() =>
            setChecked(allVisibleChecked ? checked.filter((id) => !visible.some((s) => s.id === id)) : [...checked, ...visible.map((s) => s.id)])
          }
          aria-label={t('sessions:selectAllVisible')}
          title={t('sessions:selectAllVisible')}
        />
        <span className="col-label">{t('sessions:column.session')}</span>
        <span className="col-label col-updated">{t('sessions:column.updated')}</span>
        <span className="col-label col-size">{t('sessions:column.size')}</span>
      </div>

      <div className="list-scroll" ref={listRef}>
        {groups.map((g) => (
          <Group key={g.key} group={g} selectedId={selectedId} checkedSet={checkedSet} showProject={groupBy !== 'project'} onRowKey={onRowKey} fmt={fmt} titleOf={titleOf} />
        ))}
        {snapshot && visible.length === 0 && (
          <EmptyState
            icon={search ? <IconSearch size={18} /> : <IconLayers size={18} />}
            title={search ? t('sessions:empty.noMatchTitle', { query: search }) : t('sessions:empty.viewTitle')}
            hint={search ? t('sessions:empty.noMatchHint') : t('sessions:empty.viewHint')}
            action={
              search ? (
                <button className="btn small" onClick={() => setSearch('')}>
                  {t('sessions:search.clear')}
                </button>
              ) : undefined
            }
          />
        )}
        {!snapshot && !loadError && (
          <>
            <div className="visually-hidden" role="status">
              {t('sessions:loading')}
            </div>
            <SkeletonRows />
          </>
        )}
        {loadError && <EmptyState tone="error" icon={<IconAlert size={18} />} title={t('sessions:loadFailed')} hint={<span className="mono">{loadError}</span>} />}
      </div>
    </section>
  )
}

function Group({
  group: g,
  selectedId,
  checkedSet,
  showProject,
  onRowKey,
  fmt,
  titleOf
}: {
  group: SessionGroup
  selectedId: string | null
  checkedSet: Set<string>
  showProject: boolean
  onRowKey(e: ReactKeyboardEvent<HTMLButtonElement>, id: string): void
  fmt: Formatters
  titleOf(s: ClaudeSession): string
}): ReactElement {
  const { t } = useTranslation()
  const headingId = useId()
  const label =
    g.kind === 'date' ? t(`sessions:dateGroup.${g.key}`) : g.kind === 'project' ? (g.key === 'unresolved' ? t('sessions:unknownProject') : g.label) : ''
  return (
    <section className="group" aria-labelledby={label ? headingId : undefined}>
      {label && (
        <h2 className="group-label" id={headingId}>
          <span className="group-name">{label}</span>
          <span className="group-count">{fmt.count(g.sessions.length)}</span>
        </h2>
      )}
      <div role="list">
        {g.sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            selected={s.id === selectedId}
            checked={checkedSet.has(s.id)}
            showProject={showProject}
            onKey={onRowKey}
            fmt={fmt}
            title={titleOf(s)}
          />
        ))}
      </div>
    </section>
  )
}

const SessionRow = memo(function SessionRow({
  session: s,
  selected,
  checked,
  showProject,
  onKey,
  fmt,
  title
}: {
  session: ClaudeSession
  selected: boolean
  checked: boolean
  showProject: boolean
  onKey(e: ReactKeyboardEvent<HTMLButtonElement>, id: string): void
  fmt: Formatters
  title: string
}): ReactElement {
  const { t } = useTranslation()
  const project = s.projectKey === 'unresolved' ? t('sessions:unknownProject') : s.projectName
  return (
    <div role="listitem" id={`row-${s.id}`} className={`row ${selected ? 'selected' : ''} ${checked ? 'checked' : ''}`}>
      <input
        type="checkbox"
        className="row-check"
        checked={checked}
        onChange={() => toggleChecked(s.id)}
        aria-label={t('sessions:row.select', { title })}
      />
      <button
        className="row-main"
        data-id={s.id}
        aria-current={selected ? 'true' : undefined}
        onClick={() => select(s.id)}
        onKeyDown={(e) => onKey(e, s.id)}
      >
        <span className={`row-title ${s.titleSource === 'untitled' ? 'untitled' : ''}`} title={title}>
          {title}
        </span>
        <span className="row-meta">
          {showProject && <span className="row-project">{project}</span>}
          {s.model && <span className="row-model">{s.model.replace(/^claude-/, '')}</span>}
          <SessionBadges session={s} compact />
        </span>
        <span className="row-updated" title={fmt.dateTime(s.updatedAt)}>
          {fmt.relative(s.updatedAt)}
        </span>
        <span className="row-size">{fmt.bytes(s.totalSize)}</span>
      </button>
    </div>
  )
})
