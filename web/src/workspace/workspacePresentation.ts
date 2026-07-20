import type { DashboardSummary } from '../auth/api'
import type { MessageKey } from '../i18n'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../issues/workItemDisplay'
import {
  type ProjectDirectoryProject,
  type ProjectDirectoryTeam,
  type ProjectMember,
  type ProjectMemberRole,
} from '../projects/api'
import type {
  ProjectTask,
  TaskPriority,
  TaskStatus,
} from '../tasks/api'
import type {
  TeamMemberRow,
  TeamProjectMemberAccess,
  TeamProjectSummary,
} from './workspaceTypes'

const myTaskKanbanStatuses = ['todo', 'in-progress', 'review', 'done'] as const satisfies readonly TaskStatus[]

function findActiveTeam(teams: ProjectDirectoryTeam[], activeTeamId?: string) {
  if (activeTeamId) {
    return teams.find((team) => team.id === activeTeamId)
  }

  return teams[0]
}

function isLegacyWorkspaceTask(task: ProjectTask) {
  return task.source === 'legacy'
}

function uniqueProjectIds(teams: ProjectDirectoryTeam[]) {
  return Array.from(
    new Set(teams.flatMap((team) => team.projects.map((project) => project.id))),
  )
}

function createWorkspaceTaskKey(task: ProjectTask) {
  return `${task.teamId}:${task.assignedProjectId ?? ''}:${task.id}`
}

function createWorkspaceTaskTestId(task: ProjectTask) {
  return createWorkspaceTaskTestToken(`${task.assignedProjectId ?? 'unassigned'}:${task.id}`)
}

