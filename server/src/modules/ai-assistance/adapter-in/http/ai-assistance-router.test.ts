import { describe, expect, test } from 'bun:test'
import {
  AI_ASSISTANCE_SCHEMA_VERSION,
  type AiAssistanceGeneration,
} from '@mukuroji/contracts'
import type { AiAssistanceService } from '../../application/ports/ai-assistance-ports'
import { AiAssistanceError } from '../../errors'
import { createAiAssistanceRouter } from './ai-assistance-router'

const GENERATION_REQUEST = {
  task: 'search',
  locale: 'ja',
  query: '未完了の項目',
} as const

/** Creates one valid generation response for HTTP adapter tests. */
function createGeneration(): AiAssistanceGeneration {
  return {
    schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
    id: 'generation-1',
    task: 'search',
    revision: 1,
    content: {
      availability: 'available',
      draft: {
        kind: 'search',
        interpretation: '未完了の項目',
        filters: { statuses: ['todo'] },
        caveats: [],
      },
      citations: [],
      uncertainty: { level: 'low', reason: '明確です。' },
    },
    details: {
      provider: 'bedrock',
      modelId: 'model-1',
      promptVersion: 'ai-assistance-v1',
      traceId: 'trace-1',
      usage: { latencyMs: 1, costUnavailableReason: 'pricing-not-configured' },
    },
    createdAt: '2026-08-25T00:00:00.000Z',
    expiresAt: '2026-09-24T00:00:00.000Z',
  }
}

/** Creates a complete service stub whose generation method exercises both callbacks. */
function createService(): AiAssistanceService {
  return {
    async getPolicy() {
      return {
        schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
        enabled: true,
        allowedModelIds: ['model-1'],
        defaultModelId: 'model-1',
        enabledTasks: ['search'],
        retentionDays: 30,
        revision: 0,
        updatedAt: '1970-01-01T00:00:00.000Z',
      }
    },
    async updatePolicy(_actor, request) {
      return {
        schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
        enabled: request.enabled,
        allowedModelIds: request.allowedModelIds,
        defaultModelId: request.defaultModelId,
        enabledTasks: request.enabledTasks,
        retentionDays: request.retentionDays,
        revision: request.expectedRevision + 1,
        updatedAt: '2026-08-25T00:00:00.000Z',
      }
    },
    async getPreference() {
      return {
        schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
        enabled: true,
        revision: 0,
        updatedAt: '1970-01-01T00:00:00.000Z',
      }
    },
    async updatePreference(_actor, request) {
      return {
        schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
        enabled: request.enabled,
        revision: request.expectedRevision + 1,
        updatedAt: '2026-08-25T00:00:00.000Z',
      }
    },
    async generate(actor, request, authorization) {
      const context = await authorization.resolveContext({ actor, request })
      const state = await authorization.isAuthorizationCurrent({
        actor,
        request,
        authorizationToken: context.authorizationToken,
      })
      if (!state.current) {
        throw new AiAssistanceError(
          'conflict',
          'AiAssistanceAuthorizationChanged',
          'Authorization changed.',
        )
      }
      return createGeneration()
    },
    async getGeneration() {
      return createGeneration()
    },
    async decideGeneration() {
      return createGeneration()
    },
    async createFeedback() {},
  }
}

/** Creates router dependencies while exposing authentication and current-check counts. */
function createHarness(
  changeActorOnReauthentication = false,
  service: AiAssistanceService = createService(),
) {
  let authenticateCount = 0
  let currentCheckCount = 0
  const router = createAiAssistanceRouter({
    service,
    readBearerAccessToken(context) {
      const value = context.req.header('Authorization')
      return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined
    },
    async authenticate() {
      authenticateCount += 1
      return {
        workspaceId: 'workspace-1',
        memberId: changeActorOnReauthentication && authenticateCount > 1
          ? 'member-2'
          : 'member-1',
      }
    },
    toActor(principal) {
      return {
        workspaceId: principal.workspaceId,
        memberId: principal.memberId,
        traceId: 'trace-1',
        canManagePolicy: false,
      }
    },
    async resolveContext() {
      return {
        promptContext: 'Visible search catalog.',
        citations: [],
        authorizationToken: 'snapshot-1',
        privateMemberIdentifiers: [],
        allowedValues: {
          assigneeUserIds: [],
          creatorUserIds: [],
          teamIds: [],
          projectIds: [],
          customFieldIds: [],
          relationIds: [],
          statuses: ['todo'],
          workItemEndpoints: [],
        },
      }
    },
    async isAuthorizationCurrent() {
      currentCheckCount += 1
      return { current: true }
    },
    readJson(request) {
      return request.json()
    },
    mapError(context) {
      return context.json({ code: 'UnexpectedError', message: 'Unexpected error.' }, 500)
    },
  })
  return {
    router,
    authenticateCount: () => authenticateCount,
    currentCheckCount: () => currentCheckCount,
  }
}

