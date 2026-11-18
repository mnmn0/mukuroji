import type {
  CanonicalWorkItem,
  TeamWorkItemHierarchyNode,
  TaskViewSortDirection,
  WorkItemSchedule,
} from '@mukuroji/contracts'
import {
  groupTaskViewItems,
  type TaskViewGroupValue,
} from '../../task-views/model/taskViewPresentation'
import {
  createMultiTeamWorkItemOutlineRows,
  type WorkItemOutlineRow,
} from '../../work-items/model/workItemHierarchy'
import { resolveTaskSchedule, resolveTaskSchedulePrimaryDate } from './taskSchedule'
import { createTaskKey } from './taskView'

/** Where a Work Item sits in the outline shown by a Gantt chart. */
export type TaskGanttOutlinePlacement = {
  /** Indentation level among the shown Work Items; top-level is 0. */
  depth: number
  /** Whether shown Work Items are nested under this row. */
  hasChildren: boolean
  /** Whether the rows nested under this row are hidden. */
  collapsed: boolean
  /** Hierarchy node with the WBS number and roll-up; absent outside the read hierarchy. */
  node?: TeamWorkItemHierarchyNode
}

/** One Work Item row of a Gantt chart. */
export type TaskGanttTaskRow = {
  /** Row discriminator. */
  kind: 'task'
  /** Work Item rendered in the row. */
  task: CanonicalWorkItem
  /** Canonical schedule rendered for the task. */
  schedule: WorkItemSchedule
  /** Outline placement; absent when the chart is not shown as an outline. */
  outline?: TaskGanttOutlinePlacement
}

/** Heading row of one group of a grouped Gantt chart. */
export type TaskGanttGroupRow = {
  /** Row discriminator. */
  kind: 'group'
  /** Stable group key. */
  key: string
  /** Group heading. */
  label: string
  /** Number of Work Items in the group, including rows hidden under collapsed parents. */
  count: number
}

/** One rendered row of a Gantt chart. */
export type TaskGanttRow = TaskGanttTaskRow | TaskGanttGroupRow

/** Hierarchy that turns a Gantt chart into an outline. */
export type TaskGanttOutlineSource = {
  /** Hierarchy nodes in outline order, by Team ID; a Team without nodes stays flat. */
  hierarchies: ReadonlyMap<string, readonly TeamWorkItemHierarchyNode[]>
  /** Keys from `createWorkItemOutlineKey` of the collapsed rows. */
  collapsedKeys: ReadonlySet<string>
}

/** Grouping applied to the Work Items of a Gantt chart. */
export type TaskGanttGrouping = {
  /** Order of the group headings. */
  direction: TaskViewSortDirection
  /** Resolves the group of one Work Item. */
  resolve: (task: CanonicalWorkItem) => TaskViewGroupValue
}

/** Options of {@link createTaskGanttRows}. */
export type CreateTaskGanttRowsOptions = {
  /** Hierarchy shown as an outline; without it rows follow schedule order. */
  outline?: TaskGanttOutlineSource
  /** Grouping; each group gets a heading row followed by its Work Items. */
  group?: TaskGanttGrouping
}

/**
 * Orders Work Items by primary schedule date and stable identity without mutating the input.
 *
 * @param tasks - Work Items shown in the Gantt chart.
 * @returns Rows ordered by primary schedule date.
 */
export function sortTaskGanttRowsBySchedule(tasks: readonly CanonicalWorkItem[]): TaskGanttTaskRow[] {
  return tasks
    .map((task) => ({ kind: 'task' as const, schedule: resolveTaskSchedule(task), task }))
    .toSorted((left, right) => {
      const leftDate = resolveTaskSchedulePrimaryDate(left.schedule) ?? '9999-12-31'
      const rightDate = resolveTaskSchedulePrimaryDate(right.schedule) ?? '9999-12-31'
      return leftDate.localeCompare(rightDate) || createTaskKey(left.task).localeCompare(createTaskKey(right.task))
    })
}

/**
 * Lays out the rows of a Gantt chart: schedule order, an optional outline, and optional groups.
 *
 * With an outline, Work Items follow the hierarchy within each group and each Team, children sit
 * under their nearest shown ancestor, and rows under a collapsed parent are left out. Work Items
 * outside the hierarchy follow in schedule order. A group counts all of its Work Items, also the
 * ones hidden under a collapsed parent.
 *
 * @param tasks - Work Items shown in the Gantt chart.
 * @param options - Outline and grouping.
 * @returns Rows in display order.
 */
export function createTaskGanttRows(
  tasks: readonly CanonicalWorkItem[],
  options: CreateTaskGanttRowsOptions = {},
): TaskGanttRow[] {
  const scheduled = sortTaskGanttRowsBySchedule(tasks)
  const group = options.group
  const groups = group
    ? groupTaskViewItems(scheduled, 'group', (row) => group.resolve(row.task), group.direction)
    : [{ key: '', label: '', items: scheduled }]
  return groups.flatMap((entry) => {
    const rows = layoutTaskGanttTaskRows(entry.items, options.outline)
    return group
      ? [{ kind: 'group' as const, key: entry.key, label: entry.label, count: entry.items.length }, ...rows]
      : rows
  })
}

/**
 * Applies the outline to one group's Work Items.
 *
 * @param rows - Work Item rows in schedule order.
 * @param outline - Hierarchy to apply; without it the rows are returned unchanged.
 * @returns Rows in outline order with their placements.
 */
function layoutTaskGanttTaskRows(
  rows: readonly TaskGanttTaskRow[],
  outline: TaskGanttOutlineSource | undefined,
): TaskGanttTaskRow[] {
  if (!outline) return [...rows]
  const schedules = new Map(rows.map((row) => [row.task, row.schedule]))
  return createMultiTeamWorkItemOutlineRows(
    rows.map((row) => row.task),
    outline.hierarchies,
    outline.collapsedKeys,
  ).map((row: WorkItemOutlineRow<CanonicalWorkItem>) => ({
    kind: 'task' as const,
    task: row.item,
    schedule: schedules.get(row.item) ?? resolveTaskSchedule(row.item),
    outline: {
      depth: row.depth,
      hasChildren: row.hasChildren,
      collapsed: row.collapsed,
      ...(row.node ? { node: row.node } : {}),
    },
  }))
}
