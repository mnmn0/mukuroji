import { afterEach, describe, expect, test } from 'bun:test'
import {
  AI_ASSISTANCE_SCHEMA_VERSION,
  DOCUMENT_SCHEMA_VERSION,
  REQUEST_FORM_SCHEMA_VERSION,
  REQUEST_SUBMISSION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  type AiAssistanceGeneration,
  type AiAssistanceTask,
  type DocumentComment,
  type DocumentDetail,
  type GenerateAiAssistanceRequest,
  type RequestSubmission,
  type TriageEntry,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import type {
  AiAssistanceService,
  ResolvedAiAssistanceContext,
} from '../modules/ai-assistance'
import { AiAssistanceError } from '../modules/ai-assistance'
import type { TriageCompositionClient } from '../app/composition/app-dependencies'
import { InMemoryEnterpriseIdentityClient } from '../modules/enterprise-identity/enterprise-identity'
import type { RequestIntakeClient } from '../modules/request-intake'
import type { TeamIssueResponseItem } from '../modules/work-items'
import type { WorkspaceMember } from '../modules/workspace-access'
import type { WorkspaceSearchClient } from '../modules/workspace-search/workspace-search'
import { createApiTestHarness } from './test-support/api-test-harness'

const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  createBulkRecoveryIssue,
  createCollaborationStub,
  createDocumentFake,
  createFakeWorkItemConfigurationClient,
  createTeamIssuesFake,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()

/** Stable fixture instant used by AI source projections. */
const NOW = '2026-08-25T00:00:00.000Z'

/** Returns authenticated JSON headers for an AI generation request. */
function createAiHeaders(): Record<string, string> {
  return {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'ai-request-1',
  }
}

/**
 * Creates a complete AI service fake around the operations needed by one test.
 *
 * @param overrides - Explicit service operations exercised by the test.
 * @returns A fail-fast service whose unrelated operations never reach persistence or Bedrock.
 */
function createAiService(
  overrides: Partial<AiAssistanceService> = {},
): AiAssistanceService {
  /** Rejects an AI operation that the focused test did not configure. */
  async function unsupported(): Promise<never> {
    throw new Error('Unexpected AI assistance service call.')
  }
  return {
    getPolicy: unsupported,
    updatePolicy: unsupported,
    getPreference: unsupported,
    updatePreference: unsupported,
    generate: unsupported,
    getGeneration: unsupported,
    decideGeneration: unsupported,
    createFeedback: unsupported,
    ...overrides,
  }
}

/**
 * Creates an Enterprise identity snapshot granting only `workspace.read` at Workspace scope.
 *
 * @returns In-memory Enterprise identity client for the authenticated test member.
 */
async function createWorkspaceReadOnlyEnterpriseIdentity(): Promise<
  InMemoryEnterpriseIdentityClient
> {
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:ai-workspace-reader',
    name: 'AI Workspace reader',
    permissions: ['workspace.read'],
    guestAssignable: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const readSnapshot = identity.getSnapshot.bind(identity)
  identity.getSnapshot = async (currentWorkspaceId) => {
    const snapshot = await readSnapshot(currentWorkspaceId)
    return {
      ...snapshot,
      roleAssignments: [{
        workspaceId,
        assignmentId: 'ai-workspace-reader-assignment',
        principalKind: 'member',
        principalId: 'demo@example.com',
        roleId: 'custom:ai-workspace-reader',
        scope: { workspaceId, kind: 'workspace' },
        source: 'direct',
      }],
    }
  }
  return identity
}

/**
 * Creates a rejected Request Intake operation for a source that authorization must not read.
 *
 * @param operation - Port method that must remain unreachable.
 * @param onCall - Observer invoked if the method is reached.
 * @returns Fail-fast async port implementation.
 */
function createUnexpectedAiRequestIntakeCall(
  operation: keyof RequestIntakeClient,
  onCall: () => void = () => undefined,
): () => Promise<never> {
  return async () => {
    onCall()
    throw new Error(`Unexpected RequestIntakeClient call: ${operation}`)
  }
}

/**
 * Creates a Request Intake client that fails if the AI resolver reaches any source operation.
 *
 * @param onSubmissionRead - Observer for a forbidden submission read.
 * @returns Complete fail-fast Request Intake client.
 */
function createUnreachableRequestIntakeClient(
  onSubmissionRead: () => void,
): RequestIntakeClient {
  return {
    listForms: createUnexpectedAiRequestIntakeCall('listForms'),
    getForm: createUnexpectedAiRequestIntakeCall('getForm'),
    createForm: createUnexpectedAiRequestIntakeCall('createForm'),
    updateForm: createUnexpectedAiRequestIntakeCall('updateForm'),
    publishForm: createUnexpectedAiRequestIntakeCall('publishForm'),
    resolveLink: createUnexpectedAiRequestIntakeCall('resolveLink'),
    getPublicForm: createUnexpectedAiRequestIntakeCall('getPublicForm'),
    createAttachmentUpload: createUnexpectedAiRequestIntakeCall('createAttachmentUpload'),
    submit: createUnexpectedAiRequestIntakeCall('submit'),
    listSubmissions: createUnexpectedAiRequestIntakeCall('listSubmissions'),
    getSubmission: createUnexpectedAiRequestIntakeCall('getSubmission', onSubmissionRead),
    applyAction: createUnexpectedAiRequestIntakeCall('applyAction'),
    completeConversion: createUnexpectedAiRequestIntakeCall('completeConversion'),
    getRequesterThread: createUnexpectedAiRequestIntakeCall('getRequesterThread'),
    replyToThread: createUnexpectedAiRequestIntakeCall('replyToThread'),
    ingestEmail: createUnexpectedAiRequestIntakeCall('ingestEmail'),
    createAttachmentAccess: createUnexpectedAiRequestIntakeCall('createAttachmentAccess'),
  }
}

/**
 * Creates a safe withheld generation response for a failed current-source fence.
 *
 * @param task - Workflow requested by the operator.
 * @param reasonCode - Current authorization reason supplied by the resolver.
 * @returns A generation envelope that contains no model or source content.
 */
function createWithheldGeneration(
  task: AiAssistanceTask,
  reasonCode: 'permission-changed' | 'source-changed',
): AiAssistanceGeneration {
  return {
    schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
    id: 'generation-1',
    task,
    revision: 1,
    content: { availability: 'withheld', reasonCode },
    details: {
      provider: 'bedrock',
      modelId: 'model-1',
      promptVersion: 'ai-assistance-v1',
      traceId: 'trace-1',
      usage: {
        latencyMs: 1,
        costUnavailableReason: 'pricing-not-configured',
      },
    },
    createdAt: NOW,
    expiresAt: '2026-09-24T00:00:00.000Z',
  }
}

/**
 * Creates an available Search generation for a resolver-only route test.
 *
 * @returns A valid structured Search draft without executing Workspace Search.
 */
function createSearchGeneration(): AiAssistanceGeneration {
  return {
    schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
    id: 'generation-search-1',
    task: 'search',
    revision: 1,
    content: {
      availability: 'available',
      draft: {
        kind: 'search',
        interpretation: '未完了のWork Item',
        filters: { statuses: ['in-progress'] },
        caveats: [],
      },
      citations: [],
      uncertainty: { level: 'low', reason: 'Visible filter metadata is sufficient.' },
    },
    details: {
      provider: 'bedrock',
      modelId: 'model-1',
      promptVersion: 'ai-assistance-v1',
      traceId: 'trace-search-1',
      usage: {
        latencyMs: 1,
        costUnavailableReason: 'pricing-not-configured',
      },
    },
    createdAt: NOW,
    expiresAt: '2026-09-24T00:00:00.000Z',
  }
}

/**
 * Wraps the existing Search port and fails if AI filter interpretation executes a search.
 *
 * @param client - Existing suite-owned Search port used for unrelated capabilities.
 * @param onSearch - Observer invoked if the forbidden search operation is reached.
 * @returns A complete Search port with an instrumented search method.
 */
function createNonExecutingWorkspaceSearch(
  client: WorkspaceSearchClient,
  onSearch: () => void,
): WorkspaceSearchClient {
  return {
    upsertDocument: (input, options) => client.upsertDocument(input, options),
    deleteDocument: (workspaceId, entityType, entityId, options) =>
      client.deleteDocument(workspaceId, entityType, entityId, options),
    async search() {
      onSearch()
      throw new Error('AI Search interpretation must not execute Workspace Search.')
    },
    listSavedViews: (input) => client.listSavedViews(input),
    createSavedView: (input) => client.createSavedView(input),
    updateSavedView: (input) => client.updateSavedView(input),
    deleteSavedView: (input) => client.deleteSavedView(input),
  }
}

/** Creates a full or metadata-only Triage entry for AI source checks. */
function createTriageEntry(
  visibility: 'full' | 'metadata-only',
  workspaceId = 'user#demo@example.com',
): TriageEntry {
  const permission = {
    visibility,
    canReply: false,
    guestVisible: false,
    checkedAt: NOW,
  } satisfies TriageEntry['permission']
  return {
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    id: 'triage-ai-1',
    workspaceId,
    source: {
      kind: 'chat',
      sourceId: 'source-ai-1',
      provider: 'slack',
      containerId: 'support',
      messageId: 'message-1',
    },
    sourcePreview: {
      title: 'Sensitive customer escalation',
      body: 'DENIED_TRIAGE_BODY',
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: true,
      truncated: false,
    },
    requester: { displayName: 'Requester', guest: false },
    receivedAt: NOW,
    lastActivityAt: NOW,
    state: 'pending',
    routing: {
      reason: 'Matched support routing.',
      candidates: [{
        teamId: 'core-team',
        projectId: 'refero',
        reason: 'Visible Project candidate.',
        permitted: true,
      }],
    },
    teamId: 'core-team',
    projectId: 'refero',
    permission,
    retention: { expiresAt: '2027-08-25T00:00:00.000Z' },
    capabilities: {
      canAssign: visibility === 'full',
      canAcceptCreate: visibility === 'full',
      canAcceptLink: visibility === 'full',
      canMarkDuplicate: visibility === 'full',
      canDecline: visibility === 'full',
      canSnooze: visibility === 'full',
      canRequestInformation: false,
      canReply: false,
      canViewInternalContext: visibility === 'full',
    },
    events: [],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/**
 * Creates a complete Triage client that strongly returns one selected source.
 *
 * @param entry - Canonical entry returned by the scoped source read.
 * @returns A fail-fast composition port for read-only AI tests.
 */
function createTriageClient(entry: TriageEntry): TriageCompositionClient {
  /** Rejects an unrelated mutation or settings operation. */
  async function unsupported(): Promise<never> {
    throw new Error('Unexpected Triage operation in AI assistance test.')
  }
  return {
    async listEntries() {
      return { entries: [entry], allowedBulkActions: [] }
    },
    async getEntry() {
      return entry
    },
    async getEntryForMutation() {
      return entry
    },
    applyAction: unsupported,
    getActionReceipt: unsupported,
    applyBulkAction: unsupported,
    getConfiguration: unsupported,
    getConfigurationUpdateReceipt: unsupported,
    updateConfiguration: unsupported,
    createManualHandoff: unsupported,
    async listWorkItemSources() {
      return { entries: [entry] }
    },
  }
}

/** Creates one page Document with inherited Workspace visibility. */
function createDocument(): Extract<DocumentDetail, { kind: 'page' }> {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: 'document-ai-1',
    kind: 'page',
    scope: { type: 'workspace' },
    title: 'Release notes',
    position: 'a0',
    revision: 3,
    permission: { mode: 'inherit', memberGrants: [] },
    relations: [],
    favorite: false,
    capabilities: {
      canView: true,
      canEdit: true,
      canComment: true,
      canShare: true,
      canManagePermissions: true,
      canArchive: true,
      canRestore: false,
      canExport: true,
    },
    createdByUserId: 'demo@example.com',
    updatedByUserId: 'demo@example.com',
    createdAt: NOW,
    updatedAt: NOW,
    blocks: [{ id: 'paragraph-1', type: 'paragraph', text: 'Authorized document body.' }],
  }
}

/** Creates one mutable Document comment snapshot. */
function createDocumentComment(updatedAt: string, body: string): DocumentComment {
  return {
    id: 'document-comment-1',
    documentId: 'document-ai-1',
    anchor: { type: 'document' },
    body,
    mentions: [],
    authorUserId: 'demo@example.com',
    resolved: false,
    createdAt: NOW,
    updatedAt,
  }
}

/**
 * Clones one valid active-member fixture with a controlled identifier and display name.
 *
 * @param template - Existing valid Workspace member from the composition harness.
 * @param memberKey - Stable canonical member identifier for the new fixture.
 * @param name - Current display name used by the privacy resolver.
 * @returns Active member suitable for resolver boundary tests.
 */
function createAiDirectoryMember(
  template: WorkspaceMember,
  memberKey: string,
  name: string,
): WorkspaceMember {
  return {
    ...template,
    id: `ai-member-${memberKey}`,
    memberKey,
    email: memberKey,
    name,
    role: 'member',
    status: 'active',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** Creates one Request submission containing field-aware PII and benign business context. */
function createPiiRequestSubmission(): RequestSubmission {
  const routingTarget = {
    teamId: 'core-team',
    projectId: 'refero',
    workflowStatusId: 'todo',
    assigneeUserId: 'sato@example.com',
    priority: 'medium',
    dueDateOffsetDays: 7,
  } satisfies RequestSubmission['routingTarget']
  const workItemMapping = {
    titleFieldId: 'project-name',
    descriptionFieldIds: ['details'],
  }
  return {
    schemaVersion: REQUEST_SUBMISSION_SCHEMA_VERSION,
    id: 'request-submission-pii-1',
    receiptId: 'request-receipt-pii-1',
    formId: 'request-form-pii-1',
    formVersion: 1,
    formSnapshot: {
      schemaVersion: REQUEST_FORM_SCHEMA_VERSION,
      formId: 'request-form-pii-1',
      version: 1,
      snapshot: {
        definition: {
          defaultLocale: 'ja',
          supportedLocales: ['ja'],
          title: { ja: '導入相談' },
          sections: [{
            id: 'contact',
            title: { ja: '連絡先' },
            fields: [
              { id: 'requester-name', type: 'short-text', label: { ja: 'お名前' } },
              { id: 'phone', type: 'short-text', label: { ja: '電話番号' } },
              {
                id: 'phone-numeric',
                type: 'number',
                label: { ja: 'Phone number (required)' },
              },
              {
                id: 'annual-volume',
                type: 'number',
                label: { ja: 'Annual request volume' },
              },
              { id: 'address', type: 'long-text', label: { ja: '送付先住所' } },
              { id: 'email', type: 'email', label: { ja: '返信先' } },
              {
                id: 'full-name',
                type: 'short-text',
                label: { ja: 'Full name (required)' },
              },
              {
                id: 'project-name',
                type: 'short-text',
                label: { ja: 'Project name (required)' },
              },
              { id: 'details', type: 'long-text', label: { ja: '詳細' } },
            ],
          }],
          confirmation: { message: { ja: '受け付けました。' } },
        },
        routing: {
          defaultTarget: routingTarget,
          rules: [],
          mapping: workItemMapping,
        },
      },
      createdBy: 'demo@example.com',
      createdAt: NOW,
    },
    status: 'received',
    source: 'web',
    revision: 1,
    locale: 'ja',
    answers: {
      'requester-name': '山田 太郎',
      phone: '090-1234-5678',
      'phone-numeric': 9_012_345_678,
      'annual-volume': 1_234_567,
      address: '東京都千代田区丸の内1-1-1',
      email: 'requester@example.com',
      'full-name': 'Alex Smith',
      'project-name': 'Atlas migration',
      details: 'Release 1.20.300 rollout context.',
    },
    attachments: [],
    routingTarget,
    workItemMapping,
    duplicateCandidateIds: [],
    messages: [],
    events: [],
    createdAt: NOW,
    updatedAt: NOW,
    capabilities: {
      canAssign: true,
      canRequestMoreInfo: true,
      canReject: true,
      canMarkDuplicate: true,
      canConvert: true,
    },
  }
}

afterEach(() => {
  resetTestApp()
})

describe('AI assistance API composition', () => {
  test('returns 401 without reaching the AI service', async () => {
    let serviceCalls = 0
    setTestAppDependencies({
      aiAssistanceService: createAiService({
        async getPolicy() {
          serviceCalls += 1
          throw new Error('Unauthenticated requests must not reach the AI service.')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/policy')

    expect(response.status).toBe(401)
    expect(serviceCalls).toBe(0)
  })

  test('denies policy updates when the live actor is not a Workspace manager', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      workspaceRole: 'member',
    })
    let observedCanManagePolicy: boolean | undefined
    setTestAppDependencies({
      aiAssistanceService: createAiService({
        async updatePolicy(actor) {
          observedCanManagePolicy = actor.canManagePolicy
          if (!actor.canManagePolicy) {
            throw new AiAssistanceError(
              'authorization',
              'AiAssistanceDisabled',
              'Workspace AI policy administration is required.',
            )
          }
          throw new Error('Member unexpectedly received AI policy administration.')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/policy', {
      method: 'PUT',
      headers: createAiHeaders(),
      body: JSON.stringify({
        enabled: true,
        allowedModelIds: ['model-1'],
        defaultModelId: 'model-1',
        enabledTasks: ['triage', 'summary', 'search', 'planning'],
        retentionDays: 30,
        expectedRevision: 0,
      }),
    })

    expect(response.status).toBe(403)
    expect(observedCanManagePolicy).toBe(false)
  })

  test('denies Request Intake sources to an Enterprise Workspace reader before source access', async () => {
    await withTestEnvironment({
      COGNITO_CLIENT_ID: 'mukuroji-main-client',
    }, async () => {
      configureFakeProjectClients(true, {
        projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
        workspaceRole: 'member',
      })
      let sourceReads = 0
      let serviceCalls = 0
      let providerCalls = 0
      setTestAppDependencies({
        enterpriseIdentity: await createWorkspaceReadOnlyEnterpriseIdentity(),
        requestIntake: createUnreachableRequestIntakeClient(() => {
          sourceReads += 1
        }),
        aiAssistanceService: createAiService({
          async generate(actor, request, authorization) {
            serviceCalls += 1
            await authorization.resolveContext({ actor, request })
            providerCalls += 1
            throw new Error('Read-only Enterprise access unexpectedly reached the provider.')
          },
        }),
      })
      const accessToken = createAccessToken([], {
        client_id: 'mukuroji-main-client',
        token_use: 'access',
      })

      const response = await app.request('/api/ai-assistance/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'ai-request-enterprise-reader',
        },
        body: JSON.stringify({
          task: 'triage',
          locale: 'ja',
          source: {
            type: 'request-submission',
            formId: 'request-form-1',
            submissionId: 'request-submission-1',
            expectedRevision: 1,
          },
        }),
      })

      expect(response.status).toBe(403)
      expect(serviceCalls).toBe(1)
      expect(sourceReads).toBe(0)
      expect(providerCalls).toBe(0)
    })
  })

  test('field-redacts Request Intake contact PII while retaining benign business answers', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'manager' }],
      role: 'manager',
      workspaceRole: 'owner',
    })
    const submission = createPiiRequestSubmission()
    const requestIntake = getTestAppDependencies().workItems.requestIntake
    let promptContext = ''
    setTestAppDependencies({
      requestIntake: {
        ...requestIntake,
        async getSubmission() {
          return submission
        },
      },
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          promptContext = resolved.promptContext
          return createWithheldGeneration(request.task, 'source-changed')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'triage',
        locale: 'ja',
        source: {
          type: 'request-submission',
          formId: submission.formId,
          submissionId: submission.id,
          expectedRevision: submission.revision,
        },
      }),
    })

    expect(response.status).toBe(201)
    expect(promptContext).not.toContain('山田 太郎')
    expect(promptContext).not.toContain('090-1234-5678')
    expect(promptContext).not.toContain('9012345678')
    expect(promptContext).not.toContain('東京都千代田区丸の内1-1-1')
    expect(promptContext).not.toContain('requester@example.com')
    expect(promptContext).not.toContain('Alex Smith')
    expect(promptContext).toContain('[REDACTED_PERSON]')
    expect(promptContext).toContain('[REDACTED_PHONE]')
    expect(promptContext).toContain('[REDACTED_ADDRESS]')
    expect(promptContext).toContain('[REDACTED_EMAIL]')
    expect(promptContext).toContain('Atlas migration')
    expect(promptContext).toContain('Release 1.20.300 rollout context.')
    expect(promptContext).toContain('1234567')
  })

  test('excludes sensitive and unknown Work Item custom fields from provider-bound context', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [
        { projectId: 'refero', role: 'viewer', teamId: 'core-team' },
        { projectId: 'privacy-project', role: 'viewer', teamId: 'privacy-team' },
      ],
      role: 'viewer',
      workspaceRole: 'member',
      additionalTeams: [{
        id: 'privacy-team',
        name: 'Privacy Team',
        projects: [{ id: 'privacy-project', name: 'Privacy', tone: 'purple' }],
      }],
    })
    const issue: TeamIssueResponseItem = {
      ...createBulkRecoveryIssue(),
      workflowSchemaVersion: 1,
      statusCategory: 'started',
      priority: 'high',
      source: 'dynamodb',
      customFieldValues: {
        'customer-phone': 9_012_345_678,
        'contact-names': ['Alex Smith'],
        'customer-email': 'hidden@example.com',
        'project-budget': 1_234_567,
        'shared-global-field': 'must-not-cross-global-classification',
        'legacy-unknown': 8_012_345_678,
      },
    }
    const coreCustomFields: WorkItemConfiguration['customFields'] = [
      {
        id: 'customer-phone',
        name: 'Customer phone',
        type: 'number',
        sortOrder: 10,
        required: false,
        defaultValue: 9_012_345_678,
        validation: { min: 1_000_000_000 },
      },
      {
        id: 'contact-names',
        name: 'Contacts',
        type: 'person',
        sortOrder: 20,
        required: false,
        defaultValue: ['Alex Smith'],
      },
      {
        id: 'customer-email',
        name: 'Customer e-mail',
        type: 'select',
        sortOrder: 30,
        required: false,
        defaultValue: 'private-email-option',
        options: [{
          id: 'private-email-option',
          name: 'PRIVATE_EMAIL_OPTION',
          sortOrder: 10,
        }],
      },
      {
        id: 'project-budget',
        name: 'Project budget',
        type: 'number',
        sortOrder: 40,
        required: false,
      },
      {
        id: 'shared-global-field',
        name: 'Release channel',
        type: 'text',
        sortOrder: 50,
        required: false,
      },
      {
        id: 'duplicate-budget',
        name: 'Budget per Team',
        type: 'number',
        sortOrder: 60,
        required: false,
      },
    ]
    const privacyBusinessFields = Array.from({ length: 105 }, (_, index) => ({
        id: `zz-business-field-${String(index).padStart(3, '0')}`,
        name: `Business field ${index}`,
        type: 'text',
        sortOrder: index,
        required: false,
      } satisfies WorkItemConfiguration['customFields'][number]))
    const privacyTeamCustomFields: WorkItemConfiguration['customFields'] = [
      ...privacyBusinessFields,
      {
        id: 'shared-global-field',
        name: 'Contact names',
        type: 'person',
        sortOrder: 106,
        required: false,
      },
      {
        id: 'duplicate-budget',
        name: 'Budget per Team',
        type: 'number',
        sortOrder: 107,
        required: false,
      },
    ]
    const baseConfigurationClient = createFakeWorkItemConfigurationClient()
    const teamIssues = createTeamIssuesFake({
      async getTeamIssues() {
        return { teamId: issue.teamId, issues: [issue] }
      },
      async getTeamIssueDetail() {
        return { issue, comments: [], activity: [] }
      },
    })
    let resolvedTasks = 0
    setTestAppDependencies({
      teamIssues,
      workItemConfigurations: createFakeWorkItemConfigurationClient({
        async getTeamConfiguration(workspaceId, teamId) {
          const resolved = await baseConfigurationClient.getTeamConfiguration(
            workspaceId,
            teamId,
          )
          return {
            ...resolved,
            configuration: {
              ...resolved.configuration,
              customFields: teamId === 'core-team'
                ? coreCustomFields
                : privacyTeamCustomFields,
            },
          }
        },
      }),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          resolvedTasks += 1
          expect(resolved.promptContext).not.toContain('customer-phone')
          expect(resolved.promptContext).not.toContain('contact-names')
          expect(resolved.promptContext).not.toContain('customer-email')
          expect(resolved.promptContext).not.toContain('shared-global-field')
          if (request.task === 'search') {
            expect(resolved.promptContext).not.toContain('duplicate-budget')
            expect(resolved.allowedValues.customFieldIds).not.toContain('duplicate-budget')
          }
          expect(resolved.promptContext).not.toContain('legacy-unknown')
          expect(resolved.promptContext).not.toContain('9012345678')
          expect(resolved.promptContext).not.toContain('8012345678')
          expect(resolved.promptContext).not.toContain('Alex Smith')
          expect(resolved.promptContext).not.toContain('hidden@example.com')
          expect(resolved.promptContext).not.toContain('PRIVATE_EMAIL_OPTION')
          expect(resolved.promptContext).not.toContain('private-email-option')
          expect(resolved.promptContext).not.toContain(
            'must-not-cross-global-classification',
          )
          expect(resolved.allowedValues.customFieldIds).not.toContain('customer-phone')
          expect(resolved.allowedValues.customFieldIds).not.toContain('contact-names')
          expect(resolved.allowedValues.customFieldIds).not.toContain('customer-email')
          expect(resolved.allowedValues.customFieldIds).not.toContain(
            'shared-global-field',
          )
          expect(resolved.allowedValues.customFieldIds).not.toContain('legacy-unknown')
          expect(resolved.promptContext).toContain('project-budget')
          expect(resolved.allowedValues.customFieldIds).toContain('project-budget')
          if (request.task === 'planning') {
            expect(resolved.promptContext).toContain('1234567')
            return createWithheldGeneration(request.task, 'source-changed')
          }
          return createSearchGeneration()
        },
      }),
    })

    const planningResponse = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: { ...createAiHeaders(), 'Idempotency-Key': 'ai-custom-fields-planning' },
      body: JSON.stringify({
        task: 'planning',
        locale: 'en',
        source: {
          type: 'work-item',
          teamId: issue.teamId,
          workItemId: issue.id,
          expectedRevision: issue.revision,
        },
      }),
    })
    const searchResponse = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: { ...createAiHeaders(), 'Idempotency-Key': 'ai-custom-fields-search' },
      body: JSON.stringify({
        task: 'search',
        locale: 'en',
        query: 'Group business work by custom field.',
      }),
    })

    expect(planningResponse.status).toBe(201)
    expect(searchResponse.status).toBe(201)
    expect(resolvedTasks).toBe(2)
  })

  test('builds Search context with non-linkable member aliases without executing Search', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    let searchCalls = 0
    let promptContext: string | undefined
    let authorizationToken: string | undefined
    const existingSearch = getTestAppDependencies().workItems.workspaceSearch
    setTestAppDependencies({
      workItemConfigurations: createFakeWorkItemConfigurationClient(),
      workspaceSearch: createNonExecutingWorkspaceSearch(existingSearch, () => {
        searchCalls += 1
      }),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          const independentlyResolved = await authorization.resolveContext({
            actor,
            request,
          })
          promptContext = resolved.promptContext
          authorizationToken = resolved.authorizationToken
          expect(resolved.promptContext).not.toContain('"displayName"')
          const demoMember = resolved.privateMemberIdentifiers.find((member) =>
            member.memberId === 'demo@example.com'
          )
          expect(demoMember?.identifiers).toEqual(['Demo User'])
          expect(demoMember?.providerAlias).toMatch(/^U_[A-Za-z0-9_]{4,94}$/u)
          const independentlyResolvedDemo = independentlyResolved
            .privateMemberIdentifiers.find((member) =>
              member.memberId === demoMember?.memberId
            )
          expect(independentlyResolved.authorizationToken).toBe(
            resolved.authorizationToken,
          )
          expect(independentlyResolvedDemo?.providerAlias).not.toBe(
            demoMember?.providerAlias,
          )
          expect(resolved.promptContext).not.toContain('demo@example.com')
          expect(resolved.promptContext).not.toContain('Demo User')
          expect(resolved.promptContext).toContain(demoMember?.providerAlias ?? '')
          expect(independentlyResolved.promptContext).toContain(
            independentlyResolvedDemo?.providerAlias ?? '',
          )
          expect(independentlyResolved.promptContext).not.toContain(
            demoMember?.providerAlias ?? '',
          )
          const providerAliases = resolved.privateMemberIdentifiers.map((member) =>
            member.providerAlias
          )
          expect(new Set(providerAliases).size).toBe(providerAliases.length)
          for (const member of resolved.privateMemberIdentifiers) {
            expect(member.providerAlias).not.toBe(member.memberId)
          }
          for (const value of [
            ...resolved.allowedValues.teamIds,
            ...resolved.allowedValues.projectIds,
            ...resolved.allowedValues.customFieldIds,
            ...resolved.allowedValues.relationIds,
            ...resolved.allowedValues.statuses,
          ]) {
            expect(resolved.promptContext).toContain(value)
          }
          for (const value of [
            ...resolved.allowedValues.assigneeUserIds,
            ...resolved.allowedValues.creatorUserIds,
          ]) {
            const member = resolved.privateMemberIdentifiers.find((candidate) =>
              candidate.memberId === value
            )
            expect(member).toBeDefined()
            expect(resolved.promptContext).not.toContain(value)
            expect(resolved.promptContext).toContain(member?.providerAlias ?? '')
          }
          expect(await authorization.isAuthorizationCurrent({
            actor,
            request,
            authorizationToken: resolved.authorizationToken,
          })).toEqual({ current: true })
          return createSearchGeneration()
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'search',
        locale: 'ja',
        query: '未完了のWork Itemを担当者別に数える',
      }),
    })

    expect(response.status).toBe(201)
    expect(searchCalls).toBe(0)
    expect(promptContext).toContain('core-team')
    expect(promptContext).toContain('refero')
    expect(promptContext).toContain('members')
    expect(promptContext).toContain('未完了のWork Itemを担当者別に数える')
    expect(authorizationToken).toMatch(/^ai-v1:[a-f0-9]{64}$/u)
    expect(authorizationToken).not.toContain('未完了')
  })

  test('uses the requested locale for AI directory labels', async () => {
    const calls = configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    let promptContext = ''
    setTestAppDependencies({
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          promptContext = (await authorization.resolveContext({ actor, request })).promptContext
          return createSearchGeneration()
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: { ...createAiHeaders(), 'Idempotency-Key': 'ai-directory-locale-en' },
      body: JSON.stringify({
        task: 'search',
        locale: 'en',
        query: 'Show visible work items.',
      }),
    })

    expect(response.status).toBe(201)
    expect(promptContext).toContain('Core Team')
    expect(promptContext).not.toContain('コアチーム')
    expect(calls.directoryReads.some((read) => read.locale === 'en')).toBeTrue()
  })

  test('keeps triage routing identifiers aligned with retained routing tuples', async () => {
    const projectShape: { id: string; name: string; tone: 'blue' } = {
      id: 'refero',
      name: 'Refero',
      tone: 'blue',
    }
    const coreProjects: Array<{ id: string; name: string; tone: 'blue' }> = [
      projectShape,
      ...Array.from({ length: 120 }, (_, index) => ({
        id: `core-project-${String(index).padStart(3, '0')}`,
        name: `Core project ${index}`,
        tone: 'blue',
      } satisfies { id: string; name: string; tone: 'blue' })),
    ]
    const laterProject: { id: string; name: string; tone: 'blue' } = {
      id: 'later-project',
      name: 'Later project',
      tone: 'blue',
    }
    const projectAccesses = [
      ...coreProjects.map((project) => ({
        projectId: project.id,
        role: 'viewer',
        teamId: 'core-team',
      } satisfies { projectId: string; role: 'viewer'; teamId: string })),
      {
        projectId: laterProject.id,
        role: 'viewer',
        teamId: 'later-team',
      } satisfies { projectId: string; role: 'viewer'; teamId: string },
    ]
    configureFakeProjectClients(true, {
      projectAccesses,
      teamProjects: coreProjects,
      additionalTeams: [{
        id: 'later-team',
        name: 'Later Team',
        projects: [laterProject],
      }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const entry = createTriageEntry('full')
    let resolvedContext: ResolvedAiAssistanceContext | undefined
    let observedPrompt = ''
    setTestAppDependencies({
      triage: createTriageClient(entry),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          resolvedContext = resolved
          observedPrompt = resolved.promptContext
          return createWithheldGeneration(request.task, 'source-changed')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: { ...createAiHeaders(), 'Idempotency-Key': 'ai-triage-routing-boundary' },
      body: JSON.stringify({
        task: 'triage',
        locale: 'en',
        source: {
          type: 'triage-entry',
          teamId: 'core-team',
          triageEntryId: entry.id,
          expectedRevision: entry.revision,
        },
      }),
    })

    expect(response.status).toBe(201)
    // The service fake above captures the resolved context through the actual port.
    if (resolvedContext === undefined) {
      throw new Error('Expected the AI resolver to return a triage context.')
    }
    expect(observedPrompt).not.toContain('Later Team')
    expect(observedPrompt).not.toContain('later-project')
    expect(resolvedContext.allowedValues.teamIds).not.toContain('later-team')
    expect(resolvedContext.allowedValues.projectIds).not.toContain('later-project')
    const routingTuples = resolvedContext.allowedValues.triageRoutingTuples ?? []
    const routingTeamIds = new Set(routingTuples.map((tuple) => tuple.teamId))
    const routingProjectIds = new Set(
      routingTuples.flatMap((tuple) => tuple.projectId === undefined ? [] : [tuple.projectId]),
    )
    for (const teamId of resolvedContext.allowedValues.teamIds) {
      expect(routingTeamIds.has(teamId)).toBeTrue()
    }
    for (const projectId of resolvedContext.allowedValues.projectIds) {
      expect(routingProjectIds.has(projectId)).toBeTrue()
    }
  })

  test('scopes triage-entry routing to the source Team when other Teams are visible', async () => {
    const sourceProject = {
      id: 'refero',
      name: 'Refero',
      tone: 'blue' as const,
    }
    const otherProject = {
      id: 'later-project',
      name: 'Later project',
      tone: 'blue' as const,
    }
    configureFakeProjectClients(true, {
      projectAccesses: [
        { projectId: sourceProject.id, role: 'viewer', teamId: 'core-team' },
        { projectId: otherProject.id, role: 'viewer', teamId: 'later-team' },
      ],
      teamProjects: [sourceProject],
      additionalTeams: [{
        id: 'later-team',
        name: 'Later Team',
        projects: [otherProject],
      }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const entry = createTriageEntry('full')
    const baseConfigurationClient = createFakeWorkItemConfigurationClient()
    const resolvedConfigurationTeamIds: string[] = []
    const workItemConfigurations = createFakeWorkItemConfigurationClient({
      async getTeamConfiguration(workspaceId, teamId) {
        resolvedConfigurationTeamIds.push(teamId)
        return await baseConfigurationClient.getTeamConfiguration(workspaceId, teamId)
      },
    })
    let resolvedContext: ResolvedAiAssistanceContext | undefined
    setTestAppDependencies({
      triage: createTriageClient(entry),
      workItemConfigurations,
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          resolvedContext = await authorization.resolveContext({ actor, request })
          return createWithheldGeneration(request.task, 'source-changed')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: { ...createAiHeaders(), 'Idempotency-Key': 'ai-triage-source-team-boundary' },
      body: JSON.stringify({
        task: 'triage',
        locale: 'en',
        source: {
          type: 'triage-entry',
          teamId: 'core-team',
          triageEntryId: entry.id,
          expectedRevision: entry.revision,
        },
      }),
    })

    expect(response.status).toBe(201)
    if (resolvedContext === undefined) {
      throw new Error('Expected the AI resolver to return a triage context.')
    }
    expect(resolvedContext.allowedValues.teamIds).toEqual(['core-team'])
    expect(resolvedContext.allowedValues.projectIds).toEqual(['refero'])
    expect(resolvedConfigurationTeamIds).toEqual(['core-team'])
    expect(resolvedContext.allowedValues.triageRoutingTuples?.every((tuple) =>
      tuple.teamId === 'core-team' &&
      (tuple.projectId === undefined || tuple.projectId === 'refero')
    )).toBeTrue()
    expect(JSON.stringify(resolvedContext.promptContext)).not.toContain('Later Team')
    expect(JSON.stringify(resolvedContext.promptContext)).not.toContain('later-project')
  })

  test('does not expose member candidates outside an Enterprise reader scope', async () => {
    await withTestEnvironment({
      COGNITO_CLIENT_ID: 'mukuroji-main-client',
    }, async () => {
      configureFakeProjectClients(true, {
        projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
        role: 'viewer',
        workspaceRole: 'member',
      })
      const existingWorkspaceAccess = getTestAppDependencies().workspace.workspaceAccess
      let observedAssigneeUserIds: readonly string[] = []
      let observedPromptContext = ''
      setTestAppDependencies({
        enterpriseIdentity: await createWorkspaceReadOnlyEnterpriseIdentity(),
        workspaceAccess: {
          ...existingWorkspaceAccess,
          async listActiveMembers(workspaceId) {
            const existing = await existingWorkspaceAccess.listActiveMembers(workspaceId)
            const template = existing[0]
            if (template === undefined) throw new Error('Expected an active member fixture.')
            return [
              ...existing,
              createAiDirectoryMember(
                template,
                'outside-scope@example.test',
                'Outside Scope Person',
              ),
            ]
          },
        },
        aiAssistanceService: createAiService({
          async generate(actor, request, authorization) {
            const resolved = await authorization.resolveContext({ actor, request })
            observedAssigneeUserIds = resolved.allowedValues.assigneeUserIds
            observedPromptContext = resolved.promptContext
            return createSearchGeneration()
          },
        }),
      })
      const accessToken = createAccessToken([], {
        client_id: 'mukuroji-main-client',
        token_use: 'access',
      })

      const response = await app.request('/api/ai-assistance/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'ai-request-member-scope',
        },
        body: JSON.stringify({
          task: 'search',
          locale: 'en',
          query: 'Show assignments visible to me.',
        }),
      })

      expect(response.status).toBe(201)
      expect(observedAssigneeUserIds).toEqual(['demo@example.com'])
      expect(observedPromptContext).not.toContain('outside-scope@example.test')
      expect(observedPromptContext).not.toContain('Outside Scope Person')
    })
  })

  test('aliases the complete active-member set while capping model candidates at 100', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const existingWorkspaceAccess = getTestAppDependencies().workspace.workspaceAccess
    const includedDuplicateId = 'aa-shared@example.test'
    const excludedDuplicateId = 'zz-shared@example.test'
    const excludedUniqueId = 'zzz-boundary@example.test'
    let boundaryVersion = 1
    setTestAppDependencies({
      workItemConfigurations: createFakeWorkItemConfigurationClient(),
      workspaceAccess: {
        ...existingWorkspaceAccess,
        async listActiveMembers(workspaceId) {
          const existing = await existingWorkspaceAccess.listActiveMembers(workspaceId)
          const template = existing[0]
          if (template === undefined) throw new Error('Expected an active member fixture.')
          return [
            createAiDirectoryMember(
              template,
              includedDuplicateId,
              'Shared Boundary Name',
            ),
            ...Array.from({ length: 203 }, (_, index) =>
              createAiDirectoryMember(
                template,
                `member-${String(index).padStart(3, '0')}@example.test`,
                `Member ${index}`,
              )
            ),
            createAiDirectoryMember(
              template,
              excludedDuplicateId,
              'Shared Boundary Name',
            ),
            {
              ...createAiDirectoryMember(
                template,
                excludedUniqueId,
                'Boundary Person',
              ),
              version: boundaryVersion,
              updatedAt: boundaryVersion === 1
                ? NOW
                : '2026-08-25T00:04:00.000Z',
            },
          ]
        },
      },
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          const excludedUnique = resolved.privateMemberIdentifiers.find((member) =>
            member.memberId === excludedUniqueId
          )
          expect(resolved.privateMemberIdentifiers).toHaveLength(206)
          expect(resolved.allowedValues.assigneeUserIds).toHaveLength(100)
          expect(resolved.allowedValues.assigneeUserIds).toContain(includedDuplicateId)
          expect(resolved.allowedValues.assigneeUserIds).not.toContain(
            excludedDuplicateId,
          )
          expect(resolved.allowedValues.assigneeUserIds).not.toContain(excludedUniqueId)
          expect(resolved.promptContext).not.toContain('Shared Boundary Name')
          expect(resolved.promptContext).not.toContain('Boundary Person')
          expect(resolved.promptContext).not.toContain(excludedDuplicateId)
          expect(resolved.promptContext).not.toContain(excludedUniqueId)
          expect(resolved.promptContext).toContain('[REDACTED_PERSON]')
          expect(excludedUnique).toBeDefined()
          expect(resolved.promptContext).toContain(
            excludedUnique?.providerAlias ?? '',
          )
          boundaryVersion = 2
          const changed = await authorization.resolveContext({ actor, request })
          expect(changed.authorizationToken).not.toBe(resolved.authorizationToken)
          return createSearchGeneration()
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'search',
        locale: 'en',
        query: 'Shared Boundary Name and Boundary Person assignments',
      }),
    })

    expect(response.status).toBe(201)
  })

  test('keeps a source-only member alias grounded after Summary omits the directory', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const existingWorkspaceAccess = getTestAppDependencies().workspace.workspaceAccess
    const targetMemberId = 'member-079@example.test'
    const document: ReturnType<typeof createDocument> = {
      ...createDocument(),
      blocks: [{
        id: 'paragraph-1',
        type: 'paragraph',
        text: `Only ${targetMemberId} owns this source.`,
      }],
    }
    setTestAppDependencies({
      workspaceAccess: {
        ...existingWorkspaceAccess,
        async listActiveMembers(workspaceId) {
          const existing = await existingWorkspaceAccess.listActiveMembers(workspaceId)
          const template = existing[0]
          if (template === undefined) throw new Error('Expected an active member fixture.')
          return Array.from({ length: 100 }, (_, index) => {
            const memberId = `member-${String(index).padStart(3, '0')}@example.test`
            return createAiDirectoryMember(template, memberId, `Member ${index}`)
          })
        },
      },
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 4
        },
        async get() {
          return document
        },
        async listComments() {
          return { comments: [] }
        },
      }),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          const target = resolved.privateMemberIdentifiers.find((member) =>
            member.memberId === targetMemberId
          )
          expect(target).toBeDefined()
          expect(resolved.promptContext).not.toContain('"directory"')
          expect(resolved.promptContext).not.toContain(targetMemberId)
          expect(resolved.promptContext).toContain(target?.providerAlias ?? '')
          expect(resolved.allowedValues.assigneeUserIds).toEqual([targetMemberId])
          expect(resolved.allowedValues.creatorUserIds).toEqual([targetMemberId])
          return createWithheldGeneration(request.task, 'source-changed')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'summary',
        locale: 'en',
        sources: [{
          type: 'document',
          documentId: document.id,
          expectedRevision: document.revision,
        }],
      }),
    })

    expect(response.status).toBe(201)
  })

  test('redacts complete email, member, and token values before source truncation', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const existingWorkspaceAccess = getTestAppDependencies().workspace.workspaceAccess
    const document = createDocument()
    const comments: DocumentComment[] = [
      {
        ...createDocumentComment(NOW, `${'A'.repeat(788)} victim@example.com`),
        id: 'document-comment-email',
      },
      {
        ...createDocumentComment(NOW, `${'B'.repeat(791)} Alex Smith`),
        id: 'document-comment-member',
      },
      {
        ...createDocumentComment(
          NOW,
          `${'C'.repeat(784)} github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456`,
        ),
        id: 'document-comment-token',
      },
    ]
    let promptContext = ''
    setTestAppDependencies({
      workspaceAccess: {
        ...existingWorkspaceAccess,
        async listActiveMembers(workspaceId) {
          const members = await existingWorkspaceAccess.listActiveMembers(workspaceId)
          return members.map((member) => member.memberKey === 'demo@example.com'
            ? { ...member, name: 'Alex Smith' }
            : member)
        },
      },
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 4
        },
        async get() {
          return document
        },
        async listComments() {
          return { comments }
        },
      }),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          promptContext = resolved.promptContext
          return createWithheldGeneration(request.task, 'source-changed')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'summary',
        locale: 'en',
        sources: [{
          type: 'document',
          documentId: document.id,
          expectedRevision: document.revision,
        }],
      }),
    })

    expect(response.status).toBe(201)
    expect(promptContext).not.toContain('victim@exa…')
    expect(promptContext).not.toContain('victim@exa')
    expect(promptContext).not.toContain('Alex Sm…')
    expect(promptContext).not.toContain('Alex Sm')
    expect(promptContext).not.toContain('github_pat_ABC')
    expect(promptContext).toContain('…')
  })

  test('replaces caller-provided PII request identifiers with a server trace UUID', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const callerTrace = 'Alex.Smith:090-1234-5678'
    let observedTraceId = ''
    setTestAppDependencies({
      aiAssistanceService: createAiService({
        async generate(actor) {
          observedTraceId = actor.traceId
          return createSearchGeneration()
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: {
        ...createAiHeaders(),
        'X-Request-Id': callerTrace,
        'X-Correlation-Id': 'Tokyo.Chiyoda:1-1-1',
      },
      body: JSON.stringify({
        task: 'search',
        locale: 'en',
        query: 'Open work items',
      }),
    })

    expect(response.status).toBe(201)
    expect(observedTraceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(observedTraceId).not.toContain(callerTrace)
    expect(observedTraceId).not.toContain('Tokyo.Chiyoda:1-1-1')
  })

  test('withholds a stored generation after another active member directory revision changes', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const existingWorkspaceAccess = getTestAppDependencies().workspace.workspaceAccess
    let directoryVersion = 1
    let storedRequest: GenerateAiAssistanceRequest | undefined
    let storedAuthorizationToken: string | undefined
    const availableGeneration: AiAssistanceGeneration = {
      ...createSearchGeneration(),
      content: {
        availability: 'available',
        draft: {
          kind: 'search',
          interpretation: 'Sato Before の担当作業',
          filters: { assigneeUserIds: ['sato@example.com'] },
          caveats: [],
        },
        citations: [],
        uncertainty: { level: 'low', reason: 'The active member was visible.' },
      },
    }
    setTestAppDependencies({
      workspaceAccess: {
        ...existingWorkspaceAccess,
        async listActiveMembers(workspaceId) {
          const members = await existingWorkspaceAccess.listActiveMembers(workspaceId)
          return members.map((member) => member.memberKey === 'sato@example.com'
            ? {
                ...member,
                name: directoryVersion === 1 ? 'Sato Before' : 'Sato After',
                version: directoryVersion,
                updatedAt: directoryVersion === 1
                  ? NOW
                  : '2026-08-25T00:03:00.000Z',
              }
            : member)
        },
      },
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          const sato = resolved.privateMemberIdentifiers.find((member) =>
            member.memberId === 'sato@example.com'
          )
          expect(sato).toBeDefined()
          expect(resolved.promptContext).not.toContain('Sato Before')
          expect(resolved.promptContext).not.toContain('sato@example.com')
          expect(resolved.promptContext).toContain(sato?.providerAlias ?? '')
          storedRequest = request
          storedAuthorizationToken = resolved.authorizationToken
          return availableGeneration
        },
        async getGeneration(actor, _generationId, authorization) {
          if (!storedRequest || !storedAuthorizationToken) {
            throw new Error('Expected a stored member directory fence.')
          }
          const current = await authorization.isAuthorizationCurrent({
            actor,
            request: storedRequest,
            authorizationToken: storedAuthorizationToken,
          })
          return current.current
            ? availableGeneration
            : createWithheldGeneration(storedRequest.task, current.reason)
        },
      }),
    })

    const created = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'search',
        locale: 'ja',
        query: 'Sato Before の担当作業を探す',
      }),
    })
    const createdText = await created.text()
    expect(created.status).toBe(201)
    expect(createdText).toContain('Sato Before')

    directoryVersion = 2
    const loaded = await app.request(
      '/api/ai-assistance/generations/generation-search-1',
      { headers: { Authorization: 'Bearer test-token' } },
    )
    const responseText = await loaded.text()

    expect(loaded.status).toBe(200)
    expect(responseText).toContain('source-changed')
    expect(responseText).not.toContain('Sato Before')
    expect(responseText).not.toContain('Sato After')
  })

  test('resolves Summary sources with bounded concurrency while preserving caller order', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const documentIds = Array.from(
      { length: 6 },
      (_, index) => `document-ai-${index + 1}`,
    )
    let activeDocumentReads = 0
    let maximumConcurrentDocumentReads = 0
    const startedDocumentIds: string[] = []
    let citationIds: string[] = []
    let citationLabels: string[] = []
    let promptContext = ''
    setTestAppDependencies({
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 4
        },
        async get(input) {
          activeDocumentReads += 1
          maximumConcurrentDocumentReads = Math.max(
            maximumConcurrentDocumentReads,
            activeDocumentReads,
          )
          startedDocumentIds.push(input.documentId)
          const documentIndex = documentIds.indexOf(input.documentId)
          try {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, (documentIds.length - documentIndex) * 5)
            })
            return {
              ...createDocument(),
              id: input.documentId,
              title: `Document ${documentIndex + 1}`,
            }
          } finally {
            activeDocumentReads -= 1
          }
        },
        async listComments() {
          return { comments: [] }
        },
      }),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          citationIds = resolved.citations.map((citation) => citation.id)
          citationLabels = resolved.citations.map((citation) => citation.label)
          promptContext = resolved.promptContext
          return createWithheldGeneration(request.task, 'source-changed')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'summary',
        locale: 'ja',
        sources: documentIds.map((documentId) => ({
          type: 'document',
          documentId,
          expectedRevision: 3,
        })),
      }),
    })

    expect(response.status).toBe(201)
    expect(maximumConcurrentDocumentReads).toBe(4)
    expect(startedDocumentIds).toHaveLength(documentIds.length * 2)
    expect([...new Set(startedDocumentIds)]).toEqual(documentIds)
    expect(citationIds).toEqual(documentIds.map((_, index) => `source-${index + 1}`))
    expect(citationLabels).toEqual(documentIds.map((_, index) => `Document ${index + 1}`))
    expect(promptContext).not.toContain('"directory"')
    expect(promptContext).not.toContain('Demo User')
    let previousPromptIndex = -1
    for (const documentId of documentIds) {
      const currentPromptIndex = promptContext.indexOf(`"id":"${documentId}"`)
      expect(currentPromptIndex).toBeGreaterThan(previousPromptIndex)
      previousPromptIndex = currentPromptIndex
    }
  })

  test('rejects a Document source that changes during the final content read', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const initialDocument = createDocument()
    const updatedDocument: ReturnType<typeof createDocument> = {
      ...initialDocument,
      revision: initialDocument.revision + 1,
      updatedAt: '2026-08-25T00:01:00.000Z',
      blocks: [{
        id: 'paragraph-1',
        type: 'paragraph',
        text: 'Edited document body must not reach the provider.',
      }],
    }
    let documentReads = 0
    let providerCalls = 0
    setTestAppDependencies({
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 4
        },
        async get() {
          documentReads += 1
          return documentReads === 1 ? initialDocument : updatedDocument
        },
        async listComments() {
          return { comments: [] }
        },
      }),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          await authorization.resolveContext({ actor, request })
          providerCalls += 1
          throw new Error('Stale Document source unexpectedly reached the provider.')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'summary',
        locale: 'ja',
        sources: [{
          type: 'document',
          documentId: initialDocument.id,
          expectedRevision: initialDocument.revision,
        }],
      }),
    })

    expect(response.status).toBe(409)
    expect(documentReads).toBe(2)
    expect(providerCalls).toBe(0)
    const responseText = await response.text()
    expect(responseText).not.toContain('Edited document body')
  })

  test('rejects a Document source when its comment window changes during the final read', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const document = createDocument()
    const initialComment = createDocumentComment(NOW, 'Initial comment body.')
    const updatedComment = createDocumentComment(
      '2026-08-25T00:01:00.000Z',
      'Edited comment body must not reach the provider.',
    )
    let commentReads = 0
    let providerCalls = 0
    setTestAppDependencies({
      documents: createDocumentFake({
        async getAuthorizationRevision() {
          return 4
        },
        async get() {
          return document
        },
        async listComments() {
          commentReads += 1
          return { comments: [commentReads === 1 ? initialComment : updatedComment] }
        },
      }),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          await authorization.resolveContext({ actor, request })
          providerCalls += 1
          throw new Error('Stale Document comment unexpectedly reached the provider.')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'summary',
        locale: 'ja',
        sources: [{
          type: 'document',
          documentId: document.id,
          expectedRevision: document.revision,
        }],
      }),
    })

    expect(response.status).toBe(409)
    expect(commentReads).toBe(2)
    expect(providerCalls).toBe(0)
    const responseText = await response.text()
    expect(responseText).not.toContain('Edited comment body')
  })

  test('rejects metadata-only Triage content before the provider boundary', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const entry = createTriageEntry('metadata-only')
    let providerCalls = 0
    setTestAppDependencies({
      triage: createTriageClient(entry),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          await authorization.resolveContext({ actor, request })
          providerCalls += 1
          throw new Error('Metadata-only source unexpectedly reached the provider.')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'triage',
        locale: 'ja',
        source: {
          type: 'triage-entry',
          teamId: 'core-team',
          triageEntryId: entry.id,
          expectedRevision: entry.revision,
        },
      }),
    })
    const responseText = await response.text()

    expect(response.status).toBe(403)
    expect(providerCalls).toBe(0)
    expect(responseText).not.toContain('DENIED_TRIAGE_BODY')
    expect(responseText).not.toContain('Sensitive customer escalation')
  })

  test('returns 409 for a stale source revision before the provider boundary', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const entry = createTriageEntry('full')
    let providerCalls = 0
    setTestAppDependencies({
      triage: createTriageClient(entry),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          await authorization.resolveContext({ actor, request })
          providerCalls += 1
          throw new Error('Stale source unexpectedly reached the provider.')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'triage',
        locale: 'ja',
        source: {
          type: 'triage-entry',
          teamId: 'core-team',
          triageEntryId: entry.id,
          expectedRevision: entry.revision - 1,
        },
      }),
    })

    expect(response.status).toBe(409)
    expect(providerCalls).toBe(0)
  })

  test('rejects a cross-Workspace Triage result without disclosing its metadata', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const entry = createTriageEntry('full', 'workspace-other')
    setTestAppDependencies({
      triage: createTriageClient(entry),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          await authorization.resolveContext({ actor, request })
          throw new Error('Cross-Workspace source unexpectedly passed authorization.')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'triage',
        locale: 'ja',
        source: {
          type: 'triage-entry',
          teamId: 'core-team',
          triageEntryId: entry.id,
          expectedRevision: entry.revision,
        },
      }),
    })
    const responseText = await response.text()

    expect([403, 404]).toContain(response.status)
    expect(responseText).not.toContain('DENIED_TRIAGE_BODY')
    expect(responseText).not.toContain('Sensitive customer escalation')
  })

  test('discards a Work Item draft when its comment window changes after provider use', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const issue: TeamIssueResponseItem = {
      ...createBulkRecoveryIssue(),
      workflowSchemaVersion: 1,
      statusCategory: 'started',
      priority: 'high',
      source: 'dynamodb',
    }
    let commentVersion = 1
    let providerCalls = 0
    const teamIssues = createTeamIssuesFake({
      async getTeamIssues() {
        return { teamId: issue.teamId, issues: [issue] }
      },
      async getTeamIssueDetail() {
        return {
          issue,
          comments: [],
          // The production Work Item adapter returns newest-first for this
          // request. Keep the fixture ordered the same way to guard the
          // resolver's latest-activity selection.
          activity: Array.from({ length: 40 }, (_, index) => {
            const age = index
            return {
              id: `activity-${age + 1}`,
              type: 'updated',
              actorUserId: 'demo@example.com',
              summary: age === 0 ? 'Newest activity.' : `Older activity ${age}.`,
              createdAt: new Date(
                Date.parse(NOW) - age * 60_000,
              ).toISOString(),
            }
          }),
        }
      },
    })
    const baseConfigurationClient = createFakeWorkItemConfigurationClient()
    const workItemConfigurations = createFakeWorkItemConfigurationClient({
      async getTeamConfiguration(workspaceId, teamId) {
        const resolved = await baseConfigurationClient.getTeamConfiguration(
          workspaceId,
          teamId,
        )
        return {
          ...resolved,
          configuration: {
            ...resolved.configuration,
            workflow: {
              ...resolved.configuration.workflow,
              transitions: [{
                fromStatusId: 'in-progress',
                toStatusId: 'review',
              }],
            },
          },
        }
      },
    })
    setTestAppDependencies({
      teamIssues,
      workItemConfigurations,
      collaboration: createCollaborationStub({
        async getThread() {
          return {
            comments: [{
              id: 'comment-1',
              rootCommentId: 'comment-1',
              authorMemberKey: 'demo@example.com',
              bodyMarkdown: commentVersion === 1 ? 'Initial comment' : 'Edited comment',
              version: commentVersion,
              mentionMemberKeys: [],
              createdAt: NOW,
              updatedAt: commentVersion === 1
                ? NOW
                : '2026-08-25T00:01:00.000Z',
              acceptedResolutions: [],
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
      }),
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          expect(resolved.promptContext).toContain('Initial comment')
          expect(resolved.promptContext).toContain('Newest activity.')
          expect(resolved.promptContext).not.toContain('Older activity 20.')
          for (const endpoint of resolved.allowedValues.workItemEndpoints) {
            expect(resolved.promptContext).toContain(endpoint.teamId)
            expect(resolved.promptContext).toContain(endpoint.workItemId)
          }
          expect(resolved.allowedValues.statuses).toEqual(['in-progress', 'review'])
          expect(resolved.promptContext).not.toContain('"members"')
          expect(resolved.promptContext).not.toContain('"customFields"')
          providerCalls += 1
          commentVersion = 2
          const current = await authorization.isAuthorizationCurrent({
            actor,
            request,
            authorizationToken: resolved.authorizationToken,
          })
          if (current.current) {
            throw new Error('Edited comment window did not invalidate authorization.')
          }
          return createWithheldGeneration(request.task, current.reason)
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'planning',
        locale: 'ja',
        source: {
          type: 'work-item',
          teamId: issue.teamId,
          workItemId: issue.id,
          expectedRevision: issue.revision,
        },
      }),
    })
    const responseText = await response.text()

    expect(response.status).toBe(201)
    expect(providerCalls).toBe(1)
    expect(responseText).toContain('source-changed')
    expect(responseText).not.toContain('Initial comment')
    expect(responseText).not.toContain('Edited comment')
  })

  test('omits a deactivated Work Item assignee from provider-bound context', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
      inactiveWorkspaceMemberKeys: ['sato@example.com'],
    })
    const issue = {
      ...createBulkRecoveryIssue(),
      assigneeUserId: 'sato@example.com',
      priority: 'high',
      statusCategory: 'started',
      workflowSchemaVersion: 1,
      source: 'dynamodb',
    } satisfies TeamIssueResponseItem
    const teamIssues = createTeamIssuesFake({
      async getTeamIssues() {
        return { teamId: issue.teamId, issues: [issue] }
      },
      async getTeamIssueDetail() {
        return { issue, comments: [], activity: [] }
      },
    })
    let promptContext = ''
    setTestAppDependencies({
      teamIssues,
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          promptContext = (await authorization.resolveContext({ actor, request })).promptContext
          return createWithheldGeneration(request.task, 'source-changed')
        },
      }),
    })

    const response = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: { ...createAiHeaders(), 'Idempotency-Key': 'ai-deactivated-assignee' },
      body: JSON.stringify({
        task: 'planning',
        locale: 'en',
        source: {
          type: 'work-item',
          teamId: issue.teamId,
          workItemId: issue.id,
          expectedRevision: issue.revision,
        },
      }),
    })

    expect(response.status).toBe(201)
    expect(promptContext).not.toContain('sato@example.com')
    expect(promptContext).not.toContain('assigneeUserId')
  })

  test('withholds a stored generation after a Document comment timestamp changes', async () => {
    configureFakeProjectClients(true, {
      projectAccesses: [{ projectId: 'refero', role: 'viewer' }],
      role: 'viewer',
      workspaceRole: 'member',
    })
    const document = createDocument()
    let comment = createDocumentComment(NOW, 'Initial document comment')
    let storedRequest: GenerateAiAssistanceRequest | undefined
    let storedAuthorizationToken: string | undefined
    const documents = createDocumentFake({
      async getAuthorizationRevision() {
        return 4
      },
      async get() {
        return document
      },
      async listComments() {
        return { comments: [comment] }
      },
    })
    setTestAppDependencies({
      documents,
      aiAssistanceService: createAiService({
        async generate(actor, request, authorization) {
          const resolved = await authorization.resolveContext({ actor, request })
          storedRequest = request
          storedAuthorizationToken = resolved.authorizationToken
          return {
            ...createWithheldGeneration(request.task, 'source-changed'),
            content: {
              availability: 'available',
              draft: {
                kind: 'summary',
                overview: {
                  id: 'overview-1',
                  text: 'Document summary.',
                  confidence: 'high',
                  citationIds: ['source-1'],
                },
                decisions: [],
                actions: [],
                risks: [],
              },
              citations: [...resolved.citations],
              uncertainty: { level: 'low', reason: 'Source is current.' },
            },
          }
        },
        async getGeneration(actor, _generationId, authorization) {
          if (!storedRequest || !storedAuthorizationToken) {
            throw new Error('Expected a stored Document generation fence.')
          }
          const current = await authorization.isAuthorizationCurrent({
            actor,
            request: storedRequest,
            authorizationToken: storedAuthorizationToken,
          })
          return current.current
            ? createWithheldGeneration(storedRequest.task, 'source-changed')
            : createWithheldGeneration(storedRequest.task, current.reason)
        },
      }),
    })

    const created = await app.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: createAiHeaders(),
      body: JSON.stringify({
        task: 'summary',
        locale: 'ja',
        sources: [{
          type: 'document',
          documentId: document.id,
          expectedRevision: document.revision,
        }],
      }),
    })
    expect(created.status).toBe(201)

    comment = createDocumentComment(
      '2026-08-25T00:02:00.000Z',
      'Edited document comment',
    )
    const loaded = await app.request(
      '/api/ai-assistance/generations/generation-1',
      { headers: { Authorization: 'Bearer test-token' } },
    )
    const responseText = await loaded.text()

    expect(loaded.status).toBe(200)
    expect(responseText).toContain('source-changed')
    expect(responseText).not.toContain('Initial document comment')
    expect(responseText).not.toContain('Edited document comment')
    expect(responseText).not.toContain('Document summary')
  })
})
