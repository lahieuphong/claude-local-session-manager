import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC } from '../src/shared/ipc'

const root = path.resolve(__dirname, '..')
// Code only: comments may legitimately mention what is NOT exposed.
const preload = readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const register = readFileSync(path.join(root, 'src/main/ipc/registerIpc.ts'), 'utf8')
const terminalIpc = readFileSync(path.join(root, 'src/main/ipc/terminalIpc.ts'), 'utf8')
const main = readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')

describe('renderer API surface', () => {
  it('the preload exposes no generic shell, exec, filesystem or Node access', () => {
    for (const forbidden of ['shell', 'child_process', 'exec', 'spawn', "from 'fs'", "from 'node:fs'", 'openExternal', 'require(', 'process.env']) {
      expect(preload).not.toContain(forbidden)
    }
    expect(Object.values(IPC).some((c) => /exec|shell|file:write|delete-file|write-file|run/i.test(c))).toBe(false)
  })

  it('update actions take no arguments (no URL, path or command can be passed)', () => {
    for (const name of ['getUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'openReleasesPage', 'openStoreUpdates', 'openStoreListing']) {
      expect(preload).toMatch(new RegExp(`${name}: \\(\\) => ipcRenderer\\.invoke\\(IPC\\.${name}\\)`))
    }
    expect(register).toMatch(/handle\(IPC\.checkForUpdates, \(\) =>/)
    expect(register).toMatch(/handle\(IPC\.downloadUpdate, \(\) =>/)
    expect(register).toMatch(/handle\(IPC\.installUpdate, \(\) =>/)
    expect(register).toMatch(/handle\(IPC\.openReleasesPage, \(\) =>/)
    expect(register).toMatch(/handle\(IPC\.openStoreUpdates, \(\) =>/)
    expect(register).toMatch(/handle\(IPC\.openStoreListing, \(\) =>/)
  })

  it('the session API never reaches the terminal: that is a bridge of its own', () => {
    expect(Object.values(IPC).some((c) => c.startsWith('terminal:'))).toBe(false)
    expect(preload).toMatch(/exposeInMainWorld\('sessionManager', api\)/)
    expect(preload).toMatch(/exposeInMainWorld\('terminal', terminal\)/)
  })

  it('the terminal takes a shell ID and a session ID, never a program, a command line or a folder', () => {
    // Every argument from the page goes through its check in the main process (see tests/terminal.test.ts).
    const checks: Array<[string, string]> = [
      ['open', 'assertTerminalOpen'],
      ['close', 'assertTerminalId'],
      ['openLink', 'assertWebLink'],
      ['input', 'assertTerminalInput'],
      ['resize', 'assertTerminalSize'],
      ['ack', 'assertCharCount']
    ]
    for (const [channel, check] of checks) expect(terminalIpc, channel).toMatch(new RegExp(`TERMINAL_IPC\\.${channel}\\b[\\s\\S]{0,160}${check}\\(`))
    expect(preload).toMatch(/open: \(request\) => ipcRenderer\.invoke\(TERMINAL_IPC\.open, request\)/)
    // Messages without an answer are dropped when wrong: never an exception in the main process.
    expect(terminalIpc).toMatch(/ipcMain\.on\(channel, \(event, \.\.\.args\) => \{\s*if \(!ctx\.isTrustedSender\(event\) \|\| !ctx\.service\) return\s*try \{/)
  })

  it('the Microsoft Store edition has no terminal', () => {
    expect(main).toMatch(/distribution\.channel === 'store'\s*\?\s*null\s*:\s*new TerminalService/)
    expect(terminalIpc).toMatch(/handle\(TERMINAL_IPC\.info, \(\) => ctx\.service\?\.support\(\) \?\? UNAVAILABLE\)/)
  })

  it('there is no IPC to persist or set the dry-run mode directly', () => {
    expect(Object.keys(IPC)).toEqual(expect.arrayContaining(['armRealDelete', 'returnToSafeMode', 'getSafetyMode']))
    expect(Object.keys(IPC).some((k) => /setDryRun|saveSafety|persist/i.test(k))).toBe(false)
  })
})
