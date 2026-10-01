import type { SessionManagerApi } from '../../shared/ipc'

declare global {
  interface Window {
    sessionManager: SessionManagerApi
  }
}

export {}
