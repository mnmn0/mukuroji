import { expect, spyOn, test } from 'bun:test'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { COLLABORATION_CONTEXT_SCHEMA_VERSION } from '@mukuroji/contracts'
import type { TaskViewDefinition } from '@mukuroji/contracts'
import {
  type CreateTaskViewRequest,
  DynamoDbWorkspaceSearchClient,
  WorkspaceSearchError,
  createCommentWorkspaceSearchDocument,
  createCuratedContextItemWorkspaceSearchDocument,
  createDocumentWorkspaceSearchSourceDocument,
  createDocumentWorkspaceSearchDocument,
  createTaskViewRecordKey,
  createWorkItemWorkspaceSearchDocument,
  createWorkspaceSearchDocument,
  ensureLocalWorkspaceSearchTable,
  migrateSavedWorkspaceView,
  WORKSPACE_SEARCH_STORED_BODY_MAX_LENGTH,
} from './workspace-search'

test('keeps the unprocessed DynamoDB page behind the opaque search cursor', async () => {
  const documents = ['alpha', 'beta', 'gamma'].map((id) => createWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    entityType: 'work-item',
    entityId: `team/core/issue/${id}`,
    title: `${id} title`,
    url: `/teams/core/issues?issueId=${id}`,
    teamId: 'core',
    projectId: 'project-1',
  })).sort((left, right) => left.recordKey < right.recordKey ? -1 : left.recordKey > right.recordKey ? 1 : 0)
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient(documents),
    {} as DynamoDBClient,
    false,
  )
  const input = {
    workspaceId: 'workspace-1',
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set(['project-1']),
      teamIds: new Set(['core']),
    },
    limit: 1,
  }

  const first = await client.search(input)
  const second = await client.search({ ...input, cursor: first.nextCursor })

  expect(first.results.map((result) => result.id)).toEqual([documents[0]?.entityId])
  expect(second.results.map((result) => result.id)).toEqual([documents[1]?.entityId])
  expect(first.nextCursor).toBeString()
  await expect(client.search({
    ...input,
    cursor: first.nextCursor,
    filters: { keyword: 'different query' },
  })).rejects.toMatchObject({ code: 'InvalidSearchCursor', status: 400 })
})

test('skips an invalid index row without failing or skipping the remaining page', async () => {
  const createDocument = (id: string) => createWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    entityType: 'work-item',
    entityId: `team/core/issue/${id}`,
    title: `${id} title`,
    url: `/teams/core/issues?issueId=${id}`,
    teamId: 'core',
  })
  const alpha = createDocument('alpha')
  const malformed = { ...createDocument('beta'), schemaVersion: 999 }
  const gamma = createDocument('gamma')
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([alpha, malformed, gamma]),
    {} as DynamoDBClient,
    false,
  )
  const input = {
    workspaceId: 'workspace-1',
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set<string>(),
      teamIds: new Set(['core']),
    },
    limit: 1,
  }
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

  try {
    const first = await client.search(input)
    const second = await client.search({ ...input, cursor: first.nextCursor })

    expect(first.results.map((result) => result.id)).toEqual([alpha.entityId])
    expect(second.results.map((result) => result.id)).toEqual([gamma.entityId])
    expect(errorSpy).toHaveBeenCalledTimes(2)
  } finally {
    errorSpy.mockRestore()
  }
})

test('derives document keys from entity identity instead of trusting producer input', () => {
  expect(() => createWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    recordKey: 'VIEW#victim',
    entityType: 'document',
    entityId: 'document-1',
    title: 'Document',
    url: '/documents/document-1',
  })).toThrow('record key does not match')
})

test('does not let an older source projection replace or remove a newer document', async () => {
  const current = createWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    entityType: 'context-item',
    entityId: 'team/core/issue/issue-1/context-item/context-1',
    title: 'Current context',
    url: '/teams/core/issues?issueId=issue-1&contextItemId=context-1',
    teamId: 'core',
    sourceRevision: 2,
  })
  const older = createWorkspaceSearchDocument({
    ...current,
    title: 'Older context',
    sourceRevision: 1,
  })
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([current]),
    {} as DynamoDBClient,
    false,
  )

  await client.upsertDocument(older, { sourceRevision: 1 })
  await client.deleteDocument(
    'workspace-1',
    'context-item',
    'team/core/issue/issue-1/context-item/context-1',
    { sourceRevision: 1 },
  )

  const response = await client.search({
    workspaceId: 'workspace-1',
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set<string>(),
      teamIds: new Set(['core']),
    },
  })
  expect(response.results).toHaveLength(1)
  expect(response.results[0]?.title).toBe('Current context')
})

test('fences a comment Search projection to its current canonical version', async () => {
  const commands: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      commands.push(command.input)
      if (command.input.Key !== undefined) return {}
      const error = Object.assign(new Error('canonical comment changed'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
        ],
      })
      throw error
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const document = createCommentWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    teamId: 'core',
    issueId: 'issue-1',
    commentId: 'comment-1',
    body: 'Historical comment',
    sourceRevision: 1,
  })

  await expect(client.upsertDocumentWithCommentSourceFence(document, {
    sourceTableName: 'collaboration-table',
    sourceEntityKey: 'workspace-1#work-item#team/core/issue/issue-1',
    sourceCommentId: 'comment-1',
    sourceRevision: 1,
  })).resolves.toBe('source-changed')
  expect(commands[1]?.TransactItems).toEqual([
    expect.objectContaining({
      ConditionCheck: expect.objectContaining({
        TableName: 'collaboration-table',
        Key: {
          entityKey: 'workspace-1#work-item#team/core/issue/issue-1',
          recordKey: 'COMMENT#comment-1',
        },
        ConditionExpression: expect.stringContaining('attribute_not_exists(deletedAt)'),
      }),
    }),
    expect.objectContaining({
      Put: expect.objectContaining({ TableName: 'search-table' }),
    }),
  ])
})

test('does not count a replayed Search projection as a new write', async () => {
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if (command.input.Key !== undefined) return {}
      const error = Object.assign(new Error('projection already won'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ],
      })
      throw error
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const document = createCommentWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    teamId: 'core',
    issueId: 'issue-1',
    commentId: 'comment-1',
    body: 'Historical comment',
    sourceRevision: 1,
  })

  await expect(client.upsertDocumentWithCommentSourceFence(document, {
    sourceTableName: 'collaboration-table',
    sourceEntityKey: 'workspace-1#work-item#team/core/issue/issue-1',
    sourceCommentId: 'comment-1',
    sourceRevision: 1,
  })).resolves.toBe('unchanged')
})

test('reports whether an idempotent Search deletion removed a document', async () => {
  const document = createCommentWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    teamId: 'core',
    issueId: 'issue-1',
    commentId: 'comment-1',
    body: 'Historical comment',
    sourceRevision: 1,
  })
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([document]),
    {} as DynamoDBClient,
    false,
  )

  await expect(client.deleteDocumentWithResult(
    'workspace-1',
    'comment',
    document.entityId,
    { sourceRevision: 1 },
  )).resolves.toBe(true)
  await expect(client.deleteDocumentWithResult(
    'workspace-1',
    'comment',
    document.entityId,
    { sourceRevision: 1 },
  )).resolves.toBe(false)
})

test('requires canonical ISO dates for Work Item search projections', () => {
  const input = {
    workspaceId: 'workspace-1',
    teamId: 'core',
    issueId: 'issue-1',
    title: 'Release readiness',
  }

  expect(createWorkItemWorkspaceSearchDocument({
    ...input,
    dueDate: '2026-07-20',
  }).dueDate).toBe('2026-07-20')
  expect(() => createWorkItemWorkspaceSearchDocument({
    ...input,
    dueDate: '2026/07/20',
  })).toThrow('must be a real ISO date')
  expect(() => createWorkItemWorkspaceSearchDocument({
    ...input,
    dueDate: '2026-02-29',
  })).toThrow('must be a real ISO date')
})

test('binds live projections to a deterministic server-owned content digest', async () => {
  const first = createWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    entityType: 'work-item',
    entityId: 'team/core/issue/issue-1',
    title: 'Release readiness',
    url: '/teams/core/issues?issueId=issue-1',
    teamId: 'core',
    customFields: {
      effort: 8,
      channel: ['web', 'mobile'],
    },
  })
  const reordered = createWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    entityType: 'work-item',
    entityId: 'team/core/issue/issue-1',
    title: 'Release readiness',
    url: '/teams/core/issues?issueId=issue-1',
    teamId: 'core',
    customFields: {
      channel: ['web', 'mobile'],
      effort: 8,
    },
  })
  const changed = createWorkspaceSearchDocument({
    ...first,
    title: 'Changed after migration planning',
  })
  const replacementEquivalentKeyOrder = createWorkspaceSearchDocument({
    ...first,
    customFields: {
      '\uD800': 'first',
      '\uD801': 'second',
    },
  })
  const reversedReplacementEquivalentKeyOrder = createWorkspaceSearchDocument({
    ...first,
    customFields: {
      '\uD801': 'second',
      '\uD800': 'first',
    },
  })
  const { projectionDigest: legacyProjectionDigest, ...legacyDocument } = first
  const legacyClient = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([legacyDocument]),
    {} as DynamoDBClient,
    false,
  )
  const corruptClient = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([{
      ...first,
      projectionDigest: '0'.repeat(64),
    }]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'viewer@example.com',
    isSystemAdmin: false,
    projectIds: new Set<string>(),
    teamIds: new Set(['core']),
  }

  expect(legacyProjectionDigest).toMatch(/^[0-9a-f]{64}$/u)
  expect(first.projectionDigest).toBe(
    '111162f5fe98780edfe8e96adfc1e1ad5981a8cced24b7143264b3f06e62d186',
  )
  expect(first.projectionDigest).toBe(reordered.projectionDigest)
  expect(first.projectionDigest).not.toBe(changed.projectionDigest)
  expect(replacementEquivalentKeyOrder.projectionDigest).toBe(
    reversedReplacementEquivalentKeyOrder.projectionDigest,
  )
  expect((await legacyClient.search({
    workspaceId: 'workspace-1',
    access,
  })).results.map((result) => result.id)).toEqual([
    'team/core/issue/issue-1',
  ])
  await expect(corruptClient.search({
    workspaceId: 'workspace-1',
    access,
  })).rejects.toMatchObject({
    code: 'InvalidSearchDocument',
    status: 503,
  })
})

test('normalizes realtime and backfill Work Item and comment projection fields consistently', () => {
  const workItem = createWorkItemWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    teamId: 'core',
    issueId: 'issue-1',
    title: 'Release readiness',
    body: 'Coordinate the final launch.',
    customFields: { effort: 8 },
    relationIds: ['blocks:issue-2'],
  })
  const comment = createCommentWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    teamId: 'core',
    issueId: 'issue-1',
    commentId: 'comment-1',
    body: 'Approved for release.\nProceed with rollout.',
    creatorUserId: 'owner@example.com',
    rootCommentId: 'root-comment',
    sourceRevision: 3,
  })
  const longComment = createCommentWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    teamId: 'core',
    issueId: 'issue-1',
    commentId: 'long-comment',
    body: 'x'.repeat(20_001),
  })

  expect(workItem).toMatchObject({
    subtitle: 'issue-1',
    customFields: { effort: 8 },
    relationIds: ['blocks:issue-2'],
  })
  expect(comment).toMatchObject({
    title: 'Approved for release.',
    subtitle: 'owner@example.com',
    parentId: 'team/core/issue/issue-1',
    url: '/teams/core/issues?issueId=issue-1&commentId=comment-1&rootCommentId=root-comment',
    sourceRevision: 3,
  })
  expect(longComment.body).toHaveLength(20_000)
})

test('projects curated context with a stable Work Item deep link and source revision', () => {
  const document = createCuratedContextItemWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    item: {
      schemaVersion: 1,
      id: 'context-1',
      teamId: 'core',
      workItemId: 'issue-1',
      kind: 'decision',
      state: 'accepted',
      title: 'Ship the release',
      body: 'The release is approved after the final regression pass.',
      mentionMemberKeys: ['owner@example.com'],
      createdBy: { id: 'owner@example.com', displayName: 'Owner' },
      createdAt: '2026-08-09T01:00:00.000Z',
      updatedBy: { id: 'manager@example.com', displayName: 'Manager' },
      updatedAt: '2026-08-09T02:00:00.000Z',
      revision: 3,
    },
  })

  expect(document).toMatchObject({
    entityType: 'context-item',
    entityId: 'team/core/issue/issue-1/context-item/context-1',
    parentId: 'team/core/issue/issue-1',
    title: 'Ship the release',
    subtitle: 'decision',
    status: 'accepted',
    projectId: 'project-1',
    creatorUserId: 'owner@example.com',
    sourceRevision: 3,
    url: '/projects/project-1/issues?teamId=core&issueId=issue-1&contextItemId=context-1',
  })
})

