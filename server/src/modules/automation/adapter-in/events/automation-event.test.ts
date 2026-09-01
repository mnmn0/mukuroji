import { describe, expect, test } from 'bun:test'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationExecution,
  type AutomationRule,
} from '@mukuroji/contracts'
import {
  AutomationError,
} from '../../domain/automation-error'
import { DynamoDbAutomationRepository } from '../../adapter-out/dynamodb/automation-repository'
import type { AutomationEvent } from '../../domain/rule-evaluation'
import {
  createAutomationEventProcessor,
  parseAutomationStreamRecord,
  processAutomationEventBatch,
  type AutomationEventPort,
} from './automation-event'
import type { AutomationFeatureEntitlementPort } from '../../application/ports'
import type {
  DynamoStreamEvent,
} from '../../../collaboration/adapter-in/events/collaboration-projection'

const enabledAutomationEntitlement: AutomationFeatureEntitlementPort = {
  /** Allows Automation execution in tests that focus on event delivery behavior. */
  async isAutomationEnabled() {
    return true
  },
}

describe('automation event handler', () => {
  test('delivers an event to rules from every DynamoDB query page', async () => {
    const firstRule = createRule('rule-first')
    const secondRule = createRule('rule-second')
    const cursor = { scopeKey: 'workspace-1#automation', recordKey: 'RULE#cursor' }
    const queries: Array<Record<string, unknown>> = []
    const documentClient = {
      async send(command: { input: Record<string, unknown> }) {
        queries.push(command.input)
        return command.input.ExclusiveStartKey
          ? { Items: [toRuleStorage(secondRule)] }
          : { Items: [toRuleStorage(firstRule)], LastEvaluatedKey: cursor }
      },
    } as unknown as ConstructorParameters<typeof DynamoDbAutomationRepository>[1]
    const client = new DynamoDbAutomationRepository('AutomationTable', documentClient)
    const handled: string[] = []
    const processor = createAutomationEventProcessor(client, enabledAutomationEntitlement, {
      async handleEvent(rule) {
        handled.push(rule.id)
        return undefined
      },
    })

    await processor.process({
      eventId: 'event-paginated',
      eventType: 'work-item.updated',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-16T00:00:00.000Z',
      changes: [],
    })

    expect(handled.sort()).toEqual(['rule-first', 'rule-second'])
    expect(queries).toHaveLength(2)
    expect(queries[0]?.ConsistentRead).toBe(true)
    expect(queries[1]?.ExclusiveStartKey).toEqual(cursor)
  })

  test('acknowledges events without reading rules when tenant Automation is disabled', async () => {
    let ruleReads = 0
    const client = createAutomationEventPort({
      async listRules() {
        ruleReads += 1
        return []
      },
    })
    const processor = createAutomationEventProcessor(client, {
      async isAutomationEnabled(workspaceId) {
        expect(workspaceId).toBe('workspace-1')
        return false
      },
    }, {
      async handleEvent() {
        throw new Error('Disabled Automation must not execute rules.')
      },
    })

    await processor.process({
      eventId: 'event-disabled',
      eventType: 'work-item.updated',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-16T00:00:00.000Z',
      changes: [],
    })

    expect(ruleReads).toBe(0)
  })

  /** Verifies completion-notification preparation is retried independently of Automation rules. */
  test('retries Customer completion preparation even when Automation is disabled', async () => {
    const client = createAutomationEventPort({
      async listRules() {
        throw new Error('Disabled Automation must not read rules.')
      },
    })
    const prepared: Array<[string, string, string, string]> = []
    const processor = createAutomationEventProcessor(
      client,
      {
        async isAutomationEnabled() {
          return false
        },
      },
      undefined,
      undefined,
      {
        async prepareCompletionNotifications(workspaceId, teamId, workItemId, actorId) {
          prepared.push([workspaceId, teamId, workItemId, actorId])
        },
      },
    )

    await processor.process({
      eventId: 'event-customer-completion',
      eventType: 'work-item.updated',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-16T00:00:00.000Z',
      changes: [],
      metadata: {
        completionTransition: true,
        teamId: 'support',
        issueId: 'work-item-1',
      },
    })

    expect(prepared).toEqual([[
      'workspace-1',
      'support',
      'work-item-1',
      'automation-customer-completion-projection',
    ]])
  })

  test('normalizes audit metadata, changes, and automation lineage', () => {
    const event = parseAutomationStreamRecord({
      eventName: 'INSERT',
      dynamodb: {
        NewImage: {
          eventId: { S: 'event-1' },
          eventType: { S: 'work-item.updated' },
          workspaceId: { S: 'workspace-1' },
          occurredAt: { S: '2026-07-16T00:00:00.000Z' },
          outboxStatus: { S: 'pending' },
          changes: {
            L: [{ M: {
              field: { S: 'workflowStatusId' },
              before: { S: 'todo' },
              after: { S: 'review' },
            } }],
          },
          metadata: {
            M: {
              teamId: { S: 'core-team' },
              issueId: { S: 'issue-1' },
              automationRuleLineage: { L: [{ S: 'rule-parent' }] },
            },
          },
        },
      },
    })

    expect(event).toMatchObject({
      automationRuleLineage: ['rule-parent'],
      eventId: 'event-1',
      eventType: 'work-item.updated',
      metadata: { issueId: 'issue-1', teamId: 'core-team' },
      changes: [{ field: 'workflowStatusId', before: 'todo', after: 'review' }],
    })
  })

  test('preserves stream order and stops at the first failed record', async () => {
    const streamEvent = {
      Records: [
        createRecord('event-ok', 'sequence-ok'),
        createRecord('event-failed', 'sequence-failed'),
        createRecord('event-not-started', 'sequence-not-started'),
      ],
    } satisfies DynamoStreamEvent
    const attempted: string[] = []

    const response = await processAutomationEventBatch(streamEvent, {
      async process(event) {
        attempted.push(event.eventId)
        if (event.eventId === 'event-failed') throw new Error('retry me')
      },
    })

    expect(attempted).toEqual(['event-ok', 'event-failed'])
    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: 'sequence-failed' }],
    })
  })

  test('awaits each successful stream record before starting the next one', async () => {
    const transitions: string[] = []

    const response = await processAutomationEventBatch({
      Records: [
        createRecord('event-first', 'sequence-first'),
        createRecord('event-second', 'sequence-second'),
      ],
    }, {
      async process(event) {
        transitions.push(`start:${event.eventId}`)
        await Promise.resolve()
        transitions.push(`end:${event.eventId}`)
      },
    })

    expect(transitions).toEqual([
      'start:event-first',
      'end:event-first',
      'start:event-second',
      'end:event-second',
    ])
    expect(response).toEqual({ batchItemFailures: [] })
  })

  test('fails closed for malformed inserted outbox records', async () => {
    const processed: string[] = []
    const response = await processAutomationEventBatch({
      Records: [
        {
          eventName: 'INSERT',
          dynamodb: {
            SequenceNumber: 'sequence-malformed',
            NewImage: {
              eventId: { S: 'event-malformed' },
              outboxStatus: { S: 'pending' },
            },
          },
        },
        createRecord('event-not-started', 'sequence-not-started'),
      ],
    }, {
      async process(event) {
        processed.push(event.eventId)
      },
    })

    expect(processed).toEqual([])
    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: 'sequence-malformed' }],
    })
  })

  test('fails closed for an inserted outbox record with an invalid occurrence time', async () => {
    const invalidRecord = createRecord('event-invalid-time', 'sequence-invalid-time')
    invalidRecord.dynamodb.NewImage.occurredAt = { S: 'not-a-timestamp' }
    const processed: string[] = []

    const response = await processAutomationEventBatch({
      Records: [invalidRecord],
    }, {
      async process(event) {
        processed.push(event.eventId)
      },
    })

    expect(processed).toEqual([])
    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: 'sequence-invalid-time' }],
    })
  })

  test('acknowledges a durably scheduled retry and propagates persistence failures', async () => {
    const rule = createRule('rule-1')
    const event: AutomationEvent = {
      eventId: 'event-1',
      eventType: 'work-item.updated',
      workspaceId: 'workspace-1',
      occurredAt: '2026-07-16T00:00:00.000Z',
      changes: [],
    }
    const failedExecution: AutomationExecution = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: 'automation-execution-1',
      workspaceId: event.workspaceId,
      ruleId: rule.id,
      ruleVersion: 1,
      triggerEventId: event.eventId,
      status: 'failed',
      attempts: 1,
      actions: [],
      startedAt: event.occurredAt,
      nextRetryAt: '2026-07-16T00:01:00.000Z',
      retryable: true,
    }
    const client = createAutomationEventPort({
      async listRules() {
        return [rule]
      },
    })
    let handled = 0
    const processor = createAutomationEventProcessor(client, enabledAutomationEntitlement, {
      async handleEvent(candidateRule, candidateEvent) {
        handled += 1
        expect(candidateRule).toBe(rule)
        expect(candidateEvent).toEqual(event)
        return failedExecution
      },
    })

    await processor.process(event)

    expect(handled).toBe(1)
    const persistenceError = new AutomationError(
      'unavailable',
      'AutomationPersistenceUnavailable',
      'Execution state could not be saved.',
      true,
    )
    const rejectingProcessor = createAutomationEventProcessor(client, enabledAutomationEntitlement, {
      async handleEvent() {
        throw persistenceError
      },
    })
    await expect(rejectingProcessor.process(event)).rejects.toBe(persistenceError)
  })
})

