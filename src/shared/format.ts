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

export function formatRelative(ms: number | undefined | null, now = Date.now()): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const diff = now - ms
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < 0) return formatDateTime(ms)
  if (diff < min) return 'just now'
  if (diff < hour) return `${Math.floor(diff / min)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`
  return formatDateTime(ms).slice(0, 10)
}

export function formatCount(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US')
}
