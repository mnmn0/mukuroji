import {
  PROJECT_DELIVERABLE_PAGE_DEFAULT_LIMIT,
  PROJECT_DELIVERABLE_PAGE_MAX_LIMIT,
  type ProjectDeliverable,
  type ProjectDeliverableApprovalFilter,
  type ProjectDeliverablePage,
} from '@mukuroji/contracts'
import { FileProofingError, type FileDeliverableSummary } from '../../modules/files/file-proofing'
import { isTeamIssueNotFoundError, type TeamIssueResponseItem } from '../../modules/work-items'
import { mapInOrderWithConcurrency } from './agent-run-access'
import { workItemDependencies } from './app-dependencies'
import {
  canManageTeamIssueCollaboration,
  loadProjectFileProofingContext,
} from './collaboration-access'
import { canAccessAssignedProject, type WorkspacePrincipal } from './project-access'
import { readScopedWorkItemPage } from './scoped-work-item-page'
import { createProjectReadCheck } from './team-project-read'
import { canWriteTeamIssue } from './work-item-access'

/** Largest number of Work Item file partitions read at once for one deliverables page. */
const DELIVERABLE_SCOPE_READ_CONCURRENCY = 8

/** Validated query of one Project deliverables page. */
export type ProjectDeliverableQuery = {
  /** Work Items read for the page. */
  limit: number
  /** Opaque cursor of the Work Item page to continue from. */
  cursor?: string
  /** Approval state filter. */
  approval: ProjectDeliverableApprovalFilter
  /** Whether only files with unresolved annotations on the current version are returned. */
  unresolvedOnly: boolean
}

/**
 * Parses the untrusted query of the Project deliverables list.
 *
 * @param readQuery - Reads one query value by name.
 * @returns The validated query.
 * @throws FileProofingError `400` for a malformed limit, filter, or flag.
 */
export function readProjectDeliverableQuery(
  readQuery: (name: string) => string | undefined,
): ProjectDeliverableQuery {
  const rawLimit = readQuery('limit')
  const limit = rawLimit === undefined ? PROJECT_DELIVERABLE_PAGE_DEFAULT_LIMIT : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROJECT_DELIVERABLE_PAGE_MAX_LIMIT) {
    throw new FileProofingError(
      400,
      'InvalidDeliverableQuery',
      `limit must be an integer from 1 to ${PROJECT_DELIVERABLE_PAGE_MAX_LIMIT}.`,
    )
  }
  const approval = readQuery('approval') ?? 'all'
  if (!isProjectDeliverableApprovalFilter(approval)) {
    throw new FileProofingError(400, 'InvalidDeliverableQuery', 'approval filter is not supported.')
  }
  const unresolved = readQuery('unresolvedOnly')
  if (unresolved !== undefined && unresolved !== 'true' && unresolved !== 'false') {
    throw new FileProofingError(400, 'InvalidDeliverableQuery', 'unresolvedOnly must be true or false.')
  }
  const cursor = readQuery('cursor') || undefined
  return {
    limit,
    approval,
    unresolvedOnly: unresolved === 'true',
    ...(cursor ? { cursor } : {}),
  }
}

/**
 * Lists one page of a Project's deliverables: the files attached to the Project itself and to
 * the Work Items of the Project that the principal can read.
 *
 * A page reads up to `limit` Work Items of the Project in list order and returns all of their
 * matching files; the first page also returns the Project's own files. The Project list index is
 * eventually consistent, so each candidate Work Item is read again with a strongly consistent
 * read, and its files are read only while the canonical Work Item is in the Team, assigned to
 * the Project, not archived, and readable by the principal. Work Item attachments are read only
 * when the principal holds `work-items.read` at the Project; Project files need only the route's
 * file access.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose deliverables are listed.
 * @param query - Validated page query.
 * @returns Matching deliverables, newest update first, and the cursor of the next page.
 */
