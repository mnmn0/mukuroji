import type { Context } from 'hono'
import { createDependencyRuntime } from '../../infrastructure/runtime/dependency-runtime'
import {
  freezeAppDependencies,
  type AppDependencies,
  type AuthenticationDependencies,
  type AutomationDependencies,
  type DeveloperPlatformDependencies,
  type WorkItemDependencies,
  type WorkspaceDependencies,
} from '../../app/composition/app-dependencies'
import { TenantAdministrationError } from '../../modules/tenant-administration'
import { type AutomationRuleTemplatePort } from '../../modules/automation'
import { toTenantLifecycleBoundaryError } from './http'

/** Request-scoped runtime that binds the application dependency graph to each HTTP request. */
export const appDependencyRuntime = createDependencyRuntime<AppDependencies>(
  freezeAppDependencies,
)

/** Returns the dependency graph bound to the current request and fails when none is bound. */
export const requireAppDependencies = appDependencyRuntime.requireDependencies

/** Lazy accessors for the authentication dependencies bound to the current request. */
export const authenticationDependencies: AuthenticationDependencies = {
  get cognito() {
    return requireAppDependencies().authentication.cognito
  },
}

/** Lazy accessors for the Workspace dependencies bound to the current request. */
export const workspaceDependencies: WorkspaceDependencies = {
  get customers() {
    return requireAppDependencies().workspace.customers
  },
  get dashboardSummary() {
    return requireAppDependencies().workspace.dashboardSummary
  },
  get projectDirectory() {
    return requireAppDependencies().workspace.projectDirectory
  },
  get auditEvents() {
    return requireAppDependencies().workspace.auditEvents
  },
  get auditExports() {
    return requireAppDependencies().workspace.auditExports
  },
  get workspaceAccess() {
    return requireAppDependencies().workspace.workspaceAccess
  },
  get enterpriseIdentity() {
    return requireAppDependencies().workspace.enterpriseIdentity
  },
  get enterpriseSessionActivity() {
    return requireAppDependencies().workspace.enterpriseSessionActivity
  },
  get enterpriseIdentityProviderConnectionTester() {
    return requireAppDependencies().workspace.enterpriseIdentityProviderConnectionTester
  },
  get tenantAdministration() {
    return requireAppDependencies().workspace.tenantAdministration
  },
  get tenantExportDownload() {
    return requireAppDependencies().workspace.tenantExportDownload
  },
  get tenantLifecycleEnforcement() {
    return requireAppDependencies().workspace.tenantLifecycleEnforcement
  },
}

/** Lazy accessors for the Work Item dependencies bound to the current request. */
export const workItemDependencies: WorkItemDependencies = {
  get teamIssues() {
    return requireAppDependencies().workItems.teamIssues
  },
  get realtimeTickets() {
    return requireAppDependencies().workItems.realtimeTickets
  },
  get collaboration() {
    return requireAppDependencies().workItems.collaboration
  },
  get fileProofing() {
    return requireAppDependencies().workItems.fileProofing
  },
  get notifications() {
    return requireAppDependencies().workItems.notifications
  },
  get pushSubscriptions() {
    return requireAppDependencies().workItems.pushSubscriptions
  },
  get focusState() {
    return requireAppDependencies().workItems.focusState
  },
  get workspaceSearch() {
    return requireAppDependencies().workItems.workspaceSearch
  },
  get documents() {
    return requireAppDependencies().workItems.documents
  },
  get workspaceSearchProjectionEnabled() {
    return requireAppDependencies().workItems.workspaceSearchProjectionEnabled
  },
  get workItemConfigurations() {
    return requireAppDependencies().workItems.workItemConfigurations
  },
  get planning() {
    return requireAppDependencies().workItems.planning
  },
  get updateFeedReadState() {
    return requireAppDependencies().workItems.updateFeedReadState
  },
  get savedUpdateFeeds() {
    return requireAppDependencies().workItems.savedUpdateFeeds
  },
  get collections() {
    return requireAppDependencies().workItems.collections
  },
  get updateFeedDigest() {
    return requireAppDependencies().workItems.updateFeedDigest
  },
  get inboxDigestSettings() {
    return requireAppDependencies().workItems.inboxDigestSettings
  },
  get requestIntake() {
    return requireAppDependencies().workItems.requestIntake
  },
  get triage() {
    return requireAppDependencies().workItems.triage
  },
  get analytics() {
    return requireAppDependencies().workItems.analytics
  },
}

