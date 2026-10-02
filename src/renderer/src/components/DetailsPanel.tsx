import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClaudeSession, ExportFormat, RawTitle, SessionDetails } from '../../../shared/types'
import { useFmt } from '../i18n'
import { archive, copyToClipboard, errText, exportOne, hideInManager, openDelete, runAction, useAppState } from '../stores/appStore'
import { displayPath } from '../utils/paths'
import { SessionBadges } from './Badges'
import { EmptyState } from './EmptyState'
import {
  IconAlert,
  IconArchive,
  IconChevron,
  IconCopy,
  IconDownload,
  IconExternal,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconInfo,
  IconRestore,
  IconTrash
} from './Icons'
import { useSessionTitle } from './SessionList'

const api = (): Window['sessionManager'] => window.sessionManager

export function DetailsPanel(): ReactElement {
  const { t } = useTranslation()
  const selectedId = useAppState((s) => s.selectedId)
  const snapshot = useAppState((s) => s.snapshot)
  const session = snapshot?.sessions.find((s) => s.id === selectedId) ?? null
  const [details, setDetails] = useState<SessionDetails | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    if (!selectedId) {
      setDetails(null)
      return
    }
    api()
      .getSession(selectedId)
      .then((d) => !cancelled && setDetails(d))
      .catch((err) => !cancelled && setError(errText(err)))
    return () => {
      cancelled = true
    }
  }, [selectedId, snapshot])

  if (!session) {
    return (
      <aside className="inspector inspector-empty" aria-label={t('inspector:label')}>
        <EmptyState icon={<IconInfo size={18} />} title={t('inspector:empty.title')} hint={t('inspector:empty.hint')} />
      </aside>
    )
  }
  return <SessionInspector key={session.id} session={session} details={details?.session.id === session.id ? details : null} error={error} />
}

