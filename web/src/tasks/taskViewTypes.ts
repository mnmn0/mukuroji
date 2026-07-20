import type { TaskPriority, TaskStatus } from './api'

/**
 * タスク画面で切り替えられるビューの一覧です。
 */
export const taskTabs = ['table', 'board', 'gantt', 'calendar', 'file', 'permissions'] as const

/**
 * タスク画面で選択できるステータスの一覧です。
 */
export const taskStatuses = ['in-progress', 'review', 'todo', 'done'] as const satisfies readonly TaskStatus[]

/**
 * タスク画面で選択できる優先度の一覧です。
 */
export const taskPriorities = ['high', 'medium', 'low'] as const satisfies readonly TaskPriority[]

/**
 * タスク画面で選択できる期限フィルターの一覧です。
 */
export const taskDueDateFilters = ['all', 'overdue', 'upcoming', 'no-date'] as const

/**
 * タスク画面で選択できる期限並び順の一覧です。
 */
export const taskSortOrders = ['due-date-asc', 'due-date-desc'] as const

/**
 * タスク画面で切り替えられるビュー種別です。
 */
export type TaskTab = (typeof taskTabs)[number]

/**
 * ステータス絞り込みの選択値です。
 */
export type StatusFilter = TaskStatus | 'all'

/**
 * 担当者絞り込みの選択値です。
 */
export type AssigneeFilter = string | 'all'

/**
 * 優先度絞り込みの選択値です。
 */
export type PriorityFilter = TaskPriority | 'all'

/**
 * 期限バケット絞り込みの選択値です。
 */
export type DueDateFilter = (typeof taskDueDateFilters)[number]

/**
 * タスク一覧の期限並び替え方向です。
 */
export type TaskSortOrder = (typeof taskSortOrders)[number]
