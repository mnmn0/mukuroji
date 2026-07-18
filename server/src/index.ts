import { createHash, randomUUID } from 'node:crypto'
import {
  AdminCreateUserCommand,
  AdminDeleteUserAttributesCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  GetUserCommand,
  InitiateAuthCommand,
  ListUsersCommand,
  RespondToAuthChallengeCommand,
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
} from '@aws-sdk/lib-dynamodb'
import {
  PUBLIC_API_OPENAPI_DOCUMENT,
  PLANNING_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type AutomationAction,
  type AutomationExecutionStatus,
  type AutomationTemplateApplication,
  type AutomationValue,
  type BulkOperation,
  type BulkOperationItemResult,
  type BulkOperationPreview,
  type BulkOperationRequest,
  type ApprovalSummary,
  type ApiProblem,
  type CanonicalWorkItem,
  type CreateWorkItemInput,
  type CreatePlanningDependencyInput,
  type CreatePlanningEntityInput,
  type CreateSavedWorkspaceViewInput,
  type CreateRequestFormInput,
  type CustomFieldDefinition,
  type PublishRequestFormInput,
  type RequestFormDraft,
  type RequestFormField,
  type RequestFormRoutingTarget,
  type RequestSubmissionEvent,
  type RequestSubmissionActionInput,
  type RequestRequesterReplyInput,
  type RequestAttachmentUploadInput,
  type SubmitRequestInput,
  type UpdateRequestFormInput,
  type CustomFieldValue,
  type CycleRolloverInput,
  type DuplicatePlanningEntityInput,
  type MovePlanningEntityInput,
  type PlanningEntity,
  type PlanningRevisionInput,
  type PlanningStatusUpdateInput,
  type PlanningWorkItemLinkInput,
  type PlanningWorkItemSummary,
  type ResolvedWorkItemConfiguration,
  type ImportDryRunReport,
  type ImportReport,
  type ImportRowError,
  type UpdateAutomationRuleInput,
  type UpdateAutomationTemplateInput,
  type UpdateRecurringWorkInput,
  type UpdatePlanningEntityInput,
  type UpdateSavedWorkspaceViewInput,
  type WorkItemConfiguration,
  type WorkItemPriority,
  type WorkItemRelation,
  type WorkItemRelationMutationResponse,
  type WorkItemRelationType,
  type WorkItemStatus,
  type WorkspaceSearchFilters,
  type WorkflowStatusCategory,
} from '@mukuroji/contracts'
import { Hono } from 'hono'
import { getConnInfo, handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda'
import { cors } from 'hono/cors'
import type { Context } from 'hono'
import {
  auditEventsToNdjson,
  createAuditEvent,
  createAuditEventId,
  createAuditEventTransactPut,
  createAuditFieldChanges,
  createMutationAuditContext,
  createMutationAuditEventPut,
  createRequestFingerprint,
  calculateAuditExpiresAt,
  DynamoDbAuditEventsClient,
  ensureLocalAuditEventsTable,
  getConfiguredAuditTableName,
  getConfiguredDynamoDbEndpoint,
  toAuditEventView,
  type AuditEventEntityType,
  type AuditEventPage,
  type AuditEventQuery,
  type AuditEventV1,
  type MutationAuditContext,
  type MutationAuditEventInput,
} from './audit'
import { isCanonicalWorkItemRecord } from './canonical-work-item'
import {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
  isWorkspaceIdentitySafeToDelete,
  type WorkspaceAccessClient,
  type WorkspaceIdentityOwnership,
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
  type FileApprovalCompletionTransition,
  type FileApprovalCompletionTransitionResolver,
  type ListReviewerApprovalsOptions,
  type ReviewerApprovalPage,
} from './file-proofing'
import {
  DynamoDbNotificationsClient,
  NotificationError,
  type NotificationAction,
  type NotificationClient,
  type NotificationFilter,
  type NotificationItem,
  type UpdateNotificationPreferencesInput,
} from './notifications'
import {
  createCommentWorkspaceSearchDocument,
  DynamoDbWorkspaceSearchClient,
  WorkspaceSearchError,
  createProjectWorkspaceSearchDocument,
  createTeamWorkspaceSearchDocument,
  createWorkItemWorkspaceSearchDocument,
  type SavedViewAccessScope,
  type WorkspaceSearchAccessScope,
  type WorkspaceSearchClient,
  type WorkspaceSearchDocument,
} from './workspace-search'
import {
  RequestIntakeError,
  createRequestSubmissionEventProjection,
  createRequestSubmissionEventTransactionPut,
  createDefaultRequestIntakeClient,
  createRequestWorkItemInput,
  type RequestExternalContext,
  type RequestIntakeClient,
  type RequestLinkResolution,
} from './request-intake'
import {
  DEFAULT_WORK_ITEM_CONFIGURATION,
  DynamoDbWorkItemConfigurationClient,
  WorkItemConfigurationError,
  assertWorkflowTransitionAllowed,
  createWorkItemConfigurationGuardConditionChecks,
  createWorkItemRelationIds,
  normalizeCustomFieldValues,
  resolveWorkflowStatus,
  validateWorkItemConfiguration,
  type MutateWorkItemRelationInput,
  type WorkItemConfigurationClient,
} from './work-item-configuration'
import {
  AUTOMATION_TEMPLATE_APPLICATION_LEASE_MS,
  AutomationEngine,
  AutomationError,
  DynamoDbAutomationClient,
  applyBulkOperation,
  normalizeAutomationActionFailure,
  previewBulkOperation,
  retryBulkOperation,
  toAutomationInboundWebhookEndpoint,
  undoBulkOperation,
  validateCreateAutomationRuleInput,
  validateCreateAutomationTemplateInput,
  validateApplyAutomationTemplateInput,
  validateAutomationInboundWebhookLifecycleInput,
  validateCreateAutomationInboundWebhookEndpointInput,
  validateCreateRecurringWorkInput,
  validateUpdateAutomationInboundWebhookEndpointInput,
  isAutomationValue,
  type AutomationActionExecutionContext,
  type AutomationActionExecutor,
  type AutomationClient,
  type AutomationEvent,
  type AutomationInboundWebhookEndpointRecord,
  type AutomationInboundWebhookProvisioning,
  type BulkOperationAdapter,
} from './automation'
import {
  SecretsManagerAutomationInboundWebhookSecretStore,
  isAutomationInboundWebhookJsonContentType,
  parseAutomationInboundWebhookJson,
  readAutomationInboundWebhookBody,
  readAutomationInboundWebhookTimestamp,
  verifyAutomationInboundWebhookSignature,
  type AutomationInboundWebhookSecretReference,
  type AutomationInboundWebhookSecretStore,
} from './automation-inbound-webhook'
import { deliverAutomationWebhook } from './automation-webhook'
import {
  DynamoDbPlanningClient,
  InMemoryPlanningClient,
  PlanningError,
  type PlanningClient,
  type PlanningWorkItemState,
} from './planning'
import {
  createDefaultSecretProtector,
  DynamoDbDeveloperPlatformClient,
  type AuthenticatedDeveloperCredential,
  type DeveloperPlatformClient,
  type IdempotencyCompletionTransactWrite,
  type IdempotencyMutationToken,
  type WorkItemDeletionFenceTransactWrite,
} from './developer-platform'
import {
  ConnectorAuthorizationRuntime,
  createConnectorConflictRuntime,
  type ConnectorOAuthCallbackAuthorizer,
} from './connector-authorization-runtime'
import {
  ConnectorRuntimeError,
  createOAuthConnectorRegistryFromEnvironment,
} from './connector-oauth'
import {
  createConnectorRuntimeCache,
  loadConnectorRuntimeEnvironment,
} from './connector-runtime-configuration'
import {
  ConnectorOAuthStateManager,
  createDynamoDbConnectorOAuthStateStoreFromEnvironment,
} from './connector-oauth-state'
import { createDynamoDbConnectorSyncPersistenceFromEnvironment } from './connector-sync-persistence'
import {
  ConnectorSyncEngine,
  type ConnectorSyncHealthReporter,
  type ConnectorWorkItemGateway,
  type ConnectorWorkItemSnapshot,
} from './connector-sync-runtime'
import {
  createPublicApiRouter,
  PublicApiServiceError,
  type ConnectorAuthorizationService,
  type DeveloperManagementPrincipal,
  type PublicApiDependencies,
  type PublicImportSourceInput,
  type PublicMutationContext,
  type PublicWorkItemService,
} from './public-api'
import {
  createWorkItemExport,
  previewWorkItemImport,
  WorkItemTransferError,
} from './work-item-transfer'
import { queueWebhookDeliveryMessage } from './webhook-handler'
import {
  createDefaultWorkItemImportExecutionStore,
  createDefaultWorkItemImportQueue,
  createDefaultWorkItemImportSourceStore,
} from './work-item-import-aws'
import {
  WorkItemImportError,
  createStoredWorkItemImportReport,
  createWorkItemImportJobId,
  processWorkItemImportBatch,
  requestWorkItemImportCancellation,
  stageWorkItemImport,
  type WorkItemImportExecution,
  type WorkItemImportExecutionStore,
  type WorkItemImportQueue,
  type WorkItemImportSourceStore,
  type WorkItemImportSqsEvent,
  type WorkItemImportWorkerDependencies,
} from './work-item-import'

/**
 * Workspace access の永続化 client と API error です。
 */
export {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
} from './workspace-access'
/**
 * Workspace access API で公開する型です。
 */
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
  /** Cognito の `sub` attribute から取得した安定 identity ID です。 */
  identityId?: string
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
  /**
   * 既存 identity へ directory claim を書く直前に補償責務を永続化します。
   */
  beforeDirectoryClaimUpdate: (
    cognitoIdentityId: string,
    cognitoUsername: string,
  ) => Promise<void>
}

/**
 * Cognito invitation provisioning の結果です。
 */
type ProvisionCognitoWorkspaceUserResult = {
  /**
   * invitation と紐付く Cognito user profile です。
   */
  profile: CognitoUserProfile
  /** provisioning 対象となった Cognito identity の安定 ID です。 */
  cognitoIdentityId: string
  /** provisioning 対象となった大文字小文字を保持した Cognito username です。 */
  cognitoUsername: string
  /**
   * Cognito identity が Workspace によって新規作成されたかどうかです。
   */
  identityOwnership: WorkspaceIdentityOwnership
  /**
   * この provisioning が既存 identity に Workspace directory claim を追加したかどうかです。
   */
  directoryClaimCleanupRequired: boolean
  /**
   * Cognito が invitation message を配信したかどうかです。
   */
  deliveryStatus: 'sent' | 'not-required'
}

/**
 * revoke 時に Cognito identity を検索して補償する入力です。
 */
type CognitoWorkspaceUserCleanupInput = {
  /**
   * invitation の宛先として検索する Cognito user ID です。
   */
  userId: string
  /**
   * 削除対象 claim の Workspace directory ID です。
   */
  directoryId: string
  /** provisioning 時に保存した Cognito identity の安定 ID です。 */
  cognitoIdentityId: string
  /** provisioning 時に保存した大文字小文字を保持した Cognito username です。 */
  cognitoUsername: string
}

/** Cognito user 削除処理の安全な結果です。 */
type DeleteCognitoWorkspaceUserResult =
  | 'deleted'
  | 'absent'
  | 'preserved'
  | 'manual-required'

/** Cognito directory claim 解除処理の安全な結果です。 */
type UnlinkCognitoWorkspaceUserResult = 'completed' | 'manual-required'

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

/** 手動 Cognito cleanup 完了確認 API の request body です。 */
type AcknowledgeWorkspaceInvitationCleanupRequestBody = {
  /** optimistic locking に使う current invitation version です。 */
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
  /** 旧 Project task table を保存元とすることを表します。 */
  source: 'legacy'
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
   * canonical Work Item contract の schema version です。
   */
  schemaVersion: typeof WORK_ITEM_SCHEMA_VERSION
  /**
   * optimistic concurrency に使う単調増加 revision です。
   */
  revision: number
  /**
   * Workflow / custom-field 拡張値の schema version です。
   */
  workflowSchemaVersion: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
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
   * 冪等作成時に payload 一致を検証する digest です。
   */
  importRequestDigest?: string
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
   * Issue 作成者の Workspace member key です。
   */
  creatorMemberKey: string
  /** Request intake から作成された場合の source submission ID です。 */
  sourceRequestId?: string
  /** Relation Graph から同期する search/backfill 用の派生 relation ID 一覧です。 */
  relationIds: string[]
  /**
   * 設定済み workflow 内の status ID です。
   */
  workflowStatusId: string
  /**
   * 横断集計に使う workflow status category です。
   */
  statusCategory: WorkflowStatusCategory
  /**
   * Custom field ID ごとの型付き値です。
   */
  customFieldValues: Record<string, CustomFieldValue>
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
  /** Reversible archive を適用した ISO 8601 timestamp です。 */
  archivedAt?: string
  /** Archive mutation を実行した Workspace member key です。 */
  archivedBy?: string
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
type TeamIssueResponseItem = CanonicalWorkItem & {
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
   * Issue 作成者の Workspace member key です。
   */
  creatorMemberKey: string
}

/**
 * Workspace 横断 Work Item API が返す response body です。
 */
type WorkItemsResponse = {
  /**
   * 現在ユーザーが参照できる canonical Work Item 一覧です。
   */
  workItems: TeamIssueResponseItem[]
}

/** Work Item 一覧 client の読み込み量を制御します。 */
type WorkItemListReadOptions = {
  /** DynamoDB から読み込む最大 item 数です。 */
  limit?: number
  /** Base table から強整合 read するかどうかです。 */
  consistentRead?: boolean
  /** Archive 済み Work Item を内部管理 read に含めます。 */
  includeArchived?: boolean
}

/**
 * `/api/work-items` は既存の `{ workItems }` 契約を維持するため cursor を追加せず、
 * pagination 契約を導入するまで hard cap 超過を 413 で fail-closed にします。
 * この値は一度に返す Work Item の最大件数です。
 */
const WORK_ITEMS_RESPONSE_LIMIT = 200
/** `/api/work-items` が一度に読む Team partition の最大数です。 */
const WORK_ITEMS_TEAM_READ_LIMIT = 20
/** `/api/work-items` が 1 partition で filter/dedupe 前に評価する最大 item 数です。 */
const WORK_ITEMS_PARTITION_SCAN_LIMIT = 1_000
/** Relation target の強整合 detail read を同時実行する最大数です。 */
const WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY = 8

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
  /** Bounded event 読み込みの次 page を指す opaque cursor です。 */
  nextEventCursor?: string
  /** Work Item に適用される解決済み workflow/custom field 定義です。 */
  resolvedConfiguration?: ResolvedWorkItemConfiguration
  /** Work Item から見た reciprocal relation 一覧です。 */
  relations?: WorkItemRelation[]
  /** Relation mutation の optimistic concurrency に使う graph revision です。 */
  relationGraphRevision?: number
}

/**
 * チーム Issue 作成 API が受け取る request body です。
 */
type CreateTeamIssueRequestBody = {
  /** Internal automation create action が再配送間で固定する resource ID です。 */
  idempotencyResourceId?: unknown
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
   * 期限日として保存する文字列です。
   */
  dueDate?: unknown
  /**
   * 優先度です。
   */
  priority?: unknown
  /**
   * 設定済み workflow 内の status ID です。
   */
  workflowStatusId?: unknown
  /**
   * Custom field ID ごとの型付き値です。
   */
  customFieldValues?: unknown
  /** API handler が検証後に付与する workflow extension schema version です。 */
  workflowSchemaVersion?: unknown
  /** API handler が検証後に付与する workflow status category です。 */
  statusCategory?: unknown
  /** API handler が definition の同時変更を検出するために付与する ConditionCheck です。 */
  configurationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>
  /** Import worker または public API の冪等作成で固定する Work Item ID です。 */
  idempotentIssueId?: string
  /** 既存 row と同一 request か検証する SHA-256 digest です。 */
  idempotentRequestDigest?: string
}

/** Trusted request conversion handler が Work Item transactionへ追加する narrow projection です。 */
type RequestConversionTransactionInput = {
  /** Request intake table 名です。 */
  tableName: string
  /** Submission の Workspace partition key です。 */
  scopeKey: string
  /** Submission row sort key です。 */
  recordKey: string
  /** 読み込み時点の submission revision です。 */
  expectedRevision: number
  /** Conversion event の actor member ID です。 */
  actorId: string
  /** Work Item に保存する source submission ID です。 */
  submissionId: string
  /** Mutation 前に読み込んだ append-only event 履歴です。 */
  events: readonly RequestSubmissionEvent[]
}

/**
 * 公開チーム Issue 更新 API が受け取る request body です。
 */
type PublicUpdateTeamIssueRequestBody = {
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
   * 期限日として保存する文字列です。
   */
  dueDate?: unknown
  /**
   * 優先度です。
   */
  priority?: unknown
  /**
   * 設定済み workflow 内の status ID です。
   */
  workflowStatusId?: unknown
  /**
   * Custom field ID ごとの型付き値です。null は保存済み値の削除を表します。
   */
  customFieldValues?: unknown
}

/**
 * 検証済みの設定値と内部 adapter 専用フィールドを含むチーム Issue 更新入力です。
 */
type UpdateTeamIssueRequestBody = PublicUpdateTeamIssueRequestBody & {
  /** API handler が検証後に付与する workflow extension schema version です。 */
  workflowSchemaVersion?: unknown
  /** API handler が検証後に付与する workflow status category です。 */
  statusCategory?: unknown
  /** API handler が definition の同時変更を検出するために付与する ConditionCheck です。 */
  configurationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>
  /** Internal bulk operation が設定または解除する archive timestamp です。 */
  archivedAt?: unknown
  /** Internal bulk operation が記録する archive actor member key です。 */
  archivedBy?: unknown
}

/**
 * チーム Issue コメント作成 API が受け取る request body です。
 */
type CreateTeamIssueCommentRequestBody = {
  /** Internal automation comment action が再配送間で固定する event ID です。 */
  idempotencyEventId?: unknown
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
  /** Internal template application が response-loss retry 間で固定する Project ID です。 */
  idempotencyResourceId?: unknown
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
   * Workspace が作成した未確定 Cognito username へ invitation を再送します。
   */
  resendWorkspaceUserInvitation(username: string): Promise<void>
  /**
   * Workspace が作成した未確定 user だけを削除します。
   */
  deleteWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<DeleteCognitoWorkspaceUserResult>
  /**
   * invitation が追加した Workspace directory claim を解除します。
   */
  unlinkWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<UnlinkCognitoWorkspaceUserResult>
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
}

/** Work Item domain write と public response receipt を同じ transaction に追加する境界です。 */
type WorkItemIdempotencyTransaction = {
  /** Exact HTTP response を encrypted receipt transaction item に変換します。 */
  prepare(
    response: { /** HTTP status です。 */ status: 200 | 204; /** Replay body です。 */ body: unknown },
  ): Promise<IdempotencyCompletionTransactWrite | undefined>
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
    auditContext?: MutationAuditContext,
    requestConversion?: RequestConversionTransactionInput,
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
    idempotency?: WorkItemIdempotencyTransaction,
  ): Promise<UpdateTeamIssueResponse>
  /**
   * DynamoDB の canonical Work Item を revision 条件付きで削除します。
   */
  deleteTeamIssue?(
    directoryId: string,
    teamId: string,
    issueId: string,
    expectedRevision: number,
    actorUserId: string,
    auditContext?: MutationAuditContext,
    idempotency?: WorkItemIdempotencyTransaction,
    deletionFence?: WorkItemDeletionFenceTransactWrite,
  ): Promise<{ issue: TeamIssueResponseItem }>
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
  getProjectDirectory(
    directoryId: string,
    locale: Locale,
    consistentRead?: boolean,
  ): Promise<ProjectDirectoryResponse>
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
    completionTransactItems?: NonNullable<TransactWriteCommandInput['TransactItems']>,
  ): Promise<CreateProjectResponse>
  /**
   * DynamoDB 上のチームをアーカイブします。
   */
  archiveTeam(
    directoryId: string,
    teamId: string,
    auditContext: MutationAuditContext | undefined,
    expectedPlanningRevision: number,
  ): Promise<ArchiveTeamResponse>
  /**
   * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
   */
  archiveProject(
    directoryId: string,
    teamId: string,
    projectId: string,
    auditContext: MutationAuditContext | undefined,
    expectedPlanningRevision: number,
  ): Promise<ArchiveProjectResponse>
}

/**
 * API handler から利用する append-only audit event query client です。
 */
type AuditEventsClient = {
  /**
   * Deterministic ID の event を強整合読みで返します。
   */
  getEvent(workspaceId: string, eventId: string): Promise<AuditEventV1 | undefined>
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
let notifications: NotificationClient
let workspaceSearch: WorkspaceSearchClient
let workspaceSearchProjectionEnabled: boolean
let workItemConfigurations: WorkItemConfigurationClient
let automation: AutomationClient
let automationInboundWebhookSecrets: AutomationInboundWebhookSecretStore
let planning: PlanningClient
let developerPlatform: DeveloperPlatformClient
let publicWorkItems: PublicWorkItemService
let workItemImportExecutions: WorkItemImportExecutionStore
let workItemImportSources: WorkItemImportSourceStore
let workItemImportQueue: WorkItemImportQueue
let requestIntake: RequestIntakeClient
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
    allowHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Correlation-Id',
      'X-Request-Id',
    ],
    exposeHeaders: ['X-Audit-Truncated', 'X-Audit-Next-Cursor'],
  }),
)

app.use('/api/*', async (c, next) => {
  await next()
  if (c.req.path.startsWith('/api/request-')) {
    c.header('Cache-Control', 'private, no-store')
    c.header('Pragma', 'no-cache')
    c.header('Referrer-Policy', 'no-referrer')
  }
})

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

    return c.json(await createAuthenticationResponse(tokens, c, { email }))
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
    const acceptanceState = await acquireNewPasswordChallengeInvitationLock(c, email)

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

      return c.json(await createAuthenticationResponse(
        tokens,
        c,
        { email },
        acceptanceState?.auditContext,
      ))
    } finally {
      await releaseNewPasswordChallengeInvitationLock(acceptanceState)
    }
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return toWorkspaceAccessErrorResponse(c, error)
    }

    return toNewPasswordChallengeErrorResponse(c, error)
  }
})

async function acquireNewPasswordChallengeInvitationLock(c: Context, email: string) {
  const workspaceUser = await cognito.findWorkspaceUser(email)

  if (!workspaceUser?.directoryId) {
    return undefined
  }

  const activeMember = await workspaceAccess.getActiveMember(
    workspaceUser.directoryId,
    workspaceUser.profile.id,
  )
  const auditContext = createWorkspaceMutationContextForActor(
    c,
    workspaceUser.directoryId,
    workspaceUser.identityId ?? workspaceUser.profile.username ?? workspaceUser.profile.id,
    workspaceUser.profile.email,
    { email },
  )

  if (activeMember) {
    return { auditContext }
  }

  const invitation = await workspaceAccess.acquireInvitationAcceptanceLock(
    workspaceUser.directoryId,
    email,
    auditContext,
  )

  return {
    auditContext,
    ...(invitation ? { directoryId: workspaceUser.directoryId, invitation } : {}),
  }
}

async function releaseNewPasswordChallengeInvitationLock(
  state: {
    auditContext: MutationAuditContext
    directoryId?: string
    invitation?: WorkspaceInvitation
  } | undefined,
) {
  if (!state?.directoryId || !state.invitation) {
    return
  }

  try {
    await workspaceAccess.releaseInvitationAcceptanceLock(
      state.directoryId,
      state.invitation.id,
      state.invitation.version,
      state.auditContext,
    )
  } catch (error) {
    console.error('Failed to release Workspace invitation acceptance lock:', error)
  }
}

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
    const auditContext = createWorkspaceMutationContext(c, principal, { email, name, role })
    const invitation = await workspaceAccess.createInvitation(
      principal.directoryId,
      principal.userKey,
      {
        email,
        name,
        role,
      },
      undefined,
      auditContext,
    )

    const deliveryState = { invitation }

    try {
      const result = await deliverPreparedWorkspaceInvitation(
        principal.directoryId,
        deliveryState,
        false,
        auditContext,
      )
      deliveryState.invitation = {
        ...deliveryState.invitation,
        identityOwnership: result.identityOwnership,
        cognitoIdentityId: result.cognitoIdentityId,
        cognitoUsername: result.cognitoUsername,
        directoryClaimCleanupRequired: result.directoryClaimCleanupRequired || undefined,
      }
      const deliveredInvitation = await workspaceAccess.markInvitationDelivery(
        principal.directoryId,
        deliveryState.invitation.id,
        {
          expectedVersion: deliveryState.invitation.version,
          identityOwnership: result.identityOwnership,
          cognitoIdentityId: result.cognitoIdentityId,
          cognitoUsername: result.cognitoUsername,
          directoryClaimCleanupRequired: result.directoryClaimCleanupRequired,
          deliveryStatus: result.deliveryStatus,
        },
        auditContext,
      )

      return c.json({ invitation: deliveredInvitation }, 201)
    } catch (error) {
      await markWorkspaceInvitationFailure(
        principal.directoryId,
        deliveryState.invitation,
        error,
        auditContext,
      )
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
    const auditContext = createWorkspaceMutationContext(c, principal, { invitationId })
    let invitation = await workspaceAccess.revokeInvitation(
      principal.directoryId,
      principal.userKey,
      invitationId,
      auditContext,
    )

    if (
      !invitation.identityCleanupCompleted &&
      (
        invitation.identityCleanupManualRequired === true ||
        isWorkspaceIdentitySafeToDelete(invitation.identityOwnership) ||
        invitation.directoryClaimCleanupRequired === true
      )
    ) {
      const cognitoIdentityId = invitation.cognitoIdentityId?.trim()
      const cognitoUsername = invitation.cognitoUsername?.trim()
      let cleanupCompleted = false
      let manualCleanupRequired = false

      try {
        if (cognitoIdentityId && cognitoUsername) {
          const cleanupInput = {
            userId: invitation.email,
            directoryId: principal.directoryId,
            cognitoIdentityId,
            cognitoUsername,
          }

          if (isWorkspaceIdentitySafeToDelete(invitation.identityOwnership)) {
            const deletionResult = await cognito.deleteWorkspaceUser(cleanupInput)

            if (deletionResult === 'manual-required') {
              manualCleanupRequired = true
            } else if (deletionResult === 'preserved') {
              manualCleanupRequired = await cognito.unlinkWorkspaceUser(cleanupInput) ===
                'manual-required'
            }
          } else {
            manualCleanupRequired = await cognito.unlinkWorkspaceUser(cleanupInput) ===
              'manual-required'
          }
          cleanupCompleted = !manualCleanupRequired
        } else {
          manualCleanupRequired = true
        }
      } catch (error) {
        try {
          await workspaceAccess.markInvitationCleanupFailure(
            principal.directoryId,
            invitation.id,
            {
              expectedVersion: invitation.version,
              failureMessage: 'Cognito cleanup failed and can be retried safely.',
            },
            auditContext,
          )
        } catch (markError) {
          console.error('Failed to persist Workspace invitation cleanup failure:', markError)
        }

        throw error
      }

      if (manualCleanupRequired) {
        invitation = await workspaceAccess.markInvitationManualCleanupRequired(
          principal.directoryId,
          invitation.id,
          invitation.version,
          auditContext,
        )
      } else if (cleanupCompleted) {
        invitation = await workspaceAccess.clearInvitationCleanupFailure(
          principal.directoryId,
          invitation.id,
          invitation.version,
          auditContext,
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

/** 手動 Cognito cleanup の完了を管理者が明示確認する endpoint です。 */
app.post('/api/workspace/invitations/:invitationId/cleanup/acknowledge', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceAdministration(principal)
    const invitationId = readWorkspaceEmail(c.req.param('invitationId'))
    const body = await readJson<AcknowledgeWorkspaceInvitationCleanupRequestBody>(c.req)
    const expectedVersion = readWorkspaceVersion(body?.expectedVersion)
    const auditContext = createWorkspaceMutationContext(
      c,
      principal,
      { expectedVersion, invitationId },
    )
    const invitation = await workspaceAccess.acknowledgeInvitationManualCleanup(
      principal.directoryId,
      principal.userKey,
      invitationId,
      expectedVersion,
      auditContext,
    )

    return c.json({ invitation })
  } catch (error) {
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
    const auditContext = createWorkspaceMutationContext(
      c,
      principal,
      { expectedVersion, memberKey, role, status },
    )

    let expectedPlanningRevision: number
    if (status === 'deactivated') {
      await requireWorkspaceMemberHasNoManagedProjects(principal.directoryId, memberKey)
      expectedPlanningRevision = await requireWorkspaceMemberHasNoOwnedPlanningEntities(
        principal.directoryId,
        memberKey,
      )
    } else {
      expectedPlanningRevision = (await planning.getAuthorizationState(principal.directoryId)).revision
    }

    const member = await workspaceAccess.updateMember(
      principal.directoryId,
      principal.userKey,
      memberKey,
      {
        role,
        status,
        expectedVersion,
        expectedPlanningRevision,
      },
      auditContext,
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

/** Recipient の durable notification timeline を cursor 付きで返します。 */
app.get('/api/notifications', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const isVisible = await createNotificationVisibilityFilter(principal)
    const filter = c.req.query('filter') as NotificationFilter | undefined
    const limitValue = c.req.query('limit')
    const input = {
      workspaceId: principal.directoryId,
      memberKey: principal.userKey,
      filter,
      eventType: c.req.query('type')?.trim() || undefined,
      limit: limitValue === undefined ? undefined : Number(limitValue),
      cursor: c.req.query('cursor')?.trim() || undefined,
      isVisible,
    }
    const [page, unreadCount] = await Promise.all([
      notifications.list(input),
      notifications.countUnread({
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
        isVisible,
      }),
    ])

    return c.json({ ...page, unreadCount })
  } catch (error) {
    return toNotificationErrorResponse(c, error)
  }
})

/** Recipient の現在表示可能な unread notification 件数を返します。 */
app.get('/api/notifications/unread-count', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const isVisible = await createNotificationVisibilityFilter(principal)
    const unreadCount = await notifications.countUnread({
      workspaceId: principal.directoryId,
      memberKey: principal.userKey,
      isVisible,
    })
    return c.json({ unreadCount })
  } catch (error) {
    return toNotificationErrorResponse(c, error)
  }
})

/** Recipient のすべての active unread notification を read にします。 */
app.post('/api/notifications/mark-all-read', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const isVisible = await createNotificationVisibilityFilter(principal)
    const updatedCount = await notifications.markAllRead({
      workspaceId: principal.directoryId,
      memberKey: principal.userKey,
      isVisible,
    })
    const unreadCount = await notifications.countUnread({
      workspaceId: principal.directoryId,
      memberKey: principal.userKey,
      isVisible,
    })
    return c.json({ updatedCount, unreadCount })
  } catch (error) {
    return toNotificationErrorResponse(c, error)
  }
})

/** Recipient の notification を read、archive、snooze state へ遷移させます。 */
app.patch('/api/notifications/:notificationId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const isVisible = await createNotificationVisibilityFilter(principal)
    const body = await readJson<Record<string, unknown>>(c.req) ?? {}
    const notification = await notifications.update({
      workspaceId: principal.directoryId,
      memberKey: principal.userKey,
      notificationId: c.req.param('notificationId'),
      action: readNotificationAction(body.action),
      snoozedUntil: readOptionalNotificationTimestamp(body.snoozedUntil),
      isVisible,
    })
    return c.json(notification)
  } catch (error) {
    return toNotificationErrorResponse(c, error)
  }
})

