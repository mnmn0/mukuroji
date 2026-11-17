import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_SCHEMA_VERSION,
  WORK_ITEM_TITLE_MAX_LENGTH,
  createDefaultDueDateWorkItemSchedule,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import {
  WorkItemTransferError,
  createWorkItemExport,
  previewWorkItemImport,
} from './work-item-transfer'

const mapping = [
  { sourceField: 'Name', targetField: 'title' },
  { sourceField: 'Owner', targetField: 'assigneeUserId' },
  { sourceField: 'Schedule', targetField: 'schedule' },
  { sourceField: 'Priority', targetField: 'priority' },
  { sourceField: 'Estimate', targetField: 'customFieldValues.estimate' },
] as const

const dueDateSchedule = createDefaultDueDateWorkItemSchedule('2026-08-01')
const dueDateScheduleCsv = `"${JSON.stringify(dueDateSchedule).replaceAll('"', '""')}"`

describe('Work Item import dry-run', () => {
  test('quoted CSV を mapping し、row-level error を返す', () => {
    const preview = previewWorkItemImport(
      'csv',
      `Name,Owner,Schedule,Priority,Estimate\r\n"Landing, page",sato@example.com,${dueDateScheduleCsv},high,3\r\nBroken,,${dueDateScheduleCsv},urgent,\r\n`,
      mapping,
    )

    expect(preview.totalRows).toBe(2)
    expect(preview.validRows).toBe(1)
    expect(preview.invalidRows).toBe(1)
    expect(preview.rows[0]?.input).toMatchObject({
      title: 'Landing, page',
      priority: 'high',
      customFieldValues: { estimate: 3 },
    })
    expect(preview.rows[1]?.errors.map((error) => error.code)).toEqual([
      'RequiredFieldMissing',
      'InvalidPriority',
    ])
  })

  test('JSON array と string array custom field を扱う', () => {
    const preview = previewWorkItemImport(
      'json',
      JSON.stringify([{
        name: 'API',
        owner: 'owner@example.com',
        schedule: createDefaultDueDateWorkItemSchedule('2026-08-03'),
        labels: ['api', 'p1'],
      }]),
      [
        { sourceField: 'name', targetField: 'title' },
        { sourceField: 'owner', targetField: 'assigneeUserId' },
        { sourceField: 'schedule', targetField: 'schedule' },
        { sourceField: 'labels', targetField: 'customFieldValues.labels' },
      ],
    )

    expect(preview.rows[0]?.input?.customFieldValues).toEqual({ labels: ['api', 'p1'] })
  })

  test('nested source、default、required、組み込み transform を dry-run に反映する', () => {
    const preview = previewWorkItemImport(
      'json',
      JSON.stringify([
        { task: { name: '  API Launch  ' }, owner: 'OWNER@EXAMPLE.COM', labels: 'api, p1' },
        { task: { name: 'Missing owner' }, owner: '' },
      ]),
      [
        { sourceField: 'task.name', targetField: 'title', transform: 'trim' },
        {
          sourceField: 'owner',
          targetField: 'assigneeUserId',
          transform: 'lowercase',
          required: true,
        },
        {
          sourceField: 'schedule',
          targetField: 'schedule',
          defaultValue: createDefaultDueDateWorkItemSchedule('2026-08-31'),
        },
        {
          sourceField: 'labels',
          targetField: 'customFieldValues.labels',
          transform: 'split-comma',
        },
      ],
    )

    expect(preview.rows[0]?.input).toMatchObject({
      title: 'API Launch',
      assigneeUserId: 'owner@example.com',
      schedule: { dueDate: '2026-08-31', mode: 'due-date' },
      customFieldValues: { labels: ['api', 'p1'] },
    })
    expect(preview.rows[1]?.errors).toContainEqual(expect.objectContaining({
      field: 'assigneeUserId',
      code: 'RequiredFieldMissing',
    }))
    expect(preview.rows[1]?.errors).toHaveLength(1)
  })

  test('変換できない値を row-level error として返す', () => {
    const preview = previewWorkItemImport(
      'json',
      JSON.stringify([{ name: 'Task', owner: 'owner@example.com', schedule: { mode: 'due-date' } }]),
      [
        { sourceField: 'name', targetField: 'title' },
        { sourceField: 'owner', targetField: 'assigneeUserId' },
        { sourceField: 'schedule', targetField: 'schedule' },
      ],
    )

    expect(preview.invalidRows).toBe(1)
    expect(preview.errors.map((error) => error.code)).toContain('InvalidSchedule')
    expect(preview.errors).toHaveLength(1)
  })

  test('Work Item title の上限を超える row を dry-run で拒否する', () => {
    const rows = [WORK_ITEM_TITLE_MAX_LENGTH, WORK_ITEM_TITLE_MAX_LENGTH + 1].map((length) => ({
      name: '🙂'.repeat(length),
      owner: 'owner@example.com',
      schedule: dueDateSchedule,
    }))
    const preview = previewWorkItemImport('json', JSON.stringify(rows), [
      { sourceField: 'name', targetField: 'title' },
      { sourceField: 'owner', targetField: 'assigneeUserId' },
      { sourceField: 'schedule', targetField: 'schedule' },
    ])

    expect(preview.validRows).toBe(1)
    expect(preview.invalidRows).toBe(1)
    expect(preview.errors).toEqual([expect.objectContaining({ row: 2, field: 'title', code: 'WorkItemTitleTooLong' })])
  })

  test('必須 mapping の欠落を stable error にする', () => {
    expect(() => previewWorkItemImport('csv', 'Name\nTask\n', [
      { sourceField: 'Name', targetField: 'title' },
    ])).toThrow(WorkItemTransferError)
    try {
      previewWorkItemImport('csv', 'Name\nTask\n', [
        { sourceField: 'Name', targetField: 'title' },
      ])
    } catch (error) {
      expect(error).toMatchObject({ code: 'MissingImportMapping', status: 400 })
    }
  })
})

