import { expect, spyOn, test } from 'bun:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { classifyGitHubPullRequestSection, isGitHubLogin, type GitHubPullRequestSectionInput } from '@mukuroji/contracts'
import { GitHubIntegrationError } from './domain/github-integration-error'
import { selectPullRequestInboxItems } from './domain/pull-request-inbox'
import { parseGitHubPullRequestNode, type GitHubPullRequestSnapshot } from './domain/pull-request-snapshot'
import { interpretGitHubWebhook, parseGitHubSyncJob, type GitHubSyncJob } from './domain/sync-jobs'
import { signGitHubWebhookBody, verifyGitHubWebhookSignature } from './domain/webhook-signature'
import {
  processGitHubSyncJob,
  receiveGitHubWebhook,
  reconcileGitHubPullRequests,
} from './application/pull-request-sync'
import {
  deleteGitHubLoginHolder,
  deleteGitHubRepositoryLink,
  readGitHubPullRequestInbox,
  saveGitHubLogin,
  saveGitHubRepositoryLink,
} from './application/pull-request-inbox'
import type { GitHubAppCredentialSource, GitHubAppGateway, GitHubRepositoryLinkRecord } from './application/ports'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDbGitHubIntegrationStore, InMemoryGitHubIntegrationStore } from './adapter-out/dynamodb/github-integration-store'
import { InMemoryGitHubSyncQueue } from './adapter-out/sqs/github-sync-queue'
import { createGitHubNotificationAuditEvent, InMemoryGitHubNotificationSink } from './adapter-out/dynamodb/github-notification-sink'
import { carryLastKnownMergeable, detectPullRequestNotifications } from './domain/pull-request-notifications'
import { createGitHubReconcileHandler, createGitHubSyncQueueHandler } from './adapter-in/events/github-sync-worker'

/** Workspace of the tests. */
const WORKSPACE_ID = 'workspace-1'

/** Webhook secret of the fake App. */
const WEBHOOK_SECRET = 'webhook-secret-of-at-least-20-characters'

/** Credentials of the fake App; the key is never used to sign in these tests. */
const credentials: GitHubAppCredentialSource = {
  async read() {
    return { appId: '1', privateKey: 'unused', webhookSecrets: [WEBHOOK_SECRET] }
  },
}

/** Credentials of a deployment without an App. */
const noCredentials: GitHubAppCredentialSource = {
  async read() {
    return null
  },
}

/** Link of the test repository to `core-team`. */
const link: GitHubRepositoryLinkRecord = {
  installationId: '7',
  repositoryId: '42',
  repository: 'acme/app',
  private: true,
  teamId: 'core-team',
  revision: 1,
  linkedAt: '2026-11-28T00:00:00.000Z',
}

/**
 * Builds a GraphQL pull request node as the sync query returns it.
 *
 * @param overrides - Fields to replace.
 * @returns The node.
 */
function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 5,
    title: 'Add the review inbox',
    url: 'https://github.com/acme/app/pull/5',
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-28T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: 'a'.repeat(40),
    mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    baseRepository: { databaseId: 42, nameWithOwner: 'acme/app' },
    author: { login: 'alice' },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'bob' } }, { requestedReviewer: { __typename: 'Team', slug: 'web' } }] },
    latestOpinionatedReviews: { nodes: [{ state: 'COMMENTED', author: { login: 'carol' } }] },
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: {
            state: 'FAILURE',
            contexts: {
              totalCount: 2,
              nodes: [
                { __typename: 'CheckRun', name: 'unit-tests', conclusion: 'FAILURE' },
                { __typename: 'StatusContext', context: 'ci/lint', state: 'SUCCESS' },
              ],
            },
          },
        },
      }],
    },
    ...overrides,
  }
}

/**
 * Builds a snapshot from a node.
 *
 * @param overrides - Node fields to replace.
 * @param syncedAt - Read time.
 * @returns The snapshot.
 */
function snapshot(overrides: Record<string, unknown> = {}, syncedAt = '2026-11-28T01:00:00.000Z'): GitHubPullRequestSnapshot {
  return parseGitHubPullRequestNode(node(overrides), { repositoryId: '42' }, syncedAt)
}

/**
 * Builds a gateway that serves fixed snapshots and records its calls.
 *
 * @param open - Open snapshots by repository.
 * @param byNumber - Snapshots by number; a missing number is reported missing.
 * @returns The gateway and its calls.
 */
function fakeGateway(open: GitHubPullRequestSnapshot[], byNumber: Map<number, GitHubPullRequestSnapshot> = new Map()) {
  const calls: string[] = []
  const gateway: GitHubAppGateway = {
    async listRepositories() {
      calls.push('list')
      return { repositories: [{ installationId: '7', repositoryId: '42', repository: 'acme/app', private: true }], incomplete: false }
    },
    async readRepositoryName() {
      calls.push('name')
      return 'acme/app'
    },
    async readPullRequests(_reference, numbers) {
      calls.push(`numbers:${numbers.join(',')}`)
      return {
        snapshots: numbers.flatMap((number) => byNumber.get(number) ?? []),
        missing: numbers.filter((number) => !byNumber.has(number)),
      }
    },
    async readCommitPullRequests(_reference, sha) {
      calls.push(`commit:${sha}`)
      return open
    },
    async readOpenPullRequests(_reference, options) {
      calls.push(`open:${options.baseRef ?? '*'}`)
      return { snapshots: open, incomplete: false }
    },
  }
  return { gateway, calls }
}

