import { type EnterprisePermissionId } from '@mukuroji/contracts'
import {
  projectRoleWeights,
  type ProjectDirectoryProjectResponse,
  type ProjectDirectoryResponse,
} from '../../modules/directory'
import { type TeamIssueResponseItem } from '../../modules/work-items'
import { type CollaborationComment } from '../../modules/collaboration/collaboration'
import {
  createCommentWorkspaceSearchDocument,
  createProjectWorkspaceSearchDocument,
  createWorkItemWorkspaceSearchDocument,
} from '../../modules/workspace-search/workspace-search'
import {
  evaluateEnterpriseAccess,
  type EnterpriseAuthorizationResource,
} from '../../modules/enterprise-identity'
import { createWorkItemRelationIds } from '../../modules/work-items/work-item-configuration'
import { DocumentError, type DocumentProjectRole } from '../../modules/documents'
import {
  ambientAutomationActionExecutorDependencies,
  type AutomationActionExecutorDependencies,
  requireAppDependencies,
  workItemDependencies,
  workspaceDependencies,
} from './app-dependencies'
import { DOCUMENT_AUTHORIZATION_SNAPSHOT_RETRY_LIMIT } from './constants'
import {
  type EnterpriseDocumentScopeAccess,
  resolveEnterpriseDocumentRole,
} from './enterprise-access'
import {
  documentProjectRolesCaches,
  documentProjectRolesCacheTtlMs,
  getEffectiveProjectAccessList,
  type WorkspacePrincipal,
} from './project-access'

/**
 * Reads a stable document authorization snapshot for the principal.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns The document authorization snapshot.
 */
export async function readDocumentAuthorizationSnapshot(
  principal: WorkspacePrincipal,
) {
  for (
    let attempt = 0;
    attempt < DOCUMENT_AUTHORIZATION_SNAPSHOT_RETRY_LIMIT;
    attempt += 1
  ) {
    const planningRevision = await workItemDependencies.planning.getAuthorizationRevision(
      principal.directoryId,
    )
    const projectRoles = principal.enterprisePermissions === undefined
      ? await getCachedDocumentProjectRoles(
          principal.directoryId,
          principal.userKey,
          principal.workspaceMember.version,
          planningRevision,
        )
      : Object.fromEntries(
          (await getEffectiveProjectAccessList(principal))
            .flatMap(({ projectId, role }) =>
              role === undefined ? [] : [[projectId, role]]
            ),
        ) as Record<string, DocumentProjectRole>
    if (
      await workItemDependencies.planning.getAuthorizationRevision(
        principal.directoryId,
      ) === planningRevision
    ) {
      return { planningRevision, projectRoles }
    }
  }
  throw new DocumentError(
    409,
    'DocumentAuthorizationChanged',
    'Document authorization changed. Reload and try again.',
  )
}

const enterpriseDocumentPermissionIds = [
  'documents.manage',
  'documents.write',
  'documents.read',
] as const satisfies readonly EnterprisePermissionId[]

/**
 * Search/notification 内の Document を専用 permission で再評価します。
 */
export function resolveEnterpriseDocumentScopeAccess(
  principal: WorkspacePrincipal,
  directory: ProjectDirectoryResponse,
): EnterpriseDocumentScopeAccess | undefined {
  const evaluation =
    principal.enterpriseAuthorizationEvaluation
  if (!evaluation) return undefined

  const evaluateRole = (
    resource: EnterpriseAuthorizationResource,
  ) => resolveEnterpriseDocumentRole(
    enterpriseDocumentPermissionIds.filter((permission) =>
      evaluateEnterpriseAccess({
        permission,
        principal: evaluation.principal,
        assignments: evaluation.assignments,
        customRoles:
          evaluation.snapshot.customRoles,
        groupMappings: evaluation.groupMappings,
        resource,
      }).allowed
    ),
  )
  const workspaceScopeRole = evaluateRole({
    workspaceId: principal.directoryId,
    kind: 'workspace',
  })
  const projectRoles: Record<
    string,
    DocumentProjectRole
  > = {}
  for (const team of directory.teams) {
    for (const project of team.projects) {
      const role = evaluateRole({
        workspaceId: principal.directoryId,
        kind: 'project',
        targetId: project.id,
        parentTeamId: team.id,
      })
      if (!role) continue
      const currentRole = projectRoles[project.id]
      if (
        !currentRole ||
        projectRoleWeights[role] >
          projectRoleWeights[currentRole]
      ) {
        projectRoles[project.id] = role
      }
    }
  }
  return {
    projectRoles,
    restrictToAuthorizedScopes: true,
    ...(workspaceScopeRole
      ? { workspaceScopeRole }
      : {}),
  }
}

