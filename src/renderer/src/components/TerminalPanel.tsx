import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ShellId } from '../../../shared/terminal'
import { useAppState } from '../stores/appStore'
import {
  PANEL_HEIGHT,
  SHELL_COMMAND,
  closeTerminal,
  fitTerminal,
  hideTerminal,
  refreshTerminalTheme,
  newTerminal,
  savePanelHeight,
  selectTerminal,
  setPanelHeight,
  setTerminalHost,
  toggleMaximized,
  useTerminal,
  type TerminalTab
} from '../stores/terminalStore'
import { IconCheck, IconChevron, IconMinus, IconPlus, IconTerminal, IconX } from './Icons'

/** The panel always leaves this much of the main area above it (the max-height of .terminal-panel in global.css). */
const KEEP_ABOVE = 220

/**
 * The integrated terminal, at the bottom of the window as in VS Code: one tab
 * per shell, Ctrl+` to show or hide it. Its terminals keep running while it
 * is hidden. Not in the Microsoft Store edition.
 */
export function TerminalPanel(): ReactElement | null {
  const { t } = useTranslation()
  const available = useTerminal((s) => s.support?.available ?? false)
  const open = useTerminal((s) => s.open)
  const maximized = useTerminal((s) => s.maximized)
  const height = useTerminal((s) => s.height)
  const tabs = useTerminal((s) => s.tabs)
  const activeId = useTerminal((s) => s.activeId)
  const provider = useAppState((s) => s.provider)
  const bodyId = useId()

  // The cursor and selection follow the accent: Claude orange, Codex blue.
  useEffect(refreshTerminalTheme, [provider])

  // The views are xterm.js elements outside React (terminal/terminalViews.ts): this is their place.
  const attachBody = useCallback((el: HTMLDivElement) => {
    setTerminalHost(el)
    const observer = new ResizeObserver(() => requestAnimationFrame(fitTerminal))
    observer.observe(el)
    return () => {
      observer.disconnect()
      setTerminalHost(null)
    }
  }, [])

  if (!available) return null
  const onTabsKey = (e: KeyboardEvent): void => {
    const i = tabs.findIndex((tab) => tab.id === activeId)
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
    if (next === null || !tabs.length) return
    e.preventDefault()
    const tab = tabs[(next + tabs.length) % tabs.length]
    selectTerminal(tab.id)
    document.getElementById(tabElementId(tab.id))?.focus()
  }

  return (
    <section className={`terminal-panel ${maximized ? 'maximized' : ''}`} hidden={!open} style={maximized ? undefined : { height }} aria-label={t('terminal:title')}>
      {!maximized && <PanelResizer height={height} />}
      <header className="terminal-head">
        <span className="terminal-title">{t('terminal:title')}</span>
        <div className="terminal-tabs" role="tablist" aria-label={t('terminal:tabs')} onKeyDown={onTabsKey}>
          {tabs.map((tab) => (
            <TerminalTabItem key={tab.id} tab={tab} active={tab.id === activeId} panelId={bodyId} />
          ))}
        </div>
        <div className="terminal-actions">
          <NewTerminalButtons />
          <button
            className="icon-btn"
            onClick={toggleMaximized}
            aria-pressed={maximized}
            title={t(maximized ? 'terminal:restore' : 'terminal:maximize')}
            aria-label={t(maximized ? 'terminal:restore' : 'terminal:maximize')}
          >
            <IconChevron size={14} className={`terminal-max-icon ${maximized ? 'down' : 'up'}`} />
          </button>
          <button className="icon-btn" onClick={hideTerminal} title={t('terminal:hide')} aria-label={t('terminal:hide')}>
            <IconMinus size={14} />
          </button>
        </div>
      </header>
      <div className="terminal-body" id={bodyId} role="tabpanel" aria-labelledby={activeId !== null ? tabElementId(activeId) : undefined} ref={attachBody} />
    </section>
  )
}

const tabElementId = (id: number): string => `terminal-tab-${id}`

/** The folder a terminal started in, short: "~" for the home folder. */
function folderLabel(cwd: string, home: string | undefined): string {
  if (home && cwd.toLowerCase() === home.toLowerCase()) return '~'
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
}

