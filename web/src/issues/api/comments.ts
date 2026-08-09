import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type { AcceptedResolution } from '@mukuroji/contracts'
import type { TeamIssueActivity } from './activity'
import { TeamIssuesApiError } from './errors'

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
   * Current accepted resolution snapshot; append-only history is loaded independently.
   */
  acceptedResolutions?: AcceptedResolution[]
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

const issuesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultIssuesApiErrorMessage = 'Unable to complete the Work Item request.'

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
