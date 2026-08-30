import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_WORK_ITEM_TYPE,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type ResolvedWorkItemConfiguration,
  type WorkflowStatusDefinition,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../src/projects/api/directory'
import type { MessageKey } from '../src/shared/i18n/i18n'
import type { WorkspaceMember } from '../src/workspace/api/access'
import type { CanonicalWorkItem } from '../src/tasks/api/tasks'
import {
  createDefaultDueDateTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
  deriveTaskScheduleDueDate,
} from '../src/tasks/model/taskSchedule'
import {
  createAssigneeFilterOptions,
  createBulkProjectOptions,
  createBulkOperationSelection,
  createTaskInversePatch,
  createProjectStatusTestToken,
  createProjectTaskStatusColumns,
  createTaskCalendarModel,
  createTaskKey,
  createTaskPersonLabels,
  createTaskSummary,
  filterAndSortProjectTasks,
  findTaskBySelection,
  formatTaskDateInputValue,
  applyTaskPatchOptimistically,
  isTaskInProjectStatusColumn,
  matchesProjectTaskKeyword,
  isTaskOverdue,
  matchesTaskDueDateFilter,
  parseTaskDueDate,
  resolveEffectiveDefinitionFilter,
  resolveEffectiveStatusFilter,
  resolveLatestTaskSnapshot,
  resolveDueDateFilterLabelKey,
  resolveProjectTaskConfiguration,
  resolveTaskAssigneeFilterValue,
  resolveTaskCustomFieldEntries,
  resolveTaskCustomFieldSearchValues,
  resolveTaskPriority,
  resolveTaskSortOrderLabelKey,
  sortTasksByDueDate,
  taskDueDateFilters,
  taskPriorities,
  taskSortOrders,
  taskTabs,
} from '../src/tasks/model/taskView'

describe('task view constants and input normalization', () => {
  test('exposes the existing tabs, priorities, due-date filters, and sort orders', () => {
    expect(taskTabs).toEqual(['table', 'board', 'gantt', 'calendar', 'file', 'permissions'])
    expect(taskPriorities).toEqual(['high', 'medium', 'low'])
    expect(taskDueDateFilters).toEqual(['all', 'overdue', 'today', 'upcoming', 'no-date'])
    expect(taskSortOrders).toEqual(['due-date-asc', 'due-date-desc'])
  })

  test('narrows supported priorities and defaults invalid values to medium', () => {
    expect(resolveTaskPriority('high')).toBe('high')
    expect(resolveTaskPriority('low')).toBe('low')
    expect(resolveTaskPriority('urgent')).toBe('medium')
    expect(resolveTaskPriority(null)).toBe('medium')
    expect(resolveTaskPriority({ value: 'high' })).toBe('medium')
  })

  test('formats date input values from local calendar components', () => {
    expect(formatTaskDateInputValue({
      getDate: () => 4,
      getFullYear: () => 2027,
      getMonth: () => 0,
    })).toBe('2027-01-04')
  })

  test('maps due-date filter and sort values to their existing message keys', () => {
    expect(taskDueDateFilters.map(resolveDueDateFilterLabelKey)).toEqual([
      'tasks.filter.dueDateAll',
      'tasks.filter.dueDateOverdue',
      'tasks.filter.dueDateToday',
      'tasks.filter.dueDateUpcoming',
      'tasks.filter.dueDateNoDate',
    ])
    expect(taskSortOrders.map(resolveTaskSortOrderLabelKey)).toEqual([
      'tasks.sort.dueDateAsc',
      'tasks.sort.dueDateDesc',
    ])
  })
})

