import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AutomationRuleEditor,
  AutomationTemplateEditor,
  createAutomationTrigger,
} from '../src/automation/ui/AutomationEditors'
import {
  createDefaultAutomationWorkflowTemplatePayload,
  parseAutomationTemplatePayload,
} from '../src/automation/model/editorValidation'

describe('Automation editors', () => {
  test('serializes source-only and bidirectional Work Item Type triggers', () => {
    expect(createAutomationTrigger(
      'work-item-type',
      '',
      'team-1',
      { direction: 'from', fromConfiguration: 'bug' },
    )).toEqual({
      fromWorkItemTypeId: 'bug',
      teamId: 'team-1',
      type: 'work-item-type',
    })
    expect(createAutomationTrigger(
      'work-item-type',
      'feature',
      'team-1',
      { direction: 'both', fromConfiguration: 'bug' },
    )).toEqual({
      fromWorkItemTypeId: 'bug',
      teamId: 'team-1',
      toWorkItemTypeId: 'feature',
      type: 'work-item-type',
    })
  })

  test('renders Work Item Type trigger direction controls', () => {
    const html = renderToStaticMarkup(
      <AutomationRuleEditor
        initialTriggerType="work-item-type"
        locale="en"
        onCreate={async () => undefined}
      />,
    )

    expect(html).toContain('data-testid="automation-rule-trigger-type-direction"')
    expect(html).toContain('value="from"')
    expect(html).toContain('value="both"')
  })

  test('keeps valid schedule time fields valid when only the cadence is invalid', () => {
    const html = renderToStaticMarkup(
      <AutomationRuleEditor
        initialSchedule={{
          catchUpPolicy: 'latest',
          dayOfMonth: 32,
          frequency: 'monthly',
          interval: 1,
          localTime: '09:00',
          startDate: '2026-03-01',
          timeZone: 'America/New_York',
        }}
        locale="en"
        onCreate={async () => undefined}
      />,
    )

    expect(readInput(html, 'automation-rule-schedule-time-zone')).toContain(
      'aria-invalid="false"',
    )
    expect(readInput(html, 'automation-rule-schedule-local-time')).toContain(
      'aria-invalid="false"',
    )
    expect(html).toContain('data-testid="automation-rule-schedule-cadence-error"')
  })

  test('rejects invalid typed Work Item template fields before returning the payload', () => {
    const invalidFields = {
      assignedProjectId: 1,
      assigneeUserId: null,
      customFieldValues: [],
      description: false,
      dueDate: '2026-07-31',
      schedule: { mode: 'unscheduled' },
      teamId: {},
      workflowStatusId: 2,
    }

    for (const [field, value] of Object.entries(invalidFields)) {
      expect(parseAutomationTemplatePayload(JSON.stringify({
        [field]: value,
        title: 'Review',
      }))).toEqual({ error: 'invalid-value' })
    }
  })

  test('accepts nullable Project assignment and string Work Item template fields', () => {
    expect(parseAutomationTemplatePayload(JSON.stringify({
      assignedProjectId: null,
      assigneeUserId: 'user-1',
      customFieldValues: { effort: 3, labels: ['review'] },
      description: 'Review open work',
      schedule: {
        calendarPolicy: {
          holidays: [],
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
        dueDate: '2026-07-31',
        mode: 'due-date',
      },
      teamId: 'team-1',
      title: 'Review',
      workflowStatusId: 'backlog',
    }))).toEqual({
      payload: {
        assignedProjectId: null,
        assigneeUserId: 'user-1',
        customFieldValues: { effort: 3, labels: ['review'] },
        description: 'Review open work',
        schedule: {
          calendarPolicy: {
            holidays: [],
            timeZone: 'UTC',
            workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          },
          dueDate: '2026-07-31',
          mode: 'due-date',
        },
        teamId: 'team-1',
        title: 'Review',
        workflowStatusId: 'backlog',
      },
    })
  })

  test('rejects a date range beyond the server planning horizon', () => {
    const startDate = '2000-01-01'
    const endDate = new Date(
      Date.parse(`${startDate}T00:00:00.000Z`) + 36_600 * 24 * 60 * 60 * 1_000,
    ).toISOString().slice(0, 10)

    expect(parseAutomationTemplatePayload(JSON.stringify({
      schedule: {
        calendarPolicy: {
          holidays: [],
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
        durationDays: 1,
        endDate,
        mode: 'date-range',
        startDate,
      },
      title: 'Excessive range',
    }))).toEqual({ error: 'invalid-value' })
  })

  test('creates localized initial Workflow and status names', () => {
    expect(createDefaultAutomationWorkflowTemplatePayload('ja')).toMatchObject({
      name: '状態の流れ',
      statuses: [
        { id: 'backlog', name: 'バックログ' },
        { id: 'in-progress', name: '進行中' },
        { id: 'done', name: '完了' },
      ],
    })
    expect(createDefaultAutomationWorkflowTemplatePayload('en')).toMatchObject({
      name: 'Status flow',
      statuses: [
        { id: 'backlog', name: 'Backlog' },
        { id: 'in-progress', name: 'In progress' },
        { id: 'done', name: 'Done' },
      ],
    })
  })

  test('uses the editor locale for initial Workflow field values', () => {
    const html = renderToStaticMarkup(
      <AutomationTemplateEditor
        initialKind="workflow"
        locale="ja"
        onCreate={async () => undefined}
      />,
    )

    expect(html).toContain('value="状態の流れ"')
    expect(html).toContain('value="バックログ"')
    expect(html).toContain('value="進行中"')
    expect(html).toContain('value="完了"')
  })
})

function readInput(html: string, testId: string) {
  const input = html.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`))?.[0]
  if (!input) throw new Error(`Input ${testId} was not rendered.`)
  return input
}
