import {
  createSearchWorkItemTypeKey,
  DEFAULT_WORK_ITEM_TYPE_ID,
  type CreateSavedTaskViewInput,
  type CreateSavedWorkspaceViewInput,
  type SearchCustomFieldFilter,
  type SearchCustomFieldValue,
  type DuplicateSavedTaskViewInput,
  type ResolvedWorkItemConfiguration,
  type UpdateSavedTaskViewInput,
  type UpdateSavedWorkspaceViewInput,
  type TaskViewColumn,
  type TaskViewDefinition,
  type TaskViewDisplayOptions,
  type TaskViewFilters,
  type TaskViewGrouping,
  type TaskViewLayout,
  type TaskViewScope,
  type TaskViewSurface,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import { isTeamIssueNotFoundError, type TeamIssueDetailResponse } from '../../modules/work-items'
import {
  WorkspaceSearchError,
  createTaskViewProjectScopeKey,
  createTaskViewStatusKey,
  createTaskViewWorkflowStatusKey,
  type ResolveTaskViewRelationIdsInput,
  type TaskViewAccessScope,
} from '../../modules/workspace-search/workspace-search'
import {
  getWorkItemConfigurationWorkflows,
  resolveWorkItemTypeWorkflow,
} from '../../modules/work-items/work-item-configuration'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import {
  WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY,
  WORK_ITEMS_TEAM_READ_LIMIT,
} from '../shared/constants'
import { readBearerAccessToken, readJson } from '../shared/http'
import {
  readOptionalPositiveQueryInteger,
  readRequiredPositiveQueryInteger,
} from '../shared/input-parsing'
import { type WorkspacePrincipal } from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  createWorkspaceSearchContext,
  parseSearchWorkItemEntityId,
  toWorkspaceSearchErrorResponse,
  type WorkspaceSearchContext,
} from '../shared/search-access'
import { isRecord } from '../shared/value-guards'

/** One task-view request may strongly inspect at most one full 20-Team relation filter. */
const TASK_VIEW_RELATION_TARGET_READ_LIMIT = WORK_ITEMS_TEAM_READ_LIMIT * 100

/**
 * Enriches current task-view authorization with active configuration references.
 *
 * @param principal - Authenticated Workspace principal for the current request.
 * @param context - Directory-derived authorization snapshot for the request.
 * @returns Permission-safe task-view access and migration capability sets.
 */
async function createTaskViewAccessScope(
  principal: WorkspacePrincipal,
  context: WorkspaceSearchContext,
): Promise<TaskViewAccessScope> {
  const [workspaceConfiguration, activeMembers] = await Promise.all([
    workItemDependencies.workItemConfigurations.getWorkspaceConfiguration(
      principal.directoryId,
    ),
    workspaceDependencies.workspaceAccess.listActiveMembers(principal.directoryId),
  ])
  const teamConfigurations: Array<{
    teamId: string
    resolved: ResolvedWorkItemConfiguration
  }> = []
  for (let offset = 0; offset < context.directory.teams.length; offset += 8) {
    const batch = context.directory.teams.slice(offset, offset + 8)
    teamConfigurations.push(...await Promise.all(batch.map(async (team) => ({
      teamId: team.id,
      resolved: await workItemDependencies.workItemConfigurations.getTeamConfiguration(
        principal.directoryId,
        team.id,
      ),
    }))))
  }
  const activeCustomFieldIds = new Set(
    workspaceConfiguration.configuration.customFields.map((field) => field.id),
  )
  const activeWorkItemTypeIds = new Set<string>()
  const readableWorkItemTypeIds = new Set<string>()
  const readableCustomFieldIds = new Set(activeCustomFieldIds)
  const activeStatusIds = new Set<string>()
  const activeWorkflowStatusIds = new Set<string>()
  const readableActorIds = new Set(activeMembers.flatMap((member) => [
    member.memberKey,
    member.email,
  ]))
  const relationTargetReadCache = new Map<
    string,
    Promise<TeamIssueDetailResponse | undefined>
  >()
  let planningAuthorizationStatePromise:
    ReturnType<typeof workItemDependencies.planning.getAuthorizationState> | undefined

  for (const teamConfiguration of teamConfigurations) {
    const canReadTeam =
      principal.isSystemAdmin ||
      context.taskViewAccess.teamIds.has(teamConfiguration.teamId)
    for (const field of teamConfiguration.resolved.configuration.customFields) {
      activeCustomFieldIds.add(field.id)
      if (canReadTeam) readableCustomFieldIds.add(field.id)
    }
    const configuration = teamConfiguration.resolved.configuration
    addActiveTaskViewWorkItemTypeIds(
      activeWorkItemTypeIds,
      teamConfiguration.teamId,
      configuration,
    )
    if (canReadTeam) {
      addActiveTaskViewWorkItemTypeIds(
        readableWorkItemTypeIds,
        teamConfiguration.teamId,
        configuration,
      )
    }
    for (const workflow of getWorkItemConfigurationWorkflows(configuration)) {
      for (const status of workflow.statuses) {
        activeStatusIds.add(createTaskViewStatusKey(teamConfiguration.teamId, status.id))
      }
    }
    const workItemTypeIds = configuration.workItemTypes?.map((type) => type.id) ?? []
    if (!workItemTypeIds.includes(DEFAULT_WORK_ITEM_TYPE_ID)) {
      workItemTypeIds.push(DEFAULT_WORK_ITEM_TYPE_ID)
    }
    for (const workItemTypeId of workItemTypeIds) {
      const workflow = resolveWorkItemTypeWorkflow(
        configuration,
        workItemTypeId,
        { allowArchived: true },
      )
      for (const status of workflow.statuses) {
        activeWorkflowStatusIds.add(createTaskViewWorkflowStatusKey(
          teamConfiguration.teamId,
          workItemTypeId,
          status.id,
        ))
      }
    }
  }

  return {
    ...context.taskViewAccess,
    activeCustomFieldIds,
    activeWorkItemTypeIds,
    readableWorkItemTypeIds,
    readableCustomFieldIds,
    activeStatusIds,
    activeWorkflowStatusIds,
    readableActorIds,
    resolveReadableRelationIds: (input) => resolveReadableTaskViewRelationIds(
      principal,
      context,
      input,
      relationTargetReadCache,
      () => {
        planningAuthorizationStatePromise ??=
          workItemDependencies.planning.getAuthorizationState(principal.directoryId)
        return planningAuthorizationStatePromise
      },
    ),
  }
}

