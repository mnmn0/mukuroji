import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createBulkOperationAutomationFake,
  createBulkRecoveryIssue,
  createFakeWorkItemConfigurationClient,
  createFileProofingStub,
  createInboundWebhookEndpointRecord,
  createInboundWebhookProvisioning,
  createTestWorkItemConfiguration,
  originalBulkRecoveryTitle,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  createAutomationActionExecutor,
  createBulkItemMutationIdempotencyKey,
  requireBulkOperationOwner,
  toBulkOperationResponse,
} from '../../../../api/api-router'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
} from '../../../audit/audit'
import {
  FileProofingError,
} from '../../../files/file-proofing'
import type {
  FileProofingActor,
} from '../../../files/file-proofing'
import {
  DEFAULT_WORK_ITEM_CONFIGURATION,
} from '../../../work-items/work-item-configuration'
import type {
  AutomationActionExecutionContext,
} from '../../automation'
import {
  AutomationError,
  toAutomationInboundWebhookEndpoint,
} from '../../automation'
import type {
  AutomationInboundWebhookSecretStore,
} from '../../automation-inbound-webhook'
import type {
  AutomationTemplate,
  AutomationTemplateApplication,
  AutomationTemplateApplicationResult,
  BulkOperation,
  BulkOperationRequest,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  AUTOMATION_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'
import {
  createHmac,
} from 'node:crypto'

afterEach(() => {
  resetTestApp()
})

/** Focused execution port accepted by the API test dependency override. */
type TestAutomationExecutionPort = NonNullable<
  Parameters<typeof setTestAppDependencies>[0]['executions']
>

/** Focused Rule and Template port accepted by the API test dependency override. */
type TestAutomationRuleTemplatePort = NonNullable<
  Parameters<typeof setTestAppDependencies>[0]['ruleTemplates']
>

/** Focused inbound Webhook port accepted by the API test dependency override. */
type TestAutomationInboundWebhookPort = NonNullable<
  Parameters<typeof setTestAppDependencies>[0]['inboundWebhooks']
>

/** Focused recurring schedule port accepted by the API test dependency override. */
type TestAutomationRecurringSchedulePort = NonNullable<
  Parameters<typeof setTestAppDependencies>[0]['recurringSchedules']
>

/** Team Issues client accepted by the API test dependency override. */
type TestTeamIssuesClient = NonNullable<
  Parameters<typeof setTestAppDependencies>[0]['teamIssues']
>

/**
 * Fails a test when it exercises a focused port capability that was not configured.
 *
 * @returns Never returns.
 */
function unexpectedAutomationPortCall(): never {
  throw new Error('Unexpected Automation test port call.')
}

/**
 * Creates a complete focused execution port with fail-fast defaults.
 *
 * @param overrides - Execution behavior exercised by the current test.
 * @returns A type-safe execution port.
 */
function createAutomationExecutionPort(
  overrides: Partial<TestAutomationExecutionPort>,
): TestAutomationExecutionPort {
  return {
    async listDueExecutions() {
      return unexpectedAutomationPortCall()
    },
    async reserveExecution() {
      return unexpectedAutomationPortCall()
    },
    async createExecution() {
      return unexpectedAutomationPortCall()
    },
    async getExecution() {
      return unexpectedAutomationPortCall()
    },
    async getExecutionEvent() {
      return unexpectedAutomationPortCall()
    },
    async claimExecution() {
      return unexpectedAutomationPortCall()
    },
    async saveExecution() {
      return unexpectedAutomationPortCall()
    },
    async listExecutions() {
      return unexpectedAutomationPortCall()
    },
    async hasActionReceipt() {
      return unexpectedAutomationPortCall()
    },
    async putActionReceipt() {
      return unexpectedAutomationPortCall()
    },
    async getRuleVersion() {
      return unexpectedAutomationPortCall()
    },
    async getRecurringWork() {
      return unexpectedAutomationPortCall()
    },
    ...overrides,
  }
}

/**
 * Creates a complete focused Rule and Template port with fail-fast defaults.
 *
 * @param overrides - Rule or Template behavior exercised by the current test.
 * @returns A type-safe Rule and Template port.
 */
function createAutomationRuleTemplatePort(
  overrides: Partial<TestAutomationRuleTemplatePort>,
): TestAutomationRuleTemplatePort {
  return {
    async listRules() {
      return unexpectedAutomationPortCall()
    },
    async getRule() {
      return unexpectedAutomationPortCall()
    },
    async getRuleVersion() {
      return unexpectedAutomationPortCall()
    },
    async createRule() {
      return unexpectedAutomationPortCall()
    },
    async updateRule() {
      return unexpectedAutomationPortCall()
    },
    async deleteRule() {
      return unexpectedAutomationPortCall()
    },
    async listDueScheduledRules() {
      return unexpectedAutomationPortCall()
    },
    async completeScheduledRule() {
      return unexpectedAutomationPortCall()
    },
    async listTemplates() {
      return unexpectedAutomationPortCall()
    },
    async getTemplate() {
      return unexpectedAutomationPortCall()
    },
    async getTemplateVersion() {
      return unexpectedAutomationPortCall()
    },
    async createTemplate() {
      return unexpectedAutomationPortCall()
    },
    async updateTemplate() {
      return unexpectedAutomationPortCall()
    },
    async deleteTemplate() {
      return unexpectedAutomationPortCall()
    },
    async reserveTemplateApplication() {
      return unexpectedAutomationPortCall()
    },
    async getTemplateApplication() {
      return unexpectedAutomationPortCall()
    },
    async claimTemplateApplication() {
      return unexpectedAutomationPortCall()
    },
    createTemplateApplicationCompletionMutation() {
      return unexpectedAutomationPortCall()
    },
    async saveTemplateApplication() {
      return unexpectedAutomationPortCall()
    },
    ...overrides,
  }
}

/**
 * Creates a complete focused inbound Webhook port with fail-fast defaults.
 *
 * @param overrides - Webhook behavior exercised by the current test.
 * @returns A type-safe inbound Webhook port.
 */
function createAutomationInboundWebhookPort(
  overrides: Partial<TestAutomationInboundWebhookPort>,
): TestAutomationInboundWebhookPort {
  return {
    async listInboundWebhookEndpoints() {
      return unexpectedAutomationPortCall()
    },
    async getInboundWebhookEndpoint() {
      return unexpectedAutomationPortCall()
    },
    async resolveInboundWebhookEndpoint() {
      return unexpectedAutomationPortCall()
    },
    async reserveCreateInboundWebhookEndpoint() {
      return unexpectedAutomationPortCall()
    },
    async reserveRotateInboundWebhookEndpoint() {
      return unexpectedAutomationPortCall()
    },
    async completeInboundWebhookProvisioning() {
      return unexpectedAutomationPortCall()
    },
    async updateInboundWebhookEndpoint() {
      return unexpectedAutomationPortCall()
    },
    async setInboundWebhookEndpointStatus() {
      return unexpectedAutomationPortCall()
    },
    async revokeInboundWebhookEndpoint() {
      return unexpectedAutomationPortCall()
    },
    async recordInboundWebhookDelivery() {
      return unexpectedAutomationPortCall()
    },
    async listDueInboundWebhookSecretCleanups() {
      return unexpectedAutomationPortCall()
    },
    async completeInboundWebhookSecretCleanup() {
      return unexpectedAutomationPortCall()
    },
    ...overrides,
  }
}

/**
 * Creates a complete focused recurring schedule port with fail-fast defaults.
 *
 * @param overrides - Recurring schedule behavior exercised by the current test.
 * @returns A type-safe recurring schedule port.
 */
function createAutomationRecurringSchedulePort(
  overrides: Partial<TestAutomationRecurringSchedulePort>,
): TestAutomationRecurringSchedulePort {
  return {
    async listRecurringWorks() {
      return unexpectedAutomationPortCall()
    },
    async getRecurringWork() {
      return unexpectedAutomationPortCall()
    },
    async createRecurringWork() {
      return unexpectedAutomationPortCall()
    },
    async updateRecurringWork() {
      return unexpectedAutomationPortCall()
    },
    async completeRecurringWork() {
      return unexpectedAutomationPortCall()
    },
    async deleteRecurringWork() {
      return unexpectedAutomationPortCall()
    },
    async listDueRecurringWorks() {
      return unexpectedAutomationPortCall()
    },
    ...overrides,
  }
}

test('passes execution status into persistence pagination and rejects unknown statuses', async () => {
  configureFakeProjectClients(true)
  const queries: Array<
    Parameters<TestAutomationExecutionPort['listExecutions']>[0]
  > = []
  setTestAppDependencies({
    executions: createAutomationExecutionPort({
      async listExecutions(query) {
        queries.push(query)
        return { executions: [] }
      },
    }),
  })

  const response = await app.request(
    '/api/automation/executions?status=failed&limit=25&cursor=cursor-1',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(response.status).toBe(200)
  expect(queries).toEqual([{
    workspaceId: 'user#demo@example.com',
    ruleId: undefined,
    status: 'failed',
    cursor: 'cursor-1',
    limit: 25,
  }])

  const invalid = await app.request(
    '/api/automation/executions?status=unknown',
    { headers: { Authorization: 'Bearer test-token' } },
  )
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ code: 'InvalidAutomationQuery' })
  expect(queries).toHaveLength(1)
})

