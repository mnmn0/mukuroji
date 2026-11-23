import { expect, test } from 'bun:test'
import type { WorkItemContributorAssignment } from '@mukuroji/contracts'
import { AutomationError } from './automation-error'
import {
  createBulkReassignMemberPatch,
  createBulkReassignMemberUndoPayload,
  isBulkReassignMemberApplied,
  isBulkReassignMemberUndoApplied,
  listBulkReassignMemberRemovedShares,
} from './bulk-reassign-member'

const action = { fromMemberUserId: 'leaver@example.com', toMemberUserId: 'successor@example.com' }

/**
 * Builds a contributor assignment for the reassignment tests.
 *
 * @param assignmentId - Assignment ID.
 * @param fields - Fields that differ from a planned, effortless share.
 * @returns The assignment.
 */
function share(
  assignmentId: string,
  fields: Partial<WorkItemContributorAssignment> = {},
): WorkItemContributorAssignment {
  return { assignmentId, status: 'planned', ...fields }
}

test('moves the owner and leaves contributors alone when the member only owns the Work Item', () => {
  expect(createBulkReassignMemberPatch({
    assigneeUserId: 'Leaver@example.com',
    contributorAssignments: [share('a1', { memberUserId: 'other@example.com' })],
  }, action)).toEqual({ assigneeUserId: 'successor@example.com' })
})

test('moves unfinished contributor shares and keeps a finished share as the record', () => {
  expect(createBulkReassignMemberPatch({
    assigneeUserId: 'owner@example.com',
    contributorAssignments: [
      share('a1', { memberUserId: 'leaver@example.com', jobRoleId: 'design', plannedEffortMinutes: 120, status: 'in-progress' }),
      share('a2', { jobRoleId: 'qa' }),
    ],
  }, action)).toEqual({
    contributorAssignments: [
      share('a1', { memberUserId: 'successor@example.com', jobRoleId: 'design', plannedEffortMinutes: 120, status: 'in-progress' }),
      share('a2', { jobRoleId: 'qa' }),
    ],
  })

  expect(() => createBulkReassignMemberPatch({
    assigneeUserId: 'owner@example.com',
    contributorAssignments: [share('a1', { memberUserId: 'leaver@example.com', status: 'done' })],
  }, action)).toThrow(AutomationError)
})

test('merges a moved share into the successor share so nobody holds two shares', () => {
  expect(createBulkReassignMemberPatch({
    assigneeUserId: 'leaver@example.com',
    contributorAssignments: [
      share('a1', { memberUserId: 'leaver@example.com', plannedEffortMinutes: 59_990 }),
      share('a2', { memberUserId: 'successor@example.com', plannedEffortMinutes: 30, status: 'done' }),
    ],
  }, action)).toEqual({
    assigneeUserId: 'successor@example.com',
    contributorAssignments: [
      share('a2', { memberUserId: 'successor@example.com', plannedEffortMinutes: 60_000, status: 'in-progress' }),
    ],
  })
})

test('rejects a Work Item the member no longer owns or contributes to', () => {
  try {
    createBulkReassignMemberPatch({ assigneeUserId: 'owner@example.com' }, action)
    throw new Error('Expected a conflict.')
  } catch (error) {
    expect(error).toBeInstanceOf(AutomationError)
    expect(error).toMatchObject({ code: 'BulkReassignMemberNotInvolved' })
  }
})

test('tells when a handover has taken effect', () => {
  expect(isBulkReassignMemberApplied({
    assigneeUserId: 'successor@example.com',
    contributorAssignments: [share('a1', { memberUserId: 'leaver@example.com', status: 'done' })],
  }, action)).toBe(true)
  expect(isBulkReassignMemberApplied({
    assigneeUserId: 'successor@example.com',
    contributorAssignments: [share('a1', { memberUserId: 'leaver@example.com' })],
  }, action)).toBe(false)
})

test('restores a merged-away share and recognizes the undo by value', () => {
  const before = {
    assigneeUserId: 'owner@example.com',
    contributorAssignments: [
      share('a1', { memberUserId: 'leaver@example.com', plannedEffortMinutes: 60 }),
      share('a2', { memberUserId: 'successor@example.com', plannedEffortMinutes: 30 }),
    ],
  }
  const payload = createBulkReassignMemberUndoPayload(before)
  const afterMerge = { contributorAssignments: [share('a2', { memberUserId: 'successor@example.com', plannedEffortMinutes: 90 })] }
  expect(listBulkReassignMemberRemovedShares(before.contributorAssignments, afterMerge)).toEqual([
    share('a1', { memberUserId: 'leaver@example.com', plannedEffortMinutes: 60 }),
  ])
  const undone = {
    assigneeUserId: 'owner@example.com',
    contributorAssignments: [
      share('new', { memberUserId: 'leaver@example.com', plannedEffortMinutes: 60 }),
      share('a2', { memberUserId: 'successor@example.com', plannedEffortMinutes: 30 }),
    ],
  }
  expect(isBulkReassignMemberUndoApplied(undone, payload)).toBe(true)
  expect(isBulkReassignMemberUndoApplied({ ...undone, assigneeUserId: 'successor@example.com' }, payload)).toBe(false)
  expect(isBulkReassignMemberUndoApplied(before, payload)).toBe(true)
  expect(isBulkReassignMemberUndoApplied({ ...before, contributorAssignments: before.contributorAssignments.slice(1) }, payload))
    .toBe(false)
})
