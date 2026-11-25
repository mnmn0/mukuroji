import { expect, test } from 'bun:test'
import type { Context } from 'hono'
import type { MyRequestWorkItem, RequestSubmission, RequestWorkItemReference } from '@mukuroji/contracts'
import { RequestIntakeError, type RequestIntakeClient } from '../../request-intake'
import { createMyRequestsRouter } from './my-requests-router'

/**
 * Creates a minimal submission with internal fields the requester must not see.
 *
 * @param overrides - Fields that differ from the default request.
 * @returns A submission view as the Request Intake client returns it.
 */
function createSubmission(overrides: Partial<RequestSubmission> = {}): RequestSubmission {
  return {
    schemaVersion: 1,
    id: 'req-1',
    receiptId: 'rcpt-1',
    formId: 'form-1',
    formVersion: 1,
    formSnapshot: {
      schemaVersion: 1,
      formId: 'form-1',
      version: 1,
      createdBy: 'admin@example.com',
      createdAt: '2026-07-16T08:00:00.000Z',
      snapshot: {
        definition: {
          defaultLocale: 'ja',
          supportedLocales: ['ja'],
          title: { ja: 'IT 依頼' },
          sections: [],
          confirmation: { message: { ja: '受け付けました。' } },
        },
        routing: {
          defaultTarget: { teamId: 'team-secret', assigneeUserId: 'triager@example.com', priority: 'medium', dueDateOffsetDays: 0 },
          rules: [],
          mapping: { titleFieldId: 'title' },
        },
      },
    },
    status: 'needs-more-info',
    source: 'web',
    revision: 3,
    locale: 'ja',
    answers: { title: 'Secret answer' },
    attachments: [],
    routingTarget: { teamId: 'team-secret', assigneeUserId: 'triager@example.com', priority: 'medium', dueDateOffsetDays: 0 },
    workItemMapping: { titleFieldId: 'title' },
    duplicateCandidateIds: [],
    triageAssigneeUserId: 'triager@example.com',
    requesterUserId: 'member@example.com',
    messages: [
      { id: 'm1', direction: 'internal', source: 'internal', body: 'Which laptop?', createdAt: '2026-07-16T09:00:00.000Z' },
    ],
    events: [{ id: 'e1', type: 'rejected', actorId: 'manager@example.com', summary: 'Private reason', createdAt: '2026-07-16T09:00:00.000Z' }],
    createdAt: '2026-07-16T08:30:00.000Z',
    updatedAt: '2026-07-16T09:00:00.000Z',
    capabilities: { canAssign: true, canRequestMoreInfo: true, canReject: true, canMarkDuplicate: true, canConvert: true },
    ...overrides,
  }
}

/**
 * Creates a router around a fake client that knows one request of `member@example.com`.
 *
 * @param readWorkItem - Work Item visibility reader.
 * @returns The router and the replies it saved.
 */
function createRouter(
  readWorkItem: (principal: string, reference: RequestWorkItemReference) => Promise<MyRequestWorkItem | undefined>,
) {
  const replies: Array<{ userKey: string; submissionId: string; body: string }> = []
  const submission = createSubmission({ workItem: { teamId: 'team-secret', workItemId: 'wi-1' } })
  const owned = (userKey: string, submissionId: string) => {
    if (userKey !== 'member@example.com' || submissionId !== 'req-1') {
      throw new RequestIntakeError(404, 'RequestSubmissionNotFound', 'Request submission was not found.')
    }
    return submission
  }
  const unsupported = async (): Promise<never> => {
    throw new Error('Unexpected Request Intake call.')
  }
  const client: RequestIntakeClient = {
    listForms: unsupported,
    listCurrentPublishedFormVersions: unsupported,
    getForm: unsupported,
    createForm: unsupported,
    updateForm: unsupported,
    publishForm: unsupported,
    resolveLink: unsupported,
    getPublicForm: unsupported,
    createAttachmentUpload: unsupported,
    submit: unsupported,
    listSubmissions: unsupported,
    getSubmission: unsupported,
    applyAction: unsupported,
    completeConversion: unsupported,
    getRequesterThread: unsupported,
    replyToThread: unsupported,
    ingestEmail: unsupported,
    createAttachmentAccess: unsupported,
    listRequesterSubmissions: async (_workspaceId, userKey) => ({
      submissions: userKey === 'member@example.com' ? [submission] : [],
    }),
    getRequesterSubmission: async (_workspaceId, userKey, submissionId) => owned(userKey, submissionId),
    replyAsRequester: async (_workspaceId, userKey, submissionId, input) => {
      owned(userKey, submissionId)
      replies.push({ userKey, submissionId, body: input.body })
      return { replyId: 'reply-1', receivedAt: '2026-07-16T10:00:00.000Z' }
    },
  }
  const router = createMyRequestsRouter<string>({
    getRequestIntake: () => client,
    authenticate: async (context: Context) => {
      const userKey = context.req.header('X-Test-User') ?? ''
      return { workspaceId: 'workspace-1', userKey, principal: userKey }
    },
    readWorkItem,
    createExternalContext: () => ({ clientKey: 'client-1' }),
    mapError: (context, error) => error instanceof RequestIntakeError
      ? context.json({ code: error.code }, error.status === 404 ? 404 : 400)
      : context.json({ code: 'Unexpected' }, 500),
    readJson: async (request) => await request.json().catch(() => undefined),
    readLimit: () => undefined,
  })
  return { router, replies }
}

test('returns only requester-safe fields of the member\'s own requests', async () => {
  const { router } = createRouter(async () => ({ visibility: 'restricted', completed: false }))
  const response = await router.request('/api/my-requests', { headers: { 'X-Test-User': 'member@example.com' } })
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toEqual({
    requests: [{
      id: 'req-1',
      receiptId: 'rcpt-1',
      formTitle: 'IT 依頼',
      status: 'needs-more-info',
      awaitingReply: true,
      workItem: { visibility: 'restricted', completed: false },
      submittedAt: '2026-07-16T08:30:00.000Z',
      updatedAt: '2026-07-16T09:00:00.000Z',
    }],
  })
  const text = JSON.stringify(body)
  for (const secret of ['team-secret', 'triager@example.com', 'Secret answer', 'Private reason']) {
    expect(text).not.toContain(secret)
  }
})

test('shows the thread of the member\'s own request and hides other requests', async () => {
  const { router, replies } = createRouter(async () => ({
    visibility: 'visible', teamId: 'team-secret', workItemId: 'wi-1', title: 'Laptop', statusCategory: 'started', completed: false,
  }))
  const detail = await router.request('/api/my-requests/req-1', { headers: { 'X-Test-User': 'member@example.com' } })
  expect(await detail.json()).toMatchObject({
    id: 'req-1',
    workItem: { visibility: 'visible', title: 'Laptop' },
    thread: { status: 'open', messages: [{ id: 'm1', direction: 'staff', body: 'Which laptop?' }] },
  })

  const other = await router.request('/api/my-requests/req-1', { headers: { 'X-Test-User': 'someone@example.com' } })
  expect(other.status).toBe(404)

  const reply = await router.request('/api/my-requests/req-1/replies', {
    method: 'POST',
    headers: { 'X-Test-User': 'member@example.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: '  The blue one  ' }),
  })
  expect(reply.status).toBe(201)
  expect(replies).toEqual([{ userKey: 'member@example.com', submissionId: 'req-1', body: 'The blue one' }])

  const blank = await router.request('/api/my-requests/req-1/replies', {
    method: 'POST',
    headers: { 'X-Test-User': 'member@example.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: ' ' }),
  })
  expect(blank.status).toBe(400)
})
