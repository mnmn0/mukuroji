import { describe, expect, test } from 'bun:test'
import type {
  WorkItemDependencyEndpoint,
  WorkItemSchedule,
  WorkItemScheduleDependency,
} from '@mukuroji/contracts'
import {
  previewWorkItemDependencyScheduleChange,
  type WorkItemDependencyScheduleState,
} from './work-item-schedule-dependencies'
import { WorkItemScheduleError } from './work-item-schedule'

const calendarPolicy = {
  timeZone: 'UTC',
  workingWeekdays: [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
  ],
  holidays: [],
} satisfies WorkItemSchedule['calendarPolicy']

const allDaysCalendarPolicy = {
  timeZone: 'UTC',
  workingWeekdays: [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ],
  holidays: [],
} satisfies WorkItemSchedule['calendarPolicy']

/**
 * Creates one qualified Work Item endpoint fixture.
 *
 * @param workItemId - Team-local Work Item identifier.
 * @param teamId - Optional owning Team identifier.
 * @returns Qualified dependency endpoint.
 */
function endpoint(
  workItemId: string,
  teamId = 'team-a',
): WorkItemDependencyEndpoint {
  return { teamId, workItemId }
}

/**
 * Creates a two-working-day date-range dependency state fixture.
 *
 * @param workItemId - Team-local Work Item identifier.
 * @param startDate - Inclusive range start.
 * @param endDate - Inclusive range end.
 * @param teamId - Optional owning Team identifier.
 * @returns Revision-bound schedule state.
 */
function state(
  workItemId: string,
  startDate: string,
  endDate: string,
  teamId = 'team-a',
): WorkItemDependencyScheduleState {
  return {
    endpoint: endpoint(workItemId, teamId),
    revision: 3,
    schedule: {
      mode: 'date-range',
      calendarPolicy,
      startDate,
      endDate,
      durationDays: 2,
    },
    projectId: `${teamId}-project`,
    milestoneIds: [`${teamId}-milestone`],
  }
}

/**
 * Creates one canonical dependency fixture.
 *
 * @param id - Dependency identifier.
 * @param predecessor - Predecessor Work Item identifier.
 * @param successor - Successor Work Item identifier.
 * @param type - Schedule boundary relationship.
 * @param lagDays - Signed lead or lag.
 * @returns Canonical dependency.
 */
function dependency(
  id: string,
  predecessor: WorkItemDependencyEndpoint,
  successor: WorkItemDependencyEndpoint,
  type: WorkItemScheduleDependency['type'] = 'finish-to-start',
  lagDays = 0,
): WorkItemScheduleDependency {
  return {
    id,
    predecessor,
    successor,
    type,
    lagDays,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }
}

