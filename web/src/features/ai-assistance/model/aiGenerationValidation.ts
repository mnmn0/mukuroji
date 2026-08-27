import type {
  AiAssistanceCitation,
  AiAssistanceDraft,
  AiAssistanceGeneration,
  AiAssistanceSource,
  AiAssistanceTask,
  AiBriefItem,
  SearchCustomFieldOperator,
  SearchEntityType,
  WorkspaceSearchDateField,
} from '@mukuroji/contracts'
import { isSafeApplicationPath } from '../../../shared/routing/applicationPath'

const confidenceValues = ['high', 'medium', 'low'] as const
const sourceTypeValues = [
  'triage-entry',
  'request-submission',
  'work-item',
  'document',
  'planning-target',
] as const satisfies readonly AiAssistanceSource['type'][]
const entityTypeValues = [
  'work-item',
  'project',
  'team',
  'comment',
  'context-item',
  'file',
  'document',
] as const satisfies readonly SearchEntityType[]
const customFieldOperatorValues = [
  'equals',
  'not-equals',
  'contains',
  'greater-than',
  'greater-than-or-equal',
  'less-than',
  'less-than-or-equal',
  'is-empty',
  'is-not-empty',
] as const satisfies readonly SearchCustomFieldOperator[]
const aiAssistanceTaskValues = [
  'triage',
  'summary',
  'search',
  'planning',
] as const satisfies readonly AiAssistanceTask[]
const searchDateFieldValues = [
  'createdAt',
  'updatedAt',
  'dueDate',
] as const satisfies readonly WorkspaceSearchDateField[]
const workflowStatusIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i
/** Identifier grammar used by the existing Team triage action endpoints. */
const triageIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
/** Member identifier grammar used by the existing Team triage action endpoints. */
const triageUserIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u

/** Maximum UTF-8 size accepted by the Planning status update endpoint. */
const planningStatusUpdateTextMaximumBytes = 8_000
/** Maximum number of citations exposed from one AI generation response. */
const aiAssistanceCitationMaximumCount = 100
/** Maximum number of citation references attached to one generated claim. */
const aiAssistanceCitationReferencesMaximumCount = 20
/** Maximum length of one generation-local citation identifier. */
const aiAssistanceCitationIdentifierMaximumLength = 256
/** Maximum number of summary items in one category. */
const aiAssistanceSummaryItemsMaximumCount = 100
/** Maximum number of triage custom-field suggestions. */
const aiAssistanceTriageCustomFieldsMaximumCount = 50
/** Maximum number of Search caveats shown before applying a draft. */
const aiAssistanceSearchCaveatsMaximumCount = 20
/** Maximum length of one Search caveat. */
const aiAssistanceSearchCaveatMaximumLength = 1_000
/** Maximum length of the human-readable Search interpretation shown before apply. */
const aiAssistanceSearchInterpretationMaximumLength = 4_000
/** Maximum number of Planning child Work Items. */
const aiAssistancePlanningSubtasksMaximumCount = 50
/** Maximum title length for one proposed Planning child Work Item. */
const aiAssistancePlanningSubtaskTitleMaximumLength = 256
/** Maximum description length for one proposed Planning child Work Item. */
const aiAssistancePlanningSubtaskDescriptionMaximumLength = 20_000
/** Maximum number of Planning dependency suggestions. */
const aiAssistancePlanningDependenciesMaximumCount = 100
/** Maximum length of a Team or Work Item identifier rendered in a dependency row. */
const aiAssistancePlanningDependencyIdentifierMaximumLength = 512
/** Maximum citation label length accepted by the server response contract. */
const aiAssistanceCitationLabelMaximumLength = 500
/** Maximum citation destination length accepted by the server response contract. */
const aiAssistanceCitationHrefMaximumLength = 2_000
/** Maximum displayed citation excerpt length accepted by the server response contract. */
const aiAssistanceCitationExcerptMaximumLength = 2_000
/** Maximum rationale length accepted for one model-generated suggestion or uncertainty note. */
const aiAssistanceRationaleMaximumLength = 2_000
/** Maximum length of a displayed Bedrock model identifier. */
const aiAssistanceModelIdMaximumLength = 256
/** Maximum length of a displayed prompt version identifier. */
const aiAssistancePromptVersionMaximumLength = 256
/** Maximum length of a displayed server trace identifier. */
const aiAssistanceTraceIdMaximumLength = 256
/** Maximum length of a generation identifier used in decision and feedback URLs. */
const aiAssistanceGenerationIdMaximumLength = 256

