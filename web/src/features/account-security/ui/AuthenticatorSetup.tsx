import { useMemo, useState, type FormEvent } from 'react'
import { renderSVG } from 'uqr'
import {
  ApiError,
  createTotpKeyUri,
  type SoftwareTokenSetupStart,
} from '../../../auth/api'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { copyTextToClipboard } from '../../../shared/lib/publicPage'

/**
 * Props of {@link AuthenticatorSetup}.
 */
export type AuthenticatorSetupProps = {
  /** Translates a message key. */
  t: (key: MessageKey) => string
  /** Starts registration and returns the shared secret. */
  onStart: () => Promise<SoftwareTokenSetupStart>
  /** Finishes registration with the code from the app. */
  onVerify: (code: string, setup: SoftwareTokenSetupStart) => Promise<void>
  /** Leaves the setup without registering, when the caller offers a way back. */
  onCancel?: () => void
  /** Label of the cancel button. Defaults to "Cancel". */
  cancelLabel?: string
  /** Secret shown at first render; Storybook and tests use it to skip the start step. */
  initialSetup?: SoftwareTokenSetupStart
}

/**
 * Walks the user through registering an authenticator app (TOTP): start, scan the QR code or
 * type the key, then confirm with a code from the app.
 *
 * The component owns no API calls. The caller decides whether registration runs for a signed-in
 * user, a sign-in setup token, or Cognito's MFA_SETUP challenge.
 *
 * @param props - Callbacks and translation.
 * @returns The setup steps.
 */
