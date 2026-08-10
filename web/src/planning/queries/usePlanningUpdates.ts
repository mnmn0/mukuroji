import type {
  PlanningUpdate,
  PlanningUpdateComment,
  PlanningUpdateHistoryPage,
  PlanningUpdateReaction,
  PlanningUpdateTarget,
} from '@mukuroji/contracts'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import {
  getPlanningUpdateWatch,
  listPlanningUpdateComments,
  listPlanningUpdateReactions,
  listPlanningUpdates,
} from '../api'

const planningUpdateQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

const planningUpdateAnnotationVersionLimit = 20
const planningUpdateAnnotationPageSize = 100

/** One bounded annotation page cached for a target/version pair. */
type PlanningUpdateAnnotationPage = {
  /** Comments returned by the first page. */
  comments: PlanningUpdateComment[]
  /** Reactions returned by the first page. */
  reactions: PlanningUpdateReaction[]
}

const planningUpdateAnnotationPageCache = new Map<
  string,
  Promise<PlanningUpdateAnnotationPage>
>()

/**
 * Loads the newest immutable update-history page for one selected target.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Project or Initiative target.
 * @param enabled - Whether authenticated fetching is enabled.
 * @returns SWR state for the selected target's newest history page.
 */
export function usePlanningUpdates(
  accessToken: string | undefined,
  target: PlanningUpdateTarget | undefined,
  enabled = true,
) {
  const targetKey = target ? createPlanningUpdateTargetQueryKey(target) : undefined
  const key = accessToken && target && targetKey && enabled
    ? ['planning-updates', accessToken, targetKey]
    : null
  const query = useSWRInfinite(
    (
      pageIndex,
      previousPage: PlanningUpdateHistoryPage | null,
    ) => {
      if (!accessToken || !target || !targetKey || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'planning-updates',
        accessToken,
        target,
        pageIndex === 0 ? '' : previousPage?.nextCursor ?? '',
      ] satisfies [string, string, PlanningUpdateTarget, string]
    },
    ([, token, currentTarget, cursor]) => listPlanningUpdates(token, {
      cursor: cursor || undefined,
      limit: 20,
      target: currentTarget,
    }),
    planningUpdateQueryConfig,
  )
  const pages = query.data
  const data = pages
    ? {
        nextCursor: pages.at(-1)?.nextCursor,
        updates: pages.flatMap((page) => page.updates),
      }
    : undefined
  const hasMore = Boolean(pages?.at(-1)?.nextCursor)
  const isLoadingMore = Boolean(
    query.isValidating && query.size > (pages?.length ?? 0),
  )

  return {
    ...query,
    data,
    hasMore,
    isLoadingMore,
    key,
    loadMore: () => query.setSize((current) => current + 1),
  }
}

/**
 * Loads the current viewer's watcher state for one selected update target.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Project or Initiative target.
 * @param enabled - Whether authenticated fetching is enabled.
 * @returns SWR state for the selected target's watcher projection.
 */
export function usePlanningUpdateWatch(
  accessToken: string | undefined,
  target: PlanningUpdateTarget | undefined,
  enabled = true,
) {
  const targetKey = target ? createPlanningUpdateTargetQueryKey(target) : undefined
  const key = accessToken && target && targetKey && enabled
    ? ['planning-update-watch', accessToken, targetKey]
    : null
  const query = useSWR(
    key,
    () => target && accessToken
      ? getPlanningUpdateWatch(accessToken, target)
      : undefined,
    planningUpdateQueryConfig,
  )

  return {
    ...query,
    key,
  }
}

/** Annotation projection loaded across the visible immutable update versions. */
export type PlanningUpdateAnnotations = {
  /** Append-only comments across every requested version. */
  comments: PlanningUpdateComment[]
  /** Member reactions across every requested version. */
  reactions: PlanningUpdateReaction[]
}

/**
 * Loads comments and reactions for the visible immutable update versions.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Project or Initiative target.
 * @param updates - Visible immutable update history, newest first.
 * @param enabled - Whether authenticated fetching is enabled.
 * @returns SWR state containing flattened comment and reaction collections.
 */
export function usePlanningUpdateAnnotations(
  accessToken: string | undefined,
  target: PlanningUpdateTarget | undefined,
  updates: readonly PlanningUpdate[] | undefined,
  enabled = true,
) {
  const targetKey = target ? createPlanningUpdateTargetQueryKey(target) : undefined
  const updateVersions = selectPlanningUpdateAnnotationVersions(updates)
  const versionsKey = updateVersions.join(',')
  const key = accessToken && target && targetKey && updateVersions.length > 0 && enabled
    ? ['planning-update-annotations', accessToken, targetKey, versionsKey]
    : null
  const query = useSWR(
    key,
    async (): Promise<PlanningUpdateAnnotations | undefined> => {
      if (!target || !accessToken) return undefined
      return loadCachedPlanningUpdateAnnotations(
        accessToken,
        target,
        updateVersions,
      )
    },
    planningUpdateQueryConfig,
  )

  return {
    ...query,
    mutate: () => {
      if (accessToken && target) {
        invalidatePlanningUpdateAnnotationPageCache(accessToken, target, updateVersions)
      }
      return query.mutate()
    },
    key,
  }
}

/**
 * Selects only the newest distinct update versions used by the annotation preview.
 *
 * @param updates - Visible immutable update history ordered newest first.
 * @returns At most one history page of distinct update versions.
 */
