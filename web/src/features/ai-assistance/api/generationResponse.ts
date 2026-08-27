import type {
  AiAssistanceCitation,
  AiAssistanceContent,
  AiAssistanceDecision,
  AiAssistanceDraft,
  AiAssistanceGeneration,
  AiAssistanceGenerationDetails,
  AiAssistanceTask,
  AiAssistanceUncertainty,
  AiAssistanceUsage,
  AiBriefItem,
  AiPlanningDependencyDraft,
  AiPlanningStatusUpdateDraft,
  AiPlanningSubtaskDraft,
  AiSuggestedValue,
  SearchCustomFieldFilter,
  WorkspaceSearchFilters,
} from '@mukuroji/contracts'
import { AiAssistanceApiError } from './errors'
import { isCurrentAiAssistanceGeneration } from '../model/aiGenerationValidation'

/**
 * Converts an untrusted AI generation response into a validated transport value.
 *
 * @param value - Unknown JSON returned by the AI assistance endpoint.
 * @param expectedTask - Optional workflow requested by the caller.
 * @returns A generation that satisfies the complete public contract.
 * @throws AiAssistanceApiError when the response shape is unsafe to expose.
 */
export function parseAiAssistanceGenerationResponse(
  value: unknown,
  expectedTask?: AiAssistanceTask,
): AiAssistanceGeneration {
  if (isCurrentAiAssistanceGeneration(value) &&
    (expectedTask === undefined || value.task === expectedTask) &&
    hasKnownGenerationFields(value)) return value
  throw new AiAssistanceApiError(
    502,
    'AI assistance API returned an invalid response.',
    'InvalidAiAssistanceResponse',
  )
}

/** Checks that a generation response contains only fields in the public contract. */
function hasKnownGenerationFields(generation: AiAssistanceGeneration): boolean {
  return hasOnlyKnownKeys(generation, [
    'schemaVersion',
    'id',
    'task',
    'revision',
    'content',
    'details',
    'decision',
    'createdAt',
    'expiresAt',
  ]) &&
    hasKnownContentFields(generation.content) &&
    hasKnownGenerationDetailsFields(generation.details) &&
    (generation.decision === undefined || hasKnownDecisionFields(generation.decision))
}

/** Checks the known shape of available or withheld generation content. */
function hasKnownContentFields(content: AiAssistanceContent): boolean {
  if (content.availability === 'withheld') {
    return hasOnlyKnownKeys(content, ['availability', 'reasonCode'])
  }

  return hasOnlyKnownKeys(content, ['availability', 'draft', 'citations', 'uncertainty']) &&
    hasKnownDraftFields(content.draft) &&
    content.citations.every(hasKnownCitationFields) &&
    hasKnownUncertaintyFields(content.uncertainty)
}

/** Checks the known shape of one workflow-specific draft. */
function hasKnownDraftFields(draft: AiAssistanceDraft): boolean {
  switch (draft.kind) {
    case 'triage':
      return hasOnlyKnownKeys(draft, [
        'kind',
        'title',
        'description',
        'priority',
        'assigneeUserId',
        'teamId',
        'projectId',
        'customFields',
      ]) &&
        hasKnownOptionalSuggestedValue(draft.title) &&
        hasKnownOptionalSuggestedValue(draft.description) &&
        hasKnownOptionalSuggestedValue(draft.priority) &&
        hasKnownOptionalSuggestedValue(draft.assigneeUserId) &&
        hasKnownOptionalSuggestedValue(draft.teamId) &&
        hasKnownOptionalSuggestedValue(draft.projectId) &&
        draft.customFields.every((field) =>
          hasKnownSuggestedValueFields(field) && hasOnlyKnownKeys(field, [
            'fieldId',
            'value',
            'reason',
            'confidence',
            'citationIds',
          ]))
    case 'summary':
      return hasOnlyKnownKeys(draft, ['kind', 'overview', 'decisions', 'actions', 'risks']) &&
        hasKnownBriefItemFields(draft.overview) &&
        draft.decisions.every(hasKnownBriefItemFields) &&
        draft.actions.every(hasKnownBriefItemFields) &&
        draft.risks.every(hasKnownBriefItemFields)
    case 'search':
      return hasOnlyKnownKeys(draft, ['kind', 'interpretation', 'filters', 'report', 'caveats']) &&
        hasKnownSearchFilterFields(draft.filters) &&
        (draft.report === undefined || hasOnlyKnownKeys(draft.report, ['metric', 'groupBy']))
    case 'planning':
      return hasOnlyKnownKeys(draft, [
        'kind',
        'title',
        'description',
        'priority',
        'status',
        'plannedEffortMinutes',
        'subtasks',
        'dependencies',
        'statusUpdate',
      ]) &&
        hasKnownOptionalSuggestedValue(draft.title) &&
        hasKnownOptionalSuggestedValue(draft.description) &&
        hasKnownOptionalSuggestedValue(draft.priority) &&
        hasKnownOptionalSuggestedValue(draft.status) &&
        hasKnownOptionalSuggestedValue(draft.plannedEffortMinutes) &&
        draft.subtasks.every(hasKnownPlanningSubtaskFields) &&
        draft.dependencies.every(hasKnownPlanningDependencyFields) &&
        (draft.statusUpdate === undefined || hasKnownPlanningStatusUpdateFields(draft.statusUpdate))
    default:
      return false
  }
}

