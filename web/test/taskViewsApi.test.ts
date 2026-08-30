import { afterEach, describe, expect, test } from 'bun:test'
import {
  TASK_VIEW_SCHEMA_VERSION,
  type CreateSavedTaskViewInput,
  type SavedTaskView,
  type SavedTaskViewCapabilities,
  type TaskViewDefinition,
} from '@mukuroji/contracts'
import {
  createSavedTaskView,
  deleteSavedTaskView,
  duplicateSavedTaskView,
  getSavedTaskView,
  getSavedTaskViews,
  updateSavedTaskView,
} from '../src/task-views/api/savedTaskViews'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'task-view-correlation',
  idempotencyKey: 'task-view-idempotency',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('saved task-view API', () => {
  test('paginates, deduplicates views, and intersects capabilities before a repeated cursor', async () => {
    const first = createSavedTaskViewFixture('first-view')
    const second = createSavedTaskViewFixture('second-view')
    const requests = installJsonResponses([
      {
        capabilities: createSavedTaskViewCapabilities({
          writableProjectScopes: [
            { teamId: 'core-team', projectId: 'shared-project' },
            { teamId: 'design-team', projectId: 'shared-project' },
            { teamId: 'core-team', projectId: 'shared-project' },
          ],
          writableTeamIds: ['core-team', 'design-team'],
        }),
        views: [first],
        nextCursor: 'opaque/page-2',
      },
      {
        capabilities: createSavedTaskViewCapabilities({
          canManageSharedViews: false,
          canSetTeamDefault: false,
          canWrite: false,
          writableProjectScopes: [
            { teamId: 'operations-team', projectId: 'shared-project' },
            { teamId: 'core-team', projectId: 'shared-project' },
            { teamId: 'core-team', projectId: 'shared-project' },
          ],
          writableTeamIds: ['core-team', 'operations-team'],
        }),
        views: [first, second],
        nextCursor: 'opaque/page-2',
      },
    ])

    const result = await getSavedTaskViews('access-token', {
      limit: 2,
      scope: { kind: 'project', projectId: 'refero', teamId: 'core-team' },
      surface: 'project',
    })

    expect(result.views.map((view) => view.id)).toEqual(['first-view', 'second-view'])
    expect(result.capabilities).toEqual({
      canManageSharedViews: false,
      canSetTeamDefault: false,
      canWrite: false,
      writableProjectScopes: [{ teamId: 'core-team', projectId: 'shared-project' }],
      writableTeamIds: ['core-team'],
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer access-token')
    const firstUrl = new URL(requests[0]?.url ?? '')
    expect(firstUrl.pathname).toBe('/api/task-views')
    expect(firstUrl.searchParams.get('limit')).toBe('2')
    expect(firstUrl.searchParams.get('surface')).toBe('project')
    expect(firstUrl.searchParams.get('scope')).toBe(JSON.stringify({
      kind: 'project',
      projectId: 'refero',
      teamId: 'core-team',
    }))
    expect(new URL(requests[1]?.url ?? '').searchParams.get('cursor')).toBe('opaque/page-2')
  })

  test('validates a wrapped saved view including safe migration warnings', async () => {
    const view = {
      ...createSavedTaskViewFixture('migrated-view'),
      migrationWarnings: [{
        code: 'invalid-layout',
        fallback: 'reset-to-default',
        section: 'layout',
      }],
    } satisfies SavedTaskView
    const requests = installJsonResponses([{ view }])

    await expect(getSavedTaskView('access-token', 'view/with slash')).resolves.toEqual(view)

    expect(new URL(requests[0]?.url ?? '').pathname)
      .toBe('/api/task-views/view%2Fwith%20slash')
  })

  test('sends canonical lifecycle methods, encoded paths, bodies, and mutation headers', async () => {
    const responseView = createSavedTaskViewFixture('saved-view')
    const requests = installJsonResponses([
      responseView,
      { view: { ...responseView, revision: 2 } },
      { view: { ...responseView, id: 'saved-view-copy' } },
      undefined,
    ])
    const createInput = {
      definition: createDefinition(),
      defaultSource: 'personal',
      favorite: true,
      name: 'Delivery review',
      pinned: true,
      visibility: 'personal',
    } satisfies CreateSavedTaskViewInput

    await createSavedTaskView('access-token', createInput, mutationContext)
    await updateSavedTaskView('access-token', 'view/one', {
      definition: { ...createDefinition(), filters: { keyword: 'updated' } },
      expectedRevision: 1,
      pinned: false,
      clearDefaultSource: 'personal',
    }, mutationContext)
    await duplicateSavedTaskView('access-token', 'view/one', {
      name: 'Delivery review copy',
      visibility: 'team',
      teamId: 'core-team',
    }, mutationContext)
    await deleteSavedTaskView('access-token', 'view/one', 2, mutationContext)

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['POST', '/api/task-views'],
      ['PATCH', '/api/task-views/view%2Fone'],
      ['POST', '/api/task-views/view%2Fone/duplicate'],
      ['DELETE', '/api/task-views/view%2Fone'],
    ])
    expect(await requests[0]?.json()).toEqual(createInput)
    expect(await requests[1]?.json()).toMatchObject({
      expectedRevision: 1,
      pinned: false,
      clearDefaultSource: 'personal',
    })
    expect(await requests[2]?.json()).toEqual({
      name: 'Delivery review copy',
      teamId: 'core-team',
      visibility: 'team',
    })
    expect(new URL(requests[3]?.url ?? '').searchParams.get('expectedRevision')).toBe('2')
    for (const request of requests) {
      expect(request.headers.get('Authorization')).toBe('Bearer access-token')
      expect(request.headers.get('Idempotency-Key')).toBe('task-view-idempotency')
      expect(request.headers.get('X-Correlation-Id')).toBe('task-view-correlation')
    }
    expect(requests[3]?.headers.get('Content-Type')).toBeNull()
  })

  test('rejects malformed nested custom-field and date filters at the HTTP boundary', async () => {
    const malformed = {
      ...createSavedTaskViewFixture('malformed-view'),
      definition: {
        ...createDefinition(),
        filters: {
          customFields: [{ fieldId: 42, operator: 'executes-code' }],
          date: { field: 'deletedAt', from: false },
        },
      },
    }
    installJsonResponses([malformed])

    await expect(getSavedTaskView('access-token', 'malformed-view')).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 502,
    })
  })

  test('rejects unknown entity types at the HTTP boundary', async () => {
    const malformed = {
      ...createSavedTaskViewFixture('unknown-entity-view'),
      definition: {
        ...createDefinition(),
        filters: { entityTypes: ['work-item', 'executable'] },
      },
    }
    installJsonResponses([malformed])

    await expect(getSavedTaskView('access-token', 'unknown-entity-view')).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 502,
    })
  })

  test('rejects unknown filter fields before they can reset known filters', async () => {
    const malformed = {
      ...createSavedTaskViewFixture('future-filter-view'),
      definition: {
        ...createDefinition(),
        filters: {
          assigneeUserIds: ['viewer@example.com'],
          futureFilter: true,
        },
      },
    }
    installJsonResponses([malformed])

    await expect(getSavedTaskView('access-token', 'future-filter-view')).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 502,
    })
  })

  test('rejects internally inconsistent default preference metadata', async () => {
    const malformedPersonalDefault = {
      ...createSavedTaskViewFixture('invalid-default-view'),
      preference: {
        defaultSource: 'team',
        favorite: false,
        isDefault: false,
        isPersonalDefault: true,
        isTeamDefault: false,
        pinned: false,
      },
    }
    const malformedTeamDefault = {
      ...createSavedTaskViewFixture('invalid-team-default-view'),
      preference: {
        defaultSource: 'team',
        favorite: false,
        isDefault: true,
        isPersonalDefault: false,
        isTeamDefault: false,
        pinned: false,
      },
    }
    installJsonResponses([malformedPersonalDefault, malformedTeamDefault])

    await expect(getSavedTaskView('access-token', 'invalid-default-view')).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 502,
    })
    await expect(getSavedTaskView(
      'access-token',
      'invalid-team-default-view',
    )).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 502,
    })
  })

  test('accepts a shadowed Team default preference without an effective source', async () => {
    const shadowedTeamDefault = {
      ...createSavedTaskViewFixture('shadowed-team-default-view'),
      preference: {
        favorite: false,
        isDefault: false,
        isPersonalDefault: false,
        isTeamDefault: true,
        pinned: false,
      },
    }
    installJsonResponses([shadowedTeamDefault])

    await expect(getSavedTaskView(
      'access-token',
      'shadowed-team-default-view',
    )).resolves.toEqual(shadowedTeamDefault)
  })

  test('rejects invalid layout metadata and preserves classified API errors', async () => {
    const invalidLayout = {
      ...createSavedTaskViewFixture('invalid-layout'),
      definition: {
        ...createDefinition(),
        layout: {
          ...createDefinition().layout,
          columns: [{ field: 'title', width: -1 }],
        },
      },
    }
    installJsonResponses([invalidLayout])
    await expect(getSavedTaskView('access-token', 'invalid-layout')).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 502,
    })

    globalThis.fetch = Object.assign(
      async () => Response.json({
        code: 'TaskViewRevisionConflict',
        message: 'The saved view changed.',
      }, { status: 409 }),
      { preconnect: originalFetch.preconnect },
    )
    await expect(updateSavedTaskView('access-token', 'view', {
      expectedRevision: 1,
    }, mutationContext)).rejects.toMatchObject({
      code: 'TaskViewRevisionConflict',
      message: 'The saved view changed.',
      status: 409,
    })
  })

  test('rejects malformed JSON returned with a successful status', async () => {
    globalThis.fetch = Object.assign(
      async () => new Response('{not-json', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
      { preconnect: originalFetch.preconnect },
    )

    await expect(getSavedTaskViews('access-token')).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 200,
    })
  })

  test('rejects missing or malformed list capabilities at the HTTP boundary', async () => {
    installJsonResponses([{ views: [] }])
    await expect(getSavedTaskViews('access-token')).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 502,
    })

    installJsonResponses([{
      capabilities: {
        canManageSharedViews: false,
        canSetTeamDefault: false,
        canWrite: false,
        writableTeamIds: [],
      },
      views: [],
    }])
    await expect(getSavedTaskViews('access-token')).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 502,
    })

    installJsonResponses([{
      capabilities: {
        ...createSavedTaskViewCapabilities(),
        writableTeamIds: ['core-team', 42],
      },
      views: [],
    }])
    await expect(getSavedTaskViews('access-token')).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 502,
    })

    installJsonResponses([{
      capabilities: {
        ...createSavedTaskViewCapabilities(),
        writableProjectScopes: [{ teamId: 'core-team', projectId: 42 }],
      },
      views: [],
    }])
    await expect(getSavedTaskViews('access-token')).rejects.toMatchObject({
      code: 'InvalidTaskViewResponse',
      status: 502,
    })
  })
})

