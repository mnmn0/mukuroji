import {
  TenantOperationExecutor,
} from '../../modules/tenant-administration'
import type {
  TenantOperationExecutionProcessor,
} from '../../modules/tenant-administration/adapter-in/events/tenant-operation-execution'
import { createProductionTenantAdministrationClient } from './tenant-administration'

/**
 * Creates the trusted production tenant operation executor.
 *
 * @returns An executor backed by durable tenant state and append-only audit history.
 */
export function createProductionTenantOperationExecutor(): TenantOperationExecutionProcessor {
  const client = createProductionTenantAdministrationClient()
  const executor = new TenantOperationExecutor(client)
  return {
    async execute(input) {
      return await executor.execute(input)
    },
    async reconcileAuditRetention(workspaceId) {
      return await client.reconcileAuditRetention(workspaceId)
    },
  }
}
