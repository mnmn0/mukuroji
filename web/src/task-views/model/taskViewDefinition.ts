import {
  TASK_VIEW_SURFACES,
  type SearchCustomFieldFilter,
  type SearchCustomFieldOperator,
  type SearchEntityType,
  type TaskViewColumn,
  type TaskViewDefinition,
  type TaskViewDensity,
  type TaskViewDisplayOptions,
  type TaskViewDueDatePreset,
  type TaskViewFilters,
  type TaskViewGrouping,
  type TaskViewLayout,
  type TaskViewLayoutMode,
  type TaskViewMigrationFallback,
  type TaskViewMigrationSection,
  type TaskViewMigrationWarning,
  type TaskViewMigrationWarningCode,
  type TaskViewScope,
  type TaskViewSort,
  type TaskViewSurface,
  type TaskViewUrlOverride,
  type TaskViewWorkflowStatusFilter,
  type WorkflowStatusCategory,
  type WorkItemPriority,
  type WorkspaceSearchDateFilter,
} from '@mukuroji/contracts'

const taskViewLayoutModes: readonly TaskViewLayoutMode[] = [
  'table',
  'board',
  'list',
  'gantt',
  'calendar',
  'timeline',
]
const taskViewDensities: readonly TaskViewDensity[] = [
  'compact',
  'comfortable',
  'spacious',
]
const searchEntityTypes: readonly SearchEntityType[] = [
  'work-item',
  'project',
  'team',
  'comment',
  'file',
  'document',
]
const searchCustomFieldOperators: readonly SearchCustomFieldOperator[] = [
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
const workflowStatusCategories: readonly WorkflowStatusCategory[] = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
]
const workItemPriorities: readonly WorkItemPriority[] = ['high', 'medium', 'low']
const taskViewDueDatePresets: readonly TaskViewDueDatePreset[] = [
  'overdue',
  'today',
  'upcoming',
  'no-date',
]
const taskViewDisplayOptionIds: readonly (keyof TaskViewDisplayOptions)[] = [
  'showCompleted',
  'showArchived',
  'showSubItems',
  'showEmptyGroups',
  'wrapText',
  'showAssigneeAvatars',
]
const taskViewFilterIds: readonly string[] = [
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
  'workflowStatuses',
  'workflowCategories',
  'priorities',
  'dueDatePreset',
  'includeArchived',
]
const taskViewLayoutOverrideIds: readonly string[] = [
  'mode',
  'group',
  'subgroup',
  'sort',
  'columns',
  'density',
  'displayOptions',
]

/** Source used to produce an effective task view definition. */
export type TaskViewDefinitionSource =
  | 'built-in'
  | 'team-default'
  | 'personal-default'
  | 'selected-view'
  | 'url-override'

/** Complete definition candidates resolved from lowest to highest precedence. */
export type ResolveTaskViewDefinitionInput = {
  /** Required permission-safe built-in definition for the route. */
  builtIn: TaskViewDefinition
  /** Optional Team default definition. */
  teamDefault?: TaskViewDefinition
  /** Optional current-viewer default definition. */
  personalDefault?: TaskViewDefinition
  /** Optional explicitly selected saved-view definition. */
  selectedView?: TaskViewDefinition
  /** Optional temporary URL patch layered over the winning base definition. */
  urlOverride?: TaskViewUrlOverride
}

/** Result of resolving defaults, explicit selection, and a temporary URL override. */
export type ResolvedTaskViewDefinition = {
  /** Fully detached effective definition. */
  definition: TaskViewDefinition
  /** Complete definition that won before a URL override was applied. */
  baseSource: Exclude<TaskViewDefinitionSource, 'url-override'>
  /** Highest-precedence source contributing to the effective definition. */
  source: TaskViewDefinitionSource
  /** Sources that materially contributed to the result, in application order. */
  appliedSources: readonly TaskViewDefinitionSource[]
}

/** Permission and capability boundary used to sanitize a task view definition. */
export type TaskViewSanitizeOptions = {
  /** Whether the current viewer may read the candidate view. */
  canRead: boolean
  /** Surface required by the route consuming the candidate. */
  expectedSurface: TaskViewSurface
  /** Scope required by the route consuming the candidate. */
  expectedScope: TaskViewScope
  /** Layout modes implemented by the consuming surface. */
  layoutModes: readonly TaskViewLayoutMode[]
  /** Canonical layout field references available for grouping and sorting. */
  fields: readonly string[]
  /** Field references available as visible columns. */
  columns: readonly string[]
  /** Team-qualified workflow statuses visible to the current viewer. */
  workflowStatuses: readonly TaskViewWorkflowStatusFilter[]
  /** Legacy unqualified workflow status identifiers visible to the current viewer. */
  legacyStatusIds?: readonly string[]
  /** Columns that must remain after migration. */
  requiredColumns?: readonly string[]
  /** Whether warnings may expose removed identifiers to the current viewer. */
  canExposeUnknownReferenceIds?: boolean
  /** Safe definition used for whole-view and section-level fallbacks. */
  fallback: TaskViewDefinition
}

/** Result of sanitizing a task view definition against current capabilities. */
export type SanitizedTaskViewDefinition = {
  /** Permission-safe, fully materialized definition. */
  definition: TaskViewDefinition
  /** Safe migration notices describing removed or reset state. */
  warnings: readonly TaskViewMigrationWarning[]
  /** Whether the entire candidate was replaced by the fallback. */
  didFallback: boolean
}

