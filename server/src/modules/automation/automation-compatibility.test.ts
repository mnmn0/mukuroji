import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { describe, expect, test } from 'bun:test'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationExecution,
  type AutomationRule,
} from '@mukuroji/contracts'
import {
  AutomationEngine,
  DynamoDbAutomationClient,
  type AutomationClient,
  type AutomationEvent,
  type AutomationExecutionReservation,
} from './automation'
import { createPendingAutomationExecution } from './application/pending-execution'

/** Focused reservation method exposed only through the compatibility engine internals. */
type FocusedReservationInvoker = {
  /** Reserves an already-created pending execution. */
  reserveExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    rule: AutomationRule,
  ): Promise<unknown>
}

/** Records calls made through the legacy execution reservation signature. */
class LegacyAutomationClientProbe extends DynamoDbAutomationClient {
  /** Legacy reservation arguments observed by the probe. */
  readonly reservations: Array<{
    /** Rule passed to the legacy client. */
    rule: AutomationRule
    /** Event passed to the legacy client. */
    event: AutomationEvent
    /** Start time reconstructed for the legacy client. */
    now: Date
  }> = []

  /** Creates a probe without performing AWS requests. */
  constructor() {
    super(
      'AutomationTable',
      DynamoDBDocumentClient.from(new DynamoDBClient({
        region: 'us-east-1',
        credentials: {
          accessKeyId: 'test',
          secretAccessKey: 'test',
        },
      })),
    )
  }

  /** Reports no existing execution so the engine reaches reservation. */
  override async getExecution(
    _workspaceId: string,
    _executionId: string,
  ): Promise<AutomationExecution | undefined> {
    return undefined
  }

  /** Rejects a focused call because this probe represents a legacy implementation. */
  override async reserveExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    rule: AutomationRule,
  ): Promise<AutomationExecutionReservation>
  /** Records a call through the legacy reservation signature. */
  async reserveExecution(
    rule: AutomationRule,
    event: AutomationEvent,
    now: Date,
  ): Promise<AutomationExecutionReservation>
  override async reserveExecution(
    executionOrRule: AutomationExecution | AutomationRule,
    event: AutomationEvent,
    ruleOrNow: AutomationRule | Date,
  ): Promise<AutomationExecutionReservation> {
    if (!(ruleOrNow instanceof Date) || 'ruleId' in executionOrRule) {
      throw new Error('The compatibility engine called the focused reservation signature.')
    }
    this.reservations.push({
      rule: executionOrRule,
      event,
      now: ruleOrNow,
    })
    return 'stale-definition'
  }
}

/** Creates a valid rule for compatibility execution tests. */
function createCompatibilityRule(): AutomationRule {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: 'rule-legacy-engine',
    workspaceId: 'workspace-1',
    name: 'Legacy engine rule',
    enabled: true,
    version: 2,
    revision: 3,
    trigger: { type: 'status', toStatusId: 'done' },
    conditions: [],
    actions: [{ type: 'comment', body: 'Reserved' }],
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 1_000,
      backoffMultiplier: 2,
      maxDelayMs: 60_000,
    },
    rateLimit: { maxExecutions: 10, windowSeconds: 60 },
    allowReentry: false,
    maxChainDepth: 8,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  }
}

/** Creates a matching event for compatibility execution tests. */
function createCompatibilityEvent(): AutomationEvent {
  return {
    eventId: 'event-legacy-engine',
    eventType: 'work-item.updated',
    workspaceId: 'workspace-1',
    occurredAt: '2026-07-16T00:00:01.000Z',
    changes: [{
      field: 'workflowStatusId',
      before: 'review',
      after: 'done',
    }],
  }
}

/** Narrows an unknown compatibility adapter to its focused reservation method. */
function isFocusedReservationInvoker(value: unknown): value is FocusedReservationInvoker {
  return typeof value === 'object' &&
    value !== null &&
    'reserveExecution' in value &&
    typeof value.reserveExecution === 'function'
}

describe('legacy AutomationEngine compatibility', () => {
  test('accepts an AutomationClient and calls its legacy reservation signature', async () => {
    const probe = new LegacyAutomationClientProbe()
    const legacyClient: AutomationClient = probe
    const engine = new AutomationEngine(legacyClient, {
      async execute() {
        throw new Error('A stale reservation must not execute actions.')
      },
    })
    const rule = createCompatibilityRule()
    const event = createCompatibilityEvent()
    const now = new Date('2026-07-16T00:00:02.000Z')

    expect(await engine.handleEvent(rule, event, {}, now)).toBeUndefined()
    expect(probe.reservations).toHaveLength(1)
    expect(probe.reservations[0]).toEqual({
      rule,
      event,
      now,
    })
  })

  test('fails closed before a legacy call when execution startedAt is invalid', async () => {
    const engine = new AutomationEngine(new LegacyAutomationClientProbe(), {
      async execute() {},
    })
    const adaptedClient: unknown = Reflect.get(engine, 'client')
    if (!isFocusedReservationInvoker(adaptedClient)) {
      throw new Error('The compatibility execution adapter is unavailable.')
    }
    const rule = createCompatibilityRule()
    const event = createCompatibilityEvent()
    const execution = {
      ...createPendingAutomationExecution(
        rule,
        event,
        new Date('2026-07-16T00:00:02.000Z'),
      ),
      startedAt: 'not-a-timestamp',
    } satisfies AutomationExecution

    await expect(adaptedClient.reserveExecution(execution, event, rule))
      .rejects.toMatchObject({
        category: 'unavailable',
        code: 'AutomationExecutionStartedAtInvalid',
      })
  })
})
