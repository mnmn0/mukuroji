import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Link, Navigate } from 'react-router'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../api/mutationHeaders'
import {
  clearAuthSession,
  getAuthSession,
  type AuthSession,
} from '../auth/session'
import { BrandMark } from '../components/BrandMark'
import { GlobeIcon } from '../components/icons'
import {
  createTranslator,
  getInitialLocale,
  localeOptions,
  setLocalePreference,
  type Locale,
  type MessageKey,
} from '../i18n'
import {
  activateEnterpriseBreakGlassAccess,
  EnterpriseSecurityApiError,
  type ActivateEnterpriseBreakGlassInput,
  type EnterpriseBreakGlassActivation,
} from '../security/api'

/**
 * Recovery access 画面の依存関係と Storybook 初期値です。
 */
type SecurityRecoveryPageProps = {
  /** Recovery activation API の差し替えです。 */
  activateAccess?: typeof activateEnterpriseBreakGlassAccess
  /** 現在の認証 session を取得する関数です。 */
  getSession?: () => AuthSession | null
  /** Storybook などで固定する初期 locale です。 */
  initialLocale?: Locale
  /** Activation 後の遷移を Storybook などで差し替える callback です。 */
  onActivated?: (
    activation: EnterpriseBreakGlassActivation,
  ) => void | Promise<void>
}

/**
 * Recovery form が選択できる短時間 activation duration です。
 */
type RecoveryDurationOption = {
  /** API に送信する duration minutes です。 */
  minutes: number
  /** Duration label の翻訳キーです。 */
  labelKey: MessageKey
}

const recoveryDurationOptions = [
  { minutes: 5, labelKey: 'security.recovery.duration.five' },
  { minutes: 15, labelKey: 'security.recovery.duration.fifteen' },
  { minutes: 30, labelKey: 'security.recovery.duration.thirty' },
] as const satisfies readonly RecoveryDurationOption[]

/**
 * 事前登録済み emergency administrator が短時間の recovery access を開始する画面です。
 */
