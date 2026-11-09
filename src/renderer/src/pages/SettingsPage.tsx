import { useId, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LOCALE_LABELS, SUPPORTED_LOCALES } from '../../../shared/locale'
import type { LogEntry, MotionPreference, RefreshMode, StorageRoots } from '../../../shared/types'
import { IconCheck, IconChevron, IconX } from '../components/Icons'
import { DeletionSafetySection } from '../components/SafetyMode'
import { Select } from '../components/Select'
import { AboutSection, UpdatesSection } from '../components/Updates'
import { UsageSection } from '../components/Usage'
import { useFmt } from '../i18n'
import { clearCache, errText, hasSafeMode, setLanguage, setMotion, toast, toolContext, updateSettings, useAppState } from '../stores/appStore'
import { displayPath } from '../utils/paths'

const api = (): Window['sessionManager'] => window.sessionManager

const REFRESH_MODES: RefreshMode[] = ['manual', 'watch', 'interval']
const INTERVALS = [15, 30, 60, 120, 300, 600]
const MOTIONS: MotionPreference[] = ['system', 'reduced']

/**
 * Settings: how much of the plan's limits is used, what people change
 * (language, motion, refresh), where the sessions come from, deletion safety
 * and updates. Paths, cache, debug mode
 * and logs are for troubleshooting and wait, closed, under "Advanced".
 */
export function SettingsPage(): ReactElement {
  const { t, i18n } = useTranslation()
  const settings = useAppState((s) => s.settings)
  const roots = useAppState((s) => s.snapshot?.roots)
  const safeMode = useAppState((s) => hasSafeMode(s.safety))
  const codex = useAppState((s) => s.provider) === 'codex'
  const context = useAppState(toolContext)
  const storeEdition = useAppState((s) => s.appInfo?.desktopDataReadOnly ?? false)
  const langName = useId()
  const motionName = useId()
  const refreshName = useId()
  const refreshMode = settings?.refreshMode ?? 'manual'

  return (
    <div className="page settings">
      <header className="page-header">
        <h1 className="page-title">{t('settings:title')}</h1>
      </header>

      <SettingsSection title={t('settings:section.usage')}>
        <UsageSection />
      </SettingsSection>

      <SettingsSection title={t('settings:section.general')}>
        <SettingRow label={t('settings:language.label')} id={langName}>
          <Segmented
            name={langName}
            value={i18n.language}
            options={SUPPORTED_LOCALES.map((l) => ({ value: l, label: LOCALE_LABELS[l].native, lang: l }))}
            onChange={(l) => void setLanguage(l)}
          />
          {settings?.language && (
            <button className="link-btn" onClick={() => void setLanguage(null)}>
              {t('settings:language.useSystem')}
            </button>
          )}
        </SettingRow>
        <SettingRow label={t('settings:motion.label')} id={motionName}>
          <Segmented
            name={motionName}
            value={settings?.motion ?? 'system'}
            options={MOTIONS.map((m) => ({ value: m, label: t(`settings:motion.${m}`) }))}
            onChange={(m) => void setMotion(m)}
          />
        </SettingRow>
        <SettingRow label={t('settings:refresh.label')} hint={t(`settings:refresh.${refreshMode}Hint`)} id={refreshName}>
          <Segmented
            name={refreshName}
            dataName="refresh"
            value={refreshMode}
            options={REFRESH_MODES.map((m) => ({ value: m, label: t(`settings:refresh.${m}`) }))}
            onChange={(m) => void updateSettings({ refreshMode: m })}
          />
          {settings?.refreshMode === 'interval' && (
            <div className="inline-field">
              <span aria-hidden="true">{t('settings:refresh.every')}</span>
              <Select
                name="refresh-interval"
                label={t('settings:refresh.interval')}
                value={settings.refreshIntervalSec}
                onChange={(s) => void updateSettings({ refreshIntervalSec: s })}
                options={INTERVALS.map((s) => ({ value: s, label: s < 60 ? t('settings:refresh.seconds', { count: s }) : t('settings:refresh.minutes', { count: s / 60 }) }))}
              />
            </div>
          )}
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings:section.data', { context })}>
        <SettingRow label={t('settings:data.folder')} hint={t('settings:data.hint', { context })}>
          <DataFolders roots={roots} codex={codex} raw={settings?.showRawPaths ?? false} />
        </SettingRow>
        {!codex && storeEdition && <p className="setting-note">{t('settings:storeEdition.limits')}</p>}
        {codex && (
          <SettingRow label={t('settings:data.cli')} hint={t('settings:data.cliHint')}>
            {!roots ? null : roots.codexCli ? (
              <span className="inline-status ok-text">
                <IconCheck size={14} />
                {t('settings:data.cliReady')}
              </span>
            ) : (
              <span className="warn-text">{t('settings:roots.codexCliMissing')}</span>
            )}
          </SettingRow>
        )}
      </SettingsSection>

      {safeMode && (
        <SettingsSection title={t('settings:section.deletionSafety')} tone="safety">
          <DeletionSafetySection />
        </SettingsSection>
      )}

      <SettingsSection title={t('settings:section.updates')}>
        <UpdatesSection />
      </SettingsSection>

      <AdvancedSection roots={roots} codex={codex} />

      <AboutSection />
    </div>
  )
}

