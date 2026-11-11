import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { FIVE_HOURS, ONE_WEEK, type AccountUsage, type ClaudeAccount, type Provider, type UsageLimit } from '../../../shared/types'
import { useFmt } from '../i18n'
import { toolContext, useAppState } from '../stores/appStore'

/**
 * While the usage is on screen it is read again this often, so what Claude
 * Code or Codex records shows up by itself (the main process reads only the
 * files that changed). Every read also moves "in 3 hr" and "12 min ago" on.
 */
const REFRESH_MS = 10_000

/** The last usage read for each tool: Settings opens with it at once (nothing below it moves), then reads again. */
const lastRead = new Map<Provider, AccountUsage[]>()

/**
 * Settings → Usage: how much of each account's plan limits is used, as the
 * tool on screen last recorded it. One bar per limit, with the day and time
 * it resets; with several accounts, each under its name.
 */
export function UsageSection(): ReactElement {
  const { t } = useTranslation()
  const provider = useAppState((s) => s.provider) ?? 'claude'
  const accounts = useAppState((s) => s.snapshot?.roots.accounts)
  const scannedAt = useAppState((s) => s.snapshot?.scannedAt)
  const [usage, setUsage] = useState<AccountUsage[] | null>(() => lastRead.get(provider) ?? null)
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    let current = true
    const read = (): void => {
      window.sessionManager.getUsage(provider).then(
        (u) => {
          if (!current) return
          lastRead.set(provider, u)
          setUsage(u)
          setNow(Date.now())
        },
        () => current && setUsage([])
      )
    }
    read()
    // Not while the window is minimized or hidden.
    const timer = window.setInterval(() => document.visibilityState === 'visible' && read(), REFRESH_MS)
    return () => {
      current = false
      window.clearInterval(timer)
    }
  }, [provider, scannedAt])

  if (!accounts || !usage) return <p className="usage-empty usage-pending">{t('settings:roots.pending')}</p>
  return (
    <div className="usage-panel">
      {accounts.map((a) => (
        <AccountBlock key={a.id} account={a} usage={usage.find((u) => u.accountId === a.id)} named={accounts.length > 1} now={now} />
      ))}
    </div>
  )
}

function AccountBlock({ account: a, usage, named, now }: { account: ClaudeAccount; usage?: AccountUsage; named: boolean; now: number }): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  const context = useAppState(toolContext)
  const limits = usage?.limits ?? []
  const recordedAt = usage?.recordedAt
  return (
    <div className="usage-account">
      {(named || !!recordedAt) && (
        <div className="usage-head">
          {named && (
            <span className="usage-name" title={a.email ?? a.label}>
              {a.email ?? a.label}
            </span>
          )}
          {named && a.plan && <span className="usage-plan">{a.plan}</span>}
          {!!recordedAt && (
            <span className="usage-recorded" title={fmt.dateTime(recordedAt)}>
              {t('settings:usage.recorded', { context, time: fmt.relative(recordedAt) })}
            </span>
          )}
        </div>
      )}
      {limits.length ? (
        limits.map((l) => <Meter key={`${l.windowMinutes}-${l.model ?? ''}`} limit={l} now={now} />)
      ) : (
        <p className="usage-empty">{a.apiKey ? t('settings:usage.apiKey') : t('settings:usage.none', { context })}</p>
      )}
    </div>
  )
}

function Meter({ limit: l, now }: { limit: UsageLimit; now: number }): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  const name = windowName(t, l.windowMinutes)
  // The window has started again since it was recorded: what is used of the new one is not known yet.
  const reset = l.resetsAt !== undefined && l.resetsAt <= now
  const percent = reset ? 0 : l.percent
  const date = fmt.weekdayDateTime(l.resetsAt)
  const resetText = l.resetsAt === undefined ? null : reset ? t('settings:usage.reset', { date }) : t('settings:usage.resets', { date, until: fmt.until(l.resetsAt) })
  return (
    <div
      className="usage-meter"
      role="meter"
      aria-label={l.model ? `${name} · ${l.model}` : name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={[reset ? null : t('settings:usage.used', { percent }), resetText].filter(Boolean).join(' · ')}
    >
      <span className="usage-window">
        {name}
        {l.model && <span className="usage-model">{l.model}</span>}
      </span>
      <span className="usage-bar">
        <span className={`usage-fill ${reset ? '' : l.severity}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="usage-percent">{reset ? '—' : `${l.percent}%`}</span>
      {resetText && (
        <span className="usage-reset" title={resetText}>
          {resetText}
        </span>
      )}
    </div>
  )
}

function windowName(t: TFunction, minutes: number): string {
  if (minutes === FIVE_HOURS) return t('settings:usage.window.fiveHours')
  if (minutes === ONE_WEEK) return t('settings:usage.window.week')
  return minutes % 1440 === 0 ? t('settings:usage.window.days', { count: minutes / 1440 }) : t('settings:usage.window.hours', { count: Math.round(minutes / 60) })
}
