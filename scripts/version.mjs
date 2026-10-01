// yarn version:patch | version:minor | version:major
// Bumps package.json "version" only (the single source of truth). No git
// commit, no tag, no publish. yarn.lock does not contain the root version,
// so it does not need to change.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { bumpVersion, versionToTag } from './versioning.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')

export function bumpPackageVersion(kind) {
  const text = readFileSync(pkgPath, 'utf8')
  const pkg = JSON.parse(text)
  const from = pkg.version
  const to = bumpVersion(from, kind)
  // Replace only the version value so the rest of package.json keeps its formatting.
  const updated = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${to}$2`)
  if (updated === text) throw new Error('Could not update the "version" field in package.json')
  writeFileSync(pkgPath, updated)
  return { from, to }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const kind = process.argv[2]
  try {
    const { from, to } = bumpPackageVersion(kind)
    console.log(`\nVersion: ${from} -> ${to}\n`)
    console.log('Nothing was committed, tagged or published. Next steps:')
    console.log(`  git add package.json`)
    console.log(`  git commit -m "release: ${versionToTag(to)}"`)
    console.log(`  git tag ${versionToTag(to)}`)
    console.log(`  git push origin main`)
    console.log(`  git push origin ${versionToTag(to)}   # GitHub Actions builds and publishes the release\n`)
  } catch (err) {
    console.error(`version: ${err.message}`)
    process.exit(1)
  }
}
