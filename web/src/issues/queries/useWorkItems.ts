import type { WorkspaceWorkItemListFilter } from '@mukuroji/contracts'
import useSWR, { useSWRConfig } from 'swr'
import type { Arguments, KeyedMutator, MutatorCallback, MutatorOptions } from 'swr'
import { useMemo } from 'react'
import {
  getTeamIssueDetail,
  getWorkspaceWorkItemSummary,
} from '../api/workItems'
import { TeamIssuesApiError } from '../api/errors'
import {
  loadProjectIssues,
  loadTeamIssues,
  type ProjectIssueList as ProjectIssuesPage,
  type ProjectIssueScheduleWindow,
} from './scopedWorkItemLoader'
import { loadWorkspaceWorkItems } from './workspaceWorkItemLoader'

/** Project issue list exposed to existing optimistic cache mutations. */
type ProjectIssueList = ProjectIssuesPage['issues']

/** Rebuilds a Project response while preserving its resource capability. */
function createProjectIssuesPage(
  projectId: string | undefined,
  issues: ProjectIssueList | undefined,
  current?: ProjectIssuesPage,
): ProjectIssuesPage | undefined {
  if (issues === undefined) return undefined
  return {
    projectId: current?.projectId ?? projectId ?? '',
    issues,
    ...(current?.canReadCustomerImpact === undefined
      ? {}
      : { canReadCustomerImpact: current.canReadCustomerImpact }),
  }
}

const workItemQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/** Returns whether a failed detail revalidation may safely retain validated cached data. */
function isTransientIssueDetailError(error: unknown): boolean {
  if (error instanceof TeamIssuesApiError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600)
  }
  return error instanceof TypeError
}

/**
 * Team の Work Item 一覧を取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param teamId - 取得対象の Team ID です。
 * @param enabled - Query を実行するかどうかです。
 * @param includeArchived - Whether the Team query includes archived Work Items.
 * @param scope - 同じTeam一覧を異なる用途で分離するSWR key scopeです。
 * @returns Team Work Item 一覧の SWR state です。
 */
export function useTeamIssues(
  accessToken: string | undefined,
  teamId: string | undefined,
  enabled = true,
  includeArchived = false,
  scope = 'team-issues',
) {
  const key = accessToken && teamId && enabled
    ? [scope, accessToken, teamId, includeArchived] as const
    : null

  const query = useSWR(
    key,
    ([, token, currentTeamId, shouldIncludeArchived]) =>
      loadTeamIssues(currentTeamId, token, shouldIncludeArchived),
    workItemQueryConfig,
  )

  return { ...query, key }
}

/**
 * Project に割り当てられた Work Item 一覧を取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param projectId - 取得対象の Project ID です。
 * @param enabled - Query を実行するかどうかです。
 * @param includeArchived - Whether the Project query includes archived Work Items.
 * @param selectedTeamId - Optional Team identity from the routed Work Item.
 * @param selectedIssueId - Optional Work Item identity from the route.
 * @param scheduleWindow - Optional visible calendar or Gantt period. When set, only the Work
 *   Items touching it and the unscheduled Work Items are read. The routed Work Item is still
 *   added from its detail when it lies outside the period.
 * @returns Project Work Item 一覧の SWR state です。
 */
