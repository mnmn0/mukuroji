import { expect, test } from 'bun:test'
import {
  API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES,
  hydrateApiRuntimeEnvironment,
} from './api-runtime-environment'

const configurationHeader = 'mukuroji-api-runtime-configuration-v2\n'
const secretArns = [
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:core',
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:data',
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:identity',
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:workflow',
]
const configurationGroups = ['core', 'data', 'identity', 'workflow']
const configurationRevision = 'revision-7'
const configuredValuePrefix = '設定済み-configured-'

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
 * Creates four complete disjoint v2 configuration envelopes.
 *
 * @param secretBackedNames - Canonical names represented by nested secret ARNs.
 * @returns Group strings, deterministic nested loads, and expected final values.
 */
function createValidConfigurationGroups(
  secretBackedNames: ReadonlySet<string> = new Set(),
) {
  const groupRecords: string[][] = [[], [], [], []]
  const groupNestedArns: string[][] = [[], [], [], []]
  const expectedValues = new Map<string, string>()
  const nestedValues = new Map<string, string>()

  for (
    let index = 0;
    index < API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.length;
    index += 1
  ) {
    const groupIndex = index % groupRecords.length
    const records = groupRecords[groupIndex]
    const nestedArns = groupNestedArns[groupIndex]
    const name = API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES[index]
    if (records === undefined || nestedArns === undefined || name === undefined) {
      throw new Error('Test configuration partition is invalid.')
    }

    const configuredValue = `${configuredValuePrefix}${name}`
    expectedValues.set(name, configuredValue)
    if (secretBackedNames.has(name)) {
      const nestedArn =
        `arn:aws:secretsmanager:us-east-1:123456789012:secret:nested-${index}`
      records.push(
        `secret:${name}:${encodeConfigurationValue(nestedArn)}`,
      )
      nestedArns.push(nestedArn)
      nestedValues.set(nestedArn, configuredValue)
      continue
    }
    records.push(
      `value:${name}:${encodeConfigurationValue(configuredValue)}`,
    )
  }

  return {
    expectedValues,
    nestedSecretArns: groupNestedArns.flat(),
    nestedValues,
    secretStrings: groupRecords.map((records, index) => {
      const group = configurationGroups[index]
      if (group === undefined) {
        throw new Error('Test configuration group identity is invalid.')
      }
      return [
        `${configurationHeader}group:${group}`,
        `revision:${encodeConfigurationValue(configurationRevision)}`,
        ...records,
        '',
      ].join('\n')
    }),
  }
}

/**
 * Creates a production-like environment containing only configuration pointers.
 *
 * @returns Mutable environment used by hydrator tests.
 */
function createPointerEnvironment(): Record<string, string | undefined> {
  return {
    MUKUROJI_API_CORE_CONFIG_SECRET_ARN: secretArns[0],
    MUKUROJI_API_DATA_CONFIG_SECRET_ARN: secretArns[1],
    MUKUROJI_API_IDENTITY_CONFIG_SECRET_ARN: secretArns[2],
    MUKUROJI_API_WORKFLOW_CONFIG_SECRET_ARN: secretArns[3],
  }
}

/**
 * Replaces the exact record for one canonical name.
 *
 * @param groups - Complete configuration group strings.
 * @param name - Canonical record name to replace.
 * @param replacement - Complete replacement line, or an empty string to remove it.
 * @returns Updated group strings.
 */
function replaceConfigurationRecord(
  groups: readonly string[],
  name: string,
  replacement: string,
): string[] {
  let replaced = false
  const updated = groups.map((group) => {
    const lines = group.slice(0, -1).split('\n')
    const nextLines = lines.flatMap((line) => {
      if (
        line.startsWith(`value:${name}:`) ||
        line.startsWith(`secret:${name}:`)
      ) {
        replaced = true
        return replacement.length > 0 ? [replacement] : []
      }
      return [line]
    })
    return `${nextLines.join('\n')}\n`
  })
  if (!replaced) {
    throw new Error(`Test configuration record ${name} was not found.`)
  }
  return updated
}

test('loads direct and nested API configuration in deterministic order', async () => {
  const secretBackedNames = new Set(
    API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.slice(0, 8),
  )
  const configuration = createValidConfigurationGroups(secretBackedNames)
  const environment = createPointerEnvironment()
  let loadCount = 0

  await hydrateApiRuntimeEnvironment(environment, async (requestedArns) => {
    loadCount += 1
    if (loadCount === 1) {
      expect(requestedArns).toEqual(secretArns)
      return configuration.secretStrings
    }

    expect(loadCount).toBe(2)
    expect(requestedArns).toEqual(configuration.nestedSecretArns)
    return requestedArns.map((secretArn) => {
      const value = configuration.nestedValues.get(secretArn)
      if (value === undefined) {
        throw new Error('Unexpected nested test secret ARN.')
      }
      return value
    })
  })

  expect(loadCount).toBe(2)
  for (const name of API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES) {
    expect(environment[name]).toBe(configuration.expectedValues.get(name))
  }
})

