import type {
  CanonicalWorkItem,
  ConfirmWorkItemScheduleChangeInput,
  CreateWorkItemInput,
  CustomerImpactSignal,
  PreviewWorkItemScheduleInput,
  PreviewWorkItemTypeChangeInput,
  ResolvedWorkItemConfiguration,
  UpdateWorkItemInput,
  WorkItemPatch,
  WorkItemRelation,
  WorkItemTriageContextSnapshot,
  WorkItemTypeChangePreview,
  WorkItemSummaryResponse,
  WorkspaceWorkItemListFilter,
  WorkspaceWorkItemPage,
} from '@mukuroji/contracts'
import { WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import {
  isConfirmWorkItemScheduleChangeResponse,
  readWorkItemScheduleChangePreviewForEndpoint,
  isWorkItemTypeChangePreview,
} from '../../work-items/api/contractValidation'
import type { TeamIssueActivity } from './activity'
import { TeamIssuesApiError } from './errors'
import {
  defaultIssuesApiErrorMessage,
  readApiError,
  readJson,
} from './http'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'

/**
 * チーム所有の canonical Issue です。
 */
export type TeamIssue = CanonicalWorkItem

/**
 * チーム所有 Issue の詳細レスポンスです。
 */
export type TeamIssueDetail = {
  /**
   * Issue 本体です。
   */
  issue: TeamIssue
  /**
   * Issue 活動履歴一覧です。
   */
  activity: TeamIssueActivity[]
  /** De-identified duplicate-source context retained with the canonical Work Item. */
  triageContextSnapshots?: WorkItemTriageContextSnapshot[]
  /**
   * Work Item に適用される Team / Workspace workflow configuration です。
   */
  resolvedConfiguration?: ResolvedWorkItemConfiguration
  /**
   * Work Item から見た reciprocal relation 一覧です。
   */
  relations?: WorkItemRelation[]
  /**
   * Relation mutation の optimistic concurrency に使う Team graph revision です。
   */
  relationGraphRevision?: number
  /** Customer Requests aggregated onto this Work Item. */
  customerImpact?: CustomerImpactSignal
}

/**
 * チーム所有 Issue 作成 UI の互換名で参照する canonical Work Item 入力です。
 */
export type CreateTeamIssueInput = CreateWorkItemInput

/**
 * 画面で編集する Work Item patch です。API 呼び出し時に expectedRevision を付与します。
 */
export type UpdateTeamIssueInput = WorkItemPatch

/**
 * optimistic concurrency を伴う Work Item 更新 request です。
 */
export type UpdateTeamIssueRequest = UpdateWorkItemInput

/**
 * Lambda が DynamoDB から取得して返すチーム Issue 一覧レスポンスです。
 */
type TeamIssuesResponse = {
  /**
   * 取得対象の team ID です。
   */
  teamId: string
  /**
   * チーム所有 Issue 一覧です。
   */
  issues: TeamIssue[]
}

/**
 * Lambda が DynamoDB から取得して返すプロジェクト Issue 一覧レスポンスです。
 */
type ProjectIssuesResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * プロジェクトにアサインされた Issue 一覧です。
   */
  issues: TeamIssue[]
  /** Whether Customer impact may be requested for this Project resource. */
  canReadCustomerImpact?: boolean
}

/**
 * Largest number of pages one complete Workspace Work Item read follows.
 *
 * With the maximum page size this allows 10,000 Work Items; beyond that the read fails
 * with `WorkItemListLimitExceeded` instead of showing a silently truncated list.
 */
const WORKSPACE_WORK_ITEM_MAX_PAGES = 50

/**
 * Issue 作成 API が返す response body です。
 */
type CreateTeamIssueResponse = {
  /**
   * 作成された Issue 行です。
   */
  issue: TeamIssue
}

/**
 * Issue 更新 API が返す response body です。
 */
type UpdateTeamIssueResponse = {
  /**
   * 更新された Issue 行です。
   */
  issue: TeamIssue
}

const issuesApiBaseUrl = resolveApiBaseUrl()

/**
 * Loads Team-owned Work Items through the canonical list endpoint.
 *
 * @param teamId - Team whose Work Items should be loaded.
 * @param accessToken - Optional bearer token for the Work Item API.
 * @param includeArchived - Whether archived Work Items should be included.
 * @returns Team-owned Work Items visible to the current viewer.
 */
export async function getTeamIssues(
  teamId: string,
  accessToken?: string,
  includeArchived = false,
) {
  const response = await requestJson<TeamIssuesResponse>(
    createWorkItemListUrl(
      `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues`,
      includeArchived,
    ),
    accessToken,
  )

  return response.issues
}

