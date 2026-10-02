import { useSyncExternalStore } from 'react'
import type {
  ActionResult,
  AppInfo,
  AppSettings,
  ArmResult,
  BulkActionResult,
  ExportFormat,
  ExportResult,
  MessageRef,
  MotionPreference,
  ProcessStatus,
  SafetyModeState,
  ScanSnapshot,
  UpdateState
} from '../../../shared/types'
import { resolveLocale, type SupportedLocale } from '../../../shared/locale'
import { applyLocale } from '../i18n'

import type { GroupBy, SessionFilter, SortKey } from '../../../shared/sessionQuery'
export type { GroupBy, SessionFilter, SortKey }

export type View =
  | { kind: 'sessions'; filter: SessionFilter; project?: string }
  | { kind: 'storage' }
  | { kind: 'settings' }

/**
 * A piece of toast text, resolved at render time so it follows the UI language:
 *  - { key, params }: a renderer translation key
 *  - { text, msg }: a main-process message (translated when `msg` is known, else the English text)
 */
export type ToastPart = { key: string; params?: Record<string, string | number> } | { text: string; msg?: MessageRef }

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info' | 'warning'
  parts: ToastPart[]
  leaving?: boolean
}

export interface DeleteRequest {
  ids: string[]
  bulk: boolean
}

export interface AppState {
  appInfo: AppInfo | null
  /** Deletion safety mode from the main process (memory only, never persisted). */
  safety: SafetyModeState | null
  armModalOpen: boolean
  updates: UpdateState | null
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
  safety: null,
  armModalOpen: false,
  updates: null,
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

/** Matches the toast exit animation in global.css. */
const TOAST_EXIT_MS = 220

let toastId = 0
export function toast(kind: Toast['kind'], parts: ToastPart | ToastPart[], ttl = kind === 'error' ? 9000 : 4500): void {
  const id = ++toastId
  const list = Array.isArray(parts) ? parts : [parts]
  setState((s) => ({ toasts: [...s.toasts.filter((t) => !t.leaving).slice(-3), { id, kind, parts: list }] }))
  window.setTimeout(() => dismissToast(id), ttl)
}

export function dismissToast(id: number): void {
  if (!state.toasts.some((t) => t.id === id && !t.leaving)) return
  setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }))
  window.setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), TOAST_EXIT_MS)
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Toast for a failed call: translated prefix + the raw (technical) error. */
function toastError(key: string, err: unknown): void {
  toast('error', { key, params: { error: errText(err) } })
}

const resultPart = (r: { message: string; msg?: MessageRef }): ToastPart => ({ text: r.message, msg: r.msg })

function reportResult(r: ActionResult): void {
  const kind = r.ok ? (r.dryRun ? 'info' : 'success') : r.code === 'CLAUDE_RUNNING' || r.code === 'SESSION_IN_USE' ? 'warning' : 'error'
  // Notes (warnings) are part of the English `message`; with keys they are shown translated after it.
  const notes = r.msg ? (r.notes ?? []).map((n): ToastPart => ({ text: '', msg: n })) : []
  toast(kind, [resultPart(r), ...notes])
}

// ---------------------------------------------------------------------------
// Language and motion (saved in the main-process settings file)
// ---------------------------------------------------------------------------

function applyMotion(motion: MotionPreference | undefined): void {
  document.documentElement.dataset.motion = motion === 'reduced' ? 'reduced' : 'system'
}

function applyUiSettings(settings: AppSettings, appInfo: AppInfo | null): void {
  applyLocale(resolveLocale(settings.language, appInfo?.systemLanguages ?? navigator.languages ?? []))
  applyMotion(settings.motion)
}

/** Switch language now and remember the choice. */
export async function setLanguage(language: SupportedLocale | null): Promise<void> {
  applyLocale(resolveLocale(language, state.appInfo?.systemLanguages ?? navigator.languages ?? []))
  await updateSettings({ language })
}

