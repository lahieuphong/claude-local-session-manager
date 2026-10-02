import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isValidStoreProductId, resolveDistributionChannel, type DistributionChannel } from '../shared/distribution'

export interface DistributionInfo {
  channel: DistributionChannel
  /** Microsoft Store product ID baked into Store builds once it exists; never guessed. */
  storeProductId: string | null
}

/**
 * The channel marker lives in the packaged package.json (electron-builder
 * extraMetadata): `distributionChannel` = "github" | "store", plus
 * `storeProductId` for Store builds. Read once at startup.
 */
export function readDistribution(opts: {
  appPath: string
  isPackaged: boolean
  windowsStore: boolean
  env: Record<string, string | undefined>
}): DistributionInfo {
  let meta: Record<string, unknown> = {}
  try {
    meta = JSON.parse(readFileSync(path.join(opts.appPath, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    /* unreadable metadata: treated as no marker */
  }
  const channel = resolveDistributionChannel({
    isPackaged: opts.isPackaged,
    packagedChannel: meta.distributionChannel,
    windowsStore: opts.windowsStore,
    env: opts.env
  })
  return {
    channel,
    storeProductId: channel === 'store' && isValidStoreProductId(meta.storeProductId) ? meta.storeProductId : null
  }
}
