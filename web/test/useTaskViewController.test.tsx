import { afterEach, describe, expect, test } from 'bun:test'
import {
  TASK_VIEW_SCHEMA_VERSION,
  type SavedTaskView,
  type SavedTaskViewCapabilities,
  type TaskViewDefinition,
  type TaskViewScope,
} from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { SWRConfig, unstable_serialize } from 'swr'
import {
  BUILT_IN_TASK_VIEW_ID,
  publishSavedTaskViewMutationResult,
  reconcileSavedTaskViews,
  refreshSavedTaskViewsAfterMutation,
  useTaskViewController,
  type TaskViewController,
  type UseTaskViewControllerInput,
} from '../src/task-views/mutations/useTaskViewController'
import {
  parseTaskViewUrlState,
  updateTaskViewUrlState,
} from '../src/task-views/model/taskViewUrlState'

const scope: TaskViewScope = {
  kind: 'project',
  projectId: 'refero',
  teamId: 'core-team',
}
const identity = {
  scope,
  surface: 'project',
} satisfies Parameters<typeof parseTaskViewUrlState>[1]
const builtInDefinition = createDefinition('built in', 'table')
const teamDefault = createSavedView('team-default', 'team default', 'board', {
  defaultSource: 'team',
  isDefault: true,
})
const personalDefault = createSavedView('personal-default', 'personal default', 'calendar', {
  defaultSource: 'personal',
  isDefault: true,
})
const selectedView = createSavedView('selected-view', 'selected', 'gantt', {
  isDefault: false,
})
const originalFetch = globalThis.fetch
const writableTaskViewCapabilities = {
  canManageSharedViews: true,
  canSetTeamDefault: true,
  canWrite: true,
  writableProjectScopes: [{ teamId: 'core-team', projectId: 'refero' }],
  writableTeamIds: ['core-team'],
} satisfies SavedTaskViewCapabilities

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('useTaskViewController resolution', () => {
  test('chooses personal then Team defaults when the URL has no explicit view', () => {
    const personalController = renderController(
      createInput(new URLSearchParams('tab=activity')),
      [teamDefault, personalDefault],
    )
    const teamController = renderController(
      createInput(new URLSearchParams('tab=activity')),
      [teamDefault],
    )

    expect(personalController.activeSavedView?.id).toBe('personal-default')
    expect(personalController.baselineDefinition.filters.keyword).toBe('personal default')
    expect(personalController.effectiveDefinition.layout.mode).toBe('calendar')
    expect(teamController.activeSavedView?.id).toBe('team-default')
    expect(teamController.baselineDefinition.filters.keyword).toBe('team default')
    expect(teamController.effectiveDefinition.layout.mode).toBe('board')
  })

  test('uses explicit selection over defaults and applies a temporary URL override last', () => {
    const searchParams = updateTaskViewUrlState(
      new URLSearchParams('tab=activity&panel=details'),
      identity,
      {
        override: {
          filters: { keyword: 'temporary' },
          layout: { density: 'spacious', mode: 'board' },
        },
        viewId: selectedView.id,
      },
    )
    const controller = renderController(
      createInput(searchParams),
      [teamDefault, personalDefault, selectedView],
    )

    expect(controller.activeSavedView?.id).toBe('selected-view')
    expect(controller.baselineDefinition.filters.keyword).toBe('selected')
    expect(controller.baselineDefinition.layout.mode).toBe('gantt')
    expect(controller.effectiveDefinition.filters).toEqual({ keyword: 'temporary' })
    expect(controller.effectiveDefinition.layout).toMatchObject({
      density: 'spacious',
      mode: 'board',
    })
    expect(controller.isDirty).toBe(true)
  })

  test('honors explicit built-in selection and suppresses saved defaults', () => {
    const searchParams = updateTaskViewUrlState(
      new URLSearchParams('tab=activity'),
      identity,
      { viewId: BUILT_IN_TASK_VIEW_ID },
    )
    const controller = renderController(
      createInput(searchParams),
      [teamDefault, personalDefault],
    )

    expect(controller.activeSavedView).toBeUndefined()
    expect(controller.baselineDefinition).toEqual(builtInDefinition)
    expect(controller.effectiveDefinition).toEqual(builtInDefinition)
  })

  test('falls back safely when a loaded permalink view is no longer accessible', () => {
    const searchParams = updateTaskViewUrlState(
      new URLSearchParams('tab=activity'),
      identity,
      { viewId: 'inaccessible-view' },
    )
    const controller = renderController(createInput(searchParams), [personalDefault])

    expect(controller.activeSavedView).toBeUndefined()
    expect(controller.effectiveDefinition).toEqual(builtInDefinition)
    expect(controller.migrationWarnings).toContainEqual({
      code: 'permission-redacted',
      fallback: 'unavailable',
      section: 'scope',
    })
  })

  test('suppresses the missing-view warning until saved views finish loading', () => {
    const searchParams = updateTaskViewUrlState(
      new URLSearchParams('tab=activity'),
      identity,
      { viewId: 'still-loading' },
    )
    const controller = renderController(createInput(searchParams))

    expect(controller.isLoading).toBe(true)
    expect(controller.canWrite).toBeFalse()
    expect(controller.writableProjectScopes).toEqual([])
    expect(controller.writableTeamIds).toEqual([])
    expect(controller.migrationWarnings).not.toContainEqual({
      code: 'permission-redacted',
      fallback: 'unavailable',
      section: 'scope',
    })
  })

  test('uses server capabilities and blocks lifecycle mutations for a read-only scope', async () => {
    let requestCount = 0
    globalThis.fetch = Object.assign(
      async () => {
        requestCount += 1
        return Response.json({ view: selectedView })
      },
      { preconnect: originalFetch.preconnect },
    )
    const controller = renderController(
      createInput(new URLSearchParams()),
      [selectedView],
      {
        canManageSharedViews: false,
        canSetTeamDefault: false,
        canWrite: false,
        writableProjectScopes: [{ teamId: 'core-team', projectId: 'refero' }],
        writableTeamIds: ['core-team'],
      },
    )

    expect(controller.canWrite).toBeFalse()
    expect(controller.canManageShared).toBeFalse()
    expect(controller.canSetTeamDefault).toBeFalse()
    expect(controller.writableProjectScopes).toEqual([
      { teamId: 'core-team', projectId: 'refero' },
    ])
    expect(controller.writableTeamIds).toEqual(['core-team'])
    await controller.saveAs({ name: 'Denied view', visibility: 'personal' })
    await controller.duplicateView(selectedView.id)
    await controller.patchPreference(selectedView.id, { favorite: true })
    await controller.updateActiveView()
    await controller.deleteView(selectedView.id)
    expect(requestCount).toBe(0)
  })

  test('rejects Team and shared destinations outside server-authorized capabilities', async () => {
    let requestCount = 0
    const readOnlySelectedView = { ...selectedView, canEdit: false }
    globalThis.fetch = Object.assign(
      async () => {
        requestCount += 1
        return Response.json({ view: selectedView })
      },
      { preconnect: originalFetch.preconnect },
    )
    const controller = renderController(
      createInput(new URLSearchParams()),
      [readOnlySelectedView],
      {
        canManageSharedViews: false,
        canSetTeamDefault: false,
        canWrite: true,
        writableProjectScopes: [{ teamId: 'core-team', projectId: 'refero' }],
        writableTeamIds: ['core-team'],
      },
    )

    await controller.saveAs({
      name: 'Wrong Team',
      teamId: 'restricted-team',
      visibility: 'team',
    })
    await controller.saveAs({ name: 'Denied shared view', visibility: 'shared' })
    await controller.patchPreference(readOnlySelectedView.id, { isTeamDefault: true })
    await controller.deleteView(readOnlySelectedView.id)
    await controller.duplicateView('missing-view')
    expect(requestCount).toBe(0)
  })

  test('selects built-in state and clears overrides without dropping unrelated route state', () => {
    let committed = new URLSearchParams()
    const searchParams = updateTaskViewUrlState(
      new URLSearchParams('tab=activity&panel=details'),
      identity,
      {
        override: { layout: { density: 'compact' } },
        viewId: selectedView.id,
      },
    )
    const controller = renderController({
      ...createInput(searchParams),
      onSearchParamsChange: (next) => {
        committed = next
      },
    }, [selectedView])

    controller.selectView(undefined)

    const parsed = parseTaskViewUrlState(committed, identity)
    expect(parsed.state).toEqual({
      schemaVersion: 1,
      scope,
      surface: 'project',
      viewId: BUILT_IN_TASK_VIEW_ID,
    })
    expect(committed.get('tab')).toBe('activity')
    expect(committed.get('panel')).toBe('details')
  })

  test('writes only a minimal temporary override for effective state changes', () => {
    let committed = new URLSearchParams()
    const controller = renderController({
      ...createInput(new URLSearchParams('tab=activity')),
      onSearchParamsChange: (next) => {
        committed = next
      },
    }, [personalDefault])

    controller.setEffectiveDefinition({
      ...controller.effectiveDefinition,
      layout: {
        ...controller.effectiveDefinition.layout,
        density: 'spacious',
      },
    })

    const parsed = parseTaskViewUrlState(committed, identity)
    expect(parsed.state.viewId).toBe('personal-default')
    expect(parsed.state.override).toEqual({ layout: { density: 'spacious' } })
    expect(committed.get('tab')).toBe('activity')
  })

  test('pins the built-in identifier when its effective definition gains an override', () => {
    let committed = new URLSearchParams()
    const controller = renderController({
      ...createInput(new URLSearchParams('tab=activity')),
      onSearchParamsChange: (next) => {
        committed = next
      },
    }, [])

    controller.setEffectiveDefinition({
      ...controller.effectiveDefinition,
      layout: {
        ...controller.effectiveDefinition.layout,
        density: 'compact',
      },
    })

    const parsed = parseTaskViewUrlState(committed, identity)
    expect(parsed.state.viewId).toBe(BUILT_IN_TASK_VIEW_ID)
    expect(parsed.state.override).toEqual({ layout: { density: 'compact' } })
  })

  test('sets a personal default without clearing the coexisting Team default', async () => {
    const requests: Request[] = []
    const updatedTeamDefault = {
      ...teamDefault,
      preference: {
        ...teamDefault.preference,
        defaultSource: 'personal',
        isDefault: true,
        isPersonalDefault: true,
        isTeamDefault: true,
      },
      revision: 2,
    } satisfies SavedTaskView
    globalThis.fetch = Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(new URL(String(input), 'https://example.test'), init)
        requests.push(request.clone())
        return request.method === 'PATCH'
          ? Response.json({ view: updatedTeamDefault })
          : Response.json({
              capabilities: writableTaskViewCapabilities,
              views: [updatedTeamDefault],
            })
      },
      { preconnect: originalFetch.preconnect },
    )
    const controller = renderController(
      createInput(new URLSearchParams('tab=activity')),
      [teamDefault],
    )

    await controller.patchPreference(teamDefault.id, { isDefault: true })

    expect(requests[0]?.method).toBe('PATCH')
    expect(await requests[0]?.json()).toEqual({
      defaultSource: 'personal',
      expectedRevision: teamDefault.revision,
    })
  })

  test('copies a canonical permalink that pins an implicit default and preserves route state', async () => {
    let copiedLink = ''
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (value: string) => {
            copiedLink = value
          },
        },
      },
    })
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: {
        href: 'https://mukuroji.example/projects/refero/issues?tab=activity#details',
      },
    })

    try {
      const searchParams = updateTaskViewUrlState(
        new URLSearchParams('tab=activity&panel=details'),
        identity,
        { override: { layout: { density: 'spacious' } } },
      )
      const controller = renderController(createInput(searchParams), [personalDefault])

      await controller.copyPermalink()

      const permalink = new URL(copiedLink)
      const parsed = parseTaskViewUrlState(permalink.searchParams, identity)
      expect(parsed.state.viewId).toBe('personal-default')
      expect(parsed.state.override).toEqual({ layout: { density: 'spacious' } })
      expect(permalink.searchParams.get('tab')).toBe('activity')
      expect(permalink.searchParams.get('panel')).toBe('details')
      expect(permalink.hash).toBe('#details')
    } finally {
      restoreGlobalProperty('navigator', navigatorDescriptor)
      restoreGlobalProperty('location', locationDescriptor)
    }
  })

  test('does not overwrite newer task-view state after lifecycle mutations resolve', async () => {
    const createdView = createSavedView('created-view', 'created', 'table', {
      isDefault: false,
    })
    const mutationCases = [
      {
        response: { view: createdView },
        run: (controller: TaskViewController) => controller.saveAs({
          name: 'Created view',
          visibility: 'personal',
        }),
      },
      {
        response: { view: createdView },
        run: (controller: TaskViewController) => controller.duplicateView(selectedView.id),
      },
      {
        response: undefined,
        run: (controller: TaskViewController) => controller.deleteView(selectedView.id),
      },
      {
        response: { view: { ...selectedView, revision: 2 } },
        run: (controller: TaskViewController) => controller.updateActiveView(),
      },
    ]

    for (const mutationCase of mutationCases) {
      let committed: URLSearchParams | undefined
      const searchParams = updateTaskViewUrlState(
        new URLSearchParams('issueId=item-1'),
        identity,
        { viewId: selectedView.id },
      )
      const deferredResponse = installDeferredMutationResponse(mutationCase.response)
      const controller = renderController({
        ...createInput(searchParams),
        onSearchParamsChange: (next) => {
          committed = next
        },
      }, [selectedView])

      const operation = mutationCase.run(controller)
      await deferredResponse.started
      controller.selectView('newer-selection')
      deferredResponse.complete()
      await operation

      expect(committed?.get('view')).toBe('newer-selection')
    }
  })

  test('commits lifecycle results against the latest unrelated route state', async () => {
    let committed: URLSearchParams | undefined
    const duplicatedView = createSavedView('selected-view-copy', 'copy', 'gantt', {
      isDefault: false,
    })
    const searchParams = updateTaskViewUrlState(
      new URLSearchParams('issueId=item-1&panel=activity'),
      identity,
      { viewId: selectedView.id },
    )
    const deferredResponse = installDeferredMutationResponse({ view: duplicatedView })
    const controller = renderController({
      ...createInput(searchParams),
      onSearchParamsChange: (next) => {
        committed = next
      },
    }, [selectedView])

    const operation = controller.duplicateView(selectedView.id)
    await deferredResponse.started
    searchParams.set('issueId', 'item-2')
    searchParams.set('panel', 'relations')
    deferredResponse.complete()
    await operation

    expect(committed?.get('issueId')).toBe('item-2')
    expect(committed?.get('panel')).toBe('relations')
    expect(committed?.get('view')).toBe(duplicatedView.id)
  })

  test('does not turn an acknowledged mutation into failure when list refresh fails', async () => {
    await expect(refreshSavedTaskViewsAfterMutation(
      async () => { throw new Error('refresh unavailable') },
    )).resolves.toBe(
      'The task view change was saved, but the list could not be refreshed: refresh unavailable',
    )
    await expect(refreshSavedTaskViewsAfterMutation(async () => undefined))
      .resolves.toBeUndefined()
  })

  test('reconciles canonical lifecycle responses before list revalidation', () => {
    const createdView = createSavedView('created-view', 'created', 'table', {
      isDefault: false,
    })
    const updatedView = {
      ...selectedView,
      name: 'Updated name',
      revision: selectedView.revision + 1,
    } satisfies SavedTaskView

    const appended = reconcileSavedTaskViews(
      [selectedView],
      { type: 'append', view: createdView },
    )
    expect(appended).toEqual([selectedView, createdView])
    expect(reconcileSavedTaskViews(
      appended,
      { type: 'replace', view: updatedView },
    )).toEqual([updatedView, createdView])
    expect(reconcileSavedTaskViews(
      [selectedView],
      { type: 'replace', view: createdView },
    )).toEqual([selectedView, createdView])
    expect(reconcileSavedTaskViews(
      appended,
      { type: 'remove', viewId: selectedView.id },
    )).toEqual([createdView])
  })

  test('keeps canonical cache data when revalidation fails after publication', async () => {
    const createdView = createSavedView('created-view', 'created', 'table', {
      isDefault: false,
    })
    let cachedCollection: {
      capabilities: SavedTaskViewCapabilities
      views: readonly SavedTaskView[]
    } = {
      capabilities: writableTaskViewCapabilities,
      views: [selectedView],
    }

    const warning = await publishSavedTaskViewMutationResult(
      { type: 'append', view: createdView },
      async (update) => {
        cachedCollection = {
          ...cachedCollection,
          views: update(cachedCollection.views),
        }
      },
      async () => {
        throw new Error('refresh unavailable')
      },
    )

    expect(cachedCollection).toEqual({
      capabilities: writableTaskViewCapabilities,
      views: [selectedView, createdView],
    })
    expect(warning).toBe(
      'The task view change was saved, but the list could not be refreshed: refresh unavailable',
    )
  })

  test('does not reject an acknowledged mutation when local cache publication fails', async () => {
    await expect(publishSavedTaskViewMutationResult(
      { type: 'replace', view: selectedView },
      async () => {
        throw new Error('cache unavailable')
      },
      async () => undefined,
    )).resolves.toBe(
      'The task view change was saved, but the local list could not be updated: cache unavailable',
    )
  })

  test('commits the canonical created-view URL after an acknowledged response', async () => {
    const createdView = createSavedView('created-view', 'created', 'table', {
      isDefault: false,
    })
    let committed = new URLSearchParams()
    let requestCount = 0
    globalThis.fetch = Object.assign(
      async () => {
        requestCount += 1
        return Response.json({ view: createdView })
      },
      { preconnect: originalFetch.preconnect },
    )
    const controller = renderController({
      ...createInput(new URLSearchParams('issueId=item-1')),
      onSearchParamsChange: (next) => {
        committed = next
      },
    }, [selectedView])

    await expect(controller.saveAs({
      name: createdView.name,
      visibility: 'personal',
    })).resolves.toBeUndefined()

    expect(requestCount).toBeGreaterThanOrEqual(1)
    expect(committed.get('view')).toBe(createdView.id)
    expect(committed.get('issueId')).toBe('item-1')
  })
})

