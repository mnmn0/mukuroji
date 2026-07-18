import { expect, spyOn, test } from 'bun:test'
import type {
  DocumentComment,
  DocumentDetail,
  DocumentPublicShare,
  DocumentRelationTarget,
} from '@mukuroji/contracts'
import { Hono } from 'hono'
import {
  registerDocumentApiRoutes,
  type DocumentApiDependencies,
} from './document-api'
import {
  DocumentError,
  type DocumentClient,
} from './documents'

test('requires authentication and never exposes an unexpected internal error', async () => {
  const errorLog = spyOn(console, 'error').mockImplementation(() => undefined)
  const app = createTestApp(createDocumentClient({
    async list() {
      throw new Error('database hostname and credential leaked')
    },
  }))

  try {
    const unauthorized = await app.request('/api/documents')
    expect(unauthorized.status).toBe(401)

    const failed = await app.request('/api/documents', {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({
      code: 'DocumentServiceUnavailable',
      message: 'Document service is unavailable.',
    })
    expect(errorLog).toHaveBeenCalled()
  } finally {
    errorLog.mockRestore()
  }
})

test('rejects malformed create, nested operation, presence, and share inputs as 400', async () => {
  let calls = 0
  const app = createTestApp(createDocumentClient({
    async create() {
      calls += 1
      return pageDocument
    },
    async applyOperations() {
      calls += 1
      throw new Error('must not be called')
    },
    async heartbeatPresence() {
      calls += 1
    },
    async createPublicShare() {
      calls += 1
      throw new Error('must not be called')
    },
  }))
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }
  const requests = [
    new Request('http://localhost/api/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'unknown',
        scope: { type: 'workspace' },
        title: 'Invalid',
      }),
    }),
    new Request('http://localhost/api/documents/document-1/operations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        baseRevision: 1,
        clientId: 'editor-1',
        operations: [{ type: 'insert-block', operationId: 'operation-1', index: 0 }],
      }),
    }),
    new Request('http://localhost/api/documents/document-1/presence', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        clientId: 'editor-1',
        selection: { type: 'text', anchorOffset: 0, focusOffset: 0 },
      }),
    }),
    new Request('http://localhost/api/documents/document-1/shares', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'public',
        expiresAt: '2026-07-19T00:00:00.000Z',
        allowExport: 'yes',
      }),
    }),
  ]

  for (const request of requests) {
    const response = await app.request(request)
    expect(response.status).toBe(400)
  }
  expect(calls).toBe(0)
})

test('validates relation targets before applying document operations', async () => {
  let applyCalls = 0
  const app = createTestApp(
    createDocumentClient({
      async applyOperations() {
        applyCalls += 1
        throw new Error('Target validation must run first.')
      },
    }),
    {
      async validateRelationTargets(_principal, targets) {
        expect(targets).toEqual([{
          kind: 'work-item',
          workItemId: 'team/team-a/issue/issue-1',
        }])
        throw new DocumentError(
          403,
          'DocumentRelationTargetDenied',
          'The related Work Item is not visible.',
        )
      },
    },
  )

  const response = await app.request(
    '/api/documents/document-1/operations',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        baseRevision: 1,
        clientId: 'editor-1',
        operations: [{
          operationId: 'operation-1',
          type: 'upsert-relation',
          relation: {
            id: 'relation-1',
            source: { kind: 'document' },
            target: {
              kind: 'work-item',
              workItemId: 'team/team-a/issue/issue-1',
            },
            createdByUserId: 'owner@example.com',
            createdAt: '2026-07-18T00:00:00.000Z',
          },
        }],
      }),
    },
  )

  expect(response.status).toBe(403)
  expect(applyCalls).toBe(0)
})

test('revalidates every restored snapshot target before committing the restore', async () => {
  const expectedTargets: DocumentRelationTarget[] = [
    {
      kind: 'project',
      projectId: 'project-1',
    },
    {
      kind: 'work-item',
      workItemId: 'team/team-a/issue/issue-1',
    },
  ]
  let committed = false
  let validatedTargets: readonly DocumentRelationTarget[] = []
  const app = createTestApp(
    createDocumentClient({
      async restoreVersion(input) {
        await input.validateRelationTargets(expectedTargets)
        committed = true
        return pageDocument
      },
    }),
    {
      async validateRelationTargets(_principal, targets) {
        validatedTargets = targets
      },
    },
  )

  const response = await app.request(
    '/api/documents/document-1/versions/document-1%3A1/restore',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 2 }),
    },
  )

  expect(response.status).toBe(200)
  expect(validatedTargets).toEqual(expectedTargets)
  expect(committed).toBeTrue()
})

