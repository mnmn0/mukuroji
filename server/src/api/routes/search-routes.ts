import { type WorkspaceSearchFilters } from '@mukuroji/contracts'
import type { Hono } from 'hono'
import {
  createTeamIssueAuditEntityId,
  isTeamIssueNotFoundError,
  type TeamIssueDetailResponse,
} from '../../modules/work-items'
import { createWorkItemCollaborationEntityKey } from '../../modules/collaboration/collaboration'
import {
  createCuratedContextItemWorkspaceSearchDocument,
  WorkspaceSearchError,
  type WorkspaceSearchDocument,
} from '../../modules/workspace-search/workspace-search'
import { createWorkItemRelationIds } from '../../modules/work-items/work-item-configuration'
import { createDocumentSearchAccessReadContext } from '../../modules/documents'
import { workItemDependencies } from '../shared/app-dependencies'
import {
  createCommentSearchDocument,
  createWorkItemSearchDocument,
} from '../shared/document-access'
import { readBearerAccessToken } from '../shared/http'
import { readOptionalPositiveQueryInteger } from '../shared/input-parsing'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  createWorkspaceSearchContext,
  isWorkspaceSearchAuthorizationCurrent,
  parseSearchWorkItemEntityId,
  toWorkspaceSearchErrorResponse,
  type WorkspaceSearchContext,
} from '../shared/search-access'
import type { WorkspacePrincipal } from '../shared/project-access'
import { isRecord } from '../shared/value-guards'

async function resolveCurrentWorkspaceSearchScope(
  workspaceId: string,
  document: WorkspaceSearchDocument,
  context: WorkspaceSearchContext,
  scopeCache: Map<string, Promise<TeamIssueDetailResponse | undefined>>,
  documentSearchReadContext: ReturnType<
    typeof createDocumentSearchAccessReadContext
  >,
) {
  if (document.entityType === 'document') {
    if (
      document.sourceRevision === undefined ||
      document.updatedAt === undefined
    ) {
      return undefined
    }
    const currentAccess =
      await workItemDependencies.documents.resolveSearchAccess({
        workspaceId,
        documentId: document.entityId,
        access: context.documentAccess,
        expectedRevision:
          document.sourceRevision,
        expectedUpdatedAt:
          document.updatedAt,
        readContext:
          documentSearchReadContext,
      })
    if (currentAccess === undefined) {
      return undefined
    }
    const currentDocument = {
      ...document,
    }
    if (currentAccess.body.length > 0) {
      currentDocument.body =
        currentAccess.body
    } else {
      delete currentDocument.body
    }
    return {
      ...(currentAccess.scope.type === 'project'
        ? {
            projectId:
              currentAccess.scope.projectId,
          }
        : {}),
      permissionVerified: true,
      currentDocument,
    }
  }

  if (document.entityType === 'team') {
    const team = context.directory.teams.find((candidate) => candidate.id === document.teamId)
    return team ? { teamId: team.id } : undefined
  }

  if (document.entityType === 'project') {
    const team = context.directory.teams.find((candidate) =>
      (!document.teamId || candidate.id === document.teamId) &&
      candidate.projects.some((project) => project.id === document.projectId)
    )
    return team && document.projectId
      ? { teamId: team.id, projectId: document.projectId }
      : undefined
  }

  const workItemId = document.entityType === 'work-item'
    ? document.entityId
    : document.parentId
  const parsed = parseSearchWorkItemEntityId(workItemId)
  if (parsed) {
    const activeTeam = context.directory.teams.find((team) => team.id === parsed.teamId)
    if (!activeTeam) return undefined
    const cacheKey = `${parsed.teamId}\0${parsed.issueId}`
    let pending = scopeCache.get(cacheKey)
    if (!pending) {
      pending = workItemDependencies.teamIssues.getTeamIssueDetail(
        workspaceId,
        parsed.teamId,
        parsed.issueId,
        { consistentIssueRead: true, includeEvents: false },
      ).catch((error) => {
        if (isTeamIssueNotFoundError(error)) return undefined
        throw error
      })
      scopeCache.set(cacheKey, pending)
    }
    const detail = await pending
    if (
      !detail ||
      (detail.issue.assignedProjectId &&
        !activeTeam.projects.some((project) => project.id === detail.issue.assignedProjectId))
    ) {
      return undefined
    }
    const scope = {
      teamId: parsed.teamId,
      ...(detail.issue.assignedProjectId ? { projectId: detail.issue.assignedProjectId } : {}),
    }
    if (document.entityType === 'work-item') {
      const relationPage = await workItemDependencies.workItemConfigurations.listRelations(
        workspaceId,
        parsed.teamId,
        parsed.issueId,
      )
      return {
        ...scope,
        currentDocument: createWorkItemSearchDocument(
          workspaceId,
          detail.issue,
          createWorkItemRelationIds(relationPage.relations, parsed.issueId),
        ),
      }
    }
    if (document.entityType === 'context-item') {
      const parsedContextItem = parseSearchCuratedContextItemEntityId(
        document.entityId,
        document.parentId,
      )
      if (
        !parsedContextItem ||
        parsedContextItem.teamId !== parsed.teamId ||
        parsedContextItem.issueId !== parsed.issueId
      ) {
        return undefined
      }
      const item = await workItemDependencies.collaboration.getCuratedContextItemSnapshot({
        entityKey: createWorkItemCollaborationEntityKey(
          workspaceId,
          parsed.teamId,
          parsed.issueId,
        ),
        itemId: parsedContextItem.contextItemId,
      })
      if (!item || item.state === 'superseded') return undefined
      const latestDetail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        workspaceId,
        parsed.teamId,
        parsed.issueId,
        { consistentIssueRead: true, includeEvents: false },
      ).catch((error) => {
        if (isTeamIssueNotFoundError(error)) return undefined
        throw error
      })
      if (
        !latestDetail ||
        latestDetail.issue.assignedProjectId !== detail.issue.assignedProjectId ||
        (latestDetail.issue.assignedProjectId &&
          !activeTeam.projects.some((project) =>
            project.id === latestDetail.issue.assignedProjectId,
          ))
      ) {
        return undefined
      }
      if (!await isWorkspaceSearchAuthorizationCurrent(
        workspaceId,
        context.planningRevision,
        undefined,
        context.documentAccess,
      )) {
        return undefined
      }
      return {
        ...scope,
        currentDocument: createCuratedContextItemWorkspaceSearchDocument({
          workspaceId,
          item,
          projectId: detail.issue.assignedProjectId,
        }),
      }
    }
    if (document.entityType !== 'comment') return scope
    const parsedComment = parseSearchCommentEntityId(document.entityId, document.parentId)
    if (
      !parsedComment ||
      parsedComment.teamId !== parsed.teamId ||
      parsedComment.issueId !== parsed.issueId
    ) {
      return undefined
    }
    const comment = await workItemDependencies.collaboration.getCommentSnapshot({
      entityKey: createWorkItemCollaborationEntityKey(
        workspaceId,
        parsed.teamId,
        parsed.issueId,
      ),
      commentId: parsedComment.commentId,
    })
    if (!comment || comment.deletedAt) return undefined
    return {
      ...scope,
      currentDocument: createCommentSearchDocument(
        workspaceId,
        parsed.teamId,
        detail.issue,
        comment,
      ),
    }
  }

  if (document.projectId) {
    const team = context.directory.teams.find((candidate) =>
      (!document.teamId || candidate.id === document.teamId) &&
      candidate.projects.some((project) => project.id === document.projectId)
    )
    return team ? { teamId: team.id, projectId: document.projectId } : undefined
  }
  if (document.teamId && context.directory.teams.some((team) => team.id === document.teamId)) {
    return { teamId: document.teamId }
  }
  return undefined
}

