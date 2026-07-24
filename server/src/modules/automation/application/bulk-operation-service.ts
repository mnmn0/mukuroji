import { createHash } from 'node:crypto'
import {
  AUTOMATION_SCHEMA_VERSION,
  type BulkOperation,
  type BulkOperationItemResult,
  type BulkOperationPreview,
  type BulkOperationRequest,
} from '@mukuroji/contracts'
import { AutomationError } from '../domain/automation-error'
import { requireAutomationRecord } from '../domain/automation-record'
import { normalizeAutomationActionFailure } from './action-failure'
import type {
  AutomationBulkOperationPort,
  BulkOperationAdapter,
} from './ports'

const bulkEditableWorkItemFields = new Set([
  'assignedProjectId',
  'assigneeUserId',
  'customFieldValues',
  'description',
  'dueDate',
  'priority',
  'title',
  'workflowStatusId',
])

/**
 * Validates a Bulk request and previews every item without mutation.
 *
 * @param requestValue - Untrusted Bulk request.
 * @param adapter - Work Item validation and mutation boundary.
 * @returns Preview bound to a deterministic operation token.
 */
export async function previewBulkOperation(
  requestValue: BulkOperationRequest,
  adapter: BulkOperationAdapter,
): Promise<BulkOperationPreview> {
  const request = validateBulkOperationRequest(requestValue)
  const results = await Promise.all(request.items.map(async (item, itemIndex) => {
    try {
      const preview = await adapter.preview(request, itemIndex)
      const result: BulkOperationItemResult = {
        ...item,
        status: preview.allowed ? 'ready' : 'failed',
        ...(preview.errorCode ? { errorCode: preview.errorCode } : {}),
        ...(preview.errorMessage ? { errorMessage: preview.errorMessage } : {}),
        retryable: preview.retryable ?? false,
        undoable: false,
        ...(preview.undoPayload ? {
          undoPayload: structuredClone(preview.undoPayload),
        } : {}),
      }
      return result
    } catch (error) {
      const failure = normalizeAutomationActionFailure(error)
      return {
        ...item,
        status: 'failed',
        errorCode: failure.code,
        errorMessage: failure.message,
        retryable: failure.retryable,
        undoable: false,
      } satisfies BulkOperationItemResult
    }
  }))
  return {
    operationToken: createBulkOperationToken(request),
    action: request.action,
    items: results,
    canApply: results.every((item) => item.status === 'ready'),
  }
}

/**
 * Applies a token-bound Bulk preview while durably checkpointing each item.
 *
 * @param requestValue - Bulk request containing the preview token.
 * @param preview - Previously calculated preview.
 * @param adapter - Work Item mutation boundary.
 * @param actorMemberKey - Member initiating the operation.
 * @param client - Optional durable checkpoint port.
 * @returns Completed or partially completed durable operation.
 */
