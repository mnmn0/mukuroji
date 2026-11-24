import { listDelegatedManagementScopes } from '../../../../api/shared/team-delegated-management'
import type { WorkspacePrincipal } from '../../../../api/shared/project-access'
import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  createBulkOperationAutomationFake,
  createBulkRecoveryIssue,
  createCollaborationStub,
  createFakeWorkItemConfigurationClient,
  createFileProofingStub,
  createInboundWebhookEndpointRecord,
  createTeamIssuesFake,
  createInboundWebhookProvisioning,
  createTestWorkItemConfiguration,
  getTestAppDependencies,
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
import type {
  CollaborationClient,
} from '../../../collaboration/collaboration'
import {
  DEFAULT_WORK_ITEM_CONFIGURATION,
  WorkItemConfigurationError,
} from '../../../work-items/work-item-configuration'
import {
  createWorkItemAuthorizationChangedError,
  normalizeWorkItemSchedule,
} from '../../../work-items'
import { InMemoryPlanningClient, PlanningError } from '../../../planning/planning'
import {
  createActiveAgentRun,
  InMemoryAgentRunStore,
  readStartAgentRunRequest,
} from '../../../agent-runs'
import type {
  AutomationActionExecutionContext,
} from '../../application/ports'
import { AutomationError } from '../../domain/automation-error'
import { TriageError } from '../../../triage'
import { ProjectDataError } from '../../../directory'
import { toAutomationInboundWebhookEndpoint } from '../../application/inbound-webhook-view'
import type {
  AutomationInboundWebhookSecretStore,
} from '../../automation-inbound-webhook'
import type {
  AutomationTemplate,
  AutomationTemplateApplication,
  AutomationTemplateApplicationResult,
  BulkOperation,
  BulkOperationRequest,
  CreateWebhookTriageEntryInput,
  TriageEntry,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  AUTOMATION_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  createWorkItemHierarchyRankBetween,
  DEFAULT_WORK_ITEM_TYPE,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'
import {
  createHash,
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
 * Creates unfiltered Planning state with one incident schedule dependency.
 *
 * @param workspaceId - Workspace owning the dependency graph.
 * @param targetRevision - Current revision of the dependency target.
 * @returns In-memory Planning client containing the incident edge.
 */
async function createIncidentSchedulePlanning(
  workspaceId: string,
  targetRevision = 1,
) {
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  await planning.createWorkItemDependency(workspaceId, {
    id: `incident-dependency-${targetRevision}`,
    predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'core-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 0,
  }, {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: targetRevision,
        teamId: 'core-team',
        title: 'Dependency target',
        projectId: 'refero',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 1,
        teamId: 'core-team',
        title: 'Dependency successor',
        projectId: 'refero',
        statusCategory: 'started',
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  })
  return planning
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
    async getAutomationDefinitionRevision() {
      return 0
    },
    createAutomationDefinitionRevisionConditionCheck(workspaceId) {
      return {
        ConditionCheck: {
          TableName: 'AutomationTable',
          Key: {
            recordKey: 'AUTOMATION_DEFINITION_REVISION',
            scopeKey: `${workspaceId}#automation`,
          },
          ConditionExpression: 'attribute_not_exists(scopeKey)',
        },
      }
    },
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
    /**
     * Reports that no Triage delivery was accepted for the request.
     *
     * @returns Undefined.
     */
    async resolveAcceptedTriageWebhookDelivery() {
      // Most tests send no delivery to an inactive endpoint, so none was accepted.
      return undefined
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

test('rejects guests from Workspace-wide Automation reads before reading any definition', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'guest' })
  setTestAppDependencies({
    executions: createAutomationExecutionPort({
      listExecutions: unexpectedAutomationPortCall,
    }),
  })

  for (const path of [
    '/api/automation/rules',
    '/api/automation/templates',
    '/api/recurring-work',
    '/api/automation/executions',
  ]) {
    const response = await app.request(path, { headers: { Authorization: 'Bearer test-token' } })
    expect({ path, status: response.status }).toEqual({ path, status: 403 })
    expect(await response.json()).toMatchObject({ code: 'WorkspaceRoleDenied' })
  }
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

test('fences a bulk Project move with the Planning revision', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [
      { teamId: 'core-team', projectId: 'refero', role: 'manager' },
      { teamId: 'core-team', projectId: 'project-2', role: 'manager' },
    ],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'project-2', name: 'Project 2', tone: 'green' },
    ],
  })
  const automationFake = createBulkOperationAutomationFake()
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    planning: new InMemoryPlanningClient(),
  })
  const request = {
    action: { type: 'move', targetProjectId: 'project-2' },
    items: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      expectedRevision: 1,
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
  const preview: unknown = await previewResponse.json()
  if (
    typeof preview !== 'object' ||
    preview === null ||
    !('operationToken' in preview) ||
    typeof preview.operationToken !== 'string'
  ) {
    throw new Error('Expected a bulk operation token.')
  }
  const applyResponse = await app.request('/api/bulk-operations', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, operationToken: preview.operationToken }),
  })

  expect(previewResponse.status).toBe(200)
  expect(applyResponse.status).toBe(201)
  expect(await applyResponse.json()).toMatchObject({ status: 'succeeded' })
  expect(calls.issueUpdates).toHaveLength(1)
  expect(calls.issueUpdates[0]?.authorizationSnapshot).toMatchObject({ planningRevision: 0 })
})

test('fences bulk Project-move undo with the Planning revision', async () => {
  const calls = configureFakeProjectClients(true, {
    detailAssignedProjectId: 'project-2',
    detailRevisions: { ['core-team\0onboarding-friction']: 2 },
    projectAccesses: [
      { teamId: 'core-team', projectId: 'refero', role: 'manager' },
      { teamId: 'core-team', projectId: 'project-2', role: 'manager' },
    ],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'project-2', name: 'Project 2', tone: 'green' },
    ],
  })
  const operation: BulkOperation = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'bulk-project-move-undo',
    workspaceId: 'user#demo@example.com',
    actorMemberKey: 'demo@example.com',
    revision: 1,
    status: 'succeeded',
    action: { type: 'move', targetProjectId: 'project-2' },
    items: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      expectedRevision: 1,
      resultingRevision: 2,
      status: 'succeeded',
      retryable: false,
      undoable: true,
      undoPayload: { assignedProjectId: 'refero' },
    }],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:01:00.000Z',
  }
  const automationFake = createBulkOperationAutomationFake(operation)
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    planning: new InMemoryPlanningClient(),
  })

  const response = await app.request(`/api/bulk-operations/${operation.id}/undo`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
  })

  expect(response.status).toBe(200)
  expect(calls.issueUpdates).toHaveLength(1)
  expect(calls.issueUpdates[0]?.authorizationSnapshot).toMatchObject({ planningRevision: 0 })
})

test('rejects bulk archive preview while an incident schedule dependency exists', async () => {
  const calls = configureFakeProjectClients(true, { teamIssueCount: 2 })
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'core-team',
        title: 'Archive target',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 1,
        teamId: 'core-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  }
  await planning.createWorkItemDependency('user#demo@example.com', {
    id: 'archive-dependency',
    predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'core-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 0,
  }, workItemState)
  setTestAppDependencies({ planning })

  const response = await app.request('/api/bulk-operations/preview', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: { type: 'archive', archived: true },
      items: [{
        teamId: 'core-team',
        workItemId: 'onboarding-friction',
        expectedRevision: 1,
      }],
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    canApply: false,
    items: [{
      status: 'failed',
      errorCode: 'PlanningWorkItemDependencyInUse',
      retryable: false,
    }],
  })
  expect(calls.issueUpdates).toEqual([])
})

test('rejects bulk archive when a dependency is created after its incident-edge check', async () => {
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'core-team',
        title: 'Archive target',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 1,
        teamId: 'core-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  }
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    async issueUpdateHook({ authorizationSnapshot }) {
      expect(authorizationSnapshot?.planningRevision).toBe(0)
      await planning.createWorkItemDependency('user#demo@example.com', {
        id: 'archive-race-dependency',
        predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
        successor: { teamId: 'core-team', workItemId: 'work-item-1' },
        type: 'finish-to-finish',
        lagDays: 0,
        expectedRevision: 0,
      }, workItemState)
      throw createWorkItemAuthorizationChangedError()
    },
  })
  const automationFake = createBulkOperationAutomationFake()
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    planning,
  })
  const request = {
    action: { type: 'archive', archived: true },
    items: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      expectedRevision: 1,
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
  const preview = await previewResponse.json() as { operationToken: string }
  expect(previewResponse.status).toBe(200)

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
      errorCode: 'WorkItemAuthorizationChanged',
      retryable: false,
    }],
  })
  expect(calls.issueUpdates).toEqual([])
})

test('releases the active Agent Run of a Work Item in the same write that archives it', async () => {
  const agentRuns = new InMemoryAgentRunStore()
  const run = createActiveAgentRun({
    directoryId: 'user#demo@example.com',
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    assigneeUserId: 'demo@example.com',
    start: readStartAgentRunRequest({
      expectedRevision: 1,
      workflowStatusId: 'in-progress',
      runtime: 'codex',
      agentName: 'Codex',
      instanceId: 'laptop-1',
    }),
    credentialId: 'agent-key',
    startRevision: 2,
    leaseMinutes: 30,
    now: new Date(),
  })
  agentRuns.seed(run)
  configureFakeProjectClients(true, {
    teamIssueCount: 2,
    issueUpdateHook({ agentRunTransactItems }) {
      agentRuns.applyTransactItems(agentRunTransactItems ?? [])
    },
  })
  const planning = new InMemoryPlanningClient()
  const automationFake = createBulkOperationAutomationFake()
  setTestAppDependencies({ agentRuns, bulkOperations: automationFake.client, planning })
  const request = {
    action: { type: 'archive', archived: true },
    items: [{ teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 }],
  }
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
  const previewResponse = await app.request('/api/bulk-operations/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })
  const preview: unknown = await previewResponse.json()
  const operationToken = typeof preview === 'object' && preview !== null && 'operationToken' in preview
    ? preview.operationToken
    : undefined
  expect(operationToken).toBeString()
  const applyResponse = await app.request('/api/bulk-operations', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, operationToken }),
  })

  expect(applyResponse.status).toBe(201)
  expect(await applyResponse.json()).toMatchObject({ status: 'succeeded' })
  expect(agentRuns.state.claims.size).toBe(0)
  // An archived Work Item can be restored, so the released instance stays revoked.
  expect(agentRuns.state.revocations.size).toBe(1)
  expect(await agentRuns.getRun('user#demo@example.com', 'core-team', run.runId))
    .toMatchObject({ state: 'finished', outcome: 'released', finishedBy: 'demo@example.com' })
})

/**
 * Previews and applies one bulk archive or restore request through the HTTP API.
 *
 * @param request - Bulk archive request without its operation token.
 * @returns The preview body and, when the preview could apply, the applied operation body.
 */
async function previewAndApplyBulkArchive(request: {
  action: { type: 'archive', archived: boolean }
  items: { teamId: string, workItemId: string, expectedRevision: number }[]
}): Promise<{ preview: unknown, operation?: unknown }> {
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
  const previewResponse = await app.request('/api/bulk-operations/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })
  expect(previewResponse.status).toBe(200)
  const preview: unknown = await previewResponse.json()
  if (
    typeof preview !== 'object' || preview === null ||
    !('canApply' in preview) || preview.canApply !== true ||
    !('operationToken' in preview)
  ) {
    return { preview }
  }
  const applyResponse = await app.request('/api/bulk-operations', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, operationToken: preview.operationToken }),
  })
  expect(applyResponse.status).toBe(201)
  return { preview, operation: await applyResponse.json() }
}

test('refuses to archive a parent while one of its children is not archived', async () => {
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    workItemRelations: [{
      sourceWorkItemId: 'onboarding-friction',
      type: 'child',
      targetWorkItemId: 'child-work-item',
    }],
  })
  setTestAppDependencies({
    bulkOperations: createBulkOperationAutomationFake().client,
    planning: new InMemoryPlanningClient(),
  })

  const { preview } = await previewAndApplyBulkArchive({
    action: { type: 'archive', archived: true },
    items: [{ teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 }],
  })

  expect(preview).toMatchObject({
    canApply: false,
    items: [{ status: 'failed', errorCode: 'WorkItemActiveChildren', retryable: true }],
  })
  expect(calls.issueUpdates).toEqual([])
})

test('archives a parent whose children are archived and fences the graph and child restores', async () => {
  const configurationConditionChecks: unknown[] = []
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    detailArchivedIssueIds: ['child-work-item'],
    workItemRelationGraphRevision: 7,
    workItemRelations: [{
      sourceWorkItemId: 'onboarding-friction',
      type: 'child',
      targetWorkItemId: 'child-work-item',
    }],
    issueUpdateHook(input) {
      configurationConditionChecks.push(...input.configurationConditionChecks ?? [])
    },
  })
  setTestAppDependencies({
    bulkOperations: createBulkOperationAutomationFake().client,
    planning: new InMemoryPlanningClient(),
  })

  const { operation } = await previewAndApplyBulkArchive({
    action: { type: 'archive', archived: true },
    items: [{ teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 }],
  })

  expect(operation).toMatchObject({ status: 'succeeded' })
  expect(calls.issueUpdates.map((update) => update.issueId)).toEqual(['onboarding-friction'])
  expect(configurationConditionChecks).toEqual([
    expect.objectContaining({ ConditionCheck: expect.objectContaining({
      Key: expect.objectContaining({ recordKey: 'RELATION_GRAPH' }),
      ExpressionAttributeValues: expect.objectContaining({ ':expectedRevision': 7 }),
    }) }),
    expect.objectContaining({ ConditionCheck: expect.objectContaining({
      Key: expect.objectContaining({ recordKey: 'CHILD_RESTORE#onboarding-friction' }),
      ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    }) }),
  ])
})

test('archives a parent with more children than one Bulk request holds using a fixed number of fences', async () => {
  const childIds = Array.from({ length: 200 }, (_, index) => `child-${index}`)
  const configurationConditionChecks: unknown[] = []
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    detailArchivedIssueIds: childIds,
    childRestoreGeneration: 3,
    workItemRelations: childIds.map((childId) => ({
      sourceWorkItemId: 'onboarding-friction',
      type: 'child' as const,
      targetWorkItemId: childId,
    })),
    issueUpdateHook(input) {
      configurationConditionChecks.push(...input.configurationConditionChecks ?? [])
    },
  })
  setTestAppDependencies({
    bulkOperations: createBulkOperationAutomationFake().client,
    planning: new InMemoryPlanningClient(),
  })

  const { operation } = await previewAndApplyBulkArchive({
    action: { type: 'archive', archived: true },
    items: [{ teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 }],
  })

  expect(operation).toMatchObject({ status: 'succeeded' })
  expect(calls.issueUpdates.map((update) => update.issueId)).toEqual(['onboarding-friction'])
  expect(configurationConditionChecks).toHaveLength(2)
  expect(configurationConditionChecks[1]).toMatchObject({
    ConditionCheck: {
      Key: { recordKey: 'CHILD_RESTORE#onboarding-friction' },
      ConditionExpression: '#entryType = :entryType AND #schemaVersion = :schemaVersion AND #generation = :expectedGeneration',
      ExpressionAttributeValues: { ':expectedGeneration': 3 },
    },
  })
})