test('preserves comment anchors and mention ranges at the HTTP boundary', async () => {
  let receivedBody = ''
  let receivedMentionOffset = -1
  let receivedAuditEventActor = ''
  const comment: DocumentComment = {
    id: 'comment-1',
    documentId: 'document-1',
    anchor: { type: 'text', blockId: 'block-1', start: 0, end: 5 },
    body: 'Hello @Mina',
    mentions: [{ userId: 'mina@example.com', offset: 6, length: 5 }],
    authorUserId: 'owner@example.com',
    resolved: false,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const app = createTestApp(createDocumentClient({
    async createComment(input) {
      receivedBody = input.body
      receivedMentionOffset = input.mentions?.[0]?.offset ?? -1
      receivedAuditEventActor = input.auditContext?.actor.id ?? ''
      return comment
    },
  }))

  const response = await app.request('/api/documents/document-1/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      anchor: { type: 'text', blockId: 'block-1', start: 0, end: 5 },
      body: 'Hello @Mina',
      mentions: [{ userId: 'mina@example.com', offset: 6, length: 5 }],
    }),
  })

  expect(response.status).toBe(201)
  expect(receivedBody).toBe('Hello @Mina')
  expect(receivedMentionOffset).toBe(6)
  expect(receivedAuditEventActor).toBe('owner@example.com')
  expect(await response.json()).toEqual({ comment })
})

test('replays a committed comment before revalidating mutable mentioned members', async () => {
  let memberLookups = 0
  const comment: DocumentComment = {
    id: 'comment-request-1',
    documentId: 'document-1',
    anchor: {
      type: 'block',
      blockId: 'deleted-block',
    },
    body: 'Ask @Mina',
    mentions: [{
      userId: 'mina@example.com',
      offset: 4,
      length: 5,
    }],
    authorUserId: 'owner@example.com',
    resolved: false,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const app = createTestApp(
    createDocumentClient({
      async getCommentCreateReplay() {
        return comment
      },
      async createComment() {
        throw new Error('Committed replay must not create a second comment.')
      },
    }),
    {
      getActiveMember: async () => {
        memberLookups += 1
        return undefined
      },
    },
  )

  const response = await app.request(
    '/api/documents/document-1/comments',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'comment-request-1',
      },
      body: JSON.stringify({
        anchor: {
          type: 'block',
          blockId: 'deleted-block',
        },
        body: 'Ask @Mina',
        mentions: [{
          userId: 'mina@example.com',
          offset: 4,
          length: 5,
        }],
      }),
    },
  )

  expect(response.status).toBe(201)
  expect(memberLookups).toBe(0)
  expect(await response.json()).toEqual({ comment })
})

