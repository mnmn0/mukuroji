import { describe, expect, test } from 'bun:test'
import {
  AI_ASSISTANCE_SCHEMA_VERSION,
  type AiAssistanceProviderCredentials,
} from '@mukuroji/contracts'
import type { AiAssistanceService } from '../../application/ports/ai-assistance-ports'
import type { AiProviderCredentialService } from '../../application/ports/ai-provider-credential-ports'
import { createAiAssistanceRouter } from './ai-assistance-router'

const emptyCredentials: AiAssistanceProviderCredentials = {
  schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
  providers: [],
}

/** Creates a router whose provider key service records the calls it receives. */
function createRouter(canManagePolicy = true) {
  const calls: string[] = []
  const providerCredentials: AiProviderCredentialService = {
    async list() {
      calls.push('list')
      return emptyCredentials
    },
    async put(_actor, provider, request, authorization) {
      calls.push(`put:${provider}:${request.expectedRevision}:${await authorization.isCurrent()}`)
      return emptyCredentials
    },
    async delete(_actor, provider, request) {
      calls.push(`delete:${provider}:${request.expectedRevision}`)
      return emptyCredentials
    },
    async isConfigured() { return false },
    async resolveApiKey() { return undefined },
  }
  const service: AiAssistanceService = {
    async getPolicy() {
      return {
        schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
        enabled: true,
        allowedModelIds: ['claude-sonnet-5-5'],
        defaultModelId: 'claude-sonnet-5-5',
        enabledTasks: ['search'],
        retentionDays: 30,
        revision: 0,
        updatedAt: '1970-01-01T00:00:00.000Z',
      }
    },
    updatePolicy: async () => { throw new Error('unused') },
    getPreference: async () => { throw new Error('unused') },
    updatePreference: async () => { throw new Error('unused') },
    generate: async () => { throw new Error('unused') },
    generateWithMetadata: async () => { throw new Error('unused') },
    getGeneration: async () => { throw new Error('unused') },
    decideGeneration: async () => { throw new Error('unused') },
    createFeedback: async () => { throw new Error('unused') },
  }
  const router = createAiAssistanceRouter({
    service,
    providerCredentials,
    getAvailableModels: () => [{ modelId: 'claude-sonnet-5-5', provider: 'anthropic' }],
    readBearerAccessToken: (context) =>
      context.req.header('Authorization')?.replace(/^Bearer /u, ''),
    authenticate: async () => ({ workspaceId: 'workspace-1', memberId: 'member-1' }),
    toActor: (principal) => ({
      workspaceId: principal.workspaceId,
      memberId: principal.memberId,
      actorId: principal.memberId,
      auditActorKind: 'user',
      traceId: 'trace-1',
      canManagePolicy,
    }),
    resolveContext: async () => { throw new Error('unused') },
    isAuthorizationCurrent: async () => ({ current: true }),
    readJson: (request) => request.json(),
    mapError: (context) => context.json({ code: 'UnexpectedError', message: 'x' }, 500),
  })
  return { router, calls }
}

const headers = { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' }

describe('AI provider key routes', () => {
  test('lists, registers, and removes keys with fresh authorization and no caching', async () => {
    const { router, calls } = createRouter()

    const listed = await router.request('/api/ai-assistance/provider-credentials', { headers })
    const put = await router.request('/api/ai-assistance/provider-credentials/anthropic', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ apiKey: 'sk-ant-api03-route-test-0000', expectedRevision: 0 }),
    })
    const removed = await router.request(
      '/api/ai-assistance/provider-credentials/anthropic?expectedRevision=1',
      { method: 'DELETE', headers },
    )

    expect([listed.status, put.status, removed.status]).toEqual([200, 200, 200])
    expect(put.headers.get('Cache-Control')).toBe('private, no-store')
    expect(calls).toEqual(['list', 'put:anthropic:0:true', 'delete:anthropic:1'])
  })

  test('rejects an unknown provider and a key for the wrong provider before the service', async () => {
    const { router, calls } = createRouter()

    const unknown = await router.request('/api/ai-assistance/provider-credentials/gemini', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ apiKey: 'sk-ant-api03-route-test-0000', expectedRevision: 0 }),
    })
    const mismatched = await router.request('/api/ai-assistance/provider-credentials/anthropic', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ apiKey: 'sk-proj-openai-route-0000', expectedRevision: 0 }),
    })

    expect(unknown.status).toBe(404)
    expect(mismatched.status).toBe(400)
    expect(JSON.stringify(await mismatched.json())).not.toContain('sk-proj')
    expect(calls).toEqual([])
  })

  test('adds the deployment model list to the policy response', async () => {
    const { router } = createRouter()

    const response = await router.request('/api/ai-assistance/policy', { headers })

    expect((await response.json()).availableModels).toEqual([
      { modelId: 'claude-sonnet-5-5', provider: 'anthropic' },
    ])
  })
})
