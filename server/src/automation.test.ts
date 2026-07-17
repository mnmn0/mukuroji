import { describe, expect, test } from 'bun:test'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationExecution,
  type AutomationRule,
  type AutomationTemplateApplication,
  type BulkOperation,
  type BulkOperationRequest,
  type RecurringSchedule,
  type RecurringWork,
} from '@mukuroji/contracts'
import {
  AutomationEngine,
  AutomationError,
  DynamoDbAutomationClient,
  applyBulkOperation,
  createAutomationActionId,
  createAutomationExecutionId,
  createRecurringExecutionId,
  ensureLocalAutomationTable,
  evaluateAutomationCondition,
  getRecurringOccurrences,
  matchesAutomationTrigger,
  normalizeAutomationActionFailure,
  previewBulkOperation,
  retryBulkOperation,
  selectCatchUpOccurrences,
  undoBulkOperation,
  validateCreateAutomationRuleInput,
  validateCreateAutomationTemplateInput,
  type AutomationClient,
  type AutomationEvent,
  type AutomationExecutionClaimToken,
  type BulkOperationAdapter,
} from './automation'

function createRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'rule-1',
    workspaceId: 'workspace-1',
    name: 'Rule 1',
    enabled: true,
    version: 1,
    revision: 1,
    trigger: { type: 'status', toStatusId: 'done' },
    conditions: [],
    actions: [
      { type: 'comment', body: 'First' },
      { type: 'notify', recipientMemberKeys: ['owner@example.com'], title: 'Second' },
    ],
    retryPolicy: { maxAttempts: 3, initialDelayMs: 0, backoffMultiplier: 2, maxDelayMs: 1_000 },
    rateLimit: { maxExecutions: 100, windowSeconds: 60 },
    allowReentry: false,
    maxChainDepth: 8,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  }
}

function createEvent(overrides: Partial<AutomationEvent> = {}): AutomationEvent {
  return {
    eventId: 'event-1',
    eventType: 'work-item.updated',
    workspaceId: 'workspace-1',
    occurredAt: '2026-07-16T00:00:00.000Z',
    changes: [{ field: 'workflowStatusId', before: 'review', after: 'done' }],
    ...overrides,
  }
}

function createExecution(overrides: Partial<AutomationExecution> = {}): AutomationExecution {
  const id = 'automation_execution_1'
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id,
    workspaceId: 'workspace-1',
    ruleId: 'rule-1',
    ruleVersion: 1,
    triggerEventId: 'event-1',
    status: 'failed',
    attempts: 1,
    actions: [{
      actionIndex: 0,
      actionId: createAutomationActionId(id, 0),
      status: 'failed',
      attempts: 1,
    }],
    startedAt: '2026-07-16T00:00:00.000Z',
    completedAt: '2026-07-16T00:00:01.000Z',
    nextRetryAt: '2026-07-16T00:01:00.000Z',
    retryable: true,
    ...overrides,
  }
}

function createBulkOperationFixture(overrides: Partial<BulkOperation> = {}): BulkOperation {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'bulk-1',
    workspaceId: 'workspace-1',
    actorMemberKey: 'owner@example.com',
    revision: 1,
    status: 'partial',
    action: { type: 'move', targetProjectId: 'platform' },
    items: [
      {
        teamId: 'core',
        workItemId: 'one',
        expectedRevision: 1,
        status: 'succeeded',
        resultingRevision: 10,
        retryable: false,
        undoable: true,
        undoPayload: { previousProjectId: 'alpha' },
      },
      {
        teamId: 'core',
        workItemId: 'two',
        expectedRevision: 2,
        status: 'failed',
        errorCode: 'TemporaryBulkFailure',
        errorMessage: 'Retry item.',
        retryable: true,
        undoable: false,
      },
    ],
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:01.000Z',
    ...overrides,
  }
}

function createMemoryClient(forceRateLimited = false) {
  const executions = new Map<string, AutomationExecution>()
  const events = new Map<string, AutomationEvent>()
  const receipts = new Set<string>()
  const rules = new Map<string, AutomationRule>()
  const recurringWorks = new Map<string, RecurringWork>()
  const client = {
    executions,
    events,
    receipts,
    rules,
    recurringWorks,
    async createExecution(execution: AutomationExecution, event: AutomationEvent) {
      if (executions.has(execution.id)) return false
      executions.set(execution.id, structuredClone(execution))
      events.set(execution.id, structuredClone(event))
      return true
    },
    async getExecution(_workspaceId: string, executionId: string) {
      const execution = executions.get(executionId)
      return execution ? structuredClone(execution) : undefined
    },
    async getExecutionEvent(_workspaceId: string, executionId: string) {
      const event = events.get(executionId)
      return event ? structuredClone(event) : undefined
    },
    async claimExecution(
      candidate: AutomationExecution,
      now: Date,
      leaseExpiresAt: string,
      definitionGuard?: Parameters<AutomationClient['claimExecution']>[3],
    ) {
      if (definitionGuard?.kind === 'recurring') {
        const definition = recurringWorks.get(definitionGuard.id)
        if (
          !definition?.enabled ||
          definition.version !== definitionGuard.version ||
          definition.revision !== definitionGuard.revision
        ) return false
      }
      const current = executions.get(candidate.id)
      if (!current || current.status !== candidate.status || current.attempts !== candidate.attempts) {
        return false
      }
      if (
        current.status === 'running' &&
        current.nextRetryAt &&
        current.nextRetryAt > now.toISOString()
      ) {
        return false
      }
      current.status = 'running'
      current.attempts += 1
      current.retryable = false
      current.nextRetryAt = leaseExpiresAt
      current.completedAt = undefined
      current.errorCode = undefined
      current.errorMessage = undefined
      executions.set(current.id, structuredClone(current))
      return true
    },
    async saveExecution(
      execution: AutomationExecution,
      claimToken: AutomationExecutionClaimToken,
    ) {
      const current = executions.get(execution.id)
      if (
        current?.status !== 'running' ||
        current.attempts !== claimToken.attempt ||
        current.nextRetryAt !== claimToken.leaseExpiresAt
      ) return false
      executions.set(execution.id, structuredClone(execution))
      return true
    },
    async reserveExecution(rule: AutomationRule, event: AutomationEvent, now: Date) {
      if (forceRateLimited) return 'rate-limited' as const
      const id = createAutomationExecutionId(rule, event.eventId)
      if (executions.has(id)) return 'duplicate' as const
      rules.set(`${rule.id}\0${rule.version}`, structuredClone(rule))
      executions.set(id, {
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        id,
        workspaceId: rule.workspaceId,
        ruleId: rule.id,
        ruleVersion: rule.version,
        triggerEventId: event.eventId,
        status: 'pending',
        attempts: 0,
        actions: rule.actions.map((_action, actionIndex) => ({
          actionIndex,
          actionId: createAutomationActionId(id, actionIndex),
          status: 'pending',
          attempts: 0,
        })),
        startedAt: now.toISOString(),
        retryable: false,
      })
      events.set(id, structuredClone(event))
      return 'created' as const
    },
    async hasActionReceipt(_workspaceId: string, executionId: string, actionId: string) {
      return receipts.has(`${executionId}\0${actionId}`)
    },
    async putActionReceipt(_workspaceId: string, executionId: string, actionId: string) {
      const key = `${executionId}\0${actionId}`
      if (receipts.has(key)) return false
      receipts.add(key)
      return true
    },
    async getRuleVersion(_workspaceId: string, ruleId: string, version: number) {
      return rules.get(`${ruleId}\0${version}`)
    },
    async getRecurringWork(_workspaceId: string, recurringWorkId: string) {
      const definition = recurringWorks.get(recurringWorkId)
      return definition ? structuredClone(definition) : undefined
    },
  } as unknown as AutomationClient & {
    executions: Map<string, AutomationExecution>
    events: Map<string, AutomationEvent>
    receipts: Set<string>
    rules: Map<string, AutomationRule>
    recurringWorks: Map<string, RecurringWork>
  }
  return client
}

function createIdempotencyDocumentClient() {
  const items = new Map<string, Record<string, unknown>>()
  const itemKey = (item: Record<string, unknown>) => `${String(item.scopeKey)}\0${String(item.recordKey)}`
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if (Array.isArray(command.input.TransactItems)) {
        const puts = (command.input.TransactItems as Array<{
          Put?: {
            Item?: Record<string, unknown>
            ConditionExpression?: string
            ExpressionAttributeValues?: Record<string, unknown>
          }
        }>).flatMap((item) => item.Put?.Item ? [{ ...item.Put, Item: item.Put.Item }] : [])
        const conflicts = puts.map((put) => {
          const existing = items.get(itemKey(put.Item))
          if (put.ConditionExpression?.includes('attribute_not_exists')) return existing !== undefined
          if (put.ConditionExpression?.includes('#revision = :expectedRevision')) {
            return existing?.revision !== put.ExpressionAttributeValues?.[':expectedRevision']
          }
          return false
        })
        if (conflicts.some(Boolean)) {
          throw Object.assign(new Error('ConditionalCheckFailed'), {
            name: 'TransactionCanceledException',
            CancellationReasons: conflicts.map((conflict) => ({
              Code: conflict ? 'ConditionalCheckFailed' : 'None',
            })),
          })
        }
        for (const put of puts) items.set(itemKey(put.Item), structuredClone(put.Item))
        return {}
      }
      if (
        command.input.Key &&
        command.input.ConditionExpression === '#revision = :expectedRevision'
      ) {
        const key = command.input.Key as Record<string, unknown>
        const existing = items.get(itemKey(key))
        const expectedRevision = (
          command.input.ExpressionAttributeValues as Record<string, unknown>
        )[':expectedRevision']
        if (existing?.revision !== expectedRevision) {
          throw Object.assign(new Error('ConditionalCheckFailed'), {
            name: 'ConditionalCheckFailedException',
          })
        }
        items.delete(itemKey(key))
        return {}
      }
      if (command.input.Key) {
        const key = command.input.Key as Record<string, unknown>
        const item = items.get(itemKey(key))
        return item ? { Item: structuredClone(item) } : {}
      }
      if (command.input.Item) {
        const item = command.input.Item as Record<string, unknown>
        items.set(itemKey(item), structuredClone(item))
        return {}
      }
      return {}
    },
  } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
  return { documentClient, items }
}

