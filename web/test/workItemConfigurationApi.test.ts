import { afterEach, describe, expect, test } from 'bun:test'
import type { WorkItemRelationMutationResponse } from '@mukuroji/contracts'
import {
  WorkItemConfigurationApiError,
  createConfigurationPath,
  createWorkItemRelation,
  deleteWorkItemRelation,
  getWorkItemConfiguration,
  putWorkItemConfiguration,
} from '../src/work-items/api'
import {
  inheritedWorkItemConfigurationFixture,
  workspaceWorkItemConfigurationFixture,
} from '../src/work-items/fixtures'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-21',
  idempotencyKey: 'idempotency-21',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Work Item configuration API', () => {
  test('gets resolved Workspace and encoded Team configurations', async () => {
    const requests = installFetchRecorder(inheritedWorkItemConfigurationFixture)

    const workspaceResult = await getWorkItemConfiguration('access-token', { kind: 'workspace' })
    const teamResult = await getWorkItemConfiguration('access-token', {
      kind: 'team',
      teamId: 'core/team',
    })

    expect(workspaceResult).toEqual(inheritedWorkItemConfigurationFixture)
    expect(teamResult.configuration).toEqual(workspaceWorkItemConfigurationFixture)
    expect(requests.map((request) => request.url)).toEqual([
      '/api/work-item-configuration',
      '/api/teams/core%2Fteam/work-item-configuration',
    ])
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
    })
    expect(createConfigurationPath({ kind: 'workspace' })).toBe('/api/work-item-configuration')
  })

  test('puts the complete configuration with stable mutation headers', async () => {
    const requests = installFetchRecorder({
      configuration: workspaceWorkItemConfigurationFixture,
    })

    await putWorkItemConfiguration(
      'access-token',
      { kind: 'workspace' },
      workspaceWorkItemConfigurationFixture,
      mutationContext,
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]?.init.method).toBe('PUT')
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idempotency-21',
      'X-Correlation-Id': 'correlation-21',
    })
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(
      workspaceWorkItemConfigurationFixture,
    )
  })

  test('creates and deletes reciprocal relations with encoded identifiers', async () => {
    const relationResponse: WorkItemRelationMutationResponse = {
      relation: {
        sourceWorkItemId: 'issue/1',
        targetWorkItemId: 'issue/2',
        type: 'blocks',
      },
      reciprocalRelation: {
        sourceWorkItemId: 'issue/2',
        targetWorkItemId: 'issue/1',
        type: 'blockedBy',
      },
      graphRevision: 5,
    }
    const requests = installFetchRecorder(relationResponse)
    const relationInput = {
      type: 'blocks' as const,
      targetWorkItemId: 'issue/2',
      expectedGraphRevision: 4,
    }

    expect(await createWorkItemRelation(
      'core team',
      'issue/1',
      'access-token',
      relationInput,
      mutationContext,
    )).toEqual(relationResponse)
    expect(await deleteWorkItemRelation(
      'core team',
      'issue/1',
      'access-token',
      relationInput,
      mutationContext,
    )).toEqual(relationResponse)

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', '/api/teams/core%20team/issues/issue%2F1/relations'],
      ['DELETE', '/api/teams/core%20team/issues/issue%2F1/relations/issue%2F2/blocks'],
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(relationInput)
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ expectedGraphRevision: 4 })
    expect(requests[1]?.init.headers).toMatchObject({
      'Idempotency-Key': 'idempotency-21',
      'X-Correlation-Id': 'correlation-21',
    })
  })

  test('preserves API status and error code for conflict handling', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 'WorkItemConfigurationRevisionConflict',
      message: 'The configuration was updated by another request.',
    }), { status: 409 })) as typeof fetch

    const request = putWorkItemConfiguration(
      'access-token',
      { kind: 'workspace' },
      workspaceWorkItemConfigurationFixture,
      mutationContext,
    )

    await expect(request).rejects.toMatchObject({
      code: 'WorkItemConfigurationRevisionConflict',
      message: 'The configuration was updated by another request.',
      status: 409,
    } satisfies Partial<WorkItemConfigurationApiError>)
  })
})

function installFetchRecorder(responseBody: unknown) {
  const requests: Array<{ url: string; init: RequestInit }> = []

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })

    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  return requests
}
