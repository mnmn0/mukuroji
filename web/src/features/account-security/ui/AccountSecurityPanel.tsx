import { useMemo, useState, type FormEvent } from 'react'
import useSWR from 'swr'
import {
  ApiError,
  changePassword,
  disableSoftwareToken,
  getAccountSecurity,
  startSoftwareTokenSetup,
  verifySoftwareTokenSetup,
  type AccountSecurityStatus,
  type ChangePasswordInput,
  type SoftwareTokenSetupStart,
} from '../../../auth/api'
import { createTranslator, type Locale, type MessageKey } from '../../../shared/i18n/i18n'
import { AuthenticatorSetup } from './AuthenticatorSetup'

/** SWR options for the account security status. */
const accountSecurityQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Props of {@link AccountSecurityPanelContainer}.
 */
type AccountSecurityPanelContainerProps = {
  /** Access token of the session. */
  accessToken: string
  /** Display locale. */
  locale: Locale
}

/**
 * Loads the signed-in user's sign-in settings and connects the panel to the API.
 *
 * @param props - Access token and locale.
 * @returns The panel.
 */
export function AccountSecurityPanelContainer({
  accessToken,
  locale,
}: AccountSecurityPanelContainerProps) {
  const { data, error, isLoading, mutate } = useSWR(
    ['account-security', accessToken] as const,
    ([, token]) => getAccountSecurity(token),
    accountSecurityQueryConfig,
  )

  return (
    <AccountSecurityPanel
      isLoading={isLoading}
      loadFailed={Boolean(error) && !data}
      locale={locale}
      status={data}
      onChangePassword={(input) => changePassword(accessToken, input)}
      onDisableMfa={async () => {
        await disableSoftwareToken(accessToken)
        await mutate()
      }}
      onRetry={() => void mutate()}
      onStartMfaSetup={() => startSoftwareTokenSetup(accessToken)}
      onVerifyMfaSetup={async (code) => {
        await verifySoftwareTokenSetup(accessToken, code)
        await mutate()
      }}
    />
  )
}

/**
 * Props of {@link AccountSecurityPanel}.
 */
export type AccountSecurityPanelProps = {
  /** Display locale. */
  locale: Locale
  /** Current sign-in settings, once loaded. */
  status?: AccountSecurityStatus
  /** Whether the settings are loading. */
  isLoading?: boolean
  /** Whether loading failed. */
  loadFailed?: boolean
  /** Changes the password. */
  onChangePassword?: (input: ChangePasswordInput) => Promise<void>
  /** Starts authenticator registration. */
  onStartMfaSetup?: () => Promise<SoftwareTokenSetupStart>
  /** Finishes authenticator registration. */
  onVerifyMfaSetup?: (code: string) => Promise<void>
  /** Turns the authenticator off. */
  onDisableMfa?: () => Promise<void>
  /** Loads the settings again. */
  onRetry?: () => void
}

/**
 * Lets the signed-in user change the password and register or remove an authenticator app.
 *
 * @param props - Settings and callbacks.
 * @returns The panel.
 */
