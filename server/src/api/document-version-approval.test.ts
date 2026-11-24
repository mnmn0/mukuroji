import { afterEach, expect, test } from 'bun:test'
import type {
  ApprovalRequest,
  DocumentDetail,
  DocumentVersion,
  EnterprisePermissionId,
  EnterpriseRoleAssignment,
} from '@mukuroji/contracts'
import { InMemoryEnterpriseIdentityClient } from '../modules/enterprise-identity/enterprise-identity'
import { createApiTestHarness } from './test-support/api-test-harness'
import type { CreateDocumentVersionApprovalInput, FileProofingScope } from '../modules/files/file-proofing'

const {
  app,
  configureFakeProjectClients,
  createDocumentFake,
  createFileProofingStub,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const document: DocumentDetail = {
  schemaVersion: 1,
  id: 'document-1',
  kind: 'page',
  scope: { type: 'workspace' },
  title: 'Design spec',
  position: 'a0',
  revision: 3,
  permission: { mode: 'inherit', memberGrants: [] },
  relations: [],
  favorite: false,
  capabilities: {
    canView: true,
    canEdit: true,
    canComment: true,
    canShare: false,
    canManagePermissions: false,
    canArchive: false,
    canRestore: false,
    canExport: true,
  },
  createdByUserId: 'demo@example.com',
  updatedByUserId: 'demo@example.com',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  blocks: [],
}

const pinnedVersion: DocumentVersion = {
  schemaVersion: 1,
  id: 'document-1:2',
  documentId: 'document-1',
  revision: 2,
  kind: 'page',
  title: 'Design spec',
  reason: 'edit',
  createdByUserId: 'demo@example.com',
  createdAt: '2026-11-01T00:00:00.000Z',
  name: 'v1.0',
}

/**
 * Builds a Document version approval on the fake Work Item.
 *
 * @param issueId - Work Item the approval belongs to.
 * @param teamId - Team of the Work Item.
 * @returns The approval request.
 */
function createDocumentApproval(issueId: string, teamId = 'core-team'): ApprovalRequest {
  return {
    id: `approval-${issueId}`,
    subjectType: 'document-version',
    documentId: 'document-1',
    versionId: 'document-1:2',
    teamId,
    issueId,
    revision: 1,
    status: 'pending',
    reviewers: [{ memberKey: 'sato@example.com', status: 'pending' }],
    dueAt: '2099-07-20T00:00:00.000Z',
    requestedByMemberKey: 'demo@example.com',
    requestedByKind: 'member',
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    capabilities: { canDecide: false, canCancel: true },
  }
}

test('requests approval of a pinned Document version on the deliverable Work Item', async () => {
  configureFakeProjectClients(true, { role: 'member', guestWorkspaceMemberKeys: ['guest@example.com'] })
  const created: Array<{ scope: FileProofingScope; input: CreateDocumentVersionApprovalInput }> = []
  setTestAppDependencies({
    documents: createDocumentFake({
      async get() {
        return document
      },
      async getVersion() {
        return { version: pinnedVersion, document }
      },
    }),
    fileProofing: createFileProofingStub({
      async createDocumentVersionApproval(scope, _actor, input) {
        created.push({ scope, input })
        return createDocumentApproval(scope.issueId ?? '')
      },
    }),
  })
  const request = (reviewerMemberKeys: string[]) => app.request('/api/documents/document-1/versions/2/approvals', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teamId: 'core-team',
      issueId: 'issue-1',
      reviewerMemberKeys,
      dueAt: '2099-07-20T00:00:00.000Z',
    }),
  })

  const guest = await request(['guest@example.com'])
  expect(guest.status).toBe(409)
  expect(await guest.json()).toMatchObject({ code: 'ApprovalGuestDocumentAccessDenied' })
  expect(created).toEqual([])

  const response = await request([' Sato@Example.com '])
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({
    approval: { subjectType: 'document-version', documentId: 'document-1', versionId: 'document-1:2' },
  })
  expect(created).toEqual([{
    scope: expect.objectContaining({ kind: 'work-item', teamId: 'core-team', issueId: 'issue-1' }),
    input: {
      documentId: 'document-1',
      versionId: 'document-1:2',
      reviewerMemberKeys: ['sato@example.com'],
      dueAt: '2099-07-20T00:00:00.000Z',
    },
  }])
})

