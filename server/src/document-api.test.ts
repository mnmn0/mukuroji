import { expect, spyOn, test } from 'bun:test'
import type {
  DocumentComment,
  DocumentDetail,
  DocumentPublicShare,
  DocumentRelationTarget,
} from '@mukuroji/contracts'
import { Hono } from 'hono'
import {
  DOCUMENT_API_MAX_BODY_BYTES,
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

test('passes the Hono request context to authentication', async () => {
  let receivedRequest:
    | {
      accessToken: string
      method: string
      path: string
      requestHeader: string | undefined
    }
    | undefined
  const app = createTestApp(
    createDocumentClient({
      async list() {
        return { nodes: [] }
      },
    }),
    {
      async authenticate(accessToken, context) {
        receivedRequest = {
          accessToken,
          method: context.req.method,
          path: context.req.path,
          requestHeader: context.req.header('X-Authentication-Probe'),
        }
        return {
          workspaceId: 'workspace-1',
          memberKey: 'owner@example.com',
          displayName: 'Owner',
          workspaceRole: 'owner',
          isSystemAdmin: false,
          projectRoles: { 'project-1': 'manager' },
        }
      },
    },
  )

  const response = await app.request('/api/documents?archived=true', {
    headers: {
      Authorization: 'Bearer context-token',
      'X-Authentication-Probe': 'context-visible',
    },
  })

  expect(response.status).toBe(200)
  expect(receivedRequest).toEqual({
    accessToken: 'context-token',
    method: 'GET',
    path: '/api/documents',
    requestHeader: 'context-visible',
  })
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

test('rejects malformed whiteboard create input before relation target validation', async () => {
  let createCalls = 0
  let targetValidationCalls = 0
  const app = createTestApp(
    createDocumentClient({
      async create() {
        createCalls += 1
        return pageDocument
      },
    }),
    {
      async validateRelationTargets() {
        targetValidationCalls += 1
      },
    },
  )
  const malformedWhiteboards = [
    undefined,
    {},
    {
      objects: [null],
      connectors: [],
      frames: [],
    },
  ]

  for (const whiteboard of malformedWhiteboards) {
    const response = await app.request('/api/documents', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'whiteboard',
        scope: { type: 'workspace' },
        title: 'Invalid whiteboard',
        ...(whiteboard === undefined ? {} : { whiteboard }),
      }),
    })

    expect(response.status).toBe(400)
  }
  expect(targetValidationCalls).toBe(0)
  expect(createCalls).toBe(0)
})

test('bounds permission member validation concurrency', async () => {
  let activeLookups = 0
  let maximumActiveLookups = 0
  const memberGrants = Array.from({ length: 24 }, (_, index) => ({
    memberKey: `member-${index}@example.com`,
    role: 'viewer' as const,
  }))
  const app = createTestApp(
    createDocumentClient({
      async create() {
        return pageDocument
      },
    }),
    {
      async getActiveMember(_workspaceId, memberKey) {
        activeLookups += 1
        maximumActiveLookups = Math.max(maximumActiveLookups, activeLookups)
        await Promise.resolve()
        activeLookups -= 1
        return {
          memberKey,
          email: memberKey,
        }
      },
    },
  )

  const response = await app.request('/api/documents', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'page',
      scope: { type: 'workspace' },
      title: 'Bounded member validation',
      blocks: [],
      permission: {
        mode: 'inherit',
        memberGrants,
      },
    }),
  })

  expect(response.status).toBe(201)
  expect(maximumActiveLookups).toBeLessThanOrEqual(8)
})

test('binds private Document creation to the ACL generation read before member validation', async () => {
  let receivedExpectedRevision:
    | number
    | undefined
  let memberValidated = false
  const app = createTestApp(
    createDocumentClient({
      async getAuthorizationRevision() {
        expect(memberValidated).toBeFalse()
        return 7
      },
      async create(input) {
        receivedExpectedRevision =
          input.expectedAuthorizationRevision
        return pageDocument
      },
    }),
    {
      async getActiveMember(
        _workspaceId,
        memberKey,
      ) {
        memberValidated = true
        return {
          memberKey,
          email: memberKey,
        }
      },
    },
  )

  const response = await app.request(
    '/api/documents',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'page',
        scope: { type: 'workspace' },
        title: 'Private generation',
        blocks: [],
        permission: {
          mode: 'private',
          memberGrants: [{
            memberKey: 'owner@example.com',
            role: 'manager',
          }],
        },
      }),
    },
  )

  expect(response.status).toBe(201)
  expect(receivedExpectedRevision).toBe(7)
})

