import type { GitHubPullRequestInboxResponse, GitHubRepositoryLinkListResponse } from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import type { GitHubAppCredentialSource, GitHubAppGateway } from '../../application/ports'
import { InMemoryGitHubIntegrationStore } from '../../adapter-out/dynamodb/github-integration-store'
import { InMemoryGitHubSyncQueue } from '../../adapter-out/sqs/github-sync-queue'
import { parseGitHubPullRequestNode } from '../../domain/pull-request-snapshot'
import { signGitHubWebhookBody } from '../../domain/webhook-signature'

const { app, configureFakeProjectClients, resetTestApp, setTestAppDependencies } = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Workspace of the fake signed-in member. */
const WORKSPACE_ID = 'user#demo@example.com'

/** Webhook secret of the fake App. */
const WEBHOOK_SECRET = 'webhook-secret-of-at-least-20-characters'

/**
 * Installs in-memory GitHub adapters, with or without a configured App.
 *
 * @param configured - Whether the App is configured.
 * @returns The in-memory store and queue.
 */
function installGitHub(configured: boolean): { store: InMemoryGitHubIntegrationStore, queue: InMemoryGitHubSyncQueue } {
  const credentials: GitHubAppCredentialSource = {
    async read() {
      return configured ? { appId: '1', privateKey: 'unused', webhookSecrets: [WEBHOOK_SECRET] } : null
    },
  }
  const gateway: GitHubAppGateway = {
    async listRepositories() {
      return { repositories: [{ installationId: '7', repositoryId: '42', repository: 'acme/app', private: true }], incomplete: false }
    },
    async readRepositoryName() {
      return 'acme/app'
    },
    async readPullRequests() {
      return { snapshots: [], missing: [] }
    },
    async readCommitPullRequests() {
      return []
    },
    async readOpenPullRequests() {
      return { snapshots: [], incomplete: false }
    },
  }
  const store = new InMemoryGitHubIntegrationStore()
  const queue = new InMemoryGitHubSyncQueue()
  setTestAppDependencies({ githubIntegration: { workspaceId: WORKSPACE_ID, store, credentials, gateway, queue } })
  return { store, queue }
}

/**
 * Sends a request signed in as the fake member.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body, if any.
 * @returns The response.
 */
function request(path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Sends a webhook delivery.
 *
 * @param event - `X-GitHub-Event`.
 * @param body - Body text.
 * @param signature - Signature header; a valid one when omitted.
 * @returns The response.
 */
function deliver(event: string, body: string, signature?: string) {
  return app.request('/api/integrations/github/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': '00000000-0000-4000-8000-000000000000',
      'X-Hub-Signature-256': signature ?? signGitHubWebhookBody(WEBHOOK_SECRET, new TextEncoder().encode(body)),
    },
    body,
  })
}

test('answers 404 to webhooks while no GitHub App is configured', async () => {
  installGitHub(false)
  const response = await deliver('ping', '{}')
  expect(response.status).toBe(404)
})

test('refuses an unsigned webhook and queues a signed one', async () => {
  const integration = installGitHub(true)
  const body = JSON.stringify({ installation: { id: 7 }, repository: { id: 42, full_name: 'acme/app' }, number: 5, pull_request: { number: 5 } })
  expect((await deliver('pull_request', body, 'sha256=' + '0'.repeat(64))).status).toBe(401)
  expect((await deliver('ping', '{}')).status).toBe(200)
  expect((await deliver('pull_request', body)).status).toBe(202)
  expect(integration.queue.sent.map((sent) => sent.job)).toEqual([
    { installationId: '7', repositoryId: '42', repository: 'acme/app', attempt: 0, kind: 'pull-requests', numbers: [5] },
  ])
})

test('lets an administrator link a repository and a member read their review inbox', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'owner', projectAccesses: [{ projectId: 'refero', role: 'viewer' }] })
  const integration = installGitHub(true)

  const listed = await request('/api/workspace/github/repositories')
  expect(listed.status).toBe(200)
  expect(await listed.json() as GitHubRepositoryLinkListResponse).toEqual({
    configured: true,
    repositories: [{ installationId: '7', repositoryId: '42', repository: 'acme/app', private: true }],
  })
  expect((await request('/api/workspace/github/repositories/42', 'PUT', { teamId: 'missing-team' })).status).toBe(404)
  const linked = await request('/api/workspace/github/repositories/42', 'PUT', { teamId: 'core-team' })
  expect(linked.status).toBe(200)
  expect(await linked.json()).toMatchObject({ repositoryId: '42', teamId: 'core-team', revision: 1 })

  await integration.store.putPullRequestSnapshot(WORKSPACE_ID, parseGitHubPullRequestNode({
    number: 5,
    title: 'Review me',
    url: 'https://github.com/acme/app/pull/5',
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: new Date().toISOString(),
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: 'a'.repeat(40),
    mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    baseRepository: { databaseId: 42, nameWithOwner: 'acme/app' },
    author: { login: 'alice' },
    reviewRequests: { nodes: [{ requestedReviewer: { login: 'demo-user' } }] },
    latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [] },
  }, { repositoryId: '42' }, new Date().toISOString()))

  const before = await request('/api/me/pull-requests?view=to-review')
  expect(await before.json() as GitHubPullRequestInboxResponse).toEqual({ configured: true, view: 'to-review', items: [] })
  expect((await request('/api/me/github-login', 'PUT', { githubLogin: 'not a login' })).status).toBe(400)
  expect(await (await request('/api/me/github-login', 'PUT', { githubLogin: 'demo-user' })).json()).toEqual({ githubLogin: 'demo-user' })
  const inbox = await request('/api/me/pull-requests?view=to-review')
  expect(inbox.status).toBe(200)
  expect(await inbox.json() as GitHubPullRequestInboxResponse).toMatchObject({
    configured: true,
    githubLogin: 'demo-user',
    items: [{ number: 5, teamId: 'core-team', section: 'open', title: 'Review me' }],
  })
  expect((await request('/api/me/pull-requests?view=everything')).status).toBe(400)

  expect((await request('/api/workspace/github/repositories/42?expectedRevision=2', 'DELETE')).status).toBe(409)
  expect((await request('/api/workspace/github/repositories/42?expectedRevision=1', 'DELETE')).status).toBe(204)
  const afterUnlink = await request('/api/me/pull-requests?view=to-review')
  expect((await afterUnlink.json() as GitHubPullRequestInboxResponse).items).toEqual([])
})

test('keeps repository links to Workspace administrators', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member', projectAccesses: [{ projectId: 'refero', role: 'viewer' }] })
  installGitHub(true)
  expect((await request('/api/workspace/github/repositories')).status).toBe(403)
  expect((await request('/api/workspace/github/repositories/42', 'PUT', { teamId: 'core-team' })).status).toBe(403)
})