describe('automation management create idempotency', () => {
  test('returns the original rule for a normalized replay and rejects payload reuse', async () => {
    const { documentClient, items } = createIdempotencyDocumentClient()
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const input = {
      name: 'Notify completed work',
      enabled: true,
      trigger: { type: 'status' as const, toStatusId: 'done' },
      actions: [{ type: 'comment' as const, body: 'Completed' }],
    }

    const created = await client.createRule(' workspace-1 ', input, ' create-rule-1 ')
    const replay = await client.createRule('workspace-1', {
      ...input,
      conditions: [],
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1_000, backoffMultiplier: 2, maxDelayMs: 60_000 },
      rateLimit: { maxExecutions: 100, windowSeconds: 60 },
      allowReentry: false,
      maxChainDepth: 8,
    }, 'create-rule-1')

    expect(replay).toEqual(created)
    expect(created.id).toMatch(/^rule_[a-f0-9]{48}$/)
    expect([...items.values()].filter((item) => item.entryType === 'create-receipt')).toHaveLength(1)
    await expect(client.createRule('workspace-1', {
      ...input,
      name: 'Different request',
    }, 'create-rule-1')).rejects.toMatchObject({
      status: 409,
      code: 'IdempotencyConflict',
    })
  })

  test('scopes template and recurring keys by resource kind and validates their fingerprints', async () => {
    const { documentClient } = createIdempotencyDocumentClient()
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const templateInput = {
      kind: 'work-item' as const,
      name: 'Weekly review',
      enabled: true,
      payload: { title: 'Review' },
    }
    const template = await client.createTemplate('workspace-1', templateInput, 'shared-key')
    expect(await client.createTemplate('workspace-1', templateInput, 'shared-key')).toEqual(template)
    const recurringInput = {
      name: 'Weekly review schedule',
      teamId: 'core',
      enabled: true,
      templateId: template.id,
      schedule: {
        frequency: 'weekly' as const,
        interval: 1,
        timeZone: 'UTC',
        localTime: '09:00',
        startDate: '2020-01-06',
        daysOfWeek: [1],
        catchUpPolicy: 'latest' as const,
      },
    }

    const recurring = await client.createRecurringWork('workspace-1', recurringInput, 'shared-key')
    expect(await client.createRecurringWork('workspace-1', recurringInput, 'shared-key')).toEqual(recurring)
    const disabledTemplate = await client.updateTemplate('workspace-1', template.id, {
      expectedRevision: template.revision,
      enabled: false,
    })
    expect(await client.createRecurringWork('workspace-1', recurringInput, 'shared-key')).toEqual(recurring)
    await client.deleteTemplate('workspace-1', template.id, disabledTemplate.revision)
    expect(await client.createRecurringWork('workspace-1', recurringInput, 'shared-key')).toEqual(recurring)
    expect(recurring.id).not.toBe(template.id)
    expect((await client.createTemplate('workspace-2', templateInput, 'shared-key')).id).not.toBe(template.id)

    await expect(client.createTemplate('workspace-1', {
      ...templateInput,
      payload: { title: 'Changed' },
    }, 'shared-key')).rejects.toMatchObject({ code: 'IdempotencyConflict' })
    await expect(client.createRecurringWork('workspace-1', {
      ...recurringInput,
      teamId: 'other-team',
    }, 'shared-key')).rejects.toMatchObject({ code: 'IdempotencyConflict' })
  })

  test('pins server-resolved immutable template versions for rules and recurring work', async () => {
    const { documentClient } = createIdempotencyDocumentClient()
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const templateV1 = await client.createTemplate('workspace-1', {
      kind: 'work-item',
      name: 'Pinned template',
      enabled: true,
      payload: { title: 'Version one' },
    })
    const ruleV1 = await client.createRule('workspace-1', {
      name: 'Pinned rule',
      enabled: true,
      trigger: { type: 'status', toStatusId: 'done' },
      actions: [{
        type: 'create',
        templateId: templateV1.id,
        templateVersion: 999,
      }],
    })
    expect(ruleV1.actions[0]).toMatchObject({
      templateId: templateV1.id,
      templateVersion: 1,
    })

    const templateV2 = await client.updateTemplate('workspace-1', templateV1.id, {
      expectedRevision: 1,
      payload: { title: 'Version two' },
    })
    const ruleV2 = await client.updateRule('workspace-1', ruleV1.id, {
      expectedRevision: ruleV1.revision,
      actions: [{ type: 'create', templateId: templateV1.id }],
    })
    expect(ruleV2.actions[0]).toMatchObject({ templateVersion: 2 })
    const ruleRenamed = await client.updateRule('workspace-1', ruleV1.id, {
      expectedRevision: ruleV2.revision,
      name: 'Pinned rule renamed',
    })
    expect(ruleRenamed.actions[0]).toMatchObject({ templateVersion: 2 })
    expect((await client.getTemplateVersion('workspace-1', templateV1.id, 1))?.payload)
      .toEqual({ title: 'Version one' })

    const recurringV1 = await client.createRecurringWork('workspace-1', {
      name: 'Pinned recurring work',
      teamId: 'core',
      enabled: true,
      templateId: templateV1.id,
      schedule: {
        frequency: 'daily',
        interval: 1,
        timeZone: 'UTC',
        localTime: '09:00',
        startDate: '2020-01-01',
        catchUpPolicy: 'latest',
      },
    })
    expect(recurringV1.templateVersion).toBe(templateV2.version)
    const recurringExecutionId = createRecurringExecutionId(
      recurringV1.workspaceId,
      recurringV1.id,
      recurringV1.nextRunAt,
    )
    await client.createExecution({
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: recurringExecutionId,
      workspaceId: recurringV1.workspaceId,
      ruleId: `recurring:${recurringV1.id}`,
      ruleVersion: recurringV1.version,
      triggerEventId: `recurring:${recurringV1.id}:${recurringV1.nextRunAt}`,
      status: 'pending',
      attempts: 0,
      actions: [{
        actionIndex: 0,
        actionId: createAutomationActionId(recurringExecutionId, 0),
        status: 'pending',
        attempts: 0,
      }],
      startedAt: recurringV1.nextRunAt,
      retryable: false,
    }, {
      eventId: `recurring:${recurringV1.id}:${recurringV1.nextRunAt}`,
      eventType: 'automation.schedule',
      workspaceId: recurringV1.workspaceId,
      occurredAt: recurringV1.nextRunAt,
      changes: [],
    })
    const scheduleEdited = await client.updateRecurringWork('workspace-1', recurringV1.id, {
      expectedRevision: recurringV1.revision,
      schedule: { ...recurringV1.schedule, localTime: '10:00' },
    })
    expect(scheduleEdited.nextRunAt).toBe(recurringV1.nextRunAt)
    const templateV3 = await client.updateTemplate('workspace-1', templateV1.id, {
      expectedRevision: templateV2.revision,
      payload: { title: 'Version three' },
    })
    const renamed = await client.updateRecurringWork('workspace-1', recurringV1.id, {
      expectedRevision: scheduleEdited.revision,
      name: 'Pinned recurring renamed',
    })
    expect(renamed).toMatchObject({
      templateVersion: templateV2.version,
      nextRunAt: recurringV1.nextRunAt,
    })
    const repinned = await client.updateRecurringWork('workspace-1', recurringV1.id, {
      expectedRevision: renamed.revision,
      templateId: templateV1.id,
    })
    expect(repinned.templateVersion).toBe(templateV3.version)
    await client.updateTemplate('workspace-1', templateV1.id, {
      expectedRevision: templateV3.revision,
      enabled: false,
    })
    const disabledRule = await client.updateRule('workspace-1', ruleV1.id, {
      expectedRevision: ruleRenamed.revision,
      enabled: false,
    })
    expect(disabledRule.actions[0]).toMatchObject({ templateVersion: 2 })
  })

  test('replays a pinned template application receipt after the current template is paused', async () => {
    const { documentClient } = createIdempotencyDocumentClient()
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const template = await client.createTemplate('workspace-1', {
      kind: 'project',
      name: 'Incident project',
      enabled: true,
      payload: { name: 'Incident response', tone: 'purple' },
    })
    const target = { kind: 'project' as const, teamId: 'core' }
    const application = await client.reserveTemplateApplication(
      'workspace-1',
      'owner@example.com',
      template.id,
      target,
      'apply-1',
    )
    await client.updateTemplate('workspace-1', template.id, {
      expectedRevision: template.revision,
      enabled: false,
    })

    expect(await client.reserveTemplateApplication(
      'workspace-1',
      'owner@example.com',
      template.id,
      target,
      'apply-1',
    )).toEqual(application)
    expect(application).toMatchObject({ status: 'pending', templateVersion: 1 })
    await expect(client.reserveTemplateApplication(
      'workspace-1',
      'owner@example.com',
      template.id,
      { kind: 'project', teamId: 'other' },
      'apply-1',
    )).rejects.toMatchObject({ code: 'IdempotencyConflict' })
  })

  test('keeps template kinds immutable and validates Project, Workflow, update, and approval payloads strictly', async () => {
    expect(validateCreateAutomationTemplateInput({
      kind: 'project',
      name: 'Project starter',
      enabled: true,
      payload: { nameJa: '障害対応', nameEn: 'Incident response', tone: 'green' },
    })).toMatchObject({ kind: 'project', payload: { tone: 'green' } })
    expect(validateCreateAutomationTemplateInput({
      kind: 'workflow',
      name: 'Delivery workflow',
      enabled: true,
      payload: {
        id: 'delivery',
        name: 'Delivery',
        initialStatusId: 'todo',
        statuses: [
          { id: 'todo', name: 'Todo', category: 'unstarted', sortOrder: 10, color: 'slate' },
          { id: 'done', name: 'Done', category: 'completed', sortOrder: 20, color: 'green' },
        ],
        transitions: [{ fromStatusId: 'todo', toStatusId: 'done' }],
      },
    })).toMatchObject({ kind: 'workflow', payload: { id: 'delivery' } })
    expect(() => validateCreateAutomationTemplateInput({
      kind: 'project',
      name: 'Unsafe',
      enabled: true,
      payload: { name: 'Unsafe', unexpected: true },
    })).toThrow('unsupported fields')
    expect(validateCreateAutomationRuleInput({
      name: 'Approval boundary',
      enabled: true,
      trigger: { type: 'status' },
      actions: [{
        type: 'approval',
        reviewerMemberKeys: Array.from({ length: 20 }, (_, index) => `reviewer-${index}@example.com`),
        dueInHours: 24,
      }],
    }).actions[0]).toMatchObject({ type: 'approval' })
    expect(() => validateCreateAutomationRuleInput({
      name: 'Too many reviewers',
      enabled: true,
      trigger: { type: 'status' },
      actions: [{
        type: 'approval',
        reviewerMemberKeys: Array.from({ length: 21 }, (_, index) => `reviewer-${index}@example.com`),
        dueInHours: 24,
      }],
    })).toThrow('Approval reviewers are invalid')
    expect(() => validateCreateAutomationRuleInput({
      name: 'Empty update',
      enabled: true,
      trigger: { type: 'status' },
      actions: [{ type: 'update', patch: {} }],
    })).toThrow('cannot be empty')
    expect(() => validateCreateAutomationRuleInput({
      name: 'Unsafe update',
      enabled: true,
      trigger: { type: 'status' },
      actions: [{ type: 'update', patch: { revision: 99 } }],
    })).toThrow('unsupported fields')

    const { documentClient } = createIdempotencyDocumentClient()
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const template = await client.createTemplate('workspace-1', {
      kind: 'project',
      name: 'Immutable kind',
      enabled: true,
      payload: { name: 'Project' },
    })
    await expect(client.updateTemplate('workspace-1', template.id, {
      expectedRevision: template.revision,
      kind: 'workflow',
      payload: {
        id: 'workflow',
        name: 'Workflow',
        initialStatusId: 'todo',
        statuses: [],
        transitions: [],
      },
    } as never)).rejects.toMatchObject({ code: 'InvalidAutomationInput' })
  })
})

