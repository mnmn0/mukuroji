import { afterEach, expect, test } from 'bun:test'
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type {
  ApprovalRequest,
  CustomFieldValue,
  PlanningMutationResponse,
  PlanningSnapshot,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { LambdaEvent } from 'hono/aws-lambda'
import { createAuditEvent, createMutationAuditContext } from './audit'
import { CollaborationError, type CollaborationClient } from './collaboration'
import type { NotificationClient, NotificationItem } from './notifications'
import {
  createWorkspaceSearchDocument,
  type WorkspaceSearchClient,
  type WorkspaceSearchQueryInput,
  type WorkspaceSearchResolvedScope,
} from './workspace-search'
import {
  FileProofingError,
  type FileProofingActor,
  type FileProofingClient,
} from './file-proofing'
import {
  app,
  AwsCognitoClient,
  CognitoServiceError,
  configureApiClientsForTest,
  DynamoDbDashboardSummaryClient,
  DynamoDbProjectDirectoryClient,
  DynamoDbProjectTasksClient,
  DynamoDbTeamIssuesClient,
  FlociCognitoClient,
  handler,
  resetApiClientsForTest,
  WorkspaceAccessError,
  type ProjectRole,
  type WorkspaceAccessClient,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from './index'
import {
  DEFAULT_WORK_ITEM_CONFIGURATION,
  WorkItemConfigurationError,
  type WorkItemConfigurationClient,
} from './work-item-configuration'
import { InMemoryPlanningClient } from './planning'

afterEach(() => {
  resetApiClientsForTest()
})

test('authorizes Work Item file list reads and returns server capabilities', async () => {
  configureFakeProjectClients(true, { role: 'member' })
  const reads: Array<{ actor: string; issueId?: string; teamId: string }> = []
  configureApiClientsForTest({
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
  configureApiClientsForTest({
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
  configureApiClientsForTest({
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
  configureApiClientsForTest({
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
  configureApiClientsForTest({
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
  configureApiClientsForTest({
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
  configureApiClientsForTest({
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
  configureApiClientsForTest({
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
  configureApiClientsForTest({
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
      async upsertDocument(document) {
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
  configureApiClientsForTest({
    fileProofing: createFileProofingStub({
      async decideApproval() {
        return createApprovalRequestFixture({ status: 'rejected' })
      },
    }),
    workspaceSearch: {
      async upsertDocument(document) {
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
  configureApiClientsForTest({
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
  configureApiClientsForTest({
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
  configureApiClientsForTest({
    fileProofing: createFileProofingStub({
      async cancelApproval(_scope, _actor, _approvalId, input) {
        receivedRevision = input.expectedRevision
        return {
          id: 'approval-1',
          teamId: 'core-team',
          issueId: 'issue-1',
          revision: input.expectedRevision + 1,
          fileId: 'file-1',
          versionId: 'version-1',
          status: 'cancelled',
          reviewers: [{ memberKey: 'reviewer@example.com', status: 'pending' }],
          dueAt: '2099-07-20T00:00:00.000Z',
          requestedByMemberKey: 'demo@example.com',
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
  configureApiClientsForTest({
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
  configureApiClientsForTest({
    fileProofing: createFileProofingStub({
      async listReviewerApprovals() {
        return { approvals: [{
          id: 'approval-1',
          teamId: 'core-team',
          issueId: 'issue-1',
          projectId: 'refero',
          revision: 1,
          fileId: 'file-1',
          versionId: 'version-1',
          status: 'pending',
          reviewers: [{ memberKey: 'demo@example.com', status: 'pending' }],
          dueAt: '2099-07-20T00:00:00.000Z',
          requestedByMemberKey: 'manager@example.com',
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
  configureApiClientsForTest({
    fileProofing: createFileProofingStub({
      async listReviewerApprovals(_workspaceId, _actor, options) {
        cursors.push(options?.cursor)
        const commonApproval = {
          revision: 1,
          fileId: 'file-1',
          versionId: 'version-1',
          status: 'pending' as const,
          reviewers: [{ memberKey: 'demo@example.com', status: 'pending' as const }],
          dueAt: '2099-07-20T00:00:00.000Z',
          requestedByMemberKey: 'manager@example.com',
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
  configureApiClientsForTest({
    fileProofing: createFileProofingStub({
      async listReviewerApprovals() {
        return { approvals: [{
          id: 'approval-1',
          teamId: 'core-team',
          issueId: 'issue-1',
          projectId: 'refero',
          revision: 1,
          fileId: 'file-1',
          versionId: 'version-1',
          status: 'pending',
          reviewers: [{ memberKey: 'demo@example.com', status: 'pending' }],
          dueAt: '2099-07-20T00:00:00.000Z',
          requestedByMemberKey: 'manager@example.com',
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
          schemaVersion: 1,
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
          dueDate: '2026/07/12',
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
  expect(detail.issue).toMatchObject({ schemaVersion: 1, revision: 1 })
  expect(sentInputs[0]).toMatchObject({
    TableName: 'issues-table',
    ConsistentRead: true,
  })
})

test('rejects a status-only canonical row instead of upcasting workflow fields', async () => {
  const documentClient = {
    async send() {
      return {
        Item: {
          schemaVersion: 1,
          revision: 1,
          directoryId: 'workspace-1',
          directoryTeamId: 'workspace-1#team#core-team',
          teamId: 'core-team',
          issueId: 'legacy-shaped-row',
          sortOrder: 1,
          title: 'Legacy-shaped row',
          assigneeUserId: 'member@example.com',
          status: 'todo',
          dueDate: '2026/07/12',
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
    {} as DynamoDBClient,
    false,
  )

  await expect(client.getTeamIssueDetail(
    'workspace-1',
    'core-team',
    'legacy-shaped-row',
    { eventLimit: 0 },
  )).rejects.toMatchObject({ code: 'InvalidTeamIssue', status: 503 })
})

test('rejects legacy-only display fields on canonical rows', async () => {
  const canonicalItem = {
    schemaVersion: 1,
    revision: 1,
    workflowSchemaVersion: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    teamId: 'core-team',
    issueId: 'strict-row',
    sortOrder: 1,
    title: 'Strict row',
    assigneeUserId: 'member@example.com',
    creatorMemberKey: 'member@example.com',
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/12',
    priority: 'medium',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }

  for (const legacyField of [
    'titleKey',
    'assignee',
    'assigneeKey',
    'source',
    'migrationSource',
    'migrationSourceKey',
    'relationIds',
  ] as const) {
    const documentClient = {
      async send() {
        return {
          Item: {
            ...canonicalItem,
            [legacyField]: 'legacy-display-value',
          },
        }
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbTeamIssuesClient(
      'issues-table',
      'events-table',
      documentClient,
      {} as DynamoDBClient,
      false,
    )

    await expect(client.getTeamIssueDetail(
      'workspace-1',
      'core-team',
      'strict-row',
      { eventLimit: 0 },
    )).rejects.toMatchObject({ code: 'InvalidTeamIssue', status: 503 })
  }
})

test('pages filtered legacy comments with a scope-bound opaque event cursor', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryPage = 0
  const issueItem = {
    schemaVersion: 1,
    revision: 1,
    workflowSchemaVersion: 1,
    directoryId: 'workspace-1',
    teamId: 'core-team',
    directoryTeamId: 'workspace-1#team#core-team',
    issueId: 'issue-1',
    sortOrder: 1,
    title: 'Legacy comments',
    assigneeUserId: 'member@example.com',
    creatorMemberKey: 'member@example.com',
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/12',
    priority: 'medium',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      if (!('KeyConditionExpression' in command.input)) {
        return { Item: issueItem }
      }

      queryPage += 1
      const eventId = queryPage === 1 ? '2026-07-12T00:02:00.000Z#newer' : '2026-07-12T00:01:00.000Z#older'
      return {
        Items: [{
          directoryId: 'workspace-1',
          teamId: 'core-team',
          issueId: 'issue-1',
          directoryTeamIssueId: 'workspace-1#team#core-team#issue#issue-1',
          eventId,
          eventType: 'commented',
          actorUserId: 'member@example.com',
          body: queryPage === 1 ? 'Newer legacy comment' : 'Older legacy comment',
          summary: 'Comment was added.',
          createdAt: eventId.slice(0, 24),
        }],
        ...(queryPage === 1
          ? {
              LastEvaluatedKey: {
                directoryTeamIssueId: 'workspace-1#team#core-team#issue#issue-1',
                eventId,
              },
            }
          : {}),
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
  const options = {
    consistentIssueRead: true,
    eventLimit: 1,
    eventType: 'commented' as const,
    newestEventsFirst: true,
  }

  const first = await client.getTeamIssueDetail('workspace-1', 'core-team', 'issue-1', options)
  const second = await client.getTeamIssueDetail('workspace-1', 'core-team', 'issue-1', {
    ...options,
    eventCursor: first.nextEventCursor,
  })

  expect(first.comments.map((comment) => comment.body)).toEqual(['Newer legacy comment'])
  expect(first.nextEventCursor).toBeString()
  expect(second.comments.map((comment) => comment.body)).toEqual(['Older legacy comment'])
  expect(sentInputs[1]).toMatchObject({
    TableName: 'events-table',
    FilterExpression: 'eventType = :eventType',
    Limit: 1,
    ScanIndexForward: false,
  })
  expect(sentInputs[3]?.ExclusiveStartKey).toEqual({
    directoryTeamIssueId: 'workspace-1#team#core-team#issue#issue-1',
    eventId: '2026-07-12T00:02:00.000Z#newer',
  })
})

test('serves the same authenticated API contract from Function URL root and /api paths', async () => {
  await withTestEnvironment(
    {
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-api-test',
      COGNITO_CLIENT_ID: 'mukuroji-client',
      COGNITO_ISSUER: '   ',
      COGNITO_USER_POOL_ID: 'us-east-1_mukuroji',
      MUKUROJI_WORKSPACE_DIRECTORY_ID: 'workspace#production',
    },
    async () => {
      const calls = configureFakeProjectClients(true)
      configureFakeAuthenticatedUser({
        email: 'Demo@Example.com',
        'custom:directory_id': 'workspace#production',
        'custom:workspace_id': 'workspace#production',
      })
      const accessToken = createAccessToken([], {
        client_id: 'mukuroji-client',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_mukuroji',
        token_use: 'access',
      })

      const directResponse = await handler(createLambdaHttpEvent('/teams/projects', accessToken))
      const prefixedResponse = await handler(createLambdaHttpEvent('/api/teams/projects', accessToken))

      expect(directResponse.statusCode).toBe(200)
      expect(prefixedResponse.statusCode).toBe(200)
      expect(JSON.parse(directResponse.body)).toEqual(JSON.parse(prefixedResponse.body))
      expect(calls.directoryReads).toEqual([
        { directoryId: 'workspace#production', locale: 'ja' },
        { directoryId: 'workspace#production', locale: 'ja' },
      ])
    },
  )
})

test('rejects conflicting Cognito directory attributes on auth me', async () => {
  configureFakeProjectClients(true)
  configureFakeAuthenticatedUser({
    email: 'demo@example.com',
    'custom:directory_id': 'workspace#one',
    'custom:workspace_id': 'workspace#two',
  })

  const response = await app.request('/api/auth/me', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    message: 'Cognito workspace does not match the configured workspace.',
  })
})

test('rejects a Cognito directory that differs from the configured DynamoDB workspace partition', async () => {
  await withTestEnvironment(
    { MUKUROJI_WORKSPACE_DIRECTORY_ID: 'workspace#production' },
    async () => {
      const calls = configureFakeProjectClients(true)
      configureFakeAuthenticatedUser({
        email: 'demo@example.com',
        'custom:directory_id': 'workspace#other',
      })

      const response = await app.request('/api/teams/projects', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      })

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        message: 'Cognito workspace does not match the configured workspace.',
      })
      expect(calls.directoryReads).toEqual([])
    },
  )
})

test('accepts one Cognito workspace attribute with the legacy directory environment fallback', async () => {
  await withTestEnvironment(
    {
      MUKUROJI_PROJECT_DIRECTORY_ID: 'workspace#legacy',
      MUKUROJI_WORKSPACE_DIRECTORY_ID: undefined,
    },
    async () => {
      const calls = configureFakeProjectClients(true)
      configureFakeAuthenticatedUser({
        email: 'demo@example.com',
        'custom:workspace_id': 'workspace#legacy',
      })

      const response = await app.request('/api/teams/projects', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      })

      expect(response.status).toBe(200)
      expect(calls.directoryReads).toEqual([
        { directoryId: 'workspace#legacy', locale: 'ja' },
      ])
    },
  )
})

test('rejects a token from another Cognito pool before calling GetUser', async () => {
  await withTestEnvironment(
    {
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-api-test',
      COGNITO_CLIENT_ID: 'mukuroji-client',
      COGNITO_ISSUER: undefined,
      COGNITO_USER_POOL_ID: 'us-east-1_mukuroji',
    },
    async () => {
      configureFakeProjectClients(true)
      let getUserCalls = 0
      configureFakeAuthenticatedUser(
        { email: 'demo@example.com' },
        () => {
          getUserCalls += 1
        },
      )
      const accessToken = createAccessToken([], {
        client_id: 'other-client',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_other',
        token_use: 'access',
      })

      const response = await app.request('/api/auth/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ message: 'Authentication failed.' })
      expect(getUserCalls).toBe(0)
    },
  )
})

test('uses an explicit Floci public issuer and rejects other issuers before GetUser', async () => {
  await withTestEnvironment(
    {
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-api-test',
      COGNITO_CLIENT_ID: 'mukuroji-client',
      COGNITO_ISSUER: '  http://localhost:4567/us-east-1_mukuroji/  ',
      COGNITO_USER_POOL_ID: 'us-east-1_mukuroji',
    },
    async () => {
      configureFakeProjectClients(true)
      let getUserCalls = 0
      configureFakeAuthenticatedUser(
        { email: 'demo@example.com' },
        () => {
          getUserCalls += 1
        },
      )
      const validAccessToken = createAccessToken([], {
        client_id: 'mukuroji-client',
        iss: 'http://localhost:4567/us-east-1_mukuroji',
        token_use: 'access',
      })
      const wrongIssuerToken = createAccessToken([], {
        client_id: 'mukuroji-client',
        iss: 'http://localhost:4567/us-east-1_other',
        token_use: 'access',
      })

      const validResponse = await app.request('/api/auth/me', {
        headers: { Authorization: `Bearer ${validAccessToken}` },
      })
      const wrongIssuerResponse = await app.request('/api/auth/me', {
        headers: { Authorization: `Bearer ${wrongIssuerToken}` },
      })

      expect(validResponse.status).toBe(200)
      expect(wrongIssuerResponse.status).toBe(401)
      expect(await wrongIssuerResponse.json()).toEqual({ message: 'Authentication failed.' })
      expect(getUserCalls).toBe(1)
    },
  )
})

test('fails closed when production Cognito pool or client configuration is missing', async () => {
  await withTestEnvironment(
    {
      AWS_LAMBDA_FUNCTION_NAME: 'mukuroji-api-test',
      COGNITO_CLIENT_ID: undefined,
      COGNITO_USER_POOL_ID: undefined,
    },
    async () => {
      configureFakeProjectClients(true)
      let getUserCalls = 0
      configureFakeAuthenticatedUser(
        { email: 'demo@example.com' },
        () => {
          getUserCalls += 1
        },
      )

      const response = await app.request('/api/auth/me', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      })

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ message: 'Cognito is not configured.' })
      expect(getUserCalls).toBe(0)
    },
  )
})

test('uses AWS Cognito SDK commands and excludes users with conflicting workspace attributes', async () => {
  const commandNames: string[] = []
  const sdkClient = {
    async send(command: object) {
      const commandName = command.constructor.name
      commandNames.push(commandName)

      if (commandName === 'InitiateAuthCommand') {
        return { AuthenticationResult: { AccessToken: 'access-token' } }
      }

      if (commandName === 'RespondToAuthChallengeCommand') {
        return { AuthenticationResult: { AccessToken: 'challenge-access-token' } }
      }

      if (commandName === 'GetUserCommand') {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      }

      if (commandName === 'ListUsersCommand') {
        return {
          Users: [
            {
              Username: 'valid@example.com',
              Attributes: [
                { Name: 'email', Value: 'valid@example.com' },
                { Name: 'custom:directory_id', Value: 'workspace#production' },
                { Name: 'custom:workspace_id', Value: 'workspace#production' },
              ],
            },
            {
              Username: 'conflicting@example.com',
              Attributes: [
                { Name: 'email', Value: 'conflicting@example.com' },
                { Name: 'custom:directory_id', Value: 'workspace#production' },
                { Name: 'custom:workspace_id', Value: 'workspace#other' },
              ],
            },
          ],
        }
      }

      return {
        Username: 'valid@example.com',
        UserAttributes: [{ Name: 'email', Value: 'valid@example.com' }],
      }
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(sdkClient, 'us-east-1_mukuroji', 'mukuroji-client')

  await expect(client.initiatePasswordAuth('demo@example.com', 'password')).resolves.toMatchObject({
    AuthenticationResult: { AccessToken: 'access-token' },
  })
  await expect(client.respondToNewPasswordChallenge(
    'demo@example.com',
    'Permanent123!',
    'new-password-session',
  )).resolves.toMatchObject({
    AuthenticationResult: { AccessToken: 'challenge-access-token' },
  })
  await expect(client.getUser('access-token')).resolves.toMatchObject({
    Username: 'demo@example.com',
  })
  await expect(client.listUsers({ directoryId: 'workspace#production' })).resolves.toEqual({
    users: [
      {
        id: 'valid@example.com',
        username: 'valid@example.com',
        email: 'valid@example.com',
        name: undefined,
        enabled: undefined,
        status: undefined,
      },
    ],
    nextToken: undefined,
  })
  await expect(client.getUserProfile('valid@example.com')).resolves.toMatchObject({
    id: 'valid@example.com',
  })
  expect(commandNames).toEqual([
    'InitiateAuthCommand',
    'RespondToAuthChallengeCommand',
    'GetUserCommand',
    'ListUsersCommand',
    'AdminGetUserCommand',
  ])
})

test('runs the Workspace identity lifecycle through the production AWS Cognito adapter', async () => {
  const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = []
  const adminGetAttempts = new Map<string, number>()
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      const input = command.input
      sentCommands.push({ name, input })

      if (name === 'RespondToAuthChallengeCommand') {
        return { AuthenticationResult: createFakeAuthTokenSet() }
      }

      if (name === 'GetUserCommand') {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      }

      const username = typeof input.Username === 'string' ? input.Username : ''

      if (name === 'AdminGetUserCommand') {
        const attempt = (adminGetAttempts.get(username) ?? 0) + 1
        adminGetAttempts.set(username, attempt)
        const userId = username.startsWith('sub-') ? username.slice(4) : username

        if (
          (username === 'new-user@example.com' && attempt <= 2) ||
          (username === 'raced-user@example.com' && attempt <= 2)
        ) {
          throw createCognitoSdkTestError('UserNotFoundException', 400)
        }

        if (userId === 'missing@example.com') {
          throw createCognitoSdkTestError('UserNotFoundException', 400)
        }

        if (username === 'existing@example.com') {
          return {
            Username: 'CaseSensitiveExisting',
            UserAttributes: [
              { Name: 'email', Value: username },
              { Name: 'sub', Value: 'sub-existing' },
            ],
            Enabled: true,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
          }
        }

        const directoryId = userId === 'other-workspace@example.com'
          ? 'workspace#other'
          : 'user#demo@example.com'

        return {
          Username: userId,
          UserAttributes: [
            { Name: 'email', Value: userId },
            { Name: 'sub', Value: username.startsWith('sub-') ? username : `sub-${username}` },
            { Name: 'custom:directory_id', Value: directoryId },
            { Name: 'custom:workspace_id', Value: directoryId },
          ],
          Enabled: true,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
        }
      }

      if (name === 'AdminCreateUserCommand') {
        if (username === 'raced-user@example.com' && input.MessageAction !== 'RESEND') {
          throw createCognitoSdkTestError('UsernameExistsException', 400)
        }

        return {
          User: {
            Username: username,
            Attributes: [
              { Name: 'email', Value: username },
              { Name: 'sub', Value: `sub-${username}` },
              { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
              { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
            ],
            Enabled: true,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
          },
        }
      }

      if (name === 'AdminDeleteUserCommand' && username === 'sub-missing@example.com') {
        throw createCognitoSdkTestError('UserNotFoundException', 400)
      }

      if (name === 'AdminDeleteUserCommand' && username === 'sub-forbidden@example.com') {
        throw createCognitoSdkTestError('AccessDeniedException', 403)
      }

      return {}
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )
  const calls = configureFakeProjectClients(true)
  configureApiClientsForTest({ cognito: client })

  const challengeResponse = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'Demo@Example.com',
      newPassword: 'Permanent123!',
      session: 'new-password-session',
    }),
  })
  expect(challengeResponse.status).toBe(200)
  expect(await challengeResponse.json()).toMatchObject({ accessToken: 'test-token' })
  expect(calls.workspaceReconciliations).toEqual(['demo@example.com'])

  const invite = async (email: string) => {
    const response = await app.request('/api/workspace/invitations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, name: 'Invitee', role: 'member' }),
    })

    expect(response.status).toBe(201)
    return response.json()
  }

  await expect(invite('existing@example.com')).resolves.toMatchObject({
    invitation: {
      directoryClaimCleanupRequired: true,
      deliveryStatus: 'sent',
      identityOwnership: 'pre-existing',
    },
  })
  await expect(invite('new-user@example.com')).resolves.toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      identityOwnership: 'workspace-created',
    },
  })
  await expect(invite('raced-user@example.com')).resolves.toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      identityOwnership: 'ambiguous',
    },
  })
  await expect(client.provisionWorkspaceUser({
    email: 'other-workspace@example.com',
    directoryId: 'user#demo@example.com',
    beforeDirectoryClaimUpdate: async () => {},
  })).rejects.toMatchObject({
    code: 'WorkspaceDirectoryConflict',
    status: 409,
  })

  configureApiClientsForTest({
    workspaceAccess: {
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async revokeInvitation(
        _workspaceId: string,
        _actorMemberKey: string,
        invitationId: string,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          identityLifecycleVersion: 2,
          cognitoIdentityId: 'sub-new-user@example.com',
          cognitoUsername: 'new-user@example.com',
          failureMessage: 'Cognito cleanup is pending and can be retried safely.',
          version: 2,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async clearInvitationCleanupFailure(
        _workspaceId: string,
        invitationId: string,
        expectedVersion: number,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          identityLifecycleVersion: 2,
          cognitoIdentityId: 'sub-new-user@example.com',
          cognitoUsername: 'new-user@example.com',
          identityCleanupCompleted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
    } as unknown as WorkspaceAccessClient,
  })
  const revokeResponse = await app.request(
    '/api/workspace/invitations/new-user%40example.com/revoke',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    },
  )
  expect(revokeResponse.status).toBe(200)
  expect(await revokeResponse.json()).toMatchObject({
    invitation: { identityOwnership: 'workspace-created', status: 'revoked' },
  })
  await expect(client.deleteWorkspaceUser({
    userId: 'missing@example.com',
    directoryId: 'user#demo@example.com',
    cognitoIdentityId: 'sub-missing@example.com',
    cognitoUsername: 'missing@example.com',
  })).resolves.toBe('absent')
  await expect(client.deleteWorkspaceUser({
    userId: 'forbidden@example.com',
    directoryId: 'user#demo@example.com',
    cognitoIdentityId: 'sub-forbidden@example.com',
    cognitoUsername: 'forbidden@example.com',
  })).rejects.toMatchObject({
    code: 'AccessDeniedException',
    status: 403,
  })

  expect(adminGetAttempts).toEqual(new Map([
    ['demo@example.com', 1],
    ['existing@example.com', 1],
    ['new-user@example.com', 2],
    ['sub-new-user@example.com', 1],
    ['raced-user@example.com', 3],
    ['other-workspace@example.com', 1],
    ['sub-missing@example.com', 1],
    ['missing@example.com', 1],
    ['sub-forbidden@example.com', 1],
  ]))
  expect(sentCommands
    .filter(({ name }) => name !== 'GetUserCommand')
    .map(({ name }) => name)).toEqual([
    'AdminGetUserCommand',
    'RespondToAuthChallengeCommand',
    'AdminGetUserCommand',
    'AdminUpdateUserAttributesCommand',
    'AdminCreateUserCommand',
    'AdminGetUserCommand',
    'AdminGetUserCommand',
    'AdminCreateUserCommand',
    'AdminGetUserCommand',
    'AdminGetUserCommand',
    'AdminCreateUserCommand',
    'AdminGetUserCommand',
    'AdminUpdateUserAttributesCommand',
    'AdminCreateUserCommand',
    'AdminGetUserCommand',
    'AdminGetUserCommand',
    'AdminDeleteUserCommand',
    'AdminGetUserCommand',
    'AdminGetUserCommand',
    'AdminGetUserCommand',
    'AdminDeleteUserCommand',
  ])
  expect(sentCommands.find(({ name }) => name === 'RespondToAuthChallengeCommand')?.input).toEqual({
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ChallengeResponses: {
      USERNAME: 'demo@example.com',
      NEW_PASSWORD: 'Permanent123!',
    },
    ClientId: 'mukuroji-client',
    Session: 'new-password-session',
  })
  expect(sentCommands.filter(({ name }) =>
    name === 'AdminGetUserCommand'
  ).every(({ input }) => input.UserPoolId === 'us-east-1_mukuroji')).toBe(true)
  expect(sentCommands.find(({ name, input }) =>
    name === 'AdminUpdateUserAttributesCommand' &&
    input.Username === 'CaseSensitiveExisting'
  )?.input).toEqual({
    UserPoolId: 'us-east-1_mukuroji',
    Username: 'CaseSensitiveExisting',
    UserAttributes: [
      { Name: 'email', Value: 'existing@example.com' },
      { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
      { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
      { Name: 'name', Value: 'Invitee' },
    ],
  })
  expect(sentCommands.find(({ name, input }) =>
    name === 'AdminCreateUserCommand' &&
    input.Username === 'new-user@example.com' &&
    input.MessageAction === undefined
  )?.input).toEqual({
    UserPoolId: 'us-east-1_mukuroji',
    Username: 'new-user@example.com',
    DesiredDeliveryMediums: ['EMAIL'],
    UserAttributes: [
      { Name: 'email', Value: 'new-user@example.com' },
      { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
      { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
      { Name: 'name', Value: 'Invitee' },
    ],
  })
  expect(sentCommands.filter(({ name, input }) =>
    name === 'AdminCreateUserCommand' && input.MessageAction === 'RESEND'
  ).map(({ input }) => input.Username)).toEqual([
    'CaseSensitiveExisting',
    'raced-user@example.com',
  ])
  expect(sentCommands.some(({ name, input }) =>
    (
      name === 'AdminUpdateUserAttributesCommand' ||
      name === 'AdminCreateUserCommand'
    ) && input.Username === 'other-workspace@example.com'
  )).toBe(false)
  expect(sentCommands.filter(({ name }) =>
    name === 'AdminDeleteUserCommand'
  ).map(({ input }) => input)).toEqual([
    {
      UserPoolId: 'us-east-1_mukuroji',
      Username: 'sub-new-user@example.com',
    },
    {
      UserPoolId: 'us-east-1_mukuroji',
      Username: 'sub-forbidden@example.com',
    },
  ])
})

test('preserves confirmed Cognito identities while removing invitation-owned directory claims', async () => {
  const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = []
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      const input = command.input
      sentCommands.push({ name, input })

      if (name === 'AdminGetUserCommand') {
        const identityId = String(input.Username)

        if (identityId === 'sub-original-identity') {
          throw createCognitoSdkTestError('UserNotFoundException', 400)
        }

        const userId = identityId.startsWith('sub-') ? identityId.slice(4) : identityId
        const username = userId === 'confirmed@example.com'
          ? 'CaseSensitiveConfirmed'
          : userId === 'linked@example.com'
            ? 'ExternalIdentity'
            : 'OtherWorkspaceIdentity'
        const directoryId = userId === 'other-workspace@example.com'
          ? 'workspace#other'
          : 'workspace#production'

        return {
          Username: username,
          UserAttributes: [
            { Name: 'email', Value: userId },
            { Name: 'sub', Value: identityId },
            { Name: 'custom:directory_id', Value: directoryId },
            { Name: 'custom:workspace_id', Value: directoryId },
          ],
          Enabled: true,
          UserStatus: 'CONFIRMED',
        }
      }

      return {}
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )

  await expect(client.deleteWorkspaceUser({
    userId: 'confirmed@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-confirmed@example.com',
    cognitoUsername: 'CaseSensitiveConfirmed',
  })).resolves.toBe('preserved')
  await client.unlinkWorkspaceUser({
    userId: 'confirmed@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-confirmed@example.com',
    cognitoUsername: 'CaseSensitiveConfirmed',
  })
  await client.unlinkWorkspaceUser({
    userId: 'linked@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-linked@example.com',
    cognitoUsername: 'ExternalIdentity',
  })
  await expect(client.deleteWorkspaceUser({
    userId: 'other-workspace@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-other-workspace@example.com',
    cognitoUsername: 'OtherWorkspaceIdentity',
  })).resolves.toBe('preserved')
  await client.unlinkWorkspaceUser({
    userId: 'other-workspace@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-other-workspace@example.com',
    cognitoUsername: 'OtherWorkspaceIdentity',
  })
  await expect(client.deleteWorkspaceUser({
    userId: 'replacement@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-original-identity',
    cognitoUsername: 'OriginalIdentity',
  })).resolves.toBe('absent')
  await client.unlinkWorkspaceUser({
    userId: 'replacement@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-original-identity',
    cognitoUsername: 'OriginalIdentity',
  })

  expect(sentCommands.filter(({ name }) => name === 'AdminDeleteUserCommand')).toEqual([])
  expect(sentCommands.filter(({ name }) =>
    name === 'AdminDeleteUserAttributesCommand'
  ).map(({ input }) => input)).toEqual([
    {
      UserPoolId: 'us-east-1_mukuroji',
      Username: 'sub-confirmed@example.com',
      UserAttributeNames: ['custom:directory_id', 'custom:workspace_id'],
    },
    {
      UserPoolId: 'us-east-1_mukuroji',
      Username: 'sub-linked@example.com',
      UserAttributeNames: ['custom:directory_id', 'custom:workspace_id'],
    },
  ])
})

test('requires manual cleanup instead of mutating a Cognito alias after stable lookup fails', async () => {
  const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = []
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      const input = command.input
      sentCommands.push({ name, input })

      if (name !== 'AdminGetUserCommand') {
        return {}
      }

      if (input.Username === 'sub-alias-user') {
        throw createCognitoSdkTestError('UserNotFoundException', 400)
      }

      if (input.Username === 'CaseSensitiveAlias') {
        return {
          Username: 'CaseSensitiveAlias',
          UserAttributes: [
            { Name: 'email', Value: 'alias@example.com' },
            { Name: 'sub', Value: 'sub-alias-user' },
            { Name: 'custom:directory_id', Value: 'workspace#production' },
            { Name: 'custom:workspace_id', Value: 'workspace#production' },
          ],
          Enabled: true,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
        }
      }

      throw createCognitoSdkTestError('UserNotFoundException', 400)
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )
  const cleanupInput = {
    userId: 'alias@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-alias-user',
    cognitoUsername: 'CaseSensitiveAlias',
  }

  await expect(client.deleteWorkspaceUser(cleanupInput)).resolves.toBe('manual-required')
  await expect(client.unlinkWorkspaceUser(cleanupInput)).resolves.toBe('manual-required')
  expect(sentCommands.filter(({ name }) =>
    name === 'AdminDeleteUserCommand' || name === 'AdminDeleteUserAttributesCommand'
  )).toEqual([])
})

test('requires manual cleanup when a Cognito stable identity lookup is inconclusive', async () => {
  const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = []
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      const input = command.input
      sentCommands.push({ name, input })

      if (name !== 'AdminGetUserCommand') {
        return {}
      }

      if (input.Username === 'sub-colliding-identity') {
        return {
          Username: 'ReplacementIdentity',
          UserAttributes: [
            { Name: 'email', Value: 'replacement@example.com' },
            { Name: 'sub', Value: 'sub-replacement-identity' },
            { Name: 'custom:directory_id', Value: 'workspace#production' },
          ],
          Enabled: true,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
        }
      }

      if (input.Username === 'sub-missing-canonical-identity') {
        throw createCognitoSdkTestError('UserNotFoundException', 400)
      }

      if (input.Username === 'MissingCanonicalIdentity') {
        return {
          Username: 'MissingCanonicalIdentity',
          UserAttributes: [
            { Name: 'email', Value: 'missing-sub@example.com' },
            { Name: 'custom:directory_id', Value: 'workspace#production' },
          ],
          Enabled: true,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
        }
      }

      throw createCognitoSdkTestError('UserNotFoundException', 400)
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )
  const collidingIdentityInput = {
    userId: 'collision@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-colliding-identity',
    cognitoUsername: 'CollisionIdentity',
  }
  const missingCanonicalIdentityInput = {
    userId: 'missing-sub@example.com',
    directoryId: 'workspace#production',
    cognitoIdentityId: 'sub-missing-canonical-identity',
    cognitoUsername: 'MissingCanonicalIdentity',
  }

  await expect(client.deleteWorkspaceUser(collidingIdentityInput)).resolves.toBe('manual-required')
  await expect(client.unlinkWorkspaceUser(collidingIdentityInput)).resolves.toBe('manual-required')
  await expect(client.deleteWorkspaceUser(missingCanonicalIdentityInput)).resolves.toBe(
    'manual-required',
  )
  await expect(client.unlinkWorkspaceUser(missingCanonicalIdentityInput)).resolves.toBe(
    'manual-required',
  )
  expect(sentCommands.filter(({ name }) =>
    name === 'AdminDeleteUserCommand' || name === 'AdminDeleteUserAttributesCommand'
  )).toEqual([])
})

test('cleans invitation-owned claims when revoking a pre-existing Cognito identity', async () => {
  const cleanupInputs: Array<Record<string, unknown>> = []
  let cleanupMarkerClears = 0
  configureApiClientsForTest({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      },
      async unlinkWorkspaceUser(input: Record<string, unknown>) {
        cleanupInputs.push(input)
      },
    } as unknown as NonNullable<
      Parameters<typeof configureApiClientsForTest>[0]['cognito']
    >,
    workspaceAccess: {
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async revokeInvitation(
        _workspaceId: string,
        _actorMemberKey: string,
        invitationId: string,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'pre-existing',
          identityLifecycleVersion: 2,
          cognitoIdentityId: 'sub-existing',
          cognitoUsername: 'CaseSensitiveExisting',
          directoryClaimCleanupRequired: true,
          version: 2,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: 'Cognito cleanup is pending and can be retried safely.',
        }
      },
      async clearInvitationCleanupFailure(
        _workspaceId: string,
        invitationId: string,
        expectedVersion: number,
      ) {
        cleanupMarkerClears += 1
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'pre-existing',
          identityLifecycleVersion: 2,
          cognitoIdentityId: 'sub-existing',
          cognitoUsername: 'CaseSensitiveExisting',
          identityCleanupCompleted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request(
    '/api/workspace/invitations/existing%40example.com/revoke',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    },
  )

  expect(response.status).toBe(200)
  expect(cleanupInputs).toEqual([{
    userId: 'existing@example.com',
    directoryId: 'user#demo@example.com',
    cognitoIdentityId: 'sub-existing',
    cognitoUsername: 'CaseSensitiveExisting',
  }])
  expect(cleanupMarkerClears).toBe(1)
  const responseBody = await response.json() as { invitation: Record<string, unknown> }
  expect(responseBody.invitation).toMatchObject({
    identityCleanupCompleted: true,
    identityOwnership: 'pre-existing',
    status: 'revoked',
  })
  expect(responseBody.invitation.directoryClaimCleanupRequired).toBeUndefined()
})

test('persists manual cleanup when stable Cognito mutation is unavailable', async () => {
  let manualMarkers = 0
  let cleanupCompletions = 0
  configureApiClientsForTest({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      },
      async unlinkWorkspaceUser() {
        return 'manual-required' as const
      },
    } as unknown as NonNullable<
      Parameters<typeof configureApiClientsForTest>[0]['cognito']
    >,
    workspaceAccess: {
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async revokeInvitation(_workspaceId, _actorMemberKey, invitationId) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'pre-existing',
          identityLifecycleVersion: 2,
          cognitoIdentityId: 'sub-alias-user',
          cognitoUsername: 'CaseSensitiveAlias',
          directoryClaimCleanupRequired: true,
          version: 2,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: 'Cognito cleanup is pending and can be retried safely.',
        }
      },
      async markInvitationManualCleanupRequired(_workspaceId, invitationId, expectedVersion) {
        manualMarkers += 1
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'pre-existing',
          identityCleanupManualRequired: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage:
            'Manual Cognito cleanup is required. After removing the user or Workspace claims in Cognito, retry revocation to verify completion.',
        }
      },
      async clearInvitationCleanupFailure() {
        cleanupCompletions += 1
        throw new Error('Manual cleanup must not be marked complete automatically.')
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request(
    '/api/workspace/invitations/alias%40example.com/revoke',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    },
  )

  expect(response.status).toBe(200)
  expect(manualMarkers).toBe(1)
  expect(cleanupCompletions).toBe(0)
  expect(await response.json()).toMatchObject({
    invitation: { identityCleanupManualRequired: true, status: 'revoked' },
  })
})

test('keeps legacy revoke in manual cleanup without mutating Cognito', async () => {
  let cognitoCleanupCalls = 0
  let cleanupCompletions = 0
  configureApiClientsForTest({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [
            { Name: 'email', Value: 'demo@example.com' },
            { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
            { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
          ],
        }
      },
      async isSystemAdmin() {
        return false
      },
      async deleteWorkspaceUser() {
        cognitoCleanupCalls += 1
        return 'deleted'
      },
      async unlinkWorkspaceUser() {
        cognitoCleanupCalls += 1
        return 'completed' as const
      },
      async findWorkspaceUser() {
        return {
          profile: {
            id: 'legacy@example.com',
            username: 'LegacyIdentity',
            email: 'legacy@example.com',
          },
          identityId: 'sub-legacy',
          directoryId: 'user#demo@example.com',
        }
      },
    } as unknown as NonNullable<
      Parameters<typeof configureApiClientsForTest>[0]['cognito']
    >,
    workspaceAccess: {
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async revokeInvitation(_workspaceId, _actorMemberKey, invitationId) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          identityCleanupManualRequired: true,
          version: 2,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: 'Cognito cleanup is pending and can be retried safely.',
        }
      },
      async clearInvitationCleanupFailure(_workspaceId, invitationId, expectedVersion) {
        cleanupCompletions += 1
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          identityCleanupCompleted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationManualCleanupRequired(_workspaceId, _invitationId, _expectedVersion) {
        return {
          id: 'legacy@example.com',
          email: 'legacy@example.com',
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          identityCleanupManualRequired: true,
          version: 2,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage:
            'Manual Cognito cleanup is required. After removing the user or Workspace claims in Cognito, retry revocation to verify completion.',
        }
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request(
    '/api/workspace/invitations/legacy%40example.com/revoke',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    },
  )

  expect(response.status).toBe(200)
  expect(cognitoCleanupCalls).toBe(0)
  expect(cleanupCompletions).toBe(0)
  expect(await response.json()).toMatchObject({
    invitation: {
      identityCleanupManualRequired: true,
      identityOwnership: 'workspace-created',
      status: 'revoked',
    },
  })
})

test('acknowledges manual Cognito cleanup with actor and invitation version', async () => {
  const acknowledgements: Array<Record<string, unknown>> = []
  configureApiClientsForTest({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      },
    } as unknown as NonNullable<
      Parameters<typeof configureApiClientsForTest>[0]['cognito']
    >,
    workspaceAccess: {
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async acknowledgeInvitationManualCleanup(
        workspaceId: string,
        actorMemberKey: string,
        invitationId: string,
        expectedVersion: number,
      ) {
        acknowledgements.push({
          workspaceId,
          actorMemberKey,
          invitationId,
          expectedVersion,
        })
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'ambiguous',
          identityCleanupCompleted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request(
    '/api/workspace/invitations/legacy%40example.com/cleanup/acknowledge',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 7 }),
    },
  )

  expect(response.status).toBe(200)
  expect(acknowledgements).toEqual([{
    workspaceId: 'user#demo@example.com',
    actorMemberKey: 'demo@example.com',
    invitationId: 'legacy@example.com',
    expectedVersion: 7,
  }])
  expect(await response.json()).toMatchObject({
    invitation: { identityCleanupCompleted: true, version: 8 },
  })
})

test('rejects disabled existing Cognito identities before mutating invitation attributes', async () => {
  const commandNames: string[] = []
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      commandNames.push(name)

      if (name === 'GetUserCommand') {
        return {
          Username: 'demo@example.com',
          UserAttributes: [{ Name: 'email', Value: 'demo@example.com' }],
        }
      }

      if (name === 'AdminGetUserCommand') {
        return {
          Username: 'DisabledIdentity',
          UserAttributes: [{ Name: 'email', Value: 'disabled@example.com' }],
          Enabled: false,
          UserStatus: 'CONFIRMED',
        }
      }

      return {}
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )
  configureFakeProjectClients(true)
  configureApiClientsForTest({ cognito: client })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: 'disabled@example.com', role: 'member' }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'CognitoUserDisabled',
    message: 'The existing Cognito user is disabled. Re-enable it before sending a Workspace invitation.',
  })
  expect(commandNames).toEqual(['GetUserCommand', 'AdminGetUserCommand'])
})

test('rejects a disabled Cognito identity discovered after UsernameExists', async () => {
  const commandNames: string[] = []
  let adminGetAttempts = 0
  const sdkClient = {
    async send(command: { input: Record<string, unknown> }) {
      const name = command.constructor.name
      commandNames.push(name)

      if (name === 'AdminGetUserCommand') {
        adminGetAttempts += 1

        if (adminGetAttempts === 1) {
          throw createCognitoSdkTestError('UserNotFoundException', 400)
        }

        return {
          Username: 'DisabledRaceIdentity',
          UserAttributes: [
            { Name: 'email', Value: 'disabled-race@example.com' },
            { Name: 'sub', Value: 'sub-disabled-race' },
          ],
          Enabled: false,
          UserStatus: 'FORCE_CHANGE_PASSWORD',
        }
      }

      if (name === 'AdminCreateUserCommand') {
        throw createCognitoSdkTestError('UsernameExistsException', 400)
      }

      return {}
    },
  } as unknown as CognitoIdentityProviderClient
  const client = new AwsCognitoClient(
    sdkClient,
    'us-east-1_mukuroji',
    'mukuroji-client',
  )
  let cleanupMarkerCalls = 0

  await expect(client.provisionWorkspaceUser({
    email: 'disabled-race@example.com',
    directoryId: 'workspace#production',
    beforeDirectoryClaimUpdate: async () => {
      cleanupMarkerCalls += 1
    },
  })).rejects.toMatchObject({
    code: 'CognitoUserDisabled',
    status: 409,
  })
  expect(cleanupMarkerCalls).toBe(0)
  expect(commandNames).toEqual([
    'AdminGetUserCommand',
    'AdminCreateUserCommand',
    'AdminGetUserCommand',
  ])
})

test('keeps Floci usernames case-sensitive and rejects disabled race identities', async () => {
  await withTestEnvironment(
    {
      COGNITO_CLIENT_ID: 'local-client',
      COGNITO_USER_POOL_ID: 'us-east-1_local',
    },
    async () => {
      const originalFetch = globalThis.fetch
      const requests: Array<{ action: string; payload: Record<string, unknown> }> = []
      let adminGetAttempts = 0
      globalThis.fetch = (async (_input, init) => {
        const target = new Headers(init?.headers).get('X-Amz-Target') ?? ''
        const action = target.split('.').at(-1) ?? ''
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
        requests.push({ action, payload })

        if (action === 'AdminGetUser') {
          adminGetAttempts += 1

          if (adminGetAttempts === 1) {
            return new Response(JSON.stringify({ __type: 'UserNotFoundException' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            })
          }

          return new Response(JSON.stringify({
            Username: 'DisabledFlociIdentity',
            UserAttributes: [
              { Name: 'email', Value: 'disabled-floci@example.com' },
              { Name: 'sub', Value: 'sub-disabled-floci' },
            ],
            Enabled: false,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (action === 'AdminCreateUser' && payload.MessageAction !== 'RESEND') {
          return new Response(JSON.stringify({ __type: 'UsernameExistsException' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const client = new FlociCognitoClient('http://localhost:4566')
        await client.resendWorkspaceUserInvitation('CaseSensitiveFlociUser')
        let cleanupMarkerCalls = 0

        await expect(client.provisionWorkspaceUser({
          email: 'disabled-floci@example.com',
          directoryId: 'workspace#production',
          beforeDirectoryClaimUpdate: async () => {
            cleanupMarkerCalls += 1
          },
        })).rejects.toMatchObject({
          code: 'CognitoUserDisabled',
          status: 409,
        })
        expect(cleanupMarkerCalls).toBe(0)
        expect(requests.map(({ action }) => action)).toEqual([
          'AdminCreateUser',
          'AdminGetUser',
          'AdminCreateUser',
          'AdminGetUser',
        ])
        expect(requests[0]?.payload).toMatchObject({
          MessageAction: 'RESEND',
          Username: 'CaseSensitiveFlociUser',
        })
        expect(requests.some(({ action }) => action === 'AdminUpdateUserAttributes')).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    },
  )
})

test('keeps Floci cleanup manual when a stable identity lookup is inconclusive', async () => {
  await withTestEnvironment(
    {
      COGNITO_CLIENT_ID: 'local-client',
      COGNITO_USER_POOL_ID: 'us-east-1_local',
    },
    async () => {
      const originalFetch = globalThis.fetch
      const requests: Array<{ action: string; payload: Record<string, unknown> }> = []
      globalThis.fetch = (async (_input, init) => {
        const target = new Headers(init?.headers).get('X-Amz-Target') ?? ''
        const action = target.split('.').at(-1) ?? ''
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
        requests.push({ action, payload })

        if (action !== 'AdminGetUser') {
          return new Response('{}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (payload.Username === 'sub-colliding-identity') {
          return new Response(JSON.stringify({
            Username: 'ReplacementIdentity',
            UserAttributes: [
              { Name: 'email', Value: 'replacement@example.com' },
              { Name: 'sub', Value: 'sub-replacement-identity' },
              { Name: 'custom:directory_id', Value: 'workspace#production' },
            ],
            Enabled: true,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (payload.Username === 'MissingCanonicalIdentity') {
          return new Response(JSON.stringify({
            Username: 'MissingCanonicalIdentity',
            UserAttributes: [
              { Name: 'email', Value: 'missing-sub@example.com' },
              { Name: 'custom:directory_id', Value: 'workspace#production' },
            ],
            Enabled: true,
            UserStatus: 'FORCE_CHANGE_PASSWORD',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        return new Response(JSON.stringify({ __type: 'UserNotFoundException' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      try {
        const client = new FlociCognitoClient('http://localhost:4566')
        const collidingIdentityInput = {
          userId: 'collision@example.com',
          directoryId: 'workspace#production',
          cognitoIdentityId: 'sub-colliding-identity',
          cognitoUsername: 'CollisionIdentity',
        }
        const missingCanonicalIdentityInput = {
          userId: 'missing-sub@example.com',
          directoryId: 'workspace#production',
          cognitoIdentityId: 'sub-missing-canonical-identity',
          cognitoUsername: 'MissingCanonicalIdentity',
        }

        await expect(client.deleteWorkspaceUser(collidingIdentityInput)).resolves.toBe(
          'manual-required',
        )
        await expect(client.unlinkWorkspaceUser(collidingIdentityInput)).resolves.toBe(
          'manual-required',
        )
        await expect(client.deleteWorkspaceUser(missingCanonicalIdentityInput)).resolves.toBe(
          'manual-required',
        )
        await expect(client.unlinkWorkspaceUser(missingCanonicalIdentityInput)).resolves.toBe(
          'manual-required',
        )
        expect(requests.some(({ action }) =>
          action === 'AdminDeleteUser' || action === 'AdminDeleteUserAttributes'
        )).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    },
  )
})

test('keeps the Bun development Cognito default on local Floci', async () => {
  await withTestEnvironment(
    {
      AWS_ENDPOINT_URL: undefined,
      AWS_LAMBDA_FUNCTION_NAME: undefined,
      COGNITO_CLIENT_ID: 'local-client',
      COGNITO_ENDPOINT: undefined,
      COGNITO_USER_POOL_ID: 'us-east-1_local',
    },
    async () => {
      const originalFetch = globalThis.fetch
      const requestedUrls: string[] = []
      globalThis.fetch = (async (input) => {
        requestedUrls.push(String(input))

        return new Response(JSON.stringify({
          AuthenticationResult: { AccessToken: 'local-access-token' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch
      resetApiClientsForTest()

      try {
        const response = await app.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'demo@example.com',
            password: 'password',
          }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ accessToken: 'local-access-token' })
        expect(requestedUrls).toEqual(['http://localhost:4566/'])
      } finally {
        globalThis.fetch = originalFetch
      }
    },
  )
})

test('uses ALLOWED_ORIGINS for shared Hono CORS responses', async () => {
  await withTestEnvironment(
    { ALLOWED_ORIGINS: 'https://app.example.com, https://admin.example.com' },
    async () => {
      const allowedResponse = await app.request('/api/health', {
        headers: { Origin: 'https://admin.example.com' },
      })
      const deniedResponse = await app.request('/api/health', {
        headers: { Origin: 'https://other.example.com' },
      })

      expect(allowedResponse.headers.get('access-control-allow-origin')).toBe(
        'https://admin.example.com',
      )
      expect(deniedResponse.headers.get('access-control-allow-origin')).toBeNull()
    },
  )
})

test('loads project directory from the authenticated user scoped partition', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/projects?locale=en', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'Core Team',
        expanded: true,
        projects: [
          {
            id: 'refero',
            name: 'Refero',
            tone: 'blue',
          },
        ],
      },
    ],
  })
  expect(calls.directoryReads).toEqual([{ directoryId: 'user#demo@example.com', locale: 'en' }])
})

/** Notification visibility API test に使う render-ready item を作ります。 */
function createNotificationItem(
  overrides: Partial<NotificationItem> = {},
): NotificationItem {
  return {
    id: 'notification-item',
    eventId: 'notification-event',
    eventType: 'work-item.updated',
    reasons: ['status-change'],
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'notification-item',
    occurredAt: '2026-07-12T12:00:00.000Z',
    state: 'unread',
    ...overrides,
  }
}

/** NotificationClient 経由で API の current visibility 判定結果を記録します。 */
function createNotificationVisibilityProbe(notifications: NotificationItem[]) {
  const visibility = new Map<string, boolean>()
  const client: NotificationClient = {
    async list(input) {
      const visibleNotifications: NotificationItem[] = []
      for (const notification of notifications) {
        const isVisible = !input.isVisible || await input.isVisible(notification)
        visibility.set(notification.id, isVisible)
        if (isVisible) {
          visibleNotifications.push(notification)
        }
      }
      return { notifications: visibleNotifications }
    },
    async countUnread(input) {
      let count = 0
      for (const notification of notifications) {
        const isVisible = !input.isVisible || await input.isVisible(notification)
        visibility.set(notification.id, isVisible)
        if (isVisible && notification.state === 'unread') {
          count += 1
        }
      }
      return count
    },
    async update() {
      throw new Error('Notification update is not configured for this visibility test.')
    },
    async markAllRead() {
      return 0
    },
    async getPreferences() {
      return {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant',
        quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
      }
    },
    async savePreferences(input) {
      return {
        ...input.preferences,
        version: input.preferences.version + 1,
        updatedAt: '2026-07-12T13:00:00.000Z',
      }
    },
  }
  return { client, visibility }
}

test('serves permission-filtered notification timeline, state, and preference contracts', async () => {
  const projectCalls = configureFakeProjectClients(true, {
    detailAssigneeUserId: 'demo@example.com',
  })
  const notification = {
    id: 'opaque-notification-id',
    eventId: 'evt-1',
    eventType: 'work-item.updated',
    reasons: ['status-change'],
    title: 'Notification API',
    deepLink: '/teams/core-team/issues?issueId=notification-api',
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'notification-api',
    occurredAt: '2026-07-12T12:00:00.000Z',
    state: 'unread' as const,
  }
  const calls: {
    filter?: string
    action?: string
    savedPreferenceVersion?: number
  } = {}
  const notificationClient: NotificationClient = {
    async list(input) {
      calls.filter = input.filter
      expect(input.workspaceId).toBe('user#demo@example.com')
      expect(input.memberKey).toBe('demo@example.com')
      expect(await input.isVisible?.(notification)).toBe(true)
      expect(await input.isVisible?.({ ...notification, issueId: undefined, projectId: 'hidden-project' })).toBe(false)
      return { notifications: [notification], nextCursor: 'next-page' }
    },
    async countUnread() {
      return calls.action === 'mark-read' ? 0 : 1
    },
    async update(input) {
      calls.action = input.action
      return { ...notification, state: 'read', readAt: '2026-07-12T13:00:00.000Z' }
    },
    async markAllRead() {
      return 1
    },
    async getPreferences() {
      return {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant',
        quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
      }
    },
    async savePreferences(input) {
      calls.savedPreferenceVersion = input.preferences.version
      return {
        ...input.preferences,
        version: input.preferences.version + 1,
        updatedAt: '2026-07-12T13:00:00.000Z',
      }
    },
  }
  configureApiClientsForTest({ notifications: notificationClient })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }

  const listResponse = await app.request('/api/notifications?filter=unread&limit=20', { headers })
  expect(listResponse.status).toBe(200)
  expect(await listResponse.json()).toMatchObject({
    notifications: [{ id: 'opaque-notification-id', state: 'unread' }],
    nextCursor: 'next-page',
    unreadCount: 1,
  })
  expect(calls.filter).toBe('unread')
  expect(projectCalls.directoryReads).toContainEqual({
    directoryId: 'user#demo@example.com',
    locale: 'ja',
    consistentRead: true,
  })

  const updateResponse = await app.request('/api/notifications/opaque-notification-id', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ action: 'mark-read' }),
  })
  expect(updateResponse.status).toBe(200)
  expect(await updateResponse.json()).toMatchObject({ state: 'read' })
  expect(calls.action).toBe('mark-read')

  const preferenceResponse = await app.request('/api/notification-preferences', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      version: 0,
      channels: { inApp: true, email: true, push: false },
      frequency: 'daily',
      quietHours: { enabled: true, start: '22:00', end: '07:00', timeZone: 'Asia/Tokyo' },
    }),
  })
  expect(preferenceResponse.status).toBe(200)
  expect(await preferenceResponse.json()).toMatchObject({ version: 1, frequency: 'daily' })
  expect(calls.savedPreferenceVersion).toBe(0)
})

test('hides a notification after its Work Item moves to an inaccessible project', async () => {
  configureFakeProjectClients(true, {
    detailAssignedProjectId: 'private-project',
    detailAssigneeUserId: 'demo@example.com',
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
  })
  const notification = {
    id: 'opaque-notification-id',
    eventId: 'evt-1',
    eventType: 'work-item.updated',
    reasons: ['status-change'],
    teamId: 'core-team',
    projectId: 'refero',
    issueId: 'moved-item',
    occurredAt: '2026-07-12T12:00:00.000Z',
    state: 'unread' as const,
  }
  let currentlyVisible = true
  const notificationClient = {
    async list(input) {
      currentlyVisible = await input.isVisible?.(notification) ?? true
      return { notifications: currentlyVisible ? [notification] : [] }
    },
    async countUnread(input) {
      return await input.isVisible?.(notification) ? 1 : 0
    },
    async update() {
      return notification
    },
    async markAllRead() {
      return 0
    },
    async getPreferences() {
      return {
        version: 0,
        channels: { inApp: true, email: false, push: false },
        frequency: 'instant' as const,
        quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
      }
    },
    async savePreferences(input) {
      return input.preferences
    },
  } as NotificationClient
  configureApiClientsForTest({ notifications: notificationClient })

  const response = await app.request('/api/notifications', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(currentlyVisible).toBe(false)
  expect(notification.projectId).toBe('private-project')
  expect(await response.json()).toMatchObject({ notifications: [], unreadCount: 0 })
})

test('keeps a shared-project notification visible under every active owner Team', async () => {
  configureFakeProjectClients(true, {
    detailAssignedProjectId: 'shared-launch',
    detailAssigneeUserId: 'demo@example.com',
    projectAccesses: [{ projectId: 'shared-launch', role: 'viewer' }],
    teamProjects: [{ id: 'shared-launch', name: 'Shared launch', tone: 'green' }],
    additionalTeams: [{
      id: 'design-team',
      name: 'Design Team',
      projects: [{ id: 'shared-launch', name: 'Shared launch', tone: 'green' }],
    }],
  })
  const coreNotification = createNotificationItem({
    id: 'shared-project-core-notification',
    issueId: 'shared-project-core-item',
    projectId: 'shared-launch',
    reasons: ['watcher'],
  })
  const designNotification = createNotificationItem({
    id: 'shared-project-design-notification',
    issueId: 'shared-project-design-item',
    projectId: 'shared-launch',
    reasons: ['watcher'],
    teamId: 'design-team',
  })
  const probe = createNotificationVisibilityProbe([coreNotification, designNotification])
  configureApiClientsForTest({ notifications: probe.client })

  const response = await app.request('/api/notifications', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(probe.visibility.get(coreNotification.id)).toBe(true)
  expect(probe.visibility.get(designNotification.id)).toBe(true)
  expect(await response.json()).toMatchObject({
    notifications: [{ id: coreNotification.id }, { id: designNotification.id }],
    unreadCount: 2,
  })
})

test('hides stale assignee-only notifications after Work Item reassignment', async () => {
  configureFakeProjectClients(true, {
    detailAssigneeUserId: 'sato@example.com',
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
  })
  const staleAssignment = createNotificationItem({
    id: 'stale-assignment',
    reasons: ['assignment'],
  })
  const staleDue = createNotificationItem({
    id: 'stale-due',
    reasons: ['due'],
  })
  const retainedMention = createNotificationItem({
    id: 'retained-mention',
    reasons: ['assignment', 'mention'],
  })
  const probe = createNotificationVisibilityProbe([staleAssignment, staleDue, retainedMention])
  configureApiClientsForTest({ notifications: probe.client })

  const response = await app.request('/api/notifications', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(probe.visibility.get(staleAssignment.id)).toBe(false)
  expect(probe.visibility.get(staleDue.id)).toBe(false)
  expect(probe.visibility.get(retainedMention.id)).toBe(true)
  expect(await response.json()).toMatchObject({
    notifications: [{ id: retainedMention.id }],
    unreadCount: 1,
  })
})

test('returns Cognito groups and system admin status for the current user', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/auth/me', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    groups: ['mukuroji-system-admins'],
    isSystemAdmin: true,
  })
})

test('returns Workspace role and active status for the current user', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin' })

  const response = await app.request('/api/auth/me', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    workspaceRole: 'admin',
    workspaceMemberStatus: 'active',
  })
})

test('blocks a deactivated Workspace member before any business API read', async () => {
  const calls = configureFakeProjectClients(true, { workspaceStatus: 'deactivated' })

  const response = await app.request('/api/teams/projects', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Workspace access is denied.' })
  expect(calls.directoryReads).toEqual([])
})

test('keeps guest Workspace members read-only even when they have a project role', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'guest' })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Guest must not create this task',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(calls.issueCreates).toEqual([])
})

test('limits Workspace structure changes to owners and admins', async () => {
  const calls = configureFakeProjectClients(true, { workspaceRole: 'member' })

  const response = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Unauthorized team' }),
  })

  expect(response.status).toBe(403)
  expect(calls.teamCreates).toEqual([])
})

test('rejects inactive Workspace members as task assignment candidates', async () => {
  const calls = configureFakeProjectClients(true, {
    inactiveWorkspaceMemberKeys: ['sato@example.com'],
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Inactive assignee task',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(409)
  expect(calls.issueCreates).toEqual([])
})

test('returns a NEW_PASSWORD_REQUIRED challenge without creating a session', async () => {
  const calls = configureFakeProjectClients(true, { passwordAuthChallenge: true })

  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', password: 'Temporary123!' }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    challenge: 'NEW_PASSWORD_REQUIRED',
    email: 'demo@example.com',
    session: 'new-password-session',
  })
  expect(calls.workspaceReconciliations).toEqual([])
})

test('returns a stable error when a new password violates the Cognito policy', async () => {
  const calls = configureFakeProjectClients(true, {
    newPasswordChallengeError: new CognitoServiceError(
      400,
      'InvalidPasswordException',
      'Password did not conform with policy.',
    ),
  })

  const response = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'demo@example.com',
      newPassword: 'weak',
      session: 'new-password-session',
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidNewPassword',
    message: 'New password does not meet the password policy.',
  })
  expect(calls.workspaceReconciliations).toEqual([])
})

test('holds the invitation acceptance lock across the Cognito password challenge', async () => {
  const sequence: string[] = []
  const invitation = {
    id: 'invitee@example.com',
    email: 'invitee@example.com',
    role: 'member' as const,
    status: 'pending' as const,
    deliveryStatus: 'sent' as const,
    identityOwnership: 'workspace-created' as const,
    cognitoIdentityId: 'sub-invitee',
    version: 2,
    expiresAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    acceptanceLockExpiresAt: '2026-07-11T00:01:00.000Z',
  }
  configureApiClientsForTest({
    cognito: {
      async findWorkspaceUser() {
        sequence.push('find-user')
        return {
          profile: {
            id: 'invitee@example.com',
            username: 'InviteeIdentity',
            email: 'invitee@example.com',
            enabled: true,
            status: 'FORCE_CHANGE_PASSWORD',
          },
          identityId: 'sub-invitee',
          directoryId: 'workspace#production',
        }
      },
      async respondToNewPasswordChallenge() {
        sequence.push('complete-challenge')
        return { AuthenticationResult: createFakeAuthTokenSet() }
      },
      async getUser() {
        sequence.push('get-user')
        return {
          Username: 'InviteeIdentity',
          UserAttributes: [
            { Name: 'email', Value: 'invitee@example.com' },
            { Name: 'custom:directory_id', Value: 'workspace#production' },
            { Name: 'custom:workspace_id', Value: 'workspace#production' },
          ],
        }
      },
    } as unknown as NonNullable<
      Parameters<typeof configureApiClientsForTest>[0]['cognito']
    >,
    workspaceAccess: {
      async getActiveMember() {
        sequence.push('get-active-member')
        return undefined
      },
      async acquireInvitationAcceptanceLock() {
        sequence.push('acquire-lock')
        return invitation
      },
      async releaseInvitationAcceptanceLock() {
        sequence.push('release-lock')
        return {
          ...invitation,
          acceptanceLockExpiresAt: undefined,
          version: 3,
        }
      },
      async reconcileAuthenticatedMember(_workspaceId: string, input: { memberKey: string }) {
        sequence.push('reconcile-member')
        return {
          id: input.memberKey,
          memberKey: input.memberKey,
          email: 'invitee@example.com',
          role: 'member',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'invitee@example.com',
      newPassword: 'Permanent123!',
      session: 'new-password-session',
    }),
  })

  expect(response.status).toBe(200)
  expect(sequence).toEqual([
    'find-user',
    'get-active-member',
    'acquire-lock',
    'complete-challenge',
    'get-user',
    'reconcile-member',
    'release-lock',
  ])
})

test('lets an active Workspace member complete a new password challenge without an invitation lock', async () => {
  const sequence: string[] = []
  const activeMember = {
    id: 'member@example.com',
    memberKey: 'member@example.com',
    email: 'member@example.com',
    role: 'member' as const,
    status: 'active' as const,
    version: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  }
  configureApiClientsForTest({
    cognito: {
      async findWorkspaceUser() {
        sequence.push('find-user')
        return {
          profile: {
            id: 'member@example.com',
            username: 'ExistingMemberIdentity',
            email: 'member@example.com',
            enabled: true,
            status: 'FORCE_CHANGE_PASSWORD',
          },
          identityId: 'sub-existing-member',
          directoryId: 'workspace#production',
        }
      },
      async respondToNewPasswordChallenge() {
        sequence.push('complete-challenge')
        return { AuthenticationResult: createFakeAuthTokenSet() }
      },
      async getUser() {
        sequence.push('get-user')
        return {
          Username: 'ExistingMemberIdentity',
          UserAttributes: [
            { Name: 'email', Value: 'member@example.com' },
            { Name: 'custom:directory_id', Value: 'workspace#production' },
            { Name: 'custom:workspace_id', Value: 'workspace#production' },
          ],
        }
      },
    } as unknown as NonNullable<
      Parameters<typeof configureApiClientsForTest>[0]['cognito']
    >,
    workspaceAccess: {
      async getActiveMember() {
        sequence.push('get-active-member')
        return activeMember
      },
      async acquireInvitationAcceptanceLock() {
        sequence.push('acquire-lock')
        throw new Error('Active members must not acquire an invitation acceptance lock.')
      },
      async releaseInvitationAcceptanceLock() {
        sequence.push('release-lock')
        throw new Error('No invitation acceptance lock should be released.')
      },
      async reconcileAuthenticatedMember() {
        sequence.push('reconcile-member')
        return activeMember
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'member@example.com',
      newPassword: 'Permanent123!',
      session: 'new-password-session',
    }),
  })

  expect(response.status).toBe(200)
  expect(sequence).toEqual([
    'find-user',
    'get-active-member',
    'complete-challenge',
    'get-user',
    'reconcile-member',
  ])
})

test('retries membership reconcile on normal login after password completion succeeded alone', async () => {
  const calls = configureFakeProjectClients(true, {
    newPasswordChallengeTokens: true,
    passwordAuthTokens: true,
    workspaceReconcileFailures: 1,
  })

  const challengeResponse = await app.request('/api/auth/challenge/new-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'demo@example.com',
      newPassword: 'Permanent123!',
      session: 'new-password-session',
    }),
  })
  expect(challengeResponse.status).toBe(503)

  const loginResponse = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@example.com', password: 'Permanent123!' }),
  })

  expect(loginResponse.status).toBe(200)
  expect(await loginResponse.json()).toMatchObject({ accessToken: 'test-token' })
  expect(calls.workspaceReconciliations).toEqual([
    'demo@example.com',
    'demo@example.com',
  ])
})

test('returns owner and admin Workspace capabilities from the API source of truth', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'admin' })

  const response = await app.request('/api/workspace/access', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    currentMember: { role: 'admin', status: 'active' },
    capabilities: {
      canInvite: true,
      canManageMembers: true,
      canManageAdmins: false,
    },
  })
})

test('serializes Workspace role updates with the Planning revision', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'guest', expectedVersion: 1 }),
  })

  expect(response.status).toBe(200)
  expect(calls.workspaceMemberUpdates).toEqual([{
    expectedPlanningRevision: 0,
    memberKey: 'sato@example.com',
    role: 'guest',
  }])
})

test('forwards stable Workspace mutation audit headers and actor context to the state client', async () => {
  configureFakeProjectClients(true)
  let capturedAuditContext: ReturnType<typeof createMutationAuditContext> | undefined
  const owner = {
    id: 'demo@example.com',
    memberKey: 'demo@example.com',
    email: 'demo@example.com',
    role: 'owner' as const,
    status: 'active' as const,
    version: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  }
  configureApiClientsForTest({
    workspaceAccess: {
      async getActiveMember() {
        return owner
      },
      async updateMember(
        _workspaceId: string,
        _actorMemberKey: string,
        memberKey: string,
        input: Parameters<WorkspaceAccessClient['updateMember']>[3],
        auditContext: Parameters<WorkspaceAccessClient['updateMember']>[4],
      ) {
        capturedAuditContext = auditContext
        return {
          ...owner,
          id: memberKey,
          memberKey,
          email: memberKey,
          role: input.role ?? owner.role,
          status: input.status ?? owner.status,
          version: input.expectedVersion + 1,
        }
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'workspace-member-role-change-1',
      'X-Correlation-Id': 'workspace-correlation-1',
    },
    body: JSON.stringify({ expectedVersion: 1, role: 'guest' }),
  })

  expect(response.status).toBe(200)
  expect(capturedAuditContext).toMatchObject({
    workspaceId: 'user#demo@example.com',
    actor: {
      id: 'demo@example.com',
      displayName: 'demo@example.com',
      kind: 'user',
    },
    correlationId: 'workspace-correlation-1',
    source: {
      kind: 'api',
      method: 'PATCH',
      route: '/api/workspace/members/sato%40example.com',
    },
  })
  expect(capturedAuditContext?.idempotencyKeyHash).not.toContain(
    'workspace-member-role-change-1',
  )
})

test('rejects deactivating a Workspace member who still manages an active project', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion: 1, status: 'deactivated' }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    message: 'Transfer or remove all active project manager roles before deactivating this member.',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: '*' },
  ])
})

test('rejects deactivating a Workspace member who owns an active Planning entity', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create('user#demo@example.com', {
    ...createCyclePlanningInput('cycle-owned-by-member', 0),
    ownerMemberKey: 'SATO@EXAMPLE.COM',
  }, { workItems: [] })
  configureFakeProjectClients(true, { role: 'member' })
  configureApiClientsForTest({ planning: planningClient })

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion: 1, status: 'deactivated' }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    message: 'Transfer or archive all owned Planning entities before deactivating this member.',
  })
})

test('resends credentials when inviting an existing unconfirmed Workspace identity', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'invitee@example.com',
      name: 'Invitee',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual(['invitee@example.com'])
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'invitee@example.com',
      identityOwnership: 'pre-existing',
      status: 'pending',
    },
  })
})

test('records ownership when invitation provisioning creates a new Cognito identity', async () => {
  const calls = configureFakeProjectClients(true, { workspaceUserMissing: true })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'new-user@example.com',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual([])
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'new-user@example.com',
      identityOwnership: 'workspace-created',
      status: 'pending',
    },
  })
})

test('persists created identity provenance when the successful delivery write fails', async () => {
  configureFakeProjectClients(true, { workspaceUserMissing: true })
  const deliveryInputs: Array<Parameters<WorkspaceAccessClient['markInvitationDelivery']>[2]> = []

  configureApiClientsForTest({
    workspaceAccess: {
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async createInvitation(_workspaceId, _actorMemberKey, input) {
        return {
          id: input.email,
          email: input.email,
          role: input.role,
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          version: 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationIdentityMutationStarted(
        _workspaceId,
        invitationId,
        expectedVersion,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          identityLifecycleVersion: 2,
          identityMutationAttempted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationDelivery(_workspaceId, invitationId, input) {
        deliveryInputs.push(input)

        if (input.deliveryStatus !== 'failed') {
          throw new Error('Delivery state write failed after Cognito provisioning.')
        }

        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'delivery-failed',
          deliveryStatus: 'failed',
          identityOwnership: input.identityOwnership,
          cognitoIdentityId: input.cognitoIdentityId,
          cognitoUsername: input.cognitoUsername,
          directoryClaimCleanupRequired: input.directoryClaimCleanupRequired,
          version: input.expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: input.failureMessage,
        }
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: 'new-user@example.com', role: 'member' }),
  })

  expect(response.status).toBe(502)
  expect(deliveryInputs).toEqual([
    {
      expectedVersion: 2,
      identityOwnership: 'workspace-created',
      cognitoIdentityId: 'sub-new-user@example.com',
      cognitoUsername: 'new-user@example.com',
      directoryClaimCleanupRequired: false,
      deliveryStatus: 'sent',
    },
    {
      expectedVersion: 2,
      identityOwnership: 'workspace-created',
      cognitoIdentityId: 'sub-new-user@example.com',
      cognitoUsername: 'new-user@example.com',
      directoryClaimCleanupRequired: undefined,
      deliveryStatus: 'failed',
      failureMessage: 'Invitation delivery failed.',
    },
  ])
})

test('keeps raced Cognito ownership ambiguous while resending temporary credentials', async () => {
  const calls = configureFakeProjectClients(true, { workspaceProvisionRace: true })

  const response = await app.request('/api/workspace/invitations', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'raced-user@example.com',
      role: 'member',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.workspaceInvitationResends).toEqual(['raced-user@example.com'])
  expect(await response.json()).toMatchObject({
    invitation: {
      deliveryStatus: 'sent',
      email: 'raced-user@example.com',
      identityOwnership: 'ambiguous',
      status: 'pending',
    },
  })
})

test('drops ownership and cleanup provenance when reinvite finds a replacement Cognito identity', async () => {
  const deliveryInputs: Array<Parameters<WorkspaceAccessClient['markInvitationDelivery']>[2]> = []
  const resends: string[] = []
  const preparedInvitation = {
    id: 'replacement@example.com',
    email: 'replacement@example.com',
    role: 'member' as const,
    status: 'provisioning' as const,
    deliveryStatus: 'pending' as const,
    identityOwnership: 'workspace-created' as const,
    cognitoIdentityId: 'sub-original',
    directoryClaimCleanupRequired: true,
    version: 2,
    expiresAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  }

  configureApiClientsForTest({
    cognito: {
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [
            { Name: 'email', Value: 'demo@example.com' },
            { Name: 'custom:directory_id', Value: 'user#demo@example.com' },
            { Name: 'custom:workspace_id', Value: 'user#demo@example.com' },
          ],
        }
      },
      async isSystemAdmin() {
        return false
      },
      async findWorkspaceUser() {
        return {
          profile: {
            id: 'replacement@example.com',
            username: 'CaseSensitiveReplacement',
            email: 'replacement@example.com',
            enabled: true,
            status: 'FORCE_CHANGE_PASSWORD',
          },
          identityId: 'sub-replacement',
          directoryId: 'user#demo@example.com',
        }
      },
      async provisionWorkspaceUser() {
        return {
          profile: {
            id: 'replacement@example.com',
            username: 'CaseSensitiveReplacement',
            email: 'replacement@example.com',
            enabled: true,
            status: 'FORCE_CHANGE_PASSWORD',
          },
          cognitoIdentityId: 'sub-replacement',
          cognitoUsername: 'CaseSensitiveReplacement',
          identityOwnership: 'pre-existing',
          directoryClaimCleanupRequired: false,
          deliveryStatus: 'not-required',
        }
      },
      async resendWorkspaceUserInvitation(username: string) {
        resends.push(username)
      },
    } as unknown as NonNullable<
      Parameters<typeof configureApiClientsForTest>[0]['cognito']
    >,
    workspaceAccess: {
      async getActiveMember(_workspaceId: string, memberKey: string) {
        return {
          id: memberKey,
          memberKey,
          email: memberKey,
          role: 'owner',
          status: 'active',
          version: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async prepareReinvite() {
        return preparedInvitation
      },
      async markInvitationIdentityMutationStarted(
        _workspaceId,
        _invitationId,
        expectedVersion,
        cognitoIdentityId,
        cognitoUsername,
      ) {
        return {
          ...preparedInvitation,
          identityOwnership: 'ambiguous',
          cognitoIdentityId,
          cognitoUsername,
          directoryClaimCleanupRequired: undefined,
          identityMutationAttempted: true,
          version: expectedVersion + 1,
        }
      },
      async markInvitationDelivery(_workspaceId, _invitationId, input) {
        deliveryInputs.push(input)
        return {
          ...preparedInvitation,
          status: 'pending',
          deliveryStatus: input.deliveryStatus,
          identityOwnership: input.identityOwnership,
          cognitoIdentityId: input.cognitoIdentityId,
          cognitoUsername: input.cognitoUsername,
          directoryClaimCleanupRequired: input.directoryClaimCleanupRequired,
          version: input.expectedVersion + 1,
        }
      },
    } as unknown as WorkspaceAccessClient,
  })

  const response = await app.request(
    '/api/workspace/invitations/replacement%40example.com/reinvite',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    },
  )

  expect(response.status).toBe(200)
  expect(resends).toEqual(['CaseSensitiveReplacement'])
  expect(deliveryInputs).toEqual([{
    expectedVersion: 3,
    identityOwnership: 'pre-existing',
    cognitoIdentityId: 'sub-replacement',
    cognitoUsername: 'CaseSensitiveReplacement',
    directoryClaimCleanupRequired: false,
    deliveryStatus: 'sent',
  }])
  expect(await response.json()).toMatchObject({
    invitation: {
      identityOwnership: 'pre-existing',
      cognitoIdentityId: 'sub-replacement',
      cognitoUsername: 'CaseSensitiveReplacement',
      directoryClaimCleanupRequired: false,
    },
  })
})

test('loads dashboard summary from the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/dashboard/summary', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projects: 1,
    tasks: 1,
    blocked: 0,
    updatedAt: '2026-06-03T00:00:00.000Z',
    source: 'dynamodb',
  })
  expect(calls.summaryReads).toEqual([
    {
      directoryId: 'user#demo@example.com',
      isSystemAdmin: false,
      userKey: 'demo@example.com',
    },
  ])
})

test('marks a workspace audit export as truncated when the 1,000 event cap leaves a cursor', async () => {
  configureFakeProjectClients(true)
  const event = createFakeAuditEvent()
  let pageNumber = 0

  configureApiClientsForTest({
    auditEvents: {
      async query(input) {
        pageNumber += 1
        expect(input.limit).toBe(100)

        return {
          events: Array.from({ length: 100 }, () => event),
          nextCursor: `cursor-${pageNumber}`,
        }
      },
    },
  })

  const response = await app.request('/api/audit/events/export', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      Origin: 'http://localhost:5173',
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('Access-Control-Expose-Headers')).toBe(
    'X-Audit-Truncated,X-Audit-Next-Cursor',
  )
  expect(response.headers.get('X-Audit-Truncated')).toBe('true')
  expect(response.headers.get('X-Audit-Next-Cursor')).toBe('cursor-10')
  expect((await response.text()).trimEnd().split('\n')).toHaveLength(1_000)
  expect(pageNumber).toBe(10)
})

test('omits truncation headers when a workspace audit export reaches the final page', async () => {
  configureFakeProjectClients(true)
  const event = createFakeAuditEvent()

  configureApiClientsForTest({
    auditEvents: {
      async query() {
        return { events: [event] }
      },
    },
  })

  const response = await app.request('/api/audit/events/export', {
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('X-Audit-Truncated')).toBeNull()
  expect(response.headers.get('X-Audit-Next-Cursor')).toBeNull()
  expect((await response.text()).trimEnd().split('\n')).toHaveLength(1)
})

test('reads and saves Workspace Work Item configuration through the authenticated scope', async () => {
  configureFakeProjectClients(true)
  const stored = createTestWorkItemConfiguration('workspace', 'user#demo@example.com', 3)
  const reads: string[] = []
  const writes: Array<{ configuration: WorkItemConfiguration; workspaceId: string }> = []
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getWorkspaceConfiguration(workspaceId) {
        reads.push(workspaceId)
        return { configuration: stored }
      },
      async saveWorkspaceConfiguration(workspaceId, configuration, compatibilityCheck) {
        await compatibilityCheck()
        writes.push({ workspaceId, configuration })
        return {
          configuration: {
            ...configuration,
            revision: configuration.revision + 1,
          },
        }
      },
    }),
  })

  const readResponse = await app.request('/api/work-item-configuration', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const writeResponse = await app.request('/api/work-item-configuration', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createTestWorkItemConfiguration('team', 'foreign-team', 3)),
  })

  expect(readResponse.status).toBe(200)
  expect(await readResponse.json()).toEqual({ configuration: stored })
  expect(writeResponse.status).toBe(200)
  expect(await writeResponse.json()).toMatchObject({
    configuration: {
      scopeType: 'workspace',
      scopeId: 'user#demo@example.com',
      revision: 4,
    },
  })
  expect(reads).toEqual(['user#demo@example.com'])
  expect(writes).toEqual([{
    workspaceId: 'user#demo@example.com',
    configuration: expect.objectContaining({
      scopeType: 'workspace',
      scopeId: 'user#demo@example.com',
      revision: 3,
    }),
  }])
})

test('reads and saves Team Work Item configuration for a Team manager', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const stored = createTestWorkItemConfiguration('team', 'core-team', 2)
  const reads: Array<{ teamId: string; workspaceId: string }> = []
  const writes: Array<{
    configuration: WorkItemConfiguration
    teamId: string
    workspaceId: string
  }> = []
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration(workspaceId, teamId) {
        reads.push({ workspaceId, teamId })
        return { configuration: stored }
      },
      async saveTeamConfiguration(workspaceId, teamId, configuration, compatibilityCheck) {
        await compatibilityCheck()
        writes.push({ workspaceId, teamId, configuration })
        return {
          configuration: {
            ...configuration,
            revision: configuration.revision + 1,
          },
        }
      },
    }),
  })

  const readResponse = await app.request('/api/teams/core-team/work-item-configuration', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const writeResponse = await app.request('/api/teams/core-team/work-item-configuration', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createTestWorkItemConfiguration('workspace', 'foreign-workspace', 2)),
  })

  expect(readResponse.status).toBe(200)
  expect(await readResponse.json()).toEqual({ configuration: stored })
  expect(writeResponse.status).toBe(200)
  expect(reads).toEqual([{ workspaceId: 'user#demo@example.com', teamId: 'core-team' }])
  expect(writes).toEqual([{
    workspaceId: 'user#demo@example.com',
    teamId: 'core-team',
    configuration: expect.objectContaining({
      scopeType: 'team',
      scopeId: 'core-team',
      revision: 2,
    }),
  }])
})

test('denies Work Item configuration writes outside the required administration roles', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  let writes = 0
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async saveWorkspaceConfiguration(workspaceId, configuration) {
        writes += 1
        return { configuration: { ...configuration, scopeId: workspaceId } }
      },
      async saveTeamConfiguration(_workspaceId, teamId, configuration, compatibilityCheck) {
        await compatibilityCheck()
        writes += 1
        return { configuration: { ...configuration, scopeId: teamId } }
      },
    }),
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }

  const workspaceResponse = await app.request('/api/work-item-configuration', {
    method: 'PUT',
    headers,
    body: JSON.stringify(createTestWorkItemConfiguration('workspace', 'user#demo@example.com')),
  })
  const teamResponse = await app.request('/api/teams/core-team/work-item-configuration', {
    method: 'PUT',
    headers,
    body: JSON.stringify(createTestWorkItemConfiguration('team', 'core-team')),
  })

  expect(workspaceResponse.status).toBe(403)
  expect(teamResponse.status).toBe(403)
  expect(writes).toBe(0)
})

test('rejects a configuration change that conflicts with an existing Work Item', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  let writes = 0
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async saveTeamConfiguration(_workspaceId, teamId, configuration, compatibilityCheck) {
        await compatibilityCheck()
        writes += 1
        return { configuration: { ...configuration, scopeId: teamId } }
      },
    }),
  })
  const configuration = createTestWorkItemConfiguration('team', 'core-team')
  configuration.customFields = [{
    id: 'required-reviewer',
    name: 'Required reviewer',
    type: 'person',
    sortOrder: 0,
    required: true,
  }]

  const response = await app.request('/api/teams/core-team/work-item-configuration', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(configuration),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    code: 'WorkItemConfigurationInUse',
  })
  expect(writes).toBe(0)
})

test('rejects missing required custom fields before creating a Work Item', async () => {
  const calls = configureFakeProjectClients(true)
  const configuration = createTestWorkItemConfiguration('team', 'core-team')
  configuration.customFields = [{
    id: 'effort',
    name: 'Effort',
    type: 'number',
    sortOrder: 10,
    required: true,
    validation: { min: 1, max: 8 },
  }]
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Missing effort',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
      workflowStatusId: 'todo',
      customFieldValues: {},
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidCustomFieldValue',
    message: 'Custom field "effort" is required.',
  })
  expect(calls.issueCreates).toEqual([])
})

test('uses the configured initial workflow status when create omits legacy status', async () => {
  const calls = configureFakeProjectClients(true)
  const configuration = createTestWorkItemConfiguration('team', 'core-team')
  configuration.workflow.initialStatusId = 'triage'
  configuration.workflow.statuses.unshift({
    id: 'triage',
    name: 'Triage',
    category: 'backlog',
    sortOrder: 5,
  })
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Starts in triage',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/07/20',
      priority: 'medium',
    }),
  })

  expect(response.status).toBe(201)
  expect(calls.issueCreates).toContainEqual(expect.objectContaining({
    statusCategory: 'backlog',
    workflowStatusId: 'triage',
  }))
})

