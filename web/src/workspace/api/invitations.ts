import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type { WorkspaceInvitation, WorkspaceRole } from './access'
import { WorkspaceAccessApiError } from './errors'

/**
 * Workspace invitation 作成 API の入力です。
 */
export type CreateWorkspaceInvitationInput = {
  /**
   * 招待先メールアドレスです。
   */
  email: string
  /**
   * 招待対象の任意の表示名です。
   */
  name?: string
  /**
   * 招待受諾後に付与する role です。
   */
  role: WorkspaceRole
}

/**
 * Workspace access API が invitation mutation 後に返す response body です。
 */
type WorkspaceInvitationResponse = {
  /**
   * 作成または更新された invitation です。
   */
  invitation: WorkspaceInvitation
}

const workspaceApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_PROJECTS_API_BASE_URL ??
    import.meta.env.VITE_TASKS_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Workspace invitation を作成します。
 */
export async function createWorkspaceInvitation(
  accessToken: string,
  input: CreateWorkspaceInvitationInput,
  mutationContext: MutationRequestContext,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceInvitationResponse>(
    '/workspace/invitations',
    accessToken,
    {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )

  return response.invitation
}

/**
 * 配信可能な Workspace invitation を再送します。
 */
export async function resendWorkspaceInvitation(
  accessToken: string,
  invitationId: string,
  mutationContext: MutationRequestContext,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceInvitationResponse>(
    `/workspace/invitations/${encodeURIComponent(invitationId)}/resend`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )

  return response.invitation
}

/**
 * Workspace invitation を取り消します。
 */
export async function revokeWorkspaceInvitation(
  accessToken: string,
  invitationId: string,
  mutationContext: MutationRequestContext,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceInvitationResponse>(
    `/workspace/invitations/${encodeURIComponent(invitationId)}/revoke`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )

  return response.invitation
}

/**
 * 期限切れまたは取消済み invitation から再招待を作成します。
 */
export async function reinviteWorkspaceInvitation(
  accessToken: string,
  invitationId: string,
  mutationContext: MutationRequestContext,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceInvitationResponse>(
    `/workspace/invitations/${encodeURIComponent(invitationId)}/reinvite`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )

  return response.invitation
}

/**
 * Cognito 上で実施した手動 cleanup の完了を invitation version 付きで確認します。
 */
export async function acknowledgeWorkspaceInvitationCleanup(
  accessToken: string,
  invitationId: string,
  expectedVersion: number,
  mutationContext: MutationRequestContext,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceInvitationResponse>(
    `/workspace/invitations/${encodeURIComponent(invitationId)}/cleanup/acknowledge`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion }),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    },
  )

  return response.invitation
}

async function sendWorkspaceAccessRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${workspaceApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    throw new WorkspaceAccessApiError(
      response.status,
      readErrorMessage(data),
      readErrorCode(data),
    )
  }

  return data as T
}

function readErrorCode(data: unknown) {
  return typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    typeof data.code === 'string'
    ? data.code
    : undefined
}

function readErrorMessage(data: unknown) {
  return typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string'
    ? data.message
    : 'workspace.access.error.operation'
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  return JSON.parse(text) as T
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
