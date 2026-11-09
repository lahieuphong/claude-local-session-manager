import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertTerminalId,
  assertTerminalInput,
  assertTerminalOpen,
  assertTerminalSize,
  assertWebLink
} from '../src/main/ipc/validators'
import { resumePlan, type ResumeAccount, type ResumePlan } from '../src/main/services/terminal/resume'
import { findShells, type ShellSpec } from '../src/main/services/terminal/shells'
import { chunkInput, shellEnv, TerminalService, type Pty, type PtyFactory } from '../src/main/services/terminal/terminalService'
import { FLOW, TERMINAL_LIMITS } from '../src/shared/terminal'

const SESSION = 'a'.repeat(20)
const CLI_ID = '0c0dec00-0000-4000-8000-000000000001'
const RESUME: ResumePlan = { command: `codex resume ${CLI_ID}`, env: { CODEX_HOME: 'C:\\Users\\u\\.codex-work' } }
const PROJECT = 'C:\\Projects\\OCR'
const HOME = 'C:\\Users\\u'

/** A pseudo-console that records what the service does with it. */
class FakePty implements Pty {
  readonly pid = 4100
  written: string[] = []
  sizes: Array<[number, number]> = []
  paused = false
  killed = false
  private dataListener: (d: string) => void = () => {}
  private exitListener: (e: { exitCode: number }) => void = () => {}
  onData(l: (d: string) => void): void {
    this.dataListener = l
  }
  onExit(l: (e: { exitCode: number }) => void): void {
    this.exitListener = l
  }
  write(d: string): void {
    this.written.push(d)
  }
  resize(c: number, r: number): void {
    this.sizes.push([c, r])
  }
  pause(): void {
    this.paused = true
  }
  resume(): void {
    this.paused = false
  }
  kill(): void {
    this.killed = true
  }
  print(d: string): void {
    this.dataListener(d)
  }
  end(exitCode: number): void {
    this.exitListener({ exitCode })
  }
}

const SHELLS: ShellSpec[] = [
  { id: 'pwsh', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] },
  { id: 'cmd', file: 'C:\\Windows\\System32\\cmd.exe', args: [] }
]

function setup(opts: { shells?: ShellSpec[]; loadPty?: () => PtyFactory } = {}) {
  const ptys: FakePty[] = []
  const spawned: Array<{ shell: ShellSpec; cwd: string; cols: number; rows: number; env: Record<string, string> }> = []
  const factory: PtyFactory = (shell, o) => {
    spawned.push({ shell, ...o })
    const p = new FakePty()
    ptys.push(p)
    return p
  }
  const service = new TerminalService({
    loadPty: opts.loadPty ?? (() => factory),
    findShells: async () => opts.shells ?? SHELLS,
    windowsBuild: 26100,
    home: HOME,
    projectFolder: async (id) => (id === SESSION ? PROJECT : undefined),
    resumeOf: async (id) => (id === SESSION ? RESUME : null),
    env: { Path: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', CLAUDE_SESSION_MANAGER_USER_DATA: 'x', USERPROFILE: HOME },
    log: { info: () => {}, warn: () => {} }
  })
  const output: Array<[number, string]> = []
  const exits: Array<[number, number]> = []
  service.on('output', (id, d) => output.push([id, d]))
  service.on('exit', (id, code) => exits.push([id, code]))
  return { service, ptys, spawned, output, exits }
}

describe('shells found on this PC', () => {
  const env = {
    SYSTEMROOT: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    ProgramFiles: 'C:\\Program Files',
    Path: 'C:\\Windows;C:\\Tools\\pwsh'
  }

  it('lists PowerShell 7, Windows PowerShell, Command Prompt and Git Bash, in that order', async () => {
    const files = new Set([
      'C:\\Tools\\pwsh\\pwsh.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\system32\\cmd.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe'
    ])
    const shells = await findShells(env, async (p) => files.has(p))
    expect(shells).toEqual([
      // The one on PATH first, as the user would get typing `pwsh`.
      { id: 'pwsh', file: 'C:\\Tools\\pwsh\\pwsh.exe', args: ['-NoLogo'] },
      { id: 'powershell', file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] },
      { id: 'cmd', file: 'C:\\Windows\\system32\\cmd.exe', args: [] },
      { id: 'gitbash', file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] }
    ])
  })

  it('leaves out what is not installed, and reads variable names in any case', async () => {
    const shells = await findShells({ systemroot: 'D:\\Win' }, async (p) => p === 'D:\\Win\\System32\\cmd.exe')
    expect(shells).toEqual([{ id: 'cmd', file: 'D:\\Win\\System32\\cmd.exe', args: [] }])
    expect(await findShells({}, async () => true)).toEqual([])
  })
})

