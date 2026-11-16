import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  ApiError,
  confirmPasswordReset,
  requestPasswordReset,
} from '../../auth/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { isValidEmailAddress } from '../../shared/lib/publicPage'
import { PublicPageShell } from '../../features/public-site/ui/PublicPageShell'

/**
 * Step of the password reset flow.
 *
 * - `request`: enter the email address and send a code
 * - `confirm`: enter the emailed code and a new password
 * - `done`: the password is reset
 */
export type PasswordResetStep = 'request' | 'confirm' | 'done'

/**
 * Initial state of the password reset page, for Storybook and tests.
 */
type ForgotPasswordPageProps = {
  /** Email address shown at first render. */
  initialEmail?: string
  /** Step shown at first render. */
  initialStep?: PasswordResetStep
  /** Locale fixed at first render. */
  initialLocale?: Locale
}

/**
 * Lets a member reset a forgotten password with a code emailed by Cognito.
 *
 * The page never reveals whether an account exists: sending a code always reads as sent. The
 * login page opens the confirm step directly, with `?email=…&reason=admin-reset`, when an
 * administrator has already reset the password and the code is in the member's inbox.
 *
 * @param props - Optional initial state.
 * @returns The page.
 */
export function ForgotPasswordPage({
  initialEmail,
  initialStep,
  initialLocale,
}: ForgotPasswordPageProps = {}) {
  const [searchParams] = useSearchParams()
  const adminReset = searchParams.get('reason') === 'admin-reset'
  const [email, setEmail] = useState(() => initialEmail ?? searchParams.get('email')?.trim() ?? '')
  const [step, setStep] = useState<PasswordResetStep>(
    () => initialStep ?? (adminReset && searchParams.get('email') ? 'confirm' : 'request'),
  )
  const [codeSent, setCodeSent] = useState(false)
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey | undefined>()

  /** Sends a reset code to the entered address. */
  const sendCode = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (isSubmitting) return
    const normalizedEmail = email.trim().toLowerCase()
    if (!isValidEmailAddress(normalizedEmail)) {
      setErrorKey('passwordReset.emailError')
      return
    }
    setIsSubmitting(true)
    setErrorKey(undefined)
    try {
      await requestPasswordReset(normalizedEmail)
      setEmail(normalizedEmail)
      setCodeSent(true)
      setCode('')
      setStep('confirm')
    } catch (error) {
      setErrorKey(resolvePasswordResetErrorKey(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  /** Sets the new password with the emailed code. */
  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSubmitting) return
    if (!/^\d{6,8}$/u.test(code)) {
      setErrorKey('passwordReset.codeError')
      return
    }
    if (!newPassword) {
      setErrorKey('passwordReset.error.passwordPolicy')
      return
    }
    if (newPassword !== newPasswordConfirmation) {
      setErrorKey('passwordReset.mismatch')
      return
    }
    setIsSubmitting(true)
    setErrorKey(undefined)
    try {
      await confirmPasswordReset({
        email: email.trim().toLowerCase(),
        code,
        newPassword,
      })
      setNewPassword('')
      setNewPasswordConfirmation('')
      setCode('')
      setStep('done')
    } catch (error) {
      setErrorKey(resolvePasswordResetErrorKey(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <PublicPageShell initialLocale={initialLocale} titleKey="passwordReset.title">
      {({ t }) => (
        <div className="mx-auto grid w-full max-w-[1120px] gap-8 px-5 py-12 sm:px-8 sm:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.95fr)] lg:items-start lg:gap-14 lg:py-20">
          <section aria-labelledby="password-reset-title" className="min-w-0">
            <p className="workbench-eyebrow mb-4">{t('passwordReset.eyebrow')}</p>
            <h1
              className="workbench-title m-0 max-w-[700px] text-[clamp(2.1rem,5vw,4.4rem)] leading-[1.02] tracking-[-0.035em]"
              id="password-reset-title"
            >
              {t('passwordReset.title')}
            </h1>
            <p className="mt-6 max-w-[650px] text-base font-medium leading-8 text-[var(--workbench-muted)] sm:text-lg">
              {t('passwordReset.intro')}
            </p>
            <div className="mt-10 max-w-[600px] border-l border-[var(--workbench-border-strong)] pl-7 sm:pl-9">
              <h2 className="m-0 text-base font-bold text-[var(--workbench-text)]">
                {t('passwordReset.helpTitle')}
              </h2>
              <p className="mb-0 mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t('passwordReset.helpDescription')}
              </p>
              <Link
                className="mt-4 inline-flex text-sm font-bold text-[var(--workbench-primary-text)] no-underline hover:underline"
                to="/support?topic=access"
              >
                {t('passwordReset.supportAction')}
              </Link>
            </div>
          </section>

          <section className="workbench-panel min-w-0 overflow-hidden" aria-labelledby="password-reset-form-title">
            <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5 sm:px-7">
              <h2 className="m-0 text-xl font-bold tracking-[-0.015em] text-[var(--workbench-text)]" id="password-reset-form-title">
                {step === 'request'
                  ? t('passwordReset.requestTitle')
                  : step === 'confirm'
                    ? t('passwordReset.confirmTitle')
                    : t('passwordReset.doneTitle')}
              </h2>
            </div>

            <div className="p-6 sm:p-7">
              {step === 'request' ? (
                <form className="grid gap-5" noValidate onSubmit={(event) => void sendCode(event)}>
                  <p className="m-0 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                    {t('passwordReset.requestDescription')}
                  </p>
                  <div className="grid gap-2">
                    <label className="text-sm font-bold text-[var(--workbench-text)]" htmlFor="password-reset-email">
                      {t('passwordReset.email')}
                    </label>
                    <input
                      aria-describedby={errorKey ? 'password-reset-error' : undefined}
                      aria-invalid={errorKey === 'passwordReset.emailError'}
                      autoComplete="email"
                      className="workbench-input min-h-12 w-full px-3.5 aria-invalid:border-[var(--workbench-danger)]"
                      disabled={isSubmitting}
                      id="password-reset-email"
                      name="email"
                      placeholder={t('passwordReset.emailPlaceholder')}
                      type="email"
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value)
                        setErrorKey(undefined)
                      }}
                    />
                  </div>
                  <PasswordResetError errorKey={errorKey} t={t} />
                  <button
                    className="workbench-button-primary min-h-12 cursor-pointer px-5 disabled:cursor-not-allowed disabled:opacity-70"
                    disabled={isSubmitting}
                    type="submit"
                  >
                    {isSubmitting ? t('passwordReset.sending') : t('passwordReset.send')}
                  </button>
                </form>
              ) : step === 'confirm' ? (
                <form className="grid gap-5" noValidate onSubmit={(event) => void confirm(event)}>
                  <p
                    className="m-0 rounded-lg border border-tone-99d7cf bg-tone-e5f7f4 px-4 py-3 text-sm font-semibold leading-6 text-[var(--workbench-primary-text)]"
                    role="status"
                  >
                    {codeSent || !adminReset
                      ? t('passwordReset.sentNotice').replace('{email}', email)
                      : t('passwordReset.adminResetNotice')}
                  </p>
                  <input autoComplete="username" className="sr-only" readOnly tabIndex={-1} type="email" value={email} aria-hidden="true" />
                  <PasswordField
                    autoComplete="one-time-code"
                    disabled={isSubmitting}
                    id="password-reset-code"
                    inputMode="numeric"
                    label={t('passwordReset.code')}
                    placeholder={t('passwordReset.codePlaceholder')}
                    type="text"
                    value={code}
                    onChange={(value) => {
                      setCode(value.replace(/\D/gu, '').slice(0, 8))
                      setErrorKey(undefined)
                    }}
                  />
                  <PasswordField
                    autoComplete="new-password"
                    disabled={isSubmitting}
                    hint={t('passwordReset.passwordHint')}
                    id="password-reset-new-password"
                    label={t('passwordReset.newPassword')}
                    type="password"
                    value={newPassword}
                    onChange={(value) => {
                      setNewPassword(value)
                      setErrorKey(undefined)
                    }}
                  />
                  <PasswordField
                    autoComplete="new-password"
                    disabled={isSubmitting}
                    id="password-reset-confirm-password"
                    label={t('passwordReset.confirmPassword')}
                    type="password"
                    value={newPasswordConfirmation}
                    onChange={(value) => {
                      setNewPasswordConfirmation(value)
                      setErrorKey(undefined)
                    }}
                  />
                  <PasswordResetError errorKey={errorKey} t={t} />
                  <button
                    className="workbench-button-primary min-h-12 cursor-pointer px-5 disabled:cursor-not-allowed disabled:opacity-70"
                    disabled={isSubmitting}
                    type="submit"
                  >
                    {isSubmitting ? t('passwordReset.submitting') : t('passwordReset.submit')}
                  </button>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    <button
                      className="cursor-pointer border-0 bg-transparent p-0 text-sm font-bold text-[var(--workbench-primary-text)] hover:underline disabled:opacity-60"
                      disabled={isSubmitting}
                      type="button"
                      onClick={() => void sendCode()}
                    >
                      {t('passwordReset.resend')}
                    </button>
                    <button
                      className="cursor-pointer border-0 bg-transparent p-0 text-sm font-bold text-[var(--workbench-primary-text)] hover:underline disabled:opacity-60"
                      disabled={isSubmitting}
                      type="button"
                      onClick={() => {
                        setStep('request')
                        setCodeSent(false)
                        setErrorKey(undefined)
                      }}
                    >
                      {t('passwordReset.changeEmail')}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="grid gap-5" role="status">
                  <p className="m-0 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                    {t('passwordReset.doneDescription')}
                  </p>
                  <Link
                    className="workbench-button-primary inline-flex min-h-12 items-center justify-center px-5 no-underline"
                    to="/login"
                  >
                    {t('passwordReset.goToLogin')}
                  </Link>
                </div>
              )}

              {step !== 'done' ? (
                <Link
                  className="mt-7 inline-flex text-sm font-bold text-[var(--workbench-primary-text)] no-underline hover:underline"
                  to="/"
                >
                  {t('public.backToLogin')}
                </Link>
              ) : null}
            </div>
          </section>
        </div>
      )}
    </PublicPageShell>
  )
}

/**
 * One labelled input of the reset form.
 *
 * @param props - Input attributes, label, and optional hint.
 * @returns The field.
 */
function PasswordField({
  autoComplete,
  disabled,
  hint,
  id,
  inputMode,
  label,
  placeholder,
  type,
  value,
  onChange,
}: {
  autoComplete: string
  disabled: boolean
  hint?: string
  id: string
  inputMode?: 'numeric'
  label: string
  placeholder?: string
  type: 'password' | 'text'
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="grid gap-2">
      <label className="text-sm font-bold text-[var(--workbench-text)]" htmlFor={id}>
        {label}
      </label>
      <input
        aria-describedby={hint ? `${id}-hint` : undefined}
        autoComplete={autoComplete}
        className="workbench-input min-h-12 w-full px-3.5"
        disabled={disabled}
        id={id}
        inputMode={inputMode}
        name={id}
        placeholder={placeholder}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p className="m-0 text-app-meta leading-5 text-[var(--workbench-muted)]" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Shows the current error of the reset form.
 *
 * @param props - Message key and translation.
 * @returns The alert, or nothing without an error.
 */
function PasswordResetError({
  errorKey,
  t,
}: {
  errorKey?: MessageKey
  t: (key: MessageKey) => string
}) {
  if (!errorKey) return null
  return (
    <p
      className="m-0 text-sm font-semibold text-[var(--workbench-danger)]"
      id="password-reset-error"
      role="alert"
    >
      {t(errorKey)}
    </p>
  )
}

/**
 * Maps a failed reset call to a message.
 *
 * @param error - Error from the API.
 * @returns The message key.
 */
function resolvePasswordResetErrorKey(error: unknown): MessageKey {
  if (!(error instanceof ApiError)) return 'passwordReset.error.unavailable'
  if (error.code === 'PasswordResetCodeInvalid') return 'passwordReset.error.codeInvalid'
  if (error.code === 'InvalidNewPassword') return 'passwordReset.error.passwordPolicy'
  if (error.code === 'SsoRequired') return 'passwordReset.error.sso'
  if (error.code === 'AccountSecurityRateLimited' || error.status === 429) {
    return 'passwordReset.error.rateLimited'
  }
  if (error.code === 'InvalidPasswordResetRequest') return 'passwordReset.emailError'
  return 'passwordReset.error.unavailable'
}
