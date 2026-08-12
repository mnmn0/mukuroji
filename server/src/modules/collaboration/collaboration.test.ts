import { expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { CuratedContextSource } from '@mukuroji/contracts'
import { createMutationAuditContext } from '../audit/audit'
import {
  CollaborationError,
  createProjectCollaborationEntityKey,
  createWorkItemCollaborationEntityKey,
  DynamoDbCollaborationClient,
} from './collaboration'

function readCommandInput(command: unknown) {
  if (typeof command !== 'object' || command === null || !('input' in command)) {
    throw new Error('Expected an AWS command.')
  }
  return command.input as Record<string, unknown>
}

/**
 * Creates a collaboration client with isolated DynamoDB transports.
 *
 * @param send - Document-client command implementation used by the test.
 * @param auditTableName - Optional audit table included in mutation transactions.
 * @param useConfiguredParentIssueTable - Whether the constructor should resolve its parent table from the environment.
 * @returns An isolated collaboration client.
 */
function createClient(
  send: (command: unknown) => Promise<Record<string, unknown>>,
  auditTableName?: string,
  useConfiguredParentIssueTable = false,
) {
  const documentClient = { send } as unknown as DynamoDBDocumentClient
  const lowLevelClient = { send } as unknown as DynamoDBClient
  return new DynamoDbCollaborationClient(
    'collaboration-table',
    useConfiguredParentIssueTable ? undefined : 'issue-table',
    auditTableName,
    documentClient,
    lowLevelClient,
    false,
  )
}

/**
 * Tests whether a value supports safe property access in the in-memory DynamoDB test transport.
 *
 * @param value - Unknown command fragment.
 * @returns Whether the value is a record.
 */
function isTestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Creates a DynamoDB transaction cancellation used by optimistic-lock tests.
 *
 * @returns An AWS-shaped conditional transaction error.
 */
function createConditionalTransactionError() {
  return Object.assign(new Error('conditional transaction failed'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  })
}

/**
 * Creates a small in-memory DocumentClient transport for collaboration store tests.
 *
 * @param seed - Physical collaboration rows available before the first command.
 * @param auditTableName - Optional append-only audit table used by mutations.
 * @returns Stateful client, rows, transaction log, and a comment-race hook.
 */
function createCollaborationMemory(
  seed: Array<Record<string, unknown>> = [],
  auditTableName?: string,
) {
  const rows = new Map<string, Record<string, unknown>>()
  const transactions: Array<Record<string, unknown>> = []
  let commentToMutateBeforeNextTransaction:
    | { entityKey: string; commentId: string }
    | undefined
  let reportCommittedTransactionAsConditionalFailure = false
  /** Creates the compound key used by the in-memory row map. */
  const storageKey = (entityKey: string, recordKey: string) => `${entityKey}\0${recordKey}`
  for (const row of seed) {
    if (typeof row.entityKey === 'string' && typeof row.recordKey === 'string') {
      rows.set(storageKey(row.entityKey, row.recordKey), row)
    }
  }

  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if (isTestRecord(input.Key) &&
        typeof input.Key.entityKey === 'string' &&
        typeof input.Key.recordKey === 'string') {
      return { Item: rows.get(storageKey(input.Key.entityKey, input.Key.recordKey)) }
    }

    if (typeof input.KeyConditionExpression === 'string' &&
        isTestRecord(input.ExpressionAttributeValues) &&
        typeof input.ExpressionAttributeValues[':entityKey'] === 'string' &&
        typeof input.ExpressionAttributeValues[':prefix'] === 'string') {
      const entityKey = input.ExpressionAttributeValues[':entityKey']
      const prefix = input.ExpressionAttributeValues[':prefix']
      const ordered = [...rows.values()]
        .filter((row) => row.entityKey === entityKey &&
          typeof row.recordKey === 'string' && row.recordKey.startsWith(prefix))
        .sort((left, right) => String(left.recordKey).localeCompare(String(right.recordKey)))
      if (input.ScanIndexForward === false) {
        ordered.reverse()
      }
      const startRecordKey = isTestRecord(input.ExclusiveStartKey) &&
          typeof input.ExclusiveStartKey.recordKey === 'string'
        ? input.ExclusiveStartKey.recordKey
        : undefined
      const startIndex = startRecordKey
        ? Math.max(0, ordered.findIndex((row) => row.recordKey === startRecordKey) + 1)
        : 0
      const limit = typeof input.Limit === 'number' ? input.Limit : ordered.length
      const items = ordered.slice(startIndex, startIndex + limit)
      const hasMore = startIndex + items.length < ordered.length
      const last = items.at(-1)
      return {
        Items: items,
        ...(hasMore && last && typeof last.recordKey === 'string'
          ? { LastEvaluatedKey: { entityKey, recordKey: last.recordKey } }
          : {}),
      }
    }

    if (!Array.isArray(input.TransactItems)) {
      return {}
    }
    transactions.push(input)
    if (commentToMutateBeforeNextTransaction) {
      const key = storageKey(
        commentToMutateBeforeNextTransaction.entityKey,
        `COMMENT#${commentToMutateBeforeNextTransaction.commentId}`,
      )
      const current = rows.get(key)
      if (current && typeof current.version === 'number') {
        rows.set(key, { ...current, version: current.version + 1, bodyMarkdown: 'Changed concurrently' })
      }
      commentToMutateBeforeNextTransaction = undefined
    }

    for (const transactionItem of input.TransactItems) {
      if (!isTestRecord(transactionItem)) continue
      const condition = isTestRecord(transactionItem.ConditionCheck)
        ? transactionItem.ConditionCheck
        : undefined
      if (condition?.TableName === 'collaboration-table' && isTestRecord(condition.Key) &&
          typeof condition.Key.entityKey === 'string' &&
          typeof condition.Key.recordKey === 'string') {
        const current = rows.get(storageKey(condition.Key.entityKey, condition.Key.recordKey))
        const expression = typeof condition.ConditionExpression === 'string'
          ? condition.ConditionExpression
          : ''
        const values = isTestRecord(condition.ExpressionAttributeValues)
          ? condition.ExpressionAttributeValues
          : {}
        if ((expression.includes('attribute_exists') && !current) ||
            (expression.includes('attribute_not_exists(deletedAt)') && current?.deletedAt) ||
            (typeof values[':capturedVersion'] === 'number' &&
              current?.version !== values[':capturedVersion'])) {
          throw createConditionalTransactionError()
        }
      }

      const put = isTestRecord(transactionItem.Put) ? transactionItem.Put : undefined
      if (put?.TableName !== 'collaboration-table' || !isTestRecord(put.Item) ||
          typeof put.Item.entityKey !== 'string' || typeof put.Item.recordKey !== 'string') {
        continue
      }
      const current = rows.get(storageKey(put.Item.entityKey, put.Item.recordKey))
      const expression = typeof put.ConditionExpression === 'string' ? put.ConditionExpression : ''
      const values = isTestRecord(put.ExpressionAttributeValues)
        ? put.ExpressionAttributeValues
        : {}
      if ((expression.includes('attribute_not_exists(entityKey)') && current) ||
          (typeof values[':expectedRevision'] === 'number' &&
            current?.revision !== values[':expectedRevision']) ||
          (typeof values[':expectedVersion'] === 'number' &&
            current?.version !== values[':expectedVersion'])) {
        throw createConditionalTransactionError()
      }
    }

    for (const transactionItem of input.TransactItems) {
      if (!isTestRecord(transactionItem) || !isTestRecord(transactionItem.Put)) continue
      const put = transactionItem.Put
      if (put.TableName === 'collaboration-table' && isTestRecord(put.Item) &&
          typeof put.Item.entityKey === 'string' && typeof put.Item.recordKey === 'string') {
        rows.set(storageKey(put.Item.entityKey, put.Item.recordKey), put.Item)
      }
    }
    for (const transactionItem of input.TransactItems) {
      if (!isTestRecord(transactionItem) || !isTestRecord(transactionItem.Update)) continue
      const update = transactionItem.Update
      if (update.TableName !== 'collaboration-table' || !isTestRecord(update.Key) ||
          typeof update.Key.entityKey !== 'string' ||
          update.Key.recordKey !== 'CONTEXT_LEDGER') {
        continue
      }
      const current = rows.get(storageKey(update.Key.entityKey, update.Key.recordKey))
      const generation = current && typeof current.generation === 'number'
        ? current.generation
        : 0
      rows.set(storageKey(update.Key.entityKey, update.Key.recordKey), {
        entityKey: update.Key.entityKey,
        recordKey: update.Key.recordKey,
        entryType: 'context-ledger',
        generation: generation + 1,
      })
    }
    if (reportCommittedTransactionAsConditionalFailure) {
      reportCommittedTransactionAsConditionalFailure = false
      throw createConditionalTransactionError()
    }
    return {}
  }, auditTableName)

  return {
    client,
    rows,
    transactions,
    /** Mutates one comment immediately before the next transaction evaluates its conditions. */
    mutateCommentBeforeNextTransaction(
      commentId: string,
      entityKey = createWorkItemCollaborationEntityKey(
        'workspace#one',
        'team-a',
        'issue-1',
      ),
    ) {
      commentToMutateBeforeNextTransaction = { commentId, entityKey }
    },
    /** Simulates an identical concurrent winner committing before this caller observes a conflict. */
    reportNextCommittedTransactionAsConditionalFailure() {
      reportCommittedTransactionAsConditionalFailure = true
    },
  }
}

/**
 * Creates a deterministic audit context for an in-memory collaboration mutation.
 *
 * @param idempotencyKey - Logical mutation identifier.
 * @param occurredAt - Mutation timestamp.
 * @param body - Optional request body included in the fingerprint.
 * @returns Mutation audit context.
 */
function createTestAuditContext(
  idempotencyKey: string,
  occurredAt: string,
  body?: unknown,
) {
  return createMutationAuditContext({
    workspaceId: 'workspace#one',
    actor: { id: 'author@example.com', kind: 'user', displayName: 'Author' },
    idempotencyKey,
    occurredAt,
    request: { method: 'POST', path: '/collaboration-test', body },
    source: { kind: 'api' },
  })
}

test('creates stable collaboration keys for Work Item and project scopes', () => {
  expect(createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')).toBe(
    'workspace#one#work-item#team/team-a/issue/issue-1',
  )
  expect(createProjectCollaborationEntityKey('workspace#one', 'project-a')).toBe(
    'workspace#one#project#project-a',
  )
})

test('rejects curated context rows whose owner disagrees with the entity key', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if (isTestRecord(input.Key) && input.Key.recordKey === 'CONTEXT#context-owner-mismatch') {
      return {
        Item: {
          entityKey,
          recordKey: 'CONTEXT#context-owner-mismatch',
          entryType: 'context',
          schemaVersion: 1,
          id: 'context-owner-mismatch',
          teamId: 'team-other',
          workItemId: 'issue-1',
          kind: 'decision',
          state: 'active',
          title: 'Decision',
          body: 'Body',
          mentionMemberKeys: [],
          createdBy: { id: 'author@example.com', displayName: 'Author' },
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedBy: { id: 'author@example.com', displayName: 'Author' },
          updatedAt: '2026-07-12T00:00:00.000Z',
          revision: 1,
        },
      }
    }
    return {}
  })

  await expect(client.getCuratedContextItemSnapshot({
    entityKey,
    itemId: 'context-owner-mismatch',
  })).rejects.toMatchObject({
    status: 503,
    code: 'InvalidCollaborationRecord',
  })
})

