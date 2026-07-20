import type { WorkspaceMemberStatus, WorkspaceRole } from '../../workspace/api'
import { ApiError } from './errors'

/**
 * Cognito で認証された現在のユーザー情報を表します。
 */
export type CurrentUser = {
  /**
   * Cognito のユーザー名です。
   */
  username: string
  /**
   * Cognito から返されたユーザー属性です。
   */
  attributes: Record<string, string>
  /**
   * Cognito access token に含まれるグループ名です。
   */
  groups: string[]
  /**
   * システム管理者として扱われるかどうかです。
   */
  isSystemAdmin: boolean
  /**
   * Workspace 全体で現在のユーザーに付与された role です。
   */
  workspaceRole: WorkspaceRole
  /**
   * Workspace membership の利用状態です。
   */
  workspaceMemberStatus: WorkspaceMemberStatus
}

/**
 * 現在の Workspace role がチームとプロジェクトの構成を管理できるか判定します。
 */
export function canManageWorkspaceStructure(user?: CurrentUser | null) {
  return user?.workspaceRole === 'owner' || user?.workspaceRole === 'admin'
}

/**
 * Active な Workspace membership と role が Issue、タスク、コメント、
 * project member を更新できるか判定します。
 */
export function canMutateWorkspaceContent(user?: CurrentUser | null) {
  return (
    user?.workspaceMemberStatus === 'active' &&
    user.workspaceRole !== 'guest'
  )
}

const apiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')

/**
 * アクセストークンを使って認証済みユーザー情報を取得します。
 */
export function getCurrentUser(accessToken: string) {
  return apiFetch<CurrentUser>('/auth/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

async function apiFetch<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  const data = await readJson<{ code?: string; message?: string } | T>(response)

  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof data.message === 'string'
        ? data.message
        : 'API request failed.'

    const code =
      typeof data === 'object' &&
      data !== null &&
      'code' in data &&
      typeof data.code === 'string'
        ? data.code
        : undefined

    throw new ApiError(response.status, message, code)
  }

  return data as T
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
