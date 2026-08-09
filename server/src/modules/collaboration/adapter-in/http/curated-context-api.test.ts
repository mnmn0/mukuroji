import { afterEach, expect, test } from 'bun:test'
import {
  COLLABORATION_CONTEXT_SCHEMA_VERSION,
  type CuratedContextItem,
  type CuratedContextSource,
} from '@mukuroji/contracts'
import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
import type {
  CollaborationClient,
} from '../../collaboration'
import { DocumentError } from '../../../documents'

const {
  app,
  configureFakeProjectClients,
  createCollaborationStub,
  createDocumentFake,
  createFakeAuditEvent,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/**
 * Creates a compact curated-context fixture with retained source provenance.
 *
 * @param id - Stable context-item identifier.
 * @param source - Captured source provenance, when the item has evidence.
 * @returns Curated-context fixture.
 */
function createCuratedContextFixture(
  id: string,
  source?: CuratedContextSource,
): CuratedContextItem {
  return {
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    id,
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    kind: 'context',
    state: 'active',
    title: `Context ${id}`,
    body: `Body ${id}`,
    ...(source ? { source } : {}),
    mentionMemberKeys: [],
    createdBy: { id: 'demo@example.com', displayName: 'Demo' },
    createdAt: '2026-08-09T01:00:00.000Z',
    updatedBy: { id: 'demo@example.com', displayName: 'Demo' },
    updatedAt: '2026-08-09T01:00:00.000Z',
    revision: 1,
  }
}

test('returns cursor-paginated curated context with server-derived capabilities', async () => {
  configureFakeProjectClients(true)
  let capturedInput: Parameters<CollaborationClient['getCuratedContext']>[0] | undefined
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCuratedContext(input) {
        capturedInput = input
        return {
          schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
          items: [],
          nextCursor: 'context-cursor',
          capabilities: input.capabilities,
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items?limit=12',
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect(response.status).toBe(200)
  expect(capturedInput).toMatchObject({
    limit: 12,
    capabilities: {
      canCreate: true,
      canEdit: true,
      canReplace: true,
      canAcceptResolution: true,
    },
  })
  expect(await response.json()).toMatchObject({
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    nextCursor: 'context-cursor',
  })
})

test('keeps comment provenance available when only its lifecycle revision changes', async () => {
  configureFakeProjectClients(true)
  const originalBody = 'The accepted answer remains unchanged.'
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCuratedContext(input) {
        return {
          schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
          items: [createCuratedContextFixture('comment-context', {
            kind: 'comment',
            sourceId: 'comment-1',
            containerId: 'root-1',
            originalBody,
            quote: { text: 'accepted answer' },
            occurredAt: '2026-08-09T01:00:00.000Z',
            capturedRevision: 1,
            currentRevision: 1,
            availability: 'available',
          })],
          capabilities: input.capabilities,
        }
      },
      async getCommentSnapshot() {
        return {
          id: 'comment-1',
          rootCommentId: 'root-1',
          parentCommentId: 'root-1',
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: originalBody,
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-08-09T01:00:00.000Z',
          updatedAt: '2026-08-09T02:00:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    items: [{
      id: 'comment-context',
      source: {
        originalBody,
        availability: 'available',
        currentRevision: 2,
      },
    }],
  })
})

test('returns cursor-paginated curated context revisions with permission-safe provenance', async () => {
  configureFakeProjectClients(true)
  let capturedInput: Parameters<CollaborationClient['getCuratedContextRevisions']>[0] | undefined
  setTestAppDependencies({
    documents: createDocumentFake({
      async get() {
        throw new DocumentError(403, 'DocumentViewDenied', 'Document access was lost.')
      },
    }),
    collaboration: createCollaborationStub({
      async getCuratedContextRevisions(input) {
        capturedInput = input
        return {
          schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
          items: [createCuratedContextFixture('context-1', {
            kind: 'document',
            sourceId: 'private-document',
            originalBody: 'Retained private evidence',
            quote: { text: 'private evidence' },
            permalink: '/documents/private-document',
            occurredAt: '2026-08-09T01:00:00.000Z',
            capturedRevision: 2,
            currentRevision: 2,
            availability: 'available',
          })],
          nextCursor: 'revision-cursor-2',
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items/context-1/revisions?limit=4&cursor=revision-cursor-1',
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect(response.status).toBe(200)
  expect(capturedInput).toEqual({
    entityKey: 'user#demo@example.com#work-item#team/core-team/issue/onboarding-friction',
    itemId: 'context-1',
    limit: 4,
    cursor: 'revision-cursor-1',
  })
  const body = await response.json()
  expect(body).toMatchObject({
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    nextCursor: 'revision-cursor-2',
    items: [{
      id: 'context-1',
      source: {
        kind: 'document',
        sourceId: 'private-document',
        availability: 'permission-lost',
      },
    }],
  })
  expect(body.items[0].source).not.toHaveProperty('originalBody')
  expect(body.items[0].source).not.toHaveProperty('quote')
  expect(body.items[0].source).not.toHaveProperty('permalink')
})

test('returns accepted-resolution history as an independent cursor page', async () => {
  configureFakeProjectClients(true)
  let capturedInput: Parameters<CollaborationClient['getAcceptedResolutionHistory']>[0] | undefined
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getAcceptedResolutionHistory(input) {
        capturedInput = input
        return {
          schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
          items: [{
            id: 'resolution-1',
            sourceCommentId: 'reply-1',
            sourceRootCommentId: 'root-1',
            capturedCommentRevision: 2,
            capturedCommentBody: 'Ship option A.',
            summary: 'Option A was selected after the final review.',
            acceptedBy: { id: 'demo@example.com', displayName: 'Demo' },
            acceptedAt: '2026-08-09T02:00:00.000Z',
            state: 'accepted',
          }],
          nextCursor: 'resolution-cursor-2',
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/root-1/accepted-resolutions?limit=3&cursor=resolution-cursor-1',
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect(response.status).toBe(200)
  expect(capturedInput).toEqual({
    entityKey: 'user#demo@example.com#work-item#team/core-team/issue/onboarding-friction',
    rootCommentId: 'root-1',
    limit: 3,
    cursor: 'resolution-cursor-1',
  })
  expect(await response.json()).toMatchObject({
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    nextCursor: 'resolution-cursor-2',
    items: [{ id: 'resolution-1', state: 'accepted' }],
  })
})

test('does not advertise accepted-resolution moderation to an ordinary writer', async () => {
  configureFakeProjectClients(true, {
    role: 'member',
    workspaceRole: 'member',
  })
  let capturedInput: Parameters<CollaborationClient['getCuratedContext']>[0] | undefined
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCuratedContext(input) {
        capturedInput = input
        return {
          schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
          items: [],
          capabilities: input.capabilities,
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect(response.status).toBe(200)
  expect(capturedInput?.capabilities).toMatchObject({
    canCreate: true,
    canEdit: true,
    canReplace: true,
    canAcceptResolution: false,
  })
})

test('does not advertise accepted-resolution mutations to a guest assignee', async () => {
  configureFakeProjectClients(true, {
    detailAssigneeUserId: 'demo@example.com',
    role: 'viewer',
    workspaceRole: 'guest',
  })
  let capturedInput: Parameters<CollaborationClient['getCuratedContext']>[0] | undefined
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCuratedContext(input) {
        capturedInput = input
        return {
          schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
          items: [],
          capabilities: input.capabilities,
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect(response.status).toBe(200)
  expect(capturedInput?.capabilities).toMatchObject({
    canCreate: false,
    canEdit: false,
    canReplace: false,
    canAcceptResolution: false,
  })
})

test('overlays current source loss while preserving captured provenance', async () => {
  configureFakeProjectClients(true)
  const capturedAt = '2026-08-09T00:00:00.000Z'
  const items = [
    createCuratedContextFixture('document-context', {
      kind: 'document',
      sourceId: 'document-1',
      originalBody: 'Retained document evidence',
      occurredAt: capturedAt,
      capturedRevision: 3,
      currentRevision: 3,
      availability: 'available',
    }),
    createCuratedContextFixture('external-context', {
      kind: 'external-chat',
      sourceId: 'message-1',
      containerId: 'channel-1',
      originalBody: 'Retained external evidence',
      occurredAt: capturedAt,
      capturedRevision: 'message-v1',
      availability: 'available',
    }),
    createCuratedContextFixture('archived-document-context', {
      kind: 'document',
      sourceId: 'document-archived',
      originalBody: 'Retained archived document evidence',
      quote: { text: 'archived document evidence' },
      permalink: '/documents/document-archived',
      occurredAt: capturedAt,
      capturedRevision: 4,
      currentRevision: 4,
      availability: 'available',
    }),
    createCuratedContextFixture('deleted-external-context', {
      kind: 'external-chat',
      sourceId: 'message-deleted',
      containerId: 'channel-1',
      originalBody: 'Retained deleted external evidence',
      quote: { text: 'deleted external evidence' },
      permalink: 'https://chat.example.test/messages/message-deleted',
      occurredAt: capturedAt,
      capturedRevision: 'message-v1',
      availability: 'deleted',
      availabilityReason: 'The external message was deleted.',
    }),
    createCuratedContextFixture('comment-context', {
      kind: 'comment',
      sourceId: 'comment-1',
      containerId: 'root-1',
      originalBody: 'Retained comment evidence',
      occurredAt: capturedAt,
      capturedRevision: 1,
      availability: 'available',
    }),
    createCuratedContextFixture('activity-context', {
      kind: 'activity',
      sourceId: 'event-1',
      containerId: 'team/core-team/issue/onboarding-friction',
      originalBody: 'Retained activity evidence',
      occurredAt: capturedAt,
      availability: 'available',
    }),
    createCuratedContextFixture('expired-activity-context', {
      kind: 'activity',
      sourceId: 'event-expired',
      containerId: 'team/core-team/issue/onboarding-friction',
      originalBody: 'Retained activity evidence after source expiry',
      occurredAt: capturedAt,
      availability: 'available',
    }),
  ]
  setTestAppDependencies({
    documents: createDocumentFake({
      async get(input) {
        expect(input.includeArchived).toBeTrue()
        if (input.documentId === 'document-archived') {
          throw new DocumentError(404, 'DocumentArchived', 'Document was archived.')
        }
        throw new DocumentError(403, 'DocumentViewDenied', 'Document access was lost.')
      },
    }),
    auditEvents: {
      async getEvent(_workspaceId, eventId) {
        if (eventId !== 'event-expired') return undefined
        return {
          ...createFakeAuditEvent(),
          eventId,
          entity: {
            type: 'work-item',
            id: 'team/core-team/issue/onboarding-friction',
          },
          expiresAt: 1,
        }
      },
      async query() {
        throw new Error('Unexpected audit query.')
      },
    },
    collaboration: createCollaborationStub({
      async getCuratedContext(input) {
        return {
          schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
          items,
          capabilities: input.capabilities,
        }
      },
      async getCommentSnapshot() {
        return {
          id: 'comment-1',
          rootCommentId: 'root-1',
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: capturedAt,
          updatedAt: '2026-08-09T02:00:00.000Z',
          deletedAt: '2026-08-09T02:00:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toMatchObject({
    items: [
      {
        id: 'document-context',
        source: {
          availability: 'permission-lost',
          availabilityReason: expect.any(String),
        },
      },
      {
        id: 'external-context',
        source: {
          availability: 'permission-lost',
          availabilityReason: expect.any(String),
        },
      },
      {
        id: 'archived-document-context',
        source: {
          availability: 'deleted',
          availabilityReason: expect.any(String),
        },
      },
      {
        id: 'deleted-external-context',
        source: {
          availability: 'deleted',
          availabilityReason: expect.any(String),
        },
      },
      {
        id: 'comment-context',
        source: {
          originalBody: 'Retained comment evidence',
          availability: 'deleted',
          currentRevision: 2,
          availabilityReason: expect.any(String),
        },
      },
      {
        id: 'activity-context',
        source: {
          availability: 'retention-expired',
          availabilityReason: expect.any(String),
        },
      },
      {
        id: 'expired-activity-context',
        source: {
          availability: 'retention-expired',
          availabilityReason: expect.any(String),
        },
      },
    ],
  })
  for (const source of [
    body.items[0].source,
    body.items[1].source,
    body.items[2].source,
    body.items[3].source,
    body.items[5].source,
    body.items[6].source,
  ]) {
    expect(source).not.toHaveProperty('originalBody')
    expect(source).not.toHaveProperty('quote')
    expect(source).not.toHaveProperty('permalink')
  }
})

test('redacts an inherited unavailable source from a replacement response', async () => {
  configureFakeProjectClients(true)
  const inherited = createCuratedContextFixture('replacement-context', {
    kind: 'document',
    sourceId: 'document-1',
    originalBody: 'Retained private document evidence',
    quote: { text: 'private document evidence' },
    permalink: '/documents/document-1',
    occurredAt: '2026-08-09T00:00:00.000Z',
    capturedRevision: 3,
    currentRevision: 3,
    availability: 'available',
  })
  setTestAppDependencies({
    documents: createDocumentFake({
      async get() {
        throw new DocumentError(403, 'DocumentViewDenied', 'Document access was lost.')
      },
    }),
    collaboration: createCollaborationStub({
      async createCuratedContextItem() {
        return inherited
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    {
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify({
        kind: 'decision',
        title: 'Replacement decision',
        body: 'Use the retained evidence without re-reading it.',
        supersedesItemId: 'previous-context',
      }),
    },
  )

  expect(response.status).toBe(201)
  const body = await response.json()
  expect(body.item.source).toMatchObject({
    kind: 'document',
    sourceId: 'document-1',
    availability: 'permission-lost',
  })
  expect(body.item.source).not.toHaveProperty('originalBody')
  expect(body.item.source).not.toHaveProperty('quote')
  expect(body.item.source).not.toHaveProperty('permalink')
})

test('rehydrates a comment source instead of trusting client provenance', async () => {
  configureFakeProjectClients(true)
  let capturedInput: Parameters<CollaborationClient['createCuratedContextItem']>[0] | undefined
  const item: CuratedContextItem = {
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    id: 'context-1',
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    kind: 'decision',
    state: 'active',
    title: 'Ship the release',
    body: 'Proceed after regression testing.',
    source: {
      kind: 'comment',
      sourceId: 'comment-1',
      containerId: 'comment-1',
      originalBody: 'Server-owned source body',
      actor: { id: 'demo@example.com', displayName: 'Demo' },
      occurredAt: '2026-08-09T01:00:00.000Z',
      capturedRevision: 2,
      currentRevision: 2,
      availability: 'available',
    },
    mentionMemberKeys: [],
    createdBy: { id: 'demo@example.com', displayName: 'Demo' },
    createdAt: '2026-08-09T02:00:00.000Z',
    updatedBy: { id: 'demo@example.com', displayName: 'Demo' },
    updatedAt: '2026-08-09T02:00:00.000Z',
    revision: 1,
  }
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCommentSnapshot() {
        return {
          id: 'comment-1',
          rootCommentId: 'root-1',
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: 'Server-owned source body',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-08-09T01:00:00.000Z',
          updatedAt: '2026-08-09T01:30:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
      async createCuratedContextItem(input) {
        capturedInput = input
        return item
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'decision',
        title: 'Ship the release',
        body: 'Proceed after regression testing.',
        source: {
          kind: 'comment',
          sourceId: 'comment-1',
          originalBody: 'Untrusted client body',
          quote: { text: 'source' },
          occurredAt: '2020-01-01T00:00:00.000Z',
          availability: 'deleted',
        },
      }),
    },
  )

  expect(response.status).toBe(201)
  expect(capturedInput?.source).toMatchObject({
    kind: 'comment',
    sourceId: 'comment-1',
    originalBody: 'Server-owned source body',
    capturedRevision: 2,
    availability: 'available',
    permalink: '/teams/core-team/issues?issueId=onboarding-friction&commentId=comment-1&rootCommentId=root-1',
    quote: { text: 'source', startOffset: 13, endOffset: 19 },
  })
  expect(await response.json()).toEqual({ item })
})

test('replays a committed create before rehydrating a source that later disappeared', async () => {
  configureFakeProjectClients(true)
  const source: CuratedContextSource = {
    kind: 'comment',
    sourceId: 'comment-1',
    containerId: 'root-1',
    originalBody: 'Server-owned source body',
    quote: { text: 'source' },
    actor: { id: 'demo@example.com', displayName: 'Demo' },
    occurredAt: '2026-08-09T01:00:00.000Z',
    capturedRevision: 1,
    currentRevision: 1,
    availability: 'available',
  }
  const committed = createCuratedContextFixture('context-replay', source)
  let replayChecks = 0
  let sourceReads = 0
  let createCalls = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCuratedContextMutationReplay(input) {
        replayChecks += 1
        expect(input.operation).toBe('create')
        return replayChecks === 1 ? undefined : committed
      },
      async getCommentSnapshot() {
        sourceReads += 1
        if (sourceReads === 1 || sourceReads === 2) {
          return {
            id: 'comment-1',
            rootCommentId: 'root-1',
            parentCommentId: 'root-1',
            authorMemberKey: 'demo@example.com',
            bodyMarkdown: 'Server-owned source body',
            version: 1,
            mentionMemberKeys: [],
            createdAt: '2026-08-09T01:00:00.000Z',
            updatedAt: '2026-08-09T01:00:00.000Z',
            acceptedResolutions: [],
            reactions: [],
          }
        }
        return undefined
      },
      async createCuratedContextItem() {
        createCalls += 1
        return committed
      },
    }),
  })
  const request = {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'durable-context-create',
    },
    body: JSON.stringify({
      kind: 'context',
      title: 'Durable source capture',
      body: 'Replay without recapturing unavailable evidence.',
      source: {
        kind: 'comment',
        sourceId: 'comment-1',
        quote: { text: 'source' },
        occurredAt: '2020-01-01T00:00:00.000Z',
        availability: 'available',
      },
    }),
  }

  const first = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    request,
  )
  const replay = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    request,
  )

  expect(first.status).toBe(201)
  expect(replay.status).toBe(201)
  expect(createCalls).toBe(1)
  expect(replayChecks).toBe(2)
  expect(sourceReads).toBe(3)
  expect(await replay.json()).toMatchObject({
    item: {
      id: 'context-replay',
      source: {
        sourceId: 'comment-1',
        originalBody: 'Server-owned source body',
        availability: 'deleted',
      },
    },
  })
})

test('replays a committed update before validating mutable mention dependencies', async () => {
  configureFakeProjectClients(true)
  const committed = createCuratedContextFixture('context-replay')
  committed.title = 'Committed update'
  committed.revision = 2
  let updateCalls = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCuratedContextMutationReplay(input) {
        expect(input).toMatchObject({
          operation: 'update',
          itemId: 'context-replay',
        })
        return committed
      },
      async updateCuratedContextItem() {
        updateCalls += 1
        throw new Error('Unexpected curated context update.')
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items/context-replay',
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'durable-context-update',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        title: 'Committed update',
        mentionMemberKeys: ['member-that-no-longer-exists@example.com'],
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(updateCalls).toBe(0)
  expect(await response.json()).toMatchObject({
    item: { id: 'context-replay', title: 'Committed update', revision: 2 },
  })
})

test('bounds a long document body before the context snapshot reaches persistence', async () => {
  configureFakeProjectClients(true)
  let capturedInput: Parameters<CollaborationClient['createCuratedContextItem']>[0] | undefined
  setTestAppDependencies({
    documents: createDocumentFake({
      async get() {
        return {
          schemaVersion: 1,
          id: 'document-1',
          kind: 'page',
          scope: { type: 'project', projectId: 'refero' },
          title: 'Long source',
          position: 'a0',
          revision: 7,
          permission: { mode: 'inherit', memberGrants: [] },
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
          createdByUserId: 'demo@example.com',
          updatedByUserId: 'sato@example.com',
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:30:00.000Z',
          blocks: [{
            id: 'block-1',
            type: 'paragraph',
            text: 'x'.repeat(25_000),
          }],
        }
      },
    }),
    collaboration: createCollaborationStub({
      async createCuratedContextItem(input) {
        capturedInput = input
        if (!input.source) throw new Error('Expected a resolved document source.')
        return createCuratedContextFixture('document-context', input.source)
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'context',
        title: 'Long document source',
        body: 'Retain a bounded source snapshot.',
        source: {
          kind: 'document',
          sourceId: 'document-1',
          occurredAt: '2020-01-01T00:00:00.000Z',
          availability: 'available',
        },
      }),
    },
  )

  expect(response.status).toBe(201)
  expect(capturedInput?.source?.originalBody).toHaveLength(20_000)
  expect(capturedInput?.source).toMatchObject({
    sourceId: 'document-1',
    actor: { id: 'sato@example.com' },
    occurredAt: '2026-08-09T00:30:00.000Z',
    capturedRevision: 7,
    currentRevision: 7,
    availability: 'available',
  })
})

test('does not reveal whether an unavailable document exists', async () => {
  configureFakeProjectClients(true)

  for (const status of [403, 404]) {
    let createCalled = false
    setTestAppDependencies({
      documents: createDocumentFake({
        async get() {
          throw new DocumentError(
            status,
            status === 403 ? 'DocumentViewDenied' : 'DocumentNotFound',
            'Document is unavailable.',
          )
        },
      }),
      collaboration: createCollaborationStub({
        async createCuratedContextItem() {
          createCalled = true
          throw new Error('Unexpected curated context create.')
        },
      }),
    })

    const response = await app.request(
      '/api/teams/core-team/issues/onboarding-friction/context-items',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'context',
          title: 'Private document source',
          body: 'Do not disclose source existence.',
          source: {
            kind: 'document',
            sourceId: 'private-document',
            occurredAt: '2026-08-09T01:00:00.000Z',
            availability: 'available',
          },
        }),
      },
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      code: 'CuratedContextSourceUnavailable',
      message: 'The selected document is not available to the current viewer.',
    })
    expect(createCalled).toBeFalse()
  }
})

test('fails closed when external chat provider composition is unavailable', async () => {
  configureFakeProjectClients(true)
  let createCalled = false
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async createCuratedContextItem() {
        createCalled = true
        throw new Error('Unexpected curated context create.')
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'context',
        title: 'External discussion',
        body: 'Promoted from chat.',
        source: {
          kind: 'external-chat',
          sourceId: 'message-1',
          containerId: 'channel-1',
          occurredAt: '2026-08-09T01:00:00.000Z',
          availability: 'available',
        },
      }),
    },
  )

  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'ExternalChatSourceUnavailable' })
  expect(createCalled).toBeFalse()
})

test('rejects an activity source whose retained audit row has already expired', async () => {
  configureFakeProjectClients(true)
  let createCalled = false
  const retainedExpiredEvent = {
    ...createFakeAuditEvent(),
    eventId: 'expired-event',
    entity: {
      type: 'work-item',
      id: 'team/core-team/issue/onboarding-friction',
    },
    expiresAt: 1,
  }
  setTestAppDependencies({
    auditEvents: {
      async getEvent() {
        return retainedExpiredEvent
      },
      async query() {
        throw new Error('Unexpected audit query.')
      },
    },
    collaboration: createCollaborationStub({
      async createCuratedContextItem() {
        createCalled = true
        throw new Error('Unexpected curated context create.')
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'context',
        title: 'Expired audit evidence',
        body: 'Do not promote an event after its audit retention window.',
        source: {
          kind: 'activity',
          sourceId: 'expired-event',
          occurredAt: '2026-08-09T01:00:00.000Z',
          availability: 'available',
        },
      }),
    },
  )

  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ code: 'CuratedContextSourceNotFound' })
  expect(createCalled).toBeFalse()
})

test('rejects a curated context title beyond the shared 200 character boundary', async () => {
  configureFakeProjectClients(true)
  setTestAppDependencies({ collaboration: createCollaborationStub() })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'risk',
        title: 'x'.repeat(201),
        body: 'A bounded risk description.',
      }),
    },
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'InvalidCuratedContextInput' })
})

