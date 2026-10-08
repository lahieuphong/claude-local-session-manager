import path from 'node:path'
import type { DistributionChannel } from '../../shared/distribution'
import type { DeletePlanItem } from '../../shared/types'
import { isInsideOrEqual } from '../security/pathValidator'

/**
 * What a build may change on disk, decided by its distribution channel.
 *
 * GitHub Setup / Portable (and development runs) are ordinary desktop
 * processes: every write reaches the real file, so nothing is restricted.
 *
 * The Microsoft Store edition is an MSIX-packaged full-trust app with only
 * the runFullTrust capability. For such a package Windows redirects files it
 * newly creates under the user's AppData to a private per-package location
 * (https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-behind-the-scenes).
 * Claude Desktop keeps its session metadata under AppData; archiving,
 * restoring or deleting a Desktop session needs new files there (temp file +
 * rename, `deleted_<id>` markers). This app would see those writes succeed
 * while Claude Desktop never sees them. So the Store edition does not create,
 * replace, rename or delete Claude files inside a Claude Desktop data root or
 * elsewhere under AppData: it refuses the whole operation before touching any
 * file. Reading is unaffected, and so is everything under ~/.claude outside
 * AppData. The app's own data (settings, hidden list, scan cache, logs in its
 * userData folder) is not covered by this policy and is written as usual.
 */
export interface PackagingPolicy {
  channel: DistributionChannel
  /** True when Windows isolates this build's AppData writes (Microsoft Store edition). */
  isolatesAppData: boolean
  /** Folders in which this build must not create, replace or delete Claude files, nor write exports. Empty when nothing is isolated. */
  isolatedRoots(desktopRoots?: readonly string[]): string[]
  /** The isolated folder that contains `target`, or null when writing there is fine. */
  isolatedRootOf(target: string, desktopRoots?: readonly string[]): string | null
}

/** The folders that tell where the user's AppData is (injected so tests use a fake profile). */
export interface PackagingEnv {
  homedir: string
  appData?: string
  localAppData?: string
}

export function packagingPolicy(channel: DistributionChannel, env: PackagingEnv): PackagingPolicy {
  const isolatesAppData = channel === 'store'
  const appDataRoots = isolatesAppData
    ? [env.appData, env.localAppData, env.homedir ? path.join(env.homedir, 'AppData') : undefined].filter((p): p is string => !!p)
    : []
  const isolatedRoots = (desktopRoots: readonly string[] = []): string[] => (isolatesAppData ? [...appDataRoots, ...desktopRoots] : [])
  return {
    channel,
    isolatesAppData,
    isolatedRoots,
    isolatedRootOf: (target, desktopRoots) => isolatedRoots(desktopRoots).find((root) => isInsideOrEqual(target, root)) ?? null
  }
}

/**
 * The Claude files of a delete plan that this build must not touch. The
 * manager's own records (hidden list, scan cache) are this app's data and are
 * never part of the answer. Any hit means the whole session plan is refused.
 */
export function isolatedPlanItems(items: readonly DeletePlanItem[], policy: PackagingPolicy | undefined, desktopRoots?: readonly string[]): DeletePlanItem[] {
  if (!policy?.isolatesAppData) return []
  return items.filter((i) => i.kind !== 'manager-record' && policy.isolatedRootOf(i.path, desktopRoots) !== null)
}
