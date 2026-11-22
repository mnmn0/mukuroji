import { describe, expect, test } from 'bun:test'
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  allocateWorkItemKey,
  createWorkItemKeyReservationPut,
  isWorkItemKeyRegistryRecord,
  listWorkItemKeyPrefixes,
  readWorkItemKeyLocation,
} from './work-item-key-registry'

const TABLE = 'WorkItemsTable'
const NOW = '2026-11-16T00:00:00.000Z'

/** One stored row of the in-memory table. */
type Row = Record<string, unknown>

/**
 * Creates an in-memory stand-in for the Work Items table that applies the registry's conditions
 * the way DynamoDB does, yielding before each command so concurrent calls interleave.
 *
 * @returns The fake client and its rows by `directoryTeamId` and `issueId`.
 */
function createRegistryTable() {
  const rows = new Map<string, Row>()
  const id = (key: unknown) =>
    `${String(Reflect.get(Object(key), 'directoryTeamId'))}\0${String(Reflect.get(Object(key), 'issueId'))}`
  const conditionalFailure = () => Object.assign(new Error('The conditional request failed.'), {
    name: 'ConditionalCheckFailedException',
  })
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      await Promise.resolve()
      const { input } = command
      if (command.constructor.name === 'GetCommand') {
        const row = rows.get(id(input.Key))
        return row ? { Item: structuredClone(row) } : {}
      }
      if (command.constructor.name === 'UpdateCommand') {
        const row = rows.get(id(input.Key))
        const values = Object(input.ExpressionAttributeValues)
        if (
          !row || row.entryType !== values[':counter'] ||
          typeof row.lastNumber !== 'number' || row.lastNumber >= values[':maxNumber']
        ) {
          throw conditionalFailure()
        }
        row.lastNumber += 1
        row.lastAllocatedAt = values[':now']
        return { Attributes: structuredClone(row) }
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const items: Array<{ Put: { Item: Row } }> = Object(input).TransactItems
        const reasons = items.map(({ Put }) => ({
          Code: rows.has(id(Put.Item)) ? 'ConditionalCheckFailed' : 'None',
        }))
        if (reasons.some((reason) => reason.Code !== 'None')) {
          throw Object.assign(new Error('Transaction cancelled.'), {
            name: 'TransactionCanceledException',
            CancellationReasons: reasons,
          })
        }
        for (const { Put } of items) rows.set(id(Put.Item), structuredClone(Put.Item))
        return {}
      }
      if (command.constructor.name === 'QueryCommand') {
        // Pages of one row exercise the continuation loop.
        const values = Object(input.ExpressionAttributeValues)
        const matches = [...rows.values()]
          .filter((row) => row.directoryTeamId === values[':partition'] &&
            String(row.issueId).startsWith(String(values[':prefix'])))
          .sort((left, right) => String(left.issueId).localeCompare(String(right.issueId)))
        const after = input.ExclusiveStartKey === undefined ? undefined : String(Object(input.ExclusiveStartKey).issueId)
        const remaining = matches.filter((row) => after === undefined || String(row.issueId) > after)
        const page = remaining.slice(0, 1)
        return {
          Items: page.map((row) => structuredClone(row)),
          ...(remaining.length > 1 ? { LastEvaluatedKey: { directoryTeamId: page[0]?.directoryTeamId, issueId: page[0]?.issueId } } : {}),
        }
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    },
  }
  // The fake implements only the commands the registry sends.
  return { client: client as unknown as DynamoDBDocumentClient, rows }
}

