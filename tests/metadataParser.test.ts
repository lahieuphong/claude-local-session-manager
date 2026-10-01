import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseArchiveIndex,
  parseMetadataText,
  parseTimestamp,
  scanDesktopRoot,
  serializeArchiveIndex,
  transcriptIdsOf,
  type MetadataFileInfo
} from '../src/main/services/metadataParser'
import { createFakeClaude, FIXTURES, U, type FakeClaude } from './helpers/fakeClaude'

const info: MetadataFileInfo = {
  filePath: 'C:\\x\\local_abc.json',
  storageDir: 'C:\\x',
  accountId: 'a',
  orgId: 'o',
  rootPath: 'C:\\',
  size: 10,
  mtimeMs: 1
}

let fake: FakeClaude
beforeEach(async () => {
  fake = await createFakeClaude()
})
afterEach(async () => {
  await fake.cleanup()
})

describe('metadata parsing', () => {
  it('parses the real Claude Desktop schema', async () => {
    const text = await readFile(path.join(FIXTURES, 'metadata', 'local_6f1c2a9e-4b7d-4c1e-9a3b-2d8e5f7a1c00.json'), 'utf8')
    const rec = parseMetadataText(text, { ...info, filePath: 'C:\\x\\local_6f1c2a9e-4b7d-4c1e-9a3b-2d8e5f7a1c00.json' })
    expect(rec.parseError).toBeUndefined()
    expect(rec.sessionId).toBe('local_6f1c2a9e-4b7d-4c1e-9a3b-2d8e5f7a1c00')
    expect(rec.cliSessionId).toBe(U.A)
    expect(rec.cwd).toBe('C:\\Work\\nhahattphcm')
    expect(rec.rawTitle).toEqual({ kind: 'string', value: 'Tối ưu pipeline 3D' })
    expect(rec.model).toBe('claude-opus-5-5')
    expect(rec.isArchived).toBe(false)
    expect(rec.createdAt).toBe(1790650000000)
    expect(rec.lastActivityAt).toBe(1790660000000)
  })

  it('tolerates missing fields', () => {
    const rec = parseMetadataText('{}', info)
    expect(rec.parseError).toBeUndefined()
    expect(rec.sessionId).toBe('local_abc')
    expect(rec.rawTitle).toEqual({ kind: 'missing' })
    expect(rec.cliSessionId).toBeUndefined()
    expect(rec.isArchived).toBe(false)
    expect(rec.priorCliSessionIds).toEqual([])
  })

  it('keeps title: null distinct from a missing title', () => {
    expect(parseMetadataText('{"title":null}', info).rawTitle).toEqual({ kind: 'null' })
    expect(parseMetadataText('{"title":""}', info).rawTitle).toEqual({ kind: 'empty', value: '' })
  })

  it('reports malformed JSON without throwing', () => {
    const rec = parseMetadataText('{"sessionId": "local_abc", ', info)
    expect(rec.parseError).toMatch(/Invalid JSON/)
    expect(rec.sessionId).toBe('local_abc')
    expect(parseMetadataText('[1,2]', info).parseError).toMatch(/not a JSON object/)
    expect(parseMetadataText('"str"', info).parseError).toMatch(/not a JSON object/)
  })

  it('flags a sessionId that does not match the file name', () => {
    expect(parseMetadataText('{"sessionId":"local_other"}', info).parseError).toMatch(/does not match/)
  })

  it('never trusts IDs containing path syntax', () => {
    const rec = parseMetadataText(
      JSON.stringify({ cliSessionId: '..\\..\\Windows\\evil', priorCliSessionIds: ['../x', U.B, U.B], unarchivedCliSessionId: 'a/b' }),
      info
    )
    expect(rec.cliSessionId).toBeUndefined()
    expect(rec.unarchivedCliSessionId).toBeUndefined()
    expect(rec.priorCliSessionIds).toEqual([U.B])
    expect(transcriptIdsOf(rec)).toEqual([U.B])
  })

  it('parses ms, seconds and ISO timestamps', () => {
    expect(parseTimestamp(1790650000000)).toBe(1790650000000)
    expect(parseTimestamp(1790650000)).toBe(1790650000000)
    expect(parseTimestamp('2026-09-29T03:03:17.401Z')).toBe(Date.parse('2026-09-29T03:03:17.401Z'))
    expect(parseTimestamp('1790650000000')).toBe(1790650000000)
    expect(parseTimestamp('nope')).toBeUndefined()
    expect(parseTimestamp(-1)).toBeUndefined()
  })

  it('reads and writes the archive index in Claude Desktop format', () => {
    expect(parseArchiveIndex('{"v":1,"archived":["local_b","local_a"]}')).toEqual(['local_b', 'local_a'])
    expect(parseArchiveIndex('{"v":2,"archived":[]}')).toBeNull()
    expect(parseArchiveIndex('{"v":1,"archived":["../evil"]}')).toBeNull()
    expect(parseArchiveIndex('garbage')).toBeNull()
    expect(serializeArchiveIndex(['local_b', 'local_a', 'local_a', 'bad id'])).toBe('{"v":1,"archived":["local_a","local_b"]}')
  })
})

describe('desktop root scan', () => {
  it('finds metadata, tombstones and the archive index', async () => {
    await fake.writeMetadata('one', { sessionId: 'local_one', cliSessionId: U.A, title: null })
    await fake.writeMetadata('two', '{ broken')
    await writeFile(path.join(fake.orgDir, 'deleted_old'), '1790000000000')
    await writeFile(path.join(fake.orgDir, 'archived-sessions.idx'), '{"v":1,"archived":["local_one"]}')
    await writeFile(path.join(fake.orgDir, 'scheduled-tasks.json'), '{"scheduledTasks":[]}')
    await writeFile(path.join(fake.orgDir, 'notes.txt'), 'ignored')

    const scan = await scanDesktopRoot(fake.desktopRoot)
    expect(scan.records.map((r) => r.sessionId).sort()).toEqual(['local_one', 'local_two'])
    expect(scan.records.find((r) => r.sessionId === 'local_two')?.parseError).toMatch(/Invalid JSON/)
    expect(scan.storageDirs).toHaveLength(1)
    expect(scan.storageDirs[0].tombstones).toEqual(['old'])
    expect(scan.storageDirs[0].archiveIndex?.ids).toEqual(['local_one'])
  })
})
