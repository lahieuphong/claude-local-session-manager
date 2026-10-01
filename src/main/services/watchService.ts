import { watch, type FSWatcher } from 'node:fs'
import type { AppSettings } from '../../shared/types'
import { errorMessage, logger } from '../util/logger'
import type { DiscoveredRoots } from './claudeDiscovery'

const SETTLE_MS = 2500
const MIN_GAP_MS = 6000

/**
 * Auto refresh. In "watch" mode a handful of recursive watchers (one per
 * root, not per file) trigger a throttled rescan; in "interval" mode a timer
 * does. Scans are incremental, so frequent triggers stay cheap.
 */
export class WatchService {
  private watchers: FSWatcher[] = []
  private interval: NodeJS.Timeout | null = null
  private timer: NodeJS.Timeout | null = null
  private lastRun = 0
  private signature = ''

  constructor(private trigger: (reason: string) => void) {}

  configure(settings: AppSettings, roots: DiscoveredRoots | null): void {
    const dirs = roots
      ? [roots.projectsRoot, ...roots.desktopRoots.map((d) => d.path)].filter((d): d is string => !!d)
      : []
    const shallow = roots?.liveSessionsDir ? [roots.liveSessionsDir] : []
    const signature = JSON.stringify([settings.refreshMode, settings.refreshIntervalSec, dirs, shallow])
    if (signature === this.signature) return
    this.stop()
    this.signature = signature

    if (settings.refreshMode === 'interval') {
      this.interval = setInterval(() => this.trigger('interval'), settings.refreshIntervalSec * 1000)
      logger.info(`Auto refresh: every ${settings.refreshIntervalSec}s`)
    } else if (settings.refreshMode === 'watch') {
      for (const dir of dirs) this.addWatcher(dir, true)
      for (const dir of shallow) this.addWatcher(dir, false)
      logger.info(`Auto refresh: watching ${this.watchers.length} folder(s)`)
    } else {
      logger.info('Auto refresh: manual only')
    }
  }

  private addWatcher(dir: string, recursive: boolean): void {
    try {
      const w = watch(dir, { recursive, persistent: false }, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : ''
        // Ignore temp files from atomic writes.
        if (/(^|[\\/])\.[^\\/]*\.tmp$/.test(name)) return
        this.schedule()
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

  private schedule(): void {
    if (this.timer) return
    const wait = Math.max(SETTLE_MS, this.lastRun + MIN_GAP_MS - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.lastRun = Date.now()
      this.trigger('file-change')
    }, wait)
  }

  stop(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.interval) clearInterval(this.interval)
    if (this.timer) clearTimeout(this.timer)
    this.interval = null
    this.timer = null
    this.signature = ''
  }
}
