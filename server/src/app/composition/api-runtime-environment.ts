import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES } from '@mukuroji/contracts'
import { TextDecoder } from 'node:util'
import { createSecretsManagerClient } from '../../infrastructure/aws/secrets-manager-client'

/** Re-exports the canonical API runtime configuration names for consumers. */
export { API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES } from '@mukuroji/contracts'

const API_RUNTIME_CONFIGURATION_HEADER =
  'mukuroji-api-runtime-configuration-v2\n'
const API_RUNTIME_CONFIGURATION_RECORD_PATTERN =
  /^(value|secret):([A-Z][A-Z0-9_]*):([A-Za-z0-9+/]+={0,2})$/
const API_RUNTIME_CONFIGURATION_REVISION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
const API_RUNTIME_CONFIGURATION_REVISION_RECORD_PATTERN =
  /^revision:([A-Za-z0-9+/]+={0,2})$/
const CANONICAL_STANDARD_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const FULL_SECRETS_MANAGER_ARN_PATTERN =
  /^arn:[a-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,519}$/

const API_RUNTIME_CONFIGURATION_SECRET_ENVIRONMENT_NAMES = Object.freeze([
  'MUKUROJI_API_CORE_CONFIG_SECRET_ARN',
  'MUKUROJI_API_DATA_CONFIG_SECRET_ARN',
  'MUKUROJI_API_IDENTITY_CONFIG_SECRET_ARN',
  'MUKUROJI_API_WORKFLOW_CONFIG_SECRET_ARN',
])
const API_RUNTIME_CONFIGURATION_GROUP_NAMES = Object.freeze([
  'core',
  'data',
  'identity',
  'workflow',
])

/** Loads exact secret strings for the supplied complete secret ARNs. */
type ApiRuntimeSecretLoader = (
  secretArns: readonly string[],
) => Promise<readonly string[]>

/**
 * Loads and atomically restores the API's complete production configuration.
 *
 * No configuration-secret pointers is accepted only outside AWS Lambda or in
 * the explicitly marked and locally transported Floci emulator. A production
 * Lambda must supply four distinct group secrets, every canonical value once,
 * and no competing discrete values.
 *
 * @param environment - Mutable environment receiving validated configuration.
 * @param loadSecrets - Secret loader overridden by isolated unit tests.
 * @returns A promise resolved after configuration is validated and applied.
 */