/**
 * Returns whether an unknown value is a fully grounded available generation for one workflow.
 *
 * @param value - Generation value received before a review or adoption action.
 * @param task - Workflow expected by the current product surface.
 * @returns Whether the complete envelope, task, draft, citations, and claim references are valid.
 */
export function isReviewableAiAssistanceGeneration(
  value: unknown,
  task: AiAssistanceTask,
): value is AiAssistanceGeneration {
  return isAiAssistanceGeneration(value) &&
    value.task === task &&
    value.content.availability === 'available'
}

/**
 * Validates the complete generation envelope and its permission-aware content.
 *
 * @param value - Unknown value received from an API boundary or a Storybook fixture.
 * @returns Whether the value satisfies the complete generation contract.
 */
export function isAiAssistanceGeneration(value: unknown): value is AiAssistanceGeneration {
  if (!isRecord(value)) return false
  const task = value.task

  return value.schemaVersion === 1 &&
    isBoundedString(value.id, aiAssistanceGenerationIdMaximumLength) &&
    isAiAssistanceTask(task) &&
    isNonNegativeInteger(value.revision) &&
    isAiAssistanceContent(value.content, task) &&
    isGenerationDetails(value.details) &&
    (value.decision === undefined || isDecision(value.decision)) &&
    isIsoInstant(value.createdAt) &&
    isIsoInstant(value.expiresAt)
}

/** Validates an available or withheld generation content boundary. */
function isAiAssistanceContent(value: unknown, task: AiAssistanceTask): boolean {
  if (!isRecord(value)) return false
  if (value.availability === 'withheld') {
    return isOneOf(value.reasonCode, [
      'permission-changed',
      'retention-expired',
      'source-changed',
    ])
  }

  if (
    value.availability !== 'available' ||
    !isAiAssistanceDraft(value.draft) ||
    value.draft.kind !== task ||
    !Array.isArray(value.citations) ||
    value.citations.length > aiAssistanceCitationMaximumCount ||
    !value.citations.every(isCitation) ||
    !hasUniqueCitations(value.citations) ||
    !isUncertainty(value.uncertainty)
  ) {
    return false
  }

  return hasGroundedDraftReferences(value.draft, value.citations)
}

/** Validates one workflow-specific AI draft. */
function isAiAssistanceDraft(value: unknown): value is AiAssistanceDraft {
  if (!isRecord(value)) return false

  switch (value.kind) {
    case 'triage':
      return isOptionalSuggested(value.title, (candidate) => isBoundedNonEmptyTrimmedString(candidate, 256)) &&
        isOptionalSuggested(value.description, (candidate) =>
          isBoundedNonEmptyTrimmedString(candidate, 20_000)) &&
        isOptionalSuggested(value.priority, isPriority) &&
        isOptionalSuggested(value.assigneeUserId, isTriageUserId) &&
        isOptionalSuggested(value.teamId, isTriageIdentifier) &&
        isOptionalSuggested(value.projectId, isTriageIdentifier) &&
        Array.isArray(value.customFields) &&
        value.customFields.length <= aiAssistanceTriageCustomFieldsMaximumCount &&
        value.customFields.every(isSuggestedCustomField) &&
        hasUniqueSuggestedCustomFieldIds(value.customFields)
    case 'summary':
      if (
        !isBriefItem(value.overview) ||
        !isBriefItemArray(value.decisions, aiAssistanceSummaryItemsMaximumCount) ||
        !isBriefItemArray(value.actions, aiAssistanceSummaryItemsMaximumCount) ||
        !isBriefItemArray(value.risks, aiAssistanceSummaryItemsMaximumCount)
      ) return false
      return hasUniqueBriefItemIds([
        value.overview,
        ...value.decisions,
        ...value.actions,
        ...value.risks,
      ])
    case 'search':
      return isBoundedNonEmptyTrimmedString(
          value.interpretation,
          aiAssistanceSearchInterpretationMaximumLength,
        ) &&
        isWorkspaceSearchFilters(value.filters) &&
        (value.report === undefined || isSearchReport(value.report)) &&
        isStringArray(
          value.caveats,
          aiAssistanceSearchCaveatsMaximumCount,
          aiAssistanceSearchCaveatMaximumLength,
        )
    case 'planning':
      return isOptionalSuggested(value.title, (candidate) =>
          isBoundedNonEmptyTrimmedString(candidate, 256)) &&
        isOptionalSuggested(value.description, (candidate) =>
          isBoundedNonEmptyTrimmedString(candidate, 20_000)) &&
        isOptionalSuggested(value.priority, isPriority) &&
        isOptionalSuggested(value.status, (candidate) => isBoundedString(candidate, 256)) &&
        isOptionalSuggested(value.plannedEffortMinutes, isBoundedEffortMinutes) &&
        Array.isArray(value.subtasks) &&
        value.subtasks.length <= aiAssistancePlanningSubtasksMaximumCount &&
        value.subtasks.every(isPlanningSubtask) &&
        hasUniquePlanningRowIds(value.subtasks) &&
        Array.isArray(value.dependencies) &&
        value.dependencies.length <= aiAssistancePlanningDependenciesMaximumCount &&
        value.dependencies.every(isPlanningDependency) &&
        hasUniquePlanningRowIds(value.dependencies) &&
        (value.statusUpdate === undefined || isPlanningStatusUpdate(value.statusUpdate))
    default:
      return false
  }
}

