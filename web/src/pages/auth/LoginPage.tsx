import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
  ApiError,
  completeMfaChallenge,
  completeNewPasswordChallenge,
  discoverEnterpriseSso,
  loginWithPassword,
  startEnterpriseSso,
  type AuthenticationChallenge,
  type MfaRequiredChallenge,
} from '../../auth/api'
import {
  isSafeEnterpriseSsoAuthorizationUrl,
  savePendingEnterpriseSsoLogin,
} from '../../auth/enterpriseSso'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../shared/api/mutationHeaders'
import { getAuthSession, saveAuthSession } from '../../auth/session'
import { BrandMark } from '../../shared/ui/BrandMark'
import {
  ChevronIcon,
  EyeIcon,
  GlobeIcon,
  LockIcon,
  MailIcon,
} from '../../shared/ui/icons'
import { DashboardPreview } from '../../features/login/DashboardPreview'
import {
  createTranslator,
  getInitialLocale,
  localeOptions,
  setLocalePreference,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import { resolveSafeLoginReturnPath } from '../../auth/model/loginReturnPath'

function shouldRetainAuthMutationContext(error: unknown) {
  return !(error instanceof ApiError)
}

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
 * LoginPage の初期 challenge 状態を Storybook から指定する props です。
 */
type LoginPageProps = {
  /**
   * Storybook などで初期表示する email address です。
   */
  initialEmail?: string
  /**
   * Storybook などで初期表示する login step です。
   */
  initialLoginStep?: LoginStep
  /**
   * Storybook などで固定する初期 locale です。
   */
  initialLocale?: Locale
  /**
   * 初期表示から NEW_PASSWORD_REQUIRED form を表示する challenge です。
   */
  initialChallenge?: AuthenticationChallenge
  /**
   * challenge 完了失敗後の通常ログイン再試行案内を初期表示するかどうかです。
   */
  initialChallengeFailed?: boolean
}

/**
 * Password を収集する前後の email-first login step です。
 */
type LoginStep = 'email' | 'password'

/**
 * Email domain を discovery して SSO または Cognito password login へ安全に分岐する画面です。
 */
export function LoginPage({
  initialEmail = '',
  initialLoginStep = 'email',
  initialLocale,
  initialChallenge,
  initialChallengeFailed = false,
}: LoginPageProps = {}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const returnPath = resolveSafeLoginReturnPath(searchParams.get('returnTo'))
  const [locale, setLocale] = useState<Locale>(
    () => initialLocale ?? getInitialLocale(),
  )
  const [email, setEmail] = useState(initialChallenge?.email ?? initialEmail)
  const [loginStep, setLoginStep] = useState<LoginStep>(
    initialChallenge ? 'password' : initialLoginStep,
  )
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [challenge, setChallenge] = useState<AuthenticationChallenge | undefined>(
    initialChallenge,
  )
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [challengeFailed, setChallengeFailed] = useState(initialChallengeFailed)
  const [errorKey, setErrorKey] = useState<MessageKey | null>(
    initialChallengeFailed ? 'login.challenge.error' : null,
  )
  const t = useMemo(() => createTranslator(locale), [locale])
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current

  useEffect(() => {
    if (getAuthSession()) {
      navigate(returnPath, { replace: true })
    }
  }, [navigate, returnPath])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = t('app.title')
  }, [locale, t])

  const handleLocaleChange = (value: string) => {
    const nextLocale = value === 'en' ? 'en' : 'ja'
    setLocale(nextLocale)
    setLocalePreference(nextLocale)
  }

  const startSsoLogin = async (normalizedEmail: string) => {
    const fingerprint = await createMutationFingerprint(
      normalizedEmail,
      returnPath,
    )
    const sso = await mutationRequestRunner.run(
      `auth:sso:start:${normalizedEmail}`,
      fingerprint,
      (context) =>
        startEnterpriseSso(
          {
            email: normalizedEmail,
            returnTo: returnPath,
          },
          context,
        ),
      shouldRetainAuthMutationContext,
    )

    if (!isSafeEnterpriseSsoAuthorizationUrl(sso.authorizationUrl)) {
      throw new ApiError(
        502,
        'Enterprise SSO authorization URL is unsafe.',
      )
    }

    savePendingEnterpriseSsoLogin({
      codeVerifier: sso.codeVerifier,
      expiresAt: sso.expiresAt,
      remember,
      returnTo: resolveSafeLoginReturnPath(sso.returnTo),
      state: sso.state,
    })
    window.location.assign(sso.authorizationUrl)
  }

  const resumeRequiredEnterpriseSso = async (
    error: unknown,
    challengeEmail: string,
  ) => {
    if (!isEnterpriseSsoRequired(error)) {
      return false
    }

    try {
      await startSsoLogin(challengeEmail.trim().toLowerCase())
    } catch {
      setErrorKey('login.errorSso')
    }
    return true
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (isSubmitting) {
      return
    }

    setIsSubmitting(true)
    setErrorKey(null)

    try {
      const normalizedEmail = email.trim().toLowerCase()

      if (loginStep === 'email') {
        const discovery = await discoverEnterpriseSso(normalizedEmail)

        if (discovery.ssoRequired) {
          await startSsoLogin(normalizedEmail)
          return
        }

        setLoginStep('password')
        setPassword('')
        setShowPassword(false)
        return
      }

      const fingerprint = await createMutationFingerprint(normalizedEmail, password)
      const result = await mutationRequestRunner.run(
        `auth:login:${normalizedEmail}`,
        fingerprint,
        (context) =>
          loginWithPassword(
            { email: normalizedEmail, password, remember },
            context,
          ),
        shouldRetainAuthMutationContext,
      )

      if ('challenge' in result) {
        setChallenge(result)
        setEmail(result.email)
        setPassword('')
        setShowPassword(false)
        setChallengeFailed(false)
        return
      }

      saveAuthSession(result)
      navigate(returnPath, { replace: true })
    } catch (error) {
      if (await resumeRequiredEnterpriseSso(error, email)) {
        return
      }
      setErrorKey(resolveLoginErrorKey(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleNewPasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (
      !challenge ||
      challenge.challenge !== 'NEW_PASSWORD_REQUIRED' ||
      isSubmitting
    ) {
      return
    }

    if (newPassword !== newPasswordConfirmation) {
      setErrorKey('login.challenge.errorMismatch')
      return
    }

    setIsSubmitting(true)
    setErrorKey(null)
    setChallengeFailed(false)

    try {
      const normalizedEmail = challenge.email.trim().toLowerCase()
      const fingerprint = await createMutationFingerprint(
        normalizedEmail,
        challenge.session,
        newPassword,
      )
      const result = await mutationRequestRunner.run(
        `auth:new-password:${normalizedEmail}`,
        fingerprint,
        (context) => completeNewPasswordChallenge({
          email: challenge.email,
          newPassword,
          remember,
          session: challenge.session,
        }, context),
        shouldRetainAuthMutationContext,
      )

      if ('challenge' in result) {
        setChallenge(result)
        setMfaCode('')
        setNewPassword('')
        setNewPasswordConfirmation('')
        return
      }

      saveAuthSession(result)
      navigate(returnPath, { replace: true })
    } catch (error) {
      if (await resumeRequiredEnterpriseSso(error, challenge.email)) {
        return
      }
      setErrorKey(resolveChallengeErrorKey(error))
      setChallengeFailed(shouldShowChallengeRecovery(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleMfaSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!challenge || !isMfaChallenge(challenge) || isSubmitting) {
      return
    }

    if (!/^\d{6,8}$/.test(mfaCode)) {
      setErrorKey('login.mfa.errorCode')
      return
    }

    setIsSubmitting(true)
    setErrorKey(null)
    setChallengeFailed(false)

    try {
      const normalizedEmail = challenge.email.trim().toLowerCase()
      const fingerprint = await createMutationFingerprint(
        normalizedEmail,
        challenge.session,
        challenge.challenge,
        mfaCode,
      )
      const result = await mutationRequestRunner.run(
        `auth:mfa:${normalizedEmail}`,
        fingerprint,
        (context) =>
          completeMfaChallenge(
            {
              challenge: challenge.challenge,
              code: mfaCode,
              email: challenge.email,
              remember,
              session: challenge.session,
            },
            context,
          ),
        shouldRetainAuthMutationContext,
      )

      if ('challenge' in result) {
        setChallenge(result)
        setMfaCode('')
        return
      }

      saveAuthSession(result)
      navigate(returnPath, { replace: true })
    } catch (error) {
      if (await resumeRequiredEnterpriseSso(error, challenge.email)) {
        return
      }
      setErrorKey(resolveMfaErrorKey(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  const returnToPasswordLogin = () => {
    setChallenge(undefined)
    setChallengeFailed(false)
    setErrorKey(null)
    setNewPassword('')
    setNewPasswordConfirmation('')
    setMfaCode('')
    setPassword('')
    setShowPassword(false)
    setLoginStep('email')
  }

  const returnToEmailDiscovery = () => {
    mutationRequestRunner.discardRetainedContexts()
    setLoginStep('email')
    setPassword('')
    setShowPassword(false)
    setErrorKey(null)
  }

  const mfaChallenge = challenge && isMfaChallenge(challenge)
    ? challenge
    : undefined

  return (
    <main className="workbench-shell grid min-h-svh min-w-0 grid-cols-[minmax(460px,1.02fr)_minmax(520px,0.98fr)] max-[1080px]:grid-cols-1">
      <section
        className="relative order-2 grid min-h-svh min-w-0 grid-rows-[auto_1fr_auto] bg-[var(--workbench-surface)] px-[clamp(32px,5.5vw,80px)] pb-[38px] pt-12 max-[1080px]:order-1 max-[1080px]:min-h-svh max-[1080px]:pt-[26px] max-[720px]:px-[18px] max-[720px]:pb-7 max-[720px]:pt-[22px]"
        aria-labelledby="login-title"
      >
        <div className="flex min-w-0 items-center gap-2 justify-self-end text-[var(--workbench-muted)] focus-within:rounded-lg focus-within:outline focus-within:outline-3 focus-within:outline-offset-[5px] focus-within:outline-[rgba(37,99,235,0.18)] max-[720px]:w-[calc(100vw-72px)] max-[720px]:justify-self-start max-[720px]:justify-end">
          <GlobeIcon className="h-[19px] w-[19px] fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" />
          <select
            className="w-auto min-w-0 cursor-pointer appearance-none border-0 bg-transparent text-base font-semibold text-[var(--workbench-text)] outline-none"
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

        <div className="workbench-panel my-8 w-[min(100%,520px)] min-w-0 self-center justify-self-center p-[clamp(30px,4vw,48px)] max-[720px]:mb-[34px] max-[720px]:ml-0 max-[720px]:mt-[26px] max-[720px]:w-[calc(100vw-72px)] max-[720px]:max-w-none max-[720px]:justify-self-start max-[720px]:px-5 max-[720px]:py-7">
          <div className="inline-flex w-full items-center justify-center gap-3 text-2xl font-semibold text-[var(--workbench-text)] max-[720px]:text-xl">
            <BrandMark />
            <span>mukuroji</span>
          </div>

          <div className="mt-9 text-center max-[720px]:mt-8">
            <h1
              className="workbench-title m-0 text-login-title"
              id="login-title"
            >
              {mfaChallenge
                ? t('login.mfa.title')
                : challenge
                  ? t('login.challenge.title')
                  : t('login.title')}
            </h1>
            <p className="mt-3 text-base font-medium text-[var(--workbench-muted)]">
              {mfaChallenge
                ? t('login.mfa.subtitle')
                : challenge
                  ? t('login.challenge.subtitle')
                  : t(
                    loginStep === 'email'
                      ? 'login.emailFirstSubtitle'
                      : 'login.passwordSubtitle',
                  )}
            </p>
          </div>

          <form
            className="mt-9 grid min-w-0 gap-[22px] max-[720px]:gap-[19px]"
            onSubmit={
              mfaChallenge
                ? handleMfaSubmit
                : challenge
                  ? handleNewPasswordSubmit
                  : handleSubmit
            }
          >
            {mfaChallenge ? (
              <MfaChallengeForm
                challenge={mfaChallenge}
                code={mfaCode}
                errorKey={errorKey}
                isSubmitting={isSubmitting}
                remember={remember}
                t={t}
                onBack={returnToPasswordLogin}
                onCodeChange={(value) => {
                  setMfaCode(value.replace(/\D/g, '').slice(0, 8))
                  setErrorKey(null)
                }}
                onRememberChange={setRemember}
              />
            ) : challenge ? (
              <>
                <p className="rounded-lg border border-[#99d7cf] bg-[#e5f7f4] px-4 py-3 text-sm font-semibold leading-6 text-[var(--workbench-primary)]">
                  {t('login.challenge.account').replace('{email}', challenge.email)}
                </p>

                <div className="grid gap-2.5 text-base font-semibold text-[var(--workbench-text)]">
                  <label className="w-fit" htmlFor="new-password">
                    {t('login.challenge.newPassword')}
                  </label>
                  <span className="grid min-h-[58px] w-full min-w-0 grid-cols-[24px_1fr_auto] items-center gap-3 rounded-lg border border-[var(--workbench-border-strong)] bg-white px-4 text-[var(--workbench-muted)] transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--workbench-focus)] focus-within:shadow-[0_0_0_4px_rgba(37,99,235,0.12)] max-[720px]:min-h-[54px] max-[720px]:grid-cols-[22px_minmax(0,1fr)_auto] max-[720px]:px-3.5">
                    <LockIcon />
                    <input
                      autoComplete="new-password"
                      autoFocus
                      className="min-w-0 border-0 bg-transparent text-base font-medium text-[var(--workbench-text)] outline-none placeholder:text-[var(--workbench-muted-soft)]"
                      disabled={isSubmitting}
                      id="new-password"
                      minLength={8}
                      placeholder={t('login.challenge.newPasswordPlaceholder')}
                      required
                      type={showPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(event) => {
                        setNewPassword(event.target.value)
                        setErrorKey(null)
                        setChallengeFailed(false)
                      }}
                    />
                    <button
                      aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                      className="-mr-2 grid h-[38px] w-[38px] cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-[var(--workbench-muted)] outline-none hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)] focus-visible:bg-[var(--workbench-surface-muted)] focus-visible:text-[var(--workbench-primary)]"
                      type="button"
                      onClick={() => setShowPassword((current) => !current)}
                    >
                      <EyeIcon />
                    </button>
                  </span>
                  <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                    {t('login.challenge.passwordHint')}
                  </p>
                </div>

                <div className="grid gap-2.5 text-base font-semibold text-[var(--workbench-text)]">
                  <label className="w-fit" htmlFor="new-password-confirmation">
                    {t('login.challenge.confirmPassword')}
                  </label>
                  <span className="grid min-h-[58px] w-full min-w-0 grid-cols-[24px_1fr] items-center gap-3 rounded-lg border border-[var(--workbench-border-strong)] bg-white px-4 text-[var(--workbench-muted)] transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--workbench-focus)] focus-within:shadow-[0_0_0_4px_rgba(37,99,235,0.12)] max-[720px]:min-h-[54px] max-[720px]:grid-cols-[22px_minmax(0,1fr)] max-[720px]:px-3.5">
                    <LockIcon />
                    <input
                      autoComplete="new-password"
                      className="min-w-0 border-0 bg-transparent text-base font-medium text-[var(--workbench-text)] outline-none placeholder:text-[var(--workbench-muted-soft)]"
                      disabled={isSubmitting}
                      id="new-password-confirmation"
                      minLength={8}
                      placeholder={t('login.challenge.confirmPasswordPlaceholder')}
                      required
                      type={showPassword ? 'text' : 'password'}
                      value={newPasswordConfirmation}
                      onChange={(event) => {
                        setNewPasswordConfirmation(event.target.value)
                        setErrorKey(null)
                        setChallengeFailed(false)
                      }}
                    />
                  </span>
                </div>

                <label className="flex cursor-pointer items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
                  <span className="relative grid h-6 w-6 place-items-center">
                    <input
                      checked={remember}
                      className="peer h-6 w-6 cursor-pointer appearance-none rounded-[7px] border border-[var(--workbench-border-strong)] bg-white checked:border-[var(--workbench-primary)] checked:bg-[var(--workbench-primary)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[rgba(37,99,235,0.18)]"
                      disabled={isSubmitting}
                      type="checkbox"
                      onChange={(event) => setRemember(event.target.checked)}
                    />
                    <svg
                      aria-hidden="true"
                      className="pointer-events-none absolute h-3.5 w-3.5 fill-none stroke-white stroke-[3px] opacity-0 peer-checked:opacity-100 [stroke-linecap:round] [stroke-linejoin:round]"
                      viewBox="0 0 16 16"
                    >
                      <path d="m3.5 8.2 2.8 2.8 6.2-6.5" />
                    </svg>
                  </span>
                  <span>{t('login.remember')}</span>
                </label>

                {errorKey ? (
                  <p className="m-0 rounded-lg border border-[#ffd2d2] bg-[#fff5f5] px-4 py-3 text-sm font-bold leading-6 text-[#b42318]" role="alert">
                    {t(errorKey)}
                  </p>
                ) : null}

                {challengeFailed ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left">
                    <p className="text-sm font-semibold text-amber-900">{t('login.challenge.retryTitle')}</p>
                    <p className="mt-1 text-sm font-medium leading-6 text-amber-800">{t('login.challenge.retryDescription')}</p>
                  </div>
                ) : null}

                <button
                  className="workbench-button-primary min-h-[52px] w-full cursor-pointer text-base disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={isSubmitting}
                  type="submit"
                >
                  {isSubmitting ? t('login.challenge.loading') : t('login.challenge.submit')}
                </button>

                <button
                  className="justify-self-center text-base font-semibold text-[var(--workbench-primary)] hover:text-[var(--workbench-primary-hover)] hover:underline disabled:opacity-60"
                  disabled={isSubmitting}
                  type="button"
                  onClick={returnToPasswordLogin}
                >
                  {t('login.challenge.backToLogin')}
                </button>
              </>
            ) : (
              <>
                {loginStep === 'email' ? (
                  <div className="grid gap-2.5 text-base font-semibold text-[var(--workbench-text)]">
                    <label className="w-fit" htmlFor="email">
                      {t('login.email')}
                    </label>
                    <span className="grid min-h-[58px] w-full min-w-0 grid-cols-[24px_1fr_auto] items-center gap-3 rounded-lg border border-[var(--workbench-border-strong)] bg-white px-4 text-[var(--workbench-muted)] transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--workbench-focus)] focus-within:shadow-[0_0_0_4px_rgba(37,99,235,0.12)] max-[720px]:min-h-[54px] max-[720px]:grid-cols-[22px_minmax(0,1fr)_auto] max-[720px]:px-3.5">
                      <MailIcon />
                      <input
                        autoComplete="email"
                        autoFocus
                        className="min-w-0 border-0 bg-transparent text-base font-medium text-[var(--workbench-text)] outline-none placeholder:text-[var(--workbench-muted-soft)]"
                        disabled={isSubmitting}
                        id="email"
                        name="email"
                        placeholder={t('login.emailPlaceholder')}
                        required
                        type="email"
                        value={email}
                        onChange={(event) => {
                          setEmail(event.target.value)
                          setErrorKey(null)
                        }}
                      />
                    </span>
                    <p className="m-0 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                      {t('login.discoveryHelp')}
                    </p>
                  </div>
                ) : (
                  <>
                    <input
                      aria-label={t('login.email')}
                      autoComplete="username"
                      className="sr-only"
                      name="email"
                      readOnly
                      tabIndex={-1}
                      type="email"
                      value={email.trim().toLowerCase()}
                    />
                    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-[#99d7cf] bg-[#e5f7f4] px-4 py-3">
                      <MailIcon className="h-5 w-5 shrink-0 fill-none stroke-[var(--workbench-primary)] stroke-2" />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--workbench-text)]">
                        {email.trim().toLowerCase()}
                      </span>
                      <button
                        className="shrink-0 cursor-pointer border-0 bg-transparent text-sm font-bold text-[var(--workbench-primary)] hover:underline"
                        disabled={isSubmitting}
                        type="button"
                        onClick={returnToEmailDiscovery}
                      >
                        {t('login.changeEmail')}
                      </button>
                    </div>

                    <div className="grid gap-2.5 text-base font-semibold text-[var(--workbench-text)]">
                      <label className="w-fit" htmlFor="password">
                        {t('login.password')}
                      </label>
                      <span className="grid min-h-[58px] w-full min-w-0 grid-cols-[24px_1fr_auto] items-center gap-3 rounded-lg border border-[var(--workbench-border-strong)] bg-white px-4 text-[var(--workbench-muted)] transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--workbench-focus)] focus-within:shadow-[0_0_0_4px_rgba(37,99,235,0.12)] max-[720px]:min-h-[54px] max-[720px]:grid-cols-[22px_minmax(0,1fr)_auto] max-[720px]:px-3.5">
                        <LockIcon />
                        <input
                          autoComplete="current-password"
                          autoFocus
                          className="min-w-0 border-0 bg-transparent text-base font-medium text-[var(--workbench-text)] outline-none placeholder:text-[var(--workbench-muted-soft)]"
                          disabled={isSubmitting}
                          id="password"
                          name="password"
                          placeholder={t('login.passwordPlaceholder')}
                          required
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          onChange={(event) => {
                            setPassword(event.target.value)
                            setErrorKey(null)
                          }}
                        />
                        <button
                          aria-label={
                            showPassword
                              ? t('login.hidePassword')
                              : t('login.showPassword')
                          }
                          className="-mr-2 grid h-[38px] w-[38px] cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-[var(--workbench-muted)] outline-none hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)] focus-visible:bg-[var(--workbench-surface-muted)] focus-visible:text-[var(--workbench-primary)]"
                          type="button"
                          onClick={() => setShowPassword((current) => !current)}
                        >
                          <EyeIcon />
                        </button>
                      </span>
                    </div>
                  </>
                )}

                <label className="flex cursor-pointer items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
                  <span className="relative grid h-6 w-6 place-items-center">
                    <input
                      checked={remember}
                      className="peer h-6 w-6 cursor-pointer appearance-none rounded-[7px] border border-[var(--workbench-border-strong)] bg-white checked:border-[var(--workbench-primary)] checked:bg-[var(--workbench-primary)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[rgba(37,99,235,0.18)]"
                      disabled={isSubmitting}
                      type="checkbox"
                      onChange={(event) => setRemember(event.target.checked)}
                    />
                    <svg
                      aria-hidden="true"
                      className="pointer-events-none absolute h-3.5 w-3.5 fill-none stroke-white stroke-[3px] opacity-0 peer-checked:opacity-100 [stroke-linecap:round] [stroke-linejoin:round]"
                      viewBox="0 0 16 16"
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
                  className="workbench-button-primary min-h-[52px] w-full cursor-pointer text-base disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={isSubmitting}
                  type="submit"
                >
                  {isSubmitting
                    ? t(
                        loginStep === 'email'
                          ? 'login.continuing'
                          : 'login.loading',
                      )
                    : t(
                        loginStep === 'email'
                          ? 'login.continue'
                          : 'login.submit',
                      )}
                </button>

                {loginStep === 'password' ? (
                  <Link
                    className="justify-self-center text-base font-semibold text-[var(--workbench-primary)] no-underline hover:text-[var(--workbench-primary-hover)] hover:underline focus-visible:text-[var(--workbench-primary-hover)] focus-visible:underline focus-visible:outline-none"
                    to="/forgot-password"
                  >
                    {t('login.forgotPassword')}
                  </Link>
                ) : null}
              </>
            )}
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
        className="relative isolate order-1 flex min-h-svh min-w-0 flex-col justify-center gap-12 overflow-hidden bg-[var(--workbench-canvas)] px-[clamp(36px,5vw,72px)] py-14 max-[1080px]:order-2 max-[1080px]:min-h-0 max-[1080px]:pt-[42px] max-[1080px]:pb-[50px] max-[720px]:gap-[30px] max-[720px]:px-[18px] max-[720px]:py-7 max-[720px]:pb-[34px]"
        aria-labelledby="story-title"
      >
        <div className="inline-flex items-center gap-3 text-2xl font-semibold text-[var(--workbench-text)] max-[720px]:text-xl">
          <BrandMark />
          <span>mukuroji</span>
        </div>

        <div className="min-w-0 max-w-[560px]">
          <h2
            className="workbench-title m-0 text-story-title"
            id="story-title"
          >
            {t('story.title')}
          </h2>
          <p className="mt-5 max-w-[520px] text-base leading-8 text-[var(--workbench-muted)] [overflow-wrap:anywhere] max-[720px]:leading-[1.75]">
            {t('story.description')}
          </p>
        </div>

        <DashboardPreview t={t} />
      </section>
    </main>
  )
}

/**
 * LoginPage 内に表示する one-time code challenge の props です。
 */
type MfaChallengeFormProps = {
  /** Cognito が発行した MFA challenge です。 */
  challenge: MfaRequiredChallenge
  /** User が入力中の one-time code です。 */
  code: string
  /** 現在表示する localized error key です。 */
  errorKey: MessageKey | null
  /** MFA response を送信中かどうかです。 */
  isSubmitting: boolean
  /** Login session を保持する user preference です。 */
  remember: boolean
  /** 現在の locale で文言を返す translator です。 */
  t: ReturnType<typeof createTranslator>
  /** Login flow を最初からやり直す callback です。 */
  onBack: () => void
  /** One-time code input の変更 callback です。 */
  onCodeChange: (value: string) => void
  /** Login session 保持設定の変更 callback です。 */
  onRememberChange: (remember: boolean) => void
}

/**
 * Authenticator app、SMS、email の Cognito one-time code challenge を描画します。
 */
function MfaChallengeForm({
  challenge,
  code,
  errorKey,
  isSubmitting,
  remember,
  t,
  onBack,
  onCodeChange,
  onRememberChange,
}: MfaChallengeFormProps) {
  const destination = challenge.deliveryDestination?.trim()
  const deliveryDescription = destination
    ? t('login.mfa.deliveryDescription').replace(
        '{destination}',
        destination,
      )
    : challenge.challenge === 'SOFTWARE_TOKEN_MFA'
      ? t('login.mfa.authenticatorDescription')
      : t('login.mfa.codeDescription')

  return (
    <>
      <div className="rounded-lg border border-[#99d7cf] bg-[#e5f7f4] px-4 py-3 text-left">
        <p className="m-0 text-sm font-bold text-[var(--workbench-primary)]">
          {t('login.mfa.verifyTitle')}
        </p>
        <p className="mb-0 mt-1 text-sm font-medium leading-6 text-[#285f59]">
          {deliveryDescription}
        </p>
      </div>

      <div className="grid gap-2.5 text-base font-semibold text-[var(--workbench-text)]">
        <label className="w-fit" htmlFor="mfa-code">
          {t('login.mfa.code')}
        </label>
        <span className="grid min-h-[58px] w-full min-w-0 grid-cols-[24px_1fr] items-center gap-3 rounded-lg border border-[var(--workbench-border-strong)] bg-white px-4 text-[var(--workbench-muted)] transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--workbench-focus)] focus-within:shadow-[0_0_0_4px_rgba(37,99,235,0.12)] max-[720px]:min-h-[54px] max-[720px]:grid-cols-[22px_minmax(0,1fr)] max-[720px]:px-3.5">
          <LockIcon />
          <input
            aria-describedby={
              errorKey
                ? 'mfa-code-help mfa-code-error'
                : 'mfa-code-help'
            }
            aria-invalid={errorKey ? true : undefined}
            autoComplete="one-time-code"
            autoFocus
            className="min-w-0 border-0 bg-transparent font-mono text-lg font-bold tracking-[0.18em] text-[var(--workbench-text)] outline-none placeholder:font-sans placeholder:text-base placeholder:font-medium placeholder:tracking-normal placeholder:text-[var(--workbench-muted-soft)]"
            disabled={isSubmitting}
            id="mfa-code"
            inputMode="numeric"
            maxLength={8}
            name="code"
            pattern="[0-9]{6,8}"
            placeholder={t('login.mfa.codePlaceholder')}
            required
            type="text"
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
          />
        </span>
        <p
          className="m-0 text-xs font-medium leading-5 text-[var(--workbench-muted)]"
          id="mfa-code-help"
        >
          {t('login.mfa.codeHelp')}
        </p>
      </div>

      <label className="flex cursor-pointer items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
        <span className="relative grid h-6 w-6 place-items-center">
          <input
            checked={remember}
            className="peer h-6 w-6 cursor-pointer appearance-none rounded-[7px] border border-[var(--workbench-border-strong)] bg-white checked:border-[var(--workbench-primary)] checked:bg-[var(--workbench-primary)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[rgba(37,99,235,0.18)]"
            disabled={isSubmitting}
            type="checkbox"
            onChange={(event) => onRememberChange(event.target.checked)}
          />
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute h-3.5 w-3.5 fill-none stroke-white stroke-[3px] opacity-0 peer-checked:opacity-100 [stroke-linecap:round] [stroke-linejoin:round]"
            viewBox="0 0 16 16"
          >
            <path d="m3.5 8.2 2.8 2.8 6.2-6.5" />
          </svg>
        </span>
        <span>{t('login.remember')}</span>
      </label>

      {errorKey ? (
        <p
          className="m-0 rounded-lg border border-[#ffd2d2] bg-[#fff5f5] px-4 py-3 text-sm font-bold leading-6 text-[#b42318]"
          id="mfa-code-error"
          role="alert"
        >
          {t(errorKey)}
        </p>
      ) : null}

      <button
        className="workbench-button-primary min-h-[52px] w-full cursor-pointer text-base disabled:cursor-not-allowed disabled:opacity-70"
        disabled={isSubmitting}
        type="submit"
      >
        {t(isSubmitting ? 'login.mfa.verifying' : 'login.mfa.verify')}
      </button>

      <button
        className="justify-self-center text-base font-semibold text-[var(--workbench-primary)] hover:text-[var(--workbench-primary-hover)] hover:underline disabled:opacity-60"
        disabled={isSubmitting}
        type="button"
        onClick={onBack}
      >
        {t('login.mfa.restart')}
      </button>
    </>
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

function resolveMfaErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.code === 'AuthenticationChallengeRateLimited' || error.status === 429) {
      return 'login.mfa.errorRateLimited'
    }
    if (error.code === 'InvalidMfaChallenge') {
      return 'login.mfa.errorExpired'
    }
    if (error.status === 400 || error.status === 401) {
      return 'login.mfa.errorInvalid'
    }
    if (error.status === 502 || error.status === 503 || error.status === 504) {
      return 'login.mfa.errorUnavailable'
    }
  }

  return 'login.mfa.errorUnknown'
}

function isMfaChallenge(
  challenge: AuthenticationChallenge,
): challenge is MfaRequiredChallenge {
  return challenge.challenge !== 'NEW_PASSWORD_REQUIRED'
}

function isEnterpriseSsoRequired(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === 'SsoRequired'
  )
}

function resolveChallengeErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.code === 'InvalidNewPassword') {
      return 'login.challenge.errorPasswordPolicy'
    }

    if (error.status === 400 || error.status === 401) {
      return 'login.challenge.errorExpired'
    }

    if (error.status === 502 || error.status === 503) {
      return 'login.challenge.errorUnavailable'
    }
  }

  return 'login.challenge.error'
}

function shouldShowChallengeRecovery(error: unknown) {
  if (!(error instanceof ApiError)) {
    return true
  }

  if (error.code === 'InvalidNewPassword' || error.status === 400 || error.status === 401) {
    return false
  }

  return true
}

function FooterLink({
  children,
  to,
}: FooterLinkProps) {
  return (
    <Link
      className="font-medium text-[var(--workbench-muted)] no-underline hover:text-[var(--workbench-primary)] hover:underline focus-visible:text-[var(--workbench-primary)] focus-visible:underline focus-visible:outline-none"
      to={to}
    >
      {children}
    </Link>
  )
}
