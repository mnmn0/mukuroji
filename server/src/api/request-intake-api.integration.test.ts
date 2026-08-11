import {
  createApiTestHarness,
} from './test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createTeamIssuesFake,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  DynamoDbTeamIssuesClient,
} from '../modules/work-items'
import type { TriageCompositionClient } from '../app/composition/app-dependencies'
import {
  resolveRequestClientKey,
} from './api-router'
import type {
  RequestIntakeClient,
} from '../modules/request-intake'
import {
  createFormTriageEntryId,
  RequestIntakeError,
} from '../modules/request-intake'
import {
  createTriageCapabilities,
} from '../modules/triage'
import { redactExpiredTriageEntry } from '../modules/triage/domain/triage-entry'
import type { CreateTeamIssueRequestBody } from '../modules/work-items'
import type {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import type {
  DynamoDBDocumentClient,
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import type {
  PublicRequestForm,
  RequestForm,
  RequestFormDraft,
  RequestSubmission,
  RequestSubmissionActionInput,
  TriageEntry,
} from '@mukuroji/contracts'
import {
  REQUEST_FORM_SCHEMA_VERSION,
  REQUEST_SUBMISSION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultUnscheduledWorkItemSchedule,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

/**
 * Creates a rejected operation for a Request Intake capability that a test did not configure.
 *
 * @param operation - Port method that must not be reached by the focused test.
 * @returns A fail-fast async implementation compatible with any Request Intake method.
 */
function createUnexpectedRequestIntakeCall(
  operation: keyof RequestIntakeClient,
): () => Promise<never> {
  return async () => {
    throw new Error(`Unexpected RequestIntakeClient call: ${operation}`)
  }
}

/**
 * Creates a complete Request Intake test port with explicit focused overrides.
 *
 * @param overrides - Capabilities exercised by the focused test.
 * @returns A network-free client that rejects every unconfigured capability.
 */
function createRequestIntakeClient(
  overrides: Readonly<Partial<RequestIntakeClient>>,
): RequestIntakeClient {
  return {
    listForms: createUnexpectedRequestIntakeCall('listForms'),
    getForm: createUnexpectedRequestIntakeCall('getForm'),
    createForm: createUnexpectedRequestIntakeCall('createForm'),
    updateForm: createUnexpectedRequestIntakeCall('updateForm'),
    publishForm: createUnexpectedRequestIntakeCall('publishForm'),
    resolveLink: createUnexpectedRequestIntakeCall('resolveLink'),
    getPublicForm: createUnexpectedRequestIntakeCall('getPublicForm'),
    createAttachmentUpload: createUnexpectedRequestIntakeCall(
      'createAttachmentUpload',
    ),
    submit: createUnexpectedRequestIntakeCall('submit'),
    listSubmissions: createUnexpectedRequestIntakeCall('listSubmissions'),
    getSubmission: createUnexpectedRequestIntakeCall('getSubmission'),
    applyAction: createUnexpectedRequestIntakeCall('applyAction'),
    completeConversion: createUnexpectedRequestIntakeCall('completeConversion'),
    getRequesterThread: createUnexpectedRequestIntakeCall('getRequesterThread'),
    replyToThread: createUnexpectedRequestIntakeCall('replyToThread'),
    ingestEmail: createUnexpectedRequestIntakeCall('ingestEmail'),
    createAttachmentAccess: createUnexpectedRequestIntakeCall(
      'createAttachmentAccess',
    ),
    ...overrides,
  }
}

const draft = {
  definition: {
    defaultLocale: 'ja',
    supportedLocales: ['ja'],
    title: { ja: 'Request' },
    sections: [{
      id: 'main',
      title: { ja: 'Request details' },
      fields: [{
        id: 'title',
        type: 'short-text',
        label: { ja: 'Title' },
        validation: { required: true },
      }],
    }],
    confirmation: {
      message: { ja: 'Request received.' },
    },
  },
  routing: {
    defaultTarget: {
      teamId: 'core-team',
      assigneeUserId: 'demo@example.com',
      priority: 'medium',
      dueDateOffsetDays: 1,
    },
    rules: [],
    mapping: { titleFieldId: 'title' },
  },
} satisfies RequestFormDraft

const requestForm = {
  id: 'form-1',
  name: 'Request',
  scope: { type: 'team', teamId: 'core-team' },
  status: 'draft',
  revision: 1,
  draft,
  publishedVersions: [],
  link: {
    linkId: 'link-1',
    token: 'L'.repeat(43),
    accessMode: 'public',
  },
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
  capabilities: {
    canEdit: true,
    canPublish: true,
    canManageLink: true,
  },
} satisfies RequestForm

/** Stable instant used by legacy Request/Triage composition fixtures. */
const TRIAGE_NOW = '2026-08-09T00:00:00.000Z'

/**
 * Creates a canonical Request submission for legacy action route tests.
 *
 * @param overrides - Submission fields changed for one scenario.
 * @returns A complete Request submission.
 */
function createLegacySubmission(
  overrides: Partial<RequestSubmission> = {},
): RequestSubmission {
  const routingTarget = {
    teamId: 'core-team',
    projectId: 'refero',
    workflowStatusId: 'todo',
    assigneeUserId: 'demo@example.com',
    priority: 'medium' as const,
    dueDateOffsetDays: 1,
  }
  return {
    schemaVersion: REQUEST_SUBMISSION_SCHEMA_VERSION,
    id: 'request-legacy-1',
    receiptId: 'receipt-legacy-1',
    formId: requestForm.id,
    formVersion: 1,
    formSnapshot: {
      schemaVersion: REQUEST_FORM_SCHEMA_VERSION,
      formId: requestForm.id,
      version: 1,
      snapshot: {
        definition: draft.definition,
        routing: {
          defaultTarget: routingTarget,
          rules: [],
          mapping: { titleFieldId: 'title' },
        },
      },
      createdBy: 'demo@example.com',
      createdAt: TRIAGE_NOW,
    },
    status: 'received',
    source: 'web',
    revision: 1,
    locale: 'ja',
    answers: { title: 'Legacy request title' },
    attachments: [],
    routingTarget,
    workItemMapping: { titleFieldId: 'title' },
    duplicateCandidateIds: [],
    messages: [],
    events: [{
      id: 'request-submitted-legacy',
      type: 'submitted',
      actorId: 'requester',
      summary: 'Request was submitted.',
      createdAt: TRIAGE_NOW,
    }],
    createdAt: TRIAGE_NOW,
    updatedAt: TRIAGE_NOW,
    capabilities: {
      canAssign: true,
      canRequestMoreInfo: true,
      canReject: true,
      canMarkDuplicate: true,
      canConvert: true,
    },
    ...overrides,
  }
}

/**
 * Creates the deterministic Form Triage Entry paired with a Request submission.
 *
 * @param submission - Source Request submission.
 * @param overrides - Entry fields changed for one scenario.
 * @returns A canonical pending Form Triage Entry.
 */
function createLegacyTriageEntry(
  submission: RequestSubmission,
  overrides: Partial<TriageEntry> = {},
): TriageEntry {
  const permission = {
    visibility: 'full',
    canReply: true,
    guestVisible: false,
    checkedAt: TRIAGE_NOW,
  } satisfies TriageEntry['permission']
  return {
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    id: createFormTriageEntryId(submission.id),
    workspaceId: 'user#demo@example.com',
    source: {
      kind: 'form',
      sourceId: submission.id,
      formId: submission.formId,
      submissionId: submission.id,
    },
    sourcePreview: {
      title: 'Legacy request title',
      body: '',
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: true,
      truncated: false,
    },
    requester: { displayName: 'Requester', guest: true },
    receivedAt: TRIAGE_NOW,
    lastActivityAt: TRIAGE_NOW,
    state: 'pending',
    routing: { reason: 'Form default.', candidates: [] },
    teamId: 'core-team',
    projectId: 'refero',
    ownerUserId: 'demo@example.com',
    permission,
    retention: { expiresAt: '2027-08-09T00:00:00.000Z' },
    capabilities: createTriageCapabilities({ state: 'pending', permission }),
    events: [],
    revision: 1,
    createdAt: TRIAGE_NOW,
    updatedAt: TRIAGE_NOW,
    ...overrides,
  }
}

/**
 * Creates a complete Triage composition fake around one deterministic Form entry.
 *
 * @param entry - Entry returned by strong and ordinary reads.
 * @param overrides - Focused operations changed by the test.
 * @returns A complete Triage composition client.
 */
function createLegacyTriageClient(
  entry: TriageEntry,
  overrides: Readonly<Partial<TriageCompositionClient>> = {},
): TriageCompositionClient {
  const unsupported = async () => {
    throw new Error('Unexpected Triage client call in Request Intake API test.')
  }
  return {
    listEntries: unsupported,
    getEntry: async () => entry,
    getEntryForMutation: async () => entry,
    applyAction: unsupported,
    getActionReceipt: async () => undefined,
    applyBulkAction: unsupported,
    getConfiguration: unsupported,
    getConfigurationUpdateReceipt: async () => undefined,
    updateConfiguration: unsupported,
    createManualHandoff: unsupported,
    listWorkItemSources: unsupported,
    ...overrides,
  }
}

/**
 * Creates the canonical Work Item capabilities required by a legacy duplicate action.
 *
 * @returns A focused Team Issues fake with duplicate-context transaction support.
 */
function createLegacyDuplicateTeamIssuesClient() {
  return createTeamIssuesFake({
    async getTeamIssueDetail() {
      return {
        issue: {
          schemaVersion: WORK_ITEM_SCHEMA_VERSION,
          revision: 1,
          id: 'canonical-duplicate-target',
          teamId: 'core-team',
          assignedProjectId: 'refero',
          title: 'Canonical duplicate target',
          assigneeUserId: 'demo@example.com',
          creatorMemberKey: 'demo@example.com',
          workflowSchemaVersion: 1,
          workflowStatusId: 'todo',
          statusCategory: 'unstarted',
          customFieldValues: {},
          relationIds: [],
          dueDate: '',
          schedule: createDefaultUnscheduledWorkItemSchedule(),
          priority: 'medium',
          createdAt: TRIAGE_NOW,
          updatedAt: TRIAGE_NOW,
          source: 'dynamodb',
        },
        comments: [],
        activity: [],
      }
    },
    createTriageDuplicateContextTransactionItems(input) {
      return {
        snapshot: {
          triageEntryId: input.entry.id,
          sourceKind: input.entry.source.kind,
          visibilityAtMerge: input.entry.permission.visibility,
          availability: 'summary-metadata',
          receivedAt: input.entry.receivedAt,
          lastActivityAt: input.entry.lastActivityAt,
          sourceRetentionExpiresAt: input.entry.retention.expiresAt,
          commentMetadataCount: input.entry.sourcePreview.commentCount,
          attachmentMetadataCount: input.entry.sourcePreview.attachmentCount,
          watcherMetadataCount: input.entry.sourcePreview.watcherCount,
          events: [],
          mergedAt: input.mergedAt,
        },
        transactItems: [{
          ConditionCheck: {
            TableName: 'WorkItemsTable',
            Key: { id: input.workItemId },
            ConditionExpression: '#revision = :expectedRevision',
            ExpressionAttributeValues: {
              ':expectedRevision': input.expectedWorkItemRevision,
            },
          },
        }],
      }
    },
  })
}

test('does not trust forwarded request rate-limit sources without a configured proxy', async () => {
  const clientKeys: string[] = []
  const overrides = {
    async resolveLink() {
      return {
        workspaceId: 'workspace-1',
        formId: 'form-1',
        accessMode: 'public',
        tokenDigest: 'link-digest',
      }
    },
    async getPublicForm(_resolution, context) {
      clientKeys.push(context.clientKey)
      return {
        schemaVersion: 1,
        formId: 'form-1',
        version: 1,
        accessMode: 'public',
        definition: draft.definition,
        submissionSession: {
          token: 'S'.repeat(43),
          expiresAt: '2026-07-16T00:15:00.000Z',
          minimumSubmitAt: '2026-07-16T00:00:01.000Z',
        },
      } satisfies PublicRequestForm
    },
  } satisfies Pick<RequestIntakeClient, 'getPublicForm' | 'resolveLink'>
  setTestAppDependencies({
    requestIntake: createRequestIntakeClient(overrides),
  })

  for (const userAgent of ['agent-one', 'agent-two']) {
    const response = await app.request(`/api/request-intake/${'L'.repeat(43)}`, {
      headers: {
        'User-Agent': userAgent,
        'X-Forwarded-For': '203.0.113.10',
      },
    })
    expect(response.status).toBe(200)
  }

  expect(clientKeys).toEqual(['transport-unavailable', 'transport-unavailable'])
})

test('uses a forwarded request rate-limit source only for a configured trusted proxy', () => {
  expect(resolveRequestClientKey(
    '10.0.0.8',
    '203.0.113.10, 10.0.0.8',
    new Set(['10.0.0.8']),
  )).toBe('203.0.113.10')
  expect(resolveRequestClientKey(
    '198.51.100.20',
    '203.0.113.10',
    new Set(['10.0.0.8']),
  )).toBe('198.51.100.20')
  expect(resolveRequestClientKey(
    undefined,
    '203.0.113.10',
    new Set(['10.0.0.8']),
  )).toBe('transport-unavailable')
})

test('delegates Request Form publish revision checks to the Request Intake client', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'owner' })
  let publishCalls = 0
  const conflict = new RequestIntakeError(
    409,
    'RequestRevisionConflict',
    'Request resource revision changed.',
  )
  const overrides = {
    async getForm() {
      return requestForm
    },
    async publishForm() {
      publishCalls += 1
      throw conflict
    },
  } satisfies Pick<RequestIntakeClient, 'getForm' | 'publishForm'>
  setTestAppDependencies({
    requestIntake: createRequestIntakeClient(overrides),
  })

  const response = await app.request('/api/request-forms/form-1/publish', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedRevision: 2 }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'RequestRevisionConflict',
    message: 'Request resource revision changed.',
  })
  expect(publishCalls).toBe(1)
})