test('keeps a hierarchy fence failure retryable so an explicit retry checks the hierarchy again', async () => {
  let failFence = true
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    detailArchivedIssueIds: ['child-work-item'],
    workItemRelations: [{
      sourceWorkItemId: 'onboarding-friction',
      type: 'child',
      targetWorkItemId: 'child-work-item',
    }],
    issueUpdateHook() {
      if (failFence) {
        throw new ProjectDataError(
          409,
          'WorkItemConfigurationRevisionConflict',
          'Work Item configuration changed during the mutation.',
        )
      }
    },
  })
  setTestAppDependencies({
    bulkOperations: createBulkOperationAutomationFake().client,
    planning: new InMemoryPlanningClient(),
  })

  const { operation } = await previewAndApplyBulkArchive({
    action: { type: 'archive', archived: true },
    items: [{ teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 }],
  })

  expect(operation).toMatchObject({
    status: 'failed',
    items: [{ status: 'failed', errorCode: 'WorkItemHierarchyChanged', retryable: true }],
  })
  if (!operation || typeof operation !== 'object' || !('id' in operation) || typeof operation.id !== 'string') {
    throw new Error('expected a stored Bulk operation')
  }
  failFence = false
  const retried = await app.request(`/api/bulk-operations/${operation.id}/retry`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
  })
  expect(retried.status).toBe(200)
  expect(await retried.json()).toMatchObject({ status: 'succeeded', items: [{ status: 'succeeded' }] })
  expect(calls.issueUpdates.map((update) => update.issueId)).toEqual(['onboarding-friction'])
})

test('restores a child under an active parent and records the restore on the parent', async () => {
  const configurationConditionChecks: unknown[] = []
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    childRestoreGeneration: 2,
    detailArchivedIssueIds: ['onboarding-friction'],
    workItemRelations: [{
      sourceWorkItemId: 'onboarding-friction',
      type: 'parent',
      targetWorkItemId: 'parent-work-item',
    }],
    issueUpdateHook(input) {
      configurationConditionChecks.push(...input.configurationConditionChecks ?? [])
    },
  })
  setTestAppDependencies({
    bulkOperations: createBulkOperationAutomationFake().client,
    planning: new InMemoryPlanningClient(),
  })

  const { operation } = await previewAndApplyBulkArchive({
    action: { type: 'archive', archived: false },
    items: [{ teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 }],
  })

  expect(operation).toMatchObject({ status: 'succeeded' })
  expect(calls.issueUpdates.map((update) => update.issueId)).toEqual(['onboarding-friction'])
  expect(configurationConditionChecks).toHaveLength(3)
  expect(configurationConditionChecks[1]).toMatchObject({
    ConditionCheck: { Key: { issueId: 'parent-work-item' } },
  })
  expect(configurationConditionChecks[2]).toMatchObject({
    Update: {
      Key: { recordKey: 'CHILD_RESTORE#parent-work-item' },
      UpdateExpression: 'SET #generation = :nextGeneration',
      ExpressionAttributeValues: { ':expectedGeneration': 2, ':nextGeneration': 3 },
    },
  })
})

test('archives a parent together with its active child by archiving the child first', async () => {
  const archivedIds: string[] = []
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    detailArchivedIssueIds: archivedIds,
    workItemRelations: [
      { sourceWorkItemId: 'onboarding-friction', type: 'child', targetWorkItemId: 'child-work-item' },
      { sourceWorkItemId: 'child-work-item', type: 'parent', targetWorkItemId: 'onboarding-friction' },
    ],
    issueUpdateHook(input) {
      archivedIds.push(input.issueId)
    },
  })
  setTestAppDependencies({
    bulkOperations: createBulkOperationAutomationFake().client,
    planning: new InMemoryPlanningClient(),
  })

  const { operation } = await previewAndApplyBulkArchive({
    action: { type: 'archive', archived: true },
    items: [
      { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 },
      { teamId: 'core-team', workItemId: 'child-work-item', expectedRevision: 1 },
    ],
  })

  expect(operation).toMatchObject({ status: 'succeeded' })
  expect(calls.issueUpdates.map((update) => update.issueId))
    .toEqual(['child-work-item', 'onboarding-friction'])
})

test('keeps the parent active when its child fails in the same archive operation', async () => {
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    workItemRelations: [
      { sourceWorkItemId: 'onboarding-friction', type: 'child', targetWorkItemId: 'child-work-item' },
      { sourceWorkItemId: 'child-work-item', type: 'parent', targetWorkItemId: 'onboarding-friction' },
    ],
    issueUpdateHook(input) {
      if (input.issueId === 'child-work-item') {
        throw new ProjectDataError(409, 'WorkItemRevisionConflict', 'Work Item changed after it was selected.')
      }
    },
  })
  setTestAppDependencies({
    bulkOperations: createBulkOperationAutomationFake().client,
    planning: new InMemoryPlanningClient(),
  })

  const { operation } = await previewAndApplyBulkArchive({
    action: { type: 'archive', archived: true },
    items: [
      { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 },
      { teamId: 'core-team', workItemId: 'child-work-item', expectedRevision: 1 },
    ],
  })

  expect(operation).toMatchObject({
    status: 'failed',
    items: [
      { workItemId: 'onboarding-friction', status: 'failed', errorCode: 'WorkItemActiveChildren', retryable: true },
      { workItemId: 'child-work-item', status: 'failed' },
    ],
  })
  expect(calls.issueUpdates).toEqual([])
})

test('restores a child together with its archived parent by restoring the parent first', async () => {
  const archivedIds = ['onboarding-friction', 'parent-work-item']
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    detailArchivedIssueIds: archivedIds,
    workItemRelations: [
      { sourceWorkItemId: 'onboarding-friction', type: 'parent', targetWorkItemId: 'parent-work-item' },
      { sourceWorkItemId: 'parent-work-item', type: 'child', targetWorkItemId: 'onboarding-friction' },
    ],
    issueUpdateHook(input) {
      archivedIds.splice(archivedIds.indexOf(input.issueId), 1)
    },
  })
  setTestAppDependencies({
    bulkOperations: createBulkOperationAutomationFake().client,
    planning: new InMemoryPlanningClient(),
  })

  const { operation } = await previewAndApplyBulkArchive({
    action: { type: 'archive', archived: false },
    items: [
      { teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 },
      { teamId: 'core-team', workItemId: 'parent-work-item', expectedRevision: 1 },
    ],
  })

  expect(operation).toMatchObject({ status: 'succeeded' })
  expect(calls.issueUpdates.map((update) => update.issueId))
    .toEqual(['parent-work-item', 'onboarding-friction'])
})

test('refuses to restore a child while its parent is archived', async () => {
  const calls = configureFakeProjectClients(true, {
    teamIssueCount: 2,
    detailArchivedIssueIds: ['onboarding-friction', 'parent-work-item'],
    workItemRelations: [{
      sourceWorkItemId: 'onboarding-friction',
      type: 'parent',
      targetWorkItemId: 'parent-work-item',
    }],
  })
  setTestAppDependencies({
    bulkOperations: createBulkOperationAutomationFake().client,
    planning: new InMemoryPlanningClient(),
  })

  const { preview } = await previewAndApplyBulkArchive({
    action: { type: 'archive', archived: false },
    items: [{ teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 }],
  })

  expect(preview).toMatchObject({
    canApply: false,
    items: [{ status: 'failed', errorCode: 'WorkItemParentArchived', retryable: true }],
  })
  expect(calls.issueUpdates).toEqual([])
})

test('refuses a bulk undo that would restore a child while its parent stays archived', async () => {
  const calls = configureFakeProjectClients(true, {
    detailRevisions: { ['core-team\0onboarding-friction']: 2 },
    detailArchivedIssueIds: ['onboarding-friction', 'parent-work-item'],
    teamIssueCount: 2,
    workItemRelations: [{
      sourceWorkItemId: 'onboarding-friction',
      type: 'parent',
      targetWorkItemId: 'parent-work-item',
    }],
  })
  const operation: BulkOperation = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'bulk-archive-undo-parent',
    workspaceId: 'user#demo@example.com',
    actorMemberKey: 'demo@example.com',
    revision: 1,
    status: 'succeeded',
    action: { type: 'archive', archived: true },
    items: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      expectedRevision: 1,
      resultingRevision: 2,
      status: 'succeeded',
      retryable: false,
      undoable: true,
      undoPayload: { archivedAt: null, archivedBy: null },
    }],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:01:00.000Z',
  }
  setTestAppDependencies({
    bulkOperations: createBulkOperationAutomationFake(operation).client,
    planning: new InMemoryPlanningClient(),
  })

  const response = await app.request(`/api/bulk-operations/${operation.id}/undo`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
  })

  expect(response.status).toBe(200)
  // The undo stays available, so it can run again once the parent is restored.
  expect(await response.json()).toMatchObject({
    status: 'partial',
    items: [{ status: 'succeeded', errorCode: 'WorkItemParentArchived', retryable: true, undoable: true }],
  })
  expect(calls.issueUpdates).toEqual([])
})

test('rejects bulk undo that would re-archive a Work Item with a dependency', async () => {
  const calls = configureFakeProjectClients(true, {
    detailRevisions: { ['core-team\0onboarding-friction']: 2 },
    teamIssueCount: 2,
  })
  const planning = new InMemoryPlanningClient()
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const workItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 2,
        teamId: 'core-team',
        title: 'Archive target',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
      {
        id: 'work-item-1',
        revision: 1,
        teamId: 'core-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule,
      },
    ],
  }
  await planning.createWorkItemDependency('user#demo@example.com', {
    id: 'archive-undo-dependency',
    predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'core-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 0,
  }, workItemState)
  const operation: BulkOperation = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'bulk-unarchive-undo',
    workspaceId: 'user#demo@example.com',
    actorMemberKey: 'demo@example.com',
    revision: 1,
    status: 'succeeded',
    action: { type: 'archive', archived: false },
    items: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      expectedRevision: 1,
      resultingRevision: 2,
      status: 'succeeded',
      retryable: false,
      undoable: true,
      undoPayload: {
        archivedAt: '2026-07-16T00:00:00.000Z',
        archivedBy: 'demo@example.com',
      },
    }],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:01:00.000Z',
  }
  const automationFake = createBulkOperationAutomationFake(operation)
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    planning,
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
      errorCode: 'PlanningWorkItemDependencyInUse',
      resultingRevision: 2,
      retryable: false,
    }],
  })
  expect(calls.issueUpdates).toEqual([])
})

test('rejects bulk schedule preview while an incident dependency exists', async () => {
  const calls = configureFakeProjectClients(true, { teamIssueCount: 2 })
  setTestAppDependencies({
    planning: await createIncidentSchedulePlanning('user#demo@example.com'),
  })

  const response = await app.request('/api/bulk-operations/preview', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: {
        type: 'edit',
        patch: {
          schedule: createDefaultDueDateWorkItemSchedule('2026-06-24'),
        },
      },
      items: [{
        teamId: 'core-team',
        workItemId: 'onboarding-friction',
        expectedRevision: 1,
      }],
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    canApply: false,
    items: [{
      status: 'failed',
      errorCode: 'WorkItemScheduleConfirmationRequired',
      retryable: false,
    }],
  })
  expect(calls.issueUpdates).toEqual([])
})

test('rechecks schedule dependencies when retrying a Bulk edit', async () => {
  const schedule = createDefaultDueDateWorkItemSchedule('2026-06-24')
  const operation: BulkOperation = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'bulk-schedule-retry',
    workspaceId: 'user#demo@example.com',
    actorMemberKey: 'demo@example.com',
    revision: 1,
    status: 'partial',
    action: { type: 'edit', patch: { schedule } },
    items: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      expectedRevision: 1,
      status: 'failed',
      errorCode: 'WorkItemAuthorizationChanged',
      errorMessage: 'Planning changed during the first attempt.',
      retryable: true,
      undoable: false,
      undoPayload: {
        schedule: createDefaultDueDateWorkItemSchedule('2026-06-18'),
      },
    }],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:01:00.000Z',
  }
  const calls = configureFakeProjectClients(true, { teamIssueCount: 2 })
  const automationFake = createBulkOperationAutomationFake(operation)
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    planning: await createIncidentSchedulePlanning('user#demo@example.com'),
  })

  const response = await app.request(`/api/bulk-operations/${operation.id}/retry`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    status: 'failed',
    items: [{
      status: 'failed',
      errorCode: 'WorkItemScheduleConfirmationRequired',
      retryable: false,
    }],
  })
  expect(calls.issueUpdates).toEqual([])
})

test('rechecks schedule dependencies before undoing a Bulk edit', async () => {
  const previousSchedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const operation: BulkOperation = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'bulk-schedule-undo',
    workspaceId: 'user#demo@example.com',
    actorMemberKey: 'demo@example.com',
    revision: 1,
    status: 'succeeded',
    action: {
      type: 'edit',
      patch: {
        schedule: createDefaultDueDateWorkItemSchedule('2026-06-24'),
      },
    },
    items: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      expectedRevision: 1,
      resultingRevision: 2,
      status: 'succeeded',
      retryable: false,
      undoable: true,
      undoPayload: { schedule: previousSchedule },
    }],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:01:00.000Z',
  }
  const calls = configureFakeProjectClients(true, {
    detailRevisions: { ['core-team\0onboarding-friction']: 2 },
    detailSchedule: createDefaultDueDateWorkItemSchedule('2026-06-24'),
    teamIssueCount: 2,
  })
  const automationFake = createBulkOperationAutomationFake(operation)
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    planning: await createIncidentSchedulePlanning('user#demo@example.com', 2),
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
      errorCode: 'WorkItemScheduleConfirmationRequired',
      resultingRevision: 2,
      retryable: false,
    }],
  })
  expect(calls.issueUpdates).toEqual([])
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
  const previousAuditTable = process.env.AUDIT_EVENTS_TABLE_NAME
  process.env.AUDIT_EVENTS_TABLE_NAME = 'AuditTable'
  try {
    let resolvedEndpoint = createInboundWebhookEndpointRecord()
    let deliveryInput:
      | Parameters<TestAutomationInboundWebhookPort['recordInboundWebhookDelivery']>[1]
      | undefined
    const signingSecret = Buffer.from('server-issued-secret', 'utf8')
    const secretReads: unknown[] = []
    const activeWorkspaces: string[] = []
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
      tenantLifecycleEnforcement: {
        async assertActive(workspaceId) {
          activeWorkspaces.push(workspaceId)
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
    expect(activeWorkspaces).toEqual([resolvedEndpoint.workspaceId])

    resolvedEndpoint = { ...resolvedEndpoint, status: 'paused' }
    expect((await request()).status).toBe(423)
    resolvedEndpoint = { ...resolvedEndpoint, status: 'provisioning' }
    expect((await request()).status).toBe(404)
  } finally {
    if (previousAuditTable === undefined) delete process.env.AUDIT_EVENTS_TABLE_NAME
    else process.env.AUDIT_EVENTS_TABLE_NAME = previousAuditTable
  }
})

