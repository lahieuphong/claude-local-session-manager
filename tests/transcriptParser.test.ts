import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyRecord,
  cleanPromptText,
  emptySummary,
  extractUserText,
  parseTranscriptFile,
  readDeclaredSessionId
} from '../src/main/services/transcriptParser'
import { createFakeClaude, FIXTURES, U, type FakeClaude } from './helpers/fakeClaude'

let fake: FakeClaude
beforeEach(async () => {
  fake = await createFakeClaude()
})
afterEach(async () => {
  await fake.cleanup()
})

describe('user content extraction', () => {
  it('supports string content', () => {
    expect(extractUserText({ type: 'user', message: { role: 'user', content: 'Hello' } })).toBe('Hello')
  })

  it('supports [{type:"text"}] content and ignores IDE wrapper blocks', () => {
    const rec = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<ide_selection>selected code</ide_selection>' },
          { type: 'image', source: {} },
          { type: 'text', text: 'Sửa lỗi này' }
        ]
      }
    }
    expect(extractUserText(rec)).toBe('Sửa lỗi này')
  })

  it('skips meta, tool results, sidechains and compact summaries', () => {
    expect(extractUserText({ type: 'user', isMeta: true, message: { content: 'x' } })).toBeUndefined()
    expect(extractUserText({ type: 'user', isSidechain: true, message: { content: 'x' } })).toBeUndefined()
    expect(extractUserText({ type: 'user', isCompactSummary: true, message: { content: 'x' } })).toBeUndefined()
    expect(
      extractUserText({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'x' }] } })
    ).toBeUndefined()
    expect(extractUserText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })).toBeUndefined()
  })

  it('turns slash commands into "/name args" and drops command output', () => {
    expect(cleanPromptText('<command-message>init</command-message>\n<command-name>/init</command-name>')).toBe('/init')
    expect(cleanPromptText('<command-name>/model</command-name><command-args>opus</command-args>')).toBe('/model opus')
    expect(cleanPromptText('<local-command-stdout>done</local-command-stdout>')).toBeUndefined()
    expect(cleanPromptText('[Request interrupted by user]')).toBeUndefined()
    expect(cleanPromptText('<system-reminder>noise</system-reminder>   ')).toBeUndefined()
  })
})

describe('transcript parsing', () => {
  it('extracts prompts, titles, model, counts and timestamps from the fixture', async () => {
    const { summary, bytesParsed } = await parseTranscriptFile(path.join(FIXTURES, 'transcripts', 'vietnamese-session.jsonl'))
    expect(summary.firstUserMessage).toBe('Xin chào, hãy kiểm tra dự án Nhà hát thành phố giúp tôi — tối ưu đường ống 3D')
    expect(summary.lastUserMessage).toBe('/compact')
    expect(summary.lastPrompt).toBe('Tiếp tục tối ưu đường ống 3D, giữ nguyên chất lượng')
    expect(summary.aiTitle).toBe('Kiểm tra dự án Nhà hát')
    expect(summary.model).toBe('claude-sonnet-5-5')
    expect(summary.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(summary.userMessageCount).toBe(3)
    expect(summary.assistantMessageCount).toBe(3) // msg_1 (2 records), msg_2, msg_3
    expect(summary.invalidLineCount).toBe(1)
    expect(summary.cwd).toBe('C:\\Work\\nhahattphcm')
    expect(summary.sessionIds).toEqual([U.A])
    expect(summary.firstTimestamp).toBe(Date.parse('2026-09-29T03:03:17.401Z'))
    expect(summary.lastTimestamp).toBe(Date.parse('2026-09-29T04:15:00.000Z'))
    const size = (await readFile(path.join(FIXTURES, 'transcripts', 'vietnamese-session.jsonl'))).length
    expect(bytesParsed).toBe(size)
  })

  it('decodes UTF-8 Vietnamese correctly even when chunks split multi-byte characters', async () => {
    const text = 'Đường ống tối ưu — Nhà hát thành phố Hồ Chí Minh ở Việt Nam 🎭'
    const file = await fake.writeTranscript('proj', U.B, [
      { type: 'user', message: { role: 'user', content: text }, timestamp: '2026-09-29T01:00:00Z', sessionId: U.B }
    ])
    for (const chunkSize of [1, 2, 3, 5, 7, 64]) {
      const { summary } = await parseTranscriptFile(file, { chunkSize })
      expect(summary.firstUserMessage).toBe(text)
      expect(summary.firstUserMessage).not.toMatch(/Ä|Ã|á»/)
    }
  })

  it('handles BOM, CRLF line endings and blank lines', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'một' }, sessionId: U.B }),
      '',
      JSON.stringify({ type: 'user', message: { content: 'hai' }, sessionId: U.B })
    ]
    const file = await fake.writeTranscript('proj', U.B, '\uFEFF' + lines.join('\r\n') + '\r\n')
    const { summary } = await parseTranscriptFile(file)
    expect(summary.firstUserMessage).toBe('một')
    expect(summary.lastUserMessage).toBe('hai')
    expect(summary.invalidLineCount).toBe(0)
  })

  it('leaves a partially written last line for the next parse', async () => {
    const complete = JSON.stringify({ type: 'user', message: { content: 'first' }, sessionId: U.B }) + '\n'
    const file = await fake.writeTranscript('proj', U.B, complete + '{"type":"user","message":{"cont')
    const r = await parseTranscriptFile(file)
    expect(r.summary.userMessageCount).toBe(1)
    expect(r.bytesParsed).toBe(Buffer.byteLength(complete))
    expect(r.summary.invalidLineCount).toBe(0)
  })

  it('incremental parse after an append equals a full parse', async () => {
    const file = await fake.copyTranscriptFixture('proj', U.C, 'vietnamese-session.jsonl')
    const first = await parseTranscriptFile(file)
    await appendFile(
      file,
      JSON.stringify({ type: 'user', message: { content: 'Câu hỏi mới' }, timestamp: '2026-09-30T00:00:00Z', sessionId: U.C }) +
        '\n' +
        JSON.stringify({ type: 'assistant', message: { id: 'msg_9', model: 'claude-fable-5-1' }, timestamp: '2026-09-30T00:01:00Z' }) +
        '\n',
      'utf8'
    )
    const incremental = await parseTranscriptFile(file, { resume: first })
    const full = await parseTranscriptFile(file)
    expect(incremental).toEqual(full)
    expect(full.summary.lastUserMessage).toBe('Câu hỏi mới')
    expect(full.summary.model).toBe('claude-fable-5-1')
  })

  it('applyRecord ignores non-objects and keeps the latest custom title', () => {
    const s = emptySummary()
    applyRecord(s, null)
    applyRecord(s, 'text')
    applyRecord(s, [1, 2])
    applyRecord(s, { type: 'custom-title', customTitle: 'Old' })
    applyRecord(s, { type: 'custom-title', customTitle: 'New' })
    expect(s.customTitle).toBe('New')
  })

  it('reads the declared parent session ID of a subagent log', async () => {
    expect(await readDeclaredSessionId(path.join(FIXTURES, 'transcripts', 'subagent.jsonl'))).toBe(U.A)
  })
})
