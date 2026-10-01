import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { ClaudeSession, ExportFormat, SessionDetails } from '../../../shared/types'
import { formatBytes, formatCount, formatDateTime } from '../../../shared/format'
import { TITLE_SOURCE_LABEL, describeRawTitle } from '../../../shared/titles'
import { archive, errText, exportOne, openDelete, runAction, toast, useAppState } from '../stores/appStore'
import { displayPath } from '../utils/paths'
import { SessionBadges } from './Badges'
import {
  IconArchive,
  IconCopy,
  IconDownload,
  IconExternal,
  IconFolder,
  IconInfo,
  IconRestore,
  IconTrash
} from './Icons'

const api = (): Window['sessionManager'] => window.sessionManager

export function DetailsPanel(): ReactElement {
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
      <section className="details-pane empty-details">
        <div className="empty-illustration">
          <IconInfo size={28} />
          <p>Select a session to see its details, files and actions.</p>
          <p className="muted small">Use the checkboxes to select several sessions for bulk actions.</p>
        </div>
      </section>
    )
  }
  return <SessionDetailsView key={session.id} session={session} details={details?.session.id === session.id ? details : null} error={error} />
}

function SessionDetailsView({ session: s, details, error }: { session: ClaudeSession; details: SessionDetails | null; error: string | null }): ReactElement {
  const settings = useAppState((st) => st.settings)
  const process = useAppState((st) => st.process)
  const busy = useAppState((st) => st.busy)
  const appInfo = useAppState((st) => st.appInfo)
  const raw = settings?.showRawPaths ?? false

  const desktopBlocked = !!process && (process.desktopRunning || !!process.error)
  const liveBlocked = !!s.live
  const archiveTouchesClaude = s.hasMetadata
  const archiveBlock = archiveTouchesClaude && (desktopBlocked || liveBlocked)
  const deleteBlock = desktopBlocked || liveBlocked
  const blockReason = liveBlocked
    ? `Open in a running Claude Code process (PID ${s.live!.pid}${s.live!.name ? `, ${s.live!.name}` : ''}). Close it before ${s.hasMetadata ? 'archiving or deleting' : 'deleting'}.`
    : desktopBlocked
      ? process?.error
        ? 'Claude process status is unknown. Refresh the process status first.'
        : 'Close Claude Desktop before modifying session files.'
      : null

  return (
    <section className="details-pane">
      <div className="details-scroll">
        <header className="details-header">
          <h2 className={`details-title ${s.titleSource === 'untitled' ? 'untitled' : ''}`}>{s.displayTitle}</h2>
          <SessionBadges session={s} />
        </header>

        <div className="actions">
          {s.archived ? (
            <button className="btn" disabled={busy || archiveBlock || s.kind === 'orphan'} onClick={() => void archive(s.id, false)}>
              <IconRestore size={14} /> Restore
            </button>
          ) : (
            <button
              className="btn"
              disabled={busy || archiveBlock || s.kind === 'orphan'}
              onClick={() => void archive(s.id, true)}
              title={s.hasMetadata ? 'Set isArchived=true in the Claude Desktop metadata' : 'CLI sessions have no archive flag: archived in this app only'}
            >
              <IconArchive size={14} /> Archive
            </button>
          )}
          <ExportMenu session={s} disabled={busy} />
          <button className="btn" disabled={!s.projectPath} onClick={() => void runAction(() => api().openProject(s.id))}>
            <IconFolder size={14} /> Open project
          </button>
          <div className="spacer" />
          <button className="btn danger" disabled={busy || deleteBlock} onClick={() => openDelete([s.id], false)}>
            <IconTrash size={14} /> Delete permanently
          </button>
        </div>
        {blockReason && <div className="notice warn small">{blockReason}</div>}
        {!s.hasMetadata && s.kind === 'cli' && (
          <div className="notice subtle small">
            Claude Code CLI session — there is no Claude Desktop metadata file, so Archive only hides it inside this app.
          </div>
        )}
        {appInfo?.dryRun && <div className="notice info small">DRY RUN mode: archive, restore and delete only log what they would do.</div>}

        {s.problems.length > 0 && (
          <Section title="Problems">
            <ul className="problems">
              {s.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Overview">
          <dl className="kv">
            <KV k="Display title" v={s.displayTitle} />
            <KV k="Title source" v={TITLE_SOURCE_LABEL[s.titleSource]} />
            <KV k="Raw metadata title" v={<code>{describeRawTitle(s.rawTitle)}</code>} />
            {s.customTitle && <KV k="Custom title" v={s.customTitle} />}
            {s.aiTitle && <KV k="AI title" v={s.aiTitle} />}
            <KV k="Project" v={s.projectName} />
            <KV k="Project path" v={s.projectPath ? <code>{s.projectPath}</code> : <span className="muted">unknown</span>} />
            <KV k="Session ID" v={<CopyCode value={s.id} />} hint="Internal ID assigned by this app" />
            <KV k="CLI session ID" v={s.cliSessionId ? <CopyCode value={s.cliSessionId} /> : '—'} />
            {s.desktopSessionId && <KV k="Desktop session ID" v={<CopyCode value={s.desktopSessionId} />} />}
            {s.priorCliSessionIds.length > 0 && <KV k="Prior CLI IDs" v={<code>{s.priorCliSessionIds.join(', ')}</code>} />}
            <KV k="Created" v={formatDateTime(s.createdAt)} />
            <KV k="Updated" v={formatDateTime(s.updatedAt)} />
            <KV k="Model" v={s.models.length > 1 ? s.models.join(', ') : s.model ?? '—'} />
            <KV
              k="Messages"
              v={
                s.userMessageCount !== undefined
                  ? `${formatCount(s.userMessageCount)} prompt${s.userMessageCount === 1 ? '' : 's'} · ${formatCount(s.assistantMessageCount)} response${s.assistantMessageCount === 1 ? '' : 's'}`
                  : '—'
              }
            />
            <KV
              k="Size"
              v={
                <span>
                  {formatBytes(s.totalSize)}
                  <span className="muted small">
                    {' '}
                    ({[
                      s.transcriptSize !== undefined && `transcript ${formatBytes(s.transcriptSize)}`,
                      s.sessionDataSize !== undefined && `session data ${formatBytes(s.sessionDataSize)}`,
                      s.metadataSize !== undefined && `metadata ${formatBytes(s.metadataSize)}`,
                      s.otherSize !== undefined && `other ${formatBytes(s.otherSize)}`
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    )
                  </span>
                </span>
              }
            />
            {s.gitBranch && <KV k="Git branch" v={s.gitBranch} />}
            {s.claudeVersion && <KV k="Claude Code" v={`${s.claudeVersion}${s.entrypoint ? ` · ${s.entrypoint}` : ''}`} />}
            {s.live && <KV k="In use by" v={`PID ${s.live.pid}${s.live.status ? ` (${s.live.status})` : ''}`} />}
          </dl>
        </Section>

        <Section title="Files">
          <PathRow label="Metadata" path={s.metadataFile} raw={raw} size={s.metadataSize} onReveal={() => runAction(() => api().revealMetadata(s.id))} />
          <PathRow label="Transcript" path={s.transcriptFile} raw={raw} size={s.transcriptSize} onReveal={() => runAction(() => api().revealTranscript(s.id))} />
          <PathRow label="Session data" path={s.sessionDataDirectory} raw={raw} size={s.sessionDataSize} onReveal={() => runAction(() => api().revealSessionData(s.id))} />
          {s.extraTranscriptFiles.map((p) => (
            <PathRow key={p} label="Prior transcript" path={p} raw={raw} />
          ))}
          {s.legacySubagentLogs.map((p) => (
            <PathRow key={p} label="Subagent log" path={p} raw={raw} />
          ))}
          {s.fileHistoryDirectory && <PathRow label="File history" path={s.fileHistoryDirectory} raw={raw} />}
          {s.sessionEnvDirectory && <PathRow label="Session env" path={s.sessionEnvDirectory} raw={raw} />}
        </Section>

        <Section title="Preview">
          <div className="preview-label">First user message</div>
          <div className="preview">{s.firstUserMessage ?? <span className="muted">—</span>}</div>
          <div className="preview-label">Last user message</div>
          <div className="preview">{s.lastUserMessage ?? s.lastPrompt ?? <span className="muted">—</span>}</div>
        </Section>

        <details className="raw-meta">
          <summary>Raw metadata</summary>
          {error && <div className="notice error small">{error}</div>}
          {!s.hasMetadata ? (
            <div className="muted small pad">No Claude Desktop metadata file — this is a Claude Code transcript-only session.</div>
          ) : !details ? (
            <div className="muted small pad">Loading…</div>
          ) : (
            <>
              {details.rawMetadataError && <div className="notice error small">{details.rawMetadataError}</div>}
              {details.tombstones.length > 0 && <div className="notice subtle small">Tombstones present: {details.tombstones.join(', ')}</div>}
              <pre className="code-block">{details.rawMetadata}</pre>
            </>
          )}
        </details>

        {settings?.debugMode && (
          <details className="raw-meta">
            <summary>Debug: normalized session object</summary>
            <pre className="code-block">{JSON.stringify(s, null, 2)}</pre>
          </details>
        )}
      </div>
    </section>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="section">
      <h3 className="section-title">{title}</h3>
      {children}
    </section>
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

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast('info', 'Copied to clipboard')
  } catch (err) {
    toast('error', `Copy failed: ${errText(err)}`)
  }
}

function CopyCode({ value }: { value: string }): ReactElement {
  return (
    <span className="copy-code">
      <code>{value}</code>
      <button className="icon-btn tiny" title="Copy" onClick={() => void copy(value)}>
        <IconCopy size={12} />
      </button>
    </span>
  )
}

function PathRow({ label, path, raw, size, onReveal }: { label: string; path?: string; raw: boolean; size?: number; onReveal?: () => void }): ReactElement {
  return (
    <div className={`path-row ${path ? '' : 'missing'}`}>
      <div className="path-head">
        <span className="path-label">{label}</span>
        {size !== undefined && path && <span className="muted small">{formatBytes(size)}</span>}
        <div className="spacer" />
        {path && (
          <>
            <button className="icon-btn tiny" title="Copy full path" onClick={() => void copy(path)}>
              <IconCopy size={12} />
            </button>
            {onReveal && (
              <button className="icon-btn tiny" title="Reveal in Explorer" onClick={onReveal}>
                <IconExternal size={12} />
              </button>
            )}
          </>
        )}
      </div>
      <div className="path-value" title={path}>
        {path ? displayPath(path, raw) : <span className="muted">not present</span>}
      </div>
    </div>
  )
}

function ExportMenu({ session: s, disabled }: { session: ClaudeSession; disabled: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const pick = (f: ExportFormat): void => {
    setOpen(false)
    void exportOne(s.id, f)
  }
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn" disabled={disabled} onClick={() => setOpen(!open)}>
        <IconDownload size={14} /> Export
      </button>
      {open && (
        <div className="menu">
          <button disabled={!s.hasTranscript} onClick={() => pick('jsonl')}>
            Raw transcript (.jsonl)
          </button>
          <button onClick={() => pick('info')}>Session info (.json)</button>
          <button disabled={!s.hasTranscript} onClick={() => pick('markdown')}>
            Readable conversation (.md)
          </button>
          <div className="menu-note">Exports are copies; originals are never modified.</div>
        </div>
      )}
    </div>
  )
}
