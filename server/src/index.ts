import {
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  GetUserCommand,
  InitiateAuthCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  BatchGetCommand,
  type BatchGetCommandInput,
  type BatchGetCommandOutput,
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_SCHEMA_VERSION,
  type ApprovalSummary,
  type CreateWorkItemInput,
  type WorkItem,
  type WorkItemPriority,
  type WorkItemStatus,
} from '@mukuroji/contracts'
import { Hono } from 'hono'
import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda'
import { cors } from 'hono/cors'
import type { Context } from 'hono'
import {
  auditEventsToNdjson,
  createAuditFieldChanges,
  createMutationAuditContext,
  createMutationAuditEventPut,
  DynamoDbAuditEventsClient,
  ensureLocalAuditEventsTable,
  getConfiguredAuditTableName,
  getConfiguredDynamoDbEndpoint,
  toAuditEventView,
  type AuditEventEntityType,
  type AuditEventPage,
  type AuditEventQuery,
  type MutationAuditContext,
  type MutationAuditEventInput,
} from './audit'
import {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
  isWorkspaceIdentitySafeToDelete,
  type WorkspaceAccessClient,
  type WorkspaceInvitation,
  type WorkspaceMember,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from './workspace-access'
import {
  DynamoDbRealtimeTicketsClient,
  RealtimeTicketError,
  type RealtimeTicketsClient,
} from './realtime-ticket'
import {
  CollaborationError,
  DynamoDbCollaborationClient,
  createProjectCollaborationEntityKey,
  createWorkItemCollaborationEntityKey,
  type CollaborationAutomaticWatcherCandidate,
  type CollaborationClient,
  type CollaborationComment,
} from './collaboration'
import {
  FILE_APPROVAL_MAX_REVIEWERS,
  FileProofingError,
  createDefaultFileProofingClient,
  createFileProofingScopeKey,
  type CancelFileApprovalInput,
  type CreateFileApprovalDecisionInput,
  type CreateFileApprovalInput,
  type CreateFileAnnotationInput,
  type CreateFileUploadInput,
  type FileProofingActor,
  type FileProofingClient,
  type FileProofingScope,
} from './file-proofing'

export {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
} from './workspace-access'
export type {
  WorkspaceAccessClient,
  WorkspaceIdentityOwnership,
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspaceMemberStatus,
  WorkspaceRole,
} from './workspace-access'

/**
 * Cognito の認証成功時に返る token set です。
 */
type AuthTokenSet = {
  /**
   * API 認証に使う access token です。
   */
  AccessToken?: string
  /**
   * フロントエンドでユーザー識別に使える ID token です。
   */
  IdToken?: string
  /**
   * token 更新に使う refresh token です。
   */
  RefreshToken?: string
  /**
   * token の有効秒数です。
   */
  ExpiresIn?: number
  /**
   * token type です。
   */
  TokenType?: string
}

/**
 * Cognito InitiateAuth のレスポンスです。
 */
type InitiateAuthResponse = {
  /**
   * 認証が完了した場合の token set です。
   */
  AuthenticationResult?: AuthTokenSet
  /**
   * 追加対応が必要な Cognito challenge 名です。
   */
  ChallengeName?: string
  /**
   * challenge 継続用の Cognito session です。
   */
  Session?: string
  /**
   * challenge 継続時に Cognito が返す補助 parameter です。
   */
  ChallengeParameters?: Record<string, string>
}

/**
 * Cognito の NEW_PASSWORD_REQUIRED challenge を完了する入力です。
 */
type CompleteNewPasswordChallengeRequestBody = {
  /**
   * challenge を開始した Cognito user のメールアドレスです。
   */
  email?: unknown
  /**
   * Cognito が login challenge とともに返した session です。
   */
  session?: unknown
  /**
   * user が設定する恒久 password です。
   */
  newPassword?: unknown
}

/**
 * Cognito ListUserPools のレスポンスです。
 */
type ListUserPoolsResponse = {
  /**
   * 検索対象リージョンの user pool 一覧です。
   */
  UserPools?: Array<{
    /**
     * Cognito user pool ID です。
     */
    Id?: string
    /**
     * Cognito user pool 名です。
     */
    Name?: string
  }>
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  NextToken?: string
}

/**
 * Cognito ListUserPoolClients のレスポンスです。
 */
type ListUserPoolClientsResponse = {
  /**
   * user pool に紐づく app client 一覧です。
   */
  UserPoolClients?: Array<{
    /**
     * Cognito app client ID です。
     */
    ClientId?: string
    /**
     * Cognito app client 名です。
     */
    ClientName?: string
  }>
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  NextToken?: string
}

/**
 * Cognito GetUser のレスポンスです。
 */
type GetUserResponse = {
  /**
   * Cognito ユーザー名です。
   */
  Username?: string
  /**
   * Cognito ユーザー属性一覧です。
   */
  UserAttributes?: Array<{
    /**
     * 属性名です。
     */
    Name?: string
    /**
     * 属性値です。
     */
    Value?: string
  }>
}

/**
 * Cognito ListUsers / AdminGetUser 相当の user record です。
 */
type CognitoUserRecord = {
  /**
   * Cognito user pool 内の username です。
   */
  Username?: string
  /**
   * Cognito user attributes です。
   */
  Attributes?: Array<{
    /**
     * 属性名です。
     */
    Name?: string
    /**
     * 属性値です。
     */
    Value?: string
  }>
  /**
   * AdminGetUser が返す Cognito user attributes です。
   */
  UserAttributes?: Array<{
    /**
     * 属性名です。
     */
    Name?: string
    /**
     * 属性値です。
     */
    Value?: string
  }>
  /**
   * user が有効かどうかです。
   */
  Enabled?: boolean
  /**
   * Cognito user status です。
   */
  UserStatus?: string
}

/**
 * Cognito ListUsers のレスポンスです。
 */
type ListUsersResponse = {
  /**
   * 取得できた Cognito users です。
   */
  Users?: CognitoUserRecord[]
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  PaginationToken?: string
}

/** Cognito AdminListGroupsForUser のレスポンスです。 */
type AdminListGroupsForUserResponse = {
  /** User が所属する group 一覧です。 */
  Groups?: Array<{
    /** Cognito group 名です。 */
    GroupName?: string
  }>
  /** 次 page 取得用の Cognito pagination token です。 */
  NextToken?: string
}

/**
 * Cognito AdminCreateUser のレスポンスです。
 */
type AdminCreateUserResponse = {
  /**
   * 作成された Cognito user です。
   */
  User?: CognitoUserRecord
}

/**
 * アプリが参照する Cognito user profile です。
 */
type CognitoUserProfile = {
  /**
   * アプリ内で user 参照に使う正規化済み ID です。
   */
  id: string
  /**
   * Cognito user pool 内の username です。
   */
  username: string
  /**
   * Cognito user のメールアドレスです。
   */
  email: string
  /**
   * Cognito user の表示名です。
   */
  name?: string
  /**
   * Cognito user が有効かどうかです。
   */
  enabled?: boolean
  /**
   * Cognito user status です。
   */
  status?: string
  /**
   * Workspace membership の利用状態です。assignment candidate response で付与します。
   */
  workspaceStatus?: WorkspaceMemberStatus
}

/**
 * Workspace invitation provisioning で参照する Cognito user と directory 情報です。
 */
type CognitoWorkspaceUser = {
  /**
   * 正規化済み Cognito user profile です。
   */
  profile: CognitoUserProfile
  /**
   * Cognito custom attribute に保存された Workspace directory ID です。
   */
  directoryId?: string
}

/**
 * Cognito user を Workspace invitation 用に準備する入力です。
 */
type ProvisionCognitoWorkspaceUserInput = {
  /**
   * invitation の宛先メールアドレスです。
   */
  email: string
  /**
   * invitation に指定された表示名です。
   */
  name?: string
  /**
   * Cognito custom attribute に設定する Workspace directory ID です。
   */
  directoryId: string
  /**
   * reservation 前に確認した既存 Cognito user です。
   */
  existingUser?: CognitoWorkspaceUser
}

/**
 * Cognito invitation provisioning の結果です。
 */
type ProvisionCognitoWorkspaceUserResult = {
  /**
   * invitation と紐付く Cognito user profile です。
   */
  profile: CognitoUserProfile
  /**
   * Cognito identity が Workspace によって新規作成されたかどうかです。
   */
  identityOwnership: 'workspace-created' | 'pre-existing' | 'ambiguous'
  /**
   * Cognito が invitation message を配信したかどうかです。
   */
  deliveryStatus: 'sent' | 'not-required'
}

/**
 * Cognito user 一覧 API が返す response body です。
 */
type CognitoUsersResponse = {
  /**
   * Cognito を master とする user profile 一覧です。
   */
  users: CognitoUserProfile[]
  /**
   * 次 page 取得用の Cognito pagination token です。
   */
  nextToken?: string
}

/**
 * Cognito user 一覧 API の入力です。
 */
type ListCognitoUsersInput = {
  /**
   * 候補 user を所属 directory に限定するための directory ID です。
   */
  directoryId?: string
  /**
   * Cognito の pagination token です。
   */
  paginationToken?: string
  /**
   * 1 page で取得する最大件数です。
   */
  limit?: number
  /**
   * email prefix 検索に使う query です。
   */
  query?: string
}

/**
 * Cognito access token の payload から読む claims です。
 */
type CognitoAccessTokenClaims = {
  /**
   * Cognito グループ名の配列です。
   */
  'cognito:groups'?: unknown
  /**
   * token を発行した Cognito user pool の issuer です。
   */
  iss?: unknown
  /**
   * token を発行した Cognito app client ID です。
   */
  client_id?: unknown
  /**
   * Cognito token の用途です。
   */
  token_use?: unknown
}

/**
 * プロジェクトデータへのアクセス範囲を表す認可済み principal です。
 */
type ProjectPrincipal = {
  /**
   * Cognito user から解決した directory partition key です。
   */
  directoryId: string
  /**
   * ログやエラー調査で参照するユーザー識別子です。
   */
  userKey: string
  /**
   * Audit actor に使う Cognito sub または immutable username です。
   */
  actorId: string
  /**
   * Cognito グループでシステム管理者として扱うかどうかです。
   */
  isSystemAdmin: boolean
  /**
   * access token に含まれていた Cognito グループ名です。
   */
  groups: string[]
}

/**
 * active Workspace membership を検証済みの principal です。
 */
type WorkspacePrincipal = ProjectPrincipal & {
  /**
   * DynamoDB から検証した active Workspace member です。
   */
  workspaceMember: WorkspaceMember
  /**
   * Workspace 全体で付与された role です。
   */
  workspaceRole: WorkspaceRole
  /**
   * 認証時点の Workspace member status です。
   */
  workspaceMemberStatus: WorkspaceMemberStatus
}

/**
 * Cognito JSON API のエラーレスポンスです。
 */
type CognitoErrorPayload = {
  /**
   * Cognito が返すエラー種別です。
   */
  __type?: string
  /**
   * 小文字キーで返るエラーメッセージです。
   */
  message?: string
  /**
   * 大文字キーで返るエラーメッセージです。
   */
  Message?: string
}

/**
 * ログイン API が受け取る request body です。
 */
type LoginRequestBody = {
  /**
   * ユーザーが入力したメールアドレスです。
   */
  email?: unknown
  /**
   * ユーザーが入力したパスワードです。
   */
  password?: unknown
}

/** Workspace invitation 作成 API の request body です。 */
type CreateWorkspaceInvitationRequestBody = {
  /** 招待先メールアドレスです。 */
  email?: unknown
  /** 招待対象の表示名です。 */
  name?: unknown
  /** 招待受諾後に付与する Workspace role です。 */
  role?: unknown
}

/** Workspace member 更新 API の request body です。 */
type UpdateWorkspaceAccessMemberRequestBody = {
  /** 更新後の Workspace role です。 */
  role?: unknown
  /** 更新後の member status です。 */
  status?: unknown
  /** optimistic locking に使う current version です。 */
  expectedVersion?: unknown
}

/**
 * ダッシュボード集計 API が返す response body です。
 */
type DashboardSummaryResponse = {
  /**
   * 進行中プロジェクト数です。
   */
  projects: number
  /**
   * 未完了タスク数です。
   */
  tasks: number
  /**
   * 要確認タスク数です。
   */
  blocked: number
  /**
   * 集計値を更新した ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * 集計値の取得元です。
   */
  source: 'dynamodb'
}

/**
 * タスクの進捗状態を表す API code です。
 */
type ProjectTaskStatus = WorkItemStatus

/**
 * タスクの優先度を表す API code です。
 */
type ProjectTaskPriority = WorkItemPriority

/**
 * プロジェクトごとの権限ロールです。
 */
export type ProjectRole = 'manager' | 'member' | 'viewer'

/**
 * active project と現在ユーザーの role を 1 directory read で返す行です。
 */
type ProjectAccessEntry = {
  /**
   * active project ID です。
   */
  projectId: string
  /**
   * 現在ユーザーに割り当てられた project role です。
   */
  role?: ProjectRole
}

/**
 * project 作成者を manager として登録するための context です。
 */
type ProjectCreatorContext = {
  /**
   * Cognito user を正規化した member key です。
   */
  userKey: string
  /**
   * project manager row 作成と競合させる Workspace member version です。
   */
  workspaceMemberVersion: number
}

/**
 * dashboard summary の集計対象を権限で絞り込むための user context です。
 */
type DashboardSummaryAccessContext = {
  /**
   * Cognito user を正規化した member key です。
   */
  userKey: string
  /**
   * system admin group に所属しているかどうかです。
   */
  isSystemAdmin: boolean
}

/**
 * DynamoDB に保存する project task item です。
 */
type ProjectTaskItem = {
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * タスク一覧 query に使う directory/project 複合 partition key です。
   */
  directoryProjectId: string
  /**
   * プロジェクト ID です。
   */
  projectId: string
  /**
   * タスク ID です。
   */
  taskId: string
  /**
   * プロジェクト内の表示順です。
   */
  sortOrder: number
  /**
   * タスク名を解決する i18n key です。seed 由来のタスクで利用します。
   */
  titleKey?: string
  /**
   * 登録画面から入力されたタスク名です。
   */
  title?: string
  /**
   * 担当者名を解決する i18n key です。seed 由来のタスクで利用します。
   */
  assigneeKey?: string
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId?: string
  /**
   * 登録画面から入力された担当者名です。旧データ互換で利用します。
   */
  assignee?: string
  /**
   * タスク状態です。
   */
  status: ProjectTaskStatus
  /**
   * 期限日として表示する文字列です。
   */
  dueDate: string
  /**
   * 優先度です。
   */
  priority: ProjectTaskPriority
}

/**
 * プロジェクト画面のテーブルへ表示するタスク行です。
 */
type ProjectTaskResponseItem = {
  /** canonical Work Item contract の schema version です。 */
  schemaVersion?: typeof WORK_ITEM_SCHEMA_VERSION
  /** canonical Work Item の optimistic concurrency revision です。 */
  revision?: number
  /** canonical Work Item を所有する Team ID です。 */
  teamId?: string
  /** canonical table または legacy adapter の保存元です。 */
  source?: 'dynamodb' | 'legacy'
  /**
   * React の key として使う task ID です。
   */
  id: string
  /**
   * タスク名を解決する i18n key です。
   */
  titleKey?: string
  /**
   * API から返す literal のタスク名です。
   */
  title?: string
  /**
   * canonical Work Item の詳細説明です。
   */
  description?: string
  /**
   * 担当者名を解決する i18n key です。
   */
  assigneeKey?: string
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId?: string
  /**
   * Cognito から解決した担当者メールアドレスです。
   */
  assigneeEmail?: string
  /**
   * Cognito から解決した担当者表示名です。
   */
  assigneeName?: string
  /**
   * API から返す literal の担当者名です。旧データ互換で利用します。
   */
  assignee?: string
  /**
   * タスク状態です。
   */
  status: ProjectTaskStatus
  /**
   * 期限日として表示する文字列です。
   */
  dueDate: string
  /**
   * 優先度です。
   */
  priority: ProjectTaskPriority
  /**
   * canonical Work Item の作成日時です。
   */
  createdAt?: string
  /**
   * canonical Work Item の最終更新日時です。
   */
  updatedAt?: string
}

/**
 * プロジェクトタスク一覧 API が返す response body です。
 */
type ProjectTasksResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * DynamoDB から取得したタスク一覧です。
   */
  tasks: ProjectTaskResponseItem[]
}

/**
 * チーム所有 Issue の活動種別です。
 */
type TeamIssueActivityType = 'created' | 'updated' | 'commented'

/**
 * DynamoDB に保存する team issue item です。
 */
type TeamIssueItem = {
  /**
   * canonical Work Item contract の schema version です。
   */
  schemaVersion: typeof WORK_ITEM_SCHEMA_VERSION
  /**
   * optimistic concurrency に使う単調増加 revision です。
   */
  revision: number
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * Issue 一覧 query に使う directory/team 複合 partition key です。
   */
  directoryTeamId: string
  /**
   * アサイン先 project 一覧 query に使う directory/project 複合 key です。
   */
  directoryProjectId?: string
  /**
   * Issue 所有元チーム ID です。
   */
  teamId: string
  /**
   * 遂行先 project ID です。未アサイン Issue では未設定です。
   */
  assignedProjectId?: string
  /**
   * チーム内の Issue ID です。
   */
  issueId: string
  /**
   * チーム内の表示順です。
   */
  sortOrder: number
  /**
   * Issue タイトルです。
   */
  title?: string
  /**
   * legacy seed のタイトルを解決する表示文言 key です。
   */
  titleKey?: string
  /**
   * Issue 詳細説明です。
   */
  description?: string
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId: string
  /**
   * Issue 作成者の Workspace member key です。旧 row では未設定です。
   */
  creatorMemberKey?: string
  /**
   * legacy project task migration の安定した source key です。
   */
  migrationSourceKey?: string
  /**
   * Issue 状態です。
   */
  status: ProjectTaskStatus
  /**
   * 期限日として表示する文字列です。
   */
  dueDate: string
  /**
   * 優先度です。
   */
  priority: ProjectTaskPriority
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
}

/**
 * DynamoDB に保存する team issue event item です。
 */
type TeamIssueEventItem = {
  /**
   * Issue event 一覧 query に使う directory/team/issue 複合 partition key です。
   */
  directoryTeamIssueId: string
  /**
   * event ID です。
   */
  eventId: string
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * Issue 所有元チーム ID です。
   */
  teamId: string
  /**
   * チーム内の Issue ID です。
   */
  issueId: string
  /**
   * event 種別です。
   */
  eventType: TeamIssueActivityType
  /**
   * event を起こした actor user key です。
   */
  actorUserId: string
  /**
   * コメント本文です。comment event のみ設定します。
   */
  body?: string
  /**
   * 活動履歴に表示する概要です。
   */
  summary: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
}

/**
 * チーム Issue 一覧と詳細で表示する Issue 行です。
 */
type TeamIssueResponseItem = WorkItem & {
  /**
   * チーム内の Issue ID です。
   */
  id: string
  /**
   * Issue 所有元チーム ID です。
   */
  teamId: string
  /**
   * 遂行先 project ID です。未アサイン Issue では未設定です。
   */
  assignedProjectId?: string
  /**
   * seed 由来の legacy task タイトル i18n key です。
   */
  titleKey?: string
  /**
   * Issue タイトルです。
   */
  title?: string
  /**
   * Issue 詳細説明です。
   */
  description?: string
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId?: string
  /**
   * Issue 作成者の Workspace member key です。旧 row では未設定です。
   */
  creatorMemberKey?: string
  /**
   * Cognito から解決した担当者メールアドレスです。
   */
  assigneeEmail?: string
  /**
   * Cognito から解決した担当者表示名です。
   */
  assigneeName?: string
  /**
   * Issue 状態です。
   */
  status: ProjectTaskStatus
  /**
   * 期限日として表示する文字列です。
   */
  dueDate: string
  /**
   * 優先度です。
   */
  priority: ProjectTaskPriority
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * Issue の保存元です。legacy は旧 project task table 由来の参照専用行です。
   */
  source: 'dynamodb' | 'legacy'
}

/**
 * Workspace 横断 Work Item API が返す response body です。
 */
type WorkItemsResponse = {
  /**
   * 現在ユーザーが参照できる canonical/legacy Work Item 一覧です。
   */
  workItems: TeamIssueResponseItem[]
}

/** Work Item 一覧 client の読み込み量を制御します。 */
type WorkItemListReadOptions = {
  /** DynamoDB から読み込む最大 item 数です。 */
  limit?: number
}

/** Team 一覧を legacy compatibility と統合するときの読み込み量を制御します。 */
type TeamIssueListReadOptions = {
  /** 各 DynamoDB partition で評価する最大 item 数です。 */
  scanLimit?: number
  /** Aggregate API が legacy read を許可した project ID です。 */
  legacyProjectIds?: ReadonlySet<string>
  /** canonical migration が取り込み済みの legacy source key です。 */
  migrationSourceKeys?: ReadonlySet<string>
  /** Detail fallback が必要とする legacy Issue ID です。 */
  legacyIssueId?: string
}

/**
 * `/api/work-items` は既存の `{ workItems }` 契約を維持するため cursor を追加せず、
 * pagination 契約を導入するまで hard cap 超過を 413 で fail-closed にします。
 * この値は一度に返す Work Item の最大件数です。
 */
const WORK_ITEMS_RESPONSE_LIMIT = 200
/** `/api/work-items` が一度に読む Team partition の最大数です。 */
const WORK_ITEMS_TEAM_READ_LIMIT = 20
/** `/api/work-items` が legacy compatibility のために読む project の最大数です。 */
const WORK_ITEMS_LEGACY_PROJECT_READ_LIMIT = 100
/** `/api/work-items` が 1 partition で filter/dedupe 前に評価する最大 item 数です。 */
const WORK_ITEMS_PARTITION_SCAN_LIMIT = 1_000
/** DynamoDB BatchGetItem の 1 request あたりの最大 key 数です。 */
const DYNAMODB_BATCH_GET_KEY_LIMIT = 100
/** UnprocessedKeys を同じ bounded read 内で再試行する最大回数です。 */
const DYNAMODB_BATCH_GET_ATTEMPT_LIMIT = 3
/** DynamoDB BatchGetItem retry の指数バックオフ基準時間です。 */
const DYNAMODB_BATCH_GET_RETRY_BASE_DELAY_MS = 25

/**
 * チーム Issue コメントレスポンスです。
 */
type TeamIssueCommentResponseItem = {
  /**
   * コメント ID です。
   */
  id: string
  /**
   * コメントした actor user key です。
   */
  actorUserId: string
  /**
   * コメント本文です。
   */
  body: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
}

/**
 * チーム Issue 活動履歴レスポンスです。
 */
type TeamIssueActivityResponseItem = {
  /**
   * 活動履歴 ID です。
   */
  id: string
  /**
   * 活動種別です。
   */
  type: TeamIssueActivityType
  /**
   * actor user key です。
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
 * チーム Issue 一覧 API が返す response body です。
 */
type TeamIssuesResponse = {
  /**
   * 取得対象の team ID です。
   */
  teamId: string
  /**
   * チームに紐づく Issue 一覧です。
   */
  issues: TeamIssueResponseItem[]
}

/** Aggregate Work Item read 専用の canonical Team partition 取得結果です。 */
type AggregateTeamIssuesRead = {
  /** 取得対象の Team ID です。 */
  teamId: string
  /** 公開 API と同じ canonical Work Item 表現です。 */
  issues: TeamIssueResponseItem[]
  /** legacy projection の抑止にだけ使う migration source key です。 */
  migrationSourceKeys: string[]
}

/** BatchGet で migration source を確認する Team / Issue key です。 */
type TeamIssueMigrationLookupKey = {
  /** Canonical Work Item を所有する Team ID です。 */
  teamId: string
  /** Canonical Work Item の Issue ID です。 */
  issueId: string
}

/**
 * プロジェクトにアサインされた Issue 一覧 API が返す response body です。
 */
type ProjectIssuesResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * プロジェクトにアサインされた Issue 一覧です。
   */
  issues: TeamIssueResponseItem[]
}

/**
 * チーム Issue 詳細 API が返す response body です。
 */
type TeamIssueDetailResponse = {
  /**
   * Issue 本体です。
   */
  issue: TeamIssueResponseItem
  /**
   * Issue コメント一覧です。
   */
  comments: TeamIssueCommentResponseItem[]
  /**
   * Issue 活動履歴一覧です。
   */
  activity: TeamIssueActivityResponseItem[]
  /** Bounded event 読み込みの次 page を指す opaque cursor です。 */
  nextEventCursor?: string
}

/**
 * チーム Issue 作成 API が受け取る request body です。
 */
type CreateTeamIssueRequestBody = {
  /**
   * Issue タイトルです。
   */
  title?: unknown
  /**
   * Issue 詳細説明です。
   */
  description?: unknown
  /**
   * 遂行先 project ID です。空文字または null で未アサインです。
   */
  assignedProjectId?: unknown
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId?: unknown
  /**
   * Issue 状態です。
   */
  status?: unknown
  /**
   * 期限日として保存する文字列です。
   */
  dueDate?: unknown
  /**
   * 優先度です。
   */
  priority?: unknown
}

/**
 * チーム Issue 更新 API が受け取る request body です。
 */
type UpdateTeamIssueRequestBody = {
  /**
   * optimistic concurrency に使う読み込み時点の revision です。
   */
  expectedRevision?: unknown
  /**
   * Issue タイトルです。
   */
  title?: unknown
  /**
   * Issue 詳細説明です。
   */
  description?: unknown
  /**
   * 遂行先 project ID です。空文字または null で未アサインへ戻します。
   */
  assignedProjectId?: unknown
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId?: unknown
  /**
   * Issue 状態です。
   */
  status?: unknown
  /**
   * 期限日として保存する文字列です。
   */
  dueDate?: unknown
  /**
   * 優先度です。
   */
  priority?: unknown
}

/**
 * チーム Issue コメント作成 API が受け取る request body です。
 */
type CreateTeamIssueCommentRequestBody = {
  /**
   * 旧 client が送信する plain text コメント本文です。
   */
  body?: unknown
  /**
   * Markdown source として保存するコメント本文です。
   */
  bodyMarkdown?: unknown
  /**
   * reply 先の comment ID です。
   */
  parentCommentId?: unknown
  /**
   * Composer が解決した安定した Workspace member key です。
   */
  mentionMemberKeys?: unknown
}

/**
 * チーム Issue コメント更新 API が受け取る request body です。
 */
type UpdateTeamIssueCommentRequestBody = {
  /**
   * 更新後の Markdown source です。
   */
  bodyMarkdown?: unknown
  /**
   * Composer が解決した安定した Workspace member key です。
   */
  mentionMemberKeys?: unknown
  /**
   * 読み込み時点の comment version です。
   */
  expectedVersion?: unknown
}

/**
 * Comment resolve/reopen/delete API が受け取る request body です。
 */
type VersionedTeamIssueCommentRequestBody = {
  /**
   * 読み込み時点の comment version です。
   */
  expectedVersion?: unknown
}

/**
 * Presence heartbeat API が受け取る request body です。
 */
type TeamIssuePresenceRequestBody = {
  /**
   * Browser tab ごとに作成する安定した client ID です。
   */
  clientId?: unknown
  /**
   * Comment composer に入力中かどうかです。
   */
  typing?: unknown
}

/**
 * Realtime WebSocket ticket API が受け取る request body です。
 */
type CreateRealtimeTicketRequestBody = {
  /**
   * 購読対象 Work Item の team ID です。
   */
  teamId?: unknown
  /**
   * 購読対象 Work Item の issue ID です。
   */
  issueId?: unknown
}

/**
 * チーム Issue 作成 API が返す response body です。
 */
type CreateTeamIssueResponse = {
  /**
   * 作成した Issue 行です。
   */
  issue: TeamIssueResponseItem
}

/**
 * チーム Issue 更新 API が返す response body です。
 */
type UpdateTeamIssueResponse = {
  /**
   * 更新した Issue 行です。
   */
  issue: TeamIssueResponseItem
}

/**
 * チーム Issue コメント作成 API が返す response body です。
 */
type CreateTeamIssueCommentResponse = {
  /**
   * 作成したコメントです。
   */
  comment: TeamIssueCommentResponseItem
  /**
   * コメント追加に対応する活動履歴です。
   */
  activity: TeamIssueActivityResponseItem
}

/**
 * プロジェクトタスク作成 API が受け取る request body です。
 */
type CreateProjectTaskRequestBody = {
  /**
   * ユーザーが入力したタスク名です。
   */
  title?: unknown
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId?: unknown
  /**
   * ユーザーが入力した担当者名です。旧 client 互換で利用します。
   */
  assignee?: unknown
  /**
   * タスク状態です。
   */
  status?: unknown
  /**
   * 期限日として保存する文字列です。
   */
  dueDate?: unknown
  /**
   * 優先度です。
   */
  priority?: unknown
}

/**
 * プロジェクトタスク作成 API が返す response body です。
 */
type CreateProjectTaskResponse = {
  /**
   * 作成したタスク行です。
   */
  task: ProjectTaskResponseItem
}

/**
 * プロジェクトタスク状態更新 API が受け取る request body です。
 */
type UpdateProjectTaskStatusRequestBody = {
  /**
   * 更新後のタスク状態です。
   */
  status?: unknown
  /**
   * canonical Work Item adapter が使う読み込み時点の revision です。
   */
  expectedRevision?: unknown
}

/**
 * プロジェクトタスク状態更新 API が返す response body です。
 */
type UpdateProjectTaskStatusResponse = {
  /**
   * 更新したタスク行です。
   */
  task: ProjectTaskResponseItem
}

/**
 * サイドバー上のプロジェクトを識別しやすくする表示色です。
 */
type ProjectTone = 'blue' | 'purple' | 'green' | 'yellow'

/**
 * DynamoDB に保存する team directory item です。
 */
type ProjectDirectoryTeamItem = {
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * チームとプロジェクトを並べ替える sort key です。
   */
  entryKey: string
  /**
   * item 種別です。
   */
  entryType: 'team'
  /**
   * 所属チーム ID です。
   */
  teamId: string
  /**
   * チームの表示順です。
   */
  teamSortOrder: number
  /**
   * 日本語表示名です。
   */
  nameJa: string
  /**
   * 英語表示名です。
   */
  nameEn: string
  /**
   * チーム配下を初期展開するかどうかです。
   */
  expanded?: boolean
  /**
   * アーカイブ済みの場合に設定する ISO 8601 timestamp です。
   */
  archivedAt?: string
}

/**
 * DynamoDB に保存する project directory item です。
 */
type ProjectDirectoryProjectItem = {
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * チームとプロジェクトを並べ替える sort key です。
   */
  entryKey: string
  /**
   * item 種別です。
   */
  entryType: 'project'
  /**
   * 所属チーム ID です。
   */
  teamId: string
  /**
   * チームの表示順です。
   */
  teamSortOrder: number
  /**
   * 日本語表示名です。
   */
  nameJa: string
  /**
   * 英語表示名です。
   */
  nameEn: string
  /**
   * プロジェクト ID です。
   */
  projectId: string
  /**
   * チーム内のプロジェクト表示順です。
   */
  projectSortOrder: number
  /**
   * サイドバー上のプロジェクト表示色です。
   */
  tone?: ProjectTone
  /**
   * アーカイブ済みの場合に設定する ISO 8601 timestamp です。
   */
  archivedAt?: string
}

/**
 * DynamoDB に保存する project member item です。
 */
type ProjectMemberItem = {
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * project/member を識別する sort key です。
   */
  entryKey: string
  /**
   * item 種別です。
   */
  entryType: 'project-member'
  /**
   * 所属プロジェクト ID です。
   */
  projectId: string
  /**
   * Cognito user を識別する正規化済み member key です。
   */
  memberKey: string
  /**
   * Cognito user のメールアドレスです。旧 item 互換の cache としてのみ利用します。
   */
  email?: string
  /**
   * 画面に表示するメンバー名です。旧 item 互換の cache としてのみ利用します。
   */
  name?: string
  /**
   * プロジェクト内の権限ロールです。
   */
  role: ProjectRole
  /**
   * member item の作成日時です。
   */
  createdAt: string
  /**
   * member item の更新日時です。
   */
  updatedAt: string
}

/**
 * DynamoDB に保存する team/project/member directory item です。
 */
type ProjectDirectoryItem = ProjectDirectoryTeamItem | ProjectDirectoryProjectItem | ProjectMemberItem

/**
 * サイドバーに表示するプロジェクト行です。
 */
type ProjectDirectoryProjectResponse = {
  /**
   * タスク一覧の projectId として使う一意な ID です。
   */
  id: string
  /**
   * サイドバーと画面タイトルに表示するプロジェクト名です。
   */
  name: string
  /**
   * サイドバー上のプロジェクトアイコン色です。
   */
  tone?: ProjectTone
}

/**
 * サイドバーに表示するチーム行です。
 */
type ProjectDirectoryTeamResponse = {
  /**
   * チームを識別する一意な ID です。
   */
  id: string
  /**
   * サイドバーに表示するチーム名です。
   */
  name: string
  /**
   * 初期表示時にチーム配下を展開するかどうかです。
   */
  expanded: boolean
  /**
   * チームに紐づくプロジェクト一覧です。
   */
  projects: ProjectDirectoryProjectResponse[]
}

/**
 * チーム/プロジェクト一覧 API が返す response body です。
 */
type ProjectDirectoryResponse = {
  /**
   * DB に登録されているチームとプロジェクトの階層です。
   */
  teams: ProjectDirectoryTeamResponse[]
}

/**
 * チーム作成 API が受け取る request body です。
 */
type CreateTeamRequestBody = {
  /**
   * locale 非依存で扱うチーム名です。
   */
  name?: unknown
  /**
   * 日本語表示名です。
   */
  nameJa?: unknown
  /**
   * 英語表示名です。
   */
  nameEn?: unknown
  /**
   * 初期表示時にチーム配下を展開するかどうかです。
   */
  expanded?: unknown
}

/**
 * チーム作成 API が返す response body です。
 */
type CreateTeamResponse = {
  /**
   * 作成したチーム行です。
   */
  team: ProjectDirectoryTeamResponse
}

/**
 * プロジェクト作成 API が受け取る request body です。
 */
type CreateProjectRequestBody = {
  /**
   * locale 非依存で扱うプロジェクト名です。
   */
  name?: unknown
  /**
   * 日本語表示名です。
   */
  nameJa?: unknown
  /**
   * 英語表示名です。
   */
  nameEn?: unknown
  /**
   * サイドバー上のプロジェクト表示色です。
   */
  tone?: unknown
}

/**
 * プロジェクト作成 API が返す response body です。
 */
type CreateProjectResponse = {
  /**
   * 作成したプロジェクト行です。
   */
  project: ProjectDirectoryProjectResponse
}

