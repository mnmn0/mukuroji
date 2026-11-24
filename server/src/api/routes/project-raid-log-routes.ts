import { createHash } from 'node:crypto'
import type { ProjectRaidLogResponse } from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import { normalizeProjectMemberKey, ProjectDataError } from '../../modules/directory'
import {
  createProjectRaidEntryUseCase,
  decideProjectRaidChangeRequestUseCase,
  holdProjectRaidChangeRequestUseCase,
  readProjectRaidLogUseCase,
  updateProjectRaidEntryUseCase,
  type ProjectRaidEntryReferences,
  type ProjectRaidLogCallerAuthorizationCheck,
} from '../../modules/project-raid-log'
import { createWorkItemProjectAssignmentConditionCheck } from '../../modules/work-items'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { getTeamIssuesTableName, loadAuthorizedTeamIssue } from '../shared/work-item-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import {
  canAccessAssignedProject,
  canWorkspaceBusinessWrite,
  createApiMutationContext,
  hasEnterprisePermissionAtResource,
  requireTeamPermission,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { resolveEnterpriseProjectRole } from '../shared/enterprise-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import type { TeamPermissionContext } from '../shared/workspace-access'

/**
 * Registers the Project risk, issue, and change request log endpoints.
 *
 * Reading needs viewer access to the Project. Adding, editing, closing, and reopening entries
 * needs member access, the same role that edits the Project's Work Items.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerProjectRaidLogRoutes(routeApp: Hono): void {
  /** Returns every entry of one Project log, newest first. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/raid-log', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      await requireProjectRead(principal, teamId, projectId)
      const log = await readProjectRaidLogUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
      )
      const canEdit = await canEditProjectRaidLog(principal, teamId, projectId)
      return c.json({
        ...log,
        viewer: {
          canEdit,
          // The manager role is read only for those who may edit, as deciding requires both.
          canDecide: canEdit && await managesProjectChangeRequests(principal, teamId, projectId),
        },
      } satisfies ProjectRaidLogResponse)
    } catch (error) {
      return toProjectRaidLogErrorResponse(c, error)
    }
  })

  /** Adds one risk, issue, or change request to a Project log. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/raid-log/entries', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireProjectRead(principal, teamId, projectId)
      if (!await canEditProjectRaidLog(principal, teamId, projectId)) {
        throw new ProjectDataError(403, 'ProjectRaidLogForbidden', 'Only a Project member can change the Project log.')
      }
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await createProjectRaidEntryUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createCallerAuthorization(principal, teamId, projectId),
          auditContext,
          entryId: createEntryId(teamId, projectId, auditContext.actor.id, auditContext.idempotencyKeyHash),
          creationFingerprint: auditContext.requestFingerprint,
          verifyReferences: (references) => verifyEntryReferences(principal, teamId, projectId, references),
        },
      )
      return c.json(response, 201)
    } catch (error) {
      return toProjectRaidLogErrorResponse(c, error)
    }
  })

  /** Replaces one entry; closing and reopening are status changes. */
  routeApp.put('/api/teams/:teamId/projects/:projectId/raid-log/entries/:entryId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const entryId = c.req.param('entryId')?.trim()
      if (!entryId) throw new ProjectDataError(400, 'InvalidProjectRaidEntry', 'Entry ID is required.')
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireProjectRead(principal, teamId, projectId)
      if (!await canEditProjectRaidLog(principal, teamId, projectId)) {
        throw new ProjectDataError(403, 'ProjectRaidLogForbidden', 'Only a Project member can change the Project log.')
      }
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await updateProjectRaidEntryUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        entryId,
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createCallerAuthorization(principal, teamId, projectId),
          auditContext,
          updateReceipt: createUpdateReceipt(entryId, auditContext.actor.id, auditContext.idempotencyKeyHash, auditContext.requestFingerprint),
          updateKey: createUpdateKey(entryId, auditContext.actor.id, auditContext.idempotencyKeyHash),
          editorMemberId: principal.userKey,
          verifyReferences: (references) => verifyEntryReferences(principal, teamId, projectId, references),
        },
      )
      return c.json(response)
    } catch (error) {
      return toProjectRaidLogErrorResponse(c, error)
    }
  })

  /**
   * Holds an open change request for the calling manager's approval, so nobody else rejects or
   * edits it while the client applies its date changes (ADR 0078).
   */
  routeApp.post('/api/teams/:teamId/projects/:projectId/raid-log/entries/:entryId/approval-hold', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const entryId = c.req.param('entryId')?.trim()
      if (!entryId) throw new ProjectDataError(400, 'InvalidProjectRaidEntry', 'Entry ID is required.')
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireProjectRead(principal, teamId, projectId)
      if (!await canDecideProjectChangeRequests(principal, teamId, projectId)) {
        throw new ProjectDataError(403, 'ProjectRaidLogForbidden', 'Only a Project manager can approve or reject a change request.')
      }
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await holdProjectRaidChangeRequestUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        entryId,
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createCallerAuthorization(principal, teamId, projectId),
          auditContext,
          updateReceipt: createUpdateReceipt(entryId, auditContext.actor.id, auditContext.idempotencyKeyHash, auditContext.requestFingerprint),
          updateKey: createUpdateKey(entryId, auditContext.actor.id, auditContext.idempotencyKeyHash),
          holderMemberId: principal.userKey,
        },
      )
      return c.json(response)
    } catch (error) {
      return toProjectRaidLogErrorResponse(c, error)
    }
  })

  /**
   * Approves or rejects an open change request and closes it. The client applies the requested
   * date changes and captures the baseline first (ADR 0078).
   */
  routeApp.post('/api/teams/:teamId/projects/:projectId/raid-log/entries/:entryId/decision', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const entryId = c.req.param('entryId')?.trim()
      if (!entryId) throw new ProjectDataError(400, 'InvalidProjectRaidEntry', 'Entry ID is required.')
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireProjectRead(principal, teamId, projectId)
      if (!await canDecideProjectChangeRequests(principal, teamId, projectId)) {
        throw new ProjectDataError(403, 'ProjectRaidLogForbidden', 'Only a Project manager can approve or reject a change request.')
      }
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await decideProjectRaidChangeRequestUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        entryId,
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createCallerAuthorization(principal, teamId, projectId),
          auditContext,
          updateReceipt: createUpdateReceipt(entryId, auditContext.actor.id, auditContext.idempotencyKeyHash, auditContext.requestFingerprint),
          updateKey: createUpdateKey(entryId, auditContext.actor.id, auditContext.idempotencyKeyHash),
          deciderMemberId: principal.userKey,
          verifyBaseline: (baselineId) => verifyActiveBaseline(principal.directoryId, teamId, projectId, baselineId),
        },
      )
      return c.json(response)
    } catch (error) {
      return toProjectRaidLogErrorResponse(c, error)
    }
  })
}