describe('the terminal service', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('offers the shells it found, the first being the default', async () => {
    expect(await setup().service.support()).toEqual({ available: true, shells: ['pwsh', 'cmd'], windowsBuild: 26100 })
    expect(await setup({ shells: [] }).service.support()).toEqual({ available: false, shells: [] })
  })

  it('opens the default shell in the home folder, or the chosen one in the session’s project folder', async () => {
    const { service, spawned } = setup()
    expect(await service.open({ cols: 80, rows: 24 })).toEqual({ id: 1, shell: 'pwsh', cwd: HOME })
    expect(await service.open({ shell: 'cmd', sessionId: SESSION, cols: 120, rows: 30 })).toEqual({ id: 2, shell: 'cmd', cwd: PROJECT })
    // A session whose folder is gone starts at home.
    expect((await service.open({ sessionId: 'b'.repeat(20), cols: 80, rows: 24 })).cwd).toBe(HOME)
    expect(spawned.map((s) => [s.shell.file, s.cwd, s.cols, s.rows])).toEqual([
      [SHELLS[0].file, HOME, 80, 24],
      [SHELLS[1].file, PROJECT, 120, 30],
      [SHELLS[0].file, HOME, 80, 24]
    ])
  })

  it('refuses a shell it did not find, and more than the maximum of terminals', async () => {
    const { service } = setup()
    await expect(service.open({ shell: 'gitbash', cols: 80, rows: 24 })).rejects.toThrow(/not available/)
    for (let i = 0; i < TERMINAL_LIMITS.maxTerminals; i++) await service.open({ cols: 80, rows: 24 })
    await expect(service.open({ cols: 80, rows: 24 })).rejects.toThrow(/At most/)
  })

  it('gives the shell the app’s environment, without Electron’s variables or the app’s own switches', async () => {
    const { service, spawned } = setup()
    await service.open({ cols: 80, rows: 24 })
    expect(spawned[0].env).toEqual({ Path: 'C:\\Windows', USERPROFILE: HOME, COLORTERM: 'truecolor' })
    expect(shellEnv({ electron_no_attach_console: '1', A: undefined, B: 'b' })).toEqual({ B: 'b', COLORTERM: 'truecolor' })
  })

  it('sends output in batches, and ends with what was still to be sent before the exit', async () => {
    const { service, ptys, output, exits } = setup()
    const { id } = await service.open({ cols: 80, rows: 24 })
    ptys[0].print('PS C:\\> ')
    ptys[0].print('dir')
    expect(output).toEqual([])
    vi.advanceTimersByTime(10)
    expect(output).toEqual([[id, 'PS C:\\> dir']])
    ptys[0].print('bye')
    ptys[0].end(0)
    expect(output.at(-1)).toEqual([id, 'bye'])
    expect(exits).toEqual([[id, 0]])
    // Gone: nothing more is written to it.
    service.write(id, 'x')
    expect(ptys[0].written).toEqual([])
  })

  it('stops reading a shell the page cannot keep up with, and goes on once it has caught up', async () => {
    const { service, ptys } = setup()
    const { id } = await service.open({ cols: 80, rows: 24 })
    ptys[0].print('x'.repeat(FLOW.high + 1))
    expect(ptys[0].paused).toBe(true)
    service.ack(id, FLOW.high - FLOW.low)
    expect(ptys[0].paused).toBe(true)
    service.ack(id, FLOW.ackEvery)
    expect(ptys[0].paused).toBe(false)
  })

  it('writes a long paste in small pieces, in order', async () => {
    const { service, ptys } = setup()
    const { id } = await service.open({ cols: 80, rows: 24 })
    const paste = '\x1b[200~' + 'echo hello world; '.repeat(20) + '\x1b[201~'
    service.write(id, paste)
    vi.advanceTimersByTime(1000)
    expect(ptys[0].written.length).toBeGreaterThan(5)
    expect(ptys[0].written.every((c) => c.length <= 50)).toBe(true)
    expect(ptys[0].written.join('')).toBe(paste)
  })

  it('resizes, and closing ends the shell without reporting an exit the page did not ask about', async () => {
    const { service, ptys, exits } = setup()
    const { id } = await service.open({ cols: 80, rows: 24 })
    service.resize(id, 100, 40)
    expect(ptys[0].sizes).toEqual([[100, 40]])
    service.close(id)
    expect(ptys[0].killed).toBe(true)
    ptys[0].end(1)
    expect(exits).toEqual([])
    expect(service.openCount).toBe(0)
  })

  it('ends every shell when the page goes', async () => {
    const { service, ptys } = setup()
    await service.open({ cols: 80, rows: 24 })
    await service.open({ cols: 80, rows: 24 })
    service.closeAll()
    expect(ptys.map((p) => p.killed)).toEqual([true, true])
    expect(service.openCount).toBe(0)
  })

  it('reports a terminal library that cannot load, and tries again next time', async () => {
    let attempts = 0
    const { service } = setup({
      loadPty: () => {
        attempts += 1
        throw new Error('Failed to load native module: pty.node')
      }
    })
    await expect(service.open({ cols: 80, rows: 24 })).rejects.toThrow(/native module/)
    await expect(service.open({ cols: 80, rows: 24 })).rejects.toThrow(/native module/)
    expect(attempts).toBe(2)
  })
})

