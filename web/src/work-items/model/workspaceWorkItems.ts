import {
  deriveWorkItemScheduleDueDate,
  type ResolvedWorkItemConfiguration,
  type WorkflowStatusDefinition,
} from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { ProjectTask } from '../../tasks/api'
import { taskScheduleInstantToLocalDate } from '../../tasks/model/taskSchedule'
import {
  isCompletedWorkItem,
  isOpenWorkItem,
  resolveWorkItemWorkflowStatusId,
} from './workItemDisplay'

/**
 * Describes a Team-scoped workflow status column in the Workspace Kanban board.
 */
export type WorkspaceTaskStatusColumn = {
  /** Unique column ID used as the React key and drag target. */
  key: string
  /** Column label that distinguishes identically named statuses across Teams. */
  label: string
  /** ID of the Team that owns the canonical Work Item workflow. */
  teamId: string
  /** Status definition used for the column label and category tone. */
  status: WorkflowStatusDefinition
}

/**
 * Describes aggregate values displayed in the Workspace summary cards.
 */
export type WorkspaceSummary = {
  /** Number of unique Projects in the directory. */
  projects: number
  /** Number of incomplete Work Items. */
  tasks: number
  /** Number of active Work Items blocked by canonical relation/dependency signals. */
  blocked: number
}

/**
 * Describes a Project row displayed in the Workspace dashboard portfolio table.
 */
export type WorkspacePortfolioProject = {
  /** Unique row ID composed from the Team and Project IDs. */
  id: string
  /** Project name. */
  name: string
  /** Name of the Team that owns the Project. */
  teamName: string
  /** Percentage of completed Work Items. */
  progress: number
  /** Project attention level. */
  risk: 'clear' | 'low' | 'watch'
}

/**
 * Creates a key that uniquely identifies a Work Item within the Workspace projection.
 *
 * @param task - Work Item for which to create a key.
 * @returns A key composed from the Team, Project, and Work Item IDs.
 */
export function createWorkspaceTaskKey(task: ProjectTask) {
  return `${task.teamId}:${task.assignedProjectId ?? ''}:${task.id}`
}

/**
 * Returns the resolved configuration for the Team that owns a Work Item.
 *
 * @param task - Work Item whose configuration to resolve.
 * @param configurationsByTeam - Resolved configurations keyed by Team ID.
 * @returns The Work Item's Team configuration, or undefined when unavailable.
 */
export function resolveWorkspaceTaskConfiguration(
  task: ProjectTask,
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
) {
  return configurationsByTeam[task.teamId]?.configuration
}

/**
 * Finds the Work Item that matches a Workspace task key.
 *
 * @param tasks - Work Items to search.
 * @param taskKey - Key created by {@link createWorkspaceTaskKey}.
 * @returns The matching Work Item, or undefined when no match exists.
 */
export function findWorkspaceTaskByKey(tasks: readonly ProjectTask[], taskKey: string) {
  return tasks.find((task) => createWorkspaceTaskKey(task) === taskKey)
}

/**
 * Immutably replaces the workflow status of a specified Work Item.
 *
 * @param tasks - Workspace Work Items containing the update target.
 * @param targetTask - Work Item to update.
 * @param status - Next workflow status.
 * @param expectedCurrentStatusId - Current status ID required to apply the optimistic update.
 * @returns A new array with the target Work Item's status updated.
 */
export function updateWorkspaceTaskStatus(
  tasks: readonly ProjectTask[],
  targetTask: ProjectTask,
  status: WorkflowStatusDefinition,
  expectedCurrentStatusId?: string,
) {
  const targetTaskKey = createWorkspaceTaskKey(targetTask)

  return tasks.map((task): ProjectTask =>
    createWorkspaceTaskKey(task) === targetTaskKey &&
    (expectedCurrentStatusId === undefined || task.workflowStatusId === expectedCurrentStatusId)
      ? {
          ...task,
          statusCategory: status.category,
          workflowStatusId: status.id,
        }
      : task,
  )
}

/**
 * Replaces a Workspace Work Item with the canonical response for the same identity.
 *
 * @param tasks - Work Items containing the update target.
 * @param updatedTask - Updated Work Item returned by the API.
 * @returns A new array with the target Work Item replaced.
 */
