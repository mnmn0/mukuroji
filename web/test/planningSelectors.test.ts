import { describe, expect, test } from 'bun:test'
import type { PlanningEntity } from '@mukuroji/contracts'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import {
  createPlanningEntityDetailKey,
  isPlanningWorkItemLinkCandidate,
  resolvePlanningCycleRolloverTargets,
} from '../src/planning/selectors'

describe('planning selectors', () => {
  test('remounts detail forms across entity IDs while preserving one entity snapshot identity', () => {
    const first = planningSnapshotFixture.entities[0]!
    const sameEntityUpdated = { ...first, title: `${first.title} updated` }
    const differentEntity = planningSnapshotFixture.entities[1]!

    expect(createPlanningEntityDetailKey(sameEntityUpdated)).toBe(
      createPlanningEntityDetailKey(first),
    )
    expect(createPlanningEntityDetailKey(differentEntity)).not.toBe(
      createPlanningEntityDetailKey(first),
    )
  })

  test('limits Work Item link targets to compatible open Team and Project scopes', () => {
    const workItem = planningSnapshotFixture.workItems[0]!
    const milestone = planningSnapshotFixture.entities.find(
      (entity) => entity.id === 'milestone-beta',
    )!

    expect(isPlanningWorkItemLinkCandidate(milestone, workItem)).toBe(true)
    expect(isPlanningWorkItemLinkCandidate(
      { ...milestone, teamId: 'other-team' },
      workItem,
    )).toBe(false)
    expect(isPlanningWorkItemLinkCandidate(
      { ...milestone, projectId: 'other-project' },
      workItem,
    )).toBe(false)
    expect(isPlanningWorkItemLinkCandidate(
      { ...milestone, status: 'completed' },
      workItem,
    )).toBe(false)
    expect(isPlanningWorkItemLinkCandidate(
      { ...milestone, archivedAt: '2026-07-16T05:00:00.000Z' },
      workItem,
    )).toBe(false)
  })

  test('offers only later open Cycle targets with matching scope and cadence', () => {
    const source = planningSnapshotFixture.entities.find(
      (entity) => entity.id === 'cycle-14',
    )!
    const validTarget = planningSnapshotFixture.entities.find(
      (entity) => entity.id === 'cycle-15',
    )!
    const candidates: PlanningEntity[] = [
      source,
      validTarget,
      { ...validTarget, id: 'cycle-wrong-team', teamId: 'other-team' },
      { ...validTarget, id: 'cycle-wrong-project', projectId: 'other-project' },
      { ...validTarget, id: 'cycle-wrong-cadence', cadence: { unit: 'month', count: 1 } },
      {
        ...validTarget,
        id: 'cycle-not-later',
        baseline: { ...validTarget.baseline, startDate: source.baseline.endDate },
      },
      { ...validTarget, id: 'cycle-completed', status: 'completed' },
      { ...validTarget, id: 'cycle-archived', archivedAt: '2026-07-16T05:00:00.000Z' },
    ]

    expect(resolvePlanningCycleRolloverTargets(source, candidates).map((cycle) => cycle.id))
      .toEqual([validTarget.id])
    expect(resolvePlanningCycleRolloverTargets(
      { ...source, status: 'canceled' },
      candidates,
    )).toEqual([])
  })
})
