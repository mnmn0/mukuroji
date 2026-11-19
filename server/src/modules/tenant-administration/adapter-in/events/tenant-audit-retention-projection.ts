import type {
  BatchResponse,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from '../../../../infrastructure/aws/dynamodb-stream'
import { TenantAdministrationError } from '../../domain/tenant-administration'

/** Capability that applies tenant retention to one newly inserted audit event. */
export interface TenantAuditEventRetentionReconciler {
  /** Applies current tenant retention policy to one newly inserted audit event. */
  reconcileAuditEventRetention(
    workspaceId: string,
    eventId: string,
    occurredAt: string,
  ): Promise<unknown>
}

/**
 * Applies tenant retention to the audit events of one AuditEvents stream batch.
 *
 * This runs inside the audit projection fan-out, so the AuditEvents stream
 * keeps at most two readers per shard. It stops at the first failure and
 * reports that record, so Lambda retries from the failed checkpoint.
 *
 * @param event - AuditEvents stream batch.
 * @param reconciler - Trusted tenant retention capability.
 * @returns The failed stream checkpoint, or no failures.
 */
export async function processTenantAuditRetentionProjectionBatch(
  event: DynamoStreamEvent,
  reconciler: TenantAuditEventRetentionReconciler,
): Promise<BatchResponse> {
  for (const record of event.Records ?? []) {
    try {
      const auditEvent = readTenantAuditRetentionEvent(record)
      if (!auditEvent) continue
      await reconciler.reconcileAuditEventRetention(
        auditEvent.workspaceId,
        auditEvent.eventId,
        auditEvent.occurredAt,
      )
    } catch (error) {
      console.error('Tenant audit retention projection failed.', {
        code: isRecord(error) && typeof error.code === 'string'
          ? error.code
          : 'TenantAuditRetentionProjectionFailed',
        name: isRecord(error) && typeof error.name === 'string'
          ? error.name
          : 'Error',
      })
      const sequenceNumber = record.dynamodb?.SequenceNumber
      if (!sequenceNumber) throw error
      return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] }
    }
  }
  return { batchItemFailures: [] }
}

/** Newly inserted audit event fields needed to enforce tenant retention. */
export type TenantAuditRetentionEvent = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Immutable audit event identifier. */
  eventId: string
  /** Event occurrence time used to calculate DynamoDB TTL. */
  occurredAt: string
}

/**
 * Reads a newly inserted audit event without confusing tenant-state records.
 *
 * @param record - Candidate DynamoDB stream record.
 * @returns Validated audit retention input, or undefined for another table shape.
 */
export function readTenantAuditRetentionEvent(
  record: DynamoStreamRecord,
): TenantAuditRetentionEvent | undefined {
  if (record.eventName !== 'INSERT') return undefined
  const image = record.dynamodb?.NewImage
  const directoryId = image?.directoryId?.S
  const eventId = image?.eventId?.S
  const occurredAt = image?.occurredAt?.S
  const hasAuditField = directoryId !== undefined ||
    eventId !== undefined ||
    occurredAt !== undefined
  if (!hasAuditField) return undefined
  // Readers accept only current schema v1 audit events (docs/event-audit.md).
  if (
    image?.schemaVersion?.N !== '1' ||
    !directoryId?.trim() ||
    !eventId?.trim() ||
    !occurredAt?.trim() ||
    (image?.workspaceId?.S !== undefined && image.workspaceId.S !== directoryId)
  ) {
    throw new TenantAdministrationError(
      503,
      'TenantAuditStreamRecordMalformed',
      'Tenant audit stream state is malformed.',
    )
  }
  return {
    workspaceId: directoryId,
    eventId,
    occurredAt,
  }
}

/** Returns true when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