test('reads Triage recovery markers only for Triage endpoints or unresolved IDs', async () => {
  const previousAuditTable = process.env.AUDIT_EVENTS_TABLE_NAME
  process.env.AUDIT_EVENTS_TABLE_NAME = 'AuditTable'
  try {
    let resolvedEndpoint: ReturnType<typeof createInboundWebhookEndpointRecord> | undefined =
      createInboundWebhookEndpointRecord()
    const recoveryReads: string[] = []
    const signingSecret = Buffer.from('server-issued-secret', 'utf8')
    setTestAppDependencies({
      inboundWebhooks: createAutomationInboundWebhookPort({
        /**
         * Resolves the endpoint configured by the test.
         *
         * @returns A copy of the current endpoint.
         */
        async resolveInboundWebhookEndpoint() {
          return structuredClone(resolvedEndpoint)
        },
        /**
         * Records the recovery-marker lookup and reports no accepted delivery.
         *
         * @param opaqueEndpointId - Opaque endpoint ID being looked up.
         * @returns Undefined.
         */
        async resolveAcceptedTriageWebhookDelivery(opaqueEndpointId) {
          recoveryReads.push(opaqueEndpointId)
          return undefined
        },
        /**
         * Records a new delivery.
         *
         * @param _endpoint - Endpoint receiving the delivery.
         * @param input - Delivery input.
         * @returns A non-replayed delivery result.
         */
        async recordInboundWebhookDelivery(_endpoint, input) {
          return { eventId: input.eventId, replayed: false }
        },
      }),
      automationInboundWebhookSecrets: {
        /** Fails because public delivery must not provision a secret. */
        async provision() {
          throw new Error('Public delivery must not provision a secret.')
        },
        /**
         * Returns the signing secret.
         *
         * @returns The signing secret.
         */
        async get() {
          return signingSecret
        },
        /** Fails because public delivery must not delete a secret. */
        async delete() {
          throw new Error('Public delivery must not delete a secret.')
        },
      },
      tenantLifecycleEnforcement: {
        /** Accepts the tenant as active. */
        async assertActive() {},
      },
    })
    const rawBody = '{"message":"deploy"}'
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const signature = `sha256=${createHmac('sha256', signingSecret)
      .update(`${timestamp}.`, 'utf8')
      .update(rawBody, 'utf8')
      .digest('hex')}`
    /**
     * Sends a signed delivery to the test endpoint's opaque ID.
     *
     * @returns The response.
     */
    const request = () => app.request(`/api/automation/inbound-webhooks/${'A'.repeat(43)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'sender-delivery-1',
        'X-Mukuroji-Signature': signature,
        'X-Mukuroji-Timestamp': timestamp,
      },
      body: rawBody,
    })

    // Automation endpoints never leave recovery markers, so no delivery state reads one.
    expect((await request()).status).toBe(202)
    resolvedEndpoint = createInboundWebhookEndpointRecord({ status: 'paused' })
    expect((await request()).status).toBe(423)
    expect(recoveryReads).toEqual([])

    // Revocation deletes the public lookup, so an unresolved ID still checks for recovery.
    resolvedEndpoint = undefined
    expect((await request()).status).toBe(404)
    expect(recoveryReads).toEqual(['A'.repeat(43)])
  } finally {
    if (previousAuditTable === undefined) delete process.env.AUDIT_EVENTS_TABLE_NAME
    else process.env.AUDIT_EVENTS_TABLE_NAME = previousAuditTable
  }
})

test('maps inbound webhook public validation failures without Cognito authentication', async () => {
  const endpoint = createInboundWebhookEndpointRecord()
  let lifecycleChecks = 0
  setTestAppDependencies({
    inboundWebhooks: createAutomationInboundWebhookPort({
      async resolveInboundWebhookEndpoint(opaqueEndpointId) {
        return opaqueEndpointId === endpoint.opaqueEndpointId ? endpoint : undefined
      },
    }),
    tenantLifecycleEnforcement: {
      async assertActive() {
        lifecycleChecks += 1
      },
    },
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
  expect(lifecycleChecks).toBe(0)
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

test('fences isolated automation schedule updates and rejects dependency races', async () => {
  const currentSchedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
  const nextSchedule = createDefaultDueDateWorkItemSchedule('2026-07-31')
  const workItemState = {
    workItems: [
      {
        id: 'onboarding-friction',
        revision: 1,
        teamId: 'core-team',
        title: 'Automation target',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule: currentSchedule,
      },
      {
        id: 'work-item-1',
        revision: 1,
        teamId: 'core-team',
        title: 'Successor',
        projectId: 'refero',
        statusCategory: 'started' as const,
        dueDate: '2026-06-18',
        schedule: currentSchedule,
      },
    ],
  }
  const context = {
    execution: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-schedule-fenced',
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
      metadata: { teamId: 'core-team', issueId: 'onboarding-friction' },
    },
    actionIndex: 0,
    idempotencyKey: 'automation-schedule-fenced:action:0000',
  } satisfies AutomationActionExecutionContext
  const action = {
    type: 'update' as const,
    patch: { schedule: nextSchedule },
  }

  let observedPlanningRevision: number | undefined
  const isolatedPlanning = new InMemoryPlanningClient()
  const isolatedCalls = configureFakeProjectClients(true, {
    async issueUpdateHook({ planningRevisionFence }) {
      observedPlanningRevision = planningRevisionFence?.expectedRevision
    },
  })
  setTestAppDependencies({ planning: isolatedPlanning })
  await expect(runWithTestAppDependencies(() =>
    createAutomationActionExecutor().execute(action, context)
  )).resolves.toBeUndefined()
  expect(observedPlanningRevision).toBe(0)
  expect(isolatedCalls.issueUpdates).toHaveLength(1)

  const incidentPlanning = new InMemoryPlanningClient()
  await incidentPlanning.createWorkItemDependency('workspace-1', {
    id: 'automation-schedule-dependency',
    predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'core-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision: 0,
  }, workItemState)
  const incidentCalls = configureFakeProjectClients(true)
  setTestAppDependencies({ planning: incidentPlanning })
  await expect(runWithTestAppDependencies(() =>
    createAutomationActionExecutor().execute(action, context)
  )).rejects.toMatchObject({
    category: 'conflict',
    code: 'WorkItemScheduleConfirmationRequired',
    retryable: false,
  })
  expect(incidentCalls.issueUpdates).toHaveLength(0)

  const racingPlanning = new InMemoryPlanningClient()
  const racingCalls = configureFakeProjectClients(true, {
    async issueUpdateHook({ planningRevisionFence }) {
      expect(planningRevisionFence?.expectedRevision).toBe(0)
      await racingPlanning.createWorkItemDependency('workspace-1', {
        id: 'automation-schedule-race',
        predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
        successor: { teamId: 'core-team', workItemId: 'work-item-1' },
        type: 'finish-to-finish',
        lagDays: 0,
        expectedRevision: 0,
      }, workItemState)
      throw createWorkItemAuthorizationChangedError()
    },
  })
  setTestAppDependencies({ planning: racingPlanning })

  await expect(runWithTestAppDependencies(() =>
    createAutomationActionExecutor().execute(action, context)
  )).rejects.toMatchObject({
    code: 'WorkItemAuthorizationChanged',
    status: 409,
  })
  await expect(runWithTestAppDependencies(() =>
    createAutomationActionExecutor().execute(action, context)
  )).rejects.toMatchObject({
    category: 'conflict',
    code: 'WorkItemScheduleConfirmationRequired',
  })
  expect(racingCalls.issueUpdates).toHaveLength(0)
})

test('fences an Automation Project move with the Planning revision', async () => {
  const calls = configureFakeProjectClients(true, {
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'project-2', name: 'Project 2', tone: 'green' },
    ],
  })
  const planning = new InMemoryPlanningClient()
  setTestAppDependencies({ planning })
  const context = {
    execution: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-project-move-fenced',
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
      metadata: { teamId: 'core-team', issueId: 'onboarding-friction' },
    },
    actionIndex: 0,
    idempotencyKey: 'automation-project-move-fenced:action:0000',
  } satisfies AutomationActionExecutionContext

  await expect(runWithTestAppDependencies(() =>
    createAutomationActionExecutor().execute({
      type: 'move',
      targetProjectId: 'project-2',
    }, context)
  )).resolves.toBeUndefined()

  expect(calls.issueUpdates).toHaveLength(1)
  expect(calls.issueUpdates[0]?.planningRevisionFence).toEqual({ expectedRevision: 0 })
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
  configureFakeProjectClients(true)
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
})

test('writes automation comments to the canonical Collaboration store', async () => {
  configureFakeProjectClients(true)
  const writes: Parameters<CollaborationClient['createComment']>[0][] = []
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async createComment(input) {
        writes.push(input)
        return {
          id: 'automation-comment',
          rootCommentId: 'automation-comment',
          authorMemberKey: input.actorMemberKey,
          bodyMarkdown: input.bodyMarkdown,
          version: 1,
          mentionMemberKeys: input.mentionMemberKeys ?? [],
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
    }),
  })
  const context = {
    execution: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-comment-canonical',
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
      metadata: { teamId: 'core-team', issueId: 'onboarding-friction' },
    },
    actionIndex: 0,
    idempotencyKey: 'automation-comment-canonical:action:0000',
  } satisfies AutomationActionExecutionContext

  await runWithTestAppDependencies(() =>
    createAutomationActionExecutor().execute({
      type: 'comment',
      body: 'Automated canonical comment',
    }, context)
  )

  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    workspaceId: 'workspace-1',
    teamId: 'core-team',
    issueId: 'onboarding-friction',
    entityKey: 'workspace-1#work-item#team/core-team/issue/onboarding-friction',
    projectId: 'refero',
    projectEntityKey: 'workspace-1#project#refero',
    assigneeMemberKey: 'sato@example.com',
    actorMemberKey: 'automation:rule-1',
    bodyMarkdown: 'Automated canonical comment',
    deepLink: expect.stringContaining('/teams/core-team/issues?'),
    authorizationConditionChecks: expect.arrayContaining([
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          TableName: 'DirectoryTable',
          Key: { directoryId: 'workspace-1', entryKey: 'TEAM#core-team' },
        }),
      }),
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          TableName: 'DirectoryTable',
          Key: { directoryId: 'workspace-1', entryKey: 'PROJECT#refero' },
        }),
      }),
    ]),
    auditContext: {
      correlationId: 'automation-comment-canonical',
      idempotencyKeyHash: expect.any(String),
      requestFingerprint: expect.any(String),
    },
  })
})

test('replays an automation comment before checking a changed project assignment', async () => {
  const calls = configureFakeProjectClients(true, { teamProjects: [] })
  let replayLookups = 0
  let createCalls = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCommentMutationReplay(input) {
        replayLookups += 1
        expect(input.entityKey).toBe(
          'workspace-1#work-item#team/core-team/issue/onboarding-friction',
        )
        expect(input.commentId).toBe('automation-comment-replay_comment_0')
        return {
          id: 'replayed-automation-comment',
          rootCommentId: 'replayed-automation-comment',
          authorMemberKey: 'automation:rule-1',
          bodyMarkdown: 'Already committed before the project was archived.',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
      async createComment() {
        createCalls += 1
        throw new Error('A durable replay must not create a second comment.')
      },
    }),
  })
  const context = {
    execution: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-comment-replay',
      workspaceId: 'workspace-1',
      ruleId: 'rule-1',
      ruleVersion: 1,
      triggerEventId: 'event-1',
      status: 'running',
      attempts: 2,
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
      metadata: { teamId: 'core-team', issueId: 'onboarding-friction' },
    },
    actionIndex: 0,
    idempotencyKey: 'automation-comment-replay:action:0000',
  } satisfies AutomationActionExecutionContext

  await expect(runWithTestAppDependencies(() =>
    createAutomationActionExecutor().execute({
      type: 'comment',
      body: 'Already committed before the project was archived.',
    }, context)
  )).resolves.toBeUndefined()

  expect(replayLookups).toBe(1)
  expect(createCalls).toBe(0)
  expect(calls.issueDetails).toHaveLength(0)
})

test('rejects a canonical automation comment replay with different input', async () => {
  configureFakeProjectClients(true)
  let createCalls = 0
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async getCommentMutationReplay() {
        return {
          id: 'replayed-automation-comment',
          rootCommentId: 'replayed-automation-comment',
          authorMemberKey: 'automation:another-rule',
          bodyMarkdown: 'Different comment body',
          version: 1,
          mentionMemberKeys: [],
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
          acceptedResolutions: [],
          reactions: [],
        }
      },
      async createComment() {
        createCalls += 1
        throw new Error('A conflicting replay must not create a comment.')
      },
    }),
  })
  const context = {
    execution: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-comment-replay-conflict',
      workspaceId: 'workspace-1',
      ruleId: 'rule-1',
      ruleVersion: 1,
      triggerEventId: 'event-1',
      status: 'running',
      attempts: 2,
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
      metadata: { teamId: 'core-team', issueId: 'onboarding-friction' },
    },
    actionIndex: 0,
    idempotencyKey: 'automation-comment-replay-conflict:action:0000',
  } satisfies AutomationActionExecutionContext

  await expect(runWithTestAppDependencies(() =>
    createAutomationActionExecutor().execute({
      type: 'comment',
      body: 'Requested comment body',
    }, context)
  )).rejects.toMatchObject({
    code: 'AutomationCommentIdempotencyConflict',
    category: 'conflict',
  })

  expect(createCalls).toBe(0)
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

test('applies a Project template WBS as Work Items with parent links, resumes after a link conflict without undoing Project or Work Item edits, and completes the receipt last', async () => {
  const now = '2026-07-16T00:00:00.000Z'
  const template: AutomationTemplate = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'template-project-wbs',
    workspaceId: 'user#demo@example.com',
    kind: 'project',
    name: 'Standard Project',
    enabled: true,
    version: 1,
    revision: 1,
    payload: {
      nameJa: '標準プロジェクト',
      tone: 'green',
      workItems: [
        {
          title: '要件定義',
          startOffsetWorkingDays: 0,
          durationWorkingDays: 5,
          children: [{ title: 'ヒアリング', startOffsetWorkingDays: 1, durationWorkingDays: 2 }],
        },
        { title: '設計', startOffsetWorkingDays: 5, durationWorkingDays: 3 },
        { title: '保守', startOffsetWorkingDays: 8, durationWorkingDays: 1 },
      ],
    },
    createdAt: now,
    updatedAt: now,
  }
  let application: AutomationTemplateApplication = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'application_project_wbs',
    workspaceId: template.workspaceId,
    actorId: 'demo@example.com',
    templateId: template.id,
    templateVersion: template.version,
    kind: 'project',
    target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-05' },
    status: 'pending',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  const projectInputs: Array<Record<string, unknown>> = []
  const completionMutationCounts: number[] = []
  const createdIssues = new Map<string, ReturnType<typeof createBulkRecoveryIssue>>()
  const createdInputs: Array<Record<string, unknown>> = []
  const placementInputs: Array<Record<string, unknown>> = []
  let placementAttempts = 0
  let movedByUser = false
  const placementAuditKeys: string[] = []
  const currentRanks = new Map([
    ['application_project_wbs_wbs_0', 'm'],
    ['application_project_wbs_wbs_1', 'q'],
    ['application_project_wbs_wbs_2', 'k'],
    ['application_project_wbs_wbs_3', 'n'],
  ])
  const teamProjects: Array<{ id: string; name: string; tone: 'green' }> = []
  configureFakeProjectClients(true, {
    teamProjects,
    async projectCreateHook(input, completionTransactItems) {
      projectInputs.push(input)
      completionMutationCounts.push(completionTransactItems.length)
      teamProjects.push({ id: application.id, name: '標準プロジェクト', tone: 'green' })
    },
  })
  setTestAppDependencies({
    teamIssues: createTeamIssuesFake({
      async createTeamIssue(_directoryId, teamId, input) {
        createdInputs.push({ ...input })
        const id = String(input.idempotencyResourceId)
        const existing = createdIssues.get(id)
        if (existing) throw new Error(`A retry must reuse ${id} instead of creating it again.`)
        const issue = {
          ...createBulkRecoveryIssue(),
          id,
          teamId,
          title: String(input.title),
          assignedProjectId: String(input.assignedProjectId),
        }
        createdIssues.set(id, issue)
        return { issue }
      },
      async getTeamIssueDetail(_directoryId, _teamId, issueId) {
        const issue = createdIssues.get(issueId)
        if (!issue) throw Object.assign(new Error('Work Item not found.'), { status: 404, code: 'TeamIssueNotFound' })
        return { issue, activity: [], comments: [] }
      },
      async getTeamHierarchyEntries() {
        return [...createdIssues.values()].map((issue) => ({
          issue,
          hierarchyRank: currentRanks.get(issue.id) ?? 'z',
        }))
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelationGraph() {
        return {
          relations: movedByUser
            ? [{
                sourceWorkItemId: 'application_project_wbs_wbs_3',
                targetWorkItemId: 'outside-parent',
                type: 'parent' as const,
                createdAt: now,
              }]
            : [],
          graphRevision: 0,
        }
      },
      async replaceParent(workspaceId, _teamId, input, _conditionChecks, audit) {
        expect(audit?.actorMemberKey).toBe('demo@example.com')
        expect(audit?.context.workspaceId).toBe(workspaceId)
        placementAuditKeys.push(String(audit?.context.idempotencyKeyHash))
        placementAttempts += 1
        if (placementAttempts === 1) {
          throw new WorkItemConfigurationError(409, 'WorkItemRelationGraphConflict', 'Work Item relations changed.')
        }
        placementInputs.push(structuredClone(input))
        return {
          previousParentWorkItemId: null,
          parentWorkItemId: input.nextParent?.workItemId ?? null,
          graphRevision: input.expectedGraphRevision + 1,
        }
      },
    }),
    ruleTemplates: createAutomationRuleTemplatePort({
      async reserveTemplateApplication() {
        return structuredClone(application)
      },
      async claimTemplateApplication(candidate, _claimNow, leaseExpiresAt) {
        if (candidate.status !== 'pending' || candidate.revision !== application.revision) return undefined
        application = {
          ...candidate,
          status: 'running',
          revision: candidate.revision + 1,
          runnerLeaseExpiresAt: leaseExpiresAt,
        }
        return structuredClone(application)
      },
      createTemplateApplicationCompletionMutation() {
        throw new Error('A WBS application must not complete inside the Project transaction.')
      },
      async getTemplateApplication() {
        return structuredClone(application)
      },
      async getTemplateVersion() {
        return structuredClone(template)
      },
      async saveTemplateApplication(candidate, expectedRevision) {
        expect(expectedRevision).toBe(application.revision)
        if (candidate.status === 'succeeded') {
          expect(createdIssues.size).toBe(4)
          expect(placementInputs).toHaveLength(3)
        }
        application = structuredClone(candidate)
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
        'Idempotency-Key': 'apply-project-wbs',
      },
      body: JSON.stringify({ target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-05' } }),
    },
  )

  const conflicted = await request()
  expect(conflicted.status).toBe(409)
  expect(await conflicted.json()).toMatchObject({ code: 'AutomationTemplateWorkItemLinkConflict' })
  expect(application.status).toBe('pending')
  expect(createdIssues.size).toBe(4)
  const edited = createdIssues.get('application_project_wbs_wbs_0')
  if (!edited) throw new Error('The first attempt must create the top-level Work Item.')
  createdIssues.set(edited.id, { ...edited, title: '要件定義（編集済み）', revision: edited.revision + 1 })
  movedByUser = true
  const createdProject = teamProjects[0]
  if (!createdProject) throw new Error('The first attempt must create the Project.')
  createdProject.name = '標準プロジェクト（改名済み）'

  const response = await request()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    status: 'succeeded',
    result: { kind: 'project', projectId: application.id, workItemCount: 4 },
  })
  // The retry resumes with the renamed Project instead of replaying its creation.
  expect(projectInputs).toHaveLength(1)
  expect(projectInputs[0]).not.toHaveProperty('workItems')
  expect(completionMutationCounts).toEqual([0])
  expect(createdIssues.size).toBe(4)
  expect(createdInputs.slice(0, 3).map((input) => ({
    id: input.idempotencyResourceId,
    title: input.title,
    assignedProjectId: input.assignedProjectId,
    assigneeUserId: input.assigneeUserId,
    schedule: input.schedule,
  }))).toMatchObject([
    {
      id: 'application_project_wbs_wbs_0',
      title: '要件定義',
      assignedProjectId: application.id,
      assigneeUserId: 'demo@example.com',
      schedule: { mode: 'date-range', startDate: '2026-12-07', endDate: '2026-12-11', durationDays: 5 },
    },
    {
      id: 'application_project_wbs_wbs_1',
      title: 'ヒアリング',
      schedule: { startDate: '2026-12-08', endDate: '2026-12-09', durationDays: 2 },
    },
    {
      id: 'application_project_wbs_wbs_2',
      title: '設計',
      schedule: { startDate: '2026-12-14', endDate: '2026-12-16', durationDays: 3 },
    },
  ])
  expect(createdInputs).toHaveLength(4)
  // Audit event IDs come from the idempotency key, so every placement needs its own.
  expect(new Set(placementAuditKeys).size).toBe(placementAuditKeys.length)
  const topLevelStart = 'k'
  expect(placementInputs).toEqual([
    {
      child: expect.objectContaining({
        workItemId: 'application_project_wbs_wbs_0',
        expectedRevision: edited.revision + 1,
      }),
      expectedGraphRevision: 0,
      hierarchyRank: topLevelStart,
    },
    {
      child: expect.objectContaining({ workItemId: 'application_project_wbs_wbs_1' }),
      nextParent: expect.objectContaining({ workItemId: 'application_project_wbs_wbs_0' }),
      expectedGraphRevision: 1,
      hierarchyRank: createWorkItemHierarchyRankBetween(),
    },
    {
      child: expect.objectContaining({ workItemId: 'application_project_wbs_wbs_2' }),
      expectedGraphRevision: 2,
      hierarchyRank: createWorkItemHierarchyRankBetween(topLevelStart),
    },
  ])
})

/**
 * Builds the in-memory Work Item and Planning fakes a Project template with Planning content uses.
 *
 * @param planning - Planning client the application writes to.
 * @returns Created Work Items keyed by ID.
 */
function configureProjectTemplatePlanningFakes(planning: InMemoryPlanningClient) {
  const createdIssues = new Map<string, ReturnType<typeof createBulkRecoveryIssue>>()
  setTestAppDependencies({
    planning,
    teamIssues: createTeamIssuesFake({
      async createTeamIssue(_directoryId, teamId, input) {
        const id = String(input.idempotencyResourceId)
        const schedule = normalizeWorkItemSchedule(input.schedule)
        if (schedule.mode !== 'date-range') throw new Error('Template Work Items carry a date range.')
        const issue = {
          ...createBulkRecoveryIssue(),
          id,
          teamId,
          title: String(input.title),
          assigneeUserId: 'demo@example.com',
          assignedProjectId: String(input.assignedProjectId),
          schedule,
          dueDate: schedule.endDate,
        }
        createdIssues.set(id, issue)
        return { issue }
      },
      async getTeamIssueDetail(_directoryId, _teamId, issueId) {
        const issue = createdIssues.get(issueId)
        if (!issue) throw Object.assign(new Error('Work Item not found.'), { status: 404, code: 'TeamIssueNotFound' })
        return { issue, activity: [], comments: [] }
      },
      async getTeamIssues(_directoryId, teamId) {
        return { teamId, issues: [...createdIssues.values()] }
      },
      async getTeamHierarchyEntries() {
        return [...createdIssues.values()].map((issue) => ({ issue, hierarchyRank: 'm' }))
      },
    }),
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async listRelationGraph() {
        return { relations: [], graphRevision: 0 }
      },
      async replaceParent(_workspaceId, _teamId, input) {
        return {
          previousParentWorkItemId: null,
          parentWorkItemId: input.nextParent?.workItemId ?? null,
          graphRevision: input.expectedGraphRevision + 1,
        }
      },
    }),
  })
  return createdIssues
}

/**
 * Seeds a Workspace roadmap that template Phases can be placed under.
 *
 * @param planning - Planning client to seed.
 */
async function seedProjectTemplatePlanningRoadmap(planning: InMemoryPlanningClient) {
  const workspaceId = 'user#demo@example.com'
  const base = {
    ownerMemberKey: 'demo@example.com',
    status: 'active' as const,
    health: 'unknown' as const,
    risk: 'none' as const,
    progressMode: 'automatic' as const,
    baseline: { startDate: '2026-12-01', endDate: '2027-03-31' },
    forecast: { startDate: '2026-12-01', endDate: '2027-03-31' },
  }
  await planning.create(workspaceId, { ...base, id: 'portfolio-1', type: 'portfolio', title: 'Portfolio', expectedRevision: 0 }, { workItems: [] })
  await planning.create(workspaceId, {
    ...base,
    id: 'roadmap-1',
    type: 'roadmap',
    title: 'Roadmap',
    parentId: 'portfolio-1',
    expectedRevision: 1,
  }, { workItems: [] })
}

/** Project template with a WBS, two dependencies, a Phase with a Milestone, and a top-level Milestone. */
function createProjectTemplateWithPlanning(): AutomationTemplate {
  const now = '2026-07-16T00:00:00.000Z'
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'template-project-planning',
    workspaceId: 'user#demo@example.com',
    kind: 'project',
    name: 'Planned Project',
    enabled: true,
    version: 2,
    revision: 1,
    payload: {
      nameJa: '計画付きプロジェクト',
      tone: 'blue',
      workItems: [
        {
          title: '要件定義',
          startOffsetWorkingDays: 0,
          durationWorkingDays: 5,
          children: [{ title: 'ヒアリング', startOffsetWorkingDays: 0, durationWorkingDays: 2 }],
        },
        { title: '設計', startOffsetWorkingDays: 5, durationWorkingDays: 3 },
      ],
      dependencies: [
        { predecessor: '1', successor: '2', type: 'finish-to-start', lagDays: 0 },
        { predecessor: '1.1', successor: '2', type: 'start-to-start', lagDays: 1 },
      ],
      phases: [{
        title: '準備',
        startOffsetWorkingDays: 0,
        durationWorkingDays: 5,
        milestones: [{ title: '要件確定', offsetWorkingDays: 4 }],
      }],
      milestones: [{ title: '設計完了', offsetWorkingDays: 7 }],
    },
    createdAt: now,
    updatedAt: now,
  }
}

test('previews a Project template application with dates, counts, and validation errors without writing', async () => {
  const template = createProjectTemplateWithPlanning()
  const planning = new InMemoryPlanningClient()
  await seedProjectTemplatePlanningRoadmap(planning)
  const projectCalls = configureFakeProjectClients(true, { teamProjects: [] })
  const createdIssues = configureProjectTemplatePlanningFakes(planning)
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async getTemplate() {
        return structuredClone(template)
      },
    }),
  })
  const preview = (target: Record<string, unknown>) => app.request(
    `/api/automation/templates/${template.id}/application-previews`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'project', teamId: 'core-team', ...target } }),
    },
  )

  const valid = await preview({ startDate: '2026-12-05', planningParentId: 'roadmap-1' })
  expect(valid.status).toBe(200)
  expect(await valid.json()).toEqual({
    kind: 'project',
    teamId: 'core-team',
    name: '計画付きプロジェクト',
    templateVersion: 2,
    calendarFingerprint: expect.any(String),
    startDate: '2026-12-05',
    endDate: '2026-12-16',
    workItems: [
      { wbsNumber: '1', title: '要件定義', startDate: '2026-12-07', endDate: '2026-12-11' },
      { wbsNumber: '1.1', title: 'ヒアリング', startDate: '2026-12-07', endDate: '2026-12-08' },
      { wbsNumber: '2', title: '設計', startDate: '2026-12-14', endDate: '2026-12-16' },
    ],
    planningEntities: [
      { type: 'phase', title: '準備', startDate: '2026-12-07', endDate: '2026-12-11' },
      { type: 'milestone', title: '要件確定', phaseTitle: '準備', startDate: '2026-12-11', endDate: '2026-12-11' },
      { type: 'milestone', title: '設計完了', startDate: '2026-12-16', endDate: '2026-12-16' },
    ],
    dependencyCount: 2,
    errors: [],
  })

  const missingParent = await preview({ startDate: '2026-12-05' })
  expect((await missingParent.json()).errors).toEqual([
    expect.objectContaining({ code: 'AutomationProjectTemplatePlanningParentRequired' }),
  ])
  const wrongParent = await preview({ startDate: '2026-12-05', planningParentId: 'portfolio-1' })
  expect((await wrongParent.json()).errors).toEqual([
    expect.objectContaining({ code: 'AutomationProjectTemplatePlanningParentInvalid' }),
  ])
  const missingStart = await preview({ planningParentId: 'roadmap-1' })
  expect((await missingStart.json()).errors).toEqual([
    expect.objectContaining({ code: 'AutomationProjectTemplateStartDateRequired' }),
  ])

  // A lag that the WBS dates cannot meet is reported against the dependency.
  template.payload = {
    ...template.payload,
    dependencies: [{ predecessor: '1', successor: '2', type: 'finish-to-start', lagDays: 5 }],
  }
  const conflicted = await preview({ startDate: '2026-12-05', planningParentId: 'roadmap-1' })
  expect((await conflicted.json()).errors).toEqual([
    expect.objectContaining({
      code: 'AutomationProjectTemplateDependencyConflict',
      dependencyNumber: 1,
    }),
  ])

  // A Planning graph without room for the template's rows is reported before anything is created.
  const get = planning.get.bind(planning)
  planning.get = async (...args) => {
    const snapshot = await get(...args)
    return { ...snapshot, capacity: { ...snapshot.capacity, liveRowCount: snapshot.capacity.liveRowCapacity - 1 } }
  }
  const full = await preview({ startDate: '2026-12-05', planningParentId: 'roadmap-1' })
  expect((await full.json()).errors).toContainEqual(expect.objectContaining({ code: 'PlanningCapacityExceeded' }))
  planning.get = get

  expect(createdIssues.size).toBe(0)
  expect(projectCalls.projectCreates).toEqual([])
  expect((await planning.get('user#demo@example.com', { workItems: [] })).entities).toHaveLength(2)
})

test('applies a Project template with Phases, Milestones, and WBS dependencies, and a retry creates nothing twice', async () => {
  const template = createProjectTemplateWithPlanning()
  const now = '2026-07-16T00:00:00.000Z'
  let application: AutomationTemplateApplication = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'application_project_planning',
    workspaceId: template.workspaceId,
    actorId: 'demo@example.com',
    templateId: template.id,
    templateVersion: template.version,
    kind: 'project',
    target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-05', planningParentId: 'roadmap-1' },
    status: 'pending',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  const planning = new InMemoryPlanningClient()
  await seedProjectTemplatePlanningRoadmap(planning)
  const teamProjects: Array<{ id: string; name: string; tone: 'blue' }> = []
  configureFakeProjectClients(true, {
    teamProjects,
    // The applier manages the Project the application creates.
    projectAccesses: [
      { projectId: 'application_project_planning', role: 'manager', teamId: 'core-team' },
      { projectId: 'other-project', role: 'manager', teamId: 'core-team' },
    ],
    async projectCreateHook(_input, completionTransactItems) {
      expect(completionTransactItems).toHaveLength(0)
      projectCreates += 1
      teamProjects.push({ id: application.id, name: '計画付きプロジェクト', tone: 'blue' })
      // The applier loses Workspace administration after the request was authorized.
      demoteApplier = true
    },
  })
  let projectCreates = 0
  const createdIssues = configureProjectTemplatePlanningFakes(planning)
  // Count each create call: the fake's Map would hide a second create of the same ID.
  const issueCreates = new Map<string, number>()
  const teamIssues = getTestAppDependencies().workItems.teamIssues
  setTestAppDependencies({
    teamIssues: {
      ...teamIssues,
      async createTeamIssue(...args) {
        const id = String(args[2].idempotencyResourceId)
        issueCreates.set(id, (issueCreates.get(id) ?? 0) + 1)
        return teamIssues.createTeamIssue(...args)
      },
    },
  })
  let demoteApplier = false
  const workspaceAccess = getTestAppDependencies().workspace.workspaceAccess
  setTestAppDependencies({
    workspaceAccess: {
      ...workspaceAccess,
      async getActiveMember(workspaceId, memberKey) {
        const member = await workspaceAccess.getActiveMember(workspaceId, memberKey)
        return member && demoteApplier ? { ...member, role: 'member' } : member
      },
    },
  })
  let failNextDependency = true
  const createWorkItemDependency = planning.createWorkItemDependency.bind(planning)
  planning.createWorkItemDependency = async (...args) => {
    if (failNextDependency) {
      failNextDependency = false
      throw new PlanningError(409, 'PlanningRevisionConflict', 'Planning changed. Reload and try again.')
    }
    return createWorkItemDependency(...args)
  }
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async reserveTemplateApplication() {
        return structuredClone(application)
      },
      async claimTemplateApplication(candidate, _claimNow, leaseExpiresAt) {
        if (candidate.status !== 'pending' || candidate.revision !== application.revision) return undefined
        application = { ...candidate, status: 'running', revision: candidate.revision + 1, runnerLeaseExpiresAt: leaseExpiresAt }
        return structuredClone(application)
      },
      async getTemplateApplication() {
        return structuredClone(application)
      },
      async getTemplateVersion() {
        return structuredClone(template)
      },
      async saveTemplateApplication(candidate) {
        application = structuredClone(candidate)
      },
    }),
  })
  const request = () => app.request(`/api/automation/templates/${template.id}/applications`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'apply-project-planning',
    },
    body: JSON.stringify({ target: application.target }),
  })

  const demoted = await request()
  expect(await demoted.json()).toMatchObject({ code: 'AutomationTemplatePlanningConflict' })
  expect(demoted.status).toBe(409)
  expect(application.status).toBe('pending')
  expect(failNextDependency).toBe(true)
  demoteApplier = false

  const conflicted = await request()
  expect(await conflicted.json()).toMatchObject({ code: 'AutomationTemplatePlanningConflict' })
  expect(conflicted.status).toBe(409)
  expect(application.status).toBe('pending')
  // Someone moves a created dependency endpoint to another Project of the Team before the retry.
  teamProjects.push({ id: 'other-project', name: '別プロジェクト', tone: 'blue' })
  const moved = createdIssues.get('application_project_planning_wbs_2')
  if (!moved) throw new Error('The first attempt must create the Work Items.')
  createdIssues.set(moved.id, { ...moved, assignedProjectId: 'other-project' })
  // Someone archives a created Milestone before the retry; the retry keeps it archived.
  const beforeArchive = await planning.get('user#demo@example.com', { workItems: [] })
  await planning.archive(
    'user#demo@example.com',
    'application_project_planning_plan_2',
    { expectedRevision: beforeArchive.revision },
    { workItems: [] },
  )

  const response = await request()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    status: 'succeeded',
    result: { workItemCount: 3, planningEntityCount: 3, dependencyCount: 2 },
  })
  expect(projectCreates).toBe(1)
  expect(Object.fromEntries(issueCreates)).toEqual({
    application_project_planning_wbs_0: 1,
    application_project_planning_wbs_1: 1,
    application_project_planning_wbs_2: 1,
  })
  const snapshot = await planning.get('user#demo@example.com', { workItems: [] })
  expect(snapshot.entities
    .filter((entity) => entity.projectId === application.id && entity.archivedAt === undefined)
    .map((entity) => ({
      id: entity.id,
      type: entity.type,
      title: entity.title,
      parentId: entity.parentId,
      teamId: entity.teamId,
      baseline: entity.baseline,
    }))).toEqual([
    {
      id: 'application_project_planning_plan_0',
      type: 'phase',
      title: '準備',
      parentId: 'roadmap-1',
      teamId: 'core-team',
      baseline: { startDate: '2026-12-07', endDate: '2026-12-11' },
    },
    {
      id: 'application_project_planning_plan_1',
      type: 'milestone',
      title: '要件確定',
      parentId: 'application_project_planning_plan_0',
      teamId: 'core-team',
      baseline: { startDate: '2026-12-11', endDate: '2026-12-11' },
    },
  ])
  const withWorkItems = await planning.get('user#demo@example.com', {
    workItems: [...createdIssues.values()].map((issue) => ({
      id: issue.id,
      revision: issue.revision,
      teamId: issue.teamId,
      title: issue.title,
      projectId: application.id,
      statusCategory: issue.statusCategory,
      dueDate: issue.dueDate,
      schedule: issue.schedule,
    })),
  })
  expect(withWorkItems.workItemDependencies.map((dependency) => ({
    id: dependency.id,
    predecessor: dependency.predecessor.workItemId,
    successor: dependency.successor.workItemId,
    type: dependency.type,
    lagDays: dependency.lagDays,
  }))).toEqual([
    {
      id: 'application_project_planning_dep_0',
      predecessor: 'application_project_planning_wbs_0',
      successor: 'application_project_planning_wbs_2',
      type: 'finish-to-start',
      lagDays: 0,
    },
    {
      id: 'application_project_planning_dep_1',
      predecessor: 'application_project_planning_wbs_1',
      successor: 'application_project_planning_wbs_2',
      type: 'start-to-start',
      lagDays: 1,
    },
  ])
})

test('resumes Project template Planning after its Phase moved, leaving the Phase\'s missing Milestone out', async () => {
  const template = createProjectTemplateWithPlanning()
  // Phases and Milestones only, so the retry depends on nothing but Planning.
  template.payload = {
    nameJa: '計画付きプロジェクト',
    tone: 'blue',
    phases: [{
      title: '準備',
      startOffsetWorkingDays: 0,
      durationWorkingDays: 5,
      milestones: [{ title: '要件確定', offsetWorkingDays: 4 }],
    }],
    milestones: [{ title: '設計完了', offsetWorkingDays: 7 }],
  }
  const now = '2026-07-16T00:00:00.000Z'
  let application: AutomationTemplateApplication = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'application_project_phase_moved',
    workspaceId: template.workspaceId,
    actorId: 'demo@example.com',
    templateId: template.id,
    templateVersion: template.version,
    kind: 'project',
    target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-05', planningParentId: 'roadmap-1' },
    status: 'pending',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  const planning = new InMemoryPlanningClient()
  await seedProjectTemplatePlanningRoadmap(planning)
  const teamProjects: Array<{ id: string; name: string; tone: 'blue' }> = []
  configureFakeProjectClients(true, {
    teamProjects,
    projectAccesses: [
      { projectId: 'application_project_phase_moved', role: 'manager', teamId: 'core-team' },
      { projectId: 'other-project', role: 'manager', teamId: 'core-team' },
    ],
    async projectCreateHook() {
      teamProjects.push({ id: application.id, name: '計画付きプロジェクト', tone: 'blue' })
    },
  })
  configureProjectTemplatePlanningFakes(planning)
  // The first attempt stops after creating the Phase, before its Milestone.
  let failMilestone = true
  const create = planning.create.bind(planning)
  planning.create = async (...args) => {
    if (failMilestone && args[1].id === 'application_project_phase_moved_plan_1') {
      failMilestone = false
      throw new PlanningError(409, 'PlanningRevisionConflict', 'Planning changed. Reload and try again.')
    }
    return create(...args)
  }
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async reserveTemplateApplication() {
        return structuredClone(application)
      },
      async claimTemplateApplication(candidate, _claimNow, leaseExpiresAt) {
        if (candidate.status !== 'pending' || candidate.revision !== application.revision) return undefined
        application = { ...candidate, status: 'running', revision: candidate.revision + 1, runnerLeaseExpiresAt: leaseExpiresAt }
        return structuredClone(application)
      },
      async getTemplateApplication() {
        return structuredClone(application)
      },
      async getTemplateVersion() {
        return structuredClone(template)
      },
      async saveTemplateApplication(candidate) {
        application = structuredClone(candidate)
      },
    }),
  })
  const request = () => app.request(`/api/automation/templates/${template.id}/applications`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'apply-project-phase-moved',
    },
    body: JSON.stringify({ target: application.target }),
  })

  const interrupted = await request()
  expect(await interrupted.json()).toMatchObject({ code: 'AutomationTemplatePlanningConflict' })
  expect(application.status).toBe('pending')
  // Someone moves the created Phase to another Project of the Team before the retry.
  teamProjects.push({ id: 'other-project', name: '別プロジェクト', tone: 'blue' })
  const beforeMove = await planning.get('user#demo@example.com', { workItems: [] })
  await planning.move(
    'user#demo@example.com',
    'application_project_phase_moved_plan_0',
    { parentId: 'roadmap-1', teamId: 'core-team', projectId: 'other-project', expectedRevision: beforeMove.revision },
    { workItems: [] },
  )

  const response = await request()
  expect(response.status).toBe(200)
  // The Phase and the top-level Milestone exist; the Phase's Milestone was never created.
  expect(await response.json()).toMatchObject({ status: 'succeeded', result: { planningEntityCount: 2 } })
  const snapshot = await planning.get('user#demo@example.com', { workItems: [] })
  expect(snapshot.entities
    .filter((entity) => entity.id.startsWith('application_project_phase_moved_'))
    .map((entity) => [entity.id, entity.projectId])).toEqual([
    ['application_project_phase_moved_plan_0', 'other-project'],
    ['application_project_phase_moved_plan_2', 'application_project_phase_moved'],
  ])
})

test('treats a Planning parent moved during an existing-entity re-read as a conflict to retry', async () => {
  const template = createProjectTemplateWithPlanning()
  // An archived Phase followed by a top-level Milestone, so Planning goes on after the re-read.
  template.payload = {
    nameJa: '計画付きプロジェクト',
    tone: 'blue',
    phases: [{ title: '準備', startOffsetWorkingDays: 0, durationWorkingDays: 5 }],
    milestones: [{ title: '設計完了', offsetWorkingDays: 7 }],
  }
  const now = '2026-07-16T00:00:00.000Z'
  let application: AutomationTemplateApplication = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'application_project_parent_moved',
    workspaceId: template.workspaceId,
    actorId: 'demo@example.com',
    templateId: template.id,
    templateVersion: template.version,
    kind: 'project',
    target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-05', planningParentId: 'roadmap-1' },
    status: 'pending',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  const planning = new InMemoryPlanningClient()
  await seedProjectTemplatePlanningRoadmap(planning)
  const teamProjects: Array<{ id: string; name: string; tone: 'blue' }> = [
    { id: 'other-project', name: '別プロジェクト', tone: 'blue' },
  ]
  configureFakeProjectClients(true, {
    teamProjects,
    projectAccesses: [
      { projectId: 'application_project_parent_moved', role: 'manager', teamId: 'core-team' },
      { projectId: 'other-project', role: 'manager', teamId: 'core-team' },
    ],
    async projectCreateHook() {
      teamProjects.push({ id: application.id, name: '計画付きプロジェクト', tone: 'blue' })
    },
  })
  configureProjectTemplatePlanningFakes(planning)
  // The Phase's ID is taken by an archive, and the roadmap moves into a Project meanwhile.
  const create = planning.create.bind(planning)
  planning.create = async (...args) => {
    if (args[1].id === 'application_project_parent_moved_plan_0') {
      const current = await planning.get('user#demo@example.com', { workItems: [] })
      await planning.move(
        'user#demo@example.com',
        'roadmap-1',
        { parentId: 'portfolio-1', teamId: 'core-team', projectId: 'other-project', expectedRevision: current.revision },
        { workItems: [] },
      )
      throw new PlanningError(409, 'PlanningEntityExists', 'A Planning entity with this ID already exists.')
    }
    return create(...args)
  }
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async reserveTemplateApplication() {
        return structuredClone(application)
      },
      async claimTemplateApplication(candidate, _claimNow, leaseExpiresAt) {
        if (candidate.status !== 'pending' || candidate.revision !== application.revision) return undefined
        application = { ...candidate, status: 'running', revision: candidate.revision + 1, runnerLeaseExpiresAt: leaseExpiresAt }
        return structuredClone(application)
      },
      async getTemplateApplication() {
        return structuredClone(application)
      },
      async getTemplateVersion() {
        return structuredClone(template)
      },
      async saveTemplateApplication(candidate) {
        application = structuredClone(candidate)
      },
    }),
  })

  const response = await app.request(`/api/automation/templates/${template.id}/applications`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'apply-project-parent-moved',
    },
    body: JSON.stringify({ target: application.target }),
  })

  expect(await response.json()).toMatchObject({ code: 'AutomationTemplatePlanningConflict' })
  expect(application.status).toBe('pending')
  // The top-level Milestone was not created under the moved roadmap.
  const snapshot = await planning.get('user#demo@example.com', { workItems: [] })
  expect(snapshot.entities.some((entity) => entity.id.startsWith('application_project_parent_moved_'))).toBe(false)
})

test('refuses a new Project template application whose accepted preview is stale', async () => {
  const template = createProjectTemplateWithPlanning()
  const planning = new InMemoryPlanningClient()
  await seedProjectTemplatePlanningRoadmap(planning)
  const projectCalls = configureFakeProjectClients(true, { teamProjects: [] })
  configureProjectTemplatePlanningFakes(planning)
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async getTemplate() {
        return structuredClone(template)
      },
      // A new receipt reads the calendar for the version it pins, as the repository does.
      async reserveTemplateApplication(_workspaceId, _actorId, _templateId, _target, _key, readCalendarPolicy) {
        await readCalendarPolicy?.(template.version)
        throw new Error('The stale preview must stop the reservation.')
      },
    }),
  })
  const target = { kind: 'project', teamId: 'core-team', startDate: '2026-12-05', planningParentId: 'roadmap-1' }
  const preview = await app.request(`/api/automation/templates/${template.id}/application-previews`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  })
  const { calendarFingerprint } = await preview.json()
  expect(typeof calendarFingerprint).toBe('string')
  const apply = (expectedPreview: Record<string, unknown>) => app.request(
    `/api/automation/templates/${template.id}/applications`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'apply-stale-preview',
      },
      body: JSON.stringify({ target, expectedPreview }),
    },
  )

  // Another administrator saved a new version after the preview.
  const oldVersion = await apply({ templateVersion: template.version - 1, calendarFingerprint })
  expect(oldVersion.status).toBe(409)
  expect(await oldVersion.json()).toMatchObject({ code: 'AutomationTemplatePreviewStale' })
  // The working calendar changed after the preview.
  const oldCalendar = await apply({ templateVersion: template.version, calendarFingerprint: 'stale' })
  expect(oldCalendar.status).toBe(409)
  expect(await oldCalendar.json()).toMatchObject({ code: 'AutomationTemplatePreviewStale' })
  expect(projectCalls.projectCreates).toEqual([])
})

test('rejects a Project template WBS without a start date or with a denied child type before creating anything', async () => {
  const now = '2026-07-16T00:00:00.000Z'
  const template: AutomationTemplate = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'template-project-wbs-no-date',
    workspaceId: 'user#demo@example.com',
    kind: 'project',
    name: 'Standard Project',
    enabled: true,
    version: 1,
    revision: 1,
    payload: {
      nameJa: '標準プロジェクト',
      workItems: [{ title: '要件定義', startOffsetWorkingDays: 0, durationWorkingDays: 5 }],
    },
    createdAt: now,
    updatedAt: now,
  }
  let application: AutomationTemplateApplication = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'application_project_wbs_no_date',
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
  let projectCreates = 0
  configureFakeProjectClients(true, {
    async projectCreateHook() {
      projectCreates += 1
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
      async getTemplateApplication() {
        return structuredClone(application)
      },
      async getTemplateVersion() {
        return structuredClone(template)
      },
      async saveTemplateApplication(candidate) {
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
        'Idempotency-Key': 'apply-project-wbs-no-date',
      },
      body: JSON.stringify({ target: { kind: 'project', teamId: 'core-team' } }),
    },
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'AutomationProjectTemplateStartDateRequired' })
  expect(projectCreates).toBe(0)
  expect(application.status).toBe('failed')

  // A start date is present, but the Team's Work Item Type cannot be its own child.
  template.payload = {
    nameJa: '標準プロジェクト',
    workItems: [{
      title: '要件定義',
      startOffsetWorkingDays: 0,
      durationWorkingDays: 5,
      children: [{ title: 'ヒアリング', startOffsetWorkingDays: 0, durationWorkingDays: 2 }],
    }],
  }
  application = {
    ...application,
    id: 'application_project_wbs_child_type',
    target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-07' },
    status: 'pending',
    revision: 1,
    errorCode: undefined,
    errorMessage: undefined,
  }
  setTestAppDependencies({
    workItemConfigurations: createFakeWorkItemConfigurationClient({
      async getTeamConfiguration(_workspaceId, teamId) {
        return {
          configuration: {
            ...createTestWorkItemConfiguration('team', teamId),
            workItemTypes: [{ ...DEFAULT_WORK_ITEM_TYPE, allowedChildTypeIds: [] }],
          },
          inheritedFrom: 'default',
        }
      },
    }),
  })
  const childTypeResponse = await app.request(
    `/api/automation/templates/${template.id}/applications`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'apply-project-wbs-child-type',
      },
      body: JSON.stringify({ target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-07' } }),
    },
  )
  expect(childTypeResponse.status).toBe(409)
  expect(await childTypeResponse.json()).toMatchObject({ code: 'WorkItemChildTypeDenied' })
  expect(projectCreates).toBe(0)
  expect(application.status).toBe('failed')
})

test('keeps non-retryable client-category template failures terminal', async () => {
  const now = '2026-07-16T00:00:00.000Z'
  const template: AutomationTemplate = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'template-project-terminal-failure',
    workspaceId: 'user#demo@example.com',
    kind: 'project',
    name: 'Terminal failure Project',
    enabled: true,
    version: 1,
    revision: 1,
    payload: { nameJa: '終端エラー', nameEn: 'Terminal failure', tone: 'purple' },
    createdAt: now,
    updatedAt: now,
  }
  let application: AutomationTemplateApplication = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'application_project_terminal_failure',
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
        'unprocessable',
        'TemplateTargetRejected',
        'Template target was rejected.',
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
        'Idempotency-Key': 'apply-project-terminal-failure',
      },
      body: JSON.stringify({ target: { kind: 'project', teamId: 'core-team' } }),
    },
  )

  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    code: 'TemplateTargetRejected',
    message: 'Template target was rejected.',
  })
  expect(savedApplication).toMatchObject({
    status: 'failed',
    errorCode: 'TemplateTargetRejected',
    errorMessage: 'Template target was rejected.',
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
      id: 'delivery-workflow',
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
    workItemTypes: [{
      id: 'incident',
      name: 'Incident',
      iconToken: 'incident',
      status: 'active',
      defaultWorkflowId: 'default-workflow',
      customFieldIds: ['customer'],
      requiredCustomFieldIds: [],
      detailSections: ['overview', 'custom-fields', 'activity'],
      allowedChildTypeIds: ['default', 'incident'],
      sortOrder: 10,
    }],
  }
  let savedConfiguration: WorkItemConfiguration | undefined
  let completionCount = 0
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async listRules() {
        return []
      },
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
    workflow: { id: 'delivery-workflow', name: 'Delivery workflow' },
    customFields: existingConfiguration.customFields,
    workItemTypes: [{ id: 'incident', defaultWorkflowId: 'delivery-workflow' }],
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

test('turns a signed Triage-purpose delivery into a Triage entry without an Automation event', async () => {
  const previousAuditTable = process.env.AUDIT_EVENTS_TABLE_NAME
  process.env.AUDIT_EVENTS_TABLE_NAME = 'AuditTable'
  try {
    configureFakeProjectClients(true)
    const endpoint = createInboundWebhookEndpointRecord({
      name: 'Status page',
      purpose: 'triage',
      triageRouting: { teamId: 'core-team' },
    })
    const signingSecret = Buffer.from('server-issued-secret', 'utf8')
    const deliveries: Parameters<TestAutomationInboundWebhookPort['recordInboundWebhookDelivery']>[1][] = []
    const created: { teamId: string; input: CreateWebhookTriageEntryInput }[] = []
    const admissions: { key: string; receivedAt: string | undefined }[] = []
    let admissionFailure: Error | undefined
    const now = '2026-10-16T00:00:00.000Z'
    const entry: TriageEntry = {
      schemaVersion: 1,
      id: 'triage-webhook-1',
      workspaceId: endpoint.workspaceId,
      source: { kind: 'webhook', sourceId: `${endpoint.id}:evt-1`, connectorId: endpoint.id },
      sourcePreview: { title: 'Checkout errors', body: 'Customers see 500.', attachmentCount: 0, commentCount: 0, watcherCount: 0, sanitized: true, truncated: false },
      requester: { displayName: 'Status page', guest: true },
      receivedAt: now,
      lastActivityAt: now,
      state: 'pending',
      routing: { reason: 'Received by inbound webhook.', candidates: [] },
      teamId: 'core-team',
      permission: { visibility: 'full', canReply: false, guestVisible: false, checkedAt: now },
      retention: { expiresAt: '2027-10-16T00:00:00.000Z' },
      capabilities: { canAssign: true, canAcceptCreate: true, canAcceptLink: true, canMarkDuplicate: true, canDecline: true, canSnooze: true, canRequestInformation: false, canReply: false, canViewInternalContext: true },
      events: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    /**
     * Fails on a Triage client call the test does not expect.
     *
     * @returns Never; always throws.
     */
    const unexpected = async (): Promise<never> => {
      throw new Error('Unexpected Triage client call.')
    }
    setTestAppDependencies({
      inboundWebhooks: createAutomationInboundWebhookPort({
        /**
         * Resolves the endpoint configured by the test.
         *
         * @returns A copy of the current endpoint.
         */
        async resolveInboundWebhookEndpoint() {
          return structuredClone(endpoint)
        },
        /**
         * Captures a new delivery and accepts it.
         *
         * @param _endpoint - Endpoint receiving the delivery.
         * @param input - Delivery input.
         * @returns A non-replayed delivery result with its acceptance time.
         */
        async recordInboundWebhookDelivery(_endpoint, input) {
          deliveries.push(input)
          return { eventId: input.eventId, replayed: false, acceptedAt: '2026-10-15T23:00:00.000Z' }
        },
      }),
      automationInboundWebhookSecrets: {
        /** Fails because this test does not expect the call. */
        async provision() { throw new Error('unexpected') },
        /**
         * Returns the signing secret.
         *
         * @returns The signing secret.
         */
        async get() { return signingSecret },
        /** Fails because this test does not expect the call. */
        async delete() { throw new Error('unexpected') },
      },
      tenantLifecycleEnforcement: {
        /** Accepts the tenant as active. */
        async assertActive() {},
      },
      triage: {
        listEntries: unexpected,
        getEntry: unexpected,
        getEntryForMutation: unexpected,
        applyAction: unexpected,
        getActionReceipt: unexpected,
        applyBulkAction: unexpected,
        getConfiguration: unexpected,
        getConfigurationUpdateReceipt: unexpected,
        updateConfiguration: unexpected,
        createManualHandoff: unexpected,
        listWorkItemSources: unexpected,
        /**
         * Admits a Triage webhook entry, mirroring store replay and Team checks.
         *
         * @param _workspaceId - Workspace of the entry.
         * @param teamId - Routing Team.
         * @param _endpoint - Endpoint that received the delivery.
         * @param input - Normalized Triage webhook input.
         * @param idempotency - Admission idempotency key.
         * @param options - Admission options.
         * @returns The created or replayed entry.
         */
        async createWebhookEntry(_workspaceId, teamId, _endpoint, input, idempotency, options) {
          // Mirrors the store: a committed source replays before any current-state check.
          if (created.some((item) => item.input.eventId === input.eventId)) return { entry, replayed: true }
          if (admissionFailure) throw admissionFailure
          // Mirrors the admission validator's commit-time Team check.
          if (teamId !== 'core-team') throw new TriageError(409, 'TriageAdmissionTeamUnavailable', 'The target Triage Team is not active.')
          admissions.push({ key: idempotency.key, receivedAt: options?.receivedAt })
          created.push({ teamId, input })
          return { entry, replayed: false }
        },
      },
    })
    /**
     * Sends a signed delivery.
     *
     * @param body - Raw JSON body.
     * @returns The response.
     */
    const deliver = (body: string) => {
      const timestamp = String(Math.floor(Date.now() / 1_000))
      const signature = `sha256=${createHmac('sha256', signingSecret).update(`${timestamp}.`, 'utf8').update(body, 'utf8').digest('hex')}`
      return app.request(`/api/automation/inbound-webhooks/${endpoint.opaqueEndpointId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `delivery-${deliveries.length + created.length}`,
          'X-Mukuroji-Signature': signature,
          'X-Mukuroji-Timestamp': timestamp,
        },
        body,
      })
    }

    const response = await deliver(JSON.stringify({
      eventId: 'evt-1',
      title: 'Checkout errors',
      body: 'Customers see 500.',
      requester: { name: 'Status page' },
    }))
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ eventId: deliveries[0]?.eventId, triageEntryId: 'triage-webhook-1' })
    expect(created).toEqual([{ teamId: 'core-team', input: { eventId: 'evt-1', title: 'Checkout errors', body: 'Customers see 500.', requesterDisplayName: 'Status page' } }])
    // The Triage receipt gets a fixed-length key digest and the delivery's first accepted time.
    expect(admissions).toEqual([{ key: expect.stringMatching(/^[0-9a-f]{64}$/u), receivedAt: '2026-10-15T23:00:00.000Z' }])
    const auditItem = JSON.stringify(deliveries[0]?.auditMutation)
    expect(auditItem).toContain('triage.webhook-received')
    expect(auditItem).not.toContain('webhook.received"')
    expect(auditItem).not.toContain('Customers see 500.')

    const hijack = await deliver(JSON.stringify({
      eventId: 'evt-2',
      title: 'Reroute me',
      body: 'x',
      requester: { name: 'Attacker' },
      teamId: 'other-team',
    }))
    expect(hijack.status).toBe(400)
    expect(await hijack.json()).toMatchObject({ code: 'InvalidTriageWebhookEnvelope' })
    expect(created).toHaveLength(1)

    // After the routing Team disappears, a redelivery of the admitted event still returns
    // its entry, while a new event fails closed.
    endpoint.triageRouting = { teamId: 'removed-team' }
    const replay = await deliver(JSON.stringify({
      eventId: 'evt-1',
      title: 'Checkout errors',
      body: 'Customers see 500.',
      requester: { name: 'Status page' },
    }))
    expect(replay.status).toBe(202)
    expect(await replay.json()).toMatchObject({ triageEntryId: 'triage-webhook-1' })
    const fresh = await deliver(JSON.stringify({ eventId: 'evt-3', title: 'New', body: 'x', requester: { name: 'Status page' } }))
    expect(fresh.status).toBe(409)
    expect(await fresh.json()).toMatchObject({ code: 'TriageAdmissionTeamUnavailable' })
    expect(created).toHaveLength(1)

    // Infrastructure failures during admission use the Triage error envelope.
    endpoint.triageRouting = { teamId: 'core-team' }
    admissionFailure = new Error('ProvisionedThroughputExceededException')
    const throttled = await deliver(JSON.stringify({ eventId: 'evt-4', title: 'New', body: 'x', requester: { name: 'Status page' } }))
    expect(throttled.status).toBe(503)
    expect(await throttled.json()).toMatchObject({ code: 'TriageUnavailable' })
  } finally {
    if (previousAuditTable === undefined) delete process.env.AUDIT_EVENTS_TABLE_NAME
    else process.env.AUDIT_EVENTS_TABLE_NAME = previousAuditTable
  }
})