describe('Work Item export', () => {
  const workItem = {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 2,
    id: 'api-key-ui',
    teamId: 'core',
    title: '=HYPERLINK("https://example.com")',
    assigneeUserId: 'owner@example.com',
    creatorMemberKey: 'owner@example.com',
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    workflowSchemaVersion: 1,
    customFieldValues: { labels: ['api', 'security'] },
    relationIds: [],
    dueDate: '2026-08-01',
    schedule: createDefaultDueDateWorkItemSchedule('2026-08-01'),
    priority: 'high',
    priorityUpdatedAt: '2026-07-18T00:30:00.000Z',
    dueDateUpdatedAt: '2026-07-18T00:45:00.000Z',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T01:00:00.000Z',
    source: 'dynamodb',
  } satisfies CanonicalWorkItem

  test('CSV formula injection を neutralize し custom fields を出力する', () => {
    const result = createWorkItemExport('csv', [workItem], new Date('2026-07-18T02:00:00.000Z'))
    expect(result.contentType).toContain('text/csv')
    expect(result.fileName).toBe('mukuroji-work-items-2026-07-18.csv')
    expect(result.body).toContain('customFieldValues.labels')
    expect(result.body).toContain('schedule')
    expect(result.body).toContain('due-date')
    expect(result.body).toContain('priorityUpdatedAt')
    expect(result.body).toContain('2026-07-18T00:30:00.000Z')
    expect(result.body).toContain('dueDateUpdatedAt')
    expect(result.body).toContain('2026-07-18T00:45:00.000Z')
    expect(result.body).toContain("'=HYPERLINK")
  })

  test('JSON envelope に version と Work Items を含める', () => {
    const result = createWorkItemExport('json', [workItem])
    const exported = JSON.parse(result.body)
    expect(exported).toMatchObject({
      apiVersion: '2026-07-01',
      workItems: [{
        id: 'api-key-ui',
        schedule: workItem.schedule,
        priorityUpdatedAt: workItem.priorityUpdatedAt,
        dueDateUpdatedAt: workItem.dueDateUpdatedAt,
      }],
    })
    expect(exported.workItems[0]).not.toHaveProperty('creatorMemberKey')
    expect(exported.workItems[0]).not.toHaveProperty('source')
    expect(exported.workItems[0]).not.toHaveProperty('schemaVersion')
  })

  test('CSV と JSON に実績開始日・実績終了日を出し、未記録なら空にする', () => {
    const completed = { ...workItem, actualStartDate: '2026-07-20', actualEndDate: '2026-08-03' }
    const csv = createWorkItemExport('csv', [completed, workItem]).body.split('\r\n')
    expect(csv[0]).toContain(',dueDateUpdatedAt,actualStartDate,actualEndDate,revision,')
    expect(csv[1]).toContain(',2026-07-18T00:45:00.000Z,2026-07-20,2026-08-03,2,')
    expect(csv[2]).toContain(',2026-07-18T00:45:00.000Z,,,2,')

    const exported = JSON.parse(createWorkItemExport('json', [completed, workItem]).body)
    expect(exported.workItems[0]).toMatchObject({ actualStartDate: '2026-07-20', actualEndDate: '2026-08-03' })
    expect(exported.workItems[1]).not.toHaveProperty('actualStartDate')
  })
})