describe('createAiAssistanceRouter', () => {
  test('passes a fresh management authorization callback to policy writes', async () => {
    let currentAuthorization: boolean | undefined
    const harness = createHarness(false, {
      ...createService(),
      async updatePolicy(_actor, request, authorization) {
        currentAuthorization = await authorization.isCurrent()
        return {
          schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
          enabled: request.enabled,
          allowedModelIds: request.allowedModelIds,
          defaultModelId: request.defaultModelId,
          enabledTasks: request.enabledTasks,
          retentionDays: request.retentionDays,
          revision: request.expectedRevision + 1,
          updatedAt: '2026-08-25T00:00:00.000Z',
        }
      },
    })
    const response = await harness.router.request('/api/ai-assistance/policy', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer token-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        enabled: true,
        allowedModelIds: ['model-1'],
        defaultModelId: 'model-1',
        enabledTasks: ['search'],
        retentionDays: 30,
        expectedRevision: 0,
      }),
    })

    expect(response.status).toBe(200)
    expect(currentAuthorization).toBeFalse()
    expect(harness.authenticateCount()).toBe(2)
  })

  test('reauthenticates before exposing a generated response', async () => {
    const harness = createHarness()
    const response = await harness.router.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-1',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'generation-request-1',
      },
      body: JSON.stringify(GENERATION_REQUEST),
    })

    expect(response.status).toBe(201)
    expect(harness.authenticateCount()).toBe(2)
    expect(harness.currentCheckCount()).toBe(1)
  })

  test('rejects a generation when the reauthenticated actor changed', async () => {
    const harness = createHarness(true)
    const response = await harness.router.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-1',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'generation-request-1',
      },
      body: JSON.stringify(GENERATION_REQUEST),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      code: 'AiAssistanceAuthorizationChanged',
      message: 'Authorization changed.',
    })
    expect(harness.authenticateCount()).toBe(2)
    expect(harness.currentCheckCount()).toBe(0)
  })

  test('returns a stable 401 when bearer authentication is missing', async () => {
    const harness = createHarness()
    const response = await harness.router.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(GENERATION_REQUEST),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      code: 'AiAssistanceAuthenticationRequired',
      message: 'Bearer authentication is required.',
    })
    expect(harness.authenticateCount()).toBe(0)
  })

  test('rejects unknown request fields before invoking the service', async () => {
    const harness = createHarness()
    const response = await harness.router.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-1',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'generation-request-1',
      },
      body: JSON.stringify({ ...GENERATION_REQUEST, workspaceId: 'attacker-workspace' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'InvalidAiAssistanceRequest' })
    expect(harness.authenticateCount()).toBe(1)
  })

  test('requires an idempotency key for generation mutations', async () => {
    const harness = createHarness()
    const response = await harness.router.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(GENERATION_REQUEST),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      code: 'AiAssistanceIdempotencyKeyRequired',
      message: 'A valid Idempotency-Key header is required.',
    })
  })

  test('requires an idempotency key for feedback mutations', async () => {
    const harness = createHarness()
    const response = await harness.router.request(
      '/api/ai-assistance/generations/generation-1/feedback',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rating: 'helpful' }),
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'AiAssistanceIdempotencyKeyRequired',
    })
  })

  test('maps an exhausted generation budget to a stable 429 response', async () => {
    const service: AiAssistanceService = {
      ...createService(),
      async generate() {
        throw new AiAssistanceError(
          'rate-limit',
          'AiAssistanceRateLimitExceeded',
          'AI assistance generation capacity is exhausted for this one-minute window.',
        )
      },
    }
    const harness = createHarness(false, service)
    const response = await harness.router.request('/api/ai-assistance/generations', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-1',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'generation-request-1',
      },
      body: JSON.stringify(GENERATION_REQUEST),
    })

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      code: 'AiAssistanceRateLimitExceeded',
      message: 'AI assistance generation capacity is exhausted for this one-minute window.',
    })
  })
})
