import { useSyncExternalStore } from 'react'
import type {
  ActionResult,
  AppInfo,
  AppSettings,
  BulkActionResult,
  ExportFormat,
  ExportResult,
  ProcessStatus,
  ScanSnapshot
} from '../../../shared/types'

import type { GroupBy, SessionFilter, SortKey } from '../../../shared/sessionQuery'
export type { GroupBy, SessionFilter, SortKey }

export type View =
  | { kind: 'sessions'; filter: SessionFilter; project?: string }
  | { kind: 'storage' }
  | { kind: 'settings' }

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info' | 'warning'
  message: string
}

export interface DeleteRequest {
  ids: string[]
  bulk: boolean
}

export interface AppState {
  appInfo: AppInfo | null
  settings: AppSettings | null
  snapshot: ScanSnapshot | null
  scanning: boolean
  loadError?: string
  process: ProcessStatus | null
  processChecking: boolean
  view: View
  search: string
  sort: SortKey
  groupBy: GroupBy
  selectedId: string | null
  checked: string[]
  toasts: Toast[]
  deleteRequest: DeleteRequest | null
  busy: boolean
}

const api = (): Window['sessionManager'] => window.sessionManager

function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* per-viewer convenience only */
  }
}

let state: AppState = {
  appInfo: null,
  settings: null,
  snapshot: null,
  scanning: false,
  process: null,
  processChecking: false,
  view: { kind: 'sessions', filter: 'all' },
  search: '',
  sort: loadPref<SortKey>('sort', ['updated-desc', 'updated-asc', 'title', 'size-desc', 'size-asc'], 'updated-desc'),
  groupBy: loadPref<GroupBy>('groupBy', ['date', 'project', 'none'], 'date'),
  selectedId: null,
  checked: [],
  toasts: [],
  deleteRequest: null,
  busy: false
}

const listeners = new Set<() => void>()

export function getState(): AppState {
  return state
}

