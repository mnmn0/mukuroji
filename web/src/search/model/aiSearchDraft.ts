import type {
  SearchCustomFieldFilter,
  SearchCustomFieldOperator,
  SearchCustomFieldValue,
  SearchEntityType,
  WorkspaceSearchDateField,
  WorkspaceSearchFilters,
} from '@mukuroji/contracts'

/** Search entity types that can be edited in an AI filter draft. */
export const aiSearchEntityTypes = [
  'work-item',
  'project',
  'team',
  'comment',
  'context-item',
  'file',
  'document',
] as const satisfies readonly SearchEntityType[]

/** Custom-field operators accepted by the editable AI filter draft. */
export const aiSearchCustomFieldOperators = [
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
  }
}

/**
 * Returns whether every reviewed custom-field comparison has an explicit value.
 *
 * Empty and not-empty operators intentionally omit a value; all other operators
 * must keep one so an incomplete row cannot broaden the applied Search query.
 *
 * @param filters - Locally edited Search filters.
 * @returns Whether the custom-field rows are safe to apply.
 */
export function hasReviewableAiSearchCustomFields(
  filters: WorkspaceSearchFilters,
): boolean {
  return (filters.customFields ?? []).every((filter) => {
    if (filter.operator === 'is-empty' || filter.operator === 'is-not-empty') return true
    if (filter.value === undefined) return false
    return typeof filter.value !== 'string' || filter.value.trim().length > 0
  })
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
    return Number.isSafeInteger(numericValue) ? numericValue : normalized
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

/** Returns whether text is a canonical base-ten integer accepted by Search. */
function isCanonicalNumberLiteral(value: string): boolean {
  return value !== '-0' && /^-?(?:0|[1-9]\d*)$/u.test(value)
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
