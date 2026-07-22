/** Token that binds an idempotency receipt to a domain mutation. */
export type IdempotencyMutationToken = {
  /** Credential-scoped idempotency namespace. */
  credentialId: string
  /** Caller-provided idempotency key. */
  idempotencyKey: string
  /** Stable fingerprint of method, target, and body. */
  requestFingerprint: string
  /** Opaque reservation ownership token. */
  reservationId: string
}

/** HTTP response committed atomically with a domain mutation. */
export type IdempotencyMutationResponse = {
  /** HTTP status replayed to the caller. */
  status: 200 | 201 | 202 | 204
  /** Response body replayed to the caller. */
  body: unknown
}

/** Domain mutation request that can carry an atomic idempotency token. */
export type IdempotentDomainMutationRequest = {
  /** Token used to commit a response receipt with the domain row. */
  idempotency?: IdempotencyMutationToken
}

/** Idempotency reservation request. */
export type ReserveIdempotencyRequest = {
  /** Workspace handling the request. */
  workspaceId: string
  /** Credential-scoped idempotency namespace. */
  credentialId: string
  /** Caller-provided idempotency key. */
  idempotencyKey: string
  /** Stable fingerprint of method, path, and body. */
  requestFingerprint: string
  /** Optional receipt retention period in seconds. */
  ttlSeconds?: number
}

/** Decision returned when an idempotency key is reserved. */
export type IdempotencyDecision =
  | {
      /** The first caller may start processing. */
      status: 'reserved'
      /** Ownership token required to complete the reservation. */
      reservationId: string
    }
  | {
      /** An equivalent request is still processing. */
      status: 'in-progress'
    }
  | {
      /** A stored response can be replayed. */
      status: 'replay'
      /** Previously stored JSON-safe response. */
      response: unknown
    }

/** Request used to complete an idempotency reservation. */
export type CompleteIdempotencyRequest = ReserveIdempotencyRequest & {
  /** Ownership token returned by the reservation. */
  reservationId: string
  /** JSON-safe response stored for replay. */
  response: unknown
}

/** Request used to release an incomplete idempotency reservation. */
export type ReleaseIdempotencyRequest = ReserveIdempotencyRequest & {
  /** Ownership token returned by the reservation. */
  reservationId: string
}

/** Fixed-window rate-limit consumption request. */
export type ConsumeRateLimitRequest = {
  /** Workspace that owns the credential. */
  workspaceId: string
  /** Credential whose window is consumed. */
  credentialId: string
  /** Maximum request cost within the window. */
  limit: number
  /** Window duration in seconds. */
  windowSeconds: number
  /** Cost consumed by this request. */
  cost?: number
}

/** Current fixed-window rate-limit decision. */
export type RateLimitDecision = {
  /** Whether the request may proceed. */
  allowed: boolean
  /** Configured window limit. */
  limit: number
  /** Cost remaining after this decision. */
  remaining: number
  /** Timestamp at which the window resets. */
  resetAt: string
  /** Seconds to wait when the request is rejected. */
  retryAfterSeconds?: number
}

/** Application port for idempotency reservation and replay. */
export interface IdempotencyPort {
  /** Reserves, replays, or rejects an idempotency key. */
  reserveIdempotency(request: ReserveIdempotencyRequest): Promise<IdempotencyDecision>
  /** Stores a response for the current reservation owner. */
  completeIdempotency(request: CompleteIdempotencyRequest): Promise<void>
  /** Releases an incomplete reservation owned by the caller. */
  releaseIdempotency(request: ReleaseIdempotencyRequest): Promise<void>
}

/** Application port for credential-scoped fixed-window rate limiting. */
export interface RateLimitPort {
  /** Atomically consumes cost from the current fixed window. */
  consumeRateLimit(request: ConsumeRateLimitRequest): Promise<RateLimitDecision>
}
