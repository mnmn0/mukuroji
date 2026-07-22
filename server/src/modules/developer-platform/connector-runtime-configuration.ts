/** Secrets Manager から読む connector runtime 設定の最大 byte 数です。 */
const MAX_CONNECTOR_CONFIGURATION_BYTES = 64 * 1024

/** Connector runtime 成功値を再取得する既定 TTL です。 */
const DEFAULT_CONNECTOR_RUNTIME_CACHE_TTL_MS = 60_000

/** Connector runtime load failure 後の既定初回 backoff です。 */
const DEFAULT_CONNECTOR_RUNTIME_RETRY_INITIAL_MS = 250

/** Connector runtime load failure 後の既定最大 backoff です。 */
const DEFAULT_CONNECTOR_RUNTIME_RETRY_MAX_MS = 5_000

/** Connector runtime 設定を格納する Secrets Manager secret ARN の環境変数です。 */
export const CONNECTOR_CONFIGURATION_SECRET_ARN_ENVIRONMENT_VARIABLE =
  'CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN'

/** Connector runtime secret の読み出し境界です。 */
export interface ConnectorRuntimeSecretLoader {
  /** Secret ID に対応する UTF-8 JSON を返します。 */
  readSecret(secretId: string): Promise<string>
}

/** Connector runtime 設定が不正または取得不能な場合の fail-closed error です。 */
export class ConnectorRuntimeConfigurationError extends Error {
  /** 安定した machine-readable error code です。 */
  readonly code: string

  /** Secret を含まない安全な message で error を作成します。 */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConnectorRuntimeConfigurationError'
    this.code = code
  }
}

/** Connector runtime の成功値と一時障害を管理する cache options です。 */
export type ConnectorRuntimeCacheOptions<TValue> = {
  /** Secrets Manager load と runtime 構築を行う callback です。 */
  load: () => Promise<TValue>
  /** 成功値を再取得するまでの TTL です。 */
  ttlMs?: number
  /** 一時障害後の初回 retry backoff です。 */
  retryInitialMs?: number
  /** 一時障害後の最大 retry backoff です。 */
  retryMaxMs?: number
  /** TTL と backoff 判定に使う monotonic clock です。 */
  clock?: () => number
}

/** Warm runtime で利用する connector runtime cache です。 */
export type ConnectorRuntimeCache<TValue> = {
  /** TTL 内の成功値を返し、失効後または backoff 後に再取得します。 */
  get: () => Promise<TValue>
  /** 成功値、失敗状態、実行中 load を明示的に破棄します。 */
  clear: () => void
}

/**
 * Rejected Promise を保持せず、成功 TTL と bounded exponential backoff を持つ cache を作成します。
 *
 * @param options load、TTL、backoff、clock の設定です。
 * @returns Warm Lambda invocation 間で共有できる connector runtime cache です。
 */
export function createConnectorRuntimeCache<TValue>(
  options: ConnectorRuntimeCacheOptions<TValue>,
): ConnectorRuntimeCache<TValue> {
  const ttlMs = readPositiveDuration(
    options.ttlMs,
    DEFAULT_CONNECTOR_RUNTIME_CACHE_TTL_MS,
    'Connector runtime cache TTL',
  )
  const retryInitialMs = readPositiveDuration(
    options.retryInitialMs,
    DEFAULT_CONNECTOR_RUNTIME_RETRY_INITIAL_MS,
    'Connector runtime retry initial delay',
  )
  const retryMaxMs = readPositiveDuration(
    options.retryMaxMs,
    DEFAULT_CONNECTOR_RUNTIME_RETRY_MAX_MS,
    'Connector runtime retry maximum delay',
  )
  if (retryMaxMs < retryInitialMs) {
    throw new TypeError(
      'Connector runtime retry maximum delay must be greater than or equal to the initial delay.',
    )
  }
  const clock = options.clock ?? Date.now
  let cachedValue: TValue | undefined
  let hasCachedValue = false
  let expiresAt = 0
  let inFlight: Promise<TValue> | undefined
  let failure: unknown
  let hasFailure = false
  let failureCount = 0
  let retryAt = 0

  const clear = () => {
    cachedValue = undefined
    hasCachedValue = false
    expiresAt = 0
    inFlight = undefined
    failure = undefined
    hasFailure = false
    failureCount = 0
    retryAt = 0
  }

  return {
    clear,
    get() {
      const now = clock()
      if (hasCachedValue && now < expiresAt) {
        return Promise.resolve(cachedValue as TValue)
      }
      if (inFlight) return inFlight
      if (hasFailure && now < retryAt) {
        return Promise.reject(failure)
      }

      const load = Promise.resolve()
        .then(options.load)
        .then(
          (value) => {
            if (inFlight === load) {
              cachedValue = value
              hasCachedValue = true
              expiresAt = clock() + ttlMs
              inFlight = undefined
              failure = undefined
              hasFailure = false
              failureCount = 0
              retryAt = 0
            }
            return value
          },
          (error: unknown) => {
            if (inFlight === load) {
              const exponent = Math.min(failureCount, 20)
              const delay = Math.min(
                retryMaxMs,
                retryInitialMs * (2 ** exponent),
              )
              cachedValue = undefined
              hasCachedValue = false
              expiresAt = 0
              inFlight = undefined
              failure = error
              hasFailure = true
              failureCount += 1
              retryAt = clock() + delay
            }
            throw error
          },
        )
      inFlight = load
      return load
    },
  }
}

