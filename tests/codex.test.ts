import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODEX_TEST_EMAIL, CODEX_TEST_SECRET, codexAuth, codexUuid, createCodexHome, runFakeCodex, writeCodexProfile } from '../scripts/ui-test-codex.mjs'
import { CodexActions, type CodexRunner } from '../src/main/services/codex/codexActions'
import { CodexDeleteService, codexPlanItems } from '../src/main/services/codex/codexDelete'
import { CodexExportService } from '../src/main/services/codex/codexExport'
import { discoverCodexHomes, findCodexCli, identityFromAuth, type CodexEnv } from '../src/main/services/codex/codexHomes'
import { CodexRepository } from '../src/main/services/codex/codexRepository'
import { ManagerHiddenStore } from '../src/main/services/managerHiddenStore'
import { buildProcessStatus, classifyCodexProcess, globalGuard } from '../src/main/services/processService'

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)

let root: string
let home: string
let env: CodexEnv
let hidden: ManagerHiddenStore
let profile: ReturnType<typeof writeCodexProfile>

/** The Codex CLI as the test's in-process stand-in (the real one is never run). */
const fakeRunner: CodexRunner = async (_cli, args, codexHome) => runFakeCodex(args, codexHome)
const runnerThatDoesNothing: CodexRunner = async () => ({ code: 0, output: 'Done.' })

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'codex-test-'))
  home = path.join(root, 'home')
  mkdirSync(home, { recursive: true })
  profile = writeCodexProfile(home, { now: NOW })
  // Not a Codex folder: no database, no sessions.
  mkdirSync(path.join(home, '.codex-empty'), { recursive: true })
  // The marker of a UI test profile: only there does the Codex CLI stand-in count.
  mkdirSync(path.join(home, '.claude'), { recursive: true })
  writeFileSync(path.join(home, '.claude', '.ui-test-profile'), 'test')
  env = { homedir: home, appData: path.join(root, 'appdata'), searchPath: '', arch: 'x64', commandOverride: JSON.stringify([process.execPath, 'stand-in.mjs']) }
  hidden = new ManagerHiddenStore(null)
})
const repos: CodexRepository[] = []
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose()
  rmSync(root, { recursive: true, force: true })
})

const repoWith = (e: CodexEnv = env, now = (): number => NOW): CodexRepository => {
  const repo = new CodexRepository({ env: e, hidden, now })
  repos.push(repo)
  return repo
}
const setHistoryTime = (threadId: string, at: number): void => {
  const db = new DatabaseSync(path.join(profile.main, 'thread_history_1.sqlite'))
  db.prepare('UPDATE thread_items SET created_at_ms = ? WHERE thread_id = ?').run(at, threadId)
  db.close()
}
const byThread = (repo: CodexRepository, threadId: string) => repo.getSnapshot()?.sessions.find((s) => s.cliSessionId === threadId)
const stateDb = (folder = profile.main) => path.join(folder, 'state_5.sqlite')
const threadRow = (id: string, folder = profile.main) => {
  const db = new DatabaseSync(stateDb(folder), { readOnly: true })
  try {
    return db.prepare('SELECT archived, rollout_path FROM threads WHERE id = ?').get(id) as { archived: number; rollout_path: string } | undefined
  } finally {
    db.close()
  }
}

