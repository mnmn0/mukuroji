import { describe, expect, test } from 'bun:test'
import type { ChannelDestinationRecord, ChannelDestinationTarget } from '../domain/channel-destination'
import { deliverDueChannelPosts, enqueueChannelPost, type ChannelPostFailure } from './channel-posts'
import type { ChannelPost, ChannelPostContent } from './ports/channel-posts'

const now = new Date('2026-11-24T00:00:00.000Z')

/**
 * Builds saved destination settings.
 * @param target - Team or Project.
 * @returns Destination settings in Japanese.
 */
function destination(target: ChannelDestinationTarget): ChannelDestinationRecord {
  return { target, provider: 'slack', locale: 'ja', revision: 1, updatedAt: now.toISOString(), updatedBy: 'manager@example.test', secretVersion: '00000000-0000-4000-8000-000000000001' }
}

/**
 * Builds a reader that knows the given destinations.
 * @param targets - Saved destinations.
 * @returns Destination reader.
 */
function destinations(...targets: ChannelDestinationTarget[]) {
  const keys = new Set(targets.map((target) => JSON.stringify(target)))
  return {
    async get(_workspaceId: string, target: ChannelDestinationTarget) {
      return keys.has(JSON.stringify(target)) ? destination(target) : undefined
    },
  }
}

const event = {
  eventId: 'event-1', eventType: 'planning-update.published', workspaceId: 'workspace-1',
  teamId: 'core', projectId: 'alpha', notificationTitle: 'Weekly update', summary: 'Update published.',
  deepLink: '/planning/timeline', occurredAt: now.toISOString(), planningTargetRecordKey: 'TARGET#alpha',
}

describe('channel post queuing', () => {
  test('queues a Project event for the Project channel ahead of the Team channel', async () => {
    const queued: ChannelPostContent[] = []
    const posted = await enqueueChannelPost(event, {
      destinations: destinations({ scope: 'team', teamId: 'core' }, { scope: 'project', teamId: 'core', projectId: 'alpha' }),
      posts: { async enqueue(post) { queued.push(post) } },
      now: () => now,
    })
    expect(posted).toBe(true)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.target).toEqual({ scope: 'project', teamId: 'core', projectId: 'alpha' })
    expect(queued[0]?.title).toBe('Weekly update')
    // The source is kept so the worker can recheck where it sits before sending.
    expect(queued[0]?.source).toEqual({ teamId: 'core', projectId: 'alpha', planningTargetRecordKey: 'TARGET#alpha' })
  })

  test('falls back to the Team channel and skips events channels do not receive', async () => {
    const queued: ChannelPostContent[] = []
    const dependencies = {
      destinations: destinations({ scope: 'team', teamId: 'core' }),
      posts: { async enqueue(post: ChannelPostContent) { queued.push(post) } },
      now: () => now,
    }
    expect(await enqueueChannelPost(event, dependencies)).toBe(true)
    expect(queued[0]?.target).toEqual({ scope: 'team', teamId: 'core' })
    expect(await enqueueChannelPost({ ...event, eventType: 'comment.created' }, dependencies)).toBe(false)
    expect(await enqueueChannelPost({ ...event, teamId: undefined }, dependencies)).toBe(false)
    expect(queued).toHaveLength(1)
  })

  test('queues nothing when neither the Project nor the Team has a channel', async () => {
    let calls = 0
    expect(await enqueueChannelPost(event, {
      destinations: destinations(),
      posts: { async enqueue() { calls += 1 } },
      now: () => now,
    })).toBe(false)
    expect(calls).toBe(0)
  })
})

/** Queued post due now. */
const post: ChannelPost = {
  workspaceId: 'workspace-1', eventId: 'event-1', eventType: 'work-item.overdue',
  target: { scope: 'team', teamId: 'core' }, occurredAt: now.toISOString(), source: { teamId: 'core', issueId: 'issue-1' },
  shard: 'slack-channel#1', attempts: 0, version: 1, nextAttemptAt: now.toISOString(),
}

/**
 * Builds an in-memory queue holding one due post.
 * @param due - Due post.
 * @returns Queue port and the outcomes it recorded.
 */
function queue(due: ChannelPost, renewed = true) {
  const finished: { status: string, nextAttemptAt?: Date, code?: string }[] = []
  return {
    finished,
    posts: {
      async listDue(shard: string) { return { posts: shard === due.shard ? [due] : [], invalidCount: 0 } },
      async claim() { return true },
      async renew() { return renewed },
      async finish(_post: ChannelPost, _token: string, status: 'sent' | 'suppressed' | 'failed' | 'pending', nextAttemptAt?: Date, code?: string) {
        finished.push({ status, ...(nextAttemptAt ? { nextAttemptAt } : {}), ...(code ? { code } : {}) })
      },
    },
  }
}

