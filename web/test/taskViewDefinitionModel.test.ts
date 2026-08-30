import { describe, expect, test } from 'bun:test'
import type { TaskViewDefinition } from '@mukuroji/contracts'
import {
  applyTaskViewUrlOverride,
  resolveTaskViewDefinition,
  sanitizeTaskViewDefinition,
} from '../src/task-views/model/taskViewDefinition'

const builtInDefinition = {
  surface: 'project',
  scope: { kind: 'project', projectId: 'project-1', teamId: 'team-1' },
  filters: {
    keyword: 'built in',
    statuses: ['todo'],
    workflowStatuses: [{ teamId: 'team-1', statusId: 'todo' }],
  },
  layout: {
    mode: 'table',
    sort: [{ field: 'title', direction: 'asc' }],
    columns: [{ field: 'title', width: 280 }, { field: 'status' }],
    density: 'compact',
    displayOptions: { showCompleted: false, wrapText: false },
  },
} satisfies TaskViewDefinition

const teamDefaultDefinition = {
  ...builtInDefinition,
  filters: { keyword: 'team default' },
  layout: { ...builtInDefinition.layout, mode: 'board' },
} satisfies TaskViewDefinition

const personalDefaultDefinition = {
  ...builtInDefinition,
  filters: { keyword: 'personal default' },
  layout: { ...builtInDefinition.layout, mode: 'list', density: 'comfortable' },
} satisfies TaskViewDefinition

const selectedDefinition = {
  ...builtInDefinition,
  filters: { keyword: 'selected view' },
  layout: {
    ...builtInDefinition.layout,
    mode: 'calendar',
    group: { field: 'status', direction: 'asc' },
  },
} satisfies TaskViewDefinition

describe('task view definition resolution', () => {
  test('uses explicit selection over defaults and applies only the URL override as a patch', () => {
    const resolved = resolveTaskViewDefinition({
      builtIn: builtInDefinition,
      teamDefault: teamDefaultDefinition,
      personalDefault: personalDefaultDefinition,
      selectedView: selectedDefinition,
      urlOverride: {
        filters: { keyword: 'temporary' },
        layout: {
          mode: 'gantt',
          group: null,
          displayOptions: { showCompleted: true },
        },
      },
    })

    expect(resolved.baseSource).toBe('selected-view')
    expect(resolved.source).toBe('url-override')
    expect(resolved.appliedSources).toEqual(['selected-view', 'url-override'])
    expect(resolved.definition.filters).toEqual({ keyword: 'temporary' })
    expect(resolved.definition.layout.mode).toBe('gantt')
    expect(resolved.definition.layout.group).toBeUndefined()
    expect(resolved.definition.layout.displayOptions).toEqual({
      showCompleted: true,
      wrapText: false,
    })
    expect(selectedDefinition.layout.group).toEqual({ field: 'status', direction: 'asc' })
  })

  test('selects personal, Team, and built-in complete definitions in precedence order', () => {
    expect(resolveTaskViewDefinition({
      builtIn: builtInDefinition,
      teamDefault: teamDefaultDefinition,
      personalDefault: personalDefaultDefinition,
    })).toMatchObject({
      baseSource: 'personal-default',
      source: 'personal-default',
      definition: { filters: { keyword: 'personal default' } },
    })
    expect(resolveTaskViewDefinition({
      builtIn: builtInDefinition,
      teamDefault: teamDefaultDefinition,
    }).baseSource).toBe('team-default')
    expect(resolveTaskViewDefinition({ builtIn: builtInDefinition }).baseSource).toBe('built-in')
  })

  test('detaches nested filter and layout arrays when applying an override', () => {
    const override = {
      filters: {
        customFields: [{ fieldId: 'risk', operator: 'equals', value: ['high'] }],
      },
      layout: { columns: [{ field: 'title' }], sort: [{ field: 'title', direction: 'desc' }] },
    } satisfies Parameters<typeof applyTaskViewUrlOverride>[1]

    const effective = applyTaskViewUrlOverride(builtInDefinition, override)

    expect(effective).not.toBe(builtInDefinition)
    expect(effective.filters).not.toBe(override.filters)
    expect(effective.layout.columns).not.toBe(override.layout.columns)
    expect(effective.filters.customFields?.[0]?.value).toEqual(['high'])
  })
})