test('prefers the canonical Work Items environment for parent mutation guards', async () => {
  const originalWorkItemsTableName = Bun.env.WORK_ITEMS_TABLE_NAME
  const originalLegacyTeamIssuesTableName = Bun.env.MUKUROJI_TEAM_ISSUES_TABLE
  Bun.env.WORK_ITEMS_TABLE_NAME = 'canonical-work-items-table'
  Bun.env.MUKUROJI_TEAM_ISSUES_TABLE = 'legacy-team-issues-table'
  const transactions: Array<Record<string, unknown>> = []

  try {
    const client = createClient(async (command) => {
      const input = readCommandInput(command)
      if ('TransactItems' in input) transactions.push(input)
      return {}
    }, undefined, true)
    await client.subscribe({
      workspaceId: 'workspace#one',
      entityKey: createWorkItemCollaborationEntityKey(
        'workspace#one',
        'team-a',
        'issue-1',
      ),
      teamId: 'team-a',
      issueId: 'issue-1',
      memberKey: 'member@example.com',
    })

    expect(transactions[0]?.TransactItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          TableName: 'canonical-work-items-table',
        }),
      }),
    ]))
  } finally {
    if (originalWorkItemsTableName === undefined) {
      delete Bun.env.WORK_ITEMS_TABLE_NAME
    } else {
      Bun.env.WORK_ITEMS_TABLE_NAME = originalWorkItemsTableName
    }
    if (originalLegacyTeamIssuesTableName === undefined) {
      delete Bun.env.MUKUROJI_TEAM_ISSUES_TABLE
    } else {
      Bun.env.MUKUROJI_TEAM_ISSUES_TABLE =
        originalLegacyTeamIssuesTableName
    }
  }
})

test('reads soft-deleted comment snapshots consistently for search revalidation', async () => {
  const reads: Array<Record<string, unknown>> = []
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    reads.push(input)
    return {
      Item: {
        entityKey,
        recordKey: 'COMMENT#comment-1',
        entryType: 'comment',
        id: 'comment-1',
        rootCommentId: 'comment-1',
        authorMemberKey: 'author@example.com',
        bodyMarkdown: '',
        version: 2,
        mentionMemberKeys: [],
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:01:00.000Z',
        deletedAt: '2026-07-12T00:01:00.000Z',
      },
    }
  })

  expect(await client.getCommentSnapshot({ entityKey, commentId: 'comment-1' }))
    .toMatchObject({ id: 'comment-1', deletedAt: '2026-07-12T00:01:00.000Z' })
  expect(reads).toEqual([
    expect.objectContaining({
      Key: { entityKey, recordKey: 'COMMENT#comment-1' },
      ConsistentRead: true,
    }),
  ])
})

test('accepts only saved non-deleted comments as file attachment targets', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    const commentId = String((input.Key as { recordKey?: string } | undefined)?.recordKey ?? '')
      .replace('COMMENT#', '')
    if (commentId === 'missing') {
      return {}
    }
    return {
      Item: {
        entityKey,
        recordKey: `COMMENT#${commentId}`,
        entryType: 'comment',
        id: commentId,
        rootCommentId: commentId,
        authorMemberKey: 'author@example.com',
        bodyMarkdown: commentId === 'deleted' ? '' : 'Current comment',
        version: commentId === 'deleted' ? 2 : 1,
        mentionMemberKeys: [],
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:01:00.000Z',
        ...(commentId === 'deleted'
          ? { deletedAt: '2026-07-12T00:01:00.000Z' }
          : {}),
      },
    }
  })

  expect(await client.hasAttachableComment(entityKey, 'current')).toBe(true)
  expect(await client.hasAttachableComment(entityKey, 'deleted')).toBe(false)
  expect(await client.hasAttachableComment(entityKey, 'missing')).toBe(false)
})

test('pages root comments newest-first and binds cursors to their entity scope', async () => {
  const discussionQueries: Array<Record<string, unknown>> = []
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined
    if (values?.[':prefix'] === 'DISCUSSION#ROOT#') {
      discussionQueries.push(input)
      return {
        Items: [],
        LastEvaluatedKey: {
          entityKey: 'workspace#one#work-item#team/team-a/issue/issue-1',
          recordKey: 'DISCUSSION#ROOT#2026-07-12T00:00:00.000Z#comment-1',
        },
      }
    }
    return { Items: [] }
  })
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const first = await client.getThread({ entityKey, viewerMemberKey: 'member@example.com' })

  expect(discussionQueries).toHaveLength(1)
  expect(discussionQueries[0]?.ScanIndexForward).toBe(false)
  expect(first.nextCursor).toBeString()

  await expect(client.getThread({
    entityKey: createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-2'),
    viewerMemberKey: 'member@example.com',
    cursor: first.nextCursor,
  })).rejects.toMatchObject({
    status: 400,
    code: 'InvalidCollaborationCursor',
  })
})

test('stores a project watcher in the project scope', async () => {
  const transactions: Array<Record<string, unknown>> = []
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      transactions.push(input)
      return {}
    }
    return { Items: [] }
  })
  const entityKey = createProjectCollaborationEntityKey('workspace#one', 'project-a')
  const watch = await client.subscribe({
    workspaceId: 'workspace#one',
    entityKey,
    projectId: 'project-a',
    memberKey: 'Member@Example.com',
  })

  expect(transactions).toHaveLength(1)
  expect(transactions[0]?.TransactItems).toEqual([
    expect.objectContaining({
      Update: expect.objectContaining({
        Key: { entityKey, recordKey: 'WATCHER#member@example.com' },
      }),
    }),
  ])
  expect(watch).toEqual({
    subscribed: false,
    explicit: false,
    automatic: false,
    reasons: [],
    watcherCount: 0,
  })
})

test('reads every watcher page before calculating subscription state and count', async () => {
  let watcherQueries = 0
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined
    if (values?.[':prefix'] !== 'WATCHER#') {
      return { Items: [] }
    }

    watcherQueries += 1
    const memberKey = watcherQueries === 1 ? 'first@example.com' : 'second@example.com'
    return {
      Items: [{
        entityKey: 'scope-1',
        recordKey: `WATCHER#${memberKey}`,
        entryType: 'watcher',
        memberKey,
        state: 'subscribed',
        explicit: watcherQueries === 2,
        reasons: new Set([watcherQueries === 1 ? 'comment' : 'manual']),
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z',
      }],
      ...(watcherQueries === 1
        ? { LastEvaluatedKey: { entityKey: 'scope-1', recordKey: 'WATCHER#first@example.com' } }
        : {}),
    }
  })

  const watch = await client.getWatcherState({
    entityKey: 'scope-1',
    memberKey: 'second@example.com',
  })

  expect(watcherQueries).toBe(2)
  expect(watch).toEqual({
    subscribed: true,
    explicit: true,
    automatic: false,
    reasons: ['manual'],
    watcherCount: 2,
  })
})

test('seeds deduplicated automatic watchers when a comment is created', async () => {
  let transaction: Record<string, unknown> | undefined
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      transaction = input
      return {}
    }
    return { Items: [] }
  })
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')

  await client.createComment({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    actorMemberKey: 'author@example.com',
    bodyMarkdown: 'Please review this.',
    mentionMemberKeys: ['mentioned@example.com'],
    automaticWatcherCandidates: [
      { memberKey: 'creator@example.com', reason: 'creator' },
      { memberKey: 'assignee@example.com', reason: 'assignee' },
      { memberKey: 'mentioned@example.com', reason: 'mention' },
    ],
  })

  const items = transaction?.TransactItems as Array<Record<string, unknown>>
  expect(items[0]).toEqual({
    ConditionCheck: expect.objectContaining({
      ConditionExpression: expect.stringContaining('attribute_not_exists(assignedProjectId)'),
    }),
  })
  const watcherUpdates = items.flatMap((item) => {
    const update = item.Update as Record<string, unknown> | undefined
    const key = update?.Key as Record<string, unknown> | undefined
    return update !== undefined &&
        typeof key?.recordKey === 'string' &&
        key.recordKey.startsWith('WATCHER#')
      ? [update]
      : []
  })
  expect(watcherUpdates.map((update) => (update.Key as Record<string, unknown>).recordKey).sort()).toEqual([
    'WATCHER#assignee@example.com',
    'WATCHER#author@example.com',
    'WATCHER#creator@example.com',
    'WATCHER#mentioned@example.com',
  ])
  const mentionedUpdate = watcherUpdates.find((update) =>
    (update.Key as Record<string, unknown>).recordKey === 'WATCHER#mentioned@example.com'
  )
  const mentionedValues = mentionedUpdate?.ExpressionAttributeValues as Record<string, unknown>
  expect(mentionedValues[':reasons']).toEqual(new Set(['mention']))
})

test('binds comment, reaction, and Work Item watch transactions to the loaded project assignment', async () => {
  const transactions: Array<Record<string, unknown>> = []
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      transactions.push(input)
      return {}
    }
    const key = input.Key as { recordKey?: string } | undefined
    if (key?.recordKey === 'COMMENT#root-1') {
      return {
        Item: {
          entityKey: 'workspace#one#work-item#team/team-a/issue/issue-1',
          recordKey: 'COMMENT#root-1',
          entryType: 'comment',
          id: 'root-1',
          rootCommentId: 'root-1',
          authorMemberKey: 'author@example.com',
          bodyMarkdown: 'Review this.',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
          reactions: [],
        },
      }
    }
    return { Items: [] }
  })
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const projectEntityKey = createProjectCollaborationEntityKey('workspace#one', 'project-a')
  const scope = {
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    projectId: 'project-a',
    projectEntityKey,
  }

  await client.createComment({
    ...scope,
    actorMemberKey: 'author@example.com',
    bodyMarkdown: 'New comment',
  })
  await client.addReaction({
    ...scope,
    actorMemberKey: 'author@example.com',
    commentId: 'root-1',
    emoji: '👍',
  })
  await client.subscribe({
    ...scope,
    memberKey: 'author@example.com',
  })

  expect(transactions).toHaveLength(3)
  for (const transaction of transactions) {
    const condition = (transaction.TransactItems as Array<Record<string, unknown>>)[0]
      ?.ConditionCheck as Record<string, unknown>
    expect(condition).toMatchObject({
      TableName: 'issue-table',
      Key: {
        directoryTeamId: 'workspace#one#team#team-a',
        issueId: 'issue-1',
      },
      ExpressionAttributeValues: { ':assignedProjectId': 'project-a' },
    })
    expect(condition.ConditionExpression).toContain('assignedProjectId = :assignedProjectId')
  }
})

