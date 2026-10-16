import { createAuditExportWorker } from '../../modules/audit/adapter-in/events/audit-export-worker'
import { createAuditEventsClient } from './api-dependencies'
import { createConfiguredAuditExportService } from './audit-export'
import { createProductionTenantFeatureGate } from './tenant-administration'

/**
 * Creates the production SQS handler of the audit export worker.
 *
 * @returns The batch handler.
 */
export function createProductionAuditExportWorkerHandler() {
  const auditEvents = createAuditEventsClient()
  const tenantGate = createProductionTenantFeatureGate()
  const service = createConfiguredAuditExportService(
    {
      readEvents: (query) => auditEvents.query(query),
      countEvents: (query) => auditEvents.countEventsConsistently(query),
    },
    undefined,
    (workspaceId) => tenantGate.isEnabled(workspaceId),
  )
  if (!service) {
    throw new Error('AUDIT_EXPORT_BUCKET_NAME and AUDIT_EXPORT_QUEUE_URL are required.')
  }
  return createAuditExportWorker(service)
}