test('projects rich Document content and backlinks into the Workspace search schema', () => {
  const document = createDocumentWorkspaceSearchDocument('workspace-1', {
    schemaVersion: 1,
    id: 'document-1',
    kind: 'page',
    scope: { type: 'project', projectId: 'project-1' },
    title: 'Launch brief',
    position: 'a0',
    revision: 3,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [{
      id: 'relation-1',
      source: { kind: 'block', blockId: 'block-1' },
      target: { kind: 'work-item', workItemId: 'issue-1' },
      createdByUserId: 'author@example.com',
      createdAt: '2026-07-18T00:00:00.000Z',
    }],
    favorite: false,
    capabilities: {
      canView: true,
      canEdit: true,
      canComment: true,
      canShare: true,
      canManagePermissions: true,
      canArchive: true,
      canRestore: false,
      canExport: true,
    },
    createdByUserId: 'author@example.com',
    updatedByUserId: 'author@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T01:00:00.000Z',
    blocks: [
      { id: 'block-1', type: 'heading', level: 1, text: 'Release plan' },
      {
        id: 'block-2',
        type: 'checklist',
        items: [{ id: 'item-1', text: 'Confirm rollback owner', checked: false }],
      },
    ],
  })

  expect(document).toMatchObject({
    entityType: 'document',
    entityId: 'document-1',
    sourceRevision: 3,
    projectId: 'project-1',
    body: 'Release plan\nConfirm rollback owner',
    relationIds: ['work-item:issue-1'],
    customFields: {
      documentKind: 'page',
      permissionMode: 'inherit',
    },
    url: '/documents/document-1',
  })
})

test('searches the full current Document while keeping its DynamoDB projection bounded', async () => {
  const tailToken = 'tail-only-search-token'
  const longText = `${'x'.repeat(
    WORKSPACE_SEARCH_STORED_BODY_MAX_LENGTH + 100,
  )}${tailToken}`
  const source = {
    schemaVersion: 1 as const,
    id: 'long-document',
    kind: 'page' as const,
    scope: { type: 'workspace' as const },
    title: 'Long document',
    position: 'a0',
    revision: 1,
    permission: { mode: 'inherit' as const, memberGrants: [] },
    relations: [],
    favorite: false,
    capabilities: {
      canView: true,
      canEdit: true,
      canComment: true,
      canShare: true,
      canManagePermissions: true,
      canArchive: true,
      canRestore: false,
      canExport: true,
    },
    createdByUserId: 'author@example.com',
    updatedByUserId: 'author@example.com',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    blocks: [{ id: 'block-1', type: 'paragraph' as const, text: longText }],
  }
  const stored = createDocumentWorkspaceSearchDocument(
    'workspace-1',
    source,
  )
  const current = createDocumentWorkspaceSearchSourceDocument(
    'workspace-1',
    source,
  )
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([stored]),
    {} as DynamoDBClient,
    false,
  )

  const response = await client.search({
    workspaceId: 'workspace-1',
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set<string>(),
      teamIds: new Set<string>(),
    },
    filters: { keyword: tailToken },
    resolveCurrentScope: async () => ({
      permissionVerified: true,
      currentDocument: current,
    }),
  })

  expect(stored.body).toHaveLength(
    WORKSPACE_SEARCH_STORED_BODY_MAX_LENGTH,
  )
  expect(stored.body).not.toContain(tailToken)
  expect(current.body).toBe(longText)
  expect(response.results.map(({ id }) => id)).toEqual([
    'long-document',
  ])
})

test('applies current resolved scope before RBAC and composite project filters', async () => {
  const comment = createWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    entityType: 'comment',
    entityId: 'team/core/issue/issue-1/comment/comment-1',
    parentId: 'team/core/issue/issue-1',
    title: 'Release checklist',
    body: 'Alpha readiness details',
    url: '/teams/core/issues?issueId=issue-1&commentId=comment-1',
    teamId: 'core',
    creatorUserId: 'creator@example.com',
    status: 'review',
    customFields: { score: 8, channel: ['web', 'mobile'] },
    relationIds: ['blocks:issue-2'],
    dueDate: '2026/07/20',
  })
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([comment]),
    {} as DynamoDBClient,
    false,
  )

  const response = await client.search({
    workspaceId: 'workspace-1',
    filters: {
      keyword: 'alpha readiness',
      entityTypes: ['comment'],
      creatorUserIds: ['creator@example.com'],
      statuses: ['review'],
      customFields: [
        { fieldId: 'score', operator: 'greater-than-or-equal', value: 8 },
        { fieldId: 'channel', operator: 'contains', value: 'web' },
      ],
      relationIds: ['blocks:issue-2'],
      date: { field: 'dueDate', from: '2026-07-01', to: '2026-07-31' },
      projectIds: ['project-current'],
      teamIds: ['core'],
    },
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set(['project-current']),
      teamIds: new Set(['core']),
    },
    resolveCurrentScope: async () => ({ teamId: 'core', projectId: 'project-current' }),
  })

  expect(response.results).toHaveLength(1)
  expect(response.results[0]?.projectId).toBe('project-current')
  expect(response.results[0]?.dueDate).toBe('2026-07-20')
  expect(response.results[0]?.customFields).toEqual({
    score: 8,
    channel: ['web', 'mobile'],
  })
  expect(response.results[0]?.highlights).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'body' }),
  ]))
})

test('does not authorize a context item from its stale indexed project scope', async () => {
  const contextItem = createCuratedContextItemWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    item: {
      schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
      id: 'context-1',
      teamId: 'core',
      workItemId: 'issue-1',
      kind: 'decision',
      title: 'Release decision',
      body: 'Move the release to Friday.',
      state: 'active',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      createdBy: { id: 'creator@example.com', displayName: 'Creator' },
      updatedBy: { id: 'creator@example.com', displayName: 'Creator' },
      mentionMemberKeys: [],
      revision: 1,
    },
    projectId: 'project-a',
  })
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([contextItem]),
    {} as DynamoDBClient,
    false,
  )
  const resolveCurrentScope = async () => ({
    teamId: 'core',
    projectId: 'project-b',
    currentDocument: {
      ...contextItem,
      projectId: 'project-b',
    },
  })

  const projectAResponse = await client.search({
    workspaceId: 'workspace-1',
    access: {
      viewerUserId: 'project-a-viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set(['project-a']),
      teamIds: new Set(['core']),
    },
    resolveCurrentScope,
  })
  const projectBResponse = await client.search({
    workspaceId: 'workspace-1',
    access: {
      viewerUserId: 'project-b-viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set(['project-b']),
      teamIds: new Set(['core']),
    },
    resolveCurrentScope,
  })

  expect(projectAResponse.results).toHaveLength(0)
  expect(projectBResponse.results.map(({ id }) => id)).toEqual([contextItem.entityId])
})

test('requires a source-of-truth permission decision for Workspace-scoped documents', async () => {
  const document = createWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    entityType: 'document',
    entityId: 'document-1',
    title: 'Private strategy',
    body: 'Confidential workspace notes',
    url: '/documents/document-1',
  })
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([document]),
    {} as DynamoDBClient,
    false,
  )
  const input = {
    workspaceId: 'workspace-1',
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set<string>(),
      teamIds: new Set<string>(),
    },
  }

  const withoutResolver = await client.search(input)
  const denied = await client.search({
    ...input,
    resolveCurrentScope: async () => undefined,
  })
  const allowed = await client.search({
    ...input,
    resolveCurrentScope: async () => ({
      permissionVerified: true,
      currentDocument: document,
    }),
  })

  expect(withoutResolver.results).toEqual([])
  expect(denied.results).toEqual([])
  expect(allowed.results.map((result) => result.id)).toEqual(['document-1'])
})

test('fails closed for a stale search document even for a system administrator', async () => {
  const document = createWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    entityType: 'work-item',
    entityId: 'team/archived/issue/issue-1',
    title: 'Archived secret',
    url: '/teams/archived/issues?issueId=issue-1',
    teamId: 'archived',
  })
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([document]),
    {} as DynamoDBClient,
    false,
  )

  const response = await client.search({
    workspaceId: 'workspace-1',
    access: {
      viewerUserId: 'admin@example.com',
      isSystemAdmin: true,
      projectIds: new Set(),
      teamIds: new Set(),
    },
    resolveCurrentScope: async () => undefined,
  })

  expect(response.results).toEqual([])
})

test('resolves current scopes with bounded concurrency and preserves result order', async () => {
  const documents = Array.from({ length: 12 }, (_, index) => createWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    entityType: 'work-item',
    entityId: `team/core/issue/issue-${String(index).padStart(2, '0')}`,
    title: `Issue ${index}`,
    url: `/teams/core/issues?issueId=issue-${index}`,
    teamId: 'core',
  })).sort((left, right) => left.recordKey.localeCompare(right.recordKey))
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient(documents),
    {} as DynamoDBClient,
    false,
  )
  let activeResolvers = 0
  let maximumActiveResolvers = 0

  const response = await client.search({
    workspaceId: 'workspace-1',
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set(),
      teamIds: new Set(['core']),
    },
    resolveCurrentScope: async () => {
      activeResolvers += 1
      maximumActiveResolvers = Math.max(maximumActiveResolvers, activeResolvers)
      await Promise.resolve()
      activeResolvers -= 1
      return { teamId: 'core' }
    },
  })

  expect(maximumActiveResolvers).toBe(10)
  expect(response.results.map((result) => result.id)).toEqual(
    documents.map((document) => document.entityId),
  )
})

test('prefilters immutable entity types before current access resolution', async () => {
  const excludedDocuments = Array.from(
    { length: 40 },
    (_, index) =>
      createWorkspaceSearchDocument({
        workspaceId: 'workspace-1',
        entityType: 'document',
        entityId: `document-${index}`,
        title: `Document ${index}`,
        url: `/documents/document-${index}`,
        creatorUserId: 'author@example.com',
        createdAt:
          '2026-07-18T00:00:00.000Z',
        updatedAt:
          '2026-07-18T00:00:00.000Z',
        sourceRevision: 1,
      }),
  )
  const includedComment =
    createWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      entityType: 'comment',
      entityId:
        'team/core/issue/issue-1/comment/comment-1',
      parentId:
        'team/core/issue/issue-1',
      title: 'Matching comment',
      url:
        '/teams/core/issues?issueId=issue-1&commentId=comment-1',
      teamId: 'core',
    })
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([
      ...excludedDocuments,
      includedComment,
    ]),
    {} as DynamoDBClient,
    false,
  )
  let resolverCalls = 0

  const response = await client.search({
    workspaceId: 'workspace-1',
    filters: {
      entityTypes: ['comment'],
    },
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set<string>(),
      teamIds: new Set(['core']),
    },
    resolveCurrentScope: async (document) => {
      resolverCalls += 1
      return {
        teamId: document.teamId,
      }
    },
  })

  expect(resolverCalls).toBe(1)
  expect(response.results.map(({ id }) => id))
    .toEqual([includedComment.entityId])
})

test('continues Document access resolution beyond thirty denied candidates', async () => {
  const documents = Array.from(
    { length: 40 },
    (_, index) =>
      createWorkspaceSearchDocument({
        workspaceId: 'workspace-1',
        entityType: 'document',
        entityId:
          `document-${String(index).padStart(2, '0')}`,
        title: `Document ${index}`,
        url: `/documents/document-${index}`,
        updatedAt:
          '2026-07-18T00:00:00.000Z',
        sourceRevision: 1,
      }),
  ).sort((left, right) =>
    left.recordKey.localeCompare(
      right.recordKey,
    )
  )
  const laterDocument = documents.at(-1)
  if (laterDocument === undefined) {
    throw new Error(
      'Expected a later search document.',
    )
  }
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient(documents),
    {} as DynamoDBClient,
    false,
  )
  let resolverCalls = 0

  const response = await client.search({
    workspaceId: 'workspace-1',
    limit: 1,
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set<string>(),
      teamIds: new Set<string>(),
    },
    resolveCurrentScope: async (document) => {
      resolverCalls += 1
      return document.entityId ===
        laterDocument.entityId
        ? { permissionVerified: true }
        : undefined
    },
  })

  expect(resolverCalls).toBe(40)
  expect(response.results.map(({ id }) => id))
    .toEqual([laterDocument.entityId])
})