test('rejects resolve and reopen mutations for deleted comment tombstones', async () => {
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('Key' in input) {
      return {
        Item: {
          entityKey: 'workspace#one#work-item#team/team-a/issue/issue-1',
          recordKey: 'COMMENT#root-1',
          entryType: 'comment',
          id: 'root-1',
          rootCommentId: 'root-1',
          authorMemberKey: 'author@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:01:00.000Z',
          deletedAt: '2026-07-12T00:01:00.000Z',
          reactions: [],
        },
      }
    }
    return {}
  })
  const input = {
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey: createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1'),
    actorMemberKey: 'author@example.com',
    commentId: 'root-1',
    expectedVersion: 2,
  }

  await expect(client.resolveComment(input)).rejects.toMatchObject({
    status: 409,
    code: 'CommentDeleted',
  })
  await expect(client.reopenComment(input)).rejects.toMatchObject({
    status: 409,
    code: 'CommentDeleted',
  })
})

test('binds resolve authorization to the loaded Work Item assignee', async () => {
  let transaction: Record<string, unknown> | undefined
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      transaction = input
      return {}
    }
    return {
      Item: {
        entityKey: 'workspace#one#work-item#team/team-a/issue/issue-1',
        recordKey: 'COMMENT#root-1',
        entryType: 'comment',
        id: 'root-1',
        rootCommentId: 'root-1',
        authorMemberKey: 'author@example.com',
        bodyMarkdown: 'Decision',
        version: 1,
        mentionMemberKeys: [],
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z',
        reactions: [],
      },
    }
  })

  await client.resolveComment({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey: createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1'),
    actorMemberKey: 'assignee@example.com',
    assigneeMemberKey: 'assignee@example.com',
    commentId: 'root-1',
    expectedVersion: 1,
    canModerate: true,
  })

  expect(transaction).toBeDefined()
  if (!transaction) {
    throw new Error('Expected a collaboration transaction.')
  }
  const parentCheck = (transaction.TransactItems as Array<Record<string, unknown>>)[0]
    ?.ConditionCheck as Record<string, unknown>
  expect(parentCheck.ConditionExpression).toContain('assigneeUserId = :assigneeMemberKey')
  expect(parentCheck.ExpressionAttributeValues).toEqual({
    ':assigneeMemberKey': 'assignee@example.com',
  })
})

test('derives the same comment ID when an idempotent create request is retried', async () => {
  const commentIds: string[] = []
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      const items = input.TransactItems as Array<Record<string, unknown>>
      const commentPut = items.find((item) =>
        (item.Put as { Item?: { entryType?: unknown } } | undefined)?.Item?.entryType === 'comment'
      )?.Put as { Item: { id: string } }
      commentIds.push(commentPut.Item.id)
      return {}
    }
    return { Items: [] }
  })
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const createContext = (occurredAt: string) => createMutationAuditContext({
    workspaceId: 'workspace#one',
    actor: { id: 'author@example.com', kind: 'user' },
    idempotencyKey: 'create-comment-once',
    occurredAt,
    request: { method: 'POST', path: '/comments', body: { bodyMarkdown: 'Stable' } },
    source: { kind: 'api' },
  })
  const input = {
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    actorMemberKey: 'author@example.com',
    bodyMarkdown: 'Stable',
  }

  await client.createComment({ ...input, auditContext: createContext('2026-07-12T00:00:00.000Z') })
  await client.createComment({ ...input, auditContext: createContext('2026-07-12T00:01:00.000Z') })

  expect(commentIds).toHaveLength(2)
  expect(commentIds[0]).toBe(commentIds[1])
})

test('rejects replies to a resolved root before writing', async () => {
  let writes = 0
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('Key' in input) {
      return {
        Item: {
          entityKey,
          recordKey: 'COMMENT#root-1',
          entryType: 'comment',
          id: 'root-1',
          rootCommentId: 'root-1',
          authorMemberKey: 'author@example.com',
          bodyMarkdown: 'Resolved',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:01:00.000Z',
          resolvedAt: '2026-07-12T00:01:00.000Z',
          resolvedByMemberKey: 'author@example.com',
        },
      }
    }
    writes += 1
    return {}
  })

  await expect(client.createComment({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    actorMemberKey: 'reply@example.com',
    bodyMarkdown: 'New reply',
    parentCommentId: 'root-1',
  })).rejects.toMatchObject({ code: 'CommentResolved', status: 409 })
  expect(writes).toBe(0)
})

test('rejects watcher writes whose key does not match the requested scope', async () => {
  const client = createClient(async () => ({}))

  await expect(client.unsubscribe({
    workspaceId: 'workspace#one',
    entityKey: createProjectCollaborationEntityKey('workspace#one', 'project-b'),
    projectId: 'project-a',
    memberKey: 'member@example.com',
  })).rejects.toBeInstanceOf(CollaborationError)
})

test('rejects empty, unsafe, and oversized comment bodies before persistence', async () => {
  let writes = 0
  const client = createClient(async () => {
    writes += 1
    return {}
  })
  const input = {
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey: createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1'),
    actorMemberKey: 'member@example.com',
  }

  await expect(client.createComment({ ...input, bodyMarkdown: '   ' })).rejects.toMatchObject({
    code: 'InvalidCommentBody',
  })
  await expect(client.createComment({ ...input, bodyMarkdown: 'unsafe\u0000text' })).rejects.toMatchObject({
    code: 'InvalidCommentBody',
  })
  await expect(client.createComment({ ...input, bodyMarkdown: 'x'.repeat(20_001) })).rejects.toMatchObject({
    code: 'InvalidCommentBody',
  })
  expect(writes).toBe(0)
})

test('treats a duplicate reaction add as an idempotent no-op', async () => {
  const commands: Array<Record<string, unknown>> = []
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    commands.push(input)
    const key = input.Key as Record<string, unknown> | undefined
    if (key?.recordKey === 'COMMENT#comment-1') {
      return {
        Item: {
          entityKey: key.entityKey,
          recordKey: key.recordKey,
          entryType: 'comment',
          id: 'comment-1',
          rootCommentId: 'comment-1',
          authorMemberKey: 'author@example.com',
          bodyMarkdown: 'Review this',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
        },
      }
    }
    return { Item: { entryType: 'reaction' } }
  })
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')

  await client.addReaction({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    actorMemberKey: 'member@example.com',
    commentId: 'comment-1',
    emoji: '👍',
  })

  expect(commands).toHaveLength(2)
  expect(commands.some((input) => 'TransactItems' in input)).toBe(false)
})

test('records comment edits and deletes as redacted append-only audit events', async () => {
  const transactions: Array<Record<string, unknown>> = []
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      transactions.push(input)
      return {}
    }
    if ('Key' in input) {
      return {
        Item: {
          entityKey,
          recordKey: 'COMMENT#comment-1',
          entryType: 'comment',
          id: 'comment-1',
          rootCommentId: 'comment-1',
          authorMemberKey: 'author@example.com',
          bodyMarkdown: 'Before',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
        },
      }
    }
    return { Items: [] }
  }, 'audit-table')
  const createContext = (idempotencyKey: string) => createMutationAuditContext({
    workspaceId: 'workspace#one',
    actor: { id: 'author@example.com', kind: 'user' },
    idempotencyKey,
    occurredAt: '2026-07-12T00:01:00.000Z',
    request: { method: 'PATCH', path: '/comments/comment-1' },
    source: { kind: 'api' },
  })

  await client.updateComment({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    workItemTitle: 'Notification target',
    entityKey,
    actorMemberKey: 'author@example.com',
    commentId: 'comment-1',
    bodyMarkdown: 'After',
    expectedVersion: 1,
    deepLink: '/teams/team-a/issues?issueId=issue-1',
    auditContext: createContext('edit-comment'),
  })
  await client.deleteComment({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    actorMemberKey: 'author@example.com',
    commentId: 'comment-1',
    expectedVersion: 1,
    auditContext: createContext('delete-comment'),
  })

  const auditEvents = transactions.map((transaction) => {
    const items = transaction.TransactItems as Array<Record<string, unknown>>
    const auditPut = items.find((item) =>
      (item.Put as Record<string, unknown> | undefined)?.TableName === 'audit-table'
    )?.Put as Record<string, unknown>
    return auditPut.Item as Record<string, unknown>
  })
  expect(auditEvents.map((event) => event.eventType)).toEqual(['comment.edited', 'comment.deleted'])
  expect(auditEvents[0]?.changes).toEqual([
    { field: 'body', before: '[REDACTED]', after: '[REDACTED]', redacted: true },
  ])
  expect(auditEvents[0]?.metadata).toMatchObject({
    commentId: 'comment-1',
    rootCommentId: 'comment-1',
    notificationTitle: 'Notification target',
    deepLink: '/teams/team-a/issues?issueId=issue-1&commentId=comment-1&rootCommentId=comment-1',
  })
  expect(auditEvents[1]?.changes).toEqual([
    { field: 'body', before: '[REDACTED]', after: '[REDACTED]', redacted: true },
    { field: 'deletedAt', after: '2026-07-12T00:01:00.000Z' },
  ])
})

test('returns a version conflict when an edited comment changed after it was loaded', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      const error = new Error('Transaction canceled') as Error & {
        CancellationReasons: Array<{ Code: string }>
      }
      error.name = 'TransactionCanceledException'
      error.CancellationReasons = [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }]
      throw error
    }
    if ('Key' in input) {
      return {
        Item: {
          entityKey,
          recordKey: 'COMMENT#comment-1',
          entryType: 'comment',
          id: 'comment-1',
          rootCommentId: 'comment-1',
          authorMemberKey: 'author@example.com',
          bodyMarkdown: 'A newer edit',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:02:00.000Z',
        },
      }
    }
    return { Items: [] }
  })

  await expect(client.updateComment({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    actorMemberKey: 'author@example.com',
    commentId: 'comment-1',
    bodyMarkdown: 'My stale edit',
    expectedVersion: 1,
  })).rejects.toMatchObject({
    code: 'CommentVersionConflict',
    status: 409,
  })
})

test('upserts and removes a presence lease with a normalized member key', async () => {
  const commands: Array<Record<string, unknown>> = []
  const client = createClient(async (command) => {
    commands.push(readCommandInput(command))
    return {}
  })
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')

  await client.heartbeatPresence({
    entityKey,
    memberKey: 'Member@Example.com',
    clientId: 'browser-tab-1',
    typing: true,
    ttlSeconds: 45,
  })
  await client.leavePresence({
    entityKey,
    memberKey: 'Member@Example.com',
    clientId: 'browser-tab-1',
  })

  expect(commands[0]).toMatchObject({
    TransactItems: [{
      Put: {
        TableName: 'collaboration-table',
        Item: {
          entityKey,
          recordKey: 'PRESENCE#member@example.com#browser-tab-1',
          typing: true,
        },
      },
    }],
  })
  expect(commands[1]).toMatchObject({
    TransactItems: [{
      Delete: {
        TableName: 'collaboration-table',
        Key: {
          entityKey,
          recordKey: 'PRESENCE#member@example.com#browser-tab-1',
        },
      },
    }],
  })
})

