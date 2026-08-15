import {
  TENANT_OPERATION_EXECUTION_JOB_VERSION,
  type TenantOperationExecutionJob,
} from '../../application/tenant-operation-resource-owner'
import { TenantAdministrationError } from '../../domain/tenant-administration'

/** Previous queue protocol version whose table target cursor needs rebasing. */
const PREVIOUS_TENANT_OPERATION_EXECUTION_JOB_VERSION = 1 as const

/** Minimal SQS record accepted by a tenant resource-owner Lambda. */
export type TenantOperationSqsRecord = {
  /** Stable SQS message identifier used for partial batch failure. */
  messageId?: string
  /** JSON-encoded ID-only tenant operation job. */
  body?: string
}

/** Minimal SQS event accepted by a tenant resource-owner Lambda. */
export type TenantOperationSqsEvent = {
  /** Queue records delivered in this invocation. */
  Records?: TenantOperationSqsRecord[]
}

/** Partial SQS batch response returned by resource-owner workers. */
export type TenantOperationSqsBatchResponse = {
  /** Message IDs that must be retried by SQS. */
  batchItemFailures: Array<{ itemIdentifier: string }>
}

/** Queue processor capability used by the SQS adapter. */
export interface TenantOperationResourceOwnerProcessor {
  /**
   * Processes one validated resource-owner job.
   *
   * @param job - ID-only queue job.
   */
  execute(job: TenantOperationExecutionJob): Promise<unknown>
}

/**
 * Processes resource-owner queue records with partial batch failure semantics.
 *
 * @param event - Candidate SQS event.
 * @param processor - Capability-isolated resource-owner processor.
 * @returns IDs of records that must be retried.
 */
export async function processTenantOperationResourceOwnerBatch(
  event: TenantOperationSqsEvent,
  processor: TenantOperationResourceOwnerProcessor,
): Promise<TenantOperationSqsBatchResponse> {
  const failures: Array<{ itemIdentifier: string }> = []
  for (const record of event.Records ?? []) {
    try {
      await processor.execute(readTenantOperationExecutionJob(record.body))
    } catch (error) {
      console.error('Tenant operation resource owner failed.', {
        code: isRecord(error) && typeof error.code === 'string'
          ? error.code
          : 'TenantOperationResourceOwnerFailed',
        name: isRecord(error) && typeof error.name === 'string'
          ? error.name
          : 'Error',
      })
      if (!record.messageId) throw error
      failures.push({ itemIdentifier: record.messageId })
    }
  }
  return { batchItemFailures: failures }
}

/**
 * Validates one ID-only resource-owner queue message.
 *
 * @param body - Candidate SQS message body.
 * @returns A normalized tenant operation job.
 */
export function readTenantOperationExecutionJob(
  body: string | undefined,
): TenantOperationExecutionJob {
  let value: unknown
  try {
    value = JSON.parse(body ?? '')
  } catch {
    throw invalidJob()
  }
  if (
    !isRecord(value) ||
    (value.version !== TENANT_OPERATION_EXECUTION_JOB_VERSION &&
      value.version !== PREVIOUS_TENANT_OPERATION_EXECUTION_JOB_VERSION) ||
    !isIdentifier(value.workspaceId) ||
    !isIdentifier(value.operationId) ||
    !isTenantOperationStep(value.step)
  ) {
    throw invalidJob()
  }
  const cursor = value.cursor === undefined
    ? undefined
    : readCursor(value.cursor)
  const normalizedCursor = value.version === PREVIOUS_TENANT_OPERATION_EXECUTION_JOB_VERSION
    ? rebasePreviousTargetCursor(value.step, cursor)
    : cursor
  return {
    version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
    workspaceId: value.workspaceId,
    operationId: value.operationId,
    step: value.step,
    ...(normalizedCursor ? { cursor: normalizedCursor } : {}),
  }
}

/**
 * Rebases a previous queue cursor after removing its first DynamoDB target.
 *
 * @param step - Lifecycle step owning the cursor.
 * @param cursor - Validated cursor from the previous protocol version.
 * @returns A cursor aligned with the current target list.
 */
function rebasePreviousTargetCursor(
  step: TenantOperationExecutionJob['step'],
  cursor: TenantOperationExecutionJob['cursor'],
): TenantOperationExecutionJob['cursor'] {
  if (!cursor || !usesRemovedFirstTarget(step, cursor.phase)) return cursor

  if (cursor.targetIndex === 0) {
    return {
      targetIndex: 0,
      processedCount: cursor.processedCount,
      ...(cursor.phase ? { phase: cursor.phase } : {}),
    }
  }

  return {
    ...cursor,
    targetIndex: cursor.targetIndex - 1,
  }
}

/** Returns whether a lifecycle cursor used the removed first DynamoDB target. */
function usesRemovedFirstTarget(
  step: TenantOperationExecutionJob['step'],
  phase: NonNullable<TenantOperationExecutionJob['cursor']>['phase'],
): boolean {
  return step === 'delete-data' ||
    step === 'verify' ||
    (step === 'export' && (phase === undefined || phase === 'snapshot'))
}

/** Validates one bounded secret-free continuation cursor. */
function readCursor(value: unknown): TenantOperationExecutionJob['cursor'] {
  if (
    !isRecord(value) ||
    typeof value.targetIndex !== 'number' ||
    !Number.isSafeInteger(value.targetIndex) ||
    value.targetIndex < 0 ||
    typeof value.processedCount !== 'number' ||
    !Number.isSafeInteger(value.processedCount) ||
    value.processedCount < 0 ||
    (value.position !== undefined &&
      (typeof value.position !== 'string' || value.position.length > 8_192)) ||
    (value.phase !== undefined &&
      value.phase !== 'snapshot' &&
      value.phase !== 'prepare' &&
      value.phase !== 'verify')
  ) {
    throw invalidJob()
  }
  return {
    targetIndex: value.targetIndex,
    processedCount: value.processedCount,
    ...(typeof value.position === 'string' ? { position: value.position } : {}),
    ...(value.phase === 'snapshot' || value.phase === 'prepare' || value.phase === 'verify'
      ? { phase: value.phase }
      : {}),
  }
}

/** Returns true for one bounded lifecycle step. */
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

/** Returns true for one bounded tenant or operation identifier. */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[a-zA-Z0-9#@._/-]{1,256}$/u.test(value)
}

/** Creates a safe malformed-job error. */
function invalidJob(): TenantAdministrationError {
  return new TenantAdministrationError(
    400,
    'TenantOperationExecutionJobInvalid',
    'Tenant operation execution job is invalid.',
  )
}

/** Returns true for a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
