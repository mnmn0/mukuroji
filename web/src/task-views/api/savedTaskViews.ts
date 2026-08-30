import {
  TASK_VIEW_SCHEMA_VERSION,
  TASK_VIEW_SURFACES,
  type CreateSavedTaskViewInput,
  type DuplicateSavedTaskViewInput,
  type SearchCustomFieldFilter,
  type SearchCustomFieldValue,
  type SavedTaskView,
  type SavedTaskViewCapabilities,
  type SavedTaskViewListQuery,
  type SavedTaskViewPreference,
  type SavedTaskViewsResponse,
  type TaskViewDefinition,
  type TaskViewDisplayOptions,
  type TaskViewFilters,
  type TaskViewGrouping,
  type TaskViewLayout,
  type TaskViewMigrationWarning,
  type TaskViewScope,
  type TaskViewSurface,
  type TaskViewWritableProjectScope,
  type UpdateSavedTaskViewInput,
  type WorkspaceSearchDateFilter,
} from '@mukuroji/contracts'
import { isRecord, isStringArray } from '../../shared/api/jsonValidation'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import { WorkspaceSearchApiError, resolveSearchApiBaseUrl } from '../../search/api/errors'

const taskViewApiBaseUrl = resolveSearchApiBaseUrl(import.meta.env)
const savedViewVisibilities = ['personal', 'team', 'shared']
const taskViewLayoutModes = ['table', 'board', 'list', 'gantt', 'calendar', 'timeline']
const taskViewDensities = ['compact', 'comfortable', 'spacious']
const sortDirections = ['asc', 'desc']
const migrationCodes = [
  'deleted-custom-field',
  'deleted-workflow-status',
  'permission-redacted',
  'inaccessible-scope',
  'invalid-layout',
  'invalid-url-override',
]
const migrationSections = [
  'scope',
  'filter',
  'layout',
  'group',
  'subgroup',
  'sort',
  'column',
  'density',
  'display-option',
  'url-override',
]
const migrationFallbacks = ['removed', 'reset-to-default', 'ignored', 'unavailable']
const workflowCategories = ['backlog', 'unstarted', 'started', 'completed', 'canceled']
const priorities = ['high', 'medium', 'low']
const dueDatePresets = ['overdue', 'today', 'upcoming', 'no-date']
const searchEntityTypes = ['work-item', 'project', 'team', 'comment', 'file', 'document']
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
]
const workspaceSearchDateFields = ['createdAt', 'updatedAt', 'dueDate']
const taskViewFilterFields = [
  'keyword',
  'entityTypes',
  'assigneeUserIds',
  'creatorUserIds',
  'statuses',
  'relationIds',
  'customFields',
  'date',
  'projectIds',
  'teamIds',
  'workflowStatuses',
  'workflowCategories',
  'priorities',
  'dueDatePreset',
  'includeArchived',
  'workItemTypeIds',
]

/**
 * Loads every accessible saved task view for an optional surface and scope.
 *
 * @param accessToken - Bearer token used by the task-view API.
 * @param query - Optional surface, scope, and page-size constraints.
 * @param signal - Optional abort signal for route disposal.
 * @returns Permission-filtered saved task views and fail-closed capabilities across all pages.
 */
export async function getSavedTaskViews(
  accessToken: string,
  query: SavedTaskViewListQuery = {},
  signal?: AbortSignal,
): Promise<Omit<SavedTaskViewsResponse, 'nextCursor'>> {
  const views: SavedTaskView[] = []
  const seenViewIds = new Set<string>()
  const seenCursors = new Set<string>()
  let capabilities: SavedTaskViewCapabilities | undefined
  let cursor = query.cursor

  do {
    const searchParams = createSavedTaskViewListSearchParams({
      ...query,
      cursor,
      limit: query.limit ?? 50,
    })
    const response = await requestJson(
      `${taskViewApiBaseUrl}/task-views?${searchParams.toString()}`,
      accessToken,
      { signal },
    )
    const page = readSavedTaskViewsResponse(response)
    capabilities = capabilities
      ? intersectSavedTaskViewCapabilities(capabilities, page.capabilities)
      : page.capabilities
    for (const view of page.views) {
      if (!seenViewIds.has(view.id)) {
        seenViewIds.add(view.id)
        views.push(view)
      }
    }
    cursor = page.nextCursor && !seenCursors.has(page.nextCursor)
      ? page.nextCursor
      : undefined
    if (cursor) seenCursors.add(cursor)
  } while (cursor)

  if (!capabilities) throw invalidTaskViewResponse()
  return { capabilities, views }
}