test('preserves FileProofingError status and code in Automation API responses', async () => {
  configureFakeProjectClients(true)
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async listRules() {
        throw new FileProofingError(
          409,
          'ApprovalRevisionConflict',
          'Approval changed. Reload and try again.',
        )
      },
    }),
  })

  const response = await app.request('/api/automation/rules', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'ApprovalRevisionConflict',
    message: 'Approval changed. Reload and try again.',
  })
})

test('preserves the legacy AutomationError fallback for unsupported numeric statuses', async () => {
  configureFakeProjectClients(true)
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async listRules() {
        throw new AutomationError(
          418,
          'UnsupportedLegacyAutomationStatus',
          'Legacy Automation status is unsupported.',
        )
      },
    }),
  })

  const response = await app.request('/api/automation/rules', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({
    code: 'UnsupportedLegacyAutomationStatus',
    message: 'Legacy Automation status is unsupported.',
  })
})

test('derives stable and item-scoped audit idempotency keys for bulk apply', () => {
  const request = {
    workspaceId: 'workspace-1',
    action: { type: 'move', targetProjectId: 'project-2' },
    items: [
      { teamId: 'team-1', workItemId: 'item-1', expectedRevision: 4 },
      { teamId: 'team-1', workItemId: 'item-2', expectedRevision: 7 },
    ],
  } satisfies BulkOperationRequest

  const first = createBulkItemMutationIdempotencyKey(request, 0, 'apply', 'owner@example.com')

  expect(first).toBe(createBulkItemMutationIdempotencyKey(
    structuredClone(request),
    0,
    'apply',
    'owner@example.com',
  ))
  expect(first).not.toBe(createBulkItemMutationIdempotencyKey(
    request,
    1,
    'apply',
    'owner@example.com',
  ))
  expect(first).not.toBe(createBulkItemMutationIdempotencyKey(
    request,
    0,
    'apply',
    'other@example.com',
  ))
  expect(first).toMatch(/^bulk_[a-f0-9]{64}$/)
})

test('enforces Bulk operation ownership and redacts durable undo snapshots', () => {
  const operation: BulkOperation = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'bulk-owner-test',
    workspaceId: 'workspace-1',
    actorMemberKey: 'owner@example.com',
    revision: 3,
    status: 'succeeded',
    action: { type: 'move', targetProjectId: 'project-2' },
    items: [{
      teamId: 'team-1',
      workItemId: 'item-1',
      expectedRevision: 4,
      resultingRevision: 5,
      status: 'succeeded',
      retryable: false,
      undoable: true,
      undoPayload: { assignedProjectId: 'project-1' },
    }],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:01.000Z',
  }

  expect(() => requireBulkOperationOwner(operation, 'owner@example.com')).not.toThrow()
  expect(() => requireBulkOperationOwner(operation, 'other@example.com')).toThrow()
  try {
    requireBulkOperationOwner(operation, 'other@example.com')
  } catch (error) {
    expect(error).toMatchObject({
      category: 'forbidden',
      code: 'BulkOperationForbidden',
    })
  }
  expect(toBulkOperationResponse(operation).items[0]).not.toHaveProperty('undoPayload')
  expect(operation.items[0]?.undoPayload).toEqual({ assignedProjectId: 'project-1' })
})

