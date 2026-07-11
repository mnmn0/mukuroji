import type { SidebarProjectTone } from '../components/sidebar'
import type { Locale } from '../i18n'
import { createMutationHeaders, type MutationRequestContext } from '../api/mutationHeaders'

/**
 * プロジェクトごとの権限ロールです。
 */
export type ProjectMemberRole = 'manager' | 'member' | 'viewer'

/**
 * API レスポンスとして許容する project member role の一覧です。
 */
const projectMemberRoles = ['manager', 'member', 'viewer'] as const

/**
 * サイドバーに表示するプロジェクト行です。
 */
export type ProjectDirectoryProject = {
  /**
   * タスク一覧の projectId として使う一意な ID です。
   */
  id: string
  /**
   * サイドバーと画面タイトルに表示するプロジェクト名です。
   */
  name: string
  /**
   * サイドバー上のプロジェクトアイコン色です。
   */
  tone?: SidebarProjectTone
}

/**
 * チーム作成 API に送信する入力です。
 */
export type CreateProjectDirectoryTeamInput = {
  /**
   * ユーザーが入力したチーム名です。
   */
  name: string
}

/**
 * プロジェクト作成 API に送信する入力です。
 */
export type CreateProjectDirectoryProjectInput = {
  /**
   * ユーザーが入力したプロジェクト名です。
   */
  name: string
  /**
   * サイドバー上のプロジェクト表示色です。
   */
  tone: SidebarProjectTone
}

/**
 * サイドバーに表示するチーム行です。
 */
export type ProjectDirectoryTeam = {
  /**
   * チームを識別する一意な ID です。
   */
  id: string
  /**
   * サイドバーに表示するチーム名です。
   */
  name: string
  /**
   * 初期表示時にチーム配下を展開するかどうかです。
   */
  expanded?: boolean
  /**
   * チームに紐づくプロジェクト一覧です。同一 projectId は複数チームに出現できます。
   */
  projects: ProjectDirectoryProject[]
}

/**
 * Lambda が DynamoDB から取得して返すチーム/プロジェクト一覧レスポンスです。
 */
type ProjectDirectoryResponse = {
  /**
   * DB に登録されているチームとプロジェクトの階層です。
   */
  teams: ProjectDirectoryTeam[]
}

/**
 * チーム作成 API が返す response body です。
 */
type CreateProjectDirectoryTeamResponse = {
  /**
   * 作成されたチーム行です。
   */
  team: ProjectDirectoryTeam
}

/**
 * プロジェクト作成 API が返す response body です。
 */
type CreateProjectDirectoryProjectResponse = {
  /**
   * 作成されたプロジェクト行です。
   */
  project: ProjectDirectoryProject
}

/**
 * チームアーカイブ API が返す response body です。
 */
type ArchiveProjectDirectoryTeamResponse = {
  /**
   * アーカイブされたチーム ID です。
   */
  teamId: string
  /**
   * アーカイブ日時の ISO 8601 timestamp です。
   */
  archivedAt: string
}

/**
 * プロジェクトアーカイブ API が返す response body です。
 */