/**
 * チームアーカイブ API が返す response body です。
 */
type ArchiveTeamResponse = {
  /**
   * アーカイブしたチーム ID です。
   */
  teamId: string
  /**
   * アーカイブ日時の ISO 8601 timestamp です。
   */
  archivedAt: string
}

/**
 * プロジェクトアーカイブ API が返す response body です。
 */
type ArchiveProjectResponse = {
  /**
   * プロジェクトが所属していたチーム ID です。
   */
  teamId: string
  /**
   * アーカイブしたプロジェクト ID です。
   */
  projectId: string
  /**
   * アーカイブ日時の ISO 8601 timestamp です。
   */
  archivedAt: string
}

/**
 * プロジェクト権限管理画面に表示する member 行です。
 */
type ProjectMemberResponseItem = {
  /**
   * 正規化済み member key です。
   */
  id: string
  /**
   * Cognito user のメールアドレスです。
   */
  email: string
  /**
   * Cognito user pool 内の username です。
   */
  username?: string
  /**
   * 画面に表示するメンバー名です。
   */
  name?: string
  /**
   * Cognito user が有効かどうかです。
   */
  enabled?: boolean
  /**
   * Cognito user status です。
   */
  status?: string
  /**
   * Workspace membership の利用状態です。
   */
  workspaceStatus?: WorkspaceMemberStatus
  /**
   * プロジェクト内の権限ロールです。
   */
  role: ProjectRole
  /**
   * member item の更新日時です。
   */
  updatedAt: string
}

/**
 * プロジェクトメンバー一覧 API が返す response body です。
 */
type ProjectMembersResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * DynamoDB から取得した member 一覧です。
   */
  members: ProjectMemberResponseItem[]
}

/**
 * プロジェクトメンバー更新 API が受け取る request body です。
 */
type UpdateProjectMemberRequestBody = {
  /**
   * Cognito user を参照する ID です。
   */
  userId?: unknown
  /**
   * Cognito user のメールアドレスです。旧 client 互換で userId と同義に扱います。
   */
  email?: unknown
  /**
   * 表示名です。Cognito master 化後は保存せず無視します。
   */
  name?: unknown
  /**
   * 付与するプロジェクトロールです。
   */
  role?: unknown
}

/**
 * プロジェクトメンバー更新 API が返す response body です。
 */
type UpdateProjectMemberResponse = {
  /**
   * 更新した member 行です。
   */
  member: ProjectMemberResponseItem
}

/**
 * プロジェクトメンバー削除 API が返す response body です。
 */
type RemoveProjectMemberResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * 削除した member key です。
   */
  memberId: string
}

/**
 * API handler から利用する Cognito client の最小 interface です。
 */
type CognitoClient = {
  /**
   * メールアドレスとパスワードで Cognito 認証を実行します。
   */
  initiatePasswordAuth(email: string, password: string): Promise<InitiateAuthResponse>
  /**
   * NEW_PASSWORD_REQUIRED challenge に恒久 password を応答します。
   */
  respondToNewPasswordChallenge(
    email: string,
    newPassword: string,
    session: string,
  ): Promise<InitiateAuthResponse>
  /**
   * access token から Cognito ユーザー情報を取得します。
   */
  getUser(accessToken: string): Promise<GetUserResponse>
  /**
   * Cognito user pool から user 一覧を page 単位で取得します。
   */
  listUsers(input: ListCognitoUsersInput): Promise<CognitoUsersResponse>
  /**
   * Cognito user ID から user profile を取得します。
   */
  getUserProfile(userId: string): Promise<CognitoUserProfile>
  /**
   * Cognito user が現在 system administrator group に所属するかを返します。
   */
  isSystemAdmin(userId: string): Promise<boolean>
  /**
   * Workspace invitation 対象の Cognito user と directory 属性を検索します。
   */
  findWorkspaceUser(userId: string): Promise<CognitoWorkspaceUser | undefined>
  /**
   * invitation 対象 user を Cognito に作成または既存 identity と安全に関連付けます。
   */
  provisionWorkspaceUser(
    input: ProvisionCognitoWorkspaceUserInput,
  ): Promise<ProvisionCognitoWorkspaceUserResult>
  /**
   * Workspace が作成した未確定 Cognito user の invitation を再送します。
   */
  resendWorkspaceUserInvitation(userId: string): Promise<void>
  /**
   * Workspace が所有する未確定 Cognito user を削除します。
   */
  deleteWorkspaceUser(userId: string): Promise<void>
}

/**
 * API handler から利用するダッシュボード集計 client の最小 interface です。
 */
type DashboardSummaryClient = {
  /**
   * ユーザー directory の DynamoDB data からダッシュボード集計値を取得します。
   */
  getSummary(
    directoryId: string,
    accessContext: DashboardSummaryAccessContext,
  ): Promise<DashboardSummaryResponse>
}

/**
 * API handler から利用するプロジェクトタスク client の最小 interface です。
 */
type ProjectTasksClient = {
  /**
   * DynamoDB から指定 project ID のタスク一覧を取得します。
   */
  getProjectTasks(
    directoryId: string,
    projectId: string,
    options?: WorkItemListReadOptions,
  ): Promise<ProjectTasksResponse>
  /**
   * legacy mutation 呼び出しを read-only error として拒否します。
   */
  createProjectTask(
    directoryId: string,
    projectId: string,
    input: CreateProjectTaskRequestBody,
    auditContext?: MutationAuditContext,
  ): Promise<CreateProjectTaskResponse>
  /**
   * legacy mutation 呼び出しを read-only error として拒否します。
   */
  updateProjectTaskStatus(
    directoryId: string,
    projectId: string,
    taskId: string,
    input: UpdateProjectTaskStatusRequestBody,
    auditContext?: MutationAuditContext,
  ): Promise<UpdateProjectTaskStatusResponse>
}

/**
 * API handler から利用する team issue client の最小 interface です。
 */
type TeamIssuesClient = {
  /**
   * DynamoDB から指定 team ID の Issue 一覧を取得します。
   */
  getTeamIssues(
    directoryId: string,
    teamId: string,
    options?: WorkItemListReadOptions,
  ): Promise<TeamIssuesResponse>
  /**
   * Aggregate API 用に canonical Issue と非公開 migration metadata を取得します。
   */
  getTeamIssuesForAggregate(
    directoryId: string,
    teamId: string,
    options?: WorkItemListReadOptions,
  ): Promise<AggregateTeamIssuesRead>
  /**
   * Team / Issue base key 候補を一括取得し、stable migration source key を返します。
   */
  getTeamIssueMigrationSourceKeys(
    directoryId: string,
    keys: readonly TeamIssueMigrationLookupKey[],
  ): Promise<ReadonlySet<string>>
  /**
   * DynamoDB から指定 project ID にアサインされた Issue 一覧を取得します。
   */
  getProjectIssues(
    directoryId: string,
    projectId: string,
    options?: WorkItemListReadOptions,
  ): Promise<ProjectIssuesResponse>
  /**
   * DynamoDB から Issue 詳細、コメント、活動履歴を取得します。
   */
  getTeamIssueDetail(
    directoryId: string,
    teamId: string,
    issueId: string,
    options?: TeamIssueDetailReadOptions,
  ): Promise<TeamIssueDetailResponse>
  /**
   * DynamoDB に team issue を作成します。
   */
  createTeamIssue(
    directoryId: string,
    teamId: string,
    input: CreateTeamIssueRequestBody,
    actorUserId: string,
    reservedIssueIds?: string[],
    auditContext?: MutationAuditContext,
  ): Promise<CreateTeamIssueResponse>
  /**
   * DynamoDB の team issue を更新します。
   */
  updateTeamIssue(
    directoryId: string,
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueRequestBody,
    actorUserId: string,
    auditContext?: MutationAuditContext,
  ): Promise<UpdateTeamIssueResponse>
  /**
   * DynamoDB に team issue コメントを追加します。
   */
  createTeamIssueComment(
    directoryId: string,
    teamId: string,
    issueId: string,
    input: CreateTeamIssueCommentRequestBody,
    actorUserId: string,
    auditContext?: MutationAuditContext,
  ): Promise<CreateTeamIssueCommentResponse>
}

/** Team Issue detail の event 読み込み量と順序を制御します。 */
type TeamIssueDetailReadOptions = {
  /** Issue 本体を strongly consistent read で認可へ使う場合は true です。 */
  consistentIssueRead?: boolean
  /** 読み込む event の最大件数です。0 の場合は event partition を読みません。 */
  eventLimit?: number
  /** 新しい event から読み込む場合は true です。 */
  newestEventsFirst?: boolean
  /** 指定 event 種別だけを返す DynamoDB filter です。 */
  eventType?: TeamIssueActivityType
  /** 前 page が返した event cursor です。 */
  eventCursor?: string
}

/** Team Issue event page cursor の署名対象 payload です。 */
type TeamIssueEventCursor = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor を別 Issue へ流用できないよう束縛する partition key です。 */
  directoryTeamIssueId: string
  /** DynamoDB event sort key です。 */
  eventId: string
}

/**
 * API handler から利用する team/project directory client の最小 interface です。
 */
type ProjectDirectoryClient = {
  /**
   * DynamoDB から sidebar 用の team/project 階層を取得します。
   */
  getProjectDirectory(directoryId: string, locale: Locale): Promise<ProjectDirectoryResponse>
  /**
   * active project と指定 member の role を 1 directory read で取得します。
   */
  getProjectAccess(
    directoryId: string,
    projectId: string,
    memberKey: string,
  ): Promise<ProjectAccessEntry | undefined>
  /**
   * active project と指定 member の role を 1 directory read で取得します。
   */
  getProjectAccessList(directoryId: string, memberKey: string): Promise<ProjectAccessEntry[]>
  /**
   * ユーザーの directory に指定 project ID が含まれるかどうかを判定します。
   */
  hasProjectAccess(directoryId: string, projectId: string): Promise<boolean>
  /**
   * 指定ユーザーが持つ project role を DynamoDB から取得します。
   */
  getProjectRole(
    directoryId: string,
    projectId: string,
    memberKey: string,
  ): Promise<ProjectRole | undefined>
  /**
   * DynamoDB から project member 一覧を取得します。
   */
  getProjectMembers(directoryId: string, projectId: string): Promise<ProjectMembersResponse>
  /**
   * DynamoDB の project member role を作成または更新します。
   */
  updateProjectMember(
    directoryId: string,
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberRequestBody,
    expectedWorkspaceMemberVersion: number,
    auditContext?: MutationAuditContext,
  ): Promise<UpdateProjectMemberResponse>
  /**
   * DynamoDB から project member role を削除します。
   */
  removeProjectMember(
    directoryId: string,
    projectId: string,
    memberKey: string,
    auditContext?: MutationAuditContext,
  ): Promise<RemoveProjectMemberResponse>
  /**
   * DynamoDB にチームを作成します。
   */
  createTeam(
    directoryId: string,
    input: CreateTeamRequestBody,
    auditContext?: MutationAuditContext,
  ): Promise<CreateTeamResponse>
  /**
   * DynamoDB に指定チーム配下のプロジェクトを作成します。
   */
  createProject(
    directoryId: string,
    teamId: string,
    input: CreateProjectRequestBody,
    creator: ProjectCreatorContext,
    auditContext?: MutationAuditContext,
  ): Promise<CreateProjectResponse>
  /**
   * DynamoDB 上のチームをアーカイブします。
   */
  archiveTeam(
    directoryId: string,
    teamId: string,
    auditContext?: MutationAuditContext,
  ): Promise<ArchiveTeamResponse>
  /**
   * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
   */
  archiveProject(
    directoryId: string,
    teamId: string,
    projectId: string,
    auditContext?: MutationAuditContext,
  ): Promise<ArchiveProjectResponse>
}

/**
 * API handler から利用する append-only audit event query client です。
 */
type AuditEventsClient = {
  /**
   * workspace、actor、entity、target、期間で event を page 取得します。
   */
  query(input: AuditEventQuery): Promise<AuditEventPage>
}

/**
 * チーム/プロジェクト階層の表示 locale です。
 */
type Locale = 'ja' | 'en'

/**
 * Lambda handler、Bun dev server、server test で共有する Hono app です。
 */
export const app = new Hono()
let cognito: CognitoClient
let dashboardSummary: DashboardSummaryClient
let projectTasks: ProjectTasksClient
let teamIssues: TeamIssuesClient
let projectDirectory: ProjectDirectoryClient
let auditEvents: AuditEventsClient
let workspaceAccess: WorkspaceAccessClient
let realtimeTickets: RealtimeTicketsClient
let collaboration: CollaborationClient
let fileProofing: FileProofingClient
const projectDirectoryIdPrefix = 'user#'
const defaultAllowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:6006',
  'http://127.0.0.1:6006',
] as const
const defaultSystemAdminGroups = ['mukuroji-system-admins']
const projectRoleWeights = {
  viewer: 1,
  member: 2,
  manager: 3,
} as const satisfies Record<ProjectRole, number>

app.use(
  '/api/*',
  cors({
    origin: (origin) => getAllowedOrigins().includes(origin) ? origin : undefined,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id'],
    exposeHeaders: ['X-Audit-Truncated', 'X-Audit-Next-Cursor'],
  }),
)

app.get('/', (c) => {
  return c.text('mukuroji API')
})

app.get('/api/health', (c) => {
  return c.json({ ok: true })
})

/**
 * メールアドレスとパスワードで Cognito 認証を実行する login endpoint です。
 *
 * @remarks
 * `LoginRequestBody` の `email` は trim し、`email` と `password` の存在を検証します。
 * 成功時は `accessToken`, `idToken`, `refreshToken`, `expiresAt`, `tokenType` を返します。
 * 未入力は 400、未対応 challenge は 409、Cognito 由来の認証失敗や upstream failure は
 * `toAuthErrorResponse` に委譲します。
 */
app.post('/api/auth/login', async (c) => {
  const body = await readJson<LoginRequestBody>(c.req)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!email || !password) {
    return c.json({ message: 'Email and password are required.' }, 400)
  }

  try {
    const response = await cognito.initiatePasswordAuth(email, password)
    const tokens = response.AuthenticationResult

    if (!tokens?.AccessToken) {
      if (response.ChallengeName === 'NEW_PASSWORD_REQUIRED' && response.Session) {
        return c.json({
          challenge: 'NEW_PASSWORD_REQUIRED' as const,
          email,
          session: response.Session,
        })
      }

      return c.json(
        {
          message: response.ChallengeName
            ? `Unsupported Cognito challenge: ${response.ChallengeName}`
            : 'Cognito did not return an access token.',
        },
        409,
      )
    }

    return c.json(await createAuthenticationResponse(tokens))
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return toWorkspaceAccessErrorResponse(c, error)
    }

    return toAuthErrorResponse(c, error)
  }
})

/**
 * Cognito の NEW_PASSWORD_REQUIRED challenge を完了する endpoint です。
 *
 * @remarks
 * Cognito が password 更新に成功した後の Workspace membership reconcile は通常 login と
 * 同じ処理を通ります。DynamoDB 更新だけが失敗した場合も、新 password で login し直すと
 * reconcile を再実行できます。
 */
app.post('/api/auth/challenge/new-password', async (c) => {
  const body = await readJson<CompleteNewPasswordChallengeRequestBody>(c.req)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const session = typeof body?.session === 'string' ? body.session.trim() : ''
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''

  if (!email || !session || !newPassword) {
    return c.json({ message: 'Email, session, and new password are required.' }, 400)
  }

  try {
    const response = await cognito.respondToNewPasswordChallenge(email, newPassword, session)
    const tokens = response.AuthenticationResult

    if (!tokens?.AccessToken) {
      return c.json(
        {
          message: response.ChallengeName
            ? `Unsupported Cognito challenge: ${response.ChallengeName}`
            : 'Cognito did not return an access token.',
        },
        409,
      )
    }

    return c.json(await createAuthenticationResponse(tokens))
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return toWorkspaceAccessErrorResponse(c, error)
    }

    return toNewPasswordChallengeErrorResponse(c, error)
  }
})

/** Workspace member、invitation、capability の snapshot を返す endpoint です。 */
app.get('/api/workspace/access', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    return c.json(await workspaceAccess.getAccessSnapshot(principal.directoryId, principal.userKey))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toWorkspaceAccessErrorResponse(c, error)
  }
})

/** Workspace invitation を reservation して Cognito provisioning を開始する endpoint です。 */
app.post('/api/workspace/invitations', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceAdministration(principal)
    const body = await readJson<CreateWorkspaceInvitationRequestBody>(c.req)
    const email = readWorkspaceEmail(body?.email)
    const role = readWorkspaceRole(body?.role)
    const name = readOptionalWorkspaceName(body?.name)
    const invitation = await workspaceAccess.createInvitation(
      principal.directoryId,
      principal.userKey,
      {
        email,
        name,
        role,
      },
    )

    try {
      const result = await deliverPreparedWorkspaceInvitation(
        principal.directoryId,
        invitation,
      )
      const deliveredInvitation = await workspaceAccess.markInvitationDelivery(
        principal.directoryId,
        invitation.id,
        {
          expectedVersion: invitation.version,
          identityOwnership: result.identityOwnership,
          deliveryStatus: result.deliveryStatus,
        },
      )

      return c.json({ invitation: deliveredInvitation }, 201)
    } catch (error) {
      await markWorkspaceInvitationFailure(principal.directoryId, invitation, error)
      throw error
    }
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toWorkspaceAccessErrorResponse(c, error)
  }
})

/** Workspace invitation を再送する endpoint です。 */
app.post('/api/workspace/invitations/:invitationId/resend', async (c) => {
  return handleWorkspaceInvitationDeliveryAction(c, 'resend')
})

/** Workspace invitation を取り消す endpoint です。 */
app.post('/api/workspace/invitations/:invitationId/revoke', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceAdministration(principal)
    const invitationId = readWorkspaceEmail(c.req.param('invitationId'))
    let invitation = await workspaceAccess.revokeInvitation(
      principal.directoryId,
      principal.userKey,
      invitationId,
    )

    if (isWorkspaceIdentitySafeToDelete(invitation.identityOwnership)) {
      try {
        await cognito.deleteWorkspaceUser(invitation.email)
      } catch (error) {
        try {
          await workspaceAccess.markInvitationCleanupFailure(
            principal.directoryId,
            invitation.id,
            {
              expectedVersion: invitation.version,
              failureMessage: 'Cognito cleanup failed and can be retried safely.',
            },
          )
        } catch (markError) {
          console.error('Failed to persist Workspace invitation cleanup failure:', markError)
        }

        throw error
      }

      if (invitation.failureMessage) {
        invitation = await workspaceAccess.clearInvitationCleanupFailure(
          principal.directoryId,
          invitation.id,
          invitation.version,
        )
      }
    }

    return c.json({ invitation })
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toWorkspaceAccessErrorResponse(c, error)
  }
})

/** revoked / expired Workspace invitation を再招待する endpoint です。 */
app.post('/api/workspace/invitations/:invitationId/reinvite', async (c) => {
  return handleWorkspaceInvitationDeliveryAction(c, 'reinvite')
})

/** Workspace member の role または status を version 条件付きで更新する endpoint です。 */
app.patch('/api/workspace/members/:memberKey', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceAdministration(principal)
    const memberKey = readWorkspaceEmail(c.req.param('memberKey'))
    const body = await readJson<UpdateWorkspaceAccessMemberRequestBody>(c.req)
    const role = body?.role === undefined ? undefined : readWorkspaceRole(body.role)
    const status = body?.status === undefined ? undefined : readWorkspaceMemberStatus(body.status)
    const expectedVersion = readWorkspaceVersion(body?.expectedVersion)

    if (status === 'deactivated') {
      await requireWorkspaceMemberHasNoManagedProjects(principal.directoryId, memberKey)
    }

    const member = await workspaceAccess.updateMember(
      principal.directoryId,
      principal.userKey,
      memberKey,
      { role, status, expectedVersion },
    )

    return c.json({ member })
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toWorkspaceAccessErrorResponse(c, error)
  }
})

/**
 * Bearer access token から現在の Cognito ユーザー情報を返す endpoint です。
 *
 * @remarks
 * `Authorization: Bearer <accessToken>` header を要求し、形式が合わない場合は 401 を返します。
 * 成功時は `username` と Cognito user attributes の map を返します。
 * Cognito の `getUser` 失敗は `toAuthErrorResponse` に委譲します。
 */
app.get('/api/auth/me', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    validateConfiguredCognitoAccessToken(accessToken)
    const user = await cognito.getUser(accessToken)
    const principal = await authenticateWorkspacePrincipal(accessToken, user)

    return c.json({
      username: user.Username ?? '',
      attributes: Object.fromEntries(
        (user.UserAttributes ?? [])
          .filter((attribute) => attribute.Name && attribute.Value !== undefined)
          .map((attribute) => [attribute.Name as string, attribute.Value]),
      ),
      groups: principal.groups,
      isSystemAdmin: principal.isSystemAdmin,
      workspaceRole: principal.workspaceRole,
      workspaceMemberStatus: principal.workspaceMemberStatus,
    })
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return toWorkspaceAccessErrorResponse(c, error)
    }

    if (error instanceof ProjectDataError) {
      return toProjectDataErrorResponse(c, error)
    }

    return toAuthErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたダッシュボード集計値を返す endpoint です。
 *
 * @remarks
 * `Authorization: Bearer <accessToken>` header を要求し、Cognito で token を検証してから
 * DynamoDB の集計 item を読みます。React から Lambda/API Gateway 経由で呼ぶ想定の読み取り API です。
 */
app.get('/api/dashboard/summary', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)

    return c.json(await dashboardSummary.getSummary(principal.directoryId, principal))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * Workspace audit event を filter と cursor 付きで page 取得する endpoint です。
 */
app.get('/api/audit/events', async (c) => {
  return handleWorkspaceAuditRequest(c, false)
})

/**
 * Workspace audit event を NDJSON で同期 export する endpoint です。
 */
app.get('/api/audit/events/export', async (c) => {
  return handleWorkspaceAuditRequest(c, true)
})

/**
 * DynamoDB に保存されたチーム/プロジェクト階層を返す endpoint です。
 *
 * @remarks
 * サイドバー用の directory table を読み、`locale=en` のときだけ英語名を優先します。
 */
app.get('/api/teams/projects', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)

    return c.json(await projectDirectory.getProjectDirectory(principal.directoryId, readLocale(c)))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB にチームを新規作成する endpoint です。
 */
