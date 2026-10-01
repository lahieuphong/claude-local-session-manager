import { useEffect, useState, type ReactElement } from 'react'
import type { StorageInfo } from '../../../shared/types'
import { formatBytes, formatCount, formatDateTime } from '../../../shared/format'
import { STATUS_LABEL } from '../components/Badges'
import { errText, select, setView, useAppState } from '../stores/appStore'

const api = (): Window['sessionManager'] => window.sessionManager

export function StoragePage(): ReactElement {
  const snapshot = useAppState((s) => s.snapshot)
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api()
      .getStorageInfo()
      .then(setInfo)
      .catch((err) => setError(errText(err)))
  }, [snapshot])

  if (error) return <div className="page"><div className="notice error">{error}</div></div>
  if (!info) return <div className="page"><div className="muted">Loading storage statistics…</div></div>

  const maxProject = Math.max(1, ...info.topProjects.map((p) => p.totalSize))
  const maxSession = Math.max(1, ...info.largestSessions.map((s) => s.totalSize))
  const parts = [
    { label: 'Transcripts', bytes: info.transcriptBytes, cls: 'seg-1' },
    { label: 'Session data (subagents, tool results)', bytes: info.sessionDataBytes, cls: 'seg-2' },
    { label: 'File history, env, metadata', bytes: info.otherBytes, cls: 'seg-3' }
  ]
  const total = Math.max(1, parts.reduce((n, p) => n + p.bytes, 0))

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Storage</h1>
        <span className="muted small">Last scan {formatDateTime(info.scannedAt)}</span>
      </header>

      <div className="stat-grid">
        <Stat label="Total sessions" value={formatCount(info.totalSessions)} />
        <Stat label="Active" value={formatCount(info.active)} />
        <Stat label="Archived" value={formatCount(info.archived)} />
        <Stat label="Transcript-only" value={formatCount(info.transcriptOnly)} />
        <Stat label="Metadata-only / orphan" value={formatCount(info.metadataOnly + info.orphan)} />
        <Stat label="Total disk usage" value={formatBytes(info.totalSize)} emphasis />
      </div>

      <section className="card">
        <h3 className="section-title">Disk usage breakdown</h3>
        <div className="stack-bar">
          {parts.map((p) => (
            <div key={p.label} className={`stack-seg ${p.cls}`} style={{ width: `${(p.bytes / total) * 100}%` }} title={`${p.label}: ${formatBytes(p.bytes)}`} />
          ))}
        </div>
        <div className="legend">
          {parts.map((p) => (
            <span key={p.label} className="legend-item">
              <span className={`legend-swatch ${p.cls}`} />
              {p.label} <span className="muted">{formatBytes(p.bytes)}</span>
            </span>
          ))}
        </div>
      </section>

      <div className="two-col">
        <section className="card">
          <h3 className="section-title">Top projects by disk usage</h3>
          {info.topProjects.map((p) => (
            <button key={p.projectKey} className="bar-row" onClick={() => setView({ kind: 'sessions', filter: 'all', project: p.projectKey })} title={p.projectPath}>
              <span className="bar-label">{p.projectName}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${(p.totalSize / maxProject) * 100}%` }} />
              </span>
              <span className="bar-value">{formatBytes(p.totalSize)}</span>
              <span className="bar-sub muted">{p.sessions}</span>
            </button>
          ))}
          {info.topProjects.length === 0 && <div className="muted small">No projects.</div>}
        </section>

        <section className="card">
          <h3 className="section-title">Largest sessions</h3>
          {info.largestSessions.map((s) => (
            <button
              key={s.id}
              className="bar-row"
              onClick={() => {
                setView({ kind: 'sessions', filter: 'all' })
                select(s.id)
              }}
              title={`${s.displayTitle} — ${STATUS_LABEL[s.status]}`}
            >
              <span className="bar-label">{s.displayTitle}</span>
              <span className="bar-track">
                <span className="bar-fill alt" style={{ width: `${(s.totalSize / maxSession) * 100}%` }} />
              </span>
              <span className="bar-value">{formatBytes(s.totalSize)}</span>
              <span className="bar-sub muted">{s.projectName}</span>
            </button>
          ))}
        </section>
      </div>

      {snapshot && (
        <section className="card">
          <h3 className="section-title">Last scan</h3>
          <div className="scan-stats">
            <span>{formatCount(snapshot.stats.transcripts)} transcripts</span>
            <span>{formatCount(snapshot.stats.transcriptsParsed)} parsed</span>
            <span>{formatCount(snapshot.stats.transcriptsIncremental)} incremental</span>
            <span>{formatCount(snapshot.stats.transcriptsFromCache)} from cache</span>
            <span>{formatCount(snapshot.stats.subagentLogsExcluded)} subagent logs excluded</span>
            <span>{formatCount(snapshot.stats.metadataFiles)} metadata files</span>
            <span>{formatCount(snapshot.stats.tombstones)} tombstones</span>
            <span>{snapshot.durationMs} ms</span>
          </div>
          {snapshot.issues.length > 0 && (
            <details className="issues">
              <summary>{snapshot.issues.length} scan issue(s)</summary>
              <ul className="plain-list small">
                {snapshot.issues.map((i, idx) => (
                  <li key={idx}>
                    {i.message}
                    {i.path && <div className="mono muted">{i.path}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  )
}

function Stat({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }): ReactElement {
  return (
    <div className={`stat ${emphasis ? 'emphasis' : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}
