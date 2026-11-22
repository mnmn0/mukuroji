import type {
  DirectoryAdministrationResponse,
  DirectoryArchiveImpactCount,
  DirectoryArchiveImpactResponse,
  DirectoryArchiveImpactTarget,
  WebhookSubscription,
} from '@mukuroji/contracts'
import type { AgentRunPage } from '../../modules/agent-runs'
import { ProjectDataError } from '../../modules/directory'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import type { PlanningAuthorizationState } from '../../modules/planning'
import type {
  SortedWorkItemPage,
  SortedWorkItemPagePosition,
} from '../../modules/work-items'
import { mapInOrderWithConcurrency } from './agent-run-access'
import {
  developerPlatformDependencies,
  workItemDependencies,
  workspaceDependencies,
} from './app-dependencies'

/**
 * Most distinct dependency endpoints of a Team that one Project archive can guard; more are
 * refused with 413 because their Work Item revisions would not fit in the archive transaction.
 */
export const PROJECT_ARCHIVE_DEPENDENCY_ENDPOINT_LIMIT = 96

/** Reads the archive impact counts from, replaceable in tests. */
export type DirectoryArchiveImpactSources = {
  /** Reads every Team and Project of the Workspace, archived ones included. */
  readDirectory(directoryId: string): Promise<DirectoryAdministrationResponse>
  /** Reads the Planning entities, Work Item links, and dependencies of the Workspace. */
  readPlanning(directoryId: string): Promise<PlanningAuthorizationState>
  /** Reads one bounded page of the Team's or Project's Work Items, archived ones included. */
  readWorkItemPage(
    directoryId: string,
    target: DirectoryArchiveImpactTarget,
    startAfter: SortedWorkItemPagePosition | undefined,
  ): Promise<SortedWorkItemPage>
  /** Reads one page of the Team's active Agent Runs. */
  readActiveRunPage(
    directoryId: string,
    teamId: string,
    cursor: string | undefined,
  ): Promise<AgentRunPage>
  /**
   * Strongly reads the Project a Work Item is assigned to.
   *
   * @returns The assignment, or undefined when the Work Item no longer exists.
   */
  readWorkItemAssignment(
    directoryId: string,
    teamId: string,
    workItemId: string,
  ): Promise<{ assignedProjectId?: string } | undefined>
  /** Lists every Webhook subscription of the Workspace. */
  listWebhookSubscriptions(directoryId: string): Promise<WebhookSubscription[]>
}

/** Work Items returned by one counting page. */
const WORK_ITEM_PAGE_LIMIT = 200

/** Rows DynamoDB may evaluate for one counting page, including rows the filters drop. */
const WORK_ITEM_PAGE_MAX_EVALUATED_ROWS = 500

/** Work Item pages read before the count is reported as a floor. */
const WORK_ITEM_MAX_PAGES = 10

/** Active Agent Runs read in one page. */
const ACTIVE_RUN_PAGE_LIMIT = 100

/** Active Agent Run pages read before the count is reported as a floor. */
const ACTIVE_RUN_MAX_PAGES = 5

/** Default sources backed by the application's dependencies. */
const defaultSources: DirectoryArchiveImpactSources = {
  readDirectory: (directoryId) =>
    workspaceDependencies.projectDirectory.getDirectoryAdministration(directoryId),
  readPlanning: (directoryId) => workItemDependencies.planning.getAuthorizationState(directoryId),
  readWorkItemPage: (directoryId, target, startAfter) => {
    const options = {
      limit: WORK_ITEM_PAGE_LIMIT,
      maxEvaluatedRows: WORK_ITEM_PAGE_MAX_EVALUATED_ROWS,
      // Archived Work Items still hold dependencies that block a Project archive.
      includeArchived: true,
      ...(startAfter === undefined ? {} : { startAfter }),
    }
    return target.kind === 'team'
      ? workItemDependencies.teamIssues.getTeamIssuePage(directoryId, target.teamId, options)
      : workItemDependencies.teamIssues.getProjectIssuePage(directoryId, target.projectId, options)
  },
  readActiveRunPage: (directoryId, teamId, cursor) =>
    workItemDependencies.agentRuns.listActiveRuns(directoryId, teamId, cursor, ACTIVE_RUN_PAGE_LIMIT),
  readWorkItemAssignment: async (directoryId, teamId, workItemId) => {
    try {
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        directoryId,
        teamId,
        workItemId,
        { consistentIssueRead: true, includeEvents: false },
      )
      return detail.issue.assignedProjectId === undefined
        ? {}
        : { assignedProjectId: detail.issue.assignedProjectId }
    } catch (error) {
      if (isTeamIssueNotFoundError(error)) return undefined
      throw error
    }
  },
  listWebhookSubscriptions: (directoryId) =>
    developerPlatformDependencies.webhookSubscriptions.listWebhookSubscriptions(directoryId),
}

