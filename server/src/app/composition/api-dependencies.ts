import type {
  ResolvedWorkItemConfiguration,
  WorkItemRelationMutationResponse,
  WorkItemRelationType,
} from '@mukuroji/contracts'
import {
  createCanonicalPublicWorkItemService,
  shouldEnableWorkspaceSearchProjection,
  testEnterpriseIdentityProviderConnection,
} from '../../api/api-router'
import type {
  AppDependencyOverrides,
  AppDependencies,
  AuthenticationDependencies,
  AutomationDependencies,
  DeveloperPlatformDependencies,
  WorkItemDependencies,
  WorkspaceDependencies,
} from './app-dependencies'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { createCognitoClient } from '../../modules/authentication'
import {
  DynamoDbDashboardSummaryClient,
} from '../../modules/analytics'
import {
  DynamoDbAnalyticsRepository,
  InMemoryAnalyticsRepository,
} from '../../modules/analytics/analytics'
import {
  DynamoDbAuditEventsClient,
  getConfiguredAuditTableName,
} from '../../modules/audit/audit'
import { DynamoDbAutomationClient } from '../../modules/automation/automation'
import { SecretsManagerAutomationInboundWebhookSecretStore } from '../../modules/automation/automation-inbound-webhook'
import { DynamoDbCollaborationClient } from '../../modules/collaboration/collaboration'
import { createDynamoDbDeveloperPlatformAdapters } from '../../modules/developer-platform/adapter-out/dynamodb/developer-platform-adapters'
import { DynamoDbDocumentsClient } from '../../modules/documents/documents'
import {
  createEnterpriseIdentityClient,
} from '../../modules/enterprise-identity/enterprise-identity'
import {
  createEnterpriseSessionActivityClient,
} from '../../modules/enterprise-identity/enterprise-session-activity'
import { createDefaultFileProofingClient } from '../../modules/files/file-proofing'
import { DynamoDbNotificationsClient } from '../../modules/notifications/notifications'
import {
  DynamoDbPlanningClient,
  InMemoryPlanningClient,
} from '../../modules/planning/planning'
import { DynamoDbRealtimeTicketsClient } from '../../modules/realtime/realtime-ticket'
import { createDefaultRequestIntakeClient } from '../../modules/request-intake/request-intake'
import {
  createDefaultWorkItemImportExecutionStore,
  createDefaultWorkItemImportQueue,
  createDefaultWorkItemImportSourceStore,
} from '../../modules/work-items/work-item-import-aws'
import {
  DEFAULT_WORK_ITEM_CONFIGURATION,
  DynamoDbWorkItemConfigurationClient,
  type MutateWorkItemRelationInput,
  type WorkItemConfigurationClient,
} from '../../modules/work-items/work-item-configuration'
import {
  DynamoDbProjectTasksClient,
  DynamoDbTeamIssuesClient,
  type WorkItemImportQueue,
  type WorkItemImportSourceStore,
} from '../../modules/work-items'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import { DynamoDbWorkspaceAccessClient } from '../../modules/workspace-access/workspace-access'
import { DynamoDbWorkspaceSearchClient } from '../../modules/workspace-search/workspace-search'
import { createProductionQueueWebhookDeliveryMessage } from './webhook'

/**
 * Creates the configured immutable audit event adapter.
 *
 * @returns A DynamoDB-backed audit event client.
 */
export function createAuditEventsClient(): DynamoDbAuditEventsClient {
  const dynamoDbClient = createDynamoDbClient()

  return new DynamoDbAuditEventsClient(
    createDynamoDbDocumentClient(dynamoDbClient),
    getConfiguredAuditTableName() ?? 'mukuroji-audit-events',
    {},
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
  )
}

/**
 * Creates the configured Work Item configuration adapter.
 *
 * @returns A DynamoDB-backed Work Item configuration client.
 */
