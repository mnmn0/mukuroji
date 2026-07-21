import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { copyTextToClipboard, isValidEmailAddress } from '../../shared/lib/publicPage'
import { PublicPageShell } from '../../features/public-site/ui/PublicPageShell'

/**
 * パスワード復旧ページの Storybook 初期状態です。
 */
type ForgotPasswordPageProps = {
  /**
   * 初期表示するメールアドレスです。
   */
  initialEmail?: string
  /**
   * 復旧案内を初期表示するかどうかです。
   */
  initialGuidanceVisible?: boolean
  /**
   * Storybook などで固定する初期 locale です。
   */
  initialLocale?: Locale
}

/**
 * 復旧依頼メモのコピー結果です。
 */
type CopyStatus = 'idle' | 'copied' | 'error'

/**
 * 復旧依頼メモのコピー結果と、その時点の本文です。
 */
type CopyResult = {
  /**
   * コピー処理の結果です。
   */
  status: Exclude<CopyStatus, 'idle'>
  /**
   * 結果が対応する復旧依頼メモ本文です。
   */
  value: string
}

const recoverySteps = [
  {
    titleKey: 'public.forgot.step.admin.title',
    descriptionKey: 'public.forgot.step.admin.description',
  },
  {
    titleKey: 'public.forgot.step.context.title',
    descriptionKey: 'public.forgot.step.context.description',
  },
  {
    titleKey: 'public.forgot.step.safe.title',
    descriptionKey: 'public.forgot.step.safe.description',
  },
] as const satisfies ReadonlyArray<{
  titleKey: MessageKey
  descriptionKey: MessageKey
}>

/**
 * 未接続の送信処理を装わず、管理者または正式なサポート窓口へ安全に連絡する方法を案内します。
 */
