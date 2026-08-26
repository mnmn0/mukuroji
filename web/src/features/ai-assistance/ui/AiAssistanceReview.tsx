import type {
  AiAssistanceCitation,
  AiAssistanceDraft,
  AiAssistanceGeneration,
  CreateAiAssistanceFeedbackRequest,
} from '@mukuroji/contracts'
import { useId, type ReactNode } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { isSafeApplicationPath } from '../../../shared/routing/applicationPath'
import {
  CheckCircleIcon,
  ClockIcon,
  ExternalLinkIcon,
  ShieldIcon,
} from '../../../shared/ui/icons'
import type { AiAssistanceErrorKind } from '../mutations/useAiAssistanceController'
import { ConfidenceBadge } from './ConfidenceBadge'

/**
 * Permission-safe content passed to a workflow-specific draft renderer.
 *
 * The controller supplies this value only after the generation remains
 * authorized and all citations have passed the application-path guard.
 */
export type AiAssistanceAvailableReview = {
  /** Current citations that remain authorized for the viewer. */
  citations: readonly AiAssistanceCitation[]
  /** Structured draft validated by the server. */
  draft: AiAssistanceDraft
}

/**
 * Props for the reusable evidence-first AI draft review surface.
 *
 * Workflow integrations provide callbacks for review decisions and adoption;
 * this component never mutates a domain resource itself.
 */
