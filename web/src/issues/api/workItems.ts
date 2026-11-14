import type {
  CanonicalWorkItem,
  ConfirmWorkItemScheduleChangeInput,
  CreateWorkItemInput,
  CustomerImpactSignal,
  ProjectWorkItemListPage,
  PreviewWorkItemScheduleInput,
  PreviewWorkItemTypeChangeInput,
  ResolvedWorkItemConfiguration,
  TeamWorkItemListPage,
  UpdateWorkItemInput,
  WorkItemPatch,
  WorkItemRelation,
  WorkItemTriageContextSnapshot,
  WorkItemTypeChangePreview,
  WorkItemSummaryResponse,
  WorkspaceWorkItemListFilter,
  WorkspaceWorkItemPage,
} from '@mukuroji/contracts'
import {
  SCOPED_WORK_ITEM_PAGE_MAX_LIMIT,
  WORKSPACE_WORK_ITEM_PAGE_MAX_LIMIT,
} from '@mukuroji/contracts'
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

/** Options of one Team or Project Work Item page request. */
export type ScopedWorkItemPageRequest = {
  /** Whether archived Work Items should be included. */
  includeArchived?: boolean
  /** Page size, up to the contract maximum. */
  limit?: number
  /** Cursor returned by the previous page. */
  cursor?: string
}

/**
 * Loads one page of a Team's Work Items in the Team's sort order.
 *
 * @param teamId - Team whose Work Items should be loaded.
 * @param accessToken - Bearer token for the Work Item API.
 * @param request - Archive option, page size, and cursor.
 * @returns The page and the cursor of the next one.
 */
export async function getTeamIssuesPage(
  teamId: string,
  accessToken: string,
  request: ScopedWorkItemPageRequest = {},
) {
  return requestJson<TeamWorkItemListPage<TeamIssue>>(
    createScopedWorkItemPageUrl(
      `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues`,
      request,
    ),
    accessToken,
  )
}

/**
 * Loads one page of the Work Items assigned to a Project, with its Customer capability.
 *
 * @param projectId - Project whose assigned Work Items should be loaded.
 * @param accessToken - Bearer token for the Work Item API.
 * @param request - Archive option, page size, and cursor.
 * @returns The page, the Customer impact capability, and the cursor of the next page.
 */
export async function getProjectIssuesPage(
  projectId: string,
  accessToken: string,
  request: ScopedWorkItemPageRequest = {},
) {
  return requestJson<ProjectWorkItemListPage<TeamIssue>>(
    createScopedWorkItemPageUrl(
      `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/issues`,
      request,
    ),
    accessToken,
  )
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
 * Builds a paged Team or Project Work Item list URL.
 *
 * @param url - Canonical Team or Project Work Item list URL.
 * @param request - Archive option, page size, and cursor.
 * @returns The list URL with only the parameters that are set.
 */
function createScopedWorkItemPageUrl(url: string, request: ScopedWorkItemPageRequest): string {
  const searchParams = new URLSearchParams({
    limit: String(request.limit ?? SCOPED_WORK_ITEM_PAGE_MAX_LIMIT),
  })
  if (request.includeArchived) searchParams.set('includeArchived', 'true')
  if (request.cursor) searchParams.set('cursor', request.cursor)
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
