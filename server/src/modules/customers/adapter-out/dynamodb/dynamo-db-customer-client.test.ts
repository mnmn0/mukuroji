import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expect, spyOn, test } from 'bun:test'
import type { CustomerRequest } from '@mukuroji/contracts'
import {
  createCustomerRecord,
  createCustomerRequestRecord,
} from '../../domain/customer'
import { DynamoDbCustomerClient } from './dynamo-db-customer-client'

/** Stable DynamoDB adapter test instant. */
const NOW = '2026-08-01T00:00:00.000Z'

/** Creates a valid request row for adapter read and retention tests. */
function createRequest(
  id: string,
  retentionExpiresAt = '2026-07-01T00:00:00.000Z',
  customerId = 'customer-1',
): CustomerRequest {
  return createCustomerRequestRecord(
    'workspace-1',
    id,
    {
      customerId,
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

/** Creates a persisted row for one Customer root. */
function createCustomerRow() {
  const customer = createCustomerRecord(
    'workspace-1',
    'customer-1',
    {
      name: 'Acme Corporation',
      tier: 'enterprise',
      size: 'enterprise',
      status: 'active',
      health: 'healthy',
    },
    NOW,
  )
  return {
    workspaceId: customer.workspaceId,
    recordKey: `CUSTOMER#${customer.id}`,
    entityType: 'customer',
    customer,
  }
}

/** Optional fault injection for the transactional Customer adapter harness. */
type HarnessOptions = {
  /** Transaction number that should fail once, counted from one. */
  failTransactionAt?: number
}

/** Creates a real DocumentClient whose commands are captured without contacting AWS. */
function createHarness(requestRows: readonly unknown[], options: HarnessOptions = {}) {
  const lowLevelClient = new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })
  const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
  const commands: Array<{ name: string; input: Record<string, unknown> }> = []
  const rows = new Map<string, unknown>([['META', {
    workspaceId: 'workspace-1',
    recordKey: 'META',
    entityType: 'meta',
    revision: 4,
  }]])
  for (const row of requestRows) {
    if (!isRecord(row) || typeof row.recordKey !== 'string') {
      throw new TypeError('The Customer test row is missing a record key.')
    }
    rows.set(row.recordKey, row)
  }
  let transactionCount = 0
  let failedTransaction = false
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
      return {
        Items: typeof prefix === 'string'
          ? [...rows.values()].filter((row) => isRecord(row) && typeof row.recordKey === 'string' && row.recordKey.startsWith(prefix))
          : [],
      }
    }
    if (name === 'GetCommand') {
      const key = normalizedInput.Key
      const recordKey = isRecord(key) && typeof key.recordKey === 'string'
        ? key.recordKey
        : undefined
      return { Item: recordKey ? rows.get(recordKey) : undefined }
    }
    if (name === 'TransactWriteCommand') {
      transactionCount += 1
      if (!failedTransaction && options.failTransactionAt === transactionCount) {
        failedTransaction = true
        throw new Error('Injected Customer transaction failure.')
      }
      const items = normalizedInput.TransactItems
      if (!Array.isArray(items)) throw new TypeError('Customer transaction items are missing.')
      for (const item of items) {
        if (!isRecord(item)) continue
        const put = item.Put
        if (isRecord(put) && isRecord(put.Item) && typeof put.Item.recordKey === 'string') {
          rows.set(put.Item.recordKey, put.Item)
          continue
        }
        const deletion = item.Delete
        const key = isRecord(deletion) ? deletion.Key : undefined
        if (isRecord(key) && typeof key.recordKey === 'string') rows.delete(key.recordKey)
      }
      return {}
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
    rows,
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
      requestsRedacted: 105,
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

test('uses the supplied timestamp for retention evaluation', async () => {
  const request = createRequest('request-1', '2026-07-15T00:00:00.000Z')
  const requestRow = createRequestRow(request)
  const harness = createHarness([requestRow])
  try {
    await expect(harness.client.redactExpired('workspace-1', '2026-07-01T00:00:00.000Z')).resolves.toEqual({
      customersRedacted: 0,
      contactsRedacted: 0,
      requestsRedacted: 0,
    })
    expect(harness.rows.get('REQUEST#request-1')).toEqual(requestRow)
    expect(harness.commands.filter((command) => command.name === 'TransactWriteCommand')).toHaveLength(0)
  } finally {
    harness.restore()
  }
})

test('resumes Customer retention after a later transaction fails', async () => {
  const requestRows = Array.from({ length: 105 }, (_, index) =>
    createRequestRow(createRequest(`request-${index + 1}`)),
  )
  const harness = createHarness(requestRows, { failTransactionAt: 2 })
  try {
    await expect(harness.client.redactExpired('workspace-1')).rejects.toThrow(
      'Injected Customer transaction failure.',
    )
    const pendingMetadata = harness.rows.get('META')
    expect(pendingMetadata).toMatchObject({
      revision: 5,
      retention: {
        evaluatedAt: NOW,
        cursor: 'REQUEST#request-93',
      },
    })

    await expect(harness.client.redactExpired('workspace-1')).resolves.toMatchObject({
      requestsRedacted: 0,
    })
    expect(harness.rows.get('META')).toMatchObject({ revision: 6 })
    expect(harness.rows.get('META')).not.toHaveProperty('retention')
  } finally {
    harness.restore()
  }
})

test('hides and resumes a Customer deletion after a later transaction fails', async () => {
  const requestRows = Array.from({ length: 105 }, (_, index) =>
    createRequestRow(createRequest(`request-${index + 1}`, '2027-08-01T00:00:00.000Z')),
  )
  const harness = createHarness([createCustomerRow(), ...requestRows], { failTransactionAt: 2 })
  try {
    const customer = createCustomerRow().customer
    await expect(harness.client.deleteCustomer(
      'workspace-1',
      customer.id,
      'member-1',
      customer.revision,
    )).rejects.toThrow('Injected Customer transaction failure.')

    expect(harness.rows.get('META')).toMatchObject({
      revision: 5,
      deletion: { customerId: customer.id },
    })
    expect(harness.rows.has(`CUSTOMER#${customer.id}`)).toBeTrue()

    await expect(harness.client.getCustomer('workspace-1', customer.id)).rejects.toMatchObject({
      code: 'CustomerNotFound',
    })
    expect(harness.rows.get('META')).not.toHaveProperty('deletion')
    expect(harness.rows.has(`CUSTOMER#${customer.id}`)).toBeFalse()
  } finally {
    harness.restore()
  }
})

test('does not mix unrelated retention writes into a Customer deletion', async () => {
  const ownRequest = createRequestRow(createRequest(
    'request-1',
    '2027-08-01T00:00:00.000Z',
  ))
  const unrelatedExpiredRequest = createRequestRow(createRequest(
    'request-unrelated',
    '2026-07-01T00:00:00.000Z',
    'customer-2',
  ))
  const harness = createHarness([createCustomerRow(), ownRequest, unrelatedExpiredRequest])
  try {
    await expect(harness.client.deleteCustomer(
      'workspace-1',
      'customer-1',
      'member-1',
      1,
    )).resolves.toBeUndefined()

    const transactions = harness.commands.filter((command) => command.name === 'TransactWriteCommand')
    expect(transactions).toHaveLength(1)
    expect(harness.rows.get('REQUEST#request-unrelated')).toEqual(unrelatedExpiredRequest)
  } finally {
    harness.restore()
  }
})

/** Checks whether an unknown harness value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