/** Result of syntactically parsing an unknown URL override. */
export type TaskViewUrlOverrideParseResult = {
  /** Safe temporary override, omitted when no valid field remains. */
  override?: TaskViewUrlOverride
  /** Safe URL migration notices. */
  warnings: readonly TaskViewMigrationWarning[]
}

/**
 * Resolves built-in, Team, personal, explicit, and URL state in canonical precedence order.
 *
 * Complete saved definitions replace lower-precedence defaults. Only the URL state is a patch.
 *
 * @param input - Available definition candidates and temporary override.
 * @returns A detached effective definition and its contributing sources.
 */
export function resolveTaskViewDefinition(
  input: ResolveTaskViewDefinitionInput,
): ResolvedTaskViewDefinition {
  let baseSource: Exclude<TaskViewDefinitionSource, 'url-override'> = 'built-in'
  let definition = cloneTaskViewDefinition(input.builtIn)

  if (input.teamDefault) {
    baseSource = 'team-default'
    definition = cloneTaskViewDefinition(input.teamDefault)
  }
  if (input.personalDefault) {
    baseSource = 'personal-default'
    definition = cloneTaskViewDefinition(input.personalDefault)
  }
  if (input.selectedView) {
    baseSource = 'selected-view'
    definition = cloneTaskViewDefinition(input.selectedView)
  }

  if (!input.urlOverride || !hasTaskViewUrlOverride(input.urlOverride)) {
    return {
      appliedSources: [baseSource],
      baseSource,
      definition,
      source: baseSource,
    }
  }

  return {
    appliedSources: [baseSource, 'url-override'],
    baseSource,
    definition: applyTaskViewUrlOverride(definition, input.urlOverride),
    source: 'url-override',
  }
}

/**
 * Applies a contract-owned temporary URL override without mutating either input.
 *
 * @param definition - Complete lower-precedence definition.
 * @param override - Temporary filter and layout changes.
 * @returns A detached effective definition.
 */
export function applyTaskViewUrlOverride(
  definition: TaskViewDefinition,
  override: TaskViewUrlOverride,
): TaskViewDefinition {
  const layoutOverride = override.layout
  const group = layoutOverride && Object.hasOwn(layoutOverride, 'group')
    ? layoutOverride.group ?? undefined
    : definition.layout.group
  const subgroup = layoutOverride && Object.hasOwn(layoutOverride, 'subgroup')
    ? layoutOverride.subgroup ?? undefined
    : definition.layout.subgroup

  return {
    surface: definition.surface,
    scope: cloneTaskViewScope(definition.scope),
    filters: override.filters
      ? cloneTaskViewFilters(override.filters)
      : cloneTaskViewFilters(definition.filters),
    layout: {
      mode: layoutOverride?.mode ?? definition.layout.mode,
      ...(group ? { group: { ...group } } : {}),
      ...(subgroup ? { subgroup: { ...subgroup } } : {}),
      sort: cloneTaskViewSort(layoutOverride?.sort ?? definition.layout.sort),
      columns: cloneTaskViewColumns(layoutOverride?.columns ?? definition.layout.columns),
      density: layoutOverride?.density ?? definition.layout.density,
      displayOptions: {
        ...definition.layout.displayOptions,
        ...layoutOverride?.displayOptions,
      },
    },
  }
}

/**
 * Parses a JSON-derived temporary override while discarding unsafe structure.
 *
 * Capability and permission checks are applied later when the effective definition is sanitized.
 *
 * @param value - Unknown decoded JSON value.
 * @returns A safe contract override and URL warnings.
 */
export function parseTaskViewUrlOverride(value: unknown): TaskViewUrlOverrideParseResult {
  if (!isRecord(value)) {
    return {
      warnings: [createMigrationWarning(
        'invalid-url-override',
        'url-override',
        'ignored',
      )],
    }
  }

  const warnings: TaskViewMigrationWarning[] = []
  const override: TaskViewUrlOverride = {}

  if (Object.keys(value).some((key) => key !== 'filters' && key !== 'layout')) {
    warnings.push(createMigrationWarning(
      'invalid-url-override',
      'url-override',
      'ignored',
    ))
  }

  if (Object.hasOwn(value, 'filters')) {
    const filters = readTaskViewFilters(value.filters)
    if (filters) {
      override.filters = filters
    } else {
      warnings.push(createMigrationWarning(
        'invalid-url-override',
        'filter',
        'ignored',
      ))
    }
  }

  if (Object.hasOwn(value, 'layout')) {
    const layout = readTaskViewLayoutOverride(value.layout, warnings)
    if (layout && Object.keys(layout).length > 0) {
      override.layout = layout
    }
  }

  return {
    ...(hasTaskViewUrlOverride(override) ? { override } : {}),
    warnings: deduplicateTaskViewMigrationWarnings(warnings),
  }
}

/**
 * Sanitizes a candidate against route identity, permissions, and current schema references.
 *
 * @param value - Unknown task view definition decoded from storage or an API.
 * @param options - Current route and capability boundary.
 * @returns A permission-safe definition and deterministic migration notices.
 */
