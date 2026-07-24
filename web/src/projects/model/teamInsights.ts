import type { ProjectTask } from '../../tasks/api'
import {
  createWorkspaceActionQueue,
  filterTasksByTeamProjectIds,
  isAttentionWorkspaceTask,
  isWorkspaceTaskInReview,
  calculateWorkspaceProgress,
  parseWorkspaceTaskDueDate,
} from '../../work-items/model/workspaceWorkItems'
import { isOpenWorkItem } from '../../work-items/model/workItemDisplay'
import type {
  ProjectDirectoryProject,
  ProjectMember,
  ProjectMemberRole,
} from '../api'

/**
 * Describes a member's access retrieved from a Project within a Team.
 */
export type TeamProjectMemberAccess = {
  /** ID of the Project to which the member belongs. */
  projectId: string
  /** Name of the Project to which the member belongs. */
  projectName: string
  /** Member record retrieved from the Project API. */
  member: ProjectMember
}

/**
 * Describes a Project summary row compared in the Team overview table.
 */
export type TeamProjectSummary = {
  /** Project ID. */
  id: string
  /** Project name. */
  name: string
  /** Progress represented as the percentage of completed Work Items. */
  progress: number
  /** Number of incomplete Work Items. */
  openTaskCount: number
  /** Number of Work Items in review status. */
  reviewTaskCount: number
  /** Number of high-priority or overdue Work Items. */
  attentionTaskCount: number
  /** Number of Project members. */
  memberCount: number
  /** Number of members with the manager role. */
  managerCount: number
  /** Next Work Item to open. */
  nextTask?: ProjectTask
}

/**
 * Defines the role filter used by the Team member view.
 */
export type TeamMemberRoleFilter = ProjectMemberRole | 'all'

/**
 * Describes a Project and role associated with a Team member.
 */
export type TeamMemberProjectAccess = {
  /** ID of the participating Project. */
  projectId: string
  /** Name of the participating Project. */
  projectName: string
  /** Member's role within the Project. */
  role: ProjectMemberRole
}

/**
 * Describes an aggregate row displayed in the Team member directory.
 */
export type TeamMemberRow = {
  /** Member key that identifies the row. */
  id: string
  /** Member name displayed in the interface. */
  name: string
  /** Member email address. */
  email: string
  /** Strongest member role across all associated Projects. */
  role?: ProjectMemberRole
  /** Roles for each participating Project. */
  projectAccess: TeamMemberProjectAccess[]
  /** Number of assigned Work Items. */
  taskCount: number
  /** Number of incomplete assigned Work Items. */
  openTaskCount: number
  /** Number of assigned Work Items in review status. */
  reviewTaskCount: number
  /** Number of assigned high-priority or overdue Work Items. */
  attentionTaskCount: number
  /** Percentage of assigned Work Items that are incomplete. */
  openPercent: number
  /** Earliest due date among assigned Work Items. */
  nextDueDate?: string
}

/**
 * Creates Project summary rows for the Team overview.
 *
 * @param projects - Projects within the Team.
 * @param tasks - Workspace Work Items.
 * @param teamProjectMembers - Members with their associated Project details.
 * @param referenceDate - Reference date used to determine overdue status.
 * @param teamId - Optional ID of the Team to aggregate.
 * @returns Project summary rows preserving directory order.
 */
export function createTeamProjectSummaries(
  projects: readonly ProjectDirectoryProject[],
  tasks: readonly ProjectTask[],
  teamProjectMembers: readonly TeamProjectMemberAccess[],
  referenceDate: Date,
  teamId?: string,
): TeamProjectSummary[] {
  const membersByProjectId = new Map<string, TeamProjectMemberAccess[]>()

  for (const access of teamProjectMembers) {
    membersByProjectId.set(access.projectId, [
      ...(membersByProjectId.get(access.projectId) ?? []),
      access,
    ])
  }

  return projects.map((project) => {
    const projectTasks = filterTasksByTeamProjectIds(tasks, [project.id], teamId)
    const projectMembers = membersByProjectId.get(project.id) ?? []
    const memberIds = new Set(
      projectMembers.map((access) => createProjectMemberIdentity(access.member)),
    )
    const managerIds = new Set(
      projectMembers
        .filter((access) => access.member.role === 'manager')
        .map((access) => createProjectMemberIdentity(access.member)),
    )

    return {
      attentionTaskCount: projectTasks.filter((task) =>
        isAttentionWorkspaceTask(task, referenceDate)
      ).length,
      id: project.id,
      managerCount: managerIds.size,
      memberCount: memberIds.size,
      name: project.name,
      nextTask: createWorkspaceActionQueue(projectTasks, referenceDate)[0],
      openTaskCount: projectTasks.filter((task) => isOpenWorkItem(task)).length,
      progress: calculateWorkspaceProgress(projectTasks),
      reviewTaskCount: projectTasks.filter(isWorkspaceTaskInReview).length,
    }
  })
}

