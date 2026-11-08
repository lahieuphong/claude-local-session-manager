import type { LiveCliSession } from '../../shared/types'
import { pathKey } from '../util/fsx'
import { isStrictlyInside } from '../security/pathValidator'
import { ownsStore, type AccountRoots } from './claudeDiscovery'
import type { SessionRecord } from './sessionBuilder'
import type { UuidDirEntry } from './sessionScanner'

/**
 * Work out which Claude accounts each session belongs to, for the account switcher.
 * This only decides where a session is listed: no safety check depends on it.
 *
 * Accounts may share one session store through folder links, as on a PC where
 * `~/.claude-accounts/claude-2/projects` is a junction to `~/.claude/projects`.
 * A transcript does not say who wrote it, so the evidence is what Claude Code leaves
 * in each account's own folders: `session-env/<uuid>` and the registry of running
 * sessions. A session with no evidence is listed under the account whose folder
 * really holds the store (it predates the other accounts, or left no trace).
 */
export function attributeSessions(input: {
  records: Iterable<SessionRecord>
  accounts: AccountRoots[]
  sessionEnvByRoot: Map<string, Map<string, UuidDirEntry>>
  liveSessions: Array<Pick<LiveCliSession, 'sessionId' | 'registryDir'>>
}): void {
  const { accounts } = input
  /** How many accounts reach this folder (through links, several may). */
  const sharedBy = (key: 'sessionEnvRoot' | 'liveSessionsDir', root: string): number => accounts.filter((a) => { const own = a[key]; return !!own && pathKey(own) === pathKey(root) }).length

  // uuid → accounts with their own evidence of using it. A folder shared between accounts proves nothing.
  const usedBy = new Map<string, Set<string>>()
  const add = (uuid: string, accountId: string): void => {
    const key = uuid.toLowerCase()
    if (!usedBy.has(key)) usedBy.set(key, new Set())
    usedBy.get(key)?.add(accountId)
  }
  for (const a of accounts) {
    if (a.sessionEnvRoot && sharedBy('sessionEnvRoot', a.sessionEnvRoot) === 1) {
      for (const uuid of input.sessionEnvByRoot.get(pathKey(a.sessionEnvRoot))?.keys() ?? []) add(uuid, a.id)
    }
    if (a.liveSessionsDir && sharedBy('liveSessionsDir', a.liveSessionsDir) === 1) {
      const dir = pathKey(a.liveSessionsDir)
      for (const live of input.liveSessions) if (live.registryDir && pathKey(live.registryDir) === dir) add(live.sessionId, a.id)
    }
  }

  const holds = (a: AccountRoots, file: string | undefined): boolean => !!file && !!a.projectsRoot && isStrictlyInside(file, a.projectsRoot)

  for (const r of input.records) {
    const file = r.transcript?.filePath ?? r.dataDir?.dirPath
    const inStore = accounts.filter((a) => holds(a, file))
    const candidates = inStore.length ? inStore : accounts
    const uuids = [...r.ownedUuids, ...r.guardUuids].map((u) => u.toLowerCase())
    const used = candidates.filter((a) => uuids.some((u) => usedBy.get(u)?.has(a.id)))
    const owner = candidates.find(ownsStore) ?? candidates[0]
    r.session.accountIds = used.length ? used.map((a) => a.id) : owner ? [owner.id] : []
  }
}