export function sanitizeTaskViewDefinition(
  value: unknown,
  options: TaskViewSanitizeOptions,
): SanitizedTaskViewDefinition {
  if (!options.canRead) {
    return fallbackTaskViewDefinition(options.fallback, createMigrationWarning(
      'permission-redacted',
      'scope',
      'unavailable',
    ))
  }

  if (!isRecord(value) || !isTaskViewSurface(value.surface)) {
    return fallbackTaskViewDefinition(options.fallback, createMigrationWarning(
      'inaccessible-scope',
      'scope',
      'reset-to-default',
    ))
  }

  const scope = readTaskViewScope(value.scope)
  if (
    !scope ||
    value.surface !== options.expectedSurface ||
    !taskViewScopesEqual(scope, options.expectedScope)
  ) {
    return fallbackTaskViewDefinition(options.fallback, createMigrationWarning(
      'inaccessible-scope',
      'scope',
      'reset-to-default',
    ))
  }

  const warnings: TaskViewMigrationWarning[] = []
  const filters = sanitizeTaskViewFilters(
    readTaskViewFilters(value.filters) ?? options.fallback.filters,
    options,
    warnings,
  )
  const layout = sanitizeTaskViewLayout(value.layout, options, warnings)

  return {
    definition: {
      filters,
      layout,
      scope: cloneTaskViewScope(scope),
      surface: value.surface,
    },
    didFallback: false,
    warnings: deduplicateTaskViewMigrationWarnings(warnings),
  }
}

/**
 * Tests whether a temporary override changes a filter or layout section.
 *
 * @param override - Candidate contract override.
 * @returns Whether serialization and resolution should retain the override.
 */
export function hasTaskViewUrlOverride(override: TaskViewUrlOverride): boolean {
  return override.filters !== undefined ||
    override.layout !== undefined && Object.keys(override.layout).length > 0
}

/**
 * Deduplicates migration notices while preserving first occurrence order.
 *
 * @param warnings - Candidate notices.
 * @returns Stable unique notices.
 */
export function deduplicateTaskViewMigrationWarnings(
  warnings: readonly TaskViewMigrationWarning[],
): TaskViewMigrationWarning[] {
  const seen = new Set<string>()
  return warnings.filter((warning) => {
    const key = [
      warning.code,
      warning.section,
      warning.fallback,
      warning.referenceId ?? '',
    ].join('\u0000')
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

/**
 * Produces a detached whole-view fallback.
 *
 * @param fallback - Safe route default.
 * @param warning - Reason the candidate could not be retained.
 * @returns Sanitization result using the fallback wholesale.
 */
function fallbackTaskViewDefinition(
  fallback: TaskViewDefinition,
  warning: TaskViewMigrationWarning,
): SanitizedTaskViewDefinition {
  return {
    definition: cloneTaskViewDefinition(fallback),
    didFallback: true,
    warnings: [warning],
  }
}

/**
 * Sanitizes layout mode, grouping, sorting, columns, density, and display options.
 *
 * @param value - Unknown layout value.
 * @param options - Current capability boundary.
 * @param warnings - Migration notice sink.
 * @returns Complete safe layout.
 */
function sanitizeTaskViewLayout(
  value: unknown,
  options: TaskViewSanitizeOptions,
  warnings: TaskViewMigrationWarning[],
): TaskViewLayout {
  if (!isRecord(value)) {
    warnings.push(createMigrationWarning('invalid-layout', 'layout', 'reset-to-default'))
    return cloneTaskViewLayout(options.fallback.layout)
  }

  const allowedModes = new Set(options.layoutModes)
  const mode = isEnumValue(value.mode, taskViewLayoutModes) && allowedModes.has(value.mode)
    ? value.mode
    : options.fallback.layout.mode
  if (mode !== value.mode) {
    warnings.push(createMigrationWarning(
      'invalid-layout',
      'layout',
      'reset-to-default',
      readReferenceId(value.mode, options),
    ))
  }

  const group = sanitizeTaskViewGrouping(value.group, 'group', options, warnings)
  const subgroup = sanitizeTaskViewGrouping(value.subgroup, 'subgroup', options, warnings)
  const sort = sanitizeTaskViewSort(value.sort, options, warnings)
  const columns = sanitizeTaskViewColumns(value.columns, options, warnings)
  const density = isEnumValue(value.density, taskViewDensities)
    ? value.density
    : options.fallback.layout.density
  if (density !== value.density) {
    warnings.push(createMigrationWarning('invalid-layout', 'density', 'reset-to-default'))
  }

  return {
    mode,
    ...(group ? { group } : {}),
    ...(subgroup ? { subgroup } : {}),
    sort,
    columns,
    density,
    displayOptions: sanitizeTaskViewDisplayOptions(
      value.displayOptions,
      options.fallback.layout.displayOptions,
      warnings,
    ),
  }
}

/**
 * Sanitizes an optional grouping rule.
 *
 * @param value - Unknown grouping value.
 * @param section - Primary or secondary grouping section.
 * @param options - Current field capability boundary.
 * @param warnings - Migration notice sink.
 * @returns Retained grouping or undefined.
 */
function sanitizeTaskViewGrouping(
  value: unknown,
  section: 'group' | 'subgroup',
  options: TaskViewSanitizeOptions,
  warnings: TaskViewMigrationWarning[],
): TaskViewGrouping | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (
    !isRecord(value) ||
    typeof value.field !== 'string' ||
    (value.direction !== 'asc' && value.direction !== 'desc')
  ) {
    warnings.push(createMigrationWarning('invalid-layout', section, 'removed'))
    return undefined
  }
  if (!options.fields.includes(value.field)) {
    warnings.push(createMigrationWarning(
      'deleted-custom-field',
      section,
      'removed',
      readReferenceId(value.field, options),
    ))
    return undefined
  }
  return { direction: value.direction, field: value.field }
}

/**
 * Sanitizes ordered sort rules.
 *
 * @param value - Unknown sort value.
 * @param options - Current field capability boundary.
 * @param warnings - Migration notice sink.
 * @returns Retained sort rules.
 */
function sanitizeTaskViewSort(
  value: unknown,
  options: TaskViewSanitizeOptions,
  warnings: TaskViewMigrationWarning[],
): TaskViewSort[] {
  if (!Array.isArray(value)) {
    warnings.push(createMigrationWarning('invalid-layout', 'sort', 'reset-to-default'))
    return cloneTaskViewSort(options.fallback.layout.sort)
  }

  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.field !== 'string' ||
      (candidate.direction !== 'asc' && candidate.direction !== 'desc')
    ) {
      warnings.push(createMigrationWarning('invalid-layout', 'sort', 'removed'))
      return []
    }
    if (!options.fields.includes(candidate.field)) {
      warnings.push(createMigrationWarning(
        'deleted-custom-field',
        'sort',
        'removed',
        readReferenceId(candidate.field, options),
      ))
      return []
    }
    return [{ direction: candidate.direction, field: candidate.field }]
  })
}