test('stops source-of-truth resolution after a small result page is full', async () => {
  const documents = Array.from(
    { length: 100 },
    (_, index) => createWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      entityType: 'work-item',
      entityId:
        `team/core/issue/issue-${String(index).padStart(3, '0')}`,
      title: `Issue ${index}`,
      url: `/teams/core/issues?issueId=issue-${index}`,
      teamId: 'core',
    }),
  )
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient(documents),
    {} as DynamoDBClient,
    false,
  )
  let resolverCalls = 0

  const response = await client.search({
    workspaceId: 'workspace-1',
    limit: 1,
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      projectIds: new Set(),
      teamIds: new Set(['core']),
    },
    resolveCurrentScope: async () => {
      resolverCalls += 1
      return { teamId: 'core' }
    },
  })

  expect(response.results).toHaveLength(1)
  expect(resolverCalls).toBeLessThanOrEqual(10)
  expect(response.nextCursor).toBeString()
})

test('keeps unread saved views from advancing the cursor past unprocessed rows', async () => {
  const rows = [
    createStoredSavedViewRow('00-private', 'personal', 'other@example.com'),
    createStoredSavedViewRow('01-shared', 'shared', 'owner@example.com'),
    createStoredSavedViewRow('02-shared', 'shared', 'owner@example.com'),
    createStoredSavedViewRow('03-shared', 'shared', 'owner@example.com'),
  ]
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient(rows),
    {} as DynamoDBClient,
    false,
  )
  const input = {
    workspaceId: 'workspace-1',
    access: {
      viewerUserId: 'viewer@example.com',
      isSystemAdmin: false,
      canManageSharedViews: false,
      canWrite: true,
      teamIds: new Set<string>(),
      manageableTeamIds: new Set<string>(),
    },
    limit: 2,
  }

  const first = await client.listSavedViews(input)
  const second = await client.listSavedViews({ ...input, cursor: first.nextCursor })

  expect(first.views.map((view) => view.id)).toEqual(['01-shared', '02-shared'])
  expect(first.nextCursor).toBeString()
  expect(second.views.map((view) => view.id)).toEqual(['03-shared'])
})

test('keeps personal saved views private and detects stale revisions', async () => {
  const control = { failNextTransaction: false }
  const documentClient = createMemoryDocumentClient([], control)
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const ownerAccess = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['core']),
    manageableTeamIds: new Set(['core']),
  }
  const created = await client.createSavedView({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    input: {
      name: 'My review queue',
      visibility: 'personal',
      filters: { statuses: ['review'] },
      layout: { mode: 'table', sort: [{ field: 'updatedAt', direction: 'desc' }], columns: ['title'] },
      favorite: true,
      isDefault: true,
    },
  })
  const ownerViews = await client.listSavedViews({ workspaceId: 'workspace-1', access: ownerAccess })
  const otherViews = await client.listSavedViews({
    workspaceId: 'workspace-1',
    access: { ...ownerAccess, viewerUserId: 'other@example.com' },
  })

  expect(ownerViews.views).toEqual([expect.objectContaining({
    id: created.id,
    canEdit: true,
    favorite: true,
    isDefault: true,
  })])
  expect(otherViews.views).toEqual([])
  control.failNextTransaction = true
  await expect(client.updateSavedView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: ownerAccess,
    input: {
      expectedRevision: 1,
      name: 'Partially updated queue',
      favorite: false,
      isDefault: false,
    },
  })).rejects.toThrow('transaction failed')
  expect(await client.listSavedViews({ workspaceId: 'workspace-1', access: ownerAccess }))
    .toMatchObject({
      views: [expect.objectContaining({
        name: 'My review queue',
        revision: 1,
        favorite: true,
        isDefault: true,
      })],
    })
  const updated = await client.updateSavedView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: ownerAccess,
    input: {
      expectedRevision: 1,
      name: 'Updated review queue',
      favorite: false,
      isDefault: false,
    },
  })
  expect(updated).toMatchObject({
    name: 'Updated review queue',
    revision: 2,
    favorite: false,
    isDefault: false,
  })
  await expect(client.updateSavedView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: ownerAccess,
    input: { expectedRevision: 1, name: 'Stale update' },
  })).rejects.toMatchObject({
    code: 'SavedViewRevisionConflict',
    status: 409,
  } satisfies Partial<WorkspaceSearchError>)
})

function createStoredSavedViewRow(
  id: string,
  visibility: 'personal' | 'shared',
  ownerUserId: string,
) {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-1',
    recordKey: `VIEW#${id}`,
    entryType: 'saved-view',
    id,
    name: id,
    visibility,
    ownerUserId,
    filters: {},
    layout: { mode: 'table', sort: [], columns: ['title'] },
    revision: 1,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
}

test('does not persist a partial saved view when its transaction fails', async () => {
  const control = { failNextTransaction: true }
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([], control),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['core']),
    manageableTeamIds: new Set(['core']),
  }
  const request = {
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Atomic view',
      visibility: 'personal' as const,
      filters: {},
      layout: { mode: 'table' as const, sort: [], columns: ['title'] },
      favorite: true,
      isDefault: true,
    },
  }

  await expect(client.createSavedView(request)).rejects.toThrow('transaction failed')
  expect((await client.listSavedViews({ workspaceId: 'workspace-1', access })).views).toEqual([])

  const created = await client.createSavedView(request)
  expect(await client.listSavedViews({ workspaceId: 'workspace-1', access })).toMatchObject({
    views: [expect.objectContaining({ id: created.id, favorite: true, isDefault: true })],
  })
  control.failNextTransaction = true
  await expect(client.deleteSavedView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    expectedRevision: 1,
    access,
  })).rejects.toThrow('transaction failed')
  expect(await client.listSavedViews({ workspaceId: 'workspace-1', access })).toMatchObject({
    views: [expect.objectContaining({ id: created.id, favorite: true, isDefault: true })],
  })

  await client.deleteSavedView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    expectedRevision: 1,
    access,
  })
  expect((await client.listSavedViews({ workspaceId: 'workspace-1', access })).views).toEqual([])
})

test('replays idempotent saved view creation and rejects a changed payload', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
  }
  const request = {
    workspaceId: 'workspace-1',
    access,
    idempotencyKey: 'save-current-search',
    input: {
      name: 'Idempotent view',
      visibility: 'personal' as const,
      filters: { statuses: ['review'] },
      layout: { mode: 'table' as const, sort: [], columns: ['title'] },
      favorite: true,
      isDefault: true,
    },
  }

  const created = await client.createSavedView(request)
  const replayed = await client.createSavedView(request)

  expect(replayed).toEqual(created)
  expect(await client.listSavedViews({ workspaceId: 'workspace-1', access }))
    .toMatchObject({ views: [expect.objectContaining({ id: created.id })] })
  await expect(client.createSavedView({
    ...request,
    input: { ...request.input, name: 'Changed payload' },
  })).rejects.toMatchObject({
    status: 409,
    code: 'SavedViewIdempotencyConflict',
  })
})

test('returns definition edit authority without blocking viewer preferences', async () => {
  const control: NonNullable<Parameters<typeof createMemoryDocumentClient>[1]> = {}
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([], control),
    {} as DynamoDBClient,
    false,
  )
  const ownerAccess = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['core']),
    manageableTeamIds: new Set(['core']),
  }
  const created = await client.createSavedView({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    input: {
      name: 'Team queue',
      visibility: 'team',
      teamId: 'core',
      filters: {},
      layout: { mode: 'table', sort: [], columns: ['title'] },
    },
  })
  const memberAccess = {
    ...ownerAccess,
    viewerUserId: 'member@example.com',
    manageableTeamIds: new Set<string>(),
  }

  expect(await client.listSavedViews({ workspaceId: 'workspace-1', access: memberAccess }))
    .toMatchObject({ views: [expect.objectContaining({ id: created.id, canEdit: false })] })
  control.beforeNextTransaction = (items) => {
    const recordKey = `DEFAULT#${Buffer.from(memberAccess.viewerUserId).toString('base64url')}`
    items.set(`workspace-1\0${recordKey}`, {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      recordKey,
      entryType: 'saved-view-default',
      userId: memberAccess.viewerUserId,
      viewId: created.id,
      updatedAt: '2026-07-12T00:00:00.000Z',
    })
  }
  const preferenceUpdate = {
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: memberAccess,
    input: { expectedRevision: 1, favorite: true, isDefault: false },
  }
  await expect(client.updateSavedView(preferenceUpdate)).rejects.toMatchObject({
    code: 'SavedViewRevisionConflict',
    status: 409,
  })
  expect(await client.updateSavedView(preferenceUpdate))
    .toMatchObject({ revision: 1, canEdit: false, favorite: true, isDefault: false })
  await expect(client.updateSavedView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: memberAccess,
    input: { expectedRevision: 1, name: 'Unauthorized rename' },
  })).rejects.toMatchObject({ code: 'SavedViewAccessDenied', status: 403 })

  const managerAccess = {
    ...memberAccess,
    viewerUserId: 'manager@example.com',
    manageableTeamIds: new Set(['core']),
  }
  expect(await client.listSavedViews({ workspaceId: 'workspace-1', access: managerAccess }))
    .toMatchObject({ views: [expect.objectContaining({ id: created.id, canEdit: true })] })
})

test('merges concurrent favorite and pin preference updates without lost writes', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
  }
  const created = await client.createSavedView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Concurrent preferences',
      visibility: 'personal',
      filters: {},
      layout: { mode: 'table', sort: [], columns: ['title'] },
    },
  })

  await Promise.all([
    client.updateSavedView({
      workspaceId: 'workspace-1',
      viewId: created.id,
      access,
      input: { expectedRevision: 1, favorite: true },
    }),
    client.updateSavedView({
      workspaceId: 'workspace-1',
      viewId: created.id,
      access,
      input: { expectedRevision: 1, pinned: true },
    }),
  ])

  expect(await client.listSavedViews({ workspaceId: 'workspace-1', access }))
    .toMatchObject({
      views: [expect.objectContaining({
        revision: 1,
        favorite: true,
        pinned: true,
      })],
    })
})

test('removes deleted custom field references with stable migration warnings', () => {
  const migrated = migrateSavedWorkspaceView({
    schemaVersion: 1,
    id: 'view-1',
    name: 'Custom view',
    visibility: 'personal',
    ownerUserId: 'owner@example.com',
    filters: {
      customFields: [
        { fieldId: 'kept', operator: 'equals', value: 'yes' },
        { fieldId: 'deleted', operator: 'equals', value: 'no' },
      ],
    },
    layout: {
      mode: 'table',
      sort: [
        { field: 'relevance', direction: 'desc' },
        { field: 'custom:deleted', direction: 'asc' },
      ],
      groupBy: 'custom:deleted',
      columns: ['title', 'custom:kept', 'custom:deleted'],
    },
    revision: 1,
    canEdit: true,
    favorite: false,
    pinned: false,
    isDefault: false,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }, new Set(['kept']))

  expect(migrated.filters.customFields?.map((filter) => filter.fieldId)).toEqual(['kept'])
  expect(migrated.layout).toMatchObject({
    columns: ['title', 'custom:kept'],
    sort: [{ field: 'relevance', direction: 'desc' }],
  })
  expect(migrated.layout.groupBy).toBeUndefined()
  expect(migrated.migrationWarnings).toHaveLength(4)
})

