/** Maximum cursor pages followed automatically for an unresolved deep link. */
export const MAX_DEEP_LINK_AUTO_PAGES = 5

/**
 * Mutable traversal snapshot retained by a deep-linking component ref.
 */
export type DeepLinkTraversalState = {
  /** Target identifier associated with the traversal count. */
  targetId?: string
  /** Number of cursor pages requested automatically for the target. */
  requestedPages: number
}

/**
 * Advances a bounded automatic deep-link traversal.
 *
 * @param current - Current target and automatic request count.
 * @param targetId - Deep-linked entity identifier.
 * @param canLoad - Whether another cursor page is currently available and idle.
 * @returns Updated state and whether the caller should request one page.
 */
export function advanceDeepLinkTraversal(
  current: DeepLinkTraversalState,
  targetId: string | undefined,
  canLoad: boolean,
): { state: DeepLinkTraversalState; shouldLoad: boolean } {
  if (!targetId) {
    return {
      shouldLoad: false,
      state: { requestedPages: 0 },
    }
  }

  const requestedPages =
    current.targetId === targetId ? current.requestedPages : 0
  const shouldLoad =
    canLoad && requestedPages < MAX_DEEP_LINK_AUTO_PAGES

  return {
    shouldLoad,
    state: {
      requestedPages: shouldLoad ? requestedPages + 1 : requestedPages,
      targetId,
    },
  }
}
