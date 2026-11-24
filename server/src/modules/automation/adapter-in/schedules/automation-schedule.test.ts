import { describe, expect, test } from 'bun:test'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationExecution,
  type AutomationRule,
  type RecurringWork,
} from '@mukuroji/contracts'
import {
  AutomationError,
} from '../../domain/automation-error'
import type {
  AutomationFeatureEntitlementPort,
  AutomationInboundWebhookSecretCleanup,
} from '../../application/ports'
import {
  processAutomationSchedule,
  processDueAutomationExecution,
  processInboundWebhookSecretCleanup,
  processRecurringWorkDefinition,
  processScheduledAutomationRule,
  resolveAutomationScheduleProcessingTime,
  type AutomationScheduleDependencies,
  type AutomationSchedulePort,
} from './automation-schedule'

/**
 * Fails a test when it exercises a schedule capability that was not configured.
 *
 * @returns Never returns.
 */
function unexpectedAutomationSchedulePortCall(): never {
  throw new Error('Unexpected Automation schedule port call.')
}

/**
 * Creates a complete focused schedule port with fail-fast defaults.
 *
 * @param overrides - Schedule capabilities exercised by the current test.
 * @returns A type-safe Automation schedule port.
 */
function createAutomationSchedulePort(
  overrides: Partial<AutomationSchedulePort>,
): AutomationSchedulePort {
  return {
    async listRecurringWorks() {
      return unexpectedAutomationSchedulePortCall()
    },
    async getRecurringWork() {
      return unexpectedAutomationSchedulePortCall()
    },
    async createRecurringWork() {
      return unexpectedAutomationSchedulePortCall()
    },
    async updateRecurringWork() {
      return unexpectedAutomationSchedulePortCall()
    },
    async completeRecurringWork() {
      return unexpectedAutomationSchedulePortCall()
    },
    async deferRecurringWork() {
      return unexpectedAutomationSchedulePortCall()
    },
    async deleteRecurringWork() {
      return unexpectedAutomationSchedulePortCall()
    },
    async listDueRecurringWorks() {
      return unexpectedAutomationSchedulePortCall()
    },
    async listDueExecutions() {
      return unexpectedAutomationSchedulePortCall()
    },
    async reserveExecution() {
      return unexpectedAutomationSchedulePortCall()
    },
    async createExecution() {
      return unexpectedAutomationSchedulePortCall()
    },
    async getExecution() {
      return unexpectedAutomationSchedulePortCall()
    },
    async getExecutionEvent() {
      return unexpectedAutomationSchedulePortCall()
    },
    async claimExecution() {
      return unexpectedAutomationSchedulePortCall()
    },
    async saveExecution() {
      return unexpectedAutomationSchedulePortCall()
    },
    async listExecutions() {
      return unexpectedAutomationSchedulePortCall()
    },
    async hasActionReceipt() {
      return unexpectedAutomationSchedulePortCall()
    },
    async putActionReceipt() {
      return unexpectedAutomationSchedulePortCall()
    },
    async getRuleVersion() {
      return unexpectedAutomationSchedulePortCall()
    },
    async getRule() {
      return unexpectedAutomationSchedulePortCall()
    },
    async listDueScheduledRules() {
      return unexpectedAutomationSchedulePortCall()
    },
    async completeScheduledRule() {
      return unexpectedAutomationSchedulePortCall()
    },
    async listDueInboundWebhookSecretCleanups() {
      return unexpectedAutomationSchedulePortCall()
    },
    async completeInboundWebhookSecretCleanup() {
      return unexpectedAutomationSchedulePortCall()
    },
    ...overrides,
  }
}

const enabledAutomationEntitlement: AutomationFeatureEntitlementPort = {
  /** Allows Automation execution in tests focused on schedule behavior. */
  async isAutomationEnabled() {
    return true
  },
}

/** Skip policy の 2026-07-16T00:00:00.000Z slot を定刻として処理すべき wall clock です。 */
const ON_TIME_SKIP_WALL_CLOCKS = [
  '2026-07-16T00:00:00.000Z',
  '2026-07-16T00:00:00.004Z',
  '2026-07-16T00:00:37.412Z',
  '2026-07-16T00:01:59.999Z',
]

