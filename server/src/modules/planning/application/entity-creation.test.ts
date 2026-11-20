import { describe, expect, test } from 'bun:test'
import { PlanningError } from '../planning'
import { createPlanningEntityWithAssignedId } from './entity-creation'
import type {
  PlanningEntityCreationIdempotencyDecision,
  PlanningEntityCreationIdempotencyPort,
} from './ports/entity-creation-idempotency'

/**
 * Creates a request-key store double that answers every reservation with one decision.
 *
 * @param decision - Decision, or error, returned by every reservation.
 * @returns The store and the operations it recorded.
 */
function createIdempotencyDouble(decision: PlanningEntityCreationIdempotencyDecision | Error) {
  const calls: string[] = []
  const idempotency: PlanningEntityCreationIdempotencyPort = {
    async reserveIdempotency() {
      calls.push('reserve')
      if (decision instanceof Error) throw decision
      return decision
    },
    async completeIdempotency() {
      calls.push('complete')
    },
    async releaseIdempotency() {
      calls.push('release')
    },
  }
  return { idempotency, calls }
}

/** Base input shared by the use case tests. */
const baseInput = {
  workspaceId: 'directory:workspace',
  credentialId: 'user:caller',
  idempotencyKey: 'key-1',
  requestFingerprint: 'fingerprint',
  operation: 'create' as const,
  exists: async () => false,
}

describe('createPlanningEntityWithAssignedId', () => {
  test('derives the same ID for the same caller, operation, and key', async () => {
    const ids: string[] = []
    for (const credentialId of ['user:caller', 'user:caller', 'user:other']) {
      const { idempotency } = createIdempotencyDouble({ status: 'reserved', reservationId: 'r' })
      const outcome = await createPlanningEntityWithAssignedId({
        ...baseInput,
        credentialId,
        idempotency,
        create: async (entityId) => entityId,
      })
      ids.push(outcome.entityId)
    }
    expect(ids[0]).toMatch(/^pe-[0-9a-f]{32}$/u)
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
  })

  test('returns an entity that an earlier attempt with the same key already created', async () => {
    const { idempotency, calls } = createIdempotencyDouble({ status: 'reserved', reservationId: 'r' })
    let created = false
    const outcome = await createPlanningEntityWithAssignedId({
      ...baseInput,
      idempotency,
      exists: async () => true,
      create: async () => {
        created = true
        return 'created'
      },
    })
    expect(outcome.status).toBe('replay')
    expect(created).toBe(false)
    expect(calls).toEqual(['reserve', 'complete'])
  })

  test('releases the reservation when the creation throws', async () => {
    const { idempotency, calls } = createIdempotencyDouble({ status: 'reserved', reservationId: 'r' })
    const failure = new PlanningError(403, 'PlanningForbidden', 'Denied.')
    await expect(createPlanningEntityWithAssignedId({
      ...baseInput,
      idempotency,
      create: async () => {
        throw failure
      },
    })).rejects.toBe(failure)
    expect(calls).toEqual(['reserve', 'release'])
  })

  test('keeps the reservation when the creation outcome is unknown', async () => {
    for (const failure of [
      new PlanningError(503, 'PlanningPersistenceUnavailable', 'Unavailable.'),
      new Error('connection reset'),
    ]) {
      const { idempotency, calls } = createIdempotencyDouble({ status: 'reserved', reservationId: 'r' })
      await expect(createPlanningEntityWithAssignedId({
        ...baseInput,
        idempotency,
        create: async () => {
          throw failure
        },
      })).rejects.toBe(failure)
      expect(calls).toEqual(['reserve'])
    }
  })

  test('maps an unavailable store and an unexpected receipt to stable errors', async () => {
    const unavailable = createIdempotencyDouble(new Error('store down'))
    await expect(createPlanningEntityWithAssignedId({
      ...baseInput,
      idempotency: unavailable.idempotency,
      create: async () => 'created',
    })).rejects.toMatchObject({ status: 503, code: 'PlanningEntityIdempotencyUnavailable' })

    const tampered = createIdempotencyDouble({ status: 'replay', response: { status: 201, body: {} } })
    await expect(createPlanningEntityWithAssignedId({
      ...baseInput,
      idempotency: tampered.idempotency,
      create: async () => 'created',
    })).rejects.toMatchObject({ status: 502, code: 'PlanningEntityIdempotencyReceiptInvalid' })
    expect(tampered.calls).toEqual(['reserve'])
  })
})
