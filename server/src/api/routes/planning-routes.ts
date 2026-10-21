import { createHash } from 'node:crypto'
import {
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  type ConfigurePlanningUpdateCadenceInput,
  type CreatePlanningUpdateCommentInput,
  type CreatePlanningDependencyInput,
  type CreateWorkItemScheduleDependencyInput,
  type CreatePlanningEntityInput,
  type ScheduleDependencyConstraint,
  type CycleRolloverInput,
  type DuplicatePlanningEntityInput,
  type MovePlanningEntityInput,
  type PlanningEntity,
  type PlanningRevisionInput,
  type PlanningSnapshot,
  type PlanningStatusUpdateInput,
  type PlanningUpdateCadence,
  type PlanningUpdateTargetSummary,
  type PlanningUpdate,
  type PlanningUpdateComment,
  type PlanningUpdateReaction,
  type PlanningUpdateReactionInput,
  type PlanningUpdateTarget,
  type PublishPlanningUpdateInput,
  type PlanningWorkItemLinkInput,
  type PlanningWorkItemSummary,
  type UpdatePlanningEntityInput,
  type UpdateWorkItemScheduleDependencyInput,
  type WorkItemDependencyEndpoint,
  type WorkItemScheduleDependency,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import { type Locale, type ProjectAccessEntry, type ProjectRole } from '../../modules/directory'
import { type TeamIssueResponseItem } from '../../modules/work-items'
import {
  WorkspaceAccessError,
  type WorkspaceMember,
} from '../../modules/workspace-access/workspace-access'
import {
  CollaborationError,
  createPlanningUpdateCollaborationEntityKey,
  createPlanningUpdatePublicTargetKey,
} from '../../modules/collaboration/collaboration'
import {
  createFileProofingScopeKey,
  type FileProofingActor,
  type FileProofingScope,
} from '../../modules/files/file-proofing'
import {
  evaluateEnterpriseAccess,
  resolveEnterpriseDirectoryPrincipal,
} from '../../modules/enterprise-identity'
import {
  PlanningError,
  type PlanningCallerAuthorizationConditionCheck,
  type PlanningUpdateCadenceTransactionResult,
  type PlanningMutationTransaction,
  type PlanningUpdateAnnotationTransactionResult,
  type PlanningUpdatePublishTransactionResult,
  type PlanningWorkItemState,
} from '../../modules/planning'
import {
  previewUpdateFeedDigest,
  replaceDigestPreferences,
  readUpdateFeedFilterOptions,
  resolveUpdateFeedFilterScope,
  parseSavedUpdateFeeds,
  parseUpdateFeedQuery,
  readUpdateFeed,
  parseUpdateFeedReadState,
  setUpdateFeedReadState,
  withUpdateFeedReadState,
  type InboxDigestDependencies,
  type InboxDigestStore,
  type InboxDigestRecipient,
  type UpdateFeedReader,
} from '../../modules/update-feed'
import type {
  IdempotencyMutationToken,
  ReleaseIdempotencyRequest,
  ReserveIdempotencyRequest,
} from '../../modules/developer-platform/application/ports'
import { DeveloperPlatformError } from '../../modules/developer-platform'
import {
  authenticationDependencies,
  developerPlatformDependencies,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import { WORK_ITEMS_PARTITION_SCAN_LIMIT, WORK_ITEMS_TEAM_READ_LIMIT } from '../shared/constants'
import { resolveDeveloperManagementPrincipal } from '../shared/developer-platform-access'
import {
  hasUnqualifiedEnterpriseProjectScope,
  qualifyEnterpriseProjectScopes,
} from '../shared/enterprise-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import { readLocale } from '../shared/input-parsing'
import {
  createPlanningCallerAuthorizationConditionChecks,
  filterPlanningSnapshotForPrincipal,
  planningProjectAccessMatchesQualifiedScope,
  planningUpdateTargetsEqual,
  type PlanningWorkItemReadScope,
  readPlanningIdentifier,
  readPlanningPublishState,
  readPlanningWorkItemState,
  requirePlanningUpdateProjectPermission,
  requirePlanningUpdateTargetPermission,
  requirePlanningUpdateTeamPermission,
  requirePlanningWorkItemEndpointPermission,
  requirePlanningWorkspaceScopeRead,
  toPlanningErrorResponse,
} from '../shared/planning-access'
import {
  createApiMutationContext,
  getEffectiveProjectScopeAccessList,
  type ProjectPrincipal,
  requireProjectPermission,
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessWrite,
  resolveProjectAccessTeamId,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { getEnv } from '../shared/runtime-config'
import { isRecord, stableDigestStringify } from '../shared/value-guards'
import {
  createWorkItemListLimitExceededError,
  loadAuthorizedTeamIssue,
  readCanonicalTeamIssuesForAggregate,
} from '../shared/work-item-access'
import {
  createWorkItemScheduleIdempotencyUserId,
  createWorkItemScheduleIdempotencyWorkspaceId,
} from '../shared/work-item-schedule'
import {
  projectAccessAllows,
  type TeamPermissionContext,
  type TeamPermissionReadContext,
} from '../shared/workspace-access'

/** Maximum number of immutable updates included in one Planning export. */
const MAX_PLANNING_UPDATE_EXPORT_COUNT = 10_000

/** Maximum UTF-8 payload size accepted for one Planning export. */
const MAX_PLANNING_UPDATE_EXPORT_BYTES = 16_000_000

/** Planning publish が一度に評価する canonical Work Item の最大数です。 */
const PLANNING_CANONICAL_WORK_ITEM_LIMIT =
  WORK_ITEMS_TEAM_READ_LIMIT * WORK_ITEMS_PARTITION_SCAN_LIMIT

async function readPlanningJson<T>(request: { json: () => Promise<unknown> }) {
  const body = await readJson<unknown>(request)
  if (!isRecord(body)) {
    throw new PlanningError(
      400,
      'InvalidPlanningInput',
      'A JSON object request body is required.',
    )
  }
  return body as T
}

/**
 * Validates an untrusted Project/Initiative update target at the HTTP boundary.
 *
 * @param value - Candidate target from a request body.
 * @returns A normalized target suitable for authorization and the Planning domain.
 */
function readPlanningUpdateTarget(value: unknown): PlanningUpdateTarget {
  if (!isRecord(value)) {
    throw new PlanningError(
      400,
      'PlanningUpdateTargetInvalid',
      'Planning update target must be an object.',
    )
  }
  if (value.type === 'project') {
    return {
      type: 'project',
      teamId: readPlanningIdentifier(value.teamId, 'Update target Team ID'),
      projectId: readPlanningIdentifier(value.projectId, 'Update target Project ID'),
    }
  }
  if (value.type === 'initiative') {
    return {
      type: 'initiative',
      entityId: readPlanningIdentifier(value.entityId, 'Update target Initiative ID'),
    }
  }
  throw new PlanningError(
    400,
    'PlanningUpdateTargetInvalid',
    'Planning update target type is invalid.',
  )
}

/**
 * Builds one update target from explicit query parameters without accepting ambiguous IDs.
 *
 * @param targetType - Project/Initiative discriminator.
 * @param teamId - Required Team ID for a Project target.
 * @param projectId - Required Project ID for a Project target.
 * @param entityId - Required entity ID for an Initiative target.
 * @returns Validated update target.
 */
function readPlanningUpdateTargetQuery(
  targetType: string | undefined,
  teamId: string | undefined,
  projectId: string | undefined,
  entityId: string | undefined,
): PlanningUpdateTarget {
  if (targetType === 'project') {
    return readPlanningUpdateTarget({ type: targetType, teamId, projectId })
  }
  if (targetType === 'initiative') {
    return readPlanningUpdateTarget({ type: targetType, entityId })
  }
  throw new PlanningError(
    400,
    'PlanningUpdateTargetInvalid',
    'targetType must be project or initiative.',
  )
}

/**
 * Creates a bounded ASCII token for a Content-Disposition filename.
 *
 * @param value - Logical target key.
 * @returns Safe non-empty filename component.
 */
function createSafeExportFileToken(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128) ||
    'history'
}

/**
 * Parses an optional bounded update-history page size.
 *
 * @param value - Query-string value.
 * @returns A positive integer up to 100, or undefined when omitted.
 */
function readPlanningUpdateHistoryLimit(value: string | undefined) {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) {
    throw new PlanningError(400, 'PlanningUpdateHistoryLimitInvalid', 'History limit is invalid.')
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new PlanningError(
      400,
      'PlanningUpdateHistoryLimitInvalid',
      'History limit must be between 1 and 100.',
    )
  }
  return limit
}

/**
 * Parses one positive target-local immutable update version from a route segment.
 *
 * @param value - Encoded route parameter supplied by the caller.
 * @returns A positive safe integer version.
 */
function readPlanningUpdateVersion(value: string | undefined) {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new PlanningError(
      400,
      'PlanningUpdateVersionInvalid',
      'Planning update version is invalid.',
    )
  }
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new PlanningError(
      400,
      'PlanningUpdateVersionInvalid',
      'Planning update version must be a positive integer.',
    )
  }
  return version
}

/**
 * Validates and normalizes one append-only Planning update comment body.
 *
 * @param value - Untrusted JSON body field.
 * @returns Trimmed comment text within the domain byte limit.
 */
function readPlanningUpdateCommentBody(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PlanningError(
      400,
      'PlanningUpdateCommentInvalid',
      'Planning update comment body is required.',
    )
  }
  const body = value.trim()
  if (Buffer.byteLength(body, 'utf8') > 4_000) {
    throw new PlanningError(
      400,
      'PlanningUpdateCommentInvalid',
      'Planning update comment cannot exceed 4000 UTF-8 bytes.',
    )
  }
  return body
}

/**
 * Validates and normalizes one Planning update reaction token.
 *
 * @param value - Untrusted JSON emoji field.
 * @returns Trimmed reaction token within the domain byte limit.
 */
function readPlanningUpdateReactionToken(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PlanningError(
      400,
      'PlanningUpdateReactionInvalid',
      'Planning update reaction is required.',
    )
  }
  const emoji = value.trim()
  if (Buffer.byteLength(emoji, 'utf8') > 64) {
    throw new PlanningError(
      400,
      'PlanningUpdateReactionInvalid',
      'Planning update reaction cannot exceed 64 UTF-8 bytes.',
    )
  }
  return emoji
}

function readPlanningRouteId(value: string | undefined, label: string) {
  return readPlanningIdentifier(value, label)
}

function requirePlanningAuthorizationRevision(
  currentRevision: number,
  expectedRevision: unknown,
) {
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw new PlanningError(
      400,
      'InvalidPlanningInput',
      'Planning expectedRevision must be a non-negative safe integer.',
    )
  }
  if (currentRevision !== expectedRevision) {
    throw new PlanningError(
      409,
      'PlanningRevisionConflict',
      'Planning changed. Reload and try again.',
    )
  }
}

async function requirePlanningActiveOwner(
  principal: WorkspacePrincipal,
  ownerMemberKey: unknown,
) {
  const memberKey = readPlanningIdentifier(ownerMemberKey, 'Planning owner member key')
  const owner = await workspaceDependencies.workspaceAccess.getActiveMember(principal.directoryId, memberKey)
  if (!owner) {
    throw new PlanningError(
      409,
      'PlanningOwnerInactive',
      'Planning owner must be an active Workspace member.',
    )
  }
  return owner
}

/**
 * Requires a cadence recipient to retain the role needed for its future action.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param snapshot - Current principal-filtered Planning snapshot.
 * @param target - Cadence target being configured.
 * @param memberKeyValue - Candidate update owner or escalation recipient.
 * @param minimumRole - Member for publishers and viewer for escalation recipients.
 */
async function requirePlanningCadenceRecipientTargetPermission(
  principal: WorkspacePrincipal,
  snapshot: PlanningSnapshot,
  target: PlanningUpdateTarget,
  memberKeyValue: unknown,
  minimumRole: Extract<ProjectRole, 'viewer' | 'member'>,
): Promise<WorkspaceMember> {
  const member = await requirePlanningActiveOwner(principal, memberKeyValue)
  const memberKey = member.memberKey.toLowerCase()
  let teamId: string | undefined
  let projectId: string | undefined
  if (target.type === 'project') {
    teamId = target.teamId
    projectId = target.projectId
  } else {
    const entity = snapshot.entities.find((candidate) =>
      candidate.id === target.entityId && candidate.type === 'initiative'
    )
    if (!entity) {
      throw new PlanningError(
        404,
        'PlanningUpdateTargetNotFound',
        'Planning Initiative update target was not found.',
      )
    }
    teamId = entity.teamId
    projectId = entity.projectId
  }

  if (!teamId && !projectId) {
    if (member.role === 'guest') {
      throw new PlanningError(
        409,
        'PlanningUpdateRecipientAccessDenied',
        'The update recipient must have business access to the Workspace target.',
      )
    }
    return member
  }
  if (await authenticationDependencies.cognito.isSystemAdmin(memberKey)) return member

  const enterpriseSnapshot = principal.enterpriseAuthorizationEvaluation?.snapshot ??
    await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
  const candidateGroups = await authenticationDependencies.cognito.getUserGroups(memberKey)
  const directoryPrincipal = resolveEnterpriseDirectoryPrincipal(
    enterpriseSnapshot,
    memberKey,
    candidateGroups,
  )
  const needsProjectScopeQualification =
    hasUnqualifiedEnterpriseProjectScope(directoryPrincipal.compatibleRoleAssignments) ||
    hasUnqualifiedEnterpriseProjectScope(directoryPrincipal.compatibleGroupMappings)
  const enterpriseDirectory = needsProjectScopeQualification
    ? await workspaceDependencies.projectDirectory.getProjectDirectory(
        principal.directoryId,
        'ja',
        true,
      )
    : undefined
  const qualifiedRoleAssignments = enterpriseDirectory
    ? qualifyEnterpriseProjectScopes(
        directoryPrincipal.compatibleRoleAssignments,
        enterpriseDirectory,
      )
    : directoryPrincipal.compatibleRoleAssignments
  const qualifiedGroupMappings = enterpriseDirectory
    ? qualifyEnterpriseProjectScopes(
        directoryPrincipal.compatibleGroupMappings,
        enterpriseDirectory,
      )
    : directoryPrincipal.compatibleGroupMappings
  const suppressLegacyWorkspaceRole = directoryPrincipal.directoryManaged ||
    qualifiedRoleAssignments.some((assignment) =>
      assignment.principalKind === 'member' && assignment.principalId === memberKey ||
      assignment.principalKind === 'directory-group' && (
        assignment.source === 'directory-mapping' ||
        directoryPrincipal.directoryGroupIds.includes(assignment.principalId)
      )
    ) || qualifiedGroupMappings.some((mapping) => mapping.enabled)
  if (suppressLegacyWorkspaceRole) {
    const candidateAccess = evaluateEnterpriseAccess({
      permission: minimumRole === 'member' ? 'work-items.write' : 'work-items.read',
      principal: {
        kind: 'member',
        principalId: memberKey,
        directoryGroupIds: directoryPrincipal.directoryGroupIds,
        directoryGroupMemberships: directoryPrincipal.directoryGroupMemberships,
        workspaceRole: member.role,
        includeWorkspaceRolePermissions: !suppressLegacyWorkspaceRole,
        ...(suppressLegacyWorkspaceRole
          ? { directPermissions: ['workspace.read' as const] }
          : {}),
        systemAdministrator: false,
      },
      assignments: qualifiedRoleAssignments,
      customRoles: enterpriseSnapshot.customRoles,
      groupMappings: qualifiedGroupMappings,
      resource: projectId
        ? {
            workspaceId: principal.directoryId,
            kind: 'project',
            targetId: projectId,
            parentTeamId: teamId,
          }
        : {
            workspaceId: principal.directoryId,
            kind: 'team',
            targetId: teamId,
          },
    })
    if (candidateAccess.allowed) return member
  }

  if (!suppressLegacyWorkspaceRole) {
    const [directory, accesses] = await Promise.all([
      workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja', true),
      workspaceDependencies.projectDirectory.getProjectAccessList(principal.directoryId, memberKey),
    ])
    if (projectId) {
      const resolvedTeamIds = teamId
        ? [teamId]
        : directory.teams
          .filter((team) => team.projects.some((project) => project.id === projectId))
          .map((team) => team.id)
      if (
        resolvedTeamIds.length === 1 &&
        accesses.some((access) =>
          planningProjectAccessMatchesQualifiedScope(
            access,
            directory,
            resolvedTeamIds[0]!,
            projectId,
          ) && projectAccessAllows(access, minimumRole)
        )
      ) {
        return member
      }
    } else if (teamId) {
      const team = directory.teams.find((candidate) => candidate.id === teamId)
      if (team?.projects.some((project) =>
        accesses.some((access) =>
          planningProjectAccessMatchesQualifiedScope(access, directory, teamId, project.id) &&
          projectAccessAllows(access, minimumRole)
        )
      )) {
        return member
      }
    }
  }
  throw new PlanningError(
    409,
    'PlanningUpdateRecipientAccessDenied',
    minimumRole === 'member'
      ? 'The update owner must be able to publish to the current target scope.'
      : 'The escalation recipient must be able to view the current target scope.',
  )
}

/**
 * Validates one qualified Work Item endpoint before it is used for authorization.
 *
 * @param value - Untrusted endpoint object from a Planning request.
 * @param label - Human-readable endpoint role.
 * @returns Canonical Team and Work Item identifiers.
 */
function readPlanningWorkItemDependencyEndpoint(
  value: unknown,
  label: string,
): WorkItemDependencyEndpoint {
  if (!isRecord(value) || Object.keys(value).some((key) =>
    key !== 'teamId' && key !== 'workItemId'
  )) {
    throw new PlanningError(
      400,
      'InvalidPlanningInput',
      `${label} Work Item endpoint is invalid.`,
    )
  }
  return {
    teamId: readPlanningIdentifier(value.teamId, `${label} Team ID`),
    workItemId: readPlanningIdentifier(value.workItemId, `${label} Work Item ID`),
  }
}