/** Rejects duplicate model-generated row identifiers before React renders keyed lists. */
function hasUniquePlanningRowIds(items: readonly unknown[]): boolean {
  const identifiers = new Set<string>()
  for (const item of items) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || identifiers.has(item.id)) {
      return false
    }
    identifiers.add(item.id)
  }
  return true
}

/** Rejects duplicate summary identifiers before a keyed review list is rendered. */
function hasUniqueBriefItemIds(items: readonly unknown[]): boolean {
  const identifiers = new Set<string>()
  for (const item of items) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || identifiers.has(item.id)) {
      return false
    }
    identifiers.add(item.id)
  }
  return true
}

/** Validates unique permission-safe citation identifiers. */
function hasUniqueCitations(citations: readonly AiAssistanceCitation[]): boolean {
  const citationIds = new Set<string>()
  for (const citation of citations) {
    if (citationIds.has(citation.id)) return false
    citationIds.add(citation.id)
  }
  return true
}

/** Requires every generated claim to cite at least one currently available source. */
function hasGroundedDraftReferences(
  draft: AiAssistanceDraft,
  citations: readonly AiAssistanceCitation[],
): boolean {
  const citationIds = new Set(citations.map((citation) => citation.id))
  if (draft.kind === 'search') return citations.length === 0
  if (draft.kind === 'summary') {
    return [
      draft.overview,
      ...draft.decisions,
      ...draft.actions,
      ...draft.risks,
    ].every((item) => hasKnownCitationIds(item.citationIds, citationIds))
  }
  if (draft.kind === 'triage') {
    const suggestions = [
      draft.title,
      draft.description,
      draft.priority,
      draft.assigneeUserId,
      draft.teamId,
      draft.projectId,
      ...draft.customFields,
    ].filter(isDefined)
    return suggestions.every((suggestion) =>
      hasKnownCitationIds(suggestion.citationIds, citationIds))
  }
  const suggestions = [
    draft.title,
    draft.description,
    draft.priority,
    draft.status,
    draft.plannedEffortMinutes,
  ].filter(isDefined)
  return [
    ...suggestions.map((suggestion) => suggestion.citationIds),
    ...draft.subtasks.map((subtask) => subtask.citationIds),
    ...draft.dependencies.map((dependency) => dependency.citationIds),
    ...(draft.statusUpdate ? [draft.statusUpdate.citationIds] : []),
  ].every((references) => hasKnownCitationIds(references, citationIds))
}

/** Validates one non-empty list of known citation identifiers. */
function hasKnownCitationIds(
  references: readonly string[],
  citationIds: ReadonlySet<string>,
): boolean {
  return references.length > 0 && references.every((citationId) => citationIds.has(citationId))
}

/** Removes absent optional values while preserving their narrowed type. */
function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined
}

/** Validates an optional evidence-backed suggested value. */
function isOptionalSuggested(
  value: unknown,
  isValue: (candidate: unknown) => boolean,
): boolean {
  return value === undefined || isSuggestedValue(value, isValue)
}

