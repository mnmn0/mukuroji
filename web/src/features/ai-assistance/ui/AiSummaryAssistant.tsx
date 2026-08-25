import type {
  AiAssistanceCitation,
  AiAssistanceGeneration,
  AiAssistanceSource,
  AiSummaryDraft,
  CreateAiAssistanceFeedbackRequest,
} from '@mukuroji/contracts'
import type { FormEvent } from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { isReviewableAiAssistanceGeneration } from '../model/aiGenerationValidation'
import {
  useAiAssistanceController,
  type AiAssistanceControllerError,
} from '../mutations/useAiAssistanceController'
import { AiAssistanceReview } from './AiAssistanceReview'
import { AiSummaryBrief } from './AiSummaryBrief'

/** Props for a source-scoped grounded summary assistant. */
export type AiSummaryAssistantProps = {
  /** Active Workspace member bearer token. */
  accessToken?: string
  /** Reports authenticated AI failures to the owning collaboration session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Label for the optional workflow-specific draft adoption action. */
  adoptLabel?: string
  /** Optional operator focus sent with the audited generation request. */
  focus?: string
  /** Locale sent to Bedrock and used for generation metadata. */
  locale: Locale
  /** Opens the approved summary in an existing human-owned draft workflow. */
  onAdopt?: (
    draft: AiSummaryDraft,
    citations: readonly AiAssistanceCitation[],
  ) => void | Promise<void>
  /** Permission-safe source references resolved again by the server. */
  sources: AiAssistanceSource[]
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Connects an explicit summary request to the shared permission-aware controller.
 *
 * @param props - Authentication, sources, locale, and optional draft adoption callback.
 * @returns A source-scoped summary assistant that never mutates a domain resource directly.
 */
export function AiSummaryAssistant({
  accessToken,
  adoptLabel,
  focus,
  locale,
  onAuthenticatedApiError,
  onAdopt,
  sources,
  t,
}: AiSummaryAssistantProps) {
  const controller = useAiAssistanceController({ accessToken, onAuthenticatedApiError })

  return (
    <AiSummaryAssistantView
      adoptLabel={adoptLabel}
      canGenerate={Boolean(accessToken)}
      error={controller.error}
      feedbackRating={controller.feedbackRating}
      generation={controller.generation}
      isDecisionPending={controller.isDecisionPending}
      isFeedbackPending={controller.isFeedbackPending}
      isGenerating={controller.isGenerating}
      locale={locale}
      onAdopt={onAdopt}
      onCancelGeneration={controller.cancelGeneration}
      onDecide={controller.decide}
      onFeedback={controller.sendFeedback}
      onGenerate={() => controller.generate({
        ...(focus?.trim() ? { focus: focus.trim() } : {}),
        locale,
        sources,
        task: 'summary',
      })}
      t={t}
    />
  )
}

/** Props for the pure grounded summary assistant view. */
export type AiSummaryAssistantViewProps = {
  /** Label for the optional workflow-specific draft adoption action. */
  adoptLabel?: string
  /** Whether the active session can issue a generation request. */
  canGenerate?: boolean
  /** Safe controller failure classification. */
  error?: AiAssistanceControllerError
  /** Feedback already accepted for the visible generation. */
  feedbackRating?: CreateAiAssistanceFeedbackRequest['rating']
  /** Current permission-aware generation. */
  generation?: AiAssistanceGeneration
  /** Whether a human decision is being recorded. */
  isDecisionPending?: boolean
  /** Whether evaluation feedback is being recorded. */
  isFeedbackPending?: boolean
  /** Whether an explicit generation is in flight. */
  isGenerating?: boolean
  /** Locale used for generation metadata. */
  locale: Locale
  /** Opens an approved summary in a human-owned draft workflow. */
  onAdopt?: (
    draft: AiSummaryDraft,
    citations: readonly AiAssistanceCitation[],
  ) => void | Promise<void>
  /** Cancels the active explicit generation request. */
  onCancelGeneration?: () => void
  /** Records approval or rejection without mutating a domain resource. */
  onDecide: (outcome: 'approved' | 'rejected') => Promise<AiAssistanceGeneration | undefined>
  /** Records usefulness feedback for the audited generation. */
  onFeedback?: (rating: CreateAiAssistanceFeedbackRequest['rating']) => void | Promise<void>
  /** Runs a generation only after explicit form submission. */
  onGenerate: () => void | Promise<unknown>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders an explicit Generate action and a fail-closed grounded summary review.
 *
 * @param props - Pure generation state and event handlers.
 * @returns A flat evidence-first summary workflow.
 */
export function AiSummaryAssistantView({
  adoptLabel,
  canGenerate = true,
  error,
  feedbackRating,
  generation,
  isDecisionPending = false,
  isFeedbackPending = false,
  isGenerating = false,
  locale,
  onAdopt,
  onCancelGeneration,
  onDecide,
  onFeedback,
  onGenerate,
  t,
}: AiSummaryAssistantViewProps) {
  const availableDraft = getAvailableAiSummaryDraft(generation)
  const hasInvalidAvailableDraft = generation?.content.availability === 'available' && !availableDraft
  const isOperationPending = isGenerating || isDecisionPending || isFeedbackPending

  /** Generates only in response to an explicit form submission. */
  const handleGenerate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canGenerate || isOperationPending) return
    void onGenerate()
  }

  return (
    <div className="grid gap-4" data-testid="ai-summary-assistant">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--workbench-border)] pb-4">
        <div className="min-w-0">
          <h3 className="text-app-body font-semibold text-[var(--workbench-text)]">
            {t('ai.summary.title')}
          </h3>
          <p className="mt-1 text-app-caption leading-5 text-[var(--workbench-muted)]">
            {t('ai.summary.description')}
          </p>
        </div>
        <form onSubmit={handleGenerate}>
          <button
            className="workbench-button-primary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canGenerate || isOperationPending}
            type="submit"
          >
            {isGenerating ? t('ai.summary.generating') : t('ai.summary.generate')}
          </button>
        </form>
      </div>

      {hasInvalidAvailableDraft ? (
        <AiAssistanceReview
          errorKind="validation"
          locale={locale}
          renderDraft={() => null}
          t={t}
        />
      ) : generation && (availableDraft || generation.content.availability === 'withheld') ? (
        <AiAssistanceReview
          errorKind={error?.kind}
          feedbackRating={feedbackRating}
          generation={generation}
          isDecisionPending={isDecisionPending}
          isFeedbackPending={isFeedbackPending}
          locale={locale}
          adoptLabel={adoptLabel ?? (!onAdopt ? t('ai.review.approve') : undefined)}
          onAdopt={availableDraft
            ? async () => {
                await approveAiSummaryDraft(onDecide, onAdopt)
              }
            : undefined}
          onFeedback={onFeedback}
          onReject={availableDraft
            ? async () => {
                await onDecide('rejected')
              }
            : undefined}
          renderDraft={({ citations, draft }) => draft.kind === 'summary' ? (
            <AiSummaryBrief citations={citations} draft={draft} t={t} />
          ) : null}
          t={t}
        />
      ) : (
        <AiAssistanceReview
          errorKind={error?.kind}
          isGenerating={isGenerating}
          locale={locale}
          onCancelGeneration={onCancelGeneration}
          renderDraft={() => null}
          t={t}
        />
      )}
    </div>
  )
}

