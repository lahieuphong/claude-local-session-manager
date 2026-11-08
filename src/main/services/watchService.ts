import { watch, type FSWatcher } from 'node:fs'
import type { AppSettings } from '../../shared/types'
import { errorMessage, logger } from '../util/logger'
import { rootsOf, type DiscoveredRoots } from './claudeDiscovery'

const SETTLE_MS = 2500
/** In a Codex folder: its sessions and conversations databases and the session index (not its busy log database). */
const CODEX_FILES = /^(state_\d+\.sqlite(-wal)?|thread_history_\d+\.sqlite(-wal)?|session_index\.jsonl)$/i
const MIN_GAP_MS = 6000

/** Whose data changed: a change in one tool's folders rescans only that tool. */
export type WatchTarget = 'claude' | 'codex' | 'all'

/**
 * Auto refresh. In "watch" mode a handful of recursive watchers (one per
 * root, not per file) trigger a throttled rescan of the tool whose folder
 * changed; in "interval" mode a timer rescans both. Scans are incremental,
 * so frequent triggers stay cheap.
 */
export class WatchService {
  private watchers: FSWatcher[] = []
  private interval: NodeJS.Timeout | null = null
  private timers = new Map<WatchTarget, NodeJS.Timeout>()
  private lastRun = new Map<WatchTarget, number>()
  private signature = ''

  constructor(private trigger: (reason: string, target: WatchTarget) => void) {}

  configure(settings: AppSettings, roots: DiscoveredRoots | null, codexHomes: string[] = []): void {
    const dirs = roots
      ? [...rootsOf(roots, 'projectsRoot'), ...roots.desktopRoots.map((d) => d.path)]
      : []
    const shallow = roots ? rootsOf(roots, 'liveSessionsDir') : []
    const signature = JSON.stringify([settings.refreshMode, settings.refreshIntervalSec, dirs, shallow, codexHomes])
    if (signature === this.signature) return
    this.stop()
    this.signature = signature

    if (settings.refreshMode === 'interval') {
      this.interval = setInterval(() => this.trigger('interval', 'all'), settings.refreshIntervalSec * 1000)
      logger.info(`Auto refresh: every ${settings.refreshIntervalSec}s`)
    } else if (settings.refreshMode === 'watch') {
      for (const dir of dirs) this.addWatcher(dir, true, 'claude')
      for (const dir of shallow) this.addWatcher(dir, false, 'claude')
      for (const dir of codexHomes) this.addWatcher(dir, false, 'codex', (name) => CODEX_FILES.test(name))
      logger.info(`Auto refresh: watching ${this.watchers.length} folder(s)`)
    } else {
      logger.info('Auto refresh: manual only')
    }
  }

  private addWatcher(dir: string, recursive: boolean, target: WatchTarget, only?: (name: string) => boolean): void {
    try {
      const w = watch(dir, { recursive, persistent: false }, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : ''
        // Ignore temp files from atomic writes.
        if (/(^|[\\/])\.[^\\/]*\.tmp$/.test(name)) return
        if (only && !only(name)) return
        this.schedule(target)
      })
      w.on('error', (err) => {
        logger.warn(`Watcher error on ${dir}: ${errorMessage(err)}`)
        w.close()
        this.watchers = this.watchers.filter((x) => x !== w)
      })
      this.watchers.push(w)
    } catch (err) {
      logger.warn(`Cannot watch ${dir}: ${errorMessage(err)}`)
    }
  }

  private schedule(target: WatchTarget): void {
    if (this.timers.has(target)) return
    const wait = Math.max(SETTLE_MS, (this.lastRun.get(target) ?? 0) + MIN_GAP_MS - Date.now())
    this.timers.set(
      target,
      setTimeout(() => {
        this.timers.delete(target)
        this.lastRun.set(target, Date.now())
        this.trigger('file-change', target)
      }, wait)
    )
  }

  stop(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.interval) clearInterval(this.interval)
    for (const t of this.timers.values()) clearTimeout(t)
    this.interval = null
    this.timers.clear()
    this.signature = ''
  }
}