describe('task selection model', () => {
  test('uses Project, Team, and local Work Item ID as the selection identity', () => {
    const coreTask = createTask({
      assignedProjectId: 'shared-project',
      id: 'same-local-id',
      teamId: 'core-team',
    })
    const designTask = createTask({
      assignedProjectId: 'shared-project',
      id: 'same-local-id',
      teamId: 'design-team',
    })
    const unassignedTask = createTask({
      assignedProjectId: undefined,
      id: 'same-local-id',
      teamId: 'core-team',
    })

    expect(createTaskKey(coreTask)).toBe('shared-project:core-team:same-local-id')
    expect(createTaskKey(designTask)).toBe('shared-project:design-team:same-local-id')
    expect(createTaskKey(unassignedTask)).toBe(':core-team:same-local-id')
  })

  test('disambiguates route selection by Team and snapshots bulk-operation revision', () => {
    const coreTask = createTask({ id: 'same-local-id', revision: 4, teamId: 'core-team' })
    const designTask = createTask({ id: 'same-local-id', revision: 7, teamId: 'design-team' })

    expect(findTaskBySelection([coreTask, designTask], 'same-local-id')).toBe(coreTask)
    expect(findTaskBySelection([coreTask, designTask], 'same-local-id', 'design-team'))
      .toBe(designTask)
    expect(findTaskBySelection([coreTask, designTask], undefined, 'core-team')).toBeUndefined()
    expect(createBulkOperationSelection(designTask, translateTaskLabel)).toEqual({
      expectedRevision: 7,
      label: designTask.title,
      selectionKey: createTaskKey(designTask),
      teamId: 'design-team',
      workItemId: 'same-local-id',
    })
  })

  test('uses the greatest matching revision for detail rendering and mutation', () => {
    const listTask = createTask({ id: 'same-local-id', revision: 4, teamId: 'core-team' })
    const newerDetail = createTask({ id: 'same-local-id', revision: 5, teamId: 'core-team' })
    const olderDetail = createTask({ id: 'same-local-id', revision: 3, teamId: 'core-team' })
    const otherTeamDetail = createTask({
      id: 'same-local-id',
      revision: 8,
      teamId: 'design-team',
    })

    expect(resolveLatestTaskSnapshot(listTask, newerDetail)).toBe(newerDetail)
    expect(resolveLatestTaskSnapshot(listTask, olderDetail)).toBe(listTask)
    expect(resolveLatestTaskSnapshot(listTask, otherTeamDetail)).toBe(listTask)
    expect(resolveLatestTaskSnapshot(undefined, newerDetail)).toBeUndefined()
  })
})

describe('contextual task mutations', () => {
  test('projects inline changes optimistically and restores touched fields for undo', () => {
    const baseConfiguration = createConfiguration('core-team', [
      createStatus('todo', 'To do', 'unstarted', 0),
      createStatus('active', 'In progress', 'started', 1),
    ], [
      {
        id: 'risk',
        name: 'Risk',
        options: [{ id: 'low', name: 'Low', sortOrder: 0 }],
        required: false,
        sortOrder: 0,
        type: 'select',
      },
      {
        id: 'note',
        name: 'Note',
        required: false,
        sortOrder: 1,
        type: 'text',
      },
    ])
    const configuration: WorkItemConfiguration = {
      ...baseConfiguration,
      workItemTypes: [
        {
          ...DEFAULT_WORK_ITEM_TYPE,
          defaultWorkflowId: baseConfiguration.workflow.id,
          id: 'bug',
          name: 'Bug',
          sortOrder: 1,
        },
        {
          ...DEFAULT_WORK_ITEM_TYPE,
          defaultWorkflowId: baseConfiguration.workflow.id,
          id: 'feature',
          name: 'Feature',
          sortOrder: 2,
        },
      ],
    }
    const task = createTask({
      customFieldValues: { note: 'Keep this', risk: 'low' },
      schedule: createDefaultDueDateTaskSchedule('2026-07-23'),
      workItemTypeId: 'bug',
      workflowStatusId: 'todo',
    })
    const patch = {
      customFieldValues: { note: null, risk: 'low' },
      schedule: createDefaultDueDateTaskSchedule('2026-07-25'),
      workItemTypeId: 'feature',
      workflowStatusId: 'active',
    }

    const optimisticTask = applyTaskPatchOptimistically(task, patch, configuration)
    const inversePatch = createTaskInversePatch(task, patch)

    expect(optimisticTask).toMatchObject({
      customFieldValues: { risk: 'low' },
      dueDate: '2026-07-25',
      schedule: createDefaultDueDateTaskSchedule('2026-07-25'),
      statusCategory: 'started',
      workItemTypeId: 'feature',
      workflowStatusId: 'active',
    })
    expect(optimisticTask.customFieldValues).not.toHaveProperty('note')
    expect(inversePatch).toEqual({
      customFieldValues: { note: 'Keep this', risk: 'low' },
      schedule: createDefaultDueDateTaskSchedule('2026-07-23'),
      workItemTypeId: 'bug',
      workflowStatusId: 'todo',
    })
  })
})