test('rejects oversized grants and relation targets without downstream reads', async () => {
  let memberLookups = 0
  let targetValidationCalls = 0
  let createCalls = 0
  const app = createTestApp(
    createDocumentClient({
      async create() {
        createCalls += 1
        return pageDocument
      },
    }),
    {
      async getActiveMember() {
        memberLookups += 1
        return undefined
      },
      async validateRelationTargets() {
        targetValidationCalls += 1
      },
    },
  )
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }
  const bodyResponse = await app.request('/api/documents', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'page',
      scope: { type: 'workspace' },
      title: 'x'.repeat(DOCUMENT_API_MAX_BODY_BYTES),
      blocks: [],
    }),
  })
  expect(bodyResponse.status).toBe(413)

  const grantResponse = await app.request('/api/documents', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'page',
      scope: { type: 'workspace' },
      title: 'Too many grants',
      blocks: [],
      permission: {
        mode: 'inherit',
        memberGrants: Array.from({ length: 101 }, (_, index) => ({
          memberKey: `member-${index}@example.com`,
          role: 'viewer',
        })),
      },
    }),
  })
  expect(grantResponse.status).toBe(413)

  const targetResponse = await app.request('/api/documents', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'whiteboard',
      scope: { type: 'workspace' },
      title: 'Too many targets',
      whiteboard: {
        objects: Array.from({ length: 46 }, (_, index) => ({
          id: `object-${index}`,
          type: 'work-item',
          workItemId: `team/team-a/issue/issue-${index}`,
          bounds: { x: index * 10, y: 0, width: 100, height: 100 },
          zIndex: index,
        })),
        connectors: [],
        frames: [],
      },
    }),
  })
  expect(targetResponse.status).toBe(413)
  expect(memberLookups).toBe(0)
  expect(targetValidationCalls).toBe(0)
  expect(createCalls).toBe(0)
})

test('rejects an operation that exceeds the final target limit before target reads', async () => {
  let targetValidationCalls = 0
  let applyCalls = 0
  const current = {
    ...pageDocument,
    kind: 'whiteboard',
    whiteboard: {
      objects: Array.from({ length: 45 }, (_, index) => ({
        id: `object-${index}`,
        type: 'work-item' as const,
        workItemId: `team/team-a/issue/issue-${index}`,
        bounds: { x: index * 10, y: 0, width: 100, height: 100 },
        zIndex: index,
      })),
      connectors: [],
      frames: [],
    },
  } as DocumentDetail
  const app = createTestApp(
    createDocumentClient({
      async get() {
        return current
      },
      async applyOperations() {
        applyCalls += 1
        throw new Error('must not be called')
      },
    }),
    {
      async validateRelationTargets() {
        targetValidationCalls += 1
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
          type: 'insert-object',
          object: {
            id: 'object-45',
            type: 'work-item',
            workItemId: 'team/team-a/issue/issue-45',
            bounds: { x: 450, y: 0, width: 100, height: 100 },
            zIndex: 45,
          },
        }],
      }),
    },
  )

  expect(response.status).toBe(413)
  expect(targetValidationCalls).toBe(0)
  expect(applyCalls).toBe(0)
})

test('checks mutation capabilities before member or relation target reads', async () => {
  let memberLookups = 0
  let targetValidationCalls = 0
  let mutationCalls = 0
  const readOnlyDocument: DocumentDetail = {
    ...pageDocument,
    capabilities: {
      ...pageDocument.capabilities,
      canEdit: false,
      canManagePermissions: false,
    },
  }
  const app = createTestApp(
    createDocumentClient({
      async get() {
        return readOnlyDocument
      },
      async update() {
        mutationCalls += 1
        return pageDocument
      },
      async applyOperations() {
        mutationCalls += 1
        throw new Error('must not be called')
      },
    }),
    {
      async getActiveMember() {
        memberLookups += 1
        return undefined
      },
      async validateRelationTargets() {
        targetValidationCalls += 1
      },
    },
  )
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }

  const permissionResponse = await app.request(
    '/api/documents/document-1',
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        expectedRevision: 1,
        permission: {
          mode: 'inherit',
          memberGrants: [{
            memberKey: 'another-member@example.com',
            role: 'viewer',
          }],
        },
      }),
    },
  )
  expect(permissionResponse.status).toBe(403)

  const operationResponse = await app.request(
    '/api/documents/document-1/operations',
    {
      method: 'POST',
      headers,
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
  expect(operationResponse.status).toBe(403)
  expect(memberLookups).toBe(0)
  expect(targetValidationCalls).toBe(0)
  expect(mutationCalls).toBe(0)
})

