import { useMemo, useState } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import type { EnterpriseDomainVerificationChallenge } from '../api'

/**
 * Props for the one-time domain verification challenge notice.
 */
export type EnterpriseDomainVerificationChallengeNoticeProps = {
  /** Challenge containing the DNS record name and one-time value. */
  challenge: EnterpriseDomainVerificationChallenge
  /** Locale used to render the notice. */
  locale: Locale
  /** Discards the challenge from React state. */
  onDismiss: () => void
}

/**
 * Displays the DNS TXT record value only after a domain claim is created.
 *
 * @param props - Challenge data, locale, and dismissal callback.
 * @returns The one-time domain verification notice.
 */
export function EnterpriseDomainVerificationChallengeNotice({
  challenge,
  locale,
  onDismiss,
}: EnterpriseDomainVerificationChallengeNoticeProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [copied, setCopied] = useState(false)

  /** Copies the one-time DNS value without persisting it outside this view. */
  const copyVerificationValue = async () => {
    if (!navigator.clipboard?.writeText) {
      return
    }

    try {
      await navigator.clipboard.writeText(challenge.verificationRecordValue)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section
      className="rounded-lg border border-sky-300 bg-sky-50 p-4"
      data-testid="enterprise-domain-verification-challenge"
      role="status"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-sky-950">
            {t('security.domainChallenge.title').replace(
              '{domain}',
              challenge.domain.domain,
            )}
          </h3>
          <p className="mt-1 text-xs font-medium leading-5 text-sky-900">
            {t('security.domainChallenge.description')}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          type="button"
          onClick={onDismiss}
        >
          {t('security.action.close')}
        </button>
      </div>
      <dl className="mt-3 grid gap-3 rounded-lg border border-sky-300 bg-white px-3 py-3">
        <div>
          <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
            {t('security.domainChallenge.recordName')}
          </dt>
          <dd className="mt-1">
            <code className="break-all text-sm font-semibold text-[var(--workbench-text)]">
              {challenge.domain.verificationRecordName}
            </code>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-[var(--workbench-muted)]">
            {t('security.domainChallenge.recordValue')}
          </dt>
          <dd className="mt-1 flex min-w-0 flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 break-all text-sm font-semibold text-[var(--workbench-text)]">
              {challenge.verificationRecordValue}
            </code>
            <button
              className="workbench-button-secondary min-h-9 flex-none px-3"
              type="button"
              onClick={() => void copyVerificationValue()}
            >
              {t(copied ? 'security.action.copied' : 'security.action.copy')}
            </button>
          </dd>
        </div>
      </dl>
    </section>
  )
}