test('commits a Request conversion pointer in the same transaction as its canonical Work Item', async () => {
  let transactionItems: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      if (command.constructor.name === 'QueryCommand') return { Items: [] }
      if (command.constructor.name === 'TransactWriteCommand') {
        transactionItems = command.input.TransactItems as Array<Record<string, unknown>>
        return {}
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbTeamIssuesClient(
    'work-items-table',
    'events-table',
    documentClient,
    { send: async () => ({}) } as unknown as DynamoDBClient,
    false,
  )

  const response = await client.createTeamIssue(
    'workspace-1',
    'core-team',
    {
      title: 'Request-created Work Item',
      assigneeUserId: 'member@example.com',
      workflowSchemaVersion: 1,
      workflowStatusId: 'todo',
      statusCategory: 'unstarted',
      customFieldValues: {},
      schedule: {
        calendarPolicy: {
          holidays: [],
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
        dueDate: '2026-07-31',
        mode: 'due-date',
      },
      priority: 'medium',
    },
    'admin@example.com',
    undefined,
    {
      tableName: 'request-intake-table',
      scopeKey: 'WORKSPACE#workspace-1',
      recordKey: 'SUBMISSION#req_20260716_atomic',
      expectedRevision: 3,
      actorId: 'admin@example.com',
      submissionId: 'req_20260716_atomic',
      events: [],
    },
  )

  expect(response.issue.sourceRequestId).toBe('req_20260716_atomic')
  expect(transactionItems).toHaveLength(4)
  expect(transactionItems[0]).toMatchObject({
    Put: {
      TableName: 'work-items-table',
      Item: { sourceRequestId: 'req_20260716_atomic' },
    },
  })
  expect(transactionItems[2]).toMatchObject({
    Update: {
      TableName: 'request-intake-table',
      Key: {
        scopeKey: 'WORKSPACE#workspace-1',
        recordKey: 'SUBMISSION#req_20260716_atomic',
      },
      ConditionExpression:
        '#revision = :expectedRevision AND (#status = :received OR #status = :triaging OR #status = :needsMoreInfo)',
      ExpressionAttributeValues: {
        ':expectedRevision': 3,
        ':converted': 'converted',
        ':workItem': {
          teamId: 'core-team',
          workItemId: response.issue.id,
        },
      },
    },
  })
  expect(transactionItems[3]).toMatchObject({
    Put: {
      TableName: 'request-intake-table',
      Item: {
        entryType: 'submission-event',
        scopeKey: 'WORKSPACE#workspace-1',
        recordKey: expect.stringMatching(
          /^SUBMISSION_EVENT#req_20260716_atomic#/u,
        ),
        submissionId: 'req_20260716_atomic',
        type: 'converted',
        actorId: 'admin@example.com',
      },
      ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    },
  })
})

test('does not copy expired Form answers during legacy conversion', async () => {
  const submission = createLegacySubmission({
    answers: { title: 'Expired source answer' },
  })
  const entry = redactExpiredTriageEntry(
    createLegacyTriageEntry(submission, {
      retention: { expiresAt: '2026-08-08T00:00:00.000Z' },
    }),
    TRIAGE_NOW,
  )
  let createdInput: CreateTeamIssueRequestBody | undefined
  configureFakeProjectClients(true, {
    workspaceRole: 'owner',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })
  setTestAppDependencies({
    triage: createLegacyTriageClient(entry),
    requestIntake: createRequestIntakeClient({
      getSubmission: async () => submission,
      completeConversion: async () => ({
        ...submission,
        status: 'converted',
        revision: submission.revision + 1,
        workItem: {
          teamId: 'core-team',
          workItemId: 'retained-work-item',
          projectId: 'refero',
        },
      }),
    }),
    teamIssues: createTeamIssuesFake({
      async createTeamIssue(
        _directoryId,
        teamId,
        input,
        actorUserId,
        _auditContext,
        _requestConversion,
        _triageAcceptance,
      ) {
        createdInput = input
        const statusCategory = input.statusCategory === 'backlog' ||
          input.statusCategory === 'unstarted' ||
          input.statusCategory === 'started' ||
          input.statusCategory === 'completed' ||
          input.statusCategory === 'canceled'
          ? input.statusCategory
          : 'unstarted'
        const priority = input.priority === 'low' || input.priority === 'medium' || input.priority === 'high'
          ? input.priority
          : 'medium'
        return {
          issue: {
            schemaVersion: WORK_ITEM_SCHEMA_VERSION,
            revision: 1,
            id: 'retained-work-item',
            teamId,
            ...(typeof input.assignedProjectId === 'string'
              ? { assignedProjectId: input.assignedProjectId }
              : {}),
            title: String(input.title),
            assigneeUserId: String(input.assigneeUserId),
            creatorMemberKey: actorUserId,
            workflowSchemaVersion: 1,
            workflowStatusId: typeof input.workflowStatusId === 'string'
              ? input.workflowStatusId
              : 'todo',
            statusCategory,
            customFieldValues: {},
            relationIds: [],
            dueDate: '',
            schedule: createDefaultUnscheduledWorkItemSchedule(),
            priority,
            createdAt: TRIAGE_NOW,
            updatedAt: TRIAGE_NOW,
            source: 'dynamodb',
          },
        }
      },
    }),
  })

  const response = await app.request(
    `/api/request-submissions/${submission.id}/actions`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'legacy-expired-conversion',
      },
      body: JSON.stringify({ action: 'convert', expectedRevision: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(createdInput).toMatchObject({
    title: 'Retained source',
    customFieldValues: {},
  })
  expect(createdInput?.description).toBeUndefined()
  expect(createdInput?.title).not.toBe('Expired source answer')
})

test.each([
  {
    name: 'assign',
    body: {
      action: 'assign' as const,
      expectedRevision: 1,
      assigneeUserId: 'sato@example.com',
    },
    expectedTriageState: 'pending',
  },
  {
    name: 'request-more-info',
    body: {
      action: 'request-more-info' as const,
      expectedRevision: 1,
      message: 'Please provide an exact timestamp.',
    },
    expectedTriageState: 'needs-information',
  },
  {
    name: 'reject',
    body: {
      action: 'reject' as const,
      expectedRevision: 1,
      reason: 'This request is outside our support scope.',
    },
    expectedTriageState: 'declined',
  },
])('commits legacy Request $name and matching Triage transition together', async ({
  body,
  expectedTriageState,
}) => {
  const submission = createLegacySubmission()
  const entry = createLegacyTriageEntry(submission)
  let receivedAction: unknown
  let receivedTransactionItems:
    NonNullable<TransactWriteCommandInput['TransactItems']> | undefined
  configureFakeProjectClients(true, {
    workspaceRole: 'owner',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })
  setTestAppDependencies({
    triage: createLegacyTriageClient(entry),
    requestIntake: createRequestIntakeClient({
      getSubmission: async () => submission,
      applyAction: async (
        _workspaceId,
        _submissionId,
        _actor,
        input,
        additionalTransactionItems,
      ) => {
        receivedAction = input
        receivedTransactionItems = additionalTransactionItems
        return submission
      },
    }),
  })

  const response = await app.request(
    `/api/request-submissions/${submission.id}/actions`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': `legacy-${body.action}`,
        'X-Correlation-Id': `legacy-${body.action}-correlation`,
      },
      body: JSON.stringify(body),
    },
  )

  const responseCorrelationId = response.headers.get('X-Correlation-Id')
  expect(response.status).toBe(200)
  expect(responseCorrelationId).toBeString()
  expect(receivedAction).toEqual(body)
  expect(receivedTransactionItems).toHaveLength(body.action === 'assign' ? 7 : 3)
  const triageUpdate = receivedTransactionItems?.find((item) =>
    item.Update?.ConditionExpression === '#revision = :expectedRevision AND teamId = :teamId'
  )
  expect(triageUpdate?.Update).toMatchObject({
    ConditionExpression: '#revision = :expectedRevision AND teamId = :teamId',
    ExpressionAttributeValues: {
      ':expectedRevision': 1,
      ':state': expectedTriageState,
      ':entry': {
        id: entry.id,
        state: expectedTriageState,
        revision: 2,
      },
    },
  })
  const triageReceipt = receivedTransactionItems?.find((item) =>
    item.Put?.Item?.entryType === 'triage-operation-receipt'
  )
  expect(triageReceipt?.Put?.Item).toMatchObject({
    entryType: 'triage-operation-receipt',
    entryId: entry.id,
    resultRevision: 2,
  })
  if (body.action === 'assign') {
    const assignmentAudit = receivedTransactionItems?.find((item) =>
      item.Put?.Item?.eventType === 'triage.assigned'
    )
    expect(assignmentAudit?.Put?.Item).toMatchObject({
      correlationId: responseCorrelationId,
      eventType: 'triage.assigned',
      entity: { type: 'triage-entry', id: entry.id },
      metadata: {
        teamId: entry.teamId,
        triageEntryId: entry.id,
        notificationCandidates: [{
          memberKey: body.assigneeUserId,
          reason: 'triage-assignment',
        }],
      },
      outboxStatus: 'pending',
      sourceDetails: {
        method: 'POST',
        route: `/api/request-submissions/${submission.id}/actions`,
      },
    })
  }
})

test('commits a legacy Request duplicate and canonical Triage source association together', async () => {
  const submission = createLegacySubmission()
  const duplicateTarget = createLegacySubmission({
    id: 'request-duplicate-target',
    receiptId: 'receipt-duplicate-target',
    status: 'converted',
    revision: 2,
    workItem: {
      teamId: 'core-team',
      workItemId: 'canonical-duplicate-target',
      projectId: 'refero',
    },
  })
  const entry = createLegacyTriageEntry(submission)
  let receivedTransactionItems:
    NonNullable<TransactWriteCommandInput['TransactItems']> | undefined
  configureFakeProjectClients(true, {
    workspaceRole: 'owner',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })
  setTestAppDependencies({
    triage: createLegacyTriageClient(entry),
    teamIssues: createLegacyDuplicateTeamIssuesClient(),
    requestIntake: createRequestIntakeClient({
      getSubmission: async (_workspaceId, submissionId) =>
        submissionId === duplicateTarget.id ? duplicateTarget : submission,
      applyAction: async (
        _workspaceId,
        _submissionId,
        _actor,
        _input,
        additionalTransactionItems,
      ) => {
        receivedTransactionItems = additionalTransactionItems
        return submission
      },
    }),
  })

  const response = await app.request(
    `/api/request-submissions/${submission.id}/actions`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'legacy-mark-duplicate',
      },
      body: JSON.stringify({
        action: 'mark-duplicate',
        expectedRevision: 1,
        duplicateOfSubmissionId: duplicateTarget.id,
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(receivedTransactionItems).toHaveLength(5)
  expect(receivedTransactionItems?.[0]?.ConditionCheck).toMatchObject({
    TableName: 'WorkItemsTable',
    ExpressionAttributeValues: { ':expectedRevision': 1 },
  })
  expect(receivedTransactionItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
    ':expectedRevision': 1,
    ':state': 'duplicate',
    ':entry': {
      state: 'duplicate',
      canonicalWorkItem: {
        teamId: 'core-team',
        workItemId: 'canonical-duplicate-target',
      },
      revision: 2,
    },
  })
  expect(receivedTransactionItems?.[3]?.Put?.Item).toMatchObject({
    entryType: 'triage-work-item-source',
    entryId: entry.id,
    workItemId: 'canonical-duplicate-target',
  })
  expect(receivedTransactionItems?.[4]?.Put?.Item).toMatchObject({
    entryType: 'triage-operation-receipt',
    entryId: entry.id,
    resultRevision: 2,
  })
})

const legacyRequestReplayCases = [
  {
    name: 'assign',
    body: {
      action: 'assign',
      expectedRevision: 1,
      assigneeUserId: 'sato@example.com',
    },
    resultingTriageState: 'pending',
  },
  {
    name: 'request-more-info',
    body: {
      action: 'request-more-info',
      expectedRevision: 1,
      message: 'Please provide an exact timestamp.',
    },
    resultingTriageState: 'needs-information',
  },
  {
    name: 'reject',
    body: {
      action: 'reject',
      expectedRevision: 1,
      reason: 'This request is outside our support scope.',
    },
    resultingTriageState: 'declined',
  },
  {
    name: 'mark-duplicate',
    body: {
      action: 'mark-duplicate',
      expectedRevision: 1,
      duplicateOfSubmissionId: 'request-duplicate-target',
    },
    resultingTriageState: 'duplicate',
  },
] satisfies ReadonlyArray<{
  name: string
  body: Exclude<RequestSubmissionActionInput, { action: 'convert' }>
  resultingTriageState: TriageEntry['state']
}>

test.each(legacyRequestReplayCases)(
  'replays legacy Request $name after response loss without a second write',
  async ({ body, resultingTriageState }) => {
    let currentSubmission = createLegacySubmission()
    let currentEntry = createLegacyTriageEntry(currentSubmission)
    const duplicateTarget = createLegacySubmission({
      id: 'request-duplicate-target',
      receiptId: 'receipt-duplicate-target',
      status: 'converted',
      revision: 2,
      workItem: {
        teamId: 'core-team',
        workItemId: 'canonical-duplicate-target',
        projectId: 'refero',
      },
    })
    let committedFingerprint: string | undefined
    let requestWriteCount = 0
    configureFakeProjectClients(true, {
      workspaceRole: 'owner',
      projectAccesses: [{ projectId: 'refero', role: 'manager' }],
    })
    setTestAppDependencies({
      triage: createLegacyTriageClient(currentEntry, {
        getEntry: async () => currentEntry,
        getEntryForMutation: async () => currentEntry,
        getActionReceipt: async (_workspaceId, _entryId, idempotency) => {
          if (committedFingerprint === undefined) {
            committedFingerprint = idempotency.fingerprint
            return undefined
          }
          expect(idempotency.fingerprint).toBe(committedFingerprint)
          return { entry: currentEntry, replayed: true }
        },
      }),
      teamIssues: createLegacyDuplicateTeamIssuesClient(),
      requestIntake: createRequestIntakeClient({
        getSubmission: async (_workspaceId, submissionId) =>
          submissionId === duplicateTarget.id ? duplicateTarget : currentSubmission,
        applyAction: async () => {
          requestWriteCount += 1
          currentEntry = {
            ...currentEntry,
            state: resultingTriageState,
            revision: currentEntry.revision + 1,
          }
          currentSubmission = {
            ...currentSubmission,
            revision: currentSubmission.revision + 1,
          }
          return currentSubmission
        },
      }),
    })

    const request = () => app.request(
      `/api/request-submissions/${currentSubmission.id}/actions`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': `legacy-response-loss-${body.action}`,
        },
        body: JSON.stringify(body),
      },
    )

    const firstResponse = await request()
    const replayResponse = await request()

    expect(firstResponse.status).toBe(200)
    expect(replayResponse.status).toBe(200)
    expect(requestWriteCount).toBe(1)
    expect(await replayResponse.json()).toMatchObject({
      id: currentSubmission.id,
      revision: 2,
    })
  },
)

test('rejects a legacy Request conversion that overrides its Triage owning Team', async () => {
  const submission = createLegacySubmission()
  const entry = createLegacyTriageEntry(submission)
  configureFakeProjectClients(true, {
    workspaceRole: 'owner',
    projectAccesses: [
      { projectId: 'refero', role: 'manager', teamId: 'core-team' },
      { projectId: 'design-project', role: 'manager', teamId: 'design-team' },
    ],
    additionalTeams: [{
      id: 'design-team',
      name: 'Design Team',
      projects: [{
        id: 'design-project',
        name: 'Design Project',
        tone: 'purple',
      }],
    }],
  })
  setTestAppDependencies({
    triage: createLegacyTriageClient(entry),
    requestIntake: createRequestIntakeClient({
      getSubmission: async () => submission,
    }),
  })

  const response = await app.request(
    `/api/request-submissions/${submission.id}/actions`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'legacy-cross-team-conversion',
      },
      body: JSON.stringify({
        action: 'convert',
        expectedRevision: 1,
        target: {
          teamId: 'design-team',
          projectId: 'design-project',
        },
      }),
    },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'RequestTriageTeamConflict',
    message: 'A Triage-backed Request must be accepted in its current Team.',
  })
})

