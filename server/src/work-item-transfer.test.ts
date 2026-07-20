import { describe, expect, test } from 'bun:test'
import type { WorkItem } from '@mukuroji/contracts'
import {
  WorkItemTransferError,
  createWorkItemExport,
  previewWorkItemImport,
} from './work-item-transfer'

const mapping = [
  { sourceField: 'Name', targetField: 'title' },
  { sourceField: 'Owner', targetField: 'assigneeUserId' },
  { sourceField: 'Due', targetField: 'dueDate' },
  { sourceField: 'Priority', targetField: 'priority' },
  { sourceField: 'Estimate', targetField: 'customFieldValues.estimate' },
] as const

describe('Work Item import dry-run', () => {
  test('quoted CSV を mapping し、row-level error を返す', () => {
    const preview = previewWorkItemImport(
      'csv',
      'Name,Owner,Due,Priority,Estimate\r\n"Landing, page",sato@example.com,2026-08-01,high,3\r\nBroken,,2026-08-02,urgent,\r\n',
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
      JSON.stringify([{ name: 'API', owner: 'owner@example.com', due: '2026-08-03', labels: ['api', 'p1'] }]),
      [
        { sourceField: 'name', targetField: 'title' },
        { sourceField: 'owner', targetField: 'assigneeUserId' },
        { sourceField: 'due', targetField: 'dueDate' },
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
        { sourceField: 'due', targetField: 'dueDate', defaultValue: '2026-08-31' },
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
      dueDate: '2026-08-31',
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
      JSON.stringify([{ name: 'Task', owner: 'owner@example.com', due: 'not-a-date' }]),
      [
        { sourceField: 'name', targetField: 'title' },
        { sourceField: 'owner', targetField: 'assigneeUserId' },
        { sourceField: 'due', targetField: 'dueDate', transform: 'parse-date' },
      ],
    )

    expect(preview.invalidRows).toBe(1)
    expect(preview.errors.map((error) => error.code)).toContain('InvalidFieldTransform')
    expect(preview.errors).toHaveLength(1)
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
    schemaVersion: 1,
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
    priority: 'high',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T01:00:00.000Z',
    source: 'dynamodb',
  } satisfies WorkItem

  test('CSV formula injection を neutralize し custom fields を出力する', () => {
    const result = createWorkItemExport('csv', [workItem], new Date('2026-07-18T02:00:00.000Z'))
    expect(result.contentType).toContain('text/csv')
    expect(result.fileName).toBe('mukuroji-work-items-2026-07-18.csv')
    expect(result.body).toContain('customFieldValues.labels')
    expect(result.body).toContain("'=HYPERLINK")
  })

  test('JSON envelope に version と Work Items を含める', () => {
    const result = createWorkItemExport('json', [workItem])
    const exported = JSON.parse(result.body)
    expect(exported).toMatchObject({
      apiVersion: '2026-07-01',
      workItems: [{ id: 'api-key-ui' }],
    })
    expect(exported.workItems[0]).not.toHaveProperty('creatorMemberKey')
    expect(exported.workItems[0]).not.toHaveProperty('source')
    expect(exported.workItems[0]).not.toHaveProperty('schemaVersion')
  })
})
