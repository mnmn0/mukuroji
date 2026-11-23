import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from './test-support/api-test-harness'

const { app, configureFakeProjectClients, resetTestApp } = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/** Sends a prefix change for the core Team. */
function putPrefix(body: unknown) {
  return app.request('/api/teams/core-team/work-item-key-prefix', {
    method: 'PUT',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('shows the suggested prefix of a Team without one and its current prefix once set', async () => {
  configureFakeProjectClients(true, {
    teamWorkItemKeyPrefixes: {
      'other-team': { keyPrefix: 'OT', lastNumber: 4, previousPrefixes: ['OLD'] },
    },
  })

  const response = await app.request('/api/teams/core-team/work-item-key-prefix', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teamId: 'core-team',
    suggestedKeyPrefix: 'CT',
    previousPrefixes: [],
    lastNumber: 0,
    canManage: true,
  })
})

test('lets a Team manager change the prefix, fenced by authorization checks and audited', async () => {
  const calls = configureFakeProjectClients(true, {
    teamWorkItemKeyPrefixes: {
      'core-team': { keyPrefix: 'CT', lastNumber: 7, previousPrefixes: [] },
    },
  })

  const response = await putPrefix({ keyPrefix: ' core ', expectedKeyPrefix: 'CT' })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teamId: 'core-team',
    keyPrefix: 'CORE',
    previousPrefixes: ['CT'],
    lastNumber: 7,
    canManage: true,
  })
  expect(calls.keyPrefixChanges).toEqual([expect.objectContaining({
    teamId: 'core-team',
    keyPrefix: 'CORE',
    expectedKeyPrefix: 'CT',
  })])

  const reread = await app.request('/api/teams/core-team/work-item-key-prefix', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(await reread.json()).toEqual({
    teamId: 'core-team',
    keyPrefix: 'CORE',
    previousPrefixes: ['CT'],
    lastNumber: 7,
    canManage: true,
  })
})

test.each([
  ['a prefix that does not start with a letter', { keyPrefix: '1AB', expectedKeyPrefix: null }],
  ['a one-letter prefix', { keyPrefix: 'A', expectedKeyPrefix: null }],
  ['a prefix with a separator', { keyPrefix: 'AB-C', expectedKeyPrefix: null }],
  ['a missing expected prefix', { keyPrefix: 'ABC' }],
])('rejects %s', async (_case, body) => {
  const calls = configureFakeProjectClients(true)

  const response = await putPrefix(body)

  expect(response.status).toBe(400)
  expect(calls.keyPrefixChanges).toEqual([])
})

test('refuses a prefix change from a Team member who does not manage the Team', async () => {
  const calls = configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })

  const response = await putPrefix({ keyPrefix: 'ABC', expectedKeyPrefix: null })

  expect(response.status).toBe(403)
  expect(calls.keyPrefixChanges).toEqual([])
  const read = await app.request('/api/teams/core-team/work-item-key-prefix', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(read.status).toBe(200)
  expect((await read.json()).canManage).toBe(false)
})

test('requires a bearer token', async () => {
  configureFakeProjectClients(true)

  expect((await app.request('/api/teams/core-team/work-item-key-prefix')).status).toBe(401)
})
