import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExportService, safeFileName } from '../src/main/services/exportService'
import { createFakeClaude, createHarness, U, type FakeClaude } from './helpers/fakeClaude'

let fake: FakeClaude
beforeEach(async () => {
  fake = await createFakeClaude()
})
afterEach(async () => {
  await fake.cleanup()
})

const sha = async (p: string): Promise<string> => createHash('sha256').update(await readFile(p)).digest('hex')

describe('export', () => {
  it('copies raw JSONL, writes info JSON and readable Markdown without touching the original', async () => {
    const transcript = await fake.copyTranscriptFixture('C--Work-demo', U.A, 'vietnamese-session.jsonl')
    const hashBefore = await sha(transcript)
    const mtimeBefore = (await stat(transcript)).mtimeMs
    const out = path.join(fake.root, 'exports')
    await mkdir(out)

    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    const record = h.repo.getRecord(s.id)!
    const exporter = new ExportService(h.repo, { chooseFile: async () => null, chooseDirectory: async () => out })

    await exporter.writeExport(record, 'jsonl', path.join(out, 'a.jsonl'))
    await exporter.writeExport(record, 'info', path.join(out, 'a.info.json'))
    await exporter.writeExport(record, 'markdown', path.join(out, 'a.md'))

    expect(await sha(path.join(out, 'a.jsonl'))).toBe(hashBefore)
    const info = JSON.parse(await readFile(path.join(out, 'a.info.json'), 'utf8'))
    expect(info.session.cliSessionId).toBe(U.A)
    const md = await readFile(path.join(out, 'a.md'), 'utf8')
    expect(md).toContain('# Kiểm tra dự án Nhà hát')
    expect(md).toContain('Xin chào, hãy kiểm tra dự án Nhà hát thành phố giúp tôi')
    expect(md).toContain('Tool: **Bash**')
    expect(md).not.toContain('<ide_opened_file>')

    expect(await sha(transcript)).toBe(hashBefore)
    expect((await stat(transcript)).mtimeMs).toBe(mtimeBefore)
  })

  it('bulk export writes into a new sub-folder of the chosen directory', async () => {
    await fake.copyTranscriptFixture('C--Work-demo', U.A, 'vietnamese-session.jsonl')
    await fake.copyTranscriptFixture('C--Work-demo', U.B, 'vietnamese-session.jsonl')
    const out = path.join(fake.root, 'exports')
    await mkdir(out)
    const h = createHarness(fake)
    const snap = await h.repo.scan()
    const exporter = new ExportService(h.repo, { chooseFile: async () => null, chooseDirectory: async () => out })
    const r = await exporter.exportMany(
      snap.sessions.map((s) => s.id),
      ['jsonl', 'info']
    )
    expect(r.ok).toBe(true)
    expect(r.files).toHaveLength(4)
    for (const f of r.files) expect(path.dirname(path.dirname(f))).toBe(out)
  })

  it('refuses to export into Claude storage or onto the original file', async () => {
    const transcript = await fake.copyTranscriptFixture('C--Work-demo', U.A, 'vietnamese-session.jsonl')
    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    const record = h.repo.getRecord(s.id)!
    const exporter = new ExportService(h.repo, { chooseFile: async () => null, chooseDirectory: async () => null })
    await expect(exporter.writeExport(record, 'jsonl', transcript)).rejects.toThrow(/original/)
    await expect(exporter.writeExport(record, 'jsonl', path.join(fake.projects, 'copy.jsonl'))).rejects.toThrow(/Claude storage/)
    await expect(exporter.writeExport(record, 'markdown', path.join(fake.claudeHome, 'x.md'))).rejects.toThrow(/Claude storage/)
  })

  it('builds safe file names', () => {
    expect(safeFileName('a<b>:c/d\\e|f?g*h"', U.A)).toBe('a_b__c_d_e_f_g_h_-11111111')
    expect(safeFileName('   ', U.A)).toBe('session-11111111')
    expect(safeFileName('Tối ưu', U.A)).toBe('Tối ưu-11111111')
  })
})
