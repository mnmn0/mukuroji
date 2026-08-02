import type { TenantFeature } from '@mukuroji/contracts'
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
  type WorkspaceSeatMeter,
} from '../../modules/workspace-access/workspace-access'

/** Production adapters that share one tenant-aware membership transaction boundary. */
export type ProductionTenantMeteredWorkspaceAccess = {
  /** Tenant administration adapter used by API and seat metering. */
  readonly tenantAdministration: DynamoDbTenantAdministrationClient
  /** Workspace access adapter whose membership writes include tenant seat mutations. */
  readonly workspaceAccess: DynamoDbWorkspaceAccessClient
}

/** Availability check used by trusted background feature workers. */
export interface ProductionTenantFeatureGate {
  /** Returns whether the tenant may currently execute the configured feature. */
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
    resources.workspaceAccessTableName,
  )
}

/**
 * Creates Workspace access with tenant seat enforcement joined to every membership mutation.
 *
 * @returns Production tenant and Workspace adapters sharing one seat-meter boundary.
 */
export function createProductionTenantMeteredWorkspaceAccess():
  ProductionTenantMeteredWorkspaceAccess {
  const tenantAdministration = createProductionTenantAdministrationClient()
  let workspaceAccess: DynamoDbWorkspaceAccessClient | undefined
  const seatMeter: WorkspaceSeatMeter = {
    /** Initializes legacy tenant state before preparing one atomic membership mutation. */
    async prepareSeatMutation(input) {
      try {
        return await tenantAdministration.prepareSeatMutation(input)
      } catch (error) {
        if (
          error instanceof TenantAdministrationError &&
          error.code === 'TenantAdministrationNotInitialized'
        ) {
          if (!workspaceAccess) {
            throw new WorkspaceAccessError(
              503,
              'TenantSeatMeterUnavailable',
              'Tenant seat metering is unavailable.',
              { cause: error },
            )
          }
          const activeMembers = await workspaceAccess.listActiveMembers(
            input.workspaceId,
          )
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
  workspaceAccess = new DynamoDbWorkspaceAccessClient({
    documentAuthorizationRevisionMutationPort:
      new DynamoDbDocumentAuthorizationRevisionMutationAdapter(),
    seatMeter,
  })
  return { tenantAdministration, workspaceAccess }
}

/**
 * Creates a fail-closed feature gate for a trusted background worker.
 *
 * Deliberately disabled, unavailable, and not-yet-initialized tenant features return `false`.
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
            error.code === 'TenantAdministrationNotInitialized' ||
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
