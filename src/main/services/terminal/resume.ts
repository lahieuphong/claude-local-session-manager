import { resumeCommand } from '../../../shared/terminal'
import type { ClaudeSession } from '../../../shared/types'

/** What a new terminal needs to take a session up again. */
export interface ResumePlan {
  /** Typed in once the shell is ready; never run by the app (Enter is the user's). */
  command: string
  /** The account folder, for a session of an account other than the main one. */
  env: Record<string, string>
}

export interface ResumeAccount {
  id: string
  path: string
  /** The folder the CLI uses when nothing says otherwise. */
  main: boolean
}

/** Session IDs are UUIDs for both tools; anything else is never typed into a shell. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `claude --resume <id>` or `codex resume <id>`, or null when the session
 * cannot be taken up: no ID, no conversation on this PC (Claude), or open in
 * a program right now. Each CLI finds an account other than its main one
 * through its own variable: CLAUDE_CONFIG_DIR for Claude, CODEX_HOME for Codex.
 */
export function resumePlan(
  session: Pick<ClaudeSession, 'provider' | 'cliSessionId' | 'accountIds' | 'hasTranscript' | 'live'>,
  accounts: ResumeAccount[]
): ResumePlan | null {
  const id = session.cliSessionId
  if (!id || !UUID_RE.test(id) || session.live) return null
  const codex = session.provider === 'codex'
  if (!codex && !session.hasTranscript) return null
  const own = accounts.filter((a) => session.accountIds.includes(a.id))
  const account = own.some((a) => a.main) ? undefined : own[0]
  return { command: resumeCommand(session.provider, id), env: account ? { [codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: account.path } : {} }
}