describe('taking a session up again in a terminal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('types the resume command once the shell has drawn its prompt, without running it', async () => {
    const { service, ptys, spawned } = setup()
    const { cwd } = await service.open({ sessionId: SESSION, resume: true, cols: 80, rows: 24 })
    expect(cwd).toBe(PROJECT)
    // The account folder of the session, for its CLI.
    expect(spawned[0].env.CODEX_HOME).toBe(RESUME.env.CODEX_HOME)
    ptys[0].print('Loading profile...')
    vi.advanceTimersByTime(200)
    ptys[0].print('PS C:\\Projects\\OCR> ')
    vi.advanceTimersByTime(200)
    expect(ptys[0].written).toEqual([])
    vi.advanceTimersByTime(300)
    // No Enter: running it is the user's choice.
    expect(ptys[0].written.join('')).toBe(RESUME.command)
  })

  it('types it after a while at the latest, even into a shell that prints nothing', async () => {
    const { service, ptys } = setup()
    await service.open({ sessionId: SESSION, resume: true, cols: 80, rows: 24 })
    vi.advanceTimersByTime(9_000)
    expect(ptys[0].written).toEqual([])
    vi.advanceTimersByTime(2_000)
    expect(ptys[0].written.join('')).toBe(RESUME.command)
  })

  it('refuses a session that cannot be resumed, and types nothing into a terminal closed before its prompt', async () => {
    const { service, ptys } = setup()
    await expect(service.open({ sessionId: 'b'.repeat(20), resume: true, cols: 80, rows: 24 })).rejects.toThrow(/cannot be taken up/)
    const { id } = await service.open({ sessionId: SESSION, resume: true, cols: 80, rows: 24 })
    service.close(id)
    vi.advanceTimersByTime(20_000)
    expect(ptys[0].written).toEqual([])
  })

  const accounts: ResumeAccount[] = [
    { id: 'main00000000', path: 'C:\\Users\\u\\.claude', main: true },
    { id: 'work00000000', path: 'C:\\Users\\u\\.claude-accounts\\work', main: false }
  ]
  const claude = { provider: 'claude' as const, cliSessionId: CLI_ID, accountIds: ['main00000000'], hasTranscript: true, live: undefined }

  it('resumes with the CLI of the session’s tool, in its account', () => {
    expect(resumePlan(claude, accounts)).toEqual({ command: `claude --resume ${CLI_ID}`, env: {} })
    expect(resumePlan({ ...claude, accountIds: ['work00000000'] }, accounts)).toEqual({ command: `claude --resume ${CLI_ID}`, env: { CLAUDE_CONFIG_DIR: accounts[1].path } })
    // Shared by both accounts: the main one needs nothing set.
    expect(resumePlan({ ...claude, accountIds: ['work00000000', 'main00000000'] }, accounts)?.env).toEqual({})
    expect(resumePlan({ ...claude, provider: 'codex', accountIds: ['work00000000'] }, accounts)).toEqual({ command: `codex resume ${CLI_ID}`, env: { CODEX_HOME: accounts[1].path } })
  })

  it('does not resume what its CLI cannot, nor a session open right now', () => {
    expect(resumePlan({ ...claude, hasTranscript: false }, accounts)).toBeNull()
    expect(resumePlan({ ...claude, cliSessionId: undefined }, accounts)).toBeNull()
    expect(resumePlan({ ...claude, cliSessionId: `${CLI_ID}; del *` }, accounts)).toBeNull()
    expect(resumePlan({ ...claude, live: { pid: 1, state: 'idle' } }, accounts)).toBeNull()
    // Codex keeps the conversation in its own database: no transcript file is needed.
    expect(resumePlan({ ...claude, provider: 'codex', hasTranscript: false }, accounts)?.command).toBe(`codex resume ${CLI_ID}`)
  })
})

