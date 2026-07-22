import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  AwsCognitoClient,
  CognitoServiceError,
} from '../../modules/authentication'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import { DynamoDbTeamIssuesClient } from '../../modules/work-items'
import {
  createAnalyticsScheduleRenderer,
  processAnalyticsSchedule,
  renderInAppAnalyticsArtifact,
  resolveAnalyticsScheduleProcessingTime,
  type AnalyticsScheduleEvent,
} from '../../modules/analytics/adapter-in/schedules/analytics-schedule'
import { DynamoDbAnalyticsRepository } from '../../modules/analytics/analytics'
import {
  DynamoDbAuditEventsClient,
  getConfiguredDynamoDbEndpoint,
} from '../../modules/audit/audit'
import { DynamoDbWorkspaceAccessClient } from '../../modules/workspace-access/workspace-access'

/**
 * Creates the production Analytics schedule processor.
 *
 * @returns A handler that renders and delivers due Analytics reports.
 */
export function createProductionAnalyticsScheduleHandler() {
  const configuredDynamoDbEndpoint = getConfiguredDynamoDbEndpoint()
  const dynamoDbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(configuredDynamoDbEndpoint ? { endpoint: configuredDynamoDbEndpoint } : {}),
  })
  const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: { removeUndefinedValues: true },
  })
  const repository = new DynamoDbAnalyticsRepository(
    process.env.ANALYTICS_TABLE_NAME ?? 'mukuroji-analytics',
    documentClient,
    {
      scheduleDueIndexName:
        process.env.ANALYTICS_SCHEDULE_INDEX_NAME ?? 'ScheduleDueIndex',
    },
  )
  const cognito = new AwsCognitoClient()
  const render = createAnalyticsScheduleRenderer({
    directory: new DynamoDbProjectDirectoryClient(),
    workItems: new DynamoDbTeamIssuesClient(),
    workspaceAccess: new DynamoDbWorkspaceAccessClient(),
    systemAdmin: {
      async isSystemAdmin(userId) {
        try {
          return await cognito.isSystemAdmin(userId)
        } catch (error) {
          if (
            error instanceof CognitoServiceError &&
            error.code === 'UserNotFoundException'
          ) return false
          throw error
        }
      },
    },
    auditEvents: new DynamoDbAuditEventsClient(
      documentClient,
      process.env.AUDIT_EVENTS_TABLE_NAME ?? 'mukuroji-audit-events',
      {},
      dynamoDbClient,
      Boolean(configuredDynamoDbEndpoint),
    ),
  })

  return async (event: AnalyticsScheduleEvent = {}) =>
    await processAnalyticsSchedule(
      resolveAnalyticsScheduleProcessingTime(event),
      { repository, render, renderArtifact: renderInAppAnalyticsArtifact },
    )
}