export function replaceWorkspaceTask<TTask extends ProjectTask>(
  tasks: readonly TTask[],
  updatedTask: ProjectTask,
) {
  const updatedTaskKey = createWorkspaceTaskKey(updatedTask)

  return tasks.map((task): TTask =>
    createWorkspaceTaskKey(task) === updatedTaskKey
      ? {
          ...task,
          ...updatedTask,
        }
      : task,
  )
}

/**
 * Creates Workspace Kanban columns from Work Items and Team configurations.
 *
 * @param tasks - Work Items displayed in the Kanban board.
 * @param configurationsByTeam - Resolved configurations keyed by Team ID.
 * @param teams - Directory used to resolve Team names.
 * @returns Columns grouped by Team and workflow status.
 */
export function createWorkspaceTaskStatusColumns(
  tasks: readonly ProjectTask[],
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  teams: readonly ProjectDirectoryTeam[],
): WorkspaceTaskStatusColumn[] {
  const taskTeamIds = Array.from(new Set(tasks.map((task) => task.teamId))).sort()
  const showTeamName = taskTeamIds.length > 1

  return taskTeamIds.flatMap((teamId) => {
    const configuration = configurationsByTeam[teamId]?.configuration

    if (!configuration) {
      return []
    }

    const teamName = teams.find((team) => team.id === teamId)?.name ?? teamId

    return [...configuration.workflow.statuses]
      .sort((first, second) =>
        first.sortOrder - second.sortOrder || first.name.localeCompare(second.name)
      )
      .map((status) => ({
        key: `${teamId}:${status.id}`,
        label: showTeamName ? `${teamName} · ${status.name}` : status.name,
        status,
        teamId,
      }))
  })
}

/**
 * Determines whether a Work Item belongs to a Workspace Kanban column.
 *
 * @param task - Work Item to evaluate.
 * @param column - Column to evaluate.
 * @returns True when both the Team and status match.
 */
export function isTaskInWorkspaceStatusColumn(
  task: ProjectTask,
  column: WorkspaceTaskStatusColumn,
) {
  return column.teamId === task.teamId && column.status.id === task.workflowStatusId
}

/**
 * Filters Work Items assigned to specified Projects.
 *
 * @param tasks - Work Items to filter.
 * @param projectIds - Target Project IDs.
 * @returns Work Items assigned to the specified Projects.
 */
export function filterTasksByProjectIds(
  tasks: readonly ProjectTask[],
  projectIds: readonly string[],
) {
  const projectIdSet = new Set(projectIds)

  if (projectIdSet.size === 0) {
    return []
  }

  return tasks.filter((task) => Boolean(
    task.assignedProjectId && projectIdSet.has(task.assignedProjectId),
  ))
}

/**
 * Filters Work Items that belong to specified Team and Project scopes.
 *
 * @param tasks - Work Items to filter.
 * @param projectIds - Target Project IDs.
 * @param teamId - Optional target Team ID.
 * @returns Work Items that match the Team and Project scopes.
 */
export function filterTasksByTeamProjectIds(
  tasks: readonly ProjectTask[],
  projectIds: readonly string[],
  teamId?: string,
) {
  return filterTasksByProjectIds(tasks, projectIds).filter(
    (task) => !teamId || !task.teamId || task.teamId === teamId,
  )
}

/**
 * Aggregates Workspace summary values from the directory and Work Items.
 *
 * @param teams - Workspace directory.
 * @param tasks - Workspace Work Items.
 * @param blockedCount - Count derived from active canonical relation/dependency signals.
 * @returns Project, incomplete, and attention counts.
 */
export function createWorkspaceSummary(
  teams: readonly ProjectDirectoryTeam[],
  tasks: readonly ProjectTask[],
  blockedCount: number,
): WorkspaceSummary {
  return {
    projects: countWorkspaceProjects(teams),
    tasks: tasks.filter((task) => isOpenWorkItem(task)).length,
    blocked: blockedCount,
  }
}

/**
 * Counts unique Project IDs in a Workspace directory.
 *
 * @param teams - Workspace Team and Project directory.
 * @returns The number of distinct Project IDs.
 */
export function countWorkspaceProjects(teams: readonly ProjectDirectoryTeam[]) {
  return getUniqueWorkspaceProjectIds(teams).length
}

/**
 * Returns unique Project IDs from a Workspace directory.
 *
 * @param teams - Workspace Team and Project directory.
 * @returns Distinct Project IDs in first-seen directory order.
 */
