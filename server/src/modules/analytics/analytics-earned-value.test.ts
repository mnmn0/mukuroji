import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  type AnalyticsQueryInput,
  type AnalyticsWidget,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import {
  createAnalyticsCsv,
  createAnalyticsPermissionScopeHash,
  createAnalyticsSnapshot,
  normalizeAnalyticsQueryInput,
} from './analytics'
import {
  ANALYTICS_EARNED_VALUE_AS_OF_WARNING,
  ANALYTICS_EARNED_VALUE_UNAVAILABLE_WARNING,
  analyticsQueryReadsEarnedValue,
  analyticsSnapshotReadEarnedValue,
  type AnalyticsEarnedValue,
} from './analytics-earned-value'

/** Query period of every test. */
const period = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-07T00:00:00.000Z' }

/** Projects every test viewer may read. */
const authorizedProjectIds = new Set(['project-a', 'project-b'])

/**
 * Creates a canonical Work Item that no audit event changed during the period.
 *
 * @param id - Work Item ID.
 * @param overrides - Fields to replace.
 * @returns The Work Item.
 */
function createWorkItem(id: string, overrides: Partial<CanonicalWorkItem> = {}): CanonicalWorkItem {
  const dueDate = '2026-01-10'
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id,
    teamId: 'core',
    title: `Work ${id}`,
    assigneeUserId: 'user-1',
    creatorMemberKey: 'member-1',
    priority: 'medium',
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z',
    workflowStatusId: 'status-started',
    statusCategory: 'started',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    source: 'dynamodb',
    dueDate,
    schedule: createDefaultDueDateWorkItemSchedule(dueDate),
    ...overrides,
  }
}

/**
 * Creates an ad-hoc query over the test period.
 *
 * @param widgets - Widgets.
 * @returns The query.
 */
function createQuery(widgets: AnalyticsWidget[]): AnalyticsQueryInput {
  return { filter: { period }, widgets, asOf: period.to, timeZone: 'UTC' }
}

const workItems = [
  createWorkItem('item-1', { assignedProjectId: 'project-a' }),
  createWorkItem('item-2', { teamId: 'ops', assignedProjectId: 'project-b' }),
]

/** Two measured Projects on two Teams, with one unmanaged Project and one without a baseline. */
const earnedValue: AnalyticsEarnedValue = {
  projects: [
    { teamId: 'ops', projectId: 'project-b', budgetAtCompletionMinutes: 6_000, plannedValueMinutes: 3_000, earnedValueMinutes: 1_500, actualMinutes: 3_000 },
    { teamId: 'core', projectId: 'project-a', budgetAtCompletionMinutes: 12_000, plannedValueMinutes: 6_000, earnedValueMinutes: 6_000, actualMinutes: 4_800 },
  ],
  managedProjectKeys: ['core\0project-a', 'ops\0project-b'],
  unmanagedProjectCount: 1,
  withoutBaselineCount: 1,
  asOfTooOld: false,
}