export function AuthenticatorSetup({
  t,
  onStart,
  onVerify,
  onCancel,
  cancelLabel,
  initialSetup,
}: AuthenticatorSetupProps) {
  const [setup, setSetup] = useState<SoftwareTokenSetupStart | undefined>(initialSetup)
  const [code, setCode] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey | undefined>()
  const [copied, setCopied] = useState(false)
  const qrCodeSource = useMemo(() => {
    if (!setup) return undefined
    const svg = renderSVG(createTotpKeyUri(setup), { border: 2 })
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }, [setup])

  /** Starts registration and shows the secret. */
  const start = async () => {
    if (isBusy) return
    setIsBusy(true)
    setErrorKey(undefined)
    try {
      setSetup(await onStart())
    } catch (error) {
      setErrorKey(resolveAuthenticatorSetupErrorKey(error))
    } finally {
      setIsBusy(false)
    }
  }

  /** Confirms registration with the code from the app. */
  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!setup || isBusy) return
    if (!/^\d{6}$/u.test(code)) {
      setErrorKey('mfaSetup.error.code')
      return
    }
    setIsBusy(true)
    setErrorKey(undefined)
    try {
      await onVerify(code, setup)
    } catch (error) {
      setErrorKey(resolveAuthenticatorSetupErrorKey(error))
      setCode('')
    } finally {
      setIsBusy(false)
    }
  }

  /** Copies the shared secret for manual entry. */
  const copyKey = async () => {
    if (!setup) return
    try {
      await copyTextToClipboard(setup.secretCode)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const errorMessage = errorKey ? (
    <p
      className="m-0 rounded-lg border border-tone-ffd2d2 bg-tone-fff5f5 px-4 py-3 text-sm font-bold leading-6 text-fg-b42318"
      id="authenticator-setup-error"
      role="alert"
    >
      {t(errorKey)}
    </p>
  ) : null

  const cancelButton = onCancel ? (
    <button
      className="workbench-button-secondary min-h-11 cursor-pointer px-4 disabled:opacity-60"
      disabled={isBusy}
      type="button"
      onClick={onCancel}
    >
      {cancelLabel ?? t('mfaSetup.cancel')}
    </button>
  ) : null

  if (!setup) {
    return (
      <div className="grid gap-4" data-testid="authenticator-setup">
        <p className="m-0 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('mfaSetup.intro')}
        </p>
        {errorMessage}
        <div className="flex flex-wrap gap-3">
          <button
            className="workbench-button-primary min-h-11 cursor-pointer px-5 disabled:cursor-not-allowed disabled:opacity-70"
            disabled={isBusy}
            type="button"
            onClick={() => void start()}
          >
            {isBusy ? t('mfaSetup.starting') : t('mfaSetup.start')}
          </button>
          {cancelButton}
        </div>
      </div>
    )
  }

  return (
    <form className="grid gap-5" data-testid="authenticator-setup" onSubmit={(event) => void verify(event)}>
      <div className="grid gap-3">
        <p className="m-0 text-sm font-semibold text-[var(--workbench-text)]">{t('mfaSetup.scanStep')}</p>
        <div className="flex flex-wrap items-center gap-4">
          {qrCodeSource ? (
            <img
              alt={t('mfaSetup.qrAlt')}
              className="h-44 w-44 rounded-lg border border-[var(--workbench-border)] bg-white p-1"
              height={176}
              src={qrCodeSource}
              width={176}
            />
          ) : null}
          <div className="grid min-w-0 flex-1 gap-2">
            <p className="m-0 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('mfaSetup.manualKey')}
            </p>
            <code
              className="block break-all rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2 font-mono text-sm tracking-wider text-[var(--workbench-text)]"
              data-testid="authenticator-secret"
            >
              {formatSecret(setup.secretCode)}
            </code>
            <button
              className="workbench-button-secondary min-h-9 w-fit cursor-pointer px-3 text-sm"
              type="button"
              onClick={() => void copyKey()}
            >
              {copied ? t('mfaSetup.copied') : t('mfaSetup.copyKey')}
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        <label className="w-fit text-sm font-semibold text-[var(--workbench-text)]" htmlFor="authenticator-code">
          {t('mfaSetup.codeStep')}
        </label>
        <input
          aria-describedby={errorKey ? 'authenticator-setup-error' : undefined}
          aria-invalid={errorKey ? true : undefined}
          autoComplete="one-time-code"
          className="workbench-input min-h-12 w-full max-w-[240px] px-3.5 font-mono text-lg tracking-[0.3em]"
          disabled={isBusy}
          id="authenticator-code"
          inputMode="numeric"
          maxLength={6}
          name="authenticator-code"
          pattern="[0-9]*"
          placeholder={t('mfaSetup.codePlaceholder')}
          value={code}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/gu, '').slice(0, 6))
            setErrorKey(undefined)
          }}
        />
      </div>

      {errorMessage}

      <div className="flex flex-wrap gap-3">
        <button
          className="workbench-button-primary min-h-11 cursor-pointer px-5 disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isBusy}
          type="submit"
        >
          {isBusy ? t('mfaSetup.verifying') : t('mfaSetup.verify')}
        </button>
        {cancelButton}
      </div>
    </form>
  )
}

/**
 * Groups a Base32 secret into blocks of four for easier manual entry.
 *
 * @param secret - Base32 secret.
 * @returns The grouped secret.
 */
function formatSecret(secret: string) {
  return secret.replace(/(.{4})(?=.)/gu, '$1 ')
}

/**
 * Maps a failed authenticator setup call to a message.
 *
 * @param error - Error from the API.
 * @returns The message key.
 */
function resolveAuthenticatorSetupErrorKey(error: unknown): MessageKey {
  if (!(error instanceof ApiError)) return 'mfaSetup.error.unavailable'
  if (error.code === 'MfaCodeInvalid') return 'mfaSetup.error.invalid'
  if (error.code === 'AccountSecurityRateLimited' || error.status === 429) {
    return 'mfaSetup.error.rateLimited'
  }
  if (error.code === 'MfaAlreadyEnabled') return 'mfaSetup.error.alreadyEnabled'
  if (error.status === 401) return 'mfaSetup.error.expired'
  return 'mfaSetup.error.unavailable'
}