describe('Work Item key allocation', () => {
  test('reserves the Team prefix on first use and numbers keys from 1', async () => {
    const table = createRegistryTable()

    const first = await allocateWorkItemKey(table.client, TABLE, 'ws', 'platform-team', NOW)
    const second = await allocateWorkItemKey(table.client, TABLE, 'ws', 'platform-team', NOW)

    expect(first.key).toBe('PT-1')
    expect(second.key).toBe('PT-2')
    expect(table.rows.get('ws#work-item-key-registry\0prefix#PT')).toMatchObject({
      entryType: 'work-item-key-prefix',
      teamId: 'platform-team',
    })
    for (const row of table.rows.values()) {
      expect(isWorkItemKeyRegistryRecord(row)).toBe(true)
      // Registry rows must stay out of the Work Item indexes.
      expect(row.sortOrder).toBeUndefined()
      expect(row.updatedAt).toBeUndefined()
    }
  })

  test('never hands out the same key to concurrent creates, including the first ones', async () => {
    const table = createRegistryTable()

    const keys = await Promise.all(Array.from({ length: 25 }, () =>
      allocateWorkItemKey(table.client, TABLE, 'ws', 'backend', NOW)
    ))

    expect(new Set(keys.map((key) => key.key)).size).toBe(25)
    expect(keys.map((key) => key.number).sort((left, right) => left - right))
      .toEqual(Array.from({ length: 25 }, (_, index) => index + 1))
  })

  test('gives a Team the next free prefix when another Team holds the derived one', async () => {
    const table = createRegistryTable()

    const [platform, product] = await Promise.all([
      allocateWorkItemKey(table.client, TABLE, 'ws', 'platform-team', NOW),
      allocateWorkItemKey(table.client, TABLE, 'ws', 'product-team', NOW),
    ])

    expect(new Set([platform.prefix, product.prefix])).toEqual(new Set(['PT', 'PT2']))
  })

  test('finds a free prefix for many Teams that derive the same one', async () => {
    const table = createRegistryTable()
    const teamIds = Array.from({ length: 30 }, (_, index) => `team-${index.toString(16).padStart(12, '0')}`)

    const keys = []
    for (const teamId of teamIds) keys.push(await allocateWorkItemKey(table.client, TABLE, 'ws', teamId, NOW))

    expect(new Set(keys.map((key) => key.prefix)).size).toBe(30)
    expect(keys.slice(0, 10).map((key) => key.prefix)).toEqual(
      ['TEAM', ...Array.from({ length: 9 }, (_, index) => `TEAM${index + 2}`)],
    )
    for (const key of keys.slice(10)) expect(key.prefix).toMatch(/^TEAM[0-9A-F]{4}$/u)
  })

  test('reads the counter again when a concurrent first create conflicts with its transaction', async () => {
    const table = createRegistryTable()
    let conflicted = false
    const client = {
      async send(command: { constructor: { name: string } }) {
        if (command.constructor.name === 'TransactWriteCommand' && !conflicted) {
          conflicted = true
          // Simulates the other create committing the same rows while this one is cancelled.
          await allocateWorkItemKey(table.client, TABLE, 'ws', 'backend', NOW)
          throw Object.assign(new Error('Transaction cancelled.'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
          })
        }
        return await table.client.send(command as never)
      },
    } as unknown as DynamoDBDocumentClient

    const key = await allocateWorkItemKey(client, TABLE, 'ws', 'backend', NOW)

    expect(key.key).toBe('BACK-2')
  })

  test('keeps prefixes and numbers separate per Workspace', async () => {
    const table = createRegistryTable()

    const one = await allocateWorkItemKey(table.client, TABLE, 'ws-1', 'backend', NOW)
    const two = await allocateWorkItemKey(table.client, TABLE, 'ws-2', 'backend', NOW)

    expect([one.key, two.key]).toEqual(['BACK-1', 'BACK-1'])
  })

  test('stops when the Team has used every number', async () => {
    const table = createRegistryTable()
    await allocateWorkItemKey(table.client, TABLE, 'ws', 'backend', NOW)
    const counter = table.rows.get('ws#work-item-key-registry\0team#backend')
    if (!counter) throw new Error('The counter row was not created.')
    counter.lastNumber = 999_999_999

    await expect(allocateWorkItemKey(table.client, TABLE, 'ws', 'backend', NOW))
      .rejects.toMatchObject({ status: 409, code: 'WorkItemKeySequenceExhausted' })
  })

  test('fails closed on a malformed counter row', async () => {
    const table = createRegistryTable()
    table.rows.set('ws#work-item-key-registry\0team#backend', {
      directoryTeamId: 'ws#work-item-key-registry',
      issueId: 'team#backend',
      entryType: 'work-item-key-counter',
      directoryId: 'ws',
      teamId: 'backend',
      keyPrefix: 'bad prefix',
      lastNumber: 1,
      registeredAt: NOW,
    })

    await expect(allocateWorkItemKey(table.client, TABLE, 'ws', 'backend', NOW))
      .rejects.toMatchObject({ status: 503, code: 'InvalidWorkItemKeyRegistry' })
  })
})

