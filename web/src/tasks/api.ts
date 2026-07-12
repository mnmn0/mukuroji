import type {
  CreateWorkItemInput,
  WorkItem,
  WorkItemPriority,
  WorkItemStatus,
} from '@mukuroji/contracts'
import type { MessageKey } from '../i18n'

/**
 * タスク画面が表示する canonical Work Item status の互換名です。
 */
export type TaskStatus = WorkItemStatus

/**
 * タスク画面が表示する canonical Work Item priority の互換名です。
 */
export type TaskPriority = WorkItemPriority

/**
 * タスク画面が表示する canonical Work Item の互換名です。
 */
export type ProjectTask = WorkItem<MessageKey>

/**
 * タスク作成 form が生成する canonical Work Item 入力の互換名です。
 */
export type CreateProjectTaskInput = CreateWorkItemInput

/**
 * legacy project task read API の response body です。
 */
type ProjectTasksResponse = {
  /**
   * 取得対象の Project ID です。
   */
  projectId: string
  /**
   * read-only compatibility adapter が返す Work Item 一覧です。
   */
  tasks: ProjectTask[]
}

/**
 * legacy project task read API からエラーが返ったときの例外です。
 */
export class ProjectTasksApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const tasksApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * legacy project task compatibility adapter を参照専用で取得します。
 */
export async function getProjectTasks(projectId: string, accessToken?: string) {
  const response = await fetch(
    `${tasksApiBaseUrl}/projects/${encodeURIComponent(projectId)}/tasks`,
    {
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : undefined,
    },
  )
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const message = typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof data.message === 'string'
      ? data.message
      : 'tasks.error.loading'

    throw new ProjectTasksApiError(response.status, message)
  }

  if (!isProjectTasksResponse(data)) {
    throw new ProjectTasksApiError(response.status, 'tasks.error.loading')
  }

  return data.tasks
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
 * legacy compatibility response の最低限の形を検証します。
 */
function isProjectTasksResponse(value: unknown): value is ProjectTasksResponse {
  return typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'tasks' in value &&
    Array.isArray(value.tasks)
}