/** Paths, cache, debug mode and logs: closed until opened. */
function AdvancedSection({ roots, codex }: { roots: StorageRoots | undefined; codex: boolean }): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  const settings = useAppState((s) => s.settings)
  const appInfo = useAppState((s) => s.appInfo)
  const busy = useAppState((s) => s.busy)
  const context = useAppState(toolContext)
  const [logs, setLogs] = useState<LogEntry[] | null>(null)

  const loadLogs = async (): Promise<void> => {
    try {
      setLogs(await api().getLogs())
    } catch (err) {
      toast('error', { text: errText(err) })
    }
  }

  return (
    <details className="settings-advanced">
      <summary>
        <IconChevron size={12} className="chev" />
        <span className="section-label">{t('settings:section.advanced')}</span>
        <span className="advanced-sub">{t('settings:advanced.summary')}</span>
      </summary>
      <div className="settings-card">
        <SettingRow label={t('settings:rawPaths.label')} hint={t('settings:rawPaths.hint')}>
          <Switch checked={settings?.showRawPaths ?? false} onChange={(v) => void updateSettings({ showRawPaths: v })} label={t('settings:rawPaths.label')} />
        </SettingRow>
        <SettingRow label={t('settings:cache.label')} hint={t('settings:cache.hint')}>
          <button className="btn" data-action="clear-cache" onClick={() => void clearCache()} disabled={busy}>
            {t('settings:cache.clear')}
          </button>
        </SettingRow>
        <SettingRow label={t('settings:debug.label')} hint={t('settings:debug.hint')}>
          <Switch checked={settings?.debugMode ?? false} onChange={(v) => void updateSettings({ debugMode: v })} label={t('settings:debug.label')} />
        </SettingRow>

        <SettingRow label={t('settings:roots.label')} stacked>
          {roots ? (
            <dl className="kv roots">
              {roots.accounts.length > 1 && (
                <>
                  <dt>{t('settings:roots.accounts', { context })}</dt>
                  <dd>
                    {roots.accounts.map((a) => (
                      <div key={a.id} className="root-entry">
                        <code className="wrap">{a.path}</code>
                        <div className="hint">{a.email ?? a.label}</div>
                      </div>
                    ))}
                  </dd>
                </>
              )}
              {codex ? (
                <>
                  <dt>{t('settings:roots.codexHome')}</dt>
                  <dd>{roots.claudeHome ? <code className="wrap">{roots.claudeHome}</code> : <span className="warn-text">{t('settings:roots.notFound')}</span>}</dd>
                  <dt>{t('settings:roots.codexCli')}</dt>
                  <dd>{roots.codexCli ? <code className="wrap">{roots.codexCli}</code> : <span className="warn-text">{t('settings:roots.codexCliMissing')}</span>}</dd>
                </>
              ) : (
                <ClaudeRoots roots={roots} />
              )}
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
                    {c.note && <span className="muted"> — {c.noteKey ? t(`settings:roots.${c.noteKey}`) : c.note}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </SettingRow>

        <SettingRow label={t('settings:logs.label')} hint={t('settings:logs.hint')} stacked>
          {appInfo && (
            <dl className="kv compact">
              <dt>{t('settings:logs.userData')}</dt>
              <dd>
                <code className="wrap">{appInfo.userDataPath}</code>
              </dd>
              <dt>{t('settings:logs.cache')}</dt>
              <dd>
                <code className="wrap">{appInfo.cachePath}</code>
              </dd>
              <dt>{t('settings:logs.logFile')}</dt>
              <dd>
                <code className="wrap">{appInfo.logPath}</code>
              </dd>
              <dt>{t('settings:logs.runtime')}</dt>
              <dd>
                <code>
                  Electron {appInfo.electronVersion} · {appInfo.platform}
                </code>
              </dd>
            </dl>
          )}
          <div className="row-actions">
            <button className="btn" data-action="show-logs" onClick={() => void loadLogs()}>
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
      </div>
    </details>
  )
}

/** The folder each account keeps its sessions in, one line each. */
function DataFolders({ roots, codex, raw }: { roots: StorageRoots | undefined; codex: boolean; raw: boolean }): ReactElement {
  const { t } = useTranslation()
  if (!roots) return <span className="muted">{t('settings:roots.pending')}</span>
  const many = roots.accounts.length > 1
  const folders = many ? roots.accounts : roots.claudeHome ? [{ id: 'main', path: roots.claudeHome, label: '', email: undefined }] : []
  // Claude's folder may exist without a single conversation in it.
  const found = folders.length > 0 && (codex || !!roots.projectsRoot)
  return (
    <ul className="data-folders">
      {folders.map((a) => (
        <li key={a.id}>
          {many && <span className="data-folder-account muted">{a.email ?? a.label}</span>}
          <code className="wrap" title={a.path}>
            {displayPath(a.path, raw)}
          </code>
        </li>
      ))}
      {!found && <li className="warn-text">{t('settings:roots.notFound')}</li>}
    </ul>
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

/** A row of options, one chosen; `name` is also the ID of the label that names the group. */
function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  dataName
}: {
  name: string
  value: string
  options: { value: T; label: string; lang?: string }[]
  onChange(v: T): void
  dataName?: string
}): ReactElement {
  return (
    <div className="segmented" role="radiogroup" aria-labelledby={name} data-name={dataName}>
      {options.map((o) => (
        <label key={o.value} className={`segment ${value === o.value ? 'on' : ''}`} lang={o.lang}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
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

/** Where Claude keeps its sessions (the Codex view shows its own folder and CLI instead). */
function ClaudeRoots({ roots }: { roots: StorageRoots }): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  return (
    <>
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
    </>
  )
}
