import { describe, expect, test } from 'bun:test'
import type {
  RequestForm,
  RequestFormDraft,
} from '@mukuroji/contracts'
import {
  createAdminRequestIntakeRouter,
  type AdminRequestIntakeClient,
  type AdminRequestIntakeRouterDependencies,
  type RequestIntakeAdministrator,
} from './admin-request-intake-router'
import { RequestIntakeError } from '../../request-intake'

const principal: RequestIntakeAdministrator = {
  directoryId: 'workspace-1',
  userKey: 'user-1',
}

const draft = {
  definition: {
    defaultLocale: 'en',
    supportedLocales: ['en'],
    title: { en: 'Feedback' },
    sections: [{
      id: 'details',
      title: { en: 'Details' },
      fields: [{
        id: 'summary',
        type: 'short-text',
        label: { en: 'Summary' },
      }],
    }],
    confirmation: { message: { en: 'Thanks for your feedback.' } },
  },
  routing: {
    defaultTarget: {
      teamId: 'team-1',
      assigneeUserId: 'user-1',
      priority: 'medium',
      dueDateOffsetDays: 1,
    },
    rules: [],
    mapping: { titleFieldId: 'summary' },
  },
} satisfies RequestFormDraft

const form: RequestForm = {
  id: 'form-1',
  name: 'Feedback',
  scope: { type: 'workspace' },
  status: 'draft',
  revision: 7,
  draft,
  publishedVersions: [],
  link: {
    linkId: 'link-1',
    token: 'token-1',
    accessMode: 'public',
  },
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
  capabilities: {
    canEdit: true,
    canPublish: true,
    canManageLink: true,
  },
}

const submission: unknown = { id: 'submission-1' }
const submissionPage: unknown = { submissions: [submission] }

/** Creates the default Request Intake client test double.
 *
 * @param calls The call log shared by the test.
 * @param overrides Method overrides for an individual test.
 * @returns A client boundary suitable for the admin router dependencies.
 */
function createRequestIntakeClient(
  calls: Array<{ operation: string; value: unknown }>,
  overrides: Partial<AdminRequestIntakeClient> = {},
): AdminRequestIntakeClient {
  return {
    listForms: async (workspaceId) => {
      calls.push({ operation: 'listForms', value: workspaceId })
      return { forms: [form] }
    },
    createForm: async (workspaceId, actor, input) => {
      calls.push({ operation: 'createForm', value: { workspaceId, actor, input } })
      return form
    },
    getForm: async (workspaceId, formId) => {
      calls.push({ operation: 'getForm', value: { workspaceId, formId } })
      return form
    },
    updateForm: async (workspaceId, formId, actor, input) => {
      calls.push({ operation: 'updateForm', value: { workspaceId, formId, actor, input } })
      return form
    },
    publishForm: async (workspaceId, formId, actor, input) => {
      calls.push({ operation: 'publishForm', value: { workspaceId, formId, actor, input } })
      return form
    },
    listSubmissions: async (workspaceId, options) => {
      calls.push({ operation: 'listSubmissions', value: { workspaceId, options } })
      return submissionPage
    },
    getSubmission: async (workspaceId, submissionId) => {
      calls.push({ operation: 'getSubmission', value: { workspaceId, submissionId } })
      return submission
    },
    createAttachmentAccess: async (workspaceId, submissionId, attachmentId) => {
      calls.push({
        operation: 'createAttachmentAccess',
        value: { workspaceId, submissionId, attachmentId },
      })
      return { downloadUrl: 'https://downloads.example.com/file' }
    },
    ...overrides,
  }
}

/** Creates admin router dependencies with a call-logging client.
 *
 * @param overrides Dependency overrides for an individual test.
 * @param requestIntakeOverrides Request Intake client method overrides.
 * @returns The call log and configured router.
 */
function createDependencies(
  overrides: Partial<AdminRequestIntakeRouterDependencies> = {},
  requestIntakeOverrides: Partial<AdminRequestIntakeClient> = {},
) {
  const calls: Array<{ operation: string; value: unknown }> = []
  const requestIntake = createRequestIntakeClient(calls, requestIntakeOverrides)
  const dependencies: AdminRequestIntakeRouterDependencies = {
    getRequestIntake: () => requestIntake,
    async requireAdministration(context) {
      calls.push({ operation: 'requireAdministration', value: context })
      return principal
    },
    async requireFormManagement(context) {
      calls.push({ operation: 'requireFormManagement', value: context })
      return { ...principal, workspace: true, teamIds: [] }
    },
    readJson: async (request) => await request.json(),
    async validateFormRoutingReferences(workspaceId: string, draft: RequestFormDraft) {
      calls.push({ operation: 'validateFormRoutingReferences', value: { workspaceId, draft } })
    },
    readSubmissionStatus(value) {
      calls.push({ operation: 'readSubmissionStatus', value })
      return value === 'received' ? value : undefined
    },
    readQueueLimit(value) {
      calls.push({ operation: 'readQueueLimit', value })
      return value ? Number(value) : undefined
    },
    mapError: (context) => context.json({ code: 'mapped' }, 503),
    ...overrides,
  }

  return { calls, router: createAdminRequestIntakeRouter(dependencies) }
}