describe('Codex folders and CLI', () => {
  it('finds ~/.codex first, then every ~/.codex-<name> that holds sessions, and nothing else', async () => {
    const { homes } = await discoverCodexHomes(env)
    expect(homes.map((h) => [h.label, h.main, !!h.stateDb, !!h.historyDb])).toEqual([
      ['codex.user', true, true, true],
      ['account-2', false, true, true]
    ])
  })

  it('names each folder after its sign-in: the email and plan of a ChatGPT account, or an API key', async () => {
    const { homes } = await discoverCodexHomes(env)
    expect(homes.map((h) => ({ label: h.label, email: h.email, plan: h.plan, apiKey: h.apiKey }))).toEqual([
      { label: 'codex.user', email: CODEX_TEST_EMAIL, plan: 'Pro', apiKey: undefined },
      { label: 'account-2', email: undefined, plan: undefined, apiKey: true }
    ])
    expect(JSON.stringify(homes)).not.toContain(CODEX_TEST_SECRET)
  })

  it('tells two folders of one account apart by their folder', async () => {
    writeFileSync(path.join(profile.second, 'auth.json'), JSON.stringify(codexAuth({ email: CODEX_TEST_EMAIL, plan: 'plus' })))
    const { homes } = await discoverCodexHomes(env)
    expect(homes.map((h) => [h.label, h.plan])).toEqual([
      ['codex.user (codex)', 'Pro'],
      ['codex.user (account-2)', 'Plus']
    ])
  })

  it('with a single folder, does not even open its sign-in file', async () => {
    rmSync(profile.second, { recursive: true, force: true })
    const { homes } = await discoverCodexHomes(env)
    expect(homes).toHaveLength(1)
    expect(homes[0]).toMatchObject({ label: 'codex' })
    expect(homes[0].email).toBeUndefined()
  })

  it('takes only the email and plan from a sign-in file, whatever else it holds', () => {
    expect(identityFromAuth(JSON.stringify(codexAuth({ email: 'a@b.c', plan: 'edu_plus' })))).toEqual({ email: 'a@b.c', plan: 'Edu Plus' })
    expect(identityFromAuth(JSON.stringify(codexAuth({ email: 'a@b.c', plan: 'self_serve_business_usage_based' })))).toEqual({ email: 'a@b.c', plan: 'Business' })
    expect(identityFromAuth(JSON.stringify(codexAuth({ email: 'a@b.c', plan: 'unknown' })))).toEqual({ email: 'a@b.c' })
    expect(identityFromAuth(JSON.stringify(codexAuth()))).toEqual({ apiKey: true })
    // An older file with no auth_mode: the ID token decides; a key alone means an API key.
    const chatgpt = codexAuth({ email: 'a@b.c', plan: 'pro' })
    expect(identityFromAuth(JSON.stringify({ OPENAI_API_KEY: null, tokens: chatgpt.tokens }))).toEqual({ email: 'a@b.c', plan: 'Pro' })
    expect(identityFromAuth(JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))).toEqual({ apiKey: true })
    // Saved by a Windows editor, with a byte-order mark.
    expect(identityFromAuth('﻿' + JSON.stringify(chatgpt))).toEqual({ email: 'a@b.c', plan: 'Pro' })
    // Anything broken names nothing.
    for (const text of ['', 'not json', 'null', '[]', '{"tokens":{"id_token":"a.b.c"}}', '{"tokens":{"id_token":42}}']) expect(identityFromAuth(text)).toEqual({})
  })

  it('honours CODEX_HOME for the main folder', async () => {
    const custom = createCodexHome(path.join(root, 'elsewhere'), [{ id: codexUuid(50), name: 'Elsewhere', cwd: 'C:\\x', updatedAt: NOW - 1e7 }])
    const { homes } = await discoverCodexHomes({ ...env, codexHome: custom })
    expect(homes[0]).toMatchObject({ main: true, label: 'elsewhere' })
    expect(homes.map((h) => h.label)).toContain('codex.user')
  })

  it('takes the test stand-in only in a UI test profile', async () => {
    expect((await findCodexCli(env))?.source).toBe('test')
    rmSync(path.join(home, '.claude', '.ui-test-profile'))
    expect(await findCodexCli(env)).toBeNull()
  })

  it('runs the npm Codex CLI, else the one of the VS Code extension, never a shell script', async () => {
    const npmExe = path.join(env.appData as string, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    const extExe = path.join(home, '.vscode', 'extensions', 'openai.chatgpt-26.1021.1-win32-x64', 'bin', 'windows-x86_64', 'codex.exe')
    const plain = { ...env, commandOverride: undefined }
    expect(await findCodexCli(plain)).toBeNull()
    mkdirSync(path.dirname(extExe), { recursive: true })
    writeFileSync(extExe, '')
    expect(await findCodexCli(plain)).toMatchObject({ command: extExe, source: 'vscode' })
    mkdirSync(path.dirname(npmExe), { recursive: true })
    writeFileSync(npmExe, '')
    expect(await findCodexCli(plain)).toMatchObject({ command: npmExe, source: 'npm' })
    // The npm shim (codex.cmd) is a script for a shell: never chosen.
    writeFileSync(path.join(env.appData as string, 'npm', 'codex.cmd'), '@echo off')
    expect((await findCodexCli({ ...plain, appData: path.join(root, 'nowhere'), searchPath: path.join(env.appData as string, 'npm') }))?.command ?? null).toBe(extExe)
  })
})

