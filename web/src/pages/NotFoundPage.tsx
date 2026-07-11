import { Link, useLocation } from 'react-router'
import type { Locale } from '../i18n'
import { PublicPageShell } from './PublicPageShell'

/**
 * 404ページの Storybook 初期状態です。
 */
type NotFoundPageProps = {
  /**
   * Storybook などで固定する初期 locale です。
   */
  initialLocale?: Locale
}

/**
 * 不明なURLをログインへ押し戻さず、現在地と安全な帰還先を明示します。
 */
export function NotFoundPage({ initialLocale }: NotFoundPageProps = {}) {
  const location = useLocation()

  return (
    <PublicPageShell initialLocale={initialLocale} titleKey="public.notFound.title">
      {({ t }) => (
        <div className="mx-auto grid min-h-[calc(100svh-230px)] w-full max-w-[1120px] items-center gap-10 px-5 py-14 sm:px-8 lg:grid-cols-[0.82fr_1.18fr] lg:gap-16 lg:py-20">
          <div aria-hidden="true" className="relative select-none overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-sidebar)] px-7 py-12 text-center sm:px-10 sm:py-16">
            <div className="absolute inset-x-0 top-0 h-1 bg-[#91d8ce]" />
            <span className="block font-mono text-[clamp(5rem,17vw,10rem)] font-bold leading-none tracking-[-0.08em] text-white">
              404
            </span>
            <span className="mt-5 inline-flex rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 font-mono text-xs text-[#c3d0cc]">
              route_not_found
            </span>
          </div>

          <section aria-labelledby="not-found-title">
            <p className="workbench-eyebrow mb-4">{t('public.notFound.eyebrow')}</p>
            <h1 className="workbench-title m-0 max-w-[680px] text-[clamp(2.2rem,5vw,4.6rem)] leading-[1.03] tracking-[-0.04em]" id="not-found-title">
              {t('public.notFound.title')}
            </h1>
            <p className="mb-0 mt-6 max-w-[620px] text-base font-medium leading-8 text-[var(--workbench-muted)] sm:text-lg">
              {t('public.notFound.description')}
            </p>

            <div className="mt-6 rounded-lg border border-[var(--workbench-border)] bg-white px-4 py-3">
              <span className="block text-app-micro font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                {t('public.notFound.requestedPath')}
              </span>
              <code className="mt-1 block break-all font-mono text-sm font-semibold text-[var(--workbench-text)]">
                {location.pathname}
              </code>
            </div>

            <div className="mt-7 flex flex-wrap gap-3">
              <Link className="workbench-button-primary inline-flex min-h-12 items-center justify-center px-5 no-underline" to="/">
                {t('public.notFound.loginAction')}
              </Link>
              <Link className="workbench-button-secondary inline-flex min-h-12 items-center justify-center px-5 no-underline" to="/support">
                {t('public.notFound.supportAction')}
              </Link>
            </div>

            <div className="mt-9 grid gap-3 sm:grid-cols-2">
              <Link className="workbench-panel group p-4 no-underline hover:border-[#99d7cf]" to="/privacy">
                <strong className="block text-sm text-[var(--workbench-text)] group-hover:text-[var(--workbench-primary)]">
                  {t('public.notFound.privacyTitle')}
                </strong>
                <span className="mt-1 block text-app-meta leading-5 text-[var(--workbench-muted)]">
                  {t('public.notFound.privacyDescription')}
                </span>
              </Link>
              <Link className="workbench-panel group p-4 no-underline hover:border-[#99d7cf]" to="/terms">
                <strong className="block text-sm text-[var(--workbench-text)] group-hover:text-[var(--workbench-primary)]">
                  {t('public.notFound.termsTitle')}
                </strong>
                <span className="mt-1 block text-app-meta leading-5 text-[var(--workbench-muted)]">
                  {t('public.notFound.termsDescription')}
                </span>
              </Link>
            </div>
          </section>
        </div>
      )}
    </PublicPageShell>
  )
}