test('pages curated context newest-first with scope-bound cursors and capabilities', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const actor = { id: 'author@example.com', displayName: 'Author' }
  const contextRows = [
    { id: 'ctx-1', createdAt: '2026-07-12T00:00:00.000Z', title: 'First' },
    { id: 'ctx-2', createdAt: '2026-07-12T00:01:00.000Z', title: 'Second' },
  ].flatMap(({ id, createdAt, title }) => [{
    entityKey,
    recordKey: `CONTEXT#${id}`,
    entryType: 'context',
    schemaVersion: 1,
    id,
    teamId: 'team-a',
    workItemId: 'issue-1',
    kind: 'decision',
    state: 'active',
    title,
    body: `${title} body`,
    mentionMemberKeys: [],
    createdBy: actor,
    createdAt,
    updatedBy: actor,
    updatedAt: createdAt,
    revision: 1,
  }, {
    entityKey,
    recordKey: `CONTEXT_ORDER#${createdAt}#${id}`,
    entryType: 'context-order',
    itemId: id,
    createdAt,
  }])
  const memory = createCollaborationMemory(contextRows)
  const capabilities = {
    canCreate: true,
    canEdit: true,
    canReplace: false,
    canAcceptResolution: true,
  }

  const first = await memory.client.getCuratedContext({ entityKey, limit: 1, capabilities })
  expect(first).toMatchObject({
    schemaVersion: 1,
    items: [{ id: 'ctx-2', title: 'Second' }],
    capabilities,
  })
  expect(first.nextCursor).toBeString()
  const second = await memory.client.getCuratedContext({
    entityKey,
    limit: 1,
    cursor: first.nextCursor,
    capabilities,
  })
  expect(second.items.map((item) => item.id)).toEqual(['ctx-1'])
  expect(second.nextCursor).toBeUndefined()

  await expect(memory.client.getCuratedContext({
    entityKey: createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-2'),
    cursor: first.nextCursor,
    capabilities,
  })).rejects.toMatchObject({ status: 400, code: 'InvalidCollaborationCursor' })
})

test('expires a curated context cursor when the ledger generation changes', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const actor = { id: 'author@example.com', displayName: 'Author' }
  const memory = createCollaborationMemory([
    {
      entityKey,
      recordKey: 'CONTEXT#ctx-1',
      entryType: 'context',
      schemaVersion: 1,
      id: 'ctx-1',
      teamId: 'team-a',
      workItemId: 'issue-1',
      kind: 'context',
      state: 'active',
      title: 'First',
      body: 'First body',
      mentionMemberKeys: [],
      createdBy: actor,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedBy: actor,
      updatedAt: '2026-07-12T00:00:00.000Z',
      revision: 1,
    },
    {
      entityKey,
      recordKey: 'CONTEXT_ORDER#2026-07-12T00:00:00.000Z#ctx-1',
      entryType: 'context-order',
      itemId: 'ctx-1',
      createdAt: '2026-07-12T00:00:00.000Z',
    },
    {
      entityKey,
      recordKey: 'CONTEXT#ctx-2',
      entryType: 'context',
      schemaVersion: 1,
      id: 'ctx-2',
      teamId: 'team-a',
      workItemId: 'issue-1',
      kind: 'context',
      state: 'active',
      title: 'Second',
      body: 'Second body',
      mentionMemberKeys: [],
      createdBy: actor,
      createdAt: '2026-07-12T00:01:00.000Z',
      updatedBy: actor,
      updatedAt: '2026-07-12T00:01:00.000Z',
      revision: 1,
    },
    {
      entityKey,
      recordKey: 'CONTEXT_ORDER#2026-07-12T00:01:00.000Z#ctx-2',
      entryType: 'context-order',
      itemId: 'ctx-2',
      createdAt: '2026-07-12T00:01:00.000Z',
    },
  ])
  const capabilities = {
    canCreate: true,
    canEdit: true,
    canReplace: true,
    canAcceptResolution: true,
  }
  const first = await memory.client.getCuratedContext({ entityKey, limit: 1, capabilities })
  memory.rows.set(`${entityKey}\0CONTEXT_LEDGER`, {
    entityKey,
    recordKey: 'CONTEXT_LEDGER',
    entryType: 'context-ledger',
    generation: 1,
  })

  await expect(memory.client.getCuratedContext({
    entityKey,
    cursor: first.nextCursor,
    capabilities,
  })).rejects.toMatchObject({ status: 409, code: 'CollaborationCursorExpired' })
})

test('hard-bounds curated context pages to ten payload-heavy items', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const actor = { id: 'author@example.com', displayName: 'Author' }
  const worstCaseText = '\uD800'.repeat(20_000)
  const rows = Array.from({ length: 12 }, (_, index) => {
    const id = `ctx-${String(index).padStart(2, '0')}`
    const createdAt = new Date(Date.UTC(2026, 6, 12, 0, index)).toISOString()
    return [{
      entityKey,
      recordKey: `CONTEXT#${id}`,
      entryType: 'context',
      schemaVersion: 1,
      id,
      teamId: 'team-a',
      workItemId: 'issue-1',
      kind: 'context',
      state: 'active',
      title: `Context ${index}`,
      body: worstCaseText,
      source: {
        kind: 'activity',
        sourceId: `event-${index}`,
        originalBody: worstCaseText,
        quote: { text: worstCaseText },
        occurredAt: createdAt,
        availability: 'available',
      },
      mentionMemberKeys: [],
      createdBy: actor,
      createdAt,
      updatedBy: actor,
      updatedAt: createdAt,
      revision: 1,
    }, {
      entityKey,
      recordKey: `CONTEXT_ORDER#${createdAt}#${id}`,
      entryType: 'context-order',
      itemId: id,
      createdAt,
    }]
  }).flat()
  const memory = createCollaborationMemory(rows)

  const page = await memory.client.getCuratedContext({
    entityKey,
    limit: 100,
    capabilities: {
      canCreate: true,
      canEdit: true,
      canReplace: true,
      canAcceptResolution: true,
    },
  })

  expect(page.items).toHaveLength(10)
  expect(page.items[0]?.id).toBe('ctx-11')
  expect(page.nextCursor).toBeString()
  expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(6 * 1024 * 1024)
})

test('hard-bounds and strictly validates curated context revision pages', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const actor = { id: 'author@example.com', displayName: 'Author' }
  const snapshots = Array.from({ length: 12 }, (_, index) => {
    const revision = index + 1
    const updatedAt = new Date(Date.UTC(2026, 6, 12, 0, revision)).toISOString()
    return {
      schemaVersion: 1,
      id: 'ctx-history',
      teamId: 'team-a',
      workItemId: 'issue-1',
      kind: 'decision',
      state: 'active',
      title: `Decision revision ${revision}`,
      body: `Body revision ${revision}`,
      mentionMemberKeys: [],
      createdBy: actor,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedBy: actor,
      updatedAt,
      revision,
    }
  })
  const current = snapshots.at(-1)
  if (!current) throw new Error('Expected a current context fixture.')
  const memory = createCollaborationMemory([{
    ...current,
    entityKey,
    recordKey: 'CONTEXT#ctx-history',
    entryType: 'context',
  }, ...snapshots.map((snapshot) => ({
    entityKey,
    recordKey: `CONTEXT_REVISION#ctx-history#${String(snapshot.revision).padStart(12, '0')}`,
    entryType: 'context-revision',
    itemId: 'ctx-history',
    revision: snapshot.revision,
    snapshot,
    createdAt: snapshot.updatedAt,
  }))])

  const page = await memory.client.getCuratedContextRevisions({
    entityKey,
    itemId: 'ctx-history',
    limit: 100,
  })
  expect(page.items.map((item) => item.revision)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
  expect(page.nextCursor).toBeString()

  const latestKey = `${entityKey}\0CONTEXT_REVISION#ctx-history#000000000012`
  const latest = memory.rows.get(latestKey)
  if (!latest || !isTestRecord(latest.snapshot)) {
    throw new Error('Expected the latest context revision fixture.')
  }
  memory.rows.set(latestKey, {
    ...latest,
    snapshot: { ...latest.snapshot, id: 'ctx-other' },
  })
  await expect(memory.client.getCuratedContextRevisions({
    entityKey,
    itemId: 'ctx-history',
    limit: 1,
  })).rejects.toMatchObject({ status: 503, code: 'InvalidCollaborationRecord' })
})

test('preserves source line endings while validating curated context quote ranges', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const source: CuratedContextSource = {
    kind: 'activity',
    sourceId: 'event-line-endings',
    originalBody: 'line one\r\nline two',
    quote: { text: 'line one\r\nline two', startOffset: 0, endOffset: 18 },
    occurredAt: '2026-07-11T23:59:00.000Z',
    availability: 'available',
  }
  const memory = createCollaborationMemory([], 'audit-table')

  const created = await memory.client.createCuratedContextItem({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    workItemTitle: 'Line ending evidence',
    actor: { id: 'author@example.com', displayName: 'Author' },
    kind: 'decision',
    title: 'Preserve source line endings',
    body: 'The captured source retains its original line endings.',
    source,
    activitySourceAuthorizationSnapshot: {
      sourceId: source.sourceId,
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    },
    auditContext: createTestAuditContext(
      'line-ending-context',
      '2026-07-12T00:00:00.000Z',
      { title: 'Preserve source line endings' },
    ),
  })

  expect(created.source).toEqual(source)
})

