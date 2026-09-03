import type {
  SearchCustomFieldFilter,
  SearchCustomFieldOperator,
  SearchCustomFieldValue,
  SearchEntityType,
  WorkspaceSearchDateField,
  WorkspaceSearchFilters,
} from '@mukuroji/contracts'
import { readSearchWorkItemTypeKey } from '@mukuroji/contracts'
import { isSearchFilterTransportWithinGetBudget } from './searchFilterTransportBudget'

/** Search entity types that can be edited in an AI filter draft. */
export const aiSearchEntityTypes: readonly SearchEntityType[] = [
  'work-item',
  'project',
  'team',
  'comment',
  'context-item',
  'file',
  'document',
]

/** Custom-field operators accepted by the editable AI filter draft. */
export const aiSearchCustomFieldOperators: readonly SearchCustomFieldOperator[] = [
  'equals',
  'not-equals',
  'contains',
  'greater-than',
  'greater-than-or-equal',
  'less-than',
  'less-than-or-equal',
  'is-empty',
  'is-not-empty',
]

const AI_SEARCH_MAX_LIST_ITEMS = 100
const AI_SEARCH_MAX_IDENTIFIER_LENGTH = 512
const AI_SEARCH_MAX_STATUS_ID_LENGTH = 128
const AI_SEARCH_MAX_KEYWORD_LENGTH = 256
const AI_SEARCH_MAX_CUSTOM_FIELDS = 50
const AI_SEARCH_MAX_CUSTOM_FIELD_ID_LENGTH = 256
const AI_SEARCH_MAX_CUSTOM_FIELD_VALUE_LENGTH = 20_000
const AI_SEARCH_MAX_CUSTOM_FIELD_ARRAY_ITEMS = 100

/**
 * Copies a server-validated filter set into local editable form state.
 *
 * @param filters - Structured filters returned by the AI generation endpoint.
 * @returns A detached filter object safe to edit without mutating the generation.
 */
export function createEditableAiSearchFilters(
  filters: WorkspaceSearchFilters,
): WorkspaceSearchFilters {
  return {
    keyword: filters.keyword,
    entityTypes: filters.entityTypes ? [...filters.entityTypes] : undefined,
    assigneeUserIds: filters.assigneeUserIds ? [...filters.assigneeUserIds] : undefined,
    creatorUserIds: filters.creatorUserIds ? [...filters.creatorUserIds] : undefined,
    statuses: filters.statuses ? [...filters.statuses] : undefined,
    customFields: filters.customFields?.map((filter) => ({
      fieldId: filter.fieldId,
      operator: filter.operator,
      value: Array.isArray(filter.value) ? [...filter.value] : filter.value,
    })),
    relationIds: filters.relationIds ? [...filters.relationIds] : undefined,
    date: filters.date ? { ...filters.date } : undefined,
    projectIds: filters.projectIds ? [...filters.projectIds] : undefined,
    teamIds: filters.teamIds ? [...filters.teamIds] : undefined,
    workItemTypeIds: filters.workItemTypeIds ? [...filters.workItemTypeIds] : undefined,
  }
}

/**
 * Removes empty form values before applying an AI filter draft to URL state.
 *
 * @param filters - Locally reviewed filter state.
 * @returns Canonical structured filters ready for the existing Search route state.
 */
export function normalizeAiSearchFilters(
  filters: WorkspaceSearchFilters,
): WorkspaceSearchFilters {
  const keyword = filters.keyword?.trim()
  const date = filters.date && (filters.date.from || filters.date.to)
    ? {
        field: filters.date.field,
        from: filters.date.from || undefined,
        to: filters.date.to || undefined,
      }
    : undefined

  return {
    keyword: keyword || undefined,
    entityTypes: nonEmptyArray(filters.entityTypes),
    assigneeUserIds: cleanStringArray(filters.assigneeUserIds),
    creatorUserIds: cleanStringArray(filters.creatorUserIds),
    statuses: cleanStringArray(filters.statuses),
    customFields: nonEmptyArray(filters.customFields?.filter((filter) => filter.fieldId.trim())),
    relationIds: cleanStringArray(filters.relationIds),
    date,
    projectIds: cleanStringArray(filters.projectIds),
    teamIds: cleanStringArray(filters.teamIds),
    workItemTypeIds: cleanStringArray(filters.workItemTypeIds),
  }
}

