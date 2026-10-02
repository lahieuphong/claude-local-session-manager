import type { ReactElement, ReactNode } from 'react'

/** Compact empty / error state: small icon, one-line title, optional hint and action. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  tone
}: {
  icon?: ReactNode
  title: string
  hint?: ReactNode
  action?: ReactNode
  tone?: 'error'
}): ReactElement {
  return (
    <div className={`empty-state ${tone === 'error' ? 'error' : ''}`} role={tone === 'error' ? 'alert' : undefined}>
      {icon && <span className="empty-icon">{icon}</span>}
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

/** Restrained loading placeholder rows (static when motion is reduced). */
export function SkeletonRows({ count = 8 }: { count?: number }): ReactElement {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="sk sk-check" />
          <span className="sk-lines">
            <span className="sk sk-title" style={{ width: `${48 + ((i * 17) % 38)}%` }} />
            <span className="sk sk-meta" style={{ width: `${22 + ((i * 11) % 20)}%` }} />
          </span>
          <span className="sk sk-cell" />
          <span className="sk sk-cell short" />
        </div>
      ))}
    </div>
  )
}