/** Validates a suggested value while keeping rationale, confidence, and citations adjacent. */
function isSuggestedValue(
  value: unknown,
  isValue: (candidate: unknown) => boolean,
): boolean {
  return isRecord(value) &&
    isValue(value.value) &&
    isBoundedString(value.reason, aiAssistanceRationaleMaximumLength) &&
    isConfidence(value.confidence) &&
    isCitationIdArray(value.citationIds)
}

/**
 * Validates one custom-field suggestion at the model-output boundary.
 *
 * A suggestion requires a trimmed field ID up to 256 characters plus the
 * shared value, rationale, confidence, and citation-ID fields.
 *
 * @param value - Unknown model output to validate.
 * @returns Whether the value is a supported evidence-backed custom-field suggestion.
 */
function isSuggestedCustomField(value: unknown): boolean {
  return isRecord(value) &&
    isBoundedString(value.fieldId, 256) &&
    isSuggestedValue(value, isCustomFieldValue)
}

/** Rejects duplicate triage custom-field suggestions before keyed review rendering. */
function hasUniqueSuggestedCustomFieldIds(items: readonly unknown[]): boolean {
  const fieldIds = new Set<string>()
  for (const item of items) {
    if (!isRecord(item) || !isBoundedString(item.fieldId, 256) || fieldIds.has(item.fieldId)) {
      return false
    }
    fieldIds.add(item.fieldId)
  }
  return true
}

/** Validates one grounded brief item. */
function isBriefItem(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyString(value.id) &&
    isBoundedNonEmptyTrimmedString(value.text, 20_000) &&
    isConfidence(value.confidence) &&
    isCitationIdArray(value.citationIds)
}

/** Validates a bounded array of grounded brief items. */
function isBriefItemArray(
  value: unknown,
  maximumItems: number,
): value is AiBriefItem[] {
  return Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every(isBriefItem)
}

/**
 * Validates the complete permission-safe Workspace search filter contract.
 *
 * Optional identifiers are bounded arrays, dates are calendar-valid and
 * ordered, and custom-field rows must satisfy the bounded operator/value
 * contract before a draft can reach the Search route.
 *
 * @param value - Unknown model output representing proposed filters.
 * @returns Whether every supplied filter is safe to expose for review.
 */
function isWorkspaceSearchFilters(value: unknown): boolean {
  if (!isRecord(value)) return false

  return isOptionalBoundedString(value.keyword, 256) &&
    isOptionalEnumArray(value.entityTypes, entityTypeValues, entityTypeValues.length) &&
    isOptionalStringArray(value.assigneeUserIds, 100, 512) &&
    isOptionalStringArray(value.creatorUserIds, 100, 512) &&
    isOptionalSearchStatusIdArray(value.statuses) &&
    isOptionalCustomFieldArray(value.customFields) &&
    isOptionalStringArray(value.relationIds, 100, 512) &&
    (value.date === undefined || isSearchDate(value.date)) &&
    isOptionalStringArray(value.projectIds, 100, 512) &&
    isOptionalStringArray(value.teamIds, 100, 512)
}

/** Validates a Workspace search date boundary. */
function isSearchDate(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isOneOf(value.field, searchDateFieldValues) ||
    !isOptionalCalendarDate(value.from) ||
    !isOptionalCalendarDate(value.to)
  ) return false
  if (value.from === undefined && value.to === undefined) return false
  if (value.from === undefined || value.to === undefined) return true
  return value.from <= value.to
}

/** Validates an optional fixed-width Gregorian calendar date. */
function isOptionalCalendarDate(value: unknown): value is string | undefined {
  return value === undefined || isCalendarDate(value)
}

/** Validates optional Search status IDs with the same grammar as URL serialization. */
function isOptionalSearchStatusIdArray(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(isSearchStatusId)
  )
}

/** Rejects status identifiers that Search URL serialization would silently drop. */
function isSearchStatusId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= 128 &&
    value.length > 0 &&
    value === value.trim() &&
    workflowStatusIdPattern.test(value)
}

/** Validates a fixed-width Gregorian calendar date without timezone coercion. */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  const daysByMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  return month >= 1 && month <= 12 && day >= 1 && day <= (daysByMonth[month - 1] ?? 0)
}

