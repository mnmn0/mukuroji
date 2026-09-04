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
      teamId: 'team-1',
      fromWorkItemTypeId: 'default',
      toWorkItemTypeId: 'incident',
    }, {
      ...event,
      metadata: { teamId: 'team-1' },
      changes: [{ field: 'workItemTypeId', before: 'default', after: 'incident' }],
    })).toBe(true)
    expect(matchesAutomationTrigger({
      type: 'work-item-type',
      teamId: 'team-1',
      toWorkItemTypeId: 'incident',
    }, {
      ...event,
      metadata: { teamId: 'team-2' },
      changes: [{ field: 'workItemTypeId', before: 'default', after: 'incident' }],
    })).toBe(false)
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
    expect(validateCreateAutomationRuleInput({
      name: 'Incident type change',
      enabled: true,
      trigger: {
        type: 'work-item-type',
        teamId: ' team-1 ',
        toWorkItemTypeId: 'incident',
      },
      actions: [{ type: 'comment', body: 'Changed' }],
    }).trigger).toEqual({
      type: 'work-item-type',
      teamId: 'team-1',
      toWorkItemTypeId: 'incident',
    })
    expect(() => validateCreateAutomationRuleInput({
      name: 'Unqualified type change',
      enabled: true,
      trigger: { type: 'work-item-type', toWorkItemTypeId: 'incident' },
      actions: [{ type: 'comment', body: 'Changed' }],
    })).toThrow('Work Item Type trigger Team ID is required.')
  })
})
