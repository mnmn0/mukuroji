import type { CanonicalWorkItem } from '@mukuroji/contracts'
import {
  ANALYTICS_EARNED_VALUE_MAX_AS_OF_AGE_MS,
  AnalyticsError,
  MAX_ANALYTICS_EARNED_VALUE_PROJECTS,
  createAnalyticsEarnedValueProjectKey,
  type AnalyticsEarnedValue,
  type AnalyticsEarnedValueProject,
} from '../../modules/analytics'
import { ProjectDataError } from '../../modules/directory'
import { loadProjectEarnedValue, ProjectBudgetReportError } from '../../modules/project-budget'
import { mapInOrderWithConcurrency } from './agent-run-access'
import { WORK_ITEMS_AGGREGATE_ITEM_LIMIT } from './constants'
import { createProjectBudgetReportPorts } from './project-budget-report-ports'
import { requireTeamPermission, type WorkspacePrincipal } from './project-access'
import { requireTeamProjectManager } from './project-manager-access'

/** Concurrent Project reads while earned value is assembled. */
const EARNED_VALUE_READ_CONCURRENCY = 4

/** A Team-qualified Project in the query scope. */
type ScopeProject = {
  /** Team that owns the Project. */
  teamId: string
  /** Project ID within the Team. */
  projectId: string
}

/** Refusal raised inside the manager check when the viewer does not manage the Project. */
class NotProjectManagerError extends Error {}

/**
 * Lists the Team-qualified Projects of the query scope: the current Projects of the authorized
 * Work Items that the viewer may read, narrowed to the filter's Projects.
 *
 * @param scopeWorkItems - Authorized Work Items of the query scope.
 * @param authorizedProjectIds - Project IDs the viewer may read.
 * @param filterProjectIds - Project IDs of the query filter, when it names any.
 * @returns The Projects sorted by Team and Project.
 * @throws AnalyticsError with `413` when the scope has more than
 *   {@link MAX_ANALYTICS_EARNED_VALUE_PROJECTS} Projects.
 */
function listScopeProjects(
  scopeWorkItems: readonly CanonicalWorkItem[],
  authorizedProjectIds: ReadonlySet<string>,
  filterProjectIds: readonly string[] | undefined,
): ScopeProject[] {
  const filter = filterProjectIds === undefined ? undefined : new Set(filterProjectIds)
  const projects = new Map<string, ScopeProject>()
  for (const item of scopeWorkItems) {
    const projectId = item.assignedProjectId
    if (projectId === undefined || !authorizedProjectIds.has(projectId) || (filter !== undefined && !filter.has(projectId))) continue
    projects.set(createAnalyticsEarnedValueProjectKey(item.teamId, projectId), { teamId: item.teamId, projectId })
  }
  if (projects.size > MAX_ANALYTICS_EARNED_VALUE_PROJECTS) {
    throw new AnalyticsError(
      413,
      'AnalyticsEarnedValueLimitExceeded',
      `Analytics earned value covers at most ${MAX_ANALYTICS_EARNED_VALUE_PROJECTS} Projects in one query. Narrow the report to fewer Teams or Projects.`,
    )
  }
  return [...projects.values()].sort((left, right) =>
    left.teamId.localeCompare(right.teamId) || left.projectId.localeCompare(right.projectId))
}

/**
 * Checks whether the viewer manages a Project in its Team, the role that may read the Project
 * budget report and so its earned value.
 *
 * @param principal - Viewer.
 * @param project - Team-qualified Project.
 * @returns Whether the viewer manages the Project.
 */
async function managesProject(principal: WorkspacePrincipal, project: ScopeProject): Promise<boolean> {
  try {
    const context = await requireTeamPermission(principal, project.teamId, 'viewer')
    await requireTeamProjectManager(principal, context, project.teamId, project.projectId, () => new NotProjectManagerError())
    return true
  } catch (error) {
    if (error instanceof NotProjectManagerError) return false
    if (error instanceof ProjectDataError && (error.status === 403 || error.status === 404)) return false
    throw error
  }
}

/**
 * Reads which Projects of the query scope the viewer manages, for an earned value query and for
 * the permission check of a stored earned value snapshot.
 *
 * @param principal - Viewer.
 * @param scopeWorkItems - Currently authorized Work Items of the query scope.
 * @param authorizedProjectIds - Project IDs the viewer may read.
 * @param filterProjectIds - Project IDs of the query filter, when it names any.
 * @returns The managed Projects and the number left out.
 * @throws AnalyticsError with `413` when the scope has too many Projects.
 */
