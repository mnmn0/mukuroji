import type {
  AiRequestSubmissionSource,
  AiTriageDraft,
  AiTriageEntrySource,
  CreateAiAssistanceFeedbackRequest,
} from '@mukuroji/contracts'
import { useState } from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { isReviewableAiAssistanceGeneration } from '../model/aiGenerationValidation'
import {
  useAiAssistanceController,
  type AiAssistanceController,
} from '../mutations/useAiAssistanceController'
import { AiAssistanceReview } from './AiAssistanceReview'

/** Props for an explicit evidence-first triage draft workflow. */
export type AiTriageDraftComposerProps = {
  /** Bearer token for the active Workspace member. */
  readonly accessToken?: string
  /** Workflow-specific label for copying the reviewed proposal into a form. */
  readonly adoptLabel: string
  /** Optional controller override used by isolated stories and interaction tests. */
  readonly controller?: AiAssistanceController
  /** Locale sent to Bedrock and used for visible generation metadata. */
  readonly locale: Locale
  /** Copies a reviewed draft into local form state without mutating a domain resource. */
  readonly onAdoptDraft: (draft: AiTriageDraft) => void | Promise<void>
  /** Permission-scoped source reference and optimistic revision. */
  readonly source: AiTriageEntrySource | AiRequestSubmissionSource
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
}

/**
 * Connects one explicit triage generation to the shared review and decision workflow.
 *
 * @param props - Authentication, source revision, labels, and local form adoption callback.
 * @returns A flat proposal rail that never invokes a domain mutation.
 */
export function AiTriageDraftComposer({
  accessToken,
  adoptLabel,
  controller,
  locale,
  onAdoptDraft,
  source,
  t,
}: AiTriageDraftComposerProps) {
  const liveController = useAiAssistanceController({ accessToken })
  const activeController = controller ?? liveController
  const [generatedForRevision, setGeneratedForRevision] = useState<number>()
  const [isStale, setIsStale] = useState(false)
  const canGenerate = Boolean(accessToken || controller)
  const availableDraft = getAvailableTriageDraft(activeController.generation)
  const isSourceStale = generatedForRevision !== undefined &&
    generatedForRevision !== source.expectedRevision
  const hasInvalidDraft = !isSourceStale &&
    activeController.generation?.content.availability === 'available' &&
    !availableDraft
  const isOperationPending = activeController.isGenerating ||
    activeController.isDecisionPending ||
    activeController.isFeedbackPending

  /** Generates only after the operator activates the explicit button. */
  const generateDraft = async () => {
    if (!canGenerate || isOperationPending) return
    const requestedRevision = source.expectedRevision
    setIsStale(false)
    const generation = await activeController.generate({ locale, source, task: 'triage' })
    if (generation) setGeneratedForRevision(requestedRevision)
  }

  /** Records approval before copying the currently authorized draft into local form state. */
  const adoptDraft = async () => {
    if (generatedForRevision !== source.expectedRevision) {
      setIsStale(true)
      return
    }
    const reviewedGeneration = await activeController.decide('approved')
    const reviewedDraft = getAvailableTriageDraft(reviewedGeneration)
    if (reviewedGeneration?.decision?.outcome !== 'approved' || !reviewedDraft) return
    await onAdoptDraft(reviewedDraft)
  }

  return (
    <section className="grid gap-4" data-testid="ai-triage-composer">
      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-[var(--workbench-border)] py-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('ai.triage.title')}
          </h3>
          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
            {t('ai.triage.description')}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canGenerate || isOperationPending}
          onClick={() => void generateDraft()}
          type="button"
        >
          {activeController.isGenerating ? t('ai.triage.generating') : t('ai.triage.generate')}
        </button>
      </div>

      {hasInvalidDraft ? (
        <AiAssistanceReview
          errorKind="validation"
          locale={locale}
          renderDraft={() => null}
          t={t}
        />
      ) : (
        <AiAssistanceReview
          adoptLabel={adoptLabel}
          errorKind={isStale || isSourceStale ? 'conflict' : activeController.error?.kind}
          feedbackRating={activeController.feedbackRating}
          generation={isSourceStale ? undefined : activeController.generation}
          isDecisionPending={activeController.isDecisionPending}
          isFeedbackPending={activeController.isFeedbackPending}
          isGenerating={activeController.isGenerating}
          locale={locale}
          onAdopt={availableDraft && !isSourceStale ? adoptDraft : undefined}
          onCancelGeneration={activeController.cancelGeneration}
          onFeedback={(rating: CreateAiAssistanceFeedbackRequest['rating']) =>
            activeController.sendFeedback(rating)}
          onReject={availableDraft && !isSourceStale ? async () => {
            await activeController.decide('rejected')
          } : undefined}
          renderDraft={({ draft }) => draft.kind === 'triage'
            ? <AiTriageDraftFields draft={draft} t={t} />
            : null}
          t={t}
        />
      )}
    </section>
  )
}

