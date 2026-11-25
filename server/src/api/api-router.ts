import { Hono } from 'hono'
import { type AppDependencies } from '../app/composition/app-dependencies'
import { appDependencyRuntime } from './shared/app-dependencies'
import { registerEnterpriseIdentityRoutes } from './routes/enterprise-identity-routes'
import { registerDocumentsRoutes } from './routes/documents-routes'
import { registerAuthenticationRoutes } from './routes/authentication-routes'
import { registerAccountSecurityRoutes } from './routes/account-security-routes'
import { registerWorkspaceRoutes } from './routes/workspace-routes'
import { registerAnalyticsRoutes } from './routes/analytics-routes'
import { registerAuditRoutes } from './routes/audit-routes'
import { registerTenantAdministrationRoutes } from './routes/tenant-administration-routes'
import { registerTimeTrackingRoutes } from './routes/time-tracking-routes'
import { registerAgentRunRoutes } from './routes/agent-run-routes'
import { registerCapacityPlanningRoutes } from './routes/capacity-planning-routes'
import { registerNotificationsRoutes } from './routes/notifications-routes'
import { registerAutomationRoutes } from './routes/automation-routes'
import { registerWorkItemKeyPrefixRoutes } from './routes/work-item-key-prefix-routes'
import { registerWorkItemsRoutes } from './routes/work-items-routes'
import { registerProjectCharterRoutes } from './routes/project-charter-routes'
import { registerProjectRaidLogRoutes } from './routes/project-raid-log-routes'
import { registerPortfolioRoutes } from './routes/portfolio-routes'
import { registerProjectStatusReportRoutes } from './routes/project-status-report-routes'
import { registerWeeklyReportRoutes } from './routes/weekly-report-routes'
import { registerProjectBudgetRoutes } from './routes/project-budget-routes'
import { registerScheduleBaselineRoutes } from './routes/schedule-baseline-routes'
import { registerWorkCalendarRoutes } from './routes/work-calendar-routes'
import { registerDirectoryAdministrationRoutes } from './routes/directory-administration-routes'
import { registerCollaborationRoutes } from './routes/collaboration-routes'
import { registerRequestIntakeRoutes } from './routes/request-intake-routes'
import { registerCollectionsRoutes } from './routes/collections-routes'
import { registerCustomersRoutes } from './routes/customers-routes'
import { registerAiAssistanceRoutes } from './routes/ai-assistance-routes'
import { registerWorkItemConfigurationRoutes } from './routes/work-item-configuration-routes'
import { registerFocusRoutes } from './routes/focus-routes'
import { registerPlanningRoutes } from './routes/planning-routes'
import { registerSearchRoutes } from './routes/search-routes'
import { registerTaskViewsRoutes } from './routes/task-views-routes'
import { registerRealtimeRoutes } from './routes/realtime-routes'
import { registerFilesRoutes } from './routes/files-routes'
import { registerPublicApiRoutes } from './routes/public-api-routes'
import { registerCalendarFeedRoutes } from './routes/calendar-feed-routes'

export type {
  AppDependencies,
  AppDependencyOverrides,
  AuthenticationDependencies,
  AutomationDependencies,
  DeveloperPlatformDependencies,
  WorkItemDependencies,
  WorkspaceDependencies,
} from '../app/composition/app-dependencies'

export {
  AwsCognitoClient,
  CognitoServiceError,
  createCognitoClient,
  FlociCognitoClient,
} from '../modules/authentication'

export {
  DynamoDbProjectDirectoryClient,
  type ProjectRole,
} from '../modules/directory'

export {
  DynamoDbTeamIssuesClient,
} from '../modules/work-items'

/**
 * Workspace access の永続化 client と API error です。
 */
export {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
} from '../modules/workspace-access/workspace-access'

/**
 * Workspace access API で公開する型です。
 */
export type {
  WorkspaceAccessClient,
  WorkspaceIdentityOwnership,
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspaceMemberStatus,
  WorkspaceRole,
} from '../modules/workspace-access/workspace-access'