function createWorkspaceTaskTestToken(value: string) {
  return value.replaceAll(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

function readMyTaskKanbanStatus(value: string) {
  return myTaskKanbanStatuses.find((status) => status === value)
}

function findWorkspaceTaskByKey(tasks: ProjectTask[], taskKey: string) {
  return tasks.find((task) => createWorkspaceTaskKey(task) === taskKey)
}

function updateWorkspaceTaskStatus<TTask extends ProjectTask>(
  tasks: TTask[],
  targetTask: ProjectTask,
  status: TaskStatus,
  expectedCurrentStatus?: TaskStatus,
) {
  const targetTaskKey = createWorkspaceTaskKey(targetTask)

  return tasks.map((task): TTask =>
    createWorkspaceTaskKey(task) === targetTaskKey &&
    (expectedCurrentStatus === undefined || task.status === expectedCurrentStatus)
      ? {
          ...task,
          status,
        }
      : task,
  )
}

function replaceWorkspaceTask<TTask extends ProjectTask>(
  tasks: TTask[],
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

function filterTasksByProjectIds(tasks: ProjectTask[], projectIds: readonly string[]) {
  const projectIdSet = new Set(projectIds)

  if (projectIdSet.size === 0) {
    return []
  }

  return tasks.filter((task) => Boolean(
    task.assignedProjectId && projectIdSet.has(task.assignedProjectId),
  ))
}

function filterTasksByTeamProjectIds(
  tasks: ProjectTask[],
  projectIds: readonly string[],
  teamId?: string,
) {
  return filterTasksByProjectIds(tasks, projectIds).filter(
    (task) => !teamId || !task.teamId || task.teamId === teamId,
  )
}

function createDashboardSummary(
  teams: ProjectDirectoryTeam[],
  tasks: ProjectTask[],
): DashboardSummary {
  return {
    projects: uniqueProjectIds(teams).length,
    tasks: tasks.filter((task) => task.status !== 'done').length,
    blocked: tasks.filter((task) => task.priority === 'high' && task.status !== 'done').length,
    updatedAt: new Date().toISOString(),
    source: 'dynamodb',
  }
}

function resolveTaskTitle(task: ProjectTask, t: (key: MessageKey) => string) {
  return resolveWorkItemTitle(task, t)
}

function resolveTaskAssignee(task: ProjectTask, t: (key: MessageKey) => string) {
  return resolveWorkItemAssignee(task, t)
}

function createActionQueueTasks(tasks: ProjectTask[]) {
  return [...tasks]
    .filter((task) => task.status !== 'done')
    .sort((firstTask, secondTask) => {
      const firstScore = calculateWorkspaceActionScore(firstTask)
      const secondScore = calculateWorkspaceActionScore(secondTask)

      if (firstScore !== secondScore) {
        return secondScore - firstScore
      }

      return getWorkspaceDueTime(firstTask) - getWorkspaceDueTime(secondTask)
    })
}

function createInboxTasks(tasks: ProjectTask[]) {
  return createActionQueueTasks(tasks)
    .filter((task) =>
      task.priority === 'high' ||
      task.status === 'review' ||
      isWorkspaceTaskOverdue(task),
    )
}

function isWorkspaceTaskAssignedToUser(
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

function normalizeWorkspaceSearchText(value?: string) {
  return value?.trim().toLocaleLowerCase() ?? ''
}

function calculateWorkspaceActionScore(task: ProjectTask) {
  return (isWorkspaceTaskOverdue(task) ? 8 : 0) +
    (task.priority === 'high' ? 5 : task.priority === 'medium' ? 2 : 0) +
    (task.status === 'review' ? 4 : task.status === 'in-progress' ? 1 : 0)
}

function isOpenableWorkspaceTask(task: ProjectTask) {
  return Boolean(task.teamId)
}

function isWorkspaceTaskOverdue(task: ProjectTask) {
  const dueDate = parseWorkspaceTaskDueDate(task.dueDate)

  if (task.status === 'done' || !dueDate) {
    return false
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return dueDate < today
}

function getWorkspaceDueTime(task: ProjectTask) {
  return parseWorkspaceTaskDueDate(task.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER
}

function parseWorkspaceTaskDueDate(value: string) {
  const [year, month, day] = value.split('/').map(Number)

  if (!year || !month || !day) {
    return null
  }

  const date = new Date(year, month - 1, day)
  date.setHours(0, 0, 0, 0)

  return Number.isNaN(date.getTime()) ? null : date
}

function calculateProjectProgress(tasks: ProjectTask[]) {
  if (tasks.length === 0) {
    return 0
  }

  return Math.round((tasks.filter((task) => task.status === 'done').length / tasks.length) * 100)
}

function resolvePortfolioRiskKey(tasks: ProjectTask[]): MessageKey {
  if (tasks.some((task) => task.priority === 'high' && task.status !== 'done')) {
    return 'workspace.risk.watch'
  }

  if (tasks.every((task) => task.status === 'done')) {
    return 'workspace.risk.low'
  }

  return 'workspace.risk.clear'
}

function createReportProjectRows(teams: ProjectDirectoryTeam[], tasks: ProjectTask[]) {
  return teams
    .flatMap((team) => team.projects.map((project) => {
      const projectTasks = filterTasksByTeamProjectIds(tasks, [project.id], team.id)
      const openTaskCount = projectTasks.filter((task) => task.status !== 'done').length
      const doneTaskCount = projectTasks.filter((task) => task.status === 'done').length
      const reviewTaskCount = projectTasks.filter((task) => task.status === 'review').length
      const attentionTaskCount = createInboxTasks(projectTasks).length

      return {
        attentionTaskCount,
        doneTaskCount,
        name: project.name,
        openTaskCount,
        progress: calculateProjectProgress(projectTasks),
        projectId: project.id,
        reviewTaskCount,
        taskCount: projectTasks.length,
        teamId: team.id,
        teamName: team.name,
      }
    }))
    .sort(
      (firstProject, secondProject) =>
        secondProject.attentionTaskCount - firstProject.attentionTaskCount ||
        secondProject.openTaskCount - firstProject.openTaskCount ||
        firstProject.name.localeCompare(secondProject.name),
    )
}

function resolveReportStatusToneClassName(status: TaskStatus) {
  const toneClassNames: Record<TaskStatus, string> = {
    todo: 'bg-slate-400',
    'in-progress': 'bg-[var(--workbench-primary)]',
    review: 'bg-amber-500',
    done: 'bg-emerald-600',
  }

  return toneClassNames[status]
}

function resolveReportPriorityToneClassName(priority: TaskPriority) {
  const toneClassNames: Record<TaskPriority, string> = {
    high: 'bg-red-600',
    medium: 'bg-amber-500',
    low: 'bg-emerald-600',
  }

  return toneClassNames[priority]
}

function downloadWorkspaceReportCsv(
  projectRows: ReturnType<typeof createReportProjectRows>,
  t: (key: MessageKey) => string,
) {
  const headers = [
    t('workspace.column.project'),
    t('workspace.column.team'),
    t('workspace.reports.column.total'),
    t('workspace.reports.column.open'),
    t('workspace.reports.column.done'),
    t('workspace.reports.column.review'),
    t('workspace.reports.column.attention'),
    t('workspace.column.progress'),
  ]
  const rows = projectRows.map((project) => [
    project.name,
    project.teamName,
    project.taskCount,
    project.openTaskCount,
    project.doneTaskCount,
    project.reviewTaskCount,
    project.attentionTaskCount,
    `${project.progress}%`,
  ])
  const csv = [headers, ...rows]
    .map((row) => row.map(escapeWorkspaceCsvValue).join(','))
    .join('\n')
  const downloadUrl = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')

  link.href = downloadUrl
  link.download = 'mukuroji-project-snapshot.csv'
  link.click()
  URL.revokeObjectURL(downloadUrl)
}

function escapeWorkspaceCsvValue(value: number | string) {
  const text = String(value)
  const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text

  return /[",\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText
}

function createTeamProjectSummaries(
  projects: readonly ProjectDirectoryProject[],
  tasks: ProjectTask[],
  teamProjectMembers: readonly TeamProjectMemberAccess[],
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
    const memberIds = new Set(projectMembers.map((access) => createProjectMemberIdentity(access.member)))
    const managerIds = new Set(
      projectMembers
        .filter((access) => access.member.role === 'manager')
        .map((access) => createProjectMemberIdentity(access.member)),
    )

    return {
      attentionTaskCount: projectTasks.filter(isAttentionWorkspaceTask).length,
      id: project.id,
      managerCount: managerIds.size,
      memberCount: memberIds.size,
      name: project.name,
      nextTask: createActionQueueTasks(projectTasks)[0],
      openTaskCount: projectTasks.filter((task) => task.status !== 'done').length,
      progress: calculateProjectProgress(projectTasks),
      reviewTaskCount: projectTasks.filter((task) => task.status === 'review').length,
    }
  })
}

function countUniqueTeamMembers(teamProjectMembers: readonly TeamProjectMemberAccess[]) {
  return new Set(teamProjectMembers.map((access) => createProjectMemberIdentity(access.member))).size
}

function createTeamMemberRows(
  projects: readonly ProjectDirectoryProject[],
  tasks: ProjectTask[],
  teamProjectMembers: readonly TeamProjectMemberAccess[],
  teamId: string | undefined,
  t: (key: MessageKey) => string,
): TeamMemberRow[] {
  const projectOrder = new Map(projects.map((project, index) => [project.id, index]))
  const projectIds = projects.map((project) => project.id)
  const rowsByMemberId = new Map<string, TeamMemberRow>()

  for (const access of teamProjectMembers) {
    const memberId = createProjectMemberIdentity(access.member)
    const row = rowsByMemberId.get(memberId) ?? createTeamMemberRow(access.member)
    const existingProjectAccess = row.projectAccess.find((project) => project.projectId === access.projectId)

    row.role = selectStrongerProjectMemberRole(row.role, access.member.role)

    if (existingProjectAccess) {
      existingProjectAccess.role = selectStrongerProjectMemberRole(existingProjectAccess.role, access.member.role)
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
    const memberId = resolveTaskMemberId(task, memberAliases, t)
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
      const openTasks = memberTasks.filter((task) => task.status !== 'done')
      const openTaskCount = openTasks.length
      const nextDueDate = openTasks
        .map((task) => task.dueDate)
        .sort((firstDate, secondDate) => firstDate.localeCompare(secondDate))[0]

      return {
        ...row,
        attentionTaskCount: memberTasks.filter(isAttentionWorkspaceTask).length,
        openPercent: Math.round((openTaskCount / Math.max(1, memberTasks.length)) * 100),
        nextDueDate,
        openTaskCount,
        projectAccess: row.projectAccess.sort(
          (firstProject, secondProject) =>
            (projectOrder.get(firstProject.projectId) ?? Number.MAX_SAFE_INTEGER) -
              (projectOrder.get(secondProject.projectId) ?? Number.MAX_SAFE_INTEGER) ||
            firstProject.projectName.localeCompare(secondProject.projectName),
        ),
        reviewTaskCount: memberTasks.filter((task) => task.status === 'review').length,
        taskCount: memberTasks.length,
      }
    })
    .sort(
      (firstMember, secondMember) =>
        secondMember.openTaskCount - firstMember.openTaskCount ||
        getProjectMemberRoleWeight(secondMember.role) - getProjectMemberRoleWeight(firstMember.role) ||
        firstMember.name.localeCompare(secondMember.name),
    )
}

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

function resolveTaskMemberId(
  task: ProjectTask,
  memberAliases: Map<string, string>,
  t: (key: MessageKey) => string,
) {
  const taskAliases = [
    task.assigneeUserId,
    task.assigneeEmail,
    task.assigneeName,
    task.assignee,
    task.assigneeKey ? t(task.assigneeKey) : undefined,
  ]

  for (const value of taskAliases) {
    const memberId = memberAliases.get(normalizeTeamMemberAlias(value))

    if (memberId) {
      return memberId
    }
  }

  return undefined
}

function createProjectMemberIdentity(member: ProjectMember) {
  return normalizeTeamMemberAlias(member.id || member.email) || member.id || member.email
}

function normalizeTeamMemberAlias(value?: string) {
  return value?.trim().toLowerCase() ?? ''
}

function selectStrongerProjectMemberRole(
  currentRole: ProjectMemberRole | undefined,
  nextRole: ProjectMemberRole,
) {
  return getProjectMemberRoleWeight(nextRole) > getProjectMemberRoleWeight(currentRole)
    ? nextRole
    : currentRole ?? nextRole
}

function getProjectMemberRoleWeight(role?: ProjectMemberRole) {
  const roleWeights: Record<ProjectMemberRole, number> = {
    manager: 3,
    member: 2,
    viewer: 1,
  }

  return role ? roleWeights[role] : 0
}

function isAttentionWorkspaceTask(task: ProjectTask) {
  return task.status !== 'done' && (task.priority === 'high' || isWorkspaceTaskOverdue(task))
}

function formatTeamText(value: string, teamName?: string) {
  return value.replace('{team}', teamName ?? '')
}

/**
 * Workspace の表示ビューで共有する React 非依存の集計・変換処理です。
 */
export const workspacePresentation = {
  findActiveTeam,
  isLegacyWorkspaceTask,
  uniqueProjectIds,
  createWorkspaceTaskKey,
  createWorkspaceTaskTestId,
  createWorkspaceTaskTestToken,
  readMyTaskKanbanStatus,
  findWorkspaceTaskByKey,
  updateWorkspaceTaskStatus,
  replaceWorkspaceTask,
  filterTasksByProjectIds,
  filterTasksByTeamProjectIds,
  createDashboardSummary,
  resolveTaskTitle,
  resolveTaskAssignee,
  createActionQueueTasks,
  createInboxTasks,
  isWorkspaceTaskAssignedToUser,
  normalizeWorkspaceSearchText,
  calculateWorkspaceActionScore,
  isOpenableWorkspaceTask,
  isWorkspaceTaskOverdue,
  getWorkspaceDueTime,
  parseWorkspaceTaskDueDate,
  calculateProjectProgress,
  resolvePortfolioRiskKey,
  createReportProjectRows,
  resolveReportStatusToneClassName,
  resolveReportPriorityToneClassName,
  downloadWorkspaceReportCsv,
  escapeWorkspaceCsvValue,
  createTeamProjectSummaries,
  countUniqueTeamMembers,
  createTeamMemberRows,
  createTeamMemberRow,
  createTeamMemberAliasMap,
  resolveTaskMemberId,
  createProjectMemberIdentity,
  normalizeTeamMemberAlias,
  selectStrongerProjectMemberRole,
  getProjectMemberRoleWeight,
  isAttentionWorkspaceTask,
  formatTeamText,
}
