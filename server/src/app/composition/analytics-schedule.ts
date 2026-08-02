import {
  AwsCognitoClient,
  CognitoServiceError,
} from '../../modules/authentication'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import {
  DynamoDbDocumentAuthorizationRevisionMutationAdapter,
} from '../../modules/documents/adapter-out/dynamodb/document-authorization'
import { DynamoDbTeamIssuesClient } from '../../modules/work-items'
import {
  createAnalyticsScheduleRenderer,
  DynamoDbAnalyticsRepository,
  processAnalyticsSchedule,
  renderInAppAnalyticsArtifact,
  resolveAnalyticsScheduleProcessingTime,
  type AnalyticsScheduleEvent,
} from '../../modules/analytics'
import {
  DynamoDbAuditEventsClient,
} from '../../modules/audit'
import { DynamoDbWorkspaceAccessClient } from '../../modules/workspace-access'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from '../../infrastructure/aws/dynamodb-client'
import {
  loadServerDynamoDbResourceConfig,
} from '../../infrastructure/config/server-resource-config'
import { createProductionTenantFeatureGate } from './tenant-administration'

/**
 * Creates the production Analytics schedule processor.
 *
 * @returns A handler that renders and delivers due Analytics reports.
 */
export function createProductionAnalyticsScheduleHandler() {
  const resourceConfig = loadServerDynamoDbResourceConfig()
  const dynamoDbClient = createDynamoDbClient()
  const documentClient = createDynamoDbDocumentClient(dynamoDbClient)
  const repository = new DynamoDbAnalyticsRepository(
    resourceConfig.analyticsTableName,
    documentClient,
    {
      scheduleDueIndexName: resourceConfig.analyticsScheduleIndexName,
    },
  )
  const cognito = new AwsCognitoClient()
  const tenantFeatureGate = createProductionTenantFeatureGate('analytics')
  const render = createAnalyticsScheduleRenderer({
    directory: new DynamoDbProjectDirectoryClient(),
    workItems: new DynamoDbTeamIssuesClient(),
    workspaceAccess: new DynamoDbWorkspaceAccessClient({
      documentAuthorizationRevisionMutationPort:
        new DynamoDbDocumentAuthorizationRevisionMutationAdapter(),
    }),
    systemAdmin: {
      /**
       * Resolves current system-administrator membership through Cognito.
       *
       * @param userId - Cognito user identifier to evaluate.
       * @returns Whether the user currently belongs to a system administrator group.
       */
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
      resourceConfig.auditEventsTableName,
      {},
      dynamoDbClient,
      shouldBootstrapLocalDynamoDb(),
    ),
  })

  /**
   * Processes one Analytics schedule invocation.
   *
   * @param event - Optional schedule time override supplied by EventBridge or tests.
   * @returns The due-report processing summary.
   */
  async function handleAnalyticsSchedule(event: AnalyticsScheduleEvent = {}) {
    return await processAnalyticsSchedule(
      resolveAnalyticsScheduleProcessingTime(event),
      {
        repository,
        entitlement: {
          isAnalyticsEnabled: (workspaceId) => tenantFeatureGate.isEnabled(workspaceId),
        },
        render,
        renderArtifact: renderInAppAnalyticsArtifact,
      },
    )
  }

  return handleAnalyticsSchedule
}
