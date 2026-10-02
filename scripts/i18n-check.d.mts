export const LOCALES_DIR: string
export const SOURCE: string
export const GLOSSARY: Record<string, Record<string, string>>
export function loadLocales(dir?: string): Record<string, Record<string, Record<string, unknown>>>
export function flatten(obj: Record<string, unknown>, prefix?: string, out?: Record<string, unknown>): Record<string, unknown>
export function placeholders(s: string): string[]
export function usedKeys(root?: string): { literal: string[]; prefixes: string[] }
export function checkTranslations(opts?: { dir?: string; root?: string }): { errors: string[]; stats: Record<string, number> }
