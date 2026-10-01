import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type {
  DeleteItemResult,
  DeletePlan,
  DeletePlanItem,
  DeleteResult,
  PlanItemKind,
  SessionDeletePlan
} from '../../../shared/types'
import { isConfirmationValid } from '../../../shared/confirm'
import { formatBytes, formatDateTime } from '../../../shared/format'
import { closeDelete, errText, refreshProcess, setChecked, toast, useAppState } from '../stores/appStore'
import { IconAlert, IconCheck, IconCopy, IconMinus, IconRefresh, IconTrash, IconX } from './Icons'

const api = (): Window['sessionManager'] => window.sessionManager

const KIND_LABEL: Record<PlanItemKind, string> = {
  metadata: 'Metadata',
  transcript: 'Transcript',
  'session-data': 'Session data',
  'subagent-log': 'Subagent log',
  'file-history': 'File history',
  'session-env': 'Session env',
  tombstone: 'Tombstone',
  'archive-index': 'Archive index',
  'manager-record': 'Manager record'
}

function actionLabel(i: DeletePlanItem): string {
  switch (i.action) {
    case 'delete-file':
      return 'delete file'
    case 'delete-directory':
      return `delete folder · ${i.fileCount ?? 0} file(s), ${i.dirCount ?? 1} folder(s)`
    case 'create-file':
      return 'create file'
    case 'update-file':
      return 'update file'
    case 'remove-record':
      return 'remove record'
  }
}

const exactBytes = (n: number): string => `${formatBytes(n)} (${n.toLocaleString('en-US')} bytes)`

async function copyText(text: string | undefined, what: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    toast('info', `${what} copied to clipboard`)
  } catch (err) {
    toast('error', `Copy failed: ${errText(err)}`)
  }
}