export function createWorkItemConfigurationClient(): WorkItemConfigurationClient {
  const config = loadServerConfig()
  const dynamoDbClient = createDynamoDbClient()
  const workItemTableName =
    config.environment.MUKUROJI_WORK_ITEMS_TABLE ??
    config.environment.WORK_ITEMS_TABLE_NAME ??
    config.environment.MUKUROJI_TEAM_ISSUES_TABLE ??
    config.environment.TEAM_ISSUES_TABLE_NAME ??
    'mukuroji-team-issues-local'

  return new DynamoDbWorkItemConfigurationClient(
    config.environment.WORK_ITEM_CONFIGURATION_TABLE_NAME ??
      'mukuroji-work-item-configuration-local',
    workItemTableName,
    createDynamoDbDocumentClient(dynamoDbClient),
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
  )
}

/**
 * Creates the configured Automation adapter.
 *
 * @returns A DynamoDB-backed Automation client.
 */
export function createAutomationClient(): DynamoDbAutomationClient {
  const config = loadServerConfig()
  const dynamoDbClient = createDynamoDbClient()

  return new DynamoDbAutomationClient(
    config.environment.AUTOMATION_TABLE_NAME ??
      config.environment.MUKUROJI_AUTOMATION_TABLE ??
      'mukuroji-automation-local',
    createDynamoDbDocumentClient(dynamoDbClient),
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
  )
}

/**
 * Creates the configured Planning adapter.
 *
 * @returns A DynamoDB-backed Planning client.
 */
export function createPlanningClient(): DynamoDbPlanningClient {
  const config = loadServerConfig()
  const dynamoDbClient = createDynamoDbClient()
  const workItemTableName =
    config.environment.MUKUROJI_WORK_ITEMS_TABLE ??
    config.environment.WORK_ITEMS_TABLE_NAME ??
    config.environment.MUKUROJI_TEAM_ISSUES_TABLE ??
    config.environment.TEAM_ISSUES_TABLE_NAME ??
    'mukuroji-team-issues-local'

  return new DynamoDbPlanningClient(
    config.environment.PLANNING_TABLE_NAME ?? 'mukuroji-planning-local',
    createDynamoDbDocumentClient(dynamoDbClient),
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
    () => new Date(),
    workItemTableName,
  )
}

/**
 * Creates the configured Analytics repository.
 *
 * @returns A DynamoDB-backed Analytics repository.
 */
export function createAnalyticsRepository(): DynamoDbAnalyticsRepository {
  const config = loadServerConfig()
  const dynamoDbClient = createDynamoDbClient()

  return new DynamoDbAnalyticsRepository(
    config.environment.ANALYTICS_TABLE_NAME ?? 'mukuroji-analytics-local',
    createDynamoDbDocumentClient(dynamoDbClient),
    {
      scheduleDueIndexName:
        config.environment.ANALYTICS_SCHEDULE_INDEX_NAME ?? 'ScheduleDueIndex',
    },
  )
}

/**
 * Creates an in-memory default Work Item configuration port for isolated tests.
 *
 * @returns A Work Item configuration client initialized from the default schema.
 */
export function createDefaultWorkItemConfigurationClient(): WorkItemConfigurationClient {
  const createResolved = (
    scopeType: 'workspace' | 'team',
    scopeId: string,
  ): ResolvedWorkItemConfiguration => ({
    configuration: {
      ...structuredClone(DEFAULT_WORK_ITEM_CONFIGURATION),
      scopeType,
      scopeId,
    },
    inheritedFrom: 'default',
  })

  return {
    async getWorkspaceConfiguration(workspaceId) {
      return createResolved('workspace', workspaceId)
    },
    async getTeamConfiguration(_workspaceId, teamId) {
      return createResolved('team', teamId)
    },
    async saveWorkspaceConfiguration(workspaceId, configuration, usageCheck) {
      await usageCheck()
      return {
        configuration: {
          ...structuredClone(configuration),
          scopeType: 'workspace',
          scopeId: workspaceId,
          revision: configuration.revision + 1,
        },
      }
    },
    async saveTeamConfiguration(_workspaceId, teamId, configuration, usageCheck) {
      await usageCheck()
      return {
        configuration: {
          ...structuredClone(configuration),
          scopeType: 'team',
          scopeId: teamId,
          revision: configuration.revision + 1,
        },
      }
    },
    async listRelations() {
      return { relations: [], graphRevision: 0 }
    },
    async createRelation(_workspaceId, _teamId, input) {
      return createDefaultRelationMutationResponse(input)
    },
    async deleteRelation(_workspaceId, _teamId, input) {
      return createDefaultRelationMutationResponse(input)
    },
  }
}

