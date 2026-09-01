import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, spyOn, test } from 'bun:test'
import type { CustomerRequest } from '@mukuroji/contracts'
import { createCustomerRequestRecord } from '../../domain/customer'
import { DynamoDbCustomerClient } from './dynamo-db-customer-client'

/** Stable DynamoDB adapter test instant. */
const NOW = '2026-08-01T00:00:00.000Z'

/** Creates a valid request row for adapter read and retention tests. */
function createRequest(id: string, retentionExpiresAt = '2026-07-01T00:00:00.000Z'): CustomerRequest {
  return createCustomerRequestRecord(
    'workspace-1',
    id,
    {
      customerId: 'customer-1',
      source: { kind: 'email', provider: 'mail', canNotify: true },
      originalMessage: 'Please support SSO.',
      receivedAt: NOW,
      importance: 'normal',
      retentionExpiresAt,
    },
    NOW,
  )
}

/** Creates a persisted row for one Customer entity category. */
function createRequestRow(request: CustomerRequest) {
  return {
    workspaceId: request.workspaceId,
    recordKey: `REQUEST#${request.id}`,
    entityType: 'request',
    request,
  }
}

/** Creates a real DocumentClient whose commands are captured without contacting AWS. */
function createHarness(requestRows: readonly unknown[]) {
  const lowLevelClient = new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const sendSpy = spyOn(documentClient, 'send')
  sendSpy.mockImplementation(async (command) => {
    const constructorValue = Reflect.get(command, 'constructor')
    const input = Reflect.get(command, 'input')
    if (typeof constructorValue !== 'function' || typeof constructorValue.name !== 'string' ||
      typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new TypeError('Expected an AWS DocumentClient command.')
    }
    const name = constructorValue.name
    const normalizedInput = Object.fromEntries(Object.entries(input))
    commands.push({ name, input: normalizedInput })
    if (name === 'QueryCommand') {
      const expression = normalizedInput.KeyConditionExpression
      if (typeof expression !== 'string' || !expression.includes('begins_with(recordKey')) {
        throw new Error('The Customer adapter issued an unscoped partition query.')
      }
      const values = normalizedInput.ExpressionAttributeValues
      const prefix = values && typeof values === 'object' && !Array.isArray(values)
        ? Reflect.get(values, ':recordPrefix')
        : undefined
      return { Items: prefix === 'REQUEST#' ? requestRows : [] }
    }
    if (name === 'GetCommand') {
      return {
        Item: {
          workspaceId: 'workspace-1',
          recordKey: 'META',
          entityType: 'meta',
          revision: 4,
        },
      }
    }
    return {}
  })
  return {
    client: new DynamoDbCustomerClient({
      tableName: 'CustomersTable',
      documentClient,
      bootstrapLocalTable: false,
      now: () => new Date(NOW),
      id: () => 'generated-id',
    }),
    commands,
    restore: () => sendSpy.mockRestore(),
  }
}

test('uses a focused record-prefix query for a Customer Request read', async () => {
  const request = createRequest('request-1', '2027-08-01T00:00:00.000Z')
  const harness = createHarness([createRequestRow(request)])
  try {
    await expect(harness.client.getRequest('workspace-1', request.id)).resolves.toEqual(request)

    const queryCommands = harness.commands.filter((command) => command.name === 'QueryCommand')
    expect(queryCommands).toHaveLength(1)
    expect(harness.commands.map((command) => command.name)).toEqual(['GetCommand', 'QueryCommand'])
    expect(queryCommands[0]?.input).toMatchObject({
      KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
      ExpressionAttributeValues: {
        ':recordPrefix': 'REQUEST#',
      },
    })
  } finally {
    harness.restore()
  }
})

test('splits retention writes into resumable DynamoDB-sized batches', async () => {
  const requestRows = Array.from({ length: 105 }, (_, index) =>
    createRequestRow(createRequest(`request-${index + 1}`)),
  )
  const harness = createHarness(requestRows)
  try {
    await expect(harness.client.redactExpired('workspace-1')).resolves.toMatchObject({
      requestsRedacted: 0,
    })

    const transactions = harness.commands.filter((command) => command.name === 'TransactWriteCommand')
    expect(transactions).toHaveLength(2)
    const transactionSizes = transactions.map((command) => {
      const items = command.input.TransactItems
      return Array.isArray(items) ? items.length : -1
    })
    expect(transactionSizes).toEqual([100, 7])
    expect(transactions[0]?.input.TransactItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({ recordKey: 'META', revision: 5 }),
        }),
      }),
    ]))
    expect(transactions[1]?.input.TransactItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: expect.objectContaining({ recordKey: 'META', revision: 6 }),
        }),
      }),
    ]))
  } finally {
    harness.restore()
  }
})
