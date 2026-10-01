/**
 * Shorten a path for display when "Show raw paths" is off:
 * C:\Users\<name>\.claude\projects\… → ~\.claude\projects\…
 * C:\Users\<name>\AppData\Local\Packages\… → %LOCALAPPDATA%\Packages\…
 */
export function displayPath(p: string | undefined, raw: boolean): string {
  if (!p) return '—'
  if (raw) return p
  const m = /^([A-Za-z]:\\Users\\[^\\]+)(\\.*)?$/.exec(p)
  if (!m) return p
  const rest = m[2] ?? ''
  if (/^\\AppData\\Local(\\|$)/i.test(rest)) return '%LOCALAPPDATA%' + rest.slice('\\AppData\\Local'.length)
  if (/^\\AppData\\Roaming(\\|$)/i.test(rest)) return '%APPDATA%' + rest.slice('\\AppData\\Roaming'.length)
  return '~' + rest
}