test('rejects a disallowed configured workflow transition before updating a Work Item', async () => {
  const calls = configureFakeProjectClients(true)
  const configuration = createTestWorkItemConfiguration('team', 'core-team')
  configuration.workflow.transitions = configuration.workflow.transitions.filter((transition) =>
    !(transition.fromStatusId === 'in-progress' && transition.toStatusId === 'done')
  )
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workflowStatusId: 'done', expectedRevision: 1 }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkflowTransitionDenied',
    message: 'Transition from "in-progress" to "done" is not allowed.',
  })
  expect(calls.issueUpdates).toEqual([])
})

test('calls reciprocal relation mutations and preserves their stable conflict response', async () => {
  configureFakeProjectClients(true)
  const creates: Array<{ input: unknown; teamId: string; workspaceId: string }> = []
  let deletes = 0
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async createRelation(workspaceId, teamId, input) {
        creates.push({ workspaceId, teamId, input })
        return {
          relation: {
            sourceWorkItemId: input.sourceWorkItemId,
            targetWorkItemId: input.targetWorkItemId,
            type: input.type,
          },
          reciprocalRelation: {
            sourceWorkItemId: input.targetWorkItemId,
            targetWorkItemId: input.sourceWorkItemId,
            type: 'blockedBy',
          },
          graphRevision: input.expectedGraphRevision + 1,
        }
      },
      async deleteRelation() {
        deletes += 1
        throw new WorkItemConfigurationError(
          409,
          'RelationGraphRevisionConflict',
          'Relation graph changed. Reload and try again.',
        )
      },
    }),
  })

  const createResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/relations',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'blocks',
        targetWorkItemId: 'target-issue',
        expectedGraphRevision: 4,
      }),
    },
  )
  const deleteResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/relations/target-issue/blocks',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedGraphRevision: 4 }),
    },
  )

  expect(createResponse.status).toBe(201)
  expect(await createResponse.json()).toMatchObject({
    relation: {
      sourceWorkItemId: 'onboarding-friction',
      targetWorkItemId: 'target-issue',
      type: 'blocks',
    },
    reciprocalRelation: { type: 'blockedBy' },
    graphRevision: 5,
  })
  expect(creates).toEqual([{
    workspaceId: 'user#demo@example.com',
    teamId: 'core-team',
    input: {
      sourceWorkItemId: 'onboarding-friction',
      targetWorkItemId: 'target-issue',
      type: 'blocks',
      expectedGraphRevision: 4,
      sourceExpectedRevision: 1,
      targetExpectedRevision: 1,
      sourceAssignedProjectId: 'refero',
      targetAssignedProjectId: 'refero',
    },
  }])
  expect(deleteResponse.status).toBe(409)
  expect(await deleteResponse.json()).toEqual({
    code: 'RelationGraphRevisionConflict',
    message: 'Relation graph changed. Reload and try again.',
  })
  expect(deletes).toBe(1)
})