test('accepts ordinary and Enterprise Managed Users logins and rejects malformed ones', () => {
  for (const login of ['a', 'demo-user', 'Octo42', 'mona-cat_octo', 'a'.repeat(39), 'mona_abc', 'mona_abcdefgh', `${'a'.repeat(34)}_octo`]) {
    expect(isGitHubLogin(login)).toBe(true)
  }
  for (const login of [
    '', '-alice', 'alice-', 'al--ice', 'a'.repeat(40), 'alice_', '_octo', 'mona_cat_octo', 'mona cat', 'mona@octo',
    'alice_ab', 'alice_abcdefghi', `${'a'.repeat(35)}_octo`,
  ]) {
    expect(isGitHubLogin(login)).toBe(false)
  }
})

test('verifies the webhook signature with the current or the previous secret only', () => {
  const body = new TextEncoder().encode('{"zen":"Keep it simple."}')
  const signature = signGitHubWebhookBody(WEBHOOK_SECRET, body)
  expect(verifyGitHubWebhookSignature([WEBHOOK_SECRET], body, signature)).toBe(true)
  expect(verifyGitHubWebhookSignature(['another-secret-of-20-characters', WEBHOOK_SECRET], body, signature)).toBe(true)
  expect(verifyGitHubWebhookSignature(['another-secret-of-20-characters'], body, signature)).toBe(false)
  expect(verifyGitHubWebhookSignature([WEBHOOK_SECRET], new TextEncoder().encode('{"zen":"changed"}'), signature)).toBe(false)
  expect(verifyGitHubWebhookSignature([WEBHOOK_SECRET], body, signature.replace('sha256=', 'sha1='))).toBe(false)
  expect(verifyGitHubWebhookSignature([WEBHOOK_SECRET], body, undefined)).toBe(false)
  expect(verifyGitHubWebhookSignature([''], body, signGitHubWebhookBody('', body))).toBe(false)
})

test('turns each supported webhook event into a sync job of identifiers only', () => {
  const repository = { installation: { id: 7 }, repository: { id: 42, full_name: 'acme/app' } }
  expect(interpretGitHubWebhook('pull_request', { ...repository, action: 'opened', number: 5, pull_request: { number: 5 } }))
    .toEqual({ kind: 'job', job: { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 0, kind: 'pull-requests', numbers: [5] } })
  expect(interpretGitHubWebhook('check_run', { ...repository, check_run: { head_sha: 'b'.repeat(40), pull_requests: [{ number: 5 }, { number: 5 }, { number: 6 }] } }))
    .toMatchObject({ job: { kind: 'pull-requests', numbers: [5, 6] } })
  // A pull request from a fork has an empty list, so the head commit is looked up instead.
  expect(interpretGitHubWebhook('check_suite', { ...repository, check_suite: { head_sha: 'b'.repeat(40), pull_requests: [] } }))
    .toMatchObject({ job: { kind: 'commit', sha: 'b'.repeat(40) } })
  expect(interpretGitHubWebhook('status', { ...repository, sha: 'c'.repeat(40), state: 'failure' }))
    .toMatchObject({ job: { kind: 'commit', sha: 'c'.repeat(40) } })
  expect(interpretGitHubWebhook('push', { ...repository, ref: 'refs/heads/main' }))
    .toMatchObject({ job: { kind: 'base-branch', branch: 'main' } })
  expect(interpretGitHubWebhook('push', { ...repository, ref: 'refs/tags/v1' })).toEqual({ kind: 'ignored' })
  expect(interpretGitHubWebhook('push', { ...repository, ref: 'refs/heads/main', deleted: true })).toEqual({ kind: 'ignored' })
  expect(interpretGitHubWebhook('issues', { ...repository, issue: { number: 1 } })).toEqual({ kind: 'ignored' })
  expect(interpretGitHubWebhook('pull_request', { repository: { id: 42, full_name: 'acme/app' }, number: 5 })).toEqual({ kind: 'ignored' })
  expect(interpretGitHubWebhook('ping', {})).toEqual({ kind: 'ping' })
})

test('rejects a queue message that is not a sync job', () => {
  const job: GitHubSyncJob = { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 0, kind: 'pull-requests', numbers: [5] }
  expect(parseGitHubSyncJob(job)).toEqual(job)
  expect(() => parseGitHubSyncJob({ ...job, numbers: [] })).toThrow(TypeError)
  expect(() => parseGitHubSyncJob({ ...job, numbers: [0] })).toThrow(TypeError)
  expect(() => parseGitHubSyncJob({ ...job, repository: 'acme/app/../x' })).toThrow(TypeError)
  expect(() => parseGitHubSyncJob({ ...job, attempt: 9 })).toThrow(TypeError)
  expect(() => parseGitHubSyncJob({ ...job, kind: 'delete-everything' })).toThrow(TypeError)
})

