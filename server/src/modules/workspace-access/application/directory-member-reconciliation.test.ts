import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../audit'
import type { WorkspaceMember, WorkspaceMemberStatus } from '../workspace-access'
import {
  reconcileDirectoryMemberAccess,
  type DirectoryMemberReconciliationPorts,
} from './directory-member-reconciliation'

/**
 * Builds a directory-managed member row.
 *
 * @param status - Membership status of the member.
 * @returns The member.
 */
function createMember(status: WorkspaceMemberStatus): WorkspaceMember {
  return {
    id: 'sato@example.com',
    memberKey: 'sato@example.com',
    email: 'sato@example.com',
    role: 'member',
    status,
    provisioningSource: 'directory',
    externalIdentityId: 'scim-user-1',
    version: 3,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  }
}

/**
 * Creates fake ports that record the order of revocations and reconciliations.
 *
 * @returns The ports and the recorded calls.
 */
function createPorts() {
  const calls: string[] = []
  const ports: DirectoryMemberReconciliationPorts = {
    async reconcileDirectoryMember() {
      calls.push('reconcile')
      return createMember('active')
    },
    async revokeMemberCredentials(_workspaceId, memberKey, actorId) {
      calls.push(`revoke:${memberKey}:${actorId}`)
      return { revokedApiKeyIds: [], revokedOAuthAppIds: [] }
    },
  }
  return { ports, calls }
}

/**
 * Reconciles the member from the given prior state.
 *
 * @param ports - Fake ports.
 * @param existing - Member before the reconciliation.
 * @returns The reconciled member.
 */
function run(ports: DirectoryMemberReconciliationPorts, existing: WorkspaceMember | undefined) {
  return reconcileDirectoryMemberAccess(ports, {
    workspaceId: 'workspace-1',
    existing,
    member: {
      memberKey: 'sato@example.com',
      email: 'sato@example.com',
      role: 'member',
      externalIdentityId: 'scim-user-1',
      expectedPlanningRevision: 0,
    },
    auditContext: createMutationAuditContext({
      workspaceId: 'workspace-1',
      actor: { id: 'scim-directory:idp-1', kind: 'service' },
      idempotencyKey: 'scim-reconcile',
      request: { method: 'PATCH', path: '/api/scim/v2/workspace-1/Users/scim-user-1' },
      source: { kind: 'system' },
    }),
  })
}

test('revokes old credentials before the directory reactivates a deactivated member (ADR 0095)', async () => {
  const { ports, calls } = createPorts()

  await run(ports, createMember('deactivated'))

  expect(calls).toEqual(['revoke:sato@example.com:scim-directory:idp-1', 'reconcile'])
})

test('reconciles an active or new member without revoking', async () => {
  const active = createPorts()
  await run(active.ports, createMember('active'))
  expect(active.calls).toEqual(['reconcile'])

  const created = createPorts()
  await run(created.ports, undefined)
  expect(created.calls).toEqual(['reconcile'])
})

test('does not reactivate when the revocation fails, so a retry finishes both', async () => {
  const { ports, calls } = createPorts()
  ports.revokeMemberCredentials = async () => {
    throw new Error('revocation unavailable')
  }

  await expect(run(ports, createMember('deactivated'))).rejects.toThrow('revocation unavailable')
  expect(calls).toEqual([])
})