app.post('/api/teams', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceAdministration(principal)
    const body = await readJson<CreateTeamRequestBody>(c.req)

    return c.json(
      await projectDirectory.createTeam(
        principal.directoryId,
        body ?? {},
        createApiMutationContext(c, principal, body ?? {}),
      ),
      201,
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB にチーム配下のプロジェクトを新規作成する endpoint です。
 */
app.post('/api/teams/:teamId/projects', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceAdministration(principal)
    const body = await readJson<CreateProjectRequestBody>(c.req)

    return c.json(
      await projectDirectory.createProject(
        principal.directoryId,
        teamId,
        body ?? {},
        {
          userKey: principal.userKey,
          workspaceMemberVersion: principal.workspaceMember.version,
        },
        createApiMutationContext(c, principal, { teamId, ...body }),
      ),
      201,
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB 上のチームをアーカイブする endpoint です。
 */
app.patch('/api/teams/:teamId/archive', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceAdministration(principal)

    return c.json(
      await projectDirectory.archiveTeam(
        principal.directoryId,
        teamId,
        createApiMutationContext(c, principal, { teamId }),
      ),
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB 上のチーム配下プロジェクトをアーカイブする endpoint です。
 */
app.patch('/api/teams/:teamId/projects/:projectId/archive', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceAdministration(principal)

    return c.json(
      await projectDirectory.archiveProject(
        principal.directoryId,
        teamId,
        projectId,
        createApiMutationContext(c, principal, { teamId, projectId }),
      ),
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/** 現在 user の project watcher state を返します。 */
app.get('/api/projects/:projectId/watch', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }
  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    await requireProjectPermission(principal, projectId, 'viewer')
    const watch = await collaboration.getWatcherState({
      entityKey: createProjectCollaborationEntityKey(principal.directoryId, projectId),
      memberKey: principal.userKey,
    })
    return c.json({ watch })
  } catch (error) {
    return toCollaborationErrorResponse(c, error)
  }
})

for (const projectWatchMethod of ['PUT', 'DELETE'] as const) {
  /** Project watcher の subscribe/unsubscribe endpoint です。 */
  app.on(projectWatchMethod, '/api/projects/:projectId/watch', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const projectId = c.req.param('projectId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }
    if (!projectId) {
      return c.json({ message: 'Project ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      requireWorkspaceBusinessWrite(principal)
      await requireProjectPermission(principal, projectId, 'viewer')
      const mutationInput = {
        workspaceId: principal.directoryId,
        entityKey: createProjectCollaborationEntityKey(principal.directoryId, projectId),
        projectId,
        memberKey: principal.userKey,
        auditContext: createApiMutationContext(c, principal, { projectId, method: projectWatchMethod }),
      }
      const watch = projectWatchMethod === 'PUT'
        ? await collaboration.subscribe(mutationInput)
        : await collaboration.unsubscribe(mutationInput)
      return c.json({ watch })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })
}

/**
 * 現在ユーザーが参照できる canonical/legacy Work Item を Workspace 横断で返します。
 */
app.get('/api/work-items', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    return c.json(await hydrateWorkItemsResponse(
      await readAccessibleWorkItems(principal),
      principal.directoryId,
    ))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * canonical Work Item と legacy project task を統合したプロジェクト別一覧を返します。
 */
app.get('/api/projects/:projectId/tasks', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    await requireProjectPermission(principal, projectId, 'viewer')

    return c.json(await hydrateProjectTasksResponse(
      await readProjectTasks(principal.directoryId, projectId),
    ))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * Cognito user pool からプロジェクト権限付与候補 user を検索する endpoint です。
 */
app.get('/api/projects/:projectId/users', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    await requireProjectPermission(principal, projectId, 'manager')

    return c.json(await listActiveWorkspaceCognitoUsers(principal.directoryId, c))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたプロジェクトメンバー一覧を返す endpoint です。
 */
app.get('/api/projects/:projectId/members', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    await requireProjectPermission(principal, projectId, 'member')

    return c.json(
      await hydrateProjectMembersResponse(
        await projectDirectory.getProjectMembers(principal.directoryId, projectId),
        principal.directoryId,
      ),
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたプロジェクトメンバーの role を作成または更新する endpoint です。
 */
app.patch('/api/projects/:projectId/members/:memberKey', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')
  const memberKey = c.req.param('memberKey')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  if (!memberKey) {
    return c.json({ message: 'Member key is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    await requireProjectPermission(principal, projectId, 'manager')
    const body = await readJson<UpdateProjectMemberRequestBody>(c.req)
    const profile = await cognito.getUserProfile(memberKey)
    const workspaceMember = await workspaceAccess.getActiveMember(principal.directoryId, profile.id)

    if (!workspaceMember) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceMemberInactive',
        'Only active Workspace members can be assigned to a project.',
      )
    }

    return c.json(
      await hydrateProjectMemberUpdateResponse(
        await projectDirectory.updateProjectMember(
          principal.directoryId,
          projectId,
          profile.id,
          {
            ...body,
            email: profile.email,
            name: profile.name,
          },
          workspaceMember.version,
          createApiMutationContext(c, principal, {
            projectId,
            memberKey: profile.id,
            ...body,
          }),
        ),
        principal.directoryId,
      ),
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB からプロジェクトメンバーの role を削除する endpoint です。
 */
app.delete('/api/projects/:projectId/members/:memberKey', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')
  const memberKey = c.req.param('memberKey')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  if (!memberKey) {
    return c.json({ message: 'Member key is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    await requireProjectPermission(principal, projectId, 'manager')

    return c.json(
      await projectDirectory.removeProjectMember(
        principal.directoryId,
        projectId,
        memberKey,
        createApiMutationContext(c, principal, { projectId, memberKey }),
      ),
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたチーム所有 Issue 一覧を返す endpoint です。
 */
app.get('/api/teams/:teamId/issues', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const context = await requireTeamPermission(principal, teamId, 'viewer')

    return c.json(await hydrateTeamIssuesResponse(await readTeamIssues(principal.directoryId, context, principal)))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB にチーム所有 Issue を新規作成する endpoint です。
 */
app.post('/api/teams/:teamId/issues', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const context = await requireTeamPermission(principal, teamId, 'member')
    const body = normalizeTeamIssueInput(
      await readJson<CreateTeamIssueRequestBody>(c.req) ?? {},
      context.team,
    )
    requireAssignedProjectPermission(principal, context, body.assignedProjectId, 'member')
    const assigneeUserId = readTeamIssueAssigneeUserId(body)
    await requireActiveWorkspaceAssignee(principal.directoryId, assigneeUserId)
    const reservedIssueIds = await readLegacyTeamIssueIds(principal.directoryId, context)

    return c.json(
      await hydrateCreateTeamIssueResponse(
        await teamIssues.createTeamIssue(
          principal.directoryId,
          teamId,
          {
            ...body,
            assigneeUserId,
          },
          principal.userKey,
          reservedIssueIds,
          createApiMutationContext(c, principal, { teamId, ...body }),
        ),
      ),
      201,
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたチーム所有 Issue の paginated activity を返す endpoint です。
 */
app.get('/api/teams/:teamId/issues/:issueId/activity', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId || !issueId) {
    return c.json({ message: 'Team ID and issue ID are required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const context = await requireTeamPermission(principal, teamId, 'viewer')
    let entityId = createTeamIssueAuditEntityId(teamId, issueId)

    try {
      const detail = await teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        issueId,
        { consistentIssueRead: true },
      )
      requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'viewer')
    } catch (error) {
      if (!isTeamIssueNotFoundError(error)) {
        throw error
      }

      const legacyIssue = await readLegacyTeamIssue(
        principal.directoryId,
        context,
        principal,
        issueId,
      )

      if (!legacyIssue?.assignedProjectId) {
        throw error
      }

      entityId = createProjectTaskAuditEntityId(legacyIssue.assignedProjectId, issueId)
    }

    const page = await auditEvents.query(
      readAuditEventQuery(c, principal.directoryId, {
        type: 'work-item',
        id: entityId,
      }),
    )

    return c.json(toAuditEventPageView(page))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    if (error instanceof TypeError || error instanceof RangeError) {
      return c.json({ message: error.message }, 400)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたチーム所有 Issue 詳細を返す endpoint です。
 */
app.get('/api/teams/:teamId/issues/:issueId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId || !issueId) {
    return c.json({ message: 'Team ID and issue ID are required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const context = await requireTeamPermission(principal, teamId, 'viewer')

    try {
      const detail = await teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        issueId,
        { consistentIssueRead: true },
      )
      requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'viewer')
      const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId)
      const projectEntityKey = detail.issue.assignedProjectId
        ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
        : undefined
      const collaborationPreview = await collaboration.getThread({
        entityKey,
        viewerMemberKey: principal.userKey,
        projectEntityKey,
        limit: 50,
        includeScopeState: false,
      })

      return c.json(
        await hydrateTeamIssueDetailResponse(
          {
            ...detail,
            comments: mergeLegacyCompatibleComments(
              detail.comments,
              collaborationPreview.comments,
            ),
          },
          principal.directoryId,
        ),
      )
    } catch (error) {
      if (isTeamIssueNotFoundError(error)) {
        const legacyIssue = await readLegacyTeamIssue(principal.directoryId, context, principal, issueId)

        if (legacyIssue) {
          return c.json(
            await hydrateTeamIssueDetailResponse(
              {
                issue: legacyIssue,
                comments: [],
                activity: [],
              },
              principal.directoryId,
            ),
          )
        }
      }

      throw error
    }
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたチーム所有 Issue を更新する endpoint です。
 */
app.patch('/api/teams/:teamId/issues/:issueId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId || !issueId) {
    return c.json({ message: 'Team ID and issue ID are required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const context = await requireTeamPermission(principal, teamId, 'member')
    const body = normalizeTeamIssueInput(
      await readJson<UpdateTeamIssueRequestBody>(c.req) ?? {},
      context.team,
    )
    const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
    let detail: TeamIssueDetailResponse

    try {
      detail = await teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        issueId,
        { consistentIssueRead: true, eventLimit: 0 },
      )
    } catch (error) {
      if (isTeamIssueNotFoundError(error)) {
        const legacyIssue = await readLegacyTeamIssue(
          principal.directoryId,
          context,
          principal,
          issueId,
        )

        if (legacyIssue) {
          throw createLegacyProjectTaskReadOnlyError()
        }
      }

      throw error
    }
    requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'member')
    requireAssignedProjectPermission(principal, context, body.assignedProjectId, 'member')

    if ('assigneeUserId' in body) {
      await requireActiveWorkspaceAssignee(
        principal.directoryId,
        readTeamIssueAssigneeUserId(body),
      )
    }

    return c.json(
      await hydrateUpdateTeamIssueResponse(
        await teamIssues.updateTeamIssue(
          principal.directoryId,
          teamId,
          issueId,
          { ...body, expectedRevision },
          principal.userKey,
          createApiMutationContext(c, principal, {
            teamId,
            issueId,
            ...body,
            expectedRevision,
          }),
        ),
      ),
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/** 一度の legacy collaboration page で評価する旧 event の最大件数です。 */
const LEGACY_COLLABORATION_EVENT_PREVIEW_LIMIT = 50
/** Root page cursor と legacy event cursor を区別する接頭辞です。 */
const LEGACY_COLLABORATION_CURSOR_PREFIX = 'legacy.'

/**
 * Team-owned Work Item の root comments、replies、watch、presence を page 取得します。
 */
app.get('/api/teams/:teamId/issues/:issueId/collaboration', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId || !issueId) {
    return c.json({ message: 'Team ID and issue ID are required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId)
    const projectEntityKey = detail.issue.assignedProjectId
      ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
      : undefined
    const limitValue = c.req.query('limit')
    const limit = limitValue === undefined ? undefined : Number(limitValue)
    const requestedRootCommentId = c.req.query('rootCommentId')
    const requestedCursor = c.req.query('cursor')
    const isLegacyPage = !requestedRootCommentId &&
      requestedCursor?.startsWith(LEGACY_COLLABORATION_CURSOR_PREFIX) === true
    const legacyEventCursor = isLegacyPage
      ? requestedCursor.slice(LEGACY_COLLABORATION_CURSOR_PREFIX.length)
      : undefined
    if (isLegacyPage && !legacyEventCursor) {
      throw new CollaborationError(400, 'InvalidCollaborationCursor', 'Legacy comment cursor is invalid.')
    }
    const canWrite = canWriteTeamIssue(principal, context, detail.issue.assignedProjectId)

    if (requestedRootCommentId) {
      const replies = await collaboration.getThread({
        entityKey,
        viewerMemberKey: principal.userKey,
        projectEntityKey,
        rootCommentId: readOptionalCommentId(requestedRootCommentId, 'Root comment ID'),
        cursor: requestedCursor,
        limit: limit === undefined ? 20 : Math.min(limit, 20),
      })
      return c.json({
        // Store は最新順で page し、thread 内は古い順に描画できるよう反転して返す。
        comments: [...replies.comments].reverse().map((comment) =>
          toCollaborationCommentResponse(
            comment,
            principal,
            context,
            detail.issue,
            replies.threadResolved === true,
          )
        ),
        ...(replies.nextCursor ? { nextCursor: replies.nextCursor } : {}),
        replyRootCommentId: requestedRootCommentId,
        watch: replies.watch,
        presence: replies.presence,
        capabilities: {
          canComment: canWrite,
          canReact: canWrite,
          canWatch: principal.workspaceRole !== 'guest',
        },
      })
    }

    const roots = await collaboration.getThread({
      entityKey,
      viewerMemberKey: principal.userKey,
      projectEntityKey,
      cursor: isLegacyPage ? undefined : requestedCursor,
      limit: isLegacyPage ? 1 : limit === undefined ? 10 : Math.min(limit, 20),
    })
    const replyPages = await Promise.all(
      (isLegacyPage ? [] : roots.comments).map((root) => collaboration.getThread({
        entityKey,
        viewerMemberKey: principal.userKey,
        projectEntityKey,
        rootCommentId: root.id,
        limit: 5,
        includeScopeState: false,
      })),
    )
    const comments = (isLegacyPage ? [] : roots.comments).flatMap((root, index) => [
      root,
      ...[...(replyPages[index]?.comments ?? [])].reverse(),
    ])
    const storedCommentIds = new Set(comments.map((comment) => comment.id))
    const legacyDetail = isLegacyPage || !roots.nextCursor
      ? await teamIssues.getTeamIssueDetail(
          principal.directoryId,
          teamId,
          issueId,
          {
            consistentIssueRead: true,
            eventLimit: LEGACY_COLLABORATION_EVENT_PREVIEW_LIMIT,
            newestEventsFirst: true,
            eventType: 'commented',
            eventCursor: legacyEventCursor,
          },
        )
      : undefined
    if (legacyDetail) {
      requireAssignedProjectPermission(
        principal,
        context,
        legacyDetail.issue.assignedProjectId,
        'viewer',
      )
      if (legacyDetail.issue.assignedProjectId !== detail.issue.assignedProjectId) {
        throw new CollaborationError(
          409,
          'CollaborationConflict',
          'Work Item assignment changed while comments were loading.',
        )
      }
    }
    const legacyComments = (legacyDetail?.comments ?? [])
      .filter((comment) => !storedCommentIds.has(comment.id)).map((comment) => ({
          id: comment.id,
          rootCommentId: comment.id,
          authorMemberKey: comment.actorUserId,
          bodyMarkdown: comment.body,
          version: 1,
          mentionMemberKeys: [],
          createdAt: comment.createdAt,
          updatedAt: comment.createdAt,
          reactions: [],
          source: 'legacy' as const,
          capabilities: {
            canEdit: false,
            canDelete: false,
            canResolve: false,
            canReply: false,
            canReact: false,
          },
        }))
    const collaborationComments = [
      ...comments.map((comment) =>
        toCollaborationCommentResponse(
          comment,
          principal,
          context,
          detail.issue,
          replyPages.some((page, index) =>
            roots.comments[index]?.id === comment.rootCommentId && page.threadResolved === true
          ),
        ),
      ),
      ...legacyComments,
    ]
    const replyNextCursors = Object.fromEntries(
      (isLegacyPage ? [] : roots.comments).flatMap((root, index) => {
        const cursor = replyPages[index]?.nextCursor
        return cursor ? [[root.id, cursor] as const] : []
      }),
    )
    const nextCursor = !isLegacyPage && roots.nextCursor
      ? roots.nextCursor
      : legacyDetail?.nextEventCursor
        ? `${LEGACY_COLLABORATION_CURSOR_PREFIX}${legacyDetail.nextEventCursor}`
        : undefined

    return c.json({
      comments: collaborationComments,
      ...(nextCursor ? { nextCursor } : {}),
      ...(Object.keys(replyNextCursors).length > 0 ? { replyNextCursors } : {}),
      watch: roots.watch,
      presence: roots.presence,
      capabilities: {
        canComment: canWrite,
        canReact: canWrite,
        canWatch: principal.workspaceRole !== 'guest',
      },
    })
  } catch (error) {
    return toCollaborationErrorResponse(c, error)
  }
})

/**
 * DynamoDB にチーム所有 Issue のコメントを作成する endpoint です。
 */
app.post('/api/teams/:teamId/issues/:issueId/comments', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId || !issueId) {
    return c.json({ message: 'Team ID and issue ID are required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const body = await readJson<CreateTeamIssueCommentRequestBody>(c.req) ?? {}
    const modernContract = body.bodyMarkdown !== undefined
    const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'member')
    const mentionMemberKeys = readCommentMentionMemberKeys(body.mentionMemberKeys)
    await requireValidCommentMentions(
      principal.directoryId,
      mentionMemberKeys,
      context,
      detail.issue.assignedProjectId,
    )
    const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId)
    const projectEntityKey = detail.issue.assignedProjectId
      ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
      : undefined
    const automaticWatcherCandidates = createTeamIssueAutomaticWatcherCandidates(detail.issue)
    const comment = await collaboration.createComment({
      workspaceId: principal.directoryId,
      teamId,
      issueId,
      entityKey,
      projectId: detail.issue.assignedProjectId,
      projectEntityKey,
      actorMemberKey: principal.userKey,
      bodyMarkdown: readRequiredCommentBody(modernContract ? body.bodyMarkdown : body.body),
      parentCommentId: readOptionalCommentId(body.parentCommentId, 'Parent comment ID'),
      mentionMemberKeys,
      automaticWatcherCandidates,
      deepLink: `/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`,
      auditContext: createApiMutationContext(c, principal, { teamId, issueId, ...body }),
    })
    const activity = {
      id: comment.id,
      type: 'commented' as const,
      actorUserId: principal.userKey,
      summary: body.parentCommentId ? 'Reply was added.' : 'Comment was added.',
      createdAt: comment.createdAt,
    }

    return modernContract
      ? c.json({
          comment: toCollaborationCommentResponse(comment, principal, context, detail.issue),
          activity,
        }, 201)
      : c.json({
          comment: {
            id: comment.id,
            actorUserId: comment.authorMemberKey,
            body: comment.bodyMarkdown,
            createdAt: comment.createdAt,
          },
          activity,
        }, 201)
  } catch (error) {
    return toCollaborationErrorResponse(c, error)
  }
})

/** 保存済み comment の Markdown 本文と mention を更新します。 */
app.patch('/api/teams/:teamId/issues/:issueId/comments/:commentId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')
  const commentId = c.req.param('commentId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const body = await readJson<UpdateTeamIssueCommentRequestBody>(c.req) ?? {}
    const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    const mentionMemberKeys = readCommentMentionMemberKeys(body.mentionMemberKeys)
    await requireValidCommentMentions(
      principal.directoryId,
      mentionMemberKeys,
      context,
      detail.issue.assignedProjectId,
    )
    const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId)
    const projectEntityKey = detail.issue.assignedProjectId
      ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
      : undefined
    const automaticWatcherCandidates = createTeamIssueAutomaticWatcherCandidates(detail.issue)
    const comment = await collaboration.updateComment({
      workspaceId: principal.directoryId,
      teamId,
      issueId,
      entityKey,
      projectId: detail.issue.assignedProjectId,
      projectEntityKey,
      actorMemberKey: principal.userKey,
      commentId,
      bodyMarkdown: readRequiredCommentBody(body.bodyMarkdown),
      mentionMemberKeys,
      automaticWatcherCandidates,
      expectedVersion: readCommentExpectedVersion(body.expectedVersion),
      deepLink: `/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`,
      auditContext: createApiMutationContext(c, principal, { teamId, issueId, commentId, ...body }),
    })

    return c.json({
      comment: toCollaborationCommentResponse(comment, principal, context, detail.issue),
    })
  } catch (error) {
    return toCollaborationErrorResponse(c, error)
  }
})

/** 保存済み comment を soft delete します。 */
app.delete('/api/teams/:teamId/issues/:issueId/comments/:commentId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')
  const commentId = c.req.param('commentId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    const body = await readJson<VersionedTeamIssueCommentRequestBody>(c.req) ?? {}
    const canModerate = canManageTeamIssueCollaboration(
      principal,
      context,
      detail.issue.assignedProjectId,
    )
    const comment = await collaboration.deleteComment({
      workspaceId: principal.directoryId,
      teamId,
      issueId,
      entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
      projectId: detail.issue.assignedProjectId,
      projectEntityKey: detail.issue.assignedProjectId
        ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
        : undefined,
      actorMemberKey: principal.userKey,
      commentId,
      expectedVersion: readCommentExpectedVersion(body.expectedVersion),
      canModerate,
      auditContext: createApiMutationContext(c, principal, { teamId, issueId, commentId, ...body }),
    })

    return c.json({
      comment: toCollaborationCommentResponse(comment, principal, context, detail.issue),
    })
  } catch (error) {
    return toCollaborationErrorResponse(c, error)
  }
})

for (const resolutionAction of ['resolve', 'reopen'] as const) {
  /** Root comment thread の resolve/reopen endpoint です。 */
  app.post(`/api/teams/:teamId/issues/:issueId/comments/:commentId/${resolutionAction}`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')
    const commentId = c.req.param('commentId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      requireWorkspaceBusinessWrite(principal)
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      const body = await readJson<VersionedTeamIssueCommentRequestBody>(c.req) ?? {}
      const isAssignee = detail.issue.assigneeUserId === principal.userKey
      const canModerate = canManageTeamIssueCollaboration(
        principal,
        context,
        detail.issue.assignedProjectId,
      ) || isAssignee
      const mutationInput = {
        workspaceId: principal.directoryId,
        teamId,
        issueId,
        entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
        projectId: detail.issue.assignedProjectId,
        projectEntityKey: detail.issue.assignedProjectId
          ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
          : undefined,
        assigneeMemberKey: detail.issue.assigneeUserId,
        actorMemberKey: principal.userKey,
        commentId,
        expectedVersion: readCommentExpectedVersion(body.expectedVersion),
        canModerate,
        auditContext: createApiMutationContext(c, principal, {
          teamId,
          issueId,
          commentId,
          action: resolutionAction,
          ...body,
        }),
      }
      const comment = resolutionAction === 'resolve'
        ? await collaboration.resolveComment(mutationInput)
        : await collaboration.reopenComment(mutationInput)

      return c.json({
        comment: toCollaborationCommentResponse(comment, principal, context, detail.issue),
      })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })
}

for (const reactionMethod of ['PUT', 'DELETE'] as const) {
  /** Emoji reaction の idempotent add/remove endpoint です。 */
  app.on(reactionMethod, '/api/teams/:teamId/issues/:issueId/comments/:commentId/reactions/:emoji', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')
    const commentId = c.req.param('commentId')
    const emoji = c.req.param('emoji')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      requireWorkspaceBusinessWrite(principal)
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'member')
      const mutationInput = {
        workspaceId: principal.directoryId,
        teamId,
        issueId,
        entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
        projectId: detail.issue.assignedProjectId,
        projectEntityKey: detail.issue.assignedProjectId
          ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
          : undefined,
        actorMemberKey: principal.userKey,
        commentId,
        emoji,
        auditContext: createApiMutationContext(c, principal, {
          teamId,
          issueId,
          commentId,
          emoji,
          method: reactionMethod,
        }),
      }

      if (reactionMethod === 'PUT') {
        await collaboration.addReaction(mutationInput)
      } else {
        await collaboration.removeReaction(mutationInput)
      }

      return c.json({})
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })
}

/** 現在 user の Work Item watcher state を返します。 */
app.get('/api/teams/:teamId/issues/:issueId/watch', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    const watch = await collaboration.getWatcherState({
      entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
      memberKey: principal.userKey,
      projectEntityKey: detail.issue.assignedProjectId
        ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
        : undefined,
    })
    return c.json({ watch })
  } catch (error) {
    return toCollaborationErrorResponse(c, error)
  }
})

for (const watchMethod of ['PUT', 'DELETE'] as const) {
  /** Work Item watcher の subscribe/unsubscribe endpoint です。 */
  app.on(watchMethod, '/api/teams/:teamId/issues/:issueId/watch', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      requireWorkspaceBusinessWrite(principal)
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      const mutationInput = {
        workspaceId: principal.directoryId,
        teamId,
        issueId,
        entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
        projectId: detail.issue.assignedProjectId,
        projectEntityKey: detail.issue.assignedProjectId
          ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
          : undefined,
        memberKey: principal.userKey,
        auditContext: createApiMutationContext(c, principal, {
          teamId,
          issueId,
          method: watchMethod,
        }),
      }
      const watch = watchMethod === 'PUT'
        ? await collaboration.subscribe(mutationInput)
        : await collaboration.unsubscribe(mutationInput)
      return c.json({ watch })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })
}

/** Work Item presence/typing heartbeat を更新します。 */
app.put('/api/teams/:teamId/issues/:issueId/presence', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    const body = await readJson<TeamIssuePresenceRequestBody>(c.req) ?? {}
    const typing = readPresenceTyping(body.typing)

    if (typing && !canWriteTeamIssue(principal, context, detail.issue.assignedProjectId)) {
      throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'Comment permission is required.')
    }

    await collaboration.heartbeatPresence({
      entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
      memberKey: principal.userKey,
      clientId: readPresenceClientId(body.clientId),
      typing,
    })
    return c.json({})
  } catch (error) {
    return toCollaborationErrorResponse(c, error)
  }
})

/** Browser tab の Work Item presence を削除します。 */
app.delete('/api/teams/:teamId/issues/:issueId/presence/:clientId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    await collaboration.leavePresence({
      entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
      memberKey: principal.userKey,
      clientId: readPresenceClientId(c.req.param('clientId')),
    })
    return c.json({})
  } catch (error) {
    return toCollaborationErrorResponse(c, error)
  }
})

/**
 * 認証・認可済み Work Item scope 用の one-time Realtime ticket を発行します。
 */
app.post('/api/realtime/tickets', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const body = await readJson<CreateRealtimeTicketRequestBody>(c.req) ?? {}
    const teamId = readRequiredString(body.teamId, 'Team ID is required.')
    const issueId = readRequiredString(body.issueId, 'Issue ID is required.')
    const context = await requireTeamPermission(principal, teamId, 'viewer')
    const detail = await teamIssues.getTeamIssueDetail(principal.directoryId, teamId, issueId)
    requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'viewer')

    return c.json(
      await realtimeTickets.createTicket({
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
        teamId,
        issueId,
        projectId: detail.issue.assignedProjectId,
        systemAdmin: principal.isSystemAdmin,
        canWrite: canWriteTeamIssue(principal, context, detail.issue.assignedProjectId),
        scopeKey: createWorkItemCollaborationEntityKey(
          principal.directoryId,
          teamId,
          issueId,
        ),
      }),
      201,
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    if (error instanceof RealtimeTicketError) {
      const status = error.status === 400 || error.status === 403 || error.status === 503
        ? error.status
        : 503

      return c.json({ code: error.code, message: error.message }, status)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

const fileCollectionRoutes = [
  {
    basePath: '/api/teams/:teamId/issues/:issueId/files',
    kind: 'work-item',
  },
  {
    basePath: '/api/teams/:teamId/projects/:projectId/files',
    kind: 'project',
  },
] as const

for (const fileRoute of fileCollectionRoutes) {
  /** Work Item または Team scoped Project の file/approval 一覧 endpoint です。 */
  app.get(fileRoute.basePath, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      return c.json(await fileProofing.list(scope, actor))
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Work Item または Project へ新規 file upload session を作成する endpoint です。 */
  app.post(`${fileRoute.basePath}/uploads`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const body = await readFileProofingJson<CreateFileUploadInput>(c.req)
      return c.json(
        await fileProofing.createUpload(
          scope,
          actor,
          body,
          createApiMutationContext(c, principal, body),
        ),
        201,
      )
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** 既存 file の新 version upload session を作成する endpoint です。 */
  app.post(`${fileRoute.basePath}/:fileId/versions`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const body = await readFileProofingJson<CreateFileUploadInput>(c.req)
      return c.json(
        await fileProofing.createVersionUpload(
          scope,
          actor,
          readRequiredRouteId(c.req.param('fileId'), 'File ID'),
          body,
          createApiMutationContext(c, principal, body),
        ),
        201,
      )
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Direct upload 完了後に object metadata と scan state を検証する endpoint です。 */
  app.post(`${fileRoute.basePath}/:fileId/versions/:versionId/complete`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const input = {
        fileId: readRequiredRouteId(c.req.param('fileId'), 'File ID'),
        versionId: readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
      }
      return c.json(await fileProofing.completeUpload(
        scope,
        actor,
        input.fileId,
        input.versionId,
        createApiMutationContext(c, principal, input),
      ))
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Clean version の短命 preview/download URL を発行する endpoint です。 */
  app.get(`${fileRoute.basePath}/:fileId/versions/:versionId/access`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const disposition = c.req.query('disposition') === 'attachment' ? 'attachment' : 'inline'
      const input = {
        fileId: readRequiredRouteId(c.req.param('fileId'), 'File ID'),
        versionId: readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
        disposition,
      } as const
      return c.json(await fileProofing.createAccess(
        scope,
        actor,
        input.fileId,
        input.versionId,
        disposition,
        createApiMutationContext(c, principal, input),
      ))
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Version の位置 annotation 一覧 endpoint です。 */
  app.get(`${fileRoute.basePath}/:fileId/versions/:versionId/annotations`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      return c.json({
        annotations: await fileProofing.listAnnotations(
          scope,
          actor,
          readRequiredRouteId(c.req.param('fileId'), 'File ID'),
          readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
        ),
      })
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Version preview 上へ位置 annotation を作成する endpoint です。 */
  app.post(`${fileRoute.basePath}/:fileId/versions/:versionId/annotations`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const body = await readFileProofingJson<CreateFileAnnotationInput>(c.req)
      return c.json({
        annotation: await fileProofing.createAnnotation(
          scope,
          actor,
          readRequiredRouteId(c.req.param('fileId'), 'File ID'),
          readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
          body,
          createApiMutationContext(c, principal, body),
        ),
      }, 201)
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** File を retention 付きで soft delete する endpoint です。 */
  app.delete(`${fileRoute.basePath}/:fileId`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const fileId = readRequiredRouteId(c.req.param('fileId'), 'File ID')
      await fileProofing.deleteFile(
        scope,
        actor,
        fileId,
        createApiMutationContext(c, principal, { fileId }),
      )
      return c.body(null, 204)
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })
}

/** 保存済み comment へ file を添付する direct upload session endpoint です。 */
app.post('/api/teams/:teamId/issues/:issueId/comments/:commentId/files/uploads', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const context = await loadFileProofingRequestContext(c, principal, 'work-item')
    const commentId = readRequiredRouteId(c.req.param('commentId'), 'Comment ID')
    const hasAttachableComment = collaboration.hasAttachableComment
    if (!hasAttachableComment) {
      throw new FileProofingError(
        503,
        'CommentAttachmentUnavailable',
        'Comment attachment validation is unavailable.',
      )
    }
    const commentExists = await hasAttachableComment.call(
      collaboration,
      createWorkItemCollaborationEntityKey(
        principal.directoryId,
        context.scope.teamId,
        context.scope.issueId!,
      ),
      commentId,
    )
    if (!commentExists) {
      throw new FileProofingError(
        404,
        'CommentNotFound',
        'The attachment target comment was not found.',
      )
    }
    const scope = {
      ...context.scope,
      commentId,
    }
    const body = await readFileProofingJson<CreateFileUploadInput>(c.req)
    return c.json(
      await fileProofing.createUpload(
        scope,
        context.actor,
        body,
        createApiMutationContext(c, principal, { ...body, commentId: scope.commentId }),
      ),
      201,
    )
  } catch (error) {
    return toFileProofingErrorResponse(c, error)
  }
})

/** Work Item file version の approval request を作成する endpoint です。 */
app.post('/api/teams/:teamId/issues/:issueId/approvals', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const { scope, actor } = await loadFileProofingRequestContext(
      c,
      principal,
      'work-item',
    )
    const body = await readFileProofingJson<CreateFileApprovalInput>(c.req)
    if (
      !Array.isArray(body.reviewerMemberKeys) ||
      body.reviewerMemberKeys.length === 0 ||
      body.reviewerMemberKeys.length > FILE_APPROVAL_MAX_REVIEWERS ||
      body.reviewerMemberKeys.some((memberKey) =>
        typeof memberKey !== 'string' || !memberKey.trim() || memberKey.length > 320
      )
    ) {
      throw new FileProofingError(400, 'InvalidApprovalReviewers', 'Approval reviewers are required.')
    }
    const reviewerMemberKeys = [...new Set(
      body.reviewerMemberKeys.map((memberKey) => memberKey.trim().toLowerCase()),
    )]
    if (reviewerMemberKeys.length > FILE_APPROVAL_MAX_REVIEWERS) {
      throw new FileProofingError(400, 'InvalidApprovalReviewers', 'Too many approval reviewers.')
    }
    const collection = await fileProofing.list(scope, actor)
    const targetFile = collection.files.find((file) => file.id === body.fileId)
    if (!targetFile || targetFile.currentVersion.id !== body.versionId) {
      throw new FileProofingError(
        409,
        'ApprovalVersionStale',
        'Approval must target the current file version.',
      )
    }
    const reviewerMembers = await Promise.all(reviewerMemberKeys.map(async (memberKey) => {
      const member = await workspaceAccess.getActiveMember(principal.directoryId, memberKey)
      if (!member) {
        throw new FileProofingError(
          409,
          'ApprovalReviewerInactive',
          `Reviewer "${memberKey}" is not an active Workspace member.`,
        )
      }
      const reviewerIsSystemAdmin = await cognito.isSystemAdmin(member.memberKey)
      if (scope.projectId && !reviewerIsSystemAdmin) {
        const projectAccess = await projectDirectory.getProjectAccess(
          principal.directoryId,
          scope.projectId,
          member.memberKey,
        )
        if (!projectAccess || !projectAccessAllows(projectAccess, 'viewer')) {
          throw new FileProofingError(
            409,
            'ApprovalReviewerAccessDenied',
            `Reviewer "${memberKey}" cannot view the assigned project.`,
          )
        }
      } else if (!scope.projectId && !reviewerIsSystemAdmin) {
        const directory = await projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
        const teamProjectIds = new Set(
          directory.teams.find((team) => team.id === scope.teamId)?.projects
            .map((project) => project.id) ?? [],
        )
        const projectAccesses = await projectDirectory.getProjectAccessList(
          principal.directoryId,
          member.memberKey,
        )
        if (!projectAccesses.some((access) =>
          teamProjectIds.has(access.projectId) && projectAccessAllows(access, 'viewer')
        )) {
          throw new FileProofingError(
            409,
            'ApprovalReviewerAccessDenied',
            `Reviewer "${memberKey}" cannot view the Work Item team.`,
          )
        }
      }
      return member
    }))
    if (reviewerMembers.some((member) => member.role === 'guest')) {
      if (!targetFile?.guestAccess) {
        throw new FileProofingError(
          409,
          'ApprovalGuestFileAccessDenied',
          'Guest reviewers require an explicitly guest-shared file.',
        )
      }
    }
    const input = {
      ...body,
      reviewerMemberKeys,
      completionTransition: body.completionTransition ?? 'done',
    } satisfies CreateFileApprovalInput
    return c.json({
      approval: await fileProofing.createApproval(
        scope,
        actor,
        input,
        createApiMutationContext(c, principal, input),
      ),
    }, 201)
  } catch (error) {
    return toFileProofingErrorResponse(c, error)
  }
})

/** Assigned reviewer の approval decision を保存する endpoint です。 */
app.post('/api/teams/:teamId/issues/:issueId/approvals/:approvalId/decisions', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const { scope, actor, workItemRevision } = await loadFileProofingRequestContext(
      c,
      principal,
      'work-item',
    )
    const body = await readFileProofingJson<CreateFileApprovalDecisionInput>(c.req)
    const input = { ...body, workItemRevision } satisfies CreateFileApprovalDecisionInput
    return c.json({
      approval: await fileProofing.decideApproval(
        scope,
        actor,
        readRequiredRouteId(c.req.param('approvalId'), 'Approval ID'),
        input,
        createApiMutationContext(c, principal, input),
      ),
    })
  } catch (error) {
    return toFileProofingErrorResponse(c, error)
  }
})

/** Requester または manager が pending approval を取り消す endpoint です。 */
app.post('/api/teams/:teamId/issues/:issueId/approvals/:approvalId/cancel', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const { scope, actor } = await loadFileProofingRequestContext(
      c,
      principal,
      'work-item',
    )
    const body = await readFileProofingJson<CancelFileApprovalInput>(c.req)
    const input = {
      expectedRevision: body.expectedRevision,
    } satisfies CancelFileApprovalInput
    return c.json({
      approval: await fileProofing.cancelApproval(
        scope,
        actor,
        readRequiredRouteId(c.req.param('approvalId'), 'Approval ID'),
        input,
        createApiMutationContext(c, principal, input),
      ),
    })
  } catch (error) {
    return toFileProofingErrorResponse(c, error)
  }
})

/** 現在 reviewer の未完了 approval を Workspace 横断で返す endpoint です。 */
app.get('/api/approvals/reviewer', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const page = await fileProofing.listReviewerApprovals(
      principal.directoryId,
      {
        memberKey: principal.userKey,
        guest: principal.workspaceRole === 'guest',
        canWrite: false,
        canManage: false,
      },
      {
        ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
        ...(c.req.query('limit') ? { limit: Number(c.req.query('limit')) } : {}),
      },
    )
    const authorized = await Promise.all(page.approvals.map(async (approval) => {
      if (!approval.teamId || !approval.issueId) {
        return undefined
      }
      try {
        await loadAuthorizedTeamIssue(
          principal,
          approval.teamId,
          approval.issueId,
          'viewer',
        )
        return approval
      } catch {
        return undefined
      }
    }))
    return c.json({
      approvals: authorized.filter((approval) => approval !== undefined),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    })
  } catch (error) {
    return toFileProofingErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたプロジェクト遂行 Issue 一覧を返す endpoint です。
 */
app.get('/api/projects/:projectId/issues', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    await requireProjectPermission(principal, projectId, 'viewer')

    return c.json(
      await hydrateProjectIssuesResponse(
        await readProjectIssues(principal.directoryId, projectId),
      ),
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * 旧 project task 作成契約を canonical Work Item 作成へ変換する compatibility endpoint です。
 */
app.post('/api/projects/:projectId/tasks', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    await requireProjectPermission(principal, projectId, 'member')
    const context = await requireUniqueProjectOwnerContext(principal, projectId, 'member')
    const body = await readJson<CreateProjectTaskRequestBody>(c.req)
    const assigneeUserId = readTaskAssigneeUserId(body ?? {})
    await requireActiveWorkspaceAssignee(principal.directoryId, assigneeUserId)
    const input: CreateWorkItemInput = {
      title: readRequiredString(body?.title, 'Task title is required.'),
      assignedProjectId: projectId,
      assigneeUserId,
      status: readTaskStatus(body?.status),
      dueDate: readRequiredString(body?.dueDate, 'Task due date is required.'),
      priority: readTaskPriority(body?.priority),
    }
    const reservedIssueIds = await readLegacyTeamIssueIds(principal.directoryId, context)
    const response = await teamIssues.createTeamIssue(
      principal.directoryId,
      context.team.id,
      input,
      principal.userKey,
      reservedIssueIds,
      createApiMutationContext(c, principal, {
        teamId: context.team.id,
        projectId,
        ...input,
      }),
    )
    const hydrated = await hydrateCreateTeamIssueResponse(response)

    return c.json(
      { task: toProjectTaskFromTeamIssue(hydrated.issue) } satisfies CreateProjectTaskResponse,
      201,
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/**
 * canonical Work Item の状態だけを更新し、legacy project task は read-only とする endpoint です。
 */
app.patch('/api/projects/:projectId/tasks/:taskId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')
  const taskId = c.req.param('taskId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  if (!taskId) {
    return c.json({ message: 'Task ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    await requireProjectPermission(principal, projectId, 'member')

    const body = await readJson<UpdateProjectTaskStatusRequestBody>(c.req)
    const status = readRequiredTaskStatus(body?.status)
    const expectedRevision = readWorkItemExpectedRevision(body?.expectedRevision)
    const canonicalIssues = (await teamIssues.getProjectIssues(
      principal.directoryId,
      projectId,
    )).issues.filter((issue) => issue.id === taskId)

    if (canonicalIssues.length > 1) {
      throw new ProjectDataError(
        409,
        'AmbiguousProjectWorkItem',
        'More than one canonical Work Item matches this project task ID.',
      )
    }

    const canonicalIssue = canonicalIssues[0]
    if (!canonicalIssue) {
      if (await isLegacyProjectTaskIssue(principal.directoryId, projectId, taskId)) {
        throw createLegacyProjectTaskReadOnlyError()
      }

      throw new ProjectDataError(404, 'ProjectTaskNotFound', 'Task was not found.')
    }
    const response = await teamIssues.updateTeamIssue(
      principal.directoryId,
      canonicalIssue.teamId,
      taskId,
      { status, expectedRevision },
      principal.userKey,
      createApiMutationContext(c, principal, {
        teamId: canonicalIssue.teamId,
        projectId,
        taskId,
        status,
        expectedRevision,
      }),
    )
    const hydrated = await hydrateUpdateTeamIssueResponse(response)
    return c.json(
      { task: toProjectTaskFromTeamIssue(hydrated.issue) } satisfies UpdateProjectTaskStatusResponse,
    )
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

async function readJson<T>(request: { json: () => Promise<T> }) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

async function readFileProofingJson<T>(request: { json: () => Promise<unknown> }) {
  const body = await readJson<unknown>(request)
  if (!isRecord(body)) {
    throw new FileProofingError(
      400,
      'InvalidFileProofingInput',
      'A JSON object request body is required.',
    )
  }
  return body as T
}

function createApiMutationContext(
  c: Context,
  principal: ProjectPrincipal,
  body: unknown,
): MutationAuditContext {
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
  const correlationId = c.req.header('X-Correlation-Id')?.trim()
  const path = new URL(c.req.url).pathname

  try {
    return createMutationAuditContext({
      workspaceId: principal.directoryId,
      actor: {
        id: principal.actorId,
        kind: 'user',
        displayName: principal.userKey,
      },
      idempotencyKey,
      ...(correlationId ? { correlationId } : {}),
      request: {
        method: c.req.method,
        path,
        body,
      },
      source: {
        kind: 'api',
        requestId: c.req.header('X-Request-Id'),
        method: c.req.method,
        route: path,
        ipAddress: c.req.header('X-Forwarded-For')?.split(',')[0]?.trim(),
        userAgent: c.req.header('User-Agent'),
      },
    })
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new ProjectDataError(400, 'InvalidProjectWrite', error.message)
    }

    throw error
  }
}

function createOptionalAuditTransactItems(
  tableName: string | undefined,
  context: MutationAuditContext | undefined,
  input: MutationAuditEventInput,
) {
  const item = createMutationAuditEventPut(tableName, context, input)

  return item ? [item] : []
}

async function ensureConfiguredAuditTable(
  tableName: string | undefined,
  dynamoDbClient: DynamoDBClient,
  bootstrapLocalTables: boolean,
) {
  if (tableName && bootstrapLocalTables) {
    await ensureLocalAuditEventsTable(tableName, dynamoDbClient)
  }
}

function readAuditEventQuery(
  c: Context,
  workspaceId: string,
  entity?: { type: AuditEventEntityType; id: string },
): AuditEventQuery {
  const limitValue = c.req.query('limit')
  const limit = limitValue ? Number(limitValue) : undefined
  const eventTypes = c.req.query('eventType')
    ?.split(',')
    .map((eventType) => eventType.trim())
    .filter(Boolean)

  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new ProjectDataError(400, 'InvalidAuditQuery', 'Audit limit is invalid.')
  }

  return {
    workspaceId,
    actorId: c.req.query('actorUserId') ?? c.req.query('actorId'),
    targetType: c.req.query('targetType'),
    targetId: c.req.query('targetId'),
    eventTypes,
    from: c.req.query('from'),
    to: c.req.query('to'),
    limit,
    cursor: c.req.query('cursor'),
    direction: c.req.query('direction') === 'ascending' ? 'ascending' : 'descending',
    ...(entity ? { entityType: entity.type, entityId: entity.id } : {}),
  }
}

/**
 * Storage schema の内部属性を除いた paginated audit response を作成します。
 */
function toAuditEventPageView(page: AuditEventPage) {
  return {
    events: page.events.map(toAuditEventView),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}

async function handleWorkspaceAuditRequest(c: Context, exportAsNdjson: boolean) {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireSystemAdmin(principal)
    const query = readAuditEventQuery(c, principal.directoryId)

    if (!exportAsNdjson) {
      return c.json(toAuditEventPageView(await auditEvents.query(query)))
    }

    const events = []
    let cursor = query.cursor

    do {
      const page = await auditEvents.query({
        ...query,
        cursor,
        limit: Math.min(100, 1_000 - events.length),
      })
      events.push(...page.events)
      cursor = page.nextCursor
    } while (cursor && events.length < 1_000)

    const headers: Record<string, string> = {
      'Content-Disposition': 'attachment; filename="mukuroji-audit.ndjson"',
      'Content-Type': 'application/x-ndjson; charset=utf-8',
    }

    if (events.length === 1_000 && cursor) {
      headers['X-Audit-Truncated'] = 'true'
      headers['X-Audit-Next-Cursor'] = cursor
    }

    return c.body(await auditEventsToNdjson(events), 200, headers)
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(c, error)
    }

    if (error instanceof TypeError || error instanceof RangeError) {
      return c.json({ message: error.message }, 400)
    }

    return toProjectDataErrorResponse(c, error)
  }
}

function readWorkspaceEmail(value: unknown) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''

  if (!email || !email.includes('@')) {
    throw new WorkspaceAccessError(400, 'InvalidWorkspaceEmail', 'A valid email address is required.')
  }

  return email
}

function readOptionalWorkspaceName(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readWorkspaceRole(value: unknown): WorkspaceRole {
  if (value === 'owner' || value === 'admin' || value === 'member' || value === 'guest') {
    return value
  }

  throw new WorkspaceAccessError(400, 'InvalidWorkspaceRole', 'Workspace role is invalid.')
}

function readWorkspaceMemberStatus(value: unknown): WorkspaceMemberStatus {
  if (value === 'active' || value === 'deactivated') {
    return value
  }

  throw new WorkspaceAccessError(400, 'InvalidWorkspaceMemberStatus', 'Workspace member status is invalid.')
}

function readWorkspaceVersion(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new WorkspaceAccessError(400, 'InvalidWorkspaceVersion', 'Workspace member version is required.')
  }

  return value
}

async function createAuthenticationResponse(tokens: AuthTokenSet) {
  if (!tokens.AccessToken) {
    throw new CognitoServiceError(
      502,
      'InvalidCognitoResponse',
      'Cognito did not return an access token.',
    )
  }

  if (cognito instanceof FlociCognitoClient && tokens.AccessToken.split('.').length !== 3) {
    return {
      accessToken: tokens.AccessToken,
      idToken: tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
      tokenType: tokens.TokenType ?? 'Bearer',
    }
  }

  const user = await cognito.getUser(tokens.AccessToken)
  const userKey = readUserAttribute(user, 'email') ?? user.Username

  if (userKey?.trim()) {
    const principal = toProjectPrincipal(user, tokens.AccessToken)
    await workspaceAccess.reconcileAuthenticatedMember(principal.directoryId, {
      memberKey: principal.userKey,
      email: readUserAttribute(user, 'email') ?? principal.userKey,
      name: readUserAttribute(user, 'name'),
    })
  }

  return {
    accessToken: tokens.AccessToken,
    idToken: tokens.IdToken,
    refreshToken: tokens.RefreshToken,
    expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
    tokenType: tokens.TokenType ?? 'Bearer',
  }
}

async function handleWorkspaceInvitationDeliveryAction(
  c: Context,
  action: 'resend' | 'reinvite',
) {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceAdministration(principal)
    const invitationId = readWorkspaceEmail(c.req.param('invitationId'))
    const preparedInvitation = action === 'resend'
      ? await workspaceAccess.prepareResend(
          principal.directoryId,
          principal.userKey,
          invitationId,
        )
      : await workspaceAccess.prepareReinvite(
          principal.directoryId,
          principal.userKey,
          invitationId,
        )

    try {
      const result = await deliverPreparedWorkspaceInvitation(
        principal.directoryId,
        preparedInvitation,
        action === 'resend',
      )
      const invitation = await workspaceAccess.markInvitationDelivery(
        principal.directoryId,
        preparedInvitation.id,
        {
          expectedVersion: preparedInvitation.version,
          identityOwnership: result.identityOwnership,
          deliveryStatus: result.deliveryStatus,
        },
      )

      return c.json({ invitation })
    } catch (error) {
      await markWorkspaceInvitationFailure(principal.directoryId, preparedInvitation, error)
      throw error
    }
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toWorkspaceAccessErrorResponse(c, error)
  }
}

async function deliverPreparedWorkspaceInvitation(
  directoryId: string,
  invitation: WorkspaceInvitation,
  preserveIdentityOwnership = false,
) {
  const existingUser = await cognito.findWorkspaceUser(invitation.email)

  if (existingUser?.profile.status === 'FORCE_CHANGE_PASSWORD') {
    const result = await cognito.provisionWorkspaceUser({
      directoryId,
      email: invitation.email,
      name: invitation.name,
      existingUser,
    })
    await cognito.resendWorkspaceUserInvitation(existingUser.profile.username)
    return {
      identityOwnership: preserveIdentityOwnership
        ? invitation.identityOwnership
        : result.identityOwnership,
      deliveryStatus: 'sent' as const,
    }
  }

  const result = await cognito.provisionWorkspaceUser({
    directoryId,
    email: invitation.email,
    name: invitation.name,
    existingUser,
  })

  return {
    identityOwnership: preserveIdentityOwnership
      ? invitation.identityOwnership
      : result.identityOwnership,
    deliveryStatus: result.deliveryStatus,
  }
}

async function markWorkspaceInvitationFailure(
  directoryId: string,
  invitation: WorkspaceInvitation,
  error: unknown,
) {
  console.error('Workspace invitation delivery failed:', error)

  try {
    await workspaceAccess.markInvitationDelivery(directoryId, invitation.id, {
      expectedVersion: invitation.version,
      identityOwnership: invitation.identityOwnership,
      deliveryStatus: 'failed',
      failureMessage: 'Invitation delivery failed.',
    })
  } catch (markError) {
    console.error('Failed to persist Workspace invitation delivery failure:', markError)
  }
}

async function authenticateWorkspacePrincipal(
  accessToken: string,
  user?: GetUserResponse,
): Promise<WorkspacePrincipal> {
  validateConfiguredCognitoAccessToken(accessToken)
  const principal = toProjectPrincipal(user ?? await cognito.getUser(accessToken), accessToken)
  const workspaceMember = await workspaceAccess.getActiveMember(
    principal.directoryId,
    principal.userKey,
  )

  if (!workspaceMember) {
    throw new WorkspaceAccessError(403, 'WorkspaceAccessDenied', 'Workspace access is denied.')
  }

  return {
    ...principal,
    workspaceMember,
    workspaceRole: workspaceMember.role,
    workspaceMemberStatus: workspaceMember.status,
  }
}

function readBearerAccessToken(c: Context) {
  const authorization = c.req.header('Authorization') ?? ''

  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]
}

function readLocale(c: Context): Locale {
  return c.req.query('locale') === 'en' ? 'en' : 'ja'
}

function readCognitoUsersInput(c: Context, directoryId?: string): ListCognitoUsersInput {
  const limit = Number(c.req.query('limit') ?? 20)

  return {
    directoryId,
    paginationToken: c.req.query('paginationToken') ?? c.req.query('nextToken') ?? undefined,
    limit,
    query: c.req.query('query')?.trim() || undefined,
  }
}

function toAuthErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof CognitoServiceError)) {
    console.error(error)
    return c.json({ message: 'Unexpected authentication error.' }, 500)
  }

  if (error.code === 'CognitoTimeout') {
    console.error(error)
    return c.json({ message: 'Cognito local service timed out.' }, 504)
  }

  if (error.code === 'InvalidCognitoResponse' || error.status === 200 || !error.code) {
    console.error(error)
    return c.json({ message: 'Cognito local service returned an invalid response.' }, 502)
  }

  if (error.code === 'NotAuthorizedException' || error.code === 'UserNotFoundException') {
    return c.json({ message: 'Invalid email or password.' }, 401)
  }

  if (error.code === 'CognitoAccessTokenInvalid') {
    return c.json({ message: 'Authentication failed.' }, 401)
  }

  if (error.code === 'CognitoConfigurationMissing') {
    console.error(error)
    return c.json({ message: 'Cognito is not configured.' }, 503)
  }

  if (error.code === 'WorkspaceDirectoryConflict') {
    return c.json({ message: error.message }, 409)
  }

  if (error.code === 'ResourceNotFoundException' || error.code === 'ClientNotFoundException') {
    return c.json({ message: 'Cognito local resources are not ready.' }, 503)
  }

  if (error.status >= 500) {
    console.error(error)
    return c.json({ message: 'Cognito local service is unavailable.' }, 502)
  }

  return c.json({ message: error.message }, 400)
}

function toNewPasswordChallengeErrorResponse(c: Context, error: unknown) {
  if (
    error instanceof CognitoServiceError &&
    (
      error.code === 'InvalidPasswordException' ||
      error.code === 'PasswordHistoryPolicyViolationException'
    )
  ) {
    return c.json(
      {
        code: 'InvalidNewPassword' as const,
        message: 'New password does not meet the password policy.',
      },
      400,
    )
  }

  return toAuthErrorResponse(c, error)
}

function toWorkspaceAccessErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof WorkspaceAccessError)) {
    console.error(error)
    return c.json({ message: 'Workspace access is unavailable.' }, 502)
  }

  if (error.status >= 500) {
    console.error(error)
  }

  const status = error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 503
    ? error.status
    : 502

  return c.json({ message: error.message }, status)
}

function requireSystemAdmin(principal: ProjectPrincipal) {
  if (principal.isSystemAdmin) {
    return
  }

  throw new ProjectDataError(
    403,
    'ProjectAccessDenied',
    `User "${principal.userKey}" must be a system administrator.`,
  )
}

function requireWorkspaceBusinessWrite(principal: WorkspacePrincipal) {
  if (principal.workspaceRole !== 'guest') {
    return
  }

  throw new WorkspaceAccessError(
    403,
    'WorkspaceRoleDenied',
    'Guest members have read-only Workspace access.',
  )
}

function requireWorkspaceAdministration(principal: WorkspacePrincipal) {
  if (principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin') {
    return
  }

  throw new WorkspaceAccessError(
    403,
    'WorkspaceRoleDenied',
    'Workspace owner or admin access is required.',
  )
}

async function requireWorkspaceMemberHasNoManagedProjects(
  directoryId: string,
  memberKey: string,
) {
  const managedProject = (await projectDirectory.getProjectAccessList(directoryId, memberKey))
    .find((access) => access.role === 'manager')

  if (managedProject) {
    throw new WorkspaceAccessError(
      409,
      'WorkspaceMemberManagesProjects',
      'Transfer or remove all active project manager roles before deactivating this member.',
    )
  }
}

function toCollaborationErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }

  if (!(error instanceof CollaborationError)) {
    return toProjectDataErrorResponse(c, error)
  }

  if (error.status >= 500) {
    console.error(error)
  }

  const status = error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 503
    ? error.status
    : 502

  return c.json({ code: error.code, message: error.message }, status)
}

function toFileProofingErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(c, error)
  }
  if (error instanceof ProjectDataError) {
    return toProjectDataErrorResponse(c, error)
  }
  if (!(error instanceof FileProofingError)) {
    console.error(error)
    return c.json({ message: 'File proofing data is unavailable.' }, 502)
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 410 ||
    error.status === 413 ||
    error.status === 415 ||
    error.status === 422 ||
    error.status === 423 ||
    error.status === 503
    ? error.status
    : 502

  return c.json({ code: error.code, message: error.message }, status)
}

function toProjectDataErrorResponse(c: Context, error: unknown) {
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(c, error)
  }

  if (isTeamIssueNotFoundError(error)) {
    return c.json({ message: 'Issue was not found.' }, 404)
  }

  if (!(error instanceof ProjectDataError)) {
    console.error(error)
    return c.json({ message: 'Project data is unavailable.' }, 502)
  }

  if (error.code === 'InvalidWorkItemRevision') {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (error.code === 'WorkItemListLimitExceeded') {
    return c.json({ code: error.code, message: error.message }, 413)
  }

  if (error.code === 'TeamIssueMigrationLookupIncomplete') {
    return c.json({ code: error.code, message: error.message }, 503)
  }

  if (error.code === 'InvalidProjectWrite' ||
    error.code === 'InvalidAuditQuery' ||
    error.code === 'InvalidCommentMention' ||
    error.code === 'InvalidTeamIssueCursor') {
    return c.json({ message: error.message }, 400)
  }

  if (error.code === 'TeamNotFound') {
    return c.json({ message: 'Team was not found.' }, 404)
  }

  if (error.code === 'ProjectNotFound') {
    return c.json({ message: 'Project was not found.' }, 404)
  }

  if (error.code === 'ProjectTaskNotFound') {
    return c.json({ message: 'Task was not found.' }, 404)
  }

  if (error.code === 'ProjectMemberNotFound') {
    return c.json({ message: 'Project member was not found.' }, 404)
  }

  if (error.code === 'ConditionalCheckFailedException') {
    return c.json({ message: 'The same item already exists.' }, 409)
  }

  if (error.code === 'WorkItemRevisionConflict') {
    return c.json({
      code: error.code,
      message: 'Work Item changed. Reload and try again.',
    }, 409)
  }

  if (error.code === 'LegacyProjectTaskReadOnly') {
    return c.json({
      code: error.code,
      message: 'Legacy project tasks are read-only.',
    }, 409)
  }

  if (
    error.code === 'AmbiguousProjectOwnerTeam' ||
    error.code === 'AmbiguousProjectWorkItem'
  ) {
    return c.json({ code: error.code, message: error.message }, 409)
  }

  if (error.code === 'ProjectLastManager') {
    return c.json({ message: 'At least one project manager is required.' }, 409)
  }

  if (error.code === 'WorkspaceMemberInactive') {
    return c.json({ message: 'Only active Workspace members can be assigned to a project.' }, 409)
  }

  if (error.code === 'WorkspaceMemberVersionConflict') {
    return c.json({ message: 'Workspace member changed. Reload and try again.' }, 409)
  }

  if (error.code === 'ResourceNotFoundException') {
    console.error(error)
    return c.json({ message: 'Project data is not initialized.' }, 503)
  }

  if (
    error.code === 'InvalidProjectTask' ||
    error.code === 'InvalidProjectDirectory' ||
    error.code === 'InvalidTeamIssue'
  ) {
    console.error(error)
    return c.json({ message: 'Project data is invalid.' }, 503)
  }

  if (error.code === 'ProjectDirectoryMismatch') {
    return c.json({ message: 'Cognito workspace does not match the configured workspace.' }, 403)
  }

  if (error.code === 'ProjectPrincipalMissing' || error.code === 'ProjectAccessDenied') {
    return c.json({ message: 'Project access is denied.' }, 403)
  }

  console.error(error)
  return c.json({ message: 'Project data is unavailable.' }, 502)
}

async function requireProjectPermission(
  principal: ProjectPrincipal,
  projectId: string,
  minimumRole: ProjectRole,
) {
  if (principal.isSystemAdmin) {
    return
  }

  const projectAccess = await projectDirectory.getProjectAccess(
    principal.directoryId,
    projectId,
    principal.userKey,
  )

  if (!projectAccess) {
    throw new ProjectDataError(
      403,
      'ProjectAccessDenied',
      `Project "${projectId}" is not active in directory "${principal.directoryId}".`,
    )
  }

  if (!projectAccessAllows(projectAccess, minimumRole)) {
    throw new ProjectDataError(
      403,
      'ProjectAccessDenied',
      `User "${principal.userKey}" with role "${projectAccess.role ?? 'none'}" cannot access project "${projectId}".`,
    )
  }
}

/**
 * チーム Issue 操作で使う directory context です。
 */
type TeamPermissionContext = {
  /**
   * active team 行です。
   */
  team: ProjectDirectoryTeamResponse
  /**
   * active team/project 一覧です。
   */
  directory: ProjectDirectoryResponse
  /**
   * 現在ユーザーが team 配下 project に対して持つ role 一覧です。
   * system admin の場合は全 project を扱えるため undefined です。
   */
  projectAccesses?: ProjectAccessEntry[]
}

async function requireTeamPermission(
  principal: ProjectPrincipal,
  teamId: string,
  minimumRole: ProjectRole,
): Promise<TeamPermissionContext> {
  const directory = await projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const team = directory.teams.find((candidate) => candidate.id === teamId)

  if (!team) {
    throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
  }

  if (principal.isSystemAdmin) {
    return { team, directory }
  }

  const teamProjectIds = new Set(team.projects.map((project) => project.id))
  const projectAccesses = (await projectDirectory.getProjectAccessList(
    principal.directoryId,
    principal.userKey,
  )).filter((projectAccess) => teamProjectIds.has(projectAccess.projectId))

  for (const projectAccess of projectAccesses) {
    if (projectAccess && projectAccessAllows(projectAccess, minimumRole)) {
      return { team, directory, projectAccesses }
    }
  }

  throw new ProjectDataError(
    403,
    'ProjectAccessDenied',
    `User "${principal.userKey}" cannot access team "${teamId}".`,
  )
}

/**
 * 旧 project task 作成を Team-owned Work Item へ変換できる一意な owner Team を解決します。
 */
async function requireUniqueProjectOwnerContext(
  principal: ProjectPrincipal,
  projectId: string,
  minimumRole: ProjectRole,
): Promise<TeamPermissionContext> {
  const directory = await projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const ownerTeams = directory.teams.filter((team) =>
    team.projects.some((project) => project.id === projectId)
  )

  if (ownerTeams.length === 0) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
  }

  if (ownerTeams.length > 1) {
    throw new ProjectDataError(
      409,
      'AmbiguousProjectOwnerTeam',
      `Project "${projectId}" belongs to more than one active Team.`,
    )
  }

  const team = ownerTeams[0]
  if (!team) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
  }

  if (principal.isSystemAdmin) {
    return { team, directory }
  }

  const teamProjectIds = new Set(team.projects.map((project) => project.id))
  const projectAccesses = (await projectDirectory.getProjectAccessList(
    principal.directoryId,
    principal.userKey,
  )).filter((access) => teamProjectIds.has(access.projectId))
  const targetAccess = projectAccesses.find((access) => access.projectId === projectId)

  if (!targetAccess || !projectAccessAllows(targetAccess, minimumRole)) {
    throw new ProjectDataError(
      403,
      'ProjectAccessDenied',
      `User "${principal.userKey}" cannot access project "${projectId}".`,
    )
  }

  return { team, directory, projectAccesses }
}

