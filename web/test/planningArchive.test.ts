import { describe, expect, test } from 'bun:test'
import type { ArchivedPlanningEntitySummary, PlanningEntity } from '@mukuroji/contracts'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { selectRestorablePlanningEntities } from '../src/planning/model/archive'

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
})
