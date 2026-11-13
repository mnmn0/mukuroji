import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { useIncrementalRender } from '../src/shared/ui/useIncrementalRender'
import { createTranslator } from '../src/shared/i18n/i18n'
import { formatShowMoreLabel } from '../src/tasks/model/taskListRendering'

/**
 * Renders the IDs of the items `useIncrementalRender` keeps, and its hidden count.
 *
 * @param props - Items, step size, and the index that must stay rendered.
 * @returns A comma-separated list followed by the hidden count.
 */
function RenderedPrefix({
  items,
  stepSize,
  requiredIndex,
}: {
  /** Complete list. */
  items: readonly string[]
  /** Step size. */
  stepSize: number
  /** Index that must stay rendered. */
  requiredIndex?: number
}) {
  const { renderedItems, hiddenCount } = useIncrementalRender(items, stepSize, requiredIndex)
  return <p>{`${renderedItems.join(',')}|${hiddenCount}`}</p>
}

describe('incremental task list rendering', () => {
  const items = Array.from({ length: 7 }, (_, index) => `item-${index}`)

  test('renders only the first step of a long list and counts the rest', () => {
    expect(renderToStaticMarkup(<RenderedPrefix items={items} stepSize={3} />))
      .toBe('<p>item-0,item-1,item-2|4</p>')
    expect(renderToStaticMarkup(<RenderedPrefix items={items.slice(0, 2)} stepSize={3} />))
      .toBe('<p>item-0,item-1|0</p>')
  })

  test('keeps the required item rendered even beyond the first step', () => {
    expect(renderToStaticMarkup(<RenderedPrefix items={items} requiredIndex={5} stepSize={3} />))
      .toBe('<p>item-0,item-1,item-2,item-3,item-4,item-5|1</p>')
  })

  test('labels the next step with no more than the hidden items', () => {
    const ja = createTranslator('ja')
    const en = createTranslator('en')

    expect(formatShowMoreLabel(ja, 200, 1_800)).toBe('さらに 200 件を表示（未表示 1800 件）')
    expect(formatShowMoreLabel(en, 200, 37)).toBe('Show 37 more (37 not shown)')
  })
})