test('creates, revision-fences, and atomically supersedes curated context with history and watchers', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const memory = createCollaborationMemory([], 'audit-table')
  const scope = {
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    workItemTitle: 'Decision target',
  }
  const actor = { id: 'Author@Example.com', displayName: 'Author' }
  const source: CuratedContextSource = {
    kind: 'activity',
    sourceId: 'event-1',
    originalBody: 'Regression suite passed.',
    quote: { text: 'Regression suite passed.' },
    occurredAt: '2026-07-11T23:59:00.000Z',
    availability: 'available',
  }
  const created = await memory.client.createCuratedContextItem({
    ...scope,
    actor,
    kind: 'decision',
    title: 'Choose option A',
    body: 'Option A is the accepted direction.',
    source,
    activitySourceAuthorizationSnapshot: {
      sourceId: source.sourceId,
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    },
    mentionMemberKeys: ['Reviewer@Example.com'],
    auditContext: createTestAuditContext(
      'context-create',
      '2026-07-12T00:00:00.000Z',
      { title: 'Choose option A' },
    ),
  })
  expect(created).toMatchObject({ revision: 1, state: 'active' })

  const createReplay = await memory.client.createCuratedContextItem({
    ...scope,
    actor,
    kind: 'decision',
    title: 'Choose option A',
    body: 'Option A is the accepted direction.',
    source,
    activitySourceAuthorizationSnapshot: {
      sourceId: source.sourceId,
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    },
    mentionMemberKeys: ['Reviewer@Example.com'],
    auditContext: createTestAuditContext(
      'context-create',
      '2026-07-12T00:00:30.000Z',
      { title: 'Choose option A' },
    ),
  })
  expect(createReplay).toEqual(created)
  expect(memory.transactions).toHaveLength(1)

  memory.reportNextCommittedTransactionAsConditionalFailure()
  const updated = await memory.client.updateCuratedContextItem({
    ...scope,
    actor,
    itemId: created.id,
    expectedRevision: 1,
    state: 'accepted',
    body: 'Option A is approved.',
    auditContext: createTestAuditContext(
      'context-update',
      '2026-07-12T00:01:00.000Z',
      { expectedRevision: 1 },
    ),
  })
  expect(updated).toMatchObject({ revision: 2, state: 'accepted', body: 'Option A is approved.' })

  const updateReplay = await memory.client.updateCuratedContextItem({
    ...scope,
    actor,
    itemId: created.id,
    expectedRevision: 1,
    state: 'accepted',
    body: 'Option A is approved.',
    auditContext: createTestAuditContext(
      'context-update',
      '2026-07-12T00:01:30.000Z',
      { expectedRevision: 1 },
    ),
  })
  expect(updateReplay).toEqual(updated)
  expect(memory.transactions).toHaveLength(2)

  await expect(memory.client.updateCuratedContextItem({
    ...scope,
    actor,
    itemId: created.id,
    expectedRevision: 1,
    title: 'Stale update',
  })).rejects.toMatchObject({ status: 409, code: 'ContextRevisionConflict' })

  const replacement = await memory.client.createCuratedContextItem({
    ...scope,
    actor,
    kind: 'decision',
    title: 'Choose option B',
    body: 'New evidence makes option B preferable.',
    supersedesItemId: created.id,
    auditContext: createTestAuditContext(
      'context-replace',
      '2026-07-12T00:02:00.000Z',
      { supersedesItemId: created.id },
    ),
  })
  const superseded = await memory.client.getCuratedContextItemSnapshot({
    entityKey,
    itemId: created.id,
  })
  expect(replacement).toMatchObject({ revision: 1, state: 'active' })
  expect(replacement.source).toEqual(created.source)
  expect(superseded).toMatchObject({
    revision: 3,
    state: 'superseded',
    supersededByItemId: replacement.id,
  })
  expect([...memory.rows.values()].filter((row) =>
    typeof row.recordKey === 'string' && row.recordKey.startsWith('CONTEXT_REVISION#')
  )).toHaveLength(4)
  const firstRevisionPage = await memory.client.getCuratedContextRevisions({
    entityKey,
    itemId: created.id,
    limit: 2,
  })
  expect(firstRevisionPage.items.map((item) => item.revision)).toEqual([3, 2])
  expect(firstRevisionPage.nextCursor).toBeString()
  const secondRevisionPage = await memory.client.getCuratedContextRevisions({
    entityKey,
    itemId: created.id,
    limit: 2,
    cursor: firstRevisionPage.nextCursor,
  })
  expect(secondRevisionPage.items.map((item) => item.revision)).toEqual([1])
  expect(secondRevisionPage.nextCursor).toBeUndefined()
  await expect(memory.client.getCuratedContextRevisions({
    entityKey,
    itemId: replacement.id,
    cursor: firstRevisionPage.nextCursor,
  })).rejects.toMatchObject({ status: 400, code: 'InvalidCollaborationCursor' })

  const auditEventTypes = memory.transactions.flatMap((transaction) => {
    if (!Array.isArray(transaction.TransactItems)) return []
    return transaction.TransactItems.flatMap((item) => {
      if (!isTestRecord(item) || !isTestRecord(item.Put) || !isTestRecord(item.Put.Item)) return []
      return typeof item.Put.Item.eventType === 'string' ? [item.Put.Item.eventType] : []
    })
  })
  expect(auditEventTypes).toEqual(expect.arrayContaining([
    'context-item.created',
    'context-item.updated',
    'context-item.superseded',
  ]))
  const auditSummaries = memory.transactions.flatMap((transaction) => {
    if (!Array.isArray(transaction.TransactItems)) return []
    return transaction.TransactItems.flatMap((item) => {
      if (!isTestRecord(item) || !isTestRecord(item.Put) || !isTestRecord(item.Put.Item)) return []
      return typeof item.Put.Item.summary === 'string' ? [item.Put.Item.summary] : []
    })
  })
  expect(auditSummaries).toEqual(expect.arrayContaining([
    'Curated decision “Choose option A” was created.',
    'Curated decision “Choose option A” was updated.',
    'Curated decision “Choose option A” was superseded.',
  ]))
  const watcherRecordKeys = memory.transactions.flatMap((transaction) => {
    if (!Array.isArray(transaction.TransactItems)) return []
    return transaction.TransactItems.flatMap((item) => {
      if (!isTestRecord(item) || !isTestRecord(item.Update) || !isTestRecord(item.Update.Key)) return []
      return typeof item.Update.Key.recordKey === 'string' ? [item.Update.Key.recordKey] : []
    })
  })
  expect(watcherRecordKeys).toEqual(expect.arrayContaining([
    'WATCHER#author@example.com',
    'WATCHER#reviewer@example.com',
  ]))
})

test('fences a captured Document source and its authorization generation in the create transaction', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const memory = createCollaborationMemory([], 'audit-table')
  const actor = { id: 'author@example.com', displayName: 'Author' }
  await memory.client.createCuratedContextItem({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    actor,
    authorizationSnapshot: {
      memberKey: actor.id,
      workspaceMemberVersion: 4,
    },
    kind: 'decision',
    title: 'Use the current document policy',
    body: 'The decision was captured while the source was readable.',
    source: {
      kind: 'document',
      sourceId: 'document-1',
      capturedRevision: 7,
      currentRevision: 7,
      occurredAt: '2026-07-12T00:00:00.000Z',
      availability: 'available',
    },
    sourceAuthorizationSnapshot: {
      sourceId: 'document-1',
      documentRevision: 7,
      documentAuthorizationRevision: 3,
      workspaceMemberKey: actor.id,
      workspaceMemberVersion: 4,
      planningRevision: 9,
    },
    auditContext: createTestAuditContext(
      'document-context-create',
      '2026-07-12T00:00:00.000Z',
    ),
  })

  const transactionItems = memory.transactions[0]?.TransactItems
  if (!Array.isArray(transactionItems)) {
    throw new Error('Expected a context create transaction.')
  }
  const conditions = transactionItems.filter((item): item is Record<string, unknown> =>
    isTestRecord(item) && isTestRecord(item.ConditionCheck),
  )
  expect(conditions).toContainEqual(expect.objectContaining({
    ConditionCheck: expect.objectContaining({
      TableName: 'mukuroji-documents-local',
      Key: {
        workspaceId: 'workspace#one',
        recordKey: 'DOCUMENT#document-1',
      },
      ExpressionAttributeValues: expect.objectContaining({
        ':documentRevision': 7,
      }),
    }),
  }))
  expect(conditions).toContainEqual(expect.objectContaining({
    ConditionCheck: expect.objectContaining({
      TableName: 'mukuroji-documents-local',
      Key: {
        workspaceId: 'workspace#one',
        recordKey: 'DOCUMENT_AUTHORIZATION_REVISION',
      },
      ExpressionAttributeValues: expect.objectContaining({
        ':documentAuthorizationRevision': 3,
      }),
    }),
  }))
  expect(conditions).toContainEqual(expect.objectContaining({
    ConditionCheck: expect.objectContaining({
      TableName: 'mukuroji-planning-local',
      Key: {
        workspaceId: 'workspace#one',
        recordKey: 'META',
      },
      ExpressionAttributeValues: expect.objectContaining({
        ':planningRevision': 9,
      }),
    }),
  }))
})

test('deduplicates the Enterprise control fence when mutation and source snapshots agree', async () => {
  const configuredTableName = Bun.env.ENTERPRISE_IDENTITY_TABLE_NAME
  Bun.env.ENTERPRISE_IDENTITY_TABLE_NAME = 'enterprise-identity-table'
  try {
    const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
    const memory = createCollaborationMemory([], 'audit-table')
    const actor = { id: 'author@example.com', displayName: 'Author' }
    await memory.client.createCuratedContextItem({
      workspaceId: 'workspace#one',
      teamId: 'team-a',
      issueId: 'issue-1',
      entityKey,
      actor,
      authorizationSnapshot: {
        memberKey: actor.id,
        workspaceMemberVersion: 4,
        enterpriseControlRevision: 11,
      },
      kind: 'decision',
      title: 'Use one Enterprise fence',
      body: 'The mutation and source observed the same authorization generation.',
      source: {
        kind: 'document',
        sourceId: 'document-1',
        capturedRevision: 7,
        currentRevision: 7,
        occurredAt: '2026-07-12T00:00:00.000Z',
        availability: 'available',
      },
      sourceAuthorizationSnapshot: {
        sourceId: 'document-1',
        documentRevision: 7,
        documentAuthorizationRevision: 3,
        workspaceMemberKey: actor.id,
        workspaceMemberVersion: 4,
        planningRevision: 9,
        enterpriseControlRevision: 11,
      },
    })

    const transactionItems = memory.transactions[0]?.TransactItems
    if (!Array.isArray(transactionItems)) {
      throw new Error('Expected a context create transaction.')
    }
    const enterpriseConditions = transactionItems.filter((item): item is Record<string, unknown> => {
      if (!isTestRecord(item) || !isTestRecord(item.ConditionCheck)) return false
      const condition = item.ConditionCheck
      return condition.TableName === 'enterprise-identity-table' &&
        isTestRecord(condition.Key) && condition.Key.recordKey === 'CONTROL'
    })
    expect(enterpriseConditions).toHaveLength(1)
  } finally {
    if (configuredTableName === undefined) {
      delete Bun.env.ENTERPRISE_IDENTITY_TABLE_NAME
    } else {
      Bun.env.ENTERPRISE_IDENTITY_TABLE_NAME = configuredTableName
    }
  }
})

test('fences Activity source capture against the audit retention deadline', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const memory = createCollaborationMemory([], 'audit-table')
  const expiresAt = Math.floor(Date.now() / 1_000) + 300
  await memory.client.createCuratedContextItem({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    actor: { id: 'author@example.com', displayName: 'Author' },
    kind: 'decision',
    title: 'Use the audit result',
    body: 'The activity event remains within retention.',
    source: {
      kind: 'activity',
      sourceId: 'event-1',
      occurredAt: '2026-07-12T00:00:00.000Z',
      availability: 'available',
    },
    activitySourceAuthorizationSnapshot: {
      sourceId: 'event-1',
      expiresAt,
    },
    auditContext: createTestAuditContext(
      'activity-context-create',
      '2026-07-12T00:00:00.000Z',
    ),
  })

  const transactionItems = memory.transactions[0]?.TransactItems
  if (!Array.isArray(transactionItems)) {
    throw new Error('Expected an Activity context create transaction.')
  }
  expect(transactionItems).toContainEqual(expect.objectContaining({
    ConditionCheck: expect.objectContaining({
      TableName: 'mukuroji-audit-events',
      Key: {
        directoryId: 'workspace#one',
        eventId: 'event-1',
      },
      ExpressionAttributeValues: expect.objectContaining({
        ':capturedExpiresAt': expiresAt,
        ':nowEpoch': expect.any(Number),
      }),
    }),
  }))
})

