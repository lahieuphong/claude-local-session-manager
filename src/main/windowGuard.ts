/**
 * Makes sure the main window can never stay invisible.
 *
 * The window is created hidden and normally shown on 'ready-to-show'. If the
 * page never gets there (missing files after an interrupted Portable
 * extraction, a renderer crash, a GPU stall), the process used to keep
 * running with a hidden window: nothing on screen, nothing to close, and the
 * single-instance lock blocking every new launch. These guards show the
 * window anyway and report why.
 */

/** The part of BrowserWindow this module uses (injectable for tests). */
export interface GuardedWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  show(): void
  once(event: 'ready-to-show', listener: () => void): unknown
  on(event: 'closed', listener: () => void): unknown
  webContents: {
    on(
      event: 'did-fail-load',
      listener: (event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => void
    ): unknown
    on(event: 'render-process-gone', listener: (event: unknown, details: { reason: string; exitCode: number }) => void): unknown
  }
}

export type WindowProblem =
  | { kind: 'load-failed'; code: number; description: string; url: string }
  | { kind: 'renderer-gone'; reason: string; exitCode: number }

export interface WindowGuardOptions {
  /** Show the window after this long even without 'ready-to-show'. */
  fallbackMs?: number
  /** Called once per problem, after the window has been made visible. */
  onProblem(problem: WindowProblem): void
  log?: { warn(message: string): void; error(message: string): void }
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export const SHOW_FALLBACK_MS = 5000

/** -3 = ERR_ABORTED: a navigation replaced by another one (not a failure). */
const ERR_ABORTED = -3

export function guardWindow(win: GuardedWindow, opts: WindowGuardOptions): void {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))
  const reveal = (): void => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }

  win.once('ready-to-show', reveal)

  const timer = setTimer(() => {
    if (win.isDestroyed() || win.isVisible()) return
    opts.log?.warn(`Window was not ready after ${opts.fallbackMs ?? SHOW_FALLBACK_MS} ms; showing it anyway`)
    reveal()
  }, opts.fallbackMs ?? SHOW_FALLBACK_MS)
  win.on('closed', () => clearTimer(timer))

  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === ERR_ABORTED) return
    opts.log?.error(`Window failed to load ${url}: ${description} (${code})`)
    reveal()
    opts.onProblem({ kind: 'load-failed', code, description, url })
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    opts.log?.error(`Renderer process gone: ${details.reason} (exit code ${details.exitCode})`)
    reveal()
    opts.onProblem({ kind: 'renderer-gone', reason: details.reason, exitCode: details.exitCode })
  })
}
