/**
 * Confirmation phrases required before a permanent delete.
 *
 * Single session: "DELETE" or "DELETE PERMANENTLY".
 * Bulk: "DELETE <n>" where n is the number of sessions that will be deleted.
 */
export function confirmationPhrases(sessionCount: number, bulk: boolean): string[] {
  if (!bulk) return ['DELETE', 'DELETE PERMANENTLY']
  return [`DELETE ${sessionCount}`]
}

/** Exact match after trimming outer whitespace. Case-sensitive on purpose. */
export function isConfirmationValid(input: unknown, phrases: string[]): boolean {
  if (typeof input !== 'string') return false
  const value = input.trim()
  return phrases.some((p) => p === value)
}
