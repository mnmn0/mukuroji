import { expect, test } from 'bun:test'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from './dynamodb-client'
import { loadServerConfig } from '../config/server-config'

/**
 * Runs one test with isolated live server environment overrides.
 *
 * @param overrides - Environment keys to set or delete.
 * @param callback - Test body executed with the overrides.
 * @returns The callback result.
 */
async function withServerEnvironment<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  callback: () => T | Promise<T>,
): Promise<T> {
  const previousValues = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(overrides)) {
    previousValues.set(name, Bun.env[name])
    if (value === undefined) {
      delete Bun.env[name]
    } else {
      Bun.env[name] = value
    }
  }

  try {
    return await callback()
  } finally {
    for (const [name, value] of previousValues) {
      if (value === undefined) {
        delete Bun.env[name]
      } else {
        Bun.env[name] = value
      }
    }
  }
}

test('uses one supplied configuration snapshot for transport and bootstrap', async () => {
  const config = loadServerConfig({
    AWS_REGION: 'ap-northeast-1',
    DYNAMODB_ENDPOINT: 'http://floci:8000',
  }, { localBun: false })
  const client = createDynamoDbClient(config)

  try {
    const endpoint = await client.config.endpoint?.()
    expect(await client.config.region()).toBe('ap-northeast-1')
    expect(endpoint).toMatchObject({
      hostname: 'floci',
      port: 8000,
      protocol: 'http:',
    })
    expect(shouldBootstrapLocalDynamoDb(config)).toBe(true)
    expect(createDynamoDbDocumentClient(client)).toBeDefined()
  } finally {
    client.destroy()
  }
})

test('uses non-secret local credentials and the default provider chain for regional AWS endpoints', async () => {
  const localConfig = loadServerConfig({
    AWS_ACCESS_KEY_ID: 'real-looking-access-key',
    AWS_SECRET_ACCESS_KEY: 'real-looking-secret',
    DYNAMODB_ENDPOINT: 'http://floci:8000',
  }, { localBun: false })
  const localClient = createDynamoDbClient(localConfig)
  const localCredentials = await localClient.config.credentials()
  expect(localCredentials).toMatchObject({
    accessKeyId: 'local',
    secretAccessKey: 'local',
  })
  localClient.destroy()

  const regionalConfig = loadServerConfig({
    AWS_REGION: 'ap-northeast-1',
    DYNAMODB_ENDPOINT: 'https://dynamodb.ap-northeast-1.amazonaws.com',
  }, { localBun: false })
  const regionalClient = createDynamoDbClient(regionalConfig)
  expect(regionalClient.config.credentials).toBeDefined()
  regionalClient.destroy()
})

test('local table bootstrap rejects userinfo and non-origin endpoint forms', async () => {
  for (const endpoint of [
    'http://localhost:443@remote-host:8000',
    'http://floci:8000/path',
    'http://localstack:8000?target=remote',
    'https://localhost:8000',
  ]) {
    await withServerEnvironment({ DYNAMODB_ENDPOINT: endpoint }, () => {
      expect(() => shouldBootstrapLocalDynamoDb()).toThrow('DynamoDB endpoint')
    })
  }

  await withServerEnvironment({
    DYNAMODB_ENDPOINT: 'http://[::1]:8000',
  }, () => {
    expect(shouldBootstrapLocalDynamoDb()).toBe(true)
  })
})
