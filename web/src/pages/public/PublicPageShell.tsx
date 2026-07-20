import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { Link, NavLink } from 'react-router'
import { BrandMark } from '../../shared/ui/BrandMark'
import {
  createTranslator,
  getInitialLocale,
  localeOptions,
  setLocalePreference,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'

/**
 * 公開ページの描画関数へ渡す locale と翻訳関数です。
 */
export type PublicPageContext = {
  /**
   * 現在選択されている表示言語です。
   */
  locale: Locale
  /**
   * 現在の表示言語で文言を返す翻訳関数です。
   */
  t: ReturnType<typeof createTranslator>
}

/**
 * 公開ページ共通 shell の props です。
 */
type PublicPageShellProps = {
  /**
   * Locale selector に表示できる locale 一覧です。
   */
  availableLocales?: readonly Locale[]
  /**
   * 現在の locale を受け取ってページ本文を返す描画関数です。
   */
  children: (context: PublicPageContext) => ReactNode
  /**
   * Storybook などで固定する初期 locale です。
   */
  initialLocale?: Locale
  /**
   * 親ページが locale を管理する場合の controlled value です。
   */
  locale?: Locale
  /**
   * 表示言語を変更したときにページ固有の一時状態を同期する callback です。
   */
  onLocaleChange?: (locale: Locale) => void
  /**
   * document title に使うページ見出しの翻訳キーです。
   */
  titleKey: MessageKey
}

/**
 * 未ログイン利用者向けページで共有するヘッダー、言語切替、フッターを描画します。
 */
export function PublicPageShell({
  availableLocales,
  children,
  initialLocale,
  locale: controlledLocale,
  onLocaleChange,
  titleKey,
}: PublicPageShellProps) {
  const [uncontrolledLocale, setUncontrolledLocale] = useState<Locale>(() => initialLocale ?? getInitialLocale())
  const locale = controlledLocale ?? uncontrolledLocale
  const t = useMemo(() => createTranslator(locale), [locale])
  const availableLocaleOptions = localeOptions.filter((option) =>
    availableLocales?.includes(option.locale) ?? true
  )

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${t(titleKey)} | ${t('app.title')}`
  }, [locale, t, titleKey])

  const handleLocaleChange = (value: string) => {
    const nextLocale = value === 'en' ? 'en' : 'ja'
    if (!availableLocaleOptions.some((option) => option.locale === nextLocale)) return
    if (controlledLocale === undefined) {
      setUncontrolledLocale(nextLocale)
    }
    setLocalePreference(nextLocale)
    onLocaleChange?.(nextLocale)
  }

  return (
    <div className="workbench-shell min-h-svh">
      <header className="sticky top-0 z-30 border-b border-[var(--workbench-border)] bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex min-h-16 w-full max-w-[1240px] items-center gap-4 px-5 py-2.5 sm:px-8">
          <Link
            aria-label="mukuroji"
            className="inline-flex shrink-0 items-center gap-2.5 text-lg font-bold tracking-[-0.01em] text-[var(--workbench-text)] no-underline"
            to="/"
          >
            <BrandMark small />
            <span className="hidden sm:inline">mukuroji</span>
          </Link>

          <nav
            aria-label={t('public.nav.aria')}
            className="ml-auto hidden items-center gap-1 md:flex"
          >
            <PublicNavLink to="/privacy">{t('public.nav.privacy')}</PublicNavLink>
            <PublicNavLink to="/terms">{t('public.nav.terms')}</PublicNavLink>
            <PublicNavLink to="/support">{t('public.nav.support')}</PublicNavLink>
          </nav>

          <label className="ml-auto inline-flex min-h-10 items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 text-app-meta font-semibold text-[var(--workbench-muted)] md:ml-2">
            <span className="sr-only">{t('language.aria')}</span>
            <svg
              aria-hidden="true"
              className="h-4 w-4 fill-none stroke-current stroke-[1.8]"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="8.5" />
              <path d="M3.8 12h16.4M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17" />
            </svg>
            <select
              aria-label={t('language.aria')}
              className="cursor-pointer border-0 bg-transparent font-semibold text-[var(--workbench-text)] outline-none"
              value={locale}
              onChange={(event) => handleLocaleChange(event.target.value)}
            >
              {availableLocaleOptions.map((option) => (
                <option key={option.locale} value={option.locale}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <Link
            className="workbench-button-primary inline-flex min-h-10 shrink-0 items-center justify-center px-4 no-underline"
            to="/"
          >
            {t('public.nav.login')}
          </Link>
        </div>

        <nav
          aria-label={t('public.nav.mobileAria')}
          className="mx-auto flex w-full max-w-[1240px] gap-1 overflow-x-auto border-t border-[var(--workbench-border)] px-4 py-1.5 md:hidden"
        >
          <PublicNavLink to="/privacy">{t('public.nav.privacy')}</PublicNavLink>
          <PublicNavLink to="/terms">{t('public.nav.terms')}</PublicNavLink>
          <PublicNavLink to="/support">{t('public.nav.support')}</PublicNavLink>
        </nav>
      </header>

      <main>{children({ locale, t })}</main>

      <footer className="border-t border-[var(--workbench-border)] bg-white">
        <div className="mx-auto grid w-full max-w-[1240px] gap-7 px-5 py-9 sm:px-8 md:grid-cols-[1fr_auto] md:items-end">
          <div className="max-w-[520px]">
            <div className="inline-flex items-center gap-2.5 font-bold text-[var(--workbench-text)]">
              <BrandMark small />
              <span>mukuroji</span>
            </div>
            <p className="mb-0 mt-3 text-sm leading-6 text-[var(--workbench-muted)]">
              {t('public.footer.description')}
            </p>
          </div>
          <div className="md:text-right">
            <nav className="flex flex-wrap gap-x-5 gap-y-2 md:justify-end" aria-label={t('footer.aria')}>
              <PublicFooterLink to="/privacy">{t('footer.privacy')}</PublicFooterLink>
              <PublicFooterLink to="/terms">{t('footer.terms')}</PublicFooterLink>
              <PublicFooterLink to="/support">{t('footer.support')}</PublicFooterLink>
            </nav>
            <p className="mb-0 mt-4 text-app-meta text-[var(--workbench-muted)]">
              {t('footer.copyright')}
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}

/**
 * 公開ページヘッダーのナビゲーションリンクに渡す props です。
 */
type PublicNavLinkProps = {
  /**
   * リンクに表示する文言です。
   */
  children: ReactNode
  /**
   * React Router の遷移先です。
   */
  to: string
}

/**
 * 公開ページヘッダーで使うコンパクトなナビゲーションリンクです。
 */
function PublicNavLink({ children, to }: PublicNavLinkProps) {
  return (
    <NavLink
      className={({ isActive }) =>
        `inline-flex min-h-10 shrink-0 items-center rounded-md px-3 text-sm font-semibold no-underline transition-colors duration-150 hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-text)] ${isActive ? 'bg-[var(--workbench-surface-muted)] text-[var(--workbench-text)]' : 'text-[var(--workbench-muted)]'}`
      }
      end
      to={to}
    >
      {children}
    </NavLink>
  )
}

/**
 * 公開ページフッターのナビゲーションリンクに渡す props です。
 */
type PublicFooterLinkProps = {
  /**
   * リンクに表示する文言です。
   */
  children: ReactNode
  /**
   * React Router の遷移先です。
   */
  to: string
}

/**
 * 公開ページフッターで使うテキストリンクです。
 */
function PublicFooterLink({ children, to }: PublicFooterLinkProps) {
  return (
    <Link
      className="text-sm font-semibold text-[var(--workbench-muted)] no-underline hover:text-[var(--workbench-primary)] hover:underline"
      to={to}
    >
      {children}
    </Link>
  )
}