export async function applyBulkOperation(
  requestValue: BulkOperationRequest,
  preview: BulkOperationPreview,
  adapter: BulkOperationAdapter,
  actorMemberKey: string,
  client?: AutomationBulkOperationPort,
): Promise<BulkOperation> {
  const request = validateBulkOperationRequest(requestValue)
  const normalizedActorMemberKey = requireBoundedText(
    actorMemberKey,
    'Bulk operation actor member key',
    256,
  )
  if (
    !request.operationToken ||
    request.operationToken !== createBulkOperationToken(request) ||
    request.operationToken !== preview.operationToken
  ) {
    throw new AutomationError(
      'conflict',
      'BulkPreviewTokenConflict',
      'Bulk operation preview is stale.',
    )
  }
  const operationId = createBulkOperationId(
    request.workspaceId,
    request.operationToken,
    normalizedActorMemberKey,
  )
  const existingOperation = client
    ? await client.getBulkOperation(request.workspaceId, operationId)
    : undefined
  if (existingOperation) {
    if (existingOperation.actorMemberKey !== normalizedActorMemberKey) {
      throw new AutomationError(
        'forbidden',
        'BulkOperationForbidden',
        'Bulk operation access is denied.',
      )
    }
    return existingOperation.status === 'running'
      ? await retryBulkOperation(existingOperation, adapter, client)
      : existingOperation
  }
  if (!preview.canApply) {
    throw new AutomationError(
      'conflict',
      'BulkPreviewRejected',
      'Bulk preview contains invalid items.',
    )
  }
  const now = new Date().toISOString()
  const operation: BulkOperation = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: operationId,
    workspaceId: request.workspaceId,
    actorMemberKey: normalizedActorMemberKey,
    revision: 1,
    status: 'running',
    action: request.action,
    items: preview.items.map((item) => structuredClone(item)),
    createdAt: now,
    updatedAt: now,
  }
  if (client && !await client.createBulkOperation(operation)) {
    const concurrentlyCreated = await client.getBulkOperation(
      request.workspaceId,
      operationId,
    )
    if (concurrentlyCreated) return concurrentlyCreated
    throw new AutomationError(
      'unavailable',
      'BulkOperationUnavailable',
      'Bulk operation was created but is not yet available.',
      true,
    )
  }
  for (let itemIndex = 0; itemIndex < request.items.length; itemIndex += 1) {
    const checkpoint = operation.items[itemIndex]
    if (!checkpoint) {
      throw new AutomationError('unavailable', 'BulkOperationInvalid', 'Bulk checkpoint is invalid.')
    }
    operation.items[itemIndex] = await applyBulkItem(
      request,
      checkpoint,
      itemIndex,
      adapter,
    )
    operation.updatedAt = new Date().toISOString()
    await saveBulkOperationCheckpoint(operation, client)
  }
  operation.status = summarizeBulkStatus(operation.items)
  operation.updatedAt = new Date().toISOString()
  await saveBulkOperationCheckpoint(operation, client)
  return operation
}

/**
 * Retries only pending or retryable failed items in a durable Bulk operation.
 *
 * @param operation - Durable operation to resume.
 * @param adapter - Work Item mutation boundary.
 * @param client - Optional durable checkpoint port.
 * @returns Updated operation.
 */
export async function retryBulkOperation(
  operation: BulkOperation,
  adapter: BulkOperationAdapter,
  client?: AutomationBulkOperationPort,
): Promise<BulkOperation> {
  const retryableIndexes: number[] = []
  for (let itemIndex = 0; itemIndex < operation.items.length; itemIndex += 1) {
    const item = requireBulkOperationCheckpoint(operation, itemIndex)
    if (item.status === 'ready' || (item.status === 'failed' && item.retryable)) {
      retryableIndexes.push(itemIndex)
    }
  }
  if (retryableIndexes.length === 0) {
    if (operation.status === 'running') {
      operation.status = summarizeBulkStatus(operation.items)
      operation.updatedAt = new Date().toISOString()
      await saveBulkOperationCheckpoint(operation, client)
    }
    return operation
  }
  const request: BulkOperationRequest = {
    workspaceId: operation.workspaceId,
    action: operation.action,
    items: operation.items.map(({ teamId, workItemId, expectedRevision }) => ({
      teamId,
      workItemId,
      expectedRevision,
    })),
  }
  operation.status = 'running'
  operation.updatedAt = new Date().toISOString()
  await saveBulkOperationCheckpoint(operation, client)
  for (const itemIndex of retryableIndexes) {
    const item = requireBulkOperationCheckpoint(operation, itemIndex)
    operation.items[itemIndex] = await applyBulkItem(request, item, itemIndex, adapter)
    operation.updatedAt = new Date().toISOString()
    await saveBulkOperationCheckpoint(operation, client)
  }
  operation.status = summarizeBulkStatus(operation.items)
  operation.updatedAt = new Date().toISOString()
  await saveBulkOperationCheckpoint(operation, client)
  return operation
}

/**
 * Undoes successful Bulk items in reverse order with saved revision guards.
 *
 * @param operation - Durable operation to undo.
 * @param adapter - Work Item mutation boundary.
 * @param client - Optional durable checkpoint port.
 * @returns Updated operation.
 */