/** Workspace の versioned automation rules を返します。 */
app.get('/api/automation/rules', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    return c.json({ rules: await automation.listRules(principal.directoryId) })
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が automation rule を作成します。 */
app.post('/api/automation/rules', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = validateCreateAutomationRuleInput(await readAutomationJson(c))
    return c.json(await automation.createRule(
      principal.directoryId,
      input,
      c.req.header('Idempotency-Key')?.trim() || undefined,
    ), 201)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が automation rule の新 version を保存します。 */
app.patch('/api/automation/rules/:ruleId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = await readAutomationJson(c) as UpdateAutomationRuleInput
    return c.json(await automation.updateRule(
      principal.directoryId,
      c.req.param('ruleId'),
      input,
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者へ secret を除いた inbound webhook endpoints を返します。 */
app.get('/api/automation/inbound-webhooks', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    return c.json({
      endpoints: await automation.listInboundWebhookEndpoints(principal.directoryId),
    })
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が server-issued inbound webhook endpoint を作成します。 */
app.post('/api/automation/inbound-webhooks', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const idempotencyKey = readRequiredInboundWebhookIdempotencyKey(c)
    const provisioning = await automation.reserveCreateInboundWebhookEndpoint(
      principal.directoryId,
      principal.actorId,
      validateCreateAutomationInboundWebhookEndpointInput(await readAutomationJson(c)),
      idempotencyKey,
      getAutomationInboundWebhookBaseUrl(c),
    )
    const { completed, signingSecret } = await provisionAutomationInboundWebhookEndpoint(
      provisioning,
    )
    return c.json({
      endpoint: toAutomationInboundWebhookEndpoint(completed),
      signingSecret,
    }, 201)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者へ secret を除いた inbound webhook endpoint を返します。 */
app.get('/api/automation/inbound-webhooks/:endpointId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    return c.json(await requireAutomationInboundWebhookEndpoint(
      principal.directoryId,
      c.req.param('endpointId'),
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が inbound webhook endpoint の表示名を更新します。 */
app.patch('/api/automation/inbound-webhooks/:endpointId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    return c.json(await automation.updateInboundWebhookEndpoint(
      principal.directoryId,
      c.req.param('endpointId'),
      validateUpdateAutomationInboundWebhookEndpointInput(await readAutomationJson(c)),
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が inbound webhook endpoint を pause します。 */
app.post('/api/automation/inbound-webhooks/:endpointId/pause', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    return c.json(await automation.setInboundWebhookEndpointStatus(
      principal.directoryId,
      c.req.param('endpointId'),
      validateAutomationInboundWebhookLifecycleInput(await readAutomationJson(c)),
      'paused',
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が inbound webhook endpoint を resume します。 */
app.post('/api/automation/inbound-webhooks/:endpointId/resume', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    return c.json(await automation.setInboundWebhookEndpointStatus(
      principal.directoryId,
      c.req.param('endpointId'),
      validateAutomationInboundWebhookLifecycleInput(await readAutomationJson(c)),
      'active',
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が signing secret generation を rotate します。 */
app.post('/api/automation/inbound-webhooks/:endpointId/rotate', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const idempotencyKey = readRequiredInboundWebhookIdempotencyKey(c)
    const provisioning = await automation.reserveRotateInboundWebhookEndpoint(
      principal.directoryId,
      principal.actorId,
      c.req.param('endpointId'),
      validateAutomationInboundWebhookLifecycleInput(await readAutomationJson(c)),
      idempotencyKey,
    )
    const { completed, signingSecret } = await provisionAutomationInboundWebhookEndpoint(
      provisioning,
    )
    return c.json({
      endpoint: toAutomationInboundWebhookEndpoint(completed),
      signingSecret,
    })
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が inbound webhook endpoint と全 secret generations を revoke します。 */
app.delete('/api/automation/inbound-webhooks/:endpointId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const revoked = await automation.revokeInboundWebhookEndpoint(
      principal.directoryId,
      c.req.param('endpointId'),
      validateAutomationInboundWebhookLifecycleInput(await readAutomationJson(c)),
    )
    await automationInboundWebhookSecrets.delete(
      toAutomationInboundWebhookSecretReference(revoked),
    )
    return c.json(toAutomationInboundWebhookEndpoint(revoked))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** External sender の raw JSON delivery を HMAC 検証して durable outbox event に変換します。 */
app.post('/api/automation/inbound-webhooks/:opaqueEndpointId', async (c) => {
  try {
    const endpoint = await automation.resolveInboundWebhookEndpoint(
      c.req.param('opaqueEndpointId'),
    )
    if (!endpoint || endpoint.status === 'provisioning' || endpoint.status === 'revoked') {
      throw automationInboundWebhookNotFound()
    }
    if (endpoint.status === 'paused') {
      throw new AutomationError(
        423,
        'AutomationInboundWebhookPaused',
        'Inbound webhook endpoint is paused.',
      )
    }
    if (!isAutomationInboundWebhookJsonContentType(c.req.header('Content-Type'))) {
      throw new AutomationError(
        415,
        'AutomationInboundWebhookContentTypeUnsupported',
        'Content-Type must be application/json with optional UTF-8 charset.',
      )
    }

    const idempotencyKey = readRequiredInboundWebhookIdempotencyKey(c)
    const rawBody = await readAutomationInboundWebhookBody(c.req.raw)
    const signatureTimestamp = readAutomationInboundWebhookTimestamp(
      c.req.header('X-Mukuroji-Timestamp'),
    )
    const secretReference = toAutomationInboundWebhookSecretReference(endpoint)
    const signingSecret = await automationInboundWebhookSecrets.get(secretReference)
    const signatureFingerprint = verifyAutomationInboundWebhookSignature(
      signingSecret,
      signatureTimestamp,
      rawBody,
      c.req.header('X-Mukuroji-Signature'),
    )
    const payload = parseAutomationInboundWebhookJson(rawBody)
    if (!isAutomationValue(payload)) {
      throw new AutomationError(
        400,
        'AutomationInboundWebhookJsonInvalid',
        'Request body contains an unsupported JSON value.',
      )
    }

    const auditTableName = getConfiguredAuditTableName()
    if (!auditTableName) throw automationInboundWebhookUnavailable()
    const bodyFingerprint = createHash('sha256').update(rawBody).digest('hex')
    const path = `/api/automation/inbound-webhooks/${endpoint.opaqueEndpointId}`
    const auditContext = createMutationAuditContext({
      workspaceId: endpoint.workspaceId,
      actor: {
        id: `inbound-webhook:${endpoint.id}`,
        kind: 'service',
        displayName: endpoint.name,
      },
      idempotencyKey: createHash('sha256')
        .update(`${endpoint.id}\0${idempotencyKey}`)
        .digest('hex'),
      request: {
        method: 'POST',
        path,
        body: { endpointId: endpoint.id, bodyFingerprint },
      },
      source: {
        kind: 'api',
        requestId: c.req.header('X-Request-Id'),
        method: 'POST',
        route: path,
        ipAddress: c.req.header('X-Forwarded-For')?.split(',')[0]?.trim(),
        userAgent: c.req.header('User-Agent'),
      },
    })
    const event = createAuditEvent({
      context: auditContext,
      eventType: 'webhook.received',
      entity: { type: 'automation-webhook', id: endpoint.id },
      summary: 'Automation webhook was received.',
      metadata: { webhookId: endpoint.id, payload },
      expiresAt: calculateAuditExpiresAt(auditContext.occurredAt, 365),
    })
    const delivery = await automation.recordInboundWebhookDelivery(endpoint, {
      idempotencyKey,
      bodyFingerprint,
      signatureFingerprint,
      signatureTimestamp,
      eventId: event.eventId,
      auditTransactItem: createAuditEventTransactPut(auditTableName, event),
    })
    return c.json({ eventId: delivery.eventId }, 202)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace の versioned automation templates を返します。 */
app.get('/api/automation/templates', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    return c.json({ templates: await automation.listTemplates(principal.directoryId) })
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が automation template を作成します。 */
app.post('/api/automation/templates', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = validateCreateAutomationTemplateInput(await readAutomationJson(c))
    return c.json(await automation.createTemplate(
      principal.directoryId,
      input,
      c.req.header('Idempotency-Key')?.trim() || undefined,
    ), 201)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が automation template の新 version を保存します。 */
app.patch('/api/automation/templates/:templateId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = await readAutomationJson(c) as UpdateAutomationTemplateInput
    return c.json(await automation.updateTemplate(
      principal.directoryId,
      c.req.param('templateId'),
      input,
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が template の current version を複製します。 */
app.post('/api/automation/templates/:templateId/duplicate', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const source = await automation.getTemplate(
      principal.directoryId,
      c.req.param('templateId'),
    )
    if (!source) {
      throw new AutomationError(404, 'AutomationTemplateNotFound', 'Automation template was not found.')
    }
    return c.json(await automation.createTemplate(
      principal.directoryId,
      validateCreateAutomationTemplateInput({
        kind: source.kind,
        name: `${source.name} copy`,
        enabled: source.enabled,
        payload: structuredClone(source.payload),
      }),
      c.req.header('Idempotency-Key')?.trim() || undefined,
    ), 201)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が Project/Workflow template を immutable version pin 付きで適用します。 */
app.post('/api/automation/templates/:templateId/applications', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim()
    if (!idempotencyKey) {
      throw new AutomationError(
        400,
        'AutomationIdempotencyKeyRequired',
        'Idempotency-Key is required for template application.',
      )
    }
    const input = validateApplyAutomationTemplateInput(await readAutomationJson(c))
    if (
      input.target.kind === 'workflow' &&
      input.target.scopeType === 'workspace' &&
      input.target.scopeId !== principal.directoryId
    ) {
      throw new AutomationError(
        400,
        'InvalidAutomationInput',
        'Workspace workflow target must match the authenticated Workspace.',
      )
    }
    if (input.target.kind === 'workflow' && input.target.scopeType === 'team') {
      await requireTeamConfigurationAdministration(principal, input.target.scopeId)
    }
    const application = await automation.reserveTemplateApplication(
      principal.directoryId,
      principal.actorId,
      c.req.param('templateId'),
      input.target,
      idempotencyKey,
    )
    return c.json(await executeAutomationTemplateApplication(c, principal, application))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が durable template application receipt を取得します。 */
app.get('/api/automation/template-applications/:applicationId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const application = await automation.getTemplateApplication(
      principal.directoryId,
      c.req.param('applicationId'),
    )
    if (!application) {
      throw new AutomationError(
        404,
        'AutomationTemplateApplicationNotFound',
        'Template application was not found.',
      )
    }
    return c.json(application)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace の recurring Work 定義を返します。 */
app.get('/api/recurring-work', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    return c.json({ recurringWorks: await automation.listRecurringWorks(principal.directoryId) })
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が recurring Work 定義を作成します。 */
app.post('/api/recurring-work', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = validateCreateRecurringWorkInput(await readAutomationJson(c))
    await requireAutomationTeam(principal.directoryId, input.teamId)
    return c.json(await automation.createRecurringWork(
      principal.directoryId,
      input,
      c.req.header('Idempotency-Key')?.trim() || undefined,
    ), 201)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が recurring Work 定義の新 version を保存します。 */
app.patch('/api/recurring-work/:recurringWorkId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = await readAutomationJson(c) as UpdateRecurringWorkInput
    const current = await automation.getRecurringWork(
      principal.directoryId,
      c.req.param('recurringWorkId'),
    )
    if (!current) {
      throw new AutomationError(404, 'RecurringWorkNotFound', 'Recurring Work definition was not found.')
    }
    await requireAutomationTeam(principal.directoryId, input.teamId ?? current.teamId)
    return c.json(await automation.updateRecurringWork(
      principal.directoryId,
      c.req.param('recurringWorkId'),
      input,
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Automation execution history と partial action state を返します。 */
app.get('/api/automation/executions', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    return c.json(await automation.listExecutions({
      workspaceId: principal.directoryId,
      ruleId: c.req.query('ruleId'),
      status: readAutomationExecutionStatus(c.req.query('status')),
      cursor: c.req.query('cursor'),
      limit: readAutomationPageLimit(c.req.query('limit')),
    }))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が retryable execution を同じ trigger event で再開します。 */
app.post('/api/automation/executions/:executionId/retry', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const executionId = c.req.param('executionId')
    const event = await automation.getExecutionEvent(principal.directoryId, executionId)
    if (!event) {
      throw new AutomationError(404, 'AutomationExecutionNotFound', 'Automation execution was not found.')
    }
    const engine = new AutomationEngine(automation, createAutomationActionExecutor())
    return c.json(await engine.retryExecution(principal.directoryId, executionId, event))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Authenticated form submission を durable automation outbox event に変換します。 */
app.post('/api/automation/forms/:formId/submissions', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    requireWorkspaceBusinessWrite(principal)
    const payload = await readAutomationJson(c)
    const event = await putAutomationIngressEvent(
      c,
      principal,
      c.req.param('formId'),
      { formId: c.req.param('formId'), payload },
    )
    return c.json({ eventId: event.eventId }, 202)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Bulk Work Item mutation を item 単位で検証し、dry-run 結果を返します。 */
app.post('/api/bulk-operations/preview', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    requireWorkspaceBusinessWrite(principal)
    const request = readWorkspaceBulkOperationRequest(
      await readAutomationJson(c),
      principal.directoryId,
    )
    const preview = await previewBulkOperation(
      request,
      createApiBulkOperationAdapter(principal, c),
    )
    return c.json(toBulkOperationPreviewResponse(preview))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Preview token が一致する Bulk Work Item mutation を確定します。 */
app.post('/api/bulk-operations', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    requireWorkspaceBusinessWrite(principal)
    const request = readWorkspaceBulkOperationRequest(
      await readAutomationJson(c),
      principal.directoryId,
    )
    const adapter = createApiBulkOperationAdapter(principal, c)
    const preview = await previewBulkOperation(request, adapter)
    const operation = await applyBulkOperation(
      request,
      preview,
      adapter,
      principal.userKey,
      automation,
    )
    return c.json(toBulkOperationResponse(operation), 201)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Bulk operation の retryable failures だけを安全に再実行します。 */
app.post('/api/bulk-operations/:operationId/retry', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    requireWorkspaceBusinessWrite(principal)
    const operation = await requireBulkOperation(principal.directoryId, c.req.param('operationId'))
    requireBulkOperationOwner(operation, principal.userKey)
    const retried = await retryBulkOperation(
      operation,
      createApiBulkOperationAdapter(principal, c),
      automation,
    )
    return c.json(toBulkOperationResponse(retried))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Bulk operation の成功 item を current revision guard 付きで undo します。 */
app.post('/api/bulk-operations/:operationId/undo', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    requireWorkspaceBusinessWrite(principal)
    const operation = await requireBulkOperation(principal.directoryId, c.req.param('operationId'))
    requireBulkOperationOwner(operation, principal.userKey)
    const undone = await undoBulkOperation(
      operation,
      createApiBulkOperationAdapter(principal, c),
      automation,
    )
    return c.json(toBulkOperationResponse(undone))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Recipient の notification channel、digest、quiet hours 設定を返します。 */
app.get('/api/notification-preferences', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    return c.json(await notifications.getPreferences({
      workspaceId: principal.directoryId,
      memberKey: principal.userKey,
    }))
  } catch (error) {
    return toNotificationErrorResponse(c, error)
  }
})

/** Recipient の notification preference を version 条件付きで保存します。 */
app.put('/api/notification-preferences', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const body = await readJson<Record<string, unknown>>(c.req) ?? {}
    const preferences = await notifications.savePreferences({
      workspaceId: principal.directoryId,
      memberKey: principal.userKey,
      preferences: readNotificationPreferencesInput(body),
    })
    return c.json(preferences)
  } catch (error) {
    return toNotificationErrorResponse(c, error)
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

    const response = await projectDirectory.createTeam(
      principal.directoryId,
      body ?? {},
      createApiMutationContext(c, principal, body ?? {}),
    )
    await projectWorkspaceSearchDocumentBestEffort(
      () => {
        const names = readLocalizedNames(body ?? {})
        return createTeamSearchDocument(
          principal.directoryId,
          response.team,
          principal.userKey,
          names.nameEn === response.team.name ? undefined : names.nameEn,
        )
      },
      'team creation',
    )
    return c.json(response, 201)
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
    const body = await readJson<CreateProjectRequestBody>(c.req) ?? {}
    delete body.idempotencyResourceId

    const response = await projectDirectory.createProject(
      principal.directoryId,
      teamId,
      body,
      {
        userKey: principal.userKey,
        workspaceMemberVersion: principal.workspaceMember.version,
      },
      createApiMutationContext(c, principal, { teamId, ...body }),
    )
    await projectWorkspaceSearchDocumentBestEffort(
      () => {
        const names = readLocalizedNames(body)
        return createProjectSearchDocument(
          principal.directoryId,
          teamId,
          response.project,
          principal.userKey,
          names.nameEn === response.project.name ? undefined : names.nameEn,
        )
      },
      'project creation',
    )
    return c.json(response, 201)
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
    const expectedPlanningRevision = await requirePlanningTeamScopeIsUnused(
      principal.directoryId,
      teamId,
    )

    const response = await projectDirectory.archiveTeam(
      principal.directoryId,
      teamId,
      createApiMutationContext(c, principal, { teamId }),
      expectedPlanningRevision,
    )
    await deleteWorkspaceSearchDocumentBestEffort(
      principal.directoryId,
      'team',
      `team/${teamId}`,
      'team archive',
    )
    return c.json(response)
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
    const expectedPlanningRevision = await requirePlanningProjectScopeIsUnused(
      principal.directoryId,
      teamId,
      projectId,
    )

    const response = await projectDirectory.archiveProject(
      principal.directoryId,
      teamId,
      projectId,
      createApiMutationContext(c, principal, { teamId, projectId }),
      expectedPlanningRevision,
    )
    await deleteWorkspaceSearchDocumentBestEffort(
      principal.directoryId,
      'project',
      `team/${teamId}/project/${projectId}`,
      'project archive',
    )
    return c.json(response)
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

/** Opaque capability link から allowlist 済み public Request Form を返します。 */
app.get('/api/request-intake/:token', async (c) => {
  try {
    const resolution = await requestIntake.resolveLink(c.req.param('token'))
    await authorizeRequestLink(c, resolution)
    return c.json(await requestIntake.getPublicForm(resolution, createRequestExternalContext(c)))
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error, true)
  }
})

/** Public/authenticated Request Form 用の direct attachment upload session を作成します。 */
app.post('/api/request-intake/:token/uploads', async (c) => {
  try {
    const resolution = await requestIntake.resolveLink(c.req.param('token'))
    await authorizeRequestLink(c, resolution)
    const body = await readJson<RequestAttachmentUploadInput>(c.req)
    return c.json(await requestIntake.createAttachmentUpload(
      resolution,
      body ?? {} as RequestAttachmentUploadInput,
      createRequestExternalContext(c),
    ), 201)
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error, true)
  }
})

/** Public/authenticated Request Form の回答を intake queue へ保存します。 */
app.post('/api/request-intake/:token/submissions', async (c) => {
  try {
    const resolution = await requestIntake.resolveLink(c.req.param('token'))
    await authorizeRequestLink(c, resolution)
    const body = await readJson<SubmitRequestInput>(c.req)
    return c.json(await requestIntake.submit(
      resolution,
      body ?? {} as SubmitRequestInput,
      createRequestExternalContext(c),
    ), 201)
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error, true)
  }
})

/** Opaque thread capability から requester 向け message だけを返します。 */
app.get('/api/request-threads/:threadToken', async (c) => {
  try {
    return c.json(await requestIntake.getRequesterThread(
      c.req.param('threadToken'),
      createRequestExternalContext(c),
    ))
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error, true)
  }
})

/** Opaque thread capability から追加情報 reply を安全に保存します。 */
app.post('/api/request-threads/:threadToken/replies', async (c) => {
  try {
    const body = await readJson<RequestRequesterReplyInput>(c.req)
    return c.json(await requestIntake.replyToThread(
      c.req.param('threadToken'),
      body ?? {} as RequestRequesterReplyInput,
      createRequestExternalContext(c),
    ), 201)
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error, true)
  }
})

/** Workspace admin が管理できる Request Form 一覧を返します。 */
app.get('/api/request-forms', async (c) => {
  try {
    const principal = await requireRequestAdministration(c)
    return c.json(await requestIntake.listForms(principal.directoryId))
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error)
  }
})

/** Workspace admin が Request Form draft と capability link を作成します。 */
app.post('/api/request-forms', async (c) => {
  try {
    const principal = await requireRequestAdministration(c)
    const body = await readJson<CreateRequestFormInput>(c.req)
    return c.json(await requestIntake.createForm(
      principal.directoryId,
      { id: principal.userKey },
      body ?? {} as CreateRequestFormInput,
    ), 201)
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error)
  }
})

/** Workspace admin が Request Form detail と published version metadata を取得します。 */
app.get('/api/request-forms/:formId', async (c) => {
  try {
    const principal = await requireRequestAdministration(c)
    return c.json(await requestIntake.getForm(principal.directoryId, c.req.param('formId')))
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error)
  }
})

/** Workspace admin が Request Form draft/link を revision 条件付きで更新します。 */
app.put('/api/request-forms/:formId', async (c) => {
  try {
    const principal = await requireRequestAdministration(c)
    const body = await readJson<UpdateRequestFormInput>(c.req)
    return c.json(await requestIntake.updateForm(
      principal.directoryId,
      c.req.param('formId'),
      { id: principal.userKey },
      body ?? {} as UpdateRequestFormInput,
    ))
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error)
  }
})

/** Workspace admin が current draft を immutable Request Form version として公開します。 */
app.post('/api/request-forms/:formId/publish', async (c) => {
  try {
    const principal = await requireRequestAdministration(c)
    const formId = c.req.param('formId')
    const body = await readJson<PublishRequestFormInput>(c.req)
    const publishInput = body ?? {} as PublishRequestFormInput
    const current = await requestIntake.getForm(principal.directoryId, formId)
    if (
      !Number.isSafeInteger(publishInput.expectedRevision) ||
      publishInput.expectedRevision !== current.revision
    ) {
      throw new RequestIntakeError(
        409,
        'RequestRevisionConflict',
        'Request resource revision changed.',
      )
    }
    await validateRequestFormRoutingReferences(principal.directoryId, current.draft)
    return c.json(await requestIntake.publishForm(
      principal.directoryId,
      formId,
      { id: principal.userKey },
      publishInput,
    ))
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error)
  }
})

/** Workspace admin の intake queue を cursor pagination します。 */
app.get('/api/request-queue', async (c) => {
  try {
    const principal = await requireRequestAdministration(c)
    return c.json(await requestIntake.listSubmissions(principal.directoryId, {
      status: readRequestSubmissionStatus(c.req.query('status')),
      limit: readOptionalPositiveQueryInteger(c.req.query('limit'), 'Request queue limit'),
      cursor: c.req.query('cursor'),
    }))
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error)
  }
})

/** Workspace admin が historical form snapshot を含む submission detail を取得します。 */
app.get('/api/request-submissions/:submissionId', async (c) => {
  try {
    const principal = await requireRequestAdministration(c)
    return c.json(await requestIntake.getSubmission(
      principal.directoryId,
      c.req.param('submissionId'),
    ))
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error)
  }
})

/** Workspace admin が explicit triage transition または Work Item conversion を実行します。 */
app.post('/api/request-submissions/:submissionId/actions', async (c) => {
  try {
    const principal = await requireRequestAdministration(c)
    requireWorkspaceBusinessWrite(principal)
    const submissionId = c.req.param('submissionId')
    const body = await readJson<RequestSubmissionActionInput>(c.req)
    if (!body || !isRecord(body) || typeof body.action !== 'string') {
      throw new RequestIntakeError(400, 'InvalidRequestIntakeInput', 'Request action is required.')
    }
    if (
      body.action !== 'assign' &&
      body.action !== 'request-more-info' &&
      body.action !== 'reject' &&
      body.action !== 'mark-duplicate' &&
      body.action !== 'convert'
    ) {
      throw new RequestIntakeError(400, 'InvalidRequestIntakeInput', 'Request action is invalid.')
    }
    if (body.action !== 'convert') {
      if (body.action === 'assign') {
        if (typeof body.assigneeUserId !== 'string' || !body.assigneeUserId.trim()) {
          throw new RequestIntakeError(400, 'InvalidRequestIntakeInput', 'Request assignee is required.')
        }
        await requireActiveWorkspaceAssignee(principal.directoryId, body.assigneeUserId)
      }
      return c.json(await requestIntake.applyAction(
        principal.directoryId,
        submissionId,
        { id: principal.userKey },
        body,
      ))
    }
    const submission = await requestIntake.getSubmission(principal.directoryId, submissionId)
    const conversion = createRequestWorkItemInput(submission, body)
    const teamContext = await requireTeamPermission(principal, conversion.target.teamId, 'member')
    requireAssignedProjectPermission(
      principal,
      teamContext,
      conversion.target.projectId,
      'member',
    )
    await validateRequestRoutingTarget(principal.directoryId, conversion.target)
    const normalized = normalizeTeamIssueInput(conversion.input, teamContext.team)
    const resolvedConfiguration = await workItemConfigurations.getTeamConfiguration(
      principal.directoryId,
      conversion.target.teamId,
    )
    const configured = await prepareConfiguredCreateWorkItem(
      principal.directoryId,
      conversion.target.teamId,
      normalized,
      resolvedConfiguration,
    )
    await requireActiveWorkspaceAssignee(
      principal.directoryId,
      readTeamIssueAssigneeUserId(configured),
    )
    const created = await hydrateCreateTeamIssueResponse(await teamIssues.createTeamIssue(
      principal.directoryId,
      conversion.target.teamId,
      configured,
      principal.userKey,
      createApiMutationContext(c, principal, {
        submissionId,
        action: 'convert',
        target: conversion.target,
      }),
      {
        tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
        scopeKey: `WORKSPACE#${principal.directoryId}`,
        recordKey: `SUBMISSION#${submissionId}`,
        expectedRevision: body.expectedRevision,
        actorId: principal.userKey,
        submissionId,
        events: submission.events,
      },
    ))
    await projectWorkItemSearchDocumentBestEffort(
      principal.directoryId,
      created.issue,
      'Request conversion',
      [],
    )
    return c.json(await requestIntake.completeConversion(
      principal.directoryId,
      submissionId,
      { id: principal.userKey },
      {
        expectedRevision: body.expectedRevision,
        workItem: {
          teamId: created.issue.teamId,
          workItemId: created.issue.id,
          ...(created.issue.assignedProjectId
            ? { projectId: created.issue.assignedProjectId }
            : {}),
        },
      },
    ))
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error)
  }
})

/** Workspace admin が malware scan 済み request attachment の短命 URL を取得します。 */
app.post('/api/request-submissions/:submissionId/attachments/:attachmentId/access', async (c) => {
  try {
    const principal = await requireRequestAdministration(c)
    return c.json(await requestIntake.createAttachmentAccess(
      principal.directoryId,
      c.req.param('submissionId'),
      c.req.param('attachmentId'),
    ))
  } catch (error) {
    return toRequestIntakeErrorResponse(c, error)
  }
})

/** Workspace default または built-in Work Item configuration を返します。 */
app.get('/api/work-item-configuration', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    return c.json(await workItemConfigurations.getWorkspaceConfiguration(principal.directoryId))
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
})

/** Workspace default workflow/custom field configuration を保存します。 */
app.put('/api/work-item-configuration', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceAdministration(principal)
    const body = await readJson<WorkItemConfiguration>(c.req)
    const configuration = validateWorkItemConfiguration({
      ...body,
      scopeType: 'workspace',
      scopeId: principal.directoryId,
    })
    return c.json(await workItemConfigurations.saveWorkspaceConfiguration(
      principal.directoryId,
      configuration,
      async () => {
        await validateWorkItemConfigurationReferences(principal.directoryId, configuration)
        await validateWorkItemConfigurationUsage(principal.directoryId, configuration)
      },
    ))
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
})

/** Team override または Workspace/default から継承した configuration を返します。 */
app.get('/api/teams/:teamId/work-item-configuration', async (c) => {
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
    await requireTeamPermission(principal, teamId, 'viewer')
    return c.json(await workItemConfigurations.getTeamConfiguration(principal.directoryId, teamId))
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
})

/** Team 固有 workflow/custom field configuration を保存します。 */
app.put('/api/teams/:teamId/work-item-configuration', async (c) => {
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
    await requireTeamConfigurationAdministration(principal, teamId)
    const body = await readJson<WorkItemConfiguration>(c.req)
    const configuration = validateWorkItemConfiguration({
      ...body,
      scopeType: 'team',
      scopeId: teamId,
    })
    return c.json(await workItemConfigurations.saveTeamConfiguration(
      principal.directoryId,
      teamId,
      configuration,
      async () => {
        await validateWorkItemConfigurationReferences(
          principal.directoryId,
          configuration,
          teamId,
        )
        await validateWorkItemConfigurationUsage(
          principal.directoryId,
          configuration,
          teamId,
        )
      },
    ))
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
})

/** 同一 Team 内の Work Item 間へ reciprocal relation を作成します。 */
app.post('/api/teams/:teamId/issues/:issueId/relations', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }
  if (!teamId || !issueId) {
    return c.json({ message: 'Team ID and Work Item ID are required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const body = await readJson<Record<string, unknown>>(c.req) ?? {}
    const relationType = readCreatableWorkItemRelationType(body.type)
    const targetWorkItemId = readRequiredString(
      body.targetWorkItemId,
      'Target Work Item ID is required.',
    )
    const expectedGraphRevision = readNonNegativeRevision(
      body.expectedGraphRevision,
      'Relation graph revision',
    )
    const endpoints = await authorizeRelationMutation(principal, teamId, issueId, targetWorkItemId)
    const response = await workItemConfigurations.createRelation(
      principal.directoryId,
      teamId,
      {
        sourceWorkItemId: issueId,
        targetWorkItemId,
        type: relationType,
        expectedGraphRevision,
        sourceExpectedRevision: endpoints.source.revision,
        targetExpectedRevision: endpoints.target.revision,
        sourceAssignedProjectId: endpoints.source.assignedProjectId,
        targetAssignedProjectId: endpoints.target.assignedProjectId,
      },
    )
    await Promise.all([
      refreshWorkItemSearchDocumentBestEffort(
        principal.directoryId,
        teamId,
        issueId,
        'Work Item relation creation',
      ),
      refreshWorkItemSearchDocumentBestEffort(
        principal.directoryId,
        teamId,
        targetWorkItemId,
        'Work Item reciprocal relation creation',
      ),
    ])
    return c.json(response, 201)
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
})

/** 同一 Team 内の reciprocal relation を削除します。 */
app.delete('/api/teams/:teamId/issues/:issueId/relations/:targetWorkItemId/:relationType', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')
  const targetWorkItemId = c.req.param('targetWorkItemId')
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }
  if (!teamId || !issueId || !targetWorkItemId) {
    return c.json({ message: 'Team ID and Work Item IDs are required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const body = await readJson<Record<string, unknown>>(c.req) ?? {}
    const relationType = readWorkItemRelationType(c.req.param('relationType'))
    const expectedGraphRevision = readNonNegativeRevision(
      body.expectedGraphRevision,
      'Relation graph revision',
    )
    const endpoints = await authorizeRelationMutation(principal, teamId, issueId, targetWorkItemId)
    const response = await workItemConfigurations.deleteRelation(
      principal.directoryId,
      teamId,
      {
        sourceWorkItemId: issueId,
        targetWorkItemId,
        type: relationType,
        expectedGraphRevision,
        sourceExpectedRevision: endpoints.source.revision,
        targetExpectedRevision: endpoints.target.revision,
        sourceAssignedProjectId: endpoints.source.assignedProjectId,
        targetAssignedProjectId: endpoints.target.assignedProjectId,
      },
    )
    await Promise.all([
      refreshWorkItemSearchDocumentBestEffort(
        principal.directoryId,
        teamId,
        issueId,
        'Work Item relation deletion',
      ),
      refreshWorkItemSearchDocumentBestEffort(
        principal.directoryId,
        teamId,
        targetWorkItemId,
        'Work Item reciprocal relation deletion',
      ),
    ])
    return c.json(response)
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
})

/** 現在ユーザーが参照できる canonical Work Item を Workspace 横断で返します。 */
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
    return toWorkItemConfigurationErrorResponse(c, error)
  }
})

/** Workspace planning graph と canonical Work Item roll-up を返します。 */
app.get('/api/planning', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const workItemState = await readPlanningWorkItemState(principal)
    return c.json(await planning.get(principal.directoryId, workItemState))
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning hierarchy に entity を作成します。 */
app.post('/api/planning/entities', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const input = await readPlanningJson<CreatePlanningEntityInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await requirePlanningScopePermission(principal, input, 'manager')
    if (input.parentId) {
      await requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        input.parentId,
        'manager',
      )
    }
    await requirePlanningActiveOwner(principal, input.ownerMemberKey)
    const response = await planning.create(principal.directoryId, input, workItemState)
    return c.json(response.planning, 201)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity の editable fields を更新します。 */
app.patch('/api/planning/entities/:entityId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
    const input = await readPlanningJson<UpdatePlanningEntityInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'manager')
    if (isRecord(input.patch) && input.patch.ownerMemberKey !== undefined) {
      await requirePlanningActiveOwner(principal, input.patch.ownerMemberKey)
    }
    const response = await planning.update(principal.directoryId, entityId, input, workItemState)
    return c.json(response.planning)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity を soft archive します。 */
app.post('/api/planning/entities/:entityId/archive', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
    const input = await readPlanningJson<PlanningRevisionInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'manager')
    const response = await planning.archive(principal.directoryId, entityId, input, workItemState)
    return c.json(response.planning)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity を link や dependency を持たない新規 entity として複製します。 */
app.post('/api/planning/entities/:entityId/duplicate', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
    const input = await readPlanningJson<DuplicatePlanningEntityInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    const source = await requirePlanningEntityPermission(
      principal,
      snapshot.entities,
      entityId,
      'manager',
    )
    await requirePlanningActiveOwner(principal, source.ownerMemberKey)
    const effectiveParentId = input.parentId === undefined ? source.parentId : input.parentId
    if (effectiveParentId) {
      await requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        effectiveParentId,
        'manager',
      )
    }
    const response = await planning.duplicate(principal.directoryId, entityId, input, workItemState)
    return c.json(response.planning, 201)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity の hierarchy / Team / Project scope を移動します。 */
app.post('/api/planning/entities/:entityId/move', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
    const input = await readPlanningJson<MovePlanningEntityInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'manager')
    for (const descendant of collectActivePlanningDescendants(snapshot.entities, entityId)) {
      await requirePlanningScopePermission(principal, descendant, 'manager')
    }
    await requirePlanningScopePermission(principal, input, 'manager')
    if (input.parentId) {
      await requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        input.parentId,
        'manager',
      )
    }
    const response = await planning.move(principal.directoryId, entityId, input, workItemState)
    return c.json(response.planning)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity に member authored status update を追記します。 */
app.post('/api/planning/entities/:entityId/status-updates', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
    const input = await readPlanningJson<PlanningStatusUpdateInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'member')
    const response = await planning.addStatusUpdate(
      principal.directoryId,
      entityId,
      input,
      principal.userKey,
      workItemState,
    )
    return c.json(response.planning, 201)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity 間に directed dependency を作成します。 */
app.post('/api/planning/dependencies', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const input = await readPlanningJson<CreatePlanningDependencyInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await Promise.all([
      requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        input.predecessorId,
        'manager',
      ),
      requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        input.successorId,
        'manager',
      ),
    ])
    const response = await planning.createDependency(principal.directoryId, input, workItemState)
    return c.json(response.planning, 201)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning dependency を削除します。 */
app.delete('/api/planning/dependencies/:dependencyId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const dependencyId = readPlanningRouteId(c.req.param('dependencyId'), 'Dependency ID')
    const input = await readPlanningJson<PlanningRevisionInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    const dependency = snapshot.dependencies.find((candidate) => candidate.id === dependencyId)
    if (!dependency) {
      throw new PlanningError(404, 'PlanningDependencyNotFound', 'Planning dependency was not found.')
    }
    await Promise.all([
      requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        dependency.predecessorId,
        'manager',
      ),
      requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        dependency.successorId,
        'manager',
      ),
    ])
    const response = await planning.deleteDependency(
      principal.directoryId,
      dependencyId,
      input,
      workItemState,
    )
    return c.json(response.planning)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Canonical Work Item と Cycle / Milestone / Goal の link を作成または置換します。 */
app.put('/api/planning/work-item-links/:teamId/:workItemId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const teamId = readPlanningRouteId(c.req.param('teamId'), 'Team ID')
    const workItemId = readPlanningRouteId(c.req.param('workItemId'), 'Work Item ID')
    const input = await readPlanningJson<PlanningWorkItemLinkInput>(c.req)
    if (input.teamId !== teamId || input.workItemId !== workItemId) {
      throw new PlanningError(
        400,
        'PlanningWorkItemPathMismatch',
        'Work Item link path and request body IDs must match.',
      )
    }
    const projectId = input.projectId === undefined
      ? undefined
      : readPlanningIdentifier(input.projectId, 'Project ID')
    const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
    if (
      projectId !== undefined &&
      projectId !== detail.issue.assignedProjectId
    ) {
      throw new PlanningError(
        409,
        'PlanningWorkItemProjectMismatch',
        'Work Item link Project does not match the canonical Work Item.',
      )
    }
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    const current = await planning.getWorkItemLinkForAuthorization(
      principal.directoryId,
      teamId,
      workItemId,
    )
    if (current) {
      await requirePlanningLinkEntityPermissions(
        principal,
        snapshot.entities,
        current,
      )
    }
    await requirePlanningLinkEntityPermissions(principal, snapshot.entities, input)
    const response = await planning.putWorkItemLink(principal.directoryId, input, workItemState)
    return c.json(response.planning)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Canonical Work Item の Planning link を削除します。 */
app.delete('/api/planning/work-item-links/:teamId/:workItemId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const teamId = readPlanningRouteId(c.req.param('teamId'), 'Team ID')
    const workItemId = readPlanningRouteId(c.req.param('workItemId'), 'Work Item ID')
    const input = await readPlanningJson<PlanningRevisionInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    const current = snapshot.workItemLinks.find((link) =>
      link.teamId === teamId && link.workItemId === workItemId,
    )
    if (current) {
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
      await requirePlanningLinkEntityPermissions(principal, snapshot.entities, current)
    } else if (!principal.isSystemAdmin) {
      requireWorkspaceAdministration(principal)
    }
    const response = await planning.deleteWorkItemLink(
      principal.directoryId,
      teamId,
      workItemId,
      input,
      workItemState,
    )
    return c.json(response.planning)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Cycle を完了し、未完了 Work Item を設定済み policy で rollover します。 */
app.post('/api/planning/cycles/:cycleId/rollover', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    requireWorkspaceBusinessWrite(principal)
    const cycleId = readPlanningRouteId(c.req.param('cycleId'), 'Cycle ID')
    const input = await readPlanningJson<CycleRolloverInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await Promise.all([
      requirePlanningEntityPermission(principal, snapshot.entities, cycleId, 'manager'),
      requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        input.targetCycleId,
        'manager',
      ),
    ])
    return c.json(await planning.rolloverCycle(
      principal.directoryId,
      cycleId,
      input,
      workItemState,
    ))
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/**
 * Workspace 全体の search index を複合 filter と cursor 付きで検索します。
 */
app.get('/api/search', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const context = await createWorkspaceSearchContext(principal)
    const filters = readWorkspaceSearchFilters(c.req.query('filters'))
    const scopeCache = new Map<string, Promise<TeamIssueDetailResponse | undefined>>()

    return c.json(await workspaceSearch.search({
      workspaceId: principal.directoryId,
      filters,
      limit: readOptionalPositiveQueryInteger(c.req.query('limit'), 'Search limit'),
      cursor: c.req.query('cursor'),
      access: context.searchAccess,
      resolveCurrentScope: (document) => resolveCurrentWorkspaceSearchScope(
        principal.directoryId,
        document,
        context,
        scopeCache,
      ),
    }))
  } catch (error) {
    return toWorkspaceSearchErrorResponse(c, error)
  }
})

/** Current user が参照できる personal/team/shared saved views を返します。 */
app.get('/api/saved-views', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const context = await createWorkspaceSearchContext(principal)
    return c.json(await workspaceSearch.listSavedViews({
      workspaceId: principal.directoryId,
      access: context.savedViewAccess,
      limit: readOptionalPositiveQueryInteger(c.req.query('limit'), 'Saved view limit'),
      cursor: c.req.query('cursor'),
    }))
  } catch (error) {
    return toWorkspaceSearchErrorResponse(c, error)
  }
})

/** Personal/team/shared saved view を作成します。 */
app.post('/api/saved-views', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const context = await createWorkspaceSearchContext(principal)
    const input = await readJson<CreateSavedWorkspaceViewInput>(c.req)
    return c.json(await workspaceSearch.createSavedView({
      workspaceId: principal.directoryId,
      access: context.savedViewAccess,
      idempotencyKey: c.req.header('Idempotency-Key')?.trim() || undefined,
      input: input ?? {} as CreateSavedWorkspaceViewInput,
    }), 201)
  } catch (error) {
    return toWorkspaceSearchErrorResponse(c, error)
  }
})

/** Saved view definition と current user preference を更新します。 */
app.patch('/api/saved-views/:viewId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const viewId = c.req.param('viewId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const context = await createWorkspaceSearchContext(principal)
    const input = await readJson<UpdateSavedWorkspaceViewInput>(c.req)
    return c.json(await workspaceSearch.updateSavedView({
      workspaceId: principal.directoryId,
      viewId,
      access: context.savedViewAccess,
      input: input ?? {} as UpdateSavedWorkspaceViewInput,
    }))
  } catch (error) {
    return toWorkspaceSearchErrorResponse(c, error)
  }
})

/** Saved view definition を revision 条件付きで削除します。 */
app.delete('/api/saved-views/:viewId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const viewId = c.req.param('viewId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const context = await createWorkspaceSearchContext(principal)
    return c.json(await workspaceSearch.deleteSavedView({
      workspaceId: principal.directoryId,
      viewId,
      expectedRevision: readRequiredPositiveQueryInteger(
        c.req.query('expectedRevision'),
        'Saved view revision',
      ),
      access: context.savedViewAccess,
    }))
  } catch (error) {
    return toWorkspaceSearchErrorResponse(c, error)
  }
})

/** Issue #20 の legacy project task を read-only で返します。 */
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
      await projectTasks.getProjectTasks(principal.directoryId, projectId),
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
    const requestBody = await readJson<CreateTeamIssueRequestBody>(c.req) ?? {}
    delete requestBody.idempotencyResourceId
    const body = normalizeTeamIssueInput(
      requestBody,
      context.team,
    )
    requireAssignedProjectPermission(
      principal,
      context,
      readAssignedProjectId(body.assignedProjectId),
      'member',
    )
    const resolvedConfiguration = await workItemConfigurations.getTeamConfiguration(
      principal.directoryId,
      teamId,
    )
    const configuredBody = await prepareConfiguredCreateWorkItem(
      principal.directoryId,
      teamId,
      body,
      resolvedConfiguration,
    )
    const assigneeUserId = readTeamIssueAssigneeUserId(configuredBody)
    await requireActiveWorkspaceAssignee(principal.directoryId, assigneeUserId)
    const response = await hydrateCreateTeamIssueResponse(
      await teamIssues.createTeamIssue(
        principal.directoryId,
        teamId,
        {
          ...configuredBody,
          assigneeUserId,
        },
        principal.userKey,
        createApiMutationContext(c, principal, { teamId, ...configuredBody }),
      ),
    )
    await projectWorkItemSearchDocumentBestEffort(
      principal.directoryId,
      response.issue,
      'Work Item creation',
      [],
    )
    return c.json(response, 201)
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
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
    const detail = await teamIssues.getTeamIssueDetail(
      principal.directoryId,
      teamId,
      issueId,
      { consistentIssueRead: true },
    )
    requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'viewer')

    const page = await auditEvents.query(
      readAuditEventQuery(c, principal.directoryId, {
        type: 'work-item',
        id: createTeamIssueAuditEntityId(teamId, issueId),
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
    const [collaborationPreview, resolvedConfiguration, relationPage] = await Promise.all([
      collaboration.getThread({
        entityKey,
        viewerMemberKey: principal.userKey,
        projectEntityKey,
        limit: 50,
        includeScopeState: false,
      }),
      workItemConfigurations.getTeamConfiguration(principal.directoryId, teamId),
      workItemConfigurations.listRelations(principal.directoryId, teamId, issueId),
    ])
    const visibleRelations = await filterVisibleWorkItemRelations(
      principal,
      context,
      teamId,
      relationPage.relations,
    )

    return c.json(
      await hydrateTeamIssueDetailResponse(
        {
          ...detail,
          comments: mergeLegacyCompatibleComments(
            detail.comments,
            collaborationPreview.comments,
          ),
          resolvedConfiguration,
          relations: visibleRelations,
          relationGraphRevision: relationPage.graphRevision,
        },
        principal.directoryId,
      ),
    )
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
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
    const input = await readJson<PublicUpdateTeamIssueRequestBody>(c.req) ?? {}
    rejectInternalWorkItemUpdateFields(input)
    const body = normalizeTeamIssueInput(
      input,
      context.team,
    )
    const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
    const detail = await teamIssues.getTeamIssueDetail(
      principal.directoryId,
      teamId,
      issueId,
      { consistentIssueRead: true, eventLimit: 0 },
    )
    requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'member')
    requireAssignedProjectPermission(
      principal,
      context,
      readAssignedProjectId(body.assignedProjectId),
      'member',
    )

    const resolvedConfiguration = await workItemConfigurations.getTeamConfiguration(
      principal.directoryId,
      teamId,
    )
    const configuredBody = await prepareConfiguredUpdateWorkItem(
      principal.directoryId,
      teamId,
      detail.issue,
      body,
      resolvedConfiguration,
    )

    if ('assigneeUserId' in configuredBody) {
      await requireActiveWorkspaceAssignee(
        principal.directoryId,
        readTeamIssueAssigneeUserId(configuredBody),
      )
    }

    const response = await hydrateUpdateTeamIssueResponse(
      await teamIssues.updateTeamIssue(
        principal.directoryId,
        teamId,
        issueId,
        { ...configuredBody, expectedRevision },
        principal.userKey,
        createApiMutationContext(c, principal, {
          teamId,
          issueId,
          ...configuredBody,
          expectedRevision,
        }),
      ),
    )
    await projectWorkItemMutationSearchDocumentBestEffort(
      principal.directoryId,
      response.issue,
      'Work Item update',
    )
    return c.json(response)
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
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
      workItemTitle: detail.issue.title,
      entityKey,
      projectId: detail.issue.assignedProjectId,
      projectEntityKey,
      actorMemberKey: principal.userKey,
      bodyMarkdown: readRequiredCommentBody(modernContract ? body.bodyMarkdown : body.body),
      parentCommentId: readOptionalCommentId(body.parentCommentId, 'Parent comment ID'),
      mentionMemberKeys,
      automaticWatcherCandidates,
      deepLink: createTeamIssueDeepLink(teamId, issueId),
      auditContext: createApiMutationContext(c, principal, { teamId, issueId, ...body }),
    })
    const activity = {
      id: comment.id,
      type: 'commented' as const,
      actorUserId: principal.userKey,
      summary: body.parentCommentId ? 'Reply was added.' : 'Comment was added.',
      createdAt: comment.createdAt,
    }
    await projectWorkspaceSearchDocumentBestEffort(
      () => createCommentSearchDocument(
        principal.directoryId,
        teamId,
        detail.issue,
        comment,
      ),
      'comment creation',
    )

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
      workItemTitle: detail.issue.title,
      entityKey,
      projectId: detail.issue.assignedProjectId,
      projectEntityKey,
      actorMemberKey: principal.userKey,
      commentId,
      bodyMarkdown: readRequiredCommentBody(body.bodyMarkdown),
      mentionMemberKeys,
      automaticWatcherCandidates,
      expectedVersion: readCommentExpectedVersion(body.expectedVersion),
      deepLink: createTeamIssueDeepLink(teamId, issueId),
      auditContext: createApiMutationContext(c, principal, { teamId, issueId, commentId, ...body }),
    })
    await projectWorkspaceSearchDocumentBestEffort(
      () => createCommentSearchDocument(
        principal.directoryId,
        teamId,
        detail.issue,
        comment,
      ),
      'comment update',
    )

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
    await deleteWorkspaceSearchDocumentBestEffort(
      principal.directoryId,
      'comment',
      `${createTeamIssueAuditEntityId(teamId, issueId)}/comment/${commentId}`,
      'comment deletion',
    )

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
    const commentExists = await collaboration.hasAttachableComment(
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
    const { scope, actor, workItem } = await loadFileProofingRequestContext(
      c,
      principal,
      'work-item',
    )
    const canonicalWorkItem = requireCanonicalFileProofingWorkItem(workItem)
    if (!actor.canWrite || actor.guest) {
      throw new FileProofingError(403, 'FileWriteDenied', 'File write access is required.')
    }
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
    const reviewerMembers = await requireApprovalReviewers(
      principal.directoryId,
      scope.teamId,
      scope.projectId,
      reviewerMemberKeys,
    )
    if (reviewerMembers.some((member) => member.role === 'guest')) {
      if (!targetFile?.guestAccess) {
        throw new FileProofingError(
          409,
          'ApprovalGuestFileAccessDenied',
          'Guest reviewers require an explicitly guest-shared file.',
        )
      }
    }
    if (body.completionTransition !== undefined) {
      await resolveFileApprovalCompletionTransition(
        principal.directoryId,
        scope.teamId,
        canonicalWorkItem,
        body.completionTransition,
      )
    }
    const input = {
      ...body,
      reviewerMemberKeys,
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

/** Approval reviewer が active かつ対象 Work Item を閲覧可能であることを検証します。 */
async function requireApprovalReviewers(
  workspaceId: string,
  teamId: string,
  assignedProjectId: string | undefined,
  reviewerMemberKeys: readonly string[],
) {
  const directory = assignedProjectId
    ? undefined
    : await projectDirectory.getProjectDirectory(workspaceId, 'ja', true)
  const teamProjectIds = new Set(
    directory?.teams.find((team) => team.id === teamId)?.projects.map((project) => project.id) ?? [],
  )
  return await Promise.all(reviewerMemberKeys.map(async (memberKey) => {
    const member = await workspaceAccess.getActiveMember(workspaceId, memberKey)
    if (!member) {
      throw new FileProofingError(
        409,
        'ApprovalReviewerInactive',
        `Reviewer "${memberKey}" is not an active Workspace member.`,
      )
    }
    const reviewerIsSystemAdmin = await cognito.isSystemAdmin(member.memberKey)
    if (assignedProjectId && !reviewerIsSystemAdmin) {
      const projectAccess = await projectDirectory.getProjectAccess(
        workspaceId,
        assignedProjectId,
        member.memberKey,
      )
      if (!projectAccess || !projectAccessAllows(projectAccess, 'viewer')) {
        throw new FileProofingError(
          409,
          'ApprovalReviewerAccessDenied',
          `Reviewer "${memberKey}" cannot view the assigned project.`,
        )
      }
    } else if (!assignedProjectId && !reviewerIsSystemAdmin) {
      const projectAccesses = await projectDirectory.getProjectAccessList(workspaceId, member.memberKey)
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
}

/** Assigned reviewer の approval decision を保存する endpoint です。 */
app.post('/api/teams/:teamId/issues/:issueId/approvals/:approvalId/decisions', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken)
    const { scope, actor, workItem } = await loadFileProofingRequestContext(
      c,
      principal,
      'work-item',
    )
    const canonicalWorkItem = requireCanonicalFileProofingWorkItem(workItem)
    const body = await readFileProofingJson<CreateFileApprovalDecisionInput>(c.req)
    const input = { ...body } satisfies CreateFileApprovalDecisionInput
    let resolvedCompletionTransition: FileApprovalCompletionTransition | undefined
    const resolveCompletionTransition: FileApprovalCompletionTransitionResolver = async (
      completionTransition,
    ) => {
      const resolved = await resolveFileApprovalCompletionTransitionForDecision(
        principal.directoryId,
        scope.teamId,
        canonicalWorkItem,
        completionTransition,
      )
      resolvedCompletionTransition = resolved
      return resolved
    }
    const approval = await fileProofing.decideApproval(
      scope,
      actor,
      readRequiredRouteId(c.req.param('approvalId'), 'Approval ID'),
      input,
      createApiMutationContext(c, principal, input),
      resolveCompletionTransition,
    )
    if (approval.status === 'approved' && resolvedCompletionTransition) {
      await refreshWorkItemSearchDocumentBestEffort(
        principal.directoryId,
        scope.teamId,
        canonicalWorkItem.id,
        'approval completion transition',
      )
    }
    return c.json({ approval })
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
    return c.json(await listAuthorizedReviewerApprovals(principal, {
      ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
      ...(c.req.query('limit') ? { limit: Number(c.req.query('limit')) } : {}),
    }))
  } catch (error) {
    return toFileProofingErrorResponse(c, error)
  }
})

async function listAuthorizedReviewerApprovals(
  principal: WorkspacePrincipal,
  options: ListReviewerApprovalsOptions,
): Promise<ReviewerApprovalPage> {
  const limit = options.limit ?? 50
  const approvals: ReviewerApprovalPage['approvals'] = []
  let cursor = options.cursor
  const visitedCursors = new Set<string>()

  do {
    const page = await fileProofing.listReviewerApprovals(
      principal.directoryId,
      {
        memberKey: principal.userKey,
        guest: principal.workspaceRole === 'guest',
        canWrite: false,
        canManage: false,
      },
      {
        ...(cursor ? { cursor } : {}),
        limit: limit - approvals.length,
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
      } catch (error) {
        if (isReviewerApprovalAuthorizationMiss(error)) {
          return undefined
        }
        throw error
      }
    }))
    approvals.push(...authorized.filter((approval) => approval !== undefined))

    if (page.nextCursor && (page.nextCursor === cursor || visitedCursors.has(page.nextCursor))) {
      throw new FileProofingError(
        503,
        'ReviewerApprovalCursorStalled',
        'Reviewer approvals could not advance to the next page.',
      )
    }
    if (cursor) {
      visitedCursors.add(cursor)
    }
    cursor = page.nextCursor
  } while (approvals.length < limit && cursor)

  return {
    approvals,
    ...(cursor ? { nextCursor: cursor } : {}),
  }
}

function isReviewerApprovalAuthorizationMiss(error: unknown) {
  return (error instanceof ProjectDataError || isRecord(error)) &&
    (error.status === 403 || error.status === 404)
}

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

async function readJson<T>(request: { json: () => Promise<T> }) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

async function readAutomationJson(c: Context) {
  const value = await readJson<unknown>(c.req)
  if (!isRecord(value)) {
    throw new AutomationError(
      400,
      'InvalidAutomationInput',
      'A JSON object request body is required.',
    )
  }
  return value
}

async function authenticateAutomationPrincipal(c: Context, manage = false) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    throw new AutomationError(401, 'AutomationAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken)
  if (manage) requireWorkspaceAdministration(principal)
  return principal
}

function readRequiredInboundWebhookIdempotencyKey(c: Context) {
  const value = c.req.header('Idempotency-Key')?.trim()
  if (!value || value.length > 256) {
    throw new AutomationError(
      400,
      'AutomationInboundWebhookIdempotencyKeyRequired',
      'A non-empty Idempotency-Key of at most 256 characters is required.',
    )
  }
  return value
}

function getAutomationInboundWebhookBaseUrl(c: Context) {
  return getEnv('AUTOMATION_INBOUND_WEBHOOK_BASE_URL')?.trim() || new URL(c.req.url).origin
}

async function requireAutomationInboundWebhookEndpoint(
  workspaceId: string,
  endpointId: string,
) {
  const endpoint = await automation.getInboundWebhookEndpoint(workspaceId, endpointId)
  if (!endpoint) throw automationInboundWebhookNotFound()
  return endpoint
}

function toAutomationInboundWebhookSecretReference(
  endpoint: AutomationInboundWebhookEndpointRecord,
): AutomationInboundWebhookSecretReference {
  return {
    workspaceId: endpoint.workspaceId,
    endpointId: endpoint.id,
    secretId: endpoint.secretId,
    secretVersionId: endpoint.secretVersionId,
    secretGeneration: endpoint.secretGeneration,
  }
}

async function provisionAutomationInboundWebhookEndpoint(
  provisioning: AutomationInboundWebhookProvisioning,
) {
  const secretReference = toAutomationInboundWebhookSecretReference(provisioning.endpoint)
  try {
    const signingSecret = await automationInboundWebhookSecrets.provision(secretReference)
    return {
      completed: await automation.completeInboundWebhookProvisioning(provisioning),
      signingSecret,
    }
  } catch (error) {
    const current = await automation.getInboundWebhookEndpoint(
      provisioning.endpoint.workspaceId,
      provisioning.endpoint.id,
    ).catch(() => undefined)
    if (current?.status === 'revoked') {
      await automationInboundWebhookSecrets.delete(secretReference)
    }
    throw error
  }
}

function automationInboundWebhookNotFound() {
  return new AutomationError(
    404,
    'AutomationInboundWebhookNotFound',
    'Inbound webhook endpoint was not found.',
  )
}

function automationInboundWebhookUnavailable() {
  return new AutomationError(
    503,
    'AutomationInboundWebhookUnavailable',
    'Inbound webhook service is unavailable.',
    true,
  )
}

function readAutomationPageLimit(value: string | undefined) {
  if (value === undefined) return undefined
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AutomationError(400, 'InvalidAutomationQuery', 'Automation page limit is invalid.')
  }
  return limit
}

function readAutomationExecutionStatus(
  value: string | undefined,
): AutomationExecutionStatus | undefined {
  if (value === undefined) return undefined
  if (
    value === 'pending' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'dead-letter' ||
    value === 'skipped'
  ) return value
  throw new AutomationError(400, 'InvalidAutomationQuery', 'Automation execution status is invalid.')
}

function readWorkspaceBulkOperationRequest(
  value: Record<string, unknown>,
  workspaceId: string,
): BulkOperationRequest {
  return {
    ...value,
    workspaceId,
  } as BulkOperationRequest
}

async function requireBulkOperation(workspaceId: string, operationId: string) {
  const operation = await automation.getBulkOperation(workspaceId, operationId)
  if (!operation) {
    throw new AutomationError(404, 'BulkOperationNotFound', 'Bulk operation was not found.')
  }
  return operation
}

/** Bulk retry/undo を operation を開始した member だけへ制限します。 */
export function requireBulkOperationOwner(operation: BulkOperation, actorMemberKey: string) {
  if (operation.actorMemberKey !== actorMemberKey) {
    throw new AutomationError(403, 'BulkOperationForbidden', 'Bulk operation access is denied.')
  }
}

/** Server-only undo snapshots を除いた Bulk operation API response を返します。 */
export function toBulkOperationResponse(operation: BulkOperation): BulkOperation {
  return {
    ...operation,
    items: operation.items.map((item) => {
      const redacted = { ...item }
      delete redacted.undoPayload
      return redacted
    }),
  }
}

function toBulkOperationPreviewResponse(preview: BulkOperationPreview): BulkOperationPreview {
  return {
    ...preview,
    items: preview.items.map((item) => {
      const redacted = { ...item }
      delete redacted.undoPayload
      return redacted
    }),
  }
}

async function putAutomationIngressEvent(
  c: Context,
  principal: WorkspacePrincipal,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  const tableName = getConfiguredAuditTableName()
  if (!tableName) {
    throw new AutomationError(503, 'AutomationAuditUnavailable', 'Audit outbox is not configured.', true)
  }
  const context = createApiMutationContext(c, principal, metadata)
  const event = createAuditEvent({
    context,
    eventType: 'form.submitted',
    entity: { type: 'automation-form', id: entityId },
    summary: 'Automation form was submitted.',
    metadata,
    expiresAt: calculateAuditExpiresAt(context.occurredAt, 365),
  })
  const documentClient = createDynamoDbDocumentClient()
  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: event,
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(eventId)',
    }))
  } catch (error) {
    if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) throw error
    const existing = await documentClient.send(new GetCommand({
      TableName: tableName,
      Key: { directoryId: event.directoryId, eventId: event.eventId },
      ConsistentRead: true,
    }))
    if (
      existing.Item?.eventType !== event.eventType ||
      existing.Item?.requestFingerprint !== event.requestFingerprint ||
      existing.Item?.entityId !== event.entityId
    ) {
      throw new AutomationError(
        409,
        'IdempotencyConflict',
        'Idempotency key was already used with different automation ingress input.',
      )
    }
  }
  return event
}

async function executeAutomationTemplateApplication(
  c: Context,
  principal: WorkspacePrincipal,
  initialApplication: AutomationTemplateApplication,
) {
  if (initialApplication.status === 'succeeded') return initialApplication
  assertTemplateApplicationNotFailed(initialApplication)
  const now = new Date()
  const application = await automation.claimTemplateApplication(
    initialApplication,
    now,
    new Date(now.getTime() + AUTOMATION_TEMPLATE_APPLICATION_LEASE_MS).toISOString(),
  )
  if (!application) {
    const current = await automation.getTemplateApplication(
      initialApplication.workspaceId,
      initialApplication.id,
    )
    if (current?.status === 'succeeded') return current
    if (current) assertTemplateApplicationNotFailed(current)
    throw new AutomationError(
      409,
      'AutomationTemplateApplicationInProgress',
      'Template application is already in progress. Retry with the same Idempotency-Key.',
      true,
    )
  }

  try {
    const template = await automation.getTemplateVersion(
      application.workspaceId,
      application.templateId,
      application.templateVersion,
    )
    if (!template || template.kind !== application.kind) {
      throw new AutomationError(
        503,
        'AutomationTemplateVersionUnavailable',
        'Pinned template version is unavailable.',
        true,
      )
    }
    if (application.kind === 'project') {
      const target = application.target
      if (template.kind !== 'project' || target.kind !== 'project') {
        throw new AutomationError(503, 'AutomationTemplateApplicationInvalid', 'Project template application is invalid.')
      }
      const names = readLocalizedNames(template.payload)
      const result = {
        kind: 'project' as const,
        teamId: target.teamId,
        projectId: application.id,
        name: names.nameJa,
      }
      const response = await projectDirectory.createProject(
        principal.directoryId,
        target.teamId,
        {
          ...template.payload,
          idempotencyResourceId: application.id,
        },
        {
          userKey: principal.userKey,
          workspaceMemberVersion: principal.workspaceMember.version,
        },
        createApiMutationContext(
          c,
          principal,
          {
            applicationId: application.id,
            target,
            templateId: application.templateId,
            templateVersion: application.templateVersion,
          },
          application.id,
        ),
        [automation.createTemplateApplicationCompletionTransactItem(application, result)],
      )
      await projectWorkspaceSearchDocumentBestEffort(
        () => {
          return createProjectSearchDocument(
            principal.directoryId,
            target.teamId,
            response.project,
            principal.userKey,
            names.nameEn === response.project.name ? undefined : names.nameEn,
          )
        },
        'automation template Project creation',
      )
      return await requireCompletedTemplateApplication(application)
    }

    if (template.kind !== 'workflow' || application.target.kind !== 'workflow') {
      throw new AutomationError(503, 'AutomationTemplateApplicationInvalid', 'Workflow template application is invalid.')
    }
    const target = application.target
    const resolved = target.scopeType === 'workspace'
      ? await workItemConfigurations.getWorkspaceConfiguration(application.workspaceId)
      : await workItemConfigurations.getTeamConfiguration(
          application.workspaceId,
          target.scopeId,
        )
    const storedTargetRevision = target.scopeType === 'team' && resolved.inheritedFrom
      ? 0
      : resolved.configuration.revision
    if (storedTargetRevision !== target.expectedRevision) {
      throw new WorkItemConfigurationError(
        409,
        'WorkItemConfigurationRevisionConflict',
        'Work Item configuration changed. Reload and try again.',
      )
    }
    const configuration = validateWorkItemConfiguration({
      ...resolved.configuration,
      scopeType: target.scopeType,
      scopeId: target.scopeId,
      revision: target.expectedRevision,
      workflow: template.payload,
      ...(target.expectedRevision === 0 ? { updatedAt: undefined } : {}),
    }, {
      scopeType: target.scopeType,
      scopeId: target.scopeId,
    })
    const result = {
      kind: 'workflow',
      scopeType: target.scopeType,
      scopeId: target.scopeId,
      revision: target.expectedRevision + 1,
    } as const
    const completionTransactItems = [
      automation.createTemplateApplicationCompletionTransactItem(application, result),
    ]
    if (target.scopeType === 'workspace') {
      await workItemConfigurations.saveWorkspaceConfiguration(
        application.workspaceId,
        configuration,
        async () => {
          await validateWorkItemConfigurationReferences(application.workspaceId, configuration)
          await validateWorkItemConfigurationUsage(application.workspaceId, configuration)
        },
        completionTransactItems,
      )
    } else {
      await workItemConfigurations.saveTeamConfiguration(
        application.workspaceId,
        target.scopeId,
        configuration,
        async () => {
          await validateWorkItemConfigurationReferences(
            application.workspaceId,
            configuration,
            target.scopeId,
          )
          await validateWorkItemConfigurationUsage(
            application.workspaceId,
            configuration,
            target.scopeId,
          )
        },
        completionTransactItems,
      )
    }
    return await requireCompletedTemplateApplication(application)
  } catch (error) {
    const current = await automation.getTemplateApplication(application.workspaceId, application.id)
      .catch(() => undefined)
    if (current?.status === 'succeeded') return current
    if (
      current?.status === 'running' &&
      current.revision === application.revision &&
      current.runnerLeaseExpiresAt === application.runnerLeaseExpiresAt
    ) {
      await saveTemplateApplicationFailureState(current, error).catch(() => undefined)
    }
    throw error
  }
}

function assertTemplateApplicationNotFailed(application: AutomationTemplateApplication) {
  if (application.status !== 'failed') return
  throw new AutomationError(
    409,
    application.errorCode ?? 'AutomationTemplateApplicationFailed',
    application.errorMessage ?? 'Template application previously failed.',
  )
}

async function requireCompletedTemplateApplication(application: AutomationTemplateApplication) {
  const completed = await automation.getTemplateApplication(application.workspaceId, application.id)
  if (completed?.status === 'succeeded') return completed
  throw new AutomationError(
    503,
    'AutomationTemplateApplicationCompletionUnavailable',
    'Template application completion is not yet available.',
    true,
  )
}

async function saveTemplateApplicationFailureState(
  application: AutomationTemplateApplication,
  error: unknown,
) {
  const {
    runnerLeaseExpiresAt: _runnerLeaseExpiresAt,
    result: _result,
    errorCode: _errorCode,
    errorMessage: _errorMessage,
    ...base
  } = application
  const updatedAt = new Date().toISOString()
  if (!isTerminalTemplateApplicationError(error)) {
    await automation.saveTemplateApplication({
      ...base,
      status: 'pending',
      revision: application.revision + 1,
      updatedAt,
    }, application.revision)
    return
  }
  const failed: AutomationTemplateApplication = {
    ...base,
    status: 'failed',
    revision: application.revision + 1,
    errorCode: error.code,
    errorMessage: error.message,
    updatedAt,
  }
  await automation.saveTemplateApplication(failed, application.revision)
}

function isTerminalTemplateApplicationError(
  error: unknown,
): error is AutomationError | WorkItemConfigurationError | ProjectDataError {
  if (error instanceof AutomationError) return error.status < 500 && !error.retryable
  return (error instanceof WorkItemConfigurationError || error instanceof ProjectDataError) &&
    error.status < 500
}

function createApiBulkOperationAdapter(
  principal: WorkspacePrincipal,
  c: Context,
): BulkOperationAdapter {
  const createBulkMutationContext = (
    metadata: Record<string, unknown>,
    idempotencyKey: string,
  ) => {
    const context = createApiMutationContext(c, principal, metadata, idempotencyKey)
    return {
      ...context,
      requestFingerprint: createRequestFingerprint({
        method: 'POST',
        path: '/internal/automation/bulk-item-mutation',
        body: metadata,
      }),
    }
  }

  const hasBulkMutationAuditProof = async (
    context: MutationAuditContext,
    teamId: string,
    workItemId: string,
    beforeRevision: number,
    afterRevision: number,
  ) => {
    const entityId = createTeamIssueAuditEntityId(teamId, workItemId)
    const eventId = createAuditEventId(
      context,
      'work-item.updated',
      { type: 'work-item', id: entityId },
    )
    const event = await auditEvents.getEvent(principal.directoryId, eventId)
    return isExpectedBulkMutationAuditProof(
      event,
      context,
      principal,
      entityId,
      teamId,
      workItemId,
      beforeRevision,
      afterRevision,
    )
  }

  const loadCurrentItem = async (request: BulkOperationRequest, itemIndex: number) => {
    const item = request.items[itemIndex]
    if (!item) {
      throw new AutomationError(400, 'BulkOperationTargetMissing', 'Bulk operation target is missing.')
    }
    const context = await requireTeamPermission(principal, item.teamId, 'member')
    const detail = await teamIssues.getTeamIssueDetail(
      principal.directoryId,
      item.teamId,
      item.workItemId,
      { consistentIssueRead: true, eventLimit: 0 },
    )
    requireAssignedProjectPermission(
      principal,
      context,
      detail.issue.assignedProjectId,
      'member',
    )
    return { context, detail, item }
  }

  const loadItem = async (request: BulkOperationRequest, itemIndex: number) => {
    const loaded = await loadCurrentItem(request, itemIndex)
    if (loaded.detail.issue.revision !== loaded.item.expectedRevision) {
      throw new AutomationError(
        409,
        'WorkItemRevisionConflict',
        'Work Item changed after it was selected.',
      )
    }
    return loaded
  }

  const prepareAction = async (
    request: BulkOperationRequest,
    itemIndex: number,
  ) => {
    const loaded = await loadItem(request, itemIndex)
    const { action } = request
    let body: UpdateTeamIssueRequestBody

    if (action.type === 'move') {
      body = normalizeTeamIssueInput(
        {
          assignedProjectId: action.targetProjectId,
          expectedRevision: loaded.item.expectedRevision,
        },
        loaded.context.team,
      )
      requireAssignedProjectPermission(
        principal,
        loaded.context,
        action.targetProjectId,
        'member',
      )
    } else if (action.type === 'archive') {
      body = {
        archivedAt: action.archived ? new Date().toISOString() : null,
        archivedBy: action.archived ? principal.userKey : null,
        expectedRevision: loaded.item.expectedRevision,
      }
    } else {
      body = normalizeTeamIssueInput(
        {
          ...action.patch,
          expectedRevision: loaded.item.expectedRevision,
        },
        loaded.context.team,
      )
      requireAssignedProjectPermission(
        principal,
        loaded.context,
        readAssignedProjectId(body.assignedProjectId),
        'member',
      )
    }

    const configuredBody = action.type === 'archive'
      ? body
      : await prepareConfiguredUpdateWorkItem(
          principal.directoryId,
          loaded.item.teamId,
          loaded.detail.issue,
          body,
          await workItemConfigurations.getTeamConfiguration(
            principal.directoryId,
            loaded.item.teamId,
          ),
        )
    if ('assigneeUserId' in configuredBody) {
      await requireActiveWorkspaceAssignee(
        principal.directoryId,
        readTeamIssueAssigneeUserId(configuredBody),
      )
    }
    return { ...loaded, body: configuredBody }
  }

  const canAttemptResponseLossRecovery = (error: unknown) => {
    const failure = normalizeAutomationActionFailure(error)
    return failure.retryable || failure.code === 'WorkItemRevisionConflict' ||
      failure.code === 'ConditionalCheckFailedException'
  }

  const recoverAppliedItem = async (
    request: BulkOperationRequest,
    itemIndex: number,
    checkpoint: BulkOperationItemResult,
  ) => {
    if (!checkpoint.undoPayload) return undefined
    const loaded = await loadCurrentItem(request, itemIndex)
    const resultingRevision = loaded.item.expectedRevision + 1
    if (
      loaded.detail.issue.revision !== resultingRevision ||
      !isBulkActionApplied(loaded.detail.issue, request.action)
    ) return undefined
    const metadata = { bulkAction: request.action, item: loaded.item }
    const context = createBulkMutationContext(
      metadata,
      createBulkItemMutationIdempotencyKey(
        request,
        itemIndex,
        'apply',
        principal.userKey,
      ),
    )
    if (!await hasBulkMutationAuditProof(
      context,
      loaded.item.teamId,
      loaded.item.workItemId,
      loaded.item.expectedRevision,
      resultingRevision,
    )) return undefined
    return {
      resultingRevision,
      undoPayload: structuredClone(checkpoint.undoPayload),
    }
  }

  const recoverUndoneItem = async (
    operation: BulkOperation,
    itemIndex: number,
    request: BulkOperationRequest,
    item: BulkOperationItemResult,
  ) => {
    if (!item.undoPayload || item.resultingRevision === undefined) return undefined
    const loaded = await loadCurrentItem(request, 0)
    const resultingRevision = item.resultingRevision + 1
    if (
      loaded.detail.issue.revision !== resultingRevision ||
      !isAutomationPatchApplied(loaded.detail.issue, item.undoPayload)
    ) return undefined
    const metadata = {
      bulkOperationId: operation.id,
      itemIndex,
      undo: true,
    }
    const context = createBulkMutationContext(
      metadata,
      createBulkUndoMutationIdempotencyKey(operation, itemIndex),
    )
    if (!await hasBulkMutationAuditProof(
      context,
      item.teamId,
      item.workItemId,
      item.resultingRevision,
      resultingRevision,
    )) return undefined
    return { resultingRevision }
  }

  return {
    async preview(request, itemIndex) {
      const prepared = await prepareAction(request, itemIndex)
      return {
        allowed: true,
        undoPayload: createBulkUndoPayload(request.action, prepared.detail.issue),
      }
    },
    async apply(request, itemIndex, checkpoint) {
      let prepared: Awaited<ReturnType<typeof prepareAction>>
      try {
        prepared = await prepareAction(request, itemIndex)
      } catch (error) {
        const recovered = canAttemptResponseLossRecovery(error)
          ? await recoverAppliedItem(request, itemIndex, checkpoint)
          : undefined
        if (recovered) return recovered
        throw error
      }
      let response: UpdateTeamIssueResponse
      try {
        response = await teamIssues.updateTeamIssue(
          principal.directoryId,
          prepared.item.teamId,
          prepared.item.workItemId,
          prepared.body,
          principal.userKey,
          createBulkMutationContext(
            { bulkAction: request.action, item: prepared.item },
            createBulkItemMutationIdempotencyKey(
              request,
              itemIndex,
              'apply',
              principal.userKey,
            ),
          ),
        )
      } catch (error) {
        const recovered = canAttemptResponseLossRecovery(error)
          ? await recoverAppliedItem(request, itemIndex, checkpoint)
          : undefined
        if (recovered) return recovered
        throw error
      }
      await projectWorkItemMutationSearchDocumentBestEffort(
        principal.directoryId,
        response.issue,
        'bulk Work Item update',
      )
      return {
        resultingRevision: response.issue.revision,
        undoPayload: structuredClone(checkpoint.undoPayload),
      }
    },
    async undo(operation, itemIndex) {
      const item = operation.items[itemIndex]
      if (!item?.undoPayload || item.resultingRevision === undefined) {
        throw new AutomationError(409, 'BulkUndoUnavailable', 'Bulk operation item cannot be undone.')
      }
      const request: BulkOperationRequest = {
        workspaceId: operation.workspaceId,
        action: operation.action,
        items: [{
          teamId: item.teamId,
          workItemId: item.workItemId,
          expectedRevision: item.resultingRevision,
        }],
      }
      let loaded: Awaited<ReturnType<typeof loadItem>>
      try {
        loaded = await loadItem(request, 0)
      } catch (error) {
        const recovered = canAttemptResponseLossRecovery(error)
          ? await recoverUndoneItem(operation, itemIndex, request, item)
          : undefined
        if (recovered) return recovered
        throw error
      }
      const body = {
        ...item.undoPayload,
        expectedRevision: item.resultingRevision,
      } as UpdateTeamIssueRequestBody
      const normalizedBody = operation.action.type === 'archive'
        ? body
        : normalizeTeamIssueInput(body, loaded.context.team)
      if ('assignedProjectId' in normalizedBody) {
        requireAssignedProjectPermission(
          principal,
          loaded.context,
          readAssignedProjectId(normalizedBody.assignedProjectId),
          'member',
        )
      }
      const configuredBody = operation.action.type === 'archive'
        ? normalizedBody
        : await prepareConfiguredUpdateWorkItem(
            principal.directoryId,
            item.teamId,
            loaded.detail.issue,
            normalizedBody,
            await workItemConfigurations.getTeamConfiguration(
              principal.directoryId,
              item.teamId,
            ),
          )
      if ('assigneeUserId' in configuredBody) {
        await requireActiveWorkspaceAssignee(
          principal.directoryId,
          readTeamIssueAssigneeUserId(configuredBody),
        )
      }
      let response: UpdateTeamIssueResponse
      try {
        response = await teamIssues.updateTeamIssue(
          principal.directoryId,
          item.teamId,
          item.workItemId,
          configuredBody,
          principal.userKey,
          createBulkMutationContext(
            {
              bulkOperationId: operation.id,
              itemIndex,
              undo: true,
            },
            createBulkUndoMutationIdempotencyKey(operation, itemIndex),
          ),
        )
      } catch (error) {
        const recovered = canAttemptResponseLossRecovery(error)
          ? await recoverUndoneItem(operation, itemIndex, request, item)
          : undefined
        if (recovered) return recovered
        throw error
      }
      await projectWorkItemMutationSearchDocumentBestEffort(
        principal.directoryId,
        response.issue,
        'bulk Work Item undo',
      )
      return { resultingRevision: response.issue.revision }
    },
  }
}

function isExpectedBulkMutationAuditProof(
  event: AuditEventV1 | undefined,
  context: MutationAuditContext,
  principal: WorkspacePrincipal,
  entityId: string,
  teamId: string,
  workItemId: string,
  beforeRevision: number,
  afterRevision: number,
) {
  return event?.directoryId === principal.directoryId &&
    event.workspaceId === principal.directoryId &&
    event.eventType === 'work-item.updated' &&
    event.action === 'updated' &&
    event.idempotencyKeyHash === context.idempotencyKeyHash &&
    event.requestFingerprint === context.requestFingerprint &&
    event.actor.id === principal.actorId &&
    event.actor.kind === 'user' &&
    event.actorUserId === principal.actorId &&
    event.entity.type === 'work-item' &&
    event.entity.id === entityId &&
    event.entityType === 'work-item' &&
    event.entityId === entityId &&
    event.target.type === 'work-item' &&
    event.target.id === entityId &&
    event.targetType === 'work-item' &&
    event.targetId === entityId &&
    event.metadata?.adapter === 'canonical-work-item' &&
    event.metadata.actorMemberKey === principal.userKey &&
    event.metadata.teamId === teamId &&
    event.metadata.issueId === workItemId &&
    event.metadata.beforeRevision === beforeRevision &&
    event.metadata.afterRevision === afterRevision
}

/** Bulk apply の各 Work Item へ衝突しない deterministic mutation key を割り当てます。 */
export function createBulkItemMutationIdempotencyKey(
  request: BulkOperationRequest,
  itemIndex: number,
  phase: 'apply',
  actorMemberKey: string,
) {
  const item = request.items[itemIndex]
  return `bulk_${createHash('sha256').update(JSON.stringify({
    action: request.action,
    item,
    phase,
    actorMemberKey,
    workspaceId: request.workspaceId,
  })).digest('hex')}`
}

function createBulkUndoMutationIdempotencyKey(
  operation: BulkOperation,
  itemIndex: number,
) {
  return `bulk_${createHash('sha256').update(JSON.stringify({
    itemIndex,
    operationId: operation.id,
    phase: 'undo',
    workspaceId: operation.workspaceId,
  })).digest('hex')}`
}

async function projectWorkItemMutationSearchDocumentBestEffort(
  workspaceId: string,
  issue: TeamIssueResponseItem,
  operation: string,
) {
  if (issue.archivedAt) {
    await deleteWorkspaceSearchDocumentBestEffort(
      workspaceId,
      'work-item',
      `team/${issue.teamId}/issue/${issue.id}`,
      operation,
    )
    return
  }
  await projectWorkItemSearchDocumentBestEffort(workspaceId, issue, operation)
}

function createBulkUndoPayload(
  action: BulkOperationRequest['action'],
  issue: TeamIssueResponseItem,
): Record<string, AutomationValue> {
  if (action.type === 'move') {
    return { assignedProjectId: issue.assignedProjectId ?? null }
  }
  if (action.type === 'archive') {
    return {
      archivedAt: issue.archivedAt ?? null,
      archivedBy: issue.archivedBy ?? null,
    }
  }
  const snapshot: Record<string, AutomationValue> = {}
  const issueValues = issue as unknown as Record<string, AutomationValue | undefined>
  for (const field of Object.keys(action.patch)) {
    if (bulkEditableWorkItemFields.has(field)) {
      snapshot[field] = issueValues[field] ?? null
    }
  }
  return snapshot
}

function isBulkActionApplied(
  issue: TeamIssueResponseItem,
  action: BulkOperationRequest['action'],
) {
  if (action.type === 'edit') return isAutomationPatchApplied(issue, action.patch)
  if (action.type === 'move') {
    return automationValuesEqual(issue.assignedProjectId ?? null, action.targetProjectId)
  }
  return action.archived
    ? Boolean(issue.archivedAt) && issue.archivedBy !== undefined
    : issue.archivedAt === undefined && issue.archivedBy === undefined
}

const bulkEditableWorkItemFields = new Set([
  'assignedProjectId',
  'assigneeUserId',
  'customFieldValues',
  'description',
  'dueDate',
  'priority',
  'title',
  'workflowStatusId',
])

/** Durable automation engine が利用する production action executor を返します。 */
export function createAutomationActionExecutor(): AutomationActionExecutor {
  return {
    async execute(action, context) {
      switch (action.type) {
        case 'assign':
          await executeAutomationWorkItemUpdate(
            { assigneeUserId: action.assigneeMemberKey },
            context,
          )
          return
        case 'move':
          await executeAutomationWorkItemUpdate(
            { assignedProjectId: action.targetProjectId },
            context,
          )
          return
        case 'update':
          await executeAutomationWorkItemUpdate(action.patch, context)
          return
        case 'create':
          await executeAutomationWorkItemCreate(action, context)
          return
        case 'comment':
          await executeAutomationComment(action.body, context)
          return
        case 'notify':
          await emitAutomationOutboxEvent(
            'automation.notification.requested',
            action.title,
            action.recipientMemberKeys,
            context,
            { body: action.body ?? '' },
          )
          return
        case 'approval':
          await executeAutomationApproval(action, context)
          return
        case 'webhook':
          await deliverAutomationWebhook(action, context)
      }
    },
  }
}

async function executeAutomationWorkItemUpdate(
  patch: Record<string, AutomationValue>,
  context: AutomationActionExecutionContext,
) {
  const target = readAutomationWorkItemTarget(context.event)
  const detail = await teamIssues.getTeamIssueDetail(
    context.execution.workspaceId,
    target.teamId,
    target.workItemId,
    { consistentIssueRead: true, eventLimit: 0 },
  )
  const unsafeFields = Object.keys(patch).filter((field) => !bulkEditableWorkItemFields.has(field))
  if (unsafeFields.length > 0) {
    throw new AutomationError(
      400,
      'AutomationUpdateFieldUnsupported',
      `Automation cannot update fields: ${unsafeFields.join(', ')}.`,
    )
  }
  const body = {
    ...patch,
    expectedRevision: detail.issue.revision,
  } as UpdateTeamIssueRequestBody
  const team = await requireAutomationTeam(context.execution.workspaceId, target.teamId)
  const configuredBody = await prepareConfiguredUpdateWorkItem(
    context.execution.workspaceId,
    target.teamId,
    detail.issue,
    normalizeTeamIssueInput(body, team),
    await workItemConfigurations.getTeamConfiguration(
      context.execution.workspaceId,
      target.teamId,
    ),
  )
  if ('assigneeUserId' in configuredBody) {
    await requireActiveWorkspaceAssignee(
      context.execution.workspaceId,
      readTeamIssueAssigneeUserId(configuredBody),
    )
  }
  const mutationContext = createAutomationMutationContext(context, patch)
  let updatedIssue: TeamIssueResponseItem
  try {
    const response = await teamIssues.updateTeamIssue(
      context.execution.workspaceId,
      target.teamId,
      target.workItemId,
      configuredBody,
      `automation:${context.execution.ruleId}`,
      mutationContext,
    )
    updatedIssue = response.issue
  } catch (error) {
    const current = await teamIssues.getTeamIssueDetail(
      context.execution.workspaceId,
      target.teamId,
      target.workItemId,
      { consistentIssueRead: true, eventLimit: 0 },
    ).catch(() => undefined)
    const resultingRevision = detail.issue.revision + 1
    if (
      !current ||
      current.issue.revision !== resultingRevision ||
      !isAutomationPatchApplied(current.issue, patch) ||
      !await hasAutomationMutationAuditProof(
        mutationContext,
        target.teamId,
        target.workItemId,
        detail.issue.revision,
        resultingRevision,
      )
    ) throw error
    updatedIssue = current.issue
  }
  await projectWorkItemSearchDocumentBestEffort(
    context.execution.workspaceId,
    updatedIssue,
    'automation Work Item update',
  )
}

async function hasAutomationMutationAuditProof(
  context: MutationAuditContext,
  teamId: string,
  workItemId: string,
  beforeRevision: number,
  afterRevision: number,
) {
  const entityId = createTeamIssueAuditEntityId(teamId, workItemId)
  const eventId = createAuditEventId(
    context,
    'work-item.updated',
    { type: 'work-item', id: entityId },
  )
  const event = await auditEvents.getEvent(context.workspaceId, eventId)
  return event?.directoryId === context.workspaceId &&
    event.workspaceId === context.workspaceId &&
    event.eventType === 'work-item.updated' &&
    event.action === 'updated' &&
    event.idempotencyKeyHash === context.idempotencyKeyHash &&
    event.requestFingerprint === context.requestFingerprint &&
    event.actor.id === context.actor.id &&
    event.actor.kind === 'service' &&
    event.actorUserId === context.actor.id &&
    event.entity.type === 'work-item' &&
    event.entity.id === entityId &&
    event.entityType === 'work-item' &&
    event.entityId === entityId &&
    event.target.type === 'work-item' &&
    event.target.id === entityId &&
    event.targetType === 'work-item' &&
    event.targetId === entityId &&
    event.metadata?.adapter === 'canonical-work-item' &&
    event.metadata.actorMemberKey === context.actor.id &&
    event.metadata.teamId === teamId &&
    event.metadata.issueId === workItemId &&
    event.metadata.beforeRevision === beforeRevision &&
    event.metadata.afterRevision === afterRevision
}

async function executeAutomationWorkItemCreate(
  action: Extract<AutomationAction, { type: 'create' }>,
  context: AutomationActionExecutionContext,
) {
  const templateVersion = action.templateVersion
  const template = action.templateId && templateVersion !== undefined && Number.isSafeInteger(templateVersion)
    ? await automation.getTemplateVersion(
        context.execution.workspaceId,
        action.templateId,
        templateVersion,
      )
    : undefined
  if (action.templateId && (!template || !template.enabled || template.kind !== 'work-item')) {
    throw new AutomationError(
      409,
      'AutomationTemplateUnavailable',
      'The selected Work Item template is unavailable.',
    )
  }
  const values: Record<string, AutomationValue> = {
    ...(template?.kind === 'work-item' ? template.payload : {}),
    ...action.values,
  }
  const teamId = readAutomationText(values.teamId) ?? readAutomationMetadataText(context.event, 'teamId')
  if (!teamId) {
    throw new AutomationError(400, 'AutomationTargetMissing', 'Create action requires a Team ID.')
  }
  const body = { ...values }
  delete body.teamId
  body.idempotencyResourceId = `${context.execution.id}_create_${context.actionIndex}`
  const team = await requireAutomationTeam(context.execution.workspaceId, teamId)
  const configuredBody = await prepareConfiguredCreateWorkItem(
    context.execution.workspaceId,
    teamId,
    normalizeTeamIssueInput(body as CreateTeamIssueRequestBody, team),
    await workItemConfigurations.getTeamConfiguration(context.execution.workspaceId, teamId),
  )
  const assignee = readTeamIssueAssigneeUserId(configuredBody)
  await requireActiveWorkspaceAssignee(context.execution.workspaceId, assignee)
  const response = await teamIssues.createTeamIssue(
    context.execution.workspaceId,
    teamId,
    configuredBody,
    `automation:${context.execution.ruleId}`,
    createAutomationMutationContext(context, values),
  )
  await projectWorkItemSearchDocumentBestEffort(
    context.execution.workspaceId,
    response.issue,
    'automation Work Item creation',
    [],
  )
}

async function requireAutomationTeam(workspaceId: string, teamId: string) {
  const directory = await projectDirectory.getProjectDirectory(workspaceId, 'en', true)
  const team = directory.teams.find((candidate) => candidate.id === teamId)
  if (!team) {
    throw new AutomationError(
      409,
      'AutomationTeamUnavailable',
      'The selected Work Item Team is unavailable.',
    )
  }
  return team
}

/** Automation action から durable Work Item approval を一度だけ作成します。 */
async function executeAutomationApproval(
  action: Extract<AutomationAction, { type: 'approval' }>,
  context: AutomationActionExecutionContext,
) {
  const target = readAutomationWorkItemTarget(context.event)
  const detail = await teamIssues.getTeamIssueDetail(
    context.execution.workspaceId,
    target.teamId,
    target.workItemId,
    { consistentIssueRead: true, eventLimit: 0 },
  )
  const team = await requireAutomationTeam(context.execution.workspaceId, target.teamId)
  if (
    detail.issue.assignedProjectId &&
    !team.projects.some((project) => project.id === detail.issue.assignedProjectId)
  ) {
    throw new AutomationError(
      409,
      'AutomationApprovalTargetUnavailable',
      'The approval Work Item project is not active in its owner Team.',
    )
  }
  const reviewerMemberKeys = action.reviewerMemberKeys.map((memberKey) => memberKey.trim().toLowerCase())
  await requireApprovalReviewers(
    context.execution.workspaceId,
    target.teamId,
    detail.issue.assignedProjectId,
    reviewerMemberKeys,
  )
  if (action.completionStatusId) {
    await resolveFileApprovalCompletionTransition(
      context.execution.workspaceId,
      target.teamId,
      detail.issue,
      action.completionStatusId,
    )
  }
  const executionStartedAtEpoch = Date.parse(context.execution.startedAt)
  if (!Number.isFinite(executionStartedAtEpoch)) {
    throw new AutomationError(
      503,
      'AutomationExecutionStateInvalid',
      'Automation execution start time is invalid.',
    )
  }
  const input = {
    reviewerMemberKeys,
    dueAt: new Date(executionStartedAtEpoch + action.dueInHours * 3_600_000).toISOString(),
    ...(action.completionStatusId ? { completionTransition: action.completionStatusId } : {}),
  }
  await fileProofing.createWorkItemApproval(
    {
      workspaceId: context.execution.workspaceId,
      teamId: target.teamId,
      kind: 'work-item',
      issueId: target.workItemId,
      ...(detail.issue.assignedProjectId
        ? { projectId: detail.issue.assignedProjectId }
        : {}),
    },
    {
      memberKey: `automation:${context.execution.ruleId}`,
      kind: 'service',
      guest: false,
      canWrite: true,
      canManage: true,
    },
    input,
    createAutomationMutationContext(context, {
      subjectType: 'work-item',
      teamId: target.teamId,
      workItemId: target.workItemId,
      ...input,
    }),
  )
}

async function executeAutomationComment(
  body: string,
  context: AutomationActionExecutionContext,
) {
  const target = readAutomationWorkItemTarget(context.event)
  await requireAutomationTeam(context.execution.workspaceId, target.teamId)
  await teamIssues.createTeamIssueComment(
    context.execution.workspaceId,
    target.teamId,
    target.workItemId,
    {
      body,
      idempotencyEventId: `${context.execution.id}_comment_${context.actionIndex}`,
    },
    `automation:${context.execution.ruleId}`,
    createAutomationMutationContext(context, { body }),
  )
}

async function emitAutomationOutboxEvent(
  eventType: string,
  summary: string,
  recipientMemberKeys: string[],
  context: AutomationActionExecutionContext,
  metadata: Record<string, AutomationValue>,
) {
  const tableName = getConfiguredAuditTableName()
  if (!tableName) {
    throw new AutomationError(503, 'AutomationAuditUnavailable', 'Audit outbox is not configured.', true)
  }
  const target = readOptionalAutomationWorkItemTarget(context.event)
  const event = createAuditEvent({
    context: createAutomationMutationContext(context, metadata),
    eventType,
    entity: {
      type: target ? 'work-item' : 'automation-execution',
      id: target ? `${target.teamId}#${target.workItemId}` : context.execution.id,
    },
    summary,
    expiresAt: calculateAuditExpiresAt(new Date().toISOString(), 365),
    metadata: {
      ...metadata,
      ...(target ? { teamId: target.teamId, issueId: target.workItemId } : {}),
      automationRuleLineage: createAutomationRuleLineage(context),
      notificationTitle: summary,
      notificationCandidates: recipientMemberKeys.map((memberKey) => ({
        memberKey,
        reason: eventType === 'approval.requested' ? 'approval' : 'automation',
      })),
    },
  })
  try {
    await createDynamoDbDocumentClient().send(new PutCommand({
      TableName: tableName,
      Item: event,
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(eventId)',
    }))
  } catch (error) {
    if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) {
      throw new AutomationError(503, 'AutomationAuditUnavailable', 'Audit outbox write failed.', true)
    }
  }
}

function createAutomationMutationContext(
  context: AutomationActionExecutionContext,
  body: unknown,
) {
  return createMutationAuditContext({
    workspaceId: context.execution.workspaceId,
    actor: {
      id: `automation:${context.execution.ruleId}`,
      kind: 'service',
      displayName: 'mukuroji automation',
    },
    idempotencyKey: context.idempotencyKey,
    correlationId: context.execution.id,
    request: {
      method: 'AUTOMATION',
      path: `/automation/executions/${context.execution.id}/actions/${context.actionIndex}`,
      body,
    },
    source: {
      kind: 'system',
      requestId: context.execution.id,
      route: `automation-lineage:${createAutomationRuleLineage(context).join(',')}`,
    },
  })
}

function createAutomationRuleLineage(context: AutomationActionExecutionContext) {
  return [...(context.event.automationRuleLineage ?? []), context.execution.ruleId]
}

function readAutomationWorkItemTarget(event: AutomationEvent) {
  const target = readOptionalAutomationWorkItemTarget(event)
  if (!target) {
    throw new AutomationError(400, 'AutomationTargetMissing', 'Action requires a Work Item target.')
  }
  return target
}

function readOptionalAutomationWorkItemTarget(event: AutomationEvent) {
  const teamId = readAutomationMetadataText(event, 'teamId') ?? readAutomationText(event.workItem?.teamId)
  const workItemId = readAutomationMetadataText(event, 'issueId') ??
    readAutomationMetadataText(event, 'workItemId') ??
    readAutomationText(event.workItem?.id)
  return teamId && workItemId ? { teamId, workItemId } : undefined
}

function readAutomationMetadataText(event: AutomationEvent, key: string) {
  return readAutomationText(event.metadata?.[key])
}

function readAutomationText(value: AutomationValue | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isAutomationPatchApplied(
  issue: TeamIssueResponseItem,
  patch: Record<string, AutomationValue>,
) {
  const current = issue as unknown as Record<string, unknown>
  return Object.entries(patch).every(([field, expected]) =>
    automationValuesEqual(current[field] ?? null, expected)
  )
}

function automationValuesEqual(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true
  if (Array.isArray(first) && Array.isArray(second)) {
    return first.length === second.length &&
      first.every((value, index) => automationValuesEqual(value, second[index]))
  }
  if (isRecord(first) && isRecord(second)) {
    const firstKeys = Object.keys(first).sort()
    const secondKeys = Object.keys(second).sort()
    return firstKeys.length === secondKeys.length &&
      firstKeys.every((key, index) =>
        key === secondKeys[index] && automationValuesEqual(first[key], second[key])
      )
  }
  return false
}

async function readPlanningJson<T>(request: { json: () => Promise<unknown> }) {
  const body = await readJson<unknown>(request)
  if (!isRecord(body)) {
    throw new PlanningError(
      400,
      'InvalidPlanningInput',
      'A JSON object request body is required.',
    )
  }
  return body as T
}

function readPlanningRouteId(value: string | undefined, label: string) {
  return readPlanningIdentifier(value, label)
}

function readPlanningIdentifier(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 256
  ) {
    throw new PlanningError(400, 'InvalidPlanningInput', `${label} is required.`)
  }
  return value
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
  idempotencyKeyOverride?: string,
): MutationAuditContext {
  try {
    return createRequestMutationContext(
      c,
      principal.directoryId,
      principal.actorId,
      principal.userKey,
      body,
      idempotencyKeyOverride,
    )
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new ProjectDataError(400, 'InvalidProjectWrite', error.message)
    }

    throw error
  }
}

function createWorkspaceMutationContext(
  c: Context,
  principal: ProjectPrincipal,
  body: unknown,
) {
  return createWorkspaceMutationContextForActor(
    c,
    principal.directoryId,
    principal.actorId,
    principal.userKey,
    body,
  )
}

function createWorkspaceMutationContextForActor(
  c: Context,
  workspaceId: string,
  actorId: string,
  displayName: string,
  body: unknown,
) {
  try {
    return createRequestMutationContext(c, workspaceId, actorId, displayName, body)
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new WorkspaceAccessError(
        400,
        'InvalidWorkspaceMutation',
        error.message,
      )
    }

    throw error
  }
}

