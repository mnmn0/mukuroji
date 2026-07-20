import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  AwsCognitoClient,
  CognitoServiceError,
  DynamoDbProjectDirectoryClient,
  DynamoDbTeamIssuesClient,
} from '../app/createApp'
import {
  DynamoDbAnalyticsRepository,
} from '../modules/analytics/analytics'
import {
  createAnalyticsScheduleRenderer,
  processAnalyticsSchedule,
  renderInAppAnalyticsArtifact,
  resolveAnalyticsScheduleProcessingTime,
  type AnalyticsScheduleEvent,
} from '../modules/analytics/adapter-in/schedules/analytics-schedule'
import {
  DynamoDbAuditEventsClient,
  getConfiguredDynamoDbEndpoint,
} from '../modules/audit/audit'
import {
  DynamoDbWorkspaceAccessClient,
} from '../modules/workspace-access/workspace-access'

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

/** EventBridge から due Analytics reports を処理します。 */
export async function handler(event: AnalyticsScheduleEvent = {}) {
  return await processAnalyticsSchedule(
    resolveAnalyticsScheduleProcessingTime(event),
    { repository, render, renderArtifact: renderInAppAnalyticsArtifact },
  )
}

export * from '../modules/analytics/adapter-in/schedules/analytics-schedule'