/** Adds the currently defined Team-qualified Work Item Type keys for one Team configuration. */
function addActiveTaskViewWorkItemTypeIds(
  activeTypeIds: Set<string>,
  teamId: string,
  configuration: WorkItemConfiguration,
): void {
  activeTypeIds.add(createSearchWorkItemTypeKey(teamId, DEFAULT_WORK_ITEM_TYPE_ID))
  for (const type of configuration.workItemTypes ?? []) {
    activeTypeIds.add(createSearchWorkItemTypeKey(teamId, type.id))
  }
}

/** Work Item relation prefixes whose target identifier is Team-local. */
const taskViewWorkItemRelationPrefixes: ReadonlySet<string> = new Set([
  'parent',
  'child',
  'blocks',
  'blockedBy',
  'related',
  'duplicate',
])

/**
 * Resolves persisted relation references against current targets and current viewer access.
 *
 * @param principal - Authenticated principal whose access bounds every reference.
 * @param context - Current directory and search authorization snapshot.
 * @param input - Candidate references and the task-view context that qualifies local IDs.
 * @param targetReadCache - Request-local strongly consistent Work Item target cache.
 * @param readPlanningAuthorizationState - Lazy current Planning authorization-state reader.
 * @returns Relation IDs that may be disclosed without changing valid empty-result filters.
 */
async function resolveReadableTaskViewRelationIds(
  principal: WorkspacePrincipal,
  context: WorkspaceSearchContext,
  input: ResolveTaskViewRelationIdsInput,
  targetReadCache: Map<string, Promise<TeamIssueDetailResponse | undefined>>,
  readPlanningAuthorizationState: () => ReturnType<
    typeof workItemDependencies.planning.getAuthorizationState
  >,
): Promise<ReadonlySet<string>> {
  const readableIds = new Set<string>()
  const checks: Array<() => Promise<void>> = []
  let scopedTeamIds: readonly string[] | undefined

  for (const relationId of input.relationIds) {
    const separatorIndex = relationId.indexOf(':')
    const prefix = separatorIndex < 0 ? undefined : relationId.slice(0, separatorIndex)
    const targetId = separatorIndex < 0 ? undefined : relationId.slice(separatorIndex + 1)

    if (prefix && taskViewWorkItemRelationPrefixes.has(prefix)) {
      if (!targetId) continue
      scopedTeamIds ??= resolveTaskViewRelationScopeTeamIds(input.scope, context)
      if (scopedTeamIds.length > WORK_ITEMS_TEAM_READ_LIMIT) {
        throw new WorkspaceSearchError(
          413,
          'TaskViewRelationResolutionLimitExceeded',
          `Task view relation resolution spans more than ${WORK_ITEMS_TEAM_READ_LIMIT} Teams.`,
        )
      }
      const candidateTeamIds = scopedTeamIds
      checks.push(async () => {
        for (const teamId of candidateTeamIds) {
          if (await readAuthorizedTaskViewRelationTarget(
            principal,
            context,
            teamId,
            targetId,
            targetReadCache,
          )) {
            readableIds.add(relationId)
            return
          }
        }
      })
      continue
    }

    if (prefix === 'work-item') {
      if (!targetId) continue
      const target = parseSearchWorkItemEntityId(targetId)
      if (!target) continue
      checks.push(async () => {
        if (await readAuthorizedTaskViewRelationTarget(
          principal,
          context,
          target.teamId,
          target.issueId,
          targetReadCache,
        )) {
          readableIds.add(relationId)
        }
      })
      continue
    }

    if (prefix === 'project') {
      if (!targetId) continue
      checks.push(async () => {
        if (canReadTaskViewProjectRelationTarget(principal, context, input.scope, targetId)) {
          readableIds.add(relationId)
        }
      })
      continue
    }

    if (prefix === 'goal') {
      if (!targetId) continue
      checks.push(async () => {
        const state = await readPlanningAuthorizationState()
        const target = state.entities.find((entity) =>
          entity.id === targetId &&
          entity.type === 'goal' &&
          entity.archivedAt === undefined
        )
        if (target && canReadTaskViewGoalRelationTarget(principal, context, target)) {
          readableIds.add(relationId)
        }
      })
      continue
    }

  }

  for (
    let offset = 0;
    offset < checks.length;
    offset += WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY
  ) {
    await Promise.all(
      checks.slice(offset, offset + WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY)
        .map((check) => check()),
    )
  }
  return readableIds
}

/**
 * Resolves Teams in which an unqualified Work Item relation target may be interpreted.
 *
 * @param scope - Task-view scope that qualifies Team-local Work Item IDs when possible.
 * @param context - Current readable Team and Project hierarchy.
 * @returns Active readable Team IDs bounded later by the aggregate-read policy.
 */
function resolveTaskViewRelationScopeTeamIds(
  scope: ResolveTaskViewRelationIdsInput['scope'],
  context: WorkspaceSearchContext,
): readonly string[] {
  if (scope.kind === 'team') return [scope.teamId]
  if (scope.kind === 'project' && scope.teamId) return [scope.teamId]
  if (scope.kind === 'project') {
    return context.directory.teams.flatMap((team) =>
      team.projects.some((project) => project.id === scope.projectId) &&
        context.taskViewAccess.projectScopeKeys.has(
          createTaskViewProjectScopeKey(team.id, scope.projectId),
        )
        ? [team.id]
        : []
    )
  }
  return context.directory.teams.flatMap((team) =>
    context.taskViewAccess.teamIds.has(team.id) ? [team.id] : []
  )
}

/**
 * Strongly reads one Work Item relation target and reapplies its current assigned-Project ACL.
 *
 * @param principal - Authenticated current viewer.
 * @param context - Current directory and task-view access snapshot.
 * @param teamId - Canonical owner Team of the target.
 * @param issueId - Team-local target Work Item ID.
 * @param cache - Request-local canonical target read cache.
 * @returns The current readable target, or undefined after deletion or permission loss.
 */