function createRequestMutationContext(
  c: Context,
  workspaceId: string,
  actorId: string,
  displayName: string,
  body: unknown,
  idempotencyKeyOverride?: string,
) {
  const idempotencyKey = idempotencyKeyOverride ??
    (c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID())
  const correlationId = c.req.header('X-Correlation-Id')?.trim()
  const path = new URL(c.req.url).pathname

  return createMutationAuditContext({
    workspaceId,
    actor: {
      id: actorId,
      kind: 'user',
      displayName,
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
}

function createOptionalAuditTransactItems(
  tableName: string | undefined,
  context: MutationAuditContext | undefined,
  input: MutationAuditEventInput,
) {
  const item = createMutationAuditEventPut(tableName, context, input)

  return item ? [item] : []
}

function createRequestConversionTransactionItems(
  input: RequestConversionTransactionInput,
  teamId: string,
  workItemId: string,
  projectId: string | undefined,
  now: string,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Request conversion revision is invalid.',
    )
  }
  const workItem = {
    teamId,
    workItemId,
    ...(projectId ? { projectId } : {}),
  }
  const event = {
    id: `event_${now.replace(/[-:.TZ]/gu, '')}_${workItemId}`,
    type: 'converted',
    actorId: input.actorId,
    summary: 'Request was converted to a Work Item.',
    createdAt: now,
  } satisfies RequestSubmissionEvent
  return [
    {
      Update: {
        TableName: input.tableName,
        Key: { scopeKey: input.scopeKey, recordKey: input.recordKey },
        UpdateExpression:
          'SET #status = :converted, #revision = :nextRevision, workItem = :workItem, updatedAt = :updatedAt, capabilities = :capabilities, events = :events',
        ConditionExpression:
          '#revision = :expectedRevision AND (#status = :received OR #status = :triaging OR #status = :needsMoreInfo)',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#revision': 'revision',
        },
        ExpressionAttributeValues: {
          ':converted': 'converted',
          ':nextRevision': input.expectedRevision + 1,
          ':workItem': workItem,
          ':updatedAt': now,
          ':capabilities': {
            canAssign: false,
            canRequestMoreInfo: false,
            canReject: false,
            canMarkDuplicate: false,
            canConvert: false,
          },
          ':events': createRequestSubmissionEventProjection(input.events, event),
          ':expectedRevision': input.expectedRevision,
          ':received': 'received',
          ':triaging': 'triaging',
          ':needsMoreInfo': 'needs-more-info',
        },
      },
    },
    createRequestSubmissionEventTransactionPut(
      input.tableName,
      input.scopeKey,
      input.submissionId,
      event,
    ),
  ]
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

async function createAuthenticationResponse(
  tokens: AuthTokenSet,
  c: Context,
  requestBody: Readonly<Record<string, unknown>>,
  requestAuditContext?: MutationAuditContext,
) {
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
    const auditContext = requestAuditContext ?? createWorkspaceMutationContext(
      c,
      principal,
      requestBody,
    )
    await workspaceAccess.reconcileAuthenticatedMember(principal.directoryId, {
      memberKey: principal.userKey,
      email: readUserAttribute(user, 'email') ?? principal.userKey,
      name: readUserAttribute(user, 'name'),
    }, auditContext)
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
    const auditContext = createWorkspaceMutationContext(
      c,
      principal,
      { action, invitationId },
    )
    const preparedInvitation = action === 'resend'
      ? await workspaceAccess.prepareResend(
          principal.directoryId,
          principal.userKey,
          invitationId,
          undefined,
          auditContext,
        )
      : await workspaceAccess.prepareReinvite(
          principal.directoryId,
          principal.userKey,
          invitationId,
          undefined,
          auditContext,
        )

    const deliveryState = { invitation: preparedInvitation }

    try {
      const result = await deliverPreparedWorkspaceInvitation(
        principal.directoryId,
        deliveryState,
        action === 'resend' || preparedInvitation.identityOwnership !== 'ambiguous',
        auditContext,
      )
      deliveryState.invitation = {
        ...deliveryState.invitation,
        identityOwnership: result.identityOwnership,
        cognitoIdentityId: result.cognitoIdentityId,
        cognitoUsername: result.cognitoUsername,
        directoryClaimCleanupRequired: result.directoryClaimCleanupRequired || undefined,
      }
      const invitation = await workspaceAccess.markInvitationDelivery(
        principal.directoryId,
        deliveryState.invitation.id,
        {
          expectedVersion: deliveryState.invitation.version,
          identityOwnership: result.identityOwnership,
          cognitoIdentityId: result.cognitoIdentityId,
          cognitoUsername: result.cognitoUsername,
          directoryClaimCleanupRequired: result.directoryClaimCleanupRequired,
          deliveryStatus: result.deliveryStatus,
        },
        auditContext,
      )

      return c.json({ invitation })
    } catch (error) {
      await markWorkspaceInvitationFailure(
        principal.directoryId,
        deliveryState.invitation,
        error,
        auditContext,
      )
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
  state: { invitation: WorkspaceInvitation },
  preserveIdentityOwnership = false,
  auditContext?: MutationAuditContext,
) {
  const existingUser = await cognito.findWorkspaceUser(state.invitation.email)
  const previousCognitoIdentityId = state.invitation.cognitoIdentityId
  state.invitation = await workspaceAccess.markInvitationIdentityMutationStarted(
    directoryId,
    state.invitation.id,
    state.invitation.version,
    existingUser?.identityId,
    existingUser?.profile.username,
    auditContext,
  )
  const markDirectoryClaimCleanupRequired = async (
    cognitoIdentityId: string,
    cognitoUsername: string,
  ) => {
    state.invitation = await workspaceAccess.markInvitationDirectoryClaimCleanupRequired(
      directoryId,
      state.invitation.id,
      state.invitation.version,
      cognitoIdentityId,
      cognitoUsername,
      auditContext,
    )
  }

  if (existingUser?.profile.status === 'FORCE_CHANGE_PASSWORD') {
    const result = await cognito.provisionWorkspaceUser({
      directoryId,
      email: state.invitation.email,
      name: state.invitation.name,
      existingUser,
      beforeDirectoryClaimUpdate: markDirectoryClaimCleanupRequired,
    })
    await cognito.resendWorkspaceUserInvitation(existingUser.profile.username)
    const preservesInvitationIdentity = preserveIdentityOwnership &&
      previousCognitoIdentityId !== undefined &&
      previousCognitoIdentityId === result.cognitoIdentityId

    return {
      identityOwnership: preservesInvitationIdentity
        ? state.invitation.identityOwnership
        : result.identityOwnership,
      cognitoIdentityId: result.cognitoIdentityId,
      cognitoUsername: result.cognitoUsername,
      directoryClaimCleanupRequired: result.directoryClaimCleanupRequired ||
        (preservesInvitationIdentity && state.invitation.directoryClaimCleanupRequired === true),
      deliveryStatus: 'sent' as const,
    }
  }

  const result = await cognito.provisionWorkspaceUser({
    directoryId,
    email: state.invitation.email,
    name: state.invitation.name,
    existingUser,
    beforeDirectoryClaimUpdate: markDirectoryClaimCleanupRequired,
  })
  const preservesInvitationIdentity = preserveIdentityOwnership &&
    previousCognitoIdentityId !== undefined &&
    previousCognitoIdentityId === result.cognitoIdentityId

  return {
    identityOwnership: preservesInvitationIdentity
      ? state.invitation.identityOwnership
      : result.identityOwnership,
    cognitoIdentityId: result.cognitoIdentityId,
    cognitoUsername: result.cognitoUsername,
    directoryClaimCleanupRequired: result.directoryClaimCleanupRequired ||
      (preservesInvitationIdentity && state.invitation.directoryClaimCleanupRequired === true),
    deliveryStatus: result.deliveryStatus,
  }
}

async function markWorkspaceInvitationFailure(
  directoryId: string,
  invitation: WorkspaceInvitation,
  error: unknown,
  auditContext?: MutationAuditContext,
) {
  console.error('Workspace invitation delivery failed:', error)

  try {
    await workspaceAccess.markInvitationDelivery(directoryId, invitation.id, {
      expectedVersion: invitation.version,
      identityOwnership: invitation.identityOwnership,
      cognitoIdentityId: invitation.cognitoIdentityId,
      cognitoUsername: invitation.cognitoUsername,
      directoryClaimCleanupRequired: invitation.directoryClaimCleanupRequired,
      deliveryStatus: 'failed',
      failureMessage: 'Invitation delivery failed.',
    }, auditContext)
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

  if (error.code === 'CognitoUserDisabled') {
    return c.json({ code: 'CognitoUserDisabled' as const, message: error.message }, 409)
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

function toWorkItemConfigurationErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }
  if (
    error instanceof WorkspaceAccessError ||
    error instanceof ProjectDataError ||
    isTeamIssueNotFoundError(error)
  ) {
    return toProjectDataErrorResponse(c, error)
  }
  if (!(error instanceof WorkItemConfigurationError)) {
    console.error(error)
    return c.json({ message: 'Work Item configuration is unavailable.' }, 502)
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

function toPlanningErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }
  if (
    error instanceof WorkspaceAccessError ||
    error instanceof ProjectDataError ||
    isTeamIssueNotFoundError(error)
  ) {
    return toProjectDataErrorResponse(c, error)
  }
  if (!(error instanceof PlanningError)) {
    console.error(error)
    return c.json({ message: 'Planning data is unavailable.' }, 502)
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

async function requireRequestAdministration(c: Context) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    throw new RequestIntakeError(401, 'RequestAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken)
  requireWorkspaceAdministration(principal)
  return principal
}

async function authorizeRequestLink(c: Context, resolution: RequestLinkResolution) {
  if (resolution.accessMode === 'public') return
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    throw new RequestIntakeError(
      401,
      'RequestAuthenticationRequired',
      'Authentication is required for this request form.',
    )
  }
  const principal = await authenticateWorkspacePrincipal(accessToken)
  if (principal.directoryId !== resolution.workspaceId) {
    throw new RequestIntakeError(404, 'RequestFormUnavailable', 'Request form is unavailable.')
  }
}

/**
 * Transport source と明示的に信頼した proxy 一覧から rate-limit client key を解決します。
 */
export function resolveRequestClientKey(
  transportSource: string | undefined,
  forwardedFor: string | undefined,
  trustedProxyAddresses: ReadonlySet<string>,
) {
  const normalizedTransportSource = transportSource?.trim()
  if (normalizedTransportSource && trustedProxyAddresses.has(normalizedTransportSource)) {
    const forwardedSource = forwardedFor
      ?.split(',')
      .map((entry) => entry.trim())
      .find(Boolean)
    if (forwardedSource) return forwardedSource
  }
  return normalizedTransportSource || 'transport-unavailable'
}

function createRequestExternalContext(c: Context): RequestExternalContext {
  let trustedSource: string | undefined
  try {
    trustedSource = getConnInfo(c).remote.address
  } catch {
    trustedSource = undefined
  }
  const trustedProxyAddresses = new Set(
    (getEnv('MUKUROJI_REQUEST_TRUSTED_PROXY_ADDRESSES') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  const source = resolveRequestClientKey(
    trustedSource,
    c.req.header('X-Forwarded-For'),
    trustedProxyAddresses,
  )
  return {
    clientKey: source,
    ...(c.req.header('Idempotency-Key')?.trim()
      ? { idempotencyKey: c.req.header('Idempotency-Key')!.trim() }
      : {}),
  }
}

function readRequestSubmissionStatus(value: string | undefined) {
  if (value === undefined) return undefined
  if (
    value === 'received' ||
    value === 'triaging' ||
    value === 'needs-more-info' ||
    value === 'rejected' ||
    value === 'duplicate' ||
    value === 'converted'
  ) return value
  throw new RequestIntakeError(400, 'InvalidRequestIntakeInput', 'Request status is invalid.')
}

async function validateRequestFormRoutingReferences(
  workspaceId: string,
  draft: RequestFormDraft,
) {
  const targets = [draft.routing.defaultTarget, ...draft.routing.rules.map((rule) => rule.target)]
  const configurations = new Map<string, WorkItemConfiguration>()
  for (const target of targets) {
    const configuration = await validateRequestRoutingTarget(workspaceId, target)
    configurations.set(target.teamId, configuration)
  }
  for (const [formFieldId, customFieldId] of Object.entries(
    draft.routing.mapping.customFieldMappings ?? {},
  )) {
    const formField = draft.definition.sections.flatMap((section) => section.fields)
      .find((field) => field.id === formFieldId)
    for (const target of targets) {
      const configuration = configurations.get(target.teamId)!
      const customField = configuration.customFields.find((definition) => definition.id === customFieldId)
      if (!customField) {
        throw new RequestIntakeError(
          400,
          'InvalidRequestRouting',
          `Custom field "${customFieldId}" is not active for Team "${target.teamId}".`,
        )
      }
      if (
        customField.projectIds &&
        (!target.projectId || !customField.projectIds.includes(target.projectId))
      ) {
        throw new RequestIntakeError(
          400,
          'InvalidRequestRouting',
          `Custom field "${customFieldId}" is not active for the routed Project.`,
        )
      }
      if (!formField || !isCompatibleRequestCustomField(formField, customField)) {
        throw new RequestIntakeError(
          400,
          'InvalidRequestRouting',
          `Form field "${formFieldId}" is not compatible with custom field "${customFieldId}".`,
        )
      }
    }
  }
}

function isCompatibleRequestCustomField(
  formField: RequestFormField,
  customField: CustomFieldDefinition,
) {
  if (
    formField.type === 'short-text' ||
    formField.type === 'long-text' ||
    formField.type === 'email' ||
    formField.type === 'url'
  ) return customField.type === 'text'
  if (formField.type === 'number') {
    return customField.type === 'number' || customField.type === 'currency' || customField.type === 'duration'
  }
  if (formField.type === 'boolean') return customField.type === 'boolean'
  if (formField.type === 'date') return customField.type === 'date'
  if (formField.type === 'single-select') {
    const allowedOptions = new Set(customField.options?.map((option) => option.id) ?? [])
    return customField.type === 'select' &&
      (formField.options ?? []).every((option) => allowedOptions.has(option.id))
  }
  if (formField.type === 'multi-select') {
    const allowedOptions = new Set(customField.options?.map((option) => option.id) ?? [])
    return customField.type === 'multi-select' &&
      (formField.options ?? []).every((option) => allowedOptions.has(option.id))
  }
  return false
}

async function validateRequestRoutingTarget(
  workspaceId: string,
  target: RequestFormRoutingTarget,
) {
  const directory = await projectDirectory.getProjectDirectory(workspaceId, 'ja')
  const team = directory.teams.find((candidate) => candidate.id === target.teamId)
  if (!team) {
    throw new RequestIntakeError(400, 'InvalidRequestRouting', 'Request routing Team is inactive.')
  }
  if (target.projectId && !team.projects.some((project) => project.id === target.projectId)) {
    throw new RequestIntakeError(400, 'InvalidRequestRouting', 'Request routing Project is inactive.')
  }
  await requireActiveWorkspaceAssignee(workspaceId, target.assigneeUserId)
  const resolved = await workItemConfigurations.getTeamConfiguration(workspaceId, target.teamId)
  resolveWorkflowStatus(resolved.configuration, target.workflowStatusId)
  return resolved.configuration
}

function toRequestIntakeErrorResponse(
  c: Context,
  error: unknown,
  publicBoundary = false,
) {
  if (
    publicBoundary &&
    (
      error instanceof CognitoServiceError && error.status >= 500 ||
      error instanceof FileProofingError && error.status >= 500 ||
      error instanceof RequestIntakeError && error.status >= 500
    )
  ) {
    console.error(error)
    return c.json({ code: 'RequestIntakeUnavailable', message: 'Request intake is unavailable.' }, 503)
  }
  if (error instanceof CognitoServiceError) return toAuthErrorResponse(c, error)
  if (error instanceof WorkspaceAccessError) {
    if (publicBoundary) {
      return c.json(
        { code: 'RequestAuthenticationRequired', message: 'Authentication is required for this request form.' },
        401,
      )
    }
    return toWorkspaceAccessErrorResponse(c, error)
  }
  if (
    error instanceof ProjectDataError ||
    error instanceof WorkItemConfigurationError
  ) return toWorkItemConfigurationErrorResponse(c, error)
  if (error instanceof FileProofingError) {
    const status = error.status === 400 || error.status === 403 || error.status === 404 ||
      error.status === 409 || error.status === 413 || error.status === 422 || error.status === 503
      ? error.status
      : 502
    return c.json({ code: error.code, message: error.message }, status)
  }
  if (!(error instanceof RequestIntakeError)) {
    console.error(error)
    return c.json({ code: 'RequestIntakeUnavailable', message: 'Request intake is unavailable.' }, 503)
  }
  if (error.status >= 500) console.error(error)
  if (
    publicBoundary &&
    (
      error.code === 'RequestFormUnavailable' ||
      error.code === 'RequestCapabilityUnavailable' ||
      error.code === 'RequestThreadUnavailable'
    )
  ) {
    return c.json({ code: 'RequestFormUnavailable', message: 'Request form is unavailable.' }, 404)
  }
  const status = error.status === 400 || error.status === 401 || error.status === 403 ||
    error.status === 404 || error.status === 409 || error.status === 413 ||
    error.status === 422 || error.status === 429 || error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
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

function requirePlanningAuthorizationRevision(
  currentRevision: number,
  expectedRevision: unknown,
) {
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw new PlanningError(
      400,
      'InvalidPlanningInput',
      'Planning expectedRevision must be a non-negative safe integer.',
    )
  }
  if (currentRevision !== expectedRevision) {
    throw new PlanningError(
      409,
      'PlanningRevisionConflict',
      'Planning changed. Reload and try again.',
    )
  }
}

async function requirePlanningActiveOwner(
  principal: WorkspacePrincipal,
  ownerMemberKey: unknown,
) {
  const memberKey = readPlanningIdentifier(ownerMemberKey, 'Planning owner member key')
  const owner = await workspaceAccess.getActiveMember(principal.directoryId, memberKey)
  if (!owner) {
    throw new PlanningError(
      409,
      'PlanningOwnerInactive',
      'Planning owner must be an active Workspace member.',
    )
  }
}

async function requirePlanningScopePermission(
  principal: WorkspacePrincipal,
  scope: Pick<PlanningEntity, 'teamId' | 'projectId'>,
  minimumRole: Extract<ProjectRole, 'member' | 'manager'>,
  allowWorkspaceScopeMember = false,
) {
  requireWorkspaceBusinessWrite(principal)
  const teamId = scope.teamId === undefined
    ? undefined
    : readPlanningIdentifier(scope.teamId, 'Team ID')
  const projectId = scope.projectId === undefined
    ? undefined
    : readPlanningIdentifier(scope.projectId, 'Project ID')
  const teamContext = teamId
    ? await requireTeamPermission(principal, teamId, minimumRole)
    : undefined
  if (projectId) {
    await requireProjectPermission(principal, projectId, minimumRole)
  }
  if (
    teamContext &&
    projectId &&
    !teamContext.team.projects.some((project) => project.id === projectId)
  ) {
    throw new PlanningError(
      409,
      'PlanningScopeMismatch',
      'Planning Team and Project scopes do not belong to the same hierarchy.',
    )
  }
  if (!teamId && !projectId && !principal.isSystemAdmin && !allowWorkspaceScopeMember) {
    requireWorkspaceAdministration(principal)
  }
}

async function requirePlanningEntityPermission(
  principal: WorkspacePrincipal,
  entities: readonly PlanningEntity[],
  entityId: unknown,
  minimumRole: Extract<ProjectRole, 'member' | 'manager'>,
  allowWorkspaceScopeMember = false,
) {
  const normalizedEntityId = readPlanningIdentifier(entityId, 'Planning entity ID')
  const entity = entities.find((candidate) => candidate.id === normalizedEntityId)
  if (!entity) {
    throw new PlanningError(404, 'PlanningEntityNotFound', 'Planning entity was not found.')
  }
  await requirePlanningScopePermission(
    principal,
    entity,
    minimumRole,
    allowWorkspaceScopeMember,
  )
  return entity
}

async function requirePlanningLinkEntityPermissions(
  principal: WorkspacePrincipal,
  entities: readonly PlanningEntity[],
  link: Pick<PlanningWorkItemLinkInput, 'cycleId' | 'milestoneId' | 'goalIds'>,
) {
  const goalIds: unknown = link.goalIds
  if (!Array.isArray(goalIds)) {
    throw new PlanningError(400, 'InvalidPlanningInput', 'Goal IDs must be an array.')
  }
  const entityIds = new Set([
    ...(link.cycleId === undefined
      ? []
      : [readPlanningIdentifier(link.cycleId, 'Cycle ID')]),
    ...(link.milestoneId === undefined
      ? []
      : [readPlanningIdentifier(link.milestoneId, 'Milestone ID')]),
    ...goalIds.map((goalId) => readPlanningIdentifier(goalId, 'Goal ID')),
  ])
  await Promise.all(
    [...entityIds].map((entityId) =>
      requirePlanningEntityPermission(principal, entities, entityId, 'member', true)
    ),
  )
}

function collectActivePlanningDescendants(
  entities: readonly PlanningEntity[],
  rootEntityId: string,
) {
  const descendants: PlanningEntity[] = []
  const childrenByParent = new Map<string, PlanningEntity[]>()
  for (const entity of entities) {
    if (!entity.parentId) continue
    const children = childrenByParent.get(entity.parentId) ?? []
    children.push(entity)
    childrenByParent.set(entity.parentId, children)
  }
  const pending = [rootEntityId]
  const visited = new Set<string>(pending)
  while (pending.length > 0) {
    const parentId = pending.pop()!
    for (const entity of childrenByParent.get(parentId) ?? []) {
      if (visited.has(entity.id)) continue
      visited.add(entity.id)
      pending.push(entity.id)
      if (!entity.archivedAt) descendants.push(entity)
    }
  }
  return descendants
}

/** Search と saved view authorization に使う current directory snapshot です。 */
type WorkspaceSearchContext = {
  /** Active Team/Project hierarchy です。 */
  directory: ProjectDirectoryResponse
  /** Search result の current viewer scope です。 */
  searchAccess: WorkspaceSearchAccessScope
  /** Saved view の current viewer scope です。 */
  savedViewAccess: SavedViewAccessScope
}

async function createWorkspaceSearchContext(
  principal: WorkspacePrincipal,
): Promise<WorkspaceSearchContext> {
  const directory = await projectDirectory.getProjectDirectory(principal.directoryId, 'ja', true)
  const projectAccesses = principal.isSystemAdmin
    ? directory.teams.flatMap((team) => team.projects.map((project) => ({
        projectId: project.id,
        role: 'manager' as const,
      })))
    : await projectDirectory.getProjectAccessList(principal.directoryId, principal.userKey)
  const readableProjectIds = new Set(
    projectAccesses
      .filter((access) => projectAccessAllows(access, 'viewer'))
      .map((access) => access.projectId),
  )
  const manageableProjectIds = new Set(
    projectAccesses
      .filter((access) => projectAccessAllows(access, 'manager'))
      .map((access) => access.projectId),
  )
  const readableTeamIds = new Set(
    directory.teams
      .filter((team) => team.projects.some((project) => readableProjectIds.has(project.id)))
      .map((team) => team.id),
  )
  const manageableTeamIds = new Set(
    directory.teams
      .filter((team) => team.projects.some((project) => manageableProjectIds.has(project.id)))
      .map((team) => team.id),
  )

  return {
    directory,
    searchAccess: {
      viewerUserId: principal.userKey,
      isSystemAdmin: principal.isSystemAdmin,
      projectIds: readableProjectIds,
      teamIds: readableTeamIds,
    },
    savedViewAccess: {
      viewerUserId: principal.userKey,
      isSystemAdmin: principal.isSystemAdmin,
      canManageSharedViews:
        principal.isSystemAdmin ||
        principal.workspaceRole === 'owner' ||
        principal.workspaceRole === 'admin',
      canWrite: principal.workspaceRole !== 'guest',
      teamIds: readableTeamIds,
      manageableTeamIds,
    },
  }
}

async function resolveCurrentWorkspaceSearchScope(
  workspaceId: string,
  document: WorkspaceSearchDocument,
  context: WorkspaceSearchContext,
  scopeCache: Map<string, Promise<TeamIssueDetailResponse | undefined>>,
) {
  if (document.entityType === 'team') {
    const team = context.directory.teams.find((candidate) => candidate.id === document.teamId)
    return team ? { teamId: team.id } : undefined
  }

  if (document.entityType === 'project') {
    const team = context.directory.teams.find((candidate) =>
      (!document.teamId || candidate.id === document.teamId) &&
      candidate.projects.some((project) => project.id === document.projectId)
    )
    return team && document.projectId
      ? { teamId: team.id, projectId: document.projectId }
      : undefined
  }

  const workItemId = document.entityType === 'work-item'
    ? document.entityId
    : document.parentId
  const parsed = parseSearchWorkItemEntityId(workItemId)
  if (parsed) {
    const activeTeam = context.directory.teams.find((team) => team.id === parsed.teamId)
    if (!activeTeam) return undefined
    const cacheKey = `${parsed.teamId}\0${parsed.issueId}`
    let pending = scopeCache.get(cacheKey)
    if (!pending) {
      pending = teamIssues.getTeamIssueDetail(
        workspaceId,
        parsed.teamId,
        parsed.issueId,
        { consistentIssueRead: true, eventLimit: 0 },
      ).catch((error) => {
        if (isTeamIssueNotFoundError(error)) return undefined
        throw error
      })
      scopeCache.set(cacheKey, pending)
    }
    const detail = await pending
    if (
      !detail ||
      (detail.issue.assignedProjectId &&
        !activeTeam.projects.some((project) => project.id === detail.issue.assignedProjectId))
    ) {
      return undefined
    }
    const scope = {
      teamId: parsed.teamId,
      ...(detail.issue.assignedProjectId ? { projectId: detail.issue.assignedProjectId } : {}),
    }
    if (document.entityType === 'work-item') {
      const relationPage = await workItemConfigurations.listRelations(
        workspaceId,
        parsed.teamId,
        parsed.issueId,
      )
      return {
        ...scope,
        currentDocument: createWorkItemSearchDocument(
          workspaceId,
          detail.issue,
          createWorkItemRelationIds(relationPage.relations, parsed.issueId),
        ),
      }
    }
    if (document.entityType !== 'comment') return scope
    const parsedComment = parseSearchCommentEntityId(document.entityId, document.parentId)
    if (
      !parsedComment ||
      parsedComment.teamId !== parsed.teamId ||
      parsedComment.issueId !== parsed.issueId
    ) {
      return undefined
    }
    const comment = await collaboration.getCommentSnapshot({
      entityKey: createWorkItemCollaborationEntityKey(
        workspaceId,
        parsed.teamId,
        parsed.issueId,
      ),
      commentId: parsedComment.commentId,
    })
    if (!comment || comment.deletedAt) return undefined
    return {
      ...scope,
      currentDocument: createCommentSearchDocument(
        workspaceId,
        parsed.teamId,
        detail.issue,
        comment,
      ),
    }
  }

  if (document.projectId) {
    const team = context.directory.teams.find((candidate) =>
      (!document.teamId || candidate.id === document.teamId) &&
      candidate.projects.some((project) => project.id === document.projectId)
    )
    return team ? { teamId: team.id, projectId: document.projectId } : undefined
  }
  if (document.teamId && context.directory.teams.some((team) => team.id === document.teamId)) {
    return { teamId: document.teamId }
  }
  return undefined
}

function parseSearchWorkItemEntityId(value: string | undefined) {
  const match = value?.match(/^team\/([^/]+)\/issue\/([^/]+)$/u)
  return match?.[1] && match[2]
    ? { teamId: match[1], issueId: match[2] }
    : undefined
}

function parseSearchCommentEntityId(
  value: string,
  parentId: string | undefined,
) {
  const match = value.match(/^team\/([^/]+)\/issue\/([^/]+)\/comment\/([^/]+)$/u)
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  const expectedParentId = createTeamIssueAuditEntityId(match[1], match[2])
  return parentId === expectedParentId
    ? { teamId: match[1], issueId: match[2], commentId: match[3] }
    : undefined
}

function readWorkspaceSearchFilters(value: string | undefined): WorkspaceSearchFilters {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (!isRecord(parsed)) throw new TypeError('Search filters must be an object.')
    return parsed as WorkspaceSearchFilters
  } catch (error) {
    throw new WorkspaceSearchError(400, 'InvalidSearchFilters', 'Search filters are invalid.', {
      cause: error,
    })
  }
}

function readOptionalPositiveQueryInteger(value: string | undefined, label: string) {
  if (value === undefined) return undefined
  return readRequiredPositiveQueryInteger(value, label)
}

function readRequiredPositiveQueryInteger(value: string | undefined, label: string) {
  const parsed = value ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WorkspaceSearchError(400, 'InvalidWorkspaceSearch', `${label} must be a positive integer.`)
  }
  return parsed
}

function toWorkspaceSearchErrorResponse(c: Context, error: unknown) {
  if (error instanceof WorkspaceSearchError) {
    const status = error.status === 400 || error.status === 403 || error.status === 404 ||
      error.status === 409 || error.status === 503
      ? error.status
      : 502
    return c.json({ code: error.code, message: error.message }, status)
  }
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(c, error)
  if (error instanceof CognitoServiceError) return toAuthErrorResponse(c, error)
  return toProjectDataErrorResponse(c, error)
}

async function requireTeamConfigurationAdministration(
  principal: WorkspacePrincipal,
  teamId: string,
) {
  if (
    principal.isSystemAdmin ||
    principal.workspaceRole === 'owner' ||
    principal.workspaceRole === 'admin'
  ) {
    await requireTeamPermission(principal, teamId, 'viewer')
    return
  }
  await requireTeamPermission(principal, teamId, 'manager')
}

async function authorizeRelationMutation(
  principal: WorkspacePrincipal,
  teamId: string,
  sourceWorkItemId: string,
  targetWorkItemId: string,
) {
  const context = await requireTeamPermission(principal, teamId, 'member')
  const [source, target] = await Promise.all([
    teamIssues.getTeamIssueDetail(principal.directoryId, teamId, sourceWorkItemId, {
      consistentIssueRead: true,
      eventLimit: 0,
    }),
    teamIssues.getTeamIssueDetail(principal.directoryId, teamId, targetWorkItemId, {
      consistentIssueRead: true,
      eventLimit: 0,
    }),
  ])
  requireAssignedProjectPermission(principal, context, source.issue.assignedProjectId, 'member')
  requireAssignedProjectPermission(principal, context, target.issue.assignedProjectId, 'member')
  return { source: source.issue, target: target.issue }
}

/** Relation target のみを入力順を保った bounded concurrency で取得します。 */
async function readRelationTargets(
  principal: WorkspacePrincipal,
  teamId: string,
  targetWorkItemIds: readonly string[],
) {
  const targets: Array<readonly [string, TeamIssueResponseItem]> = []

  for (
    let offset = 0;
    offset < targetWorkItemIds.length;
    offset += WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY
  ) {
    const batch = targetWorkItemIds.slice(
      offset,
      offset + WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY,
    )
    const batchTargets = await Promise.all(batch.map(async (targetWorkItemId) => {
      try {
        const detail = await teamIssues.getTeamIssueDetail(
          principal.directoryId,
          teamId,
          targetWorkItemId,
          { consistentIssueRead: true, eventLimit: 0 },
        )
        return [targetWorkItemId, detail.issue] as const
      } catch (error) {
        if (isTeamIssueNotFoundError(error)) {
          throw new WorkItemConfigurationError(
            503,
            'WorkItemRelationInconsistent',
            'A relation target Work Item is missing.',
          )
        }
        throw error
      }
    }))
    targets.push(...batchTargets)
  }

  return targets
}

async function filterVisibleWorkItemRelations(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  teamId: string,
  relations: readonly WorkItemRelation[],
) {
  if (relations.length === 0) {
    return []
  }

  const targetWorkItemIds = [...new Set(
    relations.map((relation) => relation.targetWorkItemId),
  )]
  const targets = await readRelationTargets(principal, teamId, targetWorkItemIds)
  const workItemsById = new Map(targets)

  return relations.filter((relation) => {
    const target = workItemsById.get(relation.targetWorkItemId)
    if (!target) {
      throw new WorkItemConfigurationError(
        503,
        'WorkItemRelationInconsistent',
        'A relation target Work Item is missing.',
      )
    }
    return canAccessAssignedProject(
      principal,
      context,
      target.assignedProjectId,
      'viewer',
    )
  })
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

async function requireWorkspaceMemberHasNoOwnedPlanningEntities(
  directoryId: string,
  memberKey: string,
) {
  const authorizationState = await planning.getAuthorizationState(directoryId)
  const ownedEntity = authorizationState.entities.find(
    (entity) => !entity.archivedAt && entity.ownerMemberKey === memberKey,
  )
  if (ownedEntity) {
    throw new WorkspaceAccessError(
      409,
      'WorkspaceMemberOwnsPlanningEntities',
      'Transfer or archive all owned Planning entities before deactivating this member.',
    )
  }
  return authorizationState.revision
}

async function requirePlanningTeamScopeIsUnused(directoryId: string, teamId: string) {
  const authorizationState = await planning.getAuthorizationState(directoryId)
  const scopedEntity = authorizationState.entities.find((entity) =>
    !entity.archivedAt && entity.teamId === teamId
  )
  const scopedLink = authorizationState.workItemLinks.find((link) => link.teamId === teamId)
  if (scopedEntity || scopedLink) {
    throw new WorkspaceAccessError(
      409,
      'PlanningTeamScopeInUse',
      'Move or archive active Planning entities and remove Work Item links before archiving this Team.',
    )
  }
  return authorizationState.revision
}

async function requirePlanningProjectScopeIsUnused(
  directoryId: string,
  teamId: string,
  projectId: string,
) {
  const authorizationState = await planning.getAuthorizationState(directoryId)
  const scopedEntity = authorizationState.entities.find(
    (entity) =>
      !entity.archivedAt && entity.teamId === teamId && entity.projectId === projectId,
  )
  const scopedLink = authorizationState.workItemLinks.find(
    (link) => link.teamId === teamId && link.projectId === projectId,
  )
  if (scopedEntity || scopedLink) {
    throw new WorkspaceAccessError(
      409,
      'PlanningProjectScopeInUse',
      'Move or archive active Planning entities and remove Work Item links before archiving this Project.',
    )
  }
  return authorizationState.revision
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

function toNotificationErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toAuthErrorResponse(c, error)
  }
  if (!(error instanceof NotificationError)) {
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

function toAutomationErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }
  if (error instanceof WorkspaceAccessError || error instanceof ProjectDataError) {
    return toProjectDataErrorResponse(c, error)
  }
  if (error instanceof WorkItemConfigurationError) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
  if (error instanceof FileProofingError) {
    return toFileProofingErrorResponse(c, error)
  }
  if (!(error instanceof AutomationError)) {
    console.error(error)
    return c.json({ message: 'Automation data is unavailable.' }, 502)
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 415 ||
    error.status === 422 ||
    error.status === 423 ||
    error.status === 429 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

function readNotificationAction(value: unknown): NotificationAction {
  if (
    value === 'mark-read' ||
    value === 'mark-unread' ||
    value === 'archive' ||
    value === 'restore' ||
    value === 'snooze'
  ) {
    return value
  }
  throw new NotificationError(400, 'InvalidNotificationAction', 'Notification action is invalid.')
}

function readOptionalNotificationTimestamp(value: unknown) {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new NotificationError(400, 'InvalidNotificationSnooze', 'Snooze time is invalid.')
  }
  return value.trim()
}

function readNotificationPreferencesInput(
  value: Record<string, unknown>,
): UpdateNotificationPreferencesInput {
  const channels = isRecord(value.channels) ? value.channels : {}
  const quietHours = isRecord(value.quietHours) ? value.quietHours : {}

  return {
    version: Number(value.version),
    channels: {
      inApp: channels.inApp as boolean,
      email: channels.email as boolean,
      push: channels.push as boolean,
    },
    frequency: value.frequency as UpdateNotificationPreferencesInput['frequency'],
    quietHours: {
      enabled: quietHours.enabled as boolean,
      start: quietHours.start as string,
      end: quietHours.end as string,
      timeZone: quietHours.timeZone as string,
    },
  }
}

const currentAssigneeNotificationReasons = new Set([
  'assignee',
  'assignment',
  'due',
  'due-date-change',
  'overdue',
  'status-change',
])

/** Notification が現在の担当者であることだけを配信理由にしているか判定します。 */
function requiresCurrentWorkItemAssignee(notification: NotificationItem) {
  return notification.reasons.length > 0 && notification.reasons.every(
    (reason) => currentAssigneeNotificationReasons.has(reason),
  )
}

async function createNotificationVisibilityFilter(
  principal: WorkspacePrincipal,
) {
  const directory = await projectDirectory.getProjectDirectory(principal.directoryId, 'ja', true)
  const activeTeamIds = new Set(directory.teams.map((team) => team.id))
  const projectTeamIds = new Map<string, Set<string>>()
  for (const team of directory.teams) {
    for (const project of team.projects) {
      const teamIds = projectTeamIds.get(project.id) ?? new Set<string>()
      teamIds.add(team.id)
      projectTeamIds.set(project.id, teamIds)
    }
  }
  const accessibleProjectIds = principal.isSystemAdmin
    ? new Set(projectTeamIds.keys())
    : new Set(
        (await projectDirectory.getProjectAccessList(principal.directoryId, principal.userKey))
          .filter((access) => projectAccessAllows(access, 'viewer') && projectTeamIds.has(access.projectId))
          .map((access) => access.projectId),
      )
  const accessibleTeamIds = principal.isSystemAdmin
    ? activeTeamIds
    : new Set(
        [...accessibleProjectIds]
          .flatMap((projectId) => [...(projectTeamIds.get(projectId) ?? [])]),
      )
  const workItemScopes = new Map<string, Promise<{
    assigneeMemberKey?: string
    exists: boolean
    projectId?: string
  }>>()

  return async (notification: NotificationItem) => {
    if (notification.teamId && notification.issueId) {
      const scopeKey = `${notification.teamId}\0${notification.issueId}`
      let scope = workItemScopes.get(scopeKey)
      if (!scope) {
        scope = teamIssues.getTeamIssueDetail(
          principal.directoryId,
          notification.teamId,
          notification.issueId,
          { consistentIssueRead: true, eventLimit: 0 },
        ).then((detail) => {
          return {
            assigneeMemberKey: detail.issue.assigneeUserId.trim().toLowerCase(),
            exists: true,
            ...(detail.issue.assignedProjectId
              ? { projectId: detail.issue.assignedProjectId }
              : {}),
          }
        }).catch((error: unknown) => {
          if (isTeamIssueNotFoundError(error)) {
            return { exists: false }
          }
          throw error
        })
        workItemScopes.set(scopeKey, scope)
      }
      const currentScope = await scope
      if (!currentScope.exists) {
        return false
      }
      if (
        requiresCurrentWorkItemAssignee(notification) &&
        currentScope.assigneeMemberKey !== principal.userKey
      ) {
        return false
      }
      if (currentScope.projectId) {
        notification.projectId = currentScope.projectId
        return projectTeamIds.get(currentScope.projectId)?.has(notification.teamId) === true &&
          accessibleProjectIds.has(currentScope.projectId)
      }
      delete notification.projectId
      return activeTeamIds.has(notification.teamId) && accessibleTeamIds.has(notification.teamId)
    }
    if (notification.projectId) {
      const teamIds = projectTeamIds.get(notification.projectId)
      return teamIds !== undefined &&
        (!notification.teamId || teamIds.has(notification.teamId)) &&
        accessibleProjectIds.has(notification.projectId)
    }
    if (notification.teamId) {
      return activeTeamIds.has(notification.teamId) && accessibleTeamIds.has(notification.teamId)
    }
    return true
  }
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

  if (error.code === 'InvalidWorkItemArchiveUpdate') {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (error.code === 'WorkItemListLimitExceeded') {
    return c.json({ code: error.code, message: error.message }, 413)
  }

  if (error.code === 'InvalidProjectWrite' ||
    error.code === 'InvalidWorkItemConfiguration' ||
    error.code === 'InvalidCustomFieldValue' ||
    error.code === 'InvalidAuditQuery' ||
    error.code === 'InvalidCommentMention' ||
    error.code === 'InvalidPlanningRevision' ||
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

  if (error.code === 'WorkItemConfigurationRevisionConflict') {
    return c.json({
      code: error.code,
      message: 'Work Item configuration changed. Reload and try again.',
    }, 409)
  }

  if (error.code === 'PlanningRevisionConflict') {
    return c.json({ code: error.code, message: error.message }, 409)
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
  workItem?: TeamIssueResponseItem
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
        canManage: principal.workspaceRole !== 'guest' &&
          canManageTeamIssueCollaboration(
            principal,
            context,
            detail.issue.assignedProjectId,
          ),
      },
      workItem: detail.issue,
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
  const canManage = principal.workspaceRole !== 'guest' && (
    canModerateCollaboration(principal) ||
    (projectAccess !== undefined && projectAccessAllows(projectAccess, 'manager'))
  )

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

/** File approval mutation が canonical Work Item だけを対象にすることを保証します。 */
function requireCanonicalFileProofingWorkItem(
  workItem: TeamIssueResponseItem | undefined,
) {
  if (!workItem) {
    throw new FileProofingError(
      404,
      'WorkItemNotFound',
      'Work Item was not found.',
    )
  }
  return workItem
}

/** Approval の保存済み遷移先を現在の workflow と Work Item revision に固定します。 */
async function resolveFileApprovalCompletionTransition(
  directoryId: string,
  teamId: string,
  workItem: ReturnType<typeof requireCanonicalFileProofingWorkItem>,
  completionTransition: string,
) {
  try {
    const resolved = await workItemConfigurations.getTeamConfiguration(directoryId, teamId)
    const currentStatus = resolveWorkflowStatus(
      resolved.configuration,
      workItem.workflowStatusId,
    )
    const nextStatus = resolveWorkflowStatus(resolved.configuration, completionTransition)
    assertWorkflowTransitionAllowed(
      resolved.configuration,
      currentStatus.workflowStatusId,
      nextStatus.workflowStatusId,
    )
    return {
      workflowStatusId: nextStatus.workflowStatusId,
      statusCategory: nextStatus.statusCategory,
      workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
      expectedRevision: workItem.revision,
      configurationConditionChecks: createWorkItemConfigurationGuardConditionChecks(
        getWorkItemConfigurationTableName(),
        directoryId,
        teamId,
        resolved,
      ),
    }
  } catch (error) {
    if (error instanceof WorkItemConfigurationError) {
      throw new FileProofingError(error.status, error.code, error.message, { cause: error })
    }
    throw error
  }
}

/** Approval 作成後に削除・無効化された遷移先を decision conflict として扱います。 */
async function resolveFileApprovalCompletionTransitionForDecision(
  directoryId: string,
  teamId: string,
  workItem: ReturnType<typeof requireCanonicalFileProofingWorkItem>,
  completionTransition: string,
) {
  try {
    return await resolveFileApprovalCompletionTransition(
      directoryId,
      teamId,
      workItem,
      completionTransition,
    )
  } catch (error) {
    if (
      error instanceof FileProofingError &&
      (error.code === 'InvalidWorkflowStatus' || error.code === 'WorkflowTransitionDenied')
    ) {
      return undefined
    }
    throw error
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
  const scopes = hydratedItems.map((workItem) => ({
    workspaceId: directoryId,
    teamId: workItem.teamId,
    kind: 'work-item' as const,
    issueId: workItem.id,
  }))
  const summaries = scopes.length > 0 &&
    (getEnv('FILE_PROOFING_TABLE_NAME') || getConfiguredDynamoDbEndpoint())
    ? await fileProofing.getApprovalSummaries(scopes)
    : new Map<string, ApprovalSummary>()
  const workItems = hydratedItems.map((workItem) => {
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

function createWorkItemSearchDocument(
  workspaceId: string,
  issue: TeamIssueResponseItem,
  relationIds: readonly string[],
) {
  return createWorkItemWorkspaceSearchDocument({
    workspaceId,
    teamId: issue.teamId,
    issueId: issue.id,
    title: issue.title,
    ...(issue.description ? { body: issue.description } : {}),
    ...(issue.assignedProjectId ? { projectId: issue.assignedProjectId } : {}),
    ...(issue.assigneeUserId ? { assigneeUserId: issue.assigneeUserId } : {}),
    ...(issue.creatorMemberKey ? { creatorUserId: issue.creatorMemberKey } : {}),
    status: issue.workflowStatusId,
    customFields: issue.customFieldValues,
    relationIds: [...relationIds],
    dueDate: issue.dueDate,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  })
}

function createCommentSearchDocument(
  workspaceId: string,
  teamId: string,
  issue: TeamIssueResponseItem,
  comment: CollaborationComment,
) {
  return createCommentWorkspaceSearchDocument({
    workspaceId,
    teamId,
    issueId: issue.id,
    commentId: comment.id,
    body: comment.bodyMarkdown,
    creatorUserId: comment.authorMemberKey,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  })
}

function createTeamSearchDocument(
  workspaceId: string,
  team: ProjectDirectoryTeamResponse,
  creatorUserId?: string,
  subtitle?: string,
) {
  return createTeamWorkspaceSearchDocument({
    workspaceId,
    teamId: team.id,
    title: team.name,
    ...(subtitle ? { subtitle } : {}),
    ...(creatorUserId ? { creatorUserId } : {}),
  })
}

function createProjectSearchDocument(
  workspaceId: string,
  teamId: string,
  project: ProjectDirectoryProjectResponse,
  creatorUserId?: string,
  subtitle?: string,
) {
  return createProjectWorkspaceSearchDocument({
    workspaceId,
    teamId,
    projectId: project.id,
    title: project.name,
    ...(subtitle ? { subtitle } : {}),
    ...(creatorUserId ? { creatorUserId } : {}),
  })
}

async function projectWorkspaceSearchDocumentBestEffort(
  createDocument: () => WorkspaceSearchDocument,
  operation: string,
) {
  if (!workspaceSearchProjectionEnabled) return
  try {
    await workspaceSearch.upsertDocument(createDocument())
  } catch (error) {
    console.error(`Workspace search projection failed after ${operation}.`, error)
  }
}

/** Relation graph の現在値を含む Work Item search document を best effort で反映します。 */
async function projectWorkItemSearchDocumentBestEffort(
  workspaceId: string,
  issue: TeamIssueResponseItem,
  operation: string,
  relationIds?: readonly string[],
) {
  if (!workspaceSearchProjectionEnabled) return
  try {
    const currentRelationIds = relationIds ?? createWorkItemRelationIds(
      (await workItemConfigurations.listRelations(workspaceId, issue.teamId, issue.id)).relations,
      issue.id,
    )
    await workspaceSearch.upsertDocument(
      createWorkItemSearchDocument(workspaceId, issue, currentRelationIds),
    )
  } catch (error) {
    console.error(`Workspace search projection failed after ${operation}.`, error)
  }
}

/** Mutation 後の Work Item と relation graph を強整合 read して search へ反映します。 */
async function refreshWorkItemSearchDocumentBestEffort(
  workspaceId: string,
  teamId: string,
  issueId: string,
  operation: string,
) {
  if (!workspaceSearchProjectionEnabled) return
  try {
    const [detail, relationPage] = await Promise.all([
      teamIssues.getTeamIssueDetail(workspaceId, teamId, issueId, {
        consistentIssueRead: true,
        eventLimit: 0,
      }),
      workItemConfigurations.listRelations(workspaceId, teamId, issueId),
    ])
    await workspaceSearch.upsertDocument(createWorkItemSearchDocument(
      workspaceId,
      detail.issue,
      createWorkItemRelationIds(relationPage.relations, issueId),
    ))
  } catch (error) {
    console.error(`Workspace search projection failed after ${operation}.`, error)
  }
}

async function deleteWorkspaceSearchDocumentBestEffort(
  workspaceId: string,
  entityType: WorkspaceSearchDocument['entityType'],
  entityId: string,
  operation: string,
) {
  if (!workspaceSearchProjectionEnabled) return
  try {
    await workspaceSearch.deleteDocument(workspaceId, entityType, entityId)
  } catch (error) {
    console.error(`Workspace search projection delete failed after ${operation}.`, error)
  }
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
  if (!getEnv('FILE_PROOFING_TABLE_NAME') && !getConfiguredDynamoDbEndpoint()) {
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
) {
  const storedIssues = await teamIssues.getTeamIssues(directoryId, context.team.id)

  return {
    teamId: context.team.id,
    issues: filterAccessibleTeamIssues(storedIssues.issues, principal, context),
  } satisfies TeamIssuesResponse
}

async function readCanonicalTeamIssuesForAggregate(
  directoryId: string,
  context: TeamPermissionContext,
  principal: ProjectPrincipal,
) {
  const clientReadLimit = createWorkItemListProbeLimit(WORK_ITEMS_PARTITION_SCAN_LIMIT)
  const storedIssues = await teamIssues.getTeamIssues(
    directoryId,
    context.team.id,
    { limit: clientReadLimit, consistentRead: true },
  )
  assertWorkItemListWithinLimit(
    storedIssues.issues,
    WORK_ITEMS_PARTITION_SCAN_LIMIT,
    `Team "${context.team.id}" canonical partition`,
  )

  return {
    teamId: context.team.id,
    issues: filterAccessibleTeamIssues(storedIssues.issues, principal, context),
  } satisfies TeamIssuesResponse
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

  const workItemsById = new Map<string, TeamIssueResponseItem>()

  for (const context of contexts) {
    const response = await readCanonicalTeamIssuesForAggregate(
      principal.directoryId,
      context,
      principal,
    )
    for (const workItem of response.issues) {
      addAggregateWorkItem(workItemsById, workItem)
    }
  }

  return { workItems: [...workItemsById.values()] }
}

/**
 * Export 専用に、一覧画面の Team/item hard cap を使わず全 accessible partition を走査します。
 *
 * `DynamoDbTeamIssuesClient.getTeamIssues` は各 Team partition の LastEvaluatedKey を内部で
 * 最終 page まで辿ります。ここでは Team を一つずつ処理し、無制限な並列 Query を避けます。
 */
async function readAccessibleWorkItemsForExport(
  principal: ProjectPrincipal,
): Promise<TeamIssueResponseItem[]> {
  const directory = await projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const projectAccesses = principal.isSystemAdmin
    ? undefined
    : await projectDirectory.getProjectAccessList(principal.directoryId, principal.userKey)
  const workItems: TeamIssueResponseItem[] = []

  for (const team of directory.teams) {
    const context: TeamPermissionContext | undefined = principal.isSystemAdmin
      ? { team, directory }
      : (() => {
          const teamProjectIds = new Set(team.projects.map((project) => project.id))
          const teamProjectAccesses = (projectAccesses ?? []).filter((access) =>
            teamProjectIds.has(access.projectId)
          )
          return teamProjectAccesses.some((access) => projectAccessAllows(access, 'viewer'))
            ? { team, directory, projectAccesses: teamProjectAccesses }
            : undefined
        })()
    if (!context) continue

    const response = await teamIssues.getTeamIssues(
      principal.directoryId,
      team.id,
      { consistentRead: true },
    )
    workItems.push(...filterAccessibleTeamIssues(response.issues, principal, context))
  }

  return workItems
}

async function readPlanningWorkItemState(
  principal: ProjectPrincipal,
): Promise<PlanningWorkItemState> {
  const response = await readAccessibleWorkItems(principal)
  return {
    workItems: response.workItems.map((workItem) => ({
      id: workItem.id,
      revision: workItem.revision,
      teamId: workItem.teamId,
      title: workItem.title,
      ...(workItem.assignedProjectId
        ? { projectId: workItem.assignedProjectId }
        : {}),
      statusCategory: workItem.statusCategory,
      dueDate: workItem.dueDate,
    } satisfies PlanningWorkItemSummary)),
  }
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

async function readProjectIssues(directoryId: string, projectId: string) {
  return teamIssues.getProjectIssues(directoryId, projectId)
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
export class AwsCognitoClient implements CognitoClient {
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
   * NEW_PASSWORD_REQUIRED challenge に恒久 password を応答します。
   */
  async respondToNewPasswordChallenge(
    email: string,
    newPassword: string,
    session: string,
  ): Promise<InitiateAuthResponse> {
    const { clientId } = this.readRequiredConfiguration()

    try {
      const response = await this.client.send(new RespondToAuthChallengeCommand({
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        ChallengeResponses: {
          USERNAME: normalizeCognitoUserId(email),
          NEW_PASSWORD: newPassword,
        },
        ClientId: clientId,
        Session: session,
      }))

      return {
        AuthenticationResult: response.AuthenticationResult,
        ChallengeName: response.ChallengeName,
        Session: response.Session,
        ChallengeParameters: response.ChallengeParameters,
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
   * Workspace invitation 対象の Cognito user と directory 属性を検索します。
   */
  async findWorkspaceUser(userId: string): Promise<CognitoWorkspaceUser | undefined> {
    return this.findWorkspaceUserByUsername(normalizeCognitoUserId(userId))
  }

  /** Cognito username または stable sub を大文字小文字を変えずに検索します。 */
  private async findWorkspaceUserByUsername(
    username: string,
  ): Promise<CognitoWorkspaceUser | undefined> {
    const { userPoolId } = this.readRequiredConfiguration()
    const normalizedUsername = requireCognitoUsername(username)

    try {
      const user = await this.client.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: normalizedUsername,
      }))
      const profile = toCognitoUserProfile(user)

      if (!profile) {
        throw new CognitoServiceError(
          502,
          'InvalidCognitoResponse',
          `Cognito user "${normalizedUsername}" did not include a stable profile.`,
        )
      }

      return {
        profile,
        identityId: readCognitoUserAttribute(user, 'sub')?.trim() || undefined,
        directoryId: readCognitoUserDirectoryId(user),
      }
    } catch (error) {
      const cognitoError = toCognitoSdkError(error)

      if (isCognitoUserNotFoundError(cognitoError)) {
        return undefined
      }

      throw cognitoError
    }
  }

  /**
   * invitation 対象 user を Cognito に作成または既存 identity と安全に関連付けます。
   */
  async provisionWorkspaceUser(
    input: ProvisionCognitoWorkspaceUserInput,
  ): Promise<ProvisionCognitoWorkspaceUserResult> {
    const { userPoolId } = this.readRequiredConfiguration()
    const email = normalizeCognitoUserId(input.email)
    const existingUser = input.existingUser ?? await this.findWorkspaceUser(email)

    if (existingUser) {
      this.requireCompatibleWorkspaceDirectory(existingUser, input.directoryId)
      requireEnabledWorkspaceUser(existingUser)
      const cognitoIdentityId = requireCognitoIdentityId(existingUser.identityId)
      if (!existingUser.directoryId) {
        await input.beforeDirectoryClaimUpdate(
          cognitoIdentityId,
          existingUser.profile.username,
        )
      }
      await this.updateWorkspaceUserAttributes(
        existingUser.profile.username,
        email,
        input.directoryId,
        input.name,
      )

      return {
        profile: {
          ...existingUser.profile,
          name: input.name?.trim() || existingUser.profile.name,
        },
        cognitoIdentityId,
        cognitoUsername: requireCognitoUsername(existingUser.profile.username),
        identityOwnership: 'pre-existing',
        directoryClaimCleanupRequired: !existingUser.directoryId,
        deliveryStatus: 'not-required',
      }
    }

    try {
      const response = await this.client.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: createWorkspaceCognitoUserAttributes(email, input.directoryId, input.name),
      }))
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
        cognitoIdentityId: requireCognitoIdentityId(
          response.User ? readCognitoUserAttribute(response.User, 'sub') : undefined,
        ),
        cognitoUsername: requireCognitoUsername(profile?.username ?? email),
        identityOwnership: 'workspace-created',
        directoryClaimCleanupRequired: false,
        deliveryStatus: 'sent',
      }
    } catch (error) {
      const cognitoError = toCognitoSdkError(error)

      if (cognitoError.code !== 'UsernameExistsException') {
        throw cognitoError
      }

      const racedUser = await this.findWorkspaceUser(email)

      if (!racedUser) {
        throw cognitoError
      }

      this.requireCompatibleWorkspaceDirectory(racedUser, input.directoryId)
      requireEnabledWorkspaceUser(racedUser)
      const cognitoIdentityId = requireCognitoIdentityId(racedUser.identityId)
      if (!racedUser.directoryId) {
        await input.beforeDirectoryClaimUpdate(
          cognitoIdentityId,
          racedUser.profile.username,
        )
      }
      await this.updateWorkspaceUserAttributes(
        racedUser.profile.username,
        email,
        input.directoryId,
        input.name,
      )

      if (racedUser.profile.status === 'FORCE_CHANGE_PASSWORD') {
        await this.resendWorkspaceUserInvitation(racedUser.profile.username)
      }

      return {
        profile: racedUser.profile,
        cognitoIdentityId,
        cognitoUsername: requireCognitoUsername(racedUser.profile.username),
        identityOwnership: 'ambiguous',
        directoryClaimCleanupRequired: !racedUser.directoryId,
        deliveryStatus: racedUser.profile.status === 'FORCE_CHANGE_PASSWORD'
          ? 'sent'
          : 'not-required',
      }
    }
  }

  /**
   * Workspace が作成した未確定 Cognito username へ invitation を再送します。
   */
  async resendWorkspaceUserInvitation(username: string): Promise<void> {
    const { userPoolId } = this.readRequiredConfiguration()

    try {
      await this.client.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: requireCognitoUsername(username),
        MessageAction: 'RESEND',
        DesiredDeliveryMediums: ['EMAIL'],
      }))
    } catch (error) {
      throw toCognitoSdkError(error)
    }
  }

  /** Workspace が作成した未確定 user だけを削除します。 */
  async deleteWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<DeleteCognitoWorkspaceUserResult> {
    const { userPoolId } = this.readRequiredConfiguration()
    // Cognito sub を stable lookup key として Username parameter へ意図的に渡します。
    const stableIdentityUsername = requireCognitoIdentityId(input.cognitoIdentityId)
    const canonicalUsername = requireCognitoUsername(input.cognitoUsername)
    const currentUser = await this.findWorkspaceUserByUsername(stableIdentityUsername)

    if (!currentUser && canonicalUsername !== stableIdentityUsername) {
      const canonicalUser = await this.findWorkspaceUserByUsername(canonicalUsername)

      if (!canonicalUser) {
        return 'absent'
      }

      if (!canonicalUser.identityId) {
        return 'manual-required'
      }

      if (canonicalUser.identityId !== input.cognitoIdentityId) {
        return 'absent'
      }

      if (
        canonicalUser.directoryId !== input.directoryId ||
        canonicalUser.profile.status !== 'FORCE_CHANGE_PASSWORD'
      ) {
        return 'preserved'
      }

      return 'manual-required'
    }

    if (!currentUser) {
      return 'absent'
    }

    if (currentUser.identityId !== input.cognitoIdentityId) {
      return 'manual-required'
    }

    if (
      currentUser.directoryId !== input.directoryId ||
      currentUser.profile.status !== 'FORCE_CHANGE_PASSWORD'
    ) {
      return 'preserved'
    }

    try {
      await this.client.send(new AdminDeleteUserCommand({
        UserPoolId: userPoolId,
        Username: stableIdentityUsername,
      }))
      return 'deleted'
    } catch (error) {
      const cognitoError = toCognitoSdkError(error)

      if (isCognitoUserNotFoundError(cognitoError)) {
        return 'absent'
      }

      throw cognitoError
    }
  }

  /** invitation が追加した Workspace directory claim を解除します。 */
  async unlinkWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<UnlinkCognitoWorkspaceUserResult> {
    const { userPoolId } = this.readRequiredConfiguration()
    // Cognito sub を stable lookup key として Username parameter へ意図的に渡します。
    const stableIdentityUsername = requireCognitoIdentityId(input.cognitoIdentityId)
    const canonicalUsername = requireCognitoUsername(input.cognitoUsername)
    const currentUser = await this.findWorkspaceUserByUsername(stableIdentityUsername)

    if (!currentUser && canonicalUsername !== stableIdentityUsername) {
      const canonicalUser = await this.findWorkspaceUserByUsername(canonicalUsername)

      if (!canonicalUser) {
        return 'completed'
      }

      if (!canonicalUser.identityId) {
        return 'manual-required'
      }

      if (
        canonicalUser.identityId !== input.cognitoIdentityId ||
        canonicalUser.directoryId !== input.directoryId
      ) {
        return 'completed'
      }

      return 'manual-required'
    }

    if (!currentUser) {
      return 'completed'
    }

    if (currentUser.identityId !== input.cognitoIdentityId) {
      return 'manual-required'
    }

    if (currentUser.directoryId !== input.directoryId) {
      return 'completed'
    }

    try {
      await this.client.send(new AdminDeleteUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: stableIdentityUsername,
        UserAttributeNames: ['custom:directory_id', 'custom:workspace_id'],
      }))
    } catch (error) {
      const cognitoError = toCognitoSdkError(error)

      if (!isCognitoUserNotFoundError(cognitoError)) {
        throw cognitoError
      }
    }

    return 'completed'
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
  private async updateWorkspaceUserAttributes(
    username: string,
    email: string,
    directoryId: string,
    name?: string,
  ) {
    const { userPoolId } = this.readRequiredConfiguration()

    try {
      await this.client.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: requireCognitoUsername(username),
        UserAttributes: createWorkspaceCognitoUserAttributes(email, directoryId, name),
      }))
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
export class FlociCognitoClient implements CognitoClient {
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

  /**
   * @param endpoint Floci / Cognito の endpoint URL です。
   */
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
    return this.findWorkspaceUserByUsername(normalizeCognitoUserId(userId))
  }

  /** Cognito username または stable sub を大文字小文字を変えずに検索します。 */
  private async findWorkspaceUserByUsername(username: string) {
    const normalizedUsername = requireCognitoUsername(username)

    try {
      const user = await this.request<CognitoUserRecord>('AdminGetUser', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: normalizedUsername,
      })
      const profile = toCognitoUserProfile(user)

      if (!profile) {
        throw new CognitoServiceError(
          502,
          'InvalidCognitoResponse',
          `Cognito user "${normalizedUsername}" did not include a stable profile.`,
        )
      }

      return {
        profile,
        identityId: readCognitoUserAttribute(user, 'sub')?.trim() || undefined,
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
      requireEnabledWorkspaceUser(existingUser)
      const cognitoIdentityId = requireCognitoIdentityId(existingUser.identityId)
      if (!existingUser.directoryId) {
        await input.beforeDirectoryClaimUpdate(
          cognitoIdentityId,
          existingUser.profile.username,
        )
      }
      await this.updateWorkspaceUserAttributes(
        existingUser.profile.username,
        email,
        input.directoryId,
        input.name,
      )

      return {
        profile: {
          ...existingUser.profile,
          name: input.name?.trim() || existingUser.profile.name,
        },
        cognitoIdentityId,
        cognitoUsername: requireCognitoUsername(existingUser.profile.username),
        identityOwnership: 'pre-existing',
        directoryClaimCleanupRequired: !existingUser.directoryId,
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
        cognitoIdentityId: requireCognitoIdentityId(
          response.User ? readCognitoUserAttribute(response.User, 'sub') : undefined,
        ),
        cognitoUsername: requireCognitoUsername(profile?.username ?? email),
        identityOwnership: 'workspace-created',
        directoryClaimCleanupRequired: false,
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
      requireEnabledWorkspaceUser(racedUser)
      const cognitoIdentityId = requireCognitoIdentityId(racedUser.identityId)
      if (!racedUser.directoryId) {
        await input.beforeDirectoryClaimUpdate(
          cognitoIdentityId,
          racedUser.profile.username,
        )
      }
      await this.updateWorkspaceUserAttributes(
        racedUser.profile.username,
        email,
        input.directoryId,
        input.name,
      )

      if (racedUser.profile.status === 'FORCE_CHANGE_PASSWORD') {
        await this.resendWorkspaceUserInvitation(racedUser.profile.username)
      }

      return {
        profile: racedUser.profile,
        cognitoIdentityId,
        cognitoUsername: requireCognitoUsername(racedUser.profile.username),
        identityOwnership: 'ambiguous',
        directoryClaimCleanupRequired: !racedUser.directoryId,
        deliveryStatus: racedUser.profile.status === 'FORCE_CHANGE_PASSWORD'
          ? 'sent'
          : 'not-required',
      } satisfies ProvisionCognitoWorkspaceUserResult
    }
  }

  /**
   * Workspace が作成した未確定 Cognito username へ invitation を再送します。
   */
  async resendWorkspaceUserInvitation(username: string) {
    await this.request<AdminCreateUserResponse>('AdminCreateUser', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: requireCognitoUsername(username),
      MessageAction: 'RESEND',
      DesiredDeliveryMediums: ['EMAIL'],
    })
  }

  /** Workspace が作成した未確定 user だけを削除します。 */
  async deleteWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<DeleteCognitoWorkspaceUserResult> {
    // Cognito sub を stable lookup key として Username parameter へ意図的に渡します。
    const stableIdentityUsername = requireCognitoIdentityId(input.cognitoIdentityId)
    const canonicalUsername = requireCognitoUsername(input.cognitoUsername)
    const currentUser = await this.findWorkspaceUserByUsername(stableIdentityUsername)

    if (!currentUser && canonicalUsername !== stableIdentityUsername) {
      const canonicalUser = await this.findWorkspaceUserByUsername(canonicalUsername)

      if (!canonicalUser) {
        return 'absent'
      }

      if (!canonicalUser.identityId) {
        return 'manual-required'
      }

      if (canonicalUser.identityId !== input.cognitoIdentityId) {
        return 'absent'
      }

      if (
        canonicalUser.directoryId !== input.directoryId ||
        canonicalUser.profile.status !== 'FORCE_CHANGE_PASSWORD'
      ) {
        return 'preserved'
      }

      return 'manual-required'
    }

    if (!currentUser) {
      return 'absent'
    }

    if (currentUser.identityId !== input.cognitoIdentityId) {
      return 'manual-required'
    }

    if (
      currentUser.directoryId !== input.directoryId ||
      currentUser.profile.status !== 'FORCE_CHANGE_PASSWORD'
    ) {
      return 'preserved'
    }

    try {
      await this.request<Record<string, never>>('AdminDeleteUser', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: stableIdentityUsername,
      })
      return 'deleted'
    } catch (error) {
      if (isCognitoUserNotFoundError(error)) {
        return 'absent'
      }

      throw error
    }
  }

  /** invitation が追加した Workspace directory claim を解除します。 */
  async unlinkWorkspaceUser(
    input: CognitoWorkspaceUserCleanupInput,
  ): Promise<UnlinkCognitoWorkspaceUserResult> {
    // Cognito sub を stable lookup key として Username parameter へ意図的に渡します。
    const stableIdentityUsername = requireCognitoIdentityId(input.cognitoIdentityId)
    const canonicalUsername = requireCognitoUsername(input.cognitoUsername)
    const currentUser = await this.findWorkspaceUserByUsername(stableIdentityUsername)

    if (!currentUser && canonicalUsername !== stableIdentityUsername) {
      const canonicalUser = await this.findWorkspaceUserByUsername(canonicalUsername)

      if (!canonicalUser) {
        return 'completed'
      }

      if (!canonicalUser.identityId) {
        return 'manual-required'
      }

      if (
        canonicalUser.identityId !== input.cognitoIdentityId ||
        canonicalUser.directoryId !== input.directoryId
      ) {
        return 'completed'
      }

      return 'manual-required'
    }

    if (!currentUser) {
      return 'completed'
    }

    if (currentUser.identityId !== input.cognitoIdentityId) {
      return 'manual-required'
    }

    if (currentUser.directoryId !== input.directoryId) {
      return 'completed'
    }

    try {
      await this.request<Record<string, never>>('AdminDeleteUserAttributes', {
        UserPoolId: await this.resolveUserPoolId(),
        Username: stableIdentityUsername,
        UserAttributeNames: ['custom:directory_id', 'custom:workspace_id'],
      })
    } catch (error) {
      if (!isCognitoUserNotFoundError(error)) {
        throw error
      }
    }

    return 'completed'
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
  private async updateWorkspaceUserAttributes(
    username: string,
    email: string,
    directoryId: string,
    name?: string,
  ) {
    await this.request<Record<string, never>>('AdminUpdateUserAttributes', {
      UserPoolId: await this.resolveUserPoolId(),
      Username: requireCognitoUsername(username),
      UserAttributes: createWorkspaceCognitoUserAttributes(email, directoryId, name),
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

/** DynamoDB の team/project と canonical Work Item から集計値を算出します。 */
export class DynamoDbDashboardSummaryClient {
  /**
   * team/project directory を読み取る client です。
   */
  private readonly projectDirectoryClient: ProjectDirectoryClient

  /**
   * canonical Work Item を読み取る client です。
   */
  private readonly teamIssuesClient: TeamIssuesClient

  constructor(
    projectDirectoryClient: ProjectDirectoryClient = new DynamoDbProjectDirectoryClient(),
    teamIssuesClient: TeamIssuesClient = new DynamoDbTeamIssuesClient(),
  ) {
    this.projectDirectoryClient = projectDirectoryClient
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
      Array.from(visibleProjectIds).map((projectId) =>
        this.teamIssuesClient.getProjectIssues(directoryId, projectId)
      ),
    )
    const tasks = taskResponses.flatMap((response) => response.issues)

    return {
      projects: visibleProjectIds.size,
      tasks: tasks.filter((task) => !isTerminalWorkItem(task)).length,
      blocked: tasks.filter((task) => task.priority === 'high' && !isTerminalWorkItem(task)).length,
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
  async getTeamIssues(
    directoryId: string,
    teamId: string,
    options: WorkItemListReadOptions = {},
  ) {
    await this.ensureLocalTables()

    try {
      const items = await this.queryTeamIssueItems(directoryId, teamId, options)
      const visibleItems = options.includeArchived
        ? items
        : items.filter((item) => item.archivedAt === undefined)

      return {
        teamId,
        issues: visibleItems.map(toTeamIssueResponseItem),
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
  async getProjectIssues(
    directoryId: string,
    projectId: string,
    options: WorkItemListReadOptions = {},
  ) {
    await this.ensureLocalTables()

    try {
      const items = await this.queryProjectIssueItems(directoryId, projectId, options)
      const visibleItems = options.includeArchived
        ? items
        : items.filter((item) => item.archivedAt === undefined)

      return {
        projectId,
        issues: visibleItems.map(toTeamIssueResponseItem),
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
    auditContext?: MutationAuditContext,
    requestConversion?: RequestConversionTransactionInput,
  ) {
    await this.ensureLocalTables()
    let auditPut: ReturnType<typeof createMutationAuditEventPut> = undefined

    const title = readRequiredString(input.title, 'Issue title is required.')
    const description = readOptionalString(input.description, 'Issue description is invalid.')
    const assigneeUserId = readTeamIssueAssigneeUserId(input)
    const dueDate = readRequiredString(input.dueDate, 'Issue due date is required.')
    const priority = readTaskPriority(input.priority)
    const assignedProjectId = readAssignedProjectId(input.assignedProjectId)
    const workflowSchemaVersion = readWorkflowSchemaVersion(input.workflowSchemaVersion)
    const workflowStatusId = readWorkflowStatusId(input.workflowStatusId)
    const statusCategory = readWorkflowStatusCategory(input.statusCategory)
    const customFieldValues = readCustomFieldValues(input.customFieldValues)
    const idempotentIssueId = input.idempotentIssueId === undefined
      ? undefined
      : readRequiredString(
          input.idempotentIssueId,
          'Idempotent Work Item ID is required.',
        )
    const idempotentRequestDigest = input.idempotentRequestDigest === undefined
      ? undefined
      : readRequiredString(
          input.idempotentRequestDigest,
          'Idempotent request digest is required.',
        )
    if (
      (idempotentIssueId === undefined) !==
        (idempotentRequestDigest === undefined) ||
      (idempotentIssueId !== undefined &&
        !/^(?:api|import)-[a-f0-9]{48}$/u.test(idempotentIssueId)) ||
      (idempotentRequestDigest !== undefined &&
        !/^[a-f0-9]{64}$/u.test(idempotentRequestDigest))
    ) {
      throw new ProjectDataError(
        400,
        'InvalidIdempotentWorkItemCreate',
        'Idempotent Work Item create metadata is invalid.',
      )
    }
    const sourceRequestId = requestConversion
      ? readSourceRequestId(requestConversion.submissionId)
      : undefined
    const idempotencyResourceId = readIdempotencyResourceId(input.idempotencyResourceId)
    if (idempotentIssueId !== undefined && idempotencyResourceId !== undefined) {
      throw new ProjectDataError(
        400,
        'InvalidIdempotentWorkItemCreate',
        'Only one Work Item create idempotency mechanism may be used.',
      )
    }
    const directoryTeamId = createDirectoryTeamId(directoryId, teamId)
    const now = new Date().toISOString()

    try {
      const currentIssues = await this.getTeamIssues(
        directoryId,
        teamId,
        { includeArchived: true },
      )
      const existingSourceIssue = sourceRequestId
        ? currentIssues.issues.find((issue) => issue.sourceRequestId === sourceRequestId)
        : undefined

      if (existingSourceIssue) {
        return { issue: existingSourceIssue } satisfies CreateTeamIssueResponse
      }

      const issueId = idempotentIssueId ?? idempotencyResourceId ?? (
        sourceRequestId
          ? createUniqueResourceId(
              `request-${sourceRequestId}`,
              currentIssues.issues.map((issue) => issue.id),
            )
          : createUniqueResourceId(
              title,
              currentIssues.issues.map((issue) => issue.id),
            )
      )
      const item: TeamIssueItem = {
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        revision: 1,
        directoryId,
        directoryTeamId,
        teamId,
        issueId,
        ...(idempotentRequestDigest ? { importRequestDigest: idempotentRequestDigest } : {}),
        sortOrder: (currentIssues.issues.length + 1) * 10,
        title,
        assigneeUserId,
        creatorMemberKey: actorUserId,
        ...(sourceRequestId ? { sourceRequestId } : {}),
        workflowSchemaVersion,
        workflowStatusId,
        statusCategory,
        customFieldValues,
        relationIds: [],
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
      auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'work-item.created',
        entityType: 'work-item',
        entityId: createTeamIssueAuditEntityId(teamId, issueId),
        action: 'created',
        occurredAt: now,
        summary: 'Work Item was created and assigned.',
        changes: createAuditFieldChanges(undefined, item, [
          'title',
          'description',
          'assignedProjectId',
          'assigneeUserId',
          'workflowStatusId',
          'statusCategory',
          'customFieldValues',
          'dueDate',
          'priority',
          'sourceRequestId',
        ]),
        metadata: {
          adapter: 'canonical-work-item',
          actorMemberKey: actorUserId,
          teamId,
          issueId,
          projectId: assignedProjectId,
          sourceRequestId,
          deepLink: createTeamIssueDeepLink(teamId, issueId),
          notificationTitle: title,
          notificationCandidates: [
            { memberKey: assigneeUserId, reason: 'assignment' },
          ],
          afterRevision: item.revision,
        },
      })
      const configurationConditionChecks = input.configurationConditionChecks ?? []
      const requestConversionItems = requestConversion
        ? createRequestConversionTransactionItems(
            requestConversion,
            teamId,
            issueId,
            assignedProjectId ?? undefined,
            now,
          )
        : []
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
            ...configurationConditionChecks,
            ...requestConversionItems,
          ],
        }),
      )

      return {
        issue: toTeamIssueResponseItem(item),
      } satisfies CreateTeamIssueResponse
    } catch (error) {
      const configurationConditionChecks = input.configurationConditionChecks ?? []
      const configurationConditionStartIndex = resolveConfigurationConditionStartIndex(
        2,
        auditPut,
      )
      if (configurationConditionChecks.some((_, index) =>
        isTransactionConditionalFailureAt(error, configurationConditionStartIndex + index)
      )) {
        throw createWorkItemConfigurationRevisionConflictError()
      }
      if (
        isAwsNamedError(error, 'TransactionCanceledException') &&
        hasTransactionConditionalFailure(error)
      ) {
        if (idempotentIssueId && idempotentRequestDigest) {
          try {
            const existing = await this.getRequiredTeamIssueItem(
              directoryId,
              teamId,
              idempotentIssueId,
              true,
            )
            if (existing.importRequestDigest === idempotentRequestDigest) {
              return {
                issue: toTeamIssueResponseItem(existing),
              } satisfies CreateTeamIssueResponse
            }
            throw new ProjectDataError(
              409,
              'IdempotentWorkItemCreateConflict',
              'The deterministic Work Item ID belongs to another request.',
            )
          } catch (readError) {
            if (!isTeamIssueNotFoundError(readError)) throw readError
          }
        }
        if (sourceRequestId) {
          const currentIssues = await this.getTeamIssues(
            directoryId,
            teamId,
            { includeArchived: true },
          )
          const existingSourceIssue = currentIssues.issues.find(
            (issue) => issue.sourceRequestId === sourceRequestId,
          )
          if (existingSourceIssue) {
            return { issue: existingSourceIssue } satisfies CreateTeamIssueResponse
          }
        }
        if (idempotencyResourceId) {
          const existing = await this.getTeamIssueDetail(
            directoryId,
            teamId,
            idempotencyResourceId,
            { consistentIssueRead: true, eventLimit: 0 },
          ).catch(() => undefined)
          if (existing && isMatchingIdempotentWorkItemCreate(existing.issue, {
            actorUserId,
            assigneeUserId,
            assignedProjectId,
            customFieldValues,
            description,
            dueDate,
            priority,
            statusCategory,
            title,
            workflowSchemaVersion,
            workflowStatusId,
          })) {
            return { issue: existing.issue } satisfies CreateTeamIssueResponse
          }
        }
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
    idempotency?: WorkItemIdempotencyTransaction,
  ) {
    await this.ensureLocalTables()
    let auditPut: ReturnType<typeof createMutationAuditEventPut> = undefined
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

    if ('workflowStatusId' in input) {
      expressionAttributeNames['#workflowStatusId'] = 'workflowStatusId'
      expressionAttributeValues[':workflowStatusId'] = readWorkflowStatusId(input.workflowStatusId)
      setExpressions.push('#workflowStatusId = :workflowStatusId')
    }

    if ('statusCategory' in input) {
      expressionAttributeNames['#statusCategory'] = 'statusCategory'
      expressionAttributeValues[':statusCategory'] = readWorkflowStatusCategory(input.statusCategory)
      setExpressions.push('#statusCategory = :statusCategory')
    }

    if ('workflowSchemaVersion' in input || 'workflowStatusId' in input || 'customFieldValues' in input) {
      expressionAttributeNames['#workflowSchemaVersion'] = 'workflowSchemaVersion'
      expressionAttributeValues[':workflowSchemaVersion'] = readWorkflowSchemaVersion(
        input.workflowSchemaVersion,
      )
      setExpressions.push('#workflowSchemaVersion = :workflowSchemaVersion')
    }

    if ('customFieldValues' in input) {
      expressionAttributeNames['#customFieldValues'] = 'customFieldValues'
      expressionAttributeValues[':customFieldValues'] = readCustomFieldValues(input.customFieldValues)
      setExpressions.push('#customFieldValues = :customFieldValues')
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

    if ('archivedAt' in input) {
      const archivedAt = readOptionalString(input.archivedAt, 'Issue archive timestamp is invalid.')
      expressionAttributeNames['#archivedAt'] = 'archivedAt'
      expressionAttributeNames['#archivedBy'] = 'archivedBy'

      if (archivedAt) {
        if (!Number.isFinite(Date.parse(archivedAt))) {
          throw new ProjectDataError(400, 'InvalidProjectWrite', 'Issue archive timestamp is invalid.')
        }
        expressionAttributeValues[':archivedAt'] = new Date(archivedAt).toISOString()
        expressionAttributeValues[':archivedBy'] = readRequiredString(
          input.archivedBy ?? actorUserId,
          'Issue archive actor is required.',
        )
        setExpressions.push('#archivedAt = :archivedAt')
        setExpressions.push('#archivedBy = :archivedBy')
      } else {
        removeExpressions.push('#archivedAt')
        removeExpressions.push('#archivedBy')
      }
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
      auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'work-item.updated',
        entityType: 'work-item',
        entityId: createTeamIssueAuditEntityId(teamId, issueId),
        action: 'updated',
        occurredAt: expressionAttributeValues[':updatedAt'] as string,
        summary: createWorkItemNotificationSummary(beforeIssue, afterIssue),
        changes: createAuditFieldChanges(beforeIssue, afterIssue, [
          'title',
          'description',
          'assignedProjectId',
          'assigneeUserId',
          'workflowStatusId',
          'statusCategory',
          'customFieldValues',
          'dueDate',
          'priority',
          'archivedAt',
          'archivedBy',
        ]),
        metadata: {
          adapter: 'canonical-work-item',
          actorMemberKey: actorUserId,
          teamId,
          issueId,
          projectId: afterIssue.assignedProjectId,
          deepLink: createTeamIssueDeepLink(teamId, issueId),
          notificationTitle: afterIssue.title,
          notificationCandidates: createWorkItemNotificationCandidates(beforeIssue, afterIssue),
          beforeRevision: expectedRevision,
          afterRevision: nextRevision,
        },
      })
      const configurationConditionChecks = input.configurationConditionChecks ?? []
      const idempotencyCompletion = await idempotency?.prepare({
        status: 200,
        body: toTeamIssueResponseItem(afterIssue),
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
                  '#revision = :expectedRevision',
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
            ...configurationConditionChecks,
            ...(idempotencyCompletion
              ? [idempotencyCompletion.transactWriteItem]
              : []),
          ],
        }),
      )

      return {
        issue: toTeamIssueResponseItem(afterIssue),
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

      const configurationConditionChecks = input.configurationConditionChecks ?? []
      const configurationConditionStartIndex = resolveConfigurationConditionStartIndex(
        2,
        auditPut,
      )
      if (configurationConditionChecks.some((_, index) =>
        isTransactionConditionalFailureAt(error, configurationConditionStartIndex + index)
      )) {
        throw createWorkItemConfigurationRevisionConflictError()
      }

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
   * DynamoDB の canonical Work Item を revision 条件付きで削除し、同じ transaction に
   * immutable audit event を保存します。
   */
  async deleteTeamIssue(
    directoryId: string,
    teamId: string,
    issueId: string,
    expectedRevision: number,
    actorUserId: string,
    auditContext?: MutationAuditContext,
    idempotency?: WorkItemIdempotencyTransaction,
    deletionFence?: WorkItemDeletionFenceTransactWrite,
  ) {
    await this.ensureLocalTables()
    const directoryTeamId = createDirectoryTeamId(directoryId, teamId)
    const beforeIssue = await this.getRequiredTeamIssueItem(directoryId, teamId, issueId, true)

    if (beforeIssue.revision !== expectedRevision) {
      throw createWorkItemRevisionConflictError()
    }

    const occurredAt = new Date().toISOString()
    const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
      directoryId,
      eventType: 'work-item.deleted',
      entityType: 'work-item',
      entityId: createTeamIssueAuditEntityId(teamId, issueId),
      action: 'deleted',
      occurredAt,
      summary: 'Work Item was deleted.',
      changes: createAuditFieldChanges(beforeIssue, undefined, [
        'title',
        'description',
        'assignedProjectId',
        'assigneeUserId',
        'workflowStatusId',
        'statusCategory',
        'customFieldValues',
        'dueDate',
        'priority',
      ]),
      metadata: {
        adapter: 'canonical-work-item',
        actorMemberKey: actorUserId,
        teamId,
        issueId,
        projectId: beforeIssue.assignedProjectId,
        notificationTitle: beforeIssue.title,
        beforeRevision: expectedRevision,
      },
    })
    const idempotencyCompletion = await idempotency?.prepare({
      status: 204,
      body: null,
    })

    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.issueTableName,
                Key: { directoryTeamId, issueId },
                ConditionExpression:
                  'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #revision = :expectedRevision',
                ExpressionAttributeNames: { '#revision': 'revision' },
                ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
              },
            },
            ...(deletionFence ? [deletionFence.transactWriteItem] : []),
            ...(auditPut ? [auditPut] : []),
            ...(idempotencyCompletion
              ? [idempotencyCompletion.transactWriteItem]
              : []),
          ],
        }),
      )

      return { issue: toTeamIssueResponseItem(beforeIssue) }
    } catch (error) {
      if (deletionFence && isTransactionConditionalFailureAt(error, 1)) {
        throw new ProjectDataError(
          409,
          'ExternalWorkItemLinkConflict',
          'Unlink all external resources before deleting this Work Item.',
        )
      }
      if (isTransactionConditionalFailureAt(error, 0)) {
        try {
          const latestIssue = await this.getRequiredTeamIssueItem(
            directoryId,
            teamId,
            issueId,
            true,
          )
          if (latestIssue.revision !== expectedRevision) {
            throw createWorkItemRevisionConflictError()
          }
        } catch (readError) {
          if (readError instanceof ProjectDataError) {
            throw readError
          }
          throw toProjectDataError(readError)
        }
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
    const idempotencyEventId = readIdempotencyResourceId(input.idempotencyEventId)
    const item = this.createIssueEventItem({
      directoryId,
      teamId,
      issueId,
      eventType: 'commented',
      actorUserId,
      body,
      summary: 'Comment was added.',
      createdAt,
      ...(idempotencyEventId ? { eventId: idempotencyEventId } : {}),
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
      metadata: { adapter: 'team-issue', teamId, issueId, commentId: item.eventId },
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
      if (
        idempotencyEventId &&
        (
          isAwsNamedError(error, 'ConditionalCheckFailedException') ||
          hasTransactionConditionalFailure(error)
        )
      ) {
        const existing = await this.documentClient.send(new GetCommand({
          TableName: this.eventTableName,
          Key: {
            directoryTeamIssueId: createDirectoryTeamIssueId(directoryId, teamId, issueId),
            eventId: idempotencyEventId,
          },
          ConsistentRead: true,
        }))
        if (
          isTeamIssueEventItem(existing.Item) &&
          existing.Item.eventType === 'commented' &&
          existing.Item.actorUserId === actorUserId &&
          existing.Item.body === body
        ) {
          return toCreateTeamIssueCommentResponse(existing.Item)
        }
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

    return toCreateTeamIssueCommentResponse(item)
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
    const items: TeamIssueItem[] = []
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
          ...(options.consistentRead
            ? { ConsistentRead: true }
            : { IndexName: 'TeamIssueSortOrderIndex', ScanIndexForward: true }),
          KeyConditionExpression: 'directoryTeamId = :directoryTeamId',
          ExpressionAttributeValues: {
            ':directoryTeamId': createDirectoryTeamId(directoryId, teamId),
          },
          ExclusiveStartKey: exclusiveStartKey,
          ...(remaining === undefined ? {} : { Limit: remaining }),
        }),
      )

      const pageItems = (response.Items ?? [])
        .map(toTeamIssueItem)
        .filter((item) => options.includeArchived || item.archivedAt === undefined)
      items.push(...(remaining === undefined ? pageItems : pageItems.slice(0, remaining)))
      if (limit !== undefined && items.length >= limit) {
        break
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items
  }

  private async queryProjectIssueItems(
    directoryId: string,
    projectId: string,
    options: WorkItemListReadOptions = {},
  ) {
    const items: TeamIssueItem[] = []
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

      const pageItems = (response.Items ?? [])
        .map(toTeamIssueItem)
        .filter((item) => options.includeArchived || item.archivedAt === undefined)
      items.push(...(remaining === undefined ? pageItems : pageItems.slice(0, remaining)))
      if (limit !== undefined && items.length >= limit) {
        break
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items
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

  private createIssueEventItem(
    input: Omit<TeamIssueEventItem, 'directoryTeamIssueId' | 'eventId'> & { eventId?: string },
  ) {
    return {
      ...input,
      directoryTeamIssueId: createDirectoryTeamIssueId(input.directoryId, input.teamId, input.issueId),
      eventId: input.eventId ?? createTeamIssueEventId(input.createdAt, input.eventType),
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
  /**
   * Team / Project archive と直列化する Planning table 名です。
   */
  private readonly planningTableName: string

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
    planningTableName = getEnv('PLANNING_TABLE_NAME') ?? 'mukuroji-planning-local',
  ) {
    this.tableName = tableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
    this.auditTableName = auditTableName
    this.workspaceAccessTableName = workspaceAccessTableName
    this.planningTableName = planningTableName
  }

  /**
   * DynamoDB から sidebar 用の team/project 階層を取得します。
   */
  async getProjectDirectory(
    directoryId: string,
    locale: Locale,
    consistentRead = false,
  ) {
    try {
      const items = await this.queryDirectoryItems(directoryId, true, consistentRead)

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
    completionTransactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
  ) {
    await this.ensureLocalAuditTable()
    const names = readLocalizedNames(input)
    const tone = readProjectTone(input.tone)
    const idempotencyResourceId = readIdempotencyResourceId(input.idempotencyResourceId)
    const creatorMemberKey = normalizeProjectMemberKey(creator.userKey)

    if (!creatorMemberKey) {
      throw new ProjectDataError(
        400,
        'ProjectCreatorInvalid',
        'Project creator member key is required.',
      )
    }

    try {
      const items = await this.readValidDirectoryItems(directoryId, Boolean(idempotencyResourceId))
      const team = items.find((item): item is ProjectDirectoryTeamItem =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      if (idempotencyResourceId) {
        const existingProject = items.find((item): item is ProjectDirectoryProjectItem =>
          item.entryType === 'project' && item.projectId === idempotencyResourceId,
        )
        if (existingProject) {
          if (
            existingProject.teamId !== teamId ||
            existingProject.nameJa !== names.nameJa ||
            existingProject.nameEn !== names.nameEn ||
            (existingProject.tone ?? 'blue') !== tone ||
            existingProject.archivedAt
          ) {
            throw createProjectDataConflictError()
          }
          if (completionTransactItems.length > 0) {
            try {
              await this.documentClient.send(new TransactWriteCommand({
                TransactItems: [
                  {
                    ConditionCheck: {
                      TableName: this.tableName,
                      Key: { directoryId, entryKey: existingProject.entryKey },
                      ConditionExpression:
                        '#entryType = :entryType AND #projectId = :projectId AND #teamId = :teamId AND #nameJa = :nameJa AND #nameEn = :nameEn AND #tone = :tone AND attribute_not_exists(#archivedAt)',
                      ExpressionAttributeNames: {
                        '#archivedAt': 'archivedAt',
                        '#entryType': 'entryType',
                        '#nameEn': 'nameEn',
                        '#nameJa': 'nameJa',
                        '#projectId': 'projectId',
                        '#teamId': 'teamId',
                        '#tone': 'tone',
                      },
                      ExpressionAttributeValues: {
                        ':entryType': 'project',
                        ':nameEn': names.nameEn,
                        ':nameJa': names.nameJa,
                        ':projectId': idempotencyResourceId,
                        ':teamId': teamId,
                        ':tone': tone,
                      },
                    },
                  },
                  ...completionTransactItems,
                ],
              }))
            } catch (error) {
              if (hasTransactionConditionalFailure(error)) {
                throw createProjectDataConflictError()
              }
              throw error
            }
          }
          return {
            project: {
              id: existingProject.projectId,
              name: existingProject.nameJa,
              tone: existingProject.tone,
            },
          } satisfies CreateProjectResponse
        }
      }

      const projectId = idempotencyResourceId ?? createUniqueResourceId(
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
              ...completionTransactItems,
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
    auditContext: MutationAuditContext | undefined,
    expectedPlanningRevision: number,
  ) {
    await this.ensureLocalAuditTable()
    let planningRevisionItemIndex: number | undefined
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
      const planningRevisionMutation = createPlanningRevisionBump(
        this.planningTableName,
        directoryId,
        expectedPlanningRevision,
        archivedAt,
      )
      planningRevisionItemIndex = 1 + auditItems.length

      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [stateUpdate, ...auditItems, planningRevisionMutation],
        }),
      )

      return {
        teamId,
        archivedAt,
      } satisfies ArchiveTeamResponse
    } catch (error) {
      if (isTransactionConditionalFailureAt(error, 0)) {
        await this.throwArchiveTeamTransactionCancellationResult(directoryId, teamId, error)
      }

      if (
        planningRevisionItemIndex !== undefined &&
        isTransactionConditionalFailureAt(error, planningRevisionItemIndex)
      ) {
        throw new ProjectDataError(
          409,
          'PlanningRevisionConflict',
          'Planning changed. Reload and try again.',
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
   * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
   */
  async archiveProject(
    directoryId: string,
    teamId: string,
    projectId: string,
    auditContext: MutationAuditContext | undefined,
    expectedPlanningRevision: number,
  ) {
    await this.ensureLocalAuditTable()
    let planningRevisionItemIndex: number | undefined
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
      const planningRevisionMutation = createPlanningRevisionBump(
        this.planningTableName,
        directoryId,
        expectedPlanningRevision,
        archivedAt,
      )
      planningRevisionItemIndex = 1 + auditItems.length

      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [stateUpdate, ...auditItems, planningRevisionMutation],
        }),
      )

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


      if (
        planningRevisionItemIndex !== undefined &&
        isTransactionConditionalFailureAt(error, planningRevisionItemIndex)
      ) {
        throw new ProjectDataError(
          409,
          'PlanningRevisionConflict',
          'Planning changed. Reload and try again.',
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

function requireCognitoUsername(value: string) {
  const username = value.trim()

  if (!username) {
    throw new CognitoServiceError(400, 'InvalidParameterException', 'Cognito username is required.')
  }

  return username
}

function requireCognitoIdentityId(value: string | undefined) {
  const identityId = value?.trim()

  if (!identityId) {
    throw new CognitoServiceError(
      502,
      'InvalidCognitoResponse',
      'Cognito user did not include a stable identity ID.',
    )
  }

  return identityId
}

function requireEnabledWorkspaceUser(user: CognitoWorkspaceUser) {
  if (user.profile.enabled !== false) {
    return
  }

  throw new CognitoServiceError(
    409,
    'CognitoUserDisabled',
    'The existing Cognito user is disabled. Re-enable it before sending a Workspace invitation.',
  )
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

function createWorkItemConfigurationClient() {
  const dynamoDbClient = createDynamoDbClient()
  return new DynamoDbWorkItemConfigurationClient(
    getWorkItemConfigurationTableName(),
    getEnv('MUKUROJI_WORK_ITEMS_TABLE') ??
      getEnv('WORK_ITEMS_TABLE_NAME') ??
      getEnv('MUKUROJI_TEAM_ISSUES_TABLE') ??
      getEnv('TEAM_ISSUES_TABLE_NAME') ??
      'mukuroji-team-issues-local',
    createDynamoDbDocumentClient(dynamoDbClient),
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
  )
}

function createAutomationClient() {
  const dynamoDbClient = createDynamoDbClient()
  return new DynamoDbAutomationClient(
    getAutomationTableName(),
    createDynamoDbDocumentClient(dynamoDbClient),
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
  )
}

function createPlanningClient() {
  const dynamoDbClient = createDynamoDbClient()
  return new DynamoDbPlanningClient(
    getEnv('PLANNING_TABLE_NAME') ?? 'mukuroji-planning-local',
    createDynamoDbDocumentClient(dynamoDbClient),
    dynamoDbClient,
    shouldBootstrapLocalDynamoDb(),
    () => new Date(),
    getEnv('MUKUROJI_WORK_ITEMS_TABLE') ??
      getEnv('WORK_ITEMS_TABLE_NAME') ??
      getEnv('MUKUROJI_TEAM_ISSUES_TABLE') ??
      getEnv('TEAM_ISSUES_TABLE_NAME') ??
      'mukuroji-team-issues-local',
  )
}

function createDefaultWorkItemConfigurationClient(): WorkItemConfigurationClient {
  const createResolved = (
    scopeType: 'workspace' | 'team',
    scopeId: string,
  ): ResolvedWorkItemConfiguration => ({
    configuration: {
      ...structuredClone(DEFAULT_WORK_ITEM_CONFIGURATION),
      scopeType,
      scopeId,
    },
    inheritedFrom: 'default',
  })
  return {
    async getWorkspaceConfiguration(workspaceId) {
      return createResolved('workspace', workspaceId)
    },
    async getTeamConfiguration(_workspaceId, teamId) {
      return createResolved('team', teamId)
    },
    async saveWorkspaceConfiguration(workspaceId, configuration, usageCheck) {
      await usageCheck()
      return {
        configuration: {
          ...structuredClone(configuration),
          scopeType: 'workspace',
          scopeId: workspaceId,
          revision: configuration.revision + 1,
        },
      }
    },
    async saveTeamConfiguration(_workspaceId, teamId, configuration, usageCheck) {
      await usageCheck()
      return {
        configuration: {
          ...structuredClone(configuration),
          scopeType: 'team',
          scopeId: teamId,
          revision: configuration.revision + 1,
        },
      }
    },
    async listRelations() {
      return { relations: [], graphRevision: 0 }
    },
    async createRelation(_workspaceId, _teamId, input) {
      return createDefaultRelationMutationResponse(input)
    },
    async deleteRelation(_workspaceId, _teamId, input) {
      return createDefaultRelationMutationResponse(input)
    },
  }
}

function createDefaultRelationMutationResponse(
  input: MutateWorkItemRelationInput,
): WorkItemRelationMutationResponse {
  const reciprocalTypes: Record<WorkItemRelationType, WorkItemRelationType> = {
    parent: 'child',
    child: 'parent',
    blocks: 'blockedBy',
    blockedBy: 'blocks',
    related: 'related',
    duplicate: 'duplicate',
  }
  return {
    relation: {
      sourceWorkItemId: input.sourceWorkItemId,
      targetWorkItemId: input.targetWorkItemId,
      type: input.type,
    },
    reciprocalRelation: {
      sourceWorkItemId: input.targetWorkItemId,
      targetWorkItemId: input.sourceWorkItemId,
      type: reciprocalTypes[input.type],
    },
    graphRevision: input.expectedGraphRevision + 1,
  }
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

/** Configuration ConditionCheck の transaction 内開始位置を返します。 */
function resolveConfigurationConditionStartIndex(
  precedingItemCount: number,
  auditPut: ReturnType<typeof createMutationAuditEventPut>,
) {
  return precedingItemCount + (auditPut === undefined ? 0 : 1)
}

function createProjectDataConflictError() {
  return new ProjectDataError(
    409,
    'ConditionalCheckFailedException',
    'The transaction condition failed.',
  )
}

function createPlanningRevisionBump(
  tableName: string,
  workspaceId: string,
  expectedRevision: number,
  updatedAt: string,
) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ProjectDataError(
      400,
      'InvalidPlanningRevision',
      'Planning revision must be a non-negative safe integer.',
    )
  }
  return {
    Put: {
      TableName: tableName,
      Item: {
        workspaceId,
        recordKey: 'META',
        entryType: 'planning-meta',
        schemaVersion: PLANNING_SCHEMA_VERSION,
        revision: expectedRevision + 1,
        updatedAt,
      },
      ...(expectedRevision === 0
        ? {
            ConditionExpression:
              'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
          }
        : {
            ConditionExpression: '#revision = :expectedPlanningRevision',
            ExpressionAttributeNames: { '#revision': 'revision' },
            ExpressionAttributeValues: { ':expectedPlanningRevision': expectedRevision },
          }),
    },
  }
}

function createWorkItemRevisionConflictError() {
  return new ProjectDataError(
    409,
    'WorkItemRevisionConflict',
    'Work Item revision does not match the expected revision.',
  )
}

function createWorkItemConfigurationRevisionConflictError() {
  return new ProjectDataError(
    409,
    'WorkItemConfigurationRevisionConflict',
    'Work Item configuration changed during the mutation.',
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
    schemaVersion: item.schemaVersion,
    revision: item.revision,
    id: item.issueId,
    teamId: item.teamId,
    title: item.title,
    assigneeUserId: item.assigneeUserId,
    creatorMemberKey: item.creatorMemberKey,
    workflowSchemaVersion: item.workflowSchemaVersion,
    workflowStatusId: item.workflowStatusId,
    statusCategory: item.statusCategory,
    customFieldValues: item.customFieldValues,
    relationIds: item.relationIds,
    dueDate: item.dueDate,
    priority: item.priority,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    source: 'dynamodb',
  }

  if (item.sourceRequestId) {
    issue.sourceRequestId = item.sourceRequestId
  }

  if (item.assignedProjectId) {
    issue.assignedProjectId = item.assignedProjectId
  }

  if (item.description) {
    issue.description = item.description
  }

  if (item.archivedAt) {
    issue.archivedAt = item.archivedAt
    issue.archivedBy = item.archivedBy
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

function toCreateTeamIssueCommentResponse(
  value: TeamIssueEventItem,
): CreateTeamIssueCommentResponse {
  return {
    comment: toTeamIssueCommentResponseItem(value),
    activity: toTeamIssueActivityResponseItem(value),
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
    source: 'legacy',
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
  return isCanonicalWorkItemRecord(value)
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

function isWorkflowStatusCategory(value: unknown): value is WorkflowStatusCategory {
  return value === 'backlog' ||
    value === 'unstarted' ||
    value === 'started' ||
    value === 'completed' ||
    value === 'canceled'
}

function isCustomFieldValueRecord(value: unknown): value is Record<string, CustomFieldValue> {
  return isRecord(value) && Object.values(value).every((fieldValue) =>
    typeof fieldValue === 'string' ||
    typeof fieldValue === 'number' ||
    typeof fieldValue === 'boolean' ||
    (
      Array.isArray(fieldValue) &&
      fieldValue.every((entry) => typeof entry === 'string')
    )
  )
}

function isTerminalWorkItem(item: { statusCategory: WorkflowStatusCategory }) {
  return item.statusCategory === 'completed' || item.statusCategory === 'canceled'
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

function readWorkflowSchemaVersion(value: unknown) {
  if (value === WORK_ITEM_CONFIGURATION_SCHEMA_VERSION) {
    return WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  }

  throw new ProjectDataError(
    400,
    'InvalidWorkItemConfiguration',
    'Workflow schema version is invalid.',
  )
}

function readWorkflowStatusId(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemConfiguration',
      'Workflow status ID is invalid.',
    )
  }

  return value.trim()
}

function readWorkflowStatusCategory(value: unknown) {
  if (!isWorkflowStatusCategory(value)) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemConfiguration',
      'Workflow status category is invalid.',
    )
  }

  return value
}

function readCustomFieldValues(value: unknown): Record<string, CustomFieldValue> {
  if (!isCustomFieldValueRecord(value)) {
    throw new ProjectDataError(
      400,
      'InvalidCustomFieldValue',
      'Custom field values are invalid.',
    )
  }

  return { ...value }
}

function readNonNegativeRevision(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemRelationRevision',
      `${label} must be a non-negative integer.`,
    )
  }
  return value as number
}

function readCreatableWorkItemRelationType(value: unknown): WorkItemRelationType {
  if (value === 'parent' || value === 'blocks' || value === 'related' || value === 'duplicate') {
    return value
  }
  throw new WorkItemConfigurationError(
    400,
    'InvalidWorkItemRelation',
    'Relation type must be parent, blocks, related, or duplicate.',
  )
}

function readWorkItemRelationType(value: unknown): WorkItemRelationType {
  if (
    value === 'parent' ||
    value === 'child' ||
    value === 'blocks' ||
    value === 'blockedBy' ||
    value === 'related' ||
    value === 'duplicate'
  ) {
    return value
  }
  throw new WorkItemConfigurationError(
    400,
    'InvalidWorkItemRelation',
    'Relation type is invalid.',
  )
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

function rejectInternalWorkItemUpdateFields(input: PublicUpdateTeamIssueRequestBody) {
  if ('archivedAt' in input || 'archivedBy' in input) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemArchiveUpdate',
      'Work Item archive fields cannot be updated through this endpoint.',
    )
  }
}

async function prepareConfiguredCreateWorkItem(
  directoryId: string,
  teamId: string,
  input: CreateTeamIssueRequestBody,
  resolved: ResolvedWorkItemConfiguration,
): Promise<CreateTeamIssueRequestBody> {
  const workflowStatus = resolveWorkflowStatus(
    resolved.configuration,
    input.workflowStatusId,
  )
  const projectId = readAssignedProjectId(input.assignedProjectId) ?? undefined
  const customFieldValues = normalizeCustomFieldValues(
    resolved.configuration,
    input.customFieldValues,
    { mode: 'create', projectId },
  )
  await requireActiveCustomFieldPeople(directoryId, resolved.configuration, customFieldValues, projectId)
  return {
    ...input,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: workflowStatus.workflowStatusId,
    statusCategory: workflowStatus.statusCategory,
    customFieldValues,
    configurationConditionChecks: createWorkItemConfigurationGuardConditionChecks(
      getWorkItemConfigurationTableName(),
      directoryId,
      teamId,
      resolved,
    ),
  }
}

async function prepareConfiguredUpdateWorkItem(
  directoryId: string,
  teamId: string,
  current: TeamIssueResponseItem,
  input: UpdateTeamIssueRequestBody,
  resolved: ResolvedWorkItemConfiguration,
): Promise<UpdateTeamIssueRequestBody> {
  const currentWorkflowStatus = resolveWorkflowStatus(
    resolved.configuration,
    current.workflowStatusId,
  )
  const nextWorkflowStatus = resolveWorkflowStatus(
    resolved.configuration,
    input.workflowStatusId ?? currentWorkflowStatus.workflowStatusId,
  )
  assertWorkflowTransitionAllowed(
    resolved.configuration,
    currentWorkflowStatus.workflowStatusId,
    nextWorkflowStatus.workflowStatusId,
  )
  const projectId = 'assignedProjectId' in input
    ? readAssignedProjectId(input.assignedProjectId) ?? undefined
    : current.assignedProjectId
  const customFieldValues = normalizeCustomFieldValues(
    resolved.configuration,
    input.customFieldValues,
    {
      mode: 'update',
      existingValues: current.customFieldValues,
      projectId,
    },
  )
  await requireActiveCustomFieldPeople(directoryId, resolved.configuration, customFieldValues, projectId)
  return {
    ...input,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: nextWorkflowStatus.workflowStatusId,
    statusCategory: nextWorkflowStatus.statusCategory,
    customFieldValues,
    configurationConditionChecks: createWorkItemConfigurationGuardConditionChecks(
      getWorkItemConfigurationTableName(),
      directoryId,
      teamId,
      resolved,
    ),
  }
}

async function requireActiveCustomFieldPeople(
  directoryId: string,
  configuration: WorkItemConfiguration,
  values: Readonly<Record<string, CustomFieldValue>>,
  projectId?: string,
) {
  const personIds = configuration.customFields.flatMap((definition) =>
    definition.type === 'person' &&
    (!definition.projectIds || definition.projectIds.length === 0 || Boolean(
      projectId && definition.projectIds.includes(projectId),
    )) &&
    typeof values[definition.id] === 'string'
      ? [values[definition.id] as string]
      : [],
  )
  await Promise.all([...new Set(personIds)].map((personId) =>
    requireActiveWorkspaceAssignee(directoryId, personId),
  ))
}

async function validateWorkItemConfigurationReferences(
  directoryId: string,
  configuration: WorkItemConfiguration,
  teamId?: string,
) {
  const directory = await projectDirectory.getProjectDirectory(directoryId, 'ja')
  const scopedTeams = teamId
    ? directory.teams.filter((team) => team.id === teamId)
    : directory.teams
  if (teamId && scopedTeams.length === 0) {
    throw new WorkItemConfigurationError(
      404,
      'TeamNotFound',
      `Team "${teamId}" was not found.`,
    )
  }
  const activeProjectIds = new Set(
    scopedTeams.flatMap((team) => team.projects.map((project) => project.id)),
  )
  for (const definition of configuration.customFields) {
    for (const projectId of definition.projectIds ?? []) {
      if (!activeProjectIds.has(projectId)) {
        throw new WorkItemConfigurationError(
          400,
          'InvalidWorkItemConfiguration',
          `Custom field "${definition.id}" references inactive or out-of-scope project "${projectId}".`,
        )
      }
    }
    if (definition.type === 'person' && typeof definition.defaultValue === 'string') {
      await requireActiveWorkspaceAssignee(directoryId, definition.defaultValue)
    }
  }
}

async function validateWorkItemConfigurationUsage(
  directoryId: string,
  configuration: WorkItemConfiguration,
  teamId?: string,
) {
  const directory = await projectDirectory.getProjectDirectory(directoryId, 'ja')
  const targetTeamIds = teamId
    ? [teamId]
    : directory.teams.map((team) => team.id)

  for (const targetTeamId of targetTeamIds) {
    if (!teamId) {
      const resolved = await workItemConfigurations.getTeamConfiguration(
        directoryId,
        targetTeamId,
      )
      if (!resolved.inheritedFrom && resolved.configuration.scopeType === 'team') {
        continue
      }
    }

    const readLimit = createWorkItemListProbeLimit(WORK_ITEMS_PARTITION_SCAN_LIMIT)
    const response = await teamIssues.getTeamIssues(
      directoryId,
      targetTeamId,
      {
        consistentRead: true,
        ...(readLimit === undefined ? {} : { limit: readLimit }),
      },
    )
    assertWorkItemListWithinLimit(
      response.issues,
      WORK_ITEMS_PARTITION_SCAN_LIMIT,
      `Team "${targetTeamId}" configuration validation`,
    )
    for (const workItem of response.issues) {
      assertWorkItemConfigurationUsage(workItem, configuration)
    }
  }
}

function assertWorkItemConfigurationUsage(
  workItem: TeamIssueResponseItem,
  configuration: WorkItemConfiguration,
) {
  try {
    const status = resolveWorkflowStatus(
      configuration,
      workItem.workflowStatusId,
    )
    if (status.statusCategory !== workItem.statusCategory) {
      throw new Error('the stored status category would become stale')
    }

    const storedValues = workItem.customFieldValues
    const definitionIds = new Set(configuration.customFields.map((definition) => definition.id))
    const removedValueId = Object.keys(storedValues).find((fieldId) => !definitionIds.has(fieldId))
    if (removedValueId) {
      throw new Error(`stored field "${removedValueId}" would lose its definition`)
    }
    const normalizedValues = normalizeCustomFieldValues(
      configuration,
      undefined,
      {
        existingValues: storedValues,
        mode: 'update',
        projectId: workItem.assignedProjectId,
      },
    )
    for (const definition of configuration.customFields) {
      if (
        definition.type === 'formula' &&
        (!definition.projectIds ||
          definition.projectIds.length === 0 ||
          Boolean(
            workItem.assignedProjectId &&
            definition.projectIds.includes(workItem.assignedProjectId),
          )) &&
        normalizedValues[definition.id] !== storedValues[definition.id]
      ) {
        throw new Error(`formula field "${definition.id}" requires recalculation`)
      }
    }
    if (!customFieldValueRecordsEqual(storedValues, normalizedValues)) {
      throw new Error('stored custom field values require normalization or scope cleanup')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'stored values are incompatible'
    throw new WorkItemConfigurationError(
      409,
      'WorkItemConfigurationInUse',
      `Work Item "${workItem.id}" uses a definition that conflicts with this configuration: ${reason}.`,
    )
  }
}

function customFieldValueRecordsEqual(
  first: Readonly<Record<string, CustomFieldValue>>,
  second: Readonly<Record<string, CustomFieldValue>>,
) {
  const firstKeys = Object.keys(first).sort()
  const secondKeys = Object.keys(second).sort()
  if (firstKeys.length !== secondKeys.length) {
    return false
  }
  return firstKeys.every((key, index) => {
    if (key !== secondKeys[index]) {
      return false
    }
    const firstValue = first[key]
    const secondValue = second[key]
    return Array.isArray(firstValue) && Array.isArray(secondValue)
      ? firstValue.length === secondValue.length &&
        firstValue.every((value, valueIndex) => value === secondValue[valueIndex])
      : firstValue === secondValue
  })
}

function getWorkItemConfigurationTableName() {
  return getEnv('WORK_ITEM_CONFIGURATION_TABLE_NAME') ??
    'mukuroji-work-item-configuration-local'
}

function getAutomationTableName() {
  return getEnv('AUTOMATION_TABLE_NAME') ??
    getEnv('MUKUROJI_AUTOMATION_TABLE') ??
    'mukuroji-automation-local'
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

function readSourceRequestId(value: unknown) {
  if (value === undefined) {
    return undefined
  }

  if (
    typeof value !== 'string' ||
    !/^req_[A-Za-z0-9_-]{12,160}$/u.test(value.trim())
  ) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Source request ID is invalid.',
    )
  }

  return value.trim()
}

function readIdempotencyResourceId(value: unknown) {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  ) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Idempotency resource ID is invalid.',
    )
  }
  return value
}

function isMatchingIdempotentWorkItemCreate(
  issue: TeamIssueResponseItem,
  expected: {
    actorUserId: string
    assigneeUserId: string
    assignedProjectId: string | null | undefined
    customFieldValues: Record<string, CustomFieldValue>
    description: string | undefined
    dueDate: string
    priority: ProjectTaskPriority
    statusCategory: WorkflowStatusCategory
    title: string
    workflowSchemaVersion: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
    workflowStatusId: string
  },
) {
  return issue.creatorMemberKey === expected.actorUserId &&
    issue.assigneeUserId === expected.assigneeUserId &&
    issue.assignedProjectId === (expected.assignedProjectId ?? undefined) &&
    customFieldValueRecordsEqual(issue.customFieldValues, expected.customFieldValues) &&
    issue.description === expected.description &&
    issue.dueDate === expected.dueDate &&
    issue.priority === expected.priority &&
    issue.statusCategory === expected.statusCategory &&
    issue.title === expected.title &&
    issue.workflowSchemaVersion === expected.workflowSchemaVersion &&
    issue.workflowStatusId === expected.workflowStatusId
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
 * Team Issue 一覧 route で指定 Work Item を直接開く deep link を作成します。
 */
function createTeamIssueDeepLink(teamId: string, issueId: string) {
  return `/teams/${encodeURIComponent(teamId)}/issues?${new URLSearchParams({ issueId }).toString()}`
}

/**
 * Work Item の担当・状態・期限変更から通知対象と理由を組み立てます。
 */
function createWorkItemNotificationCandidates(
  before: TeamIssueItem,
  after: TeamIssueItem,
) {
  const candidates: Array<{ memberKey: string; reason: string }> = []

  if (before.assigneeUserId !== after.assigneeUserId) {
    candidates.push({ memberKey: after.assigneeUserId, reason: 'assignment' })
  }

  if (before.workflowStatusId !== after.workflowStatusId) {
    candidates.push({ memberKey: after.assigneeUserId, reason: 'status-change' })
  }

  if (before.dueDate !== after.dueDate) {
    candidates.push({ memberKey: after.assigneeUserId, reason: 'due-date-change' })
  }

  if (before.archivedAt !== after.archivedAt) {
    candidates.push({ memberKey: after.assigneeUserId, reason: 'archive-change' })
  }

  return candidates
}

/**
 * Work Item 更新通知と activity に使う最も具体的な概要を選びます。
 */
function createWorkItemNotificationSummary(before: TeamIssueItem, after: TeamIssueItem) {
  if (before.archivedAt !== after.archivedAt) {
    return after.archivedAt ? 'Work Item was archived.' : 'Work Item was restored.'
  }

  if (before.assigneeUserId !== after.assigneeUserId) {
    return 'Work Item assignment changed.'
  }

  if (before.workflowStatusId !== after.workflowStatusId) {
    return 'Work Item status changed.'
  }

  if (before.dueDate !== after.dueDate) {
    return 'Work Item due date changed.'
  }

  return 'Work Item was updated.'
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

function shouldEnableWorkspaceSearchProjection() {
  return getEnv('NODE_ENV') !== 'test' || Boolean(
    getEnv('WORKSPACE_SEARCH_TABLE_NAME') ?? getEnv('MUKUROJI_WORKSPACE_SEARCH_TABLE'),
  )
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

function createForwardingClient<TClient extends object>(resolve: () => TClient): TClient {
  return new Proxy({} as TClient, {
    get(_target, property) {
      const client = resolve()
      const value = Reflect.get(client, property)
      return typeof value === 'function' ? value.bind(client) : value
    },
  })
}

async function authenticateDeveloperManagement(
  authorization: string,
): Promise<DeveloperManagementPrincipal> {
  const accessToken = authorization.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim()
  if (!accessToken) {
    throw new PublicApiServiceError(
      401,
      'authentication_required',
      'A Cognito Bearer token is required.',
    )
  }
  const principal = await authenticateWorkspacePrincipal(accessToken)
  const canAdminister = principal.workspaceRole === 'owner' ||
    principal.workspaceRole === 'admin'
  return {
    workspaceId: principal.directoryId,
    userId: principal.userKey,
    capabilities: {
      canManageCredentials: canAdminister,
      canManageWebhooks: canAdminister,
      canManageIntegrations: canAdminister,
      canImport: canAdminister,
      canExport: canAdminister,
    },
  }
}

async function resolveDeveloperCredentialPrincipal(
  credential: AuthenticatedDeveloperCredential,
): Promise<WorkspacePrincipal> {
  const member = await workspaceAccess.getActiveMember(
    credential.workspaceId,
    credential.subjectUserId,
  )
  if (!member) {
    throw new PublicApiServiceError(
      403,
      'forbidden',
      'The credential owner is not an active Workspace member.',
    )
  }
  return {
    directoryId: credential.workspaceId,
    userKey: member.memberKey,
    actorId: member.id,
    isSystemAdmin: await cognito.isSystemAdmin(member.memberKey),
    groups: [],
    workspaceMember: member,
    workspaceRole: member.role,
    workspaceMemberStatus: member.status,
  }
}

async function resolveDeveloperManagementPrincipal(
  principal: DeveloperManagementPrincipal,
): Promise<WorkspacePrincipal> {
  return resolveDeveloperCredentialPrincipal({
    kind: 'oauth-token',
    workspaceId: principal.workspaceId,
    credentialId: `session:${principal.userId}`,
    subjectUserId: principal.userId,
    scopes: [],
  })
}

function createPublicMutationAuditContext(
  principal: WorkspacePrincipal,
  context: PublicMutationContext,
  request: {
    method: string
    path: string
    body: unknown
    query?: Record<string, string>
  },
): MutationAuditContext {
  return createMutationAuditContext({
    workspaceId: principal.directoryId,
    actor: {
      id: principal.actorId,
      kind: 'user',
      displayName: principal.userKey,
    },
    idempotencyKey: context.idempotencyKey,
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    request,
    source: {
      kind: 'api',
      requestId: context.requestId,
      method: request.method,
      route: request.path,
    },
  })
}

function createWorkItemIdempotencyTransaction(
  workspaceId: string,
  token: IdempotencyMutationToken | undefined,
): WorkItemIdempotencyTransaction | undefined {
  if (!token || !developerPlatform.prepareIdempotencyCompletionTransactWrite) {
    return undefined
  }
  return {
    async prepare(response) {
      return developerPlatform.prepareIdempotencyCompletionTransactWrite?.({
        workspaceId,
        credentialId: token.credentialId,
        idempotencyKey: token.idempotencyKey,
        requestFingerprint: token.requestFingerprint,
        reservationId: token.reservationId,
        response,
      })
    },
  }
}

/**
 * Canonical Work Item を一度だけ materialize する identity です。
 */
export type IdempotentWorkItemCreate = {
  /** Request identity と payload から決まる deterministic Work Item ID です。 */
  issueId: string
  /** Team、row payload、idempotency identity の SHA-256 digest です。 */
  requestDigest: string
}

async function createCanonicalPublicWorkItem(
  principal: WorkspacePrincipal,
  teamId: string,
  input: CreateWorkItemInput,
  context: PublicMutationContext,
  requestPath: string,
  idempotentCreate?: IdempotentWorkItemCreate,
) {
  requireWorkspaceBusinessWrite(principal)
  const permission = await requireTeamPermission(principal, teamId, 'member')
  const body = normalizeTeamIssueInput(input, permission.team)
  requireAssignedProjectPermission(
    principal,
    permission,
    readAssignedProjectId(body.assignedProjectId),
    'member',
  )
  const resolvedConfiguration = await workItemConfigurations.getTeamConfiguration(
    principal.directoryId,
    teamId,
  )
  const configuredBody = await prepareConfiguredCreateWorkItem(
    principal.directoryId,
    teamId,
    body,
    resolvedConfiguration,
  )
  const assigneeUserId = readTeamIssueAssigneeUserId(configuredBody)
  await requireActiveWorkspaceAssignee(principal.directoryId, assigneeUserId)
  const response = await teamIssues.createTeamIssue(
    principal.directoryId,
    teamId,
    {
      ...configuredBody,
      assigneeUserId,
      ...(idempotentCreate
        ? {
            idempotentIssueId: idempotentCreate.issueId,
            idempotentRequestDigest: idempotentCreate.requestDigest,
          }
        : {}),
    },
    principal.userKey,
    createPublicMutationAuditContext(principal, context, {
      method: 'POST',
      path: requestPath,
      body: { teamId, ...input },
    }),
  )
  await projectWorkItemSearchDocumentBestEffort(
    principal.directoryId,
    response.issue,
    'Public Work Item creation',
    [],
  )
  return response.issue
}

function createCanonicalPublicWorkItemService(): PublicWorkItemService {
  return {
    async list(credential, filters) {
      const principal = await resolveDeveloperCredentialPrincipal(credential)
      const teamId = typeof filters.teamId === 'string' ? filters.teamId : ''
      if (!teamId) {
        throw new PublicApiServiceError(400, 'invalid_request', 'teamId is required.')
      }
      const permission = await requireTeamPermission(principal, teamId, 'viewer')
      const response = await readTeamIssues(principal.directoryId, permission, principal)
      const updatedAfter = typeof filters.updatedAfter === 'string'
        ? Date.parse(filters.updatedAfter)
        : undefined
      return response.issues
        .filter((issue) =>
          (filters.assignedProjectId === undefined ||
            issue.assignedProjectId === filters.assignedProjectId) &&
          (filters.assigneeUserId === undefined ||
            issue.assigneeUserId === filters.assigneeUserId) &&
          (filters.workflowStatusId === undefined ||
            issue.workflowStatusId === filters.workflowStatusId) &&
          (updatedAfter === undefined || Date.parse(issue.updatedAt) > updatedAfter)
        )
        .sort((left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.id.localeCompare(right.id)
        )
    },

    async get(credential, teamId, workItemId) {
      const principal = await resolveDeveloperCredentialPrincipal(credential)
      return (await loadAuthorizedTeamIssue(
        principal,
        teamId,
        workItemId,
        'viewer',
      )).detail.issue
    },

    async create(credential, input, context) {
      const principal = await resolveDeveloperCredentialPrincipal(credential)
      const { teamId, ...workItemInput } = input
      return createCanonicalPublicWorkItem(
        principal,
        teamId,
        workItemInput,
        context,
        '/api/v1/work-items',
        createPublicApiWorkItemCreateIdentity(
          credential.workspaceId,
          credential.credentialId,
          context,
          teamId,
          workItemInput,
        ),
      )
    },

    async update(
      credential,
      teamId,
      workItemId,
      input,
      mutationContext,
      idempotency,
    ) {
      const principal = await resolveDeveloperCredentialPrincipal(credential)
      requireWorkspaceBusinessWrite(principal)
      const permission = await requireTeamPermission(principal, teamId, 'member')
      const body = normalizeTeamIssueInput(input, permission.team)
      const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
      const detail = await teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        workItemId,
        { consistentIssueRead: true, eventLimit: 0 },
      )
      requireAssignedProjectPermission(
        principal,
        permission,
        detail.issue.assignedProjectId,
        'member',
      )
      requireAssignedProjectPermission(
        principal,
        permission,
        readAssignedProjectId(body.assignedProjectId),
        'member',
      )
      const resolvedConfiguration = await workItemConfigurations.getTeamConfiguration(
        principal.directoryId,
        teamId,
      )
      const configuredBody = await prepareConfiguredUpdateWorkItem(
        principal.directoryId,
        teamId,
        detail.issue,
        body,
        resolvedConfiguration,
      )
      if ('assigneeUserId' in configuredBody) {
        await requireActiveWorkspaceAssignee(
          principal.directoryId,
          readTeamIssueAssigneeUserId(configuredBody),
        )
      }
      const response = await teamIssues.updateTeamIssue(
        principal.directoryId,
        teamId,
        workItemId,
        { ...configuredBody, expectedRevision },
        principal.userKey,
        createPublicMutationAuditContext(principal, mutationContext, {
          method: 'PATCH',
          path: `/api/v1/work-items/${encodeURIComponent(workItemId)}`,
          query: { teamId },
          body: input,
        }),
        createWorkItemIdempotencyTransaction(
          principal.directoryId,
          idempotency,
        ),
      )
      await projectWorkItemSearchDocumentBestEffort(
        principal.directoryId,
        response.issue,
        'Public Work Item update',
      )
      return response.issue
    },

    async delete(
      credential,
      teamId,
      workItemId,
      expectedRevision,
      mutationContext,
      idempotency,
    ) {
      const principal = await resolveDeveloperCredentialPrincipal(credential)
      requireWorkspaceBusinessWrite(principal)
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
      const externalLinks = await developerPlatform.listExternalWorkItemLinks({
        workspaceId: principal.directoryId,
        teamId,
        workItemId,
      })
      if (externalLinks.length > 0) {
        throw new PublicApiServiceError(
          409,
          'conflict',
          'Unlink all external resources before deleting this Work Item.',
        )
      }
      if (!teamIssues.deleteTeamIssue) {
        throw new PublicApiServiceError(
          503,
          'temporarily_unavailable',
          'Canonical Work Item deletion is not configured.',
          true,
        )
      }
      const response = await teamIssues.deleteTeamIssue(
        principal.directoryId,
        teamId,
        workItemId,
        expectedRevision,
        principal.userKey,
        createPublicMutationAuditContext(principal, mutationContext, {
          method: 'DELETE',
          path: `/api/v1/work-items/${encodeURIComponent(workItemId)}`,
          query: { teamId },
          body: { expectedRevision },
        }),
        createWorkItemIdempotencyTransaction(
          principal.directoryId,
          idempotency,
        ),
        await developerPlatform.prepareWorkItemDeletionFenceTransactWrite?.({
          workspaceId: principal.directoryId,
          teamId,
          workItemId,
        }),
      )
      await deleteWorkspaceSearchDocumentBestEffort(
        principal.directoryId,
        'work-item',
        createTeamIssueAuditEntityId(teamId, workItemId),
        'Public Work Item deletion',
      )
      return response.issue
    },

    async authorizeExternalLink(credential, teamId, workItemId, write) {
      const principal = await resolveDeveloperCredentialPrincipal(credential)
      if (write) requireWorkspaceBusinessWrite(principal)
      await loadAuthorizedTeamIssue(
        principal,
        teamId,
        workItemId,
        write ? 'member' : 'viewer',
      )
    },

    async authorizeWebhookTeams(managementPrincipal, teamIds) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal)
      requireWorkspaceBusinessWrite(principal)
      for (const teamId of teamIds) {
        await requireTeamPermission(principal, teamId, 'viewer')
      }
    },

    async dryRunImport(managementPrincipal, input) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal)
      requireWorkspaceBusinessWrite(principal)
      await requirePublicImportPermission(principal, input)
      return (await validatePublicImport(principal, input)).report
    },

    async commitImport(managementPrincipal, dryRunJobId, input, mutationContext) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal)
      requireWorkspaceBusinessWrite(principal)
      if (dryRunJobId) {
        const dryRunJob = (await developerPlatform.listImportJobs(principal.directoryId))
          .find((job) => job.id === dryRunJobId)
        if (
          !dryRunJob ||
          dryRunJob.createdByUserId !== principal.userKey ||
          !dryRunJob.dryRun
        ) {
          throw new PublicApiServiceError(404, 'not_found', 'Import dry-run job was not found.')
        }
        if (dryRunJob.status !== 'completed' || (dryRunJob.report?.invalidRows ?? 1) > 0) {
          throw new PublicApiServiceError(
            409,
            'conflict',
            'Import dry-run must complete without invalid rows before commit.',
          )
        }
        if (!matchesImportJobInput(dryRunJob, input)) {
          throw new PublicApiServiceError(
            409,
            'conflict',
            'Import metadata differs from the dry-run. Run validation again.',
          )
        }
      }
      await requirePublicImportPermission(principal, input)
      const jobId = createWorkItemImportJobId(
        principal.directoryId,
        principal.userKey,
        mutationContext.idempotencyKey,
      )
      const job = await developerPlatform.createImportJob({
        workspaceId: principal.directoryId,
        createdByUserId: principal.userKey,
        jobId,
        input: {
          format: input.format,
          teamId: input.teamId,
          ...(input.assignedProjectId
            ? { assignedProjectId: input.assignedProjectId }
            : {}),
          mapping: input.mapping,
          dryRun: false,
        },
      })
      if (job.status === 'completed') return job
      if (job.status === 'failed' || job.status === 'cancelled') {
        throw new PublicApiServiceError(
          409,
          'conflict',
          'The deterministic import job is already in a terminal state.',
        )
      }
      try {
        await stageWorkItemImport({
          jobId: job.id,
          workspaceId: principal.directoryId,
          createdByUserId: principal.userKey,
          teamId: input.teamId,
          ...(input.assignedProjectId
            ? { assignedProjectId: input.assignedProjectId }
            : {}),
          format: input.format,
          sourceContent: input.source.content,
          mapping: input.mapping,
          requestFingerprint: createHash('sha256')
            .update(`management-import-v1\n${mutationContext.idempotencyKey}`)
            .digest('hex'),
        }, {
          executions: workItemImportExecutions,
          sources: workItemImportSources,
          queue: workItemImportQueue,
          now: () => new Date(),
        })
        return job
      } catch (error) {
        if (!(error instanceof WorkItemImportError && error.retryable)) {
          await failImportJobBestEffort(principal.directoryId, job.id, error)
        }
        throw error
      }
    },

    async authorizeImportJob(managementPrincipal, job, write) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal)
      requireWorkspaceBusinessWrite(principal)
      if (job.createdByUserId !== principal.userKey) {
        throw new PublicApiServiceError(404, 'not_found', 'Import job was not found.')
      }
      const permission = await requireTeamPermission(
        principal,
        job.teamId,
        write ? 'member' : 'viewer',
      )
      requireAssignedProjectPermission(
        principal,
        permission,
        job.assignedProjectId,
        write ? 'member' : 'viewer',
      )
    },

    async cancelImport(managementPrincipal, job) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal)
      requireWorkspaceBusinessWrite(principal)
      if (job.createdByUserId !== principal.userKey) {
        throw new PublicApiServiceError(404, 'not_found', 'Import job was not found.')
      }
      const permission = await requireTeamPermission(principal, job.teamId, 'member')
      requireAssignedProjectPermission(
        principal,
        permission,
        job.assignedProjectId,
        'member',
      )
      if (job.status === 'cancelled') return job
      if (job.status === 'completed' || job.status === 'failed') {
        throw new PublicApiServiceError(
          409,
          'conflict',
          'Only a queued or running import can be cancelled.',
        )
      }
      await requestWorkItemImportCancellation(
        principal.directoryId,
        job.id,
        {
          executions: workItemImportExecutions,
          sources: workItemImportSources,
          jobs: createWorkItemImportJobLifecycle(),
          now: () => new Date(),
        },
      )
      return requireImportJob(principal.directoryId, job.id)
    },

    async export(managementPrincipal, format) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal)
      requireWorkspaceBusinessWrite(principal)
      return createWorkItemExport(
        format,
        await readAccessibleWorkItemsForExport(principal),
      )
    },
  }
}

/** Production connector runtime の API/worker 共有 components です。 */
type ConnectorRuntimeBundle = {
  /** OAuth lifecycle と conflict recovery の API boundary です。 */
  authorization: ConnectorAuthorizationRuntime
  /** Provider と canonical Work Item の双方向 sync engine です。 */
  syncEngine: ConnectorSyncEngine
}

/** Canonical Work Item service を connector worker の current-RBAC/CAS boundary へ適合します。 */
function createCanonicalConnectorWorkItemGateway(): ConnectorWorkItemGateway {
  return {
    async authorize(workspaceId, actorUserId, teamId, workItemId, write) {
      try {
        const principal = await resolveConnectorActorPrincipal(workspaceId, actorUserId)
        if (write) requireWorkspaceBusinessWrite(principal)
        await loadAuthorizedTeamIssue(
          principal,
          teamId,
          workItemId,
          write ? 'member' : 'viewer',
        )
      } catch (error) {
        if (
          (error instanceof PublicApiServiceError || error instanceof ProjectDataError) &&
          (error.status === 403 || error.status === 404)
        ) {
          throw new ConnectorRuntimeError(
            'ConnectorWorkItemAccessDenied',
            'The connector actor cannot access this Work Item.',
          )
        }
        throw error
      }
    },

    async get(workspaceId, teamId, workItemId) {
      const detail = await teamIssues.getTeamIssueDetail(
        workspaceId,
        teamId,
        workItemId,
        { consistentIssueRead: true, eventLimit: 0 },
      )
      return toConnectorWorkItemSnapshot(detail.issue)
    },

    async applyExternal(input) {
      const principal = await resolveConnectorActorPrincipal(
        input.workspaceId,
        input.actorUserId,
      )
      requireWorkspaceBusinessWrite(principal)
      const permission = await requireTeamPermission(principal, input.teamId, 'member')
      const requestFingerprint = createHash('sha256')
        .update(stableDigestStringify({
          version: 1,
          workspaceId: input.workspaceId,
          teamId: input.teamId,
          workItemId: input.workItemId,
          actorUserId: input.actorUserId,
          expectedRevision: input.expectedRevision,
          patch: input.patch,
        }))
        .digest('hex')
      const credentialId = `connector-sync:${createHash('sha256')
        .update(`${input.workspaceId}\0${input.actorUserId}`)
        .digest('hex')
        .slice(0, 48)}`
      const reservationRequest = {
        workspaceId: input.workspaceId,
        credentialId,
        idempotencyKey: input.operationId,
        requestFingerprint,
      }
      const reservation = await developerPlatform.reserveIdempotency(reservationRequest)
      if (reservation.status === 'replay') {
        return {
          kind: 'applied',
          workItem: readConnectorWorkItemReplay(
            reservation.response,
            input.teamId,
            input.workItemId,
          ),
        }
      }
      if (reservation.status === 'in-progress') {
        throw new ConnectorRuntimeError(
          'ConnectorWorkItemMutationInProgress',
          'The same connector Work Item mutation is still in progress.',
          { retryable: true },
        )
      }
      const completionRequest = {
        ...reservationRequest,
        reservationId: reservation.reservationId,
      }
      try {
        const detail = await teamIssues.getTeamIssueDetail(
          input.workspaceId,
          input.teamId,
          input.workItemId,
          { consistentIssueRead: true, eventLimit: 0 },
        )
        requireAssignedProjectPermission(
          principal,
          permission,
          detail.issue.assignedProjectId,
          'member',
        )
        if (detail.issue.revision !== input.expectedRevision) {
          await developerPlatform.releaseIdempotency(completionRequest)
          return {
            kind: 'conflict',
            workItem: toConnectorWorkItemSnapshot(detail.issue),
          }
        }
        const body = normalizeTeamIssueInput({
          expectedRevision: input.expectedRevision,
          ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
          ...(input.patch.description !== undefined
            ? { description: input.patch.description }
            : {}),
          ...(input.patch.status !== undefined
            ? { workflowStatusId: input.patch.status }
            : {}),
        }, permission.team)
        const configuration = await workItemConfigurations.getTeamConfiguration(
          input.workspaceId,
          input.teamId,
        )
        const configuredBody = await prepareConfiguredUpdateWorkItem(
          input.workspaceId,
          input.teamId,
          detail.issue,
          body,
          configuration,
        )
        const idempotencyTransaction: WorkItemIdempotencyTransaction | undefined =
          developerPlatform.prepareIdempotencyCompletionTransactWrite
            ? {
                async prepare(response) {
                  return developerPlatform.prepareIdempotencyCompletionTransactWrite?.({
                    ...completionRequest,
                    response,
                  })
                },
              }
            : undefined
        const response = await teamIssues.updateTeamIssue(
          input.workspaceId,
          input.teamId,
          input.workItemId,
          configuredBody,
          principal.userKey,
          createMutationAuditContext({
            workspaceId: input.workspaceId,
            actor: {
              id: principal.actorId,
              kind: 'user',
              displayName: principal.userKey,
            },
            idempotencyKey: input.operationId,
            request: {
              method: 'SYNC',
              path: `/connector-sync/work-items/${input.workItemId}`,
              body: input.patch,
            },
            source: {
              kind: 'system',
              requestId: `connector-sync-${createHash('sha256')
                .update(input.operationId)
                .digest('hex')
                .slice(0, 24)}`,
            },
          }),
          idempotencyTransaction,
        )
        await developerPlatform.completeIdempotency({
          ...completionRequest,
          response: { status: 200, body: response.issue },
        })
        await projectWorkItemSearchDocumentBestEffort(
          input.workspaceId,
          response.issue,
          'Connector Work Item synchronization',
        )
        return {
          kind: 'applied',
          workItem: toConnectorWorkItemSnapshot(response.issue),
        }
      } catch (error) {
        await developerPlatform.releaseIdempotency(completionRequest).catch(() => undefined)
        if (error instanceof ProjectDataError && error.code === 'WorkItemRevisionConflict') {
          const latest = await teamIssues.getTeamIssueDetail(
            input.workspaceId,
            input.teamId,
            input.workItemId,
            { consistentIssueRead: true, eventLimit: 0 },
          )
          return {
            kind: 'conflict',
            workItem: toConnectorWorkItemSnapshot(latest.issue),
          }
        }
        throw error
      }
    },
  }
}

/** Connector actor の current Workspace membership を解決します。 */
function resolveConnectorActorPrincipal(workspaceId: string, actorUserId: string) {
  return resolveDeveloperCredentialPrincipal({
    kind: 'oauth-token',
    workspaceId,
    credentialId: `connector-actor:${createHash('sha256')
      .update(actorUserId)
      .digest('hex')
      .slice(0, 48)}`,
    subjectUserId: actorUserId,
    scopes: [],
  })
}

/** Canonical response を provider-neutral connector snapshot へ変換します。 */
function toConnectorWorkItemSnapshot(
  issue: TeamIssueResponseItem,
): ConnectorWorkItemSnapshot {
  return {
    id: issue.id,
    teamId: issue.teamId,
    revision: issue.revision,
    title: issue.title,
    ...(issue.description ? { description: issue.description } : {}),
    status: issue.workflowStatusId,
  }
}

/** Encrypted idempotency receipt から tenant/resource-bound snapshot を復元します。 */
function readConnectorWorkItemReplay(
  value: unknown,
  teamId: string,
  workItemId: string,
) {
  if (!isRecord(value) || value.status !== 200 || value.body === undefined) {
    throw new ConnectorRuntimeError(
      'ConnectorWorkItemReceiptInvalid',
      'Connector Work Item idempotency receipt is invalid.',
    )
  }
  const issue = toTeamIssueResponseItem(value.body)
  if (issue.teamId !== teamId || issue.id !== workItemId) {
    throw new ConnectorRuntimeError(
      'ConnectorWorkItemReceiptInvalid',
      'Connector Work Item idempotency receipt belongs to another resource.',
    )
  }
  return toConnectorWorkItemSnapshot(issue)
}

/** Current membership と integration 管理権限を OAuth callback 時に再評価します。 */
function createConnectorOAuthCallbackAuthorizer(): ConnectorOAuthCallbackAuthorizer {
  return {
    async authorize(workspaceId, userId) {
      const principal = await resolveConnectorActorPrincipal(workspaceId, userId)
      requireWorkspaceBusinessWrite(principal)
      if (principal.workspaceRole !== 'owner' && principal.workspaceRole !== 'admin') {
        throw new PublicApiServiceError(
          403,
          'forbidden',
          'Current Workspace administrator access is required to connect providers.',
        )
      }
    },
  }
}

/** Environment に provider がある場合だけ production connector runtime を構築します。 */
function createConfiguredConnectorRuntime(
  environment: NodeJS.ProcessEnv,
): ConnectorRuntimeBundle | undefined {
  const encodedConfiguration = environment.MUKUROJI_CONNECTOR_PROVIDERS_JSON?.trim()
  if (!hasConfiguredConnectorProviders(encodedConfiguration)) return undefined
  const registry = createOAuthConnectorRegistryFromEnvironment({
    environment,
  })
  const signingSecret = environment.CONNECTOR_OAUTH_STATE_SIGNING_SECRET?.trim()
  if (!signingSecret) {
    throw new TypeError(
      'CONNECTOR_OAUTH_STATE_SIGNING_SECRET is required when connectors are configured.',
    )
  }
  const originSigningSecret = environment.CONNECTOR_SYNC_ORIGIN_SIGNING_SECRET?.trim()
  if (!originSigningSecret) {
    throw new TypeError(
      'CONNECTOR_SYNC_ORIGIN_SIGNING_SECRET is required when connectors are configured.',
    )
  }
  const state = new ConnectorOAuthStateManager({
    store: createDynamoDbConnectorOAuthStateStoreFromEnvironment(environment),
    protector: createDefaultSecretProtector(),
    signingSecret,
    previousSigningSecrets: readConnectorOAuthStatePreviousSigningSecrets(
      environment.CONNECTOR_OAUTH_STATE_PREVIOUS_SIGNING_SECRETS_JSON,
    ),
  })
  const persistence = createDynamoDbConnectorSyncPersistenceFromEnvironment()
  let authorization: ConnectorAuthorizationRuntime | undefined
  const health = createForwardingClient<ConnectorSyncHealthReporter>(() => {
    if (!authorization) {
      throw new ConnectorRuntimeError(
        'ConnectorRuntimeUnavailable',
        'Connector authorization runtime is not initialized.',
        { retryable: true },
      )
    }
    return authorization
  })
  const syncEngine = new ConnectorSyncEngine({
    platform: createForwardingClient(() => developerPlatform),
    registry,
    workItems: createCanonicalConnectorWorkItemGateway(),
    persistence,
    health,
    originSigningSecret,
  })
  authorization = new ConnectorAuthorizationRuntime({
    platform: createForwardingClient(() => developerPlatform),
    registry,
    state,
    callbackAuthorizer: createConnectorOAuthCallbackAuthorizer(),
    conflicts: createConnectorConflictRuntime(syncEngine),
    reauthorizationReturnUrl:
      environment.CONNECTOR_REAUTHORIZATION_RETURN_URL?.trim() ??
        '/settings?developerSection=connectors',
  })
  return { authorization, syncEngine }
}

/** OAuth state key rotation の grace period に使う旧 secret JSON array を検証します。 */
function readConnectorOAuthStatePreviousSigningSecrets(
  value: string | undefined,
) {
  if (!value?.trim()) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      !Array.isArray(parsed) ||
      parsed.length > 3 ||
      parsed.some((secret) => typeof secret !== 'string' || !secret.trim())
    ) {
      throw new TypeError()
    }
    return parsed.map((secret) => secret.trim())
  } catch {
    throw new TypeError(
      'CONNECTOR_OAUTH_STATE_PREVIOUS_SIGNING_SECRETS_JSON must be a JSON array of up to three non-empty strings.',
    )
  }
}