async function loadAuthorizedTeamIssue(
  principal: WorkspacePrincipal,
  teamId: string,
  issueId: string,
  minimumRole: ProjectRole,
  detailReadOptions: TeamIssueDetailReadOptions = {
    consistentIssueRead: true,
    eventLimit: 0,
  },
) {
  const context = await requireTeamPermission(principal, teamId, minimumRole)
  const detail = await teamIssues.getTeamIssueDetail(
    principal.directoryId,
    teamId,
    issueId,
    detailReadOptions,
  )
  requireAssignedProjectPermission(
    principal,
    context,
    detail.issue.assignedProjectId,
    minimumRole,
  )

  return { context, detail }
}

async function loadFileProofingRequestContext(
  c: Context,
  principal: WorkspacePrincipal,
  kind: FileProofingScope['kind'],
): Promise<{
  scope: FileProofingScope
  actor: FileProofingActor
  workItemRevision?: number
}> {
  const teamId = readRequiredRouteId(c.req.param('teamId'), 'Team ID')

  if (kind === 'work-item') {
    const issueId = readRequiredRouteId(c.req.param('issueId'), 'Work Item ID')
    const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    return {
      scope: {
        workspaceId: principal.directoryId,
        teamId,
        kind,
        issueId,
        ...(detail.issue.assignedProjectId
          ? { projectId: detail.issue.assignedProjectId }
          : {}),
      },
      actor: {
        memberKey: principal.userKey,
        guest: principal.workspaceRole === 'guest',
        canWrite: canWriteTeamIssue(principal, context, detail.issue.assignedProjectId),
        canManage: canManageTeamIssueCollaboration(
          principal,
          context,
          detail.issue.assignedProjectId,
        ),
      },
      workItemRevision: detail.issue.revision,
    }
  }

  const projectId = readRequiredRouteId(c.req.param('projectId'), 'Project ID')
  const context = await requireTeamPermission(principal, teamId, 'viewer')
  if (!context.team.projects.some((project) => project.id === projectId)) {
    throw new ProjectDataError(
      404,
      'ProjectNotFound',
      `Project "${projectId}" was not found in team "${teamId}".`,
    )
  }
  requireAssignedProjectPermission(principal, context, projectId, 'viewer')
  const projectAccess = context.projectAccesses?.find((access) => access.projectId === projectId)
  const canWrite = principal.workspaceRole !== 'guest' && (
    principal.isSystemAdmin ||
    (projectAccess !== undefined && projectAccessAllows(projectAccess, 'member'))
  )
  const canManage = canModerateCollaboration(principal) ||
    (projectAccess !== undefined && projectAccessAllows(projectAccess, 'manager'))

  return {
    scope: {
      workspaceId: principal.directoryId,
      teamId,
      kind,
      projectId,
    },
    actor: {
      memberKey: principal.userKey,
      guest: principal.workspaceRole === 'guest',
      canWrite,
      canManage,
    },
  }
}

function readRequiredRouteId(value: string | undefined, label: string) {
  const normalized = value?.trim()
  if (!normalized) {
    throw new FileProofingError(400, 'InvalidFileScope', `${label} is required.`)
  }
  return normalized
}

function projectAccessAllows(access: ProjectAccessEntry, minimumRole: ProjectRole) {
  return access.role !== undefined && projectRoleAllows(access.role, minimumRole)
}

function requireAssignedProjectPermission(
  principal: ProjectPrincipal,
  context: TeamPermissionContext,
  assignedProjectId: string | null | undefined,
  minimumRole: ProjectRole,
) {
  if (!assignedProjectId || principal.isSystemAdmin) {
    return
  }

  const projectAccess = context.projectAccesses?.find((access) => access.projectId === assignedProjectId)

  if (!projectAccess || !projectAccessAllows(projectAccess, minimumRole)) {
    throw new ProjectDataError(
      403,
      'ProjectAccessDenied',
      `User "${principal.userKey}" cannot access assigned project "${assignedProjectId}".`,
    )
  }
}

function canAccessAssignedProject(
  principal: ProjectPrincipal,
  context: TeamPermissionContext,
  assignedProjectId: string | undefined,
  minimumRole: ProjectRole,
) {
  if (!assignedProjectId || principal.isSystemAdmin) {
    return true
  }

  const projectAccess = context.projectAccesses?.find((access) => access.projectId === assignedProjectId)

  return projectAccess !== undefined && projectAccessAllows(projectAccess, minimumRole)
}

function canWriteTeamIssue(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  assignedProjectId: string | undefined,
) {
  if (principal.workspaceRole === 'guest') {
    return false
  }

  if (principal.isSystemAdmin) {
    return true
  }

  if (assignedProjectId) {
    const access = context.projectAccesses?.find((entry) => entry.projectId === assignedProjectId)
    return access !== undefined && projectAccessAllows(access, 'member')
  }

  return context.projectAccesses?.some((access) => projectAccessAllows(access, 'member')) ?? false
}

function canModerateCollaboration(principal: WorkspacePrincipal) {
  return principal.isSystemAdmin ||
    principal.workspaceRole === 'owner' ||
    principal.workspaceRole === 'admin'
}

function canManageTeamIssueCollaboration(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  assignedProjectId: string | undefined,
) {
  if (canModerateCollaboration(principal)) {
    return true
  }

  if (!assignedProjectId) {
    return context.projectAccesses?.some((access) => projectAccessAllows(access, 'manager')) ?? false
  }

  const access = context.projectAccesses?.find((entry) => entry.projectId === assignedProjectId)
  return access !== undefined && projectAccessAllows(access, 'manager')
}

function createTeamIssueAutomaticWatcherCandidates(
  issue: TeamIssueResponseItem,
): CollaborationAutomaticWatcherCandidate[] {
  return [
    ...(issue.creatorMemberKey
      ? [{ memberKey: issue.creatorMemberKey, reason: 'creator' as const }]
      : []),
    ...(issue.assigneeUserId
      ? [{ memberKey: issue.assigneeUserId, reason: 'assignee' as const }]
      : []),
  ]
}

function toCollaborationCommentResponse(
  comment: CollaborationComment,
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  issue: TeamIssueResponseItem,
  threadResolved = false,
) {
  const canWrite = canWriteTeamIssue(principal, context, issue.assignedProjectId)
  const canManage = canManageTeamIssueCollaboration(principal, context, issue.assignedProjectId)
  const isAuthor = comment.authorMemberKey === principal.userKey
  const isRoot = !comment.parentCommentId && comment.rootCommentId === comment.id
  const authorCanMutate = principal.workspaceRole !== 'guest' && isAuthor
  const canResolve = isRoot && !comment.deletedAt && (
    authorCanMutate ||
    canManage ||
    (principal.workspaceRole !== 'guest' && issue.assigneeUserId === principal.userKey)
  )

  return {
    id: comment.id,
    source: 'collaboration' as const,
    rootCommentId: comment.rootCommentId,
    ...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
    authorMemberKey: comment.authorMemberKey,
    bodyMarkdown: comment.bodyMarkdown,
    version: comment.version,
    mentionMemberKeys: comment.mentionMemberKeys,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    ...(comment.editedAt ? { editedAt: comment.editedAt } : {}),
    ...(comment.deletedAt ? { deletedAt: comment.deletedAt } : {}),
    ...(comment.resolvedAt ? { resolvedAt: comment.resolvedAt } : {}),
    ...(comment.resolvedByMemberKey
      ? { resolvedByMemberKey: comment.resolvedByMemberKey }
      : {}),
    reactions: comment.reactions,
    capabilities: {
      canEdit: authorCanMutate && !comment.deletedAt,
      canDelete: (authorCanMutate || canManage) && !comment.deletedAt,
      canResolve,
      canReply: canWrite && !comment.deletedAt && !comment.resolvedAt && !threadResolved,
      canReact: canWrite && !comment.deletedAt,
    },
  }
}

async function requireValidCommentMentions(
  workspaceId: string,
  memberKeys: string[],
  context: TeamPermissionContext,
  assignedProjectId: string | undefined,
) {
  const activeTeamProjectIds = new Set(context.team.projects.map((project) => project.id))

  await Promise.all(
    memberKeys.map(async (memberKey) => {
      const member = await workspaceAccess.getActiveMember(workspaceId, memberKey)

      if (!member) {
        throw new ProjectDataError(
          400,
          'InvalidCommentMention',
          `Mentioned Workspace member "${memberKey}" is not active.`,
        )
      }

      if (assignedProjectId) {
        const access = await projectDirectory.getProjectAccess(
          workspaceId,
          assignedProjectId,
          memberKey,
        )

        if (
          (!access || !projectAccessAllows(access, 'viewer')) &&
          !(await cognito.isSystemAdmin(memberKey))
        ) {
          throw new ProjectDataError(
            400,
            'InvalidCommentMention',
            `Mentioned Workspace member "${memberKey}" cannot view the assigned project.`,
          )
        }

        return
      }

      const canViewOwningTeam = (await projectDirectory.getProjectAccessList(workspaceId, memberKey))
        .some((access) =>
          activeTeamProjectIds.has(access.projectId) && projectAccessAllows(access, 'viewer'),
        )

      if (!canViewOwningTeam && !(await cognito.isSystemAdmin(memberKey))) {
        throw new ProjectDataError(
          400,
          'InvalidCommentMention',
          `Mentioned Workspace member "${memberKey}" cannot view the owning team.`,
        )
      }
    }),
  )

  return memberKeys
}

function filterAccessibleTeamIssues(
  issues: TeamIssueResponseItem[],
  principal: ProjectPrincipal,
  context: TeamPermissionContext,
) {
  return issues.filter((issue) =>
    canAccessAssignedProject(principal, context, issue.assignedProjectId, 'viewer'),
  )
}

function projectRoleAllows(role: ProjectRole, minimumRole: ProjectRole) {
  return projectRoleWeights[role] >= projectRoleWeights[minimumRole]
}

async function hydrateProjectMembersResponse(
  response: ProjectMembersResponse,
  directoryId: string,
) {
  const members = await Promise.all(
    response.members.map(async (member) => hydrateProjectMember(member, directoryId)),
  )

  return {
    ...response,
    members,
  } satisfies ProjectMembersResponse
}

async function hydrateProjectMemberUpdateResponse(
  response: UpdateProjectMemberResponse,
  directoryId: string,
) {
  return {
    member: await hydrateProjectMember(response.member, directoryId),
  } satisfies UpdateProjectMemberResponse
}

async function hydrateProjectMember(member: ProjectMemberResponseItem, directoryId: string) {
  const workspaceMember = await workspaceAccess.getMember(directoryId, member.id)

  try {
    const profile = await cognito.getUserProfile(member.id)

    return {
      ...member,
      id: profile.id,
      email: profile.email,
      username: profile.username,
      name: profile.name,
      enabled: profile.enabled,
      status: profile.status,
      workspaceStatus: workspaceMember?.status ?? 'deactivated',
    } satisfies ProjectMemberResponseItem
  } catch (error) {
    if (isCognitoUserNotFoundError(error)) {
      return {
        ...member,
        workspaceStatus: workspaceMember?.status ?? 'deactivated',
      }
    }

    console.warn('Failed to hydrate project member from Cognito:', error)
    return {
      ...member,
      workspaceStatus: workspaceMember?.status ?? 'deactivated',
    }
  }
}

async function listActiveWorkspaceCognitoUsers(directoryId: string, c: Context) {
  const input = readCognitoUsersInput(c, directoryId)
  const limit = clampCognitoPageLimit(input.limit)
  const activeMemberKeys = new Set(
    (await workspaceAccess.listActiveMembers(directoryId)).map((member) => member.memberKey),
  )
  const users: CognitoUserProfile[] = []
  let paginationToken = input.paginationToken

  do {
    const response = await cognito.listUsers({
      ...input,
      limit: Math.max(1, limit - users.length),
      paginationToken,
    })

    users.push(
      ...response.users
        .filter((user) => activeMemberKeys.has(user.id))
        .map((user) => ({ ...user, workspaceStatus: 'active' as const })),
    )
    paginationToken = response.nextToken
  } while (users.length < limit && paginationToken)

  return {
    users,
    nextToken: paginationToken,
  } satisfies CognitoUsersResponse
}

async function requireActiveWorkspaceAssignee(directoryId: string, userId: string) {
  const member = await workspaceAccess.getActiveMember(directoryId, userId)

  if (!member) {
    throw new WorkspaceAccessError(
      409,
      'WorkspaceAssigneeInactive',
      'Only active Workspace members can be assigned.',
    )
  }

  return cognito.getUserProfile(userId)
}

async function hydrateProjectTasksResponse(response: ProjectTasksResponse) {
  const profiles = await readTaskAssigneeProfiles(response.tasks)

  return {
    ...response,
    tasks: response.tasks.map((task) => hydrateProjectTask(task, profiles)),
  } satisfies ProjectTasksResponse
}

async function hydrateTeamIssuesResponse(response: TeamIssuesResponse) {
  const profiles = await readIssueAssigneeProfiles(response.issues)

  return {
    ...response,
    issues: response.issues.map((issue) => hydrateTeamIssue(issue, profiles)),
  } satisfies TeamIssuesResponse
}

async function hydrateProjectIssuesResponse(response: ProjectIssuesResponse) {
  const profiles = await readIssueAssigneeProfiles(response.issues)

  return {
    ...response,
    issues: response.issues.map((issue) => hydrateTeamIssue(issue, profiles)),
  } satisfies ProjectIssuesResponse
}

async function hydrateWorkItemsResponse(response: WorkItemsResponse, directoryId: string) {
  const profiles = await readIssueAssigneeProfiles(response.workItems)
  const hydratedItems = response.workItems.map((workItem) => hydrateTeamIssue(workItem, profiles))
  const scopes = hydratedItems.flatMap((workItem) => workItem.source === 'dynamodb'
    ? [{
        workspaceId: directoryId,
        teamId: workItem.teamId,
        kind: 'work-item' as const,
        issueId: workItem.id,
      }]
    : [])
  const summaries = scopes.length > 0 &&
    (getEnv('FILE_PROOFING_TABLE_NAME') || getConfiguredDynamoDbEndpoint())
    ? await fileProofing.getApprovalSummaries(scopes)
    : new Map<string, ApprovalSummary>()
  const workItems = hydratedItems.map((workItem) => {
    if (workItem.source !== 'dynamodb') {
      return workItem
    }
    const summary = summaries.get(createFileProofingScopeKey({
      workspaceId: directoryId,
      teamId: workItem.teamId,
      kind: 'work-item',
      issueId: workItem.id,
    }))
    return summary && hasApprovalSummaryContent(summary)
      ? { ...workItem, approvalSummary: summary }
      : workItem
  })

  return {
    workItems,
  } satisfies WorkItemsResponse
}

async function hydrateTeamIssueDetailResponse(
  response: TeamIssueDetailResponse,
  directoryId: string,
) {
  const profiles = await readIssueAssigneeProfiles([response.issue])
  const issue = hydrateTeamIssue(response.issue, profiles)
  const approvalSummary = await readWorkItemApprovalSummary(directoryId, issue)

  return {
    ...response,
    issue: approvalSummary ? { ...issue, approvalSummary } : issue,
  } satisfies TeamIssueDetailResponse
}

async function readWorkItemApprovalSummary(directoryId: string, workItem: TeamIssueResponseItem) {
  if (
    workItem.source !== 'dynamodb' ||
    (!getEnv('FILE_PROOFING_TABLE_NAME') && !getConfiguredDynamoDbEndpoint())
  ) {
    return undefined
  }
  const summary = await fileProofing.getApprovalSummary({
    workspaceId: directoryId,
    teamId: workItem.teamId,
    kind: 'work-item',
    issueId: workItem.id,
  })
  return hasApprovalSummaryContent(summary) ? summary : undefined
}

function hasApprovalSummaryContent(summary: ApprovalSummary) {
  return summary.pendingCount + summary.approvedCount + summary.rejectedCount +
    summary.changesRequestedCount > 0
}

function mergeLegacyCompatibleComments(
  legacyComments: TeamIssueCommentResponseItem[],
  collaborationComments: CollaborationComment[],
) {
  const commentsById = new Map(legacyComments.map((comment) => [comment.id, comment]))

  for (const comment of collaborationComments) {
    if (comment.deletedAt) {
      commentsById.delete(comment.id)
      continue
    }
    commentsById.set(comment.id, {
      id: comment.id,
      actorUserId: comment.authorMemberKey,
      body: comment.bodyMarkdown,
      createdAt: comment.createdAt,
    })
  }

  return [...commentsById.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  )
}

async function hydrateCreateTeamIssueResponse(response: CreateTeamIssueResponse) {
  const profiles = await readIssueAssigneeProfiles([response.issue])

  return {
    issue: hydrateTeamIssue(response.issue, profiles),
  } satisfies CreateTeamIssueResponse
}

async function hydrateUpdateTeamIssueResponse(response: UpdateTeamIssueResponse) {
  const profiles = await readIssueAssigneeProfiles([response.issue])

  return {
    issue: hydrateTeamIssue(response.issue, profiles),
  } satisfies UpdateTeamIssueResponse
}

async function readTeamIssues(
  directoryId: string,
  context: TeamPermissionContext,
  principal: ProjectPrincipal,
  options: TeamIssueListReadOptions = {},
) {
  const scanLimit = normalizeWorkItemListReadLimit(options.scanLimit)
  const clientReadLimit = createWorkItemListProbeLimit(scanLimit)
  const storedIssues = await teamIssues.getTeamIssues(
    directoryId,
    context.team.id,
    clientReadLimit === undefined ? undefined : { limit: clientReadLimit },
  )
  assertWorkItemListWithinLimit(
    storedIssues.issues,
    scanLimit,
    `Team "${context.team.id}" canonical partition`,
  )
  const accessibleStoredIssues = filterAccessibleTeamIssues(
    storedIssues.issues,
    principal,
    context,
  )
  const legacyIssues = await readLegacyTeamIssues(directoryId, context, principal, options)

  return {
    teamId: context.team.id,
    issues: mergeTeamIssues(accessibleStoredIssues, legacyIssues),
  } satisfies TeamIssuesResponse
}

