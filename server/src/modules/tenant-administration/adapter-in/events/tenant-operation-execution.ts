import type {
  BatchResponse,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from '../../../../infrastructure/aws/dynamodb-stream'
import type { ExecuteTenantOperationInput } from '../../application/tenant-operation-executor'
import {
  TENANT_OPERATION_EXECUTION_JOB_VERSION,
  type TenantOperationExecutionJob,
} from '../../application/tenant-operation-resource-owner'
import { TenantAdministrationError } from '../../domain/tenant-administration'

/** Capability used by the internal tenant lifecycle event adapter. */
export interface TenantOperationExecutionProcessor {
  /** Starts or advances one evidence-backed tenant operation. */
  execute(input: ExecuteTenantOperationInput): Promise<unknown>
  /** Routes one running step to its capability-isolated durable queue. */
  dispatchOperationExecution?(job: TenantOperationExecutionJob): Promise<unknown>
  /** Applies one bounded page of tenant audit-retention reconciliation. */
  reconcileAuditRetention(workspaceId: string): Promise<unknown>
  /** Applies current tenant retention policy to one newly inserted audit event. */
  reconcileAuditEventRetention(
    workspaceId: string,
    eventId: string,
    occurredAt: string,
  ): Promise<unknown>
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
      const executionJob = readRunnableTenantOperation(record)
      if (executionJob) {
        if (!processor.dispatchOperationExecution) {
          throw new TenantAdministrationError(
            503,
            'TenantOperationDispatcherUnavailable',
            'Tenant operation resource-owner dispatcher is unavailable.',
          )
        }
        await processor.dispatchOperationExecution(executionJob)
        continue
      }
      const retentionWorkspaceId = readTenantRetentionWorkspace(record)
      if (retentionWorkspaceId) {
        await processor.reconcileAuditRetention(retentionWorkspaceId)
        continue
      }
      const auditEvent = readTenantAuditRetentionEvent(record)
      if (auditEvent) {
        await processor.reconcileAuditEventRetention(
          auditEvent.workspaceId,
          auditEvent.eventId,
          auditEvent.occurredAt,
        )
      }
    } catch (error) {
      console.error('Tenant operation execution failed.', {
        code: isRecord(error) && typeof error.code === 'string'
          ? error.code
          : 'TenantOperationExecutionFailed',
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
    !isTenantOperationStatus(value.status) ||
    typeof value.operationId !== 'string' ||
    value.workspaceId !== workspaceId ||
    recordKey !== `OPERATION#${value.operationId}`
  ) {
    throw malformedTenantOperationRecord()
  }
  if (value.status !== 'requested') return undefined
  return {
    workspaceId,
    operationId: value.operationId,
    executorId: 'executor:tenant-operation-stream',
  }
}

/**
 * Reads one running tenant operation into an ID-only resource-owner job.
 *
 * @param record - Candidate DynamoDB stream record.
 * @returns A validated queue job, or undefined for another record or state.
 */
export function readRunnableTenantOperation(
  record: DynamoStreamRecord,
): TenantOperationExecutionJob | undefined {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') {
    return undefined
  }
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
  if (!workspaceId || !payload) throw malformedTenantOperationRecord()
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw malformedTenantOperationRecord()
  }
  if (
    !isRecord(value) ||
    value.status !== 'running' ||
    typeof value.operationId !== 'string' ||
    value.workspaceId !== workspaceId ||
    recordKey !== `OPERATION#${value.operationId}` ||
    !isTenantOperationStep(value.currentStep)
  ) {
    if (isRecord(value) && value.status !== 'running') return undefined
    throw malformedTenantOperationRecord()
  }
  return {
    version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
    workspaceId,
    operationId: value.operationId,
    step: value.currentStep,
  }
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
  if (
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

/** Returns true for a durable tenant operation status. */
function isTenantOperationStatus(value: unknown): boolean {
  return value === 'requested' ||
    value === 'running' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'verified'
}

/** Returns true for one bounded tenant lifecycle step. */
function isTenantOperationStep(
  value: unknown,
): value is TenantOperationExecutionJob['step'] {
  return value === 'snapshot' ||
    value === 'prepare-artifact' ||
    value === 'verify-artifact' ||
    value === 'export' ||
    value === 'revoke-access' ||
    value === 'anonymize-members' ||
    value === 'delete-data' ||
    value === 'delete-secrets' ||
    value === 'verify'
}
