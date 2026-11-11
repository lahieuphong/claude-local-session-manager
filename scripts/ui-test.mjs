// Full UI test: drives the real app, on screen, against a throw-away profile.
//
//   yarn test:ui                     build, then test the development and Store variants
//   node scripts/ui-test.mjs --exe "<path to the packaged app's .exe>"     test a packaged build
//   Options: --channel development|store   only that variant
//            --quick                       one language and one window size for the layout pass
//            --locale vi --size 984x581    only those (both can be repeated)
//            --port 9333                   fixed DevTools port (needed for the Portable launcher)
//            --keep                        keep the throw-away profile afterwards
//            --shots                       a screenshot of every screen in every language and size
//
// Three passes:
//   1. Self-check: known defects are injected to prove the audit still notices them.
//   2. Layout: every screen, in every language, at every window size, is checked by
//      scripts/ui-test-audit.mjs for what a person would call broken.
//   3. Behaviour: real mouse clicks and key presses through every feature, including
//      real archive, hide and delete on the throw-away profile.
//
// SAFETY. The user folders are redirected to .ui-test/ and filled by
// scripts/ui-test-profile.mjs. Before the first click the test proves the app reads
// only that folder, and stops otherwise. Features with an effect outside the app are
// not clicked: export (native dialog), "open in Explorer", copy (clipboard), the
// Microsoft Store and GitHub links. Updates use the development fake updater (no
// network, nothing is installed), so a packaged build shows only its real update state.
//
// A window opens during the run. Report and screenshots: .ui-test/report/
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIT_SCRIPT } from './ui-test-audit.mjs'
import { LONG_TITLE_EN, UI_TEST_SECRET, UI_UUID_RE, writeUiTestProfile } from './ui-test-profile.mjs'
import { CODEX_TEST_EMAIL, CODEX_TEST_SECRET, CODEX_UUID_RE, writeCodexProfile } from './ui-test-codex.mjs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, '.ui-test')
const REPORT = path.join(WORK, 'report')

const argv = process.argv.slice(2)
const allArgs = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []))
const oneArg = (name) => allArgs(name)[0]
const EXE = oneArg('--exe') ? path.resolve(oneArg('--exe')) : null
const QUICK = argv.includes('--quick')
const KEEP = argv.includes('--keep')
const ALL_SHOTS = argv.includes('--shots')
const PORT = oneArg('--port') ? Number(oneArg('--port')) : 0
const CHANNELS = EXE ? ['packaged'] : oneArg('--channel') ? [oneArg('--channel')] : ['development', 'store']
const LOCALES = allArgs('--locale').length ? allArgs('--locale') : QUICK ? ['vi'] : ['en', 'vi', 'zh-CN']
const FILTERS = ['all', 'active', 'archived', 'hidden', 'transcript-only', 'problems']
const MIN_WINDOW = { width: 1000, height: 620 } // minWidth / minHeight in src/main/index.ts
const LAUNCH_ATTEMPTS = 3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quote = (value) => JSON.stringify(value)

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const checks = []
const findings = new Map()
let shotCount = 0
/** The app running right now, for the watchdog. */
let runningChild = null

