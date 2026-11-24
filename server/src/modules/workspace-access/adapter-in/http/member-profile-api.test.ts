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

test('requires authentication for the own profile', async () => {
  const readResponse = await app.request('/api/me/profile')
  const updateResponse = await app.request('/api/me/profile', {
    body: JSON.stringify({ name: 'New', expectedVersion: 1 }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  })

  expect(readResponse.status).toBe(401)
  expect(updateResponse.status).toBe(401)
})

test('reads the caller\'s own profile', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member' })

  const response = await app.request('/api/me/profile', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({
    profile: {
      memberKey: 'demo@example.com',
      email: 'demo@example.com',
      name: 'Demo User',
      nameEditable: true,
      version: 1,
    },
  })
})

test('lets a member rename themselves under their own member key', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })

  const response = await app.request('/api/me/profile', {
    body: JSON.stringify({ name: '  デモ 太郎 ', expectedVersion: 1 }),
    headers: authenticatedJsonHeaders,
    method: 'PUT',
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    profile: { memberKey: 'demo@example.com', name: 'デモ 太郎', version: 2 },
  })
  expect(calls.workspaceMemberNameUpdates).toEqual([{
    actorMemberKey: 'demo@example.com',
    memberKey: 'demo@example.com',
    expectedVersion: 1,
    name: 'デモ 太郎',
  }])
})

test('rejects a name that is too long, has control characters, or is not a string', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })

  for (const name of ['a'.repeat(129), 'Line\nbreak', 42]) {
    const response = await app.request('/api/me/profile', {
      body: JSON.stringify({ name, expectedVersion: 1 }),
      headers: authenticatedJsonHeaders,
      method: 'PUT',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'InvalidWorkspaceMemberName' })
  }
  const missingVersion = await app.request('/api/me/profile', {
    body: JSON.stringify({ name: 'Valid' }),
    headers: authenticatedJsonHeaders,
    method: 'PUT',
  })
  expect(missingVersion.status).toBe(400)
  expect(calls.workspaceMemberNameUpdates).toEqual([])
})

test('lets an administrator correct another member\'s name', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'admin' })

  const response = await app.request('/api/workspace/members/sato%40example.com/name', {
    body: JSON.stringify({ name: 'Sato', expectedVersion: 1 }),
    headers: authenticatedJsonHeaders,
    method: 'PUT',
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    member: { memberKey: 'sato@example.com', name: 'Sato', version: 2 },
  })
  expect(calls.workspaceMemberNameUpdates).toEqual([{
    actorMemberKey: 'demo@example.com',
    memberKey: 'sato@example.com',
    expectedVersion: 1,
    name: 'Sato',
  }])
})

test('refuses a member correcting another member\'s name', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })

  const response = await app.request('/api/workspace/members/sato%40example.com/name', {
    body: JSON.stringify({ name: 'Sato', expectedVersion: 1 }),
    headers: authenticatedJsonHeaders,
    method: 'PUT',
  })

  expect(response.status).toBe(403)
  expect(calls.workspaceMemberNameUpdates).toEqual([])
})