async function readCanonicalTeamIssuesForAggregate(
  directoryId: string,
  context: TeamPermissionContext,
  principal: ProjectPrincipal,
) {
  const clientReadLimit = createWorkItemListProbeLimit(WORK_ITEMS_PARTITION_SCAN_LIMIT)
  const storedIssues = await teamIssues.getTeamIssuesForAggregate(
    directoryId,
    context.team.id,
    { limit: clientReadLimit },
  )
  assertWorkItemListWithinLimit(
    storedIssues.issues,
    WORK_ITEMS_PARTITION_SCAN_LIMIT,
    `Team "${context.team.id}" canonical partition`,
  )

  return {
    teamId: context.team.id,
    issues: filterAccessibleTeamIssues(storedIssues.issues, principal, context),
    migrationSourceKeys: storedIssues.migrationSourceKeys,
  } satisfies AggregateTeamIssuesRead
}

async function readAccessibleWorkItems(
  principal: ProjectPrincipal,
): Promise<WorkItemsResponse> {
  const directory = await projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const projectAccesses = principal.isSystemAdmin
    ? undefined
    : await projectDirectory.getProjectAccessList(principal.directoryId, principal.userKey)
  const contexts = directory.teams.flatMap((team) => {
    if (principal.isSystemAdmin) {
      return [{ team, directory } satisfies TeamPermissionContext]
    }

    const teamProjectIds = new Set(team.projects.map((project) => project.id))
    const teamProjectAccesses = (projectAccesses ?? []).filter((access) =>
      teamProjectIds.has(access.projectId)
    )
    if (!teamProjectAccesses.some((access) => projectAccessAllows(access, 'viewer'))) {
      return []
    }

    return [{ team, directory, projectAccesses: teamProjectAccesses } satisfies TeamPermissionContext]
  })
  if (contexts.length > WORK_ITEMS_TEAM_READ_LIMIT) {
    throw createWorkItemListLimitExceededError(
      `Workspace has more than ${WORK_ITEMS_TEAM_READ_LIMIT} accessible Teams.`,
    )
  }

  const legacyProjectIds = selectAggregateLegacyProjectIds(contexts, principal)
  const workItemsById = new Map<string, TeamIssueResponseItem>()
  const migrationSourceKeys = new Set<string>()
  const canonicalResponses: AggregateTeamIssuesRead[] = []

  for (const context of contexts) {
    const response = await readCanonicalTeamIssuesForAggregate(
      principal.directoryId,
      context,
      principal,
    )
    canonicalResponses.push(response)
    for (const migrationSourceKey of response.migrationSourceKeys) {
      migrationSourceKeys.add(migrationSourceKey)
    }
  }

  for (const response of canonicalResponses) {
    for (const workItem of response.issues) {
      addAggregateWorkItem(workItemsById, workItem)
    }
  }

  for (const context of contexts) {
    const legacyIssues = await readLegacyTeamIssues(
      principal.directoryId,
      context,
      principal,
      {
        scanLimit: WORK_ITEMS_PARTITION_SCAN_LIMIT,
        legacyProjectIds,
        migrationSourceKeys,
      },
    )

    for (const workItem of legacyIssues) {
      if (workItemsById.has(`${workItem.teamId}\0${workItem.id}`)) {
        continue
      }
      addAggregateWorkItem(workItemsById, workItem)
    }
  }

  return { workItems: [...workItemsById.values()] }
}

function addAggregateWorkItem(
  workItemsById: Map<string, TeamIssueResponseItem>,
  workItem: TeamIssueResponseItem,
) {
  workItemsById.set(`${workItem.teamId}\0${workItem.id}`, workItem)
  if (workItemsById.size > WORK_ITEMS_RESPONSE_LIMIT) {
    throw createWorkItemListLimitExceededError(
      `Workspace has more than ${WORK_ITEMS_RESPONSE_LIMIT} accessible Work Items.`,
    )
  }
}

function selectAggregateLegacyProjectIds(
  contexts: readonly TeamPermissionContext[],
  principal: ProjectPrincipal,
) {
  const projectIds = new Set<string>()

  for (const context of contexts) {
    for (const project of context.team.projects) {
      if (findFirstProjectTeamId(context.directory.teams, project.id) !== context.team.id) {
        continue
      }
      if (!canAccessAssignedProject(principal, context, project.id, 'viewer')) {
        continue
      }

      if (
        !projectIds.has(project.id) &&
        projectIds.size >= WORK_ITEMS_LEGACY_PROJECT_READ_LIMIT
      ) {
        throw createWorkItemListLimitExceededError(
          `Workspace has more than ${WORK_ITEMS_LEGACY_PROJECT_READ_LIMIT} accessible legacy projects.`,
        )
      }

      projectIds.add(project.id)
    }
  }

  return projectIds
}

async function readProjectTasks(
  directoryId: string,
  projectId: string,
): Promise<ProjectTasksResponse> {
  const response = await readProjectIssues(directoryId, projectId)

  return {
    projectId,
    tasks: response.issues.map(toProjectTaskFromTeamIssue),
  }
}

async function readProjectIssues(directoryId: string, projectId: string) {
  const storedIssues = await teamIssues.getProjectIssues(directoryId, projectId)
  const directory = await projectDirectory.getProjectDirectory(directoryId, 'ja')
  const ownerTeamId = findFirstProjectTeamId(directory.teams, projectId)
  const legacyIssues: TeamIssueResponseItem[] = []
  if (ownerTeamId) {
    const canonicalIssueIds = new Set(storedIssues.issues.map((issue) => issue.id))
    const legacyTasks = (await projectTasks.getProjectTasks(directoryId, projectId)).tasks
    const candidates = legacyTasks.filter((task) => !canonicalIssueIds.has(task.id))
    const migrationSourceKeys = await readLegacyMigrationSourceKeys(
      directoryId,
      directory.teams,
      projectId,
      candidates,
    )

    for (const task of candidates) {
      const sourceKey = createLegacyTaskMigrationSourceKey(directoryId, projectId, task.id)
      if (!migrationSourceKeys.has(sourceKey)) {
        legacyIssues.push(toLegacyTeamIssue(task, ownerTeamId, projectId))
      }
    }
  }

  return {
    projectId,
    issues: mergeTeamIssues(storedIssues.issues, legacyIssues),
  } satisfies ProjectIssuesResponse
}

async function readLegacyTeamIssues(
  directoryId: string,
  context: TeamPermissionContext,
  principal: ProjectPrincipal,
  options: TeamIssueListReadOptions = {},
) {
  const issues: TeamIssueResponseItem[] = []
  const scanLimit = normalizeWorkItemListReadLimit(options.scanLimit)
  const clientReadLimit = createWorkItemListProbeLimit(scanLimit)

  for (const project of context.team.projects) {
    if (options.legacyProjectIds && !options.legacyProjectIds.has(project.id)) {
      continue
    }
    if (findFirstProjectTeamId(context.directory.teams, project.id) !== context.team.id) {
      continue
    }

    if (!canAccessAssignedProject(principal, context, project.id, 'viewer')) {
      continue
    }

    const [legacyResponse, canonicalResponse] = await Promise.all([
      projectTasks.getProjectTasks(
        directoryId,
        project.id,
        clientReadLimit === undefined ? undefined : { limit: clientReadLimit },
      ),
      teamIssues.getProjectIssues(
        directoryId,
        project.id,
        clientReadLimit === undefined ? undefined : { limit: clientReadLimit },
      ),
    ])
    assertWorkItemListWithinLimit(
      legacyResponse.tasks,
      scanLimit,
      `Project "${project.id}" legacy partition`,
    )
    assertWorkItemListWithinLimit(
      canonicalResponse.issues,
      scanLimit,
      `Project "${project.id}" canonical partition`,
    )
    const canonicalIssueIds = new Set(canonicalResponse.issues.map((issue) => issue.id))
    const candidates = legacyResponse.tasks.filter((task) =>
      (!options.legacyIssueId || task.id === options.legacyIssueId) &&
      !canonicalIssueIds.has(task.id)
    )
    const migrationSourceKeys = options.migrationSourceKeys ??
      await readLegacyMigrationSourceKeys(
        directoryId,
        context.directory.teams,
        project.id,
        candidates,
      )

    for (const task of candidates) {
      const sourceKey = createLegacyTaskMigrationSourceKey(directoryId, project.id, task.id)
      if (!migrationSourceKeys.has(sourceKey)) {
        issues.push(toLegacyTeamIssue(task, context.team.id, project.id))
      }
    }
  }

  return issues
}

async function readLegacyTeamIssue(
  directoryId: string,
  context: TeamPermissionContext,
  principal: ProjectPrincipal,
  issueId: string,
) {
  return (await readLegacyTeamIssues(
    directoryId,
    context,
    principal,
    { legacyIssueId: issueId },
  )).find((issue) => issue.id === issueId)
}

async function readLegacyTeamIssueIds(
  directoryId: string,
  context: TeamPermissionContext,
) {
  const issueIds: string[] = []

  for (const project of context.team.projects) {
    if (findFirstProjectTeamId(context.directory.teams, project.id) !== context.team.id) {
      continue
    }

    const response = await projectTasks.getProjectTasks(directoryId, project.id)
    issueIds.push(...response.tasks.map((task) => task.id))
  }

  return issueIds
}

async function isLegacyProjectTaskIssue(
  directoryId: string,
  projectId: string,
  taskId: string,
) {
  const directory = await projectDirectory.getProjectDirectory(directoryId, 'ja')

  if (!findFirstProjectTeamId(directory.teams, projectId)) {
    return false
  }

  const response = await projectTasks.getProjectTasks(directoryId, projectId)

  return response.tasks.some((task) => task.id === taskId)
}

function mergeTeamIssues(
  primaryIssues: TeamIssueResponseItem[],
  fallbackIssues: TeamIssueResponseItem[],
) {
  const issueIds = new Set(primaryIssues.map((issue) => issue.id))

  return [
    ...primaryIssues,
    ...fallbackIssues.filter((issue) => !issueIds.has(issue.id)),
  ]
}

function normalizeWorkItemListReadLimit(value: number | undefined) {
  if (value === undefined) {
    return undefined
  }

  return Math.max(0, Math.floor(value))
}

function createWorkItemListProbeLimit(limit: number | undefined) {
  return limit === undefined ? undefined : limit + 1
}

function assertWorkItemListWithinLimit(
  items: readonly unknown[],
  limit: number | undefined,
  scope: string,
) {
  if (limit !== undefined && items.length > limit) {
    throw createWorkItemListLimitExceededError(
      `${scope} has more than ${limit} Work Items.`,
    )
  }
}

function createWorkItemListLimitExceededError(reason: string) {
  return new ProjectDataError(
    413,
    'WorkItemListLimitExceeded',
    `${reason} Refine the Workspace before loading the aggregate Work Item list.`,
  )
}

function toLegacyTeamIssue(
  task: ProjectTaskResponseItem,
  teamId: string,
  assignedProjectId: string,
): TeamIssueResponseItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: task.id,
    teamId,
    assignedProjectId,
    titleKey: task.titleKey,
    title: task.title,
    assigneeUserId: task.assigneeUserId,
    assigneeKey: task.assigneeKey,
    assignee: task.assignee,
    assigneeEmail: task.assigneeEmail,
    assigneeName: task.assigneeName,
    status: task.status,
    dueDate: task.dueDate,
    priority: task.priority,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    source: 'legacy',
  }
}

function toProjectTaskFromTeamIssue(issue: TeamIssueResponseItem): ProjectTaskResponseItem {
  return {
    schemaVersion: issue.schemaVersion,
    revision: issue.revision,
    teamId: issue.teamId,
    source: issue.source,
    id: issue.id,
    titleKey: issue.titleKey,
    title: issue.title,
    description: issue.description,
    assigneeUserId: issue.assigneeUserId,
    assigneeEmail: issue.assigneeEmail,
    assigneeName: issue.assigneeName,
    assignee: issue.assignee,
    assigneeKey: issue.assigneeKey,
    status: issue.status,
    dueDate: issue.dueDate,
    priority: issue.priority,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }
}

function findFirstProjectTeamId(
  teams: readonly ProjectDirectoryTeamResponse[],
  projectId: string,
) {
  const teamIds = new Set(
    teams
      .filter((team) => team.projects.some((project) => project.id === projectId))
      .map((team) => team.id),
  )
  const [teamId] = teamIds

  return teamIds.size === 1 ? teamId : undefined
}

async function readLegacyMigrationSourceKeys(
  directoryId: string,
  teams: readonly ProjectDirectoryTeamResponse[],
  projectId: string,
  tasks: readonly Pick<ProjectTaskResponseItem, 'id'>[],
  client: TeamIssuesClient = teamIssues,
) {
  const teamIds = teams
    .filter((team) => team.projects.some((project) => project.id === projectId))
    .map((team) => team.id)
  const keys = teamIds.flatMap((teamId) =>
    tasks.map((task) => ({ teamId, issueId: task.id }))
  )

  if (keys.length === 0) {
    return new Set<string>()
  }

  return client.getTeamIssueMigrationSourceKeys(directoryId, keys)
}

async function readIssueAssigneeProfiles(issues: TeamIssueResponseItem[]) {
  const profiles = new Map<string, CognitoUserProfile>()
  const userIds = new Set(issues.map((issue) => issue.assigneeUserId).filter(isDefined))

  await Promise.all(
    Array.from(userIds).map(async (userId) => {
      try {
        profiles.set(userId, await cognito.getUserProfile(userId))
      } catch (error) {
        if (!isCognitoUserNotFoundError(error)) {
          console.warn('Failed to hydrate issue assignee from Cognito:', error)
        }
      }
    }),
  )

  return profiles
}

function hydrateTeamIssue(
  issue: TeamIssueResponseItem,
  profiles: Map<string, CognitoUserProfile>,
) {
  if (!issue.assigneeUserId) {
    return issue
  }

  const profile = profiles.get(issue.assigneeUserId)

  if (!profile) {
    return issue
  }

  return {
    ...issue,
    assigneeEmail: profile.email,
    assigneeName: profile.name,
  } satisfies TeamIssueResponseItem
}

async function readTaskAssigneeProfiles(tasks: ProjectTaskResponseItem[]) {
  const profiles = new Map<string, CognitoUserProfile>()
  const userIds = new Set(tasks.map((task) => task.assigneeUserId).filter(isDefined))

  await Promise.all(
    Array.from(userIds).map(async (userId) => {
      try {
        profiles.set(userId, await cognito.getUserProfile(userId))
      } catch (error) {
        if (!isCognitoUserNotFoundError(error)) {
          console.warn('Failed to hydrate task assignee from Cognito:', error)
        }
      }
    }),
  )

  return profiles
}

function hydrateProjectTask(
  task: ProjectTaskResponseItem,
  profiles: Map<string, CognitoUserProfile>,
) {
  if (!task.assigneeUserId) {
    return task
  }

  const profile = profiles.get(task.assigneeUserId)

  if (!profile) {
    return task
  }

  return {
    ...task,
    assigneeEmail: profile.email,
    assigneeName: profile.name,
  } satisfies ProjectTaskResponseItem
}

function toCognitoDirectoryErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof CognitoServiceError)) {
    console.error(error)
    return c.json({ message: 'Cognito user data is unavailable.' }, 502)
  }

  if (error.code === 'UserNotFoundException') {
    return c.json({ message: 'Cognito user was not found.' }, 404)
  }

  if (error.code === 'NotAuthorizedException' || error.code === 'CognitoAccessTokenInvalid') {
    return c.json({ message: 'Authentication failed.' }, 401)
  }

  if (error.code === 'CognitoConfigurationMissing') {
    console.error(error)
    return c.json({ message: 'Cognito is not configured.' }, 503)
  }

  if (error.code === 'TooManyRequestsException') {
    return c.json({ message: 'Cognito user data is rate limited.' }, 429)
  }

  if (error.code === 'InvalidParameterException') {
    return c.json({ message: error.message }, 400)
  }

  if (error.code === 'ResourceNotFoundException' || error.code === 'ClientNotFoundException') {
    console.error(error)
    return c.json({ message: 'Cognito local resources are not ready.' }, 503)
  }

  console.error(error)
  return c.json({ message: 'Cognito user data is unavailable.' }, 502)
}

function isCognitoUserNotFoundError(error: unknown) {
  return error instanceof CognitoServiceError && error.code === 'UserNotFoundException'
}

/**
 * AWS Cognito Identity Provider SDK を使う本番用 client です。
 */
export class AwsCognitoClient {
  /**
   * SigV4 署名と AWS endpoint 解決を委譲する SDK client です。
   */
  private readonly client: CognitoIdentityProviderClient
  /**
   * API が信頼する Cognito user pool ID です。
   */
  private readonly userPoolId: string | undefined
  /**
   * API が信頼する Cognito app client ID です。
   */
  private readonly clientId: string | undefined

  constructor(
    client = new CognitoIdentityProviderClient({ region: getAwsRegion() }),
    userPoolId = getEnv('COGNITO_USER_POOL_ID'),
    clientId = getEnv('COGNITO_CLIENT_ID'),
  ) {
    this.client = client
    this.userPoolId = userPoolId?.trim() || undefined
    this.clientId = clientId?.trim() || undefined
  }

  /**
   * USER_PASSWORD_AUTH flow で Cognito 認証を実行します。
   */
  async initiatePasswordAuth(email: string, password: string): Promise<InitiateAuthResponse> {
    const { clientId } = this.readRequiredConfiguration()

    try {
      const response = await this.client.send(new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }))

      return {
        AuthenticationResult: response.AuthenticationResult,
        ChallengeName: response.ChallengeName,
        Session: response.Session,
      }
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /**
   * access token から Cognito ユーザー情報を取得します。
   */
  async getUser(accessToken: string): Promise<GetUserResponse> {
    this.readRequiredConfiguration()

    try {
      const response = await this.client.send(new GetUserCommand({ AccessToken: accessToken }))

      return {
        Username: response.Username,
        UserAttributes: response.UserAttributes,
      }
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /**
   * Cognito user pool から所属 workspace が一致する user 一覧を取得します。
   */
  async listUsers(input: ListCognitoUsersInput): Promise<CognitoUsersResponse> {
    const { userPoolId } = this.readRequiredConfiguration()
    const limit = clampCognitoPageLimit(input.limit)
    const query = input.query?.trim()
    const users: CognitoUserProfile[] = []
    let paginationToken = input.paginationToken

    try {
      do {
        const response = await this.client.send(new ListUsersCommand({
          UserPoolId: userPoolId,
          Limit: Math.max(1, limit - users.length),
          ...(paginationToken ? { PaginationToken: paginationToken } : {}),
          ...(query ? { Filter: `"email"^="${escapeCognitoFilterValue(query.toLowerCase())}"` } : {}),
        }))
        const scopedUsers = (response.Users ?? [])
          .filter((user) => isCognitoUserInDirectory(user, input.directoryId))
          .map(toCognitoUserProfile)
          .filter(isDefined)

        users.push(...scopedUsers)
        paginationToken = response.PaginationToken
      } while (users.length < limit && paginationToken)

      return {
        users,
        nextToken: paginationToken,
      }
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /**
   * Cognito user ID から user profile を取得します。
   */
  async getUserProfile(userId: string): Promise<CognitoUserProfile> {
    const { userPoolId } = this.readRequiredConfiguration()
    const normalizedUserId = normalizeCognitoUserId(userId)

    try {
      const response = await this.client.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: normalizedUserId,
      }))
      const profile = toCognitoUserProfile(response)

      if (!profile) {
        throw new CognitoServiceError(
          404,
          'UserNotFoundException',
          `Cognito user "${normalizedUserId}" was not found.`,
        )
      }

      return profile
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /** Cognito の現在 group membership から system administrator 判定を返します。 */
  async isSystemAdmin(userId: string) {
    const { userPoolId } = this.readRequiredConfiguration()
    const normalizedUserId = normalizeCognitoUserId(userId)
    const configuredGroups = new Set(getSystemAdminGroups())
    let nextToken: string | undefined

    try {
      do {
        const response = await this.client.send(new AdminListGroupsForUserCommand({
          UserPoolId: userPoolId,
          Username: normalizedUserId,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }))
        if ((response.Groups ?? []).some((group) =>
          typeof group.GroupName === 'string' && configuredGroups.has(group.GroupName)
        )) {
          return true
        }
        nextToken = response.NextToken
      } while (nextToken)

      return false
    } catch (error) {
      if (isCognitoUserNotFoundError(error)) {
        return false
      }
      throw toCognitoSdkError(error)
    }
  }

  /**
   * 本番 Cognito client に必須の user pool / app client 設定を検証します。
   */
  private readRequiredConfiguration() {
    if (!this.userPoolId || !this.clientId) {
      throw new CognitoServiceError(
        503,
        'CognitoConfigurationMissing',
        'COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required.',
      )
    }

    return {
      userPoolId: this.userPoolId,
      clientId: this.clientId,
    }
  }
}

/**
 * Floci の Cognito JSON API を呼び出す軽量 client です。
 */
class FlociCognitoClient {
  /**
   * Floci / Cognito の endpoint URL です。
   */
  private readonly endpoint: string

  /**
   * Cognito HTTP request を abort するまでの milliseconds です。
   */
  private readonly requestTimeoutMs = 5000

  /**
   * 明示指定された Cognito user pool ID です。
   */
  private readonly userPoolId = getEnv('COGNITO_USER_POOL_ID')
  /**
   * 自動検出に使う Cognito user pool 名です。
   */
  private readonly userPoolName = getEnv('COGNITO_USER_POOL_NAME') ?? 'mukuroji-local'
  /**
   * 明示指定された Cognito app client ID です。
   */
  private readonly clientId = getEnv('COGNITO_CLIENT_ID')
  /**
   * 自動検出に使う Cognito app client 名です。
   */
  private readonly clientName = getEnv('COGNITO_USER_POOL_CLIENT_NAME') ?? 'mukuroji-web-local'
  /**
   * 解決済み user pool ID の cache です。
   */
  private resolvedUserPoolId: string | undefined
  /**
   * 解決済み app client ID の cache です。
   */
  private resolvedClientId: string | undefined

  constructor(endpoint: string) {
    this.endpoint = trimTrailingSlash(endpoint)
  }

  /**
   * USER_PASSWORD_AUTH flow で Cognito 認証を実行します。
   */
  async initiatePasswordAuth(email: string, password: string) {
    const clientId = await this.resolveClientId()

    return this.request<InitiateAuthResponse>('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    })
  }

  /**
   * NEW_PASSWORD_REQUIRED challenge に恒久 password を応答します。
   */
  async respondToNewPasswordChallenge(email: string, newPassword: string, session: string) {
    return this.request<InitiateAuthResponse>('RespondToAuthChallenge', {
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ChallengeResponses: {
        USERNAME: normalizeCognitoUserId(email),
        NEW_PASSWORD: newPassword,
      },
      ClientId: await this.resolveClientId(),
      Session: session,
    })
  }

  /**
   * access token から Cognito ユーザー情報を取得します。
   */
  async getUser(accessToken: string) {
    return this.request<GetUserResponse>('GetUser', {
      AccessToken: accessToken,
    })
  }

  /**
   * Cognito user pool から user 一覧を page 単位で取得します。
   */
  async listUsers(input: ListCognitoUsersInput) {
    const userPoolId = await this.resolveUserPoolId()
    const limit = clampCognitoPageLimit(input.limit)
    const query = input.query?.trim()
    const users: CognitoUserProfile[] = []
    let paginationToken = input.paginationToken

    do {
      const response = await this.request<ListUsersResponse>('ListUsers', {
        UserPoolId: userPoolId,
        Limit: Math.max(1, limit - users.length),
        ...(paginationToken ? { PaginationToken: paginationToken } : {}),
        ...(query ? { Filter: `"email"^="${escapeCognitoFilterValue(query.toLowerCase())}"` } : {}),
      })
      const scopedUsers = (response.Users ?? [])
        .filter((user) => isCognitoUserInDirectory(user, input.directoryId))
        .map(toCognitoUserProfile)
        .filter(isDefined)

      users.push(...scopedUsers)
      paginationToken = response.PaginationToken
    } while (users.length < limit && paginationToken)

    return {
      users,
      nextToken: paginationToken,
    } satisfies CognitoUsersResponse
  }

  /**
   * Cognito user ID から user profile を取得します。
   */
  async getUserProfile(userId: string) {
    const normalizedUserId = normalizeCognitoUserId(userId)
    const profile = toCognitoUserProfile(await this.request<CognitoUserRecord>('AdminGetUser', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: normalizedUserId,
    }))

    if (!profile) {
      throw new CognitoServiceError(
        404,
        'UserNotFoundException',
        `Cognito user "${normalizedUserId}" was not found.`,
      )
    }

    return profile
  }

  /** Cognito の現在 group membership から system administrator 判定を返します。 */
  async isSystemAdmin(userId: string) {
    const normalizedUserId = normalizeCognitoUserId(userId)
    const configuredGroups = new Set(getSystemAdminGroups())
    let nextToken: string | undefined

    try {
      do {
        const response = await this.request<AdminListGroupsForUserResponse>(
          'AdminListGroupsForUser',
          {
            UserPoolId: await this.resolveUserPoolId(),
            Username: normalizedUserId,
            ...(nextToken ? { NextToken: nextToken } : {}),
          },
        )
        if ((response.Groups ?? []).some((group) =>
          typeof group.GroupName === 'string' && configuredGroups.has(group.GroupName)
        )) {
          return true
        }
        nextToken = response.NextToken
      } while (nextToken)

      return false
    } catch (error) {
      if (isCognitoUserNotFoundError(error)) {
        return false
      }
      throw error
    }
  }

  /**
   * Workspace invitation 対象の Cognito user と directory 属性を検索します。
   */
  async findWorkspaceUser(userId: string) {
    const normalizedUserId = normalizeCognitoUserId(userId)

    try {
      const user = await this.request<CognitoUserRecord>('AdminGetUser', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: normalizedUserId,
      })
      const profile = toCognitoUserProfile(user)

      if (!profile) {
        throw new CognitoServiceError(
          502,
          'InvalidCognitoResponse',
          `Cognito user "${normalizedUserId}" did not include a stable profile.`,
        )
      }

      return {
        profile,
        directoryId: readCognitoUserDirectoryId(user),
      } satisfies CognitoWorkspaceUser
    } catch (error) {
      if (isCognitoUserNotFoundError(error)) {
        return undefined
      }

      throw error
    }
  }

  /**
   * invitation 対象 user を Cognito に作成または既存 identity と安全に関連付けます。
   */
  async provisionWorkspaceUser(input: ProvisionCognitoWorkspaceUserInput) {
    const email = normalizeCognitoUserId(input.email)
    const existingUser = input.existingUser ?? await this.findWorkspaceUser(email)

    if (existingUser) {
      this.requireCompatibleWorkspaceDirectory(existingUser, input.directoryId)
      await this.updateWorkspaceUserAttributes(email, input.directoryId, input.name)

      return {
        profile: {
          ...existingUser.profile,
          name: input.name?.trim() || existingUser.profile.name,
        },
        identityOwnership: 'pre-existing',
        deliveryStatus: 'not-required',
      } satisfies ProvisionCognitoWorkspaceUserResult
    }

    try {
      const response = await this.request<AdminCreateUserResponse>('AdminCreateUser', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: email,
        DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: createWorkspaceCognitoUserAttributes(email, input.directoryId, input.name),
      })
      const profile = response.User ? toCognitoUserProfile(response.User) : undefined

      return {
        profile: profile ?? {
          id: email,
          username: email,
          email,
          name: input.name?.trim() || undefined,
          enabled: true,
          status: 'FORCE_CHANGE_PASSWORD',
        },
        identityOwnership: 'workspace-created',
        deliveryStatus: 'sent',
      } satisfies ProvisionCognitoWorkspaceUserResult
    } catch (error) {
      if (!(error instanceof CognitoServiceError) || error.code !== 'UsernameExistsException') {
        throw error
      }

      const racedUser = await this.findWorkspaceUser(email)

      if (!racedUser) {
        throw error
      }

      this.requireCompatibleWorkspaceDirectory(racedUser, input.directoryId)
      await this.updateWorkspaceUserAttributes(email, input.directoryId, input.name)

      if (racedUser.profile.status === 'FORCE_CHANGE_PASSWORD') {
        await this.resendWorkspaceUserInvitation(racedUser.profile.username)
      }

      return {
        profile: racedUser.profile,
        identityOwnership: 'ambiguous',
        deliveryStatus: racedUser.profile.status === 'FORCE_CHANGE_PASSWORD'
          ? 'sent'
          : 'not-required',
      } satisfies ProvisionCognitoWorkspaceUserResult
    }
  }

  /**
   * Workspace が作成した未確定 Cognito user の invitation を再送します。
   */
  async resendWorkspaceUserInvitation(userId: string) {
    await this.request<AdminCreateUserResponse>('AdminCreateUser', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: normalizeCognitoUserId(userId),
      MessageAction: 'RESEND',
      DesiredDeliveryMediums: ['EMAIL'],
    })
  }

