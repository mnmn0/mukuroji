import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY,
  WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME,
  WORK_ITEM_NOTIFICATION_DUE_KEY_ATTRIBUTE,
  WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_ATTRIBUTE,
  WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_COUNT,
  createWorkItemNotificationScheduleShardName,
} from '../../../work-items'
import type {
  AutomationDueWorkItem,
  AutomationDueWorkItemSource,
} from '../../application/ports/schedule-context-port'

/** Settings of the DynamoDB due Work Item source. */
export type DynamoDbAutomationDueWorkItemSourceOptions = {
  /** DocumentClient used for the index queries. */
  documentClient: Pick<DynamoDBDocumentClient, 'send'>
  /** Canonical Work Items table name. */
  workItemsTableName: string
  /** Query page size; 100 by default. */
  pageSize?: number
}

/**
 * Creates the source that lists open Work Items due on a date from the sparse notification due
 * index (ADR 0022).
 *
 * The index keys an unstarted Work Item by its due date and a started one by a fixed key, so each
 * shard is read at both keys and the rows are filtered to the Workspace and the due date.
 *
 * @param options - Table, client, and page size.
 * @returns The due Work Item source.
 */
export function createDynamoDbAutomationDueWorkItemSource(
  options: DynamoDbAutomationDueWorkItemSourceOptions,
): AutomationDueWorkItemSource {
  return {
    async listOpenWorkItemsDueOn(workspaceId, dueDate) {
      const teamPrefix = `${workspaceId}#team#`
      const items = new Map<string, AutomationDueWorkItem>()
      for (let index = 0; index < WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_COUNT; index += 1) {
        const shard = createWorkItemNotificationScheduleShardName(index)
        for (const dueKey of [dueDate, WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY]) {
          let exclusiveStartKey: Record<string, unknown> | undefined
          do {
            const response = await options.documentClient.send(new QueryCommand({
              TableName: options.workItemsTableName,
              IndexName: WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME,
              KeyConditionExpression: '#shard = :shard AND #dueKey = :dueKey',
              FilterExpression: 'begins_with(#directoryTeamId, :teamPrefix) AND #dueDate = :dueDate',
              ExpressionAttributeNames: {
                '#shard': WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_ATTRIBUTE,
                '#dueKey': WORK_ITEM_NOTIFICATION_DUE_KEY_ATTRIBUTE,
                '#directoryTeamId': 'directoryTeamId',
                '#dueDate': 'dueDate',
              },
              ExpressionAttributeValues: {
                ':shard': shard,
                ':dueKey': dueKey,
                ':teamPrefix': teamPrefix,
                ':dueDate': dueDate,
              },
              Limit: options.pageSize ?? 100,
              ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
            }))
            for (const row of response.Items ?? []) {
              const item = readDueWorkItem(row, teamPrefix, dueDate)
              if (item) items.set(`${item.teamId}\0${item.workItemId}`, item)
            }
            exclusiveStartKey = response.LastEvaluatedKey
          } while (exclusiveStartKey)
        }
      }
      return [...items.values()]
    },
  }
}

/**
 * Reads one indexed Work Item row of the Workspace.
 *
 * @param row - Projected index row.
 * @param teamPrefix - `directoryTeamId` prefix of the Workspace.
 * @param dueDate - Due date the query asked for.
 * @returns The Work Item, or undefined when the row is outside the Workspace or archived.
 */
function readDueWorkItem(
  row: Record<string, unknown>,
  teamPrefix: string,
  dueDate: string,
): AutomationDueWorkItem | undefined {
  const directoryTeamId = row.directoryTeamId
  const workItemId = row.issueId
  if (
    typeof directoryTeamId !== 'string' ||
    !directoryTeamId.startsWith(teamPrefix) ||
    typeof workItemId !== 'string' ||
    !workItemId ||
    row.dueDate !== dueDate ||
    (row.archivedAt !== undefined && row.archivedAt !== null)
  ) {
    return undefined
  }
  const teamId = directoryTeamId.slice(teamPrefix.length)
  return teamId ? { teamId, workItemId, dueDate } : undefined
}