/**
 * Validates an optional bounded array of custom-field filters.
 *
 * Up to fifty rows are allowed; each row needs a trimmed field ID and supported
 * operator. Value-less rows are valid only for `is-empty` and `is-not-empty`.
 *
 * @param value - Unknown custom-field filter array from model output.
 * @returns Whether the optional array satisfies the Search filter contract.
 */
function isOptionalCustomFieldArray(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > 50) return false
  for (const filter of value) {
    if (!isRecord(filter)) return false
    if (!isCustomFieldOperator(filter.operator)) return false
    const operator = filter.operator
    if (
      !isBoundedString(filter.fieldId, 256) ||
      (filter.value === undefined &&
        operator !== 'is-empty' &&
        operator !== 'is-not-empty') ||
      (filter.value !== undefined && !isCustomFieldFilterValue(operator, filter.value)) ||
      ((operator === 'is-empty' || operator === 'is-not-empty') &&
        filter.value !== undefined)
    ) return false
  }
  return true
}

/** Narrows an unknown value to one supported custom-field operator. */
function isCustomFieldOperator(value: unknown): value is SearchCustomFieldOperator {
  return isOneOf(value, customFieldOperatorValues)
}

/** Validates a custom-field value against the operator-specific Search semantics. */
function isCustomFieldFilterValue(
  operator: SearchCustomFieldOperator,
  value: unknown,
): boolean {
  if (operator === 'greater-than' || operator === 'greater-than-or-equal' ||
    operator === 'less-than' || operator === 'less-than-or-equal') {
    return isFiniteNumber(value)
  }
  if (operator === 'contains') {
    return (isBoundedNonEmptyTrimmedString(value, 20_000)) || (
      Array.isArray(value) &&
      value.length <= 100 &&
      value.every((item) => isBoundedString(item, 512))
    )
  }
  return isCustomFieldValue(value)
}

/** Validates the optional count report preview. */
function isSearchReport(value: unknown): boolean {
  return isRecord(value) &&
    value.metric === 'count' &&
    (value.groupBy === undefined || isOneOf(value.groupBy, [
      'entityType',
      'assignee',
      'creator',
      'status',
      'project',
      'team',
    ]))
}

/** Validates one proposed planning subtask. */
function isPlanningSubtask(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyString(value.id) &&
    isBoundedNonEmptyTrimmedString(value.title, aiAssistancePlanningSubtaskTitleMaximumLength) &&
    (value.description === undefined ||
      isBoundedNonEmptyTrimmedString(value.description, aiAssistancePlanningSubtaskDescriptionMaximumLength)) &&
    isPriority(value.priority) &&
    (value.plannedEffortMinutes === undefined || isBoundedEffortMinutes(value.plannedEffortMinutes)) &&
    isBoundedString(value.reason, aiAssistanceRationaleMaximumLength) &&
    isConfidence(value.confidence) &&
    isCitationIdArray(value.citationIds)
}

/** Validates a Team triage route identifier before an action form can adopt it. */
function isTriageIdentifier(value: unknown): value is string {
  return isBoundedString(value, 200) && triageIdentifierPattern.test(value)
}

/** Validates a Team triage member identifier before an action form can adopt it. */
function isTriageUserId(value: unknown): value is string {
  return isBoundedString(value, 320) && triageUserIdPattern.test(value)
}

/** Validates one proposed planning dependency. */
function isPlanningDependency(value: unknown): boolean {
  if (!isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isDependencyEndpoint(value.predecessor) ||
    !isDependencyEndpoint(value.successor)) return false

  return (value.predecessor.teamId !== value.successor.teamId ||
    value.predecessor.workItemId !== value.successor.workItemId) &&
    isOneOf(value.type, [
      'finish-to-start',
      'start-to-start',
      'finish-to-finish',
      'start-to-finish',
    ]) &&
    isBoundedLagDays(value.lagDays) &&
    isBoundedString(value.reason, aiAssistanceRationaleMaximumLength) &&
    isConfidence(value.confidence) &&
    isCitationIdArray(value.citationIds)
}

/**
 * Validates a Team-qualified Work Item dependency endpoint.
 *
 * @param value - Unknown model-controlled endpoint value.
 * @returns Whether the value contains trimmed Team and Work Item identifiers,
 * each bounded to the dependency display limit.
 */
