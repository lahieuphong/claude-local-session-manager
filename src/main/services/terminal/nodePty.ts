import { createRequire } from 'node:module'
import path from 'node:path'
import type { PtyFactory } from './terminalService'

type NodePty = typeof import('node-pty')

/**
 * node-pty on Windows' own pseudo-console (ConPTY). In a packaged build it is
 * loaded from app.asar.unpacked: its native files, and the worker thread it
 * starts for each shell, must be real files on disk.
 */
export function loadNodePty(resourcesPath: string | null): PtyFactory {
  const load = createRequire(__filename)
  const pty = load(resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty') : 'node-pty') as NodePty
  return (shell, { cwd, cols, rows, env }) => pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cwd, cols, rows, env, useConpty: true })
}
