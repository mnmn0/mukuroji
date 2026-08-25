import type {
  AiAssistanceGeneration,
  AiPlanningDraft,
  AiWorkItemSource,
  CreateAiAssistanceFeedbackRequest,
  WorkItemDependencyEndpoint,
} from '@mukuroji/contracts'
import { useEffect, useRef, useState } from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { isReviewableAiAssistanceGeneration } from '../model/aiGenerationValidation'
import {
  useAiAssistanceController,
  type AiAssistanceController,
  type AiAssistanceControllerError,
} from '../mutations/useAiAssistanceController'
import { AiAssistanceReview } from './AiAssistanceReview'
import { AiPlanningDraftReview } from './AiPlanningDraftReview'

/** Props for explicit Work Item planning assistance. */
export type AiWorkItemPlanningAssistantProps = {
  /** Active Workspace member bearer token. */
  accessToken?: string
  /** Reports authenticated AI failures to the owning Work Item route session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Optional controller override used by isolated stories and interaction tests. */
  controller?: AiAssistanceController
  /** Locale sent to Bedrock and used for draft presentation. */
  locale: Locale
  /** Copies approved supported fields into the existing local editor without saving them. */
  onAdopt?: (draft: AiPlanningDraft) => void | Promise<void>
  /** Resolves a configured workflow status identifier for review. */
  resolveStatusLabel?: (statusId: string) => string
  /** Resolves a visible Team-qualified Work Item endpoint for review. */
  resolveWorkItemLabel?: (endpoint: WorkItemDependencyEndpoint) => string
  /** Whether adoption must first confirm replacement of manual supported-field edits. */
  requireAdoptionConfirmation?: boolean
  /** Revision-fenced Work Item source re-authorized by the server. */
  source: AiWorkItemSource
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Connects one Work Item to the review-only Planning generation workflow.
 *
 * @param props - Authentication, source, local adoption, and display resolvers.
 * @returns An evidence-first assistant that never mutates a Work Item itself.
 */
export function AiWorkItemPlanningAssistant({
  accessToken,
  controller,
  locale,
  onAuthenticatedApiError,
  onAdopt,
  resolveStatusLabel,
  resolveWorkItemLabel,
  requireAdoptionConfirmation,
  source,
  t,
}: AiWorkItemPlanningAssistantProps) {
  const liveController = useAiAssistanceController({ accessToken, onAuthenticatedApiError })
  const activeController = controller ?? liveController

  return (
    <AiWorkItemPlanningAssistantView
      canGenerate={Boolean(accessToken || controller)}
      error={activeController.error}
      feedbackRating={activeController.feedbackRating}
      generation={activeController.generation}
      isDecisionPending={activeController.isDecisionPending}
      isFeedbackPending={activeController.isFeedbackPending}
      isGenerating={activeController.isGenerating}
      locale={locale}
      onAdopt={onAdopt}
      onCancelGeneration={activeController.cancelGeneration}
      onDecide={activeController.decide}
      onFeedback={activeController.sendFeedback}
      onGenerate={() => activeController.generate({ locale, source, task: 'planning' })}
      resolveStatusLabel={resolveStatusLabel}
      resolveWorkItemLabel={resolveWorkItemLabel}
      requireAdoptionConfirmation={requireAdoptionConfirmation}
      t={t}
    />
  )
}

/** Props for the pure Work Item planning assistant view. */
export type AiWorkItemPlanningAssistantViewProps = {
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
  /** Whether feedback is being recorded. */
  isFeedbackPending?: boolean
  /** Whether an explicit generation is in flight. */
  isGenerating?: boolean
  /** Locale used for generation metadata and planning values. */
  locale: Locale
  /** Copies an approved draft into supported local Work Item fields only. */
  onAdopt?: (draft: AiPlanningDraft) => void | Promise<void>
  /** Cancels the active explicit generation request. */
  onCancelGeneration?: () => void
  /** Records approval or rejection without mutating a Work Item. */
  onDecide: (outcome: 'approved' | 'rejected') => Promise<AiAssistanceGeneration | undefined>
  /** Records usefulness feedback for the audited generation. */
  onFeedback?: (rating: CreateAiAssistanceFeedbackRequest['rating']) => void | Promise<void>
  /** Runs generation only after the explicit control is activated. */
  onGenerate: () => void | Promise<unknown>
  /** Resolves a configured workflow status identifier for review. */
  resolveStatusLabel?: (statusId: string) => string
  /** Resolves a visible Team-qualified Work Item endpoint for review. */
  resolveWorkItemLabel?: (endpoint: WorkItemDependencyEndpoint) => string
  /** Whether adoption must first confirm replacement of manual supported-field edits. */
  requireAdoptionConfirmation?: boolean
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders Work Item Planning generation, evidence review, and local draft adoption.
 *
 * @param props - Pure generation state and explicit action handlers.
 * @returns A flat review rail safe to mount inside an existing Work Item form.
 */
export function AiWorkItemPlanningAssistantView({
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
  resolveStatusLabel,
  resolveWorkItemLabel,
  requireAdoptionConfirmation = false,
  t,
}: AiWorkItemPlanningAssistantViewProps) {
  const [confirmationGenerationId, setConfirmationGenerationId] = useState<string>()
  const confirmationRef = useRef<HTMLDivElement>(null)
  const availableDraft = getAvailableWorkItemPlanningDraft(generation)
  const hasInvalidAvailableDraft = generation?.content.availability === 'available' &&
    !availableDraft
  const isOperationPending = isGenerating || isDecisionPending || isFeedbackPending
  const isAdoptionConfirmationVisible = confirmationGenerationId !== undefined &&
    confirmationGenerationId === generation?.id

  useEffect(() => {
    if (isAdoptionConfirmationVisible) confirmationRef.current?.focus()
  }, [isAdoptionConfirmationVisible])

  /** Starts a new draft only from the explicit button. */
  const generateDraft = () => {
    if (!canGenerate || isOperationPending) return
    void onGenerate()
  }

  /** Records approval before copying any supported value into local editor state. */
  const approveAndAdoptDraft = async () => {
    if (!onAdopt || isOperationPending) return
    const reviewedGeneration = await onDecide('approved')
    const reviewedDraft = getAvailableWorkItemPlanningDraft(reviewedGeneration)
    if (reviewedGeneration?.decision?.outcome !== 'approved' || !reviewedDraft) return
    setConfirmationGenerationId(undefined)
    await onAdopt(reviewedDraft)
  }

  /** Opens replacement confirmation before approval when manual edits could be lost. */
  const adoptDraft = () => {
    if (!onAdopt || isOperationPending) return
    if (requireAdoptionConfirmation) {
      setConfirmationGenerationId(generation?.id)
      return
    }
    void approveAndAdoptDraft()
  }

  return (
    <section
      className="grid gap-4 border-y border-[var(--workbench-border)] py-4"
      data-testid="ai-work-item-planning-assistant"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-app-body font-semibold text-[var(--workbench-text)]">
            {t('ai.planning.workItem.title')}
          </h3>
          <p className="mt-1 text-app-caption leading-5 text-[var(--workbench-muted)]">
            {t('ai.planning.workItem.description')}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canGenerate || isOperationPending}
          onClick={generateDraft}
          type="button"
        >
          {isGenerating
            ? t('ai.planning.workItem.generating')
            : t('ai.planning.workItem.generate')}
        </button>
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
          adoptLabel={t('ai.planning.workItem.adopt')}
          errorKind={error?.kind}
          feedbackRating={feedbackRating}
          generation={generation}
          isDecisionPending={isDecisionPending}
          isFeedbackPending={isFeedbackPending}
          locale={locale}
          onAdopt={availableDraft && onAdopt ? adoptDraft : undefined}
          onFeedback={onFeedback}
          onReject={availableDraft
            ? async () => {
                await onDecide('rejected')
              }
            : undefined}
          renderDraft={({ citations, draft }) => draft.kind === 'planning' ? (
            <AiPlanningDraftReview
              citations={citations}
              draft={draft}
              locale={locale}
              resolveStatusLabel={resolveStatusLabel}
              resolveWorkItemLabel={resolveWorkItemLabel}
              t={t}
            />
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
              className="workbench-button-secondary min-h-[44px] px-4"
              onClick={() => setConfirmationGenerationId(undefined)}
              type="button"
            >
              {t('ai.planning.keepManualDraft')}
            </button>
            <button
              className="workbench-button-primary min-h-[44px] px-4"
              onClick={() => void approveAndAdoptDraft()}
              type="button"
            >
              {t('ai.planning.replaceManualDraft')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

/** Returns a currently authorized Planning draft for the Work Item workflow. */
function getAvailableWorkItemPlanningDraft(
  generation: AiAssistanceGeneration | undefined,
): AiPlanningDraft | undefined {
  if (
    !isReviewableAiAssistanceGeneration(generation, 'planning') ||
    generation.content.availability !== 'available' ||
    generation.content.draft.kind !== 'planning'
  ) return undefined
  return generation.content.draft
}
