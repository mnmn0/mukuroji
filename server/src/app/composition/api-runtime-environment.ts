import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES } from '@mukuroji/contracts'
import { TextDecoder } from 'node:util'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'

/** Re-exports the canonical API runtime configuration names for consumers. */
export { API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES } from '@mukuroji/contracts'

const API_RUNTIME_CONFIGURATION_HEADER =
  'mukuroji-api-runtime-configuration-v3\n'
const API_RUNTIME_CONFIGURATION_RECORD_PATTERN =
  /^(value|secret):([A-Z][A-Z0-9_]*):([A-Za-z0-9+/]*={0,2})$/
const API_RUNTIME_CONFIGURATION_REVISION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
const API_RUNTIME_CONFIGURATION_REVISION_RECORD_PATTERN =
  /^revision:([A-Za-z0-9+/]+={0,2})$/
const CANONICAL_STANDARD_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const FULL_SECRETS_MANAGER_ARN_PATTERN =
  /^arn:[a-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,519}$/

/** Environment variable naming the single API configuration secret. */
const API_RUNTIME_CONFIGURATION_SECRET_ARN_ENVIRONMENT_NAME =
  'MUKUROJI_API_RUNTIME_CONFIG_SECRET_ARN'
/** Environment variable naming the revision this API version expects. */
const API_RUNTIME_CONFIGURATION_REVISION_ENVIRONMENT_NAME =
  'MUKUROJI_API_RUNTIME_CONFIG_REVISION'

/** Names whose empty value disables an optional feature. */
const OPTIONAL_API_RUNTIME_VALUE_NAMES: ReadonlySet<string> = new Set([
  'COGNITO_SSO_CLIENT_ID',
  'COGNITO_HOSTED_UI_DOMAIN',
  'COGNITO_SSO_REDIRECT_URI',
  'COGNITO_ENTERPRISE_IDP_NAME',
  'ENTERPRISE_SSO_STATE_SECRET',
  'WEB_PUSH_VAPID_PUBLIC_KEY',
])

/** Secrets Manager staging label read while a rollout is in flight. */
type ApiRuntimeSecretVersionStage = 'AWSCURRENT' | 'AWSPREVIOUS'

/**
 * Loads exact secret strings for the supplied complete secret ARNs.
 *
 * @param secretArns - Complete secret ARNs in deterministic order.
 * @param versionStage - Staging label to read; `AWSCURRENT` when omitted.
 */
type ApiRuntimeSecretLoader = (
  secretArns: readonly string[],
  versionStage?: ApiRuntimeSecretVersionStage,
) => Promise<readonly string[]>

/** One parsed configuration envelope before it is applied. */
type ParsedApiRuntimeConfiguration = {
  readonly revision: string
  readonly values: ReadonlyMap<string, string>
  readonly nestedSecretNames: readonly string[]
  readonly nestedSecretArns: readonly string[]
}

/**
 * Loads and atomically restores the API's complete production configuration.
 *
 * Production configuration lives in one stable secret that a deploy updates
 * in place. Each published API version carries the revision it expects. The
 * loader reads the current secret version and, while a newer deploy has
 * already updated the secret but traffic has not moved yet, the previous
 * version. Any other revision fails closed.
 *
 * No configuration pointer is accepted only outside AWS Lambda or in the
 * explicitly marked and locally transported Floci emulator.
 *
 * @param environment - Mutable environment receiving validated configuration.
 * @param loadSecrets - Secret loader overridden by isolated unit tests.
 * @returns A promise resolved after configuration is validated and applied.
 */
