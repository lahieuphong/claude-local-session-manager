import type { ClaudeSession } from '../../../shared/types'
import type { GroupBy, SessionFilter, SortKey } from '../stores/appStore'

export function matchesFilter(s: ClaudeSession, filter: SessionFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return !s.archived && (s.status === 'active' || s.status === 'transcript-only')
    case 'archived':
      return s.archived
    case 'transcript-only':
      return s.status === 'transcript-only'
    case 'problems':
      return s.status === 'metadata-only' || s.status === 'orphan' || s.problems.length > 0
  }
}

/** Lowercase and strip diacritics so "nha hat" finds "Nhà hát". */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

const haystacks = new WeakMap<ClaudeSession, { raw: string; folded: string }>()

function haystack(s: ClaudeSession): { raw: string; folded: string } {
  let h = haystacks.get(s)
  if (!h) {
    const raw = [
      s.displayTitle,
      s.customTitle,
      s.aiTitle,
      s.summary,
      s.firstUserMessage,
      s.lastUserMessage,
      s.lastPrompt,
      s.projectName,
      s.projectPath,
      s.projectDirName,
      s.transcriptFile,
      s.metadataFile,
      s.sessionDataDirectory,
      s.cliSessionId,
      s.desktopSessionId,
      s.id,
      s.model
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    h = { raw, folded: fold(raw) }
    haystacks.set(s, h)
  }
  return h
}

/** Every whitespace-separated term must match (title, prompts, project, paths, IDs). */
export function matchesSearch(s: ClaudeSession, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const h = haystack(s)
  return terms.every((t) => h.raw.includes(t) || h.folded.includes(fold(t)))
}

export function sortSessions(list: ClaudeSession[], sort: SortKey): ClaudeSession[] {
  const out = [...list]
  const updated = (s: ClaudeSession): number => s.updatedAt ?? 0
  switch (sort) {
    case 'updated-desc':
      return out.sort((a, b) => updated(b) - updated(a))
    case 'updated-asc':
      return out.sort((a, b) => updated(a) - updated(b))
    case 'title':
      return out.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle, undefined, { sensitivity: 'base' }))
    case 'size-desc':
      return out.sort((a, b) => b.totalSize - a.totalSize)
    case 'size-asc':
      return out.sort((a, b) => a.totalSize - b.totalSize)
  }
}

export interface SessionGroup {
  key: string
  label: string
  sessions: ClaudeSession[]
}

function dateBucket(ms: number | undefined, now: Date): string {
  if (!ms) return 'Unknown date'
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  if (ms >= startOfToday) return 'Today'
  if (ms >= startOfToday - day) return 'Yesterday'
  if (ms >= startOfToday - 7 * day) return 'Previous 7 days'
  if (ms >= startOfToday - 30 * day) return 'Previous 30 days'
  return 'Older'
}

export function groupSessions(list: ClaudeSession[], groupBy: GroupBy, now = new Date()): SessionGroup[] {
  if (groupBy === 'none') return [{ key: 'all', label: '', sessions: list }]
  const groups = new Map<string, SessionGroup>()
  for (const s of list) {
    const key = groupBy === 'date' ? dateBucket(s.updatedAt, now) : s.projectKey
    const label = groupBy === 'date' ? key : s.projectName
    let g = groups.get(key)
    if (!g) {
      g = { key, label, sessions: [] }
      groups.set(key, g)
    }
    g.sessions.push(s)
  }
  return [...groups.values()]
}

export interface ProjectEntry {
  key: string
  name: string
  path?: string
  count: number
  totalSize: number
}

export function projectsOf(sessions: ClaudeSession[]): ProjectEntry[] {
  const map = new Map<string, ProjectEntry>()
  for (const s of sessions) {
    const p = map.get(s.projectKey) ?? { key: s.projectKey, name: s.projectName, path: s.projectPath, count: 0, totalSize: 0 }
    p.count++
    p.totalSize += s.totalSize
    map.set(s.projectKey, p)
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export function filterCounts(sessions: ClaudeSession[]): Record<SessionFilter, number> {
  const filters: SessionFilter[] = ['all', 'active', 'archived', 'transcript-only', 'problems']
  return Object.fromEntries(filters.map((f) => [f, sessions.filter((s) => matchesFilter(s, f)).length])) as Record<
    SessionFilter,
    number
  >
}
