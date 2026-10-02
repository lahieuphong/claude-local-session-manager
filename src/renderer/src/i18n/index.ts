import i18n, { type TFunction } from 'i18next'
import { useMemo } from 'react'
import { initReactI18next, useTranslation } from 'react-i18next'
import {
  INTL_LOCALE,
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  resolveLocale,
  type SupportedLocale
} from '../../../shared/locale'
import { NAMESPACES, RESOURCES } from '../../../shared/locales'
import { translateRef, type MessageRef } from '../../../shared/messages'
import {
  formatBytesIntl,
  formatCountIntl,
  formatDateTimeIntl,
  formatRelativeIntl
} from '../../../shared/format'

/**
 * Per-viewer mirror of the saved language, read before the first paint so the
 * window never flashes another language. The real preference lives in the
 * main process settings file.
 */
const MIRROR_KEY = 'uiLanguage'

function readMirror(): string | null {
  try {
    return localStorage.getItem(MIRROR_KEY)
  } catch {
    return null
  }
}

const startLocale = resolveLocale(readMirror(), navigator.languages?.length ? navigator.languages : [navigator.language])

void i18n.use(initReactI18next).init({
  resources: RESOURCES,
  lng: startLocale,
  fallbackLng: SOURCE_LOCALE,
  supportedLngs: [...SUPPORTED_LOCALES],
  ns: [...NAMESPACES],
  defaultNS: 'common',
  interpolation: { escapeValue: false }, // React escapes
  returnEmptyString: false,
  initAsync: false,
  react: { useSuspense: false }
})
document.documentElement.lang = startLocale

export function currentLocale(): SupportedLocale {
  return isSupportedLocale(i18n.language) ? i18n.language : SOURCE_LOCALE
}

/** Switch the UI language immediately (no restart). */
export function applyLocale(locale: SupportedLocale): void {
  if (i18n.language !== locale) void i18n.changeLanguage(locale)
  document.documentElement.lang = locale
  try {
    localStorage.setItem(MIRROR_KEY, locale)
  } catch {
    /* mirror only */
  }
}

/** Translate a main-process message; falls back to its English text. Nested message params are translated too. */
export function translateMsg(t: TFunction, ref: MessageRef | undefined, fallback: string): string {
  return translateRef((key, params) => t(key, params), (key) => i18n.exists(key), ref, fallback)
}

export interface Formatters {
  locale: SupportedLocale
  bytes(n: number | undefined | null): string
  count(n: number | undefined | null): string
  dateTime(ms: number | undefined | null): string
  fullDateTime(ms: number | undefined | null): string
  date(ms: number | undefined | null): string
  relative(ms: number | undefined | null): string
  msg(ref: MessageRef | undefined, fallback: string): string
}

/** Locale-bound formatters and message translation; re-renders on language change. */
export function useFmt(): Formatters {
  const { t, i18n: inst } = useTranslation()
  const locale = isSupportedLocale(inst.language) ? inst.language : SOURCE_LOCALE
  return useMemo(() => {
    const tag = INTL_LOCALE[locale]
    return {
      locale,
      bytes: (n) => formatBytesIntl(n, tag),
      count: (n) => formatCountIntl(n, tag),
      dateTime: (ms) => formatDateTimeIntl(ms, tag),
      fullDateTime: (ms) => formatDateTimeIntl(ms, tag, 'full'),
      date: (ms) => formatDateTimeIntl(ms, tag, 'date'),
      relative: (ms) => formatRelativeIntl(ms, tag),
      msg: (ref, fallback) => translateMsg(t, ref, fallback)
    }
  }, [locale, t])
}

export default i18n
