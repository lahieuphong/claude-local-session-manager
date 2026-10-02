/**
 * UI translations: one JSON file per namespace and language.
 * en is the source language; every other language must have the same keys
 * (tests/i18n.test.ts and `yarn i18n:check` verify this).
 *
 * To add a language (e.g. zh-TW): add it to SUPPORTED_LOCALES in ../locale.ts,
 * copy the en/ folder, translate it, and register it below.
 */
import enCommon from './en/common.json'
import enSessions from './en/sessions.json'
import enInspector from './en/inspector.json'
import enDeletion from './en/deletion.json'
import enSafety from './en/safety.json'
import enSettings from './en/settings.json'
import enStorage from './en/storage.json'
import enUpdater from './en/updater.json'
import enMessages from './en/messages.json'
import viCommon from './vi/common.json'
import viSessions from './vi/sessions.json'
import viInspector from './vi/inspector.json'
import viDeletion from './vi/deletion.json'
import viSafety from './vi/safety.json'
import viSettings from './vi/settings.json'
import viStorage from './vi/storage.json'
import viUpdater from './vi/updater.json'
import viMessages from './vi/messages.json'
import zhCommon from './zh-CN/common.json'
import zhSessions from './zh-CN/sessions.json'
import zhInspector from './zh-CN/inspector.json'
import zhDeletion from './zh-CN/deletion.json'
import zhSafety from './zh-CN/safety.json'
import zhSettings from './zh-CN/settings.json'
import zhStorage from './zh-CN/storage.json'
import zhUpdater from './zh-CN/updater.json'
import zhMessages from './zh-CN/messages.json'
import type { SupportedLocale } from '../locale'

export const NAMESPACES = ['common', 'sessions', 'inspector', 'deletion', 'safety', 'settings', 'storage', 'updater', 'messages'] as const
export type Namespace = (typeof NAMESPACES)[number]

export type LocaleTree = { [k: string]: string | LocaleTree }

export const RESOURCES: Record<SupportedLocale, Record<Namespace, LocaleTree>> = {
  en: {
    common: enCommon,
    sessions: enSessions,
    inspector: enInspector,
    deletion: enDeletion,
    safety: enSafety,
    settings: enSettings,
    storage: enStorage,
    updater: enUpdater,
    messages: enMessages
  },
  vi: {
    common: viCommon,
    sessions: viSessions,
    inspector: viInspector,
    deletion: viDeletion,
    safety: viSafety,
    settings: viSettings,
    storage: viStorage,
    updater: viUpdater,
    messages: viMessages
  },
  'zh-CN': {
    common: zhCommon,
    sessions: zhSessions,
    inspector: zhInspector,
    deletion: zhDeletion,
    safety: zhSafety,
    settings: zhSettings,
    storage: zhStorage,
    updater: zhUpdater,
    messages: zhMessages
  }
}
