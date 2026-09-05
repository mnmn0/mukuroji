import {
  TASK_VIEW_URL_STATE_SCHEMA_VERSION,
  type TaskViewMigrationWarning,
  type TaskViewScope,
  type TaskViewSurface,
  type TaskViewUrlOverride,
  type TaskViewUrlState,
} from '@mukuroji/contracts'
import {
  deduplicateTaskViewMigrationWarnings,
  hasTaskViewUrlOverride,
  parseTaskViewUrlOverride,
} from './taskViewDefinition'

/** Query parameter containing a selected saved-view identifier. */
export const TASK_VIEW_ID_PARAMETER = 'view'

/** Query parameter containing the task-view URL schema version. */
export const TASK_VIEW_URL_VERSION_PARAMETER = 'view.v'

/** Query parameter containing a temporary task-view override. */
export const TASK_VIEW_OVERRIDE_PARAMETER = 'view.override'

/** One unrelated query entry retained through a task-view update. */
export type TaskViewUrlEntry = {
  /** Query parameter name. */
  key: string
  /** Query parameter value. */
  value: string
}

/** Route-owned identity required to construct canonical contract URL state. */
export type TaskViewUrlContext = {
  /** Product surface consuming the URL state. */
  surface: TaskViewSurface
  /** Route and authorization scope bound to the URL state. */
  scope: TaskViewScope
}

/** Parsed contract URL state plus query preservation and migration metadata. */
export type ParsedTaskViewUrlState = {
  /** Canonical contract state reconstructed from the route and owned parameters. */
  state: TaskViewUrlState
  /** Query entries outside the task-view namespace. */
  unrelatedParams: readonly TaskViewUrlEntry[]
  /** Invalid or unsupported URL values. */
  warnings: readonly TaskViewMigrationWarning[]
}

/** Task-view-owned values accepted when updating current route parameters. */
export type UpdateTaskViewUrlStateInput = {
  /** Explicitly selected saved-view identifier, or undefined to clear it. */
  viewId?: string
  /** Temporary contract override, or undefined to clear it. */
  override?: TaskViewUrlOverride
}

/**
 * Parses versioned task-view state without consuming route identity or deep-link parameters.
 *
 * @param searchParams - Current route search parameters.
 * @param context - Surface and permission scope derived from the route.
 * @returns Canonical contract state, preserved query entries, and safe warnings.
 */
export function parseTaskViewUrlState(
  searchParams: URLSearchParams,
  context: TaskViewUrlContext,
): ParsedTaskViewUrlState {
  const warnings: TaskViewMigrationWarning[] = []
  const viewId = normalizeOptionalText(searchParams.get(TASK_VIEW_ID_PARAMETER))
  const encodedOverride = searchParams.get(TASK_VIEW_OVERRIDE_PARAMETER)
  const rawVersion = searchParams.get(TASK_VIEW_URL_VERSION_PARAMETER)
  let override: TaskViewUrlOverride | undefined

  if (rawVersion && rawVersion !== String(TASK_VIEW_URL_STATE_SCHEMA_VERSION)) {
    warnings.push(createInvalidUrlWarning())
  } else if (encodedOverride) {
    try {
      const decoded: unknown = JSON.parse(encodedOverride)
      const parsed = parseTaskViewUrlOverride(decoded)
      override = parsed.override
      warnings.push(...parsed.warnings)
    } catch {
      warnings.push(createInvalidUrlWarning())
    }
  }

  return {
    state: {
      schemaVersion: TASK_VIEW_URL_STATE_SCHEMA_VERSION,
      surface: context.surface,
      scope: cloneTaskViewScope(context.scope),
      ...(viewId ? { viewId } : {}),
      ...(override ? { override } : {}),
    },
    unrelatedParams: readUnrelatedParams(searchParams),
    warnings: deduplicateTaskViewMigrationWarnings(warnings),
  }
}

/**
 * Serializes contract URL state in deterministic query-key order.
 *
 * Repeated unrelated parameters retain their value order.
 *
 * @param state - Canonical contract URL state.
 * @param unrelatedParams - Route query entries not owned by the task-view model.
 * @returns Canonical search parameters.
 */
export function serializeTaskViewUrlState(
  state: TaskViewUrlState,
  unrelatedParams: readonly TaskViewUrlEntry[] = [],
): URLSearchParams {
  const searchParams = new URLSearchParams()

  for (const entry of unrelatedParams) {
    if (!isTaskViewOwnedParameter(entry.key)) {
      searchParams.append(entry.key, entry.value)
    }
  }

  const viewId = normalizeOptionalText(state.viewId)
  if (viewId) searchParams.set(TASK_VIEW_ID_PARAMETER, viewId)
  if (state.override && hasTaskViewUrlOverride(state.override)) {
    searchParams.set(
      TASK_VIEW_OVERRIDE_PARAMETER,
      serializeTaskViewUrlOverride(state.override),
    )
  }
  if (viewId || state.override && hasTaskViewUrlOverride(state.override)) {
    searchParams.set(
      TASK_VIEW_URL_VERSION_PARAMETER,
      String(TASK_VIEW_URL_STATE_SCHEMA_VERSION),
    )
  }

  searchParams.sort()
  return searchParams
}

