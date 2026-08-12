import { expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { createMutationAuditContext } from '../audit/audit'
import {
  type CollaborationAuthorizationConditionCheck,
  CollaborationError,
  createPlanningUpdateCollaborationEntityKey,
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

test('creates stable collaboration keys for Work Item, project, and Planning update scopes', () => {
  expect(createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')).toBe(
    'workspace#one#work-item#team/team-a/issue/issue-1',
  )
  expect(createProjectCollaborationEntityKey('workspace#one', 'project-a')).toBe(
    'workspace#one#project#project-a',
  )
  expect(createPlanningUpdateCollaborationEntityKey(
    'workspace#one',
    'project/team-a/project-a',
  )).toBe('workspace#one#planning-update#project/team-a/project-a')
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

test('includes caller authorization guards in watcher transactions', async () => {
  let transaction: Record<string, unknown> | undefined
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) transaction = input
    return {}
  })
  const authorizationCheck: CollaborationAuthorizationConditionCheck = {
    ConditionCheck: {
      TableName: 'workspace-access-table',
      Key: {
        workspaceId: 'workspace#one',
        recordKey: 'MEMBER#member@example.com',
      },
      ConditionExpression: '#version = :expectedVersion',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':expectedVersion': 4 },
    },
  }

  await client.subscribe({
    authorizationConditionChecks: [authorizationCheck],
    entityKey: createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1'),
    expectedSubscribed: false,
    issueId: 'issue-1',
    memberKey: 'member@example.com',
    teamId: 'team-a',
    workspaceId: 'workspace#one',
  })

  expect(transaction?.TransactItems).toEqual(expect.arrayContaining([
    authorizationCheck,
    expect.objectContaining({
      ConditionCheck: expect.objectContaining({ TableName: 'issue-table' }),
    }),
  ]))
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

test('stores a Planning update watcher in its qualified target scope', async () => {
  const transactions: Array<Record<string, unknown>> = []
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      transactions.push(input)
      return {}
    }
    return { Items: [] }
  })
  const planningUpdateTargetKey = 'project/team-a/project-a'
  const entityKey = createPlanningUpdateCollaborationEntityKey(
    'workspace#one',
    planningUpdateTargetKey,
  )

  await client.subscribe({
    workspaceId: 'workspace#one',
    entityKey,
    planningUpdateTargetKey,
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

test('reads one member watcher state with consistent point gets instead of queries', async () => {
  const commands: Array<Record<string, unknown>> = []
  const entityKey = createWorkItemCollaborationEntityKey('workspace#one', 'team-a', 'issue-1')
  const projectEntityKey = createProjectCollaborationEntityKey('workspace#one', 'project-a')
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    commands.push(input)
    if (typeof input.Key !== 'object' || input.Key === null) {
      throw new Error('Expected an exact watcher key read.')
    }
    const requestedEntityKey = Reflect.get(input.Key, 'entityKey')
    return {
      Item: {
        entityKey: requestedEntityKey,
        recordKey: 'WATCHER#member@example.com',
        entryType: 'watcher',
        memberKey: 'member@example.com',
        state: requestedEntityKey === entityKey ? 'subscribed' : 'unsubscribed',
        explicit: true,
        reasons: new Set(requestedEntityKey === entityKey ? ['manual', 'comment'] : ['manual']),
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z',
        mutationIdentity: requestedEntityKey === entityKey
          ? 'watch-mutation-1'
          : 'project-watch-mutation-1',
      },
    }
  })

  const watch = await client.getMemberWatcherState({
    entityKey,
    memberKey: 'Member@Example.com',
    projectEntityKey,
  })

  expect(watch).toEqual({
    subscribed: true,
    explicit: true,
    automatic: true,
    reasons: ['comment', 'manual'],
    mutationIdentity: 'watch-mutation-1',
    updatedAt: '2026-07-12T00:00:00.000Z',
    projectSubscribed: false,
  })
  expect(commands).toEqual([
    {
      TableName: 'collaboration-table',
      Key: { entityKey, recordKey: 'WATCHER#member@example.com' },
      ConsistentRead: true,
    },
    {
      TableName: 'collaboration-table',
      Key: { entityKey: projectEntityKey, recordKey: 'WATCHER#member@example.com' },
      ConsistentRead: true,
    },
  ])
  expect(commands.every((command) => !('KeyConditionExpression' in command))).toBeTrue()
})

test('conditions manual watcher updates on the optional expected subscription state', async () => {
  const transactions: Array<Record<string, unknown>> = []
  const postWriteReads: Array<Record<string, unknown>> = []
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      transactions.push(input)
    } else {
      postWriteReads.push(input)
    }
    return { Items: [] }
  })
  const entityKey = createProjectCollaborationEntityKey('workspace#one', 'project-a')
  const scope = {
    workspaceId: 'workspace#one',
    entityKey,
    projectId: 'project-a',
    memberKey: 'member@example.com',
  }

  await client.subscribe({
    ...scope,
    expectedSubscribed: false,
    mutationIdentity: 'watch-mutation-1',
  })
  await client.unsubscribe({
    ...scope,
    expectedSubscribed: true,
    mutationIdentity: 'watch-mutation-2',
  })

  expect(transactions[0]?.TransactItems).toEqual([
    expect.objectContaining({
      Update: expect.objectContaining({
        ConditionExpression: 'attribute_not_exists(entityKey) OR #state = :expectedState',
        ExpressionAttributeValues: expect.objectContaining({
          ':state': 'subscribed',
          ':expectedState': 'unsubscribed',
          ':mutationIdentity': 'watch-mutation-1',
        }),
        UpdateExpression: expect.stringContaining('mutationIdentity = :mutationIdentity'),
      }),
    }),
  ])
  expect(transactions[1]?.TransactItems).toEqual([
    expect.objectContaining({
      Update: expect.objectContaining({
        ConditionExpression: '#state = :expectedState',
        ExpressionAttributeValues: expect.objectContaining({
          ':state': 'unsubscribed',
          ':expectedState': 'subscribed',
          ':mutationIdentity': 'watch-mutation-2',
        }),
        UpdateExpression: expect.stringContaining('mutationIdentity = :mutationIdentity'),
      }),
    }),
  ])
  expect(postWriteReads).toEqual([
    {
      TableName: 'collaboration-table',
      Key: { entityKey, recordKey: 'WATCHER#member@example.com' },
      ConsistentRead: true,
    },
    {
      TableName: 'collaboration-table',
      Key: { entityKey, recordKey: 'WATCHER#member@example.com' },
      ConsistentRead: true,
    },
  ])
})

