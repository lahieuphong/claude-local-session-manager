import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevron } from './Icons'

export interface SelectOption<T extends string | number> {
  value: T
  label: string
}

/** For type-to-find: "cu" finds "Cũ nhất trước". */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()

/**
 * A dropdown in the app's own look. The list of a native `<select>` is drawn by
 * Windows (white, with a blue highlight) and cannot be styled, so every dropdown
 * in the app is this one instead; a test fails if a native one comes back.
 *
 * It behaves like a native one: one tab stop that keeps the focus, arrows / Home /
 * End / typing to move, Enter, Space or a click to choose, Esc or leaving to close
 * without changing anything. The list floats above the page (it is never cut off
 * by a scrolling pane), opens upwards when there is no room below, and closes when
 * a scroll moves the dropdown away from it.
 */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  name,
  className = ''
}: {
  value: T
  options: Array<SelectOption<T>>
  onChange: (value: T) => void
  /** What is being chosen (the dropdown shows only the current choice). */
  label: string
  /** Stable name (`data-name`), whatever the language. */
  name: string
  className?: string
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const trigger = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  /** Where the dropdown was when its list was placed. */
  const placedAt = useRef({ top: 0, left: 0 })
  const id = useId()
  const chosen = Math.max(0, options.findIndex((o) => o.value === value))

  const show = (at = chosen): void => {
    setActive(at)
    setOpen(true)
  }
  const choose = (i: number): void => {
    setOpen(false)
    const option = options[i]
    if (option && option.value !== value) onChange(option.value)
  }

  // Under the dropdown, as wide as it at least, kept inside the window.
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const box = trigger.current?.getBoundingClientRect()
      const el = list.current
      if (!box || !el) return
      placedAt.current = { top: box.top, left: box.left }
      const gap = 4
      const margin = 8
      const below = window.innerHeight - box.bottom - gap - margin
      const above = box.top - gap - margin
      el.style.maxHeight = ''
      el.style.minWidth = `${box.width}px`
      const up = el.scrollHeight > below && above > below
      el.style.maxHeight = `${Math.floor(up ? above : below)}px`
      el.style.top = up ? '' : `${box.bottom + gap}px`
      el.style.bottom = up ? `${window.innerHeight - box.top + gap}px` : ''
      el.style.left = `${Math.max(margin, Math.min(box.left, window.innerWidth - margin - el.offsetWidth))}px`
      el.dataset.side = up ? 'top' : 'bottom'
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // Like a native list: a click elsewhere, leaving the window, or a scroll that moves the dropdown closes it.
  // (A scroll that leaves it in place does not: the page may still be settling from bringing it into view.)
  useEffect(() => {
    if (!open) return
    const outside = (e: Event): void => {
      const target = e.target as Node
      if (!trigger.current?.contains(target) && !list.current?.contains(target)) setOpen(false)
    }
    const moved = (e: Event): void => {
      const box = trigger.current?.getBoundingClientRect()
      if (list.current?.contains(e.target as Node) || !box) return
      if (Math.abs(box.top - placedAt.current.top) > 1 || Math.abs(box.left - placedAt.current.left) > 1) setOpen(false)
    }
    const leave = (): void => setOpen(false)
    window.addEventListener('mousedown', outside, true)
    window.addEventListener('scroll', moved, true)
    window.addEventListener('blur', leave)
    return () => {
      window.removeEventListener('mousedown', outside, true)
      window.removeEventListener('scroll', moved, true)
      window.removeEventListener('blur', leave)
    }
  }, [open])

  // The highlighted option stays in view (without scrolling anything else).
  useEffect(() => {
    const box = list.current
    const item = box?.children[active] as HTMLElement | undefined
    if (!box || !item) return
    if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop - 4
    else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight + 4
  }, [open, active])

  const find = (key: string): number => {
    const now = Date.now()
    typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + fold(key), at: now }
    const from = open ? active : chosen
    const order = options.map((_, i) => (from + (typed.current.text.length > 1 ? 0 : 1) + i) % options.length)
    return order.find((i) => fold(options[i].label).startsWith(typed.current.text)) ?? -1
  }

  const onKey = (e: KeyboardEvent): void => {
    const last = options.length - 1
    const typing = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.key === ' ' && Date.now() - typed.current.at > 700)
    if (typing) {
      e.preventDefault()
      const match = find(e.key)
      if (match >= 0) show(match)
      return
    }
    if (!open) {
      const at: Record<string, number> = { ArrowDown: chosen, ArrowUp: chosen, Enter: chosen, ' ': chosen, Home: 0, End: last }
      if (!(e.key in at) || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      show(at[e.key])
      return
    }
    const move: Record<string, number> = { ArrowDown: Math.min(active + 1, last), ArrowUp: Math.max(active - 1, 0), Home: 0, End: last, PageDown: Math.min(active + 5, last), PageUp: Math.max(active - 5, 0) }
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault()
      choose(active)
    } else if (e.key in move) {
      e.preventDefault()
      setActive(move[e.key])
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      choose(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  const optionId = (i: number): string => `${id}-${i}`
  return (
    <>
      <div
        ref={trigger}
        className={`select ${open ? 'open' : ''} ${className}`}
        role="combobox"
        tabIndex={0}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        data-name={name}
        data-value={String(value)}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
        onBlur={() => setOpen(false)}
      >
        {/* Every choice is laid out, only the current one is seen: the width does not jump when it changes. */}
        <span className="select-value">
          {options.map((o, i) => (
            <span key={String(o.value)} className={i === chosen ? 'on' : undefined}>
              {o.label}
            </span>
          ))}
        </span>
        <IconChevron size={12} className="select-chev" />
      </div>
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            className="menu select-menu"
            role="listbox"
            aria-label={label}
            // The focus stays on the dropdown, as with a native one.
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((o, i) => (
              <div
                key={String(o.value)}
                id={optionId(i)}
                role="option"
                aria-selected={i === chosen}
                data-value={String(o.value)}
                className={`select-option ${i === active ? 'active' : ''}`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => choose(i)}
              >
                <span className="select-option-label">{o.label}</span>
                {i === chosen ? <IconCheck size={14} className="select-option-check" /> : <span className="select-option-check" />}
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
