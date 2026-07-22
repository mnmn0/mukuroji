import type { EnterpriseIdentityProvider } from '@mukuroji/contracts'
import type { DashboardSummaryClient } from '../../modules/analytics'
import type { AnalyticsRepository } from '../../modules/analytics/analytics'
import type {
  AuditEventPage,
  AuditEventQuery,
  AuditEventV1,
} from '../../modules/audit/audit'
import type { CognitoClient } from '../../modules/authentication'
import type {
  AutomationBulkOperationPort,
  AutomationExecutionServicePort,
  AutomationInboundWebhookPort,
  AutomationInboundWebhookSecretStore,
  AutomationRecurringSchedulePort,
  AutomationRepository,
  AutomationRuleTemplatePort,
  DynamoDbAutomationTransactionItem,
} from '../../modules/automation'
import type { CollaborationClient } from '../../modules/collaboration/collaboration'
import type { DeveloperPlatformClient } from '../../modules/developer-platform/developer-platform'
import type {
  PublicApiDependencies,
  PublicWorkItemService,
} from '../../modules/developer-platform/public-api'
import type { ProjectDirectoryClient } from '../../modules/directory'
import type { DocumentClient } from '../../modules/documents/documents'
import type { EnterpriseIdentityClient } from '../../modules/enterprise-identity/enterprise-identity'
import type { EnterpriseSessionActivityClient } from '../../modules/enterprise-identity/enterprise-session-activity'
import type { FileProofingClient } from '../../modules/files/file-proofing'
import type { NotificationClient } from '../../modules/notifications/notifications'
import type { PlanningClient } from '../../modules/planning/planning'
import type { RealtimeTicketsClient } from '../../modules/realtime/realtime-ticket'
import type { RequestIntakeClient } from '../../modules/request-intake/request-intake'
import type {
  ProjectTasksClient,
  TeamIssuesClient,
} from '../../modules/work-items'
import type { WorkItemConfigurationClient } from '../../modules/work-items/work-item-configuration'
import type {
  WorkItemImportExecutionStore,
  WorkItemImportQueue,
  WorkItemImportSourceStore,
} from '../../modules/work-items/work-item-import'
import type { WorkspaceAccessClient } from '../../modules/workspace-access/workspace-access'
import type { WorkspaceSearchClient } from '../../modules/workspace-search/workspace-search'

/** Append-only audit persistence required by Workspace routes. */
export type AuditEventsClient = {
  /** Appends an immutable event when the adapter supports direct writes. */
  putEvent?(event: AuditEventV1): Promise<void>
  /**
   * Reads an event by its deterministic identifier.
   *
   * @param workspaceId - Workspace identifier.
   * @param eventId - Audit event identifier.
   * @returns The event when it exists.
   */
  getEvent(workspaceId: string, eventId: string): Promise<AuditEventV1 | undefined>
  /**
   * Queries a page of audit events.
   *
   * @param input - Audit query filters and pagination state.
   * @returns One page of matching audit events.
   */
  query(input: AuditEventQuery): Promise<AuditEventPage>
}

/** Function that validates Enterprise Identity provider metadata and connectivity. */
export type EnterpriseIdentityProviderConnectionTester = (
  provider: EnterpriseIdentityProvider,
) => Promise<EnterpriseIdentityProvider>

/** Dependencies required by authentication routes. */
export interface AuthenticationDependencies {
  /** Provides Cognito authentication and directory operations. */
  cognito: CognitoClient
}

/** Dependencies required by Workspace and Enterprise Identity routes. */
export interface WorkspaceDependencies {
  /** Provides the Dashboard read model. */
  dashboardSummary: DashboardSummaryClient
  /** Provides Team, Project, and member directory persistence. */
  projectDirectory: ProjectDirectoryClient
  /** Provides append-only audit persistence. */
  auditEvents: AuditEventsClient
  /** Provides Workspace membership persistence. */
  workspaceAccess: WorkspaceAccessClient
  /** Provides Enterprise Identity persistence. */
  enterpriseIdentity: EnterpriseIdentityClient
  /** Provides Enterprise session assurance persistence. */
  enterpriseSessionActivity: EnterpriseSessionActivityClient
  /** Validates Enterprise Identity provider metadata and connectivity. */
  enterpriseIdentityProviderConnectionTester: EnterpriseIdentityProviderConnectionTester
}

