import { describe, expect, test } from 'bun:test'
import type { FocusItem, FocusQueueResponse } from '@mukuroji/contracts'
import { focusQueueResponseFixture } from '../src/features/focus-queue/fixtures'
import { createCollaborationQueue, filterCollaborationQueue } from '../src/features/focus-queue/model/collaborationQueue'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

const first = focusQueueResponseFixture.sections[0].items[0]
if (!first) throw new Error('Focus fixture requires an item.')

/** Creates a snapshot with an explicit ordered working set. */
function snapshot(items: FocusItem[]): FocusQueueResponse {
  return { ...focusQueueResponseFixture, sections: [{ section: 'now', items }] }
}

describe('human and agent collaboration queue', () => {
  test('preserves server section order and excludes deferred and completed work', () => {
    const entries = createCollaborationQueue(focusQueueResponseFixture)
    expect(entries.map(({ item }) => item.workItem.id)).toEqual(['WI-194', 'WI-202', 'WI-205', 'WI-207'])
    expect(entries.map(({ stage }) => stage)).toEqual(['attention', 'attention', 'active', 'waiting'])
  })

  test('does not infer review or activity from arbitrary workflow names', () => {
    const task = { ...first.workItem, statusCategory: 'unstarted' as const, workflowStatusId: 'review-in-progress' }
    const item = { ...first, workItem: task, signals: [] }
    expect(createCollaborationQueue(snapshot([item]))[0].stage).toBe('ready')
    expect(createCollaborationQueue(snapshot([{ ...item, actionability: { actionable: false, reasons: ['blocked'] } }]))[0].stage).toBe('waiting')
  })

  test('resolved signals do not demand human review and terminal states never reappear', () => {
    const resolved = { ...first, signals: first.signals.map((signal) => ({ ...signal, resolution: { ...signal.resolution, status: 'resolved' as const } })) }
    expect(createCollaborationQueue(snapshot([resolved]))[0].stage).toBe('active')
    for (const statusCategory of ['completed', 'canceled'] as const) {
      expect(createCollaborationQueue(snapshot([{ ...first, workItem: { ...first.workItem, statusCategory } }]))).toEqual([])
    }
    expect(createCollaborationQueue(snapshot([{ ...first, workItem: { ...first.workItem, archivedAt: '2026-08-01T00:00:00Z' } }]))).toEqual([])
  })

  test('deduplicates within a Team while retaining the same local ID in another Team', () => {
    const anotherTeam = { ...first, workItem: { ...first.workItem, teamId: 'design-team' } }
    expect(createCollaborationQueue(snapshot([first, first, anotherTeam])).map(({ item }) => item.workItem.teamId)).toEqual(['core-team', 'design-team'])
  })

  test('combines stage, Team, owner and Project search without reordering', () => {
    const entries = createCollaborationQueue(focusQueueResponseFixture)
    expect(filterCollaborationQueue(entries, { stage: 'attention', teamId: 'core-team', query: '  DEMO USER ' }, projectDirectoryFixtures).map(({ item }) => item.workItem.id)).toEqual(['WI-194', 'WI-202'])
    expect(filterCollaborationQueue(entries, { stage: 'all', teamId: 'design-team', query: '' }, projectDirectoryFixtures)).toEqual([])
    expect(filterCollaborationQueue(entries, { stage: 'all', teamId: '', query: 'refero' }, projectDirectoryFixtures)).toHaveLength(4)
    expect(filterCollaborationQueue(entries, { stage: 'waiting', teamId: '', query: 'WI-207' }, projectDirectoryFixtures)).toHaveLength(1)
    expect(createCollaborationQueue()).toEqual([])
  })
})
