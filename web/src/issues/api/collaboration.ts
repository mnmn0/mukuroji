import type { TeamIssueComment } from './comments'
import type { AcceptedResolution } from '@mukuroji/contracts'
import { TeamIssuesApiError } from './errors'
import type { TeamIssuePresence } from './presence'
import type { TeamIssueWatchState } from './watch'

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

const issuesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultIssuesApiErrorMessage = 'Unable to complete the Work Item request.'

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

  const page = await requestJson<TeamIssueCollaborationPage>(
    `${createTeamIssuePath(teamId, issueId)}/collaboration${queryString ? `?${queryString}` : ''}`,
    accessToken,
  )

  return {
    ...page,
    comments: page.comments.map(normalizeAcceptedResolutionHistory),
  }
}

/**
 * Normalizes an absent current accepted-resolution snapshot and rejects malformed audit data.
 *
 * @param comment - Comment returned by the collaboration API.
 * @returns Comment with a runtime-validated current accepted resolution snapshot.
 */
function normalizeAcceptedResolutionHistory(
  comment: TeamIssueComment,
): TeamIssueComment {
  if (comment.acceptedResolutions === undefined) {
    return { ...comment, acceptedResolutions: [] }
  }

  if (
    !Array.isArray(comment.acceptedResolutions) ||
    !comment.acceptedResolutions.every(isAcceptedResolution)
  ) {
    throw new TeamIssuesApiError(
      502,
      'The accepted resolution history response was invalid.',
      'InvalidAcceptedResolutionResponse',
    )
  }

  return comment
}

/**
 * Validates one accepted-resolution history entry at the Web API boundary.
 *
 * @param value - Untrusted resolution candidate.
 * @returns Whether the candidate contains the complete shared contract.
 */
export function isAcceptedResolution(
  value: unknown,
): value is AcceptedResolution {
  if (typeof value !== 'object' || value === null) return false
  if (!('acceptedBy' in value)) return false
  const actor = value.acceptedBy

  const commonFieldsAreValid = (
    typeof actor === 'object' &&
    actor !== null &&
    'id' in actor &&
    typeof actor.id === 'string' &&
    'displayName' in actor &&
    typeof actor.displayName === 'string' &&
    (!('avatarUrl' in actor) || typeof actor.avatarUrl === 'string') &&
    'id' in value &&
    typeof value.id === 'string' &&
    'sourceCommentId' in value &&
    typeof value.sourceCommentId === 'string' &&
    'sourceRootCommentId' in value &&
    typeof value.sourceRootCommentId === 'string' &&
    'capturedCommentRevision' in value &&
    typeof value.capturedCommentRevision === 'number' &&
    'capturedCommentBody' in value &&
    typeof value.capturedCommentBody === 'string' &&
    'summary' in value &&
    typeof value.summary === 'string' &&
    'acceptedAt' in value &&
    typeof value.acceptedAt === 'string' &&
    'state' in value &&
    (value.state === 'accepted' || value.state === 'superseded')
  )

  if (!commonFieldsAreValid) return false
  if (value.state === 'accepted') return true

  return (
    'supersededByResolutionId' in value &&
    typeof value.supersededByResolutionId === 'string' &&
    'supersededAt' in value &&
    typeof value.supersededAt === 'string' &&
    'supersededBy' in value &&
    typeof value.supersededBy === 'object' &&
    value.supersededBy !== null &&
    'id' in value.supersededBy &&
    typeof value.supersededBy.id === 'string' &&
    'displayName' in value.supersededBy &&
    typeof value.supersededBy.displayName === 'string' &&
    (!('avatarUrl' in value.supersededBy) ||
      typeof value.supersededBy.avatarUrl === 'string')
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
