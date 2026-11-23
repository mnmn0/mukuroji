import { expect, test } from 'bun:test'
import type { WorkItemContributorAssignment } from '@mukuroji/contracts'
import { createBulkReassignMemberPatch } from './automation-routes'
import { AutomationError } from '../../modules/automation'

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
