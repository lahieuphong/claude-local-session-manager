import type {
  ActionResult,
  AppInfo,
  AppSettings,
  BulkActionResult,
  DeletePlan,
  DeleteResult,
  ExportFormat,
  ExportResult,
  LogEntry,
  ProcessStatus,
  ScanSnapshot,
  SessionDetails,
  StorageInfo
} from './types'

/**
 * IPC channel names. The renderer can only reach the main process through
 * these channels (exposed by the preload script); there is deliberately no
 * generic file-system channel. Every session-mutating call takes internal
 * session IDs produced by the scanner, never paths.
 */
export const IPC = {
  getAppInfo: 'app:get-info',
  getLogs: 'app:get-logs',
  scanSessions: 'sessions:scan',
  refreshSessions: 'sessions:refresh',
  getSession: 'sessions:get',
  archiveSession: 'sessions:archive',
  restoreSession: 'sessions:restore',
  bulkArchive: 'sessions:bulk-archive',
  bulkRestore: 'sessions:bulk-restore',
  hideSession: 'sessions:hide',
  unhideSession: 'sessions:unhide',
  bulkHide: 'sessions:bulk-hide',
  bulkUnhide: 'sessions:bulk-unhide',
  createDeletePlan: 'sessions:delete-plan',
  deleteSession: 'sessions:delete',
  createBulkDeletePlan: 'sessions:bulk-delete-plan',
  bulkDelete: 'sessions:bulk-delete',
  exportSession: 'sessions:export',
  exportSessions: 'sessions:export-bulk',
  revealMetadata: 'sessions:reveal-metadata',
  revealTranscript: 'sessions:reveal-transcript',
  revealSessionData: 'sessions:reveal-session-data',
  openProject: 'sessions:open-project',
  getClaudeProcessStatus: 'process:status',
  getStorageInfo: 'storage:info',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  clearCache: 'cache:clear',
  /** main → renderer push */
  sessionsChanged: 'sessions:changed',
  scanStateChanged: 'sessions:scan-state'
} as const

export interface ScanState {
  scanning: boolean
  reason?: string
}

export interface SessionManagerApi {
  getAppInfo(): Promise<AppInfo>
  getLogs(): Promise<LogEntry[]>

  scanSessions(): Promise<ScanSnapshot>
  refreshSessions(): Promise<ScanSnapshot>
  getSession(id: string): Promise<SessionDetails | null>

  /** Claude Desktop archive (`isArchived` in metadata). Desktop sessions only. */
  archiveSession(id: string): Promise<ActionResult>
  restoreSession(id: string): Promise<ActionResult>
  bulkArchive(ids: string[]): Promise<BulkActionResult>
  bulkRestore(ids: string[]): Promise<BulkActionResult>

  /** Hide/show inside this manager only. Never touches Claude files or Claude's archive state. */
  hideSession(id: string): Promise<ActionResult>
  unhideSession(id: string): Promise<ActionResult>
  bulkHide(ids: string[]): Promise<BulkActionResult>
  bulkUnhide(ids: string[]): Promise<BulkActionResult>

  createDeletePlan(id: string): Promise<DeletePlan>
  /** Only the session ID, plan ID and typed confirmation cross IPC — never paths. */
  deleteSession(id: string, confirmation: string, planId: string): Promise<DeleteResult>
  createBulkDeletePlan(ids: string[]): Promise<DeletePlan>
  bulkDelete(ids: string[], confirmation: string, planId: string): Promise<DeleteResult>

  exportSession(id: string, format: ExportFormat): Promise<ExportResult>
  exportSessions(ids: string[], formats: ExportFormat[]): Promise<ExportResult>

  revealMetadata(id: string): Promise<ActionResult>
  revealTranscript(id: string): Promise<ActionResult>
  revealSessionData(id: string): Promise<ActionResult>
  openProject(id: string): Promise<ActionResult>

  getClaudeProcessStatus(force?: boolean): Promise<ProcessStatus>
  getStorageInfo(): Promise<StorageInfo>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  clearCache(): Promise<ActionResult>

  onSessionsChanged(listener: (snapshot: ScanSnapshot) => void): () => void
  onScanStateChanged(listener: (state: ScanState) => void): () => void
}
