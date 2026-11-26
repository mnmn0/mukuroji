import { afterEach, expect, test } from 'bun:test'
import { createInMemoryDeveloperPlatformAdapters } from '../modules/developer-platform/adapter-out/in-memory/developer-platform-adapters'
import { createApiTestHarness } from './test-support/api-test-harness'

const { app, configureFakeProjectClients, resetTestApp, setTestAppDependencies } = createApiTestHarness()

/**
 * Configures the fake Workspace with one member role and an in-memory idempotency store.
 *
 * @param role - Team role of the caller.
 */
function configure(role: 'member' | 'viewer') {
  configureFakeProjectClients(true, { role })
  setTestAppDependencies({ ...createInMemoryDeveloperPlatformAdapters() })
}

afterEach(() => {
  resetTestApp()
})

/** Path of the links of the first fake Work Item. */
const linksPath = '/api/teams/core-team/issues/onboarding-friction/web-links'

/**
 * Sends a Web request for the links of the first fake Work Item.
 *
 * @param method - HTTP method.
 * @param path - Request path.
 * @param body - JSON body, if any.
 * @param idempotencyKey - Idempotency-Key header; a new key when omitted, none when null.
 * @returns The HTTP response.
 */
function send(method: string, path: string, body?: unknown, idempotencyKey: string | null = crypto.randomUUID()) {
  return app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      ...(idempotencyKey === null ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('a member adds, lists, and removes a link from the Work Item detail', async () => {
  configure('member')

  const added = await send('POST', linksPath, { url: ' https://Example.com/spec ', title: ' Spec ' })
  expect(added.status).toBe(201)
  const { link } = await added.json()
  expect(link).toMatchObject({ url: 'https://example.com/spec', title: 'Spec' })

  const duplicate = await send('POST', linksPath, { url: 'https://example.com/spec' })
  expect(duplicate.status).toBe(409)
  expect(await duplicate.json()).toMatchObject({ code: 'WorkItemWebLinkDuplicate' })

  const listed = await send('GET', linksPath)
  expect(listed.status).toBe(200)
  expect((await listed.json()).items.map((item: { id: string }) => item.id)).toEqual([link.id])

  expect((await send('DELETE', `${linksPath}/${link.id}`)).status).toBe(200)
  expect((await send('DELETE', `${linksPath}/${link.id}`)).status).toBe(404)
})

test('a retry with the same Idempotency-Key replays the first add and removal', async () => {
  configure('member')

  const addKey = crypto.randomUUID()
  const added = await send('POST', linksPath, { url: 'https://example.com/retry' }, addKey)
  expect(added.status).toBe(201)
  const first = await added.json()
  const retried = await send('POST', linksPath, { url: 'https://example.com/retry' }, addKey)
  expect(retried.status).toBe(201)
  expect(retried.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await retried.json()).toEqual(first)

  const reused = await send('POST', linksPath, { url: 'https://example.com/other' }, addKey)
  expect(reused.status).toBe(409)
  expect(await reused.json()).toMatchObject({ code: 'WorkItemWebLinkIdempotencyConflict' })

  const removeKey = crypto.randomUUID()
  expect((await send('DELETE', `${linksPath}/${first.link.id}`, undefined, removeKey)).status).toBe(200)
  const retriedRemoval = await send('DELETE', `${linksPath}/${first.link.id}`, undefined, removeKey)
  expect(retriedRemoval.status).toBe(200)
  expect(retriedRemoval.headers.get('Idempotency-Replayed')).toBe('true')

  const listed = await (await send('GET', linksPath)).json()
  expect(listed.items).toEqual([])
})

test('a change without an Idempotency-Key is rejected', async () => {
  configure('member')

  const response = await send('POST', linksPath, { url: 'https://example.com/' }, null)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'InvalidWorkItemWebLinkIdempotencyKey' })
})

test('rejects unsafe URLs and malformed link IDs', async () => {
  configure('member')

  for (const url of ['javascript:alert(1)', 'https://user:secret@example.com/', 'ftp://example.com/file']) {
    const response = await send('POST', linksPath, { url })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'InvalidWorkItemWebLink' })
  }
  expect((await send('DELETE', `${linksPath}/not-a-link`)).status).toBe(400)
})

test('a viewer can list the links but not change them', async () => {
  configure('viewer')

  expect((await send('GET', linksPath)).status).toBe(200)
  expect((await send('POST', linksPath, { url: 'https://example.com/' })).status).toBe(403)
})