async function requirePlanningScopePermission(
  principal: WorkspacePrincipal,
  scope: Pick<PlanningEntity, 'teamId' | 'projectId'>,
  minimumRole: Extract<ProjectRole, 'member' | 'manager'>,
  allowWorkspaceScopeMember = false,
) {
  requireWorkspaceBusinessWrite(principal)
  const teamId = scope.teamId === undefined
    ? undefined
    : readPlanningIdentifier(scope.teamId, 'Team ID')
  const projectId = scope.projectId === undefined
    ? undefined
    : readPlanningIdentifier(scope.projectId, 'Project ID')
  if (teamId && !projectId && principal.enterprisePermissions !== undefined) {
    const resource = principal.enterpriseAuthorizationResource
    if (
      !principal.enterpriseRouteAuthorizedAtResource ||
      !resource ||
      (
        resource.kind !== 'workspace' &&
        !(resource.kind === 'team' && resource.targetId === teamId)
      )
    ) {
      throw new PlanningError(
        403,
        'ProjectAccessDenied',
        'Enterprise Team permission is required for this Planning scope.',
      )
    }
    const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
    if (!directory.teams.some((team) => team.id === teamId)) {
      throw new PlanningError(404, 'TeamNotFound', 'Planning Team was not found.')
    }
    return
  }
  const teamContext = teamId
    ? await requireTeamPermission(principal, teamId, minimumRole)
    : undefined
  if (projectId) {
    await requireProjectPermission(principal, projectId, minimumRole)
  }
  if (
    teamContext &&
    projectId &&
    !teamContext.team.projects.some((project) => project.id === projectId)
  ) {
    throw new PlanningError(
      409,
      'PlanningScopeMismatch',
      'Planning Team and Project scopes do not belong to the same hierarchy.',
    )
  }
  if (!teamId && !projectId && !principal.isSystemAdmin && !allowWorkspaceScopeMember) {
    requireWorkspaceAdministration(principal)
  }
}

async function requirePlanningEntityPermission(
  principal: WorkspacePrincipal,
  entities: readonly PlanningEntity[],
  entityId: unknown,
  minimumRole: Extract<ProjectRole, 'member' | 'manager'>,
  allowWorkspaceScopeMember = false,
) {
  const normalizedEntityId = readPlanningIdentifier(entityId, 'Planning entity ID')
  const entity = entities.find((candidate) => candidate.id === normalizedEntityId)
  if (!entity) {
    throw new PlanningError(404, 'PlanningEntityNotFound', 'Planning entity was not found.')
  }
  await requirePlanningScopePermission(
    principal,
    entity,
    minimumRole,
    allowWorkspaceScopeMember,
  )
  return entity
}

/**
 * Composes the feed reader with current directory and Planning authorization.
 * @param principal - Authenticated current Workspace principal.
 * @param view - Untrusted standard feed selector.
 * @param limit - Untrusted bounded response size.
 * @param locale - Active display language for current Project titles.
 * @param feedId - Optional member-owned saved definition identifier.
 * @param expandedSignals - Whether the client opted into expanded relevance reasons.
 * @returns The authorized live feed, without loading Work Items or history.
 */
async function readPlanningUpdateFeed(principal: WorkspacePrincipal, view?: string, limit?: string, locale: Locale = 'ja', feedId?: string, expandedSignals = false) {
  parseUpdateFeedQuery(view, limit)
  const definition = feedId === undefined ? undefined : (await workItemDependencies.savedUpdateFeeds.get(principal.directoryId, principal.userKey)).feeds.find((feed) => feed.id === feedId)
  if (feedId !== undefined && !definition) throw new PlanningError(404, 'SavedUpdateFeedNotFound', 'Saved feed was not found.')
  if (definition && view !== undefined && definition.view !== view) throw new PlanningError(409, 'SavedUpdateFeedsConflict', 'Saved feed changed. Reload before opening it.')
  const reader = await createPlanningUpdateFeedReader(principal, locale, expandedSignals)
  return withUpdateFeedReadState(workItemDependencies.updateFeedReadState, principal.directoryId, principal.userKey, await readUpdateFeed(reader, definition?.view ?? view, limit, definition?.filters))
}

/** Creates request-local target authorization shared by feed reads and read-state mutations. */
async function createPlanningUpdateFeedReader(principal: WorkspacePrincipal, locale: Locale = 'ja', expandedSignals = false): Promise<UpdateFeedReader> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, locale, true)
  let projectAccesses: Promise<ProjectAccessEntry[]> | undefined
  const readContext: TeamPermissionReadContext = {
    directory,
    readProjectAccesses: () => projectAccesses ??= principal.legacyProjectScopeAccesses
      ? Promise.resolve(principal.legacyProjectScopeAccesses)
      : getEffectiveProjectScopeAccessList(principal, directory),
  }
  /** Requires the current active directory hierarchy even for Workspace administrators. */
  const activeScope = (scope: Pick<PlanningEntity, 'teamId' | 'projectId'>): boolean => {
    if (!scope.teamId) return scope.projectId === undefined
    const team = directory.teams.find((candidate) => candidate.id === scope.teamId)
    return team !== undefined && (scope.projectId === undefined || team.projects.some((project) => project.id === scope.projectId))
  }
  const scopeAccess = new Map<string, Promise<boolean>>()
  /** Caches authorization of current hierarchy scopes without exposing inaccessible ancestry. */
  const readableScope = (scope: Pick<PlanningEntity, 'teamId' | 'projectId'>): Promise<boolean> => {
    const key = JSON.stringify([scope.teamId ?? null, scope.projectId ?? null])
    const existing = scopeAccess.get(key)
    if (existing) return existing
    const access = (async () => {
      if (!activeScope(scope)) return false
      try { await requirePlanningUpdateCapturedScopePermission(principal, scope, readContext); return true }
      catch (error) { if (isPlanningVisibilityAuthorizationError(error)) return false; throw error }
    })()
    scopeAccess.set(key, access)
    return access
  }
  return {
    memberKey: principal.userKey,
    expandedSignals,
    readSignals: async (targets, snapshot) => {
      const keys = targets.map(({ target }) => createPlanningUpdateCollaborationEntityKey(principal.directoryId, createPlanningUpdatePublicTargetKey(target)))
      const [accesses, subscribed, activities] = await Promise.all([
        principal.enterpriseLegacyProjectAccessSuppressed ? [] : principal.legacyProjectScopeAccesses ?? workspaceDependencies.projectDirectory.getProjectAccessList(principal.directoryId, principal.userKey),
        workItemDependencies.collaboration.getMemberSubscribedScopes(principal.userKey, keys).catch((error: unknown) => {
          if (error instanceof CollaborationError) throw new PlanningError(error.status, error.code, 'Feed watcher signals are unavailable.')
          throw error
        }),
        workItemDependencies.planning.getUpdateActivities(principal.directoryId),
      ])
      const watches = new Set(subscribed)
      const activityByTarget = new Map(activities.map((activity) => [createPlanningUpdatePublicTargetKey(activity.target), activity]))
      /** Counts explicit current Project grants, excluding broad Workspace/Team/admin visibility. */
      const isProjectMember = (scope: Pick<PlanningEntity, 'teamId' | 'projectId'> | undefined): boolean => {
        if (!scope?.teamId || !scope.projectId) return false
        const { teamId, projectId } = scope
        if (accesses.some((access) => access.role !== undefined && planningProjectAccessMatchesQualifiedScope(access, directory, teamId, projectId))) return true
        const evaluation = principal.enterpriseAuthorizationEvaluation
        if (!evaluation || evaluation.principal.kind === 'break-glass') return false
        return evaluateEnterpriseAccess({ permission: 'planning.read', principal: { ...evaluation.principal, systemAdministrator: false, includeWorkspaceRolePermissions: false, directPermissions: [] }, assignments: evaluation.assignments.filter((assignment) => assignment.scope.kind === 'project'), groupMappings: evaluation.groupMappings.filter((mapping) => mapping.scope.kind === 'project'), customRoles: evaluation.snapshot.customRoles, resource: { workspaceId: principal.directoryId, kind: 'project', targetId: scope.projectId, parentTeamId: scope.teamId }, projectScopeOwnerTeamId: resolveProjectAccessTeamId({ projectId: scope.projectId }, directory) }).allowed
      }
      return targets.map(({ target }, index) => {
        const scope = target.type === 'project' ? target : snapshot.entities.find((entity) => entity.id === target.entityId)
        return { target, projectMember: isProjectMember(scope), watching: watches.has(keys[index] ?? ''), activity: activityByTarget.get(createPlanningUpdatePublicTargetKey(target)) }
      })
    },
    filterScope: (summary, snapshot) => resolveUpdateFeedFilterScope(summary, snapshot, readableScope),
    describeTeam: (teamId) => directory.teams.find((team) => team.id === teamId)?.name ?? teamId,
    describeTarget: (summary, snapshot) => {
      const target = summary.target
      return target.type === 'initiative'
        ? snapshot.entities.find((entity) => entity.id === target.entityId)?.title ?? target.entityId
        : directory.teams.find((team) => team.id === target.teamId)?.projects.find((project) => project.id === target.projectId)?.name ?? target.projectId
    },
    readSavedFeeds: () => workItemDependencies.savedUpdateFeeds.get(principal.directoryId, principal.userKey),
    readSnapshot: () => workItemDependencies.planning.get(principal.directoryId, { workItems: [] }),
    authorizeTarget: async (summary, snapshot) => {
      const target = summary.target
      const scope = target.type === 'project' ? target : snapshot.entities.find((entity) => entity.id === target.entityId && entity.type === 'initiative' && !entity.archivedAt)
      if (!scope || !activeScope(scope)) return undefined
      try {
        await requirePlanningUpdateTargetPermission(principal, snapshot, target, 'viewer', readContext)
      } catch (error) {
        if (isPlanningVisibilityAuthorizationError(error)) return undefined
        throw error
      }
      if (!summary.latestUpdate) return summary
      const captured = summary.latestUpdate.capturedScope
      if (!captured || !activeScope(captured) || captured.teamId !== scope.teamId || captured.projectId !== scope.projectId) {
        return { ...summary, latestUpdate: undefined }
      }
      try {
        await requirePlanningUpdateCapturedScopePermission(principal, captured, readContext)
        return summary
      } catch (error) {
        if (isPlanningVisibilityAuthorizationError(error)) return { ...summary, latestUpdate: undefined }
        throw error
      }
    },
  }
}

/**
 * Rechecks the scope captured in an immutable update before returning it.
 *
 * Immutable context can outlive a current Initiative move or an ACL change.
 * Authorizing only the current target would therefore expose historical
 * milestones, dependencies, or evidence from the former scope.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param scope - Scope captured by the immutable update.
 * @param readContext - Optional request-local directory and ACL read cache.
 */
async function requirePlanningUpdateCapturedScopePermission(
  principal: WorkspacePrincipal,
  scope: { teamId?: string; projectId?: string },
  readContext?: TeamPermissionReadContext,
): Promise<void> {
  if (scope.projectId !== undefined) {
    if (scope.teamId === undefined) {
      throw new PlanningError(
        403,
        'PlanningUpdateScopeAccessDenied',
        'The immutable update scope is incomplete.',
      )
    }
    await requirePlanningUpdateProjectPermission(
      principal,
      scope.teamId,
      scope.projectId,
      'viewer',
      readContext,
    )
    return
  }
  if (scope.teamId !== undefined) {
    await requirePlanningUpdateTeamPermission(principal, scope.teamId, 'viewer', readContext)
    return
  }
  requirePlanningWorkspaceScopeRead(principal)
}

/**
 * Removes immutable updates whose captured scope is no longer readable.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param updates - Immutable updates returned by the canonical history store.
 * @param authorizationCache - Per-request cache for captured-scope authorization results.
 * @returns Only updates whose captured scope remains visible.
 */
async function filterPlanningUpdatesByCapturedScope(
  principal: WorkspacePrincipal,
  updates: readonly PlanningUpdate[],
  authorizationCache: Map<string, Promise<void>>,
): Promise<PlanningUpdate[]> {
  const visible: PlanningUpdate[] = []
  for (const update of updates) {
    const scope = update.contextSnapshot.scope
    const scopeKey = JSON.stringify([scope.teamId ?? null, scope.projectId ?? null])
    let authorization = authorizationCache.get(scopeKey)
    if (!authorization) {
      authorization = requirePlanningUpdateCapturedScopePermission(principal, scope)
      authorizationCache.set(scopeKey, authorization)
    }
    try {
      await authorization
      visible.push(update)
    } catch (error) {
      if (isPlanningVisibilityAuthorizationError(error)) continue
      throw error
    }
  }
  return visible
}

/** Returns whether an authorization failure should hide one historical row. */
function isPlanningVisibilityAuthorizationError(error: unknown): boolean {
  return isRecord(error) &&
    typeof error.status === 'number' &&
    (error.status === 403 || error.status === 404)
}

/**
 * Finds one bounded update target summary by its qualified identity.
 *
 * @param snapshot - Current Planning snapshot.
 * @param target - Target to locate.
 * @returns Matching summary when configured or historically known.
 */
function findPlanningUpdateTargetSummary(
  snapshot: PlanningSnapshot,
  target: PlanningUpdateTarget,
) {
  return snapshot.updateTargets.find((candidate) =>
    candidate.target.type === target.type && (
      target.type === 'initiative'
        ? candidate.target.type === 'initiative' &&
          candidate.target.entityId === target.entityId
        : candidate.target.type === 'project' &&
          candidate.target.teamId === target.teamId &&
          candidate.target.projectId === target.projectId
    )
  )
}

/**
 * Validates external evidence references before an immutable update is committed.
 *
 * File references are resolved through the File Proofing read adapter and guarded by a
 * transaction condition against deletion. Unsupported external references are rejected rather
 * than accepting an opaque ID and HTTPS URL that cannot be proven to exist in this Workspace.
 *
 * @param principal - Authenticated publisher whose file visibility is being evaluated.
 * @param snapshot - Unfiltered Planning snapshot used to resolve the target envelope.
 * @param visibleSnapshot - Publisher-visible Work Item projection used to bound file scopes.
 * @param input - Candidate publish request containing external evidence references.
 * @returns File metadata condition checks to append to the publish transaction.
 */
async function createPlanningUpdateEvidenceConditionChecks(
  principal: WorkspacePrincipal,
  snapshot: PlanningSnapshot,
  visibleSnapshot: PlanningSnapshot,
  input: PublishPlanningUpdateInput,
): Promise<PlanningCallerAuthorizationConditionCheck[]> {
  const candidateEvidence = Array.isArray(input.evidence) ? input.evidence : []
  const fileIds = new Set<string>()
  for (const candidate of candidateEvidence) {
    if (!isRecord(candidate) || candidate.type !== 'file' || typeof candidate.fileId !== 'string') {
      continue
    }
    const fileId = candidate.fileId.trim()
    if (fileId) fileIds.add(fileId)
  }
  if (fileIds.size === 0) return []

  const actor: FileProofingActor = {
    memberKey: principal.userKey,
    guest: principal.workspaceRole === 'guest',
    canWrite: false,
    canManage: false,
  }
  const scopes = createPlanningUpdateEvidenceScopes(
    principal.directoryId,
    snapshot,
    visibleSnapshot,
    input.target,
  )
  const scopesByKey = new Map(scopes.map((scope) => [createFileProofingScopeKey(scope), scope]))
  try {
    const lookups = await Promise.all([...fileIds].map(async (fileId) => ({
      fileId,
      lookup: await workItemDependencies.fileProofing.findFileById(
        principal.directoryId,
        actor,
        fileId,
      ),
    })))
    for (const { fileId, lookup } of lookups) {
      if (!lookup?.file.capabilities.canDownload) continue
      const scope = scopesByKey.get(createFileProofingScopeKey(lookup.scope))
      if (scope) {
        scopesByKey.set(fileId, scope)
      }
    }
  } catch (error) {
    if (error instanceof PlanningError) throw error
    throw new PlanningError(
      503,
      'PlanningUpdateEvidenceUnavailable',
      'File evidence visibility could not be verified.',
    )
  }

  const tableName = getEnv('FILE_PROOFING_TABLE_NAME')?.trim() ?? 'mukuroji-file-proofing'
  return [...fileIds].map((fileId) => {
    const scope = scopesByKey.get(fileId)
    if (!scope) {
      throw new PlanningError(
        400,
        'PlanningUpdateEvidenceInvalid',
        `Evidence File "${fileId}" is unavailable for this update target.`,
      )
    }
    return createPlanningUpdateFileEvidenceConditionCheck(
      tableName,
      scope,
      fileId,
      actor.guest,
    )
  })
}

/**
 * Builds all File Proofing scopes that can be part of one update target's visibility envelope.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param snapshot - Unfiltered Planning snapshot containing the target entity.
 * @param visibleSnapshot - Publisher-visible Work Item projection.
 * @param target - Project or Initiative update target.
 * @returns Deduplicated Project and Work Item file scopes inside the target envelope.
 */