test('fences the Triage routing Team in the endpoint reservation', async () => {
  configureFakeProjectClients(true)
  const endpoint = createInboundWebhookEndpointRecord({
    name: 'Status page',
    purpose: 'triage',
    triageRouting: { teamId: 'core-team' },
  })
  const fences: unknown[] = []
  setTestAppDependencies({
    inboundWebhooks: createAutomationInboundWebhookPort({
      /**
       * Captures the reservation fences and reserves the endpoint.
       *
       * @param _workspaceId - Workspace of the endpoint.
       * @param _actorId - Acting user.
       * @param _input - Create input.
       * @param _key - Idempotency key.
       * @param _baseUrl - Public base URL.
       * @param validateNewEndpoint - Callback returning commit-time fences.
       * @returns The create provisioning.
       */
      async reserveCreateInboundWebhookEndpoint(_workspaceId, _actorId, _input, _key, _baseUrl, validateNewEndpoint) {
        fences.push(...(await validateNewEndpoint?.() ?? []))
        return createInboundWebhookProvisioning(endpoint, 'create')
      },
      /**
       * Activates the provisioned endpoint.
       *
       * @param provisioning - Provisioning to complete.
       * @returns The active endpoint.
       */
      async completeInboundWebhookProvisioning(provisioning) {
        return { ...provisioning.endpoint, status: 'active' }
      },
    }),
    automationInboundWebhookSecrets: {
      /**
       * Returns a one-time secret.
       *
       * @returns The secret.
       */
      async provision() { return 'one-time-secret' },
      /** Fails because this test does not expect the call. */
      async get() { throw new Error('unexpected') },
      /** Fails because this test does not expect the call. */
      async delete() { throw new Error('unexpected') },
    },
  })
  const response = await app.request('/api/automation/inbound-webhooks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'triage-endpoint-1',
    },
    body: JSON.stringify({ name: 'Status page', purpose: 'triage', triageRouting: { teamId: 'core-team' } }),
  })
  expect(response.status).toBe(201)
  // The Team check is a commit-time condition of the reservation, not only a preflight read.
  expect(fences).toEqual([expect.objectContaining({
    ConditionCheck: expect.objectContaining({
      TableName: 'DirectoryTable',
      Key: expect.objectContaining({ entryKey: 'TEAM#core-team' }),
    }),
  })])
})