test('reads the checks, reviews, and conflict state of a GraphQL pull request', () => {
  const parsed = snapshot()
  expect(parsed).toMatchObject({
    repositoryId: '42',
    repository: 'acme/app',
    number: 5,
    state: 'open',
    authorLogin: 'alice',
    mergeable: 'mergeable',
    reviewDecision: 'review-required',
    requestedReviewerLogins: ['bob'],
    requestedTeamSlugs: ['web'],
    reviews: [{ login: 'carol', state: 'commented' }],
    checks: { state: 'failure', failedNames: ['unit-tests'], total: 2 },
  })
  expect(snapshot({ state: 'MERGED', mergedAt: '2026-11-28T02:00:00Z', closedAt: '2026-11-28T02:00:00Z' }))
    .toMatchObject({ state: 'merged', mergedAt: '2026-11-28T02:00:00.000Z', closedAt: '2026-11-28T02:00:00.000Z' })
  expect(snapshot({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }).checks).toEqual({ state: 'none', failedNames: [], total: 0 })
  // A node of another repository is refused, so a forged response cannot write into this one.
  expect(() => parseGitHubPullRequestNode(node({ baseRepository: { databaseId: 43, nameWithOwner: 'acme/other' } }), { repositoryId: '42' }, 'now'))
    .toThrow(TypeError)
  expect(() => parseGitHubPullRequestNode(node({ url: 'https://evil.example/acme/app/pull/5' }), { repositoryId: '42' }, 'now'))
    .toThrow(TypeError)
})

test('classifies a pull request into the inbox sections', () => {
  const ready: GitHubPullRequestSectionInput = { state: 'open', draft: false, mergeable: 'mergeable', reviewDecision: 'approved', checks: { state: 'success', failedNames: [], total: 1 } }
  expect(classifyGitHubPullRequestSection(ready)).toBe('ready-to-merge')
  expect(classifyGitHubPullRequestSection({ ...ready, reviewDecision: 'none', checks: { state: 'none', failedNames: [], total: 0 } })).toBe('ready-to-merge')
  expect(classifyGitHubPullRequestSection({ ...ready, draft: true })).toBe('open')
  expect(classifyGitHubPullRequestSection({ ...ready, mergeable: 'conflicting' })).toBe('open')
  expect(classifyGitHubPullRequestSection({ ...ready, checks: { state: 'pending', failedNames: [], total: 1 } })).toBe('open')
  expect(classifyGitHubPullRequestSection({ ...ready, reviewDecision: 'review-required' })).toBe('open')
  expect(classifyGitHubPullRequestSection({ ...ready, state: 'merged' })).toBe('merged')
  expect(classifyGitHubPullRequestSection({ ...ready, state: 'closed' })).toBe('closed')
})

test('lists a member\'s own and requested pull requests only from Teams they can read', () => {
  const mine = snapshot()
  const requested = snapshot({ number: 6, author: { login: 'dave' } })
  const reviewed = snapshot({ number: 7, author: { login: 'dave' }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: { login: 'Bob' } }] } })
  const oldClosed = snapshot({ number: 8, state: 'CLOSED', closedAt: '2026-10-01T00:00:00Z' })
  const otherRepository = { ...snapshot({ number: 9 }), repositoryId: '99' }
  const selection = {
    repositoryTeams: new Map([['42', 'core-team'], ['99', 'secret-team']]),
    readableTeamIds: new Set(['core-team']),
    now: new Date('2026-11-28T03:00:00Z'),
  }
  const all = [mine, requested, reviewed, oldClosed, otherRepository]
  expect(selectPullRequestInboxItems(all, { ...selection, view: 'created', login: 'ALICE' }).map((item) => item.number)).toEqual([5])
  expect(selectPullRequestInboxItems(all, { ...selection, view: 'to-review', login: 'bob' }).map((item) => item.number).sort()).toEqual([5, 6, 7])
  expect(selectPullRequestInboxItems(all, { ...selection, view: 'created', login: 'alice' })[0]).toMatchObject({ teamId: 'core-team', section: 'open' })
  expect(selectPullRequestInboxItems(all, { ...selection, readableTeamIds: new Set(), view: 'created', login: 'alice' })).toEqual([])
})

