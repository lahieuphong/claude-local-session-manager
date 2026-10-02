import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ico, png } from '../scripts/generate-icon.mjs'
import appMark from '../src/shared/appMark.json'

const ROOT = path.resolve(__dirname, '..')

describe('app icon and in-app mark stay in sync', () => {
  it('build/icon.png and build/icon.ico are generated from shared/appMark.json (run `yarn icon` after changing it)', () => {
    expect(fs.readFileSync(path.join(ROOT, 'build', 'icon.png')).equals(png(512))).toBe(true)
    expect(fs.readFileSync(path.join(ROOT, 'build', 'icon.ico')).equals(ico())).toBe(true)
  })

  it('the UI draws the same mark, and its main card uses the UI accent color', () => {
    const icons = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/Icons.tsx'), 'utf8')
    expect(icons).toMatch(/import appMark from '..\/..\/..\/shared\/appMark.json'/)
    const markBody = icons.slice(icons.indexOf('export function AppMark'))
    expect(markBody).toMatch(/appMark\.shapes\.map/)
    expect(markBody).not.toMatch(/<rect x="\d/) // no hard-coded copy of the shapes
    const css = fs.readFileSync(path.join(ROOT, 'src/renderer/src/styles/global.css'), 'utf8')
    const accent = /--accent:\s*(#[0-9a-f]{6})/i.exec(css)?.[1]?.toLowerCase()
    expect(appMark.shapes.map((s) => s.color.toLowerCase())).toContain(accent)
    expect(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')).toMatch(/icon: build\/icon\.ico/)
  })
})
