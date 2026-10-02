#!/usr/bin/env node
/**
 * Translation completeness check (also used by tests/i18n.test.ts).
 *
 *   yarn i18n:check
 *
 * Verifies, for every UI language against English (the source):
 *  - the same keys exist in every namespace (no missing, no extra keys)
 *  - plural keys have every form the language needs (Intl.PluralRules)
 *  - {{placeholders}} are identical, values are non-empty strings
 *  - the safety glossary terms are used exactly
 *  - every literal translation key used in the source exists in English
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LOCALES_DIR = path.join(ROOT, 'src', 'shared', 'locales')
export const SOURCE = 'en'
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other']

/** Exact terms for the safety-critical vocabulary (must not drift). */
export const GLOSSARY = {
  'safety:mode.safe': { en: 'Safe Mode', vi: 'Chế độ an toàn', 'zh-CN': '安全模式' },
  'safety:mode.armed': { en: 'Real Delete Armed', vi: 'Đã bật xóa thật', 'zh-CN': '已启用永久删除' },
  'common:action.deletePermanently': { en: 'Delete permanently', vi: 'Xóa vĩnh viễn', 'zh-CN': '永久删除' },
  'common:action.hideInManager': { en: 'Hide in manager', vi: 'Ẩn trong trình quản lý', 'zh-CN': '在管理器中隐藏' },
  'sessions:status.transcript-only': { en: 'Transcript only', vi: 'Chỉ có bản ghi hội thoại', 'zh-CN': '仅有会话记录' }
}

export function loadLocales(dir = LOCALES_DIR) {
  const out = {}
  for (const locale of fs.readdirSync(dir)) {
    const ldir = path.join(dir, locale)
    if (!fs.statSync(ldir).isDirectory()) continue
    out[locale] = {}
    for (const file of fs.readdirSync(ldir).filter((f) => f.endsWith('.json'))) {
      out[locale][file.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(ldir, file), 'utf8'))
    }
  }
  return out
}

/** { 'a.b': 'text', … } */
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out[key] = v
  }
  return out
}

function splitPlural(key) {
  const m = /^(.*)_(zero|one|two|few|many|other)$/.exec(key)
  return m ? { base: m[1], form: m[2] } : { base: key, form: null }
}

/** base key → { forms: Set, values: { form|'' : text } } */
function group(flat) {
  const g = new Map()
  for (const [key, value] of Object.entries(flat)) {
    const { base, form } = splitPlural(key)
    if (!g.has(base)) g.set(base, { forms: new Set(), values: {} })
    const e = g.get(base)
    if (form) e.forms.add(form)
    e.values[form ?? ''] = value
  }
  return g
}

