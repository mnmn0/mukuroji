/** Rows of a Gantt chart to create in the DOM, as a half-open index range. */
export type TaskGanttVirtualRowRange = {
  /** Index of the first rendered row. */
  start: number
  /** Index after the last rendered row. */
  end: number
}

/** Part of the chart's row area that is visible, in pixels from the top of the first row. */
export type TaskGanttRowViewport = {
  /** Offset of the visible area's top edge; negative while rows start below the visible top. */
  top: number
  /** Height of the visible area. */
  height: number
}

/** Input to {@link resolveTaskGanttVirtualRowRange}. */
export type TaskGanttVirtualRowRangeInput = {
  /** Top offset of each row, followed by the total height of all rows. */
  rowTops: readonly number[]
  /** Visible part of the row area. */
  viewport: TaskGanttRowViewport
  /** Extra height rendered above and below the visible area, so fast scrolling shows no gap. */
  overscan: number
  /** Row indexes that must stay rendered, such as a row whose bar is being dragged. */
  requiredIndexes?: readonly number[]
}

/**
 * Chooses which Gantt rows to create in the DOM for the visible part of the chart.
 *
 * Rows are kept contiguous, so the caller can stand in for the rows left out with one spacer
 * above and one below. A required row outside the visible area widens the range up to it.
 *
 * @param input - Row offsets, the visible area, the overscan, and rows that must stay rendered.
 * @returns The half-open range of rows to render; empty when there are no rows.
 */
export function resolveTaskGanttVirtualRowRange(
  input: TaskGanttVirtualRowRangeInput,
): TaskGanttVirtualRowRange {
  const { overscan, requiredIndexes = [], rowTops, viewport } = input
  const rowCount = Math.max(0, rowTops.length - 1)
  if (rowCount === 0) return { start: 0, end: 0 }
  const top = viewport.top - overscan
  const bottom = viewport.top + Math.max(0, viewport.height) + overscan
  // The first row whose bottom edge is below the top, and the first row starting at the bottom.
  let start = Math.min(findFirstOffsetAbove(rowTops, top, 1) - 1, rowCount - 1)
  let end = Math.max(findFirstOffsetAbove(rowTops, bottom - 1, 0), start + 1)
  end = Math.min(end, rowCount)
  start = Math.max(0, start)
  for (const index of requiredIndexes) {
    if (index < 0 || index >= rowCount) continue
    start = Math.min(start, index)
    end = Math.max(end, index + 1)
  }
  return { start, end }
}

/**
 * Finds the first index whose offset is greater than a value, by binary search.
 *
 * @param offsets - Offsets in ascending order.
 * @param value - Value to compare with.
 * @param from - First index to search.
 * @returns The first index at or after `from` whose offset is greater than `value`, or the
 *   length of `offsets` when there is none.
 */
function findFirstOffsetAbove(offsets: readonly number[], value: number, from: number): number {
  let low = from
  let high = offsets.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((offsets[middle] ?? Number.POSITIVE_INFINITY) > value) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  return low
}
