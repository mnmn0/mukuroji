import type { CanonicalWorkItem, CreateWorkItemInput, WorkItemPriority, WorkItemStatus } from '@mukuroji/contracts'
import { ProjectTasksApiError } from './errors'

/**
 * Read-only legacy task が保持する固定 status の互換名です。
 */
export type TaskStatus = WorkItemStatus

/**
 * タスク画面が表示する canonical Work Item priority の互換名です。
 */
export type TaskPriority = WorkItemPriority

/**
 * タスク画面が表示する canonical Work Item の互換名です。
 */
export type ProjectTask = CanonicalWorkItem

/**
 * Canonical Work Item の workflow status を旧タスク画面の表示 status へ変換します。
 *
 * 分割済みの互換画面は固定 status を前提にしているため、既知の status ID を優先し、
 * 未知の ID は標準 category から表示上の status を決定します。
 */
export function resolveProjectTaskStatus(task: ProjectTask): TaskStatus {
  const normalizedStatusId = task.workflowStatusId.trim().toLowerCase()

  if (isTaskStatus(normalizedStatusId)) {
    return normalizedStatusId
  }

  switch (task.statusCategory) {
    case 'completed':
    case 'canceled':
      return 'done'
    case 'started':
      return 'in-progress'
    case 'backlog':
    case 'unstarted':
    default:
      return 'todo'
  }
}

/** Issue #20 の read-only adapter が返す legacy project task です。 */
export type LegacyProjectTask = {
  /** 旧 Project task table を保存元とすることを表します。 */
  source: 'legacy'
  /** Project 内で task を識別する ID です。 */
  id: string
  /** API が返す literal の task 名です。 */
  title?: string
  /** Seed task の表示文言 key です。 */
  titleKey?: string
  /** 担当者を参照する user ID です。 */
  assigneeUserId?: string
  /** Cognito から解決した担当者メールアドレスです。 */
  assigneeEmail?: string
  /** Cognito から解決した担当者表示名です。 */
  assigneeName?: string
  /** API が返す literal の担当者名です。 */
  assignee?: string
  /** Seed task の担当者表示文言 key です。 */
  assigneeKey?: string
  /** 旧 Project task の固定 status です。 */
  status: TaskStatus
  /** 期限日として表示する文字列です。 */
  dueDate: string
  /** Task の優先度です。 */
  priority: TaskPriority
}

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
  tasks: LegacyProjectTask[]
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
    const code = typeof data === 'object' &&
      data !== null &&
      'code' in data &&
      typeof data.code === 'string'
      ? data.code
      : undefined

    throw new ProjectTasksApiError(response.status, message, code)
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
    Array.isArray(value.tasks) &&
    value.tasks.every(isLegacyProjectTask)
}

function isLegacyProjectTask(value: unknown): value is LegacyProjectTask {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const task = value as Record<string, unknown>
  return task.source === 'legacy' &&
    typeof task.id === 'string' &&
    isOptionalString(task.title) &&
    isOptionalString(task.titleKey) &&
    isOptionalString(task.assigneeUserId) &&
    isOptionalString(task.assigneeEmail) &&
    isOptionalString(task.assigneeName) &&
    isOptionalString(task.assignee) &&
    isOptionalString(task.assigneeKey) &&
    isTaskStatus(task.status) &&
    typeof task.dueDate === 'string' &&
    isTaskPriority(task.priority)
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === 'string'
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'todo' || value === 'in-progress' || value === 'review' || value === 'done'
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 'low' || value === 'medium' || value === 'high'
}
