export const DEMO_MARKER: string
export const DEMO_UUID_RE: RegExp
export const DEMO_PROJECTS: Record<'web' | 'api' | 'design', string>
export interface DemoSession {
  n: number
  title: string
  project: 'web' | 'api' | 'design'
  ageMin?: number
  daysAgo?: number
  at?: string
  durationMin: number
  model: string
  branch: string
  entrypoint: string
  prompts: string[]
  turns: number
  tools: number
  transcript: number
  data?: [number, number]
  history?: [number, number]
  env?: number
}
export const DEMO_SESSIONS: DemoSession[]
export function demoUuid(n: number): string
export function writeDemoProfile(home: string, opts?: { now?: number; scale?: number }): { claudeHome: string; sessions: number; files: number; bytes: number }
