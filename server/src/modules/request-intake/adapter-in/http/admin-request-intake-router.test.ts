import { describe, expect, test } from 'bun:test'
import type {
  RequestForm,
  RequestFormDraft,
  RequestSubmission,
  RequestSubmissionPage,
} from '@mukuroji/contracts'
import {
  createAdminRequestIntakeRouter,
  type AdminRequestIntakeRouterDependencies,
  type RequestIntakeAdministrator,
} from './admin-request-intake-router'
import type { RequestIntakeClient } from '../../request-intake'

const principal: RequestIntakeAdministrator = {
  directoryId: 'workspace-1',
  userKey: 'user-1',
}

const form = {
  id: 'form-1',
  revision: 7,
  draft: {},
} as unknown as RequestForm

const submission = {
  id: 'submission-1',
} as unknown as RequestSubmission

const submissionPage = {
  submissions: [submission],
} as unknown as RequestSubmissionPage

function createDependencies(
  overrides: Partial<AdminRequestIntakeRouterDependencies> = {},
) {
  const calls: Array<{ operation: string; value: unknown }> = []
  const requestIntake = {
    async listForms(workspaceId: string) {
      calls.push({ operation: 'listForms', value: workspaceId })
      return { forms: [form] }
    },
    async createForm(workspaceId: string, actor: { id: string }, input: unknown) {
      calls.push({ operation: 'createForm', value: { workspaceId, actor, input } })
      return form
    },
    async getForm(workspaceId: string, formId: string) {
      calls.push({ operation: 'getForm', value: { workspaceId, formId } })
      return form
    },
    async updateForm(
      workspaceId: string,
      formId: string,
      actor: { id: string },
      input: unknown,
    ) {
      calls.push({ operation: 'updateForm', value: { workspaceId, formId, actor, input } })
      return form
    },
    async publishForm(
      workspaceId: string,
      formId: string,
      actor: { id: string },
      input: unknown,
    ) {
      calls.push({ operation: 'publishForm', value: { workspaceId, formId, actor, input } })
      return form
    },
    async listSubmissions(workspaceId: string, options: unknown) {
      calls.push({ operation: 'listSubmissions', value: { workspaceId, options } })
      return submissionPage
    },
    async getSubmission(workspaceId: string, submissionId: string) {
      calls.push({ operation: 'getSubmission', value: { workspaceId, submissionId } })
      return submission
    },
    async createAttachmentAccess(
      workspaceId: string,
      submissionId: string,
      attachmentId: string,
    ) {
      calls.push({
        operation: 'createAttachmentAccess',
        value: { workspaceId, submissionId, attachmentId },
      })
      return { downloadUrl: 'https://downloads.example.com/file' }
    },
  } as unknown as RequestIntakeClient
  const dependencies: AdminRequestIntakeRouterDependencies = {
    requestIntake,
    async requireAdministration(context) {
      calls.push({ operation: 'requireAdministration', value: context })
      return principal
    },
    readJson: async (request) => await request.json(),
    async validateFormRoutingReferences(workspaceId: string, draft: RequestFormDraft) {
      calls.push({ operation: 'validateFormRoutingReferences', value: { workspaceId, draft } })
    },
    readSubmissionStatus(value) {
      calls.push({ operation: 'readSubmissionStatus', value })
      return value as 'received' | undefined
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
      body: JSON.stringify({ name: 'Feedback' }),
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
    expect(calls.filter(({ operation }) => operation === 'requireAdministration')).toHaveLength(4)
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
      'requireAdministration',
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

  test('maps authentication and revision failures without calling downstream operations', async () => {
    const failure = new Error('not authorized')
    const { calls, router } = createDependencies({
      async requireAdministration() {
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

  test('maps a stale publish revision and does not publish', async () => {
    const stale = {
      ...form,
      revision: 8,
    }
    const { calls, router } = createDependencies({
      requestIntake: {
        async getForm() {
          return stale
        },
      } as unknown as RequestIntakeClient,
      mapError: (context, error) => {
        expect(error).toMatchObject({ code: 'RequestRevisionConflict', status: 409 })
        return context.json({ code: 'RequestRevisionConflict' }, 409)
      },
    })

    const response = await router.request('/api/request-forms/form-1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7 }),
    })

    expect(response.status).toBe(409)
    expect(calls.map(({ operation }) => operation)).toEqual(['requireAdministration'])
  })
})
