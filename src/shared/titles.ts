import type { RawTitle, TitleSource } from './types'

export const UNTITLED = 'Untitled'

/** Max characters of a prompt used as a fallback title. */
const PROMPT_TITLE_LENGTH = 80

/**
 * Classify the raw `title` value of a metadata object without losing
 * information: a missing field, `null` and `""` are all shown by Claude as
 * "Untitled" but are different on disk.
 */
export function classifyRawTitle(obj: Record<string, unknown> | null | undefined): RawTitle {
  if (!obj || !Object.prototype.hasOwnProperty.call(obj, 'title')) return { kind: 'missing' }
  const value = obj.title
  if (value === null) return { kind: 'null' }
  if (typeof value === 'string') {
    return value.trim() === '' ? { kind: 'empty', value } : { kind: 'string', value }
  }
  return { kind: 'invalid', type: Array.isArray(value) ? 'array' : typeof value }
}

/** Human readable rendering of a raw title for the Details panel. */
export function describeRawTitle(raw: RawTitle | undefined): string {
  if (!raw) return '(no metadata file)'
  switch (raw.kind) {
    case 'missing':
      return '(field missing)'
    case 'null':
      return 'null'
    case 'empty':
      return raw.value === '' ? '"" (empty string)' : `"${raw.value}" (whitespace only)`
    case 'string':
      return JSON.stringify(raw.value)
    case 'invalid':
      return `(invalid type: ${raw.type})`
  }
}

/**
 * A usable title: a non-empty string that is not the literal placeholder
 * "Untitled" (which some versions may persist instead of leaving it empty).
 */
export function isUsableTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const t = value.trim()
  return t.length > 0 && t.toLowerCase() !== UNTITLED.toLowerCase()
}

/** Collapse whitespace and cut a prompt down to a title-sized string. */
export function promptToTitle(prompt: string, max = PROMPT_TITLE_LENGTH): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return oneLine.slice(0, max - 1).trimEnd() + '…'
}

export interface TitleInputs {
  metadataTitle?: RawTitle
  customTitle?: string
  aiTitle?: string
  summary?: string
  firstUserMessage?: string
  lastPrompt?: string
}

/**
 * Pick the title shown in the UI.
 *
 * Order: metadata title → custom title (/rename) → AI title → legacy summary
 * → first meaningful user prompt → last prompt → "Untitled".
 */
export function resolveDisplayTitle(input: TitleInputs): { title: string; source: TitleSource } {
  const meta = input.metadataTitle
  if (meta && meta.kind === 'string' && isUsableTitle(meta.value)) {
    return { title: meta.value.trim(), source: 'metadata' }
  }
  if (isUsableTitle(input.customTitle)) return { title: input.customTitle.trim(), source: 'custom-title' }
  if (isUsableTitle(input.aiTitle)) return { title: input.aiTitle.trim(), source: 'ai-title' }
  if (isUsableTitle(input.summary)) return { title: promptToTitle(input.summary), source: 'summary' }
  if (isUsableTitle(input.firstUserMessage)) {
    return { title: promptToTitle(input.firstUserMessage), source: 'first-prompt' }
  }
  if (isUsableTitle(input.lastPrompt)) return { title: promptToTitle(input.lastPrompt), source: 'last-prompt' }
  return { title: UNTITLED, source: 'untitled' }
}

export const TITLE_SOURCE_LABEL: Record<TitleSource, string> = {
  metadata: 'Claude Desktop metadata title',
  'custom-title': 'Custom title (/rename)',
  'ai-title': 'AI-generated title',
  summary: 'Transcript summary',
  'first-prompt': 'First user prompt',
  'last-prompt': 'Last prompt',
  untitled: 'No title available'
}