describe('task due-date model', () => {
  const referenceDay = new Date(2026, 6, 23, 15, 30)

  test('parses canonical ISO dates at local midnight without mutating the reference day', () => {
    const parsed = parseTaskDueDate('2026-07-23')
    const referenceTime = referenceDay.getTime()

    expect(parsed?.getFullYear()).toBe(2026)
    expect(parsed?.getMonth()).toBe(6)
    expect(parsed?.getDate()).toBe(23)
    expect(parsed?.getHours()).toBe(0)
    expect(parseTaskDueDate('')).toBeNull()
    expect(parseTaskDueDate('2026-00-23')).toBeNull()
    expect(parseTaskDueDate('2026/07/23')).toBeNull()
    expect(isTaskOverdue(createTask({
      schedule: createDefaultDueDateTaskSchedule('2026-07-22'),
    }), referenceDay)).toBe(true)
    expect(referenceDay.getTime()).toBe(referenceTime)
  })

  test('excludes completed tasks and applies overdue, upcoming, and no-date boundaries', () => {
    const overdue = createTask({
      schedule: createDefaultDueDateTaskSchedule('2026-07-22'),
      statusCategory: 'started',
    })
    const today = createTask({
      schedule: createDefaultDueDateTaskSchedule('2026-07-23'),
      statusCategory: 'unstarted',
    })
    const completed = createTask({
      schedule: createDefaultDueDateTaskSchedule('2026-07-22'),
      statusCategory: 'completed',
    })
    const undated = createTask({ schedule: createDefaultUnscheduledTaskSchedule() })

    expect(isTaskOverdue(overdue, referenceDay)).toBe(true)
    expect(isTaskOverdue(today, referenceDay)).toBe(false)
    expect(isTaskOverdue(completed, referenceDay)).toBe(false)
    expect(matchesTaskDueDateFilter(overdue, 'overdue', referenceDay)).toBe(true)
    expect(matchesTaskDueDateFilter(today, 'today', referenceDay)).toBe(true)
    expect(matchesTaskDueDateFilter(today, 'upcoming', referenceDay)).toBe(true)
    expect(matchesTaskDueDateFilter(completed, 'overdue', referenceDay)).toBe(false)
    expect(matchesTaskDueDateFilter(completed, 'upcoming', referenceDay)).toBe(false)
    expect(matchesTaskDueDateFilter(undated, 'no-date', referenceDay)).toBe(true)
    expect(matchesTaskDueDateFilter(undated, 'all', referenceDay)).toBe(true)
  })

  test('uses each canonical schedule timezone for overdue boundaries', () => {
    const instant = new Date('2026-07-11T15:00:00.000Z')
    const schedule = createDefaultDueDateTaskSchedule('2026-07-11')
    const tokyoTask = createTask({
      schedule: {
        ...schedule,
        calendarPolicy: { ...schedule.calendarPolicy, timeZone: 'Asia/Tokyo' },
      },
      statusCategory: 'started',
    })
    const newYorkTask = createTask({
      schedule: {
        ...schedule,
        calendarPolicy: { ...schedule.calendarPolicy, timeZone: 'America/New_York' },
      },
      statusCategory: 'started',
    })

    expect(isTaskOverdue(tokyoTask, instant)).toBe(true)
    expect(matchesTaskDueDateFilter(tokyoTask, 'overdue', instant)).toBe(true)
    expect(isTaskOverdue(newYorkTask, instant)).toBe(false)
    expect(matchesTaskDueDateFilter(newYorkTask, 'upcoming', instant)).toBe(true)
  })

  test('preserves due-date ordering, ID tie-breakers, source order, and missing-date placement', () => {
    const source = [
      createTask({
        id: 'same-date-b',
        schedule: createDefaultDueDateTaskSchedule('2026-07-23'),
      }),
      createTask({ id: 'missing', schedule: createDefaultUnscheduledTaskSchedule() }),
      createTask({
        id: 'later',
        schedule: createDefaultDueDateTaskSchedule('2026-07-25'),
      }),
      createTask({
        id: 'same-date-a',
        schedule: createDefaultDueDateTaskSchedule('2026-07-23'),
      }),
    ]

    expect(sortTasksByDueDate(source, 'due-date-asc').map((task) => task.id)).toEqual([
      'same-date-a',
      'same-date-b',
      'later',
      'missing',
    ])
    expect(sortTasksByDueDate(source, 'due-date-desc').map((task) => task.id)).toEqual([
      'missing',
      'later',
      'same-date-a',
      'same-date-b',
    ])
    expect(source.map((task) => task.id)).toEqual([
      'same-date-b',
      'missing',
      'later',
      'same-date-a',
    ])
  })
})

