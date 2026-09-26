import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { loadServerDynamoDbResourceConfig } from '../../infrastructure/config/server-resource-config'
import {
  DynamoDbDocumentAuthorizationRevisionMutationAdapter,
} from '../../modules/documents/adapter-out/dynamodb/document-authorization'
import {
  createDynamoDbTenantAdministrationAuditWriter,
  DynamoDbTenantAdministrationClient,
  TenantAdministrationError,
} from '../../modules/tenant-administration'
import {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
  type WorkspaceMembershipGuard,
} from '../../modules/workspace-access/workspace-access'

/** Production adapters that share one tenant-aware membership transaction boundary. */
export type ProductionTenantWorkspaceAccess = {
  /** Tenant administration adapter used by API and lifecycle enforcement. */
  readonly tenantAdministration: DynamoDbTenantAdministrationClient
  /** Workspace access adapter whose membership writes include tenant lifecycle conditions. */
  readonly workspaceAccess: DynamoDbWorkspaceAccessClient
}

/** Availability check used by trusted background feature workers. */
export interface ProductionTenantFeatureGate {
  /** Returns whether the tenant may currently execute the worker. */
  isEnabled(workspaceId: string): Promise<boolean>
}

/** Active-state guard used by unauthenticated tenant-owned write surfaces. */
export interface ProductionTenantAvailability {
  /** Returns whether the tenant can currently accept normal data-plane traffic. */
  isActive(workspaceId: string): Promise<boolean>
  /** Creates an atomic DynamoDB write guard against a concurrent closure transition. */
  createActiveWriteCondition(
    workspaceId: string,
  ): ReturnType<DynamoDbTenantAdministrationClient['createActiveWriteCondition']>
}

/**
 * Creates the configured tenant administration persistence adapter.
 *
 * @param pseudonymKeyOverride - Optional in-memory key loaded by a trusted non-API runtime.
 * @returns A DynamoDB-backed tenant administration client.
 */
export function createProductionTenantAdministrationClient(
  pseudonymKeyOverride?: string,
): DynamoDbTenantAdministrationClient {
  const resources = loadServerDynamoDbResourceConfig()
  const config = loadServerConfig()
  const pseudonymKey = pseudonymKeyOverride ??
    config.environment.MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY
  return new DynamoDbTenantAdministrationClient(
    resources.tenantAdministrationTableName,
    createDynamoDbDocumentClient(createDynamoDbClient()),
    undefined,
    createDynamoDbTenantAdministrationAuditWriter(
      resources.auditEventsTableName,
      pseudonymKey,
    ),
    {
      dataResidency: config.awsRegion,
      encryptionKeyPolicy: 'aws-managed',
    },
    resources.auditEventsTableName,
    resources.workspaceAccessTableName,
    pseudonymKey,
  )
}

/**
 * Creates Workspace access with tenant lifecycle enforcement joined to every membership mutation.
 *
 * @returns Production tenant and Workspace adapters sharing one lifecycle boundary.
 */
export function createProductionTenantWorkspaceAccess():
  ProductionTenantWorkspaceAccess {
  const tenantAdministration = createProductionTenantAdministrationClient()
  const membershipGuard: WorkspaceMembershipGuard = {
    /** Rejects closed tenants and guards membership writes, allowing legacy profiles to be absent. */
    async prepareMembershipMutation(input) {
      try {
        await tenantAdministration.assertActive(input.workspaceId)
        return [tenantAdministration.createActiveWriteCondition(input.workspaceId)]
      } catch (error) {
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
  const workspaceAccess = new DynamoDbWorkspaceAccessClient({
    documentAuthorizationRevisionMutationPort:
      new DynamoDbDocumentAuthorizationRevisionMutationAdapter(),
    membershipGuard,
  })
  return { tenantAdministration, workspaceAccess }
}

/**
 * Creates a fail-closed feature gate for a trusted background worker.
 *
 * Inactive tenants return `false`; missing legacy profiles remain usable.
 * Persistence and configuration failures remain errors for retry.
 *
 * @returns A tenant-scoped feature availability gate.
 */
export function createProductionTenantFeatureGate(
): ProductionTenantFeatureGate {
  const tenantAdministration = createProductionTenantAdministrationClient()

  return {
    async isEnabled(workspaceId) {
      try {
        await tenantAdministration.assertActive(workspaceId)
        return true
      } catch (error) {
        if (
          error instanceof TenantAdministrationError &&
          (
            error.code === 'TenantClosing' ||
            error.code === 'TenantClosed'
          )
        ) {
          return false
        }
        throw error
      }
    },
  }
}

/**
 * Creates an active-state guard for public or asynchronous tenant-owned writes.
 *
 * @returns A read check and transaction condition backed by tenant lifecycle state.
 */
export function createProductionTenantAvailability(): ProductionTenantAvailability {
  const tenantAdministration = createProductionTenantAdministrationClient()
  return {
    async isActive(workspaceId) {
      try {
        await tenantAdministration.assertActive(workspaceId)
        return true
      } catch (error) {
        if (
          error instanceof TenantAdministrationError &&
          (error.code === 'TenantClosing' || error.code === 'TenantClosed')
        ) {
          return false
        }
        throw error
      }
    },
    createActiveWriteCondition: (workspaceId) =>
      tenantAdministration.createActiveWriteCondition(workspaceId),
  }
}
