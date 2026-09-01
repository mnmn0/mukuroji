import {
  createAutomationActionExecutor,
  shouldEnableWorkspaceSearchProjection,
  type AutomationActionExecutorDependencies,
} from '../../api/api-router'
import {
  createAuditEventsClient,
  createAutomationInboundWebhookSecretStore,
  createAutomationRepository,
  createPlanningClient,
  createWorkItemConfigurationClient,
} from './api-dependencies'
import {
  createAutomationEventProcessor,
  processAutomationEventBatch,
  type AutomationScheduleEvent,
  AutomationEngine,
  type AutomationRuleTemplatePort,
  type DynamoStreamEvent,
  processAutomationSchedule,
  resolveAutomationScheduleProcessingTime,
} from '../../modules/automation'
import { createCognitoClient } from '../../modules/authentication'
import { DynamoDbCollaborationClient } from '../../modules/collaboration/collaboration'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import {
  DynamoDbDocumentAuthorizationRevisionMutationAdapter,
} from '../../modules/documents/adapter-out/dynamodb/document-authorization'
import { createDefaultFileProofingClient } from '../../modules/files/file-proofing'
import { DynamoDbCustomerClient } from '../../modules/customers'
import { DynamoDbTeamIssuesClient } from '../../modules/work-items'
import { DynamoDbWorkspaceAccessClient } from '../../modules/workspace-access/workspace-access'
import { DynamoDbWorkspaceSearchClient } from '../../modules/workspace-search/workspace-search'
import { createProductionTenantFeatureGate } from './tenant-administration'

/**
 * Creates only the production ports used by Automation actions.
 *
 * @param automation - Focused template-version read used by Automation actions.
 * @param teamIssues - Canonical Work Item persistence shared with event processing.
 * @returns Explicit action dependencies without API-only or import-worker adapters.
 */
function createAutomationActionDependencies(
  automation: Pick<AutomationRuleTemplatePort, 'getTemplateVersion'>,
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
    customers: new DynamoDbCustomerClient(),
    collaboration: new DynamoDbCollaborationClient(),
    workItemConfigurations: createWorkItemConfigurationClient(),
    planning: createPlanningClient(),
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
  const automationRepository = createAutomationRepository()
  const teamIssues = new DynamoDbTeamIssuesClient()
  const actionDependencies = createAutomationActionDependencies(automationRepository, teamIssues)
  const actionExecutor = createAutomationActionExecutor(
    actionDependencies,
  )
  const tenantFeatureGate = createProductionTenantFeatureGate('automation')
  const processor = createAutomationEventProcessor(
    automationRepository,
    {
      isAutomationEnabled: (workspaceId) => tenantFeatureGate.isEnabled(workspaceId),
    },
    new AutomationEngine(automationRepository, actionExecutor),
    teamIssues,
    actionDependencies.customers,
  )

  return (event: DynamoStreamEvent) => processAutomationEventBatch(event, processor)
}

/**
 * Creates the production Automation schedule processor.
 *
 * @returns A handler for due Automation work.
 */
export function createProductionAutomationScheduleHandler() {
  const automationRepository = createAutomationRepository()
  const inboundWebhookSecrets = createAutomationInboundWebhookSecretStore()
  const actionExecutor = createAutomationActionExecutor(
    createAutomationActionDependencies(
      automationRepository,
      new DynamoDbTeamIssuesClient(),
    ),
  )
  const tenantFeatureGate = createProductionTenantFeatureGate('automation')

  return (event: AutomationScheduleEvent = {}) =>
    processAutomationSchedule(
      resolveAutomationScheduleProcessingTime(event),
      {
        client: automationRepository,
        entitlement: {
          isAutomationEnabled: (workspaceId) => tenantFeatureGate.isEnabled(workspaceId),
        },
        actionExecutor,
        inboundWebhookSecrets,
      },
    )
}