function SessionInspector({ session: s, details, error }: { session: ClaudeSession; details: SessionDetails | null; error: string | null }): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  const settings = useAppState((st) => st.settings)
  const process = useAppState((st) => st.process)
  const busy = useAppState((st) => st.busy)
  const safety = useAppState((st) => st.safety)
  const raw = settings?.showRawPaths ?? false
  const title = useSessionTitle()(s)
  const project = s.projectKey === 'unresolved' ? t('sessions:unknownProject') : s.projectName

  const desktopBlocked = !!process && (process.desktopRunning || !!process.error)
  const live = s.live
  // Claude archive changes Claude Desktop metadata, so it is guarded like delete.
  const archiveBlock = s.hasMetadata && (desktopBlocked || !!live)
  const deleteBlock = desktopBlocked || !!live
  const blockReason = live
    ? t(s.hasMetadata ? 'inspector:block.liveArchive' : 'inspector:block.live', {
        state: t(`sessions:live.state.${live.state}`),
        pid: live.pid,
        name: live.name ? ` · ${live.name}` : ''
      })
    : desktopBlocked
      ? t(process?.error ? 'inspector:block.unknown' : 'inspector:block.desktop')
      : null

  const problems = s.problems

  return (
    <aside className="inspector" aria-label={t('inspector:label')}>
      <div className="inspector-scroll">
        <header className="inspector-header">
          <h2 className={`inspector-title ${s.titleSource === 'untitled' ? 'untitled' : ''}`}>{title}</h2>
          <div className="inspector-sub">
            <SessionBadges session={s} />
            <span className="inspector-sub-text">
              {project} · {fmt.relative(s.updatedAt)} · {fmt.bytes(s.totalSize)}
            </span>
          </div>
        </header>

        <div className="actions" role="toolbar" aria-label={t('inspector:actions')}>
          {s.hasMetadata ? (
            s.archived ? (
              <button className="btn" disabled={busy || archiveBlock} onClick={() => void archive(s.id, false)} title={t('inspector:action.restoreHint')}>
                <IconRestore size={14} /> {t('common:action.restore')}
              </button>
            ) : (
              <button className="btn" disabled={busy || archiveBlock} onClick={() => void archive(s.id, true)} title={t('inspector:action.archiveHint')}>
                <IconArchive size={14} /> {t('common:action.archive')}
              </button>
            )
          ) : s.hiddenInManager ? (
            <button className="btn" disabled={busy} onClick={() => void hideInManager(s.id, false)}>
              <IconEye size={14} /> {t('common:action.showInManager')}
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => void hideInManager(s.id, true)} title={t('inspector:action.hideHint')}>
              <IconEyeOff size={14} /> {t('common:action.hideInManager')}
            </button>
          )}
          <ExportMenu session={s} disabled={busy} />
          <button className="btn" disabled={!s.projectPath} onClick={() => void runAction(() => api().openProject(s.id))} title={t('inspector:action.openProjectHint')}>
            <IconFolder size={14} /> {t('inspector:action.openProject')}
          </button>
          <div className="spacer" />
          <button className="btn danger" disabled={busy || deleteBlock} onClick={() => openDelete([s.id], false)}>
            <IconTrash size={14} /> {t('common:action.deletePermanently')}
          </button>
        </div>
        {blockReason && (
          <div className="notice warn small" role="note">
            <IconAlert size={14} />
            <span>{blockReason}</span>
          </div>
        )}
        {!s.hasMetadata && (
          <div className="notice subtle small" role="note">
            <IconInfo size={14} />
            <span>{t(s.kind === 'cli' ? 'inspector:note.transcriptOnly' : 'inspector:note.orphan')}</span>
          </div>
        )}
        {safety && !safety.dryRun && (
          <div className="notice danger small" role="note">
            <IconAlert size={14} />
            <span>{t('inspector:note.armed')}</span>
          </div>
        )}

        {problems.length > 0 && (
          <Section title={t('inspector:section.problems')} tone="warn">
            <ul className="problem-list">
              {problems.map((p, i) => (
                <li key={i}>{fmt.msg(s.problemMsgs?.[p], p)}</li>
              ))}
            </ul>
          </Section>
        )}

        <Section title={t('inspector:section.overview')}>
          <dl className="kv">
            <KV k={t('inspector:field.displayTitle')} v={title} />
            <KV k={t('inspector:field.titleSource')} v={t(`inspector:titleSource.${s.titleSource}`)} />
            <KV k={t('inspector:field.rawTitle')} v={<RawTitleValue raw={s.rawTitle} />} hint={t('inspector:hint.rawTitle')} />
            {s.customTitle && <KV k={t('inspector:field.customTitle')} v={s.customTitle} />}
            {s.aiTitle && <KV k={t('inspector:field.aiTitle')} v={s.aiTitle} />}
            <KV k={t('inspector:field.created')} v={fmt.dateTime(s.createdAt)} />
            <KV k={t('inspector:field.updated')} v={fmt.dateTime(s.updatedAt)} />
            {live && (
              <KV
                k={t('inspector:field.process')}
                v={
                  <span>
                    {t(`sessions:live.state.${live.state}`)} · <span className="mono">PID {live.pid}</span>
                    {live.status && <span className="muted"> · {live.status}</span>}
                  </span>
                }
              />
            )}
          </dl>
        </Section>

        <Section title={t('inspector:section.project')}>
          <dl className="kv">
            <KV k={t('inspector:field.project')} v={project} />
            <KV
              k={t('inspector:field.projectPath')}
              v={s.projectPath ? <code className="wrap">{s.projectPath}</code> : <span className="muted">{t('inspector:value.unknown')}</span>}
              hint={t('inspector:hint.projectPath')}
            />
            <KV k={t('inspector:field.projectSource')} v={t(`inspector:projectSource.${s.projectSource}`)} />
            {s.projectStorageDir && (
              <KV k={t('inspector:field.storageFolder')} v={<code className="wrap">{displayPath(s.projectStorageDir, raw)}</code>} hint={t('inspector:hint.storageFolder')} />
            )}
          </dl>
        </Section>

        <Section title={t('inspector:section.session')}>
          <dl className="kv">
            <KV k={t('inspector:field.cliSessionId')} v={s.cliSessionId ? <CopyCode value={s.cliSessionId} /> : '—'} />
            {s.desktopSessionId && <KV k={t('inspector:field.desktopSessionId')} v={<CopyCode value={s.desktopSessionId} />} />}
            {s.priorCliSessionIds.length > 0 && <KV k={t('inspector:field.priorIds')} v={<code className="wrap">{s.priorCliSessionIds.join(', ')}</code>} />}
            <KV k={t('inspector:field.internalId')} v={<CopyCode value={s.id} />} hint={t('inspector:hint.internalId')} />
            <KV k={t('inspector:field.model')} v={<span className="mono">{s.models.length > 1 ? s.models.join(', ') : s.model ?? '—'}</span>} />
            {s.claudeVersion && <KV k={t('inspector:field.claudeCode')} v={<span className="mono">{`${s.claudeVersion}${s.entrypoint ? ` · ${s.entrypoint}` : ''}`}</span>} />}
            {s.gitBranch && <KV k={t('inspector:field.gitBranch')} v={<span className="mono">{s.gitBranch}</span>} />}
          </dl>
        </Section>

        <Section title={t('inspector:section.storage')}>
          <dl className="kv">
            <KV k={t('inspector:field.totalSize')} v={<strong>{fmt.bytes(s.totalSize)}</strong>} />
            {s.transcriptSize !== undefined && <KV k={t('inspector:size.transcript')} v={fmt.bytes(s.transcriptSize)} />}
            {s.sessionDataSize !== undefined && <KV k={t('inspector:size.sessionData')} v={fmt.bytes(s.sessionDataSize)} />}
            {s.metadataSize !== undefined && <KV k={t('inspector:size.metadata')} v={fmt.bytes(s.metadataSize)} />}
            {s.otherSize !== undefined && <KV k={t('inspector:size.other')} v={fmt.bytes(s.otherSize)} />}
          </dl>
        </Section>

        <Section title={t('inspector:section.files')}>
          <PathRow label={t('inspector:file.metadata')} path={s.metadataFile} raw={raw} size={s.metadataSize} onReveal={() => runAction(() => api().revealMetadata(s.id))} />
          <PathRow label={t('inspector:file.transcript')} path={s.transcriptFile} raw={raw} size={s.transcriptSize} onReveal={() => runAction(() => api().revealTranscript(s.id))} />
          <PathRow label={t('inspector:file.sessionData')} path={s.sessionDataDirectory} raw={raw} size={s.sessionDataSize} onReveal={() => runAction(() => api().revealSessionData(s.id))} />
          {s.extraSessionDataDirectories.map((p) => (
            <PathRow key={p} label={t('inspector:file.sessionDataOther')} path={p} raw={raw} />
          ))}
          {s.extraTranscriptFiles.map((p) => (
            <PathRow key={p} label={t('inspector:file.priorTranscript')} path={p} raw={raw} />
          ))}
          {s.legacySubagentLogs.map((p) => (
            <PathRow key={p} label={t('inspector:file.subagentLog')} path={p} raw={raw} />
          ))}
          {s.fileHistoryDirectory && <PathRow label={t('inspector:file.fileHistory')} path={s.fileHistoryDirectory} raw={raw} />}
          {s.sessionEnvDirectory && <PathRow label={t('inspector:file.sessionEnv')} path={s.sessionEnvDirectory} raw={raw} />}
        </Section>

        <Section title={t('inspector:section.activity')}>
          <div className="metric-row" title={t('inspector:hint.messages')}>
            <Metric label={t('inspector:metric.prompts')} value={fmt.count(s.userMessageCount)} />
            <Metric label={t('inspector:metric.assistant')} value={fmt.count(s.assistantMessageCount)} />
            <Metric label={t('inspector:metric.tools')} value={fmt.count(s.toolUseCount)} />
            <Metric label={t('inspector:metric.records')} value={fmt.count(s.transcriptRecordCount)} />
          </div>
          <div className="preview-label">{t('inspector:preview.first')}</div>
          <div className="preview">{s.firstUserMessage ?? <span className="muted">—</span>}</div>
          <div className="preview-label">{t('inspector:preview.last')}</div>
          <div className="preview">{s.lastUserMessage ?? s.lastPrompt ?? <span className="muted">—</span>}</div>
        </Section>

        <Collapsible title={t('inspector:section.rawMetadata')}>
          {error && <div className="notice error small">{error}</div>}
          {!s.hasMetadata ? (
            <div className="hint">{t('inspector:raw.none')}</div>
          ) : !details ? (
            <div className="hint">{t('common:loading')}</div>
          ) : (
            <>
              {details.rawMetadataError && <div className="notice error small">{details.rawMetadataError}</div>}
              {details.tombstones.length > 0 && (
                <div className="notice subtle small">
                  {t('inspector:raw.tombstones')} <span className="mono">{details.tombstones.join(', ')}</span>
                </div>
              )}
              <pre className="code-block">{details.rawMetadata}</pre>
            </>
          )}
        </Collapsible>

        {settings?.debugMode && (
          <Collapsible title={t('inspector:section.debug')}>
            <pre className="code-block">{JSON.stringify(s, null, 2)}</pre>
          </Collapsible>
        )}
      </div>
    </aside>
  )
}