test('filters task views by surface and scope and binds cursors to that context', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['core']),
    writableTeamIds: new Set(['core']),
    manageableTeamIds: new Set(['core']),
    projectIds: new Set(['project-1', 'project-2']),
    writableProjectIds: new Set(['project-1', 'project-2']),
    projectScopeKeys: new Set(['core\0project-1', 'core\0project-2']),
    writableProjectScopeKeys: new Set(['core\0project-1', 'core\0project-2']),
  }
  const createProjectView = (projectId: string, name: string, idempotencyKey: string) =>
    client.createTaskView({
      workspaceId: 'workspace-1',
      access,
      idempotencyKey,
      input: {
        name,
        visibility: 'personal',
        definition: {
          surface: 'project',
          scope: { kind: 'project', projectId, teamId: 'core' },
          filters: {},
          layout: {
            mode: 'table',
            sort: [],
            columns: [{ field: 'title' }],
            density: 'compact',
            displayOptions: {},
          },
        },
      },
    })

  const firstProjectView = await createProjectView('project-1', 'Project one A', 'project-one-a')
  const secondProjectView = await createProjectView('project-1', 'Project one B', 'project-one-b')
  await createProjectView('project-2', 'Project two', 'project-two')
  await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Team queue',
      visibility: 'team',
      teamId: 'core',
      definition: {
        surface: 'team',
        scope: { kind: 'team', teamId: 'core' },
        filters: {},
        layout: {
          mode: 'board',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'comfortable',
          displayOptions: {},
        },
      },
    },
  })

  const projectPage = await client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'project',
    scope: { kind: 'project', projectId: 'project-1', teamId: 'core' },
    access,
  })
  expect(new Set(projectPage.views.map((view) => view.id))).toEqual(new Set([
    firstProjectView.id,
    secondProjectView.id,
  ]))
  expect(projectPage.capabilities).toEqual({
    canWrite: true,
    canManageSharedViews: false,
    canSetTeamDefault: true,
    writableTeamIds: ['core'],
    writableProjectScopes: [{ teamId: 'core', projectId: 'project-1' }],
  })

  const firstPage = await client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'project',
    scope: { kind: 'project', projectId: 'project-1', teamId: 'core' },
    access,
    limit: 1,
  })
  expect(firstPage.nextCursor).toBeString()
  await expect(client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'project',
    scope: { kind: 'project', projectId: 'project-2', teamId: 'core' },
    access,
    cursor: firstPage.nextCursor,
  })).rejects.toMatchObject({ code: 'InvalidTaskViewCursor', status: 400 })
})

test('reports mutation capabilities only for the exact task view list scope', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: false,
    canManageSharedViews: true,
    canWrite: true,
    teamIds: new Set(['read-only', 'writable', 'secondary']),
    writableTeamIds: new Set(['writable', 'secondary', 'not-readable']),
    manageableTeamIds: new Set(['writable']),
    projectIds: new Set(['project-a', 'project-b', 'project-read-only']),
    writableProjectIds: new Set(['project-a', 'project-b', 'project-read-only']),
    projectScopeKeys: new Set([
      'writable\0project-a',
      'secondary\0project-b',
      'read-only\0project-read-only',
    ]),
    writableProjectScopeKeys: new Set([
      'writable\0project-a',
      'secondary\0project-b',
      'read-only\0project-read-only',
      'not-readable\0private-project',
      'malformed-key',
    ]),
  }

  const unscoped = await client.listTaskViews({
    workspaceId: 'workspace-1',
    access,
  })
  const writableTeam = await client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'team',
    scope: { kind: 'team', teamId: 'writable' },
    access,
  })
  const readOnlyTeam = await client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'team',
    scope: { kind: 'team', teamId: 'read-only' },
    access,
  })
  const viewer = await client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'my-tasks',
    scope: { kind: 'viewer' },
    access,
  })
  const workspace = await client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'workspace-search',
    scope: { kind: 'workspace' },
    access,
  })
  const writableProject = await client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'project',
    scope: {
      kind: 'project',
      teamId: 'read-only',
      projectId: 'project-read-only',
    },
    access,
  })
  const globallyReadOnlyTeam = await client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'team',
    scope: { kind: 'team', teamId: 'writable' },
    access: { ...access, canWrite: false },
  })

  expect(unscoped.capabilities).toEqual({
    canWrite: false,
    canManageSharedViews: false,
    canSetTeamDefault: false,
    writableTeamIds: [],
    writableProjectScopes: [],
  })
  expect(writableTeam.capabilities).toEqual({
    canWrite: true,
    canManageSharedViews: true,
    canSetTeamDefault: true,
    writableTeamIds: ['writable'],
    writableProjectScopes: [{ teamId: 'writable', projectId: 'project-a' }],
  })
  expect(readOnlyTeam.capabilities).toEqual({
    canWrite: false,
    canManageSharedViews: false,
    canSetTeamDefault: false,
    writableTeamIds: [],
    writableProjectScopes: [{
      teamId: 'read-only',
      projectId: 'project-read-only',
    }],
  })
  expect(viewer.capabilities).toEqual({
    canWrite: true,
    canManageSharedViews: true,
    canSetTeamDefault: false,
    writableTeamIds: ['secondary', 'writable'],
    writableProjectScopes: [
      { teamId: 'read-only', projectId: 'project-read-only' },
      { teamId: 'secondary', projectId: 'project-b' },
      { teamId: 'writable', projectId: 'project-a' },
    ],
  })
  expect(workspace.capabilities).toEqual({
    canWrite: false,
    canManageSharedViews: false,
    canSetTeamDefault: false,
    writableTeamIds: ['secondary', 'writable'],
    writableProjectScopes: [
      { teamId: 'read-only', projectId: 'project-read-only' },
      { teamId: 'secondary', projectId: 'project-b' },
      { teamId: 'writable', projectId: 'project-a' },
    ],
  })
  expect(writableProject.capabilities).toEqual({
    canWrite: true,
    canManageSharedViews: true,
    canSetTeamDefault: false,
    writableTeamIds: [],
    writableProjectScopes: [{
      teamId: 'read-only',
      projectId: 'project-read-only',
    }],
  })
  expect(globallyReadOnlyTeam.capabilities).toEqual({
    canWrite: false,
    canManageSharedViews: false,
    canSetTeamDefault: false,
    writableTeamIds: ['writable'],
    writableProjectScopes: [{ teamId: 'writable', projectId: 'project-a' }],
  })
})

test('keeps Project scope authorization Team-qualified and rejects mismatched Team audiences', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['team-a', 'team-b']),
    writableTeamIds: new Set(['team-a', 'team-b']),
    manageableTeamIds: new Set(['team-a', 'team-b']),
    projectIds: new Set(['duplicate-project']),
    writableProjectIds: new Set(['duplicate-project']),
    projectScopeKeys: new Set(['team-a\0duplicate-project']),
    writableProjectScopeKeys: new Set(['team-a\0duplicate-project']),
  }
  const layout = {
    mode: 'table' as const,
    sort: [],
    columns: [{ field: 'title' }],
    density: 'compact' as const,
    displayOptions: {},
  }

  await expect(client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Wrong Project owner',
      visibility: 'personal',
      definition: {
        surface: 'project',
        scope: { kind: 'project', teamId: 'team-b', projectId: 'duplicate-project' },
        filters: {},
        layout,
      },
    },
  })).rejects.toMatchObject({ code: 'TaskViewAccessDenied', status: 403 })

  await expect(client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Wrong Team audience',
      visibility: 'team',
      teamId: 'team-b',
      definition: {
        surface: 'team',
        scope: { kind: 'team', teamId: 'team-a' },
        filters: {},
        layout,
      },
    },
  })).rejects.toMatchObject({ code: 'TaskViewAccessDenied', status: 403 })

  await expect(client.createTaskView({
    workspaceId: 'workspace-1',
    access: {
      ...access,
      isSystemAdmin: true,
      teamIds: new Set<string>(),
      writableTeamIds: new Set<string>(),
      manageableTeamIds: new Set<string>(),
      projectIds: new Set<string>(),
      writableProjectIds: new Set<string>(),
      projectScopeKeys: new Set<string>(),
      writableProjectScopeKeys: new Set<string>(),
    },
    input: {
      name: 'Missing Team',
      visibility: 'team',
      teamId: 'missing-team',
      definition: {
        surface: 'team',
        scope: { kind: 'team', teamId: 'missing-team' },
        filters: {},
        layout,
      },
    },
  })).rejects.toMatchObject({ code: 'TaskViewAccessDenied', status: 403 })
})

test('binds every task view mutation to its authoritative writable resource scope', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const projectDefinition = (teamId: string, projectId: string): TaskViewDefinition => ({
    surface: 'project',
    scope: { kind: 'project', teamId, projectId },
    filters: {},
    layout: {
      mode: 'table',
      sort: [],
      columns: [{ field: 'title' }],
      density: 'comfortable',
      displayOptions: {},
    },
  })
  const broadAccess = {
    viewerUserId: 'writer@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: false,
    canWriteWorkspaceScope: false,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['team-a', 'team-b']),
    writableTeamIds: new Set(['team-a', 'team-b']),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set(['project-a', 'project-b']),
    writableProjectIds: new Set(['project-a', 'project-b']),
    projectScopeKeys: new Set(['team-a\0project-a', 'team-b\0project-b']),
    writableProjectScopeKeys: new Set(['team-a\0project-a', 'team-b\0project-b']),
  }
  const projectBView = await client.createTaskView({
    workspaceId: 'workspace-1',
    access: broadAccess,
    input: {
      name: 'Project B queue',
      visibility: 'personal',
      definition: projectDefinition('team-b', 'project-b'),
    },
  })
  const projectAWriter = {
    ...broadAccess,
    writableTeamIds: new Set<string>(),
    writableProjectIds: new Set(['project-a']),
    writableProjectScopeKeys: new Set(['team-a\0project-a']),
  }

  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: projectBView.id,
    access: projectAWriter,
  })).toMatchObject({ id: projectBView.id, canEdit: false })
  await expect(client.createTaskView({
    workspaceId: 'workspace-1',
    access: projectAWriter,
    input: {
      name: 'Denied Project B copy',
      visibility: 'personal',
      definition: projectDefinition('team-b', 'project-b'),
    },
  })).rejects.toMatchObject({ code: 'TaskViewAccessDenied', status: 403 })
  await expect(client.createTaskView({
    workspaceId: 'workspace-1',
    access: projectAWriter,
    input: {
      name: 'Denied Team B audience',
      visibility: 'team',
      teamId: 'team-b',
      definition: {
        ...projectDefinition('team-a', 'project-a'),
        surface: 'my-tasks',
        scope: { kind: 'viewer' },
      },
    },
  })).rejects.toMatchObject({ code: 'TaskViewAccessDenied', status: 403 })
  await expect(client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: projectBView.id,
    access: projectAWriter,
    input: { expectedRevision: 1, favorite: true },
  })).rejects.toMatchObject({ code: 'TaskViewAccessDenied', status: 403 })
  await expect(client.duplicateTaskView({
    workspaceId: 'workspace-1',
    sourceViewId: projectBView.id,
    access: projectAWriter,
    input: { visibility: 'personal' },
  })).rejects.toMatchObject({ code: 'TaskViewAccessDenied', status: 403 })
  await expect(client.deleteTaskView({
    workspaceId: 'workspace-1',
    viewId: projectBView.id,
    expectedRevision: 1,
    access: projectAWriter,
  })).rejects.toMatchObject({ code: 'TaskViewAccessDenied', status: 403 })

  await expect(client.createTaskView({
    workspaceId: 'workspace-1',
    access: projectAWriter,
    input: {
      name: 'Project A queue',
      visibility: 'personal',
      definition: projectDefinition('team-a', 'project-a'),
    },
  })).resolves.toMatchObject({ name: 'Project A queue' })
  await expect(client.createTaskView({
    workspaceId: 'workspace-1',
    access: projectAWriter,
    input: {
      name: 'My Tasks queue',
      visibility: 'personal',
      definition: {
        ...projectDefinition('team-a', 'project-a'),
        surface: 'my-tasks',
        scope: { kind: 'viewer' },
      },
    },
  })).resolves.toMatchObject({ name: 'My Tasks queue' })
})

