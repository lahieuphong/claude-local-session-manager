import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import type { DesktopRootInfo, ScanIssue, ScanSnapshot, SessionDetails } from '../../shared/types'
import { errorMessage, logger } from '../util/logger'
import { msg } from '../util/messages'
import type { AllowedRoots } from '../security/pathValidator'
import type { ScanCache } from './cacheService'
import { discoverRoots, toAllowedRoots, toStorageRoots, type DiscoveredRoots, type DiscoveryEnv } from './claudeDiscovery'
import type { ManagerHiddenStore } from './managerHiddenStore'
import { TOMBSTONE_PREFIX, scanDesktopRoot, stripBom, transcriptIdsOf, type DesktopRootScan } from './metadataParser'
import type { ProcessService } from './processService'
import { canonicalizeProjects, decodeProjectDirName, sanitizeProjectPath } from './projectResolver'
import { buildSessions, knownWorkspacePaths, type SessionRecord } from './sessionBuilder'
import { scanProjects, scanUuidDirs, type ProjectsScan, type ScanOptions } from './sessionScanner'
import { pathKey } from '../util/fsx'

export interface RepositoryDeps {
  env: DiscoveryEnv
  cache: ScanCache
  hidden: ManagerHiddenStore
  processService: ProcessService
  scanOptions?: ScanOptions
  /** Disable filesystem decoding of encoded project folder names (tests). */
  decodeFolderNames?: boolean
}

/**
 * Holds the result of the last scan: the normalized sessions shown in the UI
 * and the registry `sessionId → exact files` that every action uses.
 */
export class SessionRepository extends EventEmitter {
  private roots: DiscoveredRoots | null = null
  private snapshot: ScanSnapshot | null = null
  private records = new Map<string, SessionRecord>()
  private inflight: Promise<ScanSnapshot> | null = null
  private queued: Promise<ScanSnapshot> | null = null

  constructor(private deps: RepositoryDeps) {
    super()
  }

  getSnapshot(): ScanSnapshot | null {
    return this.snapshot
  }

  getRecord(id: string): SessionRecord | undefined {
    return this.records.get(id)
  }

  getRoots(): DiscoveredRoots | null {
    return this.roots
  }

  getAllowedRoots(): AllowedRoots | null {
    return this.roots ? toAllowedRoots(this.roots) : null
  }

  /** Every known project workspace path (never a delete target, never inside a delete target). */
  getWorkspacePaths(): string[] {
    return knownWorkspacePaths(this.records.values())
  }

  getCache(): ScanCache {
    return this.deps.cache
  }

  getHiddenStore(): ManagerHiddenStore {
    return this.deps.hidden
  }

  isScanning(): boolean {
    return this.inflight !== null
  }

  /**
   * Scan everything. A call during a running scan waits for it and then runs
   * exactly one follow-up scan shared by all such callers (so results always
   * reflect changes made after the request).
   */
  scan(reason = 'manual'): Promise<ScanSnapshot> {
    if (this.inflight) {
      this.queued ??= this.inflight
        .catch(() => undefined)
        .then(() => {
          this.queued = null
          return this.scan(reason)
        })
      return this.queued
    }
    this.emit('scan-state', { scanning: true, reason })
    this.inflight = this.doScan(reason).finally(() => {
      this.inflight = null
      this.emit('scan-state', { scanning: false })
    })
    return this.inflight
  }

