// yarn clean      -> removes dist/, release/ and out/ (build output only)
// yarn clean:dist -> removes dist/ and release/
// Only these folders directly inside the project are allowed; sources, the
// installed app and its user data are never touched.
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED = new Set(['dist', 'release', 'out'])

const targets = process.argv.slice(2)
if (!targets.length) {
  console.error('usage: clean.mjs <dist|release|out>...')
  process.exit(1)
}
for (const name of targets) {
  if (!ALLOWED.has(name)) {
    console.error(`clean: refusing to remove "${name}" (allowed: ${[...ALLOWED].join(', ')})`)
    process.exit(1)
  }
  const dir = path.join(root, name)
  if (path.dirname(dir) !== root) process.exit(1)
  if (!existsSync(dir)) continue
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    console.log(`clean: removed ${name}/`)
  } catch (err) {
    console.error(`clean: could not remove ${name}/ (${err.code ?? err.message}). Close any app running from ${name}/ and retry.`)
    process.exit(1)
  }
}
