import { describe, expect, test } from 'bun:test'
import type {
  ResolvedWorkItemConfiguration,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  createWorkItemConfigurationRouter,
  type WorkItemConfigurationRouterDependencies,
} from './work-item-configuration-router'
import type { WorkItemConfigurationClient } from '../../work-item-configuration'

const principal = { directoryId: 'workspace-1' }

const configuration = {
  scopeType: 'workspace',
  scopeId: 'workspace-1',
  revision: 3,
} as unknown as WorkItemConfiguration

const resolvedConfiguration = {
  configuration,
} as unknown as ResolvedWorkItemConfiguration

function createDependencies(
  overrides: Partial<WorkItemConfigurationRouterDependencies<typeof principal>> = {},
) {
  const calls: Array<{ operation: string; value: unknown }> = []
  const requestClient = {
    async getWorkspaceConfiguration(workspaceId: string) {
      calls.push({ operation: 'getWorkspaceConfiguration', value: workspaceId })
      return resolvedConfiguration
    },
    async saveWorkspaceConfiguration(
      workspaceId: string,
      value: WorkItemConfiguration,
      usageCheck: () => Promise<void>,
    ) {
      calls.push({ operation: 'saveWorkspaceConfiguration', value: { workspaceId, value } })
      await usageCheck()
      return resolvedConfiguration
    },
    async getTeamConfiguration(workspaceId: string, teamId: string) {
      calls.push({ operation: 'getTeamConfiguration', value: { workspaceId, teamId } })
      return resolvedConfiguration
    },
    async saveTeamConfiguration(
      workspaceId: string,
      teamId: string,
      value: WorkItemConfiguration,
      usageCheck: () => Promise<void>,
    ) {
      calls.push({ operation: 'saveTeamConfiguration', value: { workspaceId, teamId, value } })
      await usageCheck()
      return resolvedConfiguration
    },
  } as unknown as WorkItemConfigurationClient
  const dependencies: WorkItemConfigurationRouterDependencies<typeof principal> = {
    workItemConfigurations: requestClient,
    readBearerAccessToken: (context) =>
      context.req.header('Authorization')?.replace(/^Bearer /u, ''),
    async authenticate(accessToken, context) {
      calls.push({ operation: 'authenticate', value: { accessToken, context } })
      return principal
    },
    requireWorkspaceAdministration(value) {
      calls.push({ operation: 'requireWorkspaceAdministration', value })
    },
    requireWorkspaceBusinessWrite(value) {
      calls.push({ operation: 'requireWorkspaceBusinessWrite', value })
    },
    async requireTeamPermission(value, teamId, minimum) {
      calls.push({ operation: 'requireTeamPermission', value: { value, teamId, minimum } })
    },
    async requireTeamConfigurationAdministration(value, teamId) {
      calls.push({ operation: 'requireTeamConfigurationAdministration', value: { value, teamId } })
    },
    readJson: async (request) => await request.json(),
    validateConfiguration(value, expectedScope) {
      calls.push({ operation: 'validateConfiguration', value: { value, expectedScope } })
      return value as WorkItemConfiguration
    },
    async validateReferences(workspaceId, value, teamId) {
      calls.push({ operation: 'validateReferences', value: { workspaceId, value, teamId } })
    },
    async validateUsage(workspaceId, value, teamId) {
      calls.push({ operation: 'validateUsage', value: { workspaceId, value, teamId } })
    },
    mapError: (context) => context.json({ code: 'mapped' }, 503),
    ...overrides,
  }

  return { calls, router: createWorkItemConfigurationRouter(dependencies) }
}

describe('work item configuration router', () => {
  test('authenticates and forwards workspace configuration reads and writes', async () => {
    const { calls, router } = createDependencies()
    const readResponse = await router.request('/api/work-item-configuration', {
      headers: { Authorization: 'Bearer workspace-token' },
    })
    const writeResponse = await router.request('/api/work-item-configuration', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer workspace-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ revision: 3 }),
    })

    expect(readResponse.status).toBe(200)
    expect(writeResponse.status).toBe(200)
    expect(calls.find(({ operation }) => operation === 'getWorkspaceConfiguration')?.value)
      .toBe('workspace-1')
    expect(calls.find(({ operation }) => operation === 'saveWorkspaceConfiguration')?.value)
      .toMatchObject({ workspaceId: 'workspace-1', value: { scopeType: 'workspace', scopeId: 'workspace-1' } })
    expect(calls.map(({ operation }) => operation)).toEqual([
      'authenticate',
      'getWorkspaceConfiguration',
      'authenticate',
      'requireWorkspaceAdministration',
      'validateConfiguration',
      'saveWorkspaceConfiguration',
      'validateReferences',
      'validateUsage',
    ])
  })

  test('enforces Team permissions and forwards Team-scoped configuration', async () => {
    const { calls, router } = createDependencies()
    const readResponse = await router.request('/api/teams/team-1/work-item-configuration', {
      headers: { Authorization: 'Bearer workspace-token' },
    })
    const writeResponse = await router.request('/api/teams/team-1/work-item-configuration', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer workspace-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ revision: 3 }),
    })

    expect(readResponse.status).toBe(200)
    expect(writeResponse.status).toBe(200)
    expect(calls.find(({ operation }) => operation === 'getTeamConfiguration')?.value).toEqual({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
    })
    expect(calls.find(({ operation }) => operation === 'requireTeamPermission')?.value)
      .toMatchObject({ teamId: 'team-1', minimum: 'viewer' })
    expect(calls.find(({ operation }) => operation === 'requireTeamConfigurationAdministration')?.value)
      .toMatchObject({ teamId: 'team-1' })
    expect(calls.find(({ operation }) => operation === 'saveTeamConfiguration')?.value)
      .toMatchObject({ workspaceId: 'workspace-1', teamId: 'team-1', value: { scopeType: 'team', scopeId: 'team-1' } })
    expect(calls.find(({ operation }) => operation === 'validateReferences')?.value)
      .toMatchObject({ workspaceId: 'workspace-1', teamId: 'team-1' })
  })

  test('returns the stable missing-bearer response before authentication', async () => {
    const { calls, router } = createDependencies()
    const response = await router.request('/api/work-item-configuration')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Bearer token is required.' })
    expect(calls).toEqual([])
  })

  test('maps authentication and client failures at the configuration boundary', async () => {
    const failure = new Error('configuration unavailable')
    const { calls, router } = createDependencies({
      async authenticate() {
        throw failure
      },
      mapError: (context, error) => {
        expect(error).toBe(failure)
        return context.json({ code: 'WorkItemConfigurationUnavailable' }, 503)
      },
    })

    const response = await router.request('/api/work-item-configuration', {
      headers: { Authorization: 'Bearer workspace-token' },
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: 'WorkItemConfigurationUnavailable' })
    expect(calls.map(({ operation }) => operation)).toEqual([])
  })
})