/** Checks the shared fields of an optional suggested value. */
function hasKnownOptionalSuggestedValue(value: AiSuggestedValue<unknown> | undefined): boolean {
  return value === undefined || hasKnownSuggestedValueFields(value)
}

/** Checks the known fields of one evidence-backed suggested value. */
function hasKnownSuggestedValueFields(value: AiSuggestedValue<unknown>): boolean {
  return hasOnlyKnownKeys(value, ['value', 'reason', 'confidence', 'citationIds'])
}

/** Checks the known fields of one grounded summary item. */
function hasKnownBriefItemFields(item: AiBriefItem): boolean {
  return hasOnlyKnownKeys(item, ['id', 'text', 'confidence', 'citationIds'])
}

/** Checks the known fields of one permission-safe citation. */
function hasKnownCitationFields(citation: AiAssistanceCitation): boolean {
  return hasOnlyKnownKeys(citation, [
    'id',
    'sourceType',
    'label',
    'href',
    'excerpt',
    'capturedRevision',
  ])
}

/** Checks the known fields of the generation uncertainty disclosure. */
function hasKnownUncertaintyFields(uncertainty: AiAssistanceUncertainty): boolean {
  return hasOnlyKnownKeys(uncertainty, ['level', 'reason'])
}

/** Checks the known fields of technical provider usage metadata. */
function hasKnownGenerationDetailsFields(details: AiAssistanceGenerationDetails): boolean {
  return hasOnlyKnownKeys(details, ['provider', 'modelId', 'promptVersion', 'traceId', 'usage']) &&
    hasKnownUsageFields(details.usage)
}

/** Checks the known fields of provider usage metadata. */
function hasKnownUsageFields(usage: AiAssistanceUsage): boolean {
  return hasOnlyKnownKeys(usage, [
    'inputTokens',
    'outputTokens',
    'latencyMs',
    'costUsd',
    'costUnavailableReason',
  ])
}

/** Checks the known fields of a recorded human decision. */
function hasKnownDecisionFields(decision: AiAssistanceDecision): boolean {
  return hasOnlyKnownKeys(decision, ['outcome', 'decidedAt'])
}

/** Checks the known fields of a Planning child-item proposal. */
function hasKnownPlanningSubtaskFields(subtask: AiPlanningSubtaskDraft): boolean {
  return hasOnlyKnownKeys(subtask, [
    'id',
    'title',
    'description',
    'priority',
    'plannedEffortMinutes',
    'reason',
    'confidence',
    'citationIds',
  ])
}

/** Checks the known fields of a Planning dependency proposal. */
function hasKnownPlanningDependencyFields(dependency: AiPlanningDependencyDraft): boolean {
  return hasOnlyKnownKeys(dependency, [
    'id',
    'predecessor',
    'successor',
    'type',
    'lagDays',
    'reason',
    'confidence',
    'citationIds',
  ]) &&
    hasOnlyKnownKeys(dependency.predecessor, ['teamId', 'workItemId']) &&
    hasOnlyKnownKeys(dependency.successor, ['teamId', 'workItemId'])
}

/** Checks the known fields of a structured Planning status update. */
function hasKnownPlanningStatusUpdateFields(update: AiPlanningStatusUpdateDraft): boolean {
  return hasOnlyKnownKeys(update, [
    'health',
    'risk',
    'summary',
    'riskSummary',
    'decisionSummary',
    'helpNeeded',
    'nextAction',
    'confidence',
    'citationIds',
  ])
}

/** Checks the known fields of a Search filter set and its nested rows. */
function hasKnownSearchFilterFields(filters: WorkspaceSearchFilters): boolean {
  return hasOnlyKnownKeys(filters, [
    'keyword',
    'entityTypes',
    'assigneeUserIds',
    'creatorUserIds',
    'statuses',
    'customFields',
    'relationIds',
    'date',
    'projectIds',
    'teamIds',
  ]) &&
    (filters.customFields === undefined || filters.customFields.every(hasKnownSearchCustomFieldFields)) &&
    (filters.date === undefined || hasOnlyKnownKeys(filters.date, ['field', 'from', 'to']))
}

/** Checks the known fields of one Search custom-field filter. */
function hasKnownSearchCustomFieldFields(filter: SearchCustomFieldFilter): boolean {
  return hasOnlyKnownKeys(filter, ['fieldId', 'operator', 'value'])
}

/** Checks an object for keys outside the supplied public contract allowlist. */
function hasOnlyKnownKeys(value: object, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}
