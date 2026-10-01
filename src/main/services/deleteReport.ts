import type { DeleteItemResult, DeletePlan, DeletePlanItem, DeleteResult, SessionDeletePlan } from '../../shared/types'
import { formatBytes, formatDateTime } from '../../shared/format'

const ACTION_LABEL: Record<DeletePlanItem['action'], string> = {
  'delete-file': 'delete file',
  'delete-directory': 'delete folder',
  'create-file': 'create file',
  'update-file': 'update file',
  'remove-record': 'remove record'
}

function bytes(n: number): string {
  return `${formatBytes(n)} (${n.toLocaleString('en-US')} bytes)`
}

function itemLine(i: DeletePlanItem | DeleteItemResult): string {
  const counts =
    i.action === 'delete-directory'
      ? ` [${i.fileCount ?? 0} file(s), ${i.dirCount ?? 1} folder(s)]`
      : i.action === 'delete-file'
        ? ' [1 file]'
        : ''
  const size = i.sizeBytes !== undefined && i.action.startsWith('delete') ? `  ${formatBytes(i.sizeBytes)}` : ''
  const outcome = 'outcome' in i ? `  => ${i.outcome.toUpperCase()}${i.error ? ` (${i.error})` : ''}` : ''
  const note = i.note ? `\n        note: ${i.note}` : ''
  return `    - ${i.kind.padEnd(14)} ${ACTION_LABEL[i.action]}${counts}${size}${outcome}\n        ${i.path}${note}`
}

function sessionBlock(s: SessionDeletePlan, index: number, total: number, items: Array<DeletePlanItem | DeleteItemResult>): string[] {
  const lines = [
    `SESSION ${index + 1}/${total}: ${s.displayTitle}`,
    `  Internal ID:     ${s.sessionId}`,
    `  CLI session ID:  ${s.cliSessionId ?? '-'}`,
    `  Desktop ID:      ${s.desktopSessionId ?? '-'}`,
    `  Status:          ${s.status}`,
    `  Project:         ${s.projectName}`,
    `  Project path:    ${s.projectPath ?? '(unknown)'}`,
    `  Totals:          ${s.totalFiles} file(s), ${s.totalDirs} folder(s), ${bytes(s.totalBytes)}`
  ]
  const groups: Array<[string, Array<DeletePlanItem | DeleteItemResult>]> = [
    ['WILL DELETE', items.filter((i) => i.action === 'delete-file' || i.action === 'delete-directory')],
    ['WILL CHANGE (Claude Desktop bookkeeping)', items.filter((i) => i.action === 'create-file' || i.action === 'update-file')],
    ['MANAGER RECORDS REMOVED (this app only)', items.filter((i) => i.action === 'remove-record')]
  ]
  for (const [title, list] of groups) {
    if (!list.length) continue
    lines.push(`  ${title}`)
    for (const i of list) lines.push(itemLine(i))
  }
  lines.push('  WILL NOT DELETE')
  for (const k of s.willNotDelete) lines.push(`    - ${k.path}\n        (${k.reason})`)
  for (const w of s.warnings) lines.push(`  WARNING: ${w}`)
  return lines
}

/** Plain-text plan for review / "COPY DELETE PLAN". */
export function formatPlanReport(plan: Omit<DeletePlan, 'reportText'>): string {
  const lines = [
    'CLAUDE LOCAL SESSION MANAGER - DELETE PLAN',
    `Plan ID:        ${plan.planId}`,
    `Content hash:   sha256:${plan.contentHash}`,
    `Created:        ${formatDateTime(plan.createdAt)}   (expires ${formatDateTime(plan.expiresAt)})`,
    `Mode:           ${plan.dryRun ? 'DRY RUN - validation and logging only, no files will be modified' : 'LIVE - files will be permanently deleted'}`,
    `Real deletion:  ${plan.globalBlockedReason ? `BLOCKED - ${plan.globalBlockedReason}` : 'allowed (if every check still passes at execution)'}`,
    `Sessions:       ${plan.sessions.length} to delete, ${plan.blocked.length} blocked`,
    `Totals:         ${plan.totalItems} item(s), ${plan.totalFiles} file(s), ${plan.totalDirs} folder(s), ${bytes(plan.totalBytes)}`,
    `Confirmation:   ${plan.confirmationPhrases.map((p) => `"${p}"`).join(' or ')}`,
    ''
  ]
  plan.sessions.forEach((s, i) => lines.push(...sessionBlock(s, i, plan.sessions.length, s.items), ''))
  if (plan.blocked.length) {
    lines.push('BLOCKED (will not be deleted)')
    for (const b of plan.blocked) lines.push(`  - ${b.displayTitle} [${b.cliSessionId ?? b.sessionId}]: ${b.blockedReason}`)
    lines.push('')
  }
  lines.push(
    'Execution re-scans, requires the same plan ID and content hash, the same CLI session IDs, and re-validates',
    'every path (approved Claude root, exact shape, no symlink/junction escape, never a workspace or an ancestor of one).'
  )
  return lines.join('\n')
}

/** Plain-text report of an executed (or dry-run) plan. */
export function formatResultReport(result: DeleteResult, plans: SessionDeletePlan[]): string {
  const lines = [
    `CLAUDE LOCAL SESSION MANAGER - DELETE ${result.dryRun ? 'DRY RUN ' : ''}RESULT`,
    `Plan ID:   ${result.planId ?? '-'}`,
    `Mode:      ${result.dryRun ? 'DRY RUN - nothing was modified' : 'LIVE'}`,
    `Result:    ${result.message}`,
    ''
  ]
  result.sessions.forEach((r, i) => {
    const plan = plans.find((p) => p.sessionId === r.sessionId)
    if (plan) lines.push(...sessionBlock(plan, i, result.sessions.length, r.items), `  OUTCOME: ${r.outcome.toUpperCase()}`, '')
  })
  return lines.join('\n')
}
