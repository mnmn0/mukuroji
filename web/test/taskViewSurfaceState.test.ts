import { describe, expect, test } from 'bun:test'
import type { TaskViewDefinition } from '@mukuroji/contracts'
import {
  applyTaskViewDefinitionToTasks,
  canSetTeamTaskViewDefault,
  createBuiltInTaskViewDefinition,
  createTaskViewUrlOverride,
  filterTaskViewAudienceTeams,
  filterMyTasksByTaskViewDefinition,
  presentationSettingsToTaskViewDefinition,
  projectStateToTaskViewDefinition,
  taskViewDefinitionToPresentationSettings,
  taskViewDefinitionToProjectState,
  taskViewDefinitionToTeamState,
  teamStateToTaskViewDefinition,
} from '../src/task-views/model/taskViewSurfaceState'
import {
  groupTaskViewItems,
  resolveTaskViewTableColumnPlacements,
} from '../src/task-views/model/taskViewPresentation'
import { taskViewStoryTasks } from '../src/tasks/ui/TaskView.stories.fixtures'

describe('task-view surface adapters', () => {
  test('creates a complete and deterministic built-in definition per surface', () => {
    expect(createBuiltInTaskViewDefinition(
      'team',
      { kind: 'team', teamId: 'core-team' },
      'board',
    )).toEqual({
      surface: 'team',
      scope: { kind: 'team', teamId: 'core-team' },
      filters: {},
      layout: {
        mode: 'board',
        sort: [{ direction: 'asc', field: 'dueDate' }],
        columns: [
          { field: 'title' },
          { field: 'status' },
          { field: 'assignee' },
          { field: 'dueDate' },
          { field: 'priority' },
        ],
        density: 'comfortable',
        displayOptions: {
          showArchived: false,
          showAssigneeAvatars: true,
          showCompleted: true,
          showEmptyGroups: true,
          showSubItems: true,
          wrapText: false,
        },
      },
    })
  })

  test('appends surface-specific built-in columns without changing common defaults', () => {
    const definition = createBuiltInTaskViewDefinition(
      'project',
      { kind: 'project', projectId: 'refero' },
      'table',
      ['customFields'],
    )

    expect(definition.layout.columns.map((column) => column.field)).toEqual([
      'title',
      'status',
      'assignee',
      'dueDate',
      'priority',
      'customFields',
    ])
  })

  test('maps Project state through Team-qualified status identity and retains unrelated fields', () => {
    const definition = createProjectDefinition()
    const state = taskViewDefinitionToProjectState(definition)

    expect(state).toEqual({
      activeTab: 'board',
      assigneeFilter: 'sato@example.com',
      definitionFilter: {
        category: 'started',
        customFieldId: 'risk',
        customFieldValue: 'high',
      },
      dueDateFilter: 'upcoming',
      priorityFilter: 'high',
      searchQuery: 'launch',
      sortOrder: 'due-date-desc',
      statusFilter: 'core:team:active',
    })

    const next = projectStateToTaskViewDefinition(definition, {
      ...state,
      activeTab: 'calendar',
      searchQuery: '  release  ',
      statusFilter: 'design:team:review',
    })
    expect(next).toMatchObject({
      filters: {
        includeArchived: true,
        keyword: 'release',
        relationIds: ['blocks:launch'],
        workflowStatuses: [{ teamId: 'design:team', statusId: 'review' }],
      },
      layout: {
        mode: 'calendar',
        sort: [{ direction: 'desc', field: 'dueDate' }],
      },
    })
    expect(next.layout.columns).toEqual(definition.layout.columns)
  })

  test('retains an existing Project custom-field predicate when another control changes', () => {
    const definition = createProjectDefinition()
    const state = taskViewDefinitionToProjectState(definition)

    const next = projectStateToTaskViewDefinition(definition, {
      ...state,
      searchQuery: 'updated query',
    })

    expect(next.filters.customFields).toEqual(definition.filters.customFields)
  })

  test('maps a changed Project custom-field value to a canonical predicate', () => {
    const definition = createBuiltInTaskViewDefinition(
      'project',
      { kind: 'project', projectId: 'refero' },
      'table',
    )
    const next = projectStateToTaskViewDefinition(definition, {
      ...taskViewDefinitionToProjectState(definition),
      definitionFilter: {
        category: 'all',
        customFieldId: 'impact',
        customFieldValue: 'launch',
      },
    })

    expect(next.filters.customFields).toEqual([{
      fieldId: 'impact',
      operator: 'contains',
      value: 'launch',
    }])
  })

  test('removes cleared Project filters instead of creating no-op empty arrays', () => {
    const baseline = createBuiltInTaskViewDefinition(
      'project',
      { kind: 'project', projectId: 'refero' },
      'table',
    )
    const searched = projectStateToTaskViewDefinition(baseline, {
      ...taskViewDefinitionToProjectState(baseline),
      searchQuery: 'release',
    })
    const cleared = projectStateToTaskViewDefinition(searched, {
      ...taskViewDefinitionToProjectState(searched),
      searchQuery: '',
    })

    expect(cleared.filters).toEqual({})
    expect(createTaskViewUrlOverride(baseline, cleared)).toBeUndefined()
  })

  test('preserves secondary Project filters and sort rules when another control changes', () => {
    const definition = {
      ...createProjectDefinition(),
      filters: {
        ...createProjectDefinition().filters,
        assigneeUserIds: ['sato@example.com', 'tanaka@example.com'],
        customFields: [
          { fieldId: 'risk', operator: 'equals', value: 'high' },
          { fieldId: 'impact', operator: 'is-not-empty' },
        ],
        priorities: ['high', 'low'],
        workflowCategories: ['started', 'unstarted'],
        workflowStatuses: [
          { teamId: 'core:team', statusId: 'active' },
          { teamId: 'design:team', statusId: 'review' },
        ],
      },
      layout: {
        ...createProjectDefinition().layout,
        sort: [
          { direction: 'desc', field: 'dueDate' },
          { direction: 'asc', field: 'priority' },
        ],
      },
    } satisfies TaskViewDefinition
    const next = projectStateToTaskViewDefinition(definition, {
      ...taskViewDefinitionToProjectState(definition),
      searchQuery: 'updated',
    })

    expect(next.filters.assigneeUserIds).toEqual(definition.filters.assigneeUserIds)
    expect(next.filters.customFields).toEqual(definition.filters.customFields)
    expect(next.filters.priorities).toEqual(definition.filters.priorities)
    expect(next.filters.workflowCategories).toEqual(definition.filters.workflowCategories)
    expect(next.filters.workflowStatuses).toEqual(definition.filters.workflowStatuses)
    expect(next.layout.sort).toEqual(definition.layout.sort)
  })

  test('updates only the primary Project filter and due-date sort rule', () => {
    const definition = {
      ...createProjectDefinition(),
      filters: {
        ...createProjectDefinition().filters,
        workflowStatuses: [
          { teamId: 'core:team', statusId: 'active' },
          { teamId: 'design:team', statusId: 'review' },
        ],
      },
      layout: {
        ...createProjectDefinition().layout,
        sort: [
          { direction: 'desc', field: 'dueDate' },
          { direction: 'asc', field: 'priority' },
        ],
      },
    } satisfies TaskViewDefinition
    const next = projectStateToTaskViewDefinition(definition, {
      ...taskViewDefinitionToProjectState(definition),
      sortOrder: 'due-date-asc',
      statusFilter: 'core:team:review-ready',
    })

    expect(next.filters.workflowStatuses).toEqual([
      { teamId: 'core:team', statusId: 'review-ready' },
      { teamId: 'design:team', statusId: 'review' },
    ])
    expect(next.layout.sort).toEqual([
      { direction: 'asc', field: 'dueDate' },
      { direction: 'asc', field: 'priority' },
    ])
  })

  test('maps Team state without losing scope qualification or existing custom-field predicates', () => {
    const definition = {
      ...createProjectDefinition(),
      surface: 'team',
      scope: { kind: 'team', teamId: 'core-team' },
      layout: { ...createProjectDefinition().layout, mode: 'table' },
    } satisfies TaskViewDefinition
    const state = taskViewDefinitionToTeamState(definition)

    expect(state).toEqual({
      definitionFilter: {
        category: 'started',
        customFieldId: 'risk',
        customFieldValue: 'high',
      },
      searchQuery: 'launch',
      statusFilter: 'active',
      viewMode: 'table',
    })
    const next = teamStateToTaskViewDefinition(definition, {
      ...state,
      searchQuery: 'release',
      viewMode: 'board',
    })
    expect(next.filters.workflowStatuses).toEqual([
      { teamId: 'core-team', statusId: 'active' },
    ])
    expect(next.filters.customFields).toEqual(definition.filters.customFields)
    expect(next.layout.mode).toBe('board')
  })

  test('preserves secondary Team filters and omits cleared represented filters', () => {
    const projectDefinition = createProjectDefinition()
    const definition = {
      ...projectDefinition,
      surface: 'team',
      scope: { kind: 'team', teamId: 'core-team' },
      filters: {
        ...projectDefinition.filters,
        customFields: [
          { fieldId: 'risk', operator: 'equals', value: 'high' },
          { fieldId: 'impact', operator: 'is-not-empty' },
        ],
        workflowCategories: ['started', 'backlog'],
        workflowStatuses: [
          { teamId: 'core-team', statusId: 'active' },
          { teamId: 'core-team', statusId: 'review' },
        ],
      },
      layout: { ...projectDefinition.layout, mode: 'table' },
    } satisfies TaskViewDefinition
    const searched = teamStateToTaskViewDefinition(definition, {
      ...taskViewDefinitionToTeamState(definition),
      searchQuery: 'updated',
    })

    expect(searched.filters.customFields).toEqual(definition.filters.customFields)
    expect(searched.filters.workflowCategories).toEqual(
      definition.filters.workflowCategories,
    )
    expect(searched.filters.workflowStatuses).toEqual(definition.filters.workflowStatuses)

    const cleared = teamStateToTaskViewDefinition(definition, {
      ...taskViewDefinitionToTeamState(definition),
      definitionFilter: { category: 'all', customFieldId: '' },
      statusFilter: 'all',
    })
    expect(Object.hasOwn(cleared.filters, 'customFields')).toBe(false)
    expect(Object.hasOwn(cleared.filters, 'workflowCategories')).toBe(false)
    expect(Object.hasOwn(cleared.filters, 'workflowStatuses')).toBe(false)
  })

  test('limits Team save audiences to a Team-qualified scope', () => {
    const teams = [
      { id: 'core-team', name: 'Core' },
      { id: 'design-team', name: 'Design' },
    ]

    expect(filterTaskViewAudienceTeams(
      teams,
      { kind: 'team', teamId: 'core-team' },
    )).toEqual([{ id: 'core-team', name: 'Core' }])
    expect(filterTaskViewAudienceTeams(
      teams,
      { kind: 'project', projectId: 'refero', teamId: 'design-team' },
    )).toEqual([{ id: 'design-team', name: 'Design' }])
    expect(filterTaskViewAudienceTeams(
      teams,
      { kind: 'project', projectId: 'refero' },
    )).toEqual(teams)
  })

  test('matches Team-default controls to Workspace and scoped Project managers', () => {
    const roles = {
      'core-project': 'viewer',
      'delivery-project': 'manager',
      'outside-project': 'manager',
    } satisfies Record<string, 'manager' | 'member' | 'viewer'>

    expect(canSetTeamTaskViewDefault(true, [], {})).toBe(true)
    expect(canSetTeamTaskViewDefault(
      false,
      ['core-project', 'delivery-project'],
      roles,
    )).toBe(true)
    expect(canSetTeamTaskViewDefault(false, ['core-project'], roles)).toBe(false)
    expect(canSetTeamTaskViewDefault(false, [], roles)).toBe(false)
  })

  test('round-trips presentation settings while preserving selected column metadata', () => {
    const definition = createProjectDefinition()
    const settings = taskViewDefinitionToPresentationSettings(definition)

    expect(settings).toEqual({
      columns: [{ field: 'title', pin: 'start', width: 320 }, { field: 'status' }],
      density: 'compact',
      display: {
        showArchived: false,
        showAssigneeAvatars: true,
        showCompleted: false,
        showEmptyGroups: true,
        showSubtasks: true,
        wrapTitles: false,
      },
      groupBy: 'status',
      groupDirection: 'asc',
      sort: [{ direction: 'desc', field: 'dueDate' }],
      subgroupBy: 'assignee',
      subgroupDirection: 'desc',
    })

    const densityOnly = presentationSettingsToTaskViewDefinition(definition, {
      ...settings,
      density: 'comfortable',
    })
    expect(densityOnly.filters.includeArchived).toBe(true)
    expect(densityOnly.layout.displayOptions.showArchived).toBeUndefined()
    const reversedGroups = presentationSettingsToTaskViewDefinition(definition, {
      ...settings,
      groupDirection: 'desc',
      subgroupDirection: 'asc',
    })
    expect(reversedGroups.layout.group?.direction).toBe('desc')
    expect(reversedGroups.layout.subgroup?.direction).toBe('asc')

    const next = presentationSettingsToTaskViewDefinition(definition, {
      columns: [
        { field: 'status', width: 180 },
        { field: 'title', pin: 'start', width: 360 },
        { field: 'priority', pin: 'end', width: 140 },
      ],
      density: 'spacious',
      display: {
        showArchived: true,
        showAssigneeAvatars: false,
        showCompleted: true,
        showEmptyGroups: false,
        showSubtasks: false,
        wrapTitles: true,
      },
      groupBy: 'priority',
      sort: [
        { direction: 'asc', field: 'priority' },
        { direction: 'desc', field: 'dueDate' },
      ],
    })
    expect(next.layout.columns).toEqual([
      { field: 'status', width: 180 },
      { field: 'title', pin: 'start', width: 360 },
      { field: 'priority', pin: 'end', width: 140 },
    ])
    expect(next.filters.includeArchived).toBe(true)
    expect(next.layout).toMatchObject({
      density: 'spacious',
      displayOptions: {
        showArchived: true,
        showAssigneeAvatars: false,
        showCompleted: true,
        showEmptyGroups: false,
        showSubItems: false,
        wrapText: true,
      },
      group: { direction: 'asc', field: 'priority' },
    })
    expect(next.layout.subgroup).toBeUndefined()
    expect(next.layout.sort).toEqual([
      { direction: 'asc', field: 'priority' },
      { direction: 'desc', field: 'dueDate' },
    ])

    const archivedHidden = presentationSettingsToTaskViewDefinition(
      next,
      {
        ...taskViewDefinitionToPresentationSettings(next),
        display: {
          ...taskViewDefinitionToPresentationSettings(next).display,
          showArchived: false,
        },
      },
    )
    expect(archivedHidden.filters.includeArchived).toBe(false)
    expect(archivedHidden.layout.displayOptions.showArchived).toBe(false)
  })

  test('creates only changed URL sections and uses null to remove grouping', () => {
    const baseline = createProjectDefinition()

    expect(createTaskViewUrlOverride(baseline, {
      ...baseline,
      filters: { ...baseline.filters },
      layout: {
        ...baseline.layout,
        columns: baseline.layout.columns.map((column) => ({ ...column })),
      },
    })).toBeUndefined()
    expect(createTaskViewUrlOverride(baseline, {
      ...baseline,
      layout: {
        ...baseline.layout,
        density: 'spacious',
        group: undefined,
      },
    })).toEqual({
      layout: {
        density: 'spacious',
        group: null,
      },
    })
  })
})

