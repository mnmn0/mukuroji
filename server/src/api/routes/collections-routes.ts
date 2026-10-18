import { SEARCH_SCHEMA_VERSION, type WorkspaceSearchResponse, type WorkspaceSearchResult } from '@mukuroji/contracts'
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
import type { PlanningCallerAuthorizationConditionCheck } from '../../modules/planning'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { WORKSPACE_SEARCH_DEFAULT_LIMIT, WORKSPACE_SEARCH_MAX_LIMIT, WorkspaceSearchError } from '../../modules/workspace-search'
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
   * The search index is a best-effort projection, so exact Work Item ID matches from the
   * canonical Work Items lead the results; see `searchCollectionCandidates` for paging.
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
      const limit = readOptionalPositiveQueryInteger(c.req.query('limit'), 'Search limit') ?? WORKSPACE_SEARCH_DEFAULT_LIMIT
      if (limit > WORKSPACE_SEARCH_MAX_LIMIT) {
        throw new WorkspaceSearchError(400, 'InvalidSearchLimit', `Limit must be between 1 and ${WORKSPACE_SEARCH_MAX_LIMIT}.`)
      }
      return c.json(await searchCollectionCandidates(principal, keyword, limit, c.req.query('cursor')))
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
        // Each retry reloads Project access, so a revoked grant is seen as unreadable and
        // another qualifying grant can authorize the next attempt.
        await createWorkItemReader(principal, true),
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
        // Each retry reloads Project access, so a revoked grant is seen as unreadable and
        // another qualifying grant can authorize the next attempt.
        await createWorkItemReader(principal, true),
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
 * changes, to the Project membership that authorized reading the Work Item and to that
 * Project and its Team staying active.
 *
 * @param principal - Authenticated principal.
 * @returns Request-local Collection store.
 */
function writeStore(principal: WorkspacePrincipal): CollectionsStore {
  return workItemDependencies.collections.withCallerAuthorization(
    createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account'),
    async (workspaceId, teamId, projectId, membership) => {
      const projectDirectory = workspaceDependencies.projectDirectory
      if (!projectDirectory.createProjectAccessConditionCheck || !projectDirectory.createActiveReferenceConditionChecks) {
        throw new CollectionError(503, 'CollectionAuthorizationUnavailable', 'Caller authorization is unavailable.')
      }
      const membershipChecks: PlanningCallerAuthorizationConditionCheck[] = []
      if (membership) {
        const check = await projectDirectory.createProjectAccessConditionCheck.call(
          projectDirectory,
          workspaceId,
          projectId,
          normalizeProjectMemberKey(principal.userKey),
          'viewer',
        )
        // A membership that is already gone is the same race as one revoked before commit:
        // the change is retried with a fresh readability check.
        if (!check?.ConditionCheck) throw workItemChanged()
        membershipChecks.push({ ConditionCheck: check.ConditionCheck })
      }
      // Archiving the Project changes its own row, not the membership row, so the Team and
      // Project must also still be active at commit; one archived before the write is the same
      // race and is retried with a fresh readability check.
      const activeReferences = await projectDirectory.createActiveReferenceConditionChecks
        .call(projectDirectory, workspaceId, teamId, projectId)
        .catch((error: unknown) => {
          if (error instanceof ProjectDataError && error.status === 404) throw workItemChanged()
          throw error
        })
      return [...membershipChecks, ...activeReferences.map((item) => {
        if (!item.ConditionCheck) throw new CollectionError(503, 'CollectionAuthorizationUnavailable', 'Caller authorization is unavailable.')
        return { ConditionCheck: item.ConditionCheck }
      })]
    },
  )
}

/**
 * Creates the error for a Work Item whose readability changed before the write.
 *
 * @returns A 409 Collection error that asks the client to reload and retry.
 */
function workItemChanged(): CollectionError {
  return new CollectionError(409, 'CollectionWorkItemChanged', 'The Work Item changed. Reload and try again.')
}

/**
 * Picks the Project that authorized reading a Work Item and how it was granted.
 *
 * Non-Enterprise members reach a Team and its Work Items only through Project membership
 * rows, which the Workspace membership fence does not cover. An Enterprise Project grant is
 * covered by the Enterprise control fence instead, but archiving its Project changes neither,
 * so that Project is still returned to fence its active state. A direct Team grant does not
 * depend on a Project for the Team, but reading the Work Item still requires its primary
 * Project to exist, so that Project is fenced too. A system administrator depends on neither.
 *
 * @param principal - Authenticated principal.
 * @param teamContext - Team authorization used for the read.
 * @param assignedProjectId - Primary Project of the Work Item, if any.
 * @returns The authorizing Project and whether a direct membership granted it, or undefined.
 */
