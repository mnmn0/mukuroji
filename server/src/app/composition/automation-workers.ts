import {
  createAutomationActionExecutor,
  shouldEnableWorkspaceSearchProjection,
  type AutomationActionExecutorDependencies,
} from '../../api/api-router'
import {
  createAuditEventsClient,
  createAutomationInboundWebhookSecretStore,
  createAutomationClient,
  createWorkItemConfigurationClient,
} from './api-dependencies'
import {
  createAutomationEventProcessor,
  processAutomationEventBatch,
  type AutomationScheduleEvent,
  AutomationEngine,
  DynamoDbAutomationRepository,
  type DynamoStreamEvent,
  processAutomationSchedule,
  resolveAutomationScheduleProcessingTime,
} from '../../modules/automation'
import { createCognitoClient } from '../../modules/authentication'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import {
  DynamoDbDocumentAuthorizationRevisionMutationAdapter,
} from '../../modules/documents/adapter-out/dynamodb/document-authorization'
import { createDefaultFileProofingClient } from '../../modules/files/file-proofing'
import { DynamoDbTeamIssuesClient } from '../../modules/work-items'
import { DynamoDbWorkspaceAccessClient } from '../../modules/workspace-access/workspace-access'
import { DynamoDbWorkspaceSearchClient } from '../../modules/workspace-search/workspace-search'
import { createProductionTenantFeatureGate } from './tenant-administration'

/**
 * Creates only the production ports used by Automation actions.
 *
 * @param automation - Automation persistence shared with the engine.
 * @param teamIssues - Canonical Work Item persistence shared with event processing.
 * @returns Explicit action dependencies without API-only or import-worker adapters.
 */
function createAutomationActionDependencies(
  automation: DynamoDbAutomationRepository,
  teamIssues: DynamoDbTeamIssuesClient,
): AutomationActionExecutorDependencies {
  return {
    cognito: createCognitoClient(),
    projectDirectory: new DynamoDbProjectDirectoryClient(),
    workspaceAccess: new DynamoDbWorkspaceAccessClient({
      documentAuthorizationRevisionMutationPort:
        new DynamoDbDocumentAuthorizationRevisionMutationAdapter(),
    }),
    auditEvents: createAuditEventsClient(),
    teamIssues,
    workItemConfigurations: createWorkItemConfigurationClient(),
    fileProofing: createDefaultFileProofingClient(),
    workspaceSearch: new DynamoDbWorkspaceSearchClient(),
    workspaceSearchProjectionEnabled: shouldEnableWorkspaceSearchProjection(),
    automation,
  }
}

/**
 * Creates the production Automation event-stream processor.
 *
 * @returns A handler for Automation DynamoDB stream batches.
 */
export function createProductionAutomationEventHandler() {
  const automationClient = createAutomationClient()
  const teamIssues = new DynamoDbTeamIssuesClient()
  const actionExecutor = createAutomationActionExecutor(
    createAutomationActionDependencies(automationClient, teamIssues),
  )
  const tenantFeatureGate = createProductionTenantFeatureGate('automation')
  const processor = createAutomationEventProcessor(
    automationClient,
    {
      isAutomationEnabled: (workspaceId) => tenantFeatureGate.isEnabled(workspaceId),
    },
    new AutomationEngine(automationClient, actionExecutor),
    teamIssues,
  )

  return (event: DynamoStreamEvent) => processAutomationEventBatch(event, processor)
}

/**
 * Creates the production Automation schedule processor.
 *
 * @returns A handler for due Automation work.
 */
export function createProductionAutomationScheduleHandler() {
  const automationClient = createAutomationClient()
  const inboundWebhookSecrets = createAutomationInboundWebhookSecretStore()
  const actionExecutor = createAutomationActionExecutor(
    createAutomationActionDependencies(
      automationClient,
      new DynamoDbTeamIssuesClient(),
    ),
  )
  const tenantFeatureGate = createProductionTenantFeatureGate('automation')

  return (event: AutomationScheduleEvent = {}) =>
    processAutomationSchedule(
      resolveAutomationScheduleProcessingTime(event),
      {
        client: automationClient,
        entitlement: {
          isAutomationEnabled: (workspaceId) => tenantFeatureGate.isEnabled(workspaceId),
        },
        actionExecutor,
        inboundWebhookSecrets,
      },
    )
}
