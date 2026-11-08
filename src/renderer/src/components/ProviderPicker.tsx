import { useEffect, useId, useRef, type KeyboardEvent, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { appBrand } from '../../../shared/appIdentity'
import { PROVIDERS } from '../../../shared/types'
import { chooseProvider, useAppState } from '../stores/appStore'
import { PROVIDER_NAMES, ProviderLogo } from './BrandLogos'
import { AppMark } from './Icons'

/** The first screen: whose sessions to manage, Claude's or Codex's. */
export function ProviderPicker(): ReactElement {
  const { t } = useTranslation()
  const appInfo = useAppState((s) => s.appInfo)
  const brand = appInfo ? appBrand(appInfo.distribution) : null
  const titleId = useId()
  const cards = useRef<HTMLDivElement>(null)

  // Ready for the keyboard: Enter opens the first tool, the arrows move between them.
  useEffect(() => {
    cards.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    const list = [...(cards.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
    list[(at + step + list.length) % list.length]?.focus()
  }

  return (
    <main className="picker" aria-labelledby={titleId}>
      <div className="picker-inner">
        <div className="picker-brand">
          <AppMark size={30} />
          <div>
            <div className="identity-name">{brand?.short}</div>
            <div className="identity-sub">{brand?.sub}</div>
          </div>
        </div>
        <h1 className="picker-title" id={titleId}>
          {t('common:picker.title')}
        </h1>
        <p className="picker-subtitle">{t('common:picker.subtitle')}</p>
        <div className="picker-cards" ref={cards} onKeyDown={onKey}>
          {PROVIDERS.map((p) => (
            <button key={p} className={`picker-card ${p}`} data-provider={p} onClick={() => void chooseProvider(p)} aria-label={t('common:picker.open', { name: PROVIDER_NAMES[p] })}>
              <span className="picker-logo">
                <ProviderLogo provider={p} size={52} />
              </span>
              <span className="picker-name">{PROVIDER_NAMES[p]}</span>
              <span className="picker-desc">{t(`common:picker.${p}Desc`)}</span>
            </button>
          ))}
        </div>
        <p className="picker-legal">
          {t('common:app.disclaimer')}
          <br />
          {t('common:picker.trademark')}
        </p>
      </div>
    </main>
  )
}
