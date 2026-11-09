import { clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { TERMINAL_IPC, TERMINAL_LIMITS, type TerminalSupport } from '../../shared/terminal'
import type { TerminalService } from '../services/terminal/terminalService'
import { errorMessage, logger } from '../util/logger'
import { assertCharCount, assertTerminalId, assertTerminalInput, assertTerminalOpen, assertTerminalSize, assertWebLink } from './validators'

export interface TerminalIpcContext {
  /** null in the Microsoft Store edition and in Store screenshot mode: there is no terminal. */
  service: TerminalService | null
  isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean
  /** The page that gets the output. */
  page(): WebContents | null
}

const UNAVAILABLE: TerminalSupport = { available: false, shells: [] }

/** The terminal's own bridge (shared/terminal.ts); the session API stays apart from it. */
export function registerTerminalIpc(ctx: TerminalIpcContext): void {
  const service = (): TerminalService => {
    if (!ctx.service) throw new Error('This edition has no terminal')
    return ctx.service
  }
  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!ctx.isTrustedSender(event)) throw new Error('Rejected IPC call from an untrusted frame')
      try {
        return await fn(...args)
      } catch (err) {
        logger.error(`IPC ${channel} failed: ${errorMessage(err)}`)
        throw new Error(errorMessage(err))
      }
    })
  }
  /** Keystrokes and sizes: no answer, and a bad message is dropped (never thrown in the main process). */
  const listen = (channel: string, fn: (...args: unknown[]) => void): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (!ctx.isTrustedSender(event) || !ctx.service) return
      try {
        fn(...args)
      } catch (err) {
        logger.warn(`IPC ${channel} refused: ${errorMessage(err)}`)
      }
    })
  }

  handle(TERMINAL_IPC.info, () => ctx.service?.support() ?? UNAVAILABLE)
  handle(TERMINAL_IPC.open, (request) => service().open(assertTerminalOpen(request)))
  handle(TERMINAL_IPC.close, (id) => service().close(assertTerminalId(id)))
  handle(TERMINAL_IPC.clipboardText, async () => {
    service()
    return (await clipboard.readText()).slice(0, TERMINAL_LIMITS.maxInput)
  })
  handle(TERMINAL_IPC.openLink, (url) => {
    service()
    return shell.openExternal(assertWebLink(url))
  })

  listen(TERMINAL_IPC.input, (id, data) => service().write(assertTerminalId(id), assertTerminalInput(data)))
  listen(TERMINAL_IPC.resize, (id, cols, rows) => {
    const size = assertTerminalSize(cols, rows)
    service().resize(assertTerminalId(id), size.cols, size.rows)
  })
  listen(TERMINAL_IPC.ack, (id, chars) => service().ack(assertTerminalId(id), assertCharCount(chars)))

  ctx.service?.on('output', (id, data) => ctx.page()?.send(TERMINAL_IPC.output, id, data))
  ctx.service?.on('exit', (id, exitCode) => ctx.page()?.send(TERMINAL_IPC.exit, id, exitCode))
}
