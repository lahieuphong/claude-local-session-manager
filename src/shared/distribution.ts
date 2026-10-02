/**
 * Windows distribution channels. Each build knows which one it is from the
 * `distributionChannel` field electron-builder writes into the packaged
 * package.json (extraMetadata), never from its file name.
 *
 *   github      — NSIS Setup / Portable from GitHub Releases (electron-updater)
 *   store       — Microsoft Store package (updates managed by the Store)
 *   development — `yarn dev` / unpackaged runs
 */
export const DISTRIBUTION_CHANNELS = ['github', 'store', 'development'] as const
export type DistributionChannel = (typeof DISTRIBUTION_CHANNELS)[number]

/** Development-only override (e.g. to review the Store UI with `yarn dev`). Packaged builds ignore it. */
export const DISTRIBUTION_ENV = 'CLAUDE_SESSION_MANAGER_DISTRIBUTION'

export function normalizePackagedChannel(value: unknown): 'github' | 'store' | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  return v === 'github' || v === 'store' ? v : null
}

export function resolveDistributionChannel(opts: {
  isPackaged: boolean
  /** `distributionChannel` from the packaged package.json. */
  packagedChannel: unknown
  /** Electron's `process.windowsStore`: true when running from an AppX/MSIX package. */
  windowsStore: boolean
  env?: Record<string, string | undefined>
}): DistributionChannel {
  if (!opts.isPackaged) {
    // Unpackaged runs are development; the env override only changes the UI/updater wiring, never packaging.
    return normalizePackagedChannel(opts.env?.[DISTRIBUTION_ENV]) === 'store' ? 'store' : 'development'
  }
  // Running inside a Store/AppX package is always the Store channel: the GitHub
  // installer must never run over a packaged app, whatever the metadata says.
  if (opts.windowsStore || normalizePackagedChannel(opts.packagedChannel) === 'store') return 'store'
  return 'github'
}

/** Microsoft Store product IDs are 12 characters, starting with 9 (e.g. from Partner Center → Product identity). */
export const STORE_PRODUCT_ID_RE = /^9[0-9A-Z]{11}$/

export function isValidStoreProductId(value: unknown): value is string {
  return typeof value === 'string' && STORE_PRODUCT_ID_RE.test(value)
}

/** Official Microsoft Store URI for the Store's "Downloads and updates" page. */
export const STORE_UPDATES_URI = 'ms-windows-store://downloadsandupdates'

/** Product page in the Microsoft Store app, only when a real product ID is configured. */
export function storeProductPageUri(productId: unknown): string | null {
  return isValidStoreProductId(productId) ? `ms-windows-store://pdp/?ProductId=${productId}` : null
}
