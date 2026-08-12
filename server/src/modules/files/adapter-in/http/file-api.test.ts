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
    eventLimit: 0,
  })
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
    eventLimit: 0,
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
