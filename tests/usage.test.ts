import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeLimits, claudeUsage, codexLimits, codexUsage } from '../src/main/services/usage'
import { formatUntilIntl } from '../src/shared/format'
import { FIVE_HOURS, ONE_WEEK } from '../src/shared/types'

const NOW = Date.parse('2026-11-09T10:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const H = 3_600_000

describe("Claude Code's recorded usage", () => {
  it('takes its list of limits, with their severity and model, and leaves out one not in force', () => {
    const usage = claudeLimits({
      oauthAccount: { emailAddress: 'a@b.c' },
      cachedUsageUtilization: {
        fetchedAtMs: NOW - H,
        accountUuid: 'not kept',
        utilization: {
          limits: [
            { kind: 'weekly_all', group: 'weekly', percent: 81, severity: 'warning', resets_at: iso(NOW + 50 * H), scope: null, is_active: true },
            { kind: 'five_hour', group: 'session', percent: 42.4, severity: 'normal', resets_at: iso(NOW + 2 * H), scope: null, is_active: true },
            { kind: 'weekly_scoped', group: 'weekly', percent: 12, severity: 'normal', resets_at: iso(NOW + 50 * H), scope: { model: { display_name: 'Fable' } }, is_active: true },
            { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: null, scope: { model: { display_name: 'Opus' } }, is_active: false }
          ],
          // Also given as a named window: counted once.
          seven_day: { utilization: 81, resets_at: iso(NOW + 50 * H) }
        }
      }
    })
    expect(usage).toEqual({
      recordedAt: NOW - H,
      limits: [
        { windowMinutes: FIVE_HOURS, percent: 42, resetsAt: NOW + 2 * H, severity: 'normal' },
        { windowMinutes: ONE_WEEK, percent: 81, resetsAt: NOW + 50 * H, severity: 'warning' },
        { windowMinutes: ONE_WEEK, model: 'Fable', percent: 12, resetsAt: NOW + 50 * H, severity: 'normal' }
      ]
    })
  })

  it('reads the named windows of older versions, and judges their severity itself', () => {
    const usage = claudeLimits({ cachedUsageUtilization: { fetchedAtMs: NOW, utilization: { five_hour: { utilization: 95, resets_at: iso(NOW + H) }, seven_day: null, seven_day_opus: { utilization: 76, resets_at: null } } } })
    expect(usage.limits).toEqual([
      { windowMinutes: FIVE_HOURS, percent: 95, resetsAt: NOW + H, severity: 'critical' },
      { windowMinutes: ONE_WEEK, model: 'Opus', percent: 76, resetsAt: undefined, severity: 'warning' }
    ])
  })

  it('has nothing to say about a file without it, or a broken one', () => {
    for (const config of [{}, null, 'text', { cachedUsageUtilization: { utilization: { limits: 'no' } } }]) expect(claudeLimits(config)).toEqual({ recordedAt: undefined, limits: [] })
  })
})

describe("Codex's recorded usage", () => {
  const event = (rateLimits: unknown, at = NOW) => ({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1 } }, rate_limits: rateLimits } })
  const secs = (ms: number): number => Math.floor(ms / 1000)

  it('takes a Plus plan’s five-hour and weekly limits, and a Free plan’s weekly one', () => {
    expect(
      codexLimits(
        event({ primary: { used_percent: 18, window_minutes: 300, resets_at: secs(NOW + H) }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: secs(NOW + 90 * H) }, plan_type: 'plus' })
      )
    ).toEqual({
      recordedAt: NOW,
      limits: [
        { windowMinutes: FIVE_HOURS, percent: 18, resetsAt: secs(NOW + H) * 1000, severity: 'normal' },
        { windowMinutes: ONE_WEEK, percent: 3, resetsAt: secs(NOW + 90 * H) * 1000, severity: 'normal' }
      ]
    })
    expect(codexLimits(event({ primary: { used_percent: 73, window_minutes: 10080, resets_at: secs(NOW + H) }, secondary: null }))?.limits).toEqual([
      { windowMinutes: ONE_WEEK, percent: 73, resetsAt: secs(NOW + H) * 1000, severity: 'normal' }
    ])
  })

  it('has no limits for an API key, reads the older "resets in" form, and ignores other lines', () => {
    expect(codexLimits(event({ primary: null, secondary: null, plan_type: null }))).toEqual({ recordedAt: NOW, limits: [] })
    expect(codexLimits(event({ primary: { used_percent: 50, window_minutes: 300, resets_in_seconds: 600 } }))?.limits[0].resetsAt).toBe(NOW + 600_000)
    expect(codexLimits({ type: 'response_item', payload: { type: 'message' } })).toBeNull()
  })
})