test('does not recover a Bulk apply from a competing actor state without its audit proof', async () => {
  configureFakeProjectClients(true)
  const originalIssue = createBulkRecoveryIssue()
  const competingIssue = {
    ...originalIssue,
    revision: 2,
    title: 'Bulk title',
    updatedAt: '2026-07-16T00:01:00.000Z',
  }
  const automationFake = createBulkOperationAutomationFake()
  let detailReads = 0
  let updateCalls = 0
  let auditProofReads = 0
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    teamIssues: {
      async getTeamIssueDetail() {
        detailReads += 1
        return {
          issue: structuredClone(detailReads <= 2 ? originalIssue : competingIssue),
          comments: [],
          activity: [],
        }
      },
      async updateTeamIssue() {
        updateCalls += 1
        throw new Error('The competing write must be detected before this update.')
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['teamIssues']
    >,
    auditEvents: {
      async getEvent() {
        auditProofReads += 1
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })
  const request = {
    action: { type: 'edit', patch: { title: 'Bulk title' } },
    items: [{
      teamId: originalIssue.teamId,
      workItemId: originalIssue.id,
      expectedRevision: originalIssue.revision,
    }],
  }
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }
  const previewResponse = await app.request('/api/bulk-operations/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })
  expect(previewResponse.status).toBe(200)
  const preview = await previewResponse.json() as { operationToken: string }

  const applyResponse = await app.request('/api/bulk-operations', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, operationToken: preview.operationToken }),
  })
  expect(applyResponse.status).toBe(201)
  expect(await applyResponse.json()).toMatchObject({
    status: 'failed',
    items: [{
      status: 'failed',
      errorCode: 'WorkItemRevisionConflict',
      retryable: false,
      undoable: false,
    }],
  })
  expect(detailReads).toBe(4)
  expect(auditProofReads).toBe(1)
  expect(updateCalls).toBe(0)
})

test('does not recover a Bulk undo from a competing actor state without its audit proof', async () => {
  configureFakeProjectClients(true)
  const currentIssue = {
    ...createBulkRecoveryIssue(),
    revision: 3,
    updatedAt: '2026-07-16T00:02:00.000Z',
  }
  const operation: BulkOperation = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'bulk-undo-competing-actor',
    workspaceId: 'user#demo@example.com',
    actorMemberKey: 'demo@example.com',
    revision: 1,
    status: 'succeeded',
    action: { type: 'edit', patch: { title: 'Bulk title' } },
    items: [{
      teamId: currentIssue.teamId,
      workItemId: currentIssue.id,
      expectedRevision: 1,
      resultingRevision: 2,
      status: 'succeeded',
      retryable: false,
      undoable: true,
      undoPayload: { title: originalBulkRecoveryTitle },
    }],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:01:00.000Z',
  }
  const automationFake = createBulkOperationAutomationFake(operation)
  let detailReads = 0
  let updateCalls = 0
  let auditProofReads = 0
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    teamIssues: {
      async getTeamIssueDetail() {
        detailReads += 1
        return {
          issue: structuredClone(currentIssue),
          comments: [],
          activity: [],
        }
      },
      async updateTeamIssue() {
        updateCalls += 1
        throw new Error('The competing undo state must be detected before this update.')
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['teamIssues']
    >,
    auditEvents: {
      async getEvent() {
        auditProofReads += 1
        return undefined
      },
      async query() {
        return { events: [] }
      },
    },
  })

  const response = await app.request(`/api/bulk-operations/${operation.id}/undo`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    status: 'partial',
    items: [{
      status: 'failed',
      errorCode: 'WorkItemRevisionConflict',
      resultingRevision: 2,
      retryable: false,
    }],
  })
  expect(detailReads).toBe(2)
  expect(auditProofReads).toBe(1)
  expect(updateCalls).toBe(0)
})

test('recovers Bulk apply and undo response loss only from their matching audit proofs', async () => {
  configureFakeProjectClients(true)
  let currentIssue = createBulkRecoveryIssue()
  const auditProofs = new Map<string, ReturnType<typeof createAuditEvent>>()
  const auditProofReads: string[] = []
  const mutationContexts: Parameters<typeof createAuditEvent>[0]['context'][] = []
  const automationFake = createBulkOperationAutomationFake()
  let updateCalls = 0
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    teamIssues: {
      async getTeamIssueDetail() {
        return {
          issue: structuredClone(currentIssue),
          comments: [],
          activity: [],
        }
      },
      async updateTeamIssue(...[
        directoryId,
        teamId,
        issueId,
        input,
        actorUserId,
        auditContext,
      ]: Parameters<TestTeamIssuesClient['updateTeamIssue']>) {
        if (!auditContext) throw new Error('Bulk mutation audit context is required.')
        updateCalls += 1
        mutationContexts.push(auditContext)
        const beforeRevision = currentIssue.revision
        const afterRevision = beforeRevision + 1
        currentIssue = {
          ...currentIssue,
          revision: afterRevision,
          title: typeof input.title === 'string' ? input.title : currentIssue.title,
          updatedAt: `2026-07-16T00:0${updateCalls}:00.000Z`,
        }
        const event = createAuditEvent({
          context: auditContext,
          expiresAt: calculateAuditExpiresAt(auditContext.occurredAt, 365),
          eventType: 'work-item.updated',
          entity: { type: 'work-item', id: `team/${teamId}/issue/${issueId}` },
          action: 'updated',
          metadata: {
            adapter: 'canonical-work-item',
            actorMemberKey: actorUserId,
            teamId,
            issueId,
            beforeRevision,
            afterRevision,
          },
        })
        expect(directoryId).toBe('user#demo@example.com')
        expect(input.expectedRevision).toBe(beforeRevision)
        auditProofs.set(event.eventId, event)
        throw new AutomationError(
          'unavailable',
          'BulkMutationResponseLost',
          'The mutation committed but its response was lost.',
          true,
        )
      },
    } as unknown as NonNullable<
      Parameters<typeof setTestAppDependencies>[0]['teamIssues']
    >,
    auditEvents: {
      async getEvent(workspaceId, eventId) {
        expect(workspaceId).toBe('user#demo@example.com')
        auditProofReads.push(eventId)
        return auditProofs.get(eventId)
      },
      async query() {
        return { events: [] }
      },
    },
  })
  const request = {
    action: { type: 'edit', patch: { title: 'Bulk title' } },
    items: [{
      teamId: currentIssue.teamId,
      workItemId: currentIssue.id,
      expectedRevision: currentIssue.revision,
    }],
  }
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }
  const previewResponse = await app.request('/api/bulk-operations/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })
  expect(previewResponse.status).toBe(200)
  const preview = await previewResponse.json() as { operationToken: string }
  const applyResponse = await app.request('/api/bulk-operations', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, operationToken: preview.operationToken }),
  })
  expect(applyResponse.status).toBe(201)
  const applied = await applyResponse.json() as BulkOperation
  expect(applied).toMatchObject({
    status: 'succeeded',
    items: [{
      status: 'succeeded',
      resultingRevision: 2,
      retryable: false,
      undoable: true,
    }],
  })
  expect(currentIssue).toMatchObject({ revision: 2, title: 'Bulk title' })

  const undoResponse = await app.request(`/api/bulk-operations/${applied.id}/undo`, {
    method: 'POST',
    headers,
  })
  expect(undoResponse.status).toBe(200)
  expect(await undoResponse.json()).toMatchObject({
    status: 'undone',
    items: [{
      status: 'undone',
      resultingRevision: 3,
      retryable: false,
      undoable: false,
    }],
  })
  expect(currentIssue).toMatchObject({
    revision: 3,
    title: originalBulkRecoveryTitle,
  })
  expect(updateCalls).toBe(2)
  expect(auditProofReads).toHaveLength(2)
  expect(new Set(auditProofReads).size).toBe(2)
  expect(mutationContexts).toHaveLength(2)
  expect(mutationContexts[0]?.requestFingerprint).not.toBe('')
  expect(mutationContexts[1]?.requestFingerprint).not.toBe('')
})