/**
 * Tells whether the principal may approve or reject change requests: a Project member who also
 * manages the Project, as capturing the baseline an approval replaces requires.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns Whether the principal may decide.
 */
async function canDecideProjectChangeRequests(principal: WorkspacePrincipal, teamId: string, projectId: string) {
  return await canEditProjectRaidLog(principal, teamId, projectId) &&
    await managesProjectChangeRequests(principal, teamId, projectId)
}

/**
 * Tells whether the principal manages the Project, the role that deciding a change request
 * needs on top of editing the log.
 *
 * Enterprise principals need `projects.manage` at the Project. For others, a direct Team grant
 * read at viewer level reports every Project role as viewer, so the roles are read again at
 * manager level before refusing.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns Whether the principal manages the Project.
 */
async function managesProjectChangeRequests(principal: WorkspacePrincipal, teamId: string, projectId: string) {
  // The route authorization of a log request proves only `projects.read` or `projects.write`, so
  // Enterprise principals are evaluated for `projects.manage` at this Project, as baseline
  // capture requires.
  if (principal.enterprisePermissions !== undefined) {
    return hasEnterprisePermissionAtResource(principal, 'projects.manage', {
      workspaceId: principal.directoryId,
      kind: 'project',
      targetId: projectId,
      parentTeamId: teamId,
    })
  }
  const context = await requireTeamPermission(principal, teamId, 'viewer')
  if (canAccessAssignedProject(principal, context, projectId, 'manager')) return true
  let managerContext: TeamPermissionContext
  try {
    managerContext = await requireTeamPermission(principal, teamId, 'manager')
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
  return managerContext.directTeamGrant === true || canAccessAssignedProject(principal, managerContext, projectId, 'manager')
}

/**
 * Requires a baseline named by an approval to be the Project's active baseline, which the
 * approver captured just before deciding.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @param baselineId - Baseline named by the approval.
 * @returns No commit-time checks; a later switch of the baseline does not change the record.
 * @throws ProjectDataError 400 when the baseline is not the active one.
 */
async function verifyActiveBaseline(
  directoryId: string,
  teamId: string,
  projectId: string,
  baselineId: string,
): Promise<ProjectRaidLogCallerAuthorizationCheck[]> {
  const active = await workItemDependencies.scheduleBaselines.get(directoryId, teamId, projectId)
  if (active?.id !== baselineId) {
    throw new ProjectDataError(400, 'InvalidProjectRaidDecision', 'The baseline must be the active baseline of this Project.')
  }
  return []
}

/**
 * Reads and trims the Team and Project identifiers of a log route.
 *
 * @param c - Hono request context.
 * @returns The route identifiers.
 * @throws ProjectDataError when either identifier is missing.
 */
function readLogRoute(c: Context) {
  const teamId = c.req.param('teamId')?.trim()
  const projectId = c.req.param('projectId')?.trim()
  if (!teamId || !projectId) {
    throw new ProjectDataError(400, 'InvalidProjectRaidEntry', 'Team ID and Project ID are required.')
  }
  return { teamId, projectId }
}

/**
 * Requires the Project to belong to the Team and the principal to see it.
 *
 * A Project outside the Team and a Project the principal may not see both answer 404, so the
 * response does not reveal which Projects exist.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 */
async function requireProjectRead(principal: WorkspacePrincipal, teamId: string, projectId: string) {
  const context = await requireTeamPermission(principal, teamId, 'viewer')
  const inTeam = context.team.projects.some((project) => project.id === projectId)
  if (!inTeam || !canAccessAssignedProject(principal, context, projectId, 'viewer')) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
  }
}

