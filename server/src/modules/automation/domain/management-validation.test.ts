import { describe, expect, test } from 'bun:test'
import {
  createDefaultUnscheduledWorkItemSchedule,
} from '@mukuroji/contracts'
import {
  validateApplyAutomationTemplateInput,
  validateCreateAutomationInboundWebhookEndpointInput,
  validateCreateAutomationTemplateInput,
  validateCreateRecurringWorkInput,
} from './management-validation'

describe('Automation management validation domain', () => {
  test('preserves required-field messages at the extracted validation boundary', () => {
    expect(() => validateCreateRecurringWorkInput({})).toThrow(
      'Recurring Work name is required.',
    )
    expect(() => validateCreateAutomationInboundWebhookEndpointInput({})).toThrow(
      'Inbound webhook endpoint name is required.',
    )
  })

  test('normalizes template and application inputs without persistence state', () => {
    const schedule = createDefaultUnscheduledWorkItemSchedule()
    expect(validateCreateAutomationTemplateInput({
      kind: 'work-item',
      name: 'Bug template',
      enabled: true,
      payload: {
        title: 'Investigate',
        priority: 'high',
        customFieldValues: { severity: 'critical' },
        schedule,
      },
    })).toEqual({
      kind: 'work-item',
      name: 'Bug template',
      enabled: true,
      payload: {
        title: 'Investigate',
        priority: 'high',
        customFieldValues: { severity: 'critical' },
        schedule,
      },
    })
    expect(validateApplyAutomationTemplateInput({
      target: {
        kind: 'workflow',
        scopeType: 'team',
        scopeId: 'core',
        expectedRevision: 0,
      },
    })).toMatchObject({ target: { kind: 'workflow', expectedRevision: 0 } })
  })

  test('validates webhook and recurring inputs at a transport-neutral boundary', () => {
    expect(validateCreateAutomationInboundWebhookEndpointInput({ name: '  CI  ' }))
      .toEqual({ name: 'CI' })
    expect(validateCreateRecurringWorkInput({
      name: 'Weekly review',
      teamId: 'core',
      enabled: true,
      templateId: 'template-1',
      schedule: {
        frequency: 'weekly',
        interval: 1,
        timeZone: 'Asia/Tokyo',
        localTime: '09:30',
        startDate: '2026-07-01',
        daysOfWeek: [1],
        catchUpPolicy: 'skip',
      },
    })).toMatchObject({
      name: 'Weekly review',
      schedule: { frequency: 'weekly', timeZone: 'Asia/Tokyo' },
    })
  })

  test('rejects unsupported management fields', () => {
    expect(() => validateCreateAutomationTemplateInput({
      kind: 'project',
      name: 'Project',
      enabled: true,
      payload: { name: 'Project', hidden: true },
    })).toThrow('unsupported fields')
    expect(() => validateCreateAutomationTemplateInput({
      kind: 'work-item',
      name: 'Legacy deadline',
      enabled: true,
      payload: { title: 'Review', dueDate: '2026-07-31' },
    })).toThrow('unsupported fields')
  })
})
