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
   * 取得元プロジェクト ID です。API body の top-level projectId から補完されます。
   */
  projectId?: string
  /**
   * プロジェクト内でタスクを識別する ID です。
   */
  id: string
  /**
   * タスク名を解決する i18n key です。seed 由来のタスクで利用します。
   */
  titleKey?: MessageKey
  /**
   * API から取得した literal のタスク名です。
   */
  title?: string
  /**
   * 担当者名を解決する i18n key です。seed 由来のタスクで利用します。
   */
  assigneeKey?: MessageKey
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId?: string
  /**
   * Cognito から解決した担当者メールアドレスです。
   */
  assigneeEmail?: string
  /**
   * Cognito から解決した担当者表示名です。
   */
  assigneeName?: string
  /**
   * API から取得した literal の担当者名です。旧データ互換で利用します。
   */
  assignee?: string
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
 * タスク作成 API に送信する入力です。
 */
export type CreateProjectTaskInput = {
  /**
   * ユーザーが入力したタスク名です。
   */
  title: string
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId: string
  /**
   * 期限日として保存する文字列です。
   */
  dueDate: string
  /**
   * タスクの状態コードです。
   */
  status: TaskStatus
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
 * タスク作成 API が返す response body です。
 */
type CreateProjectTaskResponse = {
  /**
   * 作成されたタスク行です。
   */
  task: ProjectTask
}

/**
 * タスク状態更新 API が返す response body です。
 */
type UpdateProjectTaskStatusResponse = {
  /**
   * 更新されたタスク行です。
   */
  task: ProjectTask
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

  return attachProjectId(data)
}

/**
 * DynamoDB にプロジェクトタスクを作成します。
 */
export async function createProjectTask(
  projectId: string,
  accessToken: string,
  input: CreateProjectTaskInput,
) {
  const response = await fetch(
    `${tasksApiBaseUrl}/projects/${encodeURIComponent(projectId)}/tasks`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
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

  if (!isCreateProjectTaskResponse(data)) {
    throw new ProjectTasksApiError(response.status, 'tasks.error.loading')
  }

  return {
    ...data.task,
    projectId,
  }
}

/**
 * DynamoDB に保存されたプロジェクトタスクの状態を更新します。
 */
export async function updateProjectTaskStatus(
  projectId: string,
  taskId: string,
  accessToken: string,
  status: TaskStatus,
) {
  const response = await fetch(
    `${tasksApiBaseUrl}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
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

  if (!isUpdateProjectTaskStatusResponse(data)) {
    throw new ProjectTasksApiError(response.status, 'tasks.error.loading')
  }

  return {
    ...data.task,
    projectId,
  }
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
    (!('projectId' in value) || typeof value.projectId === 'string') &&
    'id' in value &&
    typeof value.id === 'string' &&
    (!('titleKey' in value) || typeof value.titleKey === 'string') &&
    (!('title' in value) || typeof value.title === 'string') &&
    ('titleKey' in value || 'title' in value) &&
    (!('assigneeKey' in value) || typeof value.assigneeKey === 'string') &&
    (!('assigneeUserId' in value) || typeof value.assigneeUserId === 'string') &&
    (!('assigneeEmail' in value) || typeof value.assigneeEmail === 'string') &&
    (!('assigneeName' in value) || typeof value.assigneeName === 'string') &&
    (!('assignee' in value) || typeof value.assignee === 'string') &&
    ('assigneeUserId' in value || 'assigneeKey' in value || 'assignee' in value) &&
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

/**
 * API レスポンスがタスク作成結果として扱えるかどうかを判定します。
 */
function isCreateProjectTaskResponse(value: unknown): value is CreateProjectTaskResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'task' in value &&
    isProjectTask(value.task)
  )
}

/**
 * API レスポンスがタスク状態更新結果として扱えるかどうかを判定します。
 */
function isUpdateProjectTaskStatusResponse(value: unknown): value is UpdateProjectTaskStatusResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'task' in value &&
    isProjectTask(value.task)
  )
}

/**
 * top-level の projectId を各タスク行へ補完します。
 */
function attachProjectId(response: ProjectTasksResponse) {
  return response.tasks.map((task) => ({
    ...task,
    projectId: response.projectId,
  }))
}