describe('Codex sessions', () => {
  it('lists the sessions the user started, not sub-agents or Codex reviews, in every folder', async () => {
    const repo = repoWith()
    const snap = await repo.scan()
    const { roles } = profile
    expect(snap.provider).toBe('codex')
    const ids = snap.sessions.map((s) => s.cliSessionId).sort()
    expect(ids).toEqual([roles.named, roles.aiTitle, roles.archived, roles.withAgents, roles.recent, roles.longVi, roles.secondActive, roles.secondArchived].sort())
    const [main, second] = snap.roots.accounts
    expect(snap.sessions.filter((s) => s.accountIds.includes(main.id))).toHaveLength(profile.userSessions.main)
    expect(snap.sessions.filter((s) => s.accountIds.includes(second.id))).toHaveLength(profile.userSessions.second)
    expect(snap.sessions.every((s) => s.provider === 'codex' && s.kind === 'codex')).toBe(true)
  })

  it('names, counts and sizes a session the way Codex stores it', async () => {
    const repo = repoWith()
    await repo.scan()
    const { roles } = profile
    const named = byThread(repo, roles.named)
    expect(named).toMatchObject({ displayTitle: 'Refactor the payment flow', titleSource: 'custom-title', status: 'active', gitBranch: 'feature/pay', userMessageCount: 3, assistantMessageCount: 3, toolUseCount: 1 })
    expect(named?.hasTranscript && named.transcriptFile && existsSync(named.transcriptFile)).toBeTruthy()
    expect(byThread(repo, roles.aiTitle)).toMatchObject({ displayTitle: 'Summarise the OCR error log', titleSource: 'ai-title', transcriptFile: undefined, hasTranscript: true })
    expect(byThread(repo, roles.archived)).toMatchObject({ archived: true, status: 'archived' })
    const parent = byThread(repo, roles.withAgents)
    expect(parent?.subagentCount).toBe(2)
    expect(parent?.extraTranscriptFiles).toHaveLength(2)
    expect(parent?.totalSize).toBeGreaterThan((parent?.transcriptSize ?? 0) + (parent?.otherSize ?? 0))
  })

  it('marks a session Codex wrote to a moment ago as possibly running', async () => {
    const repo = repoWith()
    await repo.scan()
    expect(byThread(repo, profile.roles.recent)?.live).toEqual({ pid: 0, state: 'recent' })
    expect(byThread(repo, profile.roles.named)?.live).toBeUndefined()
  })

  it('a turn Codex still runs counts as activity, one left over from long ago does not', async () => {
    const extra = createCodexHome(path.join(home, '.codex-turns'), [
      { id: codexUuid(60), name: 'Turn running', cwd: 'C:\\x', updatedAt: NOW - 3_600_000, turnInProgressAt: NOW - 5 * 60_000, items: [['userMessage', 'go']] },
      { id: codexUuid(61), name: 'Turn left over', cwd: 'C:\\x', updatedAt: NOW - 3_600_000, turnInProgressAt: NOW - 10 * 3_600_000, items: [['userMessage', 'go']] }
    ])
    expect(extra).toBeTruthy()
    const repo = repoWith()
    await repo.scan()
    expect(byThread(repo, codexUuid(60))?.live).toEqual({ pid: 0, state: 'recent' })
    expect(byThread(repo, codexUuid(61))?.live).toBeUndefined()
  })

  it('archiving through Codex is not activity, though Codex sets the session update time', async () => {
    const repo = repoWith()
    await repo.scan()
    const actions = new CodexActions(repo, false, fakeRunner)
    const id = byThread(repo, profile.roles.named)?.id as string
    await actions.setArchived(id, true)
    await actions.setArchived(id, false)
    expect(byThread(repo, profile.roles.named)?.live).toBeUndefined()
    expect((await new CodexDeleteService(repo, { dryRun: false, run: fakeRunner, now: () => NOW }).createPlan([id], false)).blocked).toEqual([])
  })

  it('finds the last record time even when the last record is long', async () => {
    const repo = repoWith()
    await repo.scan()
    const file = byThread(repo, profile.roles.named)?.transcriptFile as string
    const long = { timestamp: new Date(NOW - 30_000).toISOString(), type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(300_000) } }
    appendFileSync(file, JSON.stringify(long) + '\n')
    utimesSync(file, new Date(NOW - 3_600_000), new Date(NOW - 3_600_000))
    await repo.scan()
    expect(byThread(repo, profile.roles.named)?.live).toEqual({ pid: 0, state: 'recent' })
  })

  it('reads again when a "may be running" mark runs out', async () => {
    const repo = repoWith()
    await repo.scan()
    const at = repo.getBusyCheckAt()
    expect(at).not.toBeNull()
    expect((at as number) - NOW).toBeGreaterThan(0)
    expect((at as number) - NOW).toBeLessThanOrEqual(2 * 60_000)
    repo.dispose()
    expect(repo.getBusyCheckAt()).toBeNull()
  })

  it('lists sessions from before Codex recorded who started them, but not sub-agents of that time', async () => {
    const db = new DatabaseSync(stateDb())
    db.prepare(`UPDATE threads SET thread_source = NULL WHERE id IN (?, ?)`).run(profile.roles.named, profile.roles.agentA)
    db.close()
    const repo = repoWith()
    await repo.scan()
    expect(byThread(repo, profile.roles.named)).toBeDefined()
    expect(byThread(repo, profile.roles.agentA)).toBeUndefined()
  })

  it('a session file touched without a new record is not activity (codex unarchive does that)', async () => {
    const repo = repoWith()
    await repo.scan()
    const file = byThread(repo, profile.roles.named)?.transcriptFile as string
    utimesSync(file, new Date(), new Date())
    await repo.scan()
    expect(byThread(repo, profile.roles.named)?.live).toBeUndefined()
    // A new record is.
    appendFileSync(file, JSON.stringify({ timestamp: new Date(NOW - 30_000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }) + '\n')
    await repo.scan()
    expect(byThread(repo, profile.roles.named)?.live).toEqual({ pid: 0, state: 'recent' })
  })

  it('takes nothing but the email and plan from the Codex sign-in files', async () => {
    const snap = await repoWith().scan()
    expect(snap.roots.accounts.map((a) => [a.email, a.plan, a.apiKey])).toEqual([
      [CODEX_TEST_EMAIL, 'Pro', undefined],
      [undefined, undefined, true]
    ])
    expect(JSON.stringify(snap)).not.toContain(CODEX_TEST_SECRET)
  })

  it('hides in this app only, and keeps it across scans', async () => {
    const repo = repoWith()
    await repo.scan()
    const actions = new CodexActions(repo, false, fakeRunner)
    const id = byThread(repo, profile.roles.named)?.id as string
    expect((await actions.setHidden(id, true)).ok).toBe(true)
    expect(byThread(repo, profile.roles.named)?.hiddenInManager).toBe(true)
    expect(threadRow(profile.roles.named)?.archived).toBe(0)
  })
})

