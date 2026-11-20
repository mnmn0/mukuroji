/** Reservation identity of one idempotent Planning entity creation. */
export type PlanningEntityCreationReservationRequest = {
  /** Opaque Workspace namespace of the reservation. */
  workspaceId: string
  /** Opaque caller namespace of the reservation. */
  credentialId: string
  /** Caller-provided request key. */
  idempotencyKey: string
  /** Digest that binds the key to one exact request. */
  requestFingerprint: string
}

/** Reservation owned by the request that must create the entity. */
export type PlanningEntityCreationOwnedReservation = PlanningEntityCreationReservationRequest & {
  /** Ownership token returned by the reservation. */
  reservationId: string
}

/** Decision returned when a Planning entity creation is reserved. */
export type PlanningEntityCreationIdempotencyDecision =
  | {
      /** This request owns the reservation. */
      status: 'reserved'
      /** Ownership token used to complete or release the reservation. */
      reservationId: string
    }
  | {
      /** Another request with the same key has not finished yet. */
      status: 'in-progress'
    }
  | {
      /** A request with the same key already finished. */
      status: 'replay'
      /** Receipt stored by the finished request. */
      response: unknown
    }

/**
 * Durable request-key store used by Planning entity creation.
 *
 * `reserveIdempotency` throws an error whose `code` is `IdempotencyKeyConflict` when the key was
 * already used for a different request.
 */
export interface PlanningEntityCreationIdempotencyPort {
  /** Reserves a request key, or returns the receipt of an earlier finished request. */
  reserveIdempotency(
    request: PlanningEntityCreationReservationRequest,
  ): Promise<PlanningEntityCreationIdempotencyDecision>
  /** Stores the receipt of the committed request that owns the reservation. */
  completeIdempotency(
    request: PlanningEntityCreationOwnedReservation & {
      /** JSON-safe receipt stored for replays. */
      response: unknown
    },
  ): Promise<void>
  /** Releases a reservation whose request did not commit. */
  releaseIdempotency(request: PlanningEntityCreationOwnedReservation): Promise<void>
}