function createPlanningUpdateEvidenceScopes(
  workspaceId: string,
  snapshot: PlanningSnapshot,
  visibleSnapshot: PlanningSnapshot,
  target: PlanningUpdateTarget,
): FileProofingScope[] {
  const envelope = target.type === 'project'
    ? { teamId: target.teamId, projectId: target.projectId }
    : (() => {
        const entity = snapshot.entities.find((candidate) => candidate.id === target.entityId)
        return {
          teamId: entity?.teamId,
          projectId: entity?.projectId,
        }
      })()
  const scopes: FileProofingScope[] = []
  const seen = new Set<string>()
  const addScope = (scope: FileProofingScope) => {
    const key = createFileProofingScopeKey(scope)
    if (seen.has(key)) return
    seen.add(key)
    scopes.push(scope)
  }

  if (envelope.teamId !== undefined && envelope.projectId !== undefined) {
    addScope({
      workspaceId,
      teamId: envelope.teamId,
      kind: 'project',
      projectId: envelope.projectId,
    })
  }
  for (const workItem of visibleSnapshot.workItems) {
    if (!isPlanningUpdateEvidenceScopeVisible(
      envelope,
      workItem.teamId,
      workItem.projectId,
    )) {
      continue
    }
    addScope({
      workspaceId,
      teamId: workItem.teamId,
      kind: 'work-item',
      issueId: workItem.id,
      ...(workItem.projectId === undefined ? {} : { projectId: workItem.projectId }),
    })
  }
  return scopes
}

/** Checks whether one Work Item scope is inside a Planning update envelope. */
function isPlanningUpdateEvidenceScopeVisible(
  envelope: { teamId?: string; projectId?: string },
  teamId: string,
  projectId: string | undefined,
): boolean {
  if (envelope.projectId !== undefined) {
    return teamId === envelope.teamId && projectId === envelope.projectId
  }
  if (envelope.teamId !== undefined) {
    return teamId === envelope.teamId && projectId === undefined
  }
  return true
}

/** Creates a commit-time File Proofing guard for one visible evidence file. */
function createPlanningUpdateFileEvidenceConditionCheck(
  tableName: string,
  scope: FileProofingScope,
  fileId: string,
  guest: boolean,
): PlanningCallerAuthorizationConditionCheck {
  const expressionAttributeNames: Record<string, string> = {
    '#entryType': 'entryType',
    '#workspaceId': 'workspaceId',
    '#fileId': 'fileId',
    '#deletedAt': 'deletedAt',
  }
  const expressionAttributeValues: Record<string, string | boolean> = {
    ':entryType': 'file',
    ':workspaceId': scope.workspaceId,
    ':fileId': fileId,
  }
  let conditionExpression =
    '#entryType = :entryType AND #workspaceId = :workspaceId AND ' +
    '#fileId = :fileId AND attribute_not_exists(#deletedAt)'
  if (guest) {
    expressionAttributeNames['#guestAccess'] = 'guestAccess'
    expressionAttributeValues[':guestAccess'] = true
    conditionExpression += ' AND #guestAccess = :guestAccess'
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        scopeKey: createFileProofingScopeKey(scope),
        recordKey: `FILE#${fileId}`,
      },
      ConditionExpression: conditionExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    },
  }
}

async function requirePlanningLinkEntityPermissions(
  principal: WorkspacePrincipal,
  entities: readonly PlanningEntity[],
  link: Pick<PlanningWorkItemLinkInput, 'cycleId' | 'milestoneId' | 'goalIds'>,
) {
  const goalIds: unknown = link.goalIds
  if (!Array.isArray(goalIds)) {
    throw new PlanningError(400, 'InvalidPlanningInput', 'Goal IDs must be an array.')
  }
  const entityIds = new Set([
    ...(link.cycleId === undefined
      ? []
      : [readPlanningIdentifier(link.cycleId, 'Cycle ID')]),
    ...(link.milestoneId === undefined
      ? []
      : [readPlanningIdentifier(link.milestoneId, 'Milestone ID')]),
    ...goalIds.map((goalId) => readPlanningIdentifier(goalId, 'Goal ID')),
  ])
  await Promise.all(
    [...entityIds].map((entityId) =>
      requirePlanningEntityPermission(principal, entities, entityId, 'member', true)
    ),
  )
}

function collectActivePlanningDescendants(
  entities: readonly PlanningEntity[],
  rootEntityId: string,
) {
  const descendants: PlanningEntity[] = []
  const childrenByParent = new Map<string, PlanningEntity[]>()
  for (const entity of entities) {
    if (!entity.parentId) continue
    const children = childrenByParent.get(entity.parentId) ?? []
    children.push(entity)
    childrenByParent.set(entity.parentId, children)
  }
  const pending = [rootEntityId]
  const visited = new Set<string>(pending)
  while (pending.length > 0) {
    const parentId = pending.pop()!
    for (const entity of childrenByParent.get(parentId) ?? []) {
      if (visited.has(entity.id)) continue
      visited.add(entity.id)
      pending.push(entity.id)
      if (!entity.archivedAt) descendants.push(entity)
    }
  }
  return descendants
}

/**
 * Rejects a Team / Project scope move that would leave an Initiative cadence owned by its old scope.
 *
 * @param snapshot - Complete Planning snapshot read before the move.
 * @param entityId - Root entity being moved.
 * @param input - Requested hierarchy and scope destination.
 */
function requirePlanningMoveDoesNotInvalidateUpdateCadence(
  snapshot: PlanningSnapshot,
  entityId: string,
  input: MovePlanningEntityInput,
): void {
  const current = snapshot.entities.find((entity) => entity.id === entityId)
  if (!current) return

  const movedEntities = [
    current,
    ...collectActivePlanningDescendants(snapshot.entities, current.id),
  ]
  const movedEntityIdsWithScopeChange = new Set(
    movedEntities
      .filter((entity) => entity.teamId !== input.teamId || entity.projectId !== input.projectId)
      .map((entity) => entity.id),
  )
  const cadenceTarget = snapshot.updateTargets.find((updateTarget) =>
    updateTarget.target.type === 'initiative' &&
    updateTarget.cadence !== undefined &&
    updateTarget.archivedAt === undefined &&
    movedEntityIdsWithScopeChange.has(updateTarget.target.entityId)
  )
  if (!cadenceTarget) return

  throw new PlanningError(
    409,
    'PlanningMoveRequiresCadenceReconfiguration',
    'Reconfigure or remove the active Planning update cadence before changing its Team or Project scope.',
  )
}

/**
 * Reads the complete canonical Work Item projection used for an immutable Planning publish.
 *
 * The caller's visible projection is sufficient for route authorization, but it is not a
 * canonical source for Workspace-scoped initiative progress. This internal service-authoritative
 * read keeps hidden Work Items out of the public response while making the captured context
 * independent of the publisher's project ACL.
 *
 * @param principal - Authenticated Workspace principal whose directory is being read.
 * @param scope - Optional target envelope. Workspace-scoped targets omit this value.
 * @returns Complete Work Item summaries bounded by the aggregate read limits.
 */
async function readCanonicalPlanningWorkItemState(
  principal: ProjectPrincipal,
  scope?: PlanningWorkItemReadScope,
): Promise<PlanningWorkItemState> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
    true,
  )
  if (scope?.projectId !== undefined && scope.teamId === undefined) {
    throw new PlanningError(
      409,
      'PlanningUpdateScopeInvalid',
      'A Project-scoped Planning update requires its owning Team scope.',
    )
  }
  const selectedTeams = scope?.teamId === undefined
    ? directory.teams
    : directory.teams.filter((team) => team.id === scope.teamId)
  if (scope?.teamId === undefined && selectedTeams.length > WORK_ITEMS_TEAM_READ_LIMIT) {
    throw createWorkItemListLimitExceededError(
      `Workspace has more than ${WORK_ITEMS_TEAM_READ_LIMIT} Teams for a Planning publish.`,
    )
  }
  const servicePrincipal = { ...principal, isSystemAdmin: true }
  const workItemsByKey = new Map<string, TeamIssueResponseItem>()
  for (const team of selectedTeams) {
    const response = await readCanonicalTeamIssuesForAggregate(
      principal.directoryId,
      { team, directory } satisfies TeamPermissionContext,
      servicePrincipal,
    )
    for (const workItem of response.issues) {
      if (scope?.projectId !== undefined && workItem.assignedProjectId !== scope.projectId) {
        continue
      }
      workItemsByKey.set(`${workItem.teamId}\0${workItem.id}`, workItem)
      if (workItemsByKey.size > PLANNING_CANONICAL_WORK_ITEM_LIMIT) {
        throw createWorkItemListLimitExceededError(
          `Planning publish spans more than ${PLANNING_CANONICAL_WORK_ITEM_LIMIT} Work Items.`,
        )
      }
    }
  }
  return {
    workItems: [...workItemsByKey.values()].map((workItem) => ({
      id: workItem.id,
      revision: workItem.revision,
      teamId: workItem.teamId,
      title: workItem.title,
      ...(workItem.assignedProjectId
        ? { projectId: workItem.assignedProjectId }
        : {}),
      statusCategory: workItem.statusCategory,
      dueDate: workItem.dueDate,
      schedule: workItem.schedule,
    } satisfies PlanningWorkItemSummary)),
  }
}

/** Mutation represented by one durable Planning Work Item dependency receipt. */
type PlanningWorkItemDependencyReceiptOperation = 'create' | 'update' | 'delete'

/** Stable schema discriminator for compact Planning Work Item dependency receipts. */
const PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_SCHEMA =
  'planning-work-item-dependency-mutation'

/** Current compact Planning Work Item dependency receipt version. */
const PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_VERSION = 1

/**
 * Validates the required request key for one Planning Work Item dependency mutation.
 *
 * @param value - Raw `Idempotency-Key` header value.
 * @returns Trimmed key safe for the durable reservation port.
 */
function readRequiredPlanningWorkItemDependencyIdempotencyKey(
  value: string | undefined,
): string {
  const key = value?.trim() ?? ''
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new PlanningError(
      400,
      'InvalidPlanningWorkItemDependencyIdempotencyKey',
      'Idempotency-Key must contain 1 to 256 characters without control characters.',
    )
  }
  return key
}

/**
 * Creates the user-scoped reservation identity for one dependency mutation.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param idempotencyKey - Validated caller-provided request key.
 * @param method - Canonical HTTP method.
 * @param path - Canonical API path, including the dependency ID when present.
 * @param body - Parsed JSON body bound to the reservation.
 * @returns Reservation request bound to the user, method, path, and stable body digest.
 */
function createPlanningWorkItemDependencyReservationRequest(
  principal: WorkspacePrincipal,
  idempotencyKey: string,
  method: string,
  path: string,
  body: unknown,
): ReserveIdempotencyRequest {
  return {
    workspaceId: createWorkItemScheduleIdempotencyWorkspaceId(principal.directoryId),
    credentialId: createWorkItemScheduleIdempotencyUserId(
      principal.directoryId,
      principal.actorId,
    ),
    idempotencyKey,
    requestFingerprint: createPlanningWorkItemDependencyFingerprint(method, path, body),
  }
}

/**
 * Binds one dependency mutation to its exact method, canonical path, and stable JSON body.
 *
 * @param method - Incoming HTTP method.
 * @param path - Canonical API path.
 * @param body - Parsed request body.
 * @returns Stable SHA-256 request fingerprint.
 */