export {
  createAutomationActionExecutor,
  createAutomationExecutionFailureNotifier,
  createAutomationWorkCalendarSource,
  createBulkItemMutationIdempotencyKey,
  requireBulkOperationOwner,
  toBulkOperationResponse,
} from './routes/automation-routes'

export {
  auditRejectedEnterpriseSecurityMutation,
  testEnterpriseIdentityProviderConnection,
} from './routes/enterprise-identity-routes'

export {
  createInboxDigestRecipientAuthorization,
} from './routes/planning-routes'

export {
  canManageWorkItemImports,
  createCanonicalPublicWorkItemService,
  createImportRowCreateIdentity,
  createWorkItemImportWorkerDependencies,
  readConnectorSyncOriginPreviousSigningSecrets,
  requireConfiguredConnectorSyncEngine,
  toWorkItemImportWorkerError,
} from './routes/public-api-routes'

export type {
  IdempotentWorkItemCreate,
} from './routes/public-api-routes'

export {
  createCanonicalPublicAgentRunService,
} from './routes/public-agent-run-service'

export {
  runWithAppDependencies,
} from './shared/app-dependencies'

export type {
  AutomationActionExecutorDependencies,
} from './shared/app-dependencies'

export {
  getAllowedOrigins,
  getSameOriginBrowserOrigins,
  normalizeLambdaApiEvent,
} from './shared/http'

export { resolveRequestClientKey } from '../infrastructure/http/trusted-request-source'

export {
  shouldEnableWorkspaceSearchProjection,
} from './shared/search-access'

const routeApp = new Hono()

/**
 * Mounts the complete domain HTTP route inventory on a composition-root app.
 *
 * @param app - Hono application that owns the routes.
 */
export function registerApiRoutes(app: Hono): void {
  app.route('/', routeApp)
}

/**
 * Binds a Hono application to immutable domain dependency bundles.
 *
 * @param app - Hono application to bind.
 * @param dependencies - Domain dependency graph owned by the application.
 * @returns A request-bound application facade.
 */
export function bindApiDependencies(
  app: Hono,
  dependencies: AppDependencies,
): Hono {
  return appDependencyRuntime.bindApp(app, dependencies)
}

registerEnterpriseIdentityRoutes(routeApp)
registerDocumentsRoutes(routeApp)
registerAuthenticationRoutes(routeApp)
registerAccountSecurityRoutes(routeApp)
registerWorkspaceRoutes(routeApp)
registerAnalyticsRoutes(routeApp)
registerAuditRoutes(routeApp)
registerTenantAdministrationRoutes(routeApp)
registerTimeTrackingRoutes(routeApp)
registerAgentRunRoutes(routeApp)
registerCapacityPlanningRoutes(routeApp)
registerNotificationsRoutes(routeApp)
registerAutomationRoutes(routeApp)
registerWorkItemsRoutes(routeApp)
registerWorkItemKeyPrefixRoutes(routeApp)
registerProjectCharterRoutes(routeApp)
registerProjectRaidLogRoutes(routeApp)
registerPortfolioRoutes(routeApp)
registerProjectStatusReportRoutes(routeApp)
registerWeeklyReportRoutes(routeApp)
registerScheduleBaselineRoutes(routeApp)
registerProjectBudgetRoutes(routeApp)
registerWorkCalendarRoutes(routeApp)
registerDirectoryAdministrationRoutes(routeApp)
registerCollaborationRoutes(routeApp)
registerRequestIntakeRoutes(routeApp)
registerCollectionsRoutes(routeApp)
registerCustomersRoutes(routeApp)
registerAiAssistanceRoutes(routeApp)
registerWorkItemConfigurationRoutes(routeApp)
registerFocusRoutes(routeApp)
registerPlanningRoutes(routeApp)
registerSearchRoutes(routeApp)
registerTaskViewsRoutes(routeApp)
registerRealtimeRoutes(routeApp)
registerFilesRoutes(routeApp)
registerPublicApiRoutes(routeApp)
registerCalendarFeedRoutes(routeApp)
