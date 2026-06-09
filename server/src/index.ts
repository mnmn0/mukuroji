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
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { Hono } from 'hono'
import { handle } from 'hono/aws-lambda'
import { cors } from 'hono/cors'
import type { Context } from 'hono'

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
   * Cognito グループでシステム管理者として扱うかどうかです。
   */
  isSystemAdmin: boolean
  /**
   * access token に含まれていた Cognito グループ名です。
   */
  groups: string[]
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
  ): Promise<CreateProjectTaskResponse>
  /**
   * DynamoDB に保存された指定 task ID の状態を更新します。
   */
  updateProjectTaskStatus(
    directoryId: string,
    projectId: string,
    taskId: string,
    input: UpdateProjectTaskStatusRequestBody,
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
  ): Promise<UpdateProjectMemberResponse>
  /**
   * DynamoDB から project member role を削除します。
   */
  removeProjectMember(
    directoryId: string,
    projectId: string,
    memberKey: string,
  ): Promise<RemoveProjectMemberResponse>
  /**
   * DynamoDB にチームを作成します。
   */
  createTeam(directoryId: string, input: CreateTeamRequestBody): Promise<CreateTeamResponse>
  /**
   * DynamoDB に指定チーム配下のプロジェクトを作成します。
   */
  createProject(
    directoryId: string,
    teamId: string,
    input: CreateProjectRequestBody,
    creator: ProjectCreatorContext,
  ): Promise<CreateProjectResponse>
  /**
   * DynamoDB 上のチームをアーカイブします。
   */
  archiveTeam(directoryId: string, teamId: string): Promise<ArchiveTeamResponse>
  /**
   * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
   */
  archiveProject(
    directoryId: string,
    teamId: string,
    projectId: string,
  ): Promise<ArchiveProjectResponse>
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
const projectDirectoryIdPrefix = 'user#'
const projectDirectoryIdAttributeNames = [
  'custom:directory_id',
  'custom:workspace_id',
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
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:6006',
      'http://127.0.0.1:6006',
    ],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
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
      return c.json(
        {
          message: response.ChallengeName
            ? `Unsupported Cognito challenge: ${response.ChallengeName}`
            : 'Cognito did not return an access token.',
        },
        409,
      )
    }

    return c.json({
      accessToken: tokens.AccessToken,
      idToken: tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
      tokenType: tokens.TokenType ?? 'Bearer',
    })
  } catch (error) {
    return toAuthErrorResponse(c, error)
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
    const user = await cognito.getUser(accessToken)
    const principal = toProjectPrincipal(user, accessToken)

    return c.json({
      username: user.Username ?? '',
      attributes: Object.fromEntries(
        (user.UserAttributes ?? [])
          .filter((attribute) => attribute.Name && attribute.Value !== undefined)
          .map((attribute) => [attribute.Name as string, attribute.Value]),
      ),
      groups: principal.groups,
      isSystemAdmin: principal.isSystemAdmin,
    })
  } catch (error) {
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)

    return c.json(await dashboardSummary.getSummary(principal.directoryId, principal))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)

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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    requireSystemAdmin(principal)
    const body = await readJson<CreateTeamRequestBody>(c.req)

    return c.json(await projectDirectory.createTeam(principal.directoryId, body ?? {}), 201)
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    const body = await readJson<CreateProjectRequestBody>(c.req)

    return c.json(
      await projectDirectory.createProject(
        principal.directoryId,
        teamId,
        body ?? {},
        { userKey: principal.userKey },
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    requireSystemAdmin(principal)

    return c.json(await projectDirectory.archiveTeam(principal.directoryId, teamId))
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    await requireProjectPermission(principal, projectId, 'manager')

    return c.json(await projectDirectory.archiveProject(principal.directoryId, teamId, projectId))
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    await requireProjectPermission(principal, projectId, 'manager')

    return c.json(await cognito.listUsers(readCognitoUsersInput(c, principal.directoryId)))
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    await requireProjectPermission(principal, projectId, 'member')

    return c.json(
      await hydrateProjectMembersResponse(
        await projectDirectory.getProjectMembers(principal.directoryId, projectId),
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    await requireProjectPermission(principal, projectId, 'manager')
    const body = await readJson<UpdateProjectMemberRequestBody>(c.req)
    const profile = await cognito.getUserProfile(memberKey)

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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    await requireProjectPermission(principal, projectId, 'manager')

    return c.json(
      await projectDirectory.removeProjectMember(principal.directoryId, projectId, memberKey),
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    const context = await requireTeamPermission(principal, teamId, 'member')
    const body = normalizeTeamIssueInput(
      await readJson<CreateTeamIssueRequestBody>(c.req) ?? {},
      context.team,
    )
    requireAssignedProjectPermission(principal, context, body.assignedProjectId, 'member')
    const assigneeUserId = readTeamIssueAssigneeUserId(body)
    await cognito.getUserProfile(assigneeUserId)
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    const context = await requireTeamPermission(principal, teamId, 'member')
    const body = normalizeTeamIssueInput(
      await readJson<UpdateTeamIssueRequestBody>(c.req) ?? {},
      context.team,
    )
    const detail = await teamIssues.getTeamIssueDetail(principal.directoryId, teamId, issueId)
    requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'member')
    requireAssignedProjectPermission(principal, context, body.assignedProjectId, 'member')

    if ('assigneeUserId' in body) {
      await cognito.getUserProfile(readTeamIssueAssigneeUserId(body))
    }

    return c.json(
      await hydrateUpdateTeamIssueResponse(
        await teamIssues.updateTeamIssue(
          principal.directoryId,
          teamId,
          issueId,
          body,
          principal.userKey,
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    const context = await requireTeamPermission(principal, teamId, 'member')
    const detail = await teamIssues.getTeamIssueDetail(principal.directoryId, teamId, issueId)
    requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'member')

    return c.json(
      await teamIssues.createTeamIssueComment(
        principal.directoryId,
        teamId,
        issueId,
        await readJson<CreateTeamIssueCommentRequestBody>(c.req) ?? {},
        principal.userKey,
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    await requireProjectPermission(principal, projectId, 'member')

    const body = await readJson<CreateProjectTaskRequestBody>(c.req)
    const assigneeUserId = readTaskAssigneeUserId(body ?? {})
    await cognito.getUserProfile(assigneeUserId)

    return c.json(
      await hydrateProjectTaskUpdateResponse(
        await projectTasks.createProjectTask(
          principal.directoryId,
          projectId,
          {
            ...body,
            assigneeUserId,
          },
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
    const principal = toProjectPrincipal(await cognito.getUser(accessToken), accessToken)
    await requireProjectPermission(principal, projectId, 'member')

    const body = await readJson<UpdateProjectTaskStatusRequestBody>(c.req)
    readRequiredTaskStatus(body?.status)

    if (await isLegacyProjectTaskIssue(principal.directoryId, projectId, taskId)) {
      return c.json({ message: 'Legacy task issues are read-only.' }, 409)
    }

    return c.json(
      await hydrateProjectTaskUpdateResponse(
        await projectTasks.updateProjectTaskStatus(principal.directoryId, projectId, taskId, body ?? {}),
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

  if (error.code === 'ResourceNotFoundException' || error.code === 'ClientNotFoundException') {
    return c.json({ message: 'Cognito local resources are not ready.' }, 503)
  }

  if (error.status >= 500) {
    console.error(error)
    return c.json({ message: 'Cognito local service is unavailable.' }, 502)
  }

  return c.json({ message: error.message }, 400)
}

function toProjectDataErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof ProjectDataError)) {
    console.error(error)
    return c.json({ message: 'Project data is unavailable.' }, 502)
  }

  if (error.code === 'InvalidProjectWrite') {
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

  if (error.code === 'ConditionalCheckFailedException' || error.code === 'TransactionCanceledException') {
    return c.json({ message: 'The same item already exists.' }, 409)
  }

  if (error.code === 'ProjectLastManager') {
    return c.json({ message: 'At least one project manager is required.' }, 409)
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

  if (error.code === 'ProjectPrincipalMissing' || error.code === 'ProjectAccessDenied') {
    return c.json({ message: 'Project access is denied.' }, 403)
  }

  console.error(error)
  return c.json({ message: 'Project data is unavailable.' }, 502)
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

async function hydrateProjectMembersResponse(response: ProjectMembersResponse) {
  const members = await Promise.all(
    response.members.map(async (member) => hydrateProjectMember(member)),
  )

  return {
    ...response,
    members,
  } satisfies ProjectMembersResponse
}

async function hydrateProjectMemberUpdateResponse(response: UpdateProjectMemberResponse) {
  return {
    member: await hydrateProjectMember(response.member),
  } satisfies UpdateProjectMemberResponse
}

async function hydrateProjectMember(member: ProjectMemberResponseItem) {
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
    } satisfies ProjectMemberResponseItem
  } catch (error) {
    if (isCognitoUserNotFoundError(error)) {
      return member
    }

    console.warn('Failed to hydrate project member from Cognito:', error)
    return member
  }
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
 * Floci の Cognito JSON API を呼び出す軽量 client です。
 */
class FlociCognitoClient {
  /**
   * Floci / Cognito の endpoint URL です。
   */
  private readonly endpoint = trimTrailingSlash(
    getEnv('COGNITO_ENDPOINT') ?? getEnv('AWS_ENDPOINT_URL') ?? 'http://localhost:4566',
  )

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

  constructor(
    tableName =
      getEnv('MUKUROJI_PROJECT_TASKS_TABLE') ??
      getEnv('TASKS_TABLE_NAME') ??
      'mukuroji-project-tasks-v2-local',
    documentClient = createDynamoDbDocumentClient(),
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTables = dynamoDbClient === undefined && shouldBootstrapLocalDynamoDb(),
  ) {
    this.tableName = tableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
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
  ) {
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

      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryProjectId) AND attribute_not_exists(taskId)',
        }),
      )

      return {
        task: toProjectTaskResponseItem(item),
      } satisfies CreateProjectTaskResponse
    } catch (error) {
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
  ) {
    const status = readRequiredTaskStatus(input.status)
    const directoryProjectId = createDirectoryProjectId(directoryId, projectId)

    try {
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

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
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
  ) {
    this.issueTableName = issueTableName
    this.eventTableName = eventTableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
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
          ],
        }),
      )

      return {
        issue: toTeamIssueResponseItem(item),
      } satisfies CreateTeamIssueResponse
    } catch (error) {
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
      const eventItem = this.createIssueEventItem({
        directoryId,
        teamId,
        issueId,
        eventType: 'updated',
        actorUserId,
        summary: 'Issue was updated.',
        createdAt: expressionAttributeValues[':updatedAt'] as string,
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
                ConditionExpression: 'attribute_exists(directoryTeamId) AND attribute_exists(issueId)',
              },
            },
            {
              Put: {
                TableName: this.eventTableName,
                Item: eventItem,
                ConditionExpression: 'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
              },
            },
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

      if (
        isAwsNamedError(error, 'TransactionCanceledException') &&
        !await this.hasTeamIssueItem(directoryId, teamId, issueId)
      ) {
        throw new ProjectDataError(404, 'TeamIssueNotFound', 'Issue was not found.')
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
  ) {
    await this.ensureLocalTables()
    await this.getRequiredTeamIssueItem(directoryId, teamId, issueId)

    const createdAt = new Date().toISOString()
    const item = await this.putIssueEvent({
      directoryId,
      teamId,
      issueId,
      eventType: 'commented',
      actorUserId,
      body: readRequiredCommentBody(input.body),
      summary: 'Comment was added.',
      createdAt,
    })

    return {
      comment: toTeamIssueCommentResponseItem(item),
      activity: toTeamIssueActivityResponseItem(item),
    } satisfies CreateTeamIssueCommentResponse
  }

  private async hasTeamIssueItem(directoryId: string, teamId: string, issueId: string) {
    try {
      await this.getRequiredTeamIssueItem(directoryId, teamId, issueId)

      return true
    } catch (error) {
      if (error instanceof ProjectDataError && error.code === 'TeamIssueNotFound') {
        return false
      }

      throw error
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

  constructor(
    tableName =
      getEnv('MUKUROJI_PROJECT_DIRECTORY_TABLE') ??
      getEnv('PROJECT_DIRECTORY_TABLE_NAME') ??
      'mukuroji-project-directory-local',
    documentClient = createDynamoDbDocumentClient(),
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTables = dynamoDbClient === undefined && shouldBootstrapLocalDynamoDb(),
  ) {
    this.tableName = tableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
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
      const items = await this.readValidDirectoryItems(directoryId)

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
  ) {
    const normalizedMemberKey = normalizeProjectMemberKey(memberKey)
    const email = readProjectMemberEmail(input.email, normalizedMemberKey)
    const name = readOptionalProjectMemberName(input.name)
    const role = readProjectRole(input.role)

    try {
      const items = await this.readValidDirectoryItems(directoryId)
      this.requireActiveProject(items, projectId)
      const existingMember = items.find((item) =>
        item.entryType === 'project-member' &&
        item.projectId === projectId &&
        item.memberKey === normalizedMemberKey,
      )

      const guardManager = (
        existingMember?.role === 'manager' &&
        role !== 'manager'
      )
        ? this.requireAnotherProjectManager(items, projectId, normalizedMemberKey)
        : undefined

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

      if (guardManager) {
        try {
          await this.documentClient.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  ConditionCheck: this.createProjectManagerConditionCheck(directoryId, guardManager.entryKey),
                },
                {
                  Put: {
                    TableName: this.tableName,
                    Item: item,
                  },
                },
              ],
            }),
          )
        } catch (error) {
          if (isAwsNamedError(error, 'TransactionCanceledException')) {
            await this.throwProjectManagerTransactionCancellationResult(
              directoryId,
              projectId,
              normalizedMemberKey,
              error,
            )
          }

          throw error
        }
      } else {
        await this.documentClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: item,
          }),
        )
      }

      return {
        member: toProjectMemberResponseItem(item),
      } satisfies UpdateProjectMemberResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB から project member role を削除します。
   */
  async removeProjectMember(directoryId: string, projectId: string, memberKey: string) {
    const normalizedMemberKey = normalizeProjectMemberKey(memberKey)

    try {
      const items = await this.readValidDirectoryItems(directoryId)
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

      if (guardManager) {
        try {
          await this.documentClient.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  ConditionCheck: this.createProjectManagerConditionCheck(directoryId, guardManager.entryKey),
                },
                {
                  Delete: {
                    TableName: this.tableName,
                    Key: {
                      directoryId,
                      entryKey: member.entryKey,
                    },
                    ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey)',
                  },
                },
              ],
            }),
          )
        } catch (error) {
          if (isAwsNamedError(error, 'TransactionCanceledException')) {
            await this.throwProjectManagerTransactionCancellationResult(
              directoryId,
              projectId,
              normalizedMemberKey,
              error,
            )
          }

          throw error
        }
      } else {
        await this.documentClient.send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: {
              directoryId,
              entryKey: member.entryKey,
            },
            ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey)',
          }),
        )
      }

      return {
        projectId,
        memberId: normalizedMemberKey,
      } satisfies RemoveProjectMemberResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB にチームを作成します。
   */
  async createTeam(directoryId: string, input: CreateTeamRequestBody) {
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

      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        }),
      )

      return {
        team: {
          id: item.teamId,
          name: item.nameJa,
          expanded: item.expanded ?? false,
          projects: [],
        },
      } satisfies CreateTeamResponse
    } catch (error) {
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
  ) {
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
            ],
          }),
        )
      } catch (error) {
        if (isAwsNamedError(error, 'TransactionCanceledException')) {
          await this.throwCreateProjectTransactionCancellationResult(directoryId, teamId, error)
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
  async archiveTeam(directoryId: string, teamId: string) {
    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const team = items.find((item) =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      const archivedAt = new Date().toISOString()

      await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: {
            directoryId,
            entryKey: team.entryKey,
          },
          UpdateExpression: 'SET archivedAt = :archivedAt',
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
          ExpressionAttributeValues: {
            ':archivedAt': archivedAt,
          },
        }),
      )

      return {
        teamId,
        archivedAt,
      } satisfies ArchiveTeamResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
   */
  async archiveProject(directoryId: string, teamId: string, projectId: string) {
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

      await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: {
            directoryId,
            entryKey: project.entryKey,
          },
          UpdateExpression: 'SET archivedAt = :archivedAt',
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
          ExpressionAttributeValues: {
            ':archivedAt': archivedAt,
          },
        }),
      )

      return {
        teamId,
        projectId,
        archivedAt,
      } satisfies ArchiveProjectResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * directory partition 内の全 item を検証済み item として取得します。
   */
  private async readValidDirectoryItems(directoryId: string) {
    return this.queryDirectoryItems(directoryId).then((items) =>
      items.map((item) => {
        if (!isProjectDirectoryItem(item, directoryId)) {
          throw new ProjectDataError(
            503,
            'InvalidProjectDirectory',
            'Project directory item is missing or invalid.',
          )
        }

        return item
      }),
    )
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
    const items = await this.readValidDirectoryItems(directoryId)
    const activeTeam = items.find((item) =>
      item.entryType === 'team' &&
      item.teamId === teamId &&
      isActiveDirectoryItem(item),
    )

    if (!activeTeam) {
      throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
    }

    throw originalError
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
    const items = await this.readValidDirectoryItems(directoryId)
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

    throw originalError
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
  private async queryDirectoryItems(directoryId: string, canBootstrapLocalTable = true) {
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
        return this.queryDirectoryItems(directoryId, false)
      }

      throw error
    }
  }
}

