import {
  WORK_ITEM_HIERARCHY_MAX_ITEMS,
  readWorkItemParentId,
  type TeamWorkItemHierarchyResponse,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import {
  createTeamWorkItemHierarchyResponse,
  isTeamIssueNotFoundError,
  type TeamIssueResponseItem,
} from '../../modules/work-items'
import { workItemDependencies } from './app-dependencies'

/**
 * Reads a Team's hierarchy read model for one reader.
 *
 * The graph revision is read before the Work Items, so a move made in between makes the
 * reader's next move fail with a graph conflict instead of applying to a stale tree.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team whose hierarchy is read.
 * @param isReadable - Whether the reader may see a Work Item.
 * @returns Readable nodes in outline order with WBS numbers and roll-ups.
 * @throws ProjectDataError `413 WorkItemListLimitExceeded` when the Team has more than
 *   {@link WORK_ITEM_HIERARCHY_MAX_ITEMS} non-archived Work Items.
 * @throws ProjectDataError `503 WorkItemHierarchyUnavailable` when the adapter cannot read it.
 */
export async function readTeamWorkItemHierarchy(
  directoryId: string,
  teamId: string,
  isReadable: (issue: TeamIssueResponseItem) => boolean,
): Promise<TeamWorkItemHierarchyResponse> {
  const { teamIssues, workItemConfigurations } = workItemDependencies
  if (!teamIssues.getTeamHierarchyEntries) {
    throw new ProjectDataError(
      503,
      'WorkItemHierarchyUnavailable',
      'The Work Item hierarchy cannot be read.',
    )
  }
  const graphRevision = workItemConfigurations.getRelationGraphRevision
    ? await workItemConfigurations.getRelationGraphRevision(directoryId, teamId)
    : (await workItemConfigurations.listRelationGraph(directoryId, teamId)).graphRevision
  const entries = await teamIssues.getTeamHierarchyEntries(
    directoryId,
    teamId,
    WORK_ITEM_HIERARCHY_MAX_ITEMS,
  )
  if (entries.length > WORK_ITEM_HIERARCHY_MAX_ITEMS) {
    throw new ProjectDataError(
      413,
      'WorkItemListLimitExceeded',
      `This Team has more than ${WORK_ITEM_HIERARCHY_MAX_ITEMS} Work Items, so its hierarchy ` +
        'cannot be read at once. Archive finished Work Items to read it.',
    )
  }
  return createTeamWorkItemHierarchyResponse({ teamId, graphRevision, entries, isReadable })
}

/** Child Work Items read at once while reading one Work Item's links. */
const LINK_READ_CONCURRENCY = 16

/**
 * Reads one Work Item's readable parent and children without reading the Team's whole tree.
 *
 * Used when the Team is too large for {@link readTeamWorkItemHierarchy}. Without the tree there
 * is no WBS number or sibling rank, so children are ordered by Work Item ID.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team that owns the Work Item.
 * @param issue - Work Item whose links are read.
 * @param isReadable - Whether the reader may see a Work Item.
 * @returns The readable parent, or `null`, and the readable non-archived children.
 */
export async function readWorkItemHierarchyLinks(
  directoryId: string,
  teamId: string,
  issue: TeamIssueResponseItem,
  isReadable: (issue: TeamIssueResponseItem) => boolean,
): Promise<{ parentWorkItemId: string | null, childWorkItemIds: string[] }> {
  const { teamIssues, workItemConfigurations } = workItemDependencies
  /** Reads a linked Work Item, or `undefined` when it no longer exists. */
  const readLinked = async (workItemId: string) => {
    try {
      return (await teamIssues.getTeamIssueDetail(
        directoryId,
        teamId,
        workItemId,
        { consistentIssueRead: true, includeEvents: false },
      )).issue
    } catch (error) {
      if (isTeamIssueNotFoundError(error)) return undefined
      throw error
    }
  }
  const parentId = readWorkItemParentId(issue.relationIds)
  const parent = parentId === undefined ? undefined : await readLinked(parentId)
  const children = await workItemConfigurations.listRelations(
    directoryId,
    teamId,
    issue.id,
    { types: ['child'] },
  )
  const childIds = children.relations.map((relation) => relation.targetWorkItemId)
  const childWorkItemIds: string[] = []
  for (let index = 0; index < childIds.length; index += LINK_READ_CONCURRENCY) {
    const details = await Promise.all(childIds.slice(index, index + LINK_READ_CONCURRENCY).map(readLinked))
    for (const child of details) {
      if (child && child.archivedAt === undefined && isReadable(child)) childWorkItemIds.push(child.id)
    }
  }
  return {
    parentWorkItemId: parent && parent.archivedAt === undefined && isReadable(parent) ? parent.id : null,
    childWorkItemIds: childWorkItemIds.sort(),
  }
}