  /**
   * Workspace が所有する未確定 Cognito user を削除します。
   */
  async deleteWorkspaceUser(userId: string) {
    try {
      await this.request<Record<string, never>>('AdminDeleteUser', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: normalizeCognitoUserId(userId),
      })
    } catch (error) {
      if (!isCognitoUserNotFoundError(error)) {
        throw error
      }
    }
  }

  /**
   * 既存 Cognito user が別 Workspace に所属していないことを検証します。
   */
  private requireCompatibleWorkspaceDirectory(user: CognitoWorkspaceUser, directoryId: string) {
    if (!user.directoryId || user.directoryId === directoryId) {
      return
    }

    throw new CognitoServiceError(
      409,
      'WorkspaceDirectoryConflict',
      `Cognito user "${user.profile.id}" already belongs to another Workspace.`,
    )
  }

  /**
   * 既存 Cognito user に Workspace directory と表示属性を設定します。
   */
  private async updateWorkspaceUserAttributes(userId: string, directoryId: string, name?: string) {
    await this.request<Record<string, never>>('AdminUpdateUserAttributes', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: normalizeCognitoUserId(userId),
      UserAttributes: createWorkspaceCognitoUserAttributes(userId, directoryId, name),
    })
  }

  /**
   * 環境変数または Floci 上の一覧から app client ID を解決します。
   */
  private async resolveClientId() {
    if (this.resolvedClientId) {
      return this.resolvedClientId
    }

    if (this.clientId) {
      this.resolvedClientId = this.clientId
      return this.resolvedClientId
    }

    const userPoolId = await this.resolveUserPoolId()
    let nextToken: string | undefined

    do {
      const response = await this.request<ListUserPoolClientsResponse>('ListUserPoolClients', {
        UserPoolId: userPoolId,
        MaxResults: 60,
        ...(nextToken ? { NextToken: nextToken } : {}),
      })
      const client = response.UserPoolClients?.find(
        (candidate) => candidate.ClientName === this.clientName,
      )

      if (client?.ClientId) {
        this.resolvedClientId = client.ClientId
        return this.resolvedClientId
      }

      nextToken = response.NextToken
    } while (nextToken)

    throw new CognitoServiceError(
      404,
      'ClientNotFoundException',
      `Cognito user pool client "${this.clientName}" was not found.`,
    )
  }

  /**
   * 環境変数または Floci 上の一覧から user pool ID を解決します。
   */
  private async resolveUserPoolId() {
    if (this.resolvedUserPoolId) {
      return this.resolvedUserPoolId
    }

    if (this.userPoolId) {
      this.resolvedUserPoolId = this.userPoolId
      return this.resolvedUserPoolId
    }

    let nextToken: string | undefined

    do {
      const response = await this.request<ListUserPoolsResponse>('ListUserPools', {
        MaxResults: 60,
        ...(nextToken ? { NextToken: nextToken } : {}),
      })
      const userPool = response.UserPools?.find(
        (candidate) => candidate.Name === this.userPoolName,
      )

      if (userPool?.Id) {
        this.resolvedUserPoolId = userPool.Id
        return this.resolvedUserPoolId
      }

      nextToken = response.NextToken
    } while (nextToken)

    throw new CognitoServiceError(
      404,
      'ResourceNotFoundException',
      `Cognito user pool "${this.userPoolName}" was not found.`,
    )
  }

  /**
   * Cognito JSON 1.1 API に action 指定で POST します。
   */
  private async request<T>(action: string, payload: Record<string, unknown>) {
    let response: Response
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs)

    try {
      response = await fetch(`${this.endpoint}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      const message = isAbort
        ? 'Cognito request timed out.'
        : error instanceof Error
          ? error.message
          : 'Unknown network error.'

      throw new CognitoServiceError(
        isAbort ? 504 : 503,
        isAbort ? 'CognitoTimeout' : 'CognitoUnavailable',
        message,
      )
    } finally {
      clearTimeout(timeoutId)
    }

    const data = await parseJsonResponse<T | CognitoErrorPayload>(response)

    if (!response.ok) {
      const errorPayload = data as CognitoErrorPayload
      const errorCode = normalizeCognitoErrorCode(errorPayload.__type)

      if (!errorCode) {
        throw new CognitoServiceError(
          response.status,
          'InvalidCognitoResponse',
          errorPayload.message ?? errorPayload.Message ?? response.statusText,
        )
      }

      throw new CognitoServiceError(
        response.status,
        errorCode,
        errorPayload.message ?? errorPayload.Message ?? response.statusText,
      )
    }

    return data as T
  }
}

/**
 * DynamoDB の team/project、canonical Work Item、legacy task から集計値を算出します。
 */
export class DynamoDbDashboardSummaryClient {
  /**
   * team/project directory を読み取る client です。
   */
  private readonly projectDirectoryClient: ProjectDirectoryClient

  /**
   * project task を読み取る client です。
   */
  private readonly projectTasksClient: ProjectTasksClient

  /**
   * canonical Work Item を読み取る client です。
   */
  private readonly teamIssuesClient: TeamIssuesClient

  constructor(
    projectDirectoryClient: ProjectDirectoryClient = new DynamoDbProjectDirectoryClient(),
    projectTasksClient: ProjectTasksClient = new DynamoDbProjectTasksClient(),
    teamIssuesClient: TeamIssuesClient = new DynamoDbTeamIssuesClient(),
  ) {
    this.projectDirectoryClient = projectDirectoryClient
    this.projectTasksClient = projectTasksClient
    this.teamIssuesClient = teamIssuesClient
  }

  /**
   * ユーザー directory の team/project と task data からダッシュボード集計値を取得します。
   */
  async getSummary(directoryId: string, accessContext: DashboardSummaryAccessContext) {
    const directory = await this.projectDirectoryClient.getProjectDirectory(directoryId, 'ja')
    const visibleProjectIds = accessContext.isSystemAdmin
      ? new Set(
        directory.teams.flatMap((team) => team.projects.map((project) => project.id)),
      )
      : new Set(
        (await this.projectDirectoryClient.getProjectAccessList(directoryId, accessContext.userKey))
          .filter((access) => projectAccessAllows(access, 'viewer'))
          .map((access) => access.projectId)
      )
    const taskResponses = await Promise.all(
      Array.from(visibleProjectIds).map(async (projectId) => {
        const ownerTeamId = findFirstProjectTeamId(directory.teams, projectId)
        const [canonical, legacy] = await Promise.all([
          this.teamIssuesClient.getProjectIssues(directoryId, projectId),
          ownerTeamId
            ? this.projectTasksClient.getProjectTasks(directoryId, projectId)
            : Promise.resolve({ projectId, tasks: [] }),
        ])
        if (!ownerTeamId) {
          return canonical.issues
        }

        const canonicalIds = new Set(canonical.issues.map((issue) => issue.id))
        const candidates = legacy.tasks.filter((task) => !canonicalIds.has(task.id))
        const migrationSourceKeys = await readLegacyMigrationSourceKeys(
          directoryId,
          directory.teams,
          projectId,
          candidates,
          this.teamIssuesClient,
        )
        const compatibleLegacyTasks = candidates.filter((task) =>
          !migrationSourceKeys.has(
            createLegacyTaskMigrationSourceKey(directoryId, projectId, task.id),
          )
        )

        return [
          ...canonical.issues,
          ...compatibleLegacyTasks,
        ]
      }),
    )
    const tasks = taskResponses.flat()

    return {
      projects: visibleProjectIds.size,
      tasks: tasks.filter((task) => task.status !== 'done').length,
      blocked: tasks.filter((task) => task.priority === 'high' && task.status !== 'done').length,
      updatedAt: new Date().toISOString(),
      source: 'dynamodb',
    } satisfies DashboardSummaryResponse
  }
}

/**
 * DynamoDB の project task item を読み取る client です。
 */
export class DynamoDbProjectTasksClient {
  /**
   * project task item を保存する DynamoDB table 名です。
   */
  private readonly tableName: string
  /**
   * DynamoDB DocumentClient です。
   */
  private readonly documentClient: DynamoDBDocumentClient
  /**
   * table 初期化に使う低レベル DynamoDB client です。
   */
  private readonly dynamoDbClient: DynamoDBClient
  /**
   * ローカル DynamoDB の table 欠落を自動復旧するかどうかです。
   */
  private readonly bootstrapLocalTables: boolean
  /**
   * immutable audit event を保存する DynamoDB table 名です。
   */
  private readonly auditTableName?: string

  constructor(
    tableName =
      getEnv('MUKUROJI_PROJECT_TASKS_TABLE') ??
      getEnv('TASKS_TABLE_NAME') ??
      'mukuroji-project-tasks-v2-local',
    documentClient = createDynamoDbDocumentClient(),
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTables = dynamoDbClient === undefined && shouldBootstrapLocalDynamoDb(),
    auditTableName = getConfiguredAuditTableName(),
  ) {
    this.tableName = tableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
    this.auditTableName = auditTableName
  }

  /**
   * DynamoDB からプロジェクト別タスク一覧を取得します。
   */
  async getProjectTasks(
    directoryId: string,
    projectId: string,
    options: WorkItemListReadOptions = {},
  ) {
    try {
      const items = await this.queryProjectTaskItems(directoryId, projectId, options)
      const tasks = items.map(toProjectTaskResponseItem)

      return {
        projectId,
        tasks,
      } satisfies ProjectTasksResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * legacy project task table への作成を拒否します。
   */
  async createProjectTask(
    _directoryId: string,
    _projectId: string,
    _input: CreateProjectTaskRequestBody,
    _auditContext?: MutationAuditContext,
  ) {
    throw createLegacyProjectTaskReadOnlyError()
  }

  /**
   * legacy project task table の状態更新を拒否します。
   */
  async updateProjectTaskStatus(
    _directoryId: string,
    _projectId: string,
    _taskId: string,
    _input: UpdateProjectTaskStatusRequestBody,
    _auditContext?: MutationAuditContext,
  ) {
    throw createLegacyProjectTaskReadOnlyError()
  }

  /**
   * DynamoDB から project partition の task item を全件または指定上限まで取得します。
   */
  private async queryProjectTaskItems(
    directoryId: string,
    projectId: string,
    options: WorkItemListReadOptions = {},
    canBootstrapLocalTable = true,
  ) {
    try {
      const items: unknown[] = []
      const limit = normalizeWorkItemListReadLimit(options.limit)
      let exclusiveStartKey: Record<string, unknown> | undefined

      if (limit === 0) {
        return items
      }

      do {
        const remaining = limit === undefined ? undefined : limit - items.length
        const response = await this.documentClient.send(
          new QueryCommand({
            TableName: this.tableName,
            IndexName: 'ProjectSortOrderIndex',
            KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
            ExpressionAttributeValues: {
              ':directoryProjectId': createDirectoryProjectId(directoryId, projectId),
            },
            ExclusiveStartKey: exclusiveStartKey,
            ScanIndexForward: true,
            ...(remaining === undefined ? {} : { Limit: remaining }),
          }),
        )

        items.push(...(
          remaining === undefined
            ? response.Items ?? []
            : (response.Items ?? []).slice(0, remaining)
        ))
        if (limit !== undefined && items.length >= limit) {
          break
        }
        exclusiveStartKey = response.LastEvaluatedKey
      } while (exclusiveStartKey)

      return items
    } catch (error) {
      if (
        canBootstrapLocalTable &&
        this.bootstrapLocalTables &&
        isResourceNotFoundError(error) &&
        await ensureLocalProjectTasksTable(this.tableName, this.dynamoDbClient)
      ) {
        return this.queryProjectTaskItems(directoryId, projectId, options, false)
      }

      throw error
    }
  }
}

/**
 * DynamoDB の team issue item と event item を読み書きする client です。
 */
export class DynamoDbTeamIssuesClient {
  /**
   * team issue item を保存する DynamoDB table 名です。
   */
  private readonly issueTableName: string
  /**
   * team issue event item を保存する DynamoDB table 名です。
   */
  private readonly eventTableName: string
  /**
   * DynamoDB DocumentClient です。
   */
  private readonly documentClient: DynamoDBDocumentClient
  /**
   * table 初期化に使う低レベル DynamoDB client です。
   */
  private readonly dynamoDbClient: DynamoDBClient
  /**
   * ローカル DynamoDB の table 欠落を自動復旧するかどうかです。
   */
  private readonly bootstrapLocalTables: boolean
  /**
   * immutable audit event を保存する DynamoDB table 名です。
   */
  private readonly auditTableName?: string
  /** BatchGetItem retry 前に待機する関数です。 */
  private readonly batchGetRetrySleep: (ms: number) => Promise<void>
  /** BatchGetItem retry の jitter 値を生成する関数です。 */
  private readonly batchGetRetryRandom: () => number

  constructor(
    issueTableName =
      getEnv('MUKUROJI_WORK_ITEMS_TABLE') ??
      getEnv('WORK_ITEMS_TABLE_NAME') ??
      getEnv('MUKUROJI_TEAM_ISSUES_TABLE') ??
      getEnv('TEAM_ISSUES_TABLE_NAME') ??
      'mukuroji-team-issues-local',
    eventTableName =
      getEnv('MUKUROJI_TEAM_ISSUE_EVENTS_TABLE') ??
      getEnv('TEAM_ISSUE_EVENTS_TABLE_NAME') ??
      'mukuroji-team-issue-events-local',
    documentClient = createDynamoDbDocumentClient(),
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTables = dynamoDbClient === undefined && shouldBootstrapLocalDynamoDb(),
    auditTableName = getConfiguredAuditTableName(),
    batchGetRetrySleep: (ms: number) => Promise<void> = sleep,
    batchGetRetryRandom: () => number = Math.random,
  ) {
    this.issueTableName = issueTableName
    this.eventTableName = eventTableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
    this.auditTableName = auditTableName
    this.batchGetRetrySleep = batchGetRetrySleep
    this.batchGetRetryRandom = batchGetRetryRandom
  }

  /**
   * DynamoDB から指定 team ID の Issue 一覧を取得します。
   */
  async getTeamIssues(
    directoryId: string,
    teamId: string,
    options: WorkItemListReadOptions = {},
  ) {
    const response = await this.getTeamIssuesForAggregate(directoryId, teamId, options)

    return {
      teamId: response.teamId,
      issues: response.issues,
    } satisfies TeamIssuesResponse
  }

  /**
   * DynamoDB から aggregate 用の Issue 一覧と非公開 migration metadata を取得します。
   */
  async getTeamIssuesForAggregate(
    directoryId: string,
    teamId: string,
    options: WorkItemListReadOptions = {},
  ) {
    await this.ensureLocalTables()

    try {
      const items = await this.queryTeamIssueItems(directoryId, teamId, options)

      return {
        teamId,
        issues: items.map(toTeamIssueResponseItem),
        migrationSourceKeys: items.flatMap((item) =>
          item.migrationSourceKey ? [item.migrationSourceKey] : []
        ),
      } satisfies AggregateTeamIssuesRead
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * Team / Issue base key の canonical row 存在と migration identity を確認します。
   */
  async getTeamIssueMigrationSourceKeys(
    directoryId: string,
    keys: readonly TeamIssueMigrationLookupKey[],
  ) {
    await this.ensureLocalTables()

    try {
      const uniqueKeys = [...new Map(keys.map((key) => [
        createTeamIssueLookupKey(key.teamId, key.issueId),
        {
          directoryTeamId: createDirectoryTeamId(directoryId, key.teamId),
          issueId: key.issueId,
        },
      ])).values()]
      const migrationSourceKeys = new Set<string>()

      for (let offset = 0; offset < uniqueKeys.length; offset += DYNAMODB_BATCH_GET_KEY_LIMIT) {
        let pendingKeys: NonNullable<
          NonNullable<NonNullable<BatchGetCommandInput['RequestItems']>[string]>['Keys']
        > = uniqueKeys.slice(offset, offset + DYNAMODB_BATCH_GET_KEY_LIMIT)

        for (
          let attempt = 0;
          pendingKeys.length > 0 && attempt < DYNAMODB_BATCH_GET_ATTEMPT_LIMIT;
          attempt += 1
        ) {
          const response: BatchGetCommandOutput = await this.documentClient.send(
            new BatchGetCommand({
              RequestItems: {
                [this.issueTableName]: {
                  Keys: pendingKeys,
                  ConsistentRead: true,
                },
              },
            }),
          )
          for (const value of response.Responses?.[this.issueTableName] ?? []) {
            const item = toTeamIssueItem(value)
            if (item.directoryId !== directoryId) {
              throw new ProjectDataError(
                503,
                'InvalidTeamIssue',
                'Team issue migration lookup returned another Workspace.',
              )
            }
            if (item.migrationSourceKey) {
              migrationSourceKeys.add(item.migrationSourceKey)
            }
          }
          pendingKeys = response.UnprocessedKeys?.[this.issueTableName]?.Keys ?? []
          if (
            pendingKeys.length > 0 &&
            attempt + 1 < DYNAMODB_BATCH_GET_ATTEMPT_LIMIT
          ) {
            await this.batchGetRetrySleep(
              createDynamoDbBatchGetRetryDelayMs(attempt, this.batchGetRetryRandom),
            )
          }
        }

        if (pendingKeys.length > 0) {
          throw new ProjectDataError(
            503,
            'TeamIssueMigrationLookupIncomplete',
            'Work Item migration identity lookup could not process every key.',
          )
        }
      }

      return migrationSourceKeys
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB から指定 project ID にアサインされた Issue 一覧を取得します。
   */
  async getProjectIssues(
    directoryId: string,
    projectId: string,
    options: WorkItemListReadOptions = {},
  ) {
    await this.ensureLocalTables()

    try {
      const items = await this.queryProjectIssueItems(directoryId, projectId, options)

      return {
        projectId,
        issues: items.map(toTeamIssueResponseItem),
      } satisfies ProjectIssuesResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB から Issue 詳細、コメント、活動履歴を取得します。
   */
  async getTeamIssueDetail(
    directoryId: string,
    teamId: string,
    issueId: string,
    options: TeamIssueDetailReadOptions = {},
  ) {
    await this.ensureLocalTables()

    try {
      const issue = await this.getRequiredTeamIssueItem(
        directoryId,
        teamId,
        issueId,
        options.consistentIssueRead === true,
      )
      const eventPage = options.eventLimit === 0
        ? { items: [] as TeamIssueEventItem[] }
        : await this.queryTeamIssueEventItems(directoryId, teamId, issueId, options)
      const events = eventPage.items

      return {
        issue: toTeamIssueResponseItem(issue),
        comments: events
          .filter((event) => event.eventType === 'commented' && event.body)
          .map(toTeamIssueCommentResponseItem),
        activity: events.map(toTeamIssueActivityResponseItem),
        ...(eventPage.nextCursor ? { nextEventCursor: eventPage.nextCursor } : {}),
      } satisfies TeamIssueDetailResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB に team issue を作成します。
   */
  async createTeamIssue(
    directoryId: string,
    teamId: string,
    input: CreateTeamIssueRequestBody,
    actorUserId: string,
    reservedIssueIds: string[] = [],
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalTables()

    const title = readRequiredString(input.title, 'Issue title is required.')
    const description = readOptionalString(input.description, 'Issue description is invalid.')
    const assigneeUserId = readTeamIssueAssigneeUserId(input)
    const status = readTaskStatus(input.status)
    const dueDate = readRequiredString(input.dueDate, 'Issue due date is required.')
    const priority = readTaskPriority(input.priority)
    const assignedProjectId = readAssignedProjectId(input.assignedProjectId)
    const directoryTeamId = createDirectoryTeamId(directoryId, teamId)
    const now = new Date().toISOString()

    try {
      const currentIssues = await this.getTeamIssues(directoryId, teamId)
      const issueId = createUniqueResourceId(
        title,
        [...currentIssues.issues.map((issue) => issue.id), ...reservedIssueIds],
      )
      const item: TeamIssueItem = {
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        revision: 1,
        directoryId,
        directoryTeamId,
        teamId,
        issueId,
        sortOrder: (currentIssues.issues.length + 1) * 10,
        title,
        assigneeUserId,
        creatorMemberKey: actorUserId,
        status,
        dueDate,
        priority,
        createdAt: now,
        updatedAt: now,
      }

      if (description) {
        item.description = description
      }

      if (assignedProjectId) {
        item.assignedProjectId = assignedProjectId
        item.directoryProjectId = createDirectoryProjectId(directoryId, assignedProjectId)
      }

      const eventItem = this.createIssueEventItem({
        directoryId,
        teamId,
        issueId,
        eventType: 'created',
        actorUserId,
        summary: 'Issue was created.',
        createdAt: now,
      })
      const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'work-item.created',
        entityType: 'work-item',
        entityId: createTeamIssueAuditEntityId(teamId, issueId),
        action: 'created',
        occurredAt: now,
        changes: createAuditFieldChanges(undefined, item, [
          'title',
          'description',
          'assignedProjectId',
          'assigneeUserId',
          'status',
          'dueDate',
          'priority',
        ]),
        metadata: {
          adapter: 'canonical-work-item',
          teamId,
          projectId: assignedProjectId,
          afterRevision: item.revision,
        },
      })
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.issueTableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)',
              },
            },
            {
              Put: {
                TableName: this.eventTableName,
                Item: eventItem,
                ConditionExpression: 'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
              },
            },
            ...(auditPut ? [auditPut] : []),
          ],
        }),
      )

      return {
        issue: toTeamIssueResponseItem(item),
      } satisfies CreateTeamIssueResponse
    } catch (error) {
      if (
        isAwsNamedError(error, 'TransactionCanceledException') &&
        hasTransactionConditionalFailure(error)
      ) {
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB の team issue を更新します。
   */
  async updateTeamIssue(
    directoryId: string,
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueRequestBody,
    actorUserId: string,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalTables()
    const expectedRevision = readWorkItemExpectedRevision(input.expectedRevision)
    const nextRevision = expectedRevision + 1
    const directoryTeamId = createDirectoryTeamId(directoryId, teamId)
    const expressionAttributeNames: Record<string, string> = {
      '#schemaVersion': 'schemaVersion',
      '#revision': 'revision',
      '#updatedAt': 'updatedAt',
    }
    const expressionAttributeValues: Record<string, unknown> = {
      ':schemaVersion': WORK_ITEM_SCHEMA_VERSION,
      ':expectedRevision': expectedRevision,
      ':legacyRevision': 1,
      ':nextRevision': nextRevision,
      ':updatedAt': new Date().toISOString(),
    }
    const setExpressions = [
      '#schemaVersion = :schemaVersion',
      '#revision = :nextRevision',
      '#updatedAt = :updatedAt',
    ]
    const removeExpressions: string[] = []

    if ('title' in input) {
      expressionAttributeNames['#title'] = 'title'
      expressionAttributeValues[':title'] = readRequiredString(input.title, 'Issue title is required.')
      setExpressions.push('#title = :title')
    }

    if ('description' in input) {
      const description = readOptionalString(input.description, 'Issue description is invalid.')
      expressionAttributeNames['#description'] = 'description'

      if (description) {
        expressionAttributeValues[':description'] = description
        setExpressions.push('#description = :description')
      } else {
        removeExpressions.push('#description')
      }
    }

    if ('assignedProjectId' in input) {
      const assignedProjectId = readAssignedProjectId(input.assignedProjectId)
      expressionAttributeNames['#assignedProjectId'] = 'assignedProjectId'
      expressionAttributeNames['#directoryProjectId'] = 'directoryProjectId'

      if (assignedProjectId) {
        expressionAttributeValues[':assignedProjectId'] = assignedProjectId
        expressionAttributeValues[':directoryProjectId'] = createDirectoryProjectId(directoryId, assignedProjectId)
        setExpressions.push('#assignedProjectId = :assignedProjectId')
        setExpressions.push('#directoryProjectId = :directoryProjectId')
      } else {
        removeExpressions.push('#assignedProjectId')
        removeExpressions.push('#directoryProjectId')
      }
    }

    if ('assigneeUserId' in input) {
      expressionAttributeNames['#assigneeUserId'] = 'assigneeUserId'
      expressionAttributeValues[':assigneeUserId'] = readTeamIssueAssigneeUserId(input)
      setExpressions.push('#assigneeUserId = :assigneeUserId')
    }

    if ('status' in input) {
      expressionAttributeNames['#status'] = 'status'
      expressionAttributeValues[':status'] = readRequiredTaskStatus(input.status)
      setExpressions.push('#status = :status')
    }

    if ('dueDate' in input) {
      expressionAttributeNames['#dueDate'] = 'dueDate'
      expressionAttributeValues[':dueDate'] = readRequiredString(input.dueDate, 'Issue due date is required.')
      setExpressions.push('#dueDate = :dueDate')
    }

    if ('priority' in input) {
      expressionAttributeNames['#priority'] = 'priority'
      expressionAttributeValues[':priority'] = readTaskPriority(input.priority)
      setExpressions.push('#priority = :priority')
    }

    const updateExpression = [
      `SET ${setExpressions.join(', ')}`,
      removeExpressions.length > 0 ? `REMOVE ${removeExpressions.join(', ')}` : undefined,
    ].filter(isDefined).join(' ')

    try {
      const beforeIssue = await this.getRequiredTeamIssueItem(directoryId, teamId, issueId, true)
      if (beforeIssue.revision !== expectedRevision) {
        throw createWorkItemRevisionConflictError()
      }
      const afterIssue = {
        ...beforeIssue,
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        revision: nextRevision,
        updatedAt: expressionAttributeValues[':updatedAt'] as string,
      }
      for (const [placeholder, field] of Object.entries(expressionAttributeNames)) {
        if (field === 'schemaVersion' || field === 'revision' || field === 'updatedAt') {
          continue
        }

        const value = expressionAttributeValues[`:${field}`]
        if (value !== undefined) {
          ;(afterIssue as unknown as Record<string, unknown>)[field] = value
        } else if (removeExpressions.includes(placeholder)) {
          delete (afterIssue as unknown as Record<string, unknown>)[field]
        }
      }
      const eventItem = this.createIssueEventItem({
        directoryId,
        teamId,
        issueId,
        eventType: 'updated',
        actorUserId,
        summary: 'Issue was updated.',
        createdAt: expressionAttributeValues[':updatedAt'] as string,
      })
      const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'work-item.updated',
        entityType: 'work-item',
        entityId: createTeamIssueAuditEntityId(teamId, issueId),
        action: 'updated',
        occurredAt: expressionAttributeValues[':updatedAt'] as string,
        changes: createAuditFieldChanges(beforeIssue, afterIssue, [
          'title',
          'description',
          'assignedProjectId',
          'assigneeUserId',
          'status',
          'dueDate',
          'priority',
        ]),
        metadata: {
          adapter: 'canonical-work-item',
          teamId,
          projectId: afterIssue.assignedProjectId,
          beforeRevision: expectedRevision,
          afterRevision: nextRevision,
        },
      })
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.issueTableName,
                Key: {
                  directoryTeamId,
                  issueId,
                },
                UpdateExpression: updateExpression,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues,
                ConditionExpression:
                  'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
                  '(#revision = :expectedRevision OR ' +
                  '(attribute_not_exists(#revision) AND :expectedRevision = :legacyRevision))',
              },
            },
            {
              Put: {
                TableName: this.eventTableName,
                Item: eventItem,
                ConditionExpression: 'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
              },
            },
            ...(auditPut ? [auditPut] : []),
          ],
        }),
      )
      const issue = toTeamIssueResponseItem(
        await this.getRequiredTeamIssueItem(directoryId, teamId, issueId, true),
      )

      return {
        issue,
      } satisfies UpdateTeamIssueResponse
    } catch (error) {
      if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
        throw new ProjectDataError(404, 'TeamIssueNotFound', 'Issue was not found.')
      }

      const cancellationReasonsMissing =
        isAwsNamedError(error, 'TransactionCanceledException') &&
        (
          !isRecord(error) ||
          !Array.isArray(error.CancellationReasons) ||
          error.CancellationReasons.length === 0
        )

      if (isTransactionConditionalFailureAt(error, 0) || cancellationReasonsMissing) {
        let latestIssue: TeamIssueItem

        try {
          latestIssue = await this.getRequiredTeamIssueItem(directoryId, teamId, issueId, true)
        } catch (readError) {
          if (readError instanceof ProjectDataError && readError.code === 'TeamIssueNotFound') {
            throw readError
          }

          if (readError instanceof ProjectDataError) {
            throw readError
          }

          throw toProjectDataError(readError)
        }

        if (latestIssue.revision !== expectedRevision) {
          throw createWorkItemRevisionConflictError()
        }

        if (isTransactionConditionalFailureAt(error, 0)) {
          throw createProjectDataConflictError()
        }
      }

      if (hasTransactionConditionalFailure(error)) {
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB に team issue コメントを追加します。
   */
  async createTeamIssueComment(
    directoryId: string,
    teamId: string,
    issueId: string,
    input: CreateTeamIssueCommentRequestBody,
    actorUserId: string,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalTables()
    await this.getRequiredTeamIssueItem(directoryId, teamId, issueId)

    const createdAt = new Date().toISOString()
    const body = readRequiredCommentBody(input.body)
    const item = this.createIssueEventItem({
      directoryId,
      teamId,
      issueId,
      eventType: 'commented',
      actorUserId,
      body,
      summary: 'Comment was added.',
      createdAt,
    })
    const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
      directoryId,
      eventType: 'comment.created',
      entityType: 'work-item',
      entityId: createTeamIssueAuditEntityId(teamId, issueId),
      target: {
        type: 'comment',
        id: createTeamIssueAuditCommentId(teamId, issueId, item.eventId),
      },
      action: 'commented',
      occurredAt: createdAt,
      changes: createAuditFieldChanges(undefined, { body }, ['body'], ['body']),
      metadata: { adapter: 'team-issue', teamId, commentId: item.eventId },
    })

    try {
      if (auditPut) {
        await this.documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: this.issueTableName,
                  Key: {
                    directoryTeamId: createDirectoryTeamId(directoryId, teamId),
                    issueId,
                  },
                  ConditionExpression: 'attribute_exists(directoryTeamId) AND attribute_exists(issueId)',
                },
              },
              {
                Put: {
                  TableName: this.eventTableName,
                  Item: item,
                  ConditionExpression:
                    'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
                },
              },
              auditPut,
            ],
          }),
        )
      } else {
        await this.documentClient.send(
          new PutCommand({
            TableName: this.eventTableName,
            Item: item,
            ConditionExpression:
              'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
          }),
        )
      }
    } catch (error) {
      if (isTransactionConditionalFailureAt(error, 0)) {
        if (!await this.hasTeamIssueItem(directoryId, teamId, issueId)) {
          throw new ProjectDataError(404, 'TeamIssueNotFound', 'Issue was not found.')
        }

        throw createProjectDataConflictError()
      }

      if (hasTransactionConditionalFailure(error)) {
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }

    return {
      comment: toTeamIssueCommentResponseItem(item),
      activity: toTeamIssueActivityResponseItem(item),
    } satisfies CreateTeamIssueCommentResponse
  }

  private async hasTeamIssueItem(directoryId: string, teamId: string, issueId: string) {
    try {
      await this.getRequiredTeamIssueItem(directoryId, teamId, issueId, true)

      return true
    } catch (error) {
      if (error instanceof ProjectDataError && error.code === 'TeamIssueNotFound') {
        return false
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  private async getRequiredTeamIssueItem(
    directoryId: string,
    teamId: string,
    issueId: string,
    consistentRead = false,
  ) {
    const response = await this.documentClient.send(
      new GetCommand({
        TableName: this.issueTableName,
        Key: {
          directoryTeamId: createDirectoryTeamId(directoryId, teamId),
          issueId,
        },
        ConsistentRead: consistentRead,
      }),
    )

    if (!response.Item) {
      throw new ProjectDataError(404, 'TeamIssueNotFound', 'Issue was not found.')
    }

    return toTeamIssueItem(response.Item)
  }

  private async queryTeamIssueItems(
    directoryId: string,
    teamId: string,
    options: WorkItemListReadOptions = {},
  ) {
    const items: unknown[] = []
    const limit = normalizeWorkItemListReadLimit(options.limit)
    let exclusiveStartKey: Record<string, unknown> | undefined

    if (limit === 0) {
      return []
    }

    do {
      const remaining = limit === undefined ? undefined : limit - items.length
      const response = await this.documentClient.send(
        new QueryCommand({
          TableName: this.issueTableName,
          IndexName: 'TeamIssueSortOrderIndex',
          KeyConditionExpression: 'directoryTeamId = :directoryTeamId',
          ExpressionAttributeValues: {
            ':directoryTeamId': createDirectoryTeamId(directoryId, teamId),
          },
          ExclusiveStartKey: exclusiveStartKey,
          ScanIndexForward: true,
          ...(remaining === undefined ? {} : { Limit: remaining }),
        }),
      )

      items.push(...(
        remaining === undefined
          ? response.Items ?? []
          : (response.Items ?? []).slice(0, remaining)
      ))
      if (limit !== undefined && items.length >= limit) {
        break
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items.map(toTeamIssueItem)
  }

  private async queryProjectIssueItems(
    directoryId: string,
    projectId: string,
    options: WorkItemListReadOptions = {},
  ) {
    const items: unknown[] = []
    const limit = normalizeWorkItemListReadLimit(options.limit)
    let exclusiveStartKey: Record<string, unknown> | undefined

    if (limit === 0) {
      return []
    }

    do {
      const remaining = limit === undefined ? undefined : limit - items.length
      const response = await this.documentClient.send(
        new QueryCommand({
          TableName: this.issueTableName,
          IndexName: 'AssignedProjectIssueIndex',
          KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
          ExpressionAttributeValues: {
            ':directoryProjectId': createDirectoryProjectId(directoryId, projectId),
          },
          ExclusiveStartKey: exclusiveStartKey,
          ScanIndexForward: true,
          ...(remaining === undefined ? {} : { Limit: remaining }),
        }),
      )

      items.push(...(
        remaining === undefined
          ? response.Items ?? []
          : (response.Items ?? []).slice(0, remaining)
      ))
      if (limit !== undefined && items.length >= limit) {
        break
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items.map(toTeamIssueItem)
  }

  private async queryTeamIssueEventItems(
    directoryId: string,
    teamId: string,
    issueId: string,
    options: TeamIssueDetailReadOptions = {},
  ) {
    const items: unknown[] = []
    const eventLimit = options.eventLimit === undefined
      ? undefined
      : Math.max(1, Math.floor(options.eventLimit))
    const directoryTeamIssueId = createDirectoryTeamIssueId(directoryId, teamId, issueId)
    let exclusiveStartKey = decodeTeamIssueEventCursor(
      options.eventCursor,
      directoryTeamIssueId,
    )

    do {
      const remaining = eventLimit === undefined ? undefined : eventLimit - items.length
      const response = await this.documentClient.send(
        new QueryCommand({
          TableName: this.eventTableName,
          KeyConditionExpression: 'directoryTeamIssueId = :directoryTeamIssueId',
          ExpressionAttributeValues: {
            ':directoryTeamIssueId': directoryTeamIssueId,
            ...(options.eventType ? { ':eventType': options.eventType } : {}),
          },
          ...(options.eventType ? { FilterExpression: 'eventType = :eventType' } : {}),
          ExclusiveStartKey: exclusiveStartKey,
          ScanIndexForward: options.newestEventsFirst !== true,
          ...(remaining === undefined ? {} : { Limit: remaining }),
        }),
      )

      items.push(...(response.Items ?? []))
      exclusiveStartKey = response.LastEvaluatedKey
      if (eventLimit !== undefined) {
        break
      }
    } while (exclusiveStartKey)

    return {
      items: items.map(toTeamIssueEventItem),
      ...(exclusiveStartKey
        ? { nextCursor: encodeTeamIssueEventCursor(directoryTeamIssueId, exclusiveStartKey) }
        : {}),
    }
  }

  private async putIssueEvent(input: Omit<TeamIssueEventItem, 'directoryTeamIssueId' | 'eventId'>) {
    const item = this.createIssueEventItem(input)

    await this.documentClient.send(
      new PutCommand({
        TableName: this.eventTableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
      }),
    )

    return item
  }

  private createIssueEventItem(input: Omit<TeamIssueEventItem, 'directoryTeamIssueId' | 'eventId'>) {
    return {
      ...input,
      directoryTeamIssueId: createDirectoryTeamIssueId(input.directoryId, input.teamId, input.issueId),
      eventId: createTeamIssueEventId(input.createdAt, input.eventType),
    } satisfies TeamIssueEventItem
  }

  private async ensureLocalTables() {
    if (!this.bootstrapLocalTables) {
      return
    }

    await ensureLocalTeamIssuesTable(this.issueTableName, this.dynamoDbClient)
    await ensureLocalTeamIssueEventsTable(this.eventTableName, this.dynamoDbClient)
    await ensureConfiguredAuditTable(
      this.auditTableName,
      this.dynamoDbClient,
      this.bootstrapLocalTables,
    )
  }
}

/**
 * DynamoDB の team/project directory item を読み取る client です。
 */
export class DynamoDbProjectDirectoryClient {
  /**
   * team/project directory item を保存する DynamoDB table 名です。
   */
  private readonly tableName: string
  /**
   * DynamoDB DocumentClient です。
   */
  private readonly documentClient: DynamoDBDocumentClient
  /**
   * table 初期化に使う低レベル DynamoDB client です。
   */
  private readonly dynamoDbClient: DynamoDBClient
  /**
   * ローカル DynamoDB の table 欠落を自動復旧するかどうかです。
   */
  private readonly bootstrapLocalTables: boolean
  /**
   * immutable audit event を保存する DynamoDB table 名です。
   */
  private readonly auditTableName?: string
  /**
   * project member mutation と競合させる Workspace access table 名です。
   */
  private readonly workspaceAccessTableName: string

  constructor(
    tableName =
      getEnv('MUKUROJI_PROJECT_DIRECTORY_TABLE') ??
      getEnv('PROJECT_DIRECTORY_TABLE_NAME') ??
      'mukuroji-project-directory-local',
    documentClient = createDynamoDbDocumentClient(),
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTables = dynamoDbClient === undefined && shouldBootstrapLocalDynamoDb(),
    auditTableName = getConfiguredAuditTableName(),
    workspaceAccessTableName =
      getEnv('MUKUROJI_WORKSPACE_ACCESS_TABLE') ??
      getEnv('WORKSPACE_ACCESS_TABLE_NAME') ??
      'mukuroji-workspace-access-local',
  ) {
    this.tableName = tableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
    this.auditTableName = auditTableName
    this.workspaceAccessTableName = workspaceAccessTableName
  }

  /**
   * DynamoDB から sidebar 用の team/project 階層を取得します。
   */
  async getProjectDirectory(directoryId: string, locale: Locale) {
    try {
      const items = await this.queryDirectoryItems(directoryId)

      return {
        teams: toProjectDirectoryResponse(items, locale, directoryId),
      } satisfies ProjectDirectoryResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * active project と指定 member の role を 1 directory read で取得します。
   */
  async getProjectAccess(directoryId: string, projectId: string, memberKey: string) {
    try {
      const normalizedMemberKey = normalizeProjectMemberKey(memberKey)
      const items = await this.readValidDirectoryItems(directoryId)

      return toProjectAccessEntries(items, normalizedMemberKey).find((access) => {
        return access.projectId === projectId
      })
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * active project と指定 member の role を 1 directory read で取得します。
   */
  async getProjectAccessList(directoryId: string, memberKey: string) {
    try {
      const normalizedMemberKey = normalizeProjectMemberKey(memberKey)
      const items = await this.readValidDirectoryItems(directoryId, true)

      return toProjectAccessEntries(items, normalizedMemberKey)
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * ユーザーの directory に指定 project ID が含まれるかどうかを判定します。
   */
  async hasProjectAccess(directoryId: string, projectId: string) {
    try {
      return await this.getProjectAccess(
        directoryId,
        projectId,
        'project-access-check@example.invalid',
      ) !== undefined
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * ユーザーの project role を取得します。
   */
  async getProjectRole(directoryId: string, projectId: string, memberKey: string) {
    try {
      return (await this.getProjectAccess(directoryId, projectId, memberKey))?.role
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB から project member 一覧を取得します。
   */
  async getProjectMembers(directoryId: string, projectId: string) {
    try {
      const items = await this.readValidDirectoryItems(directoryId)
      this.requireActiveProject(items, projectId)
      const members = items
        .filter((item) => item.entryType === 'project-member' && item.projectId === projectId)
        .sort(compareProjectMemberItems)
        .map(toProjectMemberResponseItem)

      return {
        projectId,
        members,
      } satisfies ProjectMembersResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB の project member role を作成または更新します。
   */
  async updateProjectMember(
    directoryId: string,
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberRequestBody,
    expectedWorkspaceMemberVersion: number,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalAuditTable()
    const normalizedMemberKey = normalizeProjectMemberKey(memberKey)
    const email = readProjectMemberEmail(input.email, normalizedMemberKey)
    const name = readOptionalProjectMemberName(input.name)
    const role = readProjectRole(input.role)
    let existingMemberExpected = false
    let managerGuarded = false

    try {
      const items = await this.readValidDirectoryItems(directoryId, true)
      this.requireActiveProject(items, projectId)
      const existingMember = items.find((item) =>
        item.entryType === 'project-member' &&
        item.projectId === projectId &&
        item.memberKey === normalizedMemberKey,
      )
      existingMemberExpected = existingMember !== undefined

      const guardManager = (
        existingMember?.role === 'manager' &&
        role !== 'manager'
      )
        ? this.requireAnotherProjectManager(items, projectId, normalizedMemberKey)
        : undefined
      managerGuarded = guardManager !== undefined

      const updatedAt = new Date().toISOString()
      const item: ProjectMemberItem = {
        directoryId,
        entryKey: createProjectMemberEntryKey(projectId, normalizedMemberKey),
        entryType: 'project-member',
        projectId,
        memberKey: normalizedMemberKey,
        email,
        name,
        role,
        createdAt: existingMember?.createdAt ?? updatedAt,
        updatedAt,
      }
      const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: existingMember ? 'member.updated' : 'member.added',
        entityType: 'member',
        entityId: `${projectId}/${normalizedMemberKey}`,
        action: existingMember ? 'updated' : 'created',
        occurredAt: updatedAt,
        changes: createAuditFieldChanges(existingMember, item, ['email', 'name', 'role']),
        metadata: { projectId, memberKey: normalizedMemberKey },
      })
      const memberPut = {
        TableName: this.tableName,
        Item: item,
        ConditionExpression: existingMember
          ? '#updatedAt = :expectedUpdatedAt'
          : 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        ...(existingMember
          ? {
              ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
              ExpressionAttributeValues: { ':expectedUpdatedAt': existingMember.updatedAt },
            }
          : {}),
      }

      const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = []

      if (guardManager) {
        transactItems.push({
          ConditionCheck: this.createProjectManagerConditionCheck(directoryId, guardManager.entryKey),
        })
      }

      transactItems.push(
        {
          Put: memberPut,
        },
        {
          Update: this.createActiveWorkspaceMemberVersionUpdate(
            directoryId,
            normalizedMemberKey,
            expectedWorkspaceMemberVersion,
            updatedAt,
          ),
        },
        ...(auditPut ? [auditPut] : []),
      )
      const workspaceUpdateIndex = guardManager ? 2 : 1

      try {
        await this.documentClient.send(
          new TransactWriteCommand({ TransactItems: transactItems }),
        )
      } catch (error) {
        if (isTransactionConditionalFailureAt(error, workspaceUpdateIndex)) {
          await this.requireUnchangedActiveWorkspaceMember(
            directoryId,
            normalizedMemberKey,
            expectedWorkspaceMemberVersion,
          )
        }

        if (
          guardManager &&
          (
            isTransactionConditionalFailureAt(error, 0) ||
            isTransactionConditionalFailureAt(error, 1)
          )
        ) {
          await this.throwProjectManagerTransactionCancellationResult(
            directoryId,
            projectId,
            normalizedMemberKey,
            error,
          )
        }

        throw error
      }

      return {
        member: toProjectMemberResponseItem(item),
      } satisfies UpdateProjectMemberResponse
    } catch (error) {
      if (!managerGuarded && isTransactionConditionalFailureAt(error, 0)) {
        await this.throwUpdateProjectMemberTransactionCancellationResult(
          directoryId,
          projectId,
          normalizedMemberKey,
          existingMemberExpected,
          error,
        )
      }

      if (hasTransactionConditionalFailure(error)) {
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB から project member role を削除します。
   */
  async removeProjectMember(
    directoryId: string,
    projectId: string,
    memberKey: string,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalAuditTable()
    const normalizedMemberKey = normalizeProjectMemberKey(memberKey)
    let managerGuarded = false

    try {
      const items = await this.readValidDirectoryItems(directoryId, true)
      this.requireActiveProject(items, projectId)
      const member = items.find((item) =>
        item.entryType === 'project-member' &&
        item.projectId === projectId &&
        item.memberKey === normalizedMemberKey,
      )

      if (!member) {
        throw new ProjectDataError(
          404,
          'ProjectMemberNotFound',
          `Project member "${normalizedMemberKey}" was not found in project "${projectId}".`,
        )
      }

      const guardManager = member.role === 'manager'
        ? this.requireAnotherProjectManager(items, projectId, normalizedMemberKey)
        : undefined
      managerGuarded = guardManager !== undefined
      const removedAt = new Date().toISOString()
      const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'member.removed',
        entityType: 'member',
        entityId: `${projectId}/${normalizedMemberKey}`,
        action: 'deleted',
        occurredAt: removedAt,
        changes: createAuditFieldChanges(member, undefined, ['email', 'name', 'role']),
        metadata: { projectId, memberKey: normalizedMemberKey },
      })
      const memberDelete = {
        TableName: this.tableName,
        Key: {
          directoryId,
          entryKey: member.entryKey,
        },
        ConditionExpression:
          'attribute_exists(directoryId) AND attribute_exists(entryKey) AND #updatedAt = :expectedUpdatedAt AND #role = :expectedRole',
        ExpressionAttributeNames: {
          '#updatedAt': 'updatedAt',
          '#role': 'role',
        },
        ExpressionAttributeValues: {
          ':expectedUpdatedAt': member.updatedAt,
          ':expectedRole': member.role,
        },
      }

      if (guardManager) {
        await this.documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: this.createProjectManagerConditionCheck(directoryId, guardManager.entryKey),
              },
              {
                Delete: memberDelete,
              },
              ...(auditPut ? [auditPut] : []),
            ],
          }),
        )
      } else {
        if (auditPut) {
          await this.documentClient.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Delete: memberDelete,
                },
                auditPut,
              ],
            }),
          )
        } else {
          await this.documentClient.send(
            new DeleteCommand({
              ...memberDelete,
            }),
          )
        }
      }

      return {
        projectId,
        memberId: normalizedMemberKey,
      } satisfies RemoveProjectMemberResponse
    } catch (error) {
      if (
        (managerGuarded && (
          isTransactionConditionalFailureAt(error, 0) ||
          isTransactionConditionalFailureAt(error, 1)
        )) ||
        (!managerGuarded && isTransactionConditionalFailureAt(error, 0))
      ) {
        await this.throwProjectManagerTransactionCancellationResult(
          directoryId,
          projectId,
          normalizedMemberKey,
          error,
        )
      }

      if (hasTransactionConditionalFailure(error)) {
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB にチームを作成します。
   */
  async createTeam(
    directoryId: string,
    input: CreateTeamRequestBody,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalAuditTable()
    const names = readLocalizedNames(input)

    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const teamId = createUniqueResourceId(
        names.nameJa,
        items
          .filter((item) => item.entryType === 'team')
          .map((item) => item.teamId),
      )
      const teamSortOrder =
        Math.max(0, ...items.filter((item) => item.entryType === 'team').map((item) => item.teamSortOrder)) +
        10
      const item: ProjectDirectoryItem = {
        directoryId,
        entryKey: createTeamEntryKey(teamSortOrder, teamId),
        entryType: 'team',
        teamId,
        teamSortOrder,
        nameJa: names.nameJa,
        nameEn: names.nameEn,
        expanded: typeof input.expanded === 'boolean' ? input.expanded : true,
      }

      const statePut = {
        Put: {
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        },
      }
      const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'project.created',
        entityType: 'project',
        entityId: `team/${teamId}`,
        action: 'created',
        changes: createAuditFieldChanges(undefined, {
          kind: 'team',
          teamId,
          name: names.nameJa,
          expanded: item.expanded ?? false,
        }),
        metadata: { kind: 'team', teamId },
      })

      if (auditPut) {
        await this.documentClient.send(
          new TransactWriteCommand({ TransactItems: [statePut, auditPut] }),
        )
      } else {
        await this.documentClient.send(new PutCommand(statePut.Put))
      }

      return {
        team: {
          id: item.teamId,
          name: item.nameJa,
          expanded: item.expanded ?? false,
          projects: [],
        },
      } satisfies CreateTeamResponse
    } catch (error) {
      if (
        isAwsNamedError(error, 'TransactionCanceledException') &&
        hasTransactionConditionalFailure(error)
      ) {
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB にチーム配下のプロジェクトを作成します。
   */
  async createProject(
    directoryId: string,
    teamId: string,
    input: CreateProjectRequestBody,
    creator: ProjectCreatorContext,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalAuditTable()
    const names = readLocalizedNames(input)
    const tone = readProjectTone(input.tone)
    const creatorMemberKey = normalizeProjectMemberKey(creator.userKey)

    if (!creatorMemberKey) {
      throw new ProjectDataError(
        400,
        'ProjectCreatorInvalid',
        'Project creator member key is required.',
      )
    }

    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const team = items.find((item) =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      const projectId = createUniqueResourceId(
        names.nameJa,
        items
          .filter((item) => item.entryType === 'project')
          .flatMap((item) => (item.projectId ? [item.projectId] : [])),
      )
      const projectSortOrder =
        Math.max(
          0,
          ...items
            .filter((item) => item.entryType === 'project' && item.teamId === teamId)
            .map((item) => item.projectSortOrder ?? 0),
        ) + 10
      const item: ProjectDirectoryItem = {
        directoryId,
        entryKey: createProjectEntryKey(team.teamSortOrder, projectSortOrder, projectId),
        entryType: 'project',
        teamId,
        teamSortOrder: team.teamSortOrder,
        nameJa: names.nameJa,
        nameEn: names.nameEn,
        projectId,
        projectSortOrder,
        tone,
      }
      const updatedAt = new Date().toISOString()
      const creatorMemberItem: ProjectMemberItem = {
        directoryId,
        entryKey: createProjectMemberEntryKey(projectId, creatorMemberKey),
        entryType: 'project-member',
        projectId,
        memberKey: creatorMemberKey,
        email: creatorMemberKey,
        role: 'manager',
        createdAt: updatedAt,
        updatedAt,
      }

      try {
        await this.documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: this.createActiveTeamConditionCheck(directoryId, team.entryKey),
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: item,
                  ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
                },
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: creatorMemberItem,
                  ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
                },
              },
              {
                Update: this.createActiveWorkspaceMemberVersionUpdate(
                  directoryId,
                  creatorMemberKey,
                  creator.workspaceMemberVersion,
                  updatedAt,
                ),
              },
              ...createOptionalAuditTransactItems(this.auditTableName, auditContext, {
                directoryId,
                eventType: 'project.created',
                entityType: 'project',
                entityId: projectId,
                action: 'created',
                occurredAt: updatedAt,
                changes: createAuditFieldChanges(undefined, {
                  projectId,
                  teamId,
                  name: names.nameJa,
                  tone,
                  creatorMemberKey,
                  creatorRole: 'manager',
                }),
                metadata: { kind: 'project', projectId, teamId },
              }),
            ],
          }),
        )
      } catch (error) {
        if (isTransactionConditionalFailureAt(error, 3)) {
          await this.requireUnchangedActiveWorkspaceMember(
            directoryId,
            creatorMemberKey,
            creator.workspaceMemberVersion,
          )
        }

        if (isTransactionConditionalFailureAt(error, 0)) {
          await this.throwCreateProjectTransactionCancellationResult(directoryId, teamId, error)
        }

        if (hasTransactionConditionalFailure(error)) {
          throw createProjectDataConflictError()
        }

        throw error
      }

      return {
        project: {
          id: item.projectId,
          name: item.nameJa,
          tone: item.tone,
        },
      } satisfies CreateProjectResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB 上のチームをアーカイブします。
   */
  async archiveTeam(
    directoryId: string,
    teamId: string,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalAuditTable()
    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const team = items.find((item) =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      const archivedAt = new Date().toISOString()

      const stateUpdate = {
        Update: {
          TableName: this.tableName,
          Key: { directoryId, entryKey: team.entryKey },
          UpdateExpression: 'SET archivedAt = :archivedAt',
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
          ExpressionAttributeValues: { ':archivedAt': archivedAt },
        },
      }
      const auditItems = createOptionalAuditTransactItems(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'project.archived',
        entityType: 'project',
        entityId: `team/${teamId}`,
        action: 'archived',
        occurredAt: archivedAt,
        changes: createAuditFieldChanges(team, { ...team, archivedAt }, ['archivedAt']),
        metadata: { kind: 'team', teamId },
      })

      if (auditItems.length) {
        await this.documentClient.send(
          new TransactWriteCommand({ TransactItems: [stateUpdate, ...auditItems] }),
        )
      } else {
        await this.documentClient.send(new UpdateCommand(stateUpdate.Update))
      }

      return {
        teamId,
        archivedAt,
      } satisfies ArchiveTeamResponse
    } catch (error) {
      if (isTransactionConditionalFailureAt(error, 0)) {
        await this.throwArchiveTeamTransactionCancellationResult(directoryId, teamId, error)
      }

      if (hasTransactionConditionalFailure(error)) {
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
   */
  async archiveProject(
    directoryId: string,
    teamId: string,
    projectId: string,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalAuditTable()
    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const team = items.find((item) =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      const project = items.find((item) =>
        item.entryType === 'project' &&
        item.teamId === teamId &&
        item.projectId === projectId &&
        isActiveDirectoryItem(item),
      )

      if (!project) {
        throw new ProjectDataError(
          404,
          'ProjectNotFound',
          `Project "${projectId}" was not found in team "${teamId}".`,
        )
      }

      const archivedAt = new Date().toISOString()

      const stateUpdate = {
        Update: {
          TableName: this.tableName,
          Key: { directoryId, entryKey: project.entryKey },
          UpdateExpression: 'SET archivedAt = :archivedAt',
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
          ExpressionAttributeValues: { ':archivedAt': archivedAt },
        },
      }
      const auditItems = createOptionalAuditTransactItems(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'project.archived',
        entityType: 'project',
        entityId: projectId,
        action: 'archived',
        occurredAt: archivedAt,
        changes: createAuditFieldChanges(project, { ...project, archivedAt }, ['archivedAt']),
        metadata: { kind: 'project', projectId, teamId },
      })

      if (auditItems.length) {
        await this.documentClient.send(
          new TransactWriteCommand({ TransactItems: [stateUpdate, ...auditItems] }),
        )
      } else {
        await this.documentClient.send(new UpdateCommand(stateUpdate.Update))
      }

      return {
        teamId,
        projectId,
        archivedAt,
      } satisfies ArchiveProjectResponse
    } catch (error) {
      if (isTransactionConditionalFailureAt(error, 0)) {
        await this.throwArchiveProjectTransactionCancellationResult(
          directoryId,
          teamId,
          projectId,
          error,
        )
      }

      if (hasTransactionConditionalFailure(error)) {
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * local runtime で audit table が未作成なら mutation 前に初期化します。
   */
  private async ensureLocalAuditTable() {
    await ensureConfiguredAuditTable(
      this.auditTableName,
      this.dynamoDbClient,
      this.bootstrapLocalTables,
    )
  }

  /**
   * directory partition 内の全 item を検証済み item として取得します。
   */
  private async readValidDirectoryItems(directoryId: string, consistentRead = false) {
    try {
      const items = await this.queryDirectoryItems(directoryId, true, consistentRead)

      return readProjectDirectoryItems(items, directoryId)
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * 指定 project ID が active な project として存在することを検証します。
   */
  private requireActiveProject(items: ProjectDirectoryItem[], projectId: string) {
    const activeTeamIds = new Set(
      items
        .filter((item) => item.entryType === 'team' && isActiveDirectoryItem(item))
        .map((item) => item.teamId),
    )
    const project = items.find((item) =>
      item.entryType === 'project' &&
      item.projectId === projectId &&
      activeTeamIds.has(item.teamId) &&
      isActiveDirectoryItem(item),
    )

    if (!project) {
      throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
    }
  }

  /**
   * 対象 member 以外に残る manager item を取得します。
   */
  private requireAnotherProjectManager(
    items: ProjectDirectoryItem[],
    projectId: string,
    memberKey: string,
  ) {
    const manager = this.findAnotherProjectManager(items, projectId, memberKey)

    if (!manager) {
      throw this.createProjectLastManagerError()
    }

    return manager
  }

  /**
   * 対象 member 以外に残る manager item を検索します。
   */
  private findAnotherProjectManager(
    items: ProjectDirectoryItem[],
    projectId: string,
    memberKey: string,
  ) {
    return items.find((item) =>
      item.entryType === 'project-member' &&
      item.projectId === projectId &&
      item.memberKey !== memberKey &&
      item.role === 'manager',
    )
  }

  /**
   * project 作成 transaction 失敗後の最新状態から team archive と重複を切り分けます。
   */
  private async throwCreateProjectTransactionCancellationResult(
    directoryId: string,
    teamId: string,
    originalError: unknown,
  ): Promise<never> {
    const items = await this.readValidDirectoryItems(directoryId, true)
    const activeTeam = items.find((item) =>
      item.entryType === 'team' &&
      item.teamId === teamId &&
      isActiveDirectoryItem(item),
    )

    if (!activeTeam) {
      throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
    }

    if (hasTransactionConditionalFailure(originalError)) {
      throw createProjectDataConflictError()
    }

    throw toProjectDataError(originalError)
  }

  /**
   * team archive transaction 失敗後の最新状態から not-found と競合を切り分けます。
   */
  private async throwArchiveTeamTransactionCancellationResult(
    directoryId: string,
    teamId: string,
    originalError: unknown,
  ): Promise<never> {
    const items = await this.readValidDirectoryItems(directoryId, true)
    const activeTeam = items.find((item) =>
      item.entryType === 'team' &&
      item.teamId === teamId &&
      isActiveDirectoryItem(item),
    )

    if (!activeTeam) {
      throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
    }

    if (hasTransactionConditionalFailure(originalError)) {
      throw createProjectDataConflictError()
    }

    throw toProjectDataError(originalError)
  }

  /**
   * project archive transaction 失敗後の最新状態から not-found と競合を切り分けます。
   */
  private async throwArchiveProjectTransactionCancellationResult(
    directoryId: string,
    teamId: string,
    projectId: string,
    originalError: unknown,
  ): Promise<never> {
    const items = await this.readValidDirectoryItems(directoryId, true)
    const activeTeam = items.find((item) =>
      item.entryType === 'team' &&
      item.teamId === teamId &&
      isActiveDirectoryItem(item),
    )

    if (!activeTeam) {
      throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
    }

    const activeProject = items.find((item) =>
      item.entryType === 'project' &&
      item.teamId === teamId &&
      item.projectId === projectId &&
      isActiveDirectoryItem(item),
    )

    if (!activeProject) {
      throw new ProjectDataError(
        404,
        'ProjectNotFound',
        `Project "${projectId}" was not found in team "${teamId}".`,
      )
    }

    if (hasTransactionConditionalFailure(originalError)) {
      throw createProjectDataConflictError()
    }

    throw toProjectDataError(originalError)
  }

  /**
   * project member upsert transaction 失敗後の最新状態から not-found と競合を切り分けます。
   */
  private async throwUpdateProjectMemberTransactionCancellationResult(
    directoryId: string,
    projectId: string,
    memberKey: string,
    existingMemberExpected: boolean,
    originalError: unknown,
  ): Promise<never> {
    const items = await this.readValidDirectoryItems(directoryId, true)
    this.requireActiveProject(items, projectId)
    const member = items.find((item) =>
      item.entryType === 'project-member' &&
      item.projectId === projectId &&
      item.memberKey === memberKey,
    )

    if (existingMemberExpected && !member) {
      throw new ProjectDataError(
        404,
        'ProjectMemberNotFound',
        `Project member "${memberKey}" was not found in project "${projectId}".`,
      )
    }

    if (hasTransactionConditionalFailure(originalError)) {
      throw createProjectDataConflictError()
    }

    throw toProjectDataError(originalError)
  }

  /**
   * project member transaction 失敗後の最新状態から 404 と last-manager conflict を切り分けます。
   */
  private async throwProjectManagerTransactionCancellationResult(
    directoryId: string,
    projectId: string,
    memberKey: string,
    originalError: unknown,
  ): Promise<never> {
    const items = await this.readValidDirectoryItems(directoryId, true)
    this.requireActiveProject(items, projectId)
    const member = items.find((item) =>
      item.entryType === 'project-member' &&
      item.projectId === projectId &&
      item.memberKey === memberKey,
    )

    if (!member) {
      throw new ProjectDataError(
        404,
        'ProjectMemberNotFound',
        `Project member "${memberKey}" was not found in project "${projectId}".`,
      )
    }

    if (member.role === 'manager' && !this.findAnotherProjectManager(items, projectId, memberKey)) {
      throw this.createProjectLastManagerError()
    }

    if (hasTransactionConditionalFailure(originalError)) {
      throw createProjectDataConflictError()
    }

    throw toProjectDataError(originalError)
  }

  /**
   * project 作成時点でも team が active であることを検証する condition check を作ります。
   */
  private createActiveTeamConditionCheck(directoryId: string, entryKey: string) {
    return {
      TableName: this.tableName,
      Key: {
        directoryId,
        entryKey,
      },
      ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
    }
  }

  /**
   * 他 manager が transaction 時点でも manager のままか検証する condition check を作ります。
   */
  private createProjectManagerConditionCheck(directoryId: string, entryKey: string) {
    return {
      TableName: this.tableName,
      Key: {
        directoryId,
        entryKey,
      },
      ConditionExpression: '#role = :manager',
      ExpressionAttributeNames: {
        '#role': 'role',
      },
      ExpressionAttributeValues: {
        ':manager': 'manager',
      },
    }
  }

  /**
   * project member 書き込みと同時に active Workspace member の version を進めます。
   */
  private createActiveWorkspaceMemberVersionUpdate(
    workspaceId: string,
    memberKey: string,
    expectedVersion: number,
    updatedAt: string,
  ) {
    return {
      TableName: this.workspaceAccessTableName,
      Key: {
        workspaceId,
        recordKey: `MEMBER#${normalizeProjectMemberKey(memberKey)}`,
      },
      UpdateExpression: 'SET updatedAt = :updatedAt ADD #version :one',
      ConditionExpression:
        '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#status': 'status',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':memberEntryType': 'workspace-member',
        ':active': 'active',
        ':expectedVersion': expectedVersion,
        ':updatedAt': updatedAt,
        ':one': 1,
      },
    }
  }

  /** transaction cancel 後に対象 Workspace member の active/version を再確認します。 */
  private async requireUnchangedActiveWorkspaceMember(
    workspaceId: string,
    memberKey: string,
    expectedVersion: number,
  ) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.workspaceAccessTableName,
      Key: {
        workspaceId,
        recordKey: `MEMBER#${normalizeProjectMemberKey(memberKey)}`,
      },
      ConsistentRead: true,
    }))
    const item = response.Item

    if (item?.entryType !== 'workspace-member' || item.status !== 'active') {
      throw new ProjectDataError(
        409,
        'WorkspaceMemberInactive',
        'Only active Workspace members can be assigned to a project.',
      )
    }

    if (item.version !== expectedVersion) {
      throw new ProjectDataError(
        409,
        'WorkspaceMemberVersionConflict',
        'Workspace member changed. Reload and try again.',
      )
    }
  }

  /**
   * project に manager が残らなくなる操作を表す domain error を作ります。
   */
  private createProjectLastManagerError() {
    return new ProjectDataError(
      409,
      'ProjectLastManager',
      'At least one project manager is required.',
    )
  }

  /**
   * directory partition 内の全 item を LastEvaluatedKey がなくなるまで取得します。
   */
  private async queryDirectoryItems(
    directoryId: string,
    canBootstrapLocalTable = true,
    consistentRead = false,
  ) {
    try {
      const items: unknown[] = []
      let exclusiveStartKey: Record<string, unknown> | undefined

      do {
        const response = await this.documentClient.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'directoryId = :directoryId',
            ExpressionAttributeValues: {
              ':directoryId': directoryId,
            },
            ExclusiveStartKey: exclusiveStartKey,
            ScanIndexForward: true,
            ...(consistentRead ? { ConsistentRead: true } : {}),
          }),
        )

        items.push(...(response.Items ?? []))
        exclusiveStartKey = response.LastEvaluatedKey
      } while (exclusiveStartKey)

      return items
    } catch (error) {
      if (
        canBootstrapLocalTable &&
        this.bootstrapLocalTables &&
        isResourceNotFoundError(error) &&
        await ensureLocalProjectDirectoryTable(this.tableName, this.dynamoDbClient)
      ) {
        return this.queryDirectoryItems(directoryId, false, consistentRead)
      }

      throw error
    }
  }
}

