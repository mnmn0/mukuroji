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

  test('keeps the outline when some rows take their parent from a WBS number', () => {
    const preview = previewWorkItemImport('json', source([
      { WBS: '1', Level: 1 },
      { WBS: '1.1', Level: 2 },
      { Level: 3 },
    ]), [
      ...baseMapping,
      { sourceField: 'WBS', targetField: 'wbsNumber' },
      { sourceField: 'Level', targetField: 'outlineLevel' },
    ])

    expect(preview.errors).toEqual([])
    expect(preview.links).toEqual([
      { kind: 'parent', childRow: 2, parentRow: 1 },
      { kind: 'parent', childRow: 3, parentRow: 2 },
    ])
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
      { WBS: '2', Predecessors: '1FS+2d, 1 ff' },
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

  test('keeps the date constraint of a JSON dependency and rejects an invalid one', () => {
    const preview = previewWorkItemImport('json', source([
      { WBS: '1' },
      { WBS: '2', Predecessors: [{ key: '1', type: 'FS', lagDays: 0, constraint: { anchor: 'finish', kind: 'not-after', date: '2026-12-01' } }] },
      { WBS: '3', Predecessors: [{ key: '1', constraint: { anchor: 'finish', kind: 'before', date: '2026-12-01' } }] },
    ]), [
      ...baseMapping,
      { sourceField: 'WBS', targetField: 'wbsNumber' },
      { sourceField: 'Predecessors', targetField: 'dependencies' },
    ])

    expect(preview.links.filter((link) => link.kind === 'dependency')).toEqual([{
      kind: 'dependency',
      predecessorRow: 1,
      successorRow: 2,
      type: 'finish-to-start',
      lagDays: 0,
      constraint: { anchor: 'finish', kind: 'not-after', date: '2026-12-01' },
    }])
    expect(preview.errors.map((error) => [error.row, error.code])).toEqual([[3, 'ImportDependenciesInvalid']])
  })

  test('reads a spaced dependency whose key ends like a type or lag', () => {
    const preview = previewWorkItemImport('json', source([
      { Key: 'task-ff' },
      { Key: 'task-12' },
      { Key: 'c', Predecessors: 'task-ff SS +3; task-12' },
    ]), [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Predecessors', targetField: 'dependencies' },
    ])

    expect(preview.errors).toEqual([])
    expect(preview.links).toEqual([
      { kind: 'dependency', predecessorRow: 1, successorRow: 3, type: 'start-to-start', lagDays: 3 },
      { kind: 'dependency', predecessorRow: 2, successorRow: 3, type: 'finish-to-start', lagDays: 0 },
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

  test('reads a member name with spaces and rejects a second member in one entry', () => {
    const mapping = [
      ...baseMapping,
      { sourceField: 'Contributors', targetField: 'contributors' },
    ]
    const named = previewWorkItemImport('json', source([
      { Contributors: 'member:Yamada Hanako effort:2h; Sato Ken role:designer' },
    ]), mapping)
    expect(named.errors).toEqual([])
    expect(named.rows[0]?.input?.contributorAssignments).toEqual([
      { memberUserId: 'Yamada Hanako', plannedEffortMinutes: 120 },
      { memberUserId: 'Sato Ken', jobRoleId: 'designer' },
    ])

    const twoMembers = previewWorkItemImport('json', source([
      { Contributors: 'member:a@example.com effort:2h member:b@example.com' },
    ]), mapping)
    expect(twoMembers.errors.map((error) => [error.row, error.code])).toEqual([[1, 'ImportContributorsInvalid']])
  })

  test('keeps a leading minus sign in an acceptance criterion', () => {
    const preview = previewWorkItemImport('json', source([
      { Criteria: '-5 °C でも起動する\n- [x] Released\n* Logged' },
    ]), [
      ...baseMapping,
      { sourceField: 'Criteria', targetField: 'acceptanceCriteria' },
    ])

    expect(preview.links).toEqual([{
      kind: 'acceptance-criteria',
      row: 1,
      criteria: [
        { text: '-5 °C でも起動する', satisfied: false },
        { text: 'Released', satisfied: true },
        { text: 'Logged', satisfied: false },
      ],
    }])
  })

  test('reports only the rows on a dependency cycle, not rows between cycles', () => {
    const preview = previewWorkItemImport('json', source([
      { Key: 'a', Predecessors: 'b' },
      { Key: 'b', Predecessors: 'a' },
      { Key: 'bridge', Predecessors: 'b' },
      { Key: 'c', Predecessors: 'bridge; d' },
      { Key: 'd', Predecessors: 'c' },
      { Key: 'after', Predecessors: 'd' },
    ]), [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Predecessors', targetField: 'dependencies' },
    ])

    expect(preview.errors.map((error) => [error.row, error.code])).toEqual([
      [1, 'ImportDependencyCycle'],
      [2, 'ImportDependencyCycle'],
      [4, 'ImportDependencyCycle'],
      [5, 'ImportDependencyCycle'],
    ])
  })

  test('lists the allowed relation types for an invalid one', () => {
    const preview = previewWorkItemImport('json', source([
      { Key: 'a', Relations: [{ type: { nested: true }, key: 'b' }] },
      { Key: 'b' },
    ]), [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Relations', targetField: 'relations' },
    ])

    expect(preview.errors).toEqual([{
      row: 1,
      field: 'relations',
      code: 'ImportRelationsInvalid',
      message: 'Each relation type must be one of blocks, blockedBy, related, or duplicate.',
    }])
  })

  test('rejects blocking relations that form a cycle', () => {
    const preview = previewWorkItemImport('json', source([
      { Key: 'a', Relations: 'blocks:b; related:c' },
      { Key: 'b', Relations: 'blocks:a' },
      { Key: 'c', Relations: 'blockedBy:a' },
    ]), [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Relations', targetField: 'relations' },
    ])

    // Creating these after every row exists would stop at the relation that closes the cycle.
    expect(preview.errors.map((error) => [error.row, error.field, error.code])).toEqual([
      [1, 'relations', 'ImportRelationCycle'],
      [2, 'relations', 'ImportRelationCycle'],
    ])
  })

  test('rejects an import whose links alone exceed what a Team can store', () => {
    // Each of 201 rows relates to the next 50, so every row holds 100 relations but the import
    // adds 10,050 links, more than the 10,000 a Team stores.
    const rows = Array.from({ length: 201 }, (_, index) => ({
      Key: `r${index}`,
      Relations: Array.from({ length: 50 }, (_, offset) => ({ type: 'related', key: `r${(index + offset + 1) % 201}` })),
    }))
    const preview = previewWorkItemImport('json', source(rows), [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Relations', targetField: 'relations' },
    ])

    expect(preview.errors.map((error) => [error.field, error.code])).toEqual([['relations', 'ImportRelationLimitExceeded']])
  })

  test('accepts a row with more predecessors than relations a row may declare', () => {
    // Planning stores any number of predecessors, so an export of such a graph re-imports.
    const preview = previewWorkItemImport('json', source([
      ...Array.from({ length: 120 }, (_, index) => ({ Key: `p${index}` })),
      { Key: 'last', Predecessors: Array.from({ length: 120 }, (_, index) => ({ key: `p${index}` })) },
    ]), [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Predecessors', targetField: 'dependencies' },
    ])

    expect(preview.errors).toEqual([])
    expect(preview.links.filter((link) => link.kind === 'dependency')).toHaveLength(120)
  })

  test('accepts as many declared relations as a Work Item can hold', () => {
    /**
     * Builds a hub row that declares relations to its spokes, and the spoke rows.
     *
     * @param count - Relations the hub declares itself; no other row adds one to it.
     * @returns JSON rows.
     */
    const declare = (count: number) => [
      { Key: 'hub', Relations: Array.from({ length: count }, (_, index) => ({ type: 'related', key: `spoke-${index}` })) },
      ...Array.from({ length: count }, (_, index) => ({ Key: `spoke-${index}` })),
    ]
    const mapping = [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Relations', targetField: 'relations' },
    ]

    // An export writes every stored relation of a Work Item on its row, up to the stored limit.
    expect(previewWorkItemImport('json', source(declare(100)), mapping).errors).toEqual([])
    expect(previewWorkItemImport('json', source(declare(101)), mapping).errors
      .map((error) => [error.row, error.field])).toEqual([[1, 'relations']])
  })

  test('rejects a row that other rows would give more relations than a Work Item can hold', () => {
    /**
     * Builds spoke rows that each declare a relation to the hub.
     *
     * @param count - Relations the other rows add to the hub; the hub declares none itself.
     * @returns JSON rows.
     */
    const relatedRows = (count: number) => Array.from({ length: count }, (_, index) => ({
      Key: `spoke-${index}`,
      Relations: 'related:hub',
    }))
    const mapping = [
      ...baseMapping,
      { sourceField: 'Key', targetField: 'importKey' },
      { sourceField: 'Relations', targetField: 'relations' },
    ]

    // The reciprocal entries are written on the hub, so 100 fit and 101 would fail after every row exists.
    expect(previewWorkItemImport('json', source([{ Key: 'hub' }, ...relatedRows(100)]), mapping).errors).toEqual([])
    expect(previewWorkItemImport('json', source([{ Key: 'hub' }, ...relatedRows(101)]), mapping).errors
      .map((error) => [error.row, error.field, error.code])).toEqual([[1, 'relations', 'ImportRelationLimitExceeded']])
  })

  test('limits acceptance criterion text by its UTF-16 length, as stored criteria are checked', () => {
    const preview = previewWorkItemImport('json', source([
      { Criteria: [{ text: '😀'.repeat(512) }] },
      { Criteria: [{ text: '😀'.repeat(513) }] },
    ]), [
      ...baseMapping,
      { sourceField: 'Criteria', targetField: 'acceptanceCriteria' },
    ])

    expect(preview.errors.map((error) => [error.row, error.field])).toEqual([[2, 'acceptanceCriteria']])
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
