import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_ID, APP_NAME, GITHUB_OWNER, GITHUB_REPO, PACKAGE_NAME, RELEASES_URL } from '../src/shared/appIdentity'

const root = path.resolve(__dirname, '..')
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8')
const builder = read('electron-builder.yml')
const pkg = JSON.parse(read('package.json')) as { name: string; productName: string; version: string; dependencies?: Record<string, string> }

/** Value of a top-level or nested "key: value" line (enough for this flat config). */
function yamlValue(key: string, scope?: string): string | undefined {
  let text = builder
  if (scope) {
    const start = text.search(new RegExp(`^${scope}:\\s*$`, 'm'))
    if (start < 0) return undefined
    const rest = text.slice(start).split('\n').slice(1)
    const end = rest.findIndex((l) => /^\S/.test(l))
    text = rest.slice(0, end < 0 ? undefined : end).join('\n')
  }
  return new RegExp(`^\\s*-?\\s*${key}:\\s*(.+?)\\s*$`, 'm').exec(text)?.[1]?.replace(/^['"]|['"]$/g, '')
}

describe('stable Windows identity', () => {
  it('electron-builder, package.json and the app share one identity', () => {
    expect(yamlValue('appId')).toBe(APP_ID)
    expect(APP_ID).toBe('com.lahieuphong.claude-local-session-manager')
    expect(yamlValue('productName')).toBe(APP_NAME)
    expect(yamlValue('executableName')).toBe(APP_NAME)
    expect(pkg.productName).toBe(APP_NAME)
    expect(pkg.name).toBe(PACKAGE_NAME)
    expect(read('src/main/index.ts')).toMatch(/app\.setAppUserModelId\(APP_ID\)/)
    expect(read('src/main/index.ts')).toMatch(/app\.setName\(APP_NAME\)/)
  })

  it('uninstall data cleanup can never resolve to Claude\'s own folders', () => {
    // NSIS --delete-app-data removes %APPDATA%\<productName>, <name> and the install dir name.
    const claudeFolders = ['claude', 'claude-3p', 'anthropicclaude', 'claude-code', '.claude']
    for (const n of [APP_NAME, PACKAGE_NAME, pkg.productName, pkg.name]) {
      expect(claudeFolders).not.toContain(n.toLowerCase())
    }
  })
})

describe('installer configuration', () => {
  it('builds a per-user Setup and a Portable exe with versioned names', () => {
    expect(builder).toMatch(/target: nsis/)
    expect(builder).toMatch(/target: portable/)
    expect(yamlValue('oneClick', 'nsis')).toBe('true')
    expect(yamlValue('perMachine', 'nsis')).toBe('false')
    expect(yamlValue('createStartMenuShortcut', 'nsis')).toBe('true')
    expect(yamlValue('createDesktopShortcut', 'nsis')).toBe('true') // first install only, not 'always'
    expect(yamlValue('deleteAppDataOnUninstall', 'nsis')).toBe('false')
    expect(yamlValue('shortcutName', 'nsis')).toBe(APP_NAME)
    expect(yamlValue('artifactName', 'nsis')).toBe('${productName}-Setup-${version}-${arch}.${ext}')
    expect(yamlValue('artifactName', 'portable')).toBe('${productName}-Portable-${version}-${arch}.${ext}')
    expect(yamlValue('output', 'directories')).toBe('dist')
  })

  it('packages only the compiled app', () => {
    const files = builder.slice(builder.indexOf('files:'), builder.indexOf('asar:'))
    expect(files).toMatch(/- out\/\*\*\/\*/)
    expect(files).not.toMatch(/src\/|tests\/|fixtures\//)
  })

  it('updates come only from this project\'s GitHub Releases over HTTPS', () => {
    expect(yamlValue('provider', 'publish')).toBe('github')
    expect(yamlValue('owner', 'publish')).toBe(GITHUB_OWNER)
    expect(yamlValue('repo', 'publish')).toBe(GITHUB_REPO)
    expect(RELEASES_URL).toBe('https://github.com/lahieuphong/claude-local-session-manager/releases')
    expect(pkg.dependencies?.['electron-updater']).toBeDefined()
  })
})

describe('release workflow', () => {
  const wf = read('.github/workflows/release.yml')

  it('runs only on version tags, verifies the tag, and publishes after test/typecheck/build', () => {
    expect(wf).toMatch(/tags:\s*\n\s*- 'v\*\.\*\.\*'/)
    expect(wf).toMatch(/contents: write/)
    expect(wf).not.toMatch(/ghp_|github_pat_/) // no hard-coded tokens
    const order = ['check-tag-version.mjs', 'yarn install --frozen-lockfile', 'yarn test', 'yarn typecheck', 'yarn build', 'yarn dist', 'yarn release:assets', 'softprops/action-gh-release']
    const idx = order.map((s) => wf.indexOf(s))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(wf).toMatch(/generate_release_notes: true/)
    expect(wf).toMatch(/name: Claude Local Session Manager \$\{\{ github\.ref_name \}\}/)
    expect(wf).not.toMatch(/win-unpacked/)
  })
})