test('loads a direct-only envelope without a second secret request', async () => {
  const configuration = createValidConfigurationGroups()
  const environment = createPointerEnvironment()
  let loadCount = 0

  await hydrateApiRuntimeEnvironment(environment, async (requestedArns) => {
    loadCount += 1
    expect(requestedArns).toEqual(secretArns)
    return configuration.secretStrings
  })

  expect(loadCount).toBe(1)
  for (const name of API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES) {
    expect(environment[name]).toBe(configuration.expectedValues.get(name))
  }
})

test('rejects swapped group identities and mixed revisions atomically', async () => {
  const configuration = createValidConfigurationGroups()
  const swappedGroups = [...configuration.secretStrings]
  const firstGroup = swappedGroups[0]
  const secondGroup = swappedGroups[1]
  if (firstGroup === undefined || secondGroup === undefined) {
    throw new Error('Test configuration groups are invalid.')
  }
  swappedGroups[0] = secondGroup
  swappedGroups[1] = firstGroup

  const mixedRevisions = [...configuration.secretStrings]
  const dataGroup = mixedRevisions[1]
  if (dataGroup === undefined) {
    throw new Error('Test data configuration group is invalid.')
  }
  mixedRevisions[1] = dataGroup.replace(
    `revision:${encodeConfigurationValue(configurationRevision)}`,
    `revision:${encodeConfigurationValue('revision-8')}`,
  )

  for (const secretStrings of [swappedGroups, mixedRevisions]) {
    const environment = createPointerEnvironment()
    const originalEnvironment = { ...environment }
    await expect(hydrateApiRuntimeEnvironment(
      environment,
      async () => secretStrings,
    )).rejects.toThrow('API runtime environment configuration is invalid.')
    expect(environment).toEqual(originalEnvironment)
  }
})

test('rejects malformed v2 envelopes and line types atomically', async () => {
  const configuration = createValidConfigurationGroups()
  const firstGroup = configuration.secretStrings[0]
  if (firstGroup === undefined) {
    throw new Error('Test configuration group is invalid.')
  }
  const malformedGroupSets = [
    [
      firstGroup.replace(configurationHeader, 'mukuroji-api-runtime-configuration-v1\n'),
      ...configuration.secretStrings.slice(1),
    ],
    [
      JSON.stringify({ schemaVersion: '1' }),
      ...configuration.secretStrings.slice(1),
    ],
    [
      firstGroup.slice(0, -1),
      ...configuration.secretStrings.slice(1),
    ],
    [
      `${firstGroup}\n`,
      ...configuration.secretStrings.slice(1),
    ],
    [
      configurationHeader,
      ...configuration.secretStrings.slice(1),
    ],
    [
      firstGroup.replace('\nvalue:', '\npointer:'),
      ...configuration.secretStrings.slice(1),
    ],
    [
      firstGroup.replace('\nvalue:', '\nvalue:UNKNOWN_CONFIGURATION:'),
      ...configuration.secretStrings.slice(1),
    ],
  ]

  for (const secretStrings of malformedGroupSets) {
    const environment = createPointerEnvironment()
    const originalEnvironment = { ...environment }
    await expect(hydrateApiRuntimeEnvironment(
      environment,
      async () => secretStrings,
    )).rejects.toThrow('API runtime environment configuration is invalid.')
    expect(environment).toEqual(originalEnvironment)
  }
})