/** Creates a complete Project definition accepted by the shared task-view contract. */
function createDefinition(): TaskViewDefinition {
  return {
    surface: 'project',
    scope: { kind: 'project', projectId: 'refero', teamId: 'core-team' },
    filters: {
      customFields: [{ fieldId: 'risk', operator: 'equals', value: ['high'] }],
      date: { field: 'dueDate', from: '2026-08-01', to: '2026-08-31' },
      workflowStatuses: [{
        teamId: 'core-team',
        workItemTypeId: 'bug',
        statusId: 'started',
      }],
    },
    layout: {
      mode: 'table',
      group: { direction: 'asc', field: 'status' },
      sort: [{ direction: 'asc', field: 'dueDate' }],
      columns: [{ field: 'title', pin: 'start', width: 320 }, { field: 'status' }],
      density: 'comfortable',
      displayOptions: { showCompleted: false, showSubItems: true, wrapText: false },
    },
  }
}

/** Creates a complete persisted task view for transport-boundary tests. */
function createSavedTaskViewFixture(id: string): SavedTaskView {
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    canEdit: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    definition: createDefinition(),
    id,
    name: id,
    ownerUserId: 'viewer@example.com',
    preference: {
      defaultSource: 'personal',
      favorite: false,
      isDefault: true,
      isPersonalDefault: true,
      isTeamDefault: false,
      pinned: false,
    },
    revision: 1,
    updatedAt: '2026-08-02T00:00:00.000Z',
    visibility: 'personal',
  }
}

/**
 * Creates server-authoritative list capabilities for transport and pagination tests.
 *
 * @param overrides - Capability fields replaced for one response page.
 * @returns A complete capability object accepted by the task-view response contract.
 */
function createSavedTaskViewCapabilities(
  overrides: Partial<SavedTaskViewCapabilities> = {},
): SavedTaskViewCapabilities {
  return {
    canManageSharedViews: true,
    canSetTeamDefault: true,
    canWrite: true,
    writableProjectScopes: [{ teamId: 'core-team', projectId: 'refero' }],
    writableTeamIds: ['core-team'],
    ...overrides,
  }
}

/** Installs deterministic JSON responses and records normalized requests. */
function installJsonResponses(responses: readonly unknown[]): Request[] {
  const requests: Request[] = []
  let responseIndex = 0
  globalThis.fetch = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'https://example.test'), init)
      requests.push(request.clone())
      const responseBody = responses[responseIndex]
      responseIndex += 1
      return responseBody === undefined
        ? new Response(null, { status: 204 })
        : Response.json(responseBody)
    },
    { preconnect: originalFetch.preconnect },
  )
  return requests
}
