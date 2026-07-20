import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type { WorkspaceMember, WorkspaceMemberStatus, WorkspaceRole } from './access'
import { WorkspaceAccessApiError } from './errors'

/**
 * Workspace member 更新 API の入力です。
 */
export type UpdateWorkspaceMemberInput = {
  /**
   * 更新後の Workspace role です。
   */
  role?: WorkspaceRole
  /**
   * 更新後の member status です。
   */
  status?: WorkspaceMemberStatus
  /**
   * 更新対象を読み込んだ時点の version です。
   */
  expectedVersion: number
}

/**
 * Workspace access API が member mutation 後に返す response body です。
 */
type WorkspaceMemberResponse = {
  /**
   * 更新された member です。
   */
  member: WorkspaceMember
}

const workspaceApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_PROJECTS_API_BASE_URL ??
    import.meta.env.VITE_TASKS_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Workspace member の role または利用状態を version 付きで更新します。
 */
export async function updateWorkspaceMember(
  accessToken: string,
  memberKey: string,
  input: UpdateWorkspaceMemberInput,
  mutationContext: MutationRequestContext,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceMemberResponse>(
    `/workspace/members/${encodeURIComponent(memberKey)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PATCH',
    },
  )

  return response.member
}

async function sendWorkspaceAccessRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${workspaceApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    throw new WorkspaceAccessApiError(
      response.status,
      readErrorMessage(data),
      readErrorCode(data),
    )
  }

  return data as T
}

function readErrorCode(data: unknown) {
  return typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    typeof data.code === 'string'
    ? data.code
    : undefined
}

function readErrorMessage(data: unknown) {
  return typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string'
    ? data.message
    : 'workspace.access.error.operation'
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  return JSON.parse(text) as T
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