test('accepts an unauthenticated signed inbound webhook without exposing secret material', async () => {
  const previousAuditTable = process.env.MUKUROJI_AUDIT_EVENTS_TABLE
  process.env.MUKUROJI_AUDIT_EVENTS_TABLE = 'AuditTable'
  try {
    let resolvedEndpoint = createInboundWebhookEndpointRecord()
    let deliveryInput:
      | Parameters<TestAutomationInboundWebhookPort['recordInboundWebhookDelivery']>[1]
      | undefined
    const signingSecret = Buffer.from('server-issued-secret', 'utf8')
    const secretReads: unknown[] = []
    setTestAppDependencies({
      inboundWebhooks: createAutomationInboundWebhookPort({
        async resolveInboundWebhookEndpoint() {
          return structuredClone(resolvedEndpoint)
        },
        async recordInboundWebhookDelivery(_endpoint, input) {
          deliveryInput = input
          return { eventId: input.eventId, replayed: false }
        },
      }),
      automationInboundWebhookSecrets: {
        async provision() {
          throw new Error('Public delivery must not provision a secret.')
        },
        async get(reference) {
          secretReads.push(structuredClone(reference))
          return signingSecret
        },
        async delete() {
          throw new Error('Public delivery must not delete a secret.')
        },
      },
    })
    const rawBody = '{\n  "message": "deploy", "nested": { "value": 1 }\n}\n'
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const signature = `sha256=${createHmac('sha256', signingSecret)
      .update(`${timestamp}.`, 'utf8')
      .update(rawBody, 'utf8')
      .digest('hex')}`
    const request = () => app.request(
      `/api/automation/inbound-webhooks/${resolvedEndpoint.opaqueEndpointId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Idempotency-Key': 'sender-delivery-1',
          'X-Mukuroji-Signature': signature,
          'X-Mukuroji-Timestamp': timestamp,
        },
        body: rawBody,
      },
    )

    const response = await request()
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ eventId: deliveryInput?.eventId })
    expect(secretReads).toEqual([expect.objectContaining({
      secretId: resolvedEndpoint.secretId,
      secretVersionId: resolvedEndpoint.secretVersionId,
      secretGeneration: resolvedEndpoint.secretGeneration,
    })])
    expect(deliveryInput).toMatchObject({
      idempotencyKey: 'sender-delivery-1',
      signatureTimestamp: timestamp,
      auditMutation: { Put: { TableName: 'AuditTable' } },
    })
    expect(JSON.stringify(deliveryInput)).not.toContain('server-issued-secret')
    expect(JSON.stringify(deliveryInput)).not.toContain(signature)
    expect(deliveryInput?.bodyFingerprint).toMatch(/^[a-f0-9]{64}$/)

    resolvedEndpoint = { ...resolvedEndpoint, status: 'paused' }
    expect((await request()).status).toBe(423)
    resolvedEndpoint = { ...resolvedEndpoint, status: 'provisioning' }
    expect((await request()).status).toBe(404)
  } finally {
    if (previousAuditTable === undefined) delete process.env.MUKUROJI_AUDIT_EVENTS_TABLE
    else process.env.MUKUROJI_AUDIT_EVENTS_TABLE = previousAuditTable
  }
})

test('maps inbound webhook public validation failures without Cognito authentication', async () => {
  const endpoint = createInboundWebhookEndpointRecord()
  setTestAppDependencies({
    inboundWebhooks: createAutomationInboundWebhookPort({
      async resolveInboundWebhookEndpoint(opaqueEndpointId) {
        return opaqueEndpointId === endpoint.opaqueEndpointId ? endpoint : undefined
      },
    }),
  })
  const baseUrl = `/api/automation/inbound-webhooks/${endpoint.opaqueEndpointId}`
  expect((await app.request(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': 'delivery-1' },
    body: '{}',
  })).status).toBe(415)
  expect((await app.request(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })).status).toBe(400)
  expect((await app.request(`/api/automation/inbound-webhooks/${'Z'.repeat(43)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'delivery-1' },
    body: '{}',
  })).status).toBe(404)
})