test('rejects a Document version approval without Work Item write access', async () => {
  configureFakeProjectClients(true, { role: 'viewer' })
  let createCalls = 0
  setTestAppDependencies({
    documents: createDocumentFake({
      async get() {
        return document
      },
      async getVersion() {
        return { version: pinnedVersion, document }
      },
    }),
    fileProofing: createFileProofingStub({
      async createDocumentVersionApproval() {
        createCalls += 1
        return createDocumentApproval('issue-1')
      },
    }),
  })

  const response = await app.request('/api/documents/document-1/versions/2/approvals', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teamId: 'core-team',
      issueId: 'issue-1',
      reviewerMemberKeys: ['sato@example.com'],
      dueAt: '2099-07-20T00:00:00.000Z',
    }),
  })

  expect(response.status).toBe(403)
  expect(createCalls).toBe(0)
})

test('lists Document version approvals only for Work Items the viewer can read', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  setTestAppDependencies({
    documents: createDocumentFake({
      async get() {
        return document
      },
    }),
    fileProofing: createFileProofingStub({
      async listDocumentApprovals(_workspaceId, documentId) {
        expect(documentId).toBe('document-1')
        return [createDocumentApproval('issue-1'), createDocumentApproval('issue-2', 'hidden-team')]
      },
    }),
  })

  const response = await app.request('/api/documents/document-1/approvals', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.approvals.map((approval: ApprovalRequest) => approval.issueId)).toEqual(['issue-1'])
})

/**
 * Creates an Enterprise identity that grants the test member one custom role per Project.
 *
 * @param grants - Permissions and the Project each role is assigned at.
 * @returns Enterprise Identity fake with only those Project-scoped assignments.
 */
async function createProjectRoleIdentity(
  grants: ReadonlyArray<{ roleId: `custom:${string}`; permissions: EnterprisePermissionId[]; projectId: string }>,
) {
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = '2026-11-01T00:00:00.000Z'
  for (const grant of grants) {
    await identity.putCustomRole({
      workspaceId: 'workspace-documents',
      roleId: grant.roleId,
      name: grant.roleId,
      permissions: grant.permissions,
      guestAssignable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
  }
  return new Proxy(identity, {
    get(target, property) {
      if (property === 'getSnapshot') {
        return async (workspaceId: string) => ({
          ...await target.getSnapshot(workspaceId),
          roleAssignments: grants.map((grant): EnterpriseRoleAssignment => ({
            workspaceId,
            assignmentId: `${grant.roleId}-assignment`,
            principalKind: 'member',
            principalId: 'demo@example.com',
            roleId: grant.roleId,
            scope: { workspaceId, kind: 'project', targetId: grant.projectId },
            source: 'direct',
          })),
        })
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('authorizes the Work Item in another Project than the Document access', async () => {
  // Document access comes from the Docs Project; Work Item and approval access from Refero.
  configureFakeProjectClients(false, {
    directoryId: 'workspace-documents',
    workspaceRole: 'admin',
    projectAccesses: [],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'docs', name: 'Docs', tone: 'green' },
    ],
  })
  const created: string[] = []
  setTestAppDependencies({
    enterpriseIdentity: await createProjectRoleIdentity([
      { roleId: 'custom:docs-editor', permissions: ['documents.read', 'documents.write'], projectId: 'docs' },
      {
        roleId: 'custom:work-item-approver',
        permissions: ['work-items.read', 'work-items.write', 'files.read', 'files.write', 'files.approve'],
        projectId: 'refero',
      },
    ]),
    documents: createDocumentFake({
      async get() {
        return document
      },
      async getVersion() {
        return { version: pinnedVersion, document }
      },
    }),
    fileProofing: createFileProofingStub({
      async createDocumentVersionApproval(scope) {
        created.push(scope.issueId ?? '')
        return createDocumentApproval(scope.issueId ?? '')
      },
      async listDocumentApprovals() {
        return [createDocumentApproval('onboarding-friction')]
      },
    }),
  })

  const requested = await app.request('/api/documents/document-1/versions/2/approvals', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teamId: 'core-team',
      issueId: 'onboarding-friction',
      reviewerMemberKeys: ['demo@example.com'],
      dueAt: '2099-07-20T00:00:00.000Z',
    }),
  })
  const listed = await app.request('/api/documents/document-1/approvals', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(requested.status).toBe(201)
  expect(created).toEqual(['onboarding-friction'])
  expect(listed.status).toBe(200)
  expect((await listed.json()).approvals.map((approval: ApprovalRequest) => approval.issueId))
    .toEqual(['onboarding-friction'])
})
