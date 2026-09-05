import useSWR from 'swr'
import type { Arguments, KeyedMutator, MutatorCallback, MutatorOptions } from 'swr'
import {
  getProjectIssuesPage,
  getTeamIssueDetail,
  getTeamIssues,
  getWorkspaceWorkItems,
} from '../api/workItems'

/** Complete Project issue response stored in the SWR cache. */
type ProjectIssuesPage = Awaited<ReturnType<typeof getProjectIssuesPage>>

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

/**
 * Loads a Project Work Item page and reconciles one explicitly routed Work Item
 * when a successful Project list response does not contain that exact identity.
 *
 * @param projectId - Project whose assigned Work Items should be loaded.
 * @param accessToken - Bearer token used by both canonical Work Item requests.
 * @param includeArchived - Whether archived Work Items should be included.
 * @param selectedTeamId - Team identity from the routed Work Item, when present.
 * @param selectedIssueId - Work Item identity from the route, when present.
 * @returns The Project page, optionally including the exact routed Work Item.
 */
async function fetchProjectIssuesPage(
  projectId: string,
  accessToken: string,
  includeArchived: boolean,
  selectedTeamId?: string,
  selectedIssueId?: string,
): Promise<ProjectIssuesPage> {
  const response = await getProjectIssuesPage(projectId, accessToken, includeArchived)
  if (!selectedTeamId || !selectedIssueId) return response

  const hasSelectedIssue = response.issues.some((issue) =>
    issue.teamId === selectedTeamId && issue.id === selectedIssueId,
  )
  if (hasSelectedIssue) return response

  const detail = await getTeamIssueDetail(selectedTeamId, selectedIssueId, accessToken)
  const selectedIssue = detail.issue
  if (
    selectedIssue.teamId !== selectedTeamId ||
    selectedIssue.id !== selectedIssueId ||
    selectedIssue.assignedProjectId !== projectId ||
    (!includeArchived && selectedIssue.archivedAt !== undefined)
  ) {
    return response
  }

  return {
    ...response,
    issues: [...response.issues, selectedIssue],
  }
}

const workItemQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

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
      getTeamIssues(currentTeamId, token, shouldIncludeArchived),
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
 * @returns Project Work Item 一覧の SWR state です。
 */
export function useProjectIssues(
  accessToken: string | undefined,
  projectId: string | undefined,
  enabled = true,
  includeArchived = false,
  selectedTeamId?: string,
  selectedIssueId?: string,
) {
  const key = accessToken && projectId && enabled
    ? ['project-issues', accessToken, projectId, includeArchived] as const
    : null

  const query = useSWR(
    key,
    ([, token, currentProjectId, shouldIncludeArchived]) =>
      fetchProjectIssuesPage(
        currentProjectId,
        token,
        shouldIncludeArchived,
        selectedTeamId,
        selectedIssueId,
      ),
    workItemQueryConfig,
  )

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
    return response?.issues
  }

  return {
    ...query,
    data: query.data?.issues,
    canReadCustomerImpact: query.data?.canReadCustomerImpact === true,
    mutate: mutateProjectIssues,
    key,
  }
}

/**
 * Workspace 全体の Work Item 投影を取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param enabled - Query を実行するかどうかです。
 * @param includeArchived - Whether the Workspace query includes archived Work Items.
 * @returns Workspace Work Item 一覧の SWR state です。
 */
export function useWorkspaceWorkItems(
  accessToken?: string,
  enabled = true,
  includeArchived = false,
) {
  const key = accessToken && enabled
    ? ['workspace-work-items', accessToken, includeArchived] as const
    : null

  const query = useSWR(
    key,
    ([, token, shouldIncludeArchived]) =>
      getWorkspaceWorkItems(token, shouldIncludeArchived),
    workItemQueryConfig,
  )

  return { ...query, key }
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