/**
 * Sanitizes visible columns and restores required columns.
 *
 * @param value - Unknown columns value.
 * @param options - Current column capability boundary.
 * @param warnings - Migration notice sink.
 * @returns Ordered safe columns.
 */
function sanitizeTaskViewColumns(
  value: unknown,
  options: TaskViewSanitizeOptions,
  warnings: TaskViewMigrationWarning[],
): TaskViewColumn[] {
  const allowedColumns = new Set(options.columns)
  const candidates = Array.isArray(value) ? value : options.fallback.layout.columns
  if (!Array.isArray(value)) {
    warnings.push(createMigrationWarning('invalid-layout', 'column', 'reset-to-default'))
  }

  const retained: TaskViewColumn[] = []
  for (const candidate of candidates) {
    const column = readTaskViewColumn(candidate)
    if (!column) {
      warnings.push(createMigrationWarning('invalid-layout', 'column', 'removed'))
      continue
    }
    if (!allowedColumns.has(column.field)) {
      warnings.push(createMigrationWarning(
        'deleted-custom-field',
        'column',
        'removed',
        readReferenceId(column.field, options),
      ))
      continue
    }
    if (!retained.some((existing) => existing.field === column.field)) {
      retained.push(column)
    }
  }

  const required = (options.requiredColumns ?? []).filter((field) => allowedColumns.has(field))
  for (const field of [...required].reverse()) {
    if (retained.some((column) => column.field === field)) {
      continue
    }
    const fallbackColumn = options.fallback.layout.columns.find((column) => column.field === field)
    retained.unshift(fallbackColumn ? { ...fallbackColumn } : { field })
  }
  return retained
}

/**
 * Sanitizes filters that contain field and workflow references.
 *
 * @param filters - Syntactically safe filter set.
 * @param options - Current field and status capability boundary.
 * @param warnings - Migration notice sink.
 * @returns Permission-safe filters.
 */
function sanitizeTaskViewFilters(
  filters: TaskViewFilters,
  options: TaskViewSanitizeOptions,
  warnings: TaskViewMigrationWarning[],
): TaskViewFilters {
  const allowedFields = new Set(options.fields)
  const allowedLegacyStatuses = new Set(options.legacyStatusIds ?? [])
  const allowedWorkflowStatuses = options.workflowStatuses
  const allowedWorkflowStatusKeys = new Set(
    options.workflowStatuses.map(createWorkflowStatusKey),
  )
  const next = cloneTaskViewFilters(filters)

  if (next.customFields) {
    next.customFields = next.customFields.filter((filter) => {
      if (allowedFields.has(`custom:${filter.fieldId}`)) {
        return true
      }
      warnings.push(createMigrationWarning(
        'deleted-custom-field',
        'filter',
        'removed',
        readReferenceId(filter.fieldId, options),
      ))
      return false
    })
  }
  if (next.statuses) {
    next.statuses = next.statuses.filter((statusId) => {
      if (allowedLegacyStatuses.has(statusId)) {
        return true
      }
      warnings.push(createMigrationWarning(
        'deleted-workflow-status',
        'filter',
        'removed',
        readReferenceId(statusId, options),
      ))
      return false
    })
  }
  if (next.workflowStatuses) {
    next.workflowStatuses = next.workflowStatuses.filter((status) => {
      if (isTaskViewWorkflowStatusAllowed(
        status,
        allowedWorkflowStatuses,
        allowedWorkflowStatusKeys,
      )) {
        return true
      }
      warnings.push(createMigrationWarning(
        'deleted-workflow-status',
        'filter',
        'removed',
        readReferenceId(status.statusId, options),
      ))
      return false
    })
  }
  return next
}

