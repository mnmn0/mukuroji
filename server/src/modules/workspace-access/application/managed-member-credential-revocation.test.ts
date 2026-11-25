import { expect, test } from 'bun:test'
import type { WorkspaceRole } from '../domain/workspace-role'
import type { WorkspaceMember } from '../workspace-access'
import {
  revokeManagedMemberCredentials,
  type ManagedMemberCredentialRevocationPorts,
} from './managed-member-credential-revocation'

/**
 * Creates fake ports holding one member and recording revocations.
 *
 * @param role - Workspace role of the stored member, or undefined for no member.
 * @returns The ports and the recorded revocations.
 */
function createPorts(role: WorkspaceRole | undefined) {
  const revocations: string[] = []
  const member: WorkspaceMember | undefined = role === undefined
    ? undefined
    : {
        id: 'sato@example.com',
        memberKey: 'sato@example.com',
        email: 'sato@example.com',
        role,
        status: 'deactivated',
        version: 2,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      }
  const ports: ManagedMemberCredentialRevocationPorts = {
    async getMember() {
      return member
    },
    async revokeMemberCredentials(_workspaceId, memberKey, actorId) {
      revocations.push(`${memberKey}:${actorId}`)
      return { revokedApiKeyIds: ['key-1'], revokedOAuthAppIds: [] }
    },
  }
  return { ports, revocations }
}

/**
 * Runs the use case as an administrator with the given role.
 *
 * @param ports - Fake ports.
 * @param actorRole - Workspace role of the administrator.
 * @returns The revoked credentials.
 */
function run(ports: ManagedMemberCredentialRevocationPorts, actorRole: WorkspaceRole) {
  return revokeManagedMemberCredentials(ports, {
    workspaceId: 'workspace-1',
    actorMemberKey: 'admin@example.com',
    actorRole,
    memberKey: 'sato@example.com',
  })
}

test('revokes the credentials of a member the administrator may manage', async () => {
  const { ports, revocations } = createPorts('member')

  expect(await run(ports, 'admin')).toEqual({ revokedApiKeyIds: ['key-1'], revokedOAuthAppIds: [] })
  expect(revocations).toEqual(['sato@example.com:admin@example.com'])
})

test('refuses an admin acting on another admin, and a missing member, without revoking', async () => {
  const admin = createPorts('admin')
  await expect(run(admin.ports, 'admin')).rejects.toMatchObject({ status: 403, code: 'WorkspaceRoleDenied' })
  expect(admin.revocations).toEqual([])

  const owner = createPorts('admin')
  await run(owner.ports, 'owner')
  expect(owner.revocations).toEqual(['sato@example.com:admin@example.com'])

  const missing = createPorts(undefined)
  await expect(run(missing.ports, 'owner')).rejects.toMatchObject({ status: 404, code: 'WorkspaceMemberNotFound' })
  expect(missing.revocations).toEqual([])
})
