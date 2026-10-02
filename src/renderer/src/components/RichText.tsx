import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'

/**
 * Translate `key` and render the given params as <code> (exact phrases the
 * user must type, IDs). The phrases themselves are never translated.
 */
export function tCode(t: TFunction, key: string, values: Record<string, string>): ReactNode[] {
  const markers = Object.fromEntries(Object.keys(values).map((k) => [k, `\u0001${k}\u0001`]))
  return t(key, markers)
    .split('\u0001')
    .map((part, i) =>
      i % 2 === 1 ? (
        <code key={i} className="phrase">
          {values[part] ?? part}
        </code>
      ) : (
        part
      )
    )
}
