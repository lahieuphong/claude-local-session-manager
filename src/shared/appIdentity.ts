/**
 * Stable application identity. These values must never change between
 * releases: Windows ties shortcuts, taskbar pins and the uninstall entry to
 * APP_ID, and app data lives in %APPDATA%\<APP_NAME>. electron-builder.yml
 * must use the same appId/productName (checked by tests/packaging.test.ts).
 */
export const APP_ID = 'com.lahieuphong.claude-local-session-manager'
export const APP_NAME = 'Claude Local Session Manager'
export const PACKAGE_NAME = 'claude-local-session-manager'

export const GITHUB_OWNER = 'lahieuphong'
export const GITHUB_REPO = 'claude-local-session-manager'
/** Fixed HTTPS page; the renderer can only ask to open this exact URL. */
export const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`
