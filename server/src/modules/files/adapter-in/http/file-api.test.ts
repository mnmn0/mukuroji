import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createApprovalRequestFixture,
  createCollaborationStub,
  createFakeWorkItemConfigurationClient,
  createFileProofingStub,
  createFileUploadSessionFixture,
  createTestWorkItemConfiguration,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import type { EnterpriseCustomRole } from '@mukuroji/contracts'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import {
  DynamoDbTeamIssuesClient,
} from '../../../work-items'
import type {
  WorkspaceSearchClient,
} from '../../../workspace-search/workspace-search'
import {
  createWorkspaceSearchDocument,
} from '../../../workspace-search/workspace-search'
import {
  FileProofingError,
} from '../../file-proofing'
import type {
  FileProofingActor,
} from '../../file-proofing'
import type {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import type {
  DynamoDBDocumentClient,
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

test('authorizes Work Item file list reads and returns server capabilities', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  const reads: Array<{ actor: string; issueId?: string; teamId: string }> = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async list(scope, actor) {
        reads.push({ actor: actor.memberKey, issueId: scope.issueId, teamId: scope.teamId })
        return {
          files: [],
          approvals: [],
          capabilities: {
            canUpload: actor.canWrite,
            canRequestApproval: actor.canWrite,
            canGrantGuestAccess: actor.canManage,
          },
        }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/issue-1/files', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    files: [],
    approvals: [],
    capabilities: {
      canUpload: true,
      canRequestApproval: true,
      canGrantGuestAccess: true,
    },
  })
  expect(reads).toEqual([{
    actor: 'demo@example.com',
    issueId: 'issue-1',
    teamId: 'core-team',
  }])
})

test('creates a direct object upload session without accepting file bytes in the API body', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  const creates: Array<{ contentType: string; fileName: string; sizeBytes: number }> = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async createUpload(_scope, _actor, input) {
        creates.push(input)
        return createFileUploadSessionFixture()
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/issue-1/files/uploads', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'upload-session-1',
    },
    body: JSON.stringify({
      contentType: 'application/pdf',
      fileName: 'proof.pdf',
      sizeBytes: 4096,
    }),
  })

  expect(response.status).toBe(201)
  const body = await response.json() as ReturnType<typeof createFileUploadSessionFixture>
  expect(body.upload).toMatchObject({ method: 'PUT', maxSizeBytes: 2_147_483_648 })
  expect(body.upload.url).toBe('https://objects.example.test/upload')
  expect(creates).toEqual([{
    contentType: 'application/pdf',
    fileName: 'proof.pdf',
    sizeBytes: 4096,
  }])
})

test('tells the client why a file type was refused and which types it may attach', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async createUpload() {
        throw new FileProofingError(415, 'FileTypeNotAllowed', 'This file type cannot be attached.', {
          fileTypeRejection: { reason: 'dangerous', allowedFileTypes: ['pdf', 'markdown'] },
        })
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/issue-1/files/uploads', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'upload-session-exe',
    },
    body: JSON.stringify({ contentType: 'application/x-msdownload', fileName: 'setup.exe', sizeBytes: 4096 }),
  })

  expect(response.status).toBe(415)
  expect(await response.json()).toEqual({
    code: 'FileTypeNotAllowed',
    message: 'This file type cannot be attached.',
    reason: 'dangerous',
    allowedFileTypes: ['pdf', 'markdown'],
  })
})

test('does not issue file access URLs without authentication or a clean scan', async () => {
  configureFakeProjectClients(true, { role: 'viewer' })
  let accessCalls = 0
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async createAccess() {
        accessCalls += 1
        throw new FileProofingError(423, 'FileScanPending', 'File scanning is still in progress.')
      },
    }),
  })

  const unauthenticated = await app.request(
    '/api/teams/core-team/issues/issue-1/files/file-1/versions/version-1/access',
  )
  expect(unauthenticated.status).toBe(401)
  expect(accessCalls).toBe(0)

  const pending = await app.request(
    '/api/teams/core-team/issues/issue-1/files/file-1/versions/version-1/access?disposition=inline',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(pending.status).toBe(423)
  expect(await pending.json()).toEqual({
    code: 'FileScanPending',
    message: 'File scanning is still in progress.',
  })
  expect(accessCalls).toBe(1)
})