test('accepts only signed webhooks and queues their job', async () => {
  const queue = new InMemoryGitHubSyncQueue()
  const body = new TextEncoder().encode(JSON.stringify({ installation: { id: 7 }, repository: { id: 42, full_name: 'acme/app' }, number: 5 }))
  const delivery = { eventName: 'pull_request', signature: signGitHubWebhookBody(WEBHOOK_SECRET, body), rawBody: body }
  expect(await receiveGitHubWebhook({ credentials: noCredentials, queue }, delivery)).toEqual({ kind: 'not-configured' })
  expect(await receiveGitHubWebhook({ credentials, queue }, { ...delivery, signature: 'sha256=' + '0'.repeat(64) })).toEqual({ kind: 'unauthorized' })
  expect(queue.sent).toEqual([])
  expect(await receiveGitHubWebhook({ credentials, queue }, delivery)).toEqual({ kind: 'accepted' })
  expect(queue.sent).toEqual([{ job: { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 0, kind: 'pull-requests', numbers: [5] }, delaySeconds: 0 }])
  const invalid = new TextEncoder().encode('{')
  expect(await receiveGitHubWebhook({ credentials, queue }, { eventName: 'pull_request', signature: signGitHubWebhookBody(WEBHOOK_SECRET, invalid), rawBody: invalid }))
    .toEqual({ kind: 'invalid' })
})

test('stores snapshots of linked repositories only and retries an unknown conflict state', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  const queue = new InMemoryGitHubSyncQueue()
  const unknown = snapshot({ mergeable: 'UNKNOWN' })
  const { gateway } = fakeGateway([], new Map([[5, unknown]]))
  const job = { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 0, kind: 'pull-requests' as const, numbers: [5, 6] }
  // Without a link, nothing is read or written.
  expect(await processGitHubSyncJob({ store, gateway, queue, notifications: new InMemoryGitHubNotificationSink() }, WORKSPACE_ID, job, new Date())).toMatchObject({ skipped: true })
  await store.saveRepositoryLink({ workspaceId: WORKSPACE_ID, record: link })
  // A delivery from an installation the link does not name is skipped too.
  expect(await processGitHubSyncJob({ store, gateway, queue, notifications: new InMemoryGitHubNotificationSink() }, WORKSPACE_ID, { ...job, installationId: '8' }, new Date())).toMatchObject({ skipped: true })
  await store.putPullRequestSnapshot(WORKSPACE_ID, snapshot({ number: 6 }))
  const result = await processGitHubSyncJob({ store, gateway, queue, notifications: new InMemoryGitHubNotificationSink() }, WORKSPACE_ID, job, new Date('2026-11-28T02:00:00Z'))
  expect(result).toEqual({ skipped: false, written: 1, deleted: 1, requeued: true })
  expect((await store.listPullRequestSnapshots(WORKSPACE_ID)).snapshots.map((item) => item.number)).toEqual([5])
  expect(queue.sent).toEqual([{ job: { ...job, attempt: 1, numbers: [5] }, delaySeconds: 30 }])
  // The last attempt does not requeue again.
  const last = await processGitHubSyncJob({ store, gateway, queue, notifications: new InMemoryGitHubNotificationSink() }, WORKSPACE_ID, { ...job, attempt: 3, numbers: [5] }, new Date('2026-11-28T03:00:00Z'))
  expect(last.requeued).toBe(false)
})

test('splits more unresolved conflict states than one job holds into several retries', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  const queue = new InMemoryGitHubSyncQueue()
  await store.saveRepositoryLink({ workspaceId: WORKSPACE_ID, record: link })
  const open = Array.from({ length: 25 }, (_, index) => snapshot({ number: index + 1, mergeable: 'UNKNOWN' }))
  const { gateway } = fakeGateway(open)
  const job = { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 0, kind: 'repository' as const }
  await processGitHubSyncJob({ store, gateway, queue, notifications: new InMemoryGitHubNotificationSink() }, WORKSPACE_ID, job, new Date('2026-11-28T02:00:00Z'))
  expect(queue.sent.map((sent) => sent.job.kind === 'pull-requests' ? sent.job.numbers.length : 0)).toEqual([20, 5])
})

test('removes only the login an administrator asked to remove', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  await store.saveMemberLogin({ workspaceId: WORKSPACE_ID, memberKey: 'alice@example.com', login: 'alice', now: 'now' })
  /** Store whose member changes their login right after the administrator's lookup. */
  class ChangingLoginStore extends InMemoryGitHubIntegrationStore {
    /**
     * Reads the member's login as changed.
     *
     * @returns The new login.
     */
    override async getMemberLogin(): Promise<string> {
      return 'alice-new'
    }
  }
  const changing = new ChangingLoginStore()
  await changing.saveMemberLogin({ workspaceId: WORKSPACE_ID, memberKey: 'alice@example.com', login: 'alice', now: 'now' })
  await expect(deleteGitHubLoginHolder(changing, WORKSPACE_ID, 'Alice', { now: 'now' })).rejects.toMatchObject({ code: 'GitHubLoginNotFound' })
  expect(await changing.findMemberByLogin(WORKSPACE_ID, 'alice')).toBe('alice@example.com')
  await deleteGitHubLoginHolder(store, WORKSPACE_ID, 'ALICE', { now: 'now' })
  expect(await store.findMemberByLogin(WORKSPACE_ID, 'alice')).toBeNull()
})

