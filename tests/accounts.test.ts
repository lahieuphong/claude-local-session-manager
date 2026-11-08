import { existsSync } from 'node:fs'
import { mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkLexical, isInsideClaudeStorage, PathRejectedError } from '../src/main/security/pathValidator'
import { discoverRoots, rootsOf, toAllowedRoots } from '../src/main/services/claudeDiscovery'
import { createFakeClaude, createHarness, U, userLine, VSCODE_CLAUDE_EXE, type FakeClaude, type Harness } from './helpers/fakeClaude'

// A store that cannot be read this time (busy, locked): its scan fails while its files are still there.
const { failingStore } = vi.hoisted(() => ({ failingStore: { part: '' } }))
vi.mock('../src/main/services/sessionScanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/sessionScanner')>()
  return {
    ...actual,
    scanProjects: (...args: Parameters<typeof actual.scanProjects>) =>
      failingStore.part && args[0].includes(failingStore.part)
        ? Promise.reject(Object.assign(new Error(`EBUSY: resource busy or locked, scandir '${args[0]}'`), { code: 'EBUSY' }))
        : actual.scanProjects(...args)
  }
})

const PROJ = 'C--Work-demo'
const SECRET = 'do-not-read-this-token'
const UNKNOWN = '66666666-6666-4666-8666-666666666666'

let fake: FakeClaude
let h: Harness
beforeEach(async () => {
  fake = await createFakeClaude()
  h = createHarness(fake, { recentWriteMs: 0 })
  await writeFile(path.join(fake.home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'main@example.com', displayName: 'Main' } }))
})
afterEach(async () => {
  await fake.cleanup()
})

/** A sign-in that shares the main account's session store through folder links, like `~/.claude-accounts/claude-2`. */
async function addLinkedAccount(name = 'claude-2', email = 'second@example.com'): Promise<string> {
  const folder = path.join(fake.home, '.claude-accounts', name)
  await mkdir(path.join(folder, 'session-env'), { recursive: true })
  await mkdir(path.join(folder, 'sessions'), { recursive: true })
  await symlink(fake.projects, path.join(folder, 'projects'), 'junction')
  await symlink(fake.fileHistory, path.join(folder, 'file-history'), 'junction')
  await writeFile(
    path.join(folder, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, displayName: 'Second', planDisplayName: 'Ultra', organizationRateLimitTier: 'default_claude_max_20x', organizationName: SECRET }, primaryApiKey: SECRET })
  )
  await writeFile(path.join(folder, '.credentials.json'), JSON.stringify({ accessToken: SECRET }))
  return folder
}

async function envIn(folder: string, uuid: string): Promise<string> {
  const dir = path.join(folder, 'session-env', uuid)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'env.json'), '{}')
  return dir
}

const transcript = (uuid: string, title: string): Promise<string> => fake.writeTranscript(PROJ, uuid, [userLine(uuid, title, '2026-09-29T01:00:00Z')])

