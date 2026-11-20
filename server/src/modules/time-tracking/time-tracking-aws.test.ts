import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { describe, expect, test } from 'bun:test'
import type { TimeEntry, TimeEntryHistory } from '@mukuroji/contracts'
import {
  DynamoDbTimeTrackingRepository,
  TimeTrackingService,
  type TimeTrackingIdempotencyPort,
} from './time-tracking'

type CommandWithInput = {
  /** Command input captured by the test transport. */
  input: Record<string, unknown>
}

/** Creates a valid entry fixture for DynamoDB adapter command assertions. */
function createEntry(projectId: string): TimeEntry {
  return {
    schemaVersion: 1,
    id: `entry-${projectId}`,
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    projectId,
    workItemId: 'work-item-1',
    userId: 'member-1',
    startAt: '2026-08-02T09:00:00.000Z',
    endAt: '2026-08-02T10:00:00.000Z',
    durationMinutes: 60,
    billable: true,
    currency: 'USD',
    status: 'draft',
    source: 'manual',
    revision: 1,
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
  }
}

/** Creates the immutable history fixture paired with an entry. */
function createHistory(entry: TimeEntry): TimeEntryHistory {
  return {
    id: 'history-1',
    entryId: entry.id,
    action: 'created',
    actorUserId: entry.userId,
    occurredAt: entry.createdAt,
  }
}

/** Installs a deterministic, network-free command responder on a DocumentClient. */
function createDocumentClient(
  responses: unknown[],
  commands: CommandWithInput[],
): DynamoDBDocumentClient {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  Object.defineProperty(client, 'send', {
    configurable: true,
    value: async (command: CommandWithInput): Promise<unknown> => {
      commands.push(command)
      return responses.shift()
    },
  })
  return client
}

