import type {
  BatchResponse,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from '../../../../infrastructure/aws/dynamodb-stream'
import type { ExecuteTenantOperationInput } from '../../application/tenant-operation-executor'
import { TenantAdministrationError } from '../../domain/tenant-administration'

/** Capability used by the internal tenant lifecycle event adapter. */
export interface TenantOperationExecutionProcessor {
  /** Starts or advances one evidence-backed tenant operation. */
  execute(input: ExecuteTenantOperationInput): Promise<unknown>
  /** Applies one bounded page of tenant audit-retention reconciliation. */
  reconcileAuditRetention(workspaceId: string): Promise<unknown>
}

/**
 * Starts newly requested operations from their durable DynamoDB stream record.
 *
 * @param event - Tenant administration stream batch.
 * @param processor - Trusted lifecycle execution capability.
 * @returns Partial batch failures for retryable records.
 */
export async function processTenantOperationExecutionBatch(
  event: DynamoStreamEvent,
  processor: TenantOperationExecutionProcessor,
): Promise<BatchResponse> {
  for (const record of event.Records ?? []) {
    try {
      const input = readRequestedTenantOperation(record)
      if (input) {
        await processor.execute(input)
        continue
      }
      const retentionWorkspaceId = readTenantRetentionWorkspace(record)
      if (retentionWorkspaceId) {
        await processor.reconcileAuditRetention(retentionWorkspaceId)
      }
    } catch (error) {
      console.error('Tenant operation execution failed:', error)
      const sequenceNumber = record.dynamodb?.SequenceNumber
      if (!sequenceNumber) throw error
      return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] }
    }
  }
  return { batchItemFailures: [] }
}

/**
 * Reads one active retention job Workspace from a validated stream image.
 *
 * @param record - Candidate DynamoDB stream record.
 * @returns Canonical Workspace identifier, or undefined for irrelevant records.
 */
export function readTenantRetentionWorkspace(
  record: DynamoStreamRecord,
): string | undefined {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return undefined
  const image = record.dynamodb?.NewImage
  if (
    image?.kind?.S !== 'retention-job' ||
    image.recordKey?.S !== 'RETENTION_JOB' ||
    (image.status?.S !== 'pending' && image.status?.S !== 'running') ||
    !image.workspaceId?.S
  ) {
    return undefined
  }
  return image.workspaceId.S
}

/**
 * Reads a requested tenant operation from a validated stream image.
 *
 * @param record - Candidate DynamoDB stream record.
 * @returns A trusted start command, or undefined for irrelevant records.
 */
export function readRequestedTenantOperation(
  record: DynamoStreamRecord,
): ExecuteTenantOperationInput | undefined {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return undefined
  const image = record.dynamodb?.NewImage
  const workspaceId = image?.workspaceId?.S
  const recordKey = image?.recordKey?.S
  const payload = image?.payload?.S
  if (
    image?.kind?.S !== 'operation' ||
    !recordKey?.startsWith('OPERATION#')
  ) {
    return undefined
  }
  if (!workspaceId || !payload) {
    throw malformedTenantOperationRecord()
  }
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw malformedTenantOperationRecord()
  }
  if (
    !isRecord(value) ||
    value.status !== 'requested' ||
    typeof value.operationId !== 'string' ||
    value.workspaceId !== workspaceId ||
    recordKey !== `OPERATION#${value.operationId}`
  ) {
    throw malformedTenantOperationRecord()
  }
  return {
    workspaceId,
    operationId: value.operationId,
    executorId: 'executor:tenant-operation-stream',
  }
}

/** Creates a stable fail-closed error for one malformed lifecycle stream row. */
function malformedTenantOperationRecord(): TenantAdministrationError {
  return new TenantAdministrationError(
    503,
    'TenantOperationStreamRecordMalformed',
    'Tenant operation stream state is malformed.',
  )
}

/** Returns true when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
