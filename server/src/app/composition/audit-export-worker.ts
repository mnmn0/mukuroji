import { createAuditExportWorker } from '../../modules/audit/adapter-in/events/audit-export-worker'
import { createAuditEventsClient } from './api-dependencies'
import { createConfiguredAuditExportService } from './audit-export'

/**
 * Creates the production SQS handler of the audit export worker.
 *
 * @returns The batch handler.
 */
export function createProductionAuditExportWorkerHandler() {
  const auditEvents = createAuditEventsClient()
  const service = createConfiguredAuditExportService((query) => auditEvents.query(query))
  if (!service) {
    throw new Error('AUDIT_EXPORT_BUCKET_NAME and AUDIT_EXPORT_QUEUE_URL are required.')
  }
  return createAuditExportWorker(service)
}
