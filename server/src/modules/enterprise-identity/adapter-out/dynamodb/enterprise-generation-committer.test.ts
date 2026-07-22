import { expect, test } from 'bun:test'
import {
  BatchWriteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import { DynamoDbEnterpriseGenerationCommitter } from './enterprise-generation-committer'

const tableName = 'enterprise-identity'
const workspaceId = 'workspace-1'
const stateGeneration = '00000000-0000-4000-8000-000000000001'

/** Returns one valid staged generation record for adapter tests. */
function createStagedItems(): Record<string, unknown>[] {
  return [{
    scopeKey: `WORKSPACE_STATE#${workspaceId}#${stateGeneration}`,
    recordKey: 'GENERATION',
    stateGeneration,
  }]
}

/** Returns the minimal CONTROL transaction required by the committer. */
function createTransactionItems() {
  return [{
    Put: {
      TableName: tableName,
      Item: {
        scopeKey: `WORKSPACE#${workspaceId}`,
        recordKey: 'CONTROL',
        workspaceId,
        controlRevision: 1,
        activeStateGeneration: stateGeneration,
      },
    },
  }]
}

test('backs off before retrying unprocessed staging and an ambiguous transaction', async () => {
  let batchAttempts = 0
  let transactionAttempts = 0
  const retryAttempts: number[] = []
  const documentClient = {
    async send(command: unknown) {
      if (command instanceof BatchWriteCommand) {
        batchAttempts += 1
        return batchAttempts === 1
          ? { UnprocessedItems: command.input.RequestItems }
          : { UnprocessedItems: {} }
      }
      if (command instanceof TransactWriteCommand) {
        transactionAttempts += 1
        if (transactionAttempts === 1) {
          const error = new Error('Injected ambiguous transaction response')
          error.name = 'TimeoutError'
          throw error
        }
        return {}
      }
      throw new Error('Unexpected DynamoDB command.')
    },
  }
  const committer = new DynamoDbEnterpriseGenerationCommitter(
    tableName,
    documentClient as never,
    async (attempt) => {
      retryAttempts.push(attempt)
    },
  )

  await expect(committer.commit(
    createStagedItems(),
    createTransactionItems(),
  )).resolves.toBeUndefined()
  expect(retryAttempts).toEqual([0, 0])
  expect(batchAttempts).toBe(2)
  expect(transactionAttempts).toBe(2)
})

test('logs cleanup failures with the generation correlation ID without masking the commit error', async () => {
  let batchAttempts = 0
  const retryAttempts: number[] = []
  const cleanupFailures: unknown[] = []
  const documentClient = {
    async send(command: unknown) {
      if (command instanceof BatchWriteCommand) {
        batchAttempts += 1
        if (batchAttempts === 1) return { UnprocessedItems: {} }
        if (batchAttempts === 2) {
          return { UnprocessedItems: command.input.RequestItems }
        }
        const error = new Error('Injected cleanup throttling')
        error.name = 'ThrottlingException'
        throw error
      }
      if (command instanceof TransactWriteCommand) {
        const error = new Error('Injected definitive transaction rejection')
        error.name = 'ValidationException'
        throw error
      }
      throw new Error('Unexpected DynamoDB command.')
    },
  }
  const committer = new DynamoDbEnterpriseGenerationCommitter(
    tableName,
    documentClient as never,
    async (attempt) => {
      retryAttempts.push(attempt)
    },
    (failure) => {
      cleanupFailures.push(failure)
    },
  )

  await expect(committer.commit(
    createStagedItems(),
    createTransactionItems(),
  )).rejects.toMatchObject({
    code: 'EnterpriseIdentityUnavailable',
    retryable: true,
  })
  expect(retryAttempts).toEqual([0])
  expect(cleanupFailures).toEqual([{
    event: 'enterprise_identity_generation_cleanup_failed',
    correlationId: stateGeneration,
    itemCount: 1,
    errorName: 'ThrottlingException',
    errorMessage: 'Injected cleanup throttling',
  }])
})
