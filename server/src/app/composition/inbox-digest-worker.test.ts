import { expect, test } from 'bun:test'
import { createInboxDigestRecipientAuthorization } from '../../api/api-router'
import { createApiTestHarness } from '../../api/test-support/api-test-harness'
import { InMemoryUpdateFeedDigestStore } from '../../modules/update-feed/adapter-out/digest-store'
import { createProductionInboxDigestWorkerHandler, decodeCursor } from './inbox-digest-worker'
import { handler } from '../../handlers/inbox-digest-worker-handler'
import { createInboxDigestAppDependencies } from './inbox-digest-dependencies'

const recipient = { workspaceId: 'user#demo@example.com', memberKey: 'demo@example.com' }

test('enabled production worker bootstraps with only its resources and rejects missing authorization resources', () => {
  const resources = ['PLANNING_TABLE_NAME', 'NOTIFICATIONS_TABLE_NAME', 'ENTERPRISE_IDENTITY_TABLE_NAME', 'TENANT_ADMINISTRATION_TABLE_NAME', 'WORKSPACE_ACCESS_TABLE_NAME', 'PROJECT_DIRECTORY_TABLE_NAME', 'COLLABORATION_TABLE_NAME', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID']
  const unrelated = ['ANALYTICS_TABLE_NAME', 'TIME_TRACKING_TABLE_NAME', 'WORK_ITEM_IMPORT_BUCKET_NAME', 'WORK_ITEM_IMPORT_QUEUE_URL', 'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY', 'PUBLIC_API_CURSOR_SECRET', 'ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET']
  const keys = [...resources, ...unrelated, 'NODE_ENV', 'AWS_LAMBDA_FUNCTION_NAME', 'INBOX_DIGEST_WORKER_ENABLED']
  const before = new Map(keys.map((key) => [key, process.env[key]]))
  try {
    for (const key of resources) process.env[key] = 'isolated-test-resource'
    for (const key of unrelated) delete process.env[key]
    process.env.NODE_ENV = 'production'
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'isolated-digest-worker'
    process.env.INBOX_DIGEST_WORKER_ENABLED = 'true'
    // Construction only: no enabled handler is invoked and no AWS operation occurs.
    expect(typeof createProductionInboxDigestWorkerHandler()).toBe('function')
    const graph = createInboxDigestAppDependencies('isolated-test-resource', 'isolated-test-resource')
    expect(() => Reflect.get(graph.workItems.analytics, 'query')).toThrow('Capability is unavailable')
    expect(() => Reflect.get(graph.timeTracking.timeTrackingService, 'query')).toThrow('Capability is unavailable')
    for (const key of resources) {
      delete process.env[key]
      expect(() => createProductionInboxDigestWorkerHandler()).toThrow('resources are not configured')
      process.env[key] = 'isolated-test-resource'
    }
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('persisted cursor decoding rejects malformed continuations with a typed nonreflective error', () => {
  const key = { workspaceId: 'workspace', recordKey: 'UPDATE_FEED_INBOX_DIGEST#hash', inboxDigestShard: 'inbox-digest#2', inboxDigestDueAt: 123 }
  expect(decodeCursor(undefined, 2)).toBeUndefined()
  expect(decodeCursor(JSON.stringify({ ...key, ignored: 'not forwarded' }), 2)).toEqual(key)
  for (const cursor of ['private malformed JSON', 'x'.repeat(4097), 'null', JSON.stringify({ ...key, workspaceId: '' }), JSON.stringify({ ...key, inboxDigestShard: 'inbox-digest#3' }), JSON.stringify({ ...key, inboxDigestDueAt: -1 })]) {
    try { decodeCursor(cursor, 2); throw new Error('Expected rejection') } catch (error) {
      expect(error).toMatchObject({ status: 502, code: 'UpdateFeedDigestCorruptState', message: 'Inbox digest continuation is unavailable.' })
    }
  }
})

test('disabled worker and entrypoint perform no resource initialization', async () => {
  const prior = process.env.INBOX_DIGEST_WORKER_ENABLED
  delete process.env.INBOX_DIGEST_WORKER_ENABLED
  try {
    expect(await createProductionInboxDigestWorkerHandler()()).toEqual({ processed: 0, delivered: 0, failed: 0, disabled: true })
    expect(await handler()).toEqual({ processed: 0, delivered: 0, failed: 0, disabled: true })
  } finally {
    if (prior === undefined) delete process.env.INBOX_DIGEST_WORKER_ENABLED
    else process.env.INBOX_DIGEST_WORKER_ENABLED = prior
  }
})

test('background authorization reuses current membership and tenant checks on every recipient', async () => {
  const h = createApiTestHarness()
  h.configureFakeProjectClients(true)
  const metadata = new InMemoryUpdateFeedDigestStore()
  let active = true
  let bound = 0
  const authorization = createInboxDigestRecipientAuthorization((_recipient, checks) => {
    expect(checks.length).toBeGreaterThan(0)
    bound++
    return {
      get: (...args) => metadata.get(...args),
      replace: (workspaceId, memberKey, state) => metadata.replace(workspaceId, memberKey, state),
      complete: async () => { throw new Error('Authorization test must never deliver') },
    }
  }, async () => active)
  await h.runWithTestAppDependencies(async () => {
    const allowed = await authorization.authorize(recipient)
    expect(allowed?.recipient).toEqual(recipient)
    expect(allowed?.reader.memberKey).toBe(recipient.memberKey)
    expect(allowed?.authorizationRevision).toBe(0)
    active = false
    expect(await authorization.authorize(recipient)).toBeUndefined()
  })
  active = true
  h.configureFakeProjectClients(true, { workspaceRole: 'guest' })
  expect(await h.runWithTestAppDependencies(() => authorization.authorize(recipient))).toBeUndefined()
  h.configureFakeProjectClients(true, { workspaceStatus: 'deactivated' })
  expect(await h.runWithTestAppDependencies(() => authorization.authorize(recipient))).toBeUndefined()
  h.configureFakeProjectClients(true, { cognitoUserGroupsError: new Error('Current groups unavailable') })
  await expect(h.runWithTestAppDependencies(() => authorization.authorize(recipient))).rejects.toThrow('Current groups unavailable')
  expect(bound).toBe(1)
})