describe('task assignee and person labels', () => {
  test('deduplicates assignee identities and sorts their labels after the all option', () => {
    const tasks = [
      createTask({ assigneeName: 'Zulu', assigneeUserId: 'z-user', id: 'z-task' }),
      createTask({ assigneeName: 'Alpha', assigneeUserId: 'a-user', id: 'a-task' }),
      createTask({ assigneeName: 'Changed duplicate', assigneeUserId: 'z-user', id: 'z-task-2' }),
    ]

    expect(resolveTaskAssigneeFilterValue(tasks[0]!, translateTaskLabel)).toBe('z-user')
    expect(createAssigneeFilterOptions(tasks, translateTaskLabel)).toEqual([
      { label: 'All assignees', value: 'all' },
      { label: 'Alpha', value: 'a-user' },
      { label: 'Zulu', value: 'z-user' },
    ])
  })

  test('maps Workspace member emails to names with an email fallback', () => {
    const members: WorkspaceMember[] = [
      createWorkspaceMember('alpha@example.com', 'Alpha'),
      createWorkspaceMember('fallback@example.com'),
      createWorkspaceMember('alpha@example.com', 'Latest Alpha'),
    ]

    expect(createTaskPersonLabels(members)).toEqual({
      'alpha@example.com': 'Latest Alpha',
      'fallback@example.com': 'fallback@example.com',
    })
  })

  test('deduplicates bulk Project options and sorts the last-seen labels', () => {
    const teams: ProjectDirectoryTeam[] = [
      {
        id: 'core-team',
        name: 'Core',
        projects: [
          { id: 'shared', name: 'Alpha shared' },
          { id: 'core-only', name: 'Beta core' },
        ],
      },
      {
        id: 'design-team',
        name: 'Design',
        projects: [{ id: 'shared', name: 'Zeta shared' }],
      },
    ]

    expect(createBulkProjectOptions(teams)).toEqual([
      { id: 'core-only', label: 'Beta core' },
      { id: 'shared', label: 'Zeta shared' },
    ])
  })
})

