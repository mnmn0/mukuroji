import type {
  FileScanStatus,
  ProjectDeliverable,
  ProjectDeliverableApprovalFilter,
  ProjectDeliverableApprovalState,
  ProjectDeliverablePage,
} from '@mukuroji/contracts'
import { FilesApiError } from './errors'
import { createFileOwnerPath } from './fileScopePath'

/**
 * Query of one Project deliverables page.
 */
export type ProjectDeliverablePageQuery = {
  /**
   * Approval state filter.
   */
  approval: ProjectDeliverableApprovalFilter
  /**
   * Whether only files with unresolved annotations on the current version are returned.
   */
  unresolvedOnly: boolean
  /**
   * Opaque cursor returned by the previous page.
   */
  cursor?: string
  /**
   * Work Items read for the page.
   */
  limit?: number
}

/**
 * Reads one page of a Project's deliverables: the Project's files and the files of the Work
 * Items the caller can read.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose deliverables are listed.
 * @param accessToken - Files API access token.
 * @param query - Filters and cursor of the page.
 * @returns The page.
 * @throws FilesApiError when the request fails or the response is malformed.
 */
export async function getProjectDeliverables(
  teamId: string,
  projectId: string,
  accessToken: string,
  query: ProjectDeliverablePageQuery,
): Promise<ProjectDeliverablePage> {
  const search = new URLSearchParams()
  if (query.approval !== 'all') search.set('approval', query.approval)
  if (query.unresolvedOnly) search.set('unresolvedOnly', 'true')
  if (query.cursor) search.set('cursor', query.cursor)
  if (query.limit !== undefined) search.set('limit', String(query.limit))
  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  const response = await fetch(
    `${createFileOwnerPath({ kind: 'project', teamId, projectId })}/deliverables${suffix}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  const data = await readJson(response)
  if (!response.ok) {
    throw new FilesApiError(
      response.status,
      isRecord(data) && typeof data.message === 'string' ? data.message : 'files.error.request',
      isRecord(data) && typeof data.code === 'string' ? data.code : undefined,
    )
  }
  if (!isRecord(data) || !Array.isArray(data.deliverables) || !data.deliverables.every(isProjectDeliverable)) {
    throw new FilesApiError(502, 'files.error.request', 'InvalidDeliverableResponse')
  }
  return {
    deliverables: data.deliverables,
    ...(typeof data.nextCursor === 'string' && data.nextCursor ? { nextCursor: data.nextCursor } : {}),
  }
}

/** Approval states a deliverable row may carry. */
const deliverableApprovalStates: ReadonlySet<unknown> = new Set<ProjectDeliverableApprovalState>([
  'none',
  'pending',
  'approved',
  'rejected',
  'changes-requested',
])

/** Scan states a deliverable's current version may carry. */
const deliverableScanStatuses: ReadonlySet<unknown> = new Set<FileScanStatus>([
  'pending',
  'scanning',
  'available',
  'blocked',
  'failed',
])

/**
 * Checks the fields of a deliverable row that the list and the CSV export read, so a malformed
 * row fails the page instead of breaking a render or an export later.
 *
 * @param value - Untrusted response row.
 * @returns Whether the row is a deliverable.
 */
function isProjectDeliverable(value: unknown): value is ProjectDeliverable {
  return isRecord(value) &&
    isDeliverableFile(value.file) &&
    isDeliverableOwner(value.owner) &&
    deliverableApprovalStates.has(value.approvalState) &&
    (value.approvalId === undefined || typeof value.approvalId === 'string') &&
    isAnnotationCount(value.unresolvedAnnotationCount)
}

/**
 * Checks the file fields of a deliverable row: identity, name, update time, and current version.
 *
 * @param value - Untrusted `file` value.
 * @returns Whether the file has every field the list and the CSV read.
 */
function isDeliverableFile(value: unknown): boolean {
  return isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.name === 'string' &&
    isNonEmptyString(value.updatedAt) &&
    isRecord(value.currentVersion) &&
    isNonEmptyString(value.currentVersion.id) &&
    typeof value.currentVersion.number === 'number' &&
    Number.isInteger(value.currentVersion.number) &&
    value.currentVersion.number > 0 &&
    deliverableScanStatuses.has(value.currentVersion.scanStatus)
}

/**
 * Checks the owner of a deliverable row: the Project, or a Work Item with its identity and title.
 *
 * @param value - Untrusted `owner` value.
 * @returns Whether the owner has every identifier and display field the list reads.
 */
function isDeliverableOwner(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.teamId)) return false
  if (value.kind === 'project') return isNonEmptyString(value.projectId)
  return value.kind === 'work-item' &&
    isNonEmptyString(value.issueId) &&
    typeof value.title === 'string' &&
    (value.key === undefined || typeof value.key === 'string')
}

/**
 * Checks an unresolved annotation count.
 *
 * @param value - Untrusted count.
 * @returns Whether the value is a non-negative integer.
 */
function isAnnotationCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Checks for a non-empty string.
 *
 * @param value - Value to check.
 * @returns Whether the value is a string with at least one character.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reads a JSON body, returning `undefined` for an empty or malformed body.
 *
 * @param response - HTTP response.
 * @returns The parsed body.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