/**
 * Builds the commit-time fences that fail a log write when the caller lost access or the Team
 * or Project was archived after the request was authorized.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose log is changed.
 * @returns The condition checks.
 * @throws ProjectDataError 503 when the directory cannot build the active-reference fences.
 */
async function createCallerAuthorization(principal: WorkspacePrincipal, teamId: string, projectId: string) {
  const { projectDirectory } = workspaceDependencies
  if (!projectDirectory.createActiveReferenceConditionChecks) {
    throw new ProjectDataError(503, 'ProjectRaidLogAuthorizationUnavailable', 'Project access cannot be verified.')
  }
  return [
    ...createPlanningCallerAuthorizationConditionChecks(
      principal,
      [],
      principal.principalKind !== 'service-account',
    ),
    ...await projectDirectory.createActiveReferenceConditionChecks(principal.directoryId, teamId, projectId),
  ]
}

/**
 * Verifies the owner and the related Work Items an entry gains.
 *
 * The owner must be a member of the Project and an active Workspace member; the returned fence
 * fails the write when the owner is deactivated before it commits. Each added Work Item must be
 * one the caller can read and must belong to this Project, and its fence fails the write when the
 * Work Item is deleted or moved to another Project before it commits. Every refusal answers the same 400
 * whether the Work Item is missing, hidden, or in another Project, so the response does not
 * reveal which Work Items exist. An Enterprise caller also needs `work-items.read` on the Project,
 * because the write request itself is authorized by `projects.write` alone.
 *
 * @param principal - Authenticated principal changing the entry.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose log is changed.
 * @param references - Owner and added Work Items.
 * @returns Fences for the added Work Items and the owner. The owner has none when it did not
 * change or is the caller.
 * @throws ProjectDataError 400 for a reference that is not allowed, 503 when membership cannot be fenced.
 */