describe('Team-scoped task status columns and configuration', () => {
  const coreConfiguration = createConfiguration('core-team', [
    createStatus('review', 'Review', 'started', 2),
    createStatus('todo', 'To do', 'unstarted', 1),
  ])
  const designConfiguration = createConfiguration('design-team', [
    createStatus('todo', 'To do', 'unstarted', 0),
  ])
  const configurationsByTeam: Record<string, ResolvedWorkItemConfiguration> = {
    'core-team': { configuration: coreConfiguration },
    'design-team': { configuration: designConfiguration },
  }
  const teams: ProjectDirectoryTeam[] = [
    { id: 'core-team', name: 'Core', projects: [] },
    { id: 'design-team', name: 'Design', projects: [] },
  ]

  test('prefers Team configuration and only uses fallback for an empty aggregate map', () => {
    const task = createTask({ teamId: 'core-team' })

    expect(resolveProjectTaskConfiguration(task, configurationsByTeam, designConfiguration))
      .toBe(coreConfiguration)
    expect(resolveProjectTaskConfiguration(task, {}, designConfiguration)).toBe(designConfiguration)
    expect(resolveProjectTaskConfiguration(
      createTask({ teamId: 'missing-team' }),
      configurationsByTeam,
      designConfiguration,
    )).toBeUndefined()
  })

  test('includes configured Teams without tasks and distinguishes equal status IDs by Team', () => {
    const coreTask = createTask({ teamId: 'core-team', workflowStatusId: 'todo' })
    const columns = createProjectTaskStatusColumns(
      [coreTask],
      configurationsByTeam,
      teams,
    )

    expect(columns.map((column) => ({ key: column.key, label: column.label }))).toEqual([
      { key: 'core-team\u0000default\u0000todo', label: 'Core · To do' },
      { key: 'core-team\u0000default\u0000review', label: 'Core · Review' },
      { key: 'design-team\u0000default\u0000todo', label: 'Design · To do' },
    ])
    expect(isTaskInProjectStatusColumn(coreTask, columns[0]!)).toBe(true)
    expect(isTaskInProjectStatusColumn(coreTask, columns[2]!)).toBe(false)
    expect(createProjectStatusTestToken('Core Team:Review / Ready')).toBe(
      'core-team-review-ready',
    )
  })

  test('includes type-specific workflow statuses and keeps equal status IDs isolated by type', () => {
    const typedConfiguration: WorkItemConfiguration = {
      ...coreConfiguration,
      workflows: [
        coreConfiguration.workflow,
        {
          id: 'bug-workflow',
          initialStatusId: 'todo',
          name: 'Bug workflow',
          statuses: [createStatus('todo', 'Investigate', 'started', 0)],
          transitions: [],
        },
      ],
      workItemTypes: [{
        ...DEFAULT_WORK_ITEM_TYPE,
        defaultWorkflowId: 'bug-workflow',
        id: 'bug',
        name: 'Bug',
        sortOrder: 1,
      }],
    }
    const typedTask = createTask({
      teamId: 'core-team',
      workItemTypeId: 'bug',
      workflowStatusId: 'todo',
    })
    const columns = createProjectTaskStatusColumns(
      [typedTask],
      { 'core-team': { configuration: typedConfiguration } },
      teams,
    )

    expect(columns.map((column) => ({ key: column.key, label: column.label }))).toEqual([
      { key: 'core-team\u0000default\u0000todo', label: 'Work Item · To do' },
      { key: 'core-team\u0000default\u0000review', label: 'Work Item · Review' },
      { key: 'core-team\u0000bug\u0000todo', label: 'Bug · Investigate' },
    ])
    expect(isTaskInProjectStatusColumn(typedTask, columns[0]!)).toBe(false)
    expect(isTaskInProjectStatusColumn(typedTask, columns[2]!)).toBe(true)
  })

  test('uses a single unprefixed fallback Team workflow when explicitly scoped', () => {
    const columns = createProjectTaskStatusColumns(
      [createTask({ teamId: 'core-team' })],
      configurationsByTeam,
      teams,
      'core-team',
      coreConfiguration,
    )

    expect(columns.map((column) => column.label)).toEqual(['To do', 'Review'])
  })
})

