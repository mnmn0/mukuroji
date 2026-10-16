import { Hono } from 'hono'
import { type AppDependencies } from '../app/composition/app-dependencies'
import { appDependencyRuntime } from './shared/app-dependencies'
import { registerEnterpriseIdentityRoutes } from './routes/enterprise-identity-routes'
import { registerDocumentsRoutes } from './routes/documents-routes'
import { registerAuthenticationRoutes } from './routes/authentication-routes'
import { registerWorkspaceRoutes } from './routes/workspace-routes'
import { registerAnalyticsRoutes } from './routes/analytics-routes'
import { registerAuditRoutes } from './routes/audit-routes'
import { registerTenantAdministrationRoutes } from './routes/tenant-administration-routes'
import { registerTimeTrackingRoutes } from './routes/time-tracking-routes'
import { registerCapacityPlanningRoutes } from './routes/capacity-planning-routes'
import { registerNotificationsRoutes } from './routes/notifications-routes'
import { registerAutomationRoutes } from './routes/automation-routes'
import { registerWorkItemsRoutes } from './routes/work-items-routes'
import { registerCollaborationRoutes } from './routes/collaboration-routes'
import { registerRequestIntakeRoutes } from './routes/request-intake-routes'
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

export type {
  AppDependencies,
  AppDependencyOverrides,
  AuthenticationDependencies,
  AutomationDependencies,
  DeveloperPlatformDependencies,
  WorkItemDependencies,
  WorkspaceDependencies,
} from '../app/composition/app-dependencies'

export { DynamoDbDashboardSummaryClient } from '../modules/analytics'

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
  runWithAppDependencies,
} from './shared/app-dependencies'

export type {
  AutomationActionExecutorDependencies,
} from './shared/app-dependencies'

export {
  getAllowedOrigins,
  normalizeLambdaApiEvent,
  resolveRequestClientKey,
} from './shared/http'

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
registerWorkspaceRoutes(routeApp)
registerAnalyticsRoutes(routeApp)
registerAuditRoutes(routeApp)
registerTenantAdministrationRoutes(routeApp)
registerTimeTrackingRoutes(routeApp)
registerCapacityPlanningRoutes(routeApp)
registerNotificationsRoutes(routeApp)
registerAutomationRoutes(routeApp)
registerWorkItemsRoutes(routeApp)
registerCollaborationRoutes(routeApp)
registerRequestIntakeRoutes(routeApp)
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
