import type {
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemPatch,
} from '@mukuroji/contracts'
import type { MessageKey } from '../i18n'
import { createMutationHeaders, type MutationRequestContext } from '../api/mutationHeaders'

/**
 * チーム所有 Issue の活動種別です。
 */
export type TeamIssueActivityType = 'created' | 'updated' | 'commented'

/**
 * チーム所有 Issue の互換名で参照する canonical Work Item です。
 */
export type TeamIssue = WorkItem<MessageKey>

/**
 * チーム所有 Issue のコメントです。
 */
export type TeamIssueComment = {
  /**
   * コメント ID です。
   */
  id: string
  /**
   * thread のルートコメント ID です。
   */
  rootCommentId?: string
  /**
   * 返信先コメント ID です。root comment では未設定です。
   */
  parentCommentId?: string
  /**
   * コメント作成者の Workspace member key です。
   */
  authorMemberKey?: string
  /**
   * 旧 comment API が返す actor user ID です。
   */
  actorUserId?: string
  /**
   * Markdown で保存されたコメント本文です。
   */
  bodyMarkdown?: string
  /**
   * 移行期間の旧 comment API が返す plain text 本文です。
   */
  body?: string
  /**
   * optimistic concurrency に使う comment revision です。
   */
  version?: number
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt?: string
  /**
   * コメントが編集された日時です。
   */
  editedAt?: string
  /**
   * コメントが soft delete された日時です。
   */
  deletedAt?: string
  /**
   * thread が解決された日時です。
   */
  resolvedAt?: string
  /**
   * thread を解決した Workspace member key です。
   */
  resolvedByMemberKey?: string
  /**
   * 本文中で mention された Workspace member key の重複除外済み一覧です。
   */
  mentionMemberKeys?: string[]
  /**
   * コメントに付いた reaction 集計です。
   */
  reactions?: TeamIssueCommentReaction[]
  /**
   * 現在のユーザーがコメントに行える操作です。
   */
  capabilities?: TeamIssueCommentCapabilities
  /**
   * collaboration store または移行前データのどちらから取得したかを表します。
   */
  source?: 'collaboration' | 'legacy'
}

/**
 * コメントに付いた emoji reaction の集計です。
 */
export type TeamIssueCommentReaction = {
  /**
   * Unicode emoji です。
   */
  emoji: string
  /**
   * 同じ emoji の reaction 数です。
   */
  count: number
  /**
   * 現在のユーザーが reaction 済みかどうかです。
   */
  reactedByMe: boolean
}

/**
 * コメント単位の操作権限です。
 */
export type TeamIssueCommentCapabilities = {
  /**
   * コメントを編集できるかどうかです。
   */
  canEdit: boolean
  /**
   * コメントを soft delete できるかどうかです。
   */
  canDelete: boolean
  /**
   * thread を resolve / reopen できるかどうかです。
   */
  canResolve: boolean
  /**
   * このコメントへ返信できるかどうかです。
   */
  canReply?: boolean
  /**
   * このコメントの reaction を変更できるかどうかです。
   */
  canReact?: boolean
}

/**
 * Work Item の watcher 状態です。
 */
export type TeamIssueWatchState = {
  /**
   * 現在のユーザーが有効な watcher かどうかです。
   */
  subscribed: boolean
  /**
   * 明示的な subscribe 設定があるかどうかです。
   */
  explicit: boolean
  /**
   * 自動 watch 条件で有効になっているかどうかです。
   */
  automatic: boolean
  /**
   * 自動 watch になった理由です。
   */
  reasons: string[]
  /**
   * Work Item の watcher 数です。
   */
  watcherCount: number
  /**
   * 割り当て先 project を現在のユーザーが watch しているかどうかです。
   */
  projectSubscribed?: boolean
  /**
   * 割り当て先 project の watcher 数です。
   */
  projectWatcherCount?: number
}

/**
 * Work Item を開いている member の presence です。
 */
export type TeamIssuePresence = {
  /**
   * Workspace member key です。
   */
  memberKey: string
  /**
   * コメントを入力中かどうかです。
   */
  typing: boolean
  /**
   * 最終 heartbeat の ISO 8601 timestamp です。
   */
  lastSeenAt: string
}

/**
 * Work Item 全体で行える共同作業操作です。
 */