describe('earned value metrics', () => {
  test('divide the summed minutes of the measured Projects and group by Team or Project', () => {
    const snapshot = createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      earnedValue,
      query: createQuery([
        { id: 'spi', type: 'metric', title: 'SPI', metric: 'evm-spi' },
        { id: 'cpi', type: 'chart', title: 'CPI', metric: 'evm-cpi', visualization: 'bar', groupBy: { dimension: 'project' } },
        { id: 'eac', type: 'table', title: 'EAC', metric: 'evm-eac', groupBy: { dimension: 'team' } },
      ]),
    })
    const [spi, cpi, eac] = snapshot.widgets
    // (6000 + 1500) / (6000 + 3000)
    expect(spi?.value).toBe(0.83)
    expect(spi?.sampleSize).toBe(2)
    expect(spi?.definition.unit).toBe('index')
    expect(spi?.warnings).toEqual([
      '1 Project(s) you do not manage were left out of the earned value.',
      '1 Project(s) have no baseline with planned effort and were left out.',
    ])
    expect(cpi?.series).toEqual([])
    expect(cpi?.groups).toEqual([
      { key: 'core\0project-a', label: 'project-a', value: 1.25, sampleSize: 1 },
      { key: 'ops\0project-b', label: 'project-b', value: 0.5, sampleSize: 1 },
    ])
    // BAC 18000 min / CPI (7500 / 7800) = 18720 min = 312 h
    expect(eac?.value).toBe(312)
    expect(eac?.groups).toEqual([
      { key: 'core', label: 'core', value: 160, sampleSize: 1 },
      { key: 'ops', label: 'ops', value: 200, sampleSize: 1 },
    ])
    expect(eac?.rows[0]).toEqual({
      id: 'core\0project-a',
      label: 'project-a',
      values: {
        teamId: 'core',
        projectId: 'project-a',
        budgetAtCompletionHours: 200,
        plannedValueHours: 100,
        earnedValueHours: 100,
        actualHours: 80,
        value: 160,
      },
    })
    expect(analyticsSnapshotReadEarnedValue(snapshot)).toBe(true)
    expect(createAnalyticsCsv(snapshot)).toContain('evm-eac')
  })

  test('fix the managed Projects in the permission scope hash', () => {
    const query = createQuery([{ id: 'spi', type: 'metric', title: 'SPI', metric: 'evm-spi' }])
    const snapshot = createAnalyticsSnapshot({ workItems, events: [], authorizedProjectIds, earnedValue, query })
    const asOf = Date.parse(period.to)
    expect(snapshot.permissionScopeHash).toBe(createAnalyticsPermissionScopeHash(
      workItems, asOf, authorizedProjectIds, undefined, undefined, undefined, earnedValue.managedProjectKeys,
    ))
    expect(snapshot.permissionScopeHash).not.toBe(createAnalyticsPermissionScopeHash(
      workItems, asOf, authorizedProjectIds, undefined, undefined, undefined, ['core\0project-a'],
    ))
  })

  test('return only a warning without earned value or with an old as-of time', () => {
    const query = createQuery([{ id: 'spi', type: 'metric', title: 'SPI', metric: 'evm-spi' }])
    expect(analyticsQueryReadsEarnedValue(query)).toBe(true)
    const scheduled = createAnalyticsSnapshot({ workItems, events: [], authorizedProjectIds, query })
    expect(scheduled.widgets[0]?.value).toBeNull()
    expect(scheduled.widgets[0]?.warnings).toEqual([ANALYTICS_EARNED_VALUE_UNAVAILABLE_WARNING])
    expect(analyticsSnapshotReadEarnedValue(scheduled)).toBe(false)
    expect(scheduled.permissionScopeHash).toBe(createAnalyticsPermissionScopeHash(workItems, Date.parse(period.to), authorizedProjectIds))

    const old = createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      earnedValue: { ...earnedValue, projects: [], asOfTooOld: true },
      query,
    })
    expect(old.widgets[0]?.value).toBeNull()
    expect(old.widgets[0]?.warnings).toEqual([ANALYTICS_EARNED_VALUE_AS_OF_WARNING])
    expect(analyticsSnapshotReadEarnedValue(old)).toBe(true)
  })

  test('leave SPI and CPI empty without planned value or actual time', () => {
    const snapshot = createAnalyticsSnapshot({
      workItems,
      events: [],
      authorizedProjectIds,
      earnedValue: {
        ...earnedValue,
        projects: [{ teamId: 'core', projectId: 'project-a', budgetAtCompletionMinutes: 600, plannedValueMinutes: 0, earnedValueMinutes: 0, actualMinutes: 0 }],
      },
      query: createQuery([
        { id: 'spi', type: 'metric', title: 'SPI', metric: 'evm-spi' },
        { id: 'cpi', type: 'metric', title: 'CPI', metric: 'evm-cpi' },
        { id: 'eac', type: 'metric', title: 'EAC', metric: 'evm-eac' },
      ]),
    })
    expect(snapshot.widgets.map((widget) => widget.value)).toEqual([null, null, null])
  })

  test('reject groupings other than Team or Project and ungrouped charts', () => {
    expect(() => normalizeAnalyticsQueryInput(createQuery([
      { id: 'spi', type: 'metric', title: 'SPI', metric: 'evm-spi', groupBy: { dimension: 'assignee' } },
    ]))).toThrow('group only by Team or Project')
    expect(() => normalizeAnalyticsQueryInput(createQuery([
      { id: 'spi', type: 'chart', title: 'SPI', metric: 'evm-spi', visualization: 'line' },
    ]))).toThrow('group only by Team or Project')
  })
})
