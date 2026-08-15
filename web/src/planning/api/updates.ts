import type {
  ConfigurePlanningUpdateCadenceInput,
  CreatePlanningUpdateCommentInput,
  ListPlanningUpdateCommentsInput,
  ListPlanningUpdateReactionsInput,
  ListPlanningUpdatesInput,
  PlanningUpdateReactionInput,
  PlanningUpdateTarget,
  PublishPlanningUpdateInput,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import {
  readPlanningUpdateCadenceMutationResponse,
  readPlanningUpdateCommentMutationResponse,
  readPlanningUpdateCommentPage,
  readPlanningUpdateHistoryPage,
  readPlanningUpdatePublishResponse,
  readPlanningUpdateReactionMutationResponse,
  readPlanningUpdateReactionPage,
} from './contractValidation'
import { PlanningApiError } from './errors'

const planningApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultPlanningApiErrorMessage = 'Unable to complete the planning request.'

/** Browser-download artifact containing immutable Planning update history. */
export type PlanningUpdateExportArtifact = {
  /** Exported file body. */
  blob: Blob
  /** Filename resolved from Content-Disposition or a stable fallback. */
  filename: string
}

/** Current viewer's watcher state for one Planning update target. */
export type PlanningUpdateWatchState = {
  /** Whether the current viewer receives target update notifications. */
  subscribed: boolean
  /** Whether the viewer made an explicit watch choice. */
  explicit: boolean
  /** Whether an automatic collaboration reason currently enables watching. */
  automatic: boolean
  /** Reasons that currently enable watching. */
  reasons: string[]
  /** Number of unique target watchers. */
  watcherCount: number
}

/**
 * Configures or clears the recurring cadence for a Project or Initiative update target.
 *
 * @param accessToken - Authorization bearer token.
 * @param input - Target, cadence, and expected Planning revision.
 * @param mutationContext - Correlation and idempotency identifiers shared across retries.
 * @returns The authoritative Planning snapshot and updated target summary.
 */
export function configurePlanningUpdateCadence(
  accessToken: string,
  input: ConfigurePlanningUpdateCadenceInput,
  mutationContext: MutationRequestContext,
) {
  return requestPlanningUpdateJson(
    `${planningApiBaseUrl}/planning/updates/cadence`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PUT',
    },
    readPlanningUpdateCadenceMutationResponse,
  )
}

/**
 * Publishes one immutable, manually authored Project or Initiative update.
 *
 * @param accessToken - Authorization bearer token.
 * @param input - Structured update content and expected Planning revision.
 * @param mutationContext - Correlation and idempotency identifiers shared across retries.
 * @returns The authoritative Planning snapshot and newly published update.
 */
export function publishPlanningUpdate(
  accessToken: string,
  input: PublishPlanningUpdateInput,
  mutationContext: MutationRequestContext,
) {
  return requestPlanningUpdateJson(
    `${planningApiBaseUrl}/planning/updates`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
    readPlanningUpdatePublishResponse,
  )
}

/**
 * Loads one cursor-paginated page of immutable update history.
 *
 * @param accessToken - Authorization bearer token.
 * @param input - Target and optional pagination values.
 * @returns A validated history page ordered newest first.
 */
export function listPlanningUpdates(
  accessToken: string,
  input: ListPlanningUpdatesInput,
) {
  const query = createPlanningUpdateSearchParams(input.target, {
    cursor: input.cursor,
    limit: input.limit,
  })
  return requestPlanningUpdateJson(
    `${planningApiBaseUrl}/planning/updates?${query.toString()}`,
    accessToken,
    { method: 'GET' },
    readPlanningUpdateHistoryPage,
  )
}

/**
 * Loads append-only comments attached to one immutable update version.
 *
 * @param accessToken - Authorization bearer token.
 * @param input - Target, immutable update version, and optional pagination values.
 * @returns A validated comment page ordered newest first.
 */
export function listPlanningUpdateComments(
  accessToken: string,
  input: ListPlanningUpdateCommentsInput,
) {
  const query = createPlanningUpdateSearchParams(input.target, {
    cursor: input.cursor,
    limit: input.limit,
  })
  return requestPlanningUpdateJson(
    `${planningApiBaseUrl}/planning/updates/${input.updateVersion}/comments?${query.toString()}`,
    accessToken,
    { method: 'GET' },
    readPlanningUpdateCommentPage,
  )
}