async function readAuthorizedTaskViewRelationTarget(
  principal: WorkspacePrincipal,
  context: WorkspaceSearchContext,
  teamId: string,
  issueId: string,
  cache: Map<string, Promise<TeamIssueDetailResponse | undefined>>,
): Promise<TeamIssueDetailResponse | undefined> {
  const team = context.directory.teams.find((candidate) => candidate.id === teamId)
  if (
    !team ||
    (!principal.isSystemAdmin && !context.taskViewAccess.teamIds.has(teamId))
  ) {
    return undefined
  }
  const cacheKey = JSON.stringify([teamId, issueId])
  let pending = cache.get(cacheKey)
  if (!pending) {
    if (cache.size >= TASK_VIEW_RELATION_TARGET_READ_LIMIT) {
      throw new WorkspaceSearchError(
        413,
        'TaskViewRelationResolutionLimitExceeded',
        'Task view relation resolution exceeds the current-source target read limit.',
      )
    }
    pending = workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      teamId,
      issueId,
      { consistentIssueRead: true, includeEvents: false },
    ).catch((error) => {
      if (isTeamIssueNotFoundError(error)) return undefined
      throw error
    })
    cache.set(cacheKey, pending)
  }
  const detail = await pending
  if (!detail || detail.issue.id !== issueId || detail.issue.teamId !== teamId) return undefined
  const assignedProjectId = detail.issue.assignedProjectId
  if (!assignedProjectId) return detail
  if (!team.projects.some((project) => project.id === assignedProjectId)) return undefined
  if (
    principal.isSystemAdmin ||
    context.taskViewAccess.projectScopeKeys.has(
      createTaskViewProjectScopeKey(teamId, assignedProjectId),
    ) ||
    principal.enterpriseAuthorizedTeamIds?.includes(teamId)
  ) {
    return detail
  }
  return undefined
}

/**
 * Checks a Document-style Project relation against a non-ambiguous current Project scope.
 *
 * @param principal - Authenticated current viewer.
 * @param context - Current active Project hierarchy and access sets.
 * @param scope - Task-view scope that may qualify a duplicate Project ID.
 * @param projectId - Bare Project target identifier from the relation filter.
 * @returns Whether the Project exists and is readable without cross-Team confusion.
 */
function canReadTaskViewProjectRelationTarget(
  principal: WorkspacePrincipal,
  context: WorkspaceSearchContext,
  scope: ResolveTaskViewRelationIdsInput['scope'],
  projectId: string,
): boolean {
  const scopeTeamId = scope.kind === 'team'
    ? scope.teamId
    : scope.kind === 'project'
      ? scope.teamId
      : undefined
  if (scopeTeamId) {
    const team = context.directory.teams.find((candidate) => candidate.id === scopeTeamId)
    if (!team?.projects.some((project) => project.id === projectId)) return false
    return principal.isSystemAdmin ||
      context.taskViewAccess.projectScopeKeys.has(
        createTaskViewProjectScopeKey(scopeTeamId, projectId),
      ) ||
      Boolean(principal.enterpriseAuthorizedTeamIds?.includes(scopeTeamId))
  }
  if (context.taskViewAccess.projectIds.has(projectId)) return true
  const ownerTeams = context.directory.teams.filter((team) =>
    team.projects.some((project) => project.id === projectId)
  )
  return ownerTeams.length === 1 && Boolean(
    ownerTeams[0] && principal.enterpriseAuthorizedTeamIds?.includes(ownerTeams[0].id),
  )
}

/**
 * Checks one active Planning Goal against the current Planning response boundary.
 *
 * @param principal - Authenticated current viewer.
 * @param context - Current active Team/Project hierarchy and task-view access.
 * @param target - Current unarchived Planning authorization reference.
 * @returns Whether the current Planning API would disclose the Goal.
 */
function canReadTaskViewGoalRelationTarget(
  principal: WorkspacePrincipal,
  context: WorkspaceSearchContext,
  target: Awaited<ReturnType<
    typeof workItemDependencies.planning.getAuthorizationState
  >>['entities'][number],
): boolean {
  const team = target.teamId === undefined
    ? undefined
    : context.directory.teams.find((candidate) => candidate.id === target.teamId)
  const projectTeams = target.projectId === undefined
    ? []
    : context.directory.teams.filter((candidate) =>
        (target.teamId === undefined || candidate.id === target.teamId) &&
        candidate.projects.some((project) => project.id === target.projectId)
      )
  const projectTeam = projectTeams.length === 1 ? projectTeams[0] : undefined
  if (
    (target.teamId !== undefined && !team) ||
    (target.projectId !== undefined && projectTeams.length !== 1)
  ) {
    return false
  }
  if (
    principal.isSystemAdmin ||
    principal.enterprisePermissions === undefined ||
    principal.enterpriseRouteAuthorizedAtResource === true &&
      principal.enterpriseAuthorizationResource?.kind === 'workspace'
  ) {
    return true
  }
  if (target.projectId !== undefined && projectTeam) {
    return context.taskViewAccess.projectScopeKeys.has(
      createTaskViewProjectScopeKey(projectTeam.id, target.projectId),
    ) || Boolean(principal.enterpriseAuthorizedTeamIds?.includes(projectTeam.id))
  }
  return Boolean(target.teamId && context.taskViewAccess.teamIds.has(target.teamId))
}

/**
 * Reads one JSON body without assigning a trusted application type prematurely.
 *
 * @param request - Hono request JSON reader.
 * @returns Parsed untrusted JSON value.
 */
async function readTaskViewJson(request: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json()
  } catch (error) {
    return invalidTaskViewApiInput('Task view request body must be valid JSON.', error)
  }
}

/**
 * Reads one stable task-view path identifier.
 *
 * @param value - Untrusted path segment.
 * @returns Trimmed application identifier.
 */
function readTaskViewPathId(value: unknown): string {
  const identifier = readRequiredTaskViewText(value, 'Task view ID', 256)
  if (!/^[A-Za-z0-9._:@+-]+$/u.test(identifier)) {
    return invalidTaskViewApiInput('Task view ID is invalid.')
  }
  return identifier
}

/**
 * Reads an optional opaque task-view cursor without decoding its contents at the transport layer.
 *
 * @param value - Untrusted cursor query value.
 * @returns Bounded opaque cursor.
 */
function readTaskViewCursor(value: unknown): string {
  return readRequiredTaskViewText(value, 'Task view cursor', 8_192)
}

/**
 * Reads the bounded page size accepted by the task-view list contract.
 *
 * @param value - Untrusted limit query value.
 * @returns Integer page size between one and one hundred.
 */
function readTaskViewListLimit(value: unknown): number {
  const parsed = typeof value === 'string' && value ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    return invalidTaskViewApiInput('Task view limit must be between 1 and 100.')
  }
  return parsed
}

/**
 * Reads the optimistic revision supplied to task-view deletion.
 *
 * @param value - Untrusted revision query value.
 * @returns Positive safe integer revision.
 */
function readTaskViewRevisionQuery(value: unknown): number {
  const parsed = typeof value === 'string' && value ? Number(value) : Number.NaN
  return readPositiveTaskViewInteger(parsed, 'Task view revision')
}