export function useProjectIssues(
  accessToken: string | undefined,
  projectId: string | undefined,
  enabled = true,
  includeArchived = false,
  selectedTeamId?: string,
  selectedIssueId?: string,
  scheduleWindow?: ProjectIssueScheduleWindow,
) {
  const key = accessToken && projectId && enabled
    ? createProjectIssuesKey(accessToken, projectId, includeArchived, scheduleWindow)
    : null

  // Moving to another period or layout keeps the previous list on screen while the next one
  // loads, so the page does not fall back to its loading state and unmount open forms.
  const query = useSWR(
    key,
    ([, token, currentProjectId, shouldIncludeArchived, from, to]) =>
      loadProjectIssues(
        currentProjectId,
        token,
        shouldIncludeArchived,
        from !== null && to !== null ? { from, to } : undefined,
      ),
    { ...workItemQueryConfig, keepPreviousData: true },
  )
  const { mutate: mutateCache } = useSWRConfig()
  // The previous list is kept only for the same Project, never shown for another one.
  const listData = query.data?.projectId === projectId ? query.data : undefined

  const selectedDetailQuery = useTeamIssueDetail(
    accessToken,
    selectedTeamId,
    selectedIssueId,
    enabled && Boolean(selectedTeamId && selectedIssueId),
    'project-issue-detail',
  )
  const selectedDetailIssue = selectedDetailQuery.error && !isTransientIssueDetailError(selectedDetailQuery.error)
    ? undefined
    : selectedDetailQuery.data?.issue
  const reconciledIssues = useMemo(() => {
    const issues = listData?.issues
    if (!issues || !selectedTeamId || !selectedIssueId || !selectedDetailIssue) {
      return issues
    }

    const selectedIssueIndex = issues.findIndex((issue) =>
      issue.teamId === selectedTeamId && issue.id === selectedIssueId,
    )

    if (
      selectedDetailIssue.teamId !== selectedTeamId ||
      selectedDetailIssue.id !== selectedIssueId ||
      selectedDetailIssue.assignedProjectId !== projectId ||
      (!includeArchived && selectedDetailIssue.archivedAt !== undefined)
    ) {
      return issues
    }

    if (selectedIssueIndex < 0) {
      return [...issues, selectedDetailIssue]
    }

    const existingIssue = issues[selectedIssueIndex]
    if (!existingIssue || selectedDetailIssue.revision <= existingIssue.revision) {
      return issues
    }

    const reconciled = [...issues]
    reconciled[selectedIssueIndex] = selectedDetailIssue
    return reconciled
  }, [
    includeArchived,
    projectId,
    listData?.issues,
    selectedDetailIssue,
    selectedIssueId,
    selectedTeamId,
  ])

  /** Adapts the response-shaped SWR cache back to the legacy issue-list mutator. */
  const mutateProjectIssues: KeyedMutator<ProjectIssueList> = async <MutationData = ProjectIssueList>(
    data?: ProjectIssueList | Promise<ProjectIssueList | undefined> | MutatorCallback<ProjectIssueList>,
    options?: boolean | MutatorOptions<ProjectIssueList, MutationData>,
  ): Promise<ProjectIssueList | MutationData | undefined> => {
    const responseData = data === undefined
      ? undefined
      : typeof data === 'function'
        ? async (current?: ProjectIssuesPage) => createProjectIssuesPage(projectId, await data(current?.issues), current)
        : data instanceof Promise
          ? async (current?: ProjectIssuesPage) => createProjectIssuesPage(projectId, await data, current)
          : async (current?: ProjectIssuesPage) => createProjectIssuesPage(projectId, data, current)
    const revalidate = options === undefined || typeof options === 'boolean' ? undefined : options.revalidate
    const responseOptions = options === undefined || typeof options === 'boolean'
      ? options
      : revalidate === undefined
        ? undefined
        : {
            revalidate: typeof revalidate === 'function'
              ? (current: ProjectIssuesPage, key: Arguments) => revalidate(current.issues, key)
              : revalidate,
          }
    // SWR treats an explicit `undefined` data argument as a cache replacement,
    // so preserve the no-argument revalidation semantics used by callers.
    const response = data === undefined && options === undefined
      ? await query.mutate()
      : await query.mutate(responseData, responseOptions)
    // The same Project is also cached for the whole list and other calendar or Gantt periods.
    // Revalidating them clears their request deduplication, so the next layout reads fresh data.
    void mutateCache((candidate: unknown) =>
      isOtherProjectIssueListKey(candidate, key)
    )
    return response?.issues
  }

  /**
   * Publishes a list to the cache of the period it was read for, not the current period.
   *
   * @param readWindow - Period the list was read for, or `undefined` for the whole Project.
   * @param issues - Refreshed Work Items of that period.
   * @returns The cache update.
   */
  const publishProjectIssues = (
    readWindow: ProjectIssueScheduleWindow | undefined,
    issues: ProjectIssueList,
  ) => {
    if (!accessToken || !projectId) return Promise.resolve(undefined)
    return mutateCache(
      createProjectIssuesKey(accessToken, projectId, includeArchived, readWindow),
      (current?: ProjectIssuesPage) => createProjectIssuesPage(projectId, issues, current),
      { revalidate: false },
    )
  }

  return {
    ...query,
    data: reconciledIssues,
    // The previous list stays visible while another period loads; only a first load is loading.
    isLoading: Boolean(key) && listData === undefined && query.error === undefined,
    canReadCustomerImpact: listData?.canReadCustomerImpact === true,
    mutate: mutateProjectIssues,
    publishIssues: publishProjectIssues,
    key,
  }
}

/**
 * Finds the Work Items that an `issueId` link without `teamId` can mean, outside of any list.
 *
 * A calendar or Gantt list holds only its visible period, so it cannot tell which Team owns a
 * routed Work Item outside that period, or whether two Teams use the same local ID. Each Team
 * that has the Project is asked for the ID directly; a Work Item counts when it is assigned to
 * the Project. A missing or unreadable Work Item of one Team is not a match.
 *
 * @param accessToken - Work Item API access token.
 * @param projectId - Project the link points into.
 * @param issueId - Team-local Work Item ID from the link.
 * @param teamIds - Teams that have the Project.
 * @param enabled - Whether the lookup runs, normally only for a windowed list.
 * @returns SWR state whose data lists every matching Work Item.
 */
