import type { SidebarProjectTone } from '../components/sidebar'
import type { Locale } from '../i18n'

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
 * API 値が既知の sidebar project tone かどうかを判定します。
 */
function isProjectTone(value: unknown): value is SidebarProjectTone {
  return value === 'blue' || value === 'purple' || value === 'green' || value === 'yellow'
}