test('reprojects both Work Item relation endpoints after relation creation and deletion', async () => {
  const calls = configureFakeProjectClients(true)
  let graphRevision = 4
  let relations: Array<{
    sourceWorkItemId: string
    targetWorkItemId: string
    type: 'blocks' | 'blockedBy'
  }> = []
  const projectedDocuments: Array<ReturnType<typeof createWorkspaceSearchDocument>> = []
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations(_workspaceId, _teamId, workItemId) {
        return {
          graphRevision,
          relations: relations.filter((relation) => relation.sourceWorkItemId === workItemId),
        }
      },
      async createRelation(_workspaceId, _teamId, input) {
        const response = {
          relation: {
            sourceWorkItemId: input.sourceWorkItemId,
            targetWorkItemId: input.targetWorkItemId,
            type: 'blocks' as const,
          },
          reciprocalRelation: {
            sourceWorkItemId: input.targetWorkItemId,
            targetWorkItemId: input.sourceWorkItemId,
            type: 'blockedBy' as const,
          },
          graphRevision: input.expectedGraphRevision + 1,
        }
        relations = [response.relation, response.reciprocalRelation]
        graphRevision = response.graphRevision
        return response
      },
      async deleteRelation(_workspaceId, _teamId, input) {
        const response = {
          relation: relations[0]!,
          reciprocalRelation: relations[1]!,
          graphRevision: input.expectedGraphRevision + 1,
        }
        relations = []
        graphRevision = response.graphRevision
        return response
      },
    }),
    workspaceSearch: {
      async upsertDocument(document) {
        const projected = createWorkspaceSearchDocument(document)
        projectedDocuments.push(projected)
        return projected
      },
    } as unknown as WorkspaceSearchClient,
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }

  const createResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/relations',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'blocks',
        targetWorkItemId: 'target-issue',
        expectedGraphRevision: 4,
      }),
    },
  )
  const deleteResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/relations/target-issue/blocks',
    {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ expectedGraphRevision: 5 }),
    },
  )

  expect([createResponse.status, deleteResponse.status]).toEqual([201, 200])
  expect(projectedDocuments.slice(0, 2)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      entityId: 'team/core-team/issue/onboarding-friction',
      relationIds: ['blocks:target-issue'],
    }),
    expect.objectContaining({
      entityId: 'team/core-team/issue/target-issue',
      relationIds: ['blockedBy:onboarding-friction'],
    }),
  ]))
  expect(projectedDocuments.slice(2)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      entityId: 'team/core-team/issue/onboarding-friction',
      relationIds: [],
    }),
    expect.objectContaining({
      entityId: 'team/core-team/issue/target-issue',
      relationIds: [],
    }),
  ]))
  expect(calls.issueDetails).toHaveLength(8)
  expect([2, 3, 6, 7].map((index) => calls.issueDetails[index]?.readOptions)).toEqual([
    { consistentIssueRead: true, eventLimit: 0 },
    { consistentIssueRead: true, eventLimit: 0 },
    { consistentIssueRead: true, eventLimit: 0 },
    { consistentIssueRead: true, eventLimit: 0 },
  ])
})

test('keeps a relation mutation successful when current relation projection reads fail', async () => {
  configureFakeProjectClients(true)
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations() {
        throw new Error('Relation graph unavailable')
      },
    }),
    workspaceSearch: {
      async upsertDocument(document) {
        return createWorkspaceSearchDocument(document)
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
      '/api/teams/core-team/issues/onboarding-friction/relations',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'blocks',
          targetWorkItemId: 'target-issue',
          expectedGraphRevision: 4,
        }),
      },
    )

    expect(response.status).toBe(201)
    expect(projectionErrors).toBe(2)
  } finally {
    console.error = originalConsoleError
  }
})

test('denies project tasks when the project is outside the user directory', async () => {
  const calls = configureFakeProjectClients(false)

  const response = await app.request('/api/projects/secret/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'secret' },
  ])
  expect(calls.taskReads).toEqual([])
})