/** Empty configuration で connector routes を fail-closed に保ちます。 */
function hasConfiguredConnectorProviders(value: string | undefined) {
  if (!value) return false
  try {
    const parsed = JSON.parse(value) as unknown
    return !Array.isArray(parsed) || parsed.length > 0
  } catch {
    return true
  }
}

/**
 * Warm Lambda invocation 間で成功値を短時間共有し、一時障害後は bounded backoff で再取得します。
 */
const connectorRuntimeBundleCache = createConnectorRuntimeCache({
  async load() {
    return createConfiguredConnectorRuntime(
      await loadConnectorRuntimeEnvironment(),
    )
  },
})

/** Secrets Manager-backed connector runtime を TTL と bounded retry 付きで構築します。 */
async function getConfiguredConnectorRuntimeBundle() {
  return connectorRuntimeBundleCache.get()
}

/** 設定済み OAuth runtime を返し、未設定なら secret-free error で fail-closed にします。 */
async function requireConfiguredConnectorAuthorization() {
  const runtime = await getConfiguredConnectorRuntimeBundle()
  if (!runtime) {
    throw new ConnectorRuntimeError(
      'ConnectorRuntimeUnavailable',
      'Connector provider authorization is not configured.',
      { retryable: true },
    )
  }
  return runtime.authorization
}