export type TeamIssueCollaborationCapabilities = {
  /**
   * comment / reply を作成できるかどうかです。
   */
  canComment: boolean
  /**
   * reaction を変更できるかどうかです。
   */
  canReact: boolean
  /**
   * watcher 設定を変更できるかどうかです。
   */
  canWatch: boolean
}

/**
 * Work Item 共同作業 API の cursor page です。
 */
export type TeamIssueCollaborationPage = {
  /**
   * コメントと reply の一覧です。
   */
  comments: TeamIssueComment[]
  /**
   * 次 page の opaque cursor です。
   */
  nextCursor?: string
  /**
   * thread root ID ごとの次 reply page cursor です。
   */
  replyNextCursors?: Record<string, string>
  /**
   * watcher 状態です。
   */
  watch: TeamIssueWatchState
  /**
   * 現在の presence 一覧です。
   */
  presence: TeamIssuePresence[]
  /**
   * 共同作業パネル全体の操作権限です。
   */
  capabilities: TeamIssueCollaborationCapabilities
}

/**
 * Work Item collaboration page の取得条件です。
 */
export type GetTeamIssueCollaborationOptions = {
  /**
   * 取得する最大件数です。
   */
  limit?: number
  /**
   * API が返した opaque cursor です。
   */
  cursor?: string
  /**
   * 指定した場合は、この thread の reply page を取得します。
   */
  rootCommentId?: string
}

/**
 * comment / reply 作成 API に送信する入力です。
 */
export type CreateTeamIssueCommentInput = {
  /**
   * Markdown 本文です。
   */
  bodyMarkdown: string
  /**
   * reply 先コメント ID です。
   */
  parentCommentId?: string
  /**
   * mention された Workspace member key です。
   */
  mentionMemberKeys?: string[]
}

/**
 * comment 更新 API に送信する入力です。
 */
export type UpdateTeamIssueCommentInput = {
  /**
   * 更新後の Markdown 本文です。
   */
  bodyMarkdown?: string
  /**
   * 更新後の mention 対象です。
   */
  mentionMemberKeys?: string[]
  /**
   * 読み込み時点の comment version です。
   */
  expectedVersion: number
}

/**
 * チーム所有 Issue の活動履歴です。
 */
export type TeamIssueActivity = {
  /**
   * 活動履歴 ID です。
   */
  id: string
  /**
   * 活動種別です。
   */
  type: TeamIssueActivityType
  /**
   * 活動したユーザー ID です。
   */
  actorUserId: string
  /**
   * 活動概要です。
   */
  summary: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
}

/**
 * append-only audit 基盤から取得する Work Item activity です。
 */
export type TeamIssueActivityEvent = {
  /**
   * audit event ID です。
   */
  eventId: string
  /**
   * `comment.edited` などの event type です。
   */
  eventType: string
  /**
   * event 発生日時の ISO 8601 timestamp です。
   */
  occurredAt: string
  /**
   * event を発生させた Workspace member key です。
   */
  actorUserId: string
  /**
   * 既知でない event の fallback 表示に使う概要です。
   */
  summary?: string
  /**
   * UI 表示に許可された event metadata です。
   */
  metadata?: Record<string, unknown>
}

/**
 * Work Item activity API の cursor page です。
 */
export type TeamIssueActivityPage = {
  /**
   * activity event 一覧です。
   */
  events: TeamIssueActivityEvent[]
  /**
   * 次 page の opaque cursor です。
   */
  nextCursor?: string
}

/**
 * WebSocket 接続用の短命 ticket です。
 */
export type TeamIssueRealtimeTicket = {
  /**
   * WebSocket authorizer が検証する one-time ticket です。
   */
  ticket: string
  /**
   * 接続先 WebSocket URL です。
   */
  websocketUrl: string
  /**
   * ticket の有効期限です。
   */
  expiresAt: string
}

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

/**
 * Issue コメント作成 API が返す response body です。
 */
type CreateTeamIssueCommentResponse = {
  /**
   * 作成されたコメントです。
   */
  comment: TeamIssueComment
  /**
   * コメント作成に対応する活動履歴です。
   */
  activity: TeamIssueActivity
}

/**
 * watcher API が返す response body です。
 */