/**
 * Counts what archiving a Team or Project affects, so the administrator can confirm it knowingly.
 *
 * Planning entities and links block the archive (the archive route refuses with 409); the other
 * counts are warnings, because the archived records stay and come back on restore. Large Teams
 * are counted up to a bound, and a count that stopped early reports `hasMore`.
 *
 * @param directoryId - Workspace directory.
 * @param target - Team or Project being archived.
 * @param sources - Readers of the counted records.
 * @returns The impact counts.
 * @throws ProjectDataError 404 when the Team or Project is missing or already archived.
 */
export async function readDirectoryArchiveImpact(
  directoryId: string,
  target: DirectoryArchiveImpactTarget,
  sources: DirectoryArchiveImpactSources = defaultSources,
): Promise<DirectoryArchiveImpactResponse> {
  await requireActiveTarget(sources, directoryId, target)

  const [planning, workItems, runPages, subscriptions] = await Promise.all([
    sources.readPlanning(directoryId),
    readWorkItems(sources, directoryId, target),
    readActiveRuns(sources, directoryId, target.teamId),
    sources.listWebhookSubscriptions(directoryId),
  ])
  const inScope = (scope: { teamId?: string; projectId?: string }) =>
    scope.teamId === target.teamId &&
    (target.kind === 'team' || scope.projectId === target.projectId)
  const planningEntities = planning.entities.filter((entity) =>
    !entity.archivedAt && inScope(entity)
  ).length
  const planningWorkItemLinks = planning.workItemLinks.filter(inScope).length
  const teamEndpointIds = [...new Set(
    planning.workItemDependencies
      .flatMap((dependency) => [dependency.predecessor, dependency.successor])
      .filter((endpoint) => endpoint.teamId === target.teamId)
      .map((endpoint) => endpoint.workItemId),
  )]
  const endpointLimitExceeded = target.kind === 'project' &&
    teamEndpointIds.length > PROJECT_ARCHIVE_DEPENDENCY_ENDPOINT_LIMIT
  // Mirrors the archive guards: a Team archive refuses every dependency on the Team, and a
  // Project archive refuses dependencies whose Work Item is assigned to the Project or missing.
  // Endpoints are read one by one, as the guard does, so the bounded Work Item count above
  // never hides a blocker.
  const blockingEndpointIds = target.kind === 'team' || endpointLimitExceeded
    ? new Set(teamEndpointIds)
    : await readProjectBlockingEndpointIds(sources, directoryId, target, teamEndpointIds)
  const isBlockingEndpoint = (endpoint: { teamId: string; workItemId: string }) =>
    endpoint.teamId === target.teamId && blockingEndpointIds.has(endpoint.workItemId)
  const planningDependencies = target.kind === 'project' && endpointLimitExceeded
    ? 0
    : planning.workItemDependencies.filter((dependency) =>
        isBlockingEndpoint(dependency.predecessor) || isBlockingEndpoint(dependency.successor)
      ).length

  return {
    openWorkItems: { count: workItems.openCount, hasMore: workItems.hasMore },
    activeAgentRuns: countActiveRuns(target, runPages, workItems),
    planningEntities,
    planningWorkItemLinks,
    planningDependencies,
    webhookSubscriptions: subscriptions.filter((subscription) =>
      subscription.status === 'active' && subscription.teamIds.includes(target.teamId)
    ).length,
    archiveBlocked: endpointLimitExceeded ||
      planningEntities + planningWorkItemLinks + planningDependencies > 0,
  }
}

/** Dependency endpoints read at once while resolving Project blockers. */
const ENDPOINT_READ_CONCURRENCY = 8

/**
 * Finds the Team's dependency endpoints that block a Project archive: Work Items assigned to the
 * Project, and Work Items that no longer exist.
 *
 * @param sources - Readers of the counted records.
 * @param directoryId - Workspace directory.
 * @param target - Project being archived.
 * @param endpointIds - Team-local Work Item IDs of the Team's dependency endpoints.
 * @returns The blocking Work Item IDs.
 */
async function readProjectBlockingEndpointIds(
  sources: DirectoryArchiveImpactSources,
  directoryId: string,
  target: Extract<DirectoryArchiveImpactTarget, { kind: 'project' }>,
  endpointIds: readonly string[],
) {
  const assignments = await mapInOrderWithConcurrency(
    endpointIds,
    ENDPOINT_READ_CONCURRENCY,
    (workItemId) => sources.readWorkItemAssignment(directoryId, target.teamId, workItemId),
  )
  return new Set(endpointIds.filter((_, index) => {
    const assignment = assignments[index]
    return assignment === undefined || assignment.assignedProjectId === target.projectId
  }))
}

