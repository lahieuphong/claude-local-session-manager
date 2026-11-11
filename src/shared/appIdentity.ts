import type { DistributionChannel } from './distribution'
import type { Provider } from './types'

/**
 * Stable application identity. These values must never change between
 * releases: Windows ties shortcuts, taskbar pins and the uninstall entry to
 * APP_ID, and app data lives in %APPDATA%\<APP_NAME>. electron-builder.yml
 * must use the same appId/productName (checked by tests/packaging.test.ts).
 */
export const APP_ID = 'com.lahieuphong.claude-local-session-manager'
/** Product name of the GitHub Setup / Portable builds (and of development runs). */
export const APP_NAME = 'Claude Local Session Manager'
export const PACKAGE_NAME = 'claude-local-session-manager'

/**
 * Customer-facing name of the Microsoft Store edition: the name reserved in
 * Partner Center, equal to `displayName` in store/identity.json (a test and
 * `yarn store:check` keep them equal). The Store package identity
 * (Package/Identity/Name) is a separate, immutable value.
 */
export const STORE_APP_NAME = 'LHP Local Session Manager'

export const GITHUB_OWNER = 'lahieuphong'
export const GITHUB_REPO = 'claude-local-session-manager'
/** Fixed HTTPS page; the renderer can only ask to open this exact URL. */
export const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`

export interface AppBrand {
  /** Full product name: window title, About, dialogs, reports, app data folder. */
  name: string
  /** `name` in two lines for the sidebar: "<short>" over "<sub>". */
  short: string
  sub: string
}

const BRAND_SUB = 'Session Manager'

/** The product name a build shows. Only the Microsoft Store edition differs. */
export function appBrand(channel: DistributionChannel): AppBrand {
  const name = channel === 'store' ? STORE_APP_NAME : APP_NAME
  return { name, short: name.slice(0, -BRAND_SUB.length).trim(), sub: BRAND_SUB }
}

/**
 * The name at the top of the sidebar for the tool on screen: "Codex Local"
 * while Codex is. Only a name that says "Claude" changes (the Store
 * edition's does not); the product's own name stays everywhere else.
 */
export function sidebarName(brand: AppBrand, provider: Provider): string {
  return provider === 'codex' ? brand.short.replace(/^Claude(?= )/, 'Codex') : brand.short
}
