import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type { SidebarProjectTone } from '../../shared/ui/sidebar'
import type { Locale } from '../../shared/i18n/i18n'
import { ProjectDirectoryApiError } from './errors'

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

const projectsApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_PROJECTS_API_BASE_URL ??
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
    throw new ProjectDirectoryApiError(
      response.status,
      readErrorMessage(data),
      readErrorCode(data),
    )
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
 * API 値が既知の sidebar project tone かどうかを判定します。
 */
function isProjectTone(value: unknown): value is SidebarProjectTone {
  return value === 'blue' || value === 'purple' || value === 'green' || value === 'yellow'
}
