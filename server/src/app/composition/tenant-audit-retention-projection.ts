import {
  processTenantAuditRetentionProjectionBatch,
} from '../../modules/tenant-administration/adapter-in/events/tenant-audit-retention-projection'
import type {
  AuditProjectionBatchProcessor,
} from '../../modules/audit/adapter-in/events/audit-projection'
import { createProductionTenantAdministrationClient } from './tenant-administration'

/**
 * Creates the tenant audit retention step of the audit projection fan-out.
 *
 * The step only reads the tenant governance record and updates the audit
 * event's expiry, so it needs no pseudonym key.
 *
 * @returns An AuditEvents stream processor that applies tenant retention.
 */
export function createProductionTenantAuditRetentionProjectionHandler(
): AuditProjectionBatchProcessor {
  const client = createProductionTenantAdministrationClient()
  return async (event) =>
    await processTenantAuditRetentionProjectionBatch(event, client)
}
