import {
  parseProjectRaidEntryResponse,
  parseProjectRaidLogResponse,
  type DecideProjectRaidChangeRequest,
  type HoldProjectRaidChangeRequest,
  type ProjectRaidEntryInput,
  type ProjectRaidEntryResponse,
  type ProjectRaidLogResponse,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ProjectDirectoryApiError } from './errors'

const projectsApiBaseUrl = resolveApiBaseUrl('projects')

/**
 * Builds the API path of one Project's risk, issue, and change request log.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns The API path below the projects base URL.
 */
function createLogPath(teamId: string, projectId: string) {
  return `/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/raid-log`
}

/**
 * Reads every entry of one Project log.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns The validated log, newest entry first.
 * @throws ProjectDirectoryApiError when the request fails or the response is malformed.
 */
export async function getProjectRaidLog(
  accessToken: string,
  teamId: string,
  projectId: string,
): Promise<ProjectRaidLogResponse> {
  const response = await fetch(`${projectsApiBaseUrl}${createLogPath(teamId, projectId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const parsed = parseProjectRaidLogResponse(await readResponse(response))
  if (!parsed || parsed.teamId !== teamId || parsed.projectId !== projectId) {
    throw new ProjectDirectoryApiError(502, 'projects.raidLog.error.loading')
  }
  return parsed
}

/**
 * Adds one entry to a Project log.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param entry - New entry.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The stored entry.
 */
export async function createProjectRaidEntry(
  accessToken: string,
  teamId: string,
  projectId: string,
  entry: ProjectRaidEntryInput,
  mutationContext: MutationRequestContext,
): Promise<ProjectRaidEntryResponse> {
  return await sendEntryMutation(`${createLogPath(teamId, projectId)}/entries`, accessToken, 'POST', { entry }, mutationContext)
}

/**
 * Replaces the editable fields of one entry.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param entryId - Entry identifier.
 * @param expectedRevision - Entry revision that was read.
 * @param entry - Next editable fields.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The stored entry.
 */
export async function updateProjectRaidEntry(
  accessToken: string,
  teamId: string,
  projectId: string,
  entryId: string,
  expectedRevision: number,
  entry: ProjectRaidEntryInput,
  mutationContext: MutationRequestContext,
): Promise<ProjectRaidEntryResponse> {
  return await sendEntryMutation(
    `${createLogPath(teamId, projectId)}/entries/${encodeURIComponent(entryId)}`,
    accessToken,
    'PUT',
    { expectedRevision, entry },
    mutationContext,
  )
}

/**
 * Holds an open change request for the caller's approval, so nobody else rejects or edits it
 * while its date changes are applied. The caller may renew their own hold.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param entryId - Change request identifier.
 * @param request - Revision that was read.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The held entry, with its next revision.
 */
export async function holdProjectRaidChangeRequest(
  accessToken: string,
  teamId: string,
  projectId: string,
  entryId: string,
  request: HoldProjectRaidChangeRequest,
  mutationContext: MutationRequestContext,
): Promise<ProjectRaidEntryResponse> {
  return await sendEntryMutation(
    `${createLogPath(teamId, projectId)}/entries/${encodeURIComponent(entryId)}/approval-hold`,
    accessToken,
    'POST',
    request,
    mutationContext,
  )
}

/**
 * Approves or rejects an open change request, which closes it.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param entryId - Change request identifier.
 * @param request - Revision that was read, outcome, and the baseline captured for an approval.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The closed entry.
 */
export async function decideProjectRaidChangeRequest(
  accessToken: string,
  teamId: string,
  projectId: string,
  entryId: string,
  request: DecideProjectRaidChangeRequest,
  mutationContext: MutationRequestContext,
): Promise<ProjectRaidEntryResponse> {
  return await sendEntryMutation(
    `${createLogPath(teamId, projectId)}/entries/${encodeURIComponent(entryId)}/decision`,
    accessToken,
    'POST',
    request,
    mutationContext,
  )
}

/**
 * Sends one entry mutation with idempotency headers and validates the response.
 *
 * @param path - API path below the projects base URL.
 * @param accessToken - Bearer token of the current session.
 * @param method - HTTP method.
 * @param body - JSON request body.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The stored entry.
 */
async function sendEntryMutation(
  path: string,
  accessToken: string,
  method: 'POST' | 'PUT',
  body: unknown,
  mutationContext: MutationRequestContext,
): Promise<ProjectRaidEntryResponse> {
  const response = await fetch(`${projectsApiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    body: JSON.stringify(body),
  })
  const parsed = parseProjectRaidEntryResponse(await readResponse(response))
  if (!parsed) throw new ProjectDirectoryApiError(502, 'projects.raidLog.error.save')
  return parsed
}

/**
 * Reads a response body, throwing the API error of a failed response.
 *
 * @param response - Fetch response.
 * @returns The parsed body of a successful response, or `undefined` when it is not JSON.
 * @throws ProjectDirectoryApiError when the response failed.
 */
async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    throw new ProjectDirectoryApiError(
      response.status,
      readStringField(data, 'message') ?? 'projects.raidLog.error.save',
      readStringField(data, 'code'),
    )
  }
  return data
}

/**
 * Reads one optional string field from an untrusted object.
 *
 * @param value - Untrusted value.
 * @param key - Field name.
 * @returns The string value, if present.
 */
function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'string' ? field : undefined
}