test('returns the persisted marker after a same-state manual watcher compare-and-set', async () => {
  let transaction: Record<string, unknown> | undefined
  const entityKey = createProjectCollaborationEntityKey('workspace#one', 'project-a')
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      transaction = input
      return {}
    }
    return {
      Item: {
        entityKey,
        recordKey: 'WATCHER#member@example.com',
        entryType: 'watcher',
        memberKey: 'member@example.com',
        state: 'subscribed',
        explicit: true,
        reasons: new Set(['manual']),
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T01:00:00.000Z',
        mutationIdentity: 'watch-mutation-same-state',
      },
    }
  })

  const state = await client.subscribe({
    workspaceId: 'workspace#one',
    entityKey,
    projectId: 'project-a',
    memberKey: 'member@example.com',
    expectedSubscribed: true,
    mutationIdentity: 'watch-mutation-same-state',
  })

  expect(transaction?.TransactItems).toEqual([
    expect.objectContaining({
      Update: expect.objectContaining({
        ConditionExpression: '#state = :expectedState',
        ExpressionAttributeValues: expect.objectContaining({
          ':expectedState': 'subscribed',
          ':mutationIdentity': 'watch-mutation-same-state',
        }),
      }),
    }),
  ])
  expect(state).toEqual({
    subscribed: true,
    explicit: true,
    automatic: false,
    reasons: ['manual'],
    mutationIdentity: 'watch-mutation-same-state',
    updatedAt: '2026-07-12T01:00:00.000Z',
  })
})

