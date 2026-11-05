import { expect, test } from 'bun:test'
import {
  API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES,
  hydrateApiRuntimeEnvironment,
} from './api-runtime-environment'

const configurationHeader = 'mukuroji-api-runtime-configuration-v3\n'
const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:api-config'
const configurationRevision = 'revision-7'
const configuredValuePrefix = '設定済み-configured-'
const invalidMessage = 'API runtime environment configuration is invalid.'

/**
 * Encodes one test value as canonical standard Base64.
 *
 * @param value - UTF-8 value to encode.
 * @returns Canonical standard Base64.
 */
function encodeConfigurationValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

/**
 * Creates one complete v3 configuration envelope.
 *
 * @param secretBackedNames - Canonical names represented by nested secret ARNs.
 * @param revision - Revision written into the envelope.
 * @returns The secret string, deterministic nested loads, and expected values.
 */
function createValidConfiguration(
  secretBackedNames: ReadonlySet<string> = new Set(),
  revision: string = configurationRevision,
) {
  const records: string[] = []
  const nestedSecretArns: string[] = []
  const expectedValues = new Map<string, string>()
  const nestedValues = new Map<string, string>()

  API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.forEach((name, index) => {
    const configuredValue = `${configuredValuePrefix}${name}`
    expectedValues.set(name, configuredValue)
    if (secretBackedNames.has(name)) {
      const nestedArn =
        `arn:aws:secretsmanager:us-east-1:123456789012:secret:nested-${index}`
      records.push(`secret:${name}:${encodeConfigurationValue(nestedArn)}`)
      nestedSecretArns.push(nestedArn)
      nestedValues.set(nestedArn, configuredValue)
      return
    }
    records.push(`value:${name}:${encodeConfigurationValue(configuredValue)}`)
  })

  return {
    expectedValues,
    nestedSecretArns,
    nestedValues,
    secretString: [
      `${configurationHeader}revision:${encodeConfigurationValue(revision)}`,
      ...records,
      '',
    ].join('\n'),
  }
}

/**
 * Creates a production-like environment containing only the configuration pointer.
 *
 * @returns Mutable environment used by hydrator tests.
 */
function createPointerEnvironment(): Record<string, string | undefined> {
  return {
    MUKUROJI_API_RUNTIME_CONFIG_REVISION: configurationRevision,
    MUKUROJI_API_RUNTIME_CONFIG_SECRET_ARN: secretArn,
  }
}

/**
 * Replaces the exact record for one canonical name.
 *
 * @param secretString - Complete configuration secret string.
 * @param name - Canonical record name to replace.
 * @param replacement - Complete replacement line, or an empty string to remove it.
 * @returns Updated secret string.
 */
