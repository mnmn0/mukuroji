import { DEFAULT_WORKSPACE_CALENDAR_SETTINGS, DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS } from '@mukuroji/contracts'
import {
  AwsCognitoClient,
  CognitoServiceError,
} from '../../modules/authentication'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import {
  DynamoDbDocumentAuthorizationRevisionMutationAdapter,
} from '../../modules/documents/adapter-out/dynamodb/document-authorization'
import { createWorkflowStatusPhaseLookup, DynamoDbTeamIssuesClient } from '../../modules/work-items'
import { createWorkItemConfigurationClient } from './api-dependencies'
import {
  createAnalyticsScheduleRenderer,
  DynamoDbAnalyticsRepository,
  processAnalyticsSchedule,
  renderInAppAnalyticsArtifact,
  resolveAnalyticsScheduleProcessingTime,
  createAnalyticsDeliveryAuditNotifier,
  type AnalyticsScheduleEvent,
} from '../../modules/analytics'
import {
  DynamoDbAuditEventsClient,
  getConfiguredAuditRetentionDays,
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
import {
  createProductionTenantAdministrationClient,
  createProductionTenantFeatureGate,
} from './tenant-administration'

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
  const tenantFeatureGate = createProductionTenantFeatureGate()
  const tenantAdministration = createProductionTenantAdministrationClient()
  const workItemConfigurations = createWorkItemConfigurationClient()
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
    workItemHistory: repository,
    workspaceCalendar: {
      /**
       * Reads the report Workspace's calendar settings from its tenant profile.
       *
       * @param workspaceId - Workspace that owns the report.
       * @returns The saved settings, or the defaults when none are saved.
       */
      async readCalendarSettings(workspaceId) {
        const profile = await tenantAdministration.getProfile(workspaceId)
        return profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS
      },
    },
    workflowStatuses: {
      /**
       * Reads each Team's workflow statuses once, with the Workspace phase names (ADR 0115).
       *
       * @param workspaceId - Workspace that owns the report.
       * @param teamIds - Teams whose Work Items the report counts.
       * @returns The catalog that names and phases the `status-time` groups.
       */
      async readCatalog(workspaceId, teamIds) {
        const [profile, configurations] = await Promise.all([
          tenantAdministration.getProfile(workspaceId),
          Promise.all(teamIds.map(async (teamId) =>
            [teamId, await workItemConfigurations.getTeamConfiguration(workspaceId, teamId)] as const)),
        ])
        const phases = profile?.workPhases ?? DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS
        return {
          teams: new Map(configurations.map(([teamId, resolved]) => [teamId, createWorkflowStatusPhaseLookup(resolved.configuration)])),
          phaseLabels: new Map(phases.phases.flatMap((phase) => phase.label === undefined ? [] : [[phase.key, phase.label] as const])),
        }
      },
    },
  })

  const notifyDelivery = createAnalyticsDeliveryAuditNotifier({
    documentClient,
    auditEventsTableName: resourceConfig.auditEventsTableName,
    auditRetentionDays: getConfiguredAuditRetentionDays(),
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
        notifyDelivery,
      },
    )
  }

  return handleAnalyticsSchedule
}
