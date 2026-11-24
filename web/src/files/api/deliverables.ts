import type {
  ProjectDeliverable,
  ProjectDeliverableApprovalFilter,
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

/**
 * Checks the fields of a deliverable row that the list reads.
 *
 * @param value - Untrusted response row.
 * @returns Whether the row is a deliverable.
 */
function isProjectDeliverable(value: unknown): value is ProjectDeliverable {
  return isRecord(value) &&
    isRecord(value.file) &&
    typeof value.file.id === 'string' &&
    typeof value.file.name === 'string' &&
    isRecord(value.file.currentVersion) &&
    isRecord(value.owner) &&
    (value.owner.kind === 'project' || value.owner.kind === 'work-item') &&
    typeof value.approvalState === 'string' &&
    typeof value.unresolvedAnnotationCount === 'number'
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
