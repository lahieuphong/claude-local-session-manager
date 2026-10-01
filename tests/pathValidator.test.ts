import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkLexical,
  isStrictlyInside,
  PathRejectedError,
  validateTarget,
  type AllowedRoots
} from '../src/main/security/pathValidator'
import { createFakeClaude, U, type FakeClaude } from './helpers/fakeClaude'

let fake: FakeClaude
let roots: AllowedRoots
beforeEach(async () => {
  fake = await createFakeClaude()
  roots = { projectsRoot: fake.projects, fileHistoryRoot: fake.fileHistory, sessionEnvRoot: fake.sessionEnv, desktopRoots: [fake.desktopRoot] }
})
afterEach(async () => {
  await fake.cleanup()
})

describe('isStrictlyInside', () => {
  it('handles equality, siblings with common prefixes and ".." look-alikes', () => {
    expect(isStrictlyInside('C:\\a\\b', 'C:\\a')).toBe(true)
    expect(isStrictlyInside('C:\\a', 'C:\\a')).toBe(false)
    expect(isStrictlyInside('C:\\ab\\c', 'C:\\a')).toBe(false)
    expect(isStrictlyInside('C:\\a\\..\\b', 'C:\\a')).toBe(false)
    expect(isStrictlyInside(path.join(fake.projects, '..foo'), fake.projects)).toBe(true)
    if (process.platform === 'win32') {
      expect(isStrictlyInside('D:\\a\\b', 'C:\\a')).toBe(false)
      expect(isStrictlyInside('c:\\A\\B', 'C:\\a')).toBe(true)
    }
  })
})

describe('lexical validation', () => {
  const reject = (p: unknown, kind: Parameters<typeof checkLexical>[1] = 'transcript'): void => {
    expect(() => checkLexical(p, kind, roots)).toThrow(PathRejectedError)
  }

  it('rejects traversal, relative paths and junk input', () => {
    reject(path.join(fake.projects, 'proj', '..', '..', 'evil.jsonl'))
    reject(`${fake.projects}\\proj\\..\\${U.A}.jsonl`)
    reject(`proj/${U.A}.jsonl`)
    reject('')
    reject(42)
    reject(undefined)
    reject(`${fake.projects}\\proj\\${U.A}.jsonl\0`)
    reject(`\\\\?\\${fake.projects}\\proj\\${U.A}.jsonl`)
  })

  it('rejects paths outside the allowed roots', () => {
    reject(path.join(fake.root, 'elsewhere', 'proj', `${U.A}.jsonl`))
    reject(path.join(fake.claudeHome, 'settings.json'))
    reject(path.join(fake.desktopRoot, 'acct', 'org', 'local_x.json'), 'transcript')
  })

  it('never allows the roots themselves, project folders or memory', () => {
    reject(fake.projects, 'session-data')
    reject(path.join(fake.projects, 'proj'), 'session-data')
    reject(path.join(fake.projects, 'proj', 'memory'), 'session-data')
    reject(path.join(fake.projects, 'proj', U.A, 'subagents'), 'session-data')
    reject(fake.desktopRoot, 'metadata')
    reject(path.join(fake.desktopRoot, 'acct'), 'metadata')
    reject(fake.fileHistory, 'file-history')
  })

  it('enforces exact names per kind', () => {
    reject(path.join(fake.projects, 'proj', 'notes.jsonl'))
    reject(path.join(fake.projects, 'proj', `${U.A}.json`))
    reject(path.join(fake.orgDir, 'scheduled-tasks.json'), 'metadata')
    reject(path.join(fake.orgDir, 'deleted_../x'), 'tombstone')
    reject(path.join(fake.fileHistory, 'not-a-uuid'), 'file-history')
  })

  it('accepts well-formed targets', () => {
    expect(checkLexical(path.join(fake.projects, 'proj', `${U.A}.jsonl`), 'transcript', roots).root).toBe(fake.projects)
    expect(checkLexical(path.join(fake.projects, 'proj', U.A), 'session-data', roots).root).toBe(fake.projects)
    expect(checkLexical(path.join(fake.projects, 'proj', 'agent-a1b2.jsonl'), 'subagent-log', roots).root).toBe(fake.projects)
    expect(checkLexical(path.join(fake.orgDir, 'local_abc.json'), 'metadata', roots).root).toBe(fake.desktopRoot)
    expect(checkLexical(path.join(fake.orgDir, 'deleted_abc'), 'tombstone', roots).root).toBe(fake.desktopRoot)
    expect(checkLexical(path.join(fake.fileHistory, U.A), 'file-history', roots).root).toBe(fake.fileHistory)
  })
})

describe('on-disk validation', () => {
  it('accepts a real transcript and reports missing files as non-existent', async () => {
    const file = await fake.writeTranscript('proj', U.A, '{}\n')
    await expect(validateTarget(file, 'transcript', roots)).resolves.toEqual({ path: file, exists: true })
    await expect(validateTarget(path.join(fake.projects, 'proj', `${U.B}.jsonl`), 'transcript', roots)).resolves.toMatchObject({
      exists: false
    })
  })

  it('rejects a type mismatch (directory where a file is expected)', async () => {
    await mkdir(path.join(fake.projects, 'proj', `${U.A}.jsonl`), { recursive: true })
    await expect(validateTarget(path.join(fake.projects, 'proj', `${U.A}.jsonl`), 'transcript', roots)).rejects.toThrow(/regular file/)
  })

  it('rejects a session folder that is a junction/symlink pointing outside', async () => {
    const outside = path.join(fake.root, 'precious')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'important.txt'), 'do not delete')
    await mkdir(path.join(fake.projects, 'proj'), { recursive: true })
    const link = path.join(fake.projects, 'proj', U.C)
    await symlink(outside, link, 'junction')
    await expect(validateTarget(link, 'session-data', roots)).rejects.toThrow(/symbolic link or junction/)
  })

  it('rejects a target whose parent project folder is a junction escaping the root', async () => {
    const outside = path.join(fake.root, 'outside-project')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, `${U.D}.jsonl`), '{}')
    await symlink(outside, path.join(fake.projects, 'linked-proj'), 'junction')
    await expect(validateTarget(path.join(fake.projects, 'linked-proj', `${U.D}.jsonl`), 'transcript', roots)).rejects.toThrow(
      /link|escapes/
    )
  })
})