/**
 * Counts unique member identities across multiple Projects.
 *
 * @param teamProjectMembers - Members with their associated Project details.
 * @returns The number of unique Team members.
 */
export function countUniqueTeamMembers(
  teamProjectMembers: readonly TeamProjectMemberAccess[],
) {
  return new Set(
    teamProjectMembers.map((access) => createProjectMemberIdentity(access.member)),
  ).size
}

/**
 * Aggregates Project members and assigned Work Items into Team member directory rows.
 *
 * @param projects - Projects within the Team.
 * @param tasks - Workspace Work Items.
 * @param teamProjectMembers - Members with their associated Project details.
 * @param referenceDate - Reference date used to determine overdue status.
 * @param teamId - Optional ID of the Team to aggregate.
 * @returns Member rows combining roles, Project access, and workload.
 */
export function createTeamMemberRows(
  projects: readonly ProjectDirectoryProject[],
  tasks: readonly ProjectTask[],
  teamProjectMembers: readonly TeamProjectMemberAccess[],
  referenceDate: Date,
  teamId?: string,
): TeamMemberRow[] {
  const projectOrder = new Map(projects.map((project, index) => [project.id, index]))
  const projectIds = projects.map((project) => project.id)
  const rowsByMemberId = new Map<string, TeamMemberRow>()

  for (const access of teamProjectMembers) {
    const memberId = createProjectMemberIdentity(access.member)
    const row = rowsByMemberId.get(memberId) ?? createTeamMemberRow(access.member)
    const existingProjectAccess = row.projectAccess.find(
      (project) => project.projectId === access.projectId,
    )

    row.role = selectStrongerProjectMemberRole(row.role, access.member.role)

    if (existingProjectAccess) {
      existingProjectAccess.role = selectStrongerProjectMemberRole(
        existingProjectAccess.role,
        access.member.role,
      )
    } else {
      row.projectAccess.push({
        projectId: access.projectId,
        projectName: access.projectName,
        role: access.member.role,
      })
    }

    rowsByMemberId.set(memberId, row)
  }

  const memberAliases = createTeamMemberAliasMap(rowsByMemberId)
  const tasksByMemberId = new Map<string, ProjectTask[]>()

  for (const task of filterTasksByTeamProjectIds(tasks, projectIds, teamId)) {
    const memberId = resolveTaskMemberId(task, memberAliases)
    const row = memberId ? rowsByMemberId.get(memberId) : undefined

    if (
      !row ||
      !task.assignedProjectId ||
      !row.projectAccess.some((project) => project.projectId === task.assignedProjectId)
    ) {
      continue
    }

    tasksByMemberId.set(row.id, [...(tasksByMemberId.get(row.id) ?? []), task])
  }

  return Array.from(rowsByMemberId.values())
    .map((row) => {
      const memberTasks = tasksByMemberId.get(row.id) ?? []
      const openTasks = memberTasks.filter((task) => isOpenWorkItem(task))
      const openTaskCount = openTasks.length
      const nextDueDate = openTasks
        .map((task) => task.dueDate)
        .filter((dueDate) => parseWorkspaceTaskDueDate(dueDate) !== null)
        .sort((firstDate, secondDate) => firstDate.localeCompare(secondDate))[0]

      return {
        ...row,
        attentionTaskCount: memberTasks.filter((task) =>
          isAttentionWorkspaceTask(task, referenceDate)
        ).length,
        openPercent: Math.round((openTaskCount / Math.max(1, memberTasks.length)) * 100),
        nextDueDate,
        openTaskCount,
        projectAccess: row.projectAccess.sort(
          (firstProject, secondProject) =>
            (projectOrder.get(firstProject.projectId) ?? Number.MAX_SAFE_INTEGER) -
              (projectOrder.get(secondProject.projectId) ?? Number.MAX_SAFE_INTEGER) ||
            firstProject.projectName.localeCompare(secondProject.projectName),
        ),
        reviewTaskCount: memberTasks.filter(isWorkspaceTaskInReview).length,
        taskCount: memberTasks.length,
      }
    })
    .sort(
      (firstMember, secondMember) =>
        secondMember.openTaskCount - firstMember.openTaskCount ||
        getProjectMemberRoleWeight(secondMember.role) -
          getProjectMemberRoleWeight(firstMember.role) ||
        firstMember.name.localeCompare(secondMember.name),
    )
}

