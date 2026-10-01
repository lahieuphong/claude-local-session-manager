// yarn release:patch | release:minor | release:major
// Prepares a release LOCALLY: bumps package.json, commits it as
// "release: vX.Y.Z" and creates the annotated tag vX.Y.Z.
// It never pushes — you push the commit and the tag yourself.
import { execFileSync } from 'node:child_process'
import { bumpPackageVersion } from './version.mjs'
import { versionToTag } from './versioning.mjs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const kind = process.argv[2]
try {
  if (!['patch', 'minor', 'major'].includes(kind)) throw new Error('usage: release.mjs patch|minor|major')
  if (git('status', '--porcelain')) throw new Error('Working tree is not clean. Commit or stash your changes first.')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') console.warn(`warning: releasing from branch "${branch}" (not main)`)

  const { from, to } = bumpPackageVersion(kind)
  const tag = versionToTag(to)
  if (git('tag', '--list', tag)) {
    git('checkout', '--', 'package.json')
    throw new Error(`Tag ${tag} already exists`)
  }
  git('add', 'package.json')
  git('commit', '-m', `release: ${tag}`)
  git('tag', '-a', tag, '-m', `Claude Local Session Manager ${tag}`)

  console.log(`\nPrepared ${tag} (${from} -> ${to}): commit + tag created locally. Nothing was pushed.\n`)
  console.log('Publish it with:')
  console.log('  git push origin main')
  console.log(`  git push origin ${tag}\n`)
  console.log(`Undo before pushing:  git tag -d ${tag} && git reset --hard HEAD~1`)
} catch (err) {
  console.error(`release: ${err.message}`)
  process.exit(1)
}