function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastId = 0
export function toast(kind: Toast['kind'], message: string, ttl = kind === 'error' ? 9000 : 4500): void {
  const id = ++toastId
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }))
  window.setTimeout(() => dismissToast(id), ttl)
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function reportResult(r: ActionResult): void {
  toast(r.ok ? (r.dryRun ? 'info' : 'success') : r.code === 'CLAUDE_RUNNING' || r.code === 'SESSION_IN_USE' ? 'warning' : 'error', r.message)
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function applySnapshot(snapshot: ScanSnapshot): void {
  setState((s) => {
    const ids = new Set(snapshot.sessions.map((x) => x.id))
    return {
      snapshot,
      loadError: undefined,
      selectedId: s.selectedId && ids.has(s.selectedId) ? s.selectedId : null,
      checked: s.checked.filter((id) => ids.has(id))
    }
  })
}

let initialized = false
export async function init(): Promise<void> {
  if (initialized) return
  initialized = true
  api().onSessionsChanged(applySnapshot)
  api().onScanStateChanged((st) => setState({ scanning: st.scanning }))
  try {
    const [appInfo, settings] = await Promise.all([api().getAppInfo(), api().getSettings()])
    setState({ appInfo, settings })
  } catch (err) {
    setState({ loadError: errText(err) })
  }
  void refreshProcess(false)
  try {
    setState({ scanning: true })
    applySnapshot(await api().scanSessions())
  } catch (err) {
    setState({ loadError: errText(err) })
    toast('error', `Scan failed: ${errText(err)}`)
  } finally {
    setState({ scanning: false })
  }
}

export async function refresh(): Promise<void> {
  try {
    setState({ scanning: true })
    applySnapshot(await api().refreshSessions())
    void refreshProcess(true)
  } catch (err) {
    toast('error', `Refresh failed: ${errText(err)}`)
  } finally {
    setState({ scanning: false })
  }
}

export async function refreshProcess(force: boolean): Promise<ProcessStatus | null> {
  setState({ processChecking: true })
  try {
    const process = await api().getClaudeProcessStatus(force)
    setState({ process })
    return process
  } catch (err) {
    toast('error', `Process check failed: ${errText(err)}`)
    return null
  } finally {
    setState({ processChecking: false })
  }
}

// ---------------------------------------------------------------------------
// Navigation / selection
// ---------------------------------------------------------------------------

export function setView(view: View): void {
  setState({ view, checked: [] })
}

export function setSearch(search: string): void {
  setState({ search })
}

export function setSort(sort: SortKey): void {
  savePref('sort', sort)
  setState({ sort })
}

export function setGroupBy(groupBy: GroupBy): void {
  savePref('groupBy', groupBy)
  setState({ groupBy })
}

export function select(id: string | null): void {
  setState({ selectedId: id })
}

export function toggleChecked(id: string): void {
  setState((s) => ({ checked: s.checked.includes(id) ? s.checked.filter((x) => x !== id) : [...s.checked, id] }))
}

export function setChecked(ids: string[]): void {
  setState({ checked: [...new Set(ids)] })
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function withBusy<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (state.busy) return undefined
  setState({ busy: true })
  try {
    return await fn()
  } catch (err) {
    toast('error', errText(err))
    return undefined
  } finally {
    setState({ busy: false })
  }
}

export async function archive(id: string, archived: boolean): Promise<void> {
  const r = await withBusy(() => (archived ? api().archiveSession(id) : api().restoreSession(id)))
  if (r) reportResult(r)
}

function reportBulk(r: BulkActionResult | undefined): void {
  if (!r) return
  const first = r.results.find((x) => !x.ok)
  toast(r.ok ? (r.results.some((x) => x.dryRun) ? 'info' : 'success') : 'warning', first ? `${r.message} ${first.title}: ${first.message}` : r.message)
  if (r.ok) setState({ checked: [] })
}

/** Claude Desktop archive (sessions with real metadata only). */
export async function bulkArchive(ids: string[], archived: boolean): Promise<void> {
  reportBulk(await withBusy(() => (archived ? api().bulkArchive(ids) : api().bulkRestore(ids))))
}

/** Manager-only hide/show (never touches Claude files). */
export async function hideInManager(id: string, hidden: boolean): Promise<void> {
  const r = await withBusy(() => (hidden ? api().hideSession(id) : api().unhideSession(id)))
  if (r) reportResult(r)
}

export async function bulkHideInManager(ids: string[], hidden: boolean): Promise<void> {
  reportBulk(await withBusy(() => (hidden ? api().bulkHide(ids) : api().bulkUnhide(ids))))
}

function reportExport(r: ExportResult | undefined): void {
  if (!r || r.cancelled) return
  toast(r.ok ? 'success' : 'error', r.errors.length ? `${r.message} ${r.errors[0]}` : r.message)
}

export async function exportOne(id: string, format: ExportFormat): Promise<void> {
  reportExport(await withBusy(() => api().exportSession(id, format)))
}

export async function exportMany(ids: string[], formats: ExportFormat[]): Promise<void> {
  reportExport(await withBusy(() => api().exportSessions(ids, formats)))
}

export async function runAction(fn: () => Promise<ActionResult>): Promise<void> {
  const r = await withBusy(fn)
  if (r && !r.ok) reportResult(r)
}

export function openDelete(ids: string[], bulk: boolean): void {
  if (ids.length) setState({ deleteRequest: { ids, bulk } })
}

export function closeDelete(): void {
  setState({ deleteRequest: null })
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  try {
    setState({ settings: await api().updateSettings(patch) })
  } catch (err) {
    toast('error', `Could not save settings: ${errText(err)}`)
  }
}

export async function clearCache(): Promise<void> {
  const r = await withBusy(() => api().clearCache())
  if (r) reportResult(r)
}

export { errText }
