import type { MessageKey } from '../i18n'

/**
 * タスクの進捗状態を表す API code です。
 */
export type TaskStatus = 'in-progress' | 'review' | 'todo' | 'done'

/**
 * タスクの優先度を表す API code です。
 */
export type TaskPriority = 'high' | 'medium' | 'low'

/**
 * API レスポンスとして許容する task status の一覧です。
 */
const taskStatuses = ['in-progress', 'review', 'todo', 'done'] as const

/**
 * API レスポンスとして許容する task priority の一覧です。
 */
const taskPriorities = ['high', 'medium', 'low'] as const

/**
 * プロジェクト画面のテーブルへ表示するタスク行です。
 */
export type ProjectTask = {
  /**
   * React の key として使う一意なタスク ID です。
   */
  id: string
  /**
   * タスク名を解決する i18n key です。
   */
  titleKey: MessageKey
  /**
   * 担当者名を解決する i18n key です。
   */
  assigneeKey: MessageKey
  /**
   * タスクの状態コードです。
   */
  status: TaskStatus
  /**
   * 期限日として表示する文字列です。
   */
  dueDate: string
  /**
   * 優先度コードです。
   */
  priority: TaskPriority
}

/**
 * Lambda が DynamoDB から取得して返すプロジェクトタスク一覧レスポンスです。
 */
type ProjectTasksResponse = {
  /**
   * 取得対象のプロジェクト ID です。
   */
  projectId: string
  /**
   * DynamoDB に保存されたタスク一覧です。
   */
  tasks: ProjectTask[]
}

/**
 * Lambda API からエラーレスポンスが返ったときに投げる例外です。
 */
export class ProjectTasksApiError extends Error {
  /**
   * API レスポンスの HTTP status code です。
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
 * DynamoDB に保存されたプロジェクトタスクを Lambda API 経由で取得します。
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
    const message =
      typeof data === 'object' &&
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
 * Lambda のタスク一覧レスポンスとして扱える形かどうかを判定します。
 */
function isProjectTasksResponse(value: unknown): value is ProjectTasksResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'tasks' in value &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isProjectTask)
  )
}

/**
 * API から返った値がタスク行として扱えるかどうかを判定します。
 */
function isProjectTask(value: unknown): value is ProjectTask {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'titleKey' in value &&
    typeof value.titleKey === 'string' &&
    'assigneeKey' in value &&
    typeof value.assigneeKey === 'string' &&
    'status' in value &&
    isTaskStatus(value.status) &&
    'dueDate' in value &&
    typeof value.dueDate === 'string' &&
    'priority' in value &&
    isTaskPriority(value.priority)
  )
}

/**
 * API 値が既知の task status かどうかを判定します。
 */
function isTaskStatus(value: unknown): value is TaskStatus {
  return taskStatuses.includes(value as TaskStatus)
}

/**
 * API 値が既知の task priority かどうかを判定します。
 */
function isTaskPriority(value: unknown): value is TaskPriority {
  return taskPriorities.includes(value as TaskPriority)
}
