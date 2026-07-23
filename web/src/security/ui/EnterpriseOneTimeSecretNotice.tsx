import { useMemo, useState } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'

/**
 * Props for the one-time SCIM or service-account secret notice.
 */
export type EnterpriseOneTimeSecretNoticeProps = {
  /** Purpose of the issued secret. */
  kind: 'scim' | 'service-account'
  /** Connection or account label associated with the secret. */
  label: string
  /** Locale used to render the notice. */
  locale: Locale
  /** Bearer token returned only by the create or rotate response. */
  token: string
  /** Discards the secret from React state. */
  onDismiss: () => void
}

/**
 * Displays a bearer token only in the component generation that received it.
 *
 * @param props - Secret metadata, token, locale, and dismissal callback.
 * @returns The one-time secret notice.
 */
export function EnterpriseOneTimeSecretNotice({
  kind,
  label,
  locale,
  token,
  onDismiss,
}: EnterpriseOneTimeSecretNoticeProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [copied, setCopied] = useState(false)

  /** Copies the displayed token without persisting it in durable state. */
  const copyToken = async () => {
    if (!navigator.clipboard?.writeText) {
      return
    }

    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section
      className="rounded-lg border border-amber-300 bg-amber-50 p-4"
      data-testid="enterprise-security-one-time-secret"
      role="status"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-amber-950">
            {t('security.secret.title')} · {label}
          </h3>
          <p className="mt-1 text-xs font-medium leading-5 text-amber-900">
            {t(
              kind === 'scim'
                ? 'security.secret.scimDescription'
                : 'security.secret.serviceAccountDescription',
            )}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          data-testid="enterprise-security-secret-dismiss"
          type="button"
          onClick={onDismiss}
        >
          {t('security.action.close')}
        </button>
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-white px-3 py-3">
        <code className="min-w-0 flex-1 break-all text-sm font-semibold text-[var(--workbench-text)]">
          {token}
        </code>
        <button
          className="workbench-button-secondary min-h-9 flex-none px-3"
          type="button"
          onClick={() => void copyToken()}
        >
          {t(copied ? 'security.action.copied' : 'security.action.copy')}
        </button>
      </div>
    </section>
  )
}