describe('admin request intake router', () => {
  test('authenticates and forwards form management operations', async () => {
    const { calls, router } = createDependencies()
    const listResponse = await router.request('/api/request-forms')
    const createResponse = await router.request('/api/request-forms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Feedback',
        scope: { type: 'workspace' },
        accessMode: 'public',
        draft,
      }),
    })
    const detailResponse = await router.request('/api/request-forms/form-1')
    const updateResponse = await router.request('/api/request-forms/form-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7 }),
    })

    expect(listResponse.status).toBe(200)
    expect(createResponse.status).toBe(201)
    expect(detailResponse.status).toBe(200)
    expect(updateResponse.status).toBe(200)
    expect(calls.filter(({ operation }) => operation === 'requireFormManagement')).toHaveLength(4)
    expect(calls.find(({ operation }) => operation === 'createForm')?.value).toMatchObject({
      workspaceId: principal.directoryId,
      actor: { id: principal.userKey },
      input: { name: 'Feedback' },
    })
    expect(calls.find(({ operation }) => operation === 'updateForm')?.value).toMatchObject({
      formId: 'form-1',
      actor: { id: principal.userKey },
      input: { expectedRevision: 7 },
    })
  })

  test('validates the current draft before publishing a matching revision', async () => {
    const { calls, router } = createDependencies()
    const response = await router.request('/api/request-forms/form-1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7 }),
    })

    expect(response.status).toBe(200)
    expect(calls.map(({ operation }) => operation)).toEqual([
      'requireFormManagement',
      'getForm',
      'validateFormRoutingReferences',
      'publishForm',
    ])
    expect(calls.find(({ operation }) => operation === 'publishForm')?.value).toMatchObject({
      workspaceId: principal.directoryId,
      formId: 'form-1',
      actor: { id: principal.userKey },
      input: { expectedRevision: 7 },
    })
  })

  test('forwards configuration guards returned by routing validation', async () => {
    const guard = {
      ConditionCheck: {
        TableName: 'mukuroji-work-item-configuration-local',
        Key: { scopeKey: 'workspace-1', recordKey: 'CONFIG' },
        ConditionExpression: 'attribute_exists(scopeKey)',
      },
    }
    let receivedGuards: unknown
    const { router } = createDependencies({
      validateFormRoutingReferences: async () => [guard],
    }, {
      publishForm: async (_workspaceId, _formId, _actor, _input, additionalTransactionItems) => {
        receivedGuards = additionalTransactionItems
        return form
      },
    })

    const response = await router.request('/api/request-forms/form-1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7 }),
    })

    expect(response.status).toBe(200)
    expect(receivedGuards).toEqual([guard])
  })

  test('forwards queue filters, submission detail, and attachment access', async () => {
    const { calls, router } = createDependencies()
    const queueResponse = await router.request(
      '/api/request-queue?status=received&limit=25&cursor=next-page',
    )
    const detailResponse = await router.request('/api/request-submissions/submission-1')
    const accessResponse = await router.request(
      '/api/request-submissions/submission-1/attachments/attachment-1/access',
      { method: 'POST' },
    )

    expect(queueResponse.status).toBe(200)
    expect(detailResponse.status).toBe(200)
    expect(accessResponse.status).toBe(200)
    expect(calls.find(({ operation }) => operation === 'listSubmissions')?.value).toEqual({
      workspaceId: principal.directoryId,
      options: { status: 'received', limit: 25, cursor: 'next-page' },
    })
    expect(calls.find(({ operation }) => operation === 'getSubmission')?.value).toEqual({
      workspaceId: principal.directoryId,
      submissionId: 'submission-1',
    })
    expect(calls.find(({ operation }) => operation === 'createAttachmentAccess')?.value).toEqual({
      workspaceId: principal.directoryId,
      submissionId: 'submission-1',
      attachmentId: 'attachment-1',
    })
  })

  test('maps authentication failures without calling downstream operations', async () => {
    const failure = new Error('not authorized')
    const { calls, router } = createDependencies({
      async requireFormManagement() {
        throw failure
      },
      mapError: (context, error) => {
        expect(error).toBe(failure)
        return context.json({ code: 'RequestAuthenticationRequired' }, 401)
      },
    })

    const response = await router.request('/api/request-forms')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'RequestAuthenticationRequired' })
    expect(calls.map(({ operation }) => operation)).toEqual([])
  })

  test('maps a stale publish revision from the application client', async () => {
    const conflict = new RequestIntakeError(
      409,
      'RequestRevisionConflict',
      'Request resource revision changed.',
    )
    let publishCalled = false
    const { calls, router } = createDependencies({
      mapError: (context, error) => {
        expect(error).toBe(conflict)
        return context.json({ code: 'RequestRevisionConflict' }, 409)
      },
    }, {
      publishForm: async () => {
        publishCalled = true
        throw conflict
      },
    })

    const response = await router.request('/api/request-forms/form-1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7 }),
    })

    expect(response.status).toBe(409)
    expect(calls.map(({ operation }) => operation)).toEqual([
      'requireFormManagement',
      'getForm',
      'validateFormRoutingReferences',
    ])
    expect(publishCalled).toBe(true)
  })

  test('rejects malformed mutation bodies before calling the application client', async () => {
    const { calls, router } = createDependencies({
      mapError: (context, error) => {
        expect(error).toMatchObject({ code: 'InvalidRequestIntakeInput', status: 400 })
        return context.json({ code: 'InvalidRequestIntakeInput' }, 400)
      },
    })

    const createResponse = await router.request('/api/request-forms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Feedback' }),
    })
    const updateResponse = await router.request('/api/request-forms/form-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: '7' }),
    })
    const publishResponse = await router.request('/api/request-forms/form-1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7.5 }),
    })

    expect(createResponse.status).toBe(400)
    expect(updateResponse.status).toBe(400)
    expect(publishResponse.status).toBe(400)
    expect(calls.map(({ operation }) => operation)).toEqual([
      'requireFormManagement',
      'requireFormManagement',
      'requireFormManagement',
    ])
  })

  test('limits a Team manager to the forms of their own Teams', async () => {
    const teamForm: RequestForm = { ...form, id: 'form-team', scope: { type: 'team', teamId: 'core' } }
    const otherTeamForm: RequestForm = { ...form, id: 'form-other', scope: { type: 'team', teamId: 'ops' } }
    const forms = new Map([form, teamForm, otherTeamForm].map((entry) => [entry.id, entry]))
    const { calls, router } = createDependencies({
      async requireFormManagement() {
        return { ...principal, workspace: false, teamIds: ['core'] }
      },
      mapError: (context, error) => {
        expect(error).toMatchObject({ code: 'RequestFormScopeDenied', status: 403 })
        return context.json({ code: 'RequestFormScopeDenied' }, 403)
      },
    }, {
      listForms: async () => ({ forms: [...forms.values()] }),
      getForm: async (_workspaceId, formId) => forms.get(formId) ?? form,
    })

    const listResponse = await router.request('/api/request-forms')
    const ownDetail = await router.request('/api/request-forms/form-team')
    const otherDetail = await router.request('/api/request-forms/form-other')
    const workspaceDetail = await router.request('/api/request-forms/form-1')
    const createWorkspace = await router.request('/api/request-forms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Feedback', scope: { type: 'workspace' }, accessMode: 'public', draft }),
    })
    const createOwn = await router.request('/api/request-forms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Feedback', scope: { type: 'team', teamId: 'core' }, accessMode: 'public', draft }),
    })
    const moveToOther = await router.request('/api/request-forms/form-team', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7, scope: { type: 'team', teamId: 'ops' } }),
    })
    const publishOther = await router.request('/api/request-forms/form-other/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7 }),
    })

    expect(await listResponse.json()).toEqual({ forms: [teamForm] })
    expect(ownDetail.status).toBe(200)
    expect(otherDetail.status).toBe(403)
    expect(workspaceDetail.status).toBe(403)
    expect(createWorkspace.status).toBe(403)
    expect(createOwn.status).toBe(201)
    expect(moveToOther.status).toBe(403)
    expect(publishOther.status).toBe(403)
    expect(calls.filter(({ operation }) => operation === 'createForm')).toHaveLength(1)
    expect(calls.some(({ operation }) => operation === 'updateForm' || operation === 'publishForm')).toBe(false)
  })

  test('binds form changes to the revision whose scope was authorized', async () => {
    const teamForm: RequestForm = { ...form, id: 'form-team', scope: { type: 'team', teamId: 'core' } }
    const { calls, router } = createDependencies({
      async requireFormManagement() {
        return { ...principal, workspace: false, teamIds: ['core'] }
      },
      mapError: (context, error) => {
        expect(error).toMatchObject({ code: 'RequestRevisionConflict', status: 409 })
        return context.json({ code: 'RequestRevisionConflict' }, 409)
      },
    }, {
      getForm: async () => teamForm,
    })

    const update = await router.request('/api/request-forms/form-team', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: teamForm.revision + 1, name: 'Renamed' }),
    })
    const publish = await router.request('/api/request-forms/form-team/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: teamForm.revision + 1 }),
    })

    expect(update.status).toBe(409)
    expect(publish.status).toBe(409)
    expect(calls.some(({ operation }) => operation === 'updateForm' || operation === 'publishForm')).toBe(false)
  })
})
