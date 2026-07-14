/**
 * Workspace 全体で付与する member role です。
 */
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest'

/**
 * Workspace member の利用状態です。
 */
export type WorkspaceMemberStatus = 'active' | 'deactivated'

/**
 * Workspace invitation の lifecycle 状態です。
 */
export type WorkspaceInvitationStatus =
  | 'provisioning'
  | 'pending'
  | 'delivery-failed'
  | 'expired'
  | 'revoked'
  | 'accepted'

/**
 * Workspace invitation のメール配信状態です。
 */
export type WorkspaceInvitationDeliveryStatus = 'pending' | 'sent' | 'failed' | 'not-required'

/**
 * 招待対象の Cognito identity を誰が作成したかを表します。
 */
export type WorkspaceIdentityOwnership = 'workspace-created' | 'pre-existing' | 'ambiguous'

/**
 * Workspace access API が返す member 行です。
 */
export type WorkspaceMember = {
  /**
   * Workspace membership item の一意な ID です。
   */
  id: string
  /**
   * member mutation URL に使用する安定した member key です。
   */
  memberKey: string
  /**
   * member のメールアドレスです。
   */
  email: string
  /**
   * member の表示名です。
   */
  name?: string
  /**
   * Workspace 全体での role です。
   */
  role: WorkspaceRole
  /**
   * Workspace へのアクセス状態です。
   */
  status: WorkspaceMemberStatus
  /**
   * 同時更新検知に使用する version です。
   */
  version: number
  /**
   * membership 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * membership 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * 利用停止日時の ISO 8601 timestamp です。
   */
  deactivatedAt?: string
}

/**
 * Workspace access API が返す invitation 行です。
 */
export type WorkspaceInvitation = {
  /**
   * invitation の一意な ID です。
   */
  id: string
  /**
   * 招待先メールアドレスです。
   */
  email: string
  /**
   * 招待時に指定された表示名です。
   */
  name?: string
  /**
   * 招待受諾後に付与する Workspace role です。
   */
  role: WorkspaceRole
  /**
   * invitation lifecycle の現在状態です。
   */
  status: WorkspaceInvitationStatus
  /**
   * 招待メールの配信状態です。
   */
  deliveryStatus: WorkspaceInvitationDeliveryStatus
  /**
   * Cognito identity の provisioning ownership です。
   */
  identityOwnership: WorkspaceIdentityOwnership
  /**
   * Cognito user または directory claim の手動 cleanup 確認が必要かどうかです。
   */
  identityCleanupManualRequired?: boolean
  /**
   * invitation の同時更新検知に使用する version です。
   */
  version: number
  /**
   * invitation の有効期限を表す ISO 8601 timestamp です。
   */
  expiresAt: string
  /**
   * invitation 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * invitation 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * 招待メール最終送信日時の ISO 8601 timestamp です。
   */
  lastSentAt?: string
  /**
   * 配信または provisioning 失敗時の安全な表示メッセージです。
   */
  failureMessage?: string
}

/**
 * ログイン中 member が Workspace access 画面で実行できる操作です。
 */
export type WorkspaceAccessCapabilities = {
  /**
   * 新しい invitation を作成できるかどうかです。
   */
  canInvite: boolean
  /**
   * member / guest の role と status を変更できるかどうかです。
   */
  canManageMembers: boolean
  /**
   * admin を含む member の role と status を変更できるかどうかです。
   */
  canManageAdmins: boolean
}

/**
 * Workspace member、invitation、操作権限をまとめた response body です。
 */
export type WorkspaceAccess = {
  /**
   * ログイン中ユーザーの Workspace membership です。
   */
  currentMember: WorkspaceMember
  /**
   * Workspace に所属する member 一覧です。
   */
  members: WorkspaceMember[]
  /**
   * Workspace invitation 一覧です。
   */
  invitations: WorkspaceInvitation[]
  /**
   * ログイン中 member が実行できる操作です。
   */
  capabilities: WorkspaceAccessCapabilities
}

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
 * Workspace member 更新 API の入力です。
 */
export type UpdateWorkspaceMemberInput = {
  /**
   * 更新後の Workspace role です。
   */
  role?: WorkspaceRole
  /**
   * 更新後の member status です。
   */
  status?: WorkspaceMemberStatus
  /**
   * 更新対象を読み込んだ時点の version です。
   */
  expectedVersion: number
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

/**
 * Workspace access API が member mutation 後に返す response body です。
 */
type WorkspaceMemberResponse = {
  /**
   * 更新された member です。
   */
  member: WorkspaceMember
}

/**
 * Workspace access API の失敗を status code とともに保持する例外です。
 */
export class WorkspaceAccessApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number
  /**
   * API が返した分岐可能な error code です。
   */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'WorkspaceAccessApiError'
    this.status = status
    this.code = code
  }
}

const workspaceApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_PROJECTS_API_BASE_URL ??
    import.meta.env.VITE_TASKS_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Workspace member、invitation、操作権限を取得します。
 */
export function getWorkspaceAccess(accessToken: string, signal?: AbortSignal) {
  return sendWorkspaceAccessRequest<WorkspaceAccess>('/workspace/access', accessToken, { signal })
}

/**
 * Workspace invitation を作成します。
 */
export async function createWorkspaceInvitation(
  accessToken: string,
  input: CreateWorkspaceInvitationInput,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceInvitationResponse>(
    '/workspace/invitations',
    accessToken,
    {
      body: JSON.stringify(input),
      method: 'POST',
    },
  )

  return response.invitation
}

/**
 * 配信可能な Workspace invitation を再送します。
 */
export async function resendWorkspaceInvitation(accessToken: string, invitationId: string) {
  const response = await sendWorkspaceAccessRequest<WorkspaceInvitationResponse>(
    `/workspace/invitations/${encodeURIComponent(invitationId)}/resend`,
    accessToken,
    { method: 'POST' },
  )

  return response.invitation
}

/**
 * Workspace invitation を取り消します。
 */
export async function revokeWorkspaceInvitation(accessToken: string, invitationId: string) {
  const response = await sendWorkspaceAccessRequest<WorkspaceInvitationResponse>(
    `/workspace/invitations/${encodeURIComponent(invitationId)}/revoke`,
    accessToken,
    { method: 'POST' },
  )

  return response.invitation
}

/**
 * 期限切れまたは取消済み invitation から再招待を作成します。
 */
export async function reinviteWorkspaceInvitation(accessToken: string, invitationId: string) {
  const response = await sendWorkspaceAccessRequest<WorkspaceInvitationResponse>(
    `/workspace/invitations/${encodeURIComponent(invitationId)}/reinvite`,
    accessToken,
    { method: 'POST' },
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
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceInvitationResponse>(
    `/workspace/invitations/${encodeURIComponent(invitationId)}/cleanup/acknowledge`,
    accessToken,
    {
      body: JSON.stringify({ expectedVersion }),
      method: 'POST',
    },
  )

  return response.invitation
}

/**
 * Workspace member の role または利用状態を version 付きで更新します。
 */
export async function updateWorkspaceMember(
  accessToken: string,
  memberKey: string,
  input: UpdateWorkspaceMemberInput,
) {
  const response = await sendWorkspaceAccessRequest<WorkspaceMemberResponse>(
    `/workspace/members/${encodeURIComponent(memberKey)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      method: 'PATCH',
    },
  )

  return response.member
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