test('reconciles open pull requests and removes unlinked and expired snapshots', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  const queue = new InMemoryGitHubSyncQueue()
  await store.saveRepositoryLink({ workspaceId: WORKSPACE_ID, record: link })
  await store.putPullRequestSnapshot(WORKSPACE_ID, snapshot({ number: 1 }, '2026-11-01T00:00:00.000Z'))
  await store.putPullRequestSnapshot(WORKSPACE_ID, snapshot({ number: 2, state: 'MERGED', closedAt: '2026-10-01T00:00:00Z' }, '2026-10-01T00:00:00.000Z'))
  await store.putPullRequestSnapshot(WORKSPACE_ID, { ...snapshot({ number: 3 }), repositoryId: '99' })
  const merged = snapshot({ number: 1, state: 'MERGED', mergedAt: '2026-11-27T00:00:00Z', closedAt: '2026-11-27T00:00:00Z' }, '2026-11-28T05:00:00.000Z')
  const { gateway, calls } = fakeGateway([snapshot({ number: 4 }, '2026-11-28T05:00:00.000Z')], new Map([[1, merged]]))
  const errors: unknown[] = []
  const result = await reconcileGitHubPullRequests({ store, gateway, queue, notifications: new InMemoryGitHubNotificationSink() }, WORKSPACE_ID, new Date('2026-11-28T05:00:00Z'), (_link, error) => errors.push(error))
  expect(errors).toEqual([])
  expect(result).toEqual({ repositories: 1, failedRepositories: 0, written: 2, deleted: 2 })
  expect(calls).toEqual(['name', 'open:*', 'numbers:1'])
  const stored = (await store.listPullRequestSnapshots(WORKSPACE_ID)).snapshots
  expect(stored.map((item) => [item.number, item.state]).sort()).toEqual([[1, 'merged'], [4, 'open']])
})

test('rereads stored open pull requests a partial open list leaves out', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  await store.saveRepositoryLink({ workspaceId: WORKSPACE_ID, record: link })
  await store.putPullRequestSnapshot(WORKSPACE_ID, snapshot({ number: 1 }, '2026-11-01T00:00:00.000Z'))
  const closed = snapshot({ number: 1, state: 'CLOSED', closedAt: '2026-11-27T00:00:00Z' }, '2026-11-28T05:00:00.000Z')
  const { gateway, calls } = fakeGateway([snapshot({ number: 4 }, '2026-11-28T05:00:00.000Z')], new Map([[1, closed]]))
  const partial: GitHubAppGateway = {
    ...gateway,
    async readOpenPullRequests(reference, options, syncedAt) {
      return { ...await gateway.readOpenPullRequests(reference, options, syncedAt), incomplete: true }
    },
  }
  await reconcileGitHubPullRequests({ store, gateway: partial, queue: new InMemoryGitHubSyncQueue(), notifications: new InMemoryGitHubNotificationSink() }, WORKSPACE_ID, new Date('2026-11-28T05:00:00Z'), () => undefined)
  expect(calls).toEqual(['name', 'open:*', 'numbers:1'])
  expect((await store.getPullRequestSnapshot(WORKSPACE_ID, '42', 1))?.state).toBe('closed')
})

test('retries unresolved conflict states that a reconcile reads', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  const queue = new InMemoryGitHubSyncQueue()
  await store.saveRepositoryLink({ workspaceId: WORKSPACE_ID, record: link })
  await store.putPullRequestSnapshot(WORKSPACE_ID, snapshot({ number: 1 }, '2026-11-01T00:00:00.000Z'))
  const reread = snapshot({ number: 1, mergeable: 'UNKNOWN' }, '2026-11-28T05:00:00.000Z')
  const { gateway } = fakeGateway(
    [snapshot({ number: 4, mergeable: 'UNKNOWN' }, '2026-11-28T05:00:00.000Z'), snapshot({ number: 5 }, '2026-11-28T05:00:00.000Z')],
    new Map([[1, reread]]),
  )
  await reconcileGitHubPullRequests({ store, gateway, queue, notifications: new InMemoryGitHubNotificationSink() }, WORKSPACE_ID, new Date('2026-11-28T05:00:00Z'), () => undefined)
  expect(queue.sent).toEqual([
    { job: { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 1, kind: 'pull-requests', numbers: [4, 1] }, delaySeconds: 30 },
  ])
})

test('keeps a snapshot written after the one a cleanup read', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  await store.putPullRequestSnapshot(WORKSPACE_ID, snapshot({ number: 1 }, '2026-11-01T00:00:00.000Z'))
  await store.putPullRequestSnapshot(WORKSPACE_ID, snapshot({ number: 1 }, '2026-11-02T00:00:00.000Z'))
  expect(await store.deletePullRequestSnapshot(WORKSPACE_ID, '42', 1, { syncedAt: '2026-11-01T00:00:00.000Z' })).toBe('stale')
  expect(await store.getPullRequestSnapshot(WORKSPACE_ID, '42', 1)).not.toBeNull()
  expect(await store.deletePullRequestSnapshot(WORKSPACE_ID, '42', 1, { syncedAt: '2026-11-02T00:00:00.000Z' })).toBe('deleted')
  expect(await store.getPullRequestSnapshot(WORKSPACE_ID, '42', 1)).toBeNull()
})

