import { afterEach, describe, expect, test } from 'bun:test'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationInboundWebhookEndpoint,
  type CreateAutomationRuleInput,
  type CreateAutomationTemplateInput,
  type CreateRecurringWorkInput,
} from '@mukuroji/contracts'
import {
  applyAutomationTemplate,
  createAutomationInboundWebhookEndpoint,
  createAutomationRule,
  createAutomationTemplate,
  createRecurringWork,
  duplicateAutomationTemplate,
  getAutomationExecutions,
  getAutomationInboundWebhookEndpoint,
  getAutomationInboundWebhookEndpoints,
  getAutomationRules,
  getAutomationTemplateApplication,
  getAutomationTemplates,
  getRecurringWork,
  pauseAutomationInboundWebhookEndpoint,
  resumeAutomationInboundWebhookEndpoint,
  resolveAutomationApiBaseUrl,
  revokeAutomationInboundWebhookEndpoint,
  retryAutomationExecution,
  rotateAutomationInboundWebhookEndpoint,
  updateAutomationRule,
  updateAutomationInboundWebhookEndpoint,
  updateAutomationTemplate,
} from '../src/automation/api'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-automation-1',
  idempotencyKey: 'idempotency-automation-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('automation API base URL', () => {
  test('uses the Workspace, Projects, Tasks, and shared API fallback chain', () => {
    expect(resolveAutomationApiBaseUrl({
      VITE_API_BASE_URL: 'https://shared.example.test/',
      VITE_PROJECTS_API_BASE_URL: 'https://projects.example.test/',
      VITE_TASKS_API_BASE_URL: 'https://tasks.example.test/',
      VITE_WORKSPACE_API_BASE_URL: 'https://workspace.example.test/',
    })).toBe('https://workspace.example.test')
    expect(resolveAutomationApiBaseUrl({
      VITE_API_BASE_URL: 'https://shared.example.test/',
      VITE_PROJECTS_API_BASE_URL: 'https://projects.example.test/',
      VITE_TASKS_API_BASE_URL: 'https://tasks.example.test/',
    })).toBe('https://projects.example.test')
    expect(resolveAutomationApiBaseUrl({
      VITE_API_BASE_URL: 'https://shared.example.test/',
      VITE_TASKS_API_BASE_URL: 'https://tasks.example.test/',
    })).toBe('https://tasks.example.test')
    expect(resolveAutomationApiBaseUrl({
      VITE_API_BASE_URL: 'https://shared.example.test/',
    })).toBe('https://shared.example.test')
    expect(resolveAutomationApiBaseUrl({})).toBe('/api')
  })
})