export const placeholders = (s) => [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort()

function sourceFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

/** Translation keys referenced in the source: literal keys and `${…}` prefixes. */
export function usedKeys(root = ROOT) {
  const literal = new Set()
  const prefixes = new Set()
  const renderer = sourceFiles(path.join(root, 'src', 'renderer', 'src'))
  for (const file of renderer) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/['"`]((?:common|sessions|inspector|deletion|safety|settings|storage|updater|messages):[A-Za-z0-9_.-]+)(\$\{)?/g)) {
      if (m[2]) prefixes.add(m[1])
      else if (!m[0].startsWith('`') || !m[1].endsWith('.')) literal.add(m[1])
    }
  }
  const main = sourceFiles(path.join(root, 'src', 'main'))
  for (const file of main) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/\b(?:msg|msgText|ref|problem|trackedText|localText)\(\s*(?:[a-zA-Z.()]+,\s*)?(['`])([A-Za-z0-9_.-]+)(\$\{)?/g)) {
      const key = `messages:${m[2]}`
      if (m[3]) prefixes.add(key)
      else literal.add(key)
    }
  }
  return { literal: [...literal].sort(), prefixes: [...prefixes].sort() }
}

export function checkTranslations({ dir = LOCALES_DIR, root = ROOT } = {}) {
  const errors = []
  const locales = loadLocales(dir)
  const source = locales[SOURCE]
  if (!source) return { errors: [`missing source locale ${SOURCE}`], stats: {} }
  const stats = {}

  for (const [locale, namespaces] of Object.entries(locales)) {
    const rules = new Intl.PluralRules(locale === 'zh-CN' ? 'zh-CN' : locale).resolvedOptions().pluralCategories
    let keys = 0
    for (const ns of new Set([...Object.keys(source), ...Object.keys(namespaces)])) {
      if (!source[ns]) {
        errors.push(`${locale}/${ns}.json: namespace not in ${SOURCE}`)
        continue
      }
      if (!namespaces[ns]) {
        errors.push(`${locale}/${ns}.json: missing namespace`)
        continue
      }
      const src = group(flatten(source[ns]))
      const tr = group(flatten(namespaces[ns]))
      for (const [base, s] of src) {
        const id = `${locale}/${ns}:${base}`
        const t = tr.get(base)
        if (!t) {
          errors.push(`${id}: missing`)
          continue
        }
        keys++
        const plural = s.forms.size > 0
        if (plural) {
          for (const form of rules) if (!t.forms.has(form)) errors.push(`${id}: missing plural form _${form}`)
          for (const form of t.forms) if (!rules.includes(form)) errors.push(`${id}: plural form _${form} is not used by ${locale}`)
          if (t.values[''] !== undefined) errors.push(`${id}: has both plural and non-plural values`)
        } else if (t.forms.size > 0) {
          errors.push(`${id}: plural forms in translation but not in ${SOURCE}`)
        }
        const want = placeholders(plural ? s.values.other : s.values[''])
        for (const [form, value] of Object.entries(t.values)) {
          if (typeof value !== 'string' || value.trim() === '') {
            errors.push(`${id}${form ? '_' + form : ''}: empty or not a string`)
            continue
          }
          const got = placeholders(value)
          // A singular form may drop {{count}} ("one session" → "a session").
          const expected = form === 'one' ? want.filter((p) => got.includes(p) || p !== 'count') : want
          if (JSON.stringify(got) !== JSON.stringify(expected)) errors.push(`${id}${form ? '_' + form : ''}: placeholders ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`)
        }
      }
      for (const base of tr.keys()) if (!src.has(base)) errors.push(`${locale}/${ns}:${base}: extra key (not in ${SOURCE})`)
    }
    stats[locale] = keys
  }

  // Glossary
  for (const [key, terms] of Object.entries(GLOSSARY)) {
    const [ns, k] = key.split(':')
    for (const [locale, term] of Object.entries(terms)) {
      const value = locales[locale] ? flatten(locales[locale][ns] ?? {})[k] : undefined
      if (value !== term) errors.push(`glossary ${locale} ${key}: "${value}" ≠ "${term}"`)
    }
  }

  // Keys used in source code must exist in the source language.
  const used = usedKeys(root)
  const srcFlat = Object.fromEntries(Object.entries(source).map(([ns, tree]) => [ns, flatten(tree)]))
  const exists = (full) => {
    const [ns, k] = full.split(':')
    const flat = srcFlat[ns] ?? {}
    return k in flat || `${k}_other` in flat || Object.keys(flat).some((x) => x.startsWith(k + '.'))
  }
  for (const key of used.literal) if (!exists(key)) errors.push(`source uses missing key ${key}`)
  for (const prefix of used.prefixes) {
    const [ns, k] = prefix.split(':')
    if (!Object.keys(srcFlat[ns] ?? {}).some((x) => x.startsWith(k))) errors.push(`source uses missing key prefix ${prefix}`)
  }
  stats.usedKeys = used.literal.length
  stats.usedPrefixes = used.prefixes.length
  return { errors, stats }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { errors, stats } = checkTranslations()
  const langs = Object.entries(stats)
    .filter(([k]) => k !== 'usedKeys' && k !== 'usedPrefixes')
    .map(([l, n]) => `${l}: ${n} keys`)
  console.log(`Translations — ${langs.join(', ')} · source references: ${stats.usedKeys} keys, ${stats.usedPrefixes} dynamic prefixes`)
  if (errors.length) {
    console.error(`\n${errors.length} problem(s):\n  ` + errors.join('\n  '))
    process.exit(1)
  }
  console.log('OK: every language is complete and consistent.')
}
