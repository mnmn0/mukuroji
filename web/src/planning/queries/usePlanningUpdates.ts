import type {
  PlanningUpdate,
  PlanningUpdateComment,
  PlanningUpdateHistoryPage,
  PlanningUpdateReaction,
  PlanningUpdateTarget,
} from '@mukuroji/contracts'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import { useMemo, useState } from 'react'
import {
  getPlanningUpdateWatch,
  listPlanningUpdateComments,
  listPlanningUpdateReactions,
  listPlanningUpdates,
} from '../api'
import { createPlanningUpdateTargetKey } from '../model/targetKey'

const planningUpdateQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

const planningUpdateAnnotationVersionLimit = 20
const planningUpdateAnnotationPageSize = 100
const planningUpdateAnnotationInFlightCacheLimit = 100

/** All annotation rows loaded for one bounded target/version pair. */
type PlanningUpdateAnnotationPage = {
  /** Comments returned by every available cursor page. */
  comments: PlanningUpdateComment[]
  /** Reactions returned by every available cursor page. */
  reactions: PlanningUpdateReaction[]
}

/** One cursor page returned by a Planning annotation endpoint. */
type PlanningUpdateAnnotationItemPage<Item> = {
  /** Annotation rows returned by this page. */
  items: Item[]
  /** Opaque cursor for the next page, when more rows exist. */
  nextCursor?: string
}

const planningUpdateAnnotationPageCache = new Map<
  string,
  Promise<PlanningUpdateAnnotationPage>
>()
const emptyPlanningUpdateAnnotationPages: Record<string, PlanningUpdateAnnotationPage> = {}

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
  const targetKey = target ? createPlanningUpdateTargetKey(target) : undefined
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
  const targetKey = target ? createPlanningUpdateTargetKey(target) : undefined
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
 * Only bounded in-flight requests are shared; resolved pages are revalidated on the next fetch.
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
  const targetKey = target ? createPlanningUpdateTargetKey(target) : undefined
  const annotationScopeKey = `${accessToken ?? ''}\0${targetKey ?? ''}`
  const [onDemandState, setOnDemandState] = useState<{
    scopeKey: string
    pages: Record<string, PlanningUpdateAnnotationPage>
  }>({ scopeKey: annotationScopeKey, pages: {} })
  const onDemandPages = useMemo(
    () => onDemandState.scopeKey === annotationScopeKey ? onDemandState.pages : {},
    [annotationScopeKey, onDemandState],
  )
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
    {
      ...planningUpdateQueryConfig,
      onError: () => {
        setOnDemandState((current) => current.scopeKey === annotationScopeKey
          ? { scopeKey: current.scopeKey, pages: {} }
          : current)
      },
      onSuccess: () => {
        setOnDemandState((current) => current.scopeKey === annotationScopeKey
          ? { scopeKey: current.scopeKey, pages: {} }
          : current)
      },
    },
  )
  const visibleOnDemandPages = query.isValidating
    ? emptyPlanningUpdateAnnotationPages
    : onDemandPages
  const data = useMemo(() => {
    const pages = [
      ...(query.data ? [query.data] : []),
      ...Object.values(visibleOnDemandPages),
    ]
    return {
      comments: deduplicatePlanningUpdateComments(pages.flatMap((page) => page.comments)),
      reactions: deduplicatePlanningUpdateReactions(pages.flatMap((page) => page.reactions)),
    }
  }, [query.data, visibleOnDemandPages])
  const loadVersion = async (updateVersion: number) => {
    if (!accessToken || !target) return undefined
    invalidatePlanningUpdateAnnotationPageCache(accessToken, target, [updateVersion])
    const page = await loadCachedPlanningUpdateAnnotationPage(
      accessToken,
      target,
      updateVersion,
    )
    setOnDemandState((current) => ({
      scopeKey: annotationScopeKey,
      pages: {
        ...(current.scopeKey === annotationScopeKey ? current.pages : {}),
        [updateVersion]: page,
      },
    }))
    return page
  }

  return {
    ...query,
    data: (query.data || Object.keys(visibleOnDemandPages).length > 0) ? data : query.data,
    loadVersion,
    mutate: () => {
      if (accessToken && target) {
        invalidatePlanningUpdateAnnotationPageCache(
          accessToken,
          target,
          [...updateVersions, ...Object.keys(visibleOnDemandPages).map(Number)],
        )
      }
      return query.mutate()
    },
    key,
  }
}

/**
 * Removes duplicate comment rows while preserving comments from different immutable versions.
 *
 * @param comments - Annotation rows collected from eager and on-demand pages.
 * @returns Comments deduplicated by immutable update version and comment ID.
 */
export function deduplicatePlanningUpdateComments(
  comments: readonly PlanningUpdateComment[],
): PlanningUpdateComment[] {
  return [...new Map(comments.map((comment) => [
    `${comment.updateVersion}\0${comment.id}`,
    comment,
  ])).values()]
}

