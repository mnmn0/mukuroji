import {
  COLLABORATION_CONTEXT_SCHEMA_VERSION,
  type AcceptedResolutionPage,
  type CuratedContextActorSnapshot,
  type CuratedContextCapabilities,
  type CuratedContextItem,
  type CuratedContextItemKind,
  type CuratedContextItemState,
  type CuratedContextPage,
  type CuratedContextQuote,
  type CuratedContextRevisionPage,
  type CuratedContextSourceAvailability,
  type CuratedContextSourceKind,
  type CuratedContextSource,
  type CreateCuratedContextItemRequest,
  type SetAcceptedResolutionRequest,
  type UpdateCuratedContextItemRequest,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import { TeamIssuesApiError } from './errors'
import { isAcceptedResolution } from './collaboration'
import {
  createTeamIssuePath,
  readApiError,
  readJson,
  trimTrailingSlash,
} from './http'

/**
 * Cursor options for the curated context ledger.
 */
export type GetTeamIssueContextItemsOptions = {
  /** Maximum number of items requested from one page. */
  limit?: number
  /** Opaque cursor returned by the previous page. */
  cursor?: string
}

/**
 * Cursor options for one bounded collaboration history page.
 */
export type GetTeamIssueHistoryOptions = {
  /** Maximum number of history snapshots requested from one page. */
  limit?: number
  /** Opaque resource-bound cursor returned by the previous page. */
  cursor?: string
}

const issuesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Loads one cursor page of human-curated Work Item context.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param accessToken - Access token for the Issues API.
 * @param options - Opaque cursor and page-size options.
 * @returns A runtime-validated curated context page.
 */
export async function getTeamIssueContextItems(
  teamId: string,
  issueId: string,
  accessToken: string,
  options: GetTeamIssueContextItemsOptions = {},
): Promise<CuratedContextPage> {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.cursor) query.set('cursor', options.cursor)
  const queryString = query.toString()
  const data = await requestIssueJson(
    `${createTeamIssuePath(issuesApiBaseUrl, teamId, issueId)}/context-items${
      queryString ? `?${queryString}` : ''
    }`,
    accessToken,
  )

  if (!isCuratedContextPage(data)) {
    throw new TeamIssuesApiError(
      502,
      'The curated context response was invalid.',
      'InvalidCuratedContextResponse',
    )
  }

  return data
}

/**
 * Loads immutable revisions for one curated context item.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param contextItemId - Curated context item whose revisions are requested.
 * @param accessToken - Access token for the Issues API.
 * @param options - Opaque cursor and bounded page-size options.
 * @returns A runtime-validated revision history page.
 */
export async function getTeamIssueContextRevisions(
  teamId: string,
  issueId: string,
  contextItemId: string,
  accessToken: string,
  options: GetTeamIssueHistoryOptions = {},
): Promise<CuratedContextRevisionPage> {
  const query = createHistoryQuery(options)
  const data = await requestIssueJson(
    `${createTeamIssuePath(issuesApiBaseUrl, teamId, issueId)}/context-items/${encodeURIComponent(
      contextItemId,
    )}/revisions${query}`,
    accessToken,
  )

  if (!isCuratedContextRevisionPage(data)) {
    throw new TeamIssuesApiError(
      502,
      'The curated context revision response was invalid.',
      'InvalidCuratedContextRevisionResponse',
    )
  }

  return data
}

/**
 * Loads accepted-resolution history for one root comment thread.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param rootCommentId - Root comment that owns the accepted resolutions.
 * @param accessToken - Access token for the Issues API.
 * @param options - Opaque cursor and bounded page-size options.
 * @returns A runtime-validated accepted-resolution history page.
 */
export async function getTeamIssueAcceptedResolutions(
  teamId: string,
  issueId: string,
  rootCommentId: string,
  accessToken: string,
  options: GetTeamIssueHistoryOptions = {},
): Promise<AcceptedResolutionPage> {
  const query = createHistoryQuery(options)
  const data = await requestIssueJson(
    `${createTeamIssuePath(issuesApiBaseUrl, teamId, issueId)}/comments/${encodeURIComponent(
      rootCommentId,
    )}/accepted-resolutions${query}`,
    accessToken,
  )

  if (!isAcceptedResolutionPage(data)) {
    throw new TeamIssuesApiError(
      502,
      'The accepted resolution history response was invalid.',
      'InvalidAcceptedResolutionHistoryResponse',
    )
  }

  return data
}

/**
 * Creates one human-curated context item.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param accessToken - Access token for the Issues API.
 * @param input - Human-authored item and optional source provenance.
 * @param mutationContext - Stable operation and idempotency metadata.
 * @returns A promise that resolves after the API accepts the mutation.
 */
