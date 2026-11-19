import { describe, expect, test } from 'bun:test'
import type { PlanningDependency, PlanningEntity } from '@mukuroji/contracts'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import {
  CROSS_PROJECT_TIMELINE_ENTITY_ROW_HEIGHT,
  CROSS_PROJECT_TIMELINE_GROUP_ROW_HEIGHT,
  createCrossProjectTimelineChart,
  formatLocalCalendarDate,
  type CrossProjectTimelineInput,
} from '../src/planning/model/crossProjectTimeline'

/** Returns a fixture entity by ID or fails the test. */
function fixtureEntity(id: string): PlanningEntity {
  const entity = planningSnapshotFixture.entities.find((candidate) => candidate.id === id)
  if (!entity) throw new Error(`Missing fixture entity ${id}.`)
  return entity
}

/** Creates a Project-scoped Phase or Milestone for timeline tests. */
function scopedEntity(
  id: string,
  type: 'phase' | 'milestone',
  projectId: string,
  forecast: { startDate: string, endDate: string },
  baseline = forecast,
): PlanningEntity {
  return {
    ...fixtureEntity(type === 'phase' ? 'phase-build' : 'milestone-beta'),
    id,
    title: id,
    projectId,
    forecast,
    baseline,
  }
}

const baseInput: Omit<CrossProjectTimelineInput, 'entities' | 'dependencies'> = {
  directory: [{
    id: 'core-team',
    name: 'Core',
    projects: [
      { id: 'alpha', name: 'Alpha project' },
      { id: 'beta', name: 'Beta project' },
    ],
  }],
  grouping: 'project',
  noPortfolioLabel: 'No portfolio',
  today: '2026-08-01',
  workspaceLabel: 'Workspace',
}