test('rejects guest document creation before grant and target reads', async () => {
  let downstreamReads = 0
  let createCalls = 0
  const app = createTestApp(
    createDocumentClient({
      async create() {
        createCalls += 1
        return pageDocument
      },
    }),
    {
      authenticate: async () => ({
        workspaceId: 'workspace-1',
        memberKey: 'guest@example.com',
        displayName: 'Guest',
        workspaceRole: 'guest',
        isSystemAdmin: false,
        projectRoles: {},
      }),
      async getActiveMember() {
        downstreamReads += 1
        return undefined
      },
      async validateRelationTargets() {
        downstreamReads += 1
      },
    },
  )

  const response = await app.request('/api/documents', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'whiteboard',
      scope: { type: 'workspace' },
      title: 'Guest payload',
      permission: {
        mode: 'inherit',
        memberGrants: [{
          memberKey: 'member@example.com',
          role: 'viewer',
        }],
      },
      whiteboard: {
        objects: [{
          id: 'object-1',
          type: 'work-item',
          workItemId: 'team/team-a/issue/issue-1',
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          zIndex: 0,
        }],
        connectors: [],
        frames: [],
      },
    }),
  })

  expect(response.status).toBe(403)
  expect(downstreamReads).toBe(0)
  expect(createCalls).toBe(0)
})

test('forwards every authenticated authorization generation guard', async () => {
  let receivedGenerations: Array<string | number> = []
  const app = createTestApp(
    createDocumentClient({
      async create(input) {
        receivedGenerations =
          input.access.authorizationGuards?.map(
            ({ expectedGeneration }) => expectedGeneration,
          ) ?? []
        return pageDocument
      },
    }),
    {
      authenticate: async () => ({
        workspaceId: 'workspace-1',
        memberKey: 'owner@example.com',
        displayName: 'Owner',
        workspaceRole: 'owner',
        isSystemAdmin: false,
        projectRoles: {},
        authorizationGuards: [
          {
            tableName: 'workspace-access',
            key: {
              directoryId: 'workspace-1',
              memberKey: 'owner@example.com',
            },
            generationAttribute: 'version',
            expectedGeneration: 7,
            requiredAttributes: {
              entryType: 'workspace-member',
              status: 'active',
            },
          },
          {
            tableName: 'planning',
            key: {
              workspaceId: 'workspace-1',
              recordKey: 'META',
            },
            generationAttribute: 'revision',
            expectedGeneration: 11,
          },
        ],
      }),
    },
  )

  const response = await app.request('/api/documents', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'page',
      scope: { type: 'workspace' },
      title: 'Guarded create',
      blocks: [],
    }),
  })

  expect(response.status).toBe(201)
  expect(receivedGenerations).toEqual([7, 11])
})

