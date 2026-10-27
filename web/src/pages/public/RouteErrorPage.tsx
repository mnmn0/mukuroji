import { Link } from 'react-router'
import type { Locale } from '../../shared/i18n/i18n'
import { PublicPageShell } from '../../features/public-site/ui/PublicPageShell'

/**
 * Props accepted by the route error page.
 */
type RouteErrorPageProps = {
  /** Initial locale, fixed in Storybook. */
  initialLocale?: Locale
  /** Reloads the application; a full page load by default. */
  onReload?: () => void
}

/**
 * Shown when a page fails to load or render, such as when its chunk cannot be downloaded.
 *
 * Reloading fetches the current application, which also recovers a tab that still references
 * chunks replaced by a deploy.
 *
 * @param props - Initial locale and the reload action.
 * @returns The error page with reload and login actions.
 */
export function RouteErrorPage({
  initialLocale,
  onReload = () => window.location.reload(),
}: RouteErrorPageProps = {}) {
  return (
    <PublicPageShell initialLocale={initialLocale} titleKey="public.routeError.title">
      {({ t }) => (
        <div className="mx-auto grid min-h-[calc(100svh-230px)] w-full max-w-[760px] content-center px-5 py-14 sm:px-8 lg:py-20">
          <section aria-labelledby="route-error-title" role="alert">
            <p className="workbench-eyebrow mb-4">{t('public.routeError.eyebrow')}</p>
            <h1 className="workbench-title m-0 text-[clamp(2rem,4.5vw,3.6rem)] leading-[1.05] tracking-[-0.04em]" id="route-error-title">
              {t('public.routeError.title')}
            </h1>
            <p className="mb-0 mt-6 text-base font-medium leading-8 text-[var(--workbench-muted)] sm:text-lg">
              {t('public.routeError.description')}
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <button className="workbench-button-primary inline-flex min-h-12 items-center justify-center px-5" onClick={onReload} type="button">
                {t('public.routeError.reloadAction')}
              </button>
              <Link className="workbench-button-secondary inline-flex min-h-12 items-center justify-center px-5 no-underline" to="/">
                {t('public.routeError.loginAction')}
              </Link>
            </div>
          </section>
        </div>
      )}
    </PublicPageShell>
  )
}