/**
 * Returns whether every reviewed custom-field comparison is safe to apply.
 *
 * Empty and not-empty operators intentionally omit a value; all other operators
 * must keep one, and string values must not be blank, so an incomplete row
 * cannot broaden the applied Search query.
 *
 * @param filters - Workspace Search filters containing locally edited custom-field rows.
 * @returns `true` when every custom-field row satisfies the review constraints.
 */
export function hasReviewableAiSearchCustomFields(
  filters: WorkspaceSearchFilters,
): boolean {
  return (filters.customFields ?? []).every((filter) => (
    isReviewableCustomFieldRow(filter) &&
    (typeof filter.value !== 'string' || filter.value.trim().length > 0)
  ))
}

/**
 * Returns whether non-date Search filters remain within the server's bounds.
 *
 * This guard runs again after local editing and before approval so a large
 * keyword, identifier list, or custom-field payload cannot be approved only to
 * fail later when the canonical Search endpoint validates it.
 *
 * @param filters - Locally edited Search filters.
 * @returns Whether every non-date filter satisfies the server size contract.
 */
export function hasReviewableAiSearchFilterBounds(
  filters: WorkspaceSearchFilters,
): boolean {
  if (!isSearchFilterTransportWithinGetBudget(filters)) return false
  if (filters.keyword !== undefined && (
    typeof filters.keyword !== 'string' ||
    filters.keyword.length > AI_SEARCH_MAX_KEYWORD_LENGTH
  )) return false
  if (!hasBoundedStringList(filters.assigneeUserIds)) return false
  if (!hasBoundedStringList(filters.creatorUserIds)) return false
  if (!hasBoundedStatusIdList(filters.statuses)) return false
  if (!hasBoundedStringList(filters.relationIds)) return false
  if (!hasBoundedStringList(filters.projectIds)) return false
  if (!hasBoundedStringList(filters.teamIds)) return false
  if (!hasBoundedSearchWorkItemTypeKeyList(filters.workItemTypeIds)) return false
  if (filters.entityTypes !== undefined && (
    !Array.isArray(filters.entityTypes) ||
    filters.entityTypes.length > aiSearchEntityTypes.length ||
    !filters.entityTypes.every((value) => aiSearchEntityTypes.includes(value))
  )) return false
  if (filters.customFields !== undefined && (
    !Array.isArray(filters.customFields) ||
    filters.customFields.length > AI_SEARCH_MAX_CUSTOM_FIELDS ||
    !filters.customFields.every(isBoundedCustomFieldFilter)
  )) return false
  return true
}

/** Validates locally edited Work Item Type filters as Team-qualified Search keys. */
function hasBoundedSearchWorkItemTypeKeyList(
  values: readonly string[] | undefined,
): boolean {
  return values === undefined || (
    hasBoundedStringList(values) &&
    values.every((value) => readSearchWorkItemTypeKey(value) !== undefined)
  )
}

/**
 * Returns whether the optional date filter is valid independently of other fields.
 *
 * @param filters - Locally edited Search filters.
 * @returns Whether the date field and boundaries are calendar-valid and ordered.
 */
export function hasReviewableAiSearchDate(
  filters: WorkspaceSearchFilters,
): boolean {
  const date = filters.date
  if (!date || (!date.from && !date.to)) return true
  if (!isAiSearchDateField(date.field)) return false
  if (date.from !== undefined && !isCalendarDate(date.from)) return false
  if (date.to !== undefined && !isCalendarDate(date.to)) return false
  return date.from === undefined || date.to === undefined || date.from <= date.to
}