/** Dependencies required by Work Item and collaboration routes. */
export interface WorkItemDependencies {
  /** Provides Project task persistence. */
  projectTasks: ProjectTasksClient
  /** Provides Team Work Item persistence. */
  teamIssues: TeamIssuesClient
  /** Provides realtime ticket persistence. */
  realtimeTickets: RealtimeTicketsClient
  /** Provides Work Item collaboration persistence. */
  collaboration: CollaborationClient
  /** Provides file proofing persistence and object access. */
  fileProofing: FileProofingClient
  /** Provides notification persistence. */
  notifications: NotificationClient
  /** Provides Workspace search persistence. */
  workspaceSearch: WorkspaceSearchClient
  /** Provides Document persistence. */
  documents: DocumentClient
  /** Enables synchronous Workspace search projection updates. */
  workspaceSearchProjectionEnabled: boolean
  /** Provides Work Item configuration persistence. */
  workItemConfigurations: WorkItemConfigurationClient
  /** Provides Planning persistence. */
  planning: PlanningClient
  /** Provides Request Intake persistence. */
  requestIntake: RequestIntakeClient
  /** Provides Analytics report and snapshot persistence. */
  analytics: AnalyticsRepository
}

/** Dependencies required by Automation routes. */
export interface AutomationDependencies {
  /** Provides Rule and Template application persistence. */
  ruleTemplates: AutomationRuleTemplatePort<DynamoDbAutomationTransactionItem>
  /** Provides inbound Webhook endpoint and replay persistence. */
  inboundWebhooks: AutomationInboundWebhookPort<DynamoDbAutomationTransactionItem>
  /** Provides recurring definition persistence. */
  recurringSchedules: AutomationRecurringSchedulePort
  /** Provides execution, lease, rate-limit, and receipt persistence. */
  executions: AutomationExecutionServicePort
  /** Provides durable Bulk operation checkpoints. */
  bulkOperations: AutomationBulkOperationPort
  /** Provides Automation inbound webhook secret persistence. */
  automationInboundWebhookSecrets: AutomationInboundWebhookSecretStore
}

/** Dependencies required by Developer Platform routes and workers. */
export interface DeveloperPlatformDependencies {
  /** Provides Developer Platform persistence. */
  developerPlatform: DeveloperPlatformClient
  /** Provides the canonical public Work Item use case. */
  publicWorkItems: PublicWorkItemService
  /** Provides durable Work Item import execution persistence. */
  workItemImportExecutions: WorkItemImportExecutionStore
  /** Provides durable Work Item import source persistence. */
  workItemImportSources: WorkItemImportSourceStore
  /** Provides the durable Work Item import queue. */
  workItemImportQueue: WorkItemImportQueue
  /** Enqueues Public API replays on the durable Webhook delivery queue. */
  queueWebhookDelivery: NonNullable<PublicApiDependencies['queueWebhookDelivery']>
}

/** Domain dependency bundles bound to one HTTP application instance. */
export interface AppDependencies {
  /** Authentication route dependencies. */
  authentication: Readonly<AuthenticationDependencies>
  /** Workspace and Enterprise Identity route dependencies. */
  workspace: Readonly<WorkspaceDependencies>
  /** Work Item and collaboration route dependencies. */
  workItems: Readonly<WorkItemDependencies>
  /** Automation route dependencies. */
  automation: Readonly<AutomationDependencies>
  /** Developer Platform route and worker dependencies. */
  developerPlatform: Readonly<DeveloperPlatformDependencies>
}

/**
 * Creates an immutable snapshot of an application's domain dependency bundles.
 *
 * Adapter instances remain stateful ports, while the bundle references themselves cannot be replaced.
 *
 * @param dependencies - Source dependency graph owned by an app or worker.
 * @returns A frozen top-level graph containing frozen copies of every domain bundle.
 */
export function freezeAppDependencies(
  dependencies: AppDependencies,
): Readonly<AppDependencies> {
  return Object.freeze({
    authentication: Object.freeze({ ...dependencies.authentication }),
    workspace: Object.freeze({ ...dependencies.workspace }),
    workItems: Object.freeze({ ...dependencies.workItems }),
    automation: Object.freeze({ ...dependencies.automation }),
    developerPlatform: Object.freeze({ ...dependencies.developerPlatform }),
  })
}

/** Flat dependency overrides accepted by test composition helpers. */
export type AppDependencyOverrides = Partial<
  AuthenticationDependencies &
  WorkspaceDependencies &
  WorkItemDependencies &
  AutomationDependencies &
  DeveloperPlatformDependencies
> & {
  /** Backward-compatible all-capability Automation adapter override for tests. */
  automation?: AutomationRepository<
    DynamoDbAutomationTransactionItem,
    DynamoDbAutomationTransactionItem
  >
}
