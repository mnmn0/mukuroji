import { describe, expect, test } from 'bun:test'
import { parseAutomationTemplatePayload } from '../src/automation/model/editorValidation'
import {
  applyWorkItemTemplateFormValue,
  createInitialWorkItemTemplateJson,
  readWorkItemTemplateFormValues,
} from '../src/automation/model/workItemTemplateForm'

describe('Work Item template form', () => {
  test('starts from a payload that becomes valid once the title is typed', () => {
    const initial = createInitialWorkItemTemplateJson()
    expect('error' in parseAutomationTemplatePayload(initial)).toBe(true)
    const titled = applyWorkItemTemplateFormValue(initial, 'title', 'Weekly report')
    const result = parseAutomationTemplatePayload(titled)
    expect('payload' in result && result.payload.title).toBe('Weekly report')
  })

  test('writes form fields and keeps the fields the form does not edit', () => {
    const schedule = {
      mode: 'unscheduled',
      calendarPolicy: { timeZone: 'Asia/Tokyo', workingWeekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-23'] },
    }
    const json = JSON.stringify({
      title: 'Review',
      customFieldValues: { points: 3 },
      schedule,
    })
    let next = applyWorkItemTemplateFormValue(json, 'priority', 'high')
    next = applyWorkItemTemplateFormValue(next, 'assigneeUserId', 'member-1')
    next = applyWorkItemTemplateFormValue(next, 'description', 'Check the draft')
    expect(readWorkItemTemplateFormValues(next)).toMatchObject({
      title: 'Review',
      priority: 'high',
      assigneeUserId: 'member-1',
      description: 'Check the draft',
    })
    expect(JSON.parse(next)).toMatchObject({ customFieldValues: { points: 3 } })
    expect(JSON.parse(next).schedule).toEqual(schedule)

    next = applyWorkItemTemplateFormValue(next, 'priority', '')
    next = applyWorkItemTemplateFormValue(next, 'assigneeUserId', ' ')
    expect(JSON.parse(next)).not.toHaveProperty('priority')
    expect(JSON.parse(next)).not.toHaveProperty('assigneeUserId')
  })

  test('leaves JSON that is not an object for the advanced editor to fix', () => {
    expect(readWorkItemTemplateFormValues('[1')).toBeUndefined()
    expect(applyWorkItemTemplateFormValue('[]', 'title', 'x')).toBe('[]')
  })
})
