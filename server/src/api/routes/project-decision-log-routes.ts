import { createHash } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import {
  createProjectDecisionEntryUseCase,
  readProjectDecisionLogUseCase,
  readTeamDecisionLogUseCase,
  updateProjectDecisionEntryUseCase,
  type ProjectDecisionEntryReferences,
  type ProjectDecisionLogCallerAuthorizationCheck,
} from '../../modules/project-decision-log'
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
 * Registers the Project decision log endpoints and the Team decision log (ADR 0114).
 *
 * Reading needs viewer access to the Project. Recording and editing decisions needs member
 * access, the same role that edits the Project's Work Items and its risk log.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerProjectDecisionLogRoutes(routeApp: Hono): void {
  /** Returns every decision of the Team's Projects the caller may see, with decided change requests. */
  routeApp.get('/api/teams/:teamId/decision-log', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const teamId = c.req.param('teamId')?.trim()
      if (!teamId) throw new ProjectDataError(400, 'InvalidTeamDecisionLogQuery', 'Team ID is required.')
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      const visibleProjectIds = context.team.projects
        .map((project) => project.id)
        .filter((projectId) => canReadProject(principal, context, teamId, projectId))
      const projectId = c.req.query('projectId')?.trim()
      const keyword = c.req.query('q')
      const response = await readTeamDecisionLogUseCase(
        workItemDependencies.projectDecisionLogs,
        { workspaceId: principal.directoryId, teamId, visibleProjectIds },
        {
          ...(keyword === undefined ? {} : { keyword }),
          ...(projectId ? { projectId } : {}),
        },
        async (visibleProjectId) => (await workItemDependencies.projectRaidLogs.list({
          workspaceId: principal.directoryId,
          teamId,
          projectId: visibleProjectId,
        })).filter((entry) => entry.decision !== undefined),
      )
      return c.json(response)
    } catch (error) {
      return toDecisionLogErrorResponse(c, error)
    }
  })

  /** Returns every decision of one Project, newest decision first. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/decision-log', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      await requireProjectRead(principal, teamId, projectId)
      const log = await readProjectDecisionLogUseCase(
        workItemDependencies.projectDecisionLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        { canEdit: await canEditProjectDecisionLog(principal, teamId, projectId) },
      )
      return c.json(log)
    } catch (error) {
      return toDecisionLogErrorResponse(c, error)
    }
  })

  /** Records one decision in a Project log. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/decision-log/entries', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireProjectRead(principal, teamId, projectId)
      if (!await canEditProjectDecisionLog(principal, teamId, projectId)) {
        throw new ProjectDataError(403, 'ProjectDecisionLogForbidden', 'Only a Project member can record decisions.')
      }
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await createProjectDecisionEntryUseCase(
        workItemDependencies.projectDecisionLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createCallerAuthorization(principal, teamId, projectId),
          auditContext,
          entryId: createEntryId(teamId, projectId, auditContext.actor.id, auditContext.idempotencyKeyHash),
          creationFingerprint: auditContext.requestFingerprint,
          recorderMemberId: principal.userKey,
          verifyReferences: (references) => verifyEntryReferences(principal, teamId, projectId, references),
        },
      )
      return c.json(response, 201)
    } catch (error) {
      return toDecisionLogErrorResponse(c, error)
    }
  })

  /** Replaces one decision; superseding, withdrawing, and reinstating are status changes. */
  routeApp.put('/api/teams/:teamId/projects/:projectId/decision-log/entries/:entryId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const entryId = c.req.param('entryId')?.trim()
      if (!entryId) throw new ProjectDataError(400, 'InvalidProjectDecisionEntry', 'Entry ID is required.')
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireProjectRead(principal, teamId, projectId)
      if (!await canEditProjectDecisionLog(principal, teamId, projectId)) {
        throw new ProjectDataError(403, 'ProjectDecisionLogForbidden', 'Only a Project member can change decisions.')
      }
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await updateProjectDecisionEntryUseCase(
        workItemDependencies.projectDecisionLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        entryId,
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createCallerAuthorization(principal, teamId, projectId),
          auditContext,
          updateReceipt: createUpdateReceipt(entryId, auditContext.actor.id, auditContext.idempotencyKeyHash, auditContext.requestFingerprint),
          updateKey: createUpdateKey(entryId, auditContext.actor.id, auditContext.idempotencyKeyHash),
          verifyReferences: (references) => verifyEntryReferences(principal, teamId, projectId, references),
        },
      )
      return c.json(response)
    } catch (error) {
      return toDecisionLogErrorResponse(c, error)
    }
  })
}

/**
 * Tells whether the principal may read one Project of a Team the Team log lists. An Enterprise
 * principal also needs `projects.read` at the Project, because the Team route is authorized at
 * the Team.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context read at viewer level.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns Whether the Project's decisions may be listed.
 */
