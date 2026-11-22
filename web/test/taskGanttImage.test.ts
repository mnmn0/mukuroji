import { describe, expect, test } from 'bun:test'
import {
  createTaskGanttImage,
  resolveTaskGanttImagePixelRatio,
  truncateTaskGanttImageLabel,
  type TaskGanttImageInput,
} from '../src/tasks/model/taskGanttImage'

/**
 * Builds an image input with the given number of one-bar task rows.
 *
 * @param count - Number of task rows.
 * @returns Chart input with 48px rows.
 */
function createInput(count: number): TaskGanttImageInput {
  return {
    columnWidth: 40,
    columns: [
      { isNonWorking: false, isToday: false, label: '6/1' },
      { isNonWorking: true, isToday: false, label: '6/2' },
      { isNonWorking: false, isToday: true, label: '6/3' },
    ],
    externalLaneHeight: 0,
    labelHeader: 'タスク / 担当者',
    labelWidth: 360,
    rowTops: Array.from({ length: count + 1 }, (_, index) => index * 48),
    rows: Array.from({ length: count }, (_, index) => ({
      bars: [{ height: 22, kind: 'date-range', left: 4, progressPercent: 50, top: 12, width: 72 }],
      indent: 0,
      kind: 'task',
      label: `1.${index + 1} Task ${index}`,
    })),
    title: 'ガントチャート（2026-06-03 時点）',
    todayX: 100,
  }
}

describe('Gantt image export', () => {
  test('draws every row, including rows the screen leaves out of the DOM', () => {
    const image = createTaskGanttImage(createInput(300))

    expect(image.width).toBe(360 + 3 * 40)
    expect(image.height).toBe(40 + 32 + 300 * 48)
    expect(image.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(image.svg).toContain('>1.1 Task 0<')
    expect(image.svg).toContain('>1.300 Task 299<')
    // The progress fill covers half of the planned bar.
    expect(image.svg).toContain('width="36"')
  })

  test('escapes titles so a Work Item cannot inject markup into the file', () => {
    const input = createInput(1)
    const image = createTaskGanttImage({
      ...input,
      rows: [{ bars: [], indent: 0, kind: 'task', label: '<script>alert("x")</script> & co' }],
    })

    expect(image.svg).not.toContain('<script>')
    expect(image.svg).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co')
  })

  test('draws group headings, today, the progress line, and dependency arrows', () => {
    const input = createInput(1)
    const image = createTaskGanttImage({
      ...input,
      connectors: [{ conflict: false, critical: true, path: 'M10 20 L60 20' }],
      progressLinePoints: [{ x: 100, y: 0 }, { x: 80, y: 24 }, { x: 100, y: 48 }],
      rowTops: [0, 40, 88],
      rows: [{ kind: 'group', label: 'Refero (1)' }, ...input.rows],
    })

    expect(image.svg).toContain('>Refero (1)<')
    expect(image.svg).toContain('points="100,0 80,24 100,48"')
    expect(image.svg).toContain('marker-end="url(#arrow-critical)"')
    expect(image.svg).toContain('x1="100" y1="0" x2="100" y2="88"')
  })

  test('shortens long labels to the column width with an ellipsis', () => {
    expect(truncateTaskGanttImageLabel('short', 100)).toBe('short')
    const shortened = truncateTaskGanttImageLabel('とても長いタスクの名前がここに入ります', 60)
    expect(shortened.endsWith('…')).toBe(true)
    expect(Array.from(shortened).length).toBeLessThanOrEqual(5)
  })

  test('lowers the pixel ratio for a large chart and refuses one too large for a canvas', () => {
    expect(resolveTaskGanttImagePixelRatio(1_000, 2_000)).toBe(2)
    expect(resolveTaskGanttImagePixelRatio(7_000, 14_000)).toBe(1)
    expect(resolveTaskGanttImagePixelRatio(20_000, 1_000)).toBeUndefined()
  })
})
