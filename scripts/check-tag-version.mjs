// CI guard: the pushed tag must be exactly v<package.json version>.
// usage: node scripts/check-tag-version.mjs <tag>   (defaults to $GITHUB_REF_NAME)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tagMatchesVersion, versionToTag } from './versioning.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? ''

if (!tagMatchesVersion(tag, version)) {
  console.error(`Tag/version mismatch: tag "${tag}" but package.json version is ${version} (expected tag ${versionToTag(version)}).`)
  console.error('Refusing to build release artifacts with the wrong version.')
  process.exit(1)
}
console.log(`OK: tag ${tag} matches package.json version ${version}`)
