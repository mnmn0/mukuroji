import useSWR, { type KeyedMutator } from 'swr'
import type { PlanningReadScope, PlanningSnapshot } from '@mukuroji/contracts'
import { getPlanningSnapshot } from '../api/snapshot'

const planningQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Workspace planning snapshot を取得します。
 *
 * @param accessToken - Planning API の access token です。
 * @param enabled - Current user の確認後に取得を有効にするかどうかです。
 * @param readScope - 指定すると、その Team / Project / Portfolio だけを読みます。
 * @returns Planning snapshot の SWR state です。
 */
export function usePlanningSnapshot(
  accessToken?: string,
  enabled = true,
  readScope?: PlanningReadScope,
) {
  const key = accessToken && enabled
    ? readScope === undefined
      ? ['planning-snapshot', accessToken] as const
      : ['planning-snapshot', accessToken, createPlanningReadScopeKey(readScope)] as const
    : null

  const query = useSWR(
    key,
    ([, token]: readonly [string, string, ...string[]]) => getPlanningSnapshot(token, readScope),
    planningQueryConfig,
  )

  /**
   * Updates the cached snapshot. A snapshot that a mutation returned carries no viewer Team
   * grants, and a mutation does not change them, so the cached grants are kept (ADR 0123).
   *
   * @param data - New snapshot, a promise of one, or an updater; undefined revalidates.
   * @param options - SWR mutate options, or whether to revalidate.
   * @returns The cached snapshot after the update.
   */
  const mutate: KeyedMutator<PlanningSnapshot> = (data, options) => data === undefined || typeof data === 'function' || data instanceof Promise
    ? query.mutate(data, options)
    : query.mutate((current) => keepViewerTeamGrants(data, current), options)

  return {
    ...query,
    mutate,
    key,
  }
}

/**
 * Keeps the viewer Team grants of the cached snapshot when the new one has none.
 *
 * @param next - Snapshot to cache.
 * @param current - Snapshot in the cache.
 * @returns The snapshot to cache.
 */
export function keepViewerTeamGrants(next: PlanningSnapshot, current: PlanningSnapshot | undefined): PlanningSnapshot {
  return next.viewerTeamGrants !== undefined || current?.viewerTeamGrants === undefined
    ? next
    : { ...next, viewerTeamGrants: current.viewerTeamGrants }
}

/**
 * Creates a stable cache key segment for a read scope.
 *
 * @param readScope - Team, Project, or Portfolio to read.
 * @returns Identifier-safe key segment.
 */
function createPlanningReadScopeKey(readScope: PlanningReadScope) {
  if (readScope.type === 'portfolio') return `portfolio:${encodeURIComponent(readScope.portfolioId)}`
  const team = `team:${encodeURIComponent(readScope.teamId)}`
  return readScope.type === 'team'
    ? team
    : `${team}:project:${encodeURIComponent(readScope.projectId)}`
}