/**
 * Creates the symmetric relation response used by the in-memory test adapter.
 *
 * @param input - Requested Work Item relation mutation.
 * @returns The relation, reciprocal relation, and next graph revision.
 */
function createDefaultRelationMutationResponse(
  input: MutateWorkItemRelationInput,
): WorkItemRelationMutationResponse {
  const reciprocalTypes: Record<WorkItemRelationType, WorkItemRelationType> = {
    parent: 'child',
    child: 'parent',
    blocks: 'blockedBy',
    blockedBy: 'blocks',
    related: 'related',
    duplicate: 'duplicate',
  }

  return {
    relation: {
      sourceWorkItemId: input.sourceWorkItemId,
      targetWorkItemId: input.targetWorkItemId,
      type: input.type,
    },
    reciprocalRelation: {
      sourceWorkItemId: input.targetWorkItemId,
      targetWorkItemId: input.sourceWorkItemId,
      type: reciprocalTypes[input.type],
    },
    graphRevision: input.expectedGraphRevision + 1,
  }
}

/**
 * Creates the production authentication adapter bundle.
 *
 * @returns Authentication dependencies backed by the configured Cognito adapter.
 */
export function createProductionAuthenticationDependencies(): AuthenticationDependencies {
  return { cognito: createCognitoClient() }
}

/**
 * Creates the production Workspace and Enterprise Identity adapter bundle.
 *
 * @returns Workspace dependencies backed by configured production adapters.
 */
export function createProductionWorkspaceDependencies(): WorkspaceDependencies {
  return {
    dashboardSummary: new DynamoDbDashboardSummaryClient(),
    projectDirectory: new DynamoDbProjectDirectoryClient(),
    auditEvents: createAuditEventsClient(),
    workspaceAccess: new DynamoDbWorkspaceAccessClient(),
    enterpriseIdentity: createEnterpriseIdentityClient(),
    enterpriseSessionActivity: createEnterpriseSessionActivityClient(),
    enterpriseIdentityProviderConnectionTester: testEnterpriseIdentityProviderConnection,
  }
}

/**
 * Creates the production Work Item and collaboration adapter bundle.
 *
 * @returns Work Item dependencies backed by configured production adapters.
 */
export function createProductionWorkItemDependencies(): WorkItemDependencies {
  return {
    projectTasks: new DynamoDbProjectTasksClient(),
    teamIssues: new DynamoDbTeamIssuesClient(),
    realtimeTickets: new DynamoDbRealtimeTicketsClient(),
    collaboration: new DynamoDbCollaborationClient(),
    fileProofing: createDefaultFileProofingClient(),
    notifications: new DynamoDbNotificationsClient(),
    workspaceSearch: new DynamoDbWorkspaceSearchClient(),
    documents: new DynamoDbDocumentsClient(),
    workspaceSearchProjectionEnabled: shouldEnableWorkspaceSearchProjection(),
    workItemConfigurations: createWorkItemConfigurationClient(),
    planning: createPlanningClient(),
    requestIntake: createDefaultRequestIntakeClient(),
    analytics: createAnalyticsRepository(),
  }
}

/**
 * Creates the production Automation adapter bundle.
 *
 * @returns Automation dependencies backed by configured production adapters.
 */
export function createProductionAutomationDependencies(): AutomationDependencies {
  return {
    automation: createAutomationClient(),
    automationInboundWebhookSecrets:
      new SecretsManagerAutomationInboundWebhookSecretStore(),
  }
}

/**
 * Creates the production Developer Platform adapter bundle.
 *
 * @returns Developer Platform dependencies backed by configured production adapters.
 */
export function createProductionDeveloperPlatformDependencies(): DeveloperPlatformDependencies {
  const adapters = createDynamoDbDeveloperPlatformAdapters()
  return {
    ...adapters,
    publicWorkItems: createCanonicalPublicWorkItemService(),
    workItemImportExecutions: createDefaultWorkItemImportExecutionStore(),
    workItemImportSources: createDefaultWorkItemImportSourceStore(),
    workItemImportQueue: createDefaultWorkItemImportQueue(),
    queueWebhookDelivery: createProductionQueueWebhookDeliveryMessage(),
  }
}