function Section({ title, children, tone }: { title: string; children: ReactNode; tone?: 'warn' }): ReactElement {
  const id = useId()
  return (
    <section className={`inspector-section ${tone === 'warn' ? 'warn' : ''}`} aria-labelledby={id}>
      <h3 className="section-label" id={id}>
        {title}
      </h3>
      {children}
    </section>
  )
}

function Collapsible({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <details className="inspector-section collapsible">
      <summary className="section-label">
        <IconChevron size={12} className="chev" />
        {title}
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  )
}

function KV({ k, v, hint }: { k: string; v: ReactNode; hint?: string }): ReactElement {
  return (
    <>
      <dt title={hint}>{k}</dt>
      <dd>{v}</dd>
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="metric">
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  )
}

/** Raw `title` field of Claude Desktop metadata. JSON values are shown as-is (never translated). */
function RawTitleValue({ raw }: { raw: RawTitle | undefined }): ReactElement {
  const { t } = useTranslation()
  if (!raw) return <span className="muted">{t('inspector:rawTitle.noFile')}</span>
  switch (raw.kind) {
    case 'missing':
      return <span className="muted">{t('inspector:rawTitle.missing')}</span>
    case 'null':
      return <code>null</code>
    case 'empty':
      return (
        <span>
          <code>{JSON.stringify(raw.value)}</code> <span className="muted">{t(raw.value === '' ? 'inspector:rawTitle.empty' : 'inspector:rawTitle.whitespace')}</span>
        </span>
      )
    case 'string':
      return <code className="wrap">{JSON.stringify(raw.value)}</code>
    case 'invalid':
      return <span className="muted">{t('inspector:rawTitle.invalid', { type: raw.type })}</span>
  }
}

