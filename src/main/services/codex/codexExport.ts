import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, realpath } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import type { ExportFormat, ExportResult } from '../../../shared/types'
import { APP_NAME } from '../../../shared/appIdentity'
import { formatDateTime } from '../../../shared/format'
import { isStrictlyInside } from '../../security/pathValidator'
import { pathKey } from '../../util/fsx'
import { errorMessage, logger } from '../../util/logger'
import { msg } from '../../util/messages'
import { EXPORT_EXTENSIONS, safeFileName, type ExportDialogs } from '../exportService'
import type { CodexRecord, CodexRepository } from './codexRepository'
import { readCodexHistoryItems, readCodexRolloutItems, type CodexTranscriptEntry } from './codexStore'

/**
 * Never into a Codex folder: exports are copies for the user, not Codex data.
 * Checked on the real path too, so a short (8.3) name or a folder link cannot lead there.
 */
async function assertDestination(dest: string, homes: string[]): Promise<void> {
  if (!path.isAbsolute(dest)) throw new Error('Export destination must be an absolute path')
  const dir = path.dirname(dest)
  const realDir = await realpath(dir).catch(() => dir)
  const targets = [dest, path.join(realDir, path.basename(dest))]
  if (targets.some((t) => homes.some((h) => pathKey(t) === pathKey(h) || isStrictlyInside(t, h)))) throw new Error('Refusing to export into a Codex folder')
}

async function writeText(dest: string, text: string): Promise<void> {
  const stream = createWriteStream(dest, { encoding: 'utf8' })
  stream.end(text)
  await once(stream, 'finish')
}

async function conversation(record: CodexRecord): Promise<CodexTranscriptEntry[]> {
  if (record.home.historyDb && record.historyItems > 0) return readCodexHistoryItems(record.home.historyDb, record.threadId)
  return record.session.transcriptFile ? readCodexRolloutItems(record.session.transcriptFile) : []
}

export class CodexExportService {
  constructor(
    private repo: CodexRepository,
    private dialogs: ExportDialogs,
    private appName = APP_NAME
  ) {}

  private homes(): string[] {
    return this.repo.getHomes().map((h) => h.path)
  }

  async writeExport(record: CodexRecord, format: ExportFormat, dest: string): Promise<void> {
    await assertDestination(dest, this.homes())
    const s = record.session
    if (format === 'info') {
      await writeText(dest, JSON.stringify({ exportedAt: new Date().toISOString(), exportedBy: `${this.appName} (unofficial)`, tool: 'OpenAI Codex', session: s }, null, 2))
    } else if (format === 'jsonl') {
      // The session file when there is one; otherwise the stored items, one per line, as Codex wrote them.
      if (s.transcriptFile) await copyFile(s.transcriptFile, dest)
      else await writeText(dest, (await conversation(record)).map((e) => e.raw).join('\n') + '\n')
    } else {
      const lines = [
        `# ${s.displayTitle}`,
        '',
        `- Tool: OpenAI Codex${s.codexSource ? ` (${s.codexSource})` : ''}`,
        `- Session ID: ${s.cliSessionId ?? '-'}`,
        `- Project: ${s.projectPath ?? s.projectName}`,
        `- Model: ${s.model ?? '-'}`,
        `- Updated: ${s.updatedAt ? formatDateTime(s.updatedAt) : '-'}`,
        `- Exported by ${this.appName} (unofficial)`,
        ''
      ]
      for (const e of await conversation(record)) {
        if (!e.text.trim()) continue
        const head = e.role === 'user' ? '## User' : e.role === 'assistant' ? '## Codex' : `### Tool (${e.type})`
        lines.push(head + (e.at ? ` · ${formatDateTime(e.at)}` : ''), '', e.role === 'tool' ? '```\n' + e.text + '\n```' : e.text, '')
      }
      await writeText(dest, lines.join('\n'))
    }
    logger.info(`Exported ${format} of Codex session ${s.id} to ${dest}`)
  }

  async exportOne(id: string, format: ExportFormat): Promise<ExportResult> {
    const record = this.repo.getRecord(id)
    if (!record) return { ok: false, ...msg('export.notFound'), files: [], errors: [] }
    if (format !== 'info' && !record.session.hasTranscript) return { ok: false, ...msg('export.noTranscript'), files: [], errors: [] }
    const name = safeFileName(record.session.displayTitle, record.threadId) + EXPORT_EXTENSIONS[format]
    const dest = await this.dialogs.chooseFile(name, format)
    if (!dest) return { ok: false, cancelled: true, ...msg('export.cancelled'), files: [], errors: [] }
    try {
      await this.writeExport(record, format, dest)
      return { ok: true, ...msg('export.done', { path: dest }), files: [dest], errors: [] }
    } catch (err) {
      return { ok: false, ...msg('export.failed', { error: errorMessage(err) }), files: [], errors: [errorMessage(err)] }
    }
  }

  async exportMany(ids: string[], formats: ExportFormat[]): Promise<ExportResult> {
    const dir = await this.dialogs.chooseDirectory()
    if (!dir) return { ok: false, cancelled: true, ...msg('export.cancelled'), files: [], errors: [] }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const target = path.join(dir, `codex-sessions-export-${stamp}`)
    const files: string[] = []
    const errors: string[] = []
    try {
      await assertDestination(target, this.homes())
      await mkdir(target, { recursive: true })
    } catch (err) {
      return { ok: false, ...msg('export.failed', { error: errorMessage(err) }), files, errors: [errorMessage(err)] }
    }
    for (const id of ids) {
      const record = this.repo.getRecord(id)
      if (!record) {
        errors.push(`${id}: session not found`)
        continue
      }
      const base = safeFileName(record.session.displayTitle, record.threadId)
      for (const format of formats) {
        if (format !== 'info' && !record.session.hasTranscript) continue
        const dest = path.join(target, base + EXPORT_EXTENSIONS[format])
        try {
          await this.writeExport(record, format, dest)
          files.push(dest)
        } catch (err) {
          errors.push(`${record.session.displayTitle} (${format}): ${errorMessage(err)}`)
        }
      }
    }
    return {
      ok: errors.length === 0,
      ...(errors.length ? msg('export.manyWithErrors', { count: files.length, path: target, errors: errors.length }) : msg('export.many', { count: files.length, path: target })),
      files,
      errors
    }
  }
}