test('fails closed when current-list pagination repeats the same cursor', async () => {
  const cursor = { scopeKey: 'workspace-1#automation', recordKey: 'RULE#cursor' }
  let queryCalls = 0
  const documentClient = {
    async send() {
      queryCalls += 1
      return { Items: [], LastEvaluatedKey: cursor }
    },
  } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
  const client = new DynamoDbAutomationClient('AutomationTable', documentClient)

  await expect(client.listRules('workspace-1')).rejects.toMatchObject({
    code: 'AutomationPaginationCursorLoop',
    retryable: true,
    status: 503,
  })
  expect(queryCalls).toBe(2)
})

test('claims only one template application runner and binds atomic completion to its lease', async () => {
  let stored: Record<string, unknown> = {
    scopeKey: 'workspace-1#automation',
    recordKey: 'TEMPLATE_APPLICATION#application-1',
    entryType: 'template-application',
    requestFingerprint: 'fingerprint',
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'application-1',
    workspaceId: 'workspace-1',
    actorId: 'owner@example.com',
    templateId: 'template-1',
    templateVersion: 1,
    kind: 'project',
    target: { kind: 'project', teamId: 'core' },
    status: 'pending',
    revision: 1,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  }
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      if (!command.input.UpdateExpression) return { Item: structuredClone(stored) }
      const values = command.input.ExpressionAttributeValues as Record<string, unknown>
      if (stored.revision !== values[':expectedRevision'] || stored.status !== 'pending') {
        throw Object.assign(new Error('ConditionalCheckFailed'), {
          name: 'ConditionalCheckFailedException',
        })
      }
      stored = {
        ...stored,
        status: 'running',
        revision: values[':nextRevision'],
        runnerLeaseExpiresAt: values[':runnerLeaseExpiresAt'],
        updatedAt: values[':updatedAt'],
      }
      return { Attributes: structuredClone(stored) }
    },
  } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
  const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
  const pending = {
    ...stored,
    target: { kind: 'project' as const, teamId: 'core' },
  } as unknown as AutomationTemplateApplication
  const now = new Date('2026-07-16T00:00:00.000Z')
  const leaseExpiresAt = '2026-07-16T00:05:00.000Z'
  const [first, second] = await Promise.all([
    client.claimTemplateApplication(pending, now, leaseExpiresAt),
    client.claimTemplateApplication(pending, now, leaseExpiresAt),
  ])

  expect([first, second].filter(Boolean)).toHaveLength(1)
  const claimed = (first ?? second)!
  expect(claimed).toMatchObject({ status: 'running', revision: 2, runnerLeaseExpiresAt: leaseExpiresAt })
  const completion = client.createTemplateApplicationCompletionTransactItem(claimed, {
    kind: 'project',
    teamId: 'core',
    projectId: claimed.id,
    name: 'Incident response',
  })
  expect(completion.Update).toMatchObject({
    ConditionExpression: expect.stringContaining('#runnerLeaseExpiresAt = :runnerLeaseExpiresAt'),
    ExpressionAttributeValues: {
      ':expectedRevision': 2,
      ':nextRevision': 3,
      ':runnerLeaseExpiresAt': leaseExpiresAt,
      ':running': 'running',
      ':succeeded': 'succeeded',
    },
  })
})

describe('automation trigger matching', () => {
  test('fails closed when a non-existence comparison path is missing', () => {
    const missingNotEquals = {
      type: 'field' as const,
      field: 'workItem.workflowStatusId',
      operator: 'not-equals' as const,
      value: 'done',
    }
    const context = { event: createEvent(), variables: {} }

    expect(evaluateAutomationCondition(missingNotEquals, context)).toBe(false)
    expect(evaluateAutomationCondition({
      type: 'not',
      condition: missingNotEquals,
    }, context)).toBe(true)
    expect(evaluateAutomationCondition({
      type: 'field',
      field: 'workItem.workflowStatusId',
      operator: 'not-exists',
    }, context)).toBe(true)
  })

  test('classifies root comments and replies by event type instead of rootCommentId metadata', () => {
    const rootComment = createEvent({
      eventType: 'comment.created',
      metadata: { rootCommentId: 'comment-root' },
      changes: [],
    })
    const reply = createEvent({
      eventId: 'event-reply',
      eventType: 'comment.replied',
      metadata: { rootCommentId: 'comment-root' },
      changes: [],
    })

    expect(matchesAutomationTrigger({ type: 'comment', kind: 'comment' }, rootComment)).toBe(true)
    expect(matchesAutomationTrigger({ type: 'comment', kind: 'reply' }, rootComment)).toBe(false)
    expect(matchesAutomationTrigger({ type: 'comment', kind: 'reply' }, reply)).toBe(true)
    expect(matchesAutomationTrigger({ type: 'comment', kind: 'comment' }, reply)).toBe(false)
    expect(matchesAutomationTrigger({ type: 'comment', kind: 'any' }, rootComment)).toBe(true)
    expect(matchesAutomationTrigger({ type: 'comment' }, reply)).toBe(true)
    expect(matchesAutomationTrigger({ type: 'comment' }, createEvent())).toBe(false)
  })
})

