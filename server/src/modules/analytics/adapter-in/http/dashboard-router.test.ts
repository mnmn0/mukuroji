import { describe, expect, test } from 'bun:test'
import type { Context } from 'hono'
import { createDashboardRouter } from './dashboard-router'

describe('createDashboardRouter', () => {
  test('keeps summary dependencies isolated between router instances', async () => {
    const first = createDashboardRouter(createDependencies('first'))
    const second = createDashboardRouter(createDependencies('second'))

    const [firstResponse, secondResponse] = await Promise.all([
      first.request('/api/dashboard/summary', {
        headers: { Authorization: 'Bearer token-1' },
      }),
      second.request('/api/dashboard/summary', {
        headers: { Authorization: 'Bearer token-2' },
      }),
    ])

    expect(await firstResponse.json()).toEqual({ marker: 'first' })
    expect(await secondResponse.json()).toEqual({ marker: 'second' })
  })

  test('preserves the missing bearer response', async () => {
    const response = await createDashboardRouter(createDependencies('unused'))
      .request('/api/dashboard/summary')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Bearer token is required.' })
  })

  test('passes resolved Project access only for non-system administrators', async () => {
    const accesses: unknown[] = []
    let resolverCalls = 0
    const dependencies = {
      ...createDependencies('acl'),
      async authenticate(accessToken: string) {
        return {
          directoryId: 'workspace-1',
          userKey: 'member-1',
          isSystemAdmin: accessToken === 'admin',
        }
      },
      async getProjectAccesses() {
        resolverCalls += 1
        return [{ projectId: 'project-1' }]
      },
      async getSummary(_workspaceId: string, access: unknown) {
        accesses.push(access)
        return { marker: 'acl' }
      },
    }
    const router = createDashboardRouter(dependencies)

    await router.request('/api/dashboard/summary', {
      headers: { Authorization: 'Bearer member' },
    })
    await router.request('/api/dashboard/summary', {
      headers: { Authorization: 'Bearer admin' },
    })

    expect(resolverCalls).toBe(1)
    expect(accesses).toEqual([
      {
        userKey: 'member-1',
        isSystemAdmin: false,
        projectAccesses: [{ projectId: 'project-1' }],
      },
      {
        userKey: 'member-1',
        isSystemAdmin: true,
      },
    ])
  })

  test('keeps authentication and Project data error mapping separate', async () => {
    const authenticationError = new Error('authentication')
    const projectError = new Error('project')
    const authenticationRouter = createDashboardRouter({
      ...createDependencies('errors'),
      async authenticate() {
        throw authenticationError
      },
      isAuthenticationError(error: unknown) {
        return error === authenticationError
      },
    })
    const projectRouter = createDashboardRouter({
      ...createDependencies('errors'),
      async getSummary() {
        throw projectError
      },
    })

    const authenticationResponse = await authenticationRouter.request(
      '/api/dashboard/summary',
      { headers: { Authorization: 'Bearer token' } },
    )
    const projectResponse = await projectRouter.request(
      '/api/dashboard/summary',
      { headers: { Authorization: 'Bearer token' } },
    )

    expect(authenticationResponse.status).toBe(401)
    expect(await authenticationResponse.json()).toEqual({
      message: 'Authentication failed.',
    })
    expect(projectResponse.status).toBe(502)
    expect(await projectResponse.json()).toEqual({
      message: 'Project data is unavailable.',
    })
  })
})

function createDependencies(marker: string) {
  return {
    async authenticate() {
      return {
        directoryId: 'workspace-1',
        userKey: 'member-1',
        isSystemAdmin: false,
      }
    },
    async getProjectAccesses() {
      return [{ projectId: 'project-1' }]
    },
    async getSummary() {
      return { marker }
    },
    isAuthenticationError() {
      return false
    },
    mapAuthenticationError(context: Context) {
      return context.json({ message: 'Authentication failed.' }, 401)
    },
    mapProjectDataError(context: Context) {
      return context.json({ message: 'Project data is unavailable.' }, 502)
    },
  }
}
