import { describe, expect, test } from 'bun:test'
import type { TeamWorkItemHierarchyNode } from '@mukuroji/contracts'
import { parseTeamWorkItemHierarchyResponse } from '../src/work-items/api/hierarchy'
import {
  createWorkItemOutlineRows,
  planWorkItemHierarchyMove,
  readWorkItemHierarchyMoveShortcut,
} from '../src/work-items/model/workItemHierarchy'

/**
 * Builds one hierarchy node.
 *
 * @param workItemId - Work Item ID.
 * @param parentWorkItemId - Parent ID, or `null` at the top level.
 * @param hierarchyRank - Sibling rank.
 * @param childWorkItemIds - Children in sibling order.
 * @param extra - Other fields to set.
 * @returns The node.
 */
function node(
  workItemId: string,
  parentWorkItemId: string | null,
  hierarchyRank: string,
  childWorkItemIds: string[] = [],
  extra: Partial<TeamWorkItemHierarchyNode> = {},
): TeamWorkItemHierarchyNode {
  return {
    workItemId,
    parentWorkItemId,
    depth: 0,
    wbsNumber: '1',
    hierarchyRank,
    childWorkItemIds,
    ...extra,
  }
}

// 1 phase-1 (b)
//   1.1 task-1 (b)
//   1.2 task-2 (d)
//   1.3 task-3 (f)
// 2 phase-2 (d)
// 3 phase-3 (f)
const nodes = [
  node('phase-1', null, 'b', ['task-1', 'task-2', 'task-3']),
  node('task-1', 'phase-1', 'b', [], { depth: 1 }),
  node('task-2', 'phase-1', 'd', [], { depth: 1 }),
  node('task-3', 'phase-1', 'f', [], { depth: 1 }),
  node('phase-2', null, 'd'),
  node('phase-3', null, 'f'),
]

describe('planWorkItemHierarchyMove', () => {
  test('indents under the previous sibling after its last child', () => {
    const plan = planWorkItemHierarchyMove(nodes, 'phase-2', 'indent')
    expect(plan).toMatchObject({ ok: true, parentWorkItemId: 'phase-1' })
    if (!plan.ok) throw new Error('Expected a plan.')
    expect(plan.hierarchyRank > 'f').toBe(true)
  })

  test('outdents right after the parent under the grandparent', () => {
    const plan = planWorkItemHierarchyMove(nodes, 'task-2', 'outdent')
    expect(plan).toMatchObject({ ok: true, parentWorkItemId: null })
    if (!plan.ok) throw new Error('Expected a plan.')
    expect(plan.hierarchyRank > 'b' && plan.hierarchyRank < 'd').toBe(true)
  })

  test('moves up and down among siblings', () => {
    const up = planWorkItemHierarchyMove(nodes, 'task-3', 'up')
    const down = planWorkItemHierarchyMove(nodes, 'task-1', 'down')
    if (!up.ok || !down.ok) throw new Error('Expected plans.')
    expect(up.parentWorkItemId).toBe('phase-1')
    expect(up.hierarchyRank > 'b' && up.hierarchyRank < 'd').toBe(true)
    expect(down.hierarchyRank > 'd' && down.hierarchyRank < 'f').toBe(true)
    const first = planWorkItemHierarchyMove(nodes, 'phase-2', 'up')
    if (!first.ok) throw new Error('Expected a plan.')
    expect(first.hierarchyRank < 'b').toBe(true)
  })

  test('explains why a move cannot be made', () => {
    expect(planWorkItemHierarchyMove(nodes, 'phase-1', 'indent')).toEqual({ ok: false, reason: 'no-previous-sibling' })
    expect(planWorkItemHierarchyMove(nodes, 'phase-3', 'down')).toEqual({ ok: false, reason: 'no-next-sibling' })
    expect(planWorkItemHierarchyMove(nodes, 'phase-1', 'outdent')).toEqual({ ok: false, reason: 'top-level' })
    expect(planWorkItemHierarchyMove(nodes, 'missing', 'up')).toEqual({ ok: false, reason: 'not-in-hierarchy' })
    const hidden = [...nodes, node('orphan', null, 'b', [], { parentHidden: true })]
    expect(planWorkItemHierarchyMove(hidden, 'orphan', 'outdent')).toEqual({ ok: false, reason: 'parent-hidden' })
  })

  test('does not treat a Work Item under a hidden parent as a top-level sibling', () => {
    const hidden = [
      node('phase-1', null, 'b'),
      node('orphan', null, 'c', [], { parentHidden: true }),
      node('phase-2', null, 'd'),
    ]
    const plan = planWorkItemHierarchyMove(hidden, 'phase-2', 'indent')
    expect(plan).toMatchObject({ ok: true, parentWorkItemId: 'phase-1' })
  })
})

