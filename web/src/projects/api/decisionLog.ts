import {
  parseProjectDecisionEntryResponse,
  parseProjectDecisionLogResponse,
  parseTeamDecisionLogResponse,
  type ProjectDecisionEntryInput,
  type ProjectDecisionEntryResponse,
  type ProjectDecisionLogResponse,
  type TeamDecisionLogResponse,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ProjectDirectoryApiError } from './errors'

const projectsApiBaseUrl = resolveApiBaseUrl('projects')

/**
 * Builds the API path of one Project's decision log.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns The API path below the projects base URL.
 */
function createLogPath(teamId: string, projectId: string) {
  return `/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/decision-log`
}

/**
 * Reads every decision of one Project.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns The validated log, newest decision first.
 * @throws ProjectDirectoryApiError when the request fails or the response is malformed.
 */
export async function getProjectDecisionLog(
  accessToken: string,
  teamId: string,
  projectId: string,
): Promise<ProjectDecisionLogResponse> {
  const response = await fetch(`${projectsApiBaseUrl}${createLogPath(teamId, projectId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const parsed = parseProjectDecisionLogResponse(await readResponse(response, 'projects.decisionLog.error.loading'))
  if (!parsed || parsed.teamId !== teamId || parsed.projectId !== projectId) {
    throw new ProjectDirectoryApiError(502, 'projects.decisionLog.error.loading')
  }
  return parsed
}

/** Filters of the Team decision log. */
export type TeamDecisionLogQuery = {
  /** Keyword matched against titles and free text. */
  keyword?: string
  /** Project to narrow to. */
  projectId?: string
}

/**
 * Reads the decisions and decided change requests of every Project of a Team the caller may see.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team identifier.
 * @param query - Keyword and Project filters.
 * @returns The validated log, newest decision first.
 * @throws ProjectDirectoryApiError when the request fails or the response is malformed.
 */
export async function getTeamDecisionLog(
  accessToken: string,
  teamId: string,
  query: TeamDecisionLogQuery,
): Promise<TeamDecisionLogResponse> {
  const search = new URLSearchParams()
  if (query.keyword) search.set('q', query.keyword)
  if (query.projectId) search.set('projectId', query.projectId)
  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  const response = await fetch(`${projectsApiBaseUrl}/teams/${encodeURIComponent(teamId)}/decision-log${suffix}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const parsed = parseTeamDecisionLogResponse(await readResponse(response, 'projects.decisionLog.error.loading'))
  if (!parsed || parsed.teamId !== teamId) throw new ProjectDirectoryApiError(502, 'projects.decisionLog.error.loading')
  return parsed
}

/**
 * Records one decision in a Project log.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param entry - New decision.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The stored decision.
 */
export async function createProjectDecision(
  accessToken: string,
  teamId: string,
  projectId: string,
  entry: ProjectDecisionEntryInput,
  mutationContext: MutationRequestContext,
): Promise<ProjectDecisionEntryResponse> {
  return await sendEntryMutation(`${createLogPath(teamId, projectId)}/entries`, accessToken, 'POST', { entry }, mutationContext)
}

/**
 * Replaces the editable fields of one decision.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param entryId - Decision identifier.
 * @param expectedRevision - Revision that was read.
 * @param entry - Next editable fields.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The stored decision.
 */
export async function updateProjectDecision(
  accessToken: string,
  teamId: string,
  projectId: string,
  entryId: string,
  expectedRevision: number,
  entry: ProjectDecisionEntryInput,
  mutationContext: MutationRequestContext,
): Promise<ProjectDecisionEntryResponse> {
  return await sendEntryMutation(
    `${createLogPath(teamId, projectId)}/entries/${encodeURIComponent(entryId)}`,
    accessToken,
    'PUT',
    { expectedRevision, entry },
    mutationContext,
  )
}

/**
 * Sends one decision mutation with idempotency headers and validates the response.
 *
 * @param path - API path below the projects base URL.
 * @param accessToken - Bearer token of the current session.
 * @param method - HTTP method.
 * @param body - JSON request body.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The stored decision.
 */
async function sendEntryMutation(
  path: string,
  accessToken: string,
  method: 'POST' | 'PUT',
  body: unknown,
  mutationContext: MutationRequestContext,
): Promise<ProjectDecisionEntryResponse> {
  const response = await fetch(`${projectsApiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    body: JSON.stringify(body),
  })
  const parsed = parseProjectDecisionEntryResponse(await readResponse(response, 'projects.decisionLog.error.save'))
  if (!parsed) throw new ProjectDirectoryApiError(502, 'projects.decisionLog.error.save')
  return parsed
}

/**
 * Reads a response body, throwing the API error of a failed response.
 *
 * @param response - Fetch response.
 * @param fallbackMessage - Message key used when the server sends no message.
 * @returns The parsed body of a successful response, or `undefined` when it is not JSON.
 * @throws ProjectDirectoryApiError when the response failed.
 */
async function readResponse(response: Response, fallbackMessage: string): Promise<unknown> {
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
      readStringField(data, 'message') ?? fallbackMessage,
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