test('reads personal Focus views and rejects Triage until its queue ownership is defined', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const ownerAccess = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    writableTeamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  await expect(client.createTaskView({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    input: {
      name: 'Unowned triage queue',
      visibility: 'personal',
      definition: {
        surface: 'triage',
        scope: { kind: 'viewer' },
        filters: {},
        layout: {
          mode: 'list',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'compact',
          displayOptions: {},
        },
      },
    },
  })).rejects.toMatchObject({ code: 'InvalidTaskView', status: 400 })
  const created = await client.createTaskView({
    workspaceId: 'workspace-1',
    access: ownerAccess,
    input: {
      name: 'My focus',
      visibility: 'personal',
      definition: {
        surface: 'focus',
        scope: { kind: 'viewer' },
        filters: { priorities: ['high'] },
        layout: {
          mode: 'list',
          sort: [{ field: 'priority', direction: 'desc' }],
          columns: [{ field: 'title' }],
          density: 'compact',
          displayOptions: {},
        },
      },
    },
  })

  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: ownerAccess,
  })).toMatchObject({ id: created.id, definition: { surface: 'focus' } })
  await expect(client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: { ...ownerAccess, viewerUserId: 'other@example.com' },
  })).rejects.toMatchObject({ code: 'TaskViewNotFound', status: 404 })
})

test('resolves personal defaults before Team defaults and falls back after clearing personal state', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const managerAccess = {
    viewerUserId: 'manager@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['core']),
    writableTeamIds: new Set(['core']),
    manageableTeamIds: new Set(['core']),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  const definition = {
    surface: 'team' as const,
    scope: { kind: 'team' as const, teamId: 'core' },
    filters: {},
    layout: {
      mode: 'board' as const,
      sort: [],
      columns: [{ field: 'title' }],
      density: 'comfortable' as const,
      displayOptions: {},
    },
  }
  const teamDefault = await client.createTaskView({
    workspaceId: 'workspace-1',
    access: managerAccess,
    input: {
      name: 'Team default',
      visibility: 'team',
      teamId: 'core',
      definition,
      defaultSource: 'team',
    },
  })
  const memberAccess = {
    ...managerAccess,
    viewerUserId: 'member@example.com',
    manageableTeamIds: new Set<string>(),
  }

  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: teamDefault.id,
    access: memberAccess,
  })).toMatchObject({
    preference: { isDefault: true, defaultSource: 'team' },
  })

  const personalDefault = await client.createTaskView({
    workspaceId: 'workspace-1',
    access: memberAccess,
    input: {
      name: 'My default',
      visibility: 'personal',
      definition,
      defaultSource: 'personal',
    },
  })
  const withPersonal = await client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'team',
    scope: { kind: 'team', teamId: 'core' },
    access: memberAccess,
  })
  expect(withPersonal.views.find((view) => view.id === personalDefault.id)?.preference)
    .toMatchObject({
      isDefault: true,
      isPersonalDefault: true,
      isTeamDefault: false,
      defaultSource: 'personal',
    })
  expect(withPersonal.views.find((view) => view.id === teamDefault.id)?.preference)
    .toMatchObject({ isDefault: false, isPersonalDefault: false, isTeamDefault: true })

  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: personalDefault.id,
    access: memberAccess,
    input: { expectedRevision: 1, defaultSource: null },
  })
  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: teamDefault.id,
    access: memberAccess,
  })).toMatchObject({ preference: { isDefault: true, defaultSource: 'team' } })

  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: teamDefault.id,
    access: managerAccess,
    input: { expectedRevision: 1, defaultSource: 'personal' },
  })
  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: teamDefault.id,
    access: managerAccess,
  })).toMatchObject({
    preference: {
      isDefault: true,
      isPersonalDefault: true,
      isTeamDefault: true,
      defaultSource: 'personal',
    },
  })
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: teamDefault.id,
    access: managerAccess,
    input: { expectedRevision: 1, clearDefaultSource: 'personal' },
  })
  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: teamDefault.id,
    access: managerAccess,
  })).toMatchObject({ preference: { isDefault: true, defaultSource: 'team' } })
  await expect(client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: teamDefault.id,
    access: memberAccess,
    input: { expectedRevision: 1, defaultSource: null },
  })).rejects.toMatchObject({ code: 'TaskViewAccessDenied', status: 403 })
  await expect(client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: teamDefault.id,
    access: memberAccess,
    input: { expectedRevision: 1, clearDefaultSource: 'team' },
  })).rejects.toMatchObject({ code: 'TaskViewAccessDenied', status: 403 })
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: teamDefault.id,
    access: managerAccess,
    input: { expectedRevision: 1, clearDefaultSource: 'team' },
  })
  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: teamDefault.id,
    access: managerAccess,
  })).toMatchObject({
    preference: {
      isDefault: false,
      isPersonalDefault: false,
      isTeamDefault: false,
    },
  })
})

test('invalidates a Team default when its target stops being a Team-visible view', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const managerAccess = {
    viewerUserId: 'manager@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: true,
    canWrite: true,
    teamIds: new Set(['core']),
    writableTeamIds: new Set(['core']),
    manageableTeamIds: new Set(['core']),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  const created = await client.createTaskView({
    workspaceId: 'workspace-1',
    access: managerAccess,
    input: {
      name: 'Former Team default',
      visibility: 'team',
      teamId: 'core',
      defaultSource: 'team',
      definition: {
        surface: 'team',
        scope: { kind: 'team', teamId: 'core' },
        filters: {},
        layout: {
          mode: 'board',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'comfortable',
          displayOptions: {},
        },
      },
    },
  })
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: managerAccess,
    input: { expectedRevision: 1, visibility: 'shared', teamId: null },
  })
  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: { ...managerAccess, viewerUserId: 'member@example.com' },
  })).toMatchObject({ preference: { isDefault: false } })
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: managerAccess,
    input: { expectedRevision: 2, visibility: 'team', teamId: 'core' },
  })
  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: managerAccess,
  })).toMatchObject({ preference: { isDefault: false, isTeamDefault: false } })
})

test('does not resurrect a personal default after its view leaves and returns to a context', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['team-a', 'team-b']),
    writableTeamIds: new Set(['team-a', 'team-b']),
    manageableTeamIds: new Set(['team-a', 'team-b']),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  const layout = {
    mode: 'board' as const,
    sort: [],
    columns: [{ field: 'title' }],
    density: 'comfortable' as const,
    displayOptions: {},
  }
  const created = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Context-bound personal default',
      visibility: 'personal',
      defaultSource: 'personal',
      definition: {
        surface: 'team',
        scope: { kind: 'team', teamId: 'team-a' },
        filters: {},
        layout,
      },
    },
  })

  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access,
    input: {
      expectedRevision: 1,
      definition: {
        ...created.definition,
        scope: { kind: 'team', teamId: 'team-b' },
      },
    },
  })
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access,
    input: {
      expectedRevision: 2,
      definition: created.definition,
    },
  })

  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access,
  })).toMatchObject({
    preference: { isDefault: false, isPersonalDefault: false },
  })
})

test('keeps a recreated default marker when stale cleanup observes an older generation', async () => {
  const control: NonNullable<Parameters<typeof createMemoryDocumentClient>[1]> = {}
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([], control),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'manager@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['team-a', 'team-b']),
    writableTeamIds: new Set(['team-a', 'team-b']),
    manageableTeamIds: new Set(['team-a', 'team-b']),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  const layout = {
    mode: 'board' as const,
    sort: [],
    columns: [{ field: 'title' }],
    density: 'comfortable' as const,
    displayOptions: {},
  }
  const teamADefinition = {
    surface: 'team' as const,
    scope: { kind: 'team' as const, teamId: 'team-a' },
    filters: {},
    layout,
  }
  const target = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Default target',
      visibility: 'team',
      teamId: 'team-a',
      defaultSource: 'team',
      definition: teamADefinition,
    },
  })
  await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Team A anchor',
      visibility: 'team',
      teamId: 'team-a',
      definition: teamADefinition,
    },
  })
  let staleMarker: Record<string, unknown> | undefined
  control.beforeNextTransaction = (items) => {
    const marker = [...items.values()].find((item) =>
      item.entryType === 'task-view-default' &&
      item.ownerType === 'team' &&
      item.viewId === target.id
    )
    if (!marker) throw new Error('Expected the original Team default marker.')
    staleMarker = structuredClone(marker)
  }
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: target.id,
    access,
    input: {
      expectedRevision: 1,
      teamId: 'team-b',
      definition: {
        ...teamADefinition,
        scope: { kind: 'team', teamId: 'team-b' },
      },
    },
  })
  const capturedMarker = staleMarker
  if (!capturedMarker || typeof capturedMarker.recordKey !== 'string') {
    throw new Error('Expected a captured Team default marker.')
  }
  control.beforeNextTransaction = (items) => {
    items.set(`workspace-1\0${capturedMarker.recordKey}`, structuredClone(capturedMarker))
  }
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: target.id,
    access,
    input: { expectedRevision: 2, favorite: true },
  })

  control.beforeNextTransaction = (items) => {
    const targetKey = `workspace-1\0${createTaskViewRecordKey(target.id)}`
    const targetRow = items.get(targetKey)
    if (!targetRow) throw new Error('Expected the task view target row.')
    items.set(targetKey, {
      ...targetRow,
      teamId: 'team-a',
      definition: teamADefinition,
      revision: 3,
      updatedAt: '2099-08-09T00:00:00.000Z',
    })
    items.set(`workspace-1\0${capturedMarker.recordKey}`, {
      ...capturedMarker,
      generation: '00000000-0000-4000-8000-000000000001',
    })
  }
  await client.listTaskViews({
    workspaceId: 'workspace-1',
    surface: 'team',
    scope: { kind: 'team', teamId: 'team-a' },
    access,
  })

  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: target.id,
    access,
  })).toMatchObject({
    preference: { isDefault: true, isTeamDefault: true },
  })
})

test('duplicates a sanitized task view into an independent idempotent lifecycle', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    writableTeamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
    activeCustomFieldIds: new Set(['kept']),
    readableCustomFieldIds: new Set(['kept']),
  }
  const source = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Source',
      description: 'Original',
      visibility: 'personal',
      definition: {
        surface: 'my-tasks',
        scope: { kind: 'viewer' },
        filters: {
          customFields: [
            { fieldId: 'kept', operator: 'equals', value: 'yes' },
            { fieldId: 'deleted', operator: 'equals', value: 'no' },
          ],
        },
        layout: {
          mode: 'table',
          sort: [],
          columns: [{ field: 'title' }, { field: 'custom:deleted' }],
          density: 'compact',
          displayOptions: {},
        },
      },
    },
  })
  const duplicateRequest = {
    workspaceId: 'workspace-1',
    sourceViewId: source.id,
    access,
    idempotencyKey: 'duplicate-source',
    input: { name: 'Copy', description: null, favorite: true },
  }
  const duplicate = await client.duplicateTaskView(duplicateRequest)
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: source.id,
    access,
    input: { expectedRevision: 1, name: 'Changed source' },
  })
  const replay = await client.duplicateTaskView(duplicateRequest)

  expect(replay).toEqual(duplicate)
  expect(duplicate).toMatchObject({
    name: 'Copy',
    revision: 1,
    preference: { favorite: true },
  })
  expect(duplicate.description).toBeUndefined()
  expect(duplicate.definition.filters.customFields?.map((filter) => filter.fieldId)).toEqual(['kept'])
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: duplicate.id,
    access,
    input: { expectedRevision: 1, name: 'Independent copy' },
  })
  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: source.id,
    access,
  })).toMatchObject({ name: 'Changed source', revision: 2 })
})