/**
 * Floci Cognito との通信で扱う domain error です。
 */
class CognitoServiceError extends Error {
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

function isCognitoUserInDirectory(user: CognitoUserRecord, directoryId: string | undefined) {
  if (!directoryId) {
    return true
  }

  return projectDirectoryIdAttributeNames.some((attributeName) => {
    return readCognitoUserAttribute(user, attributeName)?.trim() === directoryId
  })
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function createDynamoDbClient() {
  const endpoint = getDynamoDbEndpoint()

  return new DynamoDBClient({
    region: getAwsRegion(),
    endpoint,
    credentials: {
      accessKeyId: getEnv('AWS_ACCESS_KEY_ID') ?? 'test',
      secretAccessKey: getEnv('AWS_SECRET_ACCESS_KEY') ?? 'test',
    },
  })
}

function createDynamoDbDocumentClient() {
  return DynamoDBDocumentClient.from(createDynamoDbClient(), {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  })
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

  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|floci)(?::|\/|$)/.test(endpoint)
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

function toProjectDirectoryResponse(
  values: unknown[],
  locale: Locale,
  directoryId: string,
): ProjectDirectoryTeamResponse[] {
  const teams: ProjectDirectoryTeamResponse[] = []
  const teamById = new Map<string, ProjectDirectoryTeamResponse>()
  const projectItems: ProjectDirectoryItem[] = []

  for (const value of values) {
    if (!isProjectDirectoryItem(value, directoryId)) {
      throw new ProjectDataError(
        503,
        'InvalidProjectDirectory',
        'Project directory item is missing or invalid.',
      )
    }

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
  const directoryId = readProjectDirectoryId(user) ?? `${projectDirectoryIdPrefix}${normalizedUserKey}`
  const groups = readCognitoGroups(accessToken)

  return {
    directoryId,
    userKey: normalizedUserKey,
    isSystemAdmin: groups.some((group) => getSystemAdminGroups().includes(group)),
    groups,
  }
}

function readUserAttribute(user: GetUserResponse, name: string) {
  return user.UserAttributes?.find((attribute) => attribute.Name === name)?.Value
}

function readProjectDirectoryId(user: GetUserResponse) {
  for (const attributeName of projectDirectoryIdAttributeNames) {
    const value = readUserAttribute(user, attributeName)

    if (value?.trim()) {
      return value.trim()
    }
  }

  return undefined
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

function createDirectoryProjectId(directoryId: string, projectId: string) {
  return `${directoryId}#project#${projectId}`
}

function createTeamIssueEventId(createdAt: string, eventType: TeamIssueActivityType) {
  return `${createdAt}#${eventType}#${Math.random().toString(36).slice(2, 10)}`
}

function getAwsRegion() {
  return getEnv('AWS_REGION') ?? getEnv('AWS_DEFAULT_REGION') ?? 'us-east-1'
}

function getDynamoDbEndpoint() {
  return getEnv('DYNAMODB_ENDPOINT') ?? getEnv('AWS_ENDPOINT_URL') ?? 'http://localhost:4566'
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

cognito = new FlociCognitoClient()
dashboardSummary = new DynamoDbDashboardSummaryClient()
projectTasks = new DynamoDbProjectTasksClient()
teamIssues = new DynamoDbTeamIssuesClient()
projectDirectory = new DynamoDbProjectDirectoryClient()

/**
 * Server test で外部 service client を差し替えます。
 */
export function configureApiClientsForTest(clients: {
  cognito?: CognitoClient
  dashboardSummary?: DashboardSummaryClient
  projectTasks?: ProjectTasksClient
  teamIssues?: TeamIssuesClient
  projectDirectory?: ProjectDirectoryClient
}) {
  cognito = clients.cognito ?? cognito
  dashboardSummary = clients.dashboardSummary ?? dashboardSummary
  projectTasks = clients.projectTasks ?? projectTasks
  teamIssues = clients.teamIssues ?? teamIssues
  projectDirectory = clients.projectDirectory ?? projectDirectory
}

/**
 * Server test 後に外部 service client を実装 client に戻します。
 */
export function resetApiClientsForTest() {
  cognito = new FlociCognitoClient()
  dashboardSummary = new DynamoDbDashboardSummaryClient()
  projectTasks = new DynamoDbProjectTasksClient()
  teamIssues = new DynamoDbTeamIssuesClient()
  projectDirectory = new DynamoDbProjectDirectoryClient()
}

/**
 * AWS Lambda にデプロイする Hono handler です。
 */
export const handler = handle(app)

/**
 * Bun のローカル開発サーバー entrypoint です。
 */
export default {
  port: Number(getEnv('PORT') ?? 3000),
  fetch: app.fetch,
}