/**
 * Loads Work Items assigned to one Project through the canonical list endpoint.
 *
 * @param projectId - Project whose assigned Work Items should be loaded.
 * @param accessToken - Optional bearer token for the Work Item API.
 * @param includeArchived - Whether archived Work Items should be included.
 * @returns Project-assigned Work Items visible to the current viewer.
 */
export async function getProjectIssues(
  projectId: string,
  accessToken?: string,
  includeArchived = false,
) {
  const response = await getProjectIssuesPage(projectId, accessToken, includeArchived)
  return response.issues
}

/**
 * Loads a Project Work Item page together with its resource-scoped Customer capability.
 *
 * @param projectId - Project whose assigned Work Items should be loaded.
 * @param accessToken - Optional bearer token for the Work Item API.
 * @param includeArchived - Whether archived Work Items should be included.
 * @returns Project-assigned Work Items and the Customer impact capability.
 */
export async function getProjectIssuesPage(
  projectId: string,
  accessToken?: string,
  includeArchived = false,
): Promise<ProjectIssuesResponse> {
  const response = await requestJson<ProjectIssuesResponse>(
    createWorkItemListUrl(
      `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/issues`,
      includeArchived,
    ),
    accessToken,
  )

  return response
}

/** Options of one Workspace Work Item page request. */
export type WorkspaceWorkItemPageRequest = {
  /** Whether archived Work Items should be included. */
  includeArchived?: boolean
  /** Server-side filter that narrows the Work Items the viewer can read. */
  filter?: WorkspaceWorkItemListFilter
  /** Page size, up to the contract maximum. */
  limit?: number
  /** Cursor returned by the previous page. */
  cursor?: string
}

/**
 * Loads one page of the Workspace-wide Work Item projection.
 *
 * @param accessToken - Bearer token for the Work Item API.
 * @param request - Filter, archive option, page size, and cursor.
 * @returns The page and the cursor of the next one.
 */
export async function getWorkspaceWorkItemPage(
  accessToken: string,
  request: WorkspaceWorkItemPageRequest = {},
) {
  return requestJson<WorkspaceWorkItemPage<TeamIssue>>(
    createWorkspaceWorkItemPageUrl(request),
    accessToken,
  )
}

/**
 * Loads every Workspace Work Item that matches the filter by following page cursors.
 *
 * @param accessToken - Bearer token for the Work Item API.
 * @param includeArchived - Whether archived Work Items should be included.
 * @param filter - Server-side filter, such as `involvement: 'mine'` or a Team ID.
 * @returns Matching Work Items visible to the current viewer, including unassigned items.
 */
export async function getWorkspaceWorkItems(
  accessToken: string,
  includeArchived = false,
  filter: WorkspaceWorkItemListFilter = {},
) {
  const workItems: TeamIssue[] = []
  let cursor: string | undefined

  for (let page = 0; page < WORKSPACE_WORK_ITEM_MAX_PAGES; page += 1) {
    const response = await getWorkspaceWorkItemPage(accessToken, {
      includeArchived,
      filter,
      limit: WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT,
      ...(cursor ? { cursor } : {}),
    })
    workItems.push(...response.workItems)
    if (!response.nextCursor) return workItems
    cursor = response.nextCursor
  }

  throw new TeamIssuesApiError(
    413,
    `More than ${WORKSPACE_WORK_ITEM_MAX_PAGES * WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT} Work Items match this view.`,
    'WorkItemListLimitExceeded',
  )
}

/**
 * Loads Work Item counts per Team and Project for Workspace dashboards.
 *
 * @param accessToken - Bearer token for the Work Item API.
 * @returns Totals and per-bucket counts computed by the server.
 */
export async function getWorkspaceWorkItemSummary(accessToken: string) {
  return requestJson<WorkItemSummaryResponse>(
    `${issuesApiBaseUrl}/work-items/summary`,
    accessToken,
  )
}

/**
 * Builds the paged Workspace Work Item list URL.
 *
 * @param request - Filter, archive option, page size, and cursor.
 * @returns The list URL with only the parameters that are set.
 */
function createWorkspaceWorkItemPageUrl(request: WorkspaceWorkItemPageRequest): string {
  const searchParams = new URLSearchParams({
    limit: String(request.limit ?? WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT),
  })
  const filter = request.filter ?? {}
  if (request.includeArchived) searchParams.set('includeArchived', 'true')
  if (filter.involvement) searchParams.set('involvement', filter.involvement)
  if (filter.teamId) searchParams.set('teamId', filter.teamId)
  if (filter.projectId) searchParams.set('projectId', filter.projectId)
  for (const category of filter.statusCategories ?? []) {
    searchParams.append('statusCategory', category)
  }
  if (filter.openOnly) searchParams.set('open', 'true')
  if (request.cursor) searchParams.set('cursor', request.cursor)
  return `${issuesApiBaseUrl}/work-items?${searchParams.toString()}`
}

