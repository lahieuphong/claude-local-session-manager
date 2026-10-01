import { describe, expect, it } from 'vitest'
import { classifyRawTitle, describeRawTitle, promptToTitle, resolveDisplayTitle, UNTITLED } from '../src/shared/titles'
import { confirmationPhrases, isConfirmationValid } from '../src/shared/confirm'

describe('raw title classification', () => {
  it('distinguishes missing, null, empty, whitespace and real titles', () => {
    expect(classifyRawTitle({})).toEqual({ kind: 'missing' })
    expect(classifyRawTitle({ title: null })).toEqual({ kind: 'null' })
    expect(classifyRawTitle({ title: '' })).toEqual({ kind: 'empty', value: '' })
    expect(classifyRawTitle({ title: '   ' })).toEqual({ kind: 'empty', value: '   ' })
    expect(classifyRawTitle({ title: 'Hello' })).toEqual({ kind: 'string', value: 'Hello' })
    expect(classifyRawTitle({ title: 42 })).toEqual({ kind: 'invalid', type: 'number' })
    expect(classifyRawTitle({ title: ['x'] })).toEqual({ kind: 'invalid', type: 'array' })
    expect(classifyRawTitle(null)).toEqual({ kind: 'missing' })
  })

  it('describes raw values for the details panel', () => {
    expect(describeRawTitle({ kind: 'missing' })).toBe('(field missing)')
    expect(describeRawTitle({ kind: 'null' })).toBe('null')
    expect(describeRawTitle({ kind: 'empty', value: '' })).toBe('"" (empty string)')
    expect(describeRawTitle({ kind: 'string', value: 'Tối ưu' })).toBe('"Tối ưu"')
    expect(describeRawTitle(undefined)).toBe('(no metadata file)')
  })
})

describe('display title fallback', () => {
  it('uses a valid metadata title first', () => {
    expect(resolveDisplayTitle({ metadataTitle: { kind: 'string', value: ' Real title ' }, customTitle: 'x' })).toEqual({
      title: 'Real title',
      source: 'metadata'
    })
  })

  it.each([
    ['missing', { kind: 'missing' } as const],
    ['null', { kind: 'null' } as const],
    ['empty', { kind: 'empty', value: '' } as const],
    ['literal Untitled', { kind: 'string', value: 'Untitled' } as const]
  ])('falls back when the metadata title is %s', (_label, metadataTitle) => {
    expect(resolveDisplayTitle({ metadataTitle, aiTitle: 'AI title' })).toEqual({ title: 'AI title', source: 'ai-title' })
  })

  it('follows custom → ai → summary → first prompt → last prompt → Untitled', () => {
    const base = { metadataTitle: { kind: 'null' } as const }
    expect(resolveDisplayTitle({ ...base, customTitle: 'C', aiTitle: 'A' }).source).toBe('custom-title')
    expect(resolveDisplayTitle({ ...base, summary: 'S', firstUserMessage: 'F' }).source).toBe('summary')
    expect(resolveDisplayTitle({ ...base, firstUserMessage: 'First prompt', lastPrompt: 'L' })).toEqual({
      title: 'First prompt',
      source: 'first-prompt'
    })
    expect(resolveDisplayTitle({ ...base, lastPrompt: 'Last' }).source).toBe('last-prompt')
    expect(resolveDisplayTitle({ ...base, customTitle: '  ', aiTitle: '' })).toEqual({ title: UNTITLED, source: 'untitled' })
    expect(resolveDisplayTitle({})).toEqual({ title: UNTITLED, source: 'untitled' })
  })

  it('shortens long prompts to a single line', () => {
    const long = 'Xin chào\n\n' + 'rất dài '.repeat(30)
    const t = promptToTitle(long)
    expect(t.length).toBeLessThanOrEqual(80)
    expect(t).not.toContain('\n')
    expect(t.endsWith('…')).toBe(true)
  })
})

describe('delete confirmation phrases', () => {
  it('accepts DELETE / DELETE PERMANENTLY for a single session', () => {
    const p = confirmationPhrases(1, false)
    expect(isConfirmationValid('DELETE', p)).toBe(true)
    expect(isConfirmationValid(' DELETE PERMANENTLY ', p)).toBe(true)
    expect(isConfirmationValid('delete', p)).toBe(false)
    expect(isConfirmationValid('DELETE 1', p)).toBe(false)
    expect(isConfirmationValid(undefined, p)).toBe(false)
  })

  it('requires DELETE <n> for bulk', () => {
    const p = confirmationPhrases(5, true)
    expect(isConfirmationValid('DELETE 5', p)).toBe(true)
    expect(isConfirmationValid('DELETE', p)).toBe(false)
    expect(isConfirmationValid('DELETE 4', p)).toBe(false)
  })
})