export function createTeamIssueContextItem(
  teamId: string,
  issueId: string,
  accessToken: string,
  input: CreateCuratedContextItemRequest,
  mutationContext: MutationRequestContext,
): Promise<void> {
  return requestIssueMutation(
    `${createTeamIssuePath(issuesApiBaseUrl, teamId, issueId)}/context-items`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  )
}

/**
 * Updates one curated item behind an optimistic revision fence.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param contextItemId - Curated item identifier.
 * @param accessToken - Access token for the Issues API.
 * @param input - Revision-fenced human edits.
 * @param mutationContext - Stable operation and idempotency metadata.
 * @returns A promise that resolves after the API accepts the mutation.
 */
export function updateTeamIssueContextItem(
  teamId: string,
  issueId: string,
  contextItemId: string,
  accessToken: string,
  input: UpdateCuratedContextItemRequest,
  mutationContext: MutationRequestContext,
): Promise<void> {
  return requestIssueMutation(
    `${createTeamIssuePath(issuesApiBaseUrl, teamId, issueId)}/context-items/${encodeURIComponent(
      contextItemId,
    )}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PATCH',
    },
  )
}

/**
 * Selects or replaces a thread's accepted resolution with a required manual summary.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param rootCommentId - Root comment that owns the resolution.
 * @param accessToken - Access token for the Issues API.
 * @param input - Selected comment, thread version, and manual summary.
 * @param mutationContext - Stable operation and idempotency metadata.
 * @returns A promise that resolves after the API accepts the mutation.
 */
export function setTeamIssueAcceptedResolution(
  teamId: string,
  issueId: string,
  rootCommentId: string,
  accessToken: string,
  input: SetAcceptedResolutionRequest,
  mutationContext: MutationRequestContext,
): Promise<void> {
  return requestIssueMutation(
    `${createTeamIssuePath(issuesApiBaseUrl, teamId, issueId)}/comments/${encodeURIComponent(
      rootCommentId,
    )}/accepted-resolution`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PUT',
    },
  )
}

/**
 * Reads JSON from one authenticated Issues API request.
 *
 * @param url - Same-origin or configured Issues API URL.
 * @param accessToken - Access token used for authorization.
 * @param init - Optional request configuration.
 * @returns Untrusted decoded JSON for runtime validation.
 */
async function requestIssueJson(
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson(response)

  if (!response.ok) {
    const error = readApiError(data)
    throw new TeamIssuesApiError(response.status, error.message, error.code)
  }

  return data
}

/**
 * Performs a mutation whose response body is refreshed through SWR.
 *
 * @param url - Same-origin or configured Issues API URL.
 * @param accessToken - Access token used for authorization.
 * @param init - Mutation request configuration.
 * @returns A promise that resolves after a successful response.
 */
async function requestIssueMutation(
  url: string,
  accessToken: string,
  init: RequestInit,
): Promise<void> {
  await requestIssueJson(url, accessToken, init)
}

/**
 * Decodes a response body without trusting its shape.
 *
 * @param response - Fetch response to decode.
 * @returns Parsed JSON or an empty object for empty and malformed responses.
 */
/**
 * Validates a complete curated context page at the API boundary.
 *
 * @param value - Untrusted decoded JSON.
 * @returns Whether the value is a curated context page.
 */
function isCuratedContextPage(value: unknown): value is CuratedContextPage {
  return (
    isRecord(value) &&
    value.schemaVersion === COLLABORATION_CONTEXT_SCHEMA_VERSION &&
    Array.isArray(value.items) &&
    value.items.every(isCuratedContextItem) &&
    (value.nextCursor === undefined || typeof value.nextCursor === 'string') &&
    isCuratedContextCapabilities(value.capabilities)
  )
}

/**
 * Validates a cursor page of immutable curated context revisions.
 *
 * @param value - Untrusted decoded JSON.
 * @returns Whether the value is a complete revision page.
 */
function isCuratedContextRevisionPage(
  value: unknown,
): value is CuratedContextRevisionPage {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isCuratedContextItem) &&
    (value.nextCursor === undefined || typeof value.nextCursor === 'string')
  )
}

/**
 * Validates a cursor page of accepted-resolution snapshots.
 *
 * @param value - Untrusted decoded JSON.
 * @returns Whether the value is a complete accepted-resolution page.
 */
function isAcceptedResolutionPage(
  value: unknown,
): value is AcceptedResolutionPage {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isAcceptedResolution) &&
    (value.nextCursor === undefined || typeof value.nextCursor === 'string')
  )
}

/**
 * Validates one curated item.
 *
 * @param value - Untrusted item candidate.
 * @returns Whether the value has the complete curated item shape.
 */
function isCuratedContextItem(value: unknown): value is CuratedContextItem {
  return (
    isRecord(value) &&
    value.schemaVersion === COLLABORATION_CONTEXT_SCHEMA_VERSION &&
    typeof value.id === 'string' &&
    typeof value.teamId === 'string' &&
    typeof value.workItemId === 'string' &&
    isCuratedContextKind(value.kind) &&
    isCuratedContextState(value.state) &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    (value.source === undefined || isCuratedContextSource(value.source)) &&
    isStringArray(value.mentionMemberKeys) &&
    isCuratedContextActor(value.createdBy) &&
    typeof value.createdAt === 'string' &&
    isCuratedContextActor(value.updatedBy) &&
    typeof value.updatedAt === 'string' &&
    typeof value.revision === 'number' &&
    (value.supersededByItemId === undefined ||
      typeof value.supersededByItemId === 'string')
  )
}

/**
 * Validates source provenance retained by a curated item.
 *
 * @param value - Untrusted source candidate.
 * @returns Whether the value has the complete source shape.
 */
function isCuratedContextSource(value: unknown): value is CuratedContextSource {
  return (
    isRecord(value) &&
    isCuratedContextSourceKind(value.kind) &&
    typeof value.sourceId === 'string' &&
    isOptionalString(value.containerId) &&
    isOptionalString(value.originalBody) &&
    (value.quote === undefined || isCuratedContextQuote(value.quote)) &&
    isOptionalString(value.permalink) &&
    (value.actor === undefined || isCuratedContextActor(value.actor)) &&
    typeof value.occurredAt === 'string' &&
    isOptionalRevision(value.capturedRevision) &&
    isOptionalRevision(value.currentRevision) &&
    isCuratedContextAvailability(value.availability) &&
    isOptionalString(value.availabilityReason)
  )
}

/**
 * Validates an immutable quote snapshot.
 *
 * @param value - Untrusted quote candidate.
 * @returns Whether the quote is complete.
 */
function isCuratedContextQuote(value: unknown): value is CuratedContextQuote {
  if (!isRecord(value) || typeof value.text !== 'string') return false
  const hasStart = value.startOffset !== undefined
  const hasEnd = value.endOffset !== undefined
  return (
    hasStart === hasEnd &&
    (!hasStart || (
      isOptionalNumber(value.startOffset) &&
      isOptionalNumber(value.endOffset)
    ))
  )
}

/**
 * Validates an actor snapshot.
 *
 * @param value - Untrusted actor candidate.
 * @returns Whether the actor snapshot is complete.
 */
function isCuratedContextActor(
  value: unknown,
): value is CuratedContextActorSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.displayName === 'string' &&
    isOptionalString(value.avatarUrl)
  )
}

/**
 * Validates page-level curated context capabilities.
 *
 * @param value - Untrusted capabilities candidate.
 * @returns Whether all capability flags are present.
 */
function isCuratedContextCapabilities(
  value: unknown,
): value is CuratedContextCapabilities {
  return (
    isRecord(value) &&
    typeof value.canCreate === 'boolean' &&
    typeof value.canEdit === 'boolean' &&
    typeof value.canReplace === 'boolean' &&
    typeof value.canAcceptResolution === 'boolean'
  )
}

/** Validates a curated item kind. */
function isCuratedContextKind(
  value: unknown,
): value is CuratedContextItemKind {
  return (
    value === 'decision' ||
    value === 'action' ||
    value === 'risk' ||
    value === 'context'
  )
}

/** Validates a curated item state. */
function isCuratedContextState(
  value: unknown,
): value is CuratedContextItemState {
  return (
    value === 'active' ||
    value === 'accepted' ||
    value === 'completed' ||
    value === 'superseded'
  )
}

/** Validates a source kind. */
function isCuratedContextSourceKind(
  value: unknown,
): value is CuratedContextSourceKind {
  return (
    value === 'comment' ||
    value === 'external-chat' ||
    value === 'document' ||
    value === 'activity'
  )
}

/** Validates a source availability state. */
function isCuratedContextAvailability(
  value: unknown,
): value is CuratedContextSourceAvailability {
  return (
    value === 'available' ||
    value === 'edited' ||
    value === 'deleted' ||
    value === 'permission-lost' ||
    value === 'retention-expired'
  )
}

/** Validates a generic object boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validates a string array. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Validates an optional string. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** Validates an optional number. */
function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === 'number'
}

/** Validates an optional source-native revision. */
function isOptionalRevision(
  value: unknown,
): value is string | number | undefined {
  return (
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number'
  )
}

/**
 * Creates the encoded query suffix for a bounded history request.
 *
 * @param options - Optional cursor and page-size values.
 * @returns An empty string or a question-mark-prefixed query string.
 */
function createHistoryQuery(options: GetTeamIssueHistoryOptions): string {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.cursor) query.set('cursor', options.cursor)
  const queryString = query.toString()
  return queryString ? `?${queryString}` : ''
}

/**
 * Creates the encoded base path for one Team-owned Work Item.
 *
 * @param teamId - Team identifier.
 * @param issueId - Work Item identifier.
 * @returns Configured Issues API path.
 */