test('loads only legacy project tasks after project access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/projects/refero/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.projectId).toBe('refero')
  expect(body.tasks.map((task: { id: string }) => task.id)).toEqual(['wireframe'])
  expect(body.tasks[0]).toMatchObject({
    source: 'legacy',
    titleKey: 'tasks.item.wireframe',
    status: 'in-progress',
  })
  expect(body.tasks[0]).not.toHaveProperty('workflowStatusId')
  expect(body.tasks[0]).not.toHaveProperty('statusCategory')
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.projectIssueReads).toEqual([])
})

test('lists Cognito users for project member assignment when the current user is project manager', async () => {
  const calls = configureFakeProjectClients(true, {
    cognitoUsersNextToken: 'following-page-token',
    role: 'manager',
  })

  const response = await app.request(
    '/api/projects/refero/users?query=sato&limit=1&nextToken=next-page-token',
    {
      headers: {
        Authorization: 'Bearer test-token',
      },
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    users: [
      {
        id: 'sato@example.com',
        username: 'sato@example.com',
        email: 'sato@example.com',
        name: '佐藤 花子',
        enabled: true,
        status: 'CONFIRMED',
        workspaceStatus: 'active',
      },
    ],
    nextToken: 'following-page-token',
  })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.userLists).toEqual([{
    directoryId: 'user#demo@example.com',
    limit: 1,
    paginationToken: 'next-page-token',
    query: 'sato',
  }])
  expect(calls.userProfiles).toEqual([])
})

test('continues Cognito pagination until an active Workspace assignment candidate is found', async () => {
  const calls = configureFakeProjectClients(true, {
    cognitoUserPages: [
      { userIds: ['inactive@example.com'], nextToken: 'active-page' },
      { userIds: ['sato@example.com'], nextToken: 'following-page' },
    ],
    role: 'manager',
  })

  const response = await app.request('/api/projects/refero/users?limit=1', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    users: [{ id: 'sato@example.com', workspaceStatus: 'active' }],
    nextToken: 'following-page',
  })
  expect(calls.userLists).toEqual([
    {
      directoryId: 'user#demo@example.com',
      limit: 1,
      paginationToken: undefined,
      query: undefined,
    },
    {
      directoryId: 'user#demo@example.com',
      limit: 1,
      paginationToken: 'active-page',
      query: undefined,
    },
  ])
})

test('keeps project members available when Cognito profile hydration fails', async () => {
  const calls = configureFakeProjectClients(true, {
    profileError: new Error('Cognito profile hydration failed.'),
  })

  const response = await app.request('/api/projects/refero/members', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    projectId: 'refero',
    members: [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
        workspaceStatus: 'active',
      },
    ],
  })
  expect(calls.userProfiles).toEqual(['demo@example.com'])
})

test('keeps project tasks available when Cognito assignee hydration fails', async () => {
  const calls = configureFakeProjectClients(true, {
    profileError: new Error('Cognito profile hydration failed.'),
    taskAssigneeUserId: 'sato@example.com',
  })

  const response = await app.request('/api/projects/refero/tasks', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.tasks.map((task: { id: string }) => task.id)).toEqual(['wireframe'])
  expect(body.tasks[0]).toMatchObject({
    id: 'wireframe',
    assigneeUserId: 'sato@example.com',
    source: 'legacy',
  })
  expect(calls.userProfiles).toEqual(['sato@example.com'])
})

test('creates a team in the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規チーム',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    team: {
      id: 'new-team',
      name: '新規チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(calls.teamCreates).toEqual([
    { directoryId: 'user#demo@example.com', name: '新規チーム' },
  ])
})

test('creates a project under an authenticated team directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
      tone: 'green',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    project: {
      id: 'new-project',
      name: '新規プロジェクト',
      tone: 'green',
    },
  })
  expect(calls.projectCreates).toEqual([
    {
      creatorUserKey: 'demo@example.com',
      directoryId: 'user#demo@example.com',
      name: '新規プロジェクト',
      teamId: 'core-team',
    },
  ])
})

test('returns conflict when project creation transaction is canceled', async () => {
  configureFakeProjectClients(true)
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      if (command.constructor.name === 'GetCommand') {
        return {
          Item: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
            entryType: 'workspace-member',
            memberKey: 'demo@example.com',
            role: 'owner',
            status: 'active',
            version: 1,
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ message: 'The same item already exists.' })
})

test('returns bad gateway when project creation transaction has no cancellation reasons', async () => {
  configureFakeProjectClients(true)
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '新規プロジェクト' }),
  })

  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ message: 'Project data is unavailable.' })
})

test('returns service unavailable when project creation transaction table is missing', async () => {
  configureFakeProjectClients(true)
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('missing table')
        error.name = 'ResourceNotFoundException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '新規プロジェクト' }),
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ message: 'Project data is not initialized.' })
})

test('returns not found when project creation transaction loses its active team', async () => {
  configureFakeProjectClients(true)
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
              ...(queryReads >= 2 ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
            },
          ],
        }
      }

      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient

  configureApiClientsForTest({
    projectDirectory: new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient),
  })

  const response = await app.request('/api/teams/core-team/projects', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: '新規プロジェクト',
    }),
  })

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ message: 'Team was not found.' })
})

test('archives a team in the authenticated user scoped directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teamId: 'core-team',
    archivedAt: '2026-06-06T00:00:00.000Z',
  })
  expect(calls.teamArchives).toEqual([
    { directoryId: 'user#demo@example.com', expectedPlanningRevision: 0, teamId: 'core-team' },
  ])
})

test('rejects archiving a Team referenced by an active Planning entity', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create(
    'user#demo@example.com',
    createCyclePlanningInput('cycle-team-scope', 0),
    { workItems: [] },
  )
  const calls = configureFakeProjectClients(true)
  configureApiClientsForTest({ planning: planningClient })

  const response = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    message:
      'Move or archive active Planning entities and remove Work Item links before archiving this Team.',
  })
  expect(calls.teamArchives).toEqual([])
})

test('denies project-assigned Work Item creation when the project role is viewer', async () => {
  const calls = configureFakeProjectClients(true, { role: 'viewer' })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規タスク',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'high',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: '*' },
  ])
  expect(calls.issueCreates).toEqual([])
})

test('denies project member reads when the project role is viewer', async () => {
  const calls = configureFakeProjectClients(true, { role: 'viewer' })

  const response = await app.request('/api/projects/refero/members', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Project access is denied.' })
  expect(calls.accessChecks).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.memberReads).toEqual([])
})

test('updates a project member role when the current user is project manager', async () => {
  const calls = configureFakeProjectClients(true, { role: 'manager' })

  const response = await app.request('/api/projects/refero/members/sato%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    member: {
      id: 'sato@example.com',
      email: 'sato@example.com',
      username: 'sato@example.com',
      name: '佐藤 花子',
      enabled: true,
      status: 'CONFIRMED',
      role: 'member',
      updatedAt: '2026-06-08T00:00:00.000Z',
      workspaceStatus: 'active',
    },
  })
  expect(calls.memberUpdates).toEqual([
    {
      directoryId: 'user#demo@example.com',
      memberKey: 'sato@example.com',
      projectId: 'refero',
      role: 'member',
    },
  ])
  expect(calls.userProfiles).toEqual(['sato@example.com', 'sato@example.com'])
})

test('lets a system admin update project members without a project role', async () => {
  const calls = configureFakeProjectClients(false, { role: undefined })

  const response = await app.request('/api/projects/refero/members/viewer%40example.com', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${createAccessToken(['mukuroji-system-admins'])}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'viewer@example.com',
      role: 'viewer',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    member: {
      id: 'viewer@example.com',
      email: 'viewer@example.com',
      username: 'viewer@example.com',
      name: 'Viewer User',
      enabled: true,
      status: 'CONFIRMED',
      role: 'viewer',
      updatedAt: '2026-06-08T00:00:00.000Z',
      workspaceStatus: 'active',
    },
  })
  expect(calls.roleChecks).toEqual([])
  expect(calls.accessChecks).toEqual([])
  expect(calls.memberUpdates).toEqual([
    {
      directoryId: 'user#demo@example.com',
      memberKey: 'viewer@example.com',
      projectId: 'refero',
      role: 'viewer',
    },
  ])
  expect(calls.userProfiles).toEqual(['viewer@example.com', 'viewer@example.com'])
})

test('archives a project under an authenticated team directory', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: '2026-06-06T00:00:00.000Z',
  })
  expect(calls.projectArchives).toEqual([
    {
      directoryId: 'user#demo@example.com',
      expectedPlanningRevision: 0,
      teamId: 'core-team',
      projectId: 'refero',
    },
  ])
})

test('does not block archive for a same-named Project scoped to another Team', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create(
    'user#demo@example.com',
    {
      ...createCyclePlanningInput('cycle-other-team-project', 0),
      teamId: 'other-team',
      projectId: 'refero',
    },
    { workItems: [] },
  )
  const calls = configureFakeProjectClients(true)
  configureApiClientsForTest({ planning: planningClient })

  const projectResponse = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })
  const teamResponse = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(projectResponse.status).toBe(200)
  expect(teamResponse.status).toBe(200)
  expect(calls.projectArchives).toEqual([
    {
      directoryId: 'user#demo@example.com',
      expectedPlanningRevision: 1,
      teamId: 'core-team',
      projectId: 'refero',
    },
  ])
  expect(calls.teamArchives).toEqual([
    { directoryId: 'user#demo@example.com', expectedPlanningRevision: 1, teamId: 'core-team' },
  ])
})

test('rejects archiving a Project referenced by an active Planning entity', async () => {
  const planningClient = new InMemoryPlanningClient()
  await planningClient.create(
    'user#demo@example.com',
    createCyclePlanningInput('cycle-project-scope', 0),
    { workItems: [] },
  )
  const calls = configureFakeProjectClients(true)
  configureApiClientsForTest({ planning: planningClient })

  const response = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    message:
      'Move or archive active Planning entities and remove Work Item links before archiving this Project.',
  })
  expect(calls.projectArchives).toEqual([])
})

test('rejects archiving scopes referenced only by a stored Planning Work Item link', async () => {
  const planningClient = new InMemoryPlanningClient()
  const workItemState = {
    workItems: [{
      id: 'linked-work-item',
      revision: 1,
      teamId: 'core-team',
      title: 'Linked Work Item',
      projectId: 'refero',
      statusCategory: 'completed' as const,
      dueDate: '2026-08-31',
    }],
  }
  await planningClient.create(
    'user#demo@example.com',
    createCyclePlanningInput('cycle-link-scope', 0),
    workItemState,
  )
  await planningClient.putWorkItemLink('user#demo@example.com', {
    teamId: 'core-team',
    workItemId: 'linked-work-item',
    projectId: 'refero',
    cycleId: 'cycle-link-scope',
    goalIds: [],
    expectedRevision: 1,
  }, workItemState)
  await planningClient.archive(
    'user#demo@example.com',
    'cycle-link-scope',
    { expectedRevision: 2 },
    workItemState,
  )
  const calls = configureFakeProjectClients(true)
  configureApiClientsForTest({ planning: planningClient })

  const teamResponse = await app.request('/api/teams/core-team/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })
  const projectResponse = await app.request('/api/teams/core-team/projects/refero/archive', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(teamResponse.status).toBe(409)
  expect(projectResponse.status).toBe(409)
  expect(calls.teamArchives).toEqual([])
  expect(calls.projectArchives).toEqual([])
})

test('DynamoDB directory client validates and ignores workspace bootstrap rows for reads and writes', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            ...createWorkspaceBootstrapItems(),
            {
              directoryId: 'workspace#production',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'workspace#production',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'workspace#production',
              entryKey: 'PROJECT_MEMBER#refero#owner@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'owner@example.com',
              email: 'owner@example.com',
              role: 'manager',
              createdAt: '2026-07-11T00:00:00.000Z',
              updatedAt: '2026-07-11T00:00:00.000Z',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getProjectDirectory('workspace#production', 'en')).resolves.toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'Core Team',
        expanded: true,
        projects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
      },
    ],
  })
  await expect(client.createTeam('workspace#production', { name: 'New Team' })).resolves.toEqual({
    team: {
      id: 'new-team',
      name: 'New Team',
      expanded: true,
      projects: [],
    },
  })
  expect(sentInputs[2]).toMatchObject({
    Item: {
      directoryId: 'workspace#production',
      entryType: 'team',
      teamId: 'new-team',
    },
  })
})

test('DynamoDB directory client rejects malformed workspace bootstrap rows', async () => {
  const documentClient = {
    async send() {
      return {
        Items: [
          {
            directoryId: 'workspace#production',
            entryKey: 'WORKSPACE#METADATA',
            entryType: 'workspace-metadata',
            workspaceId: 'workspace#other',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.getProjectDirectory('workspace#production', 'en')).rejects.toMatchObject({
    status: 503,
    code: 'InvalidProjectDirectory',
  })
})

test('DynamoDB directory client creates duplicate named teams with a unique id suffix', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#新規チーム',
              entryType: 'team',
              teamId: '新規チーム',
              teamSortOrder: 10,
              nameJa: '新規チーム',
              nameEn: 'New Team',
              expanded: true,
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(client.createTeam('user#demo@example.com', { name: '新規チーム' })).resolves.toEqual({
    team: {
      id: '新規チーム-2',
      name: '新規チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(sentInputs[1]).toMatchObject({
    TableName: 'DirectoryTable',
    Item: {
      directoryId: 'user#demo@example.com',
      teamId: '新規チーム-2',
      teamSortOrder: 20,
      entryKey: '000020#000000#TEAM#新規チーム-2',
    },
    ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
  })
})

test('DynamoDB directory client creates duplicate named projects with a unique id suffix', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#新規プロジェクト',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: '新規プロジェクト',
              projectSortOrder: 10,
              nameJa: '新規プロジェクト',
              nameEn: 'New Project',
              tone: 'blue',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(
    client.createProject(
      'user#demo@example.com',
      'core-team',
      {
        name: '新規プロジェクト',
        tone: 'green',
      },
      { userKey: 'demo@example.com', workspaceMemberVersion: 1 },
    ),
  ).resolves.toEqual({
    project: {
      id: '新規プロジェクト-2',
      name: '新規プロジェクト',
      tone: 'green',
    },
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
          },
          ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
        },
      },
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId: 'user#demo@example.com',
            teamId: 'core-team',
            projectId: '新規プロジェクト-2',
            projectSortOrder: 20,
            entryKey: '000010#000020#PROJECT#新規プロジェクト-2',
          },
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        },
      },
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#新規プロジェクト-2#demo@example.com',
            entryType: 'project-member',
            projectId: '新規プロジェクト-2',
            memberKey: 'demo@example.com',
            email: 'demo@example.com',
            role: 'manager',
          },
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        },
      },
      {
        Update: {
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
          },
          UpdateExpression: 'SET updatedAt = :updatedAt ADD #version :one',
          ConditionExpression:
            '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
          ExpressionAttributeNames: {
            '#entryType': 'entryType',
            '#status': 'status',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':memberEntryType': 'workspace-member',
            ':active': 'active',
            ':expectedVersion': 1,
            ':one': 1,
          },
        },
      },
    ],
  })
})

test('DynamoDB directory client initializes a missing local table before creating a team', async () => {
  const documentInputs: Array<Record<string, unknown>> = []
  const rawInputs: Array<Record<string, unknown>> = []
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      documentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1

        if (queryAttempts === 1) {
          const error = new Error('missing table')
          error.name = 'ResourceNotFoundException'
          throw error
        }

        return { Items: [] }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      rawInputs.push({
        ...command.input,
        commandName: command.constructor.name,
      })

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            KeySchema: [
              { AttributeName: 'directoryId', KeyType: 'HASH' },
              { AttributeName: 'entryKey', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectDirectoryClient(
    'MissingDirectoryTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(client.createTeam('user#demo@example.com', { name: '復旧チーム' })).resolves.toEqual({
    team: {
      id: '復旧チーム',
      name: '復旧チーム',
      expanded: true,
      projects: [],
    },
  })
  expect(rawInputs).toEqual([
    expect.objectContaining({
      commandName: 'CreateTableCommand',
      TableName: 'MissingDirectoryTable',
      KeySchema: [
        { AttributeName: 'directoryId', KeyType: 'HASH' },
        { AttributeName: 'entryKey', KeyType: 'RANGE' },
      ],
    }),
    expect.objectContaining({
      commandName: 'DescribeTableCommand',
      TableName: 'MissingDirectoryTable',
    }),
  ])
  expect(documentInputs.at(-1)).toMatchObject({
    TableName: 'MissingDirectoryTable',
    Item: {
      directoryId: 'user#demo@example.com',
      teamId: '復旧チーム',
    },
  })
})

test('DynamoDB task client initializes a missing local table before reading tasks', async () => {
  const rawInputs: Array<Record<string, unknown>> = []
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1

        if (queryAttempts === 1) {
          const error = new Error('missing table')
          error.name = 'ResourceNotFoundException'
          throw error
        }

        return { Items: [] }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      rawInputs.push({
        ...command.input,
        commandName: command.constructor.name,
      })

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            GlobalSecondaryIndexes: [
              {
                IndexName: 'ProjectSortOrderIndex',
                KeySchema: [
                  { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
                  { AttributeName: 'sortOrder', KeyType: 'RANGE' },
                ],
              },
            ],
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'taskId', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectTasksClient(
    'MissingTasksTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(client.getProjectTasks('user#demo@example.com', 'new-project')).resolves.toEqual({
    projectId: 'new-project',
    tasks: [],
  })
  expect(rawInputs).toEqual([
    expect.objectContaining({
      commandName: 'CreateTableCommand',
      TableName: 'MissingTasksTable',
      KeySchema: [
        { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
        { AttributeName: 'taskId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        expect.objectContaining({
          IndexName: 'ProjectSortOrderIndex',
        }),
      ],
    }),
    expect.objectContaining({
      commandName: 'DescribeTableCommand',
      TableName: 'MissingTasksTable',
    }),
  ])
})

test('DynamoDB task client fails fast when a local table exists with the wrong schema', async () => {
  let queryAttempts = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        queryAttempts += 1
        const error = new Error('missing index')
        error.name = 'ResourceNotFoundException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const dynamoDbClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'CreateTableCommand') {
        const error = new Error('table exists')
        error.name = 'ResourceInUseException'
        throw error
      }

      if (command.constructor.name === 'DescribeTableCommand') {
        return {
          Table: {
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'taskId', KeyType: 'RANGE' },
            ],
            TableStatus: 'ACTIVE',
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBClient
  const client = new DynamoDbProjectTasksClient(
    'BrokenTasksTable',
    documentClient,
    dynamoDbClient,
    true,
  )

  await expect(
    client.getProjectTasks('user#demo@example.com', 'broken-project'),
  ).rejects.toThrow('does not match the expected schema')
  expect(queryAttempts).toBe(1)
})

test('does not expose legacy project task mutation routes', async () => {
  const calls = configureFakeProjectClients(true)
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }

  const [createResponse, updateResponse] = await Promise.all([
    app.request('/api/projects/refero/tasks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: '新規タスク' }),
    }),
    app.request('/api/projects/refero/tasks/wireframe', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'done' }),
    }),
  ])

  expect(createResponse.status).toBe(404)
  expect(updateResponse.status).toBe(404)
  expect(calls.accessChecks).toEqual([])
  expect(calls.issueCreates).toEqual([])
  expect(calls.issueUpdates).toEqual([])
  expect(calls.taskReads).toEqual([])
})

test('loads only canonical team-owned Work Items after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/teams/core-team/issues', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.teamId).toBe('core-team')
  expect(body.issues).toEqual([
    expect.objectContaining({
      id: 'onboarding-friction',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      title: '初回オンボーディングの離脱要因を減らす',
      assigneeEmail: 'sato@example.com',
    }),
  ])
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', teamId: 'core-team' },
  ])
  expect(calls.taskReads).toEqual([])
})

test('loads all accessible canonical Work Items including unassigned items', async () => {
  const calls = configureFakeProjectClients(true, {
    taskAssigneeUserId: 'sato@example.com',
    unassignedIssue: true,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.map((workItem: { id: string }) => workItem.id)).toEqual([
    'onboarding-friction',
  ])
  expect(body.workItems[0]).toMatchObject({
    schemaVersion: 1,
    revision: 1,
    teamId: 'core-team',
    source: 'dynamodb',
  })
  expect(body.workItems[0].assignedProjectId).toBeUndefined()
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
  expect(calls.taskReads).toEqual([])
  expect(calls.projectIssueReads).toEqual([])
})

test('rejects an oversized Work Item aggregate instead of returning a silent partial response', async () => {
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 201,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({
    code: 'WorkItemListLimitExceeded',
    message:
      'Workspace has more than 200 accessible Work Items. ' +
      'Refine the Workspace before loading the aggregate Work Item list.',
  })
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
})

test('rejects Work Item aggregate Team fan-out beyond the hard cap before item reads', async () => {
  const additionalTeams = Array.from({ length: 24 }, (_, teamIndex) => ({
    id: `team-${teamIndex}`,
    name: `Team ${teamIndex}`,
    projects: Array.from({ length: 6 }, (_, projectIndex) => ({
      id: `project-${teamIndex}-${projectIndex}`,
      name: `Project ${teamIndex}-${projectIndex}`,
      tone: 'blue' as const,
    })),
  }))
  const calls = configureFakeProjectClients(true, {
    additionalTeams,
    projectAccesses: [
      { projectId: 'refero', role: 'manager' },
      ...additionalTeams.flatMap((team) =>
        team.projects.map((project) => ({ projectId: project.id, role: 'manager' as const }))
      ),
    ],
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'WorkItemListLimitExceeded' })
  expect(calls.issueReads).toEqual([])
  expect(calls.taskReads).toEqual([])
  expect(calls.projectIssueReads).toEqual([])
})

test('filters canonical Work Items for authorization before enforcing the response limit', async () => {
  const calls = configureFakeProjectClients(true, {
    inaccessibleTeamIssueCount: 200,
    teamIssueCount: 201,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.workItems.map((workItem: { id: string }) => workItem.id)).toEqual([
    'work-item-200',
  ])
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
})

test('rejects a canonical partition that exceeds the bounded Work Item scan budget', async () => {
  const calls = configureFakeProjectClients(true, {
    inaccessibleTeamIssueCount: 1001,
    teamIssueCount: 1001,
  })

  const response = await app.request('/api/work-items', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ code: 'WorkItemListLimitExceeded' })
  expect(calls.issueReads).toEqual([
    { directoryId: 'user#demo@example.com', limit: 1001, teamId: 'core-team' },
  ])
  expect(calls.taskReads).toEqual([])
  expect(calls.projectIssueReads).toEqual([])
})

test('keeps shared-project legacy rows isolated to the read-only task adapter', async () => {
  const calls = configureFakeProjectClients(true, {
    additionalTeams: [{
      id: 'design-team',
      name: 'デザインチーム',
      projects: [{ id: 'refero', name: 'Refero', tone: 'purple' }],
    }],
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })
  const headers = { Authorization: 'Bearer test-token' }

  const projectResponse = await app.request('/api/projects/refero/tasks', { headers })
  const teamResponse = await app.request('/api/teams/core-team/issues', { headers })
  const detailResponse = await app.request('/api/teams/core-team/issues/wireframe', { headers })
  const aggregateResponse = await app.request('/api/work-items', { headers })

  expect(projectResponse.status).toBe(200)
  expect(teamResponse.status).toBe(200)
  expect(detailResponse.status).toBe(404)
  expect(aggregateResponse.status).toBe(200)
  expect((await projectResponse.json()).tasks).toEqual([
    expect.objectContaining({ id: 'wireframe', source: 'legacy' }),
  ])
  expect((await teamResponse.json()).issues).toEqual([
    expect.objectContaining({ id: 'onboarding-friction', source: 'dynamodb' }),
  ])
  expect((await aggregateResponse.json()).workItems)
    .not.toContainEqual(expect.objectContaining({ id: 'wireframe' }))
  expect(calls.taskReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
})

test('creates a team-owned issue after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '新規 Issue',
      description: 'Issue の説明',
      assignedProjectId: 'refero',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'medium',
      workflowStatusId: 'todo',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    issue: {
      schemaVersion: 1,
      revision: 1,
      id: 'new-issue',
      teamId: 'core-team',
      assignedProjectId: 'refero',
      title: '新規 Issue',
      description: 'Issue の説明',
      assigneeUserId: 'sato@example.com',
      creatorMemberKey: 'demo@example.com',
      assigneeEmail: 'sato@example.com',
      assigneeName: '佐藤 花子',
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      relationIds: [],
      dueDate: '2026/06/20',
      priority: 'medium',
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
      source: 'dynamodb',
    },
  })
  expect(calls.issueCreates).toEqual([
    {
      actorUserId: 'demo@example.com',
      assignedProjectId: 'refero',
      directoryId: 'user#demo@example.com',
      statusCategory: 'unstarted',
      teamId: 'core-team',
      title: '新規 Issue',
      workflowStatusId: 'todo',
    },
  ])
})

test('rejects a team issue assignment to a project outside the owning team', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '不正な割り当て',
      assignedProjectId: 'unknown-project',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'medium',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(400)
  expect(calls.issueCreates).toEqual([])
})

test('rejects a team issue assignment when the user lacks target project member role', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [
      {
        projectId: 'refero',
        role: 'member',
      },
    ],
    teamProjects: [
      {
        id: 'refero',
        name: 'Refero',
        tone: 'blue',
      },
      {
        id: 'product-roadmap',
        name: 'プロダクトロードマップ',
        tone: 'yellow',
      },
    ],
  })

  const response = await app.request('/api/teams/core-team/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '権限外プロジェクトへの割り当て',
      assignedProjectId: 'product-roadmap',
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/20',
      priority: 'medium',
      status: 'todo',
    }),
  })

  expect(response.status).toBe(403)
  expect(calls.issueCreates).toEqual([])
})

test('loads team issue detail and creates comments after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)
  const collaborationCreates: Parameters<CollaborationClient['createComment']>[0][] = []
  const collaborationComments: Awaited<ReturnType<CollaborationClient['createComment']>>[] = []
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async getThread() {
        return {
          comments: collaborationComments,
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
        }
      },
      async createComment(input) {
        collaborationCreates.push(input)
        const comment = {
          id: 'comment-2',
          rootCommentId: 'comment-2',
          authorMemberKey: input.actorMemberKey,
          bodyMarkdown: input.bodyMarkdown,
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T02:00:00.000Z',
          updatedAt: '2026-06-08T02:00:00.000Z',
          reactions: [],
        }
        collaborationComments.push(comment)
        return comment
      },
    }),
  })

  const detailResponse = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(detailResponse.status).toBe(200)
  expect(await detailResponse.json()).toMatchObject({
    issue: {
      id: 'onboarding-friction',
      assigneeEmail: 'sato@example.com',
    },
    comments: [
      {
        id: 'comment-1',
        body: '背景を確認します。',
      },
    ],
    activity: [
      {
        id: 'activity-1',
        type: 'created',
      },
    ],
  })

  const commentResponse = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      body: '追加コメント',
    }),
  })

  expect(commentResponse.status).toBe(201)
  expect(await commentResponse.json()).toEqual({
    comment: {
      id: 'comment-2',
      actorUserId: 'demo@example.com',
      body: '追加コメント',
      createdAt: '2026-06-08T02:00:00.000Z',
    },
    activity: {
      id: 'comment-2',
      type: 'commented',
      actorUserId: 'demo@example.com',
      summary: 'Comment was added.',
      createdAt: '2026-06-08T02:00:00.000Z',
    },
  })
  expect(calls.issueDetails).toEqual([
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
      readOptions: { consistentIssueRead: true },
    },
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
      readOptions: { consistentIssueRead: true, eventLimit: 0 },
    },
  ])
  expect(calls.issueComments).toEqual([])
  expect(collaborationCreates).toHaveLength(1)
  expect(collaborationCreates[0]).toMatchObject({
    actorMemberKey: 'demo@example.com',
    bodyMarkdown: '追加コメント',
    entityKey: 'user#demo@example.com#work-item#team/core-team/issue/onboarding-friction',
  })

  const refreshedDetailResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(refreshedDetailResponse.status).toBe(200)
  expect(await refreshedDetailResponse.json()).toMatchObject({
    comments: [
      { id: 'comment-1', body: '背景を確認します。' },
      { id: 'comment-2', body: '追加コメント' },
    ],
  })
})

test('omits relations whose target Project is outside the viewer access scope', async () => {
  const calls = configureFakeProjectClients(true, {
    detailAssignedProjectIds: { 'onboarding-friction': 'private-project' },
    projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
  })
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations() {
        return {
          graphRevision: 2,
          relations: [{
            sourceWorkItemId: 'work-item-1',
            targetWorkItemId: 'onboarding-friction',
            type: 'related',
            createdAt: '2026-07-14T00:00:00.000Z',
          }, {
            sourceWorkItemId: 'work-item-1',
            targetWorkItemId: 'onboarding-friction',
            type: 'blocks',
            createdAt: '2026-07-14T00:01:00.000Z',
          }],
        }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/work-item-1', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    relations: [],
    relationGraphRevision: 2,
  })
  expect(calls.issueReads).toEqual([])
  expect(calls.issueDetails).toEqual([
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'work-item-1',
      readOptions: { consistentIssueRead: true },
    },
    {
      directoryId: 'user#demo@example.com',
      teamId: 'core-team',
      issueId: 'onboarding-friction',
      readOptions: { consistentIssueRead: true, eventLimit: 0 },
    },
  ])
})

