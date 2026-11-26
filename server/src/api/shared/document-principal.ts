import type { DocumentDetail, DocumentRelationTarget } from '@mukuroji/contracts'
import { isTeamIssueNotFoundError, type TeamIssueDetailResponse } from '../../modules/work-items'
import { DocumentError, type DocumentAuthorizationFenceSnapshot } from '../../modules/documents'
import { createDocumentRealtimeScopeKey, publishRealtimeScopeSignal } from '../../modules/realtime'
import { createDocumentWorkspaceSearchDocument } from '../../modules/workspace-search/workspace-search'
import type { DocumentApiPrincipal, DocumentRealtimeChange } from '../../modules/documents/adapter-in/http/document-api'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import { readDocumentAuthorizationSnapshot } from './document-access'
import { createDocumentEnterpriseScopeBoundary, type WorkspacePrincipal } from './project-access'
import { isWorkspaceSearchProjectionEnabled, parseSearchWorkItemEntityId } from './search-access'

/** Relation target の source read を同時実行する最大数です。 */
const DOCUMENT_RELATION_TARGET_VALIDATION_CONCURRENCY = 8

/**
 * Builds the Documents principal of an authenticated Workspace principal: its current Project
 * roles, Enterprise scope boundary, and the authorization generations a Documents write fences.
 * The Documents routes and the Public API Document writes share it, so both see the same access.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns Documents principal of the same member.
 */
export async function toDocumentApiPrincipal(
  principal: WorkspacePrincipal,
): Promise<DocumentApiPrincipal> {
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
      ...(principal.enterpriseOrgStructureRevision === undefined
        ? {}
        : { orgStructureRevision: principal.enterpriseOrgStructureRevision }),
    } satisfies DocumentAuthorizationFenceSnapshot],
    projectRoles,
    ...createDocumentEnterpriseScopeBoundary(principal),
  }
}

/**
 * Checks that every relation target of a Documents write exists and that the principal can view
 * it, as the Documents routes require before a link is saved.
 *
 * @param principal - Documents principal of the writer.
 * @param targets - Work Item, Project, and Goal targets to check.
 * @returns Planning authorization generations to fence the write with, when a Goal was checked.
 * @throws DocumentError when a target is missing or hidden from the principal.
 */
export async function validateDocumentRelationTargets(
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
 * Writes a Document to the Workspace search projection, when the projection is enabled.
 *
 * @param workspaceId - Workspace that owns the Document.
 * @param document - Saved Document.
 * @returns A promise that resolves once the projection is written.
 */
export async function upsertDocumentSearchProjection(workspaceId: string, document: DocumentDetail): Promise<void> {
  if (!isWorkspaceSearchProjectionEnabled()) return
  await workItemDependencies.workspaceSearch.upsertDocument(
    createDocumentWorkspaceSearchDocument(workspaceId, document),
  )
}

/**
 * Tells the open editors of a Document that it changed, without its content.
 *
 * @param workspaceId - Workspace that owns the Document.
 * @param change - Changed Document and part.
 * @returns A promise that resolves once the signal is sent.
 */
export async function publishDocumentChange(workspaceId: string, change: DocumentRealtimeChange): Promise<void> {
  await publishRealtimeScopeSignal(
    createDocumentRealtimeScopeKey(workspaceId, change.documentId),
    {
      type: 'document.changed',
      documentId: change.documentId,
      part: change.part,
      ...(change.originClientId ? { originClientId: change.originClientId } : {}),
      occurredAt: new Date().toISOString(),
    },
  )
}