test('rejects Activity source capture with insufficient retention headroom', async () => {
  const memory = createCollaborationMemory([], 'audit-table')
  const expiresAt = Math.floor(Date.now() / 1_000) + 1

  await expect(memory.client.createCuratedContextItem({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey: createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1'),
    actor: { id: 'author@example.com', displayName: 'Author' },
    kind: 'decision',
    title: 'Reject a nearly expired source',
    body: 'The source should not cross its retention boundary during commit.',
    source: {
      kind: 'activity',
      sourceId: 'event-nearly-expired',
      occurredAt: '2026-07-12T00:00:00.000Z',
      availability: 'available',
    },
    activitySourceAuthorizationSnapshot: {
      sourceId: 'event-nearly-expired',
      expiresAt,
    },
  })).rejects.toMatchObject({
    status: 400,
    code: 'InvalidActivitySourceAuthorizationSnapshot',
  })
})

test('replays immutable curated-context mutation responses after later revisions', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const memory = createCollaborationMemory([], 'audit-table')
  const scope = {
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
  }
  const actor = { id: 'author@example.com', displayName: 'Author' }
  const createRequestBody = { title: 'Durable decision', body: 'Original response body.' }
  const createContext = createTestAuditContext(
    'durable-create',
    '2026-07-12T03:00:00.000Z',
    createRequestBody,
  )
  const created = await memory.client.createCuratedContextItem({
    ...scope,
    actor,
    kind: 'decision',
    title: createRequestBody.title,
    body: createRequestBody.body,
    auditContext: createContext,
  })
  const laterUpdate = await memory.client.updateCuratedContextItem({
    ...scope,
    actor,
    itemId: created.id,
    expectedRevision: 1,
    body: 'A later response body.',
    auditContext: createTestAuditContext(
      'later-update',
      '2026-07-12T03:01:00.000Z',
      { expectedRevision: 1, body: 'A later response body.' },
    ),
  })
  expect(laterUpdate.revision).toBe(2)

  const replayedCreate = await memory.client.createCuratedContextItem({
    ...scope,
    actor,
    kind: 'decision',
    title: createRequestBody.title,
    body: createRequestBody.body,
    auditContext: createTestAuditContext(
      'durable-create',
      '2026-07-12T03:02:00.000Z',
      createRequestBody,
    ),
  })
  expect(replayedCreate).toEqual(created)

  const durableUpdateBody = { expectedRevision: 2, title: 'Durable updated title' }
  const durableUpdate = await memory.client.updateCuratedContextItem({
    ...scope,
    actor,
    itemId: created.id,
    expectedRevision: 2,
    title: durableUpdateBody.title,
    auditContext: createTestAuditContext(
      'durable-update',
      '2026-07-12T03:03:00.000Z',
      durableUpdateBody,
    ),
  })
  const finalUpdate = await memory.client.updateCuratedContextItem({
    ...scope,
    actor,
    itemId: created.id,
    expectedRevision: 3,
    state: 'accepted',
    auditContext: createTestAuditContext(
      'final-update',
      '2026-07-12T03:04:00.000Z',
      { expectedRevision: 3, state: 'accepted' },
    ),
  })
  expect(finalUpdate).toMatchObject({ revision: 4, state: 'accepted' })

  const replayedUpdate = await memory.client.updateCuratedContextItem({
    ...scope,
    actor,
    itemId: created.id,
    expectedRevision: 2,
    title: durableUpdateBody.title,
    auditContext: createTestAuditContext(
      'durable-update',
      '2026-07-12T03:05:00.000Z',
      durableUpdateBody,
    ),
  })
  expect(replayedUpdate).toEqual(durableUpdate)
  expect(memory.transactions).toHaveLength(4)

  await expect(memory.client.createCuratedContextItem({
    ...scope,
    actor,
    kind: 'risk',
    title: 'Reused key with different input',
    body: 'This must not create another item.',
    auditContext: createTestAuditContext(
      'durable-create',
      '2026-07-12T03:06:00.000Z',
      { title: 'Different fingerprint' },
    ),
  })).rejects.toMatchObject({
    status: 409,
    code: 'CollaborationIdempotencyConflict',
  })
  expect(memory.transactions).toHaveLength(4)
})

test('reconciles lifecycle-only revisions, edits, deletion, and missing comment sources', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const sourceBody = 'The selected evidence remains immutable.'
  const comment = {
    entityKey,
    recordKey: 'COMMENT#reply-1',
    entryType: 'comment',
    id: 'reply-1',
    rootCommentId: 'root-1',
    parentCommentId: 'root-1',
    authorMemberKey: 'reply@example.com',
    bodyMarkdown: sourceBody,
    version: 2,
    mentionMemberKeys: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:01:00.000Z',
  }
  const context = {
    entityKey,
    recordKey: 'CONTEXT#ctx-source',
    entryType: 'context',
    schemaVersion: 1,
    id: 'ctx-source',
    teamId: 'team-a',
    workItemId: 'issue-1',
    kind: 'context',
    state: 'active',
    title: 'Source evidence',
    body: 'Retained source evidence.',
    source: {
      kind: 'comment',
      sourceId: 'reply-1',
      containerId: 'root-1',
      originalBody: sourceBody,
      quote: { text: 'selected evidence', startOffset: 4, endOffset: 21 },
      actor: { id: 'reply@example.com', displayName: 'Reply Author' },
      occurredAt: '2026-07-12T00:00:00.000Z',
      capturedRevision: 1,
      currentRevision: 1,
      availability: 'available',
    },
    mentionMemberKeys: [],
    createdBy: { id: 'author@example.com', displayName: 'Author' },
    createdAt: '2026-07-12T00:00:30.000Z',
    updatedBy: { id: 'author@example.com', displayName: 'Author' },
    updatedAt: '2026-07-12T00:00:30.000Z',
    revision: 1,
  }
  const memory = createCollaborationMemory([comment, context])

  const lifecycleUpdated = await memory.client.getCuratedContextItemSnapshot({
    entityKey,
    itemId: 'ctx-source',
  })
  expect(lifecycleUpdated?.source).toMatchObject({
    originalBody: sourceBody,
    availability: 'available',
    currentRevision: 2,
  })

  memory.rows.set(`${entityKey}\0COMMENT#reply-1`, {
    ...comment,
    bodyMarkdown: 'Edited current body',
    version: 3,
  })
  const edited = await memory.client.getCuratedContextItemSnapshot({
    entityKey,
    itemId: 'ctx-source',
  })
  expect(edited?.source).toMatchObject({
    originalBody: sourceBody,
    quote: { text: 'selected evidence', startOffset: 4, endOffset: 21 },
    availability: 'edited',
    currentRevision: 3,
  })
  expect(edited?.source).not.toHaveProperty('currentBody')

  memory.rows.set(`${entityKey}\0COMMENT#reply-1`, {
    ...comment,
    bodyMarkdown: '',
    version: 4,
    deletedAt: '2026-07-12T00:02:00.000Z',
  })
  const deleted = await memory.client.getCuratedContextItemSnapshot({
    entityKey,
    itemId: 'ctx-source',
  })
  expect(deleted?.source).toMatchObject({
    originalBody: sourceBody,
    availability: 'deleted',
    currentRevision: 4,
  })

  memory.rows.delete(`${entityKey}\0COMMENT#reply-1`)
  const missing = await memory.client.getCuratedContextItemSnapshot({
    entityKey,
    itemId: 'ctx-source',
  })
  expect(missing?.source).toMatchObject({ originalBody: sourceBody, availability: 'deleted' })
  expect(missing?.source?.currentRevision).toBeUndefined()
})

test('fences captured comment creation and preserves immutable provenance during edits', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const actor = { id: 'author@example.com', displayName: 'Author' }
  const createSourceComment = {
    entityKey,
    recordKey: 'COMMENT#reply-create',
    entryType: 'comment',
    id: 'reply-create',
    rootCommentId: 'root-1',
    parentCommentId: 'root-1',
    authorMemberKey: 'reply@example.com',
    bodyMarkdown: 'Create evidence',
    version: 1,
    mentionMemberKeys: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const updateSourceComment = {
    ...createSourceComment,
    recordKey: 'COMMENT#reply-update',
    id: 'reply-update',
    bodyMarkdown: 'Update evidence',
  }
  const existingContext = {
    entityKey,
    recordKey: 'CONTEXT#ctx-existing',
    entryType: 'context',
    schemaVersion: 1,
    id: 'ctx-existing',
    teamId: 'team-a',
    workItemId: 'issue-1',
    kind: 'context',
    state: 'active',
    title: 'Existing context',
    body: 'Existing body',
    source: {
      kind: 'comment',
      sourceId: 'reply-update',
      containerId: 'root-1',
      originalBody: 'Update evidence',
      quote: { text: 'Update evidence' },
      occurredAt: updateSourceComment.createdAt,
      capturedRevision: 1,
      availability: 'available',
    },
    mentionMemberKeys: [],
    createdBy: actor,
    createdAt: '2026-07-12T00:00:30.000Z',
    updatedBy: actor,
    updatedAt: '2026-07-12T00:00:30.000Z',
    revision: 1,
  }
  const memory = createCollaborationMemory([
    createSourceComment,
    updateSourceComment,
    existingContext,
  ])
  const scope = {
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
  }

  memory.mutateCommentBeforeNextTransaction('reply-create')
  await expect(memory.client.createCuratedContextItem({
    ...scope,
    actor,
    kind: 'context',
    title: 'Racing create',
    body: 'Do not commit stale evidence.',
    source: {
      kind: 'comment',
      sourceId: 'reply-create',
      containerId: 'root-1',
      originalBody: 'Create evidence',
      quote: { text: 'Create evidence' },
      occurredAt: createSourceComment.createdAt,
      capturedRevision: 1,
      availability: 'available',
    },
  })).rejects.toMatchObject({
    status: 409,
    code: 'ContextSourceRevisionConflict',
  })

  memory.mutateCommentBeforeNextTransaction('reply-update')
  const updated = await memory.client.updateCuratedContextItem({
    ...scope,
    actor,
    itemId: 'ctx-existing',
    expectedRevision: 1,
    title: 'Edited context',
  })
  expect(updated).toMatchObject({
    title: 'Edited context',
    source: {
      sourceId: 'reply-update',
      originalBody: 'Update evidence',
      capturedRevision: 1,
    },
  })
})

/**
 * Creates the accepted-resolution state used by append-only, pagination, and rejection tests.
 *
 * @returns A memory client after selecting, editing, replacing, and replaying one resolution.
 */