describe('automation schedule handler', () => {
  test('validates event time without using an old delivery time for processing leases', () => {
    const wallClock = new Date('2026-07-17T12:00:00.000Z')

    expect(resolveAutomationScheduleProcessingTime({
      time: '2026-07-16T00:00:00.000Z',
    }, wallClock)).toBe(wallClock)
    expect(() => resolveAutomationScheduleProcessingTime({
      time: 'not-a-timestamp',
    }, wallClock)).toThrow('Schedule time is invalid.')
  })

  test('leaves due work paused when tenant Automation is disabled', async () => {
    const definition = createRecurringWork()
    const result = await processRecurringWorkDefinition(
      definition,
      new Date(definition.nextRunAt),
      {
        client: createAutomationSchedulePort({
          async getRecurringWork() {
            return definition
          },
        }),
        entitlement: {
          /** Denies the tenant feature while preserving the due schedule cursor. */
          async isAutomationEnabled(workspaceId) {
            expect(workspaceId).toBe(definition.workspaceId)
            return false
          },
        },
        actionExecutor: {
          async execute() {
            throw new Error('Disabled Automation must not execute actions.')
          },
        },
      },
    )

    expect(result).toEqual(definition)
  })

  // EventBridge の rate(1 minute) tick と Lambda 起動は分境界から遅れるため、wall clock の遅れも定刻とみなす (#483)。
  test.each(ON_TIME_SKIP_WALL_CLOCKS)('materializes an on-time skip slot once across schedule redelivery at %s', async (wallClock) => {
    const definition = createRecurringWork()
    const executions = new Map<string, AutomationExecution>()
    const events = new Map<
      string,
      Parameters<AutomationSchedulePort['createExecution']>[1]
    >()
    let currentDefinition = definition
    let actionExecutions = 0
    let completionCalls = 0
    const client = createAutomationSchedulePort({
      async createExecution(execution, event) {
        if (executions.has(execution.id)) return false
        executions.set(execution.id, structuredClone(execution))
        events.set(execution.id, structuredClone(event))
        return true
      },
      async getExecution(_workspaceId, executionId) {
        return structuredClone(executions.get(executionId))
      },
      async getExecutionEvent(_workspaceId, executionId) {
        return structuredClone(events.get(executionId))
      },
      async claimExecution(candidate, now, leaseExpiresAt) {
        const current = executions.get(candidate.id)
        if (!current || current.status !== candidate.status || current.attempts !== candidate.attempts) {
          return false
        }
        if (current.status === 'running' && current.nextRetryAt && current.nextRetryAt > now.toISOString()) {
          return false
        }
        current.status = 'running'
        current.attempts += 1
        current.retryable = false
        current.nextRetryAt = leaseExpiresAt
        executions.set(current.id, structuredClone(current))
        return true
      },
      async saveExecution(execution) {
        executions.set(execution.id, structuredClone(execution))
        return true
      },
      async hasActionReceipt(_workspaceId, executionId, actionId) {
        return executions.get(executionId)?.actions.some((action) =>
          action.actionId === actionId && action.status === 'succeeded'
        ) ?? false
      },
      async putActionReceipt() {
        return true
      },
      async completeRecurringWork(_workspaceId, _id, expectedRevision, lastRunAt, nextRunAt) {
        completionCalls += 1
        if (currentDefinition.revision !== expectedRevision) return currentDefinition
        currentDefinition = {
          ...currentDefinition,
          revision: currentDefinition.revision + 1,
          lastRunAt,
          nextRunAt,
        }
        return currentDefinition
      },
      async getRecurringWork() {
        return currentDefinition
      },
    })
    const dependencies = {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute(action, context) {
          actionExecutions += 1
          expect(action).toEqual({
            type: 'create',
            templateId: 'template-1',
            templateVersion: 1,
            values: { teamId: 'core-team' },
          })
          expect(context.event.metadata).toMatchObject({
            scheduledFor: '2026-07-16T00:00:00.000Z',
            teamId: 'core-team',
          })
        },
      },
    } satisfies AutomationScheduleDependencies
    const now = new Date(wallClock)

    const first = await processRecurringWorkDefinition(definition, now, dependencies)
    const second = await processRecurringWorkDefinition(definition, now, dependencies)

    expect(first.lastRunAt).toBe('2026-07-16T00:00:00.000Z')
    expect(first.nextRunAt).toBe('2026-07-17T00:00:00.000Z')
    expect(second.lastRunAt).toBe(first.lastRunAt)
    expect(actionExecutions).toBe(1)
    expect(completionCalls).toBe(1)
  })

  test('keeps a recurring slot receipt stable when the definition version changes before CAS', async () => {
    const definition = createRecurringWork()
    const executions = new Map<string, AutomationExecution>()
    const events = new Map<
      string,
      Parameters<AutomationSchedulePort['createExecution']>[1]
    >()
    let currentDefinition: RecurringWork = definition
    let injectVersionUpdate = true
    let actionExecutions = 0
    const client = createAutomationSchedulePort({
      async createExecution(execution, event) {
        if (executions.has(execution.id)) return false
        executions.set(execution.id, structuredClone(execution))
        events.set(execution.id, structuredClone(event))
        return true
      },
      async getExecution(_workspaceId, executionId) {
        return structuredClone(executions.get(executionId))
      },
      async getExecutionEvent(_workspaceId, executionId) {
        return structuredClone(events.get(executionId))
      },
      async claimExecution(candidate, now, leaseExpiresAt) {
        const current = executions.get(candidate.id)
        if (!current || current.status !== candidate.status || current.attempts !== candidate.attempts) {
          return false
        }
        if (current.status === 'running' && current.nextRetryAt && current.nextRetryAt > now.toISOString()) {
          return false
        }
        current.status = 'running'
        current.attempts += 1
        current.retryable = false
        current.nextRetryAt = leaseExpiresAt
        executions.set(current.id, structuredClone(current))
        return true
      },
      async saveExecution(execution) {
        executions.set(execution.id, structuredClone(execution))
        return true
      },
      async hasActionReceipt(_workspaceId, executionId, actionId) {
        return executions.get(executionId)?.actions.some((action) =>
          action.actionId === actionId && action.status === 'succeeded'
        ) ?? false
      },
      async putActionReceipt() {
        return true
      },
      async completeRecurringWork(_workspaceId, _id, expectedRevision, lastRunAt, nextRunAt) {
        if (injectVersionUpdate) {
          injectVersionUpdate = false
          currentDefinition = {
            ...currentDefinition,
            name: 'Updated definition',
            version: 2,
            revision: 2,
          }
          throw new Error('revision conflict')
        }
        if (currentDefinition.revision !== expectedRevision) throw new Error('revision conflict')
        currentDefinition = {
          ...currentDefinition,
          revision: currentDefinition.revision + 1,
          lastRunAt,
          nextRunAt,
        }
        return structuredClone(currentDefinition)
      },
      async getRecurringWork() {
        return structuredClone(currentDefinition)
      },
    })
    const dependencies = {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute() {
          actionExecutions += 1
        },
      },
    } satisfies AutomationScheduleDependencies
    const now = new Date('2026-07-16T00:00:00.000Z')

    await expect(processRecurringWorkDefinition(definition, now, dependencies))
      .rejects.toThrow('revision conflict')
    const completed = await processRecurringWorkDefinition(currentDefinition, now, dependencies)

    expect(completed).toMatchObject({
      lastRunAt: '2026-07-16T00:00:00.000Z',
      version: 2,
    })
    expect(actionExecutions).toBe(1)
    expect(executions.size).toBe(1)
  })

  test.each(ON_TIME_SKIP_WALL_CLOCKS)('runs a schedule-trigger rule once and advances its slot with CAS at %s', async (wallClock) => {
    const rule = createScheduledRule()
    const executions = new Map<string, AutomationExecution>()
    const receipts = new Set<string>()
    let currentRule = rule
    let actionExecutions = 0
    const client = createAutomationSchedulePort({
      async reserveExecution(execution) {
        const executionId = execution.id
        if (executions.has(executionId)) return 'duplicate'
        executions.set(executionId, structuredClone(execution))
        return 'created'
      },
      async getExecution(_workspaceId, executionId) {
        return structuredClone(executions.get(executionId))
      },
      async claimExecution(candidate, now, leaseExpiresAt) {
        const current = executions.get(candidate.id)
        if (!current || current.status !== candidate.status || current.attempts !== candidate.attempts) {
          return false
        }
        if (current.status === 'running' && current.nextRetryAt && current.nextRetryAt > now.toISOString()) {
          return false
        }
        current.status = 'running'
        current.attempts += 1
        current.retryable = false
        current.nextRetryAt = leaseExpiresAt
        executions.set(current.id, structuredClone(current))
        return true
      },
      async saveExecution(execution) {
        executions.set(execution.id, structuredClone(execution))
        return true
      },
      async hasActionReceipt(_workspaceId, executionId, actionId) {
        return receipts.has(`${executionId}:${actionId}`)
      },
      async putActionReceipt(_workspaceId, executionId, actionId) {
        const receipt = `${executionId}:${actionId}`
        if (receipts.has(receipt)) return false
        receipts.add(receipt)
        return true
      },
      async completeScheduledRule(_workspaceId, _ruleId, expectedRevision, lastRunAt, nextRunAt) {
        if (currentRule.revision !== expectedRevision) throw new Error('revision conflict')
        currentRule = {
          ...currentRule,
          revision: currentRule.revision + 1,
          lastRunAt,
          nextRunAt,
        }
        return structuredClone(currentRule)
      },
      async getRule() {
        return structuredClone(currentRule)
      },
    })
    const dependencies = {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute(action, context) {
          actionExecutions += 1
          expect(action).toEqual({ type: 'comment', body: 'Scheduled check-in' })
          expect(context.event.metadata).toEqual({
            ruleId: 'rule-1',
            scheduledFor: '2026-07-16T00:00:00.000Z',
          })
        },
      },
    } satisfies AutomationScheduleDependencies
    const now = new Date(wallClock)

    const first = await processScheduledAutomationRule(rule, now, dependencies)
    const second = await processScheduledAutomationRule(rule, now, dependencies)

    expect(first.lastRunAt).toBe('2026-07-16T00:00:00.000Z')
    expect(first.nextRunAt).toBe('2026-07-17T00:00:00.000Z')
    expect(second).toEqual(first)
    expect(actionExecutions).toBe(1)
  })

  test('advances missed skip slots without executing recurring or rule actions', async () => {
    let currentDefinition = createRecurringWork()
    let currentRule = createScheduledRule()
    let actionExecutions = 0
    const client = createAutomationSchedulePort({
      async getExecution() {
        return undefined
      },
      async completeRecurringWork(_workspaceId, _id, expectedRevision, lastRunAt, nextRunAt) {
        expect(expectedRevision).toBe(currentDefinition.revision)
        currentDefinition = {
          ...currentDefinition,
          revision: currentDefinition.revision + 1,
          lastRunAt,
          nextRunAt,
        }
        return structuredClone(currentDefinition)
      },
      async getRecurringWork() {
        return structuredClone(currentDefinition)
      },
      async completeScheduledRule(_workspaceId, _id, expectedRevision, lastRunAt, nextRunAt) {
        expect(expectedRevision).toBe(currentRule.revision)
        currentRule = {
          ...currentRule,
          revision: currentRule.revision + 1,
          lastRunAt,
          nextRunAt,
        }
        return structuredClone(currentRule)
      },
      async getRule() {
        return structuredClone(currentRule)
      },
    })
    const dependencies = {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute() {
          actionExecutions += 1
        },
      },
    } satisfies AutomationScheduleDependencies
    // 定刻判定の許容幅 (2 tick) ちょうど遅れた slot は逃した slot として skip する。
    const now = new Date('2026-07-16T00:02:00.000Z')

    const recurringResult = await processRecurringWorkDefinition(currentDefinition, now, dependencies)
    const ruleResult = await processScheduledAutomationRule(currentRule, now, dependencies)

    expect(recurringResult).toMatchObject({
      lastRunAt: '2026-07-16T00:00:00.000Z',
      nextRunAt: '2026-07-17T00:00:00.000Z',
    })
    expect(ruleResult).toMatchObject({
      lastRunAt: '2026-07-16T00:00:00.000Z',
      nextRunAt: '2026-07-17T00:00:00.000Z',
    })
    expect(actionExecutions).toBe(0)
  })

  test('does not execute stale due-index snapshots after current definitions are disabled', async () => {
    const recurring = createRecurringWork()
    const rule = createScheduledRule()
    let actionExecutions = 0
    const client = createAutomationSchedulePort({
      async getRecurringWork() {
        return { ...recurring, enabled: false, revision: recurring.revision + 1 }
      },
      async getRule() {
        return { ...rule, enabled: false, revision: rule.revision + 1 }
      },
    })
    const dependencies = {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute() {
          actionExecutions += 1
        },
      },
    } satisfies AutomationScheduleDependencies
    const now = new Date('2026-07-16T00:00:00.000Z')

    expect(await processRecurringWorkDefinition(recurring, now, dependencies))
      .toMatchObject({ enabled: false })
    expect(await processScheduledAutomationRule(rule, now, dependencies))
      .toMatchObject({ enabled: false })
    expect(actionExecutions).toBe(0)
  })

  test('does not create a recurring execution when the definition changes at the create guard', async () => {
    const definition = createRecurringWork()
    let actionExecutions = 0
    let completionCalls = 0
    let observedGuard: Parameters<AutomationSchedulePort['createExecution']>[2]
    const client = createAutomationSchedulePort({
      async getRecurringWork() {
        return structuredClone(definition)
      },
      async createExecution(_execution, _event, definitionGuard) {
        observedGuard = definitionGuard
        return false
      },
      async getExecution() {
        return undefined
      },
      async completeRecurringWork() {
        completionCalls += 1
        throw new Error('Unexpected recurring completion.')
      },
    })

    await processRecurringWorkDefinition(
      definition,
      new Date('2026-07-16T00:00:00.000Z'),
      {
        client,
        entitlement: enabledAutomationEntitlement,
        actionExecutor: {
          async execute() {
            actionExecutions += 1
          },
        },
      },
    )

    expect(observedGuard).toEqual({
      kind: 'recurring',
      id: definition.id,
      version: definition.version,
      revision: definition.revision,
    })
    expect(actionExecutions).toBe(0)
    expect(completionCalls).toBe(0)
  })

  test('does not start a recurring slot when the definition is disabled between create and claim', async () => {
    const definition = createRecurringWork()
    const harness = createRecurringExecutionHarness(definition)
    let actionExecutions = 0
    harness.setBeforeClaim(() => {
      harness.setCurrentDefinition({
        ...definition,
        enabled: false,
        version: definition.version + 1,
        revision: definition.revision + 1,
      })
    })

    await processRecurringWorkDefinition(
      definition,
      new Date(definition.nextRunAt),
      {
        client: harness.client,
        entitlement: enabledAutomationEntitlement,
        actionExecutor: {
          async execute() {
            actionExecutions += 1
          },
        },
      },
    )

    expect(actionExecutions).toBe(0)
    expect([...harness.executions.values()][0]).toMatchObject({
      status: 'pending',
      attempts: 0,
    })
  })

  test('retries retryable recurring failures with bounded backoff then advances the dead-letter slot', async () => {
    const definition = createRecurringWork()
    const harness = createRecurringExecutionHarness(definition)
    let actionExecutions = 0
    const dependencies = {
      client: harness.client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute() {
          actionExecutions += 1
          throw new AutomationError('unavailable', 'TransientCreateFailure', 'Create is temporarily unavailable.', true)
        },
      },
    } satisfies AutomationScheduleDependencies

    await processRecurringWorkDefinition(definition, new Date('2026-07-16T00:00:00.000Z'), dependencies)
    let execution = [...harness.executions.values()][0]!
    expect(execution).toMatchObject({
      status: 'failed',
      attempts: 1,
      retryable: true,
      nextRetryAt: '2026-07-16T00:00:01.000Z',
    })

    await processRecurringWorkDefinition(definition, new Date('2026-07-16T00:00:00.500Z'), dependencies)
    expect(actionExecutions).toBe(1)

    await processRecurringWorkDefinition(definition, new Date('2026-07-16T00:00:01.000Z'), dependencies)
    execution = [...harness.executions.values()][0]!
    expect(execution).toMatchObject({
      status: 'failed',
      attempts: 2,
      nextRetryAt: '2026-07-16T00:00:03.000Z',
    })

    const completed = await processRecurringWorkDefinition(
      definition,
      new Date('2026-07-16T00:00:03.000Z'),
      dependencies,
    )
    execution = [...harness.executions.values()][0]!
    expect(execution).toMatchObject({
      status: 'dead-letter',
      attempts: 3,
      retryable: true,
    })
    expect(execution.nextRetryAt).toBeUndefined()
    expect(completed).toMatchObject({
      lastRunAt: '2026-07-16T00:00:00.000Z',
      nextRunAt: '2026-07-17T00:00:00.000Z',
    })
    expect(actionExecutions).toBe(3)
  })

  test('pauses automatic recurring execution retries after the current definition is disabled', async () => {
    const definition = createRecurringWork()
    const harness = createRecurringExecutionHarness(definition)
    let actionExecutions = 0
    const dependencies = {
      client: harness.client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute() {
          actionExecutions += 1
          throw new AutomationError('unavailable', 'TransientCreateFailure', 'Create is temporarily unavailable.', true)
        },
      },
    }
    await processRecurringWorkDefinition(
      definition,
      new Date('2026-07-16T00:00:00.000Z'),
      dependencies,
    )
    const failed = [...harness.executions.values()][0]!
    expect(failed).toMatchObject({ status: 'failed', retryable: true })
    harness.setCurrentDefinition({
      ...definition,
      enabled: false,
      version: definition.version + 1,
      revision: definition.revision + 1,
    })
    Object.assign(harness.client, {
      async listDueRecurringWorks() {
        return []
      },
      async listDueScheduledRules() {
        return []
      },
      async listDueExecutions(scheduleShard: string) {
        return scheduleShard === 'schedule-00' ? [structuredClone(failed)] : []
      },
    })

    const result = await processAutomationSchedule(
      new Date('2026-07-16T00:00:01.000Z'),
      dependencies,
    )

    expect(result.processedDueExecutions).toBe(1)
    expect(actionExecutions).toBe(1)
    expect(harness.executions.get(failed.id)).toMatchObject({ status: 'failed', attempts: 1 })
  })

  test('does not retry recurring work disabled between the current read and lease claim', async () => {
    const definition = createRecurringWork()
    const harness = createRecurringExecutionHarness(definition)
    let actionExecutions = 0
    const dependencies = {
      client: harness.client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute() {
          actionExecutions += 1
          throw new AutomationError('unavailable', 'TransientCreateFailure', 'Create is temporarily unavailable.', true)
        },
      },
    }
    await processRecurringWorkDefinition(
      definition,
      new Date(definition.nextRunAt),
      dependencies,
    )
    const failed = [...harness.executions.values()][0]!
    harness.setBeforeClaim(() => {
      harness.setCurrentDefinition({
        ...definition,
        enabled: false,
        version: definition.version + 1,
        revision: definition.revision + 1,
      })
    })

    const result = await processDueAutomationExecution(
      structuredClone(failed),
      new Date(failed.nextRetryAt!),
      dependencies,
    )

    expect(result).toMatchObject({ status: 'failed', attempts: 1 })
    expect(actionExecutions).toBe(1)
  })

  test('recovers an expired running recurring execution through its stored snapshot', async () => {
    const definition = createRecurringWork()
    const harness = createRecurringExecutionHarness(definition)
    let actionExecutions = 0
    const dependencies = {
      client: harness.client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute() {
          actionExecutions += 1
          if (actionExecutions === 1) {
            throw new AutomationError('unavailable', 'TransientCreateFailure', 'Create is temporarily unavailable.', true)
          }
        },
      },
    }
    await processRecurringWorkDefinition(
      definition,
      new Date('2026-07-16T00:00:00.000Z'),
      dependencies,
    )
    const execution = [...harness.executions.values()][0]!
    execution.status = 'running'
    execution.retryable = false
    execution.nextRetryAt = '2026-07-16T00:00:01.000Z'
    harness.executions.set(execution.id, structuredClone(execution))

    const recovered = await processDueAutomationExecution(
      structuredClone(execution),
      new Date('2026-07-16T00:00:01.000Z'),
      dependencies,
    )

    expect(recovered).toMatchObject({ status: 'succeeded', retryable: false })
    expect(actionExecutions).toBe(2)
  })

  test('retries a recurring slot with its stored template, team, and schedule snapshot', async () => {
    const definition = createRecurringWork()
    const harness = createRecurringExecutionHarness(definition)
    const actions: unknown[] = []
    const events: unknown[] = []
    let attempts = 0
    const dependencies = {
      client: harness.client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute(action, context) {
          actions.push(structuredClone(action))
          events.push(structuredClone(context.event.metadata))
          attempts += 1
          if (attempts === 1) {
            throw Object.assign(new Error('Temporary create outage.'), { status: 503 })
          }
        },
      },
    } satisfies AutomationScheduleDependencies
    await processRecurringWorkDefinition(
      definition,
      new Date('2026-07-16T00:00:00.000Z'),
      dependencies,
    )
    const updatedDefinition: RecurringWork = {
      ...definition,
      teamId: 'updated-team',
      templateId: 'template-2',
      templateVersion: 2,
      version: 2,
      revision: 2,
      schedule: { ...definition.schedule, localTime: '10:00' },
      updatedAt: '2026-07-16T00:00:00.500Z',
    }
    harness.setCurrentDefinition(updatedDefinition)

    const completed = await processRecurringWorkDefinition(
      updatedDefinition,
      new Date('2026-07-16T00:00:01.000Z'),
      dependencies,
    )

    expect(actions).toEqual([
      {
        type: 'create',
        templateId: 'template-1',
        templateVersion: 1,
        values: { teamId: 'core-team' },
      },
      {
        type: 'create',
        templateId: 'template-1',
        templateVersion: 1,
        values: { teamId: 'core-team' },
      },
    ])
    expect(events).toEqual([
      expect.objectContaining({
        scheduledFor: definition.nextRunAt,
        teamId: 'core-team',
        templateId: 'template-1',
        templateVersion: 1,
      }),
      expect.objectContaining({
        scheduledFor: definition.nextRunAt,
        teamId: 'core-team',
        templateId: 'template-1',
        templateVersion: 1,
      }),
    ])
    expect(completed).toMatchObject({
      lastRunAt: definition.nextRunAt,
      nextRunAt: '2026-07-16T01:00:00.000Z',
    })
  })

  test('dead-letters a non-retryable recurring failure and advances immediately', async () => {
    const definition = createRecurringWork()
    const harness = createRecurringExecutionHarness(definition)
    let actionExecutions = 0

    const completed = await processRecurringWorkDefinition(
      definition,
      new Date('2026-07-16T00:00:00.000Z'),
      {
        client: harness.client,
        entitlement: enabledAutomationEntitlement,
        actionExecutor: {
          async execute() {
            actionExecutions += 1
            throw new AutomationError('unprocessable', 'InvalidTemplate', 'Template cannot be materialized.')
          },
        },
      },
    )

    expect([...harness.executions.values()][0]).toMatchObject({
      status: 'dead-letter',
      attempts: 1,
      retryable: true,
    })
    expect(completed).toMatchObject({
      lastRunAt: '2026-07-16T00:00:00.000Z',
      nextRunAt: '2026-07-17T00:00:00.000Z',
    })
    expect(actionExecutions).toBe(1)
  })

  test('retries due rule executions from immutable rule and event state in the minute scheduler', async () => {
    const rule = createScheduledRule()
    const event = {
      eventId: 'event-original',
      eventType: 'work-item.updated',
      workspaceId: rule.workspaceId,
      occurredAt: '2026-07-16T00:00:00.000Z',
      changes: [{ field: 'workflowStatusId', before: 'review', after: 'done' }],
    }
    let execution: AutomationExecution = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-retry-1',
      workspaceId: rule.workspaceId,
      ruleId: rule.id,
      ruleVersion: rule.version,
      triggerEventId: event.eventId,
      status: 'failed',
      attempts: 1,
      actions: [{
        actionIndex: 0,
        actionId: 'automation-retry-1:action:0000',
        status: 'failed',
        attempts: 1,
      }],
      startedAt: '2026-07-16T00:00:00.000Z',
      completedAt: '2026-07-16T00:00:01.000Z',
      nextRetryAt: '2026-07-16T00:00:30.000Z',
      retryable: true,
    }
    let actionExecutions = 0
    const receipts = new Set<string>()
    const client = createAutomationSchedulePort({
      async listDueRecurringWorks() {
        return []
      },
      async listDueScheduledRules() {
        return []
      },
      async listDueExecutions(scheduleShard) {
        return scheduleShard === 'schedule-00' ? [structuredClone(execution)] : []
      },
      async getExecution(_workspaceId, executionId) {
        return executionId === execution.id ? structuredClone(execution) : undefined
      },
      async claimExecution(candidate, now, leaseExpiresAt) {
        if (
          candidate.id !== execution.id ||
          candidate.status !== execution.status ||
          candidate.attempts !== execution.attempts ||
          (execution.status === 'running' && execution.nextRetryAt &&
            execution.nextRetryAt > now.toISOString())
        ) {
          return false
        }
        execution = {
          ...execution,
          status: 'running',
          attempts: execution.attempts + 1,
          retryable: false,
          nextRetryAt: leaseExpiresAt,
        }
        return true
      },
      async saveExecution(updated) {
        execution = structuredClone(updated)
        return true
      },
      async getRuleVersion(_workspaceId, ruleId, version) {
        expect({ ruleId, version }).toEqual({ ruleId: rule.id, version: 1 })
        return structuredClone(rule)
      },
      async getExecutionEvent() {
        return structuredClone(event)
      },
      async hasActionReceipt(_workspaceId, executionId, actionId) {
        return receipts.has(`${executionId}:${actionId}`)
      },
      async putActionReceipt(_workspaceId, executionId, actionId) {
        receipts.add(`${executionId}:${actionId}`)
        return true
      },
    })

    const result = await processAutomationSchedule(
      new Date('2026-07-16T00:01:00.000Z'),
      {
        client,
        entitlement: enabledAutomationEntitlement,
        actionExecutor: {
          async execute(action, context) {
            actionExecutions += 1
            expect(action).toEqual({ type: 'comment', body: 'Scheduled check-in' })
            expect(context.event).toEqual(event)
          },
        },
      },
    )

    expect(result).toEqual({
      processedDefinitions: 0,
      processedScheduledRules: 0,
      processedDueExecutions: 1,
    })
    expect(execution).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      retryable: false,
    })
    expect(execution.nextRetryAt).toBeUndefined()
    expect(actionExecutions).toBe(1)
  })

  test('takes over an expired running lease and completes it', async () => {
    const rule = createScheduledRule()
    const event = {
      eventId: 'event-running',
      eventType: 'work-item.updated',
      workspaceId: rule.workspaceId,
      occurredAt: '2026-07-16T00:00:00.000Z',
      changes: [],
    }
    let execution: AutomationExecution = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-running-1',
      workspaceId: rule.workspaceId,
      ruleId: rule.id,
      ruleVersion: rule.version,
      triggerEventId: event.eventId,
      status: 'running',
      attempts: 1,
      actions: [{
        actionIndex: 0,
        actionId: 'automation-running-1:action:0000',
        status: 'running',
        attempts: 1,
      }],
      startedAt: '2026-07-16T00:00:00.000Z',
      nextRetryAt: '2026-07-16T00:05:00.000Z',
      retryable: false,
    }
    let actionExecutions = 0
    const client = createAutomationSchedulePort({
      async getExecution() {
        return structuredClone(execution)
      },
      async claimExecution(candidate, now, leaseExpiresAt) {
        if (
          candidate.status !== execution.status ||
          candidate.attempts !== execution.attempts ||
          (execution.nextRetryAt && execution.nextRetryAt > now.toISOString())
        ) {
          return false
        }
        execution = {
          ...execution,
          status: 'running',
          attempts: execution.attempts + 1,
          nextRetryAt: leaseExpiresAt,
        }
        return true
      },
      async getRuleVersion() {
        return structuredClone(rule)
      },
      async getExecutionEvent() {
        return structuredClone(event)
      },
      async hasActionReceipt() {
        return false
      },
      async putActionReceipt() {
        return true
      },
      async saveExecution(updated) {
        execution = structuredClone(updated)
        return true
      },
    })

    const result = await processDueAutomationExecution(
      structuredClone(execution),
      new Date('2026-07-16T00:05:00.000Z'),
      {
        client,
        entitlement: enabledAutomationEntitlement,
        actionExecutor: {
          async execute() {
            actionExecutions += 1
          },
        },
      },
    )

    expect(result).toMatchObject({
      status: 'succeeded',
      attempts: 2,
    })
    expect(execution.nextRetryAt).toBeUndefined()
    expect(actionExecutions).toBe(1)
  })

  test('recovers a reservation nobody claimed from the saved rule version', async () => {
    const rule = createScheduledRule()
    const event = {
      eventId: 'event-running',
      eventType: 'work-item.updated',
      workspaceId: rule.workspaceId,
      occurredAt: '2026-07-16T00:00:00.000Z',
      changes: [],
    }
    let execution: AutomationExecution = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-running-1',
      workspaceId: rule.workspaceId,
      ruleId: rule.id,
      ruleVersion: rule.version,
      triggerEventId: event.eventId,
      status: 'pending',
      attempts: 0,
      actions: [{
        actionIndex: 0,
        actionId: 'automation-running-1:action:0000',
        status: 'pending',
        attempts: 0,
      }],
      startedAt: '2026-07-16T00:00:00.000Z',
      retryable: false,
    }
    let actionExecutions = 0
    const client = createAutomationSchedulePort({
      async getExecution() {
        return structuredClone(execution)
      },
      async claimExecution(candidate, now, leaseExpiresAt) {
        if (
          candidate.status !== execution.status ||
          candidate.attempts !== execution.attempts ||
          (execution.nextRetryAt && execution.nextRetryAt > now.toISOString())
        ) {
          return false
        }
        execution = {
          ...execution,
          status: 'running',
          attempts: execution.attempts + 1,
          nextRetryAt: leaseExpiresAt,
        }
        return true
      },
      async getRuleVersion() {
        return structuredClone(rule)
      },
      async getExecutionEvent() {
        return structuredClone(event)
      },
      async hasActionReceipt() {
        return false
      },
      async putActionReceipt() {
        return true
      },
      async saveExecution(updated) {
        execution = structuredClone(updated)
        return true
      },
    })

    // The rule may be deleted meanwhile; recovery reads only the saved version and event.
    const early = await processDueAutomationExecution(
      structuredClone(execution),
      new Date('2026-07-16T00:04:59.000Z'),
      {
        client,
        entitlement: enabledAutomationEntitlement,
        actionExecutor: {
          async execute() {
            actionExecutions += 1
          },
        },
      },
    )
    expect(early.status).toBe('pending')
    const result = await processDueAutomationExecution(
      structuredClone(execution),
      new Date('2026-07-16T00:05:00.000Z'),
      {
        client,
        entitlement: enabledAutomationEntitlement,
        actionExecutor: {
          async execute() {
            actionExecutions += 1
          },
        },
      },
    )

    expect(result).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    })
    expect(execution.nextRetryAt).toBeUndefined()
    expect(actionExecutions).toBe(1)
  })

  test('advances durable inbound secret cleanup only after DeleteSecret succeeds', async () => {
    const cleanup: AutomationInboundWebhookSecretCleanup = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      workspaceId: 'workspace-1',
      endpointId: 'webhook-1',
      secretId: 'mukuroji/automation-inbound-webhooks/workspace/webhook-1',
      secretVersionId: 'a'.repeat(64),
      secretGeneration: 1,
      revision: 1,
      nextCleanupAt: '2026-07-16T00:00:00.000Z',
      cleanupUntil: '2026-07-17T00:00:00.000Z',
      createdAt: '2026-07-15T23:55:00.000Z',
      updatedAt: '2026-07-15T23:55:00.000Z',
    }
    const calls: string[] = []
    let deleteFails = true
    const dependencies = {
      client: createAutomationSchedulePort({
        async completeInboundWebhookSecretCleanup() {
          calls.push('complete')
        },
      }),
      entitlement: enabledAutomationEntitlement,
      actionExecutor: { async execute() {} },
      inboundWebhookSecrets: {
        async provision() {
          throw new Error('not used')
        },
        async get() {
          throw new Error('not used')
        },
        async delete() {
          calls.push('delete')
          if (deleteFails) throw new Error('Secrets Manager is unavailable.')
        },
      },
    } satisfies AutomationScheduleDependencies

    await expect(processInboundWebhookSecretCleanup(
      cleanup,
      new Date(cleanup.nextCleanupAt),
      dependencies,
    )).rejects.toThrow('Secrets Manager is unavailable.')
    expect(calls).toEqual(['delete'])

    deleteFails = false
    await processInboundWebhookSecretCleanup(
      cleanup,
      new Date(cleanup.nextCleanupAt),
      dependencies,
    )
    expect(calls).toEqual(['delete', 'delete', 'complete'])
  })
})

