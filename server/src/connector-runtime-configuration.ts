/** Secrets Manager から読む connector runtime 設定の最大 byte 数です。 */
const MAX_CONNECTOR_CONFIGURATION_BYTES = 64 * 1024

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

/**
 * Secrets Manager-backed 設定を base environment へ一時的に重ねます。
 * 返却 object だけを runtime 構築に渡し、process.env 自体は変更しません。
 */
export async function loadConnectorRuntimeEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  loader: ConnectorRuntimeSecretLoader = createAwsSecretsManagerLoader(),
): Promise<NodeJS.ProcessEnv> {
  const secretId = baseEnvironment[
    CONNECTOR_CONFIGURATION_SECRET_ARN_ENVIRONMENT_VARIABLE
  ]?.trim()
  if (!secretId) return { ...baseEnvironment }
  if (Buffer.byteLength(secretId, 'utf8') > 2_048) {
    throw configurationInvalid('Connector runtime secret ID is invalid.')
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

/** Lambda runtime 同梱の AWS SDK v3 を遅延利用する secret loader を作成します。 */
function createAwsSecretsManagerLoader(): ConnectorRuntimeSecretLoader {
  return {
    async readSecret(secretId) {
      try {
        const packageName = ['@aws-sdk', 'client-secrets-manager'].join('/')
        const sdk = await import(packageName) as Record<string, unknown>
        const Client = requireConstructor(
          sdk.SecretsManagerClient,
          'SecretsManagerClient',
        )
        const Command = requireConstructor(
          sdk.GetSecretValueCommand,
          'GetSecretValueCommand',
        )
        const client = Reflect.construct(Client, []) as Record<string, unknown>
        const send = client.send
        if (typeof send !== 'function') {
          throw new TypeError('Secrets Manager client is unavailable.')
        }
        const response = await Reflect.apply(send, client, [
          Reflect.construct(Command, [{ SecretId: secretId }]),
        ]) as unknown
        if (!isRecord(response)) {
          throw new TypeError('Secrets Manager response is invalid.')
        }
        if (typeof response.SecretString === 'string') return response.SecretString
        if (response.SecretBinary instanceof Uint8Array) {
          return Buffer.from(response.SecretBinary).toString('utf8')
        }
        throw new TypeError('Secrets Manager secret has no value.')
      } catch (error) {
        if (error instanceof ConnectorRuntimeConfigurationError) throw error
        throw new ConnectorRuntimeConfigurationError(
          'ConnectorConfigurationUnavailable',
          'Connector runtime configuration could not be loaded.',
        )
      }
    },
  }
}

function requireConstructor(value: unknown, name: string): Function {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} is unavailable.`)
  }
  return value
}

function isAllowedConnectorEnvironmentKey(value: string) {
  return value === 'MUKUROJI_CONNECTOR_PROVIDERS_JSON' ||
    value === 'CONNECTOR_OAUTH_STATE_SIGNING_SECRET' ||
    value === 'CONNECTOR_SYNC_ORIGIN_SIGNING_SECRET' ||
    value === 'CONNECTOR_REAUTHORIZATION_RETURN_URL' ||
    /^MUKUROJI_CONNECTOR_[A-Z0-9_]{1,96}$/.test(value)
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