/**
 * Creates a Work Item import source port that validates production resources only when used.
 *
 * Connector workers do not process imports, so deferring this unrelated adapter prevents
 * connector startup from requiring the import bucket while retaining a complete dependency graph.
 *
 * @returns A lazily initialized Work Item import source store.
 */
function createLazyWorkItemImportSourceStore(): WorkItemImportSourceStore {
  let sourceStore: WorkItemImportSourceStore | undefined

  /** Resolves the production source store on first import operation. */
  function resolveSourceStore(): WorkItemImportSourceStore {
    sourceStore ??= createDefaultWorkItemImportSourceStore()
    return sourceStore
  }

  return {
    putImmutable(request) {
      return resolveSourceStore().putImmutable(request)
    },
    getVerified(locator, expected) {
      return resolveSourceStore().getVerified(locator, expected)
    },
    deleteVersion(locator, expected) {
      return resolveSourceStore().deleteVersion(locator, expected)
    },
  }
}

/**
 * Creates a Work Item import queue port that validates production resources only when used.
 *
 * @returns A lazily initialized Work Item import queue.
 */
function createLazyWorkItemImportQueue(): WorkItemImportQueue {
  let queue: WorkItemImportQueue | undefined

  /** Resolves the production import queue on first enqueue operation. */
  function resolveQueue(): WorkItemImportQueue {
    queue ??= createDefaultWorkItemImportQueue()
    return queue
  }

  return {
    enqueue(message) {
      return resolveQueue().enqueue(message)
    },
  }
}

/**
 * Creates the complete dependency context required by Connector synchronization workers.
 *
 * Unrelated Work Item import adapters remain lazy so the Connector Lambda requires only
 * Connector resources at startup.
 *
 * @returns A production dependency graph suitable for Connector worker invocations.
 */
export function createProductionConnectorAppDependencies(): AppDependencies {
  const adapters = createDynamoDbDeveloperPlatformAdapters()
  return {
    authentication: createProductionAuthenticationDependencies(),
    workspace: createProductionWorkspaceDependencies(),
    workItems: createProductionWorkItemDependencies(),
    automation: createProductionAutomationDependencies(),
    developerPlatform: {
      ...adapters,
      publicWorkItems: createCanonicalPublicWorkItemService(),
      workItemImportExecutions: createDefaultWorkItemImportExecutionStore(),
      workItemImportSources: createLazyWorkItemImportSourceStore(),
      workItemImportQueue: createLazyWorkItemImportQueue(),
      queueWebhookDelivery: createProductionQueueWebhookDeliveryMessage(),
    },
  }
}

/**
 * Creates all production dependency bundles for one API application instance.
 *
 * @returns A nested, domain-owned dependency graph.
 */
export function createProductionAppDependencies(): AppDependencies {
  return {
    authentication: createProductionAuthenticationDependencies(),
    workspace: createProductionWorkspaceDependencies(),
    workItems: createProductionWorkItemDependencies(),
    automation: createProductionAutomationDependencies(),
    developerPlatform: createProductionDeveloperPlatformDependencies(),
  }
}

/**
 * Creates an isolated dependency graph for server tests.
 *
 * @returns Test dependencies with in-memory Planning and Analytics adapters.
 */
export function createTestAppDependencies(): AppDependencies {
  const production = createProductionAppDependencies()
  return {
    ...production,
    workItems: {
      ...production.workItems,
      workItemConfigurations: createDefaultWorkItemConfigurationClient(),
      planning: new InMemoryPlanningClient(),
      analytics: new InMemoryAnalyticsRepository(),
    },
  }
}

/**
 * Applies flat test overrides to their owning dependency bundles.
 *
 * @param dependencies - Existing nested dependency graph.
 * @param overrides - Domain port implementations to replace.
 * @returns A new dependency graph without mutating the input graph.
 */
