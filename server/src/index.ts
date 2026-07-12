import {
  AdminGetUserCommand,
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
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
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
type ProjectTaskStatus = 'in-progress' | 'review' | 'todo' | 'done'

/**
 * タスクの優先度を表す API code です。
 */
type ProjectTaskPriority = 'high' | 'medium' | 'low'

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
  title: string
  /**
   * Issue 詳細説明です。
   */
  description?: string
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId: string
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
type TeamIssueResponseItem = {
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
  assigneeUserId: string
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
   * コメント本文です。
   */
  body?: unknown
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
  getProjectTasks(directoryId: string, projectId: string): Promise<ProjectTasksResponse>
  /**
   * DynamoDB に指定 project ID のタスクを作成します。
   */
  createProjectTask(
    directoryId: string,
    projectId: string,
    input: CreateProjectTaskRequestBody,
    auditContext?: MutationAuditContext,
  ): Promise<CreateProjectTaskResponse>
  /**
   * DynamoDB に保存された指定 task ID の状態を更新します。
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
  getTeamIssues(directoryId: string, teamId: string): Promise<TeamIssuesResponse>
  /**
   * DynamoDB から指定 project ID にアサインされた Issue 一覧を取得します。
   */
  getProjectIssues(directoryId: string, projectId: string): Promise<ProjectIssuesResponse>
  /**
   * DynamoDB から Issue 詳細、コメント、活動履歴を取得します。
   */
  getTeamIssueDetail(
    directoryId: string,
    teamId: string,
    issueId: string,
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
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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

/**
 * DynamoDB に保存されたプロジェクト別タスク一覧を返す endpoint です。
 *
 * @remarks
 * `ProjectSortOrderIndex` で `sortOrder` 昇順に取得し、画面表示用 DTO に変換します。
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

    return c.json(
      await hydrateProjectTasksResponse(
        await projectTasks.getProjectTasks(principal.directoryId, projectId),
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
      const detail = await teamIssues.getTeamIssueDetail(principal.directoryId, teamId, issueId)
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
      const detail = await teamIssues.getTeamIssueDetail(principal.directoryId, teamId, issueId)
      requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'viewer')

      return c.json(
        await hydrateTeamIssueDetailResponse(
          detail,
        ),
      )
    } catch (error) {
      if (isTeamIssueNotFoundError(error)) {
        const legacyIssue = await readLegacyTeamIssue(principal.directoryId, context, principal, issueId)

        if (legacyIssue) {
          return c.json(
            await hydrateTeamIssueDetailResponse({
              issue: legacyIssue,
              comments: [],
              activity: [],
            }),
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
    const detail = await teamIssues.getTeamIssueDetail(principal.directoryId, teamId, issueId)
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
          body,
          principal.userKey,
          createApiMutationContext(c, principal, { teamId, issueId, ...body }),
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
    const context = await requireTeamPermission(principal, teamId, 'member')
    const detail = await teamIssues.getTeamIssueDetail(principal.directoryId, teamId, issueId)
    requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'member')
    const body = await readJson<CreateTeamIssueCommentRequestBody>(c.req) ?? {}

    return c.json(
      await teamIssues.createTeamIssueComment(
        principal.directoryId,
        teamId,
        issueId,
        body,
        principal.userKey,
        createApiMutationContext(c, principal, { teamId, issueId, ...body }),
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
 * DynamoDB にプロジェクト別タスクを新規作成する endpoint です。
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

    const body = await readJson<CreateProjectTaskRequestBody>(c.req)
    const assigneeUserId = readTaskAssigneeUserId(body ?? {})
    await requireActiveWorkspaceAssignee(principal.directoryId, assigneeUserId)

    return c.json(
      await hydrateProjectTaskUpdateResponse(
        await projectTasks.createProjectTask(
          principal.directoryId,
          projectId,
          {
            ...body,
            assigneeUserId,
          },
          createApiMutationContext(c, principal, { projectId, ...body, assigneeUserId }),
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
 * DynamoDB に保存されたプロジェクト別タスクの状態を更新する endpoint です。
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
    readRequiredTaskStatus(body?.status)

    if (await isLegacyProjectTaskIssue(principal.directoryId, projectId, taskId)) {
      return c.json({ message: 'Legacy task issues are read-only.' }, 409)
    }

    return c.json(
      await hydrateProjectTaskUpdateResponse(
        await projectTasks.updateProjectTaskStatus(
          principal.directoryId,
          projectId,
          taskId,
          body ?? {},
          createApiMutationContext(c, principal, { projectId, taskId, ...body }),
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

async function readJson<T>(request: { json: () => Promise<T> }) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
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

function toProjectDataErrorResponse(c: Context, error: unknown) {
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(c, error)
  }

  if (!(error instanceof ProjectDataError)) {
    console.error(error)
    return c.json({ message: 'Project data is unavailable.' }, 502)
  }

  if (error.code === 'InvalidProjectWrite' || error.code === 'InvalidAuditQuery') {
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

  if (error.code === 'TeamIssueNotFound') {
    return c.json({ message: 'Issue was not found.' }, 404)
  }

  if (error.code === 'ProjectMemberNotFound') {
    return c.json({ message: 'Project member was not found.' }, 404)
  }

  if (error.code === 'ConditionalCheckFailedException') {
    return c.json({ message: 'The same item already exists.' }, 409)
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

async function hydrateTeamIssueDetailResponse(response: TeamIssueDetailResponse) {
  const profiles = await readIssueAssigneeProfiles([response.issue])

  return {
    ...response,
    issue: hydrateTeamIssue(response.issue, profiles),
  } satisfies TeamIssueDetailResponse
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
) {
  const storedIssues = await teamIssues.getTeamIssues(directoryId, context.team.id)
  const legacyIssues = await readLegacyTeamIssues(directoryId, context, principal)

  return {
    teamId: context.team.id,
    issues: mergeTeamIssues(
      filterAccessibleTeamIssues(storedIssues.issues, principal, context),
      legacyIssues,
    ),
  } satisfies TeamIssuesResponse
}

async function readProjectIssues(directoryId: string, projectId: string) {
  const storedIssues = await teamIssues.getProjectIssues(directoryId, projectId)
  const directory = await projectDirectory.getProjectDirectory(directoryId, 'ja')
  const ownerTeamId = findFirstProjectTeamId(directory.teams, projectId)
  const legacyIssues = ownerTeamId
    ? (await projectTasks.getProjectTasks(directoryId, projectId)).tasks.map((task) =>
      toLegacyTeamIssue(task, ownerTeamId, projectId),
    )
    : []

  return {
    projectId,
    issues: mergeTeamIssues(storedIssues.issues, legacyIssues),
  } satisfies ProjectIssuesResponse
}

async function readLegacyTeamIssues(
  directoryId: string,
  context: TeamPermissionContext,
  principal: ProjectPrincipal,
) {
  const issues: TeamIssueResponseItem[] = []

  for (const project of context.team.projects) {
    if (findFirstProjectTeamId(context.directory.teams, project.id) !== context.team.id) {
      continue
    }

    if (!canAccessAssignedProject(principal, context, project.id, 'viewer')) {
      continue
    }

    const response = await projectTasks.getProjectTasks(directoryId, project.id)
    issues.push(...response.tasks.map((task) => toLegacyTeamIssue(task, context.team.id, project.id)))
  }

  return issues
}

async function readLegacyTeamIssue(
  directoryId: string,
  context: TeamPermissionContext,
  principal: ProjectPrincipal,
  issueId: string,
) {
  return (await readLegacyTeamIssues(directoryId, context, principal)).find((issue) => issue.id === issueId)
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

function toLegacyTeamIssue(
  task: ProjectTaskResponseItem,
  teamId: string,
  assignedProjectId: string,
): TeamIssueResponseItem {
  return {
    id: task.id,
    teamId,
    assignedProjectId,
    titleKey: task.titleKey,
    title: task.title,
    assigneeUserId: task.assigneeUserId ?? task.assigneeKey ?? task.assignee ?? 'legacy-assignee@example.invalid',
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

function findFirstProjectTeamId(teams: ProjectDirectoryTeamResponse[], projectId: string) {
  return teams.find((team) => team.projects.some((project) => project.id === projectId))?.id
}

async function hydrateProjectTaskUpdateResponse<T extends { task: ProjectTaskResponseItem }>(response: T) {
  const profiles = await readTaskAssigneeProfiles([response.task])

  return {
    ...response,
    task: hydrateProjectTask(response.task, profiles),
  }
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
 * DynamoDB の team/project と task data からダッシュボード集計値を算出する client です。
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

  constructor(
    projectDirectoryClient: ProjectDirectoryClient = new DynamoDbProjectDirectoryClient(),
    projectTasksClient: ProjectTasksClient = new DynamoDbProjectTasksClient(),
  ) {
    this.projectDirectoryClient = projectDirectoryClient
    this.projectTasksClient = projectTasksClient
  }

  /**
   * ユーザー directory の team/project と task data からダッシュボード集計値を取得します。
   */
  async getSummary(directoryId: string, accessContext: DashboardSummaryAccessContext) {
    const visibleProjectIds = accessContext.isSystemAdmin
      ? new Set(
        (await this.projectDirectoryClient.getProjectDirectory(directoryId, 'ja'))
          .teams.flatMap((team) => team.projects.map((project) => project.id)),
      )
      : new Set(
        (await this.projectDirectoryClient.getProjectAccessList(directoryId, accessContext.userKey))
          .filter((access) => projectAccessAllows(access, 'viewer'))
          .map((access) => access.projectId)
      )
    const taskResponses = await Promise.all(
      Array.from(visibleProjectIds).map((projectId) =>
        this.projectTasksClient.getProjectTasks(directoryId, projectId),
      ),
    )
    const tasks = taskResponses.flatMap((response) => response.tasks)

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
  async getProjectTasks(directoryId: string, projectId: string) {
    try {
      const items = await this.queryProjectTaskItems(directoryId, projectId)
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
   * DynamoDB にプロジェクト別タスクを作成します。
   */
  async createProjectTask(
    directoryId: string,
    projectId: string,
    input: CreateProjectTaskRequestBody,
    auditContext?: MutationAuditContext,
  ) {
    await ensureConfiguredAuditTable(
      this.auditTableName,
      this.dynamoDbClient,
      this.bootstrapLocalTables,
    )
    const title = readRequiredString(input.title, 'Task title is required.')
    const assigneeUserId = readTaskAssigneeUserId(input)
    const status = readTaskStatus(input.status)
    const dueDate = readRequiredString(input.dueDate, 'Task due date is required.')
    const priority = readTaskPriority(input.priority)
    const directoryProjectId = createDirectoryProjectId(directoryId, projectId)

    try {
      const currentTasks = await this.getProjectTasks(directoryId, projectId)
      const taskId = createUniqueResourceId(title, currentTasks.tasks.map((task) => task.id))
      const sortOrder = (currentTasks.tasks.length + 1) * 10
      const item: ProjectTaskItem = {
        directoryId,
        directoryProjectId,
        projectId,
        taskId,
        sortOrder,
        title,
        assigneeUserId,
        status,
        dueDate,
        priority,
      }

      const statePut = {
        Put: {
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryProjectId) AND attribute_not_exists(taskId)',
        },
      }
      const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'work-item.created',
        entityType: 'work-item',
        entityId: createProjectTaskAuditEntityId(projectId, taskId),
        action: 'created',
        changes: createAuditFieldChanges(undefined, item, [
          'title',
          'assigneeUserId',
          'status',
          'dueDate',
          'priority',
        ]),
        metadata: { adapter: 'legacy-project-task', projectId },
      })

      if (auditPut) {
        await this.documentClient.send(
          new TransactWriteCommand({ TransactItems: [statePut, auditPut] }),
        )
      } else {
        await this.documentClient.send(new PutCommand(statePut.Put))
      }

      return {
        task: toProjectTaskResponseItem(item),
      } satisfies CreateProjectTaskResponse
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
   * DynamoDB に保存されたプロジェクト別タスクの状態を更新します。
   */
  async updateProjectTaskStatus(
    directoryId: string,
    projectId: string,
    taskId: string,
    input: UpdateProjectTaskStatusRequestBody,
    auditContext?: MutationAuditContext,
  ) {
    await ensureConfiguredAuditTable(
      this.auditTableName,
      this.dynamoDbClient,
      this.bootstrapLocalTables,
    )
    const status = readRequiredTaskStatus(input.status)
    const directoryProjectId = createDirectoryProjectId(directoryId, projectId)

    try {
      if (this.auditTableName && auditContext) {
        const currentStoredItem = await this.getProjectTaskItem(directoryId, projectId, taskId)

        if (!currentStoredItem) {
          throw new ProjectDataError(404, 'ProjectTaskNotFound', 'Task was not found.')
        }

        const currentItem = toProjectTaskResponseItem(currentStoredItem)
        const updatedItem = { ...currentItem, status }
        const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
          directoryId,
          eventType: 'work-item.updated',
          entityType: 'work-item',
          entityId: createProjectTaskAuditEntityId(projectId, taskId),
          action: 'updated',
          changes: createAuditFieldChanges(currentItem, updatedItem, ['status']),
          metadata: { adapter: 'legacy-project-task', projectId },
        })

        await this.documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.tableName,
                  Key: { directoryProjectId, taskId },
                  UpdateExpression: 'SET #status = :status',
                  ExpressionAttributeNames: { '#status': 'status' },
                  ExpressionAttributeValues: {
                    ':status': status,
                    ':beforeStatus': currentItem.status,
                  },
                  ConditionExpression:
                    'attribute_exists(directoryProjectId) AND attribute_exists(taskId) AND #status = :beforeStatus',
                },
              },
              ...(auditPut ? [auditPut] : []),
            ],
          }),
        )

        return { task: updatedItem } satisfies UpdateProjectTaskStatusResponse
      }

      const response = await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: {
            directoryProjectId,
            taskId,
          },
          UpdateExpression: 'SET #status = :status',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':status': status,
          },
          ConditionExpression: 'attribute_exists(directoryProjectId) AND attribute_exists(taskId)',
          ReturnValues: 'ALL_NEW',
        }),
      )

      return {
        task: toProjectTaskResponseItem(response.Attributes),
      } satisfies UpdateProjectTaskStatusResponse
    } catch (error) {
      if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
        throw new ProjectDataError(404, 'ProjectTaskNotFound', 'Task was not found.')
      }

      if (isTransactionConditionalFailureAt(error, 0)) {
        let taskExists: boolean

        try {
          taskExists = (await this.getProjectTaskItem(directoryId, projectId, taskId)) !== undefined
        } catch (readError) {
          if (readError instanceof ProjectDataError) {
            throw readError
          }

          throw toProjectDataError(readError)
        }

        if (!taskExists) {
          throw new ProjectDataError(404, 'ProjectTaskNotFound', 'Task was not found.')
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
  }

  /**
   * base table の strongly consistent read で project task を取得します。
   */
  private async getProjectTaskItem(
    directoryId: string,
    projectId: string,
    taskId: string,
    canBootstrapLocalTable = true,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.documentClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            directoryProjectId: createDirectoryProjectId(directoryId, projectId),
            taskId,
          },
          ConsistentRead: true,
        }),
      )

      return response.Item
    } catch (error) {
      if (
        canBootstrapLocalTable &&
        this.bootstrapLocalTables &&
        isResourceNotFoundError(error) &&
        await ensureLocalProjectTasksTable(this.tableName, this.dynamoDbClient)
      ) {
        return this.getProjectTaskItem(directoryId, projectId, taskId, false)
      }

      throw error
    }
  }

  /**
   * DynamoDB から project partition の task item を全件取得します。
   */
  private async queryProjectTaskItems(
    directoryId: string,
    projectId: string,
    canBootstrapLocalTable = true,
  ) {
    try {
      const items: unknown[] = []
      let exclusiveStartKey: Record<string, unknown> | undefined

      do {
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
        await ensureLocalProjectTasksTable(this.tableName, this.dynamoDbClient)
      ) {
        return this.queryProjectTaskItems(directoryId, projectId, false)
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

  constructor(
    issueTableName =
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
  ) {
    this.issueTableName = issueTableName
    this.eventTableName = eventTableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
    this.auditTableName = auditTableName
  }

  /**
   * DynamoDB から指定 team ID の Issue 一覧を取得します。
   */
  async getTeamIssues(directoryId: string, teamId: string) {
    await this.ensureLocalTables()

    try {
      const items = await this.queryTeamIssueItems(directoryId, teamId)

      return {
        teamId,
        issues: items.map(toTeamIssueResponseItem),
      } satisfies TeamIssuesResponse
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
  async getProjectIssues(directoryId: string, projectId: string) {
    await this.ensureLocalTables()

    try {
      const items = await this.queryProjectIssueItems(directoryId, projectId)

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
  async getTeamIssueDetail(directoryId: string, teamId: string, issueId: string) {
    await this.ensureLocalTables()

    try {
      const issue = await this.getRequiredTeamIssueItem(directoryId, teamId, issueId)
      const events = await this.queryTeamIssueEventItems(directoryId, teamId, issueId)

      return {
        issue: toTeamIssueResponseItem(issue),
        comments: events
          .filter((event) => event.eventType === 'commented' && event.body)
          .map(toTeamIssueCommentResponseItem),
        activity: events.map(toTeamIssueActivityResponseItem),
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
        directoryId,
        directoryTeamId,
        teamId,
        issueId,
        sortOrder: (currentIssues.issues.length + 1) * 10,
        title,
        assigneeUserId,
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
        metadata: { adapter: 'team-issue', teamId, projectId: assignedProjectId },
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
    const directoryTeamId = createDirectoryTeamId(directoryId, teamId)
    const expressionAttributeNames: Record<string, string> = {
      '#updatedAt': 'updatedAt',
    }
    const expressionAttributeValues: Record<string, unknown> = {
      ':updatedAt': new Date().toISOString(),
    }
    const setExpressions = ['#updatedAt = :updatedAt']
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
      const beforeIssue = this.auditTableName && auditContext
        ? await this.getRequiredTeamIssueItem(directoryId, teamId, issueId, true)
        : undefined
      const afterIssue = beforeIssue ? { ...beforeIssue } : undefined

      if (beforeIssue) {
        expressionAttributeValues[':beforeUpdatedAt'] = beforeIssue.updatedAt
      }

      if (afterIssue) {
        for (const [placeholder, field] of Object.entries(expressionAttributeNames)) {
          const value = expressionAttributeValues[`:${field}`]

          if (value !== undefined) {
            ;(afterIssue as unknown as Record<string, unknown>)[field] = value
          } else if (removeExpressions.includes(placeholder)) {
            delete (afterIssue as unknown as Record<string, unknown>)[field]
          }
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
      const auditPut = beforeIssue && afterIssue
        ? createMutationAuditEventPut(this.auditTableName, auditContext, {
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
              adapter: 'team-issue',
              teamId,
              projectId: afterIssue.assignedProjectId,
            },
          })
        : undefined
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
                ConditionExpression: beforeIssue
                  ? 'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #updatedAt = :beforeUpdatedAt'
                  : 'attribute_exists(directoryTeamId) AND attribute_exists(issueId)',
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
      changes: createAuditFieldChanges(undefined, { body }),
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

  private async queryTeamIssueItems(directoryId: string, teamId: string) {
    const items: unknown[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined

    do {
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
        }),
      )

      items.push(...(response.Items ?? []))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items.map(toTeamIssueItem)
  }

  private async queryProjectIssueItems(directoryId: string, projectId: string) {
    const items: unknown[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined

    do {
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
        }),
      )

      items.push(...(response.Items ?? []))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items.map(toTeamIssueItem)
  }

  private async queryTeamIssueEventItems(directoryId: string, teamId: string, issueId: string) {
    const items: unknown[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined

    do {
      const response = await this.documentClient.send(
        new QueryCommand({
          TableName: this.eventTableName,
          KeyConditionExpression: 'directoryTeamIssueId = :directoryTeamIssueId',
          ExpressionAttributeValues: {
            ':directoryTeamIssueId': createDirectoryTeamIssueId(directoryId, teamId, issueId),
          },
          ExclusiveStartKey: exclusiveStartKey,
          ScanIndexForward: true,
        }),
      )

      items.push(...(response.Items ?? []))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items.map(toTeamIssueEventItem)
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
  for (const attributeName of projectDirectoryIdAttributeNames) {
    const directoryId = readCognitoUserAttribute(user, attributeName)?.trim()

    if (directoryId) {
      return directoryId
    }
  }

  return undefined
}

function createWorkspaceCognitoUserAttributes(email: string, directoryId: string, name?: string) {
  return [
    { Name: 'email', Value: normalizeCognitoUserId(email) },
    { Name: 'custom:directory_id', Value: directoryId },
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
    id: item.issueId,
    teamId: item.teamId,
    title: item.title,
    assigneeUserId: item.assigneeUserId,
    status: item.status,
    dueDate: item.dueDate,
    priority: item.priority,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    source: 'dynamodb',
  }

  if (item.assignedProjectId) {
    issue.assignedProjectId = item.assignedProjectId
  }

  if (item.description) {
    issue.description = item.description
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
  if (!isTeamIssueItem(value)) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team issue item is missing or invalid.',
    )
  }

  return value
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
    typeof value.directoryId === 'string' &&
    typeof value.teamId === 'string' &&
    value.directoryTeamId === createDirectoryTeamId(value.directoryId, value.teamId) &&
    typeof value.issueId === 'string' &&
    typeof value.sortOrder === 'number' &&
    typeof value.title === 'string' &&
    (value.description === undefined || typeof value.description === 'string') &&
    typeof value.assigneeUserId === 'string' &&
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

function createDirectoryTeamIssueId(directoryId: string, teamId: string, issueId: string) {
  return `${createDirectoryTeamId(directoryId, teamId)}#issue#${issueId}`
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
}) {
  cognito = clients.cognito ?? cognito
  dashboardSummary = clients.dashboardSummary ?? dashboardSummary
  projectTasks = clients.projectTasks ?? projectTasks
  teamIssues = clients.teamIssues ?? teamIssues
  projectDirectory = clients.projectDirectory ?? projectDirectory
  auditEvents = clients.auditEvents ?? auditEvents
  workspaceAccess = clients.workspaceAccess ?? workspaceAccess
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