function CopyCode({ value }: { value: string }): ReactElement {
  const { t } = useTranslation()
  return (
    <span className="copy-code">
      <code>{value}</code>
      <button className="icon-btn" title={t('common:action.copy')} aria-label={t('common:action.copyValue', { value })} onClick={() => void copyToClipboard(value)}>
        <IconCopy size={14} />
      </button>
    </span>
  )
}

function PathRow({ label, path, raw, size, onReveal }: { label: string; path?: string; raw: boolean; size?: number; onReveal?: () => void }): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  return (
    <div className={`path-row ${path ? '' : 'missing'}`}>
      <div className="path-head">
        <span className="path-label">{label}</span>
        {size !== undefined && path && <span className="path-size">{fmt.bytes(size)}</span>}
        <div className="spacer" />
        {path && (
          <>
            <button className="icon-btn" title={t('inspector:file.copyPath')} aria-label={t('inspector:file.copyPathOf', { label })} onClick={() => void copyToClipboard(path)}>
              <IconCopy size={14} />
            </button>
            {onReveal && (
              <button className="icon-btn" title={t('inspector:file.reveal')} aria-label={t('inspector:file.revealOf', { label })} onClick={onReveal}>
                <IconExternal size={14} />
              </button>
            )}
          </>
        )}
      </div>
      <div className="path-value mono" title={path}>
        {path ? displayPath(path, raw) : <span className="muted">{t('inspector:file.notPresent')}</span>}
      </div>
    </div>
  )
}

function ExportMenu({ session: s, disabled }: { session: ClaudeSession; disabled: boolean }): ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuId = useId()
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        ref.current?.querySelector<HTMLButtonElement>('.menu-trigger')?.focus()
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    ref.current?.querySelector<HTMLButtonElement>('.menu [role="menuitem"]:not([disabled])')?.focus()
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const pick = (f: ExportFormat): void => {
    setOpen(false)
    void exportOne(s.id, f)
  }
  const onMenuKey = (e: ReactKeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu [role="menuitem"]:not([disabled])') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn menu-trigger" disabled={disabled} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}>
        <IconDownload size={14} /> {t('common:action.export')}
      </button>
      {open && (
        <div className="menu" role="menu" id={menuId} onKeyDown={onMenuKey}>
          <button role="menuitem" disabled={!s.hasTranscript} onClick={() => pick('jsonl')}>
            {t('inspector:export.jsonl')}
          </button>
          <button role="menuitem" onClick={() => pick('info')}>
            {t('inspector:export.info')}
          </button>
          <button role="menuitem" disabled={!s.hasTranscript} onClick={() => pick('markdown')}>
            {t('inspector:export.markdown')}
          </button>
          <div className="menu-note">{t('inspector:export.note')}</div>
        </div>
      )}
    </div>
  )
}