test('rejects automatic watcher requests that would ignore manual transition controls', async () => {
  let commands = 0
  const client = createClient(async () => {
    commands += 1
    return {}
  })
  const scope = {
    workspaceId: 'workspace#one',
    entityKey: createProjectCollaborationEntityKey('workspace#one', 'project-a'),
    projectId: 'project-a',
    memberKey: 'member@example.com',
    automatic: true,
  }

  await expect(client.subscribe({
    ...scope,
    expectedSubscribed: false,
  })).rejects.toMatchObject({
    status: 400,
    code: 'InvalidWatcherUpdate',
  })
  await expect(client.unsubscribe(scope)).rejects.toMatchObject({
    status: 400,
    code: 'InvalidWatcherUpdate',
  })
  await expect(client.subscribe({
    ...scope,
    automatic: false,
    mutationIdentity: ' ',
  })).rejects.toMatchObject({
    status: 400,
    code: 'InvalidWatcherMutationIdentity',
  })
  expect(commands).toBe(0)
})

test('persists an automatic watcher mutation identity when explicitly supplied', async () => {
  let transaction: Record<string, unknown> | undefined
  const entityKey = createProjectCollaborationEntityKey('workspace#one', 'project-a')
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      transaction = input
      return {}
    }
    return { Items: [] }
  })

  await client.subscribe({
    workspaceId: 'workspace#one',
    entityKey,
    projectId: 'project-a',
    memberKey: 'member@example.com',
    automatic: true,
    reason: 'comment',
    mutationIdentity: 'automatic-watch-mutation-1',
  })

  expect(transaction?.TransactItems).toEqual([
    expect.objectContaining({
      Update: expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ':mutationIdentity': 'automatic-watch-mutation-1',
        }),
        UpdateExpression: expect.stringContaining('mutationIdentity = :mutationIdentity'),
      }),
    }),
  ])
})

test('fails closed on a malformed stored watcher mutation identity', async () => {
  const entityKey = createProjectCollaborationEntityKey('workspace#one', 'project-a')
  const client = createClient(async () => ({
    Item: {
      entityKey,
      recordKey: 'WATCHER#member@example.com',
      entryType: 'watcher',
      memberKey: 'member@example.com',
      state: 'subscribed',
      explicit: true,
      reasons: new Set(['manual']),
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      mutationIdentity: 'x'.repeat(257),
    },
  }))

  await expect(client.getMemberWatcherState({
    entityKey,
    memberKey: 'member@example.com',
  })).rejects.toMatchObject({
    status: 503,
    code: 'InvalidCollaborationRecord',
  })
})

test('fails a watcher compare-and-set conflict without scanning the watcher scope', async () => {
  let nonTransactionReads = 0
  const client = createClient(async (command) => {
    const input = readCommandInput(command)
    if ('TransactItems' in input) {
      throw Object.assign(new Error('conditional conflict'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      })
    }
    nonTransactionReads += 1
    return { Items: [] }
  })
  const scope = {
    workspaceId: 'workspace#one',
    entityKey: createProjectCollaborationEntityKey('workspace#one', 'project-a'),
    projectId: 'project-a',
    memberKey: 'member@example.com',
  }

  await expect(client.subscribe({ ...scope, expectedSubscribed: false })).rejects.toMatchObject({
    status: 409,
    code: 'CollaborationConflict',
  })
  await expect(client.unsubscribe({ ...scope, expectedSubscribed: true })).rejects.toMatchObject({
    status: 409,
    code: 'CollaborationConflict',
  })
  expect(nonTransactionReads).toBe(0)
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

  await expect(client.unsubscribe({
    workspaceId: 'workspace#one',
    entityKey: createPlanningUpdateCollaborationEntityKey(
      'workspace#one',
      'project/team-b/project-b',
    ),
    planningUpdateTargetKey: 'project/team-a/project-a',
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
