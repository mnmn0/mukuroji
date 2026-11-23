import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { PlanningMilestoneNotificationRevalidator } from '../../modules/collaboration/adapter-in/events/collaboration-projection'
import {
  createPlanningEntityCollaborationEntityKey,
  DynamoDbCollaborationClient,
} from '../../modules/collaboration/collaboration'
import {
  createDynamoDbPlanningMilestoneScopeReader,
  type PlanningMilestoneScopeReader,
} from '../../modules/planning/adapter-out/dynamodb/milestone-scope-reader'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'

/**
 * Adapts the Planning Milestone reader and the Collaboration watcher reader to the projection's
 * Milestone notification revalidator.
 *
 * @param milestones - Strong reader of one Milestone's scope.
 * @param watchers - Exact, strongly consistent reader of one member's watcher row.
 * @returns Revalidator used by the projection and the external-channel delivery recheck.
 */
export function createPlanningMilestoneNotificationRevalidator(
  milestones: PlanningMilestoneScopeReader,
  watchers: Pick<DynamoDbCollaborationClient, 'getMemberWatcherState'>,
): PlanningMilestoneNotificationRevalidator {
  return {
    readCurrentMilestoneScope: (workspaceId, entityId) =>
      milestones.readCurrentMilestoneScope(workspaceId, entityId),
    async isWatching(workspaceId, entityId, memberKey) {
      const entityKey = createPlanningEntityCollaborationEntityKey(workspaceId, entityId)
      return (await watchers.getMemberWatcherState({ entityKey, memberKey })).subscribed
    },
  }
}

/**
 * Builds the Milestone notification revalidator over the Planning and Collaboration tables.
 *
 * @param planningTableName - Planning table, when configured.
 * @param documentClient - Document client; a new one by default.
 * @returns The revalidator, or undefined so Milestone notifications are dropped (fail closed).
 */
export function createConfiguredPlanningMilestoneNotificationRevalidator(
  planningTableName: string | undefined,
  documentClient?: DynamoDBDocumentClient,
): PlanningMilestoneNotificationRevalidator | undefined {
  if (!planningTableName) return undefined
  const client = documentClient ?? createDynamoDbDocumentClient(createDynamoDbClient())
  return createPlanningMilestoneNotificationRevalidator(
    createDynamoDbPlanningMilestoneScopeReader({ documentClient: client, planningTableName }),
    // Collaboration table from the environment; an explicit client never bootstraps a local table.
    new DynamoDbCollaborationClient(undefined, undefined, undefined, client),
  )
}