function canReadProject(principal: WorkspacePrincipal, context: TeamPermissionContext, teamId: string, projectId: string) {
  if (!canAccessAssignedProject(principal, context, projectId, 'viewer')) return false
  return principal.enterprisePermissions === undefined || hasEnterprisePermissionAtResource(principal, 'projects.read', {
    workspaceId: principal.directoryId,
    kind: 'project',
    targetId: projectId,
    parentTeamId: teamId,
  })
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
    throw new ProjectDataError(400, 'InvalidProjectDecisionEntry', 'Team ID and Project ID are required.')
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
 * Builds the commit-time fences that fail a decision write when the caller lost access or the
 * Team or Project was archived after the request was authorized.
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
    throw new ProjectDataError(503, 'ProjectDecisionLogAuthorizationUnavailable', 'Project access cannot be verified.')
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
 * Verifies the deciders and related Work Items a decision gains.
 *
 * Each added decider must be a member of the Project when the decision is recorded; a decider
 * who leaves later stays on the record, so no fence is kept for them. Each added Work Item must
 * be one the caller can read and must belong to this Project, and its fence fails the write when
 * the Work Item is deleted or moved to another Project before it commits. Every refusal answers
 * the same 400 whether the Work Item is missing, hidden, or in another Project, so the response
 * does not reveal which Work Items exist. An Enterprise caller also needs `work-items.read` on the
 * Project, because the write request itself is authorized by `projects.write` alone.
 *
 * @param principal - Authenticated principal changing the decision.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose log is changed.
 * @param references - Added deciders and Work Items.
 * @returns Fences for the added Work Items.
 * @throws ProjectDataError 400 for a reference that is not allowed.
 */
async function verifyEntryReferences(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
  references: ProjectDecisionEntryReferences,
): Promise<ProjectDecisionLogCallerAuthorizationCheck[]> {
  const workItemFences: ProjectDecisionLogCallerAuthorizationCheck[] = []
  const notInProject = (workItemId: string) => new ProjectDataError(
    400,
    'InvalidProjectDecisionEntry',
    `Related Work Item "${workItemId}" is not a Work Item of this Project.`,
  )
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
    throw notInProject(firstAddedWorkItemId)
  }
  for (const workItemId of references.addedWorkItemIds) {
    let assignedProjectId: string | undefined
    try {
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
      assignedProjectId = detail.issue.assignedProjectId
    } catch (error) {
      if (!isHiddenOrMissing(error)) throw error
    }
    if (assignedProjectId !== projectId) throw notInProject(workItemId)
    workItemFences.push(createWorkItemProjectAssignmentConditionCheck(
      getTeamIssuesTableName(),
      principal.directoryId,
      teamId,
      workItemId,
      projectId,
    ))
  }
  if (references.addedDeciderMemberIds.length > 0) {
    const { members } = await workspaceDependencies.projectDirectory.getProjectMembers(
      principal.directoryId,
      projectId,
      teamId,
    )
    const memberIds = new Set(members.map((member) => member.id))
    if (references.addedDeciderMemberIds.some((id) => !memberIds.has(id))) {
      throw new ProjectDataError(400, 'InvalidProjectDecisionEntry', 'Each decider must be a member of the Project.')
    }
  }
  return workItemFences
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
 * @param entryId - Decision being updated.
 * @param actorId - Requesting actor.
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @param requestFingerprint - Fingerprint of the request method, path, and body.
 * @returns A hexadecimal receipt.
 */
function createUpdateReceipt(entryId: string, actorId: string, idempotencyKeyHash: string, requestFingerprint: string) {
  return createHash('sha256')
    .update(JSON.stringify(['project-decision-entry-update', entryId, actorId, idempotencyKeyHash, requestFingerprint]))
    .digest('hex')
}

/**
 * Derives the key of an update request without its content, so the same Idempotency-Key sent
 * again with other content is told apart from a retry.
 *
 * @param entryId - Decision being updated.
 * @param actorId - Requesting actor.
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @returns A hexadecimal key.
 */
function createUpdateKey(entryId: string, actorId: string, idempotencyKeyHash: string) {
  return createHash('sha256')
    .update(JSON.stringify(['project-decision-entry-update-key', entryId, actorId, idempotencyKeyHash]))
    .digest('hex')
}

/**
 * Tells whether the principal may record and edit decisions: a writable Workspace session, member
 * access to the Project resolved at the Team write level, and, for an Enterprise principal,
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
 * @returns Whether the principal may record and edit decisions.
 */
async function canEditProjectDecisionLog(principal: WorkspacePrincipal, teamId: string, projectId: string) {
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
 * Derives the ID of a new decision from the request's idempotency key, so a retried request
 * finds the decision it already recorded instead of adding a second one.
 *
 * @param teamId - Team ID.
 * @param projectId - Project ID.
 * @param actorId - Requesting actor.
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @returns A 32-character hexadecimal entry ID.
 */
function createEntryId(teamId: string, projectId: string, actorId: string, idempotencyKeyHash: string) {
  return createHash('sha256')
    .update(JSON.stringify(['project-decision-entry', teamId, projectId, actorId, idempotencyKeyHash]))
    .digest('hex')
    .slice(0, 32)
}

/**
 * Converts a decision log failure to an HTTP response.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The response.
 */
function toDecisionLogErrorResponse(c: Context, error: unknown) {
  if (
    error instanceof ProjectDataError &&
    (error.code.startsWith('ProjectDecision') || error.code === 'InvalidProjectDecisionEntry' || error.code === 'InvalidTeamDecisionLogQuery')
  ) {
    const status = toDecisionLogStatus(error.status)
    if (status >= 500) {
      // Request headers tie the failure to the request log; the body is not recorded.
      console.error('Decision log request failed.', {
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
 * Narrows a decision log error status to the statuses the endpoints answer with.
 *
 * @param status - Status carried by the error.
 * @returns The same status when it is expected, otherwise 502.
 */
function toDecisionLogStatus(status: number): 400 | 403 | 404 | 409 | 413 | 502 | 503 {
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
