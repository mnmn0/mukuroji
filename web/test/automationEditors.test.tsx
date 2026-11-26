import { describe, expect, test } from 'bun:test'
import type { AutomationAction } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AutomationRuleEditor,
  AutomationTemplateEditor,
  BaselineSlipDaysField,
} from '../src/automation/ui/AutomationEditors'
import { createRecurringSchedule } from '../src/automation/model/recurringSchedule'
import { createTranslator } from '../src/shared/i18n/i18n'
import {
  createDefaultAutomationWorkflowTemplatePayload,
  createAutomationScheduleTrigger,
  createAutomationTrigger,
  isAutomationTriggerConfigurationValid,
  readAutomationDueDaysBefore,
  parseAutomationTemplatePayload,
  readAutomationActionTypesForTrigger,
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

  test('serializes and validates the baseline-slip day count', () => {
    expect(createAutomationTrigger('baseline-slip', ' 5 ')).toEqual({ type: 'baseline-slip', minDelayDays: 5 })
    expect(createAutomationTrigger('baseline-slip', '')).toEqual({ type: 'baseline-slip' })
    expect(isAutomationTriggerConfigurationValid('baseline-slip', '')).toBe(true)
    expect(isAutomationTriggerConfigurationValid('baseline-slip', '365')).toBe(true)
    for (const value of ['0', '366', '1.5', 'three']) {
      expect(isAutomationTriggerConfigurationValid('baseline-slip', value)).toBe(false)
    }
  })

  test('builds a budget-threshold trigger that takes no configuration', () => {
    expect(createAutomationTrigger('budget-threshold', 'ignored')).toEqual({ type: 'budget-threshold' })
    expect(isAutomationTriggerConfigurationValid('budget-threshold', '')).toBe(true)
    const html = renderToStaticMarkup(
      <AutomationRuleEditor
        initialTriggerType="budget-threshold"
        locale="ja"
        onCreate={async () => undefined}
      />,
    )
    expect(html).toContain('予算消化率が閾値に到達')
  })

  test('offers a budget-threshold rule only actions that need no Work Item', () => {
    const all: AutomationAction['type'][] = ['assign', 'move', 'update', 'create', 'comment', 'notify', 'approval', 'webhook']
    expect(readAutomationActionTypesForTrigger(all, 'budget-threshold')).toEqual(['create', 'notify', 'webhook'])
    expect(readAutomationActionTypesForTrigger(all, 'status')).toEqual(all)
  })

  test('renders the baseline-slip day field', () => {
    const html = renderToStaticMarkup(
      <AutomationRuleEditor
        initialTriggerType="baseline-slip"
        locale="ja"
        onCreate={async () => undefined}
      />,
    )
    expect(html).toContain('ベースラインより何日遅れたら')
    expect(html).toContain('inputMode="numeric"')
    expect(html).toContain('aria-describedby="automation-rule-baseline-slip-days-hint"')
  })

  test('explains an out-of-range baseline-slip day count next to the field', () => {
    const t = createTranslator('ja')
    const render = (value: string) =>
      renderToStaticMarkup(<BaselineSlipDaysField t={t} value={value} onChange={() => undefined} />)
    for (const value of ['', '1', '365']) {
      expect(render(value)).not.toContain('aria-invalid')
    }
    for (const value of ['0', '366']) {
      const html = render(value)
      expect(html).toContain('aria-invalid="true"')
      expect(html).toContain('aria-describedby="automation-rule-baseline-slip-days-error automation-rule-baseline-slip-days-hint"')
      expect(html).toContain('1〜365 の整数で入力してください。')
    }
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

  test('starts a budget-threshold rule on an action it can run', () => {
    const html = renderToStaticMarkup(
      <AutomationRuleEditor initialTriggerType="budget-threshold" locale="en" onCreate={async () => undefined} />,
    )
    expect(html).toMatch(/<option value="notify" selected="">/u)
    expect(html).not.toContain('<option value="move"')
  })

  test('hides the form and webhook options from a Team rule', () => {
    const render = (teamScoped: boolean) => renderToStaticMarkup(
      <AutomationRuleEditor locale="en" teamScoped={teamScoped} onCreate={async () => undefined} />,
    )

    expect(render(false)).toContain('value="form"')
    expect(render(false)).toContain('value="webhook"')
    expect(render(true)).not.toContain('value="form"')
    expect(render(true)).not.toContain('value="webhook"')
  })

  test('serializes a relation trigger for one or every relation change', () => {
    expect(createAutomationTrigger('relation', '')).toEqual({ type: 'relation' })
    expect(createAutomationTrigger('relation', 'work-item.blocker-removed')).toEqual({
      eventTypes: ['work-item.blocker-removed'],
      type: 'relation',
    })
    expect(isAutomationTriggerConfigurationValid('relation', '')).toBe(true)
    expect(isAutomationTriggerConfigurationValid('relation', 'work-item.parent-changed')).toBe(true)
    expect(isAutomationTriggerConfigurationValid('relation', 'work-item.updated')).toBe(false)
  })

  test('renders the relation change picker with every relation event', () => {
    const html = renderToStaticMarkup(
      <AutomationRuleEditor
        initialTriggerType="relation"
        locale="ja"
        onCreate={async () => undefined}
      />,
    )

    expect(html).toContain('data-testid="automation-rule-relation-event"')
    expect(html).toContain('すべての変更')
    expect(html).toContain('value="work-item.blocker-removed"')
    expect(html).toContain('blocker の解除')
    expect(html).toContain('value="work-item.sibling-order-changed"')
  })

  test('serializes approval decision triggers', () => {
    expect(createAutomationTrigger('approval', 'rejected')).toEqual({ type: 'approval', decision: 'rejected' })
    expect(createAutomationTrigger('approval', '')).toEqual({ type: 'approval' })
    expect(isAutomationTriggerConfigurationValid('approval', 'changes-requested')).toBe(true)
    expect(isAutomationTriggerConfigurationValid('approval', 'pending')).toBe(false)
    const html = renderToStaticMarkup(
      <AutomationRuleEditor initialTriggerType="approval" locale="ja" onCreate={async () => undefined} />,
    )
    expect(html).toContain('data-testid="automation-rule-approval-decision"')
    expect(html).toContain('全員が承認')
  })

  test('serializes due-soon schedules, month ends, and business days', () => {
    const base = {
      catchUpPolicy: 'latest',
      frequency: 'daily',
      localTime: '09:00',
      startDate: '2026-03-01',
      timeZone: 'Asia/Tokyo',
    } as const
    expect(createAutomationScheduleTrigger(base, 3)).toMatchObject({
      type: 'schedule',
      dueWorkItems: { daysBefore: 3 },
    })
    expect(createAutomationScheduleTrigger(base)).not.toHaveProperty('dueWorkItems')
    expect(readAutomationDueDaysBefore('')).toBeNull()
    expect(readAutomationDueDaysBefore(' 0 ')).toBe(0)
    expect(readAutomationDueDaysBefore('366')).toBeUndefined()
    expect(readAutomationDueDaysBefore('-1')).toBeUndefined()
    expect(createRecurringSchedule({ ...base, frequency: 'monthly', dayOfMonth: 15, monthlyDay: 'last-day' }))
      .toEqual({ ...base, frequency: 'monthly', interval: 1, monthlyDay: 'last-day' })
    expect(createRecurringSchedule({ ...base, frequency: 'monthly', dayOfMonth: 3, monthlyDay: 'business-day' }))
      .toEqual({ ...base, frequency: 'monthly', interval: 1, dayOfMonth: 3, monthlyDay: 'business-day' })
    expect(() => createRecurringSchedule({ ...base, frequency: 'monthly', dayOfMonth: 24, monthlyDay: 'business-day' }))
      .toThrow('business day')
  })

  test('renders the due-soon field and month-end choice for schedule rules', () => {
    const ruleHtml = renderToStaticMarkup(
      <AutomationRuleEditor
        initialSchedule={{
          catchUpPolicy: 'latest',
          dayOfMonth: 1,
          frequency: 'monthly',
          interval: 1,
          localTime: '09:00',
          startDate: '2026-03-01',
          timeZone: 'Asia/Tokyo',
        }}
        locale="ja"
        onCreate={async () => undefined}
      />,
    )
    expect(ruleHtml).toContain('data-testid="automation-rule-schedule-due-days-before"')
    expect(ruleHtml).toContain('月末')
    expect(ruleHtml).not.toContain('value="business-day"')
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

  test('reads the contributors a Work Item template starts with', () => {
    const schedule = {
      calendarPolicy: {
        holidays: [],
        timeZone: 'UTC',
        workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      },
      mode: 'unscheduled',
    }
    const parse = (contributorAssignments: unknown) => parseAutomationTemplatePayload(JSON.stringify({
      contributorAssignments,
      schedule,
      title: 'Release',
    }))

    expect(parse([{ jobRoleId: 'qa', plannedEffortMinutes: 240 }, { memberUserId: 'dev@example.com' }])).toMatchObject({
      payload: {
        contributorAssignments: [{ jobRoleId: 'qa', plannedEffortMinutes: 240 }, { memberUserId: 'dev@example.com' }],
      },
    })
    for (const invalid of [[{}], [{ jobRoleId: 'qa', plannedEffortMinutes: 1.5 }], [{ jobRoleId: 'qa', extra: true }], {}]) {
      expect(parse(invalid)).toEqual({ error: 'invalid-value' })
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

  test('keeps Work Item template acceptance criteria within the Work Item limits', () => {
    const payload = (acceptanceCriteria: unknown) => JSON.stringify({
      acceptanceCriteria,
      schedule: {
        calendarPolicy: {
          holidays: [],
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
        mode: 'unscheduled',
      },
      title: 'Release',
    })

    expect(parseAutomationTemplatePayload(payload([' Tests pass ', 'Docs updated'])))
      .toMatchObject({ payload: { acceptanceCriteria: ['Tests pass', 'Docs updated'] } })
    expect(parseAutomationTemplatePayload(payload([]))).not.toHaveProperty('payload.acceptanceCriteria')
    for (const invalid of ['Tests pass', ['  '], ['x'.repeat(1025)], [1], Array.from({ length: 21 }, (_, index) => `C${index}`)]) {
      expect(parseAutomationTemplatePayload(payload(invalid))).toEqual({ error: 'invalid-value' })
    }
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
