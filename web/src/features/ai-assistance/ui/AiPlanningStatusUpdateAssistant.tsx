import type {
  AiAssistanceGeneration,
  AiPlanningDraft,
  AiPlanningStatusUpdateDraft,
  AiPlanningTargetSource,
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
import { AiPlanningDraftReview } from './AiPlanningDraftReview'

/** Props for a Planning-target status update assistant. */
export type AiPlanningStatusUpdateAssistantProps = {
  /** Active Workspace member bearer token. */
  accessToken?: string
  /** Optional operator guidance sent with the audited generation request. */
  guidance?: string
  /** Locale sent to Bedrock and used for generation metadata. */
  locale: Locale
  /** Copies an approved status update into the existing manual composer only. */
  onAdopt: (draft: AiPlanningStatusUpdateDraft) => void | Promise<void>
  /** Planning target reference resolved and re-authorized by the server. */
  source: AiPlanningTargetSource
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Connects an explicit Planning request to the shared permission-aware controller.
 *
 * @param props - Authentication, source, locale, and local form adoption callback.
 * @returns A planning assistant that never publishes a status update itself.
 */
export function AiPlanningStatusUpdateAssistant({
  accessToken,
  guidance,
  locale,
  onAdopt,
  source,
  t,
}: AiPlanningStatusUpdateAssistantProps) {
  const controller = useAiAssistanceController({ accessToken })

  return (
    <AiPlanningStatusUpdateAssistantView
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
        ...(guidance?.trim() ? { guidance: guidance.trim() } : {}),
        locale,
        source,
        task: 'planning',
      })}
      t={t}
    />
  )
}

/** Props for the pure Planning-target assistant view. */
export type AiPlanningStatusUpdateAssistantViewProps = {
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
  /** Locale used for generation metadata and planning values. */
  locale: Locale
  /** Copies an approved status update into the existing manual composer only. */
  onAdopt: (draft: AiPlanningStatusUpdateDraft) => void | Promise<void>
  /** Cancels the active explicit generation request. */
  onCancelGeneration?: () => void
  /** Records approval or rejection without publishing a status update. */
  onDecide: (outcome: 'approved' | 'rejected') => Promise<AiAssistanceGeneration | undefined>
  /** Records usefulness feedback for the audited generation. */
  onFeedback?: (rating: CreateAiAssistanceFeedbackRequest['rating']) => void | Promise<void>
  /** Runs a generation only after explicit form submission. */
  onGenerate: () => void | Promise<unknown>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders an explicit Generate action and a fail-closed Planning draft review.
 *
 * @param props - Pure generation state and event handlers.
 * @returns A flat evidence-first planning workflow.
 */
export function AiPlanningStatusUpdateAssistantView({
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
}: AiPlanningStatusUpdateAssistantViewProps) {
  const availableDraft = getAvailableAiPlanningDraft(generation)
  const hasInvalidAvailableDraft = generation?.content.availability === 'available' && !availableDraft
  const isOperationPending = isGenerating || isDecisionPending || isFeedbackPending

  /** Generates only in response to an explicit form submission. */
  const handleGenerate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canGenerate || isOperationPending) return
    void onGenerate()
  }

  return (
    <div className="grid gap-4 border-y border-[var(--workbench-border)] py-4" data-testid="ai-planning-status-assistant">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-app-body font-semibold text-[var(--workbench-text)]">
            {t('ai.planning.assistant.title')}
          </h3>
          <p className="mt-1 text-app-caption leading-5 text-[var(--workbench-muted)]">
            {t('ai.planning.assistant.description')}
          </p>
        </div>
        <form onSubmit={handleGenerate}>
          <button
            className="workbench-button-primary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canGenerate || isOperationPending}
            type="submit"
          >
            {isGenerating ? t('ai.planning.assistant.generating') : t('ai.planning.assistant.generate')}
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
          adoptLabel={t('ai.planning.assistant.adopt')}
          errorKind={error?.kind}
          feedbackRating={feedbackRating}
          generation={generation}
          isDecisionPending={isDecisionPending}
          isFeedbackPending={isFeedbackPending}
          locale={locale}
          onAdopt={availableDraft?.statusUpdate
            ? async () => {
                await approveAiPlanningStatusUpdate(onDecide, onAdopt)
              }
            : undefined}
          onFeedback={onFeedback}
          onReject={availableDraft
            ? async () => {
                await onDecide('rejected')
              }
            : undefined}
          renderDraft={({ citations, draft }) => draft.kind === 'planning' ? (
            <AiPlanningDraftReview citations={citations} draft={draft} locale={locale} t={t} />
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
 * Records approval, revalidates the returned content, and then copies a local form seed.
 *
 * @param onDecide - Revision-fenced approval action.
 * @param onAdopt - Local composer callback that does not publish a status update.
 * @returns Whether an approved, currently available status update was adopted.
 */
async function approveAiPlanningStatusUpdate(
  onDecide: AiPlanningStatusUpdateAssistantViewProps['onDecide'],
  onAdopt: AiPlanningStatusUpdateAssistantViewProps['onAdopt'],
): Promise<boolean> {
  const reviewedGeneration = await onDecide('approved')
  const draft = getAvailableAiPlanningDraft(reviewedGeneration)?.statusUpdate
  if (reviewedGeneration?.decision?.outcome !== 'approved' || !draft) return false
  await onAdopt(draft)
  return true
}

/** Returns a currently authorized Planning draft and rejects every mismatched shape. */
function getAvailableAiPlanningDraft(
  generation: AiAssistanceGeneration | undefined,
): AiPlanningDraft | undefined {
  if (
    !isReviewableAiAssistanceGeneration(generation, 'planning') ||
    generation.content.availability !== 'available' ||
    generation.content.draft.kind !== 'planning'
  ) {
    return undefined
  }
  return generation.content.draft
}
