import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { FilesApiError } from './errors'

const filesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * Work Item から file を soft delete します。
 */
export function deleteWorkItemFile(
  teamId: string,
  issueId: string,
  fileId: string,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<Record<string, never>>(
    `${createWorkItemFilesPath(teamId, issueId)}/${encodeURIComponent(fileId)}`,
    accessToken,
    {
      headers: createMutationHeaders(context),
      method: 'DELETE',
    },
  )
}

/**
 * Team scope の Project から file を soft delete します。
 */
export function deleteProjectFile(
  teamId: string,
  projectId: string,
  fileId: string,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<Record<string, never>>(
    `${createProjectFilesPath(teamId, projectId)}/${encodeURIComponent(fileId)}`,
    accessToken,
    {
      headers: createMutationHeaders(context),
      method: 'DELETE',
    },
  )
}

function createWorkItemPath(teamId: string, issueId: string) {
  return `${filesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`
}

function createWorkItemFilesPath(teamId: string, issueId: string) {
  return `${createWorkItemPath(teamId, issueId)}/files`
}

function createProjectFilesPath(teamId: string, projectId: string) {
  return `${filesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/files`
}

async function requestJson<TResponse>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const message = typeof data === 'object' && data !== null &&
      'message' in data && typeof data.message === 'string'
      ? data.message
      : 'files.error.request'
    const code = typeof data === 'object' && data !== null &&
      'code' in data && typeof data.code === 'string'
      ? data.code
      : undefined

    throw new FilesApiError(response.status, message, code)
  }

  return data as TResponse
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
