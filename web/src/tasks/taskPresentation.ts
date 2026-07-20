import type { MessageKey } from '../i18n'
import type { TeamIssue } from '../issues/api'
import { resolveWorkItemAssignee, resolveWorkItemTitle } from '../issues/workItemDisplay'
import type { ProjectMember } from '../projects/api'
import type { ProjectTask } from './api'
import type { AssigneeFilter, DueDateFilter, TaskSortOrder } from './taskViewTypes'

/**
 * 担当者絞り込みメニューの選択肢です。
 */
type AssigneeFilterOption = {
  /**
   * 絞り込みに使う担当者識別値です。
   */
  value: AssigneeFilter
  /**
   * メニューに表示する担当者名です。
   */
  label: string
}

/** タスクが今日より前の未完了期限を持つか判定します。 */
export function isTaskOverdue(task: ProjectTask) {
  const dueDate = parseTaskDueDate(task.dueDate)

  if (task.status === 'done' || !dueDate) {
    return false
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return dueDate < today
}

function parseTaskDueDate(value: string) {
  const [year, month, day] = value.split('/').map(Number)

  if (!year || !month || !day) {
    return null
  }

  const date = new Date(year, month - 1, day)
  date.setHours(0, 0, 0, 0)

  return Number.isNaN(date.getTime()) ? null : date
}

/** タスク一覧から重複のない担当者フィルター候補を生成します。 */
export function createAssigneeFilterOptions(
  tasks: ProjectTask[],
  t: (key: MessageKey) => string,
): AssigneeFilterOption[] {
  const assigneeOptionsByValue = new Map<string, AssigneeFilterOption>()

  for (const task of tasks) {
    const value = resolveTaskAssigneeFilterValue(task, t)

    if (!value || assigneeOptionsByValue.has(value)) {
      continue
    }

    assigneeOptionsByValue.set(value, {
      label: resolveTaskAssignee(task, t) || t('tasks.detail.unassigned'),
      value,
    })
  }

  return [
    {
      label: t('tasks.filter.assigneeAll'),
      value: 'all',
    },
    ...Array.from(assigneeOptionsByValue.values()).sort((firstOption, secondOption) =>
      firstOption.label.localeCompare(secondOption.label),
    ),
  ]
}

/** タスクの担当者フィルター識別値を解決します。 */
export function resolveTaskAssigneeFilterValue(
  task: ProjectTask,
  t: (key: MessageKey) => string,
) {
  return task.assigneeUserId ??
    task.assigneeEmail ??
    resolveTaskAssignee(task, t) ??
    t('tasks.detail.unassigned')
}

/** タスクが指定した期限フィルターに一致するか判定します。 */
export function matchesTaskDueDateFilter(task: ProjectTask, filter: DueDateFilter) {
  if (filter === 'all') {
    return true
  }

  const dueDate = parseTaskDueDate(task.dueDate)

  if (filter === 'no-date') {
    return !dueDate
  }

  if (task.status === 'done' || !dueDate) {
    return false
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (filter === 'overdue') {
    return dueDate < today
  }

  return dueDate >= today
}

/** タスク一覧を期限と ID で安定して並び替えます。 */
export function sortTasksByDueDate(tasks: ProjectTask[], sortOrder: TaskSortOrder) {
  return [...tasks].sort((firstTask, secondTask) => {
    const firstTime = parseTaskDueDate(firstTask.dueDate)?.getTime()
    const secondTime = parseTaskDueDate(secondTask.dueDate)?.getTime()
    const firstSortTime = firstTime ?? Number.MAX_SAFE_INTEGER
    const secondSortTime = secondTime ?? Number.MAX_SAFE_INTEGER

    if (firstSortTime === secondSortTime) {
      return firstTask.id.localeCompare(secondTask.id)
    }

    if (sortOrder === 'due-date-desc') {
      return secondSortTime - firstSortTime
    }

    return firstSortTime - secondSortTime
  })
}

/** 期限フィルターに対応する翻訳キーを返します。 */
export function resolveDueDateFilterLabelKey(filter: DueDateFilter): MessageKey {
  const labelKeys: Record<DueDateFilter, MessageKey> = {
    all: 'tasks.filter.dueDateAll',
    overdue: 'tasks.filter.dueDateOverdue',
    upcoming: 'tasks.filter.dueDateUpcoming',
    'no-date': 'tasks.filter.dueDateNoDate',
  }

  return labelKeys[filter]
}

/** 期限並び順に対応する翻訳キーを返します。 */
export function resolveTaskSortOrderLabelKey(sortOrder: TaskSortOrder): MessageKey {
  return sortOrder === 'due-date-desc'
    ? 'tasks.sort.dueDateDesc'
    : 'tasks.sort.dueDateAsc'
}

/** API の日付表現を date input 用の値へ変換します。 */
export function formatDateInputValue(value: string) {
  return value.replaceAll('/', '-')
}

/** タスクの表示タイトルを翻訳関数から解決します。 */
export function resolveTaskTitle(task: ProjectTask, t: (key: MessageKey) => string) {
  return resolveWorkItemTitle(task, t)
}

/** タスクの担当者表示名を翻訳関数から解決します。 */
export function resolveTaskAssignee(task: ProjectTask, t: (key: MessageKey) => string) {
  return resolveWorkItemAssignee(task, t)
}

/** Team Issue の表示タイトルを翻訳関数から解決します。 */
export function resolveTeamIssueTitle(issue: TeamIssue, t: (key: MessageKey) => string) {
  return resolveWorkItemTitle(issue, t)
}

/** Project member を select option 用の表示名へ整形します。 */
export function formatProjectMemberOption(member: ProjectMember) {
  return `${member.name ?? member.email} / ${member.email}`
}

/** 複数チーム・プロジェクト間でも安定するタスクキーを生成します。 */
export function createTaskKey(task: ProjectTask) {
  return task.assignedProjectId || task.teamId
    ? `${task.assignedProjectId ?? ''}:${task.teamId ?? ''}:${task.id}`
    : task.id
}

/** タスク一覧から期限日ごとのカレンダー列を生成します。 */
export function createTaskCalendarDays(tasks: ProjectTask[]) {
  const dates = Array.from(new Set(tasks.map((task) => task.dueDate)))
    .filter(Boolean)
    .sort()

  return dates.map((date) => ({
    id: date,
    label: date,
    date,
  }))
}