function TerminalTabItem({ tab, active, panelId }: { tab: TerminalTab; active: boolean; panelId: string }): ReactElement {
  const { t } = useTranslation()
  const home = useAppState((s) => s.appInfo?.userHome)
  const name = SHELL_COMMAND[tab.shell]
  const exited = tab.exitCode !== undefined
  const title = [t(`terminal:shell.${tab.shell}`), tab.cwd, exited ? t('terminal:exited', { code: tab.exitCode }) : ''].filter(Boolean).join('\n')
  return (
    <div className={`terminal-tab ${active ? 'on' : ''} ${exited ? 'exited' : ''}`}>
      <button
        role="tab"
        id={tabElementId(tab.id)}
        className="terminal-tab-main"
        aria-selected={active}
        aria-controls={panelId}
        tabIndex={active ? 0 : -1}
        title={title}
        onClick={() => selectTerminal(tab.id)}
      >
        <IconTerminal size={13} />
        <span className="terminal-tab-name">{name}</span>
        <span className="terminal-tab-folder">{folderLabel(tab.cwd, home)}</span>
      </button>
      <button className="terminal-tab-close" onClick={() => closeTerminal(tab.id)} title={t('terminal:close', { name })} aria-label={t('terminal:close', { name })}>
        <IconX size={11} />
      </button>
    </div>
  )
}

/** "+" opens the shell chosen last; the arrow next to it lists every shell found on this PC. */
function NewTerminalButtons(): ReactElement {
  const { t } = useTranslation()
  const shells = useTerminal((s) => (s.support?.available ? s.support.shells : []))
  const current = useTerminal((s) => s.shell)
  const starting = useTerminal((s) => s.starting)
  const [menu, setMenu] = useState<'down' | 'up' | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const newLabel = current ? t('terminal:new', { shell: t(`terminal:shell.${current}`) }) : ''

  useEffect(() => {
    if (!menu) return
    wrap.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(null)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setMenu(null)
      trigger.current?.focus()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const toggleMenu = (): void => {
    if (menu) return setMenu(null)
    // Opens upward when the panel is too low for it to fit below.
    const box = trigger.current?.getBoundingClientRect()
    setMenu(box && window.innerHeight - box.bottom < 60 + shells.length * 34 ? 'up' : 'down')
  }
  const pick = (shell: ShellId): void => {
    setMenu(null)
    void newTerminal({ shell })
  }
  const onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === 'Tab') return setMenu(null)
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }

  return (
    <div className="terminal-new" ref={wrap}>
      <button className="icon-btn" onClick={() => void newTerminal()} disabled={starting} title={newLabel} aria-label={newLabel}>
        <IconPlus size={15} />
      </button>
      <button
        ref={trigger}
        className="icon-btn terminal-shell-trigger"
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-controls={menu ? menuId : undefined}
        title={t('terminal:chooseShell')}
        aria-label={t('terminal:chooseShell')}
      >
        <IconChevron size={11} className="terminal-shell-chev" />
      </button>
      {menu && (
        <div className={`menu terminal-shell-menu ${menu}`} role="menu" id={menuId} aria-label={t('terminal:chooseShell')} onKeyDown={onMenuKey}>
          <div className="menu-heading">{t('terminal:shellsHeading')}</div>
          {shells.map((shell) => (
            <button key={shell} role="menuitemradio" aria-checked={shell === current} className="terminal-shell-item" onClick={() => pick(shell)}>
              <IconTerminal size={14} />
              <span className="terminal-shell-name">{t(`terminal:shell.${shell}`)}</span>
              {shell === current && <IconCheck size={14} className="terminal-shell-check" />}
            </button>
          ))}
          <div className="menu-note">{t('terminal:shellNote')}</div>
        </div>
      )}
    </div>
  )
}

/** The top edge: drag it, or use the arrow keys on it, to change the panel's height. */
function PanelResizer({ height }: { height: number }): ReactElement {
  const { t } = useTranslation()
  const maxFor = (el: Element): number => Math.max(PANEL_HEIGHT.min, (el.closest('.main')?.clientHeight ?? 0) - KEEP_ABOVE)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const bottom = handle.closest('.main')?.getBoundingClientRect().bottom ?? window.innerHeight
    const max = maxFor(handle)
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('dragging')
    const move = (ev: PointerEvent): void => setPanelHeight(Math.min(max, bottom - ev.clientY))
    const end = (): void => {
      handle.classList.remove('dragging')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      savePanelHeight()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const max = maxFor(e.currentTarget)
    const next =
      e.key === 'ArrowUp' ? height + PANEL_HEIGHT.step : e.key === 'ArrowDown' ? height - PANEL_HEIGHT.step : e.key === 'Home' ? PANEL_HEIGHT.min : e.key === 'End' ? max : null
    if (next === null) return
    e.preventDefault()
    setPanelHeight(Math.min(max, next))
    savePanelHeight()
  }

  return (
    <div
      className="terminal-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('terminal:resize')}
      aria-valuemin={PANEL_HEIGHT.min}
      aria-valuenow={height}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={toggleMaximized}
    />
  )
}
