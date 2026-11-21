import { afterEach, describe, expect, test } from 'bun:test'
import { AiAssistanceApiError } from '../src/features/ai-assistance/api/errors'
import {
  deleteAiAssistanceProviderCredential,
  getAiAssistanceProviderCredentials,
  putAiAssistanceProviderCredential,
} from '../src/features/ai-assistance/api/settings'

const originalFetch = globalThis.fetch
const mutationContext = { correlationId: 'correlation-1', idempotencyKey: 'idempotency-1' }
const statusResponse = {
  schemaVersion: 1,
  providers: [
    {
      provider: 'anthropic',
      deploymentEnabled: true,
      configured: true,
      keyHint: 'abcd',
      revision: 2,
      updatedAt: '2026-11-21T08:00:00.000Z',
    },
    { provider: 'openai', deploymentEnabled: false, configured: false, revision: 0 },
  ],
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** One request captured by the fake fetch. */
type RecordedRequest = {
  /** Request URL. */
  url: string
  /** Request options. */
  init: RequestInit
}

/**
 * Replaces fetch with a fake that answers every request with one response.
 *
 * @param body - JSON response body.
 * @param status - HTTP status.
 * @returns Requests the fake received.
 */
function installFetch(body: unknown, status = 200): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  const fakeFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} })
    return Response.json(body, { status })
  }
  globalThis.fetch = fakeFetch
  return requests
}

describe('AI provider credential API', () => {
  test('reads key-free provider status', async () => {
    installFetch(statusResponse)
    expect(await getAiAssistanceProviderCredentials('token')).toEqual({
      schemaVersion: 1,
      providers: [
        {
          provider: 'anthropic',
          deploymentEnabled: true,
          configured: true,
          keyHint: 'abcd',
          revision: 2,
          updatedAt: '2026-11-21T08:00:00.000Z',
        },
        { provider: 'openai', deploymentEnabled: false, configured: false, revision: 0 },
      ],
    })
  })

  test('rejects unknown providers and malformed key hints', async () => {
    installFetch({ ...statusResponse, providers: [{ ...statusResponse.providers[0], provider: 'gemini' }] })
    await expect(getAiAssistanceProviderCredentials('token')).rejects.toBeInstanceOf(AiAssistanceApiError)
    installFetch({ ...statusResponse, providers: [{ ...statusResponse.providers[0], keyHint: 'sk-ant-full-key' }] })
    await expect(getAiAssistanceProviderCredentials('token')).rejects.toBeInstanceOf(AiAssistanceApiError)
  })

  test('sends the key only in the PUT body and revisions with mutation headers', async () => {
    const requests = installFetch(statusResponse)
    await putAiAssistanceProviderCredential('token', 'anthropic', 'sk-ant-example-key-value', 2, mutationContext)
    await deleteAiAssistanceProviderCredential('token', 'anthropic', 3, mutationContext)
    expect(requests).toHaveLength(2)
    const [put, remove] = requests
    expect(put?.url).toEndWith('/provider-credentials/anthropic')
    expect(put?.url).not.toContain('sk-ant-')
    expect(put?.init.method).toBe('PUT')
    expect(JSON.parse(String(put?.init.body))).toEqual({
      apiKey: 'sk-ant-example-key-value',
      expectedRevision: 2,
    })
    expect(remove?.url).toEndWith('/provider-credentials/anthropic?expectedRevision=3')
    expect(remove?.init.method).toBe('DELETE')
    expect(remove?.init.body).toBeUndefined()
  })
})
