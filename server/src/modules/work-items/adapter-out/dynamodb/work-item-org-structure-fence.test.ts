import { expect, test } from 'bun:test'
import { createAuthorizationSnapshotConditionChecks } from './work-item-client'

const snapshot = {
  workspaceId: 'workspace-1',
  memberKey: 'manager@example.com',
  workspaceMemberVersion: 2,
  planningRevision: 5,
}

/**
 * Finds the condition check on the OrgUnit structure row among a transaction's checks.
 *
 * @param checks - Transaction items.
 * @returns The structure check, when present.
 */
function findOrgStructureCheck(checks: ReturnType<typeof createAuthorizationSnapshotConditionChecks>) {
  return checks.find((item) => item.ConditionCheck?.Key?.entryKey === 'STRUCTURE')
}

test('fences a Work Item mutation on the OrgUnit structure revision that authorized it', () => {
  const check = findOrgStructureCheck(createAuthorizationSnapshotConditionChecks({
    ...snapshot,
    orgStructureRevision: 4,
  }))

  expect(check?.ConditionCheck?.Key).toEqual({
    directoryId: 'ORG_STRUCTURE#workspace-1',
    entryKey: 'STRUCTURE',
  })
  expect(Object.values(check?.ConditionCheck?.ExpressionAttributeValues ?? {})).toEqual(
    expect.arrayContaining([4, 'org-structure']),
  )
  expect(check?.ConditionCheck?.ConditionExpression).not.toContain('attribute_not_exists')
})

test('allows only a still-missing structure row when the decision read none', () => {
  const check = findOrgStructureCheck(createAuthorizationSnapshotConditionChecks({
    ...snapshot,
    orgStructureRevision: 0,
  }))

  expect(check?.ConditionCheck?.ConditionExpression).toContain('attribute_not_exists')
})

test('adds no structure fence when no OrgUnit scope authorized the mutation', () => {
  expect(findOrgStructureCheck(createAuthorizationSnapshotConditionChecks(snapshot))).toBeUndefined()
})
