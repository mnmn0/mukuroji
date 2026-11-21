import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import {
  createPlanningBaselineDelayCandidates,
  listPlanningTargetBaselineWorkItems,
  mergePlanningUpdateEvidence,
} from '../src/planning/model/baselineDelayEvidence'
import { PlanningStatusUpdateComposer } from '../src/planning/ui/PlanningUpdatePrimitives'
import { createPlanningLabels } from '../src/planning/ui/labels'
import type { WorkItemBaselineLookup } from '../src/work-items/model/workItemScheduleBaselines'

const target = { type: 'project' as const, teamId: 'core-team', projectId: 'refero' }

/** Baseline in which `journey-copy` was due five days earlier and `journey-events` on time. */
const baselineFor: WorkItemBaselineLookup = (workItem) => {
  if (workItem.teamId !== 'core-team' || workItem.assignedProjectId !== 'refero') return undefined
  if (workItem.id === 'journey-copy') return { workItemId: 'journey-copy', endDate: '2026-07-17' }
  if (workItem.id === 'journey-events') return { workItemId: 'journey-events', endDate: '2026-07-25' }
  return undefined
}

describe('Planning update baseline delays', () => {
  test('lists the delayed Work Items and Milestones of the target, most delayed first', () => {
    const candidates = createPlanningBaselineDelayCandidates(
      planningSnapshotFixture,
      target,
      baselineFor,
      [{ type: 'planning-entity', entityId: 'milestone-beta' }],
    )
    expect(candidates.map(({ kind, title, delayDays, reportedBefore }) => ({ kind, title, delayDays, reportedBefore }))).toEqual([
      { kind: 'milestone', title: expect.any(String), delayDays: 7, reportedBefore: true },
      { kind: 'work-item', title: 'Finalize onboarding copy', delayDays: 5, reportedBefore: false },
    ])
    expect(candidates[1]?.evidence).toEqual({ type: 'work-item', teamId: 'core-team', workItemId: 'journey-copy' })
  })

  test('leaves out completed Work Items and records outside the target', () => {
    const snapshot = {
      ...planningSnapshotFixture,
      workItems: planningSnapshotFixture.workItems.map((workItem) =>
        workItem.id === 'journey-copy' ? { ...workItem, statusCategory: 'completed' as const } : workItem),
    }
    expect(createPlanningBaselineDelayCandidates(snapshot, target, baselineFor, [])
      .some((candidate) => candidate.kind === 'work-item')).toBe(false)
    expect(createPlanningBaselineDelayCandidates(
      planningSnapshotFixture,
      { type: 'project', teamId: 'other-team', projectId: 'refero' },
      baselineFor,
      [],
    )).toEqual([])
    expect(listPlanningTargetBaselineWorkItems(planningSnapshotFixture, target).map((workItem) => workItem.id))
      .toEqual(['journey-copy', 'journey-events'])
  })

  test('merges attached delays with hand-picked evidence without duplicates', () => {
    expect(mergePlanningUpdateEvidence(
      [{ type: 'work-item', teamId: 't', workItemId: 'a' }],
      [{ type: 'work-item', teamId: 't', workItemId: 'a' }, { type: 'planning-entity', entityId: 'm' }],
    )).toEqual([
      { type: 'work-item', teamId: 't', workItemId: 'a' },
      { type: 'planning-entity', entityId: 'm' },
    ])
  })

  test('offers attaching every delay in one action from the composer', () => {
    const candidates = createPlanningBaselineDelayCandidates(planningSnapshotFixture, target, baselineFor, [])
    const html = renderToStaticMarkup(
      <PlanningStatusUpdateComposer
        baselineDelays={{ status: 'ready', candidates }}
        health="on-track"
        labels={createPlanningLabels('en')}
        onPublish={() => undefined}
        progress={40}
      />,
    )
    expect(html).toContain('data-testid="planning-update-baseline-delays"')
    expect(html).toContain('Attach 2 delays as evidence')
    expect(html).toContain('5 days late')
    expect(html).toContain('New since last update')
  })

  test('says so when nothing is behind the baseline', () => {
    const html = renderToStaticMarkup(
      <PlanningStatusUpdateComposer
        baselineDelays={{ status: 'ready', candidates: [] }}
        health="on-track"
        labels={createPlanningLabels('ja')}
        onPublish={() => undefined}
        progress={40}
      />,
    )
    expect(html).toContain('ベースラインより遅れているものはありません。')
    expect(html).not.toContain('根拠に添付')
  })
})

describe('Planning update baseline delay failures', () => {
  test('shows a retry instead of an empty list when a baseline cannot be read', () => {
    const html = renderToStaticMarkup(
      <PlanningStatusUpdateComposer
        baselineDelays={{ status: 'error', retry: () => undefined }}
        health="on-track"
        labels={createPlanningLabels('en')}
        onPublish={() => undefined}
        progress={40}
      />,
    )
    expect(html).toContain('The baselines could not be loaded')
    expect(html).toContain('Load again')
    expect(html).not.toContain('Nothing is behind the baseline.')
  })
})