/**
 * Loads one saved task view directly for permalink resolution.
 *
 * @param accessToken - Bearer token used by the task-view API.
 * @param viewId - Workspace-unique saved task-view identifier.
 * @param signal - Optional abort signal for route disposal.
 * @returns The permission-filtered and migrated saved task view.
 */
export async function getSavedTaskView(
  accessToken: string,
  viewId: string,
  signal?: AbortSignal,
): Promise<SavedTaskView> {
  return readSavedTaskView(await requestJson(
    `${taskViewApiBaseUrl}/task-views/${encodeURIComponent(viewId)}`,
    accessToken,
    { signal },
  ))
}

/**
 * Persists a new task view definition and initial viewer preferences.
 *
 * @param accessToken - Bearer token used by the task-view API.
 * @param input - Complete definition and lifecycle metadata to create.
 * @param mutationContext - Stable request identifiers retained across retries.
 * @returns The newly created saved task view.
 */
export async function createSavedTaskView(
  accessToken: string,
  input: CreateSavedTaskViewInput,
  mutationContext: MutationRequestContext,
): Promise<SavedTaskView> {
  return readSavedTaskView(await requestJson(
    `${taskViewApiBaseUrl}/task-views`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  ))
}

/**
 * Applies a revision-guarded definition or preference update.
 *
 * @param accessToken - Bearer token used by the task-view API.
 * @param viewId - Saved task-view identifier to update.
 * @param input - Revision and replacement fields.
 * @param mutationContext - Stable request identifiers retained across retries.
 * @returns The updated saved task view.
 */
export async function updateSavedTaskView(
  accessToken: string,
  viewId: string,
  input: UpdateSavedTaskViewInput,
  mutationContext: MutationRequestContext,
): Promise<SavedTaskView> {
  return readSavedTaskView(await requestJson(
    `${taskViewApiBaseUrl}/task-views/${encodeURIComponent(viewId)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PATCH',
    },
  ))
}

/**
 * Duplicates an accessible saved task view through the canonical lifecycle endpoint.
 *
 * @param accessToken - Bearer token used by the task-view API.
 * @param viewId - Accessible source view identifier.
 * @param input - Optional destination metadata and initial preferences.
 * @param mutationContext - Stable request identifiers retained across retries.
 * @returns The independent duplicated saved task view.
 */
export async function duplicateSavedTaskView(
  accessToken: string,
  viewId: string,
  input: DuplicateSavedTaskViewInput,
  mutationContext: MutationRequestContext,
): Promise<SavedTaskView> {
  return readSavedTaskView(await requestJson(
    `${taskViewApiBaseUrl}/task-views/${encodeURIComponent(viewId)}/duplicate`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  ))
}

/**
 * Deletes one saved task view under an optimistic revision guard.
 *
 * @param accessToken - Bearer token used by the task-view API.
 * @param viewId - Saved task-view identifier to delete.
 * @param expectedRevision - Revision observed by the deleting client.
 * @param mutationContext - Stable request identifiers retained across retries.
 * @returns Nothing after the server acknowledges deletion.
 */
export async function deleteSavedTaskView(
  accessToken: string,
  viewId: string,
  expectedRevision: number,
  mutationContext: MutationRequestContext,
): Promise<void> {
  const searchParams = new URLSearchParams({ expectedRevision: String(expectedRevision) })
  await requestJson(
    `${taskViewApiBaseUrl}/task-views/${encodeURIComponent(viewId)}?${searchParams.toString()}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )
}

/** Converts a typed list query into deterministic endpoint parameters. */
function createSavedTaskViewListSearchParams(query: SavedTaskViewListQuery): URLSearchParams {
  const searchParams = new URLSearchParams()
  if (query.surface) searchParams.set('surface', query.surface)
  if (query.scope) searchParams.set('scope', JSON.stringify(query.scope))
  if (query.limit) searchParams.set('limit', String(query.limit))
  if (query.cursor) searchParams.set('cursor', query.cursor)
  searchParams.sort()
  return searchParams
}

/** Reads and validates one cursor page returned by the task-view API. */
function readSavedTaskViewsResponse(value: unknown): SavedTaskViewsResponse {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ['capabilities', 'views', 'nextCursor']) ||
    !isSavedTaskViewCapabilities(value.capabilities) ||
    !Array.isArray(value.views)
  ) {
    throw invalidTaskViewResponse()
  }
  const views = value.views.map(readSavedTaskView)
  if (value.nextCursor !== undefined && typeof value.nextCursor !== 'string') {
    throw invalidTaskViewResponse()
  }
  return {
    capabilities: {
      canManageSharedViews: value.capabilities.canManageSharedViews,
      canSetTeamDefault: value.capabilities.canSetTeamDefault,
      canWrite: value.capabilities.canWrite,
      writableProjectScopes: dedupeTaskViewWritableProjectScopes(
        value.capabilities.writableProjectScopes,
      ),
      writableTeamIds: [...new Set(value.capabilities.writableTeamIds)],
    },
    views,
    ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}),
  }
}

