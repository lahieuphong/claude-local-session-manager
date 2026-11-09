/**
 * The integrated terminal: real shells on Windows pseudo-consoles (ConPTY),
 * one per tab, as in VS Code.
 *
 * It is a bridge of its own (window.terminal), apart from the session API:
 * the renderer chooses a shell only by its ID from the list the main process
 * found on this PC, and the folder only as a session ID whose project folder
 * the main process looks up. No program path, command line or folder ever
 * comes from the page; what the user types goes to the shell they opened.
 * The Microsoft Store edition has no terminal.
 */

import type { Provider } from './types'

export const SHELL_IDS = ['pwsh', 'powershell', 'cmd', 'gitbash'] as const
export type ShellId = (typeof SHELL_IDS)[number]

export const TERMINAL_IPC = {
  info: 'terminal:info',
  open: 'terminal:open',
  close: 'terminal:close',
  clipboardText: 'terminal:clipboard-text',
  openLink: 'terminal:open-link',
  /** renderer → main, no answer: keystrokes, size changes, output drawn */
  input: 'terminal:input',
  resize: 'terminal:resize',
  ack: 'terminal:ack',
  /** main → renderer push */
  output: 'terminal:output',
  exit: 'terminal:exit'
} as const

/** What this build offers. `shells` is in order of preference: the first is the default. */
export type TerminalSupport = { available: true; shells: ShellId[]; windowsBuild: number } | { available: false; shells: [] }

export interface TerminalOpenRequest {
  /** One of TerminalSupport.shells; the first when absent. */
  shell?: ShellId
  /** Start in this session's project folder, when it still exists (else the user's home). */
  sessionId?: string
  /** Type in the command that takes that session up again (see resumeCommand); Enter is the user's. */
  resume?: boolean
  cols: number
  rows: number
}

/** The command that takes a session up again, in its own tool's CLI. */
export function resumeCommand(provider: Provider, cliSessionId: string): string {
  return provider === 'codex' ? `codex resume ${cliSessionId}` : `claude --resume ${cliSessionId}`
}

export interface TerminalInfo {
  id: number
  shell: ShellId
  /** The folder it started in, shown on its tab. */
  cwd: string
}

export const TERMINAL_LIMITS = {
  /** Open at once. */
  maxTerminals: 12,
  /** One write: a large paste still fits. */
  maxInput: 1_048_576,
  cols: { min: 2, max: 1000 },
  rows: { min: 1, max: 500 },
  maxLink: 2048
} as const

/**
 * Flow control, as VS Code does it: the main process stops reading a shell
 * that has sent this many characters the page has not drawn yet, and goes on
 * once it has caught up. The page reports progress every `ackEvery` characters.
 */
export const FLOW = { high: 100_000, low: 5_000, ackEvery: 5_000 } as const

export interface TerminalApi {
  info(): Promise<TerminalSupport>
  open(request: TerminalOpenRequest): Promise<TerminalInfo>
  close(id: number): Promise<void>
  /** For right-click paste; Ctrl+V pastes without it. */
  clipboardText(): Promise<string>
  /** Ctrl+click on a web address in the output: http and https only. */
  openLink(url: string): Promise<void>
  input(id: number, data: string): void
  resize(id: number, cols: number, rows: number): void
  ack(id: number, chars: number): void
  onOutput(listener: (id: number, data: string) => void): () => void
  onExit(listener: (id: number, exitCode: number) => void): () => void
}