function isDependencyEndpoint(
  value: unknown,
): value is { teamId: string; workItemId: string } {
  return isRecord(value) &&
    isBoundedNonEmptyTrimmedString(value.teamId, aiAssistancePlanningDependencyIdentifierMaximumLength) &&
    isBoundedNonEmptyTrimmedString(value.workItemId, aiAssistancePlanningDependencyIdentifierMaximumLength)
}

/** Validates a proposed structured Planning status update. */
function isPlanningStatusUpdate(value: unknown): boolean {
  return isRecord(value) &&
    isOneOf(value.health, ['unknown', 'on-track', 'at-risk', 'off-track']) &&
    isOneOf(value.risk, ['none', 'low', 'medium', 'high', 'critical']) &&
    isBoundedPlanningStatusUpdateText(value.summary, true) &&
    isBoundedPlanningStatusUpdateText(value.riskSummary) &&
    isBoundedPlanningStatusUpdateText(value.decisionSummary) &&
    isBoundedPlanningStatusUpdateText(value.helpNeeded) &&
    isBoundedPlanningStatusUpdateText(value.nextAction, true) &&
    isConfidence(value.confidence) &&
    isCitationIdArray(value.citationIds)
}

/**
 * Validates one Planning status text field against the server's UTF-8 boundary.
 *
 * @param value - Unknown model-controlled status text.
 * @param required - Whether an empty trimmed value should be rejected.
 * @returns Whether the value is a bounded string suitable for the status form.
 */
function isBoundedPlanningStatusUpdateText(value: unknown, required = false): value is string {
  if (typeof value !== 'string') return false
  if (!isWellFormedUnicode(value)) return false
  const normalized = value.trim()
  return (!required || normalized.length > 0) &&
    new TextEncoder().encode(normalized).byteLength <= planningStatusUpdateTextMaximumBytes
}

/** Rejects lone UTF-16 surrogates before browser encoding can replace them. */
function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return false
      index += 1
      continue
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false
  }
  return true
}

/** Validates one permission-safe evidence citation. */
function isCitation(value: unknown): value is AiAssistanceCitation {
  return isRecord(value) &&
    isBoundedString(value.id, aiAssistanceCitationIdentifierMaximumLength) &&
    isOneOf(value.sourceType, sourceTypeValues) &&
    isBoundedNonEmptyTrimmedString(value.label, aiAssistanceCitationLabelMaximumLength) &&
    isBoundedSafeApplicationPath(value.href, aiAssistanceCitationHrefMaximumLength) &&
    isOptionalBoundedString(value.excerpt, aiAssistanceCitationExcerptMaximumLength) &&
    isNonNegativeInteger(value.capturedRevision)
}

/** Validates a bounded application-relative citation destination. */
function isBoundedSafeApplicationPath(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' &&
    value.length <= maximumLength &&
    isSafeApplicationPath(value)
}

/** Validates a bounded list of generation-local citation identifiers. */
function isCitationIdArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= aiAssistanceCitationReferencesMaximumCount &&
    value.every((item) => isBoundedString(item, aiAssistanceCitationIdentifierMaximumLength))
}

/** Validates the overall uncertainty disclosure. */
function isUncertainty(value: unknown): boolean {
  return isRecord(value) &&
    isConfidence(value.level) &&
    isBoundedString(value.reason, aiAssistanceRationaleMaximumLength)
}

/** Validates technical generation details and provider usage. */
function isGenerationDetails(value: unknown): boolean {
  return isRecord(value) &&
    value.provider === 'bedrock' &&
    isBoundedNonEmptyTrimmedString(value.modelId, aiAssistanceModelIdMaximumLength) &&
    isBoundedNonEmptyTrimmedString(value.promptVersion, aiAssistancePromptVersionMaximumLength) &&
    isBoundedNonEmptyTrimmedString(value.traceId, aiAssistanceTraceIdMaximumLength) &&
    isUsage(value.usage)
}

/** Validates token, latency, and optional cost usage metadata. */
function isUsage(value: unknown): boolean {
  return isRecord(value) &&
    (value.inputTokens === undefined || isNonNegativeInteger(value.inputTokens)) &&
    (value.outputTokens === undefined || isNonNegativeInteger(value.outputTokens)) &&
    isNonNegativeInteger(value.latencyMs) &&
    (value.costUsd === undefined || isNonNegativeFiniteNumber(value.costUsd)) &&
    (value.costUnavailableReason === undefined || isOneOf(value.costUnavailableReason, [
      'provider-not-reported',
      'pricing-not-configured',
    ]))
}