describe('DynamoDbTimeTrackingRepository', () => {
  test('uses the team date index for bounded entry queries', async () => {
    const entry = createEntry('visible-project')
    const commands: CommandWithInput[] = []
    const repository = new DynamoDbTimeTrackingRepository(
      'analytics-table',
      createDocumentClient([{ Items: [entry] }], commands),
    )

    const entries = await repository.listEntries({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      from: '2026-08-02T09:00:00.000Z',
      to: '2026-08-03T00:00:00.000Z',
    })

    expect(entries.map((candidate) => candidate.id)).toEqual([entry.id])
    expect(commands[0]?.input.IndexName).toBe('TimeEntryTeamDateIndex')
    expect(commands[0]?.input.KeyConditionExpression).toBe(
      'teamId = :teamId AND startAt BETWEEN :queryFrom AND :queryTo',
    )
    expect(commands[0]?.input.ExpressionAttributeValues).toEqual({
      ':teamId': 'team-1',
      ':queryFrom': '2026-07-26T09:00:00.000Z',
      ':queryTo': '2026-08-03T00:00:00.000Z',
      ':workspaceId': 'workspace-1',
      ':prefix': 'TIME_ENTRY#team-1#',
      ':from': '2026-08-02T09:00:00.000Z',
    })
    expect(commands[0]?.input.FilterExpression).toBe(
      'workspaceId = :workspaceId AND begins_with(recordKey, :prefix) AND endAt > :from',
    )
  })

  test('continues filtered entry queries and uses the entry/history transaction', async () => {
    const hiddenEntry = createEntry('hidden-project')
    const visibleEntry = createEntry('visible-project')
    const commands: CommandWithInput[] = []
    const repository = new DynamoDbTimeTrackingRepository(
      'analytics-table',
      createDocumentClient([
        {
          Items: [hiddenEntry],
          LastEvaluatedKey: {
            workspaceId: 'workspace-1',
            recordKey: 'TIME_ENTRY#team-1#entry-hidden-project',
          },
        },
        { Items: [visibleEntry] },
        {},
      ], commands),
    )

    const entries = await repository.listEntries({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectIds: new Set(['visible-project']),
      limit: 1,
    })
    expect(entries.map((entry) => entry.id)).toEqual(['entry-visible-project'])
    expect(commands).toHaveLength(2)
    expect(commands[1]?.input.ExclusiveStartKey).toEqual({
      workspaceId: 'workspace-1',
      recordKey: 'TIME_ENTRY#team-1#entry-hidden-project',
    })

    await repository.saveEntryWithHistory(visibleEntry, createHistory(visibleEntry))
    expect(commands).toHaveLength(3)
    expect(commands[2]?.input.TransactItems).toHaveLength(2)
  })

  test('adds one redacted shared audit event to the entry transaction', async () => {
    const commands: CommandWithInput[] = []
    const service = new TimeTrackingService(
      new DynamoDbTimeTrackingRepository(
        'analytics-table',
        createDocumentClient([{ Items: [] }, {}], commands),
      ),
      {
        now: () => new Date('2026-08-02T12:00:00.000Z'),
        createId: (() => {
          let sequence = 0
          return () => `id-${++sequence}`
        })(),
        audit: {
          tableName: 'audit-table',
          retentionDays: 30,
        },
      },
    )

    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:00:00.000Z',
      billable: true,
      currency: 'USD',
      hourlyRateMinor: 4_000,
      source: 'manual',
    }, true)

    // The first command reads the Team's closed months before the entry is written.
    expect(commands[0]?.input.ExpressionAttributeValues).toMatchObject({ ':prefix': 'TIME_CLOSE#team-1#' })
    // The open month is rechecked in the transaction so a close that lands after the read cancels it.
    expect(commands[1]?.input.TransactItems).toHaveLength(4)
    const transactionItems = commands[1]?.input.TransactItems
    expect(Array.isArray(transactionItems)).toBe(true)
    if (!Array.isArray(transactionItems)) throw new Error('Expected transaction items.')
    expect(transactionItems[0]).toEqual({
      ConditionCheck: {
        TableName: 'analytics-table',
        Key: { workspaceId: 'workspace-1', recordKey: 'TIME_CLOSE#team-1#2026-08' },
        ConditionExpression: 'attribute_not_exists(recordKey)',
      },
    })
    expect(JSON.stringify(transactionItems[3])).not.toContain('hourlyRateMinor')
    expect(JSON.stringify(transactionItems[3])).toContain('audit-table')
  })

  test('deletes a draft with a status-guarded condition and its audit event in one transaction', async () => {
    const commands: CommandWithInput[] = []
    const entry = { ...createEntry('project-1'), hourlyRateMinor: 4_000, actualCostMinor: 4_000 }
    const service = new TimeTrackingService(
      new DynamoDbTimeTrackingRepository(
        'analytics-table',
        createDocumentClient([{ Item: { ...entry, recordKey: `TIME_ENTRY#team-1#${entry.id}` } }, { Items: [] }, {}], commands),
      ),
      {
        now: () => new Date('2026-08-02T12:00:00.000Z'),
        createId: () => 'id-1',
        audit: { tableName: 'audit-table', retentionDays: 30 },
      },
    )

    await expect(service.deleteEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      entryId: entry.id,
      actorUserId: 'member-1',
      expectedRevision: 1,
    })).resolves.toEqual({ entryId: entry.id, deleted: true })

    // The closed months are read before the delete, and the entry's open month is rechecked in it.
    expect(commands[1]?.input.ExpressionAttributeValues).toMatchObject({ ':prefix': 'TIME_CLOSE#team-1#' })
    const transactionItems = commands[2]?.input.TransactItems
    if (!Array.isArray(transactionItems)) throw new Error('Expected transaction items.')
    expect(transactionItems.length).toBeGreaterThanOrEqual(3)
    const guardCount = transactionItems.length - 2
    for (const check of transactionItems.slice(0, guardCount)) {
      expect(check).toMatchObject({ ConditionCheck: { ConditionExpression: 'attribute_not_exists(recordKey)' } })
    }
    expect(JSON.stringify(transactionItems.slice(0, guardCount))).toContain('TIME_CLOSE#team-1#2026-08')
    expect(transactionItems[guardCount]).toMatchObject({
      Delete: {
        TableName: 'analytics-table',
        Key: { workspaceId: 'workspace-1', recordKey: `TIME_ENTRY#team-1#${entry.id}` },
        ConditionExpression: 'revision = :expectedRevision AND #status IN (:draft, :rejected)',
      },
    })
    const audit = JSON.stringify(transactionItems[guardCount + 1])
    expect(audit).toContain('audit-table')
    expect(audit).toContain('time-entry.deleted')
    expect(audit).not.toContain('hourlyRateMinor')
  })

  test('refuses a stored entry with neither a Work Item nor a category', async () => {
    const { workItemId: _workItemId, ...entry } = createEntry('project-1')
    const repository = new DynamoDbTimeTrackingRepository(
      'analytics-table',
      createDocumentClient([{ Item: { ...entry, recordKey: `TIME_ENTRY#team-1#${entry.id}` } }], []),
    )

    await expect(repository.getEntry('workspace-1', 'team-1', entry.id)).rejects.toMatchObject({
      code: 'InvalidStoredTimeTrackingRecord',
    })
  })

  test('commits the durable idempotency receipt with the entry transaction', async () => {
    const commands: CommandWithInput[] = []
    let completed = 0
    const idempotency: TimeTrackingIdempotencyPort = {
      async reserveIdempotency() {
        return { status: 'reserved', reservationId: 'reservation-1' }
      },
      async completeIdempotency() {
        completed += 1
      },
      async releaseIdempotency() {},
      async prepareIdempotencyCompletion() {
        return {
          Put: {
            TableName: 'developer-platform-table',
            Item: { idempotency: 'completed' },
          },
        }
      },
    }
    const service = new TimeTrackingService(
      new DynamoDbTimeTrackingRepository(
        'analytics-table',
        createDocumentClient([{ Items: [] }, {}], commands),
      ),
      {
        now: () => new Date('2026-08-02T12:00:00.000Z'),
        createId: () => 'entry-1',
        idempotency,
      },
    )

    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:00:00.000Z',
      billable: false,
      currency: 'USD',
      source: 'manual',
      idempotencyKey: 'entry-1',
    }, false)

    expect(commands[1]?.input.TransactItems).toHaveLength(4)
    expect(JSON.stringify(commands[1]?.input.TransactItems)).toContain('developer-platform-table')
    expect(completed).toBe(0)
  })

  test('writes budget audit events in their state transaction', async () => {
    const commands: CommandWithInput[] = []
    const service = new TimeTrackingService(
      new DynamoDbTimeTrackingRepository(
        'analytics-table',
        createDocumentClient([{}, {}], commands),
      ),
      {
        now: () => new Date('2026-08-02T12:00:00.000Z'),
        createId: (() => {
          let sequence = 0
          return () => `id-${++sequence}`
        })(),
        audit: {
          tableName: 'audit-table',
          retentionDays: 30,
        },
      },
    )

    await service.saveBudget({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      scopeType: 'team',
      scopeId: 'team-1',
      amountMinor: 50_000,
      currency: 'USD',
      expectedRevision: 0,
      updatedBy: 'manager-1',
      idempotencyKey: 'budget-1',
    })

    expect(commands).toHaveLength(2)
    expect(commands[0]?.input.Key).toEqual({
      workspaceId: 'workspace-1',
      recordKey: 'TIME_BUDGET#team#team-1',
    })
    expect(commands[1]?.input.TransactItems).toHaveLength(2)
    expect(JSON.stringify(commands[1]?.input.TransactItems)).toContain('audit-table')
  })

  test('writes timer start and its audit event in one transaction', async () => {
    const commands: CommandWithInput[] = []
    const service = new TimeTrackingService(
      new DynamoDbTimeTrackingRepository(
        'analytics-table',
        createDocumentClient([{}], commands),
      ),
      {
        now: () => new Date('2026-08-02T12:00:00.000Z'),
        createId: () => 'timer-1',
        audit: {
          tableName: 'audit-table',
          retentionDays: 30,
        },
      },
    )

    await service.startTimer({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      billable: true,
      idempotencyKey: 'timer-start-1',
    })

    expect(commands).toHaveLength(1)
    expect(commands[0]?.input.TransactItems).toHaveLength(2)
    expect(JSON.stringify(commands[0]?.input.TransactItems)).toContain('audit-table')
  })

  test('writes a month close and its reopen with audit events in conditional transactions', async () => {
    const commands: CommandWithInput[] = []
    const stored = {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      month: '2026-07',
      timeZone: 'Asia/Tokyo',
      closedBy: 'manager-1',
      closedAt: '2026-08-02T12:00:00.000Z',
      recordKey: 'TIME_CLOSE#team-1#2026-07',
    }
    const service = new TimeTrackingService(
      new DynamoDbTimeTrackingRepository(
        'analytics-table',
        createDocumentClient([{}, { Items: [stored] }, {}], commands),
      ),
      {
        now: () => new Date('2026-08-02T12:00:00.000Z'),
        createId: (() => {
          let sequence = 0
          return () => `id-${++sequence}`
        })(),
        audit: { tableName: 'audit-table', retentionDays: 30 },
      },
    )

    await service.closePeriod({ workspaceId: 'workspace-1', teamId: 'team-1', month: '2026-07', timeZone: 'Asia/Tokyo', actorUserId: 'manager-1' })
    await service.reopenPeriod({ workspaceId: 'workspace-1', teamId: 'team-1', month: '2026-07', actorUserId: 'manager-1', reason: 'Late expense' })

    const closeItems = commands[0]?.input.TransactItems
    if (!Array.isArray(closeItems)) throw new Error('Expected close transaction items.')
    expect(closeItems).toHaveLength(2)
    expect(closeItems[0]).toMatchObject({
      Put: { Item: { recordKey: 'TIME_CLOSE#team-1#2026-07' }, ConditionExpression: 'attribute_not_exists(recordKey)' },
    })
    expect(JSON.stringify(closeItems[1])).toContain('time-period.closed')
    const reopenItems = commands[2]?.input.TransactItems
    if (!Array.isArray(reopenItems)) throw new Error('Expected reopen transaction items.')
    expect(reopenItems[0]).toMatchObject({
      Delete: {
        Key: { workspaceId: 'workspace-1', recordKey: 'TIME_CLOSE#team-1#2026-07' },
        ConditionExpression: 'closedAt = :closedAt',
      },
    })
    expect(JSON.stringify(reopenItems[1])).toContain('time-period.reopened')
    expect(JSON.stringify(reopenItems[1])).toContain('Late expense')
  })

  test('rechecks every month the entry can touch and keeps the close state that was read', async () => {
    const commands: CommandWithInput[] = []
    const julyClose = {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      month: '2026-07',
      timeZone: 'Asia/Tokyo',
      closedBy: 'manager-1',
      closedAt: '2026-08-01T00:00:00.000Z',
      recordKey: 'TIME_CLOSE#team-1#2026-07',
    }
    const service = new TimeTrackingService(
      new DynamoDbTimeTrackingRepository('analytics-table', createDocumentClient([{ Items: [julyClose] }, {}], commands)),
      { now: () => new Date('2026-08-02T12:00:00.000Z'), createId: () => 'entry-1' },
    )

    // Tokyo's July ends at 2026-07-31T15:00Z, so this entry is open, but July is within reach of
    // another timezone and is guarded with the close timestamp that was read.
    await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-01T10:00:00.000Z',
      endAt: '2026-08-01T11:00:00.000Z',
      billable: false,
      currency: 'USD',
      source: 'manual',
    }, false)

    const items = commands[1]?.input.TransactItems
    if (!Array.isArray(items)) throw new Error('Expected transaction items.')
    expect(items.slice(0, 2)).toEqual([
      {
        ConditionCheck: {
          TableName: 'analytics-table',
          Key: { workspaceId: 'workspace-1', recordKey: 'TIME_CLOSE#team-1#2026-07' },
          ConditionExpression: 'closedAt = :closedAt',
          ExpressionAttributeValues: { ':closedAt': '2026-08-01T00:00:00.000Z' },
        },
      },
      {
        ConditionCheck: {
          TableName: 'analytics-table',
          Key: { workspaceId: 'workspace-1', recordKey: 'TIME_CLOSE#team-1#2026-08' },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
    ])
  })

  test('reports a month closed during the write as a closed period', async () => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}))
    let calls = 0
    Object.defineProperty(client, 'send', {
      configurable: true,
      value: async (): Promise<unknown> => {
        calls += 1
        if (calls === 1) return { Items: [] }
        throw Object.assign(new Error('Transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
        })
      },
    })
    const service = new TimeTrackingService(
      new DynamoDbTimeTrackingRepository('analytics-table', client),
      { now: () => new Date('2026-08-02T12:00:00.000Z'), createId: () => 'entry-1' },
    )

    await expect(service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-02T09:00:00.000Z',
      endAt: '2026-08-02T10:00:00.000Z',
      billable: false,
      currency: 'USD',
      source: 'manual',
    }, false)).rejects.toMatchObject({ status: 409, code: 'TimePeriodClosed' })
  })

  test('rejects a stored month close whose payload month differs from its key', async () => {
    const repository = new DynamoDbTimeTrackingRepository('analytics-table', createDocumentClient([{
      Items: [{
        schemaVersion: 1,
        workspaceId: 'workspace-1',
        teamId: 'team-1',
        month: '2026-08',
        timeZone: 'UTC',
        closedBy: 'manager-1',
        closedAt: '2026-08-01T00:00:00.000Z',
        recordKey: 'TIME_CLOSE#team-1#2026-07',
      }],
    }], []))

    await expect(repository.listPeriodCloses('workspace-1', 'team-1'))
      .rejects.toMatchObject({ status: 500, code: 'InvalidStoredTimeTrackingRecord' })
  })
})
