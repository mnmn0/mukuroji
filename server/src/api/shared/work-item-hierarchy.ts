import {
  WORK_ITEM_HIERARCHY_MAX_ITEMS,
  isWorkItemHierarchyClosedCategory,
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
 * @returns The readable parent, or `null`, and the readable non-archived children; nothing for an
 *   archived Work Item, which is outside the hierarchy as in the Team tree.
 */
export async function readWorkItemHierarchyLinks(
  directoryId: string,
  teamId: string,
  issue: TeamIssueResponseItem,
  isReadable: (issue: TeamIssueResponseItem) => boolean,
): Promise<{ parentWorkItemId: string | null, childWorkItemIds: string[] }> {
  if (issue.archivedAt !== undefined) return { parentWorkItemId: null, childWorkItemIds: [] }
  const parentId = readWorkItemParentId(issue.relationIds)
  const parent = parentId === undefined ? undefined : await readLinkedWorkItem(directoryId, teamId, parentId)
  const children = await readReadableWorkItemChildren(directoryId, teamId, issue, isReadable)
  return {
    parentWorkItemId: parent && parent.archivedAt === undefined && isReadable(parent) ? parent.id : null,
    childWorkItemIds: children.map((child) => child.id).sort(),
  }
}

/**
 * Counts the readable direct children of a Work Item that are still open.
 *
 * Archived children are outside the hierarchy and are not counted, as in the server's `reject`
 * check. The Web asks with this count before completing a parent under the `warn` policy.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team that owns the Work Item.
 * @param issue - Parent Work Item.
 * @param isReadable - Whether the reader may see a Work Item.
 * @returns Number of readable, non-archived children that are neither completed nor canceled.
 */
export async function readOpenWorkItemChildCount(
  directoryId: string,
  teamId: string,
  issue: TeamIssueResponseItem,
  isReadable: (issue: TeamIssueResponseItem) => boolean,
): Promise<number> {
  const children = await readReadableWorkItemChildren(directoryId, teamId, issue, isReadable)
  return children.filter((child) => !isWorkItemHierarchyClosedCategory(child.statusCategory)).length
}

/**
 * Reads the readable, non-archived direct children of a Work Item.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team that owns the Work Item.
 * @param issue - Parent Work Item; an archived one has no children in the hierarchy.
 * @param isReadable - Whether the reader may see a Work Item.
 * @returns The children in relation order.
 */
async function readReadableWorkItemChildren(
  directoryId: string,
  teamId: string,
  issue: TeamIssueResponseItem,
  isReadable: (issue: TeamIssueResponseItem) => boolean,
): Promise<TeamIssueResponseItem[]> {
  if (issue.archivedAt !== undefined) return []
  const children = await workItemDependencies.workItemConfigurations.listRelations(
    directoryId,
    teamId,
    issue.id,
    { types: ['child'] },
  )
  const childIds = children.relations.map((relation) => relation.targetWorkItemId)
  const readable: TeamIssueResponseItem[] = []
  for (let index = 0; index < childIds.length; index += LINK_READ_CONCURRENCY) {
    const details = await Promise.all(
      childIds.slice(index, index + LINK_READ_CONCURRENCY)
        .map((childId) => readLinkedWorkItem(directoryId, teamId, childId)),
    )
    for (const child of details) {
      if (child && child.archivedAt === undefined && isReadable(child)) readable.push(child)
    }
  }
  return readable
}

/**
 * Reads a linked Work Item.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns The Work Item, or `undefined` when it no longer exists.
 */
async function readLinkedWorkItem(
  directoryId: string,
  teamId: string,
  workItemId: string,
): Promise<TeamIssueResponseItem | undefined> {
  try {
    return (await workItemDependencies.teamIssues.getTeamIssueDetail(
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
