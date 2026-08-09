import { describe, expect, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  DynamoDbFocusStateClient,
  InMemoryFocusStateClient,
} from './focus-state'

const workspaceId = 'workspace-focus'
const memberKey = 'member@example.com'

/** Creates a stable mutation clock offset by the supplied minutes. */
function mutationTime(minutes: number): Date {
  return new Date(Date.parse('2026-08-09T00:00:00.000Z') + minutes * 60_000)
}

describe('InMemoryFocusStateClient', () => {
  test('isolates personal state while returning only requested Team policies', async () => {
    const client = new InMemoryFocusStateClient()
    await client.savePolicy({
      workspaceId,
      memberKey,
      update: {
        target: { type: 'user' },
        expectedVersion: 0,
        overrides: { dueSoonDays: 2 },
      },
      now: mutationTime(0),
    })
    await client.savePolicy({
      workspaceId,
      memberKey,
      update: {
        target: { type: 'team', teamId: 'core-team' },
        expectedVersion: 0,
        overrides: { weights: { blocker: 140 } },
      },
      now: mutationTime(1),
    })
    await client.savePolicy({
      workspaceId,
      memberKey,
      update: {
        target: { type: 'team', teamId: 'hidden-team' },
        expectedVersion: 0,
        overrides: { weights: { blocker: 999 } },
      },
      now: mutationTime(2),
    })

    const state = await client.getState({
      workspaceId,
      memberKey: memberKey.toUpperCase(),
      teamIds: ['core-team'],
    })

    expect(state.userPolicy).toMatchObject({
      target: { type: 'user' },
      version: 1,
      overrides: { dueSoonDays: 2 },
    })
    expect(state.teamPolicies).toEqual([
      expect.objectContaining({
        target: { type: 'team', teamId: 'core-team' },
        version: 1,
      }),
    ])
  })

  test('rejects a stale policy version without changing the stored layer', async () => {
    const client = new InMemoryFocusStateClient()
    await client.savePolicy({
      workspaceId,
      memberKey,
      update: {
        target: { type: 'user' },
        expectedVersion: 0,
        overrides: { nowScoreThreshold: 80 },
      },
      now: mutationTime(0),
    })

    await expect(client.savePolicy({
      workspaceId,
      memberKey,
      update: {
        target: { type: 'user' },
        expectedVersion: 0,
        overrides: { nowScoreThreshold: 1 },
      },
      now: mutationTime(1),
    })).rejects.toMatchObject({
      code: 'FocusStateConflict',
      status: 409,
    })
    expect((await client.getState({
      workspaceId,
      memberKey,
      teamIds: [],
    })).userPolicy?.overrides.nowScoreThreshold).toBe(80)
  })

  test('rejects policy and snooze versions that cannot be incremented safely', async () => {
    const client = new InMemoryFocusStateClient()

    await expect(client.savePolicy({
      workspaceId,
      memberKey,
      update: {
        target: { type: 'user' },
        expectedVersion: Number.MAX_SAFE_INTEGER,
        overrides: { dueSoonDays: 2 },
      },
      now: mutationTime(0),
    })).rejects.toMatchObject({
      code: 'FocusStateVersionExhausted',
      status: 409,
    })
    await expect(client.saveSnooze({
      workspaceId,
      memberKey,
      teamId: 'core-team',
      workItemId: 'issue-1',
      expectedVersion: Number.MAX_SAFE_INTEGER,
      causeFingerprint: 'cause-v1',
      snoozedUntil: '2026-08-10T00:00:00.000Z',
      now: mutationTime(0),
    })).rejects.toMatchObject({
      code: 'FocusStateVersionExhausted',
      status: 409,
    })
  })

  test('retains a monotonic tombstone across snooze and unsnooze', async () => {
    const client = new InMemoryFocusStateClient()
    const snoozed = await client.saveSnooze({
      workspaceId,
      memberKey,
      teamId: 'core-team',
      workItemId: 'issue-1',
      expectedVersion: 0,
      causeFingerprint: 'cause-v1',
      snoozedUntil: '2026-08-10T00:00:00.000Z',
      now: mutationTime(0),
    })
    expect(snoozed).toMatchObject({
      version: 1,
      causeFingerprint: 'cause-v1',
      snoozedUntil: '2026-08-10T00:00:00.000Z',
    })

    const unsnoozed = await client.saveSnooze({
      workspaceId,
      memberKey,
      teamId: 'core-team',
      workItemId: 'issue-1',
      expectedVersion: 1,
      causeFingerprint: 'cause-v1',
      snoozedUntil: null,
      now: mutationTime(2),
    })
    expect(unsnoozed.version).toBe(2)
    expect(unsnoozed.snoozedUntil).toBeUndefined()
    expect((await client.getState({
      workspaceId,
      memberKey,
      teamIds: ['core-team'],
    })).snoozes).toEqual([unsnoozed])
  })

  test('rejects a wake time that is not in the future', async () => {
    const client = new InMemoryFocusStateClient()
    await expect(client.saveSnooze({
      workspaceId,
      memberKey,
      teamId: 'core-team',
      workItemId: 'issue-1',
      expectedVersion: 0,
      causeFingerprint: 'cause-v1',
      snoozedUntil: '2026-08-08T00:00:00.000Z',
      now: mutationTime(0),
    })).rejects.toMatchObject({
      code: 'InvalidFocusSnoozeTime',
      status: 400,
    })
  })

  test('rejects a wake time more than 365 days in the future', async () => {
    const client = new InMemoryFocusStateClient()
    const now = mutationTime(0)
    await expect(client.saveSnooze({
      workspaceId,
      memberKey,
      teamId: 'core-team',
      workItemId: 'issue-1',
      expectedVersion: 0,
      causeFingerprint: 'cause-v1',
      snoozedUntil: new Date(
        now.getTime() + 365 * 24 * 60 * 60 * 1_000 + 1,
      ).toISOString(),
      now,
    })).rejects.toMatchObject({
      code: 'InvalidFocusSnoozeTime',
      status: 400,
    })
  })
})

