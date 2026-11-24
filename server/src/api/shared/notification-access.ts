import { type EnterprisePermissionId } from '@mukuroji/contracts'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { normalizeProjectMemberKey, type ProjectAccessEntry } from '../../modules/directory'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import {
  createPlanningEntityCollaborationEntityKey,
  createPlanningUpdateCollaborationEntityKey,
  createPlanningUpdatePublicTargetKey,
} from '../../modules/collaboration/collaboration'
import { NotificationError, type NotificationItem } from '../../modules/notifications/notifications'
import { requiresCurrentWorkItemAssignee, requiresCurrentWorkItemContributor } from '../../modules/notifications'
import { TriageError } from '../../modules/triage'
import { evaluateEnterpriseAccess } from '../../modules/enterprise-identity'
import {
  createPlanningUpdateTargetRecordKey,
  readPlanningUpdateTargetId,
  type PlanningAuthorizationState,
} from '../../modules/planning'
import { ANALYTICS_REPORT_DELIVERED_EVENT_TYPE } from '../../modules/analytics'
import {
  DocumentError,
  type DocumentAccessContext,
  type DocumentProjectRole,
} from '../../modules/documents'
import { canReadAnalyticsReport } from './analytics-access'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import {
  ENTERPRISE_PLANNING_READ_PERMISSIONS,
  ENTERPRISE_PLANNING_WRITE_PERMISSIONS,
  ENTERPRISE_WORK_ITEM_READ_PERMISSIONS,
} from './constants'
import { resolveEnterpriseDocumentScopeAccess } from './document-access'
import { type EnterpriseProjectScopeAccess } from './enterprise-access'
import { toAuthErrorResponse } from './http'
import { requiresCurrentPlanningUpdateTarget } from './planning-access'
import { PLANNING_MILESTONE_NOTIFICATION_EVENT_TYPES } from './planning-entity-audit'
import {
  collapseProjectAccessesById,
  createDocumentEnterpriseScopeBoundary,
  getEffectiveProjectScopeAccessList,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from './project-access'
import { requiresCurrentTriageOwner } from './request-intake-access'
import { createWorkspaceSearchContext } from './search-access'
import { projectAccessAllows } from './workspace-access'

/** Current Inbox visibility of one scheduled Analytics delivery notification. */
type AnalyticsDeliveryNotificationVisibility =
  | {
    /** The recipient can still open the delivered report. */
    readable: true
    /** Current report name replacing the name captured at delivery. */
    name: string
  }
  | {
    /** The report is gone or no longer admits the recipient. */
    readable: false
  }

/**
 * Converts notification failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toNotificationErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toAuthErrorResponse(c, error)
  }
  if (!(error instanceof NotificationError)) {
    return toProjectDataErrorResponse(c, error)
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Revalidates one scheduled Planning notification against the strong authorization snapshot.
 *
 * @param notification - Persisted notification whose target metadata is untrusted.
 * @param state - Current strongly read Planning authorization state.
 * @param recipientMemberKey - Authenticated Inbox recipient.
 * @returns Current target, scope, and direct-recipient match, or undefined when stale.
 */
function resolveCurrentPlanningNotificationScope(
  notification: NotificationItem,
  state: PlanningAuthorizationState,
  recipientMemberKey: string,
) {
  const kind = notification.planningNotificationKind
  if (
    !kind ||
    notification.eventType !== `planning-update.${kind}` ||
    !notification.planningTargetType ||
    !notification.planningTargetId ||
    !notification.planningTargetRecordKey ||
    !notification.planningNextDueAt
  ) {
    return undefined
  }

  const updateTarget = state.updateTargets.find((candidate) =>
    candidate.target.type === notification.planningTargetType &&
    readPlanningUpdateTargetId(candidate.target) === notification.planningTargetId &&
    createPlanningUpdateTargetRecordKey(candidate.target) === notification.planningTargetRecordKey
  )
  if (!updateTarget || updateTarget.archivedAt || !updateTarget.cadence) {
    return undefined
  }

  const cadence = updateTarget.cadence
  const currentRecipient = kind === 'escalation'
    ? cadence.escalationMemberKey
    : cadence.updateOwnerMemberKey
  if (cadence.nextDueAt !== notification.planningNextDueAt) {
    return undefined
  }
  const currentRecipientMatches =
    currentRecipient?.trim().toLowerCase() === recipientMemberKey.trim().toLowerCase()

  const currentTarget = updateTarget.target
  const planningUpdateTargetKey = createPlanningUpdatePublicTargetKey(currentTarget)
  if (currentTarget.type === 'project') {
    return {
      currentRecipientMatches,
      notificationKind: kind,
      planningUpdateTargetKey,
      teamId: currentTarget.teamId,
      projectId: currentTarget.projectId,
    }
  }
  if (currentTarget.type === 'team') {
    return {
      currentRecipientMatches,
      notificationKind: kind,
      planningUpdateTargetKey,
      teamId: currentTarget.teamId,
    }
  }

  const initiative = state.entities.find((entity) =>
    entity.id === currentTarget.entityId && entity.type === 'initiative'
  )
  if (!initiative || initiative.archivedAt || (initiative.projectId && !initiative.teamId)) {
    return undefined
  }
  return {
    currentRecipientMatches,
    notificationKind: kind,
    planningUpdateTargetKey,
    ...(initiative.teamId ? { teamId: initiative.teamId } : {}),
    ...(initiative.projectId ? { projectId: initiative.projectId } : {}),
  }
}

/** Planning update publish and comment events shown in the Inbox. */
const planningUpdateActivityEventTypes = new Set([
  'planning-update.published',
  'planning-update.health-degraded',
  'planning-update.commented',
])

/** Milestone completion and reschedule events shown in the Inbox. */
const planningMilestoneNotificationEventTypes: ReadonlySet<string> = new Set(
  Object.values(PLANNING_MILESTONE_NOTIFICATION_EVENT_TYPES),
)

/**
 * Reports whether a Milestone notification still names an unarchived Milestone in the scope the
 * notification captured.
 *
 * @param notification - Persisted Milestone notification whose scope metadata is untrusted.
 * @param state - Current strongly read Planning authorization state.
 * @returns Whether the Milestone is still current; a moved Milestone is not.
 */
function isCurrentPlanningMilestone(
  notification: NotificationItem,
  state: PlanningAuthorizationState,
) {
  const milestone = notification.entityId === undefined
    ? undefined
    : state.entities.find((entity) => entity.id === notification.entityId)
  return milestone !== undefined &&
    milestone.type === 'milestone' &&
    milestone.archivedAt === undefined &&
    milestone.teamId === notification.teamId &&
    milestone.projectId === notification.projectId &&
    (milestone.projectId === undefined || milestone.teamId !== undefined)
}

/**
 * Resolves the current target scope of a Planning update publish or comment notification.
 *
 * @param notification - Persisted notification whose target metadata is untrusted.
 * @param state - Current strongly read Planning authorization state.
 * @returns Current target key and Team / Project scope, or undefined when the target is gone.
 */
function resolveCurrentPlanningActivityScope(
  notification: NotificationItem,
  state: PlanningAuthorizationState,
) {
  if (
    !planningUpdateActivityEventTypes.has(notification.eventType) ||
    notification.planningNotificationKind ||
    notification.planningNextDueAt ||
    !notification.planningTargetType ||
    !notification.planningTargetId ||
    !notification.planningTargetRecordKey
  ) {
    return undefined
  }
  const updateTarget = state.updateTargets.find((candidate) =>
    candidate.target.type === notification.planningTargetType &&
    readPlanningUpdateTargetId(candidate.target) === notification.planningTargetId &&
    createPlanningUpdateTargetRecordKey(candidate.target) === notification.planningTargetRecordKey
  )
  if (!updateTarget || updateTarget.archivedAt) return undefined
  const currentTarget = updateTarget.target
  const planningUpdateTargetKey = createPlanningUpdatePublicTargetKey(currentTarget)
  if (currentTarget.type === 'project') {
    return {
      planningUpdateTargetKey,
      teamId: currentTarget.teamId,
      projectId: currentTarget.projectId,
    }
  }
  if (currentTarget.type === 'team') {
    return { planningUpdateTargetKey, teamId: currentTarget.teamId }
  }
  const initiative = state.entities.find((entity) =>
    entity.id === currentTarget.entityId && entity.type === 'initiative'
  )
  if (!initiative || initiative.archivedAt || (initiative.projectId && !initiative.teamId)) {
    return undefined
  }
  return {
    planningUpdateTargetKey,
    ...(initiative.teamId ? { teamId: initiative.teamId } : {}),
    ...(initiative.projectId ? { projectId: initiative.projectId } : {}),
  }
}

/**
 * Creates the filter that hides notifications the principal can no longer see.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns The notification visibility filter.
 */
export async function createNotificationVisibilityFilter(
  principal: WorkspacePrincipal,
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja', true)
  const activeTeamIds = new Set(directory.teams.map((team) => team.id))
  const projectTeamIds = new Map<string, Set<string>>()
  for (const team of directory.teams) {
    for (const project of team.projects) {
      const teamIds = projectTeamIds.get(project.id) ?? new Set<string>()
      teamIds.add(team.id)
      projectTeamIds.set(project.id, teamIds)
    }
  }
  const projectScopeAccesses: ProjectAccessEntry[] = principal.isSystemAdmin
    ? [...projectTeamIds.keys()].map((projectId) => ({
        projectId,
        role: 'manager' as const,
      }))
    : await getEffectiveProjectScopeAccessList(principal)
  const projectAccesses = principal.isSystemAdmin
    ? projectScopeAccesses
    : collapseProjectAccessesById(projectScopeAccesses)
  const enterpriseEvaluation = principal.enterpriseAuthorizationEvaluation
  const isEnterpriseContentPrincipal =
    !principal.isSystemAdmin && principal.enterprisePermissions !== undefined
  const enterpriseProjectScopeAccesses =
    principal.enterpriseProjectScopeAccesses ?? []
  const enterpriseProjectHasPermission = (
    access: EnterpriseProjectScopeAccess,
    permissions: readonly EnterprisePermissionId[],
  ) => permissions.some((permission) => access.permissions.includes(permission))
  const enterpriseTeamHasPermission = (
    teamId: string,
    permissions: readonly EnterprisePermissionId[],
  ) => (principal.enterpriseTeamAccesses ?? []).some((access) =>
    access.teamId === teamId &&
    permissions.some((permission) => access.permissions.includes(permission))
  )
  const enterprisePlanningReadableProjectScopeKeys = new Set(
    enterpriseProjectScopeAccesses
      .filter((access) => enterpriseProjectHasPermission(
        access,
        ENTERPRISE_PLANNING_READ_PERMISSIONS,
      ))
      .map((access) => `${access.teamId}\0${access.projectId}`),
  )
  const enterprisePlanningWritableProjectScopeKeys = new Set(
    enterpriseProjectScopeAccesses
      .filter((access) => enterpriseProjectHasPermission(
        access,
        ENTERPRISE_PLANNING_WRITE_PERMISSIONS,
      ))
      .map((access) => `${access.teamId}\0${access.projectId}`),
  )
  const enterpriseWorkItemReadableProjectScopeKeys = new Set(
    enterpriseProjectScopeAccesses
      .filter((access) => enterpriseProjectHasPermission(
        access,
        ENTERPRISE_WORK_ITEM_READ_PERMISSIONS,
      ))
      .map((access) => `${access.teamId}\0${access.projectId}`),
  )
  const enterprisePlanningReadableTeamIds = new Set(
    (principal.enterpriseTeamAccesses ?? [])
      .filter((access) => enterpriseTeamHasPermission(
        access.teamId,
        ENTERPRISE_PLANNING_READ_PERMISSIONS,
      ))
      .map((access) => access.teamId),
  )
  const enterprisePlanningWritableTeamIds = new Set(
    (principal.enterpriseTeamAccesses ?? [])
      .filter((access) => enterpriseTeamHasPermission(
        access.teamId,
        ENTERPRISE_PLANNING_WRITE_PERMISSIONS,
      ))
      .map((access) => access.teamId),
  )
  const enterpriseWorkItemReadableTeamIds = new Set(
    (principal.enterpriseTeamAccesses ?? [])
      .filter((access) => enterpriseTeamHasPermission(
        access.teamId,
        ENTERPRISE_WORK_ITEM_READ_PERMISSIONS,
      ))
      .map((access) => access.teamId),
  )
  const enterpriseWorkItemReadableProjectIds = new Set(
    enterpriseProjectScopeAccesses
      .filter((access) => enterpriseProjectHasPermission(
        access,
        ENTERPRISE_WORK_ITEM_READ_PERMISSIONS,
      ) && projectTeamIds.get(access.projectId)?.size === 1 &&
        projectTeamIds.get(access.projectId)?.has(access.teamId) === true)
      .map((access) => access.projectId),
  )
  const enterpriseFullyAccessibleWorkItemTeamIds = new Set(
    directory.teams
      .filter((team) => enterpriseWorkItemReadableTeamIds.has(team.id))
      .map((team) => team.id),
  )
  const enterprisePlanningWorkspaceReadable = enterpriseEvaluation
    ? ENTERPRISE_PLANNING_READ_PERMISSIONS.some((permission) =>
        evaluateEnterpriseAccess({
          permission,
          principal: enterpriseEvaluation.principal,
          assignments: enterpriseEvaluation.assignments,
          customRoles: enterpriseEvaluation.snapshot.customRoles,
          groupMappings: enterpriseEvaluation.groupMappings,
          resource: { workspaceId: principal.directoryId, kind: 'workspace' },
        }).allowed
      )
    : false
  const enterprisePlanningWorkspaceWritable = enterpriseEvaluation
    ? ENTERPRISE_PLANNING_WRITE_PERMISSIONS.some((permission) =>
        evaluateEnterpriseAccess({
          permission,
          principal: enterpriseEvaluation.principal,
          assignments: enterpriseEvaluation.assignments,
          customRoles: enterpriseEvaluation.snapshot.customRoles,
          groupMappings: enterpriseEvaluation.groupMappings,
          resource: { workspaceId: principal.directoryId, kind: 'workspace' },
        }).allowed
      )
    : false
  const enterpriseWorkItemWorkspaceReadable = enterpriseEvaluation
    ? ENTERPRISE_WORK_ITEM_READ_PERMISSIONS.some((permission) =>
        evaluateEnterpriseAccess({
          permission,
          principal: enterpriseEvaluation.principal,
          assignments: enterpriseEvaluation.assignments,
          customRoles: enterpriseEvaluation.snapshot.customRoles,
          groupMappings: enterpriseEvaluation.groupMappings,
          resource: { workspaceId: principal.directoryId, kind: 'workspace' },
        }).allowed
      )
    : false
  const accessibleProjectIds = new Set(
    projectAccesses
      .filter((access) =>
        projectAccessAllows(access, 'viewer') &&
        projectTeamIds.has(access.projectId)
      )
      .map((access) => access.projectId),
  )
  const accessibleProjectScopeKeys = new Set<string>()
  const accessiblePlanningTeamIds = new Set<string>()
  const writableProjectScopeKeys = new Set<string>()
  const writablePlanningTeamIds = new Set<string>()
  if (principal.isSystemAdmin) {
    for (const team of directory.teams) {
      accessiblePlanningTeamIds.add(team.id)
      writablePlanningTeamIds.add(team.id)
      for (const project of team.projects) {
        accessibleProjectScopeKeys.add(`${team.id}\0${project.id}`)
        writableProjectScopeKeys.add(`${team.id}\0${project.id}`)
      }
    }
  } else {
    for (const access of projectScopeAccesses) {
      const canView = projectAccessAllows(access, 'viewer')
      const canWrite = projectAccessAllows(access, 'member')
      if (!canView && !canWrite) continue
      const ownerTeamIds = projectTeamIds.get(access.projectId)
      if (!ownerTeamIds) continue
      if (access.teamId) {
        if (ownerTeamIds.has(access.teamId)) {
          const scopeKey = `${access.teamId}\0${access.projectId}`
          if (canView) {
            accessibleProjectScopeKeys.add(scopeKey)
            accessiblePlanningTeamIds.add(access.teamId)
          }
          if (canWrite) {
            writableProjectScopeKeys.add(scopeKey)
            writablePlanningTeamIds.add(access.teamId)
          }
        }
        continue
      }
      if (ownerTeamIds.size === 1) {
        const ownerTeamId = ownerTeamIds.values().next().value
        if (ownerTeamId) {
          const scopeKey = `${ownerTeamId}\0${access.projectId}`
          if (canView) {
            accessibleProjectScopeKeys.add(scopeKey)
            accessiblePlanningTeamIds.add(ownerTeamId)
          }
          if (canWrite) {
            writableProjectScopeKeys.add(scopeKey)
            writablePlanningTeamIds.add(ownerTeamId)
          }
        }
      }
    }
    for (const teamId of principal.enterpriseAuthorizedTeamIds ?? []) {
      if (activeTeamIds.has(teamId)) accessiblePlanningTeamIds.add(teamId)
    }
    for (const teamAccess of principal.enterpriseTeamAccesses ?? []) {
      if (
        activeTeamIds.has(teamAccess.teamId) &&
        teamAccess.permissions.includes('work-items.write')
      ) {
        writablePlanningTeamIds.add(teamAccess.teamId)
      }
    }
    if (principal.enterprisePermissions !== undefined && enterpriseEvaluation) {
      for (const team of directory.teams) {
        for (const project of team.projects) {
          const canWrite = evaluateEnterpriseAccess({
            permission: 'work-items.write',
            principal: enterpriseEvaluation.principal,
            assignments: enterpriseEvaluation.assignments,
            customRoles: enterpriseEvaluation.snapshot.customRoles,
            groupMappings: enterpriseEvaluation.groupMappings,
            resource: {
              workspaceId: principal.directoryId,
              kind: 'project',
              targetId: project.id,
              parentTeamId: team.id,
            },
          }).allowed
          if (canWrite) {
            writableProjectScopeKeys.add(`${team.id}\0${project.id}`)
          }
        }
      }
    }
  }
  const accessibleTeamIds = principal.isSystemAdmin
    ? activeTeamIds
    : new Set(
        [
          ...[...accessibleProjectIds]
            .flatMap((projectId) => [...(projectTeamIds.get(projectId) ?? [])]),
          ...(principal.enterpriseAuthorizedTeamIds ?? [])
            .filter((teamId) => activeTeamIds.has(teamId)),
        ],
      )
  const fullyAccessibleTeamIds = new Set(
    directory.teams
      .filter((team) =>
        principal.isSystemAdmin ||
        principal.enterpriseAuthorizedTeamIds?.includes(team.id) === true ||
        (
          team.projects.length > 0 &&
          team.projects.every((project) => accessibleProjectIds.has(project.id))
        )
      )
      .map((team) => team.id),
  )
  const planningReadableProjectScopeKeys = isEnterpriseContentPrincipal
    ? enterprisePlanningReadableProjectScopeKeys
    : accessibleProjectScopeKeys
  const planningWritableProjectScopeKeys = isEnterpriseContentPrincipal
    ? enterprisePlanningWritableProjectScopeKeys
    : writableProjectScopeKeys
  const planningReadableTeamIds = isEnterpriseContentPrincipal
    ? enterprisePlanningReadableTeamIds
    : accessiblePlanningTeamIds
  const planningWritableTeamIds = isEnterpriseContentPrincipal
    ? enterprisePlanningWritableTeamIds
    : writablePlanningTeamIds
  const workItemReadableProjectScopeKeys = isEnterpriseContentPrincipal
    ? enterpriseWorkItemReadableProjectScopeKeys
    : new Set(accessibleProjectScopeKeys)
  const workItemReadableProjectIds = isEnterpriseContentPrincipal
    ? enterpriseWorkItemReadableProjectIds
    : accessibleProjectIds
  const workItemReadableTeamIds = isEnterpriseContentPrincipal
    ? enterpriseWorkItemReadableTeamIds
    : accessibleTeamIds
  const fullyAccessibleWorkItemTeamIds = isEnterpriseContentPrincipal
    ? enterpriseFullyAccessibleWorkItemTeamIds
    : fullyAccessibleTeamIds
  const workItemScopes = new Map<string, Promise<{
    assigneeMemberKey?: string
    contributorMemberKeys?: string[]
    exists: boolean
    projectId?: string
  }>>()
  const triageScopes = new Map<string, Promise<{
    /** Whether the canonical Triage Entry still exists in this Team. */
    exists: boolean
    /** Current owner used to suppress stale owner-only notifications. */
    ownerUserId?: string
    /** Current assigned Project used to re-evaluate the notification scope. */
    projectId?: string
    /** Current permission-safe title replacing historical source content. */
    title?: string
    /** Whether event summary content must be removed from the response. */
    restricted: boolean
  }>>()
  const enterpriseDocumentScopeAccess =
    resolveEnterpriseDocumentScopeAccess(
      principal,
      directory,
    )
  const documentAccess: DocumentAccessContext = {
    memberKey: principal.userKey,
    workspaceRole: principal.workspaceRole,
    isSystemAdmin: principal.isSystemAdmin,
    ...(enterpriseDocumentScopeAccess ?? {
      projectRoles: Object.fromEntries(
        projectAccesses.flatMap(({ projectId, role }) =>
          role === undefined ? [] : [[projectId, role]]
        ),
      ) as Record<string, DocumentProjectRole>,
      ...createDocumentEnterpriseScopeBoundary(
        principal,
      ),
    }),
  }
  const documentVisibilities = new Map<string, Promise<boolean>>()
  const analyticsReportVisibilities = new Map<string, Promise<AnalyticsDeliveryNotificationVisibility>>()
  let analyticsSearchContext: ReturnType<typeof createWorkspaceSearchContext> | undefined
  const watcherVisibilities = new Map<string, Promise<boolean>>()
  let planningAuthorizationState: Promise<PlanningAuthorizationState> | undefined

  /** Reports whether the principal can read Planning content in one Team / Project scope. */
  const isPlanningScopeReadable = (scope: { teamId?: string; projectId?: string }) =>
    scope.projectId
      ? scope.teamId !== undefined &&
        planningReadableProjectScopeKeys.has(`${scope.teamId}\0${scope.projectId}`)
      : scope.teamId
        ? planningReadableTeamIds.has(scope.teamId)
        : isEnterpriseContentPrincipal
          ? enterprisePlanningWorkspaceReadable
          : principal.workspaceRole !== 'guest'
  /** Reports whether the principal currently watches one Planning entity, such as a Milestone. */
  const isWatchingPlanningEntity = (entityId: string) => {
    const entityKey = createPlanningEntityCollaborationEntityKey(principal.directoryId, entityId)
    let visibility = watcherVisibilities.get(entityKey)
    if (!visibility) {
      visibility = workItemDependencies.collaboration.getWatcherState({
        entityKey,
        memberKey: principal.userKey,
      }).then((watch) => watch.subscribed)
      watcherVisibilities.set(entityKey, visibility)
    }
    return visibility
  }
  /** Reports whether the principal currently watches one Planning update target. */
  const isWatchingPlanningTarget = (planningUpdateTargetKey: string) => {
    const entityKey = createPlanningUpdateCollaborationEntityKey(
      principal.directoryId,
      planningUpdateTargetKey,
    )
    let visibility = watcherVisibilities.get(entityKey)
    if (!visibility) {
      visibility = workItemDependencies.collaboration.getWatcherState({
        entityKey,
        memberKey: principal.userKey,
      }).then((watch) => watch.subscribed)
      watcherVisibilities.set(entityKey, visibility)
    }
    return visibility
  }

  /**
   * Re-checks a scheduled Analytics delivery against the report's current visibility.
   *
   * The snapshot list applies the recipient's data ACL again when the link is opened; this check
   * removes the notification itself once the report is deleted or no longer admits the recipient.
   *
   * @param reportId - Delivered report ID from the notification's entity.
   * @returns The current readability and report name.
   */
  const readAnalyticsReportVisibility = (reportId: string) => {
    let visibility = analyticsReportVisibilities.get(reportId)
    if (!visibility) {
      visibility = (async (): Promise<AnalyticsDeliveryNotificationVisibility> => {
        // Analytics routes require Work Item read; Inbox alone only requires Workspace read.
        if (
          isEnterpriseContentPrincipal &&
          !enterpriseWorkItemWorkspaceReadable &&
          workItemReadableTeamIds.size === 0 &&
          workItemReadableProjectScopeKeys.size === 0
        ) {
          return { readable: false }
        }
        const report = await workItemDependencies.analytics.getReport(principal.directoryId, reportId)
        if (!report) return { readable: false }
        analyticsSearchContext ??= createWorkspaceSearchContext(principal)
        return canReadAnalyticsReport(principal, await analyticsSearchContext, report)
          ? { readable: true, name: report.name }
          : { readable: false }
      })()
      analyticsReportVisibilities.set(reportId, visibility)
    }
    return visibility
  }

  return async (notification: NotificationItem) => {
    if (notification.eventType === ANALYTICS_REPORT_DELIVERED_EVENT_TYPE) {
      if (!notification.entityId) return false
      const visibility = await readAnalyticsReportVisibility(notification.entityId)
      if (!visibility.readable) return false
      notification.title = visibility.name
      return true
    }
    if (planningMilestoneNotificationEventTypes.has(notification.eventType)) {
      planningAuthorizationState ??=
        workItemDependencies.planning.getAuthorizationState(principal.directoryId)
      // Watchers are the only recipients; they must still watch and still read the Milestone.
      return notification.entityId !== undefined &&
        isCurrentPlanningMilestone(notification, await planningAuthorizationState) &&
        isPlanningScopeReadable({
          ...(notification.teamId ? { teamId: notification.teamId } : {}),
          ...(notification.projectId ? { projectId: notification.projectId } : {}),
        }) &&
        await isWatchingPlanningEntity(notification.entityId)
    }
    if (planningUpdateActivityEventTypes.has(notification.eventType)) {
      planningAuthorizationState ??=
        workItemDependencies.planning.getAuthorizationState(principal.directoryId)
      const currentPlanningScope = resolveCurrentPlanningActivityScope(
        notification,
        await planningAuthorizationState,
      )
      // The recipient must read both the scope captured by the update and the current target.
      if (
        !currentPlanningScope ||
        !isPlanningScopeReadable(currentPlanningScope) ||
        !isPlanningScopeReadable({
          ...(notification.teamId ? { teamId: notification.teamId } : {}),
          ...(notification.projectId ? { projectId: notification.projectId } : {}),
        })
      ) {
        return false
      }
      const watcherOnly = notification.reasons.every((reason) => reason === 'watcher')
      if (watcherOnly && !await isWatchingPlanningTarget(currentPlanningScope.planningUpdateTargetKey)) {
        return false
      }
      // Keep the captured scope: Inbox actions save the filtered row, and later checks need it.
      // Planning read access is enough; the generic checks below require Work Item read access.
      return true
    } else if (requiresCurrentPlanningUpdateTarget(notification)) {
      planningAuthorizationState ??=
        workItemDependencies.planning.getAuthorizationState(principal.directoryId)
      const currentPlanningScope = resolveCurrentPlanningNotificationScope(
        notification,
        await planningAuthorizationState,
        principal.userKey,
      )
      if (!currentPlanningScope) return false
      if (
        currentPlanningScope.projectId &&
        (
          !currentPlanningScope.teamId ||
          !planningReadableProjectScopeKeys.has(
            `${currentPlanningScope.teamId}\0${currentPlanningScope.projectId}`,
          )
        )
      ) {
        return false
      }
      if (
        currentPlanningScope.teamId &&
        !currentPlanningScope.projectId &&
        !planningReadableTeamIds.has(currentPlanningScope.teamId)
      ) {
        return false
      }
      const directScopeVisible = currentPlanningScope.projectId
        ? (currentPlanningScope.notificationKind === 'escalation'
            ? planningReadableProjectScopeKeys
            : planningWritableProjectScopeKeys
          ).has(
            `${currentPlanningScope.teamId ?? ''}\0${currentPlanningScope.projectId}`,
          )
        : currentPlanningScope.teamId
          ? (currentPlanningScope.notificationKind === 'escalation'
              ? planningReadableTeamIds
              : planningWritableTeamIds
            ).has(currentPlanningScope.teamId)
          : isEnterpriseContentPrincipal
            ? currentPlanningScope.notificationKind === 'escalation'
              ? enterprisePlanningWorkspaceReadable
              : enterprisePlanningWorkspaceWritable
            : principal.workspaceRole !== 'guest'
      const watcherScopeVisible = currentPlanningScope.projectId
        ? planningReadableProjectScopeKeys.has(
            (currentPlanningScope.teamId ?? '') + '\0' + currentPlanningScope.projectId,
          )
        : currentPlanningScope.teamId
          ? planningReadableTeamIds.has(currentPlanningScope.teamId)
          : isEnterpriseContentPrincipal
            ? enterprisePlanningWorkspaceReadable
            : principal.workspaceRole !== 'guest'
      const directRecipientVisible =
        currentPlanningScope.currentRecipientMatches &&
        notification.reasons.includes(currentPlanningScope.notificationKind) &&
        directScopeVisible
      const watcherEntityKeys = notification.reasons.includes('watcher')
        ? [createPlanningUpdateCollaborationEntityKey(
            principal.directoryId,
            currentPlanningScope.planningUpdateTargetKey,
          )]
        : []
      let currentWatcherVisible = false
      for (const entityKey of watcherEntityKeys) {
        let visibility = watcherVisibilities.get(entityKey)
        if (!visibility) {
          visibility = workItemDependencies.collaboration.getWatcherState({
            entityKey,
            memberKey: principal.userKey,
          }).then((watch) => watch.subscribed)
          watcherVisibilities.set(entityKey, visibility)
        }
        if (await visibility) {
          currentWatcherVisible = true
          break
        }
      }
      if (
        (!directScopeVisible && !currentWatcherVisible) ||
        (currentWatcherVisible && !watcherScopeVisible) ||
        (!directRecipientVisible && !currentWatcherVisible)
      ) return false
      if (currentPlanningScope.teamId) {
        notification.teamId = currentPlanningScope.teamId
      } else {
        delete notification.teamId
      }
      if (currentPlanningScope.projectId) {
        notification.projectId = currentPlanningScope.projectId
      } else {
        delete notification.projectId
      }
    }
    if (notification.eventType.startsWith('document.')) {
      if (!notification.entityId) return false
      let visibility = documentVisibilities.get(notification.entityId)
      if (visibility === undefined) {
        visibility = workItemDependencies.documents.get({
          workspaceId: principal.directoryId,
          documentId: notification.entityId,
          access: documentAccess,
        }).then(() => true).catch((error: unknown) => {
          if (
            error instanceof DocumentError &&
            (error.status === 403 || error.status === 404)
          ) {
            return false
          }
          throw error
        })
        documentVisibilities.set(notification.entityId, visibility)
      }
      if (!await visibility) return false
      return true
    }
    if (notification.teamId && notification.triageEntryId) {
      const scopeKey = `${notification.teamId}\0${notification.triageEntryId}`
      let scope = triageScopes.get(scopeKey)
      if (!scope) {
        scope = workItemDependencies.triage.getEntry(
          principal.directoryId,
          notification.teamId,
          notification.triageEntryId,
        ).then((entry) => ({
          exists: true,
          ...(entry.ownerUserId ? { ownerUserId: entry.ownerUserId } : {}),
          ...(entry.projectId ? { projectId: entry.projectId } : {}),
          title: entry.permission.visibility === 'denied' ||
              entry.retention.redactedAt !== undefined
            ? 'Restricted source'
            : entry.sourcePreview.title,
          restricted: entry.permission.visibility !== 'full' ||
            entry.retention.redactedAt !== undefined,
        })).catch((error: unknown) => {
          if (error instanceof TriageError && error.status === 404) {
            return { exists: false, restricted: true }
          }
          throw error
        })
        triageScopes.set(scopeKey, scope)
      }
      const currentScope = await scope
      if (!currentScope.exists) return false
      if (currentScope.title) notification.title = currentScope.title
      if (currentScope.restricted) delete notification.summary
      if (
        !notification.issueId &&
        requiresCurrentTriageOwner(notification) &&
        (
          !currentScope.ownerUserId ||
          normalizeProjectMemberKey(currentScope.ownerUserId) !==
            normalizeProjectMemberKey(principal.userKey)
        )
      ) {
        return false
      }
      if (currentScope.projectId) {
        notification.projectId = currentScope.projectId
        if (projectTeamIds.get(currentScope.projectId)?.has(notification.teamId) !== true) {
          return false
        }
        if (
          isEnterpriseContentPrincipal &&
          !workItemReadableProjectScopeKeys.has(
            `${notification.teamId}\0${currentScope.projectId}`,
          )
        ) return false
        if (!isEnterpriseContentPrincipal && !accessibleProjectIds.has(currentScope.projectId)) {
          return false
        }
      } else {
        delete notification.projectId
        if (!fullyAccessibleWorkItemTeamIds.has(notification.teamId)) return false
      }
    }
    if (notification.teamId && notification.issueId) {
      const scopeKey = `${notification.teamId}\0${notification.issueId}`
      let scope = workItemScopes.get(scopeKey)
      if (!scope) {
        scope = workItemDependencies.teamIssues.getTeamIssueDetail(
          principal.directoryId,
          notification.teamId,
          notification.issueId,
          { consistentIssueRead: true, includeEvents: false },
        ).then((detail) => {
          return {
            assigneeMemberKey: detail.issue.assigneeUserId.trim().toLowerCase(),
            contributorMemberKeys: (detail.issue.contributorAssignments ?? []).flatMap((assignment) =>
              assignment.memberUserId === undefined ? [] : [assignment.memberUserId.trim().toLowerCase()]),
            exists: true,
            ...(detail.issue.assignedProjectId
              ? { projectId: detail.issue.assignedProjectId }
              : {}),
          }
        }).catch((error: unknown) => {
          if (isTeamIssueNotFoundError(error)) {
            return { exists: false }
          }
          throw error
        })
        workItemScopes.set(scopeKey, scope)
      }
      const currentScope = await scope
      if (!currentScope.exists) {
        return false
      }
      if (
        requiresCurrentWorkItemAssignee(notification) &&
        currentScope.assigneeMemberKey !== principal.userKey
      ) {
        return false
      }
      if (
        requiresCurrentWorkItemContributor(notification) &&
        !currentScope.contributorMemberKeys?.includes(principal.userKey)
      ) {
        return false
      }
      if (currentScope.projectId) {
        notification.projectId = currentScope.projectId
        if (projectTeamIds.get(currentScope.projectId)?.has(notification.teamId) !== true) {
          return false
        }
        return isEnterpriseContentPrincipal
          ? workItemReadableProjectScopeKeys.has(
              `${notification.teamId}\0${currentScope.projectId}`,
            )
          : accessibleProjectIds.has(currentScope.projectId)
      }
      delete notification.projectId
      return activeTeamIds.has(notification.teamId) && workItemReadableTeamIds.has(notification.teamId)
    }
    if (notification.projectId) {
      const teamIds = projectTeamIds.get(notification.projectId)
      return teamIds !== undefined &&
        (!notification.teamId || teamIds.has(notification.teamId)) &&
        (isEnterpriseContentPrincipal
          ? notification.teamId
            ? workItemReadableProjectScopeKeys.has(
                `${notification.teamId}\0${notification.projectId}`,
              )
            : workItemReadableProjectIds.has(notification.projectId)
          : accessibleProjectIds.has(notification.projectId))
    }
    if (notification.teamId) {
      return activeTeamIds.has(notification.teamId) && workItemReadableTeamIds.has(notification.teamId)
    }
    return true
  }
}
