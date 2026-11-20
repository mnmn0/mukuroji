import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_CUSTOMER_COMPLETION_PREPARATION_INDEX_NAME,
  WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME,
  WORK_ITEM_NOTIFICATION_DUE_KEY_ATTRIBUTE,
  WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_ATTRIBUTE,
  WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_COUNT,
  createWorkItemNotificationScheduleShardName,
} from '../../../work-items'
import type {
  ScheduledCompletionMarker,
  ScheduledReadOptions,
  ScheduledReadProgress,
  ScheduledTeam,
  ScheduledWorkItemSource,
} from '../../application/ports/scheduled-work-item-source'

/** Settings of the DynamoDB scheduled Work Item source. */
export type DynamoDbScheduledWorkItemSourceOptions = {
  /** DocumentClient used for every read and the marker update. */
  documentClient: Pick<DynamoDBDocumentClient, 'send'>
  /** Canonical Work Items table name. */
  workItemsTableName: string
  /** Project directory table name; required only for {@link ScheduledWorkItemSource.listTeams}. */
  projectDirectoryTableName?: string
  /** Sparse due GSI name; defaults to {@link WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME}. */
  dueIndexName?: string
}

/**
 * Creates the DynamoDB source that reads the Work Item notification indexes and the Team list.
 *
 * @param options - Tables and client.
 * @returns Source for the notification schedule.
 */
export function createDynamoDbScheduledWorkItemSource(
  options: DynamoDbScheduledWorkItemSourceOptions,
): ScheduledWorkItemSource {
  const { documentClient, workItemsTableName } = options
  const readCurrentWorkItem = async (row: Record<string, unknown>) => {
    const response = await documentClient.send(new GetCommand({
      TableName: workItemsTableName,
      Key: {
        directoryTeamId: requireText(row.directoryTeamId, 'Indexed Work Item partition key'),
        issueId: requireText(row.issueId, 'Indexed Work Item sort key'),
      },
      ConsistentRead: true,
    }))
    return response.Item
  }

  return {
    readDueWorkItems: (upperBoundDate, readOptions, visit) => queryIndexShards({
      documentClient,
      workItemsTableName,
      indexName: options.dueIndexName ?? WORK_ITEM_NOTIFICATION_DUE_INDEX_NAME,
      upperBound: { attribute: WORK_ITEM_NOTIFICATION_DUE_KEY_ATTRIBUTE, value: upperBoundDate },
      pageSize: readOptions.pageSize,
      visit,
    }),
    readCompletionMarkerWorkItems: (readOptions, visit) => queryIndexShards({
      documentClient,
      workItemsTableName,
      indexName: WORK_ITEM_CUSTOMER_COMPLETION_PREPARATION_INDEX_NAME,
      pageSize: readOptions.pageSize,
      visit: async (key) => {
        const current = await readCurrentWorkItem(key)
        if (current) await visit(current)
      },
    }),
    readCurrentWorkItem,
    clearCompletionMarker: (marker) =>
      clearCompletionMarker(documentClient, workItemsTableName, marker),
    listTeams: (readOptions) => listTeams(
      documentClient,
      requireText(options.projectDirectoryTableName, 'Project directory table name'),
      readOptions,
    ),
  }
}

/** Input of one pass over a sparse Work Item notification index. */
type IndexShardQueryInput = {
  /** DocumentClient used for the queries. */
  documentClient: Pick<DynamoDBDocumentClient, 'send'>
  /** Canonical Work Items table name. */
  workItemsTableName: string
  /** Sparse GSI to read. */
  indexName: string
  /** Inclusive sort key bound; omitted to read every entry of each shard. */
  upperBound?: {
    /** Sort key attribute of the GSI. */
    attribute: string
    /** Inclusive upper bound. */
    value: string
  }
  /** Items per query page. */
  pageSize: number
  /** Handles one projected row, in ascending sort key order within its shard. */
  visit: (item: Record<string, unknown>) => Promise<void>
}

/**
 * Reads every shard of a sparse Work Item notification index to the end.
 *
 * The amount read is bounded by the index itself (open, due-soon, overdue, or started Work Items,
 * or pending completion markers), not by the size of the Work Items table, so there is no page cap.
 *
 * @param input - Index, bound, and visitor.
 * @returns Pages and items read.
 */
