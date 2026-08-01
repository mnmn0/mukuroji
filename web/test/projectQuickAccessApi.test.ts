import { afterEach, describe, expect, test } from 'bun:test'
import { PROJECT_QUICK_ACCESS_IDENTIFIER_MAX_LENGTH } from '@mukuroji/contracts'
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

  test('accepts duplicate Project IDs owned by different Teams', async () => {
    installFetchResponse({
      items: [
        { projectId: 'shared-project', teamId: 'core-team' },
        { projectId: 'shared-project', teamId: 'design-team' },
      ],
      revision: 1,
    })
    await expect(getProjectQuickAccess('access-token')).resolves.toMatchObject({ revision: 1 })
  })

  test('rejects duplicate Team and Project identities', async () => {
    installFetchResponse({
      items: [
        { projectId: 'shared-project', teamId: 'core-team' },
        { projectId: 'shared-project', teamId: 'core-team' },
      ],
      revision: 1,
    })
    const duplicateError = await getProjectQuickAccess('access-token')
      .catch((reason: unknown) => reason)

    expect(duplicateError).toBeInstanceOf(ProjectDirectoryApiError)
    expect(duplicateError).toMatchObject({
      message: 'projects.quickAccess.error.loading',
    })
  })

  test('rejects noncanonical Team and Project identifiers', async () => {
    installFetchResponse({
      items: [{ projectId: ' project ', teamId: 'core/team' }],
      revision: 1,
    })
    const identifierError = await getProjectQuickAccess('access-token')
      .catch((reason: unknown) => reason)

    expect(identifierError).toBeInstanceOf(ProjectDirectoryApiError)
    expect(identifierError).toMatchObject({
      message: 'projects.quickAccess.error.loading',
    })
  })

  test('rejects identifiers beyond the shared maximum length', async () => {
    installFetchResponse({
      items: [{
        projectId: 'p'.repeat(PROJECT_QUICK_ACCESS_IDENTIFIER_MAX_LENGTH + 1),
        teamId: 'core-team',
      }],
      revision: 1,
    })
    const identifierError = await getProjectQuickAccess('access-token')
      .catch((reason: unknown) => reason)

    expect(identifierError).toBeInstanceOf(ProjectDirectoryApiError)
    expect(identifierError).toMatchObject({
      message: 'projects.quickAccess.error.loading',
    })
  })

  test('rejects the terminal preference revision', async () => {
    installFetchResponse({ items: [], revision: Number.MAX_SAFE_INTEGER })
    const terminalRevisionError = await getProjectQuickAccess('access-token')
      .catch((reason: unknown) => reason)

    expect(terminalRevisionError).toBeInstanceOf(ProjectDirectoryApiError)
    expect(terminalRevisionError).toMatchObject({
      message: 'projects.quickAccess.error.loading',
    })
  })

  test('uses operation-specific fallback keys for unstructured API failures', async () => {
    installFetchResponse({}, 500)
    const loadingError = await getProjectQuickAccess('access-token')
      .catch((reason: unknown) => reason)

    expect(loadingError).toMatchObject({
      message: 'projects.quickAccess.error.loading',
      status: 500,
    })

    installFetchResponse({}, 500)
    const savingError = await replaceProjectQuickAccess('access-token', {
      items: [],
      revision: 0,
    }, mutationContext).catch((reason: unknown) => reason)

    expect(savingError).toMatchObject({
      message: 'projects.quickAccess.error.saving',
      status: 500,
    })
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
