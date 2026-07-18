import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  processWebhookAuthorizationBackfillPage,
  startWebhookAuthorizationBackfill,
} from './webhook-authorization-backfill-handler'

test('resumes pagewise, waits for the GSI, and skips archived member grants', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  for (const row of [
    {
      directoryId: 'workspace-1',
      entryKey: 'TEAM#active',
      entryType: 'team',
      teamId: 'team-1',
    },
    {
      directoryId: 'workspace-1',
      entryKey: 'TEAM#archived',
      entryType: 'team',
      teamId: 'team-2',
      archivedAt: '2026-07-18T00:00:00.000Z',
    },
    {
      directoryId: 'workspace-1',
      entryKey: 'PROJECT#active',
      entryType: 'project',
      teamId: 'team-1',
      projectId: 'project-1',
    },
    {
      directoryId: 'workspace-1',
      entryKey: 'PROJECT#archived-team',
      entryType: 'project',
      teamId: 'team-2',
      projectId: 'project-1',
    },
    {
      directoryId: 'workspace-1',
      entryKey: 'PROJECT_MEMBER#project-1#creator-1',
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'creator-1',
      role: 'viewer',
    },
    {
      directoryId: 'workspace-1',
      entryKey: 'PROJECT_MEMBER#project-1#archived-creator',
      entryType: 'project-member',
      projectId: 'project-1',
      memberKey: 'archived-creator',
      role: 'manager',
      archivedAt: '2026-07-18T00:00:00.000Z',
    },
  ]) {
    rows.set(createKey(row), row)
  }
  const fake = createDocumentClient(rows, 2)

  await startWebhookAuthorizationBackfill(fake.client, 'ProjectDirectory')
  await startWebhookAuthorizationBackfill(fake.client, 'ProjectDirectory')

  fake.failNextCheckpointWrite()
  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
  )).rejects.toThrow('interrupted after page writes')

  let progress = await processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
  )
  while (progress.checkpoint.phase === 'projection') {
    progress = await processWebhookAuthorizationBackfillPage(
      fake.client,
      'ProjectDirectory',
    )
  }
  expect(progress.checkpoint.phase).toBe('verification')

  const revisionBeforeGsiRetry = progress.checkpoint.revision
  progress = await processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
  )
  expect(progress.checkpoint.revision).toBe(revisionBeforeGsiRetry)
  expect(progress.checkpoint.phase).toBe('verification')

  fake.flushGsi()
  for (let attempt = 0; attempt < 30 && !progress.isComplete; attempt += 1) {
    progress = await processWebhookAuthorizationBackfillPage(
      fake.client,
      'ProjectDirectory',
    )
  }
  expect(progress.isComplete).toBe(true)
  expect(progress.checkpoint).toMatchObject({
    phase: 'complete',
    sourceRowsUpdated: 6,
    sourceRowsVerified: 6,
    grantsWritten: 1,
  })
  expect(fake.scanCalls()).toBeGreaterThan(6)
  expect(fake.updateCalls()).toBeGreaterThan(6)

  expect(rows.get('workspace-1\0TEAM#active')).toMatchObject({
    webhookAuthorizationKey: 'WEBHOOK_ACL#RESOURCE#workspace-1',
    webhookAuthorizationSortKey: 'TEAM#team-1',
  })
  expect(rows.get('workspace-1\0PROJECT#active')).toMatchObject({
    webhookAuthorizationKey: 'WEBHOOK_ACL#RESOURCE#workspace-1',
    webhookAuthorizationSortKey: 'PROJECT#project-1',
  })
  expect(rows.get(
    'workspace-1\0PROJECT_MEMBER#project-1#creator-1',
  )).toMatchObject({
    webhookAuthorizationKey: 'WEBHOOK_ACL#MEMBER#workspace-1#creator-1',
    webhookAuthorizationSortKey: 'PROJECT#project-1',
  })
  expect([...rows.values()].filter((row) =>
    row.entryType === 'webhook-team-grant'
  )).toEqual([
    expect.objectContaining({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      memberKey: 'creator-1',
      sourceEntryKey: 'PROJECT_MEMBER#project-1#creator-1',
      teamSourceEntryKey: 'TEAM#active',
      projectSourceEntryKey: 'PROJECT#active',
      webhookAuthorizationKey:
        'WEBHOOK_ACL#TEAM_MEMBER#workspace-1#team-1#creator-1',
    }),
  ])

  const scansAtCompletion = fake.scanCalls()
  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
  )).resolves.toMatchObject({ isComplete: true })
  expect(fake.scanCalls()).toBe(scansAtCompletion)
})

