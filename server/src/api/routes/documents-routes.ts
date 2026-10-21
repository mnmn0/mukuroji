import { type DocumentRelationTarget } from '@mukuroji/contracts'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import { isTeamIssueNotFoundError, type TeamIssueDetailResponse } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  createDocumentWorkspaceSearchDocument,
} from '../../modules/workspace-search/workspace-search'
import { DocumentError, type DocumentAuthorizationFenceSnapshot } from '../../modules/documents'
import {
  registerDocumentApiRoutes,
  type DocumentApiPrincipal,
} from '../../modules/documents/adapter-in/http/document-api'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { readDocumentAuthorizationSnapshot } from '../shared/document-access'
import { createDocumentEnterpriseScopeBoundary } from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  isWorkspaceSearchProjectionEnabled,
  parseSearchWorkItemEntityId,
} from '../shared/search-access'
import { enforceActiveTenantForWorkspace } from '../shared/workspace-access'

/** Relation target の source read を同時実行する最大数です。 */
const DOCUMENT_RELATION_TARGET_VALIDATION_CONCURRENCY = 8

async function createDocumentApiPrincipal(
  accessToken: string,
  context: Context,
): Promise<DocumentApiPrincipal> {
  const principal = await authenticateWorkspacePrincipal(
    accessToken,
    undefined,
    context,
  )
  const {
    planningRevision,
    projectRoles,
  } = await readDocumentAuthorizationSnapshot(principal)

  return {
    workspaceId: principal.directoryId,
    memberKey: principal.userKey,
    displayName:
      principal.workspaceMember.name ??
      principal.workspaceMember.email ??
      principal.userKey,
    workspaceRole: principal.workspaceRole,
    isSystemAdmin: principal.isSystemAdmin,
    authorizationSnapshots: [{
      workspaceId: principal.directoryId,
      ...(principal.principalKind === 'service-account'
        ? {}
        : {
            workspaceMemberKey: principal.userKey,
            workspaceMemberVersion:
              principal.workspaceMember.version,
          }),
      planningRevision,
      ...(principal.enterprisePermissions === undefined ||
          principal.enterpriseIdentityControlRevision === undefined
        ? {}
        : {
            enterpriseControlRevision:
              principal.enterpriseIdentityControlRevision,
          }),
    } satisfies DocumentAuthorizationFenceSnapshot],
    projectRoles,
    ...createDocumentEnterpriseScopeBoundary(principal),
  }
}

