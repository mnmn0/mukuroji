import { describe, expect, test } from 'bun:test'
import { analyticsDateToEpochDay, type AnalyticsQueryInput } from '@mukuroji/contracts'
import {
  ANALYTICS_METRIC_DEFINITIONS,
  analyticsSnapshotReadMilestones,
  createAnalyticsCsv,
  createAnalyticsPermissionScopeHash,
  createAnalyticsSnapshot,
  InMemoryAnalyticsRepository,
  normalizeAnalyticsQueryInput,
} from './analytics'
import {
  ANALYTICS_MILESTONE_HISTORY_UNAVAILABLE_WARNING,
  createAnalyticsMilestoneScopeKey,
  type AnalyticsMilestoneHistory,
} from './analytics-milestone-trend'

const period = { from: '2026-03-01T00:00:00.000Z', to: '2026-03-04T23:59:59.999Z' }

/**
 * Builds a Milestone trend query.
 *
 * @param type - Widget type.
 * @returns The query.
 */
function createQuery(type: 'chart' | 'metric' | 'table' = 'chart'): AnalyticsQueryInput {
  return {
    filter: { period },
    widgets: [{
      id: 'trend',
      type,
      title: 'Milestone trend',
      metric: 'milestone-trend',
      ...(type === 'chart' ? { visualization: 'line' as const, groupBy: { dimension: 'day' as const } } : {}),
    }],
    asOf: '2026-03-04T12:00:00.000Z',
    timeZone: 'UTC',
  }
}

/** A Milestone created before the period that slipped twice and moved Project once. */
const slipping: AnalyticsMilestoneHistory = {
  id: 'milestone-a',
  title: 'Beta',
  teamId: 'team-1',
  projectId: 'project-1',
  forecastEndDate: '2026-04-20',
  baselineEndDate: '2026-04-10',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-03-03T09:00:00.000Z',
  history: [
    {
      eventId: 'e3',
      occurredAt: '2026-03-03T09:00:00.000Z',
      changes: [{ field: 'forecast.endDate', before: '2026-04-15', after: '2026-04-20' }],
    },
    {
      eventId: 'e1',
      occurredAt: '2026-02-01T00:00:00.000Z',
      changes: [
        { field: 'forecast.endDate', after: '2026-04-10' },
        { field: 'teamId', after: 'team-1' },
        { field: 'projectId', after: 'project-1' },
      ],
    },
    {
      eventId: 'e2',
      occurredAt: '2026-03-02T09:00:00.000Z',
      changes: [{ field: 'forecast.endDate', before: '2026-04-10', after: '2026-04-15' }],
    },
  ],
}

/**
 * Returns the day number of a date.
 *
 * @param date - `YYYY-MM-DD` date.
 * @returns Days since 1970-01-01.
 */
function day(date: string) {
  const value = analyticsDateToEpochDay(date)
  if (value === undefined) throw new Error(`invalid date ${date}`)
  return value
}

