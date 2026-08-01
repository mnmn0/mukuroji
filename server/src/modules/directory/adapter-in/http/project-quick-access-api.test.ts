import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  resetTestApp,
} = createApiTestHarness()
import {
  afterEach,
  expect,
  test,
} from 'bun:test'
import {
  PROJECT_QUICK_ACCESS_MAX_ITEMS,
  PROJECT_QUICK_ACCESS_MAX_REVISION,
} from '@mukuroji/contracts'

afterEach(() => {
  resetTestApp()
})

/**
 * Creates headers for an authenticated JSON quick-access request.
 *
 * @returns Bearer authentication and JSON content headers.
 */
function authenticatedJsonHeaders() {
  return {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }
}

test('requires authentication for Project quick-access reads and replacements', async () => {
  const readResponse = await app.request('/api/projects/quick-access')
  const replaceResponse = await app.request('/api/projects/quick-access', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [], revision: 0 }),
  })

  expect(readResponse.status).toBe(401)
  expect(await readResponse.json()).toEqual({ message: 'Bearer token is required.' })
  expect(replaceResponse.status).toBe(401)
  expect(await replaceResponse.json()).toEqual({ message: 'Bearer token is required.' })
})

test('returns only accessible quick-access Projects without changing their stored order', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
    projectQuickAccessPreference: {
      items: [
        { projectId: 'private-project', teamId: 'core-team' },
        { projectId: 'refero', teamId: 'core-team' },
      ],
      revision: 4,
    },
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private project', tone: 'purple' },
    ],
  })

  const response = await app.request('/api/projects/quick-access', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    items: [{ projectId: 'refero', teamId: 'core-team' }],
    revision: 4,
  })
  expect(calls.projectQuickAccessReads).toEqual([{
    consistentRead: true,
    directoryId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
  }])
  expect(calls.directoryReads).toEqual([{
    consistentRead: true,
    directoryId: 'user#demo@example.com',
    locale: 'ja',
  }])
})

test('rejects malformed complete quick-access replacements before persistence', async () => {
  const calls = configureFakeProjectClients(true)
  const invalidBodies = [
    { items: [], revision: -1 },
    { items: [], revision: PROJECT_QUICK_ACCESS_MAX_REVISION },
    { items: [], revision: Number.MAX_SAFE_INTEGER },
    {
      items: [{ projectId: 'project/with/slash', teamId: 'core-team' }],
      revision: 0,
    },
    {
      items: [{ projectId: ' refero', teamId: 'core-team' }],
      revision: 0,
    },
    {
      items: [
        { projectId: 'refero', teamId: 'core-team' },
        { projectId: 'refero', teamId: 'core-team' },
      ],
      revision: 0,
    },
    {
      items: Array.from({ length: PROJECT_QUICK_ACCESS_MAX_ITEMS + 1 }, (_, index) => ({
        projectId: `project-${index}`,
        teamId: 'core-team',
      })),
      revision: 0,
    },
  ]

  for (const body of invalidBodies) {
    const response = await app.request('/api/projects/quick-access', {
      method: 'PUT',
      headers: authenticatedJsonHeaders(),
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      code: 'InvalidProjectQuickAccessInput',
      message: 'Project quick-access input is invalid.',
    })
  }
  expect(calls.projectQuickAccessReplacements).toEqual([])
})

test('rejects quick-access references outside the authenticated Project access list', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private project', tone: 'purple' },
    ],
  })

  const response = await app.request('/api/projects/quick-access', {
    method: 'PUT',
    headers: authenticatedJsonHeaders(),
    body: JSON.stringify({
      items: [{ projectId: 'private-project', teamId: 'core-team' }],
      revision: 0,
    }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.projectQuickAccessReplacements).toEqual([])
})