/**
 * Validates that a form select value is a Team member role filter.
 *
 * @param value - String received from the select element.
 * @returns True when the value is an allowed filter.
 */
export function isTeamMemberRoleFilter(value: string): value is TeamMemberRoleFilter {
  return value === 'all' || value === 'manager' || value === 'member' || value === 'viewer'
}

/**
 * Creates an empty aggregate row for a Project member.
 *
 * @param member - Project member from which to initialize the row.
 * @returns A Team member row with zeroed workload values.
 */
function createTeamMemberRow(member: ProjectMember): TeamMemberRow {
  return {
    attentionTaskCount: 0,
    email: member.email,
    id: createProjectMemberIdentity(member),
    openPercent: 0,
    name: member.name?.trim() || member.email || member.id,
    openTaskCount: 0,
    projectAccess: [],
    reviewTaskCount: 0,
    role: member.role,
    taskCount: 0,
  }
}

/**
 * Creates a lookup from normalized member aliases to canonical member IDs.
 *
 * @param rowsByMemberId - Team member rows keyed by canonical member ID.
 * @returns Normalized aliases mapped to their canonical member IDs.
 */
function createTeamMemberAliasMap(rowsByMemberId: Map<string, TeamMemberRow>) {
  const aliases = new Map<string, string>()

  for (const row of rowsByMemberId.values()) {
    for (const value of [row.id, row.email, row.name]) {
      const alias = normalizeTeamMemberAlias(value)

      if (alias) {
        aliases.set(alias, row.id)
      }
    }
  }

  return aliases
}

/**
 * Resolves the canonical member ID assigned to a Work Item.
 *
 * @param task - Work Item whose assignee to resolve.
 * @param memberAliases - Normalized member aliases keyed to canonical member IDs.
 * @returns The matching member ID, or undefined when no alias matches.
 */
function resolveTaskMemberId(
  task: ProjectTask,
  memberAliases: ReadonlyMap<string, string>,
) {
  const taskAliases = [
    task.assigneeUserId,
    task.assigneeEmail,
    task.assigneeName,
  ]

  for (const value of taskAliases) {
    const memberId = memberAliases.get(normalizeTeamMemberAlias(value))

    if (memberId) {
      return memberId
    }
  }

  return undefined
}

/**
 * Creates a normalized identity for a Project member.
 *
 * @param member - Project member for which to create an identity.
 * @returns A normalized member ID or email, with the original value as fallback.
 */
function createProjectMemberIdentity(member: ProjectMember) {
  return normalizeTeamMemberAlias(member.id || member.email) || member.id || member.email
}

/**
 * Normalizes a Team member alias for case-insensitive comparison.
 *
 * @param value - Optional alias to normalize.
 * @returns Trimmed lowercase text, or an empty string when absent.
 */
function normalizeTeamMemberAlias(value?: string) {
  return value?.trim().toLowerCase() ?? ''
}

/**
 * Selects the stronger of two Project member roles.
 *
 * @param currentRole - Existing Project member role, when available.
 * @param nextRole - Candidate Project member role.
 * @returns The role with the greater permission weight.
 */
function selectStrongerProjectMemberRole(
  currentRole: ProjectMemberRole | undefined,
  nextRole: ProjectMemberRole,
) {
  return getProjectMemberRoleWeight(nextRole) > getProjectMemberRoleWeight(currentRole)
    ? nextRole
    : currentRole ?? nextRole
}

/**
 * Returns the comparison weight for a Project member role.
 *
 * @param role - Optional Project member role.
 * @returns The role's comparison weight, or zero when absent.
 */
function getProjectMemberRoleWeight(role?: ProjectMemberRole) {
  const roleWeights: Record<ProjectMemberRole, number> = {
    manager: 3,
    member: 2,
    viewer: 1,
  }

  return role ? roleWeights[role] : 0
}
