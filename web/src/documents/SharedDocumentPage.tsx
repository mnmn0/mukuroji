import { useEffect, useMemo, useState } from 'react'
import type { DocumentExportFormat } from '@mukuroji/contracts'
import { Link, useParams } from 'react-router'
import { BrandMark } from '../shared/ui/BrandMark'
import {
  createTranslator,
  getInitialLocale,
  localeOptions,
  setLocalePreference,
  type Locale,
} from '../shared/i18n/i18n'
import {
  exportPublicDocument,
  type PublicDocument,
} from './api'
import { usePublicDocument } from './queries/useDocumentQueries'
import { DocumentReadOnlyContent } from './ui/DocumentEditor'
import { WhiteboardReadOnly } from './ui/WhiteboardCanvas'

/**
 * SharedDocumentScreen の props です。
 */
export type SharedDocumentScreenProps = {
  /**
   * Public link から取得した read-only Document です。
   */
  document?: PublicDocument
  /**
   * Public share が export を許可しているかどうかです。
   */
  allowExport?: boolean
  /**
   * Storybook などで固定する locale です。
   */
  locale: Locale
  /**
   * Public API 読み込み中かどうかです。
   */
  isLoading?: boolean
  /**
   * Public API error message です。
   */
  errorMessage?: string
  /**
   * 表示言語変更 callback です。
   */
  onLocaleChange?: (locale: Locale) => void
  /**
   * Public content を kind-specific format で export する callback です。
   */
  onExport?: (format: DocumentExportFormat) => Promise<void>
}

/**
 * Expiring public link の token から Document を読み込む route page です。
 */
export function SharedDocumentPage() {
  const params = useParams()
  const token = params.shareToken ?? ''
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale())
  const {
    data: publicDocument,
    error,
    isLoading,
  } = usePublicDocument(token)

  const handleExport = async (format: DocumentExportFormat) => {
    const result = await exportPublicDocument(token, format)
    const link = globalThis.document.createElement('a')
    link.download = result.fileName
    const objectUrl =
      result.delivery === 'inline'
        ? URL.createObjectURL(
            new Blob([result.content], { type: result.mimeType }),
          )
        : undefined
    link.href =
      result.delivery === 'inline' ? objectUrl! : result.url
    link.rel = 'noopener noreferrer'
    link.referrerPolicy = 'no-referrer'
    link.click()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }

  return (
    <SharedDocumentScreen
      allowExport={publicDocument?.allowExport}
      document={publicDocument?.document}
      errorMessage={error instanceof Error ? error.message : undefined}
      isLoading={isLoading}
      locale={locale}
      onExport={handleExport}
      onLocaleChange={(nextLocale) => {
        setLocale(nextLocale)
        setLocalePreference(nextLocale)
      }}
    />
  )
}

/**
 * Public share 専用の簡素な BrandMark header と read-only content を描画します。
 */
export function SharedDocumentScreen({
  allowExport = false,
  document,
  errorMessage,
  isLoading = false,
  locale,
  onExport,
  onLocaleChange,
}: SharedDocumentScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [isExporting, setIsExporting] = useState(false)
  const exportFormat: DocumentExportFormat =
    document?.kind === 'whiteboard'
      ? 'svg'
      : document?.kind === 'page' || document?.kind === 'template'
        ? 'markdown'
        : 'json'

  useEffect(() => {
    globalThis.document.documentElement.lang = locale
    globalThis.document.title = `${document?.title ?? t('documents.public.title')} | ${t('app.title')}`
  }, [document?.title, locale, t])

  return (
    <div className="workbench-shell min-h-svh">
      <header className="sticky top-0 z-30 border-b border-[var(--workbench-border)] bg-white/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1240px] items-center gap-4 px-5 py-2.5 sm:px-8">
          <Link
            aria-label="mukuroji"
            className="inline-flex items-center gap-2.5 font-bold text-[var(--workbench-text)] no-underline"
            referrerPolicy="no-referrer"
            to="/"
          >
            <BrandMark small />
            <span>mukuroji</span>
          </Link>
          <span className="workbench-badge ml-2 hidden sm:inline-flex">
            {t('documents.public.readOnly')}
          </span>
          <label className="ml-auto inline-flex min-h-10 items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 text-xs font-semibold text-[var(--workbench-muted)]">
            <span className="sr-only">{t('language.aria')}</span>
            <span aria-hidden="true">◎</span>
            <select
              aria-label={t('language.aria')}
              className="border-0 bg-transparent font-semibold text-[var(--workbench-text)] outline-none"
              onChange={(event) =>
                onLocaleChange?.(event.target.value === 'en' ? 'en' : 'ja')
              }
              value={locale}
            >
              {localeOptions.map((option) => (
                <option key={option.locale} value={option.locale}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {allowExport && document && onExport ? (
            <button
              aria-label={t('documents.export.action')}
              className="workbench-button-secondary grid h-10 w-10 place-items-center sm:inline-flex sm:w-auto sm:px-4"
              disabled={isExporting}
              onClick={async () => {
                setIsExporting(true)
                try {
                  await onExport(exportFormat)
                } finally {
                  setIsExporting(false)
                }
              }}
              type="button"
            >
              <span aria-hidden="true" className="sm:hidden">↓</span>
              <span className="sr-only sm:not-sr-only">
                {t('documents.export.action')}
              </span>
            </button>
          ) : null}
          <Link
            className="workbench-button-secondary inline-flex min-h-10 items-center px-4 no-underline"
            referrerPolicy="no-referrer"
            to="/"
          >
            {t('documents.public.signIn')}
          </Link>
        </div>
      </header>

      {isLoading ? (
        <main className="grid min-h-[calc(100svh-65px)] place-items-center px-6 text-sm font-semibold text-[var(--workbench-muted)]">
          {t('documents.public.loading')}
        </main>
      ) : errorMessage || !document ? (
        <main className="mx-auto grid min-h-[calc(100svh-65px)] max-w-[720px] place-items-center px-6 py-16">
          <section className="workbench-panel w-full p-8 text-center">
            <span className="text-4xl" aria-hidden="true">
              ◌
            </span>
            <h1 className="mt-5 text-xl font-semibold text-[var(--workbench-text)]">
              {t('documents.public.unavailable')}
            </h1>
            <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {t('documents.public.unavailableDescription')}
            </p>
          </section>
        </main>
      ) : document.kind === 'whiteboard' ? (
        <main className="px-5 py-8 sm:px-8">
          <div className="mx-auto mb-6 max-w-[1120px]">
            <p className="workbench-eyebrow">
              {t('documents.kind.whiteboard')}
            </p>
            <h1 className="workbench-title mt-2 text-page-title">
              {document.title}
            </h1>
          </div>
          <WhiteboardReadOnly content={document.whiteboard} t={t} />
        </main>
      ) : document.kind === 'page' || document.kind === 'template' ? (
        <main>
          <DocumentReadOnlyContent document={document} t={t} />
        </main>
      ) : (
        <main className="mx-auto grid min-h-[calc(100svh-65px)] max-w-[720px] place-items-center px-6 py-16">
          <section className="workbench-panel w-full p-8 text-center">
            <h1 className="text-xl font-semibold text-[var(--workbench-text)]">
              {document.title}
            </h1>
            <p className="mt-2 text-sm text-[var(--workbench-muted)]">
              {t('documents.public.readOnly')}
            </p>
          </section>
        </main>
      )}
    </div>
  )
}
