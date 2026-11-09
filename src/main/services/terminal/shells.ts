import path from 'node:path'
import type { ShellId } from '../../../shared/terminal'
import { statOrNull } from '../../util/fsx'

/** A shell the terminal can start: always a program found here, never one the page names. */
export interface ShellSpec {
  id: ShellId
  file: string
  args: string[]
}

export type ShellEnv = Record<string, string | undefined>

/** Environment variable names are case-insensitive on Windows; a plain object (as in tests) is not. */
function envValue(env: ShellEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? env[key] || undefined : undefined
}

async function isFile(p: string): Promise<boolean> {
  const s = await statOrNull(p).catch(() => null)
  return !!s && s.isFile()
}

const under = (root: string | undefined, ...parts: string[]): string | undefined => (root ? path.join(root, ...parts) : undefined)

/**
 * The shells on this PC, in order of preference: PowerShell 7, Windows
 * PowerShell, Command Prompt, then Git Bash (the first is the default).
 * PowerShell starts without its banner.
 */
export async function findShells(env: ShellEnv, exists: (p: string) => Promise<boolean> = isFile): Promise<ShellSpec[]> {
  /** The first of these paths that is a file; a missing variable leaves its path out. */
  const first = async (paths: Array<string | undefined>): Promise<string | undefined> => {
    for (const p of paths) if (p && (await exists(p))) return p
    return undefined
  }
  const systemRoot = envValue(env, 'SystemRoot') ?? envValue(env, 'windir')
  const programFiles = [envValue(env, 'ProgramW6432'), envValue(env, 'ProgramFiles'), envValue(env, 'ProgramFiles(x86)')]
  const pathDirs = (envValue(env, 'Path') ?? '').split(';').filter(Boolean)

  const found: Array<[ShellId, string | undefined, string[]]> = [
    ['pwsh', await first([...pathDirs.map((d) => path.join(d, 'pwsh.exe')), ...programFiles.map((p) => under(p, 'PowerShell', '7', 'pwsh.exe'))]), ['-NoLogo']],
    ['powershell', await first([under(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]), ['-NoLogo']],
    ['cmd', await first([envValue(env, 'ComSpec'), under(systemRoot, 'System32', 'cmd.exe')]), []],
    ['gitbash', await first([...programFiles.map((p) => under(p, 'Git', 'bin', 'bash.exe')), under(envValue(env, 'LOCALAPPDATA'), 'Programs', 'Git', 'bin', 'bash.exe')]), ['--login', '-i']]
  ]
  return found.flatMap(([id, file, args]) => (file ? [{ id, file, args }] : []))
}