describe('milestone-trend metric', () => {
  test('draws each Milestone date at every bucket end and reports the slip of the period', () => {
    const snapshot = createAnalyticsSnapshot({
      workItems: [],
      events: [],
      authorizedProjectIds: new Set(['project-1']),
      milestones: [slipping],
      query: createQuery(),
    })
    const [widget] = snapshot.widgets

    expect(widget?.definition).toEqual(ANALYTICS_METRIC_DEFINITIONS['milestone-trend'])
    expect(widget?.series.map((point) => point.segments)).toEqual([
      [{ key: 'milestone-a', value: day('2026-04-10') }],
      [{ key: 'milestone-a', value: day('2026-04-15') }],
      [{ key: 'milestone-a', value: day('2026-04-20') }],
      [{ key: 'milestone-a', value: day('2026-04-20') }],
    ])
    expect(widget?.groups).toEqual([
      { key: 'milestone-a', label: 'Beta', value: 10, sampleSize: 2 },
    ])
    expect(widget?.value).toBe(1)
    expect(widget?.sampleSize).toBe(1)
    expect(widget?.warnings).toEqual([])
    expect(analyticsSnapshotReadMilestones(snapshot)).toBe(true)
  })

  test('hides dates recorded while the Milestone was in another scope', () => {
    const moved: AnalyticsMilestoneHistory = {
      ...slipping,
      history: [
        ...slipping.history.map((change) => change.eventId === 'e1'
          ? {
              ...change,
              changes: change.changes.map((fieldChange) => fieldChange.field === 'projectId'
                ? { ...fieldChange, after: 'project-secret' }
                : fieldChange),
            }
          : change),
        {
          eventId: 'e0',
          occurredAt: '2026-03-02T12:00:00.000Z',
          changes: [{ field: 'projectId', before: 'project-secret', after: 'project-1' }],
        },
      ],
    }
    const snapshot = createAnalyticsSnapshot({
      workItems: [],
      events: [],
      authorizedProjectIds: new Set(['project-1']),
      milestones: [moved],
      query: createQuery(),
    })
    const [widget] = snapshot.widgets

    expect(widget?.series.map((point) => point.segments)).toEqual([
      [],
      [{ key: 'milestone-a', value: day('2026-04-15') }],
      [{ key: 'milestone-a', value: day('2026-04-20') }],
      [{ key: 'milestone-a', value: day('2026-04-20') }],
    ])
    // The change on March 2 was recorded in the other Project, so only the March 3 change counts.
    expect(widget?.groups).toEqual([
      { key: 'milestone-a', label: 'Beta', value: 5, sampleSize: 1 },
    ])
  })

  test('treats a scope changed by an ancestor move as changed at the latest write', () => {
    // An Initiative moved on March 3 and carried the Milestone to project-2 without its own event.
    const carried: AnalyticsMilestoneHistory = {
      ...slipping,
      projectId: 'project-2',
      updatedAt: '2026-03-03T12:00:00.000Z',
    }
    const snapshot = createAnalyticsSnapshot({
      workItems: [],
      events: [],
      authorizedProjectIds: new Set(['project-2']),
      milestones: [carried],
      query: createQuery(),
    })

    expect(snapshot.widgets[0]?.series.map((point) => point.segments)).toEqual([
      [],
      [],
      [{ key: 'milestone-a', value: day('2026-04-20') }],
      [{ key: 'milestone-a', value: day('2026-04-20') }],
    ])
  })

  test('hides the interval in which an ancestor moved the Milestone away and back', () => {
    // Created in team-1, carried to team-2 at an unknown instant, changed there on March 3, and
    // carried back to team-1 at noon without events of its own.
    const roundTrip: AnalyticsMilestoneHistory = {
      id: 'milestone-r',
      title: 'Round trip',
      teamId: 'team-1',
      forecastEndDate: '2026-04-20',
      baselineEndDate: '2026-04-10',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-03T12:00:00.000Z',
      history: [
        {
          eventId: 'r1',
          occurredAt: '2026-03-01T00:00:00.000Z',
          changes: [
            { field: 'forecast.endDate', after: '2026-04-10' },
            { field: 'teamId', after: 'team-1' },
            { field: 'projectId' },
          ],
        },
        {
          eventId: 'r2',
          occurredAt: '2026-03-03T09:00:00.000Z',
          changes: [
            { field: 'forecast.endDate', before: '2026-04-10', after: '2026-04-20' },
            { field: 'teamId', before: 'team-2', after: 'team-2' },
            { field: 'projectId' },
          ],
        },
      ],
    }
    const snapshot = createAnalyticsSnapshot({
      workItems: [],
      events: [],
      authorizedProjectIds: new Set(),
      milestones: [roundTrip],
      query: createQuery(),
    })
    const [widget] = snapshot.widgets

    expect(widget?.series.map((point) => point.segments)).toEqual([
      [],
      [],
      [{ key: 'milestone-r', value: day('2026-04-20') }],
      [{ key: 'milestone-r', value: day('2026-04-20') }],
    ])
    // Both ends were dates in team-1. The change itself was recorded in team-2, so it is not counted.
    expect(widget?.groups).toEqual([
      { key: 'milestone-r', label: 'Round trip', value: 10, sampleSize: 0 },
    ])
  })

  test('shows the current date since creation when no history was recorded', () => {
    const snapshot = createAnalyticsSnapshot({
      workItems: [],
      events: [],
      authorizedProjectIds: new Set(),
      milestones: [{
        id: 'milestone-b',
        title: 'Launch',
        forecastEndDate: '2026-05-01',
        baselineEndDate: '2026-05-01',
        createdAt: '2026-03-02T10:00:00.000Z',
        updatedAt: '2026-03-02T10:00:00.000Z',
        history: [],
      }],
      query: createQuery('table'),
    })
    const [widget] = snapshot.widgets

    expect(widget?.series).toEqual([])
    expect(widget?.rows).toEqual([{
      id: 'milestone-b',
      label: 'Launch',
      values: {
        milestoneId: 'milestone-b',
        baselineEndDate: '2026-05-01',
        periodStartForecastEndDate: '2026-05-01',
        forecastEndDate: '2026-05-01',
        shiftDays: 0,
        changeCount: 0,
      },
    }])
    expect(widget?.warnings).toEqual([
      '1 Milestone(s) have no recorded date history; their current date is shown since creation.',
    ])
    expect(createAnalyticsCsv(snapshot)).toContain(
      'Milestone trend,0,0,Table row,baseline=2026-05-01; shiftFrom=2026-05-01; forecast=2026-05-01,',
    )
  })

  test('leaves both dates unknown for a Milestone created after the period end', () => {
    const query = createQuery('table')
    const snapshot = createAnalyticsSnapshot({
      workItems: [],
      events: [],
      authorizedProjectIds: new Set(),
      milestones: [{
        id: 'milestone-c',
        title: 'Later',
        forecastEndDate: '2026-06-01',
        baselineEndDate: '2026-06-01',
        createdAt: '2026-03-10T00:00:00.000Z',
        updatedAt: '2026-03-10T00:00:00.000Z',
        history: [],
      }],
      query: { ...query, asOf: '2026-03-12T00:00:00.000Z' },
    })

    expect(snapshot.widgets[0]?.rows[0]?.values).toMatchObject({
      periodStartForecastEndDate: null,
      forecastEndDate: null,
      shiftDays: null,
    })
  })

  test('leaves Milestones out of runs that cannot read them and keeps their hash', () => {
    const query = createQuery('metric')
    const snapshot = createAnalyticsSnapshot({
      workItems: [],
      events: [],
      authorizedProjectIds: new Set(),
      query,
    })

    expect(snapshot.widgets[0]?.warnings).toEqual([ANALYTICS_MILESTONE_HISTORY_UNAVAILABLE_WARNING])
    expect(snapshot.widgets[0]?.value).toBeNull()
    expect(analyticsSnapshotReadMilestones(snapshot)).toBe(false)
    expect(snapshot.permissionScopeHash).toBe(
      createAnalyticsPermissionScopeHash([], Date.parse(query.asOf), new Set()),
    )
  })

  test('fixes the readable Milestones in the permission scope hash', () => {
    const query = createQuery('metric')
    const snapshot = createAnalyticsSnapshot({
      workItems: [],
      events: [],
      authorizedProjectIds: new Set(),
      milestones: [slipping],
      query,
    })

    expect(snapshot.permissionScopeHash).toBe(
      createAnalyticsPermissionScopeHash([], Date.parse(query.asOf), new Set(), [
        createAnalyticsMilestoneScopeKey(slipping),
      ]),
    )
    // A Milestone that moved to another Team no longer matches the saved scope.
    expect(snapshot.permissionScopeHash).not.toBe(
      createAnalyticsPermissionScopeHash([], Date.parse(query.asOf), new Set(), [
        createAnalyticsMilestoneScopeKey({ ...slipping, teamId: 'team-2' }),
      ]),
    )
  })

  test('exports segment dates in CSV', () => {
    const snapshot = createAnalyticsSnapshot({
      workItems: [],
      events: [],
      authorizedProjectIds: new Set(['project-1']),
      milestones: [slipping],
      query: createQuery(),
    })

    expect(createAnalyticsCsv(snapshot)).toContain('Series segment,milestone-a,2026-03-01T00:00:00.000Z')
    expect(createAnalyticsCsv(snapshot)).toContain('Milestone trend,2026-04-20,')
  })

  test('saves a snapshot whose Milestone widget has no explicit group-by', async () => {
    const query = createQuery('table')
    const snapshot = createAnalyticsSnapshot({
      workItems: [],
      events: [],
      authorizedProjectIds: new Set(['project-1']),
      milestones: [slipping],
      query,
    })
    expect(snapshot.widgets[0]?.groups).toHaveLength(1)
    const record = {
      id: 'snapshot-trend',
      workspaceId: 'workspace-1',
      createdByMemberKey: 'member-1',
      createdAt: query.asOf,
      query,
      snapshot,
    }

    const saved = await new InMemoryAnalyticsRepository().putSnapshot(record)
    expect(saved.snapshot.widgets[0]?.groups).toEqual(snapshot.widgets[0]?.groups)
  })

  test('rejects Work Item dimensions as the group-by', () => {
    const query = createQuery()
    expect(() => normalizeAnalyticsQueryInput({
      ...query,
      widgets: [{ ...query.widgets[0], groupBy: { dimension: 'team' } }],
    })).toThrow('Milestone trend widgets group by Milestone')
  })
})
