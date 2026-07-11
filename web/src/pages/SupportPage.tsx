import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import type { Locale, MessageKey } from '../i18n'
import { PublicPageShell } from './PublicPageShell'
import { copyTextToClipboard } from './publicPageUtils'

/**
 * サポート記事を分類するカテゴリ ID です。
 */
type SupportCategoryId = 'access' | 'workspace' | 'work' | 'security'

/**
 * サポートページで選択できるカテゴリです。
 */
type SupportCategory = {
  /**
   * URL と絞り込み状態に使うカテゴリ ID です。
   */
  id: SupportCategoryId
  /**
   * カテゴリ名の翻訳キーです。
   */
  labelKey: MessageKey
  /**
   * カテゴリ概要の翻訳キーです。
   */
  summaryKey: MessageKey
}

/**
 * 検索と accordion に表示するサポート記事です。
 */
type SupportArticle = {
  /**
   * 記事本文の翻訳キーです。
   */
  bodyKey: MessageKey
  /**
   * 記事を分類するカテゴリ ID です。
   */
  categoryId: SupportCategoryId
  /**
   * React の描画 key に使う記事 ID です。
   */
  id: string
  /**
   * 記事見出しの翻訳キーです。
   */
  titleKey: MessageKey
}

/**
 * サポートページの Storybook 初期状態です。
 */
type SupportPageProps = {
  /**
   * Storybook などで固定する初期 locale です。
   */
  initialLocale?: Locale
  /**
   * 初期表示する検索語です。
   */
  initialQuery?: string
}

/**
 * 問い合わせメモのコピー結果です。
 */
type CopyStatus = 'idle' | 'copied' | 'error'

/**
 * 問い合わせメモのコピー結果と、その時点の本文です。
 */
type CopyResult = {
  /**
   * コピー処理の結果です。
   */
  status: Exclude<CopyStatus, 'idle'>
  /**
   * 結果が対応する問い合わせメモ本文です。
   */
  value: string
}

const supportCategories = [
  {
    id: 'access',
    labelKey: 'public.support.category.access.title',
    summaryKey: 'public.support.category.access.description',
  },
  {
    id: 'workspace',
    labelKey: 'public.support.category.workspace.title',
    summaryKey: 'public.support.category.workspace.description',
  },
  {
    id: 'work',
    labelKey: 'public.support.category.work.title',
    summaryKey: 'public.support.category.work.description',
  },
  {
    id: 'security',
    labelKey: 'public.support.category.security.title',
    summaryKey: 'public.support.category.security.description',
  },
] as const satisfies readonly SupportCategory[]

const supportArticles = [
  {
    id: 'password-recovery',
    categoryId: 'access',
    titleKey: 'public.support.article.password.title',
    bodyKey: 'public.support.article.password.body',
  },
  {
    id: 'signed-out',
    categoryId: 'access',
    titleKey: 'public.support.article.signedOut.title',
    bodyKey: 'public.support.article.signedOut.body',
  },
  {
    id: 'missing-project',
    categoryId: 'workspace',
    titleKey: 'public.support.article.missingProject.title',
    bodyKey: 'public.support.article.missingProject.body',
  },
  {
    id: 'member-role',
    categoryId: 'workspace',
    titleKey: 'public.support.article.role.title',
    bodyKey: 'public.support.article.role.body',
  },
  {
    id: 'issue-read-only',
    categoryId: 'work',
    titleKey: 'public.support.article.readOnly.title',
    bodyKey: 'public.support.article.readOnly.body',
  },
  {
    id: 'task-sync',
    categoryId: 'work',
    titleKey: 'public.support.article.sync.title',
    bodyKey: 'public.support.article.sync.body',
  },
  {
    id: 'safe-contact',
    categoryId: 'security',
    titleKey: 'public.support.article.safeContact.title',
    bodyKey: 'public.support.article.safeContact.body',
  },
  {
    id: 'privacy-request',
    categoryId: 'security',
    titleKey: 'public.support.article.privacy.title',
    bodyKey: 'public.support.article.privacy.body',
  },
] as const satisfies readonly SupportArticle[]

/**
 * FAQ検索、カテゴリ絞り込み、正式窓口へ渡す問い合わせメモを提供します。
 */