function resolveAccessProject(
  principal: WorkspacePrincipal,
  teamContext: TeamPermissionContext,
  assignedProjectId: string | undefined,
): { projectId: string; membership: boolean } | undefined {
  if (principal.isSystemAdmin) return undefined
  if (teamContext.directTeamGrant) {
    return assignedProjectId === undefined ? undefined : { projectId: assignedProjectId, membership: false }
  }
  const candidates = (teamContext.projectAccesses ?? [])
    .filter((access) => projectAccessAllows(access, 'viewer'))
    .map((access) => access.projectId)
    .filter((projectId) => assignedProjectId === undefined || projectId === assignedProjectId)
  // Any one readable Project grants the Team; fencing the first is enough, and a retry after
  // its revocation picks another one that still holds.
  const enterpriseProjectIds = new Set((principal.enterpriseProjectAccesses ?? [])
    .filter((access) => projectAccessAllows(access, 'viewer'))
    .map((access) => access.projectId))
  const enterpriseProjectId = candidates.find((projectId) => enterpriseProjectIds.has(projectId))
  if (enterpriseProjectId !== undefined) return { projectId: enterpriseProjectId, membership: false }
  return candidates[0] === undefined ? undefined : { projectId: candidates[0], membership: true }
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
 * Work Item detail route, reading the directory once.
 *
 * @param principal - Authenticated principal.
 * @param reloadProjectAccess - When true, every read loads the caller's Project access again
 *   instead of sharing one snapshot, so a retried item change sees a revoked or remaining grant.
 * @returns Reader that returns undefined for missing or unreadable Work Items.
 */
async function createWorkItemReader(principal: WorkspacePrincipal, reloadProjectAccess = false): Promise<ReadCollectionWorkItem> {
  return (await createWorkItemReadAccess(principal, reloadProjectAccess)).read
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
 * @param reloadProjectAccess - When true, each Work Item read uses its own Project access snapshot.
 * @returns The Work Item reader and the readable-Team listing.
 */
async function createWorkItemReadAccess(principal: WorkspacePrincipal, reloadProjectAccess = false): Promise<WorkItemReadAccess> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  /**
   * Builds a read context whose Project access is loaded at most once.
   *
   * @returns Directory and lazily loaded Project access for permission checks.
   */
  const createReadContext = () => {
    let projectAccesses: Promise<ProjectAccessEntry[]> | undefined
    return {
      directory,
      readProjectAccesses: () => {
        projectAccesses ??= getEffectiveProjectScopeAccessList(principal)
        return projectAccesses
      },
    }
  }
  const sharedReadContext = createReadContext()
  /**
   * Lists readable Teams from the in-memory directory and Project access snapshot.
   *
   * @returns Team IDs in directory order.
   */
  const readableTeamIds = async (): Promise<string[]> => {
    const teamIds: string[] = []
    for (const team of directory.teams) {
      try {
        await requireTeamPermission(principal, team.id, 'viewer', sharedReadContext)
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
    const readContext = reloadProjectAccess ? createReadContext() : sharedReadContext
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
      const accessProject = resolveAccessProject(principal, teamContext, detail.issue.assignedProjectId)
      return {
        entry: {
          teamId,
          issueId,
          title: detail.issue.title,
          statusCategory: detail.issue.statusCategory,
          ...(detail.issue.assignedProjectId ? { assignedProjectId: detail.issue.assignedProjectId } : {}),
        },
        revision: detail.issue.revision,
        ...(accessProject === undefined
          ? {}
          : accessProject.membership
            ? { accessProjectId: accessProject.projectId }
            : { activeProjectId: accessProject.projectId }),
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

/** Prefix of a candidate cursor that continues the exact-ID matches before the search index. */
const EXACT_CANDIDATE_CURSOR_PREFIX = 'exact:'

/**
 * Reads one page of Collection candidates.
 *
 * The search index is only a best-effort projection, so a Work Item whose projection failed
 * would otherwise never be offered. The keyword is therefore also looked up as an exact Work
 * Item ID in the canonical Work Items of the caller's first `EXACT_CANDIDATE_TEAM_LIMIT`
 * readable Teams. Paging stays stable and bounded:
 *
 * - Exact matches come first, in readable-Team order. While they remain, the page carries an
 *   `exact:<offset>` cursor (never a valid index cursor, which is base64url) that continues them.
 * - The page that exhausts the exact matches fills its remaining slots with the first index
 *   page, so the page never holds more than `limit` results, and returns the index cursor.
 * - Every index page drops results that are exact-ID matches of the keyword in those Teams. Such
 *   a Work Item is either among the exact matches already returned or not readable as a
 *   canonical Work Item, so no Work Item is returned twice across pages.
 *
 * @param principal - Authenticated principal.
 * @param keyword - Trimmed, non-blank search keyword.
 * @param limit - Validated page size.
 * @param cursor - Cursor returned by the previous page, if any.
 * @returns One page of Work Item search results.
 */
async function searchCollectionCandidates(
  principal: WorkspacePrincipal,
  keyword: string,
  limit: number,
  cursor: string | undefined,
): Promise<WorkspaceSearchResponse> {
  const exactOffset = cursor ? readExactCandidateCursor(cursor) : 0
  const access = isWorkItemReferenceIdentifier(keyword) ? await createWorkItemReadAccess(principal) : undefined
  // Only Teams the caller can read are looked up, so no Work Item row is read for the rest.
  const exactTeamIds = new Set(access ? (await access.readableTeamIds()).slice(0, EXACT_CANDIDATE_TEAM_LIMIT) : [])
  /**
   * Checks whether an index result is an exact-ID match that the exact lookup owns.
   *
   * @param result - Index search result.
   * @returns Whether the result must not be returned from the index.
   */
  const isOwnedByExactLookup = (result: WorkspaceSearchResult): boolean =>
    result.teamId !== undefined && exactTeamIds.has(result.teamId) &&
    result.id === `team/${result.teamId}/issue/${keyword}`
  if (exactOffset === undefined) {
    const page = await searchWorkspaceForPrincipal(principal, { keyword, entityTypes: ['work-item'] }, { limit, cursor })
    return { ...page, results: page.results.filter((result) => !isOwnedByExactLookup(result)) }
  }
  const exact = access ? await findExactCandidates(access, [...exactTeamIds], keyword) : []
  const shown = exact.slice(exactOffset, exactOffset + limit)
  const nextOffset = exactOffset + shown.length
  if (nextOffset < exact.length || shown.length === limit) {
    return { schemaVersion: SEARCH_SCHEMA_VERSION, results: shown, nextCursor: `${EXACT_CANDIDATE_CURSOR_PREFIX}${nextOffset}` }
  }
  const page = await searchWorkspaceForPrincipal(principal, { keyword, entityTypes: ['work-item'] }, {
    limit: limit - shown.length,
  })
  return { ...page, results: [...shown, ...page.results.filter((result) => !isOwnedByExactLookup(result))] }
}

/**
 * Reads the exact-match offset of a candidate cursor.
 *
 * @param cursor - Non-empty cursor from the client.
 * @returns The offset for an exact-match cursor, or undefined for a search index cursor.
 */
function readExactCandidateCursor(cursor: string): number | undefined {
  if (!cursor.startsWith(EXACT_CANDIDATE_CURSOR_PREFIX)) return undefined
  const value = cursor.slice(EXACT_CANDIDATE_CURSOR_PREFIX.length)
  const offset = /^(?:0|[1-9][0-9]{0,2})$/u.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(offset) || offset > EXACT_CANDIDATE_TEAM_LIMIT) {
    throw new WorkspaceSearchError(400, 'InvalidSearchCursor', 'Cursor is invalid.')
  }
  return offset
}

/**
 * Looks a candidate keyword up as an exact Work Item ID in the canonical Work Items.
 *
 * Reads the canonical row in each given readable Team, `EXACT_CANDIDATE_READ_CONCURRENCY`
 * at a time, keeping only Work Items the caller can read.
 *
 * @param access - Caller-scoped Work Item reads.
 * @param teamIds - Readable Teams to look in, in order.
 * @param keyword - Trimmed search keyword that is a valid Work Item ID.
 * @returns Work Item search results for exact ID matches, in Team order.
 */
async function findExactCandidates(
  access: WorkItemReadAccess,
  teamIds: readonly string[],
  keyword: string,
): Promise<WorkspaceSearchResult[]> {
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
