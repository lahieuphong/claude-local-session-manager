import { isSupportedLocale, type SupportedLocale } from '../../shared/locale'

/**
 * Store screenshot mode: a development-only way to render the real UI on
 * static demo data (src/main/screenshot/fixtures.ts) for Microsoft Store
 * listing screenshots (`yarn store:screenshots`).
 *
 *   CLAUDE_SESSION_MANAGER_SCREENSHOT_MODE=true         enable (unpackaged runs only)
 *   CLAUDE_SESSION_MANAGER_SCREENSHOT_LOCALE=vi         optional UI language (en | vi | zh-CN)
 *
 * In this mode the main process never creates the session repository, the
 * process service, the archive/delete/export services, the settings file or
 * the updater: every IPC call is answered from the fixture, every mutating
 * call is refused, and the app stays in Safe Mode (arming is refused). A
 * packaged build ignores both variables entirely.
 */
export const SCREENSHOT_MODE_ENV = 'CLAUDE_SESSION_MANAGER_SCREENSHOT_MODE'
export const SCREENSHOT_LOCALE_ENV = 'CLAUDE_SESSION_MANAGER_SCREENSHOT_LOCALE'

export interface ScreenshotModeConfig {
  /** UI language; null = follow the system language. */
  locale: SupportedLocale | null
}

const ENABLED = /^(1|true|yes|on)$/i

export function resolveScreenshotMode(opts: { isPackaged: boolean; env: Record<string, string | undefined> }): ScreenshotModeConfig | null {
  if (opts.isPackaged) return null
  if (!ENABLED.test(opts.env[SCREENSHOT_MODE_ENV]?.trim() ?? '')) return null
  const locale = opts.env[SCREENSHOT_LOCALE_ENV]?.trim()
  return { locale: isSupportedLocale(locale) ? locale : null }
}
