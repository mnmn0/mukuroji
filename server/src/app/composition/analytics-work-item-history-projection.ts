import {
  DynamoDbAnalyticsWorkItemHistoryStore,
  processAnalyticsWorkItemHistoryProjectionBatch,
  type AnalyticsWorkItemTimeline,
} from '../../modules/analytics'
import type {
  AuditProjectionBatchProcessor,
} from '../../modules/audit/adapter-in/events/audit-projection'
import { DynamoDbAuditEventsClient, type AuditEventV1 } from '../../modules/audit'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from '../../infrastructure/aws/dynamodb-client'
import { loadServerDynamoDbResourceConfig } from '../../infrastructure/config/server-resource-config'

/** Audit events read per page when a history row is rebuilt. */
const TIMELINE_PAGE_SIZE = 100

/** Pages read per rebuild; a longer timeline marks the row as overflowed. */
const TIMELINE_MAX_PAGES = 100

/**
 * Creates the Analytics history step of the audit projection fan-out.
 *
 * @returns An AuditEvents stream processor that maintains per-Work-Item history rows.
 */
export function createProductionAnalyticsWorkItemHistoryProjectionHandler(
): AuditProjectionBatchProcessor {
  const resourceConfig = loadServerDynamoDbResourceConfig()
  const dynamoDbClient = createDynamoDbClient()
  const documentClient = createDynamoDbDocumentClient(dynamoDbClient)
  const store = new DynamoDbAnalyticsWorkItemHistoryStore(
    resourceConfig.analyticsTableName,
    documentClient,
  )
  const auditEvents = new DynamoDbAuditEventsClient(
    documentClient,
    resourceConfig.auditEventsTableName,
    {},
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
  )

  /**
   * Reads one Work Item's audit timeline from the entity index, oldest first.
   *
   * @param workspaceId - Workspace ID.
   * @param teamId - Owning Team ID.
   * @param workItemId - Work Item ID.
   * @returns The events and whether the whole timeline fit in the page limit.
   */
  async function readWorkItemTimeline(
    workspaceId: string,
    teamId: string,
    workItemId: string,
  ): Promise<AnalyticsWorkItemTimeline> {
    const events: AuditEventV1[] = []
    let cursor: string | undefined
    for (let page = 0; page < TIMELINE_MAX_PAGES; page += 1) {
      const response = await auditEvents.query({
        workspaceId,
        entityType: 'work-item',
        entityId: `team/${teamId}/issue/${workItemId}`,
        limit: TIMELINE_PAGE_SIZE,
        direction: 'ascending',
        ...(cursor ? { cursor } : {}),
      })
      events.push(...response.events)
      cursor = response.nextCursor
      if (!cursor) return { events, complete: true }
    }
    return { events, complete: false }
  }

  return async (event) => await processAnalyticsWorkItemHistoryProjectionBatch(event, {
    store,
    readWorkItemTimeline,
  })
}
