import type { AppDependencies } from './app-dependencies'
import { createCognitoClient } from '../../modules/authentication'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import { DynamoDbWorkspaceAccessClient } from '../../modules/workspace-access'
import { DynamoDbEnterpriseIdentityReadClient } from '../../modules/enterprise-identity'
import { DynamoDbPlanningClient } from '../../modules/planning/planning'
import { DynamoDbCollaborationClient } from '../../modules/collaboration/collaboration'
import { DynamoDbUpdateFeedReadStateStore, DynamoDbSavedUpdateFeedsStore } from '../../modules/update-feed'
import { createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'

/** Provides only the production ports reached by the existing recipient/Feed authorization.
 * @param planningTable - Explicitly configured Planning table.
 * @param enterpriseTable - Explicitly configured current Enterprise policy table.
 * @returns A dedicated graph with unrelated capabilities failing closed, without initialization.
 */
export function createInboxDigestAppDependencies(planningTable: string, enterpriseTable: string): AppDependencies {
  const client = createDynamoDbDocumentClient()
  return {
    authentication: { cognito: createCognitoClient() },
    workspace: {
      projectDirectory: new DynamoDbProjectDirectoryClient(),
      workspaceAccess: new DynamoDbWorkspaceAccessClient(),
      enterpriseIdentity: {
        read: new DynamoDbEnterpriseIdentityReadClient(enterpriseTable, client),
        ssoDiscovery: unavailable(), identityProviderAdministration: unavailable(), authorization: unavailable(),
        scimDirectory: unavailable(), scimAuthentication: unavailable(), scimCredentialAdministration: unavailable(),
        provisioning: unavailable(), serviceAccountAuthentication: unavailable(), serviceAccountAdministration: unavailable(), breakGlass: unavailable(),
      },
      customers: unavailable(), dashboardSummary: unavailable(), auditEvents: unavailable(),
      enterpriseSessionActivity: unavailable(), enterpriseIdentityProviderConnectionTester: unsupported,
      tenantAdministration: unavailable(), tenantExportDownload: unavailable(), tenantLifecycleEnforcement: unavailable(),
    },
    workItems: {
      planning: new DynamoDbPlanningClient(planningTable, client, undefined, false),
      collaboration: new DynamoDbCollaborationClient(),
      updateFeedReadState: new DynamoDbUpdateFeedReadStateStore(planningTable, client),
      savedUpdateFeeds: new DynamoDbSavedUpdateFeedsStore(planningTable, client),
      teamIssues: unavailable(), realtimeTickets: unavailable(), fileProofing: unavailable(), notifications: unavailable(),
      focusState: unavailable(), workspaceSearch: unavailable(), documents: unavailable(), workspaceSearchProjectionEnabled: false,
      workItemConfigurations: unavailable(), updateFeedDigest: unavailable(), inboxDigestSettings: unavailable(),
      requestIntake: unavailable(), triage: unavailable(), analytics: unavailable(),
    },
    operational: { recordRuntimeControl: unsupported, readiness: unavailable(), runtimeControl: unavailable(), recordAccess: unsupported, recordError: unsupported },
    automation: { ruleTemplates: unavailable(), inboundWebhooks: unavailable(), recurringSchedules: unavailable(), executions: unavailable(), bulkOperations: unavailable(), automationInboundWebhookSecrets: unavailable() },
    timeTracking: { timeTrackingService: unavailable() },
    capacityPlanning: { capacityPlanningService: unavailable() },
    aiAssistance: { aiAssistanceService: unavailable() },
    developerPlatform: {
      apiKeys: unavailable(), oauthCredentials: unavailable(), webhookSubscriptions: unavailable(), webhookDeliveries: unavailable(),
      connectors: unavailable(), externalLinks: unavailable(), imports: unavailable(), idempotency: unavailable(), rateLimits: unavailable(),
      transactions: unavailable(), publicWorkItems: unavailable(), workItemImportExecutions: unavailable(), workItemImportSources: unavailable(),
      workItemImportQueue: unavailable(), queueWebhookDelivery: unsupported,
    },
  }
}

/** Rejects accidental use of any capability outside the dedicated worker graph. */
function unsupported(): never { throw new Error('Capability is unavailable in the Inbox digest worker') }

/** Supplies a fail-closed port without constructing unrelated production adapters.
 * @returns A proxy that throws on every property access; it cannot return fabricated data.
 */
function unavailable<Port extends object>(): Port {
  // This narrow assertion represents an intentionally uninhabited capability:
  // every operation throws before it can yield a value or perform a side effect.
  return new Proxy({} as Port, { get: unsupported })
}