/**
 * Floci Cognito との通信で扱う domain error です。
 */
export class CognitoServiceError extends Error {
  /**
   * Cognito または proxy 相当の HTTP status code です。
   */
  readonly status: number
  /**
   * Cognito error code またはローカルで付与した error code です。
   */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function toCognitoSdkError(error: unknown) {
  if (error instanceof CognitoServiceError) {
    return error
  }

  const metadata = isRecord(error) && isRecord(error.$metadata)
    ? error.$metadata
    : undefined
  const status = typeof metadata?.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : 502
  const code = isRecord(error) && typeof error.name === 'string'
    ? error.name
    : 'CognitoUnavailable'
  const message = isRecord(error) && typeof error.message === 'string'
    ? error.message
    : 'Cognito request failed.'

  return new CognitoServiceError(status, code, message)
}

/**
 * DynamoDB の project data 取得で扱う domain error です。
 */
class ProjectDataError extends Error {
  /**
   * DynamoDB または proxy 相当の HTTP status code です。
   */
  readonly status: number
  /**
   * DynamoDB error code またはローカルで付与した error code です。
   */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new CognitoServiceError(
      response.status,
      'InvalidCognitoResponse',
      'Cognito returned invalid JSON.',
    )
  }
}

function clampCognitoPageLimit(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return 20
  }

  return Math.min(60, Math.max(1, Math.floor(value)))
}

function escapeCognitoFilterValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function normalizeCognitoUserId(value: string) {
  const normalized = value.trim().toLowerCase()

  if (!normalized) {
    throw new CognitoServiceError(400, 'InvalidParameterException', 'Cognito user ID is required.')
  }

  return normalized
}

function toCognitoUserProfile(value: CognitoUserRecord): CognitoUserProfile | undefined {
  const username = value.Username?.trim()
  const email = readCognitoUserAttribute(value, 'email')?.trim().toLowerCase()

  if (!username || !email) {
    return undefined
  }

  return {
    id: normalizeCognitoUserId(email),
    username,
    email,
    name: readCognitoUserAttribute(value, 'name')?.trim() || undefined,
    enabled: value.Enabled,
    status: value.UserStatus,
  }
}

function readCognitoUserAttribute(user: CognitoUserRecord, name: string) {
  return (user.Attributes ?? user.UserAttributes)?.find((attribute) => attribute.Name === name)?.Value
}

function readCognitoUserDirectoryId(user: CognitoUserRecord) {
  const directoryId = readCognitoUserAttribute(user, 'custom:directory_id')?.trim() || undefined
  const workspaceId = readCognitoUserAttribute(user, 'custom:workspace_id')?.trim() || undefined

  if (directoryId && workspaceId && directoryId !== workspaceId) {
    throw new CognitoServiceError(
      409,
      'WorkspaceDirectoryConflict',
      'Cognito user has conflicting Workspace directory attributes.',
    )
  }

  return directoryId ?? workspaceId
}

function createWorkspaceCognitoUserAttributes(email: string, directoryId: string, name?: string) {
  return [
    { Name: 'email', Value: normalizeCognitoUserId(email) },
    { Name: 'custom:directory_id', Value: directoryId },
    { Name: 'custom:workspace_id', Value: directoryId },
    ...(name?.trim() ? [{ Name: 'name', Value: name.trim() }] : []),
  ]
}

function isCognitoUserInDirectory(user: CognitoUserRecord, directoryId: string | undefined) {
  if (!directoryId) {
    return true
  }

  const claimedDirectoryId = readCognitoUserAttribute(user, 'custom:directory_id')?.trim() || undefined
  const claimedWorkspaceId = readCognitoUserAttribute(user, 'custom:workspace_id')?.trim() || undefined

  if (
    claimedDirectoryId &&
    claimedWorkspaceId &&
    claimedDirectoryId !== claimedWorkspaceId
  ) {
    return false
  }

  return (claimedDirectoryId ?? claimedWorkspaceId) === directoryId
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function createDynamoDbClient() {
  const endpoint = getDynamoDbEndpoint()

  return new DynamoDBClient({
    region: getAwsRegion(),
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: getEnv('AWS_ACCESS_KEY_ID') ?? 'test',
            secretAccessKey: getEnv('AWS_SECRET_ACCESS_KEY') ?? 'test',
          },
        }
      : {}),
  })
}

function createDynamoDbDocumentClient(dynamoDbClient = createDynamoDbClient()) {
  return DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  })
}

function createAuditEventsClient() {
  const dynamoDbClient = createDynamoDbClient()

  return new DynamoDbAuditEventsClient(
    createDynamoDbDocumentClient(dynamoDbClient),
    getConfiguredAuditTableName() ?? 'mukuroji-audit-events',
    {},
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
  )
}

const localDynamoDbTableInitializers = new Map<string, Promise<void>>()

async function ensureLocalTeamIssuesTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
) {
  return ensureLocalDynamoDbTable(
    tableName,
    dynamoDbClient,
    () =>
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'directoryTeamId', AttributeType: 'S' },
          { AttributeName: 'issueId', AttributeType: 'S' },
          { AttributeName: 'sortOrder', AttributeType: 'N' },
          { AttributeName: 'directoryProjectId', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
          { AttributeName: 'issueId', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'TeamIssueSortOrderIndex',
            KeySchema: [
              { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
              { AttributeName: 'sortOrder', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'AssignedProjectIssueIndex',
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'sortOrder', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    isTeamIssuesTableDescription,
  )
}

async function ensureLocalTeamIssueEventsTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
) {
  return ensureLocalDynamoDbTable(
    tableName,
    dynamoDbClient,
    () =>
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'directoryTeamIssueId', AttributeType: 'S' },
          { AttributeName: 'eventId', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'directoryTeamIssueId', KeyType: 'HASH' },
          { AttributeName: 'eventId', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    isTeamIssueEventsTableDescription,
  )
}

async function ensureLocalProjectTasksTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
) {
  return ensureLocalDynamoDbTable(
    tableName,
    dynamoDbClient,
    () =>
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'directoryProjectId', AttributeType: 'S' },
          { AttributeName: 'taskId', AttributeType: 'S' },
          { AttributeName: 'sortOrder', AttributeType: 'N' },
        ],
        KeySchema: [
          { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
          { AttributeName: 'taskId', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'ProjectSortOrderIndex',
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'sortOrder', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    isProjectTasksTableDescription,
  )
}

async function ensureLocalProjectDirectoryTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
) {
  return ensureLocalDynamoDbTable(
    tableName,
    dynamoDbClient,
    () =>
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'directoryId', AttributeType: 'S' },
          { AttributeName: 'entryKey', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'directoryId', KeyType: 'HASH' },
          { AttributeName: 'entryKey', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    isProjectDirectoryTableDescription,
  )
}

async function ensureLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  createCommand: () => CreateTableCommand,
  validateTable: (table: TableDescription | undefined) => boolean,
) {
  if (!shouldBootstrapLocalDynamoDb()) {
    return false
  }

  const initializerKey = `${getDynamoDbEndpoint()}#${tableName}`
  const existingInitializer = localDynamoDbTableInitializers.get(initializerKey)

  if (existingInitializer) {
    await existingInitializer
    return true
  }

  const initializer = createLocalDynamoDbTable(tableName, dynamoDbClient, createCommand, validateTable)
    .finally(() => {
      localDynamoDbTableInitializers.delete(initializerKey)
    })

  localDynamoDbTableInitializers.set(initializerKey, initializer)
  await initializer

  return true
}

async function createLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  createCommand: () => CreateTableCommand,
  validateTable: (table: TableDescription | undefined) => boolean,
) {
  try {
    await dynamoDbClient.send(createCommand())
  } catch (error) {
    if (!isResourceInUseError(error)) {
      throw error
    }
  }

  await waitForLocalDynamoDbTable(tableName, dynamoDbClient, validateTable)
}

async function waitForLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  validateTable: (table: TableDescription | undefined) => boolean,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await dynamoDbClient.send(
      new DescribeTableCommand({
        TableName: tableName,
      }),
    )

    if (response.Table?.TableStatus === 'ACTIVE' && validateTable(response.Table)) {
      return
    }

    if (response.Table?.TableStatus === 'ACTIVE') {
      throw new Error(`Local DynamoDB table "${tableName}" does not match the expected schema.`)
    }

    await sleep(100)
  }

  throw new Error(`Local DynamoDB table "${tableName}" did not become active.`)
}

function isProjectTasksTableDescription(table: TableDescription | undefined) {
  return (
    hasKeySchema(table, [
      ['directoryProjectId', 'HASH'],
      ['taskId', 'RANGE'],
    ]) &&
    Boolean(
      table?.GlobalSecondaryIndexes?.some((index) =>
        index.IndexName === 'ProjectSortOrderIndex' &&
        hasKeySchema(index, [
          ['directoryProjectId', 'HASH'],
          ['sortOrder', 'RANGE'],
        ]),
      ),
    )
  )
}

function isTeamIssuesTableDescription(table: TableDescription | undefined) {
  return (
    hasKeySchema(table, [
      ['directoryTeamId', 'HASH'],
      ['issueId', 'RANGE'],
    ]) &&
    Boolean(
      table?.GlobalSecondaryIndexes?.some((index) =>
        index.IndexName === 'TeamIssueSortOrderIndex' &&
        hasKeySchema(index, [
          ['directoryTeamId', 'HASH'],
          ['sortOrder', 'RANGE'],
        ]),
      ),
    ) &&
    Boolean(
      table?.GlobalSecondaryIndexes?.some((index) =>
        index.IndexName === 'AssignedProjectIssueIndex' &&
        hasKeySchema(index, [
          ['directoryProjectId', 'HASH'],
          ['sortOrder', 'RANGE'],
        ]),
      ),
    )
  )
}

function isTeamIssueEventsTableDescription(table: TableDescription | undefined) {
  return hasKeySchema(table, [
    ['directoryTeamIssueId', 'HASH'],
    ['eventId', 'RANGE'],
  ])
}

function isProjectDirectoryTableDescription(table: TableDescription | undefined) {
  return hasKeySchema(table, [
    ['directoryId', 'HASH'],
    ['entryKey', 'RANGE'],
  ])
}

function hasKeySchema(
  value: { KeySchema?: TableDescription['KeySchema'] } | undefined,
  expected: Array<[string, 'HASH' | 'RANGE']>,
) {
  return expected.every(([attributeName, keyType]) =>
    value?.KeySchema?.some((schema) =>
      schema.AttributeName === attributeName && schema.KeyType === keyType,
    ),
  )
}

