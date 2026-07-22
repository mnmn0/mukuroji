import {
  createAutomationActionExecutor,
  shouldEnableWorkspaceSearchProjection,
  type AutomationActionExecutorDependencies,
} from '../../api/api-router'
import {
  createAuditEventsClient,
  createAutomationClient,
  createWorkItemConfigurationClient,
} from './api-dependencies'
import {
  createAutomationEventProcessor,
  processAutomationEventBatch,
  type DynamoStreamEvent,
} from '../../modules/automation/adapter-in/events/automation-event'
import {
  processAutomationSchedule,
  resolveAutomationScheduleProcessingTime,
  type AutomationScheduleEvent,
} from '../../modules/automation/adapter-in/schedules/automation-schedule'
import {
  AutomationEngine,
  DynamoDbAutomationClient,
} from '../../modules/automation/automation'
import {
  SecretsManagerAutomationInboundWebhookSecretStore,
} from '../../modules/automation/automation-inbound-webhook'
import { createCognitoClient } from '../../modules/authentication'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import { createDefaultFileProofingClient } from '../../modules/files/file-proofing'
import { DynamoDbTeamIssuesClient } from '../../modules/work-items'
import { DynamoDbWorkspaceAccessClient } from '../../modules/workspace-access/workspace-access'
import { DynamoDbWorkspaceSearchClient } from '../../modules/workspace-search/workspace-search'

/**
 * Creates only the production ports used by Automation actions.
 *
 * @param automation - Automation persistence shared with the engine.
 * @param teamIssues - Canonical Work Item persistence shared with event processing.
 * @returns Explicit action dependencies without API-only or import-worker adapters.
 */
function createAutomationActionDependencies(
  automation: DynamoDbAutomationClient,
  teamIssues: DynamoDbTeamIssuesClient,
): AutomationActionExecutorDependencies {
  return {
    cognito: createCognitoClient(),
    projectDirectory: new DynamoDbProjectDirectoryClient(),
    workspaceAccess: new DynamoDbWorkspaceAccessClient(),
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
  const processor = createAutomationEventProcessor(
    automationClient,
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
  const inboundWebhookSecrets = new SecretsManagerAutomationInboundWebhookSecretStore()
  const actionExecutor = createAutomationActionExecutor(
    createAutomationActionDependencies(
      automationClient,
      new DynamoDbTeamIssuesClient(),
    ),
  )

  return (event: AutomationScheduleEvent = {}) =>
    processAutomationSchedule(
      resolveAutomationScheduleProcessingTime(event),
      {
        client: automationClient,
        actionExecutor,
        inboundWebhookSecrets,
      },
    )
}