/**
 * Reads a complete filter object from unknown JSON.
 *
 * @param value - Unknown filter value.
 * @returns Safe recognized filters, or undefined for a non-object value.
 */
function readTaskViewFilters(value: unknown): TaskViewFilters | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  if (Object.keys(value).some((key) => !taskViewFilterIds.includes(key))) {
    return undefined
  }

  const filters: TaskViewFilters = {}
  if (Object.hasOwn(value, 'keyword')) {
    if (typeof value.keyword !== 'string') return undefined
    filters.keyword = value.keyword
  }
  if (Object.hasOwn(value, 'entityTypes')) {
    const entityTypes = readEnumArray(value.entityTypes, searchEntityTypes)
    if (!entityTypes) return undefined
    filters.entityTypes = entityTypes
  }
  if (
    !copyStringArray(value, 'assigneeUserIds', filters) ||
    !copyStringArray(value, 'creatorUserIds', filters) ||
    !copyStringArray(value, 'statuses', filters) ||
    !copyStringArray(value, 'relationIds', filters) ||
    !copyStringArray(value, 'projectIds', filters) ||
    !copyStringArray(value, 'teamIds', filters)
  ) return undefined

  if (Object.hasOwn(value, 'customFields')) {
    const customFields = readSearchCustomFieldFilters(value.customFields)
    if (!customFields) return undefined
    filters.customFields = customFields
  }
  if (Object.hasOwn(value, 'date')) {
    const date = readWorkspaceSearchDateFilter(value.date)
    if (!date) return undefined
    filters.date = date
  }
  if (Object.hasOwn(value, 'workflowStatuses')) {
    const workflowStatuses = readWorkflowStatusFilters(value.workflowStatuses)
    if (!workflowStatuses) return undefined
    filters.workflowStatuses = workflowStatuses
  }
  if (Object.hasOwn(value, 'workflowCategories')) {
    const categories = readEnumArray(value.workflowCategories, workflowStatusCategories)
    if (!categories) return undefined
    filters.workflowCategories = categories
  }
  if (Object.hasOwn(value, 'priorities')) {
    const priorities = readEnumArray(value.priorities, workItemPriorities)
    if (!priorities) return undefined
    filters.priorities = priorities
  }
  if (Object.hasOwn(value, 'dueDatePreset')) {
    if (!isEnumValue(value.dueDatePreset, taskViewDueDatePresets)) return undefined
    filters.dueDatePreset = value.dueDatePreset
  }
  if (Object.hasOwn(value, 'includeArchived')) {
    if (typeof value.includeArchived !== 'boolean') return undefined
    filters.includeArchived = value.includeArchived
  }
  return filters
}

/**
 * Reads a partial layout from URL JSON.
 *
 * @param value - Unknown layout override.
 * @param warnings - URL migration notice sink.
 * @returns Safe recognized layout fields.
 */
function readTaskViewLayoutOverride(
  value: unknown,
  warnings: TaskViewMigrationWarning[],
): TaskViewUrlOverride['layout'] | undefined {
  if (!isRecord(value)) {
    warnings.push(createMigrationWarning(
      'invalid-url-override',
      'url-override',
      'ignored',
    ))
    return undefined
  }

  if (Object.keys(value).some((key) => !taskViewLayoutOverrideIds.includes(key))) {
    warnings.push(createMigrationWarning(
      'invalid-url-override',
      'url-override',
      'ignored',
    ))
  }

  const layout: NonNullable<TaskViewUrlOverride['layout']> = {}
  if (Object.hasOwn(value, 'mode')) {
    if (isEnumValue(value.mode, taskViewLayoutModes)) layout.mode = value.mode
    else warnings.push(createMigrationWarning('invalid-url-override', 'url-override', 'ignored'))
  }
  readGroupingOverride(value, 'group', layout, warnings)
  readGroupingOverride(value, 'subgroup', layout, warnings)
  if (Object.hasOwn(value, 'sort')) {
    const sort = readTaskViewSort(value.sort)
    if (sort) layout.sort = sort
    else warnings.push(createMigrationWarning('invalid-url-override', 'url-override', 'ignored'))
  }
  if (Object.hasOwn(value, 'columns')) {
    const columns = readTaskViewColumns(value.columns)
    if (columns) layout.columns = columns
    else warnings.push(createMigrationWarning('invalid-url-override', 'url-override', 'ignored'))
  }
  if (Object.hasOwn(value, 'density')) {
    if (isEnumValue(value.density, taskViewDensities)) layout.density = value.density
    else warnings.push(createMigrationWarning('invalid-url-override', 'url-override', 'ignored'))
  }
  if (Object.hasOwn(value, 'displayOptions')) {
    const displayOptions = readTaskViewDisplayOptions(value.displayOptions)
    if (displayOptions) layout.displayOptions = displayOptions
    else warnings.push(createMigrationWarning('invalid-url-override', 'url-override', 'ignored'))
  }
  return layout
}

/**
 * Reads an optional grouping property into a URL layout override.
 *
 * @param source - Unknown layout object.
 * @param key - Group or subgroup property.
 * @param target - Parsed layout override.
 * @param warnings - URL migration notice sink.
 * @returns Whether an absent or valid property was accepted.
 */
