/**
 * UI languages. Add a locale here (and its JSON files under
 * src/renderer/src/i18n/locales/<locale>/) to support it — e.g. 'zh-TW' later.
 */
export const SUPPORTED_LOCALES = ['en', 'vi', 'zh-CN'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export const SOURCE_LOCALE: SupportedLocale = 'en'

/** Shown in the language selector (each language in its own script; no flags). */
export const LOCALE_LABELS: Record<SupportedLocale, { native: string; short: string }> = {
  en: { native: 'English', short: 'EN' },
  vi: { native: 'Tiếng Việt', short: 'VI' },
  'zh-CN': { native: '简体中文', short: '中文' }
}

/** BCP 47 tag used for Intl date/number formatting. */
export const INTL_LOCALE: Record<SupportedLocale, string> = { en: 'en-US', vi: 'vi-VN', 'zh-CN': 'zh-CN' }

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/**
 * Map one OS/app language tag to a supported UI locale:
 *   vi, vi-VN, …                     → vi
 *   zh-CN, zh-SG, zh-Hans(-*), zh    → zh-CN
 *   en, en-*                         → en
 *   anything else (incl. zh-TW/zh-Hant until it is added) → null
 */
export function mapSystemLocale(tag: string): SupportedLocale | null {
  const t = tag.trim().replace(/_/g, '-').toLowerCase()
  if (!t) return null
  if (t === 'vi' || t.startsWith('vi-')) return 'vi'
  if (t === 'zh' || t === 'zh-cn' || t === 'zh-sg' || t === 'zh-hans' || t.startsWith('zh-hans-') || t.startsWith('zh-cn-')) return 'zh-CN'
  if (t === 'en' || t.startsWith('en-')) return 'en'
  return null
}

/**
 * The UI language: the user's saved choice if any, otherwise the first OS
 * language we support, otherwise English.
 */
export function resolveLocale(saved: unknown, systemLanguages: readonly string[]): SupportedLocale {
  if (isSupportedLocale(saved)) return saved
  for (const tag of systemLanguages) {
    const mapped = mapSystemLocale(tag)
    if (mapped) return mapped
  }
  return SOURCE_LOCALE
}
