import { expect, test } from 'bun:test'
import type { WorkspaceRole } from '../domain/workspace-role'
import { createMutationAuditContext } from '../../audit'
import type { MemberCredentialRevocationRecord, WorkspaceMember } from '../workspace-access'
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
    async listMemberCredentials() {
      return { revokedApiKeyIds: ['key-1'], revokedOAuthAppIds: [] }
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

test('records the set under the idempotency key and revokes only that set on a replay', async () => {
  const { ports } = createPorts('member')
  const receipts = new Map<string, MemberCredentialRevocationRecord>()
  const limits: unknown[] = []
  let listed = ['key-1']
  ports.listMemberCredentials = async () => ({ revokedApiKeyIds: listed, revokedOAuthAppIds: ['app-1'] })
  ports.revokeMemberCredentials = async (_workspaceId, _memberKey, _actorId, limitTo) => {
    limits.push(limitTo)
    return limitTo ?? { revokedApiKeyIds: [], revokedOAuthAppIds: [] }
  }
  ports.receipts = {
    async find(_workspaceId, _memberKey, auditContext) {
      return receipts.get(auditContext.idempotencyKeyHash)
    },
    async record(_workspaceId, _memberKey, credentials, auditContext) {
      receipts.set(auditContext.idempotencyKeyHash, credentials)
      return credentials
    },
  }
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'admin@example.com', kind: 'user' },
    idempotencyKey: 'revoke-1',
    request: { method: 'POST', path: '/api/workspace/members/sato%40example.com/credentials/revoke', body: {} },
    source: { kind: 'api' },
  })
  const revoke = () => revokeManagedMemberCredentials(ports, {
    workspaceId: 'workspace-1',
    actorMemberKey: 'admin@example.com',
    actorRole: 'owner',
    memberKey: 'sato@example.com',
    auditContext,
  })

  const first = await revoke()
  // The member created another key before the lost response was retried.
  listed = ['key-1', 'key-2']
  const replayed = await revoke()

  expect(first).toEqual({ revokedApiKeyIds: ['key-1'], revokedOAuthAppIds: ['app-1'] })
  expect(replayed).toEqual(first)
  expect(limits).toEqual([first, first])
})