/**
 * Records approval, revalidates the returned content, and then opens a local draft workflow.
 *
 * @param onDecide - Revision-fenced approval action.
 * @param onAdopt - Local workflow callback that does not persist the domain resource.
 * @returns Whether an approved, currently available summary was adopted.
 */
async function approveAiSummaryDraft(
  onDecide: AiSummaryAssistantViewProps['onDecide'],
  onAdopt: AiSummaryAssistantViewProps['onAdopt'],
): Promise<boolean> {
  const reviewedGeneration = await onDecide('approved')
  const content = reviewedGeneration?.content
  if (
    reviewedGeneration?.decision?.outcome !== 'approved' ||
    content?.availability !== 'available' ||
    content.draft.kind !== 'summary'
  ) return false
  if (onAdopt) await onAdopt(content.draft, content.citations)
  return true
}

/** Returns a currently authorized summary draft and rejects every mismatched shape. */
function getAvailableAiSummaryDraft(
  generation: AiAssistanceGeneration | undefined,
): AiSummaryDraft | undefined {
  if (
    !isReviewableAiAssistanceGeneration(generation, 'summary') ||
    generation.content.availability !== 'available' ||
    generation.content.draft.kind !== 'summary'
  ) {
    return undefined
  }
  return generation.content.draft
}