function createRecurringWork(): RecurringWork {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'recurring-1',
    workspaceId: 'workspace-1',
    teamId: 'core-team',
    name: 'Daily stand-up',
    enabled: true,
    version: 1,
    revision: 1,
    templateId: 'template-1',
    templateVersion: 1,
    schedule: {
      frequency: 'daily',
      interval: 1,
      timeZone: 'Asia/Tokyo',
      localTime: '09:00',
      startDate: '2026-07-16',
      catchUpPolicy: 'skip',
    },
    nextRunAt: '2026-07-16T00:00:00.000Z',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  }
}

function createScheduledRule(): AutomationRule {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'rule-1',
    workspaceId: 'workspace-1',
    name: 'Daily check-in',
    enabled: true,
    version: 1,
    revision: 1,
    trigger: {
      type: 'schedule',
      schedule: {
        frequency: 'daily',
        interval: 1,
        timeZone: 'Asia/Tokyo',
        localTime: '09:00',
        startDate: '2026-07-16',
        catchUpPolicy: 'skip',
      },
    },
    conditions: [],
    actions: [{ type: 'comment', body: 'Scheduled check-in' }],
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 1_000,
      backoffMultiplier: 2,
      maxDelayMs: 60_000,
    },
    rateLimit: { maxExecutions: 100, windowSeconds: 60 },
    allowReentry: false,
    maxChainDepth: 8,
    nextRunAt: '2026-07-16T00:00:00.000Z',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  }
}