export function AccountSecurityPanel({
  locale,
  status,
  isLoading = false,
  loadFailed = false,
  onChangePassword,
  onStartMfaSetup,
  onVerifyMfaSetup,
  onDisableMfa,
  onRetry,
}: AccountSecurityPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])

  return (
    <section className="workbench-panel overflow-hidden" data-testid="account-security-panel">
      <div className="px-5 py-5">
        <h2 className="text-xl font-semibold text-[var(--workbench-text)]">{t('accountSecurity.title')}</h2>
        <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('accountSecurity.description')}
        </p>
      </div>
      {status ? (
        <div className="grid border-t border-[var(--workbench-border)] min-[900px]:grid-cols-2">
          <PasswordSection status={status} t={t} onChangePassword={onChangePassword} />
          <MfaSection
            status={status}
            t={t}
            onDisableMfa={onDisableMfa}
            onStartMfaSetup={onStartMfaSetup}
            onVerifyMfaSetup={onVerifyMfaSetup}
          />
        </div>
      ) : loadFailed ? (
        <div className="grid gap-4 border-t border-[var(--workbench-border)] px-5 py-6">
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-fg-red-700" role="alert">
            {t('accountSecurity.loadError')}
          </p>
          <button className="workbench-button-secondary min-h-10 w-fit px-4" type="button" onClick={onRetry}>
            {t('accountSecurity.retry')}
          </button>
        </div>
      ) : isLoading ? (
        <p className="border-t border-[var(--workbench-border)] px-5 py-8 text-sm font-semibold text-[var(--workbench-muted)]" role="status">
          {t('accountSecurity.loading')}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Password change form, or a note that SSO manages the password.
 *
 * @param props - Status, translation, and change callback.
 * @returns The section.
 */
function PasswordSection({
  status,
  t,
  onChangePassword,
}: {
  status: AccountSecurityStatus
  t: (key: MessageKey) => string
  onChangePassword?: (input: ChangePasswordInput) => Promise<void>
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey | undefined>()
  const [changed, setChanged] = useState(false)

  /** Changes the password after local checks. */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!onChangePassword || isSubmitting) return
    if (!currentPassword || !newPassword) {
      setErrorKey('passwordReset.error.passwordPolicy')
      return
    }
    if (newPassword !== confirmation) {
      setErrorKey('passwordReset.mismatch')
      return
    }
    setIsSubmitting(true)
    setErrorKey(undefined)
    setChanged(false)
    try {
      await onChangePassword({ currentPassword, newPassword })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmation('')
      setChanged(true)
    } catch (error) {
      setErrorKey(resolvePasswordChangeErrorKey(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="grid content-start gap-4 border-[var(--workbench-border)] px-5 py-5 min-[900px]:border-r" data-testid="account-security-password">
      <h3 className="m-0 text-base font-semibold text-[var(--workbench-text)]">
        {t('accountSecurity.password.title')}
      </h3>
      {!status.passwordManaged ? (
        <p className="m-0 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('accountSecurity.password.sso')}
        </p>
      ) : (
        <form className="grid gap-4" noValidate onSubmit={(event) => void submit(event)}>
          <LabelledPasswordInput
            autoComplete="current-password"
            disabled={isSubmitting}
            id="account-current-password"
            label={t('accountSecurity.password.current')}
            value={currentPassword}
            onChange={(value) => {
              setCurrentPassword(value)
              setErrorKey(undefined)
            }}
          />
          <LabelledPasswordInput
            autoComplete="new-password"
            disabled={isSubmitting}
            hint={t('passwordReset.passwordHint')}
            id="account-new-password"
            label={t('accountSecurity.password.new')}
            value={newPassword}
            onChange={(value) => {
              setNewPassword(value)
              setErrorKey(undefined)
            }}
          />
          <LabelledPasswordInput
            autoComplete="new-password"
            disabled={isSubmitting}
            id="account-confirm-password"
            label={t('accountSecurity.password.confirm')}
            value={confirmation}
            onChange={(value) => {
              setConfirmation(value)
              setErrorKey(undefined)
            }}
          />
          {errorKey ? (
            <p className="m-0 text-sm font-semibold text-[var(--workbench-danger)]" role="alert">{t(errorKey)}</p>
          ) : null}
          {changed ? (
            <p className="m-0 text-sm font-semibold text-[var(--workbench-primary-text)]" role="status">
              {t('accountSecurity.password.changed')}
            </p>
          ) : null}
          <button
            className="workbench-button-primary min-h-11 w-fit cursor-pointer px-5 disabled:cursor-not-allowed disabled:opacity-70"
            disabled={isSubmitting || !onChangePassword}
            type="submit"
          >
            {isSubmitting ? t('accountSecurity.password.submitting') : t('accountSecurity.password.submit')}
          </button>
        </form>
      )}
    </div>
  )
}

/**
 * Authenticator app state with register and turn-off actions.
 *
 * @param props - Status, translation, and callbacks.
 * @returns The section.
 */
function MfaSection({
  status,
  t,
  onStartMfaSetup,
  onVerifyMfaSetup,
  onDisableMfa,
}: {
  status: AccountSecurityStatus
  t: (key: MessageKey) => string
  onStartMfaSetup?: () => Promise<SoftwareTokenSetupStart>
  onVerifyMfaSetup?: (code: string) => Promise<void>
  onDisableMfa?: () => Promise<void>
}) {
  const [isSettingUp, setIsSettingUp] = useState(false)
  const [isConfirmingDisable, setIsConfirmingDisable] = useState(false)
  const [isDisabling, setIsDisabling] = useState(false)
  const [noticeKey, setNoticeKey] = useState<MessageKey | undefined>()
  const [errorKey, setErrorKey] = useState<MessageKey | undefined>()
  const enabled = status.softwareTokenMfaEnabled

  /** Turns the authenticator off after confirmation. */
  const disable = async () => {
    if (!onDisableMfa || isDisabling) return
    setIsDisabling(true)
    setErrorKey(undefined)
    try {
      await onDisableMfa()
      setIsConfirmingDisable(false)
      setNoticeKey('accountSecurity.mfa.disabledNotice')
    } catch {
      setErrorKey('accountSecurity.mfa.error.disable')
    } finally {
      setIsDisabling(false)
    }
  }

  return (
    <div className="grid content-start gap-4 border-t border-[var(--workbench-border)] px-5 py-5 min-[900px]:border-t-0" data-testid="account-security-mfa">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="m-0 text-base font-semibold text-[var(--workbench-text)]">
          {t('accountSecurity.mfa.title')}
        </h3>
        {status.passwordManaged ? (
          <span className={enabled ? 'workbench-badge-primary' : 'rounded-full border border-[var(--workbench-border-strong)] px-2.5 py-0.5 text-xs font-semibold text-[var(--workbench-muted)]'}>
            {enabled ? t('accountSecurity.mfa.enabled') : t('accountSecurity.mfa.disabled')}
          </span>
        ) : null}
      </div>

      {!status.passwordManaged ? (
        <p className="m-0 text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('accountSecurity.mfa.sso')}</p>
      ) : isSettingUp && onStartMfaSetup && onVerifyMfaSetup ? (
        <AuthenticatorSetup
          t={t}
          onCancel={() => setIsSettingUp(false)}
          onStart={onStartMfaSetup}
          onVerify={async (code) => {
            await onVerifyMfaSetup(code)
            setIsSettingUp(false)
            setNoticeKey('accountSecurity.mfa.registered')
          }}
        />
      ) : (
        <>
          <p className="m-0 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {enabled ? t('accountSecurity.mfa.enabledDescription') : t('accountSecurity.mfa.disabledDescription')}
          </p>
          {enabled && status.mfaRequiredByPolicy ? (
            <p className="m-0 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {t('accountSecurity.mfa.requiredByPolicy')}
            </p>
          ) : null}
          {noticeKey ? (
            <p className="m-0 text-sm font-semibold text-[var(--workbench-primary-text)]" role="status">{t(noticeKey)}</p>
          ) : null}
          {errorKey ? (
            <p className="m-0 text-sm font-semibold text-[var(--workbench-danger)]" role="alert">{t(errorKey)}</p>
          ) : null}
          {!enabled ? (
            <button
              className="workbench-button-primary min-h-11 w-fit cursor-pointer px-5"
              disabled={!onStartMfaSetup || !onVerifyMfaSetup}
              type="button"
              onClick={() => {
                setNoticeKey(undefined)
                setIsSettingUp(true)
              }}
            >
              {t('accountSecurity.mfa.register')}
            </button>
          ) : !status.mfaRequiredByPolicy ? (
            isConfirmingDisable ? (
              <div className="grid gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                <p className="m-0 text-sm font-semibold text-fg-red-700">{t('accountSecurity.mfa.disableConfirm')}</p>
                <div className="flex flex-wrap gap-3">
                  <button
                    className="min-h-10 cursor-pointer rounded-md border border-red-200 bg-surface px-3 text-sm font-semibold text-fg-red-700 hover:bg-red-50 disabled:opacity-60"
                    disabled={isDisabling}
                    type="button"
                    onClick={() => void disable()}
                  >
                    {isDisabling ? t('accountSecurity.mfa.disabling') : t('accountSecurity.mfa.disableConfirmAction')}
                  </button>
                  <button
                    className="workbench-button-secondary min-h-10 cursor-pointer px-3 text-sm"
                    disabled={isDisabling}
                    type="button"
                    onClick={() => setIsConfirmingDisable(false)}
                  >
                    {t('mfaSetup.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="min-h-10 w-fit cursor-pointer rounded-md border border-red-200 bg-surface px-3 text-sm font-semibold text-fg-red-700 hover:bg-red-50"
                disabled={!onDisableMfa}
                type="button"
                onClick={() => {
                  setNoticeKey(undefined)
                  setIsConfirmingDisable(true)
                }}
              >
                {t('accountSecurity.mfa.disable')}
              </button>
            )
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * Password input with a label and an optional hint.
 *
 * @param props - Input attributes and label.
 * @returns The field.
 */
function LabelledPasswordInput({
  autoComplete,
  disabled,
  hint,
  id,
  label,
  value,
  onChange,
}: {
  autoComplete: string
  disabled: boolean
  hint?: string
  id: string
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-semibold text-[var(--workbench-text)]" htmlFor={id}>{label}</label>
      <input
        aria-describedby={hint ? `${id}-hint` : undefined}
        autoComplete={autoComplete}
        className="workbench-input min-h-11 w-full max-w-[360px] px-3"
        disabled={disabled}
        id={id}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p className="m-0 text-xs font-medium leading-5 text-[var(--workbench-muted)]" id={`${id}-hint`}>{hint}</p>
      ) : null}
    </div>
  )
}

/**
 * Maps a failed password change to a message.
 *
 * @param error - Error from the API.
 * @returns The message key.
 */
function resolvePasswordChangeErrorKey(error: unknown): MessageKey {
  if (!(error instanceof ApiError)) return 'accountSecurity.password.error.unknown'
  if (error.code === 'CurrentPasswordIncorrect') return 'accountSecurity.password.error.current'
  if (error.code === 'InvalidNewPassword') return 'passwordReset.error.passwordPolicy'
  if (error.code === 'AccountSecurityRateLimited' || error.status === 429) {
    return 'passwordReset.error.rateLimited'
  }
  return 'accountSecurity.password.error.unknown'
}
