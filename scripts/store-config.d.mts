export interface StoreIdentity {
  identityName: string
  publisher: string
  publisherDisplayName: string
  displayName: string
  storeProductId: string
}
export const ROOT: string
export const IDENTITY_FILE: string
export const STORE_OUTPUT: string
export const STORE_TEST_OUTPUT: string
export const STORE_LANGUAGE_MAP: Record<string, string>
export const STORE_MIN_WINDOWS: string
export const STORE_MAX_TESTED_WINDOWS: string
export const STORE_APPLICATION_ID: string
export const STORE_EXCLUDED_FILES: string
export const STORE_ASSETS: Record<string, [number, number]>
export const IDENTITY_FIELDS: Record<keyof StoreIdentity, { env: string; aliases?: string[]; partnerCenter: string }>
export const TEST_IDENTITY: Readonly<StoreIdentity>
export function toStorePackageVersion(semver: string): string
export function loadStoreIdentity(opts?: { root?: string; env?: Record<string, string | undefined> }): StoreIdentity
export function validateStoreIdentity(identity: StoreIdentity): string[]
export function identityHelp(errors: string[]): string
export function storeArtifactName(storeVersion: string, opts?: { test?: boolean }): string
export function storeBuilderConfig(opts: { identity: StoreIdentity; version: string; test?: boolean }): {
  directories: { output: string }
  files: string[]
  extraMetadata: { distributionChannel: 'store'; storeProductId: string }
  appx: Record<string, unknown>
}
