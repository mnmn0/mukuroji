import { createHash } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import {
  createProjectExpenseUseCase,
  decideProjectExpenseUseCase,
  deleteProjectExpenseUseCase,
  listProjectExpensesUseCase,
  updateProjectExpenseUseCase,
  type ProjectExpenseCallerAuthorizationCheck,
  type ProjectExpenseReferences,
} from '../../modules/project-budget'
import { createWorkItemProjectAssignmentConditionCheck } from '../../modules/work-items'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson } from '../shared/http'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import {
  createApiMutationContext,
  hasEnterprisePermissionAtResource,
  requireTeamPermission,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { requireTeamProjectManager } from '../shared/project-manager-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { getTeamIssuesTableName, loadAuthorizedTeamIssue } from '../shared/work-item-access'

/**
 * Registers the Project expense endpoints (ADR 0104).
 *
 * Every endpoint needs manager access to the Project, like the budget report: expense amounts
 * count toward the confidential budget consumption.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerProjectExpenseRoutes(routeApp: Hono): void {
  /** Returns every expense of one Project, newest date first. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/expenses', async (c) => {
    try {
      const { principal, teamId, projectId } = await authorize(c, 'read')
      return c.json(await listProjectExpensesUseCase(
        workItemDependencies.projectExpenses,
        { workspaceId: principal.directoryId, teamId, projectId },
        principal.userKey,
      ))
    } catch (error) {
      return toProjectExpenseErrorResponse(c, error)
    }
  })

  /** Submits one expense, which waits for another Project manager's approval. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/expenses', async (c) => {
    try {
      const { principal, teamId, projectId } = await authorize(c, 'write')
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await createProjectExpenseUseCase(
        workItemDependencies.projectExpenses,
        { workspaceId: principal.directoryId, teamId, projectId },
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createCallerAuthorization(principal, teamId, projectId),
          auditContext,
          expenseId: createExpenseId(teamId, projectId, auditContext.actor.id, auditContext.idempotencyKeyHash),
          creationFingerprint: auditContext.requestFingerprint,
          submitterMemberId: principal.userKey,
          verifyReferences: (references) => verifyExpenseReferences(principal, teamId, projectId, references),
        },
      )
      return c.json(response, 201)
    } catch (error) {
      return toProjectExpenseErrorResponse(c, error)
    }
  })

  /** Replaces a submitted or rejected expense and submits it again. */
  routeApp.put('/api/teams/:teamId/projects/:projectId/expenses/:expenseId', async (c) => {
    try {
      const { principal, teamId, projectId, expenseId } = await authorizeExpense(c)
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await updateProjectExpenseUseCase(
        workItemDependencies.projectExpenses,
        { workspaceId: principal.directoryId, teamId, projectId },
        expenseId,
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createCallerAuthorization(principal, teamId, projectId),
          auditContext,
          ...createChangeReceipts('update', expenseId, auditContext),
          actorMemberId: principal.userKey,
          verifyReferences: (references) => verifyExpenseReferences(principal, teamId, projectId, references),
        },
      )
      return c.json(response)
    } catch (error) {
      return toProjectExpenseErrorResponse(c, error)
    }
  })

  /** Approves or rejects a submitted expense; its submitter cannot decide it. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/expenses/:expenseId/decision', async (c) => {
    try {
      const { principal, teamId, projectId, expenseId } = await authorizeExpense(c)
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await decideProjectExpenseUseCase(
        workItemDependencies.projectExpenses,
        { workspaceId: principal.directoryId, teamId, projectId },
        expenseId,
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createCallerAuthorization(principal, teamId, projectId),
          auditContext,
          ...createChangeReceipts('decision', expenseId, auditContext),
          actorMemberId: principal.userKey,
        },
      )
      return c.json(response)
    } catch (error) {
      return toProjectExpenseErrorResponse(c, error)
    }
  })

  /** Removes an expense that is not approved. */
  routeApp.delete('/api/teams/:teamId/projects/:projectId/expenses/:expenseId', async (c) => {
    try {
      const { principal, teamId, projectId, expenseId } = await authorizeExpense(c)
      const body = await readJson<unknown>(c.req)
      await deleteProjectExpenseUseCase(
        workItemDependencies.projectExpenses,
        { workspaceId: principal.directoryId, teamId, projectId },
        expenseId,
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createCallerAuthorization(principal, teamId, projectId),
          auditContext: createApiMutationContext(c, principal, body),
        },
      )
      return c.body(null, 204)
    } catch (error) {
      return toProjectExpenseErrorResponse(c, error)
    }
  })
}

