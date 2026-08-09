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
  const updateVersions = updates?.map((update) => update.version) ?? []
  const versionsKey = updateVersions.join(',')
  const key = accessToken && target && targetKey && updateVersions.length > 0 && enabled
    ? ['planning-update-annotations', accessToken, targetKey, versionsKey]
    : null
  const query = useSWR(
    key,
    async (): Promise<PlanningUpdateAnnotations | undefined> => {
      if (!target || !accessToken) return undefined
      const pages = await Promise.all(updateVersions.map(async (updateVersion) => {
        const [comments, reactions] = await Promise.all([
          listAllPlanningUpdateComments(accessToken, target, updateVersion),
          listAllPlanningUpdateReactions(accessToken, target, updateVersion),
        ])
        return {
          comments,
          reactions,
        }
      }))
      return {
        comments: pages.flatMap((page) => page.comments),
        reactions: pages.flatMap((page) => page.reactions),
      }
    },
    planningUpdateQueryConfig,
  )

  return {
    ...query,
    key,
  }
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
 * Loads every append-only comment page for one visible immutable update version.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Planning update target.
 * @param updateVersion - Immutable update version.
 * @returns All visible comments ordered by the server's page order.
 */
async function listAllPlanningUpdateComments(
  accessToken: string,
  target: PlanningUpdateTarget,
  updateVersion: number,
) {
  const comments: PlanningUpdateComment[] = []
  let cursor: string | undefined
  const visitedCursors = new Set<string>()
  do {
    const page = await listPlanningUpdateComments(accessToken, {
      cursor,
      limit: 100,
      target,
      updateVersion,
    })
    comments.push(...page.comments)
    cursor = resolveNextPlanningAnnotationCursor(page.nextCursor, visitedCursors)
  } while (cursor)
  return comments
}

/**
 * Loads every member-reaction page for one visible immutable update version.
 *
 * @param accessToken - Planning API access token.
 * @param target - Selected Planning update target.
 * @param updateVersion - Immutable update version.
 * @returns All visible member reactions ordered by the server's page order.
 */
async function listAllPlanningUpdateReactions(
  accessToken: string,
  target: PlanningUpdateTarget,
  updateVersion: number,
) {
  const reactions: PlanningUpdateReaction[] = []
  let cursor: string | undefined
  const visitedCursors = new Set<string>()
  do {
    const page = await listPlanningUpdateReactions(accessToken, {
      cursor,
      limit: 100,
      target,
      updateVersion,
    })
    reactions.push(...page.reactions)
    cursor = resolveNextPlanningAnnotationCursor(page.nextCursor, visitedCursors)
  } while (cursor)
  return reactions
}

/**
 * Rejects a repeated opaque annotation cursor to prevent an accidental infinite request loop.
 *
 * @param nextCursor - Opaque cursor returned by the server.
 * @param visitedCursors - Cursors already used for the current version and annotation type.
 * @returns A new cursor, or undefined when pagination is complete.
 */
function resolveNextPlanningAnnotationCursor(
  nextCursor: string | undefined,
  visitedCursors: Set<string>,
) {
  if (!nextCursor) return undefined
  if (visitedCursors.has(nextCursor)) {
    throw new Error('Planning annotation pagination returned a repeated cursor.')
  }
  visitedCursors.add(nextCursor)
  return nextCursor
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