test('keeps guest file uploads and management read-only at the API authorization boundary', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'guest' })
  const actors: FileProofingActor[] = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async createUpload(_scope, actor) {
        actors.push(actor)
        throw new FileProofingError(403, 'FileWriteDenied', 'File write access is required.')
      },
    }),
  })

  const responses = await Promise.all([
    '/api/teams/core-team/issues/issue-1/files/uploads',
    '/api/teams/core-team/projects/refero/files/uploads',
  ].map((path) => app.request(path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ contentType: 'image/png', fileName: 'guest.png', sizeBytes: 10 }),
  })))

  for (const response of responses) {
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'FileWriteDenied' })
  }
  expect(actors).toHaveLength(2)
  for (const actor of actors) {
    expect(actor).toMatchObject({ guest: true, canManage: false, canWrite: false })
  }
})

test('keeps a downgraded guest uploader from deleting files through the API', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'guest' })
  let receivedActor: FileProofingActor | undefined
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async deleteFile(_scope, actor) {
        receivedActor = actor
        throw new FileProofingError(
          403,
          'FileDeleteDenied',
          'File manager or uploader access is required.',
        )
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/issue-1/files/file-created-before-downgrade',
    {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token' },
    },
  )

  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'FileDeleteDenied' })
  expect(receivedActor).toMatchObject({ guest: true, canManage: false, canWrite: false })
})

test('rejects a read-only approval requester before reviewer or file fan-out', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'guest' })
  let fileListCalls = 0
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async list() {
        fileListCalls += 1
        throw new Error('File list must not be called for a read-only requester.')
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/issue-1/approvals', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dueAt: '2099-07-20T00:00:00.000Z',
      fileId: 'file-1',
      reviewerMemberKeys: ['reviewer@example.com'],
      versionId: 'version-1',
    }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'FileWriteDenied' })
  expect(fileListCalls).toBe(0)
})

test('returns 400 for malformed file JSON before calling the domain client', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  let createCalls = 0
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async createUpload() {
        createCalls += 1
        return createFileUploadSessionFixture()
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/issue-1/files/uploads', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: '{',
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'InvalidFileProofingInput' })
  expect(createCalls).toBe(0)
})

test('rejects excessive approval reviewers before external member fan-out', async () => {
  configureFakeProjectClients(true, { role: 'member' })

  const response = await app.request('/api/teams/core-team/issues/issue-1/approvals', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dueAt: '2099-07-20T00:00:00.000Z',
      fileId: 'file-1',
      reviewerMemberKeys: Array.from({ length: 21 }, (_, index) => `reviewer-${index}@example.com`),
      versionId: 'version-1',
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'InvalidApprovalReviewers' })
})

test('validates and stores an approval completion target from the current workflow', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  // Requesting an approval does not complete the Work Item, so open children do not block it.
  const configuration = {
    ...createTestWorkItemConfiguration('team', 'core-team'),
    parentCompletionPolicy: 'reject' as const,
  }
  let childReads = 0
  configuration.workflow.statuses.push({
    id: 'approval-complete',
    name: 'Approval complete',
    category: 'completed',
    sortOrder: 50,
  })
  configuration.workflow.transitions.push({
    fromStatusId: 'in-progress',
    toStatusId: 'approval-complete',
  })
  const receivedTransitions: Array<string | undefined> = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async list() {
        const upload = createFileUploadSessionFixture()
        return {
          files: [upload.file],
          approvals: [],
          capabilities: {
            canUpload: true,
            canRequestApproval: true,
            canGrantGuestAccess: true,
          },
        }
      },
      async createApproval(_scope, _actor, input) {
        receivedTransitions.push(input.completionTransition)
        return createApprovalRequestFixture()
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
      async listRelations(_workspaceId, _teamId, workItemId) {
        childReads += 1
        return {
          relations: [{ sourceWorkItemId: workItemId, targetWorkItemId: 'open-child', type: 'child' }],
          graphRevision: 2,
        }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/issue-1/approvals', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dueAt: '2099-07-20T00:00:00.000Z',
      fileId: 'file-1',
      reviewerMemberKeys: ['sato@example.com'],
      versionId: 'version-1',
      completionTransition: 'approval-complete',
    }),
  })

  expect(response.status).toBe(201)
  expect(receivedTransitions).toEqual(['approval-complete'])
  expect(childReads).toBe(0)
})

