import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { BrandMark } from '../components/BrandMark'
import {
  createTranslator,
  getInitialLocale,
  type Locale,
  type MessageKey,
} from '../i18n'

/**
 * 未実装ページの共通 placeholder に渡す i18n key です。
 */
type PlaceholderPageProps = {
  /**
   * ページ見出しとして表示する翻訳キーです。
   */
  titleKey: MessageKey
  /**
   * ページ説明文として表示する翻訳キーです。
   */
  descriptionKey: MessageKey
}

/**
 * 後続実装待ちのページに表示する共通 placeholder 画面です。
 */
export function PlaceholderPage({
  titleKey,
  descriptionKey,
}: PlaceholderPageProps) {
  const [locale] = useState<Locale>(() => getInitialLocale())
  const t = useMemo(() => createTranslator(locale), [locale])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${t(titleKey)} | ${t('app.title')}`
  }, [locale, t, titleKey])

  return (
    <main className="workbench-shell grid min-h-svh place-items-center px-5 py-10">
      <section className="workbench-panel w-full max-w-[520px] p-8 text-center">
        <div className="inline-flex items-center justify-center gap-3 text-2xl font-semibold text-[var(--workbench-text)]">
          <BrandMark />
          <span>mukuroji</span>
        </div>
        <h1 className="workbench-title mt-8 text-placeholder-title">
          {t(titleKey)}
        </h1>
        <p className="mt-4 text-base font-medium leading-relaxed text-[var(--workbench-muted)]">
          {t(descriptionKey)}
        </p>
        <Link
          className="workbench-button-primary mt-8 inline-flex min-h-12 items-center justify-center px-6 no-underline"
          to="/"
        >
          {t('placeholder.backToLogin')}
        </Link>
      </section>
    </main>
  )
}