/**
 * Verifies that the Team, and the Project when given, exist and are not archived.
 *
 * @param sources - Readers of the counted records.
 * @param directoryId - Workspace directory.
 * @param target - Team or Project being archived.
 */
async function requireActiveTarget(
  sources: DirectoryArchiveImpactSources,
  directoryId: string,
  target: DirectoryArchiveImpactTarget,
) {
  const directory = await sources.readDirectory(directoryId)
  const team = directory.teams.find((candidate) =>
    candidate.id === target.teamId && candidate.archivedAt === undefined
  )
  if (!team) {
    throw new ProjectDataError(404, 'TeamNotFound', `Team "${target.teamId}" was not found.`)
  }
  if (
    target.kind === 'project' &&
    !team.projects.some((project) =>
      project.id === target.projectId && project.archivedAt === undefined
    )
  ) {
    throw new ProjectDataError(
      404,
      'ProjectNotFound',
      `Project "${target.projectId}" was not found.`,
    )
  }
}

/** Work Items counted for an archive impact. */
type CountedWorkItems = {
  /** Work Items that are neither completed nor canceled. */
  openCount: number
  /** Team-local IDs of every Work Item read, open, closed, or archived. */
  workItemIds: Set<string>
  /** Whether reading stopped before the last page. */
  hasMore: boolean
}

/**
 * Reads the Team's or Project's unarchived Work Items up to the page bound.
 *
 * @param sources - Readers of the counted records.
 * @param directoryId - Workspace directory.
 * @param target - Team or Project being archived.
 * @returns The open count, the counted IDs, and whether reading stopped early.
 */
async function readWorkItems(
  sources: DirectoryArchiveImpactSources,
  directoryId: string,
  target: DirectoryArchiveImpactTarget,
): Promise<CountedWorkItems> {
  const counted: CountedWorkItems = { openCount: 0, workItemIds: new Set(), hasMore: false }
  let startAfter: SortedWorkItemPagePosition | undefined

  for (let page = 0; page < WORK_ITEM_MAX_PAGES; page += 1) {
    const result = await sources.readWorkItemPage(directoryId, target, startAfter)
    for (const issue of result.issues) {
      // A Project's index is keyed by the Project alone, so another Team's row is skipped.
      if (issue.teamId !== target.teamId) continue
      counted.workItemIds.add(issue.id)
      if (
        issue.archivedAt === undefined &&
        issue.statusCategory !== 'completed' &&
        issue.statusCategory !== 'canceled'
      ) {
        counted.openCount += 1
      }
    }
    if (result.nextPosition === undefined) return counted
    startAfter = result.nextPosition
  }

  counted.hasMore = true
  return counted
}

/** Active Agent Runs read for an archive impact. */
type ReadActiveRuns = {
  /** Work Item ID of each active run read. */
  workItemIds: string[]
  /** Whether reading stopped before the last page. */
  hasMore: boolean
}

/**
 * Reads the Team's active Agent Runs up to the page bound.
 *
 * @param sources - Readers of the counted records.
 * @param directoryId - Workspace directory.
 * @param teamId - Team whose runs are read.
 * @returns Work Item IDs of the runs read, and whether reading stopped early.
 */
async function readActiveRuns(
  sources: DirectoryArchiveImpactSources,
  directoryId: string,
  teamId: string,
): Promise<ReadActiveRuns> {
  const workItemIds: string[] = []
  let cursor: string | undefined

  for (let page = 0; page < ACTIVE_RUN_MAX_PAGES; page += 1) {
    const result = await sources.readActiveRunPage(directoryId, teamId, cursor)
    for (const run of result.runs) {
      if (run.state === 'active') workItemIds.push(run.workItemId)
    }
    if (result.nextCursor === undefined) return { workItemIds, hasMore: false }
    cursor = result.nextCursor
  }

  return { workItemIds, hasMore: true }
}

/**
 * Counts the active runs that the archive affects.
 *
 * Every active run of the Team counts for a Team archive. For a Project archive only runs on the
 * Project's Work Items count, so when the Work Item read stopped early a run on an unread Work
 * Item may be missing and the count is reported as a floor.
 *
 * @param target - Team or Project being archived.
 * @param runs - Active runs of the Team.
 * @param workItems - Work Items counted for the target.
 * @returns The active run count.
 */
function countActiveRuns(
  target: DirectoryArchiveImpactTarget,
  runs: ReadActiveRuns,
  workItems: CountedWorkItems,
): DirectoryArchiveImpactCount {
  if (target.kind === 'team') {
    return { count: runs.workItemIds.length, hasMore: runs.hasMore }
  }

  const matched = runs.workItemIds.filter((workItemId) => workItems.workItemIds.has(workItemId))
  return {
    count: matched.length,
    hasMore: runs.hasMore || (workItems.hasMore && matched.length < runs.workItemIds.length),
  }
}
