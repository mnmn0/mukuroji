import type {
  AiAssistanceCitation,
  AiAssistanceGeneration,
  AiPlanningDraft,
  AiPlanningStatusUpdateDraft,
  AiPlanningTargetSource,
  CreateAiAssistanceFeedbackRequest,
} from '@mukuroji/contracts'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { isReviewableAiAssistanceGeneration } from '../model/aiGenerationValidation'
import {
  useAiAssistanceController,
  type AiAssistanceControllerError,
} from '../mutations/useAiAssistanceController'
import { AiAssistanceReview } from './AiAssistanceReview'
import { AiPlanningDraftReview } from './AiPlanningDraftReview'

/** Auditable generation context passed with an adopted Planning status update. */
export type AiPlanningStatusUpdateAdoptionContext = {
  /** Generation identifier retained for local evidence labeling. */
  generationId: string
  /** Permission-safe citations returned with the approved generation. */
  citations: readonly AiAssistanceCitation[]
}

/**
 * Props for a Planning-target status update assistant.
 *
 * The assistant requests a reviewable proposal and delegates adoption to the
 * existing Planning composer; it never publishes a status update directly.
 */
export type AiPlanningStatusUpdateAssistantProps = {
  /** Active Workspace member bearer token. */
  accessToken?: string
  /** Temporarily disables AI actions while the owning status update is publishing. */
  disabled?: boolean
  /** Reports authenticated AI failures to the owning Planning route session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Reports AI generation, decision, and feedback activity to the owning Planning route. */
  onOperationPendingChange?: (pending: boolean) => void
  /** Optional operator guidance sent with the audited generation request. */
  guidance?: string
  /** Locale sent to Bedrock and used for generation metadata. */
  locale: Locale
  /** Copies an approved status update into the existing manual composer only. */
  onAdopt: (
    draft: AiPlanningStatusUpdateDraft,
    replacementConfirmed?: boolean,
    context?: AiPlanningStatusUpdateAdoptionContext,
  ) => void | Promise<void>
  /** Whether adopting the draft would replace manual form edits. */
  requireAdoptionConfirmation?: boolean
  /** Planning target reference resolved and re-authorized by the server. */
  source: AiPlanningTargetSource
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Connects an explicit Planning request to the shared permission-aware controller.
 *
 * @remarks Generation is started only from the view's explicit form action and
 * adoption remains a local draft operation.
 *
 * @param props - Authentication, source, locale, and local form adoption callback.
 * @returns A planning assistant that never publishes a status update itself.
 */
export function AiPlanningStatusUpdateAssistant({
  accessToken,
  disabled = false,
  guidance,
  locale,
  onAuthenticatedApiError,
  onAdopt,
  onOperationPendingChange,
  requireAdoptionConfirmation,
  source,
  t,
}: AiPlanningStatusUpdateAssistantProps) {
  const controller = useAiAssistanceController({ accessToken, onAuthenticatedApiError })

  /** Runs one explicit generation while fencing Planning target selection. */
  const generate = async () => {
    onOperationPendingChange?.(true)
    try {
      return await controller.generate({
        ...(guidance?.trim() ? { guidance: guidance.trim() } : {}),
        locale,
        source,
        task: 'planning',
      })
    } finally {
      onOperationPendingChange?.(false)
    }
  }

  /** Records a review decision while fencing Planning target selection. */
  const decide = async (outcome: 'approved' | 'rejected') => {
    onOperationPendingChange?.(true)
    try {
      return await controller.decide(outcome)
    } finally {
      onOperationPendingChange?.(false)
    }
  }

  /** Sends usefulness feedback while fencing Planning target selection. */
  const sendFeedback = async (rating: CreateAiAssistanceFeedbackRequest['rating']) => {
    onOperationPendingChange?.(true)
    try {
      await controller.sendFeedback(rating)
    } finally {
      onOperationPendingChange?.(false)
    }
  }

  return (
    <AiPlanningStatusUpdateAssistantView
      canGenerate={Boolean(accessToken) && !disabled}
      disabled={disabled}
      error={controller.error}
      feedbackRating={controller.feedbackRating}
      generation={controller.generation}
      isDecisionPending={controller.isDecisionPending}
      isFeedbackPending={controller.isFeedbackPending}
      isGenerating={controller.isGenerating}
      locale={locale}
      cancelLabel={t('ai.planning.assistant.cancel')}
      onAdopt={onAdopt}
      onCancelGeneration={controller.cancelGeneration}
      onDecide={decide}
      onFeedback={sendFeedback}
      onGenerate={generate}
      requireAdoptionConfirmation={requireAdoptionConfirmation}
      t={t}
    />
  )
}

/**
 * Props for the pure Planning-target assistant view.
 *
 * The view receives all state and side-effect callbacks from its container so
 * it can be rendered independently in tests and Storybook.
 */
export type AiPlanningStatusUpdateAssistantViewProps = {
  /** Whether the active session can issue a generation request. */
  canGenerate?: boolean
  /** Temporarily disables every AI action while the owning status update is publishing. */
  disabled?: boolean
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
  /** Localized cancellation action for the Planning status workflow. */
  cancelLabel?: string
  /** Copies an approved status update into the existing manual composer only. */
  onAdopt: (
    draft: AiPlanningStatusUpdateDraft,
    replacementConfirmed?: boolean,
    context?: AiPlanningStatusUpdateAdoptionContext,
  ) => void | Promise<void>
  /** Cancels the active explicit generation request. */
  onCancelGeneration?: () => void
  /** Records approval or rejection without publishing a status update. */
  onDecide: (outcome: 'approved' | 'rejected') => Promise<AiAssistanceGeneration | undefined>
  /** Records usefulness feedback for the audited generation. */
  onFeedback?: (rating: CreateAiAssistanceFeedbackRequest['rating']) => void | Promise<void>
  /** Runs a generation only after explicit form submission. */
  onGenerate: () => void | Promise<unknown>
  /** Whether adoption must confirm replacement of manual form edits first. */
  requireAdoptionConfirmation?: boolean
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders an explicit Generate action and a fail-closed Planning draft review.
 *
 * @remarks An approved draft is copied into the caller's form only after the
 * configured manual-replacement confirmation has been satisfied.
 *
 * @param props - Pure generation state and event handlers.
 * @returns A flat evidence-first planning workflow.
 */
export function AiPlanningStatusUpdateAssistantView({
  canGenerate = true,
  disabled = false,
  error,
  feedbackRating,
  generation,
  isDecisionPending = false,
  isFeedbackPending = false,
  isGenerating = false,
  locale,
  cancelLabel,
  onAdopt,
  onCancelGeneration,
  onDecide,
  onFeedback,
  onGenerate,
  requireAdoptionConfirmation = false,
  t,
}: AiPlanningStatusUpdateAssistantViewProps) {
  const [confirmationGenerationId, setConfirmationGenerationId] = useState<string>()
  const confirmationRef = useRef<HTMLDivElement>(null)
  const availableDraft = getAvailableAiPlanningDraft(generation)
  const hasInvalidAvailableDraft = generation?.content.availability === 'available' && !availableDraft
  const isOperationPending = disabled || isGenerating || isDecisionPending || isFeedbackPending
  const isAdoptionConfirmationVisible = confirmationGenerationId !== undefined &&
    confirmationGenerationId === generation?.id

  useEffect(() => {
    if (!isAdoptionConfirmationVisible) return
    confirmationRef.current?.focus()
  }, [isAdoptionConfirmationVisible])

  /** Approves the current draft only after any manual-replacement confirmation. */
  const approveAndAdopt = async (replacementConfirmed = false) => {
    if (isOperationPending) return
    const adopted = await approveAiPlanningStatusUpdate(
      onDecide,
      onAdopt,
      replacementConfirmed,
    )
    if (adopted) setConfirmationGenerationId(undefined)
  }

  /** Opens replacement confirmation before recording an approval decision. */
  const adoptDraft = () => {
    if (isOperationPending) return
    if (requireAdoptionConfirmation && generation?.id !== undefined) {
      setConfirmationGenerationId(generation.id)
      return
    }
    void approveAndAdopt()
  }

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
          generatingLabel={t('ai.planning.assistant.generating')}
          locale={locale}
          onAdopt={availableDraft?.statusUpdate && !disabled ? adoptDraft : undefined}
          onFeedback={disabled ? undefined : onFeedback}
          onReject={availableDraft && !disabled
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
          generatingLabel={t('ai.planning.assistant.generating')}
          isGenerating={isGenerating}
          locale={locale}
          cancelLabel={cancelLabel}
          onCancelGeneration={disabled ? undefined : onCancelGeneration}
          renderDraft={() => null}
          t={t}
        />
      )}

      {isAdoptionConfirmationVisible ? (
        <div
          className="border-l-2 border-amber-500 bg-amber-50 px-4 py-3 text-amber-950 outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
          ref={confirmationRef}
          role="alert"
          tabIndex={-1}
        >
          <p className="text-sm font-semibold">{t('ai.planning.replaceDraftTitle')}</p>
          <p className="mt-1 text-xs font-medium leading-5">
            {t('ai.planning.replaceDraftDescription')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="workbench-button-secondary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isOperationPending}
              onClick={() => setConfirmationGenerationId(undefined)}
              type="button"
            >
              {t('ai.planning.keepManualDraft')}
            </button>
            <button
              className="workbench-button-primary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isOperationPending}
              onClick={() => void approveAndAdopt(true)}
              type="button"
            >
              {t('ai.planning.replaceManualDraft')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Records approval, revalidates the returned content, and then copies a local form seed.
 *
 * @param onDecide - Revision-fenced approval action.
 * @param onAdopt - Local composer callback that does not publish a status update.
 * @param replacementConfirmed - Whether the operator confirmed replacing manual edits.
 * @returns Whether an approved, currently available status update was adopted.
 */
async function approveAiPlanningStatusUpdate(
  onDecide: AiPlanningStatusUpdateAssistantViewProps['onDecide'],
  onAdopt: AiPlanningStatusUpdateAssistantViewProps['onAdopt'],
  replacementConfirmed: boolean,
): Promise<boolean> {
  const reviewedGeneration = await onDecide('approved')
  const reviewedDraft = getAvailableAiPlanningDraft(reviewedGeneration)
  const draft = reviewedDraft?.statusUpdate
  if (reviewedGeneration?.decision?.outcome !== 'approved' || !draft) return false
  const citations = reviewedGeneration.content.availability === 'available'
    ? reviewedGeneration.content.citations.filter((citation) => draft.citationIds.includes(citation.id))
    : []
  await onAdopt(draft, replacementConfirmed, {
    citations,
    generationId: reviewedGeneration.id,
  })
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