describe('automation execution safety', () => {
  test('ignores events from before the current rule version but still resumes an existing execution', async () => {
    const client = createMemoryClient()
    const rule = createRule({
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      version: 3,
      revision: 3,
    })
    const event = createEvent({ occurredAt: '2026-07-15T12:00:00.000Z' })
    let actionCalls = 0
    const engine = new AutomationEngine(client, {
      async execute() {
        actionCalls += 1
      },
    })

    expect(await engine.handleEvent(rule, event)).toBeUndefined()
    expect(actionCalls).toBe(0)
    const executionId = createAutomationExecutionId(rule, event.eventId)
    const pending = createExecution({
      id: executionId,
      ruleVersion: rule.version,
      triggerEventId: event.eventId,
      status: 'pending',
      attempts: 0,
      actions: rule.actions.map((_action, actionIndex) => ({
        actionIndex,
        actionId: createAutomationActionId(executionId, actionIndex),
        status: 'pending',
        attempts: 0,
      })),
      completedAt: undefined,
      nextRetryAt: undefined,
      retryable: false,
    })
    await client.createExecution(pending, event)
    client.rules.set(`${rule.id}\0${rule.version}`, rule)

    expect(await engine.handleEvent(rule, event)).toMatchObject({ status: 'succeeded' })
    expect(actionCalls).toBe(rule.actions.length)
  })

  test('retries recurring dead letters from the stored pinned event without a rule lookup', async () => {
    const client = createMemoryClient()
    const scheduledFor = '2026-07-16T09:00:00.000Z'
    const executionId = createRecurringExecutionId('workspace-1', 'weekly-review', scheduledFor)
    const actionId = createAutomationActionId(executionId, 0)
    const event = createEvent({
      eventId: `recurring:weekly-review:${scheduledFor}`,
      eventType: 'automation.schedule',
      occurredAt: scheduledFor,
      changes: [],
      metadata: {
        recurringWorkId: 'weekly-review',
        scheduledFor,
        teamId: 'core-team',
        templateId: 'template-weekly-review',
        templateVersion: 7,
      },
    })
    const execution = createExecution({
      id: executionId,
      ruleId: 'recurring:weekly-review',
      ruleVersion: 4,
      triggerEventId: event.eventId,
      status: 'dead-letter',
      attempts: 5,
      actions: [{
        actionIndex: 0,
        actionId,
        status: 'failed',
        attempts: 5,
      }],
      nextRetryAt: undefined,
      retryable: false,
    })
    client.recurringWorks.set('weekly-review', {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'weekly-review',
      workspaceId: 'workspace-1',
      teamId: 'core-team',
      name: 'Weekly review',
      enabled: true,
      version: 4,
      revision: 4,
      templateId: 'template-weekly-review',
      templateVersion: 7,
      schedule: {
        frequency: 'weekly',
        interval: 1,
        timeZone: 'UTC',
        localTime: '09:00',
        startDate: '2026-07-16',
        daysOfWeek: [4],
        catchUpPolicy: 'skip',
      },
      nextRunAt: scheduledFor,
      createdAt: scheduledFor,
      updatedAt: scheduledFor,
    })
    client.executions.set(executionId, structuredClone(execution))
    client.events.set(executionId, structuredClone(event))
    const actions: unknown[] = []
    const engine = new AutomationEngine(client, {
      async execute(action) {
        actions.push(structuredClone(action))
      },
    })

    expect(await engine.retryExecution('workspace-1', executionId, undefined, new Date(scheduledFor)))
      .toMatchObject({ status: 'succeeded' })
    expect(actions).toEqual([{
      type: 'create',
      templateId: 'template-weekly-review',
      templateVersion: 7,
      values: { teamId: 'core-team' },
    }])
    expect(client.receipts.has(`${executionId}\0${actionId}`)).toBe(true)

    expect(await engine.retryExecution('workspace-1', executionId, undefined, new Date(scheduledFor)))
      .toMatchObject({ status: 'succeeded' })
    expect(actions).toHaveLength(1)
  })

  test('retries transient adapter failures by status or AWS retry metadata only', async () => {
    const client = createMemoryClient()
    const rule = createRule({
      actions: [{ type: 'comment', body: 'Retry transient failure' }],
      retryPolicy: { maxAttempts: 3, initialDelayMs: 0, backoffMultiplier: 2, maxDelayMs: 1_000 },
    })
    let attempts = 0
    const engine = new AutomationEngine(client, {
      async execute() {
        attempts += 1
        if (attempts === 1) {
          throw Object.assign(new Error('DynamoDB throttled.'), {
            name: 'ProvisionedThroughputExceededException',
            $retryable: { throttling: true },
          })
        }
      },
    })
    const failed = await engine.handleEvent(rule, createEvent(), {}, new Date('2026-07-16T00:00:00.000Z'))
    expect(failed).toMatchObject({ status: 'failed', retryable: true })
    const recovered = await engine.retryExecution(
      rule.workspaceId,
      failed!.id,
      undefined,
      new Date('2026-07-16T00:00:00.001Z'),
    )
    expect(recovered).toMatchObject({ status: 'succeeded', retryable: false })

    const invalidRule = createRule({ id: 'rule-invalid' })
    const invalidEngine = new AutomationEngine(createMemoryClient(), {
      async execute() {
        throw Object.assign(new Error('Invalid update.'), { code: 'ValidationException', status: 400 })
      },
    })
    expect(await invalidEngine.handleEvent(invalidRule, createEvent({ eventId: 'event-invalid' })))
      .toMatchObject({ status: 'dead-letter', nextRetryAt: undefined })
  })

  test('redacts untrusted action failure details before they reach durable history', () => {
    const secret = 'outbound-secret-value'
    const awsFailure = Object.assign(new Error(`Request exposed ${secret}.`), {
      name: 'ProvisionedThroughputExceededException',
      $retryable: { throttling: true },
    })
    const normalizedAwsFailure = normalizeAutomationActionFailure(awsFailure)

    expect(normalizedAwsFailure).toEqual({
      code: 'ProvisionedThroughputExceededException',
      message: 'Automation action failed.',
      retryable: true,
    })
    expect(JSON.stringify(normalizedAwsFailure)).not.toContain(secret)

    const untrustedCodeFailure = normalizeAutomationActionFailure(Object.assign(
      new Error(`Adapter exposed ${secret}.`),
      { code: secret },
    ))
    expect(untrustedCodeFailure).toEqual({
      code: 'AutomationActionFailed',
      message: 'Automation action failed.',
      retryable: false,
    })
    expect(JSON.stringify(untrustedCodeFailure)).not.toContain(secret)

    expect(normalizeAutomationActionFailure(
      new AutomationError(409, 'TrustedAutomationFailure', 'Safe domain message.'),
    )).toEqual({
      code: 'TrustedAutomationFailure',
      message: 'Safe domain message.',
      retryable: false,
    })
  })

  test('lists workspace execution history newest-first through its sparse index', async () => {
    const commands: Array<{ input: Record<string, unknown> }> = []
    const lastEvaluatedKey = {
      scopeKey: 'workspace-1#automation',
      recordKey: 'EXECUTION#automation_older',
      startedAtExecutionId: '2026-07-15T00:00:00.000Z#automation_older',
    }
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command)
        return commands.length === 1 ? { Items: [], LastEvaluatedKey: lastEvaluatedKey } : { Items: [] }
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)

    const firstPage = await client.listExecutions({ workspaceId: 'workspace-1', limit: 25 })
    await client.listExecutions({
      workspaceId: 'workspace-1',
      limit: 25,
      cursor: firstPage.nextCursor,
    })

    expect(commands[0]?.input).toMatchObject({
      IndexName: 'WorkspaceExecutionIndex',
      KeyConditionExpression: '#scopeKey = :scopeKey',
      ExpressionAttributeNames: { '#scopeKey': 'scopeKey' },
      ExpressionAttributeValues: { ':scopeKey': 'workspace-1#automation' },
      Limit: 25,
      ScanIndexForward: false,
    })
    expect(commands[0]?.input).not.toHaveProperty('FilterExpression')
    expect(commands[1]?.input).toMatchObject({ ExclusiveStartKey: lastEvaluatedKey })
  })

  test('fills status-filtered execution pages across DynamoDB evaluated pages', async () => {
    const commands: Array<{ input: Record<string, unknown> }> = []
    const firstCursor = {
      scopeKey: 'workspace-1#automation',
      recordKey: 'EXECUTION#evaluated-1',
      startedAtExecutionId: '2026-07-16T03:00:00.000Z#evaluated-1',
    }
    const secondCursor = {
      scopeKey: 'workspace-1#automation',
      recordKey: 'EXECUTION#evaluated-2',
      startedAtExecutionId: '2026-07-16T02:00:00.000Z#evaluated-2',
    }
    const thirdCursor = {
      scopeKey: 'workspace-1#automation',
      recordKey: 'EXECUTION#succeeded-2',
      startedAtExecutionId: '2026-07-16T01:00:00.000Z#succeeded-2',
    }
    const storageItem = (id: string, startedAt: string) => ({
      scopeKey: 'workspace-1#automation',
      recordKey: `EXECUTION#${id}`,
      entryType: 'execution',
      ...createExecution({
        id,
        status: 'succeeded',
        startedAt,
        completedAt: startedAt,
        nextRetryAt: undefined,
        retryable: false,
      }),
      startedAtExecutionId: `${startedAt}#${id}`,
    })
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command)
        const cursor = command.input.ExclusiveStartKey
        if (!cursor) {
          return {
            Items: [storageItem('succeeded-1', '2026-07-16T04:00:00.000Z')],
            LastEvaluatedKey: firstCursor,
          }
        }
        if (cursor === firstCursor) {
          return { Items: [], LastEvaluatedKey: secondCursor }
        }
        if (cursor === secondCursor) {
          return {
            Items: [storageItem('succeeded-2', '2026-07-16T01:00:00.000Z')],
            LastEvaluatedKey: thirdCursor,
          }
        }
        return {
          Items: [storageItem('succeeded-3', '2026-07-16T00:00:00.000Z')],
        }
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)

    const firstPage = await client.listExecutions({
      workspaceId: 'workspace-1',
      status: 'succeeded',
      limit: 2,
    })
    const secondPage = await client.listExecutions({
      workspaceId: 'workspace-1',
      status: 'succeeded',
      limit: 2,
      cursor: firstPage.nextCursor,
    })

    expect(firstPage.executions.map((execution) => execution.id)).toEqual([
      'succeeded-1',
      'succeeded-2',
    ])
    expect(firstPage.nextCursor).toBeDefined()
    expect(secondPage.executions.map((execution) => execution.id)).toEqual(['succeeded-3'])
    expect(secondPage.nextCursor).toBeUndefined()
    expect(commands.map((command) => command.input.Limit)).toEqual([2, 1, 1, 2])
    expect(commands[3]?.input.ExclusiveStartKey).toEqual(thirdCursor)
    for (const command of commands) {
      expect(command.input).toMatchObject({
        FilterExpression: '#status = :status',
        ExpressionAttributeNames: {
          '#scopeKey': 'scopeKey',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':scopeKey': 'workspace-1#automation',
          ':status': 'succeeded',
        },
      })
    }
  })

  test('bounds status-filtered execution reads and returns a continuation cursor', async () => {
    const commands: Array<{ input: Record<string, unknown> }> = []
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command)
        const page = commands.length
        return {
          Items: [],
          ScannedCount: command.input.Limit,
          LastEvaluatedKey: {
            scopeKey: 'workspace-1#automation',
            recordKey: `EXECUTION#evaluated-${page}`,
            startedAtExecutionId: `2026-07-16T00:00:0${page}.000Z#evaluated-${page}`,
          },
        }
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)

    const page = await client.listExecutions({
      workspaceId: 'workspace-1',
      status: 'failed',
      limit: 2,
    })

    expect(page.executions).toEqual([])
    expect(page.nextCursor).toBeDefined()
    expect(commands).toHaveLength(5)
    expect(commands.map((command) => command.input.Limit)).toEqual([2, 2, 2, 2, 2])
  })

  test('creates and validates the local workspace execution index', async () => {
    const createCommands: Array<{ input: Record<string, unknown> }> = []
    const missingTableClient = {
      async send(command: { input: Record<string, unknown> }) {
        if (createCommands.length === 0) {
          createCommands.push(command)
          throw Object.assign(new Error('missing table'), { name: 'ResourceNotFoundException' })
        }
        createCommands.push(command)
        return {}
      },
    } as unknown as Parameters<typeof ensureLocalAutomationTable>[1]

    await ensureLocalAutomationTable('AutomationTable', missingTableClient)

    expect(createCommands[1]?.input).toMatchObject({
      GlobalSecondaryIndexes: expect.arrayContaining([
        {
          IndexName: 'ScheduleDueIndex',
          KeySchema: [
            { AttributeName: 'scheduleShard', KeyType: 'HASH' },
            { AttributeName: 'nextRunAtRecordKey', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'WorkspaceExecutionIndex',
          KeySchema: [
            { AttributeName: 'scopeKey', KeyType: 'HASH' },
            { AttributeName: 'startedAtExecutionId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ]),
    })

    const staleTableClient = {
      async send() {
        return {
          Table: {
            KeySchema: [
              { AttributeName: 'scopeKey', KeyType: 'HASH' },
              { AttributeName: 'recordKey', KeyType: 'RANGE' },
            ],
            GlobalSecondaryIndexes: [
              {
                IndexName: 'ScheduleDueIndex',
                KeySchema: [
                  { AttributeName: 'scheduleShard', KeyType: 'HASH' },
                  { AttributeName: 'nextRunAtRecordKey', KeyType: 'RANGE' },
                ],
              },
              {
                IndexName: 'RuleExecutionIndex',
                KeySchema: [
                  { AttributeName: 'ruleExecutionKey', KeyType: 'HASH' },
                  { AttributeName: 'startedAtExecutionId', KeyType: 'RANGE' },
                ],
              },
            ],
          },
        }
      },
    } as unknown as Parameters<typeof ensureLocalAutomationTable>[1]
    await expect(ensureLocalAutomationTable('AutomationTable', staleTableClient))
      .rejects.toThrow('incompatible schema')
  })

  test('stores retryable failures and running leases in the shared sparse due index', async () => {
    const commands: Array<{ input: Record<string, unknown> }> = []
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command)
        if (command.input.Key) {
          return {
            Item: {
              entryType: 'execution',
              triggerEvent: createEvent(),
            },
          }
        }
        return {}
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const failed = createExecution()
    const claimToken = {
      attempt: failed.attempts,
      leaseExpiresAt: '2026-07-16T00:05:00.000Z',
    }
    const savedAt = new Date('2026-07-16T00:00:00.000Z')

    await client.saveExecution(failed, claimToken, savedAt)
    await client.saveExecution({
      ...failed,
      status: 'running',
      retryable: false,
      nextRetryAt: '2026-07-16T00:05:00.000Z',
    }, claimToken, savedAt)
    await client.saveExecution({
      ...failed,
      status: 'succeeded',
      retryable: false,
      nextRetryAt: undefined,
    }, claimToken, savedAt)
    await client.saveExecution({
      ...failed,
      status: 'dead-letter',
      nextRetryAt: undefined,
    }, claimToken, savedAt)
    await client.saveExecution({
      ...failed,
      ruleId: 'recurring:recurring-1',
    }, claimToken, savedAt)

    const items = commands.flatMap((command) => {
      const item = command.input.Item
      return item && typeof item === 'object' ? [item as Record<string, unknown>] : []
    })
    expect(items).toHaveLength(5)
    expect(items[0]).toMatchObject({
      entryType: 'execution',
      ruleExecutionKey: 'workspace-1#rule#rule-1',
      startedAtExecutionId: '2026-07-16T00:00:00.000Z#automation_execution_1',
      scheduleShard: expect.stringMatching(/^schedule-\d{2}$/),
      nextRunAtRecordKey: '2026-07-16T00:01:00.000Z#execution#automation_execution_1',
    })
    expect(items[1]).toMatchObject({
      scheduleShard: expect.stringMatching(/^schedule-\d{2}$/),
      nextRunAtRecordKey: '2026-07-16T00:05:00.000Z#execution#automation_execution_1',
    })
    for (const terminalItem of items.slice(2)) {
      expect(terminalItem).not.toHaveProperty('scheduleShard')
      expect(terminalItem).not.toHaveProperty('nextRunAtRecordKey')
      expect(terminalItem).toMatchObject({
        startedAtExecutionId: '2026-07-16T00:00:00.000Z#automation_execution_1',
      })
    }
  })

  test('claims a single execution runner with status and attempt CAS plus a durable lease', async () => {
    const commands: Array<{ input: Record<string, unknown> }> = []
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command)
        return {}
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const pending = createExecution({
      status: 'pending',
      attempts: 0,
      completedAt: undefined,
      nextRetryAt: undefined,
      retryable: false,
    })

    const claimed = await client.claimExecution(
      pending,
      new Date('2026-07-16T00:00:00.000Z'),
      '2026-07-16T00:05:00.000Z',
    )

    expect(claimed).toBe(true)
    expect(commands[0]?.input).toMatchObject({
      Key: {
        scopeKey: 'workspace-1#automation',
        recordKey: 'EXECUTION#automation_execution_1',
      },
      ConditionExpression: '#status = :expectedStatus AND #attempts = :expectedAttempts',
      ExpressionAttributeValues: {
        ':running': 'running',
        ':nextAttempts': 1,
        ':leaseExpiresAt': '2026-07-16T00:05:00.000Z',
        ':expectedStatus': 'pending',
        ':expectedAttempts': 0,
      },
    })
    expect(String(commands[0]?.input.UpdateExpression)).toContain('#nextRunAtRecordKey = :nextRunAtRecordKey')
  })

  test('claims a recurring runner only while its exact current definition remains enabled', async () => {
    const commands: Array<{ input: Record<string, unknown> }> = []
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command)
        return {}
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const pending = createExecution({
      ruleId: 'recurring:recurring-1',
      status: 'pending',
      attempts: 0,
      completedAt: undefined,
      nextRetryAt: undefined,
      retryable: false,
    })

    expect(await client.claimExecution(
      pending,
      new Date('2026-07-16T00:00:00.000Z'),
      '2026-07-16T00:05:00.000Z',
      { kind: 'recurring', id: 'recurring-1', version: 3, revision: 7 },
    )).toBe(true)

    expect(commands[0]?.input).toMatchObject({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: 'AutomationTable',
            Key: {
              scopeKey: 'workspace-1#automation',
              recordKey: 'RECURRING#recurring-1',
            },
            ExpressionAttributeValues: {
              ':enabled': true,
              ':entryType': 'recurring',
              ':id': 'recurring-1',
              ':version': 3,
              ':revision': 7,
            },
          },
        },
        {
          Update: {
            Key: {
              scopeKey: 'workspace-1#automation',
              recordKey: 'EXECUTION#automation_execution_1',
            },
            ConditionExpression: '#status = :expectedStatus AND #attempts = :expectedAttempts',
          },
        },
      ],
    })
  })

  test('fences a stale execution save after an expired lease is taken over', async () => {
    const triggerEvent = createEvent()
    const pending = createExecution({
      status: 'pending',
      attempts: 0,
      completedAt: undefined,
      nextRetryAt: undefined,
      retryable: false,
    })
    let stored: Record<string, unknown> = {
      scopeKey: 'workspace-1#automation',
      recordKey: 'EXECUTION#automation_execution_1',
      entryType: 'execution',
      ...pending,
      triggerEvent,
    }
    const putInputs: Record<string, unknown>[] = []
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        const input = command.input
        if (input.UpdateExpression) {
          const values = input.ExpressionAttributeValues as Record<string, unknown>
          const expectedStatus = values[':expectedStatus']
          const expectedAttempts = values[':expectedAttempts']
          const leaseAvailable = expectedStatus !== 'running' ||
            typeof stored.nextRetryAt !== 'string' ||
            stored.nextRetryAt <= String(values[':now'])
          if (
            stored.status !== expectedStatus ||
            stored.attempts !== expectedAttempts ||
            !leaseAvailable
          ) {
            throw Object.assign(new Error('ConditionalCheckFailed'), {
              name: 'ConditionalCheckFailedException',
            })
          }
          stored = {
            ...stored,
            status: 'running',
            attempts: values[':nextAttempts'],
            retryable: false,
            nextRetryAt: values[':leaseExpiresAt'],
          }
          return {}
        }
        if (input.Item) {
          putInputs.push(input)
          const values = input.ExpressionAttributeValues as Record<string, unknown>
          if (
            stored.status !== values[':running'] ||
            stored.attempts !== values[':expectedAttempt'] ||
            stored.nextRetryAt !== values[':expectedLeaseExpiresAt'] ||
            String(stored.nextRetryAt) <= String(values[':now'])
          ) {
            throw Object.assign(new Error('ConditionalCheckFailed'), {
              name: 'ConditionalCheckFailedException',
            })
          }
          stored = structuredClone(input.Item as Record<string, unknown>)
          return {}
        }
        return { Item: structuredClone(stored) }
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const firstLeaseExpiresAt = '2026-07-16T00:05:00.000Z'
    const secondLeaseExpiresAt = '2026-07-16T00:10:00.000Z'

    expect(await client.claimExecution(
      pending,
      new Date('2026-07-16T00:00:00.000Z'),
      firstLeaseExpiresAt,
    )).toBe(true)
    const firstRunner = await client.getExecution(pending.workspaceId, pending.id)
    expect(firstRunner).toMatchObject({ status: 'running', attempts: 1, nextRetryAt: firstLeaseExpiresAt })
    expect(await client.claimExecution(
      firstRunner!,
      new Date(firstLeaseExpiresAt),
      secondLeaseExpiresAt,
    )).toBe(true)

    const staleCompletion: AutomationExecution = {
      ...firstRunner!,
      status: 'succeeded',
      retryable: false,
      nextRetryAt: undefined,
      completedAt: '2026-07-16T00:05:01.000Z',
    }
    expect(await client.saveExecution(
      staleCompletion,
      { attempt: 1, leaseExpiresAt: firstLeaseExpiresAt },
      new Date('2026-07-16T00:05:01.000Z'),
    )).toBe(false)
    expect(stored).toMatchObject({
      status: 'running',
      attempts: 2,
      nextRetryAt: secondLeaseExpiresAt,
    })
    expect(putInputs[0]).toMatchObject({
      ConditionExpression: expect.stringContaining('#nextRetryAt > :now'),
      ExpressionAttributeValues: {
        ':running': 'running',
        ':expectedAttempt': 1,
        ':expectedLeaseExpiresAt': firstLeaseExpiresAt,
        ':now': '2026-07-16T00:05:01.000Z',
      },
    })

    const secondRunner = await client.getExecution(pending.workspaceId, pending.id)
    expect(await client.saveExecution({
      ...secondRunner!,
      status: 'succeeded',
      retryable: false,
      nextRetryAt: undefined,
      completedAt: '2026-07-16T00:06:00.000Z',
    }, {
      attempt: 2,
      leaseExpiresAt: secondLeaseExpiresAt,
    }, new Date('2026-07-16T00:06:00.000Z'))).toBe(true)
    expect(stored).toMatchObject({ status: 'succeeded', attempts: 2 })
  })

  test('queries due executions through ScheduleDueIndex without timeline fields leaking', async () => {
    const commands: Array<{ input: Record<string, unknown> }> = []
    const execution = createExecution()
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command)
        return {
          Items: [{
            scopeKey: 'workspace-1#automation',
            recordKey: 'EXECUTION#automation_execution_1',
            entryType: 'execution',
            ...execution,
            triggerEvent: createEvent(),
            scheduleShard: 'schedule-03',
            nextRunAtRecordKey: '2026-07-16T00:01:00.000Z#execution#automation_execution_1',
            ruleExecutionKey: 'workspace-1#rule#rule-1',
            startedAtExecutionId: '2026-07-16T00:00:00.000Z#automation_execution_1',
          }],
        }
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)

    const results = await client.listDueExecutions(
      'schedule-03',
      '2026-07-16T00:01:00.000Z',
      25,
    )

    expect(commands[0]?.input).toMatchObject({
      IndexName: 'ScheduleDueIndex',
      KeyConditionExpression: '#scheduleShard = :scheduleShard AND #nextRunAtRecordKey <= :due',
      ExpressionAttributeValues: {
        ':scheduleShard': 'schedule-03',
        ':due': '2026-07-16T00:01:00.000Z#￿',
      },
      Limit: 25,
    })
    expect(results).toEqual([execution])
  })

  test('reserves the execution and fixed-window rate token atomically', async () => {
    const commands: Array<{ input: Record<string, unknown> }> = []
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command)
        return {}
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const rule = createRule({ rateLimit: { maxExecutions: 2, windowSeconds: 60 } })

    const result = await client.reserveExecution(
      rule,
      createEvent(),
      new Date('2026-07-16T00:00:30.000Z'),
    )

    expect(result).toBe('created')
    expect(commands[0]?.input).toMatchObject({
      TransactItems: [
        { ConditionCheck: {
          ConditionExpression: expect.stringContaining('#enabled = :enabled'),
          ExpressionAttributeValues: {
            ':enabled': true,
            ':entryType': 'rule',
            ':id': rule.id,
            ':revision': rule.revision,
            ':version': rule.version,
          },
          Key: { recordKey: `RULE#${rule.id}` },
        } },
        { Put: {
          ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
          Item: { entryType: 'execution', ruleId: rule.id },
        } },
        { Update: {
          ConditionExpression: 'attribute_not_exists(#executionCount) OR #executionCount < :maximumExecutions',
          ExpressionAttributeValues: {
            ':maximumExecutions': 2,
            ':one': 1,
          },
          Key: {
            recordKey: expect.stringMatching(/^RATE#.+#\d+$/),
          },
        } },
      ],
    })
  })

  test('creates a recurring execution with an exact enabled definition guard', async () => {
    const commands: Array<{ input: Record<string, unknown> }> = []
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command)
        return {}
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
    const execution = createExecution({
      ruleId: 'recurring:recurring-1',
      ruleVersion: 3,
    })

    expect(await client.createExecution(execution, createEvent(), {
      kind: 'recurring',
      id: 'recurring-1',
      version: 3,
      revision: 7,
    })).toBe(true)
    expect(commands[0]?.input).toMatchObject({
      TransactItems: [
        { ConditionCheck: {
          ConditionExpression: expect.stringContaining('#enabled = :enabled'),
          ExpressionAttributeValues: {
            ':enabled': true,
            ':entryType': 'recurring',
            ':id': 'recurring-1',
            ':revision': 7,
            ':version': 3,
          },
          Key: { recordKey: 'RECURRING#recurring-1' },
        } },
        { Put: {
          ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
          Item: { entryType: 'execution', id: execution.id },
        } },
      ],
    })
  })

  test('skips a stale rule snapshot when the current definition changes before reservation', async () => {
    const rule = createRule({ rateLimit: { maxExecutions: 2, windowSeconds: 60 } })
    const documentClient = {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        if (command.constructor.name === 'TransactWriteCommand') {
          throw Object.assign(new Error('definition condition failed'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [
              { Code: 'ConditionalCheckFailed' },
              { Code: 'None' },
              { Code: 'None' },
            ],
          })
        }
        if (command.constructor.name === 'GetCommand') {
          const key = command.input.Key as Record<string, unknown>
          if (String(key.recordKey).startsWith('EXECUTION#')) return {}
          if (String(key.recordKey).startsWith('RULE#')) {
            return {
              Item: {
                scopeKey: 'workspace-1#automation',
                recordKey: key.recordKey,
                entryType: 'rule',
                ...rule,
                enabled: false,
                version: rule.version + 1,
                revision: rule.revision + 1,
              },
            }
          }
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`)
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
    const client = new DynamoDbAutomationClient('AutomationTable', documentClient)

    expect(await client.reserveExecution(
      rule,
      createEvent(),
      new Date('2026-07-16T00:00:30.000Z'),
    )).toBe('stale-definition')

    let actionExecutions = 0
    const engine = new AutomationEngine({
      async getExecution() {
        return undefined
      },
      async reserveExecution() {
        return 'stale-definition'
      },
    } as unknown as AutomationClient, {
      async execute() {
        actionExecutions += 1
      },
    })
    expect(await engine.handleEvent(
      rule,
      createEvent(),
      {},
      new Date('2026-07-16T00:00:30.000Z'),
    )).toBeUndefined()
    expect(actionExecutions).toBe(0)
  })

  test('deduplicates a completed durable event after the current rule version changes', async () => {
    const client = createMemoryClient()
    const calls: string[] = []
    const engine = new AutomationEngine(client, {
      async execute(action) {
        calls.push(action.type === 'comment' ? action.body : action.type)
      },
    })
    const rule = createRule()
    const updatedRule = createRule({
      version: 2,
      revision: 2,
      trigger: { type: 'form', formId: 'changed-trigger' },
      actions: [{ type: 'comment', body: 'New version action' }],
    })
    const event = createEvent()
    const first = await engine.handleEvent(rule, event, {}, new Date('2026-07-16T00:00:00.000Z'))
    const duplicate = await engine.handleEvent(
      updatedRule,
      event,
      {},
      new Date('2026-07-16T00:01:00.000Z'),
    )

    expect(first?.status).toBe('succeeded')
    expect(duplicate?.id).toBe(first?.id)
    expect(duplicate?.ruleVersion).toBe(1)
    expect(calls).toEqual(['First', 'notify'])
    expect(client.executions.size).toBe(1)
  })

  test('allows only one runner during concurrent delivery of the same event', async () => {
    const client = createMemoryClient()
    const rule = createRule({ actions: [{ type: 'comment', body: 'Run once' }] })
    const event = createEvent()
    let actionExecutions = 0
    let markActionStarted = () => {}
    let releaseAction = () => {}
    const actionStarted = new Promise<void>((resolve) => {
      markActionStarted = () => resolve()
    })
    const actionReleased = new Promise<void>((resolve) => {
      releaseAction = () => resolve()
    })
    const engine = new AutomationEngine(client, {
      async execute() {
        actionExecutions += 1
        markActionStarted()
        await actionReleased
      },
    })

    const firstDelivery = engine.handleEvent(
      rule,
      event,
      {},
      new Date('2026-07-16T00:00:00.000Z'),
    )
    await actionStarted
    const concurrentDelivery = await engine.handleEvent(
      rule,
      event,
      {},
      new Date('2026-07-16T00:00:01.000Z'),
    )

    expect(concurrentDelivery).toMatchObject({
      status: 'running',
      attempts: 1,
      nextRetryAt: '2026-07-16T00:05:00.000Z',
    })
    expect(actionExecutions).toBe(1)
    releaseAction()
    const completed = await firstDelivery
    expect(completed?.status).toBe('succeeded')
    expect(actionExecutions).toBe(1)
    expect(client.receipts.size).toBe(1)
  })

  test('stops a stale runner before the next action after another runner takes over', async () => {
    const client = createMemoryClient()
    const rule = createRule()
    const event = createEvent()
    const actionIndexes: number[] = []
    const takeoverLeaseExpiresAt = '2026-07-16T00:10:00.000Z'
    const engine = new AutomationEngine(client, {
      async execute(_action, context) {
        actionIndexes.push(context.actionIndex)
        if (context.actionIndex !== 0) return
        const stored = client.executions.get(context.execution.id)!
        client.executions.set(context.execution.id, {
          ...structuredClone(stored),
          status: 'running',
          attempts: stored.attempts + 1,
          nextRetryAt: takeoverLeaseExpiresAt,
        })
      },
    })

    const result = await engine.handleEvent(
      rule,
      event,
      {},
      new Date('2026-07-16T00:00:00.000Z'),
    )

    expect(actionIndexes).toEqual([0])
    expect(result).toMatchObject({
      status: 'running',
      attempts: 2,
      nextRetryAt: takeoverLeaseExpiresAt,
    })
    expect(client.executions.get(result!.id)).toMatchObject({
      status: 'running',
      attempts: 2,
      nextRetryAt: takeoverLeaseExpiresAt,
    })
    expect(client.receipts.has(`${result!.id}\0${createAutomationActionId(result!.id, 0)}`)).toBe(true)
  })

  test('resumes a stranded pending execution with its stored rule version before current matching', async () => {
    const client = createMemoryClient()
    const originalClaimExecution = client.claimExecution.bind(client)
    let failBeforeAction = true
    client.claimExecution = async (execution, now, leaseExpiresAt) => {
      if (failBeforeAction) {
        failBeforeAction = false
        throw new AutomationError(503, 'TemporaryPersistenceFailure', 'Retry delivery.', true)
      }
      return await originalClaimExecution(execution, now, leaseExpiresAt)
    }
    const calls: string[] = []
    const engine = new AutomationEngine(client, {
      async execute(action) {
        calls.push(action.type === 'comment' ? action.body : action.type)
      },
    })
    const rule = createRule({ actions: [{ type: 'comment', body: 'Resume me' }] })
    const updatedRule = createRule({
      version: 2,
      revision: 2,
      trigger: { type: 'form', formId: 'no-longer-matches' },
      actions: [
        { type: 'comment', body: 'Do not run v2' },
        { type: 'comment', body: 'Also do not run v2' },
      ],
    })
    const event = createEvent()

    await expect(engine.handleEvent(rule, event)).rejects.toMatchObject({
      code: 'TemporaryPersistenceFailure',
    })
    expect(calls).toEqual([])

    const resumed = await engine.handleEvent(
      updatedRule,
      event,
      {},
      new Date('2026-07-16T00:01:00.000Z'),
    )
    expect(resumed?.status).toBe('succeeded')
    expect(resumed?.ruleVersion).toBe(1)
    expect(resumed?.actions).toHaveLength(1)
    expect(calls).toEqual(['Resume me'])
    expect(client.executions.size).toBe(1)
  })

  test('retries from the failed action and skips successful receipts', async () => {
    const client = createMemoryClient()
    const rule = createRule()
    client.rules.set(`${rule.id}\0${rule.version}`, rule)
    const calls = [0, 0]
    const engine = new AutomationEngine(client, {
      async execute(_action, context) {
        calls[context.actionIndex] = (calls[context.actionIndex] ?? 0) + 1
        if (context.actionIndex === 1 && calls[1] === 1) {
          throw new AutomationError(503, 'TemporaryActionFailure', 'Try again.', true)
        }
      },
    })
    const event = createEvent()
    const failed = await engine.handleEvent(rule, event, {}, new Date('2026-07-16T00:00:00.000Z'))
    const retried = await engine.retryExecution(
      rule.workspaceId,
      failed!.id,
      event,
      new Date('2026-07-16T00:00:01.000Z'),
    )

    expect(failed).toMatchObject({
      status: 'failed',
      retryable: true,
      nextRetryAt: '2026-07-16T00:00:00.000Z',
    })
    expect(retried.status).toBe('succeeded')
    expect(calls).toEqual([1, 2])
  })

  test('prevents loops/rate overflow and dead-letters exhausted failures', async () => {
    let calls = 0
    const executor = {
      async execute() {
        calls += 1
        throw new AutomationError(503, 'StillFailing', 'Still failing.', true)
      },
    }
    const rule = createRule({
      actions: [{ type: 'comment', body: 'Only action' }],
      retryPolicy: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
    })
    const loop = await new AutomationEngine(createMemoryClient(), executor).handleEvent(
      rule,
      createEvent({ automationRuleLineage: [rule.id] }),
    )
    expect(loop).toMatchObject({ status: 'skipped', errorCode: 'AutomationLoopPrevented' })

    const limited = await new AutomationEngine(createMemoryClient(true), executor).handleEvent(
      createRule({ rateLimit: { maxExecutions: 1, windowSeconds: 60 } }),
      createEvent(),
    )
    expect(limited).toMatchObject({ status: 'skipped', errorCode: 'AutomationRateLimitExceeded' })

    const client = createMemoryClient()
    client.rules.set(`${rule.id}\0${rule.version}`, rule)
    const engine = new AutomationEngine(client, executor)
    const event = createEvent()
    const deadLetter = await engine.handleEvent(rule, event)
    expect(deadLetter).toMatchObject({ status: 'dead-letter', retryable: true })

    const retried = await engine.retryExecution(
      rule.workspaceId,
      deadLetter!.id,
      event,
      new Date('2026-07-16T00:01:00.000Z'),
    )
    expect(retried).toMatchObject({ status: 'dead-letter', retryable: true, attempts: 2 })
    expect(calls).toBe(2)
  })
})

describe('recurring schedule timezone behavior', () => {
  test('shifts a spring-forward gap to the first valid local minute', () => {
    const schedule: RecurringSchedule = {
      frequency: 'daily',
      interval: 1,
      timeZone: 'America/New_York',
      localTime: '02:30',
      startDate: '2026-03-07',
      catchUpPolicy: 'all',
    }
    const occurrences = getRecurringOccurrences(
      schedule,
      new Date('2026-03-07T00:00:00.000Z'),
      new Date('2026-03-10T00:00:00.000Z'),
    )
    expect(occurrences.map((value) => value.toISOString())).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-08T07:00:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ])
  })

  test('uses the earlier instant once during a fall-back overlap', () => {
    const schedule: RecurringSchedule = {
      frequency: 'daily',
      interval: 1,
      timeZone: 'America/New_York',
      localTime: '01:30',
      startDate: '2026-10-31',
      catchUpPolicy: 'all',
    }
    const occurrences = getRecurringOccurrences(
      schedule,
      new Date('2026-10-31T00:00:00.000Z'),
      new Date('2026-11-02T12:00:00.000Z'),
    )
    expect(occurrences.map((value) => value.toISOString())).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ])
  })

  test('applies skip/latest/bounded-all catch-up policies', () => {
    const occurrences = [1, 2, 3].map((day) => new Date(`2026-07-0${day}T00:00:00.000Z`))
    expect(selectCatchUpOccurrences(occurrences, 'skip')).toEqual([])
    expect(selectCatchUpOccurrences(occurrences, 'latest').map((value) => value.getUTCDate())).toEqual([3])
    expect(selectCatchUpOccurrences(occurrences, 'all', 2).map((value) => value.getUTCDate())).toEqual([1, 2])
  })
})

test('advances recurring operational state with a revision guard and due index update', async () => {
  const recurring: RecurringWork = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'recurring-1',
    workspaceId: 'workspace-1',
    teamId: 'core',
    name: 'Daily review',
    enabled: true,
    version: 4,
    revision: 7,
    templateId: 'template-1',
    templateVersion: 3,
    schedule: {
      frequency: 'daily',
      interval: 1,
      timeZone: 'Asia/Tokyo',
      localTime: '09:00',
      startDate: '2026-07-01',
      catchUpPolicy: 'latest',
    },
    nextRunAt: '2026-07-16T00:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  }
  const commands: Array<{ input: Record<string, unknown> }> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      commands.push(command)
      return command.input.Key
        ? { Item: { scopeKey: 'workspace-1#automation', recordKey: 'RECURRING#recurring-1', entryType: 'recurring', ...recurring } }
        : {}
    },
  } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
  const client = new DynamoDbAutomationClient('AutomationTable', documentClient)

  const advanced = await client.completeRecurringWork(
    recurring.workspaceId,
    recurring.id,
    recurring.revision,
    '2026-07-16T00:00:00.000Z',
    '2026-07-17T00:00:00.000Z',
  )

  expect(advanced).toMatchObject({
    version: 4,
    revision: 8,
    lastRunAt: '2026-07-16T00:00:00.000Z',
    nextRunAt: '2026-07-17T00:00:00.000Z',
  })
  expect(commands.at(-1)?.input).toMatchObject({
    ConditionExpression: '#revision = :expectedRevision',
    ExpressionAttributeValues: { ':expectedRevision': 7 },
    Item: {
      entryType: 'recurring',
      nextRunAtRecordKey: '2026-07-17T00:00:00.000Z#recurring-1',
      revision: 8,
      version: 4,
    },
  })
})

test('indexes enabled schedule-trigger rules and advances their operational slot', async () => {
  const transactionCommands: Array<{ input: Record<string, unknown> }> = []
  const createDocumentClient = {
    async send(command: { input: Record<string, unknown> }) {
      transactionCommands.push(command)
      return {}
    },
  } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
  const createClient = new DynamoDbAutomationClient('AutomationTable', createDocumentClient)
  const created = await createClient.createRule('workspace-1', {
    name: 'Daily schedule',
    enabled: true,
    trigger: {
      type: 'schedule',
      schedule: {
        frequency: 'daily',
        interval: 1,
        timeZone: 'UTC',
        localTime: '09:00',
        startDate: '2020-01-01',
        catchUpPolicy: 'latest',
      },
    },
    actions: [{ type: 'comment', body: 'Scheduled' }],
  })
  expect(created.nextRunAt).toBeDefined()
  expect(transactionCommands[0]?.input).toMatchObject({
    TransactItems: [
      { Put: { Item: {
        entryType: 'rule',
        nextRunAtRecordKey: `${created.nextRunAt}#${created.id}`,
        scheduleShard: expect.stringMatching(/^schedule-\d{2}$/),
      } } },
      { Put: { Item: { entryType: 'rule-version' } } },
    ],
  })

  const completionCommands: Array<{ input: Record<string, unknown> }> = []
  const completeDocumentClient = {
    async send(command: { input: Record<string, unknown> }) {
      completionCommands.push(command)
      return command.input.Key
        ? { Item: {
            scopeKey: 'workspace-1#automation',
            recordKey: `RULE#${created.id}`,
            entryType: 'rule',
            ...created,
          } }
        : {}
    },
  } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
  const completeClient = new DynamoDbAutomationClient('AutomationTable', completeDocumentClient)
  const completedAt = created.nextRunAt!
  const nextRunAt = new Date(new Date(completedAt).getTime() + 86_400_000).toISOString()
  const completed = await completeClient.completeScheduledRule(
    created.workspaceId,
    created.id,
    created.revision,
    completedAt,
    nextRunAt,
  )
  expect(completed).toMatchObject({
    version: created.version,
    revision: created.revision + 1,
    lastRunAt: completedAt,
    nextRunAt,
  })
  expect(completionCommands.at(-1)?.input).toMatchObject({
    ConditionExpression: '#revision = :expectedRevision',
    Item: {
      entryType: 'rule',
      nextRunAtRecordKey: `${nextRunAt}#${created.id}`,
    },
  })
})