export function getUniqueWorkspaceProjectIds(
  teams: readonly ProjectDirectoryTeam[],
) {
  return Array.from(new Set(
    teams.flatMap((team) => team.projects.map((project) => project.id)),
  ))
}

/**
 * Orders Workspace Work Items by action priority and due date.
 *
 * @param tasks - Work Items to order.
 * @param referenceDate - Reference date used to determine overdue status.
 * @returns A new Work Item array ordered by action priority.
 */
export function createWorkspaceActionQueue(
  tasks: readonly ProjectTask[],
  referenceDate: Date,
) {
  return [...tasks]
    .filter((task) => isOpenWorkItem(task) || hasApprovalAttention(task))
    .sort((firstTask, secondTask) => {
      const firstScore = calculateWorkspaceActionScore(firstTask, referenceDate)
      const secondScore = calculateWorkspaceActionScore(secondTask, referenceDate)

      if (firstScore !== secondScore) {
        return secondScore - firstScore
      }

      return getWorkspaceDueTime(firstTask) - getWorkspaceDueTime(secondTask)
    })
}

/**
 * Determines whether a Work Item has the review workflow status.
 *
 * @param task - Work Item to evaluate.
 * @returns True when the workflow status ID is review.
 */
export function isWorkspaceTaskInReview(task: ProjectTask) {
  return resolveWorkItemWorkflowStatusId(task) === 'review'
}

/**
 * Determines whether a Work Item is assigned to one of the current user's identities.
 *
 * @param task - Work Item to evaluate.
 * @param userIdentityAliases - Candidate identities such as username, email, or subject.
 * @returns True when a normalized assignee value matches an identity.
 */
export function isWorkspaceTaskAssignedToUser(
  task: ProjectTask,
  userIdentityAliases: readonly string[],
) {
  const normalizedUserAliases = new Set(
    userIdentityAliases.map(normalizeWorkspaceSearchText).filter(Boolean),
  )

  return normalizedUserAliases.size > 0 && [
    task.assigneeUserId,
    task.assigneeEmail,
  ].some((value) => normalizedUserAliases.has(normalizeWorkspaceSearchText(value)))
}

/**
 * Resolves a Work Item's Project display name from the directory.
 *
 * @param task - Work Item whose Project name to resolve.
 * @param teams - Workspace directory.
 * @returns The Project name, preferring a match within the Team scope.
 */
export function resolveWorkspaceProjectName(
  task: ProjectTask,
  teams: readonly ProjectDirectoryTeam[],
) {
  const scopedTeam = task.teamId
    ? teams.find((team) => team.id === task.teamId)
    : undefined
  const scopedProject = scopedTeam?.projects.find(
    (project) => project.id === task.assignedProjectId,
  )

  if (scopedProject) {
    return scopedProject.name
  }

  return teams
    .flatMap((team) => team.projects)
    .find((project) => project.id === task.assignedProjectId)?.name ??
      task.assignedProjectId ??
      '-'
}

/**
 * Calculates the action-priority score for a Workspace queue item.
 *
 * @param task - Work Item for which to calculate the score.
 * @param referenceDate - Reference date used to determine overdue status.
 * @returns A score weighted by due date, approval, priority, and review status.
 */
export function calculateWorkspaceActionScore(task: ProjectTask, referenceDate: Date) {
  return (isWorkspaceTaskOverdue(task, referenceDate) ? 8 : 0) +
    ((task.approvalSummary?.overdueCount ?? 0) > 0 ? 8 : 0) +
    (hasApprovalAttention(task) ? 4 : 0) +
    (task.priority === 'high' ? 5 : task.priority === 'medium' ? 2 : 0) +
    (isWorkspaceTaskInReview(task) ? 4 : 0)
}

/**
 * Determines whether a Work Item route can be opened from the Workspace queue.
 *
 * @param task - Work Item to evaluate.
 * @returns True when the Team ID required by the route is available.
 */
export function isOpenableWorkspaceTask(task: ProjectTask) {
  return Boolean(task.teamId)
}

/**
 * Determines whether a Work Item has pending or overdue approvals.
 *
 * @param task - Work Item to evaluate.
 * @returns True when the approval summary requires attention.
 */