describe('reading the recorded usage from the files', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clsm-usage-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const line = (o: unknown): string => JSON.stringify(o) + '\n'
  const usageLine = (percent: number, at: number): string =>
    line({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: percent, window_minutes: 300, resets_at: Math.floor((at + H) / 1000) } } } })

  /** A session file in Codex's layout, sessions/<yyyy>/<mm>/<dd>/rollout-….jsonl, last written `at`. */
  const sessionFile = (home: string, day: string, name: string, text: string, at: number): string => {
    const folder = path.join(home, 'sessions', ...day.split('-'))
    mkdirSync(folder, { recursive: true })
    const file = path.join(folder, `rollout-${name}.jsonl`)
    writeFileSync(file, text)
    utimesSync(file, new Date(at), new Date(at))
    return file
  }

  it('Codex: the newest event of the session files of its latest days, found at the end of a large file', async () => {
    const home = path.join(dir, '.codex')
    sessionFile(home, '2026-11-01', 'old-day', usageLine(90, NOW - 200 * H), NOW - 200 * H)
    sessionFile(home, '2026-11-08', 'yesterday', usageLine(10, NOW - 5 * H), NOW - 5 * H)
    // Started since the last scan: no session knows of it yet. More than the end that is read, the newest event last.
    sessionFile(home, '2026-11-09', 'new', usageLine(5, NOW - 9 * H) + line({ type: 'response_item', payload: { text: 'x'.repeat(1_500_000) } }) + usageLine(64, NOW - H), NOW - H)
    const [usage, none] = await codexUsage([
      { id: 'a', home, known: [] },
      { id: 'b', home: path.join(dir, 'empty'), known: [path.join(dir, 'missing.jsonl')] }
    ])
    expect(usage).toMatchObject({ accountId: 'a', recordedAt: NOW - H, limits: [{ windowMinutes: FIVE_HOURS, percent: 64 }] })
    expect(none).toEqual({ accountId: 'b', limits: [] })
  })

  it('Codex: also an older session taken up again, that the scan knows of', async () => {
    const home = path.join(dir, '.codex')
    sessionFile(home, '2026-11-09', 'today', usageLine(20, NOW - 3 * H), NOW - 3 * H)
    const resumed = sessionFile(home, '2026-10-01', 'resumed', usageLine(33, NOW - 600_000), NOW - 600_000)
    const [usage] = await codexUsage([{ id: 'a', home, known: [resumed] }])
    expect(usage.limits[0].percent).toBe(33)
  })

  it('reads a file again once it has changed, and only then', async () => {
    const home = path.join(dir, '.codex')
    const file = sessionFile(home, '2026-11-09', 'live', usageLine(40, NOW - H), NOW - H)
    expect((await codexUsage([{ id: 'a', home, known: [] }]))[0].limits[0].percent).toBe(40)
    // Codex writes its next answer's usage.
    writeFileSync(file, usageLine(40, NOW - H) + usageLine(47, NOW))
    expect((await codexUsage([{ id: 'a', home, known: [] }]))[0].limits[0].percent).toBe(47)
  })

  it('Claude: the .claude.json Claude Code wrote last, of the places it may be', async () => {
    const home = path.join(dir, 'home.claude.json')
    const inside = path.join(dir, 'inside.claude.json')
    const usage = (percent: number) => ({ cachedUsageUtilization: { fetchedAtMs: NOW, utilization: { seven_day: { utilization: percent, resets_at: iso(NOW + H) } } } })
    writeFileSync(home, JSON.stringify(usage(20)))
    writeFileSync(inside, '\uFEFF' + JSON.stringify(usage(55)))
    utimesSync(home, new Date(NOW - 2 * H), new Date(NOW - 2 * H))
    const [newest, missing] = await claudeUsage([
      { id: 'main', configFiles: [home, inside] },
      { id: 'other', configFiles: [path.join(dir, 'none.json')] }
    ])
    expect(newest.limits.map((l) => l.percent)).toEqual([55])
    expect(missing).toEqual({ accountId: 'other', limits: [] })
  })
})

describe('a moment still to come', () => {
  it('says how long until it, in minutes, hours or days', () => {
    expect(formatUntilIntl(NOW + 40 * 60_000, 'en', NOW)).toBe('in 40 min.')
    expect(formatUntilIntl(NOW + 3 * H, 'en', NOW)).toBe('in 3 hr.')
    expect(formatUntilIntl(NOW + 75 * H, 'en', NOW)).toBe('in 3 days')
    expect(formatUntilIntl(undefined, 'en', NOW)).toBe('—')
  })
})
