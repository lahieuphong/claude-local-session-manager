import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type ScanState, type SessionManagerApi } from '../shared/ipc'
import { TERMINAL_IPC, type TerminalApi } from '../shared/terminal'
import type { SafetyModeState, ScanSnapshot, UpdateState } from '../shared/types'

/**
 * The only bridge between the renderer and the main process.
 * It exposes named, session-ID based operations — no file paths in, no
 * generic fs/shell/exec access.
 */
const api: SessionManagerApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  getLogs: () => ipcRenderer.invoke(IPC.getLogs),

  scanSessions: (provider) => ipcRenderer.invoke(IPC.scanSessions, provider),
  refreshSessions: (provider) => ipcRenderer.invoke(IPC.refreshSessions, provider),
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
  getStorageInfo: (accountId, provider) => ipcRenderer.invoke(IPC.getStorageInfo, accountId, provider),

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

/**
 * The integrated terminal, a bridge of its own (see shared/terminal.ts): a
 * shell is chosen by its ID, a folder by a session ID, and what the user
 * types goes to the terminal it was typed in. The main process answers
 * "not available" in the Microsoft Store edition.
 */
const terminal: TerminalApi = {
  info: () => ipcRenderer.invoke(TERMINAL_IPC.info),
  open: (request) => ipcRenderer.invoke(TERMINAL_IPC.open, request),
  close: (id) => ipcRenderer.invoke(TERMINAL_IPC.close, id),
  clipboardText: () => ipcRenderer.invoke(TERMINAL_IPC.clipboardText),
  openLink: (url) => ipcRenderer.invoke(TERMINAL_IPC.openLink, url),
  input: (id, data) => ipcRenderer.send(TERMINAL_IPC.input, id, data),
  resize: (id, cols, rows) => ipcRenderer.send(TERMINAL_IPC.resize, id, cols, rows),
  ack: (id, chars) => ipcRenderer.send(TERMINAL_IPC.ack, id, chars),
  onOutput: (listener) => {
    const wrapped = (_e: IpcRendererEvent, id: number, data: string): void => listener(id, data)
    ipcRenderer.on(TERMINAL_IPC.output, wrapped)
    return () => ipcRenderer.removeListener(TERMINAL_IPC.output, wrapped)
  },
  onExit: (listener) => {
    const wrapped = (_e: IpcRendererEvent, id: number, exitCode: number): void => listener(id, exitCode)
    ipcRenderer.on(TERMINAL_IPC.exit, wrapped)
    return () => ipcRenderer.removeListener(TERMINAL_IPC.exit, wrapped)
  }
}

contextBridge.exposeInMainWorld('terminal', terminal)
