import { useSyncExternalStore } from 'react'
import type { ShellId, TerminalSupport } from '../../../shared/terminal'
import i18n from '../i18n'
import { errText, getState as getAppState, toast } from './appStore'

export interface TerminalTab {
  id: number
  shell: ShellId
  /** The folder it started in. */
  cwd: string
  /** Set when the shell ended with an error: the tab stays, to show why. */
  exitCode?: number
}

export interface TerminalState {
  /** null until the main process has answered. */
  support: TerminalSupport | null
  /** The panel is on screen. Its terminals keep running while it is hidden. */
  open: boolean
  maximized: boolean
  /** In px, kept between runs. */
  height: number
  tabs: TerminalTab[]
  activeId: number | null
  /** What "+" opens: the shell chosen last, else the first one found. */
  shell: ShellId | null
  starting: boolean
}

export const PANEL_HEIGHT = { min: 140, default: 260, step: 24 } as const
const HEIGHT_KEY = 'terminal:height'
const SHELL_KEY = 'terminal:shell'
const UNAVAILABLE: TerminalSupport = { available: false, shells: [] }

function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* a convenience only */
  }
}

let state: TerminalState = {
  support: null,
  open: false,
  maximized: false,
  height: Math.max(PANEL_HEIGHT.min, Number(load(HEIGHT_KEY)) || PANEL_HEIGHT.default),
  tabs: [],
  activeId: null,
  shell: null,
  starting: false
}
const listeners = new Set<() => void>()

