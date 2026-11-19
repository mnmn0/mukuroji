import { describe, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  type PlanningSnapshot,
} from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import {
  resolveCycleBacklog,
  submitCycleWorkItemBatch,
  summarizeCycleCommitment,
} from '../src/planning/model/cycles'
import { CyclePlanningPanel } from '../src/planning/ui/CyclePlanningPanel'
import { createPlanningLabels } from '../src/planning/ui/labels'

const labels = createPlanningLabels('en').cyclePlanning

/** Adds open backlog Work Items and a carried-over link to the fixture. */
function createSnapshot(): PlanningSnapshot {
  const backlog = Array.from({ length: 22 }, (_, index) => ({
    id: `backlog-${index}`,
    revision: 1,
    teamId: 'core-team',
    title: `Backlog ${index}`,
    projectId: 'refero',
    statusCategory: 'unstarted' as const,
    dueDate: '2026-07-30',
    schedule: createDefaultDueDateWorkItemSchedule('2026-07-30'),
  }))
  return {
    ...planningSnapshotFixture,
    entities: planningSnapshotFixture.entities.map((entity) => entity.id === 'cycle-14'
      ? { ...entity, automation: { createNext: true, rolloverAtEnd: false }, nextCycleId: 'cycle-15' }
      : entity),
    workItemLinks: planningSnapshotFixture.workItemLinks.map((link, index) => index === 0
      ? { ...link, carriedOverFromCycleId: 'cycle-13', carriedOverAt: '2026-07-13T00:00:00.000Z' }
      : link),
    workItems: [
      ...planningSnapshotFixture.workItems,
      ...backlog,
      {
        ...backlog[0]!,
        id: 'done-item',
        title: 'Done item',
        statusCategory: 'completed',
      },
      { ...backlog[0]!, id: 'other-team', teamId: 'other-team', title: 'Other team' },
    ],
  }
}

describe('CyclePlanningPanel', () => {
  test('summarizes commitment, capacity, and carried-over Work Items', () => {
    const snapshot = createSnapshot()
    const cycle = snapshot.entities.find((entity) => entity.id === 'cycle-14')!
    expect(summarizeCycleCommitment(cycle, snapshot.workItemLinks)).toEqual({
      committed: 2,
      capacity: 20,
      carriedOver: 1,
    })
  })

  test('lists open Work Items of the Cycle scope that are in no Cycle as backlog', () => {
    const snapshot = createSnapshot()
    const cycle = snapshot.entities.find((entity) => entity.id === 'cycle-14')!
    const backlog = resolveCycleBacklog(cycle, snapshot)
    expect(backlog).toHaveLength(22)
    expect(backlog.map((workItem) => workItem.id)).not.toContain('done-item')
    expect(backlog.map((workItem) => workItem.id)).not.toContain('other-team')
    expect(backlog.map((workItem) => workItem.id)).not.toContain('journey-copy')
  })

  test('renders the summary, automation, next Cycle, and bulk selection controls', () => {
    const html = renderToStaticMarkup(
      <CyclePlanningPanel
        labels={labels}
        snapshot={createSnapshot()}
        onCreateNextCycle={() => undefined}
        onSetCycleWorkItems={() => undefined}
        onUpdateCycleAutomation={() => undefined}
      />,
    )
    expect(html).toContain('2 committed of 20 capacity')
    expect(html).toContain('1 carried over')
    expect(html).toContain('Next cycle: Cycle 15')
    expect(html).not.toContain('data-testid="cycle-planning-create-next"')
    expect(html).toContain('Select first 22')
    expect(html).toContain('Add 0 selected')
    expect(html).toContain('Carried over')
    expect(html).toMatch(/name="createNext"[^>]*checked=""|checked=""[^>]*name="createNext"/u)
  })

  test('offers next Cycle creation and hides changes without permission', () => {
    const html = renderToStaticMarkup(
      <CyclePlanningPanel
        canLinkEntity={() => false}
        canManageEntity={() => false}
        labels={labels}
        snapshot={planningSnapshotFixture}
        onCreateNextCycle={() => undefined}
        onSetCycleWorkItems={() => undefined}
        onUpdateCycleAutomation={() => undefined}
      />,
    )
    expect(html).toContain('data-testid="cycle-planning-create-next"')
    expect(html).not.toContain('Save automation')
    expect(html).not.toContain('Add 0 selected')
  })

  test('does not let read-only Work Items be selected for removal', () => {
    const html = renderToStaticMarkup(
      <CyclePlanningPanel
        canUpdateWorkItemLink={(workItem) => workItem.id !== 'journey-copy'}
        labels={labels}
        snapshot={planningSnapshotFixture}
        onSetCycleWorkItems={() => undefined}
      />,
    )
    const items = html.slice(html.indexOf('data-testid="cycle-planning-items"'))
    expect(items).toContain('Select first 1')
    expect(items.match(/disabled=""[^>]*type="checkbox"|type="checkbox"[^>]*disabled=""/gu)).toHaveLength(1)
  })
})

describe('submitCycleWorkItemBatch', () => {
  /** Creates a request that stays pending until the test settles it. */
  function createDeferredRequest() {
    let resolve = (): void => undefined
    let reject = (_error: unknown): void => undefined
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = () => onResolve()
      reject = onReject
    })
    return { promise, resolve, reject }
  }

  test('locks the selection while saving and clears it only after success', async () => {
    const events: string[] = []
    const hooks = {
      onStart: () => events.push('start'),
      onSuccess: () => events.push('clear'),
      onSettled: () => events.push('unlock'),
    }
    const inFlight = { current: false }
    const request = createDeferredRequest()
    const sent: string[][] = []
    const first = submitCycleWorkItemBatch(inFlight, ['a'], (items) => {
      sent.push(items)
      return request.promise
    }, hooks)

    expect(inFlight.current).toBe(true)
    expect(events).toEqual(['start'])
    expect(await submitCycleWorkItemBatch(inFlight, ['b'], (items) => {
      sent.push(items)
    }, hooks)).toBe(false)
    expect(sent).toEqual([['a']])

    request.resolve()
    expect(await first).toBe(true)
    expect(events).toEqual(['start', 'clear', 'unlock'])
    expect(inFlight.current).toBe(false)
  })

  test('keeps the selection and unlocks it when saving fails', async () => {
    const events: string[] = []
    const inFlight = { current: false }
    const request = createDeferredRequest()
    const pending = submitCycleWorkItemBatch(inFlight, ['a'], () => request.promise, {
      onStart: () => events.push('start'),
      onSuccess: () => events.push('clear'),
      onSettled: () => events.push('unlock'),
    })
    request.reject(new Error('conflict'))

    expect(await pending).toBe(false)
    expect(events).toEqual(['start', 'unlock'])
    expect(inFlight.current).toBe(false)
  })
})