/** Validates a recorded human review decision. */
function isDecision(value: unknown): boolean {
  return isRecord(value) &&
    isOneOf(value.outcome, ['approved', 'rejected']) &&
    isIsoInstant(value.decidedAt)
}

/**
 * Validates a supported custom-field value.
 *
 * Allowed values are null, strings up to 20,000 characters, finite numbers,
 * booleans, or arrays of at most 100 strings with each item at most 512
 * characters; other JSON shapes are rejected.
 *
 * @param value - Unknown value supplied by a model-generated custom-field row.
 * @returns Whether the value is one of the bounded Search primitives.
 */
function isCustomFieldValue(value: unknown): boolean {
  return value === null ||
    (isString(value) && value.length <= 20_000) ||
    isFiniteNumber(value) ||
    typeof value === 'boolean' ||
    (Array.isArray(value) &&
      value.length <= 100 &&
      value.every((item) => isBoundedString(item, 512)))
}

/** Validates a built-in Work Item priority. */
function isPriority(value: unknown): boolean {
  return isOneOf(value, ['high', 'medium', 'low'])
}

/**
 * Validates one supported AI assistance workflow discriminator.
 *
 * The allowlist is intentionally limited to triage, summary, search, and
 * planning so a model cannot select an unimplemented workflow.
 *
 * @param value - Unknown task discriminator from model output.
 * @returns Whether the value belongs to the supported task allowlist.
 */
function isAiAssistanceTask(value: unknown): value is AiAssistanceTask {
  return isOneOf(value, aiAssistanceTaskValues)
}

/** Validates an AI confidence label. */
function isConfidence(value: unknown): boolean {
  return isOneOf(value, confidenceValues)
}

/** Validates an optional string array. */
function isOptionalStringArray(
  value: unknown,
  maximumItems = Number.POSITIVE_INFINITY,
  maximumLength = Number.POSITIVE_INFINITY,
): boolean {
  return value === undefined || (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => isBoundedString(item, maximumLength))
  )
}

/** Validates an optional array whose members belong to a fixed string set. */
function isOptionalEnumArray(
  value: unknown,
  allowed: readonly string[],
  maximumItems = Number.POSITIVE_INFINITY,
): boolean {
  return value === undefined || (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => isOneOf(item, allowed))
  )
}

/** Validates a bounded string array. */
function isStringArray(
  value: unknown,
  maximumItems = Number.POSITIVE_INFINITY,
  maximumLength = Number.POSITIVE_INFINITY,
): boolean {
  return Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => isBoundedString(item, maximumLength))
}

/** Validates membership in a fixed string set. */
function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value)
}

/** Narrows an unknown value to a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates a string without imposing product-specific length constraints. */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** Validates a non-empty string identifier. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Validates a non-empty trimmed string within a protocol length bound. */
function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim()
}

/** Validates a bounded prose value whose trimmed representation is non-empty. */
function isBoundedNonEmptyTrimmedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === 'string' &&
    value.length <= maximumLength &&
    value.trim().length > 0
}

/** Validates an optional bounded string without changing its representation. */
function isOptionalBoundedString(value: unknown, maximumLength: number): value is string | undefined {
  return value === undefined || (
    typeof value === 'string' &&
    value.length <= maximumLength
  )
}

/** Validates a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Validates a finite number that cannot produce a negative cost display. */
function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

/** Validates whole non-negative effort minutes within the server contract. */
function isBoundedEffortMinutes(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 10_000_000
}

/** Validates whole dependency lead-or-lag days within the server contract. */
function isBoundedLagDays(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= -36_600 &&
    value <= 36_600
}

/**
 * Validates an ISO 8601 instant with an explicit UTC designator or numeric offset.
 *
 * The timestamp must contain a real Gregorian date, a 24-hour clock, optional
 * millisecond precision, and either `Z` or an offset from `+00:00` through
 * `+23:59` / `-23:59`.
 *
 * @param value - Unknown timestamp from a generation or decision response.
 * @returns Whether the value is an offset-qualified instant accepted by the contract.
 */
function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/u.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1] ?? 0
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth &&
    hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 &&
    second >= 0 && second <= 59 && Number.isFinite(Date.parse(value))
}

/** Validates a non-negative integer. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
