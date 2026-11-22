import type {
  CanonicalWorkItem,
  ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  groupTaskViewItems,
  type TaskViewPresentationSettings,
} from '../../task-views/model/taskViewPresentation'
import { resolveMyTaskGroupValue } from './myTaskGrouping'

/** Built-in fields the My Tasks table can show as columns. */
const myTasksTableBuiltInColumns: readonly string[] = [
  'title',
  'status',
  'assignee',
  'dueDate',
  'priority',
  'workItemType',
  'project',
  'team',
  'customFields',
]

/** Columns shown when the effective view has no column settings. */
const myTasksTableDefaultColumns: readonly string[] = [
  'title',
  'status',
  'dueDate',
  'priority',
  'project',
  'team',
]

/** One run of rows in the My Tasks table, optionally under a group heading. */
export type MyTasksTableSection = {
  /** Stable key of the section. */
  key: string
  /** Heading shown above the rows with its count; absent when the table is not grouped. */
  heading?: {
    /** Visible group label. */
    label: string
    /** Number of Work Items in the group, including those of its subgroups. */
    count: number
    /** Whether the heading belongs to a subgroup under a primary group. */
    secondary: boolean
  }
  /** Work Items listed under the heading, in display order. */
  items: readonly CanonicalWorkItem[]
}

/**
 * Lists the columns of the My Tasks table from the effective view.
 *
 * Unknown fields are dropped and the title always comes first, so every row keeps a way to
 * open its Work Item.
 *
 * @param presentation - Effective presentation settings, when loaded.
 * @returns Ordered column fields.
 */
export function resolveMyTasksTableColumns(
  presentation: TaskViewPresentationSettings | undefined,
): string[] {
  const fields = (presentation?.columns.map((column) => column.field) ?? myTasksTableDefaultColumns)
    .filter((field) => myTasksTableBuiltInColumns.includes(field) || field.startsWith('custom:'))
  return ['title', ...fields.filter((field) => field !== 'title')]
}

/**
 * Splits the My Tasks table rows into group sections.
 *
 * Rows keep the order of `tasks`, which is already sorted by the effective view, so the
 * built-in view lists Work Items by due date. Groups and subgroups follow the view's grouping.
 *
 * @param tasks - Filtered and sorted Work Items.
 * @param presentation - Effective presentation settings, when loaded.
 * @param configurationsByTeam - Team configurations used for group labels.
 * @param teams - Workspace directory used for Team and Project labels.
 * @param t - Translator used for group labels.
 * @returns Sections in display order.
 */
export function createMyTasksTableSections(
  tasks: readonly CanonicalWorkItem[],
  presentation: TaskViewPresentationSettings | undefined,
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  teams: readonly ProjectDirectoryTeam[],
  t: (key: MessageKey) => string,
): MyTasksTableSection[] {
  const groupBy = presentation?.groupBy
  if (!groupBy) return [{ key: 'all', items: tasks }]

  /** Resolves one grouping value with the My Tasks labels. */
  const resolveValue = (task: CanonicalWorkItem, field: string) =>
    resolveMyTaskGroupValue(task, field, configurationsByTeam, teams, t)
  const subgroupBy = presentation.subgroupBy
  return groupTaskViewItems(tasks, groupBy, resolveValue, presentation.groupDirection)
    .flatMap((group): MyTasksTableSection[] => {
      const heading = { label: group.label, count: group.items.length, secondary: false }
      if (!subgroupBy) return [{ key: group.key, heading, items: group.items }]
      return [
        { key: group.key, heading, items: [] },
        ...groupTaskViewItems(group.items, subgroupBy, resolveValue, presentation.subgroupDirection)
          .map((subgroup) => ({
            key: `${group.key}:${subgroup.key}`,
            heading: { label: subgroup.label, count: subgroup.items.length, secondary: true },
            items: subgroup.items,
          })),
      ]
    })
}

/**
 * Lists the Work Items of the My Tasks table in display order, for keyboard movement.
 *
 * @param sections - Sections created by {@link createMyTasksTableSections}.
 * @returns Work Items in the order the table shows them.
 */
export function listMyTasksTableRowTasks(
  sections: readonly MyTasksTableSection[],
): CanonicalWorkItem[] {
  return sections.flatMap((section) => section.items)
}