describe('Codex archive', () => {
  it('asks Codex to archive and restore, and checks that it did', async () => {
    const repo = repoWith()
    await repo.scan()
    const actions = new CodexActions(repo, false, fakeRunner)
    const id = byThread(repo, profile.roles.named)?.id as string
    const archived = await actions.setArchived(id, true)
    expect(archived).toMatchObject({ ok: true, msg: { key: 'codex.archived' } })
    expect(threadRow(profile.roles.named)).toMatchObject({ archived: 1 })
    expect(threadRow(profile.roles.named)?.rollout_path).toContain('archived_sessions')
    expect(byThread(repo, profile.roles.named)?.archived).toBe(true)
    expect((await actions.setArchived(id, false)).ok).toBe(true)
    expect(threadRow(profile.roles.named)?.archived).toBe(0)
  })

  it('reads Codex again before archiving: a session resumed since is not touched', async () => {
    const repo = repoWith()
    await repo.scan()
    const id = byThread(repo, profile.roles.named)?.id as string
    expect(byThread(repo, profile.roles.named)?.live).toBeUndefined()
    // Resumed in Codex after the list was read.
    setHistoryTime(profile.roles.named, NOW - 10_000)
    expect(await new CodexActions(repo, false, fakeRunner).setArchived(id, true)).toMatchObject({ ok: false, code: 'SESSION_IN_USE' })
    expect(threadRow(profile.roles.named)?.archived).toBe(0)
  })

  it('reports a Codex that said yes but changed nothing', async () => {
    const repo = repoWith()
    await repo.scan()
    const r = await new CodexActions(repo, false, runnerThatDoesNothing).setArchived(byThread(repo, profile.roles.named)?.id as string, true)
    expect(r).toMatchObject({ ok: false, code: 'IO_ERROR', msg: { key: 'codex.notApplied' } })
  })

  it('refuses a running session, a missing CLI, and only pretends in Safe Mode', async () => {
    const repo = repoWith()
    await repo.scan()
    const recent = byThread(repo, profile.roles.recent)?.id as string
    expect(await new CodexActions(repo, false, fakeRunner).setArchived(recent, true)).toMatchObject({ ok: false, code: 'SESSION_IN_USE' })
    const named = byThread(repo, profile.roles.named)?.id as string
    expect(await new CodexActions(repo, true, fakeRunner).setArchived(named, true)).toMatchObject({ ok: true, dryRun: true })
    expect(threadRow(profile.roles.named)?.archived).toBe(0)
    const noCli = repoWith({ ...env, commandOverride: undefined })
    await noCli.scan()
    expect(await new CodexActions(noCli, false, fakeRunner).setArchived(byThread(noCli, profile.roles.named)?.id as string, true)).toMatchObject({ ok: false, code: 'NOT_SUPPORTED', msg: { key: 'codex.cliMissing' } })
  })
})

