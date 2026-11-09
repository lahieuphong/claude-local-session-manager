import { EventEmitter } from 'node:events'
import { FLOW, TERMINAL_LIMITS, type TerminalInfo, type TerminalOpenRequest, type TerminalSupport } from '../../../shared/terminal'
import type { ResumePlan } from './resume'
import type { ShellSpec } from './shells'

/** What the service needs of a pseudo-console (node-pty's IPty). */
export interface Pty {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (e: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  kill(): void
}

export type PtyFactory = (shell: ShellSpec, options: { cwd: string; cols: number; rows: number; env: Record<string, string> }) => Pty

export interface TerminalServiceOptions {
  /** node-pty, loaded on first use; throws when it cannot be. */
  loadPty(): PtyFactory
  findShells(): Promise<ShellSpec[]>
  /** For xterm.js, which adapts to the ConPTY of this Windows build. */
  windowsBuild: number
  home: string
  /** A session's project folder, if it still exists. */
  projectFolder(sessionId: string): Promise<string | undefined>
  /** How to take a session up again, or null when it cannot be (see resume.ts). */
  resumeOf(sessionId: string): Promise<ResumePlan | null>
  env: NodeJS.ProcessEnv
  log: { info(message: string): void; warn(message: string): void }
}

interface Running {
  info: TerminalInfo
  pty: Pty
  /** Output gathered for the next message to the page. */
  pending: string
  flushTimer: NodeJS.Timeout | null
  /** Output sent but not drawn yet; reading stops above FLOW.high. */
  unacked: number
  paused: boolean
  /** Input still to be written, in pieces. */
  queue: string[]
  writeTimer: NodeJS.Timeout | null
  /** A command waiting for the shell's prompt (resuming a session). */
  typeAhead: { type(): void; quiet: NodeJS.Timeout | null; deadline: NodeJS.Timeout } | null
}

/** Output is sent to the page at most this often; typing stays immediate. */
const FLUSH_MS = 5
/** ConPTY can drop data from one large write, so input goes in pieces this far apart (as in VS Code). */
const WRITE_CHUNK = 50
const WRITE_GAP_MS = 5
/** A shell has drawn its prompt once its output has been quiet this long; at the latest, it is typed after the deadline. */
const PROMPT_QUIET_MS = 400
const PROMPT_DEADLINE_MS = 10_000

/**
 * The shells of the integrated terminal. Each runs on its own pseudo-console
 * until its tab is closed, the page reloads or the app quits. What goes in
 * and out of a shell is never logged.
 */
export class TerminalService extends EventEmitter<{ output: [id: number, data: string]; exit: [id: number, exitCode: number] }> {
  private readonly running = new Map<number, Running>()
  private shells: Promise<ShellSpec[]> | null = null
  private factory: PtyFactory | null = null
  private nextId = 1

  constructor(private readonly opts: TerminalServiceOptions) {
    super()
  }

  async support(): Promise<TerminalSupport> {
    const shells = await this.shellList()
    return shells.length ? { available: true, shells: shells.map((s) => s.id), windowsBuild: this.opts.windowsBuild } : { available: false, shells: [] }
  }

  async open(request: TerminalOpenRequest): Promise<TerminalInfo> {
    if (this.running.size >= TERMINAL_LIMITS.maxTerminals) throw new Error(`At most ${TERMINAL_LIMITS.maxTerminals} terminals can be open at once`)
    const shells = await this.shellList()
    const shell = request.shell ? shells.find((s) => s.id === request.shell) : shells[0]
    if (!shell) throw new Error('This shell is not available on this PC')
    const plan = request.resume && request.sessionId ? await this.opts.resumeOf(request.sessionId) : null
    if (request.resume && !plan) throw new Error('This session cannot be taken up again from a terminal')
    const cwd = (request.sessionId && (await this.opts.projectFolder(request.sessionId))) || this.opts.home
    this.factory ??= this.opts.loadPty()
    const env = { ...shellEnv(this.opts.env), ...plan?.env }
    const pty = this.factory(shell, { cwd, cols: request.cols, rows: request.rows, env })

    const info: TerminalInfo = { id: this.nextId++, shell: shell.id, cwd }
    const t: Running = { info, pty, pending: '', flushTimer: null, unacked: 0, paused: false, queue: [], writeTimer: null, typeAhead: null }
    this.running.set(info.id, t)
    pty.onData((data) => this.received(t, data))
    pty.onExit(({ exitCode }) => this.exited(t, exitCode))
    if (plan) this.typeWhenReady(t, plan.command)
    this.opts.log.info(`Terminal ${info.id} opened: ${shell.id} (pid ${pty.pid})${plan ? ', to resume a session' : ''}`)
    return info
  }

  /** What the user typed or pasted. */
  write(id: number, data: string): void {
    const t = this.running.get(id)
    if (!t || !data) return
    t.queue.push(...chunkInput(data, WRITE_CHUNK))
    if (!t.writeTimer) this.writeNext(t)
  }