test('resolves approval completion with workflow metadata and configuration guards', async () => {
  const calls = configureFakeProjectClients(true, {
    role: 'member',
    detailWorkflowStatusIds: ['in-progress', 'approval-complete'],
    detailUpdatedAts: [
      '2026-06-08T00:00:00.000Z',
      '2026-07-12T02:34:56.000Z',
    ],
  })
  const configuration = createTestWorkItemConfiguration('team', 'core-team', 4)
  configuration.workflow.statuses.push({
    id: 'approval-complete',
    name: 'Approval complete',
    category: 'completed',
    sortOrder: 50,
  })
  configuration.workflow.transitions.push({
    fromStatusId: 'in-progress',
    toStatusId: 'approval-complete',
  })
  const resolvedTransitions: unknown[] = []
  const projectedDocuments: Array<Parameters<WorkspaceSearchClient['upsertDocument']>[0]> = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async decideApproval(_scope, _actor, _approvalId, _input, _auditContext, resolver) {
        resolvedTransitions.push(await resolver?.('approval-complete'))
        return createApprovalRequestFixture({
          status: 'approved',
          updatedAt: '2026-07-12T01:23:45.000Z',
        })
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
    workspaceSearch: {
      async upsertDocument(
        document: Parameters<WorkspaceSearchClient['upsertDocument']>[0],
      ) {
        projectedDocuments.push(document)
        return createWorkspaceSearchDocument(document)
      },
    } as unknown as WorkspaceSearchClient,
  })

  const response = await app.request(
    '/api/teams/core-team/issues/issue-1/approvals/approval-1/decisions',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve', expectedRevision: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(resolvedTransitions).toHaveLength(1)
  expect(resolvedTransitions[0]).toMatchObject({
    workflowStatusId: 'approval-complete',
    statusCategory: 'completed',
    workflowSchemaVersion: 1,
    expectedRevision: 1,
  })
  expect(
    (resolvedTransitions[0] as {
      configurationConditionChecks: TransactWriteCommandInput['TransactItems']
    }).configurationConditionChecks,
  ).toEqual(expect.arrayContaining([
    expect.objectContaining({ ConditionCheck: expect.any(Object) }),
  ]))
  expect(projectedDocuments).toHaveLength(1)
  expect(projectedDocuments[0]).toMatchObject({
    entityType: 'work-item',
    entityId: 'team/core-team/issue/issue-1',
    status: 'approval-complete',
    updatedAt: '2026-07-12T02:34:56.000Z',
  })
  expect(calls.issueDetails).toHaveLength(2)
  expect(calls.issueDetails[1]?.readOptions).toMatchObject({
    consistentIssueRead: true,
    includeEvents: false,
  })
})

test('rejects an approval that would complete a parent with an open child when the Team rejects it', async () => {
  configureFakeProjectClients(true, {
    role: 'member',
    detailWorkflowStatusIds: ['in-progress'],
  })
  const configuration = {
    ...createTestWorkItemConfiguration('team', 'core-team', 4),
    parentCompletionPolicy: 'reject' as const,
  }
  configuration.workflow.statuses.push({
    id: 'approval-complete',
    name: 'Approval complete',
    category: 'completed',
    sortOrder: 50,
  })
  configuration.workflow.transitions.push({
    fromStatusId: 'in-progress',
    toStatusId: 'approval-complete',
  })
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async decideApproval(_scope, _actor, _approvalId, _input, _auditContext, resolver) {
        await resolver?.('approval-complete')
        return createApprovalRequestFixture({ status: 'approved' })
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
      async listRelations(_workspaceId, _teamId, workItemId) {
        return {
          relations: [{ sourceWorkItemId: workItemId, targetWorkItemId: 'open-child', type: 'child' }],
          graphRevision: 2,
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/issue-1/approvals/approval-1/decisions',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve', expectedRevision: 1 }),
    },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'WorkItemOpenChildren' })
})

test('does not project a Work Item when an approval decision has no completion transition', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  let projectionWrites = 0
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async decideApproval() {
        return createApprovalRequestFixture({ status: 'rejected' })
      },
    }),
    workspaceSearch: {
      async upsertDocument(
        document: Parameters<WorkspaceSearchClient['upsertDocument']>[0],
      ) {
        projectionWrites += 1
        return createWorkspaceSearchDocument(document)
      },
    } as unknown as WorkspaceSearchClient,
  })

  const response = await app.request(
    '/api/teams/core-team/issues/issue-1/approvals/approval-1/decisions',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'reject', expectedRevision: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(projectionWrites).toBe(0)
})

