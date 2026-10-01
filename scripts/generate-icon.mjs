// Generates build/icon.png (512px) and build/icon.ico (16–256px) for the app.
// Pure Node (zlib only) so the build has no native image dependencies.
// The mark is a neutral "stacked session cards" glyph, not a Claude logo.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build')

// Shapes in a 64×64 design space, painted in order.
const SHAPES = [
  { x: 2, y: 2, w: 60, h: 60, r: 14, color: '#2f3a4d' },
  { x: 4, y: 4, w: 56, h: 56, r: 12, color: '#1b2230' },
  { x: 16, y: 14, w: 32, h: 8, r: 3, color: '#3c4a63' },
  { x: 13, y: 26, w: 38, h: 10, r: 3.5, color: '#56709c' },
  { x: 10, y: 40, w: 44, h: 12, r: 4, color: '#7aa2ff' },
  { x: 16, y: 44.5, w: 18, h: 3, r: 1.5, color: '#0d1320', alpha: 0.75 }
]

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))

function insideRoundRect(px, py, s) {
  const { x, y, w, h, r } = s
  if (px < x || py < y || px > x + w || py > y + h) return false
  const cx = Math.min(Math.max(px, x + r), x + w - r)
  const cy = Math.min(Math.max(py, y + r), y + h - r)
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
}

function render(size) {
  const ss = size <= 32 ? 6 : 4
  const px = Buffer.alloc(size * size * 4)
  const scale = 64 / size
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const x = (i + (si + 0.5) / ss) * scale
          const y = (j + (sj + 0.5) / ss) * scale
          let cr = 0, cg = 0, cb = 0, ca = 0
          for (const s of SHAPES) {
            if (!insideRoundRect(x, y, s)) continue
            const [sr, sg, sb] = hex(s.color)
            const sa = s.alpha ?? 1
            cr = sr * sa + cr * (1 - sa)
            cg = sg * sa + cg * (1 - sa)
            cb = sb * sa + cb * (1 - sa)
            ca = sa + ca * (1 - sa)
          }
          r += cr; g += cg; b += cb; a += ca
        }
      }
      const n = ss * ss
      const o = (j * size + i) * 4
      const alpha = a / n
      px[o] = alpha ? Math.round(r / n / alpha) : 0
      px[o + 1] = alpha ? Math.round(g / n / alpha) : 0
      px[o + 2] = alpha ? Math.round(b / n / alpha) : 0
      px[o + 3] = Math.round(alpha * 255)
    }
  }
  return px
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(size) {
  const rgba = render(size)
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function ico(sizes) {
  const images = sizes.map((s) => ({ size: s, data: png(s) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + dir.length
  images.forEach((img, i) => {
    const o = i * 16
    dir[o] = img.size >= 256 ? 0 : img.size
    dir[o + 1] = img.size >= 256 ? 0 : img.size
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(img.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += img.data.length
  })
  return Buffer.concat([header, dir, ...images.map((i) => i.data)])
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'icon.png'), png(512))
writeFileSync(join(outDir, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]))
console.log('Wrote build/icon.png and build/icon.ico')