export async function undoBulkOperation(
  operation: BulkOperation,
  adapter: BulkOperationAdapter,
  client?: AutomationBulkOperationPort,
): Promise<BulkOperation> {
  for (let index = 0; index < operation.items.length; index += 1) {
    requireBulkOperationCheckpoint(operation, index)
  }
  operation.status = 'undoing'
  operation.updatedAt = new Date().toISOString()
  await saveBulkOperationCheckpoint(operation, client)
  for (let index = operation.items.length - 1; index >= 0; index -= 1) {
    const item = requireBulkOperationCheckpoint(operation, index)
    if (item.status !== 'succeeded' || !item.undoable) continue
    try {
      const result = await adapter.undo(operation, index)
      operation.items[index] = {
        ...item,
        status: 'undone',
        resultingRevision: result.resultingRevision,
        retryable: false,
        undoable: false,
      }
    } catch (error) {
      const failure = normalizeAutomationActionFailure(error)
      operation.items[index] = failure.retryable
        ? {
            ...item,
            errorCode: failure.code,
            errorMessage: failure.message,
            retryable: true,
          }
        : {
            ...item,
            status: 'failed',
            errorCode: failure.code,
            errorMessage: failure.message,
            retryable: false,
          }
    }
    operation.updatedAt = new Date().toISOString()
    await saveBulkOperationCheckpoint(operation, client)
  }
  operation.status = operation.items.every((item) =>
    item.status === 'undone' || item.status === 'skipped'
  )
    ? 'undone'
    : 'partial'
  operation.updatedAt = new Date().toISOString()
  await saveBulkOperationCheckpoint(operation, client)
  return operation
}

/**
 * Creates a deterministic token bound to Bulk scope, targets, and action.
 *
 * @param request - Bulk request to bind.
 * @returns Deterministic preview token.
 */
export function createBulkOperationToken(request: BulkOperationRequest): string {
  const normalized = {
    workspaceId: request.workspaceId,
    items: request.items,
    action: request.action,
  }
  return `bulk_preview_${createHash('sha256')
    .update(canonicalString(normalized))
    .digest('hex')}`
}

/** Creates a deterministic actor-bound operation identifier. */
function createBulkOperationId(
  workspaceId: string,
  operationToken: string,
  actorMemberKey: string,
): string {
  const digest = createHash('sha256')
    .update(`${workspaceId}\0${operationToken}\0${actorMemberKey}`)
    .digest('hex')
  return `bulk_${digest}`
}