describe('Claude accounts on this PC', () => {
  it('one folder is one account, and nothing else changes', async () => {
    await transcript(U.A, 'only')
    const snap = await h.repo.scan()
    // The folder's name: with one account, its sign-in file is not even opened.
    expect(snap.roots.accounts.map((a) => [a.label, a.email])).toEqual([['claude', undefined]])
    expect(snap.sessions[0].accountIds).toEqual([snap.roots.accounts[0].id])
  })

  it('does not offer a folder with no sessions at all as an account', async () => {
    await rm(fake.projects, { recursive: true, force: true })
    const folder = path.join(fake.home, '.claude-accounts', 'with-data')
    await mkdir(path.join(folder, 'projects'), { recursive: true })
    expect((await discoverRoots(fake.env)).accounts.map((a) => a.path)).toEqual([folder])
  })

  it('lists the folder in use first, when CLAUDE_CONFIG_DIR says which one that is', async () => {
    const second = await addLinkedAccount()
    const { accounts, claudeHome } = await discoverRoots({ ...fake.env, claudeConfigDir: second })
    expect(claudeHome).toBe(second)
    expect(accounts.map((a) => a.label)).toEqual(['second', 'main'])
  })

  it('still counts one Claude Desktop folder once, whatever links lead to it', async () => {
    const real = path.join(fake.env.appData!, 'Claude', 'claude-code-sessions')
    await mkdir(real, { recursive: true })
    await mkdir(path.join(fake.env.appData!, 'Claude-3p'), { recursive: true })
    await symlink(real, path.join(fake.env.appData!, 'Claude-3p', 'claude-code-sessions'), 'junction')
    const roots = await discoverRoots({ ...fake.env, localAppData: undefined })
    expect(roots.desktopRoots.map((d) => d.path)).toEqual([real])
  })

  it('finds every sign-in and names it after its email, without reading anything else', async () => {
    await addLinkedAccount()
    await transcript(U.A, 'one')
    const snap = await h.repo.scan()
    expect(snap.roots.accounts.map((a) => [a.label, a.email, a.displayName])).toEqual([
      ['main', 'main@example.com', 'Main'],
      ['second', 'second@example.com', 'Second']
    ])
    expect(snap.roots.accounts.every((a) => /^[a-f0-9]{12}$/.test(a.id))).toBe(true)
    // The second reaches the main account's store through a link.
    expect(snap.roots.accounts.map((a) => a.storeRole)).toEqual(['original', 'shared'])
    // The plan is named as Claude Code's account picker names it; the main file has none.
    expect(snap.roots.accounts.map((a) => a.plan)).toEqual([undefined, 'Max 20x'])
    // Neither the tokens file nor any other field of .claude.json reaches the renderer.
    expect(JSON.stringify(snap)).not.toContain(SECRET)
  })

  it('names the plan from the usage tier, else from the plan name, and nothing it cannot read', async () => {
    const plans: Array<[Record<string, unknown>, string | undefined]> = [
      [{ userRateLimitTier: 'default_claude_max_5x', organizationRateLimitTier: 'default_claude_max_20x' }, 'Max 5x'],
      [{ organizationRateLimitTier: 'default_claude_max_20x', planDisplayName: 'Ultra' }, 'Max 20x'],
      [{ organizationRateLimitTier: 'default_claude_ai', planDisplayName: 'Pro' }, 'Pro'],
      [{ organizationRateLimitTier: 'default_claude_ai' }, undefined],
      [{ planDisplayName: 'x'.repeat(41) }, undefined],
      [{ planDisplayName: 42 }, undefined]
    ]
    for (const [i, [fields]] of plans.entries()) {
      const folder = path.join(fake.home, '.claude-accounts', `plan-${i}`)
      await mkdir(path.join(folder, 'projects'), { recursive: true })
      await writeFile(path.join(folder, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `plan-${i}@example.com`, ...fields } }))
    }
    const roots = await discoverRoots(fake.env)
    expect(roots.accounts.slice(1).map((a) => a.plan)).toEqual(plans.map(([, plan]) => plan))
  })

  it('reads the sign-in file Claude Code wrote last, in the folder or next to it', async () => {
    await addLinkedAccount()
    const inside = path.join(fake.claudeHome, '.claude.json')
    await writeFile(inside, JSON.stringify({ oauthAccount: { emailAddress: 'newer@example.com' } }))
    const later = new Date(Date.now() + 60_000)
    await utimes(inside, later, later)
    expect((await discoverRoots(fake.env)).accounts[0].email).toBe('newer@example.com')
    const earlier = new Date(Date.now() - 3_600_000)
    await utimes(inside, earlier, earlier)
    expect((await discoverRoots(fake.env)).accounts[0].email).toBe('main@example.com')
  })

  it('a store that cannot be read this time keeps its cache', async () => {
    const folder = path.join(fake.home, '.claude-accounts', 'own-store')
    const dir = path.join(folder, 'projects', PROJ)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${UNKNOWN}.jsonl`), JSON.stringify(userLine(UNKNOWN, 'in its own store', '2026-09-29T01:00:00Z')) + '\n')
    await transcript(U.A, 'in the main store')
    await h.repo.scan()
    const pruned: string[][] = []
    const prune = h.cache.prune.bind(h.cache)
    h.cache.prune = (live: Iterable<string>) => {
      pruned.push([...live])
      prune(live)
    }
    failingStore.part = 'own-store'
    try {
      const snap = await h.repo.scan()
      expect(snap.sessions.some((s) => s.displayTitle === 'in the main store')).toBe(true)
      expect(pruned).toEqual([])
    } finally {
      failingStore.part = ''
    }
    await h.repo.scan()
    expect(pruned).toHaveLength(1)
  })

  it('makes names unique, and falls back to the folder name', async () => {
    await addLinkedAccount('claude-2', 'main@another.example')
    await addLinkedAccount('claude-3', '')
    const { accounts } = await discoverRoots(fake.env)
    expect(accounts.map((a) => a.label)).toEqual(['main (claude)', 'main (claude-2)', 'claude-3'])
  })

  it('ignores a folder in .claude-accounts without Claude Code data', async () => {
    await mkdir(path.join(fake.home, '.claude-accounts', 'not-an-account'), { recursive: true })
    expect((await discoverRoots(fake.env)).accounts).toHaveLength(1)
  })

  it('a problem in an extra account does not hide the main one', async () => {
    await addLinkedAccount()
    const folder = path.join(fake.home, '.claude-accounts', 'broken')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'projects'), 'a file where a folder should be')
    await transcript(U.A, 'still here')
    const snap = await h.repo.scan()
    expect(snap.sessions.map((s) => s.displayTitle)).toEqual(['still here'])
  })

  it('counts a linked folder once', async () => {
    await addLinkedAccount()
    const roots = await discoverRoots(fake.env)
    expect(rootsOf(roots, 'projectsRoot')).toEqual([fake.projects])
    expect(rootsOf(roots, 'fileHistoryRoot')).toEqual([fake.fileHistory])
    expect(rootsOf(roots, 'sessionEnvRoot')).toHaveLength(2)
    expect(rootsOf(roots, 'liveSessionsDir')).toHaveLength(2)
  })
})

describe('which account a session is listed under', () => {
  it('follows the traces each account left, and the folder that holds the store when there are none', async () => {
    const second = await addLinkedAccount()
    await transcript(U.A, 'only second')
    await envIn(second, U.A)
    await transcript(U.B, 'both')
    await fake.writeUuidDir('session-env', U.B)
    await envIn(second, U.B)
    await transcript(U.C, 'only main')
    await fake.writeUuidDir('session-env', U.C)
    await transcript(U.D, 'no trace')
    const snap = await h.repo.scan()
    const [main, other] = snap.roots.accounts
    const of = (title: string): string[] => snap.sessions.find((s) => s.displayTitle === title)!.accountIds
    expect(of('only second')).toEqual([other.id])
    expect(of('both')).toEqual([main.id, other.id])
    expect(of('only main')).toEqual([main.id])
    expect(of('no trace')).toEqual([main.id])
  })

  it('counts a running session under the account that runs it', async () => {
    const second = await addLinkedAccount()
    await transcript(U.A, 'running')
    await writeFile(path.join(second, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: U.A }))
    const snap = await h.repo.scan()
    expect(snap.sessions[0].accountIds).toEqual([snap.roots.accounts[1].id])
  })

  it('a folder shared by both accounts proves nothing', async () => {
    const folder = path.join(fake.home, '.claude-accounts', 'all-linked')
    await mkdir(folder, { recursive: true })
    await symlink(fake.projects, path.join(folder, 'projects'), 'junction')
    await symlink(fake.sessionEnv, path.join(folder, 'session-env'), 'junction')
    await transcript(U.A, 'trace in the shared folder')
    await fake.writeUuidDir('session-env', U.A)
    const snap = await h.repo.scan()
    expect(snap.roots.accounts).toHaveLength(2)
    expect(snap.sessions[0].accountIds).toEqual([snap.roots.accounts[0].id])
  })

  it('an account with its own store owns what is in it', async () => {
    const folder = path.join(fake.home, '.claude-accounts', 'own-store')
    const dir = path.join(folder, 'projects', PROJ)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${UNKNOWN}.jsonl`), JSON.stringify(userLine(UNKNOWN, 'in its own store', '2026-09-29T01:00:00Z')) + '\n')
    await transcript(U.A, 'in the main store')
    const snap = await h.repo.scan()
    const [main, own] = snap.roots.accounts
    expect([main.storeRole, own.storeRole]).toEqual([undefined, undefined])
    expect(snap.sessions.find((s) => s.displayTitle === 'in its own store')?.accountIds).toEqual([own.id])
    expect(snap.sessions.find((s) => s.displayTitle === 'in the main store')?.accountIds).toEqual([main.id])
  })
})