  resize(id: number, cols: number, rows: number): void {
    const t = this.running.get(id)
    if (!t) return
    try {
      t.pty.resize(cols, rows)
    } catch {
      // The shell may have just exited.
    }
  }

  /** The page has drawn this much more output. */
  ack(id: number, chars: number): void {
    const t = this.running.get(id)
    if (!t) return
    t.unacked = Math.max(0, t.unacked - chars)
    if (t.paused && t.unacked <= FLOW.low) {
      t.paused = false
      t.pty.resume()
    }
  }

  close(id: number): void {
    const t = this.running.get(id)
    if (!t) return
    this.forget(t)
    try {
      t.pty.kill()
    } catch {
      // Already gone.
    }
    this.opts.log.info(`Terminal ${id} closed`)
  }

  closeAll(): void {
    for (const id of [...this.running.keys()]) this.close(id)
  }

  get openCount(): number {
    return this.running.size
  }

  private shellList(): Promise<ShellSpec[]> {
    // Found once: a shell installed later shows up after a restart, as in VS Code.
    this.shells ??= this.opts.findShells().catch((err) => {
      this.shells = null
      throw err
    })
    return this.shells
  }

  private received(t: Running, data: string): void {
    if (this.running.get(t.info.id) !== t) return
    t.pending += data
    t.unacked += data.length
    if (t.typeAhead) {
      if (t.typeAhead.quiet) clearTimeout(t.typeAhead.quiet)
      t.typeAhead.quiet = setTimeout(t.typeAhead.type, PROMPT_QUIET_MS)
    }
    if (!t.paused && t.unacked > FLOW.high) {
      t.paused = true
      t.pty.pause()
    }
    t.flushTimer ??= setTimeout(() => this.flush(t), FLUSH_MS)
  }

  private flush(t: Running): void {
    if (t.flushTimer) clearTimeout(t.flushTimer)
    t.flushTimer = null
    if (!t.pending) return
    const data = t.pending
    t.pending = ''
    this.emit('output', t.info.id, data)
  }

  /** Types into the shell once it has drawn its prompt, so the line editor (PSReadLine, readline) shows it. */
  private typeWhenReady(t: Running, text: string): void {
    const type = (): void => {
      if (!t.typeAhead) return
      this.cancelTypeAhead(t)
      this.write(t.info.id, text)
    }
    t.typeAhead = { type, quiet: null, deadline: setTimeout(type, PROMPT_DEADLINE_MS) }
  }

  private cancelTypeAhead(t: Running): void {
    if (!t.typeAhead) return
    clearTimeout(t.typeAhead.deadline)
    if (t.typeAhead.quiet) clearTimeout(t.typeAhead.quiet)
    t.typeAhead = null
  }

  private writeNext(t: Running): void {
    t.writeTimer = null
    const chunk = t.queue.shift()
    if (chunk === undefined || this.running.get(t.info.id) !== t) return
    try {
      t.pty.write(chunk)
    } catch (err) {
      this.opts.log.warn(`Terminal ${t.info.id}: input not written (${(err as Error).message})`)
    }
    if (t.queue.length) t.writeTimer = setTimeout(() => this.writeNext(t), WRITE_GAP_MS)
  }

  private exited(t: Running, exitCode: number): void {
    if (this.running.get(t.info.id) !== t) return // closed from the app
    this.flush(t)
    this.forget(t)
    this.opts.log.info(`Terminal ${t.info.id} exited (${exitCode})`)
    this.emit('exit', t.info.id, exitCode)
  }

  private forget(t: Running): void {
    this.running.delete(t.info.id)
    if (t.flushTimer) clearTimeout(t.flushTimer)
    if (t.writeTimer) clearTimeout(t.writeTimer)
    t.flushTimer = t.writeTimer = null
    t.queue = []
    this.cancelTypeAhead(t)
  }
}

/** The app's environment for a shell, without Electron's variables or this app's own switches. */
export function shellEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !/^(ELECTRON_|CLAUDE_SESSION_MANAGER_)/i.test(key)) env[key] = value
  }
  // xterm.js draws 24-bit colour; programs check this to use it.
  env.COLORTERM = 'truecolor'
  return env
}

/**
 * Input in pieces of at most `size` characters, never cutting a character in
 * two (a surrogate pair) or an escape sequence (a piece may end only before
 * an ESC that starts one, or after a whole sequence).
 */
export function chunkInput(data: string, size: number): string[] {
  const chunks: string[] = []
  let start = 0
  while (data.length - start > size) {
    let end = start + size
    // An ESC close before the cut starts a sequence that may run past it: cut before the ESC.
    const esc = data.lastIndexOf('\x1b', end - 1)
    if (esc > start && end - esc < 16) end = esc
    else if (isHighSurrogate(data.charCodeAt(end - 1))) end -= 1
    chunks.push(data.slice(start, end))
    start = end
  }
  if (start < data.length) chunks.push(data.slice(start))
  return chunks
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