export async function hydrateApiRuntimeEnvironment(
  environment: Record<string, string | undefined> = process.env,
  loadSecrets: ApiRuntimeSecretLoader = loadApiRuntimeSecrets,
): Promise<void> {
  const configuredPointerCount =
    API_RUNTIME_CONFIGURATION_SECRET_ENVIRONMENT_NAMES.filter(
      (name) => environment[name] !== undefined,
    ).length
  if (configuredPointerCount === 0) {
    if (allowsDiscreteApiRuntimeEnvironment(environment)) return
    throw createInvalidApiRuntimeEnvironmentError()
  }
  if (
    configuredPointerCount !==
      API_RUNTIME_CONFIGURATION_SECRET_ENVIRONMENT_NAMES.length
  ) {
    throw createInvalidApiRuntimeEnvironmentError()
  }

  const groupSecretArns: string[] = []
  for (const name of API_RUNTIME_CONFIGURATION_SECRET_ENVIRONMENT_NAMES) {
    const secretArn = environment[name]
    if (
      typeof secretArn !== 'string' ||
      !isFullSecretsManagerArn(secretArn)
    ) {
      throw createInvalidApiRuntimeEnvironmentError()
    }
    groupSecretArns.push(secretArn)
  }
  if (new Set(groupSecretArns).size !== groupSecretArns.length) {
    throw createInvalidApiRuntimeEnvironmentError()
  }

  const groupSecretStrings = await loadSecrets(groupSecretArns)
  if (groupSecretStrings.length !== groupSecretArns.length) {
    throw createInvalidApiRuntimeEnvironmentError()
  }

  const expectedNames = new Set(API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES)
  const configuredNames = new Set<string>()
  const hydratedValues = new Map<string, string>()
  const nestedSecretNames: string[] = []
  const nestedSecretArns: string[] = []
  let configurationRevision: string | undefined
  for (let index = 0; index < groupSecretStrings.length; index += 1) {
    const groupSecretString = groupSecretStrings[index]
    const groupName = API_RUNTIME_CONFIGURATION_GROUP_NAMES[index]
    if (groupSecretString === undefined || groupName === undefined) {
      throw createInvalidApiRuntimeEnvironmentError()
    }
    const groupRevision = parseApiRuntimeConfigurationGroup(
      groupSecretString,
      groupName,
      expectedNames,
      configuredNames,
      hydratedValues,
      nestedSecretNames,
      nestedSecretArns,
    )
    if (configurationRevision === undefined) {
      configurationRevision = groupRevision
    } else if (configurationRevision !== groupRevision) {
      throw createInvalidApiRuntimeEnvironmentError()
    }
  }

  if (
    configuredNames.size !== API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.length ||
    new Set(nestedSecretArns).size !== nestedSecretArns.length ||
    API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.some(
      (name) => !configuredNames.has(name) || environment[name] !== undefined,
    )
  ) {
    throw createInvalidApiRuntimeEnvironmentError()
  }

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
 * Parses one strict transform-free runtime-configuration envelope.
 *
 * @param secretString - Untrusted configuration group secret string.
 * @param expectedGroup - Exact group identity selected by the pointer name.
 * @param expectedNames - Exact canonical API environment-name set.
 * @param configuredNames - Names already claimed across preceding groups.
 * @param hydratedValues - Direct values validated before atomic publication.
 * @param nestedSecretNames - Secret-backed names in deterministic record order.
 * @param nestedSecretArns - Secret-backed ARNs in deterministic record order.
 * @returns The exact validated configuration revision.
 */
function parseApiRuntimeConfigurationGroup(
  secretString: string,
  expectedGroup: string,
  expectedNames: ReadonlySet<string>,
  configuredNames: Set<string>,
  hydratedValues: Map<string, string>,
  nestedSecretNames: string[],
  nestedSecretArns: string[],
): string {
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
  const groupRecord = lines.shift()
  const revisionRecord = lines.shift()
  const revisionMatch = revisionRecord === undefined
    ? undefined
    : API_RUNTIME_CONFIGURATION_REVISION_RECORD_PATTERN.exec(revisionRecord)
  const encodedRevision = revisionMatch?.[1]
  if (
    groupRecord !== `group:${expectedGroup}` ||
    encodedRevision === undefined ||
    lines.length === 0
  ) {
    throw createInvalidApiRuntimeEnvironmentError()
  }
  const configurationRevision =
    decodeApiRuntimeConfigurationValue(encodedRevision)
  if (!API_RUNTIME_CONFIGURATION_REVISION_PATTERN.test(
    configurationRevision,
  )) {
    throw createInvalidApiRuntimeEnvironmentError()
  }

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

    const decodedValue = decodeApiRuntimeConfigurationValue(encodedValue)
    configuredNames.add(name)
    if (kind === 'value') {
      hydratedValues.set(name, decodedValue)
      continue
    }
    if (!isFullSecretsManagerArn(decodedValue)) {
      throw createInvalidApiRuntimeEnvironmentError()
    }
    nestedSecretNames.push(name)
    nestedSecretArns.push(decodedValue)
  }
  return configurationRevision
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
 * @param secretArns - Complete secret ARNs in deterministic group or record order.
 * @returns Exact UTF-8 secret strings in the same order.
 * @throws A `TypeError` when a response omits its string secret value, or the
 * original Secrets Manager error when a requested secret cannot be retrieved.
 */
async function loadApiRuntimeSecrets(
  secretArns: readonly string[],
): Promise<readonly string[]> {
  const client = createSecretsManagerClient()
  try {
    const responses = await Promise.all(
      secretArns.map(async (secretArn) =>
        await client.send(new GetSecretValueCommand({ SecretId: secretArn }))
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
