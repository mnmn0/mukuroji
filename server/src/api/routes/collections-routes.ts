import type { Context, Hono } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import {
  addCollectionItem,
  CollectionError,
  createCollection,
  deleteCollection,
  listCollectionEntries,
  listCollections,
  parseCreateCollectionInput,
  parseExpectedRevisionQuery,
  parseUpdateCollectionInput,
  readCollectionIdentifier,
  removeCollectionItem,
  updateCollection,
  type CollectionMutationContext,
  type CollectionsStore,
  type ReadCollectionWorkItem,
} from '../../modules/collections'
import { ProjectDataError, type ProjectAccessEntry } from '../../modules/directory'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import {
  canWriteTaskViews,
  getEffectiveProjectScopeAccessList,
  requireAssignedProjectPermission,
  requireTeamPermission,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

/** Maximum length of a client idempotency key. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 256

/**
 * Registers the Workspace Collection routes.
 *
 * Collections organize references to canonical Work Items. They never copy a Work Item,
 * and item listings only include Work Items the caller can already read.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerCollectionsRoutes(routeApp: Hono): void {
  /** Lists the Workspace's Collections. */
  routeApp.get('/api/collections', async (c) => {
    try {
      const principal = await authenticate(c, 'read')
      return c.json({
        collections: await listCollections(workItemDependencies.collections, principal.directoryId),
        canWrite: canWriteTaskViews(principal),
      })
    } catch (error) {
      return toCollectionErrorResponse(c, error)
    }
  })

  /** Creates a Collection; the Idempotency-Key header makes retries safe. */
  routeApp.post('/api/collections', async (c) => {
    try {
      const principal = await authenticate(c, 'write')
      const idempotencyKey = readRequiredIdempotencyKey(c.req.header('Idempotency-Key'))
      const input = parseCreateCollectionInput(await readJson<unknown>(c.req))
      const collection = await createCollection(writeStore(principal), mutationContext(principal), input, idempotencyKey)
      return c.json(collection, 201)
    } catch (error) {
      return toCollectionErrorResponse(c, error)
    }
  })

  /** Renames or re-describes a Collection. */
  routeApp.patch('/api/collections/:collectionId', async (c) => {
    try {
      const principal = await authenticate(c, 'write')
      const collectionId = readCollectionIdentifier(c.req.param('collectionId'), 'InvalidCollectionId')
      const input = parseUpdateCollectionInput(await readJson<unknown>(c.req))
      return c.json(await updateCollection(writeStore(principal), mutationContext(principal), collectionId, input))
    } catch (error) {
      return toCollectionErrorResponse(c, error)
    }
  })

  /** Deletes a Collection without changing the Work Items it referenced. */
  routeApp.delete('/api/collections/:collectionId', async (c) => {
    try {
      const principal = await authenticate(c, 'write')
      const collectionId = readCollectionIdentifier(c.req.param('collectionId'), 'InvalidCollectionId')
      const expectedRevision = parseExpectedRevisionQuery(c.req.query('expectedRevision'))
      await deleteCollection(writeStore(principal), principal.directoryId, collectionId, expectedRevision)
      return c.body(null, 204)
    } catch (error) {
      return toCollectionErrorResponse(c, error)
    }
  })

  /** Lists the Work Items in a Collection that the caller can read. */
  routeApp.get('/api/collections/:collectionId/items', async (c) => {
    try {
      const principal = await authenticate(c, 'read')
      const collectionId = readCollectionIdentifier(c.req.param('collectionId'), 'InvalidCollectionId')
      return c.json(await listCollectionEntries(
        workItemDependencies.collections,
        principal.directoryId,
        collectionId,
        await createWorkItemReader(principal),
      ))
    } catch (error) {
      return toCollectionErrorResponse(c, error)
    }
  })

  /** Adds a readable Work Item to a Collection. */
  routeApp.put('/api/collections/:collectionId/items/:teamId/:issueId', async (c) => {
    try {
      const principal = await authenticate(c, 'write')
      const collectionId = readCollectionIdentifier(c.req.param('collectionId'), 'InvalidCollectionId')
      const teamId = readCollectionIdentifier(c.req.param('teamId'), 'InvalidCollectionWorkItem')
      const issueId = readCollectionIdentifier(c.req.param('issueId'), 'InvalidCollectionWorkItem')
      return c.json(await addCollectionItem(
        writeStore(principal),
        mutationContext(principal),
        collectionId,
        teamId,
        issueId,
        await createWorkItemReader(principal),
      ))
    } catch (error) {
      return toCollectionErrorResponse(c, error)
    }
  })

  /** Removes a readable Work Item's reference from a Collection. */
  routeApp.delete('/api/collections/:collectionId/items/:teamId/:issueId', async (c) => {
    try {
      const principal = await authenticate(c, 'write')
      const collectionId = readCollectionIdentifier(c.req.param('collectionId'), 'InvalidCollectionId')
      const teamId = readCollectionIdentifier(c.req.param('teamId'), 'InvalidCollectionWorkItem')
      const issueId = readCollectionIdentifier(c.req.param('issueId'), 'InvalidCollectionWorkItem')
      return c.json(await removeCollectionItem(
        writeStore(principal),
        mutationContext(principal),
        collectionId,
        teamId,
        issueId,
        await createWorkItemReader(principal),
      ))
    } catch (error) {
      return toCollectionErrorResponse(c, error)
    }
  })
}

