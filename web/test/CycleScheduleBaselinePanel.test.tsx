import { describe, expect, test } from 'bun:test'
import type { CycleScheduleBaseline, CycleScheduleBaselineResponse, PlanningSnapshot } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { compareCycleBaseline } from '../src/planning/model/cycleBaselines'
import { CycleScheduleBaselinePanel } from '../src/planning/ui/CycleScheduleBaselinePanel'
import { createPlanningLabels } from '../src/planning/ui/labels'

const labels = createPlanningLabels('en').cycleBaseline

/** Snapshot whose Cycle holds the two fixture items plus one added since the baseline. */
const snapshot: PlanningSnapshot = {
  ...planningSnapshotFixture,
  workItemLinks: [
    ...planningSnapshotFixture.workItemLinks.filter((link) => link.workItemId !== 'journey-events'),
    {
      teamId: 'core-team',
      workItemId: 'late-add',
      projectId: 'refero',
      cycleId: 'cycle-14',
      goalIds: [],
      createdAt: '2026-07-14T00:00:00.000Z',
    },
  ],
  workItems: [
    ...planningSnapshotFixture.workItems,
    {
      ...planningSnapshotFixture.workItems[0]!,
      id: 'late-add',
      title: 'Late addition',
    },
  ],
}

/** Baseline taken before `journey-copy` moved its end out and `journey-events` left the Cycle. */
const baseline: CycleScheduleBaseline = {
  id: 'cb-1',
  name: 'Sprint start',
  capturedAt: '2026-07-12T00:00:00.000Z',
  entryCount: 3,
  entries: [
    { teamId: 'core-team', workItemId: 'journey-copy', endDate: '2026-07-19' },
    { teamId: 'core-team', workItemId: 'journey-events', endDate: '2026-07-25' },
  ],
}

describe('Cycle schedule baselines', () => {
  test('compares the baseline scope and plan with the Cycle now', () => {
    const comparison = compareCycleBaseline(baseline, 'cycle-14', snapshot)
    expect(comparison.committed).toBe(3)
    expect(comparison.stillIn).toBe(1)
    expect(comparison.added.map((workItem) => workItem.id)).toEqual(['late-add'])
    expect(comparison.removed).toEqual([
      { entry: baseline.entries[1], title: 'Instrument activation events' },
    ])
    expect(comparison.hidden).toBe(1)
    expect(comparison.slipped).toEqual([
      { workItem: expect.objectContaining({ id: 'journey-copy' }), endSlipDays: 3 },
    ])
    expect(comparison.effortDeltaMinutes).toBe(0)
  })

  test('does not count a closed Work Item as slipped', () => {
    const closed = {
      ...snapshot,
      workItems: snapshot.workItems.map((workItem) =>
        workItem.id === 'journey-copy' ? { ...workItem, statusCategory: 'canceled' as const } : workItem),
    }
    expect(compareCycleBaseline(baseline, 'cycle-14', closed).slipped).toEqual([])
  })

  test('renders the comparison, the picker, and the save form for a manager', () => {
    const cycle = snapshot.entities.find((entity) => entity.id === 'cycle-14')!
    const response: CycleScheduleBaselineResponse = {
      cycleId: 'cycle-14',
      revision: 1,
      baseline,
      savedBaselines: [{ id: 'cb-1', name: 'Sprint start', capturedAt: baseline.capturedAt, entryCount: 3 }],
    }
    const html = renderToStaticMarkup(
      <CycleScheduleBaselinePanel
        canCapture
        captureFailed={false}
        cycle={cycle}
        hasError={false}
        isCapturing={false}
        isLoading={false}
        labels={labels}
        response={response}
        snapshot={snapshot}
        onCapture={() => undefined}
        onRetry={() => undefined}
        onSelect={() => undefined}
      />,
    )
    expect(html).toContain('3 at the baseline')
    expect(html).toContain('1 added')
    expect(html).toContain('1 removed')
    expect(html).toContain('1 you cannot see')
    expect(html).toContain('3 days late')
    expect(html).toContain('Sprint start')
    expect(html).toContain('data-testid="cycle-baseline-capture"')
  })

  test('hides the save form from a viewer and explains an empty Cycle history', () => {
    const cycle = snapshot.entities.find((entity) => entity.id === 'cycle-14')!
    const html = renderToStaticMarkup(
      <CycleScheduleBaselinePanel
        canCapture={false}
        captureFailed={false}
        cycle={cycle}
        hasError={false}
        isCapturing={false}
        isLoading={false}
        labels={labels}
        response={{ cycleId: 'cycle-14', revision: 0, baseline: null, savedBaselines: [] }}
        snapshot={snapshot}
        onCapture={() => undefined}
        onRetry={() => undefined}
        onSelect={() => undefined}
      />,
    )
    expect(html).toContain('No baseline has been saved for this Cycle yet.')
    expect(html).not.toContain('cycle-baseline-capture')
  })
})
