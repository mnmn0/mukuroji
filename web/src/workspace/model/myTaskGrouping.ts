import {
  type CanonicalWorkItem,
  createSearchWorkItemTypeKey,
  DEFAULT_WORK_ITEM_TYPE_ID,
  type ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { MessageKey } from '../../shared/i18n/i18n'
import type {
  TaskViewGroupValue,
  TaskViewSortDirection,
} from '../../task-views/model/taskViewPresentation'
import type { TaskGanttGrouping } from '../../tasks/model/taskGanttRows'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTypeLabel,
  resolveWorkItemWorkflowStatusLabel,
} from '../../work-items/model/workItemDisplay'

/** Resolves a Project display name for one Workspace Work Item. */
export function resolveMyTaskProjectLabel(
  task: CanonicalWorkItem,
  teams: readonly ProjectDirectoryTeam[],
): string | undefined {
  if (!task.assignedProjectId) return undefined
  return teams.flatMap((team) => team.projects).find(
    (project) => project.id === task.assignedProjectId,
  )?.name ?? task.assignedProjectId
}

/** Resolves a stable key and visible label for one My Tasks grouping field. */
export function resolveMyTaskGroupValue(
  task: CanonicalWorkItem,
  field: string,
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  teams: readonly ProjectDirectoryTeam[],
  t: (key: MessageKey) => string,
): TaskViewGroupValue {
  const configuration = configurationsByTeam[task.teamId]?.configuration
  let value: string
  let key: string | undefined
  switch (field) {
    case 'title': value = task.title; break
    case 'status': value = resolveWorkItemWorkflowStatusLabel(task, configuration); break
    case 'assignee': value = resolveWorkItemAssignee(task); break
    case 'dueDate': value = task.dueDate || '—'; break
    case 'priority': value = t(`tasks.priority.${task.priority}`); break
    case 'workItemType': {
      const typeLabel = resolveWorkItemTypeLabel(task, configuration)
      const hasMultipleTeams = Object.keys(configurationsByTeam).length > 1 || teams.length > 1
      const teamLabel = teams.find((team) => team.id === task.teamId)?.name ?? task.teamId
      value = hasMultipleTeams ? `${teamLabel} · ${typeLabel}` : typeLabel
      key = createSearchWorkItemTypeKey(
        task.teamId,
        task.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
      )
      break
    }
    case 'project': value = resolveMyTaskProjectLabel(task, teams) ?? '—'; break
    case 'team': value = teams.find((team) => team.id === task.teamId)?.name ?? task.teamId; break
    default: {
      const customValue = field.startsWith('custom:')
        ? task.customFieldValues[field.slice('custom:'.length)]
        : undefined
      value = Array.isArray(customValue)
        ? customValue.join(', ')
        : customValue === undefined || customValue === null || customValue === ''
          ? '—'
          : String(customValue)
    }
  }
  return { key: key ?? value, label: value }
}

/**
 * Groups the My Tasks Gantt chart by the view's grouping field.
 *
 * The page uses it too, so keyboard navigation follows the same groups as the chart.
 *
 * @param groupBy - Grouping field, or none.
 * @param groupDirection - Order of the groups.
 * @param configurationsByTeam - Resolved Work Item configurations by Team ID.
 * @param teams - Teams with their Projects.
 * @param t - Translator.
 * @returns The grouping, or `undefined` without a grouping field.
 */
export function createMyTasksGanttGrouping(
  groupBy: string | undefined,
  groupDirection: TaskViewSortDirection | undefined,
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  teams: readonly ProjectDirectoryTeam[],
  t: (key: MessageKey) => string,
): TaskGanttGrouping | undefined {
  return groupBy
    ? {
        direction: groupDirection ?? 'asc',
        resolve: (task) => resolveMyTaskGroupValue(task, groupBy, configurationsByTeam, teams, t),
      }
    : undefined
}
