import { describe, expect, test } from 'bun:test'
import {
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import {
  createWorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration,
  createWorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport,
  type WorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration,
  type WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration,
  WorkspaceSearchMigrationDescribeTableSingleAttempt,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_SDK_MAX_ATTEMPTS,
} from './migration-describe-table-single-attempt-aws'

/** Fixed test credentials that never leave the deterministic SDK harness. */
const credentials = {
  accountId: '123456789012',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
}

/**
 * Deterministic request handler that makes every SDK attempt retryable.
 */
class AlwaysTimeoutRequestHandler {
  /** Number of physical handler invocations. */
  attemptCount = 0

  /** Number of request-handler releases. */
  destroyCount = 0

  /**
   * Rejects one request with the SDK's retryable timeout classification.
   *
   * @returns A promise that always rejects.
   */
  async handle(): Promise<never> {
    this.attemptCount += 1
    const timeout = new Error('deterministic timeout')
    timeout.name = 'TimeoutError'
    throw timeout
  }

  /** Records one request-handler release. */
  destroy(): void {
    this.destroyCount += 1
  }
}

describe('Workspace Search migration single-attempt DescribeTable transport', () => {
  test('reconstructs an allowlisted maxAttempts-one configuration', () => {
    const configuration = createConfiguration()
    Reflect.set(configuration, 'endpoint', 'http://localhost:8000')
    Reflect.set(configuration, 'maxAttempts', 99)
    Reflect.set(configuration, 'retryStrategy', { mode: 'hostile' })
    const clientConfiguration =
      createWorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration(
        configuration,
      )

    expect(clientConfiguration).toEqual({
      credentials,
      endpoint: 'https://dynamodb.ap-northeast-1.amazonaws.com/',
      maxAttempts:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_SDK_MAX_ATTEMPTS,
      region: 'ap-northeast-1',
    })
    expect(clientConfiguration).not.toHaveProperty('retryStrategy')
    expect(Object.isFrozen(clientConfiguration)).toBeTrue()
    expect(clientConfiguration.credentials).not.toBe(credentials)
  })

  test('detaches static credential scalars and expiration at both factories', () => {
    const sourceExpiration = new Date('2030-01-02T03:04:05.000Z')
    const sourceCredentials = {
      accountId: '123456789012',
      accessKeyId: 'source-access-key',
      credentialScope: 'source-scope',
      expiration: sourceExpiration,
      secretAccessKey: 'source-secret-key',
      sessionToken: 'source-session-token',
    }
    const configuration: WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration = {
      account: '123456789012',
      credentials: sourceCredentials,
      region: 'ap-northeast-1',
    }
    const clientConfiguration =
      createWorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration(
        configuration,
      )
    const transport =
      createWorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport(
        configuration,
      )

    Reflect.set(sourceCredentials, 'accountId', '999999999999')
    Reflect.set(sourceCredentials, 'accessKeyId', 'mutated-access-key')
    Reflect.set(sourceCredentials, 'credentialScope', 'mutated-scope')
    Reflect.set(sourceCredentials, 'secretAccessKey', 'mutated-secret-key')
    Reflect.set(sourceCredentials, 'sessionToken', 'mutated-session-token')
    sourceExpiration.setTime(0)
    Reflect.set(configuration, 'account', '999999999999')
    Reflect.set(configuration, 'region', 'us-east-1')

    expect(clientConfiguration.credentials).toEqual({
      accountId: '123456789012',
      accessKeyId: 'source-access-key',
      credentialScope: 'source-scope',
      expiration: new Date('2030-01-02T03:04:05.000Z'),
      secretAccessKey: 'source-secret-key',
      sessionToken: 'source-session-token',
    })
    expect(clientConfiguration.credentials).not.toBe(sourceCredentials)
    expect(clientConfiguration.credentials.expiration).not.toBe(
      sourceExpiration,
    )
    expect(
      Object.isFrozen(clientConfiguration.credentials.expiration),
    ).toBeTrue()
    expect(transport.createAttempt('workspace-search-table')).toBeInstanceOf(
      WorkspaceSearchMigrationDescribeTableSingleAttempt,
    )
    transport.close()
  })

  test('rejects dynamic, absent, invalid, and cross-account credentials', () => {
    const invalidCredentials: readonly unknown[] = [
      undefined,
      (): Promise<typeof credentials> => Promise.resolve(credentials),
      {
        ...credentials,
        accountId: '999999999999',
      },
      {
        ...credentials,
        expiration: new Date(Number.NaN),
      },
      {
        accountId: '123456789012',
        accessKeyId: '',
        secretAccessKey: 'test-secret-key',
      },
    ]

    for (const invalidCredential of invalidCredentials) {
      const invalidConfiguration = {
        account: '123456789012',
        credentials: invalidCredential,
        region: 'ap-northeast-1',
      }
      expect(() =>
        Reflect.apply(
          createWorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration,
          undefined,
          [invalidConfiguration],
        )).toThrow('Invalid DescribeTable transport credentials.')
      expect(() =>
        Reflect.apply(
          createWorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport,
          undefined,
          [invalidConfiguration],
        )).toThrow('Invalid DescribeTable transport credentials.')
    }
  })

  test('keeps construction and execution behind the genuine controller', async () => {
    const configuration = createConfiguration()
    let regionReads = 0
    Object.defineProperty(configuration, 'region', {
      configurable: true,
      get: (): string => {
        regionReads += 1
        return regionReads === 1
          ? 'ap-northeast-1'
          : 'us-east-1'
      },
    })
    const transport =
      createWorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport(
        configuration,
      )
    const attempt = transport.createAttempt('workspace-search-table')
    const abortController = new AbortController()

    expect(
      WorkspaceSearchMigrationDescribeTableSingleAttempt
        .controllerConsume(undefined, attempt),
    ).toBeFalse()
    await expect(
      WorkspaceSearchMigrationDescribeTableSingleAttempt
        .controllerExecute(
          undefined,
          attempt,
          abortController.signal,
        ),
    ).rejects.toThrow('DescribeTable attempt is not executable.')
    expect(() =>
      new WorkspaceSearchMigrationDescribeTableSingleAttempt(
        Symbol('forged'),
        'forged-scope',
        'forged-transport',
        () => Promise.resolve({}),
      )).toThrow('Invalid DescribeTable attempt construction.')
    expect(() =>
      Reflect.apply(
        transport.createAttempt,
        transport,
        [new DeleteTableCommand({ TableName: 'workspace-search-table' })],
      )).toThrow('Invalid DescribeTable table name.')
    expect(Reflect.ownKeys(transport)).toEqual([])
    const transportPrototype = Reflect.getPrototypeOf(transport)
    if (transportPrototype === null) {
      throw new Error('Expected the transport prototype.')
    }
    const transportConstructor = Reflect.getOwnPropertyDescriptor(
      transportPrototype,
      'constructor',
    )?.value
    if (typeof transportConstructor !== 'function') {
      throw new Error('Expected the transport constructor.')
    }
    expect(Object.isFrozen(transportConstructor)).toBeTrue()
    expect(() =>
      Reflect.construct(transportConstructor, []),
    ).toThrow('Invalid DescribeTable capability construction.')
    expect(
      Reflect.set(
        transport,
        'client',
        Object.freeze({}),
      ),
    ).toBeFalse()
    expect(() =>
      Reflect.apply(
        transport.createAttempt,
        Object.freeze({}),
        ['workspace-search-table'],
      )).toThrow()
    expect(regionReads).toBe(1)
    transport.close()
  })

  test('allows only one real SDK handler invocation for a retryable failure', async () => {
    const requestHandler = new AlwaysTimeoutRequestHandler()
    const clientConfiguration =
      createWorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration(
        createConfiguration(),
      )
    const client = createRetryProbeClient(
      clientConfiguration,
      requestHandler,
    )

    try {
      await expect(
        client.send(
          new DescribeTableCommand({
            TableName: 'workspace-search-table',
          }),
        ),
      ).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(clientConfiguration.maxAttempts).toBe(1)
      expect(requestHandler.attemptCount).toBe(1)
    } finally {
      client.destroy()
    }
    expect(requestHandler.destroyCount).toBe(1)
  })
})

/**
 * Creates one explicit pinned test configuration.
 *
 * @returns Deterministic DynamoDB configuration without retry controls.
 */
function createConfiguration():
  WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration {
  return {
    account: '123456789012',
    credentials,
    region: 'ap-northeast-1',
  }
}

/**
 * Creates a real SDK client with a deterministic retryable request handler.
 *
 * @param configuration - Final transport-owned single-attempt configuration.
 * @param requestHandler - Handler that counts and rejects physical invocations.
 * @returns Dedicated low-level client using the real SDK retry middleware.
 */
function createRetryProbeClient(
  configuration: WorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration,
  requestHandler: AlwaysTimeoutRequestHandler,
): DynamoDBClient {
  return new DynamoDBClient({
    credentials: configuration.credentials,
    endpoint: configuration.endpoint,
    maxAttempts: configuration.maxAttempts,
    region: configuration.region,
    requestHandler,
  })
}