/** Removes duplicate reaction rows when eager and on-demand pages overlap. */
function deduplicatePlanningUpdateReactions(
  reactions: readonly PlanningUpdateReaction[],
): PlanningUpdateReaction[] {
  return [...new Map(reactions.map((reaction) => [
    `${reaction.updateVersion}\0${reaction.memberKey}\0${reaction.emoji}`,
    reaction,
  ])).values()]
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
 * @returns Flattened annotations for at most twenty update versions.
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
          loadAllPlanningUpdateAnnotationItems((cursor) =>
            loadComments(accessToken, {
              limit: planningUpdateAnnotationPageSize,
              target,
              updateVersion,
              ...(cursor ? { cursor } : {}),
            }).then((page) => ({
              items: page.comments,
              nextCursor: page.nextCursor,
            }))
          ),
          loadAllPlanningUpdateAnnotationItems((cursor) =>
            loadReactions(accessToken, {
              limit: planningUpdateAnnotationPageSize,
              target,
              updateVersion,
              ...(cursor ? { cursor } : {}),
            }).then((page) => ({
              items: page.reactions,
              nextCursor: page.nextCursor,
            }))
          ),
        ])
        return {
          comments,
          reactions,
        }
      }),
  )
  return {
    comments: pages.flatMap((page) => page.comments),
    reactions: pages.flatMap((page) => page.reactions),
  }
}

/**
 * Finds the current member's reaction while following every reaction page.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Planning update target.
 * @param updateVersion - Immutable update version to inspect.
 * @param memberKey - Current member key used for the viewer reaction lookup.
 * @param emoji - Reaction token to match.
 * @param loadReactions - Reaction page loader overridden by focused tests.
 * @returns Whether the current member already has the requested reaction.
 */
export async function hasPlanningUpdateViewerReaction(
  accessToken: string,
  target: PlanningUpdateTarget,
  updateVersion: number,
  memberKey: string,
  emoji: string,
  loadReactions: typeof listPlanningUpdateReactions = listPlanningUpdateReactions,
): Promise<boolean> {
  const normalizedMemberKey = memberKey.trim().toLowerCase()
  let cursor: string | undefined
  do {
    const page = await loadReactions(accessToken, {
      limit: planningUpdateAnnotationPageSize,
      target,
      updateVersion,
      ...(cursor ? { cursor } : {}),
    })
    if (page.reactions.some((reaction) =>
      reaction.updateVersion === updateVersion &&
      reaction.emoji === emoji &&
      reaction.memberKey.trim().toLowerCase() === normalizedMemberKey
    )) {
      return true
    }
    cursor = page.nextCursor
  } while (cursor)
  return false
}

/**
 * Loads the bounded annotation preview while reusing one cache entry per target/version.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Planning update target.
 * @param updateVersions - Immutable update versions ordered newest first.
 * @returns Flattened annotations for the newest distinct versions.
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
 * Loads all annotation pages and shares a bounded in-flight request by target/version.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Planning update target.
 * @param updateVersion - Immutable update version.
 * @returns All comments and reactions for the selected version.
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
  while (planningUpdateAnnotationPageCache.size >= planningUpdateAnnotationInFlightCacheLimit) {
    const oldestKey = planningUpdateAnnotationPageCache.keys().next().value
    if (oldestKey === undefined) break
    planningUpdateAnnotationPageCache.delete(oldestKey)
  }
  const request = Promise.all([
    loadAllPlanningUpdateAnnotationItems((cursor) =>
      listPlanningUpdateComments(accessToken, {
        limit: planningUpdateAnnotationPageSize,
        target,
        updateVersion,
        ...(cursor ? { cursor } : {}),
      }).then((page) => ({
        items: page.comments,
        nextCursor: page.nextCursor,
      }))
    ),
    loadAllPlanningUpdateAnnotationItems((cursor) =>
      listPlanningUpdateReactions(accessToken, {
        limit: planningUpdateAnnotationPageSize,
        target,
        updateVersion,
        ...(cursor ? { cursor } : {}),
      }).then((page) => ({
        items: page.reactions,
        nextCursor: page.nextCursor,
      }))
    ),
  ]).then(([comments, reactions]) => ({
    comments,
    reactions,
  }))
  planningUpdateAnnotationPageCache.set(cacheKey, request)
  void request.then(
    () => {
      if (planningUpdateAnnotationPageCache.get(cacheKey) === request) {
        planningUpdateAnnotationPageCache.delete(cacheKey)
      }
    },
    () => {
      if (planningUpdateAnnotationPageCache.get(cacheKey) === request) {
        planningUpdateAnnotationPageCache.delete(cacheKey)
      }
    },
  )
  return request
}

/**
 * Follows an annotation endpoint's opaque cursor until the collection is exhausted.
 *
 * @param loadPage - Loader for one page, given the cursor from the previous page.
 * @returns All annotation rows returned by the cursor sequence.
 */
async function loadAllPlanningUpdateAnnotationItems<Item>(
  loadPage: (cursor?: string) => Promise<PlanningUpdateAnnotationItemPage<Item>>,
): Promise<Item[]> {
  const items: Item[] = []
  const visitedCursors = new Set<string>()
  let cursor: string | undefined
  while (true) {
    const page = await loadPage(cursor)
    items.push(...page.items)
    if (!page.nextCursor) return items
    if (visitedCursors.has(page.nextCursor)) {
      throw new Error('Planning update annotation pagination repeated a cursor.')
    }
    visitedCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
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
  return `${accessToken}\n${createPlanningUpdateTargetKey(target)}\n${updateVersion}`
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
