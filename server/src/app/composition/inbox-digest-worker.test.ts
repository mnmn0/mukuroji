import { expect, test } from 'bun:test'
import { createInboxDigestRecipientAuthorization } from '../../api/api-router'
import { createApiTestHarness } from '../../api/test-support/api-test-harness'
import { InMemoryUpdateFeedDigestStore } from '../../modules/update-feed/adapter-out/digest-store'
import { createProductionInboxDigestWorkerHandler, decodeCursor } from './inbox-digest-worker'
import { handler } from '../../handlers/inbox-digest-worker-handler'

const recipient = { workspaceId: 'user#demo@example.com', memberKey: 'demo@example.com' }

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