describe('task custom-field display, filters, and sorting', () => {
  const configuration = createConfiguration('core-team', [
    createStatus('todo', 'Ready', 'unstarted', 0),
    createStatus('done', 'Done', 'completed', 1),
  ], [
    {
      id: 'risk',
      name: 'Risk level',
      options: [
        { id: 'low', name: 'Low', sortOrder: 0 },
        { id: 'urgent', name: 'Urgent', sortOrder: 1 },
      ],
      required: false,
      sortOrder: 1,
      type: 'select',
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      required: false,
      sortOrder: 0,
      type: 'person',
    },
    {
      id: 'private-note',
      name: 'Private note',
      projectIds: ['other-project'],
      required: false,
      sortOrder: 2,
      type: 'text',
    },
  ])
  const resolvedConfigurations: Record<string, ResolvedWorkItemConfiguration> = {
    'core-team': { configuration },
  }
  const columns = createProjectTaskStatusColumns(
    [],
    resolvedConfigurations,
    [{ id: 'core-team', name: 'Core', projects: [] }],
  )

  test('formats applicable custom fields in configured order and flattens search text', () => {
    const task = createTask({
      customFieldValues: {
        'private-note': 'Hidden',
        reviewer: 'reviewer@example.com',
        risk: 'urgent',
      },
    })
    const personLabels = { 'reviewer@example.com': 'Review Person' }
    const entries = resolveTaskCustomFieldEntries(
      task,
      configuration,
      'en',
      personLabels,
      translateTaskLabel,
    )

    expect(entries.map(({ definition, value }) => [definition.id, value])).toEqual([
      ['reviewer', 'Review Person'],
      ['risk', 'Urgent'],
    ])
    expect(
      resolveTaskCustomFieldSearchValues(
        task,
        configuration,
        'en',
        personLabels,
        translateTaskLabel,
      ),
    ).toEqual([
      'Reviewer',
      'Review Person',
      'Risk level',
      'Urgent',
    ])
  })

  test('combines query, Team status, assignee, priority, date, and definition filters', () => {
    const matchingTask = createTask({
      assigneeName: 'Alpha Person',
      assigneeUserId: 'alpha-user',
      customFieldValues: { risk: 'urgent' },
      id: 'matching',
      priority: 'high',
      schedule: createDefaultDueDateTaskSchedule('2026-07-24'),
      statusCategory: 'unstarted',
      teamId: 'core-team',
      title: 'Release candidate',
      workflowStatusId: 'todo',
    })
    const wrongPriority = createTask({
      ...matchingTask,
      id: 'wrong-priority',
      priority: 'low',
    })
    const wrongStatus = createTask({
      ...matchingTask,
      id: 'wrong-status',
      statusCategory: 'completed',
      workflowStatusId: 'done',
    })

    const result = filterAndSortProjectTasks(
      [wrongStatus, wrongPriority, matchingTask],
      {
        assigneeFilter: 'alpha-user',
        configuration,
        configurationsByTeam: resolvedConfigurations,
        definitionFilter: {
          category: 'unstarted',
          customFieldId: 'risk',
          customFieldValue: 'urgent',
        },
        dueDateFilter: 'upcoming',
        locale: 'en',
        personLabels: {},
        priorityFilter: 'high',
        searchQuery: 'URGENT',
        sortOrder: 'due-date-asc',
        statusColumns: columns,
        statusFilter: 'core-team\u0000default\u0000todo',
        t: translateTaskLabel,
        today: new Date(2026, 6, 23, 12),
      },
    )

    expect(result.map((task) => task.id)).toEqual(['matching'])
  })

  test('matches Project task display labels, schedule dates, and formatted custom fields', () => {
    const task = createTask({
      customFieldValues: { risk: 'urgent' },
      priority: 'high',
      schedule: createDefaultDueDateTaskSchedule('2026-07-24'),
      workflowStatusId: 'todo',
    })
    const queries = ['ready', 'high', '2026-07-24', 'urgent']

    expect(queries.map((query) => matchesProjectTaskKeyword(
      task,
      query,
      configuration,
      resolvedConfigurations,
      'en',
      {},
      translateTaskLabel,
    ))).toEqual([true, true, true, true])
  })

  test('falls back from stale status and custom-field filters without losing category', () => {
    const validDefinitionFilter = { category: 'started', customFieldId: 'risk' }
    const staleDefinitionFilter = { category: 'started', customFieldId: 'removed' }

    expect(resolveEffectiveStatusFilter('core-team\u0000default\u0000todo', columns))
      .toBe('core-team\u0000default\u0000todo')
    expect(resolveEffectiveStatusFilter('removed-team:todo', columns)).toBe('all')
    expect(resolveEffectiveDefinitionFilter(validDefinitionFilter, configuration))
      .toBe(validDefinitionFilter)
    expect(resolveEffectiveDefinitionFilter(staleDefinitionFilter, configuration)).toEqual({
      category: 'started',
      customFieldId: '',
    })
  })
})

describe('task calendar and summary models', () => {
  test('groups equal due dates, sorts day values, and separates undated tasks', () => {
    const later = createTask({
      id: 'later',
      schedule: createDefaultDueDateTaskSchedule('2026-07-25'),
    })
    const first = createTask({
      id: 'first',
      schedule: createDefaultDueDateTaskSchedule('2026-07-23'),
    })
    const second = createTask({
      id: 'second',
      schedule: createDefaultDueDateTaskSchedule('2026-07-23'),
    })
    const undated = createTask({
      id: 'undated',
      schedule: createDefaultUnscheduledTaskSchedule(),
    })
    const whitespaceOnly = createTask({
      id: 'whitespace-only',
      schedule: createDefaultUnscheduledTaskSchedule(),
    })
    const model = createTaskCalendarModel([
      later,
      first,
      undated,
      whitespaceOnly,
      second,
    ])

    expect(model.days.map((day) => ({
      date: day.date,
      ids: day.items.map((task) => task.id),
    }))).toEqual([
      { date: '2026-07-23', ids: ['first', 'second'] },
      { date: '2026-07-25', ids: ['later'] },
    ])
    expect(model.unscheduledTasks).toEqual([undated, whitespaceOnly])
  })

  test('counts open, started, completed, and canceled categories consistently', () => {
    const tasks = [
      createTask({ id: 'backlog', statusCategory: 'backlog' }),
      createTask({ id: 'started', statusCategory: 'started' }),
      createTask({ id: 'done-a', statusCategory: 'completed' }),
      createTask({ id: 'done-b', statusCategory: 'completed' }),
      createTask({ id: 'canceled', statusCategory: 'canceled' }),
    ]

    expect(createTaskSummary(tasks)).toEqual({
      completionRate: 40,
      doneCount: 2,
      inProgressCount: 1,
      openCount: 2,
      totalCount: 5,
    })
    expect(createTaskSummary([])).toEqual({
      completionRate: 0,
      doneCount: 0,
      inProgressCount: 0,
      openCount: 0,
      totalCount: 0,
    })
  })
})