function createDocumentClient(
  rows: Map<string, Record<string, unknown>>,
  pageSize: number,
) {
  const visibleGsiKeys = new Set<string>()
  let checkpointWriteFailure = false
  let scans = 0
  let updates = 0
  const client = {
    async send(command: {
      constructor: { name: string }
      input: Record<string, unknown>
    }) {
      if (command.constructor.name === 'ScanCommand') {
        scans += 1
        const values = [...rows.values()].sort(compareRows)
        const startKey = command.input.ExclusiveStartKey as {
          directoryId?: string
          entryKey?: string
        } | undefined
        const startIndex = startKey
          ? values.findIndex((row) =>
              row.directoryId === startKey.directoryId &&
              row.entryKey === startKey.entryKey
            ) + 1
          : 0
        const page = values.slice(startIndex, startIndex + pageSize)
        return {
          Items: page,
          ...(startIndex + page.length < values.length && page.at(-1)
            ? {
                LastEvaluatedKey: {
                  directoryId: page.at(-1)!.directoryId,
                  entryKey: page.at(-1)!.entryKey,
                },
              }
            : {}),
        }
      }
      if (command.constructor.name === 'GetCommand') {
        const key = command.input.Key as {
          directoryId: string
          entryKey: string
        }
        return { Item: rows.get(`${key.directoryId}\0${key.entryKey}`) }
      }
      if (command.constructor.name === 'UpdateCommand') {
        updates += 1
        const key = command.input.Key as {
          directoryId: string
          entryKey: string
        }
        const values = command.input.ExpressionAttributeValues as Record<string, string>
        const stored = rows.get(`${key.directoryId}\0${key.entryKey}`)
        if (!stored || stored.entryType !== values[':entryType']) {
          throw conditionalFailure()
        }
        stored.webhookAuthorizationKey = values[':authorizationKey']
        stored.webhookAuthorizationSortKey = values[':authorizationSortKey']
        return {}
      }
      if (command.constructor.name === 'QueryCommand') {
        const values = command.input.ExpressionAttributeValues as Record<string, string>
        const matching = [...rows.values()]
          .filter((row) =>
            visibleGsiKeys.has(createKey(row)) &&
            row.webhookAuthorizationKey === values[':authorizationKey'] &&
            row.webhookAuthorizationSortKey === values[':authorizationSortKey']
          )
          .sort(compareRows)
        const startKey = command.input.ExclusiveStartKey as {
          directoryId?: string
          entryKey?: string
        } | undefined
        const startIndex = startKey
          ? matching.findIndex((row) =>
              row.directoryId === startKey.directoryId &&
              row.entryKey === startKey.entryKey
            ) + 1
          : 0
        const limit = command.input.Limit as number
        const page = matching.slice(startIndex, startIndex + limit)
        return {
          Items: page.map((row) => ({
            directoryId: row.directoryId,
            entryKey: row.entryKey,
          })),
          ...(startIndex + page.length < matching.length && page.at(-1)
            ? {
                LastEvaluatedKey: {
                  directoryId: page.at(-1)!.directoryId,
                  entryKey: page.at(-1)!.entryKey,
                },
              }
            : {}),
        }
      }
      if (command.constructor.name === 'PutCommand') {
        const item = command.input.Item as Record<string, unknown>
        const key = createKey(item)
        if (command.input.ConditionExpression === 'attribute_not_exists(directoryId)') {
          if (rows.has(key)) throw conditionalFailure()
          rows.set(key, item)
          return {}
        }
        if (
          typeof command.input.ConditionExpression === 'string' &&
          command.input.ConditionExpression.includes('#revision')
        ) {
          if (checkpointWriteFailure) {
            checkpointWriteFailure = false
            throw new Error('interrupted after page writes')
          }
          const existing = rows.get(key)
          const values = command.input.ExpressionAttributeValues as Record<string, unknown>
          if (
            !existing ||
            existing.entryType !== values[':entryType'] ||
            existing.revision !== values[':expectedRevision']
          ) {
            throw conditionalFailure()
          }
          rows.set(key, item)
          return {}
        }
        rows.set(key, item)
        return {}
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    },
  } as unknown as DynamoDBDocumentClient
  return {
    client,
    failNextCheckpointWrite() {
      checkpointWriteFailure = true
    },
    flushGsi() {
      for (const row of rows.values()) {
        if (typeof row.webhookAuthorizationKey === 'string') {
          visibleGsiKeys.add(createKey(row))
        }
      }
    },
    scanCalls() {
      return scans
    },
    updateCalls() {
      return updates
    },
  }
}

function createKey(row: Record<string, unknown>) {
  return `${row.directoryId}\0${row.entryKey}`
}

function compareRows(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
) {
  return createKey(first).localeCompare(createKey(second))
}

function conditionalFailure() {
  return Object.assign(new Error('Conditional update failed.'), {
    name: 'ConditionalCheckFailedException',
  })
}
