import { mkdtemp, readFile, rm } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import { checkTranslations, flatten, GLOSSARY } from '../scripts/i18n-check.mjs'
import { isArmConfirmationValid, ARM_CONFIRMATION_PHRASE } from '../src/shared/confirm'
import { formatBytesIntl, formatDateTimeIntl, formatRelativeIntl } from '../src/shared/format'
import { INTL_LOCALE, LOCALE_LABELS, SUPPORTED_LOCALES, mapSystemLocale, resolveLocale, type SupportedLocale } from '../src/shared/locale'
import { NAMESPACES, RESOURCES } from '../src/shared/locales'
import { resolveMessage, translateRef, type MessageRef } from '../src/shared/messages'
import { dateBucket } from '../src/shared/sessionQuery'
import { DEFAULT_SETTINGS, mergeSettings, SettingsService } from '../src/main/services/settingsService'
import { resolveInitialMode } from '../src/main/services/safetyMode'
import { CLAUDE_RUNNING_MESSAGE, globalGuard, buildProcessStatus } from '../src/main/services/processService'
import { localText, msg, msgText } from '../src/main/util/messages'

const ROOT = path.resolve(__dirname, '..')

async function makeI18n(lng: SupportedLocale) {
  const inst = i18next.createInstance()
  await inst.init({
    resources: RESOURCES,
    lng,
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: [...NAMESPACES],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    returnEmptyString: false,
    initAsync: false
  })
  return inst
}

describe('UI language detection', () => {
  it('maps OS languages to the supported UI languages', () => {
    expect(mapSystemLocale('vi-VN')).toBe('vi')
    expect(mapSystemLocale('vi')).toBe('vi')
    expect(mapSystemLocale('vi_VN')).toBe('vi')
    expect(mapSystemLocale('zh-CN')).toBe('zh-CN')
    expect(mapSystemLocale('zh-SG')).toBe('zh-CN')
    expect(mapSystemLocale('zh-Hans')).toBe('zh-CN')
    expect(mapSystemLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(mapSystemLocale('en-GB')).toBe('en')
    // Traditional Chinese is not shipped yet: never shown as Simplified.
    expect(mapSystemLocale('zh-TW')).toBeNull()
    expect(mapSystemLocale('zh-Hant-HK')).toBeNull()
    expect(mapSystemLocale('fr-FR')).toBeNull()
  })

  it('uses the first supported OS language and falls back to English', () => {
    expect(resolveLocale(null, ['vi-VN', 'en-US'])).toBe('vi')
    expect(resolveLocale(null, ['fr-FR', 'zh-SG'])).toBe('zh-CN')
    expect(resolveLocale(null, ['zh-TW'])).toBe('en')
    expect(resolveLocale(null, ['de-DE', 'ja-JP'])).toBe('en')
    expect(resolveLocale(undefined, [])).toBe('en')
  })

  it('a saved preference wins over the OS language; invalid values are ignored', () => {
    expect(resolveLocale('zh-CN', ['vi-VN'])).toBe('zh-CN')
    expect(resolveLocale('en', ['vi-VN'])).toBe('en')
    expect(resolveLocale('de', ['vi-VN'])).toBe('vi')
    expect(resolveLocale(42, ['zh-CN'])).toBe('zh-CN')
  })

  it('every supported language has a native label and an Intl locale', () => {
    for (const l of SUPPORTED_LOCALES) {
      expect(LOCALE_LABELS[l].native.length).toBeGreaterThan(0)
      expect(INTL_LOCALE[l]).toBeTruthy()
      expect(RESOURCES[l]).toBeTruthy()
    }
    expect(LOCALE_LABELS.vi.native).toBe('Tiếng Việt')
    expect(LOCALE_LABELS['zh-CN'].native).toBe('简体中文')
  })
})

describe('language and motion preferences are saved', () => {
  it('accepts supported languages and null, rejects anything else', () => {
    expect(DEFAULT_SETTINGS.language).toBeNull()
    expect(mergeSettings(DEFAULT_SETTINGS, { language: 'vi' }).language).toBe('vi')
    expect(mergeSettings(DEFAULT_SETTINGS, { language: 'zh-CN' }).language).toBe('zh-CN')
    expect(mergeSettings({ ...DEFAULT_SETTINGS, language: 'vi' }, { language: null }).language).toBeNull()
    expect(mergeSettings(DEFAULT_SETTINGS, { language: 'de' }).language).toBeNull()
    expect(mergeSettings(DEFAULT_SETTINGS, { language: 7 }).language).toBeNull()
    expect(mergeSettings(DEFAULT_SETTINGS, { motion: 'reduced' }).motion).toBe('reduced')
    expect(mergeSettings(DEFAULT_SETTINGS, { motion: 'fast' }).motion).toBe('system')
  })

  it('persists the language across restarts, but never any deletion safety state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clsm-settings-'))
    try {
      const file = path.join(dir, 'settings.json')
      const a = new SettingsService(file)
      await a.load()
      await a.update({ language: 'zh-CN', motion: 'reduced', dryRun: false, armed: true, safetyMode: 'armed' })
      const saved = JSON.parse(await readFile(file, 'utf8'))
      expect(saved.language).toBe('zh-CN')
      expect(Object.keys(saved).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
      expect(JSON.stringify(saved)).not.toMatch(/dryRun|armed|safety/i)

      const b = new SettingsService(file)
      expect((await b.load()).language).toBe('zh-CN')
      expect(b.get().motion).toBe('reduced')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the UI language never changes how the app starts: always Safe Mode', () => {
    for (const isPackaged of [true, false]) {
      expect(resolveInitialMode({ isPackaged, env: {} })).toMatchObject({ dryRun: true, reason: 'startup' })
    }
    expect(resolveInitialMode({ isPackaged: true, env: { CLAUDE_SESSION_MANAGER_DRY_RUN: 'false', LANG: 'vi_VN' } }).dryRun).toBe(true)
  })
})

