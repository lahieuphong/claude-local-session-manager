export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`
}

export function formatDateTime(ms: number | undefined | null): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// Locale-aware formatting for the UI (Intl). The functions above stay English
// for logs and copied reports.
// ---------------------------------------------------------------------------

const numberFormats = new Map<string, Intl.NumberFormat>()
function numberFormat(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${digits}`
  let f = numberFormats.get(key)
  if (!f) {
    f = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 })
    numberFormats.set(key, f)
  }
  return f
}

/** 1.2 MB / 1,2 MB / 1.2 MB — localized number, unit symbols are the same in every UI language. */
export function formatBytesIntl(bytes: number | undefined | null, locale: string): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${numberFormat(locale, 0).format(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${numberFormat(locale, digits).format(value)} ${units[unit]}`
}

export function formatCountIntl(n: number | undefined | null, locale: string): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  return numberFormat(locale, 0).format(n)
}

const dateFormats = new Map<string, Intl.DateTimeFormat>()
function dateFormat(locale: string, kind: 'datetime' | 'date' | 'full'): Intl.DateTimeFormat {
  const key = `${locale}|${kind}`
  let f = dateFormats.get(key)
  if (!f) {
    const opts: Intl.DateTimeFormatOptions =
      kind === 'date'
        ? { year: 'numeric', month: 'short', day: 'numeric' }
        : kind === 'full'
          ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
          : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    f = new Intl.DateTimeFormat(locale, opts)
    dateFormats.set(key, f)
  }
  return f
}

export function formatDateTimeIntl(ms: number | undefined | null, locale: string, kind: 'datetime' | 'date' | 'full' = 'datetime'): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  return dateFormat(locale, kind).format(new Date(ms))
}

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>()

/** "5 min ago" / "5 phút trước" / "5分钟前"; older than a week → localized date. */
export function formatRelativeIntl(ms: number | undefined | null, locale: string, now = Date.now()): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const diff = now - ms
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < 0 || diff >= 7 * day) return formatDateTimeIntl(ms, locale, 'date')
  let rtf = relativeFormats.get(locale)
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
    relativeFormats.set(locale, rtf)
  }
  if (diff < min) return rtf.format(0, 'second')
  if (diff < hour) return rtf.format(-Math.floor(diff / min), 'minute')
  if (diff < day) return rtf.format(-Math.floor(diff / hour), 'hour')
  return rtf.format(-Math.floor(diff / day), 'day')
}
