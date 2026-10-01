import type { ReactElement } from 'react'
import type { ClaudeSession, SessionStatus } from '../../../shared/types'

const STATUS_LABEL: Record<SessionStatus, string> = {
  active: 'Active',
  archived: 'Archived',
  'transcript-only': 'Transcript only',
  'metadata-only': 'Metadata only',
  orphan: 'Orphan'
}

export function StatusBadge({ status }: { status: SessionStatus }): ReactElement {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
}

export function SessionBadges({ session, compact }: { session: ClaudeSession; compact?: boolean }): ReactElement {
  return (
    <span className="badges">
      <StatusBadge status={session.status} />
      {session.archived && session.status !== 'archived' && (
        <span className="badge badge-archived" title="Archived in this app only">
          Archived{compact ? '' : ' (app)'}
        </span>
      )}
      {session.live && (
        <span className="badge badge-live" title={`Open in Claude Code (PID ${session.live.pid})`}>
          <span className="live-dot" /> In use
        </span>
      )}
      {!compact && session.problems.length > 0 && session.status !== 'orphan' && (
        <span className="badge badge-problem">{session.problems.length} issue{session.problems.length > 1 ? 's' : ''}</span>
      )}
    </span>
  )
}

export { STATUS_LABEL }