/** Lazy accessors for the automation dependencies bound to the current request. */
export const automationDependencies: AutomationDependencies = {
  get ruleTemplates() {
    return requireAppDependencies().automation.ruleTemplates
  },
  get inboundWebhooks() {
    return requireAppDependencies().automation.inboundWebhooks
  },
  get recurringSchedules() {
    return requireAppDependencies().automation.recurringSchedules
  },
  get executions() {
    return requireAppDependencies().automation.executions
  },
  get bulkOperations() {
    return requireAppDependencies().automation.bulkOperations
  },
  get automationInboundWebhookSecrets() {
    return requireAppDependencies().automation.automationInboundWebhookSecrets
  },
}

/** Lazy accessors for the developer platform dependencies bound to the current request. */
export const developerPlatformDependencies: DeveloperPlatformDependencies = {
  get apiKeys() {
    return requireAppDependencies().developerPlatform.apiKeys
  },
  get oauthCredentials() {
    return requireAppDependencies().developerPlatform.oauthCredentials
  },
  get webhookSubscriptions() {
    return requireAppDependencies().developerPlatform.webhookSubscriptions
  },
  get webhookDeliveries() {
    return requireAppDependencies().developerPlatform.webhookDeliveries
  },
  get connectors() {
    return requireAppDependencies().developerPlatform.connectors
  },
  get externalLinks() {
    return requireAppDependencies().developerPlatform.externalLinks
  },
  get imports() {
    return requireAppDependencies().developerPlatform.imports
  },
  get idempotency() {
    return requireAppDependencies().developerPlatform.idempotency
  },
  get rateLimits() {
    return requireAppDependencies().developerPlatform.rateLimits
  },
  get transactions() {
    return requireAppDependencies().developerPlatform.transactions
  },
  get publicWorkItems() {
    return requireAppDependencies().developerPlatform.publicWorkItems
  },
  get workItemImportExecutions() {
    return requireAppDependencies().developerPlatform.workItemImportExecutions
  },
  get workItemImportSources() {
    return requireAppDependencies().developerPlatform.workItemImportSources
  },
  get workItemImportQueue() {
    return requireAppDependencies().developerPlatform.workItemImportQueue
  },
  get queueWebhookDelivery() {
    return requireAppDependencies().developerPlatform.queueWebhookDelivery
  },
}

/** Dependencies used while executing durable Automation actions. */
export interface AutomationActionExecutorDependencies {
  /** Provides Cognito user and system-administrator lookups. */
  cognito: AuthenticationDependencies['cognito']
  /** Provides Team and Project directory reads. */
  projectDirectory: WorkspaceDependencies['projectDirectory']
  /** Provides Workspace membership reads. */
  workspaceAccess: WorkspaceDependencies['workspaceAccess']
  /** Provides immutable mutation audit reads. */
  auditEvents: WorkspaceDependencies['auditEvents']
  /** Provides canonical Work Item persistence. */
  teamIssues: WorkItemDependencies['teamIssues']
  /** Prepares Customer Request completion notification candidates. */
  customers: WorkspaceDependencies['customers']
  /** Provides canonical Work Item collaboration persistence. */
  collaboration: WorkItemDependencies['collaboration']
  /** Provides Work Item workflow and relation configuration. */
  workItemConfigurations: WorkItemDependencies['workItemConfigurations']
  /** Provides unfiltered Planning dependency state for schedule mutation fencing. */
  planning: WorkItemDependencies['planning']
  /** Provides Work Item approval persistence. */
  fileProofing: WorkItemDependencies['fileProofing']
  /** Provides Workspace search projection persistence. */
  workspaceSearch: WorkItemDependencies['workspaceSearch']
  /** Enables synchronous Workspace search projection updates. */
  workspaceSearchProjectionEnabled: boolean
  /** Provides the template-version read required by Automation actions. */
  automation: Pick<AutomationRuleTemplatePort, 'getTemplateVersion'>
}

