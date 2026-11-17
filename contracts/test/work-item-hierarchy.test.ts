import { describe, expect, test } from 'bun:test'
import {
  buildWorkItemHierarchy,
  createDefaultWorkItemHierarchyRank,
  createWorkItemHierarchyRankBetween,
  isWorkItemHierarchyRank,
  readWorkItemParentId,
  rollUpWorkItemHierarchy,
  WORK_ITEM_HIERARCHY_RANK_MAX_LENGTH,
  type WorkItemHierarchyEntry,
  type WorkItemHierarchyRollupSource,
} from '../src/work-item-hierarchy'
import { DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY } from '../src/work-items'

/**
 * Builds a hierarchy entry.
 *
 * @param id - Work Item ID.
 * @param rank - Effective rank.
 * @param parentWorkItemId - Optional parent ID.
 * @returns The entry.
 */
function entry(id: string, rank: string, parentWorkItemId?: string): WorkItemHierarchyEntry {
  return { id, hierarchyRank: rank, ...(parentWorkItemId ? { parentWorkItemId } : {}) }
}

/**
 * Builds roll-up fields of one Work Item.
 *
 * @param overrides - Values replacing an unscheduled, unestimated, started Work Item.
 * @returns The roll-up source.
 */
function source(overrides: Partial<WorkItemHierarchyRollupSource> = {}): WorkItemHierarchyRollupSource {
  return {
    statusCategory: 'started',
    schedule: { mode: 'unscheduled', calendarPolicy: DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY },
    ...overrides,
  }
}

describe('hierarchy ranks', () => {
  test('validates ranks', () => {
    expect(isWorkItemHierarchyRank('i')).toBe(true)
    expect(isWorkItemHierarchyRank('a0b')).toBe(true)
    expect(isWorkItemHierarchyRank('a0')).toBe(false)
    expect(isWorkItemHierarchyRank('')).toBe(false)
    expect(isWorkItemHierarchyRank('A')).toBe(false)
    expect(isWorkItemHierarchyRank('z'.repeat(WORK_ITEM_HIERARCHY_RANK_MAX_LENGTH + 1))).toBe(false)
  })

  test('derives default ranks in creation order', () => {
    const ranks = [0, 1, 35, 36, 1_000_000, Number.MAX_SAFE_INTEGER].map(createDefaultWorkItemHierarchyRank)
    expect(ranks.every(isWorkItemHierarchyRank)).toBe(true)
    expect([...ranks].sort()).toEqual(ranks)
    expect(createDefaultWorkItemHierarchyRank(-1)).toBe(createDefaultWorkItemHierarchyRank(Number.NaN))
  })

  test('creates ranks strictly between neighbours', () => {
    const cases: [string | undefined, string | undefined][] = [
      [undefined, undefined],
      ['a', undefined],
      ['z', undefined],
      [undefined, 'a'],
      [undefined, '1'],
      [undefined, '01'],
      ['a', 'b'],
      ['a', 'a1'],
      ['k', 'k01'],
      ['az', 'b'],
      ['1000000000001i', '1000000000002i'],
    ]
    for (const [lower, upper] of cases) {
      const rank = createWorkItemHierarchyRankBetween(lower, upper)
      expect(rank).toBeDefined()
      if (rank === undefined) continue
      expect(isWorkItemHierarchyRank(rank)).toBe(true)
      if (lower !== undefined) expect(rank > lower).toBe(true)
      if (upper !== undefined) expect(rank < upper).toBe(true)
    }
  })

  test('keeps inserting between the same neighbours', () => {
    let lower = createDefaultWorkItemHierarchyRank(1)
    const upper = createDefaultWorkItemHierarchyRank(2)
    for (let index = 0; index < 40; index += 1) {
      const rank = createWorkItemHierarchyRankBetween(lower, upper)
      expect(rank).toBeDefined()
      if (!rank) break
      expect(rank > lower && rank < upper).toBe(true)
      lower = rank
    }
  })

  test('rejects invalid or unordered neighbours', () => {
    expect(createWorkItemHierarchyRankBetween('b', 'a')).toBeUndefined()
    expect(createWorkItemHierarchyRankBetween('a', 'a')).toBeUndefined()
    expect(createWorkItemHierarchyRankBetween('a0', undefined)).toBeUndefined()
  })
})