describe('safety with several accounts', () => {
  it('protects a session running under another account, whichever account is on screen', async () => {
    // The hole this closes: the store is shared, but only the main account's registry was read.
    const second = await addLinkedAccount()
    await transcript(U.A, 'running in the second account')
    await writeFile(path.join(second, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: U.A, status: 'idle' }))
    h.processes.push({ pid: 4242, name: 'claude.exe', executablePath: VSCODE_CLAUDE_EXE })
    const snap = await h.repo.scan()
    const session = snap.sessions[0]
    expect(session.live?.pid).toBe(4242)
    const plan = await h.deleter.createPlan([session.id], false)
    expect(plan.sessions).toHaveLength(0)
    expect(plan.blocked[0].blockedCode).toBe('SESSION_IN_USE')
  })

  it('deleting removes the session from every account, and only that session', async () => {
    const second = await addLinkedAccount()
    const file = await transcript(U.A, 'delete me')
    const envMain = await fake.writeUuidDir('session-env', U.A)
    const envSecond = await envIn(second, U.A)
    const keepFile = await transcript(U.B, 'keep me')
    const keepEnv = await envIn(second, U.B)
    const snap = await h.repo.scan()
    const id = snap.sessions.find((s) => s.displayTitle === 'delete me')!.id
    expect(snap.sessions.find((s) => s.id === id)?.extraSessionEnvDirectories).toEqual([envSecond])

    const plan = await h.deleter.createPlan([id], false)
    expect(plan.sessions[0].items.map((i) => i.path)).toEqual(expect.arrayContaining([file, envMain, envSecond]))
    const r = await h.deleter.execute([id], 'DELETE', plan.planId, false)
    expect(r.ok).toBe(true)
    for (const gone of [file, envMain, envSecond]) expect(existsSync(gone)).toBe(false)
    for (const kept of [keepFile, keepEnv]) expect(existsSync(kept)).toBe(true)
  })

  it('deleting also removes file history kept separately by another account', async () => {
    const folder = path.join(fake.home, '.claude-accounts', 'own-history')
    await mkdir(path.join(folder, 'file-history', U.A), { recursive: true })
    await symlink(fake.projects, path.join(folder, 'projects'), 'junction')
    const other = path.join(folder, 'file-history', U.A, 'backup@v1')
    await writeFile(other, 'history')
    const file = await transcript(U.A, 'delete me')
    const main = await fake.writeUuidDir('file-history', U.A)
    const snap = await h.repo.scan()
    const session = snap.sessions[0]
    expect(session.extraFileHistoryDirectories).toEqual([path.dirname(other)])
    const plan = await h.deleter.createPlan([session.id], false)
    expect((await h.deleter.execute([session.id], 'DELETE', plan.planId, false)).ok).toBe(true)
    for (const gone of [file, main, other]) expect(existsSync(gone)).toBe(false)
  })

  it('deleting in an account with its own store leaves the others alone', async () => {
    const folder = path.join(fake.home, '.claude-accounts', 'own-store')
    const dir = path.join(folder, 'projects', PROJ)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${UNKNOWN}.jsonl`)
    await writeFile(file, JSON.stringify(userLine(UNKNOWN, 'in its own store', '2026-09-29T01:00:00Z')) + '\n')
    const keep = await transcript(U.A, 'in the main store')
    const snap = await h.repo.scan()
    const id = snap.sessions.find((s) => s.displayTitle === 'in its own store')!.id
    const plan = await h.deleter.createPlan([id], false)
    expect((await h.deleter.execute([id], 'DELETE', plan.planId, false)).ok).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(keep)).toBe(true)
  })

  it('still refuses anything outside the accounts it found', async () => {
    await addLinkedAccount()
    const allowed = toAllowedRoots(await discoverRoots(fake.env))
    const outside = path.join(fake.root, 'somewhere-else', 'session-env', U.A)
    expect(() => checkLexical(outside, 'session-env', allowed)).toThrow(PathRejectedError)
    // The second account's own session-env is allowed; its config folder itself never is.
    const second = path.join(fake.home, '.claude-accounts', 'claude-2')
    expect(() => checkLexical(path.join(second, 'session-env', U.A), 'session-env', allowed)).not.toThrow()
    expect(() => checkLexical(second, 'session-env', allowed)).toThrow(PathRejectedError)
  })

  it('refuses to export into another account folder', async () => {
    await addLinkedAccount()
    const allowed = toAllowedRoots(await discoverRoots(fake.env))
    expect(isInsideClaudeStorage(path.join(fake.home, '.claude-accounts', 'claude-2', 'export.json'), allowed)).toBe(true)
    expect(isInsideClaudeStorage(path.join(fake.root, 'exports', 'export.json'), allowed)).toBe(false)
  })
})