describe('channel post delivery', () => {
  test('sends a due post and marks it sent', async () => {
    const state = queue(post)
    const delivered = await deliverDueChannelPosts({
      destinations: destinations({ scope: 'team', teamId: 'core' }),
      posts: state.posts,
      isAuthorized: async () => true,
      send: async (sent, saved) => {
        expect(sent.attempts).toBe(1)
        expect(saved.locale).toBe('ja')
        return { succeeded: true, retryable: false }
      },
      shards: ['slack-channel#0', 'slack-channel#1'],
      reportFailure: () => { throw new Error('Must not fail') },
      createToken: () => 'token-1',
      now: () => now,
    })
    expect(delivered).toBe(1)
    expect(state.finished).toEqual([{ status: 'sent' }])
  })

  test('drops a post whose destination was removed', async () => {
    const state = queue(post)
    const delivered = await deliverDueChannelPosts({
      destinations: destinations(),
      posts: state.posts,
      isAuthorized: async () => true,
      send: async () => { throw new Error('Must not send') },
      shards: ['slack-channel#1'],
      reportFailure: () => { throw new Error('Must not fail') },
      createToken: () => 'token-1',
      now: () => now,
    })
    expect(delivered).toBe(0)
    expect(state.finished).toEqual([{ status: 'suppressed', code: 'DestinationRemoved' }])
  })

  test('retries with backoff and Retry-After, then fails the run after the last attempt', async () => {
    const retrying = queue(post)
    await deliverDueChannelPosts({
      destinations: destinations({ scope: 'team', teamId: 'core' }),
      posts: retrying.posts,
      isAuthorized: async () => true,
      send: async () => ({ succeeded: false, retryable: true, code: 'SlackDeliveryRejected', retryAfterMs: 120_000 }),
      shards: ['slack-channel#1'],
      reportFailure: () => { throw new Error('Must not fail yet') },
      createToken: () => 'token-1',
      now: () => now,
    })
    expect(retrying.finished[0]?.status).toBe('pending')
    expect(retrying.finished[0]?.nextAttemptAt?.toISOString()).toBe('2026-11-24T00:02:00.000Z')

    const last = queue({ ...post, attempts: 4 })
    const failures: ChannelPostFailure[] = []
    await expect(deliverDueChannelPosts({
      destinations: destinations({ scope: 'team', teamId: 'core' }),
      posts: last.posts,
      isAuthorized: async () => true,
      send: async () => ({ succeeded: false, retryable: true, code: 'SlackDeliveryUnavailable' }),
      shards: ['slack-channel#1'],
      reportFailure: (failure) => failures.push(failure),
      createToken: () => 'token-5',
      now: () => now,
    })).rejects.toThrow('1 failed')
    expect(last.finished).toEqual([{ status: 'failed', code: 'SlackDeliveryUnavailable' }])
    expect(failures).toEqual([{ shard: 'slack-channel-failed#1', dueAt: post.nextAttemptAt, reference: 'token-5', code: 'SlackDeliveryUnavailable' }])
  })

  test('fails a post reclaimed after its last attempt without sending it again', async () => {
    const state = queue({ ...post, attempts: 5 })
    const failures: ChannelPostFailure[] = []
    await expect(deliverDueChannelPosts({
      destinations: destinations({ scope: 'team', teamId: 'core' }),
      posts: state.posts,
      isAuthorized: async () => { throw new Error('Must not recheck') },
      send: async () => { throw new Error('Must not send') },
      shards: ['slack-channel#1'],
      reportFailure: (failure) => failures.push(failure),
      createToken: () => 'token-6',
      now: () => now,
    })).rejects.toThrow('1 failed')
    expect(state.finished).toEqual([{ status: 'failed', code: 'ChannelPostAttemptsExhausted' }])
    expect(failures.map((failure) => failure.code)).toEqual(['ChannelPostAttemptsExhausted'])
  })

  test('fails the run when a partition was left unread at the page limit', async () => {
    const state = queue(post)
    await expect(deliverDueChannelPosts({
      destinations: destinations({ scope: 'team', teamId: 'core' }),
      posts: { ...state.posts, async listDue() { return { posts: [], invalidCount: 0, truncated: true } } },
      isAuthorized: async () => true,
      send: async () => { throw new Error('Must not send') },
      shards: ['slack-channel#1'],
      reportFailure: () => { throw new Error('Must not fail a post') },
      createToken: () => 'token-1',
      now: () => now,
    })).rejects.toThrow('1 partitions left unread')
  })

  test('drops a post whose source left its Team or Project, or whose Workspace closed', async () => {
    const state = queue(post)
    const delivered = await deliverDueChannelPosts({
      destinations: destinations({ scope: 'team', teamId: 'core' }),
      posts: state.posts,
      isAuthorized: async (checked) => {
        expect(checked.source).toEqual({ teamId: 'core', issueId: 'issue-1' })
        return false
      },
      send: async () => { throw new Error('Must not send') },
      shards: ['slack-channel#1'],
      reportFailure: () => { throw new Error('Must not fail') },
      createToken: () => 'token-1',
      now: () => now,
    })
    expect(delivered).toBe(0)
    expect(state.finished).toEqual([{ status: 'suppressed', code: 'SourceOutOfScope' }])
  })

  test('never sends after the lease was lost while the checks ran', async () => {
    const state = queue(post, false)
    const delivered = await deliverDueChannelPosts({
      destinations: destinations({ scope: 'team', teamId: 'core' }),
      posts: state.posts,
      isAuthorized: async () => true,
      send: async () => { throw new Error('Must not send') },
      shards: ['slack-channel#1'],
      reportFailure: () => { throw new Error('Must not fail') },
      createToken: () => 'token-1',
      now: () => now,
    })
    expect(delivered).toBe(0)
    expect(state.finished).toEqual([])
  })

  test('retries when the recheck cannot read the source', async () => {
    const state = queue(post)
    await deliverDueChannelPosts({
      destinations: destinations({ scope: 'team', teamId: 'core' }),
      posts: state.posts,
      isAuthorized: async () => { throw new Error('read failed') },
      send: async () => { throw new Error('Must not send') },
      shards: ['slack-channel#1'],
      reportFailure: () => { throw new Error('Must not fail yet') },
      createToken: () => 'token-1',
      now: () => now,
    })
    expect(state.finished[0]?.status).toBe('pending')
  })
})