describe('buildWorkItemHierarchy', () => {
  test('numbers a three-level tree in sibling order', () => {
    const placements = buildWorkItemHierarchy([
      entry('task-b', 'b', 'phase-1'),
      entry('phase-2', 'b'),
      entry('task-a', 'a', 'phase-1'),
      entry('phase-1', 'a'),
      entry('sub', 'i', 'task-b'),
    ])
    expect(placements.map((placement) => [placement.workItemId, placement.wbsNumber, placement.depth])).toEqual([
      ['phase-1', '1', 0],
      ['task-a', '1.1', 1],
      ['task-b', '1.2', 1],
      ['sub', '1.2.1', 2],
      ['phase-2', '2', 0],
    ])
    expect(placements[0]?.childWorkItemIds).toEqual(['task-a', 'task-b'])
    expect(placements[2]?.parentWorkItemId).toBe('phase-1')
  })

  test('places orphans at the top level and breaks stored cycles', () => {
    const placements = buildWorkItemHierarchy([
      entry('orphan', 'a', 'missing'),
      entry('cycle-a', 'b', 'cycle-b'),
      entry('cycle-b', 'c', 'cycle-a'),
    ])
    expect(placements.map((placement) => [placement.workItemId, placement.wbsNumber])).toEqual([
      ['orphan', '1'],
      ['cycle-a', '2'],
      ['cycle-b', '2.1'],
    ])
  })

  test('breaks ties in rank by Work Item ID', () => {
    const placements = buildWorkItemHierarchy([entry('b', 'i'), entry('a', 'i')])
    expect(placements.map((placement) => placement.workItemId)).toEqual(['a', 'b'])
  })
})

describe('rollUpWorkItemHierarchy', () => {
  test('counts every descendant once and spans their dates', () => {
    const placements = buildWorkItemHierarchy([
      entry('root', 'a'),
      entry('child', 'a', 'root'),
      entry('leaf-1', 'a', 'child'),
      entry('leaf-2', 'b', 'child'),
      entry('hidden', 'c', 'root'),
    ])
    const calendarPolicy = DEFAULT_WORK_ITEM_SCHEDULE_CALENDAR_POLICY
    const sources = new Map<string, WorkItemHierarchyRollupSource>([
      ['root', source({ schedule: { mode: 'unscheduled', calendarPolicy, plannedEffortMinutes: 999 } })],
      ['child', source({ statusCategory: 'completed', schedule: { mode: 'due-date', dueDate: '2026-12-20', calendarPolicy, plannedEffortMinutes: 60 } })],
      ['leaf-1', source({ schedule: { mode: 'date-range', startDate: '2026-12-01', endDate: '2026-12-05', durationDays: 5, calendarPolicy, plannedEffortMinutes: 120 }, remainingEffortMinutes: 30 })],
      ['leaf-2', source({ statusCategory: 'canceled' })],
    ])
    const rollups = rollUpWorkItemHierarchy(placements, sources)
    expect(rollups.get('root')).toEqual({
      childCount: 1,
      descendantCount: 3,
      statusCategoryCounts: { backlog: 0, unstarted: 0, started: 1, completed: 1, canceled: 1 },
      openDescendantCount: 1,
      plannedEffortMinutes: 180,
      estimatedDescendantCount: 2,
      remainingEffortMinutes: 30,
      startDate: '2026-12-01',
      endDate: '2026-12-20',
    })
    expect(rollups.get('child')?.descendantCount).toBe(2)
    expect(rollups.has('leaf-1')).toBe(false)
  })
})

describe('readWorkItemParentId', () => {
  test('reads the parent relation', () => {
    expect(readWorkItemParentId(['blocks:x', 'parent:p-1'])).toBe('p-1')
    expect(readWorkItemParentId(['blocks:x'])).toBeUndefined()
  })
})