export function DeleteModal(): ReactElement | null {
  const request = useAppState((s) => s.deleteRequest)
  const [plan, setPlan] = useState<DeletePlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DeleteResult | null>(null)

  const loadPlan = useCallback(async () => {
    if (!request) return
    setLoading(true)
    setConfirmText('')
    try {
      setPlan(request.bulk ? await api().createBulkDeletePlan(request.ids) : await api().createDeletePlan(request.ids[0]))
    } catch (err) {
      setError(errText(err))
    } finally {
      setLoading(false)
    }
  }, [request])

  useEffect(() => {
    setPlan(null)
    setResult(null)
    setError(null)
    void loadPlan()
  }, [loadPlan])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !running) closeDelete()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running])

  if (!request) return null

  const valid = !!plan && isConfirmationValid(confirmText, plan.confirmationPhrases)
  // A dry run mutates nothing, so it may run even while real deletion is blocked.
  const blockedForReal = !!plan?.globalBlockedReason && !plan.dryRun
  const canRun = !!plan && plan.sessions.length > 0 && valid && !running && !blockedForReal

  const execute = async (): Promise<void> => {
    if (!plan || !canRun) return
    setRunning(true)
    setError(null)
    try {
      const ids = plan.sessions.map((s) => s.sessionId)
      // Only internal session IDs, the plan ID and the typed confirmation cross IPC.
      const r = request.bulk
        ? await api().bulkDelete(ids, confirmText.trim(), plan.planId)
        : await api().deleteSession(ids[0], confirmText.trim(), plan.planId)
      if (r.sessions.length === 0) {
        // Refused before anything ran (stale plan, path rejected, …): show why and a fresh plan.
        setError(r.message)
        toast('error', r.message)
        await loadPlan()
        return
      }
      setResult(r)
      if (r.ok && !r.dryRun) setChecked([])
      toast(r.ok ? (r.dryRun ? 'info' : 'success') : r.dryRun ? 'warning' : 'error', r.message)
    } catch (err) {
      setError(errText(err))
    } finally {
      setRunning(false)
    }
  }

  const recheck = async (): Promise<void> => {
    await refreshProcess(true)
    setError(null)
    await loadPlan()
  }

  const n = request.ids.length
  const title = result
    ? result.dryRun
      ? 'Dry run result'
      : 'Delete result'
    : request.bulk && n > 1
      ? `Delete ${n} sessions permanently`
      : 'Delete session permanently'

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && closeDelete()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <IconTrash size={18} className="danger-text" />
          <h2>{title}</h2>
          {plan && <span className="plan-id mono">plan {plan.planId.slice(0, 12)}…</span>}
          <div className="spacer" />
          <button className="icon-btn" onClick={closeDelete} disabled={running} title="Close (Esc)">
            <IconX size={16} />
          </button>
        </header>

        <div className="modal-body">
          {loading && <div className="muted">Building delete plan…</div>}
          {error && <div className="notice error">{error}</div>}

          {result ? (
            <ResultView result={result} plan={plan} />
          ) : (
            plan && (
              <>
                {plan.dryRun && (
                  <div className="notice info">
                    <strong>DRY RUN mode.</strong> The full validation pipeline runs and the exact plan is logged, but no Claude file is
                    modified.
                  </div>
                )}
                {plan.globalBlockedReason && (
                  <div className="notice warn row-flex">
                    <IconAlert size={16} />
                    <span>
                      {plan.dryRun ? 'A real delete would be blocked right now: ' : ''}
                      {plan.globalBlockedReason}
                    </span>
                    <div className="spacer" />
                    <button className="btn small" onClick={() => void recheck()}>
                      <IconRefresh size={13} /> Re-check
                    </button>
                  </div>
                )}
                {plan.blocked.length > 0 && (
                  <div className="notice warn">
                    <strong>{plan.blocked.length} session(s) cannot be deleted and are not part of this plan:</strong>
                    <ul className="plain-list">
                      {plan.blocked.map((b) => (
                        <li key={b.sessionId}>
                          <span className="strong">{b.displayTitle}</span> — {b.blockedReason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {plan.sessions.length > 0 && (
                  <>
                    <div className="danger-box">
                      <IconAlert size={18} />
                      <div>
                        <strong>This action permanently deletes these local files.</strong>
                        <div className="small">
                          Not moved to the Recycle Bin; unrecoverable without your own backup. Only the exact paths below are touched, and
                          only if every check still passes at execution time.
                        </div>
                      </div>
                    </div>

                    <div className="plan-summary">
                      {plan.sessions.length} session(s) · {plan.totalFiles} file(s) · {plan.totalDirs} folder(s) ·{' '}
                      {exactBytes(plan.totalBytes)}
                    </div>

                    <div className="plan-list">
                      {plan.sessions.map((s) => (
                        <SessionPlanCard key={s.sessionId} plan={s} />
                      ))}
                    </div>

                    <div className="plan-meta mono">
                      <div>Plan ID: {plan.planId}</div>
                      <div>Content hash: sha256:{plan.contentHash}</div>
                      <div>
                        Created {formatDateTime(plan.createdAt)} · expires {formatDateTime(plan.expiresAt)}
                      </div>
                    </div>

                    <label className="confirm-label">
                      Type <code>{plan.confirmationPhrases[0]}</code>
                      {plan.confirmationPhrases.length > 1 && (
                        <>
                          {' '}
                          or <code>{plan.confirmationPhrases[1]}</code>
                        </>
                      )}{' '}
                      to confirm
                      <input
                        className={`confirm-input ${confirmText && !valid ? 'invalid' : ''}`}
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void execute()}
                        disabled={blockedForReal || running}
                        autoFocus
                        spellCheck={false}
                        placeholder={plan.confirmationPhrases[0]}
                      />
                    </label>
                  </>
                )}
                {plan.sessions.length === 0 && <div className="muted">Nothing in this selection can be deleted.</div>}
              </>
            )
          )}
        </div>

        <footer className="modal-footer">
          {plan && (
            <button
              className="btn"
              onClick={() => void copyText(result?.reportText ?? plan.reportText, result ? 'Delete result' : 'Delete plan')}
              title="Copy the exact plan as text for independent review"
            >
              <IconCopy size={14} /> {result ? 'COPY RESULT' : 'COPY DELETE PLAN'}
            </button>
          )}
          <div className="spacer" />
          {result ? (
            <button className="btn" onClick={closeDelete}>
              Close
            </button>
          ) : (
            <>
              <button className="btn ghost" onClick={closeDelete} disabled={running}>
                Cancel
              </button>
              <button className="btn danger solid" disabled={!canRun} onClick={() => void execute()}>
                <IconTrash size={14} />
                {running ? (plan?.dryRun ? 'Validating…' : 'Deleting…') : plan?.dryRun ? 'Run dry-run validation' : 'Delete permanently'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

function ItemRow({ item }: { item: DeletePlanItem | DeleteItemResult }): ReactElement {
  const outcome = 'outcome' in item ? item.outcome : undefined
  return (
    <div className={`plan-item ${item.action.startsWith('delete') ? '' : 'non-delete'}`}>
      {outcome && <OutcomeIcon outcome={outcome} />}
      <span className="plan-kind">{KIND_LABEL[item.kind]}</span>
      <span className="plan-action">{outcome ?? actionLabel(item)}</span>
      {item.sizeBytes !== undefined && item.action.startsWith('delete') && <span className="plan-size">{formatBytes(item.sizeBytes)}</span>}
      <div className="plan-path">{item.path}</div>
      {item.note && <div className="plan-note">{item.note}</div>}
      {'error' in item && item.error && <div className="plan-note danger-text">{item.error}</div>}
    </div>
  )
}

function SessionPlanCard({ plan: s, items }: { plan: SessionDeletePlan; items?: Array<DeletePlanItem | DeleteItemResult> }): ReactElement {
  const list = items ?? s.items
  const groups: Array<[string, Array<DeletePlanItem | DeleteItemResult>]> = [
    ['Will delete', list.filter((i) => i.action === 'delete-file' || i.action === 'delete-directory')],
    ['Will change (Claude Desktop bookkeeping)', list.filter((i) => i.action === 'create-file' || i.action === 'update-file')],
    ['Manager records removed (this app only)', list.filter((i) => i.action === 'remove-record')]
  ]
  return (
    <div className="plan-session">
      <div className="plan-session-head">
        <span className="strong">{s.displayTitle}</span>
        <span className="muted small">
          {s.totalFiles} file(s) · {s.totalDirs} folder(s) · {exactBytes(s.totalBytes)}
        </span>
      </div>
      <dl className="kv plan-kv">
        <dt>CLI session ID</dt>
        <dd className="mono">{s.cliSessionId ?? '—'}</dd>
        {s.desktopSessionId && (
          <>
            <dt>Desktop session ID</dt>
            <dd className="mono">{s.desktopSessionId}</dd>
          </>
        )}
        <dt>Project</dt>
        <dd>{s.projectName}</dd>
        <dt>Project path</dt>
        <dd className="mono">{s.projectPath ?? 'unknown'}</dd>
      </dl>
      {groups.map(([label, group]) =>
        group.length ? (
          <div key={label} className="plan-group">
            <div className="plan-group-label">{label}</div>
            {group.map((i) => (
              <ItemRow key={`${i.kind}|${i.path}|${i.note ?? ''}`} item={i} />
            ))}
          </div>
        ) : null
      )}
      <div className="plan-group keep">
        <div className="plan-group-label">Will NOT delete</div>
        {s.willNotDelete.map((k) => (
          <div key={k.path} className="keep-item">
            <div className="plan-path">{k.path}</div>
            <div className="plan-note">{k.reason}</div>
          </div>
        ))}
      </div>
      {s.warnings.map((w, idx) => (
        <div key={idx} className="plan-note warn-text">
          {w}
        </div>
      ))}
    </div>
  )
}

function OutcomeIcon({ outcome }: { outcome: DeleteItemResult['outcome'] }): ReactElement {
  if (outcome === 'deleted' || outcome === 'created' || outcome === 'updated') return <IconCheck size={14} className="ok-text" />
  if (outcome === 'failed') return <IconX size={14} className="danger-text" />
  if (outcome === 'dry-run') return <IconCheck size={14} className="info-text" />
  return <IconMinus size={14} className="muted" />
}

function ResultView({ result, plan }: { result: DeleteResult; plan: DeletePlan | null }): ReactElement {
  return (
    <>
      <div className={`notice ${result.ok ? (result.dryRun ? 'info' : 'success') : result.dryRun ? 'warn' : 'error'}`}>{result.message}</div>
      {result.dryRun && (
        <div className="notice subtle small">
          Every target below passed validation (approved root, exact shape, canonical path, no link escape, not a workspace) and was
          logged. Nothing was deleted.
        </div>
      )}
      <div className="plan-list">
        {result.sessions.map((r) => {
          const p = plan?.sessions.find((s) => s.sessionId === r.sessionId)
          return p ? (
            <div key={r.sessionId}>
              <span className={`badge outcome-${r.outcome}`}>{r.outcome}</span>
              <SessionPlanCard plan={p} items={r.items} />
            </div>
          ) : null
        })}
      </div>
    </>
  )
}
