/** Parent relations read at once while ordering a Bulk archive. */
const BULK_ARCHIVE_ORDER_READ_CONCURRENCY = 16

/**
 * Reads the parent of one Work Item.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item whose parent is read.
 * @returns The parent Work Item ID, or undefined when the Work Item has no parent.
 */
export type BulkArchiveParentReader = (teamId: string, workItemId: string) => Promise<string | undefined>

/**
 * Orders Bulk archive items so that each item's hierarchy check sees the items it depends on.
 *
 * Children are archived before their parent, and a parent is restored before its children. Each
 * item's depth counts its ancestors among the items; archiving runs the deepest first, restoring
 * the shallowest first, and items of equal depth keep request order.
 *
 * @param items - Bulk targets in request order.
 * @param archived - True when the items are archived, false when they are restored.
 * @param readParent - Reads the parent of one Work Item.
 * @returns Every item index exactly once, in apply order.
 */
export async function orderBulkArchiveItems(
  items: readonly { teamId: string, workItemId: string }[],
  archived: boolean,
  readParent: BulkArchiveParentReader,
): Promise<number[]> {
  const itemKey = (teamId: string, workItemId: string) => `${teamId}\0${workItemId}`
  const indexByKey = new Map(items.map((item, index) => [itemKey(item.teamId, item.workItemId), index]))
  const parentIndexes: (number | undefined)[] = []
  for (let start = 0; start < items.length; start += BULK_ARCHIVE_ORDER_READ_CONCURRENCY) {
    const batch = await Promise.all(items
      .slice(start, start + BULK_ARCHIVE_ORDER_READ_CONCURRENCY)
      .map(async (item) => {
        const parentId = await readParent(item.teamId, item.workItemId)
        return parentId === undefined ? undefined : indexByKey.get(itemKey(item.teamId, parentId))
      }))
    parentIndexes.push(...batch)
  }
  const depths = items.map((_, index) => {
    let depth = 0
    const visited = new Set([index])
    for (
      let parent = parentIndexes[index];
      parent !== undefined && !visited.has(parent);
      parent = parentIndexes[parent]
    ) {
      visited.add(parent)
      depth += 1
    }
    return depth
  })
  return items
    .map((_, index) => index)
    .sort((left, right) => {
      const byDepth = archived
        ? (depths[right] ?? 0) - (depths[left] ?? 0)
        : (depths[left] ?? 0) - (depths[right] ?? 0)
      return byDepth !== 0 ? byDepth : left - right
    })
}
