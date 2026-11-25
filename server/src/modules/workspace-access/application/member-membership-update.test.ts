import { describe, expect, test } from 'bun:test'
import type { WorkspaceRole } from '../domain/workspace-role'
import type { WorkspaceMember, WorkspaceMemberStatus } from '../workspace-access'
import { updateMemberMembership, type MemberMembershipUpdatePorts } from './member-membership-update'

/**
 * Builds a stored member row.
 *
 * @param role - Workspace role of the member.
 * @param status - Membership status of the member.
 * @returns The member.
 */
function createMember(role: WorkspaceRole, status: WorkspaceMemberStatus): WorkspaceMember {
  return {
    id: 'sato@example.com',
    memberKey: 'sato@example.com',
    email: 'sato@example.com',
    role,
    status,
    version: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  }
}

/**
 * Creates fake ports that record the order of the update and the revocations.
 *
 * @param current - Member row before the change.
 * @param updated - Member row the update returns.
 * @returns The ports and the recorded calls.
 */
function createPorts(current: WorkspaceMember | undefined, updated: WorkspaceMember) {
  const calls: string[] = []
  const ports: MemberMembershipUpdatePorts = {
    async getMember() {
      return current
    },
    async updateMember() {
      calls.push('update')
      return updated
    },
    async revokeMemberCredentials(_workspaceId, memberKey, actorMemberKey) {
      calls.push(`revoke:${memberKey}:${actorMemberKey}`)
      return { revokedApiKeyIds: [], revokedOAuthAppIds: [] }
    },
  }
  return { ports, calls }
}

/**
 * Runs the use case for one requested status.
 *
 * @param ports - Fake ports.
 * @param actorRole - Workspace role of the administrator.
 * @param status - Requested status.
 * @returns The updated member.
 */
function run(ports: MemberMembershipUpdatePorts, actorRole: WorkspaceRole, status: WorkspaceMemberStatus) {
  return updateMemberMembership(ports, {
    workspaceId: 'workspace-1',
    actorMemberKey: 'owner@example.com',
    actorRole,
    memberKey: 'sato@example.com',
    update: { status, expectedVersion: 1, expectedPlanningRevision: 0 },
  })
}

describe('updateMemberMembership', () => {
  test('revokes credentials before a reactivation the actor may make', async () => {
    const { ports, calls } = createPorts(createMember('member', 'deactivated'), createMember('member', 'active'))

    await run(ports, 'admin', 'active')

    expect(calls).toEqual(['revoke:sato@example.com:owner@example.com', 'update'])
  })

  test('leaves credentials alone when the actor may not reactivate the member', async () => {
    const { ports, calls } = createPorts(createMember('admin', 'deactivated'), createMember('admin', 'active'))

    await run(ports, 'admin', 'active')

    expect(calls).toEqual(['update'])
  })

  test('does not revoke for an active member who stays active', async () => {
    const { ports, calls } = createPorts(createMember('member', 'active'), createMember('member', 'active'))

    await run(ports, 'owner', 'active')

    expect(calls).toEqual(['update'])
  })

  test('revokes credentials after a deactivation', async () => {
    const { ports, calls } = createPorts(createMember('member', 'active'), createMember('member', 'deactivated'))

    const member = await run(ports, 'owner', 'deactivated')

    expect(member.status).toBe('deactivated')
    expect(calls).toEqual(['update', 'revoke:sato@example.com:owner@example.com'])
  })

  test('does not revoke when the update is refused', async () => {
    const { ports, calls } = createPorts(createMember('member', 'active'), createMember('member', 'deactivated'))
    ports.updateMember = async () => {
      throw new Error('refused')
    }

    await expect(run(ports, 'owner', 'deactivated')).rejects.toThrow('refused')
    expect(calls).toEqual([])
  })

  test('finishes a failed revocation when the deactivation is repeated at a stale version', async () => {
    const { ports, calls } = createPorts(createMember('member', 'deactivated'), createMember('member', 'deactivated'))
    ports.updateMember = async () => {
      calls.push('update')
      throw new Error('version conflict')
    }

    await expect(run(ports, 'owner', 'deactivated')).rejects.toThrow('version conflict')
    expect(calls).toEqual(['revoke:sato@example.com:owner@example.com', 'update'])
  })

  test('does not revoke a deactivated member the actor may not manage', async () => {
    const { ports, calls } = createPorts(createMember('admin', 'deactivated'), createMember('admin', 'deactivated'))
    ports.updateMember = async () => {
      calls.push('update')
      throw new Error('refused')
    }

    await expect(run(ports, 'admin', 'deactivated')).rejects.toThrow('refused')
    expect(calls).toEqual(['update'])
  })
})
