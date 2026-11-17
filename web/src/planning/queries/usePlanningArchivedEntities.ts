import type { ArchivedPlanningEntityPage } from '@mukuroji/contracts'
import useSWRInfinite from 'swr/infinite'
import { listArchivedPlanningEntities } from '../api'

const archivedPlanningQueryConfig = {
  dedupingInterval: 10_000,
  revalidateFirstPage: false,
  shouldRetryOnError: false,
} as const

/** Archive 済み entity を 1 page に読む件数です（server の上限と同じ）。 */
const archivedPlanningPageSize = 50

/**
 * 呼び出し元が復元できる archive 済み Planning entity を cursor page で取得します。
 *
 * Server は権限のない entity を page から除くため、読んだ page が空でも続きがあることがあります。
 *
 * @param accessToken - Planning API の access token です。
 * @param enabled - 一覧を開いて取得を有効にするかどうかです。
 * @returns 読み込んだ entity、続きの有無、読み込み状態と SWR の操作です。
 */
export function usePlanningArchivedEntities(accessToken?: string, enabled = true) {
  const query = useSWRInfinite(
    (pageIndex, previousPage: ArchivedPlanningEntityPage | null) => {
      if (!accessToken || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'planning-archived-entities',
        accessToken,
        pageIndex === 0 ? '' : previousPage?.nextCursor ?? '',
      ] satisfies [string, string, string]
    },
    ([, token, cursor]) => listArchivedPlanningEntities(token, {
      ...(cursor ? { cursor } : {}),
      limit: archivedPlanningPageSize,
    }),
    archivedPlanningQueryConfig,
  )
  const pages = query.data
  return {
    entities: pages?.flatMap((page) => page.entities) ?? [],
    error: query.error as unknown,
    hasMore: Boolean(pages?.at(-1)?.nextCursor),
    isLoading: query.isLoading,
    isLoadingMore: Boolean(query.isValidating && query.size > (pages?.length ?? 0)),
    loadMore: () => query.setSize(query.size + 1),
    mutate: query.mutate,
  }
}
