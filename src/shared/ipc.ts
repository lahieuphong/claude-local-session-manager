import type {
  ActionResult,
  AppInfo,
  AppSettings,
  ArmResult,
  BulkActionResult,
  DeletePlan,
  DeleteResult,
  ExportFormat,
  ExportResult,
  LogEntry,
  ProcessStatus,
  SafetyModeState,
  ScanSnapshot,
  SessionDetails,
  StorageInfo,
  UpdateState
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
  getSafetyMode: 'safety:get',
  armRealDelete: 'safety:arm',
  returnToSafeMode: 'safety:disarm',
  safetyModeChanged: 'safety:changed',
  getUpdateState: 'updates:get',
  checkForUpdates: 'updates:check',
  downloadUpdate: 'updates:download',
  installUpdate: 'updates:install',
  openReleasesPage: 'updates:open-releases',
  openStoreUpdates: 'updates:open-store-updates',
  openStoreListing: 'updates:open-store-listing',
  updateStateChanged: 'updates:changed',
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

  /** Deletion safety mode. Lives in main-process memory only; every launch starts in Safe Mode. */
  getSafetyMode(): Promise<SafetyModeState>
  /** Requires exactly "ENABLE DELETE" and Claude Desktop closed. */
  armRealDelete(confirmation: string): Promise<ArmResult>
  returnToSafeMode(): Promise<SafetyModeState>
  onSafetyModeChanged(listener: (state: SafetyModeState) => void): () => void

  /** Updates from GitHub Releases. No arguments: the renderer cannot pass a URL or a file to run. */
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  /** Restart and install a downloaded update (installed Setup build only). */
  installUpdate(): Promise<ActionResult>
  /** Opens the fixed GitHub Releases page of this project. */
  openReleasesPage(): Promise<ActionResult>
  /** Store builds: the Microsoft Store "Downloads and updates" page (fixed URI in main). */
  openStoreUpdates(): Promise<ActionResult>
  /** Store builds with a real product ID: the app's Store page (fixed URI in main). */
  openStoreListing(): Promise<ActionResult>
  onUpdateStateChanged(listener: (state: UpdateState) => void): () => void

  onSessionsChanged(listener: (snapshot: ScanSnapshot) => void): () => void
  onScanStateChanged(listener: (state: ScanState) => void): () => void
}
