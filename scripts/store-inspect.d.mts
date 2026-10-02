import type { StoreIdentity } from './store-config.mjs'
export function listZipEntries(buffer: Buffer): string[]
export function inspectAppx(file: string): { entries: string[] }
export function reviewManifest(
  xml: string,
  opts: { identity: StoreIdentity; storeVersion: string; assets?: string[]; entries?: string[] | null }
): { ok: boolean; fields: Record<string, string | undefined>; text: string }