/** Automation action executor dependencies resolved from the current request binding. */
export const ambientAutomationActionExecutorDependencies: AutomationActionExecutorDependencies = {
  get cognito() {
    return authenticationDependencies.cognito
  },
  get projectDirectory() {
    return workspaceDependencies.projectDirectory
  },
  get workspaceAccess() {
    return workspaceDependencies.workspaceAccess
  },
  get auditEvents() {
    return workspaceDependencies.auditEvents
  },
  get teamIssues() {
    return workItemDependencies.teamIssues
  },
  get customers() {
    return workspaceDependencies.customers
  },
  get collaboration() {
    return workItemDependencies.collaboration
  },
  get workItemConfigurations() {
    return workItemDependencies.workItemConfigurations
  },
  get planning() {
    return workItemDependencies.planning
  },
  get fileProofing() {
    return workItemDependencies.fileProofing
  },
  get workspaceSearch() {
    return workItemDependencies.workspaceSearch
  },
  get workspaceSearchProjectionEnabled() {
    return workItemDependencies.workspaceSearchProjectionEnabled
  },
  get automation() {
    return automationDependencies.ruleTemplates
  },
}

/** Initializes a legacy tenant once from the authoritative active membership table. */
export async function initializeLegacyTenantAdministration(workspaceId: string): Promise<void> {
  const activeMembers = await workspaceDependencies.workspaceAccess.listActiveMembers(workspaceId)
  const owner = activeMembers.find((member) => member.role === 'owner')
  if (!owner) {
    throw toTenantLifecycleBoundaryError(new TenantAdministrationError(
      503,
      'TenantOwnerUnavailable',
      'The Workspace owner required for tenant initialization is unavailable.',
    ))
  }
  await workspaceDependencies.tenantAdministration.ensureSnapshot(
    workspaceId,
    owner.memberKey,
  )
}

/**
 * Rejects normal authenticated API access after verified account closure.
 *
 * Tenant administration routes remain available for closure evidence and
 * idempotent verification reads; their mutation clients enforce closed state.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param context - Current route context, when authentication is route-bound.
 */
export async function enforceActiveTenantForRequest(
  workspaceId: string,
  context?: Context,
): Promise<void> {
  if (!context || context.req.path.startsWith('/api/tenant/')) return
  try {
    await workspaceDependencies.tenantLifecycleEnforcement.assertActive(
      workspaceId,
    )
  } catch (error) {
    if (
      error instanceof TenantAdministrationError &&
      error.code === 'TenantAdministrationNotInitialized'
    ) {
      await initializeLegacyTenantAdministration(workspaceId)
      try {
        await workspaceDependencies.tenantLifecycleEnforcement.assertActive(
          workspaceId,
        )
        return
      } catch (retryError) {
        throw toTenantLifecycleBoundaryError(retryError)
      }
    }
    throw toTenantLifecycleBoundaryError(error)
  }
}

/**
 * Binds an explicit dependency context to an application operation outside an HTTP app.
 *
 * @param dependencies - Domain dependency graph owned by the operation.
 * @param operation - Operation to run inside the dependency context.
 * @returns The operation result.
 */
export function runWithAppDependencies<Result>(
  dependencies: AppDependencies,
  operation: () => Result,
): Result {
  return appDependencyRuntime.runWith(dependencies, operation)
}
