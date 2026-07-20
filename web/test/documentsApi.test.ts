import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyDocumentOperations,
  applyDocumentOperationsWithConflictAwareness,
  deleteDocumentShare,
  getDocumentBacklinksBatch,
  getDocumentCollection,
  getNextDocumentCollectionPage,
  getDocumentShares,
  getDocumentVersions,
  getDocuments,
  getPublicDocument,
  resolvePublicDocumentUrl,
  resolveDocumentsApiBaseUrl,
  DocumentRevisionConflictError,
  DocumentsApiError,
} from '../src/documents/api'
import {
  documentRecordFixture,
  documentSummaryFixtures,
  documentVersionFixtures,
  publicDocumentFixture,
} from '../src/documents/fixtures'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Documents API base URL', () => {
  test('uses the shared Workspace API fallback order', () => {
    expect(resolveDocumentsApiBaseUrl({
      VITE_API_BASE_URL: 'https://api.example.test/',
      VITE_PROJECTS_API_BASE_URL: 'https://projects.example.test/',
      VITE_WORKSPACE_API_BASE_URL: 'https://workspace.example.test/',
    })).toBe('https://workspace.example.test')
    expect(resolveDocumentsApiBaseUrl({})).toBe('/api')
  })
})

describe('Canonical Documents API requests', () => {
  test('reads DocumentTreeResponse nodes with bearer authentication', async () => {
    const requests: Request[] = []
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request = createRequest(input, init)
      requests.push(request)
      return Response.json({ nodes: documentSummaryFixtures })
    }) as typeof fetch

    const documents = await getDocuments('access-token')

    expect(documents).toEqual(documentSummaryFixtures)
    expect(requests[0]?.headers.get('Authorization')).toBe(
      'Bearer access-token',
    )
  })

  test('loads active and archived Document trees one explicit page at a time', async () => {
    const requests: Request[] = []
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request = createRequest(input, init)
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname.endsWith('/documents/recent')) {
        return Response.json({ documents: [] })
      }
      if (url.searchParams.get('archived') === 'true') {
        return Response.json({ nodes: [documentSummaryFixtures.at(-1)] })
      }
      if (url.searchParams.get('cursor') === 'active-next') {
        return Response.json({ nodes: [documentSummaryFixtures[1]] })
      }
      return Response.json({
        nextCursor: 'active-next',
        nodes: [documentSummaryFixtures[0]],
      })
    }) as typeof fetch

    const firstPage = await getDocumentCollection('access-token')
    const documents = await getNextDocumentCollectionPage(
      'access-token',
      firstPage,
      false,
    )

    expect(documents.documents.map(({ id }) => id)).toEqual([
      documentSummaryFixtures[0]!.id,
      documentSummaryFixtures.at(-1)!.id,
      documentSummaryFixtures[1]!.id,
    ])
    expect(firstPage.activeCursor).toBe('active-next')
    expect(documents.activeCursor).toBeUndefined()
    expect(
      requests.some((request) =>
        new URL(request.url).searchParams.has('cursor'),
      ),
    ).toBe(true)
    expect(
      requests.some(
        (request) =>
          new URL(request.url).searchParams.get('archived') === 'true',
      ),
    ).toBe(true)
  })

  test('loads version history one opaque-cursor page at a time', async () => {
    const requests: Request[] = []
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request = createRequest(input, init)
      requests.push(request)
      return new URL(request.url).searchParams.get('cursor') === 'older'
        ? Response.json({ versions: [documentVersionFixtures[1]] })
        : Response.json({
            nextCursor: 'older',
            versions: [documentVersionFixtures[0]],
          })
    }) as typeof fetch

    const firstPage = await getDocumentVersions(
      'access-token',
      documentRecordFixture.id,
    )
    const secondPage = await getDocumentVersions(
      'access-token',
      documentRecordFixture.id,
      firstPage.nextCursor,
    )

    expect(firstPage).toEqual({
      nextCursor: 'older',
      versions: [documentVersionFixtures[0]],
    })
    expect(secondPage).toEqual({
      versions: [documentVersionFixtures[1]],
    })
    expect(requests).toHaveLength(2)
  })

  test('loads multiple backlink targets through one bounded batch request', async () => {
    let capturedRequest: Request | undefined
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedRequest = createRequest(input, init)
      return Response.json({
        backlinks: [],
        pending: [{
          targetType: 'goal',
          targetId: 'goal-1',
          cursor: 'next-goal-page',
        }],
      })
    }) as typeof fetch

    const response = await getDocumentBacklinksBatch(
      'access-token',
      [
        {
          targetType: 'goal',
          targetId: 'goal-1',
        },
        {
          targetType: 'project',
          targetId: 'project-1',
        },
      ],
    )

    expect(capturedRequest?.method).toBe('POST')
    expect(
      new URL(capturedRequest!.url).pathname,
    ).toEndWith('/document-backlinks/batch')
    expect(await capturedRequest?.json()).toEqual({
      targets: [
        {
          targetType: 'goal',
          targetId: 'goal-1',
        },
        {
          targetType: 'project',
          targetId: 'project-1',
        },
      ],
    })
    expect(response.pending).toEqual([{
      targetType: 'goal',
      targetId: 'goal-1',
      cursor: 'next-goal-page',
    }])
  })

  test('sends baseRevision, clientId, idempotent operations then reloads detail', async () => {
    const requests: Request[] = []
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request = createRequest(input, init)
      requests.push(request)
      return request.method === 'POST'
        ? Response.json({
            appliedOperationIds: ['operation-1'],
            documentId: documentRecordFixture.id,
            revision: 8,
            updatedAt: '2026-07-18T10:00:00.000Z',
          })
        : Response.json({ document: documentRecordFixture })
    }) as typeof fetch

    const saved = await applyDocumentOperations(
      'access-token',
      documentRecordFixture.id,
      {
        baseRevision: 7,
        clientId: 'editor-client',
        operations: [{
          block: {
            id: 'paragraph-context',
            text: 'Updated',
            type: 'paragraph',
          },
          blockId: 'paragraph-context',
          operationId: 'operation-1',
          type: 'update-block',
        }],
      },
      {
        idempotencyKey: 'batch-idempotency-key',
        requestId: 'request-id',
      },
    )

    expect(requests).toHaveLength(2)
    expect(await requests[0]?.json()).toMatchObject({
      baseRevision: 7,
      clientId: 'editor-client',
    })
    expect(requests[0]?.headers.get('Idempotency-Key')).toBe(
      'batch-idempotency-key',
    )
    expect(saved.committedRevision).toBe(8)
    expect(saved.document).toEqual(documentRecordFixture)
  })

  test('refetches conflict context without silently overwriting a collaborator', async () => {
    const attemptedRevisions: number[] = []
    globalThis.fetch = (async () =>
      Response.json({
        document: { ...documentRecordFixture, revision: 11 },
      })) as typeof fetch

    let conflict: unknown
    try {
      await applyDocumentOperationsWithConflictAwareness(
        'access-token',
        documentRecordFixture.id,
        {
          baseRevision: 7,
          clientId: 'editor-client',
          operations: [],
        },
        async (input) => {
          attemptedRevisions.push(input.baseRevision)
          throw new DocumentsApiError(
            409,
            'Concurrent update',
            'DocumentRevisionConflict',
          )
        },
      )
    } catch (error) {
      conflict = error
    }

    expect(attemptedRevisions).toEqual([7])
    expect(conflict).toBeInstanceOf(DocumentRevisionConflictError)
    expect(
      (conflict as DocumentRevisionConflictError).latestDocument.revision,
    ).toBe(11)
  })

  test('revokes shares with the canonical DELETE body', async () => {
    let capturedRequest: Request | undefined
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedRequest = createRequest(input, init)
      return Response.json({
        documentId: documentRecordFixture.id,
        revokedAt: '2026-07-18T10:00:00.000Z',
      })
    }) as typeof fetch

    await deleteDocumentShare(
      'access-token',
      documentRecordFixture.id,
      { publicShareId: 'public-share', type: 'public' },
      {
        idempotencyKey: 'revoke-share',
        requestId: 'request-id',
      },
    )

    expect(capturedRequest?.method).toBe('DELETE')
    expect(await capturedRequest?.json()).toEqual({
      publicShareId: 'public-share',
      type: 'public',
    })
  })

  test('loads a public document without an Authorization header', async () => {
    let capturedRequest: Request | undefined
    let capturedInit: RequestInit | undefined
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedInit = init
      capturedRequest = createRequest(input, init)
      return Response.json({
        allowExport: false,
        document: publicDocumentFixture,
      })
    }) as typeof fetch

    const response = await getPublicDocument('public-token')

    expect(response.document.title).toBe(publicDocumentFixture.title)
    expect(response.allowExport).toBe(false)
    expect(capturedRequest?.headers.get('Authorization')).toBeNull()
    expect(capturedInit?.referrerPolicy).toBe('no-referrer')
  })

  test('resolves public paths against the app origin and hides inactive shares', async () => {
    expect(
      resolvePublicDocumentUrl(
        '/share/documents/public-token',
        'https://app.example.test',
      ),
    ).toBe('https://app.example.test/share/documents/public-token')
    expect(
      resolvePublicDocumentUrl(
        'javascript:alert(1)',
        'https://app.example.test',
      ),
    ).toBeUndefined()
    expect(
      resolvePublicDocumentUrl(
        'https://attacker.example/share/token',
        'https://app.example.test',
      ),
    ).toBeUndefined()

    globalThis.fetch = (async () =>
      Response.json({
        memberShares: [],
        publicShares: [
          {
            allowExport: false,
            createdAt: '2026-07-18T00:00:00.000Z',
            createdByUserId: 'demo',
            documentId: documentRecordFixture.id,
            expiresAt: '2999-07-20T00:00:00.000Z',
            id: 'active-share',
            role: 'viewer',
            type: 'public',
          },
          {
            allowExport: false,
            createdAt: '2026-07-18T00:00:00.000Z',
            createdByUserId: 'demo',
            documentId: documentRecordFixture.id,
            expiresAt: '2999-07-20T00:00:00.000Z',
            id: 'revoked-share',
            revokedAt: '2026-07-19T00:00:00.000Z',
            role: 'viewer',
            type: 'public',
          },
          {
            allowExport: false,
            createdAt: '2026-07-01T00:00:00.000Z',
            createdByUserId: 'demo',
            documentId: documentRecordFixture.id,
            expiresAt: '2026-07-02T00:00:00.000Z',
            id: 'expired-share',
            role: 'viewer',
            type: 'public',
          },
        ],
      })) as typeof fetch

    const shares = await getDocumentShares(
      'access-token',
      documentRecordFixture.id,
    )

    expect(
      shares.map((share) =>
        share.type === 'public' ? share.id : share.grant.memberKey,
      ),
    ).toEqual(['active-share'])
  })
})

function createRequest(
  input: string | URL | Request,
  init?: RequestInit,
) {
  const resolvedInput =
    typeof input === 'string' && input.startsWith('/')
      ? new URL(input, 'https://example.test')
      : input
  return new Request(resolvedInput, init)
}
