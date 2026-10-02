import en from '../../shared/locales/en/messages.json'
import vi from '../../shared/locales/vi/messages.json'
import zhCN from '../../shared/locales/zh-CN/messages.json'
import { INTL_LOCALE, type SupportedLocale } from '../../shared/locale'
import { resolveMessage, type MessageDict, type MessageParams, type MessageRef } from '../../shared/messages'

const DICTS: Record<SupportedLocale, MessageDict> = { en, vi, 'zh-CN': zhCN }

/** English text of a message key (logs, copied reports, `message` fields). */
export function msgText(key: string, params?: MessageParams): string {
  const text = resolveMessage(en, key, params, 'en')
  if (text === undefined) throw new Error(`Missing English message: ${key}`)
  return text
}

/** `{ message, msg }` for result objects: English text + key the renderer translates. */
export function msg(key: string, params?: MessageParams): { message: string; msg: MessageRef } {
  return { message: msgText(key, params), msg: params ? { key, params } : { key } }
}

export function ref(key: string, params?: MessageParams): MessageRef {
  msgText(key, params) // fail fast on a typo'd key
  return params ? { key, params } : { key }
}

/** Text in the UI language, for the few strings the main process shows itself (native dialogs). */
export function localText(locale: SupportedLocale, key: string, params?: MessageParams): string {
  return resolveMessage(DICTS[locale], key, params, INTL_LOCALE[locale]) ?? msgText(key, params)
}

/**
 * English text → key for messages stored as plain strings (session problems),
 * so the scan result can carry `problemMsgs` without changing `problems`.
 */
const textRefs = new Map<string, MessageRef>()

export function trackedText(key: string, params?: MessageParams): string {
  const text = msgText(key, params)
  if (textRefs.size > 10_000) textRefs.clear()
  textRefs.set(text, params ? { key, params } : { key })
  return text
}

export function refsFor(texts: string[]): Record<string, MessageRef> {
  const out: Record<string, MessageRef> = {}
  for (const t of texts) {
    const r = textRefs.get(t)
    if (r) out[t] = r
  }
  return out
}