function check(name, ok, extra = '') {
  checks.push({ name, ok: !!ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`)
  return !!ok
}
const skip = (name, why) => console.log(`SKIP  ${name}  [${why}]`)

// ---------------------------------------------------------------------------
// The app under test
// ---------------------------------------------------------------------------

function sandboxEnv(home, userData, channel) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/^(CLAUDE|ELECTRON|CODEX)_/i.test(name)) delete env[name]
  Object.assign(env, {
    // Codex: the stand-in (scripts/ui-test-codex.mjs) instead of the real Codex CLI.
    CLAUDE_SESSION_MANAGER_CODEX_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'scripts', 'ui-test-codex.mjs')]),
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: path.parse(home).root.replace(/\\$/, ''),
    HOMEPATH: home.slice(path.parse(home).root.length - 1),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_SESSION_MANAGER_USER_DATA: userData
  })
  if (channel === 'store') env.CLAUDE_SESSION_MANAGER_DISTRIBUTION = 'store'
  if (channel === 'development') env.CLAUDE_SESSION_MANAGER_DEV_FAKE_UPDATE = '9.9.9'
  return env
}

async function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('cannot connect to the app'))
  })
  let next = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data)
    if (m.method) return onEvent(m.method, m.params)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.error) p.reject(new Error(m.error.message))
    else p.resolve(m.result)
  }
  // A crashed or frozen app must end the run with a reason, not leave it waiting.
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('the connection to the app was lost (did it crash?)'))
    pending.clear()
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`the app did not answer ${method} within a minute`))
      }, 60_000)
      const settled = (fn) => (value) => {
        clearTimeout(timer)
        fn(value)
      }
      pending.set(id, { resolve: settled(resolve), reject: settled(reject) })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  const waitFor = async (expression, what, timeoutMs = 20_000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(50)
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  return { send, evaluate, waitFor, close: () => ws.close() }
}

/** Ends only this script's own child and its helper processes. */
function killApp(child) {
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
}

/** The test app may hold its files for a moment after it closes. */
async function removeFolder(folder) {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(folder, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt === 10) throw err
      await sleep(1000)
    }
  }
}

/** Start the app and return a page connection, or throw (the caller may retry). */
async function launch(channel, env) {
  const flags = [`--remote-debugging-port=${PORT}`, '--force-device-scale-factor=1', '--disable-gpu']
  const command = EXE ?? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const args = EXE ? flags : [ROOT, ...flags]
  const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] })
  let startError = null
  child.once('error', (err) => {
    startError = new Error(`cannot start ${command}: ${err.message}`)
  })
  // Always read the app's log output: a full pipe would freeze it.
  let log = ''
  child.stderr.on('data', (d) => {
    if (log.length < 20_000) log += d.toString()
  })
  const events = []
  const stop = async (page) => {
    if (startError) return
    const exited = new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)))
    page?.evaluate('window.close()').catch(() => {})
    await Promise.race([exited, sleep(15_000)])
    page?.close()
    if (child.exitCode === null) killApp(child)
  }
  try {
    const port =
      PORT ||
      (await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the app did not open a DevTools port')), 60_000)
        child.once('error', () => reject(startError))
        child.stderr.on('data', () => {
          const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(log)
          if (m) {
            clearTimeout(timer)
            resolve(Number(m[1]))
          }
        })
        child.once('exit', (code) => reject(new Error(`the app exited early (${code}): ${log.slice(0, 300)}`)))
      }))
    let page = null
    const end = Date.now() + 60_000
    while (Date.now() < end && !page) {
      if (startError) throw startError
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])
      const target = targets.find((t) => t.type === 'page' && t.url.startsWith('file:'))
      if (target) page = await connect(target.webSocketDebuggerUrl, (method, params) => events.push({ method, params }))
      else await sleep(200)
    }
    if (!page) throw new Error('the window did not load')
    await page.send('Runtime.enable')
    await page.send('Log.enable')
    await page.send('Page.enable')
    // Every start shows the choice of tool (Claude or Codex) first.
    await page.waitFor(`document.querySelector('.picker-card')`, 'the choice of tool', 45_000)
    return { child, page, events, stop: () => stop(page) }
  } catch (err) {
    await stop(null)
    throw err
  }
}

// ---------------------------------------------------------------------------
// One full run against one variant of the app
// ---------------------------------------------------------------------------

async function runVariant(channel) {
  console.log(`\n=== ${channel} ===`)
  const base = path.join(WORK, `run-${channel}`)
  const home = path.join(base, 'home')
  const userData = path.join(home, 'userData')
  await removeFolder(base)
  mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true })
  mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  mkdirSync(userData, { recursive: true })
  // English first, so the behaviour pass can compare against stable text.
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ language: 'en', refreshMode: 'manual' }))
  const profile = writeUiTestProfile(home, { livePid: process.pid })
  const { roles } = profile
  // Real project folders in the throw-away profile: a terminal opened from a Codex session starts in its folder.
  const codexCwds = ['185', 'OCR', 'CMS'].map((name) => path.join(home, 'projects', name))
  for (const dir of codexCwds) mkdirSync(dir, { recursive: true })
  const codexProfile = writeCodexProfile(home, { cwds: codexCwds })
  const cxRoles = codexProfile.roles
  const env = sandboxEnv(home, userData, channel)

  let app = null
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS && !app; attempt++) {
    try {
      app = await launch(channel, env)
    } catch (err) {
      console.log(`launch attempt ${attempt} failed: ${err.message}`)
      if (attempt === LAUNCH_ATTEMPTS) {
        check(`${channel}: the app starts`, false, err.message)
        return
      }
      await sleep(20_000)
    }
  }
  const { page, events } = app
  runningChild = app.child

  const has = (selector) => page.evaluate(`!!document.querySelector(${quote(selector)})`)
  const count = (selector) => page.evaluate(`document.querySelectorAll(${quote(selector)}).length`)
  const text = (selector) => page.evaluate(`document.querySelector(${quote(selector)})?.textContent?.trim() ?? ''`)
  const settle = () => sleep(110)

  /** A real mouse click: fails if something else is on top of the element. */
  const clickEl = async (expression, what = expression) => {
    // A control may be disabled for a moment while the app finishes the last action.
    await page.waitFor(`!(${expression})?.disabled`, `${what} to become enabled`, 10_000).catch(() => {})
    const box = await page.evaluate(`(() => {
      const el = ${expression}
      if (!el) return null
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const top = document.elementFromPoint(x, y)
      return { x, y, disabled: !!el.disabled, hit: !!top && (top === el || el.contains(top) || top.contains(el) || !!el.closest('label')?.contains(top)), top: top ? top.tagName + '.' + top.className : 'nothing' }
    })()`)
    if (!box) throw new Error(`nothing to click: ${what}`)
    if (box.disabled) throw new Error(`cannot click ${what}: it is disabled`)
    if (!box.hit) throw new Error(`cannot click ${what}: ${box.top} is on top of it`)
    const mouse = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse })
  }
  const click = (selector) => clickEl(`document.querySelector(${quote(selector)})`, selector)
  const KEY_CODES = { Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Enter: 13, c: 67, k: 75, '/': 191 }
  const press = async (key, modifiers = 0) => {
    const common = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: KEY_CODES[key], nativeVirtualKeyCode: KEY_CODES[key], modifiers }
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  }
  const setInput = (selector, value) =>
    page.evaluate(`(() => {
      const el = document.querySelector(${quote(selector)})
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${quote(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  /** The app's dropdowns (components/Select.tsx), by their stable name. */
  const selectEl = (name) => `document.querySelector('.select[data-name="${name}"]')`
  const optionEl = (value) => `document.querySelector('.select-menu [role="option"][data-value="${value}"]')`
  const openSelect = async (name) => {
    if (!(await page.evaluate(`${selectEl(name)}.classList.contains('open')`))) await clickEl(selectEl(name), `the ${name} dropdown`)
    await page.waitFor(`document.querySelector('.select-menu')`, `the ${name} list`)
    // It slides in: measure where it ends up, not halfway.
    await page.evaluate(`Promise.all(document.querySelector('.select-menu').getAnimations().map((a) => a.finished)).then(() => true)`)
  }
  /** Choose with the mouse, as a person would. */
  const setSelect = async (name, value) => {
    if ((await page.evaluate(`${selectEl(name)}.dataset.value`)) === String(value)) return
    await openSelect(name)
    await clickEl(optionEl(value), `${value} in the ${name} list`)
    await page.waitFor(`!document.querySelector('.select-menu') && ${selectEl(name)}.dataset.value === ${quote(String(value))}`, `${name}: ${value}`)
  }
  /** One typed character, as the keyboard sends it. */
  const typeChar = async (ch) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  }
  const setSize = async ({ width, height }) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await settle()
  }
  const shot = async (name) => {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(path.join(REPORT, `${name}.png`), Buffer.from(data, 'base64'))
  }

  const filterEl = (id) => `document.querySelectorAll('.nav > .nav-item')[${FILTERS.indexOf(id)}]`
  /** Archive, Restore, Hide or Show. */
  const STATE_BUTTON = `document.querySelector('.inspector .actions .state-action')`
  const STORAGE_EL = `document.querySelectorAll('.sidebar-bottom .nav-item')[0]`
  const SETTINGS_EL = `document.querySelectorAll('.sidebar-bottom .nav-item')[1]`
  const closeToasts = async () => {
    await page.evaluate(`document.querySelectorAll('.toast .icon-btn').forEach((b) => b.click())`)
    await page.waitFor(`!document.querySelector('.toast')`, 'the messages to close', 5000)
  }
  const until = async (condition, what, timeoutMs = 10_000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (condition()) return true
      await sleep(50)
    }
    console.log(`timed out waiting for ${what}`)
    return false
  }

  const ACCOUNT_LABELS = ['first.account', 'second.account', 'third.account']
  const accountItem = (i) => `document.querySelectorAll('.account-menu [role="menuitemradio"]')[${i}]`
  const accountOnScreen = () => text('.account-trigger-name')
  const openAccounts = async () => {
    if (!(await has('.account-menu'))) await click('.account-trigger')
    await page.waitFor(`document.querySelector('.account-menu')`, 'the list of accounts')
  }
  const selectAccount = async (i) => {
    await openAccounts()
    await clickEl(accountItem(i), `account ${i} in the list`)
    await page.waitFor(`!document.querySelector('.account-menu') && document.querySelector('.account-trigger-name').textContent === ${quote(ACCOUNT_LABELS[i])}`, `account ${i} on screen`)
    await settle()
  }
  /** Enter as a keyboard really sends it: a control only reacts to the character, not to the bare key press. */
  const pressEnter = async () => {
    const common = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...common })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  }

  /** The tool on screen: claude, codex, or null on the picker. */
  const toolOnScreen = () => page.evaluate(`document.querySelector('.picker-card') ? null : document.querySelector('.app')?.dataset.provider ?? null`)
  const goTool = async (tool) => {
    if ((await toolOnScreen()) === tool) return
    if (!(await has('.picker-card'))) {
      await clickEl(`document.querySelector('.provider-switch')`, 'the switch of tool')
      await page.waitFor(`document.querySelector('.picker-card')`, 'the choice of tool')
    }
    await clickEl(`document.querySelector('.picker-card.${tool}')`, `the ${tool} card`)
    await page.waitFor(`document.querySelector('.app')?.dataset.provider === '${tool}' && document.querySelectorAll('.row').length > 0`, `the ${tool} sessions`)
    await settle()
  }

  /** Back to a known place: the first account's full session list with nothing open or checked. */
  const reset = async () => {
    if ((await toolOnScreen()) !== 'claude') {
      // A dialog fades out: the switch can be clicked only once it is gone.
      for (let i = 0; i < 3 && (await has('.modal-backdrop')); i++) {
        await press('Escape')
        await page.waitFor(`!document.querySelector('.modal-backdrop')`, 'the dialog to close', 5000).catch(() => {})
      }
      if (await has('.menu')) await press('Escape')
      await goTool('claude')
    }
    for (let i = 0; i < 3 && (await has('.modal-backdrop')); i++) {
      await press('Escape')
      await page.waitFor(`!document.querySelector('.modal-backdrop')`, 'the dialog to close', 5000).catch(() => {})
    }
    if (await has('.menu')) await press('Escape')
    // Its terminals keep running, out of sight.
    if (await terminalShown()) await hideTerminalPanel()
    await closeToasts()
    if ((await has('.account-trigger')) && (await accountOnScreen()) !== ACCOUNT_LABELS[0]) await selectAccount(0)
    await clickEl(filterEl('all'), 'the All sessions filter')
    await page.waitFor(`document.querySelector('.list-pane')`, 'the session list')
    if (await has('.bulk-bar')) await click('.bulk-bar .btn.quiet')
    if (await page.evaluate(`document.querySelector('.search input').value !== ''`)) await setInput('.search input', '')
    await setSelect('sort', 'updated-desc')
    await setSelect('group', 'date')
    if ((await page.evaluate(`document.querySelector('.nav-label-button').getAttribute('aria-expanded')`)) !== 'true') await click('.nav-label-button')
    await page.evaluate(`for (const s of document.querySelectorAll('.nav, .list-scroll, .inspector-scroll')) s.scrollTop = 0`)
    await settle()
  }

  let ids = {}
  const idOf = (uuid) => ids[uuid]
  const rowEl = (uuid) => `document.querySelector(${quote(`.row-main[data-id="${idOf(uuid)}"]`)})`
  const selectRow = async (uuid, filter = 'all') => {
    await clickEl(filterEl(filter), `the ${filter} filter`)
    await page.waitFor(rowEl(uuid), `the session ${uuid} in the ${filter} list`)
    await clickEl(rowEl(uuid), `the row of ${uuid}`)
    await page.waitFor(`document.querySelector('.inspector .actions')`, 'the details panel')
    await settle()
  }
  const refreshSnapshot = () => page.evaluate('window.sessionManager.refreshSessions()')
  const goSettings = async () => {
    await clickEl(SETTINGS_EL, 'the Settings item')
    // The usage at the top is in place: nothing below it moves any more.
    await page.waitFor(`document.querySelector('.page.settings') && !document.querySelector('.usage-pending')`, 'the settings page')
  }
  /** A refresh option in Settings: 1 manual, 2 watch, 3 interval. */
  const refreshOption = (n) => `document.querySelector('.settings .segmented[data-name="refresh"] label:nth-child(${n})')`
  /** Settings keeps paths, cache, debug mode and logs under Advanced, closed: open it with the mouse. */
  const openAdvanced = async () => {
    if (!(await page.evaluate(`document.querySelector('.settings-advanced').open`))) await clickEl(`document.querySelector('.settings-advanced > summary')`, 'the Advanced heading')
    await page.waitFor(`document.querySelector('.settings-advanced[open]')`, 'the Advanced part open')
    await settle()
  }
  const goStorage = async () => {
    await clickEl(STORAGE_EL, 'the Storage item')
    await page.waitFor(`document.querySelector('.page.storage')`, 'the storage page')
  }

  // The integrated terminal (not in the Store edition).
  const terminalShown = () => has('.terminal-panel:not([hidden])')
  const terminalText = () => page.evaluate(`document.querySelector('.terminal-view.active .xterm-rows')?.textContent ?? ''`)
  /** Each tab as "<program> <folder>", e.g. "pwsh ~". */
  const terminalTabs = () => page.evaluate(`[...document.querySelectorAll('.terminal-tab')].map((t) => t.querySelector('.terminal-tab-name').textContent + ' ' + t.querySelector('.terminal-tab-folder').textContent)`)
  const activeTab = () => text('.terminal-tab.on .terminal-tab-name')
  const waitForPrompt = (what = 'a shell prompt') =>
    page.waitFor(`document.querySelector('.terminal-panel:not([hidden]) .terminal-tab') && /\\S/.test(document.querySelector('.terminal-view.active .xterm-rows')?.textContent ?? '')`, what, 30_000)
  /** Ctrl+` (Ctrl+Shift+` with shift), as the keyboard sends it. */
  const pressBackquote = async (shift = false) => {
    const common = { key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192, modifiers: 2 | (shift ? 8 : 0) }
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  }
  /** Shows the panel with its sidebar item; the first terminal starts by itself. */
  const showTerminal = async () => {
    if (!(await terminalShown())) await clickEl(`document.querySelector('.terminal-toggle')`, 'the Terminal item')
    await waitForPrompt()
    await settle()
  }
  const MAXIMIZE = '.terminal-actions > .icon-btn[aria-pressed]'
  const hideTerminalPanel = async () => {
    if (await has('.terminal-panel.maximized')) {
      await click(MAXIMIZE)
      // The panel moves down as it shrinks: find the Hide button where it ends up.
      await page.waitFor(`!document.querySelector('.terminal-panel.maximized')`, 'the panel to restore')
      await settle()
    }
    if (await terminalShown()) await clickEl(`document.querySelector('.terminal-actions > .icon-btn:last-child')`, 'the Hide panel button')
    await page.waitFor(`!document.querySelector('.terminal-panel:not([hidden])')`, 'the terminal panel to hide')
  }
  /** Types a command into the terminal that has the focus, and runs it. */
  const runInTerminal = async (command) => {
    await page.send('Input.insertText', { text: command })
    await pressEnter()
  }
  const setLocale = async (locale) => {
    await reset()
    await goSettings()
    await click(`label.segment[lang="${locale}"]`)
    await page.waitFor(`document.documentElement.lang === ${quote(locale)}`, `the language ${locale}`)
    await settle()
  }

  // Layout audit of whatever is on screen now.
  let locale = 'en'
  let sizeName = ''
  const strings = new Map()
  const audit = async (state) => {
    const { problems, strings: seen } = await page.evaluate(AUDIT_SCRIPT)
    // The reported defect, checked exactly: sidebar items keep their designed height.
    const heights = await page.evaluate(`({
      filters: [...document.querySelectorAll('.nav > .nav-item')].map((e) => e.getBoundingClientRect().height),
      projects: [...document.querySelectorAll('.nav-project')].map((e) => e.getBoundingClientRect().height),
      bottom: [...document.querySelectorAll('.sidebar-bottom .nav-item')].map((e) => e.getBoundingClientRect().height)
    })`)
    if (heights.filters.some((h) => h !== 32) || heights.bottom.some((h) => h !== 32) || heights.projects.some((h) => h !== 28)) {
      problems.push({ rule: 'sidebar-height', severity: 'error', where: '.nav-item', detail: `filters ${[...new Set(heights.filters)].join('/')}px, projects ${[...new Set(heights.projects)].join('/')}px, bottom ${[...new Set(heights.bottom)].join('/')}px (designed: 32, 28, 32)` })
    }
    // The toolbar of the details panel: a two-by-two grid, edge to edge, in every language and size.
    const bar = await page.evaluate(`(() => {
      const bar = document.querySelector('.inspector .actions')
      // Not on screen (a maximized terminal hides the page): nothing to measure.
      if (!bar?.checkVisibility()) return null
      const box = bar.getBoundingClientRect()
      return { left: box.left, right: box.right, cells: [...bar.children].map((c) => { const r = c.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, height: r.height } }) }
    })()`)
    if (bar) {
      const same = (x, y) => Math.abs(x - y) <= 1
      const [a, b, c, d] = bar.cells
      const topRow = !!a && !!b && same(a.left, bar.left) && same(b.right, bar.right) && same(a.top, b.top)
      const bottomRow = !!c && (d ? same(c.left, a.left) && same(c.right, a.right) && same(d.left, b.left) && same(d.right, b.right) && same(c.top, d.top) : same(c.left, bar.left) && same(c.right, bar.right))
      if (!topRow || !bottomRow || bar.cells.length > 4 || bar.cells.some((cell) => !same(cell.height, 32))) {
        problems.push({ rule: 'toolbar-grid', severity: 'error', where: '.inspector .actions', detail: `${bar.cells.length} cells: ${bar.cells.map((cell) => `${Math.round(cell.left)}-${Math.round(cell.right)}@${Math.round(cell.top)} h${Math.round(cell.height)}`).join(', ')} in ${Math.round(bar.left)}-${Math.round(bar.right)}` })
      }
    }
    const key = `${channel}/${state}`
    if (!strings.has(key)) strings.set(key, new Map())
    const perLocale = strings.get(key)
    if (!perLocale.has(locale)) perLocale.set(locale, new Set())
    for (const s of seen) perLocale.get(locale).add(s)

    for (const p of problems) {
      const id = `${p.severity}|${p.rule}|${p.where}`
      let finding = findings.get(id)
      const combo = `${channel}/${state}/${locale}/${sizeName}`
      if (!finding) {
        shotCount += 1
        finding = { ...p, count: 0, combos: [], shot: shotCount <= 80 ? `${String(shotCount).padStart(3, '0')}-${p.rule}-${state}-${locale}-${sizeName}` : null }
        findings.set(id, finding)
        if (finding.shot) await shot(finding.shot).catch(() => {})
      }
      finding.count += 1
      if (finding.combos.length < 6) finding.combos.push(combo)
    }
    return problems
  }

  let failure = null
  try {
    // -----------------------------------------------------------------------
    // Guard rail: everything must come from the throw-away folder.
    // -----------------------------------------------------------------------
    const picker = await page.evaluate(`[...document.querySelectorAll('.picker-card')].map((c) => ({ tool: c.dataset.provider, logo: !!c.querySelector('svg.brand-logo'), name: c.querySelector('.picker-name').textContent }))`)
    check(`${channel}: every start offers Claude and Codex, each with its logo`, picker.map((c) => `${c.tool}:${c.name}:${c.logo}`).join() === 'claude:Claude:true,codex:Codex:true', JSON.stringify(picker))
    check(`${channel}: the picker names the trademarks and that the app is unofficial`, /Anthropic/.test(await text('.picker-legal')) && /OpenAI/.test(await text('.picker-legal')))
    check(`${channel}: the keyboard starts on the first tool`, await page.evaluate(`document.activeElement?.dataset.provider === 'claude'`))
    await press('ArrowRight')
    check(`${channel}: the arrow keys move between the tools`, await page.evaluate(`document.activeElement?.dataset.provider === 'codex'`))
    await press('ArrowLeft')
    await pressEnter()
    await page.waitFor(`document.querySelector('.app')?.dataset.provider === 'claude' && document.querySelectorAll('.row').length > 0`, 'the Claude sessions')
    check(`${channel}: Enter opens the tool`, true)

    const snap = await page.evaluate('window.sessionManager.scanSessions()')
    const inSandbox = (p) => p.toLowerCase().startsWith(home.toLowerCase() + path.sep)
    const safe =
      inSandbox(snap.roots.claudeHome) &&
      snap.roots.accounts.every((a) => inSandbox(a.path)) &&
      snap.roots.desktopRoots.every((d) => inSandbox(d.path)) &&
      snap.sessions.every((s) => !s.cliSessionId || UI_UUID_RE.test(s.cliSessionId))
    if (!safe) throw new Error(`NOT IN THE THROW-AWAY FOLDER, stopping before any click: ${snap.roots.claudeHome}`)
    check(`${channel}: the app reads only the throw-away profile`, true, `${snap.sessions.length} sessions`)
    const cxSnap = await page.evaluate(`window.sessionManager.scanSessions('codex')`)
    // Codex folders are shown by their real path: compare with the profile's real path too.
    const realHomeDir = realpathSync.native(home).toLowerCase()
    const realHome = (p) => inSandbox(p) || p.toLowerCase().startsWith(realHomeDir + path.sep)
    const cxSafe =
      cxSnap.provider === 'codex' &&
      cxSnap.roots.accounts.length === 2 &&
      cxSnap.roots.accounts.every((a) => realHome(a.path)) &&
      cxSnap.sessions.every((s) => CODEX_UUID_RE.test(s.cliSessionId ?? ''))
    if (!cxSafe) throw new Error(`CODEX NOT IN THE THROW-AWAY FOLDER, stopping before any click: ${cxSnap.roots.accounts.map((a) => a.path).join(', ')}`)
    check(`${channel}: Codex is read only from the throw-away profile`, true, `${cxSnap.sessions.length} sessions`)
    ids = Object.fromEntries([...snap.sessions, ...cxSnap.sessions].filter((s) => s.cliSessionId).map((s) => [s.cliSessionId, s.id]))

    const info = await page.evaluate('window.sessionManager.getAppInfo()')
    const processStatus = await page.evaluate('window.sessionManager.getClaudeProcessStatus(true)')
    /**
     * Claude Desktop blocks archive and delete while it runs, so those steps are skipped then.
     * Asked again before each of them: Desktop may be opened, or closed, during the run.
     */
    const canChange = async () => {
      const status = await page.evaluate('window.sessionManager.getClaudeProcessStatus(true)')
      return !status.desktopRunning && !status.error
    }
    const isStore = info.distribution === 'store'
    const updateState = await page.evaluate('window.sessionManager.getUpdateState()')
    console.log(`channel=${info.distribution} version=${info.version} claudeDesktopRunning=${processStatus.desktopRunning} updates=${updateState.mode}/${updateState.status}`)
    if (processStatus.desktopRunning || processStatus.error) console.log('Claude Desktop is running on this PC (or cannot be checked): archive and delete steps are skipped while it is.')

    const frame = await page.evaluate(`({ width: window.outerWidth - window.innerWidth, height: window.outerHeight - window.innerHeight })`)
    const minSize = { width: MIN_WINDOW.width - frame.width, height: MIN_WINDOW.height - frame.height }
    const allSizes = [
      { name: 'min', ...minSize },
      { name: '1280x720', width: 1280, height: 720 },
      { name: 'default', width: 1440 - frame.width, height: 900 - frame.height },
      { name: '1920x1080', width: 1920, height: 1080 }
    ]
    const wanted = allArgs('--size').map((s) => {
      const [width, height] = s.split('x').map(Number)
      return { name: s, width, height }
    })
    const SIZES = wanted.length ? wanted : QUICK ? [allSizes[0]] : allSizes
    console.log(`smallest window content: ${minSize.width}×${minSize.height}`)

    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    // Animations off, so what is measured is the final layout.
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })

    // The first screen, with no session selected: this state cannot be reached again later.
    sizeName = allSizes[0].name
    await setSize(allSizes[0])
    await audit('startup-nothing-selected')

    // Sessions to fill the "hidden" view.
    const hiddenSeed = [roles.longZh, roles.noProject]
    await page.evaluate(`window.sessionManager.bulkHide(${quote(hiddenSeed.map(idOf))})`)
    await refreshSnapshot()
    await settle()

    // -----------------------------------------------------------------------
    // 1. Self-check: the audit must notice known defects.
    // -----------------------------------------------------------------------
    await reset()
    const withDefect = async (name, rule, css, html) => {
      await page.evaluate(`(() => {
        const s = document.createElement('style'); s.id = 'ui-test-defect'; s.textContent = ${quote(css ?? '')}; document.head.append(s)
        ${html ? `const d = document.createElement('div'); d.id = 'ui-test-defect-html'; d.innerHTML = ${quote(html)}; document.querySelector('.list-title-row').append(d)` : ''}
      })()`)
      await settle()
      const { problems } = await page.evaluate(AUDIT_SCRIPT)
      await page.evaluate(`document.getElementById('ui-test-defect')?.remove(); document.getElementById('ui-test-defect-html')?.remove()`)
      await settle()
      check(`self-check: the audit notices ${name}`, problems.some((p) => p.rule === rule), rule)
    }
    await withDefect('sidebar items squashed by flexbox', 'squashed', '.nav-item { flex: 0 1 auto !important }')
    await withDefect('text drawn over other text', 'text-overlap', '.identity-sub { margin-top: -16px }')
    await withDefect('a control covered by something else', 'covered', '.list-header::after { content: ""; position: fixed; inset: 0; z-index: 999 }')
    await withDefect('text cut off without an ellipsis', 'clipped-text', '.page-title { width: 20px; flex: none; overflow: hidden; white-space: nowrap; text-overflow: clip !important }')
    await withDefect('text sticking out of its button', 'spill', '.list-title-row .btn { width: 16px; overflow: visible; white-space: nowrap; flex: none }')
    await withDefect('an untranslated key', 'raw-text', null, '<span>sessions:filter.all</span>')
    await withDefect('a button with no name', 'no-name', null, '<button></button>')
    // The Settings defect that was reported: a stacked row's label stretched to 220px.
    await withDefect('empty space under a settings label', 'empty-gap', '.setting-row.stacked .setting-text { flex: 1 1 220px !important }', '<div class="setting-row stacked"><div class="setting-text"><div class="setting-label">Label</div></div></div>')

    // The update screens, with the fake updater. It stays "downloaded" for the layout pass,
    // so the sidebar also carries the update message there.
    const fakeUpdates = channel === 'development'
    if (fakeUpdates) {
      const updateStatus = async () => (await page.evaluate('window.sessionManager.getUpdateState()')).status
      await reset()
      await goSettings()
      if ((await updateStatus()) !== 'available') await click('.update-panel .row-actions .btn')
      await page.waitFor(`document.querySelector('.update-pill')`, 'the update message in the sidebar')
      check('updates: a new version shows a message in the sidebar', (await text('.update-pill')).includes('9.9.9'))
      await reset()
      await click('.update-pill')
      await page.waitFor(`document.querySelector('.page.settings')`, 'the settings page')
      check('updates: the sidebar message opens Settings', true)
      await settle()
      await audit('update-available')
      await click('.update-panel .btn.primary')
      await page.waitFor(`document.querySelector('.update-panel .progress')`, 'the download progress')
      await audit('update-downloading')
      check('updates: the download shows its progress', true)
      await page.waitFor(`document.querySelector('.update-panel.status-downloaded')`, 'the finished download')
      await settle()
      await click('.update-panel .btn.primary')
      await page.waitFor(`document.querySelector('.modal-backdrop')`, 'the install question')
      await settle()
      check('updates: installing asks first, with Cancel focused', await page.evaluate(`document.activeElement === document.querySelector('.modal-footer .btn.quiet')`))
      await click('.modal-footer .btn.quiet')
      await page.waitFor(`!document.querySelector('.modal-backdrop')`, 'the question to close')
      check('updates: Cancel closes the question and nothing is installed', (await updateStatus()) === 'downloaded')
    }

    // -----------------------------------------------------------------------
    // 2. Layout: every screen × language × window size.
    // -----------------------------------------------------------------------
    const scrollToEnd = (selector) => page.evaluate(`document.querySelector(${quote(selector)}).scrollTop = 1e9`)
    const openTechnical = async () => {
      await click('details.technical summary')
      await page.waitFor(`document.querySelector('details.technical').open`, 'the technical details')
    }
    const openBulk = async () => {
      await reset()
      for (const uuid of [roles.longEn, roles.desktopActive[1], roles.desktopActive[2]]) {
        await clickEl(`document.getElementById(${quote(`row-${idOf(uuid)}`)}).querySelector('.row-check')`, 'a row checkbox')
      }
      await page.waitFor(`document.querySelector('.bulk-bar')`, 'the bulk bar')
    }
    const states = [
      { name: 'list', enter: reset },
      { name: 'picker', enter: async () => { await reset(); await clickEl(`document.querySelector('.provider-switch')`, 'the switch of tool'); await page.waitFor(`document.querySelector('.picker-card')`, 'the choice of tool') } },
      { name: 'codex-list', enter: async () => { await reset(); await goTool('codex') } },
      { name: 'codex-details', enter: async () => { await reset(); await goTool('codex'); await selectRow(cxRoles.withAgents); await openTechnical(); await scrollToEnd('.inspector-scroll') } },
      { name: 'codex-long-title', enter: async () => { await reset(); await goTool('codex'); await selectRow(cxRoles.longVi) } },
      { name: 'codex-account-menu', enter: async () => { await reset(); await goTool('codex'); await openAccounts() } },
      { name: 'codex-delete-dialog', enter: async () => { await reset(); await goTool('codex'); await selectRow(cxRoles.withAgents); await click('.inspector .actions .btn.danger'); await page.waitFor(`document.querySelector('.plan-session')`, 'the Codex delete plan') } },
      { name: 'codex-storage', enter: async () => { await reset(); await goTool('codex'); await goStorage() } },
      { name: 'codex-settings', enter: async () => { await reset(); await goTool('codex'); await goSettings() } },
      { name: 'codex-settings-advanced', enter: async () => { await reset(); await goTool('codex'); await goSettings(); await openAdvanced() } },
      { name: 'terminal', needs: () => !isStore, enter: async () => { await reset(); await showTerminal() } },
      { name: 'terminal-over-details', needs: () => !isStore, enter: async () => { await reset(); await selectRow(roles.longEn); await showTerminal() } },
      { name: 'terminal-shell-menu', needs: () => !isStore, enter: async () => { await reset(); await showTerminal(); await click('.terminal-shell-trigger'); await page.waitFor(`document.querySelector('.terminal-shell-menu')`, 'the list of shells') } },
      { name: 'terminal-maximized', needs: () => !isStore, enter: async () => { await reset(); await showTerminal(); await click(MAXIMIZE); await page.waitFor(`document.querySelector('.terminal-panel.maximized')`, 'the maximized panel') } },
      { name: 'codex-terminal-on-settings', needs: () => !isStore, enter: async () => { await reset(); await goTool('codex'); await goSettings(); await showTerminal() } },
      { name: 'sidebar-scrolled-to-end', enter: async () => { await reset(); await scrollToEnd('.nav') } },
      { name: 'sidebar-projects-collapsed', enter: async () => { await reset(); await click('.nav-label-button') } },
      { name: 'account-menu', enter: async () => { await reset(); await openAccounts() } },
      { name: 'account-menu-over-details', enter: async () => { await reset(); await selectRow(roles.longEn); await openAccounts() } },
      { name: 'account-menu-on-settings', enter: async () => { await reset(); await goSettings(); await openAccounts() } },
      { name: 'account-second', enter: async () => { await reset(); await selectAccount(1); await selectRow(roles.inBoth) } },
      { name: 'account-third', enter: async () => { await reset(); await selectAccount(2); await selectRow(roles.third[0]) } },
      { name: 'details-long-title', enter: async () => { await reset(); await selectRow(roles.longEn) } },
      { name: 'details-long-title-end', enter: async () => { await reset(); await selectRow(roles.longEn); await openTechnical(); await scrollToEnd('.inspector-scroll') } },
      { name: 'details-message-opened', enter: async () => { await reset(); await selectRow(roles.longEn); await click('.preview-label .link-btn'); await page.waitFor(`document.querySelector('.preview-text.expanded')`, 'the full message') } },
      { name: 'details-vietnamese-title', enter: async () => { await reset(); await selectRow(roles.longVi) } },
      { name: 'details-unbroken-title', enter: async () => { await reset(); await selectRow(roles.unbroken); await openTechnical(); await scrollToEnd('.inspector-scroll') } },
      { name: 'details-untitled', enter: async () => { await reset(); await selectRow(roles.untitled) } },
      { name: 'details-running-session', enter: async () => { await reset(); await selectRow(roles.live) } },
      { name: 'details-desktop-raw-metadata', enter: async () => { await reset(); await selectRow(roles.desktopActive[0]); await click('details.raw-metadata summary'); await page.waitFor(`document.querySelector('details.raw-metadata .code-block')`, 'the raw metadata'); await scrollToEnd('.inspector-scroll') } },
      { name: 'details-export-menu', enter: async () => { await reset(); await selectRow(roles.longEn); await click('.menu-trigger'); await page.waitFor(`document.querySelector('.menu')`, 'the export menu') } },
      { name: 'filter-active', enter: async () => { await reset(); await clickEl(filterEl('active')) } },
      { name: 'filter-archived', enter: async () => { await reset(); await selectRow(roles.desktopArchived[0], 'archived') } },
      { name: 'filter-hidden', enter: async () => { await reset(); await selectRow(roles.longZh, 'hidden') } },
      { name: 'filter-transcript-only', enter: async () => { await reset(); await clickEl(filterEl('transcript-only')) } },
      { name: 'filter-problems', enter: async () => { await reset(); await selectRow(roles.metadataOnly, 'problems') } },
      { name: 'project-long-name', enter: async () => { await reset(); await clickEl(`[...document.querySelectorAll('.nav-project')].find((b) => b.textContent.includes('very-long-folder-name'))`, 'the long project') ; await settle() } },
      { name: 'sort-dropdown-open', enter: async () => { await reset(); await openSelect('sort') } },
      { name: 'group-dropdown-open', enter: async () => { await reset(); await openSelect('group') } },
      {
        name: 'settings-interval-dropdown-open',
        enter: async () => {
          await reset()
          await goSettings()
          await clickEl(refreshOption(3), 'the interval refresh option')
          await page.waitFor(selectEl('refresh-interval'), 'the interval field')
          await openSelect('refresh-interval')
        }
      },
      { name: 'group-by-project', enter: async () => { await reset(); await setSelect('group', 'project') } },
      { name: 'search-no-match', enter: async () => { await reset(); await setInput('.search input', LONG_TITLE_EN + LONG_TITLE_EN) } },
      { name: 'bulk-bar', enter: openBulk },
      { name: 'storage', enter: async () => { await reset(); await goStorage() } },
      { name: 'storage-end', enter: async () => { await reset(); await goStorage(); await page.evaluate(`document.querySelector('.page').parentElement.scrollTop = 1e9; document.querySelector('.page').scrollTop = 1e9`) } },
      { name: 'settings', enter: async () => { await reset(); await goSettings() } },
      {
        name: 'settings-everything-open',
        enter: async () => {
          await reset()
          await goSettings()
          await clickEl(refreshOption(3), 'the interval refresh option')
          await page.waitFor(`document.querySelector('.inline-field .select')`, 'the interval field')
          await page.evaluate(`document.querySelectorAll('.settings details').forEach((d) => { d.open = true })`)
          await clickEl(`document.querySelector('[data-action="show-logs"]')`, 'the Show logs button')
          await page.waitFor(`document.querySelector('.code-block.log')`, 'the log')
          await page.evaluate(`document.querySelector('.page').scrollTop = 1e9`)
        },
        leave: async () => {
          await reset()
          await goSettings()
          await clickEl(refreshOption(1), 'the manual refresh option')
        }
      },
      {
        name: 'delete-dialog',
        needs: canChange,
        enter: async () => {
          await reset()
          await selectRow(roles.longEn)
          await click('.inspector .actions .btn.danger')
          await page.waitFor(`document.querySelector('.plan-session')`, 'the delete plan')
          await setInput('.confirm-input', 'DELETE')
        }
      },
      {
        name: 'delete-dialog-many',
        enter: async () => {
          await openBulk()
          await click('.bulk-bar .btn.danger')
          await page.waitFor(`document.querySelector('.plan-session')`, 'the bulk delete plan')
        }
      },
      {
        name: 'update-downloaded',
        needs: () => fakeUpdates,
        enter: async () => { await reset(); await goSettings(); await page.evaluate(`document.querySelector('.update-panel').scrollIntoView()`) }
      },
      {
        name: 'update-install-question',
        needs: () => fakeUpdates,
        enter: async () => {
          await reset()
          await goSettings()
          await click('.update-panel .btn.primary')
          await page.waitFor(`document.querySelector('.modal-backdrop')`, 'the install question')
        }
      },
      {
        name: 'store-safe-mode-settings',
        needs: () => isStore,
        enter: async () => { await reset(); await goSettings(); await page.evaluate(`document.querySelector('.settings-section.safety').scrollIntoView()`) }
      },
      {
        name: 'store-arm-dialog',
        needs: () => isStore,
        enter: async () => {
          await reset()
          await goSettings()
          await click('.settings-section.safety .btn.danger')
          await page.waitFor(`document.querySelector('.modal-backdrop')`, 'the arm dialog')
        }
      }
    ]

    for (const l of LOCALES) {
      await setLocale(l)
      locale = l
      for (const size of SIZES) {
        sizeName = size.name
        await setSize(size)
        for (const state of states) {
          if (state.needs && !(await state.needs())) continue
          try {
            await state.enter()
            await settle()
            await audit(state.name)
            if ((l === 'vi' && (size.name === 'default' || size.name === 'min')) || ALL_SHOTS) await shot(`state-${channel}-${l}-${size.name}-${state.name}`).catch(() => {})
          } catch (err) {
            check(`layout: ${state.name} (${l}, ${size.name})`, false, err.message)
            await shot(`error-${state.name}-${l}-${size.name}`).catch(() => {})
          } finally {
            await state.leave?.().catch((err) => check(`layout: undoing ${state.name} (${l}, ${size.name})`, false, err.message))
          }
        }
      }
      console.log(`layout pass done: ${l}, ${findings.size} distinct finding(s) so far`)
    }

    // Text that is the same as English in another language was probably never translated.
    const SAME_EVERYWHERE = /^(Claude( Desktop| Code| Local)?( Session Manager)?|Codex( CLI| Local)?|Terminal|PowerShell 7|Windows PowerShell|Git Bash|Claude Desktop \(.*\)|Session Manager|LHP( Local)?( Session Manager)?|Local Session Manager|DELETE( \d+)?|ENABLE DELETE|JSON|JSONL|Markdown|PID|CLI|GitHub|Microsoft Store|APPDATA|Ctrl K|English|Tiếng Việt|简体中文|[\d\s.,:/%·—-]+)$/
    for (const [state, perLocale] of strings) {
      const english = perLocale.get('en')
      if (!english) continue
      for (const [l, seen] of perLocale) {
        if (l === 'en') continue
        for (const s of seen) {
          if (english.has(s) && /[A-Za-z]{3}/.test(s) && !SAME_EVERYWHERE.test(s)) {
            const id = `warn|untranslated|${s}`
            if (!findings.has(id)) findings.set(id, { rule: 'untranslated', severity: 'warn', where: state, detail: `"${s.slice(0, 80)}" is the same in ${l} and English`, count: 1, combos: [`${state}/${l}`], shot: null })
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // 3. Behaviour, in English at the default window size (and the smallest for the sidebar).
    // -----------------------------------------------------------------------
    await setLocale('en')
    locale = 'en'

    // The sidebar defect that was reported: every item keeps its height while the list scrolls.
    sizeName = allSizes[0].name
    await setSize(allSizes[0])
    await reset()
    const sidebar = await page.evaluate(`(() => {
      const heights = (s) => [...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect().height)
      const nav = document.querySelector('.nav')
      return { filters: heights('.nav > .nav-item'), projects: heights('.nav-project'), bottom: heights('.sidebar-bottom .nav-item'), scrolls: nav.scrollHeight > nav.clientHeight, height: nav.clientHeight }
    })()`)
    check('sidebar: the six filters stay 32px tall with every project listed', sidebar.filters.length === 6 && sidebar.filters.every((h) => h === 32), sidebar.filters.join(','))
    check('sidebar: projects stay 28px tall', sidebar.projects.length >= 25 && sidebar.projects.every((h) => h === 28), `${sidebar.projects.length} projects`)
    check('sidebar: Storage and Settings stay 32px tall', sidebar.bottom.every((h) => h === 32))
    check('sidebar: the list scrolls instead of squeezing', sidebar.scrolls, `${sidebar.height}px visible`)
    await scrollToEnd('.nav')
    await settle()
    check(
      'sidebar: the last project can be scrolled into view',
      await page.evaluate(`(() => {
        const nav = document.querySelector('.nav').getBoundingClientRect()
        const last = [...document.querySelectorAll('.nav-project')].at(-1).getBoundingClientRect()
        return last.top >= nav.top && last.bottom <= nav.bottom + 1
      })()`)
    )
    await click('.nav-label-button')
    await settle()
    check('sidebar: collapsing hides the projects', !(await has('.nav-projects')) && (await page.evaluate(`document.querySelector('.nav-label-button').getAttribute('aria-expanded')`)) === 'false')
    await click('.nav-label-button')
    await settle()
    check('sidebar: expanding shows them again', await has('.nav-projects'))

    sizeName = allSizes[2].name
    await setSize(allSizes[2])
    await reset()

    // Claude accounts: a dropdown in the top right corner, and everything on screen follows it.
    const focusedItem = () => page.evaluate(`[...document.querySelectorAll('.account-menu [role="menuitemradio"]')].indexOf(document.activeElement)`)
    const triggerFocused = () => page.evaluate(`document.activeElement === document.querySelector('.account-trigger')`)
    check('accounts: the dropdown is on the top strip, last on the right, on the main account', (await page.evaluate(`document.querySelector('.status-strip').lastElementChild.contains(document.querySelector('.account-trigger'))`)) && (await accountOnScreen()) === ACCOUNT_LABELS[0] && !(await has('.account-menu')))
    await openAccounts()
    const tabs = await page.evaluate(`[...document.querySelectorAll('.account-menu [role="menuitemradio"]')].map((t) => ({ name: t.querySelector('.account-item-name').textContent, tag: t.querySelector('.account-item-tag')?.textContent ?? '', email: t.querySelector('.account-item-email')?.textContent ?? '', plan: t.querySelector('.account-item-plan')?.textContent ?? '', count: Number(t.querySelector('.account-item-count').textContent.replace(/\\D/g, '')), on: t.getAttribute('aria-checked') === 'true', mark: !!t.querySelector('.account-item-check'), title: t.title }))`)
    check('accounts: one row each, with the name and the whole email, the main account first and ticked', tabs.map((x) => x.name).join() === 'First Account,Second Account,Third Account' && tabs.map((x) => x.email).join() === 'first.account@example.com,second.account@example.com,third.account@example.com' && tabs.map((x) => x.on).join() === 'true,false,false' && tabs.map((x) => x.mark).join() === 'true,false,false', tabs.map((x) => `${x.name} ${x.count}`).join(', '))
    check('accounts: the labels say who shares a store, and an account with its own has none', !!tabs[0].tag && !!tabs[1].tag && tabs[0].tag !== tabs[1].tag && tabs[2].tag === '', tabs.map((x) => x.tag).join(' | '))
    check('accounts: the plan as Claude Code names it, and none where the file has none', tabs.map((x) => x.plan).join() === 'Max 20x,Pro,', tabs.map((x) => x.plan).join(' | '))
    check('accounts: the tooltip has the folder', tabs[1].title.includes('second-account'))
    const menuBox = await page.evaluate(`(() => { const r = document.querySelector('.account-menu').getBoundingClientRect(); const c = ${accountItem(2)}.getBoundingClientRect(); const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2); return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, onTop: ${accountItem(2)}.contains(hit), underStrip: r.top >= document.querySelector('.status-strip').getBoundingClientRect().bottom - 1 } })()`)
    check('accounts: the list opens under the strip, inside the window and above everything', menuBox.inside && menuBox.onTop && menuBox.underStrip, JSON.stringify(menuBox))
    check('accounts: opening starts on the account on screen', (await focusedItem()) === 0)
    await press('ArrowDown')
    check('accounts: the arrow keys move down the list', (await focusedItem()) === 1)
    await press('End')
    check('accounts: End goes to the last', (await focusedItem()) === 2)
    await press('ArrowDown')
    check('accounts: past the last goes back to the first', (await focusedItem()) === 0)
    await press('ArrowUp')
    check('accounts: before the first goes to the last', (await focusedItem()) === 2)
    await press('Home')
    check('accounts: Home goes to the first', (await focusedItem()) === 0)
    await press('ArrowDown')
    await press('Escape')
    await settle()
    check('accounts: Esc closes without switching and goes back to the button', !(await has('.account-menu')) && (await triggerFocused()) && (await accountOnScreen()) === ACCOUNT_LABELS[0])
    await press('ArrowDown')
    await settle()
    check('accounts: the arrow key opens it from the button', (await has('.account-menu')) && (await focusedItem()) === 0)
    await press('Tab')
    await settle()
    check('accounts: Tab closes it and moves on', !(await has('.account-menu')) && !(await triggerFocused()))
    await click('.account-trigger')
    await page.waitFor(`document.querySelector('.account-menu')`, 'the list of accounts')
    await click('.account-trigger')
    await settle()
    check('accounts: a second click on the button closes it', !(await has('.account-menu')))
    await openAccounts()
    await click('.account-menu .menu-note')
    await settle()
    check('accounts: a click on the note leaves it open and the keys still work', (await has('.account-menu')) && (await focusedItem()) === 0)
    await click('.page-title')
    await settle()
    check('accounts: a click elsewhere closes it without switching', !(await has('.account-menu')) && (await accountOnScreen()) === ACCOUNT_LABELS[0])
    await openAccounts()
    await press('k', 2)
    await settle()
    check('accounts: the search shortcut closes it and takes the focus', !(await has('.account-menu')) && (await page.evaluate(`document.activeElement === document.querySelector('.search input')`)))
    const rowIdsNow = () => page.evaluate(`[...document.querySelectorAll('.row-main')].map((r) => r.dataset.id).sort()`)
    const sameIds = (actual, uuids) => actual.join() === uuids.map(idOf).sort().join()
    await selectRow(roles.longEn)
    await selectAccount(1)
    check('accounts: switching clears what was selected in the other account', await has('.inspector-empty'))
    check('accounts: the second lists what it used, not the whole shared store', sameIds(await rowIdsNow(), [roles.onlySecond, roles.inBoth, roles.liveSecond]))
    check('accounts: the number in the list matches', tabs[1].count === 3 && (await page.evaluate(`${filterEl('all')}.querySelector('.nav-count').textContent`)) === '3')
    check('accounts: the projects follow', (await count('.nav-project')) === 1)
    const secondTotal = await page.evaluate(`document.querySelector('.sidebar-bottom .nav-count').textContent`)
    await goStorage()
    await page.waitFor(`document.querySelector('.hero-value')?.textContent === ${quote(secondTotal)}`, 'the storage page of the second account')
    check('accounts: the storage page follows', true, secondTotal)
    await selectRow(roles.inBoth)
    check('accounts: a session used by both says so', (await text('.inspector .kv')).includes('first.account, second.account'))
    await selectRow(roles.liveSecond)
    check(
      'accounts: a session running under the second account cannot be deleted',
      (await page.evaluate(`document.querySelector('.inspector .actions .btn.danger').disabled`)) && (await has('.inspector .notice.warn')) && (await has('.inspector-sub .badge-live'))
    )
    await selectAccount(2)
    check('accounts: the third, with its own store, lists its own sessions', sameIds(await rowIdsNow(), roles.third))
    await clickEl(`document.querySelector('.nav-project')`, 'the project of the third account')
    await settle()
    const thirdProject = await text('.page-title')
    await selectAccount(0)
    check('accounts: a project of another account does not stay open', (await text('.page-title')) !== thirdProject && (await count('.row')) === tabs[0].count, thirdProject)
    await selectAccount(1)
    const chosen = (await page.evaluate('window.sessionManager.scanSessions()')).roots.accounts[1].id
    check('accounts: the choice is remembered for the next start', (await page.evaluate(`localStorage.getItem('account')`)) === chosen)
    await openAccounts()
    check('accounts: the list ticks the account chosen and starts there', (await focusedItem()) === 1 && (await page.evaluate(`[...document.querySelectorAll('.account-menu [role="menuitemradio"]')].map((t) => t.getAttribute('aria-checked') + !!t.querySelector('.account-item-check')).join()`)) === 'falsefalse,truetrue,falsefalse')
    await press('ArrowDown')
    await pressEnter()
    await settle()
    check('accounts: Enter switches, closes and goes back to the button', (await accountOnScreen()) === ACCOUNT_LABELS[2] && !(await has('.account-menu')) && (await triggerFocused()))
    const leakCheck = JSON.stringify(await page.evaluate('window.sessionManager.scanSessions()')) + (await page.evaluate('document.body.innerText')) + (await page.evaluate(`window.sessionManager.getLogs().then(JSON.stringify)`))
    check('accounts: nothing but the name and plan is read from the sign-in files', !leakCheck.includes(UI_TEST_SECRET))
    await reset()

    // -----------------------------------------------------------------------
    // OpenAI Codex: the same app on Codex's own data, which only Codex changes,
    // through its CLI (here the stand-in scripts/ui-test-codex.mjs).
    // -----------------------------------------------------------------------
    // The accent tells the tools apart: Claude orange, Codex blue, also in a dropdown (drawn outside the app's frame).
    const accentOf = (selector) => page.evaluate(`getComputedStyle(document.querySelector(${quote(selector)})).color`)
    const ORANGE = 'rgb(217, 119, 87)'
    const BLUE = 'rgb(76, 141, 255)'
    await reset()
    const claudeAccent = await accentOf('.nav > .nav-item.active svg')
    await goTool('codex')
    const codexAccent = await accentOf('.nav > .nav-item.active svg')
    await openSelect('sort')
    const codexMenuAccent = await accentOf('.select-menu [aria-selected="true"] .select-option-check')
    await press('Escape')
    check('accent: orange for Claude, blue for Codex, dropdowns included', claudeAccent === ORANGE && codexAccent === BLUE && codexMenuAccent === BLUE, `${claudeAccent} / ${codexAccent} / ${codexMenuAccent}`)
    // The name and mark at the top of the sidebar follow the tool too (the Store edition's name has no "Claude" in it).
    const identity = () => page.evaluate(`document.querySelector('.identity-name').textContent + ' ' + document.querySelectorAll('.identity svg rect')[4].getAttribute('fill')`)
    const codexIdentity = await identity()
    check('identity: Codex Local with a blue mark while Codex is on screen', codexIdentity === (isStore ? 'LHP Local #4c8dff' : 'Codex Local #4c8dff'), codexIdentity)
    await goTool('claude')
    check('accent: back to orange with Claude', (await accentOf('.nav > .nav-item.active svg')) === ORANGE)
    const claudeIdentity = await identity()
    check('identity: back to Claude Local and the orange mark', claudeIdentity === (isStore ? 'LHP Local #d97757' : 'Claude Local #d97757'), claudeIdentity)
    await goTool('codex')
    const cxDb = (file) => new DatabaseSync(path.join(codexProfile.main, file))
    const cxThread = (id) => {
      const db = cxDb('state_5.sqlite')
      try {
        return db.prepare('SELECT archived, rollout_path FROM threads WHERE id = ?').get(id)
      } finally {
        db.close()
      }
    }
    const cxHistoryRows = (ids) => {
      const db = cxDb('thread_history_1.sqlite')
      try {
        return ids.reduce((n, id) => n + db.prepare('SELECT COUNT(*) AS n FROM thread_items WHERE thread_id = ?').get(id).n, 0)
      } finally {
        db.close()
      }
    }
    check('codex: the switch at the top names the tool on screen', (await text('.provider-switch-name')) === 'Codex')
    check('codex: the sessions the user started, not sub-agents or Codex reviews', sameIds(await rowIdsNow(), [cxRoles.named, cxRoles.aiTitle, cxRoles.archived, cxRoles.withAgents, cxRoles.recent, cxRoles.longVi]))
    const cxFilters = await page.evaluate(`[...document.querySelectorAll('.nav > .nav-item')].map((b) => b.querySelector('.nav-text').textContent)`)
    check('codex: only the views that apply, its archive named as Codex\'s', cxFilters.length === 4 && /Codex/.test(cxFilters[2]), cxFilters.join(' | '))
    const cxStrip = await page.evaluate(`({ text: document.querySelector('.strip-claude').innerText, warn: document.querySelector('.strip-claude').classList.contains('warn') })`)
    check('codex: the top strip tells about the Codex app and never blocks', /Codex/.test(cxStrip.text) && !cxStrip.warn, cxStrip.text)
    await openAccounts()
    const cxAccounts = await page.evaluate(`[...document.querySelectorAll('.account-item-name')].map((n) => n.textContent)`)
    check('codex: one row per Codex sign-in, named like Claude accounts, under a Codex heading', cxAccounts.join() === 'codex.user,account-2' && /Codex/.test(await text('.account-menu .menu-heading')), cxAccounts.join())
    const accountMeta = () => page.evaluate(`[...document.querySelectorAll('.account-item-meta')].map((m) => [...m.children].map((c) => c.className + '=' + c.textContent).join('|'))`)
    const cxMeta = await accountMeta()
    check(
      'codex: each row has the email and plan, or "API key", and its sessions',
      cxMeta[0]?.startsWith(`account-item-email=${CODEX_TEST_EMAIL}|account-item-plan=Pro|account-item-count=6 sessions`) && cxMeta[1] === 'account-item-plan=API key|account-item-count=2 sessions',
      JSON.stringify(cxMeta)
    )
    await press('Escape')

    await selectRow(cxRoles.named)
    const cxButtons = await page.evaluate(`[...document.querySelectorAll('.inspector .actions .btn')].map((b) => (b.disabled ? '-' : '+') + b.textContent.trim())`)
    check('codex: open, export, archive and delete', cxButtons.length === 4 && cxButtons.every((b) => b.startsWith('+')), cxButtons.join(' | '))
    check('codex: the details name Codex, not Claude', !/Claude/.test(await page.evaluate(`document.querySelector('.inspector').innerText`)))
    await selectRow(cxRoles.withAgents)
    await openTechnical()
    check('codex: a session shows the sessions it started', (await page.evaluate(`[...document.querySelectorAll('.inspector .kv dd')].map((d) => d.textContent)`)).includes('2'))

    // The session Codex is "working in": it adds to its conversation just now.
    {
      const db = cxDb('thread_history_1.sqlite')
      db.prepare('UPDATE thread_items SET created_at_ms = ? WHERE thread_id = ?').run(Date.now(), cxRoles.recent)
      db.close()
    }
    await page.evaluate(`window.sessionManager.refreshSessions('codex')`)
    await settle()
    await openAccounts()
    const cxOpen = await accountMeta()
    check('codex: the account row counts the session Codex is working in', cxOpen[0]?.endsWith('|account-item-open=1 active just now') && !cxOpen[1]?.includes('account-item-open'), JSON.stringify(cxOpen))
    await press('Escape')
    await selectRow(cxRoles.recent)
    check(
      'codex: a session Codex wrote to a moment ago cannot be archived or deleted, and says why',
      (await page.evaluate(`document.querySelector('.inspector .actions .btn.danger').disabled && document.querySelector('.inspector .actions .state-action').disabled`)) &&
        (await has('.inspector .notice.warn')) &&
        (await has('.inspector-sub .badge-live.live-recent'))
    )

    await selectRow(cxRoles.named)
    if (isStore) {
      await clickEl(STATE_BUTTON, 'Archive')
      await page.waitFor(`document.querySelector('.toast')`, 'the Safe Mode message')
      check('codex: Safe Mode only says what Codex would do', cxThread(cxRoles.named).archived === 0)
      await closeToasts()
    } else {
      await clickEl(STATE_BUTTON, 'Archive')
      await page.waitFor(`document.querySelector('.toast')`, 'the archive message')
      check('codex: Archive asks Codex, which archives it and moves its file', cxThread(cxRoles.named).archived === 1 && /archived_sessions/.test(cxThread(cxRoles.named).rollout_path))
      await closeToasts()
      await selectRow(cxRoles.named, 'archived')
      await clickEl(STATE_BUTTON, 'Restore')
      await page.waitFor(`document.querySelector('.toast')`, 'the restore message')
      check('codex: Restore asks Codex, which restores it', cxThread(cxRoles.named).archived === 0)
      await closeToasts()
    }

    // Delete: the plan says what Codex will remove; Codex removes it; the app checks.
    await selectRow(cxRoles.withAgents)
    await click('.inspector .actions .btn.danger')
    await page.waitFor(`document.querySelector('.plan-session')`, 'the Codex delete plan')
    const cxPlan = await page.evaluate(`[...document.querySelectorAll('.plan-group.delete .plan-item .plan-path')].map((el) => el.textContent)`)
    const cxGroups = await page.evaluate(`[...document.querySelectorAll('.plan-group-label')].map((l) => l.textContent).join(' | ')`)
    check('codex: the plan lists what Codex will remove, under its own heading', cxPlan.length === 6 && /codex delete/.test(cxGroups), `${cxPlan.length} items: ${cxGroups}`)
    check('codex: the plan touches only the throw-away Codex folder', cxPlan.every((p) => realHome(p)))
    const cxFiles = cxPlan.filter((p) => p.endsWith('.jsonl') && !p.endsWith('session_index.jsonl'))
    await setInput('.confirm-input', 'DELETE')
    const cxButton = isStore ? '.modal-footer .btn.info.solid' : '.modal-footer .btn.danger.solid'
    await page.waitFor(`!document.querySelector(${quote(cxButton)}).disabled`, 'the delete button')
    await click(cxButton)
    await page.waitFor(`document.querySelector('.result-session')`, 'the Codex delete result')
    const gone = [cxRoles.withAgents, cxRoles.agentA, cxRoles.agentB]
    if (isStore) {
      check('codex: Safe Mode deletes nothing', gone.every((id) => cxThread(id)) && cxFiles.every((f) => existsSync(f)))
    } else {
      check(
        'codex: deleted through Codex: the session, the sessions it started, their conversation and files, its index line',
        gone.every((id) => !cxThread(id)) &&
          cxHistoryRows(gone) === 0 &&
          cxFiles.length === 3 &&
          cxFiles.every((f) => !existsSync(f)) &&
          !readFileSync(path.join(codexProfile.main, 'session_index.jsonl'), 'utf8').includes(cxRoles.withAgents),
        `${cxFiles.length} files`
      )
      check('codex: the other sessions are untouched', !!cxThread(cxRoles.named) && !!cxThread(cxRoles.aiTitle))
    }
    await click('.modal-footer .btn[data-autofocus]')
    await page.waitFor(`!document.querySelector('.modal-backdrop')`, 'the dialog to close')
    await closeToasts()
    if (!isStore) check('codex: it leaves the list', !(await has(`.row-main[data-id="${idOf(cxRoles.withAgents)}"]`)))

    await goStorage()
    check('codex: the storage page counts Codex sessions', (await has('.stat-cells.four')) && (await count('.stat-cell')) === 4)
    await goSettings()
    check('codex: Settings says the Codex CLI is ready', (await has('.settings-section .inline-status.ok-text')) && !(await page.evaluate(`document.querySelector('.settings-advanced').open`)))
    await openAdvanced()
    check('codex: Advanced shows the Codex CLI the app runs', (await page.evaluate(`document.querySelector('.kv.roots').innerText`)).includes(process.execPath))
    const cxLeak = JSON.stringify(await page.evaluate(`window.sessionManager.scanSessions('codex')`)) + (await page.evaluate('document.body.innerText')) + (await page.evaluate(`window.sessionManager.getLogs().then(JSON.stringify)`))
    check('codex: nothing but the email and plan is read from the Codex sign-in files', !cxLeak.includes(CODEX_TEST_SECRET))
    await goTool('claude')
    check('codex: back to Claude, its sessions again', (await toolOnScreen()) === 'claude' && (await count('.row')) > 0)
    await reset()

    // Every filter shows as many rows as its counter says.
    for (const f of FILTERS) {
      await clickEl(filterEl(f), `the ${f} filter`)
      await settle()
      const shown = await count('.row')
      const counter = Number((await page.evaluate(`${filterEl(f)}.querySelector('.nav-count').textContent`)).replace(/\D/g, ''))
      const current = await page.evaluate(`${filterEl(f)}.getAttribute('aria-current')`)
      check(`filter ${f}: the counter matches the rows and the item is marked current`, shown === counter && current === 'page', `${shown} rows, counter ${counter}`)
    }

    // A project shows its own sessions.
    await reset()
    const project = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('.nav-project')].find((e) => Number(e.querySelector('.nav-count').textContent) >= 2)
      return { label: b.querySelector('.nav-text').textContent, count: Number(b.querySelector('.nav-count').textContent) }
    })()`)
    await clickEl(`[...document.querySelectorAll('.nav-project')].find((e) => e.querySelector('.nav-text').textContent === ${quote(project.label)})`, 'a project')
    await settle()
    check('project: shows its sessions and its name as the title', (await count('.row')) === project.count && (await text('.page-title')) === project.label, `${project.label}: ${project.count}`)

    // Search.
    await reset()
    await press('k', 2)
    await settle()
    check('search: Ctrl+K puts the cursor in the search box', await page.evaluate(`document.activeElement === document.querySelector('.search input')`))
    await page.send('Input.insertText', { text: 'VeryLongComponentName' })
    await settle()
    check('search: typing filters the list', (await count('.row')) === 1 && (await text('.row-title')).includes('VeryLongComponentName'), `${await count('.row')} rows`)
    await press('Escape')
    await settle()
    check('search: Escape clears it', (await page.evaluate(`document.querySelector('.search input').value`)) === '' && (await count('.row')) > 1)
    await page.evaluate(`document.activeElement.blur()`)
    await press('/')
    await settle()
    check('search: the / key puts the cursor in the search box', await page.evaluate(`document.activeElement === document.querySelector('.search input')`))
    await page.send('Input.insertText', { text: 'zzz-no-such-session' })
    await settle()
    check('search: no match shows the empty state with a clear button', (await has('.list-scroll .empty-state')) && (await has('.list-scroll .empty-state .btn')))
    await click('.list-scroll .empty-state .btn')
    await settle()
    check('search: the clear button brings the rows back', (await count('.row')) > 1)

    // Sorting and grouping.
    await reset()
    await setSelect('group', 'none')
    const orderBy = (field) => page.evaluate(`window.sessionManager.scanSessions().then((snap) => {
      const byId = new Map(snap.sessions.map((s) => [s.id, s]))
      return [...document.querySelectorAll('.row-main')].map((r) => byId.get(r.dataset.id)?.[${quote(field)}] ?? 0)
    })`)
    const monotonic = (values, dir) => values.every((v, i) => i === 0 || (dir > 0 ? v >= values[i - 1] : v <= values[i - 1]))
    await setSelect('sort', 'size-desc')
    await settle()
    check('sort: largest first', monotonic(await orderBy('totalSize'), -1))
    await setSelect('sort', 'size-asc')
    await settle()
    check('sort: smallest first', monotonic(await orderBy('totalSize'), 1))
    await setSelect('sort', 'updated-desc')
    await settle()
    check('sort: newest first', monotonic(await orderBy('updatedAt'), -1))
    await setSelect('group', 'project')
    await settle()
    check('group: by project shows group headings', (await count('.group-label')) >= 25)

    // Dropdowns: the app's own list, never the one Windows draws, and they work like a native one.
    await reset()
    const sortSel = selectEl('sort')
    const sortValue = () => page.evaluate(`${sortSel}.dataset.value`)
    const listShown = () => has('.select-menu')
    const onSort = () => page.evaluate(`document.activeElement === ${sortSel}`)
    const activeOption = () => page.evaluate(`[...document.querySelectorAll('.select-menu [role="option"]')].findIndex((o) => o.classList.contains('active'))`)
    check('dropdowns: none is a native one', (await count('select, datalist')) === 0 && (await count('.select')) === 2)
    const widthBefore = await page.evaluate(`${sortSel}.getBoundingClientRect().width`)
    await openSelect('sort')
    const opened = await page.evaluate(`(() => {
      const t = ${sortSel}.getBoundingClientRect()
      const m = document.querySelector('.select-menu').getBoundingClientRect()
      const options = [...document.querySelectorAll('.select-menu [role="option"]')]
      const on = options.filter((o) => o.getAttribute('aria-selected') === 'true')
      return {
        gap: Math.round(m.top - t.bottom), dx: Math.round(m.left - t.left), widths: [Math.round(t.width), Math.round(m.width)],
        under: m.top >= t.bottom && m.top - t.bottom < 10 && Math.abs(m.left - t.left) < 1 && m.width >= t.width - 0.5,
        inside: m.left >= 0 && m.top >= 0 && m.right <= innerWidth && m.bottom <= innerHeight,
        count: options.length,
        ticked: on.length === 1 && on[0].dataset.value === ${sortSel}.dataset.value && !!on[0].querySelector('svg') && on[0].classList.contains('active'),
        style: (() => { const c = getComputedStyle(document.querySelector('.select-menu')); return [c.backgroundColor, c.borderTopColor, c.borderTopLeftRadius, c.boxShadow].join(' | ') })()
      }
    })()`)
    check('dropdowns: the list opens right under it, at least as wide, inside the window', opened.under && opened.inside, JSON.stringify(opened))
    check('dropdowns: every choice is there, the current one ticked and highlighted', opened.count === 5 && opened.ticked)
    check('dropdowns: the focus stays on the dropdown', await onSort())
    await press('Escape')
    await openAccounts()
    const accountLook = await page.evaluate(`(() => { const c = getComputedStyle(document.querySelector('.account-menu')); return [c.backgroundColor, c.borderTopColor, c.borderTopLeftRadius, c.boxShadow].join(' | ') })()`)
    await press('Escape')
    check('dropdowns: the list looks like the other menus of the app', opened.style === accountLook, opened.style)
    await openSelect('sort')
    const hoverAt = await page.evaluate(`(() => { const r = document.querySelectorAll('.select-menu [role="option"]')[2].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverAt.x, y: hoverAt.y })
    await settle()
    check('dropdowns: the mouse highlights what it points at', (await activeOption()) === 2)
    await clickEl(optionEl('size-desc'), 'Largest first')
    await settle()
    check('dropdowns: a click chooses, closes and keeps the focus', (await sortValue()) === 'size-desc' && !(await listShown()) && (await onSort()))
    check('dropdowns: the width does not jump with the choice', Math.abs((await page.evaluate(`${sortSel}.getBoundingClientRect().width`)) - widthBefore) < 0.5)
    await press('ArrowDown')
    await settle()
    check('dropdowns: the arrow key opens it on the current choice', (await listShown()) && (await activeOption()) === 3)
    await press('ArrowDown')
    await press('ArrowDown')
    await settle()
    check('dropdowns: the arrow keys move and stop at the end', (await activeOption()) === 4)
    await press('Home')
    await settle()
    check('dropdowns: Home goes to the first', (await activeOption()) === 0)
    await press('Escape')
    await settle()
    check('dropdowns: Esc closes without changing anything', !(await listShown()) && (await sortValue()) === 'size-desc' && (await onSort()))
    await press('Enter')
    await press('End')
    await press('Enter')
    await settle()
    check('dropdowns: Enter opens, and Enter chooses', !(await listShown()) && (await sortValue()) === 'size-asc')
    const typed = await page.evaluate(`(() => {
      const fold = (t) => t.normalize('NFD').replace(/\\p{M}/gu, '').toLocaleLowerCase()
      const labels = [...${sortSel}.querySelectorAll('.select-value > span')].map((x) => x.textContent)
      const ch = fold(labels[2])[0]
      const from = labels.findIndex((_, i) => ${sortSel}.querySelectorAll('.select-value > span')[i].classList.contains('on'))
      const expected = labels.map((_, i) => (from + 1 + i) % labels.length).find((i) => fold(labels[i]).startsWith(ch))
      return { ch: labels[2][0], expected }
    })()`)
    await typeChar(typed.ch)
    await settle()
    check('dropdowns: typing a letter finds the choice that starts with it', (await listShown()) && (await activeOption()) === typed.expected, JSON.stringify(typed))
    await press('ArrowUp')
    await press('Tab')
    await settle()
    check('dropdowns: Tab leaves without changing anything', !(await listShown()) && (await sortValue()) === 'size-asc' && !(await onSort()))
    await openSelect('sort')
    await click('.page-title')
    await settle()
    check('dropdowns: a click elsewhere closes it without changing anything', !(await listShown()) && (await sortValue()) === 'size-asc')
    await openSelect('sort')
    await clickEl(sortSel, 'the sort dropdown again')
    await settle()
    check('dropdowns: a second click on it closes it', !(await listShown()))
    await openSelect('sort')
    const listTopBefore = await page.evaluate(`document.querySelector('.select-menu').getBoundingClientRect().top`)
    await page.evaluate(`document.querySelector('.list-scroll').scrollTop += 60`)
    await settle()
    check('dropdowns: scrolling the list below leaves it open, still under the dropdown', (await listShown()) && (await page.evaluate(`document.querySelector('.select-menu').getBoundingClientRect().top`)) === listTopBefore)
    await press('Escape')
    await setSelect('sort', 'updated-desc')

    // Keyboard in the list.
    await reset()
    await setSelect('group', 'none')
    await settle()
    const rowIds = await page.evaluate(`[...document.querySelectorAll('.row-main')].map((r) => r.dataset.id)`)
    await page.evaluate(`document.querySelector('.row-main').focus()`)
    await press('ArrowDown')
    await settle()
    const currentRow = () => page.evaluate(`document.querySelector('.row-main[aria-current="true"]')?.dataset.id`)
    check('keyboard: the down arrow selects the next row', (await currentRow()) === rowIds[1])
    await press('End')
    await settle()
    check('keyboard: End selects the last row', (await currentRow()) === rowIds.at(-1))
    await press('Home')
    await settle()
    check('keyboard: Home selects the first row', (await currentRow()) === rowIds[0])
    check('keyboard: focus follows the selection', await page.evaluate(`document.activeElement === document.querySelector('.row-main[aria-current="true"]')`))

    // Keyboard: every stop on the Tab path shows a focus ring.
    await reset()
    await page.evaluate(`document.activeElement?.blur?.()`)
    const noRing = new Set()
    for (let i = 0; i < 24; i++) {
      await press('Tab')
      const focus = await page.evaluate(`(() => {
        const el = document.activeElement
        if (!el || el === document.body) return null
        const s = getComputedStyle(el)
        const parent = el.closest('label, .switch, .segment')
        const ps = parent ? getComputedStyle(parent) : null
        const ring = (x) => !!x && ((x.outlineStyle !== 'none' && parseFloat(x.outlineWidth) > 0) || x.boxShadow !== 'none')
        return { name: el.tagName.toLowerCase() + '.' + el.className, ok: ring(s) || ring(ps) }
      })()`)
      if (focus && !focus.ok) noRing.add(focus.name)
    }
    check('keyboard: every focused control shows a focus ring', noRing.size === 0, [...noRing].join(', '))

    // Selecting rows for bulk actions.
    await reset()
    const visibleRows = await count('.row')
    await click('.list-columns .row-check')
    await page.waitFor(`document.querySelector('.bulk-bar')`, 'the bulk bar')
    check('selection: the header checkbox selects every visible row', (await count('.row .row-check:checked')) === visibleRows)
    await clickEl(`document.querySelector('.row .row-check')`, 'a row checkbox')
    await settle()
    check('selection: unchecking one makes the header checkbox "partly checked"', await page.evaluate(`document.querySelector('.list-columns .row-check').indeterminate`))
    await click('.bulk-bar .btn.quiet')
    await settle()
    check('selection: Clear removes the bulk bar', !(await has('.bulk-bar')) && (await count('.row .row-check:checked')) === 0)

    // Export menu (opened and closed; choosing a format opens a native dialog).
    await reset()
    await selectRow(roles.longEn)
    await click('.menu-trigger')
    await page.waitFor(`document.querySelector('.menu')`, 'the export menu')
    await settle()
    check('export menu: focus moves to its first item', await page.evaluate(`document.activeElement === document.querySelector('.menu [role=menuitem]')`))
    check(
      'export menu: opens right below its button, across the toolbar',
      await page.evaluate(`(() => {
        const menu = document.querySelector('.menu').getBoundingClientRect()
        const button = document.querySelector('.menu-trigger').getBoundingClientRect()
        const bar = document.querySelector('.inspector .actions').getBoundingClientRect()
        return menu.top >= button.bottom && menu.top - button.bottom <= 8 && Math.abs(menu.left - bar.left) <= 1 && Math.abs(menu.right - bar.right) <= 1
      })()`)
    )
    await press('ArrowDown')
    await settle()
    check('export menu: arrow keys move inside it', await page.evaluate(`document.activeElement === document.querySelectorAll('.menu [role=menuitem]')[1]`))
    await press('Escape')
    await settle()
    check('export menu: Escape closes it and returns focus', !(await has('.menu')) && (await page.evaluate(`document.activeElement === document.querySelector('.menu-trigger')`)))
    await click('.menu-trigger')
    await page.waitFor(`document.querySelector('.menu')`, 'the export menu')
    await click('.inspector-title')
    await settle()
    check('export menu: clicking outside closes it', !(await has('.menu')))
    // The open menu covers the bottom row: Tab must never land on a button behind it.
    await click('.menu-trigger')
    await page.waitFor(`document.querySelector('.menu')`, 'the export menu')
    await settle()
    let focusBehindMenu = false
    for (let i = 0; i < 5; i++) {
      await press('Tab')
      if (await page.evaluate(`!!document.querySelector('.menu') && !document.activeElement.closest('.menu-wrap')`)) focusBehindMenu = true
    }
    check('export menu: Tab closes it on the way out, so focus never lands behind it', !focusBehindMenu && !(await has('.menu')))

    // Details panel.
    await reset()
    await selectRow(roles.desktopActive[0])
    await click('details.raw-metadata summary')
    await page.waitFor(`document.querySelector('details.raw-metadata .code-block')`, 'the raw metadata')
    check('details: raw metadata opens and shows the file', (await text('details.raw-metadata .code-block')).includes('Desktop session 1'))

    // The panel shows the essentials; the rest waits behind "Technical details".
    await reset()
    await selectRow(roles.longEn)
    const panel = () =>
      page.evaluate(`(() => {
        const inspector = document.querySelector('.inspector')
        return {
          rows: [...inspector.querySelectorAll('section.inspector-section .kv dt')].length,
          note: !!inspector.querySelector('.notice.subtle'),
          technicalOpen: inspector.querySelector('details.technical').open,
          rawMetadata: !!inspector.querySelector('details.raw-metadata'),
          badgeHint: !!inspector.querySelector('.inspector-sub .badge-transcript-only')?.title,
          metrics: inspector.querySelectorAll('.metric').length,
          previewLines: [...inspector.querySelectorAll('.preview-text')].map((p) => Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight))),
          paths: [...inspector.querySelectorAll('details.technical .path-row')].length,
          copyId: !!inspector.querySelector('details.technical .copy-code'),
          text: inspector.textContent
        }
      })()`)
    const essentials = await panel()
    check('details: at most five rows until Technical details is opened', essentials.rows <= 5, `${essentials.rows} rows`)
    check('details: Technical details starts closed', !essentials.technicalOpen)
    check('details: a transcript-only session has no note box; the badge explains it on hover', !essentials.note && essentials.badgeHint)
    check('details: no raw metadata section without a metadata file', !essentials.rawMetadata)
    check('details: three activity numbers, messages of at most three lines', essentials.metrics === 3 && essentials.previewLines.length === 2 && essentials.previewLines.every((n) => n <= 3), essentials.previewLines.join(','))
    await openTechnical()
    const technical = await panel()
    check('details: Technical details has the session ID and the files that exist', technical.copyId && technical.paths >= 3, `${technical.paths} paths`)
    check('details: rows that only repeated something are gone', !/not present|Display title/i.test(technical.text))
    await reset()
    await selectRow(roles.longEn)
    const fullMessage = LONG_TITLE_EN + ' (step 1)'
    check('details: a long message starts cut, with a way to read all of it', (await has('.preview-label .link-btn')) && (await page.evaluate(`(() => { const p = document.querySelector('.preview-text'); return p.scrollHeight > p.clientHeight })()`)))
    await click('.preview-label .link-btn')
    await page.waitFor(`document.querySelector('.preview-text.expanded')`, 'the full message')
    await settle()
    check('details: opened, the whole message can be read', await page.evaluate(`(() => { const p = document.querySelector('.preview-text.expanded'); return p.textContent.split(${quote(fullMessage)}).length === 9 && p.clientHeight > 80 })()`))
    await click('.preview-label .link-btn')
    await page.waitFor(`!document.querySelector('.preview-text.expanded')`, 'the message to close')
    check('details: and it closes again', true)

    // Claude Desktop metadata: archive and restore, on the throw-away profile.
    await reset()
    await selectRow(roles.desktopActive[0])
    const metaFile = roles.metadataFiles[roles.desktopActive[0]]
    const isArchivedOnDisk = () => JSON.parse(readFileSync(metaFile, 'utf8')).isArchived
    if (isStore) {
      check('Store edition: no archive button for Desktop sessions', (await page.evaluate(`[...document.querySelectorAll('.inspector .actions .btn')].length`)) === 3)
      check('Store edition: delete is disabled for Desktop sessions', await page.evaluate(`document.querySelector('.inspector .actions .btn.danger').disabled`))
      check('Store edition: the read-only note is shown', await has('.inspector .notice.subtle'))
    } else if (await canChange()) {
      const archivedBefore = await page.evaluate(`Number(${filterEl('archived')}.querySelector('.nav-count').textContent)`)
      await clickEl(STATE_BUTTON, 'Archive')
      check('archive: writes to the metadata file at once', await until(() => isArchivedOnDisk() === true, 'the archived flag'))
      await page.waitFor(`document.querySelector('.toast')`, 'the archive confirmation')
      await sleep(400)
      await audit('toast-after-archive')
      await shot(`state-${channel}-message-after-archive`).catch(() => {})
      check('archive: the archived counter goes up', (await page.evaluate(`Number(${filterEl('archived')}.querySelector('.nav-count').textContent)`)) === archivedBefore + 1)
      await closeToasts()
      await selectRow(roles.desktopActive[0], 'archived')
      await clickEl(STATE_BUTTON, 'Restore')
      check('restore: writes to the metadata file at once', await until(() => isArchivedOnDisk() === false, 'the archived flag'))
      await page.waitFor(`document.querySelector('.toast')`, 'the restore confirmation')
      await closeToasts()
    } else skip('archive and restore', 'Claude Desktop is running')

    // Hide inside the manager (never touches Claude files).
    await reset()
    await selectRow(roles.disposable)
    const hiddenBefore = await page.evaluate(`Number(${filterEl('hidden')}.querySelector('.nav-count').textContent)`)
    await clickEl(STATE_BUTTON, 'Hide')
    await page.waitFor(`${filterEl('hidden')}.querySelector('.nav-count').textContent === ${quote(String(hiddenBefore + 1))}`, 'the hidden counter')
    check('hide: the session leaves the list', !(await page.evaluate(`!!${rowEl(roles.disposable)}`)))
    await closeToasts()
    await selectRow(roles.disposable, 'hidden')
    await clickEl(STATE_BUTTON, 'Show')
    await page.waitFor(`${filterEl('hidden')}.querySelector('.nav-count').textContent === ${quote(String(hiddenBefore))}`, 'the hidden counter')
    check('show: it comes back', true)
    await closeToasts()

    // A running session cannot be deleted.
    await reset()
    await selectRow(roles.live)
    check('running session: delete is disabled with a reason', (await page.evaluate(`document.querySelector('.inspector .actions .btn.danger').disabled`)) && (await has('.inspector .notice.warn')))

    // Settings → Usage: each account's limits as its tool recorded them (scripts/ui-test-profile.mjs, ui-test-codex.mjs).
    const usageOnScreen = () =>
      page.evaluate(`[...document.querySelectorAll('.usage-account')].map((a) =>
        [...a.querySelectorAll('.usage-meter')].map((m) => m.querySelector('.usage-window').textContent + ' ' + m.querySelector('.usage-percent').textContent + ' ' + m.querySelector('.usage-fill').classList[1]).join(', ') ||
        a.querySelector('.usage-empty').textContent)`)
    await reset()
    await goSettings()
    await page.waitFor(`document.querySelector('.usage-panel')`, 'the usage')
    const claudeUsage = await usageOnScreen()
    check(
      'usage: each Claude account shows its limits, in the colour of how close they are',
      JSON.stringify(claudeUsage) === JSON.stringify(['5 hours 42% normal, Week 81% warning', 'Week 100% critical', 'Claude Code has not recorded any usage yet.']),
      JSON.stringify(claudeUsage)
    )
    check('usage: it says when Claude Code recorded it', /^Recorded by Claude Code /.test(await text('.usage-account .usage-recorded')))
    const resetLine = await text('.usage-account .usage-reset')
    check('usage: each limit says the day and time it resets, and how long until then', /^Resets \w+day, \d{1,2}\/\d{1,2}\/\d{4}, \d{2}:\d{2} [AP]M · in \d+ (min|hr)\.$/.test(resetLine), resetLine)
    // Live: what Claude Code records while Settings is open shows up by itself.
    const configFile = path.join(home, '.claude.json')
    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    config.cachedUsageUtilization.utilization.limits[0].percent = 57
    config.cachedUsageUtilization.fetchedAtMs = Date.now()
    writeFileSync(configFile, JSON.stringify(config))
    const claudeLive = await page
      .waitFor(`document.querySelector('.usage-account .usage-percent')?.textContent === '57%'`, 'the new Claude usage', 20_000)
      .then(() => true, () => false)
    check('usage: what Claude Code records shows up by itself, within seconds', claudeLive && /just now|now|\d+ sec/.test(await text('.usage-account .usage-recorded')), await text('.usage-account .usage-recorded'))
    await goTool('codex')
    await goSettings()
    await page.waitFor(`document.querySelector('.usage-panel')`, 'the Codex usage')
    const codexUsage = await usageOnScreen()
    check('usage: Codex shows its five-hour and weekly limits, and an API key has none', JSON.stringify(codexUsage) === JSON.stringify(['5 hours 23% normal, Week 64% normal', 'API key: no plan limits.']), JSON.stringify(codexUsage))
    // Live: Codex answers again and records its usage at the end of the session file.
    const resetsSoon = Math.floor((Date.now() + 3_600_000) / 1000)
    appendFileSync(
      cxThread(cxRoles.recent).rollout_path,
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 31, window_minutes: 300, resets_at: resetsSoon }, secondary: { used_percent: 65, window_minutes: 10080, resets_at: resetsSoon + 200_000 } } } }) + '\n'
    )
    const codexLive = await page
      .waitFor(`document.querySelector('.usage-account .usage-percent')?.textContent === '31%'`, 'the new Codex usage', 20_000)
      .then(() => true, () => false)
    check('usage: what Codex records shows up by itself, within seconds', codexLive, JSON.stringify(await usageOnScreen()))

    // Settings.
    await reset()
    await goSettings()
    const settings = () => page.evaluate('window.sessionManager.getSettings()')
    const switches = `document.querySelectorAll('.switch input')`
    check('settings: paths, cache, debug and logs wait under Advanced, closed', (await count('.settings-advanced:not([open])')) === 1 && (await count('.settings-section .switch')) === 0)
    check('settings: the data folder is shown in one place', (await count('.settings-section .data-folders li')) >= 1)
    await openAdvanced()
    await clickEl(`${switches}[0].closest('.switch')`, 'the raw paths switch')
    await settle()
    check('settings: the raw paths switch is saved', (await settings()).showRawPaths === true)
    await clickEl(`${switches}[0].closest('.switch')`, 'the raw paths switch')
    await settle()
    await clickEl(`document.querySelector('.settings .segmented:not(:has([lang])) label:last-child')`, 'the reduced motion option')
    await settle()
    check('settings: the motion option applies', (await page.evaluate(`document.documentElement.dataset.motion`)) === 'reduced')
    await clickEl(`document.querySelector('.settings .segmented:not(:has([lang])) label:first-child')`, 'the system motion option')
    await settle()
    await clickEl(refreshOption(3), 'the interval option')
    await page.waitFor(`document.querySelector('.inline-field .select')`, 'the interval field')
    check('settings: the interval option shows its field and is saved', (await settings()).refreshMode === 'interval')
    await setSelect('refresh-interval', '300')
    await page.waitFor(`window.sessionManager.getSettings().then((s) => s.refreshIntervalSec === 300)`, 'the interval to be saved').catch(() => {})
    check('settings: the interval is chosen in the app\'s own dropdown and saved', (await settings()).refreshIntervalSec === 300)
    // In the smallest window, on a page that scrolls (Advanced is open): the list must open whole, and go when the page moves it.
    await setSize(allSizes[0])
    await page.evaluate(`document.querySelector('.page').scrollTop = 0; document.querySelector('.page').parentElement.scrollTop = 0`)
    await settle()
    await openSelect('refresh-interval')
    await settle()
    const low = await page.evaluate(`(() => { const m = document.querySelector('.select-menu'); const r = m?.getBoundingClientRect(); return r ? { side: m.dataset.side, inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth } : null })()`)
    check('settings: in the smallest window the interval list opens whole, even after scrolling to it', !!low?.inside, JSON.stringify(low))
    await page.evaluate(`(() => { let box = ${selectEl('refresh-interval')}.parentElement; while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement; box.scrollTop = box.scrollTop >= 40 ? box.scrollTop - 40 : box.scrollTop + 40 })()`)
    await settle()
    check('settings: scrolling the page closes the list', !(await has('.select-menu')))
    await setSize(allSizes[2])
    await clickEl(refreshOption(1), 'the manual option')
    await settle()
    check('settings: the manual option hides the field', !(await has('.inline-field .select')))
    await closeToasts()
    await clickEl(`document.querySelector('[data-action="clear-cache"]')`, 'Clear cache')
    await page.waitFor(`document.querySelector('.toast')`, 'the cache confirmation')
    check('settings: clearing the cache confirms it', true)
    await closeToasts()
    await clickEl(`document.querySelector('[data-action="show-logs"]')`, 'Show logs')
    await page.waitFor(`document.querySelector('.code-block.log')`, 'the log')
    check('settings: the log can be shown', (await text('.code-block.log')).length > 0)
    await clickEl(`${switches}[${(await count('.switch input')) - 1}].closest('.switch')`, 'the debug switch')
    await settle()
    check('settings: the debug switch is saved', (await settings()).debugMode === true)
    await selectRow(roles.longEn)
    check('settings: debug mode adds a section to the details panel', (await count('details.collapsible')) === 2)
    await goSettings()
    await openAdvanced()
    await clickEl(`${switches}[${(await count('.switch input')) - 1}].closest('.switch')`, 'the debug switch')
    await settle()
    check(isStore ? 'Store edition: the Deletion safety section is there' : 'no Deletion safety section without Safe Mode', (await has('.settings-section.safety')) === isStore)
    check('settings: language "use system" appears when a language is chosen', await has('.setting-control .link-btn'))

    // Storage.
    await reset()
    const sidebarTotal = await page.evaluate(`document.querySelector('.sidebar-bottom .nav-count').textContent`)
    await goStorage()
    check('storage: the total matches the sidebar', (await text('.hero-value')) === sidebarTotal, sidebarTotal)
    check('storage: lists projects and sessions', (await count('.ranked-row')) >= 2)
    const topProject = await page.evaluate(`document.querySelector('.ranked-name').textContent`)
    await click('.ranked-row')
    await page.waitFor(`document.querySelector('.list-pane')`, 'the project list')
    await settle()
    check('storage: clicking a project opens it', (await text('.page-title')) === topProject, topProject)

    // The integrated terminal: real shells, as in VS Code (the Store edition has none).
    if (isStore) {
      const support = await page.evaluate('window.terminal.info()')
      check('Store edition: no terminal, not even its item', !(await has('.terminal-toggle')) && !(await has('.terminal-panel')) && support.available === false)
      await reset()
      await selectRow(roles.longEn)
      check('Store edition: no "Continue in terminal" in the details', !(await has('.resume-btn')))
    } else {
      // From nothing: the layout pass left a terminal running.
      await reset()
      await showTerminal()
      while ((await count('.terminal-tab')) > 0) {
        await click('.terminal-tab.on .terminal-tab-close')
        await settle()
      }
      check('terminal: closing the last tab closes the panel, and the focus goes to its item', !(await terminalShown()) && (await page.evaluate(`document.activeElement === document.querySelector('.terminal-toggle')`)))
      check('terminal: the sidebar item shows its key', (await text('.terminal-toggle .nav-kbd')) === 'Ctrl+`')

      await pressBackquote()
      await waitForPrompt()
      const [first] = await terminalTabs()
      check('terminal: Ctrl+` opens a shell in the home folder', /^(pwsh|powershell|cmd) ~$/.test(first ?? ''), first)
      check('terminal: typing goes to the shell', await page.evaluate(`document.activeElement?.classList.contains('xterm-helper-textarea')`))
      await runInTerminal('echo clsm-ui-terminal-ok')
      // Twice: the command as typed, then what it printed.
      const ran = await page
        .waitFor(`(document.querySelector('.terminal-view.active .xterm-rows').textContent.match(/clsm-ui-terminal-ok/g) ?? []).length >= 2`, 'the command and its output', 20_000)
        .then(() => true, () => false)
      check('terminal: a command runs and prints its output', ran, (await terminalText()).replace(/\s+/g, ' ').slice(-120))
      await press('k', 2)
      check('terminal: Ctrl+K stays in the shell (it does not jump to the search box)', await page.evaluate(`document.activeElement?.classList.contains('xterm-helper-textarea')`))

      await click('.terminal-shell-trigger')
      await page.waitFor(`document.querySelector('.terminal-shell-menu')`, 'the list of shells')
      const shellNames = await page.evaluate(`[...document.querySelectorAll('.terminal-shell-item')].map((b) => b.textContent)`)
      check('terminal: the list offers the shells of this PC, Command Prompt among them', shellNames.includes('Command Prompt') && shellNames.length >= 2, shellNames.join(', '))
      await clickEl(`[...document.querySelectorAll('.terminal-shell-item')].find((b) => b.textContent === 'Command Prompt')`, 'Command Prompt in the list')
      await page.waitFor(`document.querySelectorAll('.terminal-tab').length === 2`, 'a second terminal')
      await waitForPrompt('the Command Prompt')
      check('terminal: a second shell opens in its own tab, on screen', (await activeTab()) === 'cmd')
      await page.evaluate(`document.querySelector('.terminal-tab.on .terminal-tab-main').focus()`)
      await press('ArrowLeft')
      check('terminal: the arrow keys move between the tabs', (await activeTab()) === (first ?? '').split(' ')[0])

      // From a Codex session: its project folder, with the shell chosen last ("+" remembers it).
      await goTool('codex')
      check('terminal: going to Codex keeps the terminals', (await count('.terminal-tab')) === 2 && (await terminalShown()))
      await selectRow(cxRoles.named)
      await pressBackquote(true)
      await page.waitFor(`document.querySelectorAll('.terminal-tab').length === 3`, 'a third terminal')
      await waitForPrompt('the Command Prompt in the project')
      await page.waitFor(`document.querySelector('.terminal-view.active .xterm-rows').textContent.includes('185>')`, 'the prompt in the project folder', 20_000).catch(() => {})
      check('terminal: Ctrl+Shift+` opens one in the project folder of the session on screen', (await terminalTabs())[2] === 'cmd 185' && (await terminalText()).includes(`${path.join('projects', '185')}>`), (await terminalTabs()).join(' | '))
      await runInTerminal('exit')
      await page.waitFor(`document.querySelectorAll('.terminal-tab').length === 2`, 'the tab to close', 15_000).catch(() => {})
      check('terminal: `exit` closes its tab', (await count('.terminal-tab')) === 2)

      await click(MAXIMIZE)
      await page.waitFor(`document.querySelector('.terminal-panel.maximized')`, 'the maximized panel')
      check('terminal: maximized, it takes the place of the page', !(await page.evaluate(`document.querySelector('.sessions-layout').checkVisibility()`)))
      await click(MAXIMIZE)
      await page.waitFor(`!document.querySelector('.terminal-panel.maximized')`, 'the panel to restore')
      const before = await page.evaluate(`document.querySelector('.terminal-panel').getBoundingClientRect().height`)
      await page.evaluate(`document.querySelector('.terminal-resizer').focus()`)
      await press('ArrowUp')
      await settle()
      const after = await page.evaluate(`document.querySelector('.terminal-panel').getBoundingClientRect().height`)
      check('terminal: the arrow keys on its edge change its height', Math.round(after - before) === 24, `${before} → ${after}`)

      await pressBackquote()
      await page.waitFor(`!document.querySelector('.terminal-panel:not([hidden])')`, 'the panel to hide')
      await pressBackquote()
      await waitForPrompt()
      // The focus goes back to the shell once the panel is drawn again (a frame later).
      const refocused = await page
        .waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`, 'the focus back in the shell', 5000)
        .then(() => true, () => false)
      check('terminal: Ctrl+` hides and shows it, its shells still there, with the focus', (await count('.terminal-tab')) === 2 && refocused)

      // "Continue in terminal": the session's resume command, typed in for the user to run, in its account.
      await reset()
      await selectAccount(2)
      await selectRow(roles.third[0])
      const tabsBefore = await count('.terminal-tab')
      await click('.resume-btn')
      await page.waitFor(`document.querySelectorAll('.terminal-tab').length === ${tabsBefore + 1}`, 'the terminal to resume in')
      const claudeCommand = `claude --resume ${roles.third[0]}`
      const typed = await page
        .waitFor(`document.querySelector('.terminal-view.active .xterm-rows').textContent.includes(${quote(claudeCommand)})`, 'the resume command', 20_000)
        .then(() => true, () => false)
      await sleep(1500)
      check('resume: the command is typed in, and left for the user to run', typed && (await terminalText()).trimEnd().endsWith(claudeCommand), (await terminalText()).replace(/\s+/g, ' ').slice(-120))
      // Not run: cancel it, and look at the account the shell was given.
      await press('c', 2)
      const shellName = await activeTab()
      await runInTerminal(shellName === 'cmd' ? 'echo %CLAUDE_CONFIG_DIR%' : shellName === 'bash' ? 'echo $CLAUDE_CONFIG_DIR' : 'echo $env:CLAUDE_CONFIG_DIR')
      const third = path.join(home, '.claude-accounts', 'third-account')
      const account = await page
        .waitFor(`document.querySelector('.terminal-view.active .xterm-rows').textContent.includes(${quote(third)})`, 'the account folder', 15_000)
        .then(() => true, () => false)
      check('resume: a session of another account resumes in that account (CLAUDE_CONFIG_DIR)', account, shellName)
      await reset()
      await selectRow(roles.metadataOnly, 'problems')
      check('resume: not offered for a session whose conversation is not on this PC', await page.evaluate(`document.querySelector('.resume-btn').disabled`))
      await reset()
      await selectRow(roles.live)
      check('resume: not offered for a session open right now', await page.evaluate(`document.querySelector('.resume-btn').disabled`))
      await goTool('codex')
      await selectRow(cxRoles.aiTitle)
      await click('.resume-btn')
      const codexCommand = `codex resume ${cxRoles.aiTitle}`
      const codexTyped = await page
        .waitFor(`document.querySelector('.terminal-view.active .xterm-rows').textContent.includes(${quote(codexCommand)})`, 'the Codex resume command', 20_000)
        .then(() => true, () => false)
      check('resume: a Codex session gets `codex resume <id>`, in its project folder', codexTyped && (await terminalTabs()).at(-1)?.endsWith(' OCR'), (await terminalTabs()).join(' | '))
      while ((await count('.terminal-tab')) > 0) {
        await click('.terminal-tab.on .terminal-tab-close')
        await settle()
      }
      await reset()
    }

    // The delete dialog (Claude Desktop, while it runs, keeps it closed).
    if (!(await canChange())) {
      skip('the delete dialog', 'Claude Desktop is running')
    } else {
      await reset()
      await selectRow(roles.longVi)
      await click('.inspector .actions .btn.danger')
      await page.waitFor(`document.querySelector('.plan-session')`, 'the delete plan')
      await settle()
      const keptInside = []
      for (let i = 0; i < 14; i++) {
        await press('Tab')
        keptInside.push(await page.evaluate(`!!document.activeElement.closest('.modal')`))
      }
      check('delete dialog: Tab stays inside it', keptInside.every(Boolean))
      const closeLook = await page.evaluate(`(() => {
        const head = document.querySelector('.modal-header')
        const size = (el) => Math.round(el.getBoundingClientRect().width)
        const close = head.querySelector('.modal-close')
        const title = head.querySelector(':scope > svg').getBoundingClientRect()
        const x = close.querySelector('svg').getBoundingClientRect()
        return { titleIcon: size(head.querySelector(':scope > svg')), closeIcon: size(close.querySelector('svg')), button: size(close), offset: Math.round((x.top + x.height / 2) - (title.top + title.height / 2)) }
      })()`)
      check('delete dialog: the close icon is as big as the title icon, level with it', closeLook.closeIcon === closeLook.titleIcon && closeLook.button >= 30 && Math.abs(closeLook.offset) <= 1, JSON.stringify(closeLook))
      check('delete dialog: the app behind it cannot be used', await page.evaluate(`document.getElementById('root').hasAttribute('inert')`))
      // A message can appear while a dialog is open (copying the plan, for one). It must leave the dialog's controls free.
      for (const size of [allSizes[0], allSizes[2]]) {
        await setSize(size)
        const under = await page.evaluate(`(() => {
          const message = document.createElement('div')
          message.className = 'toast toast-error'
          message.innerHTML = '<span class="toast-text">' + 'A long message shown while a dialog is open. '.repeat(3) + '</span>'
          document.querySelector('.toasts').append(message)
          const m = message.getBoundingClientRect()
          const under = [...document.querySelectorAll('.modal button, .modal input')].filter((b) => {
            const r = b.getBoundingClientRect()
            return r.left < m.right && m.left < r.right && r.top < m.bottom && m.top < r.bottom
          })
          message.remove()
          return under.map((b) => b.className)
        })()`)
        check(`delete dialog: a message leaves its controls free (${size.name} window)`, under.length === 0, under.join(', '))
      }
      await press('Escape')
      await page.waitFor(`!document.querySelector('.modal-backdrop')`, 'the dialog to close')
      await settle()
      check('delete dialog: Escape closes it and returns focus to the button', await page.evaluate(`document.activeElement === document.querySelector('.inspector .actions .btn.danger')`), await page.evaluate(`'focus is on ' + document.activeElement.tagName + '.' + document.activeElement.className`))
    }

    /** What the plan on screen deletes. Stops the run, before any delete, if it touches anything outside the throw-away folder. */
    const planPaths = async () => {
      const touched = await page.evaluate(`[...document.querySelectorAll('.plan-group:not(.keep) .plan-path')].map((el) => el.textContent)`)
      const outside = touched.filter((p) => !inSandbox(p))
      if (outside.length) throw new Error(`NOT IN THE THROW-AWAY FOLDER, stopping before the delete: ${outside[0]}`)
      return page.evaluate(`[...document.querySelectorAll('.plan-group.delete .plan-path')].map((el) => el.textContent)`)
    }
    const realButton = '.modal-footer .btn.danger.solid'
    const dryButton = '.modal-footer .btn.info.solid'
    const openDeleteFor = async (uuid, filter = 'all') => {
      await reset()
      await selectRow(uuid, filter)
      await click('.inspector .actions .btn.danger')
      await page.waitFor(`document.querySelector('.plan-session')`, 'the delete plan')
      await settle()
    }
    const closeResult = async () => {
      await click('.modal-footer .btn[data-autofocus]')
      await page.waitFor(`!document.querySelector('.modal-backdrop')`, 'the dialog to close')
      await closeToasts()
    }

    if (!(await canChange())) {
      skip('deleting', 'Claude Desktop is running')
    } else if (isStore) {
      // Store edition: Safe Mode on, a delete is only a rehearsal until it is armed.
      await openDeleteFor(roles.longVi)
      check('Store edition: the dialog shows the Safe Mode bar and a dry-run button', (await has('.mode-bar.safe')) && (await has(dryButton)))
      const planned = await planPaths()
      await setInput('.confirm-input', 'DELETE')
      await page.waitFor(`!document.querySelector(${quote(dryButton)}).disabled`, 'the dry-run button')
      await click(dryButton)
      await page.waitFor(`document.querySelector('.result-session')`, 'the dry-run result')
      await sleep(400)
      await audit('store-dry-run-result')
      check('Store edition: a dry run deletes nothing', planned.length > 0 && planned.every((p) => existsSync(p)), `${planned.length} paths`)
      await closeResult()

      await reset()
      await goSettings()
      await click('.settings-section.safety .btn.danger')
      await page.waitFor(`document.querySelector('.modal-backdrop')`, 'the arm dialog')
      await settle()
      await setInput('.confirm-input', 'ENABLE DELETE')
      await page.waitFor(`!document.querySelector('.modal-footer .btn.danger').disabled`, 'the arm button')
      await click('.modal-footer .btn.danger')
      await page.waitFor(`document.querySelector('.settings-section.safety .mode-chip.armed .mode-timer')`, 'the armed chip with its countdown')
      check('Store edition: arming starts the countdown', await has('.status-strip .mode-chip.armed'))
      await sleep(400)
      await audit('store-armed-settings')
      await shot(`state-${channel}-armed-settings`).catch(() => {})
      await reset()
      await selectRow(roles.longEn)
      await audit('store-armed-details')
      await click('.inspector .actions .btn.danger')
      await page.waitFor(`document.querySelector('.plan-session')`, 'the delete plan')
      await settle()
      await audit('store-armed-delete-dialog')
      await press('Escape')
      await page.waitFor(`!document.querySelector('.modal-backdrop')`, 'the dialog to close')
      await goSettings()
      await click('.safety-panel .row-actions .btn')
      await page.waitFor(`document.querySelector('.settings-section.safety .mode-chip.safe')`, 'Safe Mode again')
      check('Store edition: returning to Safe Mode works', true)
      await closeToasts()
    } else {
      // GitHub and development builds: no arming, the typed confirmation deletes for real.
      const safety = await page.evaluate('window.sessionManager.getSafetyMode()')
      check('no arming: the app starts with real deletion', safety.dryRun === false && safety.reason === 'no-arming')
      check('no arming: the status strip has no mode chip', !(await has('.mode-chip')))
      await openDeleteFor(roles.longVi)
      check('delete: no mode bar, the permanent-delete warning stays', !(await has('.mode-bar')) && (await has('.danger-box')))
      check('delete: the button starts disabled', await page.evaluate(`document.querySelector(${quote(realButton)}).disabled`))
      await click('.confirm-input')
      await page.send('Input.insertText', { text: 'delete' })
      await settle()
      check('delete: a wrong confirmation keeps it disabled', await page.evaluate(`document.querySelector(${quote(realButton)}).disabled`))
      await setInput('.confirm-input', 'DELETE')
      await page.waitFor(`!document.querySelector(${quote(realButton)}).disabled`, 'the delete button')
      const first = await planPaths()
      await click(realButton)
      await page.waitFor(`document.querySelector('.result-session')`, 'the delete result')
      check('delete: the files are really gone', first.length > 0 && first.every((p) => !existsSync(p)), `${first.length} paths`)
      await sleep(400)
      await audit('delete-result')
      await shot(`state-${channel}-delete-result`).catch(() => {})
      check('delete: focus moves to the Close button', await page.evaluate(`document.activeElement === document.querySelector('.modal-footer .btn[data-autofocus]')`))
      check('delete: the result starts at the top, with the outcome in view', (await page.evaluate(`document.querySelector('.modal-body').scrollTop`)) === 0)
      await closeResult()

      await openDeleteFor(roles.unbroken)
      await setInput('.confirm-input', 'DELETE')
      await page.waitFor(`!document.querySelector(${quote(realButton)}).disabled`, 'the delete button')
      const second = await planPaths()
      await click(realButton)
      await page.waitFor(`document.querySelector('.result-session')`, 'the second result')
      check('delete: a second one straight after also deletes, with no new step', second.length > 0 && second.every((p) => !existsSync(p)), `${second.length} paths`)
      await closeResult()

      await openDeleteFor(roles.inBoth)
      await setInput('.confirm-input', 'DELETE')
      await page.waitFor(`!document.querySelector(${quote(realButton)}).disabled`, 'the delete button')
      const inBoth = await planPaths()
      check('delete: a session used by two accounts lists its folder in each', inBoth.filter((p) => /session-env/.test(p)).length === 2, `${inBoth.length} paths`)
      await click(realButton)
      await page.waitFor(`document.querySelector('.result-session')`, 'the result')
      check('delete: and removes them all', inBoth.every((p) => !existsSync(p)))
      await closeResult()

      // The last screens: delete everything, one view at a time, to see the empty app.
      rmSync(roles.liveFile, { force: true })
      rmSync(roles.liveSecondFile, { force: true })
      await refreshSnapshot()
      await settle()
      let bulkPhraseOk = true
      let lastResultShown = false
      const eachView = tabs.flatMap((_, account) => ['all', 'archived', 'hidden', 'problems'].map((f) => [account, f]))
      for (const [account, f] of eachView) {
        await reset()
        await selectAccount(account)
        await clickEl(filterEl(f), `the ${f} filter`)
        await settle()
        if (!(await has('.row'))) continue
        await click('.list-columns .row-check')
        await page.waitFor(`document.querySelector('.bulk-bar')`, 'the bulk bar')
        const selected = await count('.row .row-check:checked')
        await click('.bulk-bar .btn.danger')
        if (await has('.result-session')) lastResultShown = true
        await page.waitFor(`document.querySelector('.confirm-input')`, 'the bulk delete plan', 60_000)
        await settle()
        const phrase = await page.evaluate(`document.querySelector('.confirm-input')?.placeholder`)
        if (phrase !== `DELETE ${selected}` && !(selected === 1 && phrase === 'DELETE')) bulkPhraseOk = false
        await planPaths()
        await setInput('.confirm-input', phrase)
        await page.waitFor(`!document.querySelector(${quote(realButton)}).disabled`, 'the bulk delete button')
        await click(realButton)
        await page.waitFor(`document.querySelector('.result-session')`, 'the bulk result', 60_000)
        await closeResult()
        await settle()
      }
      check('delete dialog: opening it again never shows the last result', !lastResultShown)
      check('bulk delete: asks for its own typed phrase', bulkPhraseOk)
      const left = (await refreshSnapshot()).sessions.length
      await settle()
      check('bulk delete: empties the throw-away profile', left === 0, `${left} left`)
      if (left === 0) {
        for (const l of LOCALES) {
          await setLocale(l)
          locale = l
          for (const size of SIZES) {
            sizeName = size.name
            await setSize(size)
            await clickEl(filterEl('all'))
            await settle()
            await audit('empty-list')
            if (size.name === 'default') await shot(`state-${channel}-empty-list-${l}`).catch(() => {})
            await goStorage()
            await settle()
            await audit('empty-storage')
            if (size.name === 'default') await shot(`state-${channel}-empty-storage-${l}`).catch(() => {})
            await goSettings()
            await settle()
            await audit('empty-settings')
          }
        }
        await clickEl(filterEl('all'))
        await settle()
        check('empty app: the list and the project list say so', (await has('.list-scroll .empty-state')) && (await has('.nav-empty')))
      }
    }

  } catch (err) {
    failure = err
    check(`${channel}: the run reached the end`, false, err.message)
    await Promise.race([shot(`error-${channel}`).catch(() => {}), sleep(5000)])
  }

  // Errors the page reported at any time, also when the run stopped early: they may be the reason.
  const seenErrors = new Set()
  for (const { method, params } of events) {
    let message = null
    if (method === 'Runtime.exceptionThrown') message = params.exceptionDetails.exception?.description ?? params.exceptionDetails.text
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') message = params.args.map((a) => a.value ?? a.description).join(' ')
    if (method === 'Log.entryAdded' && params.entry.level === 'error') message = params.entry.text
    if (message) seenErrors.add(message.slice(0, 300))
  }
  check(`${channel}: the page reported no errors during the run`, seenErrors.size === 0, [...seenErrors].slice(0, 5).join(' | '))

  await app.stop()
  runningChild = null
  await sleep(1500)
  if (!KEEP) await removeFolder(base)
  return failure
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function writeReport() {
  const list = [...findings.values()].sort((a, b) => (a.severity === b.severity ? a.rule.localeCompare(b.rule) : a.severity === 'error' ? -1 : 1))
  const errors = list.filter((f) => f.severity === 'error')
  const warnings = list.filter((f) => f.severity === 'warn')
  const failed = checks.filter((c) => !c.ok)
  const md = [
    '# UI test report',
    '',
    `Checks: ${checks.length - failed.length} passed, ${failed.length} failed. Layout findings: ${errors.length} errors, ${warnings.length} warnings.`,
    '',
    ...(failed.length ? ['## Failed checks', '', ...failed.map((c) => `- ${c.name}${c.extra ? ` — ${c.extra}` : ''}`), ''] : []),
    ...list.flatMap((f) => [`## ${f.severity === 'error' ? 'ERROR' : 'warning'} · ${f.rule} · \`${f.where}\``, '', `${f.detail}`, '', `Seen ${f.count} time(s), e.g. ${f.combos.join(', ')}${f.shot ? ` (screenshot ${f.shot}.png)` : ''}`, ''])
  ]
  writeFileSync(path.join(REPORT, 'report.md'), md.join('\n'))
  writeFileSync(path.join(REPORT, 'report.json'), JSON.stringify({ checks, findings: list }, null, 2))

  console.log(`\n--- Layout findings: ${errors.length} errors, ${warnings.length} warnings ---`)
  for (const f of list) console.log(`${f.severity === 'error' ? 'ERROR' : 'warn '} ${f.rule.padEnd(14)} ${f.where}\n        ${f.detail}  (${f.count}×, e.g. ${f.combos[0]})`)
  console.log(`\nChecks: ${checks.length - failed.length} passed, ${failed.length} failed.`)
  for (const c of failed) console.log(`  FAILED: ${c.name}${c.extra ? ` [${c.extra}]` : ''}`)
  console.log(`Report: ${path.join(REPORT, 'report.md')}`)
  return failed.length + errors.length
}

rmSync(REPORT, { recursive: true, force: true })
mkdirSync(REPORT, { recursive: true })
const watchdog = setTimeout(() => {
  console.log('The run took more than 40 minutes; stopping.')
  if (runningChild) killApp(runningChild)
  writeReport()
  process.exit(2)
}, 40 * 60_000)
for (const [i, channel] of CHANNELS.entries()) {
  if (i > 0) await sleep(30_000) // Launching again right away can hang while the graphics card is busy.
  try {
    await runVariant(channel)
  } catch (err) {
    check(`${channel}: the run could be prepared`, false, err.message)
  }
}
clearTimeout(watchdog)
process.exit(writeReport() ? 1 : 0)