/** Connector worker entrypoint へ設定済み sync engine を遅延提供します。 */
export async function requireConfiguredConnectorSyncEngine() {
  const runtime = await getConfiguredConnectorRuntimeBundle()
  if (!runtime) {
    throw new ConnectorRuntimeError(
      'ConnectorRuntimeUnavailable',
      'Connector synchronization is not configured.',
      { retryable: true },
    )
  }
  return runtime.syncEngine
}

/** Public router が module-load secret read なしで利用する OAuth runtime proxy です。 */
const lazyConnectorAuthorization: ConnectorAuthorizationService = {
  async begin(principal, input, operationId) {
    return (await requireConfiguredConnectorAuthorization())
      .begin(principal, input, operationId)
  },
  async completeCallback(input) {
    return (await requireConfiguredConnectorAuthorization()).completeCallback(input)
  },
  async abortCallback(input) {
    return (await requireConfiguredConnectorAuthorization()).abortCallback(input)
  },
  async reauthorize(principal, installationId, operationId) {
    return (await requireConfiguredConnectorAuthorization())
      .reauthorize(principal, installationId, operationId)
  },
  async disconnect(principal, installationId) {
    return (await requireConfiguredConnectorAuthorization())
      .disconnect(principal, installationId)
  },
  async listConflicts(principal, input) {
    return (await requireConfiguredConnectorAuthorization())
      .listConflicts(principal, input)
  },
  async resolveConflict(principal, conflictId, input) {
    return (await requireConfiguredConnectorAuthorization())
      .resolveConflict(principal, conflictId, input)
  },
}

