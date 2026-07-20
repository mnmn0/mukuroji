import { Link } from 'react-router'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { PublicPageShell } from './PublicPageShell'

/**
 * 公開する法務文書の1章を構成する翻訳キーです。
 */
export type LegalSection = {
  /**
   * 目次リンクと本文見出しを接続する anchor ID です。
   */
  id: string
  /**
   * 章内の段落として順に表示する翻訳キーです。
   */
  paragraphKeys: readonly MessageKey[]
  /**
   * 章見出しの翻訳キーです。
   */
  titleKey: MessageKey
}

/**
 * 公開する法務文書ページの props です。
 */
type PublicLegalPageProps = {
  /**
   * 見出し上部に表示する分類ラベルの翻訳キーです。
   */
  eyebrowKey: MessageKey
  /**
   * Storybook などで固定する初期 locale です。
   */
  initialLocale?: Locale
  /**
   * 文書冒頭の要約文の翻訳キーです。
   */
  introKey: MessageKey
  /**
   * 本文に表示する章の一覧です。
   */
  sections: readonly LegalSection[]
  /**
   * ページ見出しと document title に使う翻訳キーです。
   */
  titleKey: MessageKey
  /**
   * 文書の最終更新日を示す翻訳キーです。
   */
  updatedKey: MessageKey
}

/**
 * 目次と読み幅を抑えた本文を持つ公開法務文書ページを描画します。
 */
export function PublicLegalPage({
  eyebrowKey,
  initialLocale,
  introKey,
  sections,
  titleKey,
  updatedKey,
}: PublicLegalPageProps) {
  return (
    <PublicPageShell initialLocale={initialLocale} titleKey={titleKey}>
      {({ t }) => (
        <div className="mx-auto w-full max-w-[1120px] px-5 py-12 sm:px-8 sm:py-16 lg:py-20">
          <header className="border-b border-[var(--workbench-border)] pb-10 sm:pb-12">
            <p className="workbench-eyebrow mb-4">{t(eyebrowKey)}</p>
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-end lg:gap-14">
              <div>
                <h1 className="workbench-title m-0 max-w-[760px] text-[clamp(2.2rem,5vw,4.8rem)] leading-[1.02] tracking-[-0.04em]">
                  {t(titleKey)}
                </h1>
                <p className="mb-0 mt-6 max-w-[720px] text-base font-medium leading-8 text-[var(--workbench-muted)] sm:text-lg">
                  {t(introKey)}
                </p>
              </div>
              <div className="workbench-panel-muted p-4 lg:text-right">
                <span className="block text-app-micro font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                  {t('public.legal.updatedLabel')}
                </span>
                <time className="mt-1 block text-sm font-bold text-[var(--workbench-text)]" dateTime="2026-07-11">
                  {t(updatedKey)}
                </time>
              </div>
            </div>
            <div className="mt-8 rounded-lg border border-[#f4d6a6] bg-[#fffaf0] px-5 py-4 text-[#7a4b0c]" role="note">
              <strong className="block text-sm">{t('public.legal.draftTitle')}</strong>
              <p className="mb-0 mt-1 text-sm font-medium leading-6">
                {t('public.legal.draftDescription')}
              </p>
            </div>
          </header>

          <div className="mt-10 grid gap-10 lg:grid-cols-[250px_minmax(0,1fr)] lg:gap-14">
            <aside className="lg:sticky lg:top-28 lg:self-start">
              <nav aria-label={t('public.legal.contentsAria')} className="workbench-panel overflow-hidden">
                <p className="m-0 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3 text-app-meta font-bold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
                  {t('public.legal.contents')}
                </p>
                <ol className="m-0 grid list-none p-2">
                  {sections.map((section, index) => (
                    <li key={section.id}>
                      <a
                        className="grid min-h-10 grid-cols-[24px_1fr] items-start gap-2 rounded-md px-2 py-2 text-sm font-semibold leading-5 text-[var(--workbench-muted)] no-underline hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-text)]"
                        href={`#${section.id}`}
                      >
                        <span aria-hidden="true" className="font-mono text-xs leading-5 text-[var(--workbench-primary)]">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span>{t(section.titleKey)}</span>
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            </aside>

            <article className="min-w-0">
              {sections.map((section, index) => (
                <section
                  className="scroll-mt-28 border-b border-[var(--workbench-border)] py-9 first:pt-0 last:border-b-0 last:pb-0"
                  id={section.id}
                  key={section.id}
                >
                  <div className="grid gap-3 sm:grid-cols-[46px_minmax(0,1fr)] sm:gap-5">
                    <span className="font-mono text-sm font-bold text-[var(--workbench-primary)]" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div>
                      <h2 className="m-0 text-xl font-bold tracking-[-0.015em] text-[var(--workbench-text)] sm:text-2xl">
                        {t(section.titleKey)}
                      </h2>
                      <div className="mt-4 max-w-[72ch] space-y-4 text-[0.98rem] font-medium leading-8 text-[var(--workbench-muted)]">
                        {section.paragraphKeys.map((paragraphKey) => (
                          <p className="m-0" key={paragraphKey}>{t(paragraphKey)}</p>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              ))}

              <section className="mt-10 rounded-lg border border-[#99d7cf] bg-[#eefaf7] p-6 sm:flex sm:items-center sm:justify-between sm:gap-7">
                <div>
                  <h2 className="m-0 text-lg font-bold text-[var(--workbench-text)]">
                    {t('public.legal.questionTitle')}
                  </h2>
                  <p className="mb-0 mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                    {t('public.legal.questionDescription')}
                  </p>
                </div>
                <Link
                  className="workbench-button-primary mt-5 inline-flex min-h-11 shrink-0 items-center justify-center px-4 no-underline sm:mt-0"
                  to="/support?topic=security"
                >
                  {t('public.legal.supportAction')}
                </Link>
              </section>
            </article>
          </div>
        </div>
      )}
    </PublicPageShell>
  )
}
