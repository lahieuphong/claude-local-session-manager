import { createWriteStream } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import type { ExportFormat, ExportResult } from '../../shared/types'
import { formatDateTime } from '../../shared/format'
import { isInsideClaudeStorage, type AllowedRoots } from '../security/pathValidator'
import { pathKey } from '../util/fsx'
import { errorMessage, logger } from '../util/logger'
import type { SessionRecord } from './sessionBuilder'
import type { SessionRepository } from './sessionRepository'
import { extractUserText, readJsonlLines } from './transcriptParser'

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  jsonl: '.jsonl',
  info: '.info.json',
  markdown: '.md'
}

export function safeFileName(title: string, id: string): string {
  const base = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '')
  return `${base || 'session'}-${id.slice(0, 8)}`
}

function assertDestination(dest: string, record: SessionRecord, roots: AllowedRoots & { claudeHome?: string }): void {
  if (!path.isAbsolute(dest)) throw new Error('Export destination must be an absolute path')
  const sources = [record.transcript?.filePath, record.metadata?.filePath].filter(Boolean) as string[]
  if (sources.some((s) => pathKey(s) === pathKey(dest))) throw new Error('Export destination is the original file')
  if (isInsideClaudeStorage(dest, roots)) throw new Error('Refusing to export into Claude storage folders')
}

/** Copy the raw transcript. The original is only read. */
export async function exportJsonl(record: SessionRecord, dest: string): Promise<void> {
  if (!record.transcript) throw new Error('This session has no transcript file')
  await copyFile(record.transcript.filePath, dest)
}

export async function exportInfo(record: SessionRecord, rawMetadata: string | undefined, dest: string): Promise<void> {
  let metadata: unknown = undefined
  if (rawMetadata !== undefined) {
    try {
      metadata = JSON.parse(rawMetadata)
    } catch {
      metadata = rawMetadata
    }
  }
  const info = {
    exportedAt: new Date().toISOString(),
    exportedBy: 'Claude Local Session Manager (unofficial)',
    session: record.session,
    metadata
  }
  const stream = createWriteStream(dest, { encoding: 'utf8' })
  stream.end(JSON.stringify(info, null, 2))
  await once(stream, 'finish')
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** Render a readable conversation (user prompts, assistant text, tool calls). */
export async function exportMarkdown(record: SessionRecord, dest: string): Promise<void> {
  if (!record.transcript) throw new Error('This session has no transcript file')
  const s = record.session
  const out = createWriteStream(dest, { encoding: 'utf8' })
  const write = async (chunk: string): Promise<void> => {
    if (!out.write(chunk)) await once(out, 'drain')
  }
  try {
    await write(`# ${s.displayTitle}\n\n`)
    await write(`| | |\n|---|---|\n`)
    await write(`| Session | \`${s.cliSessionId ?? s.id}\` |\n`)
    if (s.projectPath) await write(`| Project | \`${s.projectPath}\` |\n`)
    await write(`| Created | ${formatDateTime(s.createdAt)} |\n| Updated | ${formatDateTime(s.updatedAt)} |\n`)
    if (s.model) await write(`| Model | ${s.model} |\n`)
    await write(`\n> Exported by Claude Local Session Manager (unofficial). Tool output and thinking are omitted.\n\n---\n\n`)

    let lastAssistantId: string | undefined
    for await (const line of readJsonlLines(record.transcript.filePath)) {
      if (!line.text.trim()) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(line.text) as Record<string, unknown>
      } catch {
        continue
      }
      const when = typeof rec.timestamp === 'string' ? formatDateTime(Date.parse(rec.timestamp)) : ''
      if (rec.type === 'user') {
        const text = extractUserText(rec)
        if (!text) continue
        lastAssistantId = undefined
        await write(`## User${when ? ` · ${when}` : ''}\n\n${text}\n\n`)
      } else if (rec.type === 'assistant' && rec.isSidechain !== true) {
        const message = (rec.message ?? {}) as Record<string, unknown>
        const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []
        const parts: string[] = []
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim())
          else if (block?.type === 'tool_use') {
            const input = truncate(JSON.stringify(block.input ?? {}), 300)
            parts.push(`> Tool: **${String(block.name)}** \`${input.replace(/`/g, "'")}\``)
          }
        }
        if (!parts.length) continue
        const id = typeof message.id === 'string' ? message.id : undefined
        if (!id || id !== lastAssistantId) await write(`## Assistant${when ? ` · ${when}` : ''}\n\n`)
        lastAssistantId = id
        await write(parts.join('\n\n') + '\n\n')
      }
    }
  } finally {
    out.end()
    await once(out, 'finish').catch(() => undefined)
  }
}

