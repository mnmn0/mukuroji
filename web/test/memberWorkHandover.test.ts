import { expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import {
  MEMBER_WORK_HANDOVER_BATCH_LIMIT,
  createMemberWorkHandoverRequest,
  listMemberWorkHandoverItems,
} from '../src/workspace/model/memberWorkHandover'

/**
 * Builds the Work Item fields the handover reads.
 *
 * @param id - Work Item ID.
 * @param fields - Owner and contributors.
 * @returns A Work Item for the handover model.
 */
function workItem(
  id: string,
  fields: Pick<CanonicalWorkItem, 'assigneeUserId'> & Partial<Pick<CanonicalWorkItem, 'contributorAssignments'>>,
): CanonicalWorkItem {
  return {
    createdAt: '2026-07-01T00:00:00.000Z',
    creatorMemberKey: 'creator@example.com',
    customFieldValues: {},
    dueDate: '2026/07/31',
    id,
    key: `CORE-${id}`,
    priority: 'medium',
    relationIds: [],
    revision: 3,
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    source: 'dynamodb',
    statusCategory: 'started',
    teamId: 'core',
    title: `Item ${id}`,
    updatedAt: '2026-07-01T00:00:00.000Z',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'active',
    ...fields,
  }
}

test('lists owned Work Items and unfinished contributor shares, not finished ones', () => {
  const items = listMemberWorkHandoverItems([
    workItem('1', { assigneeUserId: 'Leaver@example.com' }),
    workItem('2', {
      assigneeUserId: 'other@example.com',
      contributorAssignments: [{ assignmentId: 'a', memberUserId: 'leaver@example.com', status: 'in-progress' }],
    }),
    workItem('3', {
      assigneeUserId: 'other@example.com',
      contributorAssignments: [{ assignmentId: 'b', memberUserId: 'leaver@example.com', status: 'done' }],
    }),
  ], 'leaver@example.com')

  expect(items).toEqual([
    { teamId: 'core', workItemId: '1', key: 'CORE-1', title: 'Item 1', revision: 3, owner: true, contributor: false },
    { teamId: 'core', workItemId: '2', key: 'CORE-2', title: 'Item 2', revision: 3, owner: false, contributor: true },
  ])
})

test('builds a reassignment request that stays within one bulk operation', () => {
  const items = Array.from({ length: MEMBER_WORK_HANDOVER_BATCH_LIMIT + 5 }, (_, index) => ({
    teamId: 'core',
    workItemId: String(index),
    title: 'Item',
    revision: index + 1,
    owner: true,
    contributor: false,
  }))
  const request = createMemberWorkHandoverRequest('workspace-1', items, 'Leaver@example.com', ' Successor@example.com ')

  expect(request.items).toHaveLength(MEMBER_WORK_HANDOVER_BATCH_LIMIT)
  expect(request.items[0]).toEqual({ teamId: 'core', workItemId: '0', expectedRevision: 1 })
  expect(request.action).toEqual({
    type: 'reassign-member',
    fromMemberUserId: 'leaver@example.com',
    toMemberUserId: 'successor@example.com',
  })
})