test('finishes an accepted Triage delivery after its endpoint is revoked', async () => {
  configureFakeProjectClients(true)
  const endpoint = createInboundWebhookEndpointRecord({
    name: 'Status page',
    purpose: 'triage',
    triageRouting: { teamId: 'core-team' },
    status: 'revoked',
    revokedAt: '2026-10-16T01:00:00.000Z',
  })
  const body = JSON.stringify({ eventId: 'evt-1', title: 'Checkout errors', body: 'Customers see 500.', requester: { name: 'Status page' } })
  const admissions: { eventId: string; receivedAt: string | undefined }[] = []
  /**
   * Fails on a Triage client call the test does not expect.
   *
   * @returns Never; always throws.
   */
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected Triage client call.')
  }
  setTestAppDependencies({
    inboundWebhooks: createAutomationInboundWebhookPort({
      /**
       * Resolves nothing because revocation removed the opaque lookup.
       *
       * @returns Undefined.
       */
      async resolveInboundWebhookEndpoint() {
        return undefined
      },
      /**
       * Returns the accepted delivery for the accepted idempotency key only.
       *
       * @param _opaqueEndpointId - Opaque endpoint ID.
       * @param idempotencyKey - Sender idempotency key.
       * @returns The accepted delivery, or undefined.
       */
      async resolveAcceptedTriageWebhookDelivery(_opaqueEndpointId, idempotencyKey) {
        if (idempotencyKey !== 'accepted-key') return undefined
        return {
          endpoint: structuredClone(endpoint),
          eventId: 'event-accepted',
          bodyFingerprint: createHash('sha256').update(body).digest('hex'),
          acceptedAt: '2026-10-16T00:00:00.000Z',
        }
      },
      /** Fails because a revoked endpoint must not record a new delivery. */
      async recordInboundWebhookDelivery() {
        throw new Error('A revoked endpoint must not record a new delivery.')
      },
    }),
    automationInboundWebhookSecrets: {
      /** Fails because this test does not expect the call. */
      async provision() { throw new Error('unexpected') },
      /** Fails because the revoked endpoint's secret is gone. */
      async get() { throw new Error('A revoked endpoint has no signing secret.') },
      /** Fails because this test does not expect the call. */
      async delete() { throw new Error('unexpected') },
    },
    tenantLifecycleEnforcement: {
      /** Accepts the tenant as active. */
      async assertActive() {},
    },
    triage: {
      listEntries: unexpected,
      getEntry: unexpected,
      getEntryForMutation: unexpected,
      applyAction: unexpected,
      getActionReceipt: unexpected,
      applyBulkAction: unexpected,
      getConfiguration: unexpected,
      getConfigurationUpdateReceipt: unexpected,
      updateConfiguration: unexpected,
      createManualHandoff: unexpected,
      listWorkItemSources: unexpected,
      /**
       * Records the admission and returns the created Triage entry.
       *
       * @param _workspaceId - Workspace of the entry.
       * @param _teamId - Routing Team.
       * @param _endpoint - Endpoint that received the delivery.
       * @param input - Normalized Triage webhook input.
       * @param _idempotency - Admission idempotency key.
       * @param options - Admission options.
       * @returns The created entry.
       */
      async createWebhookEntry(_workspaceId, _teamId, _endpoint, input, _idempotency, options) {
        admissions.push({ eventId: input.eventId, receivedAt: options?.receivedAt })
        return {
          entry: {
            schemaVersion: 1,
            id: 'triage-webhook-1',
            workspaceId: endpoint.workspaceId,
            source: { kind: 'webhook', sourceId: `${endpoint.id}:evt-1`, connectorId: endpoint.id },
            sourcePreview: { title: 'Checkout errors', body: 'Customers see 500.', attachmentCount: 0, commentCount: 0, watcherCount: 0, sanitized: true, truncated: false },
            requester: { displayName: 'Status page', guest: true },
            receivedAt: '2026-10-16T00:00:00.000Z',
            lastActivityAt: '2026-10-16T00:00:00.000Z',
            state: 'pending',
            routing: { reason: 'Received by inbound webhook.', candidates: [] },
            teamId: 'core-team',
            permission: { visibility: 'full', canReply: false, guestVisible: false, checkedAt: '2026-10-16T00:00:00.000Z' },
            retention: { expiresAt: '2027-10-16T00:00:00.000Z' },
            capabilities: { canAssign: true, canAcceptCreate: true, canAcceptLink: true, canMarkDuplicate: true, canDecline: true, canSnooze: true, canRequestInformation: false, canReply: false, canViewInternalContext: true },
            events: [],
            revision: 1,
            createdAt: '2026-10-16T00:00:00.000Z',
            updatedAt: '2026-10-16T00:00:00.000Z',
          },
          replayed: false,
        }
      },
    },
  })
  /**
   * Retries a delivery to the revoked endpoint.
   *
   * @param idempotencyKey - Sender idempotency key.
   * @param requestBody - Raw JSON body.
   * @returns The response.
   */
  const retry = (idempotencyKey: string, requestBody: string) =>
    app.request(`/api/automation/inbound-webhooks/${endpoint.opaqueEndpointId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'X-Mukuroji-Signature': `sha256=${'0'.repeat(64)}`,
        'X-Mukuroji-Timestamp': String(Math.floor(Date.now() / 1_000)),
      },
      body: requestBody,
    })

  const completed = await retry('accepted-key', body)
  expect(completed.status).toBe(202)
  expect(await completed.json()).toEqual({ eventId: 'event-accepted', triageEntryId: 'triage-webhook-1' })
  expect(admissions).toEqual([{ eventId: 'evt-1', receivedAt: '2026-10-16T00:00:00.000Z' }])

  // A new delivery, or a different body under the accepted key, is still rejected.
  const fresh = await retry('new-key', JSON.stringify({ eventId: 'evt-2', title: 'New', body: 'x', requester: { name: 'Status page' } }))
  expect(fresh.status).toBe(404)
  expect(await fresh.json()).toMatchObject({ code: 'AutomationInboundWebhookNotFound' })
  const altered = await retry('accepted-key', JSON.stringify({ eventId: 'evt-1', title: 'Altered', body: 'x', requester: { name: 'Status page' } }))
  expect(altered.status).toBe(404)
  expect(admissions).toHaveLength(1)
})

test('finishes an accepted Triage delivery after the endpoint secret is rotated', async () => {
  configureFakeProjectClients(true)
  const endpoint = createInboundWebhookEndpointRecord({
    name: 'Status page',
    purpose: 'triage',
    triageRouting: { teamId: 'core-team' },
    secretGeneration: 2,
  })
  const previousSecret = Buffer.from('previous-secret', 'utf8')
  const currentSecret = Buffer.from('current-secret', 'utf8')
  const body = JSON.stringify({ eventId: 'evt-1', title: 'Checkout errors', body: 'Customers see 500.', requester: { name: 'Status page' } })
  const admissions: string[] = []
  const recordedBodies: string[] = []
  /**
   * Fails on a Triage client call the test does not expect.
   *
   * @returns Never; always throws.
   */
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected Triage client call.')
  }
  setTestAppDependencies({
    inboundWebhooks: createAutomationInboundWebhookPort({
      /**
       * Resolves the endpoint configured by the test.
       *
       * @returns A copy of the current endpoint.
       */
      async resolveInboundWebhookEndpoint() {
        return structuredClone(endpoint)
      },
      /**
       * Returns the accepted delivery for the accepted idempotency key only.
       *
       * @param _opaqueEndpointId - Opaque endpoint ID.
       * @param idempotencyKey - Sender idempotency key.
       * @returns The accepted delivery, or undefined.
       */
      async resolveAcceptedTriageWebhookDelivery(_opaqueEndpointId, idempotencyKey) {
        if (idempotencyKey !== 'accepted-key') return undefined
        return {
          endpoint: structuredClone(endpoint),
          eventId: 'event-accepted',
          bodyFingerprint: createHash('sha256').update(body).digest('hex'),
          acceptedAt: '2026-10-16T00:00:00.000Z',
        }
      },
      /**
       * Captures the body fingerprint and rejects it as an idempotency conflict.
       *
       * @param _endpoint - Endpoint receiving the delivery.
       * @param input - Delivery input.
       */
      async recordInboundWebhookDelivery(_endpoint, input) {
        recordedBodies.push(input.bodyFingerprint)
        throw new AutomationError(
          'conflict',
          'AutomationInboundWebhookIdempotencyConflict',
          'Idempotency key was already used with a different request body.',
        )
      },
    }),
    automationInboundWebhookSecrets: {
      /** Fails because this test does not expect the call. */
      async provision() { throw new Error('unexpected') },
      /**
       * Returns the current signing secret.
       *
       * @returns The current secret.
       */
      async get() { return currentSecret },
      /** Fails because this test does not expect the call. */
      async delete() { throw new Error('unexpected') },
    },
    tenantLifecycleEnforcement: {
      /** Accepts the tenant as active. */
      async assertActive() {},
    },
    triage: {
      listEntries: unexpected,
      getEntry: unexpected,
      getEntryForMutation: unexpected,
      applyAction: unexpected,
      getActionReceipt: unexpected,
      applyBulkAction: unexpected,
      getConfiguration: unexpected,
      getConfigurationUpdateReceipt: unexpected,
      updateConfiguration: unexpected,
      createManualHandoff: unexpected,
      listWorkItemSources: unexpected,
      /**
       * Records the admission and returns the created Triage entry.
       *
       * @param _workspaceId - Workspace of the entry.
       * @param _teamId - Routing Team.
       * @param _endpoint - Endpoint that received the delivery.
       * @param input - Normalized Triage webhook input.
       * @returns The created entry.
       */
      async createWebhookEntry(_workspaceId, _teamId, _endpoint, input) {
        admissions.push(input.eventId)
        return {
          entry: {
            schemaVersion: 1,
            id: 'triage-webhook-1',
            workspaceId: endpoint.workspaceId,
            source: { kind: 'webhook', sourceId: `${endpoint.id}:evt-1`, connectorId: endpoint.id },
            sourcePreview: { title: 'Checkout errors', body: 'Customers see 500.', attachmentCount: 0, commentCount: 0, watcherCount: 0, sanitized: true, truncated: false },
            requester: { displayName: 'Status page', guest: true },
            receivedAt: '2026-10-16T00:00:00.000Z',
            lastActivityAt: '2026-10-16T00:00:00.000Z',
            state: 'pending',
            routing: { reason: 'Received by inbound webhook.', candidates: [] },
            teamId: 'core-team',
            permission: { visibility: 'full', canReply: false, guestVisible: false, checkedAt: '2026-10-16T00:00:00.000Z' },
            retention: { expiresAt: '2027-10-16T00:00:00.000Z' },
            capabilities: { canAssign: true, canAcceptCreate: true, canAcceptLink: true, canMarkDuplicate: true, canDecline: true, canSnooze: true, canRequestInformation: false, canReply: false, canViewInternalContext: true },
            events: [],
            revision: 1,
            createdAt: '2026-10-16T00:00:00.000Z',
            updatedAt: '2026-10-16T00:00:00.000Z',
          },
          replayed: false,
        }
      },
    },
  })
  /**
   * Sends a delivery signed with the given secret.
   *
   * @param secret - Signing secret.
   * @param idempotencyKey - Sender idempotency key.
   * @param requestBody - Raw JSON body.
   * @returns The response.
   */
  const deliver = (secret: Buffer, idempotencyKey: string, requestBody: string) => {
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const signature = `sha256=${createHmac('sha256', secret).update(`${timestamp}.`, 'utf8').update(requestBody, 'utf8').digest('hex')}`
    return app.request(`/api/automation/inbound-webhooks/${endpoint.opaqueEndpointId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'X-Mukuroji-Signature': signature,
        'X-Mukuroji-Timestamp': timestamp,
      },
      body: requestBody,
    })
  }

  const previousAuditTable = process.env.AUDIT_EVENTS_TABLE_NAME
  process.env.AUDIT_EVENTS_TABLE_NAME = 'AuditTable'
  try {
    // The accepted delivery's retry is still signed with the secret from before the rotation.
    const completed = await deliver(previousSecret, 'accepted-key', body)
    expect(completed.status).toBe(202)
    expect(await completed.json()).toEqual({ eventId: 'event-accepted', triageEntryId: 'triage-webhook-1' })
    expect(admissions).toEqual(['evt-1'])

    // A new delivery signed with the old secret fails verification.
    const fresh = await deliver(previousSecret, 'new-key', body)
    expect(fresh.status).toBe(401)
    // A different body under the accepted key goes through normal verification with its bytes intact.
    const altered = JSON.stringify({ eventId: 'evt-1', title: 'Altered', body: 'x', requester: { name: 'Status page' } })
    const conflict = await deliver(currentSecret, 'accepted-key', altered)
    expect(conflict.status).toBe(409)
    expect(recordedBodies).toEqual([createHash('sha256').update(altered).digest('hex')])
    expect(admissions).toHaveLength(1)
  } finally {
    if (previousAuditTable === undefined) delete process.env.AUDIT_EVENTS_TABLE_NAME
    else process.env.AUDIT_EVENTS_TABLE_NAME = previousAuditTable
  }
})

