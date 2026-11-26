import { expect, test } from 'bun:test'
import type { WorkItemRelation } from '@mukuroji/contracts'
import type { WorkspacePrincipal } from './project-access'
import { createRelationCoWrites } from './public-relation-access'

/** Workspace member who authorized the relation write. */
const principal: WorkspacePrincipal = {
  directoryId: 'workspace-1',
  userKey: 'member@example.com',
  actorId: 'member-1',
  isSystemAdmin: false,
  groups: [],
  principalKind: 'member',
  workspaceMember: {
    id: 'member-1',
    memberKey: 'member@example.com',
    email: 'member@example.com',
    role: 'member',
    status: 'active',
    version: 7,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
  workspaceRole: 'member',
  workspaceMemberStatus: 'active',
}

/** A stored relation. */
const relation: WorkItemRelation = { sourceWorkItemId: 'wi-1', targetWorkItemId: 'wi-2', type: 'blocks' }
/** The reciprocal row of the stored relation. */
const reciprocal: WorkItemRelation = { sourceWorkItemId: 'wi-2', targetWorkItemId: 'wi-1', type: 'blockedBy' }

test('binds a relation commit to the caller\'s member row as it was when authorized', async () => {
  const writes = await createRelationCoWrites(principal, 'team-1', 'wi-1', 201, undefined)(relation, reciprocal)
  expect(writes).toContainEqual(expect.objectContaining({
    ConditionCheck: expect.objectContaining({
      Key: { workspaceId: 'workspace-1', recordKey: 'MEMBER#member@example.com' },
      ExpressionAttributeValues: expect.objectContaining({ ':active': 'active', ':expectedVersion': 7 }),
    }),
  }))
})

test('checks no member row for a service account, which has none', async () => {
  const service = { ...principal, principalKind: 'service-account' as const }
  const writes = await createRelationCoWrites(service, 'team-1', 'wi-1', 200, undefined)(relation, reciprocal)
  expect(JSON.stringify(writes)).not.toContain('MEMBER#')
})