/**
 * Reads an optional task-view mutation idempotency key.
 *
 * @param value - Untrusted request header value.
 * @returns Trimmed bounded idempotency key, when supplied.
 */
function readOptionalTaskViewIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  return readRequiredTaskViewText(value, 'Task view idempotency key', 256)
}

/**
 * Reads a task-view surface discriminator.
 *
 * @param value - Untrusted surface value.
 * @returns Supported task-view surface.
 */
function readTaskViewSurface(value: unknown): TaskViewSurface {
  if (
    value === 'workspace-search' ||
    value === 'project' ||
    value === 'team' ||
    value === 'my-tasks' ||
    value === 'focus' ||
    value === 'triage'
  ) {
    return value
  }
  return invalidTaskViewApiInput('Task view surface is invalid.')
}

/**
 * Parses one JSON-encoded task-view scope query.
 *
 * @param value - Untrusted scope query value.
 * @returns Validated task-view resource scope.
 */
function readTaskViewScopeQuery(value: unknown): TaskViewScope {
  if (typeof value !== 'string' || !value) {
    return invalidTaskViewApiInput('Task view scope is invalid.')
  }
  try {
    return readTaskViewScope(JSON.parse(value))
  } catch (error) {
    if (error instanceof WorkspaceSearchError) throw error
    return invalidTaskViewApiInput('Task view scope is invalid.', error)
  }
}

/**
 * Reads one structured task-view resource scope.
 *
 * @param value - Untrusted scope value.
 * @returns Canonical task-view resource scope.
 */
function readTaskViewScope(value: unknown): TaskViewScope {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view scope is invalid.')
  }
  if (value.kind === 'workspace') return { kind: 'workspace' }
  if (value.kind === 'viewer') return { kind: 'viewer' }
  if (value.kind === 'team') {
    return {
      kind: 'team',
      teamId: readRequiredTaskViewText(value.teamId, 'Task view scope Team ID', 256),
    }
  }
  if (value.kind === 'project') {
    const teamId = readOptionalTaskViewText(value.teamId, 'Task view scope Team ID', 256)
    return {
      kind: 'project',
      projectId: readRequiredTaskViewText(
        value.projectId,
        'Task view scope Project ID',
        256,
      ),
      ...(teamId ? { teamId } : {}),
    }
  }
  return invalidTaskViewApiInput('Task view scope is invalid.')
}

/**
 * Reads one complete task-view definition.
 *
 * @param value - Untrusted definition value.
 * @returns Canonical task-view definition.
 */
function readTaskViewDefinition(value: unknown): TaskViewDefinition {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view definition is required.')
  }
  const surface = readTaskViewSurface(value.surface)
  const scope = readTaskViewScope(value.scope)
  const validScope = surface === 'workspace-search'
    ? scope.kind === 'workspace'
    : surface === 'project'
      ? scope.kind === 'project'
      : surface === 'team'
        ? scope.kind === 'team'
        : surface === 'my-tasks' || surface === 'focus'
          ? scope.kind === 'viewer'
          : false
  if (!validScope) {
    return invalidTaskViewApiInput('Task view surface and scope do not match.')
  }
  return {
    surface,
    scope,
    filters: readTaskViewFilters(value.filters),
    layout: readTaskViewLayout(value.layout),
  }
}

/**
 * Reads a task-view create payload.
 *
 * @param value - Untrusted request body.
 * @returns Validated create input.
 */
function readCreateSavedTaskViewInput(value: unknown): CreateSavedTaskViewInput {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view input is required.')
  }
  const visibility = readTaskViewVisibility(value.visibility)
  const teamId = readOptionalTaskViewText(value.teamId, 'Task view Team ID', 256)
  validateTaskViewVisibilityTeam(visibility, teamId)
  const description = readOptionalTaskViewText(
    value.description,
    'Task view description',
    1_000,
  )
  return {
    name: readRequiredTaskViewText(value.name, 'Task view name', 120),
    ...(description ? { description } : {}),
    visibility,
    ...(teamId ? { teamId } : {}),
    definition: readTaskViewDefinition(value.definition),
    ...(value.favorite === undefined
      ? {}
      : { favorite: readTaskViewBoolean(value.favorite, 'Task view favorite') }),
    ...(value.pinned === undefined
      ? {}
      : { pinned: readTaskViewBoolean(value.pinned, 'Task view pinned') }),
    ...(value.defaultSource === undefined
      ? {}
      : { defaultSource: readTaskViewDefaultSource(value.defaultSource) }),
  }
}

/**
 * Reads a revision-guarded task-view update payload.
 *
 * @param value - Untrusted request body.
 * @returns Validated update input.
 */
function readUpdateSavedTaskViewInput(value: unknown): UpdateSavedTaskViewInput {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view update is required.')
  }
  if (value.defaultSource !== undefined && value.clearDefaultSource !== undefined) {
    return invalidTaskViewApiInput(
      'Task view default assignment and clearing are mutually exclusive.',
    )
  }
  return {
    expectedRevision: readPositiveTaskViewInteger(
      value.expectedRevision,
      'Task view revision',
    ),
    ...(value.name === undefined
      ? {}
      : { name: readRequiredTaskViewText(value.name, 'Task view name', 120) }),
    ...(value.description === undefined
      ? {}
      : {
          description: value.description === null
            ? null
            : readRequiredTaskViewText(
                value.description,
                'Task view description',
                1_000,
              ),
        }),
    ...(value.visibility === undefined
      ? {}
      : { visibility: readTaskViewVisibility(value.visibility) }),
    ...(value.teamId === undefined
      ? {}
      : {
          teamId: value.teamId === null
            ? null
            : readRequiredTaskViewText(value.teamId, 'Task view Team ID', 256),
        }),
    ...(value.definition === undefined
      ? {}
      : { definition: readTaskViewDefinition(value.definition) }),
    ...(value.favorite === undefined
      ? {}
      : { favorite: readTaskViewBoolean(value.favorite, 'Task view favorite') }),
    ...(value.pinned === undefined
      ? {}
      : { pinned: readTaskViewBoolean(value.pinned, 'Task view pinned') }),
    ...(value.defaultSource === undefined
      ? {}
      : {
          defaultSource: value.defaultSource === null
            ? null
            : readTaskViewDefaultSource(value.defaultSource),
        }),
    ...(value.clearDefaultSource === undefined
      ? {}
      : { clearDefaultSource: readTaskViewDefaultSource(value.clearDefaultSource) }),
  }
}