/**
 * Replaces task-view-owned parameters while preserving every unrelated current entry.
 *
 * @param current - Current route search parameters.
 * @param context - Surface and permission scope derived from the route.
 * @param next - New saved-view selection and temporary override.
 * @returns Deterministically ordered search parameters.
 */
export function updateTaskViewUrlState(
  current: URLSearchParams,
  context: TaskViewUrlContext,
  next: UpdateTaskViewUrlStateInput,
): URLSearchParams {
  const viewId = normalizeOptionalText(next.viewId)
  return serializeTaskViewUrlState({
    schemaVersion: TASK_VIEW_URL_STATE_SCHEMA_VERSION,
    surface: context.surface,
    scope: cloneTaskViewScope(context.scope),
    ...(viewId ? { viewId } : {}),
    ...(next.override && hasTaskViewUrlOverride(next.override)
      ? { override: next.override }
      : {}),
  }, readUnrelatedParams(current))
}

/**
 * Carries task-view-owned query state into another route on the same product surface.
 *
 * Destination-owned parameters such as a selected Work Item remain intact, while any
 * stale task-view parameters already present in the destination are replaced.
 *
 * @param destinationPath - Same-origin application path produced by a route helper.
 * @param currentSearchParams - Current route parameters containing task-view state.
 * @returns Destination path with the current task-view parameters preserved.
 */
export function preserveTaskViewUrlState(
  destinationPath: string,
  currentSearchParams: URLSearchParams,
): string {
  const destination = new URL(destinationPath, 'https://mukuroji.invalid')

  for (const parameter of [
    TASK_VIEW_ID_PARAMETER,
    TASK_VIEW_URL_VERSION_PARAMETER,
    TASK_VIEW_OVERRIDE_PARAMETER,
  ]) {
    destination.searchParams.delete(parameter)
    for (const value of currentSearchParams.getAll(parameter)) {
      destination.searchParams.append(parameter, value)
    }
  }

  destination.searchParams.sort()
  return `${destination.pathname}${destination.search}${destination.hash}`
}

/**
 * Creates a stable fingerprint of only the query parameters owned by task views.
 *
 * Unrelated detail, panel, and pagination parameters intentionally do not affect the
 * fingerprint so an asynchronous lifecycle mutation can preserve their latest values.
 *
 * @param searchParams - Route parameters observed at one point in time.
 * @returns Deterministic task-view query state suitable for stale-result guards.
 */
export function createTaskViewUrlStateFingerprint(
  searchParams: URLSearchParams,
): string {
  const ownedSearchParams = new URLSearchParams()
  for (const [key, value] of searchParams) {
    if (isTaskViewOwnedParameter(key)) ownedSearchParams.append(key, value)
  }
  ownedSearchParams.sort()
  return ownedSearchParams.toString()
}

/**
 * Serializes a contract temporary override with fixed object-key ordering.
 *
 * @param override - Temporary filter and layout state.
 * @returns Deterministic JSON suitable for URLSearchParams encoding.
 */
export function serializeTaskViewUrlOverride(override: TaskViewUrlOverride): string {
  return JSON.stringify({
    ...(override.filters ? { filters: normalizeTaskViewFilters(override.filters) } : {}),
    ...(override.layout ? { layout: normalizeTaskViewLayoutOverride(override.layout) } : {}),
  })
}

/**
 * Reads query entries outside the task-view namespace.
 *
 * @param searchParams - Current route search parameters.
 * @returns Preserved entries in their current order.
 */
function readUnrelatedParams(searchParams: URLSearchParams): TaskViewUrlEntry[] {
  return Array.from(searchParams.entries()).flatMap(([key, value]) =>
    isTaskViewOwnedParameter(key) ? [] : [{ key, value }]
  )
}

/**
 * Tests whether a query parameter is owned by task-view state.
 *
 * @param key - Query parameter name.
 * @returns Whether serialization may replace the parameter.
 */
function isTaskViewOwnedParameter(key: string): boolean {
  return key === TASK_VIEW_ID_PARAMETER ||
    key === TASK_VIEW_URL_VERSION_PARAMETER ||
    key === TASK_VIEW_OVERRIDE_PARAMETER
}

/**
 * Normalizes optional identifiers.
 *
 * @param value - Nullable text.
 * @returns Trimmed non-empty text.
 */
function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

/**
 * Creates the contract warning used for malformed or unsupported URL state.
 *
 * @returns Safe invalid-override warning.
 */
function createInvalidUrlWarning(): TaskViewMigrationWarning {
  return {
    code: 'invalid-url-override',
    section: 'url-override',
    fallback: 'ignored',
  }
}

