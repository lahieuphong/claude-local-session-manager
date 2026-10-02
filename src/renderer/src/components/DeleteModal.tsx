import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DeleteItemResult,
  DeletePlan,
  DeletePlanItem,
  DeleteResult,
  SessionDeletePlan
} from '../../../shared/types'
import { isConfirmationValid } from '../../../shared/confirm'
import { useFmt, type Formatters } from '../i18n'
import { closeDelete, copyToClipboard, errText, refreshProcess, setChecked, toast, useAppState, type DeleteRequest } from '../stores/appStore'
import { IconAlert, IconCheck, IconCopy, IconMinus, IconRefresh, IconShield, IconShieldAlert, IconTrash, IconX } from './Icons'
import { Modal } from './Modal'
import { tCode } from './RichText'
import { localTitle } from '../utils/titles'

const api = (): Window['sessionManager'] => window.sessionManager

type AnyItem = DeletePlanItem | DeleteItemResult

const isDelete = (i: AnyItem): boolean => i.action === 'delete-file' || i.action === 'delete-directory'

export function DeleteModal(): ReactElement | null {
  const { t } = useTranslation()
  const fmt = useFmt()
  const liveRequest = useAppState((s) => s.deleteRequest)
  const safety = useAppState((s) => s.safety)
  // Keep the last request while the dialog animates out.
  const lastRequest = useRef<DeleteRequest | null>(null)
  if (liveRequest) lastRequest.current = liveRequest
  const request = liveRequest ?? lastRequest.current

  const [plan, setPlan] = useState<DeletePlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ text: string; msg?: DeleteResult['msg'] } | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DeleteResult | null>(null)
  const titleId = useId()
  const descId = useId()

  const loadPlan = useCallback(async () => {
    if (!liveRequest) return
    setLoading(true)
    setConfirmText('')
    try {
      setPlan(liveRequest.bulk ? await api().createBulkDeletePlan(liveRequest.ids) : await api().createDeletePlan(liveRequest.ids[0]))
    } catch (err) {
      setError({ text: errText(err) })
    } finally {
      setLoading(false)
    }
  }, [liveRequest])

  useEffect(() => {
    if (!liveRequest) return
    setPlan(null)
    setResult(null)
    setError(null)
    void loadPlan()
  }, [liveRequest, loadPlan])

  // The safety mode changed while the dialog is open (armed, returned, expired):
  // a plan is bound to the mode it was created in, so build a fresh one.
  useEffect(() => {
    if (liveRequest && plan && !result && !running && safety && safety.dryRun !== plan.dryRun) void loadPlan()
  }, [liveRequest, safety, plan, result, running, loadPlan])

  if (!request) return null

  const valid = !!plan && isConfirmationValid(confirmText, plan.confirmationPhrases)
  // A dry run mutates nothing, so it may run even while real deletion is blocked.
  const blockedForReal = !!plan?.globalBlockedReason && !plan.dryRun
  const canRun = !!liveRequest && !!plan && plan.sessions.length > 0 && valid && !running && !blockedForReal

  const execute = async (): Promise<void> => {
    if (!plan || !canRun || !liveRequest) return
    setRunning(true)
    setError(null)
    try {
      const ids = plan.sessions.map((s) => s.sessionId)
      // Only internal session IDs, the plan ID and the typed confirmation cross IPC.
      const r = liveRequest.bulk
        ? await api().bulkDelete(ids, confirmText.trim(), plan.planId)
        : await api().deleteSession(ids[0], confirmText.trim(), plan.planId)
      if (r.sessions.length === 0) {
        // Refused before anything ran (stale plan, path rejected, …): show why and a fresh plan.
        setError({ text: r.message, msg: r.msg })
        toast('error', { text: r.message, msg: r.msg })
        await loadPlan()
        return
      }
      setResult(r)
      if (r.ok && !r.dryRun) setChecked([])
      toast(r.ok ? (r.dryRun ? 'info' : 'success') : r.dryRun ? 'warning' : 'error', { text: r.message, msg: r.msg })
    } catch (err) {
      setError({ text: errText(err) })
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
    ? t(result.dryRun ? 'deletion:title.dryRunResult' : 'deletion:title.result')
    : request.bulk && n > 1
      ? t('deletion:title.bulk', { count: n })
      : t('deletion:title.single')

  return (
    <Modal open={!!liveRequest} onClose={closeDelete} locked={running} labelledBy={titleId} describedBy={descId} size="wide" tone="danger">
      <header className="modal-header delete-header">
        <IconTrash size={18} className="danger-text" />
        <div className="modal-heading">
          <h2 id={titleId}>{title}</h2>
          <div className="modal-sub" id={descId}>
            {plan ? (
              <>
                <span className="plan-id mono" title={plan.planId}>
                  {t('deletion:planId', { id: plan.planId.slice(0, 12) })}
                </span>
                {plan.sessions.length > 0 && (
                  <span>
                    {t('deletion:summary', {
                      sessions: t('deletion:count.sessions', { count: plan.sessions.length }),
                      files: t('deletion:count.files', { count: plan.totalFiles }),
                      folders: t('deletion:count.folders', { count: plan.totalDirs }),
                      size: fmt.bytes(plan.totalBytes)
                    })}
                  </span>
                )}
              </>
            ) : (
              <span>{t('deletion:building')}</span>
            )}
          </div>
        </div>
        <div className="spacer" />
        <button className="icon-btn" onClick={closeDelete} disabled={running} title={t('common:action.closeEsc')} aria-label={t('common:action.closeEsc')}>
          <IconX size={16} />
        </button>
      </header>

      <div className="modal-body">
        {loading && !plan && (
          <div className="hint" role="status">
            {t('deletion:building')}
          </div>
        )}
        {error && (
          <div className="notice error" role="alert">
            <IconAlert size={14} />
            <span>{fmt.msg(error.msg, error.text)}</span>
          </div>
        )}

        {result ? (
          <ResultView result={result} plan={plan} fmt={fmt} />
        ) : (
          plan && (
            <>
              <ModeBar dryRun={plan.dryRun} />
              {plan.globalBlockedReason && (
                <div className="notice warn" role="alert">
                  <IconAlert size={14} />
                  <span>
                    {plan.dryRun ? `${t('deletion:wouldBeBlocked')} ` : ''}
                    {fmt.msg(plan.globalBlockedMsg, plan.globalBlockedReason)}
                  </span>
                  <div className="spacer" />
                  <button className="btn small" onClick={() => void recheck()}>
                    <IconRefresh size={14} /> {t('deletion:recheck')}
                  </button>
                </div>
              )}
              {plan.blocked.length > 0 && (
                <div className="notice warn block">
                  <strong>{t('deletion:blockedSessions', { count: plan.blocked.length })}</strong>
                  <ul className="plain-list">
                    {plan.blocked.map((b) => (
                      <li key={b.sessionId}>
                        <span className="strong">{localTitle(t, b.displayTitle)}</span> — {fmt.msg(b.blockedMsg, b.blockedReason ?? '')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {plan.sessions.length > 0 && (
                <>
                  {!plan.dryRun && (
                    <div className="danger-box">
                      <IconAlert size={18} />
                      <div>
                        <strong>{t('deletion:danger.title')}</strong>
                        <div className="small">{t('deletion:danger.text')}</div>
                      </div>
                    </div>
                  )}

                  <div className="plan-list">
                    {plan.sessions.map((s) => (
                      <SessionPlanCard key={s.sessionId} plan={s} fmt={fmt} />
                    ))}
                  </div>

                  <dl className="plan-meta">
                    <dt>{t('deletion:meta.planId')}</dt>
                    <dd className="mono">{plan.planId}</dd>
                    <dt>{t('deletion:meta.hash')}</dt>
                    <dd className="mono">sha256:{plan.contentHash}</dd>
                    <dt>{t('deletion:meta.created')}</dt>
                    <dd>{fmt.fullDateTime(plan.createdAt)}</dd>
                    <dt>{t('deletion:meta.expires')}</dt>
                    <dd>{fmt.fullDateTime(plan.expiresAt)}</dd>
                  </dl>

                  <label className="confirm-label">
                    <span>
                      {plan.confirmationPhrases.length > 1
                        ? tCode(t, 'deletion:confirm.typeEither', { a: plan.confirmationPhrases[0], b: plan.confirmationPhrases[1] })
                        : tCode(t, 'deletion:confirm.type', { phrase: plan.confirmationPhrases[0] })}
                    </span>
                    <input
                      className={`confirm-input mono ${confirmText && !valid ? 'invalid' : ''}`}
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void execute()}
                      disabled={blockedForReal || running}
                      data-autofocus
                      autoFocus
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={plan.confirmationPhrases[0]}
                      aria-invalid={!!confirmText && !valid}
                    />
                  </label>
                </>
              )}
              {plan.sessions.length === 0 && <div className="hint">{t('deletion:nothing')}</div>}
            </>
          )
        )}
      </div>

      <footer className="modal-footer">
        {plan && (
          <button
            className="btn quiet caps"
            onClick={() =>
              void copyToClipboard(result?.reportText ?? plan.reportText, { key: result ? 'deletion:copied.result' : 'deletion:copied.plan' })
            }
            title={t('deletion:copyHint')}
          >
            <IconCopy size={14} /> {t(result ? 'deletion:action.copyResult' : 'deletion:action.copyPlan')}
          </button>
        )}
        <div className="spacer" />
        {result ? (
          <button className="btn" onClick={closeDelete} data-autofocus>
            {t('common:action.close')}
          </button>
        ) : (
          <>
            <button className="btn quiet" onClick={closeDelete} disabled={running}>
              {t('common:action.cancel')}
            </button>
            {(plan ? plan.dryRun : safety?.dryRun !== false) ? (
              <button className="btn info solid" disabled={!canRun} onClick={() => void execute()}>
                <IconShield size={14} />
                {running ? t('deletion:action.validating') : t('deletion:action.runDryRun')}
              </button>
            ) : (
              <button className="btn danger solid" disabled={!canRun} onClick={() => void execute()}>
                <IconTrash size={14} />
                {running ? t('deletion:action.deleting') : t('common:action.deletePermanently')}
              </button>
            )}
          </>
        )}
      </footer>
    </Modal>
  )
}

function ModeBar({ dryRun }: { dryRun: boolean }): ReactElement {
  const { t } = useTranslation()
  return dryRun ? (
    <div className="mode-bar safe">
      <span className="mode-chip safe">
        <IconShield size={14} />
        {t('safety:mode.safeDryRun')}
      </span>
      <span>{t('deletion:mode.safeText')}</span>
    </div>
  ) : (
    <div className="mode-bar armed">
      <span className="mode-chip armed">
        <IconShieldAlert size={14} />
        {t('safety:mode.armed')}
      </span>
      <span>{t('deletion:mode.armedText')}</span>
    </div>
  )
}

function actionLabel(t: ReturnType<typeof useTranslation>['t'], i: DeletePlanItem): string {
  return t(`deletion:itemAction.${i.action}`, {
    files: t('deletion:count.files', { count: i.fileCount ?? 0 }),
    folders: t('deletion:count.folders', { count: i.dirCount ?? 1 })
  })
}

function ItemRow({ item, fmt }: { item: AnyItem; fmt: Formatters }): ReactElement {
  const { t } = useTranslation()
  const outcome = 'outcome' in item ? item.outcome : undefined
  return (
    <div className="plan-item">
      <div className="plan-item-head">
        {outcome && <OutcomeIcon outcome={outcome} />}
        <span className="plan-kind">{t(`deletion:kind.${item.kind}`)}</span>
        <span className="plan-action">{outcome ? t(`deletion:outcome.${outcome}`) : actionLabel(t, item)}</span>
        <div className="spacer" />
        {item.sizeBytes !== undefined && isDelete(item) && <span className="plan-size">{fmt.bytes(item.sizeBytes)}</span>}
      </div>
      <div className="plan-path mono">{item.path}</div>
      {item.note && <div className="plan-note">{fmt.msg(item.noteMsg, item.note)}</div>}
      {'error' in item && item.error && <div className="plan-note danger-text">{fmt.msg(item.errorMsg, item.error)}</div>}
    </div>
  )
}

function PlanGroup({ label, tone, items, fmt }: { label: string; tone: 'delete' | 'change' | 'record'; items: AnyItem[]; fmt: Formatters }): ReactElement | null {
  if (!items.length) return null
  return (
    <div className={`plan-group ${tone}`}>
      <div className="plan-group-label">
        {label} <span className="plan-group-count">{fmt.count(items.length)}</span>
      </div>
      {items.map((i) => (
        <ItemRow key={`${i.kind}|${i.path}|${i.note ?? ''}`} item={i} fmt={fmt} />
      ))}
    </div>
  )
}

function SessionPlanCard({ plan: s, items, fmt }: { plan: SessionDeletePlan; items?: AnyItem[]; fmt: Formatters }): ReactElement {
  const { t } = useTranslation()
  const list = items ?? s.items
  return (
    <div className="plan-session">
      <div className="plan-session-head">
        <span className="plan-session-title">{localTitle(t, s.displayTitle)}</span>
        <span className="plan-session-size">
          {t('deletion:sessionSummary', {
            files: t('deletion:count.files', { count: s.totalFiles }),
            folders: t('deletion:count.folders', { count: s.totalDirs }),
            size: fmt.bytes(s.totalBytes),
            bytes: fmt.count(s.totalBytes)
          })}
        </span>
      </div>
      <dl className="kv compact plan-kv">
        <dt>{t('inspector:field.cliSessionId')}</dt>
        <dd className="mono">{s.cliSessionId ?? '—'}</dd>
        {s.desktopSessionId && (
          <>
            <dt>{t('inspector:field.desktopSessionId')}</dt>
            <dd className="mono">{s.desktopSessionId}</dd>
          </>
        )}
        <dt>{t('inspector:field.project')}</dt>
        <dd>{s.projectName}</dd>
        <dt>{t('inspector:field.projectPath')}</dt>
        <dd className="mono">{s.projectPath ?? t('inspector:value.unknown')}</dd>
      </dl>
      <PlanGroup label={t('deletion:group.willDelete')} tone="delete" items={list.filter(isDelete)} fmt={fmt} />
      <PlanGroup label={t('deletion:group.willChange')} tone="change" items={list.filter((i) => i.action === 'create-file' || i.action === 'update-file')} fmt={fmt} />
      <PlanGroup label={t('deletion:group.managerRecords')} tone="record" items={list.filter((i) => i.action === 'remove-record')} fmt={fmt} />
      <div className="plan-group keep">
        <div className="plan-group-label">
          <IconShield size={14} /> {t('deletion:group.willNotDelete')}
        </div>
        {s.willNotDelete.map((k) => (
          <div key={k.path} className="plan-item">
            <div className="plan-path mono">{k.path}</div>
            <div className="plan-note">{fmt.msg(k.reasonMsg, k.reason)}</div>
          </div>
        ))}
      </div>
      {s.warnings.map((w, idx) => (
        <div key={idx} className="plan-note warn-text">
          {fmt.msg(s.warningMsgs?.[idx], w)}
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

function ResultView({ result, plan, fmt }: { result: DeleteResult; plan: DeletePlan | null; fmt: Formatters }): ReactElement {
  const { t } = useTranslation()
  const tone = result.ok ? (result.dryRun ? 'info' : 'success') : result.dryRun ? 'warn' : 'error'
  return (
    <>
      <div className={`notice ${tone}`} role="status">
        {result.ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
        <span>{fmt.msg(result.msg, result.message)}</span>
      </div>
      {result.dryRun && <div className="hint">{t('deletion:dryRunExplain')}</div>}
      <div className="plan-list">
        {result.sessions.map((r) => {
          const p = plan?.sessions.find((s) => s.sessionId === r.sessionId)
          return p ? (
            <div key={r.sessionId} className="result-session">
              <span className={`badge outcome-${r.outcome}`}>{t(`deletion:sessionOutcome.${r.outcome}`)}</span>
              <SessionPlanCard plan={p} items={r.items} fmt={fmt} />
            </div>
          ) : null
        })}
      </div>
    </>
  )
}
