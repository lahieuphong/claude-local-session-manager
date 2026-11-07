// The layout and accessibility audit of the full UI test (scripts/ui-test.mjs).
//
// `auditPage` is serialized and runs inside the app's page, so it must not use
// anything from this module's scope. It looks at what is really on screen for the
// current window size and language and reports what a person would call broken:
//
//   squashed       a box smaller than its content (fixed-height items shrunk by flexbox)
//   too-small      a control too small to read or click
//   text-overlap   two pieces of text drawn on top of each other
//   covered        a control another element sits on top of (it cannot be clicked)
//   clipped        a control cut off by a container or the window, with no way to scroll to it
//   clipped-text   text cut off without an ellipsis
//   spill          text or a control sticking out of its container
//   h-scroll       an unintended horizontal scrollbar
//   page-overflow  the whole window scrolls (the app is laid out to fit it)
//   cramped        a scrolling area too short to use
//   modal          a dialog (or its buttons) outside the window
//   raw-text       untranslated keys, {{placeholders}}, undefined, NaN, raw system errors...
//   no-name        a control a screen reader cannot name
//   dup-id, aria-ref  broken IDs and ARIA references
//   broken-image   an image that did not load
//   contrast       text too faint for its background (WCAG 3:1 is an error, 4.5:1 a warning)
//   no-tooltip     text cut with an ellipsis and no way to read all of it (warning)