test('sanitizes deleted and permission-restricted task view references with stable warnings', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['core']),
    writableTeamIds: new Set(['core']),
    manageableTeamIds: new Set(['core']),
    projectIds: new Set(['project-1']),
    writableProjectIds: new Set(['project-1']),
    projectScopeKeys: new Set(['core\0project-1']),
    writableProjectScopeKeys: new Set(['core\0project-1']),
    activeCustomFieldIds: new Set(['kept', 'private']),
    readableCustomFieldIds: new Set(['kept']),
    activeStatusIds: new Set(['core\0todo']),
    readableColumnIds: new Set(['title', 'customFields']),
    readableActorIds: new Set(['owner@example.com']),
    readableRelationIds: new Set(['visible-relation']),
  }
  const created = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Migration source',
      visibility: 'personal',
      definition: {
        surface: 'team',
        scope: { kind: 'team', teamId: 'core' },
        filters: {
          assigneeUserIds: ['owner@example.com', 'hidden@example.com'],
          creatorUserIds: ['hidden@example.com'],
          relationIds: ['visible-relation', 'hidden-relation'],
          teamIds: ['core', 'secret'],
          projectIds: ['project-1', 'project-2'],
          statuses: ['todo', 'gone'],
          workflowStatuses: [
            { teamId: 'core', statusId: 'todo' },
            { teamId: 'core', statusId: 'gone' },
            { teamId: 'secret', statusId: 'hidden' },
          ],
          customFields: [
            { fieldId: 'kept', operator: 'equals', value: 'yes' },
            { fieldId: 'deleted', operator: 'equals', value: 'no' },
            { fieldId: 'private', operator: 'equals', value: 'hidden' },
          ],
        },
        layout: {
          mode: 'table',
          group: { field: 'custom:deleted', direction: 'asc' },
          subgroup: { field: 'custom:private', direction: 'asc' },
          sort: [
            { field: 'custom:kept', direction: 'asc' },
            { field: 'customFields', direction: 'asc' },
            { field: 'unknown-built-in', direction: 'desc' },
          ],
          columns: [
            { field: 'title' },
            { field: 'customFields' },
            { field: 'status' },
            { field: 'custom:kept' },
            { field: 'custom:deleted' },
            { field: 'custom:private' },
          ],
          density: 'comfortable',
          displayOptions: {},
        },
      },
    },
  })

  expect(created.definition.filters).toMatchObject({
    assigneeUserIds: ['owner@example.com'],
    creatorUserIds: [],
    relationIds: ['visible-relation'],
    teamIds: ['core'],
    projectIds: ['project-1'],
    statuses: ['todo'],
    workflowStatuses: [{ teamId: 'core', statusId: 'todo' }],
    customFields: [{ fieldId: 'kept', operator: 'equals', value: 'yes' }],
  })
  expect(created.definition.layout).toMatchObject({
    sort: [{ field: 'custom:kept', direction: 'asc' }],
    columns: [
      { field: 'title' },
      { field: 'customFields' },
      { field: 'custom:kept' },
    ],
  })
  expect(created.definition.layout.group).toBeUndefined()
  expect(created.definition.layout.subgroup).toBeUndefined()
  expect(new Set(created.migrationWarnings?.map((warning) => warning.code))).toEqual(new Set([
    'deleted-custom-field',
    'deleted-workflow-status',
    'permission-redacted',
    'invalid-layout',
  ]))
  expect(created.migrationWarnings?.every((warning) => warning.referenceId === undefined)).toBe(true)
})

test('retains a currently authorized relation target with no source edge and redacts it after access loss', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  let targetReadable = true
  const resolvedInputs: Array<{
    relationIds: readonly string[]
    surface: string
    scopeKind: string
  }> = []
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['core']),
    writableTeamIds: new Set(['core']),
    manageableTeamIds: new Set(['core']),
    projectIds: new Set(['project-1']),
    writableProjectIds: new Set(['project-1']),
    projectScopeKeys: new Set(['core\0project-1']),
    writableProjectScopeKeys: new Set(['core\0project-1']),
    async resolveReadableRelationIds(input: {
      relationIds: readonly string[]
      surface: string
      scope: { kind: string }
    }) {
      await Promise.resolve()
      resolvedInputs.push({
        relationIds: [...input.relationIds],
        surface: input.surface,
        scopeKind: input.scope.kind,
      })
      return targetReadable
        ? new Set(['blocks:target-without-edge'])
        : new Set<string>()
    },
  }
  const created = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Blocked by target',
      visibility: 'personal',
      definition: {
        surface: 'team',
        scope: { kind: 'team', teamId: 'core' },
        filters: { relationIds: ['blocks:target-without-edge'] },
        layout: {
          mode: 'table',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'comfortable',
          displayOptions: {},
        },
      },
    },
  })

  expect(created.definition.filters.relationIds).toEqual(['blocks:target-without-edge'])
  expect(created.migrationWarnings).toBeUndefined()

  targetReadable = false
  const afterPermissionLoss = await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access,
  })

  expect(afterPermissionLoss.definition.filters.relationIds).toEqual([])
  expect(afterPermissionLoss.migrationWarnings).toContainEqual({
    code: 'permission-redacted',
    section: 'filter',
    fallback: 'removed',
  })
  expect(resolvedInputs).toEqual([
    {
      relationIds: ['blocks:target-without-edge'],
      surface: 'team',
      scopeKind: 'team',
    },
    {
      relationIds: ['blocks:target-without-edge'],
      surface: 'team',
      scopeKind: 'team',
    },
  ])
})

test('retains a duplicate Project ID when the task view scope safely qualifies its Team', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set(['team-a']),
    writableTeamIds: new Set(['team-a']),
    manageableTeamIds: new Set(['team-a']),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set(['team-a\0roadmap']),
    writableProjectScopeKeys: new Set(['team-a\0roadmap']),
  }

  const created = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Qualified roadmap',
      visibility: 'personal',
      definition: {
        surface: 'project',
        scope: { kind: 'project', projectId: 'roadmap', teamId: 'team-a' },
        filters: { projectIds: ['roadmap'] },
        layout: {
          mode: 'table',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'comfortable',
          displayOptions: {},
        },
      },
    },
  })

  expect(created.definition.filters.projectIds).toEqual(['roadmap'])
  expect(created.migrationWarnings).toBeUndefined()
})

test('rejects a normalized task view definition that exceeds the DynamoDB item budget', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const fieldIds = Array.from({ length: 20 }, (_, index) => `field-${index}`)
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    writableTeamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
    activeCustomFieldIds: new Set(fieldIds),
    readableCustomFieldIds: new Set(fieldIds),
  }

  await expect(client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Oversized definition',
      visibility: 'personal',
      definition: {
        surface: 'my-tasks',
        scope: { kind: 'viewer' },
        filters: {
          customFields: fieldIds.map((fieldId) => ({
            fieldId,
            operator: 'equals',
            value: 'x'.repeat(20_000),
          })),
        },
        layout: {
          mode: 'table',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'compact',
          displayOptions: {},
        },
      },
    },
  })).rejects.toMatchObject({ code: 'InvalidTaskView', status: 400 })
})

test('replays task view updates without reverting newer preference, default, or definition state', async () => {
  const control: NonNullable<Parameters<typeof createMemoryDocumentClient>[1]> = {}
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([], control),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    writableTeamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  const definition = {
    surface: 'my-tasks' as const,
    scope: { kind: 'viewer' as const },
    filters: {},
    layout: {
      mode: 'list' as const,
      sort: [],
      columns: [{ field: 'title' }],
      density: 'compact' as const,
      displayOptions: {},
    },
  }
  const primary = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: { name: 'Primary', visibility: 'personal', definition },
  })
  const replacement = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: { name: 'Replacement', visibility: 'personal', definition },
  })
  const firstRequest = {
    workspaceId: 'workspace-1',
    viewId: primary.id,
    access,
    idempotencyKey: 'preference-a',
    input: {
      expectedRevision: 1,
      favorite: true,
      defaultSource: 'personal' as const,
    },
  }

  await client.updateTaskView(firstRequest)
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: primary.id,
    access,
    idempotencyKey: 'preference-b',
    input: { expectedRevision: 1, favorite: false },
  })
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: replacement.id,
    access,
    idempotencyKey: 'default-b',
    input: { expectedRevision: 1, defaultSource: 'personal' },
  })

  expect(await client.updateTaskView(firstRequest)).toMatchObject({
    revision: 1,
    preference: { favorite: false, isDefault: false },
  })
  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: replacement.id,
    access,
  })).toMatchObject({ preference: { isDefault: true, isPersonalDefault: true } })
  await expect(client.updateTaskView({
    ...firstRequest,
    input: { expectedRevision: 1, favorite: false, defaultSource: 'personal' },
  })).rejects.toMatchObject({ code: 'TaskViewIdempotencyConflict', status: 409 })

  const definitionRequest = {
    workspaceId: 'workspace-1',
    viewId: primary.id,
    access,
    idempotencyKey: 'definition-a',
    input: { expectedRevision: 1, name: 'First committed name' },
  }
  expect(await client.updateTaskView(definitionRequest)).toMatchObject({
    name: 'First committed name',
    revision: 2,
  })
  expect(await client.updateTaskView(definitionRequest)).toMatchObject({
    name: 'First committed name',
    revision: 2,
  })
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: primary.id,
    access,
    idempotencyKey: 'definition-b',
    input: { expectedRevision: 2, name: 'Latest committed name' },
  })
  expect(await client.updateTaskView(definitionRequest)).toMatchObject({
    name: 'Latest committed name',
    revision: 3,
  })

  control.failNextTransaction = true
  const atomicRequest = {
    workspaceId: 'workspace-1',
    viewId: primary.id,
    access,
    idempotencyKey: 'atomic-update',
    input: { expectedRevision: 3, pinned: true },
  }
  await expect(client.updateTaskView(atomicRequest)).rejects.toThrow('transaction failed')
  let atomicReceiptRecordKey: string | undefined
  control.beforeNextTransaction = (_items, transactItems) => {
    const receipt = transactItems
      .flatMap((item) => isMemoryRecord(item.Put?.Item) ? [item.Put.Item] : [])
      .find((item) => item.entryType === 'task-view-mutation-receipt')
    if (!receipt || typeof receipt.recordKey !== 'string') {
      throw new Error('Expected the atomic update receipt.')
    }
    atomicReceiptRecordKey = receipt.recordKey
  }
  expect(await client.updateTaskView(atomicRequest)).toMatchObject({
    revision: 3,
    preference: { pinned: true },
  })

  const capturedReceiptRecordKey = atomicReceiptRecordKey
  if (!capturedReceiptRecordKey) throw new Error('Expected a captured atomic update receipt.')
  control.beforeNextTransaction = (items) => {
    const receiptKey = `workspace-1\0${capturedReceiptRecordKey}`
    const receipt = items.get(receiptKey)
    if (!receipt) throw new Error('Expected the committed atomic update receipt.')
    items.set(receiptKey, {
      ...receipt,
      committedAt: '2000-01-01T00:00:00.000Z',
      expiresAt: 946_771_200,
    })
  }
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: replacement.id,
    access,
    input: { expectedRevision: 1, pinned: true },
  })
  expect(await client.updateTaskView({
    ...atomicRequest,
    input: { expectedRevision: 3, pinned: false },
  })).toMatchObject({
    revision: 3,
    preference: { pinned: false },
  })
})

test('replays a same-key concurrent task view update after the receipt wins its transaction', async () => {
  const control: NonNullable<Parameters<typeof createMemoryDocumentClient>[1]> = {}
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([], control),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    writableTeamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  const created = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Concurrent replay',
      visibility: 'personal',
      definition: {
        surface: 'my-tasks',
        scope: { kind: 'viewer' },
        filters: {},
        layout: {
          mode: 'list',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'compact',
          displayOptions: {},
        },
      },
    },
  })
  let installedReceipt = false
  control.beforeNextTransaction = (items, transactItems) => {
    const preferenceMutation = transactItems.find((item) => {
      const key = item.Update?.Key
      return isMemoryRecord(key) &&
        typeof key.recordKey === 'string' &&
        key.recordKey.startsWith('TASK_VIEW_PREFERENCE#')
    })
    if (!preferenceMutation) {
      throw new Error('Expected a task view preference transaction item.')
    }
    applyMemoryTransactionItem(items, preferenceMutation, 0, 1)
    const receipt = transactItems
      .flatMap((item) => isMemoryRecord(item.Put?.Item) ? [item.Put.Item] : [])
      .find((item) => item?.entryType === 'task-view-mutation-receipt')
    if (!receipt) throw new Error('Expected a task view mutation receipt transaction item.')
    if (typeof receipt.committedAt !== 'string' || typeof receipt.expiresAt !== 'number') {
      throw new Error('Expected a timestamped task view mutation receipt.')
    }
    expect(receipt.expiresAt).toBe(
      Math.floor(Date.parse(receipt.committedAt) / 1_000) + 24 * 60 * 60,
    )
    items.set(
      `${String(receipt.workspaceId)}\0${String(receipt.recordKey)}`,
      structuredClone(receipt),
    )
    installedReceipt = true
  }

  const replay = await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access,
    idempotencyKey: 'concurrent-update',
    input: { expectedRevision: 1, favorite: true },
  })

  expect(installedReceipt).toBeTrue()
  expect(replay).toMatchObject({
    id: created.id,
    revision: 1,
    preference: { favorite: true },
  })
})