test('creates bulk operations once and checkpoints them with revision CAS', async () => {
  const commands: Array<{ input: Record<string, unknown> }> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      commands.push(command)
      return {}
    },
  } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
  const client = new DynamoDbAutomationClient('AutomationTable', documentClient)
  const operation = createBulkOperationFixture({ revision: 1 })

  expect(await client.createBulkOperation(operation)).toBe(true)
  operation.revision = 2
  await client.saveBulkOperation(operation, 1)

  expect(commands[0]?.input).toMatchObject({
    ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    Item: { entryType: 'bulk-operation', revision: 1 },
  })
  expect(commands[1]?.input).toMatchObject({
    ConditionExpression: '#revision = :expectedRevision',
    ExpressionAttributeNames: { '#revision': 'revision' },
    ExpressionAttributeValues: { ':expectedRevision': 1 },
    Item: { entryType: 'bulk-operation', revision: 2 },
  })

  const conflict = Object.assign(new Error('conditional write failed'), {
    name: 'ConditionalCheckFailedException',
  })
  const conflictingDocumentClient = {
    async send() {
      throw conflict
    },
  } as unknown as ConstructorParameters<typeof DynamoDbAutomationClient>[1]
  const conflictingClient = new DynamoDbAutomationClient(
    'AutomationTable',
    conflictingDocumentClient,
  )
  expect(await conflictingClient.createBulkOperation(createBulkOperationFixture())).toBe(false)
  await expect(conflictingClient.saveBulkOperation(operation, 1)).rejects.toMatchObject({
    code: 'BulkOperationRevisionConflict',
    status: 409,
  })
})