describe('My Tasks task-view filtering', () => {
  test('shows archived Work Items only when both filter and display settings allow them', () => {
    const archivedTask = {
      ...taskViewStoryTasks[0],
      archivedAt: '2026-06-03T10:00:00.000Z',
    }
    const baseDefinition = createBuiltInTaskViewDefinition(
      'my-tasks',
      { kind: 'viewer' },
      'board',
    )
    /** Creates one archived-visibility combination from the same built-in baseline. */
    const createDefinition = (
      includeArchived: boolean,
      showArchived: boolean,
    ): TaskViewDefinition => ({
      ...baseDefinition,
      filters: { includeArchived },
      layout: {
        ...baseDefinition.layout,
        displayOptions: {
          ...baseDefinition.layout.displayOptions,
          showArchived,
        },
      },
    })

    expect(filterMyTasksByTaskViewDefinition(
      [archivedTask],
      createDefinition(true, false),
    )).toEqual([])
    expect(filterMyTasksByTaskViewDefinition(
      [archivedTask],
      createDefinition(false, true),
    )).toEqual([])
    expect(filterMyTasksByTaskViewDefinition(
      [archivedTask],
      createDefinition(true, true),
    ).map((task) => task.id)).toEqual(['wireframe'])
  })

  test('combines common identity, workflow, due-date, keyword, and display filters', () => {
    const matchingTask = {
      ...taskViewStoryTasks[0],
      customFieldValues: { risk: 'high' },
    }
    const definition = {
      ...createBuiltInTaskViewDefinition('my-tasks', { kind: 'viewer' }, 'board'),
      filters: {
        assigneeUserIds: ['sato@example.com'],
        customFields: [{ fieldId: 'risk', operator: 'is-not-empty' }],
        dueDatePreset: 'today',
        keyword: 'ワイヤー',
        priorities: ['high'],
        projectIds: ['refero'],
        teamIds: ['core-team'],
        workflowCategories: ['started'],
        workflowStatuses: [{ teamId: 'core-team', statusId: 'active' }],
      },
      layout: {
        ...createBuiltInTaskViewDefinition('my-tasks', { kind: 'viewer' }, 'board').layout,
        displayOptions: { showCompleted: false },
      },
    } satisfies TaskViewDefinition

    expect(filterMyTasksByTaskViewDefinition(
      [matchingTask, ...taskViewStoryTasks.slice(1)],
      definition,
      { now: new Date(2026, 5, 3, 12) },
    ).map((task) => task.id)).toEqual(['wireframe'])
  })

  test('supplements canonical My Tasks keyword fields without replacing raw matching', () => {
    const task = taskViewStoryTasks[0]
    const baseline = createBuiltInTaskViewDefinition(
      'my-tasks',
      { kind: 'viewer' },
      'board',
    )
    const localizedDefinition = {
      ...baseline,
      filters: { keyword: 'localized project name' },
    } satisfies TaskViewDefinition
    const rawDefinition = {
      ...baseline,
      filters: { keyword: task.assigneeUserId },
    } satisfies TaskViewDefinition

    expect(filterMyTasksByTaskViewDefinition([task], localizedDefinition, {
      keywordMatcher: (_candidate, normalizedKeyword) =>
        'Localized Project Name'.toLocaleLowerCase().includes(normalizedKeyword),
    })).toEqual([task])
    expect(filterMyTasksByTaskViewDefinition([task], rawDefinition, {
      keywordMatcher: () => false,
    })).toEqual([task])
  })

  test('requires every shared keyword term and normalizes full-width input', () => {
    const task = {
      ...taskViewStoryTasks[0],
      title: 'Release wireframe plan',
    }
    const definition = {
      ...createBuiltInTaskViewDefinition('my-tasks', { kind: 'viewer' }, 'board'),
      filters: { keyword: 'ＲＥＬＥＡＳＥ   wireframe' },
    } satisfies TaskViewDefinition

    expect(filterMyTasksByTaskViewDefinition([task], definition)).toEqual([task])
    expect(filterMyTasksByTaskViewDefinition([task], {
      ...definition,
      filters: { keyword: 'release missing' },
    })).toEqual([])
  })

  test('hides child Work Items when sub-items are disabled', () => {
    const childTask = {
      ...taskViewStoryTasks[0],
      id: 'child-task',
      relationIds: ['parent:parent-task'],
    }
    const definition = {
      ...createBuiltInTaskViewDefinition('project', { kind: 'project', projectId: 'refero' }, 'table'),
      layout: {
        ...createBuiltInTaskViewDefinition('project', { kind: 'project', projectId: 'refero' }, 'table').layout,
        displayOptions: { showSubItems: false },
      },
    } satisfies TaskViewDefinition

    expect(filterMyTasksByTaskViewDefinition([childTask], definition)).toEqual([])
  })

  test('matches legacy status filters only against workflow status IDs', () => {
    const task = taskViewStoryTasks[0]
    const definition = {
      ...createBuiltInTaskViewDefinition('my-tasks', { kind: 'viewer' }, 'board'),
      filters: { statuses: [task.statusCategory] },
    } satisfies TaskViewDefinition

    expect(filterMyTasksByTaskViewDefinition([task], definition)).toEqual([])
  })

  test('compares date-only upper bounds at day granularity', () => {
    const task = {
      ...taskViewStoryTasks[0],
      updatedAt: '2026-06-10T12:00:00.000Z',
    }
    const definition = {
      ...createBuiltInTaskViewDefinition('my-tasks', { kind: 'viewer' }, 'board'),
      filters: {
        date: { field: 'updatedAt', to: '2026-06-10' },
      },
    } satisfies TaskViewDefinition

    expect(filterMyTasksByTaskViewDefinition([task], definition)).toEqual([task])
  })

  test('evaluates canonical custom-field operators instead of treating them as no-ops', () => {
    const tasks = taskViewStoryTasks.slice(0, 2).map((task, index) => ({
      ...task,
      customFieldValues: { risk: index === 0 ? 'high' : 'low' },
    }))
    const definition = {
      ...createBuiltInTaskViewDefinition('my-tasks', { kind: 'viewer' }, 'board'),
      filters: {
        customFields: [{ fieldId: 'risk', operator: 'equals', value: 'high' }],
      },
    } satisfies TaskViewDefinition

    expect(filterMyTasksByTaskViewDefinition(tasks, definition).map((task) => task.id))
      .toEqual(['wireframe'])
  })

  test('evaluates today in each Work Item schedule timezone', () => {
    const task = {
      ...taskViewStoryTasks[0],
      schedule: {
        ...taskViewStoryTasks[0].schedule,
        calendarPolicy: {
          ...taskViewStoryTasks[0].schedule.calendarPolicy,
          timeZone: 'America/Los_Angeles',
        },
      },
    }
    const definition = {
      ...createBuiltInTaskViewDefinition('my-tasks', { kind: 'viewer' }, 'board'),
      filters: { dueDatePreset: 'today' },
    } satisfies TaskViewDefinition

    expect(filterMyTasksByTaskViewDefinition(
      [task],
      definition,
      { now: new Date('2026-06-04T01:00:00.000Z') },
    ).map((item) => item.id)).toEqual(['wireframe'])
  })

  test('consumes every multi-value filter and stable sort rule as one canonical result', () => {
    const firstTask = {
      ...taskViewStoryTasks[0],
      assigneeUserId: 'viewer-a',
      dueDate: '2026-06-04',
      priority: 'high',
      relationIds: ['launch'],
      workflowStatusId: 'active',
    }
    const secondTask = {
      ...taskViewStoryTasks[1],
      assigneeUserId: 'viewer-b',
      dueDate: '2026-06-03',
      priority: 'low',
      relationIds: ['launch'],
      workflowStatusId: 'review',
    }
    const completedTask = {
      ...taskViewStoryTasks[3],
      assigneeUserId: 'viewer-b',
      relationIds: ['launch'],
    }
    const definition = {
      ...createBuiltInTaskViewDefinition('project', { kind: 'project', projectId: 'refero' }, 'table'),
      filters: {
        assigneeUserIds: ['viewer-a', 'viewer-b'],
        priorities: ['high', 'low'],
        relationIds: ['launch'],
        workflowStatuses: [
          { teamId: 'core-team', statusId: 'active' },
          { teamId: 'core-team', statusId: 'review' },
        ],
      },
      layout: {
        ...createBuiltInTaskViewDefinition('project', { kind: 'project', projectId: 'refero' }, 'table').layout,
        displayOptions: { showCompleted: false },
        sort: [
          { direction: 'asc', field: 'priority' },
          { direction: 'desc', field: 'dueDate' },
        ],
      },
    } satisfies TaskViewDefinition

    expect(applyTaskViewDefinitionToTasks(
      [firstTask, secondTask, completedTask],
      definition,
    ).map((task) => task.id)).toEqual(['brand-guideline', 'wireframe'])
  })

  test('creates ordered non-empty groups while retaining item order inside each group', () => {
    const groups = groupTaskViewItems(
      taskViewStoryTasks.slice(0, 3),
      'assignee',
      (task) => ({ key: task.assigneeUserId, label: task.assigneeUserId }),
      'desc',
    )

    expect(groups.map((group) => ({
      ids: group.items.map((task) => task.id),
      label: group.label,
    }))).toEqual([
      { ids: ['brand-guideline'], label: 'suzuki@example.com' },
      { ids: ['wireframe', 'seo-research'], label: 'sato@example.com' },
    ])
  })

  test('resolves column order, widths, and cumulative pin offsets deterministically', () => {
    const placements = resolveTaskViewTableColumnPlacements([
      { field: 'title', pin: 'start', width: 320 },
      { field: 'status', pin: 'start', width: 150 },
      { field: 'assignee' },
      { field: 'priority', pin: 'end', width: 120 },
      { field: 'dueDate', pin: 'end' },
    ])

    expect(placements.map((placement) => placement.column.field)).toEqual([
      'title',
      'status',
      'assignee',
      'priority',
      'dueDate',
    ])
    expect(placements.map((placement) => placement.width)).toEqual([
      320,
      150,
      160,
      120,
      160,
    ])
    expect(placements[0]?.startOffset).toBe(0)
    expect(placements[1]?.startOffset).toBe(320)
    expect(placements[3]?.endOffset).toBe(160)
    expect(placements[4]?.endOffset).toBe(0)
  })
})

/** Creates a rich Project definition used to verify lossless surface adaptation. */
function createProjectDefinition(): TaskViewDefinition {
  return {
    surface: 'project',
    scope: { kind: 'project', projectId: 'refero', teamId: 'core:team' },
    filters: {
      assigneeUserIds: ['sato@example.com'],
      customFields: [{ fieldId: 'risk', operator: 'equals', value: 'high' }],
      dueDatePreset: 'upcoming',
      includeArchived: true,
      keyword: 'launch',
      priorities: ['high'],
      relationIds: ['blocks:launch'],
      workflowCategories: ['started'],
      workflowStatuses: [{ teamId: 'core:team', statusId: 'active' }],
    },
    layout: {
      mode: 'board',
      group: { direction: 'asc', field: 'status' },
      subgroup: { direction: 'desc', field: 'assignee' },
      sort: [{ direction: 'desc', field: 'dueDate' }],
      columns: [{ field: 'title', pin: 'start', width: 320 }, { field: 'status' }],
      density: 'compact',
      displayOptions: {
        showAssigneeAvatars: true,
        showCompleted: false,
        showSubItems: true,
        wrapText: false,
      },
    },
  }
}
