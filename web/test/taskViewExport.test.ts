import { describe, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import { readSpreadsheetWorkbook } from '../src/developer-platform/model/spreadsheet'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createTaskTableExportTable } from '../src/tasks/model/taskTableExport'
import { createTaskViewExportFile, escapeTaskViewCsvCell } from '../src/task-views/model/taskViewExport'

/**
 * Builds a Work Item shown in a view.
 *
 * @param overrides - Fields to replace.
 * @returns The Work Item.
 */
function workItem(overrides: Partial<CanonicalWorkItem>): CanonicalWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'item',
    teamId: 'team-a',
    title: 'Item',
    assigneeUserId: 'owner@example.com',
    assigneeName: 'Owner',
    creatorMemberKey: 'member-owner',
    customFieldValues: {},
    statusCategory: 'unstarted',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'todo',
    dueDate: '2026-08-03',
    schedule: createDefaultDueDateWorkItemSchedule('2026-08-03'),
    priority: 'high',
    relationIds: [],
    source: 'dynamodb',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  }
}

describe('view export', () => {
  const t = createTranslator('ja')

  test('writes the rows and columns the table shows, in its order', () => {
    const table = createTaskTableExportTable(
      [workItem({ id: 'b', title: 'Second' }), workItem({ id: 'a', title: '=SUM(A1)', assignedProjectId: 'refero' })],
      ['title', 'priority', 'project', 'actualStartDate'],
      {
        columnLabel: (field) => `col:${field}`,
        configurationFor: () => undefined,
        t,
        cellOverride: (field) => field === 'project' ? 'Overridden' : undefined,
      },
    )

    expect(table.columns).toEqual(['col:title', 'col:priority', 'col:project', 'col:actualStartDate'])
    expect(table.rows).toEqual([
      ['Second', t('tasks.priority.high'), 'Overridden', ''],
      ['=SUM(A1)', t('tasks.priority.high'), 'Overridden', ''],
    ])
  })

  test('writes a CSV that Excel reads as UTF-8 text and does not run formulas', async () => {
    const file = createTaskViewExportFile(
      { columns: ['名前', 'メモ'], rows: [['=SUM(A1)', 'a,"b"'], ['-1', '']] },
      'csv',
      'Project: A/B',
      new Date(2026, 10, 23),
    )

    expect(file.fileName).toBe('Project- A-B-20261123.csv')
    const bytes = new Uint8Array(await file.blob.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(bytes.slice(3))).toBe(
      "名前,メモ\r\n'=SUM(A1),\"a,\"\"b\"\"\"\r\n'-1,\r\n",
    )
    expect(escapeTaskViewCsvCell(' @cmd')).toBe("' @cmd")
  })

  test('writes an Excel workbook with the same table', async () => {
    const file = createTaskViewExportFile(
      { columns: ['Title', 'Status'], rows: [['Ship', 'Todo'], ['Verify', '']] },
      'xlsx',
      '',
      new Date(2026, 10, 23),
    )

    expect(file.fileName).toBe('work-items-20261123.xlsx')
    const sheets = await readSpreadsheetWorkbook(new Uint8Array(await file.blob.arrayBuffer()))
    expect(sheets[0]?.rows).toEqual([['Title', 'Status'], ['Ship', 'Todo'], ['Verify']])
  })
})
