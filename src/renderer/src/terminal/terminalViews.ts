import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { FLOW } from '../../../shared/terminal'
import i18n from '../i18n'

/**
 * One xterm.js view per terminal. They live outside React: switching tabs,
 * hiding the panel or going back to the choice of tool must not lose what a
 * shell has printed. React only gives them their place (mountHost).
 */
export interface TerminalView {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  /** Output drawn since the last report to the main process (flow control). */
  drawn: number
}

const api = (): Window['terminal'] => window.terminal

/** The app's dark surfaces, with ANSI colours tuned to them (the semantic colours of global.css). */
const THEME: ITheme = {
  background: '#0e0f0f',
  foreground: '#dcdcdc',
  cursor: '#d97757',
  cursorAccent: '#0e0f0f',
  selectionBackground: 'rgba(217, 119, 87, 0.32)',
  selectionInactiveBackground: 'rgba(217, 119, 87, 0.18)',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.10)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.18)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.26)',
  black: '#1c1d1d',
  red: '#f0605d',
  green: '#4cc38a',
  yellow: '#e5a83b',
  blue: '#6aa9ef',
  magenta: '#c58af0',
  cyan: '#4fc4c4',
  white: '#cfcfcf',
  brightBlack: '#6e7171',
  brightRed: '#ff8481',
  brightGreen: '#72dcaa',
  brightYellow: '#f4c56c',
  brightBlue: '#92c2f7',
  brightMagenta: '#dbb2f8',
  brightCyan: '#7fdede',
  brightWhite: '#f5f5f5'
}

const views = new Map<number, TerminalView>()
let host: HTMLElement | null = null
let listening = false
/** The newest terminal with a view; output for a higher ID is for one still opening. */
let lastAttached = 0
/** Output that arrived before its view was attached. */
const early = new Map<number, string>()

/** Where the views are shown; null while the panel is not on screen. */
export function mountHost(el: HTMLElement | null): void {
  host = el
  if (el) for (const v of views.values()) el.append(v.el)
}

/** A new view, already on screen and sized, for a terminal about to be opened. */
export function createView(windowsBuild: number): TerminalView {
  const el = document.createElement('div')
  el.className = 'terminal-view'
  host?.append(el)
  const term = new Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'outline',
    scrollback: 5000,
    // Dim text stays readable on the dark background, as in VS Code.
    minimumContrastRatio: 4.5,
    windowsPty: { backend: 'conpty', buildNumber: windowsBuild },
    theme: THEME
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const openLink = (event: MouseEvent, uri: string): void => {
    // Ctrl+click, as in VS Code: a plain click only places the selection.
    if (event.ctrlKey || event.metaKey) void api().openLink(uri).catch(() => {})
  }
  term.loadAddon(
    new WebLinksAddon(openLink, {
      hover: () => (el.title = i18n.t('terminal:link.hint')),
      leave: () => el.removeAttribute('title')
    })
  )
  term.open(el)
  const view: TerminalView = { term, fit, el, drawn: 0 }
  showOnly(null)
  show(view)
  return view
}

/** Connects a view to its shell. */
export function attach(view: TerminalView, id: number): void {
  views.set(id, view)
  lastAttached = Math.max(lastAttached, id)
  view.el.dataset.terminal = String(id)
  view.term.onData((data) => api().input(id, data))
  view.term.onResize(({ cols, rows }) => api().resize(id, cols, rows))
  view.term.attachCustomKeyEventHandler((e) => handleKey(view, e))
  view.el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    void copyOrPaste(view)
  })
  const pending = early.get(id)
  early.delete(id)
  if (pending) draw(view, id, pending)
}

/** Output from the shells, from the first terminal on. */
export function listenForOutput(): void {
  if (listening) return
  listening = true
  api().onOutput((id, data) => {
    const view = views.get(id)
    if (view) draw(view, id, data)
    else if (id > lastAttached) early.set(id, (early.get(id) ?? '') + data)
  })
}

/** The only view on screen; the others stay as they are, out of sight. */
export function showOnly(id: number | null): void {
  for (const [key, v] of views) v.el.classList.toggle('active', key === id)
  const view = id === null ? undefined : views.get(id)
  if (view) show(view)
}

/** Fits the view on screen to its space (after a resize of the panel or the window). */
export function fitActive(): void {
  for (const v of views.values()) if (v.el.classList.contains('active')) fitView(v)
}

export function focusView(id: number): void {
  views.get(id)?.term.focus()
}

/** A line from the app, not the shell, dimmed. */
export function notice(id: number, text: string): void {
  views.get(id)?.term.write(`\r\n\x1b[2m${text}\x1b[22m\r\n`)
}

export function disposeView(id: number): void {
  const view = views.get(id)
  views.delete(id)
  early.delete(id)
  if (view) discardView(view)
}

/** A view whose shell never started, or is gone. */
export function discardView(view: TerminalView): void {
  view.term.dispose()
  view.el.remove()
}

/** Draws output and tells the main process how far the page has got. */
function draw(view: TerminalView, id: number, data: string): void {
  view.term.write(data, () => {
    view.drawn += data.length
    if (view.drawn >= FLOW.ackEvery) {
      api().ack(id, view.drawn)
      view.drawn = 0
    }
  })
}

function show(view: TerminalView): void {
  view.el.classList.add('active')
  fitView(view)
}

function fitView(view: TerminalView): void {
  // Nothing to measure while the panel is hidden: it is fitted when shown.
  if (!view.el.isConnected || view.el.clientWidth === 0) return
  try {
    view.fit.fit()
  } catch {
    // Not rendered yet.
  }
}

/**
 * Keys as in VS Code on Windows: Ctrl+C copies a selection (else it stops the
 * running program), Ctrl+Shift+C copies, Ctrl+V and Ctrl+Shift+V paste.
 */
function handleKey(view: TerminalView, e: KeyboardEvent): boolean {
  if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true
  const key = e.key.toLowerCase()
  if (key === 'c' && (e.shiftKey || view.term.hasSelection())) {
    e.preventDefault()
    void copySelection(view)
    return false
  }
  // The browser pastes into the terminal itself (with bracketed paste when the shell asks for it).
  if (key === 'v') return false
  return true
}

async function copySelection(view: TerminalView): Promise<void> {
  const text = view.term.getSelection()
  if (!text) return
  await navigator.clipboard.writeText(text).catch(() => {})
  view.term.clearSelection()
}

/** Right-click: copies the selection, else pastes. */
async function copyOrPaste(view: TerminalView): Promise<void> {
  if (view.term.hasSelection()) return copySelection(view)
  const text = await api().clipboardText().catch(() => '')
  if (text) view.term.paste(text)
  view.term.focus()
}
