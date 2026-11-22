import { describe, expect, test } from 'bun:test'
import { resolveTaskGanttVirtualRowRange } from '../src/tasks/model/taskGanttVirtualRows'

/**
 * Builds row offsets for rows of the same height.
 *
 * @param count - Number of rows.
 * @param height - Height of each row.
 * @returns The top of each row, followed by the total height.
 */
function uniformRowTops(count: number, height: number): number[] {
  return Array.from({ length: count + 1 }, (_, index) => index * height)
}

describe('resolveTaskGanttVirtualRowRange', () => {
  const rowTops = uniformRowTops(300, 48)

  test('renders the rows of the visible area and the overscan only', () => {
    expect(resolveTaskGanttVirtualRowRange({
      overscan: 96,
      rowTops,
      viewport: { height: 480, top: 4_800 },
    })).toEqual({ end: 112, start: 98 })
  })

  test('starts at the first row while the rows are below the visible top', () => {
    expect(resolveTaskGanttVirtualRowRange({
      overscan: 0,
      rowTops,
      viewport: { height: 200, top: -100 },
    })).toEqual({ end: 3, start: 0 })
  })

  test('keeps the last rows when scrolled to the bottom or past it', () => {
    expect(resolveTaskGanttVirtualRowRange({
      overscan: 48,
      rowTops,
      viewport: { height: 480, top: 300 * 48 - 480 },
    })).toEqual({ end: 300, start: 289 })
    expect(resolveTaskGanttVirtualRowRange({
      overscan: 0,
      rowTops,
      viewport: { height: 480, top: 100_000 },
    })).toEqual({ end: 300, start: 299 })
  })

  test('widens the range to rows that must stay rendered', () => {
    expect(resolveTaskGanttVirtualRowRange({
      overscan: 0,
      requiredIndexes: [5, 400, -1],
      rowTops,
      viewport: { height: 480, top: 4_800 },
    })).toEqual({ end: 110, start: 5 })
  })

  test('handles rows of different heights and an empty chart', () => {
    // A 40px group heading followed by 124px task rows.
    const mixed = [0, 40, 164, 288, 412]
    expect(resolveTaskGanttVirtualRowRange({
      overscan: 0,
      rowTops: mixed,
      viewport: { height: 100, top: 170 },
    })).toEqual({ end: 3, start: 2 })
    expect(resolveTaskGanttVirtualRowRange({
      overscan: 0,
      rowTops: [0],
      viewport: { height: 480, top: 0 },
    })).toEqual({ end: 0, start: 0 })
  })
})