/**
 * Builds a completed Bulk status edit whose single item undoes with the given payload.
 *
 * @param undoPayload - Undo snapshot stored for the edited Work Item.
 * @returns Bulk Operation ready to be undone.
 */
function createBulkStatusUndoOperation(
  undoPayload: BulkOperation['items'][number]['undoPayload'],
): BulkOperation {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'bulk-status-undo',
    workspaceId: 'user#demo@example.com',
    actorMemberKey: 'demo@example.com',
    revision: 1,
    status: 'succeeded',
    action: { type: 'edit', patch: { workflowStatusId: 'in-progress' } },
    items: [{
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      expectedRevision: 1,
      resultingRevision: 2,
      status: 'succeeded',
      retryable: false,
      undoable: true,
      ...(undoPayload ? { undoPayload } : {}),
    }],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:01:00.000Z',
  }
}

/**
 * Undoes a stored Bulk Operation through the API.
 *
 * @param operation - Bulk Operation the fake store returns.
 * @returns The HTTP response of the undo request.
 */
async function requestBulkUndo(operation: BulkOperation) {
  const automationFake = createBulkOperationAutomationFake(operation)
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    planning: new InMemoryPlanningClient(),
  })
  return app.request(`/api/bulk-operations/${operation.id}/undo`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
  })
}

