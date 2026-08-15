import type {
  CanonicalWorkItem,
  ConfirmWorkItemScheduleChangeInput,
  CreateWorkItemInput,
  PreviewWorkItemScheduleInput,
  ResolvedWorkItemConfiguration,
  UpdateWorkItemInput,
  WorkItemPatch,
  WorkItemRelation,
  WorkItemTriageContextSnapshot,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import {
  isConfirmWorkItemScheduleChangeResponse,
  readWorkItemScheduleChangePreviewForEndpoint,
} from '../../work-items/api/contractValidation'
import type { TeamIssueActivity } from './activity'
import { TeamIssuesApiError } from './errors'
import {
  defaultIssuesApiErrorMessage,
  readApiError,
  readJson,
  trimTrailingSlash,
} from './http'

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
}

/**
 * Workspace 全体の Work Item 一覧レスポンスです。
 */
type WorkspaceWorkItemsResponse = {
  /**
   * 未割り当てを含む Workspace 内の Work Item 一覧です。
   */
  workItems: TeamIssue[]
}

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

const issuesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

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
  const response = await requestJson<ProjectIssuesResponse>(
    createWorkItemListUrl(
      `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/issues`,
      includeArchived,
    ),
    accessToken,
  )

  return response.issues
}

/**
 * Loads the Workspace-wide Work Item projection, including unassigned items.
 *
 * @param accessToken - Bearer token for the Work Item API.
 * @param includeArchived - Whether archived Work Items should be included.
 * @returns Workspace Work Items visible to the current viewer.
 */
export async function getWorkspaceWorkItems(
  accessToken: string,
  includeArchived = false,
) {
  const response = await requestJson<WorkspaceWorkItemsResponse>(
    createWorkItemListUrl(`${issuesApiBaseUrl}/work-items`, includeArchived),
    accessToken,
  )

  return response.workItems
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