export async function readAnalyticsEarnedValueProjects(
  principal: WorkspacePrincipal,
  scopeWorkItems: readonly CanonicalWorkItem[],
  authorizedProjectIds: ReadonlySet<string>,
  filterProjectIds: readonly string[] | undefined,
): Promise<{ managed: ScopeProject[]; unmanagedCount: number }> {
  const projects = listScopeProjects(scopeWorkItems, authorizedProjectIds, filterProjectIds)
  const managed = (await mapInOrderWithConcurrency(projects, EARNED_VALUE_READ_CONCURRENCY, async (project) =>
    await managesProject(principal, project) ? project : undefined
  )).flatMap((project) => project === undefined ? [] : [project])
  return { managed, unmanagedCount: projects.length - managed.length }
}

/**
 * Reads the earned value of the Projects in the query scope that the viewer manages (ADR 0110).
 * The figures come from the same reads as the Project budget report. A query whose as-of time is
 * more than a day old reads only the managed Projects, because earned value would mix the current
 * progress with past planned value.
 *
 * @param principal - Viewer whose access already bounded `scopeWorkItems`.
 * @param scopeWorkItems - Authorized Work Items of the query scope.
 * @param authorizedProjectIds - Project IDs the viewer may read.
 * @param filterProjectIds - Project IDs of the query filter, when it names any.
 * @param asOf - Query as-of instant, ISO 8601.
 * @param timeZone - Query timezone, which picks the as-of local date.
 * @param now - Current instant, epoch milliseconds.
 * @returns The earned value.
 * @throws AnalyticsError with `413` when the scope has too many Projects or a Team too many Work Items.
 */
export async function readAuthorizedAnalyticsEarnedValue(
  principal: WorkspacePrincipal,
  scopeWorkItems: readonly CanonicalWorkItem[],
  authorizedProjectIds: ReadonlySet<string>,
  filterProjectIds: readonly string[] | undefined,
  asOf: string,
  timeZone: string,
  now: number = Date.now(),
): Promise<AnalyticsEarnedValue> {
  const { managed, unmanagedCount } = await readAnalyticsEarnedValueProjects(
    principal,
    scopeWorkItems,
    authorizedProjectIds,
    filterProjectIds,
  )
  const managedProjectKeys = managed.map((project) => createAnalyticsEarnedValueProjectKey(project.teamId, project.projectId))
  const asOfAt = Date.parse(asOf)
  if (!(asOfAt >= now - ANALYTICS_EARNED_VALUE_MAX_AS_OF_AGE_MS)) {
    return { projects: [], managedProjectKeys, unmanagedProjectCount: unmanagedCount, withoutBaselineCount: 0, asOfTooOld: true }
  }
  // One set of ports for the query, so Projects of one Team share its Work Item pages.
  const ports = createProjectBudgetReportPorts({ cacheWorkItemPages: true })
  const figures = await mapInOrderWithConcurrency(managed, EARNED_VALUE_READ_CONCURRENCY, async (project) => {
    try {
      return await loadProjectEarnedValue(
        { workspaceId: principal.directoryId, ...project, timeZone, asOf: Math.min(asOfAt, now) },
        ports,
        WORK_ITEMS_AGGREGATE_ITEM_LIMIT,
      )
    } catch (error) {
      if (error instanceof ProjectBudgetReportError && error.status === 413) {
        throw new AnalyticsError(413, 'AnalyticsEarnedValueLimitExceeded', error.message)
      }
      throw error
    }
  })
  const projects: AnalyticsEarnedValueProject[] = []
  for (const [index, project] of managed.entries()) {
    const value = figures[index]
    if (value === null || value === undefined) continue
    projects.push({
      ...project,
      budgetAtCompletionMinutes: value.budgetAtCompletionMinutes,
      plannedValueMinutes: value.plannedValueMinutes,
      earnedValueMinutes: value.earnedValueMinutes,
      actualMinutes: value.actualMinutes,
    })
  }
  return {
    projects,
    managedProjectKeys,
    unmanagedProjectCount: unmanagedCount,
    withoutBaselineCount: managed.length - projects.length,
    asOfTooOld: false,
  }
}
