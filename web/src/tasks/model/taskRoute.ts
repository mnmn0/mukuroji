import type { CurrentUser } from '../../auth/api'
import { TeamIssuesApiError, type TeamIssue } from '../../issues/api'
import type {
  ProjectDirectoryProject,
  ProjectDirectoryTeam,
  ProjectUser,
} from '../../projects/api'
import { ProjectTasksApiError } from '../api/errors'

/** Inputs used to resolve Project, Team, and Issue context for the task route. */
export type ResolveProjectTaskRouteContextInput = {
  /** Directory Teams and their Project entries visible to the current user. */
  teams: ProjectDirectoryTeam[]
  /** Canonical Issues returned by the Project-wide query. */
  projectIssues: TeamIssue[]
  /** Project ID resolved from the route path. */
  projectId: string
  /** Optional Team ID resolved from route search parameters. */
  selectedTeamId?: string
  /** Optional Issue ID resolved from route search parameters. */
  selectedIssueId?: string
  /** Whether a prior ambiguous selection must suppress fallback to the first Issue Team. */
  suppressIssueFallback: boolean
}

/** Resolved Project, Team, and Issue context consumed by the task route container. */
export type ProjectTaskRouteContext = {
  /** Explicitly selected Team when it contains the routed Project. */
  selectedProjectTeam?: ProjectDirectoryTeam
  /** Every visible Team containing the routed Project. */
  projectTeams: ProjectDirectoryTeam[]
  /** Sole Project Team when exactly one Team contains the routed Project. */
  aggregateProjectTeam?: ProjectDirectoryTeam
  /** Project entries matching the routed Project ID across all Teams. */
  matchingProjects: ProjectDirectoryProject[]
  /** Project Issues narrowed by the explicit Team selection when present. */
  tasks: TeamIssue[]
  /** Whether an unscoped Issue ID resolves to multiple Team-owned Issues. */
  hasAmbiguousIssueSelection: boolean
  /** Unambiguous Issue explicitly requested by route search parameters. */
  requestedIssue?: TeamIssue
  /** Explicitly requested Issue or first task used by the detail fallback. */
  resolvedSelectedIssue?: TeamIssue
  /** Team used for detail interaction, chosen from explicit Team, Issue, or sole Project Team. */
  interactionTeamId?: string
  /** Directory Team used for detail interaction. */
  interactionTeam?: ProjectDirectoryTeam
  /** Interaction Team or sole Project Team used by active route presentation. */
  activeTeam?: ProjectDirectoryTeam
  /** Explicit or sole Team allowed to create a Project task. */
  creationTeam?: ProjectDirectoryTeam
  /** Team whose configuration may drive the aggregate task list directly. */
  listConfigurationTeamId?: string
  /** Project entry used for the route heading and active Project presentation. */
  activeProject?: ProjectDirectoryProject
  /** Sorted Team IDs whose Work Item configurations must be loaded. */
  configurationTeamIds: string[]
  /** Team ID used for selected Work Item detail, collaboration, and files. */
  selectedWorkItemTeamId?: string
}

/**
 * Resolves the normalized directory key used to match the current user to a Project member.
 *
 * @param user - The authenticated user returned by the current-user query.
 * @returns The lowercase email or username used by Project membership records.
 */
export function resolveCurrentUserProjectKey(user: CurrentUser | undefined) {
  return (user?.attributes.email ?? user?.username ?? '').trim().toLowerCase()
}

/**
 * Builds the identity for an accumulated Project-user page.
 *
 * @param projectId - The Project whose assignment candidates are being listed.
 * @param query - The current user search query.
 * @returns A stable key that separates Project and search result pages.
 */
export function createProjectUsersPageKey(projectId: string, query: string) {
  return `${projectId}\u0000${query.trim()}`
}

/**
 * Merges paginated Project users by their canonical identifier.
 *
 * @param currentUsers - Users retained from earlier pages.
 * @param nextUsers - Users returned by the next page.
 * @returns The deduplicated users in first-seen order.
 */
export function mergeProjectUsers(
  currentUsers: readonly ProjectUser[],
  nextUsers: readonly ProjectUser[],
) {
  const usersById = new Map(currentUsers.map((user) => [user.id, user]))

  for (const user of nextUsers) {
    usersById.set(user.id, user)
  }

  return Array.from(usersById.values())
}