async function requirePublicImportPermission(
  principal: WorkspacePrincipal,
  input: PublicImportSourceInput,
) {
  const permission = await requireTeamPermission(principal, input.teamId, 'member')
  requireAssignedProjectPermission(
    principal,
    permission,
    input.assignedProjectId,
    'member',
  )
  return permission
}

async function validatePublicImport(
  principal: WorkspacePrincipal,
  input: PublicImportSourceInput,
) {
  const permission = await requirePublicImportPermission(principal, input)
  const configuration = await workItemConfigurations.getTeamConfiguration(
    principal.directoryId,
    input.teamId,
  )
  const preview = previewWorkItemImport(
    input.format,
    input.source.content,
    input.mapping,
  )
  const errorsByRow = new Map<number, ImportRowError[]>(
    preview.rows.map((row) => [row.row, [...row.errors]]),
  )
  const mappedByRow = new Map<number, Record<string, unknown>>()
  const validInputs: Array<{ row: number; input: CreateWorkItemInput }> = []
  const assigneeValidations = new Map<
    string,
    ReturnType<typeof requireActiveWorkspaceAssignee>
  >()
  for (const row of preview.rows) {
    if (!row.input) continue
    const candidate: CreateWorkItemInput = {
      ...row.input,
      ...(row.input.assignedProjectId === undefined && input.assignedProjectId
        ? { assignedProjectId: input.assignedProjectId }
        : {}),
    }
    mappedByRow.set(row.row, { ...candidate })
    try {
      const normalized = normalizeTeamIssueInput(candidate, permission.team)
      requireAssignedProjectPermission(
        principal,
        permission,
        readAssignedProjectId(normalized.assignedProjectId),
        'member',
      )
      const configured = await prepareConfiguredCreateWorkItem(
        principal.directoryId,
        input.teamId,
        normalized,
        configuration,
      )
      const assigneeUserId = readTeamIssueAssigneeUserId(configured)
      let assigneeValidation = assigneeValidations.get(assigneeUserId)
      if (!assigneeValidation) {
        assigneeValidation = requireActiveWorkspaceAssignee(
          principal.directoryId,
          assigneeUserId,
        )
        assigneeValidations.set(assigneeUserId, assigneeValidation)
      }
      await assigneeValidation
      validInputs.push({ row: row.row, input: candidate })
    } catch (error) {
      const rowError = toImportRowError(error, row.row)
      if (!rowError) throw error
      errorsByRow.get(row.row)?.push(rowError)
    }
  }
  const errors = [...errorsByRow.values()].flat()
  const invalidRowIds = new Set(errors.map((error) => error.row))
  const report: ImportDryRunReport = {
    valid: invalidRowIds.size === 0,
    totalRows: preview.totalRows,
    validRows: preview.totalRows - invalidRowIds.size,
    invalidRows: invalidRowIds.size,
    errors,
    sample: preview.rows.slice(0, 20).map((row) => {
      const rowErrors = errorsByRow.get(row.row) ?? []
      return {
        row: row.row,
        input: {},
        mapped: mappedByRow.get(row.row) ?? {},
        valid: rowErrors.length === 0,
        errors: rowErrors,
      }
    }),
  }
  return {
    report,
    validInputs: validInputs.filter((row) => !invalidRowIds.has(row.row)),
  }
}

