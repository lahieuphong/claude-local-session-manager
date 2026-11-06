export const UI_TEST_MARKER: string
export const UI_UUID_RE: RegExp
export const LONG_TITLE_EN: string
export const LONG_TITLE_VI: string
export const LONG_TITLE_ZH: string
export const UNBROKEN_TITLE: string
export function uiUuid(n: number): string
export interface UiTestRoles {
  longEn: string
  longVi: string
  longZh: string
  unbroken: string
  untitled: string
  noProject: string
  disposable: string
  desktopActive: string[]
  desktopArchived: string[]
  metadataOnly: string
  metadataFiles: Record<string, string>
  live?: string
  liveFile?: string
}
export function writeUiTestProfile(home: string, opts?: { now?: number; livePid?: number }): { claudeHome: string; sessionFiles: number; projectCount: number; roles: UiTestRoles }