function replaceConfigurationRecord(
  secretString: string,
  name: string,
  replacement: string,
): string {
  let replaced = false
  const lines = secretString.slice(0, -1).split('\n').flatMap((line) => {
    if (line.startsWith(`value:${name}:`) || line.startsWith(`secret:${name}:`)) {
      replaced = true
      return replacement.length > 0 ? [replacement] : []
    }
    return [line]
  })
  if (!replaced) {
    throw new Error(`Test configuration record ${name} was not found.`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Expects one configuration to be rejected without touching the environment.
 *
 * @param secretString - Configuration secret string returned for every read.
 */
async function expectRejectedConfiguration(secretString: string): Promise<void> {
  const environment = createPointerEnvironment()
  const originalEnvironment = { ...environment }
  await expect(hydrateApiRuntimeEnvironment(
    environment,
    async () => [secretString],
  )).rejects.toThrow(invalidMessage)
  expect(environment).toEqual(originalEnvironment)
}

test('loads direct and nested API configuration in deterministic order', async () => {
  const secretBackedNames = new Set(
    API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.slice(0, 8),
  )
  const configuration = createValidConfiguration(secretBackedNames)
  const environment = createPointerEnvironment()
  const requests: unknown[] = []

  await hydrateApiRuntimeEnvironment(environment, async (requestedArns, stage) => {
    requests.push([requestedArns, stage])
    if (requests.length === 1) return [configuration.secretString]
    return requestedArns.map((nestedArn) => {
      const value = configuration.nestedValues.get(nestedArn)
      if (value === undefined) {
        throw new Error('Unexpected nested test secret ARN.')
      }
      return value
    })
  })

  expect(requests).toEqual([
    [[secretArn], 'AWSCURRENT'],
    [configuration.nestedSecretArns, undefined],
  ])
  for (const name of API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES) {
    expect(environment[name]).toBe(configuration.expectedValues.get(name))
  }
})

test('allows omitted SSO values in a complete runtime envelope', async () => {
  const configuration = createValidConfiguration()
  const optionalNames = [
    'COGNITO_SSO_CLIENT_ID',
    'COGNITO_HOSTED_UI_DOMAIN',
    'COGNITO_SSO_REDIRECT_URI',
    'COGNITO_ENTERPRISE_IDP_NAME',
    'ENTERPRISE_SSO_STATE_SECRET',
  ]
  let secretString = configuration.secretString
  for (const name of optionalNames) {
    secretString = replaceConfigurationRecord(secretString, name, `value:${name}:`)
  }
  const environment = createPointerEnvironment()
  await hydrateApiRuntimeEnvironment(environment, async () => [secretString])
  for (const name of optionalNames) expect(environment[name]).toBe('')
  expect(environment.COGNITO_CLIENT_ID).toBe(configuration.expectedValues.get('COGNITO_CLIENT_ID'))

  await expectRejectedConfiguration(
    replaceConfigurationRecord(secretString, 'COGNITO_CLIENT_ID', 'value:COGNITO_CLIENT_ID:'),
  )
})

test('loads a direct-only envelope with a single secret request', async () => {
  const configuration = createValidConfiguration()
  const environment = createPointerEnvironment()
  let loadCount = 0

  await hydrateApiRuntimeEnvironment(environment, async (requestedArns, stage) => {
    loadCount += 1
    expect(requestedArns).toEqual([secretArn])
    expect(stage).toBe('AWSCURRENT')
    return [configuration.secretString]
  })

  expect(loadCount).toBe(1)
  for (const name of API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES) {
    expect(environment[name]).toBe(configuration.expectedValues.get(name))
  }
})

test('reads the previous secret version while a newer deploy is rolling out', async () => {
  const newer = createValidConfiguration(new Set(), 'revision-8')
  const expected = createValidConfiguration()
  const environment = createPointerEnvironment()
  const stages: unknown[] = []

  await hydrateApiRuntimeEnvironment(environment, async (_requestedArns, stage) => {
    stages.push(stage)
    return [stage === 'AWSPREVIOUS' ? expected.secretString : newer.secretString]
  })

  expect(stages).toEqual(['AWSCURRENT', 'AWSPREVIOUS'])
  for (const name of API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES) {
    expect(environment[name]).toBe(expected.expectedValues.get(name))
  }
})

test('rejects a configuration whose current and previous revisions both differ', async () => {
  const newer = createValidConfiguration(new Set(), 'revision-8')
  const older = createValidConfiguration(new Set(), 'revision-6')
  const environment = createPointerEnvironment()
  const originalEnvironment = { ...environment }

  await expect(hydrateApiRuntimeEnvironment(
    environment,
    async (_requestedArns, stage) => [
      stage === 'AWSPREVIOUS' ? older.secretString : newer.secretString,
    ],
  )).rejects.toThrow(invalidMessage)
  expect(environment).toEqual(originalEnvironment)
})

test('rejects malformed v3 envelopes and line types atomically', async () => {
  const { secretString } = createValidConfiguration()
  const malformedSecretStrings = [
    secretString.replace(configurationHeader, 'mukuroji-api-runtime-configuration-v2\n'),
    secretString.replace(configurationHeader, `${configurationHeader}group:core\n`),
    JSON.stringify({ schemaVersion: '1' }),
    secretString.slice(0, -1),
    `${secretString}\n`,
    configurationHeader,
    secretString.replace('\nvalue:', '\npointer:'),
    secretString.replace('\nvalue:', '\nvalue:UNKNOWN_CONFIGURATION:'),
  ]

  for (const malformed of malformedSecretStrings) {
    await expectRejectedConfiguration(malformed)
  }
})

test('rejects incomplete, duplicate, unexpected, and ambiguous records atomically', async () => {
  const configuration = createValidConfiguration()
  const configuredName = API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES[0]
  if (configuredName === undefined) {
    throw new Error('Test configuration fixture is invalid.')
  }
  const configuredValue = configuration.expectedValues.get(configuredName)
  if (configuredValue === undefined) {
    throw new Error('Test configuration value is invalid.')
  }
  const configuredRecord =
    `value:${configuredName}:${encodeConfigurationValue(configuredValue)}`

  for (const secretString of [
    replaceConfigurationRecord(configuration.secretString, configuredName, ''),
    `${configuration.secretString.slice(0, -1)}\n${configuredRecord}\n`,
    replaceConfigurationRecord(
      configuration.secretString,
      configuredName,
      `value:UNKNOWN_CONFIGURATION:${encodeConfigurationValue('unexpected')}`,
    ),
  ]) {
    await expectRejectedConfiguration(secretString)
  }

  const ambiguousEnvironment = {
    ...createPointerEnvironment(),
    [configuredName]: 'discrete-value',
  }
  const originalAmbiguousEnvironment = { ...ambiguousEnvironment }
  await expect(hydrateApiRuntimeEnvironment(
    ambiguousEnvironment,
    async () => [configuration.secretString],
  )).rejects.toThrow(invalidMessage)
  expect(ambiguousEnvironment).toEqual(originalAmbiguousEnvironment)
})

test('rejects invalid, noncanonical, non-UTF-8, and NUL direct values atomically', async () => {
  const invalidEncodedValues = [
    '',
    'not-base64!',
    'Zg',
    'Zh==',
    '-_8=',
    Buffer.from([0xc3, 0x28]).toString('base64'),
    encodeConfigurationValue('\0'),
  ]
  const configuredName = API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES[0]
  if (configuredName === undefined) {
    throw new Error('Test configuration name is invalid.')
  }

  for (const invalidEncodedValue of invalidEncodedValues) {
    await expectRejectedConfiguration(replaceConfigurationRecord(
      createValidConfiguration().secretString,
      configuredName,
      `value:${configuredName}:${invalidEncodedValue}`,
    ))
  }
})

test('rejects invalid nested pointers before requesting their values', async () => {
  const configuredName = API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES[0]
  if (configuredName === undefined) {
    throw new Error('Test configuration name is invalid.')
  }
  const secretString = replaceConfigurationRecord(
    createValidConfiguration().secretString,
    configuredName,
    `secret:${configuredName}:${encodeConfigurationValue('not-an-arn')}`,
  )
  const environment = createPointerEnvironment()
  const originalEnvironment = { ...environment }
  let loadCount = 0

  await expect(hydrateApiRuntimeEnvironment(environment, async () => {
    loadCount += 1
    return [secretString]
  })).rejects.toThrow(invalidMessage)
  expect(loadCount).toBe(1)
  expect(environment).toEqual(originalEnvironment)
})

test('rejects duplicate nested secret pointers before loading them', async () => {
  const configuration = createValidConfiguration(
    new Set(API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.slice(0, 2)),
  )
  const secondName = API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES[1]
  const firstNestedArn = configuration.nestedSecretArns[0]
  if (secondName === undefined || firstNestedArn === undefined) {
    throw new Error('Test nested secret fixture is invalid.')
  }
  const secretString = replaceConfigurationRecord(
    configuration.secretString,
    secondName,
    `secret:${secondName}:${encodeConfigurationValue(firstNestedArn)}`,
  )
  const environment = createPointerEnvironment()
  const originalEnvironment = { ...environment }
  let loadCount = 0

  await expect(hydrateApiRuntimeEnvironment(environment, async () => {
    loadCount += 1
    return [secretString]
  })).rejects.toThrow(invalidMessage)
  expect(loadCount).toBe(1)
  expect(environment).toEqual(originalEnvironment)
})

test('rejects missing, empty, and NUL nested secret values atomically', async () => {
  const configuration = createValidConfiguration(
    new Set(API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.slice(0, 2)),
  )
  const invalidNestedResponses = [
    ['one-value-only'],
    ['one', 'two', 'three'],
    ['', 'valid'],
    ['valid', 'contains\0nul'],
  ]

  for (const invalidNestedResponse of invalidNestedResponses) {
    const environment = createPointerEnvironment()
    const originalEnvironment = { ...environment }
    let loadCount = 0
    await expect(hydrateApiRuntimeEnvironment(environment, async () => {
      loadCount += 1
      return loadCount === 1 ? [configuration.secretString] : invalidNestedResponse
    })).rejects.toThrow(invalidMessage)
    expect(loadCount).toBe(2)
    expect(environment).toEqual(originalEnvironment)
  }
})

test('rejects partial, blank, and malformed pointers before loading', async () => {
  const invalidEnvironments = [
    { MUKUROJI_API_RUNTIME_CONFIG_SECRET_ARN: secretArn },
    { MUKUROJI_API_RUNTIME_CONFIG_REVISION: configurationRevision },
    { ...createPointerEnvironment(), MUKUROJI_API_RUNTIME_CONFIG_SECRET_ARN: '' },
    { ...createPointerEnvironment(), MUKUROJI_API_RUNTIME_CONFIG_SECRET_ARN: 'api-config' },
    { ...createPointerEnvironment(), MUKUROJI_API_RUNTIME_CONFIG_REVISION: '' },
    { ...createPointerEnvironment(), MUKUROJI_API_RUNTIME_CONFIG_REVISION: '-starts-with-dash' },
  ]

  for (const environment of invalidEnvironments) {
    const originalEnvironment = { ...environment }
    let loaderCalled = false
    await expect(hydrateApiRuntimeEnvironment(environment, async () => {
      loaderCalled = true
      return []
    })).rejects.toThrow(invalidMessage)
    expect(loaderCalled).toBe(false)
    expect(environment).toEqual(originalEnvironment)
  }
})

test('allows pointer-free local execution and a strictly local Floci Lambda', async () => {
  const localEnvironment = { NODE_ENV: 'test' }
  await hydrateApiRuntimeEnvironment(localEnvironment)
  expect(localEnvironment).toEqual({ NODE_ENV: 'test' })

  const flociEnvironment = {
    AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
    AWS_LAMBDA_FUNCTION_NAME: 'local-api',
    DYNAMODB_ENDPOINT: 'http://floci:4566',
    MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
    NODE_ENV: 'development',
    SECRETS_MANAGER_ENDPOINT: 'http://localstack:4566/',
  }
  await hydrateApiRuntimeEnvironment(flociEnvironment)
  expect(flociEnvironment).toEqual({
    AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
    AWS_LAMBDA_FUNCTION_NAME: 'local-api',
    DYNAMODB_ENDPOINT: 'http://floci:4566',
    MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
    NODE_ENV: 'development',
    SECRETS_MANAGER_ENDPOINT: 'http://localstack:4566/',
  })
})

test('rejects pointer-free real Lambda and remote or malformed Floci endpoints', async () => {
  const invalidLambdaEnvironments = [
    {
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
      AWS_LAMBDA_FUNCTION_NAME: 'production-api',
    },
    {
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
      AWS_LAMBDA_FUNCTION_NAME: 'local-api',
      DYNAMODB_ENDPOINT: 'http://example.com:4566',
      MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
      NODE_ENV: 'development',
      SECRETS_MANAGER_ENDPOINT: 'http://floci:4566',
    },
    {
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
      AWS_LAMBDA_FUNCTION_NAME: 'local-api',
      DYNAMODB_ENDPOINT: 'http://floci:4566',
      MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
      NODE_ENV: 'development',
      SECRETS_MANAGER_ENDPOINT: 'https://floci:4566',
    },
    {
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
      AWS_LAMBDA_FUNCTION_NAME: 'local-api',
      DYNAMODB_ENDPOINT: 'http://floci:4566/path',
      MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
      NODE_ENV: 'development',
      SECRETS_MANAGER_ENDPOINT: 'http://floci:4566',
    },
    {
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
      AWS_LAMBDA_FUNCTION_NAME: 'local-api',
      DYNAMODB_ENDPOINT: 'http://floci:4566',
      MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
      NODE_ENV: 'production',
      SECRETS_MANAGER_ENDPOINT: 'http://floci:4566',
    },
    {
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
      DYNAMODB_ENDPOINT: 'http://floci:4566',
      MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
      NODE_ENV: 'development',
      SECRETS_MANAGER_ENDPOINT: 'http://floci:4566',
    },
    {
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
      AWS_LAMBDA_FUNCTION_NAME: 'local-api',
      DYNAMODB_ENDPOINT: 'http://user@floci:4566',
      MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
      NODE_ENV: 'development',
      SECRETS_MANAGER_ENDPOINT: 'http://floci:4566',
    },
    {
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
      AWS_LAMBDA_FUNCTION_NAME: 'local-api',
      DYNAMODB_ENDPOINT: 'http://floci:4566?service=dynamodb',
      MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
      NODE_ENV: 'development',
      SECRETS_MANAGER_ENDPOINT: 'http://floci:4566',
    },
    {
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
      AWS_LAMBDA_FUNCTION_NAME: 'local-api',
      DYNAMODB_ENDPOINT: 'http://floci:4566',
      MUKUROJI_LOCAL_AWS_RUNTIME: 'floci ',
      NODE_ENV: 'development',
      SECRETS_MANAGER_ENDPOINT: 'http://floci:4566#secrets',
    },
  ]

  for (const environment of invalidLambdaEnvironments) {
    await expect(hydrateApiRuntimeEnvironment(environment)).rejects.toThrow(
      'API runtime environment configuration is invalid.',
    )
  }
})
