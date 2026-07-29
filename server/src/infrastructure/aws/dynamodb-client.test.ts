import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { expect, spyOn, test } from 'bun:test'
import {
  createDynamoDbClient,
  createWorkspaceSearchWriterDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from './dynamodb-client'

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

/**
 * Creates one offline low-level client for factory validation.
 *
 * @returns DynamoDB client that is never sent a request.
 */
function createOfflineDynamoDbClient(): DynamoDBClient {
  return new DynamoDBClient({
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    region: 'ap-northeast-1',
  })
}

/** Environment keys that select the exact writer-fence runtime mode. */
const runtimeEnvironment: Readonly<Record<string, string | undefined>> = {
  AWS_EXECUTION_ENV: undefined,
  AWS_LAMBDA_FUNCTION_NAME: undefined,
  AWS_ENDPOINT_URL: undefined,
  AWS_ENDPOINT_URL_DYNAMODB: undefined,
  DYNAMODB_ENDPOINT: undefined,
  MUKUROJI_LOCAL_AWS_RUNTIME: undefined,
}

/** Exact complete production table-name configuration. */
const completeTableEnvironment: Readonly<
  Record<string, string | undefined>
> = {
  PROJECT_DIRECTORY_TABLE_NAME: 'ProjectDirectory',
  WORK_ITEMS_TABLE_NAME: 'WorkItems',
  COLLABORATION_TABLE_NAME: 'Collaboration',
  DOCUMENTS_TABLE_NAME: 'Documents',
  WORKSPACE_SEARCH_TABLE_NAME: 'WorkspaceSearch',
  WORKSPACE_SEARCH_MIGRATION_STATE_TABLE_NAME:
    'WorkspaceSearchMigrationState',
}

test('requires the writer-fence mode outside explicit local runtimes', async () => {
  await withServerEnvironment({
    ...runtimeEnvironment,
    ...completeTableEnvironment,
    NODE_ENV: 'production',
    MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: undefined,
  }, () => {
    const lowLevelClient = createOfflineDynamoDbClient()
    try {
      expect(() =>
        createWorkspaceSearchWriterDynamoDbDocumentClient(lowLevelClient)
      ).toThrow(
        'MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE=required is required.',
      )
    } finally {
      lowLevelClient.destroy()
    }
  })
})

test('does not accept NODE_ENV=test as a Lambda writer-fence bypass', async () => {
  await withServerEnvironment({
    ...runtimeEnvironment,
    ...completeTableEnvironment,
    NODE_ENV: 'test',
    AWS_LAMBDA_FUNCTION_NAME: 'production-writer',
    AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
    MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: undefined,
  }, () => {
    const lowLevelClient = createOfflineDynamoDbClient()
    try {
      expect(() =>
        createWorkspaceSearchWriterDynamoDbDocumentClient(lowLevelClient)
      ).toThrow(
        'MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE=required is required.',
      )
    } finally {
      lowLevelClient.destroy()
    }
  })
})

test('does not accept NODE_ENV=test for a remote DynamoDB endpoint', async () => {
  await withServerEnvironment({
    ...runtimeEnvironment,
    ...completeTableEnvironment,
    NODE_ENV: 'test',
    DYNAMODB_ENDPOINT:
      'https://dynamodb.ap-northeast-1.amazonaws.com',
    MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: undefined,
  }, () => {
    const lowLevelClient = createOfflineDynamoDbClient()
    try {
      expect(() =>
        createWorkspaceSearchWriterDynamoDbDocumentClient(lowLevelClient)
      ).toThrow(
        'MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE=required is required.',
      )
    } finally {
      lowLevelClient.destroy()
    }
  })
})

test('requires every exact table name in required mode', async () => {
  await withServerEnvironment({
    ...runtimeEnvironment,
    ...completeTableEnvironment,
    NODE_ENV: 'production',
    DOCUMENTS_TABLE_NAME: ' ',
    MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: 'required',
  }, () => {
    const lowLevelClient = createOfflineDynamoDbClient()
    try {
      expect(() =>
        createWorkspaceSearchWriterDynamoDbDocumentClient(lowLevelClient)
      ).toThrow(
        'DOCUMENTS_TABLE_NAME is required for the Workspace Search writer fence.',
      )
    } finally {
      lowLevelClient.destroy()
    }
  })
})

test('accepts a complete exact six-table configuration in required mode', async () => {
  await withServerEnvironment({
    ...runtimeEnvironment,
    ...completeTableEnvironment,
    NODE_ENV: 'production',
    MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: 'required',
  }, () => {
    const lowLevelClient = createDynamoDbClient()
    const documentClient =
      createWorkspaceSearchWriterDynamoDbDocumentClient(lowLevelClient)

    expect(documentClient.middlewareStack.identify()).toContain(
      'mukurojiWorkspaceSearchWriterFence - initialize',
    )
    documentClient.destroy()
  })
})

test('rejects a local bypass for an unbound injected transport', async () => {
  await withServerEnvironment({
    ...runtimeEnvironment,
    ...completeTableEnvironment,
    NODE_ENV: 'development',
    AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-local-floci-api',
    DYNAMODB_ENDPOINT: 'http://floci:8000',
    MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
    MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: 'local-floci-bypass',
  }, () => {
    const lowLevelClient = createOfflineDynamoDbClient()
    try {
      expect(() =>
        createWorkspaceSearchWriterDynamoDbDocumentClient(lowLevelClient)
      ).toThrow(
        'Workspace Search writer-fence local bypass configuration is invalid.',
      )
    } finally {
      lowLevelClient.destroy()
    }
  })
})

test('accepts only the explicit non-production Floci bypass boundary', async () => {
  await withServerEnvironment({
    ...runtimeEnvironment,
    ...completeTableEnvironment,
    NODE_ENV: 'development',
    AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-local-floci-api',
    DYNAMODB_ENDPOINT: 'http://floci:8000',
    MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
    MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: 'local-floci-bypass',
  }, () => {
    const lowLevelClient = createDynamoDbClient()
    const documentClient =
      createWorkspaceSearchWriterDynamoDbDocumentClient(lowLevelClient)

    expect(documentClient.middlewareStack.identify()).not.toContain(
      'mukurojiWorkspaceSearchWriterFence - initialize',
    )
    documentClient.destroy()
  })
})

test('accepts rollout-pending only for an explicit remote AWS Lambda runtime', async () => {
  await withServerEnvironment({
    ...runtimeEnvironment,
    ...completeTableEnvironment,
    NODE_ENV: 'production',
    AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-production-api',
    AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
    MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: 'rollout-pending',
  }, () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    const lowLevelClient = createOfflineDynamoDbClient()
    try {
      const documentClient =
        createWorkspaceSearchWriterDynamoDbDocumentClient(lowLevelClient)

      expect(documentClient.middlewareStack.identify()).toContain(
        'mukurojiWorkspaceSearchWriterFenceRolloutPending - initialize',
      )
      expect(documentClient.middlewareStack.identify()).not.toContain(
        'mukurojiWorkspaceSearchWriterFence - initialize',
      )
      expect(warning).toHaveBeenCalledWith(
        'WORKSPACE_SEARCH_WRITER_FENCE_ROLLOUT_PENDING',
      )
      documentClient.destroy()
    } finally {
      warning.mockRestore()
      lowLevelClient.destroy()
    }
  })
})