/** Returns whether an unknown list capability object matches the complete response contract. */
function isSavedTaskViewCapabilities(value: unknown): value is SavedTaskViewCapabilities {
  return isRecord(value) &&
    hasOnlyFields(value, [
      'canWrite',
      'canManageSharedViews',
      'canSetTeamDefault',
      'writableProjectScopes',
      'writableTeamIds',
    ]) &&
    typeof value.canWrite === 'boolean' &&
    typeof value.canManageSharedViews === 'boolean' &&
    typeof value.canSetTeamDefault === 'boolean' &&
    Array.isArray(value.writableProjectScopes) &&
    value.writableProjectScopes.every(isTaskViewWritableProjectScope) &&
    isStringArray(value.writableTeamIds)
}

/** Returns whether one unknown value is a complete Team-qualified writable Project scope. */
function isTaskViewWritableProjectScope(
  value: unknown,
): value is TaskViewWritableProjectScope {
  return isRecord(value) &&
    hasOnlyFields(value, ['teamId', 'projectId']) &&
    typeof value.teamId === 'string' &&
    value.teamId.length > 0 &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0
}

/** Deduplicates structured writable Project scopes without exposing an encoded key contract. */
function dedupeTaskViewWritableProjectScopes(
  scopes: readonly TaskViewWritableProjectScope[],
): TaskViewWritableProjectScope[] {
  const deduped: TaskViewWritableProjectScope[] = []
  for (const scope of scopes) {
    if (deduped.some((candidate) =>
      candidate.teamId === scope.teamId && candidate.projectId === scope.projectId
    )) {
      continue
    }
    deduped.push({ projectId: scope.projectId, teamId: scope.teamId })
  }
  return deduped
}

/**
 * Intersects capabilities observed across cursor pages so mid-pagination permission changes fail closed.
 *
 * @param current - Capabilities retained from prior pages.
 * @param next - Capabilities returned by the next page.
 * @returns Capabilities allowed by every observed page.
 */
function intersectSavedTaskViewCapabilities(
  current: SavedTaskViewCapabilities,
  next: SavedTaskViewCapabilities,
): SavedTaskViewCapabilities {
  const nextWritableTeamIds = new Set(next.writableTeamIds)
  return {
    canManageSharedViews: current.canManageSharedViews && next.canManageSharedViews,
    canSetTeamDefault: current.canSetTeamDefault && next.canSetTeamDefault,
    canWrite: current.canWrite && next.canWrite,
    writableProjectScopes: current.writableProjectScopes.filter((scope) =>
      next.writableProjectScopes.some((candidate) =>
        candidate.teamId === scope.teamId && candidate.projectId === scope.projectId
      )
    ),
    writableTeamIds: current.writableTeamIds.filter((teamId) =>
      nextWritableTeamIds.has(teamId)
    ),
  }
}

/** Reads and validates one saved task view returned across an HTTP boundary. */
function readSavedTaskView(value: unknown): SavedTaskView {
  if (!isRecord(value)) throw invalidTaskViewResponse()
  const candidate = isRecord(value.view) ? value.view : value
  if (
    candidate.schemaVersion !== TASK_VIEW_SCHEMA_VERSION ||
    typeof candidate.id !== 'string' ||
    typeof candidate.name !== 'string' ||
    (candidate.description !== undefined && typeof candidate.description !== 'string') ||
    !isSavedViewVisibility(candidate.visibility) ||
    typeof candidate.ownerUserId !== 'string' ||
    (candidate.teamId !== undefined && typeof candidate.teamId !== 'string') ||
    !isTaskViewDefinition(candidate.definition) ||
    !isPositiveInteger(candidate.revision) ||
    typeof candidate.canEdit !== 'boolean' ||
    !isSavedTaskViewPreference(candidate.preference) ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    !isOptionalMigrationWarnings(candidate.migrationWarnings)
  ) {
    throw invalidTaskViewResponse()
  }
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    id: candidate.id,
    name: candidate.name,
    ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
    visibility: candidate.visibility,
    ownerUserId: candidate.ownerUserId,
    ...(typeof candidate.teamId === 'string' ? { teamId: candidate.teamId } : {}),
    definition: candidate.definition,
    revision: candidate.revision,
    canEdit: candidate.canEdit,
    preference: candidate.preference,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    ...(candidate.migrationWarnings ? { migrationWarnings: candidate.migrationWarnings } : {}),
  }
}