test('loads deduplicated relation targets with bounded concurrency and preserves relation order', async () => {
  const targetWorkItemIds = Array.from({ length: 12 }, (_, index) => `target-${index}`)
  const relations = [
    ...targetWorkItemIds.map((targetWorkItemId, index) => ({
      sourceWorkItemId: 'source-work-item',
      targetWorkItemId,
      type: 'related' as const,
      createdAt: `2026-07-14T00:${String(index).padStart(2, '0')}:00.000Z`,
    })),
    {
      sourceWorkItemId: 'source-work-item',
      targetWorkItemId: targetWorkItemIds[0] as string,
      type: 'blocks' as const,
      createdAt: '2026-07-14T01:00:00.000Z',
    },
  ]
  let activeTargetReads = 0
  let maximumActiveTargetReads = 0
  const calls = configureFakeProjectClients(true, {
    async detailReadHook(issueId) {
      if (!issueId.startsWith('target-')) return
      activeTargetReads += 1
      maximumActiveTargetReads = Math.max(maximumActiveTargetReads, activeTargetReads)
      await Promise.resolve()
      activeTargetReads -= 1
    },
  })
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations() {
        return { graphRevision: 4, relations }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/source-work-item', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const body = await response.json() as { relations: Array<{ targetWorkItemId: string }> }

  expect(response.status).toBe(200)
  expect(maximumActiveTargetReads).toBe(8)
  expect(calls.issueReads).toEqual([])
  expect(
    calls.issueDetails
      .filter(({ issueId }) => issueId.startsWith('target-'))
      .map(({ issueId }) => issueId),
  ).toEqual(targetWorkItemIds)
  expect(body.relations.map(({ targetWorkItemId }) => targetWorkItemId)).toEqual(
    relations.map(({ targetWorkItemId }) => targetWorkItemId),
  )
})

test('fails closed when a persisted relation target Work Item is missing', async () => {
  const calls = configureFakeProjectClients(true, {
    detailMissingIssueIds: ['missing-target'],
  })
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations() {
        return {
          graphRevision: 3,
          relations: [{
            sourceWorkItemId: 'work-item-1',
            targetWorkItemId: 'missing-target',
            type: 'related',
            createdAt: '2026-07-14T00:00:00.000Z',
          }],
        }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/work-item-1', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    code: 'WorkItemRelationInconsistent',
    message: 'A relation target Work Item is missing.',
  })
  expect(calls.issueReads).toEqual([])
  expect(calls.issueDetails.map(({ issueId, readOptions }) => ({ issueId, readOptions }))).toEqual([
    {
      issueId: 'work-item-1',
      readOptions: { consistentIssueRead: true },
    },
    {
      issueId: 'missing-target',
      readOptions: { consistentIssueRead: true, eventLimit: 0 },
    },
  ])
})

test('returns persisted collaboration comments together with inert legacy comments and reply cursors', async () => {
  const calls = configureFakeProjectClients(true)
  const threadInputs: Parameters<CollaborationClient['getThread']>[0][] = []
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async getThread(input) {
        threadInputs.push(input)
        const pageBase = {
          watch: {
            subscribed: true,
            explicit: true,
            automatic: false,
            reasons: ['manual'],
            watcherCount: 2,
          },
          presence: [],
        }
        if (input.rootCommentId) {
          return {
            ...pageBase,
            comments: [{
              id: 'stored-reply',
              rootCommentId: input.rootCommentId,
              parentCommentId: input.rootCommentId,
              authorMemberKey: 'sato@example.com',
              bodyMarkdown: 'Persisted reply',
              version: 1,
              mentionMemberKeys: [],
              createdAt: '2026-07-12T00:01:00.000Z',
              updatedAt: '2026-07-12T00:01:00.000Z',
              reactions: [],
            }],
            nextCursor: 'older-replies',
          }
        }
        return {
          ...pageBase,
          comments: [{
            id: 'stored-root',
            rootCommentId: 'stored-root',
            authorMemberKey: 'demo@example.com',
            bodyMarkdown: 'Persisted root',
            version: 2,
            mentionMemberKeys: [],
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:30.000Z',
            editedAt: '2026-07-12T00:00:30.000Z',
            reactions: [],
          }],
        }
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/collaboration', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    comments: [
      { id: 'stored-root', source: 'collaboration' },
      { id: 'stored-reply', source: 'collaboration' },
      {
        id: 'comment-1',
        source: 'legacy',
        capabilities: { canReply: false, canReact: false },
      },
    ],
    replyNextCursors: { 'stored-root': 'older-replies' },
  })
  expect(threadInputs).toHaveLength(2)
  expect(threadInputs[0]?.rootCommentId).toBeUndefined()
  expect(threadInputs[0]?.limit).toBe(10)
  expect(threadInputs[1]).toMatchObject({
    rootCommentId: 'stored-root',
    limit: 5,
    includeScopeState: false,
  })
  expect(calls.issueDetails).toContainEqual({
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    readOptions: {
      consistentIssueRead: true,
      eventLimit: 50,
      newestEventsFirst: true,
      eventType: 'commented',
    },
  })
})

test('keeps a departed author in history while blocking deactivated member mutations', async () => {
  configureFakeProjectClients(true, {
    inactiveWorkspaceMemberKeys: ['departed@example.com'],
  })
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async getThread(input) {
        return {
          comments: input.rootCommentId
            ? []
            : [{
                id: 'departed-comment',
                rootCommentId: 'departed-comment',
                authorMemberKey: 'departed@example.com',
                bodyMarkdown: 'This decision remains in history.',
                version: 1,
                mentionMemberKeys: [],
                createdAt: '2026-07-12T00:00:00.000Z',
                updatedAt: '2026-07-12T00:00:00.000Z',
                reactions: [],
              }],
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
        }
      },
      async getCommentSnapshot(input) {
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: 'Search body',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-06-08T01:00:00.000Z',
          reactions: [],
        }
      },
    }),
  })

  const historyResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/collaboration',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(historyResponse.status).toBe(200)
  const history = await historyResponse.json() as { comments: unknown[] }
  expect(history.comments).toContainEqual(expect.objectContaining({
    id: 'departed-comment',
    authorMemberKey: 'departed@example.com',
    bodyMarkdown: 'This decision remains in history.',
  }))

  configureFakeProjectClients(true, { workspaceStatus: 'deactivated' })
  let mutationCalls = 0
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async updateComment() {
        mutationCalls += 1
        throw new Error('A deactivated member must not reach the collaboration store.')
      },
    }),
  })
  const mutationResponse = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/departed-comment',
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bodyMarkdown: 'Changed', expectedVersion: 1 }),
    },
  )

  expect(mutationResponse.status).toBe(403)
  expect(mutationCalls).toBe(0)
})

test('marks roots and replies in a resolved thread as non-replyable', async () => {
  configureFakeProjectClients(true)
  const root = {
    id: 'resolved-root',
    rootCommentId: 'resolved-root',
    authorMemberKey: 'demo@example.com',
    bodyMarkdown: 'Resolved decision',
    version: 2,
    mentionMemberKeys: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:01:00.000Z',
    resolvedAt: '2026-07-12T00:01:00.000Z',
    reactions: [],
  }
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async getThread(input) {
        return {
          comments: input.rootCommentId
            ? [{
                ...root,
                id: 'resolved-reply',
                parentCommentId: root.id,
                resolvedAt: undefined,
              }]
            : [root],
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
          ...(input.rootCommentId ? { threadResolved: true } : {}),
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/collaboration',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(response.status).toBe(200)
  const body = await response.json() as {
    comments: Array<{ id: string; capabilities: { canReply: boolean } }>
  }
  expect(body.comments.find((comment) => comment.id === 'resolved-root')?.capabilities.canReply)
    .toBe(false)
  expect(body.comments.find((comment) => comment.id === 'resolved-reply')?.capabilities.canReply)
    .toBe(false)
})

test('denies collaboration reads without Work Item viewer access', async () => {
  configureFakeProjectClients(false)
  let reads = 0
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async getThread() {
        reads += 1
        throw new Error('Collaboration store must not be called.')
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/collaboration', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(403)
  expect(reads).toBe(0)
})

test('keeps guest members read-only for collaboration mutations', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'guest' })
  let writes = 0
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async createComment() {
        writes += 1
        throw new Error('Collaboration store must not be called.')
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bodyMarkdown: 'Guest comment' }),
  })

  expect(response.status).toBe(403)
  expect(writes).toBe(0)
})

test('returns a client error when a comment mentions an inactive Workspace member', async () => {
  configureFakeProjectClients(true, { inactiveWorkspaceMemberKeys: ['inactive@example.com'] })
  let writes = 0
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async createComment() {
        writes += 1
        throw new Error('Collaboration store must not be called.')
      },
    }),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bodyMarkdown: 'Please review this, @Inactive.',
      mentionMemberKeys: ['inactive@example.com'],
    }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    message: 'Mentioned Workspace member "inactive@example.com" is not active.',
  })
  expect(writes).toBe(0)
})

test('allows active system administrators to be mentioned without project membership', async () => {
  for (const unassignedIssue of [false, true]) {
    configureFakeProjectClients(true, {
      mentionAccessDeniedMemberKeys: ['admin@example.com'],
      systemAdminMemberKeys: ['admin@example.com'],
      unassignedIssue,
    })
    const writes: Parameters<CollaborationClient['createComment']>[0][] = []
    configureApiClientsForTest({
      collaboration: createCollaborationStub({
        async createComment(input) {
          writes.push(input)
          return {
            id: `admin-mention-${unassignedIssue ? 'team' : 'project'}`,
            rootCommentId: `admin-mention-${unassignedIssue ? 'team' : 'project'}`,
            authorMemberKey: input.actorMemberKey,
            bodyMarkdown: input.bodyMarkdown,
            version: 1,
            mentionMemberKeys: input.mentionMemberKeys ?? [],
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:00.000Z',
            reactions: [],
          }
        },
      }),
    })

    const response = await app.request('/api/teams/core-team/issues/onboarding-friction/comments', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bodyMarkdown: 'Please review this, @Admin.',
        mentionMemberKeys: ['admin@example.com'],
      }),
    })

    expect(response.status).toBe(201)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.mentionMemberKeys).toEqual(['admin@example.com'])
  }
})

test('allows a Workspace owner with viewer access to moderate a comment', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'owner' })
  const deletes: Parameters<CollaborationClient['deleteComment']>[0][] = []
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async deleteComment(input) {
        deletes.push(input)
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'sato@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:01:00.000Z',
          deletedAt: '2026-07-12T00:01:00.000Z',
          reactions: [],
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/comment-1',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(deletes).toHaveLength(1)
  expect(deletes[0]?.canModerate).toBe(true)
})

test('allows an assigned project manager to moderate another member comment', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const deletes: Parameters<CollaborationClient['deleteComment']>[0][] = []
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async deleteComment(input) {
        deletes.push(input)
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'sato@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:01:00.000Z',
          deletedAt: '2026-07-12T00:01:00.000Z',
          reactions: [],
        }
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/comment-1',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(deletes[0]?.canModerate).toBe(true)
})

test('denies a project viewer from deleting another member comment', async () => {
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  let deletes = 0
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async deleteComment() {
        deletes += 1
        throw new CollaborationError(403, 'CommentDeleteDenied', 'Comment delete permission is required.')
      },
    }),
  })

  const response = await app.request(
    '/api/teams/core-team/issues/onboarding-friction/comments/comment-1',
    {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  )

  expect(response.status).toBe(403)
  expect(deletes).toBe(1)
})

test('reads and changes project watcher state through the project scope', async () => {
  configureFakeProjectClients(true)
  const reads: Parameters<CollaborationClient['getWatcherState']>[0][] = []
  const writes: Parameters<CollaborationClient['subscribe']>[0][] = []
  const watch = {
    subscribed: true,
    explicit: true,
    automatic: false,
    reasons: ['manual'],
    watcherCount: 3,
  }
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async getWatcherState(input) {
        reads.push(input)
        return watch
      },
      async subscribe(input) {
        writes.push(input)
        return watch
      },
    }),
  })

  const readResponse = await app.request('/api/projects/refero/watch', {
    headers: { Authorization: 'Bearer test-token' },
  })
  const writeResponse = await app.request('/api/projects/refero/watch', {
    method: 'PUT',
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(readResponse.status).toBe(200)
  expect(writeResponse.status).toBe(200)
  expect(reads).toEqual([{
    entityKey: 'user#demo@example.com#project#refero',
    memberKey: 'demo@example.com',
  }])
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    workspaceId: 'user#demo@example.com',
    entityKey: 'user#demo@example.com#project#refero',
    projectId: 'refero',
    memberKey: 'demo@example.com',
  })
})

test('issues a one-time realtime ticket only after Work Item viewer access is confirmed', async () => {
  configureFakeProjectClients(true)
  const ticketInputs: Array<Record<string, unknown>> = []
  configureApiClientsForTest({
    realtimeTickets: {
      async createTicket(input) {
        ticketInputs.push(input)

        return {
          ticket: 'one-time-ticket',
          websocketUrl: 'wss://realtime.example.com/dev',
          expiresAt: '2026-07-12T00:01:00.000Z',
        }
      },
    },
  })

  const response = await app.request('/api/realtime/tickets', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      teamId: 'core-team',
      issueId: 'onboarding-friction',
    }),
  })

  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    ticket: 'one-time-ticket',
    websocketUrl: 'wss://realtime.example.com/dev',
    expiresAt: '2026-07-12T00:01:00.000Z',
  })
  expect(ticketInputs).toEqual([{
    workspaceId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    projectId: 'refero',
    systemAdmin: false,
    canWrite: true,
    scopeKey: 'user#demo@example.com#work-item#team/core-team/issue/onboarding-friction',
  }])
})

test('updates a team-owned issue after team access is confirmed', async () => {
  const calls = configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: '更新済み Issue',
      assignedProjectId: null,
      assigneeUserId: 'sato@example.com',
      dueDate: '2026/06/22',
      priority: 'low',
      workflowStatusId: 'done',
      expectedRevision: 1,
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    issue: {
      id: 'onboarding-friction',
      teamId: 'core-team',
      title: '更新済み Issue',
      assigneeEmail: 'sato@example.com',
      workflowStatusId: 'done',
      statusCategory: 'completed',
      dueDate: '2026/06/22',
      priority: 'low',
    },
  })
  expect(calls.issueDetails).toContainEqual({
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    readOptions: { consistentIssueRead: true, eventLimit: 0 },
  })
  expect(calls.issueUpdates).toEqual([
    {
      actorUserId: 'demo@example.com',
      assignedProjectId: null,
      directoryId: 'user#demo@example.com',
      issueId: 'onboarding-friction',
      teamId: 'core-team',
    },
  ])
})

test('returns a stable conflict code when a Work Item revision is stale', async () => {
  configureFakeProjectClients(true)
  const currentIssue = {
    schemaVersion: 1,
    revision: 2,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'onboarding-friction',
    sortOrder: 10,
    title: '初回オンボーディングの離脱要因を減らす',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'in-progress',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/18',
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T02:00:00.000Z',
  }
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      return command.constructor.name === 'GetCommand'
        ? { Item: currentIssue }
        : { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  configureApiClientsForTest({
    teamIssues: new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      'AuditTable',
    ),
  })

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workflowStatusId: 'done', expectedRevision: 1 }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'WorkItemRevisionConflict',
    message: 'Work Item changed. Reload and try again.',
  })
})

test('requires a positive expected revision for Work Item updates', async () => {
  configureFakeProjectClients(true)

  const response = await app.request('/api/teams/core-team/issues/onboarding-friction', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workflowStatusId: 'done' }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'InvalidWorkItemRevision',
    message: 'Work Item expected revision is required.',
  })
})

test('loads only canonical project execution Work Items', async () => {
  const calls = configureFakeProjectClients(true, { taskAssigneeUserId: 'sato@example.com' })

  const response = await app.request('/api/projects/refero/issues', {
    headers: {
      Authorization: 'Bearer test-token',
    },
  })

  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.projectId).toBe('refero')
  expect(body.issues.map((issue: { id: string }) => issue.id)).toEqual([
    'onboarding-friction',
  ])
  expect(calls.projectIssueReads).toEqual([
    { directoryId: 'user#demo@example.com', projectId: 'refero' },
  ])
  expect(calls.taskReads).toEqual([])
})

test('DynamoDB task client queries the scoped project partition across pages', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if (sentInputs.length === 1) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              directoryProjectId: 'user#demo@example.com#project#refero',
              projectId: 'refero',
              taskId: 'wireframe',
              sortOrder: 10,
              titleKey: 'tasks.item.wireframe',
              assigneeKey: 'tasks.assignee.sato',
              status: 'in-progress',
              dueDate: '2026/06/03',
              priority: 'high',
            },
          ],
          LastEvaluatedKey: {
            directoryProjectId: 'user#demo@example.com#project#refero',
            taskId: 'wireframe',
          },
        }
      }

      return {
        Items: [
          {
            directoryId: 'user#demo@example.com',
            directoryProjectId: 'user#demo@example.com#project#refero',
            projectId: 'refero',
            taskId: 'brand-guideline',
            sortOrder: 20,
            titleKey: 'tasks.item.brandGuideline',
            assigneeKey: 'tasks.assignee.suzuki',
            status: 'review',
            dueDate: '2026/06/05',
            priority: 'medium',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectTasksClient('TasksTable', documentClient)

  await expect(client.getProjectTasks('user#demo@example.com', 'refero')).resolves.toEqual({
    projectId: 'refero',
    tasks: [
      {
        source: 'legacy',
        id: 'wireframe',
        titleKey: 'tasks.item.wireframe',
        assigneeKey: 'tasks.assignee.sato',
        status: 'in-progress',
        dueDate: '2026/06/03',
        priority: 'high',
      },
      {
        source: 'legacy',
        id: 'brand-guideline',
        titleKey: 'tasks.item.brandGuideline',
        assigneeKey: 'tasks.assignee.suzuki',
        status: 'review',
        dueDate: '2026/06/05',
        priority: 'medium',
      },
    ],
  })
  expect(sentInputs).toEqual([
    {
      TableName: 'TasksTable',
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': 'user#demo@example.com#project#refero',
      },
      ExclusiveStartKey: undefined,
      ScanIndexForward: true,
    },
    {
      TableName: 'TasksTable',
      IndexName: 'ProjectSortOrderIndex',
      KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
      ExpressionAttributeValues: {
        ':directoryProjectId': 'user#demo@example.com#project#refero',
      },
      ExclusiveStartKey: {
        directoryProjectId: 'user#demo@example.com#project#refero',
        taskId: 'wireframe',
      },
      ScanIndexForward: true,
    },
  ])
})

test('DynamoDB task and Work Item list clients stop pagination at the requested read limit', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const legacyTask = {
    directoryId: 'user#demo@example.com',
    directoryProjectId: 'user#demo@example.com#project#refero',
    projectId: 'refero',
    taskId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    status: 'todo',
    dueDate: '2026/06/03',
    priority: 'high',
  }
  const canonicalWorkItem = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {
        Items: [command.input.TableName === 'LegacyTasksTable' ? legacyTask : canonicalWorkItem],
        LastEvaluatedKey: { more: true },
      }
    },
  } as unknown as DynamoDBDocumentClient
  const projectTasksClient = new DynamoDbProjectTasksClient(
    'LegacyTasksTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const workItemsClient = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await projectTasksClient.getProjectTasks('user#demo@example.com', 'refero', { limit: 1 })
  await workItemsClient.getTeamIssues('user#demo@example.com', 'core-team', { limit: 1 })
  await workItemsClient.getProjectIssues('user#demo@example.com', 'refero', { limit: 1 })

  expect(sentInputs).toHaveLength(3)
  expect(sentInputs.map((input) => input.Limit)).toEqual([1, 1, 1])
})

test('DynamoDB task and Work Item list clients skip DynamoDB reads when limit is zero', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const projectTasksClient = new DynamoDbProjectTasksClient(
    'LegacyTasksTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )
  const workItemsClient = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(
    projectTasksClient.getProjectTasks('user#demo@example.com', 'refero', { limit: 0 }),
  ).resolves.toMatchObject({ tasks: [] })
  await expect(
    workItemsClient.getTeamIssues('user#demo@example.com', 'core-team', { limit: 0 }),
  ).resolves.toMatchObject({ issues: [] })
  await expect(
    workItemsClient.getProjectIssues('user#demo@example.com', 'refero', { limit: 0 }),
  ).resolves.toMatchObject({ issues: [] })
  expect(sentInputs).toEqual([])
})

test('DynamoDB Team Work Item reads can use the strongly consistent base table', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await client.getTeamIssues('user#demo@example.com', 'core-team', {
    consistentRead: true,
  })

  expect(sentInputs).toEqual([{
    TableName: 'WorkItemsTable',
    ConsistentRead: true,
    KeyConditionExpression: 'directoryTeamId = :directoryTeamId',
    ExpressionAttributeValues: {
      ':directoryTeamId': 'user#demo@example.com#team#core-team',
    },
    ExclusiveStartKey: undefined,
  }])
})

test('DynamoDB Team and project Work Item clients read every page without a default Limit', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const pageCounts = new Map<string, number>()
  const canonicalWorkItem = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'work-item-1',
    sortOrder: 10,
    title: 'Work Item',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      const indexName = String(command.input.IndexName)
      const pageCount = (pageCounts.get(indexName) ?? 0) + 1
      pageCounts.set(indexName, pageCount)

      return {
        Items: [{
          ...canonicalWorkItem,
          issueId: `${indexName}-${pageCount}`,
          sortOrder: pageCount * 10,
        }],
        ...(pageCount === 1 ? { LastEvaluatedKey: { indexName, pageCount } } : {}),
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'WorkItemsTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  const teamResponse = await client.getTeamIssues(
    'user#demo@example.com',
    'core-team',
    { limit: undefined },
  )
  const projectResponse = await client.getProjectIssues(
    'user#demo@example.com',
    'refero',
    { limit: undefined },
  )

  expect(teamResponse.issues).toHaveLength(2)
  expect(projectResponse.issues).toHaveLength(2)
  expect(sentInputs).toHaveLength(4)
  expect(sentInputs.every((input) => !('Limit' in input))).toBe(true)
})

test('DynamoDB Work Item client increments revision with an atomic CAS update', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  let reads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentCommands.push({ input: command.input, name: command.constructor.name })
      if (command.constructor.name === 'GetCommand') {
        reads += 1
        return {
          Item: reads === 1
            ? currentIssue
            : {
                ...currentIssue,
                revision: 2,
                workflowStatusId: 'done',
                statusCategory: 'completed',
              },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
  )

  await expect(client.updateTeamIssue(
    'user#demo@example.com',
    'core-team',
    'wireframe',
    {
      workflowSchemaVersion: 1,
      workflowStatusId: 'done',
      statusCategory: 'completed',
      customFieldValues: {},
      expectedRevision: 1,
    },
    'demo@example.com',
  )).resolves.toMatchObject({
    issue: { schemaVersion: 1, revision: 2, workflowStatusId: 'done' },
  })
  const transaction = sentCommands.find((command) => command.name === 'TransactWriteCommand')
  const transactItems = transaction?.input.TransactItems
  expect(Array.isArray(transactItems) ? transactItems[0] : undefined).toMatchObject({
    Update: {
      ExpressionAttributeValues: {
        ':expectedRevision': 1,
        ':nextRevision': 2,
      },
      ConditionExpression:
        'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
        '#revision = :expectedRevision',
    },
  })
})

test('DynamoDB Work Item client classifies configuration conflicts from the actual transaction layout', async () => {
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: 'configuration-conflict',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'configuration-conflict' },
  })
  const configurationConditionChecks: NonNullable<
    TransactWriteCommandInput['TransactItems']
  > = [{
    ConditionCheck: {
      TableName: 'ConfigurationTable',
      Key: { workspaceId: 'workspace-1', scopeKey: 'WORK_ITEM_CONFIGURATION#TEAM#core-team' },
      ConditionExpression: '#revision = :expectedRevision',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':expectedRevision': 1 },
    },
  }]

  for (const operation of ['create', 'update'] as const) {
    for (const auditEnabled of [false, true]) {
      let configurationConditionIndex = -1
      const documentClient = {
        async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
          if (command.constructor.name === 'QueryCommand') {
            return { Items: [] }
          }
          if (command.constructor.name === 'GetCommand') {
            return { Item: currentIssue }
          }
          if (command.constructor.name === 'TransactWriteCommand') {
            const transactItems = command.input.TransactItems as Array<{
              ConditionCheck?: { TableName?: string }
            }>
            configurationConditionIndex = transactItems.findIndex((item) =>
              item.ConditionCheck?.TableName === 'ConfigurationTable'
            )
            const error = new Error('Transaction was canceled.')
            error.name = 'TransactionCanceledException'
            Object.assign(error, {
              CancellationReasons: transactItems.map((_, index) => ({
                Code: index === configurationConditionIndex ? 'ConditionalCheckFailed' : 'None',
              })),
            })
            throw error
          }
          return {}
        },
      } as unknown as DynamoDBDocumentClient
      const client = new DynamoDbTeamIssuesClient(
        'IssuesTable',
        'IssueEventsTable',
        documentClient,
        {} as DynamoDBClient,
        false,
        auditEnabled ? 'AuditTable' : undefined,
      )
      const mutation = operation === 'create'
        ? client.createTeamIssue(
            'workspace-1',
            'core-team',
            {
              title: 'New Work Item',
              assigneeUserId: 'sato@example.com',
              workflowSchemaVersion: 1,
              workflowStatusId: 'todo',
              statusCategory: 'unstarted',
              customFieldValues: {},
              dueDate: '2026/07/20',
              priority: 'medium',
              configurationConditionChecks,
            },
            'demo@example.com',
            auditEnabled ? auditContext : undefined,
          )
        : client.updateTeamIssue(
            'workspace-1',
            'core-team',
            'wireframe',
            {
              workflowSchemaVersion: 1,
              workflowStatusId: 'done',
              statusCategory: 'completed',
              customFieldValues: {},
              expectedRevision: 1,
              configurationConditionChecks,
            },
            'demo@example.com',
            auditEnabled ? auditContext : undefined,
          )

      await expect(mutation).rejects.toMatchObject({
        code: 'WorkItemConfigurationRevisionConflict',
        status: 409,
      })
      expect(configurationConditionIndex).toBe(auditEnabled ? 3 : 2)
    }
  }
})

test('DynamoDB Work Item update emits render-ready notification candidates', async () => {
  const sentCommands: Array<{ input: Record<string, unknown>; name: string }> = []
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'workspace-1',
    directoryTeamId: 'workspace-1#team#core-team',
    directoryProjectId: 'workspace-1#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Notification-ready Work Item',
    assigneeUserId: 'before@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/07/20',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  let reads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentCommands.push({ input: command.input, name: command.constructor.name })
      if (command.constructor.name === 'GetCommand') {
        reads += 1
        return {
          Item: reads === 1
            ? currentIssue
            : {
                ...currentIssue,
                revision: 2,
                assigneeUserId: 'after@example.com',
                workflowStatusId: 'review',
                statusCategory: 'started',
              },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'manager-sub', kind: 'user', displayName: 'manager@example.com' },
    idempotencyKey: 'notification-update',
    occurredAt: '2026-07-12T01:00:00.000Z',
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'notification-update' },
  })
  const client = new DynamoDbTeamIssuesClient(
    'IssuesTable',
    'IssueEventsTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    'AuditTable',
  )

  await client.updateTeamIssue(
    'workspace-1',
    'core-team',
    'wireframe',
    {
      assigneeUserId: 'after@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'review',
      statusCategory: 'started',
      customFieldValues: {},
      expectedRevision: 1,
    },
    'manager@example.com',
    auditContext,
  )

  const transaction = sentCommands.find((command) => command.name === 'TransactWriteCommand')
  const transactItems = transaction?.input.TransactItems
  const auditItem = Array.isArray(transactItems)
    ? (transactItems[2] as { Put?: { Item?: Record<string, unknown> } })?.Put?.Item
    : undefined

  expect(auditItem).toMatchObject({
    eventType: 'work-item.updated',
    summary: 'Work Item assignment changed.',
    metadata: {
      actorMemberKey: 'manager@example.com',
      teamId: 'core-team',
      issueId: 'wireframe',
      projectId: 'refero',
      deepLink: '/teams/core-team/issues?issueId=wireframe',
      notificationTitle: 'Notification-ready Work Item',
      notificationCandidates: [
        { memberKey: 'after@example.com', reason: 'assignment' },
        { memberKey: 'after@example.com', reason: 'status-change' },
      ],
    },
  })
})

