import { describe, expect, test } from 'bun:test'
import {
  AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_PLANNING_ENTITY_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_DEPTH_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT,
  createDefaultUnscheduledWorkItemSchedule,
  WORK_ITEM_TITLE_MAX_LENGTH,
  type AutomationProjectTemplateWorkItem,
} from '@mukuroji/contracts'
import {
  listProjectTemplateWbsNumbers,
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

  test('keeps the contributors a Work Item template starts with and rejects malformed ones', () => {
    const schedule = createDefaultUnscheduledWorkItemSchedule()
    const template = (contributorAssignments: unknown) => validateCreateAutomationTemplateInput({
      kind: 'work-item',
      name: 'Release template',
      enabled: true,
      payload: { title: 'Release', schedule, contributorAssignments },
    })

    expect(template([
      { jobRoleId: 'qa', plannedEffortMinutes: 240 },
      { memberUserId: ' Dev@Example.com ', status: 'in-progress' },
    ]).payload).toMatchObject({
      contributorAssignments: [
        { jobRoleId: 'qa', plannedEffortMinutes: 240 },
        { memberUserId: 'dev@example.com', status: 'in-progress' },
      ],
    })
    expect(template([]).payload).not.toHaveProperty('contributorAssignments')
    for (const invalid of [
      [{}],
      [{ jobRoleId: 'qa', plannedEffortMinutes: -1 }],
      [{ jobRoleId: 'qa', status: 'blocked' }],
      [{ jobRoleId: 'qa', assignmentId: 'a'.repeat(32) }],
      Array.from({ length: 21 }, () => ({ jobRoleId: 'qa' })),
      'qa',
    ]) {
      expect(() => template(invalid)).toThrow()
    }
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

  test('bounds a Work Item template title like a Work Item title', () => {
    const template = (title: string) => ({
      kind: 'work-item',
      name: 'Long title',
      enabled: true,
      payload: { title, schedule: createDefaultUnscheduledWorkItemSchedule() },
    })
    expect(validateCreateAutomationTemplateInput(template('🙂'.repeat(WORK_ITEM_TITLE_MAX_LENGTH))))
      .toMatchObject({ payload: { title: '🙂'.repeat(WORK_ITEM_TITLE_MAX_LENGTH) } })
    expect(() => validateCreateAutomationTemplateInput(template('a'.repeat(WORK_ITEM_TITLE_MAX_LENGTH + 1))))
      .toThrow(`Work Item template title must be ${WORK_ITEM_TITLE_MAX_LENGTH} characters or fewer.`)
  })

  test('rejects a Project template name that Project creation would refuse', () => {
    const template = (nameJa: string) => ({
      kind: 'project',
      name: 'Project template',
      enabled: true,
      payload: { nameJa },
    })
    expect(() => validateCreateAutomationTemplateInput(template('line\nbreak')))
      .toThrow('Project template Japanese name must not contain control characters.')
  })

  test('validates webhook and recurring inputs at a transport-neutral boundary', () => {
    expect(validateCreateAutomationInboundWebhookEndpointInput({ name: '  CI  ' }))
      .toEqual({ name: 'CI' })
    expect(validateCreateAutomationInboundWebhookEndpointInput({ name: 'CI', purpose: 'automation' }))
      .toEqual({ name: 'CI' })
    expect(validateCreateAutomationInboundWebhookEndpointInput({ name: 'Support', purpose: 'triage', triageRouting: { teamId: 'support' } }))
      .toEqual({ name: 'Support', purpose: 'triage', triageRouting: { teamId: 'support' } })
    // Routing accepts the same 200-character Team IDs as the Triage identifier boundary.
    const longTeamId = 't'.repeat(200)
    expect(validateCreateAutomationInboundWebhookEndpointInput({ name: 'Support', purpose: 'triage', triageRouting: { teamId: longTeamId } }))
      .toEqual({ name: 'Support', purpose: 'triage', triageRouting: { teamId: longTeamId } })
    for (const invalid of [
      { name: 'Support', purpose: 'triage', triageRouting: { teamId: 't'.repeat(201) } },
      { name: 'Support', purpose: 'triage' },
      { name: 'Support', purpose: 'triage', triageRouting: { teamId: 'support', ownerUserId: 'x' } },
      { name: 'CI', triageRouting: { teamId: 'support' } },
      { name: 'CI', purpose: 'chat' },
    ]) {
      expect(() => validateCreateAutomationInboundWebhookEndpointInput(invalid)).toThrow()
    }
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

  test('normalizes a Project template WBS and the application start date', () => {
    expect(validateCreateAutomationTemplateInput({
      kind: 'project',
      name: 'Standard project',
      enabled: true,
      payload: {
        nameJa: '標準プロジェクト',
        workItems: [
          {
            title: ' 要件定義 ',
            startOffsetWorkingDays: 0,
            durationWorkingDays: 5,
            children: [{ title: 'ヒアリング', startOffsetWorkingDays: 0, durationWorkingDays: 2, children: [] }],
          },
          { title: '設計', startOffsetWorkingDays: 5, durationWorkingDays: 10 },
        ],
      },
    }).payload).toEqual({
      nameJa: '標準プロジェクト',
      tone: 'blue',
      workItems: [
        {
          title: '要件定義',
          startOffsetWorkingDays: 0,
          durationWorkingDays: 5,
          children: [{ title: 'ヒアリング', startOffsetWorkingDays: 0, durationWorkingDays: 2 }],
        },
        { title: '設計', startOffsetWorkingDays: 5, durationWorkingDays: 10 },
      ],
    })
    expect(validateCreateAutomationTemplateInput({
      kind: 'project',
      name: 'Empty WBS',
      enabled: true,
      payload: { name: 'Empty', workItems: [] },
    }).payload).toEqual({ name: 'Empty', tone: 'blue' })
    expect(validateApplyAutomationTemplateInput({
      target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-01' },
    })).toEqual({ target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-01' } })
  })

  test('rejects an invalid Project template WBS or start date', () => {
    const project = (workItems: unknown) => validateCreateAutomationTemplateInput({
      kind: 'project',
      name: 'Project',
      enabled: true,
      payload: { name: 'Project', workItems },
    })
    expect(() => project({})).toThrow('must be an array')
    expect(() => project([{ title: '', startOffsetWorkingDays: 0, durationWorkingDays: 1 }]))
      .toThrow('title is required')
    expect(() => project([{ title: 'A | 0 | 1\nB', startOffsetWorkingDays: 0, durationWorkingDays: 1 }]))
      .toThrow('must not contain line breaks')
    expect(() => project([{ title: 'A\u2028B', startOffsetWorkingDays: 0, durationWorkingDays: 1 }]))
      .toThrow('must not contain line breaks')
    expect(() => project([{ title: 'A', startOffsetWorkingDays: -1, durationWorkingDays: 1 }]))
      .toThrow('start offset')
    expect(() => project([{ title: 'A', startOffsetWorkingDays: 0, durationWorkingDays: 0 }]))
      .toThrow('duration')
    expect(() => project([{ title: 'A', startOffsetWorkingDays: 0, durationWorkingDays: 1, assigneeUserId: 'x' }]))
      .toThrow('unsupported fields')
    expect(() => project(Array.from({ length: AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT + 1 }, (_, index) => ({
      title: `Item ${index}`,
      startOffsetWorkingDays: 0,
      durationWorkingDays: 1,
    })))).toThrow(`at most ${AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT} Work Items`)
    let nested: AutomationProjectTemplateWorkItem = { title: 'Leaf', startOffsetWorkingDays: 0, durationWorkingDays: 1 }
    for (let level = 0; level < AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_DEPTH_LIMIT; level += 1) {
      nested = { title: `Level ${level}`, startOffsetWorkingDays: 0, durationWorkingDays: 1, children: [nested] }
    }
    expect(() => project([nested])).toThrow('levels deep')
    for (const startDate of ['2026-02-30', '2026/12/01', 20261201, '1969-12-31', '3000-01-01']) {
      expect(() => validateApplyAutomationTemplateInput({
        target: { kind: 'project', teamId: 'core-team', startDate },
      })).toThrow('start date')
    }
  })

  test('normalizes Project template Phases, Milestones, dependencies, and the Planning parent', () => {
    const workItems: AutomationProjectTemplateWorkItem[] = [
      {
        title: '要件定義',
        startOffsetWorkingDays: 0,
        durationWorkingDays: 5,
        children: [{ title: 'ヒアリング', startOffsetWorkingDays: 0, durationWorkingDays: 2 }],
      },
      { title: '設計', startOffsetWorkingDays: 5, durationWorkingDays: 3 },
    ]
    expect(validateCreateAutomationTemplateInput({
      kind: 'project',
      name: 'Planned',
      enabled: true,
      payload: {
        nameJa: '計画',
        workItems,
        dependencies: [{ predecessor: '1.1', successor: '2', type: 'start-to-start', lagDays: -1 }],
        phases: [{
          title: ' 準備 ',
          startOffsetWorkingDays: 0,
          durationWorkingDays: 5,
          milestones: [{ title: '要件確定', offsetWorkingDays: 4 }],
        }],
        milestones: [{ title: '設計完了', offsetWorkingDays: 7 }],
      },
    }).payload).toEqual({
      nameJa: '計画',
      tone: 'blue',
      workItems,
      dependencies: [{ predecessor: '1.1', successor: '2', type: 'start-to-start', lagDays: -1 }],
      phases: [{
        title: '準備',
        startOffsetWorkingDays: 0,
        durationWorkingDays: 5,
        milestones: [{ title: '要件確定', offsetWorkingDays: 4 }],
      }],
      milestones: [{ title: '設計完了', offsetWorkingDays: 7 }],
    })
    expect(listProjectTemplateWbsNumbers(workItems)).toEqual(['1', '1.1', '2'])
    expect(validateApplyAutomationTemplateInput({
      target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-07', planningParentId: 'roadmap-1' },
    })).toEqual({
      target: { kind: 'project', teamId: 'core-team', startDate: '2026-12-07', planningParentId: 'roadmap-1' },
    })
  })

  test('rejects invalid Project template dependencies and Planning entities', () => {
    const workItems: AutomationProjectTemplateWorkItem[] = [
      {
        title: '要件定義',
        startOffsetWorkingDays: 0,
        durationWorkingDays: 5,
        children: [{ title: 'ヒアリング', startOffsetWorkingDays: 0, durationWorkingDays: 2 }],
      },
      { title: '設計', startOffsetWorkingDays: 5, durationWorkingDays: 3 },
      { title: '実装', startOffsetWorkingDays: 8, durationWorkingDays: 3 },
    ]
    const create = (payload: Record<string, unknown>) => validateCreateAutomationTemplateInput({
      kind: 'project',
      name: 'Planned',
      enabled: true,
      payload: { nameJa: '計画', workItems, ...payload },
    })
    const dependency = (predecessor: string, successor: string, extra: Record<string, unknown> = {}) => ({
      predecessor,
      successor,
      type: 'finish-to-start',
      lagDays: 0,
      ...extra,
    })
    expect(() => create({ dependencies: [dependency('1', '9')] })).toThrow('WBS number 9')
    expect(() => create({ dependencies: [dependency('2', '2')] })).toThrow('to itself')
    expect(() => create({ dependencies: [dependency('1', '1.1')] })).toThrow('parent or child')
    expect(() => create({ dependencies: [dependency('1', '2'), dependency('2', '1')] })).toThrow('same Work Items')
    expect(() => create({
      dependencies: [dependency('1', '2'), dependency('2', '3'), dependency('3', '1')],
    })).toThrow('cycle')
    expect(() => create({ dependencies: [dependency('1', '2', { type: 'blocks' })] })).toThrow('type is invalid')
    expect(() => create({ dependencies: [dependency('1', '2', { lagDays: 366 })] })).toThrow('lag days')
    expect(() => create({
      dependencies: Array.from({ length: AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_LIMIT + 1 }, () => dependency('1', '2')),
    })).toThrow(`at most ${AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_LIMIT} dependencies`)
    expect(() => create({ phases: [{ title: '準備', startOffsetWorkingDays: 0, durationWorkingDays: 0 }] }))
      .toThrow('Phase duration')
    expect(() => create({ milestones: [{ title: '改行\nあり', offsetWorkingDays: 0 }] })).toThrow('line breaks')
    expect(() => create({ phases: [{ title: '◆ 準備', startOffsetWorkingDays: 0, durationWorkingDays: 1 }] }))
      .toThrow('must not start with')
    // 251 supplementary characters fit the character limit but not Planning's UTF-16 limit.
    expect(() => create({ milestones: [{ title: '𠮷'.repeat(251), offsetWorkingDays: 0 }] }))
      .toThrow('500 characters or fewer')
    expect(() => create({ milestones: [{ title: 'a\uD800b', offsetWorkingDays: 0 }] })).toThrow('well-formed')
    expect(() => create({
      milestones: Array.from(
        { length: AUTOMATION_PROJECT_TEMPLATE_PLANNING_ENTITY_LIMIT + 1 },
        (_, index) => ({ title: `M${index}`, offsetWorkingDays: 0 }),
      ),
    })).toThrow(`at most ${AUTOMATION_PROJECT_TEMPLATE_PLANNING_ENTITY_LIMIT} Phases and Milestones`)
    expect(() => validateApplyAutomationTemplateInput({
      target: { kind: 'project', teamId: 'core-team', planningParentId: '' },
    })).toThrow('Planning parent ID')
  })
})
