import {
  SEARCH_SCHEMA_VERSION,
  type SearchCustomFieldFilter,
  type SearchCustomFieldOperator,
  type SearchCustomFieldValue,
  type SearchEntityType,
  type SearchViewLayout,
  type SearchViewLayoutMode,
  type WorkspaceSearchDateField,
  type WorkspaceSearchFilters,
} from '@mukuroji/contracts'

/**
 * Search URL から復元する filter と layout の組です。
 */
export type SearchRouteState = {
  /**
   * API へ送信する Workspace search filter です。
   */
  filters: WorkspaceSearchFilters
  /**
   * Search result の表示、sort、group、column 設定です。
   */
  layout: SearchViewLayout
  /**
   * URL から選択された saved view ID です。
   */
  savedViewId?: string
  /**
   * URL schema を移行したときに利用者へ知らせる警告です。
   */
  migrationWarnings: string[]
}

const searchEntityTypes = [
  'work-item',
  'project',
  'team',
  'comment',
  'file',
  'document',
] as const satisfies readonly SearchEntityType[]

const searchLayoutModes = ['table', 'board', 'calendar', 'timeline'] as const satisfies readonly SearchViewLayoutMode[]
const workItemStatuses = ['todo', 'in-progress', 'review', 'done'] as const
const searchCustomFieldOperators = [
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
const defaultColumns = ['title', 'type', 'status', 'assignee', 'project', 'updatedAt']

/**
 * URLSearchParams を versioned Workspace search state へ変換します。
 *
 * 不明な値は無視し、未知の schema version は migration warning として返します。
 */
export function parseSearchRouteState(searchParams: URLSearchParams): SearchRouteState {
  const migrationWarnings: string[] = []
  const version = searchParams.get('v')

  if (version && version !== String(SEARCH_SCHEMA_VERSION)) {
    migrationWarnings.push(`Search URL v${version} was opened with v${SEARCH_SCHEMA_VERSION}.`)
  }

  const entityTypes = readRepeatedValues(searchParams, 'type', isSearchEntityType)
  const statuses = readRepeatedValues(searchParams, 'status', isWorkItemStatus)
  const customFields = searchParams
    .getAll('customField')
    .map(parseCustomFieldFilter)
    .filter((filter): filter is SearchCustomFieldFilter => Boolean(filter))
  const invalidCustomFieldCount = searchParams.getAll('customField').length - customFields.length
  const dateFrom = readOptionalValue(searchParams, 'dateFrom')
  const dateTo = readOptionalValue(searchParams, 'dateTo')

  if (invalidCustomFieldCount > 0) {
    migrationWarnings.push(`${invalidCustomFieldCount} custom field filter(s) could not be restored.`)
  }

  const filters = {
    keyword: readOptionalValue(searchParams, 'q'),
    entityTypes,
    statuses,
    assigneeUserIds: readRepeatedStrings(searchParams, 'assignee'),
    creatorUserIds: readRepeatedStrings(searchParams, 'creator'),
    teamIds: readRepeatedStrings(searchParams, 'team'),
    projectIds: readRepeatedStrings(searchParams, 'project'),
    date: dateFrom || dateTo ? {
      field: readEnumValue(searchParams.get('dateField'), ['createdAt', 'updatedAt', 'dueDate'] as const) ?? 'updatedAt',
      from: dateFrom,
      to: dateTo,
    } : undefined,
    customFields,
    relationIds: readRepeatedStrings(searchParams, 'relation'),
  } as unknown as WorkspaceSearchFilters
  const layoutMode = readEnumValue(searchParams.get('layout'), searchLayoutModes) ?? 'table'
  const columns = parseColumns(searchParams.get('columns'))
  const layout = {
    mode: layoutMode,
    sort: parseSort(searchParams.getAll('sort')),
    groupBy: readOptionalValue(searchParams, 'group'),
    columns,
  } as unknown as SearchViewLayout

  return {
    filters,
    layout,
    migrationWarnings,
    savedViewId: readOptionalValue(searchParams, 'view'),
  }
}

/**
 * Workspace search state を共有可能な canonical URL query へ直列化します。
 */
export function serializeSearchRouteState(state: SearchRouteState) {
  const searchParams = new URLSearchParams()
  const filters = asRecord(state.filters)
  const layout = asRecord(state.layout)

  searchParams.set('v', String(SEARCH_SCHEMA_VERSION))
  setOptionalValue(searchParams, 'q', readString(filters.keyword))
  appendValues(searchParams, 'type', readStringArray(filters.entityTypes))
  appendValues(searchParams, 'status', readStringArray(filters.statuses))
  appendValues(searchParams, 'assignee', readStringArray(filters.assigneeUserIds))
  appendValues(searchParams, 'creator', readStringArray(filters.creatorUserIds))
  appendValues(searchParams, 'team', readStringArray(filters.teamIds))
  appendValues(searchParams, 'project', readStringArray(filters.projectIds))
  const date = asRecord(filters.date)
  const dateField = readString(date.field)
  if (dateField && dateField !== 'updatedAt') {
    searchParams.set('dateField', dateField)
  }
  setOptionalValue(searchParams, 'dateFrom', readString(date.from))
  setOptionalValue(searchParams, 'dateTo', readString(date.to))
  appendValues(
    searchParams,
    'customField',
    readUnknownArray(filters.customFields).map((filter) => stableStringify(filter)),
  )
  appendValues(searchParams, 'relation', readStringArray(filters.relationIds))

  const mode = readString(layout.mode)
  if (mode && mode !== 'table') {
    searchParams.set('layout', mode)
  }
  const sort = readUnknownArray(layout.sort)
    .map((item) => {
      const sortItem = asRecord(item)
      const field = readString(sortItem.field)
      const direction = readString(sortItem.direction)
      return field && (direction === 'asc' || direction === 'desc')
        ? `${field}:${direction}`
        : undefined
    })
    .filter((value): value is string => Boolean(value))
  if (sort.join(',') !== 'relevance:desc') {
    appendOrderedValues(searchParams, 'sort', sort)
  }
  setOptionalValue(searchParams, 'group', readString(layout.groupBy))

  const columns = readStringArray(layout.columns)
  if (columns.length > 0 && columns.join(',') !== defaultColumns.join(',')) {
    searchParams.set('columns', columns.join(','))
  }
  setOptionalValue(searchParams, 'view', state.savedViewId)

  searchParams.sort()
  return searchParams
}

/**
 * Search state の一部を更新し、既存の migration warning を維持します。
 */
export function updateSearchRouteState(
  state: SearchRouteState,
  next: {
    /**
     * 置き換える filter です。
     */
    filters?: WorkspaceSearchFilters
    /**
     * 置き換える layout です。
     */
    layout?: SearchViewLayout
    /**
     * 置き換える saved view ID です。
     */
    savedViewId?: string
  },
): SearchRouteState {
  return {
    ...state,
    ...next,
    savedViewId: Object.hasOwn(next, 'savedViewId') ? next.savedViewId : state.savedViewId,
  }
}

/**
 * URL と saved view 由来の migration warning を表示順を保って一意化します。
 */
export function deduplicateSearchMigrationWarnings(
  ...warningGroups: readonly (readonly string[])[]
) {
  return [...new Set(warningGroups.flat())]
}

/**
 * URL state から keyword を安全に読み取ります。
 */
export function getSearchKeyword(filters: WorkspaceSearchFilters) {
  return readString(asRecord(filters).keyword) ?? ''
}

/**
 * URL state から検索対象 entity type を読み取ります。
 */
export function getSearchEntityTypes(filters: WorkspaceSearchFilters) {
  return readStringArray(asRecord(filters).entityTypes).filter(isSearchEntityType)
}

/**
 * URL state から選択中 status を読み取ります。
 */
export function getSearchStatuses(filters: WorkspaceSearchFilters) {
  return readStringArray(asRecord(filters).statuses).filter(isWorkItemStatus)
}

/**
 * URL state から任意の複数選択 filter を読み取ります。
 */
export function getSearchFilterValues(filters: WorkspaceSearchFilters, key: string) {
  return readStringArray(asRecord(filters)[key])
}

/**
 * URL state から日付 filter を読み取ります。
 */
export function getSearchDateValue(filters: WorkspaceSearchFilters, key: 'dateFrom' | 'dateTo') {
  const date = asRecord(asRecord(filters).date)
  return readString(date[key === 'dateFrom' ? 'from' : 'to']) ?? ''
}

/**
 * URL state から日付 filter の対象 field を読み取ります。
 */
export function getSearchDateField(filters: WorkspaceSearchFilters): WorkspaceSearchDateField {
  return readEnumValue(
    readString(asRecord(asRecord(filters).date).field),
    ['createdAt', 'updatedAt', 'dueDate'] as const,
  ) ?? 'updatedAt'
}

/**
 * URL state から custom field filter を読み取ります。
 */
export function getSearchCustomFields(filters: WorkspaceSearchFilters) {
  return readUnknownArray(asRecord(filters).customFields) as SearchCustomFieldFilter[]
}

/**
 * Search layout の表示モードを読み取ります。
 */
export function getSearchLayoutMode(layout: SearchViewLayout): SearchViewLayoutMode {
  return readEnumValue(readString(asRecord(layout).mode), searchLayoutModes) ?? 'table'
}

/**
 * Search layout の sort 値を読み取ります。
 */
export function getSearchSort(layout: SearchViewLayout) {
  const firstSort = asRecord(readUnknownArray(asRecord(layout).sort)[0])
  const field = readString(firstSort.field) ?? 'relevance'
  const direction = readString(firstSort.direction) === 'asc' ? 'asc' : 'desc'

  return `${field}:${direction}`
}

/**
 * Search layout の group 値を読み取ります。
 */
export function getSearchGroup(layout: SearchViewLayout) {
  return readString(asRecord(layout).groupBy) ?? ''
}

/**
 * Search layout の表示 column を読み取ります。
 */
export function getSearchColumns(layout: SearchViewLayout) {
  const columns = readStringArray(asRecord(layout).columns)

  return columns.length > 0
    ? ['title', ...columns.filter((column) => column !== 'title')]
    : [...defaultColumns]
}

function parseCustomFieldFilter(value: string): SearchCustomFieldFilter | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    const record = asRecord(parsed)
    const fieldId = readString(record.fieldId)
    const operator = readEnumValue(readString(record.operator), searchCustomFieldOperators)
    if (!fieldId || !operator) {
      return undefined
    }

    if (operator === 'is-empty' || operator === 'is-not-empty') {
      return { fieldId, operator } satisfies SearchCustomFieldFilter
    }

    return isSearchCustomFieldValue(record.value)
      ? { fieldId, operator, value: record.value }
      : undefined
  } catch {
    return undefined
  }
}