/** Validates an untrusted Bulk operation request. */
function validateBulkOperationRequest(value: unknown): BulkOperationRequest {
  const request = requireRecord(value, 'Bulk operation request')
  const workspaceId = requireBoundedText(request.workspaceId, 'Bulk Workspace ID', 256)
  if (
    !Array.isArray(request.items) ||
    request.items.length === 0 ||
    request.items.length > 100
  ) {
    throw invalidInput('Bulk operation must contain between 1 and 100 items.')
  }
  const items = request.items.map((value) => {
    const item = requireRecord(value, 'Bulk operation item')
    return {
      teamId: requireBoundedText(item.teamId, 'Bulk Team ID', 256),
      workItemId: requireBoundedText(item.workItemId, 'Bulk Work Item ID', 256),
      expectedRevision: requireInteger(
        item.expectedRevision,
        'Bulk expected revision',
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    }
  })
  const uniqueTargets = new Set(items.map((item) => `${item.teamId}\0${item.workItemId}`))
  if (uniqueTargets.size !== items.length) {
    throw invalidInput('Bulk operation items must be unique.')
  }
  const action = requireRecord(request.action, 'Bulk operation action')
  let normalizedAction: BulkOperationRequest['action']
  if (action.type === 'edit') {
    const patch = requireAutomationRecord(action.patch, 'Bulk edit patch')
    if (Object.keys(patch).length === 0) throw invalidInput('Bulk edit patch is invalid.')
    const unsupportedFields = Object.keys(patch)
      .filter((field) => !bulkEditableWorkItemFields.has(field))
    if (unsupportedFields.length > 0) {
      throw invalidInput(`Bulk edit cannot update fields: ${unsupportedFields.join(', ')}.`)
    }
    normalizedAction = { type: 'edit', patch }
  } else if (action.type === 'move') {
    normalizedAction = {
      type: 'move',
      targetProjectId: action.targetProjectId === null
        ? null
        : requireBoundedText(action.targetProjectId, 'Bulk target Project ID', 256),
    }
  } else if (action.type === 'archive') {
    normalizedAction = {
      type: 'archive',
      archived: requireBoolean(action.archived, 'Bulk archived'),
    }
  } else {
    throw invalidInput('Bulk operation action is invalid.')
  }
  return {
    workspaceId,
    items,
    action: normalizedAction,
    ...(request.operationToken === undefined ? {} : {
      operationToken: requireBoundedText(
        request.operationToken,
        'Bulk operation token',
        256,
      ),
    }),
  }
}

/** Applies one Bulk item and converts failures to stable checkpoint state. */
async function applyBulkItem(
  request: BulkOperationRequest,
  item: BulkOperationItemResult,
  itemIndex: number,
  adapter: BulkOperationAdapter,
): Promise<BulkOperationItemResult> {
  try {
    const result = await adapter.apply(request, itemIndex, item)
    return {
      ...item,
      status: 'succeeded',
      resultingRevision: result.resultingRevision,
      retryable: false,
      undoable: result.undoPayload !== undefined,
      ...(result.undoPayload ? { undoPayload: result.undoPayload } : {}),
    }
  } catch (error) {
    const failure = normalizeAutomationActionFailure(error)
    return {
      ...item,
      status: 'failed',
      errorCode: failure.code,
      errorMessage: failure.message,
      retryable: failure.retryable,
      undoable: false,
    }
  }
}

/** Summarizes item checkpoints into the durable operation status. */
function summarizeBulkStatus(
  items: readonly BulkOperationItemResult[],
): BulkOperation['status'] {
  const succeeded = items.filter((item) => item.status === 'succeeded').length
  if (succeeded === items.length) return 'succeeded'
  if (succeeded > 0) return 'partial'
  return 'failed'
}

/**
 * Reads one required checkpoint from a durable Bulk operation.
 *
 * @param operation - Durable operation being resumed or undone.
 * @param itemIndex - Zero-based checkpoint index.
 * @returns The required checkpoint.
 */
function requireBulkOperationCheckpoint(
  operation: BulkOperation,
  itemIndex: number,
): BulkOperationItemResult {
  const checkpoint = operation.items[itemIndex]
  if (!checkpoint) {
    throw new AutomationError(
      'unavailable',
      'BulkOperationInvalid',
      'Bulk checkpoint is invalid.',
    )
  }
  return checkpoint
}

/** Saves one revision-fenced operation checkpoint. */
async function saveBulkOperationCheckpoint(
  operation: BulkOperation,
  client: AutomationBulkOperationPort | undefined,
): Promise<void> {
  const expectedRevision = operation.revision
  operation.revision = expectedRevision + 1
  if (!client) return
  try {
    await client.saveBulkOperation(operation, expectedRevision)
  } catch (error) {
    operation.revision = expectedRevision
    throw error
  }
}

/** Reads a plain record from untrusted input. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidInput(`${label} must be an object.`)
  return value
}

/** Narrows an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads required bounded text from untrusted input. */
function requireBoundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidInput(`${label} is required.`)
  }
  const text = value.trim()
  if (text.length > maximum) {
    throw invalidInput(`${label} must be ${maximum} characters or fewer.`)
  }
  return text
}

/** Reads a boolean from untrusted input. */
function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidInput(`${label} must be boolean.`)
  return value
}

/** Reads a bounded integer from untrusted input. */
function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidInput(
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    )
  }
  return value
}

/** Creates the stable invalid-input error. */
function invalidInput(message: string): AutomationError {
  return new AutomationError('invalid-input', 'InvalidAutomationInput', message)
}

/** Produces a deterministic representation for JSON-compatible values. */
function canonicalString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalString(value[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}
