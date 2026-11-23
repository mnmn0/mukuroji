import type { PublicProjectStatusReportResponse } from '@mukuroji/contracts'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { createTranslator, localeOptions, type Locale } from '../../shared/i18n/i18n'
import { BrandMark } from '../../shared/ui/BrandMark'
import { ProjectStatusReportDocument, useProjectStatusReportPrint } from './ProjectStatusReportDocument'

/** Props of {@link SharedProjectStatusReportScreen}. */
export type SharedProjectStatusReportScreenProps = {
  /** Report the link publishes, once loaded. */
  published?: PublicProjectStatusReportResponse
  /** Whether the report is loading. */
  isLoading?: boolean
  /** Whether the link is invalid, revoked, or expired. */
  isUnavailable?: boolean
  /** Whether the report could not be read for a temporary reason, such as a network error. */
  hasFailed?: boolean
  /** Whether a retry is running. */
  isRetrying?: boolean
  /** Reads the report again after a temporary failure. */
  onRetry?: () => void
  /** Language of the page chrome. */
  locale: Locale
  /** Changes the language of the page chrome. */
  onLocaleChange?: (locale: Locale) => void
  /** Downloads the PDF of the report. */
  onDownloadPdf?: () => Promise<void>
}

/**
 * Shows the read-only report a share link publishes to people outside the Workspace.
 *
 * @param props - Published report, load state, locale, and actions.
 * @returns The public page.
 */
export function SharedProjectStatusReportScreen({
  published,
  isLoading = false,
  isUnavailable = false,
  hasFailed = false,
  isRetrying = false,
  onRetry,
  locale,
  onLocaleChange,
  onDownloadPdf,
}: SharedProjectStatusReportScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { print, portal } = useProjectStatusReportPrint()
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${published?.report.projectName ?? t('projects.statusReport.title')} | ${t('app.title')}`
  }, [locale, published?.report.projectName, t])

  return (
    <div className="workbench-shell min-h-svh">
      {portal}
      <header className="sticky top-0 z-30 border-b border-[var(--workbench-border)] bg-surface/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1040px] flex-wrap items-center gap-2 px-4 py-2.5 sm:gap-4 sm:px-8">
          <Link
            aria-label="mukuroji"
            className="inline-flex items-center gap-2.5 font-bold text-[var(--workbench-text)] no-underline"
            referrerPolicy="no-referrer"
            to="/"
          >
            <BrandMark small />
            <span>mukuroji</span>
          </Link>
          <span className="workbench-badge ml-2 hidden sm:inline-flex">{t('projects.statusReport.public.readOnly')}</span>
          <label className="ml-auto inline-flex min-h-10 items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 text-xs font-semibold text-[var(--workbench-muted)]">
            <span className="sr-only">{t('language.aria')}</span>
            <select
              aria-label={t('language.aria')}
              className="border-0 bg-transparent font-semibold text-[var(--workbench-text)] outline-none"
              onChange={(event) => onLocaleChange?.(event.target.value === 'en' ? 'en' : 'ja')}
              value={locale}
            >
              {localeOptions.map((option) => (
                <option key={option.locale} value={option.locale}>{option.label}</option>
              ))}
            </select>
          </label>
          {published ? (
            <>
              <button className="workbench-button-secondary min-h-10 px-4" onClick={() => print(published.report)} type="button">
                {t('projects.statusReport.public.print')}
              </button>
              {onDownloadPdf ? (
                <button
                  className="workbench-button-secondary min-h-10 px-4"
                  disabled={isDownloading}
                  onClick={async () => {
                    setIsDownloading(true)
                    setDownloadFailed(false)
                    try {
                      await onDownloadPdf()
                    } catch {
                      setDownloadFailed(true)
                    } finally {
                      setIsDownloading(false)
                    }
                  }}
                  type="button"
                >
                  {t('projects.statusReport.public.download')}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      {isLoading ? (
        <main className="grid min-h-[calc(100svh-65px)] place-items-center px-6 text-sm font-semibold text-[var(--workbench-muted)]" role="status">
          {t('projects.statusReport.public.loading')}
        </main>
      ) : hasFailed ? (
        <main className="mx-auto grid min-h-[calc(100svh-65px)] max-w-[720px] place-items-center px-6 py-16">
          <section className="workbench-panel grid w-full justify-items-center gap-4 p-8 text-center" data-testid="shared-project-status-failed" role="alert">
            <h1 className="text-xl font-semibold text-[var(--workbench-text)]">{t('projects.statusReport.public.failed')}</h1>
            {onRetry ? (
              <button className="workbench-button-secondary min-h-10 px-4" disabled={isRetrying} onClick={onRetry} type="button">
                {t('projects.statusReport.public.retry')}
              </button>
            ) : null}
          </section>
        </main>
      ) : isUnavailable || !published ? (
        <main className="mx-auto grid min-h-[calc(100svh-65px)] max-w-[720px] place-items-center px-6 py-16">
          <section className="workbench-panel w-full p-8 text-center" data-testid="shared-project-status-unavailable">
            <h1 className="text-xl font-semibold text-[var(--workbench-text)]">{t('projects.statusReport.public.unavailable')}</h1>
          </section>
        </main>
      ) : (
        <main className="mx-auto max-w-[1040px] px-4 py-8 sm:px-8">
          {downloadFailed ? (
            <p className="mb-4 text-sm font-semibold text-red-700" role="alert">{t('projects.statusReport.public.downloadError')}</p>
          ) : null}
          <div className="workbench-panel p-6 sm:p-8">
            <ProjectStatusReportDocument report={published.report} />
          </div>
          <p className="mt-4 text-xs text-[var(--workbench-muted)]">
            {t('projects.statusReport.public.expiresAt').replace('{expiresAt}', published.expiresAt.slice(0, 10))}
          </p>
        </main>
      )}
    </div>
  )
}
