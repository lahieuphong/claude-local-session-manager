import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bumpVersion,
  compareVersions,
  parseVersion,
  releaseAssetName,
  tagMatchesVersion,
  tagToVersion,
  versionToTag
} from '../scripts/versioning.mjs'

const root = path.resolve(__dirname, '..')
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version as string

describe('semantic version parsing', () => {
  it('accepts only MAJOR.MINOR.PATCH', () => {
    expect(parseVersion('1.0.0')).toEqual({ major: 1, minor: 0, patch: 0 })
    expect(parseVersion('12.34.56')).toEqual({ major: 12, minor: 34, patch: 56 })
    for (const bad of ['1.0', '1.0.0.0', 'v1.0.0', '01.0.0', '1.0.0-beta', '', 'abc']) {
      expect(() => parseVersion(bad)).toThrow()
    }
  })

  it('bumps patch / minor / major', () => {
    expect(bumpVersion('1.0.0', 'patch')).toBe('1.0.1')
    expect(bumpVersion('1.0.9', 'patch')).toBe('1.0.10')
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(() => bumpVersion('1.2.3', 'prerelease')).toThrow()
  })

  it('compares numerically, not as strings', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1)
  })

  it('package.json holds a valid canonical version', () => {
    expect(() => parseVersion(pkgVersion)).not.toThrow()
  })
})

describe('release tag ↔ version', () => {
  it('maps tags and versions', () => {
    expect(tagToVersion('v1.0.1')).toBe('1.0.1')
    expect(tagToVersion('refs/tags/v2.3.4')).toBe('2.3.4')
    expect(versionToTag('1.0.1')).toBe('v1.0.1')
    expect(() => tagToVersion('1.0.1')).toThrow()
  })

  it('a tag must be exactly v<version>', () => {
    expect(tagMatchesVersion('v1.0.1', '1.0.1')).toBe(true)
    expect(tagMatchesVersion('refs/tags/v1.0.1', '1.0.1')).toBe(true)
    expect(tagMatchesVersion('v1.0.2', '1.0.1')).toBe(false)
    expect(tagMatchesVersion('1.0.1', '1.0.1')).toBe(false)
    expect(tagMatchesVersion('v1.0.01', '1.0.1')).toBe(false)
    expect(tagMatchesVersion('v1.0.1-rc1', '1.0.1')).toBe(false)
    expect(tagMatchesVersion('', '1.0.1')).toBe(false)
  })

  it('CI guard script fails on a mismatching tag and passes on the right one', () => {
    const run = (tag: string): { ok: boolean; out: string } => {
      try {
        return { ok: true, out: execFileSync(process.execPath, ['scripts/check-tag-version.mjs', tag], { cwd: root, encoding: 'utf8', stdio: 'pipe' }) }
      } catch (err) {
        return { ok: false, out: String((err as { stderr?: string }).stderr) }
      }
    }
    expect(run(`v${pkgVersion}`).ok).toBe(true)
    const bad = run('v999.0.0')
    expect(bad.ok).toBe(false)
    expect(bad.out).toMatch(/mismatch/)
  })

  it('release asset names match what electron-builder writes into latest.yml', () => {
    expect(releaseAssetName('Claude Local Session Manager-Setup-1.0.1-x64.exe')).toBe('Claude-Local-Session-Manager-Setup-1.0.1-x64.exe')
  })
})