/**
 * Adapts the canonical Project issue load error to the legacy Project-task copy contract.
 *
 * @param error - The error raised by the Project issue query.
 * @returns The task-specific error when the canonical fallback key is used, otherwise the input.
 */
export function normalizeProjectIssueError(error: unknown) {
  if (error instanceof TeamIssuesApiError && error.message === 'issues.error.loading') {
    return new ProjectTasksApiError(error.status, 'tasks.error.loading', error.code)
  }

  return error
}

/**
 * Resolves the complete Project, Team, and Issue context for the task route.
 *
 * This preserves aggregate Project behavior for repeated Project IDs, disambiguates Team-local
 * Issue IDs, and retains configuration Teams even when they currently have no tasks.
 *
 * @param input - Directory, Project Issue, route selection, and fallback-suppression inputs.
 * @returns The route context consumed by task queries, mutations, and the task screen.
 */
export function resolveProjectTaskRouteContext(
  input: ResolveProjectTaskRouteContextInput,
): ProjectTaskRouteContext {
  const selectedProjectTeam = input.selectedTeamId
    ? input.teams.find((team) =>
        team.id === input.selectedTeamId &&
        team.projects.some((project) => project.id === input.projectId)
      )
    : undefined
  const projectTeams = input.teams.filter((team) =>
    team.projects.some((project) => project.id === input.projectId)
  )
  const aggregateProjectTeam = projectTeams.length === 1 ? projectTeams[0] : undefined
  const matchingProjects = projectTeams.flatMap((team) =>
    team.projects.filter((project) => project.id === input.projectId)
  )
  const tasks = input.selectedTeamId
    ? input.projectIssues.filter((issue) => issue.teamId === input.selectedTeamId)
    : input.projectIssues
  const requestedIssueCandidates = input.selectedIssueId
    ? tasks.filter((issue) =>
        issue.id === input.selectedIssueId &&
        (!input.selectedTeamId || issue.teamId === input.selectedTeamId)
      )
    : []
  const hasAmbiguousIssueSelection = Boolean(
    input.selectedIssueId &&
    !input.selectedTeamId &&
    requestedIssueCandidates.length > 1,
  )
  const requestedIssue = hasAmbiguousIssueSelection
    ? undefined
    : requestedIssueCandidates[0]
  const resolvedSelectedIssue = requestedIssue ?? tasks[0]
  const requestedIssueTeamId = input.selectedIssueId && requestedIssue
    ? requestedIssue.teamId
    : undefined
  const interactionTeamId = selectedProjectTeam?.id ??
    requestedIssueTeamId ??
    aggregateProjectTeam?.id
  const interactionTeam = interactionTeamId
    ? input.teams.find((team) => team.id === interactionTeamId)
    : undefined
  const activeTeam = interactionTeam ?? aggregateProjectTeam
  const creationTeam = selectedProjectTeam ?? aggregateProjectTeam
  const listConfigurationTeamId = selectedProjectTeam?.id ?? aggregateProjectTeam?.id
  const consistentAggregateProject = matchingProjects.every(
    (project) => project.name === matchingProjects[0]?.name,
  )
    ? matchingProjects[0]
    : undefined
  const activeProject = interactionTeam
    ? interactionTeam.projects.find((project) => project.id === input.projectId)
    : consistentAggregateProject
  const configurationTeamIds = selectedProjectTeam
    ? [selectedProjectTeam.id]
    : Array.from(new Set([
        ...projectTeams.map((team) => team.id),
        ...input.projectIssues.map((issue) => issue.teamId),
      ])).sort()
  const selectedWorkItemTeamId = interactionTeamId ?? (
    hasAmbiguousIssueSelection || input.suppressIssueFallback
      ? undefined
      : resolvedSelectedIssue?.teamId
  )

  return {
    activeProject,
    activeTeam,
    aggregateProjectTeam,
    configurationTeamIds,
    creationTeam,
    hasAmbiguousIssueSelection,
    interactionTeam,
    interactionTeamId,
    listConfigurationTeamId,
    matchingProjects,
    projectTeams,
    requestedIssue,
    resolvedSelectedIssue,
    selectedProjectTeam,
    selectedWorkItemTeamId,
    tasks,
  }
}