export type AiAssistanceReviewProps = {
  /** Label for the workflow-specific adopt action. */
  adoptLabel?: string
  /** Safe error category selected by the controller. */
  errorKind?: AiAssistanceErrorKind
  /** Feedback already accepted by the server. */
  feedbackRating?: CreateAiAssistanceFeedbackRequest['rating']
  /** Current permission-aware generation. */
  generation?: AiAssistanceGeneration
  /** Whether a decision request is in flight. */
  isDecisionPending?: boolean
  /** Whether a feedback request is in flight. */
  isFeedbackPending?: boolean
  /** Whether a user-initiated generation is in flight. */
  isGenerating?: boolean
  /** Localized status message shown while this workflow is generating. */
  generatingLabel?: string
  /** Locale used for dates and numeric metadata. */
  locale: 'ja' | 'en'
  /** Cancels the active generation request. */
  onCancelGeneration?: () => void
  /** Adopts the reviewed draft through a workflow-specific handler. */
  onAdopt?: () => void | Promise<void>
  /** Records usefulness feedback for the audited generation. */
  onFeedback?: (rating: CreateAiAssistanceFeedbackRequest['rating']) => void | Promise<void>
  /** Rejects the draft without mutating a domain resource. */
  onReject?: () => void | Promise<void>
  /** Renders workflow-specific controls only after content authorization succeeds. */
  renderDraft: (review: AiAssistanceAvailableReview) => ReactNode
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders an evidence-first AI draft review with authorization, uncertainty, and audit details.
 *
 * @remarks Generation, decision, and feedback callbacks are always explicit;
 * rendering an available draft does not apply it to a domain form.
 *
 * @param props - Permission-aware generation state and explicit review actions.
 * @returns A flat proposal rail, or null while idle.
 */
export function AiAssistanceReview({
  adoptLabel,
  errorKind,
  feedbackRating,
  generation,
  generatingLabel,
  isDecisionPending = false,
  isFeedbackPending = false,
  isGenerating = false,
  locale,
  onAdopt,
  onCancelGeneration,
  onFeedback,
  onReject,
  renderDraft,
  t,
}: AiAssistanceReviewProps) {
  const reviewTitleId = useId()
  const citationsTitleId = useId()

  if (!generation && !isGenerating && !errorKind) return null

  const content = generation?.content
  const safeCitations = content?.availability === 'available'
    ? content.citations.filter((citation) => isSafeApplicationPath(citation.href))
    : []
  const hasUnsafeCitation = content?.availability === 'available' &&
    safeCitations.length !== content.citations.length
  const decision = generation?.decision

  return (
    <section
      aria-busy={isGenerating || isDecisionPending || isFeedbackPending || undefined}
      aria-labelledby={reviewTitleId}
      className="border-l-2 border-[var(--workbench-primary)] pl-4"
      data-testid="ai-assistance-review"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[var(--workbench-primary)]">
            <ShieldIcon className="h-5 w-5 fill-none stroke-current stroke-2" />
            <h2 className="text-app-body font-semibold" id={reviewTitleId}>
              {t('ai.review.title')}
            </h2>
          </div>
          {generation ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-app-caption text-[var(--workbench-muted)]">
              <span className="inline-flex items-center gap-1">
                <ClockIcon className="h-4 w-4 fill-none stroke-current stroke-2" />
                {t('ai.review.generated')} {formatDateTime(generation.createdAt, locale)}
              </span>
              {content?.availability === 'available' && !hasUnsafeCitation ? (
                <span>{t('ai.review.sources').replace('{count}', String(safeCitations.length))}</span>
              ) : null}
            </p>
          ) : null}
        </div>
        {content?.availability === 'available' && !hasUnsafeCitation ? (
          <ConfidenceBadge confidence={content.uncertainty.level} t={t} />
        ) : null}
      </header>

      <div className="mt-4 grid gap-4">
        {isGenerating ? (
          <div className="grid gap-3" role="status">
            <span className="text-app-body font-semibold text-[var(--workbench-text)]">
              {generatingLabel ?? t('ai.search.generating')}
            </span>
            <div aria-hidden="true" className="grid gap-2">
              <span className="h-3 w-4/5 animate-pulse rounded bg-[var(--workbench-border)] motion-reduce:animate-none" />
              <span className="h-3 w-3/5 animate-pulse rounded bg-[var(--workbench-border)] motion-reduce:animate-none" />
            </div>
            {onCancelGeneration ? (
              <button
                className="workbench-button-secondary min-h-[44px] justify-self-start px-4"
                onClick={onCancelGeneration}
                type="button"
              >
                {t('ai.search.cancel')}
              </button>
            ) : null}
          </div>
        ) : null}

        {errorKind || hasUnsafeCitation ? (
          <p className="border-l-2 border-[var(--workbench-danger)] bg-red-50 px-3 py-2 text-app-body font-semibold text-[var(--workbench-danger)]" role="alert">
            {t(getErrorMessageKey(hasUnsafeCitation ? 'validation' : errorKind ?? 'generic'))}
          </p>
        ) : null}

        {!isGenerating && generation && content?.availability === 'withheld' ? (
          <p className="bg-[var(--workbench-surface-muted)] px-3 py-3 text-app-body font-semibold text-[var(--workbench-text)]" role="status">
            {t(`ai.review.withheld.${content.reasonCode}`)}
          </p>
        ) : null}

        {!isGenerating && generation && content?.availability === 'available' && !hasUnsafeCitation ? (
          <>
            <p className="text-app-caption font-medium text-[var(--workbench-muted)]">
              {t('ai.review.draftNotice')}
            </p>
            <div className="border-y border-[var(--workbench-border)] py-4">
              {renderDraft({ citations: safeCitations, draft: content.draft })}
            </div>
            <div className="grid gap-1">
              <h3 className="text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                {t('ai.review.uncertainty')}
              </h3>
              <p className="text-app-body text-[var(--workbench-text)]">{content.uncertainty.reason}</p>
            </div>
            <AiCitationList citations={safeCitations} t={t} titleId={citationsTitleId} />

            {decision ? (
              <p
                className={decision.outcome === 'approved'
                  ? 'inline-flex items-center gap-2 text-app-body font-semibold text-[var(--workbench-success)]'
                  : 'inline-flex items-center gap-2 border-l-2 border-[var(--workbench-danger)] bg-red-50 px-2 py-1 text-app-body font-semibold text-[var(--workbench-danger)]'}
                role="status"
              >
                {decision.outcome === 'approved' ? (
                  <CheckCircleIcon className="h-5 w-5 fill-none stroke-current stroke-2" />
                ) : (
                  <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-current text-xs leading-none">
                    !
                  </span>
                )}
                {t(decision.outcome === 'approved' ? 'ai.review.approved' : 'ai.review.rejected')}
              </p>
            ) : onAdopt || onReject ? (
              <div className="flex flex-wrap justify-end gap-2 max-[520px]:grid max-[520px]:grid-cols-1">
                {onReject ? (
                  <button
                    className="workbench-button-secondary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isDecisionPending || isFeedbackPending}
                    onClick={() => void onReject()}
                    type="button"
                  >
                    {t('ai.review.reject')}
                  </button>
                ) : null}
                {onAdopt ? (
                  <button
                    className="workbench-button-primary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isDecisionPending || isFeedbackPending}
                    onClick={() => void onAdopt()}
                    type="button"
                  >
                    {adoptLabel ?? t('ai.review.adopt')}
                  </button>
                ) : null}
              </div>
            ) : null}

            {onFeedback ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-[var(--workbench-border)] pt-3">
                <span className="mr-auto text-app-caption font-semibold text-[var(--workbench-muted)]">
                  {feedbackRating ? t('ai.review.feedbackThanks') : t('ai.review.feedback')}
                </span>
                <FeedbackButton
                  active={feedbackRating === 'helpful'}
                  disabled={Boolean(feedbackRating) || isFeedbackPending || isDecisionPending}
                  label={t('ai.review.helpful')}
                  onClick={() => void onFeedback('helpful')}
                />
                <FeedbackButton
                  active={feedbackRating === 'not-helpful'}
                  disabled={Boolean(feedbackRating) || isFeedbackPending || isDecisionPending}
                  label={t('ai.review.notHelpful')}
                  onClick={() => void onFeedback('not-helpful')}
                />
              </div>
            ) : null}

            <GenerationDetails generation={generation} locale={locale} t={t} />
          </>
        ) : null}
      </div>
    </section>
  )
}

