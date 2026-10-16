import {
  SEARCH_SCHEMA_VERSION,
  type CreateWorkItemCollectionInput,
  type UpdateWorkItemCollectionInput,
  type WorkItemCollection,
  type WorkItemCollectionEntry,
  type WorkItemCollectionItemsResponse,
  type WorkItemCollectionsResponse,
  type WorkflowStatusCategory,
} from '@mukuroji/contracts'
import { isRecord } from '../../../shared/api/jsonValidation'
import { toCollectionCandidates } from '../model/collectionCandidates'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'

/** Error returned by a Collection request. */
export class CollectionApiError extends Error {
  /** HTTP status returned by the Collection API. */
  readonly status: number
  /** Stable API error code, when provided. */
  readonly code?: string

  /**
   * Creates one Collection API error.
   *
   * @param status - HTTP status returned by the API.
   * @param message - Human-readable failure message.
   * @param code - Optional stable API error code.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'CollectionApiError'
    this.status = status
    this.code = code
  }
}

const collectionsApiBaseUrl = `${(import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/u, '')}/collections`

/** Workflow status categories accepted from the API. */
const statusCategories: readonly WorkflowStatusCategory[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled']

/**
 * Loads the Workspace's Collections and whether the caller may change them.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @returns Collections ordered by name, with the caller's write capability.
 */
export async function getCollections(accessToken: string): Promise<WorkItemCollectionsResponse> {
  const data = await requestJson(collectionsApiBaseUrl, accessToken)
  if (!isCollectionsResponse(data)) throw invalidResponse()
  return { collections: data.collections, canWrite: data.canWrite }
}

/** One page of Work Item candidates; each result is validated by the caller. */
export type CollectionCandidatePage = {
  /** Raw search results from the API. */
  results: unknown[]
  /** Opaque cursor for the next page, when more results remain. */
  nextCursor?: string
}

/**
 * Searches Work Items that the caller can read and add to a Collection.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param keyword - Non-blank search keyword.
 * @param options - Page size and the cursor returned by the previous page.
 * @returns One page of search results.
 */
export async function searchCollectionCandidatePage(
  accessToken: string,
  keyword: string,
  options: { limit: number; cursor?: string },
): Promise<CollectionCandidatePage> {
  const query = new URLSearchParams({ keyword, limit: String(options.limit) })
  if (options.cursor) query.set('cursor', options.cursor)
  const data = await requestJson(`${collectionsApiBaseUrl}/candidates?${query.toString()}`, accessToken)
  // A page from another search schema, or with non-object results, is malformed rather than empty.
  // Every result must be a complete Work Item candidate; a malformed one is a transport error,
  // not a match to drop silently.
  if (
    !isRecord(data) ||
    data.schemaVersion !== SEARCH_SCHEMA_VERSION ||
    !Array.isArray(data.results) ||
    !data.results.every((result) => toCollectionCandidates([result]).length === 1)
  ) {
    throw invalidResponse()
  }
  const { nextCursor } = data
  if (nextCursor !== undefined && typeof nextCursor !== 'string') throw invalidResponse()
  return { results: data.results, ...(nextCursor ? { nextCursor } : {}) }
}

/**
 * Loads the readable Work Items of one Collection.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param collectionId - Collection identifier.
 * @returns The Collection and its readable Work Items.
 */
export async function getCollectionItems(accessToken: string, collectionId: string): Promise<WorkItemCollectionItemsResponse> {
  const data = await requestJson(`${collectionPath(collectionId)}/items`, accessToken)
  if (!isRecord(data) || !isCollection(data.collection) || !Array.isArray(data.items) || !data.items.every(isCollectionEntry)) {
    throw invalidResponse()
  }
  return { collection: data.collection, items: data.items }
}

/**
 * Creates a Collection.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param input - Name and optional description.
 * @param context - Retry context shared by every attempt of this creation.
 * @returns The created Collection.
 */
export async function createCollection(
  accessToken: string,
  input: CreateWorkItemCollectionInput,
  context: MutationRequestContext,
): Promise<WorkItemCollection> {
  return readCollection(await requestJson(collectionsApiBaseUrl, accessToken, {
    method: 'POST',
    headers: { ...createMutationHeaders(context), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

/**
 * Renames or re-describes a Collection.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param collectionId - Collection identifier.
 * @param input - Change and the observed revision.
 * @returns The updated Collection.
 */
export async function updateCollection(
  accessToken: string,
  collectionId: string,
  input: UpdateWorkItemCollectionInput,
): Promise<WorkItemCollection> {
  return readCollection(await requestJson(collectionPath(collectionId), accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

/**
 * Deletes a Collection; its Work Items are not changed.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param collectionId - Collection identifier.
 * @param expectedRevision - Observed revision.
 */
export async function deleteCollection(accessToken: string, collectionId: string, expectedRevision: number): Promise<void> {
  const query = new URLSearchParams({ expectedRevision: String(expectedRevision) })
  await requestJson(`${collectionPath(collectionId)}?${query.toString()}`, accessToken, { method: 'DELETE' })
}

/**
 * Adds a Work Item to a Collection.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param collectionId - Collection identifier.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @returns The Collection after the change.
 */
export async function addCollectionItem(accessToken: string, collectionId: string, teamId: string, issueId: string): Promise<WorkItemCollection> {
  return readCollection(await requestJson(itemPath(collectionId, teamId, issueId), accessToken, { method: 'PUT' }))
}

/**
 * Removes a Work Item reference from a Collection.
 *
 * @param accessToken - Bearer token for the Workspace.
 * @param collectionId - Collection identifier.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @returns The Collection after the change.
 */
export async function removeCollectionItem(accessToken: string, collectionId: string, teamId: string, issueId: string): Promise<WorkItemCollection> {
  return readCollection(await requestJson(itemPath(collectionId, teamId, issueId), accessToken, { method: 'DELETE' }))
}

/**
 * Builds the path of one Collection.
 *
 * @param collectionId - Collection identifier.
 * @returns Collection URL.
 */
function collectionPath(collectionId: string): string {
  return `${collectionsApiBaseUrl}/${encodeURIComponent(collectionId)}`
}

/**
 * Builds the path of one Collection item.
 *
 * @param collectionId - Collection identifier.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @returns Collection item URL.
 */
function itemPath(collectionId: string, teamId: string, issueId: string): string {
  return `${collectionPath(collectionId)}/items/${encodeURIComponent(teamId)}/${encodeURIComponent(issueId)}`
}

/**
 * Sends an authenticated request and decodes its JSON body.
 *
 * @param url - Request URL.
 * @param accessToken - Bearer token.
 * @param init - Request options.
 * @returns Untrusted JSON body.
 */
async function requestJson(url: string, accessToken: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(url, { ...init, headers })
  const text = await response.text()
  let data: unknown = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = {}
    }
  }
  if (!response.ok) {
    const error = isRecord(data) ? data : {}
    throw new CollectionApiError(
      response.status,
      typeof error.message === 'string' && error.message.trim() ? error.message : 'Collection request failed.',
      typeof error.code === 'string' ? error.code : undefined,
    )
  }
  return data
}

/**
 * Validates a single-Collection response.
 *
 * @param value - Untrusted JSON body.
 * @returns The Collection.
 */
function readCollection(value: unknown): WorkItemCollection {
  if (!isCollection(value)) throw invalidResponse()
  return value
}

/**
 * Validates the Collection list response.
 *
 * @param value - Untrusted JSON body.
 * @returns Whether the body is a Collection list.
 */
function isCollectionsResponse(value: unknown): value is WorkItemCollectionsResponse {
  return isRecord(value) && Array.isArray(value.collections) && value.collections.every(isCollection) &&
    typeof value.canWrite === 'boolean'
}

/**
 * Validates one Collection.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a Collection.
 */
function isCollection(value: unknown): value is WorkItemCollection {
  return isRecord(value) &&
    typeof value.collectionId === 'string' &&
    typeof value.name === 'string' &&
    (value.description === undefined || typeof value.description === 'string') &&
    typeof value.createdBy === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 1
}

/**
 * Validates one Collection entry.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a Collection entry.
 */
function isCollectionEntry(value: unknown): value is WorkItemCollectionEntry {
  return isRecord(value) &&
    typeof value.teamId === 'string' &&
    typeof value.issueId === 'string' &&
    typeof value.title === 'string' &&
    statusCategories.some((category) => category === value.statusCategory) &&
    (value.assignedProjectId === undefined || typeof value.assignedProjectId === 'string') &&
    typeof value.addedAt === 'string'
}

/**
 * Creates the shared invalid-response error.
 *
 * @returns A 502 Collection API error.
 */
function invalidResponse(): CollectionApiError {
  return new CollectionApiError(502, 'Collection response is invalid.')
}
