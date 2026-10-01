import { useState, type ReactElement } from 'react'
import type { LogEntry, RefreshMode } from '../../../shared/types'
import { formatDateTime } from '../../../shared/format'
import { IconCheck, IconX } from '../components/Icons'
import { DeletionSafetySection } from '../components/SafetyMode'
import { AboutSection } from '../components/Updates'
import { clearCache, errText, toast, updateSettings, useAppState } from '../stores/appStore'

const api = (): Window['sessionManager'] => window.sessionManager

export function SettingsPage(): ReactElement {
  const settings = useAppState((s) => s.settings)
  const snapshot = useAppState((s) => s.snapshot)
  const appInfo = useAppState((s) => s.appInfo)
  const busy = useAppState((s) => s.busy)
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const roots = snapshot?.roots

  const loadLogs = async (): Promise<void> => {
    try {
      setLogs(await api().getLogs())
    } catch (err) {
      toast('error', errText(err))
    }
  }

  return (
    <div className="page settings">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
      </header>

      <section className="card">
        <h3 className="section-title">Auto-discovered storage roots</h3>
        <p className="muted small">
          Roots are detected from USERPROFILE / APPDATA / LOCALAPPDATA on every scan. They cannot be edited: the app only ever modifies
          files inside these roots, and only paths the scanner attributed to a session.
        </p>
        {roots ? (
          <dl className="kv roots">
            <dt>Claude Code home</dt>
            <dd><code>{roots.claudeHome}</code></dd>
            <dt>Transcript root</dt>
            <dd>{roots.projectsRoot ? <code>{roots.projectsRoot}</code> : <span className="warn-text">not found</span>}</dd>
            <dt>File history</dt>
            <dd>{roots.fileHistoryRoot ? <code>{roots.fileHistoryRoot}</code> : <span className="muted">not found</span>}</dd>
            <dt>Session env</dt>
            <dd>{roots.sessionEnvRoot ? <code>{roots.sessionEnvRoot}</code> : <span className="muted">not found</span>}</dd>
            <dt>Running sessions</dt>
            <dd>{roots.liveSessionsDir ? <code>{roots.liveSessionsDir}</code> : <span className="muted">not found</span>}</dd>
            <dt>Claude metadata roots</dt>
            <dd>
              {roots.desktopRoots.length === 0 && <span className="muted">No Claude Desktop claude-code-sessions folder found</span>}
              {roots.desktopRoots.map((d) => (
                <div key={d.path} className="root-entry">
                  <code>{d.path}</code>
                  <div className="muted small">
                    {d.source.toUpperCase()} · {d.variant}
                    {d.packageName ? ` · ${d.packageName}` : ''} · {d.sessionFiles} session file(s) · {d.tombstones} tombstone(s) ·{' '}
                    {d.archiveIndexes} archive index(es)
                  </div>
                </div>
              ))}
            </dd>
          </dl>
        ) : (
          <div className="muted">Scan pending…</div>
        )}
        {roots && (
          <details className="issues">
            <summary>All locations checked ({roots.candidates.length})</summary>
            <ul className="plain-list small">
              {roots.candidates.map((c) => (
                <li key={c.path} className="candidate">
                  {c.exists ? <IconCheck size={13} className="ok-text" /> : <IconX size={13} className="muted" />}
                  <code>{c.path}</code>
                  {c.note && <span className="muted"> — {c.note}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card">
        <h3 className="section-title">Refresh</h3>
        <div className="radio-group">
          {(
            [
              ['manual', 'Manual only', 'Scan on start and when you click Refresh (F5).'],
              ['watch', 'Watch files', 'Rescan shortly after Claude writes to its storage folders (debounced, few watchers).'],
              ['interval', 'Interval', 'Rescan on a fixed timer.']
            ] as Array<[RefreshMode, string, string]>
          ).map(([mode, label, hint]) => (
            <label key={mode} className="radio">
              <input type="radio" name="refresh" checked={settings?.refreshMode === mode} onChange={() => void updateSettings({ refreshMode: mode })} />
              <span>
                {label}
                <span className="muted small"> — {hint}</span>
              </span>
            </label>
          ))}
        </div>
        {settings?.refreshMode === 'interval' && (
          <label className="inline-field">
            Interval
            <select value={settings.refreshIntervalSec} onChange={(e) => void updateSettings({ refreshIntervalSec: Number(e.target.value) })}>
              {[15, 30, 60, 120, 300, 600].map((s) => (
                <option key={s} value={s}>
                  {s < 60 ? `${s} seconds` : `${s / 60} minute${s > 60 ? 's' : ''}`}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section className="card">
        <h3 className="section-title">Display & developer</h3>
        <label className="toggle">
          <input type="checkbox" checked={settings?.showRawPaths ?? false} onChange={(e) => void updateSettings({ showRawPaths: e.target.checked })} />
          <span>
            Show raw paths
            <span className="muted small"> — full absolute paths instead of ~ / %LOCALAPPDATA% shorthands (the delete dialog always shows full paths)</span>
          </span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={settings?.debugMode ?? false} onChange={(e) => void updateSettings({ debugMode: e.target.checked })} />
          <span>
            Developer / debug mode
            <span className="muted small"> — verbose logging, normalized session JSON in Details, DevTools (F12)</span>
          </span>
        </label>
        <div className="row-flex gap">
          <button className="btn small" onClick={() => void clearCache()} disabled={busy}>
            Clear scan cache
          </button>
          <button className="btn small" onClick={() => void loadLogs()}>
            Show log
          </button>
        </div>
        {appInfo && (
          <dl className="kv small">
            <dt>Cache</dt>
            <dd><code>{appInfo.cachePath}</code></dd>
            <dt>Log file</dt>
            <dd><code>{appInfo.logPath}</code></dd>
          </dl>
        )}
        {logs && (
          <pre className="code-block log">
            {logs
              .slice(-200)
              .map((l) => `${formatDateTime(l.time)} [${l.level}] ${l.message}`)
              .join('\n') || '(empty)'}
          </pre>
        )}
      </section>

      <DeletionSafetySection />

      <AboutSection />
    </div>
  )
}
