import {
  isAddDirectoryTeamMemberResponse,
  isDirectoryAdministrationResponse,
  isDirectoryArchiveImpactResponse,
  isUpdateDirectoryTeamProfileResponse,
  type AddDirectoryTeamMemberInput,
  type AddDirectoryTeamMemberResponse,
  type UpdateDirectoryTeamProfileInput,
  type UpdateDirectoryTeamProfileResponse,
  type DirectoryAdministrationTeam,
  type DirectoryArchiveImpactResponse,
  type DirectoryArchiveImpactTarget,
  type RenameDirectoryProjectInput,
  type RenameDirectoryTeamInput,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { ProjectDirectoryApiError } from './errors'

const projectsApiBaseUrl = resolveApiBaseUrl('projects')

/**
 * Reads every Team and Project, archived ones included, for Workspace administrators.
 *
 * @param accessToken - Bearer token of the administrator.
 * @param signal - Optional abort signal.
 * @returns Teams in display order with their Projects.
 */
export async function getDirectoryAdministration(
  accessToken: string,
  signal?: AbortSignal,
): Promise<DirectoryAdministrationTeam[]> {
  const data = await sendDirectoryAdministrationRequest('/teams/directory', accessToken, {
    signal,
  })

  if (!isDirectoryAdministrationResponse(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }

  return data.teams
}

/**
 * Reads what archiving a Team or Project affects, for the archive confirmation.
 *
 * @param accessToken - Bearer token of the administrator.
 * @param target - Team or Project about to be archived.
 * @param signal - Optional abort signal.
 * @returns Open Work Items, active Agent Runs, Planning references, and Webhook counts.
 */
export async function getDirectoryArchiveImpact(
  accessToken: string,
  target: DirectoryArchiveImpactTarget,
  signal?: AbortSignal,
): Promise<DirectoryArchiveImpactResponse> {
  const teamPath = `/teams/${encodeURIComponent(target.teamId)}`
  const path = target.kind === 'team'
    ? `${teamPath}/archive-impact`
    : `${teamPath}/projects/${encodeURIComponent(target.projectId)}/archive-impact`
  const data = await sendDirectoryAdministrationRequest(path, accessToken, { signal })

  if (!isDirectoryArchiveImpactResponse(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }

  return data
}

/**
 * Renames a Team. Its ID and URLs stay the same.
 *
 * @param accessToken - Bearer token of the administrator.
 * @param teamId - Team to rename.
 * @param input - New Japanese and English names.
 * @param mutationContext - Idempotency context of the mutation.
 */
export async function renameDirectoryTeam(
  accessToken: string,
  teamId: string,
  input: RenameDirectoryTeamInput,
  mutationContext: MutationRequestContext,
) {
  await sendDirectoryAdministrationRequest(
    `/teams/${encodeURIComponent(teamId)}`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify(input) },
    mutationContext,
  )
}

/**
 * Replaces the description and leader of a Team.
 *
 * @param accessToken - Bearer token of the administrator.
 * @param teamId - Team to update.
 * @param input - New description and leader.
 * @param mutationContext - Idempotency context of the mutation.
 * @returns The stored profile and its revision.
 */
export async function updateDirectoryTeamProfile(
  accessToken: string,
  teamId: string,
  input: UpdateDirectoryTeamProfileInput,
  mutationContext: MutationRequestContext,
): Promise<UpdateDirectoryTeamProfileResponse> {
  const data = await sendDirectoryAdministrationRequest(
    `/teams/${encodeURIComponent(teamId)}/profile`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify(input) },
    mutationContext,
  )

  if (!isUpdateDirectoryTeamProfileResponse(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }

  return data
}

/**
 * Adds a Workspace member to every active Project of a Team, keeping existing roles.
 *
 * @param accessToken - Bearer token of the administrator.
 * @param teamId - Team whose Projects the member joins.
 * @param input - Member and the Project role to grant.
 * @param mutationContext - Idempotency context of the mutation.
 * @returns The Projects the member was added to and the ones they already belonged to.
 */
export async function addDirectoryTeamMember(
  accessToken: string,
  teamId: string,
  input: AddDirectoryTeamMemberInput,
  mutationContext: MutationRequestContext,
): Promise<AddDirectoryTeamMemberResponse> {
  const data = await sendDirectoryAdministrationRequest(
    `/teams/${encodeURIComponent(teamId)}/members`,
    accessToken,
    { method: 'POST', body: JSON.stringify(input) },
    mutationContext,
  )

  if (!isAddDirectoryTeamMemberResponse(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }

  return data
}

/**
 * Renames a Project or changes its color. Its ID and URLs stay the same.
 *
 * @param accessToken - Bearer token of the administrator.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project to rename.
 * @param input - New names and optional color.
 * @param mutationContext - Idempotency context of the mutation.
 */
export async function renameDirectoryProject(
  accessToken: string,
  teamId: string,
  projectId: string,
  input: RenameDirectoryProjectInput,
  mutationContext: MutationRequestContext,
) {
  await sendDirectoryAdministrationRequest(
    `/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify(input) },
    mutationContext,
  )
}

/**
 * Restores an archived Team.
 *
 * @param accessToken - Bearer token of the administrator.
 * @param teamId - Archived Team.
 * @param mutationContext - Idempotency context of the mutation.
 */
export async function restoreDirectoryTeam(
  accessToken: string,
  teamId: string,
  mutationContext: MutationRequestContext,
) {
  await sendDirectoryAdministrationRequest(
    `/teams/${encodeURIComponent(teamId)}/restore`,
    accessToken,
    { method: 'PATCH' },
    mutationContext,
  )
}

/**
 * Restores an archived Project of an active Team.
 *
 * @param accessToken - Bearer token of the administrator.
 * @param teamId - Active Team that owns the Project.
 * @param projectId - Archived Project.
 * @param mutationContext - Idempotency context of the mutation.
 */
export async function restoreDirectoryProject(
  accessToken: string,
  teamId: string,
  projectId: string,
  mutationContext: MutationRequestContext,
) {
  await sendDirectoryAdministrationRequest(
    `/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/restore`,
    accessToken,
    { method: 'PATCH' },
    mutationContext,
  )
}

/**
 * Stores a new display order of every active Team.
 *
 * @param accessToken - Bearer token of the administrator.
 * @param teamIds - Every active Team ID in the new order.
 * @param mutationContext - Idempotency context of the mutation.
 */
export async function reorderDirectoryTeams(
  accessToken: string,
  teamIds: readonly string[],
  mutationContext: MutationRequestContext,
) {
  await sendDirectoryAdministrationRequest(
    '/teams/order',
    accessToken,
    { method: 'PUT', body: JSON.stringify({ teamIds }) },
    mutationContext,
  )
}

/**
 * Stores a new display order of every active Project of one Team.
 *
 * @param accessToken - Bearer token of the administrator.
 * @param teamId - Team whose Projects are reordered.
 * @param projectIds - Every active Project ID of the Team in the new order.
 * @param mutationContext - Idempotency context of the mutation.
 */
export async function reorderDirectoryProjects(
  accessToken: string,
  teamId: string,
  projectIds: readonly string[],
  mutationContext: MutationRequestContext,
) {
  await sendDirectoryAdministrationRequest(
    `/teams/${encodeURIComponent(teamId)}/project-order`,
    accessToken,
    { method: 'PUT', body: JSON.stringify({ projectIds }) },
    mutationContext,
  )
}

/**
 * Sends one directory administration request and returns its parsed body.
 *
 * @param path - Path under the Projects API base URL.
 * @param accessToken - Bearer token of the administrator.
 * @param init - Fetch options.
 * @param mutationContext - Idempotency context, for mutations.
 * @returns The parsed JSON body.
 */
async function sendDirectoryAdministrationRequest(
  path: string,
  accessToken: string,
  init: RequestInit,
  mutationContext?: MutationRequestContext,
): Promise<unknown> {
  const response = await fetch(`${projectsApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(mutationContext ? createMutationHeaders(mutationContext) : {}),
    },
  })
  const data = parseResponseBody(await response.text())

  if (!response.ok) {
    throw new ProjectDirectoryApiError(
      response.status,
      readStringField(data, 'message') ?? 'projects.error.loading',
      readStringField(data, 'code'),
    )
  }

  return data
}

/**
 * Parses a response body, treating an empty or malformed body as an empty object.
 *
 * @param text - Raw response text.
 * @returns The parsed body.
 */
function parseResponseBody(text: string): unknown {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * Reads a string field from an untrusted response body.
 *
 * @param data - Parsed response body.
 * @param field - Field name.
 * @returns The field value when it is a string.
 */
function readStringField(data: unknown, field: string) {
  if (typeof data !== 'object' || data === null) return undefined
  const value: unknown = Reflect.get(data, field)
  return typeof value === 'string' ? value : undefined
}