/**
 * Authenticates the caller and applies the Workspace business capability.
 *
 * @param context - Hono request context.
 * @param minimum - Required capability.
 * @returns Authenticated principal.
 */
async function authenticate(context: Context, minimum: 'read' | 'write'): Promise<WorkspacePrincipal> {
  const accessToken = readBearerAccessToken(context)
  if (!accessToken) {
    throw new WorkspaceAccessError(401, 'WorkspaceAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  requireWorkspaceBusinessRead(principal)
  if (minimum === 'write') {
    requireWorkspaceBusinessWrite(principal)
    if (!canWriteTaskViews(principal)) {
      throw new WorkspaceAccessError(403, 'CollectionWriteDenied', 'Work Item write permission is required to change Collections.')
    }
  }
  return principal
}

/**
 * Binds Collection writes to the caller's current Workspace membership.
 *
 * @param principal - Authenticated principal.
 * @returns Request-local Collection store.
 */
function writeStore(principal: WorkspacePrincipal): CollectionsStore {
  return workItemDependencies.collections.withCallerAuthorization(
    createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account'),
  )
}

/**
 * Builds the caller and clock for a mutation.
 *
 * @param principal - Authenticated principal.
 * @returns Mutation context.
 */
function mutationContext(principal: WorkspacePrincipal): CollectionMutationContext {
  return { workspaceId: principal.directoryId, actor: principal.userKey, now: new Date().toISOString() }
}

/**
 * Creates a Work Item reader that applies the same Team and Project checks as the
 * Work Item detail route, reading the directory and the caller's Project access once.
 *
 * @param principal - Authenticated principal.
 * @returns Reader that returns undefined for missing or unreadable Work Items.
 */
async function createWorkItemReader(principal: WorkspacePrincipal): Promise<ReadCollectionWorkItem> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  let projectAccesses: Promise<ProjectAccessEntry[]> | undefined
  const readContext = {
    directory,
    readProjectAccesses: () => {
      projectAccesses ??= getEffectiveProjectScopeAccessList(principal)
      return projectAccesses
    },
  }
  return async (teamId, issueId) => {
    try {
      const teamContext = await requireTeamPermission(principal, teamId, 'viewer', readContext)
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        issueId,
        { consistentIssueRead: true, includeEvents: false },
      )
      if (detail.issue.teamId !== teamId || detail.issue.id !== issueId) return undefined
      requireAssignedProjectPermission(principal, teamContext, detail.issue.assignedProjectId, 'viewer')
      return {
        teamId,
        issueId,
        title: detail.issue.title,
        statusCategory: detail.issue.statusCategory,
        ...(detail.issue.assignedProjectId ? { assignedProjectId: detail.issue.assignedProjectId } : {}),
      }
    } catch (error) {
      if (isUnreadableWorkItemError(error)) return undefined
      throw error
    }
  }
}

/**
 * Checks whether a failure means the Work Item is missing or not readable by the caller.
 *
 * @param error - Thrown value.
 * @returns Whether the Work Item should be treated as absent.
 */
function isUnreadableWorkItemError(error: unknown): boolean {
  if (isTeamIssueNotFoundError(error)) return true
  if (error instanceof ProjectDataError) return error.status === 403 || error.status === 404
  return error instanceof WorkspaceAccessError && (error.status === 403 || error.status === 404)
}

/**
 * Reads the required idempotency key for Collection creation.
 *
 * @param value - Raw header value.
 * @returns The key.
 */
function readRequiredIdempotencyKey(value: string | undefined): string {
  const key = value?.trim()
  if (!key || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new CollectionError(400, 'InvalidIdempotencyKey', 'An Idempotency-Key header of up to 256 characters is required.')
  }
  return key
}

/**
 * Converts Collection, authorization, and persistence failures into the API envelope.
 *
 * @param context - Hono request context.
 * @param error - Thrown value.
 * @returns JSON error response.
 */
function toCollectionErrorResponse(context: Context, error: unknown) {
  if (error instanceof CognitoServiceError) return toAuthErrorResponse(context, error)
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(context, error)
  if (error instanceof ProjectDataError) return toProjectDataErrorResponse(context, error)
  if (!(error instanceof CollectionError)) {
    console.error(error)
    return context.json({ code: 'CollectionUnavailable', message: 'Collection data is unavailable.' }, 503)
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 || error.status === 403 || error.status === 404 || error.status === 409 || error.status === 503
    ? error.status
    : 502
  return context.json({ code: error.code, message: error.message }, status)
}
