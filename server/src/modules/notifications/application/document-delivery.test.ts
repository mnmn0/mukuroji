import { expect, test } from 'bun:test'
import { DocumentError, type GetDocumentRequest } from '../../documents'
import { isDocumentDeliveryVisible, resolveDocumentDeliveryAccess, type DocumentDeliveryAccessInput } from './document-delivery'

/** Creates current membership and directory state for document delivery checks. */
function input(): DocumentDeliveryAccessInput {
  return {
    workspaceId: 'workspace-1', memberKey: 'member@example.test', workspaceRole: 'member', isSystemAdmin: false,
    projects: [{ teamId: 'team-1', projectId: 'project-1' }], projectRoles: { 'project-1': 'viewer' },
    snapshot: {
      workspaceId: 'workspace-1', identityProviders: [], domains: [], customRoles: [], groupMappings: [],
      roleAssignments: [], scimUsers: [], scimGroups: [], scimCredentials: [], serviceAccounts: [],
      breakGlassAccounts: [], provisioningRuns: [], provisioningLogs: [],
    },
  }
}

test('retains legacy roles while binding the Documents read to the current recipient and workspace', async () => {
  const access = resolveDocumentDeliveryAccess(input())
  const reads: GetDocumentRequest[] = []
  expect(await isDocumentDeliveryVisible('workspace-1', 'private-document', access, async (request) => {
    reads.push(request)
  })).toBe(true)
  expect(reads).toEqual([{ workspaceId: 'workspace-1', documentId: 'private-document', access: {
    memberKey: 'member@example.test', workspaceRole: 'member', isSystemAdmin: false, projectRoles: { 'project-1': 'viewer' },
  } }])
})

test('denies missing source, private-document denial, deleted or archived source, and revoked grants without caching', async () => {
  const access = resolveDocumentDeliveryAccess(input())
  let reads = 0
  let status = 200
  /** Simulates the Documents capability after current ACL/ancestor evaluation. */
  async function read() {
    reads += 1
    if (status !== 200) throw new DocumentError(status, 'DocumentViewDenied', 'Denied')
  }
  expect(await isDocumentDeliveryVisible('workspace-1', undefined, access, read)).toBe(false)
  expect(reads).toBe(0)
  expect(await isDocumentDeliveryVisible('workspace-1', 'doc', access, read)).toBe(true)
  for (status of [403, 404]) {
    expect(await isDocumentDeliveryVisible('workspace-1', 'doc', access, read)).toBe(false)
  }
  expect(reads).toBe(3)
  status = 503
  await expect(isDocumentDeliveryVisible('workspace-1', 'doc', access, read)).rejects.toThrow('Denied')
})

test('uses document-specific Enterprise permissions instead of legacy roles or Work Item grants', () => {
  const state = input()
  state.snapshot.roleAssignments = [{
    workspaceId: state.workspaceId, assignmentId: 'assignment-1', principalKind: 'member', principalId: state.memberKey,
    roleId: 'custom:no-documents', scope: { workspaceId: state.workspaceId, kind: 'workspace' }, source: 'direct',
  }]
  state.snapshot.customRoles = [{
    workspaceId: state.workspaceId, roleId: 'custom:no-documents', name: 'Work Items only', description: '',
    permissions: ['work-items.read'], guestAssignable: false, revision: 1,
    createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
  }]
  const denied = resolveDocumentDeliveryAccess(state)
  expect(denied?.restrictToAuthorizedScopes).toBe(true)
  expect(denied?.projectRoles).toEqual({})
  expect(denied?.workspaceScopeRole).toBeUndefined()
  state.snapshot.customRoles[0]!.permissions = ['documents.read']
  expect(resolveDocumentDeliveryAccess(state)?.workspaceScopeRole).toBe('viewer')
  expect(resolveDocumentDeliveryAccess(state)?.projectRoles).toEqual({ 'project-1': 'viewer' })
  state.snapshot.scimUsers = [{
    workspaceId: state.workspaceId, identityProviderId: 'provider-1', userId: 'user-1', externalId: 'external-1',
    userName: state.memberKey, displayName: 'Member', emails: [state.memberKey], linkedMemberKey: state.memberKey,
    active: false, groupIds: [], version: 1, appliedVersion: 1,
    createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
  }]
  expect(resolveDocumentDeliveryAccess(state)).toBeUndefined()
  state.snapshot.scimUsers = []
  state.snapshot.workspaceId = 'other-workspace'
  expect(resolveDocumentDeliveryAccess(state)).toBeUndefined()
})
