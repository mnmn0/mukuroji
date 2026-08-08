import type {
  CanonicalWorkItem,
  ConfirmWorkItemScheduleChangeInput,
  CreateWorkItemInput,
  PreviewWorkItemScheduleInput,
  ResolvedWorkItemConfiguration,
  UpdateWorkItemInput,
  WorkItemPatch,
  WorkItemRelation,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import {
  isConfirmWorkItemScheduleChangeResponse,
  readWorkItemScheduleChangePreviewForEndpoint,
} from '../../work-items/api/contractValidation'
import type { TeamIssueActivity } from './activity'
import type { TeamIssueComment } from './comments'
import { TeamIssuesApiError } from './errors'

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
   * Issue コメント一覧です。
   */
  comments: TeamIssueComment[]
  /**
   * Issue 活動履歴一覧です。
   */
  activity: TeamIssueActivity[]
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

const defaultIssuesApiErrorMessage = 'Unable to complete the Work Item request.'

/**
 * DynamoDB に保存されたチーム所有 Issue を Lambda API 経由で取得します。
 */
export async function getTeamIssues(teamId: string, accessToken?: string) {
  const response = await requestJson<TeamIssuesResponse>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues`,
    accessToken,
  )

  return response.issues
}

/**
 * DynamoDB に保存されたプロジェクト遂行 Issue を Lambda API 経由で取得します。
 */
export async function getProjectIssues(projectId: string, accessToken?: string) {
  const response = await requestJson<ProjectIssuesResponse>(
    `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/issues`,
    accessToken,
  )

  return response.issues
}

/**
 * 未割り当てを含む Workspace 全体の Work Item 投影を取得します。
 */
export async function getWorkspaceWorkItems(accessToken: string) {
  const response = await requestJson<WorkspaceWorkItemsResponse>(
    `${issuesApiBaseUrl}/work-items`,
    accessToken,
  )

  return response.workItems
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

function readApiError(data: unknown) {
  const message = typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string' &&
    data.message.trim().length > 0
    ? data.message
    : defaultIssuesApiErrorMessage
  const code = typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    typeof data.code === 'string'
    ? data.code
    : undefined

  return { code, message }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
