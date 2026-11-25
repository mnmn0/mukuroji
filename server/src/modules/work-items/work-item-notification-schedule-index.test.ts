import { expect, test } from 'bun:test'
import {
  WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY,
  WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_COUNT,
  createWorkItemNotificationDueKey,
  createWorkItemNotificationScheduleAttributes,
  createWorkItemNotificationScheduleShard,
  createWorkItemNotificationScheduleShardName,
  createWorkItemNotificationScheduleUpdate,
  createWorkItemStartedDirectoryTeamId,
} from './work-item-notification-schedule-index'

test('keeps only open Work Items with a deadline or in progress in the due index', () => {
  expect(createWorkItemNotificationDueKey({ statusCategory: 'unstarted', dueDate: '2026-07-12' }))
    .toBe('2026-07-12')
  expect(createWorkItemNotificationDueKey({ statusCategory: 'backlog', dueDate: '2026-07-12' }))
    .toBe('2026-07-12')
  expect(createWorkItemNotificationDueKey({ statusCategory: 'unstarted', dueDate: '' }))
    .toBeUndefined()
  // Started Work Items are read on every run for the stale reminder, deadline or not.
  expect(createWorkItemNotificationDueKey({ statusCategory: 'started', dueDate: '' }))
    .toBe(WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY)
  expect(createWorkItemNotificationDueKey({ statusCategory: 'started', dueDate: '2027-01-01' }))
    .toBe(WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY)
  expect(WORK_ITEM_NOTIFICATION_ALWAYS_DUE_KEY < '1970-01-01').toBeTrue()
  for (const statusCategory of ['completed', 'canceled', 'triage', undefined]) {
    expect(createWorkItemNotificationDueKey({ statusCategory, dueDate: '2026-07-12' }))
      .toBeUndefined()
  }
  expect(createWorkItemNotificationDueKey({
    statusCategory: 'started',
    dueDate: '2026-07-12',
    archivedAt: '2026-07-01T00:00:00.000Z',
  })).toBeUndefined()
})

test('assigns a stable shard from the Work Item keys', () => {
  const shard = createWorkItemNotificationScheduleShard('workspace-1', 'core-team', 'issue-1')

  expect(shard).toMatch(/^work-item-schedule-\d{2}$/)
  expect(createWorkItemNotificationScheduleShard('workspace-1', 'core-team', 'issue-1')).toBe(shard)
  const shards = new Set(Array.from({ length: 200 }, (_, index) =>
    createWorkItemNotificationScheduleShard('workspace-1', 'core-team', `issue-${index}`)
  ))
  expect(shards.size).toBe(WORK_ITEM_NOTIFICATION_SCHEDULE_SHARD_COUNT)
  expect(() => createWorkItemNotificationScheduleShard('workspace-1', ' ', 'issue-1')).toThrow(TypeError)
  // The CDK demo seed copies this hash; cdk/test/bootstrap.suite.ts pins the same values.
  expect(createWorkItemNotificationScheduleShard('directory-1', 'core-team', 'wireframe'))
    .toBe('work-item-schedule-01')
  expect(createWorkItemNotificationScheduleShard('directory-1', 'core-team', 'seo-research'))
    .toBe('work-item-schedule-06')
  expect(createWorkItemNotificationScheduleShardName(15)).toBe('work-item-schedule-15')
  expect(() => createWorkItemNotificationScheduleShardName(16)).toThrow(TypeError)
})

test('writes the shard on every save and removes the due key when the Work Item leaves the index', () => {
  expect(createWorkItemNotificationScheduleAttributes('workspace-1', 'core-team', 'issue-1', {
    statusCategory: 'unstarted',
    dueDate: '2026-07-12',
  })).toEqual({
    notificationScheduleShard: createWorkItemNotificationScheduleShard('workspace-1', 'core-team', 'issue-1'),
    notificationDueKey: '2026-07-12',
  })

  const completed = createWorkItemNotificationScheduleUpdate('workspace-1', 'core-team', 'issue-1', {
    statusCategory: 'completed',
    dueDate: '2026-07-12',
  })
  expect(completed).toEqual({
    setExpressions: ['#notificationScheduleShard = :notificationScheduleShard'],
    removeExpressions: ['#notificationDueKey', '#startedDirectoryTeamId'],
    expressionAttributeNames: {
      '#notificationScheduleShard': 'notificationScheduleShard',
      '#notificationDueKey': 'notificationDueKey',
      '#startedDirectoryTeamId': 'startedDirectoryTeamId',
    },
    expressionAttributeValues: {
      ':notificationScheduleShard': createWorkItemNotificationScheduleShard('workspace-1', 'core-team', 'issue-1'),
    },
  })

  const rescheduled = createWorkItemNotificationScheduleUpdate('workspace-1', 'core-team', 'issue-1', {
    statusCategory: 'unstarted',
    dueDate: '2026-08-01',
  })
  expect(rescheduled.setExpressions).toContain('#notificationDueKey = :notificationDueKey')
  expect(rescheduled.removeExpressions).toEqual(['#startedDirectoryTeamId'])
  expect(rescheduled.expressionAttributeValues[':notificationDueKey']).toBe('2026-08-01')
})

test('keeps only started, unarchived Work Items in the Team started index', () => {
  expect(createWorkItemStartedDirectoryTeamId('workspace-1', 'core-team', { statusCategory: 'started', dueDate: '' }))
    .toBe('workspace-1#team#core-team')
  for (const statusCategory of ['backlog', 'unstarted', 'completed', 'canceled', 'triage', undefined]) {
    expect(createWorkItemStartedDirectoryTeamId('workspace-1', 'core-team', { statusCategory, dueDate: '' }))
      .toBeUndefined()
  }
  expect(createWorkItemStartedDirectoryTeamId('workspace-1', 'core-team', {
    statusCategory: 'started',
    dueDate: '',
    archivedAt: '2026-07-01T00:00:00.000Z',
  })).toBeUndefined()

  expect(createWorkItemNotificationScheduleAttributes('workspace-1', 'core-team', 'issue-1', {
    statusCategory: 'started',
    dueDate: '',
  })).toMatchObject({ startedDirectoryTeamId: 'workspace-1#team#core-team' })
  const started = createWorkItemNotificationScheduleUpdate('workspace-1', 'core-team', 'issue-1', {
    statusCategory: 'started',
    dueDate: '',
  })
  expect(started.setExpressions).toContain('#startedDirectoryTeamId = :startedDirectoryTeamId')
  expect(started.removeExpressions).not.toContain('#startedDirectoryTeamId')
  expect(started.expressionAttributeValues[':startedDirectoryTeamId']).toBe('workspace-1#team#core-team')
})
