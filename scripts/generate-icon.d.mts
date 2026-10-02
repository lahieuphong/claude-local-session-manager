export const ICO_SIZES: number[]
export function png(width: number, height?: number, markSize?: number): Buffer
export function ico(sizes?: number[]): Buffer
export function storeMarkSize(width: number, height: number): number
export function storeAsset(width: number, height: number): Buffer
export const STORE_LISTING_TILE: { file: string; size: number; markSize: number }
export function storeListingTile(): Buffer