describe('Codex delete', () => {
  const deleter = (repo: CodexRepository, opts: Partial<ConstructorParameters<typeof CodexDeleteService>[1]> = {}) =>
    new CodexDeleteService(repo, { dryRun: false, run: fakeRunner, now: () => NOW, ...opts })

  it('plans exactly what Codex will remove: the row and its sub-agents, the conversation, the files, the index line', async () => {
    const repo = repoWith()
    await repo.scan()
    const record = repo.getRecord(byThread(repo, profile.roles.withAgents)?.id as string)
    expect(record).toBeDefined()
    const items = codexPlanItems(record as NonNullable<typeof record>)
    expect(items.map((i) => i.kind)).toEqual(['codex-thread', 'codex-history', 'codex-rollout', 'codex-rollout', 'codex-rollout', 'codex-index'])
    expect(items.every((i) => i.action === 'codex-delete')).toBe(true)
    expect(items[0].noteMsg).toMatchObject({ key: 'codex.noteThreadWithAgents', params: { count: 2 } })
    const plan = await deleter(repo).createPlan([record?.session.id as string], false)
    expect(plan.sessions[0].willNotDelete.map((k) => k.path)).toEqual([record?.session.projectPath, realpathSync.native(profile.main)])
    expect(plan.blocked).toEqual([])
  })

  it('deletes through Codex, then checks every part is gone', async () => {
    const repo = repoWith()
    await repo.scan()
    const id = byThread(repo, profile.roles.withAgents)?.id as string
    const files = [byThread(repo, profile.roles.withAgents)?.transcriptFile, ...(byThread(repo, profile.roles.withAgents)?.extraTranscriptFiles ?? [])]
    const service = deleter(repo)
    const plan = await service.createPlan([id], false)
    const result = await service.execute([id], 'DELETE', plan.planId, false)
    expect(result).toMatchObject({ ok: true, dryRun: false })
    expect(result.sessions[0].items.every((i) => i.outcome === 'deleted')).toBe(true)
    for (const t of [profile.roles.withAgents, profile.roles.agentA, profile.roles.agentB]) expect(threadRow(t)).toBeUndefined()
    for (const f of files) expect(existsSync(f as string)).toBe(false)
    expect(readFileSync(path.join(profile.main, 'session_index.jsonl'), 'utf8')).not.toContain(profile.roles.withAgents)
    expect(byThread(repo, profile.roles.withAgents)).toBeUndefined()
    // The other sessions are untouched.
    expect(threadRow(profile.roles.named)).toBeDefined()
  })

  it('says what is still there when Codex fails, and keeps the manager records', async () => {
    const repo = repoWith()
    await repo.scan()
    const actions = new CodexActions(repo, false, fakeRunner)
    const id = byThread(repo, profile.roles.named)?.id as string
    await actions.setHidden(id, true)
    const service = deleter(repo, { run: async () => ({ code: 1, output: 'Error: database is locked' }) })
    const plan = await service.createPlan([id], false)
    const result = await service.execute([id], 'DELETE', plan.planId, false)
    expect(result.ok).toBe(false)
    expect(result.sessions[0].outcome).toBe('failed')
    expect(result.sessions[0].items.find((i) => i.kind === 'codex-thread')).toMatchObject({ outcome: 'failed', error: expect.stringContaining('database is locked') })
    expect(result.sessions[0].items.find((i) => i.kind === 'manager-record')?.outcome).toBe('skipped')
    expect(hidden.has(`codex:${profile.roles.named}`)).toBe(true)
  })

  it('a new plan reads Codex again: a session that has stopped can be deleted', async () => {
    const repo = repoWith()
    await repo.scan()
    const id = byThread(repo, profile.roles.recent)?.id as string
    const service = deleter(repo)
    expect((await service.createPlan([id], false)).blocked).toHaveLength(1)
    setHistoryTime(profile.roles.recent, NOW - 3_600_000)
    const db = new DatabaseSync(stateDb())
    db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run('', profile.roles.recent)
    db.close()
    expect((await service.createPlan([id], false)).blocked).toEqual([])
  })

  it('checks every row the plan names: one of a sub-agent left behind is reported', async () => {
    const repo = repoWith()
    await repo.scan()
    const id = byThread(repo, profile.roles.withAgents)?.id as string
    // A Codex that removes the session's own row and nothing else.
    const partial: CodexRunner = async (_cli, args, codexHome) => {
      const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'))
      db.prepare('DELETE FROM threads WHERE id = ?').run(args[2])
      db.close()
      return { code: 0, output: 'Deleted session.' }
    }
    const service = deleter(repo, { run: partial })
    const plan = await service.createPlan([id], false)
    const result = await service.execute([id], 'DELETE', plan.planId, false)
    expect(result.ok).toBe(false)
    expect(result.sessions[0].items.find((i) => i.kind === 'codex-thread')?.outcome).toBe('failed')
    expect(threadRow(profile.roles.agentA)).toBeDefined()
  })

  it('in Safe Mode checks everything and changes nothing', async () => {
    const repo = repoWith()
    await repo.scan()
    const id = byThread(repo, profile.roles.named)?.id as string
    const service = deleter(repo, { dryRun: true })
    const plan = await service.createPlan([id], false)
    const result = await service.execute([id], 'DELETE', plan.planId, false)
    expect(result).toMatchObject({ ok: true, dryRun: true })
    expect(threadRow(profile.roles.named)).toBeDefined()
  })

  it('refuses a stale plan, a wrong confirmation, a running session and a missing CLI', async () => {
    const repo = repoWith()
    await repo.scan()
    const id = byThread(repo, profile.roles.named)?.id as string
    const service = deleter(repo)
    const plan = await service.createPlan([id], false)
    expect(await service.execute([id], 'delete', plan.planId, false)).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    // The conversation grew after the plan was shown: the plan no longer says what would go.
    const fresh = await service.createPlan([id], false)
    const db = new DatabaseSync(path.join(profile.main, 'thread_history_1.sqlite'))
    // (An item dated an hour ago: a change to what would be deleted, not Codex at work.)
    db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(profile.roles.named, 'turn-2', 'late', 99, NOW - 3_600_000, JSON.stringify({ type: 'agentMessage', text: 'late' }), 'agentMessage', 99)
    db.close()
    expect(await service.execute([id], 'DELETE', fresh.planId, false)).toMatchObject({ ok: false, code: 'STALE_PLAN' })
    expect(threadRow(profile.roles.named)).toBeDefined()
    // Codex writing to it after the plan was shown: it is running now.
    const third = await service.createPlan([id], false)
    const busy = new DatabaseSync(path.join(profile.main, 'thread_history_1.sqlite'))
    busy.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(profile.roles.named, 'turn-3', 'now', 100, NOW, JSON.stringify({ type: 'agentMessage', text: 'working' }), 'agentMessage', 100)
    busy.close()
    expect(await service.execute([id], 'DELETE', third.planId, false)).toMatchObject({ ok: false, code: 'SESSION_IN_USE' })
    expect(threadRow(profile.roles.named)).toBeDefined()

    const recentPlan = await service.createPlan([byThread(repo, profile.roles.recent)?.id as string], false)
    expect(recentPlan.blocked[0]).toMatchObject({ blockedCode: 'SESSION_IN_USE', blockedMsg: { key: 'codex.recentlyActive' } })
    const noCli = repoWith({ ...env, commandOverride: undefined })
    await noCli.scan()
    const noCliPlan = await deleter(noCli).createPlan([byThread(noCli, profile.roles.named)?.id as string], false)
    expect(noCliPlan.blocked[0]).toMatchObject({ blockedCode: 'NOT_SUPPORTED', blockedMsg: { key: 'codex.cliMissing' } })
  })
})

