import { useState } from 'react'

/** State of a list that renders its items in steps instead of all at once. */
export type IncrementalRenderState<TItem> = {
  /** Items to render now: a prefix of the complete list. */
  renderedItems: readonly TItem[]
  /** Items of the complete list that are not rendered yet. */
  hiddenCount: number
  /** Renders the next step of items. */
  showMore: () => void
}

/**
 * Renders a long list in steps so thousands of rows do not create their DOM at once.
 *
 * Filtering, sorting, and counts stay on the complete list; only rendering is limited. An item
 * the caller must keep on screen, such as the selected row, extends the rendered prefix up to it.
 *
 * @param items - Complete list in display order.
 * @param stepSize - Number of items added per step, and rendered initially.
 * @param requiredIndex - Index that must stay rendered, or a negative number for none.
 * @returns The rendered prefix, the number of hidden items, and a callback for the next step.
 */
export function useIncrementalRender<TItem>(
  items: readonly TItem[],
  stepSize: number,
  requiredIndex = -1,
): IncrementalRenderState<TItem> {
  const [renderLimit, setRenderLimit] = useState(stepSize)
  const effectiveLimit = Math.max(renderLimit, requiredIndex + 1)
  const renderedItems = items.length > effectiveLimit ? items.slice(0, effectiveLimit) : items
  return {
    renderedItems,
    hiddenCount: items.length - renderedItems.length,
    showMore: () => setRenderLimit(effectiveLimit + stepSize),
  }
}
