import type {
  CompleteIdempotencyRequest,
  ConsumeRateLimitRequest,
  IdempotencyPort,
  RateLimitPort,
  ReleaseIdempotencyRequest,
  ReserveIdempotencyRequest,
} from '../../application/ports'

/** Focused adapter for idempotency reservation and replay operations. */
export class IdempotencyAdapter implements IdempotencyPort {
  /** Storage implementation that owns idempotency records. */
  readonly #source: IdempotencyPort

  /** Creates a focused idempotency adapter. */
  constructor(source: IdempotencyPort) {
    this.#source = source
  }

  /** Reserves an idempotency key. */
  reserveIdempotency(request: ReserveIdempotencyRequest) {
    return this.#source.reserveIdempotency(request)
  }

  /** Completes an idempotency reservation. */
  completeIdempotency(request: CompleteIdempotencyRequest) {
    return this.#source.completeIdempotency(request)
  }

  /** Releases an idempotency reservation. */
  releaseIdempotency(request: ReleaseIdempotencyRequest) {
    return this.#source.releaseIdempotency(request)
  }
}

/** Focused adapter for fixed-window rate limiting. */
export class RateLimitAdapter implements RateLimitPort {
  /** Storage implementation that owns rate-limit records. */
  readonly #source: RateLimitPort

  /** Creates a focused rate-limit adapter. */
  constructor(source: RateLimitPort) {
    this.#source = source
  }

  /** Consumes rate-limit capacity. */
  consumeRateLimit(request: ConsumeRateLimitRequest) {
    return this.#source.consumeRateLimit(request)
  }
}