describe('Work Item key prefix listing', () => {
  test('lists every reserved prefix of the Workspace with its Team', async () => {
    const table = createRegistryTable()
    await allocateWorkItemKey(table.client, TABLE, 'ws', 'platform-team', NOW)
    await allocateWorkItemKey(table.client, TABLE, 'ws', 'product-team', NOW)
    await allocateWorkItemKey(table.client, TABLE, 'ws', 'backend', NOW)
    await allocateWorkItemKey(table.client, TABLE, 'other-ws', 'design', NOW)

    expect(await listWorkItemKeyPrefixes(table.client, TABLE, 'ws')).toEqual([
      { keyPrefix: 'BACK', teamId: 'backend' },
      { keyPrefix: 'PT', teamId: 'platform-team' },
      { keyPrefix: 'PT2', teamId: 'product-team' },
    ])
  })

  test('fails closed on a malformed prefix row', async () => {
    const table = createRegistryTable()
    await allocateWorkItemKey(table.client, TABLE, 'ws', 'platform-team', NOW)
    const row = table.rows.get('ws#work-item-key-registry\0prefix#PT')
    if (row) row.keyPrefix = 'pt'

    await expect(listWorkItemKeyPrefixes(table.client, TABLE, 'ws')).rejects.toMatchObject({
      code: 'InvalidWorkItemKeyRegistry',
    })
  })
})

describe('Work Item key lookup', () => {
  test('reads where a recorded key points and reports unknown keys as absent', async () => {
    const table = createRegistryTable()
    const reservation = createWorkItemKeyReservationPut(
      TABLE,
      'ws',
      { key: 'BACK-7', teamId: 'backend', workItemId: 'back-7' },
      NOW,
    )
    await table.client.send(new TransactWriteCommand({ TransactItems: [reservation] }))

    expect(await readWorkItemKeyLocation(table.client, TABLE, 'ws', 'BACK-7'))
      .toEqual({ key: 'BACK-7', teamId: 'backend', workItemId: 'back-7' })
    expect(await readWorkItemKeyLocation(table.client, TABLE, 'ws', 'BACK-8')).toBeUndefined()
    expect(await readWorkItemKeyLocation(table.client, TABLE, 'other-ws', 'BACK-7')).toBeUndefined()
  })

  test('recognizes only well-formed registry rows', () => {
    const reservation = createWorkItemKeyReservationPut(
      TABLE,
      'ws',
      { key: 'BACK-7', teamId: 'backend', workItemId: 'back-7' },
      NOW,
    )
    const row = reservation.Put?.Item

    expect(isWorkItemKeyRegistryRecord(row)).toBe(true)
    expect(isWorkItemKeyRegistryRecord({ ...row, key: 'back-7' })).toBe(false)
    expect(isWorkItemKeyRegistryRecord({ ...row, directoryTeamId: 'ws#team#backend' })).toBe(false)
    expect(isWorkItemKeyRegistryRecord({ ...row, sortOrder: 10 })).toBe(false)
    expect(isWorkItemKeyRegistryRecord({ ...row, entryType: 'something-else' })).toBe(false)
    expect(isWorkItemKeyRegistryRecord({ ...row, registeredAt: 'invalid' })).toBe(false)
    expect(isWorkItemKeyRegistryRecord({ ...row, registeredAt: '2026-11-16T00:00:00Z' })).toBe(false)
  })

  test('rejects a counter row whose last allocation time is not a canonical timestamp', async () => {
    const table = createRegistryTable()
    await allocateWorkItemKey(table.client, TABLE, 'ws', 'backend', NOW)
    const counter = table.rows.get('ws#work-item-key-registry\0team#backend')
    expect(isWorkItemKeyRegistryRecord(counter)).toBe(true)
    expect(isWorkItemKeyRegistryRecord({ ...counter, lastAllocatedAt: 'invalid' })).toBe(false)
  })
})
