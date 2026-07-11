/**
 * 一つの logical mutation と、その retry で共有する request context です。
 */
export type MutationRequestContext = {
  /**
   * State/event の重複作成を防ぐ idempotency key です。
   */
  readonly idempotencyKey: string
  /**
   * 同じ mutation から派生する処理を関連付ける correlation ID です。
   */
  readonly correlationId: string
}

/**
 * 一つの logical mutation で保持し、すべての retry に再利用する context を作成します。
 *
 * @returns 同じ UUID を共有する idempotency key と correlation ID です。
 */
export function createMutationRequestContext(): MutationRequestContext {
  const requestId = globalThis.crypto.randomUUID()

  return {
    idempotencyKey: requestId,
    correlationId: requestId,
  }
}

/**
 * Business mutation request の再送制御と追跡に使う header を生成します。
 *
 * @param context logical mutation の初回 request と retry で共有する context です。
 * @returns idempotency key と correlation ID を含む HTTP headers です。
 */
export function createMutationHeaders(
  context: MutationRequestContext = createMutationRequestContext(),
) {
  return {
    'Idempotency-Key': context.idempotencyKey,
    'X-Correlation-Id': context.correlationId,
  }
}