test('keeps a snapshot read after the read that found the pull request gone', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  await store.putPullRequestSnapshot(WORKSPACE_ID, snapshot({ number: 1 }, '2026-11-02T00:00:00.000Z'))
  expect(await store.deletePullRequestSnapshot(WORKSPACE_ID, '42', 1, { readAt: '2026-11-01T00:00:00.000Z' })).toBe('stale')
  expect(await store.getPullRequestSnapshot(WORKSPACE_ID, '42', 1)).not.toBeNull()
  expect(await store.deletePullRequestSnapshot(WORKSPACE_ID, '42', 1, { readAt: '2026-11-03T00:00:00.000Z' })).toBe('deleted')
  expect(await store.getPullRequestSnapshot(WORKSPACE_ID, '42', 1)).toBeNull()
})

test('lists the inbox for the caller\'s registered login', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  await store.saveRepositoryLink({ workspaceId: WORKSPACE_ID, record: link })
  await store.putPullRequestSnapshot(WORKSPACE_ID, snapshot())
  const member = { workspaceId: WORKSPACE_ID, memberKey: 'alice@example.com' }
  const readable = async () => new Set(['core-team'])
  expect(await readGitHubPullRequestInbox({ store, credentials }, member, 'created', readable, new Date('2026-11-28T03:00:00Z')))
    .toEqual({ configured: true, view: 'created', items: [] })
  await saveGitHubLogin(store, member, 'alice', { now: '2026-11-28T03:00:00Z' })
  const inbox = await readGitHubPullRequestInbox({ store, credentials }, member, 'created', readable, new Date('2026-11-28T03:00:00Z'))
  expect(inbox).toMatchObject({ configured: true, githubLogin: 'alice', view: 'created', items: [{ number: 5, section: 'open' }] })
  // Another member cannot take the same login, in any case.
  await expect(saveGitHubLogin(store, { workspaceId: WORKSPACE_ID, memberKey: 'mallory@example.com' }, 'Alice', { now: 'now' }))
    .rejects.toMatchObject({ code: 'GitHubLoginTaken' })
  // A case-only change keeps the login.
  expect(await saveGitHubLogin(store, member, 'Alice', { now: 'now' })).toEqual({ githubLogin: 'Alice' })
  expect(await store.findMemberByLogin(WORKSPACE_ID, 'alice')).toBe('alice@example.com')
})

test('links only repositories the App can read to an existing Team', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  const queue = new InMemoryGitHubSyncQueue()
  const { gateway } = fakeGateway([])
  const dependencies = { store, credentials, gateway, queue }
  const context = { teamExists: async (teamId: string) => teamId === 'core-team', now: '2026-11-28T00:00:00.000Z' }
  await expect(saveGitHubRepositoryLink(dependencies, WORKSPACE_ID, '43', { teamId: 'core-team' }, context))
    .rejects.toMatchObject({ code: 'GitHubRepositoryNotFound' })
  await expect(saveGitHubRepositoryLink(dependencies, WORKSPACE_ID, '42', { teamId: 'other' }, context))
    .rejects.toMatchObject({ code: 'GitHubLinkTeamNotFound' })
  await expect(saveGitHubRepositoryLink({ ...dependencies, credentials: noCredentials }, WORKSPACE_ID, '42', { teamId: 'core-team' }, context))
    .rejects.toMatchObject({ code: 'GitHubAppNotConfigured' })
  expect(await saveGitHubRepositoryLink(dependencies, WORKSPACE_ID, '42', { teamId: 'core-team' }, context))
    .toMatchObject({ repositoryId: '42', teamId: 'core-team', revision: 1 })
  expect(queue.sent.map((sent) => sent.job.kind)).toEqual(['repository'])
  // Retrying the same save, as after a queue failure, queues the first sync again without a conflict.
  expect(await saveGitHubRepositoryLink(dependencies, WORKSPACE_ID, '42', { teamId: 'core-team' }, context))
    .toMatchObject({ revision: 1 })
  expect(queue.sent.map((sent) => sent.job.kind)).toEqual(['repository', 'repository'])
  // A save made from an older revision for another Team still conflicts.
  const contextWithSecond = { ...context, teamExists: async (teamId: string) => teamId === 'core-team' || teamId === 'web-team' }
  await expect(saveGitHubRepositoryLink(dependencies, WORKSPACE_ID, '42', { teamId: 'web-team' }, contextWithSecond))
    .rejects.toMatchObject({ code: 'GitHubRepositoryLinkConflict' })
  expect(await saveGitHubRepositoryLink(dependencies, WORKSPACE_ID, '42', { teamId: 'core-team', expectedRevision: 1 }, context))
    .toMatchObject({ revision: 2 })
  // Linking again after removal continues the revisions, so a tab still holding revision 1 or 2
  // cannot change the new link.
  await deleteGitHubRepositoryLink(store, WORKSPACE_ID, '42', 2, { now: 'now' })
  expect(await saveGitHubRepositoryLink(dependencies, WORKSPACE_ID, '42', { teamId: 'web-team' }, contextWithSecond))
    .toMatchObject({ teamId: 'web-team', revision: 3 })
  await expect(deleteGitHubRepositoryLink(store, WORKSPACE_ID, '42', 1, { now: 'now' })).rejects.toMatchObject({ code: 'GitHubRepositoryLinkConflict' })
  await expect(saveGitHubRepositoryLink(dependencies, WORKSPACE_ID, '42', { teamId: 'core-team', expectedRevision: 1 }, context))
    .rejects.toMatchObject({ code: 'GitHubRepositoryLinkConflict' })
})