test('parses comment pagination strictly and returns the canonical cursor page', async () => {
  let calls = 0
  const receivedCursors: Array<string | undefined> = []
  const receivedLimits: Array<number | undefined> = []
  const receivedRootCommentIds: Array<string | undefined> = []
  const comment: DocumentComment = {
    id: 'comment-page-1',
    documentId: 'document-1',
    anchor: { type: 'document' },
    body: 'Paginated comment',
    mentions: [],
    authorUserId: 'owner@example.com',
    resolved: false,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const app = createTestApp(createDocumentClient({
    async listComments(input) {
      calls += 1
      receivedCursors.push(input.cursor)
      receivedLimits.push(input.limit)
      receivedRootCommentIds.push(input.rootCommentId)
      return input.cursor === undefined
        ? { comments: [comment], nextCursor: 'next-page' }
        : {
            comments: [{ ...comment, id: 'comment-page-2' }],
          }
    },
  }))

  const firstResponse = await app.request(
    '/api/documents/document-1/comments?limit=1&rootCommentId=root-1',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(firstResponse.status).toBe(200)
  expect(await firstResponse.json()).toEqual({
    comments: [comment],
    nextCursor: 'next-page',
  })
  const secondResponse = await app.request(
    '/api/documents/document-1/comments?limit=1&cursor=next-page&rootCommentId=root-1',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(secondResponse.status).toBe(200)
  expect(await secondResponse.json()).toEqual({
    comments: [{ ...comment, id: 'comment-page-2' }],
  })
  expect(receivedLimits).toEqual([1, 1])
  expect(receivedCursors).toEqual([undefined, 'next-page'])
  expect(receivedRootCommentIds).toEqual(['root-1', 'root-1'])

  const malformedQueries = [
    'limit=1e2',
    'limit=101',
    'limit=2&limit=3',
    'cursor=bad%21',
    'cursor=',
    'cursor=first&cursor=second',
    'rootCommentId=',
    'rootCommentId=root-1&rootCommentId=root-2',
  ]
  for (const query of malformedQueries) {
    const malformed = await app.request(
      `/api/documents/document-1/comments?${query}`,
      { headers: { Authorization: 'Bearer test-token' } },
    )
    expect(malformed.status).toBe(400)
  }
  expect(calls).toBe(2)
})

test('projects every public document kind without internal metadata', async () => {
  const documentWithPrivateMetadata = {
    ...pageDocument,
    scope: { type: 'project', projectId: 'private-project-id' },
    parentId: 'private-parent-id',
    position: 'private-position',
    permission: {
      mode: 'private',
      memberGrants: [
        { memberKey: 'private-manager@example.com', role: 'manager' },
      ],
    },
    relations: [
      {
        id: 'private-relation-id',
        source: { kind: 'document' },
        target: { kind: 'project', projectId: 'private-project-id' },
        createdByUserId: 'private-relation-author@example.com',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
    ],
    favorite: true,
    lastOpenedAt: '2026-07-18T01:00:00.000Z',
    createdByUserId: 'private-creator@example.com',
    updatedByUserId: 'private-editor@example.com',
  } as DocumentDetail
  const cases = [
    {
      document: {
        ...documentWithPrivateMetadata,
        kind: 'folder',
        childCount: 12,
      } as DocumentDetail,
      expected: {
        kind: 'folder',
        title: 'Roadmap',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
    },
    {
      document: {
        ...documentWithPrivateMetadata,
        kind: 'page',
        blocks: [
          {
            id: 'block-1',
            type: 'paragraph',
            text: 'Plan safely.',
            createdByUserId: 'private-block-author@example.com',
          },
          {
            id: 'block-2',
            type: 'checklist',
            items: [
              {
                id: 'item-1',
                text: 'Private owner assignment is hidden.',
                checked: false,
                assigneeMemberKey: 'private-assignee@example.com',
              },
            ],
          },
        ],
      } as DocumentDetail,
      expected: {
        kind: 'page',
        title: 'Roadmap',
        updatedAt: '2026-07-18T00:00:00.000Z',
        blocks: [
          { id: 'block-1', type: 'paragraph', text: 'Plan safely.' },
          {
            id: 'block-2',
            type: 'checklist',
            items: [
              {
                id: 'item-1',
                text: 'Private owner assignment is hidden.',
                checked: false,
              },
            ],
          },
        ],
      },
    },
    {
      document: {
        ...documentWithPrivateMetadata,
        kind: 'template',
        blocks: [
          {
            id: 'template-block-1',
            type: 'heading',
            level: 2,
            text: 'Template',
            permission: { mode: 'private' },
          },
        ],
      } as DocumentDetail,
      expected: {
        kind: 'template',
        title: 'Roadmap',
        updatedAt: '2026-07-18T00:00:00.000Z',
        blocks: [{ id: 'template-block-1', type: 'heading', level: 2, text: 'Template' }],
      },
    },
    {
      document: {
        ...documentWithPrivateMetadata,
        kind: 'whiteboard',
        whiteboard: {
          objects: [
            {
              id: 'work-item-card-1',
              type: 'work-item',
              workItemId: 'private-work-item-id',
              bounds: { x: 10, y: 20, width: 160, height: 96 },
              zIndex: 1,
              style: { fill: '#ffffff' },
            },
            {
              id: 'note-1',
              type: 'note',
              text: 'Public note',
              bounds: { x: 220, y: 20, width: 160, height: 96 },
              zIndex: 2,
              memberKey: 'private-note-author@example.com',
            },
          ],
          connectors: [
            {
              id: 'connector-1',
              from: { objectId: 'work-item-card-1' },
              to: { objectId: 'note-1' },
              createdByUserId: 'private-connector-author@example.com',
            },
          ],
          frames: [
            {
              id: 'frame-1',
              title: 'Public frame',
              bounds: { x: 0, y: 0, width: 400, height: 160 },
              objectIds: ['work-item-card-1', 'note-1'],
              parentId: 'private-frame-parent-id',
            },
          ],
        },
      } as DocumentDetail,
      expected: {
        kind: 'whiteboard',
        title: 'Roadmap',
        updatedAt: '2026-07-18T00:00:00.000Z',
        whiteboard: {
          objects: [
            {
              id: 'work-item-card-1',
              type: 'work-item',
              bounds: { x: 10, y: 20, width: 160, height: 96 },
              zIndex: 1,
              style: { fill: '#ffffff' },
            },
            {
              id: 'note-1',
              type: 'note',
              text: 'Public note',
              bounds: { x: 220, y: 20, width: 160, height: 96 },
              zIndex: 2,
            },
          ],
          connectors: [
            {
              id: 'connector-1',
              from: { objectId: 'work-item-card-1' },
              to: { objectId: 'note-1' },
            },
          ],
          frames: [
            {
              id: 'frame-1',
              title: 'Public frame',
              bounds: { x: 0, y: 0, width: 400, height: 160 },
              objectIds: ['work-item-card-1', 'note-1'],
            },
          ],
        },
      },
    },
  ]

  for (const testCase of cases) {
    const app = createTestApp(createDocumentClient({
      async resolvePublicShare() {
        return {
          document: testCase.document,
          share: publicShare,
        }
      },
    }))
    const response = await app.request(
      '/api/public/documents/a-valid-public-token-with-more-than-32-characters',
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      document: testCase.expected,
      allowExport: true,
    })
  }
})

test('exports a public document only when the current token permits it', async () => {
  let allowExport = true
  let document = {
    ...pageDocument,
    parentId: 'private-parent-id',
    permission: {
      mode: 'private',
      memberGrants: [
        { memberKey: 'private-manager@example.com', role: 'manager' },
      ],
    },
    relations: [
      {
        id: 'private-relation-id',
        source: { kind: 'document' },
        target: { kind: 'goal', goalId: 'private-goal-id' },
        createdByUserId: 'private-relation-author@example.com',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
    ],
    blocks: [
      { id: 'block-1', type: 'paragraph', text: 'Plan safely.' },
      {
        id: 'block-2',
        type: 'checklist',
        items: [
          {
            id: 'item-1',
            text: 'Publish the roadmap.',
            checked: false,
            assigneeMemberKey: 'private-assignee@example.com',
          },
        ],
      },
    ],
  } as DocumentDetail
  const app = createTestApp(createDocumentClient({
    async resolvePublicShare() {
      return {
        document,
        share: {
          ...publicShare,
          allowExport,
        },
      }
    },
  }))

  const jsonExported = await app.request(
    '/api/public/documents/a-valid-public-token-with-more-than-32-characters/export?format=json',
  )
  expect(jsonExported.status).toBe(200)
  const jsonArtifact = await jsonExported.json()
  expect(JSON.parse(jsonArtifact.content)).toEqual({
    kind: 'page',
    title: 'Roadmap',
    updatedAt: '2026-07-18T00:00:00.000Z',
    blocks: [
      { id: 'block-1', type: 'paragraph', text: 'Plan safely.' },
      {
        id: 'block-2',
        type: 'checklist',
        items: [{ id: 'item-1', text: 'Publish the roadmap.', checked: false }],
      },
    ],
  })
  expect(jsonArtifact.content).not.toContain('private-')

  const exported = await app.request(
    '/api/public/documents/a-valid-public-token-with-more-than-32-characters/export?format=markdown',
  )
  expect(exported.status).toBe(200)
  const markdownArtifact = await exported.json()
  expect(markdownArtifact).toMatchObject({
    delivery: 'inline',
    format: 'markdown',
    fileName: 'Roadmap.md',
  })
  expect(markdownArtifact.content).toContain('Publish the roadmap.')
  expect(markdownArtifact.content).not.toContain('private-assignee@example.com')

  document = {
    ...pageDocument,
    kind: 'whiteboard',
    relations: [
      {
        id: 'private-relation-id',
        source: { kind: 'document' },
        target: { kind: 'work-item', workItemId: 'private-related-work-item-id' },
        createdByUserId: 'private-relation-author@example.com',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
    ],
    whiteboard: {
      objects: [
        {
          id: 'work-item-card-1',
          type: 'work-item',
          workItemId: 'private-work-item-id',
          bounds: { x: 10, y: 20, width: 160, height: 96 },
          zIndex: 1,
        },
      ],
      connectors: [],
      frames: [],
    },
  } as DocumentDetail
  const svgExported = await app.request(
    '/api/public/documents/a-valid-public-token-with-more-than-32-characters/export?format=svg',
  )
  expect(svgExported.status).toBe(200)
  const svgArtifact = await svgExported.json()
  expect(svgArtifact.content).toContain('Work item')
  expect(svgArtifact.content).not.toContain('private-work-item-id')
  expect(svgArtifact.content).not.toContain('private-related-work-item-id')

  allowExport = false
  const denied = await app.request(
    '/api/public/documents/a-valid-public-token-with-more-than-32-characters/export?format=markdown',
  )
  expect(denied.status).toBe(403)
  expect(await denied.json()).toMatchObject({ code: 'DocumentPublicExportDenied' })
})

test('revokes member shares with the canonical discriminated request body', async () => {
  let remainingMemberKeys: string[] = []
  const app = createTestApp(createDocumentClient({
    async get() {
      return {
        ...pageDocument,
        permission: {
          mode: 'private',
          memberGrants: [
            { memberKey: 'owner@example.com', role: 'manager' },
            { memberKey: 'guest@example.com', role: 'viewer' },
          ],
        },
      }
    },
    async update(input) {
      remainingMemberKeys = input.permission?.memberGrants.map(({ memberKey }) => memberKey) ?? []
      return pageDocument
    },
  }))

  const response = await app.request('/api/documents/document-1/shares', {
    method: 'DELETE',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'member', memberKey: 'guest@example.com' }),
  })

  expect(response.status).toBe(200)
  expect(remainingMemberKeys).toEqual(['owner@example.com'])
})

test('forwards the mutation idempotency key when creating a public share', async () => {
  let receivedIdempotencyKey: string | undefined
  const app = createTestApp(createDocumentClient({
    async createPublicShare(input) {
      receivedIdempotencyKey = input.idempotencyKey
      return {
        share: publicShare,
        token: 'stable-public-share-token',
      }
    },
  }))

  const response = await app.request(
    '/api/documents/document-1/shares',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'public-share-request-1',
      },
      body: JSON.stringify({
        type: 'public',
        expiresAt: '2099-07-19T00:00:00.000Z',
        allowExport: true,
      }),
    },
  )

  expect(response.status).toBe(201)
  expect(receivedIdempotencyKey).toBe('public-share-request-1')
  expect(await response.json()).toMatchObject({
    type: 'public',
    url: '/share/documents/stable-public-share-token',
  })
})

function createTestApp(
  client: DocumentClient,
  overrides: Partial<DocumentApiDependencies> = {},
) {
  const app = new Hono()
  const dependencies: DocumentApiDependencies = {
    authenticate: async () => ({
      workspaceId: 'workspace-1',
      memberKey: 'owner@example.com',
      displayName: 'Owner',
      workspaceRole: 'owner',
      isSystemAdmin: false,
      projectRoles: { 'project-1': 'manager' },
    }),
    getActiveMember: async (_workspaceId, memberKey) => ({
      memberKey,
      email: memberKey,
    }),
    validateRelationTargets: async () => undefined,
    ...overrides,
    getClient: () => client,
  }
  registerDocumentApiRoutes(app, dependencies)
  return app
}

function createDocumentClient(overrides: Partial<DocumentClient>): DocumentClient {
  return new Proxy(overrides as DocumentClient, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (value !== undefined) return value
      return async () => {
        throw new Error(`Unexpected DocumentClient call: ${String(property)}`)
      }
    },
  })
}

const pageDocument: DocumentDetail = {
  schemaVersion: 1,
  id: 'document-1',
  kind: 'page',
  scope: { type: 'workspace' },
  title: 'Roadmap',
  position: 'a0',
  revision: 1,
  permission: {
    mode: 'private',
    memberGrants: [{ memberKey: 'owner@example.com', role: 'manager' }],
  },
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
  createdByUserId: 'owner@example.com',
  updatedByUserId: 'owner@example.com',
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  blocks: [{ id: 'block-1', type: 'paragraph', text: 'Plan safely.' }],
}

const publicShare: DocumentPublicShare = {
  type: 'public',
  id: 'share-1',
  documentId: 'document-1',
  role: 'viewer',
  expiresAt: '2026-07-19T00:00:00.000Z',
  allowExport: true,
  createdByUserId: 'owner@example.com',
  createdAt: '2026-07-18T00:00:00.000Z',
}