/**
 * Appends a comment to one immutable update version.
 *
 * @param accessToken - Authorization bearer token.
 * @param input - Canonical target, immutable update version, ID, and comment body.
 * @param mutationContext - Correlation and idempotency identifiers shared across retries.
 * @returns The newly created comment envelope.
 */
export function createPlanningUpdateComment(
  accessToken: string,
  input: CreatePlanningUpdateCommentInput,
  mutationContext: MutationRequestContext,
) {
  const query = createPlanningUpdateSearchParams(input.target)
  return requestPlanningUpdateJson(
    `${planningApiBaseUrl}/planning/updates/${input.updateVersion}/comments?${query.toString()}`,
    accessToken,
    {
      body: JSON.stringify({ body: input.body, id: input.id }),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
    readPlanningUpdateCommentMutationResponse,
  )
}

/**
 * Loads member reactions attached to one immutable update version.
 *
 * @param accessToken - Authorization bearer token.
 * @param input - Target, immutable update version, and optional pagination values.
 * @returns A validated reaction page.
 */
export function listPlanningUpdateReactions(
  accessToken: string,
  input: ListPlanningUpdateReactionsInput,
) {
  const query = createPlanningUpdateSearchParams(input.target, {
    cursor: input.cursor,
    limit: input.limit,
  })
  return requestPlanningUpdateJson(
    `${planningApiBaseUrl}/planning/updates/${input.updateVersion}/reactions?${query.toString()}`,
    accessToken,
    { method: 'GET' },
    readPlanningUpdateReactionPage,
  )
}

/**
 * Adds the current member's reaction to one immutable update version.
 *
 * @param accessToken - Authorization bearer token.
 * @param input - Canonical target, immutable update version, and reaction emoji.
 * @param mutationContext - Correlation and idempotency identifiers shared across retries.
 * @returns The newly added reaction envelope.
 */
export function addPlanningUpdateReaction(
  accessToken: string,
  input: PlanningUpdateReactionInput,
  mutationContext: MutationRequestContext,
) {
  return requestPlanningUpdateReactionMutation(
    accessToken,
    input,
    mutationContext,
    'PUT',
  )
}

/**
 * Removes the current member's reaction from one immutable update version.
 *
 * @param accessToken - Authorization bearer token.
 * @param input - Canonical target, immutable update version, and reaction emoji.
 * @param mutationContext - Correlation and idempotency identifiers shared across retries.
 * @returns A promise that resolves after the 204 response is accepted.
 */
export function removePlanningUpdateReaction(
  accessToken: string,
  input: PlanningUpdateReactionInput,
  mutationContext: MutationRequestContext,
) {
  return requestPlanningUpdateReactionMutation(
    accessToken,
    input,
    mutationContext,
    'DELETE',
  )
}

/**
 * Exports immutable update history for one Project or Initiative target.
 *
 * @param accessToken - Authorization bearer token.
 * @param target - Project or Initiative whose history is exported.
 * @returns A browser-download artifact.
 */
export async function exportPlanningUpdates(
  accessToken: string,
  target: PlanningUpdateTarget,
): Promise<PlanningUpdateExportArtifact> {
  const query = createPlanningUpdateSearchParams(target)
  const response = await fetch(
    `${planningApiBaseUrl}/planning/updates/export?${query.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      method: 'GET',
    },
  )
  if (!response.ok) await throwPlanningUpdateResponseError(response)
  return {
    blob: await response.blob(),
    filename: readDownloadFilename(response.headers.get('Content-Disposition')) ??
      'mukuroji-planning-updates.json',
  }
}

/**
 * Loads the current viewer's watcher state for one update target.
 *
 * @param accessToken - Authorization bearer token.
 * @param target - Project or Initiative update target.
 * @returns The validated watcher state.
 */
export function getPlanningUpdateWatch(
  accessToken: string,
  target: PlanningUpdateTarget,
) {
  return requestPlanningUpdateWatch(accessToken, target, 'GET')
}

/**
 * Subscribes the current viewer to one update target.
 *
 * @param accessToken - Authorization bearer token.
 * @param target - Project or Initiative update target.
 * @param mutationContext - Correlation and idempotency identifiers shared across retries.
 * @returns The updated watcher state.
 */
export function subscribePlanningUpdateWatch(
  accessToken: string,
  target: PlanningUpdateTarget,
  mutationContext: MutationRequestContext,
) {
  return requestPlanningUpdateWatch(accessToken, target, 'PUT', mutationContext)
}

/**
 * Unsubscribes the current viewer from one update target.
 *
 * @param accessToken - Authorization bearer token.
 * @param target - Project or Initiative update target.
 * @param mutationContext - Correlation and idempotency identifiers shared across retries.
 * @returns The updated watcher state.
 */
export function unsubscribePlanningUpdateWatch(
  accessToken: string,
  target: PlanningUpdateTarget,
  mutationContext: MutationRequestContext,
) {
  return requestPlanningUpdateWatch(accessToken, target, 'DELETE', mutationContext)
}

/**
 * Adds or removes one current-member immutable-update reaction.
 *
 * @param accessToken - Authorization bearer token.
 * @param input - Target, update version, and emoji.
 * @param mutationContext - Correlation and idempotency identifiers shared across retries.
 * @param method - Idempotent add or remove operation.
 * @returns The added reaction envelope, or no value after removal.
 */
function requestPlanningUpdateReactionMutation(
  accessToken: string,
  input: PlanningUpdateReactionInput,
  mutationContext: MutationRequestContext,
  method: 'DELETE' | 'PUT',
) {
  const query = createPlanningUpdateSearchParams(input.target, method === 'DELETE'
    ? { emoji: input.emoji }
    : {})
  const path = `${planningApiBaseUrl}/planning/updates/${input.updateVersion}/reactions?${query.toString()}`
  const init: RequestInit = method === 'DELETE'
    ? {
        headers: createMutationHeaders(mutationContext),
        method,
      }
    : {
        body: JSON.stringify({ emoji: input.emoji }),
        headers: {
          'Content-Type': 'application/json',
          ...createMutationHeaders(mutationContext),
        },
        method,
      }
  return method === 'DELETE'
    ? requestPlanningUpdateNoContent(path, accessToken, init)
    : requestPlanningUpdateJson(
        path,
        accessToken,
        init,
        readPlanningUpdateReactionMutationResponse,
      )
}

/**
 * Requests and validates a watcher response.
 *
 * @param accessToken - Authorization bearer token.
 * @param target - Project or Initiative update target.
 * @param method - Read, subscribe, or unsubscribe operation.
 * @param mutationContext - Optional mutation headers for writes.
 * @returns The updated watcher state.
 */
function requestPlanningUpdateWatch(
  accessToken: string,
  target: PlanningUpdateTarget,
  method: 'DELETE' | 'GET' | 'PUT',
  mutationContext?: MutationRequestContext,
) {
  const query = createPlanningUpdateSearchParams(target)
  return requestPlanningUpdateJson(
    `${planningApiBaseUrl}/planning/update-watch?${query.toString()}`,
    accessToken,
    {
      headers: mutationContext ? createMutationHeaders(mutationContext) : undefined,
      method,
    },
    readPlanningUpdateWatchResponse,
  )
}

/**
 * Serializes a target and optional pagination values to the Planning API query contract.
 *
 * @param target - Project or Initiative target.
 * @param pagination - Optional cursor and page-size values.
 * @returns URL search parameters with Team-qualified Project identity.
 */
export function createPlanningUpdateSearchParams(
  target: PlanningUpdateTarget,
  pagination: { cursor?: string; emoji?: string; limit?: number } = {},
) {
  const parameters = new URLSearchParams({ targetType: target.type })
  if (target.type === 'project') {
    parameters.set('teamId', target.teamId)
    parameters.set('projectId', target.projectId)
  } else {
    parameters.set('entityId', target.entityId)
  }
  if (pagination.limit !== undefined) parameters.set('limit', String(pagination.limit))
  if (pagination.cursor) parameters.set('cursor', pagination.cursor)
  if (pagination.emoji) parameters.set('emoji', pagination.emoji)
  return parameters
}

/**
 * Requests JSON and accepts it only when the supplied runtime decoder succeeds.
 *
 * @param path - Same-origin Planning API path.
 * @param accessToken - Authorization bearer token.
 * @param init - Optional fetch initialization.
 * @param decode - Runtime decoder for the expected response.
 * @returns The decoded response.
 */
async function requestPlanningUpdateJson<T>(
  path: string,
  accessToken: string,
  init: RequestInit | undefined,
  decode: (value: unknown) => T | undefined,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init?.headers,
    },
  })
  const data = await readJson(response)
  if (!response.ok) {
    throwPlanningUpdateApiError(response.status, data)
  }
  const decoded = decode(data)
  if (!decoded) {
    throw new PlanningApiError(
      response.status,
      defaultPlanningApiErrorMessage,
      'InvalidPlanningUpdateResponse',
    )
  }
  return decoded
}

/**
 * Requests a mutation whose successful response intentionally has no body.
 *
 * @param path - Same-origin Planning API path.
 * @param accessToken - Authorization bearer token.
 * @param init - Fetch initialization including mutation headers.
 * @returns A promise that resolves after any successful no-content response.
 */
async function requestPlanningUpdateNoContent(
  path: string,
  accessToken: string,
  init: RequestInit,
): Promise<void> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  if (!response.ok) {
    throwPlanningUpdateApiError(response.status, await readJson(response))
  }
}

/**
 * Converts an unsuccessful file response into the shared Planning API error.
 *
 * @param response - Unsuccessful export response.
 * @returns This function never returns.
 */
async function throwPlanningUpdateResponseError(response: Response): Promise<never> {
  throwPlanningUpdateApiError(response.status, await readJson(response))
}

/**
 * Throws a shared Planning API error from an unknown response body.
 *
 * @param status - HTTP status code.
 * @param value - Unknown response body.
 * @returns This function never returns.
 */
function throwPlanningUpdateApiError(status: number, value: unknown): never {
  const code = readOptionalRecordString(value, 'code')
  const message = readOptionalRecordString(value, 'message')
  throw new PlanningApiError(
    status,
    message?.trim() || defaultPlanningApiErrorMessage,
    code,
  )
}

/**
 * Reads one optional string field without trusting a JSON object.
 *
 * @param value - Unknown JSON value.
 * @param key - Field name to read.
 * @returns The string field, or undefined.
 */
function readOptionalRecordString(value: unknown, key: string) {
  if (!isUnknownRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

/** Returns whether an unknown value is a string-keyed record. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Decodes the collaboration watcher envelope returned by the Planning API.
 *
 * @param value - Unknown watcher response candidate.
 * @returns A validated watcher state, or undefined when malformed.
 */
function readPlanningUpdateWatchResponse(
  value: unknown,
): PlanningUpdateWatchState | undefined {
  if (!isUnknownRecord(value) || !isUnknownRecord(value.watch)) return undefined
  const watch = value.watch
  if (typeof watch.subscribed !== 'boolean' ||
    typeof watch.explicit !== 'boolean' ||
    typeof watch.automatic !== 'boolean' ||
    !Array.isArray(watch.reasons) ||
    !watch.reasons.every((reason) => typeof reason === 'string') ||
    typeof watch.watcherCount !== 'number' ||
    !Number.isSafeInteger(watch.watcherCount) ||
    watch.watcherCount < 0) {
    return undefined
  }
  return {
    automatic: watch.automatic,
    explicit: watch.explicit,
    reasons: watch.reasons,
    subscribed: watch.subscribed,
    watcherCount: watch.watcherCount,
  }
}

/** Reads a JSON body without trusting its runtime shape. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return undefined
  }
}

/** Extracts a safe filename from a Content-Disposition response header. */
function readDownloadFilename(contentDisposition: string | null) {
  if (!contentDisposition) return undefined
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }
  return contentDisposition.match(/filename="?([^";]+)"?/i)?.[1]
}

/** Removes trailing slashes from an API base URL. */
function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