/** An authorized expense request. */
type AuthorizedExpenseRequest = {
  /** Authenticated principal who manages the Project. */
  principal: WorkspacePrincipal
  /** Team that owns the Project. */
  teamId: string
  /** Project ID. */
  projectId: string
}

/**
 * Authenticates the caller and requires manager access to the Project.
 *
 * @param c - Hono request context.
 * @param access - Whether the request reads or writes.
 * @returns The principal and the route identifiers.
 * @throws ProjectDataError for a missing token, an invalid route, or a caller who does not manage the Project.
 */
async function authorize(c: Context, access: 'read' | 'write'): Promise<AuthorizedExpenseRequest> {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) throw new ProjectDataError(401, 'Unauthorized', 'Bearer token is required.')
  const teamId = c.req.param('teamId')?.trim()
  const projectId = c.req.param('projectId')?.trim()
  if (!teamId || !projectId) throw new ProjectDataError(400, 'InvalidProjectExpense', 'Team ID and Project ID are required.')
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
  if (access === 'read') requireWorkspaceBusinessRead(principal)
  else requireWorkspaceBusinessWrite(principal)
  const context = await requireTeamPermission(principal, teamId, 'viewer')
  await requireTeamProjectManager(principal, context, teamId, projectId, () => new ProjectDataError(
    403,
    'ProjectExpenseForbidden',
    'Only a Project manager can read or change the Project expenses.',
  ))
  return { principal, teamId, projectId }
}

/**
 * Authorizes a write on one expense and reads its ID.
 *
 * @param c - Hono request context.
 * @returns The principal, the route identifiers, and the expense ID.
 * @throws ProjectDataError like {@link authorize}, or 400 without an expense ID.
 */
async function authorizeExpense(c: Context): Promise<AuthorizedExpenseRequest & { expenseId: string }> {
  const expenseId = c.req.param('expenseId')?.trim()
  if (!expenseId) throw new ProjectDataError(400, 'InvalidProjectExpense', 'Expense ID is required.')
  return { ...await authorize(c, 'write'), expenseId }
}

/**
 * Builds the commit-time fences that fail an expense write when the caller lost access or the
 * Team or Project was archived after the request was authorized.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose expenses change.
 * @returns The condition checks.
 * @throws ProjectDataError 503 when the directory cannot build the active-reference fences.
 */
