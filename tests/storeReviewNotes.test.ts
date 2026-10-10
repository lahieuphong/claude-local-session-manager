import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESOURCES } from '../src/shared/locales'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8')

describe('what a Store reviewer is told about a PC without session files', () => {
  const notes = read('store/certification-notes.md')
  /** The quoted (`> `) block of the note, as it is pasted into Partner Center. */
  const note = notes
    .slice(notes.indexOf('### Notes for certification'), notes.indexOf('## Store-edition limitations'))
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .map((l) => l.replace(/^> ?/, ''))
    .join('\n')
    .trim()
  const flat = note.replace(/\s+/g, ' ')

  it('the certification note explains the empty list with the words the app shows, within the field size', () => {
    expect(flat).toContain('independent, unofficial local utility, not affiliated with Anthropic')
    expect(flat).toContain('No account, sign-in or network service is needed.')
    expect(flat).toContain("have already stored on the user's PC")
    expect(flat).toContain('AN EMPTY LIST IS NORMAL.')
    expect(flat).toContain('This is expected behavior, not a fault.')
    // The texts quoted in the note are what the app shows for an empty list.
    const en = RESOURCES.en as unknown as { sessions: { count: string; empty: { viewTitle: string } } }
    expect(flat).toContain(`"${en.sessions.empty.viewTitle}"`)
    expect(flat).toContain(`"${en.sessions.count.replace('{{shown}}', '0').replace('{{total}}', '0')}"`)
    expect(flat).toContain('Every launch starts in Safe Mode (dry run)')
    expect([...note].length).toBeLessThanOrEqual(2000)
  })

  it('it says how the screenshots were made and does not claim an installed MSIX was tested', () => {
    expect(flat).toContain('running the executable contained in this package (1.2.4.0, unpacked from the package, not an installed copy)')
    expect(flat).toContain('synthetic sample session files stored on disk')
    expect(flat).toContain('The sample data is not part of the package')
    expect(flat).not.toMatch(/installed from the (Microsoft )?Store|installed the (package|MSIX)|tested the installed/i)
    // Reviewers are not asked to download anything.
    expect(note).not.toMatch(/https?:\/\/|\.zip|download/i)
  })

  it('every listing says the app needs existing session files and is not an assistant itself', () => {
    const description = (locale: string): string => read(`store/listing/${locale}.md`).split(/^## .*$/m)[3].replace(/\s+/g, ' ')
    expect(description('en-US')).toMatch(/works with session files that already exist on your PC\. It is not an AI assistant, does not include Claude Code or Claude Desktop, and does not create sessions\. On a PC without such files the list is empty\./)
    expect(description('vi-VN')).toMatch(/làm việc với các tệp phiên đã có sẵn trên máy\. Đây không phải trợ lý AI, không kèm Claude Code hay Claude Desktop và không tự tạo phiên\. Trên máy chưa có các tệp này, danh sách sẽ trống\./)
    expect(description('zh-CN')).toMatch(/处理的是电脑上已有的会话文件。它不是 AI 助手，不包含 Claude Code 或 Claude Desktop，也不会创建会话。如果电脑上没有这类文件，列表为空。/)
  })
})
