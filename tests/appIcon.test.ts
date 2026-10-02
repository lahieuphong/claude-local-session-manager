import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { STORE_LISTING_TILE, ico, png, storeListingTile } from '../scripts/generate-icon.mjs'
import appMark from '../src/shared/appMark.json'

const ROOT = path.resolve(__dirname, '..')

describe('app icon and in-app mark stay in sync', () => {
  it('build/icon.png and build/icon.ico are generated from shared/appMark.json (run `yarn icon` after changing it)', () => {
    expect(fs.readFileSync(path.join(ROOT, 'build', 'icon.png')).equals(png(512))).toBe(true)
    expect(fs.readFileSync(path.join(ROOT, 'build', 'icon.ico')).equals(ico())).toBe(true)
  })

  it('the Store listing tile icon is the same mark, 300x300 on transparency (run `yarn icon` after changing it)', () => {
    const tile = fs.readFileSync(path.join(ROOT, STORE_LISTING_TILE.file))
    expect(tile.equals(storeListingTile())).toBe(true)
    expect([tile.readUInt32BE(16), tile.readUInt32BE(20)]).toEqual([300, 300])
    expect(tile[25]).toBe(6) // RGBA: transparent outside the mark's rounded tile
    expect(STORE_LISTING_TILE.markSize).toBeLessThan(300) // a margin, never stretched
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