describe('automation API', () => {
  test('loads every automation collection from its stable path', async () => {
    const requests = installFetchRecorder({
      executions: [],
      recurringWorks: [],
      rules: [],
      templates: [],
    })

    await getAutomationRules('access-token')
    await getAutomationTemplates('access-token')
    await getRecurringWork('access-token')
    await getAutomationExecutions('access-token', {
      cursor: 'next/a+b',
      ruleId: 'rule/1',
      status: 'dead-letter',
    })

    expect(requests.map((request) => request.url)).toEqual([
      '/api/automation/rules',
      '/api/automation/templates',
      '/api/recurring-work',
      '/api/automation/executions?ruleId=rule%2F1&status=dead-letter&cursor=next%2Fa%2Bb',
    ])
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
    })
  })

  test('creates and pauses rules with mutation tracking headers', async () => {
    const requests = installFetchRecorder({})
    const input = createRuleInput()

    await createAutomationRule('access-token', input, mutationContext)
    await updateAutomationRule(
      'access-token',
      'rule/1',
      { enabled: false, expectedRevision: 4 },
      mutationContext,
    )

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', '/api/automation/rules'],
      ['PATCH', '/api/automation/rules/rule%2F1'],
    ])
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': mutationContext.idempotencyKey,
      'X-Correlation-Id': mutationContext.correlationId,
    })
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      enabled: false,
      expectedRevision: 4,
    })
  })

  test('uses tracked writes for template, recurring work, duplicate, and retry endpoints', async () => {
    const requests = installFetchRecorder({})
    const templateInput: CreateAutomationTemplateInput = {
      enabled: true,
      kind: 'work-item',
      name: 'Weekly review',
      payload: { title: 'Weekly review' },
    }
    const recurringInput: CreateRecurringWorkInput = {
      enabled: false,
      name: 'Weekly review',
      schedule: {
        catchUpPolicy: 'latest',
        daysOfWeek: [1],
        frequency: 'weekly',
        interval: 1,
        localTime: '09:00',
        startDate: '2026-07-20',
        timeZone: 'Asia/Tokyo',
      },
      teamId: 'core-team',
      templateId: 'template-1',
    } as CreateRecurringWorkInput

    await createAutomationTemplate('access-token', templateInput, mutationContext)
    await duplicateAutomationTemplate('access-token', 'template/1', mutationContext)
    await createRecurringWork('access-token', recurringInput, mutationContext)
    await retryAutomationExecution('access-token', 'execution/1', mutationContext)

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', '/api/automation/templates'],
      ['POST', '/api/automation/templates/template%2F1/duplicate'],
      ['POST', '/api/recurring-work'],
      ['POST', '/api/automation/executions/execution%2F1/retry'],
    ])
    for (const request of requests) {
      expect(request.init.headers).toMatchObject({
        'Idempotency-Key': mutationContext.idempotencyKey,
        'X-Correlation-Id': mutationContext.correlationId,
      })
    }
  })

  test('updates typed templates and applies an immutable version with idempotency headers', async () => {
    const requests = installFetchRecorder({})

    await updateAutomationTemplate(
      'access-token',
      'template/workflow',
      {
        expectedRevision: 7,
        name: 'Delivery workflow',
        payload: {
          id: 'delivery',
          initialStatusId: 'backlog',
          name: 'Delivery workflow',
          statuses: [
            { category: 'backlog', id: 'backlog', name: 'Backlog', sortOrder: 0 },
          ],
          transitions: [],
        },
      },
      mutationContext,
    )
    await applyAutomationTemplate(
      'access-token',
      'template/workflow',
      {
        target: {
          expectedRevision: 11,
          kind: 'workflow',
          scopeId: 'team/core',
          scopeType: 'team',
        },
      },
      mutationContext,
    )
    await getAutomationTemplateApplication('access-token', 'application/1')

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['PATCH', '/api/automation/templates/template%2Fworkflow'],
      ['POST', '/api/automation/templates/template%2Fworkflow/applications'],
      [undefined, '/api/automation/template-applications/application%2F1'],
    ])
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      target: {
        expectedRevision: 11,
        kind: 'workflow',
        scopeId: 'team/core',
        scopeType: 'team',
      },
    })
    expect(requests[1]?.init.headers).toMatchObject({
      'Idempotency-Key': mutationContext.idempotencyKey,
      'X-Correlation-Id': mutationContext.correlationId,
    })
    expect(requests[2]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
    })
  })

  test('manages inbound Webhook lifecycle while keeping secrets out of list results', async () => {
    const endpoint = createInboundWebhookEndpoint()
    const response = {
      endpoint,
      endpoints: [endpoint],
      signingSecret: 'whsec_one_time_only',
    }
    const requests = installFetchRecorder(response)

    const listed = await getAutomationInboundWebhookEndpoints('access-token')
    await getAutomationInboundWebhookEndpoint('access-token', 'release/hook')
    const created = await createAutomationInboundWebhookEndpoint(
      'access-token',
      { name: 'Release events' },
      mutationContext,
    )
    await updateAutomationInboundWebhookEndpoint(
      'access-token',
      'release/hook',
      { expectedRevision: 4, name: 'Production releases' },
      mutationContext,
    )
    await pauseAutomationInboundWebhookEndpoint(
      'access-token',
      'release/hook',
      { expectedRevision: 5 },
      mutationContext,
    )
    await resumeAutomationInboundWebhookEndpoint(
      'access-token',
      'release/hook',
      { expectedRevision: 6 },
      mutationContext,
    )
    const rotated = await rotateAutomationInboundWebhookEndpoint(
      'access-token',
      'release/hook',
      { expectedRevision: 7 },
      mutationContext,
    )
    await revokeAutomationInboundWebhookEndpoint(
      'access-token',
      'release/hook',
      { expectedRevision: 8 },
      mutationContext,
    )

    expect(listed).toEqual([endpoint])
    expect(JSON.stringify(listed)).not.toContain('whsec_one_time_only')
    expect(created.signingSecret).toBe('whsec_one_time_only')
    expect(rotated.signingSecret).toBe('whsec_one_time_only')
    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      [undefined, '/api/automation/inbound-webhooks'],
      [undefined, '/api/automation/inbound-webhooks/release%2Fhook'],
      ['POST', '/api/automation/inbound-webhooks'],
      ['PATCH', '/api/automation/inbound-webhooks/release%2Fhook'],
      ['POST', '/api/automation/inbound-webhooks/release%2Fhook/pause'],
      ['POST', '/api/automation/inbound-webhooks/release%2Fhook/resume'],
      ['POST', '/api/automation/inbound-webhooks/release%2Fhook/rotate'],
      ['DELETE', '/api/automation/inbound-webhooks/release%2Fhook'],
    ])
    for (const request of requests.slice(2)) {
      expect(request.init.headers).toMatchObject({
        'Idempotency-Key': mutationContext.idempotencyKey,
        'X-Correlation-Id': mutationContext.correlationId,
      })
    }
    expect(JSON.parse(String(requests[7]?.init.body))).toEqual({ expectedRevision: 8 })
  })
})

function createRuleInput(): CreateAutomationRuleInput {
  return {
    actions: [{ body: 'Review started', type: 'comment' }],
    conditions: [{
      field: 'workItem.priority',
      operator: 'equals',
      type: 'field',
      value: 'high',
    }],
    enabled: false,
    name: 'Review notification',
    trigger: { toStatusId: 'in-review', type: 'status' },
  }
}

function createInboundWebhookEndpoint(): AutomationInboundWebhookEndpoint {
  return {
    createdAt: '2026-07-16T00:00:00.000Z',
    endpointUrl: 'https://api.example.com/api/automation/inbound-webhooks/opaque-release-hook',
    id: 'release/hook',
    name: 'Release events',
    opaqueEndpointId: 'opaque-release-hook',
    revision: 4,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    secretGeneration: 1,
    status: 'active',
    updatedAt: '2026-07-16T00:00:00.000Z',
    version: 4,
    workspaceId: 'workspace-demo',
  }
}

function installFetchRecorder(responseBody: unknown) {
  const requests: Array<{ url: string; init: RequestInit }> = []

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })

    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  return requests
}