function createPlanningWorkItemDependencyFingerprint(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${stableDigestStringify(body)}`)
    .digest('hex')
}

/**
 * Reserves one dependency mutation and maps persistence failures to stable Planning errors.
 *
 * @param request - User-scoped reservation identity.
 * @returns Reservation, in-progress, or completed replay decision.
 */
async function reservePlanningWorkItemDependencyMutation(request: ReserveIdempotencyRequest) {
  try {
    return await developerPlatformDependencies.idempotency.reserveIdempotency(request)
  } catch (error) {
    if (error instanceof DeveloperPlatformError && error.code === 'IdempotencyKeyConflict') {
      throw new PlanningError(
        409,
        'PlanningWorkItemDependencyIdempotencyConflict',
        'Idempotency-Key was already used for a different Work Item dependency mutation.',
      )
    }
    throw planningWorkItemDependencyIdempotencyUnavailable()
  }
}

/** Creates the stable failure used when dependency idempotency persistence is unavailable. */
function planningWorkItemDependencyIdempotencyUnavailable(): PlanningError {
  return new PlanningError(
    503,
    'PlanningWorkItemDependencyIdempotencyUnavailable',
    'Work Item dependency idempotency is unavailable.',
  )
}

/**
 * Releases an incomplete dependency reservation without masking the route's original failure.
 *
 * @param request - Caller-owned incomplete reservation.
 */
async function releasePlanningWorkItemDependencyReservation(
  request: ReleaseIdempotencyRequest,
): Promise<void> {
  await developerPlatformDependencies.idempotency
    .releaseIdempotency(request)
    .catch(() => undefined)
}

/** Stable operation stored in one Planning update annotation mutation receipt. */
type PlanningUpdateAnnotationReceiptOperation =
  | 'comment-create'
  | 'reaction-add'
  | 'reaction-remove'

/** Canonical request identity retained by a durable Planning publish receipt. */
type PlanningUpdatePublishReceiptExpectation = {
  /** Project or Initiative that owns the immutable update. */
  target: PlanningUpdateTarget
  /** Client-generated target-local update ID. */
  id: string
  /** Authenticated member key that published the update. */
  authorMemberKey: string
  /** Exact request body bound to the idempotency fingerprint. */
  request: PublishPlanningUpdateInput
}

/** Canonical request identity retained by a durable Planning cadence receipt. */
type PlanningUpdateCadenceReceiptExpectation = {
  /** Project or Initiative whose recurring cadence changes. */
  target: PlanningUpdateTarget
  /** Exact request body bound to the idempotency fingerprint. */
  request: ConfigurePlanningUpdateCadenceInput
}

/** Stable schema discriminator for Planning publish receipts. */
const PLANNING_UPDATE_PUBLISH_RECEIPT_SCHEMA = 'planning-update-publish'

/** Current Planning publish receipt version. */
const PLANNING_UPDATE_PUBLISH_RECEIPT_VERSION = 1

/** Stable schema discriminator for Planning cadence receipts. */
const PLANNING_UPDATE_CADENCE_RECEIPT_SCHEMA = 'planning-update-cadence'

/** Current Planning cadence receipt version. */
const PLANNING_UPDATE_CADENCE_RECEIPT_VERSION = 1

/** Target and actor fields shared by every Planning update annotation receipt. */
type PlanningUpdateAnnotationReceiptBase = {
  /** Receipt operation discriminator. */
  operation: PlanningUpdateAnnotationReceiptOperation
  /** Project or Initiative that owns the immutable update. */
  target: PlanningUpdateTarget
  /** Target-local immutable update version. */
  updateVersion: number
  /** Authenticated Workspace member performing the mutation. */
  memberKey: string
}

/** Canonical request identity bound to one Planning update annotation receipt. */
type PlanningUpdateAnnotationReceiptExpectation = PlanningUpdateAnnotationReceiptBase & (
  | {
      /** Append-only comment operation. */
      operation: 'comment-create'
      /** Client-generated comment identifier. */
      id: string
      /** Normalized comment body. */
      body: string
    }
  | {
      /** Current-member reaction operation. */
      operation: 'reaction-add' | 'reaction-remove'
      /** Normalized reaction token. */
      emoji: string
    }
)

/** Strictly decoded successful Planning update annotation replay. */
type PlanningUpdateAnnotationReplay =
  | {
      /** Append-only comment operation. */
      operation: 'comment-create'
      /** Original successful response status. */
      status: 201
      /** Original comment response envelope. */
      body: { comment: PlanningUpdateComment }
    }
  | {
      /** Current-member reaction addition. */
      operation: 'reaction-add'
      /** Original successful response status. */
      status: 201
      /** Original reaction response envelope. */
      body: { reaction: PlanningUpdateReaction }
    }
  | {
      /** Current-member reaction removal. */
      operation: 'reaction-remove'
      /** Original successful response status. */
      status: 204
      /** No-content response body. */
      body: null
    }

/** Stable schema discriminator for Planning update annotation receipts. */
const PLANNING_UPDATE_ANNOTATION_RECEIPT_SCHEMA = 'planning-update-annotation-mutation'

/** Current Planning update annotation receipt version. */
const PLANNING_UPDATE_ANNOTATION_RECEIPT_VERSION = 1

/**
 * Validates the caller-provided idempotency key required by annotation mutations.
 *
 * @param value - Raw `Idempotency-Key` header value.
 * @returns A bounded key safe for the durable reservation port.
 */
function readRequiredPlanningUpdateAnnotationIdempotencyKey(
  value: string | undefined,
): string {
  const key = value?.trim() ?? ''
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new PlanningError(
      400,
      'InvalidPlanningUpdateAnnotationIdempotencyKey',
      'Idempotency-Key must contain 1 to 256 characters without control characters.',
    )
  }
  return key
}

/**
 * Creates a user-scoped durable reservation for one annotation request.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param idempotencyKey - Validated caller key.
 * @param method - Canonical HTTP method.
 * @param path - Canonical annotation path without query aliases.
 * @param body - Normalized request identity including its qualified target.
 * @returns Developer Platform reservation request bound to method, path, and body.
 */
function createPlanningUpdateAnnotationReservationRequest(
  principal: WorkspacePrincipal,
  idempotencyKey: string,
  method: string,
  path: string,
  body: PlanningUpdateAnnotationReceiptExpectation,
): ReserveIdempotencyRequest {
  return {
    workspaceId: createWorkItemScheduleIdempotencyWorkspaceId(principal.directoryId),
    credentialId: createWorkItemScheduleIdempotencyUserId(
      principal.directoryId,
      principal.actorId,
    ),
    idempotencyKey,
    requestFingerprint: createHash('sha256')
      .update(`${method.toUpperCase()}\n${path}\n${stableDigestStringify(body)}`)
      .digest('hex'),
  }
}

/**
 * Reserves one Planning update annotation mutation.
 *
 * @param request - User-scoped request identity.
 * @returns Reservation, in-progress, or completed replay decision.
 */
async function reservePlanningUpdateAnnotationMutation(request: ReserveIdempotencyRequest) {
  try {
    return await developerPlatformDependencies.idempotency.reserveIdempotency(request)
  } catch (error) {
    if (error instanceof DeveloperPlatformError && error.code === 'IdempotencyKeyConflict') {
      throw new PlanningError(
        409,
        'PlanningUpdateAnnotationIdempotencyConflict',
        'Idempotency-Key was already used for a different Planning update annotation mutation.',
      )
    }
    throw planningUpdateAnnotationIdempotencyUnavailable()
  }
}

/** Creates the stable failure returned when annotation receipt persistence is unavailable. */
function planningUpdateAnnotationIdempotencyUnavailable(): PlanningError {
  return new PlanningError(
    503,
    'PlanningUpdateAnnotationIdempotencyUnavailable',
    'Planning update annotation idempotency is unavailable.',
  )
}

/**
 * Releases an uncommitted annotation reservation without masking the original route error.
 *
 * @param request - Caller-owned incomplete reservation.
 */
async function releasePlanningUpdateAnnotationReservation(
  request: ReleaseIdempotencyRequest,
): Promise<void> {
  await developerPlatformDependencies.idempotency
    .releaseIdempotency(request)
    .catch(() => undefined)
}

/** Query and path values shared by Planning update annotation mutations. */
type PlanningUpdateAnnotationMutationInput = {
  /** Requested target discriminator. */
  targetType: string | undefined
  /** Qualified Project Team identifier, when applicable. */
  teamId: string | undefined
  /** Qualified Project identifier, when applicable. */
  projectId: string | undefined
  /** Initiative identifier, when applicable. */
  entityId: string | undefined
  /** Raw immutable update version path parameter. */
  updateVersion: string
  /** Canonical route path used for the idempotency fingerprint. */
  path: string
}

/** Callbacks that retain the operation-specific part of an annotation mutation. */
type PlanningUpdateAnnotationMutationCallbacks<Result> = {
  /** Builds the receipt identity after target and version validation. */
  createExpectation: (
    target: PlanningUpdateTarget,
    updateVersion: number,
  ) => PlanningUpdateAnnotationReceiptExpectation
  /** Executes the domain mutation with its durable receipt transaction. */
  mutate: (input: {
    target: PlanningUpdateTarget
    updateVersion: number
    transaction: PlanningMutationTransaction<PlanningUpdateAnnotationTransactionResult>
    authorizationConditionChecks: readonly PlanningCallerAuthorizationConditionCheck[]
  }) => Promise<Result>
  /** Creates the response for a completed durable mutation. */
  success: (context: Context, result: Result) => Response
  /** Creates the response for a durable replay. */
  replay: (context: Context, replay: PlanningUpdateAnnotationReplay) => Response
}

/**
 * Executes the shared authorization and idempotency flow for one annotation mutation.
 *
 * Target/version parsing, captured-scope authorization, durable reservation, replay, and
 * failed-mutation cleanup intentionally live here so comment and reaction routes cannot drift.
 *
 * @param context - Hono request context used to create the response and replay header.
 * @param principal - Authenticated Workspace principal.
 * @param snapshot - Current Planning snapshot used for target authorization.
 * @param input - Raw target/version/path values from the route.
 * @param callbacks - Operation-specific receipt, domain, and response callbacks.
 * @returns The operation-specific HTTP response.
 */
async function executePlanningUpdateAnnotationMutation<Result>(
  context: Context,
  principal: WorkspacePrincipal,
  snapshot: PlanningSnapshot,
  input: PlanningUpdateAnnotationMutationInput,
  callbacks: PlanningUpdateAnnotationMutationCallbacks<Result>,
): Promise<Response> {
  let reservationToRelease: ReleaseIdempotencyRequest | undefined
  let mutationCommitted = false
  try {
    requireWorkspaceBusinessWrite(principal)
    const idempotencyKey = readRequiredPlanningUpdateAnnotationIdempotencyKey(
      context.req.header('Idempotency-Key'),
    )
    const target = readPlanningUpdateTargetQuery(
      input.targetType,
      input.teamId,
      input.projectId,
      input.entityId,
    )
    const updateVersion = readPlanningUpdateVersion(input.updateVersion)
    await requirePlanningUpdateTargetPermission(
      principal,
      filterPlanningSnapshotForPrincipal(principal, snapshot),
      target,
      'member',
    )
    await requirePlanningUpdateVersionCapturedScopePermission(
      principal.directoryId,
      principal,
      target,
      updateVersion,
    )
    const receiptExpectation = callbacks.createExpectation(target, updateVersion)
    const reservationRequest = createPlanningUpdateAnnotationReservationRequest(
      principal,
      idempotencyKey,
      context.req.method,
      input.path,
      receiptExpectation,
    )
    const reservation = await reservePlanningUpdateAnnotationMutation(reservationRequest)
    if (reservation.status === 'in-progress') {
      throw new PlanningError(
        409,
        'PlanningUpdateAnnotationIdempotencyInProgress',
        'The same Planning update annotation mutation is still in progress.',
      )
    }
    if (reservation.status === 'replay') {
      const replay = readStoredPlanningUpdateAnnotationMutationReceipt(
        reservation.response,
        reservationRequest.workspaceId,
        receiptExpectation,
      )
      return callbacks.replay(context, replay)
    }
    reservationToRelease = { ...reservationRequest, reservationId: reservation.reservationId }
    const transaction = createPlanningUpdateAnnotationIdempotencyTransaction(
      reservationRequest.workspaceId,
      {
        credentialId: reservationRequest.credentialId,
        idempotencyKey,
        requestFingerprint: reservationRequest.requestFingerprint,
        reservationId: reservation.reservationId,
      },
      receiptExpectation,
    )
    if (!transaction) throw planningUpdateAnnotationIdempotencyUnavailable()
    const result = await callbacks.mutate({
      target,
      updateVersion,
      transaction,
      authorizationConditionChecks: [
        ...createPlanningCallerAuthorizationConditionChecks(principal),
        createPlanningRevisionConditionCheck(principal.directoryId, snapshot.revision),
      ],
    })
    mutationCommitted = true
    return callbacks.success(context, result)
  } catch (error) {
    if (reservationToRelease && !mutationCommitted) {
      await releasePlanningUpdateAnnotationReservation(reservationToRelease)
    }
    throw error
  }
}

/** Validates the required idempotency key for one Planning cadence mutation. */
function readRequiredPlanningUpdateCadenceIdempotencyKey(value: string): string {
  const key = value.trim()
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new PlanningError(
      400,
      'InvalidPlanningUpdateCadenceIdempotencyKey',
      'Idempotency-Key must contain 1 to 256 characters without control characters.',
    )
  }
  return key
}

/** Creates the user-scoped reservation identity for one cadence mutation. */
function createPlanningUpdateCadenceReservationRequest(
  principal: WorkspacePrincipal,
  idempotencyKey: string,
  method: string,
  path: string,
  expectation: PlanningUpdateCadenceReceiptExpectation,
): ReserveIdempotencyRequest {
  return {
    workspaceId: createWorkItemScheduleIdempotencyWorkspaceId(principal.directoryId),
    credentialId: createWorkItemScheduleIdempotencyUserId(
      principal.directoryId,
      principal.actorId,
    ),
    idempotencyKey,
    requestFingerprint: createHash('sha256')
      .update(`${method.toUpperCase()}\n${path}\n${stableDigestStringify(expectation.request)}`)
      .digest('hex'),
  }
}

/** Reserves one Planning cadence mutation and maps storage failures to a stable API error. */
async function reservePlanningUpdateCadenceMutation(request: ReserveIdempotencyRequest) {
  try {
    return await developerPlatformDependencies.idempotency.reserveIdempotency(request)
  } catch (error) {
    if (error instanceof DeveloperPlatformError && error.code === 'IdempotencyKeyConflict') {
      throw new PlanningError(
        409,
        'PlanningUpdateCadenceIdempotencyConflict',
        'Idempotency-Key was already used for a different Planning update cadence mutation.',
      )
    }
    throw planningUpdateCadenceIdempotencyUnavailable()
  }
}

/** Creates the stable failure returned when cadence receipt persistence is unavailable. */
function planningUpdateCadenceIdempotencyUnavailable(): PlanningError {
  return new PlanningError(
    503,
    'PlanningUpdateCadenceIdempotencyUnavailable',
    'Planning update cadence idempotency is unavailable.',
  )
}

/** Releases an uncommitted Planning cadence reservation without masking the route error. */
async function releasePlanningUpdateCadenceReservation(
  request: ReleaseIdempotencyRequest,
): Promise<void> {
  await developerPlatformDependencies.idempotency.releaseIdempotency(request).catch(() => undefined)
}

/** Creates a durable cadence receipt contribution for the Planning transaction. */
function createPlanningUpdateCadenceIdempotencyTransaction(
  workspaceId: string,
  token: IdempotencyMutationToken,
  expectation: PlanningUpdateCadenceReceiptExpectation,
): PlanningMutationTransaction<PlanningUpdateCadenceTransactionResult> | undefined {
  const prepare = developerPlatformDependencies.transactions
    .prepareIdempotencyCompletionTransactWrite
  if (!prepare) return undefined
  return {
    async prepare(result) {
      return prepare.call(developerPlatformDependencies.transactions, {
        workspaceId,
        credentialId: token.credentialId,
        idempotencyKey: token.idempotencyKey,
        requestFingerprint: token.requestFingerprint,
        reservationId: token.reservationId,
        response: createPlanningUpdateCadenceReceiptResponse(workspaceId, expectation, result),
      })
    },
  }
}

/** Creates the compact durable payload used to replay a cadence mutation. */
function createPlanningUpdateCadenceReceiptResponse(
  workspaceId: string,
  expectation: PlanningUpdateCadenceReceiptExpectation,
  result: PlanningUpdateCadenceTransactionResult,
) {
  if (
    result.kind !== 'cadence' ||
    !planningUpdateTargetsEqual(result.updateTarget.target, expectation.target)
  ) {
    throw planningUpdateCadenceIdempotencyUnavailable()
  }
  return {
    status: 200 as const,
    body: {
      schema: PLANNING_UPDATE_CADENCE_RECEIPT_SCHEMA,
      version: PLANNING_UPDATE_CADENCE_RECEIPT_VERSION,
      workspaceId,
      status: 200,
      payload: {
        target: structuredClone(result.updateTarget.target),
        revision: result.revision,
        updateTarget: structuredClone(result.updateTarget),
      },
    },
  }
}

/** Decoded identity stored in a successful Planning cadence receipt. */
type PlanningUpdateCadenceReplay = {
  /** Project or Initiative target. */
  target: PlanningUpdateTarget
  /** Planning revision committed by the cadence mutation. */
  revision: number
  /** Target summary committed by the cadence mutation. */
  updateTarget: PlanningUpdateTargetSummary
}

/** Strictly decodes one completed Planning cadence receipt. */
function readStoredPlanningUpdateCadenceMutationReceipt(
  value: unknown,
  workspaceId: string,
  expectation: PlanningUpdateCadenceReceiptExpectation,
): PlanningUpdateCadenceReplay {
  if (!isRecord(value) || value.status !== 200 || !isRecord(value.body)) {
    throw planningUpdateCadenceIdempotencyUnavailable()
  }
  const receipt = value.body
  const payload = isRecord(receipt.payload) ? receipt.payload : undefined
  if (
    receipt.schema !== PLANNING_UPDATE_CADENCE_RECEIPT_SCHEMA ||
    receipt.version !== PLANNING_UPDATE_CADENCE_RECEIPT_VERSION ||
    receipt.workspaceId !== workspaceId ||
    receipt.status !== 200 ||
    !payload ||
    typeof payload.revision !== 'number' ||
    !Number.isSafeInteger(payload.revision) ||
    payload.revision < 1 ||
    !isPlanningUpdateTargetSummary(payload.updateTarget) ||
    !isPlanningUpdateTarget(payload.target) ||
    stableDigestStringify(payload.target) !== stableDigestStringify(expectation.target) ||
    stableDigestStringify(payload.updateTarget.target) !== stableDigestStringify(expectation.target) ||
    stableDigestStringify({ status: 200, body: receipt }) !== stableDigestStringify(value)
  ) {
    throw planningUpdateCadenceIdempotencyUnavailable()
  }
  return {
    target: structuredClone(expectation.target),
    revision: payload.revision,
    updateTarget: structuredClone(payload.updateTarget),
  }
}

/** Checks the persisted shape of one Planning update target. */
function isPlanningUpdateTarget(value: unknown): value is PlanningUpdateTarget {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'initiative') return typeof value.entityId === 'string'
  return value.type === 'project' &&
    typeof value.teamId === 'string' &&
    typeof value.projectId === 'string'
}

/** Checks the persisted shape of one Planning cadence. */
function isPlanningUpdateCadence(value: unknown): value is PlanningUpdateCadence {
  if (!isRecord(value) || typeof value.updateOwnerMemberKey !== 'string' ||
    typeof value.timeZone !== 'string' || typeof value.nextDueAt !== 'string' ||
    typeof value.reminderHoursBefore !== 'number' ||
    !Number.isSafeInteger(value.reminderHoursBefore) || value.reminderHoursBefore < 0 ||
    !isRecord(value.cadence) ||
    (value.cadence.unit !== 'week' && value.cadence.unit !== 'month') ||
    typeof value.cadence.count !== 'number' ||
    !Number.isSafeInteger(value.cadence.count) || value.cadence.count < 1) {
    return false
  }
  return (value.escalationHoursAfter === undefined ||
      (typeof value.escalationHoursAfter === 'number' &&
        Number.isSafeInteger(value.escalationHoursAfter) &&
        value.escalationHoursAfter >= 0)) &&
    (value.escalationMemberKey === undefined || typeof value.escalationMemberKey === 'string')
}

/** Checks the persisted shape of one Planning update target summary. */
function isPlanningUpdateTargetSummary(value: unknown): value is PlanningUpdateTargetSummary {
  if (!isRecord(value) || !isPlanningUpdateTarget(value.target) ||
    (value.cadence !== undefined && !isPlanningUpdateCadence(value.cadence)) ||
    typeof value.latestVersion !== 'number' ||
    !Number.isSafeInteger(value.latestVersion) || value.latestVersion < 0 ||
    (value.updateState !== 'not-configured' && value.updateState !== 'missing' &&
      value.updateState !== 'current' && value.updateState !== 'overdue' &&
      value.updateState !== 'stale') ||
    typeof value.updatedAt !== 'string') {
    return false
  }
  return true
}

/** Validates the optional publish idempotency key when one is supplied. */
function readRequiredPlanningUpdatePublishIdempotencyKey(value: string): string {
  const key = value.trim()
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new PlanningError(
      400,
      'InvalidPlanningUpdatePublishIdempotencyKey',
      'Idempotency-Key must contain 1 to 256 characters without control characters.',
    )
  }
  return key
}

/** Creates the user-scoped reservation identity for one publish request. */
function createPlanningUpdatePublishReservationRequest(
  principal: WorkspacePrincipal,
  idempotencyKey: string,
  method: string,
  path: string,
  expectation: PlanningUpdatePublishReceiptExpectation,
): ReserveIdempotencyRequest {
  return {
    workspaceId: createWorkItemScheduleIdempotencyWorkspaceId(principal.directoryId),
    credentialId: createWorkItemScheduleIdempotencyUserId(
      principal.directoryId,
      principal.actorId,
    ),
    idempotencyKey,
    requestFingerprint: createHash('sha256')
      .update(`${method.toUpperCase()}\n${path}\n${stableDigestStringify(expectation.request)}`)
      .digest('hex'),
  }
}

/** Reserves one Planning publish and maps storage failures to its stable error. */
async function reservePlanningUpdatePublishMutation(request: ReserveIdempotencyRequest) {
  try {
    return await developerPlatformDependencies.idempotency.reserveIdempotency(request)
  } catch (error) {
    if (error instanceof DeveloperPlatformError && error.code === 'IdempotencyKeyConflict') {
      throw new PlanningError(
        409,
        'PlanningUpdatePublishIdempotencyConflict',
        'Idempotency-Key was already used for a different Planning update publish.',
      )
    }
    throw planningUpdatePublishIdempotencyUnavailable()
  }
}

/** Creates the stable failure returned when publish receipt persistence is unavailable. */
function planningUpdatePublishIdempotencyUnavailable(): PlanningError {
  return new PlanningError(
    503,
    'PlanningUpdatePublishIdempotencyUnavailable',
    'Planning update publish idempotency is unavailable.',
  )
}

/** Releases an uncommitted Planning publish reservation without masking the original error. */
async function releasePlanningUpdatePublishReservation(
  request: ReleaseIdempotencyRequest,
): Promise<void> {
  await developerPlatformDependencies.idempotency.releaseIdempotency(request).catch(() => undefined)
}

/** Creates a durable publish receipt contribution for the Planning transaction. */
function createPlanningUpdatePublishIdempotencyTransaction(
  workspaceId: string,
  token: IdempotencyMutationToken,
  expectation: PlanningUpdatePublishReceiptExpectation,
): PlanningMutationTransaction<PlanningUpdatePublishTransactionResult> | undefined {
  const prepare = developerPlatformDependencies.transactions
    .prepareIdempotencyCompletionTransactWrite
  if (!prepare) return undefined
  return {
    async prepare(result) {
      return prepare.call(developerPlatformDependencies.transactions, {
        workspaceId,
        credentialId: token.credentialId,
        idempotencyKey: token.idempotencyKey,
        requestFingerprint: token.requestFingerprint,
        reservationId: token.reservationId,
        response: createPlanningUpdatePublishReceiptResponse(workspaceId, expectation, result),
      })
    },
  }
}

/** Creates the compact durable payload used to replay the immutable update. */
function createPlanningUpdatePublishReceiptResponse(
  workspaceId: string,
  expectation: PlanningUpdatePublishReceiptExpectation,
  result: PlanningUpdatePublishTransactionResult,
) {
  if (
    result.kind !== 'publish' ||
    result.update.id !== expectation.id ||
    result.update.authorMemberKey !== expectation.authorMemberKey ||
    !planningUpdateTargetsEqual(result.update.target, expectation.target)
  ) {
    throw planningUpdatePublishIdempotencyUnavailable()
  }
  return {
    status: 201 as const,
    body: {
      schema: PLANNING_UPDATE_PUBLISH_RECEIPT_SCHEMA,
      version: PLANNING_UPDATE_PUBLISH_RECEIPT_VERSION,
      workspaceId,
      status: 201,
      payload: {
        target: structuredClone(result.update.target),
        id: result.update.id,
        version: result.update.version,
      },
    },
  }
}

/** Decoded identity stored in a successful Planning publish receipt. */
type PlanningUpdatePublishReplay = {
  /** Project or Initiative target. */
  target: PlanningUpdateTarget
  /** Immutable update ID. */
  id: string
  /** Target-local immutable version. */
  version: number
}

/** Strictly decodes one completed Planning publish receipt. */
function readStoredPlanningUpdatePublishMutationReceipt(
  value: unknown,
  workspaceId: string,
  expectation: PlanningUpdatePublishReceiptExpectation,
): PlanningUpdatePublishReplay {
  if (!isRecord(value) || value.status !== 201 || !isRecord(value.body)) {
    throw planningUpdatePublishIdempotencyUnavailable()
  }
  const receipt = value.body
  const payload = isRecord(receipt.payload) ? receipt.payload : undefined
  if (
    receipt.schema !== PLANNING_UPDATE_PUBLISH_RECEIPT_SCHEMA ||
    receipt.version !== PLANNING_UPDATE_PUBLISH_RECEIPT_VERSION ||
    receipt.workspaceId !== workspaceId ||
    receipt.status !== 201 ||
    !payload ||
    typeof payload.id !== 'string' ||
    typeof payload.version !== 'number' ||
    !Number.isSafeInteger(payload.version) ||
    payload.version < 1 ||
    !isRecord(payload.target) ||
    stableDigestStringify(payload.target) !== stableDigestStringify(expectation.target) ||
    payload.id !== expectation.id ||
    stableDigestStringify({ status: 201, body: receipt }) !== stableDigestStringify(value)
  ) {
    throw planningUpdatePublishIdempotencyUnavailable()
  }
  return {
    target: structuredClone(expectation.target),
    id: expectation.id,
    version: payload.version,
  }
}

/** Reads one immutable update version, paging only when the receipt is not latest. */
async function readPlanningUpdateByVersion(
  workspaceId: string,
  target: PlanningUpdateTarget,
  version: number,
): Promise<PlanningUpdate | undefined> {
  let cursor: string | undefined
  do {
    const page = await workItemDependencies.planning.listUpdates(workspaceId, {
      target,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    })
    const update = page.updates.find((candidate) => candidate.version === version)
    if (update) return update
    cursor = page.nextCursor
  } while (cursor)
  return undefined
}

/** Rechecks the captured scope before exposing annotations for one immutable version. */
async function requirePlanningUpdateVersionCapturedScopePermission(
  workspaceId: string,
  principal: WorkspacePrincipal,
  target: PlanningUpdateTarget,
  version: number,
): Promise<void> {
  const snapshot = await workItemDependencies.planning.get(
    workspaceId,
    await readPlanningWorkItemState(principal),
  )
  const targetSummary = findPlanningUpdateTargetSummary(snapshot, target)
  if (!targetSummary || version > targetSummary.latestVersion) {
    throw new PlanningError(
      404,
      'PlanningUpdateNotFound',
      'Planning update was not found.',
    )
  }
  const update = await readPlanningUpdateByVersion(workspaceId, target, version)
  if (!update || !planningUpdateTargetsEqual(update.target, target)) {
    throw new PlanningError(
      404,
      'PlanningUpdateNotFound',
      'Planning update was not found.',
    )
  }
  await requirePlanningUpdateCapturedScopePermission(
    principal,
    update.contextSnapshot.scope,
  )
}

/** Creates the stable failure used when a stored annotation receipt is malformed. */
function invalidStoredPlanningUpdateAnnotationMutationReceipt(): PlanningError {
  return new PlanningError(
    503,
    'InvalidStoredPlanningUpdateAnnotationMutationReceipt',
    'The stored Planning update annotation mutation receipt is invalid.',
  )
}

/**
 * Validates a domain mutation result and creates its compact replay payload.
 *
 * @param workspaceId - Opaque reservation Workspace identity.
 * @param expectation - Canonical request identity.
 * @param result - Domain-produced result committed with the receipt.
 * @returns Exact HTTP response wrapper stored by the idempotency port.
 */
function createPlanningUpdateAnnotationReceiptResponse(
  workspaceId: string,
  expectation: PlanningUpdateAnnotationReceiptExpectation,
  result: PlanningUpdateAnnotationTransactionResult,
) {
  let replay: PlanningUpdateAnnotationReplay
  if (expectation.operation === 'comment-create') {
    if (
      result.kind !== 'comment-create' ||
      result.comment.id !== expectation.id ||
      result.comment.body !== expectation.body ||
      result.comment.updateVersion !== expectation.updateVersion ||
      result.comment.authorMemberKey !== expectation.memberKey ||
      !planningUpdateTargetsEqual(result.comment.target, expectation.target)
    ) {
      throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
    }
    replay = {
      operation: 'comment-create',
      status: 201,
      body: { comment: structuredClone(result.comment) },
    }
  } else if (expectation.operation === 'reaction-add') {
    if (
      result.kind !== 'reaction-add' ||
      result.reaction.emoji !== expectation.emoji ||
      result.reaction.updateVersion !== expectation.updateVersion ||
      result.reaction.memberKey !== expectation.memberKey ||
      !planningUpdateTargetsEqual(result.reaction.target, expectation.target)
    ) {
      throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
    }
    replay = {
      operation: 'reaction-add',
      status: 201,
      body: { reaction: structuredClone(result.reaction) },
    }
  } else {
    if (
      result.kind !== 'reaction-remove' ||
      result.emoji !== expectation.emoji ||
      result.updateVersion !== expectation.updateVersion ||
      result.memberKey !== expectation.memberKey ||
      !planningUpdateTargetsEqual(result.target, expectation.target)
    ) {
      throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
    }
    replay = { operation: 'reaction-remove', status: 204, body: null }
  }
  const receipt = {
    schema: PLANNING_UPDATE_ANNOTATION_RECEIPT_SCHEMA,
    version: PLANNING_UPDATE_ANNOTATION_RECEIPT_VERSION,
    workspaceId,
    operation: replay.operation,
    status: replay.status,
    payload: replay.body,
  }
  return { status: replay.status, body: receipt }
}

/**
 * Creates an atomic annotation receipt contribution for the Planning transaction.
 *
 * @param workspaceId - Opaque reservation Workspace identity.
 * @param token - Reservation token owned by the current request.
 * @param expectation - Canonical annotation request identity.
 * @returns Planning transaction contribution, or undefined when unavailable.
 */
function createPlanningUpdateAnnotationIdempotencyTransaction(
  workspaceId: string,
  token: IdempotencyMutationToken,
  expectation: PlanningUpdateAnnotationReceiptExpectation,
): PlanningMutationTransaction<PlanningUpdateAnnotationTransactionResult> | undefined {
  const prepare = developerPlatformDependencies.transactions
    .prepareIdempotencyCompletionTransactWrite
  if (!prepare) return undefined
  return {
    async prepare(result) {
      return prepare.call(developerPlatformDependencies.transactions, {
        workspaceId,
        credentialId: token.credentialId,
        idempotencyKey: token.idempotencyKey,
        requestFingerprint: token.requestFingerprint,
        reservationId: token.reservationId,
        response: createPlanningUpdateAnnotationReceiptResponse(
          workspaceId,
          expectation,
          result,
        ),
      })
    },
  }
}

/**
 * Validates one canonical ISO timestamp stored in an annotation replay receipt.
 *
 * @param value - Candidate timestamp.
 * @returns Exact ISO timestamp.
 */
function readStoredPlanningUpdateAnnotationTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
  }
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
  }
  return value
}

/**
 * Strictly validates one completed Planning update annotation replay receipt.
 *
 * @param value - Candidate Developer Platform replay response.
 * @param workspaceId - Opaque Workspace identity expected by the route.
 * @param expectation - Canonical annotation request identity.
 * @returns Original successful HTTP response envelope.
 */
function readStoredPlanningUpdateAnnotationMutationReceipt(
  value: unknown,
  workspaceId: string,
  expectation: PlanningUpdateAnnotationReceiptExpectation,
): PlanningUpdateAnnotationReplay {
  if (!isRecord(value) || !isRecord(value.body)) {
    throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
  }
  const receipt = value.body
  if (
    receipt.schema !== PLANNING_UPDATE_ANNOTATION_RECEIPT_SCHEMA ||
    receipt.version !== PLANNING_UPDATE_ANNOTATION_RECEIPT_VERSION ||
    receipt.workspaceId !== workspaceId ||
    receipt.operation !== expectation.operation
  ) {
    throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
  }

  let replay: PlanningUpdateAnnotationReplay
  if (expectation.operation === 'comment-create') {
    if (!isRecord(receipt.payload) || !isRecord(receipt.payload.comment)) {
      throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
    }
    const rawComment = receipt.payload.comment
    const comment: PlanningUpdateComment = {
      id: expectation.id,
      target: structuredClone(expectation.target),
      updateVersion: expectation.updateVersion,
      body: expectation.body,
      authorMemberKey: expectation.memberKey,
      createdAt: readStoredPlanningUpdateAnnotationTimestamp(rawComment.createdAt),
    }
    if (stableDigestStringify(comment) !== stableDigestStringify(rawComment)) {
      throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
    }
    replay = { operation: 'comment-create', status: 201, body: { comment } }
  } else if (expectation.operation === 'reaction-add') {
    if (!isRecord(receipt.payload) || !isRecord(receipt.payload.reaction)) {
      throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
    }
    const rawReaction = receipt.payload.reaction
    const reaction: PlanningUpdateReaction = {
      target: structuredClone(expectation.target),
      updateVersion: expectation.updateVersion,
      emoji: expectation.emoji,
      memberKey: expectation.memberKey,
      createdAt: readStoredPlanningUpdateAnnotationTimestamp(rawReaction.createdAt),
    }
    if (stableDigestStringify(reaction) !== stableDigestStringify(rawReaction)) {
      throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
    }
    replay = { operation: 'reaction-add', status: 201, body: { reaction } }
  } else {
    if (receipt.payload !== null) {
      throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
    }
    replay = { operation: 'reaction-remove', status: 204, body: null }
  }

  const canonicalReceipt = {
    schema: PLANNING_UPDATE_ANNOTATION_RECEIPT_SCHEMA,
    version: PLANNING_UPDATE_ANNOTATION_RECEIPT_VERSION,
    workspaceId,
    operation: replay.operation,
    status: replay.status,
    payload: replay.body,
  }
  if (
    receipt.status !== replay.status ||
    value.status !== replay.status ||
    stableDigestStringify({ status: replay.status, body: canonicalReceipt }) !==
      stableDigestStringify(value)
  ) {
    throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
  }
  return replay
}

/** Creates the stable failure used when a durable dependency replay receipt is malformed. */
function invalidStoredPlanningWorkItemDependencyMutationReceipt(): PlanningError {
  return new PlanningError(
    503,
    'InvalidStoredPlanningWorkItemDependencyMutationReceipt',
    'The stored Work Item dependency mutation receipt is invalid.',
  )
}

/**
 * Reads one identifier from an encrypted dependency receipt.
 *
 * @param value - Candidate identifier.
 * @returns Validated non-empty identifier.
 */
function readStoredPlanningWorkItemDependencyIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 256
  ) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return value
}

/**
 * Reads one exact qualified endpoint from an encrypted dependency receipt.
 *
 * @param value - Candidate endpoint.
 * @returns Validated detached endpoint.
 */
function readStoredPlanningWorkItemDependencyEndpoint(
  value: unknown,
): WorkItemDependencyEndpoint {
  if (!isRecord(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const endpoint = {
    teamId: readStoredPlanningWorkItemDependencyIdentifier(value.teamId),
    workItemId: readStoredPlanningWorkItemDependencyIdentifier(value.workItemId),
  }
  if (stableDigestStringify(endpoint) !== stableDigestStringify(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return endpoint
}

/**
 * Tests whether a receipt value is one canonical supported schedule date.
 *
 * @param value - Candidate date.
 * @returns Whether the value is a real `YYYY-MM-DD` date within supported years.
 */
function isStoredPlanningWorkItemDependencyDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number(value.slice(0, 4)) < WORK_ITEM_SCHEDULE_MIN_YEAR
  ) {
    return false
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Reads one exact dependency constraint from an encrypted receipt.
 *
 * @param value - Candidate constraint.
 * @returns Validated detached constraint.
 */
function readStoredPlanningWorkItemDependencyConstraint(
  value: unknown,
): ScheduleDependencyConstraint {
  if (
    !isRecord(value) ||
    (value.anchor !== 'start' && value.anchor !== 'finish') ||
    (value.kind !== 'on' && value.kind !== 'not-before' && value.kind !== 'not-after') ||
    !isStoredPlanningWorkItemDependencyDate(value.date)
  ) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const constraint: ScheduleDependencyConstraint = {
    anchor: value.anchor,
    kind: value.kind,
    date: value.date,
  }
  if (stableDigestStringify(constraint) !== stableDigestStringify(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return constraint
}

/**
 * Reads one canonical ISO timestamp from an encrypted dependency receipt.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readStoredPlanningWorkItemDependencyTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return value
}

/**
 * Reads one exact canonical dependency from an encrypted replay receipt.
 *
 * @param value - Candidate dependency.
 * @returns Validated detached dependency.
 */
function readStoredPlanningWorkItemDependency(
  value: unknown,
): WorkItemScheduleDependency {
  if (!isRecord(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const type = value.type
  if (
    type !== 'finish-to-start' &&
    type !== 'start-to-start' &&
    type !== 'finish-to-finish' &&
    type !== 'start-to-finish'
  ) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  if (
    typeof value.lagDays !== 'number' ||
    !Number.isSafeInteger(value.lagDays) ||
    Math.abs(value.lagDays) > WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS
  ) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const createdAt = readStoredPlanningWorkItemDependencyTimestamp(value.createdAt)
  const updatedAt = readStoredPlanningWorkItemDependencyTimestamp(value.updatedAt)
  if (updatedAt < createdAt) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const dependency: WorkItemScheduleDependency = {
    id: readStoredPlanningWorkItemDependencyIdentifier(value.id),
    predecessor: readStoredPlanningWorkItemDependencyEndpoint(value.predecessor),
    successor: readStoredPlanningWorkItemDependencyEndpoint(value.successor),
    type,
    lagDays: value.lagDays,
    ...(value.constraint === undefined
      ? {}
      : { constraint: readStoredPlanningWorkItemDependencyConstraint(value.constraint) }),
    createdAt,
    updatedAt,
  }
  if (stableDigestStringify(dependency) !== stableDigestStringify(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return dependency
}

/**
 * Resolves the original successful status for one dependency mutation operation.
 *
 * @param operation - Receipt operation.
 * @returns `201` for create and `200` for update or delete.
 */
function resolvePlanningWorkItemDependencyReceiptStatus(
  operation: PlanningWorkItemDependencyReceiptOperation,
): 200 | 201 {
  return operation === 'create' ? 201 : 200
}

/**
 * Strictly validates one compact dependency mutation replay receipt.
 *
 * @param value - Candidate Developer Platform replay response.
 * @param workspaceId - Opaque Workspace reservation identity expected by the route.
 * @param operation - Expected mutation operation.
 * @param dependencyId - Dependency identity bound to the canonical path or create body.
 * @returns Validated dependency, committed revision, and original response status.
 */
function readStoredPlanningWorkItemDependencyMutationReceipt(
  value: unknown,
  workspaceId: string,
  operation: PlanningWorkItemDependencyReceiptOperation,
  dependencyId: string,
) {
  if (!isRecord(value) || !isRecord(value.body)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const status = resolvePlanningWorkItemDependencyReceiptStatus(operation)
  const body = value.body
  const revision = body.revision
  if (
    body.schema !== PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_SCHEMA ||
    body.version !== PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_VERSION ||
    body.workspaceId !== workspaceId ||
    body.operation !== operation ||
    body.status !== status ||
    value.status !== status ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const dependency = readStoredPlanningWorkItemDependency(body.dependency)
  if (dependency.id !== dependencyId) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const receipt = {
    schema: PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_SCHEMA,
    version: PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_VERSION,
    workspaceId,
    operation,
    dependency,
    revision,
    status,
  }
  if (stableDigestStringify({ status, body: receipt }) !== stableDigestStringify(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return { dependency, revision, status }
}

/**
 * Reauthorizes both stored endpoints and loads the current filtered Planning snapshot.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param dependency - Strictly validated stored dependency.
 * @param operation - Stored mutation operation.
 * @param committedRevision - Planning revision atomically committed with the receipt.
 * @returns Current Planning snapshot visible to the principal.
 */
async function readPlanningWorkItemDependencyReplaySnapshot(
  principal: WorkspacePrincipal,
  dependency: WorkItemScheduleDependency,
  operation: PlanningWorkItemDependencyReceiptOperation,
  committedRevision: number,
): Promise<PlanningSnapshot> {
  await Promise.all([
    requirePlanningWorkItemEndpointPermission(principal, dependency.predecessor, 'manager'),
    requirePlanningWorkItemEndpointPermission(principal, dependency.successor, 'manager'),
  ])
  const workItemState = await readPlanningWorkItemState(principal)
  const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
  if (snapshot.revision < committedRevision) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  if (snapshot.revision === committedRevision) {
    const current = snapshot.workItemDependencies.find((candidate) =>
      candidate.id === dependency.id
    )
    const stateMatches = operation === 'delete'
      ? current === undefined
      : current !== undefined &&
        stableDigestStringify(current) === stableDigestStringify(dependency)
    if (!stateMatches) {
      throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
    }
  }
  return filterPlanningSnapshotForPrincipal(principal, snapshot)
}

/**
 * Copies exactly the canonical dependency fields allowed in a compact receipt.
 *
 * @param dependency - Domain-produced committed dependency.
 * @returns Detached receipt-safe dependency.
 */
function createPlanningWorkItemDependencyReceiptValue(
  dependency: WorkItemScheduleDependency,
): WorkItemScheduleDependency {
  return {
    id: dependency.id,
    predecessor: { ...dependency.predecessor },
    successor: { ...dependency.successor },
    type: dependency.type,
    lagDays: dependency.lagDays,
    ...(dependency.constraint === undefined
      ? {}
      : { constraint: { ...dependency.constraint } }),
    createdAt: dependency.createdAt,
    updatedAt: dependency.updatedAt,
  }
}

/**
 * Creates the atomic compact receipt contribution for one dependency mutation.
 *
 * @param workspaceId - Opaque Workspace reservation identity.
 * @param token - Reservation token owned by this request.
 * @param operation - Mutation operation persisted in the receipt.
 * @param dependencyId - Expected committed dependency identity.
 * @returns Planning transaction contribution, or undefined when persistence is unavailable.
 */
function createPlanningWorkItemDependencyIdempotencyTransaction(
  workspaceId: string,
  token: IdempotencyMutationToken,
  operation: PlanningWorkItemDependencyReceiptOperation,
  dependencyId: string,
): PlanningMutationTransaction | undefined {
  const prepare = developerPlatformDependencies.transactions
    .prepareIdempotencyCompletionTransactWrite
  if (!prepare) return undefined
  const status = resolvePlanningWorkItemDependencyReceiptStatus(operation)
  return {
    async prepare(result) {
      const expectedKind = operation === 'delete' ? 'delete' : 'upsert'
      if (
        result.kind !== expectedKind ||
        result.dependency.id !== dependencyId ||
        !Number.isSafeInteger(result.revision) ||
        result.revision < 1
      ) {
        throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
      }
      const receipt = {
        schema: PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_SCHEMA,
        version: PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_VERSION,
        workspaceId,
        operation,
        dependency: createPlanningWorkItemDependencyReceiptValue(result.dependency),
        revision: result.revision,
        status,
      }
      return prepare.call(developerPlatformDependencies.transactions, {
        workspaceId,
        credentialId: token.credentialId,
        idempotencyKey: token.idempotencyKey,
        requestFingerprint: token.requestFingerprint,
        reservationId: token.reservationId,
        response: { status, body: receipt },
      })
    },
  }
}

/**
 * Applies the current principal and target-scope filter to one idempotent response target.
 *
 * @param principal - Authenticated principal receiving the response.
 * @param snapshot - Current canonical Planning snapshot used to resolve target scope.
 * @param updateTarget - Receipt or mutation target summary to sanitize.
 * @returns Target summary safe for the current principal, with stale latest content removed.
 */
function filterPlanningUpdateTargetSummaryForPrincipal(
  principal: ProjectPrincipal,
  snapshot: PlanningSnapshot,
  updateTarget: PlanningUpdateTargetSummary,
): PlanningUpdateTargetSummary {
  const filtered = filterPlanningSnapshotForPrincipal(principal, {
    ...snapshot,
    updateTargets: [structuredClone(updateTarget)],
  }).updateTargets[0]
  if (filtered) return filtered
  const redacted = structuredClone(updateTarget)
  delete redacted.latestUpdate
  return redacted
}

/** Reuses current background-member and Feed authorization without constructing HTTP requests.
 * @param bindStore - Composition-owned durable store with current caller/tenant fences.
 * @param tenantIsActive - Current tenant lifecycle check; errors propagate.
 * @param locale - Language resolved by worker configuration.
 * @returns Fresh authorization per candidate, bound to the surrounding dependency context.
 */
export function createInboxDigestRecipientAuthorization(
  bindStore: (recipient: InboxDigestRecipient, checks: readonly PlanningCallerAuthorizationConditionCheck[]) => InboxDigestStore,
  tenantIsActive: (workspaceId: string) => Promise<boolean>,
  locale: Locale = 'ja',
): InboxDigestDependencies {
  return { async authorize(recipient) {
    if (!await tenantIsActive(recipient.workspaceId)) return undefined
    const authorizationRevision = await workItemDependencies.planning.getAuthorizationRevision(recipient.workspaceId)
    try {
      const principal = await resolveDeveloperManagementPrincipal({
        workspaceId: recipient.workspaceId, userId: recipient.memberKey,
        capabilities: { canManageCredentials: false, canManageWebhooks: false, canManageIntegrations: false, canImport: false, canExport: false },
      }, { permission: 'planning.read', evaluateProjectScopes: true })
      if (principal.workspaceRole === 'guest' || principal.directoryId !== recipient.workspaceId || principal.userKey !== recipient.memberKey) return undefined
      const reader = await createPlanningUpdateFeedReader(principal, locale, true)
      const store = bindStore(recipient, createPlanningCallerAuthorizationConditionChecks(principal))
      return { recipient, authorizationRevision, reader, readState: workItemDependencies.updateFeedReadState, store }
    } catch (error) {
      if (isPlanningVisibilityAuthorizationError(error)) return undefined
      throw error
    }
  } }
}

/** Creates a commit-time Planning revision fence for a non-Planning transaction.
 *
 * @param workspaceId Workspace whose target snapshot authorized the mutation.
 * @param expectedRevision Strongly read Planning revision.
 * @returns A condition check for the isolated Planning revision-fence row.
 */
function createPlanningRevisionConditionCheck(
  workspaceId: string,
  expectedRevision: number,
): PlanningCallerAuthorizationConditionCheck {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new PlanningError(500, 'PlanningRevisionInvalid', 'Planning revision is invalid.')
  }
  const tableName = getEnv('PLANNING_TABLE_NAME')?.trim() ?? 'mukuroji-planning-local'
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        workspaceId: `FENCE#${workspaceId}`,
        recordKey: 'META',
      },
      ConditionExpression: expectedRevision === 0
        ? 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)'
        : '#entryType = :entryType AND #schemaVersion = :schemaVersion AND ' +
          '#revision = :expectedRevision',
      ...(expectedRevision === 0
        ? {}
        : {
            ExpressionAttributeNames: {
              '#entryType': 'entryType',
              '#revision': 'revision',
              '#schemaVersion': 'schemaVersion',
            },
            ExpressionAttributeValues: {
              ':entryType': 'planning-meta',
              ':expectedRevision': expectedRevision,
              ':schemaVersion': 1,
            },
          }),
    },
  }
}

