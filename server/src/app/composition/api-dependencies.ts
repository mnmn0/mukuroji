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
  OperationalDependencies,
  WorkItemDependencies,
  WorkspaceDependencies,
} from './app-dependencies'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
  createWorkspaceSearchWriterDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from '../../infrastructure/aws/dynamodb-client'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import {
  recordApiAccess,
  recordApiError,
} from '../../infrastructure/observability/api-observability'
import { createDynamoDbReadinessProbe } from '../../infrastructure/observability/readiness'
import {
  createStaticRuntimeControlProvider,
} from '../../infrastructure/runtime/runtime-control'
import {
  createProductionRuntimeControlProvider,
  createProductionRuntimeControlObservationRecorder,
} from './runtime-control'
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
  getConfiguredAuditRetentionDays,
  getConfiguredAuditTableName,
} from '../../modules/audit/audit'
import { DynamoDbAutomationRepository } from '../../modules/automation'
import { SecretsManagerAutomationInboundWebhookSecretStore } from '../../modules/automation'
import { DynamoDbCollaborationClient } from '../../modules/collaboration/collaboration'
import { createDynamoDbDeveloperPlatformAdapters } from '../../modules/developer-platform/adapter-out/dynamodb/developer-platform-adapters'
import type { DeveloperPlatformTransactionPort } from '../../modules/developer-platform/adapter-out/dynamodb/developer-platform-transaction-port'
import type { IdempotencyPort } from '../../modules/developer-platform'
import {
  DynamoDbDocumentsClient,
} from '../../modules/documents/adapter-out/dynamodb/dynamo-db-documents-client'
import {
  DynamoDbDocumentAuthorizationRevisionMutationAdapter,
} from '../../modules/documents/adapter-out/dynamodb/document-authorization'
import {
  createEnterpriseIdentityClient,
  createEnterpriseIdentityCapabilities,
} from '../../modules/enterprise-identity'
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
import {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
  type WorkspaceSeatMeter,
} from '../../modules/workspace-access/workspace-access'
import {
  TenantAdministrationError,
  type TenantEntitlementEnforcement,
} from '../../modules/tenant-administration'
import { DynamoDbWorkspaceSearchClient } from '../../modules/workspace-search/workspace-search'
import { createProductionQueueWebhookDeliveryMessage } from './webhook'
import {
  DynamoDbTimeTrackingRepository,
  InMemoryTimeTrackingRepository,
  TimeTrackingService,
  type TimeTrackingIdempotencyPort,
} from '../../modules/time-tracking'
import { createProductionTenantAdministrationClient } from './tenant-administration'

/**
 * Projects shared idempotency reservation and transaction-completion capabilities
 * into the time-tracking application port.
 *
 * @param idempotency - Shared durable reservation and replay capability.
 * @param transactions - Shared DynamoDB transaction contribution capability.
 * @returns A time-tracking-specific idempotency port.
 */
function createTimeTrackingIdempotencyPort(
  idempotency: IdempotencyPort,
  transactions: DeveloperPlatformTransactionPort,
): TimeTrackingIdempotencyPort {
  const prepareCompletion = transactions.prepareIdempotencyCompletionTransactWrite
  return {
    reserveIdempotency: (request) => idempotency.reserveIdempotency(request),
    completeIdempotency: (request) => idempotency.completeIdempotency(request),
    releaseIdempotency: (request) => idempotency.releaseIdempotency(request),
    ...(prepareCompletion
      ? {
          prepareIdempotencyCompletion: async (request) =>
            (await prepareCompletion.call(transactions, request)).transactWriteItem,
        }
      : {}),
  }
}

/**
 * Creates the configured immutable audit event adapter.
 *
 * @returns A DynamoDB-backed audit event client.
 */
export function createAuditEventsClient(): DynamoDbAuditEventsClient {
  const dynamoDbClient = createDynamoDbClient()

  return new DynamoDbAuditEventsClient(
    createWorkspaceSearchWriterDynamoDbDocumentClient(dynamoDbClient),
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
    createWorkspaceSearchWriterDynamoDbDocumentClient(dynamoDbClient),
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
  )
}

/**
 * Creates the configured Automation adapter.
 *
 * @returns A DynamoDB-backed Automation repository.
 */
export function createAutomationClient(): DynamoDbAutomationRepository {
  const config = loadServerConfig()
  const dynamoDbClient = createDynamoDbClient()

  return new DynamoDbAutomationRepository(
    config.environment.AUTOMATION_TABLE_NAME ??
      config.environment.MUKUROJI_AUTOMATION_TABLE ??
      'mukuroji-automation-local',
    createDynamoDbDocumentClient(dynamoDbClient),
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
  )
}

/**
 * Creates the configured inbound Webhook secret-store adapter.
 *
 * @returns A Secrets Manager-backed secret store using centralized server configuration.
 */
