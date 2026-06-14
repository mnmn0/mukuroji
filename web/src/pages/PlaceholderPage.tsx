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
    <main className="grid min-h-svh place-items-center bg-[var(--surface)] px-5 py-10">
      <section className="w-full max-w-[520px] rounded-lg border border-[#d9e1eb] bg-white/95 p-8 text-center shadow-[0_28px_60px_rgba(28,53,88,0.08)]">
        <div className="inline-flex items-center justify-center gap-3 text-2xl font-extrabold text-[var(--ink)]">
          <BrandMark />
          <span>mukuroji</span>
        </div>
        <h1 className="mt-8 text-placeholder-title font-black text-[var(--ink)]">
          {t(titleKey)}
        </h1>
        <p className="mt-4 text-base font-bold leading-relaxed text-[var(--muted)]">
          {t(descriptionKey)}
        </p>
        <Link
          className="mt-8 inline-flex min-h-12 items-center justify-center rounded-lg bg-linear-to-br from-[#006cff] to-[#004ec8] px-6 font-black text-white no-underline shadow-[0_14px_30px_rgba(0,89,216,0.22)] transition-[transform,box-shadow,filter] duration-150 hover:-translate-y-px hover:saturate-[1.08] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[rgba(0,101,238,0.22)]"
          to="/"
        >
          {t('placeholder.backToLogin')}
        </Link>
      </section>
    </main>
  )
}
