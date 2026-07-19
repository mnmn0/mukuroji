import { expect, test } from 'bun:test'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  isCompleteHandler,
  processWebhookAuthorizationBackfillEvent,
  processWebhookAuthorizationBackfillPage,
  processWebhookAuthorizationBackfillPages,
  startWebhookAuthorizationBackfill,
} from './webhook-authorization-backfill-handler'

const backfillStartedAt = new Date('2026-07-18T00:00:00.000Z')
const afterWriterDrain = new Date('2026-07-18T00:00:31.000Z')

test('accepts the replaced v1 custom resource delete without v2 validation', async () => {
  await expect(isCompleteHandler({
    RequestType: 'Delete',
    ResourceProperties: { MigrationVersion: 'v1' },
  })).resolves.toEqual({ IsComplete: true })
})

test('deletes the replaced v1 checkpoint without changing its physical ID', async () => {
  const commands: Array<{
    constructor: { name: string }
    input: Record<string, unknown>
  }> = []
  const documentClient = {
    async send(command: {
      constructor: { name: string }
      input: Record<string, unknown>
    }) {
      commands.push(command)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  await expect(processWebhookAuthorizationBackfillEvent({
    RequestType: 'Delete',
    PhysicalResourceId: 'webhook-authorization-projection-backfill-v1',
    ResourceProperties: { MigrationVersion: 'v1' },
  }, documentClient, 'ProjectDirectory')).resolves.toEqual({
    PhysicalResourceId: 'webhook-authorization-projection-backfill-v1',
    SkipMigration: true,
  })
  expect(commands).toHaveLength(1)
  expect(commands[0]?.constructor.name).toBe('DeleteCommand')
  expect(commands[0]?.input).toMatchObject({
    TableName: 'ProjectDirectory',
    Key: {
      directoryId: 'WEBHOOK_AUTHORIZATION_BACKFILL#v1',
      entryKey: 'CHECKPOINT',
    },
  })
})

test('waits for pre-deploy writers to drain before starting the first scan', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const team = {
    directoryId: 'workspace-1',
    entryKey: 'TEAM#active',
    entryType: 'team',
    teamId: 'team-1',
  }
  rows.set(createKey(team), team)
  const fake = createDocumentClient(rows, 10)
  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
  )

  const waiting = await processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    new Date('2026-07-18T00:00:29.999Z'),
  )
  expect(waiting).toMatchObject({
    isComplete: false,
    madeProgress: false,
    checkpoint: {
      phase: 'projection',
      revision: 0,
      writerDrainUntil: '2026-07-18T00:00:30.000Z',
    },
  })
  expect(fake.scanCalls()).toBe(0)

  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterWriterDrain,
  )).resolves.toMatchObject({
    madeProgress: true,
    checkpoint: { revision: 1 },
  })
  expect(fake.scanCalls()).toBe(1)
})

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
    {
      directoryId: 'WEBHOOK_TEAM_GRANT#workspace-1#creator-1',
      entryKey: 'TEAM#team-2#PROJECT#project-1',
      entryType: 'webhook-team-grant',
      workspaceId: 'workspace-1',
      teamId: 'team-2',
      projectId: 'project-1',
      memberKey: 'creator-1',
      sourceEntryKey: 'PROJECT_MEMBER#project-1#creator-1',
      teamSourceEntryKey: 'TEAM#archived',
      projectSourceEntryKey: 'PROJECT#archived-team',
      webhookAuthorizationKey:
        'WEBHOOK_ACL#TEAM_MEMBER#workspace-1#team-2#creator-1',
      webhookAuthorizationSortKey: 'PROJECT#project-1',
    },
  ]) {
    rows.set(createKey(row), row)
  }
  const fake = createDocumentClient(rows, 3)

  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
  )
  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
  )

  fake.failNextCheckpointWrite()
  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterWriterDrain,
  )).rejects.toThrow('interrupted after page writes')

  const scansBeforeBatch = fake.scanCalls()
  let progress = await processWebhookAuthorizationBackfillPages(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    {
      maxPages: 2,
      canProcessNextPage: () => true,
      now: () => afterWriterDrain,
    },
  )
  expect(fake.scanCalls() - scansBeforeBatch).toBe(2)
  expect(progress.checkpoint.phase).toBe('projection')
  while (progress.checkpoint.phase === 'projection') {
    progress = await processWebhookAuthorizationBackfillPage(
      fake.client,
      'ProjectDirectory',
      'WebhookAuthorizationIndex',
      afterWriterDrain,
    )
  }
  expect(progress.checkpoint.phase).toBe('verification')

  const revisionBeforeGsiRetry = progress.checkpoint.revision
  const scansBeforeGsiRetry = fake.scanCalls()
  progress = await processWebhookAuthorizationBackfillPages(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    {
      maxPages: 100,
      canProcessNextPage: () => true,
      now: () => afterWriterDrain,
    },
  )
  expect(fake.scanCalls() - scansBeforeGsiRetry).toBe(1)
  expect(progress.checkpoint.revision).toBe(revisionBeforeGsiRetry)
  expect(progress.checkpoint.phase).toBe('verification')

  fake.flushGsi()
  for (
    let attempt = 0;
    attempt < 30 && progress.checkpoint.phase !== 'grant-cleanup';
    attempt += 1
  ) {
    progress = await processWebhookAuthorizationBackfillPage(
      fake.client,
      'ProjectDirectory',
      'WebhookAuthorizationIndex',
      afterWriterDrain,
    )
  }
  expect(progress.checkpoint.phase).toBe('grant-cleanup')
  const activeGrantKey =
    'WEBHOOK_TEAM_GRANT#workspace-1#creator-1\0TEAM#team-1#PROJECT#project-1'
  const activeProjectKey = 'workspace-1\0PROJECT#active'
  const activeProject = rows.get(activeProjectKey)!
  for (const field of [
    'entryType',
    'teamId',
    'projectId',
    'memberKey',
    'role',
    'archivedAt',
  ]) {
    delete activeProject[field]
  }
  fake.repairSourceBeforeGrantDelete(
    activeGrantKey,
    activeProjectKey,
    {
      entryType: 'project',
      teamId: 'team-1',
      projectId: 'project-1',
    },
  )
  let malformedRepairRaceRejected = false
  for (
    let attempt = 0;
    attempt < 20 && !malformedRepairRaceRejected;
    attempt += 1
  ) {
    try {
      progress = await processWebhookAuthorizationBackfillPage(
        fake.client,
        'ProjectDirectory',
        'WebhookAuthorizationIndex',
        afterWriterDrain,
      )
    } catch (error) {
      expect(error).toMatchObject({ name: 'ConditionalCheckFailedException' })
      malformedRepairRaceRejected = true
    }
  }
  expect(malformedRepairRaceRejected).toBe(true)
  expect(rows.has(activeGrantKey)).toBe(true)
  expect(fake.repairedSourceCondition()).toMatchObject({
    ConditionExpression:
      'attribute_not_exists(#entryType) AND attribute_not_exists(#teamId) AND ' +
      'attribute_not_exists(#projectId) AND attribute_not_exists(#memberKey) AND ' +
      'attribute_not_exists(#role) AND attribute_not_exists(#archivedAt)',
  })
  expect(fake.repairedSourceCondition()?.ExpressionAttributeValues)
    .toBeUndefined()

  const staleGrantKey =
    'WEBHOOK_TEAM_GRANT#workspace-1#creator-1\0TEAM#team-2#PROJECT#project-1'
  fake.replaceGrantBeforeNextDelete()
  let replacementRaceRejected = false
  for (let attempt = 0; attempt < 20 && !replacementRaceRejected; attempt += 1) {
    try {
      progress = await processWebhookAuthorizationBackfillPage(
        fake.client,
        'ProjectDirectory',
        'WebhookAuthorizationIndex',
        afterWriterDrain,
      )
    } catch (error) {
      expect(error).toMatchObject({ name: 'ConditionalCheckFailedException' })
      replacementRaceRejected = true
    }
  }
  expect(replacementRaceRejected).toBe(true)
  expect(rows.has(staleGrantKey)).toBe(true)
  rows.get(staleGrantKey)!.projectSourceEntryKey = 'PROJECT#archived-team'
  for (let attempt = 0; attempt < 30 && !progress.isComplete; attempt += 1) {
    progress = await processWebhookAuthorizationBackfillPages(
      fake.client,
      'ProjectDirectory',
      'WebhookAuthorizationIndex',
      {
        maxPages: 2,
        canProcessNextPage: () => true,
        now: () => afterWriterDrain,
      },
    )
  }
  expect(progress.isComplete).toBe(true)
  expect(progress.checkpoint).toMatchObject({
    phase: 'complete',
    sourceRowsUpdated: 6,
    sourceRowsVerified: 6,
    grantsWritten: 1,
    grantsDeleted: 1,
    cleanupLocatorsWritten: 1,
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
  expect(rows.has(staleGrantKey)).toBe(false)
  expect([...rows.values()].filter((row) =>
    row.entryType === 'webhook-team-grant-cleanup'
  )).toEqual([
    expect.objectContaining({
      directoryId: 'WEBHOOK_GRANT_CLEANUP#workspace-1#team-1',
      entryKey: 'PROJECT#project-1#MEMBER#creator-1',
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      projectId: 'project-1',
      memberKey: 'creator-1',
      grantDirectoryId: 'WEBHOOK_TEAM_GRANT#workspace-1#creator-1',
      grantEntryKey: 'TEAM#team-1#PROJECT#project-1',
    }),
  ])

  const scansAtCompletion = fake.scanCalls()
  await expect(processWebhookAuthorizationBackfillPage(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    afterWriterDrain,
  )).resolves.toMatchObject({ isComplete: true })
  expect(fake.scanCalls()).toBe(scansAtCompletion)
})

