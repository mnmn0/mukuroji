import { createHash } from 'node:crypto'
import { PlanningError } from '../planning'
import type {
  PlanningEntityCreationIdempotencyDecision,
  PlanningEntityCreationIdempotencyPort,
  PlanningEntityCreationOwnedReservation,
} from './ports/entity-creation-idempotency'

/** Planning entity mutation that can receive a server-assigned entity ID. */
export type PlanningEntityCreationOperation = 'create' | 'duplicate'

/** Prefix of Planning entity IDs assigned by the server. */
const SERVER_ASSIGNED_PLANNING_ENTITY_ID_PREFIX = 'pe-'

/** Stable schema discriminator for Planning entity creation receipts. */
const PLANNING_ENTITY_CREATION_RECEIPT_SCHEMA = 'planning-entity-creation'

/** Current Planning entity creation receipt version. */
const PLANNING_ENTITY_CREATION_RECEIPT_VERSION = 1

/** Input of one create or duplicate request that omitted the new entity ID. */
export type PlanningEntityCreationWithAssignedIdInput<TResult> = {
  /** Durable request-key store. */
  idempotency: PlanningEntityCreationIdempotencyPort
  /** Opaque Workspace namespace of the reservation. */
  workspaceId: string
  /** Opaque caller namespace of the reservation; it also scopes the derived entity ID. */
  credentialId: string
  /** Raw `Idempotency-Key` header value. */
  idempotencyKey: string | undefined
  /** Digest that binds the key to the exact method, path, and body of the request. */
  requestFingerprint: string
  /** Mutation that creates the entity. */
  operation: PlanningEntityCreationOperation
  /**
   * Authorizes and commits the creation with the assigned ID. It must not return before the
   * entity is committed, and must throw when nothing was committed.
   */
  create: (entityId: string) => Promise<TResult>
}

/** Outcome of one create or duplicate request that omitted the new entity ID. */
export type PlanningEntityCreationWithAssignedIdOutcome<TResult> =
  | {
      /** An earlier request with the same key created the entity. */
      status: 'replay'
      /** Server-assigned ID of the entity the earlier request created. */
      entityId: string
    }
  | {
      /** This request created the entity. */
      status: 'created'
      /** Server-assigned ID of the created entity. */
      entityId: string
      /** Result returned by the create callback. */
      result: TResult
    }

/**
 * Creates or duplicates a Planning entity with a server-assigned ID, once per request key.
 *
 * The ID depends only on the caller, the operation, and the request key. The receipt is stored
 * after the commit, so a lost receipt can leave the reservation incomplete; a later retry then
 * targets the same ID and the domain rejects it as an existing entity instead of creating a
 * second one.
 *
 * @param input - Reservation scope, request key, and the creation to run.
 * @returns Replay of an earlier success, or the result of this creation.
 */
export async function createPlanningEntityWithAssignedId<TResult>(
  input: PlanningEntityCreationWithAssignedIdInput<TResult>,
): Promise<PlanningEntityCreationWithAssignedIdOutcome<TResult>> {
  const idempotencyKey = readPlanningEntityIdempotencyKey(input.idempotencyKey)
  const entityId = createServerAssignedPlanningEntityId(
    input.credentialId,
    input.operation,
    idempotencyKey,
  )
  const request = {
    workspaceId: input.workspaceId,
    credentialId: input.credentialId,
    idempotencyKey,
    requestFingerprint: input.requestFingerprint,
  }
  const decision = await reservePlanningEntityCreation(input.idempotency, request)
  if (decision.status === 'in-progress') {
    throw new PlanningError(
      409,
      'PlanningEntityIdempotencyInProgress',
      'The same Planning entity request is still in progress.',
    )
  }
  const receipt = createPlanningEntityCreationReceipt(input.workspaceId, input.operation, entityId)
  if (decision.status === 'replay') {
    if (JSON.stringify(decision.response) !== JSON.stringify(receipt)) {
      throw new PlanningError(
        502,
        'PlanningEntityIdempotencyReceiptInvalid',
        'The stored Planning entity receipt is invalid.',
      )
    }
    return { status: 'replay', entityId }
  }
  const reservation: PlanningEntityCreationOwnedReservation = {
    ...request,
    reservationId: decision.reservationId,
  }
  let result: TResult
  try {
    result = await input.create(entityId)
  } catch (error) {
    await input.idempotency.releaseIdempotency(reservation).catch(() => undefined)
    throw error
  }
  await input.idempotency
    .completeIdempotency({ ...reservation, response: receipt })
    .catch(() => undefined)
  return { status: 'created', entityId, result }
}

/**
 * Validates the request key required when a create or duplicate request omits the new entity ID.
 *
 * @param value - Raw `Idempotency-Key` header value.
 * @returns Trimmed key safe for the durable reservation port.
 */
function readPlanningEntityIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? ''
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new PlanningError(
      400,
      'InvalidPlanningEntityIdempotencyKey',
      'Idempotency-Key with 1 to 256 characters and no control characters is required when the entity ID is omitted.',
    )
  }
  return key
}

/**
 * Derives the entity ID for one idempotent create or duplicate request.
 *
 * @param credentialId - Opaque caller namespace, already scoped to the Workspace.
 * @param operation - Mutation that creates the entity.
 * @param idempotencyKey - Validated caller-provided request key.
 * @returns Entity ID with the server-assigned prefix.
 */
function createServerAssignedPlanningEntityId(
  credentialId: string,
  operation: PlanningEntityCreationOperation,
  idempotencyKey: string,
): string {
  const digest = createHash('sha256')
    .update(`planning-entity-id-v1\0${credentialId}\0${operation}\0${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32)
  return `${SERVER_ASSIGNED_PLANNING_ENTITY_ID_PREFIX}${digest}`
}

/**
 * Creates the compact receipt stored for one successful entity creation.
 *
 * @param workspaceId - Opaque Workspace namespace of the reservation.
 * @param operation - Mutation that created the entity.
 * @param entityId - Server-assigned ID of the created entity.
 * @returns Replay response holding only the original status and entity ID.
 */
function createPlanningEntityCreationReceipt(
  workspaceId: string,
  operation: PlanningEntityCreationOperation,
  entityId: string,
) {
  return {
    status: 201,
    body: {
      schema: PLANNING_ENTITY_CREATION_RECEIPT_SCHEMA,
      version: PLANNING_ENTITY_CREATION_RECEIPT_VERSION,
      workspaceId,
      operation,
      entityId,
    },
  }
}

/**
 * Reserves one request key and maps store failures to stable Planning errors.
 *
 * @param idempotency - Durable request-key store.
 * @param request - Reservation identity.
 * @returns Reservation, in-progress, or replay decision.
 */
async function reservePlanningEntityCreation(
  idempotency: PlanningEntityCreationIdempotencyPort,
  request: Parameters<PlanningEntityCreationIdempotencyPort['reserveIdempotency']>[0],
): Promise<PlanningEntityCreationIdempotencyDecision> {
  try {
    return await idempotency.reserveIdempotency(request)
  } catch (error) {
    if (readErrorCode(error) === 'IdempotencyKeyConflict') {
      throw new PlanningError(
        409,
        'PlanningEntityIdempotencyConflict',
        'Idempotency-Key was already used for a different Planning request.',
      )
    }
    throw new PlanningError(
      503,
      'PlanningEntityIdempotencyUnavailable',
      'Planning entity idempotency is unavailable.',
    )
  }
}

/**
 * Reads the stable `code` of an error thrown by the request-key store.
 *
 * @param error - Thrown value.
 * @returns Error code, when the value carries a string code.
 */
function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
