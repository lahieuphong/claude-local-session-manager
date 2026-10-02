export const LISTING_ASSETS_DIR: string
export const LISTING_LOCALES: Record<'en-US' | 'vi-VN' | 'zh-CN', 'en' | 'vi' | 'zh-CN'>
export const SCREENSHOTS: string[]
export const SCREENSHOT_SIZE: { width: number; height: number }
export const APP_TILE: { file: string; width: number; height: number }
export function readPngHeader(buf: Buffer): { width: number; height: number; bitDepth: number; colorType: number } | null
export function validateListingAssets(dir?: string): {
  errors: string[]
  checked: Array<{ file: string; width: number; height: number; bytes: number }>
}
