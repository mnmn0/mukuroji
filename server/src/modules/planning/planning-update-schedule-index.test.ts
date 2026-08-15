import { describe, expect, test } from 'bun:test'
import {
  createPlanningUpdateNextNotificationAtRecordKey,
  createPlanningUpdateScheduleShard,
  createPlanningUpdateScheduleShardName,
  createPlanningUpdateScheduleUpperBound,
  PLANNING_UPDATE_SCHEDULE_SHARD_COUNT,
} from './planning-update-schedule-index'

describe('Planning update schedule due index', () => {
  test('assigns targets deterministically across the fixed shard namespace', () => {
    const first = createPlanningUpdateScheduleShard(
      'workspace-1',
      'UPDATE_TARGET#PROJECT#team-1#project-1',
    )
    expect(createPlanningUpdateScheduleShard(
      'workspace-1',
      'UPDATE_TARGET#PROJECT#team-1#project-1',
    )).toBe(first)
    expect(Array.from({ length: PLANNING_UPDATE_SCHEDULE_SHARD_COUNT }, (_, index) =>
      createPlanningUpdateScheduleShardName(index)
    )).toEqual([
      'planning-update-00',
      'planning-update-01',
      'planning-update-02',
      'planning-update-03',
      'planning-update-04',
      'planning-update-05',
      'planning-update-06',
      'planning-update-07',
      'planning-update-08',
      'planning-update-09',
      'planning-update-10',
      'planning-update-11',
      'planning-update-12',
      'planning-update-13',
      'planning-update-14',
      'planning-update-15',
    ])
    expect(() => createPlanningUpdateScheduleShardName(16)).toThrow(
      'Planning update schedule shard index is invalid.',
    )
  })

  test('indexes the first effective stage and includes exact instants in query bounds', () => {
    const withReminder = createPlanningUpdateNextNotificationAtRecordKey(
      'workspace-1',
      'UPDATE_TARGET#INITIATIVE#launch',
      '2026-07-12T09:00:00.000Z',
      24,
    )
    const withoutReminder = createPlanningUpdateNextNotificationAtRecordKey(
      'workspace-1',
      'UPDATE_TARGET#INITIATIVE#launch',
      '2026-07-12T09:00:00.000Z',
      0,
    )
    expect(withReminder.startsWith('2026-07-11T09:00:00.000Z#')).toBeTrue()
    expect(withoutReminder.startsWith('2026-07-12T09:00:00.000Z#')).toBeTrue()
    expect(
      withReminder < createPlanningUpdateScheduleUpperBound('2026-07-11T09:00:00.000Z'),
    ).toBeTrue()
    expect(
      withoutReminder < createPlanningUpdateScheduleUpperBound('2026-07-12T09:00:00.000Z'),
    ).toBeTrue()
  })
})