/**
 * Props for the permission-safe citation list.
 *
 * @remarks The list accepts only citations already filtered by the caller's
 * application-path policy.
 */
type AiCitationListProps = {
  /** Citations already filtered to safe application paths. */
  citations: readonly AiAssistanceCitation[]
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Instance-unique heading identifier used by the citation region. */
  titleId: string
}

/**
 * Renders bounded citations without constructing links from invalid paths.
 *
 * @param props - Safe citations, localized labels, and an instance heading ID.
 * @returns A citation list with links to authorized application routes.
 */
function AiCitationList({ citations, t, titleId }: AiCitationListProps) {
  return (
    <section aria-labelledby={titleId} className="grid gap-2">
      <h3 className="text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]" id={titleId}>
        {t('ai.review.citations')}
      </h3>
      {citations.length === 0 ? (
        <p className="text-app-caption text-[var(--workbench-muted)]">{t('ai.review.noCitations')}</p>
      ) : (
        <ol className="divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
          {citations.map((citation) => (
            <li className="grid gap-1 py-3" key={citation.id}>
              <a className="inline-flex min-h-[44px] items-center gap-2 font-semibold text-[var(--workbench-primary)] underline-offset-2 hover:underline" href={citation.href} rel="noreferrer" target="_blank">
                <span>{citation.label}</span>
                <ExternalLinkIcon className="h-4 w-4 fill-none stroke-current stroke-2" />
              </a>
              {citation.excerpt ? (
                <p className="text-app-caption text-[var(--workbench-text)]">{citation.excerpt}</p>
              ) : null}
              <p className="text-[11px] font-medium text-[var(--workbench-muted)]">
                {t('ai.review.capturedRevision').replace('{revision}', String(citation.capturedRevision))}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/**
 * Props for one compact feedback action.
 *
 * @remarks A feedback button exposes its selected state through `aria-pressed`.
 */
type FeedbackButtonProps = {
  /** Whether this rating has already been selected. */
  active: boolean
  /** Whether feedback is unavailable or currently submitting. */
  disabled: boolean
  /** Accessible localized button label. */
  label: string
  /** Submits this rating. */
  onClick: () => void
}

/**
 * Renders a compact accessible feedback choice.
 *
 * @param props - Selection, disabled state, label, and submit callback.
 * @returns A single localized feedback button.
 */
function FeedbackButton({ active, disabled, label, onClick }: FeedbackButtonProps) {
  return (
    <button
      aria-pressed={active}
      className={`min-h-[44px] rounded-md border px-3 text-app-caption font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'border-[#99d7cf] bg-[#e5f7f4] text-[var(--workbench-primary)]'
          : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}

/**
 * Props for the opt-in technical generation details disclosure.
 *
 * @remarks Provider and cost metadata remain behind a disclosure so the main
 * review flow stays focused on human verification.
 */
type GenerationDetailsProps = {
  /** Audited generation whose technical details are displayed. */
  generation: AiAssistanceGeneration
  /** Locale used for numeric formatting. */
  locale: 'ja' | 'en'
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders provider metadata in a secondary disclosure instead of the primary task flow.
 *
 * @param props - Audited generation, locale, and localized labels.
 * @returns A disclosure containing bounded technical metadata.
 */
function GenerationDetails({ generation, locale, t }: GenerationDetailsProps) {
  const { details } = generation
  const usage = details.usage
  const tokenParts = [usage.inputTokens, usage.outputTokens]
    .map((value) => value === undefined ? '—' : value.toLocaleString(locale))

  return (
    <details className="border-t border-[var(--workbench-border)] pt-3">
      <summary className="min-h-[44px] cursor-pointer py-3 text-app-caption font-semibold text-[var(--workbench-muted)]">
        {t('ai.review.details')}
      </summary>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 pb-2 text-app-caption max-[480px]:grid-cols-1 max-[480px]:gap-y-1">
        <DetailRow label={t('ai.review.provider')} value="Amazon Bedrock" />
        <DetailRow label={t('ai.review.model')} value={details.modelId} />
        <DetailRow label={t('ai.review.promptVersion')} value={details.promptVersion} />
        <DetailRow label={t('ai.review.trace')} value={details.traceId} />
        <DetailRow label={t('ai.review.latency')} value={`${usage.latencyMs.toLocaleString(locale)} ms`} />
        <DetailRow label={t('ai.review.tokens')} value={tokenParts.join(' / ')} />
        <DetailRow
          label={t('ai.review.cost')}
          value={usage.costUsd === undefined
            ? t('ai.review.costUnavailable')
            : new Intl.NumberFormat(locale, { currency: 'USD', style: 'currency' }).format(usage.costUsd)}
        />
      </dl>
    </details>
  )
}

/**
 * Props for one generation-detail definition row.
 *
 * @remarks The row is intentionally presentation-only and does not expose raw
 * provider response payloads.
 */
type DetailRowProps = {
  /** Definition term. */
  label: string
  /** Definition value. */
  value: string
}

/**
 * Renders one compact definition-list row.
 *
 * @param props - Definition term and safe display value.
 * @returns A `dt`/`dd` pair for the generation metadata list.
 */
function DetailRow({ label, value }: DetailRowProps) {
  return (
    <>
      <dt className="font-semibold text-[var(--workbench-muted)]">{label}</dt>
      <dd className="min-w-0 break-all text-[var(--workbench-text)]">{value}</dd>
    </>
  )
}

/**
 * Selects a localized safe error message key for a controller category.
 *
 * @param kind - Stable controller error category.
 * @returns The matching localized message key.
 */
function getErrorMessageKey(kind: AiAssistanceErrorKind): MessageKey {
  return `ai.error.${kind}`
}

/**
 * Formats one generation timestamp for the visible locale.
 *
 * @param value - ISO timestamp from the validated generation response.
 * @param locale - Locale used by the browser formatter.
 * @returns A localized date-time string, or the original value if invalid.
 */
function formatDateTime(value: string, locale: 'ja' | 'en'): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}
