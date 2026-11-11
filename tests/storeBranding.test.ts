import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRIVACY_URL, SITE_URL, SUPPORT_URL, markdownToHtml, sitePages } from '../scripts/privacy-page.mjs'
import { THIRD_PARTY_NAME_RE, storeAppName, validateStoreName, type StoreIdentity } from '../scripts/store-config.mjs'
import { APP_NAME, STORE_APP_NAME, appBrand, sidebarName } from '../src/shared/appIdentity'
import { SUPPORTED_LOCALES } from '../src/shared/locale'
import { RESOURCES } from '../src/shared/locales'
import { formatPlanReport, formatResultReport } from '../src/main/services/deleteReport'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8')
const LISTINGS = ['en-US', 'vi-VN', 'zh-CN'] as const

/** The `## ` sections of a listing draft, in order (the headings are translated, the order is fixed). */
function sections(locale: (typeof LISTINGS)[number]): string[] {
  return read(`store/listing/${locale}.md`)
    .split(/^## .*$/m)
    .slice(1)
    .map((s) => s.trim())
}
const [NAME, SHORT, DESCRIPTION, FEATURES, SEARCH, , , COPYRIGHT, LINKS] = [0, 1, 2, 3, 4, 5, 6, 7, 8]
const bullets = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())

describe('Store-facing product name', () => {
  it('only the Microsoft Store edition is called LHP Local Session Manager', () => {
    expect(STORE_APP_NAME).toBe('LHP Local Session Manager')
    expect(appBrand('store')).toEqual({ name: 'LHP Local Session Manager', short: 'LHP Local', sub: 'Session Manager' })
    expect(appBrand('github')).toEqual({ name: APP_NAME, short: 'Claude Local', sub: 'Session Manager' })
    expect(appBrand('development').name).toBe(APP_NAME)
    expect(THIRD_PARTY_NAME_RE.test(STORE_APP_NAME)).toBe(false)
  })

  it('the sidebar names the tool on screen where the name says Claude: Codex Local while Codex is', () => {
    expect(sidebarName(appBrand('github'), 'claude')).toBe('Claude Local')
    expect(sidebarName(appBrand('github'), 'codex')).toBe('Codex Local')
    // The Store edition's name has no third-party name to swap.
    expect(sidebarName(appBrand('store'), 'codex')).toBe('LHP Local')
  })

  it('the package display name is the name the app shows; the immutable identity is unchanged', () => {
    const identity = JSON.parse(read('store/identity.json')) as StoreIdentity
    expect(identity.displayName).toBe(STORE_APP_NAME)
    expect(storeAppName()).toBe(STORE_APP_NAME)
    expect(validateStoreName(identity)).toEqual([])
    expect(identity.identityName).toBe('LaHieuPhong.ClaudeLocalSessionManager')
    expect(identity.publisher).toBe('CN=CA5468D0-A735-4CDB-9F0A-A0CDD47D1EA5')
    expect(identity.storeProductId).toBe('9N5XNN8H1TSZ')
    expect(validateStoreName({ ...identity, displayName: 'Another Reserved Name' }).join()).toMatch(/not the name the Store edition shows/)
    expect(validateStoreName({ ...identity, displayName: 'Claude Local Session Manager' }).join()).toMatch(/name of another product/)
  })

  it('every customer-visible surface takes the name from the build, not from a fixed string', () => {
    const main = read('src/main/index.ts')
    expect(main).toMatch(/const brand = appBrand\(storeEdition \? 'store' : distribution\.channel\)/)
    expect(main).toMatch(/app\.setName\(brand\.name\)/)
    expect(main).toMatch(/title: brand\.name,/)
    expect(main).toMatch(/win\.on\('page-title-updated', \(event\) => event\.preventDefault\(\)\)/)
    expect(main).toMatch(/dialog\.showErrorBox\(brand\.name,/)
    expect(main).toMatch(/name: brand\.name,/)
    // The only remaining use of the GitHub name in main is the GitHub uninstaller lookup.
    expect(main.match(/\bAPP_NAME\b/g)).toHaveLength(3) // import, a comment, detectUpdateMode
    expect(main).toMatch(/detectUpdateMode\(\{[^}]*productName: APP_NAME/)

    expect(read('src/renderer/index.html')).toMatch(/<title>Local Session Manager<\/title>/)
    const sidebar = read('src/renderer/src/components/Sidebar.tsx')
    expect(sidebar).toMatch(/const brand = appInfo \? appBrand\(appInfo\.distribution\) : null/)
    expect(sidebar).toMatch(/\{brand && sidebarName\(brand, provider\)\}/)
    expect(read('src/renderer/src/components/Updates.tsx')).toMatch(/<span className="about-name">\{appInfo\?\.name\}<\/span>/)
    // No translation carries a product name any more.
    for (const l of SUPPORTED_LOCALES) {
      expect(JSON.stringify(RESOURCES[l]), l).not.toMatch(/Claude Local|LHP Local/)
      expect((RESOURCES[l].common as { app: Record<string, string> }).app).not.toHaveProperty('name')
      expect((RESOURCES[l].updater as { confirm: { text: string } }).confirm.text).toMatch(/\{\{appName\}\}/)
    }
  })

  it('reports carry the name of the build that wrote them', () => {
    const plan = { planId: 'p', contentHash: 'h', createdAt: 0, expiresAt: 0, dryRun: true, bulk: false, sessions: [], blocked: [], totalBytes: 0, totalItems: 0, totalFiles: 0, totalDirs: 0, confirmationPhrases: ['DELETE'] }
    expect(formatPlanReport(plan, STORE_APP_NAME).split('\n')[0]).toBe('LHP LOCAL SESSION MANAGER - DELETE PLAN')
    expect(formatPlanReport(plan).split('\n')[0]).toBe('CLAUDE LOCAL SESSION MANAGER - DELETE PLAN')
    const result = { ok: true, partial: false, dryRun: true, message: 'm', sessions: [] }
    expect(formatResultReport(result, [], STORE_APP_NAME).split('\n')[0]).toBe('LHP LOCAL SESSION MANAGER - DELETE DRY RUN RESULT')
  })
})

describe('Store listing drafts', () => {
  const SEARCH_TERMS: Record<(typeof LISTINGS)[number], string[]> = {
    'en-US': ['session manager', 'local sessions', 'developer tools', 'transcript viewer', 'session cleanup', 'storage manager', 'desktop utility'],
    'vi-VN': ['quản lý phiên', 'phiên cục bộ', 'công cụ lập trình', 'xem transcript', 'dọn dẹp phiên', 'quản lý lưu trữ', 'tiện ích desktop'],
    'zh-CN': ['会话管理', '本地会话', '开发者工具', '记录查看', '会话清理', '存储管理', '桌面工具']
  }
  const ARCHIVE_WORDS: Record<(typeof LISTINGS)[number], RegExp> = { 'en-US': /archiv|restor/i, 'vi-VN': /lưu trữ \/|khôi phục/i, 'zh-CN': /归档|恢复/ }

  it('use the new product name and never the rejected one', () => {
    for (const locale of LISTINGS) {
      const s = sections(locale)
      expect(s[NAME], locale).toMatch(/^LHP Local Session Manager/)
      expect(read(`store/listing/${locale}.md`), locale).not.toMatch(/Claude Local/)
      expect(s[DESCRIPTION], locale).toMatch(/^LHP Local Session Manager/)
    }
  })

  it('search terms are generic: exactly the agreed list, no third-party product names', () => {
    for (const locale of LISTINGS) {
      const terms = bullets(sections(locale)[SEARCH])
      expect(terms, locale).toEqual(SEARCH_TERMS[locale])
      expect(terms.length).toBeLessThanOrEqual(7)
      for (const term of terms) {
        expect(term, locale).not.toMatch(/claude|anthropic|code|desktop app/i)
        expect(term.length).toBeLessThanOrEqual(30)
      }
    }
    // "desktop utility" / "tiện ích desktop" are generic; the product "Claude Desktop" is never a term.
    expect(Object.values(SEARCH_TERMS).flat().join(' ')).not.toMatch(/claude|anthropic/i)
  })

  it('advertise only what the Store edition can do', () => {
    for (const locale of LISTINGS) {
      const s = sections(locale)
      const features = bullets(s[FEATURES])
      expect(features.length, locale).toBeGreaterThanOrEqual(8)
      expect(features.length).toBeLessThanOrEqual(20)
      for (const f of features) {
        expect(f.length, f).toBeLessThanOrEqual(200)
        expect(f, locale).not.toMatch(ARCHIVE_WORDS[locale]) // Archive / Restore are not offered
        expect(f, locale).not.toMatch(/claude|anthropic/i)
      }
      expect(s[SHORT], locale).not.toMatch(ARCHIVE_WORDS[locale])
      expect(s[SHORT].replace(/\s+/g, ' ').length, locale).toBeLessThanOrEqual(270)
      // The description states the limitation of this edition and keeps the disclaimer.
      expect(s[DESCRIPTION], locale).toMatch(/Microsoft Store/)
      expect(s[DESCRIPTION], locale).toMatch(/AppData/)
      expect(s[DESCRIPTION], locale).toMatch(/Anthropic/)
      expect(s[COPYRIGHT], locale).toMatch(/Anthropic/)
      expect(s[DESCRIPTION], locale).not.toMatch(/https?:\/\//) // Partner Center: no URLs in the description
    }
    const en = sections('en-US')
    expect(bullets(en[FEATURES])).toEqual(
      expect.arrayContaining([
        'Browse and inspect local sessions',
        'Search and organize local session history',
        'Hide sessions in the manager',
        'Safely remove supported local transcript-only sessions',
        'Protected delete plans and workspace validation'
      ])
    )
    expect(en[DESCRIPTION]).toMatch(/Unofficial local utility\. Not affiliated with, endorsed by or sponsored by\s+Anthropic\./)
    expect(en[DESCRIPTION]).toMatch(/can be viewed and exported, but not\s+archived, restored or deleted/)
  })

  it('point to the public privacy page', () => {
    for (const locale of LISTINGS) expect(sections(locale)[LINKS], locale).toContain(PRIVACY_URL)
  })

  it('the certification notes justify runFullTrust only and describe the Store-edition limits', () => {
    const notes = read('store/certification-notes.md')
    expect(notes).toMatch(/\*\*LHP Local Session Manager\*\*/)
    expect(notes).not.toMatch(/Claude Local/)
    expect(notes.match(/^### `(\w+)`$/gm)).toEqual(['### `runFullTrust`'])
    // Quoted blocks wrap; compare the text as one line.
    const flat = notes.replace(/\n>[ ]?/g, ' ').replace(/\s+/g, ' ')
    // The exact wording agreed for certification, in the pasted note and in the limitations section.
    const agreed =
      "The Store edition does not create, replace, rename, or delete files inside Claude Desktop's AppData storage. Unsupported Claude Desktop metadata mutations are blocked before any filesystem change occurs."
    expect(flat.split(agreed).length - 1).toBe(2)
    expect(flat).toContain("The Store edition may still write its own application data, such as settings and manager state, inside the app's own user-data location.")
    expect(flat).toContain('Sessions that only have a transcript under %USERPROFILE%\\.claude (outside AppData) can be hidden in the app or permanently deleted')
  })

  it('the documentation is precise about AppData: only Claude Desktop’s files are off limits, the app still writes its own data', () => {
    const flatten = (p: string): string => read(p).replace(/[`*]/g, '').replace(/\s+/g, ' ')
    const precise = "The Microsoft Store edition does not modify Claude Desktop's AppData files"
    const ownData = "It may still write its own application data, such as settings and manager state, inside the app's own user-data location."
    for (const f of ['README.md', 'docs/MICROSOFT_STORE.md', 'store/privacy.md']) {
      expect(flatten(f), f).toContain(precise)
      expect(flatten(f), f).toContain(ownData)
    }
    expect(read('docs/privacy/index.html').replace(/\s+/g, ' ')).toContain(precise)
    // Never the blanket claim: the app does write its own settings, cache and logs under its user-data folder.
    const blanket = /does not modify any files in AppData|changes nothing under AppData|nothing under AppData|never changes files under AppData|does not write to AppData\b/i
    const files = ['README.md', 'docs/MICROSOFT_STORE.md', 'store/README.md', 'store/privacy.md', 'store/certification-notes.md', 'store/listing-assets/README.md', 'src/main/index.ts', 'src/main/services/packagingPolicy.ts']
    for (const f of [...files, ...LISTINGS.map((l) => `store/listing/${l}.md`)]) expect(flatten(f), f).not.toMatch(blanket)
  })

  it('no Partner Center material in store/ uses the rejected name', () => {
    const files = ['store/README.md', 'store/certification-notes.md', 'store/privacy.md', 'store/identity.json', 'store/listing-assets/README.md', 'store/listing-assets/captions.md']
    for (const f of files) expect(read(f), f).not.toMatch(/Claude Local Session Manager/)
  })
})

describe('public privacy policy page', () => {
  const html = read('docs/privacy/index.html')

  it('is generated from store/privacy.md and committed up to date (run `yarn store:privacy`)', () => {
    for (const [rel, content] of Object.entries(sitePages())) expect(read(rel), rel).toBe(content)
    expect(fs.existsSync(path.join(ROOT, 'docs', '.nojekyll'))).toBe(true)
    expect(PRIVACY_URL).toBe('https://lahieuphong.github.io/claude-local-session-manager/privacy/')
    expect(SITE_URL).toBe('https://lahieuphong.github.io/claude-local-session-manager/')
  })

  it('is a plain, self-contained HTML page (works over HTTPS without sign-in or scripts)', () => {
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/)
    expect(html).toMatch(/<meta name="viewport"/)
    expect(html).toMatch(/<title>Privacy policy — LHP Local Session Manager<\/title>/)
    expect(html).not.toMatch(/<script|<img|<iframe|<link rel="stylesheet"|@import|url\(/i)
    // Every link is absolute https; nothing points at a file that needs GitHub authentication.
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    expect(links.length).toBeGreaterThan(4)
    for (const link of links) expect(link).toMatch(/^https:\/\//)
    expect(html).not.toMatch(/github\.com\/[^"]*\/blob\//)
  })

  it('names the product, says it is unofficial and covers every required topic', () => {
    expect(html).toMatch(/<h1>Privacy policy — LHP Local Session Manager<\/h1>/)
    expect(html).not.toMatch(/Claude Local Session Manager/)
    expect(html).toMatch(/<strong>unofficial, independent<\/strong>/)
    expect(html).toMatch(/not made by, affiliated with, endorsed by or sponsored by Anthropic/)
    for (const heading of [
      'What the app accesses on your computer',
      'Why the app accesses it',
      'What the app stores',
      'What the app transmits',
      'Security and local processing',
      'Your controls',
      'Export and deletion',
      'Contact and support'
    ]) {
      expect(html, heading).toContain(`<h2>${heading}</h2>`)
    }
    expect(html).toContain(`<a href="${SUPPORT_URL}">${SUPPORT_URL}</a>`)
    expect(html).toMatch(/<strong>Nothing\.<\/strong> The Microsoft Store edition has no update checker and sends no data/)
  })

  it('describes the Store edition as it really behaves', () => {
    const policy = read('store/privacy.md').replace(/\s+/g, ' ')
    expect(policy).toContain('sessions that have Claude Desktop metadata can be viewed and exported, but not archived, restored or deleted')
    expect(policy).toContain('The Microsoft Store edition does not export into `AppData`')
    expect(policy).toContain('`%APPDATA%\\LHP Local Session Manager`')
    expect(policy).toContain('GitHub Setup and Portable builds only')
    // The policy never claims Archive / Restore for the Store edition.
    expect(policy).not.toMatch(/Archive \/ Restore\*\* changes/)
  })

  it('the Markdown converter handles the constructs the policy uses and escapes HTML', () => {
    expect(markdownToHtml('# T\n\n_x_ and **b** `<c>`\n\n- one\n  more\n- two <https://e.example/a>')).toBe(
      ['<h1>T</h1>', '<p><em>x</em> and <strong>b</strong> <code>&lt;c&gt;</code></p>', '<ul>', '  <li>one more</li>', '  <li>two <a href="https://e.example/a">https://e.example/a</a></li>', '</ul>'].join('\n')
    )
    expect(markdownToHtml('a <b> & "c"')).toBe('<p>a &lt;b&gt; &amp; &quot;c&quot;</p>')
  })
})
