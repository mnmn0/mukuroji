import { afterEach, describe, expect, test } from 'bun:test'
import {
  addTeamIssueCommentReaction,
  createTeamIssueComment,
  deleteTeamIssueComment,
  getTeamIssueActivity,
  getTeamIssueCollaboration,
  getProjectWatch,
  resolveTeamIssueComment,
  subscribeProjectWatch,
  subscribeTeamIssueWatch,
  unsubscribeProjectWatch,
  updateTeamIssuePresence,
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
