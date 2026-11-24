import useSWR from 'swr'
import type { PlanningReadScope } from '@mukuroji/contracts'
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

  return {
    ...query,
    key,
  }
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
