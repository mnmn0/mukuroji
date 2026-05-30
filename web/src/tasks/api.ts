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
export async function getProjectTasks(projectId: string) {
  const response = await fetch(
    `${tasksApiBaseUrl}/projects/${encodeURIComponent(projectId)}/tasks`,
  )
  const data = await readJson<{ message?: string } | ProjectTasksResponse>(response)

  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      'message' in data &&
      typeof data.message === 'string'
        ? data.message
        : 'Project tasks request failed.'

    throw new ProjectTasksApiError(response.status, message)
  }

  return (data as ProjectTasksResponse).tasks
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
