import { describe, expect, test } from 'bun:test'
import {
  evaluateAutomationCondition,
  matchesAutomationTrigger,
  type AutomationEvent,
} from './rule-evaluation'
import { validateCreateAutomationRuleInput } from './rule-validation'

const event: AutomationEvent = {
  eventId: 'event-1',
  eventType: 'work-item.updated',
  workspaceId: 'workspace-1',
  occurredAt: '2026-07-22T00:00:00.000Z',
  changes: [{
    field: 'workflowStatusId',
    before: 'review',
    after: 'done',
  }],
  workItem: {
    priority: 'high',
    estimate: 8,
  },
}

describe('Automation rule domain', () => {
  test('matches trigger filters without AWS or transport state', () => {
    expect(matchesAutomationTrigger({
      type: 'status',
      fromStatusId: 'review',
      toStatusId: 'done',
    }, event)).toBe(true)
    expect(matchesAutomationTrigger({
      type: 'status',
      toStatusId: 'cancelled',
    }, event)).toBe(false)
    expect(matchesAutomationTrigger({
      type: 'work-item-type',
      fromWorkItemTypeId: 'default',
      toWorkItemTypeId: 'incident',
    }, {
      ...event,
      changes: [{ field: 'workItemTypeId', before: 'default', after: 'incident' }],
    })).toBe(true)
  })

  test('evaluates nested conditions against typed domain roots', () => {
    expect(evaluateAutomationCondition({
      type: 'all',
      conditions: [
        {
          type: 'field',
          field: 'workItem.priority',
          operator: 'equals',
          value: 'high',
        },
        {
          type: 'field',
          field: 'workItem.estimate',
          operator: 'greater-than-or-equal',
          value: 5,
        },
      ],
    }, { event, workItem: event.workItem })).toBe(true)
  })

  test('normalizes untrusted Rule input in the pure domain boundary', () => {
    const input = validateCreateAutomationRuleInput({
      name: 'Complete review',
      enabled: true,
      trigger: { type: 'status', toStatusId: 'done' },
      conditions: [],
      actions: [{ type: 'comment', body: 'Completed' }],
      retryPolicy: {
        maxAttempts: 3,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        maxDelayMs: 1_000,
      },
      rateLimit: { maxExecutions: 10, windowSeconds: 60 },
    })

    expect(input.name).toBe('Complete review')
    expect(input.actions).toEqual([{ type: 'comment', body: 'Completed' }])
  })
})