test('returns the converted Request on a response-loss conversion retry without another write', async () => {
  const converted = createLegacySubmission({
    status: 'converted',
    revision: 2,
    workItem: {
      teamId: 'core-team',
      workItemId: 'triage-deterministic-work-item',
      projectId: 'refero',
    },
  })
  const pendingEntry = createLegacyTriageEntry(converted)
  const entry = createLegacyTriageEntry(converted, {
    state: 'accepted',
    revision: 2,
    canonicalWorkItem: converted.workItem,
    capabilities: createTriageCapabilities({
      state: 'accepted',
      permission: pendingEntry.permission,
    }),
  })
  let triageReadCount = 0
  let triageWriteCount = 0
  configureFakeProjectClients(true, {
    workspaceRole: 'owner',
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
  })
  setTestAppDependencies({
    triage: createLegacyTriageClient(entry, {
      getEntryForMutation: async () => {
        triageReadCount += 1
        return entry
      },
      applyAction: async () => {
        triageWriteCount += 1
        return { entry, replayed: false }
      },
    }),
    requestIntake: createRequestIntakeClient({
      getSubmission: async () => converted,
    }),
  })

  const response = await app.request(
    `/api/request-submissions/${converted.id}/actions`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'legacy-response-loss-retry',
      },
      body: JSON.stringify({ action: 'convert', expectedRevision: 1 }),
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    status: 'converted',
    revision: 2,
    workItem: {
      teamId: 'core-team',
      workItemId: 'triage-deterministic-work-item',
      projectId: 'refero',
    },
  })
  expect(triageReadCount).toBe(1)
  expect(triageWriteCount).toBe(0)
})