export async function setMotion(motion: MotionPreference): Promise<void> {
  applyMotion(motion)
  await updateSettings({ motion })
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
  api().onSafetyModeChanged((safety) => setState({ safety }))
  api().onUpdateStateChanged((updates) => setState({ updates }))
  void api()
    .getUpdateState()
    .then((updates) => setState({ updates }))
    .catch(() => undefined)
  void api()
    .getSafetyMode()
    .then((safety) => setState({ safety }))
    .catch((err) => toastError('common:toast.safetyReadFailed', err))
  try {
    const [appInfo, settings] = await Promise.all([api().getAppInfo(), api().getSettings()])
    setState({ appInfo, settings })
    applyUiSettings(settings, appInfo)
  } catch (err) {
    setState({ loadError: errText(err) })
  }
  void refreshProcess(false)
  try {
    setState({ scanning: true })
    applySnapshot(await api().scanSessions())
  } catch (err) {
    setState({ loadError: errText(err) })
    toastError('common:toast.scanFailed', err)
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
    toastError('common:toast.refreshFailed', err)
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
    toastError('common:toast.processCheckFailed', err)
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
    toast('error', { text: errText(err) })
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
  const parts: ToastPart[] = [resultPart(r)]
  if (first) parts.push({ key: 'common:toast.firstFailure', params: { title: first.title } }, resultPart(first))
  toast(r.ok ? (r.results.some((x) => x.dryRun) ? 'info' : 'success') : 'warning', parts)
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
  toast(r.ok ? 'success' : 'error', r.errors.length ? [resultPart(r), { text: r.errors[0] }] : resultPart(r))
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
    toastError('common:toast.settingsSaveFailed', err)
  }
}

// ---------------------------------------------------------------------------
// Deletion safety mode
// ---------------------------------------------------------------------------

export function openArmModal(open: boolean): void {
  setState({ armModalOpen: open })
}

/** Arm real deletion (exact "ENABLE DELETE"; main also requires Claude Desktop closed). */
export async function armRealDelete(confirmation: string): Promise<ArmResult | undefined> {
  try {
    const r = await api().armRealDelete(confirmation)
    setState({ safety: r.state })
    toast(r.ok ? 'warning' : 'error', resultPart(r))
    if (r.ok) setState({ armModalOpen: false })
    return r
  } catch (err) {
    toast('error', { text: errText(err) })
    return undefined
  }
}

export async function returnToSafeMode(): Promise<void> {
  try {
    setState({ safety: await api().returnToSafeMode() })
    toast('info', { key: 'safety:toast.returned' })
  } catch (err) {
    toast('error', { text: errText(err) })
  }
}

export async function refreshSafetyMode(): Promise<void> {
  try {
    setState({ safety: await api().getSafetyMode() })
  } catch {
    /* next push will correct it */
  }
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

async function updateCall(fn: () => Promise<UpdateState>): Promise<void> {
  try {
    setState({ updates: await fn() })
  } catch (err) {
    toastError('updater:toast.failed', err)
  }
}

export const checkForUpdates = (): Promise<void> => updateCall(() => api().checkForUpdates())
export const downloadUpdate = (): Promise<void> => updateCall(() => api().downloadUpdate())

export async function installUpdate(): Promise<void> {
  try {
    const r = await api().installUpdate()
    toast(r.ok ? 'info' : 'error', resultPart(r))
  } catch (err) {
    toastError('updater:toast.failed', err)
  }
}

export async function openReleasesPage(): Promise<void> {
  try {
    await api().openReleasesPage()
  } catch (err) {
    toast('error', { text: errText(err) })
  }
}

export async function clearCache(): Promise<void> {
  const r = await withBusy(() => api().clearCache())
  if (r) reportResult(r)
}

export async function copyToClipboard(text: string, what: ToastPart = { key: 'common:toast.copied' }): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast('info', what)
  } catch (err) {
    toastError('common:toast.copyFailed', err)
  }
}

export { errText }