export function selectPlanningUpdateAnnotationVersions(
  updates: readonly Pick<PlanningUpdate, 'version'>[] | undefined,
) {
  const versions: number[] = []
  const seenVersions = new Set<number>()
  for (const update of updates ?? []) {
    if (seenVersions.has(update.version)) continue
    seenVersions.add(update.version)
    versions.push(update.version)
    if (versions.length === planningUpdateAnnotationVersionLimit) break
  }
  return versions
}

/**
 * Loads one bounded comment and reaction preview page for each newest update version.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Planning update target.
 * @param updateVersions - Immutable update versions ordered newest first.
 * @param loadComments - Comment page loader overridden by focused tests.
 * @param loadReactions - Reaction page loader overridden by focused tests.
 * @returns Flattened first-page annotations for at most twenty update versions.
 */
export async function loadBoundedPlanningUpdateAnnotations(
  accessToken: string,
  target: PlanningUpdateTarget,
  updateVersions: readonly number[],
  loadComments: typeof listPlanningUpdateComments = listPlanningUpdateComments,
  loadReactions: typeof listPlanningUpdateReactions = listPlanningUpdateReactions,
): Promise<PlanningUpdateAnnotations> {
  const pages = await Promise.all(
    updateVersions
      .slice(0, planningUpdateAnnotationVersionLimit)
      .map(async (updateVersion) => {
        const [comments, reactions] = await Promise.all([
          loadComments(accessToken, {
            limit: planningUpdateAnnotationPageSize,
            target,
            updateVersion,
          }),
          loadReactions(accessToken, {
            limit: planningUpdateAnnotationPageSize,
            target,
            updateVersion,
          }),
        ])
        return {
          comments: comments.comments,
          reactions: reactions.reactions,
        }
      }),
  )
  return {
    comments: pages.flatMap((page) => page.comments),
    reactions: pages.flatMap((page) => page.reactions),
  }
}

/**
 * Loads the bounded annotation preview while reusing one cache entry per target/version.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Planning update target.
 * @param updateVersions - Immutable update versions ordered newest first.
 * @returns Flattened first-page annotations for the newest distinct versions.
 */
async function loadCachedPlanningUpdateAnnotations(
  accessToken: string,
  target: PlanningUpdateTarget,
  updateVersions: readonly number[],
): Promise<PlanningUpdateAnnotations> {
  const pages = await Promise.all(
    updateVersions
      .slice(0, planningUpdateAnnotationVersionLimit)
      .map((updateVersion) => loadCachedPlanningUpdateAnnotationPage(
        accessToken,
        target,
        updateVersion,
      )),
  )
  return {
    comments: pages.flatMap((page) => page.comments),
    reactions: pages.flatMap((page) => page.reactions),
  }
}

/**
 * Loads one annotation page and shares the in-flight/resolved request by target/version.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Planning update target.
 * @param updateVersion - Immutable update version.
 * @returns One bounded comment/reaction page.
 */
function loadCachedPlanningUpdateAnnotationPage(
  accessToken: string,
  target: PlanningUpdateTarget,
  updateVersion: number,
): Promise<PlanningUpdateAnnotationPage> {
  const cacheKey = createPlanningUpdateAnnotationPageCacheKey(
    accessToken,
    target,
    updateVersion,
  )
  const cached = planningUpdateAnnotationPageCache.get(cacheKey)
  if (cached) return cached
  const request = Promise.all([
    listPlanningUpdateComments(accessToken, {
      limit: planningUpdateAnnotationPageSize,
      target,
      updateVersion,
    }),
    listPlanningUpdateReactions(accessToken, {
      limit: planningUpdateAnnotationPageSize,
      target,
      updateVersion,
    }),
  ]).then(([comments, reactions]) => ({
    comments: comments.comments,
    reactions: reactions.reactions,
  }))
  planningUpdateAnnotationPageCache.set(cacheKey, request)
  void request.catch(() => {
    if (planningUpdateAnnotationPageCache.get(cacheKey) === request) {
      planningUpdateAnnotationPageCache.delete(cacheKey)
    }
  })
  return request
}

/** Removes cached annotation pages so a successful comment/reaction mutation is visible. */
function invalidatePlanningUpdateAnnotationPageCache(
  accessToken: string,
  target: PlanningUpdateTarget,
  updateVersions: readonly number[],
): void {
  for (const updateVersion of updateVersions.slice(0, planningUpdateAnnotationVersionLimit)) {
    planningUpdateAnnotationPageCache.delete(
      createPlanningUpdateAnnotationPageCacheKey(accessToken, target, updateVersion),
    )
  }
}

/** Creates the cache key for one target/version annotation page. */
function createPlanningUpdateAnnotationPageCacheKey(
  accessToken: string,
  target: PlanningUpdateTarget,
  updateVersion: number,
): string {
  return `${accessToken}\n${createPlanningUpdateTargetQueryKey(target)}\n${updateVersion}`
}

/**
 * Reloads immutable history after a successful publish without converting a query failure into
 * a publish mutation failure.
 *
 * @param revalidate - SWR history revalidation callback.
 * @returns Whether the history refresh completed successfully.
 */
export async function revalidatePlanningUpdateHistoryAfterPublish(
  revalidate: () => Promise<unknown>,
) {
  try {
    await revalidate()
    return true
  } catch {
    return false
  }
}

/**
 * Creates a Team-qualified cache key for a Project or Initiative update stream.
 *
 * @param target - Canonical update target.
 * @returns Stable SWR cache-key segment.
 */
function createPlanningUpdateTargetQueryKey(target: PlanningUpdateTarget) {
  return target.type === 'project'
    ? `project:${target.teamId}\0${target.projectId}`
    : `initiative:${target.entityId}`
}
