import { describe, expect, it } from 'vitest'
import { buildProcessStatus, classifyProcess, globalGuard, ProcessService, sessionGuard } from '../src/main/services/processService'
import { createFakeClaude, DESKTOP_EXE, U, VSCODE_CLAUDE_EXE } from './helpers/fakeClaude'

describe('ProcessService', () => {
  it('does not reuse a query started before the live-session folder was known', async () => {
    const fake = await createFakeClaude()
    try {
      await fake.writeLive(4242, U.A)
      const slow = async (): Promise<Array<{ pid: number; name: string; executablePath?: string }>> => {
        await new Promise((r) => setTimeout(r, 50))
        return [{ pid: 4242, name: 'claude.exe', executablePath: VSCODE_CLAUDE_EXE }]
      }
      const svc = new ProcessService(null, slow)
      const early = svc.getStatus() // e.g. the renderer's first poll, before discovery
      svc.setLiveSessionsDir(fake.liveDir)
      const late = await svc.getStatus() // e.g. the repository scan
      expect((await early).liveSessions).toEqual([])
      expect(late.liveSessions.map((l) => [l.pid, l.alive])).toEqual([[4242, true]])
      expect((await svc.getStatus()).liveSessions).toHaveLength(1)
    } finally {
      await fake.cleanup()
    }
  })
})

describe('Claude process classification', () => {
  it('recognises Claude Desktop (MSIX and Squirrel installs)', () => {
    expect(classifyProcess({ pid: 1, name: 'claude.exe', executablePath: DESKTOP_EXE })).toBe('desktop')
    expect(classifyProcess({ pid: 1, name: 'Claude.exe', executablePath: 'C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe' })).toBe(
      'desktop'
    )
  })

  it('recognises Claude Code (IDE binary, Desktop-bundled CLI, node CLI)', () => {
    expect(classifyProcess({ pid: 1, name: 'claude.exe', executablePath: VSCODE_CLAUDE_EXE })).toBe('claude-code')
    expect(
      classifyProcess({
        pid: 1,
        name: 'claude.exe',
        executablePath: 'C:\\Users\\u\\AppData\\Local\\Packages\\Claude_x\\LocalCache\\Roaming\\Claude\\claude-code\\2.1.284\\claude.exe'
      })
    ).toBe('claude-code')
    expect(
      classifyProcess({ pid: 1, name: 'node.exe', commandLine: 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' })
    ).toBe('claude-code')
  })

  it('ignores unrelated processes and flags unidentifiable claude.exe as unknown', () => {
    expect(classifyProcess({ pid: 1, name: 'node.exe', commandLine: 'node server.js' })).toBeNull()
    expect(classifyProcess({ pid: 1, name: 'chrome.exe' })).toBeNull()
    expect(classifyProcess({ pid: 1, name: 'claude.exe' })).toBe('unknown')
  })
})

describe('process status and guards', () => {
  const registry = [{ pid: 300, sessionId: U.A }, { pid: 301, sessionId: U.B }]

  it('marks live sessions only when the PID belongs to a Claude-like process', () => {
    const st = buildProcessStatus(
      [
        { pid: 300, name: 'claude.exe', executablePath: VSCODE_CLAUDE_EXE },
        { pid: 301, name: 'notepad.exe' }
      ],
      registry
    )
    expect(st.desktopRunning).toBe(false)
    expect(st.liveSessions.find((l) => l.sessionId === U.A)?.alive).toBe(true)
    expect(st.liveSessions.find((l) => l.sessionId === U.B)?.alive).toBe(false)
    expect(globalGuard(st)).toBeNull()
    expect(sessionGuard(st, [U.A])?.code).toBe('SESSION_IN_USE')
    expect(sessionGuard(st, [U.B])).toBeNull()
  })

  it('blocks everything while Claude Desktop runs or when the status is unknown', () => {
    const running = buildProcessStatus([{ pid: 9, name: 'claude.exe', executablePath: DESKTOP_EXE }], [])
    expect(globalGuard(running)).toEqual({
      code: 'CLAUDE_RUNNING',
      message: 'Close Claude Desktop before modifying session files.',
      msg: { key: 'guard.claudeRunning' }
    })
    const unknown = buildProcessStatus([], [], 'Process query failed: timeout')
    expect(globalGuard(unknown)?.code).toBe('CLAUDE_RUNNING')
  })
})
