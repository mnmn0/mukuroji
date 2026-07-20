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
 * 分類された transport failure の request context を retry まで保持する runner です。
 */
export type MutationRequestRunner = {
  /**
   * State 再取得後に、実行中ではない retry 待ち context を破棄します。
   */
  readonly discardRetainedContexts: () => void
  /**
   * 同じ operation key と fingerprint の実行中 request と保持対象の再実行を共有します。
   */
  readonly run: <TResult>(
    operationKey: string,
    fingerprint: string,
    request: (context: MutationRequestContext) => Promise<TResult>,
    shouldRetainContext?: (error: unknown) => boolean,
  ) => Promise<TResult>
}

/**
 * retry 待ちの logical mutation を表す内部 entry です。
 */
type PendingMutationRequest = {
  /**
   * mutation の入力を識別する fingerprint です。
   */
  readonly fingerprint: string
  /**
   * 初回 request と retry で共有する context です。
   */
  readonly context: MutationRequestContext
  /**
   * 同じ logical mutation の多重送信を1本にまとめる実行中 Promise です。
   */
  inFlight?: Promise<unknown>
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
 * Secret を runner の保持 map に残さず、入力変更を識別する one-way fingerprint を作成します。
 *
 * @param parts logical mutation を構成する入力です。
 * @returns 入力境界を含めて SHA-256 した16進 digest です。
 */
export async function createMutationFingerprint(...parts: readonly string[]) {
  const payload = new TextEncoder().encode(JSON.stringify(parts))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', payload)

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 分類した mutation failure の context を保持し、同じ入力の retry へ引き継ぐ runner を作成します。
 *
 * 同じ operation key と fingerprint の request が実行中の場合はその Promise を共有し、
 * HTTP callback を重複実行しません。
 *
 * 成功した mutation と caller が保持対象外とした error の context は破棄します。operation key
 * が同じでも fingerprint が変わった場合は別の logical mutation として新しい context を発行します。
 *
 * @param createContext request context を発行する factory です。
 * @returns logical mutation 単位で request context を管理する runner です。
 */
export function createMutationRequestRunner(
  createContext: () => MutationRequestContext = createMutationRequestContext,
): MutationRequestRunner {
  const pendingRequests = new Map<string, PendingMutationRequest>()

  return {
    discardRetainedContexts: () => {
      for (const [operationKey, pendingRequest] of pendingRequests) {
        if (pendingRequest.inFlight === undefined) {
          pendingRequests.delete(operationKey)
        }
      }
    },
    run: <TResult>(
      operationKey: string,
      fingerprint: string,
      request: (context: MutationRequestContext) => Promise<TResult>,
      shouldRetainContext: (error: unknown) => boolean = () => true,
    ) => {
      const pendingRequest = pendingRequests.get(operationKey)
      const retryRequest = pendingRequest?.fingerprint === fingerprint

      if (retryRequest && pendingRequest.inFlight) {
        return pendingRequest.inFlight as Promise<TResult>
      }

      const requestEntry = retryRequest
        ? pendingRequest
        : {
            context: createContext(),
            fingerprint,
          }
      const inFlight = Promise.resolve()
        .then(() => request(requestEntry.context))
        .then(
          (result) => {
            if (pendingRequests.get(operationKey)?.inFlight === inFlight) {
              pendingRequests.delete(operationKey)
            }

            return result
          },
          (error: unknown) => {
            const currentRequest = pendingRequests.get(operationKey)

            if (currentRequest?.inFlight === inFlight) {
              if (shouldRetainContext(error)) {
                currentRequest.inFlight = undefined
              } else {
                pendingRequests.delete(operationKey)
              }
            }

            throw error
          },
        )

      requestEntry.inFlight = inFlight
      pendingRequests.set(operationKey, requestEntry)

      return inFlight
    },
  }
}

/**
 * Business mutation request の再送制御と追跡に使う header を生成します。
 *
 * @param context logical mutation の初回 request と retry で共有する context です。
 * @returns idempotency key と correlation ID を含む HTTP headers です。
 */
export function createMutationHeaders(
  context: MutationRequestContext,
) {
  return {
    'Idempotency-Key': context.idempotencyKey,
    'X-Correlation-Id': context.correlationId,
  }
}