/** Returns whether an unknown definition has every version-one task-view field. */
function isTaskViewDefinition(value: unknown): value is TaskViewDefinition {
  return isRecord(value) &&
    isTaskViewSurface(value.surface) &&
    isTaskViewScope(value.scope) &&
    isTaskViewFilters(value.filters) &&
    isTaskViewLayout(value.layout)
}

/** Returns whether a value is a supported task-view surface. */
function isTaskViewSurface(value: unknown): value is TaskViewSurface {
  return typeof value === 'string' && TASK_VIEW_SURFACES.some((surface) => surface === value)
}

/** Returns whether a value is a well-formed task-view scope. */
function isTaskViewScope(value: unknown): value is TaskViewScope {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'workspace' || value.kind === 'viewer') return true
  if (value.kind === 'team') return typeof value.teamId === 'string'
  return value.kind === 'project' &&
    typeof value.projectId === 'string' &&
    (value.teamId === undefined || typeof value.teamId === 'string')
}

/** Returns whether an unknown filter object is safe to expose as task-view filters. */
function isTaskViewFilters(value: unknown): value is TaskViewFilters {
  if (!isRecord(value) || !hasOnlyFields(value, taskViewFilterFields)) return false
  if (!hasOptionalString(value.keyword)) return false
  if (!hasOptionalStringArrayFrom(value.entityTypes, searchEntityTypes)) return false
  if (!hasOptionalStringArray(value.assigneeUserIds)) return false
  if (!hasOptionalStringArray(value.creatorUserIds)) return false
  if (!hasOptionalStringArray(value.statuses)) return false
  if (!hasOptionalStringArray(value.relationIds)) return false
  if (!hasOptionalStringArray(value.projectIds)) return false
  if (!hasOptionalStringArray(value.teamIds)) return false
  if (!hasOptionalStringArray(value.workItemTypeIds)) return false
  if (!hasOptionalStringArrayFrom(value.workflowCategories, workflowCategories)) return false
  if (!hasOptionalStringArrayFrom(value.priorities, priorities)) return false
  if (value.dueDatePreset !== undefined && !includesString(dueDatePresets, value.dueDatePreset)) {
    return false
  }
  if (value.includeArchived !== undefined && typeof value.includeArchived !== 'boolean') return false
  if (value.workflowStatuses !== undefined && (
    !Array.isArray(value.workflowStatuses) ||
    !value.workflowStatuses.every((entry) =>
      isRecord(entry) && typeof entry.teamId === 'string' && typeof entry.statusId === 'string'
    )
  )) return false
  if (value.customFields !== undefined && (
    !Array.isArray(value.customFields) ||
    !value.customFields.every(isSearchCustomFieldFilter)
  )) return false
  if (value.date !== undefined && !isWorkspaceSearchDateFilter(value.date)) return false
  return true
}

/** Returns whether an unknown value is a complete custom-field predicate. */
function isSearchCustomFieldFilter(value: unknown): value is SearchCustomFieldFilter {
  return isRecord(value) &&
    typeof value.fieldId === 'string' &&
    includesString(searchCustomFieldOperators, value.operator) &&
    (value.value === undefined || isSearchCustomFieldValue(value.value))
}

/** Returns whether an unknown value is supported by the search comparison contract. */
function isSearchCustomFieldValue(value: unknown): value is SearchCustomFieldValue {
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number' && Number.isFinite(value) ||
    isStringArray(value)
}

/** Returns whether an unknown value is a valid inclusive search date range. */
function isWorkspaceSearchDateFilter(value: unknown): value is WorkspaceSearchDateFilter {
  return isRecord(value) &&
    includesString(workspaceSearchDateFields, value.field) &&
    (value.from === undefined || typeof value.from === 'string') &&
    (value.to === undefined || typeof value.to === 'string')
}

/** Returns whether an unknown layout object is a complete task-view layout. */
function isTaskViewLayout(value: unknown): value is TaskViewLayout {
  return isRecord(value) &&
    includesString(taskViewLayoutModes, value.mode) &&
    (value.group === undefined || isTaskViewGrouping(value.group)) &&
    (value.subgroup === undefined || isTaskViewGrouping(value.subgroup)) &&
    Array.isArray(value.sort) &&
    value.sort.every((entry) =>
      isRecord(entry) &&
      typeof entry.field === 'string' &&
      includesString(sortDirections, entry.direction)
    ) &&
    Array.isArray(value.columns) &&
    value.columns.every((entry) =>
      isRecord(entry) &&
      typeof entry.field === 'string' &&
      (entry.width === undefined || isPositiveFiniteNumber(entry.width)) &&
      (entry.pin === undefined || entry.pin === 'start' || entry.pin === 'end')
    ) &&
    includesString(taskViewDensities, value.density) &&
    isTaskViewDisplayOptions(value.displayOptions)
}

