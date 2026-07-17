import type {
  RequestAnswerValue,
  RequestLocale,
  RequestRequesterReplyReceipt,
  RequestRequesterThread,
  RequestSubmissionReceipt,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { createMutationRequestRunner } from '../api/mutationHeaders'
import { getAuthSession } from '../auth/session'
import {
  createTranslator,
  getInitialLocale,
  setLocalePreference,
  type Locale,
} from '../i18n'
import { PublicPageShell } from '../pages/PublicPageShell'
import {
  createRequestAttachmentUpload,
  getPublicRequestForm,
  getRequestThread,
  putRequestAttachment,
  replyToRequestThread,
  RequestIntakeApiError,
  submitPublicRequest,
} from './api'
import {
  normalizePublicRequestForm,
  type PublicRequestFormModel,
  type RequestBuilderField,
} from './model'
import {
  filterVisibleRequestAnswers,
  getVisibleRequestFieldIds,
  isCurrentPublicRequestFormRequest,
  resolveRequestFormLocale,
  resolveRequestLocalizedText,
  selectRequestAttachmentClaims,
  updatePendingRequestAttachmentFields,
  validateVisibleRequestAnswers,
} from './requestFormLogic'

const publicRequestSessionRenewalLeadMs = 30_000

function hasUsablePublicRequestSession(form: PublicRequestFormModel) {
  const expiresAt = Date.parse(form.sessionExpiresAt)
  return Number.isFinite(expiresAt)
    && expiresAt - Date.now() > publicRequestSessionRenewalLeadMs
}

/**
 * PublicRequestFormScreen の入力です。
 */
export type PublicRequestFormScreenProps = {
  /**
   * Public serializer だけから構築した form model です。
   */
  form: PublicRequestFormModel
  /**
   * 現在選択されている locale です。
   */
  locale: RequestLocale
  /**
   * Locale selector 変更 callback です。
   */
  onLocaleChange: (locale: RequestLocale) => void
  /**
   * Form card 内にも locale selector を表示するかどうかです。
   */
  showLocaleSelector?: boolean
  /**
   * Attachment field の direct upload callback です。
   */
  onUploadAttachment?: (fieldId: string, file: File) => Promise<string>
  /**
   * Visible answers と consent を保存する callback です。
   */
  onSubmit: (
    answers: Record<string, RequestAnswerValue>,
    consentAccepted: boolean,
    honeypot: string,
  ) => Promise<RequestSubmissionReceipt>
  /**
   * Receipt の capability token を使って同じ request thread へ追記する callback です。
   */
  onReply?: (
    threadToken: string,
    body: string,
  ) => Promise<RequestRequesterReplyReceipt>
  /**
   * Opaque capability から requester 向け thread view を再取得する callback です。
   */
  onLoadThread?: (threadToken: string) => Promise<RequestRequesterThread>
  /**
   * Storybook などで固定する initial answer です。
   */
  initialAnswers?: Record<string, RequestAnswerValue>
  /**
   * Storybook などで固定する成功 receipt です。
   */
  initialReceipt?: RequestSubmissionReceipt
}

/**
 * Opaque link token から公開 DTO を取得し、routing/permission 非依存の form を描画します。
 */
export function PublicRequestFormPage() {
  const params = useParams()
  const linkToken = params.linkToken ?? ''

  return <PublicRequestFormPageForLink key={linkToken} linkToken={linkToken} />
}

function PublicRequestFormPageForLink({ linkToken }: { linkToken: string }) {
  const location = useLocation()
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const activeFormRef = useRef<PublicRequestFormModel | undefined>(undefined)
  const activeFormLinkTokenRef = useRef('')
  const activeLinkTokenRef = useRef(linkToken)
  const attachmentClaimsRef = useRef(new Map<string, string>())
  const formRequestGenerationRef = useRef(0)
  const sessionRenewalRef = useRef<Promise<PublicRequestFormModel> | undefined>(undefined)
  const [session] = useState(() => getAuthSession())
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale())
  const initialLocaleRef = useRef(locale)
  const [form, setForm] = useState<PublicRequestFormModel>()
  const [formWasUpdated, setFormWasUpdated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [resolvedLinkToken, setResolvedLinkToken] = useState('')
  const [error, setError] = useState<'login' | 'unavailable' | 'rate-limit'>()
  const t = useMemo(() => createTranslator(locale), [locale])

  useEffect(() => {
    let cancelled = false
    const requestGeneration = formRequestGenerationRef.current + 1
    formRequestGenerationRef.current = requestGeneration
    activeLinkTokenRef.current = linkToken
    activeFormRef.current = undefined
    activeFormLinkTokenRef.current = ''
    attachmentClaimsRef.current.clear()
    sessionRenewalRef.current = undefined

    void getPublicRequestForm(linkToken, session?.accessToken)
      .then((response) => {
        if (
          cancelled ||
          !isCurrentPublicRequestFormRequest(
            linkToken,
            requestGeneration,
            activeLinkTokenRef.current,
            formRequestGenerationRef.current,
          )
        ) return
        const normalized = normalizePublicRequestForm(response)
        activeFormRef.current = normalized
        activeFormLinkTokenRef.current = linkToken
        setError(undefined)
        setForm(normalized)
        setFormWasUpdated(false)
        setResolvedLinkToken(linkToken)
        const nextLocale = resolveRequestFormLocale(
          normalized,
          initialLocaleRef.current,
        ) as RequestLocale
        setLocale(nextLocale)
      })
      .catch((reason: unknown) => {
        if (
          cancelled ||
          !isCurrentPublicRequestFormRequest(
            linkToken,
            requestGeneration,
            activeLinkTokenRef.current,
            formRequestGenerationRef.current,
          )
        ) return
        setResolvedLinkToken(linkToken)
        setForm(undefined)
        setFormWasUpdated(false)
        if (reason instanceof RequestIntakeApiError && reason.status === 401) {
          setError('login')
        } else if (reason instanceof RequestIntakeApiError && reason.status === 429) {
          setError('rate-limit')
        } else {
          setError('unavailable')
        }
      })
      .finally(() => {
        if (
          !cancelled &&
          isCurrentPublicRequestFormRequest(
            linkToken,
            requestGeneration,
            activeLinkTokenRef.current,
            formRequestGenerationRef.current,
          )
        ) setIsLoading(false)
      })

    return () => {
      cancelled = true
      formRequestGenerationRef.current += 1
      activeLinkTokenRef.current = ''
      activeFormRef.current = undefined
      activeFormLinkTokenRef.current = ''
      sessionRenewalRef.current = undefined
    }
  }, [linkToken, session?.accessToken])

  const handleLocaleChange = (nextLocale: RequestLocale) => {
    const resolvedLocale = form
      ? resolveRequestFormLocale(form, nextLocale) as RequestLocale
      : nextLocale
    setLocale(resolvedLocale)
    setLocalePreference(resolvedLocale)
  }

  const renewPublicFormSession = () => {
    if (sessionRenewalRef.current) return sessionRenewalRef.current

    const requestGeneration = formRequestGenerationRef.current
    const requestedLinkToken = linkToken
    const renewal = getPublicRequestForm(linkToken, session?.accessToken)
      .then((response) => {
        if (!isCurrentPublicRequestFormRequest(
          requestedLinkToken,
          requestGeneration,
          activeLinkTokenRef.current,
          formRequestGenerationRef.current,
        )) {
          throw new Error('The public request form route changed while renewing its session.')
        }
        const normalized = normalizePublicRequestForm(response)
        const previous = activeFormRef.current
        activeFormRef.current = normalized
        activeFormLinkTokenRef.current = requestedLinkToken
        setForm(normalized)
        setLocale((current) => resolveRequestFormLocale(
          normalized,
          current,
        ) as RequestLocale)
        if (previous && previous.version !== normalized.version) {
          attachmentClaimsRef.current.clear()
          setFormWasUpdated(true)
          throw new Error('The request form was updated. Review the new version before submitting.')
        }
        return normalized
      })
      .finally(() => {
        if (sessionRenewalRef.current === renewal) {
          sessionRenewalRef.current = undefined
        }
      })
    sessionRenewalRef.current = renewal
    return renewal
  }

  const ensureFreshRequestForm = () => {
    const activeForm = activeFormRef.current
    if (!activeForm || activeFormLinkTokenRef.current !== linkToken) {
      throw new Error('Public request form is not loaded.')
    }
    return hasUsablePublicRequestSession(activeForm)
      ? Promise.resolve(activeForm)
      : renewPublicFormSession()
  }

  const loginPath = `/?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`
  const isResolvingCurrentLink = isLoading || resolvedLinkToken !== linkToken

  return (
    <PublicPageShell
      locale={locale}
      titleKey="requests.public.pageTitle"
      onLocaleChange={(nextLocale) => handleLocaleChange(nextLocale)}
    >
      {() => (
        <div className="mx-auto w-full max-w-[860px] px-5 py-10 sm:px-8 sm:py-14">
          {isResolvingCurrentLink ? (
            <div className="workbench-panel grid min-h-64 place-items-center p-8 text-sm font-semibold text-[var(--workbench-muted)]">
              {t('requests.public.loading')}
            </div>
          ) : error ? (
            <div className="workbench-panel p-8 text-center">
              <h1 className="text-2xl font-semibold text-[var(--workbench-text)]">
                {error === 'login'
                  ? t('requests.public.loginRequired')
                  : error === 'rate-limit'
                    ? t('requests.public.rateLimited')
                    : t('requests.public.unavailable')}
              </h1>
              {error === 'login' ? (
                <Link className="workbench-button-primary mt-6 inline-flex min-h-10 items-center justify-center px-5 no-underline" to={loginPath}>
                  {t('requests.public.login')}
                </Link>
              ) : null}
            </div>
          ) : form ? (
            <>
              {formWasUpdated ? (
                <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900" role="status">
                  {t('requests.public.formUpdated')}
                </p>
              ) : null}
              <PublicRequestFormScreen
              form={form}
              key={`${form.formId}:${form.version}`}
              locale={locale}
              onLocaleChange={handleLocaleChange}
              showLocaleSelector={false}
              onUploadAttachment={async (fieldId, file) => {
                const activeForm = await ensureFreshRequestForm()
                const sessionResult = await mutationRunner.run(
                  `request-attachment:${fieldId}:${file.name}:${file.size}`,
                  JSON.stringify([activeForm.sessionToken, fieldId, file.name, file.size, file.type]),
                  (context) => createRequestAttachmentUpload(
                    linkToken,
                    {
                      contentType: file.type || 'application/octet-stream',
                      fieldId,
                      fileName: file.name,
                      sessionToken: activeForm.sessionToken,
                      sizeBytes: file.size,
                    },
                    context,
                    session?.accessToken,
                  ),
                )
                await putRequestAttachment(sessionResult, file)
                attachmentClaimsRef.current.set(
                  sessionResult.attachmentId,
                  sessionResult.claimToken,
                )
                return sessionResult.attachmentId
              }}
              onSubmit={async (answers, consentAccepted, honeypot) => {
                const activeForm = await ensureFreshRequestForm()
                await waitForMinimumSubmitAt(activeForm.minimumSubmitAt)
                const attachmentClaims = selectRequestAttachmentClaims(
                  activeForm,
                  answers,
                  attachmentClaimsRef.current,
                )
                return mutationRunner.run(
                  'public-request:submit',
                  JSON.stringify([activeForm.sessionToken, locale, answers, consentAccepted, honeypot]),
                  (context) => submitPublicRequest(
                    linkToken,
                    {
                      answers,
                      ...(Object.keys(attachmentClaims).length > 0 ? { attachmentClaims } : {}),
                      consentAccepted,
                      honeypot: honeypot || undefined,
                      locale,
                      sessionToken: activeForm.sessionToken,
                    },
                    context,
                    session?.accessToken,
                  ),
                )
              }}
              onReply={(threadToken, body) => mutationRunner.run(
                `request-thread:reply:${threadToken}`,
                body,
                (context) => replyToRequestThread(
                  threadToken,
                  { body },
                  context,
                ),
              )}
              onLoadThread={getRequestThread}
              />
            </>
          ) : null}
        </div>
      )}
    </PublicPageShell>
  )
}

/**
 * Locale/conditional/validation/consent/attachment を含む公開 form presentation です。
 */
export function PublicRequestFormScreen({
  form,
  initialAnswers = {},
  initialReceipt,
  locale,
  onLocaleChange,
  onLoadThread,
  onReply,
  onSubmit,
  onUploadAttachment,
  showLocaleSelector = true,
}: PublicRequestFormScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [answers, setAnswers] = useState<Record<string, RequestAnswerValue>>(initialAnswers)
  const [consentAccepted, setConsentAccepted] = useState(false)
  const [honeypot, setHoneypot] = useState('')
  const [receipt, setReceipt] = useState<RequestSubmissionReceipt | undefined>(initialReceipt)
  const [validationCodes, setValidationCodes] = useState<Record<string, string>>({})
  const [uploadingFieldIds, setUploadingFieldIds] = useState<ReadonlySet<string>>(() => new Set())
  const [uploadErrorFieldId, setUploadErrorFieldId] = useState<string>()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<'generic' | 'rate-limit'>()
  const [fileNamesByField, setFileNamesByField] = useState<Record<string, string[]>>({})
  const [replyBody, setReplyBody] = useState('')
  const [replyReceipt, setReplyReceipt] = useState<RequestRequesterReplyReceipt>()
  const [isReplying, setIsReplying] = useState(false)
  const [replyError, setReplyError] = useState(false)
  const [thread, setThread] = useState<RequestRequesterThread>()
  const [threadError, setThreadError] = useState(false)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const visibleFieldIds = new Set(getVisibleRequestFieldIds(form, answers))
  const minimumSubmitTime = Date.parse(form.minimumSubmitAt)
  const submitDelayMs = Number.isFinite(minimumSubmitTime)
    ? Math.max(0, minimumSubmitTime - currentTime)
    : 0
  const submitDelaySeconds = Math.ceil(submitDelayMs / 1_000)

  useEffect(() => {
    if (submitDelayMs <= 0) return

    const timeout = window.setTimeout(
      () => setCurrentTime(Date.now()),
      Math.min(1_000, submitDelayMs),
    )
    return () => window.clearTimeout(timeout)
  }, [form.minimumSubmitAt, submitDelayMs])

  useEffect(() => {
    if (!receipt || !onLoadThread) return
    let cancelled = false
    const loadThread = () => {
      void onLoadThread(receipt.threadToken).then((nextThread) => {
        if (cancelled) return
        setThread(nextThread)
        setThreadError(false)
      }).catch(() => {
        if (!cancelled) setThreadError(true)
      })
    }
    loadThread()
    const interval = window.setInterval(loadThread, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [onLoadThread, receipt])

  const updateAnswer = (fieldId: string, value: RequestAnswerValue) => {
    setAnswers((current) => ({ ...current, [fieldId]: value }))
    setValidationCodes((current) => {
      const next = { ...current }
      delete next[fieldId]
      return next
    })
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSubmitting || uploadingFieldIds.size > 0 || submitDelayMs > 0) return

    const visibleAnswers = filterVisibleRequestAnswers(form, answers)
    const validationErrors = validateVisibleRequestAnswers(form, visibleAnswers)
    if (form.consent.required && !consentAccepted) {
      validationErrors.push({ code: 'required', fieldId: '__consent' })
    }

    if (validationErrors.length > 0) {
      setValidationCodes(Object.fromEntries(validationErrors.map((error) => [error.fieldId, error.code])))
      return
    }

    setIsSubmitting(true)
    setSubmitError(undefined)
    try {
      setReceipt(await onSubmit(visibleAnswers, consentAccepted, honeypot))
    } catch (reason) {
      setSubmitError(
        reason instanceof RequestIntakeApiError && reason.status === 429
          ? 'rate-limit'
          : 'generic',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const body = replyBody.trim()
    if (!receipt || !onReply || !body || isReplying) return

    setIsReplying(true)
    setReplyError(false)
    try {
      setReplyReceipt(await onReply(receipt.threadToken, body))
      setReplyBody('')
      if (onLoadThread) {
        try {
          setThread(await onLoadThread(receipt.threadToken))
          setThreadError(false)
        } catch {
          setThreadError(true)
        }
      }
    } catch {
      setReplyError(true)
    } finally {
      setIsReplying(false)
    }
  }

  if (receipt) {
    return (
      <section className="workbench-panel p-8 text-center" data-testid="public-request-confirmation">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✓</div>
        <h1 className="mt-5 text-2xl font-semibold text-[var(--workbench-text)]">
          {receipt.confirmationMessage || resolveRequestLocalizedText(form.confirmation, locale, form.defaultLocale)}
        </h1>
        <p className="mt-4 text-sm font-semibold text-[var(--workbench-muted)]">
          {t('requests.public.receipt').replace('{id}', receipt.receiptId)}
        </p>
        {thread?.messages.length ? (
          <div className="mx-auto mt-7 grid max-w-[620px] gap-3 border-t border-[var(--workbench-border)] pt-6 text-left">
            <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{t('requests.public.threadTitle')}</h2>
            {thread.messages.map((message) => (
              <article className="rounded-lg border border-[var(--workbench-border)] bg-white px-4 py-3" key={message.id}>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                  {message.direction === 'staff'
                    ? t('requests.public.threadStaff')
                    : t('requests.public.threadRequester')}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--workbench-text)]">{message.body}</p>
              </article>
            ))}
          </div>
        ) : null}
        {threadError ? <p className="mt-4 text-sm font-semibold text-red-700" role="alert">{t('requests.public.threadError')}</p> : null}
        {onReply && thread?.status !== 'closed' ? (
          <form className="mx-auto mt-7 grid max-w-[620px] gap-3 border-t border-[var(--workbench-border)] pt-6 text-left" onSubmit={(event) => void handleReply(event)}>
            <div>
              <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{t('requests.public.replyTitle')}</h2>
              <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('requests.public.replyDescription')}</p>
            </div>
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('requests.public.replyLabel')}
              <textarea
                className="workbench-input min-h-28 px-3 py-2"
                maxLength={4_000}
                placeholder={t('requests.public.replyPlaceholder')}
                required
                value={replyBody}
                onChange={(event) => {
                  setReplyBody(event.target.value)
                  setReplyError(false)
                }}
              />
            </label>
            {replyReceipt ? <p className="text-sm font-semibold text-emerald-700" role="status">{t('requests.public.replySuccess')}</p> : null}
            {replyError ? <p className="text-sm font-semibold text-red-700" role="alert">{t('requests.public.replyError')}</p> : null}
            <button className="workbench-button-primary min-h-11 justify-self-end px-5" disabled={isReplying} type="submit">
              {isReplying ? t('requests.public.replySubmitting') : t('requests.public.replySubmit')}
            </button>
          </form>
        ) : null}
        {form.redirectUrl ? (
          <a className="workbench-button-primary mt-6 inline-flex min-h-10 items-center justify-center px-5 no-underline" href={form.redirectUrl} rel="noreferrer noopener">
            {form.redirectUrl}
          </a>
        ) : null}
      </section>
    )
  }

  return (
    <form className="workbench-panel overflow-hidden" data-testid="public-request-form" onSubmit={(event) => void handleSubmit(event)}>
      <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-6 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-[620px]">
            <p className="workbench-eyebrow">mukuroji request</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--workbench-text)]">
              {resolveRequestLocalizedText(form.title, locale, form.defaultLocale)}
            </h1>
            <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {resolveRequestLocalizedText(form.description, locale, form.defaultLocale)}
            </p>
          </div>
          {showLocaleSelector ? (
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('language.aria')}
              <select className="workbench-input min-h-10 px-3" value={locale} onChange={(event) => onLocaleChange(event.target.value as RequestLocale)}>
                {form.locales.map((candidate) => <option key={candidate} value={candidate}>{candidate.toUpperCase()}</option>)}
              </select>
            </label>
          ) : null}
        </div>
      </div>

      <div className="grid gap-7 p-6 sm:p-8">
        {form.sections.map((section) => {
          const visibleFields = section.fields.filter((field) => visibleFieldIds.has(field.id))
          if (visibleFields.length === 0) return null

          return (
            <fieldset className="grid gap-4 border-0" key={section.id}>
              <legend className="text-xl font-semibold text-[var(--workbench-text)]">
                {resolveRequestLocalizedText(section.title, locale, form.defaultLocale)}
              </legend>
              <p className="-mt-2 whitespace-pre-wrap text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {resolveRequestLocalizedText(section.description, locale, form.defaultLocale)}
              </p>
              {visibleFields.map((field) => (
                <PublicField
                  answer={answers[field.id]}
                  errorCode={validationCodes[field.id]}
                  field={field}
                  fileNames={fileNamesByField[field.id] ?? []}
                  form={form}
                  isUploading={uploadingFieldIds.has(field.id)}
                  key={field.id}
                  locale={locale}
                  t={t}
                  uploadError={uploadErrorFieldId === field.id}
                  onChange={(value) => updateAnswer(field.id, value)}
                  onFiles={async (files) => {
                    if (!onUploadAttachment || files.length === 0) return
                    setUploadingFieldIds((current) =>
                      updatePendingRequestAttachmentFields(current, field.id, true)
                    )
                    setUploadErrorFieldId(undefined)
                    try {
                      const existingAnswer = answers[field.id]
                      const attachmentIds = Array.isArray(existingAnswer)
                        ? existingAnswer.filter((value): value is string => typeof value === 'string')
                        : []
                      const fileNames = [...(fileNamesByField[field.id] ?? [])]
                      for (const file of files) {
                        attachmentIds.push(await onUploadAttachment(field.id, file))
                        fileNames.push(file.name)
                        updateAnswer(field.id, [...attachmentIds])
                        setFileNamesByField((current) => ({
                          ...current,
                          [field.id]: [...fileNames],
                        }))
                      }
                    } catch {
                      setUploadErrorFieldId(field.id)
                    } finally {
                      setUploadingFieldIds((current) =>
                        updatePendingRequestAttachmentFields(current, field.id, false)
                      )
                    }
                  }}
                />
              ))}
            </fieldset>
          )
        })}

        {form.consent.required || resolveRequestLocalizedText(form.consent.text, locale, form.defaultLocale) ? (
          <div className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
            <label className="flex items-start gap-3 text-sm font-semibold leading-6 text-[var(--workbench-text)]">
              <input checked={consentAccepted} className="mt-1 h-4 w-4 flex-none accent-[var(--workbench-primary)]" onChange={(event) => {
                setConsentAccepted(event.target.checked)
                setValidationCodes((current) => ({ ...current, __consent: '' }))
              }} type="checkbox" />
              <span>
                {resolveRequestLocalizedText(form.consent.text, locale, form.defaultLocale)}
                {form.consent.privacyUrl ? <a className="ml-2 text-[var(--workbench-primary)] underline" href={form.consent.privacyUrl} rel="noreferrer noopener" target="_blank">{t('requests.public.privacy')}</a> : null}
              </span>
            </label>
            {validationCodes.__consent ? <p className="mt-2 text-sm font-semibold text-red-700" role="alert">{t('requests.public.required')}</p> : null}
          </div>
        ) : null}

        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label>
            Company website
            <input autoComplete="off" tabIndex={-1} value={honeypot} onChange={(event) => setHoneypot(event.target.value)} />
          </label>
        </div>

        {submitError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
            {submitError === 'rate-limit' ? t('requests.public.rateLimited') : t('requests.public.submitError')}
          </p>
        ) : null}

        <button className="workbench-button-primary min-h-12 justify-self-end px-7" disabled={isSubmitting || uploadingFieldIds.size > 0 || submitDelayMs > 0} type="submit">
          {isSubmitting
            ? t('requests.public.submitting')
            : submitDelayMs > 0
              ? t('requests.public.submitAvailableIn').replace('{seconds}', String(submitDelaySeconds))
              : t('requests.public.submit')}
        </button>
      </div>
    </form>
  )
}

