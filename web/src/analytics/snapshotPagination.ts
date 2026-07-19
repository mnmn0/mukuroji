import type { AnalyticsSnapshotListResponse } from '@mukuroji/contracts'

const maximumAutomaticSnapshotPageCount = 10

/**
 * 共有URLのsnapshotを探すために次pageを自動取得するか判定します。
 *
 * @param pages - 取得済みsnapshot pageです。
 * @param targetSnapshotId - 共有URLが指定したsnapshot IDです。
 * @param requestedPageCount - SWRInfiniteへ要求済みのpage数です。
 * @returns 次page取得、上限停止、またはcursor guard違反を表す判定です。
 */
export function resolveAnalyticsSnapshotAutoPagination(
  pages: readonly AnalyticsSnapshotListResponse[] | undefined,
  targetSnapshotId: string | undefined,
  requestedPageCount: number,
) {
  if (
    !targetSnapshotId ||
    !pages ||
    pages.length === 0 ||
    pages.length < requestedPageCount ||
    pages.some((page) =>
      page.snapshots.some((snapshot) => snapshot.id === targetSnapshotId)
    )
  ) {
    return 'idle'
  }

  const nextCursor = pages.at(-1)?.nextCursor
  if (nextCursor === undefined) return 'idle'
  if (
    pages.slice(0, -1).some((page) => page.nextCursor === nextCursor)
  ) {
    return 'cursor-repeated'
  }
  if (pages.length >= maximumAutomaticSnapshotPageCount) {
    return 'page-limit-reached'
  }
  return 'load-next-page'
}