/** Renders the controller with an isolated SWR cache and returns the captured hook result. */
function renderController(
  input: UseTaskViewControllerInput,
  views?: readonly SavedTaskView[],
  capabilities: SavedTaskViewCapabilities = writableTaskViewCapabilities,
): TaskViewController {
  let captured: TaskViewController | undefined
  const key = unstable_serialize([
    'saved-task-views',
    input.accessToken,
    input.surface,
    JSON.stringify(input.scope),
  ])

  /** Captures one server-rendered controller result for synchronous resolution assertions. */
  function ControllerProbe() {
    captured = useTaskViewController(input)
    return null
  }

  renderToStaticMarkup(
    <SWRConfig value={{
      fallback: views ? { [key]: { capabilities, views } } : {},
      provider: () => views
        ? new Map()
        : new Map([[key, { isLoading: true }]]),
      revalidateOnMount: false,
    }}>
      <ControllerProbe />
    </SWRConfig>,
  )
  if (!captured) throw new Error('The task-view controller was not rendered.')
  return captured
}

/**
 * Restores one browser global after a controller test replaces it.
 *
 * @param key - Global browser property to restore.
 * @param descriptor - Original property descriptor, or undefined when it was absent.
 */
function restoreGlobalProperty(
  key: 'location' | 'navigator',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  else Reflect.deleteProperty(globalThis, key)
}