/** Returns whether an unknown grouping object contains a field and direction. */
function isTaskViewGrouping(value: unknown): value is TaskViewGrouping {
  return isRecord(value) &&
    typeof value.field === 'string' &&
    includesString(sortDirections, value.direction)
}

/** Returns whether display options contain only optional booleans. */
function isTaskViewDisplayOptions(value: unknown): value is TaskViewDisplayOptions {
  if (!isRecord(value)) return false
  return [
    value.showCompleted,
    value.showArchived,
    value.showSubItems,
    value.showEmptyGroups,
    value.wrapText,
    value.showAssigneeAvatars,
  ].every((option) => option === undefined || typeof option === 'boolean')
}

/** Returns whether an unknown preference object is complete and internally consistent. */
function isSavedTaskViewPreference(value: unknown): value is SavedTaskViewPreference {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      'favorite',
      'pinned',
      'isDefault',
      'isPersonalDefault',
      'isTeamDefault',
      'defaultSource',
    ]) ||
    typeof value.favorite !== 'boolean' ||
    typeof value.pinned !== 'boolean' ||
    typeof value.isDefault !== 'boolean' ||
    typeof value.isPersonalDefault !== 'boolean' ||
    typeof value.isTeamDefault !== 'boolean'
  ) return false

  if (!value.isDefault) {
    return value.defaultSource === undefined &&
      !value.isPersonalDefault
  }
  if (value.defaultSource === 'personal') {
    return value.isPersonalDefault
  }
  if (value.defaultSource === 'team') {
    return value.isTeamDefault && !value.isPersonalDefault
  }
  return false
}

/** Returns whether a record contains no fields outside the current schema version. */
function hasOnlyFields(value: Record<string, unknown>, allowedFields: readonly string[]) {
  return Object.keys(value).every((field) => allowedFields.includes(field))
}

/** Returns whether optional migration warnings are valid safe warning records. */
function isOptionalMigrationWarnings(
  value: unknown,
): value is TaskViewMigrationWarning[] | undefined {
  return value === undefined || (
    Array.isArray(value) && value.every((warning) =>
      isRecord(warning) &&
      includesString(migrationCodes, warning.code) &&
      includesString(migrationSections, warning.section) &&
      includesString(migrationFallbacks, warning.fallback) &&
      (warning.referenceId === undefined || typeof warning.referenceId === 'string')
    )
  )
}

/** Sends one authenticated JSON request and reports stable API errors. */
async function requestJson(
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const body = await readJson(response)
  if (!response.ok) {
    const error = isRecord(body) ? body : {}
    throw new WorkspaceSearchApiError(
      response.status,
      typeof error.message === 'string' ? error.message : 'Unable to complete the task view request.',
      typeof error.code === 'string' ? error.code : undefined,
    )
  }
  return body
}

/** Reads optional JSON without accepting malformed transport payloads. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new WorkspaceSearchApiError(
      response.status,
      'Task view API returned invalid JSON.',
      'InvalidTaskViewResponse',
    )
  }
}

/** Returns whether a string is present in an untrusted string list. */
function includesString(values: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && values.includes(value)
}

/** Returns whether an optional value is a string. */
function hasOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** Returns whether an optional value is a string array. */
function hasOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value)
}

/** Returns whether an optional value is an array drawn from an allowed string set. */
function hasOptionalStringArrayFrom(value: unknown, allowed: readonly string[]): boolean {
  return value === undefined || (
    isStringArray(value) && value.every((entry) => allowed.includes(entry))
  )
}

/** Returns whether a number is positive and finite. */
function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Returns whether a number is a positive safe integer. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Returns whether a value is one of the three supported visibility values. */
function isSavedViewVisibility(
  value: unknown,
): value is SavedTaskView['visibility'] {
  return includesString(savedViewVisibilities, value)
}

/** Creates the stable invalid-response error used by every task-view reader. */
function invalidTaskViewResponse(): WorkspaceSearchApiError {
  return new WorkspaceSearchApiError(
    502,
    'Saved task view response was invalid.',
    'InvalidTaskViewResponse',
  )
}
