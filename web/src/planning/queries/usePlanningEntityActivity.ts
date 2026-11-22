import useSWRInfinite from 'swr/infinite'
import { getPlanningEntityActivity, type PlanningEntityActivityPage } from '../api/entities'

const planningEntityActivityQueryConfig = {
  dedupingInterval: 10_000,
  revalidateFirstPage: true,
  shouldRetryOnError: false,
} as const

/** 活動を 1 page に読む件数です。 */
const planningEntityActivityPageSize = 25

/**
 * Planning entity の活動を新しい順の cursor page で取得します。
 *
 * Server は閲覧者が見られない scope の event を page から除くため、読んだ page が空でも続きがあることがあります。
 *
 * @param accessToken - Planning API の access token です。
 * @param entityId - 活動を読む entity ID です。
 * @param revision - Planning snapshot の revision です。変わると先頭 page を読み直します。
 * @returns 読み込んだ event、続きの有無、読み込み状態と再取得の操作です。
 */
export function usePlanningEntityActivity(accessToken: string | undefined, entityId: string, revision?: number) {
  const query = useSWRInfinite(
    (pageIndex, previousPage: PlanningEntityActivityPage | null) => {
      if (!accessToken) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'planning-entity-activity',
        accessToken,
        entityId,
        revision ?? -1,
        pageIndex === 0 ? '' : previousPage?.nextCursor ?? '',
      ] satisfies [string, string, string, number, string]
    },
    ([, token, id, , cursor]) => getPlanningEntityActivity(token, id, {
      ...(cursor ? { cursor } : {}),
      limit: planningEntityActivityPageSize,
    }),
    planningEntityActivityQueryConfig,
  )
  const pages = query.data
  const activityError: unknown = query.error
  return {
    events: pages?.flatMap((page) => page.events) ?? [],
    error: activityError,
    hasMore: Boolean(pages?.at(-1)?.nextCursor),
    isLoading: query.isLoading,
    isLoadingMore: Boolean(query.isValidating && query.size > (pages?.length ?? 0)),
    loadMore: () => query.setSize(query.size + 1),
    retry: () => query.mutate(),
  }
}