test('keeps an approval completion successful when Work Item search projection fails', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  const configuration = createTestWorkItemConfiguration('team', 'core-team')
  configuration.workflow.statuses.push({
    id: 'approval-complete',
    name: 'Approval complete',
    category: 'completed',
    sortOrder: 50,
  })
  configuration.workflow.transitions.push({
    fromStatusId: 'in-progress',
    toStatusId: 'approval-complete',
  })
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async decideApproval(_scope, _actor, _approvalId, _input, _auditContext, resolver) {
        await resolver?.('approval-complete')
        return createApprovalRequestFixture({ status: 'approved' })
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
    workspaceSearch: {
      async upsertDocument() {
        throw new Error('Search index unavailable')
      },
    } as unknown as WorkspaceSearchClient,
  })
  const originalConsoleError = console.error
  let projectionErrors = 0
  console.error = () => {
    projectionErrors += 1
  }
  try {
    const response = await app.request(
      '/api/teams/core-team/issues/issue-1/approvals/approval-1/decisions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approve', expectedRevision: 1 }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ approval: { status: 'approved' } })
    expect(projectionErrors).toBe(1)
  } finally {
    console.error = originalConsoleError
  }
})

test('classifies a removed approval completion target as a decision conflict', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  const configuration = createTestWorkItemConfiguration('team', 'core-team', 5)
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async decideApproval(_scope, _actor, _approvalId, _input, _auditContext, resolver) {
        const resolved = await resolver?.('removed-after-request')
        if (!resolved) {
          throw new FileProofingError(
            409,
            'ApprovalCompletionTransitionConflict',
            'Approval completion workflow transition is no longer available.',
          )
        }
        return createApprovalRequestFixture({ status: 'approved' })
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/issue-1/approvals/approval-1/decisions',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve', expectedRevision: 1 }),
    },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    code: 'ApprovalCompletionTransitionConflict',
  })
})

test('cancels a pending approval through the authenticated Work Item scope', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  let receivedRevision: number | undefined
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async cancelApproval(_scope, _actor, _approvalId, input) {
        receivedRevision = input.expectedRevision
        return {
          id: 'approval-1',
          teamId: 'core-team',
          issueId: 'issue-1',
          subjectType: 'file-version',
          revision: input.expectedRevision + 1,
          fileId: 'file-1',
          versionId: 'version-1',
          status: 'cancelled',
          reviewers: [{ memberKey: 'reviewer@example.com', status: 'pending' }],
          dueAt: '2099-07-20T00:00:00.000Z',
          requestedByMemberKey: 'demo@example.com',
          requestedByKind: 'member',
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T01:00:00.000Z',
          completedAt: '2026-07-12T01:00:00.000Z',
          capabilities: { canCancel: false, canDecide: false },
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/issue-1/approvals/approval-1/cancel',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedRevision: 3 }),
    },
  )

  expect(response.status).toBe(200)
  expect(receivedRevision).toBe(3)
  expect(await response.json()).toMatchObject({
    approval: { id: 'approval-1', revision: 4, status: 'cancelled' },
  })
})

test('rejects a comment attachment when the saved comment does not exist', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  let uploadCalls = 0
  const attachmentChecks: Array<{ entityKey: string; commentId: string }> = []
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async hasAttachableComment(entityKey, commentId) {
        attachmentChecks.push({ entityKey, commentId })
        return false
      },
    }),
    fileProofing: createFileProofingStub({
      async createUpload() {
        uploadCalls += 1
        return createFileUploadSessionFixture()
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/issue-1/comments/missing-comment/files/uploads',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contentType: 'application/pdf', fileName: 'proof.pdf', sizeBytes: 10 }),
    },
  )

  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ code: 'CommentNotFound' })
  expect(uploadCalls).toBe(0)
  expect(attachmentChecks).toEqual([{
    entityKey: 'user#demo@example.com#work-item#team/core-team/issue/issue-1',
    commentId: 'missing-comment',
  }])
})

test('filters reviewer Inbox approvals after current project access is revoked', async () => {
  configureFakeProjectClients(false, { role: 'viewer' })
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async listReviewerApprovals() {
        return { approvals: [{
          id: 'approval-1',
          teamId: 'core-team',
          issueId: 'issue-1',
          projectId: 'refero',
          subjectType: 'file-version',
          revision: 1,
          fileId: 'file-1',
          versionId: 'version-1',
          status: 'pending',
          reviewers: [{ memberKey: 'demo@example.com', status: 'pending' }],
          dueAt: '2099-07-20T00:00:00.000Z',
          requestedByMemberKey: 'manager@example.com',
          requestedByKind: 'member',
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
          capabilities: { canCancel: false, canDecide: true },
        }] }
      },
    }),
  })

  const response = await app.request('/api/approvals/reviewer', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ approvals: [] })
})