async function validateDocumentRelationTargets(
  principal: DocumentApiPrincipal,
  targets: readonly DocumentRelationTarget[],
) {
  const [directory, planningAuthorizationState] = await Promise.all([
    workspaceDependencies.projectDirectory.getProjectDirectory(
      principal.workspaceId,
      'ja',
      true,
    ),
    targets.some((target) => target.kind === 'goal')
      ? workItemDependencies.planning.getAuthorizationState(principal.workspaceId)
      : undefined,
  ])
  for (
    let offset = 0;
    offset < targets.length;
    offset += DOCUMENT_RELATION_TARGET_VALIDATION_CONCURRENCY
  ) {
    await Promise.all(targets.slice(
      offset,
      offset + DOCUMENT_RELATION_TARGET_VALIDATION_CONCURRENCY,
    ).map(async (target) => {
      if (target.kind === 'goal') {
        const entity = planningAuthorizationState?.entities.find(
          (candidate) =>
            candidate.id === target.goalId &&
            candidate.type === 'goal' &&
            candidate.archivedAt === undefined,
        )
        if (!entity) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Goal was not found.',
          )
        }
        const team = entity.teamId === undefined
          ? undefined
          : directory.teams.find((candidate) => candidate.id === entity.teamId)
        const projectTeam = entity.projectId === undefined
          ? undefined
          : directory.teams.find((candidate) =>
              (entity.teamId === undefined || candidate.id === entity.teamId) &&
              candidate.projects.some((project) => project.id === entity.projectId)
            )
        if (
          (entity.teamId !== undefined && team === undefined) ||
          (entity.projectId !== undefined && projectTeam === undefined)
        ) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Goal was not found.',
          )
        }
        const visible = principal.isSystemAdmin ||
          (entity.projectId !== undefined
            ? principal.projectRoles[entity.projectId] !== undefined
            : team !== undefined
              ? team.projects.some(
                  (project) => principal.projectRoles[project.id] !== undefined,
                )
              : true)
        if (!visible) {
          throw new DocumentError(
            403,
            'DocumentRelationTargetDenied',
            'The related Goal is not visible.',
          )
        }
        return
      }
      if (target.kind === 'project') {
        const exists = directory.teams.some((team) =>
          team.projects.some((project) =>
            project.id === target.projectId
          )
        )
        if (!exists) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Project was not found.',
          )
        }
        if (
          !principal.isSystemAdmin &&
          principal.projectRoles[target.projectId] === undefined
        ) {
          throw new DocumentError(
            403,
            'DocumentRelationTargetDenied',
            'The related Project is not visible.',
          )
        }
        return
      }
      const parsed = parseSearchWorkItemEntityId(target.workItemId)
      if (!parsed) {
        throw new DocumentError(
          400,
          'InvalidDocumentRelationTarget',
          'Work Item targets must use team/<teamId>/issue/<issueId>.',
        )
      }
      const team = directory.teams.find(
        (candidate) => candidate.id === parsed.teamId,
      )
      if (!team) {
        throw new DocumentError(
          400,
          'InvalidDocumentRelationTarget',
          'The related Team was not found.',
        )
      }
      if (
        !principal.isSystemAdmin &&
        !team.projects.some(
          (project) =>
            principal.projectRoles[project.id] !== undefined,
        )
      ) {
        throw new DocumentError(
          403,
          'DocumentRelationTargetDenied',
          'The related Work Item is not visible.',
        )
      }
      let detail: TeamIssueDetailResponse
      try {
        detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
          principal.workspaceId,
          parsed.teamId,
          parsed.issueId,
          { consistentIssueRead: true, includeEvents: false },
        )
      } catch (error) {
        if (isTeamIssueNotFoundError(error)) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Work Item was not found.',
          )
        }
        throw error
      }
      if (
        detail.issue.assignedProjectId &&
        !principal.isSystemAdmin &&
        principal.projectRoles[
          detail.issue.assignedProjectId
        ] === undefined
      ) {
        throw new DocumentError(
          403,
          'DocumentRelationTargetDenied',
          'The related Work Item is not visible.',
        )
      }
    }))
  }
  return planningAuthorizationState === undefined
    ? undefined
    : [{
        workspaceId: principal.workspaceId,
        planningRevision: planningAuthorizationState.revision,
      } satisfies DocumentAuthorizationFenceSnapshot]
}

/**
 * Registers the documents HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerDocumentsRoutes(routeApp: Hono): void {
  registerDocumentApiRoutes(routeApp, {
    getClient: () => workItemDependencies.documents,
    authenticate: createDocumentApiPrincipal,
    assertPublicShareEntitled: async (workspaceId) => {
      try {
        await enforceActiveTenantForWorkspace(workspaceId)
      } catch (error) {
        if (error instanceof WorkspaceAccessError) {
          throw new DocumentError(error.status, error.code, error.message)
        }
        throw error
      }
    },
    getActiveMember: (workspaceId, memberKey) =>
      workspaceDependencies.workspaceAccess.getActiveMember(workspaceId, memberKey),
    validateRelationTargets: validateDocumentRelationTargets,
    upsertSearchDocument: async (workspaceId, document) => {
      if (!isWorkspaceSearchProjectionEnabled()) return
      await workItemDependencies.workspaceSearch.upsertDocument(
        createDocumentWorkspaceSearchDocument(workspaceId, document),
      )
    },
    deleteSearchDocument: async (workspaceId, documentId) => {
      if (!isWorkspaceSearchProjectionEnabled()) return
      await workItemDependencies.workspaceSearch.deleteDocument(workspaceId, 'document', documentId)
    },
  })
}
