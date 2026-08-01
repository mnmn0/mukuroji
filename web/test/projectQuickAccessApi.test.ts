import { afterEach, describe, expect, test } from 'bun:test'
import {
  getProjectQuickAccess,
  ProjectDirectoryApiError,
  replaceProjectQuickAccess,
} from '../src/projects/api'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'quick-access-correlation',
  idempotencyKey: 'quick-access-idempotency',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Project quick-access API', () => {
  test('loads an ordered canonical preference with bearer authentication', async () => {
    const requests = installFetchResponse({
      items: [
        { projectId: 'refero', teamId: 'core-team' },
        { projectId: 'launch', teamId: 'design-team' },
      ],
      revision: 4,
    })

    await expect(getProjectQuickAccess('access-token')).resolves.toEqual({
      items: [
        { projectId: 'refero', teamId: 'core-team' },
        { projectId: 'launch', teamId: 'design-team' },
      ],
      revision: 4,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/api/projects/quick-access')
    expect(new Headers(requests[0]?.init.headers).get('Authorization')).toBe(
      'Bearer access-token',
    )
  })

  test('rejects duplicate Project identities and noncanonical identifiers', async () => {
    installFetchResponse({
      items: [
        { projectId: 'shared-project', teamId: 'core-team' },
        { projectId: 'shared-project', teamId: 'design-team' },
      ],
      revision: 1,
    })
    const duplicateError = await getProjectQuickAccess('access-token')
      .catch((reason: unknown) => reason)

    expect(duplicateError).toBeInstanceOf(ProjectDirectoryApiError)

    installFetchResponse({
      items: [{ projectId: ' project ', teamId: 'core/team' }],
      revision: 1,
    })
    const identifierError = await getProjectQuickAccess('access-token')
      .catch((reason: unknown) => reason)

    expect(identifierError).toBeInstanceOf(ProjectDirectoryApiError)

    installFetchResponse({ items: [], revision: Number.MAX_SAFE_INTEGER })
    const terminalRevisionError = await getProjectQuickAccess('access-token')
      .catch((reason: unknown) => reason)

    expect(terminalRevisionError).toBeInstanceOf(ProjectDirectoryApiError)
  })

  test('replaces the complete order with stable mutation headers', async () => {
    const requests = installFetchResponse({
      items: [{ projectId: 'refero', teamId: 'core-team' }],
      revision: 8,
    })

    await expect(replaceProjectQuickAccess('access-token', {
      items: [{ projectId: 'refero', teamId: 'core-team' }],
      revision: 7,
    }, mutationContext)).resolves.toMatchObject({ revision: 8 })

    const request = requests[0]
    expect(request?.url).toBe('/api/projects/quick-access')
    expect(request?.init.method).toBe('PUT')
    expect(JSON.parse(String(request?.init.body))).toEqual({
      items: [{ projectId: 'refero', teamId: 'core-team' }],
      revision: 7,
    })
    const headers = new Headers(request?.init.headers)
    expect(headers.get('Authorization')).toBe('Bearer access-token')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Idempotency-Key')).toBe(mutationContext.idempotencyKey)
    expect(headers.get('X-Correlation-Id')).toBe(mutationContext.correlationId)
  })

  test('preserves a structured compare-and-swap conflict', async () => {
    installFetchResponse({
      code: 'ProjectQuickAccessConflict',
      message: 'Project quick access changed before this update was saved.',
    }, 409)

    const error = await replaceProjectQuickAccess('access-token', {
      items: [],
      revision: 3,
    }, mutationContext).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ProjectDirectoryApiError)
    expect(error).toMatchObject({
      code: 'ProjectQuickAccessConflict',
      status: 409,
    })
  })
})

/**
 * Installs a deterministic fetch response and records its request metadata.
 *
 * @param body - JSON value returned by the fetch double.
 * @param status - HTTP status returned by the fetch double.
 * @returns Mutable request records populated by subsequent API calls.
 */
function installFetchResponse(body: unknown, status = 200) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetchResponse: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    requests.push({ init, url })
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
      status,
    })
  }
  globalThis.fetch = fetchResponse
  return requests
}