/**
 * Registers the planning HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerPlanningRoutes(routeApp: Hono): void {
  /** Workspace planning graph と canonical Work Item roll-up を返します。 */
  routeApp.get('/api/planning', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const workItemState = await readPlanningWorkItemState(principal)
      return c.json(filterPlanningSnapshotForPrincipal(
        principal,
        await workItemDependencies.planning.get(principal.directoryId, workItemState),
      ))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Returns a bounded, currently authorized aggregate of latest Planning updates. */
  routeApp.get('/api/planning/update-feed', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      if (['view', 'limit', 'locale', 'feedId', 'relevance'].some((key) => (c.req.queries(key)?.length ?? 0) > 1)) {
        throw new PlanningError(400, 'UpdateFeedQueryAmbiguous', 'Feed query parameters must occur at most once.')
      }
      const relevance = c.req.query('relevance')
      if (relevance !== undefined && relevance !== '2') throw new PlanningError(400, 'UpdateFeedRelevanceInvalid', 'Unsupported feed relevance version.')
      return c.json(await readPlanningUpdateFeed(principal, c.req.query('view'), c.req.query('limit'), readLocale(c), c.req.query('feedId'), relevance === '2'))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Reads only personal digest preferences and content-free receipts. */
  routeApp.get('/api/planning/update-feed/digest', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await workItemDependencies.updateFeedDigest.get(principal.directoryId, principal.userKey))
    } catch (error) { return toPlanningErrorResponse(c, error) }
  })

  /** Reads delivery consent independently of manual-preview preferences. */
  routeApp.get('/api/planning/update-feed/digest/inbox', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await workItemDependencies.inboxDigestSettings.get(principal.directoryId, principal.userKey))
    } catch (error) { return toPlanningErrorResponse(c, error) }
  })

  /** Saves delivery consent only; no worker is activated and no notification is sent. */
  routeApp.put('/api/planning/update-feed/digest/inbox', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      if (principal.workspaceRole === 'guest') throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'Guest members have read-only Workspace access.')
      const store = workItemDependencies.inboxDigestSettings.withCallerAuthorization(createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account'))
      return c.json(await replaceDigestPreferences(store, principal.directoryId, principal.userKey, await readPlanningJson<unknown>(c.req), workItemDependencies.savedUpdateFeeds))
    } catch (error) { return toPlanningErrorResponse(c, error) }
  })

  /** Saves manual-preview preferences without enabling a live delivery schedule. */
  routeApp.put('/api/planning/update-feed/digest', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      if (principal.workspaceRole === 'guest') throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'Guest members have read-only Workspace access.')
      const store = workItemDependencies.updateFeedDigest.withCallerAuthorization(createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account'))
      return c.json(await replaceDigestPreferences(store, principal.directoryId, principal.userKey, await readPlanningJson<unknown>(c.req), workItemDependencies.savedUpdateFeeds))
    } catch (error) { return toPlanningErrorResponse(c, error) }
  })

  /** Manually previews a digest; no Inbox, notification or schedule transport is connected. */
  routeApp.post('/api/planning/update-feed/digest/preview', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const initialPrincipal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const authorizationRevision = await workItemDependencies.planning.getAuthorizationRevision(initialPrincipal.directoryId)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      if (principal.directoryId !== initialPrincipal.directoryId) throw new PlanningError(409, 'UpdateFeedDigestConflict', 'Workspace authorization changed.')
      if (principal.workspaceRole === 'guest') throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'Guest members have read-only Workspace access.')
      const store = workItemDependencies.updateFeedDigest.withCallerAuthorization(createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account'))
      const authorizedReader = await createPlanningUpdateFeedReader(principal, readLocale(c), true)
      const reader: UpdateFeedReader = { ...authorizedReader, readSnapshot: async () => {
        const snapshot = await authorizedReader.readSnapshot()
        if (snapshot.revision !== authorizationRevision) throw new PlanningError(409, 'UpdateFeedDigestConflict', 'Feed authorization changed. Retry with current permissions.')
        return snapshot
      } }
      return c.json(await previewUpdateFeedDigest(reader, workItemDependencies.updateFeedReadState, store, principal.directoryId))
    } catch (error) { return toPlanningErrorResponse(c, error) }
  })

  /** Returns current authorized labels for editing filter dimensions. */
  routeApp.get('/api/planning/update-feed/options', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      if ((c.req.queries('locale')?.length ?? 0) > 1) throw new PlanningError(400, 'UpdateFeedQueryAmbiguous', 'Feed query parameters must occur at most once.')
      return c.json(await readUpdateFeedFilterOptions(await createPlanningUpdateFeedReader(principal, readLocale(c))))
    } catch (error) { return toPlanningErrorResponse(c, error) }
  })

  /** Reads only the authenticated member's bounded saved filter definitions. */
  routeApp.get('/api/planning/update-feed/saved', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await workItemDependencies.savedUpdateFeeds.get(principal.directoryId, principal.userKey))
    } catch (error) { return toPlanningErrorResponse(c, error) }
  })

  /** Creates, edits, or deletes personal definitions through a bounded collection CAS. */
  routeApp.put('/api/planning/update-feed/saved', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      if (principal.workspaceRole === 'guest') throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'Guest members have read-only Workspace access.')
      const input = parseSavedUpdateFeeds(await readPlanningJson<unknown>(c.req))
      const store = workItemDependencies.savedUpdateFeeds.withCallerAuthorization(createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account'))
      return c.json(await store.replace(principal.directoryId, principal.userKey, input))
    } catch (error) { return toPlanningErrorResponse(c, error) }
  })

  /** Persists the current member's explicit read state for one currently readable report. */
  routeApp.put('/api/planning/update-feed/read-state', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const initialPrincipal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const input = parseUpdateFeedReadState(await readPlanningJson<unknown>(c.req))
      const authorizationRevision = await workItemDependencies.planning.getAuthorizationRevision(initialPrincipal.directoryId)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      if (principal.directoryId !== initialPrincipal.directoryId) throw new PlanningError(409, 'UpdateFeedReadStateConflict', 'Workspace authorization changed.')
      if (principal.workspaceRole === 'guest') throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'Guest members have read-only Workspace access.')
      const authorizedReader = await createPlanningUpdateFeedReader(principal)
      const reader: UpdateFeedReader = { ...authorizedReader, readSnapshot: async () => {
        const snapshot = await authorizedReader.readSnapshot()
        if (snapshot.revision !== authorizationRevision) throw new PlanningError(409, 'UpdateFeedReadStateConflict', 'Target authorization changed. Refresh and retry.')
        return snapshot
      } }
      const callerChecks = createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account')
      if (callerChecks.length === 0) throw new PlanningError(503, 'UpdateFeedAuthorizationUnavailable', 'Caller authorization conditions are unavailable.')
      const store = workItemDependencies.updateFeedReadState.withCallerAuthorization(callerChecks)
      return c.json(await setUpdateFeedReadState(reader, store, principal.directoryId, input))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Project / Initiative の recurring health-update cadence を設定または解除します。 */
  routeApp.put('/api/planning/updates/cadence', async (c) => {
    const accessToken = readBearerAccessToken(c)
    let reservationToRelease: ReleaseIdempotencyRequest | undefined
    let mutationCommitted = false
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const candidate = await readPlanningJson<ConfigurePlanningUpdateCadenceInput>(c.req)
      const input: ConfigurePlanningUpdateCadenceInput = {
        ...candidate,
        target: readPlanningUpdateTarget(candidate.target),
      }
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(
        principal.directoryId,
        workItemState,
      )
      const visibleSnapshot = filterPlanningSnapshotForPrincipal(principal, snapshot)
      const idempotencyKey = c.req.header('Idempotency-Key')?.trim()
      let cadenceTransaction: PlanningMutationTransaction<PlanningUpdateCadenceTransactionResult> | undefined
      if (idempotencyKey) {
        const validatedKey = readRequiredPlanningUpdateCadenceIdempotencyKey(idempotencyKey)
        const expectation: PlanningUpdateCadenceReceiptExpectation = {
          target: input.target,
          request: input,
        }
        const reservationRequest = createPlanningUpdateCadenceReservationRequest(
          principal,
          validatedKey,
          c.req.method,
          '/api/planning/updates/cadence',
          expectation,
        )
        const reservation = await reservePlanningUpdateCadenceMutation(reservationRequest)
        if (reservation.status === 'in-progress') {
          throw new PlanningError(
            409,
            'PlanningUpdateCadenceIdempotencyInProgress',
            'The same Planning update cadence mutation is still in progress.',
          )
        }
        if (reservation.status === 'replay') {
          await requirePlanningUpdateTargetPermission(
            principal,
            visibleSnapshot,
            input.target,
            'manager',
          )
          const replay = readStoredPlanningUpdateCadenceMutationReceipt(
            reservation.response,
            reservationRequest.workspaceId,
            expectation,
          )
          c.header('Idempotency-Replayed', 'true')
          const replayPlanning = filterPlanningSnapshotForPrincipal(principal, snapshot)
          const replayTarget = findPlanningUpdateTargetSummary(snapshot, replay.target)
          if (!replayTarget) {
            throw planningUpdateCadenceIdempotencyUnavailable()
          }
          return c.json({
            planning: replayPlanning,
            updateTarget: filterPlanningUpdateTargetSummaryForPrincipal(
              principal,
              snapshot,
              replayTarget,
            ),
          })
        }
        reservationToRelease = {
          ...reservationRequest,
          reservationId: reservation.reservationId,
        }
        cadenceTransaction = createPlanningUpdateCadenceIdempotencyTransaction(
          reservationRequest.workspaceId,
          {
            credentialId: reservationRequest.credentialId,
            idempotencyKey: validatedKey,
            requestFingerprint: reservationRequest.requestFingerprint,
            reservationId: reservation.reservationId,
          },
          expectation,
        )
        if (!cadenceTransaction) throw planningUpdateCadenceIdempotencyUnavailable()
      }
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      await requirePlanningUpdateTargetPermission(
        principal,
        visibleSnapshot,
        input.target,
        'manager',
      )
      const cadenceRecipientMembers = input.cadence
        ? await Promise.all([
          requirePlanningCadenceRecipientTargetPermission(
            principal,
            visibleSnapshot,
            input.target,
            input.cadence.updateOwnerMemberKey,
            'member',
          ),
          ...(input.cadence.escalationMemberKey
            ? [requirePlanningCadenceRecipientTargetPermission(
                principal,
                visibleSnapshot,
                input.target,
                input.cadence.escalationMemberKey,
                'viewer',
              )]
            : []),
        ])
        : []
      const response = await workItemDependencies.planning.configureUpdateCadence(
        principal.directoryId,
        input,
        workItemState,
        createPlanningCallerAuthorizationConditionChecks(principal, cadenceRecipientMembers),
        cadenceTransaction,
      )
      mutationCommitted = true
      const filteredPlanning = filterPlanningSnapshotForPrincipal(principal, response.planning)
      return c.json({
        ...response,
        planning: filteredPlanning,
        updateTarget: filterPlanningUpdateTargetSummaryForPrincipal(
          principal,
          response.planning,
          response.updateTarget,
        ),
      })
    } catch (error) {
      if (reservationToRelease && !mutationCommitted) {
        await releasePlanningUpdateCadenceReservation(reservationToRelease)
      }
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Human-authored structured Project / Initiative update を immutable publish します。 */
  routeApp.post('/api/planning/updates', async (c) => {
    const accessToken = readBearerAccessToken(c)
    let reservationToRelease: ReleaseIdempotencyRequest | undefined
    let mutationCommitted = false
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const candidate = await readPlanningJson<PublishPlanningUpdateInput>(c.req)
      const input: PublishPlanningUpdateInput = {
        ...candidate,
        target: readPlanningUpdateTarget(candidate.target),
      }
      const { snapshot, targetScope } = await readPlanningPublishState(principal, input.target)
      const visibleSnapshot = filterPlanningSnapshotForPrincipal(principal, snapshot)
      const idempotencyKey = c.req.header('Idempotency-Key')?.trim()
      let publishTransaction: PlanningMutationTransaction<PlanningUpdatePublishTransactionResult> | undefined
      if (idempotencyKey) {
        const validatedKey = readRequiredPlanningUpdatePublishIdempotencyKey(idempotencyKey)
        const expectation: PlanningUpdatePublishReceiptExpectation = {
          target: input.target,
          id: input.id,
          authorMemberKey: principal.userKey.toLowerCase(),
          request: input,
        }
        const reservationRequest = createPlanningUpdatePublishReservationRequest(
          principal,
          validatedKey,
          c.req.method,
          '/api/planning/updates',
          expectation,
        )
        const reservation = await reservePlanningUpdatePublishMutation(reservationRequest)
        if (reservation.status === 'in-progress') {
          throw new PlanningError(
            409,
            'PlanningUpdatePublishIdempotencyInProgress',
            'The same Planning update publish is still in progress.',
          )
        }
        if (reservation.status === 'replay') {
          await requirePlanningUpdateTargetPermission(principal, visibleSnapshot, input.target, 'member')
          const replay = readStoredPlanningUpdatePublishMutationReceipt(
            reservation.response,
            reservationRequest.workspaceId,
            expectation,
          )
          const update = await readPlanningUpdateByVersion(
            principal.directoryId,
            replay.target,
            replay.version,
          )
          if (!update || update.id !== replay.id) {
            throw planningUpdatePublishIdempotencyUnavailable()
          }
          await requirePlanningUpdateCapturedScopePermission(
            principal,
            update.contextSnapshot.scope,
          )
          c.header('Idempotency-Replayed', 'true')
          return c.json({
            planning: filterPlanningSnapshotForPrincipal(principal, snapshot),
            update,
          }, 201)
        }
        reservationToRelease = { ...reservationRequest, reservationId: reservation.reservationId }
        publishTransaction = createPlanningUpdatePublishIdempotencyTransaction(
          reservationRequest.workspaceId,
          {
            credentialId: reservationRequest.credentialId,
            idempotencyKey: validatedKey,
            requestFingerprint: reservationRequest.requestFingerprint,
            reservationId: reservation.reservationId,
          },
          expectation,
        )
        if (!publishTransaction) throw planningUpdatePublishIdempotencyUnavailable()
      }
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      await requirePlanningUpdateTargetPermission(principal, visibleSnapshot, input.target, 'member')
      const configuredTarget = findPlanningUpdateTargetSummary(snapshot, input.target)
      if (!configuredTarget?.cadence) {
        throw new PlanningError(
          409,
          'PlanningUpdateCadenceNotConfigured',
          'Configure an update cadence before publishing.',
        )
      }
      if (configuredTarget.cadence.updateOwnerMemberKey !== principal.userKey.toLowerCase()) {
        await requirePlanningUpdateTargetPermission(principal, visibleSnapshot, input.target, 'manager')
      }
      const evidenceConditionChecks = await createPlanningUpdateEvidenceConditionChecks(
        principal,
        snapshot,
        visibleSnapshot,
        input,
      )
      const canonicalWorkItemState = await readCanonicalPlanningWorkItemState(
        principal,
        targetScope,
      )
      const response = await workItemDependencies.planning.publishUpdate(
        principal.directoryId,
        input,
        principal.userKey,
        canonicalWorkItemState,
        [
          ...createPlanningCallerAuthorizationConditionChecks(principal),
          ...evidenceConditionChecks,
        ],
        publishTransaction,
      )
      mutationCommitted = true
      return c.json({
        ...response,
        planning: filterPlanningSnapshotForPrincipal(principal, response.planning),
      }, 201)
    } catch (error) {
      if (reservationToRelease && !mutationCommitted) {
        await releasePlanningUpdatePublishReservation(reservationToRelease)
      }
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Project / Initiative の immutable structured update history を page 取得します。 */
  routeApp.get('/api/planning/updates', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const target = readPlanningUpdateTargetQuery(
        c.req.query('targetType'),
        c.req.query('teamId'),
        c.req.query('projectId'),
        c.req.query('entityId'),
      )
      const snapshot = await workItemDependencies.planning.get(
        principal.directoryId,
        await readPlanningWorkItemState(principal),
      )
      await requirePlanningUpdateTargetPermission(
        principal,
        filterPlanningSnapshotForPrincipal(principal, snapshot),
        target,
        'viewer',
      )
      const limit = readPlanningUpdateHistoryLimit(c.req.query('limit'))
      const capturedScopeAuthorizationCache = new Map<string, Promise<void>>()
      let page = await workItemDependencies.planning.listUpdates(principal.directoryId, {
        target,
        ...(limit === undefined ? {} : { limit }),
        ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
      })
      const visibleUpdates = await filterPlanningUpdatesByCapturedScope(
        principal,
        page.updates,
        capturedScopeAuthorizationCache,
      )
      while (limit !== undefined && visibleUpdates.length < limit && page.nextCursor) {
        const remaining = limit - visibleUpdates.length
        page = await workItemDependencies.planning.listUpdates(principal.directoryId, {
          target,
          limit: remaining,
          cursor: page.nextCursor,
        })
        visibleUpdates.push(
          ...(await filterPlanningUpdatesByCapturedScope(
            principal,
            page.updates,
            capturedScopeAuthorizationCache,
          )).slice(0, remaining),
        )
      }
      return c.json({
        ...page,
        updates: visibleUpdates,
      })
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Immutable Planning update に append-only comment を作成します。 */
  routeApp.post('/api/planning/updates/:updateVersion/comments', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const candidate = await readPlanningJson<Pick<
        CreatePlanningUpdateCommentInput,
        'body' | 'id'
      >>(c.req)
      const id = readPlanningIdentifier(candidate.id, 'Planning update comment ID')
      const body = readPlanningUpdateCommentBody(candidate.body)
      const snapshot = await workItemDependencies.planning.get(
        principal.directoryId,
        await readPlanningWorkItemState(principal),
      )
      return await executePlanningUpdateAnnotationMutation(c, principal, snapshot, {
        targetType: c.req.query('targetType'),
        teamId: c.req.query('teamId'),
        projectId: c.req.query('projectId'),
        entityId: c.req.query('entityId'),
        updateVersion: c.req.param('updateVersion'),
        path: `/api/planning/updates/${c.req.param('updateVersion')}/comments`,
      }, {
        createExpectation: (target, updateVersion) => ({
          operation: 'comment-create',
          target,
          updateVersion,
          memberKey: principal.userKey.toLowerCase(),
          id,
          body,
        }),
        mutate: ({ target, updateVersion, transaction, authorizationConditionChecks }) =>
          workItemDependencies.planning.createUpdateComment(
            principal.directoryId,
            { target, updateVersion, id, body },
            principal.userKey,
            transaction,
            authorizationConditionChecks,
          ),
        replay: (context, replay) => {
          if (replay.operation !== 'comment-create') {
            throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
          }
          context.header('Idempotency-Replayed', 'true')
          return context.json(replay.body, replay.status)
        },
        success: (context, comment) => context.json({ comment }, 201),
      })
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Immutable Planning update comments を cursor pagination で返します。 */
  routeApp.get('/api/planning/updates/:updateVersion/comments', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const target = readPlanningUpdateTargetQuery(
        c.req.query('targetType'),
        c.req.query('teamId'),
        c.req.query('projectId'),
        c.req.query('entityId'),
      )
      const updateVersion = readPlanningUpdateVersion(c.req.param('updateVersion'))
      const snapshot = await workItemDependencies.planning.get(
        principal.directoryId,
        await readPlanningWorkItemState(principal),
      )
      await requirePlanningUpdateTargetPermission(
        principal,
        filterPlanningSnapshotForPrincipal(principal, snapshot),
        target,
        'viewer',
      )
      await requirePlanningUpdateVersionCapturedScopePermission(
        principal.directoryId,
        principal,
        target,
        updateVersion,
      )
      const limit = readPlanningUpdateHistoryLimit(c.req.query('limit'))
      return c.json(await workItemDependencies.planning.listUpdateComments(
        principal.directoryId,
        {
          target,
          updateVersion,
          ...(limit === undefined ? {} : { limit }),
          ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
        },
      ))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Current member の reaction を immutable Planning update に追加します。 */
  routeApp.put('/api/planning/updates/:updateVersion/reactions', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const candidate = await readPlanningJson<Pick<PlanningUpdateReactionInput, 'emoji'>>(c.req)
      const emoji = readPlanningUpdateReactionToken(candidate.emoji)
      const snapshot = await workItemDependencies.planning.get(
        principal.directoryId,
        await readPlanningWorkItemState(principal),
      )
      return await executePlanningUpdateAnnotationMutation(c, principal, snapshot, {
        targetType: c.req.query('targetType'),
        teamId: c.req.query('teamId'),
        projectId: c.req.query('projectId'),
        entityId: c.req.query('entityId'),
        updateVersion: c.req.param('updateVersion'),
        path: `/api/planning/updates/${c.req.param('updateVersion')}/reactions`,
      }, {
        createExpectation: (target, updateVersion) => ({
          operation: 'reaction-add',
          target,
          updateVersion,
          memberKey: principal.userKey.toLowerCase(),
          emoji,
        }),
        mutate: ({ target, updateVersion, transaction, authorizationConditionChecks }) =>
          workItemDependencies.planning.addUpdateReaction(
            principal.directoryId,
            { target, updateVersion, emoji },
            principal.userKey,
            transaction,
            authorizationConditionChecks,
          ),
        replay: (context, replay) => {
          if (replay.operation !== 'reaction-add') {
            throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
          }
          context.header('Idempotency-Replayed', 'true')
          return context.json(replay.body, replay.status)
        },
        success: (context, reaction) => context.json({ reaction }, 201),
      })
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Current member の reaction を immutable Planning update から削除します。 */
  routeApp.delete('/api/planning/updates/:updateVersion/reactions', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const emoji = readPlanningUpdateReactionToken(c.req.query('emoji'))
      const snapshot = await workItemDependencies.planning.get(
        principal.directoryId,
        await readPlanningWorkItemState(principal),
      )
      return await executePlanningUpdateAnnotationMutation(c, principal, snapshot, {
        targetType: c.req.query('targetType'),
        teamId: c.req.query('teamId'),
        projectId: c.req.query('projectId'),
        entityId: c.req.query('entityId'),
        updateVersion: c.req.param('updateVersion'),
        path: `/api/planning/updates/${c.req.param('updateVersion')}/reactions`,
      }, {
        createExpectation: (target, updateVersion) => ({
          operation: 'reaction-remove',
          target,
          updateVersion,
          memberKey: principal.userKey.toLowerCase(),
          emoji,
        }),
        mutate: ({ target, updateVersion, transaction, authorizationConditionChecks }) =>
          workItemDependencies.planning.removeUpdateReaction(
            principal.directoryId,
            { target, updateVersion, emoji },
            principal.userKey,
            transaction,
            authorizationConditionChecks,
          ).then(() => undefined),
        replay: (context, replay) => {
          if (replay.operation !== 'reaction-remove') {
            throw invalidStoredPlanningUpdateAnnotationMutationReceipt()
          }
          context.header('Idempotency-Replayed', 'true')
          return context.body(null, replay.status)
        },
        success: (context) => context.body(null, 204),
      })
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Immutable Planning update reactions を cursor pagination で返します。 */
  routeApp.get('/api/planning/updates/:updateVersion/reactions', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const target = readPlanningUpdateTargetQuery(
        c.req.query('targetType'),
        c.req.query('teamId'),
        c.req.query('projectId'),
        c.req.query('entityId'),
      )
      const updateVersion = readPlanningUpdateVersion(c.req.param('updateVersion'))
      const snapshot = await workItemDependencies.planning.get(
        principal.directoryId,
        await readPlanningWorkItemState(principal),
      )
      await requirePlanningUpdateTargetPermission(
        principal,
        filterPlanningSnapshotForPrincipal(principal, snapshot),
        target,
        'viewer',
      )
      await requirePlanningUpdateVersionCapturedScopePermission(
        principal.directoryId,
        principal,
        target,
        updateVersion,
      )
      const limit = readPlanningUpdateHistoryLimit(c.req.query('limit'))
      return c.json(await workItemDependencies.planning.listUpdateReactions(
        principal.directoryId,
        {
          target,
          updateVersion,
          ...(limit === undefined ? {} : { limit }),
          ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
        },
      ))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Project / Initiative の全 immutable update history を versioned JSON で export します。 */
  routeApp.get('/api/planning/updates/export', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const target = readPlanningUpdateTargetQuery(
        c.req.query('targetType'),
        c.req.query('teamId'),
        c.req.query('projectId'),
        c.req.query('entityId'),
      )
      const snapshot = await workItemDependencies.planning.get(
        principal.directoryId,
        await readPlanningWorkItemState(principal),
      )
      await requirePlanningUpdateTargetPermission(
        principal,
        filterPlanningSnapshotForPrincipal(principal, snapshot),
        target,
        'viewer',
      )
      const updates: PlanningUpdate[] = []
      const capturedScopeAuthorizationCache = new Map<string, Promise<void>>()
      let cursor: string | undefined
      do {
        const page = await workItemDependencies.planning.listUpdates(principal.directoryId, {
          target,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })
        updates.push(...await filterPlanningUpdatesByCapturedScope(
          principal,
          page.updates,
          capturedScopeAuthorizationCache,
        ))
        cursor = page.nextCursor
        if (
          updates.length > MAX_PLANNING_UPDATE_EXPORT_COUNT ||
          Buffer.byteLength(JSON.stringify(updates), 'utf8') > MAX_PLANNING_UPDATE_EXPORT_BYTES
        ) {
          throw new PlanningError(
            413,
            'PlanningUpdateExportLimitExceeded',
            'Planning update export exceeds the safe size limit.',
          )
        }
      } while (cursor)
      const targetKey = createPlanningUpdatePublicTargetKey(target)
      c.header(
        'Content-Disposition',
        `attachment; filename="planning-updates-${createSafeExportFileToken(targetKey)}.json"`,
      )
      return c.json({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        target,
        updates,
      })
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Current user の qualified Project / Initiative update watcher state を返します。 */
  routeApp.get('/api/planning/update-watch', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const target = readPlanningUpdateTargetQuery(
        c.req.query('targetType'),
        c.req.query('teamId'),
        c.req.query('projectId'),
        c.req.query('entityId'),
      )
      const snapshot = await workItemDependencies.planning.get(
        principal.directoryId,
        await readPlanningWorkItemState(principal),
      )
      await requirePlanningUpdateTargetPermission(
        principal,
        filterPlanningSnapshotForPrincipal(principal, snapshot),
        target,
        'viewer',
      )
      const targetKey = createPlanningUpdatePublicTargetKey(target)
      const watch = await workItemDependencies.collaboration.getWatcherState({
        entityKey: createPlanningUpdateCollaborationEntityKey(
          principal.directoryId,
          targetKey,
        ),
        memberKey: principal.userKey,
      })
      return c.json({ watch })
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  for (const planningUpdateWatchMethod of ['PUT', 'DELETE'] as const) {
    /** Qualified Project / Initiative update watcher を subscribe/unsubscribe します。 */
    routeApp.on(planningUpdateWatchMethod, '/api/planning/update-watch', async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        requireWorkspaceBusinessWrite(principal)
        const target = readPlanningUpdateTargetQuery(
          c.req.query('targetType'),
          c.req.query('teamId'),
          c.req.query('projectId'),
          c.req.query('entityId'),
        )
        const snapshot = await workItemDependencies.planning.get(
          principal.directoryId,
          await readPlanningWorkItemState(principal),
        )
        await requirePlanningUpdateTargetPermission(
          principal,
          filterPlanningSnapshotForPrincipal(principal, snapshot),
          target,
          'viewer',
        )
        const targetKey = createPlanningUpdatePublicTargetKey(target)
        const mutationInput = {
          workspaceId: principal.directoryId,
          entityKey: createPlanningUpdateCollaborationEntityKey(
            principal.directoryId,
            targetKey,
          ),
          planningUpdateTargetKey: targetKey,
          memberKey: principal.userKey,
          ...(target.type === 'project'
            ? { teamId: target.teamId, projectId: target.projectId }
            : {}),
          authorizationConditionChecks: [
            ...createPlanningCallerAuthorizationConditionChecks(principal),
            createPlanningRevisionConditionCheck(principal.directoryId, snapshot.revision),
          ],
          auditContext: createApiMutationContext(c, principal, {
            planningUpdateTargetKey: targetKey,
            method: planningUpdateWatchMethod,
          }),
        }
        const watch = planningUpdateWatchMethod === 'PUT'
          ? await workItemDependencies.collaboration.subscribe(mutationInput)
          : await workItemDependencies.collaboration.unsubscribe(mutationInput)
        return c.json({ watch })
      } catch (error) {
        return toPlanningErrorResponse(c, error)
      }
    })
  }

  /** Planning hierarchy に entity を作成します。 */
  routeApp.post('/api/planning/entities', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const input = await readPlanningJson<CreatePlanningEntityInput>(c.req)
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      await requirePlanningScopePermission(principal, input, 'member')
      if (input.parentId) {
        await requirePlanningEntityPermission(
          principal,
          snapshot.entities,
          input.parentId,
          'member',
        )
      }
      await requirePlanningActiveOwner(principal, input.ownerMemberKey)
      const response = await workItemDependencies.planning.create(principal.directoryId, input, workItemState)
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning), 201)
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Planning entity の editable fields を更新します。 */
  routeApp.patch('/api/planning/entities/:entityId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
      const input = await readPlanningJson<UpdatePlanningEntityInput>(c.req)
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'member')
      if (isRecord(input.patch) && input.patch.ownerMemberKey !== undefined) {
        await requirePlanningActiveOwner(principal, input.patch.ownerMemberKey)
      }
      const response = await workItemDependencies.planning.update(principal.directoryId, entityId, input, workItemState)
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Planning entity を soft archive します。 */
  routeApp.post('/api/planning/entities/:entityId/archive', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
      const input = await readPlanningJson<PlanningRevisionInput>(c.req)
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'manager')
      const response = await workItemDependencies.planning.archive(principal.directoryId, entityId, input, workItemState)
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Planning entity を link や dependency を持たない新規 entity として複製します。 */
  routeApp.post('/api/planning/entities/:entityId/duplicate', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
      const input = await readPlanningJson<DuplicatePlanningEntityInput>(c.req)
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      const source = await requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        entityId,
        'member',
      )
      await requirePlanningActiveOwner(principal, source.ownerMemberKey)
      const effectiveParentId = input.parentId === undefined ? source.parentId : input.parentId
      if (effectiveParentId) {
        await requirePlanningEntityPermission(
          principal,
          snapshot.entities,
          effectiveParentId,
          'member',
        )
      }
      const response = await workItemDependencies.planning.duplicate(principal.directoryId, entityId, input, workItemState)
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning), 201)
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Planning entity の hierarchy / Team / Project scope を移動します。 */
  routeApp.post('/api/planning/entities/:entityId/move', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
      const input = await readPlanningJson<MovePlanningEntityInput>(c.req)
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'manager')
      for (const descendant of collectActivePlanningDescendants(snapshot.entities, entityId)) {
        await requirePlanningScopePermission(principal, descendant, 'manager')
      }
      await requirePlanningScopePermission(principal, input, 'manager')
      if (input.parentId) {
        await requirePlanningEntityPermission(
          principal,
          snapshot.entities,
          input.parentId,
          'manager',
        )
      }
      requirePlanningMoveDoesNotInvalidateUpdateCadence(snapshot, entityId, input)
      const response = await workItemDependencies.planning.move(principal.directoryId, entityId, input, workItemState)
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Planning entity に member authored status update を追記します。 */
  routeApp.post('/api/planning/entities/:entityId/status-updates', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
      const input = await readPlanningJson<PlanningStatusUpdateInput>(c.req)
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'member')
      const response = await workItemDependencies.planning.addStatusUpdate(
        principal.directoryId,
        entityId,
        input,
        principal.userKey,
        workItemState,
      )
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning), 201)
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Planning entity 間に directed dependency を作成します。 */
  routeApp.post('/api/planning/dependencies', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const input = await readPlanningJson<CreatePlanningDependencyInput>(c.req)
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      await Promise.all([
        requirePlanningEntityPermission(
          principal,
          snapshot.entities,
          input.predecessorId,
          'manager',
        ),
        requirePlanningEntityPermission(
          principal,
          snapshot.entities,
          input.successorId,
          'manager',
        ),
      ])
      const response = await workItemDependencies.planning.createDependency(principal.directoryId, input, workItemState)
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning), 201)
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Planning dependency を削除します。 */
  routeApp.delete('/api/planning/dependencies/:dependencyId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const dependencyId = readPlanningRouteId(c.req.param('dependencyId'), 'Dependency ID')
      const input = await readPlanningJson<PlanningRevisionInput>(c.req)
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      const dependency = snapshot.dependencies.find((candidate) => candidate.id === dependencyId)
      if (!dependency) {
        throw new PlanningError(404, 'PlanningDependencyNotFound', 'Planning dependency was not found.')
      }
      await Promise.all([
        requirePlanningEntityPermission(
          principal,
          snapshot.entities,
          dependency.predecessorId,
          'manager',
        ),
        requirePlanningEntityPermission(
          principal,
          snapshot.entities,
          dependency.successorId,
          'manager',
        ),
      ])
      const response = await workItemDependencies.planning.deleteDependency(
        principal.directoryId,
        dependencyId,
        input,
        workItemState,
      )
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Creates one canonical schedule dependency between authorized Work Item endpoints. */
  routeApp.post('/api/planning/work-item-dependencies', async (c) => {
    const accessToken = readBearerAccessToken(c)
    let reservationToRelease: ReleaseIdempotencyRequest | undefined
    let mutationCommitted = false
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const idempotencyKey = readRequiredPlanningWorkItemDependencyIdempotencyKey(
        c.req.header('Idempotency-Key'),
      )
      const input = await readPlanningJson<CreateWorkItemScheduleDependencyInput>(c.req)
      const dependencyId = readPlanningIdentifier(input.id, 'Work Item dependency ID')
      const predecessor = readPlanningWorkItemDependencyEndpoint(
        input.predecessor,
        'Predecessor',
      )
      const successor = readPlanningWorkItemDependencyEndpoint(input.successor, 'Successor')
      const reservationRequest = createPlanningWorkItemDependencyReservationRequest(
        principal,
        idempotencyKey,
        c.req.method,
        '/api/planning/work-item-dependencies',
        input,
      )
      const reservation = await reservePlanningWorkItemDependencyMutation(reservationRequest)
      if (reservation.status === 'in-progress') {
        throw new PlanningError(
          409,
          'PlanningWorkItemDependencyIdempotencyInProgress',
          'The same Work Item dependency mutation is still in progress.',
        )
      }
      if (reservation.status === 'replay') {
        const replay = readStoredPlanningWorkItemDependencyMutationReceipt(
          reservation.response,
          reservationRequest.workspaceId,
          'create',
          dependencyId,
        )
        const planning = await readPlanningWorkItemDependencyReplaySnapshot(
          principal,
          replay.dependency,
          'create',
          replay.revision,
        )
        c.header('Idempotency-Replayed', 'true')
        return c.json(planning, replay.status)
      }
      reservationToRelease = {
        ...reservationRequest,
        reservationId: reservation.reservationId,
      }
      const transaction = createPlanningWorkItemDependencyIdempotencyTransaction(
        reservationRequest.workspaceId,
        {
          credentialId: reservationRequest.credentialId,
          idempotencyKey,
          requestFingerprint: reservationRequest.requestFingerprint,
          reservationId: reservation.reservationId,
        },
        'create',
        dependencyId,
      )
      if (!transaction) throw planningWorkItemDependencyIdempotencyUnavailable()
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      await Promise.all([
        requirePlanningWorkItemEndpointPermission(principal, predecessor, 'manager'),
        requirePlanningWorkItemEndpointPermission(principal, successor, 'manager'),
      ])
      const response = await workItemDependencies.planning.createWorkItemDependency(
        principal.directoryId,
        {
          id: dependencyId,
          predecessor,
          successor,
          type: input.type,
          lagDays: input.lagDays,
          ...(input.constraint === undefined
            ? {}
            : { constraint: input.constraint }),
          expectedRevision: input.expectedRevision,
        },
        workItemState,
        createPlanningCallerAuthorizationConditionChecks(principal),
        transaction,
      )
      mutationCommitted = true
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning), 201)
    } catch (error) {
      if (reservationToRelease && !mutationCommitted) {
        await releasePlanningWorkItemDependencyReservation(reservationToRelease)
      }
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Updates one canonical Work Item schedule dependency after authorizing both endpoints. */
  routeApp.patch('/api/planning/work-item-dependencies/:dependencyId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    let reservationToRelease: ReleaseIdempotencyRequest | undefined
    let mutationCommitted = false
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const idempotencyKey = readRequiredPlanningWorkItemDependencyIdempotencyKey(
        c.req.header('Idempotency-Key'),
      )
      const dependencyId = readPlanningRouteId(
        c.req.param('dependencyId'),
        'Work Item dependency ID',
      )
      const input = await readPlanningJson<UpdateWorkItemScheduleDependencyInput>(c.req)
      const canonicalPath = `/api/planning/work-item-dependencies/${dependencyId}`
      const reservationRequest = createPlanningWorkItemDependencyReservationRequest(
        principal,
        idempotencyKey,
        c.req.method,
        canonicalPath,
        input,
      )
      const reservation = await reservePlanningWorkItemDependencyMutation(reservationRequest)
      if (reservation.status === 'in-progress') {
        throw new PlanningError(
          409,
          'PlanningWorkItemDependencyIdempotencyInProgress',
          'The same Work Item dependency mutation is still in progress.',
        )
      }
      if (reservation.status === 'replay') {
        const replay = readStoredPlanningWorkItemDependencyMutationReceipt(
          reservation.response,
          reservationRequest.workspaceId,
          'update',
          dependencyId,
        )
        const planning = await readPlanningWorkItemDependencyReplaySnapshot(
          principal,
          replay.dependency,
          'update',
          replay.revision,
        )
        c.header('Idempotency-Replayed', 'true')
        return c.json(planning, replay.status)
      }
      reservationToRelease = {
        ...reservationRequest,
        reservationId: reservation.reservationId,
      }
      const transaction = createPlanningWorkItemDependencyIdempotencyTransaction(
        reservationRequest.workspaceId,
        {
          credentialId: reservationRequest.credentialId,
          idempotencyKey,
          requestFingerprint: reservationRequest.requestFingerprint,
          reservationId: reservation.reservationId,
        },
        'update',
        dependencyId,
      )
      if (!transaction) throw planningWorkItemDependencyIdempotencyUnavailable()
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = filterPlanningSnapshotForPrincipal(
        principal,
        await workItemDependencies.planning.get(principal.directoryId, workItemState),
      )
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      const dependency = snapshot.workItemDependencies.find((candidate) =>
        candidate.id === dependencyId
      )
      if (!dependency) {
        throw new PlanningError(
          404,
          'PlanningWorkItemDependencyNotFound',
          'Work Item dependency was not found.',
        )
      }
      await Promise.all([
        requirePlanningWorkItemEndpointPermission(principal, dependency.predecessor, 'manager'),
        requirePlanningWorkItemEndpointPermission(principal, dependency.successor, 'manager'),
      ])
      const response = await workItemDependencies.planning.updateWorkItemDependency(
        principal.directoryId,
        dependencyId,
        input,
        workItemState,
        createPlanningCallerAuthorizationConditionChecks(principal),
        transaction,
      )
      mutationCommitted = true
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
    } catch (error) {
      if (reservationToRelease && !mutationCommitted) {
        await releasePlanningWorkItemDependencyReservation(reservationToRelease)
      }
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Deletes one canonical Work Item schedule dependency after authorizing both endpoints. */
  routeApp.delete('/api/planning/work-item-dependencies/:dependencyId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    let reservationToRelease: ReleaseIdempotencyRequest | undefined
    let mutationCommitted = false
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const idempotencyKey = readRequiredPlanningWorkItemDependencyIdempotencyKey(
        c.req.header('Idempotency-Key'),
      )
      const dependencyId = readPlanningRouteId(
        c.req.param('dependencyId'),
        'Work Item dependency ID',
      )
      const input = await readPlanningJson<PlanningRevisionInput>(c.req)
      const canonicalPath = `/api/planning/work-item-dependencies/${dependencyId}`
      const reservationRequest = createPlanningWorkItemDependencyReservationRequest(
        principal,
        idempotencyKey,
        c.req.method,
        canonicalPath,
        input,
      )
      const reservation = await reservePlanningWorkItemDependencyMutation(reservationRequest)
      if (reservation.status === 'in-progress') {
        throw new PlanningError(
          409,
          'PlanningWorkItemDependencyIdempotencyInProgress',
          'The same Work Item dependency mutation is still in progress.',
        )
      }
      if (reservation.status === 'replay') {
        const replay = readStoredPlanningWorkItemDependencyMutationReceipt(
          reservation.response,
          reservationRequest.workspaceId,
          'delete',
          dependencyId,
        )
        const planning = await readPlanningWorkItemDependencyReplaySnapshot(
          principal,
          replay.dependency,
          'delete',
          replay.revision,
        )
        c.header('Idempotency-Replayed', 'true')
        return c.json(planning, replay.status)
      }
      reservationToRelease = {
        ...reservationRequest,
        reservationId: reservation.reservationId,
      }
      const transaction = createPlanningWorkItemDependencyIdempotencyTransaction(
        reservationRequest.workspaceId,
        {
          credentialId: reservationRequest.credentialId,
          idempotencyKey,
          requestFingerprint: reservationRequest.requestFingerprint,
          reservationId: reservation.reservationId,
        },
        'delete',
        dependencyId,
      )
      if (!transaction) throw planningWorkItemDependencyIdempotencyUnavailable()
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = filterPlanningSnapshotForPrincipal(
        principal,
        await workItemDependencies.planning.get(principal.directoryId, workItemState),
      )
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      const dependency = snapshot.workItemDependencies.find((candidate) =>
        candidate.id === dependencyId
      )
      if (!dependency) {
        throw new PlanningError(
          404,
          'PlanningWorkItemDependencyNotFound',
          'Work Item dependency was not found.',
        )
      }
      await Promise.all([
        requirePlanningWorkItemEndpointPermission(principal, dependency.predecessor, 'manager'),
        requirePlanningWorkItemEndpointPermission(principal, dependency.successor, 'manager'),
      ])
      const response = await workItemDependencies.planning.deleteWorkItemDependency(
        principal.directoryId,
        dependencyId,
        input,
        workItemState,
        createPlanningCallerAuthorizationConditionChecks(principal),
        transaction,
      )
      mutationCommitted = true
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
    } catch (error) {
      if (reservationToRelease && !mutationCommitted) {
        await releasePlanningWorkItemDependencyReservation(reservationToRelease)
      }
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Canonical Work Item と Cycle / Milestone / Goal の link を作成または置換します。 */
  routeApp.put('/api/planning/work-item-links/:teamId/:workItemId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const teamId = readPlanningRouteId(c.req.param('teamId'), 'Team ID')
      const workItemId = readPlanningRouteId(c.req.param('workItemId'), 'Work Item ID')
      const input = await readPlanningJson<PlanningWorkItemLinkInput>(c.req)
      if (input.teamId !== teamId || input.workItemId !== workItemId) {
        throw new PlanningError(
          400,
          'PlanningWorkItemPathMismatch',
          'Work Item link path and request body IDs must match.',
        )
      }
      const projectId = input.projectId === undefined
        ? undefined
        : readPlanningIdentifier(input.projectId, 'Project ID')
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
      if (
        projectId !== undefined &&
        projectId !== detail.issue.assignedProjectId
      ) {
        throw new PlanningError(
          409,
          'PlanningWorkItemProjectMismatch',
          'Work Item link Project does not match the canonical Work Item.',
        )
      }
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      const current = await workItemDependencies.planning.getWorkItemLinkForAuthorization(
        principal.directoryId,
        teamId,
        workItemId,
      )
      if (current) {
        await requirePlanningLinkEntityPermissions(
          principal,
          snapshot.entities,
          current,
        )
      }
      await requirePlanningLinkEntityPermissions(principal, snapshot.entities, input)
      const response = await workItemDependencies.planning.putWorkItemLink(principal.directoryId, input, workItemState)
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Canonical Work Item の Planning link を削除します。 */
  routeApp.delete('/api/planning/work-item-links/:teamId/:workItemId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const teamId = readPlanningRouteId(c.req.param('teamId'), 'Team ID')
      const workItemId = readPlanningRouteId(c.req.param('workItemId'), 'Work Item ID')
      const input = await readPlanningJson<PlanningRevisionInput>(c.req)
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      const current = snapshot.workItemLinks.find((link) =>
        link.teamId === teamId && link.workItemId === workItemId,
      )
      if (current) {
        await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
        await requirePlanningLinkEntityPermissions(principal, snapshot.entities, current)
      } else if (!principal.isSystemAdmin) {
        requireWorkspaceAdministration(principal)
      }
      const response = await workItemDependencies.planning.deleteWorkItemLink(
        principal.directoryId,
        teamId,
        workItemId,
        input,
        workItemState,
      )
      return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })

  /** Cycle を完了し、未完了 Work Item を設定済み policy で rollover します。 */
  routeApp.post('/api/planning/cycles/:cycleId/rollover', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const cycleId = readPlanningRouteId(c.req.param('cycleId'), 'Cycle ID')
      const input = await readPlanningJson<CycleRolloverInput>(c.req)
      const workItemState = await readPlanningWorkItemState(principal)
      const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
      requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
      await Promise.all([
        requirePlanningEntityPermission(principal, snapshot.entities, cycleId, 'manager'),
        requirePlanningEntityPermission(
          principal,
          snapshot.entities,
          input.targetCycleId,
          'manager',
        ),
      ])
      const response = await workItemDependencies.planning.rolloverCycle(
        principal.directoryId,
        cycleId,
        input,
        workItemState,
      )
      return c.json({
        ...response,
        planning: filterPlanningSnapshotForPrincipal(principal, response.planning),
      })
    } catch (error) {
      return toPlanningErrorResponse(c, error)
    }
  })
}
