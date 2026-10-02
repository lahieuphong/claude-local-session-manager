import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_TILE, LISTING_ASSETS_DIR, LISTING_LOCALES, SCREENSHOTS, readPngHeader, validateListingAssets } from '../scripts/store-listing-assets.mjs'

const ROOT = path.resolve(__dirname, '..')
const LOCALES = Object.keys(LISTING_LOCALES)

/** A PNG signature + IHDR chunk: all the validator reads. */
function fakePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr])
}

function withCopy(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clsm-listing-'))
  try {
    cpSync(LISTING_ASSETS_DIR, dir, { recursive: true })
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** `| file | caption |` rows of captions.md, per `## … (locale)` section. */
function captions(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let locale = ''
  for (const line of readFileSync(path.join(LISTING_ASSETS_DIR, 'captions.md'), 'utf8').split('\n')) {
    const heading = /^## .*\(([a-z]{2}-[A-Z]{2})\)\s*$/.exec(line)
    if (heading) locale = heading[1]
    const row = /^\| (\d\d-[a-z-]+\.png) \| (.+) \|\s*$/.exec(line)
    if (row && locale) (out[locale] ??= {})[row[1]] = row[2].trim()
  }
  return out
}

describe('Microsoft Store listing assets', () => {
  it('the committed pack is complete: 4 screenshots per language at 1920x1080, the 300x300 tile, PNG only', () => {
    const { errors, checked } = validateListingAssets()
    expect(errors).toEqual([])
    expect(checked).toHaveLength(LOCALES.length * SCREENSHOTS.length + 1)
    expect(checked.find((c) => c.file === 'common/app-tile-300x300.png')).toMatchObject({ width: 300, height: 300 })
    for (const c of checked.filter((x) => !x.file.startsWith('common/'))) expect([c.width, c.height]).toEqual([1920, 1080])
  })

  it('the validator reports wrong sizes, non-PNG files, unexpected files, missing files and unequal counts', () => {
    withCopy((dir) => {
      writeFileSync(path.join(dir, 'vi-VN', '02-session-details.png'), fakePng(1366, 768))
      writeFileSync(path.join(dir, 'zh-CN', '03-delete-plan.png'), Buffer.from('not a png'))
      writeFileSync(path.join(dir, APP_TILE.file), fakePng(310, 310))
      writeFileSync(path.join(dir, 'en-US', '05-extra.png'), fakePng(1920, 1080))
      mkdirSync(path.join(dir, 'trailers'))
      writeFileSync(path.join(dir, 'trailers', 'trailer.mp4'), 'x')
      rmSync(path.join(dir, 'captions.md'))
      const { errors } = validateListingAssets(dir)
      expect(errors).toEqual(
        expect.arrayContaining([
          'Missing captions.md',
          'vi-VN/02-session-details.png: 1366x768, expected 1920x1080'.replace(/\//g, path.sep),
          'zh-CN/03-delete-plan.png: not a PNG file'.replace(/\//g, path.sep),
          expect.stringMatching(/app-tile-300x300\.png: 310x310, expected 300x300/),
          expect.stringMatching(/^Screenshot counts differ between languages: en-US=5, vi-VN=4, zh-CN=4$/),
          expect.stringMatching(/^Unexpected file en-US\/05-extra\.png/),
          expect.stringMatching(/^Unexpected file trailers\/trailer\.mp4/)
        ])
      )
    })
    expect(readPngHeader(fakePng(7, 9))).toMatchObject({ width: 7, height: 9 })
    expect(readPngHeader(Buffer.from('GIF89a......................................'))).toBeNull()
  })

  it('every screenshot has a caption in every language, each at most 200 characters', () => {
    const all = captions()
    expect(Object.keys(all).sort()).toEqual([...LOCALES].sort())
    for (const locale of LOCALES) {
      expect(Object.keys(all[locale])).toEqual(SCREENSHOTS)
      for (const text of Object.values(all[locale])) {
        expect(text.length).toBeGreaterThan(20)
        expect(text.length).toBeLessThanOrEqual(200)
      }
    }
    // Written in the language, not copied from English.
    for (const text of Object.values(all['vi-VN'])) expect(text).toMatch(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i)
    for (const text of Object.values(all['zh-CN'])) expect(text).toMatch(/[一-鿿]/)
  })

  it('the README maps every Partner Center field and leaves game/Xbox/trailer fields blank', () => {
    const readme = readFileSync(path.join(LISTING_ASSETS_DIR, 'README.md'), 'utf8')
    for (const row of [
      /\| Screenshots → Desktop \| \*\*Required\*\*/,
      /\| Store logos → 1:1 App tile icon \(300 × 300\) \| \*\*Recommended\*\* \| `common\/app-tile-300x300\.png`/,
      /\| Store logos → 2:3 Poster art \(720 × 1080\) \| Not applicable/,
      /\| Store logos → 1:1 Box art \(1080 × 1080\) \| Not applicable/,
      /\| Trailers [^|]*\| Optional/,
      /16:9 Super hero art \| Optional \(recommended\) \| — /,
      /\| Xbox images [^|]*\| Not applicable/
    ]) {
      expect(readme).toMatch(row)
    }
    for (const name of ['English (United States)', 'Vietnamese', 'Chinese (Simplified, China)']) expect(readme).toContain(name)
  })

  it('yarn scripts exist for capturing and validating the assets', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['store:screenshots']).toBe('node scripts/store-screenshots.mjs')
    expect(pkg.scripts['store:validate-assets']).toBe('node scripts/store-listing-assets.mjs')
  })

  it('the listing assets are never packaged into the app', () => {
    const builder = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')
    expect(builder).not.toMatch(/listing-assets/)
    expect(builder).toMatch(/^files:/m)
    expect(builder).not.toMatch(/^\s*-\s*store\/?\*\*/m)
  })
})
