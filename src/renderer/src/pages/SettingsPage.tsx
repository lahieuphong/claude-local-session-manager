import { useId, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LOCALE_LABELS, SUPPORTED_LOCALES, resolveLocale } from '../../../shared/locale'
import type { LogEntry, MotionPreference, RefreshMode } from '../../../shared/types'
import { IconCheck, IconChevron, IconX } from '../components/Icons'
import { DeletionSafetySection } from '../components/SafetyMode'
import { AboutSection, UpdatesSection } from '../components/Updates'
import { useFmt } from '../i18n'
import { clearCache, errText, setLanguage, setMotion, toast, updateSettings, useAppState } from '../stores/appStore'

const api = (): Window['sessionManager'] => window.sessionManager

const REFRESH_MODES: RefreshMode[] = ['manual', 'watch', 'interval']
const INTERVALS = [15, 30, 60, 120, 300, 600]
const MOTIONS: MotionPreference[] = ['system', 'reduced']

export function SettingsPage(): ReactElement {
  const { t, i18n } = useTranslation()
  const fmt = useFmt()
  const settings = useAppState((s) => s.settings)
  const snapshot = useAppState((s) => s.snapshot)
  const appInfo = useAppState((s) => s.appInfo)
  const busy = useAppState((s) => s.busy)
  const [logs, setLogs] = useState<LogEntry[] | null>(null)
  const roots = snapshot?.roots
  const langName = useId()
  const motionName = useId()
  const refreshName = useId()
  const systemLocale = resolveLocale(null, appInfo?.systemLanguages ?? navigator.languages ?? [])

  const loadLogs = async (): Promise<void> => {
    try {
      setLogs(await api().getLogs())
    } catch (err) {
      toast('error', { text: errText(err) })
    }
  }

  return (
    <div className="page settings">
      <header className="page-header">
        <h1 className="page-title">{t('settings:title')}</h1>
      </header>

      <SettingsSection title={t('settings:section.general')}>
        <SettingRow label={t('settings:language.label')} hint={t('settings:language.hint', { language: LOCALE_LABELS[systemLocale].native })} id={langName}>
          <div className="segmented" role="radiogroup" aria-labelledby={langName}>
            {SUPPORTED_LOCALES.map((l) => (
              <label key={l} className={`segment ${i18n.language === l ? 'on' : ''}`} lang={l}>
                <input type="radio" name={langName} checked={i18n.language === l} onChange={() => void setLanguage(l)} />
                {LOCALE_LABELS[l].native}
              </label>
            ))}
          </div>
          {settings?.language && (
            <button className="link-btn" onClick={() => void setLanguage(null)}>
              {t('settings:language.useSystem')}
            </button>
          )}
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings:section.appearance')}>
        <SettingRow label={t('settings:motion.label')} hint={t('settings:motion.hint')} id={motionName}>
          <div className="segmented" role="radiogroup" aria-labelledby={motionName}>
            {MOTIONS.map((m) => (
              <label key={m} className={`segment ${(settings?.motion ?? 'system') === m ? 'on' : ''}`}>
                <input type="radio" name={motionName} checked={(settings?.motion ?? 'system') === m} onChange={() => void setMotion(m)} />
                {t(`settings:motion.${m}`)}
              </label>
            ))}
          </div>
        </SettingRow>
        <SettingRow label={t('settings:rawPaths.label')} hint={t('settings:rawPaths.hint')}>
          <Switch checked={settings?.showRawPaths ?? false} onChange={(v) => void updateSettings({ showRawPaths: v })} label={t('settings:rawPaths.label')} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings:section.discovery')}>
        <SettingRow label={t('settings:refresh.label')} id={refreshName} stacked>
          <div className="radio-list" role="radiogroup" aria-labelledby={refreshName}>
            {REFRESH_MODES.map((mode) => (
              <label key={mode} className="radio">
                <input type="radio" name={refreshName} checked={settings?.refreshMode === mode} onChange={() => void updateSettings({ refreshMode: mode })} />
                <span>
                  <span className="radio-title">{t(`settings:refresh.${mode}`)}</span>
                  <span className="radio-hint">{t(`settings:refresh.${mode}Hint`)}</span>
                </span>
              </label>
            ))}
          </div>
          {settings?.refreshMode === 'interval' && (
            <label className="inline-field">
              <span>{t('settings:refresh.interval')}</span>
              <select className="select" value={settings.refreshIntervalSec} onChange={(e) => void updateSettings({ refreshIntervalSec: Number(e.target.value) })}>
                {INTERVALS.map((s) => (
                  <option key={s} value={s}>
                    {s < 60 ? t('settings:refresh.seconds', { count: s }) : t('settings:refresh.minutes', { count: s / 60 })}
                  </option>
                ))}
              </select>
            </label>
          )}
        </SettingRow>

        <SettingRow label={t('settings:roots.label')} hint={t('settings:roots.hint')} stacked>
          {roots ? (
            <dl className="kv roots">
              <dt>{t('settings:roots.claudeHome')}</dt>
              <dd>
                <code className="wrap">{roots.claudeHome}</code>
              </dd>
              <dt>{t('settings:roots.transcripts')}</dt>
              <dd>{roots.projectsRoot ? <code className="wrap">{roots.projectsRoot}</code> : <span className="warn-text">{t('settings:roots.notFound')}</span>}</dd>
              <dt>{t('settings:roots.fileHistory')}</dt>
              <dd>{roots.fileHistoryRoot ? <code className="wrap">{roots.fileHistoryRoot}</code> : <span className="muted">{t('settings:roots.notFound')}</span>}</dd>
              <dt>{t('settings:roots.sessionEnv')}</dt>
              <dd>{roots.sessionEnvRoot ? <code className="wrap">{roots.sessionEnvRoot}</code> : <span className="muted">{t('settings:roots.notFound')}</span>}</dd>
              <dt>{t('settings:roots.running')}</dt>
              <dd>{roots.liveSessionsDir ? <code className="wrap">{roots.liveSessionsDir}</code> : <span className="muted">{t('settings:roots.notFound')}</span>}</dd>
              <dt>{t('settings:roots.desktop')}</dt>
              <dd>
                {roots.desktopRoots.length === 0 && <span className="muted">{t('settings:roots.noDesktop')}</span>}
                {roots.desktopRoots.map((d) => (
                  <div key={d.path} className="root-entry">
                    <code className="wrap">{d.path}</code>
                    <div className="hint">
                      {d.source.toUpperCase()} · {d.variant}
                      {d.packageName ? ` · ${d.packageName}` : ''} ·{' '}
                      {t('settings:roots.desktopCounts', {
                        sessions: fmt.count(d.sessionFiles),
                        tombstones: fmt.count(d.tombstones),
                        indexes: fmt.count(d.archiveIndexes)
                      })}
                    </div>
                  </div>
                ))}
              </dd>
            </dl>
          ) : (
            <div className="hint">{t('settings:roots.pending')}</div>
          )}
          {roots && (
            <details className="disclosure">
              <summary>
                <IconChevron size={12} className="chev" />
                {t('settings:roots.checked', { count: roots.candidates.length })}
              </summary>
              <ul className="candidate-list">
                {roots.candidates.map((c) => (
                  <li key={c.path} className="candidate">
                    {c.exists ? <IconCheck size={14} className="ok-text" /> : <IconX size={14} className="muted" />}
                    <code className="wrap">{c.path}</code>
                    {c.note && <span className="muted"> — {c.note}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </SettingRow>

        <SettingRow label={t('settings:cache.label')} hint={t('settings:cache.hint')}>
          <button className="btn" onClick={() => void clearCache()} disabled={busy}>
            {t('settings:cache.clear')}
          </button>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings:section.deletionSafety')} tone="safety">
        <DeletionSafetySection />
      </SettingsSection>

      <SettingsSection title={t('settings:section.updates')}>
        <UpdatesSection />
      </SettingsSection>

      <SettingsSection title={t('settings:section.about')}>
        <AboutSection />
        <SettingRow label={t('settings:debug.label')} hint={t('settings:debug.hint')}>
          <Switch checked={settings?.debugMode ?? false} onChange={(v) => void updateSettings({ debugMode: v })} label={t('settings:debug.label')} />
        </SettingRow>
        <SettingRow label={t('settings:logs.label')} stacked>
          {appInfo && (
            <dl className="kv compact">
              <dt>{t('settings:logs.cache')}</dt>
              <dd>
                <code className="wrap">{appInfo.cachePath}</code>
              </dd>
              <dt>{t('settings:logs.logFile')}</dt>
              <dd>
                <code className="wrap">{appInfo.logPath}</code>
              </dd>
            </dl>
          )}
          <div className="row-actions">
            <button className="btn" onClick={() => void loadLogs()}>
              {t('settings:logs.show')}
            </button>
          </div>
          {logs && (
            <pre className="code-block log">
              {logs
                .slice(-200)
                .map((l) => `${fmt.fullDateTime(l.time)} [${l.level}] ${l.message}`)
                .join('\n') || t('settings:logs.empty')}
            </pre>
          )}
        </SettingRow>
      </SettingsSection>
    </div>
  )
}

function SettingsSection({ title, tone, children }: { title: string; tone?: 'safety'; children: ReactNode }): ReactElement {
  const id = useId()
  return (
    <section className={`settings-section ${tone ?? ''}`} aria-labelledby={id}>
      <h2 className="section-label" id={id}>
        {title}
      </h2>
      <div className="settings-card">{children}</div>
    </section>
  )
}

function SettingRow({ label, hint, id, stacked, children }: { label: string; hint?: string; id?: string; stacked?: boolean; children: ReactNode }): ReactElement {
  return (
    <div className={`setting-row ${stacked ? 'stacked' : ''}`}>
      <div className="setting-text">
        <div className="setting-label" id={id}>
          {label}
        </div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }): ReactElement {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </label>
  )
}