test('keeps bulk partial failures across retry and safe undo', async () => {
  const request: BulkOperationRequest = {
    workspaceId: 'workspace-1',
    items: [
      { teamId: 'core', workItemId: 'one', expectedRevision: 1 },
      { teamId: 'core', workItemId: 'two', expectedRevision: 2 },
    ],
    action: { type: 'move', targetProjectId: 'platform' },
  }
  const attempts = [0, 0]
  const undone: number[] = []
  const saved: BulkOperation[] = []
  const expectedRevisions: number[] = []
  let persistedRevision = 0
  let persistedOperation: BulkOperation | undefined
  const persistence = {
    async getBulkOperation() {
      return persistedOperation ? structuredClone(persistedOperation) : undefined
    },
    async createBulkOperation(operation: BulkOperation) {
      if (persistedRevision !== 0) return false
      persistedRevision = operation.revision
      persistedOperation = structuredClone(operation)
      saved.push(structuredClone(operation))
      return true
    },
    async saveBulkOperation(operation: BulkOperation, expectedRevision: number) {
      expectedRevisions.push(expectedRevision)
      if (persistedRevision !== expectedRevision) {
        throw new AutomationError(409, 'BulkOperationRevisionConflict', 'Bulk operation revision does not match.')
      }
      persistedRevision = operation.revision
      persistedOperation = structuredClone(operation)
      saved.push(structuredClone(operation))
    },
  } as AutomationClient
  const adapter: BulkOperationAdapter = {
    async preview() {
      return { allowed: true }
    },
    async apply(_request, itemIndex) {
      attempts[itemIndex] = (attempts[itemIndex] ?? 0) + 1
      if (itemIndex === 1 && attempts[itemIndex] === 1) {
        throw new AutomationError(503, 'TemporaryBulkFailure', 'Retry item.', true)
      }
      return {
        resultingRevision: itemIndex + 10,
        undoPayload: { previousProjectId: itemIndex === 0 ? 'alpha' : 'beta' },
      }
    },
    async undo(_operation, itemIndex) {
      undone.push(itemIndex)
      return { resultingRevision: itemIndex + 20 }
    },
  }
  const preview = await previewBulkOperation(request, adapter)
  const applied = await applyBulkOperation(
    { ...request, operationToken: preview.operationToken },
    preview,
    adapter,
    'owner@example.com',
    persistence,
  )
  expect(applied.status).toBe('partial')
  expect(applied.items.map((item) => item.status)).toEqual(['succeeded', 'failed'])
  expect(saved[0]?.items.map((item) => item.status)).toEqual(['ready', 'ready'])
  expect(saved.some((operation) =>
    operation.status === 'running' &&
    operation.items[0]?.status === 'succeeded' &&
    operation.items[1]?.status === 'ready'
  )).toBe(true)

  const retried = await retryBulkOperation(applied, adapter, persistence)
  expect(retried.status).toBe('succeeded')
  expect(attempts).toEqual([1, 2])

  const result = await undoBulkOperation(retried, adapter, persistence)
  expect(result.status).toBe('undone')
  expect(undone).toEqual([1, 0])
  expect(expectedRevisions).toEqual(
    Array.from({ length: expectedRevisions.length }, (_, index) => index + 1),
  )
  expect(result.revision).toBe(persistedRevision)
})

