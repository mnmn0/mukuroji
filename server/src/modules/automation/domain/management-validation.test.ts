import { describe, expect, test } from 'bun:test'
import {
  validateApplyAutomationTemplateInput,
  validateCreateAutomationInboundWebhookEndpointInput,
  validateCreateAutomationTemplateInput,
  validateCreateRecurringWorkInput,
} from './management-validation'

describe('Automation management validation domain', () => {
  test('normalizes template and application inputs without persistence state', () => {
    expect(validateCreateAutomationTemplateInput({
      kind: 'work-item',
      name: 'Bug template',
      enabled: true,
      payload: {
        title: 'Investigate',
        priority: 'high',
        customFieldValues: { severity: 'critical' },
      },
    })).toEqual({
      kind: 'work-item',
      name: 'Bug template',
      enabled: true,
      payload: {
        title: 'Investigate',
        priority: 'high',
        customFieldValues: { severity: 'critical' },
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
  })
})