test('binds duplicated Project IDs to their owner Team despite ambiguous bare access', async () => {
  const calls = configureFakeProjectClients(true, {
    additionalTeams: [{
      id: 'design-team',
      name: 'Design Team',
      projects: [{ id: 'shared-project', name: 'Shared design', tone: 'purple' }],
    }],
    projectAccesses: [
      {
        projectId: 'shared-project',
        role: 'viewer',
        teamId: 'core-team',
      },
      {
        projectId: 'shared-project',
        role: 'viewer',
      },
    ],
    projectQuickAccessPreference: {
      items: [{ projectId: 'shared-project', teamId: 'design-team' }],
      revision: 4,
    },
    teamProjects: [{ id: 'shared-project', name: 'Shared core', tone: 'blue' }],
  })

  const readResponse = await app.request('/api/projects/quick-access', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const deniedReplaceResponse = await app.request('/api/projects/quick-access', {
    method: 'PUT',
    headers: authenticatedJsonHeaders(),
    body: JSON.stringify({
      items: [{ projectId: 'shared-project', teamId: 'design-team' }],
      revision: 4,
    }),
  })
  const allowedReplaceResponse = await app.request('/api/projects/quick-access', {
    method: 'PUT',
    headers: authenticatedJsonHeaders(),
    body: JSON.stringify({
      items: [{ projectId: 'shared-project', teamId: 'core-team' }],
      revision: 4,
    }),
  })

  expect(readResponse.status).toBe(200)
  expect(await readResponse.json()).toEqual({ items: [], revision: 4 })
  expect(deniedReplaceResponse.status).toBe(403)
  expect(allowedReplaceResponse.status).toBe(200)
  expect(await allowedReplaceResponse.json()).toEqual({
    items: [{ projectId: 'shared-project', teamId: 'core-team' }],
    revision: 5,
  })
  expect(calls.projectQuickAccessReplacements).toEqual([{
    directoryId: 'user#demo@example.com',
    input: {
      items: [{ projectId: 'shared-project', teamId: 'core-team' }],
      revision: 4,
    },
    memberKey: 'demo@example.com',
  }])
})

test('accepts the same Project ID from distinct authorized Teams', async () => {
  const calls = configureFakeProjectClients(true, {
    additionalTeams: [{
      id: 'design-team',
      name: 'Design Team',
      projects: [{ id: 'shared-project', name: 'Shared design', tone: 'purple' }],
    }],
    projectAccesses: [
      {
        projectId: 'shared-project',
        role: 'viewer',
        teamId: 'core-team',
      },
      {
        projectId: 'shared-project',
        role: 'viewer',
        teamId: 'design-team',
      },
    ],
    teamProjects: [{ id: 'shared-project', name: 'Shared core', tone: 'blue' }],
  })
  const items = [
    { projectId: 'shared-project', teamId: 'core-team' },
    { projectId: 'shared-project', teamId: 'design-team' },
  ]

  const response = await app.request('/api/projects/quick-access', {
    method: 'PUT',
    headers: authenticatedJsonHeaders(),
    body: JSON.stringify({ items, revision: 0 }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ items, revision: 1 })
  expect(calls.projectQuickAccessReplacements).toEqual([{
    directoryId: 'user#demo@example.com',
    input: { items, revision: 0 },
    memberKey: 'demo@example.com',
  }])
})

test('replaces and returns the complete quick-access order for the authenticated member', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [
      { projectId: 'refero', role: 'viewer' },
      { projectId: 'mobile-app', role: 'member' },
    ],
    projectQuickAccessPreference: {
      items: [{ projectId: 'refero', teamId: 'core-team' }],
      revision: 6,
    },
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'mobile-app', name: 'Mobile app', tone: 'green' },
    ],
  })
  const items = [
    { projectId: 'mobile-app', teamId: 'core-team' },
    { projectId: 'refero', teamId: 'core-team' },
  ]

  const replaceResponse = await app.request('/api/projects/quick-access', {
    method: 'PUT',
    headers: authenticatedJsonHeaders(),
    body: JSON.stringify({ items, revision: 6 }),
  })
  const readResponse = await app.request('/api/projects/quick-access', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(replaceResponse.status).toBe(200)
  expect(await replaceResponse.json()).toEqual({ items, revision: 7 })
  expect(readResponse.status).toBe(200)
  expect(await readResponse.json()).toEqual({ items, revision: 7 })
  expect(calls.projectQuickAccessReplacements).toEqual([{
    directoryId: 'user#demo@example.com',
    input: { items, revision: 6 },
    memberKey: 'demo@example.com',
  }])
  expect(calls.projectQuickAccessReads).toEqual([{
    consistentRead: true,
    directoryId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
  }])
  expect(calls.directoryReads).toEqual([
    {
      consistentRead: true,
      directoryId: 'user#demo@example.com',
      locale: 'ja',
    },
    {
      consistentRead: true,
      directoryId: 'user#demo@example.com',
      locale: 'ja',
    },
  ])
})