test('rejects unsafe Bulk edit fields before previewing any item', async () => {
  let previewCalls = 0
  const adapter: BulkOperationAdapter = {
    async preview() {
      previewCalls += 1
      return { allowed: true }
    },
    async apply() {
      return { resultingRevision: 2 }
    },
    async undo() {
      return { resultingRevision: 3 }
    },
  }
  await expect(previewBulkOperation({
    workspaceId: 'workspace-1',
    items: [{ teamId: 'core', workItemId: 'one', expectedRevision: 1 }],
    action: { type: 'edit', patch: { archivedAt: '2026-07-16T00:00:00.000Z' } },
  }, adapter)).rejects.toMatchObject({ code: 'InvalidAutomationInput', status: 400 })
  expect(previewCalls).toBe(0)
})

test('scopes Bulk operation identity and replay ownership to the initiating actor', async () => {
  const request: BulkOperationRequest = {
    workspaceId: 'workspace-1',
    items: [{ teamId: 'core', workItemId: 'one', expectedRevision: 1 }],
    action: { type: 'archive', archived: true },
  }
  const adapter: BulkOperationAdapter = {
    async preview() {
      return { allowed: true, undoPayload: { archivedAt: null, archivedBy: null } }
    },
    async apply(_request, _itemIndex, checkpoint) {
      return { resultingRevision: 2, undoPayload: checkpoint.undoPayload }
    },
    async undo() {
      return { resultingRevision: 3 }
    },
  }
  const preview = await previewBulkOperation(request, adapter)
  const applyRequest = { ...request, operationToken: preview.operationToken }
  const ownerOperation = await applyBulkOperation(
    applyRequest,
    preview,
    adapter,
    'owner@example.com',
  )
  const otherOperation = await applyBulkOperation(
    applyRequest,
    preview,
    adapter,
    'other@example.com',
  )

  expect(ownerOperation.id).not.toBe(otherOperation.id)
  expect(ownerOperation.actorMemberKey).toBe('owner@example.com')
  expect(otherOperation.actorMemberKey).toBe('other@example.com')
})