export function createAutomationInboundWebhookSecretStore(
): SecretsManagerAutomationInboundWebhookSecretStore {
  return new SecretsManagerAutomationInboundWebhookSecretStore(
    createSecretsManagerClient(),
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
  const tableName = config.environment.ANALYTICS_TABLE_NAME
  if (config.production && !tableName) {
    throw new Error('ANALYTICS_TABLE_NAME must be set for durable analytics storage.')
  }

  return new DynamoDbAnalyticsRepository(
    tableName ?? 'mukuroji-analytics-local',
    createDynamoDbDocumentClient(dynamoDbClient),
    {
      scheduleDueIndexName:
        config.environment.ANALYTICS_SCHEDULE_INDEX_NAME ?? 'ScheduleDueIndex',
    },
  )
}

/**
 * Creates the configured durable time tracking service.
 *
 * @param idempotency - Optional shared receipt store used for mutation replay.
 * @returns A configured time tracking service.
 */
export function createTimeTrackingService(idempotency?: TimeTrackingIdempotencyPort): TimeTrackingService {
  const config = loadServerConfig()
  const dynamoDbClient = createDynamoDbClient()
  const tableName = config.environment.ANALYTICS_TABLE_NAME
  const auditTableName = getConfiguredAuditTableName()
  if (config.production && !tableName) {
    throw new Error('ANALYTICS_TABLE_NAME must be set for durable time tracking storage.')
  }
  if (config.production && !auditTableName) {
    throw new Error('MUKUROJI_AUDIT_EVENTS_TABLE or AUDIT_EVENTS_TABLE_NAME must be set for time tracking audit writes.')
  }
  return new TimeTrackingService(
    new DynamoDbTimeTrackingRepository(
      tableName ?? 'mukuroji-analytics-local',
      createDynamoDbDocumentClient(dynamoDbClient),
    ),
    {
      audit: {
        tableName: auditTableName ?? 'mukuroji-audit-events',
        retentionDays: getConfiguredAuditRetentionDays(),
      },
      ...(idempotency ? { idempotency } : {}),
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
  const enterpriseIdentityClient = createEnterpriseIdentityClient()
  const tenantAdministration = createProductionTenantAdministrationClient()
  let workspaceAccessClient: DynamoDbWorkspaceAccessClient | undefined
  const seatMeter: WorkspaceSeatMeter = {
    /** Initializes missing tenant state before joining seat writes to membership transactions. */
    async prepareSeatMutation(input) {
      try {
        return await tenantAdministration.prepareSeatMutation(input)
      } catch (error) {
        if (
          error instanceof TenantAdministrationError &&
          error.code === 'TenantAdministrationNotInitialized'
        ) {
          if (!workspaceAccessClient) {
            throw new WorkspaceAccessError(
              503,
              'TenantSeatMeterUnavailable',
              'Tenant seat metering is unavailable.',
              { cause: error },
            )
          }
          const activeMembers = await workspaceAccessClient.listActiveMembers(input.workspaceId)
          const owner = activeMembers.find((member) => member.role === 'owner')
          if (!owner) {
            throw new WorkspaceAccessError(
              503,
              'TenantOwnerUnavailable',
              'The Workspace owner required for tenant initialization is unavailable.',
            )
          }
          await tenantAdministration.ensureSnapshot(
            input.workspaceId,
            owner.memberKey,
            activeMembers.length,
          )
          try {
            return await tenantAdministration.prepareSeatMutation(input)
          } catch (retryError) {
            if (retryError instanceof TenantAdministrationError) {
              throw new WorkspaceAccessError(
                retryError.status,
                retryError.code,
                retryError.message,
                { cause: retryError },
              )
            }
            throw retryError
          }
        }
        if (error instanceof TenantAdministrationError) {
          throw new WorkspaceAccessError(
            error.status,
            error.code,
            error.message,
            { cause: error },
          )
        }
        throw error
      }
    },
  }
  workspaceAccessClient = new DynamoDbWorkspaceAccessClient({
    documentAuthorizationRevisionMutationPort:
      new DynamoDbDocumentAuthorizationRevisionMutationAdapter(),
    seatMeter,
  })
  return {
    dashboardSummary: new DynamoDbDashboardSummaryClient(),
    projectDirectory: new DynamoDbProjectDirectoryClient(),
    auditEvents: createAuditEventsClient(),
    workspaceAccess: workspaceAccessClient,
    enterpriseIdentity: createEnterpriseIdentityCapabilities(enterpriseIdentityClient),
    enterpriseSessionActivity: createEnterpriseSessionActivityClient(),
    enterpriseIdentityProviderConnectionTester: testEnterpriseIdentityProviderConnection,
    tenantAdministration,
    tenantEntitlementEnforcement: tenantAdministration,
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
  const automation = createAutomationClient()
  return {
    ruleTemplates: automation,
    inboundWebhooks: automation,
    recurringSchedules: automation,
    executions: automation,
    bulkOperations: automation,
    automationInboundWebhookSecrets: createAutomationInboundWebhookSecretStore(),
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
 * Creates production operational dependencies with live critical-table checks.
 *
 * @returns Operational dependencies backed by fail-closed DynamoDB readiness probes.
 */
export function createProductionOperationalDependencies(): OperationalDependencies {
  return {
    recordRuntimeControl:
      createProductionRuntimeControlObservationRecorder(),
    readiness: createDynamoDbReadinessProbe(),
    recordAccess: recordApiAccess,
    recordError: recordApiError,
    runtimeControl: createProductionRuntimeControlProvider('api'),
  }
}

/**
 * Creates deterministic operational dependencies for isolated server tests.
 *
 * @returns Operational dependencies that explicitly model an available test runtime.
 */
function createTestOperationalDependencies(): OperationalDependencies {
  return {
    recordRuntimeControl() {},
    readiness: {
      async check() {
        return {
          checks: [
            { name: 'test-runtime', ready: true },
          ],
          ready: true,
        }
      },
    },
    recordAccess() {},
    recordError() {},
    runtimeControl: createStaticRuntimeControlProvider('enabled'),
  }
}

/**
 * Creates permissive entitlement enforcement for route tests unrelated to billing policy.
 *
 * @returns An isolated no-op enforcement port that never performs network I/O.
 */
function createTestTenantEntitlementEnforcement(): TenantEntitlementEnforcement {
  return {
    async assertFeature() {},
    async reserveUsage() {},
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
    operational: createProductionOperationalDependencies(),
    authentication: createProductionAuthenticationDependencies(),
    workspace: createProductionWorkspaceDependencies(),
    workItems: createProductionWorkItemDependencies(),
    automation: createProductionAutomationDependencies(),
    timeTracking: {
      timeTrackingService: createTimeTrackingService(
        createTimeTrackingIdempotencyPort(adapters.idempotency, adapters.transactions),
      ),
    },
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
  const developerPlatform = createProductionDeveloperPlatformDependencies()
  return {
    operational: createProductionOperationalDependencies(),
    authentication: createProductionAuthenticationDependencies(),
    workspace: createProductionWorkspaceDependencies(),
    workItems: createProductionWorkItemDependencies(),
    automation: createProductionAutomationDependencies(),
    timeTracking: {
      timeTrackingService: createTimeTrackingService(
        createTimeTrackingIdempotencyPort(
          developerPlatform.idempotency,
          developerPlatform.transactions,
        ),
      ),
    },
    developerPlatform,
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
    operational: createTestOperationalDependencies(),
    workspace: {
      ...production.workspace,
      tenantEntitlementEnforcement: createTestTenantEntitlementEnforcement(),
    },
    workItems: {
      ...production.workItems,
      workItemConfigurations: createDefaultWorkItemConfigurationClient(),
      planning: new InMemoryPlanningClient(),
      analytics: new InMemoryAnalyticsRepository(),
    },
    timeTracking: {
      timeTrackingService: new TimeTrackingService(new InMemoryTimeTrackingRepository()),
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
    operational: {
      ...dependencies.operational,
      ...(overrides.recordRuntimeControl
        ? { recordRuntimeControl: overrides.recordRuntimeControl }
        : {}),
      ...(overrides.readiness ? { readiness: overrides.readiness } : {}),
      ...(overrides.recordAccess
        ? { recordAccess: overrides.recordAccess }
        : {}),
      ...(overrides.recordError ? { recordError: overrides.recordError } : {}),
      ...(overrides.runtimeControl
        ? { runtimeControl: overrides.runtimeControl }
        : {}),
    },
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
        ? {
            enterpriseIdentity: createEnterpriseIdentityCapabilities(
              overrides.enterpriseIdentity,
            ),
          }
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
      ...(overrides.tenantAdministration
        ? { tenantAdministration: overrides.tenantAdministration }
        : {}),
      ...(overrides.tenantEntitlementEnforcement
        ? {
            tenantEntitlementEnforcement:
              overrides.tenantEntitlementEnforcement,
          }
        : overrides.tenantAdministration
          ? { tenantEntitlementEnforcement: overrides.tenantAdministration }
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
      ...(overrides.automation
        ? {
            ruleTemplates: overrides.automation,
            inboundWebhooks: overrides.automation,
            recurringSchedules: overrides.automation,
            executions: overrides.automation,
            bulkOperations: overrides.automation,
          }
        : {}),
      ...(overrides.ruleTemplates ? { ruleTemplates: overrides.ruleTemplates } : {}),
      ...(overrides.inboundWebhooks ? { inboundWebhooks: overrides.inboundWebhooks } : {}),
      ...(overrides.recurringSchedules
        ? { recurringSchedules: overrides.recurringSchedules }
        : {}),
      ...(overrides.executions ? { executions: overrides.executions } : {}),
      ...(overrides.bulkOperations ? { bulkOperations: overrides.bulkOperations } : {}),
      ...(overrides.automationInboundWebhookSecrets
        ? {
            automationInboundWebhookSecrets:
              overrides.automationInboundWebhookSecrets,
          }
        : {}),
    },
    timeTracking: {
      ...dependencies.timeTracking,
      ...(overrides.timeTrackingService ? { timeTrackingService: overrides.timeTrackingService } : {}),
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
