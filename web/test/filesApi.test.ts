import { afterEach, describe, expect, test } from 'bun:test'
import {
  cancelApprovalRequest,
  createApprovalDecision,
  createApprovalRequest,
  createCommentFileUpload,
  createFileAnnotation,
  createProjectFileUpload,
  createWorkItemFileUpload,
  getFileVersionAccess,
  FilesApiError,
  putPresignedFile,
} from '../src/files/api'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-files-1',
  idempotencyKey: 'idempotency-files-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('file artifacts API', () => {
  test('creates team-scoped Work Item, comment, and Project upload sessions', async () => {
    const requests: Array<{ init: RequestInit; url: string }> = []
    globalThis.fetch = createFetchRecorder(requests, createUploadSessionResponse())

    const input = { contentType: 'image/png', fileName: 'proof 1.png', sizeBytes: 120 }

    await createWorkItemFileUpload('core team', 'issue/1', 'token', input, mutationContext)
    await createCommentFileUpload('core team', 'issue/1', 'comment/1', 'token', input, mutationContext)
    await createProjectFileUpload('core team', 'project/1', 'token', input, mutationContext)

    expect(requests.map((request) => request.url)).toEqual([
      '/api/teams/core%20team/issues/issue%2F1/files/uploads',
      '/api/teams/core%20team/issues/issue%2F1/comments/comment%2F1/files/uploads',
      '/api/teams/core%20team/projects/project%2F1/files/uploads',
    ])
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer token',
      'Idempotency-Key': mutationContext.idempotencyKey,
      'X-Correlation-Id': mutationContext.correlationId,
    })
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(input)
  })

  test('uploads file bytes directly to the signed URL without API authorization', async () => {
    const requests: Array<{ init: RequestInit; url: string }> = []
    globalThis.fetch = createFetchRecorder(requests, undefined, 204)
    const file = new File(['proof'], 'proof.png', { type: 'image/png' })

    await putPresignedFile({
      expiresAt: '2026-07-12T03:00:00.000Z',
      headers: { 'Content-Type': 'image/png', 'x-amz-meta-upload-id': 'upload-1' },
      maxSizeBytes: 1_000,
      method: 'PUT',
      url: 'https://uploads.example.test/object',
    }, file)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://uploads.example.test/object')
    expect(requests[0]?.init.method).toBe('PUT')
    expect(requests[0]?.init.body).toBe(file)
    expect(requests[0]?.init.headers).toEqual({
      'Content-Type': 'image/png',
      'x-amz-meta-upload-id': 'upload-1',
    })
    expect(requests[0]?.init.headers).not.toHaveProperty('Authorization')
  })

  test('rejects a file larger than the signed session limit before object storage is called', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response(undefined, { status: 200 })
    }) as typeof fetch
    const file = new File(['too large'], 'proof.png', { type: 'image/png' })
    const request = putPresignedFile({
      expiresAt: '2026-07-12T03:00:00.000Z',
      headers: { 'Content-Type': 'image/png' },
      maxSizeBytes: 2,
      method: 'PUT',
      url: 'https://uploads.example.test/object',
    }, file)

    await expect(request).rejects.toMatchObject({ code: 'FileTooLarge', status: 413 })
    expect(fetchCalled).toBeFalse()
  })

  test('keeps preview access, annotation, and approval mutations resource scoped', async () => {
    const requests: Array<{ init: RequestInit; url: string }> = []
    globalThis.fetch = createFetchRecorder(requests, {
      annotation: {},
      approval: {},
      expiresAt: '2026-07-12T03:00:00.000Z',
      url: 'https://downloads.example.test/object',
    })

    await getFileVersionAccess('core', 'issue/1', 'file/1', 'version/1', 'token', 'inline')
    await createFileAnnotation(
      'core',
      'issue/1',
      'file/1',
      'version/1',
      'token',
      { anchor: { kind: 'pdf', pageNumber: 2, x: 0.2, y: 0.4 }, bodyMarkdown: 'Check' },
      mutationContext,
    )
    await createApprovalRequest(
      'core',
      'issue/1',
      'token',
      {
        dueAt: '2026-07-15T00:00:00.000Z',
        fileId: 'file/1',
        reviewerMemberKeys: ['member/1'],
        versionId: 'version/1',
      },
      mutationContext,
    )
    await createApprovalDecision(
      'core',
      'issue/1',
      'approval/1',
      'token',
      { decision: 'request-changes', expectedRevision: 3 },
      mutationContext,
    )
    await cancelApprovalRequest(
      'core',
      'issue/1',
      'approval/1',
      'token',
      { expectedRevision: 4 },
      mutationContext,
    )

    expect(requests.map((request) => [request.init.method ?? 'GET', request.url])).toEqual([
      ['GET', '/api/teams/core/issues/issue%2F1/files/file%2F1/versions/version%2F1/access?disposition=inline'],
      ['POST', '/api/teams/core/issues/issue%2F1/files/file%2F1/versions/version%2F1/annotations'],
      ['POST', '/api/teams/core/issues/issue%2F1/approvals'],
      ['POST', '/api/teams/core/issues/issue%2F1/approvals/approval%2F1/decisions'],
      ['POST', '/api/teams/core/issues/issue%2F1/approvals/approval%2F1/cancel'],
    ])
    expect(JSON.parse(String(requests[3]?.init.body))).toEqual({
      decision: 'request-changes',
      expectedRevision: 3,
    })
    expect(JSON.parse(String(requests[4]?.init.body))).toEqual({ expectedRevision: 4 })
  })

  test('preserves scan and permission error codes from signed access requests', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 'FileThreatDetected',
      message: 'Malware scanning blocked this file.',
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 423,
    })) as typeof fetch

    const request = getFileVersionAccess(
      'core',
      'issue-1',
      'file-1',
      'version-1',
      'token',
      'inline',
    )

    await expect(request).rejects.toBeInstanceOf(FilesApiError)
    await expect(request).rejects.toMatchObject({
      code: 'FileThreatDetected',
      status: 423,
    })
  })
})

function createFetchRecorder(
  requests: Array<{ init: RequestInit; url: string }>,
  responseBody: unknown,
  status = 200,
) {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      init,
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    })

    return new Response(responseBody === undefined ? undefined : JSON.stringify(responseBody), {
      headers: responseBody === undefined ? undefined : { 'Content-Type': 'application/json' },
      status,
    })
  }) as typeof fetch
}

function createUploadSessionResponse() {
  return {
    file: {},
    version: {},
    upload: {
      expiresAt: '2026-07-12T03:00:00.000Z',
      headers: { 'Content-Type': 'image/png' },
      maxSizeBytes: 1_000,
      method: 'PUT',
      url: 'https://uploads.example.test/object',
    },
  }
}
