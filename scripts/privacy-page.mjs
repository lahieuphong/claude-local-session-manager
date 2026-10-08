// Builds the public web pages served by GitHub Pages from the /docs folder:
//
//   docs/privacy/index.html   ← store/privacy.md (the privacy policy; the single source)
//   docs/index.html           ← a short landing page
//   docs/.nojekyll            ← serve the files as they are
//
// Public URL once Pages is enabled (Settings → Pages → Deploy from a branch →
// main, /docs): https://lahieuphong.github.io/claude-local-session-manager/privacy/
// That URL is the Privacy policy URL in Partner Center.
//
//   yarn store:privacy
//
// tests/privacyPage.test.ts fails when the committed pages are out of date.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PRIVACY_SOURCE = path.join('store', 'privacy.md')
export const SITE_DIR = 'docs'
export const SITE_URL = 'https://lahieuphong.github.io/claude-local-session-manager/'
export const PRIVACY_URL = `${SITE_URL}privacy/`
export const SUPPORT_URL = 'https://github.com/lahieuphong/claude-local-session-manager/issues'
export const SOURCE_URL = 'https://github.com/lahieuphong/claude-local-session-manager'
const PRODUCT = 'LHP Local Session Manager'

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline Markdown: `code`, **bold**, *italic* / _italic_, [text](url) and <https://…>. */
function inline(text) {
  const parts = text.split(/(`[^`]+`)/)
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return `<code>${escapeHtml(part.slice(1, -1))}</code>`
      let s = part.replace(/<(https?:\/\/[^>\s]+)>/g, '[$1]($1)')
      s = escapeHtml(s)
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, '$1<em>$2</em>')
      s = s.replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>')
      return s
    })
    .join('')
}

/** The small Markdown subset the policy uses: #/## headings, paragraphs and "- " lists. */
export function markdownToHtml(markdown) {
  const out = []
  let paragraph = []
  let list = null
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (list) out.push(`<ul>\n${list.map((item) => `  <li>${inline(item)}</li>`).join('\n')}\n</ul>`)
    list = null
  }
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const heading = /^(#{1,3}) (.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
    } else if (line.startsWith('- ')) {
      flushParagraph()
      list = [...(list ?? []), line.slice(2)]
    } else if (/^\s+\S/.test(line) && list) {
      list[list.length - 1] += ' ' + line.trim()
    } else if (line.trim() === '') {
      flushParagraph()
      flushList()
    } else {
      flushList()
      paragraph.push(line.trim())
    }
  }
  flushParagraph()
  flushList()
  return out.join('\n')
}

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1b1b1b; --muted: #5c5c5c; --line: #e3e3e3; --code: #f3f1ef; --link: #9a4a2b; }
@media (prefers-color-scheme: dark) { :root { --bg: #141312; --fg: #ecebe9; --muted: #a8a5a1; --line: #2d2b29; --code: #23211f; --link: #e39270; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 0.5rem; }
h2 { font-size: 1.2rem; margin: 2.2rem 0 0.5rem; padding-top: 1.2rem; border-top: 1px solid var(--line); }
p, ul { margin: 0.7rem 0; }
ul { padding-left: 1.3rem; }
li { margin: 0.35rem 0; }
code { background: var(--code); border-radius: 4px; padding: 0.1em 0.35em; font: 0.9em Consolas, "Cascadia Mono", monospace; overflow-wrap: anywhere; }
a { color: var(--link); overflow-wrap: anywhere; }
em { color: var(--muted); }
footer { margin-top: 3rem; padding-top: 1.2rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.9rem; }
footer a { margin-right: 1rem; }
`

function page({ title, description, canonical, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<footer>
<p>${PRODUCT} is an unofficial, independent utility. It is not affiliated with, endorsed by or sponsored by Anthropic.</p>
<p><a href="${SITE_URL}">Home</a><a href="${PRIVACY_URL}">Privacy policy</a><a href="${SUPPORT_URL}">Support</a><a href="${SOURCE_URL}">Source code</a></p>
</footer>
</main>
</body>
</html>
`
}

export function renderPrivacyPage(markdown) {
  return page({
    title: `Privacy policy — ${PRODUCT}`,
    description: `Privacy policy of ${PRODUCT}: what local session data the app reads, what it stores, and that it sends nothing.`,
    canonical: PRIVACY_URL,
    body: markdownToHtml(markdown)
  })
}

export function renderHomePage() {
  return page({
    title: PRODUCT,
    description: `${PRODUCT}: an unofficial Windows utility to browse, search, export and clean up local AI coding session history.`,
    canonical: SITE_URL,
    body: [
      `<h1>${PRODUCT}</h1>`,
      '<p>An <strong>unofficial, independent</strong> Windows utility to browse, search, export and clean up the session history that Claude Code and Claude Desktop keep on your own computer. Everything is processed locally: no account, no server, no telemetry.</p>',
      '<ul>',
      `  <li><a href="${PRIVACY_URL}">Privacy policy</a></li>`,
      `  <li><a href="${SUPPORT_URL}">Support and contact</a></li>`,
      `  <li><a href="${SOURCE_URL}">Source code</a></li>`,
      '</ul>'
    ].join('\n')
  })
}

/** Every generated file, relative to the repository root. */
export function sitePages({ root = ROOT } = {}) {
  return {
    [path.join(SITE_DIR, 'privacy', 'index.html')]: renderPrivacyPage(readFileSync(path.join(root, PRIVACY_SOURCE), 'utf8')),
    [path.join(SITE_DIR, 'index.html')]: renderHomePage(),
    [path.join(SITE_DIR, '.nojekyll')]: ''
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [rel, content] of Object.entries(sitePages())) {
    const file = path.join(ROOT, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
    console.log(`Wrote ${rel.split(path.sep).join('/')}`)
  }
  console.log(`\nPublic URL after GitHub Pages is enabled for main /docs: ${PRIVACY_URL}`)
}