test('continues reviewer Inbox pagination after filtering an unauthorized scope', async () => {
  configureFakeProjectClients(true, { role: 'viewer' })
  const cursors: Array<string | undefined> = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async listReviewerApprovals(_workspaceId, _actor, options) {
        cursors.push(options?.cursor)
        const commonApproval = {
          subjectType: 'file-version' as const,
          revision: 1,
          fileId: 'file-1',
          versionId: 'version-1',
          status: 'pending' as const,
          reviewers: [{ memberKey: 'demo@example.com', status: 'pending' as const }],
          dueAt: '2099-07-20T00:00:00.000Z',
          requestedByMemberKey: 'manager@example.com',
          requestedByKind: 'member' as const,
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
          capabilities: { canCancel: false, canDecide: true },
        }

        return options?.cursor
          ? {
              approvals: [{
                ...commonApproval,
                id: 'approval-visible',
                teamId: 'core-team',
                issueId: 'issue-visible',
                projectId: 'refero',
              }],
            }
          : {
              approvals: [{
                ...commonApproval,
                id: 'approval-stale',
                teamId: 'missing-team',
                issueId: 'issue-stale',
                projectId: 'refero',
              }],
              nextCursor: 'page-2',
            }
      },
    }),
  })

  const response = await app.request('/api/approvals/reviewer?limit=1', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    approvals: [{ id: 'approval-visible' }],
  })
  expect(cursors).toEqual([undefined, 'page-2'])
})

test('does not hide reviewer Inbox authorization read failures as an empty page', async () => {
  configureFakeProjectClients(true, {
    detailReadError: Object.assign(new Error('Work Item read is unavailable.'), {
      code: 'DynamoDbUnavailable',
      status: 503,
    }),
    role: 'viewer',
  })
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async listReviewerApprovals() {
        return { approvals: [{
          id: 'approval-1',
          teamId: 'core-team',
          issueId: 'issue-1',
          projectId: 'refero',
          subjectType: 'file-version',
          revision: 1,
          fileId: 'file-1',
          versionId: 'version-1',
          status: 'pending',
          reviewers: [{ memberKey: 'demo@example.com', status: 'pending' }],
          dueAt: '2099-07-20T00:00:00.000Z',
          requestedByMemberKey: 'manager@example.com',
          requestedByKind: 'member',
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
          capabilities: { canCancel: false, canDecide: true },
        }] }
      },
    }),
  })

  const response = await app.request('/api/approvals/reviewer', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ message: 'File proofing data is unavailable.' })
})

test('uses a strongly consistent Work Item read for authorization-sensitive detail loads', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {
        Item: {
          schemaVersion: 2,
          revision: 1,
          workflowSchemaVersion: 1,
          directoryId: 'workspace-1',
          teamId: 'core-team',
          directoryTeamId: 'workspace-1#team#core-team',
          issueId: 'issue-1',
          sortOrder: 1,
          title: 'Authorization-sensitive issue',
          assigneeUserId: 'member@example.com',
          creatorMemberKey: 'member@example.com',
          workflowStatusId: 'todo',
          statusCategory: 'unstarted',
          customFieldValues: {},
          relationIds: [],
          dueDate: '2026-07-12',
          schedule: {
            calendarPolicy: {
              holidays: [],
              timeZone: 'UTC',
              workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
            },
            dueDate: '2026-07-12',
            mode: 'due-date',
          },
          priority: 'medium',
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
        },
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'issues-table',
    'events-table',
    documentClient,
    { send: async () => ({}) } as unknown as DynamoDBClient,
    false,
  )

  const detail = await client.getTeamIssueDetail('workspace-1', 'core-team', 'issue-1', {
    consistentIssueRead: true,
    includeEvents: false,
  })

  expect(sentInputs).toHaveLength(1)
  expect(detail.issue).toMatchObject({
    revision: 1,
    schedule: { dueDate: '2026-07-12', mode: 'due-date' },
    schemaVersion: 2,
  })
  expect(sentInputs[0]).toMatchObject({
    TableName: 'issues-table',
    ConsistentRead: true,
  })
})

/**
 * Creates a deliverable summary for one scope, as the file proofing client returns it.
 *
 * @param fileId - File ID of the summary.
 * @param approvalState - Current-version approval state.
 * @param updatedAt - File update time that orders the list.
 * @returns The summary.
 */
