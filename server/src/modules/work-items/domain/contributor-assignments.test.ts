import { describe, expect, test } from 'bun:test'
import type { WorkItemContributorAssignment, WorkItemJobRoleDefinition } from '@mukuroji/contracts'
import {
  WorkItemContributorAssignmentError,
  isStoredContributorAssignmentList,
  listAddedContributorMembers,
  normalizeContributorAssignments,
} from './contributor-assignments'

const jobRoles: WorkItemJobRoleDefinition[] = [
  { id: 'designer', name: 'Designer' },
  { id: 'qa', name: 'QA' },
  { id: 'legacy-writer', name: 'Writer', archived: true },
]

const existing: WorkItemContributorAssignment[] = [
  {
    assignmentId: 'a'.repeat(32),
    memberUserId: 'alex@example.com',
    jobRoleId: 'legacy-writer',
    plannedEffortMinutes: 120,
    status: 'in-progress',
  },
]

/**
 * Creates a deterministic identifier factory.
 *
 * @returns A factory that yields 32-digit hexadecimal identifiers in sequence.
 */
function sequentialIds() {
  let next = 0
  return () => (next += 1).toString(16).padStart(32, '0')
}

/**
 * Normalizes a list with the shared test configuration.
 *
 * @param value - Untrusted contributor list.
 * @returns The normalized list.
 */
function normalize(value: unknown) {
  return normalizeContributorAssignments(value, { jobRoles, existing, createAssignmentId: sequentialIds() })
}

describe('normalizeContributorAssignments', () => {
  test('keeps existing assignments, assigns IDs to new ones, and normalizes members', () => {
    expect(normalize([
      { assignmentId: 'a'.repeat(32), memberUserId: 'alex@example.com', jobRoleId: 'legacy-writer', status: 'done' },
      { jobRoleId: 'designer', plannedEffortMinutes: 240 },
      { memberUserId: '  Sam@Example.com ', jobRoleId: 'qa', status: 'in-progress' },
    ])).toEqual([
      { assignmentId: 'a'.repeat(32), memberUserId: 'alex@example.com', jobRoleId: 'legacy-writer', status: 'done' },
      { assignmentId: '1'.padStart(32, '0'), jobRoleId: 'designer', plannedEffortMinutes: 240, status: 'planned' },
      { assignmentId: '2'.padStart(32, '0'), memberUserId: 'sam@example.com', jobRoleId: 'qa', status: 'in-progress' },
    ])
    expect(normalize([])).toEqual([])
  })

  test.each([
    ['not an array', { memberUserId: 'sam@example.com' }, 'must be an array'],
    ['an unknown field', [{ memberUserId: 'sam@example.com', role: 'Designer' }], 'Unsupported contributor assignment field: role'],
    ['neither member nor role', [{ plannedEffortMinutes: 60 }], 'needs a member, a job role, or both'],
    ['an invented assignment ID', [{ assignmentId: 'b'.repeat(32), jobRoleId: 'qa' }], 'does not match an existing assignment'],
    ['a repeated assignment ID', [
      { assignmentId: 'a'.repeat(32), jobRoleId: 'qa' },
      { assignmentId: 'a'.repeat(32), jobRoleId: 'designer' },
    ], 'can appear only once'],
    ['a repeated member', [
      { memberUserId: 'sam@example.com' },
      { memberUserId: 'SAM@example.com', jobRoleId: 'qa' },
    ], 'only once per Work Item'],
    ['an undefined job role', [{ jobRoleId: 'architect' }], 'is not defined'],
    ['a newly assigned archived job role', [{ jobRoleId: 'legacy-writer' }], 'is archived'],
    ['fractional effort', [{ jobRoleId: 'qa', plannedEffortMinutes: 1.5 }], 'whole minutes'],
    ['negative effort', [{ jobRoleId: 'qa', plannedEffortMinutes: -1 }], 'whole minutes'],
    ['excessive effort', [{ jobRoleId: 'qa', plannedEffortMinutes: 60_001 }], 'whole minutes'],
    ['an unknown status', [{ jobRoleId: 'qa', status: 'blocked' }], 'Contribution status'],
    ['too many assignments', Array.from({ length: 21 }, (_, index) => ({ memberUserId: `m${index}@example.com` })), 'at most 20'],
  ])('rejects %s', (_label, value, message) => {
    expect(() => normalize(value)).toThrow(WorkItemContributorAssignmentError)
    expect(() => normalize(value)).toThrow(message)
  })
})

describe('listAddedContributorMembers', () => {
  test('returns only members who were not contributors before', () => {
    const next = normalize([
      { assignmentId: 'a'.repeat(32), memberUserId: 'alex@example.com', jobRoleId: 'legacy-writer' },
      { memberUserId: 'sam@example.com' },
      { jobRoleId: 'qa' },
    ])
    expect(listAddedContributorMembers(next, existing)).toEqual(['sam@example.com'])
  })
})

describe('isStoredContributorAssignmentList', () => {
  test('accepts stored lists whose job roles are no longer configured', () => {
    expect(isStoredContributorAssignmentList([...existing, { assignmentId: 'c'.repeat(32), jobRoleId: 'removed', status: 'planned' }])).toBe(true)
  })

  test.each([
    ['a non-array', {}],
    ['a malformed ID', [{ assignmentId: 'short', jobRoleId: 'qa', status: 'planned' }]],
    ['an empty assignment', [{ assignmentId: 'c'.repeat(32), status: 'planned' }]],
    ['an invalid status', [{ assignmentId: 'c'.repeat(32), jobRoleId: 'qa', status: 'blocked' }]],
    ['invalid effort', [{ assignmentId: 'c'.repeat(32), jobRoleId: 'qa', status: 'planned', plannedEffortMinutes: '60' }]],
  ])('rejects %s', (_label, value) => {
    expect(isStoredContributorAssignmentList(value)).toBe(false)
  })
})
