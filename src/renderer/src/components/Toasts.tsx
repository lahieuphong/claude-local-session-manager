import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../i18n'
import { dismissToast, useAppState, type ToastPart } from '../stores/appStore'
import { IconAlert, IconCheck, IconInfo, IconX } from './Icons'
import { localTitle } from '../utils/titles'

/** Outside the app root so they stay readable and dismissable while a dialog makes the app inert. */
export function Toasts(): ReactElement {
  const { t } = useTranslation()
  const fmt = useFmt()
  const toasts = useAppState((s) => s.toasts)
  const text = (p: ToastPart): string => {
    if (!('key' in p)) return fmt.msg(p.msg, p.text)
    const params = p.params && typeof p.params.title === 'string' ? { ...p.params, title: localTitle(t, p.params.title) } : p.params
    return t(p.key, params)
  }
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind} ${toast.leaving ? 'leaving' : ''}`} role={toast.kind === 'error' ? 'alert' : undefined}>
          <span className="toast-icon">
            {toast.kind === 'success' ? <IconCheck size={16} /> : toast.kind === 'info' ? <IconInfo size={16} /> : <IconAlert size={16} />}
          </span>
          <span className="toast-text">{toast.parts.map(text).filter(Boolean).join(' ')}</span>
          <button className="icon-btn" onClick={() => dismissToast(toast.id)} title={t('common:action.dismiss')} aria-label={t('common:action.dismiss')}>
            <IconX size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