  private async doScan(reason: string): Promise<ScanSnapshot> {
    const started = Date.now()
    const issues: ScanIssue[] = []
    const roots = await discoverRoots(this.deps.env)
    this.roots = roots
    this.deps.processService.setLiveSessionsDir(roots.liveSessionsDir)

    const [desktop, projects, fileHistory, sessionEnv, processStatus] = await Promise.all([
      Promise.all(roots.desktopRoots.map((d) => scanDesktopRoot(d.path))),
      roots.projectsRoot
        ? scanProjects(roots.projectsRoot, this.deps.cache, this.deps.scanOptions)
        : Promise.resolve(null),
      scanUuidDirs(roots.fileHistoryRoot).catch((err) => {
        issues.push({ path: roots.fileHistoryRoot ?? undefined, message: errorMessage(err) })
        return new Map()
      }),
      scanUuidDirs(roots.sessionEnvRoot).catch((err) => {
        issues.push({ path: roots.sessionEnvRoot ?? undefined, message: errorMessage(err) })
        return new Map()
      }),
      this.deps.processService.getStatus().catch(() => null)
    ])

    for (const d of desktop) issues.push(...d.issues)
    if (projects) issues.push(...projects.issues)
    if (!roots.projectsRoot) issues.push(msg('scan.projectsRootMissing'))

    const decodedProjectDirs = await this.resolveFolderNames(projects, desktop)
    const { sessions, records } = buildSessions({
      desktop,
      projects,
      fileHistory,
      sessionEnv,
      hidden: this.deps.hidden.keys(),
      liveSessions: processStatus?.liveSessions ?? [],
      decodedProjectDirs
    })
    // One project per real workspace: drive-letter/case variants and junctions collapse.
    await canonicalizeProjects(sessions)
    for (const r of records.values()) {
      const p = r.session.projectPath
      if (p && !r.workspacePaths.some((w) => pathKey(w) === pathKey(p))) r.workspacePaths.push(p)
    }
    this.records = records

    if (projects) {
      this.deps.cache.prune([...projects.transcripts.map((t) => t.filePath), ...projects.legacySubagentLogs.map((l) => l.filePath)])
    }
    await this.deps.cache.save()

    const counts = new Map<string, Omit<DesktopRootInfo, 'path' | 'source' | 'variant' | 'packageName'>>()
    for (const d of desktop) counts.set(d.root, desktopCounts(d))

    const snapshot: ScanSnapshot = {
      sessions,
      scannedAt: Date.now(),
      durationMs: Date.now() - started,
      roots: toStorageRoots(roots, counts),
      stats: {
        transcripts: projects?.transcripts.length ?? 0,
        transcriptsParsed: projects?.stats.parsed ?? 0,
        transcriptsIncremental: projects?.stats.incremental ?? 0,
        transcriptsFromCache: projects?.stats.fromCache ?? 0,
        subagentLogsExcluded: projects?.stats.subagentLogsExcluded ?? 0,
        legacySubagentLogs: projects?.legacySubagentLogs.length ?? 0,
        sessionDataDirs: projects?.dataDirs.length ?? 0,
        orphanDirs: sessions.filter((s) => s.status === 'orphan').length,
        metadataFiles: desktop.reduce((n, d) => n + d.records.length, 0),
        metadataInvalid: desktop.reduce((n, d) => n + d.records.filter((r) => r.parseError).length, 0),
        tombstones: desktop.reduce((n, d) => n + d.storageDirs.reduce((m, s) => m + s.tombstones.length, 0), 0),
        ignoredEntries: projects?.stats.ignoredEntries ?? 0
      },
      issues
    }
    this.snapshot = snapshot
    logger.info(
      `Scan (${reason}) finished in ${snapshot.durationMs} ms: ${sessions.length} sessions, ` +
        `${snapshot.stats.transcriptsParsed} parsed, ${snapshot.stats.transcriptsIncremental} incremental, ` +
        `${snapshot.stats.transcriptsFromCache} cached`
    )
    this.emit('changed', snapshot)
    return snapshot
  }

  /**
   * Map encoded project folder names (storage locators) to real workspace
   * paths for folders whose sessions carry no cwd of their own: first from
   * cwds recorded elsewhere, then by decoding the name against the real
   * filesystem (read-only directory listings).
   */
  private async resolveFolderNames(projects: ProjectsScan | null, desktop: DesktopRootScan[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    if (!projects) return map
    const known: string[] = []
    for (const t of projects.transcripts) if (t.summary.cwd) known.push(t.summary.cwd)
    for (const d of desktop) for (const r of d.records) for (const c of [r.cwd, r.originCwd]) if (c) known.push(c)
    for (const d of projects.dataDirs) if (d.declaredCwd) known.push(d.declaredCwd)
    for (const c of known) {
      const key = sanitizeProjectPath(c).toLowerCase()
      if (!map.has(key)) map.set(key, c)
    }
    if (this.deps.decodeFolderNames === false) return map
    const needed = new Set(
      projects.dataDirs.filter((d) => !d.declaredCwd && !map.has(d.projectDirName.toLowerCase())).map((d) => d.projectDirName)
    )
    for (const name of needed) {
      const decoded = await decodeProjectDirName(name).catch(() => undefined)
      if (decoded) map.set(name.toLowerCase(), decoded)
    }
    return map
  }

  async getDetails(id: string): Promise<SessionDetails | null> {
    const record = this.records.get(id)
    if (!record) return null
    const details: SessionDetails = { session: record.session, tombstones: [] }
    const meta = record.metadata
    if (meta) {
      try {
        const text = stripBom(await readFile(meta.filePath, 'utf8'))
        try {
          details.rawMetadata = JSON.stringify(JSON.parse(text), null, 2)
        } catch (err) {
          details.rawMetadata = text.length > 200_000 ? text.slice(0, 200_000) + '\n…' : text
          details.rawMetadataError = `Invalid JSON: ${errorMessage(err)}`
        }
      } catch (err) {
        details.rawMetadataError = `Cannot read metadata: ${errorMessage(err)}`
      }
      const wanted = new Set([meta.stem.replace(/^local_/, ''), ...transcriptIdsOf(meta)])
      details.tombstones = (record.storageDir?.tombstones ?? []).filter((t) => wanted.has(t)).map((t) => TOMBSTONE_PREFIX + t)
    }
    return details
  }
}

function desktopCounts(d: DesktopRootScan): { sessionFiles: number; tombstones: number; archiveIndexes: number } {
  return {
    sessionFiles: d.records.length,
    tombstones: d.storageDirs.reduce((n, s) => n + s.tombstones.length, 0),
    archiveIndexes: d.storageDirs.filter((s) => s.archiveIndex).length
  }
}