export function useProjectIssueLinkCandidates(
  accessToken: string | undefined,
  projectId: string | undefined,
  issueId: string | undefined,
  teamIds: readonly string[],
  enabled: boolean,
) {
  const key = accessToken && projectId && issueId && enabled && teamIds.length > 0
    ? ['project-issue-link-candidates', accessToken, projectId, issueId, ...teamIds] as const
    : null
  return useSWR(
    key,
    async ([, token, currentProjectId, currentIssueId, ...candidateTeamIds]) => {
      const issues = await Promise.all(candidateTeamIds.map(async (teamId) => {
        try {
          return (await getTeamIssueDetail(teamId, currentIssueId, token)).issue
        } catch (error) {
          if (error instanceof TeamIssuesApiError && (error.status === 403 || error.status === 404)) {
            return undefined
          }
          throw error
        }
      }))
      return issues.filter((issue): issue is NonNullable<typeof issue> =>
        issue !== undefined && issue.assignedProjectId === currentProjectId
      )
    },
    workItemQueryConfig,
  )
}

/**
 * Creates the SWR key of one Project Work Item list.
 *
 * @param accessToken - Work Item API access token.
 * @param projectId - Project whose Work Items are listed.
 * @param includeArchived - Whether archived Work Items are included.
 * @param scheduleWindow - Optional visible calendar or Gantt period.
 * @returns The cache key, distinct per archive option and period.
 */
function createProjectIssuesKey(
  accessToken: string,
  projectId: string,
  includeArchived: boolean,
  scheduleWindow: ProjectIssueScheduleWindow | undefined,
) {
  return [
    'project-issues',
    accessToken,
    projectId,
    includeArchived,
    scheduleWindow?.from ?? null,
    scheduleWindow?.to ?? null,
  ] as const
}

/**
 * Decides whether a cache key is another list of the same Project as `currentKey`.
 *
 * @param candidate - Cache key supplied by the global mutator.
 * @param currentKey - Key of the Project list that was changed.
 * @returns Whether the candidate caches the same Project for another archive option or period.
 */
function isOtherProjectIssueListKey(
  candidate: unknown,
  currentKey: readonly unknown[] | null,
): boolean {
  if (!currentKey || !Array.isArray(candidate) || candidate[0] !== 'project-issues') return false
  return candidate[1] === currentKey[1] &&
    candidate[2] === currentKey[2] &&
    candidate.some((part, index) => part !== currentKey[index])
}

/**
 * Workspace 横断の Work Item 投影を server 側の filter で絞って取得します。
 *
 * 全件ではなく、画面に必要な範囲（自分の担当、1 Team など）だけを cursor で読み切ります。
 *
 * @param accessToken - Work Item API の access token です。
 * @param enabled - Query を実行するかどうかです。
 * @param includeArchived - Whether the Workspace query includes archived Work Items.
 * @param filter - Server-side filter. Omitting it reads every visible Work Item.
 * @returns Workspace Work Item 一覧の SWR state です。
 */
export function useWorkspaceWorkItems(
  accessToken?: string,
  enabled = true,
  includeArchived = false,
  filter: WorkspaceWorkItemListFilter = {},
) {
  const filterKey = createWorkspaceWorkItemFilterKey(filter)
  const key = accessToken && enabled
    ? ['workspace-work-items', accessToken, includeArchived, filterKey] as const
    : null

  const query = useSWR(
    key,
    ([, token, shouldIncludeArchived]) =>
      loadWorkspaceWorkItems(token, shouldIncludeArchived, filter),
    workItemQueryConfig,
  )

  return { ...query, key }
}

/**
 * Workspace の Work Item 件数を Team と Project ごとに server で集計して取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Work Item summary の SWR state です。
 */
export function useWorkspaceWorkItemSummary(
  accessToken?: string,
  enabled = true,
) {
  const key = accessToken && enabled
    ? ['workspace-work-item-summary', accessToken] as const
    : null

  const query = useSWR(
    key,
    ([, token]) => getWorkspaceWorkItemSummary(token),
    workItemQueryConfig,
  )

  return { ...query, key }
}

/**
 * Serializes a Workspace Work Item filter into a stable SWR key segment.
 *
 * @param filter - Server-side filter.
 * @returns A string that is equal for equal filters.
 */
function createWorkspaceWorkItemFilterKey(filter: WorkspaceWorkItemListFilter) {
  return JSON.stringify([
    filter.involvement ?? null,
    filter.teamId ?? null,
    filter.projectId ?? null,
    [...(filter.statusCategories ?? [])].sort(),
    filter.openOnly === true,
  ])
}

/**
 * Team Work Item の詳細を取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param teamId - Work Item を所有する Team ID です。
 * @param issueId - 取得対象の Work Item ID です。
 * @param enabled - Query を実行するかどうかです。
 * @param scope - 詳細queryを利用画面ごとに分離するSWR key scopeです。
 * @returns Work Item 詳細の SWR state です。
 */
export function useTeamIssueDetail(
  accessToken: string | undefined,
  teamId: string | undefined,
  issueId: string | undefined,
  enabled = true,
  scope = 'team-issue-detail',
) {
  const key = accessToken && teamId && issueId && enabled
    ? [scope, accessToken, teamId, issueId] as const
    : null

  const query = useSWR(
    key,
    ([, token, currentTeamId, currentIssueId]) =>
      getTeamIssueDetail(currentTeamId, currentIssueId, token),
    workItemQueryConfig,
  )

  return { ...query, key }
}
