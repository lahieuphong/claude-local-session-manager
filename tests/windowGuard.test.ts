import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { guardWindow, SHOW_FALLBACK_MS, type GuardedWindow, type WindowProblem } from '../src/main/windowGuard'

/** Fake BrowserWindow: hidden until show(), with webContents events and a manual timer. */
function fakeWindow() {
  const events = new EventEmitter()
  const contents = new EventEmitter()
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  let visible = false
  let destroyed = false
  let shows = 0
  const win: GuardedWindow = {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    show: () => {
      visible = true
      shows++
    },
    once: (event, listener) => events.once(event, listener),
    on: (event, listener) => events.on(event, listener),
    webContents: { on: (event: string, listener: (...args: never[]) => void) => contents.on(event, listener as (...args: unknown[]) => void) }
  }
  const problems: WindowProblem[] = []
  const logs: string[] = []
  guardWindow(win, {
    onProblem: (p) => problems.push(p),
    log: { warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    }
  })
  return {
    events,
    contents,
    timers,
    problems,
    logs,
    get shows() {
      return shows
    },
    get visible() {
      return visible
    },
    destroy: () => {
      destroyed = true
    },
    fire: () => timers.forEach((t) => !t.cleared && t.fn())
  }
}

describe('the main window never stays hidden', () => {
  it('shows on ready-to-show, and the fallback then does nothing', () => {
    const w = fakeWindow()
    expect(w.visible).toBe(false)
    w.events.emit('ready-to-show')
    expect(w.visible).toBe(true)
    w.fire()
    expect(w.shows).toBe(1)
    expect(w.logs).toEqual([])
  })

  it('shows the window after the fallback delay when the page never gets ready', () => {
    const w = fakeWindow()
    expect(w.timers[0].ms).toBe(SHOW_FALLBACK_MS)
    w.fire()
    expect(w.visible).toBe(true)
    expect(w.logs[0]).toMatch(/not ready after 5000 ms/)
    expect(w.problems).toEqual([])
  })

  it('shows the window and reports a failed page load', () => {
    const w = fakeWindow()
    w.contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x/index.html', true)
    expect(w.visible).toBe(true)
    expect(w.problems).toEqual([{ kind: 'load-failed', code: -6, description: 'ERR_FILE_NOT_FOUND', url: 'file:///x/index.html' }])
  })

  it('ignores sub-frame failures and aborted navigations', () => {
    const w = fakeWindow()
    w.contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x/frame.html', false)
    w.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///x/index.html', true)
    expect(w.visible).toBe(false)
    expect(w.problems).toEqual([])
  })

  it('shows the window and reports a crashed renderer, but not a clean exit', () => {
    const w = fakeWindow()
    w.contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    expect(w.problems).toEqual([])
    w.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(w.visible).toBe(true)
    expect(w.problems).toEqual([{ kind: 'renderer-gone', reason: 'crashed', exitCode: 1 }])
  })

  it('clears the fallback when the window closes and never touches a destroyed window', () => {
    const w = fakeWindow()
    w.events.emit('closed')
    expect(w.timers[0].cleared).toBe(true)
    const v = fakeWindow()
    v.destroy()
    v.fire()
    v.events.emit('ready-to-show')
    expect(v.shows).toBe(0)
  })
})