function parseSearchCommentEntityId(
  value: string,
  parentId: string | undefined,
) {
  const match = value.match(/^team\/([^/]+)\/issue\/([^/]+)\/comment\/([^/]+)$/u)
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  const expectedParentId = createTeamIssueAuditEntityId(match[1], match[2])
  return parentId === expectedParentId
    ? { teamId: match[1], issueId: match[2], commentId: match[3] }
    : undefined
}

/**
 * Parses a canonical curated-context search identity and verifies its parent.
 *
 * @param value - Indexed context-item entity identity.
 * @param parentId - Indexed parent Work Item identity.
 * @returns Parsed identifiers when the identity and parent agree.
 */
function parseSearchCuratedContextItemEntityId(
  value: string,
  parentId: string | undefined,
) {
  const match = value.match(
    /^team\/([^/]+)\/issue\/([^/]+)\/context-item\/([^/]+)$/u,
  )
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  const expectedParentId = createTeamIssueAuditEntityId(match[1], match[2])
  return parentId === expectedParentId
    ? {
        teamId: match[1],
        issueId: match[2],
        contextItemId: match[3],
      }
    : undefined
}

function readWorkspaceSearchFilters(value: string | undefined): WorkspaceSearchFilters {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) throw new TypeError('Search filters must be an object.')
    return parsed as WorkspaceSearchFilters
  } catch (error) {
    throw new WorkspaceSearchError(400, 'InvalidSearchFilters', 'Search filters are invalid.', {
      cause: error,
    })
  }
}

/**
 * Searches the Workspace index as the principal, returning only results whose current
 * scope the principal can still read.
 *
 * @param principal - Authenticated Workspace principal.
 * @param filters - Search filters; `entityTypes` also limits scope resolution.
 * @param page - Optional page size and opaque cursor.
 * @returns One page of authorized search results.
 */
export async function searchWorkspaceForPrincipal(
  principal: WorkspacePrincipal,
  filters: WorkspaceSearchFilters,
  page: { limit?: number; cursor?: string },
) {
  const context = await createWorkspaceSearchContext(principal)
  const scopeCache = new Map<string, Promise<TeamIssueDetailResponse | undefined>>()
  const documentSearchReadContext = createDocumentSearchAccessReadContext()
  return workItemDependencies.workspaceSearch.search({
    workspaceId: principal.directoryId,
    filters,
    limit: page.limit,
    cursor: page.cursor,
    access: context.searchAccess,
    resolveCurrentScope: (document) => {
      if (
        filters.entityTypes?.length &&
        !filters.entityTypes.includes(document.entityType)
      ) {
        return Promise.resolve(undefined)
      }
      return resolveCurrentWorkspaceSearchScope(
        principal.directoryId,
        document,
        context,
        scopeCache,
        documentSearchReadContext,
      )
    },
  })
}

/**
 * Registers the search HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerSearchRoutes(routeApp: Hono): void {
  /**
   * Workspace 全体の search index を複合 filter と cursor 付きで検索します。
   */
  routeApp.get('/api/search', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await searchWorkspaceForPrincipal(principal, readWorkspaceSearchFilters(c.req.query('filters')), {
        limit: readOptionalPositiveQueryInteger(c.req.query('limit'), 'Search limit'),
        cursor: c.req.query('cursor'),
      }))
    } catch (error) {
      return toWorkspaceSearchErrorResponse(c, error)
    }
  })
}