/**
 * Reads task-view duplicate metadata.
 *
 * @param value - Untrusted request body.
 * @returns Validated duplicate input.
 */
function readDuplicateSavedTaskViewInput(value: unknown): DuplicateSavedTaskViewInput {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view duplicate input is required.')
  }
  return {
    ...(value.name === undefined
      ? {}
      : { name: readRequiredTaskViewText(value.name, 'Task view name', 120) }),
    ...(value.description === undefined
      ? {}
      : {
          description: value.description === null
            ? null
            : readRequiredTaskViewText(
                value.description,
                'Task view description',
                1_000,
              ),
        }),
    ...(value.visibility === undefined
      ? {}
      : { visibility: readTaskViewVisibility(value.visibility) }),
    ...(value.teamId === undefined
      ? {}
      : {
          teamId: value.teamId === null
            ? null
            : readRequiredTaskViewText(value.teamId, 'Task view Team ID', 256),
        }),
    ...(value.favorite === undefined
      ? {}
      : { favorite: readTaskViewBoolean(value.favorite, 'Task view favorite') }),
    ...(value.pinned === undefined
      ? {}
      : { pinned: readTaskViewBoolean(value.pinned, 'Task view pinned') }),
    ...(value.defaultSource === undefined
      ? {}
      : { defaultSource: readTaskViewDefaultSource(value.defaultSource) }),
  }
}

/**
 * Reads filters shared by task-oriented surfaces and Workspace Search.
 *
 * @param value - Untrusted filter object.
 * @returns Canonical task-view filters.
 */
function readTaskViewFilters(value: unknown): TaskViewFilters {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view filters are invalid.')
  }
  const filters: TaskViewFilters = {}
  const keyword = readOptionalTaskViewText(value.keyword, 'Task view keyword', 256)
  if (keyword) filters.keyword = keyword
  if (value.entityTypes !== undefined) {
    if (!Array.isArray(value.entityTypes) || value.entityTypes.length > 6) {
      return invalidTaskViewApiInput('Task view entity types are invalid.')
    }
    filters.entityTypes = [...new Set(value.entityTypes.map(readTaskViewEntityType))]
  }
  copyTaskViewStringFilter(filters, value, 'assigneeUserIds')
  copyTaskViewStringFilter(filters, value, 'creatorUserIds')
  copyTaskViewStringFilter(filters, value, 'statuses')
  copyTaskViewStringFilter(filters, value, 'relationIds')
  copyTaskViewStringFilter(filters, value, 'projectIds')
  copyTaskViewStringFilter(filters, value, 'teamIds')
  copyTaskViewStringFilter(filters, value, 'workItemTypeIds')
  if (value.customFields !== undefined) {
    if (!Array.isArray(value.customFields) || value.customFields.length > 50) {
      return invalidTaskViewApiInput('Task view custom field filters are invalid.')
    }
    filters.customFields = value.customFields.map(readTaskViewCustomFieldFilter)
  }
  if (value.date !== undefined) {
    filters.date = readTaskViewDateFilter(value.date)
  }
  if (value.workflowStatuses !== undefined) {
    if (!Array.isArray(value.workflowStatuses) || value.workflowStatuses.length > 100) {
      return invalidTaskViewApiInput('Task view workflow statuses are invalid.')
    }
    filters.workflowStatuses = value.workflowStatuses.map((status) => {
      if (!isRecord(status)) {
        return invalidTaskViewApiInput('Task view workflow status is invalid.')
      }
      return {
        teamId: readRequiredTaskViewText(
          status.teamId,
          'Task view workflow status Team ID',
          256,
        ),
        ...(status.workItemTypeId === undefined
          ? {}
          : {
              workItemTypeId: readRequiredTaskViewText(
                status.workItemTypeId,
                'Task view workflow status Work Item Type ID',
                256,
              ),
            }),
        statusId: readRequiredTaskViewText(
          status.statusId,
          'Task view workflow status ID',
          256,
        ),
      }
    })
  }
  if (value.workflowCategories !== undefined) {
    if (!Array.isArray(value.workflowCategories) || value.workflowCategories.length > 100) {
      return invalidTaskViewApiInput('Task view workflow categories are invalid.')
    }
    filters.workflowCategories = [
      ...new Set(value.workflowCategories.map(readTaskViewWorkflowCategory)),
    ]
  }
  if (value.priorities !== undefined) {
    if (!Array.isArray(value.priorities) || value.priorities.length > 100) {
      return invalidTaskViewApiInput('Task view priorities are invalid.')
    }
    filters.priorities = [...new Set(value.priorities.map(readTaskViewPriority))]
  }
  if (value.dueDatePreset !== undefined) {
    filters.dueDatePreset = readTaskViewDueDatePreset(value.dueDatePreset)
  }
  if (value.includeArchived !== undefined) {
    filters.includeArchived = readTaskViewBoolean(
      value.includeArchived,
      'Task view include archived',
    )
  }
  return filters
}

/**
 * Copies one bounded string-list filter into a canonical task-view filter object.
 *
 * @param target - Canonical filter object being constructed.
 * @param source - Untrusted source object.
 * @param key - Supported string-list filter key.
 */
function copyTaskViewStringFilter(
  target: TaskViewFilters,
  source: Record<string, unknown>,
  key: 'assigneeUserIds' | 'creatorUserIds' | 'statuses' | 'relationIds' | 'projectIds' | 'teamIds' | 'workItemTypeIds',
): void {
  const candidate = source[key]
  if (candidate === undefined) return
  target[key] = readTaskViewStringList(candidate, `Task view ${key}`, 100, 512)
}

/**
 * Reads one Workspace Search entity discriminator used by a task-view filter.
 *
 * @param value - Untrusted entity type.
 * @returns Supported entity type.
 */
function readTaskViewEntityType(
  value: unknown,
): NonNullable<TaskViewFilters['entityTypes']>[number] {
  if (
    value === 'work-item' ||
    value === 'project' ||
    value === 'team' ||
    value === 'comment' ||
    value === 'file' ||
    value === 'document'
  ) {
    return value
  }
  return invalidTaskViewApiInput('Task view entity type is invalid.')
}

/**
 * Reads one custom-field filter from a task-view definition.
 *
 * @param value - Untrusted custom-field filter.
 * @returns Canonical custom-field filter.
 */