/**
 * Normalizes filters into contract property order.
 *
 * @param filters - Filters to serialize.
 * @returns Detached filters with deterministic nested ordering.
 */
function normalizeTaskViewFilters(
  filters: NonNullable<TaskViewUrlOverride['filters']>,
): NonNullable<TaskViewUrlOverride['filters']> {
  return {
    ...(filters.keyword !== undefined ? { keyword: filters.keyword } : {}),
    ...(filters.entityTypes ? { entityTypes: [...filters.entityTypes] } : {}),
    ...(filters.assigneeUserIds
      ? { assigneeUserIds: [...filters.assigneeUserIds] }
      : {}),
    ...(filters.creatorUserIds ? { creatorUserIds: [...filters.creatorUserIds] } : {}),
    ...(filters.statuses ? { statuses: [...filters.statuses] } : {}),
    ...(filters.customFields ? {
      customFields: filters.customFields.map((filter) => ({
        fieldId: filter.fieldId,
        operator: filter.operator,
        ...(Object.hasOwn(filter, 'value')
          ? { value: Array.isArray(filter.value) ? [...filter.value] : filter.value }
          : {}),
      })),
    } : {}),
    ...(filters.relationIds ? { relationIds: [...filters.relationIds] } : {}),
    ...(filters.date ? {
      date: {
        field: filters.date.field,
        ...(filters.date.from !== undefined ? { from: filters.date.from } : {}),
        ...(filters.date.to !== undefined ? { to: filters.date.to } : {}),
      },
    } : {}),
    ...(filters.projectIds ? { projectIds: [...filters.projectIds] } : {}),
    ...(filters.teamIds ? { teamIds: [...filters.teamIds] } : {}),
    ...(filters.workItemTypeIds
      ? { workItemTypeIds: [...filters.workItemTypeIds] }
      : {}),
    ...(filters.workflowStatuses ? {
      workflowStatuses: filters.workflowStatuses.map((status) => ({
        teamId: status.teamId,
        ...(status.workItemTypeId !== undefined
          ? { workItemTypeId: status.workItemTypeId }
          : {}),
        statusId: status.statusId,
      })),
    } : {}),
    ...(filters.workflowCategories
      ? { workflowCategories: [...filters.workflowCategories] }
      : {}),
    ...(filters.priorities ? { priorities: [...filters.priorities] } : {}),
    ...(filters.dueDatePreset !== undefined
      ? { dueDatePreset: filters.dueDatePreset }
      : {}),
    ...(filters.includeArchived !== undefined
      ? { includeArchived: filters.includeArchived }
      : {}),
  }
}

/**
 * Normalizes a partial layout into contract property order.
 *
 * @param layout - Layout override to serialize.
 * @returns Detached deterministic layout override.
 */
function normalizeTaskViewLayoutOverride(
  layout: NonNullable<TaskViewUrlOverride['layout']>,
): NonNullable<TaskViewUrlOverride['layout']> {
  return {
    ...(layout.mode !== undefined ? { mode: layout.mode } : {}),
    ...(Object.hasOwn(layout, 'group')
      ? { group: layout.group ? normalizeGrouping(layout.group) : null }
      : {}),
    ...(Object.hasOwn(layout, 'subgroup')
      ? { subgroup: layout.subgroup ? normalizeGrouping(layout.subgroup) : null }
      : {}),
    ...(layout.sort ? { sort: layout.sort.map(normalizeGrouping) } : {}),
    ...(layout.columns ? {
      columns: layout.columns.map((column) => ({
        field: column.field,
        ...(column.width !== undefined ? { width: column.width } : {}),
        ...(column.pin !== undefined ? { pin: column.pin } : {}),
      })),
    } : {}),
    ...(layout.density !== undefined ? { density: layout.density } : {}),
    ...(layout.displayOptions ? {
      displayOptions: Object.fromEntries(
        Object.entries(layout.displayOptions).sort(
          ([first], [second]) => first.localeCompare(second),
        ),
      ),
    } : {}),
  }
}

/**
 * Normalizes one grouping or sort rule.
 *
 * @param grouping - Contract grouping rule.
 * @returns Stable property order.
 */
function normalizeGrouping(grouping: { field: string; direction: 'asc' | 'desc' }) {
  return { field: grouping.field, direction: grouping.direction }
}

/**
 * Clones a contract route scope.
 *
 * @param scope - Route scope to detach.
 * @returns Detached scope.
 */
function cloneTaskViewScope(scope: TaskViewScope): TaskViewScope {
  if (scope.kind === 'project') {
    return {
      kind: 'project',
      projectId: scope.projectId,
      ...(scope.teamId ? { teamId: scope.teamId } : {}),
    }
  }
  if (scope.kind === 'team') return { kind: 'team', teamId: scope.teamId }
  return { kind: scope.kind }
}