function PublicField({
  answer,
  errorCode,
  field,
  fileNames,
  form,
  isUploading,
  locale,
  onChange,
  onFiles,
  t,
  uploadError,
}: {
  answer?: RequestAnswerValue
  errorCode?: string
  field: RequestBuilderField
  fileNames: string[]
  form: PublicRequestFormModel
  isUploading: boolean
  locale: RequestLocale
  onChange: (value: RequestAnswerValue) => void
  onFiles: (files: File[]) => Promise<void>
  t: ReturnType<typeof createTranslator>
  uploadError: boolean
}) {
  const label = resolveRequestLocalizedText(field.label, locale, form.defaultLocale) || field.id
  const helpText = resolveRequestLocalizedText(field.description, locale, form.defaultLocale)
  const placeholder = resolveRequestLocalizedText(field.placeholder, locale, form.defaultLocale)
  const errorText = errorCode === 'required' ? t('requests.public.required') : t('requests.public.invalid')
  const commonInputClass = `workbench-input min-h-11 w-full px-3 ${errorCode ? 'border-red-400' : ''}`

  return (
    <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
      <span>{label}{field.required ? <span className="ml-1 text-red-700">*</span> : null}</span>
      {helpText ? <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">{helpText}</span> : null}
      {field.type === 'textarea' ? (
        <textarea className={`${commonInputClass} min-h-28 py-3`} maxLength={field.validation?.maxLength} minLength={field.validation?.minLength} placeholder={placeholder} value={typeof answer === 'string' ? answer : ''} onChange={(event) => onChange(event.target.value)} />
      ) : field.type === 'select' ? (
        <select className={commonInputClass} value={typeof answer === 'string' ? answer : ''} onChange={(event) => onChange(event.target.value)}>
          <option value="">—</option>
          {field.options.map((option) => <option key={option.id} value={option.id}>{resolveRequestLocalizedText(option.label, locale, form.defaultLocale)}</option>)}
        </select>
      ) : field.type === 'multi-select' ? (
        <select className={`${commonInputClass} min-h-28 py-2`} multiple value={Array.isArray(answer) ? answer : []} onChange={(event) => onChange(Array.from(event.target.selectedOptions).map((option) => option.value))}>
          {field.options.map((option) => <option key={option.id} value={option.id}>{resolveRequestLocalizedText(option.label, locale, form.defaultLocale)}</option>)}
        </select>
      ) : field.type === 'checkbox' ? (
        <span className="flex min-h-11 items-center gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3">
          <input checked={answer === true} className="h-4 w-4 accent-[var(--workbench-primary)]" onChange={(event) => onChange(event.target.checked)} type="checkbox" />
          {label}
        </span>
      ) : field.type === 'attachment' ? (
        <span className="grid gap-2">
          <input
            accept={form.attachmentPolicy.allowedContentTypes.join(',') || undefined}
            className={commonInputClass}
            disabled={!form.attachmentPolicy.enabled || isUploading}
            multiple={form.attachmentPolicy.maxFiles > 1}
            onChange={(event) => void onFiles(Array.from(event.target.files ?? []).slice(0, form.attachmentPolicy.maxFiles))}
            type="file"
          />
          {isUploading ? <span className="text-xs text-[var(--workbench-muted)]">{t('requests.public.uploading')}</span> : null}
          {uploadError ? <span className="text-xs text-red-700">{t('requests.public.uploadError')}</span> : null}
          {fileNames.length > 0 ? <span className="text-xs text-[var(--workbench-muted)]">{fileNames.join(', ')}</span> : null}
        </span>
      ) : (
        <input
          className={commonInputClass}
          max={field.validation?.max}
          maxLength={field.validation?.maxLength}
          min={field.validation?.min}
          minLength={field.validation?.minLength}
          pattern={field.validation?.pattern}
          placeholder={placeholder}
          type={field.type === 'text' ? 'text' : field.type}
          value={typeof answer === 'string' || typeof answer === 'number' ? answer : ''}
          onChange={(event) => onChange(
            field.type === 'number' && event.target.value !== ''
              ? Number(event.target.value)
              : event.target.value,
          )}
        />
      )}
      {errorCode ? <span className="text-xs font-semibold text-red-700" role="alert">{errorText}</span> : null}
    </label>
  )
}

async function waitForMinimumSubmitAt(minimumSubmitAt: string) {
  const minimumTime = Date.parse(minimumSubmitAt)
  if (!Number.isFinite(minimumTime)) return

  const delay = Math.max(0, minimumTime - Date.now())
  if (delay > 0) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, delay))
  }
}
