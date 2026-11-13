import { TeamIssuesApiError } from '../api/errors'

/**
 * Largest number of Work Items one complete list read keeps.
 *
 * Beyond it the read fails with `WorkItemListLimitExceeded` instead of showing a silently
 * truncated list.
 */
export const WORK_ITEM_LIST_MAX_ITEMS = 10_000

/**
 * Safety limit on followed pages.
 *
 * A selective filter can return empty pages with a cursor, because the server evaluates at
 * most 2,000 rows per request, so the item limit above is what bounds the result. This limit
 * only stops a read that never ends.
 */
const WORK_ITEM_LIST_MAX_PAGES = 500

/** Minimal shape of one cursor page. */
type CursorPage = {
  /** Opaque cursor for the next page. Absent on the last page. */
  nextCursor?: string
}

/**
 * Follows page cursors until the last page and returns the collected Work Items.
 *
 * @param readPage - Reads the page that starts at `cursor`, or the first page.
 * @param readItems - Returns the Work Items of one page.
 * @param onPage - Optional callback that receives each page, for example to keep capabilities.
 * @returns Every Work Item of every page, in page order.
 * @throws TeamIssuesApiError `413 WorkItemListLimitExceeded` above {@link WORK_ITEM_LIST_MAX_ITEMS},
 *   or `503 WorkItemListReadStalled` when the cursor repeats or the read never ends.
 */
export async function loadAllWorkItemPages<TPage extends CursorPage, TItem>(
  readPage: (cursor: string | undefined) => Promise<TPage>,
  readItems: (page: TPage) => readonly TItem[],
  onPage?: (page: TPage) => void,
): Promise<TItem[]> {
  const items: TItem[] = []
  let cursor: string | undefined

  for (let page = 0; page < WORK_ITEM_LIST_MAX_PAGES; page += 1) {
    const response = await readPage(cursor)
    onPage?.(response)
    items.push(...readItems(response))
    if (items.length > WORK_ITEM_LIST_MAX_ITEMS) {
      throw new TeamIssuesApiError(
        413,
        `More than ${WORK_ITEM_LIST_MAX_ITEMS} Work Items match this view.`,
        'WorkItemListLimitExceeded',
      )
    }
    if (!response.nextCursor) return items
    if (response.nextCursor === cursor) throw createWorkItemListStalledError()
    cursor = response.nextCursor
  }

  throw createWorkItemListStalledError()
}

/**
 * Creates the error for a cursor read that repeats its cursor or never ends.
 *
 * @returns The error shown instead of a partial Work Item list.
 */
function createWorkItemListStalledError() {
  return new TeamIssuesApiError(
    503,
    'The Work Item list did not finish loading.',
    'WorkItemListReadStalled',
  )
}
