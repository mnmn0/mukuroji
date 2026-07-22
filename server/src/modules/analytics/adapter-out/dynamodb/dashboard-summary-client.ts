import type {
  ProjectAccessEntry,
  ProjectDirectoryClient,
  ProjectRole,
} from '../../../directory'
import { projectRoleWeights } from '../../../directory'
import type { TeamIssuesClient } from '../../../work-items'
import { DynamoDbTeamIssuesClient } from '../../../work-items'
import { DynamoDbProjectDirectoryClient } from '../../../directory'

/** Dashboard summary returned by the API. */
export type DashboardSummaryResponse = {
  /** Number of visible active projects. */
  projects: number
  /** Number of visible unfinished Work Items. */
  tasks: number
  /** Number of visible high-priority unfinished Work Items. */
  blocked: number
  /** ISO 8601 timestamp at which the summary was calculated. */
  updatedAt: string
  /** Persistence source used to calculate the summary. */
  source: 'dynamodb'
}

/** Authorization context used to constrain a dashboard summary. */
export type DashboardSummaryAccessContext = {
  /** Normalized Workspace member key. */
  userKey: string
  /** Whether the caller is a system administrator. */
  isSystemAdmin: boolean
  /** Project access entries resolved at the API authorization boundary. */
  projectAccesses?: ProjectAccessEntry[]
}

/** Port used by the dashboard route to calculate a summary. */
export type DashboardSummaryClient = {
  /**
   * Calculates the dashboard summary visible to a caller.
   *
   * @param directoryId - Workspace directory identifier.
   * @param accessContext - Resolved caller authorization context.
   * @returns The current dashboard summary.
   */
  getSummary(
    directoryId: string,
    accessContext: DashboardSummaryAccessContext,
  ): Promise<DashboardSummaryResponse>
}

/** Calculates dashboard summaries from DynamoDB-backed directory and Work Item adapters. */
export class DynamoDbDashboardSummaryClient implements DashboardSummaryClient {
  /** Team and project directory reader. */
  private readonly projectDirectoryClient: ProjectDirectoryClient

  /** Canonical Work Item reader. */
  private readonly teamIssuesClient: TeamIssuesClient

  /**
   * Creates a dashboard summary adapter.
   *
   * @param projectDirectoryClient - Team and project directory reader.
   * @param teamIssuesClient - Canonical Work Item reader.
   */
  constructor(
    projectDirectoryClient: ProjectDirectoryClient = new DynamoDbProjectDirectoryClient(),
    teamIssuesClient: TeamIssuesClient = new DynamoDbTeamIssuesClient(),
  ) {
    this.projectDirectoryClient = projectDirectoryClient
    this.teamIssuesClient = teamIssuesClient
  }

  /**
   * Calculates the dashboard summary visible to a caller.
   *
   * @param directoryId - Workspace directory identifier.
   * @param accessContext - Resolved caller authorization context.
   * @returns The current dashboard summary.
   */
  async getSummary(
    directoryId: string,
    accessContext: DashboardSummaryAccessContext,
  ): Promise<DashboardSummaryResponse> {
    const directory = await this.projectDirectoryClient.getProjectDirectory(directoryId, 'ja')
    const visibleProjectIds = accessContext.isSystemAdmin
      ? new Set(
        directory.teams.flatMap((team) => team.projects.map((project) => project.id)),
      )
      : new Set(
        (accessContext.projectAccesses ??
          await this.projectDirectoryClient.getProjectAccessList(directoryId, accessContext.userKey))
          .filter((access) => projectAccessAllows(access, 'viewer'))
          .map((access) => access.projectId),
      )
    const taskResponses = await Promise.all(
      Array.from(visibleProjectIds).map((projectId) =>
        this.teamIssuesClient.getProjectIssues(directoryId, projectId)
      ),
    )
    const tasks = taskResponses.flatMap((response) => response.issues)

    return {
      projects: visibleProjectIds.size,
      tasks: tasks.filter((task) => !isTerminalWorkItem(task)).length,
      blocked: tasks.filter((task) =>
        task.priority === 'high' && !isTerminalWorkItem(task)
      ).length,
      updatedAt: new Date().toISOString(),
      source: 'dynamodb',
    }
  }
}

/**
 * Determines whether a Project access entry meets a minimum role.
 *
 * @param access - Project access entry to evaluate.
 * @param minimumRole - Minimum required Project role.
 * @returns Whether the entry grants the required role.
 */
function projectAccessAllows(access: ProjectAccessEntry, minimumRole: ProjectRole): boolean {
  return access.role !== undefined &&
    projectRoleWeights[access.role] >= projectRoleWeights[minimumRole]
}

/**
 * Determines whether a Work Item is in a terminal workflow state.
 *
 * @param item - Work Item status projection.
 * @returns Whether the Work Item is completed or canceled.
 */
function isTerminalWorkItem(item: { statusCategory: string }): boolean {
  return item.statusCategory === 'completed' || item.statusCategory === 'canceled'
}
