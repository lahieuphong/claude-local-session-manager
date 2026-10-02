import { useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** Matches --dur-modal in global.css. */
const EXIT_MS = 200

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

function reducedMotion(): boolean {
  return document.documentElement.dataset.motion === 'reduced' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Keep content mounted while it animates out. */
export function useExitTransition(open: boolean, ms = EXIT_MS): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    setClosing(true)
    const t = window.setTimeout(
      () => {
        setMounted(false)
        setClosing(false)
      },
      reducedMotion() ? 0 : ms
    )
    return () => window.clearTimeout(t)
  }, [open, ms])
  return { mounted: open || mounted, closing: !open && closing }
}

/** Open modals, topmost last: only the topmost one reacts to Escape / Tab. */
const stack: symbol[] = []

function setAppInert(inert: boolean): void {
  const root = document.getElementById('root')
  if (!root) return
  if (inert) root.setAttribute('inert', '')
  else root.removeAttribute('inert')
}

export interface ModalProps {
  open: boolean
  onClose(): void
  /** While true, Escape and the backdrop do nothing (an operation is running). */
  locked?: boolean
  labelledBy: string
  describedBy?: string
  size?: 'narrow' | 'wide'
  tone?: 'danger' | 'neutral'
  initialFocus?: RefObject<HTMLElement | null>
  children: ReactNode
}

/**
 * Accessible dialog: rendered outside the app root (which becomes inert),
 * traps Tab, closes on Escape, returns focus to the opener, and animates
 * opacity + a small vertical offset (reduced-motion aware).
 */
export function Modal({ open, onClose, locked, labelledBy, describedBy, size, tone, initialFocus, children }: ModalProps): ReactElement | null {
  const { mounted, closing } = useExitTransition(open)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const lockedRef = useRef(locked)
  closeRef.current = onClose
  lockedRef.current = locked

  useEffect(() => {
    if (!open) return
    const id = Symbol('modal')
    stack.push(id)
    setAppInert(true)
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const target = initialFocus?.current ?? panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel
      target.focus()
    })

    const onKey = (e: KeyboardEvent): void => {
      if (stack[stack.length - 1] !== id) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!lockedRef.current) closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (items.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey, true)
      const i = stack.indexOf(id)
      if (i >= 0) stack.splice(i, 1)
      if (stack.length === 0) setAppInert(false)
      if (opener?.isConnected) opener.focus()
    }
  }, [open, initialFocus])

  if (!mounted) return null
  return createPortal(
    <div
      className={`modal-backdrop ${closing ? 'closing' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={`modal ${size ?? ''} ${tone === 'danger' ? 'tone-danger' : ''} ${closing ? 'closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
