import type { ProjectDirectoryTeam } from '../api/directory'
import type { ProjectTask } from '../../tasks/api/tasks'
import {
  isOpenWorkItem,
  resolveWorkItemAssignee,
} from '../../work-items/model/workItemDisplay'

/** Number of Project rows rendered on one directory page. */
export const PROJECT_DIRECTORY_PAGE_SIZE = 50

/** Stable filters supported by the Project directory URL. */
export type ProjectDirectoryFilters = {
  /** Case-insensitive search applied to Project, Team, and assignee labels. */
  query: string
  /** Optional Team ID used to restrict the directory. */
  teamId?: string
  /** Project lifecycle state used to restrict the directory. */
  status: ProjectDirectoryStatusFilter
  /** Optional assignee ID, or the unassigned sentinel. */
  assigneeId?: string
  /** Whether only starred Projects are included. */
  quickAccessOnly: boolean
}

/** Project lifecycle values available in the directory filter. */
export type ProjectDirectoryStatus =
  | 'active'
  | 'attention'
  | 'completed'
  | 'not-started'

/** Project lifecycle filter values including the unfiltered state. */
export type ProjectDirectoryStatusFilter = 'all' | ProjectDirectoryStatus

/** Assignee identity displayed and filtered in the Project directory. */
export type ProjectDirectoryAssignee = {
  /** Stable Workspace user ID used by the URL filter. */
  id: string
  /** Best available name, email address, or ID displayed to the user. */
  label: string
}

/** One derived Project row displayed in the searchable directory. */
export type ProjectDirectoryRow = {
  /** Stable key composed from the owning Team and Project IDs. */
  key: string
  /** Project ID used by the Project issue route. */
  projectId: string
  /** Project name displayed as the row's primary action. */
  projectName: string
  /** Optional Project color inherited from the directory. */
  tone?: 'blue' | 'purple' | 'green' | 'yellow'
  /** ID of the Team that owns the Project. */
  teamId: string
  /** Name of the Team that owns the Project. */
  teamName: string
  /** Derived Project lifecycle state. */
  status: ProjectDirectoryStatus
  /** Percentage of closed Work Items, normalized from zero through one hundred. */
  progress: number
  /** Number of incomplete Work Items assigned to the Project. */
  openWorkItemCount: number
  /** Total number of Work Items assigned to the Project. */
  workItemCount: number
  /** Unique assignees represented by the Project's Work Items. */
  assignees: ProjectDirectoryAssignee[]
  /** Whether the Project is currently shown in quick access. */
  isQuickAccess: boolean
}

/** One page of filtered Project directory rows. */
export type ProjectDirectoryPage = {
  /** One-based page number after clamping to the available range. */
  page: number
  /** Total number of pages, with a minimum of one. */
  pageCount: number
  /** Rows rendered for the current page. */
  rows: ProjectDirectoryRow[]
}

/** Sentinel used to represent Projects without an assigned person. */
export const PROJECT_DIRECTORY_UNASSIGNED_ID = 'unassigned'

/**
 * Creates a collision-resistant key for one Team-owned Project.
 *
 * @param teamId - ID of the owning Team.
 * @param projectId - ID of the Project.
 * @returns A key that preserves Team identity when Project IDs are duplicated.
 */
export function createProjectDirectoryRowKey(teamId: string, projectId: string) {
  return `${teamId}\u0000${projectId}`
}

/**
 * Derives searchable Project rows from the directory and canonical Work Items.
 *
 * @param teams - Permission-filtered Team and Project directory.
 * @param tasks - Canonical Work Items loaded for the Workspace.
 * @param isProjectQuickAccess - Predicate that recognizes starred Project IDs.
 * @returns Project rows in the stable Team and Project order supplied by the directory.
 */
export function createProjectDirectoryRows(
  teams: readonly ProjectDirectoryTeam[],
  tasks: readonly ProjectTask[],
  isProjectQuickAccess: (projectId: string) => boolean = () => false,
): ProjectDirectoryRow[] {
  const tasksByProject = new Map<string, ProjectTask[]>()

  for (const task of tasks) {
    if (!task.assignedProjectId) {
      continue
    }

    const key = createProjectDirectoryRowKey(task.teamId, task.assignedProjectId)
    const projectTasks = tasksByProject.get(key)
    if (projectTasks) {
      projectTasks.push(task)
    } else {
      tasksByProject.set(key, [task])
    }
  }

  return teams.flatMap((team) =>
    team.projects.map((project): ProjectDirectoryRow => {
      const projectTasks = tasksByProject.get(
        createProjectDirectoryRowKey(team.id, project.id),
      ) ?? []
      const closedWorkItemCount = projectTasks.filter(
        (task) => !isOpenWorkItem(task),
      ).length
      const openWorkItemCount = projectTasks.length - closedWorkItemCount

      return {
        assignees: createProjectAssignees(projectTasks),
        isQuickAccess: isProjectQuickAccess(project.id),
        key: createProjectDirectoryRowKey(team.id, project.id),
        openWorkItemCount,
        progress: projectTasks.length === 0
          ? 0
          : Math.round((closedWorkItemCount / projectTasks.length) * 100),
        projectId: project.id,
        projectName: project.name,
        status: resolveProjectDirectoryStatus(projectTasks),
        teamId: team.id,
        teamName: team.name,
        tone: project.tone,
        workItemCount: projectTasks.length,
      }
    }),
  )
}