export async function hydrateApiRuntimeEnvironment(
  environment: Record<string, string | undefined> = process.env,
  loadSecrets: ApiRuntimeSecretLoader = loadApiRuntimeSecrets,
): Promise<void> {
  const secretArn =
    environment[API_RUNTIME_CONFIGURATION_SECRET_ARN_ENVIRONMENT_NAME]
  const expectedRevision =
    environment[API_RUNTIME_CONFIGURATION_REVISION_ENVIRONMENT_NAME]
  if (secretArn === undefined && expectedRevision === undefined) {
    if (allowsDiscreteApiRuntimeEnvironment(environment)) return
    throw createInvalidApiRuntimeEnvironmentError()
  }
  if (
    typeof secretArn !== 'string' ||
    !isFullSecretsManagerArn(secretArn) ||
    typeof expectedRevision !== 'string' ||
    !API_RUNTIME_CONFIGURATION_REVISION_PATTERN.test(expectedRevision)
  ) {
    throw createInvalidApiRuntimeEnvironmentError()
  }
  const expectedNames = new Set(API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES)
  if (
    API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.some(
      (name) => environment[name] !== undefined,
    )
  ) {
    throw createInvalidApiRuntimeEnvironmentError()
  }

  // Select the version by revision before validating its records: a newer
  // deploy may add or remove canonical names this API version does not know.
  let secretString = await loadSingleSecret(loadSecrets, secretArn, 'AWSCURRENT')
  if (readApiRuntimeConfigurationRevision(secretString) !== expectedRevision) {
    secretString = await loadSingleSecret(loadSecrets, secretArn, 'AWSPREVIOUS')
    if (readApiRuntimeConfigurationRevision(secretString) !== expectedRevision) {
      throw createInvalidApiRuntimeEnvironmentError()
    }
  }
  const configuration = parseApiRuntimeConfiguration(secretString, expectedNames)

  const hydratedValues = new Map(configuration.values)
  const { nestedSecretArns, nestedSecretNames } = configuration
  if (nestedSecretArns.length > 0) {
    const nestedSecretStrings = await loadSecrets(nestedSecretArns)
    if (nestedSecretStrings.length !== nestedSecretArns.length) {
      throw createInvalidApiRuntimeEnvironmentError()
    }
    for (let index = 0; index < nestedSecretStrings.length; index += 1) {
      const name = nestedSecretNames[index]
      const secretString = nestedSecretStrings[index]
      if (
        name === undefined ||
        typeof secretString !== 'string' ||
        secretString.length === 0 ||
        secretString.includes('\0')
      ) {
        throw createInvalidApiRuntimeEnvironmentError()
      }
      hydratedValues.set(name, secretString)
    }
  }

  if (hydratedValues.size !== API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.length) {
    throw createInvalidApiRuntimeEnvironmentError()
  }
  for (const name of API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES) {
    const value = hydratedValues.get(name)
    if (value === undefined) {
      throw createInvalidApiRuntimeEnvironmentError()
    }
    environment[name] = value
  }
}

/**
 * Loads exactly one secret string at one staging label.
 *
 * @param loadSecrets - Secret loader.
 * @param secretArn - Complete configuration secret ARN.
 * @param versionStage - Staging label to read.
 * @returns The secret string.
 */
async function loadSingleSecret(
  loadSecrets: ApiRuntimeSecretLoader,
  secretArn: string,
  versionStage: ApiRuntimeSecretVersionStage,
): Promise<string> {
  const secretStrings = await loadSecrets([secretArn], versionStage)
  const secretString = secretStrings[0]
  if (secretStrings.length !== 1 || typeof secretString !== 'string') {
    throw createInvalidApiRuntimeEnvironmentError()
  }
  return secretString
}

/**
 * Splits one envelope into its validated revision and its record lines.
 *
 * @param secretString - Untrusted configuration secret string.
 * @returns The decoded revision and the remaining record lines.
 */