test('deduplicates concurrent and replayed bulk apply requests by operation token', async () => {
  const request: BulkOperationRequest = {
    workspaceId: 'workspace-1',
    items: [{ teamId: 'core', workItemId: 'one', expectedRevision: 1 }],
    action: { type: 'archive', archived: true },
  }
  let stored: BulkOperation | undefined
  let applyCalls = 0
  let createCalls = 0
  const persistence = {
    async getBulkOperation() {
      return stored ? structuredClone(stored) : undefined
    },
    async createBulkOperation(operation: BulkOperation) {
      createCalls += 1
      if (stored) return false
      stored = structuredClone(operation)
      return true
    },
    async saveBulkOperation(operation: BulkOperation, expectedRevision: number) {
      if (!stored || stored.revision !== expectedRevision) {
        throw new AutomationError(409, 'BulkOperationRevisionConflict', 'Bulk operation revision does not match.')
      }
      stored = structuredClone(operation)
    },
  } as AutomationClient
  const adapter: BulkOperationAdapter = {
    async preview() {
      return { allowed: true }
    },
    async apply() {
      applyCalls += 1
      return { resultingRevision: 2, undoPayload: { archivedAt: null } }
    },
    async undo() {
      return { resultingRevision: 3 }
    },
  }
  const preview = await previewBulkOperation(request, adapter)
  const applyRequest = { ...request, operationToken: preview.operationToken }

  const concurrentResults = await Promise.all([
    applyBulkOperation(applyRequest, preview, adapter, 'owner@example.com', persistence),
    applyBulkOperation(applyRequest, preview, adapter, 'owner@example.com', persistence),
  ])
  const replayed = await applyBulkOperation(
    applyRequest,
    { ...preview, canApply: false },
    adapter,
    'owner@example.com',
    persistence,
  )

  expect(new Set(concurrentResults.map((operation) => operation.id))).toEqual(new Set([stored?.id]))
  expect(replayed.id).toBe(stored?.id)
  expect(replayed.status).toBe('succeeded')
  expect(replayed.id).toMatch(/^bulk_[a-f0-9]{64}$/)
  expect(applyCalls).toBe(1)
  expect(createCalls).toBe(2)
})

test('resumes a bulk apply from the last durable item checkpoint', async () => {
  const request: BulkOperationRequest = {
    workspaceId: 'workspace-1',
    items: [
      { teamId: 'core', workItemId: 'one', expectedRevision: 1 },
      { teamId: 'core', workItemId: 'two', expectedRevision: 1 },
    ],
    action: { type: 'archive', archived: true },
  }
  const attempts = [0, 0]
  let stored: BulkOperation | undefined
  let failAfterFirstItem = true
  const persistence = {
    async getBulkOperation() {
      return stored ? structuredClone(stored) : undefined
    },
    async createBulkOperation(operation: BulkOperation) {
      stored = structuredClone(operation)
      return true
    },
    async saveBulkOperation(operation: BulkOperation, expectedRevision: number) {
      if (!stored || stored.revision !== expectedRevision) {
        throw new AutomationError(409, 'BulkOperationRevisionConflict', 'Bulk operation revision does not match.')
      }
      stored = structuredClone(operation)
      if (failAfterFirstItem && operation.items[0]?.status === 'succeeded' && operation.items[1]?.status === 'ready') {
        failAfterFirstItem = false
        throw new AutomationError(503, 'CheckpointResponseLost', 'Checkpoint response was lost.', true)
      }
    },
  } as AutomationClient
  const adapter: BulkOperationAdapter = {
    async preview() {
      return { allowed: true }
    },
    async apply(_request, itemIndex) {
      attempts[itemIndex] = (attempts[itemIndex] ?? 0) + 1
      return { resultingRevision: itemIndex + 2, undoPayload: { archivedAt: null } }
    },
    async undo() {
      return { resultingRevision: 4 }
    },
  }
  const preview = await previewBulkOperation(request, adapter)

  await expect(applyBulkOperation(
    { ...request, operationToken: preview.operationToken },
    preview,
    adapter,
    'owner@example.com',
    persistence,
  )).rejects.toMatchObject({ code: 'CheckpointResponseLost' })
  expect(stored?.items.map((item) => item.status)).toEqual(['succeeded', 'ready'])
  expect(stored?.revision).toBe(2)

  const resumed = await applyBulkOperation(
    { ...request, operationToken: preview.operationToken },
    preview,
    adapter,
    'owner@example.com',
    persistence,
  )
  expect(resumed.status).toBe('succeeded')
  expect(attempts).toEqual([1, 1])
  expect(resumed.revision).toBe(stored?.revision)
})

test('retains durable snapshots across apply and undo response loss recovery', async () => {
  const request: BulkOperationRequest = {
    workspaceId: 'workspace-1',
    items: [{ teamId: 'core', workItemId: 'one', expectedRevision: 1 }],
    action: { type: 'edit', patch: { title: 'Updated' } },
  }
  let state = { title: 'Original', revision: 1 }
  let applyCalls = 0
  let undoCalls = 0
  const adapter: BulkOperationAdapter = {
    async preview() {
      return { allowed: true, undoPayload: { title: state.title } }
    },
    async apply(_request, _itemIndex, checkpoint) {
      applyCalls += 1
      if (state.revision === 1) {
        state = { title: 'Updated', revision: 2 }
        throw Object.assign(new Error('Apply response was lost.'), { status: 503 })
      }
      expect(checkpoint.undoPayload).toEqual({ title: 'Original' })
      return { resultingRevision: state.revision, undoPayload: checkpoint.undoPayload }
    },
    async undo(operation, itemIndex) {
      undoCalls += 1
      const item = operation.items[itemIndex]!
      if (state.revision === 2) {
        state = { title: String(item.undoPayload?.title), revision: 3 }
        throw Object.assign(new Error('Undo response was lost.'), {
          name: 'InternalServerError',
          $metadata: { httpStatusCode: 500 },
        })
      }
      return { resultingRevision: state.revision }
    },
  }
  const preview = await previewBulkOperation(request, adapter)
  const failed = await applyBulkOperation(
    { ...request, operationToken: preview.operationToken },
    preview,
    adapter,
    'owner@example.com',
  )
  expect(failed).toMatchObject({
    status: 'failed',
    items: [{ status: 'failed', retryable: true, undoPayload: { title: 'Original' } }],
  })

  const recovered = await retryBulkOperation(failed, adapter)
  expect(recovered).toMatchObject({
    status: 'succeeded',
    items: [{ resultingRevision: 2, undoPayload: { title: 'Original' } }],
  })
  const interruptedUndo = await undoBulkOperation(recovered, adapter)
  expect(interruptedUndo).toMatchObject({
    status: 'partial',
    items: [{ status: 'succeeded', retryable: true, undoable: true }],
  })
  const recoveredUndo = await undoBulkOperation(interruptedUndo, adapter)
  expect(recoveredUndo).toMatchObject({ status: 'undone', items: [{ status: 'undone' }] })
  expect({ applyCalls, undoCalls, state }).toEqual({
    applyCalls: 2,
    undoCalls: 2,
    state: { title: 'Original', revision: 3 },
  })
})

test('does not mark Bulk permission or conflict failures as retryable', async () => {
  const request: BulkOperationRequest = {
    workspaceId: 'workspace-1',
    items: [{ teamId: 'core', workItemId: 'one', expectedRevision: 1 }],
    action: { type: 'archive', archived: true },
  }
  let applyCalls = 0
  const adapter: BulkOperationAdapter = {
    async preview() {
      return { allowed: true }
    },
    async apply() {
      applyCalls += 1
      throw Object.assign(new Error('Revision changed.'), {
        code: 'WorkItemRevisionConflict',
        status: 409,
      })
    },
    async undo() {
      return { resultingRevision: 3 }
    },
  }
  const preview = await previewBulkOperation(request, adapter)
  const operation = await applyBulkOperation(
    { ...request, operationToken: preview.operationToken },
    preview,
    adapter,
    'owner@example.com',
  )
  expect(operation.items[0]).toMatchObject({ status: 'failed', retryable: false })
  await retryBulkOperation(operation, adapter)
  expect(applyCalls).toBe(1)
})

test('rejects one of concurrent bulk retry and undo mutations with 409', async () => {
  let stored = createBulkOperationFixture({ revision: 7 })
  let applyCalls = 0
  let undoCalls = 0
  const persistence = {
    async saveBulkOperation(operation: BulkOperation, expectedRevision: number) {
      await Promise.resolve()
      if (stored.revision !== expectedRevision) {
        throw new AutomationError(409, 'BulkOperationRevisionConflict', 'Bulk operation revision does not match.')
      }
      stored = structuredClone(operation)
    },
  } as AutomationClient
  const adapter: BulkOperationAdapter = {
    async preview() {
      return { allowed: true }
    },
    async apply() {
      applyCalls += 1
      return { resultingRevision: 20, undoPayload: { previousProjectId: 'beta' } }
    },
    async undo() {
      undoCalls += 1
      return { resultingRevision: 21 }
    },
  }
  const retrySnapshot = structuredClone(stored)
  const undoSnapshot = structuredClone(stored)

  const results = await Promise.allSettled([
    retryBulkOperation(retrySnapshot, adapter, persistence),
    undoBulkOperation(undoSnapshot, adapter, persistence),
  ])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')

  expect(fulfilled).toHaveLength(1)
  expect(rejected).toHaveLength(1)
  expect(rejected[0]).toMatchObject({
    reason: { code: 'BulkOperationRevisionConflict', status: 409 },
  })
  expect(applyCalls + undoCalls).toBe(1)
  expect(stored.revision).toBeGreaterThan(7)
})