export async function listProjectDeliverables(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
  query: ProjectDeliverableQuery,
): Promise<ProjectDeliverablePage> {
  const { scope, actor, context } = await loadProjectFileProofingContext(principal, teamId, projectId)
  const canReadWorkItems = createProjectReadCheck(principal, context)(projectId)
  const projectDeliverables = query.cursor
    ? []
    : (await workItemDependencies.fileProofing.listDeliverables(scope, actor))
        .map((summary) => toProjectDeliverable(summary, { kind: 'project', teamId, projectId }))
  if (!canReadWorkItems) {
    return { deliverables: filterAndSortDeliverables(projectDeliverables, query) }
  }
  const isReadable = (issue: TeamIssueResponseItem) => issue.teamId === teamId &&
    issue.assignedProjectId === projectId &&
    issue.archivedAt === undefined &&
    canAccessAssignedProject(principal, context, issue.assignedProjectId, 'viewer')
  const page = await readScopedWorkItemPage(
    principal.directoryId,
    { kind: 'project', id: projectId, includeArchived: false },
    { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
    isReadable,
  )
  const workItemDeliverables = await mapInOrderWithConcurrency(
    page.issues,
    DELIVERABLE_SCOPE_READ_CONCURRENCY,
    async (candidate) => {
      const issue = await readCanonicalWorkItem(principal.directoryId, teamId, candidate.id)
      if (!issue || !isReadable(issue)) {
        return []
      }
      const summaries = await workItemDependencies.fileProofing.listDeliverables(
        {
          workspaceId: principal.directoryId,
          teamId,
          kind: 'work-item',
          issueId: issue.id,
          projectId,
        },
        {
          memberKey: principal.userKey,
          guest: principal.workspaceRole === 'guest',
          canWrite: canWriteTeamIssue(principal, context, issue.assignedProjectId),
          canManage: principal.workspaceRole !== 'guest' &&
            canManageTeamIssueCollaboration(principal, context, issue.assignedProjectId),
        },
      )
      return summaries.map((summary) => toProjectDeliverable(summary, toWorkItemOwner(issue)))
    },
  )
  return {
    deliverables: filterAndSortDeliverables([...projectDeliverables, ...workItemDeliverables.flat()], query),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}

/**
 * Reads the canonical Work Item with a strongly consistent read, for an authorization decision.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item ID taken from the list index.
 * @returns The canonical Work Item, or `undefined` when it no longer exists.
 */
async function readCanonicalWorkItem(directoryId: string, teamId: string, issueId: string) {
  try {
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
      directoryId,
      teamId,
      issueId,
      { consistentIssueRead: true, includeEvents: false },
    )
    return detail.issue
  } catch (error) {
    if (isTeamIssueNotFoundError(error)) {
      return undefined
    }
    throw error
  }
}

/**
 * Applies the page filters and orders the rows newest update first.
 *
 * @param deliverables - Rows read for the page.
 * @param query - Page query with the filters.
 * @returns The rows to return.
 */
function filterAndSortDeliverables(deliverables: readonly ProjectDeliverable[], query: ProjectDeliverableQuery) {
  return deliverables
    .filter((deliverable) => matchesProjectDeliverableQuery(deliverable, query))
    .sort((left, right) => right.file.updatedAt.localeCompare(left.file.updatedAt))
}

/**
 * Checks whether a deliverable passes the approval filter and the unresolved-annotation flag.
 *
 * @param deliverable - Deliverable row.
 * @param query - Page query with the filters.
 * @returns Whether the row is returned.
 */
export function matchesProjectDeliverableQuery(
  deliverable: ProjectDeliverable,
  query: Pick<ProjectDeliverableQuery, 'approval' | 'unresolvedOnly'>,
) {
  if (query.unresolvedOnly && deliverable.unresolvedAnnotationCount === 0) {
    return false
  }
  switch (query.approval) {
    case 'all':
      return true
    case 'unapproved':
      return deliverable.approvalState !== 'approved'
    case 'pending':
      return deliverable.approvalState === 'pending'
    case 'approved':
      return deliverable.approvalState === 'approved'
  }
}

/**
 * Builds the owner of a Work Item attachment.
 *
 * @param issue - Readable Work Item of the Project.
 * @returns The Work Item owner shown in the list.
 */
function toWorkItemOwner(issue: TeamIssueResponseItem): ProjectDeliverable['owner'] {
  return {
    kind: 'work-item',
    teamId: issue.teamId,
    issueId: issue.id,
    title: issue.title,
    ...(issue.key ? { key: issue.key } : {}),
  }
}

/**
 * Builds one deliverable row from a scope's file summary.
 *
 * @param summary - File with its current-version review state.
 * @param owner - Project or Work Item that holds the file.
 * @returns The deliverable row.
 */
function toProjectDeliverable(
  summary: FileDeliverableSummary,
  owner: ProjectDeliverable['owner'],
): ProjectDeliverable {
  return {
    file: summary.file,
    owner,
    approvalState: summary.approvalState,
    ...(summary.approvalId ? { approvalId: summary.approvalId } : {}),
    unresolvedAnnotationCount: summary.unresolvedAnnotationCount,
  }
}

/**
 * Narrows an untrusted query value to a supported approval filter.
 *
 * @param value - Query value.
 * @returns Whether the value is a supported filter.
 */
function isProjectDeliverableApprovalFilter(value: string): value is ProjectDeliverableApprovalFilter {
  return value === 'all' || value === 'unapproved' || value === 'pending' || value === 'approved'
}