function readTaskViewCustomFieldFilter(value: unknown): SearchCustomFieldFilter {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view custom field filter is invalid.')
  }
  const operator = readTaskViewCustomFieldOperator(value.operator)
  if (operator !== 'is-empty' && operator !== 'is-not-empty' && value.value === undefined) {
    return invalidTaskViewApiInput('Task view custom field filter value is required.')
  }
  return {
    fieldId: readRequiredTaskViewText(value.fieldId, 'Task view custom field ID', 256),
    operator,
    ...(value.value === undefined ? {} : { value: readTaskViewCustomFieldValue(value.value) }),
  }
}

/**
 * Reads one custom-field comparison operator.
 *
 * @param value - Untrusted operator.
 * @returns Supported comparison operator.
 */
function readTaskViewCustomFieldOperator(
  value: unknown,
): SearchCustomFieldFilter['operator'] {
  if (
    value === 'equals' ||
    value === 'not-equals' ||
    value === 'contains' ||
    value === 'greater-than' ||
    value === 'greater-than-or-equal' ||
    value === 'less-than' ||
    value === 'less-than-or-equal' ||
    value === 'is-empty' ||
    value === 'is-not-empty'
  ) {
    return value
  }
  return invalidTaskViewApiInput('Task view custom field operator is invalid.')
}

/**
 * Reads one JSON-compatible custom-field filter value.
 *
 * @param value - Untrusted filter value.
 * @returns Canonical custom-field filter value.
 */
function readTaskViewCustomFieldValue(value: unknown): SearchCustomFieldValue {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > 20_000) {
      return invalidTaskViewApiInput('Task view custom field value is too large.')
    }
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return invalidTaskViewApiInput('Task view custom field number is invalid.')
    }
    return value
  }
  if (Array.isArray(value)) {
    return readTaskViewStringList(value, 'Task view custom field list', 100, 512)
  }
  return invalidTaskViewApiInput('Task view custom field value is invalid.')
}

/**
 * Reads one inclusive task-view date range.
 *
 * @param value - Untrusted date filter.
 * @returns Canonical date filter.
 */
function readTaskViewDateFilter(value: unknown): NonNullable<TaskViewFilters['date']> {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view date filter is invalid.')
  }
  const field = value.field
  if (field !== 'createdAt' && field !== 'updatedAt' && field !== 'dueDate') {
    return invalidTaskViewApiInput('Task view date field is invalid.')
  }
  const from = readOptionalTaskViewText(value.from, 'Task view date lower bound', 128)
  const to = readOptionalTaskViewText(value.to, 'Task view date upper bound', 128)
  if (!from && !to) {
    return invalidTaskViewApiInput('Task view date range is empty.')
  }
  if (from && to && from > to) {
    return invalidTaskViewApiInput('Task view date range is reversed.')
  }
  return { field, ...(from ? { from } : {}), ...(to ? { to } : {}) }
}

/**
 * Reads one stable workflow category.
 *
 * @param value - Untrusted category.
 * @returns Supported workflow category.
 */
function readTaskViewWorkflowCategory(
  value: unknown,
): NonNullable<TaskViewFilters['workflowCategories']>[number] {
  if (
    value === 'backlog' ||
    value === 'unstarted' ||
    value === 'started' ||
    value === 'completed' ||
    value === 'canceled'
  ) {
    return value
  }
  return invalidTaskViewApiInput('Task view workflow category is invalid.')
}

/**
 * Reads one Work Item priority filter.
 *
 * @param value - Untrusted priority.
 * @returns Supported priority.
 */
function readTaskViewPriority(
  value: unknown,
): NonNullable<TaskViewFilters['priorities']>[number] {
  if (value === 'high' || value === 'medium' || value === 'low') return value
  return invalidTaskViewApiInput('Task view priority is invalid.')
}

/**
 * Reads one relative due-date preset.
 *
 * @param value - Untrusted due-date preset.
 * @returns Supported due-date preset.
 */
function readTaskViewDueDatePreset(
  value: unknown,
): NonNullable<TaskViewFilters['dueDatePreset']> {
  if (
    value === 'overdue' ||
    value === 'today' ||
    value === 'upcoming' ||
    value === 'no-date'
  ) {
    return value
  }
  return invalidTaskViewApiInput('Task view due-date preset is invalid.')
}

/**
 * Reads one complete task-view layout.
 *
 * @param value - Untrusted layout value.
 * @returns Canonical task-view layout.
 */
function readTaskViewLayout(value: unknown): TaskViewLayout {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view layout is invalid.')
  }
  if (!Array.isArray(value.sort) || value.sort.length > 10) {
    return invalidTaskViewApiInput('Task view sort is invalid.')
  }
  if (!Array.isArray(value.columns) || value.columns.length > 100) {
    return invalidTaskViewApiInput('Task view columns are invalid.')
  }
  const group = value.group === undefined
    ? undefined
    : readTaskViewGrouping(value.group, 'Task view group')
  const subgroup = value.subgroup === undefined
    ? undefined
    : readTaskViewGrouping(value.subgroup, 'Task view subgroup')
  return {
    mode: readTaskViewLayoutMode(value.mode),
    ...(group ? { group } : {}),
    ...(subgroup ? { subgroup } : {}),
    sort: value.sort.map((rule) => readTaskViewGrouping(rule, 'Task view sort')),
    columns: value.columns.map(readTaskViewColumn),
    density: readTaskViewDensity(value.density),
    displayOptions: readTaskViewDisplayOptions(value.displayOptions),
  }
}

/**
 * Reads one task-view grouping or sort rule.
 *
 * @param value - Untrusted grouping rule.
 * @param label - Stable validation label.
 * @returns Canonical grouping rule.
 */
function readTaskViewGrouping(value: unknown, label: string): TaskViewGrouping {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput(`${label} is invalid.`)
  }
  return {
    field: readRequiredTaskViewText(value.field, `${label} field`, 256),
    direction: readTaskViewSortDirection(value.direction, label),
  }
}

/**
 * Reads one task-view column.
 *
 * @param value - Untrusted column value.
 * @returns Canonical task-view column.
 */
function readTaskViewColumn(value: unknown): TaskViewColumn {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view column is invalid.')
  }
  let width: number | undefined
  if (value.width !== undefined) {
    if (
      typeof value.width !== 'number' ||
      !Number.isFinite(value.width) ||
      value.width < 40 ||
      value.width > 2_000
    ) {
      return invalidTaskViewApiInput('Task view column width is invalid.')
    }
    width = value.width
  }
  let pin: TaskViewColumn['pin']
  if (value.pin !== undefined) {
    if (value.pin !== 'start' && value.pin !== 'end') {
      return invalidTaskViewApiInput('Task view column pin is invalid.')
    }
    pin = value.pin
  }
  return {
    field: readRequiredTaskViewText(value.field, 'Task view column field', 256),
    ...(width === undefined ? {} : { width }),
    ...(pin === undefined ? {} : { pin }),
  }
}