function isSearchCustomFieldValue(value: unknown): value is SearchCustomFieldValue {
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

function parseColumns(value: string | null) {
  const columns = value
    ?.split(',')
    .map((column) => column.trim())
    .filter(Boolean)

  return columns && columns.length > 0 ? [...new Set(columns)] : [...defaultColumns]
}

function isSearchEntityType(value: string): value is SearchEntityType {
  return searchEntityTypes.some((type) => type === value)
}

function isWorkItemStatus(value: string): value is (typeof workItemStatuses)[number] {
  return workItemStatuses.some((status) => status === value)
}

function parseSort(values: readonly string[]) {
  const sort = values.flatMap((value) => value.split(',')).flatMap((value) => {
    const directionSeparatorIndex = value.lastIndexOf(':')
    const field = directionSeparatorIndex > 0 ? value.slice(0, directionSeparatorIndex) : ''
    const direction = directionSeparatorIndex > 0 ? value.slice(directionSeparatorIndex + 1) : ''

    return field && (direction === 'asc' || direction === 'desc')
      ? [{ field, direction }]
      : []
  })

  return sort.length > 0 ? sort : [{ field: 'relevance', direction: 'desc' as const }]
}

function readRepeatedValues<TValue extends string>(
  searchParams: URLSearchParams,
  key: string,
  predicate: (value: string) => value is TValue,
) {
  return readRepeatedStrings(searchParams, key).filter(predicate)
}

function readRepeatedStrings(searchParams: URLSearchParams, key: string) {
  return [...new Set(searchParams.getAll(key).map((value) => value.trim()).filter(Boolean))]
}

function readOptionalValue(searchParams: URLSearchParams, key: string) {
  return searchParams.get(key)?.trim() || undefined
}

function readEnumValue<TValue extends string>(value: string | null | undefined, values: readonly TValue[]) {
  return value && values.some((candidate) => candidate === value)
    ? value as TValue
    : undefined
}

function appendValues(searchParams: URLSearchParams, key: string, values: readonly string[]) {
  for (const value of [...new Set(values)].sort()) {
    if (value) {
      searchParams.append(key, value)
    }
  }
}

function appendOrderedValues(searchParams: URLSearchParams, key: string, values: readonly string[]) {
  for (const value of values) {
    if (value) {
      searchParams.append(key, value)
    }
  }
}

function setOptionalValue(searchParams: URLSearchParams, key: string, value?: string) {
  if (value) {
    searchParams.set(key, value)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item))
    : []
}

function readUnknownArray(value: unknown) {
  return Array.isArray(value) ? value : []
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value) ?? 'null'
}