describe('task view definition migration and sanitization', () => {
  const options = {
    canRead: true,
    expectedSurface: 'project',
    expectedScope: { kind: 'project', projectId: 'project-1', teamId: 'team-1' },
    layoutModes: ['table', 'board'],
    fields: ['title', 'status', 'custom:visible'],
    columns: ['title', 'status'],
    workflowStatuses: [{ teamId: 'team-1', statusId: 'todo' }],
    legacyStatusIds: ['todo'],
    requiredColumns: ['status'],
    fallback: builtInDefinition,
  } satisfies Parameters<typeof sanitizeTaskViewDefinition>[1]

  test('removes unknown field and workflow references and resets unsupported presentation state', () => {
    const result = sanitizeTaskViewDefinition({
      surface: 'project',
      scope: { kind: 'project', projectId: 'project-1', teamId: 'team-1' },
      filters: {
        statuses: ['todo', 'removed-status'],
        workflowStatuses: [
          { teamId: 'team-1', statusId: 'todo' },
          { teamId: 'team-1', statusId: 'deleted' },
        ],
        customFields: [
          { fieldId: 'visible', operator: 'equals', value: 'high' },
          { fieldId: 'deleted', operator: 'equals', value: true },
        ],
      },
      layout: {
        mode: 'mind-map',
        group: { field: 'custom:deleted', direction: 'asc' },
        subgroup: { field: 'status', direction: 'desc' },
        sort: [
          { field: 'title', direction: 'asc' },
          { field: 'custom:deleted', direction: 'desc' },
        ],
        columns: [{ field: 'title' }, { field: 'custom:deleted' }],
        density: 'giant',
        displayOptions: { showCompleted: true, oldOption: true },
      },
    }, options)

    expect(result.didFallback).toBe(false)
    expect(result.definition.filters.statuses).toEqual(['todo'])
    expect(result.definition.filters.workflowStatuses).toEqual([
      { teamId: 'team-1', statusId: 'todo' },
    ])
    expect(result.definition.filters.customFields?.map((filter) => filter.fieldId))
      .toEqual(['visible'])
    expect(result.definition.layout).toMatchObject({
      mode: 'table',
      subgroup: { field: 'status', direction: 'desc' },
      sort: [{ field: 'title', direction: 'asc' }],
      columns: [{ field: 'status' }, { field: 'title' }],
      density: 'compact',
      displayOptions: { showCompleted: true },
    })
    expect(result.definition.layout.group).toBeUndefined()
    expect(result.warnings.map((warning) => [warning.code, warning.section])).toEqual(
      expect.arrayContaining([
        ['invalid-layout', 'layout'],
        ['deleted-custom-field', 'group'],
        ['deleted-custom-field', 'sort'],
        ['deleted-custom-field', 'column'],
        ['deleted-custom-field', 'filter'],
        ['deleted-workflow-status', 'filter'],
        ['invalid-layout', 'density'],
        ['invalid-layout', 'display-option'],
      ]),
    )
    expect(result.warnings.every((warning) => warning.referenceId === undefined)).toBe(true)
  })

  test('keeps legacy status filters broad while checking type-qualified filters exactly', () => {
    const result = sanitizeTaskViewDefinition({
      ...builtInDefinition,
      filters: {
        workflowStatuses: [
          { teamId: 'team-1', statusId: 'todo' },
          { teamId: 'team-1', workItemTypeId: 'bug', statusId: 'todo' },
          { teamId: 'team-1', workItemTypeId: 'feature', statusId: 'todo' },
        ],
      },
    }, {
      ...options,
      workflowStatuses: [
        { teamId: 'team-1', workItemTypeId: 'bug', statusId: 'todo' },
      ],
    })

    expect(result.definition.filters.workflowStatuses).toEqual([
      { teamId: 'team-1', statusId: 'todo' },
      { teamId: 'team-1', workItemTypeId: 'bug', statusId: 'todo' },
    ])
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'deleted-workflow-status', section: 'filter' }),
    ])
  })

  test('keeps custom filters while removing raw custom layout fields from a URL override', () => {
    const overridden = applyTaskViewUrlOverride(builtInDefinition, {
      filters: {
        customFields: [{ fieldId: 'visible', operator: 'equals', value: 'high' }],
      },
      layout: {
        group: { field: 'visible', direction: 'asc' },
        sort: [{ field: 'visible', direction: 'desc' }],
      },
    })

    const result = sanitizeTaskViewDefinition(overridden, options)

    expect(result.definition.filters.customFields).toEqual([
      { fieldId: 'visible', operator: 'equals', value: 'high' },
    ])
    expect(result.definition.layout.group).toBeUndefined()
    expect(result.definition.layout.sort).toEqual([])
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'deleted-custom-field', section: 'group' }),
      expect.objectContaining({ code: 'deleted-custom-field', section: 'sort' }),
    ]))
  })

  test('uses the whole permission-safe fallback for denied or mismatched scope state', () => {
    const denied = sanitizeTaskViewDefinition(selectedDefinition, {
      ...options,
      canRead: false,
    })
    const wrongScope = sanitizeTaskViewDefinition({
      ...selectedDefinition,
      scope: { kind: 'project', projectId: 'other-project' },
    }, options)

    expect(denied).toEqual({
      definition: builtInDefinition,
      didFallback: true,
      warnings: [{
        code: 'permission-redacted',
        section: 'scope',
        fallback: 'unavailable',
      }],
    })
    expect(wrongScope.didFallback).toBe(true)
    expect(wrongScope.warnings[0]?.code).toBe('inaccessible-scope')
  })
})
