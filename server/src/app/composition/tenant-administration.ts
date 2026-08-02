import type { TenantFeature } from '@mukuroji/contracts'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { loadServerDynamoDbResourceConfig } from '../../infrastructure/config/server-resource-config'
import {
  createDynamoDbTenantAdministrationAuditWriter,
  DynamoDbTenantAdministrationClient,
  TenantAdministrationError,
} from '../../modules/tenant-administration'

/** Availability check used by trusted background feature workers. */
export interface ProductionTenantFeatureGate {
  /** Returns whether the tenant may currently execute the configured feature. */
  isEnabled(workspaceId: string): Promise<boolean>
}

/**
 * Creates the configured tenant administration persistence adapter.
 *
 * @returns A DynamoDB-backed tenant administration client.
 */
export function createProductionTenantAdministrationClient(): DynamoDbTenantAdministrationClient {
  const resources = loadServerDynamoDbResourceConfig()
  const config = loadServerConfig()
  return new DynamoDbTenantAdministrationClient(
    resources.tenantAdministrationTableName,
    createDynamoDbDocumentClient(createDynamoDbClient()),
    undefined,
    createDynamoDbTenantAdministrationAuditWriter(
      resources.auditEventsTableName,
      config.environment.MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY,
    ),
    {
      dataResidency: config.awsRegion,
      encryptionKeyPolicy: 'aws-managed',
    },
    resources.auditEventsTableName,
  )
}

/**
 * Creates a fail-closed feature gate for a trusted background worker.
 *
 * Deliberately disabled and not-yet-initialized tenant features return `false`.
 * Authenticated API access owns legacy initialization from authoritative Workspace
 * membership; persistence and configuration failures remain errors for retry.
 *
 * @param feature - Commercial feature executed by the worker.
 * @returns A tenant-scoped feature availability gate.
 */
export function createProductionTenantFeatureGate(
  feature: TenantFeature,
): ProductionTenantFeatureGate {
  const tenantAdministration = createProductionTenantAdministrationClient()

  return {
    async isEnabled(workspaceId) {
      try {
        await tenantAdministration.assertFeature(workspaceId, feature)
        return true
      } catch (error) {
        if (
          error instanceof TenantAdministrationError &&
          (
            error.code === 'TenantFeatureNotEntitled' ||
            error.code === 'TenantAdministrationNotInitialized'
          )
        ) {
          return false
        }
        throw error
      }
    },
  }
}
