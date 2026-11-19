import {
  BatchGetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type { PlanningWorkItemLink, PlanningWorkItemSummary } from '@mukuroji/contracts'
import { isCanonicalWorkItemRecord } from '../../../work-items'
import type {
  CycleScheduleDueCycle,
  CycleScheduleSource,
} from '../../application/ports/cycle-schedule-source'
import {
  createPlanningCycleScheduleShardName,
  PLANNING_CYCLE_SCHEDULE_SHARD_COUNT,
} from '../../cycle-schedule-index'
import type { PlanningWorkItemState } from '../../planning'
import { PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME } from '../../planning-update-schedule-index'

/** Options of the DynamoDB Cycle schedule source. */
export type DynamoDbCycleScheduleSourceOptions = {
  /** DocumentClient for due-index queries and Work Item reads. */
  documentClient: Pick<DynamoDBDocumentClient, 'send'>
  /** Planning table that holds the due index. */
  planningTableName: string
  /** Canonical Work Items table. */
  workItemsTableName: string
  /** Due index shared with update targets. */
  indexName?: string
}

const ENTITY_RECORD_PREFIX = 'ENTITY#'
const QUERY_PAGE_SIZE = 100
const BATCH_GET_SIZE = 100
const BATCH_GET_ATTEMPTS = 3

/**
 * Creates the DynamoDB storage the Cycle automation schedule reads.
 *
 * @param options - DocumentClient and table names.
 * @returns Cycle schedule source.
 */
export function createDynamoDbCycleScheduleSource(
  options: DynamoDbCycleScheduleSourceOptions,
): CycleScheduleSource {
  const indexName = options.indexName ?? PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME
  return {
    shardCount: PLANNING_CYCLE_SCHEDULE_SHARD_COUNT,
    async listDueCycles(shard, asOf, cursor) {
      const response = await options.documentClient.send(new QueryCommand({
        TableName: options.planningTableName,
        IndexName: indexName,
        KeyConditionExpression:
          'updateScheduleShard = :scheduleShard AND nextNotificationAtRecordKey <= :upperBound',
        ExpressionAttributeValues: {
          ':scheduleShard': createPlanningCycleScheduleShardName(shard),
          ':upperBound': `${asOf.toISOString()}$`,
        },
        Limit: QUERY_PAGE_SIZE,
        ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor as Record<string, unknown> }),
      }))
      return {
        cycles: (response.Items ?? []).map(readIndexedCycle),
        ...(response.LastEvaluatedKey === undefined ? {} : { cursor: response.LastEvaluatedKey }),
      }
    },
    readLinkedWorkItems: (workspaceId, links) =>
      readLinkedWorkItems(options.documentClient, options.workItemsTableName, workspaceId, links),
  }
}

/** Reads the Workspace and Cycle ID of one due-index row, failing closed on a foreign row. */
function readIndexedCycle(item: Record<string, unknown>): CycleScheduleDueCycle {
  const { workspaceId, recordKey } = item
  if (
    typeof workspaceId !== 'string' ||
    typeof recordKey !== 'string' ||
    !recordKey.startsWith(ENTITY_RECORD_PREFIX)
  ) {
    throw new TypeError('Cycle schedule index returned a row that is not a Planning entity.')
  }
  return { workspaceId, cycleId: decodeURIComponent(recordKey.slice(ENTITY_RECORD_PREFIX.length)) }
}

/**
 * Reads the canonical Work Items behind Cycle links with strongly consistent batch reads.
 *
 * Missing Work Items and archived open ones are left out, so the rollover fails closed on them like
 * the manual rollover does. Archived completed or canceled Work Items are kept as finished work of
 * the source Cycle. A row that is not a canonical Work Item of the Workspace is rejected.
 */
async function readLinkedWorkItems(
  documentClient: Pick<DynamoDBDocumentClient, 'send'>,
  tableName: string,
  workspaceId: string,
  links: readonly PlanningWorkItemLink[],
): Promise<PlanningWorkItemState> {
  const workItems: PlanningWorkItemSummary[] = []
  for (let offset = 0; offset < links.length; offset += BATCH_GET_SIZE) {
    let keys: Record<string, unknown>[] = links.slice(offset, offset + BATCH_GET_SIZE).map((link) => ({
      directoryTeamId: `${workspaceId}#team#${link.teamId}`,
      issueId: link.workItemId,
    }))
    for (let attempt = 0; keys.length > 0; attempt += 1) {
      if (attempt >= BATCH_GET_ATTEMPTS) {
        throw new Error('Cycle schedule could not read every linked Work Item.')
      }
      const response = await documentClient.send(new BatchGetCommand({
        RequestItems: { [tableName]: { Keys: keys, ConsistentRead: true } },
      }))
      for (const row of response.Responses?.[tableName] ?? []) {
        if (!isCanonicalWorkItemRecord(row) || row.directoryId !== workspaceId) {
          throw new TypeError('Cycle schedule read an invalid canonical Work Item row.')
        }
        // An archived open Work Item stays out, so rollover fails closed as it does by hand. An archived
        // completed or canceled one is finished work that stays with the source Cycle.
        if (row.archivedAt && row.statusCategory !== 'completed' && row.statusCategory !== 'canceled') continue
        workItems.push({
          id: row.issueId,
          revision: row.revision,
          teamId: row.teamId,
          title: row.title,
          ...(row.assignedProjectId ? { projectId: row.assignedProjectId } : {}),
          statusCategory: row.statusCategory,
          dueDate: row.dueDate,
          schedule: row.schedule,
        })
      }
      keys = (response.UnprocessedKeys?.[tableName]?.Keys ?? []) as Record<string, unknown>[]
    }
  }
  return { workItems }
}