test('rejects rollout-pending in tests or with endpoint overrides', async () => {
  for (const overrides of [
    {
      NODE_ENV: 'test',
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-production-api',
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
    },
    {
      NODE_ENV: 'production',
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-production-api',
      AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
      DYNAMODB_ENDPOINT: 'http://localhost:4566',
    },
    {
      NODE_ENV: 'production',
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-production-api',
      AWS_EXECUTION_ENV: undefined,
    },
  ]) {
    await withServerEnvironment({
      ...runtimeEnvironment,
      ...completeTableEnvironment,
      ...overrides,
      MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: 'rollout-pending',
    }, () => {
      const lowLevelClient = createOfflineDynamoDbClient()
      try {
        expect(() =>
          createWorkspaceSearchWriterDynamoDbDocumentClient(lowLevelClient)
        ).toThrow(
          'Workspace Search writer-fence rollout-pending configuration is invalid.',
        )
      } finally {
        lowLevelClient.destroy()
      }
    })
  }
})

test('rejects Floci bypass in production even for a local endpoint', async () => {
  await withServerEnvironment({
    ...runtimeEnvironment,
    ...completeTableEnvironment,
    NODE_ENV: 'production',
    DYNAMODB_ENDPOINT: 'http://floci:8000',
    MUKUROJI_LOCAL_AWS_RUNTIME: 'floci',
    MUKUROJI_WORKSPACE_SEARCH_WRITER_FENCE_MODE: 'local-floci-bypass',
  }, () => {
    const lowLevelClient = createOfflineDynamoDbClient()
    try {
      expect(() =>
        createWorkspaceSearchWriterDynamoDbDocumentClient(lowLevelClient)
      ).toThrow(
        'Workspace Search writer-fence local bypass configuration is invalid.',
      )
    } finally {
      lowLevelClient.destroy()
    }
  })
})

test('local table bootstrap rejects userinfo and non-origin endpoint forms', async () => {
  for (const endpoint of [
    'http://localhost:443@remote-host:8000',
    'http://floci:8000/path',
    'http://localstack:8000?target=remote',
    'https://localhost:8000',
  ]) {
    await withServerEnvironment({
      ...runtimeEnvironment,
      DYNAMODB_ENDPOINT: endpoint,
    }, () => {
      expect(shouldBootstrapLocalDynamoDb()).toBe(false)
    })
  }

  await withServerEnvironment({
    ...runtimeEnvironment,
    DYNAMODB_ENDPOINT: 'http://[::1]:8000',
  }, () => {
    expect(shouldBootstrapLocalDynamoDb()).toBe(true)
  })
})
