// Captures the Microsoft Store listing screenshots from the real UI, one set
// per listing language, as exact 1920×1080 PNGs (DPI-independent: the page is
// rendered at 1920×1080 CSS px with a device scale factor of 1).
//
// The app runs unpackaged in Store screenshot mode (src/main/screenshot/):
// static demo data only — no Claude data, process, settings or log is read or
// written, deletion stays in Safe Mode. Nothing is clicked that changes data.
//
// Usage: yarn build && yarn store:screenshots [--locale vi-VN] [--out <dir>]
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LISTING_ASSETS_DIR, LISTING_LOCALES, SCREENSHOT_SIZE, readPngHeader } from './store-listing-assets.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = createRequire(import.meta.url)('electron')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const OUT = path.resolve(arg('--out') ?? LISTING_ASSETS_DIR)
const only = arg('--locale')
const locales = Object.entries(LISTING_LOCALES).filter(([listing]) => !only || listing === only)
if (!locales.length) throw new Error(`Unknown --locale ${only}; use one of ${Object.keys(LISTING_LOCALES).join(', ')}`)

/** The demo session used for the details and delete-plan screenshots (a Claude Code session in C:\Projects\DemoWebApp). */
const DETAIL_SESSION = 'Update dashboard layout'
/** Selected on the first screenshot: a session open in a running Claude Code process. */
const BROWSER_SESSION = 'Refactor authentication flow'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Text that must never appear in a screenshot: this machine's user, home and checkout paths. */
const PRIVATE_TEXT = [os.homedir(), path.basename(os.homedir()), os.userInfo().username, ROOT, path.basename(path.dirname(ROOT))]
  .filter((s) => s && s.length >= 3)
  .map((s) => s.toLowerCase())
/** The only session-like IDs allowed on screen: the fixture's synthetic series. */
const DEMO_UUID = /^a1b2c3d4-0000-4000-[89ab]000-\d{12}$/
const ANY_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Everything rendered as text (incl. dialogs and attributes such as titles) must be demo data. */
async function assertNoPrivateData(page, name) {
  const text = await page.evaluate(
    `document.body.innerText + '\\n' + [...document.querySelectorAll('[title],[placeholder],[aria-label]')].map((e) => [e.title, e.placeholder, e.getAttribute('aria-label')].join(' ')).join('\\n')`
  )
  const lower = text.toLowerCase()
  const leaked = PRIVATE_TEXT.filter((s) => lower.includes(s))
  const ids = [...new Set(text.match(ANY_UUID) ?? [])].filter((id) => !DEMO_UUID.test(id))
  if (leaked.length || ids.length) throw new Error(`${name}: private data on screen (${[...leaked, ...ids].join(', ')}); not saved`)
}

