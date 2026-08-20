import { WorkspaceAccessApiError } from './errors'

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
   * Invitation を membership へ収束させた日時です。
   */
  acceptedAt?: string
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

const workspaceApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_PROJECTS_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Workspace member、invitation、操作権限を取得します。
 */
export function getWorkspaceAccess(accessToken: string, signal?: AbortSignal) {
  return sendWorkspaceAccessRequest<WorkspaceAccess>('/workspace/access', accessToken, { signal })
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