function createRule(id: string): AutomationRule {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id,
    workspaceId: 'workspace-1',
    name: id,
    enabled: true,
    version: 1,
    revision: 1,
    trigger: { type: 'status' },
    conditions: [],
    actions: [{ type: 'comment', body: 'Handled' }],
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1_000, backoffMultiplier: 2, maxDelayMs: 60_000 },
    rateLimit: { maxExecutions: 100, windowSeconds: 60 },
    allowReentry: false,
    maxChainDepth: 8,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  }
}

/**
 * Fails a test when an event-port capability was not configured explicitly.
 *
 * @returns Never returns.
 */
function unexpectedAutomationEventPortCall(): never {
  throw new Error('Unexpected Automation event port call.')
}

/**
 * Creates a complete focused event port with fail-fast defaults.
 *
 * @param overrides - Capabilities exercised by the current test.
 * @returns A type-safe Automation event port.
 */
function createAutomationEventPort(
  overrides: Partial<AutomationEventPort> = {},
): AutomationEventPort {
  return {
    async listDueExecutions() {
      return unexpectedAutomationEventPortCall()
    },
    async reserveExecution() {
      return unexpectedAutomationEventPortCall()
    },
    async createExecution() {
      return unexpectedAutomationEventPortCall()
    },
    async getExecution() {
      return unexpectedAutomationEventPortCall()
    },
    async getExecutionEvent() {
      return unexpectedAutomationEventPortCall()
    },
    async claimExecution() {
      return unexpectedAutomationEventPortCall()
    },
    async saveExecution() {
      return unexpectedAutomationEventPortCall()
    },
    async listExecutions() {
      return unexpectedAutomationEventPortCall()
    },
    async hasActionReceipt() {
      return unexpectedAutomationEventPortCall()
    },
    async putActionReceipt() {
      return unexpectedAutomationEventPortCall()
    },
    async getRuleVersion() {
      return unexpectedAutomationEventPortCall()
    },
    async getRecurringWork() {
      return unexpectedAutomationEventPortCall()
    },
    async listRules() {
      return unexpectedAutomationEventPortCall()
    },
    ...overrides,
  }
}

function toRuleStorage(rule: AutomationRule) {
  return {
    scopeKey: `${rule.workspaceId}#automation`,
    recordKey: `RULE#${rule.id}`,
    entryType: 'rule',
    ...rule,
  }
}

function createRecord(eventId: string, sequenceNumber: string) {
  return {
    eventName: 'INSERT',
    dynamodb: {
      SequenceNumber: sequenceNumber,
      NewImage: {
        eventId: { S: eventId },
        eventType: { S: 'work-item.updated' },
        workspaceId: { S: 'workspace-1' },
        occurredAt: { S: '2026-07-16T00:00:00.000Z' },
        outboxStatus: { S: 'pending' },
      },
    },
  }
}