describe('DynamoDbFocusStateClient', () => {
  test('encodes scope keys and writes version-checked state with bounded TTLs', async () => {
    const requests: Record<string, unknown>[] = []
    const lowLevelClient = new DynamoDBClient({
      credentials: {
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      },
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          requests.push(readJsonRequestBody(request))
          return {
            response: {
              body: new TextEncoder().encode('{}'),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(lowLevelClient, {
      marshallOptions: { removeUndefinedValues: true },
    })
    const client = new DynamoDbFocusStateClient(
      'focus-table',
      documentClient,
      lowLevelClient,
      false,
    )
    const encodedWorkspacePrefix = 'WORKSPACE#workspace%2Fone%23peer#'
    const snoozedUntil = '2026-08-10T00:00:00.000Z'
    const unsnoozedAt = mutationTime(4)

    try {
      await client.savePolicy({
        workspaceId: 'workspace/one#peer',
        memberKey,
        update: {
          target: { type: 'user' },
          expectedVersion: 0,
          overrides: { dueSoonDays: 2 },
        },
        now: mutationTime(0),
      })
      await client.savePolicy({
        workspaceId: 'workspace/one#peer',
        memberKey,
        update: {
          target: { type: 'team', teamId: 'core-team' },
          expectedVersion: 0,
          overrides: { dueSoonDays: 3 },
        },
        now: mutationTime(1),
      })
      await client.saveSnooze({
        workspaceId: 'workspace/one#peer',
        memberKey,
        teamId: 'core-team',
        workItemId: 'issue-1',
        expectedVersion: 0,
        causeFingerprint: 'focus-cause-v1',
        snoozedUntil,
        now: mutationTime(2),
      })
      await client.savePolicy({
        workspaceId: 'workspace/one#peer',
        memberKey,
        update: {
          target: { type: 'user' },
          expectedVersion: 1,
          overrides: { dueSoonDays: 4 },
        },
        now: mutationTime(3),
      })
      await client.saveSnooze({
        workspaceId: 'workspace/one#peer',
        memberKey,
        teamId: 'core-team',
        workItemId: 'issue-1',
        expectedVersion: 1,
        causeFingerprint: 'focus-cause-v1',
        snoozedUntil: null,
        now: unsnoozedAt,
      })

      expect(requests).toHaveLength(5)
      expect(requests[0]).toMatchObject({
        ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        Item: {
          scopeKey: { S: `${encodedWorkspacePrefix}USER#${memberKey}` },
        },
        TableName: 'focus-table',
      })
      expect(requests[1]).toMatchObject({
        ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        Item: {
          scopeKey: { S: `${encodedWorkspacePrefix}TEAM#core-team` },
        },
        TableName: 'focus-table',
      })
      expect(requests[2]).toMatchObject({
        ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        Item: {
          expiresAt: { N: createRetentionExpiry(snoozedUntil) },
          scopeKey: { S: `${encodedWorkspacePrefix}USER#${memberKey}` },
        },
        TableName: 'focus-table',
      })
      expect(requests[3]).toMatchObject({
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': { N: '1' } },
        Item: {
          scopeKey: { S: `${encodedWorkspacePrefix}USER#${memberKey}` },
          version: { N: '2' },
        },
      })
      expect(requests[4]).toMatchObject({
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': { N: '1' } },
        Item: {
          expiresAt: { N: createRetentionExpiry(unsnoozedAt.toISOString()) },
          scopeKey: { S: `${encodedWorkspacePrefix}USER#${memberKey}` },
          version: { N: '2' },
        },
      })
      expect(requests[4]).not.toHaveProperty('Item.snoozedUntil')
    } finally {
      documentClient.destroy()
      lowLevelClient.destroy()
    }
  })

  test('fails closed after four recipient snooze Query pages', async () => {
    const requests: Record<string, unknown>[] = []
    let queryReads = 0
    const lowLevelClient = new DynamoDBClient({
      credentials: {
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      },
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          const body = readJsonRequestBody(request)
          requests.push(body)
          const responseBody = 'KeyConditionExpression' in body
            ? createPaginatedSnoozeResponse(++queryReads)
            : {}
          return {
            response: {
              body: new TextEncoder().encode(JSON.stringify(responseBody)),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
    const client = new DynamoDbFocusStateClient(
      'focus-table',
      documentClient,
      lowLevelClient,
      false,
    )

    try {
      await expect(client.getState({
        workspaceId,
        memberKey,
        teamIds: [],
      })).rejects.toMatchObject({
        code: 'FocusStateReadLimitExceeded',
        status: 503,
      })
      expect(queryReads).toBe(4)
      expect(requests.filter((request) =>
        'KeyConditionExpression' in request
      )).toEqual(Array.from({ length: 4 }, () =>
        expect.objectContaining({ Limit: 250 })
      ))
    } finally {
      documentClient.destroy()
      lowLevelClient.destroy()
    }
  })

  test('fails closed when a recipient snooze Query cursor stops advancing', async () => {
    const requests: Record<string, unknown>[] = []
    let queryReads = 0
    const lowLevelClient = new DynamoDBClient({
      credentials: {
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      },
      region: 'ap-northeast-1',
      requestHandler: {
        async handle(request: unknown) {
          const body = readJsonRequestBody(request)
          requests.push(body)
          const isQuery = 'KeyConditionExpression' in body
          if (isQuery) queryReads += 1
          const responseBody = isQuery
            ? createPaginatedSnoozeResponse(1)
            : {}
          return {
            response: {
              body: new TextEncoder().encode(JSON.stringify(responseBody)),
              headers: {},
              statusCode: 200,
            },
          }
        },
      },
    })
    const documentClient = DynamoDBDocumentClient.from(lowLevelClient)
    const client = new DynamoDbFocusStateClient(
      'focus-table',
      documentClient,
      lowLevelClient,
      false,
    )

    try {
      await expect(client.getState({
        workspaceId,
        memberKey,
        teamIds: [],
      })).rejects.toMatchObject({
        code: 'FocusStateCursorStalled',
        status: 503,
      })
      const queries = requests.filter((request) =>
        'KeyConditionExpression' in request
      )
      expect(queryReads).toBe(2)
      expect(queries).toHaveLength(2)
      expect(queries[1]).toMatchObject({
        ExclusiveStartKey: {
          recordKey: { S: 'SNOOZE#core-team#issue-1' },
          scopeKey: { S: `WORKSPACE#${workspaceId}#USER#${memberKey}` },
        },
        Limit: 250,
      })
    } finally {
      documentClient.destroy()
      lowLevelClient.destroy()
    }
  })
})

/** Creates the expected epoch-second TTL retained for 90 days after one timestamp. */
function createRetentionExpiry(timestamp: string): string {
  return String(Math.floor(Date.parse(timestamp) / 1_000) + 90 * 24 * 60 * 60)
}

/** Creates one valid low-level DynamoDB snooze page with a continuing cursor. */
function createPaginatedSnoozeResponse(page: number): Record<string, unknown> {
  const scopeKey = `WORKSPACE#${workspaceId}#USER#${memberKey}`
  const recordKey = `SNOOZE#core-team#issue-${page}`
  return {
    Items: [{
      scopeKey: { S: scopeKey },
      recordKey: { S: recordKey },
      entryType: { S: 'snooze' },
      version: { N: '1' },
      teamId: { S: 'core-team' },
      workItemId: { S: `issue-${page}` },
      causeFingerprint: { S: `cause-${page}` },
      updatedAt: { S: mutationTime(page).toISOString() },
    }],
    LastEvaluatedKey: {
      scopeKey: { S: scopeKey },
      recordKey: { S: recordKey },
    },
  }
}

/** Reads one AWS SDK HTTP request body as a JSON object. */
function readJsonRequestBody(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) throw new TypeError('Expected an AWS SDK request object.')
  const body = Reflect.get(request, 'body')
  const text = typeof body === 'string'
    ? body
    : body instanceof Uint8Array
      ? new TextDecoder().decode(body)
      : undefined
  if (text === undefined) throw new TypeError('Expected an AWS SDK request body.')
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new TypeError('Expected an AWS SDK JSON request body.')
  return parsed
}

/** Returns whether an unknown value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
