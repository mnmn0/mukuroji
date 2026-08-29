import type {
  AiAssistancePolicy,
  ResolvedWorkItemConfiguration,
  TriageActionInput,
  TriageEntry,
  UpdateTriageConfigurationInput,
  WorkItemRelationMutationResponse,
  WorkItemRelationType,
} from '@mukuroji/contracts'
import { AI_ASSISTANCE_SCHEMA_VERSION } from '@mukuroji/contracts'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import {
  createCanonicalPublicWorkItemService,
  shouldEnableWorkspaceSearchProjection,
  testEnterpriseIdentityProviderConnection,
} from '../../api/api-router'
import type {
  AiAssistanceDependencies,
  AuditEventsClient,
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
  createAiAssistanceService,
  createMastraBedrockAiModelGateway,
  DynamoDbAiAssistanceStore,
  type AiAssistancePolicyAudit,
  type AiAssistancePolicyAuditInput,
  type AiAssistanceService,
} from '../../modules/ai-assistance'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
  createPlanningRevisionFenceWriterDynamoDbDocumentClient,
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
  calculateAuditExpiresAt,
  createAuditEvent,
  createMutationAuditContext,
  DynamoDbAuditEventsClient,
  getConfiguredAuditRetentionDays,
  getConfiguredAuditTableName,
  type AuditEventV1,
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
  createEnterpriseIdentityClient,
  createEnterpriseIdentityCapabilities,
} from '../../modules/enterprise-identity'
import {
  createEnterpriseSessionActivityClient,
} from '../../modules/enterprise-identity/enterprise-session-activity'
import { createDefaultFileProofingClient } from '../../modules/files/file-proofing'
import {
  InMemoryFocusStateClient,
  createFocusStateClient,
} from '../../modules/focus'
import { DynamoDbNotificationsClient } from '../../modules/notifications/notifications'
import {
  DynamoDbPlanningClient,
  InMemoryPlanningClient,
} from '../../modules/planning/planning'
import { DynamoDbRealtimeTicketsClient } from '../../modules/realtime/realtime-ticket'
import { createDefaultRequestIntakeClient } from '../../modules/request-intake/request-intake'
import {
  DynamoDbTriageClient,
  TriageError,
  type TriageActionReferenceValidator,
  type TriageAdmissionValidator,
  type TriageAuthorizationConditionChecks,
  type TriageConfigurationReferenceValidator,
} from '../../modules/triage'
import {
  DynamoDbWorkspaceAccessClient,
  type WorkspaceActiveMemberConditionOptions,
} from '../../modules/workspace-access'
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
  DynamoDbTeamIssuesClient,
  createWorkItemRevisionConditionCheck,
  type TeamIssuesClient,
  type TriageDuplicateContextTransactionContribution,
  type WorkItemImportQueue,
  type WorkItemImportSourceStore,
} from '../../modules/work-items'
import {
  DynamoDbProjectDirectoryClient,
  ProjectDataError,
  normalizeProjectMemberKey,
} from '../../modules/directory'
import {
  createProductionTenantExportDownloadClient,
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
import {
  createProductionTenantAvailability,
  createProductionTenantMeteredWorkspaceAccess,
} from './tenant-administration'
import {
  CapacityPlanningService,
  DynamoDbCapacityPlanningRepository,
  InMemoryCapacityPlanningRepository,
  type CapacityPlanningDataSource,
} from '../../modules/capacity-planning'

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
    config.environment.WORK_ITEMS_TABLE_NAME ??
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
 * @returns A DynamoDB-backed Automation repository.
 */
export function createAutomationRepository(): DynamoDbAutomationRepository {
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
    config.environment.WORK_ITEMS_TABLE_NAME ??
    'mukuroji-team-issues-local'

  return new DynamoDbPlanningClient(
    config.environment.PLANNING_TABLE_NAME ?? 'mukuroji-planning-local',
    createPlanningRevisionFenceWriterDynamoDbDocumentClient(
      dynamoDbClient,
      config,
    ),
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

/** Creates capacity-planning source adapters backed by the shared time-tracking service. */
function createCapacityPlanningDataSource(
  timeTrackingService: TimeTrackingService,
): CapacityPlanningDataSource {
  return {
    async listTimeEntries(input) {
      const entries = await timeTrackingService.listAllEntries(input)
      return entries.map((entry) => ({
        memberId: entry.userId,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        workItemId: entry.workItemId,
        startAt: entry.startAt,
        endAt: entry.endAt,
        durationMinutes: entry.durationMinutes,
        status: entry.status,
      }))
    },
    async listEstimates(workspaceId, teamId) {
      return await timeTrackingService.listEstimates(workspaceId, teamId)
    },
  }
}

/** Creates a capacity-planning service using durable state and shared time tracking. */
export function createCapacityPlanningService(
  timeTrackingService: TimeTrackingService,
): CapacityPlanningService {
  const config = loadServerConfig()
  const dynamoDbClient = createDynamoDbClient()
  const tableName = config.environment.CAPACITY_PLANNING_TABLE_NAME
  if (config.production && !tableName) {
    throw new Error('CAPACITY_PLANNING_TABLE_NAME must be set for durable capacity planning storage.')
  }
  return new CapacityPlanningService(
    new DynamoDbCapacityPlanningRepository(
      tableName ?? 'mukuroji-capacity-planning-local',
      createDynamoDbDocumentClient(dynamoDbClient),
    ),
    createCapacityPlanningDataSource(timeTrackingService),
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
  const { tenantAdministration, workspaceAccess } =
    createProductionTenantMeteredWorkspaceAccess()
  return {
    dashboardSummary: new DynamoDbDashboardSummaryClient(),
    projectDirectory: new DynamoDbProjectDirectoryClient(),
    auditEvents: createAuditEventsClient(),
    workspaceAccess,
    enterpriseIdentity: createEnterpriseIdentityCapabilities(enterpriseIdentityClient),
    enterpriseSessionActivity: createEnterpriseSessionActivityClient(),
    enterpriseIdentityProviderConnectionTester: testEnterpriseIdentityProviderConnection,
    tenantAdministration,
    tenantExportDownload: createProductionTenantExportDownloadClient(),
    tenantEntitlementEnforcement: tenantAdministration,
  }
}

/**
 * Creates the production Work Item and collaboration adapter bundle.
 *
 * @returns Work Item dependencies backed by configured production adapters.
 */
export function createProductionWorkItemDependencies(): WorkItemDependencies {
  const teamIssues = new DynamoDbTeamIssuesClient()
  const projectDirectory = new DynamoDbProjectDirectoryClient()
  const workspaceAccess = new DynamoDbWorkspaceAccessClient()
  const triageAdmissionValidator = createTriageAdmissionValidator(
    projectDirectory,
    workspaceAccess,
  )
  const triage = createTriageClient(
    teamIssues,
    triageAdmissionValidator,
    createTriageConfigurationReferenceValidator(projectDirectory, workspaceAccess),
    createTriageActionReferenceValidator(projectDirectory, workspaceAccess),
  )
  return {
    teamIssues,
    realtimeTickets: new DynamoDbRealtimeTicketsClient(),
    collaboration: new DynamoDbCollaborationClient(),
    fileProofing: createDefaultFileProofingClient(),
    notifications: new DynamoDbNotificationsClient(),
    focusState: createFocusStateClient(),
    workspaceSearch: new DynamoDbWorkspaceSearchClient(),
    documents: new DynamoDbDocumentsClient(),
    workspaceSearchProjectionEnabled: shouldEnableWorkspaceSearchProjection(),
    workItemConfigurations: createWorkItemConfigurationClient(),
    planning: createPlanningClient(),
    requestIntake: createDefaultRequestIntakeClient(
      createProductionTenantAvailability(),
      async (entry) => await triage.prepareEntryAdmission(entry),
    ),
    triage,
    analytics: createAnalyticsRepository(),
  }
}

/** Stable prompt template version retained with every production generation. */
const AI_ASSISTANCE_PROMPT_VERSION = 'ai-assistance-v1'

/** Local-only model default used when CDK has not bound a deployment allowlist. */
const LOCAL_AI_ASSISTANCE_MODEL_ID = 'jp.anthropic.claude-sonnet-4-6'

/** Default audit retention applied before a Workspace writes an explicit policy. */
const DEFAULT_AI_ASSISTANCE_RETENTION_DAYS = 30

/** Default unique generation-key limit per Workspace and UTC minute. */
const DEFAULT_AI_ASSISTANCE_WORKSPACE_GENERATIONS_PER_MINUTE = 32

/** Default unique generation-key limit per member and UTC minute. */
const DEFAULT_AI_ASSISTANCE_MEMBER_GENERATIONS_PER_MINUTE = 4

/** Default conservative Workspace token-reservation cap per UTC minute. */
const DEFAULT_AI_ASSISTANCE_WORKSPACE_TOKENS_PER_MINUTE = 32_000_000

/** Default conservative member token-reservation cap per UTC minute. */
const DEFAULT_AI_ASSISTANCE_MEMBER_TOKENS_PER_MINUTE = 4_000_000

/** Default worst-case input-plus-output token charge for one unique key. */
const DEFAULT_AI_ASSISTANCE_WORST_CASE_TOKENS_PER_GENERATION = 1_000_000

/**
 * Creates a service proxy that initializes Bedrock and persistence only on first AI use.
 *
 * @param createService - Factory for the complete production service.
 * @returns A lazy service implementing the complete AI assistance application port.
 */
function createLazyAiAssistanceService(
  createService: () => AiAssistanceService,
): AiAssistanceService {
  let service: AiAssistanceService | undefined

  /** Resolves the production service once for this application dependency graph. */
  function resolveService(): AiAssistanceService {
    service ??= createService()
    return service
  }

  return {
    getPolicy: (actor) => resolveService().getPolicy(actor),
    updatePolicy: (actor, request, authorization) =>
      resolveService().updatePolicy(actor, request, authorization),
    getPreference: (actor) => resolveService().getPreference(actor),
    updatePreference: (actor, request) =>
      resolveService().updatePreference(actor, request),
    generate: (actor, request, authorization, idempotencyKey, requestStartedAtMs) =>
      resolveService().generate(
        actor,
        request,
        authorization,
        idempotencyKey,
        requestStartedAtMs,
      ),
    getGeneration: (actor, generationId, authorization) =>
      resolveService().getGeneration(actor, generationId, authorization),
    decideGeneration: (actor, generationId, request, authorization) =>
      resolveService().decideGeneration(
        actor,
        generationId,
        request,
        authorization,
      ),
    createFeedback: (actor, generationId, request, idempotencyKey) =>
      resolveService().createFeedback(actor, generationId, request, idempotencyKey),
  }
}

/**
 * Parses a comma-separated deployment model allowlist without accepting empty entries.
 *
 * @param value - Optional environment value bound by CDK or local configuration.
 * @param defaultModelId - Model used when local development omits an allowlist.
 * @returns Stable unique model identifiers in configuration order.
 */
function readAiAssistanceAllowedModelIds(
  value: string | undefined,
  defaultModelId: string,
): string[] {
  if (value === undefined) return [defaultModelId]
  const modelIds = value.split(',').map((entry) => entry.trim())
  if (modelIds.length === 0 || modelIds.some((entry) => entry.length === 0)) {
    throw new TypeError(
      'AI_ASSISTANCE_ALLOWED_MODEL_IDS must contain only non-empty model IDs.',
    )
  }
  return [...new Set(modelIds)]
}

/**
 * Parses one optional positive safe-integer AI budget setting.
 *
 * @param value - Optional environment value.
 * @param name - Environment variable name used in the safe configuration error.
 * @param fallback - Reviewed deployment default used when the value is absent.
 * @returns Validated positive safe integer.
 */
function readAiAssistanceBudgetInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined) return fallback
  const normalized = value.trim()
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new TypeError(`${name} must be a positive integer.`)
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} must be a positive safe integer.`)
  }
  return parsed
}

/**
 * Parses one optional positive deployment-reviewed Bedrock token price.
 *
 * @param value - Optional environment value in USD per one million tokens.
 * @param name - Environment variable name used in the safe configuration error.
 * @returns Validated finite positive price, or undefined when not configured.
 */
function readAiAssistanceTokenPrice(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!/^(?:0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]+)?)$/u.test(normalized)) {
    throw new TypeError(`${name} must be a positive decimal number.`)
  }
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1_000_000) {
    throw new TypeError(`${name} must be a positive decimal number.`)
  }
  return parsed
}

/**
 * Creates the append-only audit writer used for AI policy transitions.
 *
 * @param auditEvents - Existing Workspace audit event persistence.
 * @returns Application audit boundary that records redacted before/after policy state.
 */
function createAiAssistancePolicyAudit(
  auditEvents: AuditEventsClient,
  store: DynamoDbAiAssistanceStore,
): AiAssistancePolicyAudit {
  /** Creates one immutable, policy-only audit event. */
  function createPolicyAuditEvent(input: AiAssistancePolicyAuditInput): AuditEventV1 {
    const occurredAt = new Date().toISOString()
    const context = createMutationAuditContext({
      workspaceId: input.workspaceId,
      actor: { id: input.actorId, kind: 'user' },
      idempotencyKey: `ai-assistance-policy:${input.workspaceId}:${input.nextPolicy.revision}`,
      request: {
        method: 'PUT',
        path: '/api/ai-assistance/policy',
        body: {
          expectedRevision: input.previousPolicy.revision,
          revision: input.nextPolicy.revision,
        },
      },
      source: {
        kind: 'api',
        method: 'PUT',
        route: '/api/ai-assistance/policy',
      },
      occurredAt,
    })
    return createAuditEvent({
      context,
      eventType: 'ai-assistance.policy.updated',
      entity: { type: 'workspace', id: input.workspaceId },
      target: { type: 'workspace', id: input.workspaceId },
      action: 'updated',
      before: input.previousPolicy,
      after: input.nextPolicy,
      summary: 'AI assistance policy was updated.',
      metadata: {
        previousRevision: input.previousPolicy.revision,
        revision: input.nextPolicy.revision,
      },
      expiresAt: calculateAuditExpiresAt(
        occurredAt,
        getConfiguredAuditRetentionDays(),
      ),
    })
  }

  /** Appends one event for non-transactional compatibility adapters. */
  async function recordEvent(input: AiAssistancePolicyAuditInput): Promise<void> {
    if (!auditEvents.putEvent) {
      throw new Error('AI assistance policy audit writer is unavailable.')
    }
    await auditEvents.putEvent(createPolicyAuditEvent(input))
  }

  return {
    async record(input) {
      await recordEvent(input)
    },
    async persist(input, expectedRevision, authorizationFence, write) {
      const auditEvent = createPolicyAuditEvent(input)
      // The Dynamo adapter owns the cross-table TransactWrite boundary. The
      // fallback keeps custom test/local adapters compatible with this port.
      if (store.putPolicyWithAudit) {
        return await store.putPolicyWithAudit(
          input.workspaceId,
          input.actorId,
          input.nextPolicy,
          expectedRevision,
          authorizationFence,
          auditEvent,
        )
      }
      const storedPolicy = await write()
      await recordEvent(input)
      return storedPolicy
    },
  }
}

/**
 * Creates the production AI service with SigV4 credentials and exact model allowlists.
 *
 * @param auditEvents - Optional existing Workspace audit persistence boundary.
 * @returns Mastra/Bedrock service backed by the existing Workspace Search table.
 */
function createProductionAiAssistanceService(
  auditEvents?: AuditEventsClient,
): AiAssistanceService {
  const config = loadServerConfig()
  const environment = config.environment
  if (environment.AWS_BEARER_TOKEN_BEDROCK !== undefined) {
    throw new TypeError(
      'AWS_BEARER_TOKEN_BEDROCK is not supported; use the Lambda execution role or the standard AWS credential chain.',
    )
  }
  const configuredDefaultModelId = environment.AI_ASSISTANCE_DEFAULT_MODEL_ID?.trim()
  const defaultModelId = configuredDefaultModelId || LOCAL_AI_ASSISTANCE_MODEL_ID
  const allowedModelIds = readAiAssistanceAllowedModelIds(
    environment.AI_ASSISTANCE_ALLOWED_MODEL_IDS,
    defaultModelId,
  )
  if (!allowedModelIds.includes(defaultModelId)) {
    throw new TypeError(
      'AI_ASSISTANCE_DEFAULT_MODEL_ID must be included in AI_ASSISTANCE_ALLOWED_MODEL_IDS.',
    )
  }
  const workspaceGenerationLimitPerMinute = readAiAssistanceBudgetInteger(
    environment.AI_ASSISTANCE_WORKSPACE_GENERATIONS_PER_MINUTE,
    'AI_ASSISTANCE_WORKSPACE_GENERATIONS_PER_MINUTE',
    DEFAULT_AI_ASSISTANCE_WORKSPACE_GENERATIONS_PER_MINUTE,
  )
  const memberGenerationLimitPerMinute = readAiAssistanceBudgetInteger(
    environment.AI_ASSISTANCE_MEMBER_GENERATIONS_PER_MINUTE,
    'AI_ASSISTANCE_MEMBER_GENERATIONS_PER_MINUTE',
    DEFAULT_AI_ASSISTANCE_MEMBER_GENERATIONS_PER_MINUTE,
  )
  const workspaceTokenLimitPerMinute = readAiAssistanceBudgetInteger(
    environment.AI_ASSISTANCE_WORKSPACE_TOKENS_PER_MINUTE,
    'AI_ASSISTANCE_WORKSPACE_TOKENS_PER_MINUTE',
    DEFAULT_AI_ASSISTANCE_WORKSPACE_TOKENS_PER_MINUTE,
  )
  const memberTokenLimitPerMinute = readAiAssistanceBudgetInteger(
    environment.AI_ASSISTANCE_MEMBER_TOKENS_PER_MINUTE,
    'AI_ASSISTANCE_MEMBER_TOKENS_PER_MINUTE',
    DEFAULT_AI_ASSISTANCE_MEMBER_TOKENS_PER_MINUTE,
  )
  const worstCaseTokensPerGeneration = readAiAssistanceBudgetInteger(
    environment.AI_ASSISTANCE_WORST_CASE_TOKENS_PER_GENERATION,
    'AI_ASSISTANCE_WORST_CASE_TOKENS_PER_GENERATION',
    DEFAULT_AI_ASSISTANCE_WORST_CASE_TOKENS_PER_GENERATION,
  )
  const inputTokenPrice = readAiAssistanceTokenPrice(
    environment.AI_ASSISTANCE_BEDROCK_INPUT_PRICE_PER_MILLION_TOKENS_USD,
    'AI_ASSISTANCE_BEDROCK_INPUT_PRICE_PER_MILLION_TOKENS_USD',
  )
  const outputTokenPrice = readAiAssistanceTokenPrice(
    environment.AI_ASSISTANCE_BEDROCK_OUTPUT_PRICE_PER_MILLION_TOKENS_USD,
    'AI_ASSISTANCE_BEDROCK_OUTPUT_PRICE_PER_MILLION_TOKENS_USD',
  )
  if ((inputTokenPrice === undefined) !== (outputTokenPrice === undefined)) {
    throw new TypeError(
      'AI assistance Bedrock input and output token prices must be configured together.',
    )
  }
  const tableName = environment.AI_ASSISTANCE_TABLE_NAME?.trim() ||
    environment.WORKSPACE_SEARCH_TABLE_NAME?.trim() ||
    environment.MUKUROJI_WORKSPACE_SEARCH_TABLE?.trim()
  if (config.production && !tableName) {
    throw new TypeError(
      'AI_ASSISTANCE_TABLE_NAME must be set for durable AI assistance storage.',
    )
  }
  const auditTableName = getConfiguredAuditTableName()
  if (config.production && !auditTableName) {
    throw new TypeError(
      'MUKUROJI_AUDIT_EVENTS_TABLE or AUDIT_EVENTS_TABLE_NAME must be set for AI policy audit writes.',
    )
  }
  const workspaceAccessTableName = environment.WORKSPACE_ACCESS_TABLE_NAME?.trim() ||
    environment.MUKUROJI_WORKSPACE_ACCESS_TABLE?.trim() ||
    'mukuroji-workspace-access-local'
  const enterpriseIdentityTableName = environment.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  const defaultPolicy: AiAssistancePolicy = {
    schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
    enabled: true,
    allowedModelIds,
    defaultModelId,
    enabledTasks: ['triage', 'summary', 'search', 'planning'],
    retentionDays: DEFAULT_AI_ASSISTANCE_RETENTION_DAYS,
    revision: 0,
    updatedAt: '1970-01-01T00:00:00.000Z',
  }
  const dynamoDbClient = createDynamoDbClient()
  const store = new DynamoDbAiAssistanceStore(
    createDynamoDbDocumentClient(dynamoDbClient),
    tableName ?? 'mukuroji-workspace-search-local',
    auditTableName ?? 'mukuroji-audit-events',
    workspaceAccessTableName,
    enterpriseIdentityTableName,
  )
  return createAiAssistanceService({
    gateway: createMastraBedrockAiModelGateway({
      region: environment.AI_ASSISTANCE_BEDROCK_REGION?.trim() || config.awsRegion,
      credentialProvider: fromNodeProviderChain(),
      ...(inputTokenPrice === undefined || outputTokenPrice === undefined
        ? {}
        : {
            pricingByModelId: {
              [defaultModelId]: {
                inputPerMillionTokensUsd: inputTokenPrice,
                outputPerMillionTokensUsd: outputTokenPrice,
              },
            },
          }),
    }),
    store,
    defaultPolicy,
    deploymentAllowedModelIds: allowedModelIds,
    promptVersion: AI_ASSISTANCE_PROMPT_VERSION,
    ...(auditEvents === undefined
      ? {}
      : { policyAudit: createAiAssistancePolicyAudit(auditEvents, store) }),
    workspaceGenerationLimitPerMinute,
    memberGenerationLimitPerMinute,
    workspaceTokenLimitPerMinute,
    memberTokenLimitPerMinute,
    worstCaseTokensPerGeneration,
  })
}

/**
 * Creates the production AI assistance dependency bundle lazily.
 *
 * @param auditEvents - Optional audit event client used for policy-transition persistence.
 * @returns AI assistance dependencies that defer provider configuration until use.
 */
export function createProductionAiAssistanceDependencies(
  auditEvents?: AuditEventsClient,
): AiAssistanceDependencies {
  return {
    aiAssistanceService: createLazyAiAssistanceService(
      () => createProductionAiAssistanceService(auditEvents),
    ),
  }
}

/**
 * Creates the Team Triage adapter with canonical Work Item lookup composition.
 *
 * New Work Item creation remains at the HTTP application boundary so its Work Item,
 * audit, source conversion, Triage revision, association, and receipt commit together.
 * Existing Work Item links are resolved after the route's live authorization checks. Duplicate
 * resolution additionally contributes a revision-guarded, de-identified Work Item context event
 * to the same transaction that terminalizes the Triage Entry.
 *
 * @param teamIssues - Canonical Work Item persistence used for strong reference reads.
 * @param validateAdmission - Live Project/member validation for source admission.
 * @returns A production DynamoDB-backed Triage client.
 */
function createTriageClient(
  teamIssues: TeamIssuesClient,
  validateAdmission: TriageAdmissionValidator,
  validateConfigurationReferences: TriageConfigurationReferenceValidator,
  validateActionReferences: TriageActionReferenceValidator,
): DynamoDbTriageClient {
  return new DynamoDbTriageClient({
    validateAdmission,
    validateConfigurationReferences,
    validateActionReferences,
    resolveWorkItemAction: async (workspaceId, entry, actor, action, now) => {
      if (action.action === 'accept' && action.mode === 'create') {
        throw new TriageError(
          409,
          'TriageWorkItemOrchestrationRequired',
          'New Work Item acceptance requires atomic API orchestration.',
        )
      }
      const workItemId = action.action === 'duplicate'
        ? action.canonicalWorkItemId
        : action.workItemId
      const detail = await teamIssues.getTeamIssueDetail(
        workspaceId,
        entry.teamId,
        workItemId,
        { consistentIssueRead: true, eventLimit: 0 },
      )
      let duplicateContext: TriageDuplicateContextTransactionContribution | undefined
      if (action.action === 'duplicate') {
        if (!teamIssues.createTriageDuplicateContextTransactionItems) {
          throw new TriageError(
            409,
            'TriageDuplicateContextOrchestrationRequired',
            'Duplicate resolution requires canonical Work Item context orchestration.',
          )
        }
        duplicateContext = teamIssues.createTriageDuplicateContextTransactionItems({
          directoryId: workspaceId,
          teamId: detail.issue.teamId,
          workItemId: detail.issue.id,
          expectedWorkItemRevision: detail.issue.revision,
          actorUserId: actor.id,
          entry,
          mergedAt: now,
        })
      }
      const environment = loadServerConfig().environment
      const workItemTableName = environment.WORK_ITEMS_TABLE_NAME ??
        'mukuroji-team-issues-local'
      return {
        canonicalWorkItem: {
          teamId: detail.issue.teamId,
          workItemId: detail.issue.id,
          ...(detail.issue.assignedProjectId
            ? { projectId: detail.issue.assignedProjectId }
            : {}),
        },
        ...(action.action === 'duplicate'
          ? {
              mergeReceipt: {
                canonicalWorkItemId: detail.issue.id,
                mergedSourceCount: 1,
                mergedCommentCount: duplicateContext?.snapshot.commentMetadataCount ?? 0,
                mergedAttachmentCount:
                  duplicateContext?.snapshot.attachmentMetadataCount ?? 0,
                mergedWatcherCount: duplicateContext?.snapshot.watcherMetadataCount ?? 0,
                completedAt: now,
              },
              transactItems: duplicateContext?.transactItems,
            }
          : {}),
        ...(action.action === 'accept'
          ? {
              transactItems: [
                createWorkItemRevisionConditionCheck(
                  workItemTableName,
                  workspaceId,
                  detail.issue.teamId,
                  detail.issue.id,
                  detail.issue.revision,
                ),
              ],
            }
          : {}),
      }
    },
  })
}

/** Workspace roles that may own a Triage entry or escalation. */
const TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS: WorkspaceActiveMemberConditionOptions = {
  allowedRoles: ['owner', 'admin', 'member'],
}

/** Identifies one configured owner that must retain access to a destination Project. */
type TriageOwnerProjectReference = {
  /** Workspace member selected as the owner. */
  memberUserId: string
  /** Project that the owner must be able to operate in. */
  projectId: string
}

/** Builds commit-time Project membership fences for configured Triage owners.
 *
 * @param projectDirectory Authoritative Project membership reader.
 * @param workspaceId Owning Workspace identifier.
 * @param references Owner and destination Project pairs to fence.
 * @param errorCode Stable error code when an owner lacks Project access.
 * @param errorMessage Safe error message when an owner lacks Project access.
 * @returns Deduplicated Project membership condition checks.
 */
async function createTriageOwnerProjectConditionChecks(
  projectDirectory: Pick<DynamoDbProjectDirectoryClient, 'createProjectAccessConditionCheck'>,
  workspaceId: string,
  references: readonly TriageOwnerProjectReference[],
  errorCode: string,
  errorMessage: string,
): Promise<TriageAuthorizationConditionChecks> {
  const uniqueReferences = new Map<string, TriageOwnerProjectReference>()
  for (const reference of references) {
    const memberUserId = normalizeProjectMemberKey(reference.memberUserId)
    uniqueReferences.set(`${reference.projectId}\u0000${memberUserId}`, {
      memberUserId,
      projectId: reference.projectId,
    })
  }
  const conditionChecks = await Promise.all([...uniqueReferences.values()].map(async (reference) =>
    await projectDirectory.createProjectAccessConditionCheck(
      workspaceId,
      reference.projectId,
      reference.memberUserId,
      'member',
    )
  ))
  if (conditionChecks.some((conditionCheck) => conditionCheck === undefined)) {
    throw new TriageError(409, errorCode, errorMessage)
  }
  return conditionChecks.flatMap((conditionCheck) =>
    conditionCheck === undefined ? [] : [conditionCheck]
  )
}

/** Collects every configured owner and Project pair that can be selected together.
 *
 * @param input Replacement Team Triage configuration.
 * @returns Deduplicated candidate owner and Project references.
 */
function collectTriageConfigurationOwnerProjectReferences(
  input: UpdateTriageConfigurationInput,
): TriageOwnerProjectReference[] {
  const rotationsById = new Map(input.rotations.map((rotation) => [rotation.id, rotation]))
  const references: TriageOwnerProjectReference[] = []
  for (const rule of input.rules) {
    if (!rule.projectId) continue
    if (rule.owner.type === 'fixed') {
      references.push({ memberUserId: rule.owner.ownerUserId, projectId: rule.projectId })
      continue
    }
    if (rule.owner.type !== 'rotation') continue
    const rotation = rotationsById.get(rule.owner.rotationId)
    if (!rotation) continue
    for (const memberUserId of rotation.memberUserIds) {
      references.push({ memberUserId, projectId: rule.projectId })
    }
  }
  for (const policy of input.slaPolicies) {
    if (!policy.escalationOwnerUserId) continue
    for (const rule of input.rules) {
      if (!rule.projectId || !rule.sourceKinds.some((kind) => policy.sourceKinds.includes(kind))) {
        continue
      }
      references.push({
        memberUserId: policy.escalationOwnerUserId,
        projectId: rule.projectId,
      })
    }
  }
  return references
}

/** Creates live Project/member validation for every Triage admission attempt.
 *
 * @param projectDirectory Authoritative active Team and Project directory reader.
 * @param workspaceAccess Authoritative active Workspace member reader.
 * @returns A validator invoked after each current configuration evaluation.
 */
export function createTriageAdmissionValidator(
  projectDirectory: Pick<
    DynamoDbProjectDirectoryClient,
    'createActiveReferenceConditionChecks' | 'createProjectAccessConditionCheck'
  >,
  workspaceAccess: Pick<DynamoDbWorkspaceAccessClient, 'createActiveMemberConditionCheck'>,
): TriageAdmissionValidator {
  return async (entry, configuration) => {
    let directoryConditionChecks
    try {
      directoryConditionChecks = await projectDirectory.createActiveReferenceConditionChecks(
        entry.workspaceId,
        entry.teamId,
        entry.projectId,
      )
    } catch (error) {
      if (error instanceof ProjectDataError && error.code === 'TeamNotFound') {
        throw new TriageError(
          409,
          'TriageAdmissionTeamUnavailable',
          'The target Triage Team is not active.',
          { cause: error },
        )
      }
      if (error instanceof ProjectDataError && error.code === 'ProjectNotFound') {
        throw new TriageError(
          409,
          'TriageAdmissionProjectUnavailable',
          'The configured Triage Project is not active in the target Team.',
          { cause: error },
        )
      }
      throw error
    }
    const memberUserIds = new Set<string>()
    if (entry.ownerUserId) memberUserIds.add(normalizeProjectMemberKey(entry.ownerUserId))
    const slaPolicy = entry.sla
      ? configuration.slaPolicies.find((candidate) => candidate.id === entry.sla?.policyId)
      : undefined
    if (slaPolicy?.escalationOwnerUserId) {
      memberUserIds.add(normalizeProjectMemberKey(slaPolicy.escalationOwnerUserId))
    }
    const memberConditionChecks = await Promise.all([...memberUserIds].map(async (memberUserId) =>
      await workspaceAccess.createActiveMemberConditionCheck(
        entry.workspaceId,
        memberUserId,
        TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
      )
    ))
    if (memberConditionChecks.some((conditionCheck) => conditionCheck === undefined)) {
      throw new TriageError(
        409,
        'TriageAdmissionOwnerUnavailable',
        'A configured Triage owner is not an active Workspace member.',
      )
    }
    const admissionProjectId = entry.projectId
    const ownerProjectConditionChecks = await createTriageOwnerProjectConditionChecks(
      projectDirectory,
      entry.workspaceId,
      admissionProjectId
        ? [...memberUserIds].map((memberUserId) => ({
            memberUserId,
            projectId: admissionProjectId,
          }))
        : [],
      'TriageAdmissionOwnerProjectUnavailable',
      'A configured Triage owner cannot access the destination Project.',
    )
    return {
      transactItems: [
        ...directoryConditionChecks,
        ...memberConditionChecks.flatMap((conditionCheck) =>
          conditionCheck === undefined ? [] : [conditionCheck]
        ),
        ...ownerProjectConditionChecks,
      ],
    }
  }
}

/** Creates commit-time guards for every directory and member referenced by settings. */
export function createTriageConfigurationReferenceValidator(
  projectDirectory: Pick<
    DynamoDbProjectDirectoryClient,
    'createActiveReferenceConditionChecks' | 'createProjectAccessConditionCheck'
  >,
  workspaceAccess: Pick<DynamoDbWorkspaceAccessClient, 'createActiveMemberConditionCheck'>,
): TriageConfigurationReferenceValidator {
  return async (workspaceId: string, teamId: string, input: UpdateTriageConfigurationInput) => {
    let directoryConditionChecks
    try {
      directoryConditionChecks = await projectDirectory.createActiveReferenceConditionChecks(
        workspaceId,
        teamId,
      )
      const projectIds = new Set(
        input.rules
          .map((rule) => rule.projectId)
          .filter((projectId): projectId is string => projectId !== undefined),
      )
      for (const projectId of projectIds) {
        const projectChecks = await projectDirectory.createActiveReferenceConditionChecks(
          workspaceId,
          teamId,
          projectId,
        )
        directoryConditionChecks.push(...projectChecks.slice(1))
      }
    } catch (error) {
      if (error instanceof ProjectDataError && error.code === 'TeamNotFound') {
        throw new TriageError(
          409,
          'TriageConfigurationTeamUnavailable',
          'The configured Triage Team is not active.',
          { cause: error },
        )
      }
      if (error instanceof ProjectDataError && error.code === 'ProjectNotFound') {
        throw new TriageError(
          409,
          'TriageConfigurationProjectUnavailable',
          'A configured Triage Project is not active in the target Team.',
          { cause: error },
        )
      }
      throw error
    }

    const memberUserIds = new Set<string>()
    for (const rule of input.rules) {
      if (rule.owner.type === 'fixed') {
        memberUserIds.add(normalizeProjectMemberKey(rule.owner.ownerUserId))
      }
    }
    for (const rotation of input.rotations) {
      for (const memberUserId of rotation.memberUserIds) {
        memberUserIds.add(normalizeProjectMemberKey(memberUserId))
      }
    }
    for (const policy of input.slaPolicies) {
      if (policy.escalationOwnerUserId) {
        memberUserIds.add(normalizeProjectMemberKey(policy.escalationOwnerUserId))
      }
    }
    const memberConditionChecks = await Promise.all([...memberUserIds].map(async (memberUserId) =>
      await workspaceAccess.createActiveMemberConditionCheck(
        workspaceId,
        memberUserId,
        TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
      )
    ))
    if (memberConditionChecks.some((conditionCheck) => conditionCheck === undefined)) {
      throw new TriageError(
        409,
        'TriageConfigurationOwnerUnavailable',
        'A configured Triage owner is not an active Workspace member.',
      )
    }
    const ownerProjectConditionChecks = await createTriageOwnerProjectConditionChecks(
      projectDirectory,
      workspaceId,
      collectTriageConfigurationOwnerProjectReferences(input),
      'TriageConfigurationOwnerProjectUnavailable',
      'A configured Triage owner cannot access a referenced Project.',
    )
    const transactItems = [
      ...directoryConditionChecks,
      ...memberConditionChecks.flatMap((conditionCheck) =>
        conditionCheck === undefined ? [] : [conditionCheck]
      ),
      ...ownerProjectConditionChecks,
    ]
    if (transactItems.length > 98) {
      throw new TriageError(
        400,
        'InvalidTriageConfiguration',
        'The Triage configuration references too many live directory records.',
      )
    }
    return { transactItems }
  }
}

/** Creates commit-time guards for one Triage action's Team, Project, and owner references. */
export function createTriageActionReferenceValidator(
  projectDirectory: Pick<DynamoDbProjectDirectoryClient, 'createActiveReferenceConditionChecks'> &
    Partial<Pick<DynamoDbProjectDirectoryClient, 'createProjectAccessConditionCheck'>>,
  workspaceAccess: Pick<DynamoDbWorkspaceAccessClient, 'createActiveMemberConditionCheck'>,
): TriageActionReferenceValidator {
  return async (
    workspaceId: string,
    teamId: string,
    entry: TriageEntry,
    action: Exclude<TriageActionInput, { action: 'accept' | 'duplicate' }>,
    actorId?: string,
  ) => {
    const projectId = action.action === 'assign'
      ? action.projectId === null
        ? undefined
        : action.projectId ?? entry.projectId
      : entry.projectId
    let directoryConditionChecks
    try {
      directoryConditionChecks = await projectDirectory.createActiveReferenceConditionChecks(
        workspaceId,
        teamId,
        projectId,
      )
    } catch (error) {
      if (error instanceof ProjectDataError && error.code === 'TeamNotFound') {
        throw new TriageError(409, 'TriageAssignmentTeamUnavailable', 'The target Team is not active.', { cause: error })
      }
      if (error instanceof ProjectDataError && error.code === 'ProjectNotFound') {
        throw new TriageError(409, 'TriageAssignmentProjectUnavailable', 'The target Project is not active.', { cause: error })
      }
      throw error
    }
    const accessConditionCheck = projectId && actorId && projectDirectory.createProjectAccessConditionCheck
      ? await projectDirectory.createProjectAccessConditionCheck(
          workspaceId,
          projectId,
          actorId,
          'member',
        )
      : undefined
    const memberConditionChecks = action.action !== 'assign' ||
      action.ownerUserId === null || action.ownerUserId === undefined
      ? []
      : [await workspaceAccess.createActiveMemberConditionCheck(
          workspaceId,
          normalizeProjectMemberKey(action.ownerUserId),
          TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
        )]
    if (memberConditionChecks.some((conditionCheck) => conditionCheck === undefined)) {
      throw new TriageError(
        409,
        'TriageAssignmentOwnerUnavailable',
        'The assigned owner is not an active Workspace member.',
      )
    }
    return {
      transactItems: [
        ...directoryConditionChecks,
        ...(accessConditionCheck ? [accessConditionCheck] : []),
        ...memberConditionChecks.flatMap((conditionCheck) =>
          conditionCheck === undefined ? [] : [conditionCheck]
        ),
      ],
    }
  }
}

/**
 * Creates the production Automation adapter bundle.
 *
 * @returns Automation dependencies backed by configured production adapters.
 */
export function createProductionAutomationDependencies(): AutomationDependencies {
  const automationRepository = createAutomationRepository()
  return {
    ruleTemplates: automationRepository,
    inboundWebhooks: automationRepository,
    recurringSchedules: automationRepository,
    executions: automationRepository,
    bulkOperations: automationRepository,
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
    async assertActive() {},
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
  const timeTrackingService = createTimeTrackingService(
    createTimeTrackingIdempotencyPort(adapters.idempotency, adapters.transactions),
  )
  const workspace = createProductionWorkspaceDependencies()
  return {
    operational: createProductionOperationalDependencies(),
    authentication: createProductionAuthenticationDependencies(),
    workspace,
    workItems: createProductionWorkItemDependencies(),
    automation: createProductionAutomationDependencies(),
    timeTracking: { timeTrackingService },
    capacityPlanning: {
      capacityPlanningService: createCapacityPlanningService(timeTrackingService),
    },
    aiAssistance: createProductionAiAssistanceDependencies(workspace.auditEvents),
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
  const timeTrackingService = createTimeTrackingService(
    createTimeTrackingIdempotencyPort(
      developerPlatform.idempotency,
      developerPlatform.transactions,
    ),
  )
  const workspace = createProductionWorkspaceDependencies()
  return {
    operational: createProductionOperationalDependencies(),
    authentication: createProductionAuthenticationDependencies(),
    workspace,
    workItems: createProductionWorkItemDependencies(),
    automation: createProductionAutomationDependencies(),
    timeTracking: { timeTrackingService },
    capacityPlanning: {
      capacityPlanningService: createCapacityPlanningService(timeTrackingService),
    },
    aiAssistance: createProductionAiAssistanceDependencies(workspace.auditEvents),
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
  const timeTrackingService = new TimeTrackingService(new InMemoryTimeTrackingRepository())
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
      focusState: new InMemoryFocusStateClient(),
      analytics: new InMemoryAnalyticsRepository(),
    },
    timeTracking: { timeTrackingService },
    capacityPlanning: {
      capacityPlanningService: new CapacityPlanningService(
        new InMemoryCapacityPlanningRepository(),
        createCapacityPlanningDataSource(timeTrackingService),
      ),
    },
    aiAssistance: production.aiAssistance,
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
      ...(overrides.teamIssues ? { teamIssues: overrides.teamIssues } : {}),
      ...(overrides.realtimeTickets
        ? { realtimeTickets: overrides.realtimeTickets }
        : {}),
      ...(overrides.collaboration ? { collaboration: overrides.collaboration } : {}),
      ...(overrides.fileProofing ? { fileProofing: overrides.fileProofing } : {}),
      ...(overrides.notifications ? { notifications: overrides.notifications } : {}),
      ...(overrides.focusState ? { focusState: overrides.focusState } : {}),
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
      ...(overrides.triage ? { triage: overrides.triage } : {}),
      ...(overrides.analytics ? { analytics: overrides.analytics } : {}),
    },
    automation: {
      ...dependencies.automation,
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
    capacityPlanning: {
      ...dependencies.capacityPlanning,
      ...(overrides.capacityPlanningService
        ? { capacityPlanningService: overrides.capacityPlanningService }
        : {}),
    },
    aiAssistance: {
      ...dependencies.aiAssistance,
      ...(overrides.aiAssistanceService
        ? { aiAssistanceService: overrides.aiAssistanceService }
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