export function SupportPage({
  initialLocale,
  initialQuery = '',
}: SupportPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const categoryFromUrl = readSupportCategory(searchParams.get('topic'))
  const activeCategory = categoryFromUrl ?? 'all'
  const [query, setQuery] = useState(initialQuery)
  const [copyResult, setCopyResult] = useState<CopyResult | undefined>()

  return (
    <PublicPageShell
      initialLocale={initialLocale}
      titleKey="public.support.title"
      onLocaleChange={() => setCopyResult(undefined)}
    >
      {({ locale, t }) => {
        const localeTag = locale === 'ja' ? 'ja-JP' : 'en-US'
        const normalizedQuery = query.trim().toLocaleLowerCase(localeTag)
        const filteredArticles = supportArticles.filter((article) => {
          const matchesCategory = activeCategory === 'all' || article.categoryId === activeCategory
          const searchableText = `${t(article.titleKey)} ${t(article.bodyKey)}`.toLocaleLowerCase(localeTag)

          return matchesCategory && (!normalizedQuery || searchableText.includes(normalizedQuery))
        })
        const selectedCategoryLabel = activeCategory === 'all'
          ? t('public.support.category.all')
          : t(
            supportCategories.find((category) => category.id === activeCategory)?.labelKey ??
              'public.support.category.all',
          )
        const contactTemplate = t('public.support.contact.template').replace(
          '{category}',
          selectedCategoryLabel,
        )
        const copyStatus: CopyStatus = copyResult?.value === contactTemplate
          ? copyResult.status
          : 'idle'

        const handleCategoryChange = (categoryId: SupportCategoryId | 'all') => {
          setCopyResult(undefined)

          const nextSearchParams = new URLSearchParams(searchParams)
          if (categoryId === 'all') {
            nextSearchParams.delete('topic')
          } else {
            nextSearchParams.set('topic', categoryId)
          }
          setSearchParams(nextSearchParams, { replace: true })
        }

        const handleCopy = async () => {
          try {
            await copyTextToClipboard(contactTemplate)
            setCopyResult({ status: 'copied', value: contactTemplate })
          } catch {
            setCopyResult({ status: 'error', value: contactTemplate })
          }
        }

        return (
          <div>
            <section className="border-b border-[var(--workbench-border)] bg-white">
              <div className="mx-auto w-full max-w-[1120px] px-5 py-12 sm:px-8 sm:py-16 lg:py-20">
                <p className="workbench-eyebrow mb-4">{t('public.support.eyebrow')}</p>
                <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-end lg:gap-14">
                  <div>
                    <h1 className="workbench-title m-0 max-w-[720px] text-[clamp(2.2rem,5vw,4.8rem)] leading-[1.02] tracking-[-0.04em]">
                      {t('public.support.title')}
                    </h1>
                    <p className="mb-0 mt-6 max-w-[680px] text-base font-medium leading-8 text-[var(--workbench-muted)] sm:text-lg">
                      {t('public.support.intro')}
                    </p>
                  </div>

                  <label className="grid gap-2 text-sm font-bold text-[var(--workbench-text)]" htmlFor="support-search">
                    {t('public.support.search.label')}
                    <span className="relative block">
                      <svg
                        aria-hidden="true"
                        className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 fill-none stroke-[var(--workbench-muted)] stroke-2"
                        viewBox="0 0 24 24"
                      >
                        <circle cx="10.5" cy="10.5" r="6.5" />
                        <path d="m15.5 15.5 5 5" />
                      </svg>
                      <input
                        className="workbench-input min-h-14 w-full pl-12 pr-4 text-base"
                        id="support-search"
                        placeholder={t('public.support.search.placeholder')}
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </span>
                  </label>
                </div>
              </div>
            </section>

            <div className="mx-auto w-full max-w-[1120px] px-5 py-12 sm:px-8 sm:py-16">
              <section aria-labelledby="support-categories-title">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="workbench-eyebrow mb-2">{t('public.support.categories.eyebrow')}</p>
                    <h2 className="m-0 text-2xl font-bold tracking-[-0.02em] text-[var(--workbench-text)]" id="support-categories-title">
                      {t('public.support.categories.title')}
                    </h2>
                  </div>
                  <button
                    aria-pressed={activeCategory === 'all'}
                    className="workbench-button-secondary min-h-10 cursor-pointer px-4 aria-pressed:border-[var(--workbench-primary)] aria-pressed:bg-[#e5f7f4] aria-pressed:text-[var(--workbench-primary)]"
                    type="button"
                    onClick={() => handleCategoryChange('all')}
                  >
                    {t('public.support.category.all')}
                  </button>
                </div>

                <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {supportCategories.map((category) => (
                    <button
                      aria-pressed={activeCategory === category.id}
                      className="workbench-panel group min-h-[150px] cursor-pointer p-5 text-left transition-[border-color,background-color,transform] duration-150 hover:-translate-y-0.5 hover:border-[#99d7cf] aria-pressed:border-[var(--workbench-primary)] aria-pressed:bg-[#eefaf7]"
                      key={category.id}
                      type="button"
                      onClick={() => handleCategoryChange(category.id)}
                    >
                      <span className="mb-5 block h-1 w-9 rounded-full bg-[var(--workbench-border-strong)] transition-colors group-hover:bg-[var(--workbench-primary)] group-aria-pressed:bg-[var(--workbench-primary)]" />
                      <strong className="block text-base text-[var(--workbench-text)]">
                        {t(category.labelKey)}
                      </strong>
                      <span className="mt-2 block text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                        {t(category.summaryKey)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="mt-14" aria-labelledby="support-answers-title">
                <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--workbench-border)] pb-4">
                  <h2 className="m-0 text-2xl font-bold tracking-[-0.02em] text-[var(--workbench-text)]" id="support-answers-title">
                    {t('public.support.answers.title')}
                  </h2>
                  <span aria-live="polite" className="workbench-badge" role="status">
                    {t(
                      filteredArticles.length === 1
                        ? 'public.support.answers.countOne'
                        : 'public.support.answers.count',
                    ).replace('{count}', String(filteredArticles.length))}
                  </span>
                </div>

                {filteredArticles.length > 0 ? (
                  <div className="divide-y divide-[var(--workbench-border)]">
                    {filteredArticles.map((article) => (
                      <details className="group py-1" key={article.id}>
                        <summary className="grid min-h-16 cursor-pointer list-none grid-cols-[1fr_auto] items-center gap-5 rounded-md px-2 py-4 text-base font-bold text-[var(--workbench-text)] hover:bg-white [&::-webkit-details-marker]:hidden">
                          <span>{t(article.titleKey)}</span>
                          <span className="grid h-8 w-8 place-items-center rounded-full border border-[var(--workbench-border)] bg-white text-xl font-normal text-[var(--workbench-muted)] transition-transform group-open:rotate-45" aria-hidden="true">
                            +
                          </span>
                        </summary>
                        <p className="mb-5 ml-2 mt-0 max-w-[76ch] pr-12 text-sm font-medium leading-7 text-[var(--workbench-muted)]">
                          {t(article.bodyKey)}
                        </p>
                      </details>
                    ))}
                  </div>
                ) : (
                  <div className="workbench-panel-muted mt-6 p-8 text-center">
                    <p className="m-0 text-lg font-bold text-[var(--workbench-text)]">
                      {t('public.support.empty.title')}
                    </p>
                    <p className="mb-0 mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                      {t('public.support.empty.description')}
                    </p>
                    <button className="workbench-button-secondary mt-5 min-h-10 cursor-pointer px-4" type="button" onClick={() => {
                      setQuery('')
                      handleCategoryChange('all')
                    }}>
                      {t('public.support.empty.reset')}
                    </button>
                  </div>
                )}
              </section>

              <section className="mt-16 overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-sidebar)] text-white" aria-labelledby="support-contact-title">
                <div className="grid lg:grid-cols-[minmax(0,0.8fr)_minmax(420px,1.2fr)]">
                  <div className="p-7 sm:p-9">
                    <p className="m-0 text-xs font-bold uppercase tracking-[0.08em] text-[#91d8ce]">
                      {t('public.support.contact.eyebrow')}
                    </p>
                    <h2 className="mb-0 mt-3 text-2xl font-bold tracking-[-0.02em]" id="support-contact-title">
                      {t('public.support.contact.title')}
                    </h2>
                    <p className="mb-0 mt-4 text-sm font-medium leading-7 text-[#c3d0cc]">
                      {t('public.support.contact.description')}
                    </p>
                    <div className="mt-6 grid gap-3 text-sm font-semibold text-[#e7efec]">
                      <span className="flex gap-3"><span className="text-[#91d8ce]">•</span>{t('public.support.contact.admin')}</span>
                      <span className="flex gap-3"><span className="text-[#91d8ce]">•</span>{t('public.support.contact.contract')}</span>
                      <span className="flex gap-3"><span className="text-[#91d8ce]">•</span>{t('public.support.contact.security')}</span>
                    </div>
                  </div>

                  <div className="border-t border-white/15 bg-white/[0.06] p-7 sm:p-9 lg:border-l lg:border-t-0">
                    <label className="block text-sm font-bold text-white" htmlFor="support-contact-template">
                      {t('public.support.contact.templateLabel')}
                    </label>
                    <textarea
                      className="mt-3 min-h-[190px] w-full resize-y rounded-lg border border-white/20 bg-white px-4 py-3 text-sm font-medium leading-6 text-[var(--workbench-text)] outline-none focus:border-[#91d8ce] focus:shadow-[0_0_0_4px_rgba(145,216,206,0.16)]"
                      id="support-contact-template"
                      readOnly
                      value={contactTemplate}
                    />
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <button className="min-h-11 cursor-pointer rounded-md border border-[#91d8ce] bg-[#d9f8ed] px-4 text-sm font-bold text-[#0b625c] hover:bg-white" type="button" onClick={handleCopy}>
                        {copyStatus === 'copied' ? t('public.copy.copied') : t('public.support.contact.copyAction')}
                      </button>
                      <Link className="inline-flex min-h-11 items-center text-sm font-bold text-white underline decoration-white/40 underline-offset-4 hover:decoration-white" to="/privacy">
                        {t('public.support.contact.privacyAction')}
                      </Link>
                    </div>
                    <p className="sr-only" aria-live="polite" role="status">
                      {copyStatus === 'copied'
                        ? t('public.copy.copied')
                        : copyStatus === 'error'
                          ? t('public.copy.error')
                          : ''}
                    </p>
                    {copyStatus === 'error' ? (
                      <p className="mb-0 mt-3 text-sm font-semibold text-[#fecaca]">
                        {t('public.copy.error')}
                      </p>
                    ) : null}
                  </div>
                </div>
              </section>
            </div>
          </div>
        )
      }}
    </PublicPageShell>
  )
}

/**
 * URL query の値がサポートカテゴリ ID ならその値を返します。
 */
function readSupportCategory(value: string | null): SupportCategoryId | undefined {
  return supportCategories.some((category) => category.id === value)
    ? value as SupportCategoryId
    : undefined
}