function splitApiRuntimeConfiguration(
  secretString: string,
): { readonly revision: string; readonly lines: readonly string[] } {
  if (
    typeof secretString !== 'string' ||
    !secretString.startsWith(API_RUNTIME_CONFIGURATION_HEADER) ||
    !secretString.endsWith('\n')
  ) {
    throw createInvalidApiRuntimeEnvironmentError()
  }

  const body = secretString.slice(
    API_RUNTIME_CONFIGURATION_HEADER.length,
    -1,
  )
  const lines = body.split('\n')
  const revisionRecord = lines.shift()
  const revisionMatch = revisionRecord === undefined
    ? undefined
    : API_RUNTIME_CONFIGURATION_REVISION_RECORD_PATTERN.exec(revisionRecord)
  const encodedRevision = revisionMatch?.[1]
  if (encodedRevision === undefined || lines.length === 0) {
    throw createInvalidApiRuntimeEnvironmentError()
  }
  const revision = decodeApiRuntimeConfigurationValue(encodedRevision)
  if (!API_RUNTIME_CONFIGURATION_REVISION_PATTERN.test(revision)) {
    throw createInvalidApiRuntimeEnvironmentError()
  }
  return { revision, lines }
}

/**
 * Reads only the revision of one envelope, without validating its records.
 *
 * @param secretString - Untrusted configuration secret string.
 * @returns The decoded revision.
 */
function readApiRuntimeConfigurationRevision(secretString: string): string {
  return splitApiRuntimeConfiguration(secretString).revision
}

/**
 * Parses one strict transform-free runtime-configuration envelope.
 *
 * @param secretString - Untrusted configuration secret string.
 * @param expectedNames - Exact canonical API environment-name set.
 * @returns The validated revision, direct values, and nested secret pointers.
 */
function parseApiRuntimeConfiguration(
  secretString: string,
  expectedNames: ReadonlySet<string>,
): ParsedApiRuntimeConfiguration {
  const { revision, lines } = splitApiRuntimeConfiguration(secretString)

  const configuredNames = new Set<string>()
  const values = new Map<string, string>()
  const nestedSecretNames: string[] = []
  const nestedSecretArns: string[] = []
  for (const line of lines) {
    const match = API_RUNTIME_CONFIGURATION_RECORD_PATTERN.exec(line)
    const kind = match?.[1]
    const name = match?.[2]
    const encodedValue = match?.[3]
    if (
      (kind !== 'value' && kind !== 'secret') ||
      name === undefined ||
      encodedValue === undefined ||
      !expectedNames.has(name) ||
      configuredNames.has(name)
    ) {
      throw createInvalidApiRuntimeEnvironmentError()
    }

    // Optional features are disabled by an empty value, which CloudFormation encodes as ''.
    const optionalValue =
      kind === 'value' && OPTIONAL_API_RUNTIME_VALUE_NAMES.has(name)
    const decodedValue = optionalValue && encodedValue === ''
      ? ''
      : decodeApiRuntimeConfigurationValue(encodedValue)
    configuredNames.add(name)
    if (kind === 'value') {
      values.set(name, decodedValue)
      continue
    }
    if (!isFullSecretsManagerArn(decodedValue)) {
      throw createInvalidApiRuntimeEnvironmentError()
    }
    nestedSecretNames.push(name)
    nestedSecretArns.push(decodedValue)
  }

  if (
    configuredNames.size !== expectedNames.size ||
    new Set(nestedSecretArns).size !== nestedSecretArns.length
  ) {
    throw createInvalidApiRuntimeEnvironmentError()
  }
  return { revision, values, nestedSecretNames, nestedSecretArns }
}

/**
 * Restricts pointer-free discrete configuration to local execution.
 *
 * @param environment - Candidate process environment.
 * @returns Whether production configuration secrets are not required.
 */
function allowsDiscreteApiRuntimeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const hasLambdaExecutionMarker = Boolean(
    environment.AWS_EXECUTION_ENV?.trim(),
  )
  const hasLambdaFunctionMarker = Boolean(
    environment.AWS_LAMBDA_FUNCTION_NAME?.trim(),
  )
  if (!hasLambdaExecutionMarker && !hasLambdaFunctionMarker) return true

  return hasLambdaExecutionMarker &&
    hasLambdaFunctionMarker &&
    environment.NODE_ENV !== 'production' &&
    environment.MUKUROJI_LOCAL_AWS_RUNTIME === 'floci' &&
    isExplicitLocalHttpEndpoint(environment.DYNAMODB_ENDPOINT) &&
    isExplicitLocalHttpEndpoint(environment.SECRETS_MANAGER_ENDPOINT)
}

/**
 * Validates an explicit root-only HTTP endpoint for a supported local runtime.
 *
 * @param value - Candidate endpoint URL.
 * @returns Whether the URL is an exact local emulator endpoint.
 */
function isExplicitLocalHttpEndpoint(value: string | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false

  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return false
  }

  return endpoint.protocol === 'http:' &&
    !endpoint.username &&
    !endpoint.password &&
    endpoint.pathname === '/' &&
    !endpoint.search &&
    !endpoint.hash &&
    [
      'localhost',
      '127.0.0.1',
      '[::1]',
      'floci',
      'localstack',
    ].includes(endpoint.hostname)
}

/**
 * Decodes an exact canonical standard-base64 non-empty UTF-8 value.
 *
 * @param value - Untrusted encoded configuration value.
 * @returns The validated decoded configuration value.
 */
function decodeApiRuntimeConfigurationValue(value: string): string {
  if (
    value.length === 0 ||
    !CANONICAL_STANDARD_BASE64_PATTERN.test(value)
  ) {
    throw createInvalidApiRuntimeEnvironmentError()
  }

  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw createInvalidApiRuntimeEnvironmentError()
  }

  let decodedValue: string
  try {
    decodedValue = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes)
  } catch {
    throw createInvalidApiRuntimeEnvironmentError()
  }

  if (
    decodedValue.length === 0 ||
    decodedValue.includes('\0') ||
    !Buffer.from(decodedValue, 'utf8').equals(bytes)
  ) {
    throw createInvalidApiRuntimeEnvironmentError()
  }
  return decodedValue
}

/**
 * Validates a complete Secrets Manager secret ARN.
 *
 * @param value - Candidate ARN.
 * @returns Whether the value is a complete Secrets Manager ARN.
 */
function isFullSecretsManagerArn(value: string): boolean {
  return FULL_SECRETS_MANAGER_ARN_PATTERN.test(value)
}

/**
 * Loads plaintext configuration groups only for the atomic cold-start
 * hydration boundary and destroys the shared Secrets Manager client before
 * returning. This helper neither logs nor persists the secret strings.
 *
 * @param secretArns - Complete secret ARNs in deterministic record order.
 * @param versionStage - Staging label to read; `AWSCURRENT` by default.
 * @returns Exact UTF-8 secret strings in the same order.
 * @throws A `TypeError` when a response omits its string secret value, or the
 * original Secrets Manager error when a requested secret cannot be retrieved.
 */
async function loadApiRuntimeSecrets(
  secretArns: readonly string[],
  versionStage: ApiRuntimeSecretVersionStage = 'AWSCURRENT',
): Promise<readonly string[]> {
  const client = createSecretsManagerClient()
  try {
    const responses = await Promise.all(
      secretArns.map(async (secretArn) =>
        await client.send(new GetSecretValueCommand({
          SecretId: secretArn,
          VersionStage: versionStage,
        }))
      ),
    )
    return responses.map((response) => {
      if (typeof response.SecretString !== 'string') {
        throw createInvalidApiRuntimeEnvironmentError()
      }
      return response.SecretString
    })
  } finally {
    client.destroy()
  }
}

/**
 * Creates the stable raw-value-free configuration error.
 *
 * @returns A configuration error safe to expose in cold-start logs.
 */
function createInvalidApiRuntimeEnvironmentError(): TypeError {
  return new TypeError('API runtime environment configuration is invalid.')
}