function readGroupingOverride(
  source: Record<string, unknown>,
  key: 'group' | 'subgroup',
  target: NonNullable<TaskViewUrlOverride['layout']>,
  warnings: TaskViewMigrationWarning[],
): void {
  if (!Object.hasOwn(source, key)) return
  if (source[key] === null) {
    target[key] = null
    return
  }
  const grouping = readTaskViewGrouping(source[key])
  if (grouping) target[key] = grouping
  else warnings.push(createMigrationWarning('invalid-url-override', 'url-override', 'ignored'))
}

/**
 * Reads a grouping rule.
 *
 * @param value - Unknown grouping value.
 * @returns Safe grouping rule or undefined.
 */
function readTaskViewGrouping(value: unknown): TaskViewGrouping | undefined {
  if (
    !isRecord(value) ||
    typeof value.field !== 'string' ||
    (value.direction !== 'asc' && value.direction !== 'desc')
  ) return undefined
  return { direction: value.direction, field: value.field }
}

/**
 * Reads ordered sort rules.
 *
 * @param value - Unknown sort value.
 * @returns Safe sort rules or undefined.
 */
function readTaskViewSort(value: unknown): TaskViewSort[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: TaskViewSort[] = []
  for (const candidate of value) {
    const rule = readTaskViewGrouping(candidate)
    if (!rule) return undefined
    result.push(rule)
  }
  return result
}

/**
 * Reads ordered visible columns.
 *
 * @param value - Unknown columns value.
 * @returns Safe columns or undefined.
 */
function readTaskViewColumns(value: unknown): TaskViewColumn[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: TaskViewColumn[] = []
  for (const candidate of value) {
    const column = readTaskViewColumn(candidate)
    if (!column) return undefined
    result.push(column)
  }
  return result
}

/**
 * Reads one visible column.
 *
 * @param value - Unknown column value.
 * @returns Safe column or undefined.
 */
function readTaskViewColumn(value: unknown): TaskViewColumn | undefined {
  if (!isRecord(value) || typeof value.field !== 'string' || !value.field.trim()) {
    return undefined
  }
  if (value.width !== undefined && (
    typeof value.width !== 'number' ||
    !Number.isFinite(value.width) ||
    value.width < 40 ||
    value.width > 2_000
  )) return undefined
  if (value.pin !== undefined && value.pin !== 'start' && value.pin !== 'end') {
    return undefined
  }
  return {
    field: value.field.trim(),
    ...(typeof value.width === 'number' ? { width: value.width } : {}),
    ...(value.pin === 'start' || value.pin === 'end' ? { pin: value.pin } : {}),
  }
}

/**
 * Reads recognized boolean display options.
 *
 * @param value - Unknown display-options value.
 * @returns Safe options or undefined for a non-object value.
 */
function readTaskViewDisplayOptions(value: unknown): TaskViewDisplayOptions | undefined {
  if (!isRecord(value)) return undefined
  const options: TaskViewDisplayOptions = {}
  for (const key of taskViewDisplayOptionIds) {
    if (typeof value[key] === 'boolean') options[key] = value[key]
  }
  return options
}

/**
 * Sanitizes recognized display options and reports unknown keys.
 *
 * @param value - Unknown display-options value.
 * @param fallback - Safe default options.
 * @param warnings - Migration notice sink.
 * @returns Safe display options.
 */
function sanitizeTaskViewDisplayOptions(
  value: unknown,
  fallback: TaskViewDisplayOptions,
  warnings: TaskViewMigrationWarning[],
): TaskViewDisplayOptions {
  if (!isRecord(value)) {
    warnings.push(createMigrationWarning('invalid-layout', 'display-option', 'reset-to-default'))
    return { ...fallback }
  }
  const options = readTaskViewDisplayOptions(value) ?? {}
  for (const key of Object.keys(value).sort()) {
    if (!taskViewDisplayOptionIds.some((optionId) => optionId === key)) {
      warnings.push(createMigrationWarning('invalid-layout', 'display-option', 'ignored'))
    }
  }
  return options
}

/**
 * Reads search custom-field filters.
 *
 * @param value - Unknown custom filter array.
 * @returns Safe filters or undefined for an absent or invalid container.
 */
function readSearchCustomFieldFilters(value: unknown): SearchCustomFieldFilter[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const result: SearchCustomFieldFilter[] = []
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.fieldId !== 'string' ||
      !isEnumValue(candidate.operator, searchCustomFieldOperators)
    ) return undefined
    const filter: SearchCustomFieldFilter = {
      fieldId: candidate.fieldId,
      operator: candidate.operator,
    }
    if (Object.hasOwn(candidate, 'value')) {
      const filterValue = readSearchCustomFieldValue(candidate.value)
      if (!filterValue.valid) return undefined
      filter.value = filterValue.value
    }
    result.push(filter)
  }
  return result
}

/** Result of reading one JSON-safe custom field value. */
type SearchCustomFieldValueResult =
  | {
      /** Whether the value is valid. */
      valid: true
      /** Parsed comparison value. */
      value: string | number | boolean | string[] | null
    }
  | {
      /** Whether the value is valid. */
      valid: false
    }

/**
 * Reads one JSON-safe custom field value.
 *
 * @param value - Unknown comparison value.
 * @returns Discriminated parse result.
 */
function readSearchCustomFieldValue(value: unknown): SearchCustomFieldValueResult {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number' && Number.isFinite(value)
  ) return { valid: true, value }
  const values = readStringArray(value)
  return values ? { valid: true, value: values } : { valid: false }
}