/**
 * Reads all supported task-view display options without accepting coercion.
 *
 * @param value - Untrusted display-options object.
 * @returns Canonical display options.
 */
function readTaskViewDisplayOptions(value: unknown): TaskViewDisplayOptions {
  if (!isRecord(value)) {
    return invalidTaskViewApiInput('Task view display options are invalid.')
  }
  return {
    ...(value.showCompleted === undefined
      ? {}
      : {
          showCompleted: readTaskViewBoolean(
            value.showCompleted,
            'Task view showCompleted',
          ),
        }),
    ...(value.showArchived === undefined
      ? {}
      : {
          showArchived: readTaskViewBoolean(
            value.showArchived,
            'Task view showArchived',
          ),
        }),
    ...(value.showSubItems === undefined
      ? {}
      : {
          showSubItems: readTaskViewBoolean(
            value.showSubItems,
            'Task view showSubItems',
          ),
        }),
    ...(value.showEmptyGroups === undefined
      ? {}
      : {
          showEmptyGroups: readTaskViewBoolean(
            value.showEmptyGroups,
            'Task view showEmptyGroups',
          ),
        }),
    ...(value.wrapText === undefined
      ? {}
      : { wrapText: readTaskViewBoolean(value.wrapText, 'Task view wrapText') }),
    ...(value.showAssigneeAvatars === undefined
      ? {}
      : {
          showAssigneeAvatars: readTaskViewBoolean(
            value.showAssigneeAvatars,
            'Task view showAssigneeAvatars',
          ),
        }),
  }
}

/**
 * Reads one supported task-view layout mode.
 *
 * @param value - Untrusted layout mode.
 * @returns Supported layout mode.
 */
function readTaskViewLayoutMode(value: unknown): TaskViewLayout['mode'] {
  if (
    value === 'table' ||
    value === 'board' ||
    value === 'list' ||
    value === 'gantt' ||
    value === 'calendar' ||
    value === 'timeline'
  ) {
    return value
  }
  return invalidTaskViewApiInput('Task view layout mode is invalid.')
}

/**
 * Reads one task-view density.
 *
 * @param value - Untrusted density.
 * @returns Supported density.
 */
function readTaskViewDensity(value: unknown): TaskViewLayout['density'] {
  if (value === 'compact' || value === 'comfortable' || value === 'spacious') return value
  return invalidTaskViewApiInput('Task view density is invalid.')
}

/**
 * Reads one task-view sort direction.
 *
 * @param value - Untrusted direction.
 * @param label - Stable validation label.
 * @returns Supported sort direction.
 */
function readTaskViewSortDirection(
  value: unknown,
  label: string,
): TaskViewGrouping['direction'] {
  if (value === 'asc' || value === 'desc') return value
  return invalidTaskViewApiInput(`${label} direction is invalid.`)
}

/**
 * Reads one saved task-view visibility.
 *
 * @param value - Untrusted visibility.
 * @returns Supported visibility.
 */
function readTaskViewVisibility(
  value: unknown,
): CreateSavedTaskViewInput['visibility'] {
  if (value === 'personal' || value === 'team' || value === 'shared') return value
  return invalidTaskViewApiInput('Task view visibility is invalid.')
}

/**
 * Validates the relationship between task-view visibility and Team ownership.
 *
 * @param visibility - Validated saved view visibility.
 * @param teamId - Optional Team ownership identifier.
 */
function validateTaskViewVisibilityTeam(
  visibility: CreateSavedTaskViewInput['visibility'],
  teamId: string | undefined,
): void {
  if (visibility === 'team' && !teamId) {
    invalidTaskViewApiInput('Team task views require a Team ID.')
  }
  if (visibility !== 'team' && teamId) {
    invalidTaskViewApiInput('Only Team task views can contain a Team ID.')
  }
}

/**
 * Reads one mutable task-view default source.
 *
 * @param value - Untrusted default source.
 * @returns Supported default source.
 */
function readTaskViewDefaultSource(
  value: unknown,
): NonNullable<CreateSavedTaskViewInput['defaultSource']> {
  if (value === 'personal' || value === 'team') return value
  return invalidTaskViewApiInput('Task view default source is invalid.')
}

/**
 * Reads one boolean without coercion.
 *
 * @param value - Untrusted boolean value.
 * @param label - Stable validation label.
 * @returns Validated boolean.
 */
function readTaskViewBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    return invalidTaskViewApiInput(`${label} is invalid.`)
  }
  return value
}

/**
 * Reads one required positive integer.
 *
 * @param value - Untrusted number value.
 * @param label - Stable validation label.
 * @returns Positive safe integer.
 */
function readPositiveTaskViewInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return invalidTaskViewApiInput(`${label} must be a positive integer.`)
  }
  return value
}

/**
 * Reads one required bounded text value.
 *
 * @param value - Untrusted text value.
 * @param label - Stable validation label.
 * @param maximumLength - Maximum accepted trimmed length.
 * @returns Trimmed non-empty text.
 */
function readRequiredTaskViewText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (typeof value !== 'string') {
    return invalidTaskViewApiInput(`${label} is invalid.`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > maximumLength) {
    return invalidTaskViewApiInput(`${label} is invalid.`)
  }
  return normalized
}

/**
 * Reads one optional bounded text value.
 *
 * @param value - Untrusted optional text value.
 * @param label - Stable validation label.
 * @param maximumLength - Maximum accepted trimmed length.
 * @returns Trimmed text when supplied.
 */
function readOptionalTaskViewText(
  value: unknown,
  label: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined || value === '') return undefined
  return readRequiredTaskViewText(value, label, maximumLength)
}

/**
 * Reads one bounded string list while preserving first occurrence order.
 *
 * @param value - Untrusted list value.
 * @param label - Stable validation label.
 * @param maximumItems - Maximum accepted item count.
 * @param maximumLength - Maximum accepted length per item.
 * @returns Deduplicated string list.
 */
function readTaskViewStringList(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return invalidTaskViewApiInput(`${label} is invalid.`)
  }
  return [
    ...new Set(
      value.map((item) => readRequiredTaskViewText(item, label, maximumLength)),
    ),
  ]
}

/**
 * Creates a stable task-view validation error for the HTTP adapter boundary.
 *
 * @param message - Safe client-facing validation message.
 * @param cause - Optional parse or validation cause retained internally.
 * @returns Never returns because validation has failed.
 */
