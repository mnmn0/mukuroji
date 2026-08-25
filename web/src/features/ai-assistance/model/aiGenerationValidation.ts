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
    isNonEmptyString(value.id) &&
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
      return isOptionalSuggested(value.title, isString) &&
        isOptionalSuggested(value.description, isString) &&
        isOptionalSuggested(value.priority, isPriority) &&
        isOptionalSuggested(value.assigneeUserId, isString) &&
        isOptionalSuggested(value.teamId, isString) &&
        isOptionalSuggested(value.projectId, isString) &&
        Array.isArray(value.customFields) &&
        value.customFields.every(isSuggestedCustomField) &&
        hasUniqueSuggestedCustomFieldIds(value.customFields)
    case 'summary':
      if (
        !isBriefItem(value.overview) ||
        !isBriefItemArray(value.decisions) ||
        !isBriefItemArray(value.actions) ||
        !isBriefItemArray(value.risks)
      ) return false
      return hasUniqueBriefItemIds([
        value.overview,
        ...value.decisions,
        ...value.actions,
        ...value.risks,
      ])
    case 'search':
      return isString(value.interpretation) &&
        isWorkspaceSearchFilters(value.filters) &&
        (value.report === undefined || isSearchReport(value.report)) &&
        isStringArray(value.caveats)
    case 'planning':
      return isOptionalSuggested(value.title, isString) &&
        isOptionalSuggested(value.description, isString) &&
        isOptionalSuggested(value.priority, isPriority) &&
        isOptionalSuggested(value.status, isNonEmptyString) &&
        isOptionalSuggested(value.plannedEffortMinutes, isBoundedEffortMinutes) &&
        Array.isArray(value.subtasks) &&
        value.subtasks.every(isPlanningSubtask) &&
        hasUniquePlanningRowIds(value.subtasks) &&
        Array.isArray(value.dependencies) &&
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
    isString(value.reason) &&
    isConfidence(value.confidence) &&
    isStringArray(value.citationIds)
}

/** Validates a custom-field suggestion and its supported value. */
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
    isString(value.text) &&
    isConfidence(value.confidence) &&
    isStringArray(value.citationIds)
}

/** Validates an array of grounded brief items. */
function isBriefItemArray(value: unknown): value is AiBriefItem[] {
  return Array.isArray(value) && value.every(isBriefItem)
}

/** Validates the complete safe Workspace search filter contract. */
function isWorkspaceSearchFilters(value: unknown): boolean {
  if (!isRecord(value)) return false

  return isOptionalBoundedString(value.keyword, 256) &&
    isOptionalEnumArray(value.entityTypes, entityTypeValues, entityTypeValues.length) &&
    isOptionalStringArray(value.assigneeUserIds, 100, 512) &&
    isOptionalStringArray(value.creatorUserIds, 100, 512) &&
    isOptionalStringArray(value.statuses, 100, 512) &&
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

/** Validates an optional array of custom-field filters. */
function isOptionalCustomFieldArray(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > 50) return false
  for (const filter of value) {
    if (
      !isRecord(filter) ||
      !isBoundedString(filter.fieldId, 256) ||
      !isOneOf(filter.operator, customFieldOperatorValues) ||
      (filter.value === undefined &&
        filter.operator !== 'is-empty' &&
        filter.operator !== 'is-not-empty') ||
      (filter.value !== undefined && !isCustomFieldValue(filter.value))
    ) return false
  }
  return true
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
    isString(value.title) &&
    isOptionalString(value.description) &&
    isPriority(value.priority) &&
    (value.plannedEffortMinutes === undefined || isBoundedEffortMinutes(value.plannedEffortMinutes)) &&
    isString(value.reason) &&
    isConfidence(value.confidence) &&
    isStringArray(value.citationIds)
}

/** Validates one proposed planning dependency. */
function isPlanningDependency(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyString(value.id) &&
    isDependencyEndpoint(value.predecessor) &&
    isDependencyEndpoint(value.successor) &&
    isOneOf(value.type, [
      'finish-to-start',
      'start-to-start',
      'finish-to-finish',
      'start-to-finish',
    ]) &&
    isBoundedLagDays(value.lagDays) &&
    isString(value.reason) &&
    isConfidence(value.confidence) &&
    isStringArray(value.citationIds)
}

/** Validates a Team-qualified Work Item dependency endpoint. */
function isDependencyEndpoint(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyString(value.teamId) &&
    isNonEmptyString(value.workItemId)
}

/** Validates a proposed structured Planning status update. */
function isPlanningStatusUpdate(value: unknown): boolean {
  return isRecord(value) &&
    isOneOf(value.health, ['unknown', 'on-track', 'at-risk', 'off-track']) &&
    isOneOf(value.risk, ['none', 'low', 'medium', 'high', 'critical']) &&
    isString(value.summary) &&
    isString(value.riskSummary) &&
    isString(value.decisionSummary) &&
    isString(value.helpNeeded) &&
    isString(value.nextAction) &&
    isConfidence(value.confidence) &&
    isStringArray(value.citationIds)
}

/** Validates one permission-safe evidence citation. */
function isCitation(value: unknown): value is AiAssistanceCitation {
  return isRecord(value) &&
    isNonEmptyString(value.id) &&
    isOneOf(value.sourceType, sourceTypeValues) &&
    isString(value.label) &&
    isSafeApplicationPath(value.href) &&
    isOptionalString(value.excerpt) &&
    isNonNegativeInteger(value.capturedRevision)
}

/** Validates the overall uncertainty disclosure. */
function isUncertainty(value: unknown): boolean {
  return isRecord(value) &&
    isConfidence(value.level) &&
    isString(value.reason)
}

/** Validates technical generation details and provider usage. */
function isGenerationDetails(value: unknown): boolean {
  return isRecord(value) &&
    value.provider === 'bedrock' &&
    isNonEmptyString(value.modelId) &&
    isNonEmptyString(value.promptVersion) &&
    isNonEmptyString(value.traceId) &&
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

/** Validates a supported custom-field value. */
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

/** Validates one supported AI assistance workflow discriminator. */
function isAiAssistanceTask(value: unknown): value is AiAssistanceTask {
  return isOneOf(value, aiAssistanceTaskValues)
}

/** Validates an AI confidence label. */
function isConfidence(value: unknown): boolean {
  return isOneOf(value, confidenceValues)
}

/** Validates an optional string. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value)
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

/** Validates a string array. */
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString)
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

/** Validates an ISO 8601 instant with an explicit UTC designator or numeric offset. */
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
