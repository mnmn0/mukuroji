import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type { WorkspaceMemberStatus } from '../../workspace/api'
import { ProjectDirectoryApiError } from './errors'

/**
 * プロジェクトごとの権限ロールです。
 */
export type ProjectMemberRole = 'manager' | 'member' | 'viewer'

/**
 * API レスポンスとして許容する project member role の一覧です。
 */
const projectMemberRoles = ['manager', 'member', 'viewer'] as const

/**
 * Project assignment candidate の Workspace 利用状態です。
 */
type ProjectAssignmentCandidateStatus = {
  /**
   * Cognito user が有効かどうかです。
   */
  enabled?: boolean
  /**
   * Workspace membership の利用状態です。
   */
  workspaceStatus?: WorkspaceMemberStatus
}

/**
 * プロジェクト権限管理に表示する member 行です。
 */
export type ProjectMember = {
  /**
   * 正規化済み member key です。
   */
  id: string
  /**
   * Cognito user のメールアドレスです。
   */
  email: string
  /**
   * Cognito user pool 内の username です。
   */
  username?: string
  /**
   * 画面に表示するメンバー名です。
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
  /**
   * プロジェクト内の権限ロールです。
   */
  role: ProjectMemberRole
  /**
   * 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
}

/**
 * プロジェクト member role 更新 API に送信する入力です。
 */
export type UpdateProjectMemberInput = {
  /**
   * 付与するプロジェクトロールです。
   */
  role: ProjectMemberRole
}

/**
 * プロジェクトメンバー一覧 API が返す response body です。
 */
type ProjectMembersResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * DynamoDB に保存された project member 一覧です。
   */
  members: ProjectMember[]
}

/**
 * プロジェクト member role 更新 API が返す response body です。
 */
type UpdateProjectMemberResponse = {
  /**
   * 更新された project member 行です。
   */
  member: ProjectMember
}

/**
 * プロジェクト member role 削除 API が返す response body です。
 */
type RemoveProjectMemberResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * 削除された member key です。
   */
  memberId: string
}

/**
 * Project 追加・Issue 担当者候補として active な Workspace member かどうかを判定します。
 */
export function isActiveProjectAssignmentCandidate(candidate: ProjectAssignmentCandidateStatus) {
  return candidate.enabled !== false && candidate.workspaceStatus === 'active'
}

const projectsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_PROJECTS_API_BASE_URL ??
    import.meta.env.VITE_TASKS_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Loads the active members and project roles for one Project.
 *
 * When the optional third argument is a Team ID, it is sent as a query parameter; when it is
 * an AbortSignal, it is used as the request signal. A fourth signal is used only with the Team
 * ID form, so the two overload forms retain the same cancellation behavior.
 *
 * @param accessToken - Bearer token for the Project directory API.
 * @param projectId - Project identifier to load.
 * @param teamIdOrSignal - Optional qualified Team ID or request cancellation signal.
 * @param signal - Optional cancellation signal when the third argument is a Team ID.
 * @returns Project members with their current roles.
 */
export async function getProjectMembers(
  accessToken: string,
  projectId: string,
  teamIdOrSignal?: string | AbortSignal,
  signal?: AbortSignal,
) {
  const teamId = typeof teamIdOrSignal === 'string' ? teamIdOrSignal : undefined
  const requestSignal = typeof teamIdOrSignal === 'string' ? signal : teamIdOrSignal ?? signal
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
  const response = await fetch(
    `${projectsApiBaseUrl}/projects/${encodeURIComponent(projectId)}/members${query}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: requestSignal,
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

  if (!isProjectMembersResponse(data)) {
    throw new ProjectDirectoryApiError(response.status, 'projects.error.loading')
  }

  return data.members
}

/**
 * DynamoDB に保存されたプロジェクトメンバー role を作成または更新します。
 */
export async function updateProjectMember(
  accessToken: string,
  projectId: string,
  memberKey: string,
  input: UpdateProjectMemberInput,
  mutationContext: MutationRequestContext,
) {
  const data = await sendProjectDirectoryRequest<unknown>(
    `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberKey)}`,
    accessToken,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
    mutationContext,
  )

  if (!isUpdateProjectMemberResponse(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }

  return data.member
}

/**
 * DynamoDB に保存されたプロジェクトメンバー role を削除します。
 */
export async function removeProjectMember(
  accessToken: string,
  projectId: string,
  memberKey: string,
  mutationContext: MutationRequestContext,
) {
  const data = await sendProjectDirectoryRequest<unknown>(
    `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberKey)}`,
    accessToken,
    {
      method: 'DELETE',
    },
    mutationContext,
  )

  if (!isRemoveProjectMemberResponse(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }

  return data
}

async function sendProjectDirectoryRequest<T>(
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
      ...init?.headers,
      ...createMutationHeaders(mutationContext),
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    throw new ProjectDirectoryApiError(
      response.status,
      readErrorMessage(data),
      readErrorCode(data),
    )
  }

  return data as T
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
 * API レスポンスがプロジェクトメンバー一覧として扱えるかどうかを判定します。
 */
function isProjectMembersResponse(value: unknown): value is ProjectMembersResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'members' in value &&
    Array.isArray(value.members) &&
    value.members.every(isProjectMember)
  )
}

/**
 * API から返った値がプロジェクトメンバー行として扱えるかどうかを判定します。
 */
function isProjectMember(value: unknown): value is ProjectMember {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'email' in value &&
    typeof value.email === 'string' &&
    (!('username' in value) || typeof value.username === 'string') &&
    (!('name' in value) || typeof value.name === 'string') &&
    (!('enabled' in value) || typeof value.enabled === 'boolean') &&
    (!('status' in value) || typeof value.status === 'string') &&
    (!('workspaceStatus' in value) || isWorkspaceMemberStatus(value.workspaceStatus)) &&
    'role' in value &&
    isProjectMemberRole(value.role) &&
    'updatedAt' in value &&
    typeof value.updatedAt === 'string'
  )
}

/**
 * API レスポンスが project member 更新結果として扱えるかどうかを判定します。
 */
function isUpdateProjectMemberResponse(value: unknown): value is UpdateProjectMemberResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'member' in value &&
    isProjectMember(value.member)
  )
}

/**
 * API レスポンスが project member 削除結果として扱えるかどうかを判定します。
 */
function isRemoveProjectMemberResponse(value: unknown): value is RemoveProjectMemberResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'memberId' in value &&
    typeof value.memberId === 'string'
  )
}

/**
 * API 値が既知の project member role かどうかを判定します。
 */
function isProjectMemberRole(value: unknown): value is ProjectMemberRole {
  return projectMemberRoles.includes(value as ProjectMemberRole)
}

/**
 * API 値が既知の Workspace member status かどうかを判定します。
 */
function isWorkspaceMemberStatus(value: unknown): value is WorkspaceMemberStatus {
  return value === 'active' || value === 'deactivated'
}