export function hasApprovalAttention(task: ProjectTask) {
  const summary = task.approvalSummary

  return Boolean(summary && (
    summary.pendingCount > 0 ||
    summary.overdueCount > 0
  ))
}

/**
 * Determines whether an incomplete Work Item is due before the reference date.
 *
 * @param task - Work Item to evaluate.
 * @param referenceDate - Reference date used to determine overdue status.
 * @returns True when the Work Item is incomplete and overdue.
 */
export function isWorkspaceTaskOverdue(task: ProjectTask, referenceDate: Date) {
  const dueDate = deriveWorkItemScheduleDueDate(task.schedule)

  if (!isOpenWorkItem(task) || !parseWorkspaceTaskDueDate(dueDate)) {
    return false
  }

  const today = taskScheduleInstantToLocalDate(
    referenceDate,
    task.schedule.calendarPolicy,
  )

  return dueDate < today
}

/**
 * Parses a Work Item's canonical ISO due-date projection as a local date.
 *
 * @param value - Work Item due-date string.
 * @returns The parsed date, or null when the value is invalid.
 */
export function parseWorkspaceTaskDueDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)

  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }

  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)

  return date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    ? date
    : null
}

/**
 * Calculates the percentage of completed Work Items.
 *
 * @param tasks - Work Items to aggregate.
 * @returns An integer from 0 through 100.
 */
export function calculateWorkspaceProgress(tasks: readonly ProjectTask[]) {
  if (tasks.length === 0) {
    return 0
  }

  return Math.round(
    (tasks.filter((task) => isCompletedWorkItem(task)).length / tasks.length) * 100,
  )
}

/**
 * Resolves portfolio risk from a Project's Work Items.
 *
 * @param tasks - Work Items within the Project scope.
 * @returns The risk level representing high-priority open work, full completion, or neither.
 */
export function resolveWorkspacePortfolioRisk(
  tasks: readonly ProjectTask[],
): WorkspacePortfolioProject['risk'] {
  if (tasks.some((task) => task.priority === 'high' && isOpenWorkItem(task))) {
    return 'watch'
  }

  if (tasks.length > 0 && tasks.every((task) => isCompletedWorkItem(task))) {
    return 'low'
  }

  return 'clear'
}

/**
 * Creates portfolio rows from the Workspace directory and Work Items.
 *
 * @param teams - Workspace directory.
 * @param tasks - Workspace Work Items.
 * @returns Project portfolio rows grouped by Team.
 */
export function createWorkspacePortfolioProjects(
  teams: readonly ProjectDirectoryTeam[],
  tasks: readonly ProjectTask[],
): WorkspacePortfolioProject[] {
  return teams.flatMap((team) =>
    team.projects.map((project) => {
      const projectTasks = filterTasksByTeamProjectIds(tasks, [project.id], team.id)

      return {
        progress: calculateWorkspaceProgress(projectTasks),
        id: `${team.id}-${project.id}`,
        name: project.name,
        teamName: team.name,
        risk: resolveWorkspacePortfolioRisk(projectTasks),
      }
    }),
  )
}

/**
 * Determines whether a Work Item counts as requiring attention in a Team summary.
 *
 * @param task - Work Item to evaluate.
 * @param referenceDate - Reference date used to determine overdue status.
 * @returns True when the Work Item is incomplete and either high priority or overdue.
 */
export function isAttentionWorkspaceTask(task: ProjectTask, referenceDate: Date) {
  return isOpenWorkItem(task) && (
    task.priority === 'high' || isWorkspaceTaskOverdue(task, referenceDate)
  )
}

/**
 * Normalizes text for case-insensitive Workspace identity comparisons.
 *
 * @param value - Optional text to normalize.
 * @returns Trimmed lowercase text, or an empty string when absent.
 */
function normalizeWorkspaceSearchText(value?: string) {
  return value?.trim().toLocaleLowerCase() ?? ''
}

/**
 * Resolves a sortable due-time value for a Workspace Work Item.
 *
 * @param task - Work Item whose due time to resolve.
 * @returns The due date in milliseconds, or the maximum safe integer when invalid.
 */
function getWorkspaceDueTime(task: ProjectTask) {
  return parseWorkspaceTaskDueDate(
    deriveWorkItemScheduleDueDate(task.schedule),
  )?.getTime() ?? Number.MAX_SAFE_INTEGER
}