function createRecurringExecutionHarness(definition: RecurringWork) {
  const executions = new Map<string, AutomationExecution>()
  const events = new Map<
    string,
    Parameters<AutomationSchedulePort['createExecution']>[1]
  >()
  const receipts = new Set<string>()
  let currentDefinition = structuredClone(definition)
  let beforeClaim: (() => void) | undefined
  const client = createAutomationSchedulePort({
    async createExecution(execution, event) {
      if (executions.has(execution.id)) return false
      executions.set(execution.id, structuredClone(execution))
      events.set(execution.id, structuredClone(event))
      return true
    },
    async getExecution(_workspaceId, executionId) {
      return structuredClone(executions.get(executionId))
    },
    async getExecutionEvent(_workspaceId, executionId) {
      return structuredClone(events.get(executionId))
    },
    async claimExecution(candidate, now, leaseExpiresAt, definitionGuard) {
      const callback = beforeClaim
      beforeClaim = undefined
      callback?.()
      if (
        definitionGuard &&
        (
          !currentDefinition.enabled ||
          currentDefinition.id !== definitionGuard.id ||
          currentDefinition.version !== definitionGuard.version ||
          currentDefinition.revision !== definitionGuard.revision
        )
      ) return false
      const current = executions.get(candidate.id)
      if (!current || current.status !== candidate.status || current.attempts !== candidate.attempts) {
        return false
      }
      if (current.status === 'running' && current.nextRetryAt && current.nextRetryAt > now.toISOString()) {
        return false
      }
      current.status = 'running'
      current.attempts += 1
      current.retryable = false
      current.nextRetryAt = leaseExpiresAt
      executions.set(current.id, structuredClone(current))
      return true
    },
    async saveExecution(execution) {
      executions.set(execution.id, structuredClone(execution))
      return true
    },
    async hasActionReceipt(_workspaceId, executionId, actionId) {
      return receipts.has(`${executionId}:${actionId}`)
    },
    async putActionReceipt(_workspaceId, executionId, actionId) {
      const receipt = `${executionId}:${actionId}`
      if (receipts.has(receipt)) return false
      receipts.add(receipt)
      return true
    },
    async completeRecurringWork(_workspaceId, _id, expectedRevision, lastRunAt, nextRunAt) {
      if (currentDefinition.revision !== expectedRevision) throw new Error('revision conflict')
      currentDefinition = {
        ...currentDefinition,
        revision: currentDefinition.revision + 1,
        lastRunAt,
        nextRunAt,
      }
      return structuredClone(currentDefinition)
    },
    async getRecurringWork() {
      return structuredClone(currentDefinition)
    },
  })
  return {
    client,
    executions,
    setCurrentDefinition(definitionValue: RecurringWork) {
      currentDefinition = structuredClone(definitionValue)
    },
    setBeforeClaim(callback: () => void) {
      beforeClaim = callback
    },
  }
}

