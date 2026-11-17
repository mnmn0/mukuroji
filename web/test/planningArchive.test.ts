import { describe, expect, test } from 'bun:test'
import type { ArchivedPlanningEntitySummary, PlanningEntity } from '@mukuroji/contracts'
import { PlanningApiError } from '../src/planning/api/errors'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { isUncertainPlanningRestoreFailure } from '../src/planning/mutations/usePlanningArchive'
import {
  dropPlanningRestoreResult,
  hasPendingPlanningRestore,
  readStoredPlanningRestoreResults,
  recordPlanningRestoreResult,
  recordUncertainPlanningRestore,
  selectRestorablePlanningEntities,
  updateStoredPlanningRestoreResults,
  writeStoredPlanningRestoreResults,
  type PlanningRestoreResultView,
} from '../src/planning/model/archive'

/** Returns a fixture entity archived at the given time. */
function archiveFixtureEntity(index: number, archivedAt: string): PlanningEntity {
  const entity = planningSnapshotFixture.entities[index]
  if (!entity) throw new Error('Planning fixture is incomplete.')
  return { ...entity, archivedAt }
}

describe('archived Planning entities', () => {
  test('lists archived snapshot entities first, newest first, then the archive list without duplicates', () => {
    const older = archiveFixtureEntity(0, '2026-10-01T00:00:00.000Z')
    const newer = archiveFixtureEntity(1, '2026-11-01T00:00:00.000Z')
    const listed: ArchivedPlanningEntitySummary[] = [
      {
        id: older.id,
        type: older.type,
        title: older.title,
        ownerMemberKey: older.ownerMemberKey,
        archivedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 'goal-compacted',
        type: 'goal',
        title: 'Compacted goal',
        ownerMemberKey: 'owner@example.com',
        archivedAt: '2026-09-01T00:00:00.000Z',
      },
    ]
    const entities = [older, newer, ...planningSnapshotFixture.entities.slice(2)]

    expect(selectRestorablePlanningEntities(entities, listed).map((entity) => entity.id))
      .toEqual([newer.id, older.id, 'goal-compacted'])
    expect(selectRestorablePlanningEntities(entities, listed)[0]).toMatchObject({
      id: newer.id,
      title: newer.title,
      archivedAt: '2026-11-01T00:00:00.000Z',
    })
    // A snapshot entity the caller cannot manage is not offered; the server already filters the list.
    expect(selectRestorablePlanningEntities(entities, listed, (entity) => entity.id !== newer.id)
      .map((entity) => entity.id)).toEqual([older.id, 'goal-compacted'])
  })

  test('keeps earlier restore outcomes only while their references remain archived', () => {
    const outcome = (entityId: string, pendingReferenceCount: number): PlanningRestoreResultView => ({
      entityId,
      title: entityId,
      summary: {
        restoredLinkCount: 1,
        droppedLinkCount: 0,
        restoredDependencyCount: 0,
        retainedDependencyCount: 0,
        droppedDependencyCount: 0,
        pendingReferenceCount,
      },
    })
    const afterA = recordPlanningRestoreResult([], outcome('goal-a', 5))
    const afterB = recordPlanningRestoreResult(afterA, outcome('goal-b', 0))
    expect(afterB.map((result) => result.entityId)).toEqual(['goal-b', 'goal-a'])
    // B's finished outcome leaves when a newer restore replaces it; A still has pending references.
    const afterC = recordPlanningRestoreResult(afterB, outcome('goal-c', 0))
    expect(afterC.map((result) => result.entityId)).toEqual(['goal-c', 'goal-a'])
    // Continuing A replaces its own outcome, and A leaves once nothing is pending.
    const afterARest = recordPlanningRestoreResult(afterC, outcome('goal-a', 0))
    expect(afterARest.map((result) => result.entityId)).toEqual(['goal-a'])
  })

  test('keeps a retry target for a restore whose outcome is unknown', () => {
    const pending: PlanningRestoreResultView = {
      entityId: 'goal-a',
      title: 'Goal A',
      summary: {
        restoredLinkCount: 1,
        droppedLinkCount: 0,
        restoredDependencyCount: 0,
        retainedDependencyCount: 0,
        droppedDependencyCount: 0,
        pendingReferenceCount: 3,
      },
    }
    const uncertain = recordUncertainPlanningRestore([pending], { entityId: 'goal-b', title: 'Goal B' })
    expect(uncertain).toEqual([{ entityId: 'goal-b', title: 'Goal B' }, pending])
    expect(uncertain.every(hasPendingPlanningRestore)).toBe(true)
    // A failed continuation keeps the counts the earlier restore reported.
    expect(recordUncertainPlanningRestore(uncertain, { entityId: 'goal-a', title: 'Goal A' }))
      .toEqual(uncertain)
    // A finished outcome offers no continuation, so an unknown restore of that entity replaces it.
    const finished: PlanningRestoreResultView = {
      ...pending,
      entityId: 'goal-c',
      title: 'Goal C',
      summary: { ...pending.summary!, pendingReferenceCount: 0 },
    }
    expect(recordUncertainPlanningRestore([pending, finished], { entityId: 'goal-c', title: 'Goal C' }))
      .toEqual([{ entityId: 'goal-c', title: 'Goal C' }, pending])
    // A later successful restore of the same entity replaces the unknown outcome.
    const restored = recordPlanningRestoreResult(uncertain, {
      ...pending,
      entityId: 'goal-b',
      title: 'Goal B',
      summary: { ...pending.summary!, pendingReferenceCount: 0 },
    })
    expect(restored.map((result) => result.entityId)).toEqual(['goal-b', 'goal-a'])
    expect(hasPendingPlanningRestore(restored[0]!)).toBe(false)
  })

  test('saves unfinished restores per member and reads back only valid pending ones', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    const summary = {
      restoredLinkCount: 1,
      droppedLinkCount: 0,
      restoredDependencyCount: 0,
      retainedDependencyCount: 0,
      droppedDependencyCount: 0,
      pendingReferenceCount: 2,
    }
    const pending: PlanningRestoreResultView = { entityId: 'goal-a', title: 'Goal A', summary }
    const unknown: PlanningRestoreResultView = { entityId: 'goal-b', title: 'Goal B' }
    const finished: PlanningRestoreResultView = {
      entityId: 'goal-c',
      title: 'Goal C',
      summary: { ...summary, pendingReferenceCount: 0 },
    }

    writeStoredPlanningRestoreResults(storage, 'member-1', [finished, unknown, pending])
    expect(readStoredPlanningRestoreResults(storage, 'member-1')).toEqual([unknown, pending])
    // Every unfinished restore is kept, however many there are.
    const many = Array.from({ length: 60 }, (_, index) => ({ ...unknown, entityId: `goal-${index}` }))
    writeStoredPlanningRestoreResults(storage, 'member-3', many)
    expect(readStoredPlanningRestoreResults(storage, 'member-3')).toHaveLength(60)
    writeStoredPlanningRestoreResults(storage, 'member-3', [])
    expect(readStoredPlanningRestoreResults(storage, 'member-2')).toEqual([])
    // Nothing left to continue clears the saved entry.
    writeStoredPlanningRestoreResults(storage, 'member-1', [finished])
    expect(values.size).toBe(0)

    values.set('mukuroji.planning.pendingRestores:member-1', JSON.stringify([
      { entityId: 'goal-a', title: 'Goal A', summary: { ...summary, pendingReferenceCount: -1 } },
      { entityId: '', title: 'Empty' },
      unknown,
      { ...unknown, title: 'Duplicate' },
    ]))
    expect(readStoredPlanningRestoreResults(storage, 'member-1')).toEqual([unknown])
    values.set('mukuroji.planning.pendingRestores:member-1', '{not json')
    expect(readStoredPlanningRestoreResults(storage, 'member-1')).toEqual([])
    // Unavailable or failing storage reads as empty and ignores writes.
    expect(readStoredPlanningRestoreResults(undefined, 'member-1')).toEqual([])
    const failing = {
      getItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(readStoredPlanningRestoreResults(failing, 'member-1')).toEqual([])
    expect(() => writeStoredPlanningRestoreResults(failing, 'member-1', [pending])).not.toThrow()

    expect(dropPlanningRestoreResult([unknown, pending], 'goal-b')).toEqual([pending])

    // Another tab of the same member saved goal-a; this tab, which never showed it, finishes
    // goal-c and loses track of goal-b, and goal-a stays saved.
    writeStoredPlanningRestoreResults(storage, 'member-1', [pending, unknown])
    updateStoredPlanningRestoreResults(storage, 'member-1', (current) =>
      recordPlanningRestoreResult(current, finished))
    updateStoredPlanningRestoreResults(storage, 'member-1', (current) =>
      dropPlanningRestoreResult(current, 'goal-b'))
    expect(readStoredPlanningRestoreResults(storage, 'member-1')).toEqual([pending])
    updateStoredPlanningRestoreResults(storage, 'member-1', (current) =>
      recordUncertainPlanningRestore(current, { entityId: 'goal-d', title: 'Goal D' }))
    expect(readStoredPlanningRestoreResults(storage, 'member-1').map((result) => result.entityId))
      .toEqual(['goal-d', 'goal-a'])
  })

  test('treats only failures that may follow a committed restore as uncertain', () => {
    expect(isUncertainPlanningRestoreFailure(new PlanningApiError(503, 'Unavailable.'))).toBe(true)
    expect(isUncertainPlanningRestoreFailure(new TypeError('Failed to fetch'))).toBe(true)
    // The server reports a changed grant after the entity may already be active again.
    expect(isUncertainPlanningRestoreFailure(
      new PlanningApiError(409, 'Changed.', 'PlanningAuthorizationChanged'),
    )).toBe(true)
    expect(isUncertainPlanningRestoreFailure(
      new PlanningApiError(409, 'Conflict.', 'PlanningRevisionConflict'),
    )).toBe(false)
    expect(isUncertainPlanningRestoreFailure(
      new PlanningApiError(409, 'Inactive.', 'PlanningOwnerInactive'),
    )).toBe(false)
  })
})