async function getCachedDocumentProjectRoles(
  workspaceId: string,
  memberKey: string,
  workspaceMemberVersion: number,
  planningRevision: number,
) {
  const dependencies = requireAppDependencies()
  let documentProjectRolesCache = documentProjectRolesCaches.get(dependencies)
  if (!documentProjectRolesCache) {
    documentProjectRolesCache = new Map()
    documentProjectRolesCaches.set(dependencies, documentProjectRolesCache)
  }
  const cacheKey = `${workspaceId}\0${memberKey}`
  const now = Date.now()
  const cached = documentProjectRolesCache.get(cacheKey)
  if (
    cached &&
    cached.expiresAt > now &&
    cached.workspaceMemberVersion === workspaceMemberVersion &&
    cached.planningRevision === planningRevision
  ) {
    return cached.value
  }
  if (cached) documentProjectRolesCache.delete(cacheKey)
  const value = workspaceDependencies.projectDirectory.getProjectAccessList(
    workspaceId,
    memberKey,
  ).then((projectAccesses) =>
    Object.fromEntries(
      projectAccesses.flatMap(({ projectId, role }) =>
        role === undefined ? [] : [[projectId, role]]
      ),
    ) as Record<string, DocumentProjectRole>
  ).catch((error: unknown) => {
    documentProjectRolesCache.delete(cacheKey)
    throw error
  })
  documentProjectRolesCache.set(cacheKey, {
    expiresAt: now + documentProjectRolesCacheTtlMs,
    workspaceMemberVersion,
    planningRevision,
    value,
  })
  return value
}

/**
 * Creates the Workspace search document for a Work Item.
 *
 * @param workspaceId - Workspace that scopes the operation.
 * @param issue - Work Item response item.
 * @param relationIds - Related Work Item IDs.
 * @returns The Work Item search document.
 */
export function createWorkItemSearchDocument(
  workspaceId: string,
  issue: TeamIssueResponseItem,
  relationIds: readonly string[],
) {
  return createWorkItemWorkspaceSearchDocument({
    workspaceId,
    teamId: issue.teamId,
    issueId: issue.id,
    title: issue.title,
    ...(issue.description ? { body: issue.description } : {}),
    ...(issue.assignedProjectId ? { projectId: issue.assignedProjectId } : {}),
    ...(issue.assigneeUserId ? { assigneeUserId: issue.assigneeUserId } : {}),
    ...(issue.creatorMemberKey ? { creatorUserId: issue.creatorMemberKey } : {}),
    status: issue.workflowStatusId,
    workItemTypeId: issue.workItemTypeId,
    customFields: issue.customFieldValues,
    relationIds: [...relationIds],
    dueDate: issue.dueDate,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  })
}

/**
 * Creates the Workspace search document for a comment.
 *
 * @param workspaceId - Workspace that scopes the operation.
 * @param teamId - Team that owns the resource.
 * @param issue - Work Item response item.
 * @param comment - Collaboration comment.
 * @returns The comment search document.
 */
export function createCommentSearchDocument(
  workspaceId: string,
  teamId: string,
  issue: TeamIssueResponseItem,
  comment: CollaborationComment,
) {
  return createCommentWorkspaceSearchDocument({
    workspaceId,
    teamId,
    issueId: issue.id,
    commentId: comment.id,
    rootCommentId: comment.rootCommentId,
    body: comment.bodyMarkdown,
    creatorUserId: comment.authorMemberKey,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    sourceRevision: comment.version,
  })
}

/**
 * Creates the Workspace search document for a Project.
 *
 * @param workspaceId - Workspace that scopes the operation.
 * @param teamId - Team that owns the resource.
 * @param project - Project directory entry.
 * @param creatorUserId - User who created the Project.
 * @param subtitle - Search result subtitle.
 * @returns The Project search document.
 */
export function createProjectSearchDocument(
  workspaceId: string,
  teamId: string,
  project: ProjectDirectoryProjectResponse,
  creatorUserId?: string,
  subtitle?: string,
) {
  return createProjectWorkspaceSearchDocument({
    workspaceId,
    teamId,
    projectId: project.id,
    title: project.name,
    ...(subtitle ? { subtitle } : {}),
    ...(creatorUserId ? { creatorUserId } : {}),
  })
}

/**
 * Projects a Work Item and its current relation graph into Workspace Search.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param issue - Canonical Work Item snapshot.
 * @param operation - Safe operation label used for error logging.
 * @param relationIds - Optional preloaded relation identifiers.
 * @param dependencies - Ports and feature state used by the projection.
 * @returns A promise that resolves after best-effort projection.
 */
export async function projectWorkItemSearchDocumentBestEffort(
  workspaceId: string,
  issue: TeamIssueResponseItem,
  operation: string,
  relationIds?: readonly string[],
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
) {
  if (!dependencies.workspaceSearchProjectionEnabled) return
  try {
    const currentRelationIds = relationIds ?? createWorkItemRelationIds(
      (await dependencies.workItemConfigurations.listRelations(
        workspaceId,
        issue.teamId,
        issue.id,
      )).relations,
      issue.id,
    )
    await dependencies.workspaceSearch.upsertDocument(
      createWorkItemSearchDocument(workspaceId, issue, currentRelationIds),
    )
  } catch (error) {
    console.error(`Workspace search projection failed after ${operation}.`, error)
  }
}
