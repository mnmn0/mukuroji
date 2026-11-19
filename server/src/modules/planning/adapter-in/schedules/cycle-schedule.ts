import {
  BatchGetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type { PlanningWorkItemLink, PlanningWorkItemSummary } from '@mukuroji/contracts'
import { isCanonicalWorkItemRecord } from '../../../work-items'
import {
  createPlanningCycleScheduleShardName,
  PLANNING_CYCLE_SCHEDULE_SHARD_COUNT,
} from '../../cycle-schedule-index'
import { PlanningError, type PlanningClient, type PlanningWorkItemState } from '../../planning'
import { PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME } from '../../planning-update-schedule-index'

/** EventBridge scheduled event fields used by the Cycle schedule. */
export type CycleScheduleEvent = {
  /** ISO 8601 time at which EventBridge fired the schedule. */
  time?: string
}

/** Options of the Cycle automation schedule. */
export type CycleScheduleOptions = {
  /** DocumentClient for due-index queries and Work Item reads. */
  documentClient: Pick<DynamoDBDocumentClient, 'send'>
  /** Planning adapter that runs one automation step at a time. */
  planning: Pick<PlanningClient, 'runCycleAutomationStep'>
  /** Planning table that holds the due index. */
  planningTableName: string
  /** Canonical Work Items table. */
  workItemsTableName: string
  /** Due index shared with update targets. */
  indexName?: string
  /** Clock used when the event has no time. */
  now?: () => Date
  /** Query pages read per shard in one run. */
  maxPagesPerShard?: number
  /** Steps run for one Cycle in one run. */
  maxStepsPerCycle?: number
}

/** Counts reported by one Cycle schedule run. */
export type CycleScheduleResult = {
  /** Due Cycles read from the index. */
  examined: number
  /** Next Cycles created. */
  created: number
  /** Rollover batches committed. */
  rolledOver: number
  /** Cycles whose step failed; they are retried on the next run. */
  failed: number
}

const ENTITY_RECORD_PREFIX = 'ENTITY#'
const QUERY_PAGE_SIZE = 100
const BATCH_GET_SIZE = 100
const BATCH_GET_ATTEMPTS = 3

/**
 * Creates the hourly job that creates next Cycles and carries over unfinished Work Items.
 *
 * Cycle rows carry sparse due-index attributes while an automation step is pending. Each run reads
 * the due rows of every shard and advances each Cycle until nothing is due. A failed Cycle stays in
 * the index and is retried on the next run.
 *
 * @param options - Storage, Planning adapter, and limits.
 * @returns Schedule handler.
 */
export function createCycleScheduleHandler(options: CycleScheduleOptions) {
  const indexName = options.indexName ?? PLANNING_UPDATE_SCHEDULE_DUE_INDEX_NAME
  const maxPages = options.maxPagesPerShard ?? 10
  const maxSteps = options.maxStepsPerCycle ?? 20
  const loadWorkItems = (workspaceId: string) =>
    (links: readonly PlanningWorkItemLink[]) =>
      readLinkedWorkItems(options.documentClient, options.workItemsTableName, workspaceId, links)

  return async (event: CycleScheduleEvent = {}): Promise<CycleScheduleResult> => {
    const asOf = readScheduleTime(event.time) ?? (options.now ?? (() => new Date()))()
    const result: CycleScheduleResult = { examined: 0, created: 0, rolledOver: 0, failed: 0 }
    for (let shard = 0; shard < PLANNING_CYCLE_SCHEDULE_SHARD_COUNT; shard += 1) {
      const scheduleShard = createPlanningCycleScheduleShardName(shard)
      let cursor: Record<string, unknown> | undefined
      let pages = 0
      do {
        const response = await options.documentClient.send(new QueryCommand({
          TableName: options.planningTableName,
          IndexName: indexName,
          KeyConditionExpression:
            'updateScheduleShard = :scheduleShard AND nextNotificationAtRecordKey <= :upperBound',
          ExpressionAttributeValues: {
            ':scheduleShard': scheduleShard,
            ':upperBound': `${asOf.toISOString()}$`,
          },
          Limit: QUERY_PAGE_SIZE,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }))
        cursor = response.LastEvaluatedKey
        pages += 1
        for (const item of response.Items ?? []) {
          const cycle = readIndexedCycle(item)
          if (!cycle) continue
          result.examined += 1
          try {
            await advanceCycle(options.planning, cycle, loadWorkItems(cycle.workspaceId), maxSteps, result)
          } catch (error) {
            result.failed += 1
            console.error('Cycle automation step failed.', {
              shard: scheduleShard,
              error: error instanceof PlanningError ? error.code : error instanceof Error ? error.name : 'unknown',
            })
          }
        }
      } while (cursor && pages < maxPages)
    }
    return result
  }
}

/** Runs automation steps for one Cycle until nothing is due. */
async function advanceCycle(
  planning: CycleScheduleOptions['planning'],
  cycle: { workspaceId: string; cycleId: string },
  loadWorkItems: (links: readonly PlanningWorkItemLink[]) => Promise<PlanningWorkItemState>,
  maxSteps: number,
  result: CycleScheduleResult,
) {
  let conflicts = 0
  for (let step = 0; step < maxSteps; step += 1) {
    let outcome
    try {
      outcome = await planning.runCycleAutomationStep(cycle.workspaceId, cycle.cycleId, loadWorkItems)
    } catch (error) {
      // A concurrent Planning change moved the revision; read the graph again and retry.
      if (error instanceof PlanningError && error.code === 'PlanningRevisionConflict' && conflicts < 3) {
        conflicts += 1
        continue
      }
      throw error
    }
    if (outcome.action === 'idle') return
    if (outcome.action === 'created-next') result.created += 1
    else result.rolledOver += 1
  }
}

/** Reads the Workspace and Cycle ID of one due-index row. */
function readIndexedCycle(item: Record<string, unknown>) {
  const { workspaceId, recordKey } = item
  if (
    typeof workspaceId !== 'string' ||
    typeof recordKey !== 'string' ||
    !recordKey.startsWith(ENTITY_RECORD_PREFIX)
  ) {
    return undefined
  }
  try {
    return { workspaceId, cycleId: decodeURIComponent(recordKey.slice(ENTITY_RECORD_PREFIX.length)) }
  } catch {
    return undefined
  }
}

/** Parses the schedule time of an EventBridge event. */
function readScheduleTime(value: unknown) {
  if (typeof value !== 'string') return undefined
  const time = new Date(value)
  return Number.isFinite(time.getTime()) ? time : undefined
}

/**
 * Reads the canonical Work Items behind Cycle links with strongly consistent batch reads.
 *
 * Archived or missing Work Items are left out, so the rollover fails closed on them like the
 * manual rollover does.
 *
 * @param documentClient - DocumentClient.
 * @param tableName - Canonical Work Items table.
 * @param workspaceId - Owning Workspace.
 * @param links - Cycle links.
 * @returns Planning Work Item projection.
 */
export async function readLinkedWorkItems(
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
        if (!isCanonicalWorkItemRecord(row) || row.directoryId !== workspaceId || row.archivedAt) continue
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