/**
 * Resolves a Project lifecycle state from its canonical Work Items.
 *
 * @param tasks - Work Items scoped to one Team-owned Project.
 * @returns Attention, active, completed, or not-started state.
 */
export function resolveProjectDirectoryStatus(
  tasks: readonly ProjectTask[],
): ProjectDirectoryStatus {
  if (tasks.length === 0) {
    return 'not-started'
  }

  if (tasks.some((task) => task.priority === 'high' && isOpenWorkItem(task))) {
    return 'attention'
  }

  if (tasks.every((task) => !isOpenWorkItem(task))) {
    return 'completed'
  }

  return 'active'
}

/**
 * Filters Project directory rows using URL-backed search and facets.
 *
 * @param rows - Complete derived Project directory.
 * @param filters - Search query and selected filter values.
 * @returns Rows matching every active filter while preserving input order.
 */
export function filterProjectDirectoryRows(
  rows: readonly ProjectDirectoryRow[],
  filters: ProjectDirectoryFilters,
) {
  const normalizedQuery = normalizeProjectDirectoryText(filters.query)

  return rows.filter((row) => {
    if (filters.teamId && row.teamId !== filters.teamId) {
      return false
    }

    if (filters.status !== 'all' && row.status !== filters.status) {
      return false
    }

    if (filters.quickAccessOnly && !row.isQuickAccess) {
      return false
    }

    if (filters.assigneeId) {
      const matchesAssignee = filters.assigneeId === PROJECT_DIRECTORY_UNASSIGNED_ID
        ? row.assignees.length === 0
        : row.assignees.some((assignee) => assignee.id === filters.assigneeId)
      if (!matchesAssignee) {
        return false
      }
    }

    if (!normalizedQuery) {
      return true
    }

    const searchText = [
      row.projectName,
      row.teamName,
      ...row.assignees.map((assignee) => assignee.label),
    ].map(normalizeProjectDirectoryText).join('\n')

    return searchText.includes(normalizedQuery)
  })
}

/**
 * Collects unique assignee choices from Project rows.
 *
 * @param rows - Project rows from which to collect people.
 * @returns Assignees sorted by display label and then stable ID.
 */
export function createProjectDirectoryAssigneeOptions(
  rows: readonly ProjectDirectoryRow[],
) {
  const assigneesById = new Map<string, ProjectDirectoryAssignee>()
  let hasUnassignedProjects = false

  for (const row of rows) {
    if (row.assignees.length === 0) {
      hasUnassignedProjects = true
    }
    for (const assignee of row.assignees) {
      assigneesById.set(assignee.id, assignee)
    }
  }

  const assignees = Array.from(assigneesById.values()).sort(
    (first, second) =>
      first.label.localeCompare(second.label) || first.id.localeCompare(second.id),
  )

  return {
    assignees,
    hasUnassignedProjects,
  }
}

/**
 * Returns one bounded page of Project directory rows.
 *
 * @param rows - Filtered Project rows.
 * @param requestedPage - Requested one-based page number.
 * @param pageSize - Maximum rows shown on one page.
 * @returns Clamped pagination metadata and rows.
 */
export function paginateProjectDirectoryRows(
  rows: readonly ProjectDirectoryRow[],
  requestedPage: number,
  pageSize = PROJECT_DIRECTORY_PAGE_SIZE,
): ProjectDirectoryPage {
  const safePageSize = Math.max(1, Math.floor(pageSize))
  const pageCount = Math.max(1, Math.ceil(rows.length / safePageSize))
  const page = Math.min(pageCount, Math.max(1, Math.floor(requestedPage)))
  const startIndex = (page - 1) * safePageSize

  return {
    page,
    pageCount,
    rows: rows.slice(startIndex, startIndex + safePageSize),
  }
}

/**
 * Parses an optional page query value into a safe one-based number.
 *
 * @param value - Raw value read from the URL.
 * @returns A positive integer, or one for missing and invalid input.
 */
export function parseProjectDirectoryPage(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value)) {
    return 1
  }

  const page = Number(value)
  return Number.isSafeInteger(page) && page > 0 ? page : 1
}

/**
 * Collects one Project's unique assignees in stable Work Item order.
 *
 * @param tasks - Work Items scoped to one Project.
 * @returns Unique person references suitable for display and filtering.
 */
function createProjectAssignees(
  tasks: readonly ProjectTask[],
): ProjectDirectoryAssignee[] {
  const assigneesById = new Map<string, ProjectDirectoryAssignee>()

  for (const task of tasks) {
    const id = task.assigneeUserId.trim()
    if (!id || assigneesById.has(id)) {
      continue
    }
    assigneesById.set(id, {
      id,
      label: resolveWorkItemAssignee(task),
    })
  }

  return Array.from(assigneesById.values())
}

/**
 * Normalizes Project directory search text for case-insensitive matching.
 *
 * @param value - User-entered or directory-owned display text.
 * @returns Trimmed locale-aware lowercase text.
 */
function normalizeProjectDirectoryText(value: string) {
  return value.trim().toLocaleLowerCase()
}