test('reports every job failure and malformed message to SQS', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  await store.saveRepositoryLink({ workspaceId: WORKSPACE_ID, record: link })
  const failing: GitHubAppGateway = {
    ...fakeGateway([]).gateway,
    async readPullRequests(_reference, numbers) {
      if (numbers.includes(6)) {
        throw new GitHubIntegrationError('unavailable', 'GitHubResponseMalformed', 'GitHub returned an unexpected answer.', { retryable: false })
      }
      throw new GitHubIntegrationError('unavailable', 'GitHubRequestRejected', 'GitHub answered 502.')
    },
  }
  const logs: string[] = []
  const handler = createGitHubSyncQueueHandler({
    store,
    gateway: failing,
    queue: new InMemoryGitHubSyncQueue(),
    notifications: new InMemoryGitHubNotificationSink(),
    workspaceId: WORKSPACE_ID,
    now: () => new Date(),
    log: (message) => logs.push(message),
    isTenantActive: async () => true,
  })
  const job = { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 0, kind: 'pull-requests', numbers: [5] }
  const response = await handler({ Records: [
    { messageId: 'm1', body: JSON.stringify(job) },
    { messageId: 'm2', body: 'not json' },
    { messageId: 'm3', body: JSON.stringify({ ...job, numbers: [6] }) },
  ] })
  // A malformed message and a failure retrying will not fix go back to SQS too, so they reach the
  // DLQ instead of being lost.
  expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }, { itemIdentifier: 'm2' }, { itemIdentifier: 'm3' }] })
  expect(logs).toEqual(['GitHub sync job failed.', 'GitHub sync worker received a malformed message.', 'GitHub sync job failed.'])
})

test('notifies new reviewers and the author of new CI failures and conflicts, once', () => {
  const before = { ...snapshot({}, '2026-11-28T01:00:00.000Z'), checks: { state: 'success' as const, failedNames: [], total: 2 } }
  // A pull request seen for the first time notifies only when a webhook announced it.
  expect(detectPullRequestNotifications(undefined, before, { notifyNew: false })).toEqual([])
  expect(detectPullRequestNotifications(undefined, before, { notifyNew: true }).map((item) => [item.kind, item.login])).toEqual([['review-requested', 'bob']])
  const failing = snapshot({
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'Bob' } }, { requestedReviewer: { __typename: 'User', login: 'dave' } }, { requestedReviewer: { __typename: 'User', login: 'alice' } }] },
    mergeable: 'CONFLICTING',
  }, '2026-11-28T02:00:00.000Z')
  const found = detectPullRequestNotifications(before, failing, { notifyNew: false })
  // Bob was already requested, and the author never reviews their own pull request.
  expect(found.map((item) => [item.kind, item.login])).toEqual([['review-requested', 'dave'], ['checks-failed', 'alice'], ['conflict', 'alice']])
  // Reading the same change again from the same stored snapshot yields the same keys.
  expect(detectPullRequestNotifications(before, failing, { notifyNew: false }).map((item) => item.key)).toEqual(found.map((item) => item.key))
  // A failure that keeps failing on the same head, or a closed pull request, says nothing.
  expect(detectPullRequestNotifications(failing, { ...failing, syncedAt: '2026-11-28T03:00:00.000Z' }, { notifyNew: false })).toEqual([])
  expect(detectPullRequestNotifications(before, { ...failing, state: 'merged' }, { notifyNew: false })).toEqual([])
  // GitHub recomputing the conflict state after a push is not a new conflict.
  const recomputing = { ...failing, mergeable: 'unknown' as const, syncedAt: '2026-11-28T03:00:00.000Z' }
  expect(detectPullRequestNotifications(recomputing, { ...failing, syncedAt: '2026-11-28T04:00:00.000Z' }, { notifyNew: false })).toEqual([])
  // A push makes GitHub answer `unknown` before `conflicting`; the state before the push counts.
  const pushed = carryLastKnownMergeable(before, { ...before, mergeable: 'unknown', syncedAt: '2026-11-28T03:00:00.000Z' })
  expect(pushed.lastKnownMergeable).toBe('mergeable')
  const conflicting = { ...before, mergeable: 'conflicting' as const, syncedAt: '2026-11-28T04:00:00.000Z' }
  expect(detectPullRequestNotifications(pushed, conflicting, { notifyNew: false }).map((item) => item.kind)).toEqual(['conflict'])
  expect(carryLastKnownMergeable(pushed, conflicting).lastKnownMergeable).toBeUndefined()
  // A conflict that lasts through the recomputation is not new.
  const stillConflicting = carryLastKnownMergeable(conflicting, { ...conflicting, mergeable: 'unknown', syncedAt: '2026-11-28T05:00:00.000Z' })
  expect(detectPullRequestNotifications(stillConflicting, { ...conflicting, syncedAt: '2026-11-28T06:00:00.000Z' }, { notifyNew: false })).toEqual([])
})