test('batches backlink targets behind one bounded source-read budget', async () => {
  const calls: Array<{
    targetKind: string
    targetId: string
    limit?: number
    cursor?: string
  }> = []
  const app = createTestApp(createDocumentClient({
    async listBacklinks(input) {
      calls.push({
        targetKind: input.targetKind,
        targetId: input.targetId,
        limit: input.limit,
        cursor: input.cursor,
      })
      return {
        backlinks: [{
          documentId: `source-${input.targetId}`,
          documentTitle: `Source ${input.targetId}`,
          relation: {
            id: `relation-${input.targetId}`,
            source: { kind: 'document' },
            target: input.targetKind === 'goal'
              ? {
                  kind: 'goal',
                  goalId: input.targetId,
                }
              : input.targetKind === 'project'
                ? {
                    kind: 'project',
                    projectId: input.targetId,
                  }
                : {
                    kind: 'work-item',
                    workItemId: input.targetId,
                  },
            createdByUserId: 'owner@example.com',
            createdAt: '2026-07-19T00:00:00.000Z',
          },
        }],
        ...(input.targetId === 'goal-1'
          ? { nextCursor: 'next-goal-page' }
          : {}),
      }
    },
  }))

  const response = await app.request(
    '/api/document-backlinks/batch',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targets: [
          {
            targetType: 'goal',
            targetId: 'goal-1',
          },
          {
            targetType: 'project',
            targetId: 'project-1',
          },
          {
            targetType: 'work-item',
            targetId: 'team/team-a/issue/issue-1',
          },
        ],
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(calls).toEqual([
    {
      targetKind: 'goal',
      targetId: 'goal-1',
      limit: 15,
      cursor: undefined,
    },
    {
      targetKind: 'project',
      targetId: 'project-1',
      limit: 15,
      cursor: undefined,
    },
    {
      targetKind: 'work-item',
      targetId: 'team/team-a/issue/issue-1',
      limit: 15,
      cursor: undefined,
    },
  ])
  expect(await response.json()).toMatchObject({
    backlinks: [
      { documentId: 'source-goal-1' },
      { documentId: 'source-project-1' },
      {
        documentId:
          'source-team/team-a/issue/issue-1',
      },
    ],
    pending: [
      {
        targetType: 'goal',
        targetId: 'goal-1',
        cursor: 'next-goal-page',
      },
    ],
  })
  expect(
    calls.reduce(
      (total, call) =>
        total + (call.limit ?? 0),
      0,
    ),
  ).toBeLessThanOrEqual(45)
})

test('rejects an oversized backlink batch before source reads', async () => {
  let calls = 0
  const app = createTestApp(createDocumentClient({
    async listBacklinks() {
      calls += 1
      return { backlinks: [] }
    },
  }))

  const response = await app.request(
    '/api/document-backlinks/batch',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targets: Array.from(
          { length: 46 },
          (_, index) => ({
            targetType: 'goal',
            targetId: `goal-${index}`,
          }),
        ),
      }),
    },
  )

  expect(response.status).toBe(413)
  expect(calls).toBe(0)
})