describe('translation completeness', () => {
  it('every language has every key, the same placeholders and the needed plural forms', () => {
    const { errors, stats } = checkTranslations()
    expect(errors).toEqual([])
    expect(stats.en).toBeGreaterThan(400)
    expect(stats.vi).toBe(stats.en)
    expect(stats['zh-CN']).toBe(stats.en)
    expect(stats.usedKeys).toBeGreaterThan(300)
  })

  it('the checker reports missing keys, extra keys and placeholder drift', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clsm-i18n-'))
    try {
      for (const [l, data] of [
        ['en', { a: 'Hello {{name}}', b: 'Bye', n_one: '{{count}} item', n_other: '{{count}} items' }],
        ['vi', { a: 'Xin chào {{ten}}', extra: 'x', n_one: '{{count}} mục' }]
      ] as const) {
        fs.mkdirSync(path.join(dir, l))
        fs.writeFileSync(path.join(dir, l, 'common.json'), JSON.stringify(data))
      }
      const { errors } = checkTranslations({ dir, root: ROOT })
      const text = errors.join('\n')
      expect(text).toMatch(/vi\/common:a: placeholders/)
      expect(text).toMatch(/vi\/common:b: missing/)
      expect(text).toMatch(/vi\/common:extra: extra key/)
      expect(text).toMatch(/vi\/common:n: missing plural form _other/)
      expect(text).toMatch(/vi\/common:n: plural form _one is not used by vi/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('every value of the enums the UI translates dynamically has a key in every language', async () => {
    const dynamic: Record<string, readonly string[]> = {
      'sessions:status': ['active', 'archived', 'transcript-only', 'metadata-only', 'orphan'],
      'sessions:live.state': ['running', 'idle', 'in-use'],
      'sessions:live.hint': ['running', 'idle', 'in-use'],
      'sessions:filter': ['all', 'active', 'archived', 'hidden', 'transcript-only', 'problems'],
      'sessions:title': ['all', 'active', 'archived', 'hidden', 'transcript-only', 'problems'],
      'sessions:sort': ['updated-desc', 'updated-asc', 'title', 'size-desc', 'size-asc'],
      'sessions:group': ['date', 'project', 'none'],
      'sessions:dateGroup': ['today', 'yesterday', 'last7', 'last30', 'older', 'unknown'],
      'inspector:titleSource': ['metadata', 'custom-title', 'ai-title', 'summary', 'first-prompt', 'last-prompt', 'untitled'],
      'inspector:projectSource': ['metadata-cwd', 'transcript-cwd', 'owner-session', 'folder-records', 'decoded-folder-name', 'unresolved'],
      'deletion:kind': ['metadata', 'transcript', 'session-data', 'subagent-log', 'file-history', 'session-env', 'tombstone', 'archive-index', 'manager-record'],
      'deletion:itemAction': ['delete-file', 'delete-directory', 'create-file', 'update-file', 'remove-record'],
      'deletion:outcome': ['deleted', 'created', 'updated', 'missing', 'failed', 'skipped', 'dry-run'],
      'deletion:sessionOutcome': ['deleted', 'partial', 'failed', 'skipped', 'dry-run'],
      'updater:status': ['idle', 'checking', 'up-to-date', 'available', 'downloading', 'downloaded', 'error', 'unsupported', 'unsupportedDev', 'noRelease'],
      'updater:mode': ['installed', 'portable', 'development'],
      'settings:motion': ['system', 'reduced'],
      'settings:refresh': ['manual', 'watch', 'interval', 'manualHint', 'watchHint', 'intervalHint'],
      'messages:bulk.verb': ['archived', 'restored', 'hidden', 'shown'],
      'messages:reveal': ['metadata.none', 'transcript.gone', 'sessionData.done']
    }
    for (const l of SUPPORTED_LOCALES) {
      const inst = await makeI18n(l)
      for (const [prefix, values] of Object.entries(dynamic)) {
        for (const v of values) expect(inst.exists(`${prefix}.${v}`, { lng: l, fallbackLng: [] }), `${l} ${prefix}.${v}`).toBe(true)
      }
    }
    expect(dateBucket(Date.now(), new Date())).toBe('today')
  })
})

describe('switching language', () => {
  it('changes the safety wording immediately and keeps the glossary', async () => {
    const inst = await makeI18n('en')
    expect(inst.t('safety:mode.safe')).toBe('Safe Mode')
    await inst.changeLanguage('vi')
    expect(inst.t('safety:mode.safe')).toBe('Chế độ an toàn')
    expect(inst.t('common:action.deletePermanently')).toBe('Xóa vĩnh viễn')
    await inst.changeLanguage('zh-CN')
    expect(inst.t('safety:mode.armed')).toBe('已启用永久删除')
    expect(inst.t('sessions:status.transcript-only')).toBe('仅有会话记录')
    for (const [key, terms] of Object.entries(GLOSSARY)) {
      for (const [l, term] of Object.entries(terms)) {
        await inst.changeLanguage(l)
        expect(inst.t(key)).toBe(term)
      }
    }
  })

  it('uses language-specific plurals and falls back to English for a missing key', async () => {
    const inst = await makeI18n('en')
    expect(inst.t('deletion:count.files', { count: 1 })).toBe('1 file')
    expect(inst.t('deletion:count.files', { count: 3 })).toBe('3 files')
    await inst.changeLanguage('vi')
    expect(inst.t('deletion:count.files', { count: 1 })).toBe('1 tệp')
    await inst.changeLanguage('zh-CN')
    expect(inst.t('deletion:count.files', { count: 3 })).toBe('3 个文件')

    const partial = i18next.createInstance()
    await partial.init({
      resources: { en: { common: { a: 'English A', b: 'English B' } }, vi: { common: { a: 'Tiếng Việt A' } } },
      lng: 'vi',
      fallbackLng: 'en',
      ns: ['common'],
      defaultNS: 'common',
      initAsync: false
    })
    expect(partial.t('a')).toBe('Tiếng Việt A')
    expect(partial.t('b')).toBe('English B')
  })

  it('translates main-process messages, including nested reasons; unknown keys keep the English text', async () => {
    const guard = globalGuard(buildProcessStatus([{ pid: 9, name: 'claude.exe', executablePath: 'C:\\Program Files\\WindowsApps\\Claude_1_x64__x\\app\\claude.exe' }], [], undefined))!
    const notArmed = msg('safety.notArmed', { reason: guard.msg })
    expect(notArmed.message).toBe(`Real deletion was not armed: ${CLAUDE_RUNNING_MESSAGE}`)

    const inst = await makeI18n('vi')
    const tr = (ref: MessageRef | undefined, fallback: string): string =>
      translateRef((k, p) => inst.t(k, p), (k) => inst.exists(k), ref, fallback)
    expect(tr(notArmed.msg, notArmed.message)).toBe('Chưa bật xóa thật: Hãy đóng Claude Desktop trước khi thay đổi tệp phiên.')
    const done = msg('delete.done', { count: 2, size: '1.2 MB' })
    expect(done.message).toBe('Permanently deleted 2 sessions, 1.2 MB freed.')
    expect(tr(done.msg, done.message)).toBe('Đã xóa vĩnh viễn 2 phiên, giải phóng 1.2 MB.')
    await inst.changeLanguage('zh-CN')
    expect(tr(done.msg, done.message)).toBe('已永久删除 2 个会话，释放 1.2 MB。')
    expect(tr({ key: 'no.such.key' }, 'raw OS error')).toBe('raw OS error')
    expect(tr(undefined, 'raw')).toBe('raw')
  })

  it('main-process English text is unchanged and dialog titles follow the UI language', () => {
    expect(CLAUDE_RUNNING_MESSAGE).toBe('Close Claude Desktop before modifying session files.')
    expect(msgText('delete.done', { count: 1, size: '5 KB' })).toBe('Permanently deleted 1 session, 5 KB freed.')
    expect(msgText('safety.typeExactly', { phrase: ARM_CONFIRMATION_PHRASE })).toBe('Type exactly ENABLE DELETE to arm real deletion.')
    expect(() => msgText('typo.key')).toThrow()
    expect(localText('vi', 'export.chooseFolder')).toBe('Chọn thư mục xuất')
    expect(localText('zh-CN', 'export.chooseFolder')).toBe('选择导出文件夹')
  })

  it('resolves interpolation, plurals and nested messages', () => {
    const dict = { a: { n_one: 'one {{x}}', n_other: '{{count}} {{x}}' }, b: 'B {{inner}} {{missing}}', c: 'C{{v}}' }
    expect(resolveMessage(dict, 'a.n', { count: 1, x: 'y' })).toBe('one y')
    expect(resolveMessage(dict, 'a.n', { count: 4, x: 'y' })).toBe('4 y')
    expect(resolveMessage(dict, 'b', { inner: { key: 'c', params: { v: 1 } } })).toBe('B C1 {{missing}}')
    expect(resolveMessage(dict, 'nope')).toBeUndefined()
  })
})

describe('dangerous actions stay explicit in every language', () => {
  it('confirmation phrases are never translated', async () => {
    for (const l of SUPPORTED_LOCALES) {
      const inst = await makeI18n(l)
      expect(inst.t('deletion:confirm.type', { phrase: 'DELETE 1' })).toContain('DELETE 1')
      expect(inst.t('safety:arm.typeToConfirm', { phrase: ARM_CONFIRMATION_PHRASE })).toContain('ENABLE DELETE')
      expect(inst.t('safety:section.guardsNote')).toContain('DELETE')
    }
    // Only the exact English phrase arms deletion, whatever the UI language.
    expect(isArmConfirmationValid('ENABLE DELETE')).toBe(true)
    expect(isArmConfirmationValid('BẬT XÓA THẬT')).toBe(false)
    expect(isArmConfirmationValid('启用永久删除')).toBe(false)
  })

  it('the warnings that matter are present and complete', async () => {
    const keys = [
      'deletion:danger.title',
      'deletion:danger.text',
      'deletion:mode.safeText',
      'deletion:mode.armedText',
      'deletion:group.willDelete',
      'deletion:group.willNotDelete',
      'safety:arm.warningTitle',
      'safety:arm.warningText',
      'safety:strip.armedText',
      'inspector:note.armed'
    ]
    for (const l of SUPPORTED_LOCALES) {
      const inst = await makeI18n(l)
      for (const k of keys) expect(inst.exists(k, { lng: l, fallbackLng: [] }), `${l} ${k}`).toBe(true)
      // The automatic return to Safe Mode is stated with its 10-minute limit.
      expect(inst.t('safety:arm.warningText')).toMatch(/10/)
      expect(inst.t('safety:strip.armedText')).toMatch(/10/)
    }
  })
})

describe('locale-aware formatting', () => {
  it('formats numbers, sizes, dates and relative times per language', () => {
    expect(formatBytesIntl(1536, 'en-US')).toBe('1.5 KB')
    expect(formatBytesIntl(1536, 'vi-VN')).toBe('1,5 KB')
    expect(formatBytesIntl(1536, 'zh-CN')).toBe('1.5 KB')
    expect(formatBytesIntl(undefined, 'vi-VN')).toBe('—')
    const now = Date.UTC(2026, 9, 2, 12, 0, 0)
    expect(formatRelativeIntl(now - 5 * 60_000, 'vi-VN', now)).toBe('5 phút trước')
    expect(formatRelativeIntl(now - 2 * 3_600_000, 'zh-CN', now)).toBe('2小时前')
    expect(formatRelativeIntl(now - 30_000, 'en-US', now)).toBe('now')
    expect(formatDateTimeIntl(now, 'zh-CN', 'date')).toMatch(/2026年10月/)
  })
})

describe('UI source hygiene', () => {
  const files = (function walk(d: string): string[] {
    return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.tsx') ? [path.join(d, e.name)] : []))
  })(path.join(ROOT, 'src', 'renderer', 'src'))

  it('has no hard-coded UI text in JSX or user-facing attributes', () => {
    const allowed = new Set(['Ctrl K', 'null'])
    const found: string[] = []
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/\b(title|placeholder|aria-label|alt)="([^"]*)"/g)) {
          if (/[A-Za-z]/.test(m[2])) found.push(`${path.basename(f)}:${i + 1} ${m[1]}="${m[2]}"`)
        }
        const t = line.trim()
        const prev = (lines[i - 1] ?? '').trim()
        if (/^[A-Za-z][A-Za-z0-9 .,!?'’…-]*$/.test(t) && prev.endsWith('>') && !allowed.has(t)) found.push(`${path.basename(f)}:${i + 1} "${t}"`)
        for (const m of line.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
          if (!allowed.has(m[1].trim()) && !/[=;()]/.test(m[1])) found.push(`${path.basename(f)}:${i + 1} "${m[1].trim()}"`)
        }
      })
    }
    expect(found).toEqual([])
  })

  /** JSX opening tags of an element (handles `=>` and nested braces inside attributes). */
  function openingTags(text: string, tag: string): string[] {
    const out: string[] = []
    let i = text.indexOf(`<${tag}`)
    while (i >= 0) {
      let depth = 0
      let j = i + 1
      for (; j < text.length; j++) {
        const c = text[j]
        if (c === '{') depth++
        else if (c === '}') depth--
        else if (c === '>' && depth === 0) break
      }
      const t = text.slice(i, j + 1)
      if (/^<\w+[\s>]/.test(t) && t.startsWith(`<${tag}`) && /\s|>/.test(t[tag.length + 1])) out.push(t)
      i = text.indexOf(`<${tag}`, j)
    }
    return out
  }

  it('icon-only buttons have an accessible name and dialogs are labelled', () => {
    const problems: string[] = []
    let iconButtons = 0
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      for (const tag of openingTags(text, 'button')) {
        if (!/className="icon-btn"/.test(tag)) continue
        iconButtons++
        if (!/aria-label=/.test(tag)) problems.push(`${path.basename(f)}: icon button without aria-label`)
      }
      for (const tag of openingTags(text, 'input')) {
        if (/type="checkbox"/.test(tag) && !/aria-label=/.test(tag)) problems.push(`${path.basename(f)}: checkbox without aria-label`)
      }
      if (/<img\b(?![^>]*\balt=)/.test(text)) problems.push(`${path.basename(f)}: img without alt`)
    }
    const modal = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/Modal.tsx'), 'utf8')
    expect(modal).toMatch(/role="dialog"/)
    expect(modal).toMatch(/aria-modal="true"/)
    expect(modal).toMatch(/aria-labelledby=\{labelledBy\}/)
    expect(modal).toMatch(/'Escape'/)
    expect(modal).toMatch(/'Tab'/)
    expect(problems).toEqual([])
    expect(iconButtons).toBeGreaterThanOrEqual(8)
  })

  it('bundles no font files; type uses system font stacks only', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/renderer/src/styles/global.css'), 'utf8')
    expect(css).not.toMatch(/@font-face/)
    expect(css).toMatch(/--font-ui: 'SF Pro Text', 'SF Pro Display', -apple-system, BlinkMacSystemFont/)
    expect(css).toMatch(/--font-mono: 'SFMono-Regular', 'SF Mono', 'Cascadia Code'/)
    expect(css).toMatch(/'Microsoft YaHei UI'/)
    expect(css).toMatch(/prefers-reduced-motion: reduce/)
    const fontFiles = (function walk(d: string): string[] {
      return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : /\.(otf|ttf|woff2?)$/i.test(e.name) ? [e.name] : []
      )
    })(path.join(ROOT, 'src'))
    expect(fontFiles).toEqual([])
    expect(flatten({ a: { b: 'c' } })).toEqual({ 'a.b': 'c' })
  })
})
