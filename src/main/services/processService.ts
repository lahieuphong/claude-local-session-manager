import { execFile } from 'node:child_process'
import type {
  ActionErrorCode,
  ClaudeProcessInfo,
  ClaudeProcessKind,
  LiveCliSession,
  ProcessStatus
} from '../../shared/types'
import { errorMessage, logger } from '../util/logger'
import { readLiveSessionRegistry } from './sessionScanner'

export interface RawProcess {
  pid: number
  name: string
  executablePath?: string
  commandLine?: string
}

/**
 * Decide whether a process is Claude Desktop, Claude Code, or unrelated.
 *
 * Claude Desktop (MSIX): C:\Program Files\WindowsApps\Claude_<ver>_x64__<id>\app\claude.exe
 * Claude Desktop (Squirrel): %LOCALAPPDATA%\AnthropicClaude\app-<ver>\claude.exe
 * Claude Code bundled by Desktop: …\Roaming\Claude\claude-code\<ver>\claude.exe
 * Claude Code CLI/IDE: any other claude.exe, or node running @anthropic-ai/claude-code.
 */
export function classifyProcess(p: RawProcess): ClaudeProcessKind | null {
  const name = p.name.toLowerCase()
  const exe = (p.executablePath ?? '').replace(/\//g, '\\').toLowerCase()
  const cmd = (p.commandLine ?? '').toLowerCase()

  if (name === 'claude.exe' || name === 'claude') {
    if (/\\claude(-3p)?\\claude-code\\[^\\]+\\claude(\.exe)?$/.test(exe)) return 'claude-code'
    if (exe.includes('\\windowsapps\\') || exe.includes('\\anthropicclaude\\') || exe.includes('\\programs\\claude\\')) {
      return 'desktop'
    }
    if (exe.includes('/applications/claude.app/') || exe.includes('\\applications\\claude.app\\')) return 'desktop'
    if (!exe) return cmd.includes('--type=') ? 'desktop' : 'unknown'
    return 'claude-code'
  }
  if (name === 'node.exe' || name === 'node' || name === 'bun.exe' || name === 'bun') {
    if (/@anthropic-ai[\\/]claude-code|claude-code[\\/]cli\.(m?js)/.test(cmd)) return 'claude-code'
  }
  return null
}

const LIVE_NAME_RE = /^(claude|node|bun)(\.exe)?$/i

type Runner = (pids: number[]) => Promise<RawProcess[]>

function runCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/** Query processes on Windows through CIM. Fixed script; PIDs are integers. */
export const windowsRunner: Runner = async (pids) => {
  const pidList = pids.filter((p) => Number.isInteger(p) && p > 0).join(',')
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$pids = @(${pidList})`,
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(claude|node|bun)(\\.exe)?$' -or $pids -contains [int]$_.ProcessId } |",
    '  Select-Object ProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress -Depth 2'
  ].join('\n')
  const out = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script])
  const text = out.trim()
  if (!text) return []
  const parsed = JSON.parse(text) as unknown
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>
  return list
    .filter((p) => typeof p?.ProcessId === 'number' && typeof p?.Name === 'string')
    .map((p) => ({
      pid: p.ProcessId as number,
      name: p.Name as string,
      executablePath: typeof p.ExecutablePath === 'string' ? p.ExecutablePath : undefined,
      commandLine: typeof p.CommandLine === 'string' ? p.CommandLine : undefined
    }))
}

export const posixRunner: Runner = async () => {
  const out = await runCommand('ps', ['-A', '-o', 'pid=,comm=,args='])
  const list: RawProcess[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const exe = m[2]
    list.push({ pid: Number(m[1]), name: exe.split('/').pop() ?? exe, executablePath: exe, commandLine: m[3] })
  }
  return list
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function buildProcessStatus(
  processes: RawProcess[],
  registry: Array<Omit<LiveCliSession, 'alive'>>,
  error?: string
): ProcessStatus {
  const desktop: ClaudeProcessInfo[] = []
  const code: ClaudeProcessInfo[] = []
  const unknown: ClaudeProcessInfo[] = []
  for (const p of processes) {
    const kind = classifyProcess(p)
    if (!kind) continue
    const info: ClaudeProcessInfo = { pid: p.pid, name: p.name, executablePath: p.executablePath, kind }
    if (kind === 'desktop') desktop.push(info)
    else if (kind === 'claude-code') code.push(info)
    else unknown.push(info)
  }
  const byPid = new Map(processes.map((p) => [p.pid, p]))
  const liveSessions: LiveCliSession[] = registry.map((r) => {
    const proc = byPid.get(r.pid)
    // If the process query failed, fall back to "PID exists" (conservative).
    const alive = error ? pidExists(r.pid) : !!proc && LIVE_NAME_RE.test(proc.name)
    return { ...r, alive }
  })
  return {
    checkedAt: Date.now(),
    supported: true,
    desktopRunning: desktop.length > 0 || unknown.length > 0,
    desktopProcesses: desktop,
    claudeCodeProcesses: code,
    unknownProcesses: unknown,
    liveSessions,
    error
  }
}

export class ProcessService {
  private cached: ProcessStatus | null = null
  private inflight: Promise<ProcessStatus> | null = null
  private inflightDir: string | null = null

  constructor(
    private liveSessionsDir: string | null,
    private runner: Runner = process.platform === 'win32' ? windowsRunner : posixRunner,
    private maxAgeMs = 10_000
  ) {}

  setLiveSessionsDir(dir: string | null): void {
    this.liveSessionsDir = dir
    this.cached = null
  }

  async getStatus(force = false): Promise<ProcessStatus> {
    if (!force && this.cached && Date.now() - this.cached.checkedAt < this.maxAgeMs) return this.cached
    // Reuse a running query only if it reads the same registry folder; a
    // query started before discovery set the folder would miss live sessions.
    if (this.inflight && this.inflightDir === this.liveSessionsDir) return this.inflight
    const dir = this.liveSessionsDir
    this.inflightDir = dir
    const run = (async () => {
      const registry = await readLiveSessionRegistry(dir).catch(() => [])
      let processes: RawProcess[] = []
      let error: string | undefined
      try {
        processes = await this.runner(registry.map((r) => r.pid))
      } catch (err) {
        error = `Process query failed: ${errorMessage(err)}`
        logger.warn(error)
      }
      const status = buildProcessStatus(processes, registry, error)
      if (dir === this.liveSessionsDir) this.cached = status
      return status
    })().finally(() => {
      if (this.inflight === run) this.inflight = null
    })
    this.inflight = run
    return run
  }
}

export interface GuardResult {
  code: ActionErrorCode
  message: string
}

export const CLAUDE_RUNNING_MESSAGE = 'Close Claude Desktop before modifying session files.'

/** Block every Claude file mutation while Claude Desktop runs (or status is unknown). */
export function globalGuard(status: ProcessStatus): GuardResult | null {
  if (status.error) {
    return {
      code: 'CLAUDE_RUNNING',
      message: `Could not verify whether Claude is running (${status.error}). Use "Refresh process status" and try again.`
    }
  }
  if (status.desktopRunning) return { code: 'CLAUDE_RUNNING', message: CLAUDE_RUNNING_MESSAGE }
  return null
}

/** Block a specific session that a running Claude Code process has open. */
export function sessionGuard(status: ProcessStatus, sessionUuids: string[]): GuardResult | null {
  const ids = new Set(sessionUuids.map((s) => s.toLowerCase()))
  const live = status.liveSessions.find((l) => l.alive && ids.has(l.sessionId))
  if (!live) return null
  return {
    code: 'SESSION_IN_USE',
    message: `This session is open in a running Claude Code process (PID ${live.pid}${live.name ? `, "${live.name}"` : ''}). Close it first.`
  }
}