test('DynamoDB Work Item client classifies revision CAS transaction conditions', async () => {
  const currentIssue = {
    schemaVersion: 1,
    revision: 1,
    directoryId: 'user#demo@example.com',
    directoryTeamId: 'user#demo@example.com#team#core-team',
    directoryProjectId: 'user#demo@example.com#project#refero',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    issueId: 'wireframe',
    sortOrder: 10,
    title: 'Wireframe',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'demo@example.com',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026/06/03',
    priority: 'high',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const auditContext = createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo@example.com', kind: 'user' },
    idempotencyKey: 'request-1',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/teams/core-team/issues/wireframe' },
    source: { kind: 'api', requestId: 'request-1' },
  })
  const runUpdate = (
    cancellationReasons: Array<{ Code: string }> | undefined,
    latestIssue: Record<string, unknown> | undefined,
  ) => {
    const sentInputs: Array<Record<string, unknown>> = []
    let issueReads = 0
    const documentClient = {
      async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
        sentInputs.push(command.input)

        if (command.constructor.name === 'GetCommand') {
          issueReads += 1
          return { Item: issueReads === 1 ? currentIssue : latestIssue }
        }

        if (command.constructor.name === 'TransactWriteCommand') {
          const error = new Error('Transaction was canceled.')
          error.name = 'TransactionCanceledException'

          if (cancellationReasons) {
            Object.assign(error, { CancellationReasons: cancellationReasons })
          }

          throw error
        }

        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const client = new DynamoDbTeamIssuesClient(
      'IssuesTable',
      'IssueEventsTable',
      documentClient,
      {} as DynamoDBClient,
      false,
      'AuditTable',
    )
    const result = client.updateTeamIssue(
      'user#demo@example.com',
      'core-team',
      'wireframe',
      {
        workflowSchemaVersion: 1,
        workflowStatusId: 'done',
        statusCategory: 'completed',
        customFieldValues: {},
        expectedRevision: 1,
      },
      'demo@example.com',
      auditContext,
    )

    return { result, sentInputs }
  }

  const stateConflict = runUpdate(
    [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    { ...currentIssue, revision: 2 },
  )
  await expect(stateConflict.result).rejects.toMatchObject({
    code: 'WorkItemRevisionConflict',
    status: 409,
  })
  expect(stateConflict.sentInputs[0]).toMatchObject({
    TableName: 'IssuesTable',
    ConsistentRead: true,
  })
  expect(stateConflict.sentInputs.at(-1)).toMatchObject({
    TableName: 'IssuesTable',
    Key: {
      directoryTeamId: 'user#demo@example.com#team#core-team',
      issueId: 'wireframe',
    },
    ConsistentRead: true,
  })

  const auditConflict = runUpdate(
    [{ Code: 'None' }, { Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    currentIssue,
  )
  await expect(auditConflict.result).rejects.toMatchObject({
    code: 'ConditionalCheckFailedException',
    status: 409,
  })
  expect(auditConflict.sentInputs).toHaveLength(2)

  const deletedIssue = runUpdate(
    [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    undefined,
  )
  await expect(deletedIssue.result).rejects.toMatchObject({
    code: 'TeamIssueNotFound',
    status: 404,
  })

  const missingReasons = runUpdate(undefined, { ...currentIssue, revision: 2 })
  await expect(missingReasons.result).rejects.toMatchObject({
    code: 'WorkItemRevisionConflict',
    status: 409,
  })
  expect(missingReasons.sentInputs).toHaveLength(3)

  const missingReasonsWithoutRevisionChange = runUpdate(undefined, currentIssue)
  await expect(missingReasonsWithoutRevisionChange.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(missingReasonsWithoutRevisionChange.sentInputs).toHaveLength(3)

  const emptyReasons = runUpdate([], { ...currentIssue, revision: 2 })
  await expect(emptyReasons.result).rejects.toMatchObject({
    code: 'WorkItemRevisionConflict',
    status: 409,
  })
  expect(emptyReasons.sentInputs).toHaveLength(3)

  const unknownReason = runUpdate([{ Code: 'TransactionConflict' }], undefined)
  await expect(unknownReason.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(unknownReason.sentInputs).toHaveLength(2)

  const mixedReasons = runUpdate(
    [
      { Code: 'ConditionalCheckFailed' },
      { Code: 'ProvisionedThroughputExceeded' },
      { Code: 'None' },
    ],
    undefined,
  )
  await expect(mixedReasons.result).rejects.toMatchObject({
    code: 'TransactionCanceledException',
    status: 502,
  })
  expect(mixedReasons.sentInputs).toHaveLength(2)
})

test('DynamoDB dashboard summary client derives counts from canonical Work Items', async () => {
  const accessListReads: Array<{ directoryId: string; memberKey: string }> = []
  const projectIssueReads: Array<{ directoryId: string; projectId: string }> = []
  const client = new DynamoDbDashboardSummaryClient(
    {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'core-team',
            name: 'Core Team',
            expanded: true,
            projects: [
              { id: 'refero', name: 'Refero', tone: 'blue' as const },
              { id: 'private', name: 'Private', tone: 'purple' as const },
            ],
          }],
        }
      },
      async getProjectAccessList(directoryId: string, memberKey: string) {
        accessListReads.push({ directoryId, memberKey })
        return [{ projectId: 'refero', role: 'viewer' as ProjectRole }]
      },
    } as never,
    {
      async getProjectIssues(directoryId: string, projectId: string) {
        projectIssueReads.push({ directoryId, projectId })
        return {
          projectId,
          issues: [
            {
              schemaVersion: 1 as const,
              revision: 1,
              id: 'active-high',
              teamId: 'core-team',
              assignedProjectId: projectId,
              title: 'Active high priority Work Item',
              assigneeUserId: 'sato@example.com',
              creatorMemberKey: 'demo@example.com',
              workflowSchemaVersion: 1 as const,
              workflowStatusId: 'in-progress',
              statusCategory: 'started' as const,
              customFieldValues: {},
              relationIds: [],
              dueDate: '2026/07/20',
              priority: 'high' as const,
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-01T00:00:00.000Z',
              source: 'dynamodb' as const,
            },
            {
              schemaVersion: 1 as const,
              revision: 1,
              id: 'completed-high',
              teamId: 'core-team',
              assignedProjectId: projectId,
              title: 'Completed high priority Work Item',
              assigneeUserId: 'sato@example.com',
              creatorMemberKey: 'demo@example.com',
              workflowSchemaVersion: 1 as const,
              workflowStatusId: 'done',
              statusCategory: 'completed' as const,
              customFieldValues: {},
              relationIds: [],
              dueDate: '2026/07/20',
              priority: 'high' as const,
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-01T00:00:00.000Z',
              source: 'dynamodb' as const,
            },
          ],
        }
      },
    } as never,
  )

  const summary = await client.getSummary('user#demo@example.com', {
    userKey: 'demo@example.com',
    isSystemAdmin: false,
  })

  expect(summary).toMatchObject({
    projects: 1,
    tasks: 1,
    blocked: 1,
    source: 'dynamodb',
  })
  expect(Date.parse(summary.updatedAt)).not.toBeNaN()
  expect(accessListReads).toEqual([{
    directoryId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
  }])
  expect(projectIssueReads).toEqual([{
    directoryId: 'user#demo@example.com',
    projectId: 'refero',
  }])
})

test('DynamoDB directory client reads project access consistently for Workspace guards', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      return { Items: createProjectMemberFixtureItems() }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.getProjectAccessList('user#demo@example.com', 'demo@example.com'),
  ).resolves.toEqual([{ projectId: 'refero', role: 'manager' }])
  expect(sentInputs).toEqual([
    expect.objectContaining({
      TableName: 'DirectoryTable',
      ConsistentRead: true,
    }),
  ])
})

test('DynamoDB directory client reads every page from the user partition', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if (sentInputs.length === 1) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
          ],
          LastEvaluatedKey: {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
          },
        }
      }

      return {
        Items: [
          {
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000010#PROJECT#refero',
            entryType: 'project',
            teamId: 'core-team',
            teamSortOrder: 10,
            projectId: 'refero',
            projectSortOrder: 10,
            nameJa: 'Refero',
            nameEn: 'Refero',
            tone: 'blue',
          },
        ],
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(client.getProjectDirectory('user#demo@example.com', 'ja')).resolves.toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'コアチーム',
        expanded: true,
        projects: [
          {
            id: 'refero',
            name: 'Refero',
            tone: 'blue',
          },
        ],
      },
    ],
  })
  expect(sentInputs).toEqual([
    {
      TableName: 'DirectoryTable',
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: {
        ':directoryId': 'user#demo@example.com',
      },
      ExclusiveStartKey: undefined,
      ScanIndexForward: true,
    },
    {
      TableName: 'DirectoryTable',
      KeyConditionExpression: 'directoryId = :directoryId',
      ExpressionAttributeValues: {
        ':directoryId': 'user#demo@example.com',
      },
      ExclusiveStartKey: {
        directoryId: 'user#demo@example.com',
        entryKey: '000010#000000#TEAM#core-team',
      },
      ScanIndexForward: true,
    },
  ])
})

test('DynamoDB directory client omits archived teams and projects', async () => {
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000020#PROJECT#archived-project',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'archived-project',
              projectSortOrder: 20,
              nameJa: 'Archived Project',
              nameEn: 'Archived Project',
              tone: 'green',
              archivedAt: '2026-06-06T00:00:00.000Z',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000020#000000#TEAM#archived-team',
              entryType: 'team',
              teamId: 'archived-team',
              teamSortOrder: 20,
              nameJa: 'Archived Team',
              nameEn: 'Archived Team',
              expanded: true,
              archivedAt: '2026-06-06T00:00:00.000Z',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000020#000010#PROJECT#hidden-project',
              entryType: 'project',
              teamId: 'archived-team',
              teamSortOrder: 20,
              projectId: 'hidden-project',
              projectSortOrder: 10,
              nameJa: 'Hidden Project',
              nameEn: 'Hidden Project',
              tone: 'yellow',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(client.getProjectDirectory('user#demo@example.com', 'ja')).resolves.toEqual({
    teams: [
      {
        id: 'core-team',
        name: 'コアチーム',
        expanded: true,
        projects: [
          {
            id: 'refero',
            name: 'Refero',
            tone: 'blue',
          },
        ],
      },
    ],
  })
  await expect(client.hasProjectAccess('user#demo@example.com', 'refero')).resolves.toBe(true)
  await expect(
    client.hasProjectAccess('user#demo@example.com', 'archived-project'),
  ).resolves.toBe(false)
  await expect(
    client.hasProjectAccess('user#demo@example.com', 'hidden-project'),
  ).resolves.toBe(false)
})

test('DynamoDB directory client archives teams and projects with conditional updates', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(client.archiveTeam('user#demo@example.com', 'core-team', undefined, 0)).resolves.toEqual({
    teamId: 'core-team',
    archivedAt: expect.any(String),
  })
  await expect(
    client.archiveProject('user#demo@example.com', 'core-team', 'refero', undefined, 1),
  ).resolves.toEqual({
    teamId: 'core-team',
    projectId: 'refero',
    archivedAt: expect.any(String),
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [{
      Update: {
        TableName: 'DirectoryTable',
        Key: {
          directoryId: 'user#demo@example.com',
          entryKey: '000010#000000#TEAM#core-team',
        },
        UpdateExpression: 'SET archivedAt = :archivedAt',
        ConditionExpression:
          'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
      },
    }, {
      Put: {
        TableName: 'mukuroji-planning-local',
        Item: {
          workspaceId: 'user#demo@example.com',
          recordKey: 'META',
          revision: 1,
        },
        ConditionExpression:
          'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
      },
    }],
  })
  expect(sentInputs[3]).toMatchObject({
    TransactItems: [{
      Update: {
        TableName: 'DirectoryTable',
        Key: {
          directoryId: 'user#demo@example.com',
          entryKey: '000010#000010#PROJECT#refero',
        },
        UpdateExpression: 'SET archivedAt = :archivedAt',
        ConditionExpression:
          'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
      },
    }, {}],
  })
})

test('serializes directory archive with the Planning graph revision', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [{
            directoryId: 'user#demo@example.com',
            entryKey: '000010#000000#TEAM#core-team',
            entryType: 'team',
            teamId: 'core-team',
            teamSortOrder: 10,
            nameJa: 'コアチーム',
            nameEn: 'Core Team',
            expanded: true,
          }],
        }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
    'PlanningTable',
  )

  await client.archiveTeam('user#demo@example.com', 'core-team', undefined, 4)

  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      { Update: { TableName: 'DirectoryTable' } },
      {
        Put: {
          TableName: 'PlanningTable',
          Item: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'META',
            entryType: 'planning-meta',
            schemaVersion: 1,
            revision: 5,
          },
          ConditionExpression: '#revision = :expectedPlanningRevision',
          ExpressionAttributeValues: { ':expectedPlanningRevision': 4 },
        },
      },
    ],
  })
})

test('classifies a Planning revision race during directory archive', async () => {
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
          ],
        }
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        const error = new Error('canceled')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        })
        throw error
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
    'PlanningTable',
  )

  await expect(client.archiveProject(
    'user#demo@example.com',
    'core-team',
    'refero',
    undefined,
    4,
  )).rejects.toMatchObject({
    status: 409,
    code: 'PlanningRevisionConflict',
  })
})

test('DynamoDB directory client manages project member roles', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'demo@example.com',
              email: 'demo@example.com',
              name: 'Demo User',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'zmanager@example.com',
              email: 'zmanager@example.com',
              name: 'Z Manager',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    undefined,
    false,
    undefined,
    'WorkspaceAccessTable',
  )

  await expect(
    client.getProjectMembers('user#demo@example.com', 'refero'),
  ).resolves.toEqual({
    projectId: 'refero',
    members: [
      {
        id: 'demo@example.com',
        email: 'demo@example.com',
        name: 'Demo User',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
      {
        id: 'zmanager@example.com',
        email: 'zmanager@example.com',
        name: 'Z Manager',
        role: 'manager',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
    ],
  })
  await expect(
    client.getProjectRole('user#demo@example.com', 'refero', 'DEMO@example.com'),
  ).resolves.toBe('manager')
  await expect(
    client.updateProjectMember('user#demo@example.com', 'refero', 'sato@example.com', {
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
    }, 1),
  ).resolves.toEqual({
    member: {
      id: 'sato@example.com',
      email: 'sato@example.com',
      name: '佐藤 花子',
      role: 'member',
      updatedAt: expect.any(String),
    },
  })
  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).resolves.toEqual({
    projectId: 'refero',
    memberId: 'demo@example.com',
  })
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
  expect(sentInputs[3]).toMatchObject({
    TransactItems: [
      {
        Put: {
          TableName: 'DirectoryTable',
          Item: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#sato@example.com',
            entryType: 'project-member',
            projectId: 'refero',
            memberKey: 'sato@example.com',
            email: 'sato@example.com',
            name: '佐藤 花子',
            role: 'member',
          },
        },
      },
      {
        Update: {
          TableName: 'WorkspaceAccessTable',
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#sato@example.com',
          },
          ConditionExpression:
            '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
          ExpressionAttributeValues: {
            ':expectedVersion': 1,
          },
        },
      },
    ],
  })
  expect(sentInputs[5]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
          },
          ConditionExpression: '#role = :manager',
          ExpressionAttributeNames: {
            '#role': 'role',
          },
          ExpressionAttributeValues: {
            ':manager': 'manager',
          },
        },
      },
      {
        Delete: {
          TableName: 'DirectoryTable',
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
          },
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND #updatedAt = :expectedUpdatedAt AND #role = :expectedRole',
          ExpressionAttributeNames: {
            '#updatedAt': 'updatedAt',
            '#role': 'role',
          },
          ExpressionAttributeValues: {
            ':expectedUpdatedAt': '2026-06-08T00:00:00.000Z',
            ':expectedRole': 'manager',
          },
        },
      },
    ],
  })
  expect(sentInputs[4]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client keeps at least one project manager', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'demo@example.com',
              email: 'demo@example.com',
              name: 'Demo User',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.updateProjectMember('user#demo@example.com', 'refero', 'demo@example.com', {
      email: 'demo@example.com',
      role: 'viewer',
    }, 1),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  expect(sentInputs).toHaveLength(2)
})

test('DynamoDB directory client treats manager guard transaction cancellation as last manager conflict', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'demo@example.com',
              email: 'demo@example.com',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
            ...(queryReads === 1
              ? [
                  {
                    directoryId: 'user#demo@example.com',
                    entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
                    entryType: 'project-member',
                    projectId: 'refero',
                    memberKey: 'zmanager@example.com',
                    email: 'zmanager@example.com',
                    role: 'manager',
                    createdAt: '2026-06-08T00:00:00.000Z',
                    updatedAt: '2026-06-08T00:00:00.000Z',
                  },
                ]
              : []),
          ],
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      if ('Key' in command.input) {
        return {
          Item: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
            entryType: 'workspace-member',
            memberKey: 'demo@example.com',
            role: 'owner',
            status: 'active',
            version: 1,
          },
        }
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
          },
        },
      },
      {
        Delete: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
          },
        },
      },
    ],
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[0]).toMatchObject({ ConsistentRead: true })
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client treats deleted target member transaction cancellation as member not found', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: [
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000000#TEAM#core-team',
              entryType: 'team',
              teamId: 'core-team',
              teamSortOrder: 10,
              nameJa: 'コアチーム',
              nameEn: 'Core Team',
              expanded: true,
            },
            {
              directoryId: 'user#demo@example.com',
              entryKey: '000010#000010#PROJECT#refero',
              entryType: 'project',
              teamId: 'core-team',
              teamSortOrder: 10,
              projectId: 'refero',
              projectSortOrder: 10,
              nameJa: 'Refero',
              nameEn: 'Refero',
              tone: 'blue',
            },
            ...(queryReads === 1
              ? [
                  {
                    directoryId: 'user#demo@example.com',
                    entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
                    entryType: 'project-member',
                    projectId: 'refero',
                    memberKey: 'demo@example.com',
                    email: 'demo@example.com',
                    role: 'manager',
                    createdAt: '2026-06-08T00:00:00.000Z',
                    updatedAt: '2026-06-08T00:00:00.000Z',
                  },
                ]
              : []),
            {
              directoryId: 'user#demo@example.com',
              entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
              entryType: 'project-member',
              projectId: 'refero',
              memberKey: 'zmanager@example.com',
              email: 'zmanager@example.com',
              role: 'manager',
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        })
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'ProjectMemberNotFound',
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[0]).toMatchObject({ ConsistentRead: true })
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client treats manager downgrade transaction cancellation as last manager conflict', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: createProjectMemberFixtureItems({
            includeOtherManager: queryReads === 1,
          }),
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        Object.assign(error, {
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.updateProjectMember('user#demo@example.com', 'refero', 'demo@example.com', {
      email: 'demo@example.com',
      role: 'viewer',
    }, 1),
  ).rejects.toMatchObject({
    code: 'ProjectLastManager',
  })
  expect(sentInputs[1]).toMatchObject({
    TransactItems: [
      {
        ConditionCheck: {
          Key: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
          },
        },
      },
      {
        Put: {
          Item: {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
            role: 'viewer',
          },
        },
      },
      {
        Update: {
          Key: {
            workspaceId: 'user#demo@example.com',
            recordKey: 'MEMBER#demo@example.com',
          },
          ExpressionAttributeValues: {
            ':expectedVersion': 1,
          },
        },
      },
    ],
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client returns not found when a non-manager update loses its target member', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: createProjectMemberFixtureItems({
            includeTargetMember: queryReads === 1,
            targetRole: 'member',
          }),
        }
      }

      if ('TransactItems' in command.input) {
        throw Object.assign(new Error('Transaction was canceled.'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    'AuditTable',
  )

  await expect(
    client.updateProjectMember(
      'user#demo@example.com',
      'refero',
      'demo@example.com',
      {
        email: 'demo@example.com',
        role: 'viewer',
      },
      1,
      createDirectoryMutationAuditContext(),
    ),
  ).rejects.toMatchObject({
    code: 'ProjectMemberNotFound',
    status: 404,
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client returns not found when a non-manager removal loses its target member', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  let queryReads = 0
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        queryReads += 1

        return {
          Items: createProjectMemberFixtureItems({
            includeTargetMember: queryReads === 1,
            targetRole: 'member',
          }),
        }
      }

      if ('TransactItems' in command.input) {
        throw Object.assign(new Error('Transaction was canceled.'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'ConditionalCheckFailed' },
            { Code: 'None' },
          ],
        })
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient(
    'DirectoryTable',
    documentClient,
    {} as DynamoDBClient,
    false,
    'AuditTable',
  )

  await expect(
    client.removeProjectMember(
      'user#demo@example.com',
      'refero',
      'demo@example.com',
      createDirectoryMutationAuditContext(),
    ),
  ).rejects.toMatchObject({
    code: 'ProjectMemberNotFound',
    status: 404,
  })
  expect(sentInputs).toHaveLength(3)
  expect(sentInputs[2]).toMatchObject({ ConsistentRead: true })
})

test('DynamoDB directory client does not reread manager state when cancellation reasons are missing', async () => {
  const sentInputs: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sentInputs.push(command.input)

      if ('KeyConditionExpression' in command.input) {
        return {
          Items: createProjectMemberFixtureItems(),
        }
      }

      if ('TransactItems' in command.input) {
        const error = new Error('Transaction was canceled.')
        error.name = 'TransactionCanceledException'
        throw error
      }

      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbProjectDirectoryClient('DirectoryTable', documentClient)

  await expect(
    client.removeProjectMember('user#demo@example.com', 'refero', 'demo@example.com'),
  ).rejects.toMatchObject({
    code: 'TransactionCanceledException',
  })
  expect(sentInputs).toHaveLength(2)
})

test('search endpoint parses filters and revalidates comment scope against current RBAC', async () => {
  configureFakeProjectClients(true)
  let capturedInput: WorkspaceSearchQueryInput | undefined
  let resolvedProjectId: string | undefined
  configureApiClientsForTest({
    workspaceSearch: {
      async search(input) {
        capturedInput = input
        const document = createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'comment',
          entityId: 'team/core-team/issue/issue-1/comment/comment-1',
          parentId: 'team/core-team/issue/issue-1',
          title: 'Current scope comment',
          body: 'Search body',
          url: '/teams/core-team/issues?issueId=issue-1&commentId=comment-1',
          teamId: 'core-team',
        })
        resolvedProjectId = (await input.resolveCurrentScope?.(document))?.projectId
        return { schemaVersion: 1, results: [] }
      },
    } as unknown as WorkspaceSearchClient,
  })
  const filters = {
    keyword: 'scope',
    projectIds: ['refero'],
    customFields: [{ fieldId: 'score', operator: 'greater-than', value: 5 }],
  }

  const response = await app.request(
    `/api/search?filters=${encodeURIComponent(JSON.stringify(filters))}&limit=25`,
    { headers: { Authorization: 'Bearer test-token' } },
  )

  expect(response.status).toBe(200)
  expect(capturedInput?.filters).toEqual(filters)
  expect(capturedInput?.limit).toBe(25)
  expect(capturedInput?.access.projectIds.has('refero')).toBe(true)
  expect(capturedInput?.access.teamIds.has('core-team')).toBe(true)
  expect(resolvedProjectId).toBe('refero')
})

test('search endpoint refreshes workflow, custom fields, and relations from current sources', async () => {
  configureFakeProjectClients(true, {
    detailCustomFieldValues: {},
    detailWorkflowStatusId: 'active-review',
  })
  let resolvedScope: WorkspaceSearchResolvedScope | undefined
  let relationFilters: string[] | undefined
  configureApiClientsForTest({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelations(_workspaceId, _teamId, workItemId) {
        return {
          graphRevision: 3,
          relations: [{
            sourceWorkItemId: workItemId,
            targetWorkItemId: 'current-dependency',
            type: 'blocks',
          }],
        }
      },
    }),
    workspaceSearch: {
      async search(input) {
        relationFilters = input.filters.relationIds
        resolvedScope = await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'work-item',
          entityId: 'team/core-team/issue/work-item-1',
          title: 'Stale Work Item',
          url: '/teams/core-team/issues?issueId=work-item-1',
          teamId: 'core-team',
          status: 'in-progress',
          customFields: { legacyScore: 13 },
          relationIds: ['stale-dependency'],
        }))
        return { schemaVersion: 1, results: [] }
      },
    } as unknown as WorkspaceSearchClient,
  })

  const filters = encodeURIComponent(JSON.stringify({
    relationIds: ['blocks:current-dependency'],
  }))
  const response = await app.request(`/api/search?filters=${filters}`, {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(relationFilters).toEqual(['blocks:current-dependency'])
  expect(resolvedScope).toMatchObject({
    teamId: 'core-team',
    projectId: 'refero',
    currentDocument: {
      status: 'active-review',
      customFields: {},
      relationIds: ['blocks:current-dependency'],
    },
  })
})

test('search endpoint refreshes comment content from its current source snapshot', async () => {
  configureFakeProjectClients(true)
  let resolvedScope: WorkspaceSearchResolvedScope | undefined
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async getCommentSnapshot(input) {
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'sato@example.com',
          bodyMarkdown: 'Current private decision',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-07-12T02:00:00.000Z',
          reactions: [],
        }
      },
    }),
    workspaceSearch: {
      async search(input) {
        resolvedScope = await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'comment',
          entityId: 'team/core-team/issue/issue-1/comment/comment-1',
          parentId: 'team/core-team/issue/issue-1',
          title: 'Stale title',
          body: 'Stale private decision',
          url: '/teams/core-team/issues?issueId=issue-1&commentId=comment-1',
          teamId: 'core-team',
          updatedAt: '2026-06-08T01:00:00.000Z',
        }))
        return { schemaVersion: 1, results: [] }
      },
    } as unknown as WorkspaceSearchClient,
  })

  const response = await app.request('/api/search', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(resolvedScope).toMatchObject({
    teamId: 'core-team',
    projectId: 'refero',
    currentDocument: {
      body: 'Current private decision',
      creatorUserId: 'sato@example.com',
      updatedAt: '2026-07-12T02:00:00.000Z',
    },
  })
})

test('search endpoint fails closed for missing, deleted, or malformed comment sources', async () => {
  configureFakeProjectClients(true)
  const resolvedScopes: Array<WorkspaceSearchResolvedScope | undefined> = []
  let snapshotReads = 0
  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async getCommentSnapshot(input) {
        snapshotReads += 1
        if (input.commentId === 'missing') return undefined
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: '',
          version: 2,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-07-12T02:00:00.000Z',
          deletedAt: '2026-07-12T02:00:00.000Z',
          reactions: [],
        }
      },
    }),
    workspaceSearch: {
      async search(input) {
        for (const [commentId, parentId] of [
          ['missing', 'team/core-team/issue/issue-1'],
          ['deleted', 'team/core-team/issue/issue-1'],
          ['malformed', 'team/core-team/issue/other'],
        ] as const) {
          resolvedScopes.push(await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
            workspaceId: input.workspaceId,
            entityType: 'comment',
            entityId: `team/core-team/issue/issue-1/comment/${commentId}`,
            parentId,
            title: 'Stale title',
            body: 'Stale body',
            url: `/teams/core-team/issues?issueId=issue-1&commentId=${commentId}`,
            teamId: 'core-team',
          })))
        }
        return { schemaVersion: 1, results: [] }
      },
    } as unknown as WorkspaceSearchClient,
  })

  const response = await app.request('/api/search', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(resolvedScopes).toEqual([undefined, undefined, undefined])
  expect(snapshotReads).toBe(2)
})

test('search endpoint excludes archived Team documents for system administrators', async () => {
  configureFakeProjectClients(true, { systemAdminMemberKeys: ['demo@example.com'] })
  let resolvedScope: unknown = 'not-called'
  configureApiClientsForTest({
    workspaceSearch: {
      async search(input) {
        resolvedScope = await input.resolveCurrentScope?.(createWorkspaceSearchDocument({
          workspaceId: input.workspaceId,
          entityType: 'work-item',
          entityId: 'team/archived-team/issue/issue-1',
          title: 'Archived Team item',
          url: '/teams/archived-team/issues?issueId=issue-1',
          teamId: 'archived-team',
        }))
        return { schemaVersion: 1, results: [] }
      },
    } as unknown as WorkspaceSearchClient,
  })

  const response = await app.request('/api/search', {
    headers: { Authorization: 'Bearer test-token' },
  })

  expect(response.status).toBe(200)
  expect(resolvedScope).toBeUndefined()
})

test('saved view endpoints forward create update list and revision delete contracts', async () => {
  configureFakeProjectClients(true)
  const calls = {
    creates: [] as unknown[],
    deletes: [] as unknown[],
    lists: [] as unknown[],
    updates: [] as unknown[],
  }
  const view = {
    schemaVersion: 1 as const,
    id: 'view-1',
    name: 'Review queue',
    visibility: 'personal' as const,
    ownerUserId: 'demo@example.com',
    filters: { statuses: ['review'] },
    layout: { mode: 'table' as const, sort: [], columns: ['title'] },
    revision: 1,
    canEdit: true,
    favorite: false,
    pinned: false,
    isDefault: false,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  configureApiClientsForTest({
    workspaceSearch: {
      async listSavedViews(input) {
        calls.lists.push(input)
        return { views: [view] }
      },
      async createSavedView(input) {
        calls.creates.push(input)
        return view
      },
      async updateSavedView(input) {
        calls.updates.push(input)
        return { ...view, revision: 2, favorite: true }
      },
      async deleteSavedView(input) {
        calls.deletes.push(input)
        return { id: input.viewId, revision: input.expectedRevision }
      },
    } as unknown as WorkspaceSearchClient,
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'saved-view-request-1',
  }
  const listResponse = await app.request('/api/saved-views', { headers })
  const createResponse = await app.request('/api/saved-views', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Review queue',
      visibility: 'personal',
      filters: { statuses: ['review'] },
      layout: { mode: 'table', sort: [], columns: ['title'] },
    }),
  })
  const updateResponse = await app.request('/api/saved-views/view-1', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ expectedRevision: 1, favorite: true }),
  })
  const deleteResponse = await app.request('/api/saved-views/view-1?expectedRevision=2', {
    method: 'DELETE',
    headers,
  })

  expect([listResponse.status, createResponse.status, updateResponse.status, deleteResponse.status])
    .toEqual([200, 201, 200, 200])
  expect(calls.lists).toHaveLength(1)
  expect(calls.creates).toHaveLength(1)
  expect(calls.creates[0]).toMatchObject({ idempotencyKey: 'saved-view-request-1' })
  expect(calls.updates).toHaveLength(1)
  expect(calls.deletes).toEqual([
    expect.objectContaining({ viewId: 'view-1', expectedRevision: 2 }),
  ])
})

test('keeps a primary mutation successful when search projection fails', async () => {
  configureFakeProjectClients(true)
  let projectedTitle: string | undefined
  configureApiClientsForTest({
    workspaceSearch: {
      async upsertDocument(document) {
        projectedTitle = document.title
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
    const response = await app.request('/api/teams', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Search resilient Team' }),
    })

    expect(response.status).toBe(201)
    expect(projectedTitle).toBe('Search resilient Team')
    expect(projectionErrors).toBe(1)
  } finally {
    console.error = originalConsoleError
  }
})

test('keeps a committed mutation successful when search document construction fails', async () => {
  configureFakeProjectClients(true)
  let projectionWrites = 0
  configureApiClientsForTest({
    workspaceSearch: {
      async upsertDocument(document) {
        projectionWrites += 1
        return createWorkspaceSearchDocument(document)
      },
    } as unknown as WorkspaceSearchClient,
  })
  const originalConsoleError = console.error
  let projectionErrors = 0
  console.error = () => {
    projectionErrors += 1
  }
  try {
    const response = await app.request('/api/teams', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'x'.repeat(501) }),
    })

    expect(response.status).toBe(201)
    expect(projectionWrites).toBe(0)
    expect(projectionErrors).toBe(1)
  } finally {
    console.error = originalConsoleError
  }
})

function createProjectMemberFixtureItems(
  options: {
    /** owner Team ambiguity を再現する追加 Team です。 */
    additionalTeams?: Array<{
      /** Team ID です。 */
      id: string
      /** Team 表示名です。 */
      name: string
      /** Team 配下 project 一覧です。 */
      projects: Array<{
        /** Project ID です。 */
        id: string
        /** Project 表示名です。 */
        name: string
        /** Project tone です。 */
        tone: 'blue' | 'purple' | 'green' | 'yellow'
      }>
    }>
    archivedProject?: boolean
    archivedTeam?: boolean
    includeOtherManager?: boolean
    includeTargetMember?: boolean
    targetRole?: ProjectRole
  } = {},
) {
  const includeOtherManager = options.includeOtherManager ?? true
  const includeTargetMember = options.includeTargetMember ?? true
  const targetRole = options.targetRole ?? 'manager'

  return [
    {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000000#TEAM#core-team',
      entryType: 'team',
      teamId: 'core-team',
      teamSortOrder: 10,
      nameJa: 'コアチーム',
      nameEn: 'Core Team',
      expanded: true,
      ...(options.archivedTeam ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
    },
    {
      directoryId: 'user#demo@example.com',
      entryKey: '000010#000010#PROJECT#refero',
      entryType: 'project',
      teamId: 'core-team',
      teamSortOrder: 10,
      projectId: 'refero',
      projectSortOrder: 10,
      nameJa: 'Refero',
      nameEn: 'Refero',
      tone: 'blue',
      ...(options.archivedProject ? { archivedAt: '2026-06-08T00:00:00.000Z' } : {}),
    },
    ...(includeTargetMember
      ? [
          {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#demo@example.com',
            entryType: 'project-member',
            projectId: 'refero',
            memberKey: 'demo@example.com',
            email: 'demo@example.com',
            role: targetRole,
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        ]
      : []),
    ...(includeOtherManager
      ? [
          {
            directoryId: 'user#demo@example.com',
            entryKey: 'PROJECT_MEMBER#refero#zmanager@example.com',
            entryType: 'project-member',
            projectId: 'refero',
            memberKey: 'zmanager@example.com',
            email: 'zmanager@example.com',
            role: 'manager',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        ]
      : []),
  ]
}

function createDirectoryMutationAuditContext() {
  return createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo-sub', kind: 'user' },
    idempotencyKey: 'directory-mutation-request',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'PATCH', path: '/api/projects/refero/members/demo@example.com' },
    source: { kind: 'api', requestId: 'directory-mutation-request' },
  })
}

