import { expect, test } from 'bun:test'
import {
  createWorkItemMemberIndexRecord,
  createWorkItemMemberIndexTransactItems,
  isWorkItemMemberIndexRecord,
  listWorkItemMemberIndexKeys,
} from './work-item-member-index'

test('indexes the owner and every contributor with a member once, normalized', () => {
  expect(listWorkItemMemberIndexKeys({
    assigneeUserId: ' Sato@Example.com ',
    contributorAssignments: [
      { assignmentId: 'a', memberUserId: 'sato@example.com', status: 'planned' },
      { assignmentId: 'b', memberUserId: 'Kato@example.com', status: 'done' },
      { assignmentId: 'c', jobRoleId: 'designer', status: 'planned' },
    ],
  })).toEqual(['kato@example.com', 'sato@example.com'])
})

test('keys rows by member and by an unambiguous Team and Work Item pair', () => {
  const left = createWorkItemMemberIndexRecord('ws', 'a#b', 'c', 'sato@example.com')
  const right = createWorkItemMemberIndexRecord('ws', 'a', 'b#c', 'sato@example.com')

  expect(left.directoryTeamId).toBe('ws#member-work-items#sato@example.com')
  expect(left.issueId).not.toBe(right.issueId)
  expect(isWorkItemMemberIndexRecord(left)).toBeTrue()
  expect(isWorkItemMemberIndexRecord({ ...left, issueId: right.issueId })).toBeFalse()
  expect(isWorkItemMemberIndexRecord({ ...left, directoryTeamId: 'ws#team#a#b' })).toBeFalse()
})

test('writes only the membership difference and appends deletes after puts', () => {
  const items = createWorkItemMemberIndexTransactItems(
    'work-items',
    'ws',
    'core-team',
    'item-1',
    {
      assigneeUserId: 'sato@example.com',
      contributorAssignments: [{ assignmentId: 'a', memberUserId: 'kato@example.com', status: 'planned' }],
    },
    {
      assigneeUserId: 'sato@example.com',
      contributorAssignments: [{ assignmentId: 'b', memberUserId: 'ito@example.com', status: 'planned' }],
    },
  )

  expect(items).toEqual([
    {
      Put: {
        TableName: 'work-items',
        Item: createWorkItemMemberIndexRecord('ws', 'core-team', 'item-1', 'ito@example.com'),
      },
    },
    {
      Delete: {
        TableName: 'work-items',
        Key: {
          directoryTeamId: 'ws#member-work-items#kato@example.com',
          issueId: 'core-team#item-1',
        },
      },
    },
  ])
  expect(createWorkItemMemberIndexTransactItems(
    'work-items',
    'ws',
    'core-team',
    'item-1',
    { assigneeUserId: 'sato@example.com' },
    { assigneeUserId: 'SATO@example.com' },
  )).toEqual([])
})

test('creates rows for a new Work Item and removes them for a deleted one', () => {
  const source = { assigneeUserId: 'sato@example.com' }

  expect(createWorkItemMemberIndexTransactItems('t', 'ws', 'team', 'id', undefined, source))
    .toHaveLength(1)
  expect(createWorkItemMemberIndexTransactItems('t', 'ws', 'team', 'id', source, undefined))
    .toEqual([{
      Delete: {
        TableName: 't',
        Key: { directoryTeamId: 'ws#member-work-items#sato@example.com', issueId: 'team#id' },
      },
    }])
})

test('backfill migration derives index rows from canonical Work Items only', async () => {
  const { workItemMemberIndexMigration } = await import('./work-item-member-index-migration')
  const { WORK_ITEM_SCHEMA_VERSION, createDefaultDueDateWorkItemSchedule } = await import('@mukuroji/contracts')
  const workItem = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 2,
    workflowSchemaVersion: 1,
    directoryId: 'ws',
    directoryTeamId: 'ws#team#core-team',
    teamId: 'core-team',
    issueId: 'item-1',
    sortOrder: 1,
    title: 'Title',
    assigneeUserId: 'sato@example.com',
    contributorAssignments: [{ assignmentId: 'a'.repeat(32), memberUserId: 'kato@example.com', status: 'planned' }],
    creatorMemberKey: 'sato@example.com',
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-18',
    schedule: createDefaultDueDateWorkItemSchedule('2026-06-18'),
    priority: 'medium',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }

  expect(workItemMemberIndexMigration.classify(workItem)).toBe('pending')
  const derived = workItemMemberIndexMigration.derive(workItem)
  expect(derived.map((row) => row.memberKey)).toEqual(['kato@example.com', 'sato@example.com'])
  expect(derived.every((row) => workItemMemberIndexMigration.classify(row) === 'unrelated')).toBeTrue()
  expect(workItemMemberIndexMigration.classify({ directoryTeamId: 'ws#team#x', issueId: 'broken' })).toBe('unknown')
})