async function createAcceptedResolutionHistoryState() {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  /** Creates a physical comment seed row for accepted-resolution tests. */
  const commentRow = (
    id: string,
    rootCommentId: string,
    bodyMarkdown: string,
    deletedAt?: string,
  ) => ({
    entityKey,
    recordKey: `COMMENT#${id}`,
    entryType: 'comment',
    id,
    rootCommentId,
    ...(id === rootCommentId ? {} : { parentCommentId: rootCommentId }),
    authorMemberKey: id === rootCommentId ? 'author@example.com' : `${id}@example.com`,
    bodyMarkdown,
    version: 1,
    mentionMemberKeys: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...(deletedAt ? { deletedAt } : {}),
  })
  const memory = createCollaborationMemory([
    commentRow('root-1', 'root-1', 'Question'),
    commentRow('reply-1', 'root-1', 'First answer'),
    commentRow('reply-2', 'root-1', 'Second answer'),
    commentRow('reply-3', 'root-1', 'Third answer'),
    commentRow('other-reply', 'other-root', 'Other thread answer'),
    commentRow('deleted-reply', 'root-1', '', '2026-07-12T00:01:00.000Z'),
  ], 'audit-table')
  const scope = {
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
  }
  const actor = { id: 'author@example.com', displayName: 'Author' }
  const firstInput = {
    ...scope,
    rootCommentId: 'root-1',
    commentId: 'reply-1',
    summary: 'Use the first answer.',
    expectedThreadVersion: 1,
    actor,
    canModerate: false,
    auditContext: createTestAuditContext(
      'resolution-select',
      '2026-07-12T00:01:00.000Z',
      { commentId: 'reply-1', summary: 'Use the first answer.' },
    ),
  }
  memory.reportNextCommittedTransactionAsConditionalFailure()
  const first = await memory.client.setAcceptedResolution(firstInput)
  expect(first.acceptedResolutions).toHaveLength(1)
  expect(first.acceptedResolutions[0]).toMatchObject({
    sourceCommentId: 'reply-1',
    capturedCommentRevision: 1,
    capturedCommentBody: 'First answer',
    state: 'accepted',
  })
  /** Counts append-only resolution rows without inspecting root history fields. */
  const resolutionRowCount = () => [...memory.rows.values()].filter((row) =>
    typeof row.recordKey === 'string' && row.recordKey.startsWith('RESOLUTION#root-1#')
  ).length
  expect(resolutionRowCount()).toBe(1)
  const replay = await memory.client.setAcceptedResolution(firstInput)
  expect(replay.version).toBe(2)
  expect(resolutionRowCount()).toBe(1)

  const selectedReplyKey = `${entityKey}\0COMMENT#reply-1`
  const selectedReply = memory.rows.get(selectedReplyKey)
  if (!selectedReply) throw new Error('Expected the selected reply fixture.')
  memory.rows.set(selectedReplyKey, {
    ...selectedReply,
    bodyMarkdown: '',
    deletedAt: '2026-07-12T00:01:30.000Z',
    updatedAt: '2026-07-12T00:01:30.000Z',
    version: 2,
  })

  const edited = await memory.client.setAcceptedResolution({
    ...scope,
    rootCommentId: 'root-1',
    commentId: 'reply-1',
    summary: 'Use the first answer with the manual clarification.',
    expectedThreadVersion: 2,
    actor,
    canModerate: false,
    auditContext: createTestAuditContext(
      'resolution-edit',
      '2026-07-12T00:02:00.000Z',
      { commentId: 'reply-1', summary: 'Use the first answer with the manual clarification.' },
    ),
  })
  expect(edited.acceptedResolutions).toHaveLength(1)
  expect(edited.acceptedResolutions[0]).toMatchObject({
    capturedCommentBody: 'First answer',
    capturedCommentRevision: 1,
    sourceCommentId: 'reply-1',
    state: 'accepted',
  })
  expect(resolutionRowCount()).toBe(3)

  const replaced = await memory.client.setAcceptedResolution({
    ...scope,
    rootCommentId: 'root-1',
    commentId: 'reply-2',
    summary: 'Use the newer second answer.',
    expectedThreadVersion: 3,
    actor,
    canModerate: false,
    auditContext: createTestAuditContext(
      'resolution-replace',
      '2026-07-12T00:03:00.000Z',
      { commentId: 'reply-2', summary: 'Use the newer second answer.' },
    ),
  })
  expect(replaced.acceptedResolutions).toHaveLength(1)
  expect(replaced.acceptedResolutions[0]).toMatchObject({
    sourceCommentId: 'reply-2',
    state: 'accepted',
  })
  expect(resolutionRowCount()).toBe(5)
  const replacementRows = [...memory.rows.values()]
    .filter((row) => row.entryType === 'accepted-resolution' &&
      row.recordedAt === '2026-07-12T00:03:00.000Z')
    .sort((left, right) => String(right.recordKey).localeCompare(String(left.recordKey)))
  expect(replacementRows[0]).toMatchObject({ resolution: { state: 'accepted' } })
  expect(replacementRows[1]).toMatchObject({ resolution: { state: 'superseded' } })

  const replayAfterReplacement = await memory.client.setAcceptedResolution(firstInput)
  expect(resolutionRowCount()).toBe(5)

  return {
    actor,
    entityKey,
    first,
    firstInput,
    memory,
    replay,
    replayAfterReplacement,
    replaced,
    resolutionRowCount,
    scope,
  }
}

test('keeps accepted resolution history append-only through replacement and replay', async () => {
  const {
    entityKey,
    first,
    firstInput,
    memory,
    replay,
    replayAfterReplacement,
    replaced,
    resolutionRowCount,
  } = await createAcceptedResolutionHistoryState()

  expect(first.acceptedResolutions).toHaveLength(1)
  expect(first.acceptedResolutions[0]).toMatchObject({
    sourceCommentId: 'reply-1',
    capturedCommentRevision: 1,
    capturedCommentBody: 'First answer',
    state: 'accepted',
  })
  const physicalRoot = memory.rows.get(`${entityKey}\0COMMENT#root-1`)
  expect(physicalRoot).not.toHaveProperty('acceptedResolutions')
  expect(physicalRoot?.acceptedResolutionId).toBe(
    replaced.acceptedResolutions[0]?.id,
  )
  expect(physicalRoot?.acceptedResolution).toMatchObject({
    id: replaced.acceptedResolutions[0]?.id,
    state: 'accepted',
  })
  expect(replay.version).toBe(2)
  expect(replayAfterReplacement).toMatchObject({
    version: 2,
    acceptedResolutions: [{
      sourceCommentId: 'reply-1',
      summary: 'Use the first answer.',
      state: 'accepted',
    }],
  })
  expect(resolutionRowCount()).toBe(5)
  expect(firstInput.commentId).toBe('reply-1')
})

test('rejects accepted-resolution pointers and snapshots that are not paired', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const resolution = {
    id: 'resolution-current',
    sourceCommentId: 'reply-1',
    sourceRootCommentId: 'root-malformed',
    capturedCommentRevision: 1,
    capturedCommentBody: 'Answer',
    summary: 'Use the answer.',
    acceptedBy: { id: 'author@example.com', displayName: 'Author' },
    acceptedAt: '2026-07-12T00:01:00.000Z',
    state: 'accepted' as const,
  }
  const root = {
    entityKey,
    recordKey: 'COMMENT#root-malformed',
    entryType: 'comment',
    id: 'root-malformed',
    rootCommentId: 'root-malformed',
    authorMemberKey: 'author@example.com',
    bodyMarkdown: 'Question',
    version: 1,
    mentionMemberKeys: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const malformedRoots = [
    { ...root, acceptedResolutionId: resolution.id },
    { ...root, acceptedResolution: resolution },
    {
      ...root,
      acceptedResolutionId: resolution.id,
      acceptedResolution: { ...resolution, id: 'resolution-other' },
    },
  ]

  for (const malformedRoot of malformedRoots) {
    const memory = createCollaborationMemory([malformedRoot])
    await expect(memory.client.getCommentSnapshot({
      entityKey,
      commentId: root.id,
    })).rejects.toMatchObject({ status: 503, code: 'InvalidCollaborationRecord' })
  }
})

test('paginates accepted-resolution history with a scope-bound cursor', async () => {
  const { entityKey, memory } = await createAcceptedResolutionHistoryState()

  const firstHistoryPage = await memory.client.getAcceptedResolutionHistory({
    entityKey,
    rootCommentId: 'root-1',
    limit: 2,
  })
  expect(firstHistoryPage.items).toHaveLength(2)
  expect(firstHistoryPage.items.map((resolution) => resolution.state)).toEqual([
    'accepted',
    'superseded',
  ])
  expect(firstHistoryPage.nextCursor).toBeString()
  const secondHistoryPage = await memory.client.getAcceptedResolutionHistory({
    entityKey,
    rootCommentId: 'root-1',
    limit: 2,
    cursor: firstHistoryPage.nextCursor,
  })
  expect(secondHistoryPage.items).toHaveLength(1)
  expect(secondHistoryPage.items[0]).toMatchObject({ state: 'superseded' })
  expect(secondHistoryPage.nextCursor).toBeUndefined()
  await expect(memory.client.getAcceptedResolutionHistory({
    entityKey: createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-2'),
    rootCommentId: 'root-1',
    cursor: firstHistoryPage.nextCursor,
  })).rejects.toMatchObject({ status: 400, code: 'InvalidCollaborationCursor' })
})

test('rejects an accepted-resolution cursor when the root pointer changes', async () => {
  const { actor, entityKey, memory, scope } = await createAcceptedResolutionHistoryState()
  const firstHistoryPage = await memory.client.getAcceptedResolutionHistory({
    entityKey,
    rootCommentId: 'root-1',
    limit: 1,
  })
  expect(firstHistoryPage.nextCursor).toBeString()

  await memory.client.setAcceptedResolution({
    ...scope,
    rootCommentId: 'root-1',
    commentId: 'reply-3',
    summary: 'Use the third answer after the first history page.',
    expectedThreadVersion: 4,
    actor,
    canModerate: false,
  })

  await expect(memory.client.getAcceptedResolutionHistory({
    entityKey,
    rootCommentId: 'root-1',
    limit: 1,
    cursor: firstHistoryPage.nextCursor,
  })).rejects.toMatchObject({
    status: 409,
    code: 'AcceptedResolutionHistoryConflict',
  })
})

test('rejects invalid and concurrently edited accepted-resolution replies', async () => {
  const { actor, entityKey, memory, scope } =
    await createAcceptedResolutionHistoryState()
  await expect(memory.client.setAcceptedResolution({
    ...scope,
    rootCommentId: 'root-1',
    commentId: 'other-reply',
    summary: 'Invalid cross-thread source.',
    expectedThreadVersion: 4,
    actor,
    canModerate: false,
  })).rejects.toMatchObject({ status: 400, code: 'AcceptedResolutionCrossThread' })
  await expect(memory.client.setAcceptedResolution({
    ...scope,
    rootCommentId: 'root-1',
    commentId: 'deleted-reply',
    summary: 'Invalid deleted source.',
    expectedThreadVersion: 4,
    actor,
    canModerate: false,
  })).rejects.toMatchObject({ status: 409, code: 'AcceptedResolutionSourceDeleted' })
  await expect(memory.client.setAcceptedResolution({
    ...scope,
    rootCommentId: 'root-1',
    commentId: 'root-1',
    summary: 'Root is not a reply.',
    expectedThreadVersion: 4,
    actor,
    canModerate: false,
  })).rejects.toMatchObject({ status: 400, code: 'AcceptedResolutionNotReply' })

  memory.mutateCommentBeforeNextTransaction('reply-3', entityKey)
  await expect(memory.client.setAcceptedResolution({
    ...scope,
    rootCommentId: 'root-1',
    commentId: 'reply-3',
    summary: 'This capture races with an edit.',
    expectedThreadVersion: 4,
    actor,
    canModerate: false,
  })).rejects.toMatchObject({ status: 409, code: 'AcceptedResolutionSourceConflict' })
})

