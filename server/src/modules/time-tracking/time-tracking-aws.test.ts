import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { describe, expect, test } from 'bun:test'
import type { TimeEntry, TimeEntryHistory } from '@mukuroji/contracts'
import { DynamoDbTimeTrackingRepository, TimeTrackingService } from './time-tracking'

type CommandWithInput = {
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
        createDocumentClient([{}], commands),
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

    expect(commands[0]?.input.TransactItems).toHaveLength(3)
    const transactionItems = commands[0]?.input.TransactItems
    expect(Array.isArray(transactionItems)).toBe(true)
    if (!Array.isArray(transactionItems)) throw new Error('Expected transaction items.')
    expect(JSON.stringify(transactionItems[2])).not.toContain('hourlyRateMinor')
    expect(JSON.stringify(transactionItems[2])).toContain('audit-table')
  })

  test('writes estimate and budget audit events in their state transactions', async () => {
    const commands: CommandWithInput[] = []
    const service = new TimeTrackingService(
      new DynamoDbTimeTrackingRepository(
        'analytics-table',
        createDocumentClient([{}, {}, {}, {}], commands),
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

    await service.saveEstimate({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      estimateMinutes: 120,
      updatedBy: 'manager-1',
      idempotencyKey: 'estimate-1',
    })
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

    expect(commands).toHaveLength(4)
    expect(commands[1]?.input.TransactItems).toHaveLength(2)
    expect(commands[2]?.input.Key).toEqual({
      workspaceId: 'workspace-1',
      recordKey: 'TIME_BUDGET#team#team-1',
    })
    expect(commands[3]?.input.TransactItems).toHaveLength(2)
    expect(JSON.stringify(commands[1]?.input.TransactItems)).toContain('audit-table')
    expect(JSON.stringify(commands[3]?.input.TransactItems)).toContain('audit-table')
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
})
