import type {
  DirectoryAdministrationResponse,
  DirectoryArchiveImpactCount,
  DirectoryArchiveImpactResponse,
  WebhookSubscription,
} from '@mukuroji/contracts'
import type { AgentRunPage } from '../../modules/agent-runs'
import { ProjectDataError } from '../../modules/directory'
import type { PlanningAuthorizationState } from '../../modules/planning'
import type {
  SortedWorkItemPage,
  SortedWorkItemPagePosition,
} from '../../modules/work-items'
import {
  developerPlatformDependencies,
  workItemDependencies,
  workspaceDependencies,
} from './app-dependencies'

/** Team or Project whose archive impact is counted. */
export type DirectoryArchiveImpactTarget =
  | {
      /** A Team and every Project in it. */
      kind: 'team'
      /** Team identifier. */
      teamId: string
    }
  | {
      /** One Project of a Team. */
      kind: 'project'
      /** Team that owns the Project. */
      teamId: string
      /** Project identifier. */
      projectId: string
    }

/** Reads the archive impact counts from, replaceable in tests. */
export type DirectoryArchiveImpactSources = {
  /** Reads every Team and Project of the Workspace, archived ones included. */
  readDirectory(directoryId: string): Promise<DirectoryAdministrationResponse>
  /** Reads the Planning entities, Work Item links, and dependencies of the Workspace. */
  readPlanning(directoryId: string): Promise<PlanningAuthorizationState>
  /** Reads one bounded page of the Team's or Project's unarchived Work Items in sort order. */
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
      includeArchived: false,
      ...(startAfter === undefined ? {} : { startAfter }),
    }
    return target.kind === 'team'
      ? workItemDependencies.teamIssues.getTeamIssuePage(directoryId, target.teamId, options)
      : workItemDependencies.teamIssues.getProjectIssuePage(directoryId, target.projectId, options)
  },
  readActiveRunPage: (directoryId, teamId, cursor) =>
    workItemDependencies.agentRuns.listActiveRuns(directoryId, teamId, cursor, ACTIVE_RUN_PAGE_LIMIT),
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
  const planningDependencies = target.kind === 'team'
    ? planning.workItemDependencies.filter((dependency) =>
        dependency.predecessor.teamId === target.teamId ||
        dependency.successor.teamId === target.teamId
      ).length
    : 0

  return {
    openWorkItems: { count: workItems.openCount, hasMore: workItems.hasMore },
    activeAgentRuns: countActiveRuns(target, runPages, workItems),
    planningEntities,
    planningWorkItemLinks,
    planningDependencies,
    webhookSubscriptions: subscriptions.filter((subscription) =>
      subscription.status === 'active' && subscription.teamIds.includes(target.teamId)
    ).length,
    archiveBlocked: planningEntities + planningWorkItemLinks + planningDependencies > 0,
  }
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
  /** Team-local IDs of every counted Work Item of the Team, open or closed. */
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
      if (issue.teamId !== target.teamId || issue.archivedAt !== undefined) continue
      counted.workItemIds.add(issue.id)
      if (issue.statusCategory !== 'completed' && issue.statusCategory !== 'canceled') {
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