describe('Work Item schedule dependency preview', () => {
  test('propagates an FS chain transitively with deterministic impacts and affected scopes', () => {
    const root = state('root', '2026-06-01', '2026-06-02')
    const middle = state('middle', '2026-06-03', '2026-06-04', 'team-b')
    const leaf = state('leaf', '2026-06-05', '2026-06-08', 'team-b')

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '2026-06-03' },
      workItems: [leaf, middle, root],
      dependencies: [
        dependency('dep-2', middle.endpoint, leaf.endpoint),
        dependency('dep-1', root.endpoint, middle.endpoint),
      ],
      planningRevision: 9,
      relationGraphRevision: 4,
      semanticBlockerCount: 1,
    })

    expect(preview).toEqual({
      expectedRevision: 3,
      planningRevision: 9,
      relationGraphRevision: 4,
      impacts: [
        {
          teamId: 'team-a',
          workItemId: 'root',
          kind: 'direct',
          expectedRevision: 3,
          before: root.schedule,
          after: {
            mode: 'date-range',
            calendarPolicy,
            startDate: '2026-06-03',
            endDate: '2026-06-04',
            durationDays: 2,
          },
          dateDeltaDays: 2,
        },
        {
          teamId: 'team-b',
          workItemId: 'middle',
          kind: 'dependency',
          expectedRevision: 3,
          before: middle.schedule,
          after: {
            mode: 'date-range',
            calendarPolicy,
            startDate: '2026-06-05',
            endDate: '2026-06-08',
            durationDays: 2,
          },
          dateDeltaDays: 4,
          dependencyId: 'dep-1',
        },
        {
          teamId: 'team-b',
          workItemId: 'leaf',
          kind: 'dependency',
          expectedRevision: 3,
          before: leaf.schedule,
          after: {
            mode: 'date-range',
            calendarPolicy,
            startDate: '2026-06-09',
            endDate: '2026-06-10',
            durationDays: 2,
          },
          dateDeltaDays: 2,
          dependencyId: 'dep-2',
        },
      ],
      evaluatedRevisions: [
        { teamId: 'team-a', workItemId: 'root', expectedRevision: 3 },
        { teamId: 'team-b', workItemId: 'leaf', expectedRevision: 3 },
        { teamId: 'team-b', workItemId: 'middle', expectedRevision: 3 },
      ],
      conflicts: [],
      affectedProjectIds: ['team-a-project', 'team-b-project'],
      affectedMilestoneIds: ['team-a-milestone', 'team-b-milestone'],
      requiresConfirmation: true,
      warnings: [
        'DependencyRippleRequiresReview',
        'SemanticBlockRelationsDoNotReschedule',
      ],
    })
  })

  test('supports SF with signed lead and preserves a finish-anchored duration', () => {
    const root = state('root', '2026-06-08', '2026-06-09')
    const successor = state('successor', '2026-06-04', '2026-06-05')
    const edge = dependency(
      'dep-sf',
      root.endpoint,
      successor.endpoint,
      'start-to-finish',
      -3,
    )

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '2026-06-10' },
      workItems: [root, successor],
      dependencies: [edge],
      planningRevision: 2,
    })

    expect(preview.impacts[1]).toMatchObject({
      dependencyId: 'dep-sf',
      before: { startDate: '2026-06-04', endDate: '2026-06-05' },
      after: { startDate: '2026-06-04', endDate: '2026-06-07' },
      dateDeltaDays: 2,
    })
    expect(preview.conflicts).toEqual([])
  })

  const signedAnchorCases = [
    {
      label: 'SS positive lag',
      relationship: 'start-to-start',
      lagDays: 2,
      successorBeforeStart: '2026-06-03',
      successorBeforeEnd: '2026-06-04',
      successorAfterStart: '2026-06-05',
      successorAfterEnd: '2026-06-08',
    },
    {
      label: 'FF negative lead',
      relationship: 'finish-to-finish',
      lagDays: -2,
      successorBeforeStart: '2026-05-28',
      successorBeforeEnd: '2026-05-31',
      successorAfterStart: '2026-06-01',
      successorAfterEnd: '2026-06-02',
    },
  ] satisfies Array<{
    label: string
    relationship: WorkItemScheduleDependency['type']
    lagDays: number
    successorBeforeStart: string
    successorBeforeEnd: string
    successorAfterStart: string
    successorAfterEnd: string
  }>

  test.each(signedAnchorCases)(
    'propagates $label using the canonical predecessor and successor anchors',
    (scenario) => {
      const root = state('root', '2026-06-01', '2026-06-02')
      const successor = state(
        'successor',
        scenario.successorBeforeStart,
        scenario.successorBeforeEnd,
      )
      const edge = dependency(
        `dep-${scenario.relationship}`,
        root.endpoint,
        successor.endpoint,
        scenario.relationship,
        scenario.lagDays,
      )

      const preview = previewWorkItemDependencyScheduleChange({
        root,
        operation: { type: 'move', targetDate: '2026-06-03' },
        workItems: [root, successor],
        dependencies: [edge],
        planningRevision: 2,
      })

      expect(preview.impacts[1]).toMatchObject({
        dependencyId: edge.id,
        after: {
          startDate: scenario.successorAfterStart,
          endDate: scenario.successorAfterEnd,
        },
      })
      expect(preview.conflicts).toEqual([])
    },
  )

  test('reports exact and upper constraint conflicts without hiding the proposed ripple', () => {
    const root = state('root', '2026-06-01', '2026-06-02')
    const successor = state('successor', '2026-06-03', '2026-06-04')
    const edge = {
      ...dependency('dep-constrained', root.endpoint, successor.endpoint),
      constraint: {
        anchor: 'start',
        kind: 'not-after',
        date: '2026-06-05',
      },
    } satisfies WorkItemScheduleDependency

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '2026-06-08' },
      workItems: [root, successor],
      dependencies: [edge],
      planningRevision: 5,
    })

    expect(preview.impacts[1]).toMatchObject({
      after: { startDate: '2026-06-10', endDate: '2026-06-11' },
    })
    expect(preview.conflicts).toEqual([{
      code: 'constraint-violation',
      dependencyId: 'dep-constrained',
      workItem: successor.endpoint,
      requiredDate: '2026-06-05',
      actualDate: '2026-06-10',
    }])
  })

  test('does not infer a missing successor start from a due-date schedule', () => {
    const root = state('root', '2026-06-01', '2026-06-02')
    const successor: WorkItemDependencyScheduleState = {
      endpoint: endpoint('due-only'),
      revision: 4,
      schedule: {
        mode: 'due-date',
        dueDate: '2026-06-10',
        calendarPolicy,
      },
      milestoneIds: [],
    }
    const edge = dependency('dep-missing', root.endpoint, successor.endpoint)

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '2026-06-03' },
      workItems: [root, successor],
      dependencies: [edge],
      planningRevision: 1,
    })

    expect(preview.impacts).toHaveLength(1)
    expect(preview.conflicts).toEqual([{
      code: 'missing-schedule',
      dependencyId: 'dep-missing',
      workItem: successor.endpoint,
    }])
  })

  test('retains a stronger bound from a visible predecessor outside the edited cascade', () => {
    const root = state('root', '2026-06-01', '2026-06-02')
    const outside = state('outside', '2026-06-08', '2026-06-09')
    const successor = state('successor', '2026-06-10', '2026-06-11')

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '2026-06-03' },
      workItems: [root, outside, successor],
      dependencies: [
        dependency('dep-root', root.endpoint, successor.endpoint),
        dependency('dep-outside', outside.endpoint, successor.endpoint),
      ],
      planningRevision: 1,
    })

    expect(preview.impacts).toHaveLength(1)
    expect(preview.conflicts).toEqual([])
  })

  test('re-enforces an unchanged finish bound after a released start bound moves earlier', () => {
    const root = state('root', '2026-06-10', '2026-06-11')
    const outside = state('outside', '2026-06-10', '2026-06-11')
    const successor = state('successor', '2026-06-10', '2026-06-11')

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '2026-06-05' },
      workItems: [root, outside, successor],
      dependencies: [
        dependency(
          'dep-released-start',
          root.endpoint,
          successor.endpoint,
          'start-to-start',
        ),
        dependency(
          'dep-unchanged-finish',
          outside.endpoint,
          successor.endpoint,
          'finish-to-finish',
        ),
      ],
      planningRevision: 1,
    })

    expect(preview.impacts).toHaveLength(1)
    expect(preview.impacts[0]?.workItemId).toBe('root')
    expect(preview.conflicts).toEqual([])
  })

  test('re-enforces an unchanged start bound after a released finish bound moves earlier', () => {
    const root = state('root', '2026-06-10', '2026-06-11')
    const outside = state('outside', '2026-06-10', '2026-06-11')
    const successor = state('successor', '2026-06-10', '2026-06-11')

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '2026-06-05' },
      workItems: [root, outside, successor],
      dependencies: [
        dependency(
          'dep-released-finish',
          root.endpoint,
          successor.endpoint,
          'finish-to-finish',
        ),
        dependency(
          'dep-unchanged-start',
          outside.endpoint,
          successor.endpoint,
          'start-to-start',
        ),
      ],
      planningRevision: 1,
    })

    expect(preview.impacts).toHaveLength(1)
    expect(preview.impacts[0]?.workItemId).toBe('root')
    expect(preview.conflicts).toEqual([])
  })

  test('propagates when the direct predecessor changes from unscheduled to scheduled', () => {
    const root: WorkItemDependencyScheduleState = {
      ...state('root', '2026-06-01', '2026-06-02'),
      schedule: { mode: 'unscheduled', calendarPolicy },
    }
    const successor = state('successor', '2026-06-03', '2026-06-04')
    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: {
        type: 'replace',
        schedule: {
          mode: 'date-range',
          calendarPolicy,
          startDate: '2026-06-03',
          endDate: '2026-06-04',
          durationDays: 2,
        },
      },
      workItems: [root, successor],
      dependencies: [dependency('dep-from-unscheduled', root.endpoint, successor.endpoint)],
      planningRevision: 1,
    })

    expect(preview.impacts[1]).toMatchObject({
      dependencyId: 'dep-from-unscheduled',
      after: { startDate: '2026-06-05', endDate: '2026-06-08' },
    })
    expect(preview.conflicts).toEqual([])
  })

  test('revalidates earlier explicit constraints after a later constraint shifts the schedule', () => {
    const root = state('root', '2026-06-01', '2026-06-02')
    const outside = state('outside', '2026-06-01', '2026-06-02')
    const successor = state('successor', '2026-06-04', '2026-06-05')
    const upperBound = {
      ...dependency(
        'dep-a-upper',
        root.endpoint,
        successor.endpoint,
        'start-to-start',
      ),
      constraint: { anchor: 'start', kind: 'not-after', date: '2026-06-05' },
    } satisfies WorkItemScheduleDependency
    const lowerBound = {
      ...dependency(
        'dep-b-lower',
        outside.endpoint,
        successor.endpoint,
        'start-to-start',
      ),
      constraint: { anchor: 'start', kind: 'not-before', date: '2026-06-07' },
    } satisfies WorkItemScheduleDependency

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '2026-06-03' },
      workItems: [root, outside, successor],
      dependencies: [upperBound, lowerBound],
      planningRevision: 2,
    })

    expect(preview.impacts[1]?.after).toMatchObject({
      startDate: '2026-06-07',
      endDate: '2026-06-09',
    })
    expect(preview.conflicts).toContainEqual({
      code: 'constraint-violation',
      dependencyId: 'dep-a-upper',
      workItem: successor.endpoint,
      requiredDate: '2026-06-05',
      actualDate: '2026-06-07',
    })
  })

  test('reports incoming root dependency and constraint conflicts without rewriting the direct result', () => {
    const predecessor = state('predecessor', '2026-06-08', '2026-06-09')
    const root = state('root', '2026-06-10', '2026-06-11')
    const edge = {
      ...dependency('dep-root-incoming', predecessor.endpoint, root.endpoint),
      constraint: {
        anchor: 'start',
        kind: 'not-before',
        date: '2026-06-10',
      },
    } satisfies WorkItemScheduleDependency

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '2026-06-08' },
      workItems: [predecessor, root],
      dependencies: [edge],
      planningRevision: 1,
    })

    expect(preview.impacts).toHaveLength(1)
    expect(preview.impacts[0]?.after).toMatchObject({
      startDate: '2026-06-08',
      endDate: '2026-06-09',
    })
    expect(preview.conflicts).toEqual([
      {
        code: 'constraint-violation',
        dependencyId: 'dep-root-incoming',
        workItem: root.endpoint,
        requiredDate: '2026-06-10',
        actualDate: '2026-06-08',
      },
      {
        code: 'dependency-violation',
        dependencyId: 'dep-root-incoming',
        workItem: root.endpoint,
        requiredDate: '2026-06-10',
        actualDate: '2026-06-08',
      },
    ])
  })

  test('reports an upper-bound conflict when preserving successor duration exceeds year 9999', () => {
    const root: WorkItemDependencyScheduleState = {
      endpoint: endpoint('root'),
      revision: 3,
      schedule: {
        mode: 'milestone',
        startDate: '9999-12-29',
        endDate: '9999-12-29',
        durationDays: 0,
        calendarPolicy: allDaysCalendarPolicy,
      },
      projectId: 'team-a-project',
      milestoneIds: [],
    }
    const successor: WorkItemDependencyScheduleState = {
      endpoint: endpoint('successor'),
      revision: 3,
      schedule: {
        mode: 'date-range',
        startDate: '9999-12-29',
        endDate: '9999-12-30',
        durationDays: 2,
        calendarPolicy: allDaysCalendarPolicy,
      },
      projectId: 'team-a-project',
      milestoneIds: [],
    }
    const edge = dependency(
      'dep-upper-bound',
      root.endpoint,
      successor.endpoint,
      'start-to-start',
    )

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '9999-12-31' },
      workItems: [root, successor],
      dependencies: [edge],
      planningRevision: 1,
    })

    expect(preview.impacts).toEqual([expect.objectContaining({
      kind: 'direct',
      workItemId: 'root',
      after: expect.objectContaining({
        startDate: '9999-12-31',
        endDate: '9999-12-31',
      }),
    })])
    expect(preview.conflicts).toEqual([{
      code: 'dependency-violation',
      dependencyId: 'dep-upper-bound',
      workItem: successor.endpoint,
      requiredDate: '9999-12-31',
      actualDate: '9999-12-29',
    }])
  })

  test('reports a stable lower-bound conflict when dependency arithmetic leaves year 1000', () => {
    const root: WorkItemDependencyScheduleState = {
      endpoint: endpoint('root'),
      revision: 3,
      schedule: {
        mode: 'milestone',
        startDate: '1000-01-02',
        endDate: '1000-01-02',
        durationDays: 0,
        calendarPolicy: allDaysCalendarPolicy,
      },
      projectId: 'team-a-project',
      milestoneIds: [],
    }
    const successor: WorkItemDependencyScheduleState = {
      endpoint: endpoint('successor'),
      revision: 3,
      schedule: {
        mode: 'milestone',
        startDate: '1000-01-01',
        endDate: '1000-01-01',
        durationDays: 0,
        calendarPolicy: allDaysCalendarPolicy,
      },
      projectId: 'team-a-project',
      milestoneIds: [],
    }
    const edge = dependency(
      'dep-lower-bound',
      root.endpoint,
      successor.endpoint,
      'start-to-start',
      -1,
    )

    const preview = previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '1000-01-01' },
      workItems: [root, successor],
      dependencies: [edge],
      planningRevision: 1,
    })

    expect(preview.impacts).toEqual([expect.objectContaining({
      kind: 'direct',
      workItemId: 'root',
      after: expect.objectContaining({
        startDate: '1000-01-01',
        endDate: '1000-01-01',
      }),
    })])
    expect(preview.conflicts).toEqual([{
      code: 'dependency-violation',
      dependencyId: 'dep-lower-bound',
      workItem: successor.endpoint,
      actualDate: '1000-01-01',
    }])
  })

  test('rejects a reachable stored cycle before returning impacts', () => {
    const root = state('root', '2026-06-01', '2026-06-02')
    const successor = state('successor', '2026-06-03', '2026-06-04')

    expect(() => previewWorkItemDependencyScheduleChange({
      root,
      operation: { type: 'move', targetDate: '2026-06-03' },
      workItems: [root, successor],
      dependencies: [
        dependency('dep-forward', root.endpoint, successor.endpoint),
        dependency('dep-back', successor.endpoint, root.endpoint),
      ],
      planningRevision: 1,
    })).toThrow(new WorkItemScheduleError(
      409,
      'WorkItemScheduleDependencyCycle',
      'Stored Work Item schedule dependencies contain a cycle.',
    ))
  })
})
