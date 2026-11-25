import { APPROVAL_MAX_REVIEWERS, type ApprovalRequest } from '@mukuroji/contracts'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type { Context } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import type { DocumentVersionApprovalRequest } from '../../modules/documents/adapter-in/http/document-api'
import { FileProofingError } from '../../modules/files/file-proofing'
import { workItemDependencies } from './app-dependencies'
import { loadWorkItemFileProofingContext } from './collaboration-access'
import { requireApprovalReviewers } from './file-approval-access'
import {
  createApiMutationContext,
  hasEnterprisePermissionAtResource,
  type WorkspacePrincipal,
} from './project-access'
import { isRecord } from './value-guards'
import { loadAuthorizedTeamIssue } from './work-item-access'

/** Maximum length of one reviewer member key accepted from a request. */
const REVIEWER_MEMBER_KEY_MAX_LENGTH = 320

/**
 * Creates an approval request for a pinned Document version on the Work Item that links it as a
 * deliverable. The caller has already verified that the principal can read the Document and that
 * the version is pinned.
 *
 * @param c - Hono request context used for the mutation audit and idempotency key.
 * @param principal - Authenticated Workspace principal.
 * @param request - Document version subject, Work Item, reviewers, and due date.
 * @param subjectConditionChecks - Document owner's checks that keep the requester's Document edit
 *   permission and the pinned version unchanged until the approval is saved.
 * @returns The created approval request.
 * @throws FileProofingError when the principal cannot write the Work Item or the reviewers are invalid.
 */
export async function createAuthorizedDocumentVersionApproval(
  c: Context,
  principal: WorkspacePrincipal,
  request: DocumentVersionApprovalRequest,
  subjectConditionChecks: NonNullable<TransactWriteCommandInput['TransactItems']>,
): Promise<ApprovalRequest> {
  const { scope, actor } = await loadWorkItemFileProofingContext(
    principal,
    request.teamId,
    request.issueId,
  )
  if (!actor.canWrite || actor.guest) {
    throw new FileProofingError(403, 'ApprovalWriteDenied', 'Work Item write access is required.')
  }
  if (!hasEnterpriseApprovalPermission(principal, 'files.approve', scope.teamId, scope.projectId)) {
    throw new FileProofingError(403, 'ApprovalWriteDenied', 'Approval permission is required.')
  }
  const reviewerMemberKeys = [...new Set(
    request.reviewerMemberKeys.map((memberKey) => memberKey.trim().toLowerCase()),
  )]
  if (
    reviewerMemberKeys.length === 0 ||
    reviewerMemberKeys.length > APPROVAL_MAX_REVIEWERS ||
    reviewerMemberKeys.some((memberKey) =>
      !memberKey || memberKey.length > REVIEWER_MEMBER_KEY_MAX_LENGTH
    )
  ) {
    throw new FileProofingError(400, 'InvalidApprovalReviewers', 'Approval reviewers are required.')
  }
  const reviewerMembers = await requireApprovalReviewers(
    principal.directoryId,
    scope.teamId,
    scope.projectId,
    reviewerMemberKeys,
  )
  if (reviewerMembers.some((member) => member.role === 'guest')) {
    throw new FileProofingError(
      409,
      'ApprovalGuestDocumentAccessDenied',
      'Guest reviewers cannot review Document versions.',
    )
  }
  const input = {
    documentId: request.documentId,
    versionId: request.versionId,
    reviewerMemberKeys,
    dueAt: request.dueAt,
  }
  return workItemDependencies.fileProofing.createDocumentVersionApproval(
    scope,
    actor,
    input,
    createApiMutationContext(c, principal, { ...input, teamId: request.teamId, issueId: request.issueId }),
    subjectConditionChecks,
  )
}

/**
 * Lists approvals of one Document's versions whose Work Item the principal can view. The caller
 * has already verified that the principal can read the Document.
 *
 * @param principal - Authenticated Workspace principal of the Document request.
 * @param documentId - Document whose version approvals are listed.
 * @param authorizeWorkItem - Authenticates the member for one Work Item as the Work Item routes
 *   would, so access granted in another Project than the Document's counts.
 * @returns Approvals the principal may see, newest first.
 */
export async function listAuthorizedDocumentApprovals(
  principal: WorkspacePrincipal,
  documentId: string,
  authorizeWorkItem: (teamId: string, issueId: string) => Promise<WorkspacePrincipal>,
): Promise<ApprovalRequest[]> {
  const approvals = await workItemDependencies.fileProofing.listDocumentApprovals(
    principal.directoryId,
    documentId,
    {
      memberKey: principal.userKey,
      guest: principal.workspaceRole === 'guest',
      canWrite: false,
      canManage: false,
    },
  )
  const visibility = new Map<string, Promise<boolean>>()
  const authorized = await Promise.all(approvals.map(async (approval) => {
    const { teamId, issueId } = approval
    if (!teamId || !issueId) return undefined
    const key = JSON.stringify([teamId, issueId])
    let visible = visibility.get(key)
    if (!visible) {
      visible = canViewWorkItemApprovals(authorizeWorkItem, teamId, issueId)
      visibility.set(key, visible)
    }
    return await visible ? approval : undefined
  }))
  return authorized.filter((approval) => approval !== undefined)
}

/**
 * Checks whether the member may see the approvals of one Work Item, reading it once per list.
 *
 * @param authorizeWorkItem - Authenticates the member for the Work Item's own route.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item that owns the approvals.
 * @returns Whether the Work Item and its approvals are visible to the member.
 */
async function canViewWorkItemApprovals(
  authorizeWorkItem: (teamId: string, issueId: string) => Promise<WorkspacePrincipal>,
  teamId: string,
  issueId: string,
) {
  try {
    const principal = await authorizeWorkItem(teamId, issueId)
    const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    return hasEnterpriseApprovalPermission(principal, 'files.read', teamId, detail.issue.assignedProjectId)
  } catch (error) {
    if (isWorkItemAuthorizationMiss(error)) return false
    throw error
  }
}

/**
 * Applies the Enterprise permission that the Work Item approval routes require at the Work Item's
 * Team or Project, because these requests arrive through Document routes whose route-level check
 * only covers Document permissions.
 *
 * @param principal - Authenticated Workspace principal.
 * @param permission - `files.read` to see approvals, `files.approve` to request them.
 * @param teamId - Team that owns the Work Item.
 * @param projectId - Project the Work Item is assigned to, if any.
 * @returns Whether the principal holds the permission, or true without Enterprise roles.
 */
function hasEnterpriseApprovalPermission(
  principal: WorkspacePrincipal,
  permission: 'files.read' | 'files.approve',
  teamId: string,
  projectId: string | undefined,
) {
  if (principal.enterprisePermissions === undefined && principal.enterpriseAuthorizationEvaluation === undefined) {
    return true
  }
  return hasEnterprisePermissionAtResource(
    principal,
    permission,
    projectId === undefined
      ? { workspaceId: principal.directoryId, kind: 'team', targetId: teamId }
      : { workspaceId: principal.directoryId, kind: 'project', targetId: projectId, parentTeamId: teamId },
  )
}

/**
 * Checks whether an error means that the Work Item is hidden from or missing for the principal.
 *
 * @param error - Error raised while authorizing the Work Item.
 * @returns Whether the approval should be left out instead of failing the list.
 */
function isWorkItemAuthorizationMiss(error: unknown) {
  return (error instanceof ProjectDataError || isRecord(error)) &&
    (error.status === 403 || error.status === 404)
}
