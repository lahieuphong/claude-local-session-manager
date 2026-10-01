import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { DeleteItemResult, DeletePlan, DeletePlanItem, DeleteResult, PlanItemKind } from '../../../shared/types'
import { isConfirmationValid } from '../../../shared/confirm'
import { formatBytes } from '../../../shared/format'
import { closeDelete, errText, refreshProcess, setChecked, toast, useAppState } from '../stores/appStore'
import { IconAlert, IconCheck, IconMinus, IconRefresh, IconTrash, IconX } from './Icons'

const api = (): Window['sessionManager'] => window.sessionManager

const KIND_LABEL: Record<PlanItemKind, string> = {
  metadata: 'Metadata',
  transcript: 'Transcript',
  'session-data': 'Session data',
  'subagent-log': 'Subagent log',
  'file-history': 'File history',
  'session-env': 'Session env',
  tombstone: 'Tombstone',
  'archive-index': 'Archive index'
}

function actionLabel(i: DeletePlanItem): string {
  switch (i.action) {
    case 'delete-file':
      return 'delete file'
    case 'delete-directory':
      return `delete folder${i.fileCount !== undefined ? ` (${i.fileCount} files)` : ''}`
    case 'create-file':
      return 'create'
    case 'update-file':
      return 'update'
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
    setError(null)
    setConfirmText('')
    try {
      const p = request.bulk ? await api().createBulkDeletePlan(request.ids) : await api().createDeletePlan(request.ids[0])
      setPlan(p)
    } catch (err) {
      setError(errText(err))
    } finally {
      setLoading(false)
    }
  }, [request])

  useEffect(() => {
    setPlan(null)
    setResult(null)
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
  const canDelete = !!plan && !plan.globalBlockedReason && plan.sessions.length > 0 && valid && !running

  const execute = async (): Promise<void> => {
    if (!plan || !canDelete) return
    setRunning(true)
    try {
      const ids = plan.sessions.map((s) => s.sessionId)
      const r = request.bulk
        ? await api().bulkDelete(ids, confirmText.trim(), plan.token)
        : await api().deleteSession(ids[0], confirmText.trim(), plan.token)
      setResult(r)
      if (r.ok && !r.dryRun) setChecked([])
      toast(r.ok ? (r.dryRun ? 'info' : 'success') : 'error', r.message)
      if (!r.ok && r.sessions.length === 0) {
        // Rejected before anything ran (e.g. files changed): show a fresh plan.
        setResult(null)
        setError(r.message)
        await loadPlan()
      }
    } catch (err) {
      setError(errText(err))
    } finally {
      setRunning(false)
    }
  }

  const recheck = async (): Promise<void> => {
    await refreshProcess(true)
    await loadPlan()
  }

  const n = request.ids.length
  const title = request.bulk && n > 1 ? `Delete ${n} sessions permanently` : 'Delete session permanently'

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && closeDelete()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <IconTrash size={18} className="danger-text" />
          <h2>{result ? (result.dryRun ? 'Dry run result' : 'Delete result') : title}</h2>
          <div className="spacer" />
          <button className="icon-btn" onClick={closeDelete} disabled={running} title="Close (Esc)">
            <IconX size={16} />
          </button>
        </header>

        <div className="modal-body">
          {loading && <div className="muted">Building delete plan…</div>}
          {error && <div className="notice error">{error}</div>}

          {result ? (
            <ResultView result={result} />
          ) : (
            plan && (
              <>
                {plan.dryRun && (
                  <div className="notice info">
                    <strong>DRY RUN mode.</strong> Nothing will be deleted; the planned paths are only written to the log.
                  </div>
                )}
                {plan.globalBlockedReason && (
                  <div className="notice warn row-flex">
                    <IconAlert size={16} />
                    <span>{plan.globalBlockedReason}</span>
                    <div className="spacer" />
                    <button className="btn small" onClick={() => void recheck()}>
                      <IconRefresh size={13} /> Re-check
                    </button>
                  </div>
                )}
                {plan.blocked.length > 0 && (
                  <div className="notice warn">
                    <strong>{plan.blocked.length} session(s) will be skipped:</strong>
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
                          They are not moved to the Recycle Bin and cannot be recovered unless you have your own backup. Only the exact paths
                          listed below are touched.
                        </div>
                      </div>
                    </div>

                    <div className="plan-summary">
                      {plan.sessions.length} session(s) · {plan.totalItems} item(s) · {formatBytes(plan.totalBytes)} will be freed
                    </div>

                    <div className="plan-list">
                      {plan.sessions.map((s) => (
                        <div key={s.sessionId} className="plan-session">
                          <div className="plan-session-head">
                            <span className="strong">{s.displayTitle}</span>
                            <span className="muted small">{formatBytes(s.totalBytes)}</span>
                          </div>
                          {s.items.map((i) => (
                            <div key={i.path} className={`plan-item ${i.action.startsWith('delete') ? '' : 'non-delete'}`}>
                              <span className="plan-kind">{KIND_LABEL[i.kind]}</span>
                              <span className="plan-action">{actionLabel(i)}</span>
                              {i.sizeBytes !== undefined && <span className="plan-size">{formatBytes(i.sizeBytes)}</span>}
                              <div className="plan-path">{i.path}</div>
                              {i.note && <div className="plan-note">{i.note}</div>}
                            </div>
                          ))}
                          {s.warnings.map((w, idx) => (
                            <div key={idx} className="plan-note warn-text">
                              {w}
                            </div>
                          ))}
                        </div>
                      ))}
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
                        disabled={!!plan.globalBlockedReason || running}
                        autoFocus
                        spellCheck={false}
                        placeholder={plan.confirmationPhrases[0]}
                      />
                    </label>
                  </>
                )}
                {plan.sessions.length === 0 && !plan.globalBlockedReason && <div className="muted">Nothing can be deleted.</div>}
              </>
            )
          )}
        </div>

        <footer className="modal-footer">
          {result ? (
            <button className="btn" onClick={closeDelete}>
              Close
            </button>
          ) : (
            <>
              <button className="btn ghost" onClick={closeDelete} disabled={running}>
                Cancel
              </button>
              <button className="btn danger solid" disabled={!canDelete} onClick={() => void execute()}>
                <IconTrash size={14} />
                {running ? 'Deleting…' : plan?.dryRun ? 'Run dry-run delete' : 'Delete permanently'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

function OutcomeIcon({ item }: { item: DeleteItemResult }): ReactElement {
  if (item.outcome === 'deleted' || item.outcome === 'created' || item.outcome === 'updated') return <IconCheck size={14} className="ok-text" />
  if (item.outcome === 'failed') return <IconX size={14} className="danger-text" />
  return <IconMinus size={14} className="muted" />
}

function ResultView({ result }: { result: DeleteResult }): ReactElement {
  return (
    <>
      <div className={`notice ${result.ok ? (result.dryRun ? 'info' : 'success') : 'error'}`}>{result.message}</div>
      <div className="plan-list">
        {result.sessions.map((s) => (
          <div key={s.sessionId} className="plan-session">
            <div className="plan-session-head">
              <span className="strong">{s.displayTitle}</span>
              <span className={`badge outcome-${s.outcome}`}>{s.outcome}</span>
            </div>
            {s.error && <div className="plan-note danger-text">{s.error}</div>}
            {s.items.map((i) => (
              <div key={i.path} className="plan-item">
                <OutcomeIcon item={i} />
                <span className="plan-kind">{KIND_LABEL[i.kind]}</span>
                <span className="plan-action">{i.outcome}</span>
                <div className="plan-path">{i.path}</div>
                {i.error && <div className="plan-note danger-text">{i.error}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