describe('due-soon schedule rules and business-day Recurring Work', () => {
  test('runs a due-soon rule once per open Work Item due that many days after the occurrence', async () => {
    const rule: AutomationRule = {
      ...createScheduledRule(),
      trigger: {
        ...createScheduledRule().trigger,
        type: 'schedule',
        schedule: {
          frequency: 'daily',
          interval: 1,
          timeZone: 'Asia/Tokyo',
          localTime: '09:00',
          startDate: '2026-07-16',
          catchUpPolicy: 'skip',
        },
        dueWorkItems: { daysBefore: 3 },
      },
      actions: [{ type: 'notify', recipientMemberKeys: [], notifyAssignee: true, title: 'Due soon' }],
    }
    const executions = new Map<string, AutomationExecution>()
    const receipts = new Set<string>()
    let currentRule = rule
    const notified: string[] = []
    const requestedDueDates: string[] = []
    const client = createAutomationSchedulePort({
      async reserveExecution(execution) {
        if (executions.has(execution.id)) return 'duplicate'
        executions.set(execution.id, structuredClone(execution))
        return 'created'
      },
      async getExecution(_workspaceId, executionId) {
        return structuredClone(executions.get(executionId))
      },
      async claimExecution(candidate, _now, leaseExpiresAt) {
        const current = executions.get(candidate.id)
        if (!current || current.status !== candidate.status || current.attempts !== candidate.attempts) {
          return false
        }
        current.status = 'running'
        current.attempts += 1
        current.nextRetryAt = leaseExpiresAt
        executions.set(current.id, structuredClone(current))
        return true
      },
      async saveExecution(execution) {
        executions.set(execution.id, structuredClone(execution))
        return true
      },
      async hasActionReceipt(_workspaceId, executionId, actionId) {
        return receipts.has(`${executionId}:${actionId}`)
      },
      async putActionReceipt(_workspaceId, executionId, actionId) {
        const receipt = `${executionId}:${actionId}`
        if (receipts.has(receipt)) return false
        receipts.add(receipt)
        return true
      },
      async completeScheduledRule(_workspaceId, _ruleId, expectedRevision, lastRunAt, nextRunAt) {
        if (currentRule.revision !== expectedRevision) throw new Error('revision conflict')
        currentRule = { ...currentRule, revision: currentRule.revision + 1, lastRunAt, nextRunAt }
        return structuredClone(currentRule)
      },
      async getRule() {
        return structuredClone(currentRule)
      },
    })
    const dependencies = {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute(_action, context) {
          const assignee = context.event.workItem?.assigneeUserId
          notified.push(`${String(context.event.metadata?.issueId)}:${String(assignee)}`)
        },
      },
      dueWorkItems: {
        async listOpenWorkItemsDueOn(workspaceId, dueDate) {
          expect(workspaceId).toBe('workspace-1')
          requestedDueDates.push(dueDate)
          return [
            { teamId: 'core', workItemId: 'item-2', dueDate },
            { teamId: 'core', workItemId: 'item-1', dueDate },
            { teamId: 'core', workItemId: 'moved', dueDate },
            { teamId: 'core', workItemId: 'done', dueDate },
          ]
        },
      },
      workItems: {
        async getTeamIssueDetail(_workspaceId, _teamId, workItemId) {
          return {
            issue: {
              id: workItemId,
              assigneeUserId: `member-${workItemId}`,
              dueDate: workItemId === 'moved' ? '2026-08-01' : '2026-07-19',
              statusCategory: workItemId === 'done' ? 'completed' : 'unstarted',
            },
          }
        },
      },
    } satisfies AutomationScheduleDependencies
    const now = new Date('2026-07-16T00:00:30.000Z')

    const first = await processScheduledAutomationRule(rule, now, dependencies)
    const second = await processScheduledAutomationRule(rule, now, dependencies)

    expect(requestedDueDates).toEqual(['2026-07-19'])
    expect(notified).toEqual(['item-1:member-item-1', 'item-2:member-item-2'])
    expect(first.nextRunAt).toBe('2026-07-17T00:00:00.000Z')
    expect(second).toEqual(first)
  })

  test('resumes the rest of a late skip-policy due-soon occurrence after a partial fan-out', async () => {
    const rule: AutomationRule = {
      ...createScheduledRule(),
      trigger: {
        type: 'schedule',
        schedule: {
          frequency: 'daily',
          interval: 1,
          timeZone: 'Asia/Tokyo',
          localTime: '09:00',
          startDate: '2026-07-16',
          catchUpPolicy: 'skip',
        },
        dueWorkItems: { daysBefore: 3 },
      },
      actions: [{ type: 'notify', recipientMemberKeys: [], notifyAssignee: true, title: 'Due soon' }],
    }
    const executions = new Map<string, AutomationExecution>()
    const receipts = new Set<string>()
    let currentRule = rule
    let crashOnSecondItem = true
    const notified: string[] = []
    const client = createAutomationSchedulePort({
      async reserveExecution(execution) {
        if (crashOnSecondItem && execution.triggerEventId.endsWith(':item-2')) {
          crashOnSecondItem = false
          throw new Error('worker stopped')
        }
        if (executions.has(execution.id)) return 'duplicate'
        executions.set(execution.id, structuredClone(execution))
        return 'created'
      },
      async getExecution(_workspaceId, executionId) {
        return structuredClone(executions.get(executionId))
      },
      async claimExecution(candidate, _now, leaseExpiresAt) {
        const current = executions.get(candidate.id)
        if (!current || current.status !== candidate.status || current.attempts !== candidate.attempts) {
          return false
        }
        current.status = 'running'
        current.attempts += 1
        current.nextRetryAt = leaseExpiresAt
        executions.set(current.id, structuredClone(current))
        return true
      },
      async saveExecution(execution) {
        executions.set(execution.id, structuredClone(execution))
        return true
      },
      async hasActionReceipt(_workspaceId, executionId, actionId) {
        return receipts.has(`${executionId}:${actionId}`)
      },
      async putActionReceipt(_workspaceId, executionId, actionId) {
        const receipt = `${executionId}:${actionId}`
        if (receipts.has(receipt)) return false
        receipts.add(receipt)
        return true
      },
      async completeScheduledRule(_workspaceId, _ruleId, expectedRevision, lastRunAt, nextRunAt) {
        if (currentRule.revision !== expectedRevision) throw new Error('revision conflict')
        currentRule = { ...currentRule, revision: currentRule.revision + 1, lastRunAt, nextRunAt }
        return structuredClone(currentRule)
      },
      async getRule() {
        return structuredClone(currentRule)
      },
    })
    const dependencies = {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute(_action, context) {
          notified.push(String(context.event.metadata?.issueId))
        },
      },
      dueWorkItems: {
        async listOpenWorkItemsDueOn(_workspaceId, dueDate) {
          return [
            { teamId: 'core', workItemId: 'item-1', dueDate },
            { teamId: 'core', workItemId: 'item-2', dueDate },
          ]
        },
      },
      workItems: {
        async getTeamIssueDetail(_workspaceId, _teamId, workItemId) {
          return {
            issue: {
              id: workItemId,
              assigneeUserId: `member-${workItemId}`,
              dueDate: '2026-07-19',
              statusCategory: 'unstarted',
            },
          }
        },
      },
    } satisfies AutomationScheduleDependencies

    await expect(processScheduledAutomationRule(
      rule,
      new Date('2026-07-16T00:00:30.000Z'),
      dependencies,
    )).rejects.toThrow('worker stopped')
    const resumed = await processScheduledAutomationRule(
      currentRule,
      new Date('2026-07-16T00:10:00.000Z'),
      dependencies,
    )

    expect(notified).toEqual(['item-1', 'item-2'])
    expect(resumed.lastRunAt).toBe('2026-07-16T00:00:00.000Z')
    expect(resumed.nextRunAt).toBe('2026-07-17T00:00:00.000Z')
  })

  test('rejects a due-soon rule when the schedule has no due Work Item source', async () => {
    const rule: AutomationRule = {
      ...createScheduledRule(),
      trigger: {
        type: 'schedule',
        schedule: {
          frequency: 'daily',
          interval: 1,
          timeZone: 'Asia/Tokyo',
          localTime: '09:00',
          startDate: '2026-07-16',
          catchUpPolicy: 'skip',
        },
        dueWorkItems: { daysBefore: 0 },
      },
    }
    const client = createAutomationSchedulePort({
      async getRule() {
        return structuredClone(rule)
      },
      async getExecution() {
        return undefined
      },
    })

    await expect(processScheduledAutomationRule(rule, new Date('2026-07-16T00:00:00.000Z'), {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute() {
          throw new Error('No action runs without the source.')
        },
      },
    })).rejects.toThrow('Due Work Item lookup is not configured.')
  })

  test('does not catch up business-day months that passed before the current next run', async () => {
    const definition: RecurringWork = {
      ...createRecurringWork(),
      schedule: {
        frequency: 'monthly',
        interval: 1,
        timeZone: 'Asia/Tokyo',
        localTime: '09:00',
        startDate: '2026-01-01',
        dayOfMonth: 1,
        monthlyDay: 'business-day',
        catchUpPolicy: 'all',
      },
      // Paused since April and re-enabled with the next run on 2026-08-01.
      lastRunAt: '2026-04-01T00:00:00.000Z',
      nextRunAt: '2026-08-01T00:00:00.000Z',
    }
    const harness = createRecurringExecutionHarness(definition)
    let current = structuredClone(definition)
    const occurrences: string[] = []
    const client: AutomationSchedulePort = {
      ...harness.client,
      async getRecurringWork() {
        return structuredClone(current)
      },
      async deferRecurringWork(_workspaceId, _id, _revision, nextRunAt) {
        current = { ...current, revision: current.revision + 1, nextRunAt }
        harness.setCurrentDefinition(current)
        return structuredClone(current)
      },
    }

    const deferred = await processRecurringWorkDefinition(definition, new Date('2026-08-01T00:00:00.000Z'), {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute(_action, context) {
          occurrences.push(String(context.event.occurredAt))
        },
      },
      workCalendars: {
        async readTeamWorkCalendar() {
          return { workingWeekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set<string>() }
        },
      },
    })

    expect(occurrences).toEqual([])
    // 2026-08-01 is a Saturday, so the first business day is Monday the 3rd; it wakes daily until then.
    expect(deferred.nextRunAt).toBe('2026-08-02T00:00:00.000Z')
  })

  test('does not run a business-day time that passed before the schedule was changed', async () => {
    const definition: RecurringWork = {
      ...createRecurringWork(),
      schedule: {
        frequency: 'monthly',
        interval: 1,
        timeZone: 'Asia/Tokyo',
        localTime: '09:00',
        startDate: '2026-01-01',
        dayOfMonth: 1,
        monthlyDay: 'business-day',
        catchUpPolicy: 'latest',
      },
      // Changed to the first business day on August 10, after this month's (August 3) had passed.
      lastRunAt: '2026-07-01T00:00:00.000Z',
      scheduleChangedAt: '2026-08-10T01:00:00.000Z',
      nextRunAt: '2026-08-11T00:00:00.000Z',
    }
    const harness = createRecurringExecutionHarness(definition)
    let current = structuredClone(definition)
    const occurrences: string[] = []
    const client: AutomationSchedulePort = {
      ...harness.client,
      async getRecurringWork() {
        return structuredClone(current)
      },
      async deferRecurringWork(_workspaceId, _id, _revision, nextRunAt) {
        current = { ...current, revision: current.revision + 1, nextRunAt }
        harness.setCurrentDefinition(current)
        return structuredClone(current)
      },
    }

    const deferred = await processRecurringWorkDefinition(definition, new Date('2026-08-11T00:00:00.000Z'), {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute(_action, context) {
          occurrences.push(String(context.event.occurredAt))
        },
      },
      workCalendars: {
        async readTeamWorkCalendar() {
          return { workingWeekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set<string>() }
        },
      },
    })

    expect(occurrences).toEqual([])
    expect(deferred.nextRunAt).toBe('2026-09-01T00:00:00.000Z')
  })

  test('retries a started business-day run on its day even after the calendar moves the business day', async () => {
    const definition: RecurringWork = {
      ...createRecurringWork(),
      schedule: {
        frequency: 'monthly',
        interval: 1,
        timeZone: 'Asia/Tokyo',
        localTime: '09:00',
        startDate: '2026-07-16',
        dayOfMonth: 1,
        monthlyDay: 'business-day',
        catchUpPolicy: 'skip',
      },
      nextRunAt: '2026-08-03T00:00:00.000Z',
    }
    const harness = createRecurringExecutionHarness(definition)
    let holidays = new Set<string>()
    let failNext = true
    const occurrences: string[] = []
    const dependencies = {
      client: harness.client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute(_action, context) {
          if (failNext) {
            failNext = false
            throw new AutomationError('unavailable', 'TransientCreateFailure', 'Create is temporarily unavailable.', true)
          }
          occurrences.push(String(context.event.occurredAt))
        },
      },
      workCalendars: {
        async readTeamWorkCalendar() {
          return { workingWeekdays: new Set([1, 2, 3, 4, 5]), holidays }
        },
      },
    } satisfies AutomationScheduleDependencies

    // 2026-08-03 is the first business day (Monday); the first attempt fails and waits for a retry.
    const pending = await processRecurringWorkDefinition(definition, new Date('2026-08-03T00:00:10.000Z'), dependencies)
    expect(pending.lastRunAt).toBeUndefined()
    // The Team then marks August 3 as a holiday, which would move the first business day to the 4th.
    holidays = new Set(['2026-08-03'])
    const completed = await processRecurringWorkDefinition(pending, new Date('2026-08-03T06:00:00.000Z'), dependencies)

    expect(occurrences).toEqual(['2026-08-03T00:00:00.000Z'])
    expect(completed.lastRunAt).toBe('2026-08-03T00:00:00.000Z')
    expect(completed.nextRunAt).toBe('2026-09-01T00:00:00.000Z')
  })

  test('defers a business-day Recurring Work to its working day and runs it there', async () => {
    const definition: RecurringWork = {
      ...createRecurringWork(),
      schedule: {
        frequency: 'monthly',
        interval: 1,
        timeZone: 'Asia/Tokyo',
        localTime: '09:00',
        startDate: '2026-07-16',
        dayOfMonth: 1,
        monthlyDay: 'business-day',
        catchUpPolicy: 'skip',
      },
      // Calendar day 1 is the earliest day the first business day can fall on.
      nextRunAt: '2026-08-01T00:00:00.000Z',
    }
    const harness = createRecurringExecutionHarness(definition)
    let current = structuredClone(definition)
    const client: AutomationSchedulePort = {
      ...harness.client,
      async getRecurringWork() {
        return structuredClone(current)
      },
      async deferRecurringWork(_workspaceId, _id, expectedRevision, nextRunAt) {
        expect(expectedRevision).toBe(current.revision)
        current = { ...current, revision: current.revision + 1, nextRunAt }
        harness.setCurrentDefinition(current)
        return structuredClone(current)
      },
      async completeRecurringWork(_workspaceId, _id, expectedRevision, lastRunAt, nextRunAt) {
        expect(expectedRevision).toBe(current.revision)
        current = { ...current, revision: current.revision + 1, lastRunAt, nextRunAt }
        harness.setCurrentDefinition(current)
        return structuredClone(current)
      },
    }
    let created = 0
    const dependencies = {
      client,
      entitlement: enabledAutomationEntitlement,
      actionExecutor: {
        async execute() {
          created += 1
        },
      },
      workCalendars: {
        async readTeamWorkCalendar(workspaceId, teamId) {
          expect([workspaceId, teamId]).toEqual(['workspace-1', 'core-team'])
          // 2026-08-01 is a Saturday and 2026-08-03 a holiday, so the first business day is the 4th.
          return { workingWeekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set(['2026-08-03']) }
        },
      },
    } satisfies AutomationScheduleDependencies

    // Until the business day comes, the definition wakes every day at its local time.
    let deferred = definition
    for (const [now, next] of [
      ['2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'],
      ['2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z'],
      ['2026-08-03T00:00:00.000Z', '2026-08-04T00:00:00.000Z'],
    ] as const) {
      deferred = await processRecurringWorkDefinition(deferred, new Date(now), dependencies)
      expect(deferred.nextRunAt).toBe(next)
    }
    expect(created).toBe(0)

    const completed = await processRecurringWorkDefinition(
      deferred,
      new Date('2026-08-04T00:00:10.000Z'),
      dependencies,
    )
    expect(created).toBe(1)
    expect(completed.lastRunAt).toBe('2026-08-04T00:00:00.000Z')
    // 2026-09-01 is a Tuesday.
    expect(completed.nextRunAt).toBe('2026-09-01T00:00:00.000Z')
  })
})