function createDeliverableSummaryFixture(
  fileId: string,
  approvalState: 'none' | 'pending' | 'approved',
  updatedAt: string,
) {
  const upload = createFileUploadSessionFixture()
  return {
    file: { ...upload.file, id: fileId, updatedAt, unresolvedAnnotationCount: 0 },
    approvalState,
    unresolvedAnnotationCount: approvalState === 'pending' ? 2 : 0,
  }
}

test('lists Project deliverables only from the Project and its readable Work Items', async () => {
  configureFakeProjectClients(true, {
    role: 'viewer',
    canonicalProjectIssueIds: ['visible-item', 'other-team-item'],
    canonicalProjectIssueTeamIds: { 'other-team-item': 'other-team' },
  })
  const reads: Array<{ kind: string; teamId: string; issueId?: string; projectId?: string }> = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async listDeliverables(scope) {
        reads.push({
          kind: scope.kind,
          teamId: scope.teamId,
          ...(scope.issueId ? { issueId: scope.issueId } : {}),
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
        })
        if (scope.kind === 'project') {
          return [createDeliverableSummaryFixture('project-file', 'approved', '2026-07-10T00:00:00.000Z')]
        }
        return [createDeliverableSummaryFixture(`${scope.issueId}-file`, 'pending', '2026-07-12T00:00:00.000Z')]
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/projects/refero/deliverables', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json() as {
    deliverables: Array<{ file: { id: string }; owner: { kind: string; issueId?: string }; approvalState: string }>
  }
  expect(body.deliverables.map((deliverable) => deliverable.file.id)).toEqual([
    'visible-item-file',
    'project-file',
  ])
  expect(body.deliverables[0]?.owner).toMatchObject({ kind: 'work-item', issueId: 'visible-item' })
  expect(reads).toEqual([
    { kind: 'project', teamId: 'core-team', projectId: 'refero' },
    { kind: 'work-item', teamId: 'core-team', issueId: 'visible-item', projectId: 'refero' },
  ])

  const unapproved = await app.request(
    '/api/teams/core-team/projects/refero/deliverables?approval=unapproved',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  const unapprovedBody = await unapproved.json() as { deliverables: Array<{ file: { id: string } }> }
  expect(unapprovedBody.deliverables.map((deliverable) => deliverable.file.id)).toEqual(['visible-item-file'])

  const invalid = await app.request(
    '/api/teams/core-team/projects/refero/deliverables?approval=everything',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(invalid.status).toBe(400)
})

test('does not read any deliverable when the Project is not readable', async () => {
  configureFakeProjectClients(true, {
    role: 'viewer',
    projectAccesses: [{ projectId: 'other-project', role: 'viewer' }],
    canonicalProjectIssueIds: ['hidden-item'],
  })
  let reads = 0
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async listDeliverables() {
        reads += 1
        return []
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/projects/refero/deliverables', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(403)
  expect(reads).toBe(0)
})

test('reads no attachment of a Work Item whose canonical row moved to another Project', async () => {
  const calls = configureFakeProjectClients(true, {
    role: 'viewer',
    canonicalProjectIssueIds: ['visible-item', 'moved-item'],
    detailAssignedProjectIds: { 'moved-item': 'other-project' },
  })
  const reads: string[] = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async listDeliverables(scope) {
        reads.push(scope.issueId ?? scope.kind)
        return scope.kind === 'project'
          ? []
          : [createDeliverableSummaryFixture(`${scope.issueId}-file`, 'none', '2026-07-12T00:00:00.000Z')]
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/projects/refero/deliverables', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json() as { deliverables: Array<{ file: { id: string } }> }
  expect(body.deliverables.map((deliverable) => deliverable.file.id)).toEqual(['visible-item-file'])
  expect(reads).toEqual(['project', 'visible-item'])
  expect(calls.issueDetails.map((read) => ({ issueId: read.issueId, readOptions: read.readOptions })))
    .toEqual([
      { issueId: 'visible-item', readOptions: { consistentIssueRead: true, includeEvents: false } },
      { issueId: 'moved-item', readOptions: { consistentIssueRead: true, includeEvents: false } },
    ])
})

test('returns only Project files to an Enterprise role without work-items.read', async () => {
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    canonicalProjectIssueIds: ['visible-item'],
  })
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const readIdentity = identity.getSnapshot.bind(identity)
  const customRole: EnterpriseCustomRole = {
    workspaceId, roleId: 'custom:files-only', name: 'Files only',
    permissions: ['teams.read', 'projects.read', 'files.read'],
    guestAssignable: false, revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }
  identity.getSnapshot = async (id) => ({
    ...await readIdentity(id),
    roleAssignments: [{
      workspaceId, assignmentId: 'files-only',
      principalKind: 'member', principalId: 'demo@example.com', roleId: customRole.roleId,
      scope: { workspaceId, kind: 'team', targetId: 'core-team' }, source: 'direct',
    }],
    customRoles: [customRole],
  })
  const reads: string[] = []
  setTestAppDependencies({
    enterpriseIdentity: identity,
    fileProofing: createFileProofingStub({
      async listDeliverables(scope) {
        reads.push(scope.issueId ?? scope.kind)
        return [createDeliverableSummaryFixture(`${scope.issueId ?? 'project'}-file`, 'none', '2026-07-12T00:00:00.000Z')]
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/projects/refero/deliverables', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json() as { deliverables: Array<{ file: { id: string } }>; nextCursor?: string }
  expect(body.deliverables.map((deliverable) => deliverable.file.id)).toEqual(['project-file'])
  expect(body.nextCursor).toBeUndefined()
  expect(reads).toEqual(['project'])
  expect(JSON.stringify(body)).not.toContain('visible-item')
})

test('requests approval of a Project file without a Work Item completion target', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  const requests: Array<{ kind: string; projectId?: string; reviewerMemberKeys: string[] }> = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async list() {
        const upload = createFileUploadSessionFixture()
        return {
          files: [{ ...upload.file, targetType: 'project', targetId: 'refero' }],
          approvals: [],
          capabilities: { canUpload: true, canRequestApproval: true, canGrantGuestAccess: false },
        }
      },
      async createApproval(scope, _actor, input) {
        requests.push({ kind: scope.kind, projectId: scope.projectId, reviewerMemberKeys: input.reviewerMemberKeys })
        const { issueId: _issueId, ...approval } = createApprovalRequestFixture({ projectId: 'refero' })
        return approval
      },
    }),
  })
  const request = (body: Record<string, unknown>) => app.request('/api/teams/core-team/projects/refero/approvals', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dueAt: '2099-07-20T00:00:00.000Z',
      fileId: 'file-1',
      versionId: 'version-1',
      reviewerMemberKeys: [' Sato@example.com '],
      ...body,
    }),
  })

  const rejected = await request({ completionTransition: 'done' })
  expect(rejected.status).toBe(400)
  expect(await rejected.json()).toMatchObject({ code: 'ApprovalCompletionTransitionUnsupported' })

  const response = await request({})
  expect(response.status).toBe(201)
  expect(requests).toEqual([{ kind: 'project', projectId: 'refero', reviewerMemberKeys: ['sato@example.com'] }])
})