/**
 * Returns whether all locally edited AI Search filters can be applied safely.
 *
 * Empty date boundaries are treated as an intentionally cleared date filter;
 * supplied boundaries must be real Gregorian dates in ascending order.
 *
 * @param filters - Locally edited Search filters.
 * @returns Whether custom-field and date constraints are safe to apply.
 */
export function hasReviewableAiSearchFilters(
  filters: WorkspaceSearchFilters,
): boolean {
  return hasReviewableAiSearchFilterBounds(filters) &&
    hasReviewableAiSearchCustomFields(filters) &&
    hasReviewableAiSearchDate(filters)
}

/**
 * Parses a comma-separated form value into stable unique identifiers.
 *
 * @param value - Editable comma-separated input.
 * @returns Trimmed identifiers in first-seen order.
 */
export function parseAiSearchList(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
}

/**
 * Formats structured identifiers for a comma-separated input.
 *
 * @param values - Structured filter identifiers.
 * @returns A comma-separated editable value.
 */
export function formatAiSearchList(values?: readonly string[]): string {
  return values?.join(', ') ?? ''
}

/**
 * Parses an editable custom-field value using the same primitive contract as Search.
 *
 * @param value - User-edited text value.
 * @returns A supported structured custom-field value.
 */
export function parseAiSearchCustomFieldValue(value: string): SearchCustomFieldValue {
  const normalized = value.trim()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  if (normalized === 'null') return null
  if (isCanonicalNumberLiteral(normalized)) {
    const numericValue = Number(normalized)
    return Number.isFinite(numericValue) &&
      (!Number.isInteger(numericValue) || Number.isSafeInteger(numericValue))
      ? numericValue
      : normalized
  }
  if (normalized.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(normalized)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed
      }
    } catch {
      return value
    }
  }

  return value
}

/** Returns whether text is a canonical base-ten integer or decimal accepted by Search. */
function isCanonicalNumberLiteral(value: string): boolean {
  if (value === '-0') return false
  return /^-?(?:0|[1-9]\d*)$/u.test(value) ||
    /^-?(?:0|[1-9]\d*)\.\d*[1-9]$/u.test(value)
}

/** Validates a supported Search date field identifier. */
function isAiSearchDateField(value: string): value is WorkspaceSearchDateField {
  return value === 'createdAt' || value === 'updatedAt' || value === 'dueDate'
}

/** Validates a fixed-width Gregorian calendar date without timezone coercion. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
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

/** Validates one list against the bounded Search identifier contract. */
function hasBoundedStringList(values: readonly string[] | undefined): boolean {
  return values === undefined || (
    Array.isArray(values) &&
    values.length <= AI_SEARCH_MAX_LIST_ITEMS &&
    values.every((value) => (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= AI_SEARCH_MAX_IDENTIFIER_LENGTH &&
      value === value.trim()
    ))
  )
}

/** Validates workflow status IDs with the same grammar as Search URL serialization. */
function hasBoundedStatusIdList(values: readonly string[] | undefined): boolean {
  return values === undefined || (
    Array.isArray(values) &&
    values.length <= AI_SEARCH_MAX_LIST_ITEMS &&
    values.every((value) => (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= AI_SEARCH_MAX_STATUS_ID_LENGTH &&
      value === value.trim() &&
      /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i.test(value)
    ))
  )
}

/** Validates one custom-field row against Search bounds and operator semantics. */
function isBoundedCustomFieldFilter(filter: SearchCustomFieldFilter): boolean {
  return typeof filter.fieldId === 'string' &&
    filter.fieldId.length > 0 &&
    filter.fieldId.length <= AI_SEARCH_MAX_CUSTOM_FIELD_ID_LENGTH &&
    filter.fieldId === filter.fieldId.trim() &&
    isReviewableCustomFieldRow(filter)
}