function createFakeAuditEvent() {
  const context = createMutationAuditContext({
    workspaceId: 'user#demo@example.com',
    actor: { id: 'demo-sub', kind: 'user' },
    idempotencyKey: 'audit-export-request',
    occurredAt: '2026-07-12T00:00:00.000Z',
    request: { method: 'GET', path: '/api/audit/events/export' },
    source: { kind: 'api', requestId: 'audit-export-request' },
  })

  return createAuditEvent({
    context,
    eventType: 'project.updated',
    entity: { type: 'project', id: 'refero' },
  })
}

function createFileProofingStub(
  overrides: Partial<FileProofingClient> = {},
): FileProofingClient {
  const unsupported = async () => {
    throw new Error('Unexpected file proofing client call.')
  }
  return {
    list: unsupported,
    createUpload: unsupported,
    createVersionUpload: unsupported,
    completeUpload: unsupported,
    createAccess: unsupported,
    listAnnotations: unsupported,
    createAnnotation: unsupported,
    deleteFile: unsupported,
    createApproval: unsupported,
    decideApproval: unsupported,
    cancelApproval: unsupported,
    async getApprovalSummary() {
      return {
        pendingCount: 0,
        overdueCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        changesRequestedCount: 0,
      }
    },
    async getApprovalSummaries() {
      return new Map()
    },
    listReviewerApprovals: unsupported,
    ...overrides,
  } as FileProofingClient
}

function createCollaborationStub(
  overrides: Partial<CollaborationClient> = {},
): CollaborationClient {
  const unsupported = async () => {
    throw new Error('Unexpected collaboration client call.')
  }
  return {
    getThread: unsupported,
    hasAttachableComment: unsupported,
    getCommentSnapshot: unsupported,
    createComment: unsupported,
    updateComment: unsupported,
    deleteComment: unsupported,
    resolveComment: unsupported,
    reopenComment: unsupported,
    addReaction: unsupported,
    removeReaction: unsupported,
    getWatcherState: unsupported,
    subscribe: unsupported,
    unsubscribe: unsupported,
    heartbeatPresence: unsupported,
    leavePresence: unsupported,
    ...overrides,
  } satisfies CollaborationClient
}

function createFileUploadSessionFixture() {
  const version = {
    id: 'version-1',
    number: 1,
    fileName: 'proof.pdf',
    contentType: 'application/pdf',
    sizeBytes: 4096,
    scanStatus: 'pending' as const,
    previewKind: 'pdf' as const,
    createdByMemberKey: 'demo@example.com',
    createdAt: '2026-07-12T00:00:00.000Z',
  }
  return {
    file: {
      id: 'file-1',
      name: 'proof.pdf',
      targetType: 'work-item' as const,
      targetId: 'issue-1',
      versionCount: 1,
      versions: [version],
      currentVersion: version,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      capabilities: {
        canDownload: false,
        canUploadVersion: true,
        canDelete: true,
        canAnnotate: true,
        canRequestApproval: true,
      },
    },
    version,
    upload: {
      url: 'https://objects.example.test/upload',
      method: 'PUT' as const,
      headers: {
        'content-length': '4096',
        'content-type': 'application/pdf',
      },
      expiresAt: '2026-07-12T00:10:00.000Z',
      maxSizeBytes: 2_147_483_648,
    },
  }
}

/** Approval API route test で利用する標準 request fixture です。 */
function createApprovalRequestFixture(
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    id: 'approval-1',
    teamId: 'core-team',
    issueId: 'issue-1',
    revision: 1,
    fileId: 'file-1',
    versionId: 'version-1',
    status: 'pending',
    reviewers: [{ memberKey: 'sato@example.com', status: 'pending' }],
    dueAt: '2099-07-20T00:00:00.000Z',
    requestedByMemberKey: 'demo@example.com',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    capabilities: { canCancel: true, canDecide: false },
    ...overrides,
  }
}

/** API integration tests で利用する scope 固定済み Work Item configuration です。 */
function createTestWorkItemConfiguration(
  scopeType: 'workspace' | 'team',
  scopeId: string,
  revision = 0,
): WorkItemConfiguration {
  return {
    ...structuredClone(DEFAULT_WORK_ITEM_CONFIGURATION),
    scopeType,
    scopeId,
    revision,
  }
}

/** 関心のある method だけ上書きできる Work Item configuration client fake です。 */
function createFakeWorkItemConfigurationClient(
  overrides: Partial<WorkItemConfigurationClient> = {},
): WorkItemConfigurationClient {
  const createResolved = (scopeType: 'workspace' | 'team', scopeId: string) => ({
    configuration: createTestWorkItemConfiguration(scopeType, scopeId),
    inheritedFrom: 'default' as const,
  })
  return {
    async getWorkspaceConfiguration(workspaceId) {
      return createResolved('workspace', workspaceId)
    },
    async getTeamConfiguration(_workspaceId, teamId) {
      return createResolved('team', teamId)
    },
    async saveWorkspaceConfiguration(workspaceId, configuration, compatibilityCheck) {
      await compatibilityCheck()
      return {
        configuration: {
          ...configuration,
          scopeType: 'workspace',
          scopeId: workspaceId,
          revision: configuration.revision + 1,
        },
      }
    },
    async saveTeamConfiguration(_workspaceId, teamId, configuration, compatibilityCheck) {
      await compatibilityCheck()
      return {
        configuration: {
          ...configuration,
          scopeType: 'team',
          scopeId: teamId,
          revision: configuration.revision + 1,
        },
      }
    },
    async listRelations() {
      return { relations: [], graphRevision: 0 }
    },
    async createRelation(_workspaceId, _teamId, input) {
      return createFakeRelationMutationResponse(input)
    },
    async deleteRelation(_workspaceId, _teamId, input) {
      return createFakeRelationMutationResponse(input)
    },
    ...overrides,
  }
}

/** Client fake の既定 relation mutation response です。 */
function createFakeRelationMutationResponse(
  input: Parameters<WorkItemConfigurationClient['createRelation']>[2],
) {
  return {
    relation: {
      sourceWorkItemId: input.sourceWorkItemId,
      targetWorkItemId: input.targetWorkItemId,
      type: input.type,
    },
    reciprocalRelation: {
      sourceWorkItemId: input.targetWorkItemId,
      targetWorkItemId: input.sourceWorkItemId,
      type: input.type,
    },
    graphRevision: input.expectedGraphRevision + 1,
  }
}