test('returns plaintext inbound secrets only from create/rotate and redacts durable endpoints', async () => {
  configureFakeProjectClients(true)
  let current = createInboundWebhookEndpointRecord({
    status: 'provisioning',
    revision: 1,
    provisioningOperationId: `inbound_operation_create_${'d'.repeat(32)}`,
    provisioningTargetStatus: 'active',
  })
  let deletedSecrets = 0
  const createProvisioning = createInboundWebhookProvisioning(current, 'create')
  const secretStore: AutomationInboundWebhookSecretStore = {
    async provision(reference) {
      return `one-time-secret-generation-${reference.secretGeneration}`
    },
    async get() {
      throw new Error('Admin routes must not read delivery secrets.')
    },
    async delete() {
      deletedSecrets += 1
    },
  }
  setTestAppDependencies({
    inboundWebhooks: createAutomationInboundWebhookPort({
      async listInboundWebhookEndpoints() {
        return [toAutomationInboundWebhookEndpoint(current)]
      },
      async getInboundWebhookEndpoint() {
        return toAutomationInboundWebhookEndpoint(current)
      },
      async reserveCreateInboundWebhookEndpoint() {
        return structuredClone(createProvisioning)
      },
      async reserveRotateInboundWebhookEndpoint() {
        const rotated = createInboundWebhookEndpointRecord({
          ...current,
          status: 'provisioning',
          version: current.version + 1,
          revision: current.revision + 1,
          secretGeneration: current.secretGeneration + 1,
          secretVersionId: 'f'.repeat(64),
        })
        return createInboundWebhookProvisioning(rotated, 'rotate')
      },
      async completeInboundWebhookProvisioning(provisioning) {
        current = {
          ...provisioning.endpoint,
          status: provisioning.operation.targetStatus,
          revision: provisioning.endpoint.revision + 1,
        }
        delete current.provisioningOperationId
        delete current.provisioningTargetStatus
        return structuredClone(current)
      },
      async revokeInboundWebhookEndpoint() {
        current = {
          ...current,
          status: 'revoked',
          version: current.version + 1,
          revision: current.revision + 1,
          revokedAt: new Date().toISOString(),
        }
        return structuredClone(current)
      },
    }),
    automationInboundWebhookSecrets: secretStore,
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'admin-operation-1',
  }
  const createdResponse = await app.request('/api/automation/inbound-webhooks', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Build events' }),
  })
  expect(createdResponse.status).toBe(201)
  const created = await createdResponse.json() as Record<string, unknown>
  expect(created.signingSecret).toBe('one-time-secret-generation-1')
  expect(created.endpoint).not.toHaveProperty('secretId')
  expect(created.endpoint).not.toHaveProperty('secretVersionId')

  const getResponse = await app.request(`/api/automation/inbound-webhooks/${current.id}`, {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(getResponse.status).toBe(200)
  expect(await getResponse.json()).not.toHaveProperty('signingSecret')
  const listResponse = await app.request('/api/automation/inbound-webhooks', {
    headers: { Authorization: 'Bearer test-token' },
  })
  expect(await listResponse.json()).not.toHaveProperty('signingSecret')

  const rotateResponse = await app.request(
    `/api/automation/inbound-webhooks/${current.id}/rotate`,
    {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'admin-rotate-1' },
      body: JSON.stringify({ expectedRevision: current.revision }),
    },
  )
  expect(rotateResponse.status).toBe(200)
  const rotated = await rotateResponse.json() as Record<string, unknown>
  expect(rotated.signingSecret).toBe('one-time-secret-generation-2')
  expect(rotated.endpoint).not.toHaveProperty('secretId')

  const revokeResponse = await app.request(`/api/automation/inbound-webhooks/${current.id}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ expectedRevision: current.revision }),
  })
  expect(revokeResponse.status).toBe(200)
  expect(await revokeResponse.json()).not.toHaveProperty('signingSecret')
  expect(deletedSecrets).toBe(1)
})

test('compensates a late secret provision after an administrator aborts provisioning', async () => {
  configureFakeProjectClients(true)
  const provisioning = createInboundWebhookProvisioning(
    createInboundWebhookEndpointRecord({ status: 'provisioning', revision: 1 }),
    'create',
  )
  let deletedSecrets = 0
  let provisionFails = false
  setTestAppDependencies({
    inboundWebhooks: createAutomationInboundWebhookPort({
      async reserveCreateInboundWebhookEndpoint() {
        return provisioning
      },
      async completeInboundWebhookProvisioning() {
        throw new AutomationError(
          'conflict',
          'AutomationInboundWebhookLifecycleConflict',
          'Endpoint was revoked while the secret write was in flight.',
        )
      },
      async getInboundWebhookEndpoint() {
        return toAutomationInboundWebhookEndpoint({
          ...provisioning.endpoint,
          status: 'revoked',
          revokedAt: new Date().toISOString(),
          provisioningOperationId: undefined,
          provisioningTargetStatus: undefined,
        })
      },
    }),
    automationInboundWebhookSecrets: {
      async provision() {
        if (provisionFails) {
          throw new AutomationError(
            'unavailable',
            'AutomationInboundWebhookSecretUnavailable',
            'Secret write response and recovery read were unavailable.',
            true,
          )
        }
        return 'late-secret'
      },
      async get() {
        throw new Error('Unexpected get.')
      },
      async delete() {
        deletedSecrets += 1
      },
    },
  })
  const response = await app.request('/api/automation/inbound-webhooks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'late-provision',
    },
    body: JSON.stringify({ name: 'Aborted endpoint' }),
  })
  expect(response.status).toBe(409)
  expect(deletedSecrets).toBe(1)

  provisionFails = true
  const lostWriteResponse = await app.request('/api/automation/inbound-webhooks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'late-provision',
    },
    body: JSON.stringify({ name: 'Aborted endpoint' }),
  })
  expect(lostWriteResponse.status).toBe(503)
  expect(deletedSecrets).toBe(2)
})

test('recovers an automation Work Item update only from its deterministic audit proof', async () => {
  const runResponseLoss = async (withAuditProof: boolean) => {
    configureFakeProjectClients(true, {
      teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
    })
    let currentIssue = createBulkRecoveryIssue()
    let auditProof: ReturnType<typeof createAuditEvent> | undefined
    let auditProofReads = 0
    setTestAppDependencies({
      teamIssues: {
        async getTeamIssueDetail() {
          return {
            issue: structuredClone(currentIssue),
            comments: [],
            activity: [],
          }
        },
        async updateTeamIssue(...[
          _directoryId,
          teamId,
          issueId,
          input,
          actorUserId,
          auditContext,
        ]: Parameters<TestTeamIssuesClient['updateTeamIssue']>) {
          if (!auditContext) throw new Error('Automation mutation audit context is required.')
          const beforeRevision = currentIssue.revision
          const afterRevision = beforeRevision + 1
          currentIssue = {
            ...currentIssue,
            revision: afterRevision,
            title: String(input.title),
            updatedAt: '2026-07-16T00:01:00.000Z',
          }
          const event = createAuditEvent({
            context: auditContext,
            expiresAt: calculateAuditExpiresAt(auditContext.occurredAt, 365),
            eventType: 'work-item.updated',
            entity: { type: 'work-item', id: `team/${teamId}/issue/${issueId}` },
            action: 'updated',
            metadata: {
              adapter: 'canonical-work-item',
              actorMemberKey: actorUserId,
              teamId,
              issueId,
              beforeRevision,
              afterRevision,
            },
          })
          if (withAuditProof) auditProof = event
          throw new AutomationError(
            'unavailable',
            'AutomationMutationResponseLost',
            'The mutation committed but its response was lost.',
            true,
          )
        },
      } as unknown as NonNullable<
        Parameters<typeof setTestAppDependencies>[0]['teamIssues']
      >,
      auditEvents: {
        async getEvent(workspaceId, eventId) {
          auditProofReads += 1
          expect(workspaceId).toBe('workspace-1')
          return auditProof?.eventId === eventId ? auditProof : undefined
        },
        async query() {
          return { events: [] }
        },
      },
    })
    const context = {
      execution: {
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        id: `automation-update-${withAuditProof ? 'proved' : 'unproved'}`,
        workspaceId: 'workspace-1',
        ruleId: 'rule-1',
        ruleVersion: 1,
        triggerEventId: 'event-1',
        status: 'running',
        attempts: 1,
        actions: [],
        startedAt: '2026-07-16T00:00:00.000Z',
        retryable: false,
      },
      event: {
        eventId: 'event-1',
        eventType: 'work-item.updated',
        workspaceId: 'workspace-1',
        occurredAt: '2026-07-16T00:00:00.000Z',
        changes: [],
        metadata: { teamId: 'core-team', issueId: currentIssue.id },
      },
      actionIndex: 0,
      idempotencyKey: `automation-update-${withAuditProof ? 'proved' : 'unproved'}:action:0000`,
    } satisfies AutomationActionExecutionContext
    const execution = runWithTestAppDependencies(() =>
      createAutomationActionExecutor().execute({
        type: 'update',
        patch: { title: 'Automation title' },
      }, context)
    )

    if (withAuditProof) {
      await expect(execution).resolves.toBeUndefined()
    } else {
      await expect(execution).rejects.toMatchObject({
        code: 'AutomationMutationResponseLost',
        category: 'unavailable',
      })
    }
    expect(auditProofReads).toBe(1)
  }

  await runResponseLoss(false)
  await runResponseLoss(true)
})

test('fails closed when automation targets a Project outside the owner Team', async () => {
  const calls = configureFakeProjectClients(true, {
    teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
  })
  const context = {
    execution: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-project-guard',
      workspaceId: 'workspace-1',
      ruleId: 'rule-1',
      ruleVersion: 1,
      triggerEventId: 'event-1',
      status: 'running',
      attempts: 1,
      actions: [],
      startedAt: '2026-07-16T00:00:00.000Z',
      retryable: false,
    },
    event: {
      eventId: 'event-1',
      eventType: 'work-item.updated',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-16T00:00:00.000Z',
      changes: [],
      metadata: { teamId: 'core-team', issueId: 'issue-1' },
    },
    actionIndex: 0,
    idempotencyKey: 'automation-project-guard:action:0000',
  } satisfies AutomationActionExecutionContext
  const executor = createAutomationActionExecutor()

  await expect(runWithTestAppDependencies(() =>
    executor.execute({ type: 'move', targetProjectId: 'other-team-project' }, context)
  ))
    .rejects.toMatchObject({ code: 'InvalidProjectWrite', status: 400 })
  await expect(runWithTestAppDependencies(() =>
    executor.execute({
      type: 'create',
      values: {
        teamId: 'core-team',
        title: 'Invalid project create',
        assignedProjectId: 'other-team-project',
      },
    }, context)
  )).rejects.toMatchObject({ code: 'InvalidProjectWrite', status: 400 })
  expect(calls.issueUpdates).toHaveLength(0)
  expect(calls.issueCreates).toHaveLength(0)
})

test('fails closed before an automation comment targets a removed Team', async () => {
  const calls = configureFakeProjectClients(true)
  const context = {
    execution: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-comment-team-guard',
      workspaceId: 'workspace-1',
      ruleId: 'rule-1',
      ruleVersion: 1,
      triggerEventId: 'event-1',
      status: 'running',
      attempts: 1,
      actions: [],
      startedAt: '2026-07-16T00:00:00.000Z',
      retryable: false,
    },
    event: {
      eventId: 'event-1',
      eventType: 'work-item.updated',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-16T00:00:00.000Z',
      changes: [],
      metadata: { teamId: 'removed-team', issueId: 'issue-1' },
    },
    actionIndex: 0,
    idempotencyKey: 'automation-comment-team-guard:action:0000',
  } satisfies AutomationActionExecutionContext

  await expect(runWithTestAppDependencies(() =>
    createAutomationActionExecutor().execute({
      type: 'comment',
      body: 'This must not be written.',
    }, context)
  )).rejects.toMatchObject({
    category: 'conflict',
    code: 'AutomationTeamUnavailable',
  })
  expect(calls.issueComments).toHaveLength(0)
})

test('rejects removed recurring-work Teams on create and update before saving a definition', async () => {
  configureFakeProjectClients(true)
  let updateCalls = 0
  setTestAppDependencies({
    recurringSchedules: createAutomationRecurringSchedulePort({
      async getRecurringWork() {
        return {
          schemaVersion: AUTOMATION_SCHEMA_VERSION,
          id: 'recurring-1',
          workspaceId: 'user#demo@example.com',
          teamId: 'core-team',
          name: 'Daily triage',
          enabled: true,
          version: 1,
          revision: 1,
          templateId: 'template-1',
          templateVersion: 1,
          schedule: {
            frequency: 'daily',
            interval: 1,
            timeZone: 'UTC',
            localTime: '09:00',
            startDate: '2026-07-16',
            catchUpPolicy: 'latest',
          },
          nextRunAt: '2026-07-17T09:00:00.000Z',
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
        }
      },
      async updateRecurringWork() {
        updateCalls += 1
        throw new Error('Removed Team must be rejected first.')
      },
    }),
  })
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  }
  const createResponse = await app.request('/api/recurring-work', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Daily triage',
      teamId: 'removed-team',
      enabled: true,
      templateId: 'template-1',
      schedule: {
        frequency: 'daily',
        interval: 1,
        timeZone: 'UTC',
        localTime: '09:00',
        startDate: '2026-07-16',
        catchUpPolicy: 'latest',
      },
    }),
  })
  const updateResponse = await app.request('/api/recurring-work/recurring-1', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ expectedRevision: 1, teamId: 'removed-team' }),
  })

  expect(createResponse.status).toBe(409)
  expect(await createResponse.json()).toMatchObject({ code: 'AutomationTeamUnavailable' })
  expect(updateResponse.status).toBe(409)
  expect(await updateResponse.json()).toMatchObject({ code: 'AutomationTeamUnavailable' })
  expect(updateCalls).toBe(0)
})

test('recovers a Project template application from atomic receipt success without duplicate creation', async () => {
  const now = '2026-07-16T00:00:00.000Z'
  const template: AutomationTemplate = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'template-project-1',
    workspaceId: 'user#demo@example.com',
    kind: 'project',
    name: 'Incident response Project',
    enabled: true,
    version: 1,
    revision: 1,
    payload: { nameJa: '障害対応', nameEn: 'Incident response', tone: 'purple' },
    createdAt: now,
    updatedAt: now,
  }
  let application: AutomationTemplateApplication = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'application_project_1',
    workspaceId: template.workspaceId,
    actorId: 'demo@example.com',
    templateId: template.id,
    templateVersion: template.version,
    kind: 'project',
    target: { kind: 'project', teamId: 'core-team' },
    status: 'pending',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  let createCalls = 0
  let templateVersionReads = 0
  configureFakeProjectClients(true, {
    async projectCreateHook(input, completionTransactItems) {
      createCalls += 1
      expect(input.idempotencyResourceId).toBe(application.id)
      expect(completionTransactItems).toHaveLength(1)
      const result = completionTransactItems[0]?.Update?.ExpressionAttributeValues?.[':result'] as
        | AutomationTemplateApplicationResult
        | undefined
      application = {
        ...application,
        status: 'succeeded',
        revision: application.revision + 1,
        result,
        runnerLeaseExpiresAt: undefined,
        updatedAt: '2026-07-16T00:00:01.000Z',
      }
      throw new Error('The atomic Project transaction committed but its response was lost.')
    },
  })
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async reserveTemplateApplication() {
        return structuredClone(application)
      },
      async claimTemplateApplication(candidate, _claimNow, leaseExpiresAt) {
        if (candidate.status !== 'pending' || application.revision !== candidate.revision) return undefined
        application = {
          ...application,
          status: 'running',
          revision: application.revision + 1,
          runnerLeaseExpiresAt: leaseExpiresAt,
          updatedAt: now,
        }
        return structuredClone(application)
      },
      createTemplateApplicationCompletionMutation(candidate, result) {
        return {
          Update: {
            TableName: 'AutomationTable',
            Key: { scopeKey: candidate.workspaceId, recordKey: candidate.id },
            UpdateExpression: 'SET #status = :succeeded, #result = :result',
            ExpressionAttributeValues: { ':result': result, ':succeeded': 'succeeded' },
          },
        }
      },
      async getTemplateApplication() {
        return structuredClone(application)
      },
      async getTemplateVersion() {
        templateVersionReads += 1
        return structuredClone(template)
      },
    }),
  })
  const request = () => app.request(
    `/api/automation/templates/${template.id}/applications`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'apply-project-1',
      },
      body: JSON.stringify({ target: { kind: 'project', teamId: 'core-team' } }),
    },
  )

  const first = await request()
  const replay = await request()
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({
    status: 'succeeded',
    result: {
      kind: 'project',
      projectId: application.id,
      teamId: 'core-team',
      name: '障害対応',
    },
  })
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ status: 'succeeded', id: application.id })
  expect({ createCalls, templateVersionReads }).toEqual({ createCalls: 1, templateVersionReads: 1 })
})

test('keeps unsupported legacy 4xx template failures terminal', async () => {
  const now = '2026-07-16T00:00:00.000Z'
  const template: AutomationTemplate = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'template-project-legacy-failure',
    workspaceId: 'user#demo@example.com',
    kind: 'project',
    name: 'Legacy failure Project',
    enabled: true,
    version: 1,
    revision: 1,
    payload: { nameJa: '旧エラー', nameEn: 'Legacy failure', tone: 'purple' },
    createdAt: now,
    updatedAt: now,
  }
  let application: AutomationTemplateApplication = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'application_project_legacy_failure',
    workspaceId: template.workspaceId,
    actorId: 'demo@example.com',
    templateId: template.id,
    templateVersion: template.version,
    kind: 'project',
    target: { kind: 'project', teamId: 'core-team' },
    status: 'pending',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  let savedApplication: AutomationTemplateApplication | undefined
  configureFakeProjectClients(true, {
    async projectCreateHook() {
      throw new AutomationError(
        418,
        'UnsupportedLegacyTemplateFailure',
        'Legacy template failure is terminal.',
      )
    },
  })
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async reserveTemplateApplication() {
        return structuredClone(application)
      },
      async claimTemplateApplication(candidate, _claimNow, leaseExpiresAt) {
        application = {
          ...candidate,
          status: 'running',
          revision: candidate.revision + 1,
          runnerLeaseExpiresAt: leaseExpiresAt,
        }
        return structuredClone(application)
      },
      createTemplateApplicationCompletionMutation() {
        return {
          Update: {
            TableName: 'AutomationTable',
            Key: { scopeKey: application.workspaceId, recordKey: application.id },
            UpdateExpression: 'SET #status = :succeeded',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':succeeded': 'succeeded' },
          },
        }
      },
      async getTemplateApplication() {
        return structuredClone(application)
      },
      async getTemplateVersion() {
        return structuredClone(template)
      },
      async saveTemplateApplication(candidate) {
        savedApplication = structuredClone(candidate)
        application = structuredClone(candidate)
      },
    }),
  })

  const response = await app.request(
    `/api/automation/templates/${template.id}/applications`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'apply-project-legacy-failure',
      },
      body: JSON.stringify({ target: { kind: 'project', teamId: 'core-team' } }),
    },
  )

  expect(response.status).toBe(502)
  expect(savedApplication).toMatchObject({
    status: 'failed',
    errorCode: 'UnsupportedLegacyTemplateFailure',
    errorMessage: 'Legacy template failure is terminal.',
  })
})

test('applies a Workflow template atomically while preserving custom fields and target revision', async () => {
  configureFakeProjectClients(true)
  const workspaceId = 'user#demo@example.com'
  const now = '2026-07-16T00:00:00.000Z'
  const template: AutomationTemplate = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'template-workflow-1',
    workspaceId,
    kind: 'workflow',
    name: 'Delivery workflow',
    enabled: true,
    version: 1,
    revision: 1,
    payload: {
      ...structuredClone(DEFAULT_WORK_ITEM_CONFIGURATION.workflow),
      name: 'Delivery workflow',
    },
    createdAt: now,
    updatedAt: now,
  }
  let application: AutomationTemplateApplication = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'application_workflow_1',
    workspaceId,
    actorId: 'demo@example.com',
    templateId: template.id,
    templateVersion: 1,
    kind: 'workflow',
    target: { kind: 'workflow', scopeType: 'team', scopeId: 'core-team', expectedRevision: 2 },
    status: 'pending',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  const existingConfiguration: WorkItemConfiguration = {
    ...createTestWorkItemConfiguration('team', 'core-team', 2),
    customFields: [{
      id: 'customer',
      name: 'Customer',
      type: 'text',
      sortOrder: 10,
      required: false,
    }],
  }
  let savedConfiguration: WorkItemConfiguration | undefined
  let completionCount = 0
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async reserveTemplateApplication() {
        return structuredClone(application)
      },
      async claimTemplateApplication(candidate, _claimNow, leaseExpiresAt) {
        if (candidate.status !== 'pending') return undefined
        application = {
          ...application,
          status: 'running',
          revision: application.revision + 1,
          runnerLeaseExpiresAt: leaseExpiresAt,
        }
        return structuredClone(application)
      },
      createTemplateApplicationCompletionMutation(candidate, result) {
        return {
          Update: {
            TableName: 'AutomationTable',
            Key: { scopeKey: candidate.workspaceId, recordKey: candidate.id },
            UpdateExpression: 'SET #status = :succeeded, #result = :result',
            ExpressionAttributeValues: { ':result': result, ':succeeded': 'succeeded' },
          },
        }
      },
      async getTemplateApplication() {
        return structuredClone(application)
      },
      async getTemplateVersion() {
        return structuredClone(template)
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration() {
        return { configuration: structuredClone(existingConfiguration) }
      },
      async saveTeamConfiguration(
        _savedWorkspaceId,
        _teamId,
        configuration,
        usageCheck,
        completionTransactItems = [],
      ) {
        await usageCheck()
        savedConfiguration = structuredClone(configuration)
        const result = completionTransactItems[0]?.Update?.ExpressionAttributeValues?.[':result'] as
          | AutomationTemplateApplicationResult
          | undefined
        completionCount = completionTransactItems.length
        application = {
          ...application,
          status: 'succeeded',
          revision: application.revision + 1,
          result,
          runnerLeaseExpiresAt: undefined,
          updatedAt: '2026-07-16T00:00:01.000Z',
        }
        return {
          configuration: {
            ...structuredClone(configuration),
            revision: configuration.revision + 1,
          },
        }
      },
    }),
  })

  const response = await app.request(
    `/api/automation/templates/${template.id}/applications`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'apply-workflow-1',
      },
      body: JSON.stringify({
        target: {
          kind: 'workflow',
          scopeType: 'team',
          scopeId: 'core-team',
          expectedRevision: 2,
        },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    status: 'succeeded',
    result: { kind: 'workflow', scopeType: 'team', scopeId: 'core-team', revision: 3 },
  })
  expect(savedConfiguration).toMatchObject({
    revision: 2,
    workflow: { name: 'Delivery workflow' },
    customFields: existingConfiguration.customFields,
  })
  expect(completionCount).toBe(1)
})

test('retries Work Item approval with an execution-anchored deadline after response loss', async () => {
  configureFakeProjectClients(true)
  const approvalWrites: Array<{
    actor: FileProofingActor
    dueAt: string
    requestFingerprint?: string
    scope: { issueId?: string; projectId?: string; teamId: string; workspaceId: string }
  }> = []
  let loseFirstResponse = true
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async createWorkItemApproval(scope, actor, input, auditContext) {
        approvalWrites.push({
          actor,
          dueAt: input.dueAt,
          requestFingerprint: auditContext?.requestFingerprint,
          scope,
        })
        if (loseFirstResponse) {
          loseFirstResponse = false
          throw new Error('The approval committed but its response was lost.')
        }
        return {
          id: 'approval-automation-1',
          subjectType: 'work-item',
          revision: 1,
          status: 'pending',
          reviewers: input.reviewerMemberKeys.map((memberKey) => ({
            memberKey,
            status: 'pending',
          })),
          dueAt: input.dueAt,
          requestedByMemberKey: actor.memberKey,
          requestedByKind: 'service',
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
          capabilities: { canCancel: false, canDecide: false },
        }
      },
    }),
  })
  const execution = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'approval-response-loss',
    workspaceId: 'workspace-1',
    ruleId: 'rule-1',
    ruleVersion: 1,
    triggerEventId: 'event-1',
    status: 'running' as const,
    attempts: 1,
    actions: [{
      actionIndex: 0,
      actionId: 'approval-response-loss:action:0000',
      status: 'running' as const,
      attempts: 1,
      startedAt: '2026-07-16T02:00:00.000Z',
    }],
    startedAt: '2026-07-16T00:00:00.000Z',
    retryable: false,
  }
  const event = {
    eventId: 'event-1',
    eventType: 'work-item.updated',
    workspaceId: 'workspace-1',
    occurredAt: '2026-07-16T00:00:00.000Z',
    changes: [],
    metadata: { teamId: 'core-team', issueId: 'issue-1' },
  }
  const action = {
    type: 'approval' as const,
    reviewerMemberKeys: ['Reviewer@Example.com'],
    dueInHours: 24,
  }
  const executor = createAutomationActionExecutor()
  const firstContext = {
    execution,
    event,
    actionIndex: 0,
    idempotencyKey: 'approval-response-loss:action:0000',
  } satisfies AutomationActionExecutionContext

  await expect(runWithTestAppDependencies(() =>
    executor.execute(action, firstContext)
  )).rejects.toThrow('response was lost')
  const reloadedContext = {
    ...firstContext,
    execution: {
      ...execution,
      actions: [{
        actionIndex: 0,
        actionId: 'approval-response-loss:action:0000',
        status: 'pending' as const,
        attempts: 0,
      }],
    },
  } satisfies AutomationActionExecutionContext
  await runWithTestAppDependencies(() =>
    executor.execute(action, reloadedContext)
  )

  expect(approvalWrites).toHaveLength(2)
  expect(approvalWrites[0]).toMatchObject({
    actor: {
      kind: 'service',
      memberKey: 'automation:rule-1',
      canManage: true,
      canWrite: true,
    },
    dueAt: '2026-07-17T00:00:00.000Z',
    scope: {
      workspaceId: 'workspace-1',
      teamId: 'core-team',
      issueId: 'issue-1',
      projectId: 'refero',
    },
  })
  expect(approvalWrites[1]?.dueAt).toBe(approvalWrites[0]?.dueAt)
  expect(approvalWrites[1]?.requestFingerprint).toBe(approvalWrites[0]?.requestFingerprint)
})

test('rejects inactive automation approval reviewers before creating durable state', async () => {
  configureFakeProjectClients(true, {
    inactiveWorkspaceMemberKeys: ['inactive@example.com'],
  })
  let createCalls = 0
  setTestAppDependencies({
    fileProofing: createFileProofingStub({
      async createWorkItemApproval() {
        createCalls += 1
        throw new Error('An inactive reviewer must not reach durable approval creation.')
      },
    }),
  })
  const context = {
    execution: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'approval-inactive-reviewer',
      workspaceId: 'workspace-1',
      ruleId: 'rule-1',
      ruleVersion: 1,
      triggerEventId: 'event-1',
      status: 'running',
      attempts: 1,
      actions: [],
      startedAt: '2026-07-16T00:00:00.000Z',
      retryable: false,
    },
    event: {
      eventId: 'event-1',
      eventType: 'work-item.updated',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-16T00:00:00.000Z',
      changes: [],
      metadata: { teamId: 'core-team', issueId: 'issue-1' },
    },
    actionIndex: 0,
    idempotencyKey: 'approval-inactive-reviewer:action:0000',
  } satisfies AutomationActionExecutionContext

  await expect(runWithTestAppDependencies(() =>
    createAutomationActionExecutor().execute({
      type: 'approval',
      reviewerMemberKeys: ['inactive@example.com'],
      dueInHours: 24,
    }, context)
  )).rejects.toMatchObject({
    code: 'ApprovalReviewerInactive',
    status: 409,
  })
  expect(createCalls).toBe(0)
})
