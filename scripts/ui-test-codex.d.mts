export const CODEX_UUID_RE: RegExp
export const CODEX_TEST_SECRET: string
export function codexUuid(n: number): string
export interface CodexThreadSpec {
  id: string
  name?: string
  title?: string
  first?: string
  cwd: string
  model?: string
  branch?: string
  archived?: boolean
  updatedAt: number
  createdAt?: number
  source?: string
  threadSource?: string
  parent?: string
  file?: boolean
  items?: Array<[string, string]>
  turnInProgressAt?: number
}
export function createCodexHome(dir: string, threads: CodexThreadSpec[]): string
export interface CodexRoles {
  named: string
  aiTitle: string
  archived: string
  withAgents: string
  agentA: string
  agentB: string
  recent: string
  longVi: string
  guardian: string
  secondActive: string
  secondArchived: string
}
export function writeCodexProfile(home: string, opts?: { now?: number; cwds?: string[] }): { main: string; second: string; roles: CodexRoles; userSessions: { main: number; second: number } }
export function runFakeCodex(args: string[], codexHome: string): { code: number; output: string }