type TeamIssueWatchResponse = {
  /**
   * 更新後の watcher 状態です。
   */
  watch: TeamIssueWatchState
}

/**
 * Lambda API からエラーレスポンスが返ったときに投げる例外です。
 */
export class TeamIssuesApiError extends Error {
  /**
   * API レスポンスの HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した安定 error code です。
   */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const issuesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

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
 * 未割り当てを含む Workspace 全体の canonical Work Item を取得します。
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
 * DynamoDB にチーム所有 Issue コメントを作成します。
 */
export async function createTeamIssueComment(
  teamId: string,
  issueId: string,
  accessToken: string,
  input: CreateTeamIssueCommentInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<CreateTeamIssueCommentResponse>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}/comments`,
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
}

/**
 * Work Item の comment thread、watcher、presence を cursor 付きで取得します。
 */
export async function getTeamIssueCollaboration(
  teamId: string,
  issueId: string,
  accessToken: string,
  options: GetTeamIssueCollaborationOptions = {},
) {
  const query = new URLSearchParams()

  if (options.limit !== undefined) {
    query.set('limit', String(options.limit))
  }

  if (options.cursor) {
    query.set('cursor', options.cursor)
  }

  if (options.rootCommentId) {
    query.set('rootCommentId', options.rootCommentId)
  }

  const queryString = query.toString()

  return requestJson<TeamIssueCollaborationPage>(
    `${createTeamIssuePath(teamId, issueId)}/collaboration${queryString ? `?${queryString}` : ''}`,
    accessToken,
  )
}

/**
 * append-only audit 基盤から Work Item activity を cursor 付きで取得します。
 */
export function getTeamIssueActivity(
  teamId: string,
  issueId: string,
  accessToken: string,
  options: { limit?: number; cursor?: string } = {},
) {
  const query = new URLSearchParams()

  if (options.limit !== undefined) {
    query.set('limit', String(options.limit))
  }

  if (options.cursor) {
    query.set('cursor', options.cursor)
  }

  const queryString = query.toString()

  return requestJson<TeamIssueActivityPage>(
    `${createTeamIssuePath(teamId, issueId)}/activity${queryString ? `?${queryString}` : ''}`,
    accessToken,
  )
}

/**
 * Work Item の realtime channel に接続するための短命 ticket を発行します。
 */
export function createTeamIssueRealtimeTicket(
  teamId: string,
  issueId: string,
  accessToken: string,
) {
  return requestJson<TeamIssueRealtimeTicket>(
    `${issuesApiBaseUrl}/realtime/tickets`,
    accessToken,
    {
      body: JSON.stringify({ teamId, issueId }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    },
  )
}

/**
 * 保存済み comment の Markdown 本文と mention を更新します。
 */
export function updateTeamIssueComment(
  teamId: string,
  issueId: string,
  commentId: string,
  accessToken: string,
  input: UpdateTeamIssueCommentInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<{ comment: TeamIssueComment }>(
    `${createTeamIssuePath(teamId, issueId)}/comments/${encodeURIComponent(commentId)}`,
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
}

/**
 * 保存済み comment を soft delete します。
 */
export function deleteTeamIssueComment(
  teamId: string,
  issueId: string,
  commentId: string,
  accessToken: string,
  expectedVersion: number,
  mutationContext: MutationRequestContext,
) {
  return requestJson<{ comment: TeamIssueComment }>(
    `${createTeamIssuePath(teamId, issueId)}/comments/${encodeURIComponent(commentId)}`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion }),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'DELETE',
    },
  )
}

/**
 * comment thread を解決済みにします。
 */
export function resolveTeamIssueComment(
  teamId: string,
  issueId: string,
  commentId: string,
  accessToken: string,
  expectedVersion: number,
  mutationContext: MutationRequestContext,
) {
  return changeTeamIssueCommentResolution(
    teamId,
    issueId,
    commentId,
    accessToken,
    'resolve',
    expectedVersion,
    mutationContext,
  )
}

/**
 * 解決済み comment thread を再度開きます。
 */
export function reopenTeamIssueComment(
  teamId: string,
  issueId: string,
  commentId: string,
  accessToken: string,
  expectedVersion: number,
  mutationContext: MutationRequestContext,
) {
  return changeTeamIssueCommentResolution(
    teamId,
    issueId,
    commentId,
    accessToken,
    'reopen',
    expectedVersion,
    mutationContext,
  )
}

/**
 * comment へ emoji reaction を追加します。
 */
export function addTeamIssueCommentReaction(
  teamId: string,
  issueId: string,
  commentId: string,
  emoji: string,
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  return changeTeamIssueCommentReaction(
    teamId,
    issueId,
    commentId,
    emoji,
    accessToken,
    'PUT',
    mutationContext,
  )
}

/**
 * comment から現在のユーザーの emoji reaction を削除します。
 */
export function removeTeamIssueCommentReaction(
  teamId: string,
  issueId: string,
  commentId: string,
  emoji: string,
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  return changeTeamIssueCommentReaction(
    teamId,
    issueId,
    commentId,
    emoji,
    accessToken,
    'DELETE',
    mutationContext,
  )
}

/**
 * Work Item の現在の watcher 状態を取得します。
 */
export async function getTeamIssueWatch(teamId: string, issueId: string, accessToken: string) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${createTeamIssuePath(teamId, issueId)}/watch`,
    accessToken,
  )

  return response.watch
}

