import { afterEach, describe, expect, test } from 'bun:test'
import { COLLABORATION_CONTEXT_SCHEMA_VERSION } from '@mukuroji/contracts'
import {
  addTeamIssueCommentReaction,
  createTeamIssueComment,
  createTeamIssueContextItem,
  deleteTeamIssueComment,
  getTeamIssueActivity,
  getTeamIssueAcceptedResolutions,
  getTeamIssueCollaboration,
  getTeamIssueContextItems,
  getTeamIssueContextRevisions,
  getProjectWatch,
  resolveTeamIssueComment,
  subscribeProjectWatch,
  subscribeTeamIssueWatch,
  setTeamIssueAcceptedResolution,
  unsubscribeProjectWatch,
  updateTeamIssuePresence,
  updateTeamIssueContextItem,
} from '../src/issues/api'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-1',
  idempotencyKey: 'idempotency-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('team issue collaboration API', () => {
  test('creates a threaded Markdown comment with stable mention member keys', async () => {
    const requests = installFetchRecorder({ comment: {}, activity: {} })

    await createTeamIssueComment(
      'core team',
      'issue/1',
      'access-token',
      {
        bodyMarkdown: '**Review** @Sato',
        mentionMemberKeys: ['member#sato@example.com'],
        parentCommentId: 'comment/parent',
      },
      mutationContext,
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/api/teams/core%20team/issues/issue%2F1/comments')
    expect(requests[0]?.init.method).toBe('POST')
    expect(requests[0]?.init.headers).toMatchObject({
      'Idempotency-Key': 'idempotency-1',
      'X-Correlation-Id': 'correlation-1',
    })
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      bodyMarkdown: '**Review** @Sato',
      mentionMemberKeys: ['member#sato@example.com'],
      parentCommentId: 'comment/parent',
    })
  })

  test('uses versioned and idempotent comment mutation endpoints', async () => {
    const requests = installFetchRecorder({ comment: {} })

    await deleteTeamIssueComment('core', 'issue-1', 'comment-1', 'token', 4, mutationContext)
    await resolveTeamIssueComment('core', 'issue-1', 'comment-1', 'token', 5, mutationContext)
    await addTeamIssueCommentReaction('core', 'issue-1', 'comment-1', '👍', 'token', mutationContext)
    await subscribeTeamIssueWatch('core', 'issue-1', 'token', mutationContext)
    await subscribeProjectWatch('project/1', 'token', mutationContext)
    await unsubscribeProjectWatch('project/1', 'token', mutationContext)
    await updateTeamIssuePresence('core', 'issue-1', 'token', 'tab-1', true)

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['DELETE', '/api/teams/core/issues/issue-1/comments/comment-1'],
      ['POST', '/api/teams/core/issues/issue-1/comments/comment-1/resolve'],
      ['PUT', '/api/teams/core/issues/issue-1/comments/comment-1/reactions/%F0%9F%91%8D'],
      ['PUT', '/api/teams/core/issues/issue-1/watch'],
      ['PUT', '/api/projects/project%2F1/watch'],
      ['DELETE', '/api/projects/project%2F1/watch'],
      ['PUT', '/api/teams/core/issues/issue-1/presence'],
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ expectedVersion: 4 })
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ expectedVersion: 5 })
    expect(JSON.parse(String(requests[6]?.init.body))).toEqual({ clientId: 'tab-1', typing: true })
  })

  test('gets the assigned project watcher state', async () => {
    const requests = installFetchRecorder({ watch: { subscribed: false, watcherCount: 2 } })

    const watch = await getProjectWatch('project/1', 'token')

    expect(watch).toMatchObject({ subscribed: false, watcherCount: 2 })
    expect(requests[0]?.url).toBe('/api/projects/project%2F1/watch')
  })

  test('forwards opaque cursors to separate collaboration and activity resources', async () => {
    const requests = installFetchRecorder({
      comments: [],
      watch: {
        subscribed: false,
        explicit: false,
        automatic: false,
        reasons: [],
        watcherCount: 0,
      },
      presence: [],
      capabilities: { canComment: true, canReact: true, canWatch: true },
      events: [],
    })

    await getTeamIssueCollaboration('core', 'issue-1', 'token', { limit: 20, cursor: 'next/a+b' })
    await getTeamIssueCollaboration('core', 'issue-1', 'token', {
      limit: 100,
      cursor: 'reply/next',
      rootCommentId: 'root-1',
    })
    await getTeamIssueActivity('core', 'issue-1', 'token', { limit: 10, cursor: 'event/cursor' })

    expect(requests.map((request) => request.url)).toEqual([
      '/api/teams/core/issues/issue-1/collaboration?limit=20&cursor=next%2Fa%2Bb',
      '/api/teams/core/issues/issue-1/collaboration?limit=100&cursor=reply%2Fnext&rootCommentId=root-1',
      '/api/teams/core/issues/issue-1/activity?limit=10&cursor=event%2Fcursor',
    ])
  })

  test('rejects malformed activity pages at the API boundary', async () => {
    installFetchRecorder({
      events: [
        {
          actorUserId: null,
          eventId: 'event-1',
          eventType: 'work-item.updated',
          occurredAt: '2026-08-09T00:00:00.000Z',
        },
      ],
    })

    await expect(
      getTeamIssueActivity('core', 'issue-1', 'token'),
    ).rejects.toMatchObject({
      code: 'InvalidIssueActivityResponse',
      status: 502,
    })
  })

  test('rejects malformed collaboration pages at the API boundary', async () => {
    installFetchRecorder({ comments: null })

    await expect(
      getTeamIssueCollaboration('core', 'issue-1', 'token'),
    ).rejects.toMatchObject({
      code: 'InvalidIssueCollaborationResponse',
      status: 502,
    })
  })

  test('uses an independent context cursor and revision-fenced curated mutations', async () => {
    const requests = installFetchRecorder({
      schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
      capabilities: {
        canAcceptResolution: true,
        canCreate: true,
        canEdit: true,
        canReplace: true,
      },
      items: [],
      nextCursor: 'context/next',
    })

    const page = await getTeamIssueContextItems('core', 'issue-1', 'token', {
      cursor: 'context/a+b',
      limit: 20,
    })
    await createTeamIssueContextItem(
      'core',
      'issue-1',
      'token',
      { body: 'Rationale', kind: 'decision', title: 'Adopt option A' },
      mutationContext,
    )
    await updateTeamIssueContextItem(
      'core',
      'issue-1',
      'context-1',
      'token',
      { body: 'Updated rationale', expectedRevision: 3 },
      mutationContext,
    )
    await setTeamIssueAcceptedResolution(
      'core',
      'issue-1',
      'root-1',
      'token',
      {
        commentId: 'reply-2',
        expectedThreadVersion: 4,
        summary: 'Use the reply as the adopted conclusion.',
      },
      mutationContext,
    )

    expect(page.nextCursor).toBe('context/next')
    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      [undefined, '/api/teams/core/issues/issue-1/context-items?limit=20&cursor=context%2Fa%2Bb'],
      ['POST', '/api/teams/core/issues/issue-1/context-items'],
      ['PATCH', '/api/teams/core/issues/issue-1/context-items/context-1'],
      ['PUT', '/api/teams/core/issues/issue-1/comments/root-1/accepted-resolution'],
    ])
    expect(JSON.parse(String(requests[3]?.init.body))).toEqual({
      commentId: 'reply-2',
      expectedThreadVersion: 4,
      summary: 'Use the reply as the adopted conclusion.',
    })
  })

  test('runtime-validates independently paginated context and resolution history', async () => {
    const contextItem = {
      schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
      id: 'context/1',
      teamId: 'core',
      workItemId: 'issue-1',
      kind: 'decision',
      state: 'active',
      title: 'Earlier title',
      body: 'Earlier rationale',
      mentionMemberKeys: [],
      createdBy: { id: 'member-1', displayName: 'Demo User' },
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedBy: { id: 'member-1', displayName: 'Demo User' },
      updatedAt: '2026-08-09T00:10:00.000Z',
      revision: 1,
    }
    const contextRequests = installFetchRecorder({
      items: [contextItem],
      nextCursor: 'revision/next',
    })

    const revisionPage = await getTeamIssueContextRevisions(
      'core team',
      'issue/1',
      'context/1',
      'token',
      { cursor: 'revision/a+b', limit: 10 },
    )

    expect(revisionPage.items[0]?.revision).toBe(1)
    expect(contextRequests[0]?.url).toBe(
      '/api/teams/core%20team/issues/issue%2F1/context-items/context%2F1/revisions?limit=10&cursor=revision%2Fa%2Bb',
    )

    const resolutionRequests = installFetchRecorder({
      items: [
        {
          id: 'resolution-1',
          sourceCommentId: 'reply-1',
          sourceRootCommentId: 'root/1',
          capturedCommentRevision: 2,
          capturedCommentBody: 'Captured answer',
          summary: 'Adopt the captured answer.',
          acceptedBy: { id: 'member-1', displayName: 'Demo User' },
          acceptedAt: '2026-08-09T00:20:00.000Z',
          state: 'accepted',
        },
      ],
      nextCursor: 'resolution/next',
    })

    const resolutionPage = await getTeamIssueAcceptedResolutions(
      'core team',
      'issue/1',
      'root/1',
      'token',
      { cursor: 'resolution/a+b', limit: 10 },
    )

    expect(resolutionPage.items[0]?.summary).toBe(
      'Adopt the captured answer.',
    )
    expect(resolutionRequests[0]?.url).toBe(
      '/api/teams/core%20team/issues/issue%2F1/comments/root%2F1/accepted-resolutions?limit=10&cursor=resolution%2Fa%2Bb',
    )
  })

  test('rejects malformed collaboration history pages at the API boundary', async () => {
    installFetchRecorder({ items: [{ revision: 1 }] })
    await expect(
      getTeamIssueContextRevisions(
        'core',
        'issue-1',
        'context-1',
        'token',
      ),
    ).rejects.toMatchObject({
      code: 'InvalidCuratedContextRevisionResponse',
      status: 502,
    })

    installFetchRecorder({
      items: [
        {
          id: 'resolution-corrupt',
          state: 'superseded',
        },
      ],
    })
    await expect(
      getTeamIssueAcceptedResolutions(
        'core',
        'issue-1',
        'root-1',
        'token',
      ),
    ).rejects.toMatchObject({
      code: 'InvalidAcceptedResolutionHistoryResponse',
      status: 502,
    })
  })

  test('rejects malformed accepted resolution audit history instead of hiding it', async () => {
    installFetchRecorder({
      comments: [
        {
          acceptedResolutions: [
            {
              acceptedAt: '2026-08-09T00:00:00.000Z',
              acceptedBy: { displayName: 'Demo User', id: 'demo@example.com' },
              capturedCommentBody: 'Old conclusion',
              capturedCommentRevision: 1,
              id: 'resolution-corrupt',
              sourceCommentId: 'reply-1',
              sourceRootCommentId: 'root-1',
              state: 'superseded',
              summary: 'Old summary',
            },
          ],
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: 'Current conclusion',
          capabilities: {
            canDelete: true,
            canEdit: true,
            canResolve: true,
          },
          createdAt: '2026-08-09T00:00:00.000Z',
          id: 'root-1',
          mentionMemberKeys: [],
          reactions: [],
          rootCommentId: 'root-1',
          updatedAt: '2026-08-09T00:00:00.000Z',
          version: 1,
        },
      ],
      watch: {
        subscribed: false,
        explicit: false,
        automatic: false,
        reasons: [],
        watcherCount: 0,
      },
      presence: [],
      capabilities: { canComment: true, canReact: true, canWatch: true },
    })

    await expect(
      getTeamIssueCollaboration('core', 'issue-1', 'token'),
    ).rejects.toMatchObject({
      code: 'InvalidAcceptedResolutionResponse',
      status: 502,
    })
  })
})

function installFetchRecorder(responseBody: unknown) {
  const requests: Array<{ url: string; init: RequestInit }> = []

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })

    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  return requests
}