test('validates relation targets before applying document operations', async () => {
  let applyCalls = 0
  const app = createTestApp(
    createDocumentClient({
      async get() {
        return pageDocument
      },
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

test('replays committed operations before canonical and Goal source validation', async () => {
  let canonicalReads = 0
  let applyCalls = 0
  let relationTargetReads = 0
  const replayResults = {
    'insert-response-lost': {
      revision: 2,
      updatedAt:
        '2026-07-18T00:01:00.000Z',
    },
    'delete-response-lost': {
      revision: 3,
      updatedAt:
        '2026-07-18T00:02:00.000Z',
    },
    'goal-response-lost': {
      revision: 4,
      updatedAt:
        '2026-07-18T00:03:00.000Z',
    },
  } as const
  const app = createTestApp(
    createDocumentClient({
      async prepareOperations(input) {
        const operation =
          input.input.operations[0]
        const replay =
          operation === undefined
            ? undefined
            : replayResults[
                operation.operationId as
                  keyof typeof replayResults
              ]
        if (replay === undefined) {
          return {
            pendingInput: input.input,
          }
        }
        return {
          replay: {
            documentId: input.documentId,
            revision: replay.revision,
            appliedOperationIds:
              input.input.operations.map(
                ({ operationId }) =>
                  operationId,
              ),
            updatedAt: replay.updatedAt,
          },
        }
      },
      async get() {
        canonicalReads += 1
        throw new Error(
          'A receipt replay must not revalidate current canonical state.',
        )
      },
      async applyOperations() {
        applyCalls += 1
        throw new Error(
          'A receipt replay must not reapply the operation.',
        )
      },
    }),
    {
      async validateRelationTargets() {
        relationTargetReads += 1
        throw new Error(
          'A receipt replay must not revalidate changed Goal state.',
        )
      },
    },
  )
  const requests = [
    {
      baseRevision: 1,
      clientId: 'editor-1',
      operations: [{
        operationId: 'insert-response-lost',
        type: 'insert-block',
        index: 1,
        block: {
          id: 'inserted-block',
          type: 'paragraph',
          text: 'Already inserted.',
        },
      }],
    },
    {
      baseRevision: 2,
      clientId: 'editor-1',
      operations: [{
        operationId: 'delete-response-lost',
        type: 'delete-block',
        blockId: 'inserted-block',
      }],
    },
    {
      baseRevision: 3,
      clientId: 'editor-1',
      operations: [{
        operationId:
          'goal-response-lost',
        type: 'upsert-relation',
        relation: {
          id: 'goal-relation',
          source: { kind: 'document' },
          target: {
            kind: 'goal',
            goalId: 'goal-now-archived',
          },
          createdByUserId:
            'owner@example.com',
          createdAt:
            '2026-07-18T00:03:00.000Z',
        },
      }],
    },
  ]

  const responses = await Promise.all(
    requests.map((body) =>
      app.request(
        '/api/documents/document-1/operations',
        {
          method: 'POST',
          headers: {
            Authorization:
              'Bearer test-token',
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify(body),
        },
      )
    ),
  )

  expect(
    responses.map(({ status }) => status),
  ).toEqual([200, 200, 200])
  expect(await responses[0]?.json()).toEqual({
    documentId: 'document-1',
    revision: 2,
    appliedOperationIds: [
      'insert-response-lost',
    ],
    updatedAt:
      '2026-07-18T00:01:00.000Z',
  })
  expect(await responses[1]?.json()).toEqual({
    documentId: 'document-1',
    revision: 3,
    appliedOperationIds: [
      'delete-response-lost',
    ],
    updatedAt:
      '2026-07-18T00:02:00.000Z',
  })
  expect(await responses[2]?.json()).toEqual({
    documentId: 'document-1',
    revision: 4,
    appliedOperationIds: [
      'goal-response-lost',
    ],
    updatedAt:
      '2026-07-18T00:03:00.000Z',
  })
  expect(canonicalReads).toBe(0)
  expect(applyCalls).toBe(0)
  expect(relationTargetReads).toBe(0)
})

test('validates only pending operations in a mixed receipt batch', async () => {
  const current: DocumentDetail = {
    ...pageDocument,
    revision: 2,
    blocks: [
      ...pageDocument.blocks,
      {
        id: 'already-inserted',
        type: 'paragraph',
        text: 'Committed before response loss.',
      },
    ],
  }
  let appliedOperationIds: string[] = []
  let validatedPendingOperationIds:
    readonly string[] | undefined
  const app = createTestApp(
    createDocumentClient({
      async prepareOperations(input) {
        expect(
          input.input.operations.map(
            ({ operationId }) =>
              operationId,
          ),
        ).toEqual([
          'already-committed-insert',
          'pending-delete',
        ])
        return {
          pendingInput: {
            ...input.input,
            operations: [
              input.input.operations[1]!,
            ],
          },
        }
      },
      async get() {
        return current
      },
      async applyOperations(input) {
        appliedOperationIds =
          input.input.operations.map(
            ({ operationId }) =>
              operationId,
          )
        validatedPendingOperationIds =
          input.validatedPendingOperationIds
        return {
          documentId: input.documentId,
          revision: 3,
          appliedOperationIds,
          updatedAt:
            '2026-07-18T00:03:00.000Z',
        }
      },
    }),
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
        operations: [
          {
            operationId:
              'already-committed-insert',
            type: 'insert-block',
            index: 1,
            block: {
              id: 'already-inserted',
              type: 'paragraph',
              text:
                'Committed before response loss.',
            },
          },
          {
            operationId:
              'pending-delete',
            type: 'delete-block',
            blockId: 'block-1',
          },
        ],
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    documentId: 'document-1',
    revision: 3,
    appliedOperationIds: [
      'already-committed-insert',
      'pending-delete',
    ],
    updatedAt:
      '2026-07-18T00:03:00.000Z',
  })
  expect(appliedOperationIds).toEqual([
    'already-committed-insert',
    'pending-delete',
  ])
  expect(
    validatedPendingOperationIds,
  ).toEqual([
    'pending-delete',
  ])
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

test('revalidates archived document targets before restoring the document', async () => {
  let restoreCalls = 0
  let validatedTargets: readonly DocumentRelationTarget[] = []
  const archivedDocument: DocumentDetail = {
    ...pageDocument,
    archivedAt: '2026-07-18T01:00:00.000Z',
    relations: [{
      id: 'goal-relation-1',
      source: { kind: 'document' },
      target: { kind: 'goal', goalId: 'goal-1' },
      createdByUserId: 'owner@example.com',
      createdAt: '2026-07-18T00:00:00.000Z',
    }],
    capabilities: {
      ...pageDocument.capabilities,
      canEdit: false,
      canArchive: false,
      canRestore: true,
    },
  }
  const app = createTestApp(
    createDocumentClient({
      async get() {
        return archivedDocument
      },
      async restoreArchived() {
        restoreCalls += 1
        return pageDocument
      },
    }),
    {
      async validateRelationTargets(_principal, targets) {
        validatedTargets = targets
        throw new DocumentError(
          403,
          'DocumentRelationTargetDenied',
          'The related Goal is not visible.',
        )
      },
    },
  )

  const response = await app.request(
    '/api/documents/document-1/restore',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 1 }),
    },
  )

  expect(response.status).toBe(403)
  expect(validatedTargets).toEqual([{
    kind: 'goal',
    goalId: 'goal-1',
  }])
  expect(restoreCalls).toBe(0)
})

test('validates and forwards template instance permissions', async () => {
  let instantiateCalls = 0
  let receivedMemberKeys: string[] = []
  const app = createTestApp(createDocumentClient({
    async instantiateTemplate(input) {
      instantiateCalls += 1
      receivedMemberKeys =
        input.permission?.memberGrants.map(({ memberKey }) => memberKey) ?? []
      return pageDocument
    },
  }))
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }
  const created = await app.request(
    '/api/documents/template-1/instantiate',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scope: { type: 'workspace' },
        permission: {
          mode: 'private',
          memberGrants: [{
            memberKey: 'manager@example.com',
            role: 'manager',
          }],
        },
      }),
    },
  )

  expect(created.status).toBe(201)
  expect(receivedMemberKeys).toEqual(['manager@example.com'])

  const createdThroughGenericRoute = await app.request(
    '/api/documents',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'page',
        templateId: 'template-1',
        scope: { type: 'workspace' },
        title: 'Private template instance',
        blocks: [],
        permission: {
          mode: 'private',
          memberGrants: [{
            memberKey: 'manager@example.com',
            role: 'manager',
          }],
        },
      }),
    },
  )

  expect(createdThroughGenericRoute.status).toBe(201)
  expect(receivedMemberKeys).toEqual(['manager@example.com'])

  const malformed = await app.request(
    '/api/documents/template-1/instantiate',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scope: { type: 'workspace' },
        permission: {
          mode: 'private',
          memberGrants: 'manager@example.com',
        },
      }),
    },
  )
  expect(malformed.status).toBe(400)
  expect(instantiateCalls).toBe(2)
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
  let receivedExpectedAuthorizationRevision:
    | number
    | undefined
  const app = createTestApp(createDocumentClient({
    async getAuthorizationRevision() {
      return 19
    },
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
      receivedExpectedAuthorizationRevision =
        input.expectedAuthorizationRevision
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
  expect(
    receivedExpectedAuthorizationRevision,
  ).toBe(19)
})

test('binds active member share validation to the private ACL generation', async () => {
  let receivedExpectedAuthorizationRevision:
    | number
    | undefined
  const app = createTestApp(
    createDocumentClient({
      async getAuthorizationRevision() {
        return 27
      },
      async get() {
        return pageDocument
      },
      async update(input) {
        receivedExpectedAuthorizationRevision =
          input.expectedAuthorizationRevision
        return pageDocument
      },
    }),
  )

  const response = await app.request(
    '/api/documents/document-1/shares',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'member',
        memberKey: 'guest@example.com',
        role: 'viewer',
      }),
    },
  )

  expect(response.status).toBe(201)
  expect(
    receivedExpectedAuthorizationRevision,
  ).toBe(27)
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
  const client = {
    getAuthorizationRevision: async () => 0,
    prepareOperations: async (input) => ({
      pendingInput: input.input,
    }),
    ...overrides,
  } as DocumentClient
  return new Proxy(client, {
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
