import { type WorkItemDependencies } from '../../app/composition/app-dependencies'
import {
  createWorkItemRelationGraphRevisionConditionCheck,
  createWorkItemRevisionConditionCheck,
  isTeamIssueNotFoundError,
  type TeamIssueResponseItem,
} from '../../modules/work-items'
import {
  WorkItemConfigurationError,
  type WorkItemConfigurationTransactionItems,
} from '../../modules/work-items/work-item-configuration'
import { getTeamIssuesTableName } from './work-item-access'
import { getWorkItemConfigurationTableName } from './work-item-configuration'

/** Child Work Items read at once while checking that a parent can be archived. */
const ARCHIVE_CHILD_READ_CONCURRENCY = 16

/**
 * Most Work Item revision fences one archive or restore commits with its update.
 *
 * DynamoDB allows 100 items per transaction. The rest are left for the update itself, its event,
 * audit, authorization, and Agent Run fences the persistence adapter adds. When more children
 * than this are read, only the relation graph is fenced.
 */
const ARCHIVE_HIERARCHY_REVISION_FENCE_BUDGET = 60

/** Error code of an archive refused because a child Work Item is not archived. */
export const WORK_ITEM_ACTIVE_CHILDREN_ERROR_CODE = 'WorkItemActiveChildren'

/** Error code of a restore refused because the parent Work Item is archived. */
export const WORK_ITEM_PARENT_ARCHIVED_ERROR_CODE = 'WorkItemParentArchived'

/** Inputs of one archive or restore hierarchy check. */
export type WorkItemArchiveHierarchyCheckInput = {
  /** Workspace directory ID. */
  directoryId: string
  /** Team that owns the Work Item and its parent and children. */
  teamId: string
  /** Work Item about to be archived or restored. */
  workItemId: string
  /** True when the Work Item is being archived, false when it is being restored. */
  archived: boolean
  /**
   * Other Work Items of the same Team that the same operation archives or restores.
   *
   * Archiving a parent together with its children, or restoring a child together with its
   * parent, is allowed, so these are left out of the check and its fences.
   */
  sameOperationWorkItemIds?: ReadonlySet<string>
}

/**
 * Keeps the Work Item hierarchy whole when a Work Item is archived or restored.
 *
 * Archiving is refused while a child that is not archived remains, so an archived parent never
 * hides active children from the WBS. Restoring is refused while the parent is archived, so a
 * restored child does not land at the top of the WBS under a hidden parent. What was read is
 * fenced into the update: the relation graph revision catches a child or parent attached
 * meanwhile, and each read Work Item's revision catches it being archived or restored meanwhile.
 *
 * @param input - Work Item, direction, and the other targets of the same operation.
 * @param dependencies - Relation and Work Item persistence.
 * @returns Condition checks to commit with the archive or restore.
 * @throws WorkItemConfigurationError `409 WorkItemActiveChildren` when archiving a parent that has
 * a child that is not archived, or `409 WorkItemParentArchived` when restoring a child whose
 * parent is archived.
 */
export async function prepareWorkItemArchiveHierarchyConditionChecks(
  input: WorkItemArchiveHierarchyCheckInput,
  dependencies: Pick<WorkItemDependencies, 'teamIssues' | 'workItemConfigurations'>,
): Promise<WorkItemConfigurationTransactionItems> {
  const { directoryId, teamId, workItemId, archived } = input
  const relationType = archived ? 'child' : 'parent'
  const related = await dependencies.workItemConfigurations.listRelations(
    directoryId,
    teamId,
    workItemId,
    { types: [relationType] },
  )
  const relatedIds = [...new Set(related.relations
    .filter((relation) => relation.sourceWorkItemId === workItemId && relation.type === relationType)
    .map((relation) => relation.targetWorkItemId))]
    .filter((relatedId) => !input.sameOperationWorkItemIds?.has(relatedId))
  const issues = await readExistingWorkItems(directoryId, teamId, relatedIds, dependencies)
  if (archived && issues.some((issue) => issue.archivedAt === undefined)) {
    throw new WorkItemConfigurationError(
      409,
      WORK_ITEM_ACTIVE_CHILDREN_ERROR_CODE,
      // The children can include ones the caller cannot read, so the message leaves out a count.
      'A child Work Item is not archived. Archive the children or move them to another parent first.',
    )
  }
  if (!archived && issues.some((issue) => issue.archivedAt !== undefined)) {
    throw new WorkItemConfigurationError(
      409,
      WORK_ITEM_PARENT_ARCHIVED_ERROR_CODE,
      'The parent Work Item is archived. Restore the parent first.',
    )
  }
  const graphConditionCheck = createWorkItemRelationGraphRevisionConditionCheck(
    getWorkItemConfigurationTableName(),
    directoryId,
    teamId,
    related.graphRevision,
  )
  if (issues.length > ARCHIVE_HIERARCHY_REVISION_FENCE_BUDGET) return [graphConditionCheck]
  return [
    graphConditionCheck,
    ...issues.map((issue) => createWorkItemRevisionConditionCheck(
      getTeamIssuesTableName(),
      directoryId,
      teamId,
      issue.id,
      issue.revision,
    )),
  ]
}

/**
 * Reads Work Items with strongly consistent reads and skips ones that no longer exist.
 *
 * A deleted Work Item can leave its relation behind. It can never be archived or restored again,
 * so it neither blocks the change nor needs a fence.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team that owns the Work Items.
 * @param workItemIds - Work Items to read.
 * @param dependencies - Work Item persistence.
 * @returns The Work Items that exist, in no particular order.
 */
async function readExistingWorkItems(
  directoryId: string,
  teamId: string,
  workItemIds: readonly string[],
  dependencies: Pick<WorkItemDependencies, 'teamIssues'>,
): Promise<TeamIssueResponseItem[]> {
  const issues: TeamIssueResponseItem[] = []
  for (let index = 0; index < workItemIds.length; index += ARCHIVE_CHILD_READ_CONCURRENCY) {
    const details = await Promise.all(workItemIds
      .slice(index, index + ARCHIVE_CHILD_READ_CONCURRENCY)
      .map(async (workItemId) => {
        try {
          return await dependencies.teamIssues.getTeamIssueDetail(
            directoryId,
            teamId,
            workItemId,
            { consistentIssueRead: true, includeEvents: false },
          )
        } catch (error) {
          if (isTeamIssueNotFoundError(error)) return undefined
          throw error
        }
      }))
    for (const detail of details) {
      if (detail) issues.push(detail.issue)
    }
  }
  return issues
}