/**
 * Secrets Manager-backed 設定を base environment へ一時的に重ねます。
 * 返却 object だけを runtime 構築に渡し、process.env 自体は変更しません。
 */
export async function loadConnectorRuntimeEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  loader?: ConnectorRuntimeSecretLoader,
): Promise<NodeJS.ProcessEnv> {
  const secretId = baseEnvironment[
    CONNECTOR_CONFIGURATION_SECRET_ARN_ENVIRONMENT_VARIABLE
  ]?.trim()
  if (!secretId) return { ...baseEnvironment }
  if (Buffer.byteLength(secretId, 'utf8') > 2_048) {
    throw configurationInvalid('Connector runtime secret ID is invalid.')
  }
  if (!loader) {
    throw new ConnectorRuntimeConfigurationError(
      'ConnectorConfigurationUnavailable',
      'Connector runtime configuration loader is unavailable.',
    )
  }
  let secret: string
  try {
    secret = await loader.readSecret(secretId)
  } catch (error) {
    if (error instanceof ConnectorRuntimeConfigurationError) throw error
    throw new ConnectorRuntimeConfigurationError(
      'ConnectorConfigurationUnavailable',
      'Connector runtime configuration could not be loaded.',
    )
  }
  if (Buffer.byteLength(secret, 'utf8') > MAX_CONNECTOR_CONFIGURATION_BYTES) {
    throw configurationInvalid('Connector runtime configuration is too large.')
  }
  const configuration = parseConnectorRuntimeSecret(secret)
  return { ...baseEnvironment, ...configuration }
}

/** Secrets Manager JSON を許可済み environment key/value だけへ正規化します。 */
export function parseConnectorRuntimeSecret(
  secret: string,
): Readonly<Record<string, string>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(secret) as unknown
  } catch {
    throw configurationInvalid('Connector runtime configuration must be valid JSON.')
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw configurationInvalid('Connector runtime configuration must be a JSON object.')
  }
  const configuration: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!isAllowedConnectorEnvironmentKey(key) || typeof value !== 'string') {
      throw configurationInvalid('Connector runtime configuration contains an invalid field.')
    }
    if (Buffer.byteLength(value, 'utf8') > 32 * 1024) {
      throw configurationInvalid('Connector runtime configuration contains an oversized field.')
    }
    configuration[key] = value
  }
  return configuration
}

function isAllowedConnectorEnvironmentKey(value: string) {
  return value === 'MUKUROJI_CONNECTOR_PROVIDERS_JSON' ||
    value === 'CONNECTOR_OAUTH_STATE_SIGNING_SECRET' ||
    value === 'CONNECTOR_OAUTH_STATE_PREVIOUS_SIGNING_SECRETS_JSON' ||
    value === 'CONNECTOR_SYNC_ORIGIN_SIGNING_SECRET' ||
    value === 'CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON' ||
    value === 'CONNECTOR_SYNC_CURSOR_SIGNING_SECRET' ||
    value === 'CONNECTOR_SYNC_CURSOR_PREVIOUS_SIGNING_SECRETS_JSON' ||
    value === 'CONNECTOR_REAUTHORIZATION_RETURN_URL' ||
    /^MUKUROJI_CONNECTOR_[A-Z0-9_]{1,96}$/.test(value)
}

function readPositiveDuration(
  value: number | undefined,
  fallback: number,
  label: string,
) {
  const duration = value ?? fallback
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new TypeError(`${label} must be a positive integer.`)
  }
  return duration
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function configurationInvalid(message: string) {
  return new ConnectorRuntimeConfigurationError(
    'ConnectorConfigurationInvalid',
    message,
  )
}
