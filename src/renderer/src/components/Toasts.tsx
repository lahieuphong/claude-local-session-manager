import type { ReactElement } from 'react'
import { dismissToast, useAppState } from '../stores/appStore'
import { IconAlert, IconCheck, IconInfo, IconX } from './Icons'

export function Toasts(): ReactElement {
  const toasts = useAppState((s) => s.toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === 'success' ? <IconCheck size={15} /> : t.kind === 'info' ? <IconInfo size={15} /> : <IconAlert size={15} />}
          <span className="toast-text">{t.message}</span>
          <button className="icon-btn tiny" onClick={() => dismissToast(t.id)} title="Dismiss">
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