async function queryIndexShards(input: IndexShardQueryInput): Promise<ScheduledReadProgress> {
  const progress: ScheduledReadProgress = { pages: 0, items: 0 }
  for (let shardIndex = 0; shardIndex < WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_COUNT; shardIndex += 1) {
    const shard = createWorkItemNotificationScheduleShardName(shardIndex)
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await input.documentClient.send(new QueryCommand({
        TableName: input.workItemsTableName,
        IndexName: input.indexName,
        KeyConditionExpression: input.upperBound
          ? '#shard = :shard AND #sortKey <= :upperBound'
          : '#shard = :shard',
        ExpressionAttributeNames: {
          '#shard': WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_ATTRIBUTE,
          ...(input.upperBound ? { '#sortKey': input.upperBound.attribute } : {}),
        },
        ExpressionAttributeValues: {
          ':shard': shard,
          ...(input.upperBound ? { ':upperBound': input.upperBound.value } : {}),
        },
        Limit: input.pageSize,
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      progress.pages += 1
      progress.items += response.ScannedCount ?? response.Items?.length ?? 0
      for (const item of response.Items ?? []) {
        await input.visit(item)
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
  }
  return progress
}

/**
 * Clears one Customer completion marker unless a newer marker replaced it.
 *
 * @param documentClient - DocumentClient used for the update.
 * @param workItemsTableName - Canonical Work Items table name.
 * @param marker - Marker that was prepared.
 */
async function clearCompletionMarker(
  documentClient: Pick<DynamoDBDocumentClient, 'send'>,
  workItemsTableName: string,
  marker: ScheduledCompletionMarker,
): Promise<void> {
  try {
    await documentClient.send(new UpdateCommand({
      TableName: workItemsTableName,
      Key: { directoryTeamId: marker.directoryTeamId, issueId: marker.issueId },
      UpdateExpression: 'REMOVE #preparationAt, #preparationRevision',
      ConditionExpression: '#preparationRevision = :revision',
      ExpressionAttributeNames: {
        '#preparationAt': 'customerCompletionPreparationAt',
        '#preparationRevision': 'customerCompletionPreparationRevision',
      },
      ExpressionAttributeValues: { ':revision': marker.revision },
    }))
  } catch (error) {
    if (!isConditionalCheckFailure(error)) throw error
    // A newer completion marker won the race; leave it for the next run.
  }
}

/**
 * Lists every Team in the Project directory.
 *
 * The directory holds Teams, Projects, and memberships, so this read grows with the organization
 * rather than with the number of Work Items.
 *
 * @param documentClient - DocumentClient used for the scan.
 * @param projectDirectoryTableName - Project directory table name.
 * @param options - Paging settings.
 * @returns Distinct Teams and the pages and items read.
 * @throws Error when the directory needs more than `maxPages` pages.
 */
async function listTeams(
  documentClient: Pick<DynamoDBDocumentClient, 'send'>,
  projectDirectoryTableName: string,
  options: ScheduledReadOptions,
): Promise<{ teams: ScheduledTeam[], progress: ScheduledReadProgress }> {
  const teams = new Map<string, ScheduledTeam>()
  const progress: ScheduledReadProgress = { pages: 0, items: 0 }
  let exclusiveStartKey: Record<string, unknown> | undefined
  do {
    if (progress.pages >= options.maxPages) {
      throw new Error(
        `Timesheet reminder Team lookup exceeded the configured ${options.maxPages} page limit.`,
      )
    }
    const response = await documentClient.send(new ScanCommand({
      TableName: projectDirectoryTableName,
      FilterExpression: '#entryType = :team',
      ProjectionExpression: '#directoryId, #entryType, #teamId',
      ExpressionAttributeNames: {
        '#directoryId': 'directoryId',
        '#entryType': 'entryType',
        '#teamId': 'teamId',
      },
      ExpressionAttributeValues: { ':team': 'team' },
      Limit: options.pageSize,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }))
    progress.pages += 1
    progress.items += response.ScannedCount ?? response.Items?.length ?? 0
    for (const item of response.Items ?? []) {
      const workspaceId = readText(item.directoryId)
      const teamId = readText(item.teamId)
      if (item.entryType !== 'team' || !workspaceId || !teamId) continue
      teams.set(`${workspaceId}\0${teamId}`, { workspaceId, teamId })
    }
    exclusiveStartKey = response.LastEvaluatedKey
  } while (exclusiveStartKey)
  return { teams: [...teams.values()], progress }
}

/**
 * Reads a non-blank string with surrounding whitespace removed.
 *
 * @param value - Candidate value.
 * @returns The trimmed text, or undefined when blank or not a string.
 */
function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Requires a non-blank string.
 *
 * @param value - Candidate value.
 * @param label - Name used in the error.
 * @returns The trimmed text.
 * @throws TypeError when the value is blank.
 */
function requireText(value: unknown, label: string): string {
  const text = readText(value)
  if (!text) throw new TypeError(`${label} is required.`)
  return text
}

/**
 * Detects a failed DynamoDB condition.
 *
 * @param error - Error thrown by the DocumentClient.
 * @returns Whether the error is a ConditionalCheckFailedException.
 */
function isConditionalCheckFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'name' in error && error.name === 'ConditionalCheckFailedException'
}
