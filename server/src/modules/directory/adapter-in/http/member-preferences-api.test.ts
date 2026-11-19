import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  resetTestApp,
} = createApiTestHarness()
import { afterEach, expect, test } from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/** Headers for an authenticated JSON request. */
const authenticatedJsonHeaders = {
  Authorization: 'Bearer test-token',
  'Content-Type': 'application/json',
}

test('requires authentication for member preference reads and replacements', async () => {
  const readResponse = await app.request('/api/me/preferences')
  const replaceResponse = await app.request('/api/me/preferences', {
    body: JSON.stringify({ revision: 0 }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  })

  expect(readResponse.status).toBe(401)
  expect(replaceResponse.status).toBe(401)
})

test('saves the caller\'s preferences under their own member key and reads them back', async () => {
  const calls = configureFakeProjectClients(true)

  const initial = await app.request('/api/me/preferences', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(initial.status).toBe(200)
  expect(initial.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await initial.json()).toEqual({ revision: 0 })

  const saved = await app.request('/api/me/preferences', {
    body: JSON.stringify({
      fontSize: 'compact',
      locale: 'en',
      revision: 0,
      theme: 'system',
      timeZone: 'America/New_York',
    }),
    headers: authenticatedJsonHeaders,
    method: 'PUT',
  })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toEqual({
    fontSize: 'compact',
    locale: 'en',
    revision: 1,
    theme: 'system',
    timeZone: 'America/New_York',
  })
  expect(calls.memberPreferencesReplacements).toEqual([{
    directoryId: 'user#demo@example.com',
    input: {
      fontSize: 'compact',
      locale: 'en',
      revision: 0,
      theme: 'system',
      timeZone: 'America/New_York',
    },
    memberKey: 'demo@example.com',
  }])

  const reread = await app.request('/api/me/preferences', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(await reread.json()).toMatchObject({ locale: 'en', revision: 1 })
})

test('rejects invalid preference input without saving', async () => {
  const calls = configureFakeProjectClients(true)

  for (const body of [
    { locale: 'fr', revision: 0 },
    { revision: 0, timeZone: 'Not/AZone' },
    { revision: 'one' },
    { revision: 0, theme: 'neon' },
  ]) {
    const response = await app.request('/api/me/preferences', {
      body: JSON.stringify(body),
      headers: authenticatedJsonHeaders,
      method: 'PUT',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'InvalidMemberPreferencesInput' })
  }
  expect(calls.memberPreferencesReplacements).toEqual([])
})

test('reports a stale revision as a conflict', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/me/preferences', {
    body: JSON.stringify({ locale: 'ja', revision: 3 }),
    headers: authenticatedJsonHeaders,
    method: 'PUT',
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'MemberPreferencesConflict' })
})

test('lets a guest save their own preferences', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'guest' })

  const response = await app.request('/api/me/preferences', {
    body: JSON.stringify({ locale: 'ja', revision: 0 }),
    headers: authenticatedJsonHeaders,
    method: 'PUT',
  })

  expect(response.status).toBe(200)
})