/**
 * Reads one optional Workspace Search date filter.
 *
 * @param value - Unknown date filter.
 * @returns Safe date filter or undefined.
 */
function readWorkspaceSearchDateFilter(value: unknown): WorkspaceSearchDateFilter | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    value.field !== 'createdAt' && value.field !== 'updatedAt' && value.field !== 'dueDate' ||
    value.from !== undefined && typeof value.from !== 'string' ||
    value.to !== undefined && typeof value.to !== 'string'
  ) return undefined
  return {
    field: value.field,
    ...(typeof value.from === 'string' ? { from: value.from } : {}),
    ...(typeof value.to === 'string' ? { to: value.to } : {}),
  }
}

/**
 * Reads Team-qualified workflow status filters.
 *
 * @param value - Unknown status filter array.
 * @returns Safe status filters or undefined.
 */
function readWorkflowStatusFilters(value: unknown): TaskViewWorkflowStatusFilter[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const result: TaskViewWorkflowStatusFilter[] = []
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.teamId !== 'string' ||
      typeof candidate.statusId !== 'string' ||
      candidate.workItemTypeId !== undefined &&
        typeof candidate.workItemTypeId !== 'string'
    ) return undefined
    result.push({
      statusId: candidate.statusId,
      teamId: candidate.teamId,
      ...(typeof candidate.workItemTypeId === 'string'
        ? { workItemTypeId: candidate.workItemTypeId }
        : {}),
    })
  }
  return result
}

/**
 * Copies a valid string-array property between filter records.
 *
 * @param source - Unknown source object.
 * @param key - Shared string-array property.
 * @param target - Parsed filter target.
 * @returns Nothing.
 */
function copyStringArray(
  source: Record<string, unknown>,
  key:
    | 'assigneeUserIds'
    | 'creatorUserIds'
    | 'statuses'
    | 'relationIds'
    | 'projectIds'
    | 'teamIds',
  target: TaskViewFilters,
): boolean {
  if (!Object.hasOwn(source, key)) return true
  const values = readStringArray(source[key])
  if (!values) return false
  target[key] = values
  return true
}

/**
 * Reads a string array without assertions.
 *
 * @param value - Unknown array value.
 * @returns Detached strings or undefined.
 */
function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') return undefined
    result.push(candidate)
  }
  return result
}

/**
 * Reads an array of string-enum values.
 *
 * @param value - Unknown array value.
 * @param allowed - Supported enum members.
 * @returns Detached values or undefined.
 */
function readEnumArray<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): Value[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: Value[] = []
  for (const candidate of value) {
    if (!isEnumValue(candidate, allowed)) return undefined
    result.push(candidate)
  }
  return result
}

/**
 * Reads one contract task-view scope.
 *
 * @param value - Unknown scope value.
 * @returns Safe scope or undefined.
 */
function readTaskViewScope(value: unknown): TaskViewScope | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined
  if (value.kind === 'workspace' || value.kind === 'viewer') return { kind: value.kind }
  if (value.kind === 'team' && typeof value.teamId === 'string') {
    return { kind: 'team', teamId: value.teamId }
  }
  if (value.kind === 'project' && typeof value.projectId === 'string') {
    return {
      kind: 'project',
      projectId: value.projectId,
      ...(typeof value.teamId === 'string' ? { teamId: value.teamId } : {}),
    }
  }
  return undefined
}

/**
 * Compares route scopes without depending on object property order.
 *
 * @param left - First scope.
 * @param right - Second scope.
 * @returns Whether both scopes address the same permission boundary.
 */
function taskViewScopesEqual(left: TaskViewScope, right: TaskViewScope): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'workspace' || left.kind === 'viewer') return true
  if (left.kind === 'team') return right.kind === 'team' && left.teamId === right.teamId
  return right.kind === 'project' &&
    left.projectId === right.projectId &&
    left.teamId === right.teamId
}

/**
 * Clones a complete definition.
 *
 * @param definition - Definition to detach.
 * @returns Detached definition.
 */
function cloneTaskViewDefinition(definition: TaskViewDefinition): TaskViewDefinition {
  return {
    filters: cloneTaskViewFilters(definition.filters),
    layout: cloneTaskViewLayout(definition.layout),
    scope: cloneTaskViewScope(definition.scope),
    surface: definition.surface,
  }
}

/**
 * Clones a complete task-view layout.
 *
 * @param layout - Layout to detach.
 * @returns Detached layout.
 */
function cloneTaskViewLayout(layout: TaskViewLayout): TaskViewLayout {
  return {
    mode: layout.mode,
    ...(layout.group ? { group: { ...layout.group } } : {}),
    ...(layout.subgroup ? { subgroup: { ...layout.subgroup } } : {}),
    sort: cloneTaskViewSort(layout.sort),
    columns: cloneTaskViewColumns(layout.columns),
    density: layout.density,
    displayOptions: { ...layout.displayOptions },
  }
}

/**
 * Clones filters and nested reference arrays.
 *
 * @param filters - Filters to detach.
 * @returns Detached filters.
 */