test('accepts a Project file reviewer whose Enterprise role reads and approves files but not Work Items', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const readIdentity = identity.getSnapshot.bind(identity)
  const filesOnly: EnterpriseCustomRole = {
    workspaceId, roleId: 'custom:file-reviewer', name: 'File reviewer',
    permissions: ['teams.read', 'projects.read', 'files.read', 'files.approve'],
    guestAssignable: false, revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }
  const projectOnly: EnterpriseCustomRole = {
    ...filesOnly, roleId: 'custom:project-only', name: 'Project only', permissions: ['teams.read', 'projects.read'],
  }
  const readOnly: EnterpriseCustomRole = {
    ...filesOnly, roleId: 'custom:file-reader', name: 'File reader',
    permissions: ['teams.read', 'projects.read', 'files.read'],
  }
  identity.getSnapshot = async (id) => ({
    ...await readIdentity(id),
    roleAssignments: [
      {
        workspaceId, assignmentId: 'file-reviewer',
        principalKind: 'member', principalId: 'sato@example.com', roleId: filesOnly.roleId,
        scope: { workspaceId, kind: 'project', targetId: 'refero', parentTeamId: 'core-team' }, source: 'direct',
      },
      {
        workspaceId, assignmentId: 'project-only',
        principalKind: 'member', principalId: 'suzuki@example.com', roleId: projectOnly.roleId,
        scope: { workspaceId, kind: 'project', targetId: 'refero', parentTeamId: 'core-team' }, source: 'direct',
      },
      {
        workspaceId, assignmentId: 'file-reader',
        principalKind: 'member', principalId: 'tanaka@example.com', roleId: readOnly.roleId,
        scope: { workspaceId, kind: 'project', targetId: 'refero', parentTeamId: 'core-team' }, source: 'direct',
      },
    ],
    customRoles: [filesOnly, projectOnly, readOnly],
  })
  const created: string[][] = []
  setTestAppDependencies({
    enterpriseIdentity: identity,
    fileProofing: createFileProofingStub({
      async list() {
        const upload = createFileUploadSessionFixture()
        return {
          files: [{ ...upload.file, targetType: 'project', targetId: 'refero' }],
          approvals: [],
          capabilities: { canUpload: true, canRequestApproval: true, canGrantGuestAccess: false },
        }
      },
      async createApproval(_scope, _actor, input) {
        created.push(input.reviewerMemberKeys)
        const { issueId: _issueId, ...approval } = createApprovalRequestFixture({ projectId: 'refero' })
        return approval
      },
    }),
  })
  const request = (reviewer: string) => app.request('/api/teams/core-team/projects/refero/approvals', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dueAt: '2099-07-20T00:00:00.000Z',
      fileId: 'file-1',
      versionId: 'version-1',
      reviewerMemberKeys: [reviewer],
    }),
  })

  expect((await request('sato@example.com')).status).toBe(201)
  const denied = await request('suzuki@example.com')
  expect(denied.status).toBe(409)
  expect(await denied.json()).toMatchObject({ code: 'ApprovalReviewerAccessDenied' })
  // A reviewer who reads the files but cannot record a decision is not chosen either.
  const cannotDecide = await request('tanaka@example.com')
  expect(cannotDecide.status).toBe(409)
  expect(await cannotDecide.json()).toMatchObject({ code: 'ApprovalReviewerAccessDenied' })
  expect(created).toEqual([['sato@example.com']])
})