/**
 * 現在のユーザーを Work Item watcher に追加します。
 */
export async function subscribeTeamIssueWatch(
  teamId: string,
  issueId: string,
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${createTeamIssuePath(teamId, issueId)}/watch`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  )

  return response.watch
}

/**
 * 現在のユーザーを Work Item watcher から外します。
 */
export async function unsubscribeTeamIssueWatch(
  teamId: string,
  issueId: string,
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${createTeamIssuePath(teamId, issueId)}/watch`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )

  return response.watch
}

/**
 * 現在のユーザーに対する Project watcher 状態を取得します。
 */
export async function getProjectWatch(projectId: string, accessToken: string) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/watch`,
    accessToken,
  )

  return response.watch
}

/**
 * 現在のユーザーを Project watcher に追加します。
 */
export async function subscribeProjectWatch(
  projectId: string,
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/watch`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  )

  return response.watch
}

/**
 * 現在のユーザーを Project watcher から外します。
 */
export async function unsubscribeProjectWatch(
  projectId: string,
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/watch`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )

  return response.watch
}

/**
 * Work Item の presence heartbeat と typing 状態を更新します。
 */
export function updateTeamIssuePresence(
  teamId: string,
  issueId: string,
  accessToken: string,
  clientId: string,
  typing: boolean,
) {
  return requestJson<Record<string, never>>(
    `${createTeamIssuePath(teamId, issueId)}/presence`,
    accessToken,
    {
      body: JSON.stringify({ clientId, typing }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
    },
  )
}

/**
 * 閉じた browser tab の presence を削除します。
 */
export function deleteTeamIssuePresence(
  teamId: string,
  issueId: string,
  accessToken: string,
  clientId: string,
) {
  return requestJson<Record<string, never>>(
    `${createTeamIssuePath(teamId, issueId)}/presence/${encodeURIComponent(clientId)}`,
    accessToken,
    { method: 'DELETE' },
  )
}

function changeTeamIssueCommentResolution(
  teamId: string,
  issueId: string,
  commentId: string,
  accessToken: string,
  action: 'resolve' | 'reopen',
  expectedVersion: number,
  mutationContext: MutationRequestContext,
) {
  return requestJson<{ comment: TeamIssueComment }>(
    `${createTeamIssuePath(teamId, issueId)}/comments/${encodeURIComponent(commentId)}/${action}`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion }),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'POST',
    },
  )
}

function changeTeamIssueCommentReaction(
  teamId: string,
  issueId: string,
  commentId: string,
  emoji: string,
  accessToken: string,
  method: 'DELETE' | 'PUT',
  mutationContext: MutationRequestContext,
) {
  return requestJson<Record<string, never>>(
    `${createTeamIssuePath(teamId, issueId)}/comments/${encodeURIComponent(commentId)}/reactions/${encodeURIComponent(emoji)}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method,
    },
  )
}

function createTeamIssuePath(teamId: string, issueId: string) {
  return `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`
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
    typeof data.message === 'string'
    ? data.message
    : 'issues.error.loading'
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
    return { message: text } as T
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
