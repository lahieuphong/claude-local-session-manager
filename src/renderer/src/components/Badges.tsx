import type { ReactElement } from 'react'
import type { ClaudeSession, LiveState, SessionStatus } from '../../../shared/types'

const STATUS_LABEL: Record<SessionStatus, string> = {
  active: 'Active',
  archived: 'Archived',
  'transcript-only': 'Transcript only',
  'metadata-only': 'Metadata only',
  orphan: 'Orphan'
}

const LIVE_LABEL: Record<LiveState, string> = {
  running: 'Running',
  idle: 'Idle',
  'in-use': 'In use'
}

const LIVE_HINT: Record<LiveState, string> = {
  running: 'A Claude Code process is working in this session right now',
  idle: 'Open (idle) in a running Claude Code process',
  'in-use': 'Attached to a running Claude Code process'
}

export function StatusBadge({ status }: { status: SessionStatus }): ReactElement {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
}

export function LiveBadge({ session }: { session: ClaudeSession }): ReactElement | null {
  if (!session.live) return null
  const state = session.live.state
  return (
    <span className={`badge badge-live live-${state}`} title={`${LIVE_HINT[state]} (PID ${session.live.pid}). Deletion is blocked.`}>
      <span className="live-dot" /> {LIVE_LABEL[state]}
    </span>
  )
}

export function SessionBadges({ session, compact }: { session: ClaudeSession; compact?: boolean }): ReactElement {
  return (
    <span className="badges">
      <StatusBadge status={session.status} />
      {session.hiddenInManager && (
        <span className="badge badge-hidden" title="Hidden in this manager only; Claude's own state is unchanged">
          Hidden
        </span>
      )}
      <LiveBadge session={session} />
      {!compact && session.problems.length > 0 && session.status !== 'orphan' && (
        <span className="badge badge-problem">{session.problems.length} issue{session.problems.length > 1 ? 's' : ''}</span>
      )}
    </span>
  )
}

export { STATUS_LABEL, LIVE_LABEL }