test('stops a multi-page invocation when its time budget is exhausted', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  for (let index = 0; index < 6; index += 1) {
    const row = {
      directoryId: 'workspace-1',
      entryKey: `TEAM#${index}`,
      entryType: 'team',
      teamId: `team-${index}`,
    }
    rows.set(createKey(row), row)
  }
  const fake = createDocumentClient(rows, 3)
  await startWebhookAuthorizationBackfill(
    fake.client,
    'ProjectDirectory',
    backfillStartedAt,
  )

  const progress = await processWebhookAuthorizationBackfillPages(
    fake.client,
    'ProjectDirectory',
    'WebhookAuthorizationIndex',
    {
      maxPages: 100,
      canProcessNextPage: () => false,
      now: () => afterWriterDrain,
    },
  )

  expect(progress.isComplete).toBe(false)
  expect(progress.madeProgress).toBe(true)
  expect(progress.checkpoint).toMatchObject({
    phase: 'projection',
    revision: 1,
    sourceRowsUpdated: 2,
  })
  expect(fake.scanCalls()).toBe(1)
})

function createDocumentClient(
  rows: Map<string, Record<string, unknown>>,
  pageSize: number,
) {
  const visibleGsiKeys = new Set<string>()
  let checkpointWriteFailure = false
  let replaceGrantBeforeDelete = false
  let sourceRepairBeforeDelete: {
    grantKey: string
    sourceKey: string
    replacement: Record<string, unknown>
  } | undefined
  let repairedSourceCondition: {
    ConditionExpression: string
    ExpressionAttributeValues?: Record<string, unknown>
  } | undefined
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
      if (command.constructor.name === 'TransactWriteCommand') {
        const transactItems = command.input.TransactItems as Array<{
          ConditionCheck?: {
            Key: { directoryId: string; entryKey: string }
            ConditionExpression: string
            ExpressionAttributeNames?: Record<string, string>
            ExpressionAttributeValues?: Record<string, unknown>
          }
          Delete?: {
            Key: { directoryId: string; entryKey: string }
            ConditionExpression?: string
            ExpressionAttributeValues?: Record<string, unknown>
          }
          Put?: { Item: Record<string, unknown> }
        }>
        if (sourceRepairBeforeDelete) {
          const repair = sourceRepairBeforeDelete
          const targetsGrant = transactItems.some((item) =>
            item.Delete &&
            `${item.Delete.Key.directoryId}\0${item.Delete.Key.entryKey}` ===
              repair.grantKey
          )
          if (targetsGrant) {
            sourceRepairBeforeDelete = undefined
            const condition = transactItems.find((item) => item.ConditionCheck)
              ?.ConditionCheck
            if (condition) {
              repairedSourceCondition = {
                ConditionExpression: condition.ConditionExpression,
                ...(condition.ExpressionAttributeValues
                  ? {
                      ExpressionAttributeValues:
                        condition.ExpressionAttributeValues,
                    }
                  : {}),
              }
            }
            Object.assign(rows.get(repair.sourceKey)!, repair.replacement)
          }
        }
        if (
          replaceGrantBeforeDelete &&
          transactItems.some((item) =>
            item.Delete?.Key.directoryId.startsWith('WEBHOOK_TEAM_GRANT#')
          )
        ) {
          replaceGrantBeforeDelete = false
          const grantDelete = transactItems.find((item) =>
            item.Delete?.Key.directoryId.startsWith('WEBHOOK_TEAM_GRANT#')
          )!.Delete!
          const replacement = rows.get(
            `${grantDelete.Key.directoryId}\0${grantDelete.Key.entryKey}`,
          )
          if (replacement) {
            replacement.projectSourceEntryKey = 'PROJECT#replacement-after-read'
          }
        }
        for (const item of transactItems) {
          if (!item.ConditionCheck) continue
          const source = rows.get(
            `${item.ConditionCheck.Key.directoryId}\0${item.ConditionCheck.Key.entryKey}`,
          )
          if (item.ConditionCheck.ConditionExpression ===
            'attribute_not_exists(directoryId)') {
            if (source) throw conditionalFailure()
            continue
          }
          const values = item.ConditionCheck.ExpressionAttributeValues ?? {}
          if (item.ConditionCheck.ConditionExpression.includes(
            'attribute_not_exists(archivedAt)',
          ) && (
            source?.entryType !== values[':entryType'] ||
            source.archivedAt !== undefined
          )) {
            throw conditionalFailure()
          }
          if (!item.ConditionCheck.ConditionExpression.includes(
            'attribute_not_exists(archivedAt)',
          )) {
            const names = item.ConditionCheck.ExpressionAttributeNames ?? {}
            for (const [placeholder, field] of Object.entries(names)) {
              if (source?.[field] !== values[`:${placeholder.slice(1)}`]) {
                throw conditionalFailure()
              }
            }
          }
        }
        for (const item of transactItems) {
          if (!item.Delete?.ConditionExpression) continue
          const current = rows.get(
            `${item.Delete.Key.directoryId}\0${item.Delete.Key.entryKey}`,
          )
          const values = item.Delete.ExpressionAttributeValues ?? {}
          for (const [placeholder, expected] of Object.entries(values)) {
            const field = placeholder === ':entryType'
              ? 'entryType'
              : placeholder.slice(1)
            if (current?.[field] !== expected) throw conditionalFailure()
          }
        }
        for (const item of transactItems) {
          if (item.Delete) {
            rows.delete(
              `${item.Delete.Key.directoryId}\0${item.Delete.Key.entryKey}`,
            )
          }
          if (item.Put) rows.set(createKey(item.Put.Item), item.Put.Item)
        }
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
    replaceGrantBeforeNextDelete() {
      replaceGrantBeforeDelete = true
    },
    repairSourceBeforeGrantDelete(
      grantKey: string,
      sourceKey: string,
      replacement: Record<string, unknown>,
    ) {
      sourceRepairBeforeDelete = { grantKey, sourceKey, replacement }
    },
    repairedSourceCondition() {
      return repairedSourceCondition
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