test('replays the accepted resolution safely after root deletion', async () => {
  const { actor, firstInput, memory, scope } =
    await createAcceptedResolutionHistoryState()
  await memory.client.deleteComment({
    ...scope,
    actorMemberKey: actor.id,
    commentId: 'root-1',
    expectedVersion: 4,
    auditContext: createTestAuditContext(
      'delete-root-after-resolution',
      '2026-07-12T00:05:00.000Z',
      { commentId: 'root-1' },
    ),
  })
  const replayAfterRootDeletion = await memory.client.setAcceptedResolution(firstInput)
  expect(replayAfterRootDeletion).toMatchObject({
    bodyMarkdown: '',
    mentionMemberKeys: [],
    deletedAt: '2026-07-12T00:05:00.000Z',
    acceptedResolutions: [{ capturedCommentBody: 'First answer' }],
  })
  expect(replayAfterRootDeletion.bodyMarkdown).not.toContain('Question')
})

test('rejects accepted-resolution idempotency key reuse without an audit table', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  /** Creates a physical comment row for the receipt collision test. */
  const commentRow = (id: string, rootCommentId: string, bodyMarkdown: string) => ({
    entityKey,
    recordKey: `COMMENT#${id}`,
    entryType: 'comment',
    id,
    rootCommentId,
    ...(id === rootCommentId ? {} : { parentCommentId: rootCommentId }),
    authorMemberKey: id === rootCommentId ? 'author@example.com' : `${id}@example.com`,
    bodyMarkdown,
    version: 1,
    mentionMemberKeys: [],
    createdAt: '2026-07-12T05:00:00.000Z',
    updatedAt: '2026-07-12T05:00:00.000Z',
  })
  const memory = createCollaborationMemory([
    commentRow('root-receipt', 'root-receipt', 'Question'),
    commentRow('reply-a', 'root-receipt', 'Answer A'),
    commentRow('reply-b', 'root-receipt', 'Answer B'),
  ])
  const scope = {
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    rootCommentId: 'root-receipt',
    actor: { id: 'author@example.com', displayName: 'Author' },
    canModerate: false,
  }
  const requestBody = {
    expectedThreadVersion: 1,
    commentId: 'reply-a',
    summary: 'Accept answer A.',
  }
  await memory.client.setAcceptedResolution({
    ...scope,
    ...requestBody,
    auditContext: createTestAuditContext(
      'accepted-receipt-collision',
      '2026-07-12T05:01:00.000Z',
      requestBody,
    ),
  })

  const conflictingInputs = [
    { ...requestBody, summary: 'A different summary.' },
    { ...requestBody, commentId: 'reply-b' },
    { ...requestBody, expectedThreadVersion: 2 },
  ]
  for (const [index, conflicting] of conflictingInputs.entries()) {
    await expect(memory.client.setAcceptedResolution({
      ...scope,
      ...conflicting,
      auditContext: createTestAuditContext(
        'accepted-receipt-collision',
        `2026-07-12T05:0${index + 2}:00.000Z`,
        conflicting,
      ),
    })).rejects.toMatchObject({
      status: 409,
      code: 'CollaborationIdempotencyConflict',
    })
  }
  expect(memory.transactions).toHaveLength(1)
})

test('hard-bounds large accepted resolution history pages and keeps cursors thread-scoped', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const actor = { id: 'author@example.com', displayName: 'Author' }
  const worstCaseText = '\uD800'.repeat(20_000)
  const current = {
    id: 'resolution-current',
    sourceCommentId: 'reply-current',
    sourceRootCommentId: 'root-many',
    capturedCommentRevision: 1,
    capturedCommentBody: worstCaseText,
    summary: worstCaseText,
    acceptedBy: actor,
    acceptedAt: '2026-07-13T00:00:00.000Z',
    state: 'accepted',
  }
  const historicalRows = Array.from({ length: 120 }, (_, index) => {
    const recordedAt = new Date(Date.UTC(2026, 6, 12, 0, 0, index)).toISOString()
    const id = `resolution-${String(index).padStart(3, '0')}`
    return {
      entityKey,
      recordKey: `RESOLUTION#root-many#${recordedAt}#${id}#superseded`,
      entryType: 'accepted-resolution',
      rootCommentId: 'root-many',
      resolution: {
        id,
        sourceCommentId: `reply-${index}`,
        sourceRootCommentId: 'root-many',
        capturedCommentRevision: 1,
        capturedCommentBody: index >= 110 ? worstCaseText : `Answer ${index}`,
        summary: index >= 110 ? worstCaseText : `Accepted answer ${index}.`,
        acceptedBy: actor,
        acceptedAt: recordedAt,
        state: 'superseded',
        supersededByResolutionId: 'resolution-current',
        supersededBy: actor,
        supersededAt: recordedAt,
      },
      recordedAt,
    }
  })
  const memory = createCollaborationMemory([
    {
      entityKey,
      recordKey: 'COMMENT#root-many',
      entryType: 'comment',
      id: 'root-many',
      rootCommentId: 'root-many',
      authorMemberKey: 'author@example.com',
      bodyMarkdown: 'Question',
      version: 121,
      mentionMemberKeys: [],
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      acceptedResolutionId: current.id,
      acceptedResolution: current,
    },
    ...historicalRows,
    {
      entityKey,
      recordKey: `RESOLUTION#root-many#${current.acceptedAt}#${current.id}#accepted`,
      entryType: 'accepted-resolution',
      rootCommentId: 'root-many',
      resolution: current,
      recordedAt: current.acceptedAt,
    },
  ])

  const first = await memory.client.getAcceptedResolutionHistory({
    entityKey,
    rootCommentId: 'root-many',
    limit: 100,
  })
  expect(first.items).toHaveLength(10)
  expect(first.items[0]).toMatchObject({ id: 'resolution-current', state: 'accepted' })
  expect(first.nextCursor).toBeString()
  expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(6 * 1024 * 1024)
  const second = await memory.client.getAcceptedResolutionHistory({
    entityKey,
    rootCommentId: 'root-many',
    limit: 100,
    cursor: first.nextCursor,
  })
  expect(second.items).toHaveLength(10)
  expect(second.nextCursor).toBeString()
  expect(new Set([...first.items, ...second.items].map((resolution) => resolution.id)).size)
    .toBe(20)

  await expect(memory.client.getAcceptedResolutionHistory({
    entityKey,
    rootCommentId: 'other-root',
    cursor: first.nextCursor,
  })).rejects.toMatchObject({ status: 400, code: 'InvalidCollaborationCursor' })
})

test('reads and incrementally migrates legacy inline accepted resolution history', async () => {
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const actor = { id: 'author@example.com', displayName: 'Author' }
  const legacySuperseded = {
    id: 'legacy-old',
    sourceCommentId: 'reply-old',
    sourceRootCommentId: 'root-legacy',
    capturedCommentRevision: 1,
    capturedCommentBody: 'Old answer',
    summary: 'Old accepted answer.',
    acceptedBy: actor,
    acceptedAt: '2026-07-12T00:01:00.000Z',
    state: 'superseded',
    supersededByResolutionId: 'legacy-current',
    supersededBy: actor,
    supersededAt: '2026-07-12T00:02:00.000Z',
  }
  const legacyCurrent = {
    id: 'legacy-current',
    sourceCommentId: 'reply-current',
    sourceRootCommentId: 'root-legacy',
    capturedCommentRevision: 1,
    capturedCommentBody: 'Legacy current answer',
    summary: 'Legacy current accepted answer.',
    acceptedBy: actor,
    acceptedAt: '2026-07-12T00:02:00.000Z',
    state: 'accepted',
  }
  const memory = createCollaborationMemory([{
    entityKey,
    recordKey: 'COMMENT#root-legacy',
    entryType: 'comment',
    id: 'root-legacy',
    rootCommentId: 'root-legacy',
    authorMemberKey: actor.id,
    bodyMarkdown: 'Legacy question',
    version: 5,
    mentionMemberKeys: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:02:00.000Z',
    acceptedResolutions: [legacySuperseded, legacyCurrent],
  }, {
    entityKey,
    recordKey: 'COMMENT#reply-new',
    entryType: 'comment',
    id: 'reply-new',
    rootCommentId: 'root-legacy',
    parentCommentId: 'root-legacy',
    authorMemberKey: 'reply@example.com',
    bodyMarkdown: 'New answer',
    version: 1,
    mentionMemberKeys: [],
    createdAt: '2026-07-12T00:03:00.000Z',
    updatedAt: '2026-07-12T00:03:00.000Z',
  }])

  const snapshot = await memory.client.getCommentSnapshot({
    entityKey,
    commentId: 'root-legacy',
  })
  expect(snapshot?.acceptedResolutions).toMatchObject([legacyCurrent])
  const firstLegacyPage = await memory.client.getAcceptedResolutionHistory({
    entityKey,
    rootCommentId: 'root-legacy',
    limit: 1,
  })
  expect(firstLegacyPage.nextCursor).toBeString()
  const secondLegacyPage = await memory.client.getAcceptedResolutionHistory({
    entityKey,
    rootCommentId: 'root-legacy',
    limit: 1,
    cursor: firstLegacyPage.nextCursor,
  })
  expect(new Set([
    ...firstLegacyPage.items,
    ...secondLegacyPage.items,
  ].map((resolution) => resolution.id))).toEqual(new Set(['legacy-current', 'legacy-old']))

  const migrated = await memory.client.setAcceptedResolution({
    workspaceId: 'workspace#one',
    teamId: 'team-a',
    issueId: 'issue-1',
    entityKey,
    rootCommentId: 'root-legacy',
    commentId: 'reply-new',
    summary: 'Use the new answer.',
    expectedThreadVersion: 5,
    actor,
    canModerate: false,
    auditContext: createTestAuditContext(
      'legacy-resolution-migration',
      '2026-07-12T00:04:00.000Z',
      { commentId: 'reply-new', summary: 'Use the new answer.' },
    ),
  })
  expect(migrated.acceptedResolutions).toMatchObject([{
    sourceCommentId: 'reply-new',
    state: 'accepted',
  }])
  const physicalRoot = memory.rows.get(`${entityKey}\0COMMENT#root-legacy`)
  expect(physicalRoot?.acceptedResolution).toMatchObject({
    sourceCommentId: 'reply-new',
    state: 'accepted',
  })
  expect(physicalRoot?.acceptedResolutions).toMatchObject([
    { id: 'legacy-old', state: 'superseded' },
    { id: 'legacy-current', state: 'superseded' },
  ])
  const migratedHistory = await memory.client.getAcceptedResolutionHistory({
    entityKey,
    rootCommentId: 'root-legacy',
    limit: 10,
  })
  expect(migratedHistory.items.map((resolution) => resolution.id)).toEqual([
    migrated.acceptedResolutions[0]?.id,
    'legacy-current',
    'legacy-old',
  ])
})
