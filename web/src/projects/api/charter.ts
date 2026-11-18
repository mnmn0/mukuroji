import {
  isProjectLifecycleState,
  type ProjectCharter,
  type ProjectCharterState,
  type ProjectLifecycleState,
  type UpdateProjectCharterInput,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ProjectDirectoryApiError } from './errors'

const projectsApiBaseUrl = resolveApiBaseUrl('projects')

/**
 * Builds the API path of one Team-owned Project's charter resource.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param resource - Charter sub-resource.
 * @returns The API path below the projects base URL.
 */
function createCharterPath(teamId: string, projectId: string, resource: 'charter' | 'lifecycle') {
  return `/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/${resource}`
}

/**
 * Reads the charter and lifecycle state of one Team-owned Project.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param signal - Optional abort signal.
 * @returns The validated charter state.
 */
export async function getProjectCharter(
  accessToken: string,
  teamId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectCharterState> {
  const response = await fetch(`${projectsApiBaseUrl}${createCharterPath(teamId, projectId, 'charter')}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  })
  return readCharterStateResponse(response)
}

/**
 * Replaces the charter of one Team-owned Project.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param input - Complete charter replacement with the revision that was read.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The committed charter state.
 */
export async function updateProjectCharter(
  accessToken: string,
  teamId: string,
  projectId: string,
  input: UpdateProjectCharterInput,
  mutationContext: MutationRequestContext,
): Promise<ProjectCharterState> {
  return await sendCharterMutation(createCharterPath(teamId, projectId, 'charter'), accessToken, {
    method: 'PUT',
    body: JSON.stringify(input),
  }, mutationContext)
}

/**
 * Moves one Team-owned Project to another lifecycle state.
 *
 * @param accessToken - Bearer token of the current session.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param expectedRevision - Charter revision that was read.
 * @param state - Requested lifecycle state.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The committed charter state.
 */
export async function transitionProjectLifecycle(
  accessToken: string,
  teamId: string,
  projectId: string,
  expectedRevision: number,
  state: ProjectLifecycleState,
  mutationContext: MutationRequestContext,
): Promise<ProjectCharterState> {
  return await sendCharterMutation(createCharterPath(teamId, projectId, 'lifecycle'), accessToken, {
    method: 'POST',
    body: JSON.stringify({ expectedRevision, state }),
  }, mutationContext)
}

/**
 * Sends one charter mutation with idempotency headers.
 *
 * @param path - API path below the projects base URL.
 * @param accessToken - Bearer token of the current session.
 * @param init - Method and body.
 * @param mutationContext - Idempotency and correlation identifiers.
 * @returns The committed charter state.
 */
async function sendCharterMutation(
  path: string,
  accessToken: string,
  init: RequestInit,
  mutationContext: MutationRequestContext,
) {
  const response = await fetch(`${projectsApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
  })
  return readCharterStateResponse(response)
}

/**
 * Reads and validates a charter state response or throws its API error.
 *
 * @param response - Fetch response.
 * @returns The validated charter state.
 */
async function readCharterStateResponse(response: Response): Promise<ProjectCharterState> {
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
      readStringField(data, 'message') ?? 'projects.error.loading',
      readStringField(data, 'code'),
    )
  }
  if (!isProjectCharterState(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
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

/**
 * Checks whether an API value is a charter state.
 *
 * @param value - Untrusted response body.
 * @returns Whether the value can be used as a charter state.
 */
function isProjectCharterState(value: unknown): value is ProjectCharterState {
  if (typeof value !== 'object' || value === null) return false
  const revision: unknown = Reflect.get(value, 'revision')
  return typeof Reflect.get(value, 'teamId') === 'string' &&
    typeof Reflect.get(value, 'projectId') === 'string' &&
    isProjectLifecycleState(Reflect.get(value, 'lifecycleState')) &&
    typeof revision === 'number' &&
    Number.isSafeInteger(revision) &&
    isProjectCharter(Reflect.get(value, 'charter')) &&
    isOptionalViewerCapabilities(Reflect.get(value, 'viewer'))
}

/**
 * Checks the optional server-decided charter capabilities of the viewer.
 *
 * @param value - Untrusted `viewer` value.
 * @returns Whether the value is absent or a complete capability set.
 */
function isOptionalViewerCapabilities(value: unknown): boolean {
  return value === undefined || (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'canEdit') === 'boolean' &&
    typeof Reflect.get(value, 'canDecideProposal') === 'boolean'
  )
}

/**
 * Checks whether an API value is a Project charter.
 *
 * @param value - Untrusted charter value.
 * @returns Whether the value can be used as a charter.
 */
function isProjectCharter(value: unknown): value is ProjectCharter {
  if (typeof value !== 'object' || value === null) return false
  const isOptionalText = (key: string) => {
    const field: unknown = Reflect.get(value, key)
    return field === undefined || typeof field === 'string'
  }
  const isOptionalPerson = (key: string) => {
    const field: unknown = Reflect.get(value, key)
    return field === undefined || (
      typeof field === 'object' &&
      field !== null &&
      typeof Reflect.get(field, 'userId') === 'string' &&
      typeof Reflect.get(field, 'displayName') === 'string'
    )
  }
  const isTextList = (key: string) => {
    const field: unknown = Reflect.get(value, key)
    return Array.isArray(field) && field.every((item) => typeof item === 'string')
  }
  return ['code', 'description', 'purpose', 'plannedStartDate', 'plannedEndDate'].every(isOptionalText) &&
    isOptionalPerson('owner') &&
    isOptionalPerson('sponsor') &&
    isTextList('tags') &&
    isTextList('repositoryUrls')
}