/**
 * Installs a deferred lifecycle response followed by a valid saved-view refresh.
 *
 * @param mutationResponse - JSON mutation payload, or undefined for a 204 response.
 * @returns Controls for waiting until the request starts and completing it deterministically.
 */
function installDeferredMutationResponse(mutationResponse: unknown) {
  let requestCount = 0
  let notifyStarted: (() => void) | undefined
  let resolveMutation: ((response: Response) => void) | undefined
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  globalThis.fetch = Object.assign(
    async () => {
      const requestIndex = requestCount
      requestCount += 1
      if (requestIndex === 0) {
        return new Promise<Response>((resolve) => {
          resolveMutation = resolve
          notifyStarted?.()
        })
      }
      return Response.json({
        capabilities: writableTaskViewCapabilities,
        views: [],
      })
    },
    { preconnect: originalFetch.preconnect },
  )

  return {
    complete: () => {
      if (!resolveMutation) throw new Error('The deferred mutation did not start.')
      resolveMutation(mutationResponse === undefined
        ? new Response(null, { status: 204 })
        : Response.json(mutationResponse))
    },
    started,
  }
}

/** Creates stable controller input for the Project surface. */
function createInput(searchParams: URLSearchParams): UseTaskViewControllerInput {
  return {
    accessToken: 'access-token',
    builtInDefinition,
    capabilities: {
      columns: ['title', 'status', 'dueDate'],
      fields: ['title', 'status', 'dueDate'],
      layoutModes: ['table', 'board', 'gantt', 'calendar'],
      requiredColumns: ['title'],
      workflowStatuses: [{ teamId: 'core-team', statusId: 'active' }],
    },
    enabled: true,
    onSearchParamsChange: () => undefined,
    searchParams,
    scope,
    surface: 'project',
  }
}