function configureFakeProjectClients(
  hasProjectAccess: boolean,
  options: {
    /** Cognito user pagination fake が page ごとに返す user ID と token です。 */
    cognitoUserPages?: Array<{ userIds: string[]; nextToken?: string }>
    /** Cognito user 一覧 fake が返す次 page token です。 */
    cognitoUsersNextToken?: string
    profileError?: Error
    inactiveWorkspaceMemberKeys?: string[]
    mentionAccessDeniedMemberKeys?: string[]
    /** NEW_PASSWORD_REQUIRED challenge で Cognito が返す error です。 */
    newPasswordChallengeError?: CognitoServiceError
    newPasswordChallengeTokens?: boolean
    passwordAuthChallenge?: boolean
    passwordAuthTokens?: boolean
    projectAccesses?: Array<{ projectId: string; role?: ProjectRole }>
    role?: ProjectRole
    systemAdminMemberKeys?: string[]
    taskAssigneeUserId?: string
    /** Notification 認可で再取得する Work Item の現在 assigned Project ID です。 */
    detailAssignedProjectId?: string
    /** Work Item ID ごとに detail fake が返す現在 assigned Project ID です。 */
    detailAssignedProjectIds?: Record<string, string>
    /** Notification 認可で再取得する Work Item の現在担当者です。 */
    detailAssigneeUserId?: string
    /** Detail fake が返す現在の設定済み custom field values です。 */
    detailCustomFieldValues?: Record<string, CustomFieldValue>
    /** Detail fake が返す legacy search custom fields です。 */
    /** Detail fake が TeamIssueNotFound を返す Work Item ID です。 */
    detailMissingIssueIds?: string[]
    /** Work Item detail read の障害を再現する error です。 */
    detailReadError?: Error
    /** Work Item detail read の同時実行を観測または制御する hook です。 */
    detailReadHook?: (issueId: string) => Promise<void>
    /** Detail fake が返す現在の設定済み workflow status ID です。 */
    detailWorkflowStatusId?: string
    /** Detail fake が read ごとに返す workflow status ID です。 */
    detailWorkflowStatusIds?: string[]
    /** Detail fake が read ごとに返す更新日時です。 */
    detailUpdatedAts?: string[]
    teamProjects?: Array<{ id: string; name: string; tone: 'blue' | 'purple' | 'green' | 'yellow' }>
    /** owner Team ambiguity を再現する追加 Team です。 */
    additionalTeams?: Array<{
      /** Team ID です。 */
      id: string
      /** Team 表示名です。 */
      name: string
      /** Team 配下 project 一覧です。 */
      projects: Array<{
        /** Project ID です。 */
        id: string
        /** Project 表示名です。 */
        name: string
        /** Project tone です。 */
        tone: 'blue' | 'purple' | 'green' | 'yellow'
      }>
    }>
    /** Project 別 canonical Work Item fake が返す Issue ID です。 */
    canonicalProjectIssueIds?: string[]
    /** Team Issue fake が返す canonical Work Item 数です。 */
    teamIssueCount?: number
    /** Team Issue fake の先頭に置く閲覧不可 Work Item 数です。 */
    inaccessibleTeamIssueCount?: number
    unassignedIssue?: boolean
    workspaceRole?: WorkspaceRole
    workspaceReconcileFailures?: number
    workspaceStatus?: WorkspaceMemberStatus
    /** Invitation provisioning 時に Cognito user が存在しない状態を再現します。 */
    workspaceUserMissing?: boolean
    /** AdminCreateUser と競合して temporary-password user が作成された状態を再現します。 */
    workspaceProvisionRace?: boolean
  } = {},
) {
  const role = 'role' in options ? options.role : 'manager'
  const workspaceRole = options.workspaceRole ?? 'owner'
  const workspaceStatus = options.workspaceStatus ?? 'active'
  let workspaceReconcileFailures = options.workspaceReconcileFailures ?? 0
  const calls = {
    accessChecks: [] as Array<{ directoryId: string; projectId: string }>,
    directoryReads: [] as Array<{
      directoryId: string
      locale: string
      consistentRead?: boolean
    }>,
    memberDeletes: [] as Array<{ directoryId: string; projectId: string; memberKey: string }>,
    memberReads: [] as Array<{ directoryId: string; projectId: string }>,
    memberUpdates: [] as Array<{
      directoryId: string
      memberKey: string
      projectId: string
      role: string
    }>,
    projectArchives: [] as Array<{
      directoryId: string
      expectedPlanningRevision: number
      teamId: string
      projectId: string
    }>,
    projectCreates: [] as Array<{
      creatorUserKey: string
      directoryId: string
      name: string
      teamId: string
    }>,
    roleChecks: [] as Array<{ directoryId: string; memberKey: string; projectId: string }>,
    summaryReads: [] as Array<{
      directoryId: string
      isSystemAdmin: boolean
      userKey: string
    }>,
    teamArchives: [] as Array<{
      directoryId: string
      expectedPlanningRevision: number
      teamId: string
    }>,
    teamCreates: [] as Array<{ directoryId: string; name: string }>,
    issueComments: [] as Array<{ actorUserId: string; directoryId: string; issueId: string; teamId: string }>,
    issueCreates: [] as Array<{
      actorUserId: string
      assignedProjectId?: unknown
      directoryId: string
      teamId: string
      title: string
      statusCategory?: unknown
      workflowStatusId?: unknown
    }>,
    issueDetails: [] as Array<{
      directoryId: string
      issueId: string
      teamId: string
      readOptions?: {
        consistentIssueRead?: boolean
        eventCursor?: string
        eventLimit?: number
        eventType?: string
        newestEventsFirst?: boolean
      }
    }>,
    issueReads: [] as Array<{ directoryId: string; limit?: number; teamId: string }>,
    issueUpdates: [] as Array<{
      actorUserId: string
      assignedProjectId?: unknown
      directoryId: string
      issueId: string
      teamId: string
    }>,
    projectIssueReads: [] as Array<{ directoryId: string; limit?: number; projectId: string }>,
    taskReads: [] as Array<{ directoryId: string; limit?: number; projectId: string }>,
    userLists: [] as Array<{
      directoryId?: string
      limit?: number
      paginationToken?: string
      query?: string
    }>,
    userProfiles: [] as string[],
    workspaceInvitationResends: [] as string[],
    workspaceMemberUpdates: [] as Array<{
      expectedPlanningRevision: number
      memberKey: string
      role?: WorkspaceRole
      status?: WorkspaceMemberStatus
    }>,
    workspaceReconciliations: [] as string[],
  }
  const workspaceInvitationInputs = new Map<string, {
    name?: string
    role: WorkspaceRole
  }>()
  const createWorkspaceMember = (memberKey: string) => ({
    id: memberKey,
    memberKey,
    email: memberKey,
    name: memberKey === 'demo@example.com' ? 'Demo User' : undefined,
    role: memberKey === 'demo@example.com' ? workspaceRole : 'member' as WorkspaceRole,
    status: memberKey === 'demo@example.com'
      ? workspaceStatus
      : options.inactiveWorkspaceMemberKeys?.includes(memberKey)
        ? 'deactivated' as WorkspaceMemberStatus
        : 'active' as WorkspaceMemberStatus,
    version: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  })

  configureApiClientsForTest({
    collaboration: createCollaborationStub({
      async getThread() {
        return {
          comments: [],
          watch: {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          },
          presence: [],
        }
      },
      async getCommentSnapshot(input) {
        return {
          id: input.commentId,
          rootCommentId: input.commentId,
          authorMemberKey: 'demo@example.com',
          bodyMarkdown: 'Search body',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-06-08T01:00:00.000Z',
          updatedAt: '2026-06-08T01:00:00.000Z',
          reactions: [],
        }
      },
    }),
    cognito: {
      async initiatePasswordAuth() {
        if (options.passwordAuthChallenge) {
          return {
            ChallengeName: 'NEW_PASSWORD_REQUIRED',
            Session: 'new-password-session',
          }
        }

        if (options.passwordAuthTokens) {
          return { AuthenticationResult: createFakeAuthTokenSet() }
        }

        return {}
      },
      async respondToNewPasswordChallenge() {
        if (options.newPasswordChallengeError) {
          throw options.newPasswordChallengeError
        }

        if (options.newPasswordChallengeTokens) {
          return { AuthenticationResult: createFakeAuthTokenSet() }
        }

        return {}
      },
      async getUser() {
        return {
          Username: 'demo@example.com',
          UserAttributes: [
            {
              Name: 'email',
              Value: 'Demo@Example.com',
            },
          ],
        }
      },
      async listUsers(input) {
        calls.userLists.push(input)
        const page = options.cognitoUserPages?.[calls.userLists.length - 1]

        if (page) {
          return {
            users: page.userIds.map(createFakeCognitoProfile),
            nextToken: page.nextToken,
          }
        }

        return {
          users: [createFakeCognitoProfile('sato@example.com')],
          nextToken: options.cognitoUsersNextToken,
        }
      },
      async getUserProfile(userId) {
        calls.userProfiles.push(userId)

        if (options.profileError) {
          throw options.profileError
        }

        return createFakeCognitoProfile(userId)
      },
      async isSystemAdmin(userId) {
        return options.systemAdminMemberKeys?.includes(userId.toLowerCase()) ?? false
      },
      async findWorkspaceUser(userId) {
        if (options.workspaceUserMissing || options.workspaceProvisionRace) {
          return undefined
        }

        return {
          profile: {
            ...createFakeCognitoProfile(userId),
            status: 'FORCE_CHANGE_PASSWORD',
          },
          identityId: `sub-${userId.toLowerCase()}`,
          directoryId: 'user#demo@example.com',
        }
      },
      async provisionWorkspaceUser(input) {
        if (options.workspaceProvisionRace) {
          await input.beforeDirectoryClaimUpdate(`sub-${input.email}`, input.email)
          calls.workspaceInvitationResends.push(input.email)
          return {
            profile: {
              ...createFakeCognitoProfile(input.email),
              status: 'FORCE_CHANGE_PASSWORD',
            },
            cognitoIdentityId: `sub-${input.email}`,
            cognitoUsername: input.email,
            identityOwnership: 'ambiguous',
            directoryClaimCleanupRequired: true,
            deliveryStatus: 'sent',
          }
        }

        return {
          profile: createFakeCognitoProfile(input.email),
          cognitoIdentityId: `sub-${input.email}`,
          cognitoUsername: input.email,
          identityOwnership: input.existingUser ? 'pre-existing' : 'workspace-created',
          directoryClaimCleanupRequired: false,
          deliveryStatus: input.existingUser ? 'not-required' : 'sent',
        }
      },
      async resendWorkspaceUserInvitation(userId) {
        calls.workspaceInvitationResends.push(userId)
      },
      async deleteWorkspaceUser() {
        return 'deleted'
      },
      async unlinkWorkspaceUser() {},
    },
    dashboardSummary: {
      async getSummary(directoryId, accessContext) {
        calls.summaryReads.push({
          directoryId,
          isSystemAdmin: accessContext.isSystemAdmin,
          userKey: accessContext.userKey,
        })

        return {
          projects: 1,
          tasks: 1,
          blocked: 0,
          updatedAt: '2026-06-03T00:00:00.000Z',
          source: 'dynamodb',
        }
      },
    },
    workItemConfigurations: createFakeWorkItemConfigurationClient(),
    projectDirectory: {
      async getProjectDirectory(directoryId, locale, consistentRead) {
        calls.directoryReads.push({
          directoryId,
          locale,
          ...(consistentRead === undefined ? {} : { consistentRead }),
        })

        return {
          teams: [
            {
              id: 'core-team',
              name: locale === 'en' ? 'Core Team' : 'コアチーム',
              expanded: true,
              projects: options.teamProjects ?? [
                {
                  id: 'refero',
                  name: 'Refero',
                  tone: 'blue',
                },
              ],
            },
            ...(options.additionalTeams ?? []),
          ],
        }
      },
      async getProjectAccess(directoryId, projectId, memberKey = 'demo@example.com') {
        calls.accessChecks.push({ directoryId, projectId })

        if (options.mentionAccessDeniedMemberKeys?.includes(memberKey)) {
          return undefined
        }

        if (options.projectAccesses) {
          return options.projectAccesses.find((access) => access.projectId === projectId)
        }

        if (!hasProjectAccess) {
          return undefined
        }

        return {
          projectId,
          role,
        }
      },
      async getProjectAccessList(directoryId, memberKey = 'demo@example.com') {
        calls.accessChecks.push({ directoryId, projectId: '*' })

        if (options.mentionAccessDeniedMemberKeys?.includes(memberKey)) {
          return []
        }

        if (options.projectAccesses) {
          return options.projectAccesses
        }

        if (!hasProjectAccess) {
          return []
        }

        return [
          {
            projectId: 'refero',
            role,
          },
        ]
      },
      async hasProjectAccess(directoryId, projectId) {
        calls.accessChecks.push({ directoryId, projectId })

        return hasProjectAccess
      },
      async getProjectRole(directoryId, projectId, memberKey) {
        calls.roleChecks.push({ directoryId, projectId, memberKey })

        if (options.projectAccesses) {
          return options.projectAccesses.find((access) => access.projectId === projectId)?.role
        }

        return role
      },
      async getProjectMembers(directoryId, projectId) {
        calls.memberReads.push({ directoryId, projectId })

        return {
          projectId,
          members: [
            {
              id: 'demo@example.com',
              email: 'demo@example.com',
              role: 'manager',
              updatedAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      },
      async updateProjectMember(directoryId, projectId, memberKey, input) {
        calls.memberUpdates.push({
          directoryId,
          memberKey,
          projectId,
          role: String(input.role),
        })

        return {
          member: {
            id: memberKey,
            email: String(input.email ?? memberKey),
            name: typeof input.name === 'string' ? input.name : undefined,
            role: input.role === 'member' ? 'member' : input.role === 'manager' ? 'manager' : 'viewer',
            updatedAt: '2026-06-08T00:00:00.000Z',
          },
        }
      },
      async removeProjectMember(directoryId, projectId, memberKey) {
        calls.memberDeletes.push({ directoryId, projectId, memberKey })

        return {
          projectId,
          memberId: memberKey,
        }
      },
      async createTeam(directoryId, input) {
        calls.teamCreates.push({ directoryId, name: String(input.name) })

        return {
          team: {
            id: 'new-team',
            name: String(input.name),
            expanded: true,
            projects: [],
          },
        }
      },
      async createProject(directoryId, teamId, input, creator) {
        calls.projectCreates.push({
          creatorUserKey: creator.userKey,
          directoryId,
          name: String(input.name),
          teamId,
        })

        return {
          project: {
            id: 'new-project',
            name: String(input.name),
            tone: 'green',
          },
        }
      },
      async archiveTeam(directoryId, teamId, _auditContext, expectedPlanningRevision) {
        calls.teamArchives.push({ directoryId, expectedPlanningRevision, teamId })

        return {
          teamId,
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
      async archiveProject(
        directoryId,
        teamId,
        projectId,
        _auditContext,
        expectedPlanningRevision,
      ) {
        calls.projectArchives.push({ directoryId, expectedPlanningRevision, teamId, projectId })

        return {
          teamId,
          projectId,
          archivedAt: '2026-06-06T00:00:00.000Z',
        }
      },
    },
    workspaceAccess: {
      async getMember(_workspaceId, memberKey) {
        return createWorkspaceMember(memberKey)
      },
      async getActiveMember(_workspaceId, memberKey) {
        const member = createWorkspaceMember(memberKey)
        return member.status === 'active' ? member : undefined
      },
      async listActiveMembers() {
        return [
          createWorkspaceMember('demo@example.com'),
          createWorkspaceMember('sato@example.com'),
          createWorkspaceMember('suzuki@example.com'),
          createWorkspaceMember('viewer@example.com'),
        ].filter((member) => member.status === 'active')
      },
      async getAccessSnapshot(_workspaceId, memberKey) {
        const currentMember = createWorkspaceMember(memberKey)
        return {
          currentMember,
          members: [currentMember, createWorkspaceMember('sato@example.com')],
          invitations: [],
          capabilities: {
            canInvite: currentMember.role === 'owner' || currentMember.role === 'admin',
            canManageMembers: currentMember.role === 'owner' || currentMember.role === 'admin',
            canManageAdmins: currentMember.role === 'owner',
          },
        }
      },
      async getInvitation() {
        return undefined
      },
      async acquireInvitationAcceptanceLock() {
        return undefined
      },
      async releaseInvitationAcceptanceLock() {
        throw new Error('Acceptance lock fake is not configured for this test.')
      },
      async markInvitationIdentityMutationStarted(
        _workspaceId,
        invitationId,
        expectedVersion,
        cognitoIdentityId,
        cognitoUsername,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          name: workspaceInvitationInputs.get(invitationId)?.name,
          role: workspaceInvitationInputs.get(invitationId)?.role ?? 'member',
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          identityLifecycleVersion: 2,
          cognitoIdentityId,
          cognitoUsername,
          identityMutationAttempted: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationDirectoryClaimCleanupRequired(
        _workspaceId,
        invitationId,
        expectedVersion,
        cognitoIdentityId,
        cognitoUsername,
      ) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          cognitoIdentityId,
          cognitoUsername,
          directoryClaimCleanupRequired: true,
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async createInvitation(_workspaceId, _actorMemberKey, input) {
        workspaceInvitationInputs.set(input.email, { name: input.name, role: input.role })
        return {
          id: input.email,
          email: input.email,
          name: input.name,
          role: input.role,
          status: 'provisioning',
          deliveryStatus: 'pending',
          identityOwnership: 'ambiguous',
          version: 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationDelivery(_workspaceId, invitationId, input) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: input.deliveryStatus === 'failed' ? 'delivery-failed' : 'pending',
          deliveryStatus: input.deliveryStatus,
          identityOwnership: input.identityOwnership,
          cognitoIdentityId: input.cognitoIdentityId,
          cognitoUsername: input.cognitoUsername,
          directoryClaimCleanupRequired: input.directoryClaimCleanupRequired,
          version: input.expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationCleanupFailure(_workspaceId, invitationId, input) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          version: input.expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
          failureMessage: input.failureMessage,
        }
      },
      async clearInvitationCleanupFailure(_workspaceId, invitationId, expectedVersion) {
        return {
          id: invitationId,
          email: invitationId,
          role: 'member',
          status: 'revoked',
          deliveryStatus: 'not-required',
          identityOwnership: 'workspace-created',
          version: expectedVersion + 1,
          expiresAt: '2026-07-18T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }
      },
      async markInvitationManualCleanupRequired() {
        throw new Error('Manual invitation cleanup fake is not configured for this test.')
      },
      async acknowledgeInvitationManualCleanup() {
        throw new Error('Manual invitation cleanup acknowledgement fake is not configured for this test.')
      },
      async prepareResend() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async revokeInvitation() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async prepareReinvite() {
        throw new Error('Invitation fake is not configured for this test.')
      },
      async reconcileAuthenticatedMember(_workspaceId, input) {
        calls.workspaceReconciliations.push(input.memberKey)

        if (workspaceReconcileFailures > 0) {
          workspaceReconcileFailures -= 1
          throw new WorkspaceAccessError(
            503,
            'WorkspaceAccessUnavailable',
            'Workspace membership update failed.',
          )
        }

        return createWorkspaceMember(input.memberKey)
      },
      async updateMember(_workspaceId, _actorMemberKey, memberKey, input) {
        calls.workspaceMemberUpdates.push({
          expectedPlanningRevision: input.expectedPlanningRevision,
          memberKey,
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.status === undefined ? {} : { status: input.status }),
        })
        return {
          ...createWorkspaceMember(memberKey),
          role: input.role ?? createWorkspaceMember(memberKey).role,
          status: input.status ?? createWorkspaceMember(memberKey).status,
          version: input.expectedVersion + 1,
        }
      },
    },
    projectTasks: {
      async getProjectTasks(directoryId, projectId, readOptions) {
        calls.taskReads.push({
          directoryId,
          projectId,
          ...(readOptions?.limit === undefined ? {} : { limit: readOptions.limit }),
        })

        const tasks = ['wireframe'].map((taskId, index) => ({
          source: 'legacy' as const,
          id: taskId,
          ...(taskId === 'wireframe'
            ? { titleKey: 'tasks.item.wireframe' as const }
            : { title: `Legacy Work Item ${index}` }),
          assigneeKey: 'tasks.assignee.sato' as const,
          assigneeUserId: options.taskAssigneeUserId,
          status: 'in-progress' as const,
          dueDate: '2026/06/03',
          priority: 'high' as const,
        }))
        return {
          projectId,
          tasks: readOptions?.limit === undefined ? tasks : tasks.slice(0, readOptions.limit),
        }
      },
    },
    teamIssues: {
      async getTeamIssues(directoryId, teamId, readOptions) {
        calls.issueReads.push({
          directoryId,
          teamId,
          ...(readOptions?.limit === undefined ? {} : { limit: readOptions.limit }),
        })

        const issues = Array.from({ length: options.teamIssueCount ?? 1 }, (_, index) => ({
            schemaVersion: 1 as const,
            revision: 1,
            id: index === 0 ? 'onboarding-friction' : `work-item-${index}`,
            teamId,
            assignedProjectId: index < (options.inaccessibleTeamIssueCount ?? 0)
              ? 'private-project'
              : options.unassignedIssue ? undefined : 'refero',
            title: index === 0
              ? '初回オンボーディングの離脱要因を減らす'
              : `Work Item ${index}`,
            description: '初回体験の摩擦を下げる。',
            assigneeUserId: 'sato@example.com',
            creatorMemberKey: 'demo@example.com',
            workflowSchemaVersion: 1 as const,
            workflowStatusId: 'in-progress',
            statusCategory: 'started' as const,
            customFieldValues: {},
            relationIds: [],
            dueDate: '2026/06/18',
            priority: 'high' as const,
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
            source: 'dynamodb' as const,
          }))
        return {
          teamId,
          issues: readOptions?.limit === undefined ? issues : issues.slice(0, readOptions.limit),
        }
      },
      async getProjectIssues(directoryId, projectId, readOptions) {
        calls.projectIssueReads.push({
          directoryId,
          projectId,
          ...(readOptions?.limit === undefined ? {} : { limit: readOptions.limit }),
        })

        const issues = options.canonicalProjectIssueIds
          ? options.canonicalProjectIssueIds.map((issueId, index) => ({
              schemaVersion: 1 as const,
              revision: 1,
              id: issueId,
              teamId: 'core-team',
              assignedProjectId: projectId,
              title: `Canonical Work Item ${index}`,
              assigneeUserId: 'sato@example.com',
              creatorMemberKey: 'demo@example.com',
              workflowSchemaVersion: 1 as const,
              workflowStatusId: 'in-progress',
              statusCategory: 'started' as const,
              customFieldValues: {},
              relationIds: [],
              dueDate: '2026/06/18',
              priority: 'high' as const,
              createdAt: '2026-06-08T00:00:00.000Z',
              updatedAt: '2026-06-08T00:00:00.000Z',
              source: 'dynamodb' as const,
            }))
          : [
              {
                schemaVersion: 1 as const,
                revision: 1,
                id: 'onboarding-friction',
                teamId: 'core-team',
                assignedProjectId: projectId,
                title: '初回オンボーディングの離脱要因を減らす',
                assigneeUserId: 'sato@example.com',
                creatorMemberKey: 'demo@example.com',
                workflowSchemaVersion: 1 as const,
                workflowStatusId: 'in-progress',
                statusCategory: 'started' as const,
                customFieldValues: {},
                relationIds: [],
                dueDate: '2026/06/18',
                priority: 'high' as const,
                createdAt: '2026-06-08T00:00:00.000Z',
                updatedAt: '2026-06-08T00:00:00.000Z',
                source: 'dynamodb' as const,
              },
            ]
        return {
          projectId,
          issues: readOptions?.limit === undefined ? issues : issues.slice(0, readOptions.limit),
        }
      },
      async getTeamIssueDetail(directoryId, teamId, issueId, readOptions) {
        const detailReadIndex = calls.issueDetails.length
        calls.issueDetails.push({
          directoryId,
          teamId,
          issueId,
          ...(readOptions ? { readOptions } : {}),
        })
        await options.detailReadHook?.(issueId)

        if (options.detailReadError) {
          throw options.detailReadError
        }

        if (issueId === 'wireframe' || options.detailMissingIssueIds?.includes(issueId)) {
          throw {
            status: 404,
            code: 'TeamIssueNotFound',
            message: 'Issue was not found.',
          }
        }
        const workflowStatusId = options.detailWorkflowStatusIds?.[detailReadIndex] ??
          options.detailWorkflowStatusId ??
          'in-progress'

        return {
          issue: {
            schemaVersion: 1,
            revision: 1,
            id: issueId,
            teamId,
            assignedProjectId: options.detailAssignedProjectIds?.[issueId] ??
              (options.unassignedIssue
                ? undefined
                : options.detailAssignedProjectId ?? 'refero'),
            title: '初回オンボーディングの離脱要因を減らす',
            description: '初回体験の摩擦を下げる。',
            assigneeUserId: options.detailAssigneeUserId ?? 'sato@example.com',
            creatorMemberKey: 'demo@example.com',
            workflowSchemaVersion: 1,
            workflowStatusId,
            statusCategory:
              workflowStatusId === 'done' || workflowStatusId === 'approval-complete'
                ? 'completed'
                : 'started',
            customFieldValues: options.detailCustomFieldValues ?? {},
            relationIds: [],
            dueDate: '2026/06/18',
            priority: 'high',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: options.detailUpdatedAts?.[detailReadIndex] ??
              '2026-06-08T00:00:00.000Z',
            source: 'dynamodb',
          },
          comments: [
            {
              id: 'comment-1',
              actorUserId: 'demo@example.com',
              body: '背景を確認します。',
              createdAt: '2026-06-08T01:00:00.000Z',
            },
          ],
          activity: [
            {
              id: 'activity-1',
              type: 'created',
              actorUserId: 'demo@example.com',
              summary: 'Issue was created.',
              createdAt: '2026-06-08T00:00:00.000Z',
            },
          ],
        }
      },
      async createTeamIssue(directoryId, teamId, input, actorUserId) {
        calls.issueCreates.push({
          actorUserId,
          assignedProjectId: input.assignedProjectId,
          directoryId,
          teamId,
          title: String(input.title),
          ...(input.statusCategory === undefined
            ? {}
            : { statusCategory: input.statusCategory }),
          ...(input.workflowStatusId === undefined
            ? {}
            : { workflowStatusId: input.workflowStatusId }),
        })

        return {
          issue: {
            schemaVersion: 1,
            revision: 1,
            id: 'new-issue',
            teamId,
            assignedProjectId: typeof input.assignedProjectId === 'string'
              ? input.assignedProjectId
              : undefined,
            title: String(input.title),
            description: typeof input.description === 'string' ? input.description : undefined,
            assigneeUserId: String(input.assigneeUserId),
            creatorMemberKey: actorUserId,
            workflowSchemaVersion: 1,
            workflowStatusId: String(input.workflowStatusId),
            statusCategory: input.statusCategory === 'backlog' ||
              input.statusCategory === 'unstarted' ||
              input.statusCategory === 'started' ||
              input.statusCategory === 'completed' ||
              input.statusCategory === 'canceled'
              ? input.statusCategory
              : 'unstarted',
            customFieldValues: input.customFieldValues as Record<string, CustomFieldValue>,
            relationIds: [],
            dueDate: String(input.dueDate),
            priority: 'medium',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
            source: 'dynamodb',
          },
        }
      },
      async updateTeamIssue(directoryId, teamId, issueId, input, actorUserId) {
        calls.issueUpdates.push({
          actorUserId,
          assignedProjectId: input.assignedProjectId,
          directoryId,
          issueId,
          teamId,
        })

        return {
          issue: {
            schemaVersion: 1,
            revision: 2,
            id: issueId,
            teamId,
            assignedProjectId: typeof input.assignedProjectId === 'string'
              ? input.assignedProjectId
              : undefined,
            title: typeof input.title === 'string' ? input.title : '初回オンボーディングの離脱要因を減らす',
            assigneeUserId: typeof input.assigneeUserId === 'string' ? input.assigneeUserId : 'sato@example.com',
            creatorMemberKey: 'demo@example.com',
            workflowSchemaVersion: 1,
            workflowStatusId: typeof input.workflowStatusId === 'string'
              ? input.workflowStatusId
              : 'in-progress',
            statusCategory: input.statusCategory === 'backlog' ||
              input.statusCategory === 'unstarted' ||
              input.statusCategory === 'started' ||
              input.statusCategory === 'completed' ||
              input.statusCategory === 'canceled'
              ? input.statusCategory
              : 'started',
            customFieldValues: input.customFieldValues as Record<string, CustomFieldValue>,
            relationIds: [],
            dueDate: typeof input.dueDate === 'string' ? input.dueDate : '2026/06/18',
            priority: input.priority === 'low' ? 'low' : 'high',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T02:00:00.000Z',
            source: 'dynamodb',
          },
        }
      },
      async createTeamIssueComment(directoryId, teamId, issueId, input, actorUserId) {
        calls.issueComments.push({ actorUserId, directoryId, issueId, teamId })

        return {
          comment: {
            id: 'comment-2',
            actorUserId,
            body: String(input.body),
            createdAt: '2026-06-08T02:00:00.000Z',
          },
          activity: {
            id: 'activity-2',
            type: 'commented',
            actorUserId,
            summary: 'Comment was added.',
            createdAt: '2026-06-08T02:00:00.000Z',
          },
        }
      },
    },
  })

  return calls
}

function configureFakeAuthenticatedUser(
  attributes: Record<string, string>,
  onGetUser: () => void = () => undefined,
) {
  configureApiClientsForTest({
    cognito: {
      async initiatePasswordAuth() {
        return {}
      },
      async getUser() {
        onGetUser()

        return {
          Username: attributes.email ?? 'demo@example.com',
          UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })),
        }
      },
      async listUsers() {
        return { users: [] }
      },
      async getUserProfile(userId) {
        return createFakeCognitoProfile(userId)
      },
    },
  })
}

function createLambdaHttpEvent(rawPath: string, accessToken: string) {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${accessToken}`,
      host: 'example.lambda-url.us-east-1.on.aws',
    },
    body: null,
    isBase64Encoded: false,
    requestContext: {
      accountId: 'anonymous',
      apiId: 'function-url',
      authentication: null,
      authorizer: {},
      domainName: 'example.lambda-url.us-east-1.on.aws',
      domainPrefix: 'example',
      http: {
        method: 'GET',
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'bun:test',
      },
      requestId: 'request-id',
      routeKey: '$default',
      stage: '$default',
      time: '11/Jul/2026:00:00:00 +0000',
      timeEpoch: 1_783_728_000_000,
    },
  } satisfies Extract<LambdaEvent, { rawPath: string }>
}

async function withTestEnvironment(
  values: Record<string, string | undefined>,
  callback: () => Promise<void>,
) {
  const originalValues = new Map(
    Object.keys(values).map((name) => [name, Bun.env[name]]),
  )

  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete Bun.env[name]
    } else {
      Bun.env[name] = value
    }
  }

  try {
    await callback()
  } finally {
    for (const [name, value] of originalValues) {
      if (value === undefined) {
        delete Bun.env[name]
      } else {
        Bun.env[name] = value
      }
    }
  }
}

function createFakeCognitoProfile(userId: string) {
  const id = userId.trim().toLowerCase()
  const names: Record<string, string> = {
    'demo@example.com': 'Demo User',
    'sato@example.com': '佐藤 花子',
    'suzuki@example.com': '鈴木 太郎',
    'viewer@example.com': 'Viewer User',
  }

  return {
    id,
    username: id,
    email: id,
    name: names[id],
    enabled: true,
    status: 'CONFIRMED',
  }
}

function createFakeAuthTokenSet() {
  return {
    AccessToken: 'test-token',
    IdToken: 'test-id-token',
    RefreshToken: 'test-refresh-token',
    ExpiresIn: 3600,
    TokenType: 'Bearer',
  }
}

function createCognitoSdkTestError(name: string, status: number) {
  const error = new Error(`${name} from the Cognito SDK test double.`)
  error.name = name

  return Object.assign(error, {
    $metadata: { httpStatusCode: status },
  })
}

function createWorkspaceBootstrapItems() {
  return [
    {
      directoryId: 'workspace#production',
      entryKey: 'WORKSPACE#METADATA',
      entryType: 'workspace-metadata',
      workspaceId: 'workspace#production',
    },
    {
      directoryId: 'workspace#production',
      entryKey: 'WORKSPACE_MEMBER#owner@example.com',
      entryType: 'workspace-member',
      workspaceId: 'workspace#production',
      memberKey: 'owner@example.com',
      email: 'owner@example.com',
      username: 'owner-cognito-id',
      role: 'owner',
    },
    {
      directoryId: 'workspace#production',
      entryKey: 'EMAIL_ALIAS#owner@example.com',
      entryType: 'email-alias',
      workspaceId: 'workspace#production',
      memberKey: 'owner@example.com',
      email: 'owner@example.com',
      username: 'owner-cognito-id',
    },
  ]
}

function createAccessToken(groups: string[] = [], claims: Record<string, unknown> = {}) {
  const payload = Buffer
    .from(JSON.stringify({ ...claims, 'cognito:groups': groups }))
    .toString('base64url')

  return `header.${payload}.signature`
}

function planningApiRequest(path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function createCyclePlanningInput(id: string, expectedRevision: number) {
  return {
    id,
    type: 'cycle' as const,
    title: `Cycle ${id}`,
    teamId: 'core-team',
    projectId: 'refero',
    ownerMemberKey: 'demo@example.com',
    status: 'active' as const,
    health: 'on-track' as const,
    risk: 'low' as const,
    progressMode: 'automatic' as const,
    baseline: { startDate: '2026-07-01', endDate: '2026-07-14' },
    forecast: { startDate: '2026-07-01', endDate: '2026-07-14' },
    cadence: { unit: 'week' as const, count: 2 },
    capacity: 10,
    carryOverPolicy: 'move-incomplete' as const,
    expectedRevision,
  }
}

async function seedPlanningWorkspaceParentAndScopedChild(
  planningClient: InMemoryPlanningClient,
) {
  await planningClient.create('user#demo@example.com', {
    ...createCyclePlanningInput('portfolio-scope-parent', 0),
    type: 'portfolio',
    title: 'Workspace portfolio',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
  await planningClient.create('user#demo@example.com', {
    ...createCyclePlanningInput('roadmap-scoped-child', 1),
    type: 'roadmap',
    title: 'Scoped roadmap',
    parentId: 'portfolio-scope-parent',
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
}

test('returns an authenticated empty Planning graph with accessible Work Item projections', async () => {
  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  configureApiClientsForTest({ planning: new InMemoryPlanningClient() })

  const response = await planningApiRequest('/api/planning')

  expect(response.status).toBe(200)
  const planning = await response.json() as PlanningSnapshot
  expect(planning).toMatchObject({
    schemaVersion: 1,
    revision: 0,
    entities: [],
    dependencies: [],
    workItemLinks: [],
  })
  expect(planning.workItems).toEqual([
    expect.objectContaining({
      id: 'onboarding-friction',
      teamId: 'core-team',
      projectId: 'refero',
      statusCategory: 'started',
    }),
  ])
})

test('lets managers build a scoped hierarchy and dependency graph', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  configureApiClientsForTest({ planning: new InMemoryPlanningClient() })

  const portfolio = await planningApiRequest('/api/planning/entities', 'POST', {
    id: 'portfolio-1',
    type: 'portfolio',
    title: 'Company portfolio',
    ownerMemberKey: 'demo@example.com',
    status: 'active',
    health: 'on-track',
    risk: 'low',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
    expectedRevision: 0,
  })
  expect(portfolio.status).toBe(201)

  for (const [index, id] of ['roadmap-a', 'roadmap-b'].entries()) {
    const response = await planningApiRequest('/api/planning/entities', 'POST', {
      id,
      type: 'roadmap',
      title: id,
      parentId: 'portfolio-1',
      teamId: 'core-team',
      projectId: 'refero',
      ownerMemberKey: 'demo@example.com',
      status: 'planned',
      health: 'on-track',
      risk: 'low',
      progressMode: 'automatic',
      baseline: { startDate: '2026-07-01', endDate: '2026-07-31' },
      forecast: { startDate: '2026-07-01', endDate: '2026-07-31' },
      expectedRevision: index + 1,
    })
    expect(response.status).toBe(201)
  }

  const dependency = await planningApiRequest('/api/planning/dependencies', 'POST', {
    id: 'dependency-1',
    predecessorId: 'roadmap-a',
    successorId: 'roadmap-b',
    type: 'finish-to-start',
    lagDays: 2,
    expectedRevision: 3,
  })

  expect(dependency.status).toBe(201)
  const planning = await dependency.json() as PlanningSnapshot
  expect(planning.revision).toBe(4)
  expect(planning.dependencies).toEqual([
    expect.objectContaining({
      id: 'dependency-1',
      predecessorId: 'roadmap-a',
      successorId: 'roadmap-b',
    }),
  ])
})

test('requires parent scope permission when creating a Planning child', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  configureApiClientsForTest({ planning: planningClient })

  const parent = await planningApiRequest('/api/planning/entities', 'POST', {
    id: 'portfolio-protected',
    type: 'portfolio',
    title: 'Protected Workspace portfolio',
    ownerMemberKey: 'demo@example.com',
    status: 'active',
    health: 'on-track',
    risk: 'low',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
    expectedRevision: 0,
  })
  expect(parent.status).toBe(201)

  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const child = await planningApiRequest('/api/planning/entities', 'POST', {
    id: 'roadmap-denied',
    type: 'roadmap',
    title: 'Project roadmap',
    parentId: 'portfolio-protected',
    teamId: 'core-team',
    projectId: 'refero',
    ownerMemberKey: 'demo@example.com',
    status: 'planned',
    health: 'on-track',
    risk: 'low',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-01', endDate: '2026-07-31' },
    forecast: { startDate: '2026-07-01', endDate: '2026-07-31' },
    expectedRevision: 1,
  })

  expect(child.status).toBe(403)
  const snapshot = await planningClient.get('user#demo@example.com', { workItems: [] })
  expect(snapshot.revision).toBe(1)
  expect(snapshot.entities.map((entity) => entity.id)).toEqual(['portfolio-protected'])
})

test('requires inherited parent permission when duplicate omits parentId', async () => {
  const planningClient = new InMemoryPlanningClient()
  await seedPlanningWorkspaceParentAndScopedChild(planningClient)
  let duplicateCalls = 0
  const duplicate = planningClient.duplicate.bind(planningClient)
  planningClient.duplicate = async (...input) => {
    duplicateCalls += 1
    return duplicate(...input)
  }
  configureFakeProjectClients(true, {
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
    workspaceRole: 'member',
  })
  configureApiClientsForTest({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/entities/roadmap-scoped-child/duplicate',
    'POST',
    { targetId: 'roadmap-denied-copy', expectedRevision: 2 },
  )

  expect(response.status).toBe(403)
  expect(duplicateCalls).toBe(0)
})

test('requires manager permission for every active descendant before subtree move', async () => {
  const planningClient = new InMemoryPlanningClient()
  await seedPlanningWorkspaceParentAndScopedChild(planningClient)
  let moveCalls = 0
  const move = planningClient.move.bind(planningClient)
  planningClient.move = async (...input) => {
    moveCalls += 1
    return move(...input)
  }
  configureFakeProjectClients(true, {
    projectAccesses: [],
    workspaceRole: 'owner',
  })
  configureApiClientsForTest({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/entities/portfolio-scope-parent/move',
    'POST',
    { expectedRevision: 2 },
  )

  expect(response.status).toBe(403)
  expect(moveCalls).toBe(0)
})

test('denies guest Planning writes before invoking a mutation client', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'guest' })
  const planningClient = new InMemoryPlanningClient()
  const create = planningClient.create.bind(planningClient)
  let createCalls = 0
  planningClient.create = async (...input) => {
    createCalls += 1
    return create(...input)
  }
  configureApiClientsForTest({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('guest-cycle', 0),
  )

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    message: 'Guest members have read-only Workspace access.',
  })
  expect(createCalls).toBe(0)
})

test('enforces Planning revisions and structural permissions before mutations', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  configureApiClientsForTest({ planning: planningClient })
  const created = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('cycle-structural', 0),
  )
  expect(created.status).toBe(201)

  const malformedPatch = await planningApiRequest(
    '/api/planning/entities/cycle-structural',
    'PATCH',
    { expectedRevision: 1 },
  )
  expect(malformedPatch.status).toBe(400)
  expect(await malformedPatch.json()).toMatchObject({ code: 'PlanningPatchInvalid' })

  const structuralCalls = { archive: 0, duplicate: 0, move: 0 }
  const archive = planningClient.archive.bind(planningClient)
  const duplicate = planningClient.duplicate.bind(planningClient)
  const move = planningClient.move.bind(planningClient)
  planningClient.archive = async (...input) => {
    structuralCalls.archive += 1
    return archive(...input)
  }
  planningClient.duplicate = async (...input) => {
    structuralCalls.duplicate += 1
    return duplicate(...input)
  }
  planningClient.move = async (...input) => {
    structuralCalls.move += 1
    return move(...input)
  }

  const futureRevision = await planningApiRequest(
    '/api/planning/entities/cycle-structural/archive',
    'POST',
    { expectedRevision: 2 },
  )
  expect(futureRevision.status).toBe(409)
  expect(await futureRevision.json()).toMatchObject({ code: 'PlanningRevisionConflict' })
  expect(structuralCalls.archive).toBe(0)

  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  const memberArchive = await planningApiRequest(
    '/api/planning/entities/cycle-structural/archive',
    'POST',
    { expectedRevision: 1 },
  )
  expect(memberArchive.status).toBe(403)

  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  const viewerDuplicate = await planningApiRequest(
    '/api/planning/entities/cycle-structural/duplicate',
    'POST',
    { targetId: 'cycle-viewer-copy', expectedRevision: 1 },
  )
  expect(viewerDuplicate.status).toBe(403)

  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const rootMove = await planningApiRequest(
    '/api/planning/entities/cycle-structural/move',
    'POST',
    { expectedRevision: 1 },
  )
  expect(rootMove.status).toBe(403)
  expect(structuralCalls).toEqual({ archive: 0, duplicate: 0, move: 0 })

  const managerDuplicate = await planningApiRequest(
    '/api/planning/entities/cycle-structural/duplicate',
    'POST',
    { targetId: 'cycle-manager-copy', expectedRevision: 1 },
  )
  expect(managerDuplicate.status).toBe(201)
  const duplicatedPlanning = await managerDuplicate.json() as PlanningSnapshot
  expect(duplicatedPlanning.revision).toBe(2)

  const managerMove = await planningApiRequest(
    '/api/planning/entities/cycle-manager-copy/move',
    'POST',
    { teamId: 'core-team', projectId: 'refero', expectedRevision: 2 },
  )
  expect(managerMove.status).toBe(200)
  const movedPlanning = await managerMove.json() as PlanningSnapshot
  expect(movedPlanning.revision).toBe(3)

  const managerArchive = await planningApiRequest(
    '/api/planning/entities/cycle-structural/archive',
    'POST',
    { expectedRevision: 3 },
  )
  expect(managerArchive.status).toBe(200)
  const archivedPlanning = await managerArchive.json() as PlanningSnapshot
  expect(archivedPlanning.revision).toBe(4)
  expect(archivedPlanning.entities.find((entity) => entity.id === 'cycle-structural')?.archivedAt)
    .toBeDefined()
  expect(structuralCalls).toEqual({ archive: 1, duplicate: 1, move: 1 })
})

test('requires Workspace administration for unscoped status updates', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  configureApiClientsForTest({ planning: planningClient })
  const created = await planningApiRequest('/api/planning/entities', 'POST', {
    id: 'portfolio-workspace',
    type: 'portfolio',
    title: 'Workspace portfolio',
    ownerMemberKey: 'demo@example.com',
    status: 'active',
    health: 'on-track',
    risk: 'low',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
    expectedRevision: 0,
  })
  expect(created.status).toBe(201)

  let statusUpdateCalls = 0
  const addStatusUpdate = planningClient.addStatusUpdate.bind(planningClient)
  planningClient.addStatusUpdate = async (...input) => {
    statusUpdateCalls += 1
    return addStatusUpdate(...input)
  }
  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })

  const response = await planningApiRequest(
    '/api/planning/entities/portfolio-workspace/status-updates',
    'POST',
    {
      id: 'status-workspace',
      message: 'Member must not update Workspace scope.',
      health: 'at-risk',
      expectedRevision: 1,
    },
  )

  expect(response.status).toBe(403)
  expect(statusUpdateCalls).toBe(0)
})

test('rejects an inactive Planning owner before invoking the mutation client', async () => {
  const planningClient = new InMemoryPlanningClient()
  let createCalls = 0
  const create = planningClient.create.bind(planningClient)
  planningClient.create = async (...input) => {
    createCalls += 1
    return create(...input)
  }
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'owner',
    inactiveWorkspaceMemberKeys: ['inactive@example.com'],
  })
  configureApiClientsForTest({ planning: planningClient })

  const response = await planningApiRequest('/api/planning/entities', 'POST', {
    id: 'portfolio-inactive-owner',
    type: 'portfolio',
    title: 'Invalid owner portfolio',
    ownerMemberKey: 'inactive@example.com',
    status: 'planned',
    health: 'on-track',
    risk: 'none',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
    expectedRevision: 0,
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'PlanningOwnerInactive' })
  expect(createCalls).toBe(0)
})

test('rejects duplicate when the source Planning owner became inactive', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  configureApiClientsForTest({ planning: planningClient })
  const created = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    {
      ...createCyclePlanningInput('cycle-inactive-owner', 0),
      ownerMemberKey: 'former-owner@example.com',
    },
  )
  expect(created.status).toBe(201)

  let duplicateCalls = 0
  const duplicate = planningClient.duplicate.bind(planningClient)
  planningClient.duplicate = async (...input) => {
    duplicateCalls += 1
    return duplicate(...input)
  }
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    inactiveWorkspaceMemberKeys: ['former-owner@example.com'],
  })

  const response = await planningApiRequest(
    '/api/planning/entities/cycle-inactive-owner/duplicate',
    'POST',
    { targetId: 'cycle-inactive-owner-copy', expectedRevision: 1 },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'PlanningOwnerInactive' })
  expect(duplicateCalls).toBe(0)
})

test('lets Project members link Work Items to Workspace-scope strategic goals', async () => {
  const planningClient = new InMemoryPlanningClient()
  const workspaceId = 'user#demo@example.com'
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 0),
    id: 'portfolio-strategy',
    type: 'portfolio',
    title: 'Strategy portfolio',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 1),
    id: 'roadmap-strategy',
    type: 'roadmap',
    title: 'Strategy roadmap',
    parentId: 'portfolio-strategy',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 2),
    id: 'initiative-strategy',
    type: 'initiative',
    title: 'Strategy initiative',
    parentId: 'roadmap-strategy',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 3),
    id: 'objective-strategy',
    type: 'goal',
    title: 'Strategy objective',
    parentId: 'initiative-strategy',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
    goalFramework: 'objective',
  }, { workItems: [] })
  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  configureApiClientsForTest({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'refero',
      goalIds: ['objective-strategy'],
      expectedRevision: 4,
    },
  )

  expect(response.status).toBe(200)
  expect((await response.json() as PlanningSnapshot).workItemLinks[0]?.goalIds)
    .toEqual(['objective-strategy'])
})

test('requires old Planning scope permission when re-linking a moved Work Item', async () => {
  const planningClient = new InMemoryPlanningClient()
  const workspaceId = 'user#demo@example.com'
  const oldWorkItemState = {
    workItems: [{
      id: 'onboarding-friction',
      revision: 1,
      teamId: 'core-team',
      title: 'Moved Work Item',
      projectId: 'refero',
      statusCategory: 'started' as const,
      dueDate: '2026-08-31',
    }],
  }
  await planningClient.create(
    workspaceId,
    createCyclePlanningInput('cycle-project-a', 0),
    oldWorkItemState,
  )
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('cycle-project-b', 1),
    projectId: 'project-b',
  }, oldWorkItemState)
  await planningClient.putWorkItemLink(workspaceId, {
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    projectId: 'refero',
    cycleId: 'cycle-project-a',
    goalIds: [],
    expectedRevision: 2,
  }, oldWorkItemState)
  let putCalls = 0
  const putWorkItemLink = planningClient.putWorkItemLink.bind(planningClient)
  planningClient.putWorkItemLink = async (...input) => {
    putCalls += 1
    return putWorkItemLink(...input)
  }
  configureFakeProjectClients(true, {
    detailAssignedProjectId: 'project-b',
    projectAccesses: [{ projectId: 'project-b', role: 'member' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'project-b', name: 'Project B', tone: 'green' },
    ],
    workspaceRole: 'member',
  })
  configureApiClientsForTest({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'project-b',
      cycleId: 'cycle-project-b',
      goalIds: [],
      expectedRevision: 3,
    },
  )

  expect(response.status).toBe(403)
  expect(putCalls).toBe(0)
})

test('lets Workspace owners clean up inaccessible stale Work Item links', async () => {
  const planningClient = new InMemoryPlanningClient()
  const workspaceId = 'user#demo@example.com'
  const staleWorkItemState = {
    workItems: [{
      id: 'missing-work-item',
      revision: 1,
      teamId: 'core-team',
      title: 'Deleted later',
      projectId: 'refero',
      statusCategory: 'unstarted' as const,
      dueDate: '2026-08-31',
    }],
  }
  await planningClient.create(
    workspaceId,
    createCyclePlanningInput('cycle-stale-link', 0),
    staleWorkItemState,
  )
  await planningClient.putWorkItemLink(workspaceId, {
    teamId: 'core-team',
    workItemId: 'missing-work-item',
    projectId: 'refero',
    cycleId: 'cycle-stale-link',
    goalIds: [],
    expectedRevision: 1,
  }, staleWorkItemState)
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  configureApiClientsForTest({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/work-item-links/core-team/missing-work-item',
    'DELETE',
    { expectedRevision: 2 },
  )

  expect(response.status).toBe(200)
  const planning = await response.json() as PlanningSnapshot
  expect(planning.revision).toBe(3)
  expect(planning.workItemLinks).toEqual([])
})

test('lets members add status updates and link accessible canonical Work Items', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  configureApiClientsForTest({ planning: planningClient })
  const created = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('cycle-current', 0),
  )
  expect(created.status).toBe(201)

  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  const statusUpdate = await planningApiRequest(
    '/api/planning/entities/cycle-current/status-updates',
    'POST',
    {
      id: 'status-1',
      message: 'Delivery is proceeding.',
      health: 'on-track',
      expectedRevision: 1,
    },
  )
  expect(statusUpdate.status).toBe(201)
  const statusPlanning = await statusUpdate.json() as PlanningSnapshot
  expect(statusPlanning.entities[0]?.statusUpdates[0]).toMatchObject({
    id: 'status-1',
    authorMemberKey: 'demo@example.com',
  })

  const malformedLink = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'refero',
      cycleId: 'cycle-current',
      expectedRevision: 2,
    },
  )
  expect(malformedLink.status).toBe(400)
  expect(await malformedLink.json()).toMatchObject({ code: 'InvalidPlanningInput' })

  const linked = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'refero',
      cycleId: 'cycle-current',
      goalIds: [],
      expectedRevision: 2,
    },
  )

  expect(linked.status).toBe(200)
  const linkedPlanning = await linked.json() as PlanningSnapshot
  expect(linkedPlanning.workItemLinks).toEqual([
    expect.objectContaining({
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      cycleId: 'cycle-current',
    }),
  ])
  expect(linkedPlanning.entities[0]).toMatchObject({
    linkedWorkItemCount: 1,
    progress: 50,
  })
})

test('returns revision conflicts and reproducibly rolls incomplete Work Items forward', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  configureApiClientsForTest({ planning: new InMemoryPlanningClient() })

  const source = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('cycle-source', 0),
  )
  expect(source.status).toBe(201)
  const target = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    {
      ...createCyclePlanningInput('cycle-target', 1),
      baseline: { startDate: '2026-07-15', endDate: '2026-07-28' },
      forecast: { startDate: '2026-07-15', endDate: '2026-07-28' },
    },
  )
  expect(target.status).toBe(201)
  const linked = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'refero',
      cycleId: 'cycle-source',
      goalIds: [],
      expectedRevision: 2,
    },
  )
  expect(linked.status).toBe(200)

  const conflict = await planningApiRequest(
    '/api/planning/cycles/cycle-source/rollover',
    'POST',
    { targetCycleId: 'cycle-target', expectedRevision: 2 },
  )
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ code: 'PlanningRevisionConflict' })

  const rolledOver = await planningApiRequest(
    '/api/planning/cycles/cycle-source/rollover',
    'POST',
    { targetCycleId: 'cycle-target', expectedRevision: 3 },
  )
  expect(rolledOver.status).toBe(200)
  const body = await rolledOver.json() as PlanningMutationResponse
  expect(body.movedWorkItemIds).toEqual(['onboarding-friction'])
  expect(body.retainedWorkItemIds).toEqual([])
  expect(body.planning.revision).toBe(4)
  expect(body.planning.workItemLinks[0]?.cycleId).toBe('cycle-target')
  expect(body.planning.entities.find((entity) => entity.id === 'cycle-source')?.status)
    .toBe('completed')
})
