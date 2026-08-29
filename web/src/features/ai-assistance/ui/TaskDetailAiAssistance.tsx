import type {
  AiAssistanceCitation,
  AiPlanningDraft,
  AiSummaryDraft,
  AiWorkItemSource,
  WorkItemDependencyEndpoint,
} from '@mukuroji/contracts'
import type { ReactNode } from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import type { AiAssistanceController } from '../mutations/useAiAssistanceController'
import { createAiAssistantSessionKey } from '../model/assistantSessionKey'
import { AiSummaryAssistant } from './AiSummaryAssistant'
import { AiWorkItemPlanningAssistant } from './AiWorkItemPlanningAssistant'

/** Context accepted by the feature-owned Work Item AI renderer. */
export type TaskDetailAiAssistanceRenderContext = {
  /** Active Workspace member bearer token. */
  accessToken?: string
  /** Whether the Planning workflow is enabled for this route. */
  aiAssistanceEnabled: boolean
  /** Whether the Summary workflow is enabled for this route. */
  aiSummaryAssistanceEnabled: boolean
  /** Whether a Work Item mutation is currently in flight. */
  isMutationPending: boolean
  /** Locale used by the assistants. */
  locale: Locale
  /** Reports authenticated AI failures to the route session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Copies an approved Planning draft into the local Work Item editor. */
  onPlanningAdopt?: (draft: AiPlanningDraft) => void | Promise<void>
  /** Reports Planning operation state to the local Work Item save guard. */
  onPlanningOperationPendingChange?: (pending: boolean) => void
  /** Determines whether a Planning draft contains an editable supported field. */
  canAdoptPlanningDraft?: (draft: AiPlanningDraft) => boolean
  /** Rechecks local edits after the asynchronous Planning approval. */
  shouldConfirmPlanningAdoption?: (draft: AiPlanningDraft) => boolean
  /** Resolves a visible workflow status label. */
  resolveStatusLabel?: (statusId: string) => string
  /** Resolves a visible Team-qualified Work Item label. */
  resolveWorkItemLabel?: (endpoint: WorkItemDependencyEndpoint) => string
  /** Whether Planning adoption must confirm replacing local edits. */
  requirePlanningAdoptionConfirmation?: boolean
  /** Reports Summary operation state to the local Work Item save guard. */
  onSummaryOperationPendingChange?: (pending: boolean) => void
  /** Revision-fenced Work Item source shared by both workflows. */
  source: AiWorkItemSource
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Summary slot passed to the Work Item collaboration panel. */
export type TaskDetailAiAssistanceSummarySlot = {
  /** Stable source-and-revision key used to fence delayed callbacks. */
  sessionKey: string
  /** Renders the summary assistant inside the collaboration Brief tab. */
  renderBrief: (
    onAdopt: ((draft: AiSummaryDraft, citations: readonly AiAssistanceCitation[]) => void) | undefined,
    onOperationPendingChange: ((sessionKey: string, pending: boolean) => void) | undefined,
  ) => ReactNode
}

/** AI slots mounted by a feature-owned Work Item renderer. */
export type TaskDetailAiAssistanceSlots = {
  /** Planning assistant rendered above the Work Item fields. */
  planning?: ReactNode
  /** Summary assistant supplied to the collaboration panel. */
  summary?: TaskDetailAiAssistanceSummarySlot
}

/**
 * Creates the feature-owned renderer used by the Work Item page container.
 *
 * @param controller - Optional controller override used by isolated stories.
 * @returns A renderer that returns Planning and Summary slots for one source.
 */
export function createTaskDetailAiAssistanceRenderer(
  controller?: AiAssistanceController,
): (context: TaskDetailAiAssistanceRenderContext) => TaskDetailAiAssistanceSlots {
  return (context) => {
    const sessionKey = createAiAssistantSessionKey(context.source)
    const planning = context.aiAssistanceEnabled &&
      (context.accessToken !== undefined || controller !== undefined)
      ? (
          <AiWorkItemPlanningAssistant
            accessToken={context.accessToken}
            canAdoptDraft={context.canAdoptPlanningDraft}
            controller={controller}
            isMutationPending={context.isMutationPending}
            key={sessionKey}
            locale={context.locale}
            onAuthenticatedApiError={context.onAuthenticatedApiError}
            onAdopt={context.onPlanningAdopt}
            onOperationPendingChange={context.onPlanningOperationPendingChange}
            resolveStatusLabel={context.resolveStatusLabel}
            resolveWorkItemLabel={context.resolveWorkItemLabel}
            requireAdoptionConfirmation={context.requirePlanningAdoptionConfirmation}
            shouldConfirmAdoption={context.shouldConfirmPlanningAdoption}
            source={context.source}
            t={context.t}
          />
        )
      : undefined

    const summary = context.aiSummaryAssistanceEnabled && context.accessToken
      ? {
          renderBrief: (
            onAdopt: ((draft: AiSummaryDraft, citations: readonly AiAssistanceCitation[]) => void) | undefined,
            onOperationPendingChange: ((sessionKey: string, pending: boolean) => void) | undefined,
          ) => (
            <AiSummaryAssistant
              accessToken={context.accessToken}
              adoptLabel={context.t('ai.summary.adoptContext')}
              key={sessionKey}
              locale={context.locale}
              onAdopt={onAdopt}
              onAuthenticatedApiError={context.onAuthenticatedApiError}
              onOperationPendingChange={(pending) => {
                context.onSummaryOperationPendingChange?.(pending)
                onOperationPendingChange?.(sessionKey, pending)
              }}
              sources={[context.source]}
              t={context.t}
            />
          ),
          sessionKey,
        }
      : undefined

    return { planning, summary }
  }
}

/** Creates the default route-scoped renderer without a test controller override. */
export const taskDetailAiAssistanceRenderer = createTaskDetailAiAssistanceRenderer()
