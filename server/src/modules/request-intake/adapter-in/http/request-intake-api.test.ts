import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  DynamoDbTeamIssuesClient,
} from '../../../work-items'
import {
  resolveRequestClientKey,
} from '../../../../api/api-router'
import type {
  RequestIntakeClient,
} from '../../request-intake'
import {
  RequestIntakeError,
} from '../../request-intake'
import type {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import type {
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type {
  PublicRequestForm,
  RequestForm,
  RequestFormDraft,
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
        submissionId: 'req_20260716_atomic',
        type: 'converted',
        actorId: 'admin@example.com',
      },
      ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    },
  })
})
