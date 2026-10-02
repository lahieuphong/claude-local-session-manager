import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClaudeSession, SessionStatus } from '../../../shared/types'

/** Compact status badge. `quiet` hides the default "Active" state in dense lists. */
export function StatusBadge({ status, quiet }: { status: SessionStatus; quiet?: boolean }): ReactElement | null {
  const { t } = useTranslation()
  if (quiet && status === 'active') return null
  return <span className={`badge badge-${status}`}>{t(`sessions:status.${status}`)}</span>
}

export function LiveBadge({ session }: { session: ClaudeSession }): ReactElement | null {
  const { t } = useTranslation()
  if (!session.live) return null
  const state = session.live.state
  return (
    <span className={`badge badge-live live-${state}`} title={t(`sessions:live.hint.${state}`, { pid: session.live.pid })}>
      <span className="live-dot" aria-hidden="true" />
      {t(`sessions:live.state.${state}`)}
    </span>
  )
}

export function SessionBadges({ session, compact }: { session: ClaudeSession; compact?: boolean }): ReactElement {
  const { t } = useTranslation()
  const issues = session.status !== 'orphan' ? session.problems.length : 0
  return (
    <span className="badges">
      <StatusBadge status={session.status} quiet={compact} />
      {session.hiddenInManager && (
        <span className="badge badge-hidden" title={t('sessions:badge.hiddenHint')}>
          {t('sessions:badge.hidden')}
        </span>
      )}
      <LiveBadge session={session} />
      {issues > 0 && (
        <span className="badge badge-problem" title={t('sessions:badge.issuesHint')}>
          {t('sessions:badge.issues', { count: issues })}
        </span>
      )}
    </span>
  )
}