export interface ExportDialogs {
  chooseFile(defaultName: string, format: ExportFormat): Promise<string | null>
  chooseDirectory(): Promise<string | null>
}

export class ExportService {
  constructor(
    private repo: SessionRepository,
    private dialogs: ExportDialogs
  ) {}

  private roots(): AllowedRoots & { claudeHome?: string } {
    const roots = this.repo.getAllowedRoots()
    if (!roots) throw new Error('Scan sessions first')
    return { ...roots, claudeHome: this.repo.getRoots()?.claudeHome }
  }

  async writeExport(record: SessionRecord, format: ExportFormat, dest: string): Promise<void> {
    assertDestination(dest, record, this.roots())
    if (format === 'jsonl') await exportJsonl(record, dest)
    else if (format === 'markdown') await exportMarkdown(record, dest)
    else {
      const details = await this.repo.getDetails(record.session.id)
      await exportInfo(record, details?.rawMetadata, dest)
    }
    logger.info(`Exported ${format} of ${record.session.id} to ${dest}`)
  }

  async exportOne(id: string, format: ExportFormat): Promise<ExportResult> {
    const record = this.repo.getRecord(id)
    if (!record) return { ok: false, message: 'Session not found', files: [], errors: [] }
    if (format !== 'info' && !record.transcript) {
      return { ok: false, message: 'This session has no transcript to export.', files: [], errors: [] }
    }
    const name = safeFileName(record.session.displayTitle, record.session.cliSessionId ?? id) + EXPORT_EXTENSIONS[format]
    const dest = await this.dialogs.chooseFile(name, format)
    if (!dest) return { ok: false, cancelled: true, message: 'Export cancelled', files: [], errors: [] }
    try {
      await this.writeExport(record, format, dest)
      return { ok: true, message: `Exported to ${dest}`, files: [dest], errors: [] }
    } catch (err) {
      return { ok: false, message: `Export failed: ${errorMessage(err)}`, files: [], errors: [errorMessage(err)] }
    }
  }

  async exportMany(ids: string[], formats: ExportFormat[]): Promise<ExportResult> {
    const dir = await this.dialogs.chooseDirectory()
    if (!dir) return { ok: false, cancelled: true, message: 'Export cancelled', files: [], errors: [] }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const target = path.join(dir, `claude-sessions-export-${stamp}`)
    const files: string[] = []
    const errors: string[] = []
    try {
      if (isInsideClaudeStorage(target, this.roots())) throw new Error('Refusing to export into Claude storage folders')
      await mkdir(target, { recursive: true })
    } catch (err) {
      return { ok: false, message: `Export failed: ${errorMessage(err)}`, files, errors: [errorMessage(err)] }
    }
    for (const id of ids) {
      const record = this.repo.getRecord(id)
      if (!record) {
        errors.push(`${id}: session not found`)
        continue
      }
      const base = safeFileName(record.session.displayTitle, record.session.cliSessionId ?? id)
      for (const format of formats) {
        if (format !== 'info' && !record.transcript) continue
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
      message: errors.length ? `Exported ${files.length} file(s) to ${target}; ${errors.length} error(s).` : `Exported ${files.length} file(s) to ${target}`,
      files,
      errors
    }
  }
}