test('sends pull request notifications to registered members before storing the snapshot', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  const notifications = new InMemoryGitHubNotificationSink()
  await store.saveRepositoryLink({ workspaceId: WORKSPACE_ID, record: link })
  await store.saveMemberLogin({ workspaceId: WORKSPACE_ID, memberKey: 'bob@example.com', login: 'bob', now: 'now' })
  const { gateway } = fakeGateway([], new Map([[5, snapshot({}, 'ignored')]]))
  const job = { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 0, kind: 'pull-requests' as const, numbers: [5] }
  await processGitHubSyncJob({ store, gateway, queue: new InMemoryGitHubSyncQueue(), notifications }, WORKSPACE_ID, job, new Date('2026-11-28T02:00:00Z'))
  // Alice has no registered login, so only Bob is told.
  expect(notifications.published.map((item) => [item.kind, item.memberKey, item.teamId])).toEqual([['review-requested', 'bob@example.com', 'core-team']])
  // Linking a repository reads every open pull request without notifying.
  const linked = new InMemoryGitHubNotificationSink()
  const fresh = new InMemoryGitHubIntegrationStore()
  await fresh.saveRepositoryLink({ workspaceId: WORKSPACE_ID, record: link })
  await fresh.saveMemberLogin({ workspaceId: WORKSPACE_ID, memberKey: 'bob@example.com', login: 'bob', now: 'now' })
  const repositoryJob = { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 0, kind: 'repository' as const }
  const result = await processGitHubSyncJob({ store: fresh, gateway: fakeGateway([snapshot()]).gateway, queue: new InMemoryGitHubSyncQueue(), notifications: linked }, WORKSPACE_ID, repositoryJob, new Date())
  expect(result.written).toBe(1)
  expect(linked.published).toEqual([])
  const event = createGitHubNotificationAuditEvent(notifications.published[0], new Date('2026-11-28T02:00:00Z'), 30)
  expect(event).toMatchObject({
    eventType: 'github.pull_request_review_requested',
    summary: 'A GitHub pull request notification was sent.',
    metadata: {
      teamId: 'core-team',
      deepLink: '/reviews',
      notificationCandidates: [{ memberKey: 'bob@example.com', reason: 'review-requested' }],
      notificationMessage: { code: 'github.review-requested', params: { repository: 'acme/app', number: 5 } },
    },
  })
  // The event ID comes from the notification key, so a retry writes the same row.
  expect(createGitHubNotificationAuditEvent(notifications.published[0], new Date('2026-11-28T02:05:00Z'), 30).eventId).toBe(event.eventId)
})

test('fails instead of treating an unreadable stored snapshot as absent', async () => {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }))
  const send = spyOn(client, 'send').mockImplementation(async () => ({
    Item: { workspaceId: WORKSPACE_ID, recordKey: 'GITHUB_PULL_REQUEST#42#0000000005', entryType: 'github-pull-request', schemaVersion: 99 },
    $metadata: {},
  }))
  try {
    const store = new DynamoDbGitHubIntegrationStore('planning', client)
    await expect(store.getPullRequestSnapshot(WORKSPACE_ID, '42', 5)).rejects.toMatchObject({ code: 'GitHubIntegrationCorrupt' })
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand)
  } finally {
    send.mockRestore()
  }
})

test('skips queued jobs and the reconcile of a closing Workspace', async () => {
  const store = new InMemoryGitHubIntegrationStore()
  await store.saveRepositoryLink({ workspaceId: WORKSPACE_ID, record: link })
  const { gateway, calls } = fakeGateway([snapshot({ number: 4 })])
  const logs: string[] = []
  const dependencies = {
    store,
    gateway,
    queue: new InMemoryGitHubSyncQueue(),
    notifications: new InMemoryGitHubNotificationSink(),
    workspaceId: WORKSPACE_ID,
    now: () => new Date('2026-11-28T05:00:00Z'),
    log: (message: string) => logs.push(message),
    isTenantActive: async () => false,
  }
  const job = { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 0, kind: 'repository' }
  expect(await createGitHubSyncQueueHandler(dependencies)({ Records: [{ messageId: 'm1', body: JSON.stringify(job) }] }))
    .toEqual({ batchItemFailures: [] })
  expect(await createGitHubReconcileHandler(dependencies, async () => true)()).toEqual({ skipped: true })
  expect(calls).toEqual([])
  expect((await store.listPullRequestSnapshots(WORKSPACE_ID)).snapshots).toEqual([])
  expect(logs).toEqual(['GitHub sync skipped a closing Workspace.', 'GitHub reconcile skipped a closing Workspace.'])
})