/* eslint-disable */
export function auditPage() {
  const problems = []
  const vw = window.innerWidth
  const vh = window.innerHeight
  const NS = 'common|deletion|inspector|messages|safety|sessions|settings|storage|updater'
  const styles = new Map()
  const style = (el) => {
    let s = styles.get(el)
    if (!s) styles.set(el, (s = getComputedStyle(el)))
    return s
  }
  const STATE_CLASSES = /^(active|on|open|selected|checked|disabled|armed|safe|ok|bad|closing|leaving|spin|invalid|untitled|missing)$/
  const describeOne = (el) => {
    const classes = [...el.classList].filter((c) => !STATE_CLASSES.test(c) && !/^status-|^toast-|^tone-/.test(c)).slice(0, 2)
    return el.tagName.toLowerCase() + (classes.length ? `.${classes.join('.')}` : '')
  }
  /** A stable name for an element: no data, so one defect in many rows counts once. */
  const describe = (el) => {
    const parts = []
    for (let e = el, i = 0; e && e !== document.body && i < 3; e = e.parentElement, i++) parts.unshift(describeOne(e))
    return parts.join(' > ')
  }
  const snippet = (el) => (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50)
  const add = (rule, el, detail, severity = 'error') => problems.push({ rule, severity, where: describe(el), detail })

  const intersect = (a, b) => {
    const left = Math.max(a.left, b.left)
    const top = Math.max(a.top, b.top)
    const right = Math.min(a.right, b.right)
    const bottom = Math.min(a.bottom, b.bottom)
    return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null
  }
  const viewport = { left: 0, top: 0, right: vw, bottom: vh }
  const clips = (s) => s.overflowX !== 'visible' || s.overflowY !== 'visible'
  const scrolls = (s) => /auto|scroll/.test(s.overflowX) || /auto|scroll/.test(s.overflowY)
  /** The part of a rectangle not cut away by the containers around `el`, or null. */
  const visiblePart = (el, rect) => {
    let r = intersect(rect, viewport)
    for (let p = el; p && r; p = p.parentElement) {
      if (clips(style(p))) r = intersect(r, p.getBoundingClientRect())
    }
    return r
  }
  const hasScrollerAround = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (scrolls(style(p))) return true
    return false
  }
  const insideHidden = (el) => !!el.closest('.visually-hidden')
  const rendered = (el) => el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) && !insideHidden(el)

  // A dialog makes the app behind it inert: only the topmost dialog can be used.
  const backdrops = [...document.querySelectorAll('.modal-backdrop')]
  const scope = backdrops.length ? backdrops[backdrops.length - 1] : document.body
  const all = [...scope.querySelectorAll('*')].filter((el) => !el.closest('svg') && !/^(SCRIPT|STYLE|OPTION|NOSCRIPT)$/.test(el.tagName))
  const live = all.filter(rendered)
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=menuitem], [role=radio], [role=switch], [role=tab]'
  const controls = live.filter((el) => el.matches(INTERACTIVE))
  /** Overlays float above the page on purpose; they are compared only with themselves. */
  const layerOf = (el) => el.closest('.toasts, .menu') ?? el.closest('.group-label, .list-columns') ?? scope

  const canvas = document.createElement('canvas').getContext('2d')

  // The window itself must not scroll.
  const doc = document.documentElement
  if (doc.scrollWidth > vw + 1) problems.push({ rule: 'page-overflow', severity: 'error', where: 'window', detail: `page is ${doc.scrollWidth}px wide in a ${vw}px window` })
  if (doc.scrollHeight > vh + 1) problems.push({ rule: 'page-overflow', severity: 'error', where: 'window', detail: `page is ${doc.scrollHeight}px tall in a ${vh}px window` })

  // Boxes, scrollers and text clipping.
  for (const el of live) {
    const s = style(el)
    const r = el.getBoundingClientRect()
    if (r.width < 1 && r.height < 1) continue
    const clampLines = s.webkitLineClamp && s.webkitLineClamp !== 'none'
    if (/hidden|clip/.test(s.overflowY) && !clampLines && s.display !== 'inline' && el.scrollHeight - el.clientHeight > 2 && (el.textContent ?? '').trim()) {
      add('squashed', el, `shows ${el.clientHeight}px of ${el.scrollHeight}px: "${snippet(el)}"`)
    }
    const directText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    if (directText && r.height > 0 && r.height < parseFloat(s.fontSize) * 0.9 && s.display !== 'inline') {
      add('squashed', el, `${Math.round(r.height)}px tall for ${s.fontSize} text: "${snippet(el)}"`)
    }
    if (/hidden|clip/.test(s.overflowX) && directText && el.scrollWidth - el.clientWidth > 1) {
      if (s.textOverflow !== 'ellipsis') add('clipped-text', el, `shows ${el.clientWidth}px of ${el.scrollWidth}px: "${snippet(el)}"`)
      else if (!el.closest('[title]')) add('no-tooltip', el, `"${snippet(el)}"`, 'warn')
    }
    if (/auto|scroll/.test(s.overflowX) && el.scrollWidth - el.clientWidth > 1 && !el.closest('pre')) {
      add('h-scroll', el, `content is ${el.scrollWidth}px wide in ${el.clientWidth}px`)
    }
    if (/auto|scroll/.test(s.overflowY) && el.scrollHeight - el.clientHeight > 1 && el.clientHeight < 80 && !el.closest('pre')) {
      add('cramped', el, `only ${el.clientHeight}px tall for ${el.scrollHeight}px of content`)
    }
    if (el.tagName === 'IMG' && el.complete && el.naturalWidth === 0) add('broken-image', el, el.getAttribute('src') ?? '')
    if (el.tagName === 'INPUT' && el.placeholder && !el.value && !el.title) {
      canvas.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
      const room = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
      if (canvas.measureText(el.placeholder).width > room + 1) add('no-tooltip', el, `placeholder is cut off: "${el.placeholder.slice(0, 50)}"`, 'warn')
    }
  }

  // Controls: size, reachability, what sits on top of them.
  for (const el of controls) {
    const r = el.getBoundingClientRect()
    const s = style(el)
    if (parseFloat(s.opacity) === 0 || (el.tagName === 'INPUT' && /radio|checkbox/.test(el.type) && el.closest('.switch, .segment, .radio'))) continue
    if (r.height < 14 || r.width < 14) add('too-small', el, `${Math.round(r.width)}×${Math.round(r.height)}px: "${snippet(el)}"`)
    const seen = visiblePart(el, r)
    if (!seen) {
      if (!hasScrollerAround(el)) add('clipped', el, `outside the window with no way to scroll to it: "${snippet(el)}"`)
      continue
    }
    if (!hasScrollerAround(el) && (seen.width < r.width - 1 || seen.height < r.height - 1)) add('clipped', el, `only ${Math.round(seen.width)}×${Math.round(seen.height)}px of ${Math.round(r.width)}×${Math.round(r.height)}px is visible: "${snippet(el)}"`)
    if (seen.width < 2 || seen.height < 2 || el.disabled) continue
    const top = document.elementFromPoint(seen.left + seen.width / 2, seen.top + seen.height / 2)
    if (top && top !== el && !el.contains(top) && !top.contains(el) && !el.closest('label')?.contains(top)) {
      // A message may float over the page for a few seconds, but never over the buttons of a dialog.
      const message = top.closest('.toasts')
      if (message ? backdrops.length > 0 : layerOf(top) === layerOf(el)) add('covered', el, `covered by ${describe(top)}: "${snippet(el)}"`)
    }
  }

  // Text: what it says, where it is drawn, how readable it is.
  const textRects = []
  const parseColor = (value) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(value)
    if (!m) {
      canvas.fillStyle = '#000'
      canvas.fillStyle = value
      m = /^rgba?\(([^)]+)\)$/.exec(canvas.fillStyle)
      if (!m) {
        const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(canvas.fillStyle)
        return hex ? { r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16), a: 1 } : null
      }
    }
    const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    return { r, g, b, a }
  }
  const blend = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 })
  const luminance = ({ r, g, b }) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  /** The solid colour behind an element, or null when a gradient or image is involved. */
  const backgroundOf = (el) => {
    const layers = []
    for (let p = el; p; p = p.parentElement) {
      const s = style(p)
      if (s.backgroundImage !== 'none') return null
      const c = parseColor(s.backgroundColor)
      if (c && c.a > 0) {
        layers.push(c)
        if (c.a >= 1) break
      }
    }
    if (!layers.length) return null
    let base = layers.pop()
    if (base.a < 1) base = blend(base, { r: 0, g: 0, b: 0, a: 1 })
    while (layers.length) base = blend(layers.pop(), base)
    return base
  }
  const opacityOf = (el) => {
    let o = 1
    for (let p = el; p; p = p.parentElement) o *= parseFloat(style(p).opacity)
    return o
  }
  const contrastSeen = new Set()
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  const strings = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim()
    if (!text) continue
    const el = node.parentElement
    if (!el || el.closest('svg, script, style, option') || !rendered(el)) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()]
    if (!rects.length) continue

    const technical = !!el.closest('pre, code, .mono, kbd, .row-title, .inspector-title, .row-model, .row-project, .preview, .path-value')
    if (!technical) {
      if (new RegExp(`^(${NS}):`).test(text) || /^[a-z][A-Za-z]*(\.[A-Za-z0-9_-]+)+$/.test(text)) add('raw-text', el, `looks like an untranslated key: "${text}"`)
      if (/\{\{|\}\}|\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date|\b(ENOENT|EACCES|EPERM|EBUSY)\b/.test(text)) add('raw-text', el, `"${text.slice(0, 60)}"`)
      if (!el.closest('.row, .nav-project, .ranked-row, dd, .plan-path, .plan-session-head, .result-session, .inspector-sub-text, .group-name, .page-title, .root-entry, .candidate code, .plain-list .strong')) strings.push(text)
    }

    // Sticking out of its own block.
    let block = el
    while (block && style(block).display === 'inline') block = block.parentElement
    if (block && !/hidden|clip/.test(style(block).overflowX)) {
      const box = block.getBoundingClientRect()
      for (const r of rects) {
        if (r.right > box.right + 1.5 || r.left < box.left - 1.5) {
          add('spill', block, `text is ${Math.round(Math.max(r.right - box.right, box.left - r.left))}px outside its box: "${text.slice(0, 50)}"`)
          break
        }
      }
    }

    // Cut off sideways by a container that does not scroll and shows no ellipsis.
    cut: for (let p = el; p; p = p.parentElement) {
      const ps = style(p)
      if (!clips(ps)) continue
      if (scrolls(ps)) break
      if (ps.textOverflow === 'ellipsis') break // Cut on purpose, with a visible "…".
      if (!/hidden|clip/.test(ps.overflowX)) continue
      const box = p.getBoundingClientRect()
      for (const r of rects) {
        if (r.left < box.right && (r.right > box.right + 1 || r.left < box.left - 1)) {
          add('clipped-text', el, `cut off by ${describeOne(p)}: "${text.slice(0, 50)}"`)
          break cut
        }
      }
    }

    for (const r of rects) {
      const v = visiblePart(el, r)
      if (v && v.width > 1 && v.height > 1) textRects.push({ el, r: v, layer: layerOf(el), text })
    }

    // Contrast, once per kind of element.
    const key = describe(el)
    if (!contrastSeen.has(key) && !el.closest('button:disabled, input:disabled, select:disabled, [aria-disabled=true]')) {
      contrastSeen.add(key)
      const s = style(el)
      const bg = backgroundOf(el)
      const color = parseColor(s.color)
      if (bg && color) {
        const o = opacityOf(el)
        const fg = blend({ ...color, a: color.a * o }, bg)
        const a = luminance(fg)
        const b = luminance(bg)
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        const size = parseFloat(s.fontSize)
        const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight, 10) >= 700)
        if (ratio < 3) add('contrast', el, `${ratio.toFixed(2)}:1 "${text.slice(0, 40)}"`)
        else if (ratio < (large ? 3 : 4.5)) add('contrast', el, `${ratio.toFixed(2)}:1 "${text.slice(0, 40)}"`, 'warn')
      }
    }
  }
  for (let i = 0; i < textRects.length; i++) {
    const a = textRects[i]
    for (let j = i + 1; j < textRects.length; j++) {
      const b = textRects[j]
      if (a.el === b.el || a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue
      const o = intersect(a.r, b.r)
      if (o && o.width > 2 && o.height > Math.min(a.r.height, b.r.height) * 0.35) {
        problems.push({ rule: 'text-overlap', severity: 'error', where: `${describe(a.el)} × ${describe(b.el)}`, detail: `"${a.text.slice(0, 30)}" and "${b.text.slice(0, 30)}"` })
      }
    }
  }

  // Dialogs must fit the window, with their buttons on screen.
  for (const modal of scope.matches('.modal-backdrop') ? scope.querySelectorAll('.modal') : []) {
    const r = modal.getBoundingClientRect()
    if (r.top < -1 || r.bottom > vh + 1 || r.left < -1 || r.right > vw + 1) add('modal', modal, `dialog is at ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in a ${vw}×${vh} window`)
    const footer = modal.querySelector('.modal-footer')
    if (footer) {
      const f = footer.getBoundingClientRect()
      if (f.bottom > vh + 1 || f.top < 0) add('modal', footer, 'the dialog buttons are outside the window')
    }
  }

  // Names and references for screen readers.
  const accessibleName = (el) => {
    if (el.getAttribute('aria-label')?.trim()) return true
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy && labelledBy.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())) return true
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && (el.textContent ?? '').trim()) return true
    if (el.getAttribute('title')?.trim()) return true
    if (el.closest('label')?.textContent?.trim()) return true
    return !!(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim())
  }
  for (const el of controls) if (!accessibleName(el)) add('no-name', el, el.outerHTML.slice(0, 80))
  const ids = new Map()
  for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1)
  for (const [id, count] of ids) if (count > 1) problems.push({ rule: 'dup-id', severity: 'error', where: `#${id}`, detail: `${count} elements` })
  for (const el of live) {
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      const value = el.getAttribute(attr)
      if (value) for (const id of value.split(/\s+/)) if (!document.getElementById(id)) add('aria-ref', el, `${attr} points to a missing element`)
    }
  }

  return { problems, strings: [...new Set(strings)] }
}

/** The script to evaluate in the page. */
export const AUDIT_SCRIPT = `(${auditPage.toString()})()`
