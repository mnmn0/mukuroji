import type { WorkspaceMemberStatus } from '../../workspace/api'
import { ProjectDirectoryApiError } from './errors'

/**
 * Cognito を master とする user profile です。
 */
export type ProjectUser = {
  /**
   * アプリ内で user 参照に使う正規化済み ID です。
   */
  id: string
  /**
   * Cognito user pool 内の username です。
   */
  username: string
  /**
   * Cognito user のメールアドレスです。
   */
  email: string
  /**
   * Cognito user の表示名です。
   */
  name?: string
  /**
   * Cognito user が有効かどうかです。
   */
  enabled?: boolean
  /**
   * Cognito user status です。
   */
  status?: string
  /**
   * Workspace membership の利用状態です。省略された legacy response は割り当て候補に含めません。
   */
  workspaceStatus?: WorkspaceMemberStatus
}

/**
 * Cognito user 一覧 API に渡す検索条件です。
 */
export type GetProjectUsersInput = {
  /**
   * email prefix 検索に使う query です。
   */
  query?: string
  /**
   * 1 page で取得する最大件数です。
   */
  limit?: number
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  nextToken?: string
}

/**
 * Cognito user 一覧 API が返す response body です。
 */
type ProjectUsersResponse = {
  /**
   * Cognito user pool から取得した user 一覧です。
   */
  users: ProjectUser[]
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  nextToken?: string
}

const projectsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_PROJECTS_API_BASE_URL ??
    import.meta.env.VITE_TASKS_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Cognito user pool から project member 候補を取得します。
 */
export async function getProjectUsers(
  accessToken: string,
  projectId: string,
  input: GetProjectUsersInput = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()

  if (input.query?.trim()) {
    query.set('query', input.query.trim())
  }

  if (input.limit !== undefined) {
    query.set('limit', String(input.limit))
  }

  if (input.nextToken) {
    query.set('nextToken', input.nextToken)
  }

  const queryString = query.toString()
  const response = await fetch(
    `${projectsApiBaseUrl}/projects/${encodeURIComponent(projectId)}/users${queryString ? `?${queryString}` : ''}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    },
  )
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    throw new ProjectDirectoryApiError(
      response.status,
      readErrorMessage(data),
      readErrorCode(data),
    )
  }

  if (!isProjectUsersResponse(data)) {
    throw new ProjectDirectoryApiError(response.status, 'projects.error.loading')
  }

  return data
}

function readErrorMessage(data: unknown) {
  return typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string'
    ? data.message
    : 'projects.error.loading'
}

function readErrorCode(data: unknown) {
  return typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    typeof data.code === 'string'
    ? data.code
    : undefined
}

/**
 * fetch response body を JSON として読み込みます。
 */
async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  return JSON.parse(text) as T
}

/**
 * URL 文字列末尾の slash を取り除きます。
 */
function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

/**
 * API レスポンスが Cognito user 一覧として扱えるかどうかを判定します。
 */
function isProjectUsersResponse(value: unknown): value is ProjectUsersResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'users' in value &&
    Array.isArray(value.users) &&
    value.users.every(isProjectUser) &&
    (!('nextToken' in value) || typeof value.nextToken === 'string')
  )
}

/**
 * API から返った値が Cognito user profile として扱えるかどうかを判定します。
 */
function isProjectUser(value: unknown): value is ProjectUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'username' in value &&
    typeof value.username === 'string' &&
    'email' in value &&
    typeof value.email === 'string' &&
    (!('name' in value) || typeof value.name === 'string') &&
    (!('enabled' in value) || typeof value.enabled === 'boolean') &&
    (!('status' in value) || typeof value.status === 'string') &&
    (!('workspaceStatus' in value) || isWorkspaceMemberStatus(value.workspaceStatus))
  )
}

/**
 * API 値が既知の Workspace member status かどうかを判定します。
 */
function isWorkspaceMemberStatus(value: unknown): value is WorkspaceMemberStatus {
  return value === 'active' || value === 'deactivated'
}