function invalidTaskViewApiInput(message: string, cause?: unknown): never {
  throw new WorkspaceSearchError(
    400,
    'InvalidTaskView',
    message,
    cause === undefined ? undefined : { cause },
  )
}

/**
 * Registers the task views HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerTaskViewsRoutes(routeApp: Hono): void {
  /** Current user が参照できる personal/team/shared saved views を返します。 */
  routeApp.get('/api/saved-views', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await createWorkspaceSearchContext(principal)
      return c.json(await workItemDependencies.workspaceSearch.listSavedViews({
        workspaceId: principal.directoryId,
        access: context.savedViewAccess,
        limit: readOptionalPositiveQueryInteger(c.req.query('limit'), 'Saved view limit'),
        cursor: c.req.query('cursor'),
      }))
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })

  /** Personal/team/shared saved view を作成します。 */
  routeApp.post('/api/saved-views', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await createWorkspaceSearchContext(principal)
      const input = await readJson<CreateSavedWorkspaceViewInput>(c.req)
      return c.json(await workItemDependencies.workspaceSearch.createSavedView({
        workspaceId: principal.directoryId,
        access: context.savedViewAccess,
        idempotencyKey: c.req.header('Idempotency-Key')?.trim() || undefined,
        input: input ?? {} as CreateSavedWorkspaceViewInput,
      }), 201)
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })

  /** Saved view definition と current user preference を更新します。 */
  routeApp.patch('/api/saved-views/:viewId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const viewId = c.req.param('viewId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await createWorkspaceSearchContext(principal)
      const input = await readJson<UpdateSavedWorkspaceViewInput>(c.req)
      return c.json(await workItemDependencies.workspaceSearch.updateSavedView({
        workspaceId: principal.directoryId,
        viewId,
        access: context.savedViewAccess,
        input: input ?? {} as UpdateSavedWorkspaceViewInput,
      }))
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })

  /** Saved view definition を revision 条件付きで削除します。 */
  routeApp.delete('/api/saved-views/:viewId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const viewId = c.req.param('viewId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await createWorkspaceSearchContext(principal)
      return c.json(await workItemDependencies.workspaceSearch.deleteSavedView({
        workspaceId: principal.directoryId,
        viewId,
        expectedRevision: readRequiredPositiveQueryInteger(
          c.req.query('expectedRevision'),
          'Saved view revision',
        ),
        access: context.savedViewAccess,
      }))
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })

  /** Returns task views visible to the current viewer within an optional surface and scope. */
  routeApp.get('/api/task-views', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await createWorkspaceSearchContext(principal)
      const surface = c.req.query('surface') === undefined
        ? undefined
        : readTaskViewSurface(c.req.query('surface'))
      const scope = c.req.query('scope') === undefined
        ? undefined
        : readTaskViewScopeQuery(c.req.query('scope'))
      const limit = c.req.query('limit') === undefined
        ? undefined
        : readTaskViewListLimit(c.req.query('limit'))
      const cursor = c.req.query('cursor') === undefined
        ? undefined
        : readTaskViewCursor(c.req.query('cursor'))
      const access = await createTaskViewAccessScope(principal, context)
      return c.json(await workItemDependencies.workspaceSearch.listTaskViews({
        workspaceId: principal.directoryId,
        access,
        ...(surface ? { surface } : {}),
        ...(scope ? { scope } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor ? { cursor } : {}),
      }))
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })

  /** Creates one personal, Team, or Workspace-shared task view. */
  routeApp.post('/api/task-views', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await createWorkspaceSearchContext(principal)
      const input = readCreateSavedTaskViewInput(await readTaskViewJson(c.req))
      const idempotencyKey = readOptionalTaskViewIdempotencyKey(
        c.req.header('Idempotency-Key'),
      )
      const access = await createTaskViewAccessScope(principal, context)
      return c.json(await workItemDependencies.workspaceSearch.createTaskView({
        workspaceId: principal.directoryId,
        access,
        input,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }), 201)
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })

  /** Reads one task view without disclosing inaccessible definitions. */
  routeApp.get('/api/task-views/:viewId', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await createWorkspaceSearchContext(principal)
      const viewId = readTaskViewPathId(c.req.param('viewId'))
      const access = await createTaskViewAccessScope(principal, context)
      return c.json(await workItemDependencies.workspaceSearch.getTaskView({
        workspaceId: principal.directoryId,
        viewId,
        access,
      }))
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })

  /** Updates one task view definition or the current viewer's preferences. */
  routeApp.patch('/api/task-views/:viewId', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await createWorkspaceSearchContext(principal)
      const viewId = readTaskViewPathId(c.req.param('viewId'))
      const input = readUpdateSavedTaskViewInput(await readTaskViewJson(c.req))
      const idempotencyKey = readOptionalTaskViewIdempotencyKey(
        c.req.header('Idempotency-Key'),
      )
      const access = await createTaskViewAccessScope(principal, context)
      return c.json(await workItemDependencies.workspaceSearch.updateTaskView({
        workspaceId: principal.directoryId,
        viewId,
        access,
        input,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }))
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })

  /** Duplicates one accessible task view into an independent lifecycle. */
  routeApp.post('/api/task-views/:viewId/duplicate', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await createWorkspaceSearchContext(principal)
      const sourceViewId = readTaskViewPathId(c.req.param('viewId'))
      const input = readDuplicateSavedTaskViewInput(await readTaskViewJson(c.req))
      const idempotencyKey = readOptionalTaskViewIdempotencyKey(
        c.req.header('Idempotency-Key'),
      )
      const access = await createTaskViewAccessScope(principal, context)
      return c.json(await workItemDependencies.workspaceSearch.duplicateTaskView({
        workspaceId: principal.directoryId,
        sourceViewId,
        access,
        input,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }), 201)
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })

  /** Deletes one task view definition under an optimistic revision guard. */
  routeApp.delete('/api/task-views/:viewId', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await createWorkspaceSearchContext(principal)
      const viewId = readTaskViewPathId(c.req.param('viewId'))
      const expectedRevision = readTaskViewRevisionQuery(c.req.query('expectedRevision'))
      const idempotencyKey = readOptionalTaskViewIdempotencyKey(
        c.req.header('Idempotency-Key'),
      )
      const access = await createTaskViewAccessScope(principal, context)
      return c.json(await workItemDependencies.workspaceSearch.deleteTaskView({
        workspaceId: principal.directoryId,
        viewId,
        expectedRevision,
        access,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }))
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })
}
