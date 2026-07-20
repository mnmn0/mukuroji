import type { ApprovalRequest } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { FilesApiError } from './errors'

/**
 * approval request 作成入力です。
 */
export type CreateApprovalRequestInput = {
  /**
   * approval 対象 file ID です。
   */
  fileId: string
  /**
   * approval 対象 version ID です。
   */
  versionId: string
  /**
   * reviewer の Workspace member key 一覧です。
   */
  reviewerMemberKeys: string[]
  /**
   * 判断期限の ISO 8601 timestamp です。
   */
  dueAt: string
  /**
   * 全 reviewer 承認後に適用する Work Item transition です。
   */
  completionTransition?: string
}

/**
 * reviewer が選択できる approval decision です。
 */
export type ApprovalDecision = 'approve' | 'reject' | 'request-changes'

/**
 * approval decision 作成入力です。
 */
export type CreateApprovalDecisionInput = {
  /**
   * reviewer の判断です。
   */
  decision: ApprovalDecision
  /**
   * 判断理由として残す任意の本文です。
   */
  comment?: string
  /**
   * 読み込み時点の approval revision です。
   */
  expectedRevision: number
}

/**
 * Approval request を cancel する入力です。
 */
export type CancelApprovalRequestInput = {
  /**
   * 読み込み時点の approval revision です。
   */
  expectedRevision: number
}

const filesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * Work Item の file version に approval request を作成します。
 */
export function createApprovalRequest(
  teamId: string,
  issueId: string,
  accessToken: string,
  input: CreateApprovalRequestInput,
  context: MutationRequestContext,
) {
  return requestJson<{ approval: ApprovalRequest }>(
    `${createWorkItemPath(teamId, issueId)}/approvals`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(context),
      },
      method: 'POST',
    },
  )
}

/**
 * reviewer の approval decision を保存します。
 */
export function createApprovalDecision(
  teamId: string,
  issueId: string,
  approvalId: string,
  accessToken: string,
  input: CreateApprovalDecisionInput,
  context: MutationRequestContext,
) {
  return requestJson<{ approval: ApprovalRequest }>(
    `${createWorkItemPath(teamId, issueId)}/approvals/${encodeURIComponent(approvalId)}/decisions`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(context),
      },
      method: 'POST',
    },
  )
}

/**
 * Requester または cancel 権限を持つ user が approval request を取り消します。
 */
export function cancelApprovalRequest(
  teamId: string,
  issueId: string,
  approvalId: string,
  accessToken: string,
  input: CancelApprovalRequestInput,
  context: MutationRequestContext,
) {
  return requestJson<{ approval: ApprovalRequest }>(
    `${createWorkItemPath(teamId, issueId)}/approvals/${encodeURIComponent(approvalId)}/cancel`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(context),
      },
      method: 'POST',
    },
  )
}

function createWorkItemPath(teamId: string, issueId: string) {
  return `${filesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`
}

async function requestJson<TResponse>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const message = typeof data === 'object' && data !== null &&
      'message' in data && typeof data.message === 'string'
      ? data.message
      : 'files.error.request'
    const code = typeof data === 'object' && data !== null &&
      'code' in data && typeof data.code === 'string'
      ? data.code
      : undefined

    throw new FilesApiError(response.status, message, code)
  }

  return data as TResponse
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
