import type { ProjectBudgetReportPorts, ProjectBudgetWorkItemPage } from '../../modules/project-budget'
import { requireAppDependencies, workItemDependencies } from './app-dependencies'
import { WORK_ITEMS_AGGREGATE_READ_PAGE_SIZE } from './constants'

/**
 * Creates the Team-scoped reads the Project budget report and its earned value need.
 *
 * @param options - `cacheWorkItemPages` keeps each Team Work Item page for the life of the ports,
 *   so measuring several Projects of one Team reads the Team once.
 * @returns The ports.
 */
export function createProjectBudgetReportPorts(options: {
  /** Whether Team Work Item pages are read once and reused. */
  cacheWorkItemPages?: boolean
} = {}): ProjectBudgetReportPorts {
  const timeTracking = requireAppDependencies().timeTracking.timeTrackingService
  const pages = new Map<string, Promise<ProjectBudgetWorkItemPage>>()
  /**
   * Reads one page of a Team's Work Items, archived ones included.
   *
   * @param workspaceId - Workspace ID.
   * @param teamId - Team ID.
   * @param startAfterIssueId - Cursor of the page.
   * @returns The page.
   */
  const readPage = (workspaceId: string, teamId: string, startAfterIssueId: string | undefined) =>
    workItemDependencies.teamIssues.getTeamIssues(workspaceId, teamId, {
      limit: WORK_ITEMS_AGGREGATE_READ_PAGE_SIZE,
      includeArchived: true,
      consistentRead: true,
      limitEvaluatedRows: true,
      ...(startAfterIssueId ? { startAfterIssueId } : {}),
    })
  return {
    getBudget: (workspaceId, teamId, projectId) => timeTracking.getBudget(workspaceId, teamId, 'project', projectId),
    getBaseline: (workspaceId, teamId, projectId) => workItemDependencies.scheduleBaselines.get(workspaceId, teamId, projectId),
    getProgressMode: async (workspaceId, teamId) =>
      (await workItemDependencies.workItemConfigurations.getTeamConfiguration(workspaceId, teamId)).configuration.progressMode,
    listEntries: (input) => timeTracking.listAllEntries({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      from: input.from,
      to: input.to,
      projectIds: new Set([input.projectId]),
    }),
    listExpenses: (workspaceId, teamId, projectId) =>
      workItemDependencies.projectExpenses.list({ workspaceId, teamId, projectId }),
    listWorkItems: (workspaceId, teamId, startAfterIssueId) => {
      if (!options.cacheWorkItemPages) return readPage(workspaceId, teamId, startAfterIssueId)
      const key = JSON.stringify([workspaceId, teamId, startAfterIssueId ?? null])
      let page = pages.get(key)
      if (!page) {
        page = readPage(workspaceId, teamId, startAfterIssueId)
        pages.set(key, page)
      }
      return page
    },
    now: () => new Date(),
  }
}
