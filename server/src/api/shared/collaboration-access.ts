import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { normalizeProjectMemberKey, ProjectDataError } from '../../modules/directory'
import {
  isTeamIssueNotFoundError,
  WorkItemScheduleError,
  type TeamIssueResponseItem,
} from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  CollaborationError,
  type CollaborationAutomaticWatcherCandidate,
  type CollaborationAuthorizationConditionCheck,
  type CollaborationComment,
} from '../../modules/collaboration/collaboration'
import { type FileProofingActor, type FileProofingScope } from '../../modules/files/file-proofing'
import { WorkItemConfigurationError } from '../../modules/work-items/work-item-configuration'
import { authenticationDependencies, workspaceDependencies } from './app-dependencies'
import { toCognitoDirectoryErrorResponse } from './enterprise-access'
import { readRequiredRouteId } from './input-parsing'
import {
  createEnterpriseControlAuthorizationConditionCheck,
  requireAssignedProjectPermission,
  requireTeamPermission,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from './project-access'
import { canWriteTeamIssue, loadAuthorizedTeamIssue } from './work-item-access'
import { projectAccessAllows, type TeamPermissionContext } from './workspace-access'

/**
 * Converts Work Item configuration failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toWorkItemConfigurationErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }
  if (error instanceof CollaborationError) {
    return toCollaborationErrorResponse(c, error)
  }
  if (
    error instanceof WorkspaceAccessError ||
    error instanceof ProjectDataError ||
    isTeamIssueNotFoundError(error)
  ) {
    return toProjectDataErrorResponse(c, error)
  }
  if (error instanceof WorkItemScheduleError) {
    const status = error.status === 400 ||
        error.status === 403 ||
        error.status === 409 ||
        error.status === 413 ||
        error.status === 503
      ? error.status
      : 500
    return c.json({ code: error.code, message: error.message }, status)
  }
  if (!(error instanceof WorkItemConfigurationError)) {
    console.error(error)
    return c.json({ message: 'Work Item configuration is unavailable.' }, 502)
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Converts collaboration failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toCollaborationErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }

  if (!(error instanceof CollaborationError)) {
    return toProjectDataErrorResponse(c, error)
  }

  if (error.status >= 500) {
    console.error(error)
  }

  const status = error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 503
    ? error.status
    : 502

  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Loads the file proofing scope and actor for the current route.
 *
 * @param c - Hono request context.
 * @param principal - Authenticated Workspace principal.
 * @param kind - File proofing scope kind.
 * @returns The scope, actor, and optional Work Item for the request.
 */
export async function loadFileProofingRequestContext(
  c: Context,
  principal: WorkspacePrincipal,
  kind: FileProofingScope['kind'],
): Promise<{
  scope: FileProofingScope
  actor: FileProofingActor
  workItem?: TeamIssueResponseItem
}> {
  const teamId = readRequiredRouteId(c.req.param('teamId'), 'Team ID')

  if (kind === 'work-item') {
    const issueId = readRequiredRouteId(c.req.param('issueId'), 'Work Item ID')
    const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    return {
      scope: {
        workspaceId: principal.directoryId,
        teamId,
        kind,
        issueId,
        ...(detail.issue.assignedProjectId
          ? { projectId: detail.issue.assignedProjectId }
          : {}),
      },
      actor: {
        memberKey: principal.userKey,
        guest: principal.workspaceRole === 'guest',
        canWrite: canWriteTeamIssue(principal, context, detail.issue.assignedProjectId),
        canManage: principal.workspaceRole !== 'guest' &&
          canManageTeamIssueCollaboration(
            principal,
            context,
            detail.issue.assignedProjectId,
          ),
      },
      workItem: detail.issue,
    }
  }

  const projectId = readRequiredRouteId(c.req.param('projectId'), 'Project ID')
  const context = await requireTeamPermission(principal, teamId, 'viewer')
  if (!context.team.projects.some((project) => project.id === projectId)) {
    throw new ProjectDataError(
      404,
      'ProjectNotFound',
      `Project "${projectId}" was not found in team "${teamId}".`,
    )
  }
  requireAssignedProjectPermission(principal, context, projectId, 'viewer')
  const projectAccess = context.projectAccesses?.find((access) => access.projectId === projectId)
  const canWrite = principal.workspaceRole !== 'guest' && (
    principal.isSystemAdmin ||
    (projectAccess !== undefined && projectAccessAllows(projectAccess, 'member'))
  )
  const canManage = principal.workspaceRole !== 'guest' && (
    canModerateCollaboration(principal) ||
    (projectAccess !== undefined && projectAccessAllows(projectAccess, 'manager'))
  )

  return {
    scope: {
      workspaceId: principal.directoryId,
      teamId,
      kind,
      projectId,
    },
    actor: {
      memberKey: principal.userKey,
      guest: principal.workspaceRole === 'guest',
      canWrite,
      canManage,
    },
  }
}

function canModerateCollaboration(principal: WorkspacePrincipal) {
  return principal.isSystemAdmin ||
    principal.workspaceRole === 'owner' ||
    principal.workspaceRole === 'admin'
}

/**
 * Checks whether the principal can moderate collaboration on the Work Item.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Team permission context of the principal.
 * @param assignedProjectId - Project the Work Item is assigned to.
 * @returns `true` when the principal may manage the collaboration.
 */
export function canManageTeamIssueCollaboration(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  assignedProjectId: string | undefined,
) {
  if (canModerateCollaboration(principal)) {
    return true
  }

  if (!assignedProjectId) {
    return context.projectAccesses?.some((access) => projectAccessAllows(access, 'manager')) ?? false
  }

  const access = context.projectAccesses?.find((entry) => entry.projectId === assignedProjectId)
  return access !== undefined && projectAccessAllows(access, 'manager')
}

/**
 * Lists the members who automatically watch a Work Item.
 *
 * @param issue - Work Item response item.
 * @returns The automatic watcher candidates.
 */
export function createTeamIssueAutomaticWatcherCandidates(
  issue: TeamIssueResponseItem,
): CollaborationAutomaticWatcherCandidate[] {
  return [
    ...(issue.creatorMemberKey
      ? [{ memberKey: issue.creatorMemberKey, reason: 'creator' as const }]
      : []),
    ...(issue.assigneeUserId
      ? [{ memberKey: issue.assigneeUserId, reason: 'assignee' as const }]
      : []),
  ]
}

/** Builds commit-time authorization fences for a direct Work Item comment mutation.
 *
 * @param principal - Authenticated Workspace principal making the comment request.
 * @param context - Team and Project authorization snapshot used to authorize the request.
 * @param teamId - Team owning the Work Item.
 * @param projectId - Project currently assigned to the Work Item, when present.
 * @returns Condition checks that must pass in the same transaction as the comment write.
 */
export async function createCollaborationCommentAuthorizationConditionChecks(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  teamId: string,
  projectId: string | undefined,
): Promise<CollaborationAuthorizationConditionCheck[]> {
  const createActiveReferenceConditionChecks =
    workspaceDependencies.projectDirectory.createActiveReferenceConditionChecks
  if (!createActiveReferenceConditionChecks) {
    throw new CollaborationError(
      503,
      'CollaborationAuthorizationUnavailable',
      'Comment authorization fencing is unavailable. Retry the request.',
    )
  }
  const checks = readCollaborationAuthorizationConditionChecks(
    await createActiveReferenceConditionChecks.call(
      workspaceDependencies.projectDirectory,
      principal.directoryId,
      teamId,
      projectId,
    ),
  )

  if (principal.isSystemAdmin) return checks

  const createActiveMemberConditionCheck =
    workspaceDependencies.workspaceAccess.createActiveMemberConditionCheck
  if (!createActiveMemberConditionCheck) {
    throw new CollaborationError(
      503,
      'CollaborationAuthorizationUnavailable',
      'Comment authorization fencing is unavailable. Retry the request.',
    )
  }
  const actorMembershipCheck = await createActiveMemberConditionCheck.call(
    workspaceDependencies.workspaceAccess,
    principal.directoryId,
    normalizeProjectMemberKey(principal.userKey),
    { allowedRoles: ['owner', 'admin', 'member'] },
  )
  if (!actorMembershipCheck) {
    throw new CollaborationError(
      409,
      'CollaborationActorMembershipChanged',
      'Workspace membership changed while the comment was being prepared.',
    )
  }
  checks.push(...readCollaborationAuthorizationConditionChecks([actorMembershipCheck]))

  if (!projectId) return checks

  const enterpriseProjectAccess = principal.enterpriseProjectAccesses?.some((access) =>
    access.projectId === projectId && projectAccessAllows(access, 'member')
  ) === true
  const enterpriseTeamAccess = principal.enterpriseTeamAccesses?.some((access) =>
    access.teamId === teamId && access.permissions.includes('teams.write')
  ) === true
  const enterpriseRouteAccess = principal.enterpriseRouteAuthorizedAtResource === true &&
    (
      principal.enterpriseAuthorizationResource?.kind === 'workspace' ||
      principal.enterpriseAuthorizationResource?.kind === 'team' &&
        principal.enterpriseAuthorizationResource.targetId === teamId
    ) && principal.enterprisePermissions?.includes('teams.write') === true

  if (enterpriseProjectAccess || enterpriseTeamAccess || enterpriseRouteAccess) {
    const enterpriseControlCheck = createEnterpriseControlAuthorizationConditionCheck(principal)
    if (enterpriseControlCheck) {
      checks.push(...readCollaborationAuthorizationConditionChecks([enterpriseControlCheck]))
    }
    return checks
  }

  const projectAccess = context.projectAccesses?.find((access) => access.projectId === projectId)
  if (!projectAccess || !projectAccessAllows(projectAccess, 'member')) {
    throw new CollaborationError(
      403,
      'CollaborationProjectAccessDenied',
      'The caller no longer has access to the assigned Project.',
    )
  }
  const createProjectAccessConditionCheck =
    workspaceDependencies.projectDirectory.createProjectAccessConditionCheck
  if (!createProjectAccessConditionCheck) {
    throw new CollaborationError(
      503,
      'CollaborationAuthorizationUnavailable',
      'Comment authorization fencing is unavailable. Retry the request.',
    )
  }
  const projectAccessCheck = await createProjectAccessConditionCheck.call(
    workspaceDependencies.projectDirectory,
    principal.directoryId,
    projectId,
    normalizeProjectMemberKey(principal.userKey),
    'member',
  )
  if (!projectAccessCheck) {
    throw new CollaborationError(
      409,
      'CollaborationProjectAccessChanged',
      'Project authorization changed while the comment was being prepared.',
    )
  }
  checks.push(...readCollaborationAuthorizationConditionChecks([projectAccessCheck]))
  return checks
}

/**
 * Narrows directory transaction contributions to read-only condition checks.
 *
 * @param items - Directory transaction contributions returned by the authoritative reader.
 * @returns Condition checks safe to append to a Collaboration comment transaction.
 */
export function readCollaborationAuthorizationConditionChecks(
  items: NonNullable<TransactWriteCommandInput['TransactItems']>,
): CollaborationAuthorizationConditionCheck[] {
  const checks: CollaborationAuthorizationConditionCheck[] = []
  for (const item of items) {
    if (
      item.ConditionCheck === undefined ||
      item.Delete !== undefined ||
      item.Put !== undefined ||
      item.Update !== undefined
    ) {
      throw new CollaborationError(
        503,
        'CollaborationAuthorizationUnavailable',
        'Comment authorization fencing is unavailable. Retry the request.',
      )
    }
    checks.push({ ConditionCheck: item.ConditionCheck })
  }
  if (checks.length === 0) {
    throw new CollaborationError(
      503,
      'CollaborationAuthorizationUnavailable',
      'Comment authorization fencing is unavailable. Retry the request.',
    )
  }
  return checks
}

/**
 * Converts a collaboration comment into its API response with caller capabilities.
 *
 * @param comment - Collaboration comment.
 * @param principal - Authenticated Workspace principal.
 * @param context - Team permission context of the principal.
 * @param issue - Work Item response item.
 * @param threadResolved - Whether the comment thread is resolved.
 * @returns The comment response.
 */
export function toCollaborationCommentResponse(
  comment: CollaborationComment,
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  issue: TeamIssueResponseItem,
  threadResolved = false,
) {
  const canWrite = canWriteTeamIssue(principal, context, issue.assignedProjectId)
  const canManage = canManageTeamIssueCollaboration(principal, context, issue.assignedProjectId)
  const isAuthor = comment.authorMemberKey === principal.userKey
  const isRoot = !comment.parentCommentId && comment.rootCommentId === comment.id
  const authorCanMutate = principal.workspaceRole !== 'guest' && isAuthor
  const canResolve = isRoot && !comment.deletedAt && (
    authorCanMutate ||
    canManage ||
    (principal.workspaceRole !== 'guest' && issue.assigneeUserId === principal.userKey)
  )

  return {
    id: comment.id,
    rootCommentId: comment.rootCommentId,
    ...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
    authorMemberKey: comment.authorMemberKey,
    bodyMarkdown: comment.bodyMarkdown,
    version: comment.version,
    mentionMemberKeys: comment.mentionMemberKeys,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    ...(comment.editedAt ? { editedAt: comment.editedAt } : {}),
    ...(comment.deletedAt ? { deletedAt: comment.deletedAt } : {}),
    ...(comment.resolvedAt ? { resolvedAt: comment.resolvedAt } : {}),
    ...(comment.resolvedByMemberKey
      ? { resolvedByMemberKey: comment.resolvedByMemberKey }
      : {}),
    acceptedResolutions: comment.acceptedResolutions,
    reactions: comment.reactions,
    capabilities: {
      canEdit: authorCanMutate && !comment.deletedAt,
      canDelete: (authorCanMutate || canManage) && !comment.deletedAt,
      canResolve,
      canReply: canWrite && !comment.deletedAt && !comment.resolvedAt && !threadResolved,
      canReact: canWrite && !comment.deletedAt,
      canAttach: canWrite && !comment.deletedAt,
      canPromote: canWrite && !comment.deletedAt,
    },
  }
}

/**
 * Requires every mentioned member to be able to see the Work Item.
 *
 * @param workspaceId - Workspace that scopes the operation.
 * @param memberKeys - Mentioned member keys.
 * @param context - Team permission context of the principal.
 * @param assignedProjectId - Project the Work Item is assigned to.
 * @returns The validated mention member keys.
 */
export async function requireValidCommentMentions(
  workspaceId: string,
  memberKeys: string[],
  context: TeamPermissionContext,
  assignedProjectId: string | undefined,
) {
  const activeTeamProjectIds = new Set(context.team.projects.map((project) => project.id))

  await Promise.all(
    memberKeys.map(async (memberKey) => {
      const member = await workspaceDependencies.workspaceAccess.getActiveMember(workspaceId, memberKey)

      if (!member) {
        throw new ProjectDataError(
          400,
          'InvalidCommentMention',
          `Mentioned Workspace member "${memberKey}" is not active.`,
        )
      }

      if (assignedProjectId) {
        const access = await workspaceDependencies.projectDirectory.getProjectAccess(
          workspaceId,
          assignedProjectId,
          memberKey,
        )

        if (
          (!access || !projectAccessAllows(access, 'viewer')) &&
          !(await authenticationDependencies.cognito.isSystemAdmin(memberKey))
        ) {
          throw new ProjectDataError(
            400,
            'InvalidCommentMention',
            `Mentioned Workspace member "${memberKey}" cannot view the assigned project.`,
          )
        }

        return
      }

      const canViewOwningTeam = (await workspaceDependencies.projectDirectory.getProjectAccessList(workspaceId, memberKey))
        .some((access) =>
          activeTeamProjectIds.has(access.projectId) && projectAccessAllows(access, 'viewer'),
        )

      if (!canViewOwningTeam && !(await authenticationDependencies.cognito.isSystemAdmin(memberKey))) {
        throw new ProjectDataError(
          400,
          'InvalidCommentMention',
          `Mentioned Workspace member "${memberKey}" cannot view the owning team.`,
        )
      }
    }),
  )

  return memberKeys
}

/**
 * Reads an optional comment ID from request input.
 *
 * @param value - Raw input value.
 * @param label - Field label used in validation messages.
 * @returns The comment ID, or `undefined` when it is absent.
 */
export function readOptionalCommentId(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', `${label} is invalid.`)
  }

  return value.trim()
}

/**
 * Reads and validates comment mention member keys.
 *
 * @param value - Raw input value.
 * @returns The mention member keys.
 */
export function readCommentMentionMemberKeys(value: unknown) {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value) || value.length > 20) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Issue comment mentions must contain at most 20 Workspace members.',
    )
  }

  const memberKeys = value.map((memberKey) => {
    if (typeof memberKey !== 'string') {
      throw new ProjectDataError(400, 'InvalidProjectWrite', 'Issue comment mention is invalid.')
    }

    return normalizeProjectMemberKey(memberKey)
  })

  return [...new Set(memberKeys)]
}
