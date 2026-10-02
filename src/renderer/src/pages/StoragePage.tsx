import { useEffect, useId, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { StorageInfo } from '../../../shared/types'
import { EmptyState } from '../components/EmptyState'
import { IconAlert, IconChevron, IconDatabase } from '../components/Icons'
import { useFmt } from '../i18n'
import { errText, select, setView, useAppState } from '../stores/appStore'
import { localTitle } from '../utils/titles'

const api = (): Window['sessionManager'] => window.sessionManager

export function StoragePage(): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  const snapshot = useAppState((s) => s.snapshot)
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api()
      .getStorageInfo()
      .then(setInfo)
      .catch((err) => setError(errText(err)))
  }, [snapshot])

  if (error) {
    return (
      <div className="page">
        <EmptyState tone="error" icon={<IconAlert size={18} />} title={t('storage:loadFailed')} hint={<span className="mono">{error}</span>} />
      </div>
    )
  }
  if (!info) {
    return (
      <div className="page">
        <EmptyState icon={<IconDatabase size={18} />} title={t('storage:loading')} />
      </div>
    )
  }

  const maxProject = Math.max(1, ...info.topProjects.map((p) => p.totalSize))
  const maxSession = Math.max(1, ...info.largestSessions.map((s) => s.totalSize))
  const parts = [
    { key: 'transcripts', bytes: info.transcriptBytes, cls: 'seg-1' },
    { key: 'sessionData', bytes: info.sessionDataBytes, cls: 'seg-2' },
    { key: 'other', bytes: info.otherBytes, cls: 'seg-3' }
  ]
  const total = Math.max(1, parts.reduce((n, p) => n + p.bytes, 0))

  return (
    <div className="page storage">
      <header className="page-header">
        <h1 className="page-title">{t('storage:title')}</h1>
        <span className="count-label">{t('storage:lastScan', { time: fmt.dateTime(info.scannedAt) })}</span>
      </header>

      <div className="storage-hero">
        <div className="hero-total">
          <div className="hero-value">{fmt.bytes(info.totalSize)}</div>
          <div className="hero-label">{t('storage:stat.totalDisk')}</div>
        </div>
        <div className="stat-cells">
          <Stat label={t('storage:stat.sessions')} value={fmt.count(info.totalSessions)} />
          <Stat label={t('storage:stat.active')} value={fmt.count(info.active)} />
          <Stat label={t('storage:stat.archived')} value={fmt.count(info.archived)} />
          <Stat label={t('storage:stat.hidden')} value={fmt.count(info.hiddenInManager)} />
          <Stat label={t('storage:stat.transcriptOnly')} value={fmt.count(info.transcriptOnly)} />
          <Stat label={t('storage:stat.metadataOrphan')} value={fmt.count(info.metadataOnly + info.orphan)} />
        </div>
      </div>

      <StorageSection title={t('storage:section.breakdown')}>
        <div className="stack-bar" role="img" aria-label={parts.map((p) => `${t(`storage:part.${p.key}`)}: ${fmt.bytes(p.bytes)}`).join(', ')}>
          {parts.map((p) => (
            <div key={p.key} className={`stack-seg ${p.cls}`} style={{ width: `${(p.bytes / total) * 100}%` }} />
          ))}
        </div>
        <div className="legend">
          {parts.map((p) => (
            <span key={p.key} className="legend-item">
              <span className={`legend-swatch ${p.cls}`} aria-hidden="true" />
              {t(`storage:part.${p.key}`)}
              <span className="legend-value">{fmt.bytes(p.bytes)}</span>
            </span>
          ))}
        </div>
      </StorageSection>

      <div className="two-col">
        <StorageSection title={t('storage:section.topProjects')}>
          <ol className="ranked">
            {info.topProjects.map((p, i) => (
              <li key={p.projectKey}>
                <button className="ranked-row" onClick={() => setView({ kind: 'sessions', filter: 'all', project: p.projectKey })} title={p.projectPath}>
                  <span className="rank mono">{String(i + 1).padStart(2, '0')}</span>
                  <span className="ranked-main">
                    <span className="ranked-name">{p.projectKey === 'unresolved' ? t('sessions:unknownProject') : p.projectName}</span>
                    <span className="ranked-sub">{t('storage:sessionsCount', { count: p.sessions })}</span>
                  </span>
                  <span className="ranked-bar" aria-hidden="true">
                    <span className="ranked-fill" style={{ width: `${(p.totalSize / maxProject) * 100}%` }} />
                  </span>
                  <span className="ranked-value">{fmt.bytes(p.totalSize)}</span>
                </button>
              </li>
            ))}
          </ol>
          {info.topProjects.length === 0 && <div className="hint">{t('storage:noProjects')}</div>}
        </StorageSection>

        <StorageSection title={t('storage:section.largestSessions')}>
          <ol className="ranked">
            {info.largestSessions.map((s, i) => (
              <li key={s.id}>
                <button
                  className="ranked-row"
                  onClick={() => {
                    setView({ kind: 'sessions', filter: 'all' })
                    select(s.id)
                  }}
                  title={`${localTitle(t, s.displayTitle)} — ${t(`sessions:status.${s.status}`)}`}
                >
                  <span className="rank mono">{String(i + 1).padStart(2, '0')}</span>
                  <span className="ranked-main">
                    <span className="ranked-name">{localTitle(t, s.displayTitle)}</span>
                    <span className="ranked-sub">{s.projectName}</span>
                  </span>
                  <span className="ranked-bar" aria-hidden="true">
                    <span className="ranked-fill alt" style={{ width: `${(s.totalSize / maxSession) * 100}%` }} />
                  </span>
                  <span className="ranked-value">{fmt.bytes(s.totalSize)}</span>
                </button>
              </li>
            ))}
          </ol>
        </StorageSection>
      </div>

      {snapshot && (
        <StorageSection title={t('storage:section.lastScan')}>
          <dl className="scan-stats">
            <ScanStat label={t('storage:scan.transcripts')} value={fmt.count(snapshot.stats.transcripts)} />
            <ScanStat label={t('storage:scan.parsed')} value={fmt.count(snapshot.stats.transcriptsParsed)} />
            <ScanStat label={t('storage:scan.incremental')} value={fmt.count(snapshot.stats.transcriptsIncremental)} />
            <ScanStat label={t('storage:scan.fromCache')} value={fmt.count(snapshot.stats.transcriptsFromCache)} />
            <ScanStat label={t('storage:scan.subagentExcluded')} value={fmt.count(snapshot.stats.subagentLogsExcluded)} />
            <ScanStat label={t('storage:scan.metadataFiles')} value={fmt.count(snapshot.stats.metadataFiles)} />
            <ScanStat label={t('storage:scan.tombstones')} value={fmt.count(snapshot.stats.tombstones)} />
            <ScanStat label={t('storage:scan.duration')} value={t('storage:scan.ms', { value: fmt.count(snapshot.durationMs) })} />
          </dl>
          {snapshot.issues.length > 0 && (
            <details className="disclosure">
              <summary>
                <IconChevron size={12} className="chev" />
                {t('storage:scan.issues', { count: snapshot.issues.length })}
              </summary>
              <ul className="issue-list">
                {snapshot.issues.map((i, idx) => (
                  <li key={idx}>
                    {fmt.msg(i.msg, i.message)}
                    {i.path && <div className="mono muted">{i.path}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </StorageSection>
      )}
    </div>
  )
}

function StorageSection({ title, children }: { title: string; children: ReactNode }): ReactElement {
  const id = useId()
  return (
    <section className="storage-section" aria-labelledby={id}>
      <h2 className="section-label" id={id}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="stat-cell">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function ScanStat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="scan-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