test('replays task view deletion from a durable actor-bound receipt', async () => {
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([]),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    writableTeamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  const definition = {
    surface: 'my-tasks' as const,
    scope: { kind: 'viewer' as const },
    filters: {},
    layout: {
      mode: 'list' as const,
      sort: [],
      columns: [{ field: 'title' }],
      density: 'compact' as const,
      displayOptions: {},
    },
  }
  const created = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: { name: 'Delete once', visibility: 'personal', definition },
  })
  const request = {
    workspaceId: 'workspace-1',
    viewId: created.id,
    expectedRevision: 1,
    access,
    idempotencyKey: 'delete-once',
  }

  const deleted = await client.deleteTaskView(request)
  expect(await client.deleteTaskView(request)).toEqual(deleted)
  await expect(client.deleteTaskView({
    ...request,
    expectedRevision: 2,
  })).rejects.toMatchObject({ code: 'TaskViewIdempotencyConflict', status: 409 })
  await expect(client.deleteTaskView({
    ...request,
    access: { ...access, viewerUserId: 'other@example.com' },
  })).rejects.toMatchObject({ code: 'TaskViewNotFound', status: 404 })

  const withoutKey = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: { name: 'Legacy delete', visibility: 'personal', definition },
  })
  await client.deleteTaskView({
    workspaceId: 'workspace-1',
    viewId: withoutKey.id,
    expectedRevision: 1,
    access,
  })
  await expect(client.deleteTaskView({
    workspaceId: 'workspace-1',
    viewId: withoutKey.id,
    expectedRevision: 1,
    access,
  })).rejects.toMatchObject({ code: 'TaskViewNotFound', status: 404 })
})

test('keeps a committed task view deletion successful when preference cleanup is unavailable', async () => {
  const control: NonNullable<Parameters<typeof createMemoryDocumentClient>[1]> = {
    failNextQuery: false,
  }
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([], control),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    writableTeamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  const created = await client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name: 'Cleanup outage',
      visibility: 'personal',
      definition: {
        surface: 'my-tasks',
        scope: { kind: 'viewer' },
        filters: {},
        layout: {
          mode: 'list',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'compact',
          displayOptions: {},
        },
      },
    },
  })
  control.failNextQuery = true

  await expect(client.deleteTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    expectedRevision: 1,
    access,
  })).resolves.toEqual({ id: created.id, revision: 1 })
  await expect(client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access,
  })).rejects.toMatchObject({ code: 'TaskViewNotFound', status: 404 })
})

test('rejects task view updates when a concurrent delete removes the live row', async () => {
  const control: NonNullable<Parameters<typeof createMemoryDocumentClient>[1]> = {}
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([], control),
    {} as DynamoDBClient,
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    writableTeamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  /** Creates one personal task view used as a target for the concurrent-delete race. */
  const createView = (name: string) => client.createTaskView({
    workspaceId: 'workspace-1',
    access,
    input: {
      name,
      visibility: 'personal',
      definition: {
        surface: 'my-tasks',
        scope: { kind: 'viewer' },
        filters: {},
        layout: {
          mode: 'list',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'compact',
          displayOptions: {},
        },
      },
    },
  })
  const definitionTarget = await createView('Definition target')
  const preferenceTarget = await createView('Preference target')

  control.beforeNextTransaction = (items) => {
    const liveRecordKey = createTaskViewRecordKey(definitionTarget.id)
    const tombstoneRecordKey = `TASK_VIEW_TOMBSTONE#${definitionTarget.id}`
    items.delete(`workspace-1\0${liveRecordKey}`)
    items.set(`workspace-1\0${tombstoneRecordKey}`, {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      recordKey: tombstoneRecordKey,
      entryType: 'task-view-tombstone',
      id: definitionTarget.id,
      revision: definitionTarget.revision,
      deletedAt: '2026-08-09T00:00:00.000Z',
    })
  }
  await expect(client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: definitionTarget.id,
    access,
    input: { expectedRevision: 1, name: 'Must not update the tombstone' },
  })).rejects.toMatchObject({ code: 'TaskViewRevisionConflict', status: 409 })

  control.beforeNextTransaction = (items) => {
    const liveRecordKey = createTaskViewRecordKey(preferenceTarget.id)
    const tombstoneRecordKey = `TASK_VIEW_TOMBSTONE#${preferenceTarget.id}`
    items.delete(`workspace-1\0${liveRecordKey}`)
    items.set(`workspace-1\0${tombstoneRecordKey}`, {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      recordKey: tombstoneRecordKey,
      entryType: 'task-view-tombstone',
      id: preferenceTarget.id,
      revision: preferenceTarget.revision,
      deletedAt: '2026-08-09T00:00:00.000Z',
    })
  }
  await expect(client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: preferenceTarget.id,
    access,
    input: { expectedRevision: 1, favorite: true },
  })).rejects.toMatchObject({ code: 'TaskViewRevisionConflict', status: 409 })
})

test('returns a stable conflict when deletion commits between create replay reads', async () => {
  const control: NonNullable<Parameters<typeof createMemoryDocumentClient>[1]> = {}
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([], control),
    new DynamoDBClient({}),
    false,
  )
  const access = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
    canWrite: true,
    teamIds: new Set<string>(),
    writableTeamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  const createRequest: CreateTaskViewRequest = {
    workspaceId: 'workspace-1',
    access,
    idempotencyKey: 'delete-between-replay-reads',
    input: {
      name: 'Delete during replay',
      visibility: 'personal',
      definition: {
        surface: 'my-tasks',
        scope: { kind: 'viewer' },
        filters: {},
        layout: {
          mode: 'list',
          sort: [],
          columns: [{ field: 'title' }],
          density: 'compact',
          displayOptions: {},
        },
      },
    },
  }
  const created = await client.createTaskView(createRequest)
  let liveReadCount = 0
  control.beforeGet = (items, workspaceId, recordKey) => {
    const liveRecordKey = createTaskViewRecordKey(created.id)
    if (workspaceId !== 'workspace-1' || recordKey !== liveRecordKey) return
    liveReadCount += 1
    if (liveReadCount !== 2) return
    const mapKey = `${workspaceId}\0${recordKey}`
    const liveView = items.get(mapKey)
    if (
      !liveView ||
      typeof liveView.createIdempotencyKeyHash !== 'string' ||
      typeof liveView.createRequestFingerprint !== 'string' ||
      typeof liveView.revision !== 'number'
    ) {
      throw new Error('Expected an idempotent live task view.')
    }
    const tombstoneRecordKey = `TASK_VIEW_TOMBSTONE#${created.id}`
    items.delete(mapKey)
    items.set(`${workspaceId}\0${tombstoneRecordKey}`, {
      schemaVersion: 1,
      workspaceId,
      recordKey: tombstoneRecordKey,
      entryType: 'task-view-tombstone',
      id: created.id,
      revision: liveView.revision,
      createIdempotencyKeyHash: liveView.createIdempotencyKeyHash,
      createRequestFingerprint: liveView.createRequestFingerprint,
      deletedAt: '2026-08-09T00:00:00.000Z',
    })
  }

  await expect(client.createTaskView(createRequest)).rejects.toMatchObject({
    code: 'TaskViewIdempotencyConflict',
    status: 409,
  })
  expect(liveReadCount).toBe(2)
})

test('prevents idempotent recreation from reviving another viewer preference lifecycle', async () => {
  const liveListPages: string[][] = []
  const control: NonNullable<Parameters<typeof createMemoryDocumentClient>[1]> = {
    observeQuery(prefix, recordKeys) {
      if (prefix === 'TASK_VIEW#') liveListPages.push([...recordKeys])
    },
  }
  const client = new DynamoDbWorkspaceSearchClient(
    'search-table',
    createMemoryDocumentClient([], control),
    {} as DynamoDBClient,
    false,
  )
  const ownerAccess = {
    viewerUserId: 'owner@example.com',
    isSystemAdmin: false,
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: true,
    canWrite: true,
    teamIds: new Set<string>(),
    writableTeamIds: new Set<string>(),
    manageableTeamIds: new Set<string>(),
    projectIds: new Set<string>(),
    writableProjectIds: new Set<string>(),
    projectScopeKeys: new Set<string>(),
    writableProjectScopeKeys: new Set<string>(),
  }
  const createRequest = {
    workspaceId: 'workspace-1',
    access: ownerAccess,
    idempotencyKey: 'reusable-shared-view',
    input: {
      name: 'Shared queue',
      visibility: 'shared' as const,
      definition: {
        surface: 'workspace-search' as const,
        scope: { kind: 'workspace' as const },
        filters: {},
        layout: {
          mode: 'table' as const,
          sort: [],
          columns: [{ field: 'title' }],
          density: 'compact' as const,
          displayOptions: {},
        },
      },
    },
  }
  const created = await client.createTaskView(createRequest)
  const memberAccess = {
    ...ownerAccess,
    viewerUserId: 'member@example.com',
    canAccessWorkspaceScope: true,
    canWriteWorkspaceScope: true,
    canManageSharedViews: false,
  }
  let sharedViewerPreferenceRecordKey: string | undefined
  control.beforeNextTransaction = (_items, transactItems) => {
    const preferenceMutation = transactItems.find((item) => {
      const key = item.Update?.Key
      return isMemoryRecord(key) &&
        typeof key.recordKey === 'string' &&
        key.recordKey.startsWith('TASK_VIEW_PREFERENCE#')
    })
    const key = preferenceMutation?.Update?.Key
    if (!isMemoryRecord(key) || typeof key.recordKey !== 'string') {
      throw new Error('Expected a shared viewer preference transaction item.')
    }
    sharedViewerPreferenceRecordKey = key.recordKey
  }
  await client.updateTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    access: memberAccess,
    input: {
      expectedRevision: 1,
      favorite: true,
      pinned: true,
      defaultSource: 'personal',
    },
  })
  if (!sharedViewerPreferenceRecordKey) {
    throw new Error('Expected a captured shared viewer preference record key.')
  }
  let deletionTombstoneRecordKey: string | undefined
  let sharedViewerPreferenceDeleted = false
  /** Captures the main deletion and the subsequent paginated preference cleanup transaction. */
  const observeDeletionTransaction = (
    _items: Map<string, Record<string, unknown>>,
    transactItems: Array<Record<string, Record<string, unknown>>>,
  ) => {
    const tombstone = transactItems
      .flatMap((item) => isMemoryRecord(item.Put?.Item) ? [item.Put.Item] : [])
      .find((item) => item.entryType === 'task-view-tombstone')
    if (tombstone && typeof tombstone.recordKey === 'string') {
      deletionTombstoneRecordKey = tombstone.recordKey
    }
    sharedViewerPreferenceDeleted ||= transactItems.some((item) => {
      const key = item.Delete?.Key
      return isMemoryRecord(key) &&
        key.recordKey === sharedViewerPreferenceRecordKey
    })
    if (tombstone) {
      control.beforeNextTransaction = observeDeletionTransaction
    } else if (!sharedViewerPreferenceDeleted) {
      throw new Error('Expected a task view deletion cleanup transaction.')
    }
  }
  control.beforeNextTransaction = observeDeletionTransaction
  await client.deleteTaskView({
    workspaceId: 'workspace-1',
    viewId: created.id,
    expectedRevision: 1,
    access: ownerAccess,
  })

  const expectedTombstoneRecordKey = `TASK_VIEW_TOMBSTONE#${created.id}`
  expect(deletionTombstoneRecordKey).toBe(expectedTombstoneRecordKey)
  expect(sharedViewerPreferenceDeleted).toBeTrue()
  let createTombstoneBlockerObserved = false
  control.beforeNextTransaction = (_items, transactItems) => {
    createTombstoneBlockerObserved = transactItems.some((item) => {
      const key = item.ConditionCheck?.Key
      return isMemoryRecord(key) && key.recordKey === expectedTombstoneRecordKey
    })
  }
  await expect(client.createTaskView(createRequest)).rejects.toMatchObject({
    code: 'TaskViewIdempotencyConflict',
    status: 409,
  })
  expect(createTombstoneBlockerObserved).toBeTrue()
  expect(await client.listTaskViews({
    workspaceId: 'workspace-1',
    access: memberAccess,
  })).toEqual({
    capabilities: {
      canWrite: false,
      canManageSharedViews: false,
      canSetTeamDefault: false,
      writableTeamIds: [],
      writableProjectScopes: [],
    },
    views: [],
  })
  expect(liveListPages).toEqual([[]])
  const recreated = await client.createTaskView({
    workspaceId: createRequest.workspaceId,
    access: createRequest.access,
    input: createRequest.input,
  })
  expect(recreated.id).not.toBe(created.id)
  expect(await client.getTaskView({
    workspaceId: 'workspace-1',
    viewId: recreated.id,
    access: memberAccess,
  })).toMatchObject({
    preference: {
      favorite: false,
      pinned: false,
      isDefault: false,
    },
  })
})