/**
 * Creates a canonical task fixture with focused overrides.
 *
 * @param overrides - Fields that differ from the default task fixture.
 * @returns A canonical Project task.
 */
function createTask(
  overrides: Omit<Partial<CanonicalWorkItem>, 'dueDate'> = {},
): CanonicalWorkItem {
  const schedule = overrides.schedule ?? createDefaultDueDateTaskSchedule('2026-07-23')

  return {
    assigneeUserId: 'user@example.com',
    createdAt: '2026-07-01T00:00:00.000Z',
    creatorMemberKey: 'creator@example.com',
    customFieldValues: {},
    dueDate: deriveTaskScheduleDueDate(schedule),
    id: 'task-1',
    priority: 'medium',
    relationIds: [],
    revision: 1,
    schedule,
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    source: 'dynamodb',
    statusCategory: 'unstarted',
    teamId: 'core-team',
    title: 'Task title',
    updatedAt: '2026-07-01T00:00:00.000Z',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'todo',
    ...overrides,
  }
}

/**
 * Creates a workflow status fixture.
 *
 * @param id - Workflow-local status ID.
 * @param name - Display name.
 * @param category - Canonical workflow category.
 * @param sortOrder - Configured display order.
 * @returns A workflow status definition.
 */
function createStatus(
  id: string,
  name: string,
  category: WorkflowStatusDefinition['category'],
  sortOrder: number,
): WorkflowStatusDefinition {
  return { category, id, name, sortOrder }
}

/**
 * Creates a Team-scoped Work Item configuration fixture.
 *
 * @param teamId - Team that owns the configuration.
 * @param statuses - Workflow statuses available to the Team.
 * @param customFields - Custom fields available to the Team.
 * @returns A complete Work Item configuration.
 */
function createConfiguration(
  teamId: string,
  statuses: WorkflowStatusDefinition[],
  customFields: WorkItemConfiguration['customFields'] = [],
): WorkItemConfiguration {
  return {
    customFields,
    revision: 1,
    schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    scopeId: teamId,
    scopeType: 'team',
    workflow: {
      id: `${teamId}-workflow`,
      initialStatusId: statuses[0]?.id ?? '',
      name: `${teamId} workflow`,
      statuses,
      transitions: [],
    },
  }
}

/**
 * Creates a Workspace member fixture for person-label mapping.
 *
 * @param email - Member email and stable key.
 * @param name - Optional display name.
 * @returns A complete Workspace member.
 */
function createWorkspaceMember(email: string, name?: string): WorkspaceMember {
  return {
    createdAt: '2026-07-01T00:00:00.000Z',
    email,
    id: email,
    memberKey: email,
    name,
    role: 'member',
    status: 'active',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 1,
  }
}

/**
 * Translates the small label subset required by task-view model tests.
 *
 * @param key - Task message key.
 * @returns Deterministic English label for the key.
 */
function translateTaskLabel(key: MessageKey) {
  switch (key) {
    case 'tasks.detail.unassigned':
      return 'Unassigned'
    case 'tasks.filter.assigneeAll':
      return 'All assignees'
    case 'tasks.priority.high':
      return 'High'
    case 'tasks.priority.medium':
      return 'Medium'
    case 'tasks.priority.low':
      return 'Low'
    default:
      return key
  }
}