function cloneTaskViewFilters(filters: TaskViewFilters): TaskViewFilters {
  return {
    ...filters,
    ...(filters.entityTypes ? { entityTypes: [...filters.entityTypes] } : {}),
    ...(filters.assigneeUserIds ? { assigneeUserIds: [...filters.assigneeUserIds] } : {}),
    ...(filters.creatorUserIds ? { creatorUserIds: [...filters.creatorUserIds] } : {}),
    ...(filters.statuses ? { statuses: [...filters.statuses] } : {}),
    ...(filters.customFields ? {
      customFields: filters.customFields.map((filter) => ({
        ...filter,
        ...(Array.isArray(filter.value) ? { value: [...filter.value] } : {}),
      })),
    } : {}),
    ...(filters.relationIds ? { relationIds: [...filters.relationIds] } : {}),
    ...(filters.date ? { date: { ...filters.date } } : {}),
    ...(filters.projectIds ? { projectIds: [...filters.projectIds] } : {}),
    ...(filters.teamIds ? { teamIds: [...filters.teamIds] } : {}),
    ...(filters.workflowStatuses ? {
      workflowStatuses: filters.workflowStatuses.map((status) => ({ ...status })),
    } : {}),
    ...(filters.workflowCategories ? {
      workflowCategories: [...filters.workflowCategories],
    } : {}),
    ...(filters.priorities ? { priorities: [...filters.priorities] } : {}),
  }
}

/**
 * Clones sort rules.
 *
 * @param sort - Rules to detach.
 * @returns Detached rules.
 */
function cloneTaskViewSort(sort: readonly TaskViewSort[]): TaskViewSort[] {
  return sort.map((rule) => ({ ...rule }))
}

/**
 * Clones visible columns.
 *
 * @param columns - Columns to detach.
 * @returns Detached columns.
 */
function cloneTaskViewColumns(columns: readonly TaskViewColumn[]): TaskViewColumn[] {
  return columns.map((column) => ({ ...column }))
}

/**
 * Clones a contract task-view scope.
 *
 * @param scope - Scope to detach.
 * @returns Detached scope.
 */
function cloneTaskViewScope(scope: TaskViewScope): TaskViewScope {
  if (scope.kind === 'project') {
    return {
      kind: 'project',
      projectId: scope.projectId,
      ...(scope.teamId !== undefined ? { teamId: scope.teamId } : {}),
    }
  }
  if (scope.kind === 'team') return { kind: 'team', teamId: scope.teamId }
  return { kind: scope.kind }
}

/**
 * Creates a stable Team-qualified workflow status key.
 *
 * @param status - Status reference.
 * @returns Collision-safe lookup key.
 */
function createWorkflowStatusKey(status: TaskViewWorkflowStatusFilter): string {
  return [
    status.teamId,
    status.workItemTypeId ?? '',
    status.statusId,
  ].join('\u0000')
}

/**
 * Tests a workflow status filter against the current status capabilities.
 *
 * @param status - Persisted status filter to validate.
 * @param allowedStatuses - Current type-qualified and legacy status capabilities.
 * @param allowedStatusKeys - Exact lookup keys for type-qualified status capabilities.
 * @returns Whether the filter is still available.
 */
function isTaskViewWorkflowStatusAllowed(
  status: TaskViewWorkflowStatusFilter,
  allowedStatuses: readonly TaskViewWorkflowStatusFilter[],
  allowedStatusKeys: ReadonlySet<string>,
): boolean {
  if (status.workItemTypeId !== undefined) {
    return allowedStatusKeys.has(createWorkflowStatusKey(status))
  }
  return allowedStatuses.some((candidate) =>
    candidate.teamId === status.teamId && candidate.statusId === status.statusId
  )
}

/**
 * Creates one contract migration warning.
 *
 * @param code - Stable migration reason.
 * @param section - Affected definition section.
 * @param fallback - Applied safe fallback.
 * @param referenceId - Optional viewer-safe identifier.
 * @returns Migration warning.
 */
function createMigrationWarning(
  code: TaskViewMigrationWarningCode,
  section: TaskViewMigrationSection,
  fallback: TaskViewMigrationFallback,
  referenceId?: string,
): TaskViewMigrationWarning {
  return {
    code,
    section,
    fallback,
    ...(referenceId ? { referenceId } : {}),
  }
}

/**
 * Returns a rejected identifier only when policy permits exposing it.
 *
 * @param value - Unknown candidate reference.
 * @param options - Sanitization policy.
 * @returns Viewer-safe reference or undefined.
 */
function readReferenceId(
  value: unknown,
  options: TaskViewSanitizeOptions,
): string | undefined {
  return options.canExposeUnknownReferenceIds && typeof value === 'string'
    ? value
    : undefined
}

/**
 * Tests membership in a string enum without an assertion.
 *
 * @param value - Unknown candidate.
 * @param allowed - Supported values.
 * @returns Whether the candidate is a supported enum value.
 */
function isEnumValue<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): value is Value {
  return typeof value === 'string' && allowed.some((candidate) => candidate === value)
}

/**
 * Tests whether an unknown value is a contract task-view surface.
 *
 * @param value - Unknown candidate.
 * @returns Whether the candidate is a supported surface.
 */
function isTaskViewSurface(value: unknown): value is TaskViewSurface {
  return isEnumValue(value, TASK_VIEW_SURFACES)
}

/**
 * Narrows an unknown object to a string-keyed record.
 *
 * @param value - Unknown candidate.
 * @returns Whether the candidate is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