test('waits for a newly created local search table to become active', async () => {
  const commands: string[] = []
  let describeCount = 0
  const dynamoDbClient = {
    async send(
      command:
        | CreateTableCommand
        | DescribeTableCommand
        | DescribeTimeToLiveCommand
        | UpdateTimeToLiveCommand,
    ) {
      commands.push(command.constructor.name)
      if (command instanceof CreateTableCommand) return {}
      if (command instanceof DescribeTimeToLiveCommand) {
        return {
          TimeToLiveDescription: {
            AttributeName: 'expiresAt',
            TimeToLiveStatus: 'ENABLED',
          },
        }
      }
      if (command instanceof UpdateTimeToLiveCommand) return {}
      describeCount += 1
      if (describeCount === 1) {
        const error = new Error('missing')
        error.name = 'ResourceNotFoundException'
        throw error
      }
      return {
        Table: {
          TableStatus: describeCount >= 3 ? 'ACTIVE' : 'CREATING',
          KeySchema: [
            { AttributeName: 'workspaceId', KeyType: 'HASH' },
            { AttributeName: 'recordKey', KeyType: 'RANGE' },
          ],
        },
      }
    },
  } as unknown as DynamoDBClient

  await ensureLocalWorkspaceSearchTable('search-table', dynamoDbClient)

  expect(commands).toEqual([
    'DescribeTableCommand',
    'CreateTableCommand',
    'DescribeTableCommand',
    'DescribeTableCommand',
    'DescribeTimeToLiveCommand',
  ])
})

test('enables and verifies expiresAt TTL on an existing local search table', async () => {
  const commands: string[] = []
  let ttlDescribeCount = 0
  const dynamoDbClient = {
    async send(
      command:
        | DescribeTableCommand
        | DescribeTimeToLiveCommand
        | UpdateTimeToLiveCommand,
    ) {
      commands.push(command.constructor.name)
      if (command instanceof DescribeTableCommand) {
        return {
          Table: {
            TableStatus: 'ACTIVE',
            KeySchema: [
              { AttributeName: 'workspaceId', KeyType: 'HASH' },
              { AttributeName: 'recordKey', KeyType: 'RANGE' },
            ],
          },
        }
      }
      if (command instanceof UpdateTimeToLiveCommand) return {}
      ttlDescribeCount += 1
      return ttlDescribeCount === 1
        ? { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } }
        : {
            TimeToLiveDescription: {
              AttributeName: 'expiresAt',
              TimeToLiveStatus: 'ENABLING',
            },
          }
    },
  } as unknown as DynamoDBClient

  await ensureLocalWorkspaceSearchTable('search-table', dynamoDbClient)

  expect(commands).toEqual([
    'DescribeTableCommand',
    'DescribeTimeToLiveCommand',
    'UpdateTimeToLiveCommand',
    'DescribeTimeToLiveCommand',
  ])
})

function createMemoryDocumentClient(
  initialItems: Array<Record<string, unknown>>,
  control: {
    failNextTransaction?: boolean
    /** Fails the next paginated Query to simulate a post-commit cleanup outage. */
    failNextQuery?: boolean
    beforeNextTransaction?: (
      items: Map<string, Record<string, unknown>>,
      transactItems: Array<Record<string, Record<string, unknown>>>,
    ) => void
    /** Observes the record keys returned by each in-memory query page. */
    observeQuery?: (prefix: string, recordKeys: readonly string[]) => void
    /** Mutates or observes in-memory state immediately before one point read. */
    beforeGet?: (
      items: Map<string, Record<string, unknown>>,
      workspaceId: string,
      recordKey: string,
    ) => void
  } = {},
) {
  const items = new Map(
    initialItems.map((item) => [`${String(item.workspaceId)}\0${String(item.recordKey)}`, structuredClone(item)]),
  )
  return {
    async send(command: { input: Record<string, unknown> }) {
      const input = command.input
      const transactItems = input.TransactItems as Array<Record<string, Record<string, unknown>>> | undefined
      if (transactItems) {
        if (control.failNextTransaction) {
          control.failNextTransaction = false
          throw new Error('transaction failed')
        }
        const beforeNextTransaction = control.beforeNextTransaction
        control.beforeNextTransaction = undefined
        beforeNextTransaction?.(items, transactItems)
        const pendingItems = new Map(
          [...items].map(([key, item]) => [key, structuredClone(item)]),
        )
        for (const [index, transactItem] of transactItems.entries()) {
          applyMemoryTransactionItem(pendingItems, transactItem, index, transactItems.length)
        }
        items.clear()
        for (const [key, item] of pendingItems) items.set(key, item)
        return {}
      }
      const expressionValues = input.ExpressionAttributeValues as Record<string, unknown> | undefined
      const tableItems = [...items.values()]
        .filter((item) => item.workspaceId === expressionValues?.[':workspaceId'])
        .sort((left, right) => String(left.recordKey) < String(right.recordKey)
          ? -1
          : String(left.recordKey) > String(right.recordKey) ? 1 : 0)
      if ('KeyConditionExpression' in input) {
        if (control.failNextQuery) {
          control.failNextQuery = false
          throw new Error('query failed')
        }
        const prefix = String(expressionValues?.[':prefix'] ?? '')
        const startKey = (input.ExclusiveStartKey as { recordKey?: string } | undefined)?.recordKey
        const matching = tableItems.filter((item) =>
          String(item.recordKey).startsWith(prefix) && (!startKey || String(item.recordKey) > startKey)
        )
        const limit = typeof input.Limit === 'number' ? input.Limit : matching.length
        const page = matching.slice(0, limit)
        control.observeQuery?.(
          prefix,
          page.map((item) => String(item.recordKey)),
        )
        return {
          Items: page.map((item) => structuredClone(item)),
          ScannedCount: page.length,
          ...(matching.length > page.length && page.at(-1)
            ? {
                LastEvaluatedKey: {
                  workspaceId: page.at(-1)?.workspaceId,
                  recordKey: page.at(-1)?.recordKey,
                },
              }
            : {}),
        }
      }
      const key = input.Key as { workspaceId?: string; recordKey?: string } | undefined
      if (key) {
        if (command.constructor.name !== 'DeleteCommand') {
          control.beforeGet?.(
            items,
            String(key.workspaceId),
            String(key.recordKey),
          )
        }
        const mapKey = `${String(key.workspaceId)}\0${String(key.recordKey)}`
        if (command.constructor.name === 'DeleteCommand') {
          items.delete(mapKey)
          return {}
        }
        return { Item: structuredClone(items.get(mapKey)) }
      }
      const item = input.Item as Record<string, unknown> | undefined
      if (item) {
        items.set(`${String(item.workspaceId)}\0${String(item.recordKey)}`, structuredClone(item))
        return {}
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
}

function applyMemoryTransactionItem(
  items: Map<string, Record<string, unknown>>,
  transactItem: Record<string, Record<string, unknown>>,
  index: number,
  transactionLength: number,
) {
  const operation = transactItem.Put ?? transactItem.Update ??
    transactItem.Delete ?? transactItem.ConditionCheck
  if (!operation) throw new Error('Unsupported memory transaction operation.')
  const item = operation.Item as Record<string, unknown> | undefined
  const key = (operation.Key ?? item) as { workspaceId?: string; recordKey?: string }
  const mapKey = `${String(key.workspaceId)}\0${String(key.recordKey)}`
  const current = items.get(mapKey)
  if (!matchesMemoryCondition(current, operation)) {
    const error = new Error('transaction condition failed')
    error.name = 'TransactionCanceledException'
    Object.assign(error, {
      CancellationReasons: Array.from({ length: transactionLength }, (_, reasonIndex) => ({
        Code: reasonIndex === index ? 'ConditionalCheckFailed' : 'None',
      })),
    })
    throw error
  }
  if (transactItem.Put && item) {
    items.set(mapKey, structuredClone(item))
  } else if (transactItem.Update) {
    const updated = current ?? {
      workspaceId: key.workspaceId,
      recordKey: key.recordKey,
    }
    applyMemoryUpdate(updated, operation)
    items.set(mapKey, updated)
  } else if (transactItem.Delete) {
    items.delete(mapKey)
  }
}

function matchesMemoryCondition(
  current: Record<string, unknown> | undefined,
  operation: Record<string, unknown>,
) {
  const condition = operation.ConditionExpression
  if (typeof condition !== 'string') return true
  const names = operation.ExpressionAttributeNames as Record<string, string> | undefined
  const values = operation.ExpressionAttributeValues as Record<string, unknown> | undefined
  return condition.split(' OR ').some((alternative) =>
    alternative.split(' AND ').every((clause) =>
      matchesMemoryConditionClause(current, clause, names, values)
    )
  )
}

/** Evaluates one atomic DynamoDB condition used by the in-memory persistence fake. */
function matchesMemoryConditionClause(
  current: Record<string, unknown> | undefined,
  clause: string,
  names: Record<string, string> | undefined,
  values: Record<string, unknown> | undefined,
) {
  const attributeNotExists = clause.match(/^attribute_not_exists\((#?[A-Za-z0-9]+)\)$/u)
  if (attributeNotExists?.[1]) {
    const attributeName = names?.[attributeNotExists[1]] ?? attributeNotExists[1]
    return current?.[attributeName] === undefined
  }
  const lessThanOrEqual = clause.match(/^(#[A-Za-z0-9]+) <= (:[A-Za-z0-9]+)$/u)
  if (lessThanOrEqual?.[1] && lessThanOrEqual[2]) {
    const currentValue = current?.[names?.[lessThanOrEqual[1]] ?? '']
    const expectedValue = values?.[lessThanOrEqual[2]]
    return typeof currentValue === 'number' &&
      typeof expectedValue === 'number' &&
      currentValue <= expectedValue
  }
  const match = clause.match(/^(#[A-Za-z0-9]+) = (:[A-Za-z0-9]+)$/u)
  if (!match) throw new Error(`Unsupported memory condition: ${clause}`)
  return current?.[names?.[match[1] ?? ''] ?? ''] === values?.[match[2] ?? '']
}

/** Returns whether an in-memory DynamoDB attribute is a record value. */
function isMemoryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function applyMemoryUpdate(
  current: Record<string, unknown>,
  operation: Record<string, unknown>,
) {
  const expression = String(operation.UpdateExpression)
  const names = operation.ExpressionAttributeNames as Record<string, string>
  const values = operation.ExpressionAttributeValues as Record<string, unknown>
  const [setExpression, removeExpression] = expression.split(' REMOVE ')
  for (const assignment of splitMemoryAssignments(setExpression?.replace(/^SET /u, '') ?? '')) {
    const [nameToken, valueToken] = assignment.split(' = ')
    if (!nameToken || !valueToken) continue
    const targetName = names[nameToken] ?? nameToken
    const ifNotExists = valueToken.match(/^if_not_exists\((#[A-Za-z0-9]+), (:[A-Za-z0-9]+)\)$/u)
    if (ifNotExists?.[1] && ifNotExists[2]) {
      const existingName = names[ifNotExists[1]] ?? ifNotExists[1]
      if (current[existingName] === undefined) {
        current[targetName] = structuredClone(values[ifNotExists[2]])
      }
      continue
    }
    current[targetName] = structuredClone(values[valueToken])
  }
  for (const nameToken of removeExpression?.split(', ') ?? []) {
    delete current[names[nameToken] ?? nameToken]
  }
}

function splitMemoryAssignments(expression: string) {
  const assignments: string[] = []
  let start = 0
  let depth = 0
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index]
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      assignments.push(expression.slice(start, index).trim())
      start = index + 1
    }
  }
  const tail = expression.slice(start).trim()
  if (tail) assignments.push(tail)
  return assignments
}
