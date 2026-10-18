import {
  parseAuditExportQueueMessage,
  type AuditExportService,
} from '../../audit-export'

/**
 * One SQS record delivered to the export worker.
 */
export type AuditExportSqsRecord = {
  /** SQS message identifier used for partial batch failures. */
  readonly messageId: string
  /** Raw message body. */
  readonly body: string
}

/**
 * SQS batch delivered to the export worker.
 */
export type AuditExportSqsEvent = {
  /** Records in the batch. */
  readonly Records?: readonly AuditExportSqsRecord[]
}

/**
 * Partial batch response that asks SQS to retry failed records.
 */
export type AuditExportBatchResponse = {
  /** Records to retry. */
  readonly batchItemFailures: { readonly itemIdentifier: string }[]
}

/**
 * Creates the SQS entrypoint that runs one export step per message.
 *
 * Each step receives its SQS message ID, which stays the same across redeliveries, so a
 * retry after the step committed but its continuation failed to send only sends it again.
 *
 * Failure logs carry the request's correlation ID from the message, so a failed step can be
 * traced back to the audited export request. The service also checks that correlation ID
 * against the stored job and rejects a mismatched message, which then fails like any step.
 *
 * Malformed messages and failed steps are reported as batch item failures, so SQS
 * retries them and the redrive policy quarantines them in the dead-letter queue,
 * where the DLQ alarm makes them visible.
 *
 * @param service - Export service.
 * @param log - Error sink for operational logs.
 * @returns The batch handler.
 */
export function createAuditExportWorker(
  service: Pick<AuditExportService, 'processExport'>,
  log: (message: string, details: Record<string, string>) => void = (message, details) => {
    console.error(message, details)
  },
) {
  return async (event: AuditExportSqsEvent): Promise<AuditExportBatchResponse> => {
    const failures: { itemIdentifier: string }[] = []
    for (const record of event.Records ?? []) {
      const message = parseAuditExportQueueMessage(record.body)
      if (!message) {
        log('Audit export worker rejected a malformed message.', { messageId: record.messageId })
        failures.push({ itemIdentifier: record.messageId })
        continue
      }
      try {
        // The message ID lets a redelivery of a committed step resend only its continuation.
        await service.processExport(message.workspaceId, message.exportId, message.correlationId, record.messageId)
      } catch (error) {
        log('Audit export step failed and will be retried.', {
          messageId: record.messageId,
          exportId: message.exportId,
          correlationId: message.correlationId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        })
        failures.push({ itemIdentifier: record.messageId })
      }
    }
    return { batchItemFailures: failures }
  }
}
