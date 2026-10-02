import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type ScanState, type SessionManagerApi } from '../shared/ipc'
import type { SafetyModeState, ScanSnapshot, UpdateState } from '../shared/types'

/**
 * The only bridge between the renderer and the main process.
 * It exposes named, session-ID based operations — no file paths in, no
 * generic fs/shell/exec access.
 */
const api: SessionManagerApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  getLogs: () => ipcRenderer.invoke(IPC.getLogs),

  scanSessions: () => ipcRenderer.invoke(IPC.scanSessions),
  refreshSessions: () => ipcRenderer.invoke(IPC.refreshSessions),
  getSession: (id) => ipcRenderer.invoke(IPC.getSession, id),

  archiveSession: (id) => ipcRenderer.invoke(IPC.archiveSession, id),
  restoreSession: (id) => ipcRenderer.invoke(IPC.restoreSession, id),
  bulkArchive: (ids) => ipcRenderer.invoke(IPC.bulkArchive, ids),
  bulkRestore: (ids) => ipcRenderer.invoke(IPC.bulkRestore, ids),
  hideSession: (id) => ipcRenderer.invoke(IPC.hideSession, id),
  unhideSession: (id) => ipcRenderer.invoke(IPC.unhideSession, id),
  bulkHide: (ids) => ipcRenderer.invoke(IPC.bulkHide, ids),
  bulkUnhide: (ids) => ipcRenderer.invoke(IPC.bulkUnhide, ids),

  createDeletePlan: (id) => ipcRenderer.invoke(IPC.createDeletePlan, id),
  deleteSession: (id, confirmation, planId) => ipcRenderer.invoke(IPC.deleteSession, id, confirmation, planId),
  createBulkDeletePlan: (ids) => ipcRenderer.invoke(IPC.createBulkDeletePlan, ids),
  bulkDelete: (ids, confirmation, planId) => ipcRenderer.invoke(IPC.bulkDelete, ids, confirmation, planId),

  exportSession: (id, format) => ipcRenderer.invoke(IPC.exportSession, id, format),
  exportSessions: (ids, formats) => ipcRenderer.invoke(IPC.exportSessions, ids, formats),

  revealMetadata: (id) => ipcRenderer.invoke(IPC.revealMetadata, id),
  revealTranscript: (id) => ipcRenderer.invoke(IPC.revealTranscript, id),
  revealSessionData: (id) => ipcRenderer.invoke(IPC.revealSessionData, id),
  openProject: (id) => ipcRenderer.invoke(IPC.openProject, id),

  getClaudeProcessStatus: (force) => ipcRenderer.invoke(IPC.getClaudeProcessStatus, force === true),
  getStorageInfo: () => ipcRenderer.invoke(IPC.getStorageInfo),

  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  clearCache: () => ipcRenderer.invoke(IPC.clearCache),

  getSafetyMode: () => ipcRenderer.invoke(IPC.getSafetyMode),
  armRealDelete: (confirmation) => ipcRenderer.invoke(IPC.armRealDelete, confirmation),
  returnToSafeMode: () => ipcRenderer.invoke(IPC.returnToSafeMode),
  getUpdateState: () => ipcRenderer.invoke(IPC.getUpdateState),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(IPC.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  openReleasesPage: () => ipcRenderer.invoke(IPC.openReleasesPage),
  openStoreUpdates: () => ipcRenderer.invoke(IPC.openStoreUpdates),
  openStoreListing: () => ipcRenderer.invoke(IPC.openStoreListing),
  onUpdateStateChanged: (listener) => {
    const wrapped = (_e: IpcRendererEvent, state: UpdateState): void => listener(state)
    ipcRenderer.on(IPC.updateStateChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC.updateStateChanged, wrapped)
  },
  onSafetyModeChanged: (listener) => {
    const wrapped = (_e: IpcRendererEvent, state: SafetyModeState): void => listener(state)
    ipcRenderer.on(IPC.safetyModeChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC.safetyModeChanged, wrapped)
  },

  onSessionsChanged: (listener) => {
    const wrapped = (_e: IpcRendererEvent, snapshot: ScanSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC.sessionsChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC.sessionsChanged, wrapped)
  },
  onScanStateChanged: (listener) => {
    const wrapped = (_e: IpcRendererEvent, state: ScanState): void => listener(state)
    ipcRenderer.on(IPC.scanStateChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC.scanStateChanged, wrapped)
  }
}

contextBridge.exposeInMainWorld('sessionManager', api)
