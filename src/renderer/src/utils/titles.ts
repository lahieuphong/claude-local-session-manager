import type { TFunction } from 'i18next'
import { UNTITLED } from '../../../shared/titles'

/**
 * Titles that come from the main process as plain text (delete plans, storage
 * rankings, bulk results). The "Untitled" placeholder is the only text that is
 * not user content, so it is the only one translated.
 */
export function localTitle(t: TFunction, title: string): string {
  return title === UNTITLED ? t('sessions:untitled') : title
}
