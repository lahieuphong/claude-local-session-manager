/**
 * Messages produced by the main process (results, guards, warnings) carry a
 * translation key + params next to their English text. The renderer shows
 * the text in the user's language; logs and copied reports stay English.
 *
 * A param may itself be a MessageRef (e.g. "Real deletion was not armed:
 * {{reason}}" where the reason is a guard message), so nested messages are
 * translated too.
 */
export type MessageParam = string | number | MessageRef
export type MessageParams = Record<string, MessageParam>

export interface MessageRef {
  key: string
  params?: MessageParams
}

export type MessageDict = { [k: string]: string | MessageDict }

export function isMessageRef(v: unknown): v is MessageRef {
  return !!v && typeof v === 'object' && typeof (v as MessageRef).key === 'string'
}

function lookup(dict: MessageDict, path: string): string | undefined {
  let node: string | MessageDict | undefined = dict
  for (const part of path.split('.')) {
    if (!node || typeof node === 'string') return undefined
    node = node[part]
  }
  return typeof node === 'string' ? node : undefined
}

/** Plural suffix used by i18next for the languages this app ships (one/other). */
function pluralKey(key: string, count: number, locale: string): string[] {
  const rule = new Intl.PluralRules(locale).select(count)
  return [`${key}_${rule}`, `${key}_other`]
}

/**
 * i18next-compatible resolution: {{name}} interpolation, _one/_other plural
 * keys when params.count is a number, nested MessageRef params.
 */
export function resolveMessage(dict: MessageDict, key: string, params: MessageParams = {}, locale = 'en'): string | undefined {
  let template: string | undefined
  if (typeof params.count === 'number') {
    for (const k of pluralKey(key, params.count, locale)) {
      template ??= lookup(dict, k)
    }
  }
  template ??= lookup(dict, key)
  if (template === undefined) return undefined
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    if (!(name in params)) return `{{${name}}}`
    const v = params[name]
    if (isMessageRef(v)) return resolveMessage(dict, v.key, v.params, locale) ?? v.key
    return String(v)
  })
}

/**
 * Translate a main-process message with an i18next-style `t`; nested message
 * params are translated first. Falls back to the English text when the key
 * is unknown (e.g. a raw OS error).
 */
export function translateRef(
  t: (key: string, params?: Record<string, string | number>) => string,
  exists: (key: string) => boolean,
  ref: MessageRef | undefined,
  fallback: string
): string {
  if (!ref || (!exists(`messages:${ref.key}`) && !exists(`messages:${ref.key}_other`))) return fallback
  const params: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(ref.params ?? {})) params[k] = isMessageRef(v) ? translateRef(t, exists, v, v.key) : v
  return t(`messages:${ref.key}`, params)
}