/** Props for the permission-safe triage proposal field list. */
export type AiTriageDraftFieldsProps = {
  /** Structured triage proposal returned from the authorized server workflow. */
  readonly draft: AiTriageDraft
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
}

/**
 * Renders all proposed triage fields with their rationale and confidence.
 *
 * @param props - Validated triage draft and localized labels.
 * @returns A flat definition list suitable for Request and Team triage surfaces.
 */
export function AiTriageDraftFields({ draft, t }: AiTriageDraftFieldsProps) {
  const fields = [
    draft.title ? { key: 'title', label: t('ai.triage.field.title'), suggestion: draft.title } : undefined,
    draft.description ? { key: 'description', label: t('ai.triage.field.description'), suggestion: draft.description } : undefined,
    draft.priority ? { key: 'priority', label: t('ai.triage.field.priority'), suggestion: draft.priority } : undefined,
    draft.assigneeUserId ? { key: 'assignee', label: t('ai.triage.field.assignee'), suggestion: draft.assigneeUserId } : undefined,
    draft.teamId ? { key: 'team', label: t('ai.triage.field.team'), suggestion: draft.teamId } : undefined,
    draft.projectId ? { key: 'project', label: t('ai.triage.field.project'), suggestion: draft.projectId } : undefined,
    ...draft.customFields.map((suggestion) => ({
      key: `custom-field:${suggestion.fieldId}`,
      label: t('ai.triage.field.customField').replace('{fieldId}', suggestion.fieldId),
      suggestion,
    })),
  ].filter(isDefined)

  if (fields.length === 0) {
    return <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('ai.triage.empty')}</p>
  }

  return (
    <dl className="divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
      {fields.map((field) => (
        <div className="grid gap-2 py-3 first:pt-0 last:pb-0" key={field.key}>
          <dt className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
            {field.label}
          </dt>
          <dd className="whitespace-pre-wrap break-words text-sm font-semibold text-[var(--workbench-text)]">
            {formatSuggestedValue(field.suggestion.value)}
          </dd>
          <dd className="flex flex-wrap items-start justify-between gap-2 text-xs font-medium text-[var(--workbench-muted)]">
            <span className="min-w-0 flex-1">{field.suggestion.reason}</span>
            <span className="rounded-md border border-[var(--workbench-border)] bg-white px-2 py-1 font-semibold">
              {t(`ai.review.confidence.${field.suggestion.confidence}`)}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Returns a triage draft only when the complete generation has the expected task and shape. */
function getAvailableTriageDraft(
  generation: AiAssistanceController['generation'],
): AiTriageDraft | undefined {
  if (
    !isReviewableAiAssistanceGeneration(generation, 'triage') ||
    generation.content.availability !== 'available' ||
    generation.content.draft.kind !== 'triage'
  ) return undefined
  return generation.content.draft
}

/** Formats a supported custom-field or scalar suggestion without rendering unsafe markup. */
function formatSuggestedValue(value: string | number | boolean | readonly string[] | null): string {
  if (value === null) return '—'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/** Removes absent optional field descriptors with a reusable type guard. */
function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined
}
