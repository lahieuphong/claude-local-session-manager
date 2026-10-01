// Pure semantic-version helpers shared by the release scripts (and unit tested).
// package.json "version" is the single source of truth for the app version.

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** Parse "MAJOR.MINOR.PATCH" (no prefix, no pre-release). Throws on anything else. */
export function parseVersion(version) {
  const m = SEMVER.exec(String(version).trim())
  if (!m) throw new Error(`Not a MAJOR.MINOR.PATCH version: "${version}"`)
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

export function formatVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}`
}

/** patch: 1.2.3 → 1.2.4 · minor: 1.2.3 → 1.3.0 · major: 1.2.3 → 2.0.0 */
export function bumpVersion(version, kind) {
  const v = parseVersion(version)
  if (kind === 'patch') return formatVersion({ ...v, patch: v.patch + 1 })
  if (kind === 'minor') return formatVersion({ major: v.major, minor: v.minor + 1, patch: 0 })
  if (kind === 'major') return formatVersion({ major: v.major + 1, minor: 0, patch: 0 })
  throw new Error(`Unknown bump kind "${kind}" (expected patch, minor or major)`)
}

export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  return 0
}

/** "v1.2.3" (or "refs/tags/v1.2.3") → "1.2.3". Tags must start with "v". */
export function tagToVersion(tag) {
  const t = String(tag).trim().replace(/^refs\/tags\//, '')
  if (!t.startsWith('v')) throw new Error(`Release tags must look like v1.2.3, got "${tag}"`)
  return formatVersion(parseVersion(t.slice(1)))
}

export function versionToTag(version) {
  return `v${formatVersion(parseVersion(version))}`
}

/** True only when the tag is exactly v<package.json version>. */
export function tagMatchesVersion(tag, version) {
  try {
    return String(tag).trim().replace(/^refs\/tags\//, '') === versionToTag(version)
  } catch {
    return false
  }
}

/** GitHub turns spaces in asset names into dots; electron-builder's latest.yml uses dashes. */
export function releaseAssetName(fileName) {
  return String(fileName).replace(/ /g, '-')
}