async function verifyEntryReferences(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
  references: ProjectRaidEntryReferences,
): Promise<ProjectRaidLogCallerAuthorizationCheck[]> {
  const workItemFences: ProjectRaidLogCallerAuthorizationCheck[] = []
  const [firstAddedWorkItemId] = references.addedWorkItemIds
  if (
    firstAddedWorkItemId !== undefined &&
    principal.enterprisePermissions !== undefined &&
    !hasEnterprisePermissionAtResource(principal, 'work-items.read', {
      workspaceId: principal.directoryId,
      kind: 'project',
      targetId: projectId,
      parentTeamId: teamId,
    })
  ) {
    throw new ProjectDataError(
      400,
      'InvalidProjectRaidEntry',
      `Related Work Item "${firstAddedWorkItemId}" is not a Work Item of this Project.`,
    )
  }
  for (const workItemId of references.addedWorkItemIds) {
    let assignedProjectId: string | undefined
    try {
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
      assignedProjectId = detail.issue.assignedProjectId
    } catch (error) {
      if (!isHiddenOrMissing(error)) throw error
    }
    if (assignedProjectId !== projectId) {
      throw new ProjectDataError(
        400,
        'InvalidProjectRaidEntry',
        `Related Work Item "${workItemId}" is not a Work Item of this Project.`,
      )
    }
    workItemFences.push(createWorkItemProjectAssignmentConditionCheck(
      getTeamIssuesTableName(),
      principal.directoryId,
      teamId,
      workItemId,
      projectId,
    ))
  }
  const { ownerMemberId } = references
  if (ownerMemberId === undefined) return workItemFences
  const notMember = () => new ProjectDataError(
    400,
    'InvalidProjectRaidEntry',
    'The owner must be an active member of the Project.',
  )
  const isCaller = principal.principalKind !== 'service-account' &&
    normalizeProjectMemberKey(principal.workspaceMember.memberKey) === normalizeProjectMemberKey(ownerMemberId)
  // The owner's fence is read before the membership check: removing the owner from the Project
  // advances the member version, so a removal after this read fails the write at commit. The
  // caller's own membership fence already covers a caller who owns the entry, and DynamoDB refuses
  // a transaction that checks the same item twice.
  let fence: ProjectRaidLogCallerAuthorizationCheck | undefined
  if (!isCaller) {
    const { workspaceAccess } = workspaceDependencies
    if (!workspaceAccess.createActiveMemberConditionCheck) {
      throw new ProjectDataError(503, 'ProjectRaidLogAuthorizationUnavailable', 'The owner cannot be verified.')
    }
    fence = await workspaceAccess.createActiveMemberConditionCheck.call(
      workspaceAccess,
      principal.directoryId,
      ownerMemberId,
    )
    if (!fence) throw notMember()
  }
  const { members } = await workspaceDependencies.projectDirectory.getProjectMembers(
    principal.directoryId,
    projectId,
    teamId,
  )
  if (!members.some((member) => member.id === ownerMemberId)) throw notMember()
  return fence ? [...workItemFences, fence] : workItemFences
}

/**
 * Tells whether a Work Item read failed because the Work Item is missing or hidden from the caller.
 *
 * @param error - Thrown error.
 * @returns Whether the error carries status 403 or 404.
 */
function isHiddenOrMissing(error: unknown) {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false
  return error.status === 403 || error.status === 404
}

/**
 * Derives the receipt of an update request, so a retry of the same request with the same
 * Idempotency-Key is recognized after its first attempt committed.
 *
 * @param entryId - Entry being updated.
 * @param actorId - Requesting actor.
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @param requestFingerprint - Fingerprint of the request method, path, and body.
 * @returns A hexadecimal receipt.
 */
function createUpdateReceipt(entryId: string, actorId: string, idempotencyKeyHash: string, requestFingerprint: string) {
  return createHash('sha256')
    .update(JSON.stringify(['project-raid-entry-update', entryId, actorId, idempotencyKeyHash, requestFingerprint]))
    .digest('hex')
}