export function ForgotPasswordPage({
  initialEmail = '',
  initialGuidanceVisible = false,
  initialLocale,
}: ForgotPasswordPageProps = {}) {
  const [email, setEmail] = useState(initialEmail)
  const [isGuidanceVisible, setIsGuidanceVisible] = useState(initialGuidanceVisible)
  const [hasValidationError, setHasValidationError] = useState(false)
  const [copyResult, setCopyResult] = useState<CopyResult | undefined>()

  return (
    <PublicPageShell
      initialLocale={initialLocale}
      titleKey="public.forgot.title"
      onLocaleChange={() => setCopyResult(undefined)}
    >
      {({ t }) => {
        const normalizedEmail = email.trim()
        const requestTemplate = t('public.forgot.requestTemplate').replace(
          '{email}',
          normalizedEmail,
        )
        const copyStatus: CopyStatus = copyResult?.value === requestTemplate
          ? copyResult.status
          : 'idle'

        const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()

          if (!isValidEmailAddress(normalizedEmail)) {
            setHasValidationError(true)
            setIsGuidanceVisible(false)
            return
          }

          setHasValidationError(false)
          setCopyResult(undefined)
          setIsGuidanceVisible(true)
        }

        const handleCopy = async () => {
          try {
            await copyTextToClipboard(requestTemplate)
            setCopyResult({ status: 'copied', value: requestTemplate })
          } catch {
            setCopyResult({ status: 'error', value: requestTemplate })
          }
        }

        return (
          <div className="mx-auto grid w-full max-w-[1120px] gap-8 px-5 py-12 sm:px-8 sm:py-16 lg:grid-cols-[minmax(0,1.08fr)_minmax(340px,0.92fr)] lg:items-start lg:gap-14 lg:py-20">
            <section aria-labelledby="recovery-title" className="min-w-0">
              <p className="workbench-eyebrow mb-4">{t('public.forgot.eyebrow')}</p>
              <h1
                className="workbench-title m-0 max-w-[700px] text-[clamp(2.1rem,5vw,4.4rem)] leading-[1.02] tracking-[-0.035em]"
                id="recovery-title"
              >
                {t('public.forgot.title')}
              </h1>
              <p className="mt-6 max-w-[650px] text-base font-medium leading-8 text-[var(--workbench-muted)] sm:text-lg">
                {t('public.forgot.intro')}
              </p>

              <div className="mt-10 border-l border-[var(--workbench-border-strong)] pl-7 sm:pl-9">
                {recoverySteps.map((step, index) => (
                  <div
                    className="relative pb-9 last:pb-0"
                    key={step.titleKey}
                  >
                    <span className="absolute -left-[2.35rem] top-0 grid h-7 w-7 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-xs font-bold text-[var(--workbench-primary)] sm:-left-[2.65rem]">
                      {index + 1}
                    </span>
                    <h2 className="m-0 text-base font-bold text-[var(--workbench-text)]">
                      {t(step.titleKey)}
                    </h2>
                    <p className="mb-0 mt-2 max-w-[600px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                      {t(step.descriptionKey)}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section className="workbench-panel min-w-0 overflow-hidden" aria-labelledby="recovery-form-title">
              <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5 sm:px-7">
                <span className="workbench-badge-primary">{t('public.forgot.localOnly')}</span>
                <h2 className="mb-0 mt-3 text-xl font-bold tracking-[-0.015em] text-[var(--workbench-text)]" id="recovery-form-title">
                  {t('public.forgot.form.title')}
                </h2>
              </div>

              <div className="p-6 sm:p-7">
                <p className="mt-0 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                  {t('public.forgot.form.description')}
                </p>
                <form className="mt-6 grid gap-5" onSubmit={handleSubmit} noValidate>
                  <div className="grid gap-2">
                    <label className="text-sm font-bold text-[var(--workbench-text)]" htmlFor="recovery-email">
                      {t('public.forgot.email')}
                    </label>
                    <input
                      aria-describedby={hasValidationError ? 'recovery-email-error' : 'recovery-email-help'}
                      aria-invalid={hasValidationError}
                      autoComplete="email"
                      className="workbench-input min-h-12 w-full px-3.5 aria-invalid:border-[var(--workbench-danger)]"
                      id="recovery-email"
                      name="email"
                      placeholder={t('public.forgot.emailPlaceholder')}
                      type="email"
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value)
                        setHasValidationError(false)
                        setIsGuidanceVisible(false)
                        setCopyResult(undefined)
                      }}
                    />
                    <p className="m-0 text-app-meta leading-5 text-[var(--workbench-muted)]" id="recovery-email-help">
                      {t('public.forgot.emailHelp')}
                    </p>
                    {hasValidationError ? (
                      <p className="m-0 text-sm font-semibold text-[var(--workbench-danger)]" id="recovery-email-error" role="alert">
                        {t('public.forgot.emailError')}
                      </p>
                    ) : null}
                  </div>

                  <button className="workbench-button-primary min-h-12 cursor-pointer px-5" type="submit">
                    {t('public.forgot.reviewAction')}
                  </button>
                </form>
                <p className="sr-only" aria-live="polite" role="status">
                  {copyStatus === 'copied'
                    ? t('public.copy.copied')
                    : copyStatus === 'error'
                      ? t('public.copy.error')
                      : isGuidanceVisible
                        ? t('public.forgot.guidance.title')
                        : ''}
                </p>

                <div className="mt-6 rounded-lg border border-[#f4d6a6] bg-[#fffaf0] p-4 text-sm leading-6 text-[#7a4b0c]">
                  <strong className="block">{t('public.forgot.noSend.title')}</strong>
                  <span>{t('public.forgot.noSend.description')}</span>
                </div>

                {isGuidanceVisible ? (
                  <div className="mt-6 border-t border-[var(--workbench-border)] pt-6">
                    <h3 className="m-0 text-base font-bold text-[var(--workbench-text)]">
                      {t('public.forgot.guidance.title')}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-[var(--workbench-muted)]">
                      {t('public.forgot.guidance.description')}
                    </p>
                    <pre className="mt-4 whitespace-pre-wrap break-words rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4 font-[var(--sans)] text-sm leading-6 text-[var(--workbench-text)]">
                      {requestTemplate}
                    </pre>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <button
                        className="workbench-button-secondary min-h-11 cursor-pointer px-4"
                        type="button"
                        onClick={handleCopy}
                      >
                        {copyStatus === 'copied'
                          ? t('public.copy.copied')
                          : t('public.forgot.copyAction')}
                      </button>
                      <Link
                        className="workbench-button-primary inline-flex min-h-11 items-center justify-center px-4 no-underline"
                        to="/support?topic=access"
                      >
                        {t('public.forgot.supportAction')}
                      </Link>
                    </div>
                    {copyStatus === 'error' ? (
                      <p className="mb-0 mt-3 text-sm font-semibold text-[var(--workbench-danger)]">
                        {t('public.copy.error')}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <Link
                  className="mt-7 inline-flex text-sm font-bold text-[var(--workbench-primary)] no-underline hover:underline"
                  to="/"
                >
                  {t('public.backToLogin')}
                </Link>
              </div>
            </section>
          </div>
        )
      }}
    </PublicPageShell>
  )
}