test('requires atomic replacement instead of detaching source provenance in place', async () => {
  configureFakeProjectClients(true)
  let updateCalled = false
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async updateCuratedContextItem() {
        updateCalled = true
        throw new Error('Unexpected curated context update.')
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/context-items/context-1',
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: 1,
        source: null,
      }),
    },
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    code: 'InvalidCuratedContextInput',
    message: 'Use atomic replacement to change curated context source evidence.',
  })
  expect(updateCalled).toBeFalse()
})

test('returns accepted resolution history on the updated root comment', async () => {
  configureFakeProjectClients(true)
  let capturedInput: Parameters<CollaborationClient['setAcceptedResolution']>[0] | undefined
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async setAcceptedResolution(input) {
        capturedInput = input
        return {
          id: 'root-1',
          rootCommentId: 'root-1',
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: 'What should we ship?',
          version: 4,
          mentionMemberKeys: [],
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T02:00:00.000Z',
          acceptedResolutions: [{
            id: 'resolution-1',
            sourceCommentId: 'reply-1',
            sourceRootCommentId: 'root-1',
            capturedCommentRevision: 2,
            capturedCommentBody: 'Ship option A.',
            summary: 'Option A was selected after the final review.',
            acceptedBy: { id: 'demo@example.com', displayName: 'Demo' },
            acceptedAt: '2026-08-09T02:00:00.000Z',
            state: 'accepted',
          }],
          reactions: [],
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/root-1/accepted-resolution',
    {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedThreadVersion: 3,
        commentId: 'reply-1',
        summary: 'Option A was selected after the final review.',
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(capturedInput).toMatchObject({
    rootCommentId: 'root-1',
    commentId: 'reply-1',
    expectedThreadVersion: 3,
    canModerate: true,
  })
  expect(await response.json()).toMatchObject({
    comment: {
      id: 'root-1',
      acceptedResolutions: [{
        sourceCommentId: 'reply-1',
        state: 'accepted',
      }],
    },
  })
})

test('allows the Work Item assignee to accept a resolution with viewer project access', async () => {
  configureFakeProjectClients(true, {
    detailAssigneeUserId: 'demo@example.com',
    role: 'viewer',
    workspaceRole: 'member',
  })
  let capturedInput: Parameters<CollaborationClient['setAcceptedResolution']>[0] | undefined
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async setAcceptedResolution(input) {
        capturedInput = input
        return {
          id: 'root-1',
          rootCommentId: 'root-1',
          authorMemberKey: 'author@example.com',
          bodyMarkdown: 'What should we ship?',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T02:00:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/root-1/accepted-resolution',
    {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedThreadVersion: 1,
        commentId: 'reply-1',
        summary: 'Use the reviewed answer.',
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(capturedInput).toMatchObject({ canModerate: true })
})