export function overrideAppDependencies(
  dependencies: AppDependencies,
  overrides: AppDependencyOverrides,
): AppDependencies {
  return {
    authentication: {
      ...dependencies.authentication,
      ...(overrides.cognito ? { cognito: overrides.cognito } : {}),
    },
    workspace: {
      ...dependencies.workspace,
      ...(overrides.dashboardSummary
        ? { dashboardSummary: overrides.dashboardSummary }
        : {}),
      ...(overrides.projectDirectory
        ? { projectDirectory: overrides.projectDirectory }
        : {}),
      ...(overrides.auditEvents ? { auditEvents: overrides.auditEvents } : {}),
      ...(overrides.workspaceAccess
        ? { workspaceAccess: overrides.workspaceAccess }
        : {}),
      ...(overrides.enterpriseIdentity
        ? { enterpriseIdentity: overrides.enterpriseIdentity }
        : {}),
      ...(overrides.enterpriseSessionActivity
        ? { enterpriseSessionActivity: overrides.enterpriseSessionActivity }
        : {}),
      ...(overrides.enterpriseIdentityProviderConnectionTester
        ? {
            enterpriseIdentityProviderConnectionTester:
              overrides.enterpriseIdentityProviderConnectionTester,
          }
        : {}),
    },
    workItems: {
      ...dependencies.workItems,
      ...(overrides.projectTasks ? { projectTasks: overrides.projectTasks } : {}),
      ...(overrides.teamIssues ? { teamIssues: overrides.teamIssues } : {}),
      ...(overrides.realtimeTickets
        ? { realtimeTickets: overrides.realtimeTickets }
        : {}),
      ...(overrides.collaboration ? { collaboration: overrides.collaboration } : {}),
      ...(overrides.fileProofing ? { fileProofing: overrides.fileProofing } : {}),
      ...(overrides.notifications ? { notifications: overrides.notifications } : {}),
      ...(overrides.workspaceSearch
        ? { workspaceSearch: overrides.workspaceSearch }
        : {}),
      ...(overrides.documents ? { documents: overrides.documents } : {}),
      ...(overrides.workspaceSearchProjectionEnabled === undefined
        ? {}
        : {
            workspaceSearchProjectionEnabled:
              overrides.workspaceSearchProjectionEnabled,
          }),
      ...(overrides.workItemConfigurations
        ? { workItemConfigurations: overrides.workItemConfigurations }
        : {}),
      ...(overrides.planning ? { planning: overrides.planning } : {}),
      ...(overrides.requestIntake ? { requestIntake: overrides.requestIntake } : {}),
      ...(overrides.analytics ? { analytics: overrides.analytics } : {}),
    },
    automation: {
      ...dependencies.automation,
      ...(overrides.automation ? { automation: overrides.automation } : {}),
      ...(overrides.automationInboundWebhookSecrets
        ? {
            automationInboundWebhookSecrets:
              overrides.automationInboundWebhookSecrets,
          }
        : {}),
    },
    developerPlatform: {
      ...dependencies.developerPlatform,
      ...(overrides.apiKeys ? { apiKeys: overrides.apiKeys } : {}),
      ...(overrides.oauthCredentials
        ? { oauthCredentials: overrides.oauthCredentials }
        : {}),
      ...(overrides.webhookSubscriptions
        ? { webhookSubscriptions: overrides.webhookSubscriptions }
        : {}),
      ...(overrides.webhookDeliveries
        ? { webhookDeliveries: overrides.webhookDeliveries }
        : {}),
      ...(overrides.connectors ? { connectors: overrides.connectors } : {}),
      ...(overrides.externalLinks ? { externalLinks: overrides.externalLinks } : {}),
      ...(overrides.imports ? { imports: overrides.imports } : {}),
      ...(overrides.idempotency ? { idempotency: overrides.idempotency } : {}),
      ...(overrides.rateLimits ? { rateLimits: overrides.rateLimits } : {}),
      ...(overrides.transactions ? { transactions: overrides.transactions } : {}),
      ...(overrides.publicWorkItems
        ? { publicWorkItems: overrides.publicWorkItems }
        : {}),
      ...(overrides.workItemImportExecutions
        ? { workItemImportExecutions: overrides.workItemImportExecutions }
        : {}),
      ...(overrides.workItemImportSources
        ? { workItemImportSources: overrides.workItemImportSources }
        : {}),
      ...(overrides.workItemImportQueue
        ? { workItemImportQueue: overrides.workItemImportQueue }
        : {}),
      ...(overrides.queueWebhookDelivery
        ? { queueWebhookDelivery: overrides.queueWebhookDelivery }
        : {}),
    },
  }
}