/** Creates one permission-safe Project definition for precedence tests. */
function createDefinition(keyword: string, mode: TaskViewDefinition['layout']['mode']): TaskViewDefinition {
  return {
    surface: 'project',
    scope,
    filters: { keyword },
    layout: {
      mode,
      sort: [{ direction: 'asc', field: 'dueDate' }],
      columns: [{ field: 'title' }, { field: 'status' }],
      density: 'comfortable',
      displayOptions: { showCompleted: true },
    },
  }
}

/** Creates a saved Project view with configurable default metadata. */
function createSavedView(
  id: string,
  keyword: string,
  mode: TaskViewDefinition['layout']['mode'],
  preference: Pick<SavedTaskView['preference'], 'isDefault'> &
    Partial<Pick<SavedTaskView['preference'], 'defaultSource'>>,
): SavedTaskView {
  const isTeamDefault = preference.defaultSource === 'team'
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    canEdit: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    definition: createDefinition(keyword, mode),
    id,
    name: id,
    ownerUserId: 'viewer@example.com',
    preference: {
      ...preference,
      favorite: false,
      isPersonalDefault: preference.defaultSource === 'personal',
      isTeamDefault: preference.defaultSource === 'team',
      pinned: false,
    },
    revision: 1,
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...(isTeamDefault ? { teamId: 'core-team' } : {}),
    visibility: isTeamDefault ? 'team' : 'personal',
  }
}
