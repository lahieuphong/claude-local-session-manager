// Captures the Microsoft Store listing screenshots from the Store package's own
// binaries: dist/store/win-unpacked is the exact layout electron-builder packed
// into dist/store/*.appx (this script proves it by comparing CRC-32 values
// with the package before it starts).
//
// The packaged app runs unchanged, as the Store edition, against a synthetic
// profile written to disk by scripts/store-demo-data.mjs (real session files in
// a throw-away user folder). The profile folders are redirected with the usual
// environment variables, so no real Claude data is read. The script only clicks
// navigation, selection and the delete *preview*: nothing is deleted, exported
// or changed, and the app stays in Safe Mode.
//
// One set per listing language, exact 1920×1080 PNG (the window's content area
// rendered at 1920×1080 CSS px, scale 100%). No title bar, taskbar or cursor.
//
// Usage: yarn dist:store (once) → yarn store:screenshots [--locale vi-VN] [--out <dir>] [--home <dir>]
//   --home   the throw-away user folder (default <drive of this repo>:\Users\Demo,
//            which must not exist yet; it is removed afterwards)
//   --allow-claude-desktop-running   capture although Claude Desktop is running
//            (the app then shows its "delete is disabled" warning)
//   --software-rendering   let Chromium draw with the CPU (--disable-gpu), for a PC
//            whose graphics card is busy; the window content is the same
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { DEMO_MARKER, DEMO_SESSIONS, DEMO_UUID_RE, writeDemoProfile } from './store-demo-data.mjs'
import { readZipDirectory } from './store-inspect.mjs'
import { LISTING_ASSETS_DIR, LISTING_LOCALES, SCREENSHOT_SIZE, readPngHeader } from './store-listing-assets.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const OUT = path.resolve(arg('--out') ?? LISTING_ASSETS_DIR)
const only = arg('--locale')
const locales = Object.entries(LISTING_LOCALES).filter(([listing]) => !only || listing === only)
if (!locales.length) throw new Error(`Unknown --locale ${only}; use one of ${Object.keys(LISTING_LOCALES).join(', ')}`)
const allowDesktopRunning = process.argv.includes('--allow-claude-desktop-running')
/**
 * Chromium switches only, no app option: a DevTools port to drive the window, 100% scale,
 * and on request CPU rendering. They are recorded in the capture report.
 */
const LAUNCH_ARGS = ['--remote-debugging-port=0', '--force-device-scale-factor=1', ...(process.argv.includes('--software-rendering') ? ['--disable-gpu'] : [])]

/** The Store-facing product name the screenshots must show (STORE_APP_NAME in src/shared/appIdentity.ts). */
const STORE_NAME = 'LHP Local Session Manager'
/** The GitHub product name must not appear in a Store screenshot (Store policy 10.1.1). */
const FORBIDDEN_NAME = /claude local/i
const STORE_DIR = path.join(ROOT, 'dist', 'store')
const UNPACKED = path.join(STORE_DIR, 'win-unpacked')
const EXE = path.join(UNPACKED, `${STORE_NAME}.exe`)
/** Throw-away user profile for the capture: a real folder with a neutral path (shown in the screenshots). */
const HOME = path.resolve(arg('--home') ?? path.join(path.parse(ROOT).root, 'Users', 'Demo'))

/** The demo session of the details and delete-preview screenshots. */
const DETAIL_SESSION = 'Update dashboard layout'
/** The most recent demo session, selected on the overview screenshot. */
const OVERVIEW_SESSION = 'Refactor authentication flow'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Text that must never appear in a screenshot: this machine's user, home and checkout paths. */
const PRIVATE_TEXT = [os.homedir(), path.basename(os.homedir()), os.userInfo().username, ROOT, path.basename(path.dirname(ROOT))]
  .filter((s) => s && s.length >= 3)
  .map((s) => s.toLowerCase())
const ANY_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// ---------------------------------------------------------------------------
// The package under test
// ---------------------------------------------------------------------------

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

/**
 * dist/store/win-unpacked must be what is inside the .appx: every file of the
 * package's app\ folder is compared with win-unpacked by size and CRC-32, and
 * win-unpacked may hold nothing else. `yarn dist:store` leaves that folder next
 * to the package; the app\ folder of an unpacked package (`makeappx unpack`)
 * is the same thing. The manifest copy is checked against the package too.
 */