async function createCallerAuthorization(principal: WorkspacePrincipal, teamId: string, projectId: string) {
  const { projectDirectory } = workspaceDependencies
  if (!projectDirectory.createActiveReferenceConditionChecks) {
    throw new ProjectDataError(503, 'ProjectExpenseAuthorizationUnavailable', 'Project access cannot be verified.')
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
 * Verifies the Work Item and the receipts an expense gains.
 *
 * The Work Item must be one the caller can read and must belong to this Project; its fence fails
 * the write when it is deleted or moved before the write commits. Each receipt must be a file of
 * this Project's files. Every refusal answers the same 400 whether the reference is missing,
 * hidden, or in another Project, so the response does not reveal what exists.
 *
 * @param principal - Authenticated principal changing the expense.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose expenses change.
 * @param references - Work Item and added receipts.
 * @returns Fences for the Work Item.
 * @throws ProjectDataError 400 for a reference that is not allowed.
 */
async function verifyExpenseReferences(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
  references: ProjectExpenseReferences,
): Promise<ProjectExpenseCallerAuthorizationCheck[]> {
  const fences: ProjectExpenseCallerAuthorizationCheck[] = []
  const { workItemId } = references
  if (workItemId !== undefined) {
    const notInProject = () => new ProjectDataError(400, 'InvalidProjectExpense', `Work Item "${workItemId}" is not a Work Item of this Project.`)
    if (
      principal.enterprisePermissions !== undefined &&
      !hasEnterprisePermissionAtResource(principal, 'work-items.read', {
        workspaceId: principal.directoryId,
        kind: 'project',
        targetId: projectId,
        parentTeamId: teamId,
      })
    ) {
      throw notInProject()
    }
    let assignedProjectId: string | undefined
    try {
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
      assignedProjectId = detail.issue.assignedProjectId
    } catch (error) {
      if (!isHiddenOrMissing(error)) throw error
    }
    if (assignedProjectId !== projectId) throw notInProject()
    fences.push(createWorkItemProjectAssignmentConditionCheck(
      getTeamIssuesTableName(),
      principal.directoryId,
      teamId,
      workItemId,
      projectId,
    ))
  }
  for (const fileId of references.addedReceiptFileIds) {
    const lookup = await workItemDependencies.fileProofing.findFileById(
      principal.directoryId,
      { memberKey: principal.userKey, kind: 'member', guest: false, canWrite: false, canManage: false },
      fileId,
    )
    if (
      !lookup ||
      lookup.scope.kind !== 'project' ||
      lookup.scope.teamId !== teamId ||
      lookup.scope.projectId !== projectId
    ) {
      throw new ProjectDataError(400, 'InvalidProjectExpense', `Receipt "${fileId}" is not a file of this Project.`)
    }
  }
  return fences
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
 * Derives the ID of a new expense from the request's idempotency key, so a retried request finds
 * the expense it already created instead of adding a second one.
 *
 * @param teamId - Team ID.
 * @param projectId - Project ID.
 * @param actorId - Requesting actor.
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @returns A 32-character hexadecimal expense ID.
 */
function createExpenseId(teamId: string, projectId: string, actorId: string, idempotencyKeyHash: string) {
  return createHash('sha256')
    .update(JSON.stringify(['project-expense', teamId, projectId, actorId, idempotencyKeyHash]))
    .digest('hex')
    .slice(0, 32)
}

/**
 * Derives the receipt and the key of a change request. The receipt covers the content, so a
 * retry of the same request is recognized after its first attempt committed; the key leaves the
 * content out, so the same Idempotency-Key sent with other content is told apart from a retry.
 *
 * @param operation - Kind of change.
 * @param expenseId - Expense being changed.
 * @param auditContext - Audit context with the actor, key hash, and request fingerprint.
 * @returns The receipt and the key, hexadecimal.
 */
function createChangeReceipts(
  operation: 'update' | 'decision',
  expenseId: string,
  auditContext: { actor: { id: string }; idempotencyKeyHash: string; requestFingerprint: string },
) {
  const hash = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  return {
    updateReceipt: hash([`project-expense-${operation}`, expenseId, auditContext.actor.id, auditContext.idempotencyKeyHash, auditContext.requestFingerprint]),
    updateKey: hash([`project-expense-${operation}-key`, expenseId, auditContext.actor.id, auditContext.idempotencyKeyHash]),
  }
}

/**
 * Converts an expense failure to an HTTP response.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The response.
 */
function toProjectExpenseErrorResponse(c: Context, error: unknown) {
  if (error instanceof ProjectDataError && (error.code.startsWith('ProjectExpense') || error.code === 'InvalidProjectExpense')) {
    const status = toProjectExpenseStatus(error.status)
    if (status >= 500) {
      // Request headers tie the failure to the request log; the body is not recorded.
      console.error('Project expense request failed.', {
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
 * Narrows an expense error status to the statuses the endpoints answer with.
 *
 * @param status - Status carried by the error.
 * @returns The same status when it is expected, otherwise 502.
 */
function toProjectExpenseStatus(status: number): 400 | 403 | 404 | 409 | 413 | 502 | 503 {
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
