import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError, loginWithPassword } from '../auth/api'
import { getAuthSession, saveAuthSession } from '../auth/session'
import { BrandMark } from '../components/BrandMark'
import {
  ChevronIcon,
  EyeIcon,
  GlobeIcon,
  LockIcon,
  MailIcon,
} from '../components/icons'
import { DashboardPreview } from '../features/login/DashboardPreview'
import {
  createTranslator,
  getInitialLocale,
  localeOptions,
  setLocalePreference,
  type Locale,
  type MessageKey,
} from '../i18n'

/**
 * ログイン画面フッターリンクの props です。
 */
type FooterLinkProps = {
  /**
   * リンク内に表示する要素です。
   */
  children: ReactNode
  /**
   * React Router に渡す遷移先パスです。
   */
  to: string
}

/**
 * Cognito のパスワード認証に接続したログイン画面です。
 */
export function LoginPage() {
  const navigate = useNavigate()
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale())
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const t = useMemo(() => createTranslator(locale), [locale])

  useEffect(() => {
    if (getAuthSession()) {
      navigate('/dashboard', { replace: true })
    }
  }, [navigate])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = t('app.title')
  }, [locale, t])

  const handleLocaleChange = (value: string) => {
    const nextLocale = value === 'en' ? 'en' : 'ja'
    setLocale(nextLocale)
    setLocalePreference(nextLocale)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (isSubmitting) {
      return
    }

    setIsSubmitting(true)
    setErrorKey(null)

    try {
      const session = await loginWithPassword({ email, password, remember })
      saveAuthSession(session)
      navigate('/dashboard', { replace: true })
    } catch (error) {
      setErrorKey(resolveLoginErrorKey(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-svh min-w-0 grid-cols-[minmax(460px,1.02fr)_minmax(520px,0.98fr)] bg-[var(--surface)] max-[1080px]:grid-cols-1">
      <section
        className="relative order-2 grid min-h-svh min-w-0 grid-rows-[auto_1fr_auto] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(250,252,255,0.96))] px-[clamp(32px,5.5vw,80px)] pb-[38px] pt-12 max-[1080px]:order-1 max-[1080px]:min-h-svh max-[1080px]:pt-[26px] max-[720px]:px-[18px] max-[720px]:pb-7 max-[720px]:pt-[22px]"
        aria-labelledby="login-title"
      >
        <div className="flex min-w-0 items-center gap-2 justify-self-end text-[#4d5868] focus-within:rounded-lg focus-within:outline focus-within:outline-3 focus-within:outline-offset-[5px] focus-within:outline-[rgba(0,101,238,0.18)] max-[720px]:w-[calc(100vw-72px)] max-[720px]:justify-self-start max-[720px]:justify-end">
          <GlobeIcon className="h-[19px] w-[19px] fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" />
          <select
            className="w-auto min-w-0 cursor-pointer appearance-none border-0 bg-transparent text-base font-extrabold text-[var(--ink)] outline-none"
            aria-label={t('language.aria')}
            value={locale}
            onChange={(event) => handleLocaleChange(event.target.value)}
          >
            {localeOptions.map((option) => (
              <option key={option.locale} value={option.locale}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronIcon className="h-[19px] w-[19px] fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" />
        </div>

        <div className="my-8 w-[min(100%,520px)] min-w-0 self-center justify-self-center rounded-lg border border-[#d9e1eb] bg-[rgba(255,255,255,0.92)] p-[clamp(30px,4vw,48px)] shadow-[0_24px_52px_rgba(28,53,88,0.07)] max-[720px]:mb-[34px] max-[720px]:ml-0 max-[720px]:mt-[26px] max-[720px]:w-[calc(100vw-72px)] max-[720px]:max-w-none max-[720px]:justify-self-start max-[720px]:px-5 max-[720px]:py-7">
          <div className="inline-flex w-full items-center justify-center gap-3 text-2xl font-extrabold text-[var(--ink)] max-[720px]:text-xl">
            <BrandMark />
            <span>mukuroji</span>
          </div>

          <div className="mt-9 text-center max-[720px]:mt-8">
            <h1
              className="m-0 text-login-title font-black text-[var(--ink)]"
              id="login-title"
            >
              {t('login.title')}
            </h1>
            <p className="mt-3 text-base font-bold text-[var(--muted)]">
              {t('login.subtitle')}
            </p>
          </div>

          <form
            className="mt-9 grid min-w-0 gap-[22px] max-[720px]:gap-[19px]"
            onSubmit={handleSubmit}
          >
            <div className="grid gap-2.5 text-base font-extrabold text-[var(--ink)]">
              <label className="w-fit" htmlFor="email">
                {t('login.email')}
              </label>
              <span className="grid min-h-[58px] w-full min-w-0 grid-cols-[24px_1fr_auto] items-center gap-3 rounded-lg border border-[#d8e0ea] bg-white px-4 text-[#7b8797] transition-[border-color,box-shadow] duration-150 focus-within:border-[#0065ee] focus-within:shadow-[0_0_0_4px_rgba(0,101,238,0.12)] max-[720px]:min-h-[54px] max-[720px]:grid-cols-[22px_minmax(0,1fr)_auto] max-[720px]:px-3.5">
                <MailIcon />
                <input
                  className="min-w-0 border-0 bg-transparent text-base font-bold text-[var(--ink)] outline-none placeholder:text-[#8d98a8]"
                  disabled={isSubmitting}
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder={t('login.emailPlaceholder')}
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    setErrorKey(null)
                  }}
                  required
                />
              </span>
            </div>

            <div className="grid gap-2.5 text-base font-extrabold text-[var(--ink)]">
              <label className="w-fit" htmlFor="password">
                {t('login.password')}
              </label>
              <span className="grid min-h-[58px] w-full min-w-0 grid-cols-[24px_1fr_auto] items-center gap-3 rounded-lg border border-[#d8e0ea] bg-white px-4 text-[#7b8797] transition-[border-color,box-shadow] duration-150 focus-within:border-[#0065ee] focus-within:shadow-[0_0_0_4px_rgba(0,101,238,0.12)] max-[720px]:min-h-[54px] max-[720px]:grid-cols-[22px_minmax(0,1fr)_auto] max-[720px]:px-3.5">
                <LockIcon />
                <input
                  className="min-w-0 border-0 bg-transparent text-base font-bold text-[var(--ink)] outline-none placeholder:text-[#8d98a8]"
                  disabled={isSubmitting}
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder={t('login.passwordPlaceholder')}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    setErrorKey(null)
                  }}
                  required
                />
                <button
                  type="button"
                  className="-mr-2 grid h-[38px] w-[38px] cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-[#718095] outline-none hover:bg-[#edf5ff] hover:text-[#005fe7] focus-visible:bg-[#edf5ff] focus-visible:text-[#005fe7]"
                  aria-label={
                    showPassword
                      ? t('login.hidePassword')
                      : t('login.showPassword')
                  }
                  onClick={() => setShowPassword((current) => !current)}
                >
                  <EyeIcon />
                </button>
              </span>
            </div>

            <label className="flex cursor-pointer items-center gap-3 text-sm font-extrabold text-[var(--ink)]">
              <span className="relative grid h-6 w-6 place-items-center">
                <input
                  className="peer h-6 w-6 cursor-pointer appearance-none rounded-[7px] border border-[#cfd8e5] bg-white checked:border-[#0063ed] checked:bg-[#0063ed] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[rgba(0,101,238,0.18)]"
                  type="checkbox"
                  checked={remember}
                  disabled={isSubmitting}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <svg
                  className="pointer-events-none absolute h-3.5 w-3.5 fill-none stroke-white stroke-[3px] opacity-0 peer-checked:opacity-100 [stroke-linecap:round] [stroke-linejoin:round]"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path d="m3.5 8.2 2.8 2.8 6.2-6.5" />
                </svg>
              </span>
              <span>{t('login.remember')}</span>
            </label>

            {errorKey ? (
              <p
                className="m-0 rounded-lg border border-[#ffd2d2] bg-[#fff5f5] px-4 py-3 text-sm font-bold leading-6 text-[#b42318]"
                role="alert"
              >
                {t(errorKey)}
              </p>
            ) : null}

            <button
              className="min-h-[52px] w-full cursor-pointer rounded-lg border-0 bg-linear-to-br from-[#006cff] to-[#004ec8] text-base font-black text-white shadow-[0_14px_30px_rgba(0,89,216,0.22)] transition-[transform,box-shadow,filter] duration-150 hover:-translate-y-px hover:saturate-[1.08] hover:shadow-[0_18px_36px_rgba(0,89,216,0.28)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[rgba(0,101,238,0.22)] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0 disabled:hover:saturate-100"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? t('login.loading') : t('login.submit')}
            </button>

            <Link
              className="justify-self-center text-base font-extrabold text-[#0063ed] no-underline hover:text-[#004ab4] hover:underline focus-visible:text-[#004ab4] focus-visible:underline focus-visible:outline-none"
              to="/forgot-password"
            >
              {t('login.forgotPassword')}
            </Link>
          </form>
        </div>

        <footer className="self-end text-center text-sm text-[var(--muted)] max-[720px]:w-[calc(100vw-72px)] max-[720px]:justify-self-start max-[720px]:text-app-meta">
          <nav
            className="flex flex-wrap justify-center gap-[18px]"
            aria-label={t('footer.aria')}
          >
            <FooterLink to="/privacy">{t('footer.privacy')}</FooterLink>
            <FooterLink to="/terms">{t('footer.terms')}</FooterLink>
            <FooterLink to="/support">{t('footer.support')}</FooterLink>
          </nav>
          <p className="mt-[18px]">{t('footer.copyright')}</p>
        </footer>
      </section>

      <section
        className="relative isolate order-1 flex min-h-svh min-w-0 flex-col justify-center gap-12 overflow-hidden bg-[radial-gradient(circle_at_88%_8%,rgba(47,115,255,0.15),transparent_27%),linear-gradient(144deg,#f7fbff_0%,#e8f3ff_48%,#d8ebff_100%)] px-[clamp(36px,5vw,72px)] py-14 max-[1080px]:order-2 max-[1080px]:min-h-0 max-[1080px]:pt-[42px] max-[1080px]:pb-[50px] max-[720px]:gap-[30px] max-[720px]:px-[18px] max-[720px]:py-7 max-[720px]:pb-[34px]"
        aria-labelledby="story-title"
      >
        <span
          className="pointer-events-none absolute -right-[122px] -top-[70px] -z-10 h-[420px] w-[420px] rotate-[34deg] rounded-[45%] border-[54px] border-white/50"
          aria-hidden="true"
        ></span>
        <span
          className="pointer-events-none absolute -left-[72px] bottom-[124px] -z-10 h-[210px] w-[210px] bg-[radial-gradient(rgba(255,255,255,0.9)_1.5px,transparent_1.5px)] bg-[length:12px_12px] opacity-95"
          aria-hidden="true"
        ></span>

        <div className="inline-flex items-center gap-3 text-2xl font-extrabold text-[var(--ink)] max-[720px]:text-xl">
          <BrandMark />
          <span>mukuroji</span>
        </div>

        <div className="min-w-0 max-w-[560px]">
          <h2
            className="m-0 text-story-title font-black text-[var(--ink)]"
            id="story-title"
          >
            {t('story.title')}
          </h2>
          <p className="mt-5 max-w-[520px] text-base leading-8 text-[var(--muted-strong)] [overflow-wrap:anywhere] max-[720px]:leading-[1.75]">
            {t('story.description')}
          </p>
        </div>

        <DashboardPreview t={t} />
      </section>
    </main>
  )
}

function resolveLoginErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'login.errorInvalid'
    }

    if (error.status === 503 || error.status === 502) {
      return 'login.errorUnavailable'
    }
  }

  return 'login.errorUnknown'
}

function FooterLink({
  children,
  to,
}: FooterLinkProps) {
  return (
    <Link
      className="font-bold text-[var(--muted-strong)] no-underline hover:text-[#005fe7] hover:underline focus-visible:text-[#005fe7] focus-visible:underline focus-visible:outline-none"
      to={to}
    >
      {children}
    </Link>
  )
}