describe('createWorkItemOutlineRows', () => {
  const items = ['task-3', 'phase-3', 'phase-1', 'task-1', 'new-item', 'task-2', 'phase-2'].map((id) => ({ id }))

  test('orders shown Work Items as an outline and appends ones outside the hierarchy', () => {
    const rows = createWorkItemOutlineRows(items, nodes, new Set())
    expect(rows.map((row) => [row.item.id, row.depth, row.hasChildren])).toEqual([
      ['phase-1', 0, true],
      ['task-1', 1, false],
      ['task-2', 1, false],
      ['task-3', 1, false],
      ['phase-2', 0, false],
      ['phase-3', 0, false],
      ['new-item', 0, false],
    ])
  })

  test('hides rows under a collapsed parent', () => {
    const rows = createWorkItemOutlineRows(items, nodes, new Set(['phase-1', 'phase-2']))
    expect(rows.map((row) => row.item.id)).toEqual(['phase-1', 'phase-2', 'phase-3', 'new-item'])
    expect(rows[0]?.collapsed).toBe(true)
    // A Work Item without shown children is never reported as collapsed.
    expect(rows[1]?.collapsed).toBe(false)
  })

  test('nests a Work Item under its nearest shown ancestor when a filter hides its parent', () => {
    const deep = [
      node('root', null, 'b', ['middle']),
      node('middle', 'root', 'b', ['leaf'], { depth: 1 }),
      node('leaf', 'middle', 'b', [], { depth: 2 }),
    ]
    const rows = createWorkItemOutlineRows([{ id: 'root' }, { id: 'leaf' }], deep, new Set())
    expect(rows.map((row) => [row.item.id, row.depth])).toEqual([['root', 0], ['leaf', 1]])
  })

  test('keeps a Work Item under an unreadable parent inside its readable ancestor', () => {
    // root > (unreadable) > hidden-child, and root > sibling: the server omits the unreadable node.
    const withHidden = [
      node('root', null, 'b', ['sibling']),
      node('hidden-child', null, 'b', [], { depth: 1, parentHidden: true }),
      node('sibling', 'root', 'd', [], { depth: 1 }),
    ]
    const items = [{ id: 'root' }, { id: 'hidden-child' }, { id: 'sibling' }]
    expect(createWorkItemOutlineRows(items, withHidden, new Set())
      .map((row) => [row.item.id, row.depth, row.hasChildren])).toEqual([
      ['root', 0, true],
      ['hidden-child', 1, false],
      ['sibling', 1, false],
    ])
    // Collapsing the root hides both; nothing else hides the sibling.
    expect(createWorkItemOutlineRows(items, withHidden, new Set(['hidden-child']))
      .map((row) => row.item.id)).toEqual(['root', 'hidden-child', 'sibling'])
    expect(createWorkItemOutlineRows(items, withHidden, new Set(['root']))
      .map((row) => row.item.id)).toEqual(['root'])
  })
})

test('reads hierarchy move shortcuts only with Alt+Shift and an arrow key', () => {
  const keys = { altKey: true, shiftKey: true, ctrlKey: false, metaKey: false }
  expect(readWorkItemHierarchyMoveShortcut({ ...keys, key: 'ArrowRight' })).toBe('indent')
  expect(readWorkItemHierarchyMoveShortcut({ ...keys, key: 'ArrowLeft' })).toBe('outdent')
  expect(readWorkItemHierarchyMoveShortcut({ ...keys, key: 'ArrowUp' })).toBe('up')
  expect(readWorkItemHierarchyMoveShortcut({ ...keys, key: 'ArrowDown' })).toBe('down')
  expect(readWorkItemHierarchyMoveShortcut({ ...keys, key: 'j' })).toBeUndefined()
  expect(readWorkItemHierarchyMoveShortcut({ ...keys, ctrlKey: true, key: 'ArrowUp' })).toBeUndefined()
  expect(readWorkItemHierarchyMoveShortcut({ ...keys, shiftKey: false, key: 'ArrowUp' })).toBeUndefined()
})

describe('parseTeamWorkItemHierarchyResponse', () => {
  const valid = {
    schemaVersion: 1,
    teamId: 'core-team',
    graphRevision: 4,
    nodes: [{
      workItemId: 'phase-1',
      parentWorkItemId: null,
      depth: 0,
      wbsNumber: '1',
      hierarchyRank: 'b',
      childWorkItemIds: ['task-1'],
      rollup: {
        childCount: 1,
        descendantCount: 1,
        statusCategoryCounts: { backlog: 0, unstarted: 0, started: 1, completed: 0, canceled: 0 },
        openDescendantCount: 1,
        plannedEffortMinutes: 60,
        estimatedDescendantCount: 1,
        remainingEffortMinutes: 60,
        startDate: '2026-12-01',
        endDate: '2026-12-10',
      },
    }, {
      workItemId: 'task-1',
      parentWorkItemId: 'phase-1',
      depth: 1,
      wbsNumber: '1.1',
      hierarchyRank: 'b',
      childWorkItemIds: [],
    }],
  }

  test('accepts a well-formed hierarchy', () => {
    expect(parseTeamWorkItemHierarchyResponse(valid)).toEqual(valid)
  })

  test('rejects malformed nodes', () => {
    const withNode = (patch: Record<string, unknown>) => ({
      ...valid,
      nodes: [{ ...valid.nodes[1], ...patch }],
    })
    expect(parseTeamWorkItemHierarchyResponse(withNode({ wbsNumber: '1.0' }))).toBeUndefined()
    expect(parseTeamWorkItemHierarchyResponse(withNode({ hierarchyRank: 'B0' }))).toBeUndefined()
    expect(parseTeamWorkItemHierarchyResponse(withNode({ parentHidden: false }))).toBeUndefined()
    expect(parseTeamWorkItemHierarchyResponse(withNode({ rollup: { childCount: 1 } }))).toBeUndefined()
    expect(parseTeamWorkItemHierarchyResponse({ ...valid, schemaVersion: 2 })).toBeUndefined()
  })
})
