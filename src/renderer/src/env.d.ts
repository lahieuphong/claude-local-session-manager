import type { SessionManagerApi } from '../../shared/ipc'
import type { TerminalApi } from '../../shared/terminal'

declare global {
  interface Window {
    sessionManager: SessionManagerApi
    terminal: TerminalApi
  }
}

export {}
