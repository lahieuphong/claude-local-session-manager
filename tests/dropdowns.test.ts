import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = path.resolve(__dirname, '..', 'src', 'renderer', 'src')
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []))

describe('dropdowns', () => {
  it('are all drawn by the app: Windows draws the list of a native one in its own colours', () => {
    // Comments may name it; code may not.
    const code = (file: string): string => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const native = sources(RENDERER).filter((file) => /<(select|datalist)\b/.test(code(file)))
    expect(native.map((file) => path.relative(RENDERER, file))).toEqual([])
  })
})
