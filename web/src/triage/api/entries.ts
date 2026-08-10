import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import {
  readTriageBulkActionResult,
  readTriageConfiguration,
  readTriageEntry,
  readTriageEntryPage,
  readTriageMutationReceipt,
} from './contractValidation'
import { TriageApiError } from './errors'
import type {
  TriageBulkActionInput,
  TriageActionInput,
  TriageEntryListInput,
  UpdateTriageConfigurationInput,
} from './types'

const triageApiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')
const defaultTriageApiErrorMessage = 'Unable to complete the Team triage operation.'

/** Options accepted by the cursor-paginated Team triage queue API. */
export type GetTriageEntriesOptions = TriageEntryListInput

/**
 * Loads one permission-filtered page from a Team triage queue.
 *
 * @param teamId - Team whose intake queue should be loaded.
 * @param accessToken - Access token used by the triage API.
 * @param options - Cursor and filter options.
 * @returns A validated triage queue page.
 */
export function getTriageEntries(
  teamId: string,
  accessToken: string,
  options: GetTriageEntriesOptions = {},
) {
  const query = new URLSearchParams()
  if (options.cursor) query.set('cursor', options.cursor)
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.query) query.set('query', options.query)
  if (options.sla) query.set('sla', options.sla)
  if (options.state) query.set('state', options.state)
  if (options.sourceKind) query.set('sourceKind', options.sourceKind)
  if (options.ownerUserId) query.set('owner', options.ownerUserId)

  return requestJson(
    `${triageTeamPath(teamId)}/triage-entries${query.size ? `?${query.toString()}` : ''}`,
    { accessToken },
    readTriageEntryPage,
  )
}

/**
 * Loads one versioned, permission-filtered triage entry.
 *
 * @param teamId - Team whose queue owns the entry.
 * @param entryId - Stable triage entry ID.
 * @param accessToken - Access token used by the triage API.
 * @returns A validated triage entry.
 */
export function getTriageEntry(teamId: string, entryId: string, accessToken: string) {
  return requestJson(
    `${triageTeamPath(teamId)}/triage-entries/${encodeURIComponent(entryId)}`,
    { accessToken },
    readTriageEntry,
  )
}

/**
 * Applies one revision-fenced triage transition.
 *
 * @param teamId - Team whose queue owns the entry.
 * @param entryId - Stable triage entry ID.
 * @param input - Explicit state transition input.
 * @param accessToken - Access token used by the triage API.
 * @param context - Idempotency and correlation context retained across retries.
 * @returns The validated entry after the transition.
 */
export function applyTriageEntryAction(
  teamId: string,
  entryId: string,
  input: TriageActionInput,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson(
    `${triageTeamPath(teamId)}/triage-entries/${encodeURIComponent(entryId)}/actions`,
    {
      accessToken,
      init: createMutationInit(input, context),
    },
    readTriageMutationReceipt,
  )
}

/**
 * Applies one explicit action to multiple revision-fenced entries.
 *
 * @param teamId - Team whose queue owns every selected entry.
 * @param input - Selected entries and bulk transition parameters.
 * @param accessToken - Access token used by the triage API.
 * @param context - Idempotency and correlation context retained across retries.
 * @returns Per-entry bulk transition results.
 */
export function applyTriageBulkAction(
  teamId: string,
  input: TriageBulkActionInput,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson(
    `${triageTeamPath(teamId)}/triage-entries/bulk-actions`,
    {
      accessToken,
      init: createMutationInit(input, context),
    },
    readTriageBulkActionResult,
  )
}

/**
 * Loads versioned routing, rotation, SLA, and escalation settings for a Team.
 *
 * @param teamId - Team whose triage settings should be loaded.
 * @param accessToken - Access token used by the triage API.
 * @returns Validated Team triage settings.
 */
export function getTriageSettings(teamId: string, accessToken: string) {
  return requestJson(
    `${triageTeamPath(teamId)}/triage-settings`,
    { accessToken },
    readTriageConfiguration,
  )
}

/**
 * Updates versioned routing, rotation, SLA, and escalation settings for a Team.
 *
 * @param teamId - Team whose triage settings should be updated.
 * @param input - Revision-fenced settings replacement.
 * @param accessToken - Access token used by the triage API.
 * @param context - Idempotency and correlation context retained across retries.
 * @returns Validated updated Team triage settings.
 */
export function updateTriageSettings(
  teamId: string,
  input: UpdateTriageConfigurationInput,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson(
    `${triageTeamPath(teamId)}/triage-settings`,
    {
      accessToken,
      init: {
        ...createMutationInit(input, context),
        method: 'PUT',
      },
    },
    readTriageConfiguration,
  )
}

/** Request options accepted by the shared triage JSON boundary. */
type TriageRequestOptions = {
  /** Access token included in the Authorization header. */
  readonly accessToken: string
  /** Additional fetch options. */
  readonly init?: RequestInit
}

/** Executes an authenticated request and validates its successful JSON body. */
async function requestJson<Result>(
  path: string,
  options: TriageRequestOptions,
  readResult: (value: unknown) => Result,
) {
  const response = await fetch(`${triageApiBaseUrl}${path}`, {
    ...options.init,
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      ...options.init?.headers,
    },
  })
  const data = await readJson(response)

  if (!response.ok) {
    const error = readApiError(data)
    throw new TriageApiError(response.status, error.message, error.code)
  }

  return readResult(data)
}

/** Builds a JSON mutation request with replay-safe headers. */
function createMutationInit(
  input: TriageActionInput | TriageBulkActionInput | UpdateTriageConfigurationInput,
  context: MutationRequestContext,
): RequestInit {
  return {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(context),
    },
    method: 'POST',
  }
}

/** Reads a response body without trusting its JSON shape. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Extracts safe structured error fields with a stable fallback. */
function readApiError(value: unknown) {
  if (!isRecord(value)) {
    return { message: defaultTriageApiErrorMessage }
  }
  const message = typeof value.message === 'string' && value.message.trim()
    ? value.message
    : defaultTriageApiErrorMessage
  const code = typeof value.code === 'string' && value.code.trim()
    ? value.code
    : undefined
  return { code, message }
}

/** Checks whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Creates the encoded API path for one Team. */
function triageTeamPath(teamId: string) {
  return `/teams/${encodeURIComponent(teamId)}`
}

/** Removes trailing slashes from the configured API origin. */
function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