async function requireImportJob(workspaceId: string, jobId: string) {
  const job = (await developerPlatform.listImportJobs(workspaceId))
    .find((candidate) => candidate.id === jobId)
  if (!job) {
    throw new WorkItemImportError('ImportJobNotFound', 'Import job was not found.')
  }
  return job
}

function createWorkItemImportJobLifecycle() {
  return {
    async markRunning(execution: WorkItemImportExecution) {
      const job = await requireImportJob(execution.workspaceId, execution.jobId)
      if (job.status === 'running' || job.status === 'completed') return
      if (job.status !== 'queued') {
        throw new WorkItemImportError(
          'ImportJobTerminal',
          'Import job cannot be started from its current state.',
        )
      }
      await developerPlatform.updateImportJob({
        workspaceId: execution.workspaceId,
        jobId: execution.jobId,
        status: 'running',
      })
    },

    async markCompleted(
      execution: WorkItemImportExecution,
      report: ImportReport,
    ) {
      const job = await requireImportJob(execution.workspaceId, execution.jobId)
      if (job.status === 'completed') return
      if (job.status !== 'running') {
        throw new WorkItemImportError(
          'ImportJobTerminal',
          'Import job cannot be completed from its current state.',
        )
      }
      await developerPlatform.updateImportJob({
        workspaceId: execution.workspaceId,
        jobId: execution.jobId,
        status: 'completed',
        report: createStoredWorkItemImportReport(report),
      })
    },

    async markFailed(
      execution: WorkItemImportExecution,
      problem: ApiProblem,
      report?: ImportReport,
    ) {
      const job = await requireImportJob(execution.workspaceId, execution.jobId)
      if (job.status === 'failed' || job.status === 'completed' || job.status === 'cancelled') {
        return
      }
      await developerPlatform.updateImportJob({
        workspaceId: execution.workspaceId,
        jobId: execution.jobId,
        status: 'failed',
        ...(report ? { report: createStoredWorkItemImportReport(report) } : {}),
        error: problem,
      })
    },

    async markCancelled(execution: WorkItemImportExecution) {
      const job = await requireImportJob(execution.workspaceId, execution.jobId)
      if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') {
        return
      }
      await developerPlatform.updateImportJob({
        workspaceId: execution.workspaceId,
        jobId: execution.jobId,
        status: 'cancelled',
      })
    },
  }
}

