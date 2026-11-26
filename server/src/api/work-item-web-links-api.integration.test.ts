import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from './test-support/api-test-harness'

const { app, configureFakeProjectClients, resetTestApp } = createApiTestHarness()

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
 * @returns The HTTP response.
 */
function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('a member adds, lists, and removes a link from the Work Item detail', async () => {
  configureFakeProjectClients(true, { role: 'member' })

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

test('rejects unsafe URLs and malformed link IDs', async () => {
  configureFakeProjectClients(true, { role: 'member' })

  for (const url of ['javascript:alert(1)', 'https://user:secret@example.com/', 'ftp://example.com/file']) {
    const response = await send('POST', linksPath, { url })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'InvalidWorkItemWebLink' })
  }
  expect((await send('DELETE', `${linksPath}/not-a-link`)).status).toBe(400)
})

test('a viewer can list the links but not change them', async () => {
  configureFakeProjectClients(true, { role: 'viewer' })

  expect((await send('GET', linksPath)).status).toBe(200)
  expect((await send('POST', linksPath, { url: 'https://example.com/' })).status).toBe(403)
})
