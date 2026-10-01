// Collects the exact files to attach to a GitHub Release into release/,
// named the way electron-updater expects (spaces -> dashes, as in latest.yml):
//   Claude-Local-Session-Manager-Setup-X.Y.Z-x64.exe          (recommended)
//   Claude-Local-Session-Manager-Setup-X.Y.Z-x64.exe.blockmap (differential updates)
//   Claude-Local-Session-Manager-Portable-X.Y.Z-x64.exe       (no installation)
//   latest.yml                                                (updater metadata)
//   SHA256SUMS.txt
// Verifies versions and the Setup SHA-512 from latest.yml before copying.
// win-unpacked/, debug files and anything else in dist/ are never included.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { releaseAssetName } from './versioning.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const out = path.join(root, 'release')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const { version, productName } = pkg

function fail(msg) {
  console.error(`release assets: ${msg}`)
  process.exit(1)
}

const hash = (file, algo, enc) => createHash(algo).update(readFileSync(file)).digest(enc)

// Minimal parse of the few latest.yml fields we need (version, path, sha512).
const latestPath = path.join(dist, 'latest.yml')
if (!existsSync(latestPath)) fail('dist/latest.yml not found. Run `yarn dist` first.')
const latest = readFileSync(latestPath, 'utf8')
const field = (name) => new RegExp(`^${name}:\\s*'?([^'\\n]+)'?\\s*$`, 'm').exec(latest)?.[1]?.trim()
const ymlVersion = field('version')
const ymlPath = field('path')
const ymlSha512 = field('sha512')
if (ymlVersion !== version) fail(`latest.yml version ${ymlVersion} != package.json ${version}`)

const setupName = `${productName}-Setup-${version}-x64.exe`
const portableName = `${productName}-Portable-${version}-x64.exe`
const wanted = [setupName, `${setupName}.blockmap`, portableName]
for (const f of wanted) if (!existsSync(path.join(dist, f))) fail(`missing dist/${f}`)
if (ymlPath !== releaseAssetName(setupName)) fail(`latest.yml path "${ymlPath}" does not match ${releaseAssetName(setupName)}`)
if (hash(path.join(dist, setupName), 'sha512', 'base64') !== ymlSha512) fail('Setup SHA-512 does not match latest.yml')

const stray = readdirSync(dist).filter((f) => f.endsWith('.exe') && !wanted.includes(f))
if (stray.length) fail(`unexpected executables in dist/ (run \`yarn dist\` from a clean state): ${stray.join(', ')}`)

rmSync(out, { recursive: true, force: true })
mkdirSync(out)
const sums = []
for (const f of wanted) {
  const target = releaseAssetName(f)
  copyFileSync(path.join(dist, f), path.join(out, target))
  sums.push(`${hash(path.join(out, target), 'sha256', 'hex')}  ${target}`)
}
copyFileSync(latestPath, path.join(out, 'latest.yml'))
writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n')

console.log(`Release assets for v${version} in release/:`)
for (const f of readdirSync(out)) console.log(`  ${f}`)