export function SecurityRecoveryPage({
  activateAccess = activateEnterpriseBreakGlassAccess,
  getSession = getAuthSession,
  initialLocale,
  onActivated,
}: SecurityRecoveryPageProps = {}) {
  const [session] = useState<AuthSession | null>(() => getSession())
  const [locale, setLocale] = useState<Locale>(
    () => initialLocale ?? getInitialLocale(),
  )
  const [reason, setReason] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(15)
  const [errorKey, setErrorKey] = useState<MessageKey | undefined>()
  const [reauthenticationRequired, setReauthenticationRequired] =
    useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const t = useMemo(() => createTranslator(locale), [locale])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${t('security.recovery.title')} | ${t('app.title')}`
  }, [locale, t])

  if (!session) {
    return (
      <Navigate
        replace
        to="/login?returnTo=%2Fsecurity%2Frecovery"
      />
    )
  }

  const handleLocaleChange = (value: string) => {
    const nextLocale = value === 'en' ? 'en' : 'ja'
    setLocale(nextLocale)
    setLocalePreference(nextLocale)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const normalizedReason = reason.trim()
    if (normalizedReason.length < 10 || isSubmitting) {
      setErrorKey(
        normalizedReason.length < 10
          ? 'security.recovery.error.reason'
          : undefined,
      )
      return
    }

    setErrorKey(undefined)
    setReauthenticationRequired(false)
    setIsSubmitting(true)

    try {
      const input = {
        durationMinutes,
        reason: normalizedReason,
      } satisfies ActivateEnterpriseBreakGlassInput
      const fingerprint = await createMutationFingerprint(
        input.reason,
        String(input.durationMinutes),
      )
      const activation = await mutationRequestRunner.run(
        'enterprise:break-glass:activate',
        fingerprint,
        (context) => activateAccess(session.accessToken, input, context),
        (error) => !(error instanceof EnterpriseSecurityApiError),
      )

      if (onActivated) {
        await onActivated(activation)
      } else {
        const searchParams = new URLSearchParams({
          recovery: 'active',
          recoveryExpiresAt: activation.expiresAt,
        })
        window.location.assign(`/settings/security?${searchParams}`)
      }
    } catch (error) {
      setErrorKey(resolveRecoveryErrorKey(error))
      if (recoveryErrorRequiresAuthentication(error)) {
        clearAuthSession()
        setReauthenticationRequired(true)
      }
      setIsSubmitting(false)
    }
  }

  return (
    <div className="workbench-shell min-h-svh bg-[var(--workbench-page)]">
      <header className="border-b border-[var(--workbench-border)] bg-white">
        <div className="mx-auto flex min-h-16 w-full max-w-[1120px] items-center gap-4 px-5 py-2.5 sm:px-8">
          <Link
            aria-label="mukuroji"
            className="inline-flex shrink-0 items-center gap-2.5 text-lg font-bold tracking-[-0.01em] text-[var(--workbench-text)] no-underline"
            to="/dashboard"
          >
            <BrandMark small />
            <span>mukuroji</span>
          </Link>
          <span className="hidden h-5 w-px bg-[var(--workbench-border-strong)] sm:block" />
          <span className="hidden text-sm font-semibold text-[var(--workbench-muted)] sm:block">
            {t('security.recovery.header')}
          </span>

          <label className="ml-auto inline-flex min-h-10 items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 text-app-meta font-semibold text-[var(--workbench-muted)] transition focus-within:border-[var(--workbench-focus)] focus-within:ring-3 focus-within:ring-[rgba(37,99,235,0.18)]">
            <span className="sr-only">{t('language.aria')}</span>
            <GlobeIcon className="h-4 w-4 fill-none stroke-current stroke-[1.8]" />
            <select
              aria-label={t('language.aria')}
              className="cursor-pointer border-0 bg-transparent font-semibold text-[var(--workbench-text)] outline-none"
              value={locale}
              onChange={(event) => handleLocaleChange(event.target.value)}
            >
              {localeOptions.map((option) => (
                <option key={option.locale} value={option.locale}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1120px] gap-9 px-5 py-10 sm:px-8 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.82fr)] lg:items-start lg:gap-14 lg:py-20">
        <section aria-labelledby="recovery-access-title" className="min-w-0">
          <span className="inline-flex rounded-full border border-[#f0c7bf] bg-[#fff2ef] px-3 py-1 text-xs font-bold tracking-[0.04em] text-[#a33b2b]">
            {t('security.recovery.eyebrow')}
          </span>
          <h1
            className="workbench-title mb-0 mt-5 max-w-[680px] text-[clamp(2.1rem,5vw,4rem)] leading-[1.04] tracking-[-0.035em]"
            id="recovery-access-title"
          >
            {t('security.recovery.title')}
          </h1>
          <p className="mb-0 mt-6 max-w-[680px] text-base font-medium leading-8 text-[var(--workbench-muted)] sm:text-lg">
            {t('security.recovery.description')}
          </p>

          <div className="mt-10 grid gap-5">
            <RecoveryStep
              index="01"
              title={t('security.recovery.step.verify.title')}
              description={t('security.recovery.step.verify.description')}
            />
            <RecoveryStep
              index="02"
              title={t('security.recovery.step.audit.title')}
              description={t('security.recovery.step.audit.description')}
            />
            <RecoveryStep
              index="03"
              title={t('security.recovery.step.expire.title')}
              description={t('security.recovery.step.expire.description')}
            />
          </div>
        </section>

        <section
          aria-labelledby="recovery-form-title"
          className="workbench-panel min-w-0 overflow-hidden"
        >
          <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5 sm:px-7">
            <p className="m-0 text-xs font-bold uppercase tracking-[0.08em] text-[#a33b2b]">
              {t('security.recovery.form.label')}
            </p>
            <h2
              className="mb-0 mt-2 text-xl font-bold tracking-[-0.015em] text-[var(--workbench-text)]"
              id="recovery-form-title"
            >
              {t('security.recovery.form.title')}
            </h2>
          </div>

          <form className="grid gap-6 p-6 sm:p-7" onSubmit={handleSubmit}>
            <div
              className="rounded-lg border border-[#f0c7bf] bg-[#fff8f6] p-4 text-sm font-medium leading-6 text-[#7c3126]"
              role="note"
            >
              <strong className="block">{t('security.recovery.warning.title')}</strong>
              <span>{t('security.recovery.warning.description')}</span>
            </div>

            <div className="grid gap-2">
              <label
                className="text-sm font-bold text-[var(--workbench-text)]"
                htmlFor="recovery-reason"
              >
                {t('security.recovery.reason')}
              </label>
              <textarea
                aria-describedby="recovery-reason-help"
                aria-invalid={errorKey === 'security.recovery.error.reason'}
                className="workbench-input min-h-32 w-full resize-y px-3.5 py-3 aria-invalid:border-[var(--workbench-danger)]"
                id="recovery-reason"
                maxLength={500}
                name="reason"
                placeholder={t('security.recovery.reasonPlaceholder')}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value)
                  setErrorKey(undefined)
                }}
              />
              <p
                className="m-0 text-app-meta leading-5 text-[var(--workbench-muted)]"
                id="recovery-reason-help"
              >
                {t('security.recovery.reasonHelp')}
              </p>
            </div>

            <fieldset className="grid gap-3">
              <legend className="text-sm font-bold text-[var(--workbench-text)]">
                {t('security.recovery.duration')}
              </legend>
              <div className="grid grid-cols-3 gap-2">
                {recoveryDurationOptions.map((option) => {
                  const selected = durationMinutes === option.minutes

                  return (
                    <label
                      className={`grid min-h-11 cursor-pointer place-items-center rounded-md border px-2 text-sm font-bold transition focus-within:outline focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-[rgba(37,99,235,0.22)] ${
                        selected
                          ? 'border-[var(--workbench-primary)] bg-[#e8f6f3] text-[var(--workbench-primary)]'
                          : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:border-[var(--workbench-border-strong)]'
                      }`}
                      key={option.minutes}
                    >
                      <input
                        className="sr-only"
                        name="durationMinutes"
                        type="radio"
                        value={option.minutes}
                        checked={selected}
                        onChange={() => {
                          setDurationMinutes(option.minutes)
                          setErrorKey(undefined)
                        }}
                      />
                      {t(option.labelKey)}
                    </label>
                  )
                })}
              </div>
              <p className="m-0 text-app-meta leading-5 text-[var(--workbench-muted)]">
                {t('security.recovery.durationHelp')}
              </p>
            </fieldset>

            {errorKey ? (
              <div
                className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold leading-6 text-red-700"
                role="alert"
              >
                {t(errorKey)}
              </div>
            ) : null}

            {reauthenticationRequired ? (
              <Link
                className="workbench-button-primary inline-flex min-h-12 items-center justify-center px-5 text-center no-underline"
                to="/login?returnTo=%2Fsecurity%2Frecovery"
              >
                {t('security.recovery.reauthenticate')}
              </Link>
            ) : (
              <button
                className="workbench-button-primary min-h-12 cursor-pointer px-5 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSubmitting}
                type="submit"
              >
                {t(
                  isSubmitting
                    ? 'security.recovery.activating'
                    : 'security.recovery.activate',
                )}
              </button>
            )}
            <Link
              className="text-center text-sm font-semibold text-[var(--workbench-muted)] underline-offset-4 hover:underline"
              to="/dashboard"
            >
              {t('security.recovery.cancel')}
            </Link>
          </form>
        </section>
      </main>
    </div>
  )
}

/**
 * Recovery access の安全条件を番号付きで説明します。
 */
function RecoveryStep({
  description,
  index,
  title,
}: {
  /** Step の補足説明です。 */
  description: string
  /** 視覚的に表示する step number です。 */
  index: string
  /** Step の見出しです。 */
  title: string
}) {
  return (
    <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-4 border-t border-[var(--workbench-border)] pt-5">
      <span className="font-mono text-sm font-bold text-[var(--workbench-primary)]">
        {index}
      </span>
      <div>
        <h2 className="m-0 text-base font-bold text-[var(--workbench-text)]">
          {title}
        </h2>
        <p className="mb-0 mt-1.5 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {description}
        </p>
      </div>
    </div>
  )
}

function resolveRecoveryErrorKey(error: unknown): MessageKey {
  if (error instanceof EnterpriseSecurityApiError) {
    if (
      error.code === 'EnterpriseSessionMfaRequired' ||
      error.code === 'EnterpriseBreakGlassMfaRequired'
    ) {
      return 'security.recovery.error.mfa'
    }
    if (
      error.code ===
        'EnterpriseSessionReauthenticationRequired' ||
      error.code ===
        'EnterpriseBreakGlassReauthenticationRequired'
    ) {
      return 'security.recovery.error.reauthentication'
    }
    if (error.code === 'EnterpriseSessionIpDenied') {
      return 'security.error.ipDenied'
    }
    if (
      error.code === 'EnterpriseSessionExpired' ||
      error.code === 'EnterpriseSessionIdleTimeout'
    ) {
      return 'security.recovery.error.session'
    }
    if (error.code === 'EnterpriseBreakGlassDenied') {
      return 'security.recovery.error.denied'
    }
    if (error.code === 'EnterpriseBreakGlassDurationInvalid') {
      return 'security.recovery.error.duration'
    }
    if (error.status === 401) {
      return 'security.recovery.error.session'
    }
  }

  return 'security.recovery.error.unknown'
}

function recoveryErrorRequiresAuthentication(error: unknown) {
  return (
    error instanceof EnterpriseSecurityApiError &&
    (error.status === 401 ||
      error.code === 'EnterpriseBreakGlassMfaRequired' ||
      error.code ===
        'EnterpriseBreakGlassReauthenticationRequired' ||
      error.code === 'EnterpriseSessionMfaRequired' ||
      error.code === 'EnterpriseSessionExpired' ||
      error.code === 'EnterpriseSessionIdleTimeout' ||
      error.code ===
        'EnterpriseSessionReauthenticationRequired')
  )
}