function verifyPackage() {
  if (!existsSync(EXE)) throw new Error(`Store build not found (${path.relative(ROOT, EXE)}). Run \`yarn dist:store\` first.`)
  const appxName = readdirSync(STORE_DIR).find((f) => f.endsWith('.appx'))
  if (!appxName) throw new Error('No .appx in dist/store. Run `yarn dist:store` first.')
  const appx = path.join(STORE_DIR, appxName)
  const directory = readZipDirectory(readFileSync(appx)).map((e) => ({ ...e, path: decodeURIComponent(e.name).replace(/\\/g, '/') }))
  const differs = (local, entry) => local.length !== entry.size || crc32(local) !== entry.crc32
  const unpacked = new Set(listFiles(UNPACKED).map((f) => path.relative(UNPACKED, f).split(path.sep).join('/').toLowerCase()))
  const files = {}
  let compared = 0
  for (const entry of directory.filter((e) => e.path.toLowerCase().startsWith('app/') && !e.path.endsWith('/'))) {
    const rel = entry.path.slice('app/'.length)
    const file = path.join(UNPACKED, rel)
    if (!existsSync(file) || differs(readFileSync(file), entry)) {
      throw new Error(`${rel} in win-unpacked differs from the one inside ${appxName}. Rebuild with \`yarn dist:store\`, or unpack the package again.`)
    }
    unpacked.delete(rel.toLowerCase())
    compared++
    if (/^(.*\.exe|resources\/app\.asar)$/i.test(rel)) files[entry.path] = { bytes: entry.size, crc32: entry.crc32.toString(16).padStart(8, '0') }
  }
  if (!files[`app/${STORE_NAME}.exe`] || !files['app/resources/app.asar']) throw new Error(`The app executable or app.asar is not in ${appxName}`)
  if (unpacked.size) throw new Error(`win-unpacked holds files that are not in ${appxName}: ${[...unpacked].slice(0, 5).join(', ')}`)
  const manifestBytes = readFileSync(path.join(STORE_DIR, 'AppxManifest.xml'))
  const manifestEntry = directory.find((e) => e.path === 'AppxManifest.xml')
  if (!manifestEntry || differs(manifestBytes, manifestEntry)) throw new Error(`dist/store/AppxManifest.xml is not the manifest inside ${appxName}`)
  const manifest = manifestBytes.toString('utf8')
  const version = /<Identity[^>]*\bVersion="([^"]+)"/.exec(manifest)?.[1]
  const capabilities = [...manifest.matchAll(/Capability Name="([^"]+)"/g)].map((m) => m[1])
  return { appx: appxName, sha256: sha256(appx), packageVersion: version, capabilities, appFilesCompared: compared, identicalFiles: files }
}

// ---------------------------------------------------------------------------
// The throw-away profile
// ---------------------------------------------------------------------------

const HOME_MARKER = path.join(HOME, '.lhp-store-screenshots')
let createdParent = false

/** A fresh synthetic profile; refuses to reuse a folder this script did not create. */
/** Remove a folder, waiting while the app that was just closed still releases its files. */
async function removeTree(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt >= 120) throw err
      await sleep(1000)
    }
  }
}

/** Every file under `dir` with its content hash: proof that a capture changed nothing in the profile. */
function treeDigest(dir) {
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else {
        files++
        bytes += statSync(full).size
        hash.update(path.relative(dir, full)).update(readFileSync(full))
      }
    }
  }
  walk(dir)
  return { files, bytes, sha256: hash.digest('hex') }
}

async function prepareHome(appLocale) {
  if (existsSync(HOME)) {
    if (!existsSync(HOME_MARKER)) throw new Error(`${HOME} already exists and was not created by this script. Use --home <new folder>.`)
    await removeTree(HOME)
  } else if (!existsSync(path.dirname(HOME))) {
    createdParent = true
  }
  mkdirSync(HOME, { recursive: true })
  writeFileSync(HOME_MARKER, 'Throw-away profile for scripts/store-screenshots.mjs. Safe to delete.\n')
  const profile = writeDemoProfile(HOME)
  // The language is the app's own saved setting, exactly as Settings → Language writes it.
  const userData = path.join(HOME, 'AppData', 'Roaming', STORE_NAME)
  mkdirSync(userData, { recursive: true })
  mkdirSync(path.join(HOME, 'AppData', 'Local'), { recursive: true })
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ language: appLocale }, null, 2))
  return profile
}

async function removeHome() {
  if (!existsSync(HOME_MARKER)) return
  await removeTree(HOME)
  if (createdParent) {
    try {
      rmdirSync(path.dirname(HOME)) // only succeeds when empty
    } catch {
      /* something else was put there meanwhile: leave it */
    }
  }
}