describe('Codex export', () => {
  it('writes the conversation as Markdown, never into a Codex folder', async () => {
    const repo = repoWith()
    await repo.scan()
    const record = repo.getRecord(byThread(repo, profile.roles.aiTitle)?.id as string)
    const out = path.join(root, 'out')
    mkdirSync(out)
    const exporter = new CodexExportService(repo, { chooseFile: async () => null, chooseDirectory: async () => null })
    await exporter.writeExport(record as NonNullable<typeof record>, 'markdown', path.join(out, 'x.md'))
    const md = readFileSync(path.join(out, 'x.md'), 'utf8')
    expect(md).toContain('# Summarise the OCR error log')
    expect(md).toContain('## User')
    expect(md).toContain('Refactor the payment module')
    await exporter.writeExport(record as NonNullable<typeof record>, 'jsonl', path.join(out, 'x.jsonl'))
    expect(readFileSync(path.join(out, 'x.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5)
    await expect(exporter.writeExport(record as NonNullable<typeof record>, 'markdown', path.join(profile.main, 'x.md'))).rejects.toThrow(/Codex folder/)
  })
})

describe('Codex of other versions', () => {
  it('exports a conversation from a history database without item times', async () => {
    const db = new DatabaseSync(path.join(profile.main, 'thread_history_1.sqlite'))
    db.exec('ALTER TABLE thread_items DROP COLUMN created_at_ms')
    db.close()
    const repo = repoWith()
    await repo.scan()
    const record = repo.getRecord(byThread(repo, profile.roles.aiTitle)?.id as string)
    const out = path.join(root, 'out.md')
    await new CodexExportService(repo, { chooseFile: async () => null, chooseDirectory: async () => null }).writeExport(record as NonNullable<typeof record>, 'markdown', out)
    expect(readFileSync(out, 'utf8')).toContain('Refactor the payment module')
  })
})

describe('Codex processes', () => {
  it('tells the Codex app and CLI apart from Claude, and never lets them block Claude', () => {
    const app = { pid: 1, name: 'ChatGPT.exe', executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1016.8622.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe' }
    const chatgpt = { pid: 2, name: 'ChatGPT.exe', executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT-Desktop_1.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe' }
    const cli = { pid: 3, name: 'codex.exe', executablePath: 'C:\\x\\codex.exe' }
    const node = { pid: 4, name: 'node.exe', commandLine: 'node C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js' }
    expect([app, chatgpt, cli, node].map(classifyCodexProcess)).toEqual(['codex-app', null, 'codex-cli', 'codex-cli'])
    const status = buildProcessStatus([app, cli], [])
    expect(status).toMatchObject({ codexAppRunning: true, desktopRunning: false })
    expect(status.codexProcesses).toHaveLength(2)
    expect(globalGuard(status)).toBeNull()
  })
})
