import { expect, spyOn, test } from 'bun:test'
import {
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { COLLABORATION_CONTEXT_SCHEMA_VERSION } from '@mukuroji/contracts'
import {
  DynamoDbWorkspaceSearchClient,
  WorkspaceSearchError,
  createCommentWorkspaceSearchDocument,
  createCuratedContextItemWorkspaceSearchDocument,
  createDocumentWorkspaceSearchSourceDocument,
  createDocumentWorkspaceSearchDocument,
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
  expect(client.search({
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
  expect(corruptClient.search({
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
  })
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
  expect(client.updateSavedView({
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
  expect(client.updateSavedView({
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

  expect(client.createSavedView(request)).rejects.toThrow('transaction failed')
  expect((await client.listSavedViews({ workspaceId: 'workspace-1', access })).views).toEqual([])

  const created = await client.createSavedView(request)
  expect(await client.listSavedViews({ workspaceId: 'workspace-1', access })).toMatchObject({
    views: [expect.objectContaining({ id: created.id, favorite: true, isDefault: true })],
  })
  control.failNextTransaction = true
  expect(client.deleteSavedView({
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
  expect(client.createSavedView({
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
  expect(client.updateSavedView(preferenceUpdate)).rejects.toMatchObject({
    code: 'SavedViewRevisionConflict',
    status: 409,
  })
  expect(await client.updateSavedView(preferenceUpdate))
    .toMatchObject({ revision: 1, canEdit: false, favorite: true, isDefault: false })
  expect(client.updateSavedView({
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

test('waits for a newly created local search table to become active', async () => {
  const commands: string[] = []
  let describeCount = 0
  const dynamoDbClient = {
    async send(command: CreateTableCommand | DescribeTableCommand) {
      commands.push(command.constructor.name)
      if (command instanceof CreateTableCommand) return {}
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
  ])
})

function createMemoryDocumentClient(
  initialItems: Array<Record<string, unknown>>,
  control: {
    failNextTransaction?: boolean
    beforeNextTransaction?: (items: Map<string, Record<string, unknown>>) => void
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
        beforeNextTransaction?.(items)
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
        const prefix = String(expressionValues?.[':prefix'] ?? '')
        const startKey = (input.ExclusiveStartKey as { recordKey?: string } | undefined)?.recordKey
        const matching = tableItems.filter((item) =>
          String(item.recordKey).startsWith(prefix) && (!startKey || String(item.recordKey) > startKey)
        )
        const limit = typeof input.Limit === 'number' ? input.Limit : matching.length
        const page = matching.slice(0, limit)
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
  if (condition.startsWith('attribute_not_exists')) return current === undefined
  const names = operation.ExpressionAttributeNames as Record<string, string> | undefined
  const values = operation.ExpressionAttributeValues as Record<string, unknown> | undefined
  const match = condition.match(/^(#[A-Za-z0-9]+) = (:[A-Za-z0-9]+)$/u)
  if (!match) throw new Error(`Unsupported memory condition: ${condition}`)
  return current?.[names?.[match[1] ?? ''] ?? ''] === values?.[match[2] ?? '']
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