/** Validates one custom-field row's operator and value semantics. */
function isReviewableCustomFieldRow(filter: SearchCustomFieldFilter): boolean {
  if (!aiSearchCustomFieldOperators.includes(filter.operator)) return false
  if (filter.operator === 'is-empty' || filter.operator === 'is-not-empty') {
    return filter.value === undefined
  }
  return filter.value !== undefined && isReviewableCustomFieldValue(filter.operator, filter.value)
}

/** Validates a custom-field value using the operator-specific Search contract. */
function isReviewableCustomFieldValue(
  operator: SearchCustomFieldOperator,
  value: SearchCustomFieldValue,
): boolean {
  if (operator === 'greater-than' || operator === 'greater-than-or-equal' ||
    operator === 'less-than' || operator === 'less-than-or-equal') {
    return typeof value === 'number' && Number.isFinite(value)
  }
  if (operator === 'contains') {
    return typeof value === 'string'
      ? value.trim().length > 0 && value.length <= AI_SEARCH_MAX_CUSTOM_FIELD_VALUE_LENGTH
      : Array.isArray(value) && value.length > 0 && value.length <= AI_SEARCH_MAX_CUSTOM_FIELD_ARRAY_ITEMS &&
        value.every((item) => item.trim().length > 0 && item.length <= AI_SEARCH_MAX_IDENTIFIER_LENGTH)
  }
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= AI_SEARCH_MAX_CUSTOM_FIELD_VALUE_LENGTH
  return value.length <= AI_SEARCH_MAX_CUSTOM_FIELD_ARRAY_ITEMS &&
    value.every((item) => item.length <= AI_SEARCH_MAX_IDENTIFIER_LENGTH)
}

/**
 * Formats a custom-field filter value for an editable input.
 *
 * @param value - Structured custom-field value.
 * @returns A stable text representation.
 */
export function formatAiSearchCustomFieldValue(value: SearchCustomFieldValue | undefined): string {
  if (Array.isArray(value)) return JSON.stringify(value)
  return value === null ? 'null' : String(value ?? '')
}

/**
 * Reads a supported custom-field operator without an unsafe assertion.
 *
 * @param value - Select value from the DOM.
 * @returns A supported operator, falling back to equals.
 */
export function readAiSearchCustomFieldOperator(value: string): SearchCustomFieldOperator {
  return aiSearchCustomFieldOperators.find((operator) => operator === value) ?? 'equals'
}

/**
 * Reads a supported Search date field without an unsafe assertion.
 *
 * @param value - Select value from the DOM.
 * @returns A supported date field, falling back to updatedAt.
 */
export function readAiSearchDateField(value: string): WorkspaceSearchDateField {
  if (value === 'createdAt' || value === 'dueDate') return value
  return 'updatedAt'
}

/**
 * Toggles one entity type in an editable filter set.
 *
 * @param values - Currently selected entity types.
 * @param value - Entity type selected by the operator.
 * @returns A new selected entity type array.
 */
export function toggleAiSearchEntityType(
  values: readonly SearchEntityType[] | undefined,
  value: SearchEntityType,
): SearchEntityType[] {
  const current = values ?? []
  return current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value]
}

/** Returns a non-empty copied array or undefined. */
function nonEmptyArray<Value>(values: readonly Value[] | undefined): Value[] | undefined {
  return values && values.length > 0 ? [...values] : undefined
}

/** Trims and removes empty repeated Search identifiers. */
function cleanStringArray(values: readonly string[] | undefined): string[] | undefined {
  return nonEmptyArray(values?.map((value) => value.trim()).filter(Boolean))
}

/**
 * Replaces one custom-field row without mutating the current filter array.
 *
 * @param filters - Existing custom-field filter rows.
 * @param index - Row index to replace.
 * @param patch - Reviewed field changes.
 * @returns A new custom-field filter array.
 */
export function updateAiSearchCustomField(
  filters: readonly SearchCustomFieldFilter[],
  index: number,
  patch: Partial<SearchCustomFieldFilter>,
): SearchCustomFieldFilter[] {
  return filters.map((filter, filterIndex) => filterIndex === index
    ? { ...filter, ...patch }
    : { ...filter })
}
