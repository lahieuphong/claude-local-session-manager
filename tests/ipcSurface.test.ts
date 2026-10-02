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

  it('there is no IPC to persist or set the dry-run mode directly', () => {
    expect(Object.keys(IPC)).toEqual(expect.arrayContaining(['armRealDelete', 'returnToSafeMode', 'getSafetyMode']))
    expect(Object.keys(IPC).some((k) => /setDryRun|saveSafety|persist/i.test(k))).toBe(false)
  })
})
