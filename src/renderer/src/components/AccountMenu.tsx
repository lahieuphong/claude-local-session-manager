import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { matchesFilter } from '../../../shared/sessionQuery'
import type { ClaudeAccount } from '../../../shared/types'
import { activeAccountId, setAccount, useAppState } from '../stores/appStore'
import { IconCheck, IconChevron, IconUser } from './Icons'

/** Which Claude account is on screen. There is nothing to choose with a single account. */
export function AccountMenu(): ReactElement | null {
  const accounts = useAppState((s) => s.snapshot?.roots.accounts)
  return accounts && accounts.length > 1 ? <AccountDropdown accounts={accounts} /> : null
}

function AccountDropdown({ accounts }: { accounts: ClaudeAccount[] }): ReactElement {
  const { t } = useTranslation()
  const sessions = useAppState((s) => s.snapshot?.sessions)
  const activeId = useAppState(activeAccountId)
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const headingId = useId()
  const noteId = useId()

  const current = accounts.find((a) => a.id === activeId) ?? accounts[0]
  const counts = useMemo(
    () =>
      new Map(
        accounts.map((a) => {
          const mine = (sessions ?? []).filter((s) => s.accountIds.includes(a.id))
          // As counted under "All sessions" once this account is on screen.
          return [a.id, { all: mine.filter((s) => matchesFilter(s, 'all')).length, open: mine.filter((s) => s.live).length }]
        })
      ),
    [accounts, sessions]
  )

  const close = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }
  const pick = (id: string): void => {
    if (id !== activeId) setAccount(id)
    close()
  }

  useEffect(() => {
    if (!open) return
    // Starts on the account on screen, so Enter or Esc changes nothing by accident.
    wrap.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const onMouseDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onMenuKey = (e: KeyboardEvent): void => {
    // Tab leaves the list altogether, moving on from the button like from any other control.
    if (e.key === 'Tab') return close()
    const items = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next: Record<string, number> = { ArrowDown: (at + 1) % items.length, ArrowUp: (at - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }
    if (!(e.key in next)) return
    e.preventDefault()
    items[next[e.key]]?.focus()
  }

  const name = t('common:account.current', { name: current.email ?? current.label })
  return (
    <div
      className="account-menu-wrap"
      ref={wrap}
      // Something else took the focus (Ctrl+K goes to the search box, for one).
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false)
      }}
    >
      <button
        ref={trigger}
        className="account-trigger"
        title={name}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          setOpen(true)
        }}
      >
        <IconUser size={15} className="account-trigger-icon" />
        <span className="account-trigger-name">{current.label}</span>
        <IconChevron size={12} className="account-trigger-chev" />
      </button>
      {open && (
        <div
          className="menu account-menu"
          role="menu"
          id={menuId}
          aria-labelledby={headingId}
          aria-describedby={noteId}
          onKeyDown={onMenuKey}
          // A click on the heading or the note must not lose the place in the list.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="menu-heading" id={headingId}>
            {t('common:nav.accounts')}
          </div>
          <div className="account-list">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} on={a.id === current.id} count={counts.get(a.id)} onPick={() => pick(a.id)} />
            ))}
          </div>
          <div className="menu-note" id={noteId}>
            {t('common:account.note')}
          </div>
        </div>
      )}
    </div>
  )
}

function AccountRow({ account: a, on, count, onPick }: { account: ClaudeAccount; on: boolean; count?: { all: number; open: number }; onPick: () => void }): ReactElement {
  const { t } = useTranslation()
  return (
    <button
      role="menuitemradio"
      aria-checked={on}
      tabIndex={-1}
      className={`account-item ${on ? 'on' : ''}`}
      title={[a.displayName, a.email, a.path].filter(Boolean).join('\n')}
      onClick={onPick}
    >
      <IconUser size={20} className="account-item-icon" />
      <span className="account-item-text">
        <span className="account-item-head">
          <span className="account-item-name">{a.displayName || a.label}</span>
          {a.storeRole && (
            <span className="account-item-tag" title={t(`common:account.roleHint.${a.storeRole}`)}>
              {t(`common:account.role.${a.storeRole}`)}
            </span>
          )}
        </span>
        <span className="account-item-meta">
          {a.email && <span className="account-item-email">{a.email}</span>}
          {a.plan && <span className="account-item-plan">{a.plan}</span>}
          <span className="account-item-count">{t('common:account.sessions', { count: count?.all ?? 0 })}</span>
          {!!count?.open && <span className="account-item-open">{t('common:account.open', { count: count.open })}</span>}
        </span>
      </span>
      {on && <IconCheck size={16} className="account-item-check" />}
    </button>
  )
}
