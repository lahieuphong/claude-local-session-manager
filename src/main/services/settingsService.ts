import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings, RefreshMode } from '../../shared/types'
import { writeFileAtomic } from '../util/atomicWrite'
import { errorMessage, logger } from '../util/logger'

export const DEFAULT_SETTINGS: AppSettings = {
  refreshMode: 'watch',
  refreshIntervalSec: 60,
  showRawPaths: false,
  debugMode: false
}

const MODES: RefreshMode[] = ['manual', 'watch', 'interval']
const INTERVALS = [15, 30, 60, 120, 300, 600]

/**
 * Validate a settings patch from the renderer. Only known keys with valid
 * values are applied. Note there is intentionally no setting for storage or
 * delete roots: those always come from auto-discovery.
 */
export function mergeSettings(base: AppSettings, patch: unknown): AppSettings {
  const next = { ...base }
  if (!patch || typeof patch !== 'object') return next
  const p = patch as Record<string, unknown>
  if (typeof p.refreshMode === 'string' && MODES.includes(p.refreshMode as RefreshMode)) next.refreshMode = p.refreshMode as RefreshMode
  if (typeof p.refreshIntervalSec === 'number' && INTERVALS.includes(p.refreshIntervalSec)) next.refreshIntervalSec = p.refreshIntervalSec
  if (typeof p.showRawPaths === 'boolean') next.showRawPaths = p.showRawPaths
  if (typeof p.debugMode === 'boolean') next.debugMode = p.debugMode
  return next
}

export class SettingsService {
  private settings: AppSettings = { ...DEFAULT_SETTINGS }

  constructor(private filePath: string) {}

  async load(): Promise<AppSettings> {
    try {
      this.settings = mergeSettings(DEFAULT_SETTINGS, JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn(`Ignoring unreadable settings: ${errorMessage(err)}`)
    }
    return this.get()
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: unknown): Promise<AppSettings> {
    this.settings = mergeSettings(this.settings, patch)
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFileAtomic(this.filePath, JSON.stringify(this.settings, null, 2))
    return this.get()
  }
}
