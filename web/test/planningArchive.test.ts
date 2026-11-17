import { describe, expect, test } from 'bun:test'
import type { ArchivedPlanningEntitySummary, PlanningEntity } from '@mukuroji/contracts'
import { PlanningApiError } from '../src/planning/api/errors'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import {
  isUncertainPlanningRestoreFailure,
  planningRestoreMayHaveCommitted,
} from '../src/planning/mutations/usePlanningArchive'
import {
  dropPlanningRestoreResult,
  hasPendingPlanningRestore,
  readStoredPlanningRestoreResults,
  recordPlanningRestoreResult,
  recordUncertainPlanningRestore,
  selectRestorablePlanningEntities,
  updateStoredPlanningRestoreResults,
  writeStoredPlanningRestoreResult,
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

  test('saves unfinished restores per member and entity and reads back only valid pending ones', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size
      },
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

    writeStoredPlanningRestoreResult(storage, 'member-1', 'goal-a', pending, 1)
    writeStoredPlanningRestoreResult(storage, 'member-1', 'goal-b', unknown, 2)
    // A finished outcome is not saved.
    writeStoredPlanningRestoreResult(storage, 'member-1', 'goal-c', finished, 3)
    expect(readStoredPlanningRestoreResults(storage, 'member-1')).toEqual([unknown, pending])
    expect(readStoredPlanningRestoreResults(storage, 'member-2')).toEqual([])
    // Every unfinished restore is kept, however many there are.
    for (let index = 0; index < 60; index += 1) {
      writeStoredPlanningRestoreResult(storage, 'member-3', `goal-${index}`, { ...unknown, entityId: `goal-${index}` })
    }
    expect(readStoredPlanningRestoreResults(storage, 'member-3')).toHaveLength(60)
    for (let index = 0; index < 60; index += 1) {
      writeStoredPlanningRestoreResult(storage, 'member-3', `goal-${index}`, undefined)
    }
    // Finishing an entity removes only its own entry.
    writeStoredPlanningRestoreResult(storage, 'member-1', 'goal-b', undefined)
    expect(readStoredPlanningRestoreResults(storage, 'member-1')).toEqual([pending])
    writeStoredPlanningRestoreResult(storage, 'member-1', 'goal-a', { ...pending, summary: finished.summary })
    expect(values.size).toBe(0)

    // Invalid, finished, misplaced and unreadable entries are skipped without hiding valid ones.
    const prefix = 'mukuroji.planning.pendingRestore:member-1:'
    values.set(`${prefix}goal-a`, JSON.stringify({
      result: { ...pending, summary: { ...summary, pendingReferenceCount: -1 } },
      savedAt: 1,
    }))
    values.set(`${prefix}goal-x`, JSON.stringify({ result: unknown, savedAt: 1 }))
    values.set(`${prefix}goal-y`, '{not json')
    values.set(`${prefix}goal-b`, JSON.stringify({ result: unknown, savedAt: 5 }))
    expect(readStoredPlanningRestoreResults(storage, 'member-1')).toEqual([unknown])
    values.clear()

    // Unavailable or failing storage reads as empty and ignores writes.
    expect(readStoredPlanningRestoreResults(undefined, 'member-1')).toEqual([])
    const failing = {
      getItem: () => { throw new Error('blocked') },
      key: () => { throw new Error('blocked') },
      length: 1,
      removeItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(readStoredPlanningRestoreResults(failing, 'member-1')).toEqual([])
    expect(() => writeStoredPlanningRestoreResult(failing, 'member-1', 'goal-a', pending)).not.toThrow()

    expect(dropPlanningRestoreResult([unknown, pending], 'goal-b')).toEqual([pending])

    // Two tabs that read the same saved list and change different entities keep each other's
    // entries: each writes only its own entity's key.
    writeStoredPlanningRestoreResult(storage, 'member-1', 'goal-a', pending, 1)
    updateStoredPlanningRestoreResults(storage, 'member-1', 'goal-c', (current) =>
      recordPlanningRestoreResult(current, finished))
    updateStoredPlanningRestoreResults(storage, 'member-1', 'goal-d', (current) =>
      recordUncertainPlanningRestore(current, { entityId: 'goal-d', title: 'Goal D' }))
    expect(readStoredPlanningRestoreResults(storage, 'member-1').map((result) => result.entityId))
      .toEqual(['goal-d', 'goal-a'])
    updateStoredPlanningRestoreResults(storage, 'member-1', 'goal-d', (current) =>
      dropPlanningRestoreResult(current, 'goal-d'))
    expect(readStoredPlanningRestoreResults(storage, 'member-1')).toEqual([pending])

    // Interleaved: both tabs read the same saved state before either writes.
    const seenByBoth = readStoredPlanningRestoreResults(storage, 'member-1')
    const tabA = recordUncertainPlanningRestore(seenByBoth, { entityId: 'goal-e', title: 'Goal E' })
    const tabB = recordUncertainPlanningRestore(seenByBoth, { entityId: 'goal-f', title: 'Goal F' })
    writeStoredPlanningRestoreResult(storage, 'member-1', 'goal-e', tabA.find((result) => result.entityId === 'goal-e'), 10)
    writeStoredPlanningRestoreResult(storage, 'member-1', 'goal-f', tabB.find((result) => result.entityId === 'goal-f'), 11)
    expect(readStoredPlanningRestoreResults(storage, 'member-1').map((result) => result.entityId))
      .toEqual(['goal-f', 'goal-e', 'goal-a'])
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

  test('decides from the reloaded snapshot whether a failed restore brought the entity back', () => {
    const conflict = new PlanningApiError(409, 'Conflict.', 'PlanningRevisionConflict')
    const fixtureEntity = planningSnapshotFixture.entities[0]
    if (!fixtureEntity) throw new Error('Planning fixture is incomplete.')
    const active = { ...planningSnapshotFixture }
    const stillArchived = {
      ...planningSnapshotFixture,
      entities: planningSnapshotFixture.entities.map((entity) =>
        entity.id === fixtureEntity.id ? { ...entity, archivedAt: '2026-11-01T00:00:00.000Z' } : entity),
    }
    // A conflict from the final read after the commit: the entity is active again.
    expect(planningRestoreMayHaveCommitted(conflict, fixtureEntity.id, active)).toBe(true)
    // A rejected restore leaves the entity archived or out of the live graph.
    expect(planningRestoreMayHaveCommitted(conflict, fixtureEntity.id, stillArchived)).toBe(false)
    expect(planningRestoreMayHaveCommitted(new PlanningApiError(503, 'Down.'), 'goal-compacted', active))
      .toBe(false)
    // Without a reloaded snapshot the error decides.
    expect(planningRestoreMayHaveCommitted(conflict, fixtureEntity.id, undefined)).toBe(false)
    expect(planningRestoreMayHaveCommitted(new PlanningApiError(503, 'Down.'), fixtureEntity.id, undefined))
      .toBe(true)
  })
})
