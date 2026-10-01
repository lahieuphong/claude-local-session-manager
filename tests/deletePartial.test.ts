import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Simulate a file that cannot be deleted (e.g. locked by another process).
const { failing } = vi.hoisted(() => ({ failing: new Set<string>() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (p: string, opts?: Parameters<typeof actual.rm>[1]) => {
      if (failing.has(path.resolve(p).toLowerCase())) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${p}'`), { code: 'EBUSY' })
      }
      return actual.rm(p, opts)
    }
  }
})

const { createFakeClaude, createHarness, U, userLine } = await import('./helpers/fakeClaude')
const { lstatOrNull } = await import('../src/main/util/fsx')
type Fake = Awaited<ReturnType<typeof createFakeClaude>>

let fake: Fake
beforeEach(async () => {
  fake = await createFakeClaude()
  failing.clear()
})
afterEach(async () => {
  failing.clear()
  await fake.cleanup()
})

describe('partial delete failure', () => {
  it('reports exactly which items failed and never claims success', async () => {
    const transcript = await fake.writeTranscript('C--Work-demo', U.A, [userLine(U.A, 'locked', '2026-09-29T01:00:00Z')])
    const dataDir = await fake.writeSessionData('C--Work-demo', U.A)
    failing.add(path.resolve(transcript).toLowerCase())

    const h = createHarness(fake)
    const [s] = (await h.repo.scan()).sessions
    const plan = await h.deleter.createPlan([s.id], false)
    const r = await h.deleter.execute([s.id], 'DELETE', plan.token, false)

    expect(r.ok).toBe(false)
    expect(r.partial).toBe(true)
    expect(r.message).toMatch(/incomplete/i)
    expect(r.message).not.toMatch(/Permanently deleted/)
    const items = r.sessions[0].items
    expect(r.sessions[0].outcome).toBe('partial')
    expect(items.find((i) => i.kind === 'transcript')).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/EBUSY/) })
    expect(items.find((i) => i.kind === 'session-data')).toMatchObject({ outcome: 'deleted' })
    expect(await lstatOrNull(transcript)).not.toBeNull()
    expect(await lstatOrNull(dataDir)).toBeNull()
  })
})