// ---------------------------------------------------------------------------
// Driving the app (Chrome DevTools Protocol, Node's built-in WebSocket)
// ---------------------------------------------------------------------------

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
  const waitFor = async (expression, what, timeoutMs = 30_000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(100)
    }
    throw new Error(`Timed out waiting for ${what}`)
  }
  return { send, evaluate, waitFor, close: () => ws.close() }
}

/** Start the packaged Store build with the profile folders pointing at the throw-away home. */
async function launch() {
  const env = {
    ...process.env,
    USERPROFILE: HOME,
    HOME,
    HOMEDRIVE: path.parse(HOME).root.replace(/\\$/, ''),
    HOMEPATH: HOME.slice(path.parse(HOME).root.length - 1),
    APPDATA: path.join(HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(HOME, 'AppData', 'Local')
  }
  for (const name of Object.keys(env)) {
    if (/^CLAUDE_SESSION_MANAGER_|^CLAUDE_CONFIG_DIR$|^ELECTRON_RUN_AS_NODE$/i.test(name)) delete env[name]
  }
  const child = spawn(EXE, LAUNCH_ARGS, { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const port = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('The app did not open a DevTools port')), 30_000)
    child.stderr.on('data', (d) => {
      text += d.toString()
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(text)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.on('exit', (code) => reject(new Error(`The app exited early (${code})`)))
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

/** Close the app as a user does (close its window); end the process only if it does not exit. */
async function quit(child, page) {
  const exited = new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)))
  page.evaluate('window.close()').catch(() => {}) // the reply never arrives: the page is gone
  await Promise.race([exited, sleep(20_000)])
  page.close()
  if (child.exitCode === null) {
    child.kill()
    await Promise.race([exited, sleep(5_000)])
  }
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
/** Set a React-controlled input (what typing does). */
const setValue = (element, value, event = 'input') => `(() => {
  const el = ${element}
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }))
})()`
const settle = (page) => page.evaluate('document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 1400)))')
/** Labels and buttons whose text is cut off without an ellipsis, or that leave the window. */
const CLIPPED = `(() => {
  const out = []
  for (const el of document.querySelectorAll('button, .btn, .nav-text, .badge, .mode-chip, .segment, .col-label, .metric-label, .page-title, .strip-text, .kv dt, .section-label, label, .plan-kind, .plan-action, .setting-label, .about-name, .identity-name, .identity-sub')) {
    if (!(el instanceof HTMLElement) || el.offsetParent === null) continue
    const style = getComputedStyle(el)
    if (el.scrollWidth > el.clientWidth + 1 && style.textOverflow !== 'ellipsis' && style.overflowX !== 'visible') out.push(el.textContent.trim().slice(0, 60))
    if (el.getBoundingClientRect().right > window.innerWidth + 1) out.push('off-screen: ' + el.textContent.trim().slice(0, 60))
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push('page scrolls horizontally')
  return [...new Set(out)]
})()`

/** Everything rendered as text (incl. dialogs and attributes such as titles) must be demo data. */
async function assertCleanScreen(page, name) {
  const text = await page.evaluate(
    `document.body.innerText + '\\n' + [...document.querySelectorAll('[title],[placeholder],[aria-label]')].map((e) => [e.title, e.placeholder, e.getAttribute('aria-label')].join(' ')).join('\\n')`
  )
  const lower = text.toLowerCase()
  const leaked = PRIVATE_TEXT.filter((s) => lower.includes(s))
  const ids = [...new Set(text.match(ANY_UUID) ?? [])].filter((id) => !DEMO_UUID_RE.test(id))
  if (leaked.length || ids.length) throw new Error(`${name}: private data on screen (${[...leaked, ...ids].join(', ')}); not saved`)
  if (FORBIDDEN_NAME.test(text)) throw new Error(`${name}: the GitHub product name is on screen; not saved`)
  const clipped = await page.evaluate(CLIPPED)
  if (clipped.length) throw new Error(`${name}: clipped or overflowing text (${clipped.join(' | ')}); not saved`)
}

async function capture(page, file, audit) {
  await settle(page)
  await assertCleanScreen(page, path.basename(file))
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true })
  const png = Buffer.from(data, 'base64')
  const header = readPngHeader(png)
  if (!header || header.width !== SCREENSHOT_SIZE.width || header.height !== SCREENSHOT_SIZE.height) {
    throw new Error(`${path.basename(file)}: captured ${header?.width}x${header?.height}, expected ${SCREENSHOT_SIZE.width}x${SCREENSHOT_SIZE.height}`)
  }
  writeFileSync(file, png)
  audit.files.push({ file: path.relative(OUT, file).split(path.sep).join('/'), width: header.width, height: header.height, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') })
  console.log(`  ${path.relative(ROOT, file)}  ${header.width}x${header.height}`)
}

/** Choose the UI language in Settings → Language, as a user does (it applies immediately), then show the full session list. */
async function showLanguage(page, appLocale) {
  const viaSettings = (await page.evaluate('document.documentElement.lang')) !== appLocale
  if (viaSettings) {
    const option = `document.querySelector('.segment[lang=${JSON.stringify(appLocale)}] input')`
    await page.evaluate(`document.querySelectorAll('.sidebar-bottom .nav-item')[1].click()`)
    await page.waitFor(option, 'the language setting')
    await page.evaluate(`${option}.click()`)
    await page.waitFor(`document.documentElement.lang === ${JSON.stringify(appLocale)}`, `the ${appLocale} interface`)
  }
  await page.evaluate(`document.querySelector('.nav .nav-item').click()`)
  await page.waitFor(`document.querySelectorAll('.row').length === ${DEMO_SESSIONS.length}`, 'the session list')
  await choose(page, 'group', 'date')
  await page.waitFor(`document.querySelectorAll('.group').length > 1 && document.querySelector('.group-name')?.textContent !== 'DemoWebApp'`, 'date grouping')
  return viaSettings ? 'Settings → Language' : 'saved language setting at launch'
}

/** Choose in one of the app's dropdowns (components/Select.tsx), as a click would. */
async function choose(page, name, value) {
  const trigger = `document.querySelector('.select[data-name=${JSON.stringify(name)}]')`
  if ((await page.evaluate(`${trigger}.dataset.value`)) === value) return
  await page.evaluate(`${trigger}.click()`)
  const option = `document.querySelector('.select-menu [role=option][data-value=${JSON.stringify(value)}]')`
  await page.waitFor(option, `the ${name} list`)
  await page.evaluate(`${option}.click()`)
  await page.waitFor(`${trigger}.dataset.value === ${JSON.stringify(value)} && !document.querySelector('.select-menu')`, `${name}: ${value}`)
}

/** The four screenshots of one language, in the running app. */
async function shoot(page, listingLocale, appLocale, claudeHome, audit) {
  const outDir = path.join(OUT, listingLocale)
  mkdirSync(outDir, { recursive: true })
  audit.languageChosenBy = await showLanguage(page, appLocale)
  const lang = await page.evaluate('document.documentElement.lang')
  if (lang !== appLocale) throw new Error(`UI language is ${lang}, expected ${appLocale}`)

  // 1. Session overview: all sessions grouped by date, search, filters and projects; the newest session selected.
  await page.evaluate(`${rowByTitle(OVERVIEW_SESSION)}.querySelector('.row-main').click()`)
  await page.waitFor(`document.querySelector('.inspector-title')?.textContent.includes(${JSON.stringify(OVERVIEW_SESSION)})`, 'the inspector')
  await capture(page, path.join(outDir, '01-sessions.png'), audit)

  // 2. Session details: grouped by project, one session, with Technical details open so the
  //    picture shows what its caption promises: project, session ID, model, sizes and files.
  await choose(page, 'group', 'project')
  await page.waitFor(`document.querySelector('.group-name')?.textContent === 'DemoWebApp'`, 'project grouping')
  await page.evaluate(`${rowByTitle(DETAIL_SESSION)}.querySelector('.row-main').click()`)
  await page.waitFor(`document.querySelector('.inspector-title')?.textContent.includes(${JSON.stringify(DETAIL_SESSION)})`, 'the selected session')
  await page.evaluate(`document.querySelector('details.technical').open = true`)
  await page.evaluate(scrollToTop(`document.querySelectorAll('.inspector-section')[0]`, 20))
  await capture(page, path.join(outDir, '02-session-details.png'), audit)

  // 3. Safe deletion preview of that transcript-only session: the app's own plan dialog in Safe Mode
  //    (dry run), with the confirmation typed. The dialog is closed with Cancel: nothing is executed.
  await page.evaluate(scrollToTop(`document.querySelector('.inspector-header')`, 0))
  const deleteButton = `document.querySelector('.inspector .actions .btn.danger')`
  if (await page.evaluate(`${deleteButton}.disabled`)) {
    // Claude Desktop is running (--allow-claude-desktop-running): the bulk bar still opens the (blocked) preview.
    await page.evaluate(`document.querySelector('.row.selected .row-check').click()`)
    await page.evaluate(`document.querySelector('.bulk-bar .btn.danger').click()`)
  } else {
    await page.evaluate(`${deleteButton}.click()`)
  }
  await page.waitFor(`document.querySelector('.plan-session')`, 'the delete plan')
  const plan = await page.evaluate(`document.querySelector('.modal-body').innerText`)
  if (/deleted_|local_|archived-sessions\.idx|claude-code-sessions/i.test(plan)) throw new Error('The delete plan touches Claude Desktop metadata; not a Store-supported scenario')
  // The plan is the app's own (its delete service built it from the files on disk): every Claude
  // path it would delete exists in the synthetic profile. They are checked again after the dialog is cancelled.
  const planPaths = (await page.evaluate(`[...document.querySelectorAll('.plan-group:not(.keep) .plan-path')].map((el) => el.textContent)`)).filter((p) =>
    p.toLowerCase().startsWith(claudeHome.toLowerCase() + path.sep)
  )
  if (planPaths.length < 4 || !planPaths.every((p) => existsSync(p))) throw new Error('The delete plan does not list existing files of the synthetic profile')
  audit.deletePlan = { summary: (await page.evaluate(`document.querySelector('.modal')?.innerText ?? ''`)).split('\n').slice(0, 3).join(' | '), claudePathsListed: planPaths.length }
  await page.evaluate(setValue(`document.querySelector('.confirm-input')`, (await page.evaluate(`document.querySelector('.confirm-input').placeholder`)) || 'DELETE'))
  await page.evaluate(`document.activeElement?.blur()`)
  await page.evaluate(`document.querySelector('.modal-body').scrollTop = 0`)
  await page.waitFor(`!document.querySelector('.modal-footer .btn.info.solid').disabled`, 'the dry-run button')
  await capture(page, path.join(outDir, '03-delete-plan.png'), audit)
  await page.evaluate(`document.querySelector('.modal-footer .btn.quiet:not(.caps)').click()`)
  await page.waitFor(`!document.querySelector('.plan-session')`, 'the dialog to close')
  audit.deletePlan.closedWith = 'Cancel'
  audit.deletePlan.pathsStillExist = planPaths.every((p) => existsSync(p))
  if (!audit.deletePlan.pathsStillExist) throw new Error('A file of the previewed delete plan is gone')

  // 4. Settings and safety: one scroll position, from Deletion safety down (Safe Mode, Store updates, version, limits).
  await page.evaluate(`document.querySelectorAll('.sidebar-bottom .nav-item')[1].click()`)
  await page.waitFor(`document.querySelector('.settings-section.safety')`, 'the settings page')
  await page.evaluate(scrollToTop(`document.querySelector('.settings-section.safety')`, 24))
  await capture(page, path.join(outDir, '04-settings.png'), audit)

  // Nothing was deleted or changed in the synthetic profile.
  const after = await page.evaluate('window.sessionManager.refreshSessions()')
  if (after.sessions.length !== DEMO_SESSIONS.length) throw new Error('The demo profile changed during the capture')
  audit.sessionsAfterCapture = after.sessions.length
  audit.safeModeAfterCapture = (await page.evaluate('window.sessionManager.getSafetyMode()')).dryRun
  if (audit.safeModeAfterCapture !== true) throw new Error('The app left Safe Mode during the capture')
}

/**
 * One run of the app for all languages: the language is switched in Settings,
 * as a user does, so the app is started (and closed) only once.
 */
async function captureAll(pkg, report) {
  const profile = await prepareHome(locales[0][1])
  const claudeHome = path.join(HOME, '.claude')
  const before = treeDigest(claudeHome)
  const { child, page } = await launch()
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { ...SCREENSHOT_SIZE, deviceScaleFactor: 1, mobile: false })
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    // Every start shows the choice of tool first; the screenshots are of Claude sessions.
    await page.waitFor(`document.querySelector('.picker-card.claude')`, 'the choice of tool')
    await page.evaluate(`document.querySelector('.picker-card.claude').click()`)
    await page.waitFor(`document.querySelectorAll('.row').length === ${DEMO_SESSIONS.length}`, 'the demo sessions in the list (is the PC or its graphics card busy? try --software-rendering)')

    // Guards: the packaged Store edition, scanning only the throw-away profile.
    const info = await page.evaluate('window.sessionManager.getAppInfo()')
    const snapshot = await page.evaluate('window.sessionManager.scanSessions()')
    const processes = await page.evaluate('window.sessionManager.getClaudeProcessStatus(true)')
    const safety = await page.evaluate('window.sessionManager.getSafetyMode()')
    const inHome = (p) => typeof p === 'string' && p.toLowerCase().startsWith(HOME.toLowerCase() + path.sep)
    if (!info.isPackaged || info.distribution !== 'store' || info.name !== STORE_NAME || info.desktopDataReadOnly !== true) {
      throw new Error('This is not the packaged Microsoft Store edition; aborting')
    }
    if (`${info.version}.0` !== pkg.packageVersion) throw new Error(`App version ${info.version} does not match package ${pkg.packageVersion}`)
    if (info.userHome.toLowerCase() !== HOME.toLowerCase() || !inHome(snapshot.roots.claudeHome) || !inHome(info.userDataPath)) {
      throw new Error('The app is not confined to the throw-away profile; aborting')
    }
    if (snapshot.sessions.length !== DEMO_SESSIONS.length || snapshot.sessions.some((s) => s.kind !== 'cli' || !DEMO_UUID_RE.test(s.cliSessionId ?? ''))) {
      throw new Error('The session list is not exactly the synthetic demo sessions; aborting')
    }
    if (safety.dryRun !== true) throw new Error('The app is not in Safe Mode; aborting')
    if (processes.desktopRunning && !allowDesktopRunning) {
      throw new Error(
        'Claude Desktop is running on this PC. The app then (correctly) disables deletion and shows a warning, which is not the state these screenshots document.\n' +
          'Close Claude Desktop (also from the system tray) and run again, or pass --allow-claude-desktop-running.'
      )
    }
    await page.waitFor(`document.querySelector('.identity-name')?.textContent === 'LHP Local'`, 'the Store product name in the sidebar')
    if ((await page.evaluate('window.devicePixelRatio')) !== 1) throw new Error('Device pixel ratio is not 1')
    const run = {
      profile: { home: HOME, sessions: profile.sessions, files: profile.files },
      app: { name: info.name, version: info.version, isPackaged: info.isPackaged, distribution: info.distribution, desktopDataReadOnly: info.desktopDataReadOnly },
      nativeWindowTitle: execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).MainWindowTitle`]).toString().trim(),
      safeMode: safety.dryRun,
      claudeDesktopRunning: processes.desktopRunning,
      sessionKinds: [...new Set(snapshot.sessions.map((s) => s.status))]
    }

    for (const [listingLocale, appLocale] of locales) {
      console.log(`${listingLocale} (UI: ${appLocale})`)
      const audit = { listingLocale, uiLocale: appLocale, ...run, files: [] }
      await shoot(page, listingLocale, appLocale, claudeHome, audit)
      report.locales.push(audit)
    }
  } finally {
    await quit(child, page)
  }
  // Byte for byte the profile that was written before the app started: nothing was deleted or changed.
  const digestAfter = treeDigest(claudeHome)
  report.profileUnchanged = digestAfter.sha256 === before.sha256 && digestAfter.files === before.files
  report.profileDigest = digestAfter
  if (!report.profileUnchanged) throw new Error('The synthetic profile changed during the capture')
}

const pkg = verifyPackage()
console.log(`Package: ${pkg.appx}  version ${pkg.packageVersion}  capabilities ${pkg.capabilities.join(', ')}`)
console.log(`SHA-256: ${pkg.sha256}`)
console.log(`win-unpacked is identical to the app folder inside the package (${pkg.appFilesCompared} files, including ${Object.keys(pkg.identicalFiles).join(" and ")})`)
console.log(`Throw-away profile: ${HOME}\n`)
const report = { capturedAt: new Date().toISOString(), package: pkg, launchArgs: LAUNCH_ARGS, locales: [] }
try {
  await captureAll(pkg, report)
  // Evidence for the certification audit (not a listing asset; dist/ is not committed).
  writeFileSync(path.join(STORE_DIR, 'screenshot-capture-report.json'), JSON.stringify(report, null, 2))
  console.log(`\nCapture report: ${path.relative(ROOT, path.join(STORE_DIR, 'screenshot-capture-report.json'))}`)
} finally {
  await removeHome()
}
if (existsSync(path.join(HOME, '.claude', DEMO_MARKER))) console.warn(`Could not remove ${HOME}; delete it by hand.`)