type ArchiveProjectDirectoryProjectResponse = {
  /**
   * プロジェクトが所属していたチーム ID です。
   */
  teamId: string
  /**
   * アーカイブされたプロジェクト ID です。
   */
  projectId: string
  /**
   * アーカイブ日時の ISO 8601 timestamp です。
   */
  archivedAt: string
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
   * プロジェクト内の権限ロールです。
   */
  role: ProjectMemberRole
  /**
   * 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
}

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
 * プロジェクト directory API からエラーレスポンスが返ったときに投げる例外です。
 */
export class ProjectDirectoryApiError extends Error {
  /**
   * API レスポンスの HTTP status code です。
   */
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const projectsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_PROJECTS_API_BASE_URL ??
    import.meta.env.VITE_TASKS_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * DynamoDB に保存されたチーム/プロジェクト階層を Lambda API 経由で取得します。
 */
export async function getProjectDirectory(
  accessToken: string,
  locale: Locale,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `${projectsApiBaseUrl}/teams/projects?locale=${encodeURIComponent(locale)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    },
  )
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof data.message === 'string'
        ? data.message
        : 'projects.error.loading'

    throw new ProjectDirectoryApiError(response.status, message)
  }

  if (!isProjectDirectoryResponse(data)) {
    throw new ProjectDirectoryApiError(response.status, 'projects.error.loading')
  }

  return data.teams
}

/**
 * DynamoDB にチームを作成します。
 */
export async function createProjectDirectoryTeam(
  accessToken: string,
  input: CreateProjectDirectoryTeamInput,
  mutationContext: MutationRequestContext,
) {
  const data = await sendProjectDirectoryRequest<unknown>(
    '/teams',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    mutationContext,
  )

  if (!isCreateProjectDirectoryTeamResponse(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }

  return data.team
}

/**
 * DynamoDB にチーム配下のプロジェクトを作成します。
 */
export async function createProjectDirectoryProject(
  accessToken: string,
  teamId: string,
  input: CreateProjectDirectoryProjectInput,
  mutationContext: MutationRequestContext,
) {
  const data = await sendProjectDirectoryRequest<unknown>(
    `/teams/${encodeURIComponent(teamId)}/projects`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    mutationContext,
  )

  if (!isCreateProjectDirectoryProjectResponse(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }

  return data.project
}

/**
 * DynamoDB 上のチームをアーカイブします。
 */
export async function archiveProjectDirectoryTeam(
  accessToken: string,
  teamId: string,
  mutationContext: MutationRequestContext,
) {
  const data = await sendProjectDirectoryRequest<unknown>(
    `/teams/${encodeURIComponent(teamId)}/archive`,
    accessToken,
    {
      method: 'PATCH',
    },
    mutationContext,
  )

  if (!isArchiveProjectDirectoryTeamResponse(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }

  return data
}

/**
 * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
 */
export async function archiveProjectDirectoryProject(
  accessToken: string,
  teamId: string,
  projectId: string,
  mutationContext: MutationRequestContext,
) {
  const data = await sendProjectDirectoryRequest<unknown>(
    `/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}/archive`,
    accessToken,
    {
      method: 'PATCH',
    },
    mutationContext,
  )

  if (!isArchiveProjectDirectoryProjectResponse(data)) {
    throw new ProjectDirectoryApiError(502, 'projects.error.loading')
  }

  return data
}

/**
 * DynamoDB に保存されたプロジェクトメンバー一覧を取得します。
 */
export async function getProjectMembers(accessToken: string, projectId: string, signal?: AbortSignal) {
  const response = await fetch(
    `${projectsApiBaseUrl}/projects/${encodeURIComponent(projectId)}/members`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    },
  )
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const message = readErrorMessage(data)

    throw new ProjectDirectoryApiError(response.status, message)
  }

  if (!isProjectMembersResponse(data)) {
    throw new ProjectDirectoryApiError(response.status, 'projects.error.loading')
  }

  return data.members
}

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
    const message = readErrorMessage(data)

    throw new ProjectDirectoryApiError(response.status, message)
  }

  if (!isProjectUsersResponse(data)) {
    throw new ProjectDirectoryApiError(response.status, 'projects.error.loading')
  }

  return data
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
    const message = readErrorMessage(data)

    throw new ProjectDirectoryApiError(response.status, message)
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
 * API レスポンスがチーム/プロジェクト階層として扱えるかどうかを判定します。
 */
function isProjectDirectoryResponse(value: unknown): value is ProjectDirectoryResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'teams' in value &&
    Array.isArray(value.teams) &&
    value.teams.every(isProjectDirectoryTeam)
  )
}

/**
 * API から返った値がチーム行として扱えるかどうかを判定します。
 */
function isProjectDirectoryTeam(value: unknown): value is ProjectDirectoryTeam {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    (!('expanded' in value) || typeof value.expanded === 'boolean') &&
    'projects' in value &&
    Array.isArray(value.projects) &&
    value.projects.every(isProjectDirectoryProject)
  )
}

/**
 * API から返った値がプロジェクト行として扱えるかどうかを判定します。
 */
function isProjectDirectoryProject(value: unknown): value is ProjectDirectoryProject {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    (!('tone' in value) || isProjectTone(value.tone))
  )
}

/**
 * API レスポンスがチーム作成結果として扱えるかどうかを判定します。
 */
function isCreateProjectDirectoryTeamResponse(
  value: unknown,
): value is CreateProjectDirectoryTeamResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'team' in value &&
    isProjectDirectoryTeam(value.team)
  )
}

/**
 * API レスポンスがプロジェクト作成結果として扱えるかどうかを判定します。
 */
function isCreateProjectDirectoryProjectResponse(
  value: unknown,
): value is CreateProjectDirectoryProjectResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'project' in value &&
    isProjectDirectoryProject(value.project)
  )
}

/**
 * API レスポンスがチームアーカイブ結果として扱えるかどうかを判定します。
 */
function isArchiveProjectDirectoryTeamResponse(
  value: unknown,
): value is ArchiveProjectDirectoryTeamResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'teamId' in value &&
    typeof value.teamId === 'string' &&
    'archivedAt' in value &&
    typeof value.archivedAt === 'string'
  )
}

/**
 * API レスポンスがプロジェクトアーカイブ結果として扱えるかどうかを判定します。
 */
function isArchiveProjectDirectoryProjectResponse(
  value: unknown,
): value is ArchiveProjectDirectoryProjectResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'teamId' in value &&
    typeof value.teamId === 'string' &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'archivedAt' in value &&
    typeof value.archivedAt === 'string'
  )
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
    'role' in value &&
    isProjectMemberRole(value.role) &&
    'updatedAt' in value &&
    typeof value.updatedAt === 'string'
  )
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
    (!('status' in value) || typeof value.status === 'string')
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
 * API 値が既知の sidebar project tone かどうかを判定します。
 */
function isProjectTone(value: unknown): value is SidebarProjectTone {
  return value === 'blue' || value === 'purple' || value === 'green' || value === 'yellow'
}