test('keeps the actual dates in the undo snapshot of a Bulk status edit', async () => {
  configureFakeProjectClients(true, {
    detailWorkflowStatusId: 'done',
    detailActualStartDate: '2026-06-01',
    detailActualEndDate: '2026-06-05',
  })
  const automationFake = createBulkOperationAutomationFake()
  setTestAppDependencies({
    bulkOperations: automationFake.client,
    planning: new InMemoryPlanningClient(),
  })
  const request = {
    action: { type: 'edit', patch: { workflowStatusId: 'in-progress' } },
    items: [{ teamId: 'core-team', workItemId: 'onboarding-friction', expectedRevision: 1 }],
  }
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
  const previewResponse = await app.request('/api/bulk-operations/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })
  const preview = await previewResponse.json() as { operationToken: string }
  const applyResponse = await app.request('/api/bulk-operations', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, operationToken: preview.operationToken }),
  })
  const applied = await applyResponse.json() as { id: string }

  expect(applyResponse.status).toBe(201)
  const stored = await automationFake.client.getBulkOperation('user#demo@example.com', applied.id)
  expect(stored?.items[0]?.undoPayload).toEqual({
    workflowStatusId: 'done',
    actualStartDate: '2026-06-01',
    actualEndDate: '2026-06-05',
  })
})

