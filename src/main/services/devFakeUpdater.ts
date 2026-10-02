import { EventEmitter } from 'node:events'
import { logger } from '../util/logger'
import type { UpdaterLike } from './updateService'

export const DEV_FAKE_UPDATE_ENV = 'CLAUDE_SESSION_MANAGER_DEV_FAKE_UPDATE'

/**
 * Development-only stand-in for electron-updater, used to review the update UI
 * (`CLAUDE_SESSION_MANAGER_DEV_FAKE_UPDATE=9.9.9 yarn dev`). It never touches
 * the network or the disk, and "install" only logs. A packaged build ignores
 * the variable entirely.
 */
export function devFakeUpdater(opts: { isPackaged: boolean; env: Record<string, string | undefined> }): UpdaterLike | null {
  const version = opts.env[DEV_FAKE_UPDATE_ENV]?.trim()
  if (opts.isPackaged || !version || !/^\d+\.\d+\.\d+$/.test(version)) return null
  const events = new EventEmitter()
  const updater: UpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    checkForUpdates: async () => ({ updateInfo: { version } }),
    downloadUpdate: async () => {
      for (const percent of [12, 38, 64, 91]) {
        events.emit('download-progress', { percent })
        await new Promise((r) => setTimeout(r, 250))
      }
      events.emit('update-downloaded', { version })
      return []
    },
    quitAndInstall: () => logger.info(`[dev fake updater] install of ${version} requested; nothing is installed in development`),
    on: (event: string, listener: (...args: never[]) => void) => events.on(event, listener as (...args: unknown[]) => void)
  }
  return updater
}
