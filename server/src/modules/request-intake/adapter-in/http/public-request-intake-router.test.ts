import { describe, expect, test } from 'bun:test'
import type {
  PublicRequestForm,
  RequestAttachmentUploadSession,
  RequestRequesterReplyReceipt,
  RequestRequesterThread,
  RequestSubmissionReceipt,
} from '@mukuroji/contracts'
import {
  createPublicRequestIntakeRouter,
  type PublicRequestIntakeRouterDependencies,
} from './public-request-intake-router'
import type {
  RequestExternalContext,
  RequestIntakeClient,
  RequestLinkResolution,
} from '../../request-intake'

const resolution: RequestLinkResolution = {
  workspaceId: 'workspace-1',
  formId: 'form-1',
  accessMode: 'public',
  tokenDigest: 'token-digest',
}

const externalContext: RequestExternalContext = {
  clientKey: '203.0.113.10',
  idempotencyKey: 'request-1',
}

const publicForm = {
  id: 'form-1',
} as unknown as PublicRequestForm

const uploadSession = {
  uploadUrl: 'https://uploads.example.com/put',
} as unknown as RequestAttachmentUploadSession

const submissionReceipt = {
  submissionId: 'submission-1',
} as unknown as RequestSubmissionReceipt

const requesterThread = {
  submissionId: 'submission-1',
  messages: [],
} as unknown as RequestRequesterThread

const replyReceipt = {
  replyId: 'reply-1',
} as unknown as RequestRequesterReplyReceipt

function createDependencies(
  overrides: Partial<PublicRequestIntakeRouterDependencies> = {},
) {
  const calls: Array<{ operation: string; value: unknown }> = []
  const requestIntake = {
    async resolveLink(token: string) {
      calls.push({ operation: 'resolveLink', value: token })
      return resolution
    },
    async getPublicForm(value: RequestLinkResolution, context: RequestExternalContext) {
      calls.push({ operation: 'getPublicForm', value: { value, context } })
      return publicForm
    },
    async createAttachmentUpload(
      value: RequestLinkResolution,
      input: unknown,
      context: RequestExternalContext,
    ) {
      calls.push({ operation: 'createAttachmentUpload', value: { value, input, context } })
      return uploadSession
    },
    async submit(
      value: RequestLinkResolution,
      input: unknown,
      context: RequestExternalContext,
    ) {
      calls.push({ operation: 'submit', value: { value, input, context } })
      return submissionReceipt
    },
    async getRequesterThread(token: string, context: RequestExternalContext) {
      calls.push({ operation: 'getRequesterThread', value: { token, context } })
      return requesterThread
    },
    async replyToThread(token: string, input: unknown, context: RequestExternalContext) {
      calls.push({ operation: 'replyToThread', value: { token, input, context } })
      return replyReceipt
    },
  } as unknown as RequestIntakeClient
  const dependencies: PublicRequestIntakeRouterDependencies = {
    requestIntake,
    async authorizeRequestLink(context, value) {
      calls.push({ operation: 'authorizeRequestLink', value: { context, value } })
    },
    createExternalContext() {
      return externalContext
    },
    mapError: (context) => context.json({ code: 'mapped' }, 503),
    readJson: async (request) => await request.json(),
    ...overrides,
  }

  return { calls, router: createPublicRequestIntakeRouter(dependencies) }
}

describe('public request intake router', () => {
  test('resolves and authorizes a public form before returning its safe view', async () => {
    const { calls, router } = createDependencies()

    const response = await router.request('/api/request-intake/capability-token')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(publicForm)
    expect(calls.map(({ operation }) => operation)).toEqual([
      'resolveLink',
      'authorizeRequestLink',
      'getPublicForm',
    ])
  })

  test('passes external context and normalized route inputs to upload and submission operations', async () => {
    const { calls, router } = createDependencies()
    const uploadResponse = await router.request('/api/request-intake/token/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionToken: 'session-token',
        fieldId: 'attachment',
        fileName: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 42,
      }),
    })
    const submissionResponse = await router.request('/api/request-intake/token/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionToken: 'session-token',
        locale: 'ja',
        answers: { summary: 'hello' },
      }),
    })

    expect(uploadResponse.status).toBe(201)
    expect(await uploadResponse.json()).toEqual(uploadSession)
    expect(submissionResponse.status).toBe(201)
    expect(await submissionResponse.json()).toEqual(submissionReceipt)
    expect(calls.filter(({ operation }) => operation === 'authorizeRequestLink')).toHaveLength(2)
    expect(calls.find(({ operation }) => operation === 'createAttachmentUpload')?.value).toMatchObject({
      context: externalContext,
      input: {
        sessionToken: 'session-token',
        fieldId: 'attachment',
        fileName: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 42,
      },
    })
    expect(calls.find(({ operation }) => operation === 'submit')?.value).toMatchObject({
      context: externalContext,
      input: {
        sessionToken: 'session-token',
        locale: 'ja',
        answers: { summary: 'hello' },
      },
    })
  })

  test('serves requester threads and writes replies without link authorization', async () => {
    const { calls, router } = createDependencies()
    const threadResponse = await router.request('/api/request-threads/thread-token')
    const replyResponse = await router.request('/api/request-threads/thread-token/replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'More details' }),
    })

    expect(threadResponse.status).toBe(200)
    expect(await threadResponse.json()).toEqual(requesterThread)
    expect(replyResponse.status).toBe(201)
    expect(await replyResponse.json()).toEqual(replyReceipt)
    expect(calls.map(({ operation }) => operation)).toEqual([
      'getRequesterThread',
      'replyToThread',
    ])
    expect(calls.find(({ operation }) => operation === 'replyToThread')?.value).toMatchObject({
      input: { body: 'More details' },
    })
  })

  test('rejects malformed mutation bodies before invoking request intake operations', async () => {
    const { calls, router } = createDependencies({
      mapError: (context, error) => {
        expect(error).toMatchObject({
          code: 'InvalidRequestIntakeInput',
          status: 400,
        })
        return context.json({ code: 'InvalidRequestIntakeInput' }, 400)
      },
    })

    const uploadResponse = await router.request('/api/request-intake/token/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldId: 'attachment', fileName: 'report.pdf' }),
    })
    const submissionResponse = await router.request('/api/request-intake/token/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: { summary: 'hello' } }),
    })
    const replyResponse = await router.request('/api/request-threads/thread-token/replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'More details' }),
    })

    expect(uploadResponse.status).toBe(400)
    expect(submissionResponse.status).toBe(400)
    expect(replyResponse.status).toBe(400)
    expect(calls.map(({ operation }) => operation)).toEqual([
      'resolveLink',
      'authorizeRequestLink',
      'resolveLink',
      'authorizeRequestLink',
    ])
  })

  test('maps request intake failures at the public boundary', async () => {
    const failure = new Error('request intake unavailable')
    const { router } = createDependencies({
      mapError: (context, error) => {
        expect(error).toBe(failure)
        return context.json({ code: 'RequestIntakeUnavailable' }, 503)
      },
      requestIntake: {
        async resolveLink() {
          throw failure
        },
      } as unknown as RequestIntakeClient,
    })

    const response = await router.request('/api/request-intake/token')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: 'RequestIntakeUnavailable' })
  })
})
