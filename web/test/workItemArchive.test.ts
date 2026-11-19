import { afterEach, describe, expect, test } from 'bun:test'
import { applyWorkItemArchive } from '../src/bulk-operations/mutations/workItemArchive'
import { selectArchivedWorkItems } from '../src/issues/model/archivedWorkItems'
import { createMutationRequestRunner } from '../src/shared/api/mutationHeaders'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with a recorder that answers each request with the next queued body.
 *
 * @param responses - Response bodies in request order.
 * @returns The recorded request URLs and JSON bodies.
 */
function installFetchSequence(responses: unknown[]) {
  const requests: { url: string; body: unknown }[] = []
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? 'null')) })
      return new Response(JSON.stringify(responses.shift() ?? {}), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    },
    { preconnect: originalFetch.preconnect },
  )
  return requests
}

const target = { id: 'item-1', revision: 4, teamId: 'core-team' }

/**
 * Runs one archive change against the recorded fetch.
 *
 * @param archived - True to archive, false to restore.
 * @returns The mutation promise.
 */
function runArchive(archived: boolean) {
  return applyWorkItemArchive({
    accessToken: 'token',
    archived,
    fallbackErrorMessage: 'fallback',
    runner: createMutationRequestRunner(),
    target,
    workspaceId: 'workspace-1',
  })
}

describe('single Work Item archive', () => {
  test('previews and applies a one-item archive operation', async () => {
    const requests = installFetchSequence([
      { action: { type: 'archive', archived: false }, canApply: true, items: [], operationToken: 'preview-token' },
      { items: [{ status: 'succeeded' }] },
    ])

    await runArchive(false)

    const expectedRequest = {
      workspaceId: 'workspace-1',
      items: [{ teamId: 'core-team', workItemId: 'item-1', expectedRevision: 4 }],
      action: { type: 'archive', archived: false },
    }
    expect(requests.map((request) => request.url)).toEqual([
      '/api/bulk-operations/preview',
      '/api/bulk-operations',
    ])
    expect(requests[0]?.body).toEqual(expectedRequest)
    expect(requests[1]?.body).toEqual({ ...expectedRequest, operationToken: 'preview-token' })
  })

  test('stops at a rejected preview and reports the server message', async () => {
    const requests = installFetchSequence([
      {
        canApply: false,
        items: [{ status: 'failed', errorMessage: 'Work Item changed after it was selected.' }],
        operationToken: 'preview-token',
      },
    ])

    await expect(runArchive(true)).rejects.toThrow('Work Item changed after it was selected.')
    expect(requests).toHaveLength(1)
  })

  test('reports a failed apply with the fallback message when the server gives none', async () => {
    installFetchSequence([
      { canApply: true, items: [], operationToken: 'preview-token' },
      { items: [{ status: 'failed' }] },
    ])

    await expect(runArchive(true)).rejects.toThrow('fallback')
  })

  test('retries a retryable failed item through the retry endpoint', async () => {
    const requests = installFetchSequence([
      { canApply: true, items: [], operationToken: 'preview-token' },
      { id: 'bulk_1', items: [{ status: 'failed', retryable: true, errorMessage: 'Temporary failure.' }] },
      { id: 'bulk_1', items: [{ status: 'succeeded', retryable: false }] },
    ])

    await runArchive(true)

    expect(requests.map((request) => request.url)).toEqual([
      '/api/bulk-operations/preview',
      '/api/bulk-operations',
      '/api/bulk-operations/bulk_1/retry',
    ])
  })
})

describe('archived Work Item list', () => {
  test('keeps archived Work Items, newest archive first', () => {
    expect(selectArchivedWorkItems([
      { id: 'active' },
      { id: 'older', archivedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'newer', archivedAt: '2026-11-10T00:00:00.000Z' },
    ]).map((item) => item.id)).toEqual(['newer', 'older'])
  })
})