describe('createCrossProjectTimelineChart', () => {
  test('groups Phases and Milestones of several Projects on one axis', () => {
    const chart = createCrossProjectTimelineChart({
      ...baseInput,
      dependencies: [],
      entities: [
        scopedEntity('beta-phase', 'phase', 'beta', { startDate: '2026-08-01', endDate: '2026-08-31' }),
        scopedEntity('alpha-phase', 'phase', 'alpha', { startDate: '2026-07-01', endDate: '2026-07-31' }),
        scopedEntity('alpha-ms', 'milestone', 'alpha', { startDate: '2026-08-10', endDate: '2026-08-10' }),
      ],
    })

    expect(chart).toBeDefined()
    if (!chart) return
    expect(chart.projectCount).toBe(2)
    expect(chart.startDate).toBe('2026-06-24')
    expect(chart.endDate).toBe('2026-09-07')
    expect(chart.rows.map((row) => row.kind === 'group' ? `group:${row.label}` : row.entity.id)).toEqual([
      'group:Alpha project',
      'alpha-phase',
      'alpha-ms',
      'group:Beta project',
      'beta-phase',
    ])
    const alphaGroup = chart.rows[0]
    expect(alphaGroup?.kind === 'group' ? alphaGroup.project : undefined)
      .toEqual({ teamId: 'core-team', projectId: 'alpha' })
    expect(chart.height).toBe(2 * CROSS_PROJECT_TIMELINE_GROUP_ROW_HEIGHT + 3 * CROSS_PROJECT_TIMELINE_ENTITY_ROW_HEIGHT)
    expect(chart.ticks.map((tick) => tick.date)).toEqual(['2026-07-01', '2026-08-01', '2026-09-01'])
    expect(chart.todayPercent).toBeGreaterThan(0)
    expect(chart.todayPercent).toBeLessThan(100)
  })

  test('reports forecast drift against the baseline and moves the bar when the forecast changes', () => {
    const baseline = { startDate: '2026-08-10', endDate: '2026-08-10' }
    const onPlan = createCrossProjectTimelineChart({
      ...baseInput,
      dependencies: [],
      entities: [
        scopedEntity('anchor', 'phase', 'alpha', { startDate: '2026-07-01', endDate: '2026-09-30' }),
        scopedEntity('ms', 'milestone', 'alpha', baseline, baseline),
      ],
    })
    const late = createCrossProjectTimelineChart({
      ...baseInput,
      dependencies: [],
      entities: [
        scopedEntity('anchor', 'phase', 'alpha', { startDate: '2026-07-01', endDate: '2026-09-30' }),
        scopedEntity('ms', 'milestone', 'alpha', { startDate: '2026-08-15', endDate: '2026-08-15' }, baseline),
      ],
    })

    const onPlanRow = onPlan?.rows.find((row) => row.kind === 'entity' && row.entity.id === 'ms')
    const lateRow = late?.rows.find((row) => row.kind === 'entity' && row.entity.id === 'ms')
    if (onPlanRow?.kind !== 'entity' || lateRow?.kind !== 'entity') throw new Error('Milestone row is missing.')
    expect(onPlanRow.endVarianceDays).toBe(0)
    expect(lateRow.endVarianceDays).toBe(5)
    expect(lateRow.forecast.leftPercent).toBeGreaterThan(onPlanRow.forecast.leftPercent)
    expect(lateRow.baseline.leftPercent).toBeCloseTo(onPlanRow.baseline.leftPercent)
  })

  test('draws dependency lines only between visible entities and flags violated constraints', () => {
    const dependency = (id: string, predecessorId: string, successorId: string, lagDays = 0): PlanningDependency => ({
      id,
      predecessorId,
      successorId,
      type: 'finish-to-start',
      lagDays,
      createdAt: '2026-07-01T00:00:00.000Z',
    })
    const chart = createCrossProjectTimelineChart({
      ...baseInput,
      dependencies: [
        dependency('ok', 'alpha-phase', 'beta-ms'),
        dependency('late', 'alpha-phase', 'beta-ms', 30),
        dependency('hidden', 'alpha-phase', 'not-visible'),
      ],
      entities: [
        scopedEntity('alpha-phase', 'phase', 'alpha', { startDate: '2026-07-01', endDate: '2026-07-31' }),
        scopedEntity('beta-ms', 'milestone', 'beta', { startDate: '2026-08-10', endDate: '2026-08-10' }),
      ],
    })

    expect(chart?.links.map((link) => [link.id, link.violated])).toEqual([
      ['ok', false],
      ['late', true],
    ])
    const link = chart?.links[0]
    expect(link?.toY).toBeGreaterThan(link?.fromY ?? Number.POSITIVE_INFINITY)
  })

  test('groups by the nearest Portfolio ancestor', () => {
    const chart = createCrossProjectTimelineChart({
      ...baseInput,
      dependencies: planningSnapshotFixture.dependencies,
      entities: planningSnapshotFixture.entities,
      grouping: 'portfolio',
    })

    const groups = chart?.rows.flatMap((row) => row.kind === 'group' ? [row.label] : []) ?? []
    expect(groups).toContain(fixtureEntity('portfolio-product').title)
    expect(chart?.rows.some((row) => row.kind === 'entity' && row.entity.type === 'goal')).toBe(false)
  })

  test('skips archived and invalid entities and returns undefined when nothing is drawable', () => {
    expect(createCrossProjectTimelineChart({
      ...baseInput,
      dependencies: [],
      entities: [
        { ...scopedEntity('archived', 'phase', 'alpha', { startDate: '2026-07-01', endDate: '2026-07-31' }), archivedAt: '2026-07-02T00:00:00.000Z' },
        scopedEntity('reversed', 'phase', 'alpha', { startDate: '2026-07-31', endDate: '2026-07-01' }),
        scopedEntity('invalid', 'phase', 'alpha', { startDate: '2026-02-30', endDate: '2026-03-01' }),
      ],
    })).toBeUndefined()
  })

  test('falls back to the Project ID when the directory does not name the Project', () => {
    const chart = createCrossProjectTimelineChart({
      ...baseInput,
      directory: undefined,
      dependencies: [],
      entities: [scopedEntity('gamma-phase', 'phase', 'gamma', { startDate: '2026-07-01', endDate: '2026-07-31' })],
    })
    const group = chart?.rows[0]
    expect(group?.kind === 'group' ? group.label : undefined).toBe('gamma')
  })
})

describe('formatLocalCalendarDate', () => {
  test('formats the local calendar date', () => {
    expect(formatLocalCalendarDate(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05')
  })
})
