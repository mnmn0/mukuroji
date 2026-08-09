import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyTriageEntryAction,
  getTriageEntries,
  getTriageSettings,
  TriageApiError,
} from '../src/triage/api'
import {
  triageConfigurationFixture,
  triageEntryFixtures,
} from '../src/triage/fixtures'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'triage-correlation-1',
  idempotencyKey: 'triage-idempotency-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Team triage API boundary', () => {
  test('encodes Team scope and queue filters', async () => {
    const requests = installFetchRecorder([{
      allowedBulkActions: ['assign', 'decline', 'snooze'],
      entries: triageEntryFixtures,
    }])

    const page = await getTriageEntries('core/team', 'access-token', {
      cursor: 'opaque/cursor',
      limit: 25,
      ownerUserId: 'unowned',
      sourceKind: 'chat',
      state: 'pending',
    })

    expect(page.entries).toHaveLength(4)
    expect(page.allowedBulkActions).toEqual(['assign', 'decline', 'snooze'])
    expect(requests[0]?.url).toBe(
      '/api/teams/core%2Fteam/triage-entries?cursor=opaque%2Fcursor&limit=25&state=pending&sourceKind=chat&owner=unowned',
    )
    expect(new Headers(requests[0]?.init.headers).get('Authorization')).toBe(
      'Bearer access-token',
    )
  })

  test('validates mutation receipts and sends stable replay headers', async () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    const requests = installFetchRecorder([{ entry, replayed: false }])

    const receipt = await applyTriageEntryAction(
      'core-team',
      'entry/1',
      { action: 'decline', expectedRevision: 3, reason: 'Outside scope' },
      'access-token',
      mutationContext,
    )

    expect(receipt.entry.id).toBe(entry.id)
    expect(requests[0]?.url).toBe('/api/teams/core-team/triage-entries/entry%2F1/actions')
    expect(new Headers(requests[0]?.init.headers).get('Idempotency-Key')).toBe(
      'triage-idempotency-1',
    )
    expect(new Headers(requests[0]?.init.headers).get('X-Correlation-Id')).toBe(
      'triage-correlation-1',
    )
  })

  test('validates the configured bulk action allowlist including an empty list', async () => {
    const requests = installFetchRecorder([{
      ...triageConfigurationFixture,
      allowedBulkActions: [],
    }])

    const configuration = await getTriageSettings('core-team', 'access-token')

    expect(configuration.allowedBulkActions).toEqual([])
    expect(requests[0]?.url).toBe('/api/teams/core-team/triage-settings')
  })

  test('rejects unknown configured bulk actions at the Web trust boundary', async () => {
    installFetchRecorder([{
      ...triageConfigurationFixture,
      allowedBulkActions: ['assign', 'archive'],
    }])

    await expect(
      getTriageSettings('core-team', 'access-token'),
    ).rejects.toMatchObject({
      code: 'InvalidTriageContract',
      status: 502,
    })
  })

  test('rejects non-HTTPS source permalinks at the Web trust boundary', async () => {
    const entry = triageEntryFixtures[0]
    if (!entry) throw new Error('Expected a triage fixture.')
    installFetchRecorder([{
      allowedBulkActions: ['assign', 'decline', 'snooze'],
      entries: [{
        ...entry,
        sourcePreview: { ...entry.sourcePreview, permalink: 'javascript:alert(1)' },
      }],
    }])

    const request = getTriageEntries('core-team', 'access-token')
    await expect(request).rejects.toMatchObject({
      code: 'InvalidTriageContract',
      status: 502,
    })
    await expect(request).rejects.toBeInstanceOf(
      TriageApiError,
    )
  })
})

function installFetchRecorder(responseBodies: unknown[]) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const mockFetch: typeof fetch = async (input, init = {}) => {
    requests.push({
      url: typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
      init,
    })
    return new Response(JSON.stringify(responseBodies.shift() ?? {}), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }
  globalThis.fetch = mockFetch
  return requests
}
