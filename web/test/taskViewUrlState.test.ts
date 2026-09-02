import { describe, expect, test } from 'bun:test'
import {
  TASK_VIEW_URL_STATE_SCHEMA_VERSION,
  type TaskViewUrlState,
} from '@mukuroji/contracts'
import {
  createTaskViewUrlStateFingerprint,
  parseTaskViewUrlState,
  preserveTaskViewUrlState,
  serializeTaskViewUrlOverride,
  serializeTaskViewUrlState,
  updateTaskViewUrlState,
} from '../src/task-views/model/taskViewUrlState'

const context = {
  surface: 'team',
  scope: { kind: 'team', teamId: 'team-1' },
} satisfies Parameters<typeof parseTaskViewUrlState>[1]

describe('task view URL state', () => {
  test('parses a selected view and temporary override while preserving unrelated repeated params', () => {
    const searchParams = new URLSearchParams()
    searchParams.append('tag', 'second')
    searchParams.append('issueId', 'work-item-1')
    searchParams.append('tag', 'first')
    searchParams.set('view', ' saved-view-1 ')
    searchParams.set('view.v', String(TASK_VIEW_URL_STATE_SCHEMA_VERSION))
    searchParams.set('view.override', JSON.stringify({
      filters: {
        keyword: 'urgent',
        statuses: ['todo'],
        workflowStatuses: [{
          teamId: 'team-1',
          workItemTypeId: 'bug',
          statusId: 'todo',
        }],
      },
      layout: {
        mode: 'board',
        group: { field: 'status', direction: 'asc' },
        displayOptions: { wrapText: true, showCompleted: false },
      },
    }))

    const parsed = parseTaskViewUrlState(searchParams, context)

    expect(parsed.state).toEqual({
      schemaVersion: TASK_VIEW_URL_STATE_SCHEMA_VERSION,
      surface: 'team',
      scope: { kind: 'team', teamId: 'team-1' },
      viewId: 'saved-view-1',
      override: {
        filters: {
          keyword: 'urgent',
          statuses: ['todo'],
          workflowStatuses: [{
            teamId: 'team-1',
            workItemTypeId: 'bug',
            statusId: 'todo',
          }],
        },
        layout: {
          mode: 'board',
          group: { field: 'status', direction: 'asc' },
          displayOptions: { wrapText: true, showCompleted: false },
        },
      },
    })
    expect(parsed.unrelatedParams).toEqual([
      { key: 'tag', value: 'second' },
      { key: 'issueId', value: 'work-item-1' },
      { key: 'tag', value: 'first' },
    ])
    expect(parsed.warnings).toEqual([])
  })

  test('serializes equivalent overrides to identical deterministic JSON and query order', () => {
    const first = {
      schemaVersion: TASK_VIEW_URL_STATE_SCHEMA_VERSION,
      surface: 'team',
      scope: { kind: 'team', teamId: 'team-1' },
      viewId: 'view-1',
      override: {
        filters: {
          teamIds: ['team-1'],
          workItemTypeIds: ['bug'],
          keyword: 'alpha',
        },
        layout: {
          columns: [{ field: 'title', width: 240 }, { field: 'status' }],
          displayOptions: { wrapText: true, showCompleted: false },
          density: 'comfortable',
        },
      },
    } satisfies TaskViewUrlState
    const second = {
      schemaVersion: TASK_VIEW_URL_STATE_SCHEMA_VERSION,
      surface: 'team',
      scope: { kind: 'team', teamId: 'team-1' },
      viewId: 'view-1',
      override: {
        layout: {
          density: 'comfortable',
          displayOptions: { showCompleted: false, wrapText: true },
          columns: [{ width: 240, field: 'title' }, { field: 'status' }],
        },
        filters: {
          keyword: 'alpha',
          teamIds: ['team-1'],
          workItemTypeIds: ['bug'],
        },
      },
    } satisfies TaskViewUrlState
    const unrelated = [
      { key: 'z', value: 'last' },
      { key: 'a', value: 'first' },
      { key: 'z', value: 'again' },
    ]

    expect(serializeTaskViewUrlOverride(first.override ?? {}))
      .toBe(serializeTaskViewUrlOverride(second.override ?? {}))
    expect(serializeTaskViewUrlState(first, unrelated).toString())
      .toBe(serializeTaskViewUrlState(second, unrelated).toString())
    expect(Array.from(serializeTaskViewUrlState(first, unrelated).entries()).slice(0, 3))
      .toEqual([
        ['a', 'first'],
        ['view', 'view-1'],
        ['view.override', serializeTaskViewUrlOverride(first.override ?? {})],
      ])
    expect(Array.from(serializeTaskViewUrlState(first, unrelated).getAll('z')))
      .toEqual(['last', 'again'])
  })

  test('ignores unsupported or malformed override versions without losing the selected view', () => {
    const unsupported = new URLSearchParams({
      view: 'view-1',
      'view.v': '999',
      'view.override': JSON.stringify({ layout: { mode: 'board' } }),
    })
    const malformed = new URLSearchParams({
      view: 'view-2',
      'view.v': String(TASK_VIEW_URL_STATE_SCHEMA_VERSION),
      'view.override': '{',
    })

    expect(parseTaskViewUrlState(unsupported, context)).toMatchObject({
      state: { viewId: 'view-1' },
      warnings: [{ code: 'invalid-url-override', section: 'url-override' }],
    })
    expect(parseTaskViewUrlState(unsupported, context).state.override).toBeUndefined()
    expect(parseTaskViewUrlState(malformed, context).state.override).toBeUndefined()
    expect(parseTaskViewUrlState(malformed, context).warnings).toHaveLength(1)
  })

  test('drops an invalid override section instead of turning it into an empty filter', () => {
    const searchParams = new URLSearchParams({
      'view.v': String(TASK_VIEW_URL_STATE_SCHEMA_VERSION),
      'view.override': JSON.stringify({
        filters: { statuses: 'todo' },
        layout: { mode: 'board' },
      }),
    })

    expect(parseTaskViewUrlState(searchParams, context)).toMatchObject({
      state: { override: { layout: { mode: 'board' } } },
      warnings: [{
        code: 'invalid-url-override',
        section: 'filter',
        fallback: 'ignored',
      }],
    })
  })

  test('rejects URL column widths outside persisted server bounds', () => {
    const searchParams = new URLSearchParams({
      'view.v': String(TASK_VIEW_URL_STATE_SCHEMA_VERSION),
      'view.override': JSON.stringify({
        layout: {
          columns: [{ field: 'title', width: 39 }, { field: 'status', width: 2_001 }],
        },
      }),
    })

    const parsed = parseTaskViewUrlState(searchParams, context)

    expect(parsed.state.override?.layout?.columns).toBeUndefined()
    expect(parsed.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: 'url-override' }),
    ]))
  })

  test('updates only owned parameters and clears stale view state', () => {
    const current = new URLSearchParams()
    current.append('teamId', 'team-1')
    current.append('tag', 'a')
    current.append('tag', 'b')
    current.set('view', 'old-view')
    current.set('view.v', '1')
    current.set('view.override', '{}')

    const updated = updateTaskViewUrlState(current, context, {})

    expect(Array.from(updated.entries())).toEqual([
      ['tag', 'a'],
      ['tag', 'b'],
      ['teamId', 'team-1'],
    ])
  })

  test('preserves task-view state across collection create and detail navigation', () => {
    const override = JSON.stringify({ filters: { keyword: 'release' } })
    const current = new URLSearchParams({
      issueId: 'old-item',
      panel: 'activity',
      view: 'delivery-review',
      'view.override': override,
      'view.v': String(TASK_VIEW_URL_STATE_SCHEMA_VERSION),
    })

    const destination = preserveTaskViewUrlState(
      '/projects/refero/issues?teamId=core-team&issueId=new-item&view=stale&view.v=0#details',
      current,
    )
    const parsedDestination = new URL(destination, 'https://mukuroji.invalid')

    expect(parsedDestination.pathname).toBe('/projects/refero/issues')
    expect(parsedDestination.hash).toBe('#details')
    expect(parsedDestination.searchParams.get('teamId')).toBe('core-team')
    expect(parsedDestination.searchParams.get('issueId')).toBe('new-item')
    expect(parsedDestination.searchParams.get('panel')).toBeNull()
    expect(parsedDestination.searchParams.get('view')).toBe('delivery-review')
    expect(parsedDestination.searchParams.get('view.override')).toBe(override)
    expect(parsedDestination.searchParams.get('view.v'))
      .toBe(String(TASK_VIEW_URL_STATE_SCHEMA_VERSION))
  })

  test('fingerprints owned state while ignoring unrelated route changes', () => {
    const started = new URLSearchParams({
      issueId: 'item-1',
      panel: 'activity',
      view: 'delivery-review',
      'view.override': JSON.stringify({ filters: { keyword: 'release' } }),
      'view.v': String(TASK_VIEW_URL_STATE_SCHEMA_VERSION),
    })
    const unrelatedChange = new URLSearchParams(started)
    unrelatedChange.set('issueId', 'item-2')
    unrelatedChange.set('panel', 'relations')
    const ownedChange = new URLSearchParams(unrelatedChange)
    ownedChange.set('view', 'another-view')

    expect(createTaskViewUrlStateFingerprint(unrelatedChange))
      .toBe(createTaskViewUrlStateFingerprint(started))
    expect(createTaskViewUrlStateFingerprint(ownedChange))
      .not.toBe(createTaskViewUrlStateFingerprint(started))
  })
})
