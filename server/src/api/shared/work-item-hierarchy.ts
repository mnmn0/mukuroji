import {
  WORK_ITEM_HIERARCHY_MAX_ITEMS,
  type TeamWorkItemHierarchyResponse,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import {
  createTeamWorkItemHierarchyResponse,
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