function set(patch: Partial<TerminalState> | ((s: TerminalState) => Partial<TerminalState>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTerminal<T>(selector: (s: TerminalState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

/** Once the page has drawn: the panel is on screen and can be measured. */
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

// xterm.js comes with the first terminal: the app starts without it, and the
// Microsoft Store edition never loads it. Every tab has a view, so once there
// is a tab, `views` is there.
type Views = typeof import('../terminal/terminalViews')
let views: Views | null = null
let viewsLoading: Promise<Views> | null = null
let host: HTMLElement | null = null

function loadViews(): Promise<Views> {
  viewsLoading ??= import('../terminal/terminalViews').then((m) => {
    views = m
    m.listenForOutput()
    m.mountHost(host)
    return m
  })
  return viewsLoading
}

/** Where the terminals are shown: the panel's body, or null while it is not on screen. */
export function setTerminalHost(el: HTMLElement | null): void {
  host = el
  views?.mountHost(el)
}

/** After the panel or the window changed size. */
export function fitTerminal(): void {
  views?.fitActive()
}

/** What this build offers, and Ctrl+` from anywhere in the app. */
export async function initTerminal(): Promise<void> {
  const support = await window.terminal.info().catch(() => UNAVAILABLE)
  const saved = load(SHELL_KEY) as ShellId | null
  set({ support, shell: support.available ? (saved && support.shells.includes(saved) ? saved : support.shells[0]) : null })
  if (!support.available) return
  window.terminal.onExit(onExit)
  // Capture: the terminal must not take the key for itself.
  window.addEventListener('keydown', onShortcut, true)
}

/** Ctrl+` shows or hides the panel, Ctrl+Shift+` opens a new terminal (VS Code's keys). */
function onShortcut(e: KeyboardEvent): void {
  if (e.code !== 'Backquote' || !e.ctrlKey || e.altKey || e.metaKey) return
  // Not on the choice of tool, and not under a dialog.
  if (!getAppState().provider || document.getElementById('root')?.hasAttribute('inert')) return
  e.preventDefault()
  e.stopPropagation()
  if (e.shiftKey) void newTerminal()
  else toggleTerminal()
}

export function toggleTerminal(): void {
  if (state.open) hideTerminal()
  else void showTerminal()
}

export async function showTerminal(): Promise<void> {
  if (!state.support?.available) return
  if (!state.tabs.length) return newTerminal()
  set({ open: true })
  await nextFrame()
  views?.showOnly(state.activeId)
  if (state.activeId !== null) views?.focusView(state.activeId)
}

export function hideTerminal(): void {
  const hadFocus = !!document.activeElement?.closest('.terminal-panel')
  set({ open: false })
  // Back to the button that brings it back, rather than nowhere.
  if (hadFocus) document.querySelector<HTMLElement>('.terminal-toggle')?.focus()
}

export interface NewTerminalOptions {
  /** The shell chosen last when absent. */
  shell?: ShellId
  /** Its project folder is where the terminal starts; the session on screen when absent. */
  sessionId?: string
  /** Type in the command that takes that session up again. */
  resume?: boolean
}

/** A new terminal in the project folder of the session on screen (else the home folder), as VS Code opens one in the workspace. */
export async function newTerminal({ shell = state.shell ?? undefined, sessionId = getAppState().selectedId ?? undefined, resume }: NewTerminalOptions = {}): Promise<void> {
  const support = state.support
  if (!support?.available || state.starting) return
  set({ starting: true, open: true })
  let view: ReturnType<Views['createView']> | null = null
  try {
    const [v] = await Promise.all([loadViews(), nextFrame()])
    view = v.createView(support.windowsBuild)
    const info = await window.terminal.open({ shell, sessionId, resume, cols: view.term.cols, rows: view.term.rows })
    // Straight away: the shell's first output is already on its way.
    v.attach(view, info.id)
    set((s) => ({ tabs: [...s.tabs, { id: info.id, shell: info.shell, cwd: info.cwd }], activeId: info.id, shell: info.shell }))
    save(SHELL_KEY, info.shell)
    v.showOnly(info.id)
    v.focusView(info.id)
  } catch (err) {
    if (view) views?.discardView(view)
    views?.showOnly(state.activeId)
    if (!state.tabs.length) set({ open: false })
    toast('error', { key: 'terminal:startFailed', params: { error: errText(err) } })
  } finally {
    set({ starting: false })
  }
}

/** A new terminal in the session's project folder, with `claude --resume <id>` (or Codex's) typed in. */
export function resumeInTerminal(sessionId: string): Promise<void> {
  return newTerminal({ sessionId, resume: true })
}

export function selectTerminal(id: number): void {
  set({ activeId: id })
  views?.showOnly(id)
  views?.focusView(id)
}

/** Ends the shell and closes its tab; the panel closes with the last one. */
export function closeTerminal(id: number): void {
  void window.terminal.close(id).catch(() => {})
  views?.disposeView(id)
  const index = state.tabs.findIndex((t) => t.id === id)
  const tabs = state.tabs.filter((t) => t.id !== id)
  const activeId = state.activeId !== id ? state.activeId : (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
  if (!tabs.length) hideTerminal()
  set({ tabs, activeId })
  views?.showOnly(activeId)
  if (activeId !== null && state.open) views?.focusView(activeId)
}

/** A shell that ends normally (`exit`) closes its tab, as in VS Code; one that fails stays open to show why. */
function onExit(id: number, exitCode: number): void {
  if (!state.tabs.some((t) => t.id === id)) return
  if (exitCode === 0) return closeTerminal(id)
  views?.notice(id, i18n.t('terminal:exited', { code: exitCode }))
  set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, exitCode } : t)) }))
}

export function setPanelHeight(height: number): void {
  set({ height: Math.max(PANEL_HEIGHT.min, Math.round(height)) })
}

export function savePanelHeight(): void {
  save(HEIGHT_KEY, String(state.height))
}

export function toggleMaximized(): void {
  set((s) => ({ maximized: !s.maximized }))
}

/** VS Code's key, shown next to the Terminal item (keys are never translated). */
export const TERMINAL_SHORTCUT = 'Ctrl+`'

/** For a short name on a tab: the program, as VS Code shows it. */
export const SHELL_COMMAND: Record<ShellId, string> = { pwsh: 'pwsh', powershell: 'powershell', cmd: 'cmd', gitbash: 'bash' }