async function resolveWorkItemImportPrincipal(execution: WorkItemImportExecution) {
  return resolveDeveloperManagementPrincipal({
    workspaceId: execution.workspaceId,
    userId: execution.createdByUserId,
    capabilities: {
      canManageCredentials: false,
      canManageWebhooks: false,
      canManageIntegrations: false,
      canImport: true,
      canExport: false,
    },
  })
}

/** Current Workspace role が management import を開始・継続できるか判定します。 */
export function canManageWorkItemImports(role: WorkspaceRole) {
  return role === 'owner' || role === 'admin'
}

async function authorizeWorkItemImportExecution(execution: WorkItemImportExecution) {
  try {
    const principal = await resolveWorkItemImportPrincipal(execution)
    if (!canManageWorkItemImports(principal.workspaceRole)) {
      throw new WorkItemImportError(
        'ImportManagementAccessRevoked',
        'Import management access is no longer available.',
      )
    }
    requireWorkspaceBusinessWrite(principal)
    const permission = await requireTeamPermission(principal, execution.teamId, 'member')
    requireAssignedProjectPermission(
      principal,
      permission,
      execution.assignedProjectId,
      'member',
    )
  } catch (error) {
    throw toWorkItemImportWorkerError(error)
  }
}

/** Worker error を retryable concurrency と terminal authorization/validation に分類します。 */
export function toWorkItemImportWorkerError(error: unknown): unknown {
  if (error instanceof WorkItemImportError) return error
  const mapped = mapPublicApiAdapterError(error)
  if (!mapped || mapped.retryable || mapped.status >= 500) return error
  const errorCode = error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string'
    ? error.code
    : undefined
  if (
    mapped.status === 409 &&
    (errorCode === 'WorkItemConfigurationRevisionConflict' ||
      errorCode === 'ConditionalCheckFailedException')
  ) {
    return new WorkItemImportError(
      'ImportConcurrentMutation',
      'Import encountered a concurrent state change and will retry.',
      true,
    )
  }
  if (mapped.status === 401 || mapped.status === 403 || mapped.status === 404) {
    return new WorkItemImportError(
      'ImportAuthorizationRejected',
      'Import is no longer authorized by current Workspace, Team, or Project access.',
    )
  }
  return new WorkItemImportError(
    'ImportValidationRejected',
    'Import source no longer passes current validation.',
  )
}

function createWorkItemImportWorkerDependencies(): WorkItemImportWorkerDependencies {
  return {
    executions: workItemImportExecutions,
    sources: workItemImportSources,
    jobs: createWorkItemImportJobLifecycle(),
    authorize: authorizeWorkItemImportExecution,
    async validate(execution, sourceContent) {
      try {
        const principal = await resolveWorkItemImportPrincipal(execution)
        const validation = await validatePublicImport(principal, {
          format: execution.format,
          source: {
            fileName: execution.format === 'csv' ? 'import.csv' : 'import.json',
            mediaType: execution.format === 'csv' ? 'text/csv' : 'application/json',
            content: sourceContent,
          },
          teamId: execution.teamId,
          ...(execution.assignedProjectId
            ? { assignedProjectId: execution.assignedProjectId }
            : {}),
          mapping: execution.mapping,
        })
        return { report: validation.report, rows: validation.validInputs }
      } catch (error) {
        throw toWorkItemImportWorkerError(error)
      }
    },
    async createWorkItem(request) {
      try {
        const principal = await resolveWorkItemImportPrincipal(request.execution)
        await createCanonicalPublicWorkItem(
          principal,
          request.execution.teamId,
          request.input,
          {
            requestId: `import-worker-${createHash('sha256')
              .update(request.execution.jobId)
              .digest('hex')
              .slice(0, 20)}`,
            idempotencyKey: request.idempotencyKey,
            correlationId: request.execution.jobId,
          },
          '/api/developer/imports',
          {
            issueId: request.workItemId,
            requestDigest: request.requestDigest,
          },
        )
      } catch (error) {
        throw toWorkItemImportWorkerError(error)
      }
    },
    now: () => new Date(),
    createLeaseOwner: randomUUID,
  }
}

function toImportRowError(error: unknown, row: number): ImportRowError | undefined {
  if (
    error instanceof ProjectDataError ||
    error instanceof WorkspaceAccessError ||
    error instanceof WorkItemConfigurationError ||
    error instanceof CognitoServiceError
  ) {
    if (error.status >= 500) return undefined
    return { row, code: error.code, message: error.message }
  }
  return undefined
}

function matchesImportJobInput(
  job: Awaited<ReturnType<DeveloperPlatformClient['listImportJobs']>>[number],
  input: PublicImportSourceInput,
) {
  return job.format === input.format &&
    job.teamId === input.teamId &&
    job.assignedProjectId === input.assignedProjectId &&
    JSON.stringify(job.mapping) === JSON.stringify(input.mapping)
}

/**
 * Actor-scoped import row identity と payload digest を作成します。
 */
export function createImportRowCreateIdentity(
  workspaceId: string,
  actorUserId: string,
  context: PublicMutationContext,
  teamId: string,
  input: CreateWorkItemInput,
): IdempotentWorkItemCreate {
  const identityDigest = createHash('sha256')
    .update(`${workspaceId}\n${actorUserId}\n${context.idempotencyKey}\n${teamId}`)
    .digest('hex')
  const requestDigest = createHash('sha256')
    .update(
      `${workspaceId}\n${actorUserId}\n${context.idempotencyKey}\n` +
        `${teamId}\n${stableDigestStringify(input)}`,
    )
    .digest('hex')
  return {
    issueId: `import-${identityDigest.slice(0, 48)}`,
    requestDigest,
  }
}

function createPublicApiWorkItemCreateIdentity(
  workspaceId: string,
  credentialId: string,
  context: PublicMutationContext,
  teamId: string,
  input: CreateWorkItemInput,
): IdempotentWorkItemCreate {
  const requestIdentity =
    `${workspaceId}\n${credentialId}\n${context.idempotencyKey}\n${teamId}`
  const identityDigest = createHash('sha256')
    .update(`public-work-item-v1\n${requestIdentity}`)
    .digest('hex')
  const requestDigest = createHash('sha256')
    .update(
      `public-work-item-v1\n${requestIdentity}\n${stableDigestStringify(input)}`,
    )
    .digest('hex')
  return {
    issueId: `api-${identityDigest.slice(0, 48)}`,
    requestDigest,
  }
}

function stableDigestStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableDigestStringify).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableDigestStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function failImportJobBestEffort(
  workspaceId: string,
  jobId: string,
  error: unknown,
) {
  try {
    await developerPlatform.updateImportJob({
      workspaceId,
      jobId,
      status: 'failed',
      error: toImportApiProblem(error),
    })
  } catch (updateError) {
    const failure = mapPublicApiAdapterError(updateError)
    console.error('Failed to persist import job failure.', {
      code: failure?.code ?? 'internal_error',
      status: failure?.status ?? 500,
    })
  }
}

function toImportApiProblem(error: unknown): ApiProblem {
  const mapped = mapPublicApiAdapterError(error)
  const normalized = mapped ?? new PublicApiServiceError(
    500,
    'internal_error',
    'Import failed unexpectedly.',
    true,
  )
  return {
    type: `https://docs.mukuroji.app/problems/${normalized.code}`,
    title: normalized.code,
    status: normalized.status,
    code: normalized.code,
    detail: normalized.message,
    requestId: 'import-job',
    retryable: normalized.retryable,
  }
}

function mapPublicApiAdapterError(error: unknown) {
  if (error instanceof PublicApiServiceError) return error
  if (error instanceof ConnectorRuntimeError) {
    const status = error.providerStatus === 429
      ? 429
      : error.retryable
        ? 503
        : error.authorizationRequired
          ? 409
          : error.code.includes('NotFound')
            ? 404
            : error.code.includes('Conflict') ||
                error.code.includes('Changed') ||
                error.code.includes('Mismatch') ||
                error.code.includes('Consumed')
              ? 409
              : 400
    const code = status === 429
      ? 'rate_limited'
      : status === 503
        ? 'temporarily_unavailable'
        : status === 404
          ? 'not_found'
          : status === 409
            ? 'conflict'
            : 'validation_failed'
    return new PublicApiServiceError(status, code, error.message, error.retryable)
  }
  if (error instanceof WorkItemImportError) {
    return new PublicApiServiceError(
      error.retryable ? 503 : 409,
      error.retryable ? 'temporarily_unavailable' : 'conflict',
      error.retryable
        ? 'Import could not be queued because a durable dependency is temporarily unavailable.'
        : error.message,
      error.retryable,
    )
  }
  if (error instanceof WorkItemTransferError) {
    return new PublicApiServiceError(
      error.status,
      error.status >= 500 ? 'temporarily_unavailable' : 'validation_failed',
      error.message,
      error.status >= 500,
    )
  }
  if (
    error instanceof ProjectDataError ||
    error instanceof WorkspaceAccessError ||
    error instanceof WorkItemConfigurationError ||
    error instanceof CognitoServiceError
  ) {
    const code = error.status === 401
      ? 'invalid_credentials'
      : error.status === 403
        ? 'forbidden'
        : error.status === 404
          ? 'not_found'
          : error.status === 409
            ? 'conflict'
            : error.status >= 500
              ? 'temporarily_unavailable'
              : 'validation_failed'
    return new PublicApiServiceError(error.status, code, error.message, error.status >= 500)
  }
  return undefined
}

function getPublicApiCursorSecret() {
  const configured = getEnv('PUBLIC_API_CURSOR_SECRET') ??
    getEnv('MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY')
  if (configured && Buffer.byteLength(configured, 'utf8') >= 32) {
    return configured
  }
  const production = process.env.NODE_ENV === 'production' ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(process.env.AWS_EXECUTION_ENV)
  if (production) {
    throw new TypeError('A 32-byte Public API cursor signing secret is required.')
  }
  return 'mukuroji-local-public-api-cursor-signing-secret'
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
notifications = new DynamoDbNotificationsClient()
workspaceSearch = new DynamoDbWorkspaceSearchClient()
workspaceSearchProjectionEnabled = shouldEnableWorkspaceSearchProjection()
workItemConfigurations = createWorkItemConfigurationClient()
automation = createAutomationClient()
automationInboundWebhookSecrets = new SecretsManagerAutomationInboundWebhookSecretStore()
planning = createPlanningClient()
developerPlatform = new DynamoDbDeveloperPlatformClient()
workItemImportExecutions = createDefaultWorkItemImportExecutionStore()
workItemImportSources = createDefaultWorkItemImportSourceStore()
workItemImportQueue = createDefaultWorkItemImportQueue()
publicWorkItems = createCanonicalPublicWorkItemService()

if (!getEnv('MUKUROJI_RUNTIME_ROLE')) {
  requestIntake = createDefaultRequestIntakeClient()
  const publicApiDependencies: PublicApiDependencies = {
    developerPlatform: createForwardingClient(() => developerPlatform),
    authenticateManagement: authenticateDeveloperManagement,
    workItems: createForwardingClient(() => publicWorkItems),
    openApiDocument: PUBLIC_API_OPENAPI_DOCUMENT as unknown as Record<string, unknown>,
    cursorSecret: getPublicApiCursorSecret(),
    queueWebhookDelivery: queueWebhookDeliveryMessage,
    connectorAuthorization: lazyConnectorAuthorization,
    mapError: mapPublicApiAdapterError,
  }
  app.route('/api', createPublicApiRouter(publicApiDependencies))
}

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
  notifications?: NotificationClient
  workspaceSearch?: WorkspaceSearchClient
  workItemConfigurations?: WorkItemConfigurationClient
  automation?: AutomationClient
  automationInboundWebhookSecrets?: AutomationInboundWebhookSecretStore
  planning?: PlanningClient
  developerPlatform?: DeveloperPlatformClient
  publicWorkItems?: PublicWorkItemService
  workItemImportExecutions?: WorkItemImportExecutionStore
  workItemImportSources?: WorkItemImportSourceStore
  workItemImportQueue?: WorkItemImportQueue
  requestIntake?: RequestIntakeClient
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
  notifications = clients.notifications ?? notifications
  workspaceSearch = clients.workspaceSearch ?? workspaceSearch
  if (clients.workspaceSearch) workspaceSearchProjectionEnabled = true
  workItemConfigurations = clients.workItemConfigurations ?? workItemConfigurations
  automation = clients.automation ?? automation
  automationInboundWebhookSecrets = clients.automationInboundWebhookSecrets ??
    automationInboundWebhookSecrets
  planning = clients.planning ?? planning
  developerPlatform = clients.developerPlatform ?? developerPlatform
  publicWorkItems = clients.publicWorkItems ?? publicWorkItems
  workItemImportExecutions = clients.workItemImportExecutions ?? workItemImportExecutions
  workItemImportSources = clients.workItemImportSources ?? workItemImportSources
  workItemImportQueue = clients.workItemImportQueue ?? workItemImportQueue
  requestIntake = clients.requestIntake ?? requestIntake
}

/**
 * Server test 後に外部 service client を実装 client に戻します。
 */
export function resetApiClientsForTest() {
  connectorRuntimeBundleCache.clear()
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
  notifications = new DynamoDbNotificationsClient()
  workspaceSearch = new DynamoDbWorkspaceSearchClient()
  workspaceSearchProjectionEnabled = shouldEnableWorkspaceSearchProjection()
  workItemConfigurations = createDefaultWorkItemConfigurationClient()
  automation = createAutomationClient()
  automationInboundWebhookSecrets = new SecretsManagerAutomationInboundWebhookSecretStore()
  planning = new InMemoryPlanningClient()
  developerPlatform = new DynamoDbDeveloperPlatformClient()
  workItemImportExecutions = createDefaultWorkItemImportExecutionStore()
  workItemImportSources = createDefaultWorkItemImportSourceStore()
  workItemImportQueue = createDefaultWorkItemImportQueue()
  publicWorkItems = createCanonicalPublicWorkItemService()
  requestIntake = createDefaultRequestIntakeClient()
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

/** Durable Work Item import SQS batch を current RBAC で処理します。 */
export async function workItemImportHandler(event: WorkItemImportSqsEvent) {
  return processWorkItemImportBatch(event, createWorkItemImportWorkerDependencies())
}

/**
 * Bun のローカル開発サーバー entrypoint です。
 */
export default {
  port: Number(getEnv('PORT') ?? 3000),
  fetch: app.fetch,
}