/** Minimal Chrome DevTools Protocol client (Node's built-in WebSocket). */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`Cannot connect to ${wsUrl}`))
  })
  let next = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data)
    const p = m.id !== undefined && pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.error) p.reject(new Error(`${m.error.message} (${m.error.code})`))
    else p.resolve(m.result)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`Page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  const waitFor = async (expression, what, timeoutMs = 20_000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(100)
    }
    throw new Error(`Timed out waiting for ${what}`)
  }
  return { send, evaluate, waitFor, close: () => ws.close() }
}

/** Start the app in screenshot mode and return the DevTools page target. */
async function launch(appLocale, userData) {
  const env = {
    ...process.env,
    CLAUDE_SESSION_MANAGER_SCREENSHOT_MODE: 'true',
    CLAUDE_SESSION_MANAGER_SCREENSHOT_LOCALE: appLocale,
    CLAUDE_SESSION_MANAGER_USER_DATA: userData
  }
  for (const name of [
    'ELECTRON_RUN_AS_NODE',
    'CLAUDE_SESSION_MANAGER_DRY_RUN',
    'CLAUDE_SESSION_MANAGER_DEV_ALLOW_ENV_ARM',
    'CLAUDE_SESSION_MANAGER_DEV_FAKE_UPDATE',
    'CLAUDE_SESSION_MANAGER_DISTRIBUTION'
  ]) {
    delete env[name]
  }
  const child = spawn(electronPath, [ROOT, '--remote-debugging-port=0', '--force-device-scale-factor=1'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const port = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('Electron did not open a DevTools port')), 30_000)
    child.stderr.on('data', (d) => {
      text += d.toString()
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(text)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.on('exit', (code) => reject(new Error(`Electron exited early (${code})`)))
  })
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])
    const page = targets.find((t) => t.type === 'page' && t.url.startsWith('file:'))
    if (page) return { child, page: await connect(page.webSocketDebuggerUrl) }
    await sleep(200)
  }
  child.kill()
  throw new Error('The app window did not load')
}

// In-page helpers (strings evaluated in the renderer).
const rowByTitle = (title) => `[...document.querySelectorAll('.row')].find((r) => r.textContent.includes(${JSON.stringify(title)}))`
/** Scroll the element's scroll container so the element starts `offset` px below the container's top. */
const scrollToTop = (element, offset = 16) => `(() => {
  const el = ${element}
  let box = el.parentElement
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement
  if (box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - ${offset}
})()`
/** Set a React-controlled input or select. */
const setValue = (element, value, event = 'input') => `(() => {
  const el = ${element}
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }))
})()`
const settle = (page) => page.evaluate('document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 1400)))')

async function capture(page, file) {
  await settle(page)
  await assertNoPrivateData(page, path.basename(file))
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true })
  const png = Buffer.from(data, 'base64')
  const header = readPngHeader(png)
  if (!header || header.width !== SCREENSHOT_SIZE.width || header.height !== SCREENSHOT_SIZE.height) {
    throw new Error(`${path.basename(file)}: captured ${header?.width}x${header?.height}, expected ${SCREENSHOT_SIZE.width}x${SCREENSHOT_SIZE.height}`)
  }
  writeFileSync(file, png)
  console.log(`  ${path.relative(ROOT, file)}  ${header.width}x${header.height}`)
}

async function shoot(listingLocale, appLocale) {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'clsm-store-shots-'))
  const outDir = path.join(OUT, listingLocale)
  mkdirSync(outDir, { recursive: true })
  const { child, page } = await launch(appLocale, userData)
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { ...SCREENSHOT_SIZE, deviceScaleFactor: 1, mobile: false })
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await page.waitFor(`document.querySelectorAll('.row').length > 0`, 'the session list')

    // Guard: this must be screenshot mode on demo data, in the requested language.
    const info = await page.evaluate('window.sessionManager.getAppInfo()')
    if (info.userHome !== 'C:\\Users\\Demo' || info.distribution !== 'store') throw new Error('Not running in Store screenshot mode; aborting')
    const lang = await page.evaluate('document.documentElement.lang')
    if (lang !== appLocale) throw new Error(`UI language is ${lang}, expected ${appLocale}`)
    const dpr = await page.evaluate('window.devicePixelRatio')
    if (dpr !== 1) throw new Error(`Device pixel ratio ${dpr}, expected 1`)

    // 1. Session browser: All sessions, grouped by date, a running session selected.
    await page.evaluate(`${rowByTitle(BROWSER_SESSION)}.querySelector('.row-main').click()`)
    await page.waitFor(`document.querySelector('.inspector-title')`, 'the inspector')
    await capture(page, path.join(outDir, '01-sessions.png'))

    // 2. Session details: grouped by project, a Claude Code session, the inspector at its IDs, sizes, files and activity.
    await page.evaluate(setValue(`[...document.querySelectorAll('select.select')].find((s) => [...s.options].some((o) => o.value === 'project'))`, 'project', 'change'))
    await page.waitFor(`document.querySelector('.group-name')?.textContent === 'DemoWebApp'`, 'project grouping')
    await page.evaluate(`${rowByTitle(DETAIL_SESSION)}.querySelector('.row-main').click()`)
    await page.waitFor(`document.querySelector('.inspector-title')?.textContent.includes(${JSON.stringify(DETAIL_SESSION)})`, 'the selected session')
    await page.evaluate(scrollToTop(`document.querySelectorAll('.inspector-section')[2]`, 20))
    await capture(page, path.join(outDir, '02-session-details.png'))

    // 3. Delete plan in Safe Mode: the dry-run dialog with the confirmation typed. Nothing is executed.
    await page.evaluate(`document.querySelector('.inspector .actions .btn.danger').click()`)
    await page.waitFor(`document.querySelector('.plan-session')`, 'the delete plan')
    await page.evaluate(setValue(`document.querySelector('.confirm-input')`, 'DELETE'))
    await page.evaluate(`document.activeElement?.blur()`)
    await page.evaluate(`document.querySelector('.modal-body').scrollTop = 0`)
    await page.waitFor(`!document.querySelector('.modal-footer .btn.info.solid').disabled`, 'the dry-run button')
    await capture(page, path.join(outDir, '03-delete-plan.png'))
    await page.evaluate(`document.querySelector('.modal-footer .btn.quiet:not(.caps)').click()`)
    await page.waitFor(`!document.querySelector('.plan-session')`, 'the dialog to close')

    // 4. Settings: deletion safety (Safe Mode), Microsoft Store updates, version and distribution.
    await page.evaluate(`document.querySelectorAll('.sidebar-bottom .nav-item')[1].click()`)
    await page.waitFor(`document.querySelector('.settings-section.safety')`, 'the settings page')
    await page.evaluate(scrollToTop(`document.querySelector('.settings-section.safety')`, 24))
    await capture(page, path.join(outDir, '04-settings.png'))
  } finally {
    page.close()
    child.kill()
    await sleep(500)
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

for (const [listingLocale, appLocale] of locales) {
  console.log(`${listingLocale} (UI: ${appLocale})`)
  await shoot(listingLocale, appLocale)
}
