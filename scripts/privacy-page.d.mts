export const PRIVACY_SOURCE: string
export const SITE_DIR: string
export const SITE_URL: string
export const PRIVACY_URL: string
export const SUPPORT_URL: string
export const SOURCE_URL: string
export function markdownToHtml(markdown: string): string
export function renderPrivacyPage(markdown: string): string
export function renderHomePage(): string
export function sitePages(opts?: { root?: string }): Record<string, string>
