import type { Context } from 'hono'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { CognitoServiceError } from '../../modules/authentication'
import { type ProjectDirectoryResponse } from '../../modules/directory'
import { type TeamIssueResponseItem } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  WorkspaceSearchError,
  createTaskViewProjectScopeKey,
  type SavedViewAccessScope,
  type TaskViewAccessScope,
  type WorkspaceSearchAccessScope,
  type WorkspaceSearchDocument,
} from '../../modules/workspace-search/workspace-search'
import { evaluateEnterpriseAccess } from '../../modules/enterprise-identity'
import {
  type DocumentAccessContext,
  type DocumentAuthorizationFenceSnapshot,
  type DocumentProjectRole,
} from '../../modules/documents'
import {
  requireAppDependencies,
  workItemDependencies,
  workspaceDependencies,
} from './app-dependencies'
import {
  projectWorkItemSearchDocumentBestEffort,
  readDocumentAuthorizationSnapshot,
  resolveEnterpriseDocumentScopeAccess,
} from './document-access'
import { toAuthErrorResponse } from './http'
import {
  canWriteTaskViews,
  createDocumentEnterpriseScopeBoundary,
  getEffectiveProjectScopeAccessList,
  getGloballyUniqueProjectIds,
  hasEnterpriseWorkspacePermission,
  resolveProjectAccessTeamId,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from './project-access'
import { projectAccessAllows, toWorkspaceAccessErrorResponse } from './workspace-access'

/**
 * Checks whether Workspace search projection is enabled for the current request binding.
 *
 * @returns `true` when search documents should be projected.
 */
export function isWorkspaceSearchProjectionEnabled() {
  return requireAppDependencies().workItems.workspaceSearchProjectionEnabled
}

/**
 * Updates or removes the search document after a Work Item mutation without failing the request.
 *
 * @param workspaceId - Workspace that scopes the operation.
 * @param issue - Work Item response item.
 * @param operation - Operation name used in logs.
 */
export async function projectWorkItemMutationSearchDocumentBestEffort(
  workspaceId: string,
  issue: TeamIssueResponseItem,
  operation: string,
) {
  if (issue.archivedAt) {
    await deleteWorkspaceSearchDocumentBestEffort(
      workspaceId,
      'work-item',
      `team/${issue.teamId}/issue/${issue.id}`,
      operation,
    )
    return
  }
  await projectWorkItemSearchDocumentBestEffort(workspaceId, issue, operation)
}

/** Search と saved view authorization に使う current directory snapshot です。 */
export type WorkspaceSearchContext = {
  /** Active Team/Project hierarchy です。 */
  directory: ProjectDirectoryResponse
  /** Search scope と Document ACL を解決した Planning authorization revision です。 */
  planningRevision: number
  /** Document ACL の current authorization generation です。 */
  documentAuthorizationRevision?: number
  /** Document source of truth の ACL 評価に使う current viewer です。 */
  documentAccess: DocumentAccessContext
  /** Search result の current viewer scope です。 */
  searchAccess: WorkspaceSearchAccessScope
  /** Saved view の current viewer scope です。 */
  savedViewAccess: SavedViewAccessScope
  /** Task view の current viewer scope without configuration-derived capabilities. */
  taskViewAccess: TaskViewAccessScope
}

/**
 * Reads the Project access set together with the Planning generation that authorized it.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param directory - Consistent active Team/Project directory snapshot.
 * @returns Project access entries and the generation that serialized the read.
 */
async function readWorkspaceSearchAuthorizationSnapshot(
  principal: WorkspacePrincipal,
  directory: ProjectDirectoryResponse,
) {
  if (principal.isSystemAdmin) {
    return {
      planningRevision: await workItemDependencies.planning.getAuthorizationRevision(
        principal.directoryId,
      ),
      projectAccesses: directory.teams.flatMap((team) => team.projects.map((project) => ({
        projectId: project.id,
        role: 'manager' as const,
      }))),
    }
  }

  const authorization = await readDocumentAuthorizationSnapshot(principal)
  return {
    planningRevision: authorization.planningRevision,
    projectAccesses: Object.entries(authorization.projectRoles).map(([projectId, role]) => ({
      projectId,
      role,
    })),
  }
}

/**
 * Reads the current workspace directory and search authorization snapshot.
 *
 * @param principal - Authenticated Workspace principal used for scope resolution.
 * @param options - Optional document revision and directory locale requirements.
 * @returns Current directory, project access, and revision state for AI resolution.
 */
export async function createWorkspaceSearchContext(
  principal: WorkspacePrincipal,
  options: {
    includeDocumentAuthorizationRevision?: boolean
    locale?: 'ja' | 'en'
  } = {},
): Promise<WorkspaceSearchContext> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    options.locale ?? 'ja',
    true,
  )
  const authorization = await readWorkspaceSearchAuthorizationSnapshot(principal, directory)
  const documentAuthorizationRevision = options.includeDocumentAuthorizationRevision
    ? await workItemDependencies.documents.getAuthorizationRevision(principal.directoryId)
    : undefined
  const projectScopeAccesses = principal.isSystemAdmin
    ? directory.teams.flatMap((team) => team.projects.map((project) => ({
        teamId: team.id,
        projectId: project.id,
        role: 'manager' as const,
      })))
    : await getEffectiveProjectScopeAccessList(principal)
  const projectAccesses = authorization.projectAccesses
  const globallyUniqueProjectIds = getGloballyUniqueProjectIds(directory)
  const readableProjectIds = new Set(
    projectAccesses
      .filter((access) =>
        globallyUniqueProjectIds.has(access.projectId) && projectAccessAllows(access, 'viewer')
      )
      .map((access) => access.projectId),
  )
  const readableProjectScopeKeys = new Set(
    projectScopeAccesses.flatMap((access) => {
      if (!projectAccessAllows(access, 'viewer')) return []
      const teamId = resolveProjectAccessTeamId(access, directory)
      return teamId
        ? [createTaskViewProjectScopeKey(teamId, access.projectId)]
        : []
    }),
  )
  const roleWritableTeamIds = new Set<string>()
  const roleWritableProjectIds = new Set<string>()
  const roleWritableProjectScopeKeys = new Set<string>()
  for (const access of projectScopeAccesses) {
    if (!projectAccessAllows(access, 'member')) continue
    const teamId = resolveProjectAccessTeamId(access, directory)
    if (!teamId) continue
    roleWritableTeamIds.add(teamId)
    roleWritableProjectScopeKeys.add(
      createTaskViewProjectScopeKey(teamId, access.projectId),
    )
    if (globallyUniqueProjectIds.has(access.projectId)) {
      roleWritableProjectIds.add(access.projectId)
    }
  }
  const readableTeamIds = new Set(
    projectScopeAccesses.flatMap((access) => {
      if (!projectAccessAllows(access, 'viewer')) return []
      const teamId = resolveProjectAccessTeamId(access, directory)
      return teamId ? [teamId] : []
    }),
  )
  const activeTeamIds = new Set(directory.teams.map((team) => team.id))
  if (principal.isSystemAdmin) {
    for (const teamId of activeTeamIds) readableTeamIds.add(teamId)
  }
  for (const teamId of principal.enterpriseAuthorizedTeamIds ?? []) {
    if (activeTeamIds.has(teamId)) readableTeamIds.add(teamId)
  }
  const canManageReadableTaskViewTeams =
    principal.isSystemAdmin ||
    (
      principal.enterprisePermissions === undefined &&
      (principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin')
    ) ||
    (
      principal.enterprisePermissions !== undefined &&
      hasEnterpriseWorkspacePermission(principal, 'workspace.manage')
    )
  const canWriteWorkspaceTaskViewScope =
    principal.isSystemAdmin ||
    (
      principal.enterprisePermissions === undefined
        ? principal.workspaceRole !== 'guest'
        : hasEnterpriseWorkspacePermission(principal, 'workspace.write')
    )
  const enterpriseManageableTeamIds = new Set<string>()
  const enterpriseWritableTeamIds = new Set<string>()
  const enterpriseWritableProjectIds = new Set<string>()
  const enterpriseWritableProjectScopeKeys = new Set<string>()
  const enterpriseEvaluation = principal.enterpriseAuthorizationEvaluation
  if (principal.enterprisePermissions !== undefined && enterpriseEvaluation) {
    for (const team of directory.teams) {
      const canManageTeam = evaluateEnterpriseAccess({
        permission: 'teams.manage',
        principal: enterpriseEvaluation.principal,
        assignments: enterpriseEvaluation.assignments,
        customRoles: enterpriseEvaluation.snapshot.customRoles,
        groupMappings: enterpriseEvaluation.groupMappings,
        resource: {
          workspaceId: principal.directoryId,
          kind: 'team',
          targetId: team.id,
        },
      }).allowed
      const canManageProject = team.projects.some((project) =>
        evaluateEnterpriseAccess({
          permission: 'projects.manage',
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
      )
      if (canManageTeam || canManageProject) enterpriseManageableTeamIds.add(team.id)
      if (evaluateEnterpriseAccess({
        permission: 'work-items.write',
        principal: enterpriseEvaluation.principal,
        assignments: enterpriseEvaluation.assignments,
        customRoles: enterpriseEvaluation.snapshot.customRoles,
        groupMappings: enterpriseEvaluation.groupMappings,
        resource: {
          workspaceId: principal.directoryId,
          kind: 'team',
          targetId: team.id,
        },
      }).allowed) {
        enterpriseWritableTeamIds.add(team.id)
      }
      for (const project of team.projects) {
        if (!evaluateEnterpriseAccess({
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
        }).allowed) {
          continue
        }
        enterpriseWritableProjectScopeKeys.add(
          createTaskViewProjectScopeKey(team.id, project.id),
        )
        if (globallyUniqueProjectIds.has(project.id)) {
          enterpriseWritableProjectIds.add(project.id)
        }
      }
    }
  }
  const canAccessWorkspaceTaskViewScope =
    principal.isSystemAdmin ||
    principal.enterprisePermissions === undefined ||
    principal.enterpriseRouteAuthorizedAtResource === true
  const manageableTeamIds = new Set(canManageReadableTaskViewTeams
    ? readableTeamIds
    : [
        ...enterpriseManageableTeamIds,
        ...(principal.enterprisePermissions === undefined
          ? projectScopeAccesses.flatMap((access) => {
              if (!projectAccessAllows(access, 'manager')) return []
              const teamId = resolveProjectAccessTeamId(access, directory)
              return teamId ? [teamId] : []
            })
          : []),
      ].filter((teamId) => readableTeamIds.has(teamId)))
  const writableTeamIds = new Set(
    principal.isSystemAdmin
      ? readableTeamIds
      : principal.enterprisePermissions !== undefined
        ? [...enterpriseWritableTeamIds].filter((teamId) => readableTeamIds.has(teamId))
        : [...roleWritableTeamIds].filter((teamId) => readableTeamIds.has(teamId)),
  )
  const writableProjectIds = new Set(
    principal.isSystemAdmin
      ? readableProjectIds
      : principal.enterprisePermissions !== undefined
        ? [...enterpriseWritableProjectIds].filter((projectId) => readableProjectIds.has(projectId))
        : [...roleWritableProjectIds].filter((projectId) => readableProjectIds.has(projectId)),
  )
  const writableProjectScopeKeys = new Set(
    principal.isSystemAdmin
      ? readableProjectScopeKeys
      : principal.enterprisePermissions !== undefined
        ? [...enterpriseWritableProjectScopeKeys].filter((scopeKey) =>
            readableProjectScopeKeys.has(scopeKey)
          )
        : [...roleWritableProjectScopeKeys].filter((scopeKey) =>
            readableProjectScopeKeys.has(scopeKey)
          ),
  )
  const projectRoles = Object.fromEntries(
    projectAccesses.flatMap(({ projectId, role }) =>
      role === undefined ? [] : [[projectId, role]]
    ),
  ) as Record<string, DocumentProjectRole>
  const enterpriseDocumentScopeAccess =
    resolveEnterpriseDocumentScopeAccess(
      principal,
      directory,
    )

  return {
    directory,
    planningRevision: authorization.planningRevision,
    documentAuthorizationRevision,
    documentAccess: {
      memberKey: principal.userKey,
      workspaceRole: principal.workspaceRole,
      isSystemAdmin: principal.isSystemAdmin,
      authorizationSnapshots: [{
        workspaceId: principal.directoryId,
        ...(principal.principalKind === 'service-account'
          ? {}
          : {
              workspaceMemberKey: principal.userKey,
              workspaceMemberVersion: principal.workspaceMember.version,
            }),
        planningRevision: authorization.planningRevision,
        ...(principal.enterpriseIdentityControlRevision === undefined
          ? {}
          : {
              enterpriseControlRevision:
                principal.enterpriseIdentityControlRevision,
            }),
      } satisfies DocumentAuthorizationFenceSnapshot],
      ...(enterpriseDocumentScopeAccess ?? {
        projectRoles,
        ...createDocumentEnterpriseScopeBoundary(
          principal,
        ),
      }),
    },
    searchAccess: {
      viewerUserId: principal.userKey,
      isSystemAdmin: principal.isSystemAdmin,
      projectIds: readableProjectIds,
      teamIds: readableTeamIds,
    },
    savedViewAccess: {
      viewerUserId: principal.userKey,
      isSystemAdmin: principal.isSystemAdmin,
      canManageSharedViews:
        principal.isSystemAdmin ||
        principal.workspaceRole === 'owner' ||
        principal.workspaceRole === 'admin',
      canWrite: principal.workspaceRole !== 'guest',
      teamIds: readableTeamIds,
      manageableTeamIds,
    },
    taskViewAccess: {
      viewerUserId: principal.userKey,
      isSystemAdmin: principal.isSystemAdmin,
      canAccessWorkspaceScope: canAccessWorkspaceTaskViewScope,
      canWriteWorkspaceScope: canWriteWorkspaceTaskViewScope,
      canManageSharedViews:
        canAccessWorkspaceTaskViewScope && canManageReadableTaskViewTeams,
      canWrite: canWriteTaskViews(principal),
      teamIds: readableTeamIds,
      writableTeamIds,
      manageableTeamIds,
      projectIds: readableProjectIds,
      writableProjectIds,
      projectScopeKeys: readableProjectScopeKeys,
      writableProjectScopeKeys,
    },
  }
}

/**
 * Rechecks the Planning generation before exposing a rehydrated search result.
 *
 * @param workspaceId - Workspace whose Project authorization is being checked.
 * @param expectedPlanningRevision - Generation captured when the search context was built.
 * @param expectedDocumentAuthorizationRevision - Document ACL generation captured with the context.
 * @param expectedDocumentAccess - Document authorization generations captured with the context.
 * @returns Whether the original Project access snapshot is still current.
 */
export async function isWorkspaceSearchAuthorizationCurrent(
  workspaceId: string,
  expectedPlanningRevision: number,
  expectedDocumentAuthorizationRevision?: number,
  expectedDocumentAccess?: DocumentAccessContext,
): Promise<boolean> {
  const authorizationSnapshots = expectedDocumentAccess?.authorizationSnapshots ?? []
  const memberSnapshots = authorizationSnapshots.filter((snapshot) =>
    snapshot.workspaceMemberKey !== undefined || snapshot.workspaceMemberVersion !== undefined
  )
  const enterpriseSnapshots = authorizationSnapshots.filter((snapshot) =>
    snapshot.enterpriseControlRevision !== undefined
  )
  const [planningRevision, documentAuthorizationRevision, enterpriseSnapshot, members] = await Promise.all([
    workItemDependencies.planning.getAuthorizationRevision(workspaceId),
    expectedDocumentAuthorizationRevision === undefined
      ? Promise.resolve(undefined)
      : workItemDependencies.documents.getAuthorizationRevision(workspaceId),
    enterpriseSnapshots.length === 0
      ? Promise.resolve(undefined)
      : workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId),
    Promise.all(memberSnapshots.map((snapshot) =>
      snapshot.workspaceMemberKey === undefined
        ? Promise.resolve(undefined)
        : workspaceDependencies.workspaceAccess.getActiveMember(
            workspaceId,
            snapshot.workspaceMemberKey,
          )
    )),
  ])
  return authorizationSnapshots.every((snapshot) => snapshot.workspaceId === workspaceId) &&
    planningRevision === expectedPlanningRevision &&
    (expectedDocumentAuthorizationRevision === undefined ||
      documentAuthorizationRevision === expectedDocumentAuthorizationRevision) &&
    memberSnapshots.every((snapshot, index) =>
      snapshot.workspaceMemberKey !== undefined &&
      snapshot.workspaceMemberVersion !== undefined &&
      members[index]?.version === snapshot.workspaceMemberVersion
    ) &&
    enterpriseSnapshots.every((snapshot) =>
      enterpriseSnapshot?.controlRevision === snapshot.enterpriseControlRevision
    )
}

/**
 * Splits an indexed Work Item ID using the Team recorded on the search document.
 *
 * Work Item IDs may contain `/`, which the plain grammar cannot split. When the document
 * carries its Team, the Team prefix is matched literally and the rest is the Work Item ID;
 * otherwise the plain grammar is used. Search identities are only written for Team IDs
 * without `/`, because such an identity could also belong to another `(teamId, issueId)`
 * pair; a document naming such a Team is not resolved.
 *
 * @param value - Indexed ID in the form `team/<teamId>/issue/<issueId>`.
 * @param teamId - Team recorded on the search document, when present.
 * @returns The Team and Work Item IDs, or undefined when the ID does not match.
 */
export function parseSearchWorkItemEntityIdForTeam(value: string | undefined, teamId: string | undefined) {
  if (teamId?.includes('/')) return undefined
  const prefix = teamId ? `team/${teamId}/issue/` : undefined
  const issueId = prefix && value?.startsWith(prefix) ? value.slice(prefix.length) : undefined
  return teamId && issueId ? { teamId, issueId } : parseSearchWorkItemEntityId(value)
}

/**
 * Parses a Work Item search entity ID into its Team and Work Item IDs.
 *
 * @param value - Raw input value.
 * @returns The parsed IDs, or `undefined` when the ID is not a Work Item entity ID.
 */
export function parseSearchWorkItemEntityId(value: string | undefined) {
  const match = value?.match(/^team\/([^/]+)\/issue\/([^/]+)$/u)
  return match?.[1] && match[2]
    ? { teamId: match[1], issueId: match[2] }
    : undefined
}

/**
 * Converts Workspace search failures into an HTTP error response.
 *
 * @param c - Hono request context.
 * @param error - Error raised by the operation.
 * @returns The HTTP error response.
 */
export function toWorkspaceSearchErrorResponse(c: Context, error: unknown) {
  if (error instanceof WorkspaceSearchError) {
    const status = error.status === 400 || error.status === 403 || error.status === 404 ||
      error.status === 409 || error.status === 413 || error.status === 503
      ? error.status
      : 502
    return c.json({ code: error.code, message: error.message }, status)
  }
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(c, error)
  if (error instanceof CognitoServiceError) return toAuthErrorResponse(c, error)
  return toProjectDataErrorResponse(c, error)
}

/**
 * Writes a Workspace search document and logs instead of failing the request on errors.
 *
 * @param createDocument - Factory for the search document.
 * @param operation - Operation name used in logs.
 */
export async function projectWorkspaceSearchDocumentBestEffort(
  createDocument: () => WorkspaceSearchDocument,
  operation: string,
) {
  if (!isWorkspaceSearchProjectionEnabled()) return
  try {
    await workItemDependencies.workspaceSearch.upsertDocument(createDocument())
  } catch (error) {
    console.error(`Workspace search projection failed after ${operation}.`, error)
  }
}

/**
 * Deletes a Workspace search document and logs instead of failing the request on errors.
 *
 * @param workspaceId - Workspace that scopes the operation.
 * @param entityType - Search entity type.
 * @param entityId - Search entity ID.
 * @param operation - Operation name used in logs.
 */
export async function deleteWorkspaceSearchDocumentBestEffort(
  workspaceId: string,
  entityType: WorkspaceSearchDocument['entityType'],
  entityId: string,
  operation: string,
) {
  if (!isWorkspaceSearchProjectionEnabled()) return
  try {
    await workItemDependencies.workspaceSearch.deleteDocument(workspaceId, entityType, entityId)
  } catch (error) {
    console.error(`Workspace search projection delete failed after ${operation}.`, error)
  }
}

/**
 * Reads the synchronous Workspace Search projection feature flag.
 *
 * @returns Whether request-time search projection is enabled.
 */
export function shouldEnableWorkspaceSearchProjection() {
  return loadServerConfig().workspaceSearchProjectionEnabled
}