describe('input in pieces', () => {
  it('never cuts an escape sequence or a character in two', () => {
    const data = 'a'.repeat(45) + '\x1b[200~' + 'b'.repeat(60) + '😀'.repeat(30)
    const chunks = chunkInput(data, 50)
    expect(chunks.join('')).toBe(data)
    expect(chunks.every((c) => c.length <= 50)).toBe(true)
    expect(chunks.some((c) => c.startsWith('\x1b[200~'))).toBe(true)
    for (const c of chunks) expect(c).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(chunkInput('ls\r', 50)).toEqual(['ls\r'])
  })
})

describe('what the page may send to the terminal', () => {
  it('opens a shell only by its ID and a folder only by a session ID', () => {
    expect(assertTerminalOpen({ shell: 'cmd', sessionId: SESSION, cols: 80, rows: 24 })).toEqual({ shell: 'cmd', sessionId: SESSION, cols: 80, rows: 24 })
    expect(assertTerminalOpen({ cols: 80, rows: 24 })).toEqual({ shell: undefined, sessionId: undefined, cols: 80, rows: 24 })
    expect(assertTerminalOpen({ sessionId: SESSION, resume: true, cols: 80, rows: 24 })).toEqual({ shell: undefined, sessionId: SESSION, resume: true, cols: 80, rows: 24 })
    for (const bad of [
      { shell: 'C:\\evil.exe', cols: 80, rows: 24 },
      { file: 'C:\\Windows\\System32\\cmd.exe', cols: 80, rows: 24 },
      { args: ['/c', 'del'], cols: 80, rows: 24 },
      { cwd: 'C:\\', cols: 80, rows: 24 },
      { sessionId: 'C:\\Projects', cols: 80, rows: 24 },
      // Resuming needs a session, and only says yes or no: the command is the main process's.
      { resume: true, cols: 80, rows: 24 },
      { sessionId: SESSION, resume: 'claude --resume x', cols: 80, rows: 24 },
      { sessionId: SESSION, command: 'claude --resume x', cols: 80, rows: 24 },
      { cols: 0, rows: 24 },
      { cols: 80.5, rows: 24 },
      null,
      ['cmd']
    ]) {
      expect(() => assertTerminalOpen(bad), JSON.stringify(bad)).toThrow()
    }
  })

  it('checks terminal IDs, sizes and input', () => {
    expect(assertTerminalId(3)).toBe(3)
    for (const bad of [0, -1, 1.5, '1', null]) expect(() => assertTerminalId(bad)).toThrow()
    expect(assertTerminalSize(TERMINAL_LIMITS.cols.max, TERMINAL_LIMITS.rows.max)).toEqual({ cols: TERMINAL_LIMITS.cols.max, rows: TERMINAL_LIMITS.rows.max })
    expect(() => assertTerminalSize(TERMINAL_LIMITS.cols.max + 1, 10)).toThrow()
    expect(assertTerminalInput('dir\r')).toBe('dir\r')
    expect(() => assertTerminalInput('x'.repeat(TERMINAL_LIMITS.maxInput + 1))).toThrow()
    expect(() => assertTerminalInput(42)).toThrow()
  })

  it('opens web links only', () => {
    expect(assertWebLink('https://github.com/anthropics/claude-code')).toBe('https://github.com/anthropics/claude-code')
    expect(assertWebLink('http://localhost:5173/')).toBe('http://localhost:5173/')
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:privacy', 'C:\\x', 'not a url', 'https://x/' + 'a'.repeat(3000)]) {
      expect(() => assertWebLink(bad), bad).toThrow()
    }
  })
})

describe.runIf(process.platform === 'win32')('node-pty on this PC', () => {
  it('runs a real command on a Windows pseudo-console', async () => {
    const pty = await import('node-pty')
    const term = pty.spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'echo clsm-terminal-ok'], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string>, useConpty: true })
    let out = ''
    term.onData((d) => (out += d))
    const code = await new Promise<number>((resolve) => term.onExit(({ exitCode }) => resolve(exitCode)))
    expect(code).toBe(0)
    expect(out).toContain('clsm-terminal-ok')
  }, 20_000)
})