test('rejects incomplete, duplicate, unexpected, and ambiguous records atomically', async () => {
  const configuration = createValidConfigurationGroups()
  const configuredName = API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES[0]
  const secondGroup = configuration.secretStrings[1]
  if (configuredName === undefined || secondGroup === undefined) {
    throw new Error('Test configuration fixture is invalid.')
  }
  const configuredValue = configuration.expectedValues.get(configuredName)
  if (configuredValue === undefined) {
    throw new Error('Test configuration value is invalid.')
  }
  const configuredRecord =
    `value:${configuredName}:${encodeConfigurationValue(configuredValue)}`
  const incompleteGroups = replaceConfigurationRecord(
    configuration.secretStrings,
    configuredName,
    '',
  )
  const duplicateGroups = [...configuration.secretStrings]
  duplicateGroups[1] =
    `${secondGroup.slice(0, -1)}\n${configuredRecord}\n`
  const unexpectedGroups = replaceConfigurationRecord(
    configuration.secretStrings,
    configuredName,
    `value:UNKNOWN_CONFIGURATION:${encodeConfigurationValue('unexpected')}`,
  )

  for (const secretStrings of [
    incompleteGroups,
    duplicateGroups,
    unexpectedGroups,
  ]) {
    const environment = createPointerEnvironment()
    const originalEnvironment = { ...environment }
    await expect(hydrateApiRuntimeEnvironment(
      environment,
      async () => secretStrings,
    )).rejects.toThrow('API runtime environment configuration is invalid.')
    expect(environment).toEqual(originalEnvironment)
  }

  const ambiguousEnvironment = {
    ...createPointerEnvironment(),
    [configuredName]: 'discrete-value',
  }
  const originalAmbiguousEnvironment = { ...ambiguousEnvironment }
  await expect(hydrateApiRuntimeEnvironment(
    ambiguousEnvironment,
    async () => configuration.secretStrings,
  )).rejects.toThrow('API runtime environment configuration is invalid.')
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
    const configuration = createValidConfigurationGroups()
    const groups = replaceConfigurationRecord(
      configuration.secretStrings,
      configuredName,
      `value:${configuredName}:${invalidEncodedValue}`,
    )
    const environment = createPointerEnvironment()
    const originalEnvironment = { ...environment }

    await expect(hydrateApiRuntimeEnvironment(
      environment,
      async () => groups,
    )).rejects.toThrow('API runtime environment configuration is invalid.')
    expect(environment).toEqual(originalEnvironment)
  }
})

test('rejects invalid nested pointers before requesting their values', async () => {
  const configuredName = API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES[0]
  if (configuredName === undefined) {
    throw new Error('Test configuration name is invalid.')
  }
  const configuration = createValidConfigurationGroups()
  const groups = replaceConfigurationRecord(
    configuration.secretStrings,
    configuredName,
    `secret:${configuredName}:${encodeConfigurationValue('not-an-arn')}`,
  )
  const environment = createPointerEnvironment()
  const originalEnvironment = { ...environment }
  let loadCount = 0

  await expect(hydrateApiRuntimeEnvironment(
    environment,
    async () => {
      loadCount += 1
      return groups
    },
  )).rejects.toThrow('API runtime environment configuration is invalid.')
  expect(loadCount).toBe(1)
  expect(environment).toEqual(originalEnvironment)
})

test('rejects duplicate nested secret pointers before loading them', async () => {
  const secretBackedNames = new Set(
    API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.slice(0, 2),
  )
  const configuration = createValidConfigurationGroups(secretBackedNames)
  const firstName = API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES[0]
  const secondName = API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES[1]
  const firstNestedArn = configuration.nestedSecretArns[0]
  if (
    firstName === undefined ||
    secondName === undefined ||
    firstNestedArn === undefined
  ) {
    throw new Error('Test nested secret fixture is invalid.')
  }
  const groups = replaceConfigurationRecord(
    configuration.secretStrings,
    secondName,
    `secret:${secondName}:${encodeConfigurationValue(firstNestedArn)}`,
  )
  const environment = createPointerEnvironment()
  const originalEnvironment = { ...environment }
  let loadCount = 0

  await expect(hydrateApiRuntimeEnvironment(
    environment,
    async () => {
      loadCount += 1
      return groups
    },
  )).rejects.toThrow('API runtime environment configuration is invalid.')
  expect(loadCount).toBe(1)
  expect(environment).toEqual(originalEnvironment)
})

test('rejects missing, empty, and NUL nested secret values atomically', async () => {
  const secretBackedNames = new Set(
    API_RUNTIME_ENVIRONMENT_VARIABLE_NAMES.slice(0, 2),
  )
  const configuration = createValidConfigurationGroups(secretBackedNames)
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
    await expect(hydrateApiRuntimeEnvironment(
      environment,
      async () => {
        loadCount += 1
        return loadCount === 1
          ? configuration.secretStrings
          : invalidNestedResponse
      },
    )).rejects.toThrow('API runtime environment configuration is invalid.')
    expect(loadCount).toBe(2)
    expect(environment).toEqual(originalEnvironment)
  }
})

test('rejects partial, blank, and duplicate group pointers before loading', async () => {
  const invalidEnvironments = [
    {
      MUKUROJI_API_CORE_CONFIG_SECRET_ARN: secretArns[0],
    },
    {
      ...createPointerEnvironment(),
      MUKUROJI_API_CORE_CONFIG_SECRET_ARN: '',
    },
    {
      ...createPointerEnvironment(),
      MUKUROJI_API_DATA_CONFIG_SECRET_ARN: secretArns[0],
    },
  ]

  for (const environment of invalidEnvironments) {
    const originalEnvironment = { ...environment }
    let loaderCalled = false
    await expect(hydrateApiRuntimeEnvironment(environment, async () => {
      loaderCalled = true
      return []
    })).rejects.toThrow('API runtime environment configuration is invalid.')
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