/**
 * Appends the archived-list opt-in without changing legacy active-only request URLs.
 *
 * @param url - Canonical Work Item list URL.
 * @param includeArchived - Whether archived rows should be requested.
 * @returns The original URL or its archived-inclusive query variant.
 */
function createWorkItemListUrl(url: string, includeArchived: boolean): string {
  if (!includeArchived) return url
  const searchParams = new URLSearchParams({ includeArchived: 'true' })
  return `${url}?${searchParams.toString()}`
}

/**
 * DynamoDB に保存されたチーム所有 Issue 詳細を Lambda API 経由で取得します。
 */
export async function getTeamIssueDetail(
  teamId: string,
  issueId: string,
  accessToken?: string,
) {
  return requestJson<TeamIssueDetail>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`,
    accessToken,
  )
}

/**
 * DynamoDB にチーム所有 Issue を作成します。
 */
export async function createTeamIssue(
  teamId: string,
  accessToken: string,
  input: CreateTeamIssueInput,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<CreateTeamIssueResponse>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  )

  return response.issue
}

/**
 * DynamoDB に保存されたチーム所有 Issue を更新します。
 */
export async function updateTeamIssue(
  teamId: string,
  issueId: string,
  accessToken: string,
  input: UpdateTeamIssueRequest,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<UpdateTeamIssueResponse>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PATCH',
    },
  )

  return response.issue
}

/**
 * Validates a schedule operation against the current Work Item revision without mutating it.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Team-local Work Item identifier.
 * @param accessToken - Session bearer token.
 * @param input - Revision and schedule operation to preview.
 * @returns Server-authoritative before/after impacts and warnings.
 */
export async function previewTeamIssueSchedule(
  teamId: string,
  issueId: string,
  accessToken: string,
  input: PreviewWorkItemScheduleInput,
) {
  const data = await requestJson<unknown>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}/schedule/preview`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    },
  )
  const preview = readWorkItemScheduleChangePreviewForEndpoint(data, teamId, issueId)
  if (!preview) {
    throw new TeamIssuesApiError(
      502,
      defaultIssuesApiErrorMessage,
      'InvalidWorkItemSchedulePreview',
    )
  }
  return preview
}

/**
 * Validates a proposed Work Item Type change without mutating the Work Item.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Team-local Work Item identifier.
 * @param accessToken - Session bearer token.
 * @param input - Revision and target type sent to the preview endpoint.
 * @returns Server-authoritative field and workflow impacts.
 */
export async function previewTeamIssueWorkItemType(
  teamId: string,
  issueId: string,
  accessToken: string,
  input: PreviewWorkItemTypeChangeInput,
): Promise<WorkItemTypeChangePreview> {
  return requestValidatedJson(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}/work-item-type-preview`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    },
    isWorkItemTypeChangePreview,
    'InvalidWorkItemTypeChangePreview',
  )
}

/**
 * Confirms and atomically applies a server-recomputed dependency schedule cascade.
 *
 * @param teamId - Team that owns the directly edited Work Item.
 * @param issueId - Team-local Work Item identifier.
 * @param accessToken - Session bearer token.
 * @param input - Original operation, graph revisions, and explicit acknowledgement.
 * @param mutationContext - Stable idempotency and correlation identifiers.
 * @returns Compact canonical schedule projections for every changed Work Item.
 */
export async function confirmTeamIssueSchedule(
  teamId: string,
  issueId: string,
  accessToken: string,
  input: ConfirmWorkItemScheduleChangeInput,
  mutationContext: MutationRequestContext,
) {
  return requestValidatedJson(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}/schedule/confirm`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
    isConfirmWorkItemScheduleChangeResponse,
    'InvalidWorkItemScheduleConfirmationResponse',
  )
}

/** Fetches JSON and rejects a successful response that violates its contract. */
async function requestValidatedJson<TResponse>(
  url: string,
  accessToken: string | undefined,
  init: RequestInit,
  validate: (value: unknown) => value is TResponse,
  invalidCode: string,
): Promise<TResponse> {
  const data = await requestJson<unknown>(url, accessToken, init)
  if (!validate(data)) {
    throw new TeamIssuesApiError(502, defaultIssuesApiErrorMessage, invalidCode)
  }
  return data
}

async function requestJson<TResponse>(
  url: string,
  accessToken?: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : {}),
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const error = readApiError(data)

    throw new TeamIssuesApiError(response.status, error.message, error.code)
  }

  return data as TResponse
}
