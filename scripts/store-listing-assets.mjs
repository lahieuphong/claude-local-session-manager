// Microsoft Store listing assets (store/listing-assets/): the expected files
// and a validator (`yarn store:validate-assets`). These images are uploaded
// by hand in Partner Center → Store listings; they are not part of the app
// package. See store/listing-assets/README.md.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LISTING_ASSETS_DIR = path.join(ROOT, 'store', 'listing-assets')

/** Partner Center Store listing language → app UI locale it is captured in. */
export const LISTING_LOCALES = { 'en-US': 'en', 'vi-VN': 'vi', 'zh-CN': 'zh-CN' }

/** Desktop screenshots, in upload order (Partner Center shows them in this order). */
export const SCREENSHOTS = ['01-sessions.png', '02-session-details.png', '03-delete-plan.png', '04-settings.png']
export const SCREENSHOT_SIZE = { width: 1920, height: 1080 }

/** Partner Center → Store logos → "1:1 App tile icon (300 x 300 pixels)". */
export const APP_TILE = { file: path.join('common', 'app-tile-300x300.png'), width: 300, height: 300 }

/** Documentation that lives next to the images (required). */
const DOCS = ['README.md', 'captions.md']
/** Partner Center limits (screenshots and logos): PNG, at most 50 MB. */
const MAX_BYTES = 50 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Width, height, bit depth and color type from a PNG's IHDR chunk; null if the data is not a PNG. */
export function readPngHeader(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] }
}

function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else out.push(path.relative(base, full))
  }
  return out
}

/**
 * Check the asset pack: every expected file present, PNG, exact size, no
 * unexpected files, and the same screenshots for every listing language.
 */
export function validateListingAssets(dir = LISTING_ASSETS_DIR) {
  const errors = []
  const checked = []
  if (!existsSync(dir)) return { errors: [`Missing folder ${dir}`], checked }

  const expectImage = (rel, width, height) => {
    const file = path.join(dir, rel)
    if (!existsSync(file)) return errors.push(`Missing ${rel}`)
    const size = statSync(file).size
    if (size > MAX_BYTES) errors.push(`${rel}: ${size} bytes is above the 50 MB Partner Center limit`)
    const png = readPngHeader(readFileSync(file))
    if (!png) return errors.push(`${rel}: not a PNG file`)
    if (png.width !== width || png.height !== height) errors.push(`${rel}: ${png.width}x${png.height}, expected ${width}x${height}`)
    checked.push({ file: rel.split(path.sep).join('/'), width: png.width, height: png.height, bytes: size })
  }

  for (const doc of DOCS) if (!existsSync(path.join(dir, doc))) errors.push(`Missing ${doc}`)
  expectImage(APP_TILE.file, APP_TILE.width, APP_TILE.height)
  const counts = {}
  for (const locale of Object.keys(LISTING_LOCALES)) {
    for (const name of SCREENSHOTS) expectImage(path.join(locale, name), SCREENSHOT_SIZE.width, SCREENSHOT_SIZE.height)
    const localeDir = path.join(dir, locale)
    counts[locale] = existsSync(localeDir) ? readdirSync(localeDir).filter((f) => f.toLowerCase().endsWith('.png')).length : 0
  }
  if (new Set(Object.values(counts)).size > 1) {
    errors.push(`Screenshot counts differ between languages: ${Object.entries(counts).map(([l, n]) => `${l}=${n}`).join(', ')}`)
  }

  const allowed = new Set([
    ...DOCS,
    APP_TILE.file,
    ...Object.keys(LISTING_LOCALES).flatMap((locale) => SCREENSHOTS.map((name) => path.join(locale, name)))
  ])
  for (const rel of listFiles(dir)) {
    if (!allowed.has(rel)) errors.push(`Unexpected file ${rel.split(path.sep).join('/')} (only the listed PNGs and the two .md files belong here)`)
  }
  return { errors, checked }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, checked } = validateListingAssets()
  for (const c of checked) console.log(`  ok  ${c.file}  ${c.width}x${c.height}  ${(c.bytes / 1024).toFixed(0)} KB`)
  if (errors.length) {
    console.error(`\nStore listing assets: ${errors.length} problem(s)`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log(`\nStore listing assets: OK (${checked.length} images)`)
}