test('restores the earlier completion date when a manager undoes a Bulk reopen', async () => {
  const corrections: unknown[] = []
  const transitionInstants: unknown[] = []
  const calls = configureFakeProjectClients(true, {
    detailRevisions: { ['core-team\0onboarding-friction']: 2 },
    detailWorkflowStatusId: 'in-progress',
    detailActualStartDate: '2026-06-01',
    issueUpdateHook: (input) => {
      corrections.push(input.actualDateCorrection)
      transitionInstants.push(input.actualDateTransitionAt)
    },
  })

  const response = await requestBulkUndo(createBulkStatusUndoOperation({
    workflowStatusId: 'done',
    actualStartDate: '2026-06-01',
    actualEndDate: '2026-06-05',
  }))

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ items: [{ status: 'undone' }] })
  expect(calls.issueUpdates).toHaveLength(1)
  expect(corrections).toEqual([{ actualStartDate: '2026-06-01', actualEndDate: '2026-06-05' }])
  // The adapter dates the transition with the same instant the prediction used.
  expect(transitionInstants).toHaveLength(1)
  expect(Number.isNaN(Date.parse(String(transitionInstants[0])))).toBe(false)
})

test('refuses a member Bulk undo that would replace the recorded completion date', async () => {
  const calls = configureFakeProjectClients(true, {
    role: 'member',
    detailRevisions: { ['core-team\0onboarding-friction']: 2 },
    detailWorkflowStatusId: 'in-progress',
    detailActualStartDate: '2026-06-01',
  })

  const response = await requestBulkUndo(createBulkStatusUndoOperation({
    workflowStatusId: 'done',
    actualStartDate: '2026-06-01',
    actualEndDate: '2026-06-05',
  }))

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    items: [{ status: 'failed', errorCode: 'BulkUndoUnavailable' }],
  })
  expect(calls.issueUpdates).toEqual([])
})

test('lets a member undo a Bulk first start without correcting the actual dates', async () => {
  const corrections: unknown[] = []
  const calls = configureFakeProjectClients(true, {
    role: 'member',
    detailRevisions: { ['core-team\0onboarding-friction']: 2 },
    detailWorkflowStatusId: 'in-progress',
    detailActualStartDate: '2026-06-01',
    issueUpdateHook: (input) => {
      corrections.push(input.actualDateCorrection)
    },
  })

  const response = await requestBulkUndo(createBulkStatusUndoOperation({
    workflowStatusId: 'todo',
    actualStartDate: null,
    actualEndDate: null,
  }))

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ items: [{ status: 'undone' }] })
  expect(calls.issueUpdates).toHaveLength(1)
  expect(corrections).toEqual([undefined])
})

test('predicts a Bulk undo completion date in the calendar of the restored schedule', async () => {
  const withTimeZone = (timeZone: string) => {
    const schedule = createDefaultDueDateWorkItemSchedule('2026-06-18')
    return { ...schedule, calendarPolicy: { ...schedule.calendarPolicy, timeZone } }
  }
  // These zones are 26 hours apart, so their local dates always differ.
  const restoredSchedule = withTimeZone('Pacific/Kiritimati')
  const todayInRestoredZone = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Kiritimati',
  }).format(new Date())
  const corrections: unknown[] = []
  const calls = configureFakeProjectClients(true, {
    role: 'member',
    detailRevisions: { ['core-team\0onboarding-friction']: 2 },
    detailWorkflowStatusId: 'in-progress',
    detailActualStartDate: '2026-06-01',
    detailSchedule: withTimeZone('Etc/GMT+12'),
    issueUpdateHook: (input) => {
      corrections.push(input.actualDateCorrection)
    },
  })
  const operation = createBulkStatusUndoOperation({
    workflowStatusId: 'done',
    schedule: restoredSchedule,
    actualStartDate: '2026-06-01',
    actualEndDate: todayInRestoredZone,
  })
  operation.action = {
    type: 'edit',
    patch: { workflowStatusId: 'in-progress', schedule: withTimeZone('Etc/GMT+12') },
  }

  const response = await requestBulkUndo(operation)

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ items: [{ status: 'undone' }] })
  expect(calls.issueUpdates).toHaveLength(1)
  expect(corrections).toEqual([undefined])
})

/** A Team rule body that reacts to status changes and assigns the Work Item. */
const teamRuleBody = {
  ownerTeamId: 'core-team',
  name: 'Assign on review',
  enabled: true,
  trigger: { type: 'status', toStatusId: 'review' },
  actions: [{ type: 'assign', assigneeMemberKey: 'user#reviewer@example.com' }],
}

/**
 * Creates the stored form of a Team rule.
 *
 * @param ownerTeamId - Owner Team of the stored rule, or undefined for a Workspace rule.
 * @returns A stored Automation rule.
 */
function createStoredTeamRule(ownerTeamId: string | undefined) {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'rule-team',
    workspaceId: 'user#demo@example.com',
    ...(ownerTeamId === undefined ? {} : { ownerTeamId }),
    name: 'Assign on review',
    enabled: true,
    version: 1,
    revision: 1,
    trigger: { type: 'status', toStatusId: 'review' },
    conditions: [],
    actions: [{ type: 'assign', assigneeMemberKey: 'user#reviewer@example.com' }],
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 60000 },
    rateLimit: { maxExecutions: 100, windowSeconds: 60 },
    allowReentry: false,
    maxChainDepth: 8,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  } satisfies Awaited<ReturnType<TestAutomationRuleTemplatePort['createRule']>>
}

test('lets a Team manager create and change rules of their own Team only', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member', role: 'manager' })
  const created: unknown[] = []
  const updated: unknown[] = []
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async createRule(_workspaceId, input) {
        created.push(input)
        return createStoredTeamRule(input.ownerTeamId)
      },
      async getRule(_workspaceId, ruleId) {
        return createStoredTeamRule(ruleId === 'rule-workspace' ? undefined : 'core-team')
      },
      async updateRule(_workspaceId, _ruleId, input) {
        updated.push(input)
        return createStoredTeamRule('core-team')
      },
    }),
  })
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }
  const post = (body: unknown) => app.request('/api/automation/rules', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const ownTeam = await post(teamRuleBody)
  const workspaceRule = await post({ ...teamRuleBody, ownerTeamId: undefined })
  const webhookAction = await post({
    ...teamRuleBody,
    actions: [{ type: 'webhook', url: 'https://hooks.example.com/review' }],
  })
  const otherTeamCreate = await post({
    ...teamRuleBody,
    actions: [{
      type: 'create',
      values: { teamId: 'ops-team', title: 'Follow up', schedule: createDefaultDueDateWorkItemSchedule('2026-07-20') },
    }],
  })
  const otherTeamProject = await post({
    ...teamRuleBody,
    actions: [{ type: 'move', targetProjectId: 'other-team-project' }],
  })
  const otherTeamUpdate = await post({
    ...teamRuleBody,
    actions: [{ type: 'update', patch: { assignedProjectId: 'other-team-project' } }],
  })
  const formTrigger = await post({ ...teamRuleBody, trigger: { type: 'form', formId: 'form-1' } })
  const stopOwn = await app.request('/api/automation/rules/rule-team', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ expectedRevision: 1, enabled: false }),
  })
  const stopWorkspace = await app.request('/api/automation/rules/rule-workspace', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ expectedRevision: 1, enabled: false }),
  })
  const scopes = await app.request('/api/automation/management-scopes', { headers })

  expect(ownTeam.status).toBe(201)
  expect(workspaceRule.status).toBe(403)
  expect(await workspaceRule.json()).toMatchObject({ code: 'WorkspaceRoleDenied' })
  for (const response of [webhookAction, otherTeamCreate, otherTeamProject, otherTeamUpdate, formTrigger]) {
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'AutomationTeamScopeViolation' })
  }
  expect(stopOwn.status).toBe(200)
  expect(stopWorkspace.status).toBe(403)
  expect(created).toEqual([expect.objectContaining({ ownerTeamId: 'core-team' })])
  expect(updated).toEqual([{ expectedRevision: 1, enabled: false }])
  expect(await scopes.json()).toEqual({ workspace: false, teamIds: ['core-team'] })
})

test('keeps Team rules with Workspace administrators for members who do not manage the Team', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member', role: 'member' })
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({}),
  })
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

  const response = await app.request('/api/automation/rules', {
    method: 'POST',
    headers,
    body: JSON.stringify(teamRuleBody),
  })
  const scopes = await app.request('/api/automation/management-scopes', { headers })

  expect(response.status).toBe(403)
  expect(await scopes.json()).toEqual({ workspace: false, teamIds: [] })
})

test('lets a Workspace administrator stop a Team rule and see every Team as manageable', async () => {
  configureFakeProjectClients(true)
  const updated: unknown[] = []
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async getRule() {
        return createStoredTeamRule('core-team')
      },
      async updateRule(_workspaceId, _ruleId, input) {
        updated.push(input)
        return { ...createStoredTeamRule('core-team'), enabled: false }
      },
    }),
  })
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

  const stop = await app.request('/api/automation/rules/rule-team', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ expectedRevision: 1, enabled: false }),
  })
  const scopes = await app.request('/api/automation/management-scopes', { headers })

  expect(stop.status).toBe(200)
  expect(updated).toHaveLength(1)
  expect(await scopes.json()).toEqual({ workspace: true, teamIds: ['core-team'] })
})

test('lets a Workspace administrator stop a rule whose Team is no longer active', async () => {
  configureFakeProjectClients(true)
  setTestAppDependencies({
    ruleTemplates: createAutomationRuleTemplatePort({
      async getRule() {
        return createStoredTeamRule('archived-team')
      },
      async updateRule() {
        return { ...createStoredTeamRule('archived-team'), enabled: false }
      },
    }),
  })

  const stop = await app.request('/api/automation/rules/rule-team', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 1, enabled: false }),
  })

  expect(stop.status).toBe(200)
})

test('reports Enterprise management scopes from the manage grant, not the read grant', async () => {
  configureFakeProjectClients(true)
  const principal = (permissions: WorkspacePrincipal['enterprisePermissions']): WorkspacePrincipal => ({
    directoryId: 'default',
    userKey: 'enterprise-user',
    actorId: 'enterprise-user',
    isSystemAdmin: false,
    groups: [],
    enterprisePermissions: permissions,
    enterpriseRouteAuthorizedAtResource: true,
    enterpriseAuthorizationResource: { kind: 'workspace', targetId: 'default', workspaceId: 'default' },
    workspaceMember: {
      id: 'enterprise-user',
      memberKey: 'enterprise-user',
      email: 'enterprise@example.com',
      role: 'member',
      status: 'active',
      version: 1,
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
    },
    workspaceRole: 'member',
    workspaceMemberStatus: 'active',
  })

  const reader = await runWithTestAppDependencies(() =>
    listDelegatedManagementScopes(principal(['automation.read']), 'automation.manage'))
  const manager = await runWithTestAppDependencies(() =>
    listDelegatedManagementScopes(principal(['automation.read', 'automation.manage']), 'automation.manage'))

  expect(reader).toEqual({ workspace: false, teamIds: [] })
  expect(manager).toEqual({ workspace: true, teamIds: ['core-team'] })
})

test('rejects Team execution actions that reach another Team at run time', async () => {
  const calls = configureFakeProjectClients(true)
  const context = {
    execution: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-team-guard',
      workspaceId: 'workspace-1',
      ruleId: 'rule-team',
      ruleVersion: 1,
      ownerTeamId: 'ops-team',
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
    idempotencyKey: 'automation-team-guard:action:0000',
  } satisfies AutomationActionExecutionContext
  const executor = createAutomationActionExecutor()

  await expect(runWithTestAppDependencies(() =>
    executor.execute({ type: 'assign', assigneeMemberKey: 'user#demo@example.com' }, context)
  )).rejects.toMatchObject({ code: 'AutomationTeamScopeViolation' })
  await expect(runWithTestAppDependencies(() =>
    executor.execute({
      type: 'create',
      values: { teamId: 'core-team', title: 'Elsewhere', schedule: createDefaultDueDateWorkItemSchedule('2026-07-20') },
    }, context)
  )).rejects.toMatchObject({ code: 'AutomationTeamScopeViolation' })
  await expect(runWithTestAppDependencies(() =>
    executor.execute({ type: 'webhook', url: 'https://hooks.example.com/x' }, context)
  )).rejects.toMatchObject({ code: 'AutomationTeamScopeViolation' })
  expect(calls.issueUpdates).toHaveLength(0)
  expect(calls.issueCreates).toHaveLength(0)
})