/**
 * Derives the key of an update request without its content, so the same Idempotency-Key sent
 * again with other content is told apart from a retry.
 *
 * @param entryId - Entry being updated.
 * @param actorId - Requesting actor.
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @returns A hexadecimal key.
 */
function createUpdateKey(entryId: string, actorId: string, idempotencyKeyHash: string) {
  return createHash('sha256')
    .update(JSON.stringify(['project-raid-entry-update-key', entryId, actorId, idempotencyKeyHash]))
    .digest('hex')
}

/**
 * Tells whether the principal may change a Project log: a writable Workspace session, member
 * access to the Project resolved at the Team write level (so a Team-wide grant such as an
 * Enterprise Team member keeps its effective role), and, for an Enterprise principal,
 * `projects.write` on the Project.
 *
 * @remarks
 * The Enterprise Project accesses on the principal carry the role of the current route's
 * permission, so on a read they are viewer even for a Project member. Once `projects.write`
 * holds on this Project, the check uses the role that grant gives, the same role a write
 * request resolves, so the read reports the access the write will get.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns Whether the principal may add and edit entries.
 */
async function canEditProjectRaidLog(principal: WorkspacePrincipal, teamId: string, projectId: string) {
  if (!canWorkspaceBusinessWrite(principal)) return false
  let writer = principal
  if (principal.enterprisePermissions !== undefined) {
    if (!hasEnterprisePermissionAtResource(principal, 'projects.write', {
      workspaceId: principal.directoryId,
      kind: 'project',
      targetId: projectId,
      parentTeamId: teamId,
    })) {
      return false
    }
    writer = {
      ...principal,
      enterpriseProjectAccesses: [
        ...(principal.enterpriseProjectAccesses ?? []).filter((access) =>
          access.projectId !== projectId || (access.teamId !== undefined && access.teamId !== teamId)
        ),
        { teamId, projectId, role: resolveEnterpriseProjectRole(['projects.write']) },
      ],
    }
  }
  let context: TeamPermissionContext
  try {
    context = await requireTeamPermission(writer, teamId, 'member')
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
  return canAccessAssignedProject(writer, context, projectId, 'member')
}

/**
 * Derives the ID of a new entry from the request's idempotency key, so a retried request finds
 * the entry it already created instead of adding a second one.
 *
 * @param teamId - Team ID.
 * @param projectId - Project ID.
 * @param actorId - Requesting actor.
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @returns A 32-character hexadecimal entry ID.
 */
function createEntryId(teamId: string, projectId: string, actorId: string, idempotencyKeyHash: string) {
  return createHash('sha256')
    .update(JSON.stringify(['project-raid-entry', teamId, projectId, actorId, idempotencyKeyHash]))
    .digest('hex')
    .slice(0, 32)
}

/**
 * Converts a log failure to an HTTP response.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The response.
 */
function toProjectRaidLogErrorResponse(c: Context, error: unknown) {
  if (
    error instanceof ProjectDataError &&
    (error.code.startsWith('ProjectRaid') || error.code === 'InvalidProjectRaidEntry' || error.code === 'InvalidProjectRaidDecision')
  ) {
    const status = toProjectRaidLogStatus(error.status)
    if (status >= 500) {
      // Request headers tie the failure to the request log; the body is not recorded.
      console.error('Project log request failed.', {
        status,
        code: error.code,
        requestId: c.req.header('X-Request-Id'),
        correlationId: c.req.header('X-Correlation-Id')?.trim(),
        error,
      })
    }
    return c.json({ code: error.code, message: error.message }, status)
  }
  return toProjectDataErrorResponse(c, error)
}

/**
 * Narrows a Project log error status to the statuses the endpoints answer with.
 *
 * @param status - Status carried by the error.
 * @returns The same status when it is expected, otherwise 502.
 */
function toProjectRaidLogStatus(status: number): 400 | 403 | 404 | 409 | 413 | 502 | 503 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 413:
    case 503:
      return status
    default:
      return 502
  }
}