function shouldBootstrapLocalDynamoDb() {
  const endpoint = getDynamoDbEndpoint()

  return Boolean(
    endpoint &&
    /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|floci)(?::|\/|$)/.test(endpoint),
  )
}

function isResourceNotFoundError(error: unknown) {
  return isAwsNamedError(error, 'ResourceNotFoundException')
}

function isResourceInUseError(error: unknown) {
  return isAwsNamedError(error, 'ResourceInUseException')
}

function isAwsNamedError(error: unknown, name: string) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name
}

function hasTransactionConditionalFailure(error: unknown) {
  if (!isAwsNamedError(error, 'TransactionCanceledException') || !isRecord(error)) {
    return false
  }

  const reasons = error.CancellationReasons

  if (!Array.isArray(reasons)) {
    return false
  }

  const reasonCodes = reasons.map((reason) => isRecord(reason) ? reason.Code : undefined)

  if (!reasonCodes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')) {
    return false
  }

  return reasonCodes.includes('ConditionalCheckFailed')
}

function isTransactionConditionalFailureAt(error: unknown, index: number) {
  if (!hasTransactionConditionalFailure(error) || !isRecord(error)) {
    return false
  }

  const reasons = error.CancellationReasons

  return Array.isArray(reasons) &&
    isRecord(reasons[index]) &&
    reasons[index].Code === 'ConditionalCheckFailed'
}

function createProjectDataConflictError() {
  return new ProjectDataError(
    409,
    'ConditionalCheckFailedException',
    'The transaction condition failed.',
  )
}

function createWorkItemRevisionConflictError() {
  return new ProjectDataError(
    409,
    'WorkItemRevisionConflict',
    'Work Item revision does not match the expected revision.',
  )
}

function createLegacyProjectTaskReadOnlyError() {
  return new ProjectDataError(
    409,
    'LegacyProjectTaskReadOnly',
    'Legacy project tasks are read-only.',
  )
}

function createDynamoDbBatchGetRetryDelayMs(
  attempt: number,
  random: () => number,
) {
  const exponentialDelay = DYNAMODB_BATCH_GET_RETRY_BASE_DELAY_MS * 2 ** attempt

  return exponentialDelay + Math.floor(exponentialDelay * random())
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function toProjectDataError(error: unknown) {
  const awsError = error as {
    $metadata?: {
      httpStatusCode?: number
    }
    message?: string
    name?: string
  }

  return new ProjectDataError(
    awsError.$metadata?.httpStatusCode ?? 502,
    awsError.name ?? 'DynamoDbUnavailable',
    awsError.message ?? 'DynamoDB request failed.',
  )
}

function isTeamIssueNotFoundError(error: unknown) {
  if (error instanceof ProjectDataError) {
    return error.status === 404 && error.code === 'TeamIssueNotFound'
  }

  return isRecord(error) && error.status === 404 && error.code === 'TeamIssueNotFound'
}

function toTeamIssueResponseItem(value: unknown): TeamIssueResponseItem {
  const item = toTeamIssueItem(value)
  const issue: TeamIssueResponseItem = {
    schemaVersion: item.schemaVersion,
    revision: item.revision,
    id: item.issueId,
    teamId: item.teamId,
    assigneeUserId: item.assigneeUserId,
    status: item.status,
    dueDate: item.dueDate,
    priority: item.priority,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    source: 'dynamodb',
  }

  if (item.title) {
    issue.title = item.title
  }

  if (item.titleKey) {
    issue.titleKey = item.titleKey
  }

  if (item.assignedProjectId) {
    issue.assignedProjectId = item.assignedProjectId
  }

  if (item.description) {
    issue.description = item.description
  }

  if (item.creatorMemberKey) {
    issue.creatorMemberKey = item.creatorMemberKey
  }

  return issue
}

function toTeamIssueCommentResponseItem(value: TeamIssueEventItem): TeamIssueCommentResponseItem {
  return {
    id: value.eventId,
    actorUserId: value.actorUserId,
    body: value.body ?? '',
    createdAt: value.createdAt,
  }
}

function toTeamIssueActivityResponseItem(value: TeamIssueEventItem): TeamIssueActivityResponseItem {
  return {
    id: value.eventId,
    type: value.eventType,
    actorUserId: value.actorUserId,
    summary: value.summary,
    createdAt: value.createdAt,
  }
}

function toTeamIssueItem(value: unknown): TeamIssueItem {
  const candidate = isRecord(value)
    ? {
        ...value,
        schemaVersion: value.schemaVersion ?? WORK_ITEM_SCHEMA_VERSION,
        revision: value.revision ?? 1,
      }
    : value

  if (!isTeamIssueItem(candidate)) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team issue item is missing or invalid.',
    )
  }

  return candidate
}

function toTeamIssueEventItem(value: unknown): TeamIssueEventItem {
  if (!isTeamIssueEventItem(value)) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team issue event item is missing or invalid.',
    )
  }

  return value
}

function toProjectTaskResponseItem(value: unknown): ProjectTaskResponseItem {
  if (!isProjectTaskItem(value)) {
    throw new ProjectDataError(
      503,
      'InvalidProjectTask',
      'Project task item is missing or invalid.',
    )
  }

  const task: ProjectTaskResponseItem = {
    id: value.taskId,
    status: value.status,
    dueDate: value.dueDate,
    priority: value.priority,
  }

  if (value.titleKey) {
    task.titleKey = value.titleKey
  }

  if (value.title) {
    task.title = value.title
  }

  if (value.assigneeKey) {
    task.assigneeKey = value.assigneeKey
  }

  if (value.assigneeUserId) {
    task.assigneeUserId = value.assigneeUserId
  }

  if (value.assignee) {
    task.assignee = value.assignee
  }

  return task
}

function readProjectDirectoryItems(values: unknown[], directoryId: string) {
  const directoryItems: ProjectDirectoryItem[] = []

  for (const value of values) {
    if (isProjectDirectoryItem(value, directoryId)) {
      directoryItems.push(value)
      continue
    }

    if (isWorkspaceBootstrapItem(value, directoryId)) {
      continue
    }

    throw new ProjectDataError(
      503,
      'InvalidProjectDirectory',
      'Project directory item is missing or invalid.',
    )
  }

  return directoryItems
}

function toProjectDirectoryResponse(
  values: unknown[],
  locale: Locale,
  directoryId: string,
): ProjectDirectoryTeamResponse[] {
  const teams: ProjectDirectoryTeamResponse[] = []
  const teamById = new Map<string, ProjectDirectoryTeamResponse>()
  const projectItems: ProjectDirectoryItem[] = []

  for (const value of readProjectDirectoryItems(values, directoryId)) {
    if (value.entryType === 'project-member') {
      continue
    }

    if (!isActiveDirectoryItem(value)) {
      continue
    }

    if (value.entryType === 'team') {
      const team = {
        id: value.teamId,
        name: localizedName(value, locale),
        expanded: value.expanded ?? false,
        projects: [],
      }

      teamById.set(team.id, team)
      teams.push(team)
      continue
    }

    projectItems.push(value)
  }

  for (const item of projectItems) {
    const team = teamById.get(item.teamId)

    if (!team || !item.projectId) {
      continue
    }

    team.projects.push({
      id: item.projectId,
      name: localizedName(item, locale),
      tone: item.tone,
    })
  }

  return teams
}

function toProjectMemberResponseItem(item: ProjectMemberItem): ProjectMemberResponseItem {
  const member: ProjectMemberResponseItem = {
    id: item.memberKey,
    email: item.email ?? item.memberKey,
    role: item.role,
    updatedAt: item.updatedAt,
  }

  if (item.name) {
    member.name = item.name
  }

  return member
}

function toProjectAccessEntries(items: ProjectDirectoryItem[], memberKey: string) {
  const activeTeamIds = new Set(
    items
      .filter((item) => item.entryType === 'team' && isActiveDirectoryItem(item))
      .map((item) => item.teamId),
  )
  const roleByProjectId = new Map(
    items
      .filter((item) => {
        return item.entryType === 'project-member' && item.memberKey === memberKey
      })
      .map((item) => [item.projectId, item.role] as const),
  )
  const seenProjectIds = new Set<string>()
  const accessEntries: ProjectAccessEntry[] = []

  for (const item of items) {
    if (
      item.entryType !== 'project' ||
      seenProjectIds.has(item.projectId) ||
      !isActiveDirectoryItem(item) ||
      !activeTeamIds.has(item.teamId)
    ) {
      continue
    }

    seenProjectIds.add(item.projectId)
    accessEntries.push({
      projectId: item.projectId,
      role: roleByProjectId.get(item.projectId),
    })
  }

  return accessEntries
}

function compareProjectMemberItems(first: ProjectMemberItem, second: ProjectMemberItem) {
  const roleDelta = projectRoleWeights[second.role] - projectRoleWeights[first.role]

  if (roleDelta !== 0) {
    return roleDelta
  }

  return (first.name ?? first.email ?? first.memberKey).localeCompare(
    second.name ?? second.email ?? second.memberKey,
    'ja',
  )
}

function localizedName(item: ProjectDirectoryTeamItem | ProjectDirectoryProjectItem, locale: Locale) {
  return locale === 'en' ? item.nameEn || item.nameJa : item.nameJa || item.nameEn
}

function isActiveDirectoryItem(item: ProjectDirectoryTeamItem | ProjectDirectoryProjectItem) {
  return item.archivedAt === undefined
}

function isTeamIssueItem(value: unknown): value is TeamIssueItem {
  if (!isRecord(value)) {
    return false
  }

  return (
    value.schemaVersion === WORK_ITEM_SCHEMA_VERSION &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    typeof value.directoryId === 'string' &&
    typeof value.teamId === 'string' &&
    value.directoryTeamId === createDirectoryTeamId(value.directoryId, value.teamId) &&
    typeof value.issueId === 'string' &&
    typeof value.sortOrder === 'number' &&
    (typeof value.title === 'string' || typeof value.titleKey === 'string') &&
    (value.description === undefined || typeof value.description === 'string') &&
    typeof value.assigneeUserId === 'string' &&
    (value.creatorMemberKey === undefined || typeof value.creatorMemberKey === 'string') &&
    (
      value.migrationSourceKey === undefined ||
      isLegacyTaskMigrationSourceKey(
        value.migrationSourceKey,
        value.directoryId,
        value.issueId,
      )
    ) &&
    isProjectTaskStatus(value.status) &&
    typeof value.dueDate === 'string' &&
    isProjectTaskPriority(value.priority) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (
      value.assignedProjectId === undefined ||
      (
        typeof value.assignedProjectId === 'string' &&
        value.directoryProjectId === createDirectoryProjectId(value.directoryId, value.assignedProjectId)
      )
    )
  )
}

function isTeamIssueEventItem(value: unknown): value is TeamIssueEventItem {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.directoryId === 'string' &&
    typeof value.teamId === 'string' &&
    typeof value.issueId === 'string' &&
    value.directoryTeamIssueId === createDirectoryTeamIssueId(
      value.directoryId,
      value.teamId,
      value.issueId,
    ) &&
    typeof value.eventId === 'string' &&
    isTeamIssueActivityType(value.eventType) &&
    typeof value.actorUserId === 'string' &&
    (value.body === undefined || typeof value.body === 'string') &&
    typeof value.summary === 'string' &&
    typeof value.createdAt === 'string'
  )
}

function isProjectTaskItem(value: unknown): value is ProjectTaskItem {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.projectId === 'string' &&
    typeof value.directoryId === 'string' &&
    value.directoryProjectId === createDirectoryProjectId(value.directoryId, value.projectId) &&
    typeof value.taskId === 'string' &&
    typeof value.sortOrder === 'number' &&
    (typeof value.titleKey === 'string' || typeof value.title === 'string') &&
    (
      typeof value.assigneeUserId === 'string' ||
      typeof value.assigneeKey === 'string' ||
      typeof value.assignee === 'string'
    ) &&
    isProjectTaskStatus(value.status) &&
    typeof value.dueDate === 'string' &&
    isProjectTaskPriority(value.priority)
  )
}

function isWorkspaceBootstrapItem(value: unknown, directoryId: string) {
  if (
    !isRecord(value) ||
    value.directoryId !== directoryId ||
    value.workspaceId !== directoryId ||
    typeof value.entryKey !== 'string'
  ) {
    return false
  }

  if (value.entryType === 'workspace-metadata') {
    return value.entryKey === 'WORKSPACE#METADATA'
  }

  if (value.entryType === 'workspace-member') {
    return (
      typeof value.memberKey === 'string' &&
      typeof value.email === 'string' &&
      value.email === value.memberKey &&
      typeof value.username === 'string' &&
      value.role === 'owner' &&
      value.entryKey === `WORKSPACE_MEMBER#${value.memberKey}`
    )
  }

  if (value.entryType === 'email-alias') {
    return (
      typeof value.memberKey === 'string' &&
      typeof value.email === 'string' &&
      value.email === value.memberKey &&
      typeof value.username === 'string' &&
      value.entryKey === `EMAIL_ALIAS#${value.email}`
    )
  }

  return false
}

function isProjectDirectoryItem(value: unknown, directoryId: string): value is ProjectDirectoryItem {
  if (!isRecord(value)) {
    return false
  }

  if (
    value.directoryId !== directoryId ||
    typeof value.entryKey !== 'string' ||
    (
      value.entryType !== 'team' &&
      value.entryType !== 'project' &&
      value.entryType !== 'project-member'
    )
  ) {
    return false
  }

  if (value.entryType === 'project-member') {
    return (
      typeof value.projectId === 'string' &&
      typeof value.memberKey === 'string' &&
      (value.email === undefined || typeof value.email === 'string') &&
      (value.name === undefined || typeof value.name === 'string') &&
      isProjectRole(value.role) &&
      typeof value.createdAt === 'string' &&
      typeof value.updatedAt === 'string'
    )
  }

  if (
    typeof value.teamId !== 'string' ||
    typeof value.teamSortOrder !== 'number' ||
    typeof value.nameJa !== 'string' ||
    typeof value.nameEn !== 'string' ||
    (value.archivedAt !== undefined && typeof value.archivedAt !== 'string')
  ) {
    return false
  }

  if (value.entryType === 'team') {
    return value.expanded === undefined || typeof value.expanded === 'boolean'
  }

  return (
    typeof value.projectId === 'string' &&
    typeof value.projectSortOrder === 'number' &&
    isProjectTone(value.tone)
  )
}

function isProjectTaskStatus(value: unknown): value is ProjectTaskStatus {
  return value === 'in-progress' || value === 'review' || value === 'todo' || value === 'done'
}

function isProjectTaskPriority(value: unknown): value is ProjectTaskPriority {
  return value === 'high' || value === 'medium' || value === 'low'
}

function isTeamIssueActivityType(value: unknown): value is TeamIssueActivityType {
  return value === 'created' || value === 'updated' || value === 'commented'
}

function isProjectRole(value: unknown): value is ProjectRole {
  return value === 'manager' || value === 'member' || value === 'viewer'
}

function isProjectTone(value: unknown): value is ProjectTone {
  return value === 'blue' || value === 'purple' || value === 'green' || value === 'yellow'
}

function readRequiredString(value: unknown, message: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', message)
  }

  return value.trim()
}

function readLocalizedNames(input: CreateTeamRequestBody | CreateProjectRequestBody) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const nameJa = typeof input.nameJa === 'string' ? input.nameJa.trim() : ''
  const nameEn = typeof input.nameEn === 'string' ? input.nameEn.trim() : ''
  const primaryName = nameJa || name || nameEn

  if (!primaryName) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Name is required.')
  }

  return {
    nameJa: primaryName,
    nameEn: nameEn || name || primaryName,
  }
}

function readTaskStatus(value: unknown): ProjectTaskStatus {
  if (value === undefined) {
    return 'todo'
  }

  if (!isProjectTaskStatus(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Task status is invalid.')
  }

  return value
}

function readRequiredTaskStatus(value: unknown): ProjectTaskStatus {
  if (!isProjectTaskStatus(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Task status is invalid.')
  }

  return value
}

function readWorkItemExpectedRevision(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemRevision',
      'Work Item expected revision is required.',
    )
  }

  return value
}

function readTaskPriority(value: unknown): ProjectTaskPriority {
  if (value === undefined) {
    return 'medium'
  }

  if (!isProjectTaskPriority(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Task priority is invalid.')
  }

  return value
}

function readProjectTone(value: unknown): ProjectTone {
  if (value === undefined) {
    return 'blue'
  }

  if (!isProjectTone(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project tone is invalid.')
  }

  return value
}

function readProjectRole(value: unknown): ProjectRole {
  if (!isProjectRole(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project role is invalid.')
  }

  return value
}

function normalizeTeamIssueInput<TInput extends CreateTeamIssueRequestBody | UpdateTeamIssueRequestBody>(
  input: TInput,
  team: ProjectDirectoryTeamResponse,
) {
  if (!('assignedProjectId' in input)) {
    return input
  }

  const assignedProjectId = readAssignedProjectId(input.assignedProjectId)

  if (
    assignedProjectId &&
    !team.projects.some((project) => project.id === assignedProjectId)
  ) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      `Assigned project "${assignedProjectId}" is not active in team "${team.id}".`,
    )
  }

  return {
    ...input,
    assignedProjectId,
  }
}

function readAssignedProjectId(value: unknown) {
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return null
  }

  if (typeof value !== 'string') {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Assigned project is invalid.')
  }

  const assignedProjectId = value.trim()

  return assignedProjectId || null
}

function readOptionalString(value: unknown, message: string) {
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return ''
  }

  if (typeof value !== 'string') {
    throw new ProjectDataError(400, 'InvalidProjectWrite', message)
  }

  return value.trim()
}

function readTeamIssueAssigneeUserId(input: CreateTeamIssueRequestBody | UpdateTeamIssueRequestBody) {
  const value = input.assigneeUserId

  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Issue assignee is required.')
  }

  return normalizeCognitoUserId(value)
}

function readRequiredCommentBody(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Issue comment body is required.')
  }

  return value.trim()
}

function readOptionalCommentId(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', `${label} is invalid.`)
  }

  return value.trim()
}

function readCommentMentionMemberKeys(value: unknown) {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value) || value.length > 20) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Issue comment mentions must contain at most 20 Workspace members.',
    )
  }

  const memberKeys = value.map((memberKey) => {
    if (typeof memberKey !== 'string') {
      throw new ProjectDataError(400, 'InvalidProjectWrite', 'Issue comment mention is invalid.')
    }

    return normalizeProjectMemberKey(memberKey)
  })

  return [...new Set(memberKeys)]
}

function readCommentExpectedVersion(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'A positive expectedVersion is required.',
    )
  }

  return value as number
}

function readPresenceClientId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value.trim())) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Presence client ID is invalid.')
  }

  return value.trim()
}

function readPresenceTyping(value: unknown) {
  if (typeof value !== 'boolean') {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Presence typing state is invalid.')
  }

  return value
}

function readTaskAssigneeUserId(input: CreateProjectTaskRequestBody) {
  const value = input.assigneeUserId ?? input.assignee

  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Task assignee is required.')
  }

  return normalizeCognitoUserId(value)
}

function readProjectMemberEmail(value: unknown, fallbackMemberKey: string) {
  if (value === undefined) {
    return fallbackMemberKey
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project member email is required.')
  }

  return normalizeProjectMemberKey(value)
}

function readOptionalProjectMemberName(value: unknown) {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project member name is invalid.')
  }

  const name = value.trim()

  return name || undefined
}

function normalizeProjectMemberKey(value: string) {
  const memberKey = value.trim().toLowerCase()

  if (!memberKey) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project member key is required.')
  }

  return memberKey
}

function createResourceId(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || `item-${Date.now()}`
}

function createUniqueResourceId(value: string, existingIds: Iterable<string>) {
  const baseId = createResourceId(value)
  const usedIds = new Set(existingIds)

  if (!usedIds.has(baseId)) {
    return baseId
  }

  let suffix = 2

  while (usedIds.has(`${baseId}-${suffix}`)) {
    suffix += 1
  }

  return `${baseId}-${suffix}`
}

function createTeamEntryKey(teamSortOrder: number, teamId: string) {
  return `${padSortOrder(teamSortOrder)}#000000#TEAM#${teamId}`
}

function createProjectEntryKey(
  teamSortOrder: number,
  projectSortOrder: number,
  projectId: string,
) {
  return `${padSortOrder(teamSortOrder)}#${padSortOrder(projectSortOrder)}#PROJECT#${projectId}`
}

function createProjectMemberEntryKey(projectId: string, memberKey: string) {
  return `PROJECT_MEMBER#${projectId}#${memberKey}`
}

function padSortOrder(value: number) {
  return String(value).padStart(6, '0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toProjectPrincipal(user: GetUserResponse, accessToken: string): ProjectPrincipal {
  const userKey = readUserAttribute(user, 'email') ?? user.Username

  if (!userKey?.trim()) {
    throw new ProjectDataError(
      403,
      'ProjectPrincipalMissing',
      'Cognito user does not have a stable project access identifier.',
    )
  }

  const normalizedUserKey = userKey.trim().toLowerCase()
  const actorId = readUserAttribute(user, 'sub')?.trim() || user.Username?.trim() || normalizedUserKey
  const directoryId = readProjectDirectoryId(user) ?? `${projectDirectoryIdPrefix}${normalizedUserKey}`
  const groups = readCognitoGroups(accessToken)

  return {
    directoryId,
    userKey: normalizedUserKey,
    actorId,
    isSystemAdmin: groups.some((group) => getSystemAdminGroups().includes(group)),
    groups,
  }
}

function validateConfiguredCognitoAccessToken(accessToken: string) {
  const userPoolId = getEnv('COGNITO_USER_POOL_ID')?.trim()
  const clientId = getEnv('COGNITO_CLIENT_ID')?.trim()

  if ((!userPoolId || !clientId) && !canAutoDiscoverLocalCognitoConfiguration()) {
    throw new CognitoServiceError(
      503,
      'CognitoConfigurationMissing',
      'COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required.',
    )
  }

  if (!userPoolId && !clientId) {
    return
  }

  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  const expectedIssuer = userPoolId ? getConfiguredCognitoIssuer(userPoolId) : undefined
  const tokenIssuer = typeof claims?.iss === 'string'
    ? normalizeCognitoIssuer(claims.iss)
    : undefined

  if (
    !claims ||
    claims.token_use !== 'access' ||
    (expectedIssuer && tokenIssuer !== expectedIssuer) ||
    (clientId && claims.client_id !== clientId)
  ) {
    throw new CognitoServiceError(
      401,
      'CognitoAccessTokenInvalid',
      'Access token does not match the configured Cognito user pool and app client.',
    )
  }
}

function getConfiguredCognitoIssuer(userPoolId: string) {
  const configuredIssuer = normalizeCognitoIssuer(getEnv('COGNITO_ISSUER') ?? '')

  return configuredIssuer || createCognitoIssuer(userPoolId)
}

function normalizeCognitoIssuer(value: string) {
  return trimTrailingSlash(value.trim())
}

function createCognitoIssuer(userPoolId: string) {
  const poolRegion = userPoolId.split('_')[0] || getAwsRegion()
  const domainSuffix = poolRegion.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'

  return `https://cognito-idp.${poolRegion}.${domainSuffix}/${userPoolId}`
}

function canAutoDiscoverLocalCognitoConfiguration() {
  return Boolean(getCognitoEndpoint()) || (
    typeof Bun !== 'undefined' && !getEnv('AWS_LAMBDA_FUNCTION_NAME')
  )
}

function readUserAttribute(user: GetUserResponse, name: string) {
  return user.UserAttributes?.find((attribute) => attribute.Name === name)?.Value
}

function getConfiguredWorkspaceDirectoryId() {
  return (
    getEnv('MUKUROJI_WORKSPACE_DIRECTORY_ID')?.trim() ||
    getEnv('MUKUROJI_PROJECT_DIRECTORY_ID')?.trim() ||
    undefined
  )
}

function readProjectDirectoryId(user: GetUserResponse) {
  const directoryId = readUserAttribute(user, 'custom:directory_id')?.trim() || undefined
  const workspaceId = readUserAttribute(user, 'custom:workspace_id')?.trim() || undefined
  const configuredWorkspaceDirectoryId = getConfiguredWorkspaceDirectoryId()

  if (directoryId && workspaceId && directoryId !== workspaceId) {
    throw new ProjectDataError(
      403,
      'ProjectDirectoryMismatch',
      'Cognito directory attributes do not identify the same workspace.',
    )
  }

  const claimedDirectoryId = directoryId ?? workspaceId

  if (
    configuredWorkspaceDirectoryId &&
    claimedDirectoryId !== configuredWorkspaceDirectoryId
  ) {
    throw new ProjectDataError(
      403,
      'ProjectDirectoryMismatch',
      `Cognito workspace "${claimedDirectoryId ?? 'missing'}" does not match configured workspace "${configuredWorkspaceDirectoryId}".`,
    )
  }

  return claimedDirectoryId
}

function readCognitoGroups(accessToken: string) {
  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  const groups = claims?.['cognito:groups']

  if (!Array.isArray(groups)) {
    return []
  }

  return groups.filter((group): group is string => typeof group === 'string' && Boolean(group))
}

function decodeJwtPayload<T>(token: string): T | undefined {
  const payload = token.split('.')[1]

  if (!payload) {
    return undefined
  }

  try {
    const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/')
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - normalizedPayload.length % 4) % 4),
      '=',
    )
    const json = Buffer.from(paddedPayload, 'base64').toString('utf8')

    return JSON.parse(json) as T
  } catch {
    return undefined
  }
}

function getSystemAdminGroups() {
  const configuredGroups = (
    getEnv('MUKUROJI_SYSTEM_ADMIN_GROUPS') ??
    getEnv('SYSTEM_ADMIN_GROUPS') ??
    ''
  )
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean)

  return configuredGroups.length > 0 ? configuredGroups : defaultSystemAdminGroups
}

function createDirectoryTeamId(directoryId: string, teamId: string) {
  return `${directoryId}#team#${teamId}`
}

function createTeamIssueLookupKey(teamId: string, issueId: string) {
  return JSON.stringify([teamId, issueId])
}

function createDirectoryTeamIssueId(directoryId: string, teamId: string, issueId: string) {
  return `${createDirectoryTeamId(directoryId, teamId)}#issue#${issueId}`
}

/** Team Issue event の DynamoDB key を scope-bound opaque cursor に変換します。 */
function encodeTeamIssueEventCursor(
  directoryTeamIssueId: string,
  key: Record<string, unknown>,
) {
  const eventId = typeof key.eventId === 'string' ? key.eventId : undefined
  if (!eventId) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team Issue event page did not include a valid continuation key.',
    )
  }

  const cursor: TeamIssueEventCursor = {
    version: 1,
    directoryTeamIssueId,
    eventId,
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Team Issue event cursor を検証し DynamoDB key に戻します。 */
function decodeTeamIssueEventCursor(
  value: string | undefined,
  directoryTeamIssueId: string,
) {
  if (!value) {
    return undefined
  }

  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<TeamIssueEventCursor>
    if (
      cursor.version !== 1 ||
      cursor.directoryTeamIssueId !== directoryTeamIssueId ||
      typeof cursor.eventId !== 'string' ||
      !cursor.eventId
    ) {
      throw new TypeError('Invalid cursor payload.')
    }
    return {
      directoryTeamIssueId,
      eventId: cursor.eventId,
    }
  } catch {
    throw new ProjectDataError(
      400,
      'InvalidTeamIssueCursor',
      'Team Issue event cursor is invalid.',
    )
  }
}

/**
 * Team-local Issue ID を Workspace 内で一意な audit Work Item ID に変換します。
 */
function createTeamIssueAuditEntityId(teamId: string, issueId: string) {
  return `team/${teamId}/issue/${issueId}`
}

/**
 * Team Issue comment を Workspace 内で一意な audit target ID に変換します。
 */
function createTeamIssueAuditCommentId(teamId: string, issueId: string, commentId: string) {
  return `${createTeamIssueAuditEntityId(teamId, issueId)}/comment/${commentId}`
}

function createDirectoryProjectId(directoryId: string, projectId: string) {
  return `${directoryId}#project#${projectId}`
}

function createLegacyTaskMigrationSourceKey(
  directoryId: string,
  projectId: string,
  taskId: string,
) {
  return `${createDirectoryProjectId(directoryId, projectId)}#task#${taskId}`
}

function isLegacyTaskMigrationSourceKey(
  value: unknown,
  directoryId: string,
  issueId: string,
) {
  if (typeof value !== 'string') {
    return false
  }

  const prefix = `${directoryId}#project#`
  if (!value.startsWith(prefix)) {
    return false
  }

  const [projectId, taskId, ...unexpectedParts] = value.slice(prefix.length).split('#task#')

  return Boolean(projectId) && taskId === issueId && unexpectedParts.length === 0
}

/**
 * Project-local Task ID を Workspace 内で一意な audit Work Item ID に変換します。
 */
function createProjectTaskAuditEntityId(projectId: string, taskId: string) {
  return `project/${projectId}/task/${taskId}`
}

function createTeamIssueEventId(createdAt: string, eventType: TeamIssueActivityType) {
  return `${createdAt}#${eventType}#${Math.random().toString(36).slice(2, 10)}`
}

function getAwsRegion() {
  return getEnv('AWS_REGION') ?? getEnv('AWS_DEFAULT_REGION') ?? 'us-east-1'
}

function getDynamoDbEndpoint() {
  const configuredEndpoint = getConfiguredDynamoDbEndpoint({
    DYNAMODB_ENDPOINT: getEnv('DYNAMODB_ENDPOINT'),
    AWS_ENDPOINT_URL_DYNAMODB: getEnv('AWS_ENDPOINT_URL_DYNAMODB'),
    AWS_ENDPOINT_URL: getEnv('AWS_ENDPOINT_URL'),
  })

  if (configuredEndpoint) {
    return configuredEndpoint
  }

  return typeof Bun !== 'undefined' && !getEnv('AWS_LAMBDA_FUNCTION_NAME')
    ? 'http://localhost:4566'
    : undefined
}

function getAllowedOrigins() {
  const configuredOrigins = (getEnv('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return configuredOrigins.length > 0 ? configuredOrigins : [...defaultAllowedOrigins]
}

function getCognitoEndpoint() {
  const configuredEndpoint = getEnv('COGNITO_ENDPOINT') ?? getEnv('AWS_ENDPOINT_URL')

  if (configuredEndpoint?.trim()) {
    return trimTrailingSlash(configuredEndpoint.trim())
  }

  return typeof Bun !== 'undefined' && !getEnv('AWS_LAMBDA_FUNCTION_NAME')
    ? 'http://localhost:4566'
    : undefined
}

function getEnv(name: string) {
  if (typeof Bun !== 'undefined') {
    return Bun.env[name]
  }

  return process.env[name]
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function normalizeCognitoErrorCode(value: string | undefined) {
  return value?.split('#').pop()
}

function createCognitoClient(): CognitoClient {
  const endpoint = getCognitoEndpoint()

  return endpoint
    ? new FlociCognitoClient(endpoint)
    : new AwsCognitoClient()
}

function normalizeLambdaApiEvent(event: LambdaEvent): LambdaEvent {
  if ('rawPath' in event) {
    const rawPath = normalizeApiRequestPath(event.rawPath)

    if (rawPath === event.rawPath) {
      return event
    }

    return {
      ...event,
      rawPath,
      requestContext: {
        ...event.requestContext,
        http: {
          ...event.requestContext.http,
          path: rawPath,
        },
      },
    }
  }

  const path = normalizeApiRequestPath(event.path)

  return path === event.path ? event : { ...event, path }
}

function normalizeApiRequestPath(path: string) {
  if (path === '/' || path === '/api' || path.startsWith('/api/')) {
    return path
  }

  return `/api${path.startsWith('/') ? path : `/${path}`}`
}

cognito = createCognitoClient()
dashboardSummary = new DynamoDbDashboardSummaryClient()
projectTasks = new DynamoDbProjectTasksClient()
teamIssues = new DynamoDbTeamIssuesClient()
projectDirectory = new DynamoDbProjectDirectoryClient()
auditEvents = createAuditEventsClient()
workspaceAccess = new DynamoDbWorkspaceAccessClient()
realtimeTickets = new DynamoDbRealtimeTicketsClient()
collaboration = new DynamoDbCollaborationClient()
fileProofing = createDefaultFileProofingClient()

/**
 * Server test で外部 service client を差し替えます。
 */
export function configureApiClientsForTest(clients: {
  cognito?: CognitoClient
  dashboardSummary?: DashboardSummaryClient
  projectTasks?: ProjectTasksClient
  teamIssues?: TeamIssuesClient
  projectDirectory?: ProjectDirectoryClient
  auditEvents?: AuditEventsClient
  workspaceAccess?: WorkspaceAccessClient
  realtimeTickets?: RealtimeTicketsClient
  collaboration?: CollaborationClient
  fileProofing?: FileProofingClient
}) {
  cognito = clients.cognito ?? cognito
  dashboardSummary = clients.dashboardSummary ?? dashboardSummary
  projectTasks = clients.projectTasks ?? projectTasks
  teamIssues = clients.teamIssues ?? teamIssues
  projectDirectory = clients.projectDirectory ?? projectDirectory
  auditEvents = clients.auditEvents ?? auditEvents
  workspaceAccess = clients.workspaceAccess ?? workspaceAccess
  realtimeTickets = clients.realtimeTickets ?? realtimeTickets
  collaboration = clients.collaboration ?? collaboration
  fileProofing = clients.fileProofing ?? fileProofing
}

/**
 * Server test 後に外部 service client を実装 client に戻します。
 */
export function resetApiClientsForTest() {
  cognito = createCognitoClient()
  dashboardSummary = new DynamoDbDashboardSummaryClient()
  projectTasks = new DynamoDbProjectTasksClient()
  teamIssues = new DynamoDbTeamIssuesClient()
  projectDirectory = new DynamoDbProjectDirectoryClient()
  auditEvents = createAuditEventsClient()
  workspaceAccess = new DynamoDbWorkspaceAccessClient()
  realtimeTickets = new DynamoDbRealtimeTicketsClient()
  collaboration = new DynamoDbCollaborationClient()
  fileProofing = createDefaultFileProofingClient()
}

/**
 * AWS Lambda にデプロイする Hono handler です。
 */
const lambdaHandler = handle(app)

/**
 * Function URL 直下と `/api` prefix 付き event を同じ Hono route へ渡す Lambda handler です。
 */
export const handler = (event: LambdaEvent, lambdaContext?: LambdaContext) => {
  return lambdaHandler(normalizeLambdaApiEvent(event), lambdaContext)
}

/**
 * Bun のローカル開発サーバー entrypoint です。
 */
export default {
  port: Number(getEnv('PORT') ?? 3000),
  fetch: app.fetch,
}
