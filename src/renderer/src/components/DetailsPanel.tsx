import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { resumeCommand } from '../../../shared/terminal'
import type { ClaudeSession, ExportFormat, RawTitle, SessionDetails } from '../../../shared/types'
import { useFmt } from '../i18n'
import { archive, copyToClipboard, errText, exportOne, hasSafeMode, hideInManager, openDelete, runAction, toolContext, useAppState } from '../stores/appStore'
import { resumeInTerminal, useTerminal } from '../stores/terminalStore'
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
  IconTerminal,
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
  const hasMetadata = !!session?.hasMetadata

  // Only the raw metadata section reads these, and a session without metadata does not have it.
  useEffect(() => {
    let cancelled = false
    setError(null)
    if (!selectedId || !hasMetadata) {
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
  }, [selectedId, hasMetadata, snapshot])

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
  const appInfo = useAppState((st) => st.appInfo)
  const accounts = useAppState((st) => st.snapshot?.roots.accounts)
  const codexCli = useAppState((st) => st.snapshot?.roots.codexCli)
  const context = useAppState(toolContext)
  const raw = settings?.showRawPaths ?? false
  // Microsoft Store edition: Claude Desktop's data is read-only for this build (the main process enforces it).
  const storeReadOnly = s.hasMetadata && !!appInfo?.desktopDataReadOnly
  const title = useSessionTitle()(s)
  const project = s.projectKey === 'unresolved' ? t('sessions:unknownProject') : s.projectName

  // Codex: Codex changes its own data when asked (codex archive / delete), which needs its CLI;
  // a session it wrote to a moment ago may still be running. Claude Desktop does not matter here.
  const codex = s.provider === 'codex'
  const cliMissing = codex && !codexCli
  const desktopBlocked = !codex && !!process && (process.desktopRunning || !!process.error)
  const live = s.live
  // Claude archive changes Claude Desktop metadata, so it is guarded like delete.
  const archiveBlock = codex ? !!live || cliMissing : s.hasMetadata && (desktopBlocked || !!live)
  const deleteBlock = codex ? !!live || cliMissing : desktopBlocked || !!live
  const blockReason = codex
    ? live
      ? t('inspector:block.codexRecent')
      : null
    : live
      ? t(s.hasMetadata ? 'inspector:block.liveArchive' : 'inspector:block.live', {
          state: t(`sessions:live.state.${live.state}`),
          pid: live.pid,
          name: live.name ? ` · ${live.name}` : ''
        })
      : desktopBlocked
        ? t(process?.error ? 'inspector:block.unknown' : 'inspector:block.desktop')
        : null

  const problems = s.problems
  const models = s.models.length > 1 ? s.models.join(', ') : s.model
  const firstMessage = s.firstUserMessage
  const lastMessage = s.lastUserMessage ?? s.lastPrompt

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

        <ResumeButton session={s} />
        <div className="actions" role="toolbar" aria-label={t('inspector:actions')}>
          <button className="btn" disabled={!s.projectPath} onClick={() => void runAction(() => api().openProject(s.id))} title={t('inspector:action.openProjectHint')}>
            <IconFolder size={14} /> {t('inspector:action.openProject')}
          </button>
          <ExportMenu session={s} disabled={busy} />
          {codex ? (
            // Codex has its own archive; a session hidden in this app shows the way back first.
            s.hiddenInManager ? (
              <button className="btn state-action" disabled={busy} onClick={() => void hideInManager(s.id, false)} title={t('common:action.showInManager')}>
                <IconEye size={14} /> {t('inspector:action.show')}
              </button>
            ) : s.archived ? (
              <button className="btn state-action" disabled={busy || archiveBlock} onClick={() => void archive(s.id, false)} title={t('inspector:action.restoreHint', { context })}>
                <IconRestore size={14} /> {t('common:action.restore')}
              </button>
            ) : (
              <button className="btn state-action" disabled={busy || archiveBlock} onClick={() => void archive(s.id, true)} title={t('inspector:action.archiveHint', { context })}>
                <IconArchive size={14} /> {t('common:action.archive')}
              </button>
            )
          ) : storeReadOnly ? null : s.hasMetadata ? (
            s.archived ? (
              <button className="btn state-action" disabled={busy || archiveBlock} onClick={() => void archive(s.id, false)} title={t('inspector:action.restoreHint')}>
                <IconRestore size={14} /> {t('common:action.restore')}
              </button>
            ) : (
              <button className="btn state-action" disabled={busy || archiveBlock} onClick={() => void archive(s.id, true)} title={t('inspector:action.archiveHint')}>
                <IconArchive size={14} /> {t('common:action.archive')}
              </button>
            )
          ) : s.hiddenInManager ? (
            <button className="btn state-action" disabled={busy} onClick={() => void hideInManager(s.id, false)} title={t('common:action.showInManager')}>
              <IconEye size={14} /> {t('inspector:action.show')}
            </button>
          ) : (
            <button className="btn state-action" disabled={busy} onClick={() => void hideInManager(s.id, true)} title={t('sessions:bulk.hideHint')}>
              <IconEyeOff size={14} /> {t('inspector:action.hide')}
            </button>
          )}
          <button className={`btn danger ${storeReadOnly ? 'wide' : ''}`} disabled={busy || deleteBlock || storeReadOnly} onClick={() => openDelete([s.id], false)}>
            <IconTrash size={14} /> {t('common:action.deletePermanently')}
          </button>
        </div>
        {/* A Store-edition read-only session cannot be changed whatever is running: only the Store note applies. */}
        {blockReason && !storeReadOnly && (
          <div className="notice warn small" role="note">
            <IconAlert size={14} />
            <span>{blockReason}</span>
          </div>
        )}
        {storeReadOnly && (
          <div className="notice subtle small" role="note">
            <IconInfo size={14} />
            <span>{t('inspector:note.storeDesktop')}</span>
          </div>
        )}
        {cliMissing && (
          <div className="notice subtle small" role="note">
            <IconInfo size={14} />
            <span>{t('inspector:note.codexCliMissing')}</span>
          </div>
        )}
        {hasSafeMode(safety) && !safety.dryRun && (
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
            <KV
              k={t('inspector:field.projectPath')}
              v={s.projectPath ? <code className="wrap">{s.projectPath}</code> : <span className="muted">{t('inspector:value.unknown')}</span>}
              hint={t('inspector:hint.projectPath')}
            />
            <KV k={t('inspector:field.created')} v={fmt.dateTime(s.createdAt)} />
            <KV k={t('inspector:field.updated')} v={fmt.dateTime(s.updatedAt)} />
            {models && <KV k={t('inspector:field.model')} v={<span className="mono">{models}</span>} />}
            {/* Accounts can share one session store: deleting this session removes it for all of them. */}
            {s.accountIds.length > 1 && <KV k={t('inspector:field.accounts')} v={accounts?.filter((a) => s.accountIds.includes(a.id)).map((a) => a.label).join(', ')} />}
            {live && (
              <KV
                k={t('inspector:field.process', { context })}
                v={
                  <span>
                    {t(`sessions:live.state.${live.state}`)}
                    {live.pid > 0 && (
                      <>
                        {' · '}
                        <span className="mono">PID {live.pid}</span>
                      </>
                    )}
                    {live.status && <span className="muted"> · {live.status}</span>}
                  </span>
                }
              />
            )}
          </dl>
        </Section>

        <Section title={t('inspector:section.activity')}>
          <div className="metric-row" title={t('inspector:hint.messages')}>
            <Metric label={t('inspector:metric.prompts')} value={fmt.count(s.userMessageCount)} />
            <Metric label={t('inspector:metric.assistant')} value={fmt.count(s.assistantMessageCount)} />
            <Metric label={t('inspector:metric.tools')} value={fmt.count(s.toolUseCount)} />
          </div>
          {firstMessage && <MessagePreview label={t('inspector:preview.first')} text={firstMessage} />}
          {lastMessage && lastMessage !== firstMessage && <MessagePreview label={t('inspector:preview.last')} text={lastMessage} />}
        </Section>

        <Collapsible className="technical" title={t('inspector:section.technical')}>
          <dl className="kv">
            {s.cliSessionId && <KV k={t('inspector:field.cliSessionId', { context })} v={<CopyCode value={s.cliSessionId} />} />}
            {s.desktopSessionId && <KV k={t('inspector:field.desktopSessionId')} v={<CopyCode value={s.desktopSessionId} />} />}
            {s.priorCliSessionIds.length > 0 && <KV k={t('inspector:field.priorIds')} v={<code className="wrap">{s.priorCliSessionIds.join(', ')}</code>} />}
            <KV k={t('inspector:field.internalId')} v={<CopyCode value={s.id} />} hint={t('inspector:hint.internalId')} />
            <KV k={t('inspector:field.titleSource')} v={t(`inspector:titleSource.${s.titleSource}`, { context })} />
            {s.rawTitle && <KV k={t('inspector:field.rawTitle')} v={<RawTitleValue raw={s.rawTitle} />} hint={t('inspector:hint.rawTitle')} />}
            {s.customTitle && s.customTitle !== title && <KV k={t('inspector:field.customTitle')} v={s.customTitle} />}
            {s.aiTitle && s.aiTitle !== title && <KV k={t('inspector:field.aiTitle')} v={s.aiTitle} />}
            <KV k={t('inspector:field.projectSource')} v={t(`inspector:projectSource.${s.projectSource}`, { context })} />
            {s.claudeVersion && <KV k={t('inspector:field.claudeCode', { context })} v={<span className="mono">{`${s.claudeVersion}${s.entrypoint ? ` · ${s.entrypoint}` : ''}`}</span>} />}
            {s.gitBranch && <KV k={t('inspector:field.gitBranch')} v={<span className="mono">{s.gitBranch}</span>} />}
            {/* Codex deletes and archives the sessions a session started along with it. */}
            {!!s.subagentCount && <KV k={t('inspector:field.subagents')} v={fmt.count(s.subagentCount)} />}
            {codex && s.sessionDataSize !== undefined && <KV k={t('inspector:field.codexHistory')} v={fmt.bytes(s.sessionDataSize)} />}
            {/* The file rows below show the transcript and session data; this is where the rest of the total goes. */}
            {s.otherSize !== undefined && <KV k={t('inspector:size.other', { context })} v={fmt.bytes(s.otherSize)} />}
          </dl>
          <div className="preview-label">{t('inspector:section.files')}</div>
          <div className="path-list">
            <PathRow label={t('inspector:file.metadata')} path={s.metadataFile} raw={raw} size={s.metadataSize} onReveal={() => runAction(() => api().revealMetadata(s.id))} />
            <PathRow label={t('inspector:file.transcript', { context })} path={s.transcriptFile} raw={raw} size={s.transcriptSize} onReveal={() => runAction(() => api().revealTranscript(s.id))} />
            <PathRow label={t('inspector:file.sessionData')} path={s.sessionDataDirectory} raw={raw} size={codex ? undefined : s.sessionDataSize} onReveal={() => runAction(() => api().revealSessionData(s.id))} />
            {s.extraSessionDataDirectories.map((p) => (
              <PathRow key={p} label={t('inspector:file.sessionDataOther')} path={p} raw={raw} />
            ))}
            {s.extraTranscriptFiles.map((p) => (
              <PathRow key={p} label={t('inspector:file.priorTranscript', { context })} path={p} raw={raw} />
            ))}
            {s.legacySubagentLogs.map((p) => (
              <PathRow key={p} label={t('inspector:file.subagentLog')} path={p} raw={raw} />
            ))}
            <PathRow label={t('inspector:file.fileHistory')} path={s.fileHistoryDirectory} raw={raw} />
            {s.extraFileHistoryDirectories.map((p) => (
              <PathRow key={p} label={t('inspector:file.fileHistory')} path={p} raw={raw} />
            ))}
            <PathRow label={t('inspector:file.sessionEnv')} path={s.sessionEnvDirectory} raw={raw} />
            {s.extraSessionEnvDirectories.map((p) => (
              <PathRow key={p} label={t('inspector:file.sessionEnv')} path={p} raw={raw} />
            ))}
          </div>
        </Collapsible>

        {s.hasMetadata && (
          <Collapsible className="raw-metadata" title={t('inspector:section.rawMetadata')}>
            {error && <div className="notice error small">{error}</div>}
            {!details ? (
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
        )}

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

function Collapsible({ title, className, children }: { title: string; className?: string; children: ReactNode }): ReactElement {
  return (
    <details className={`inspector-section collapsible ${className ?? ''}`}>
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

/** Enough of a message to recognise the session, and a way to read all of it. */
function MessagePreview({ label, text }: { label: string; text: string }): ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [cut, setCut] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    const measure = (): void => setCut(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, expanded])
  return (
    <>
      <div className="preview-label">
        <span>{label}</span>
        {(cut || expanded) && (
          <button className="link-btn" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {t(expanded ? 'inspector:preview.less' : 'inspector:preview.more')}
          </button>
        )}
      </div>
      <div className="preview">
        <div ref={ref} className={`preview-text ${expanded ? 'expanded' : ''}`}>
          {text}
        </div>
      </div>
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
function RawTitleValue({ raw }: { raw: RawTitle }): ReactElement {
  const { t } = useTranslation()
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

function PathRow({ label, path, raw, size, onReveal }: { label: string; path?: string; raw: boolean; size?: number; onReveal?: () => void }): ReactElement | null {
  const { t } = useTranslation()
  const fmt = useFmt()
  if (!path) return null
  return (
    <div className="path-row">
      <div className="path-head">
        <span className="path-label">{label}</span>
        {size !== undefined && <span className="path-size">{fmt.bytes(size)}</span>}
        <div className="spacer" />
        <button className="icon-btn" title={t('inspector:file.copyPath')} aria-label={t('inspector:file.copyPathOf', { label })} onClick={() => void copyToClipboard(path)}>
          <IconCopy size={14} />
        </button>
        {onReveal && (
          <button className="icon-btn" title={t('inspector:file.reveal')} aria-label={t('inspector:file.revealOf', { label })} onClick={onReveal}>
            <IconExternal size={14} />
          </button>
        )}
      </div>
      <div className="path-value mono" title={path}>
        {displayPath(path, raw)}
      </div>
    </div>
  )
}

/** Takes the session up again in the app's terminal: its CLI's resume command, typed in, in its project folder. Not in the Store edition. */
function ResumeButton({ session: s }: { session: ClaudeSession }): ReactElement | null {
  const { t } = useTranslation()
  const available = useTerminal((st) => st.support?.available ?? false)
  const starting = useTerminal((st) => st.starting)
  const context = useAppState(toolContext)
  if (!available) return null
  const command = s.cliSessionId ? resumeCommand(s.provider, s.cliSessionId) : null
  const blocked = !command
    ? t('terminal:resume.noId')
    : s.provider !== 'codex' && !s.hasTranscript
      ? t('terminal:resume.noTranscript')
      : s.live
        ? t('terminal:resume.live', { context })
        : null
  return (
    <button className="btn resume-btn" disabled={!!blocked || starting} onClick={() => void resumeInTerminal(s.id)} title={blocked ?? t('terminal:resume.hint', { command })}>
      <IconTerminal size={14} /> {t('terminal:resume.button')}
    </button>
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
    <div
      className="menu-wrap"
      ref={ref}
      // The open menu covers the toolbar's bottom row: Tab must not reach a button the user cannot see.
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false)
      }}
    >
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
