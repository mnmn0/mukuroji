import { createProductionAuditExportWorkerHandler } from '../app/composition/audit-export-worker'
import { createRuntimeControlGuardedHandler } from '../app/composition/runtime-control'
import type { AuditExportSqsEvent } from '../modules/audit/adapter-in/events/audit-export-worker'

let productionHandler:
  | ReturnType<typeof createProductionAuditExportWorkerHandler>
  | undefined

/**
 * Processes one audit export SQS batch.
 *
 * @param event - Audit export SQS batch.
 * @returns The partial-batch response with records to retry.
 */
async function processAuditExport(event: AuditExportSqsEvent) {
  productionHandler ??= createProductionAuditExportWorkerHandler()
  return await productionHandler(event)
}

/**
 * Runtime-control guarded audit export SQS entrypoint.
 *
 * @param event - Audit export SQS batch.
 * @returns The partial-batch response with records to retry.
 */
export const auditExportWorkerHandler = createRuntimeControlGuardedHandler(
  'audit-export',
  processAuditExport,
)
