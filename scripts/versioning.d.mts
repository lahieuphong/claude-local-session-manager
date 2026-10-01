export interface ParsedVersion {
  major: number
  minor: number
  patch: number
}
export type BumpKind = 'patch' | 'minor' | 'major'
export function parseVersion(version: string): ParsedVersion
export function formatVersion(v: ParsedVersion): string
export function bumpVersion(version: string, kind: BumpKind | string): string
export function compareVersions(a: string, b: string): number
export function tagToVersion(tag: string): string
export function versionToTag(version: string): string
export function tagMatchesVersion(tag: string, version: string): boolean
export function releaseAssetName(fileName: string): string
