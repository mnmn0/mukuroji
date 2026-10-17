import type { WorkspaceSearchResult } from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import {
  addCollectionItem,
  CollectionError,
  createCollection,
  deleteCollection,
  isWorkItemReferenceIdentifier,
  listCollectionEntries,
  listCollections,
  parseCreateCollectionInput,
  parseExpectedRevisionQuery,
  parseUpdateCollectionInput,
  readCollectionIdentifier,
  readWorkItemReferenceIdentifier,
  removeCollectionItem,
  updateCollection,
  type CollectionMutationContext,
  type CollectionsStore,
  type ReadCollectionWorkItem,
} from '../../modules/collections'
import { normalizeProjectMemberKey, ProjectDataError, type ProjectAccessEntry } from '../../modules/directory'
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
import { readOptionalPositiveQueryInteger } from '../shared/input-parsing'
import { toWorkspaceSearchErrorResponse } from '../shared/search-access'
import { searchWorkspaceForPrincipal } from './search-routes'
import { projectAccessAllows, toWorkspaceAccessErrorResponse, type TeamPermissionContext } from '../shared/workspace-access'

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

  /**
   * Searches Work Items that can be added to a Collection.
   *
   * Candidate search follows the Collection permission (`work-items.read`) instead of the
   * Workspace-wide search permission, and returns only Work Items the caller can read.
   * The search index is a best-effort projection, so the first page also looks the keyword
   * up as an exact Work Item ID in the canonical Work Items of the caller's readable Teams.
   */
  routeApp.get('/api/collections/candidates', async (c) => {
    let principal: WorkspacePrincipal
    try {
      principal = await authenticate(c, 'read')
    } catch (error) {
      return toCollectionErrorResponse(c, error)
    }
    try {
      const keyword = c.req.query('keyword')?.trim() ?? ''
      if (!keyword) return c.json({ code: 'InvalidCollectionCandidateQuery', message: 'keyword is required.' }, 400)
      const cursor = c.req.query('cursor')
      const page = await searchWorkspaceForPrincipal(principal, { keyword, entityTypes: ['work-item'] }, {
        limit: readOptionalPositiveQueryInteger(c.req.query('limit'), 'Search limit'),
        cursor,
      })
      if (cursor) return c.json(page)
      const exact = await findExactCandidates(principal, keyword)
      const indexed = new Set(page.results.map((result) => result.id))
      return c.json({ ...page, results: [...exact.filter((result) => !indexed.has(result.id)), ...page.results] })
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
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
      const teamId = readWorkItemReferenceIdentifier(c.req.param('teamId'))
      const issueId = readWorkItemReferenceIdentifier(c.req.param('issueId'))
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
      const teamId = readWorkItemReferenceIdentifier(c.req.param('teamId'))
      const issueId = readWorkItemReferenceIdentifier(c.req.param('issueId'))
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
 * Binds Collection writes to the caller's current Workspace membership and, for item
 * changes, to the Project membership that authorized reading the Work Item.
 *
 * @param principal - Authenticated principal.
 * @returns Request-local Collection store.
 */
function writeStore(principal: WorkspacePrincipal): CollectionsStore {
  return workItemDependencies.collections.withCallerAuthorization(
    createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account'),
    async (workspaceId, projectId) => {
      const projectDirectory = workspaceDependencies.projectDirectory
      if (!projectDirectory.createProjectAccessConditionCheck) {
        throw new CollectionError(503, 'CollectionAuthorizationUnavailable', 'Caller authorization is unavailable.')
      }
      const check = await projectDirectory.createProjectAccessConditionCheck.call(
        projectDirectory,
        workspaceId,
        projectId,
        normalizeProjectMemberKey(principal.userKey),
        'viewer',
      )
      // A membership that is already gone is the same race as one revoked before commit:
      // the change is retried with a fresh readability check.
      if (!check?.ConditionCheck) {
        throw new CollectionError(409, 'CollectionWorkItemChanged', 'The Work Item changed. Reload and try again.')
      }
      return { ConditionCheck: check.ConditionCheck }
    },
  )
}

/**
 * Picks the Project whose direct membership authorized reading a Work Item.
 *
 * Non-Enterprise members reach a Team and its Work Items only through Project membership
 * rows, which the Workspace membership fence does not cover. A system administrator, a
 * direct Team grant, or an Enterprise Project grant is covered by the Enterprise control
 * fence instead, so no Project membership is returned for them.
 *
 * @param principal - Authenticated principal.
 * @param teamContext - Team authorization used for the read.
 * @param assignedProjectId - Primary Project of the Work Item, if any.
 * @returns The Project membership to fence, or undefined when none authorized the read.
 */
function resolveAccessProjectId(
  principal: WorkspacePrincipal,
  teamContext: TeamPermissionContext,
  assignedProjectId: string | undefined,
): string | undefined {
  if (principal.isSystemAdmin || teamContext.directTeamGrant) return undefined
  const candidates = (teamContext.projectAccesses ?? [])
    .filter((access) => projectAccessAllows(access, 'viewer'))
    .map((access) => access.projectId)
    .filter((projectId) => assignedProjectId === undefined || projectId === assignedProjectId)
  // Any one readable Project grants the Team; fencing the first is enough, and a retry after
  // its revocation picks another one that still holds.
  const enterpriseProjectIds = new Set((principal.enterpriseProjectAccesses ?? [])
    .filter((access) => projectAccessAllows(access, 'viewer'))
    .map((access) => access.projectId))
  if (candidates.some((projectId) => enterpriseProjectIds.has(projectId))) return undefined
  return candidates[0]
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
  return (await createWorkItemReadAccess(principal)).read
}

/** Caller-scoped Work Item reads that share one directory and Project access snapshot. */
type WorkItemReadAccess = {
  /** Reads one Work Item, or undefined when it is missing or unreadable. */
  read: ReadCollectionWorkItem
  /** Lists the Teams whose Work Items the caller may read, without reading any Work Item. */
  readableTeamIds: () => Promise<string[]>
}

/**
 * Creates caller-scoped Work Item reads over one directory and Project access snapshot.
 *
 * @param principal - Authenticated principal.
 * @returns The Work Item reader and the readable-Team listing.
 */
async function createWorkItemReadAccess(principal: WorkspacePrincipal): Promise<WorkItemReadAccess> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  let projectAccesses: Promise<ProjectAccessEntry[]> | undefined
  const readContext = {
    directory,
    readProjectAccesses: () => {
      projectAccesses ??= getEffectiveProjectScopeAccessList(principal)
      return projectAccesses
    },
  }
  /**
   * Lists readable Teams from the in-memory directory and Project access snapshot.
   *
   * @returns Team IDs in directory order.
   */
  const readableTeamIds = async (): Promise<string[]> => {
    const teamIds: string[] = []
    for (const team of directory.teams) {
      try {
        await requireTeamPermission(principal, team.id, 'viewer', readContext)
        teamIds.push(team.id)
      } catch (error) {
        if (!isUnreadableWorkItemError(error)) throw error
      }
    }
    return teamIds
  }
  /**
   * Reads one Work Item for the caller.
   *
   * @param teamId - Team that owns the Work Item.
   * @param issueId - Work Item identifier.
   * @returns The readable Work Item, or undefined.
   */
  const read: ReadCollectionWorkItem = async (teamId, issueId) => {
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
      const accessProjectId = resolveAccessProjectId(principal, teamContext, detail.issue.assignedProjectId)
      return {
        entry: {
          teamId,
          issueId,
          title: detail.issue.title,
          statusCategory: detail.issue.statusCategory,
          ...(detail.issue.assignedProjectId ? { assignedProjectId: detail.issue.assignedProjectId } : {}),
        },
        revision: detail.issue.revision,
        ...(accessProjectId === undefined ? {} : { accessProjectId }),
      }
    } catch (error) {
      if (isUnreadableWorkItemError(error)) return undefined
      throw error
    }
  }
  return { read, readableTeamIds }
}

/** Readable Teams whose canonical Work Items are checked for an exact-ID candidate. */
const EXACT_CANDIDATE_TEAM_LIMIT = 100

/** Number of exact-ID reads issued at once. */
const EXACT_CANDIDATE_READ_CONCURRENCY = 10

/**
 * Looks a candidate keyword up as an exact Work Item ID in the canonical Work Items.
 *
 * The search index is only a best-effort projection, so a Work Item whose projection
 * failed would otherwise never be offered. This first narrows the Workspace's Teams to those
 * the caller can read, using the directory and Project access already loaded, and then
 * reads the canonical row in at most `EXACT_CANDIDATE_TEAM_LIMIT` of those Teams, keeping
 * only Work Items the caller can read.
 *
 * @param principal - Authenticated principal.
 * @param keyword - Trimmed search keyword.
 * @returns Work Item search results for exact ID matches.
 */
async function findExactCandidates(principal: WorkspacePrincipal, keyword: string): Promise<WorkspaceSearchResult[]> {
  if (!isWorkItemReferenceIdentifier(keyword)) return []
  const access = await createWorkItemReadAccess(principal)
  // Only Teams the caller can read are looked up, so no Work Item row is read for the rest.
  const teamIds = (await access.readableTeamIds()).slice(0, EXACT_CANDIDATE_TEAM_LIMIT)
  const readWorkItem = access.read
  const results: WorkspaceSearchResult[] = []
  for (let start = 0; start < teamIds.length; start += EXACT_CANDIDATE_READ_CONCURRENCY) {
    const batch = teamIds.slice(start, start + EXACT_CANDIDATE_READ_CONCURRENCY)
    for (const observed of await Promise.all(batch.map((teamId) => readWorkItem(teamId, keyword)))) {
      if (!observed) continue
      const { entry } = observed
      // Same identity and URL as the projected search document of this Work Item.
      const query = new URLSearchParams({
        ...(entry.assignedProjectId ? { teamId: entry.teamId } : {}),
        issueId: entry.issueId,
      }).toString()
      results.push({
        id: `team/${entry.teamId}/issue/${entry.issueId}`,
        entityType: 'work-item',
        title: entry.title,
        subtitle: entry.issueId,
        url: entry.assignedProjectId
          ? `/projects/${encodeURIComponent(entry.assignedProjectId)}/issues?${query}`
          : `/teams/${encodeURIComponent(entry.teamId)}/issues?${query}`,
        teamId: entry.teamId,
        ...(entry.assignedProjectId ? { projectId: entry.assignedProjectId } : {}),
        highlights: [],
      })
    }
  }
  return results
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
