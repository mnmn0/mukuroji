import { describe, expect, test } from 'bun:test'
import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
import { previewWorkItemImport } from './work-item-transfer'

const baseMapping = [
  { sourceField: 'Name', targetField: 'title' },
  { sourceField: 'Owner', targetField: 'assigneeUserId' },
  { sourceField: 'Schedule', targetField: 'schedule' },
]

const schedule = createDefaultDueDateWorkItemSchedule('2026-08-01')

/**
 * Builds JSON import rows with the base fields filled in.
 *
 * @param rows - Extra fields of each row.
 * @returns JSON source text.
 */
function source(rows: Array<Record<string, unknown>>) {
  return JSON.stringify(rows.map((row, index) => ({
    Name: `Task ${index + 1}`,
    Owner: 'owner@example.com',
    Schedule: schedule,
    ...row,
  })))
}

describe('Work Item import structure', () => {
  test('derives parents from WBS numbers in source order', () => {
    const preview = previewWorkItemImport('json', source([
      { WBS: '1' },
      { WBS: '1.1' },
      { WBS: '1.2' },
      { WBS: '1.2.1' },
      { WBS: '2' },
    ]), [...baseMapping, { sourceField: 'WBS', targetField: 'wbsNumber' }])

    expect(preview.invalidRows).toBe(0)
    expect(preview.links).toEqual([
      { kind: 'parent', childRow: 2, parentRow: 1 },
      { kind: 'parent', childRow: 3, parentRow: 1 },
      { kind: 'parent', childRow: 4, parentRow: 3 },
    ])
  })

  test('derives parents from outline levels and rejects a skipped level', () => {
    const preview = previewWorkItemImport('json', source([
      { Level: 1 },
      { Level: 2 },
      { Level: 3 },
      { Level: 2 },
      { Level: 1 },
      { Level: 3 },
    ]), [...baseMapping, { sourceField: 'Level', targetField: 'outlineLevel' }])

    expect(preview.links).toEqual([
      { kind: 'parent', childRow: 2, parentRow: 1 },
      { kind: 'parent', childRow: 3, parentRow: 2 },
      { kind: 'parent', childRow: 4, parentRow: 1 },
    ])
    expect(preview.errors).toEqual([expect.objectContaining({ row: 6, code: 'ImportOutlineLevelInvalid' })])
  })

  test('resolves parent keys by import key and reports unknown, duplicate, and cyclic keys', () => {
    const preview = previewWorkItemImport('json', source([
      { Key: 'a', Parent: 'c' },
      { Key: 'b', Parent: 'a' },
      { Key: 'c', Parent: 'b' },
      { Key: 'd', Parent: 'missing' },
      { Key: 'd' },
      { Key: 'e', Parent: 'e' },
    ]), [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Parent', targetField: 'parentKey' },
    ])

    expect(preview.links).toEqual([])
    expect(preview.errors.map((error) => [error.row, error.code])).toEqual([
      [1, 'ImportHierarchyCycle'],
      [2, 'ImportHierarchyCycle'],
      [3, 'ImportHierarchyCycle'],
      [4, 'ImportReferenceInvalid'],
      [5, 'ImportKeyDuplicate'],
      [6, 'ImportReferenceInvalid'],
    ])
  })

  test('reads dependencies with type and lag and rejects dependency cycles', () => {
    const preview = previewWorkItemImport('json', source([
      { WBS: '1' },
      { WBS: '2', Predecessors: '1FS+2d, 1' },
      { WBS: '3', Predecessors: '2SS-1; 4' },
      { WBS: '4', Predecessors: [{ key: '3', type: 'finish-to-finish', lagDays: 0 }] },
    ]), [
      ...baseMapping,
      { sourceField: 'WBS', targetField: 'wbsNumber' },
      { sourceField: 'Predecessors', targetField: 'dependencies' },
    ])

    expect(preview.links.filter((link) => link.kind === 'dependency')).toEqual([
      { kind: 'dependency', predecessorRow: 1, successorRow: 2, type: 'finish-to-start', lagDays: 2 },
      { kind: 'dependency', predecessorRow: 2, successorRow: 3, type: 'start-to-start', lagDays: -1 },
      { kind: 'dependency', predecessorRow: 4, successorRow: 3, type: 'finish-to-start', lagDays: 0 },
      { kind: 'dependency', predecessorRow: 3, successorRow: 4, type: 'finish-to-finish', lagDays: 0 },
    ])
    expect(preview.errors.map((error) => [error.row, error.code])).toEqual([
      [2, 'ImportDependencyDuplicate'],
      [3, 'ImportDependencyCycle'],
      [4, 'ImportDependencyCycle'],
    ])
  })

  test('reads relations, contributors, and acceptance criteria', () => {
    const preview = previewWorkItemImport('json', source([
      {
        Key: 'a',
        Relations: 'blocks:b; related:b',
        Contributors: 'member:dev@example.com effort:2h; role:designer status:in-progress',
        Criteria: '[x] Spec reviewed\n[ ] Tests pass\n- Released',
      },
      { Key: 'b', Relations: 'blockedBy:a, related:a' },
    ]), [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Relations', targetField: 'relations' },
      { sourceField: 'Contributors', targetField: 'contributors' },
      { sourceField: 'Criteria', targetField: 'acceptanceCriteria' },
    ])

    expect(preview.errors).toEqual([])
    expect(preview.rows[0]?.input?.contributorAssignments).toEqual([
      { memberUserId: 'dev@example.com', plannedEffortMinutes: 120 },
      { jobRoleId: 'designer', status: 'in-progress' },
    ])
    expect(preview.links).toEqual([
      { kind: 'relation', sourceRow: 1, targetRow: 2, type: 'blocks' },
      { kind: 'relation', sourceRow: 1, targetRow: 2, type: 'related' },
      {
        kind: 'acceptance-criteria',
        row: 1,
        criteria: [
          { text: 'Spec reviewed', satisfied: true },
          { text: 'Tests pass', satisfied: false },
          { text: 'Released', satisfied: false },
        ],
      },
    ])
  })

  test('reports invalid structure cells on their rows', () => {
    const preview = previewWorkItemImport('json', source([
      { Key: 'a', Level: 0, Relations: 'parent:b', Contributors: 'team:x', Predecessors: { key: 'b' } },
    ]), [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Level', targetField: 'outlineLevel' },
      { sourceField: 'Relations', targetField: 'relations' },
      { sourceField: 'Contributors', targetField: 'contributors' },
      { sourceField: 'Predecessors', targetField: 'dependencies' },
    ])

    expect(preview.errors.map((error) => error.code).sort()).toEqual([
      'ImportContributorsInvalid',
      'ImportDependenciesInvalid',
      'ImportOutlineLevelInvalid',
      'ImportRelationsInvalid',
    ])
    expect(preview.rows[0]?.input).toBeUndefined()
  })

  test('keeps imports without structure mapping unchanged', () => {
    const preview = previewWorkItemImport('json', source([{}, {}]), baseMapping)

    expect(preview.links).toEqual([])
    expect(preview.rows.every((row) => row.structure === undefined)).toBe(true)
  })
})