test('keeps Project file approvals in the reviewer Inbox only while the Project is readable', async () => {
  const { issueId: _issueId, ...projectApproval } = createApprovalRequestFixture({ projectId: 'refero' })
  for (const [hasAccess, expectedIds] of [[true, ['approval-1']], [false, []]] as const) {
    configureFakeProjectClients(hasAccess, { role: 'viewer' })
    setTestAppDependencies({
      fileProofing: createFileProofingStub({
        async listReviewerApprovals() {
          return { approvals: [projectApproval] }
        },
      }),
    })

    const response = await app.request('/api/approvals/reviewer', {
      headers: { Authorization: 'Bearer test-token' },
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { approvals: Array<{ id: string }> }
    expect(body.approvals.map((approval) => approval.id)).toEqual([...expectedIds])
    resetTestApp()
  }
})

test('routes annotation resolve, reopen, and delete to the authorized file scope', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  const calls: Array<{ action: string; kind: string; annotationId: string; resolved?: boolean }> = []
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async setAnnotationResolution(scope, _actor, fileId, versionId, annotationId, resolved) {
        calls.push({ action: 'resolution', kind: scope.kind, annotationId, resolved })
        return {
          id: annotationId,
          fileId,
          versionId,
          anchor: { kind: 'image', x: 0.5, y: 0.5 },
          bodyMarkdown: 'Fix this.',
          authorMemberKey: 'demo@example.com',
          createdAt: '2026-07-12T00:00:00.000Z',
          ...(resolved ? { resolvedAt: '2026-07-13T00:00:00.000Z' } : {}),
          capabilities: { canResolve: true, canDelete: true },
        }
      },
      async deleteAnnotation(scope, _actor, _fileId, _versionId, annotationId) {
        calls.push({ action: 'delete', kind: scope.kind, annotationId })
      },
    }),
  })
  const base = '/api/teams/core-team/projects/refero/files/file-1/versions/version-1/annotations/annotation-1'

  const resolved = await app.request(`${base}/resolve`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(resolved.status).toBe(200)
  expect(await resolved.json()).toMatchObject({ annotation: { resolvedAt: '2026-07-13T00:00:00.000Z' } })
  const reopened = await app.request(
    '/api/teams/core-team/issues/issue-1/files/file-1/versions/version-1/annotations/annotation-1/reopen',
    { method: 'POST', headers: { Authorization: 'Bearer test-token' } },
  )
  expect(reopened.status).toBe(200)
  const deleted = await app.request(base, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(deleted.status).toBe(204)
  expect(calls).toEqual([
    { action: 'resolution', kind: 'project', annotationId: 'annotation-1', resolved: true },
    { action: 'resolution', kind: 'work-item', annotationId: 'annotation-1', resolved: false },
    { action: 'delete', kind: 'project', annotationId: 'annotation-1' },
  ])
})
