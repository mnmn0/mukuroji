import {
  X509Certificate,
  createHash,
  createHmac,
  randomUUID,
} from 'node:crypto'
import { resolve4, resolve6, resolveTxt } from 'node:dns/promises'
import { request as requestHttps } from 'node:https'
import { isIP } from 'node:net'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import {
  PUBLIC_API_OPENAPI_DOCUMENT,
  ENTERPRISE_PERMISSION_IDS,
  createDefaultUnscheduledWorkItemSchedule,
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type AnalyticsQueryInput,
  type AnalyticsReport,
  type AnalyticsSnapshot,
  type AnalyticsSnapshotListResponse,
  type AnalyticsSnapshotRecord,
  type AcceptCreateTriageAction,
  type CreateManualTriageEntryInput,
  type CreateAnalyticsReportInput,
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
  type ConfirmedWorkItemSchedule,
  type ConfirmWorkItemScheduleChangeResponse,
  type CreateWorkItemInput,
  type CreatePlanningDependencyInput,
  type CreateWorkItemScheduleDependencyInput,
  type CreatePlanningEntityInput,
  type CreateSavedWorkspaceViewInput,
  type CustomFieldDefinition,
  type DocumentRelationTarget,
  type RequestFormDraft,
  type RequestFormField,
  type RequestFormRoutingTarget,
  type RequestSubmission,
  type RequestSubmissionActionInput,
  type TriageBulkActionInput,
  type TriageBulkActionResult,
  type TriageConfiguration,
  type TriageActionInput,
  type TriageEntry,
  type UpdateTriageConfigurationInput,
  type ScheduleDependencyConstraint,
  type CustomFieldValue,
  type CycleRolloverInput,
  type DuplicatePlanningEntityInput,
  type MovePlanningEntityInput,
  type PlanningEntity,
  type PlanningRevisionInput,
  type PlanningSnapshot,
  type PlanningStatusUpdateInput,
  type PlanningWorkItemLinkInput,
  type PlanningWorkItemSummary,
  PROJECT_QUICK_ACCESS_MAX_REVISION,
  type ProjectQuickAccessPreferences,
  type ResolvedWorkItemConfiguration,
  type ImportDryRunReport,
  type ImportJob,
  type ImportReport,
  type ImportRowError,
  type UpdateAutomationRuleInput,
  type UpdateAutomationTemplateInput,
  type UpdateAnalyticsReportInput,
  type UpdateRecurringWorkInput,
  type UpdatePlanningEntityInput,
  type UpdateWorkItemScheduleDependencyInput,
  type UpdateProjectQuickAccessPreferencesInput,
  type UpdateSavedWorkspaceViewInput,
  type WorkItemConfiguration,
  type WorkItemRelation,
  type WorkItemRelationType,
  type WorkItemDependencyEndpoint,
  type WorkItemScheduleDependency,
  type WorkItemScheduleEvaluationRevision,
  type WorkItemScheduleImpact,
  type WorkItemScheduleOperation,
  type WorkspaceSearchFilters,
  type EnterpriseBreakGlassAccount,
  type EnterpriseCustomRole,
  type EnterpriseIdentityProvider,
  type EnterpriseIdentitySnapshot,
  type EnterprisePermissionId,
  type EnterpriseProvisioningPreview,
  type EnterpriseProvisioningRun,
  type EnterpriseRoleId,
  type EnterpriseRoutePermissionRule,
  type EnterpriseScimGroup,
  type EnterpriseScimGroupInput,
  type EnterpriseScimUser,
  type EnterpriseScimUserInput,
  type EnterpriseServiceAccount,
  type EnterpriseVerifiedDomain,
  type TenantFeature,
} from '@mukuroji/contracts'
import { Hono } from 'hono'
import { getConnInfo, type LambdaEvent } from 'hono/aws-lambda'
import type { Context } from 'hono'
import { createDependencyRuntime } from '../infrastructure/runtime/dependency-runtime'
import {
  freezeAppDependencies,
  type AppDependencies,
  type AuthenticationDependencies,
  type AutomationDependencies,
  type DeveloperPlatformDependencies,
  type EnterpriseIdentityProviderConnectionTester,
  type WorkItemDependencies,
  type WorkspaceDependencies,
} from '../app/composition/app-dependencies'

export type {
  AppDependencies,
  AppDependencyOverrides,
  AuthenticationDependencies,
  AutomationDependencies,
  DeveloperPlatformDependencies,
  WorkItemDependencies,
  WorkspaceDependencies,
} from '../app/composition/app-dependencies'
import {
  createAnalyticsRouter,
  type AnalyticsExportFile,
} from '../modules/analytics/adapter-in/http/analytics-router'
import { createDashboardRouter } from '../modules/analytics/adapter-in/http/dashboard-router'
import type { DashboardSummaryResponse } from '../modules/analytics'

export { DynamoDbDashboardSummaryClient } from '../modules/analytics'
import { createAuditRouter } from '../modules/audit/adapter-in/http/audit-router'
import { createTenantAdministrationRouter } from '../modules/tenant-administration/adapter-in/http/tenant-administration-router'
import { TenantAdministrationError } from '../modules/tenant-administration'
import { loadServerConfig } from '../infrastructure/config/server-config'
import {
  clampCognitoPageLimit,
  CognitoServiceError,
  FlociCognitoClient,
  getSystemAdminGroups,
  isCognitoUserNotFoundError,
  readCognitoMfaChallengeName,
  type AuthTokenSet,
  type CognitoUserProfile,
  type CognitoUsersResponse,
  type EnterpriseCognitoSsoAppClientBinding,
  type GetUserResponse,
  type InitiateAuthResponse,
  type ListCognitoUsersInput,
} from '../modules/authentication'

export {
  AwsCognitoClient,
  CognitoServiceError,
  createCognitoClient,
  FlociCognitoClient,
} from '../modules/authentication'
import {
  createProjectQuickAccessIdentity,
  isProjectQuickAccessItems,
  normalizeProjectMemberKey,
  ProjectDataError,
  projectRoleWeights,
  readLocalizedNames,
  type CreateProjectRequestBody,
  type CreateTeamRequestBody,
  type Locale,
  type ProjectAccessEntry,
  type ProjectDirectoryProjectResponse,
  type ProjectDirectoryResponse,
  type ProjectDirectoryTeamResponse,
  type ProjectArchiveWorkItemRevisionGuard,
  type ProjectMemberResponseItem,
  type ProjectMembersResponse,
  type ProjectRole,
  type UpdateProjectMemberRequestBody,
  type UpdateProjectMemberResponse,
} from '../modules/directory'

export {
  DynamoDbProjectDirectoryClient,
  type ProjectRole,
} from '../modules/directory'
import {
  auditEventsToNdjson,
  createAuditEvent,
  createAuditEventId,
  createAuditEventTransactPut,
  createMutationAuditContext,
  createRequestFingerprint,
  calculateAuditExpiresAt,
  getConfiguredAuditTableName,
  getConfiguredAuditRetentionDays,
  getConfiguredDynamoDbEndpoint,
  toAuditEventView,
  type AuditEventEntityType,
  type AuditActorKind,
  type AuditEventPage,
  type AuditEventQuery,
  type AuditEventV1,
  type MutationAuditContext,
} from '../modules/audit/audit'
import {
  createTeamIssueAuditEntityId,
  createTeamIssueDeepLink,
  confirmWorkItemScheduleChange,
  collectWorkItemScheduleEvaluationEndpoints,
  createWorkItemDependencyKey,
  createWorkItemAuthorizationChangedError,
  createWorkItemRelationGraphRevisionConditionCheck,
  createWorkItemRevisionConditionCheck,
  customFieldValueRecordsEqual,
  deriveWorkItemScheduleDueDate,
  isTeamIssueNotFoundError,
  normalizeWorkItemSchedule,
  normalizeWorkItemScheduleOperation,
  previewWorkItemDependencyScheduleChange,
  readAssignedProjectId,
  readRequiredCommentBody,
  readRequiredString,
  readTeamIssueAssigneeUserId,
  readWorkItemExpectedRevision,
  toTeamIssueResponseItem,
  WorkItemScheduleError,
  WORK_ITEM_SCHEDULE_CASCADE_LIMIT,
  type CreateTeamIssueCommentRequestBody,
  type CreateTeamIssueRequestBody,
  type CreateTeamIssueResponse,
  type ConfirmWorkItemScheduleChangeCommand,
  type ProjectIssuesResponse,
  type ProjectTaskResponseItem,
  type ProjectTasksResponse,
  type PublicUpdateTeamIssueRequestBody,
  type TeamIssueCommentResponseItem,
  type TeamIssueDetailReadOptions,
  type TeamIssueDetailResponse,
  type TeamIssueResponseItem,
  type TeamIssuesResponse,
  type TriageDuplicateContextTransactionContribution,
  type UpdateTeamIssueRequestBody,
  type UpdateTeamIssueResponse,
  type WorkItemIdempotencyTransaction,
  type WorkItemListReadOptions,
  type WorkItemAuthorizationSnapshot,
  type WorkItemDependencyScheduleState,
} from '../modules/work-items'

export {
  DynamoDbProjectTasksClient,
  DynamoDbTeamIssuesClient,
} from '../modules/work-items'
import {
  WorkspaceAccessError,
  isWorkspaceIdentitySafeToDelete,
  type WorkspaceInvitation,
  type WorkspaceMember,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from '../modules/workspace-access/workspace-access'
import { createRealtimeTicketRouter } from '../modules/realtime'
import {
  CollaborationError,
  createProjectCollaborationEntityKey,
  createWorkItemCollaborationEntityKey,
  type CollaborationAutomaticWatcherCandidate,
  type CollaborationComment,
} from '../modules/collaboration/collaboration'
import {
  FILE_APPROVAL_MAX_REVIEWERS,
  FileProofingError,
  createFileProofingScopeKey,
  type CancelFileApprovalInput,
  type CreateFileApprovalDecisionInput,
  type CreateFileApprovalInput,
  type CreateFileAnnotationInput,
  type CreateFileUploadInput,
  type FileProofingActor,
  type FileProofingScope,
  type FileApprovalCompletionTransition,
  type FileApprovalCompletionTransitionResolver,
  type ListReviewerApprovalsOptions,
  type ReviewerApprovalPage,
} from '../modules/files/file-proofing'
import { NotificationError, type NotificationItem } from '../modules/notifications/notifications'
import {
  createNotificationRouter,
} from '../modules/notifications/adapter-in/http/notification-router'
import {
  createCommentWorkspaceSearchDocument,
  createDocumentWorkspaceSearchDocument,
  WorkspaceSearchError,
  createProjectWorkspaceSearchDocument,
  createTeamWorkspaceSearchDocument,
  createWorkItemWorkspaceSearchDocument,
  type SavedViewAccessScope,
  type WorkspaceSearchAccessScope,
  type WorkspaceSearchDocument,
} from '../modules/workspace-search/workspace-search'
import {
  createFormTriageEntryId,
  RequestIntakeError,
  createRequestWorkItemInput,
  type RequestExternalContext,
  type RequestLinkResolution,
} from '../modules/request-intake/request-intake'
import {
  createAdminRequestIntakeRouter,
} from '../modules/request-intake/adapter-in/http/admin-request-intake-router'
import {
  createPublicRequestIntakeRouter,
} from '../modules/request-intake/adapter-in/http/public-request-intake-router'
import {
  createTriageAcceptanceTransactionItems,
  createTriageActionAuditIdempotencyKey,
  createTriageActionTransactionItems,
  createTriageBulkTargetIdempotencyKey,
  createTriageInputFingerprint,
  createTriageRouter,
  TriageError,
  type TriageIdempotency,
  type TriageRouterBulkActionRequest,
  type TriageTransactionContribution,
  type TriageRouterActionRequest,
  type TriageTeamAccess,
} from '../modules/triage'
import {
  ENTERPRISE_SCIM_DISPLAY_NAME_MAX_BYTES,
  ENTERPRISE_SCIM_EXTERNAL_ID_MAX_BYTES,
  ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT,
  ENTERPRISE_SCIM_GROUP_PAGE_LIMIT,
  ENTERPRISE_SCIM_IDEMPOTENCY_KEY_MAX_BYTES,
  ENTERPRISE_SCIM_MEMBER_ID_MAX_BYTES,
  ENTERPRISE_SCIM_RESOURCE_ID_MAX_BYTES,
  ENTERPRISE_SCIM_USER_EMAIL_LIMIT,
  ENTERPRISE_SCIM_USER_IDENTIFIER_MAX_BYTES,
  EnterpriseIdentityError,
  assertEnterpriseCognitoFederationBinding,
  assertEnterpriseCognitoProviderBinding,
  assertEnterpriseIdentityProviderReady,
  canAssignEnterpriseRole,
  evaluateEnterpriseAccess,
  ipMatchesCidr,
  resolveEnterpriseDirectoryPrincipal,
  resolveEnterpriseRolePermissions,
  resolveRoutePermissions,
  validateEnterpriseSession,
  type EnterpriseAuthorizationResource,
  type EnterpriseCognitoFederationBinding,
  type EnterprisePrincipalContext,
} from '../modules/enterprise-identity'
import {
  createEnterpriseCognitoInspectionCache,
} from '../modules/enterprise-identity/enterprise-cognito-inspection-cache'
import {
  createDefaultEnterpriseSecurityPolicy,
  toEnterpriseSecuritySnapshotView,
} from '../modules/enterprise-identity/enterprise-security-view'
import {
  EnterpriseSsoError,
  buildCognitoAuthorizeUrl,
  createEnterpriseSsoAuthenticationMethod,
  createEnterpriseSsoState,
  isEnterpriseSsoAuthenticationMethod,
  parseEnterpriseSsoTokenResponse,
  validateEnterpriseSsoState,
} from '../modules/enterprise-identity/enterprise-sso'
import {
  EnterpriseSessionActivityError,
} from '../modules/enterprise-identity/enterprise-session-activity'
import {
  WorkItemConfigurationError,
  assertWorkflowTransitionAllowed,
  createWorkItemConfigurationGuardConditionChecks,
  createWorkItemRelationIds,
  normalizeCustomFieldValues,
  resolveWorkflowStatus,
  validateWorkItemConfiguration,
} from '../modules/work-items/work-item-configuration'
import {
  createWorkItemConfigurationRouter,
} from '../modules/work-items/adapter-in/http/work-item-configuration-router'
import {
  AUTOMATION_TEMPLATE_APPLICATION_LEASE_MS,
  AutomationEngine,
  AutomationError,
  applyBulkOperation,
  deliverAutomationWebhook,
  isAutomationInboundWebhookJsonContentType,
  isAutomationValue,
  normalizeAutomationActionFailure,
  parseAutomationInboundWebhookJson,
  previewBulkOperation,
  readAutomationInboundWebhookBody,
  readAutomationInboundWebhookTimestamp,
  retryBulkOperation,
  toAutomationInboundWebhookEndpoint,
  undoBulkOperation,
  validateApplyAutomationTemplateInput,
  validateAutomationInboundWebhookLifecycleInput,
  validateCreateAutomationInboundWebhookEndpointInput,
  validateCreateAutomationRuleInput,
  validateCreateAutomationTemplateInput,
  validateCreateRecurringWorkInput,
  validateUpdateAutomationInboundWebhookEndpointInput,
  verifyAutomationInboundWebhookSignature,
  type AutomationActionExecutionContext,
  type AutomationActionExecutor,
  type AutomationErrorCategory,
  type AutomationEvent,
  type AutomationInboundWebhookEndpointRecord,
  type AutomationInboundWebhookProvisioning,
  type AutomationInboundWebhookSecretReference,
  type AutomationRuleTemplatePort,
  type BulkOperationAdapter,
} from '../modules/automation'
import {
  createPlanningWorkItemDependencySummary,
  PlanningError,
  requirePlanningWorkItemHasNoScheduleDependencies,
  type PlanningCallerAuthorizationConditionCheck,
  type PlanningMutationTransaction,
  type PlanningWorkItemState,
} from '../modules/planning'
import type {
  AuthenticatedDeveloperCredential,
  IdempotencyMutationToken,
  ReleaseIdempotencyRequest,
  ReserveIdempotencyRequest,
} from '../modules/developer-platform/application/ports'
import { DeveloperPlatformError } from '../modules/developer-platform'
import { createDefaultSecretProtector } from '../modules/developer-platform/adapter-out/shared/developer-platform-store'
import {
  ConnectorAuthorizationRuntime,
  createConnectorConflictRuntime,
  type ConnectorOAuthCallbackAuthorizer,
} from '../modules/developer-platform/connector-authorization-runtime'
import {
  ConnectorRuntimeError,
  createOAuthConnectorRegistryFromEnvironment,
} from '../modules/developer-platform/connector-oauth'
import {
  createConnectorRuntimeCache,
  loadConnectorRuntimeEnvironment,
} from '../modules/developer-platform/connector-runtime-configuration'
import { createSecretsManagerConnectorRuntimeSecretLoader } from '../modules/developer-platform/adapter-out/secrets-manager/connector-runtime-secret-loader'
import {
  createDynamoDbConnectorOAuthStateStoreFromEnvironment,
} from '../modules/developer-platform/adapter-out/dynamodb/connector-oauth-state-store'
import { ConnectorOAuthStateManager } from '../modules/developer-platform/connector-oauth-state'
import {
  createDynamoDbConnectorSyncPersistenceFromEnvironment,
} from '../modules/developer-platform/adapter-out/dynamodb/connector-sync-persistence'
import {
  ConnectorSyncEngine,
  type ConnectorSyncHealthReporter,
  type ConnectorWorkItemGateway,
  type ConnectorWorkItemSnapshot,
} from '../modules/developer-platform/connector-sync-runtime'
import {
  createPublicApiRouter,
  PublicApiServiceError,
  type ConnectorAuthorizationService,
  type DeveloperManagementPrincipal,
  type PublicApiDependencies,
  type PublicImportSourceInput,
  type PublicMutationContext,
  type PublicWorkItemService,
} from '../modules/developer-platform/public-api'
import {
  previewWorkItemImport,
  WorkItemTransferError,
} from '../modules/work-items/work-item-transfer'
import {
  evaluateWebhookEnterpriseTeamAccess,
} from '../modules/developer-platform/webhook-authorization'
import {
  WorkItemImportError,
  createStoredWorkItemImportReport,
  createWorkItemImportJobId,
  requestWorkItemImportCancellation,
  stageWorkItemImport,
  type WorkItemImportExecution,
  type WorkItemImportWorkerDependencies,
} from '../modules/work-items/work-item-import'
import {
  createDocumentSearchAccessReadContext,
  DocumentError,
  type DocumentAccessContext,
  type DocumentAuthorizationFenceSnapshot,
  type DocumentProjectRole,
} from '../modules/documents'
import {
  requirePrivateDocumentManagerContinuity,
} from '../modules/workspace-access/document-manager-lifecycle'
import {
  registerDocumentApiRoutes,
  type DocumentApiPrincipal,
} from '../modules/documents/adapter-in/http/document-api'
import {
  AnalyticsError,
  createAnalyticsCsv,
  createAnalyticsPermissionScopeHash,
  createAnalyticsPdf,
  createAnalyticsSnapshot,
  createAnalyticsSnapshotListCursor,
  normalizeAnalyticsEvidenceInput,
  normalizeAnalyticsExportLocale,
  normalizeAnalyticsQueryInput,
  queryAnalyticsEvidence,
} from '../modules/analytics/analytics'
import { createTimeTrackingRouter } from '../modules/time-tracking/adapter-in/http/time-tracking-router'
import { TimeTrackingError } from '../modules/time-tracking'
import { createCapacityPlanningRouter } from '../modules/capacity-planning/adapter-in/http/capacity-planning-router'
import { CapacityPlanningError } from '../modules/capacity-planning'

/**
 * Workspace access の永続化 client と API error です。
 */
export {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
} from '../modules/workspace-access/workspace-access'
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
} from '../modules/workspace-access/workspace-access'



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
 * Cognito MFA challenge を完了する入力です。
 */
type CompleteMfaChallengeRequestBody = {
  /** Challenge 対象の正規化済みメールアドレスです。 */
  email?: unknown
  /** Cognito が発行した challenge session です。 */
  session?: unknown
  /** Login/challenge response が返した challenge 名です。 */
  challenge?: unknown
  /** Authenticator、SMS、または email に届いた one-time code です。 */
  code?: unknown
}

















/**
 * Cognito access token の payload から読む claims です。
 */
type CognitoAccessTokenClaims = {
  /**
   * Cognito user の immutable subject です。
   */
  sub?: unknown
  /**
   * Cognito access token の username です。
   */
  username?: unknown
  /**
   * Workspace partition を示す custom claim です。
   */
  'custom:directory_id'?: unknown
  /**
   * Cognito が認証を完了した epoch seconds です。
   */
  auth_time?: unknown
  /**
   * Access token を発行した epoch seconds です。
   */
  iat?: unknown
  /**
   * Access token が失効する epoch seconds です。
   */
  exp?: unknown
  /**
   * Authentication method reference 一覧です。
   */
  amr?: unknown
  /**
   * Cognito が返す authentication method reference 一覧です。
   */
  'cognito:amr'?: unknown
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
 * Enterprise route 評価で特定 Team に付与された permission です。
 */
type EnterpriseTeamAccess = {
  /** Permission の対象 Team ID です。 */
  teamId: string
  /** 対象 Team scope で有効な permission です。 */
  permissions: EnterprisePermissionId[]
}

/**
 * Current request と独立した resource permission を再評価する Enterprise snapshot です。
 */
type EnterpriseAuthorizationEvaluationSnapshot = {
  /** Directory、external ceiling、principal kind を解決済みの principal です。 */
  principal: EnterprisePrincipalContext
  /** 認証時に読み込んだ authoritative Enterprise state です。 */
  snapshot: EnterpriseIdentitySnapshot
  /** Provider binding と current membership に適合した role assignment です。 */
  assignments: EnterpriseIdentitySnapshot['roleAssignments']
  /** Provider binding と current membership に適合した group mapping です。 */
  groupMappings: EnterpriseIdentitySnapshot['groupMappings']
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
  /**
   * Interactive user、service account、break-glass の区別です。
   */
  principalKind?: EnterprisePrincipalContext['kind']
  /**
   * Break-glass elevation 中の audit correlation に使う activation ID です。
   */
  enterpriseBreakGlassActivationId?: string
  /**
   * Access token を plaintext 保存せず session-bound elevation に使う SHA-256 digest です。
   */
  enterpriseAuthenticationSessionId?: string
  /**
   * Current route/resource 上で有効な enterprise permission です。
   */
  enterprisePermissions?: EnterprisePermissionId[]
  /**
   * 認証・認可時に読んだ Enterprise CONTROL revision です。
   */
  enterpriseIdentityControlRevision?: number
  /**
   * Current request の enterprise authorization で評価した resource です。
   */
  enterpriseAuthorizationResource?: EnterpriseAuthorizationResource
  /**
   * Current request の route を許可した enterprise permission です。
   */
  enterpriseGrantedRoutePermission?: EnterprisePermissionId
  /**
   * Current request の route 候補として実際に許可された enterprise permission 一覧です。
   */
  enterpriseGrantedRoutePermissions?: EnterprisePermissionId[]
  /**
   * Current request を URL/resource そのものの scope で許可したかどうかです。
   */
  enterpriseRouteAuthorizedAtResource?: boolean
  /**
   * Current request の permission でアクセスできる Project と相当 role です。
   */
  enterpriseProjectAccesses?: ProjectAccessEntry[]
  /**
   * Current request の permission で独立してアクセスできる Team ID 一覧です。
   */
  enterpriseAuthorizedTeamIds?: string[]
  /**
   * Current request で Team ごとに有効な enterprise permission です。
   */
  enterpriseTeamAccesses?: EnterpriseTeamAccess[]
  /**
   * Enterprise directory/assignment が legacy Project ACL より権威を持つかどうかです。
   */
  enterpriseLegacyProjectAccessSuppressed?: boolean
  /**
   * Search/notification など current route と異なる resource permission を安全に再評価する snapshot です。
   */
  enterpriseAuthorizationEvaluation?: EnterpriseAuthorizationEvaluationSnapshot
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
 * Enterprise security route の current permission set を検証済みの principal です。
 */
type EnterpriseSecurityPrincipal = WorkspacePrincipal & {
  /**
   * Current Enterprise security route で有効な permission です。
   */
  enterprisePermissions: EnterprisePermissionId[]
}

/**
 * Workspace principal authentication の例外的な route 境界です。
 */
type WorkspaceAuthenticationOptions = {
  /**
   * 事前登録済み recovery identity の MFA/recent-auth 検証前アクセスかどうかです。
   */
  breakGlassCandidate?: boolean
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
 * Workspace 横断 Work Item API が返す response body です。
 */
type WorkItemsResponse = {
  /**
   * 現在ユーザーが参照できる canonical Work Item 一覧です。
   */
  workItems: TeamIssueResponseItem[]
}




/** Workspace 横断 export の Team/page continuation です。 */
type WorkItemExportContinuation = {
  /** Continuation schema version です。 */
  version: 1
  /** 次に読む Team ID です。 */
  teamId: string
  /** Accessible Team 順序を current RBAC directory snapshot に束縛する digest です。 */
  teamSetDigest: string
  /** Team 内の次 Work Item page cursor です。 */
  workItemCursor?: string
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
/** Analytics が一つの entity query で読む audit event page size です。 */
const ANALYTICS_AUDIT_PAGE_SIZE = 100
/** Analytics が一つの Work Item identity で読む最大 audit page 数です。 */
const ANALYTICS_AUDIT_MAX_PAGES = 100
/** Analytics が認可済み Work Item 全体で評価する最大 audit event 数です。 */
const ANALYTICS_AUDIT_EVENT_LIMIT =
  ANALYTICS_AUDIT_PAGE_SIZE * ANALYTICS_AUDIT_MAX_PAGES
/** Entity-scoped audit query を並列実行する最大 worker 数です。 */
const ANALYTICS_AUDIT_QUERY_CONCURRENCY = 8
/** API timeout 内に収めるため、一度にqueryするWork Item identityの最大数です。 */
const ANALYTICS_AUDIT_IDENTITY_QUERY_LIMIT = 500
/** 全 identity の pagination を通じて実行する audit page query の最大数です。 */
const ANALYTICS_AUDIT_PAGE_QUERY_LIMIT = 500
/** Analytics が filter/ACL 適用後に一度に評価する Work Item の最大数です。 */
const ANALYTICS_WORK_ITEM_LIMIT = 10_000
/** Analytics が一度に読む Team または Project partition の最大数です。 */
const ANALYTICS_WORK_ITEM_PARTITION_COUNT_LIMIT = 100
/** Analytics が一つの Team または Project partition で評価する最大 item 数です。 */
const ANALYTICS_WORK_ITEM_PARTITION_SCAN_LIMIT = 10_000
/** Canonical Work Item と audit history を揃える最大 read barrier 試行回数です。 */
const ANALYTICS_READ_BARRIER_MAX_ATTEMPTS = 3
/** Analytics snapshot 一覧で一度に返す current ACL 検証済み record の最大数です。 */
const ANALYTICS_SNAPSHOT_LIST_LIMIT = 100
/** Analytics snapshot 一覧の一 response で current ACL を検査する最大保存 record 数です。 */
const ANALYTICS_SNAPSHOT_ACL_INSPECTION_LIMIT = 1_000
/** Analytics snapshot 一覧の一 response で直列実行するrepository readの最大数です。 */
const ANALYTICS_SNAPSHOT_REPOSITORY_PAGE_LIMIT = 10
/** Relation target の強整合 detail read を同時実行する最大数です。 */
const WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY = 8











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






































/** Cognito binding inspection を live read するか短期 cache から読むかを指定します。 */
type EnterpriseCognitoInspectionMode = 'cached' | 'fresh'








const routeApp = new Hono()
const appDependencyRuntime = createDependencyRuntime<AppDependencies>(
  freezeAppDependencies,
)
const requireAppDependencies = appDependencyRuntime.requireDependencies
const authenticationDependencies: AuthenticationDependencies = {
  get cognito() {
    return requireAppDependencies().authentication.cognito
  },
}
const workspaceDependencies: WorkspaceDependencies = {
  get dashboardSummary() {
    return requireAppDependencies().workspace.dashboardSummary
  },
  get projectDirectory() {
    return requireAppDependencies().workspace.projectDirectory
  },
  get auditEvents() {
    return requireAppDependencies().workspace.auditEvents
  },
  get workspaceAccess() {
    return requireAppDependencies().workspace.workspaceAccess
  },
  get enterpriseIdentity() {
    return requireAppDependencies().workspace.enterpriseIdentity
  },
  get enterpriseSessionActivity() {
    return requireAppDependencies().workspace.enterpriseSessionActivity
  },
  get enterpriseIdentityProviderConnectionTester() {
    return requireAppDependencies().workspace.enterpriseIdentityProviderConnectionTester
  },
  get tenantAdministration() {
    return requireAppDependencies().workspace.tenantAdministration
  },
  get tenantExportDownload() {
    return requireAppDependencies().workspace.tenantExportDownload
  },
  get tenantEntitlementEnforcement() {
    return requireAppDependencies().workspace.tenantEntitlementEnforcement
  },
}
const workItemDependencies: WorkItemDependencies = {
  get projectTasks() {
    return requireAppDependencies().workItems.projectTasks
  },
  get teamIssues() {
    return requireAppDependencies().workItems.teamIssues
  },
  get realtimeTickets() {
    return requireAppDependencies().workItems.realtimeTickets
  },
  get collaboration() {
    return requireAppDependencies().workItems.collaboration
  },
  get fileProofing() {
    return requireAppDependencies().workItems.fileProofing
  },
  get notifications() {
    return requireAppDependencies().workItems.notifications
  },
  get workspaceSearch() {
    return requireAppDependencies().workItems.workspaceSearch
  },
  get documents() {
    return requireAppDependencies().workItems.documents
  },
  get workspaceSearchProjectionEnabled() {
    return requireAppDependencies().workItems.workspaceSearchProjectionEnabled
  },
  get workItemConfigurations() {
    return requireAppDependencies().workItems.workItemConfigurations
  },
  get planning() {
    return requireAppDependencies().workItems.planning
  },
  get requestIntake() {
    return requireAppDependencies().workItems.requestIntake
  },
  get triage() {
    return requireAppDependencies().workItems.triage
  },
  get analytics() {
    return requireAppDependencies().workItems.analytics
  },
}
const automationDependencies: AutomationDependencies = {
  get ruleTemplates() {
    return requireAppDependencies().automation.ruleTemplates
  },
  get inboundWebhooks() {
    return requireAppDependencies().automation.inboundWebhooks
  },
  get recurringSchedules() {
    return requireAppDependencies().automation.recurringSchedules
  },
  get executions() {
    return requireAppDependencies().automation.executions
  },
  get bulkOperations() {
    return requireAppDependencies().automation.bulkOperations
  },
  get automationInboundWebhookSecrets() {
    return requireAppDependencies().automation.automationInboundWebhookSecrets
  },
}
const timeTrackingDependencies = {
  get timeTrackingService() {
    return requireAppDependencies().timeTracking.timeTrackingService
  },
}
const capacityPlanningDependencies = {
  get capacityPlanningService() {
    return requireAppDependencies().capacityPlanning.capacityPlanningService
  },
}
const developerPlatformDependencies: DeveloperPlatformDependencies = {
  get apiKeys() {
    return requireAppDependencies().developerPlatform.apiKeys
  },
  get oauthCredentials() {
    return requireAppDependencies().developerPlatform.oauthCredentials
  },
  get webhookSubscriptions() {
    return requireAppDependencies().developerPlatform.webhookSubscriptions
  },
  get webhookDeliveries() {
    return requireAppDependencies().developerPlatform.webhookDeliveries
  },
  get connectors() {
    return requireAppDependencies().developerPlatform.connectors
  },
  get externalLinks() {
    return requireAppDependencies().developerPlatform.externalLinks
  },
  get imports() {
    return requireAppDependencies().developerPlatform.imports
  },
  get idempotency() {
    return requireAppDependencies().developerPlatform.idempotency
  },
  get rateLimits() {
    return requireAppDependencies().developerPlatform.rateLimits
  },
  get transactions() {
    return requireAppDependencies().developerPlatform.transactions
  },
  get publicWorkItems() {
    return requireAppDependencies().developerPlatform.publicWorkItems
  },
  get workItemImportExecutions() {
    return requireAppDependencies().developerPlatform.workItemImportExecutions
  },
  get workItemImportSources() {
    return requireAppDependencies().developerPlatform.workItemImportSources
  },
  get workItemImportQueue() {
    return requireAppDependencies().developerPlatform.workItemImportQueue
  },
  get queueWebhookDelivery() {
    return requireAppDependencies().developerPlatform.queueWebhookDelivery
  },
}

const queueWebhookDelivery = (...args: Parameters<
  NonNullable<PublicApiDependencies['queueWebhookDelivery']>
>) => requireAppDependencies().developerPlatform.queueWebhookDelivery(...args)
const enterpriseIdentityProviderConnectionTester: EnterpriseIdentityProviderConnectionTester = (
  provider,
) => requireAppDependencies().workspace.enterpriseIdentityProviderConnectionTester(provider)

/**
 * Mounts the complete domain HTTP route inventory on a composition-root app.
 *
 * @param app - Hono application that owns the routes.
 */
export function registerApiRoutes(app: Hono): void {
  app.route('/', routeApp)
}

/**
 * Binds a Hono application to immutable domain dependency bundles.
 *
 * @param app - Hono application to bind.
 * @param dependencies - Domain dependency graph owned by the application.
 * @returns A request-bound application facade.
 */
export function bindApiDependencies(
  app: Hono,
  dependencies: AppDependencies,
): Hono {
  return appDependencyRuntime.bindApp(app, dependencies)
}

function isWorkspaceSearchProjectionEnabled() {
  return requireAppDependencies().workItems.workspaceSearchProjectionEnabled
}
const enterpriseCognitoFederationBindingCaches = new WeakMap<
  Readonly<AppDependencies>,
  ReturnType<
    typeof createEnterpriseCognitoInspectionCache<
      EnterpriseCognitoFederationBinding
    >
  >
>()
const enterpriseCognitoSsoAppClientBindingCaches = new WeakMap<
  Readonly<AppDependencies>,
  ReturnType<
    typeof createEnterpriseCognitoInspectionCache<
      EnterpriseCognitoSsoAppClientBinding
    >
  >
>()
const documentProjectRolesCaches = new WeakMap<
  Readonly<AppDependencies>,
  Map<string, {
    /** Cache entry の失効時刻です。 */
    expiresAt: number
    /** Role snapshot と同時に確認した Workspace member version です。 */
    workspaceMemberVersion: number
    /** Active Project hierarchy を直列化する Planning revision です。 */
    planningRevision: number
    /** Project role read の共有中または解決済み promise です。 */
    value: Promise<Record<string, DocumentProjectRole>>
  }>
>()
const documentProjectRolesCacheTtlMs = 1_000
/** Cross-table authorization snapshot を安定化する再読込回数です。 */
const DOCUMENT_AUTHORIZATION_SNAPSHOT_RETRY_LIMIT = 3
/** Work Item authorization snapshot を安定化する再読込回数です。 */
const WORK_ITEM_AUTHORIZATION_SNAPSHOT_RETRY_LIMIT = 3
/** Schedule dependency graph and authorization snapshot stabilization attempts. */
const WORK_ITEM_SCHEDULE_SNAPSHOT_RETRY_LIMIT = 3
/** Relation target の source read を同時実行する最大数です。 */
const DOCUMENT_RELATION_TARGET_VALIDATION_CONCURRENCY = 8
const projectDirectoryIdPrefix = 'user#'

function getEnterpriseCognitoFederationBindingCache() {
  const dependencies = requireAppDependencies()
  let cache = enterpriseCognitoFederationBindingCaches.get(dependencies)
  if (!cache) {
    cache =
      createEnterpriseCognitoInspectionCache<EnterpriseCognitoFederationBinding>()
    enterpriseCognitoFederationBindingCaches.set(dependencies, cache)
  }
  return cache
}

function getEnterpriseCognitoSsoAppClientBindingCache() {
  const dependencies = requireAppDependencies()
  let cache = enterpriseCognitoSsoAppClientBindingCaches.get(dependencies)
  if (!cache) {
    cache =
      createEnterpriseCognitoInspectionCache<EnterpriseCognitoSsoAppClientBinding>()
    enterpriseCognitoSsoAppClientBindingCaches.set(dependencies, cache)
  }
  return cache
}
const enterpriseRoutePermissionRules = [
  {
    method: 'POST',
    pathPattern: '/api/enterprise/security/break-glass/activate',
    permission: 'workspace.read',
  },
  {
    method: 'POST',
    pathPattern: '/api/enterprise/security/break-glass/test',
    permission: 'workspace.read',
  },
  {
    method: 'POST',
    pathPattern: '/api/enterprise/security/break-glass/revoke-activation',
    permission: 'workspace.read',
  },
  {
    method: 'POST',
    pathPattern: '/api/enterprise/security/break-glass/deactivate',
    permission: 'security.manage',
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/break-glass/accounts*',
    permission: 'security.manage',
  },
  {
    method: 'GET',
    pathPattern: '/api/enterprise/security',
    permission: 'security.read',
    alternativePermissions: [
      'identity.read',
      'identity.manage',
      'security.manage',
      'members.read',
      'members.manage',
      'service-accounts.manage',
    ],
  },
  {
    method: 'PUT',
    pathPattern: '/api/enterprise/security/identity-provider',
    permission: 'identity.manage',
    alternativePermissions: ['security.manage'],
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/domains*',
    permission: 'identity.manage',
    alternativePermissions: ['security.manage'],
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/scim*',
    permission: 'identity.manage',
  },
  {
    method: 'GET',
    pathPattern: '/api/enterprise/security/provisioning/logs',
    permission: 'identity.read',
    alternativePermissions: ['security.read'],
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/provisioning*',
    permission: 'identity.manage',
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/policy*',
    permission: 'security.manage',
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/roles*',
    permission: 'security.manage',
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/group-mappings*',
    permission: 'security.manage',
    alternativePermissions: ['members.manage'],
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/service-accounts*',
    permission: 'service-accounts.manage',
    alternativePermissions: ['security.manage'],
  },
  {
    method: 'GET',
    pathPattern: '/api/enterprise/security*',
    permission: 'security.read',
    alternativePermissions: ['identity.read'],
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security*',
    permission: 'security.manage',
  },
  { method: 'GET', pathPattern: '/api/audit/events/export', permission: 'audit.export' },
  { method: 'GET', pathPattern: '/api/audit/*', permission: 'audit.read' },
  { method: 'POST', pathPattern: '/api/analytics/query', permission: 'work-items.read' },
  { method: 'POST', pathPattern: '/api/analytics/evidence', permission: 'work-items.read' },
  { method: 'POST', pathPattern: '/api/analytics/export', permission: 'work-items.read' },
  { method: 'GET', pathPattern: '/api/analytics/reports', permission: 'work-items.read' },
  {
    method: 'GET',
    pathPattern: '/api/analytics/reports/:reportId/snapshots',
    permission: 'work-items.read',
  },
  {
    method: 'POST',
    pathPattern: '/api/analytics/reports',
    permission: 'work-items.write',
    alternativePermissions: ['teams.manage', 'workspace.manage'],
  },
  {
    method: 'PATCH',
    pathPattern: '/api/analytics/reports/:reportId',
    permission: 'work-items.write',
    alternativePermissions: ['teams.manage', 'workspace.manage'],
  },
  {
    method: 'DELETE',
    pathPattern: '/api/analytics/reports/:reportId',
    permission: 'work-items.write',
    alternativePermissions: ['teams.manage', 'workspace.manage'],
  },
  {
    method: 'POST',
    pathPattern: '/api/analytics/reports/:reportId/snapshots',
    permission: 'work-items.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/documents*',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: '*',
    pathPattern: '/api/document-backlinks*',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: 'POST',
    pathPattern: '/api/documents/:documentId/comments*',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: '*',
    pathPattern: '/api/documents/:documentId/presence*',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: '*',
    pathPattern: '/api/documents/:documentId/favorite',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: 'POST',
    pathPattern: '/api/documents/:documentId/recent',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: '*',
    pathPattern: '/api/documents/:documentId/shares',
    permission: 'documents.manage',
  },
  {
    method: '*',
    pathPattern: '/api/documents*',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write'],
  },
  { method: 'GET', pathPattern: '/api/workspace/*', permission: 'members.read' },
  { method: '*', pathPattern: '/api/workspace/*', permission: 'members.manage' },
  { method: '*', pathPattern: '/api/tenant/*', permission: 'workspace.manage' },
  { method: 'GET', pathPattern: '/api/automation/*', permission: 'automation.read' },
  { method: '*', pathPattern: '/api/automation/*', permission: 'automation.manage' },
  { method: 'GET', pathPattern: '/api/recurring-work*', permission: 'automation.read' },
  { method: '*', pathPattern: '/api/recurring-work*', permission: 'automation.manage' },
  { method: '*', pathPattern: '/api/bulk-operations*', permission: 'work-items.write' },
  { method: 'GET', pathPattern: '/api/planning*', permission: 'planning.read' },
  {
    method: 'POST',
    pathPattern: '/api/planning/entities/:entityId/archive',
    permission: 'planning.manage',
  },
  {
    method: 'POST',
    pathPattern: '/api/planning/entities/:entityId/move',
    permission: 'planning.manage',
  },
  { method: '*', pathPattern: '/api/planning/dependencies*', permission: 'planning.manage' },
  {
    method: '*',
    pathPattern: '/api/planning/work-item-dependencies*',
    permission: 'planning.manage',
  },
  { method: '*', pathPattern: '/api/planning/cycles*', permission: 'planning.manage' },
  { method: '*', pathPattern: '/api/planning*', permission: 'planning.write' },
  { method: 'GET', pathPattern: '/api/request-forms*', permission: 'requests.read' },
  { method: '*', pathPattern: '/api/request-forms*', permission: 'requests.manage' },
  { method: 'GET', pathPattern: '/api/request-queue*', permission: 'requests.read' },
  { method: 'GET', pathPattern: '/api/request-submissions*', permission: 'requests.read' },
  { method: '*', pathPattern: '/api/request-submissions*', permission: 'requests.manage' },
  {
    method: 'PUT',
    pathPattern: '/api/teams/:teamId/triage-settings',
    permission: 'teams.manage',
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/triage*',
    permission: 'teams.read',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/triage*',
    permission: 'teams.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/work-items/:workItemId/triage-sources',
    permission: 'teams.read',
  },
  { method: 'GET', pathPattern: '/api/approvals*', permission: 'files.read' },
  { method: '*', pathPattern: '/api/approvals*', permission: 'files.approve' },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/issues/:issueId/files*',
    permission: 'files.read',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/issues/:issueId/files*',
    permission: 'files.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/projects/:projectId/files*',
    permission: 'files.read',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/projects/:projectId/files*',
    permission: 'files.write',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/issues/:issueId/comments/:commentId/files*',
    permission: 'files.write',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/issues/:issueId/approvals*',
    permission: 'files.approve',
  },
  {
    method: 'POST',
    pathPattern: '/api/realtime/tickets',
    permission: 'work-items.read',
  },
  { method: 'GET', pathPattern: '/api/work-items*', permission: 'work-items.read' },
  { method: '*', pathPattern: '/api/work-items*', permission: 'work-items.write' },
  {
    method: 'GET',
    pathPattern: '/api/work-item-configuration*',
    permission: 'work-items.read',
  },
  {
    method: '*',
    pathPattern: '/api/work-item-configuration*',
    permission: 'work-items.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/work-item-configuration*',
    permission: 'work-items.read',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/work-item-configuration*',
    permission: 'work-items.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/issues*',
    permission: 'work-items.read',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/issues*',
    permission: 'work-items.write',
  },
  { method: 'GET', pathPattern: '/api/projects/:projectId/tasks*', permission: 'work-items.read' },
  { method: '*', pathPattern: '/api/projects/:projectId/tasks*', permission: 'work-items.write' },
  { method: 'GET', pathPattern: '/api/projects/:projectId/issues*', permission: 'work-items.read' },
  { method: '*', pathPattern: '/api/projects/:projectId/issues*', permission: 'work-items.write' },
  {
    method: 'GET',
    pathPattern: '/api/projects/:projectId/users*',
    permission: 'projects.manage',
  },
  {
    method: 'GET',
    pathPattern: '/api/projects/:projectId/members*',
    permission: 'projects.write',
  },
  {
    method: '*',
    pathPattern: '/api/projects/:projectId/members*',
    permission: 'projects.manage',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/projects/:projectId/archive',
    permission: 'projects.manage',
  },
  {
    method: 'POST',
    pathPattern: '/api/teams/:teamId/projects',
    permission: 'projects.write',
  },
  {
    method: 'PATCH',
    pathPattern: '/api/teams/:teamId/archive',
    permission: 'teams.manage',
  },
  {
    method: 'POST',
    pathPattern: '/api/teams',
    permission: 'teams.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/projects',
    permission: 'teams.read',
    alternativePermissions: ['projects.read'],
  },
  {
    method: '*',
    pathPattern: '/api/projects/quick-access',
    permission: 'projects.read',
  },
  { method: 'GET', pathPattern: '/api/teams*', permission: 'teams.read' },
  { method: '*', pathPattern: '/api/teams*', permission: 'teams.write' },
  { method: 'GET', pathPattern: '/api/projects*', permission: 'projects.read' },
  { method: '*', pathPattern: '/api/projects*', permission: 'projects.write' },
  { method: '*', pathPattern: '/api/developer*', permission: 'workspace.manage' },
  { method: 'GET', pathPattern: '/api/*', permission: 'workspace.read' },
  { method: '*', pathPattern: '/api/*', permission: 'workspace.write' },
] as const satisfies readonly EnterpriseRoutePermissionRule[]

/** Email domain に適用される enterprise SSO login policy を返します。 */
routeApp.get('/api/auth/sso/discovery', async (c) => {
  const email = c.req.query('email')?.trim() ?? ''
  if (!email) {
    return c.json({ code: 'EnterpriseEmailRequired', message: 'Email is required.' }, 400)
  }
  try {
    const discovery = await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
    if (!discovery) {
      return c.json({ ssoRequired: false, loginMode: 'password-or-sso' as const })
    }
    await enforceTenantFeatureForWorkspace(
      discovery.provider.workspaceId,
      'sso',
      'GET',
    )
    assertEnterpriseIdentityProviderReady(discovery.provider)
    assertEnterpriseCognitoProviderBinding(
      discovery.provider,
      requireEnterpriseCognitoProviderName(),
    )
    await assertEnterpriseCognitoFederationProvider(discovery.provider, 'cached')
    return c.json({
      ssoRequired: true,
      loginMode: 'sso-for-claimed-domains' as const,
      domain: discovery.domain.domain,
      provider: {
        id: discovery.provider.providerId,
        kind: discovery.provider.kind,
        displayName: discovery.provider.displayName,
      },
      ssoStartPath: '/api/auth/sso/start',
    })
  } catch (error) {
    return toEnterpriseSsoErrorResponse(c, error)
  }
})

/** Cognito federation の authorization-code + PKCE login を開始します。 */
routeApp.post('/api/auth/sso/start', async (c) => {
  try {
    const body = await readJson<Record<string, unknown>>(c.req)
    const email = readWorkspaceEmail(body?.email)
    const discovery = await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
    if (!discovery) {
      throw new EnterpriseSsoError(
        404,
        'EnterpriseSsoNotRequired',
        'Enterprise SSO is not configured for this email domain.',
      )
    }
    await enforceTenantFeatureForWorkspace(
      discovery.provider.workspaceId,
      'sso',
      'GET',
    )
    const configuration = requireEnterpriseSsoFederationConfiguration()
    assertEnterpriseIdentityProviderReady(discovery.provider)
    assertEnterpriseCognitoProviderBinding(
      discovery.provider,
      configuration.identityProviderName,
    )
    await assertEnterpriseCognitoFederationProvider(discovery.provider)
    await assertEnterpriseCognitoSsoAppClient(discovery.provider)
    const state = createEnterpriseSsoState({
      email,
      providerId: discovery.provider.providerId,
      providerRevision: discovery.provider.revision,
      redirectUri: configuration.redirectUri,
      returnTo: typeof body?.returnTo === 'string' ? body.returnTo : undefined,
      hmacSecret: configuration.stateSecret,
    })
    c.header('Cache-Control', 'no-store')
    return c.json({
      authorizationUrl: buildCognitoAuthorizeUrl({
        cognitoDomain: configuration.cognitoDomain,
        clientId: configuration.clientId,
        redirectUri: configuration.redirectUri,
        identityProvider: discovery.provider.cognitoProviderName,
        state: state.state,
        nonce: state.nonce,
        codeChallenge: state.codeChallenge,
      }),
      state: state.state,
      codeVerifier: state.codeVerifier,
      expiresAt: state.expiresAt * 1_000,
      returnTo: state.returnTo,
    })
  } catch (error) {
    return toEnterpriseSsoErrorResponse(c, error)
  }
})

/** Cognito federation callback の code を PKCE verifier 付きで token と交換します。 */
routeApp.post('/api/auth/sso/exchange', async (c) => {
  try {
    const body = await readJson<Record<string, unknown>>(c.req)
    const configuration = requireEnterpriseSsoFederationConfiguration()
    const state = readEnterpriseText(body?.state, 'SSO state')
    const codeVerifier = readEnterpriseText(body?.codeVerifier, 'PKCE verifier')
    const validatedState = validateEnterpriseSsoState({
      state,
      codeVerifier,
      hmacSecret: configuration.stateSecret,
      expectedRedirectUri: configuration.redirectUri,
    })
    const discovery = await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(validatedState.email)
    if (
      !discovery ||
      discovery.provider.providerId !== validatedState.providerId ||
      discovery.provider.revision !== validatedState.providerRevision
    ) {
      throw new EnterpriseSsoError(
        409,
        'EnterpriseSsoConfigurationChanged',
        'Enterprise SSO configuration changed during login. Start again.',
      )
    }
    await enforceTenantFeatureForWorkspace(
      discovery.provider.workspaceId,
      'sso',
      'GET',
    )
    assertEnterpriseIdentityProviderReady(discovery.provider)
    assertEnterpriseCognitoProviderBinding(
      discovery.provider,
      configuration.identityProviderName,
    )
    await assertEnterpriseCognitoFederationProvider(discovery.provider)
    await assertEnterpriseCognitoSsoAppClient(discovery.provider)
    const code = readEnterpriseText(body?.code, 'Authorization code')
    const tokenUrl = new URL('/oauth2/token', normalizeEnterpriseCognitoDomain(
      configuration.cognitoDomain,
    ))
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: configuration.clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: configuration.redirectUri,
      }),
      signal: AbortSignal.timeout(7_500),
    })
    const tokenResponse = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new EnterpriseSsoError(
        401,
        'EnterpriseSsoCodeExchangeFailed',
        'Enterprise SSO authorization code could not be exchanged.',
      )
    }
    c.header('Cache-Control', 'no-store')
    const parsed = parseEnterpriseSsoTokenResponse({
      response: tokenResponse,
      expectedNonce: validatedState.nonce,
      expectedEmail: validatedState.email,
      returnTo: validatedState.returnTo,
      expectedClientId: configuration.clientId,
      expectedIssuer: configuration.issuer,
    })
    validateConfiguredCognitoAccessToken(parsed.accessToken)
    const accessTokenClaims = decodeJwtPayload<CognitoAccessTokenClaims>(parsed.accessToken)
    if (accessTokenClaims?.client_id !== configuration.clientId) {
      throw new EnterpriseSsoError(
        401,
        'InvalidSsoTokenResponse',
        'Cognito returned an access token for another app client.',
      )
    }
    const authentication = await createAuthenticationResponse({
      AccessToken: parsed.accessToken,
      IdToken: parsed.idToken,
      RefreshToken: parsed.refreshToken,
      ExpiresIn: Math.max(1, Math.floor((parsed.expiresAt - Date.now()) / 1_000)),
      TokenType: parsed.tokenType,
    }, c, {
      email: validatedState.email,
      providerId: validatedState.providerId,
      sso: true,
    }, undefined, [
      ...readCognitoAuthenticationMethods(
        decodeJwtPayload<CognitoAccessTokenClaims>(parsed.idToken),
      ),
      createEnterpriseSsoAuthenticationMethod(
        validatedState.providerId,
        discovery.provider.revision,
      ),
    ])
    return c.json({
      ...authentication,
      returnTo: parsed.returnTo,
    })
  } catch (error) {
    return toEnterpriseSsoErrorResponse(c, error)
  }
})

registerDocumentApiRoutes(routeApp, {
  getClient: () => workItemDependencies.documents,
  authenticate: createDocumentApiPrincipal,
  assertPublicShareEntitled: async (workspaceId) => {
    try {
      await enforceTenantFeatureForWorkspace(workspaceId, 'documents', 'GET')
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        throw new DocumentError(error.status, error.code, error.message)
      }
      throw error
    }
  },
  getActiveMember: (workspaceId, memberKey) =>
    workspaceDependencies.workspaceAccess.getActiveMember(workspaceId, memberKey),
  validateRelationTargets: validateDocumentRelationTargets,
  upsertSearchDocument: async (workspaceId, document) => {
    if (!isWorkspaceSearchProjectionEnabled()) return
    await workItemDependencies.workspaceSearch.upsertDocument(
      createDocumentWorkspaceSearchDocument(workspaceId, document),
    )
  },
  deleteSearchDocument: async (workspaceId, documentId) => {
    if (!isWorkspaceSearchProjectionEnabled()) return
    await workItemDependencies.workspaceSearch.deleteDocument(workspaceId, 'document', documentId)
  },
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
routeApp.post('/api/auth/login', async (c) => {
  const body = await readJson<LoginRequestBody>(c.req)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!email || !password) {
    return c.json({ message: 'Email and password are required.' }, 400)
  }

  try {
    const discovery = await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
    if (discovery) {
      return c.json({
        code: 'SsoRequired' as const,
        message: 'Single sign-on is required for this email domain.',
        provider: {
          id: discovery.provider.providerId,
          kind: discovery.provider.kind,
          displayName: discovery.provider.displayName,
        },
        ssoStartPath: '/api/auth/sso/start' as const,
      }, 409)
    }
    const response = await authenticationDependencies.cognito.initiatePasswordAuth(email, password)
    const tokens = response.AuthenticationResult

    if (!tokens?.AccessToken) {
      if (response.ChallengeName === 'NEW_PASSWORD_REQUIRED' && response.Session) {
        return c.json({
          challenge: 'NEW_PASSWORD_REQUIRED' as const,
          email,
          session: response.Session,
        })
      }
      const mfaChallenge = toSupportedMfaChallenge(response, email)
      if (mfaChallenge) return c.json(mfaChallenge)

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
    if (error instanceof EnterpriseIdentityError) {
      return toEnterpriseIdentityErrorResponse(c, error)
    }
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
routeApp.post('/api/auth/challenge/new-password', async (c) => {
  const body = await readJson<CompleteNewPasswordChallengeRequestBody>(c.req)
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const session = typeof body?.session === 'string' ? body.session.trim() : ''
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''

  if (!email || !session || !newPassword) {
    return c.json({ message: 'Email, session, and new password are required.' }, 400)
  }

  try {
    const discovery = await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
    if (discovery) {
      return c.json({
        code: 'SsoRequired' as const,
        message: 'Single sign-on is required for this email domain.',
        provider: {
          id: discovery.provider.providerId,
          kind: discovery.provider.kind,
          displayName: discovery.provider.displayName,
        },
        ssoStartPath: '/api/auth/sso/start' as const,
      }, 409)
    }
    const acceptanceState = await acquireNewPasswordChallengeInvitationLock(c, email)

    try {
      const response = await authenticationDependencies.cognito.respondToNewPasswordChallenge(email, newPassword, session)
      const tokens = response.AuthenticationResult

      if (!tokens?.AccessToken) {
        const mfaChallenge = toSupportedMfaChallenge(response, email)
        if (mfaChallenge) return c.json(mfaChallenge)
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

/**
 * Cognito の MFA/OTP challenge を完了する endpoint です。
 */
routeApp.post('/api/auth/challenge/mfa', async (c) => {
  const body = await readJson<CompleteMfaChallengeRequestBody>(c.req)
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const session = typeof body?.session === 'string' ? body.session.trim() : ''
  const code = typeof body?.code === 'string' ? body.code.trim() : ''
  const challenge = readCognitoMfaChallengeName(body?.challenge)

  if (!email || !session || !challenge || !/^\d{6,8}$/u.test(code)) {
    return c.json({
      code: 'InvalidMfaChallenge',
      message: 'Email, challenge session, and a valid one-time code are required.',
    }, 400)
  }

  try {
    const discovery = await workspaceDependencies.enterpriseIdentity.ssoDiscovery.discoverSso(email)
    if (discovery) {
      return c.json({
        code: 'SsoRequired' as const,
        message: 'Single sign-on is required for this email domain.',
        provider: {
          id: discovery.provider.providerId,
          kind: discovery.provider.kind,
          displayName: discovery.provider.displayName,
        },
        ssoStartPath: '/api/auth/sso/start' as const,
      }, 409)
    }
  } catch (error) {
    return toEnterpriseIdentityErrorResponse(c, error)
  }

  const rateLimit = consumeAuthenticationChallengeAttempt(c, email)
  if (!rateLimit.allowed) {
    c.header('Retry-After', String(rateLimit.retryAfterSeconds))
    return c.json({
      code: 'AuthenticationChallengeRateLimited',
      message: 'Too many verification attempts. Try again later.',
    }, 429)
  }

  try {
    const response = await authenticationDependencies.cognito.respondToMfaChallenge(
      email,
      challenge,
      code,
      session,
    )
    const tokens = response.AuthenticationResult
    if (!tokens?.AccessToken) {
      const nextChallenge = toSupportedMfaChallenge(response, email)
      if (nextChallenge) return c.json(nextChallenge)
      return c.json({
        code: 'UnsupportedAuthenticationChallenge',
        message: response.ChallengeName
          ? `Unsupported Cognito challenge: ${response.ChallengeName}`
          : 'Cognito did not return an access token.',
      }, 409)
    }
    clearAuthenticationChallengeAttempts(c, email)
    return c.json(await createAuthenticationResponse(
      tokens,
      c,
      { email },
      undefined,
      [challenge],
    ))
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return toWorkspaceAccessErrorResponse(c, error)
    }
    return toAuthErrorResponse(c, error)
  }
})

function toSupportedMfaChallenge(response: InitiateAuthResponse, email: string) {
  const challenge = readCognitoMfaChallengeName(response.ChallengeName)
  if (!challenge || !response.Session) return undefined
  const destination = response.ChallengeParameters?.CODE_DELIVERY_DESTINATION
  const deliveryMedium = response.ChallengeParameters?.CODE_DELIVERY_DELIVERY_MEDIUM
  return {
    challenge,
    email,
    session: response.Session,
    ...(destination ? { deliveryDestination: destination } : {}),
    ...(deliveryMedium ? { deliveryMedium } : {}),
  }
}

const authenticationChallengeAttempts = new Map<string, {
  attempts: number
  resetAt: number
}>()

function consumeAuthenticationChallengeAttempt(c: Context, email: string) {
  const key = authenticationChallengeAttemptKey(c, email)
  const now = Date.now()
  for (const [candidate, state] of authenticationChallengeAttempts) {
    if (state.resetAt <= now) authenticationChallengeAttempts.delete(candidate)
  }
  const current = authenticationChallengeAttempts.get(key)
  if (current && current.resetAt > now && current.attempts >= 10) {
    return {
      allowed: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
    }
  }
  authenticationChallengeAttempts.set(key, {
    attempts: (current?.attempts ?? 0) + 1,
    resetAt: current?.resetAt && current.resetAt > now
      ? current.resetAt
      : now + 5 * 60_000,
  })
  return { allowed: true as const, retryAfterSeconds: 0 }
}

function clearAuthenticationChallengeAttempts(c: Context, email: string) {
  authenticationChallengeAttempts.delete(authenticationChallengeAttemptKey(c, email))
}

function authenticationChallengeAttemptKey(c: Context, email: string) {
  let transportSource = 'transport-unavailable'
  try {
    transportSource = getConnInfo(c).remote.address ?? transportSource
  } catch {
    // Unit tests and non-server adapters do not always expose connection metadata.
  }
  return createHash('sha256')
    .update(`${transportSource}\0${email}`)
    .digest('base64url')
}

async function acquireNewPasswordChallengeInvitationLock(c: Context, email: string) {
  const workspaceUser = await authenticationDependencies.cognito.findWorkspaceUser(email)

  if (!workspaceUser?.directoryId) {
    return undefined
  }

  const activeMember = await workspaceDependencies.workspaceAccess.getActiveMember(
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

  const invitation = await workspaceDependencies.workspaceAccess.acquireInvitationAcceptanceLock(
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
    await workspaceDependencies.workspaceAccess.releaseInvitationAcceptanceLock(
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
routeApp.get('/api/workspace/access', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    return c.json(await workspaceDependencies.workspaceAccess.getAccessSnapshot(principal.directoryId, principal.userKey))
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toWorkspaceAccessErrorResponse(c, error)
  }
})

/** Workspace invitation を reservation して Cognito provisioning を開始する endpoint です。 */
routeApp.post('/api/workspace/invitations', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const body = await readJson<CreateWorkspaceInvitationRequestBody>(c.req)
    const email = readWorkspaceEmail(body?.email)
    const role = body?.role === undefined
      ? await resolveTenantDefaultInvitationRole(principal)
      : readWorkspaceRole(body.role)
    const name = readOptionalWorkspaceName(body?.name)
    const enterpriseSnapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    requireEnterpriseExternalAccessAllowed(enterpriseSnapshot, email, role)
    const auditContext = createWorkspaceMutationContext(c, principal, { email, name, role })
    const invitation = await workspaceDependencies.workspaceAccess.createInvitation(
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
      const deliveredInvitation = await workspaceDependencies.workspaceAccess.markInvitationDelivery(
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
routeApp.post('/api/workspace/invitations/:invitationId/resend', async (c) => {
  return handleWorkspaceInvitationDeliveryAction(c, 'resend')
})

/** Workspace invitation を取り消す endpoint です。 */
routeApp.post('/api/workspace/invitations/:invitationId/revoke', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const invitationId = readWorkspaceEmail(c.req.param('invitationId'))
    const auditContext = createWorkspaceMutationContext(c, principal, { invitationId })
    let invitation = await workspaceDependencies.workspaceAccess.revokeInvitation(
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
            const deletionResult = await authenticationDependencies.cognito.deleteWorkspaceUser(cleanupInput)

            if (deletionResult === 'manual-required') {
              manualCleanupRequired = true
            } else if (deletionResult === 'preserved') {
              manualCleanupRequired = await authenticationDependencies.cognito.unlinkWorkspaceUser(cleanupInput) ===
                'manual-required'
            }
          } else {
            manualCleanupRequired = await authenticationDependencies.cognito.unlinkWorkspaceUser(cleanupInput) ===
              'manual-required'
          }
          cleanupCompleted = !manualCleanupRequired
        } else {
          manualCleanupRequired = true
        }
      } catch (error) {
        try {
          await workspaceDependencies.workspaceAccess.markInvitationCleanupFailure(
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
        invitation = await workspaceDependencies.workspaceAccess.markInvitationManualCleanupRequired(
          principal.directoryId,
          invitation.id,
          invitation.version,
          auditContext,
        )
      } else if (cleanupCompleted) {
        invitation = await workspaceDependencies.workspaceAccess.clearInvitationCleanupFailure(
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
routeApp.post('/api/workspace/invitations/:invitationId/cleanup/acknowledge', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const invitationId = readWorkspaceEmail(c.req.param('invitationId'))
    const body = await readJson<AcknowledgeWorkspaceInvitationCleanupRequestBody>(c.req)
    const expectedVersion = readWorkspaceVersion(body?.expectedVersion)
    const auditContext = createWorkspaceMutationContext(
      c,
      principal,
      { expectedVersion, invitationId },
    )
    const invitation = await workspaceDependencies.workspaceAccess.acknowledgeInvitationManualCleanup(
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
routeApp.post('/api/workspace/invitations/:invitationId/reinvite', async (c) => {
  return handleWorkspaceInvitationDeliveryAction(c, 'reinvite')
})

/** Workspace member の role または status を version 条件付きで更新する endpoint です。 */
routeApp.patch('/api/workspace/members/:memberKey', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const memberKey = readWorkspaceEmail(c.req.param('memberKey'))
    const body = await readJson<UpdateWorkspaceAccessMemberRequestBody>(c.req)
    const role = body?.role === undefined ? undefined : readWorkspaceRole(body.role)
    const status = body?.status === undefined ? undefined : readWorkspaceMemberStatus(body.status)
    const expectedVersion = readWorkspaceVersion(body?.expectedVersion)
    if (role) {
      const existingMember = await workspaceDependencies.workspaceAccess.getMember(
        principal.directoryId,
        memberKey,
      )
      if (!existingMember) {
        throw new WorkspaceAccessError(
          404,
          'WorkspaceMemberNotFound',
          'Workspace member was not found.',
        )
      }
      requireEnterpriseExternalAccessAllowed(
        await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId),
        existingMember.email,
        role,
      )
    }
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
      expectedPlanningRevision = (await workItemDependencies.planning.getAuthorizationState(principal.directoryId)).revision
    }
    const expectedDocumentAuthorizationRevision =
      status === 'deactivated' || role === 'guest'
        ? await requirePrivateDocumentManagerContinuity(
            {
              documents: workItemDependencies.documents,
              workspaceAccess: workspaceDependencies.workspaceAccess,
            },
            principal.directoryId,
            memberKey,
          )
        : undefined

    const member = await workspaceDependencies.workspaceAccess.updateMember(
      principal.directoryId,
      principal.userKey,
      memberKey,
      {
        role,
        status,
        expectedVersion,
        expectedPlanningRevision,
        ...(expectedDocumentAuthorizationRevision === undefined
          ? {}
          : {
              expectedDocumentAuthorizationRevision,
            }),
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
routeApp.get('/api/auth/me', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    validateConfiguredCognitoAccessToken(accessToken)
    const user = await authenticationDependencies.cognito.getUser(accessToken)
    const principal = await authenticateWorkspacePrincipal(accessToken, user, c)

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

/** Enterprise identity/security の管理 snapshot を返します。 */
routeApp.get('/api/enterprise/security', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const activeBreakGlassActivation = principal.enterpriseAuthenticationSessionId
      ? await workspaceDependencies.enterpriseIdentity.read.getActiveBreakGlassActivation(
        principal.directoryId,
        principal.userKey,
        principal.enterpriseAuthenticationSessionId,
      )
      : undefined
    return c.json({
      ...toEnterpriseSecuritySnapshotView(
      snapshot,
      new URL(`/api/scim/v2/${encodeURIComponent(principal.directoryId)}`, c.req.url).toString(),
      principal.enterprisePermissions,
      ),
      ...(activeBreakGlassActivation
        ? {
            activeBreakGlassActivation: {
              expiresAt: activeBreakGlassActivation.expiresAt,
            },
          }
        : {}),
    })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** SAML/OIDC identity provider を保存または SSO enforcement を更新します。 */
routeApp.put('/api/enterprise/security/identity-provider', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const auditContext = createWorkspaceMutationContext(c, principal, body)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    if (typeof body?.enforced === 'boolean') {
      const provider = snapshot.identityProviders.find((candidate) =>
        candidate.status === 'active'
      )
      const domain = snapshot.domains.find((candidate) => candidate.status === 'verified')
      const breakGlassAccount = snapshot.breakGlassAccounts.find((candidate) =>
        isEnterpriseSsoRecoveryAccountReady(snapshot, candidate)
      )
      if (
        !domain ||
        body.enforced && (!provider || !breakGlassAccount)
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseSsoPrerequisiteMissing',
          'Verify a domain, activate an identity provider, and register an MFA-ready break-glass administrator before enforcing SSO.',
        )
      }
      if (body.enforced && provider) {
        const configuration = requireEnterpriseSsoFederationConfiguration()
        assertEnterpriseIdentityProviderReady(provider)
        assertEnterpriseCognitoProviderBinding(
          provider,
          configuration.identityProviderName,
        )
        await assertEnterpriseCognitoFederationProvider(provider)
        await assertEnterpriseCognitoSsoAppClient(provider)
      }
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 0)
      if (expectedVersion !== (provider?.revision ?? 0)) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIdentityProviderConflict',
          'Identity provider changed. Reload before changing SSO enforcement.',
        )
      }
      await workspaceDependencies.enterpriseIdentity.identityProviderAdministration.setSsoEnforcement(
        principal.directoryId,
        body.enforced,
        body.enforced ? provider?.providerId : undefined,
        expectedVersion,
        auditContext,
      )
    } else {
      const existing = snapshot.identityProviders[0]
      const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 0)
      if (expectedVersion !== (existing?.revision ?? 0)) {
        if (
          existing &&
          expectedVersion + 1 === existing.revision &&
          enterpriseIdentityProviderMatchesInput(existing, body)
        ) {
          return c.json({
            identityProvider: toEnterpriseSecuritySnapshotView(
              snapshot,
              new URL(
                `/api/scim/v2/${encodeURIComponent(principal.directoryId)}`,
                c.req.url,
              ).toString(),
              principal.enterprisePermissions,
            ).identityProvider,
          })
        }
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIdentityProviderConflict',
          'Identity provider changed. Reload and try again.',
        )
      }
      let provider = readEnterpriseIdentityProviderInput(
        principal.directoryId,
        body,
        existing,
      )
      if (body?.testConnection === true) {
        provider = await enterpriseIdentityProviderConnectionTester(provider)
      } else if (existing?.status === 'active') {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIdentityProviderTestRequired',
          'Test the replacement identity provider before changing an active connection.',
        )
      }
      if (provider.status === 'active') {
        const configuration = requireEnterpriseSsoFederationConfiguration()
        assertEnterpriseIdentityProviderReady(provider)
        assertEnterpriseCognitoProviderBinding(
          provider,
          configuration.identityProviderName,
        )
        await assertEnterpriseCognitoFederationProvider(provider)
        await assertEnterpriseCognitoSsoAppClient(provider)
      }
      await workspaceDependencies.enterpriseIdentity.identityProviderAdministration.putIdentityProvider(
        provider,
        auditContext,
      )
    }
    const nextSnapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    return c.json({
      identityProvider: toEnterpriseSecuritySnapshotView(
        nextSnapshot,
        new URL(`/api/scim/v2/${encodeURIComponent(principal.directoryId)}`, c.req.url).toString(),
        principal.enterprisePermissions,
      ).identityProvider,
    })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Managed domain claim と一回限り DNS verification value を作成します。 */
routeApp.post('/api/enterprise/security/domains', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const domainName = readEnterpriseText(body?.domain, 'Domain').toLowerCase()
    const requestIdempotencyKey =
      c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
    const domainId = createEnterpriseIdempotentResourceId(
      'domain',
      principal.directoryId,
      requestIdempotencyKey,
    )
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const receiptDomain = snapshot.domains.find((candidate) =>
      candidate.domainId === domainId
    )
    if (receiptDomain) {
      if (receiptDomain.domain !== domainName) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIdempotencyConflict',
          'Domain idempotency key was already used with a different payload.',
        )
      }
      return c.json({
        domain: toEnterpriseDomainView(receiptDomain),
        verificationRecordValue: createEnterpriseDomainVerificationValue(
          principal.directoryId,
          receiptDomain.domain,
        ),
      })
    }
    if (snapshot.domains.some((candidate) => candidate.domain === domainName)) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseDomainAlreadyClaimed',
        'Domain is already claimed in this Workspace.',
      )
    }
    const nowIso = new Date().toISOString()
    const domain = await workspaceDependencies.enterpriseIdentity.identityProviderAdministration.putVerifiedDomain({
      workspaceId: principal.directoryId,
      domainId,
      domain: domainName,
      status: 'pending',
      revision: 1,
      verificationRecordName: `_mukuroji-challenge.${domainName}`,
      enforceSso: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    }, createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey))
    return c.json({
      domain: toEnterpriseDomainView(domain),
      verificationRecordValue: createEnterpriseDomainVerificationValue(
        principal.directoryId,
        domain.domain,
      ),
    }, 201)
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** DNS TXT challenge を確認して domain claim を verified にします。 */
routeApp.post('/api/enterprise/security/domains/:domain/verify', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const domain = snapshot.domains.find((candidate) =>
      candidate.domain === c.req.param('domain').trim().toLowerCase()
    )
    if (!domain) {
      throw new EnterpriseIdentityError(404, 'EnterpriseDomainNotFound', 'Domain was not found.')
    }
    const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
    if (domain.status === 'verified' && expectedVersion + 1 === domain.revision) {
      return c.json({ domain: toEnterpriseDomainView(domain) })
    }
    if (expectedVersion !== domain.revision) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseDomainConflict',
        'Domain claim changed. Reload and try again.',
      )
    }
    const expectedValue = createEnterpriseDomainVerificationValue(
      principal.directoryId,
      domain.domain,
    )
    if (!isLocalEnterpriseDomainVerification()) {
      const values = (await resolveTxt(domain.verificationRecordName)).flat()
      if (!values.includes(expectedValue)) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseDomainVerificationPending',
          'DNS verification record was not found.',
          true,
        )
      }
    }
    const verified = await workspaceDependencies.enterpriseIdentity.identityProviderAdministration.putVerifiedDomain({
      ...domain,
      status: 'verified',
      revision: domain.revision + 1,
      verifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, createWorkspaceMutationContext(c, principal, body))
    return c.json({ domain: toEnterpriseDomainView(verified) })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** IP allowlist 保存前に現在の caller が締め出されるかを preview します。 */
routeApp.post('/api/enterprise/security/policy/preview', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const current = snapshot.policy ??
      createDefaultEnterpriseSecurityPolicy(principal.directoryId, principal.actorId)
    const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 0)
    if (expectedVersion !== current.revision) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseSecurityPolicyConflict',
        'Security policy changed. Reload and try again.',
      )
    }
    const ipAllowlist = readEnterpriseStringArray(body?.ipAllowlist, 'IP allowlist')
    validateEnterpriseIpAllowlist(ipAllowlist)
    return c.json({
      impact: createEnterprisePolicyCallerImpact(
        c,
        principal.directoryId,
        expectedVersion,
        ipAllowlist,
      ),
    })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** MFA/session/reauthentication/IP/guest security policy を更新します。 */
routeApp.put('/api/enterprise/security/policy', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const current = snapshot.policy ??
      createDefaultEnterpriseSecurityPolicy(principal.directoryId, principal.actorId)
    const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 0)
    if (expectedVersion !== current.revision) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseSecurityPolicyConflict',
        'Security policy changed. Reload and try again.',
      )
    }
    const ipAllowlist = readEnterpriseStringArray(body?.ipAllowlist, 'IP allowlist')
    validateEnterpriseIpAllowlist(ipAllowlist)
    const callerImpact = createEnterprisePolicyCallerImpact(
      c,
      principal.directoryId,
      expectedVersion,
      ipAllowlist,
    )
    if (
      callerImpact.requiresConfirmation &&
      body?.callerIpConfirmationToken !== callerImpact.confirmationToken
    ) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseIpAllowlistCallerExclusionConfirmationRequired',
        'The new IP allowlist excludes the current caller. Preview and explicitly confirm it.',
      )
    }
    const externalCollaboratorsAllowed =
      typeof body?.externalCollaboratorsAllowed === 'boolean'
        ? body.externalCollaboratorsAllowed
        : current.externalAccess.allowExternalCollaborators
    const verifiedDomains = snapshot.domains.filter((domain) =>
      domain.status === 'verified'
    )
    const callerDomain = normalizeEnterpriseEmailDomain(principal.workspaceMember.email)
    const callerIsExternal = verifiedDomains.length > 0 &&
      !verifiedDomains.some((domain) => domain.domain === callerDomain)
    const callerIsRecovery = snapshot.breakGlassAccounts.some((account) =>
      account.status === 'active' && account.linkedMemberKey === principal.userKey
    )
    if (!externalCollaboratorsAllowed && callerIsExternal && !callerIsRecovery) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseExternalPolicyCallerExclusion',
        'Register and test an external break-glass account before excluding the current caller.',
      )
    }
    const policy = await workspaceDependencies.enterpriseIdentity.authorization.putSecurityPolicy({
      ...current,
      mfaRequirement: body?.mfaRequired === true ? 'required' : 'optional',
      sessionLifetimeMinutes: readEnterpriseInteger(
        body?.sessionLifetimeMinutes,
        'Session lifetime',
        1,
      ),
      idleTimeoutMinutes: readEnterpriseInteger(
        body?.idleTimeoutMinutes,
        'Idle timeout',
        1,
      ),
      reauthenticationIntervalMinutes: readEnterpriseInteger(
        body?.reauthenticationMinutes,
        'Reauthentication interval',
        1,
      ),
      sensitiveActionReauthenticationMinutes: readEnterpriseInteger(
        body?.sensitiveActionReauthenticationMinutes,
        'Sensitive reauthentication interval',
        1,
      ),
      ipAllowlistMode: ipAllowlist.length > 0
        ? 'all-users'
        : 'disabled',
      ipAllowlist,
      externalAccess: {
        ...current.externalAccess,
        allowGuests: body?.guestsAllowed === true,
        allowExternalCollaborators: externalCollaboratorsAllowed,
        maximumSessionLifetimeMinutes: readEnterpriseInteger(
          body?.guestSessionLifetimeMinutes,
          'Guest session lifetime',
          1,
        ),
        allowedGuestDomains: readEnterpriseDomainArray(
          body?.allowedGuestDomains,
          'Allowed guest domains',
        ),
      },
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: principal.actorId,
    }, createWorkspaceMutationContext(c, principal, body))
    return c.json({ policy: toEnterpriseSecuritySnapshotView(
      { ...snapshot, policy },
      new URL(`/api/scim/v2/${encodeURIComponent(principal.directoryId)}`, c.req.url).toString(),
      principal.enterprisePermissions,
    ).sessionPolicy })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** SCIM bearer token を rotate して raw token を一回だけ返します。 */
routeApp.post('/api/enterprise/security/scim/token', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const requestIdempotencyKey =
      c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
    const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 0)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const requestedProviderId = typeof body?.identityProviderId === 'string'
      ? readEnterpriseText(body.identityProviderId, 'Identity provider ID')
      : undefined
    const readyProviders = snapshot.identityProviders.filter((candidate) =>
      candidate.status === 'active' &&
      candidate.lastTestedAt !== undefined &&
      Number.isFinite(Date.parse(candidate.lastTestedAt))
    )
    if (!requestedProviderId && readyProviders.length > 1) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseScimProviderAmbiguous',
        'Select the identity provider that will own this SCIM credential.',
      )
    }
    const provider = requestedProviderId
      ? readyProviders.find((candidate) => candidate.providerId === requestedProviderId)
      : readyProviders[0]
    assertEnterpriseIdentityProviderReady(provider)
    assertEnterpriseCognitoProviderBinding(
      provider,
      requireEnterpriseCognitoProviderName(),
    )
    await assertEnterpriseCognitoFederationProvider(provider)
    const issued = await workspaceDependencies.enterpriseIdentity.scimCredentialAdministration.rotateScimToken(
      principal.directoryId,
      provider.providerId,
      'Directory provider',
      expectedVersion,
      requestIdempotencyKey,
      createHash('sha256')
        .update(JSON.stringify({
          expectedVersion,
          identityProviderId: provider.providerId,
        }))
        .digest('hex'),
      createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey),
    )
    const nextSnapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    return c.json({
      scim: toEnterpriseSecuritySnapshotView(
        nextSnapshot,
        new URL(`/api/scim/v2/${encodeURIComponent(principal.directoryId)}`, c.req.url).toString(),
        principal.enterprisePermissions,
      ).scim,
      token: issued.token,
    }, 201)
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Provisioning dry-run impact preview を返します。 */
routeApp.post('/api/enterprise/security/provisioning/preview', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const preview = await workspaceDependencies.enterpriseIdentity.provisioning.previewProvisioning({
      workspaceId: principal.directoryId,
      source: 'directory-reconciliation',
      idempotencyKey: c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID(),
      protectedMemberKeys: await resolveEnterpriseProtectedProvisioningMemberKeys(
        principal.directoryId,
        snapshot,
      ),
    }, createWorkspaceMutationContext(c, principal, body))
    return c.json({ impact: toEnterpriseProvisioningImpact(preview) })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** 確認済み provisioning preview を Workspace access state へ適用します。 */
routeApp.post('/api/enterprise/security/provisioning/reconcile', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const previewId = readEnterpriseText(body?.previewId, 'Preview ID')
    const preview = await workspaceDependencies.enterpriseIdentity.provisioning.getProvisioningPreview(
      principal.directoryId,
      previewId,
    )
    if (
      !preview ||
      typeof body?.previewExpiresAt !== 'string' ||
      body.previewExpiresAt !== preview.expiresAt
    ) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseProvisioningPreviewExpired',
        'Provisioning preview changed or expired. Run a new dry-run.',
      )
    }
    const currentPreview = await workspaceDependencies.enterpriseIdentity.provisioning.previewProvisioning({
      workspaceId: principal.directoryId,
      source: 'directory-reconciliation',
      idempotencyKey: `${previewId}:freshness-check`,
      protectedMemberKeys: await resolveEnterpriseProtectedProvisioningMemberKeys(
        principal.directoryId,
        await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId),
      ),
    })
    if (currentPreview.fingerprint !== preview.fingerprint) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseProvisioningPreviewChanged',
        'Directory desired state changed after the dry-run. Review a new preview.',
      )
    }
    const run = await workspaceDependencies.enterpriseIdentity.provisioning.reconcileProvisioning({
      workspaceId: principal.directoryId,
      source: 'directory-reconciliation',
      idempotencyKey: c.req.header('Idempotency-Key')?.trim() || previewId,
      previewFingerprint: preview.fingerprint,
    }, createWorkspaceMutationContext(c, principal, body))
    if (run.status === 'succeeded') return c.json({ run })
    if (run.status === 'failed') {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseProvisioningRetryRequired',
        'This provisioning run failed previously. Use the retry action.',
      )
    }
    try {
      await applyEnterpriseProvisioningPlan(c, run)
      return c.json({
        run: await workspaceDependencies.enterpriseIdentity.provisioning.finalizeProvisioningRun(
          principal.directoryId,
          run.runId,
          'succeeded',
          undefined,
          createWorkspaceMutationContext(c, principal, body),
        ),
      })
    } catch (error) {
      await workspaceDependencies.enterpriseIdentity.provisioning.finalizeProvisioningRun(
        principal.directoryId,
        run.runId,
        'failed',
        resolveEnterpriseProvisioningFailureCode(error),
        createWorkspaceMutationContext(c, principal, body),
      )
      throw error
    }
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Redacted provisioning operation logs を返します。 */
routeApp.get('/api/enterprise/security/provisioning/logs', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    return c.json({
      logs: toEnterpriseSecuritySnapshotView(
        snapshot,
        new URL(`/api/scim/v2/${encodeURIComponent(principal.directoryId)}`, c.req.url).toString(),
        principal.enterprisePermissions,
      ).provisioningLogs,
    })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Failed provisioning operation を retry します。 */
routeApp.post('/api/enterprise/security/provisioning/logs/:runId/retry', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const run = await workspaceDependencies.enterpriseIdentity.provisioning.retryProvisioning(
      principal.directoryId,
      c.req.param('runId'),
      createWorkspaceMutationContext(c, principal, { runId: c.req.param('runId') }),
    )
    if (run.status === 'succeeded') return c.json({ run })
    try {
      await applyEnterpriseProvisioningPlan(c, run)
      return c.json({
        run: await workspaceDependencies.enterpriseIdentity.provisioning.finalizeProvisioningRun(
          principal.directoryId,
          run.runId,
          'succeeded',
          undefined,
          createWorkspaceMutationContext(c, principal, { runId: run.runId }),
        ),
      })
    } catch (error) {
      await workspaceDependencies.enterpriseIdentity.provisioning.finalizeProvisioningRun(
        principal.directoryId,
        run.runId,
        'failed',
        resolveEnterpriseProvisioningFailureCode(error),
        createWorkspaceMutationContext(c, principal, { runId: run.runId }),
      )
      throw error
    }
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Custom role を作成します。 */
routeApp.post('/api/enterprise/security/roles', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const requestIdempotencyKey =
      c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
    const roleId: EnterpriseCustomRole['roleId'] = `custom:${createEnterpriseIdempotentResourceId(
      'role',
      principal.directoryId,
      requestIdempotencyKey,
    )}`
    const name = readEnterpriseText(body?.name, 'Role name')
    const description = typeof body?.description === 'string'
      ? body.description.trim()
      : undefined
    const permissions = readEnterprisePermissions(body?.permissionIds)
    requireEnterprisePermissionGrantCeiling(
      principal.enterprisePermissions,
      permissions,
    )
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const receiptRole = snapshot.customRoles.find((candidate) =>
      candidate.roleId === roleId
    )
    if (receiptRole) {
      if (
        receiptRole.name !== name ||
        (receiptRole.description ?? '') !== (description ?? '') ||
        receiptRole.permissions.length !== permissions.length ||
        !receiptRole.permissions.every((permission) => permissions.includes(permission)) ||
        receiptRole.guestAssignable !== (body?.guestAssignable === true)
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIdempotencyConflict',
          'Role idempotency key was already used with a different payload.',
        )
      }
      return c.json({
        role: toEnterpriseRoleView(
          receiptRole,
          snapshot.roleAssignments.filter((assignment) =>
            assignment.roleId === receiptRole.roleId
          ).length,
        ),
      })
    }
    const nowIso = new Date().toISOString()
    const role = await workspaceDependencies.enterpriseIdentity.authorization.putCustomRole({
      workspaceId: principal.directoryId,
      roleId,
      name,
      description,
      permissions,
      guestAssignable: body?.guestAssignable === true,
      revision: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    }, createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey))
    return c.json({ role: toEnterpriseRoleView(role, 0) }, 201)
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Custom role 更新・削除前の assignment impact と確認 token を返します。 */
routeApp.post('/api/enterprise/security/roles/:roleId/impact', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const role = snapshot.customRoles.find((candidate) =>
      candidate.roleId === c.req.param('roleId')
    )
    if (!role) {
      throw new EnterpriseIdentityError(404, 'EnterpriseRoleNotFound', 'Role was not found.')
    }
    if (readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1) !== role.revision) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseCustomRoleConflict',
        'Custom role changed. Reload and try again.',
      )
    }
    const deleteRequested = body?.delete === true
    const permissionIds = deleteRequested || body?.permissionIds === undefined
      ? role.permissions
      : readEnterprisePermissions(body.permissionIds)
    const guestAssignable = deleteRequested || body?.guestAssignable === undefined
      ? role.guestAssignable
      : body.guestAssignable === true
    return c.json({
      impact: createEnterpriseRoleImpact(
        snapshot,
        role,
        permissionIds,
        guestAssignable,
        deleteRequested,
      ),
    })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Custom role permission set を optimistic revision 付きで更新します。 */
routeApp.put('/api/enterprise/security/roles/:roleId', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const existing = snapshot.customRoles.find((role) =>
      role.roleId === c.req.param('roleId')
    )
    if (!existing) {
      throw new EnterpriseIdentityError(404, 'EnterpriseRoleNotFound', 'Role was not found.')
    }
    if (readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1) !== existing.revision) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseCustomRoleConflict',
        'Custom role changed. Reload and try again.',
      )
    }
    const permissionIds = readEnterprisePermissions(body?.permissionIds)
    requireEnterprisePermissionGrantCeiling(
      principal.enterprisePermissions,
      permissionIds,
    )
    const guestAssignable = body?.guestAssignable === true
    const impact = createEnterpriseRoleImpact(
      snapshot,
      existing,
      permissionIds,
      guestAssignable,
      false,
    )
    if (body?.impactConfirmationToken !== impact.confirmationToken) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseRoleImpactConfirmationRequired',
        'Preview and confirm the custom role assignment impact before saving.',
      )
    }
    const role = await workspaceDependencies.enterpriseIdentity.authorization.putCustomRole({
      ...existing,
      name: readEnterpriseText(body?.name, 'Role name'),
      description: typeof body?.description === 'string' ? body.description.trim() : undefined,
      permissions: permissionIds,
      guestAssignable,
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
    }, createWorkspaceMutationContext(c, principal, body))
    return c.json({
      role: toEnterpriseRoleView(
        role,
        snapshot.roleAssignments.filter((assignment) => assignment.roleId === role.roleId).length,
      ),
    })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** 未使用 custom role を削除します。 */
routeApp.delete('/api/enterprise/security/roles/:roleId', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const role = snapshot.customRoles.find((candidate) =>
      candidate.roleId === c.req.param('roleId')
    )
    if (!role) {
      throw new EnterpriseIdentityError(404, 'EnterpriseRoleNotFound', 'Role was not found.')
    }
    const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
    if (expectedVersion !== role.revision) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseCustomRoleConflict',
        'Custom role changed. Reload and try again.',
      )
    }
    const impact = createEnterpriseRoleImpact(
      snapshot,
      role,
      role.permissions,
      role.guestAssignable,
      true,
    )
    if (impact.blocking) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseCustomRoleInUse',
        'Reassign every role reference before deleting this custom role.',
      )
    }
    if (body?.impactConfirmationToken !== impact.confirmationToken) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseRoleImpactConfirmationRequired',
        'Preview and confirm the custom role assignment impact before deleting.',
      )
    }
    await workspaceDependencies.enterpriseIdentity.authorization.deleteCustomRole(
      principal.directoryId,
      c.req.param('roleId'),
      expectedVersion,
      createWorkspaceMutationContext(c, principal, body),
    )
    return c.body(null, 204)
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Directory group → scoped role mapping を作成します。 */
routeApp.post('/api/enterprise/security/group-mappings', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const requestIdempotencyKey =
      c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
    const mappingId = createEnterpriseIdempotentResourceId(
      'group-mapping',
      principal.directoryId,
      requestIdempotencyKey,
    )
    const scopeType = body?.scopeType === 'team' || body?.scopeType === 'project'
      ? body.scopeType
      : 'workspace'
    const directoryGroupId = readEnterpriseText(
      body?.directoryGroupId,
      'Directory group ID',
    )
    const identityProviderId = readEnterpriseText(
      body?.identityProviderId,
      'Identity provider ID',
    )
    const roleId = readEnterpriseRoleId(body?.roleId)
    requireEnterpriseAssignableRole(
      snapshot,
      principal.enterprisePermissions,
      roleId,
      scopeType,
    )
    const scopeTargetId = scopeType === 'workspace'
      ? undefined
      : readEnterpriseText(body?.scopeId, 'Scope ID')
    const receiptMapping = snapshot.groupMappings.find((candidate) =>
      candidate.mappingId === mappingId
    )
    if (receiptMapping) {
      if (
        receiptMapping.directoryGroupId !== directoryGroupId ||
        receiptMapping.identityProviderId !== identityProviderId ||
        receiptMapping.roleId !== roleId ||
        receiptMapping.scope.kind !== scopeType ||
        receiptMapping.scope.targetId !== scopeTargetId
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseIdempotencyConflict',
          'Group mapping idempotency key was already used with a different payload.',
        )
      }
      return c.json({
        mapping: {
          id: receiptMapping.mappingId,
          identityProviderId: receiptMapping.identityProviderId,
          directoryGroupId: receiptMapping.directoryGroupId,
          directoryGroupName: typeof body?.directoryGroupName === 'string'
            ? body.directoryGroupName
            : receiptMapping.directoryGroupId,
          scopeType: receiptMapping.scope.kind,
          scopeId: receiptMapping.scope.targetId ?? receiptMapping.scope.workspaceId,
          scopeName: typeof body?.scopeName === 'string' ? body.scopeName : 'Workspace',
          roleId: receiptMapping.roleId,
          version: receiptMapping.revision,
        },
      })
    }
    await requireEnterpriseMappingReferences(
      snapshot,
      principal.directoryId,
      identityProviderId,
      directoryGroupId,
      scopeType,
      scopeTargetId,
    )
    const mapping = await workspaceDependencies.enterpriseIdentity.authorization.putGroupMapping({
      workspaceId: principal.directoryId,
      mappingId,
      identityProviderId,
      directoryGroupId,
      roleId,
      scope: {
        workspaceId: principal.directoryId,
        kind: scopeType,
        ...(scopeType === 'workspace'
          ? {}
          : { targetId: scopeTargetId }),
      },
      enabled: true,
      priority: snapshot.groupMappings.length,
      revision: 1,
      updatedAt: new Date().toISOString(),
    }, createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey))
    return c.json({
      mapping: {
        id: mapping.mappingId,
        identityProviderId: mapping.identityProviderId,
        directoryGroupId: mapping.directoryGroupId,
        directoryGroupName: typeof body?.directoryGroupName === 'string'
          ? body.directoryGroupName
          : mapping.directoryGroupId,
        scopeType: mapping.scope.kind,
        scopeId: mapping.scope.targetId ?? mapping.scope.workspaceId,
        scopeName: typeof body?.scopeName === 'string' ? body.scopeName : 'Workspace',
        roleId: mapping.roleId,
        version: mapping.revision,
      },
    }, 201)
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Directory group mapping の scope と role を optimistic revision 付きで更新します。 */
routeApp.put('/api/enterprise/security/group-mappings/:mappingId', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const existing = snapshot.groupMappings.find((mapping) =>
      mapping.mappingId === c.req.param('mappingId')
    )
    if (!existing) {
      throw new EnterpriseIdentityError(
        404,
        'EnterpriseGroupMappingNotFound',
        'Directory group mapping was not found.',
      )
    }
    const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
    if (existing.revision !== expectedVersion) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseGroupMappingConflict',
        'Directory group mapping changed. Reload and try again.',
      )
    }
    const scopeType = body?.scopeType === 'team' || body?.scopeType === 'project'
      ? body.scopeType
      : 'workspace'
    const roleId = readEnterpriseRoleId(body?.roleId)
    requireEnterpriseAssignableRole(
      snapshot,
      principal.enterprisePermissions,
      roleId,
      scopeType,
    )
    const directoryGroupId = readEnterpriseText(
      body?.directoryGroupId,
      'Directory group ID',
    )
    const identityProviderId = typeof body?.identityProviderId === 'string'
      ? readEnterpriseText(body.identityProviderId, 'Identity provider ID')
      : existing.identityProviderId
    if (identityProviderId !== existing.identityProviderId) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseDirectoryGroupProviderMismatch',
        'Directory mappings cannot be moved between identity providers.',
      )
    }
    const scopeTargetId = scopeType === 'workspace'
      ? undefined
      : readEnterpriseText(body?.scopeId, 'Scope ID')
    await requireEnterpriseMappingReferences(
      snapshot,
      principal.directoryId,
      identityProviderId,
      directoryGroupId,
      scopeType,
      scopeTargetId,
    )
    const mapping = await workspaceDependencies.enterpriseIdentity.authorization.putGroupMapping({
      ...existing,
      directoryGroupId,
      roleId,
      scope: {
        workspaceId: principal.directoryId,
        kind: scopeType,
        ...(scopeType === 'workspace'
          ? {}
          : { targetId: scopeTargetId }),
      },
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
    }, createWorkspaceMutationContext(c, principal, body))
    return c.json({
      mapping: {
        id: mapping.mappingId,
        identityProviderId: mapping.identityProviderId,
        directoryGroupId: mapping.directoryGroupId,
        directoryGroupName: typeof body?.directoryGroupName === 'string'
          ? body.directoryGroupName
          : mapping.directoryGroupId,
        scopeType: mapping.scope.kind,
        scopeId: mapping.scope.targetId ?? mapping.scope.workspaceId,
        scopeName: typeof body?.scopeName === 'string' ? body.scopeName : 'Workspace',
        roleId: mapping.roleId,
        version: mapping.revision,
      },
    })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Directory group mapping を削除します。 */
routeApp.delete('/api/enterprise/security/group-mappings/:mappingId', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    await workspaceDependencies.enterpriseIdentity.authorization.deleteGroupMapping(
      principal.directoryId,
      c.req.param('mappingId'),
      readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1),
      createWorkspaceMutationContext(c, principal, body),
    )
    return c.body(null, 204)
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Service account と一回限り credential を作成します。 */
routeApp.post('/api/enterprise/security/service-accounts', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const roleId = readEnterpriseRoleId(body?.roleId)
    const scopeType = body?.scopeType === 'team' || body?.scopeType === 'project'
      ? body.scopeType
      : 'workspace'
    const scopeId = scopeType === 'workspace'
      ? undefined
      : readEnterpriseText(body?.scopeId, 'Scope ID')
    requireEnterpriseAssignableRole(
      snapshot,
      principal.enterprisePermissions,
      roleId,
      scopeType,
    )
    await requireEnterpriseResourceScope(
      principal.directoryId,
      scopeType,
      scopeId,
    )
    const permissions = resolveEnterpriseRolePermissions(snapshot.customRoles, roleId)
    const credentialLifetimeDays = body?.credentialLifetimeDays === undefined
      ? 90
      : readEnterpriseInteger(body.credentialLifetimeDays, 'Credential lifetime', 1)
    if (credentialLifetimeDays > 365) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseServiceAccountLifetimeInvalid',
        'Credential lifetime must not exceed 365 days.',
      )
    }
    const allowedSourceCidrs = body?.allowedSourceCidrs === undefined
      ? []
      : readEnterpriseStringArray(body.allowedSourceCidrs, 'Allowed source CIDRs')
    validateEnterpriseIpAllowlist(allowedSourceCidrs)
    allowedSourceCidrs.sort()
    const nowIso = new Date().toISOString()
    const requestIdempotencyKey =
      c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
    const issued = await workspaceDependencies.enterpriseIdentity.serviceAccountAdministration.createServiceAccountWithToken({
      workspaceId: principal.directoryId,
      accountId: createEnterpriseIdempotentResourceId(
        'service-account',
        principal.directoryId,
        requestIdempotencyKey,
      ),
      displayName: readEnterpriseText(body?.name, 'Service account name'),
      permissions: [...new Set([...permissions, 'service-accounts.use' as const])],
      roleId,
      scope: {
        workspaceId: principal.directoryId,
        kind: scopeType,
        ...(scopeId ? { targetId: scopeId } : {}),
      },
      credentialLifetimeDays,
      allowedSourceCidrs,
      status: 'active',
      credentialGeneration: 0,
      revision: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    }, requestIdempotencyKey, createHash('sha256')
      .update(JSON.stringify({
        name: body?.name,
        roleId,
        scopeType,
        scopeId,
        credentialLifetimeDays,
        allowedSourceCidrs,
      }))
      .digest('hex'), createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey))
    return c.json({
      serviceAccount: toEnterpriseServiceAccountView(
        issued.account,
        issued.credential.expiresAt,
      ),
      token: issued.token,
    }, 201)
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Service account credential を rotate して一回だけ返します。 */
routeApp.post('/api/enterprise/security/service-accounts/:accountId/rotate', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const account = snapshot.serviceAccounts.find((candidate) =>
      candidate.accountId === c.req.param('accountId')
    )
    if (!account || account.status !== 'active') {
      throw new EnterpriseIdentityError(
        404,
        'EnterpriseServiceAccountNotFound',
        'Active service account was not found.',
      )
    }
    const requestIdempotencyKey =
      c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
    const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
    const issued = await workspaceDependencies.enterpriseIdentity.serviceAccountAdministration.rotateServiceAccountToken(
      principal.directoryId,
      account.accountId,
      expectedVersion,
      requestIdempotencyKey,
      createHash('sha256')
        .update(JSON.stringify({ accountId: account.accountId, expectedVersion }))
        .digest('hex'),
      createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey),
    )
    const rotatedAccount = (await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId))
      .serviceAccounts.find((candidate) => candidate.accountId === account.accountId) ?? account
    return c.json({
      serviceAccount: toEnterpriseServiceAccountView(
        rotatedAccount,
        issued.credential.expiresAt,
      ),
      token: issued.token,
    })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Service account と全 credential を revoke します。 */
routeApp.post('/api/enterprise/security/service-accounts/:accountId/revoke', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const account = snapshot.serviceAccounts.find((candidate) =>
      candidate.accountId === c.req.param('accountId')
    )
    const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
    if (
      account?.status === 'disabled' &&
      expectedVersion + 1 === account.revision
    ) {
      return c.json({ revoked: true })
    }
    await workspaceDependencies.enterpriseIdentity.serviceAccountAdministration.revokeServiceAccountToken(
      principal.directoryId,
      c.req.param('accountId'),
      undefined,
      expectedVersion,
      createWorkspaceMutationContext(c, principal, body),
    )
    return c.json({ revoked: true })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** MFA enrollment 済み member を break-glass administrator として事前登録します。 */
routeApp.post('/api/enterprise/security/break-glass/accounts', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const email = readWorkspaceEmail(body?.email)
    const member = (await workspaceDependencies.workspaceAccess.listActiveMembers(principal.directoryId))
      .find((candidate) => candidate.email.trim().toLowerCase() === email)
    if (!member || member.role === 'guest') {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseBreakGlassMemberInvalid',
        'Break-glass administrator must be an active non-guest Workspace member.',
      )
    }
    const profile = await authenticationDependencies.cognito.getUserProfile(member.memberKey)
    if (profile.mfaConfigured !== true) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseBreakGlassMfaRequired',
        'Configure MFA for this member before registering break-glass access.',
      )
    }
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    requireEnterpriseBreakGlassRecoveryDomainUnmanaged(snapshot, email)
    const requestIdempotencyKey =
      c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID()
    const accountId = createEnterpriseIdempotentResourceId(
      'break-glass',
      principal.directoryId,
      requestIdempotencyKey,
    )
    const receiptAccount = snapshot.breakGlassAccounts.find((account) =>
      account.accountId === accountId
    )
    if (receiptAccount && receiptAccount.linkedMemberKey !== member.memberKey) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseIdempotencyConflict',
        'Break-glass idempotency key was already used with a different member.',
      )
    }
    const existing = snapshot.breakGlassAccounts.find((account) =>
      account.linkedMemberKey === member.memberKey
    )
    if (existing?.status === 'active') {
      return c.json({
        breakGlassAdministrator: toEnterpriseBreakGlassView(existing),
      })
    }
    const nowIso = new Date().toISOString()
    const account = await workspaceDependencies.enterpriseIdentity.breakGlass.putBreakGlassAccount({
      workspaceId: principal.directoryId,
      accountId: existing?.accountId ?? accountId,
      linkedMemberKey: member.memberKey,
      email,
      status: 'active',
      requireMfa: true,
      maximumActivationMinutes: 30,
      mfaVerifiedAt: nowIso,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    }, createWorkspaceMutationContext(c, principal, body, requestIdempotencyKey))
    return c.json({
      breakGlassAdministrator: toEnterpriseBreakGlassView(account),
    }, existing ? 200 : 201)
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/**
 * 事前登録済み recovery identity の local login、MFA、recent authentication を検査します。
 */
routeApp.post('/api/enterprise/security/break-glass/test', async (c) => {
  try {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      throw new EnterpriseIdentityError(
        401,
        'EnterpriseAuthenticationRequired',
        'Bearer token is required.',
      )
    }
    const principal = await authenticateWorkspacePrincipal(
      accessToken,
      undefined,
      c,
      { breakGlassCandidate: true },
    )
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const account = snapshot.breakGlassAccounts.find((candidate) =>
      candidate.linkedMemberKey === principal.userKey && candidate.status === 'active'
    )
    if (!account) {
      throw new EnterpriseIdentityError(
        403,
        'EnterpriseBreakGlassDenied',
        'A pre-registered active break-glass account was not found for this member.',
      )
    }
    requireEnterpriseBreakGlassRecoveryDomainUnmanaged(snapshot, account.email)
    await requireEnterpriseMfa(principal.directoryId, accessToken)
    requireEnterpriseRecentAuthentication(
      accessToken,
      snapshot.policy?.sensitiveActionReauthenticationMinutes ?? 15,
    )
    const nowIso = new Date().toISOString()
    const tested = await workspaceDependencies.enterpriseIdentity.breakGlass.putBreakGlassAccount({
      ...account,
      lastTestedAt: nowIso,
      revision: account.revision + 1,
      updatedAt: nowIso,
    }, createWorkspaceMutationContext(c, principal, {
      accountId: account.accountId,
      recoveryAccessTested: true,
    }))
    return c.json({
      breakGlassAdministrator: toEnterpriseBreakGlassView(tested),
    })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/**
 * 事前登録済み本人だけが理由・MFA・recent re-authentication 付きで短時間昇格します。
 */
routeApp.post('/api/enterprise/security/break-glass/activate', async (c) => {
  try {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      throw new EnterpriseIdentityError(
        401,
        'EnterpriseAuthenticationRequired',
        'Bearer token is required.',
      )
    }
    const principal = await authenticateWorkspacePrincipal(
      accessToken,
      undefined,
      c,
      { breakGlassCandidate: true },
    )
    const body = await readJson<Record<string, unknown>>(c.req)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const account = snapshot.breakGlassAccounts.find((candidate) =>
      candidate.linkedMemberKey === principal.userKey &&
      candidate.status === 'active'
    )
    if (!account) {
      throw new EnterpriseIdentityError(
        403,
        'EnterpriseBreakGlassDenied',
        'A pre-registered active break-glass account was not found for this member.',
      )
    }
    await requireEnterpriseMfa(principal.directoryId, accessToken)
    requireEnterpriseRecentAuthentication(
      accessToken,
      snapshot.policy?.sensitiveActionReauthenticationMinutes ?? 15,
    )
    const reason = readEnterpriseText(
      body?.reason ?? c.req.header('X-Break-Glass-Reason'),
      'Break-glass reason',
    )
    const activationSnapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const activationAccount = activationSnapshot.breakGlassAccounts.find((candidate) =>
      candidate.accountId === account.accountId &&
      candidate.linkedMemberKey === principal.userKey &&
      candidate.status === 'active'
    )
    if (!activationAccount) {
      throw new EnterpriseIdentityError(
        403,
        'EnterpriseBreakGlassDenied',
        'A pre-registered active break-glass account was not found for this member.',
      )
    }
    requireEnterpriseBreakGlassRecoveryDomainUnmanaged(
      activationSnapshot,
      activationAccount.email,
    )
    const durationMinutes = body?.durationMinutes === undefined
      ? Math.min(15, activationAccount.maximumActivationMinutes)
      : readEnterpriseInteger(body.durationMinutes, 'Activation duration', 1)
    const activation = await workspaceDependencies.enterpriseIdentity.breakGlass.activateBreakGlass(
      principal.directoryId,
      activationAccount.accountId,
      principal.userKey,
      createEnterpriseAuthenticationSessionId(accessToken),
      reason,
      durationMinutes,
      createWorkspaceMutationContext(c, principal, {
        accountId: activationAccount.accountId,
        durationMinutes,
        reason,
      }),
    )
    return c.json({
      activation: {
        id: activation.activationId,
        accountId: activation.accountId,
        startedAt: activation.startedAt,
        expiresAt: activation.expiresAt,
      },
    }, 201)
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Current member の break-glass elevation だけを早期終了します。 */
routeApp.post('/api/enterprise/security/break-glass/revoke-activation', async (c) => {
  try {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      throw new EnterpriseIdentityError(
        401,
        'EnterpriseAuthenticationRequired',
        'Bearer token is required.',
      )
    }
    const principal = await authenticateWorkspacePrincipal(
      accessToken,
      undefined,
      c,
      { breakGlassCandidate: true },
    )
    await workspaceDependencies.enterpriseIdentity.breakGlass.revokeBreakGlassActivation(
      principal.directoryId,
      principal.userKey,
      createEnterpriseAuthenticationSessionId(accessToken),
      createWorkspaceMutationContext(c, principal, {
        breakGlassActivationRevoked: true,
      }),
    )
    return c.json({ revoked: true })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** Break-glass activation/account を即時停止します。 */
routeApp.post('/api/enterprise/security/break-glass/deactivate', async (c) => {
  try {
    const principal = await requireEnterpriseSecurityPrincipal(c)
    const body = await readJson<Record<string, unknown>>(c.req)
    const accountId = readEnterpriseText(body?.administratorId, 'Administrator ID')
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
    const account = snapshot.breakGlassAccounts.find((candidate) =>
      candidate.accountId === accountId
    )
    if (!account) {
      throw new EnterpriseIdentityError(
        404,
        'EnterpriseBreakGlassAccountNotFound',
        'Break-glass account was not found.',
      )
    }
    const expectedVersion = readEnterpriseInteger(body?.expectedVersion, 'Expected version', 1)
    if (account.status === 'disabled' && expectedVersion + 1 === account.revision) {
      return c.json({ deactivated: true })
    }
    await workspaceDependencies.enterpriseIdentity.breakGlass.deactivateBreakGlass(
      principal.directoryId,
      accountId,
      expectedVersion,
      createWorkspaceMutationContext(c, principal, body),
    )
    return c.json({ deactivated: true })
  } catch (error) {
    return toEnterpriseIdentityBoundaryErrorResponse(c, error)
  }
})

/** SCIM 2.0 provider capability document を返します。 */
routeApp.get('/api/scim/v2/:workspaceId/ServiceProviderConfig', async (c) => {
  try {
    await requireEnterpriseScimWorkspace(c)
    return toScimJson(c, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: true },
      authenticationSchemes: [{
        type: 'oauthbearertoken',
        name: 'Bearer Token',
        description: 'Workspace-scoped SCIM bearer credential.',
        specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
        primary: true,
      }],
    })
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/** SCIM user desired-state collection を list します。 */
routeApp.get('/api/scim/v2/:workspaceId/Users', async (c) => {
  try {
    const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
    const pagination = readScimPagination(c)
    const page = await workspaceDependencies.enterpriseIdentity.scimDirectory.listScimUsers({
      workspaceId,
      identityProviderId: credential.identityProviderId,
      ...pagination,
      ...readScimEqualityFilter(
        c.req.query('filter'),
        ['externalId', 'userName', 'displayName'],
      ),
    })
    return toScimJson(c, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: page.totalResults,
      startIndex: page.startIndex,
      itemsPerPage: page.resources.length,
      Resources: page.resources.map(toScimUserResource),
    })
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/** SCIM user desired state を idempotent に作成します。 */
routeApp.post('/api/scim/v2/:workspaceId/Users', async (c) => {
  try {
    const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
    const body = await readScimJson(c)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    const input = readEnterpriseScimUserInput(
      c,
      workspaceId,
      credential.identityProviderId,
      body,
    )
    if (!input.active && input.linkedMemberKey) {
      await requireEnterpriseScimDeprovisionAllowed(
        workspaceId,
        input.linkedMemberKey,
        snapshot,
      )
    }
    const user = await workspaceDependencies.enterpriseIdentity.scimDirectory.upsertScimUser(
      input,
      createEnterpriseScimMutationContext(
        c,
        workspaceId,
        credential.identityProviderId,
        body,
      ),
    )
    await applyEnterpriseScimUser(c, user)
    c.status(201)
    c.header('Location', new URL(
      `/api/scim/v2/${encodeURIComponent(workspaceId)}/Users/${encodeURIComponent(user.userId)}`,
      c.req.url,
    ).toString())
    setScimEtag(c, user.version)
    return toScimJson(c, toScimUserResource(user))
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/** SCIM user desired state を ID で返します。 */
routeApp.get('/api/scim/v2/:workspaceId/Users/:userId', async (c) => {
  try {
    const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
    const userId = readScimResourceId(c.req.param('userId'), 'user')
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    const user = snapshot.scimUsers.find((candidate) =>
      candidate.userId === userId &&
      candidate.identityProviderId === credential.identityProviderId
    )
    if (!user) {
      throw new EnterpriseIdentityError(404, 'EnterpriseScimUserNotFound', 'SCIM user was not found.')
    }
    setScimEtag(c, user.version)
    return toScimJson(c, toScimUserResource(user))
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/** SCIM user desired state を replace/patch します。 */
routeApp.on(['PUT', 'PATCH'], '/api/scim/v2/:workspaceId/Users/:userId', async (c) => {
  try {
    const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
    const userId = readScimResourceId(c.req.param('userId'), 'user')
    const body = await readScimJson(c)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    const existing = snapshot.scimUsers.find((candidate) =>
      candidate.userId === userId &&
      candidate.identityProviderId === credential.identityProviderId
    )
    if (!existing) {
      throw new EnterpriseIdentityError(404, 'EnterpriseScimUserNotFound', 'SCIM user was not found.')
    }
    requireScimIfMatch(c, existing.version)
    const merged = applyScimPatch(body, {
      externalId: existing.externalId,
      userName: existing.userName,
      displayName: existing.displayName,
      emails: existing.emails.map((value) => ({ value, primary: value === existing.emails[0] })),
      active: existing.active,
    })
    const input = readEnterpriseScimUserInput(
      c,
      workspaceId,
      credential.identityProviderId,
      merged,
      existing,
    )
    if (!input.active && input.linkedMemberKey) {
      await requireEnterpriseScimDeprovisionAllowed(
        workspaceId,
        input.linkedMemberKey,
        snapshot,
      )
    }
    const user = await workspaceDependencies.enterpriseIdentity.scimDirectory.upsertScimUser(
      input,
      createEnterpriseScimMutationContext(
        c,
        workspaceId,
        credential.identityProviderId,
        body,
      ),
    )
    await applyEnterpriseScimUser(c, user)
    setScimEtag(c, user.version)
    return toScimJson(c, toScimUserResource(user))
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/** SCIM user を desired inactive に収束させます。 */
routeApp.delete('/api/scim/v2/:workspaceId/Users/:userId', async (c) => {
  try {
    const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
    const userId = readScimResourceId(c.req.param('userId'), 'user')
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    const existing = snapshot.scimUsers.find((candidate) =>
      candidate.userId === userId &&
      candidate.identityProviderId === credential.identityProviderId
    )
    if (!existing) {
      throw new EnterpriseIdentityError(
        404,
        'EnterpriseScimUserNotFound',
        'SCIM user was not found.',
      )
    }
    requireScimIfMatch(c, existing.version)
    if (existing.linkedMemberKey) {
      await requireEnterpriseScimDeprovisionAllowed(
        workspaceId,
        existing.linkedMemberKey,
        snapshot,
      )
    }
    const user = await workspaceDependencies.enterpriseIdentity.scimDirectory.deactivateScimUser(
      workspaceId,
      credential.identityProviderId,
      userId,
      readScimIdempotencyKey(c, `delete-user:${userId}`),
      createEnterpriseScimMutationContext(
        c,
        workspaceId,
        credential.identityProviderId,
        { userId },
      ),
    )
    if (user) await applyEnterpriseScimUser(c, user)
    return c.body(null, 204)
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/** SCIM group desired-state collection を list します。 */
routeApp.get('/api/scim/v2/:workspaceId/Groups', async (c) => {
  try {
    const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
    const pagination = readScimPagination(
      c,
      ENTERPRISE_SCIM_GROUP_PAGE_LIMIT,
    )
    const page = await workspaceDependencies.enterpriseIdentity.scimDirectory.listScimGroups({
      workspaceId,
      identityProviderId: credential.identityProviderId,
      ...pagination,
      ...readScimEqualityFilter(
        c.req.query('filter'),
        ['externalId', 'displayName'],
      ),
    })
    return toScimJson(c, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: page.totalResults,
      startIndex: page.startIndex,
      itemsPerPage: page.resources.length,
      Resources: page.resources.map(toScimGroupResource),
    })
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/** SCIM group desired state を idempotent に作成します。 */
routeApp.post('/api/scim/v2/:workspaceId/Groups', async (c) => {
  try {
    const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
    const body = await readScimJson(c)
    const input = readEnterpriseScimGroupInput(
      c,
      workspaceId,
      credential.identityProviderId,
      body,
    )
    const group = await workspaceDependencies.enterpriseIdentity.scimDirectory.upsertScimGroup(
      input,
      createEnterpriseScimMutationContext(
        c,
        workspaceId,
        credential.identityProviderId,
        body,
      ),
    )
    c.status(202)
    c.header('Retry-After', '1')
    c.header('Location', new URL(
      `/api/scim/v2/${encodeURIComponent(workspaceId)}/Groups/${
        encodeURIComponent(group.groupId)
      }`,
      c.req.url,
    ).toString())
    setScimEtag(c, group.version)
    return toScimJson(c, toScimGroupResource(group))
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/** SCIM group desired state を ID で返します。 */
routeApp.get('/api/scim/v2/:workspaceId/Groups/:groupId', async (c) => {
  try {
    const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
    const groupId = readScimResourceId(c.req.param('groupId'), 'group')
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    const group = snapshot.scimGroups.find((candidate) =>
      candidate.groupId === groupId &&
      candidate.identityProviderId === credential.identityProviderId
    )
    if (!group) {
      throw new EnterpriseIdentityError(404, 'EnterpriseScimGroupNotFound', 'SCIM group was not found.')
    }
    setScimEtag(c, group.version)
    return toScimJson(c, toScimGroupResource(group))
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/** SCIM group desired state を replace/patch します。 */
routeApp.on(['PUT', 'PATCH'], '/api/scim/v2/:workspaceId/Groups/:groupId', async (c) => {
  try {
    const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
    const groupId = readScimResourceId(c.req.param('groupId'), 'group')
    const body = await readScimJson(c)
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    const existing = snapshot.scimGroups.find((candidate) =>
      candidate.groupId === groupId &&
      candidate.identityProviderId === credential.identityProviderId
    )
    if (!existing) {
      throw new EnterpriseIdentityError(404, 'EnterpriseScimGroupNotFound', 'SCIM group was not found.')
    }
    requireScimIfMatch(c, existing.version)
    const merged = applyScimPatch(body, {
      externalId: existing.externalId,
      displayName: existing.displayName,
      active: existing.active,
      members: existing.memberUserIds.map((value) => ({ value })),
    })
    const group = await workspaceDependencies.enterpriseIdentity.scimDirectory.upsertScimGroup(
      readEnterpriseScimGroupInput(
        c,
        workspaceId,
        credential.identityProviderId,
        merged,
        existing,
      ),
      createEnterpriseScimMutationContext(
        c,
        workspaceId,
        credential.identityProviderId,
        body,
      ),
    )
    c.status(202)
    c.header('Retry-After', '1')
    setScimEtag(c, group.version)
    return toScimJson(c, toScimGroupResource(group))
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/** SCIM group を desired inactive に収束させます。 */
routeApp.delete('/api/scim/v2/:workspaceId/Groups/:groupId', async (c) => {
  try {
    const { workspaceId, credential } = await requireEnterpriseScimWorkspace(c)
    const groupId = readScimResourceId(c.req.param('groupId'), 'group')
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    const existing = snapshot.scimGroups.find((candidate) =>
      candidate.groupId === groupId &&
      candidate.identityProviderId === credential.identityProviderId
    )
    if (!existing) {
      throw new EnterpriseIdentityError(
        404,
        'EnterpriseScimGroupNotFound',
        'SCIM group was not found.',
      )
    }
    requireScimIfMatch(c, existing.version)
    await workspaceDependencies.enterpriseIdentity.scimDirectory.deactivateScimGroup(
      workspaceId,
      credential.identityProviderId,
      groupId,
      readScimIdempotencyKey(c, `delete-group:${groupId}`),
      createEnterpriseScimMutationContext(
        c,
        workspaceId,
        credential.identityProviderId,
        { groupId },
      ),
    )
    c.header('Retry-After', '1')
    return c.body(null, 202)
  } catch (error) {
    return toScimErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたダッシュボード集計値を返す endpoint です。
 *
 * @remarks
 * `Authorization: Bearer <accessToken>` header を要求し、Cognito で token を検証してから
 * DynamoDB の集計 item を読みます。React から Lambda/API Gateway 経由で呼ぶ想定の読み取り API です。
 */
routeApp.route('/', createDashboardRouter<
  WorkspacePrincipal,
  ProjectAccessEntry,
  DashboardSummaryResponse
>({
  authenticate: async (accessToken, context) =>
    await authenticateWorkspacePrincipal(accessToken, undefined, context),
  getProjectAccesses: getEffectiveProjectAccessList,
  getSummary: (workspaceId, access) => workspaceDependencies.dashboardSummary.getSummary(workspaceId, access),
  isAuthenticationError: (error) => error instanceof CognitoServiceError,
  mapAuthenticationError: toAuthErrorResponse,
  mapProjectDataError: toProjectDataErrorResponse,
}))
routeApp.route('/', createAuditRouter(handleWorkspaceAuditRequest))
routeApp.route('/', createTenantAdministrationRouter({
  authenticate: async (accessToken, context) =>
    await authenticateWorkspacePrincipal(accessToken, undefined, context),
  requireAdministration: requireWorkspaceAdministration,
  requireEntitlementAdministration: requireTenantEntitlementAdministration,
  get client() {
    return workspaceDependencies.tenantAdministration
  },
  get tenantExportDownload() {
    return workspaceDependencies.tenantExportDownload
  },
  async resolveInitialization(principal) {
    const activeMembers = await workspaceDependencies.workspaceAccess.listActiveMembers(
      principal.directoryId,
    )
    const owner = activeMembers.find((member) => member.role === 'owner')
    if (!owner) {
      throw new TenantAdministrationError(
        503,
        'TenantOwnerUnavailable',
        'The Workspace owner required for tenant initialization is unavailable.',
      )
    }
    return {
      ownerMemberKey: owner.memberKey,
      activeSeats: activeMembers.length,
    }
  },
  readJson,
  mapError: (context, error) => {
    if (error instanceof CognitoServiceError) return toAuthErrorResponse(context, error)
    if (error instanceof WorkspaceAccessError) {
      return toWorkspaceAccessErrorResponse(context, error)
    }
    return toTenantAdministrationErrorResponse(context, error)
  },
}))

routeApp.route('/', createAnalyticsRouter({
  readBearerAccessToken,
  authenticate: async (accessToken, context) =>
    await authenticateWorkspacePrincipal(accessToken, undefined, context),
  readJson: readAnalyticsJson,
  executeQuery: executeAnalyticsHttpQuery,
  executeEvidence: executeAnalyticsHttpEvidence,
  createExport: createAnalyticsHttpExport,
  listReports: listAnalyticsHttpReports,
  createReport: createAnalyticsHttpReport,
  updateReport: updateAnalyticsHttpReport,
  deleteReport: deleteAnalyticsHttpReport,
  listSnapshots: listAnalyticsHttpSnapshots,
  createSnapshot: createAnalyticsHttpSnapshot,
  mapError: toAnalyticsErrorResponse,
}))

routeApp.route('/', createTimeTrackingRouter({
  readBearerAccessToken,
  authenticate: async (accessToken, context) =>
    await authenticateWorkspacePrincipal(accessToken, undefined, context),
  requireTeamPermission: async (principal, teamId, minimum) => {
    await requireTeamPermission(principal, teamId, minimum)
  },
  canManageRates: async (principal, teamId) => {
    try {
      await requireTeamPermission(principal, teamId, 'manager')
      return true
    } catch (error) {
      if (error instanceof ProjectDataError && error.status === 403) return false
      throw error
    }
  },
  getAccessibleProjectIds: async (principal, teamId) => {
    const context = await requireTeamPermission(principal, teamId, 'viewer')
    if (principal.isSystemAdmin) return undefined
    return new Set(
      (context.projectAccesses ?? [])
        .filter((access) => projectAccessAllows(access, 'viewer'))
        .map((access) => access.projectId),
    )
  },
  getManagedProjectIds: async (principal, teamId) => {
    const context = await requireTeamPermission(principal, teamId, 'viewer')
    if (principal.isSystemAdmin) return undefined
    return new Set(
      (context.projectAccesses ?? [])
        .filter((access) => projectAccessAllows(access, 'manager'))
        .map((access) => access.projectId),
    )
  },
  verifyProject: async (principal, teamId, projectId, minimum) => {
    const context = await requireTeamPermission(principal, teamId, minimum)
    if (
      !principal.isSystemAdmin &&
      !(context.projectAccesses ?? []).some((access) =>
        access.projectId === projectId && projectAccessAllows(access, minimum)
      )
    ) {
      throw new ProjectDataError(
        403,
        'ProjectAccessDenied',
        `User "${principal.userKey}" cannot access project "${projectId}".`,
      )
    }
  },
  verifyWorkItem: async (principal, teamId, workItemId, minimum = 'member') => {
    const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, minimum)
    return detail.issue.assignedProjectId ?? undefined
  },
  getTimeTracking: () => timeTrackingDependencies.timeTrackingService,
  readJson,
  mapError: toTimeTrackingErrorResponse,
}))

routeApp.route('/', createCapacityPlanningRouter({
  readBearerAccessToken,
  authenticate: async (accessToken, context) =>
    await authenticateWorkspacePrincipal(accessToken, undefined, context),
  requireTeamPermission: async (principal, teamId, minimum) => {
    if (principal.workspaceRole === 'guest') {
      throw new ProjectDataError(403, 'ProjectAccessDenied', 'Guests cannot access workload planning.')
    }
    const context = await requireTeamPermission(principal, teamId, minimum)
    const isPrivileged = principal.isSystemAdmin || principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin'
    return {
      ...(isPrivileged ? {} : {
        visibleProjectIds: new Set(
          (context.projectAccesses ?? [])
            .filter((access) => projectAccessAllows(access, 'viewer'))
            .map((access) => access.projectId),
        ),
      }),
      teamProjectIds: context.team.projects.map((project) => project.id),
      canViewConfidential: isPrivileged || (context.projectAccesses ?? []).some((access) => projectAccessAllows(access, 'manager')),
    }
  },
  getWorkloadVisibility: async (principal, _teamId, permission) => {
    if (permission.visibleProjectIds === undefined) {
      return { canViewConfidential: permission.canViewConfidential ?? false }
    }
    const visibleMemberIds = await readWorkloadProjectMemberIds(
      principal,
      [...permission.visibleProjectIds],
    )
    visibleMemberIds.add(principal.userKey)
    return {
      visibleMemberIds,
      visibleProjectIds: permission.visibleProjectIds,
      canViewConfidential: permission.canViewConfidential ?? false,
    }
  },
  verifyMember: async (principal, _teamId, memberId, permission) => {
    const projectIds = permission.visibleProjectIds === undefined
      ? permission.teamProjectIds ?? []
      : [...permission.visibleProjectIds]
    const visibleMemberIds = await readWorkloadProjectMemberIds(principal, projectIds)
    if (!visibleMemberIds.has(memberId)) {
      throw new ProjectDataError(
        403,
        'ProjectAccessDenied',
        `User "${principal.userKey}" cannot manage workload member "${memberId}".`,
      )
    }
  },
  canManageMember: async (principal, teamId, memberId) => {
    if (principal.isSystemAdmin || principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin') return true
    if (principal.userKey === memberId) return true
    try {
      await requireTeamPermission(principal, teamId, 'manager')
      return true
    } catch (error) {
      if (error instanceof ProjectDataError && error.status === 403) return false
      throw error
    }
  },
  verifyProject: async (principal, teamId, projectId, minimum) => {
    const context = await requireTeamPermission(principal, teamId, minimum)
    if (
      !principal.isSystemAdmin &&
      principal.workspaceRole !== 'owner' &&
      principal.workspaceRole !== 'admin' &&
      !(context.projectAccesses ?? []).some((access) =>
        access.projectId === projectId && projectAccessAllows(access, minimum)
      )
    ) {
      throw new ProjectDataError(
        403,
        'ProjectAccessDenied',
        `User "${principal.userKey}" cannot access project "${projectId}".`,
      )
    }
  },
  verifyWorkItem: async (principal, teamId, workItemId, minimum) =>
    (await loadAuthorizedTeamIssue(principal, teamId, workItemId, minimum)).detail.issue.assignedProjectId ?? undefined,
  getCapacityPlanning: () => capacityPlanningDependencies.capacityPlanningService,
  readJson,
  mapError: toCapacityPlanningErrorResponse,
}))

const WORKLOAD_PROJECT_MEMBER_BATCH_SIZE = 20

/** Reads canonical members for workload visibility using bounded directory batches. */
async function readWorkloadProjectMemberIds(
  principal: WorkspacePrincipal,
  projectIds: readonly string[],
): Promise<Set<string>> {
  const memberIds = new Set<string>()
  for (let index = 0; index < projectIds.length; index += WORKLOAD_PROJECT_MEMBER_BATCH_SIZE) {
    const batch = projectIds.slice(index, index + WORKLOAD_PROJECT_MEMBER_BATCH_SIZE)
    const responses = await Promise.all(batch.map((projectId) =>
      workspaceDependencies.projectDirectory.getProjectMembers(principal.directoryId, projectId),
    ))
    for (const response of responses) {
      for (const member of response.members) memberIds.add(member.id)
    }
  }
  return memberIds
}

routeApp.route('/', createNotificationRouter({
  getNotifications: () => workItemDependencies.notifications,
  authenticate: async (accessToken, context) =>
    await authenticateWorkspacePrincipal(accessToken, undefined, context),
  createVisibilityFilter: createNotificationVisibilityFilter,
  mapError: toNotificationErrorResponse,
  readJson,
}))

/** Workspace の versioned automation rules を返します。 */
routeApp.get('/api/automation/rules', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    return c.json({ rules: await automationDependencies.ruleTemplates.listRules(principal.directoryId) })
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が automation rule を作成します。 */
routeApp.post('/api/automation/rules', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = validateCreateAutomationRuleInput(await readAutomationJson(c))
    return c.json(await automationDependencies.ruleTemplates.createRule(
      principal.directoryId,
      input,
      c.req.header('Idempotency-Key')?.trim() || undefined,
    ), 201)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が automation rule の新 version を保存します。 */
routeApp.patch('/api/automation/rules/:ruleId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = await readAutomationJson(c) as UpdateAutomationRuleInput
    return c.json(await automationDependencies.ruleTemplates.updateRule(
      principal.directoryId,
      c.req.param('ruleId'),
      input,
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者へ secret を除いた inbound webhook endpoints を返します。 */
routeApp.get('/api/automation/inbound-webhooks', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    return c.json({
      endpoints: await automationDependencies.inboundWebhooks.listInboundWebhookEndpoints(principal.directoryId),
    })
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が server-issued inbound webhook endpoint を作成します。 */
routeApp.post('/api/automation/inbound-webhooks', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const idempotencyKey = readRequiredInboundWebhookIdempotencyKey(c)
    const provisioning = await automationDependencies.inboundWebhooks.reserveCreateInboundWebhookEndpoint(
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
routeApp.get('/api/automation/inbound-webhooks/:endpointId', async (c) => {
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
routeApp.patch('/api/automation/inbound-webhooks/:endpointId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    return c.json(await automationDependencies.inboundWebhooks.updateInboundWebhookEndpoint(
      principal.directoryId,
      c.req.param('endpointId'),
      validateUpdateAutomationInboundWebhookEndpointInput(await readAutomationJson(c)),
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が inbound webhook endpoint を pause します。 */
routeApp.post('/api/automation/inbound-webhooks/:endpointId/pause', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    return c.json(await automationDependencies.inboundWebhooks.setInboundWebhookEndpointStatus(
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
routeApp.post('/api/automation/inbound-webhooks/:endpointId/resume', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    return c.json(await automationDependencies.inboundWebhooks.setInboundWebhookEndpointStatus(
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
routeApp.post('/api/automation/inbound-webhooks/:endpointId/rotate', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const idempotencyKey = readRequiredInboundWebhookIdempotencyKey(c)
    const provisioning = await automationDependencies.inboundWebhooks.reserveRotateInboundWebhookEndpoint(
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
routeApp.delete('/api/automation/inbound-webhooks/:endpointId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const revoked = await automationDependencies.inboundWebhooks.revokeInboundWebhookEndpoint(
      principal.directoryId,
      c.req.param('endpointId'),
      validateAutomationInboundWebhookLifecycleInput(await readAutomationJson(c)),
    )
    await automationDependencies.automationInboundWebhookSecrets.delete(
      toAutomationInboundWebhookSecretReference(revoked),
    )
    return c.json(toAutomationInboundWebhookEndpoint(revoked))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** External sender の raw JSON delivery を HMAC 検証して durable outbox event に変換します。 */
routeApp.post('/api/automation/inbound-webhooks/:opaqueEndpointId', async (c) => {
  try {
    const endpoint = await automationDependencies.inboundWebhooks.resolveInboundWebhookEndpoint(
      c.req.param('opaqueEndpointId'),
    )
    if (!endpoint || endpoint.status === 'provisioning' || endpoint.status === 'revoked') {
      throw automationInboundWebhookNotFound()
    }
    if (endpoint.status === 'paused') {
      throw new AutomationError(
        'locked',
        'AutomationInboundWebhookPaused',
        'Inbound webhook endpoint is paused.',
      )
    }
    if (!isAutomationInboundWebhookJsonContentType(c.req.header('Content-Type'))) {
      throw new AutomationError(
        'unsupported-media-type',
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
    const signingSecret = await automationDependencies.automationInboundWebhookSecrets.get(secretReference)
    const signatureFingerprint = verifyAutomationInboundWebhookSignature(
      signingSecret,
      signatureTimestamp,
      rawBody,
      c.req.header('X-Mukuroji-Signature'),
    )
    const payload = parseAutomationInboundWebhookJson(rawBody)
    if (!isAutomationValue(payload)) {
      throw new AutomationError(
        'invalid-input',
        'AutomationInboundWebhookJsonInvalid',
        'Request body contains an unsupported JSON value.',
      )
    }
    const bodyFingerprint = createHash('sha256').update(rawBody).digest('hex')
    const meteringScope = createHash('sha256')
      .update('POST')
      .update('\0')
      .update(endpoint.id)
      .update('\0')
      .update(idempotencyKey)
      .digest('hex')
    await enforceTenantFeatureForWorkspace(
      endpoint.workspaceId,
      'automation',
      c.req.method,
      `tenant-meter:v1:${meteringScope}:${bodyFingerprint}`,
    )

    const auditTableName = getConfiguredAuditTableName()
    if (!auditTableName) throw automationInboundWebhookUnavailable()
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
      expiresAt: calculateAuditExpiresAt(
        auditContext.occurredAt,
        getConfiguredAuditRetentionDays(),
      ),
    })
    const delivery = await automationDependencies.inboundWebhooks.recordInboundWebhookDelivery(endpoint, {
      idempotencyKey,
      bodyFingerprint,
      signatureFingerprint,
      signatureTimestamp,
      eventId: event.eventId,
      auditMutation: createAuditEventTransactPut(auditTableName, event),
    })
    return c.json({ eventId: delivery.eventId }, 202)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace の versioned automation templates を返します。 */
routeApp.get('/api/automation/templates', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    return c.json({ templates: await automationDependencies.ruleTemplates.listTemplates(principal.directoryId) })
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が automation template を作成します。 */
routeApp.post('/api/automation/templates', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = validateCreateAutomationTemplateInput(await readAutomationJson(c))
    return c.json(await automationDependencies.ruleTemplates.createTemplate(
      principal.directoryId,
      input,
      c.req.header('Idempotency-Key')?.trim() || undefined,
    ), 201)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が automation template の新 version を保存します。 */
routeApp.patch('/api/automation/templates/:templateId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = await readAutomationJson(c) as UpdateAutomationTemplateInput
    return c.json(await automationDependencies.ruleTemplates.updateTemplate(
      principal.directoryId,
      c.req.param('templateId'),
      input,
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が template の current version を複製します。 */
routeApp.post('/api/automation/templates/:templateId/duplicate', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const source = await automationDependencies.ruleTemplates.getTemplate(
      principal.directoryId,
      c.req.param('templateId'),
    )
    if (!source) {
      throw new AutomationError('not-found', 'AutomationTemplateNotFound', 'Automation template was not found.')
    }
    return c.json(await automationDependencies.ruleTemplates.createTemplate(
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
routeApp.post('/api/automation/templates/:templateId/applications', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim()
    if (!idempotencyKey) {
      throw new AutomationError(
        'invalid-input',
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
        'invalid-input',
        'InvalidAutomationInput',
        'Workspace workflow target must match the authenticated Workspace.',
      )
    }
    if (input.target.kind === 'workflow' && input.target.scopeType === 'team') {
      await requireTeamConfigurationAdministration(principal, input.target.scopeId)
    }
    const application = await automationDependencies.ruleTemplates.reserveTemplateApplication(
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
routeApp.get('/api/automation/template-applications/:applicationId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const application = await automationDependencies.ruleTemplates.getTemplateApplication(
      principal.directoryId,
      c.req.param('applicationId'),
    )
    if (!application) {
      throw new AutomationError(
        'not-found',
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
routeApp.get('/api/recurring-work', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    return c.json({ recurringWorks: await automationDependencies.recurringSchedules.listRecurringWorks(principal.directoryId) })
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が recurring Work 定義を作成します。 */
routeApp.post('/api/recurring-work', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = validateCreateRecurringWorkInput(await readAutomationJson(c))
    await requireAutomationTeam(principal.directoryId, input.teamId)
    return c.json(await automationDependencies.recurringSchedules.createRecurringWork(
      principal.directoryId,
      input,
      c.req.header('Idempotency-Key')?.trim() || undefined,
    ), 201)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Workspace 管理者が recurring Work 定義の新 version を保存します。 */
routeApp.patch('/api/recurring-work/:recurringWorkId', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const input = await readAutomationJson(c) as UpdateRecurringWorkInput
    const current = await automationDependencies.recurringSchedules.getRecurringWork(
      principal.directoryId,
      c.req.param('recurringWorkId'),
    )
    if (!current) {
      throw new AutomationError('not-found', 'RecurringWorkNotFound', 'Recurring Work definition was not found.')
    }
    await requireAutomationTeam(principal.directoryId, input.teamId ?? current.teamId)
    return c.json(await automationDependencies.recurringSchedules.updateRecurringWork(
      principal.directoryId,
      c.req.param('recurringWorkId'),
      input,
    ))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Automation execution history と partial action state を返します。 */
routeApp.get('/api/automation/executions', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    return c.json(await automationDependencies.executions.listExecutions({
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
routeApp.post('/api/automation/executions/:executionId/retry', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c, true)
    const executionId = c.req.param('executionId')
    const event = await automationDependencies.executions.getExecutionEvent(principal.directoryId, executionId)
    if (!event) {
      throw new AutomationError('not-found', 'AutomationExecutionNotFound', 'Automation execution was not found.')
    }
    const engine = new AutomationEngine(
      automationDependencies.executions,
      createAutomationActionExecutor(),
    )
    return c.json(await engine.retryExecution(principal.directoryId, executionId, event))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Authenticated form submission を durable automation outbox event に変換します。 */
routeApp.post('/api/automation/forms/:formId/submissions', async (c) => {
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
routeApp.post('/api/bulk-operations/preview', async (c) => {
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
routeApp.post('/api/bulk-operations', async (c) => {
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
      automationDependencies.bulkOperations,
    )
    return c.json(toBulkOperationResponse(operation), 201)
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Bulk operation の retryable failures だけを安全に再実行します。 */
routeApp.post('/api/bulk-operations/:operationId/retry', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    requireWorkspaceBusinessWrite(principal)
    const operation = await requireBulkOperation(principal.directoryId, c.req.param('operationId'))
    requireBulkOperationOwner(operation, principal.userKey)
    const retried = await retryBulkOperation(
      operation,
      createApiBulkOperationAdapter(principal, c),
      automationDependencies.bulkOperations,
    )
    return c.json(toBulkOperationResponse(retried))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/** Bulk operation の成功 item を current revision guard 付きで undo します。 */
routeApp.post('/api/bulk-operations/:operationId/undo', async (c) => {
  try {
    const principal = await authenticateAutomationPrincipal(c)
    requireWorkspaceBusinessWrite(principal)
    const operation = await requireBulkOperation(principal.directoryId, c.req.param('operationId'))
    requireBulkOperationOwner(operation, principal.userKey)
    const undone = await undoBulkOperation(
      operation,
      createApiBulkOperationAdapter(principal, c),
      automationDependencies.bulkOperations,
    )
    return c.json(toBulkOperationResponse(undone))
  } catch (error) {
    return toAutomationErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたチーム/プロジェクト階層を返す endpoint です。
 *
 * @remarks
 * サイドバー用の directory table を読み、`locale=en` のときだけ英語名を優先します。
 */
routeApp.get('/api/teams/projects', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
      principal.directoryId,
      readLocale(c),
    )
    if (principal.isSystemAdmin) return c.json(directory)
    const readableProjectIds = new Set(
      (await getEffectiveProjectAccessList(principal))
        .filter((access) => projectAccessAllows(access, 'viewer'))
        .map((access) => access.projectId),
    )
    const authorizedTeamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
    return c.json({
      ...directory,
      teams: directory.teams
        .map((team) => ({
          ...team,
          projects: team.projects.filter((project) =>
            readableProjectIds.has(project.id)
          ),
        }))
        .filter((team) => authorizedTeamIds.has(team.id) || team.projects.length > 0),
    })
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/** Returns the authenticated viewer's accessible ordered Project shortcuts. */
routeApp.get('/api/projects/quick-access', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const [preference, authorizedProjectKeys] = await Promise.all([
      workspaceDependencies.projectDirectory.getProjectQuickAccess(
        principal.directoryId,
        principal.userKey,
        true,
      ),
      getAuthorizedProjectQuickAccessKeys(principal),
    ])

    return c.json({
      ...preference,
      items: preference.items.filter((item) =>
        authorizedProjectKeys.has(createProjectQuickAccessIdentity(item))
      ),
    } satisfies ProjectQuickAccessPreferences)
  } catch (error) {
    if (error instanceof CognitoServiceError) {
      return toAuthErrorResponse(c, error)
    }

    return toProjectDataErrorResponse(c, error)
  }
})

/** Replaces the authenticated viewer's complete ordered Project shortcuts. */
routeApp.put('/api/projects/quick-access', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const input = readProjectQuickAccessInput(await readJson<unknown>(c.req))
    const authorizedProjectKeys = await getAuthorizedProjectQuickAccessKeys(principal)

    if (input.items.some((item) =>
      !authorizedProjectKeys.has(createProjectQuickAccessIdentity(item))
    )) {
      throw new ProjectDataError(
        403,
        'ProjectAccessDenied',
        'One or more Project quick-access references are unavailable.',
      )
    }

    return c.json(await workspaceDependencies.projectDirectory.replaceProjectQuickAccess(
      principal.directoryId,
      principal.userKey,
      input,
    ))
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
routeApp.post('/api/teams', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const body = await readJson<CreateTeamRequestBody>(c.req)

    const response = await workspaceDependencies.projectDirectory.createTeam(
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
routeApp.post('/api/teams/:teamId/projects', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const body = await readJson<CreateProjectRequestBody>(c.req) ?? {}
    delete body.idempotencyResourceId

    const response = await workspaceDependencies.projectDirectory.createProject(
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
routeApp.patch('/api/teams/:teamId/archive', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const expectedPlanningRevision = await requirePlanningTeamScopeIsUnused(
      principal.directoryId,
      teamId,
    )

    const response = await workspaceDependencies.projectDirectory.archiveTeam(
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
routeApp.patch('/api/teams/:teamId/projects/:projectId/archive', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const archiveGuard = await requirePlanningProjectScopeIsUnused(
      principal.directoryId,
      teamId,
      projectId,
    )

    const response = await workspaceDependencies.projectDirectory.archiveProject(
      principal.directoryId,
      teamId,
      projectId,
      createApiMutationContext(c, principal, { teamId, projectId }),
      archiveGuard.expectedPlanningRevision,
      archiveGuard.workItemRevisionGuards,
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
routeApp.get('/api/projects/:projectId/watch', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }
  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    await requireProjectPermission(principal, projectId, 'viewer')
    const watch = await workItemDependencies.collaboration.getWatcherState({
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
  routeApp.on(projectWatchMethod, '/api/projects/:projectId/watch', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const projectId = c.req.param('projectId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }
    if (!projectId) {
      return c.json({ message: 'Project ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
        ? await workItemDependencies.collaboration.subscribe(mutationInput)
        : await workItemDependencies.collaboration.unsubscribe(mutationInput)
      return c.json({ watch })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })
}

routeApp.route('/', createPublicRequestIntakeRouter({
  getRequestIntake: () => workItemDependencies.requestIntake,
  authorizeRequestLink,
  createExternalContext: createRequestExternalContext,
  mapError: (context, error) => toRequestIntakeErrorResponse(context, error, true),
  readJson,
}))

routeApp.route('/', createAdminRequestIntakeRouter({
  getRequestIntake: () => workItemDependencies.requestIntake,
  requireAdministration: requireRequestAdministration,
  readJson,
  validateFormRoutingReferences: validateRequestFormRoutingReferences,
  readSubmissionStatus: readRequestSubmissionStatus,
  readQueueLimit: (value) => readOptionalPositiveQueryInteger(value, 'Request queue limit'),
  mapError: toRequestIntakeErrorResponse,
}))

routeApp.route('/', createTriageRouter({
  getTriage: () => workItemDependencies.triage,
  requireTeamAccess: requireTriageTeamAccess,
  requireWorkItemAccess: requireTriageWorkItemAccess,
  readJson,
  validateBulkAction: validateTriageBulkAction,
  prepareManualHandoff: prepareTriageManualHandoff,
  validateConfiguration: validateTriageConfigurationReferences,
  applyAction: applyTriageRouteAction,
  applyBulkAction: applyTriageBulkRouteAction,
  mapError: toTriageErrorResponse,
}))

/** Workspace admin が explicit triage transition または Work Item conversion を実行します。 */
routeApp.post('/api/request-submissions/:submissionId/actions', async (c) => {
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
      const submission = await workItemDependencies.requestIntake.getSubmission(
        principal.directoryId,
        submissionId,
      )
      const triageEntry = await readLegacyConversionTriageEntry(
        principal.directoryId,
        submission.routingTarget.teamId,
        createFormTriageEntryId(submissionId),
      )
      const triageContribution = triageEntry
        ? await createLegacyRequestTriageContribution(
            c,
            principal,
            submission,
            triageEntry,
            body,
          )
        : undefined
      if (triageContribution?.replayed) return c.json(submission)
      return c.json(await workItemDependencies.requestIntake.applyAction(
        principal.directoryId,
        submissionId,
        { id: principal.userKey },
        body,
        triageContribution?.contribution.transactItems,
      ))
    }
    const submission = await workItemDependencies.requestIntake.getSubmission(principal.directoryId, submissionId)
    if (submission.status === 'converted' && submission.workItem) {
      await repairConvertedRequestTriageProjection(c, principal, submission)
      return c.json(submission)
    }
    const conversion = createRequestWorkItemInput(submission, body)
    const teamContext = await requireTeamPermission(principal, conversion.target.teamId, 'member')
    requireAssignedProjectPermission(
      principal,
      teamContext,
      conversion.target.projectId,
      'member',
    )
    await validateRequestRoutingTarget(principal.directoryId, conversion.target)
    const triageEntryId = createFormTriageEntryId(submissionId)
    const triageEntry = await readLegacyConversionTriageEntry(
      principal.directoryId,
      submission.routingTarget.teamId,
      triageEntryId,
    )
    if (triageEntry && conversion.target.teamId !== triageEntry.teamId) {
      throw new RequestIntakeError(
        409,
        'RequestTriageTeamConflict',
        'A Triage-backed Request must be accepted in its current Team.',
      )
    }
    if (triageEntry && triageEntry.state !== 'pending' && triageEntry.state !== 'needs-information' &&
      triageEntry.state !== 'snoozed') {
      throw new RequestIntakeError(
        409,
        'RequestTriageStateConflict',
        'The corresponding Triage entry is already resolved.',
      )
    }
    const triageAction: AcceptCreateTriageAction | undefined = triageEntry
      ? {
          action: 'accept',
          mode: 'create',
          expectedRevision: triageEntry.revision,
        }
      : undefined
    const triageIdempotency = triageAction
      ? {
          key: c.req.header('Idempotency-Key')?.trim() ||
            `request-conversion:${submissionId}:${body.expectedRevision}`,
          fingerprint: createTriageInputFingerprint({
            workspaceId: principal.directoryId,
            teamId: conversion.target.teamId,
            entryId: triageEntryId,
            action: triageAction,
          }),
        }
      : undefined
    const deterministicIssueId = triageEntry
      ? createDeterministicTriageWorkItemId(
          principal.directoryId,
          conversion.target.teamId,
          triageEntry.id,
        )
      : undefined
    const normalized = normalizeTeamIssueInput({
      ...conversion.input,
      ...(deterministicIssueId && triageIdempotency
        ? {
            idempotentIssueId: deterministicIssueId,
            idempotentRequestDigest: triageIdempotency.fingerprint,
          }
        : {}),
    }, teamContext.team)
    const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
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
    const triageOccurredAt = triageEntry && triageAction && triageIdempotency && deterministicIssueId
      ? new Date().toISOString()
      : undefined
    const triageAcceptance = triageEntry && triageAction && triageIdempotency &&
      deterministicIssueId && triageOccurredAt
      ? createTriageAcceptanceTransactionItems({
          tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
          entry: triageEntry,
          action: triageAction,
          canonicalWorkItem: {
            teamId: conversion.target.teamId,
            workItemId: deterministicIssueId,
            ...(conversion.target.projectId
              ? { projectId: conversion.target.projectId }
              : {}),
          },
          actorId: principal.userKey,
          now: triageOccurredAt,
          idempotency: triageIdempotency,
        })
      : undefined
    const created = await hydrateCreateTeamIssueResponse(await workItemDependencies.teamIssues.createTeamIssue(
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
      triageAcceptance && triageOccurredAt
        ? {
            entryId: triageAcceptance.entry.id,
            occurredAt: triageOccurredAt,
            transactItems: triageAcceptance.transactItems,
          }
        : undefined,
    ))
    await projectWorkItemSearchDocumentBestEffort(
      principal.directoryId,
      created.issue,
      'Request conversion',
      [],
    )
    return c.json(await workItemDependencies.requestIntake.completeConversion(
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

routeApp.route('/', createWorkItemConfigurationRouter<WorkspacePrincipal>({
  getWorkItemConfigurations: () => workItemDependencies.workItemConfigurations,
  readBearerAccessToken,
  authenticate: async (accessToken, context) =>
    await authenticateWorkspacePrincipal(accessToken, undefined, context),
  requireWorkspaceAdministration,
  requireWorkspaceBusinessWrite,
  requireTeamPermission: async (principal, teamId, minimum) => {
    await requireTeamPermission(principal, teamId, minimum)
  },
  requireTeamConfigurationAdministration,
  readJson,
  validateConfiguration: validateWorkItemConfiguration,
  validateReferences: validateWorkItemConfigurationReferences,
  validateUsage: validateWorkItemConfigurationUsage,
  mapError: toWorkItemConfigurationErrorResponse,
}))

/** 同一 Team 内の Work Item 間へ reciprocal relation を作成します。 */
routeApp.post('/api/teams/:teamId/issues/:issueId/relations', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
    const response = await workItemDependencies.workItemConfigurations.createRelation(
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
routeApp.delete('/api/teams/:teamId/issues/:issueId/relations/:targetWorkItemId/:relationType', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const body = await readJson<Record<string, unknown>>(c.req) ?? {}
    const relationType = readWorkItemRelationType(c.req.param('relationType'))
    const expectedGraphRevision = readNonNegativeRevision(
      body.expectedGraphRevision,
      'Relation graph revision',
    )
    const endpoints = await authorizeRelationMutation(principal, teamId, issueId, targetWorkItemId)
    const response = await workItemDependencies.workItemConfigurations.deleteRelation(
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
routeApp.get('/api/work-items', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    return c.json(await hydrateWorkItemsResponse(
      await readAccessibleWorkItems(principal),
      principal.directoryId,
    ))
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
})

/** Workspace planning graph と canonical Work Item roll-up を返します。 */
routeApp.get('/api/planning', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const workItemState = await readPlanningWorkItemState(principal)
    return c.json(filterPlanningSnapshotForPrincipal(
      principal,
      await workItemDependencies.planning.get(principal.directoryId, workItemState),
    ))
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning hierarchy に entity を作成します。 */
routeApp.post('/api/planning/entities', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const input = await readPlanningJson<CreatePlanningEntityInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await requirePlanningScopePermission(principal, input, 'member')
    if (input.parentId) {
      await requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        input.parentId,
        'member',
      )
    }
    await requirePlanningActiveOwner(principal, input.ownerMemberKey)
    const response = await workItemDependencies.planning.create(principal.directoryId, input, workItemState)
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning), 201)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity の editable fields を更新します。 */
routeApp.patch('/api/planning/entities/:entityId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
    const input = await readPlanningJson<UpdatePlanningEntityInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'member')
    if (isRecord(input.patch) && input.patch.ownerMemberKey !== undefined) {
      await requirePlanningActiveOwner(principal, input.patch.ownerMemberKey)
    }
    const response = await workItemDependencies.planning.update(principal.directoryId, entityId, input, workItemState)
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity を soft archive します。 */
routeApp.post('/api/planning/entities/:entityId/archive', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
    const input = await readPlanningJson<PlanningRevisionInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'manager')
    const response = await workItemDependencies.planning.archive(principal.directoryId, entityId, input, workItemState)
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity を link や dependency を持たない新規 entity として複製します。 */
routeApp.post('/api/planning/entities/:entityId/duplicate', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
    const input = await readPlanningJson<DuplicatePlanningEntityInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    const source = await requirePlanningEntityPermission(
      principal,
      snapshot.entities,
      entityId,
      'member',
    )
    await requirePlanningActiveOwner(principal, source.ownerMemberKey)
    const effectiveParentId = input.parentId === undefined ? source.parentId : input.parentId
    if (effectiveParentId) {
      await requirePlanningEntityPermission(
        principal,
        snapshot.entities,
        effectiveParentId,
        'member',
      )
    }
    const response = await workItemDependencies.planning.duplicate(principal.directoryId, entityId, input, workItemState)
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning), 201)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity の hierarchy / Team / Project scope を移動します。 */
routeApp.post('/api/planning/entities/:entityId/move', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
    const input = await readPlanningJson<MovePlanningEntityInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
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
    const response = await workItemDependencies.planning.move(principal.directoryId, entityId, input, workItemState)
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity に member authored status update を追記します。 */
routeApp.post('/api/planning/entities/:entityId/status-updates', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const entityId = readPlanningRouteId(c.req.param('entityId'), 'Planning entity ID')
    const input = await readPlanningJson<PlanningStatusUpdateInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await requirePlanningEntityPermission(principal, snapshot.entities, entityId, 'member')
    const response = await workItemDependencies.planning.addStatusUpdate(
      principal.directoryId,
      entityId,
      input,
      principal.userKey,
      workItemState,
    )
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning), 201)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning entity 間に directed dependency を作成します。 */
routeApp.post('/api/planning/dependencies', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const input = await readPlanningJson<CreatePlanningDependencyInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
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
    const response = await workItemDependencies.planning.createDependency(principal.directoryId, input, workItemState)
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning), 201)
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Planning dependency を削除します。 */
routeApp.delete('/api/planning/dependencies/:dependencyId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const dependencyId = readPlanningRouteId(c.req.param('dependencyId'), 'Dependency ID')
    const input = await readPlanningJson<PlanningRevisionInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
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
    const response = await workItemDependencies.planning.deleteDependency(
      principal.directoryId,
      dependencyId,
      input,
      workItemState,
    )
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Creates one canonical schedule dependency between authorized Work Item endpoints. */
routeApp.post('/api/planning/work-item-dependencies', async (c) => {
  const accessToken = readBearerAccessToken(c)
  let reservationToRelease: ReleaseIdempotencyRequest | undefined
  let mutationCommitted = false
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const idempotencyKey = readRequiredPlanningWorkItemDependencyIdempotencyKey(
      c.req.header('Idempotency-Key'),
    )
    const input = await readPlanningJson<CreateWorkItemScheduleDependencyInput>(c.req)
    const dependencyId = readPlanningIdentifier(input.id, 'Work Item dependency ID')
    const predecessor = readPlanningWorkItemDependencyEndpoint(
      input.predecessor,
      'Predecessor',
    )
    const successor = readPlanningWorkItemDependencyEndpoint(input.successor, 'Successor')
    const reservationRequest = createPlanningWorkItemDependencyReservationRequest(
      principal,
      idempotencyKey,
      c.req.method,
      '/api/planning/work-item-dependencies',
      input,
    )
    const reservation = await reservePlanningWorkItemDependencyMutation(reservationRequest)
    if (reservation.status === 'in-progress') {
      throw new PlanningError(
        409,
        'PlanningWorkItemDependencyIdempotencyInProgress',
        'The same Work Item dependency mutation is still in progress.',
      )
    }
    if (reservation.status === 'replay') {
      const replay = readStoredPlanningWorkItemDependencyMutationReceipt(
        reservation.response,
        reservationRequest.workspaceId,
        'create',
        dependencyId,
      )
      const planning = await readPlanningWorkItemDependencyReplaySnapshot(
        principal,
        replay.dependency,
        'create',
        replay.revision,
      )
      c.header('Idempotency-Replayed', 'true')
      return c.json(planning, replay.status)
    }
    reservationToRelease = {
      ...reservationRequest,
      reservationId: reservation.reservationId,
    }
    const transaction = createPlanningWorkItemDependencyIdempotencyTransaction(
      reservationRequest.workspaceId,
      {
        credentialId: reservationRequest.credentialId,
        idempotencyKey,
        requestFingerprint: reservationRequest.requestFingerprint,
        reservationId: reservation.reservationId,
      },
      'create',
      dependencyId,
    )
    if (!transaction) throw planningWorkItemDependencyIdempotencyUnavailable()
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    await Promise.all([
      requirePlanningWorkItemEndpointPermission(principal, predecessor, 'manager'),
      requirePlanningWorkItemEndpointPermission(principal, successor, 'manager'),
    ])
    const response = await workItemDependencies.planning.createWorkItemDependency(
      principal.directoryId,
      {
        id: dependencyId,
        predecessor,
        successor,
        type: input.type,
        lagDays: input.lagDays,
        ...(input.constraint === undefined
          ? {}
          : { constraint: input.constraint }),
        expectedRevision: input.expectedRevision,
      },
      workItemState,
      createPlanningCallerAuthorizationConditionChecks(principal),
      transaction,
    )
    mutationCommitted = true
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning), 201)
  } catch (error) {
    if (reservationToRelease && !mutationCommitted) {
      await releasePlanningWorkItemDependencyReservation(reservationToRelease)
    }
    return toPlanningErrorResponse(c, error)
  }
})

/** Updates one canonical Work Item schedule dependency after authorizing both endpoints. */
routeApp.patch('/api/planning/work-item-dependencies/:dependencyId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  let reservationToRelease: ReleaseIdempotencyRequest | undefined
  let mutationCommitted = false
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const idempotencyKey = readRequiredPlanningWorkItemDependencyIdempotencyKey(
      c.req.header('Idempotency-Key'),
    )
    const dependencyId = readPlanningRouteId(
      c.req.param('dependencyId'),
      'Work Item dependency ID',
    )
    const input = await readPlanningJson<UpdateWorkItemScheduleDependencyInput>(c.req)
    const canonicalPath = `/api/planning/work-item-dependencies/${dependencyId}`
    const reservationRequest = createPlanningWorkItemDependencyReservationRequest(
      principal,
      idempotencyKey,
      c.req.method,
      canonicalPath,
      input,
    )
    const reservation = await reservePlanningWorkItemDependencyMutation(reservationRequest)
    if (reservation.status === 'in-progress') {
      throw new PlanningError(
        409,
        'PlanningWorkItemDependencyIdempotencyInProgress',
        'The same Work Item dependency mutation is still in progress.',
      )
    }
    if (reservation.status === 'replay') {
      const replay = readStoredPlanningWorkItemDependencyMutationReceipt(
        reservation.response,
        reservationRequest.workspaceId,
        'update',
        dependencyId,
      )
      const planning = await readPlanningWorkItemDependencyReplaySnapshot(
        principal,
        replay.dependency,
        'update',
        replay.revision,
      )
      c.header('Idempotency-Replayed', 'true')
      return c.json(planning, replay.status)
    }
    reservationToRelease = {
      ...reservationRequest,
      reservationId: reservation.reservationId,
    }
    const transaction = createPlanningWorkItemDependencyIdempotencyTransaction(
      reservationRequest.workspaceId,
      {
        credentialId: reservationRequest.credentialId,
        idempotencyKey,
        requestFingerprint: reservationRequest.requestFingerprint,
        reservationId: reservation.reservationId,
      },
      'update',
      dependencyId,
    )
    if (!transaction) throw planningWorkItemDependencyIdempotencyUnavailable()
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = filterPlanningSnapshotForPrincipal(
      principal,
      await workItemDependencies.planning.get(principal.directoryId, workItemState),
    )
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    const dependency = snapshot.workItemDependencies.find((candidate) =>
      candidate.id === dependencyId
    )
    if (!dependency) {
      throw new PlanningError(
        404,
        'PlanningWorkItemDependencyNotFound',
        'Work Item dependency was not found.',
      )
    }
    await Promise.all([
      requirePlanningWorkItemEndpointPermission(principal, dependency.predecessor, 'manager'),
      requirePlanningWorkItemEndpointPermission(principal, dependency.successor, 'manager'),
    ])
    const response = await workItemDependencies.planning.updateWorkItemDependency(
      principal.directoryId,
      dependencyId,
      input,
      workItemState,
      createPlanningCallerAuthorizationConditionChecks(principal),
      transaction,
    )
    mutationCommitted = true
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
  } catch (error) {
    if (reservationToRelease && !mutationCommitted) {
      await releasePlanningWorkItemDependencyReservation(reservationToRelease)
    }
    return toPlanningErrorResponse(c, error)
  }
})

/** Deletes one canonical Work Item schedule dependency after authorizing both endpoints. */
routeApp.delete('/api/planning/work-item-dependencies/:dependencyId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  let reservationToRelease: ReleaseIdempotencyRequest | undefined
  let mutationCommitted = false
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const idempotencyKey = readRequiredPlanningWorkItemDependencyIdempotencyKey(
      c.req.header('Idempotency-Key'),
    )
    const dependencyId = readPlanningRouteId(
      c.req.param('dependencyId'),
      'Work Item dependency ID',
    )
    const input = await readPlanningJson<PlanningRevisionInput>(c.req)
    const canonicalPath = `/api/planning/work-item-dependencies/${dependencyId}`
    const reservationRequest = createPlanningWorkItemDependencyReservationRequest(
      principal,
      idempotencyKey,
      c.req.method,
      canonicalPath,
      input,
    )
    const reservation = await reservePlanningWorkItemDependencyMutation(reservationRequest)
    if (reservation.status === 'in-progress') {
      throw new PlanningError(
        409,
        'PlanningWorkItemDependencyIdempotencyInProgress',
        'The same Work Item dependency mutation is still in progress.',
      )
    }
    if (reservation.status === 'replay') {
      const replay = readStoredPlanningWorkItemDependencyMutationReceipt(
        reservation.response,
        reservationRequest.workspaceId,
        'delete',
        dependencyId,
      )
      const planning = await readPlanningWorkItemDependencyReplaySnapshot(
        principal,
        replay.dependency,
        'delete',
        replay.revision,
      )
      c.header('Idempotency-Replayed', 'true')
      return c.json(planning, replay.status)
    }
    reservationToRelease = {
      ...reservationRequest,
      reservationId: reservation.reservationId,
    }
    const transaction = createPlanningWorkItemDependencyIdempotencyTransaction(
      reservationRequest.workspaceId,
      {
        credentialId: reservationRequest.credentialId,
        idempotencyKey,
        requestFingerprint: reservationRequest.requestFingerprint,
        reservationId: reservation.reservationId,
      },
      'delete',
      dependencyId,
    )
    if (!transaction) throw planningWorkItemDependencyIdempotencyUnavailable()
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = filterPlanningSnapshotForPrincipal(
      principal,
      await workItemDependencies.planning.get(principal.directoryId, workItemState),
    )
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    const dependency = snapshot.workItemDependencies.find((candidate) =>
      candidate.id === dependencyId
    )
    if (!dependency) {
      throw new PlanningError(
        404,
        'PlanningWorkItemDependencyNotFound',
        'Work Item dependency was not found.',
      )
    }
    await Promise.all([
      requirePlanningWorkItemEndpointPermission(principal, dependency.predecessor, 'manager'),
      requirePlanningWorkItemEndpointPermission(principal, dependency.successor, 'manager'),
    ])
    const response = await workItemDependencies.planning.deleteWorkItemDependency(
      principal.directoryId,
      dependencyId,
      input,
      workItemState,
      createPlanningCallerAuthorizationConditionChecks(principal),
      transaction,
    )
    mutationCommitted = true
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
  } catch (error) {
    if (reservationToRelease && !mutationCommitted) {
      await releasePlanningWorkItemDependencyReservation(reservationToRelease)
    }
    return toPlanningErrorResponse(c, error)
  }
})

/** Canonical Work Item と Cycle / Milestone / Goal の link を作成または置換します。 */
routeApp.put('/api/planning/work-item-links/:teamId/:workItemId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
    requirePlanningAuthorizationRevision(snapshot.revision, input.expectedRevision)
    const current = await workItemDependencies.planning.getWorkItemLinkForAuthorization(
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
    const response = await workItemDependencies.planning.putWorkItemLink(principal.directoryId, input, workItemState)
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Canonical Work Item の Planning link を削除します。 */
routeApp.delete('/api/planning/work-item-links/:teamId/:workItemId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const teamId = readPlanningRouteId(c.req.param('teamId'), 'Team ID')
    const workItemId = readPlanningRouteId(c.req.param('workItemId'), 'Work Item ID')
    const input = await readPlanningJson<PlanningRevisionInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
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
    const response = await workItemDependencies.planning.deleteWorkItemLink(
      principal.directoryId,
      teamId,
      workItemId,
      input,
      workItemState,
    )
    return c.json(filterPlanningSnapshotForPrincipal(principal, response.planning))
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/** Cycle を完了し、未完了 Work Item を設定済み policy で rollover します。 */
routeApp.post('/api/planning/cycles/:cycleId/rollover', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const cycleId = readPlanningRouteId(c.req.param('cycleId'), 'Cycle ID')
    const input = await readPlanningJson<CycleRolloverInput>(c.req)
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
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
    const response = await workItemDependencies.planning.rolloverCycle(
      principal.directoryId,
      cycleId,
      input,
      workItemState,
    )
    return c.json({
      ...response,
      planning: filterPlanningSnapshotForPrincipal(principal, response.planning),
    })
  } catch (error) {
    return toPlanningErrorResponse(c, error)
  }
})

/**
 * Workspace 全体の search index を複合 filter と cursor 付きで検索します。
 */
routeApp.get('/api/search', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const context = await createWorkspaceSearchContext(principal)
    const filters = readWorkspaceSearchFilters(c.req.query('filters'))
    const scopeCache = new Map<string, Promise<TeamIssueDetailResponse | undefined>>()
    const documentSearchReadContext =
      createDocumentSearchAccessReadContext()

    return c.json(await workItemDependencies.workspaceSearch.search({
      workspaceId: principal.directoryId,
      filters,
      limit: readOptionalPositiveQueryInteger(c.req.query('limit'), 'Search limit'),
      cursor: c.req.query('cursor'),
      access: context.searchAccess,
      resolveCurrentScope: (document) => {
        if (
          filters.entityTypes?.length &&
          !filters.entityTypes.includes(document.entityType)
        ) {
          return Promise.resolve(undefined)
        }
        return resolveCurrentWorkspaceSearchScope(
          principal.directoryId,
          document,
          context,
          scopeCache,
          documentSearchReadContext,
        )
      },
    }))
  } catch (error) {
    return toWorkspaceSearchErrorResponse(c, error)
  }
})

/** Current user が参照できる personal/team/shared saved views を返します。 */
routeApp.get('/api/saved-views', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const context = await createWorkspaceSearchContext(principal)
    return c.json(await workItemDependencies.workspaceSearch.listSavedViews({
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
routeApp.post('/api/saved-views', async (c) => {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const context = await createWorkspaceSearchContext(principal)
    const input = await readJson<CreateSavedWorkspaceViewInput>(c.req)
    return c.json(await workItemDependencies.workspaceSearch.createSavedView({
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
routeApp.patch('/api/saved-views/:viewId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const viewId = c.req.param('viewId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const context = await createWorkspaceSearchContext(principal)
    const input = await readJson<UpdateSavedWorkspaceViewInput>(c.req)
    return c.json(await workItemDependencies.workspaceSearch.updateSavedView({
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
routeApp.delete('/api/saved-views/:viewId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const viewId = c.req.param('viewId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const context = await createWorkspaceSearchContext(principal)
    return c.json(await workItemDependencies.workspaceSearch.deleteSavedView({
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
routeApp.get('/api/projects/:projectId/tasks', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    await requireProjectPermission(principal, projectId, 'viewer')

    return c.json(await hydrateProjectTasksResponse(
      await workItemDependencies.projectTasks.getProjectTasks(principal.directoryId, projectId),
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
routeApp.get('/api/projects/:projectId/users', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
routeApp.get('/api/projects/:projectId/members', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    await requireProjectPermission(principal, projectId, 'member')

    return c.json(
      await hydrateProjectMembersResponse(
        await workspaceDependencies.projectDirectory.getProjectMembers(principal.directoryId, projectId),
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
routeApp.patch('/api/projects/:projectId/members/:memberKey', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    await requireProjectPermission(principal, projectId, 'manager')
    const body = await readJson<UpdateProjectMemberRequestBody>(c.req)
    const profile = await authenticationDependencies.cognito.getUserProfile(memberKey)
    const workspaceMember = await workspaceDependencies.workspaceAccess.getActiveMember(principal.directoryId, profile.id)

    if (!workspaceMember) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceMemberInactive',
        'Only active Workspace members can be assigned to a project.',
      )
    }

    return c.json(
      await hydrateProjectMemberUpdateResponse(
        await workspaceDependencies.projectDirectory.updateProjectMember(
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
routeApp.delete('/api/projects/:projectId/members/:memberKey', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    await requireProjectPermission(principal, projectId, 'manager')
    const targetWorkspaceMember = await workspaceDependencies.workspaceAccess.getMember(
      principal.directoryId,
      memberKey,
    )

    return c.json(
      await workspaceDependencies.projectDirectory.removeProjectMember(
        principal.directoryId,
        projectId,
        memberKey,
        createApiMutationContext(c, principal, { projectId, memberKey }),
        targetWorkspaceMember === undefined
          ? { exists: false }
          : {
              exists: true,
              version: targetWorkspaceMember.version,
              status: targetWorkspaceMember.status,
            },
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
routeApp.get('/api/teams/:teamId/issues', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
routeApp.post('/api/teams/:teamId/issues', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!teamId) {
    return c.json({ message: 'Team ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const context = await requireTeamPermission(principal, teamId, 'member')
    const requestBody = await readJson<CreateTeamIssueRequestBody>(c.req)
    if (!requestBody) {
      throw new ProjectDataError(400, 'InvalidProjectWrite', 'Work Item body is required.')
    }
    rejectInternalWorkItemCreateFields(requestBody)
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
    const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
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
      await workItemDependencies.teamIssues.createTeamIssue(
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
routeApp.get('/api/teams/:teamId/issues/:issueId/activity', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const context = await requireTeamPermission(principal, teamId, 'viewer')
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      teamId,
      issueId,
      { consistentIssueRead: true },
    )
    requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'viewer')

    const page = await workspaceDependencies.auditEvents.query(
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
routeApp.get('/api/teams/:teamId/issues/:issueId', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const context = await requireTeamPermission(principal, teamId, 'viewer')

    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
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
      workItemDependencies.collaboration.getThread({
        entityKey,
        viewerMemberKey: principal.userKey,
        projectEntityKey,
        limit: 50,
        includeScopeState: false,
      }),
      workItemDependencies.workItemConfigurations.getTeamConfiguration(principal.directoryId, teamId),
      workItemDependencies.workItemConfigurations.listRelations(principal.directoryId, teamId, issueId),
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
 * Validates a Work Item schedule operation and returns its impact before mutation.
 */
routeApp.post('/api/teams/:teamId/issues/:issueId/schedule/preview', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const context = await requireTeamPermission(principal, teamId, 'member')
    const body = await readJson<Record<string, unknown>>(c.req) ?? {}
    const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
    const operation = normalizeWorkItemScheduleOperation(body.operation)
    const [detail, relationPage] = await Promise.all([
      workItemDependencies.teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        issueId,
        { consistentIssueRead: true, eventLimit: 0 },
      ),
      workItemDependencies.workItemConfigurations.listRelations(
        principal.directoryId,
        teamId,
        issueId,
      ),
    ])
    requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'member')
    if (detail.issue.revision !== expectedRevision) {
      throw new ProjectDataError(
        409,
        'WorkItemRevisionConflict',
        'Work Item changed. Reload and try again.',
      )
    }

    const visibleRelations = await filterVisibleWorkItemRelations(
      principal,
      context,
      teamId,
      relationPage.relations,
    )
    const recomputed = await recomputeWorkItemScheduleDependencyPreview(
      principal,
      detail.issue,
      operation,
      relationPage.graphRevision,
      visibleRelations.filter((relation) =>
        relation.sourceWorkItemId === issueId &&
        (relation.type === 'blocks' || relation.type === 'blockedBy')
      ).length,
      'viewer',
    )
    return c.json(recomputed.preview)
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
})

/**
 * Recomputes and atomically persists an explicitly confirmed schedule dependency cascade.
 */
routeApp.post('/api/teams/:teamId/issues/:issueId/schedule/confirm', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const context = await requireTeamPermission(principal, teamId, 'member')
    const idempotencyKey = readRequiredWorkItemScheduleIdempotencyKey(
      c.req.header('Idempotency-Key'),
    )
    const body = await readJson<Record<string, unknown>>(c.req) ?? {}
    if (body.confirmed !== true) {
      throw new WorkItemScheduleError(
        400,
        'WorkItemScheduleConfirmationRequired',
        'Schedule dependency changes require explicit confirmation.',
      )
    }
    const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
    const expectedPlanningRevision = readWorkItemScheduleGraphRevision(
      body.expectedPlanningRevision,
      'Planning revision',
    )
    const expectedRelationGraphRevision = readWorkItemScheduleGraphRevision(
      body.expectedRelationGraphRevision,
      'Relation graph revision',
    )
    const expectedEvaluatedRevisions = readWorkItemScheduleEvaluationRevisions(
      body.expectedEvaluatedRevisions,
    )
    const expectedImpacts = readWorkItemScheduleImpacts(body.expectedImpacts)
    const operation = normalizeWorkItemScheduleOperation(body.operation)
    const reservationRequest: ReserveIdempotencyRequest = {
      workspaceId: createWorkItemScheduleIdempotencyWorkspaceId(principal.directoryId),
      credentialId: createWorkItemScheduleIdempotencyUserId(
        principal.directoryId,
        principal.actorId,
      ),
      idempotencyKey,
      requestFingerprint: createWorkItemScheduleConfirmationFingerprint(
        c.req.method,
        new URL(c.req.url).pathname,
        body,
      ),
    }
    const response = await executeConfirmedWorkItemScheduleChange(
      c,
      principal,
      context,
      body,
      {
        teamId,
        workItemId: issueId,
        expectedRevision,
        expectedPlanningRevision,
        expectedRelationGraphRevision,
        expectedEvaluatedRevisions,
        expectedImpacts,
        operation,
        reservationRequest,
      },
    )
    return c.json(response)
  } catch (error) {
    return toWorkItemConfigurationErrorResponse(c, error)
  }
})

/**
 * DynamoDB に保存されたチーム所有 Issue を更新する endpoint です。
 */
routeApp.patch('/api/teams/:teamId/issues/:issueId', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const context = await requireTeamPermission(principal, teamId, 'member')
    const input = await readJson<PublicUpdateTeamIssueRequestBody>(c.req) ?? {}
    rejectInternalWorkItemUpdateFields(input)
    const body = normalizeTeamIssueInput(
      input,
      context.team,
    )
    const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
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

    const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
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

    let authorizationSnapshot: WorkItemAuthorizationSnapshot | undefined
    const changesSchedule =
      'schedule' in configuredBody &&
      configuredBody.schedule !== undefined &&
      stableDigestStringify(configuredBody.schedule) !==
        stableDigestStringify(detail.issue.schedule)
    const changesAssignedProject =
      'assignedProjectId' in configuredBody &&
      readAssignedProjectId(configuredBody.assignedProjectId) !== detail.issue.assignedProjectId
    if (changesSchedule) {
      try {
        authorizationSnapshot = await createDependencyFencedWorkItemAuthorizationSnapshot(
          principal,
          teamId,
          issueId,
        )
      } catch (error) {
        if (
          error instanceof PlanningError &&
          error.code === 'PlanningWorkItemDependencyInUse'
        ) {
          throw new WorkItemScheduleError(
            409,
            'WorkItemScheduleConfirmationRequired',
            'Preview and explicitly confirm schedule changes for Work Items with dependencies.',
          )
        }
        if (error instanceof PlanningError) {
          throw new WorkItemScheduleError(error.status, error.code, error.message)
        }
        throw error
      }
    } else if (changesAssignedProject) {
      authorizationSnapshot = await createPlanningFencedWorkItemAuthorizationSnapshot(principal)
    }

    if ('assigneeUserId' in configuredBody) {
      await requireActiveWorkspaceAssignee(
        principal.directoryId,
        readTeamIssueAssigneeUserId(configuredBody),
      )
    }

    const response = await hydrateUpdateTeamIssueResponse(
      await workItemDependencies.teamIssues.updateTeamIssue(
        principal.directoryId,
        teamId,
        issueId,
        {
          ...configuredBody,
          expectedRevision,
          ...(authorizationSnapshot ? { authorizationSnapshot } : {}),
        },
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
routeApp.get('/api/teams/:teamId/issues/:issueId/collaboration', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
      const replies = await workItemDependencies.collaboration.getThread({
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

    const roots = await workItemDependencies.collaboration.getThread({
      entityKey,
      viewerMemberKey: principal.userKey,
      projectEntityKey,
      cursor: isLegacyPage ? undefined : requestedCursor,
      limit: isLegacyPage ? 1 : limit === undefined ? 10 : Math.min(limit, 20),
    })
    const replyPages = await Promise.all(
      (isLegacyPage ? [] : roots.comments).map((root) => workItemDependencies.collaboration.getThread({
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
      ? await workItemDependencies.teamIssues.getTeamIssueDetail(
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
routeApp.post('/api/teams/:teamId/issues/:issueId/comments', async (c) => {
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
    const comment = await workItemDependencies.collaboration.createComment({
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
routeApp.patch('/api/teams/:teamId/issues/:issueId/comments/:commentId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')
  const commentId = c.req.param('commentId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
    const comment = await workItemDependencies.collaboration.updateComment({
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
routeApp.delete('/api/teams/:teamId/issues/:issueId/comments/:commentId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')
  const commentId = c.req.param('commentId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceBusinessWrite(principal)
    const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    const body = await readJson<VersionedTeamIssueCommentRequestBody>(c.req) ?? {}
    const canModerate = canManageTeamIssueCollaboration(
      principal,
      context,
      detail.issue.assignedProjectId,
    )
    const comment = await workItemDependencies.collaboration.deleteComment({
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
  routeApp.post(`/api/teams/:teamId/issues/:issueId/comments/:commentId/${resolutionAction}`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')
    const commentId = c.req.param('commentId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
        ? await workItemDependencies.collaboration.resolveComment(mutationInput)
        : await workItemDependencies.collaboration.reopenComment(mutationInput)

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
  routeApp.on(reactionMethod, '/api/teams/:teamId/issues/:issueId/comments/:commentId/reactions/:emoji', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')
    const commentId = c.req.param('commentId')
    const emoji = c.req.param('emoji')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
        await workItemDependencies.collaboration.addReaction(mutationInput)
      } else {
        await workItemDependencies.collaboration.removeReaction(mutationInput)
      }

      return c.json({})
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })
}

/** 現在 user の Work Item watcher state を返します。 */
routeApp.get('/api/teams/:teamId/issues/:issueId/watch', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    const watch = await workItemDependencies.collaboration.getWatcherState({
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
  routeApp.on(watchMethod, '/api/teams/:teamId/issues/:issueId/watch', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
        ? await workItemDependencies.collaboration.subscribe(mutationInput)
        : await workItemDependencies.collaboration.unsubscribe(mutationInput)
      return c.json({ watch })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })
}

/** Work Item presence/typing heartbeat を更新します。 */
routeApp.put('/api/teams/:teamId/issues/:issueId/presence', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    const body = await readJson<TeamIssuePresenceRequestBody>(c.req) ?? {}
    const typing = readPresenceTyping(body.typing)

    if (typing && !canWriteTeamIssue(principal, context, detail.issue.assignedProjectId)) {
      throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'Comment permission is required.')
    }

    await workItemDependencies.collaboration.heartbeatPresence({
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
routeApp.delete('/api/teams/:teamId/issues/:issueId/presence/:clientId', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const teamId = c.req.param('teamId')
  const issueId = c.req.param('issueId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
    await workItemDependencies.collaboration.leavePresence({
      entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
      memberKey: principal.userKey,
      clientId: readPresenceClientId(c.req.param('clientId')),
    })
    return c.json({})
  } catch (error) {
    return toCollaborationErrorResponse(c, error)
  }
})

routeApp.route('/', createRealtimeTicketRouter<WorkspacePrincipal>({
  authenticate: async (accessToken, context) =>
    await authenticateWorkspacePrincipal(accessToken, undefined, context),
  issueTicket: async ({ accessToken, principal, teamId, issueId, context }) => {
    const permissionContext = await requireTeamPermission(principal, teamId, 'viewer')
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(principal.directoryId, teamId, issueId)
    requireAssignedProjectPermission(
      principal,
      permissionContext,
      detail.issue.assignedProjectId,
      'viewer',
    )
    const tokenClaims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
    const issuedAt = readNumericClaim(tokenClaims?.iat) ?? Math.floor(Date.now() / 1_000)
    const authenticatedAt = readNumericClaim(tokenClaims?.auth_time) ?? issuedAt
    const tokenExpiresAt = readNumericClaim(tokenClaims?.exp) ?? issuedAt + 60 * 60
    const verifiedAuthenticationMethods =
      await workspaceDependencies.enterpriseSessionActivity.getAuthenticationMethods(
        principal.directoryId,
        createHash('sha256').update(accessToken).digest('base64url'),
      )

    return await workItemDependencies.realtimeTickets.createTicket({
      workspaceId: principal.directoryId,
      memberKey: principal.userKey,
      teamId,
      issueId,
      projectId: detail.issue.assignedProjectId,
      systemAdmin: principal.isSystemAdmin,
      canWrite: canWriteTeamIssue(
        principal,
        permissionContext,
        detail.issue.assignedProjectId,
      ),
      scopeKey: createWorkItemCollaborationEntityKey(
        principal.directoryId,
        teamId,
        issueId,
      ),
      authenticatedAt,
      tokenExpiresAt,
      authenticationSessionId: createEnterpriseAuthenticationSessionId(accessToken),
      authenticationMethods: [
        ...new Set([
          ...readCognitoAuthenticationMethods(tokenClaims),
          ...verifiedAuthenticationMethods,
        ]),
      ],
      clientIp: resolveEnterpriseClientIp(context),
    })
  },
  mapError: (context, error) => {
    if (error instanceof CognitoServiceError) {
      return toCognitoDirectoryErrorResponse(context, error)
    }

    return toProjectDataErrorResponse(context, error)
  },
  readJson,
}))

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
  routeApp.get(fileRoute.basePath, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      return c.json(await workItemDependencies.fileProofing.list(scope, actor))
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Work Item または Project へ新規 file upload session を作成する endpoint です。 */
  routeApp.post(`${fileRoute.basePath}/uploads`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const body = await readFileProofingJson<CreateFileUploadInput>(c.req)
      return c.json(
        await workItemDependencies.fileProofing.createUpload(
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
  routeApp.post(`${fileRoute.basePath}/:fileId/versions`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const body = await readFileProofingJson<CreateFileUploadInput>(c.req)
      return c.json(
        await workItemDependencies.fileProofing.createVersionUpload(
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
  routeApp.post(`${fileRoute.basePath}/:fileId/versions/:versionId/complete`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const input = {
        fileId: readRequiredRouteId(c.req.param('fileId'), 'File ID'),
        versionId: readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
      }
      return c.json(await workItemDependencies.fileProofing.completeUpload(
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
  routeApp.get(`${fileRoute.basePath}/:fileId/versions/:versionId/access`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const disposition = c.req.query('disposition') === 'attachment' ? 'attachment' : 'inline'
      const input = {
        fileId: readRequiredRouteId(c.req.param('fileId'), 'File ID'),
        versionId: readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
        disposition,
      } as const
      return c.json(await workItemDependencies.fileProofing.createAccess(
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
  routeApp.get(`${fileRoute.basePath}/:fileId/versions/:versionId/annotations`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      return c.json({
        annotations: await workItemDependencies.fileProofing.listAnnotations(
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
  routeApp.post(`${fileRoute.basePath}/:fileId/versions/:versionId/annotations`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const body = await readFileProofingJson<CreateFileAnnotationInput>(c.req)
      return c.json({
        annotation: await workItemDependencies.fileProofing.createAnnotation(
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
  routeApp.delete(`${fileRoute.basePath}/:fileId`, async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
      const fileId = readRequiredRouteId(c.req.param('fileId'), 'File ID')
      await workItemDependencies.fileProofing.deleteFile(
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
routeApp.post('/api/teams/:teamId/issues/:issueId/comments/:commentId/files/uploads', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    const context = await loadFileProofingRequestContext(c, principal, 'work-item')
    const commentId = readRequiredRouteId(c.req.param('commentId'), 'Comment ID')
    const commentExists = await workItemDependencies.collaboration.hasAttachableComment(
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
      await workItemDependencies.fileProofing.createUpload(
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
routeApp.post('/api/teams/:teamId/issues/:issueId/approvals', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
    const collection = await workItemDependencies.fileProofing.list(scope, actor)
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
      approval: await workItemDependencies.fileProofing.createApproval(
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

/**
 * Requires every approval reviewer to be active and able to view the target Work Item.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Owning Team identifier.
 * @param assignedProjectId - Optional assigned Project identifier.
 * @param reviewerMemberKeys - Normalized reviewer member keys.
 * @param dependencies - Ports used for membership and access checks.
 * @returns Active reviewer membership records.
 */
async function requireApprovalReviewers(
  workspaceId: string,
  teamId: string,
  assignedProjectId: string | undefined,
  reviewerMemberKeys: readonly string[],
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
) {
  const directory = assignedProjectId
    ? undefined
    : await dependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja', true)
  const teamProjectIds = new Set(
    directory?.teams.find((team) => team.id === teamId)?.projects.map((project) => project.id) ?? [],
  )
  return await Promise.all(reviewerMemberKeys.map(async (memberKey) => {
    const member = await dependencies.workspaceAccess.getActiveMember(
      workspaceId,
      memberKey,
    )
    if (!member) {
      throw new FileProofingError(
        409,
        'ApprovalReviewerInactive',
        `Reviewer "${memberKey}" is not an active Workspace member.`,
      )
    }
    const reviewerIsSystemAdmin = await dependencies.cognito.isSystemAdmin(
      member.memberKey,
    )
    if (assignedProjectId && !reviewerIsSystemAdmin) {
      const projectAccess = await dependencies.projectDirectory.getProjectAccess(
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
      const projectAccesses = await dependencies.projectDirectory.getProjectAccessList(
        workspaceId,
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
}

/** Assigned reviewer の approval decision を保存する endpoint です。 */
routeApp.post('/api/teams/:teamId/issues/:issueId/approvals/:approvalId/decisions', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
    const approval = await workItemDependencies.fileProofing.decideApproval(
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
routeApp.post('/api/teams/:teamId/issues/:issueId/approvals/:approvalId/cancel', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
      approval: await workItemDependencies.fileProofing.cancelApproval(
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
routeApp.get('/api/approvals/reviewer', async (c) => {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
    const page = await workItemDependencies.fileProofing.listReviewerApprovals(
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
routeApp.get('/api/projects/:projectId/issues', async (c) => {
  const accessToken = readBearerAccessToken(c)
  const projectId = c.req.param('projectId')

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  if (!projectId) {
    return c.json({ message: 'Project ID is required.' }, 400)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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

/**
 * Parses and validates a complete quick-access replacement request.
 *
 * @param value - Unknown JSON request body.
 * @returns A normalized versioned replacement input.
 */
function readProjectQuickAccessInput(
  value: unknown,
): UpdateProjectQuickAccessPreferencesInput {
  if (!isRecord(value)) {
    throw createInvalidProjectQuickAccessInputError()
  }

  const revision = value.revision
  const candidateItems = value.items
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision >= PROJECT_QUICK_ACCESS_MAX_REVISION ||
    !isProjectQuickAccessItems(candidateItems)
  ) {
    throw createInvalidProjectQuickAccessInputError()
  }

  return {
    items: candidateItems.map(({ projectId, teamId }) => ({ projectId, teamId })),
    revision,
  }
}

/** Creates the safe 400 response error for malformed quick-access input. */
function createInvalidProjectQuickAccessInputError() {
  return new ProjectDataError(
    400,
    'InvalidProjectQuickAccessInput',
    'Project quick-access input is invalid.',
  )
}

/**
 * Lists active Team/Project identities visible to the current principal.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns Composite keys permitted in the viewer preference.
 */
async function getAuthorizedProjectQuickAccessKeys(
  principal: ProjectPrincipal,
) {
  const [directory, directProjectAccesses] = await Promise.all([
    workspaceDependencies.projectDirectory.getProjectDirectory(
      principal.directoryId,
      'ja',
      true,
    ),
    principal.isSystemAdmin || principal.enterpriseLegacyProjectAccessSuppressed
      ? Promise.resolve([])
      : workspaceDependencies.projectDirectory.getProjectAccessList(
          principal.directoryId,
          principal.userKey,
        ),
  ])
  const readableProjectAccesses = principal.isSystemAdmin
    ? undefined
    : [...directProjectAccesses, ...(principal.enterpriseProjectAccesses ?? [])]
      .filter((access) => projectAccessAllows(access, 'viewer'))
  const projectTeamCounts = new Map<string, number>()
  for (const team of directory.teams) {
    for (const project of team.projects) {
      projectTeamCounts.set(
        project.id,
        (projectTeamCounts.get(project.id) ?? 0) + 1,
      )
    }
  }

  return new Set(directory.teams.flatMap((team) =>
    team.projects.flatMap((project) =>
      readableProjectAccesses === undefined || readableProjectAccesses.some((access) =>
        access.projectId === project.id &&
        (
          access.teamId === team.id ||
          access.teamId === undefined && projectTeamCounts.get(project.id) === 1
        )
      )
        ? [createProjectQuickAccessIdentity({ projectId: project.id, teamId: team.id })]
        : [],
    )
  ))
}

/** Analytics route の JSON object body を検証します。 */
async function readAnalyticsJson(c: Context): Promise<Record<string, unknown>> {
  const value = await readJson<unknown>(c.req)
  if (!isRecord(value)) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsInput',
      'A JSON object request body is required.',
    )
  }
  return value
}

/** Executes an ad-hoc or saved Analytics query for the authenticated principal. */
async function executeAnalyticsHttpQuery(
  principal: WorkspacePrincipal,
  input: Record<string, unknown>,
) {
  const query = await resolveAnalyticsQuery(principal, input)
  return await executeAnalyticsQuery(principal, query)
}

/** Executes an Analytics evidence request for the authenticated principal. */
async function executeAnalyticsHttpEvidence(
  principal: WorkspacePrincipal,
  input: Record<string, unknown>,
) {
  return await executeAnalyticsEvidenceQuery(principal, input)
}

/** Generates a CSV or PDF Analytics export for the authenticated principal. */
async function createAnalyticsHttpExport(
  principal: WorkspacePrincipal,
  input: Record<string, unknown>,
): Promise<AnalyticsExportFile> {
  const format = readAnalyticsExportFormat(input.format)
  const locale = normalizeAnalyticsExportLocale(
    typeof input.locale === 'string' ? input.locale : undefined,
  )
  const snapshot = await resolveAnalyticsExportSnapshot(principal, input)
  return format === 'csv'
    ? {
        body: createAnalyticsCsv(snapshot, locale),
        extension: format,
        contentType: 'text/csv; charset=utf-8',
      }
    : {
        body: createAnalyticsPdf(snapshot, locale),
        extension: format,
        contentType: 'application/pdf',
      }
}

/** Lists Analytics reports visible to the authenticated principal. */
async function listAnalyticsHttpReports(
  principal: WorkspacePrincipal,
  limit: string | undefined,
  cursor: string | undefined,
) {
  const context = await createWorkspaceSearchContext(principal)
  const response = await workItemDependencies.analytics.listReports(
    principal.directoryId,
    readAnalyticsReportListLimit(limit),
    readAnalyticsReportListCursor(cursor),
  )
  return {
    reports: response.reports.filter((report) =>
      canReadAnalyticsReport(principal, context, report)
    ),
    ...(response.nextCursor === undefined
      ? {}
      : { nextCursor: response.nextCursor }),
  }
}

/** Creates an Analytics report after applying visibility authorization. */
async function createAnalyticsHttpReport(
  principal: WorkspacePrincipal,
  input: Record<string, unknown>,
) {
  requireWorkspaceBusinessWrite(principal)
  const normalized = sanitizePublicAnalyticsReportCreateInput(input)
  await requireAnalyticsVisibilityWrite(
    principal,
    normalized.visibility,
    normalized.teamId,
    principal.userKey,
  )
  return await workItemDependencies.analytics.createReport(
    principal.directoryId,
    principal.userKey,
    normalized,
  )
}

/** Updates an Analytics report after authorization and revision checks. */
async function updateAnalyticsHttpReport(
  principal: WorkspacePrincipal,
  reportIdValue: string,
  input: Record<string, unknown>,
) {
  requireWorkspaceBusinessWrite(principal)
  const reportId = readAnalyticsIdentifier(reportIdValue, 'Analytics report ID')
  const current = await requireAnalyticsReport(principal, reportId)
  await requireAnalyticsReportWrite(principal, current)
  const normalized = sanitizePublicAnalyticsReportUpdateInput(input, current)
  await requireAnalyticsVisibilityWrite(
    principal,
    normalized.visibility ?? current.visibility,
    normalized.teamId === null ? undefined : normalized.teamId ?? current.teamId,
    current.ownerMemberKey,
  )
  return await workItemDependencies.analytics.updateReport(principal.directoryId, reportId, normalized)
}

/** Deletes an Analytics report after authorization and revision checks. */
async function deleteAnalyticsHttpReport(
  principal: WorkspacePrincipal,
  reportIdValue: string,
  input: Record<string, unknown>,
) {
  requireWorkspaceBusinessWrite(principal)
  const reportId = readAnalyticsIdentifier(reportIdValue, 'Analytics report ID')
  const current = await requireAnalyticsReport(principal, reportId)
  await requireAnalyticsReportWrite(principal, current)
  const expectedRevision = readAnalyticsExpectedRevision(input.expectedRevision)
  await workItemDependencies.analytics.deleteReport(principal.directoryId, reportId, expectedRevision)
}

/** Lists report snapshots that remain visible under the current ACL. */
async function listAnalyticsHttpSnapshots(
  principal: WorkspacePrincipal,
  reportIdValue: string,
  cursor: string | undefined,
) {
  const reportId = readAnalyticsIdentifier(reportIdValue, 'Analytics report ID')
  const report = await requireAnalyticsReport(principal, reportId)
  const visibleSnapshots: AnalyticsSnapshotRecord[] = []
  const scopeCache = new Map<
    string,
    ReturnType<typeof readAccessibleAnalyticsWorkItems>
  >()
  const permissionScopeHashCache = new Map<string, Promise<string>>()
  const seenCursors = new Set<string>()
  let inspectedCount = 0
  let repositoryPageCount = 0
  let nextCursor = readAnalyticsSnapshotListCursor(cursor)
  if (nextCursor !== undefined) seenCursors.add(nextCursor)
  do {
    const pageCursor = nextCursor
    const page = await workItemDependencies.analytics.listSnapshots(
      principal.directoryId,
      report.id,
      Math.min(
        ANALYTICS_SNAPSHOT_LIST_LIMIT,
        ANALYTICS_SNAPSHOT_ACL_INSPECTION_LIMIT - inspectedCount,
      ),
      pageCursor,
    )
    repositoryPageCount += 1
    let resumeCursor = page.nextCursor
    for (const [recordIndex, record] of page.snapshots.entries()) {
      inspectedCount += 1
      const queryCacheKey = record.snapshot.queryHash
      let pendingPermissionScopeHash = permissionScopeHashCache.get(queryCacheKey)
      if (!pendingPermissionScopeHash) {
        pendingPermissionScopeHash = readCurrentAnalyticsPermissionScopeHash(
          principal,
          record.query,
          scopeCache,
        )
        permissionScopeHashCache.set(queryCacheKey, pendingPermissionScopeHash)
      }
      const currentPermissionScopeHash = await pendingPermissionScopeHash
      if (currentPermissionScopeHash === record.snapshot.permissionScopeHash) {
        visibleSnapshots.push(record)
        if (visibleSnapshots.length === ANALYTICS_SNAPSHOT_LIST_LIMIT) {
          resumeCursor = recordIndex < page.snapshots.length - 1
            ? createAnalyticsSnapshotListCursor(
                principal.directoryId,
                report.id,
                record,
              )
            : page.nextCursor
          break
        }
      }
    }
    nextCursor = resumeCursor
    if (
      nextCursor !== undefined &&
      (
        page.snapshots.length === 0 ||
        nextCursor === pageCursor ||
        seenCursors.has(nextCursor)
      )
    ) {
      throw new AnalyticsError(
        500,
        'AnalyticsSnapshotPaginationInvalid',
        'Analytics snapshot pagination did not make progress.',
      )
    }
    if (nextCursor !== undefined) seenCursors.add(nextCursor)
  } while (
    visibleSnapshots.length < ANALYTICS_SNAPSHOT_LIST_LIMIT &&
    inspectedCount < ANALYTICS_SNAPSHOT_ACL_INSPECTION_LIMIT &&
    repositoryPageCount < ANALYTICS_SNAPSHOT_REPOSITORY_PAGE_LIMIT &&
    nextCursor !== undefined
  )
  return {
    snapshots: visibleSnapshots,
    inspectedCount,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  } satisfies AnalyticsSnapshotListResponse
}

/** Creates an immutable report snapshot under the current ACL. */
async function createAnalyticsHttpSnapshot(
  principal: WorkspacePrincipal,
  reportIdValue: string,
  input: Record<string, unknown>,
  idempotencyKey: string | undefined,
) {
  requireWorkspaceBusinessWrite(principal)
  const reportId = readAnalyticsIdentifier(reportIdValue, 'Analytics report ID')
  const report = await requireAnalyticsReport(principal, reportId)
  await requireAnalyticsReportWrite(principal, report)
  const query = createAnalyticsReportQuery(report, input)
  const snapshot = await executeAnalyticsQuery(principal, query)
  const createdAt = new Date().toISOString()
  return await workItemDependencies.analytics.putSnapshot({
    id: createAnalyticsSnapshotId(
      principal.directoryId,
      report,
      snapshot,
      principal.userKey,
      idempotencyKey,
    ),
    workspaceId: principal.directoryId,
    reportId: report.id,
    reportRevision: report.revision,
    createdByMemberKey: principal.userKey,
    createdAt,
    query: structuredClone(query),
    snapshot,
  })
}

/** Public create input から server-owned schedule cursor を除外します。 */
function sanitizePublicAnalyticsReportCreateInput(
  body: Record<string, unknown>,
): CreateAnalyticsReportInput {
  return {
    ...body,
    ...(body.schedule === undefined
      ? {}
      : { schedule: stripAnalyticsScheduleCursor(body.schedule) }),
  } as unknown as CreateAnalyticsReportInput
}

/**
 * Public update input の schedule cursor を除外し、設定が不変なら current cursor を保持します。
 */
function sanitizePublicAnalyticsReportUpdateInput(
  body: Record<string, unknown>,
  current: AnalyticsReport,
): UpdateAnalyticsReportInput {
  if (!isRecord(body.schedule)) {
    return body as unknown as UpdateAnalyticsReportInput
  }
  const schedule = stripAnalyticsScheduleCursor(body.schedule)
  const currentSchedule = current.schedule
  return {
    ...body,
    schedule: currentSchedule !== undefined &&
        analyticsScheduleConfigurationKey(schedule) ===
          analyticsScheduleConfigurationKey(currentSchedule)
      ? structuredClone(currentSchedule)
      : schedule,
  } as unknown as UpdateAnalyticsReportInput
}

/** Client-controlled `nextRunAt` を schedule configuration から除きます。 */
function stripAnalyticsScheduleCursor(value: unknown) {
  if (!isRecord(value)) return value
  const { nextRunAt: _clientNextRunAt, ...schedule } = value
  return schedule
}

/** Schedule cursor を除いた semantic configuration の比較 key を返します。 */
function analyticsScheduleConfigurationKey(value: unknown) {
  if (!isRecord(value)) return JSON.stringify(value)
  const recipients = Array.isArray(value.recipientMemberKeys) &&
      value.recipientMemberKeys.every((recipient) => typeof recipient === 'string')
    ? [...new Set(value.recipientMemberKeys)].sort()
    : value.recipientMemberKeys
  return JSON.stringify({
    enabled: value.enabled,
    frequency: value.frequency,
    timeZone: value.timeZone,
    localTime: value.localTime,
    dayOfWeek: value.dayOfWeek,
    dayOfMonth: value.dayOfMonth,
    recipientMemberKeys: recipients,
    format: value.format,
  })
}

/** Ad-hoc input または saved report ID から実行 query を解決します。 */
async function resolveAnalyticsQuery(
  principal: WorkspacePrincipal,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (body.reportId === undefined) {
    return body
  }
  const reportId = readAnalyticsIdentifier(body.reportId, 'Analytics report ID')
  const report = await requireAnalyticsReport(principal, reportId)
  return createAnalyticsReportQuery(report, body)
}

/** Saved report の definition を client override から保護して query にします。 */
function createAnalyticsReportQuery(
  report: AnalyticsReport,
  overrides: Record<string, unknown>,
): AnalyticsQueryInput {
  const asOf = typeof overrides.asOf === 'string' && overrides.asOf.trim()
    ? overrides.asOf
    : new Date().toISOString()
  return {
    filter: structuredClone(report.filter),
    widgets: structuredClone(report.widgets),
    asOf,
    timeZone: report.timeZone,
    ...(report.forecastBaseline === undefined
      ? {}
      : { forecastBaseline: structuredClone(report.forecastBaseline) }),
  }
}

/** Query を事前検証し、current ACL の Work Item/event だけで snapshot を作ります。 */
async function executeAnalyticsQuery(
  principal: WorkspacePrincipal,
  query: unknown,
): Promise<AnalyticsSnapshot> {
  const normalizedQuery = normalizeAnalyticsQueryInput(query)
  const authorized = await readAuthorizedAnalyticsData(
    principal,
    normalizedQuery.filter,
    normalizedQuery.asOf,
  )
  return createAnalyticsSnapshot({ ...authorized, query: normalizedQuery })
}

/** Evidence query を事前検証し、current ACL の Work Item/event だけで再実行します。 */
async function executeAnalyticsEvidenceQuery(
  principal: WorkspacePrincipal,
  evidence: unknown,
) {
  const normalizedEvidence = normalizeAnalyticsEvidenceInput(evidence)
  const authorized = await readAuthorizedAnalyticsData(
    principal,
    normalizedEvidence.filter,
    normalizedEvidence.asOf,
  )
  return queryAnalyticsEvidence({ ...authorized, evidence: normalizedEvidence })
}

/**
 * Analytics engine へ渡す前に current Work Item ACL を確定し、対応eventだけを残します。
 */
async function readAuthorizedAnalyticsData(
  principal: WorkspacePrincipal,
  filter: AnalyticsQueryInput['filter'],
  asOf: string,
) {
  let accessible = await readAccessibleAnalyticsWorkItems(
    principal,
    filter,
  )
  const historyReadAt = new Date(
    Math.max(Date.now(), Date.parse(asOf)),
  ).toISOString()
  assertAnalyticsWorkItemsAtCutoff(accessible.workItems, historyReadAt)

  for (
    let attempt = 0;
    attempt < ANALYTICS_READ_BARRIER_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const events = await readAuthorizedAnalyticsAuditEvents(
      principal.directoryId,
      accessible.workItems,
      historyReadAt,
    )
    const verified = await readAccessibleAnalyticsWorkItems(
      principal,
      filter,
    )
    assertAnalyticsWorkItemsAtCutoff(verified.workItems, historyReadAt)

    if (
      createAnalyticsAccessibleDataFingerprint(accessible) ===
        createAnalyticsAccessibleDataFingerprint(verified) &&
      hasAnalyticsLatestAuditCoverage(verified.workItems, events)
    ) {
      return {
        workItems: verified.workItems,
        events,
        authorizedProjectIds: verified.authorizedProjectIds,
      }
    }
    accessible = verified
  }

  throw createAnalyticsReadBarrierError()
}

/** Canonical state が audit cutoff 以下であることを fail-closed に検証します。 */
function assertAnalyticsWorkItemsAtCutoff(
  workItems: readonly CanonicalWorkItem[],
  historyReadAt: string,
) {
  const cutoff = Date.parse(historyReadAt)
  if (
    Number.isNaN(cutoff) ||
    workItems.some((workItem) => {
      const updatedAt = Date.parse(workItem.updatedAt)
      return Number.isNaN(updatedAt) || updatedAt > cutoff
    })
  ) {
    throw createAnalyticsReadBarrierError()
  }
}

/** ACL allowlist と canonical Work Item 集合の順序非依存 fingerprint を返します。 */
function createAnalyticsAccessibleDataFingerprint(
  accessible: Awaited<ReturnType<typeof readAccessibleAnalyticsWorkItems>>,
) {
  const digest = createHash('sha256')
  for (const projectId of [...accessible.authorizedProjectIds].sort()) {
    digest.update(`project:${projectId}\0`)
  }
  const workItems = [...accessible.workItems].sort((left, right) =>
    createTeamIssueAuditEntityId(left.teamId, left.id).localeCompare(
      createTeamIssueAuditEntityId(right.teamId, right.id),
    )
  )
  for (const workItem of workItems) {
    digest.update(stableAnalyticsApiStringify(workItem))
    digest.update('\0')
  }
  return digest.digest('hex')
}

/** Object key の列挙順に依存しない canonical JSON 文字列を返します。 */
function stableAnalyticsApiStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableAnalyticsApiStringify).join(',')}]`
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${stableAnalyticsApiStringify(entry)}`
    )
    .join(',')}}`
}

/** Current canonical revision の latest update event がすべて読めたかを返します。 */
function hasAnalyticsLatestAuditCoverage(
  workItems: readonly CanonicalWorkItem[],
  events: readonly AuditEventV1[],
) {
  const rawIdByCanonicalEntityId = new Map(workItems.map((workItem) => [
    createTeamIssueAuditEntityId(workItem.teamId, workItem.id),
    workItem.id,
  ]))
  return workItems.every((workItem) => {
    if (workItem.revision <= 1) return true
    const canonicalEntityId = createTeamIssueAuditEntityId(
      workItem.teamId,
      workItem.id,
    )
    const updatedAt = Date.parse(workItem.updatedAt)
    return events.some((event) =>
      Date.parse(event.occurredAt) === updatedAt &&
      isAnalyticsLatestWorkItemUpdate(event, workItem, canonicalEntityId) &&
      (
        isCanonicalAnalyticsAuditEvent(event, canonicalEntityId) ||
        isAuthorizedLegacyAnalyticsAuditEvent(
          event,
          workItem.id,
          rawIdByCanonicalEntityId,
        )
      )
    )
  })
}

/** Event が canonical Work Item の latest revision を生成した update かを返します。 */
function isAnalyticsLatestWorkItemUpdate(
  event: AuditEventV1,
  workItem: CanonicalWorkItem,
  canonicalEntityId: string,
) {
  if (
    event.eventType !== 'work-item.updated' ||
    event.action !== 'updated' ||
    event.targetType !== 'work-item' ||
    event.target.type !== 'work-item' ||
    event.targetId !== event.target.id ||
    (
      event.targetId !== canonicalEntityId &&
      event.targetId !== workItem.id
    )
  ) {
    return false
  }
  const metadataTeamId = readAnalyticsAuditMetadataText(event.metadata?.teamId)
  const metadataIssueId = readAnalyticsAuditMetadataText(event.metadata?.issueId)
  const metadataWorkItemId = readAnalyticsAuditMetadataText(
    event.metadata?.workItemId,
  )
  return event.metadata?.adapter === 'canonical-work-item' &&
    event.metadata.afterRevision === workItem.revision &&
    metadataTeamId === workItem.teamId &&
    (metadataIssueId ?? metadataWorkItemId) === workItem.id &&
    (
      metadataIssueId === undefined ||
      metadataWorkItemId === undefined ||
      metadataIssueId === metadataWorkItemId
    )
}

/** Bounded retry 後も整合しない canonical/audit read を retryable error にします。 */
function createAnalyticsReadBarrierError() {
  return new AnalyticsError(
    503,
    'AnalyticsReadBarrierUnavailable',
    'Analytics data changed while its audit history was being read. Retry the request.',
  )
}

/**
 * Current ACL で選ばれた Work Item identity だけを entity GSI から読みます。
 *
 * Canonical identity に加えて legacy raw ID も検索しますが、raw ID event は Team/Issue
 * metadata または canonical target が current authorized Work Item と一致する場合だけ採用します。
 * Team を跨いで同じ raw ID が存在しても、認可不能な event を別 Work Item に帰属させません。
 */
async function readAuthorizedAnalyticsAuditEvents(
  workspaceId: string,
  workItems: readonly TeamIssueResponseItem[],
  historyReadAt: string,
) {
  const authorizedRawIdByCanonicalEntityId = new Map(workItems.map((workItem) => [
    createTeamIssueAuditEntityId(workItem.teamId, workItem.id),
    workItem.id,
  ]))
  const authorizedCanonicalEntityIds = new Set(
    authorizedRawIdByCanonicalEntityId.keys(),
  )
  const identities = [
    ...[...authorizedCanonicalEntityIds].sort().map((entityId) => ({
      entityId,
      legacyRawId: false,
    })),
    ...[...new Set(workItems.map((workItem) => workItem.id))].sort().map((entityId) => ({
      entityId,
      legacyRawId: true,
    })),
  ]
  if (identities.length > ANALYTICS_AUDIT_IDENTITY_QUERY_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsHistoryLimitExceeded',
      `Analytics history requires more than ${ANALYTICS_AUDIT_IDENTITY_QUERY_LIMIT} entity timeline queries. Narrow the report scope.`,
    )
  }
  const events: AuditEventV1[] = []
  let nextIdentityIndex = 0
  let pageQueryCount = 0
  let readEventCount = 0
  let failure: unknown
  const workerCount = Math.min(ANALYTICS_AUDIT_QUERY_CONCURRENCY, identities.length)

  const readNextIdentity = async () => {
    while (failure === undefined) {
      const identityIndex = nextIdentityIndex
      nextIdentityIndex += 1
      const identity = identities[identityIndex]
      if (!identity) return

      try {
        let cursor: string | undefined
        let pageCount = 0
        do {
          if (
            pageCount >= ANALYTICS_AUDIT_MAX_PAGES ||
            pageQueryCount >= ANALYTICS_AUDIT_PAGE_QUERY_LIMIT
          ) {
            throw createAnalyticsHistoryLimitExceededError()
          }
          pageQueryCount += 1
          const page = await workspaceDependencies.auditEvents.query({
            workspaceId,
            entityType: 'work-item',
            entityId: identity.entityId,
            to: historyReadAt,
            limit: ANALYTICS_AUDIT_PAGE_SIZE,
            cursor,
            direction: 'ascending',
          })
          pageCount += 1
          readEventCount += page.events.length
          if (readEventCount > ANALYTICS_AUDIT_EVENT_LIMIT) {
            throw createAnalyticsHistoryLimitExceededError()
          }
          for (const event of page.events) {
            const authorized = identity.legacyRawId
              ? isAuthorizedLegacyAnalyticsAuditEvent(
                event,
                identity.entityId,
                authorizedRawIdByCanonicalEntityId,
              )
              : isCanonicalAnalyticsAuditEvent(event, identity.entityId)
            if (!authorized) continue

            events.push(event)
            if (events.length > ANALYTICS_AUDIT_EVENT_LIMIT) {
              throw createAnalyticsHistoryLimitExceededError()
            }
          }
          cursor = page.nextCursor
        } while (cursor)
      } catch (error) {
        failure ??= error
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, readNextIdentity))
  if (failure !== undefined) throw failure
  return events
}

/** Canonical entity query の結果が要求した Work Item identity と完全一致するかを判定します。 */
function isCanonicalAnalyticsAuditEvent(
  event: AuditEventV1,
  canonicalEntityId: string,
) {
  return event.entityType === 'work-item' &&
    event.entity.type === 'work-item' &&
    event.entityId === canonicalEntityId &&
    event.entity.id === canonicalEntityId
}

/** Legacy raw-ID event が current authorized Work Item へ安全に解決できるかを判定します。 */
function isAuthorizedLegacyAnalyticsAuditEvent(
  event: AuditEventV1,
  rawWorkItemId: string,
  authorizedRawIdByCanonicalEntityId: ReadonlyMap<string, string>,
) {
  if (
    event.entityType !== 'work-item' ||
    event.entity.type !== 'work-item'
  ) {
    return false
  }
  if (
    event.entityId !== rawWorkItemId ||
    event.entity.id !== rawWorkItemId
  ) {
    return false
  }
  if (
    event.targetType !== 'work-item' ||
    event.target.type !== 'work-item' ||
    event.targetId !== event.target.id
  ) {
    return false
  }

  const metadataTeamValue = event.metadata?.teamId
  const metadataIssueValue = event.metadata?.issueId
  const metadataWorkItemValue = event.metadata?.workItemId
  const metadataTeamId = readAnalyticsAuditMetadataText(event.metadata?.teamId)
  const metadataIssueId = readAnalyticsAuditMetadataText(metadataIssueValue)
  const metadataWorkItemId = readAnalyticsAuditMetadataText(metadataWorkItemValue)
  if (
    (metadataTeamValue !== undefined && metadataTeamId === undefined) ||
    (metadataIssueValue !== undefined && metadataIssueId === undefined) ||
    (metadataWorkItemValue !== undefined && metadataWorkItemId === undefined)
  ) {
    return false
  }
  if (
    metadataIssueId !== undefined &&
    metadataWorkItemId !== undefined &&
    metadataIssueId !== metadataWorkItemId
  ) {
    return false
  }
  const metadataRawId = metadataIssueId ?? metadataWorkItemId
  if (metadataRawId !== undefined && metadataRawId !== rawWorkItemId) {
    return false
  }

  const resolvedCanonicalEntityIds = new Set<string>()
  if (metadataTeamId !== undefined) {
    const canonicalEntityId = createTeamIssueAuditEntityId(
      metadataTeamId,
      metadataRawId ?? rawWorkItemId,
    )
    if (
      authorizedRawIdByCanonicalEntityId.get(canonicalEntityId) !==
        rawWorkItemId
    ) {
      return false
    }
    resolvedCanonicalEntityIds.add(canonicalEntityId)
  }

  if (event.targetId !== rawWorkItemId) {
    if (
      authorizedRawIdByCanonicalEntityId.get(event.targetId) !==
        rawWorkItemId
    ) {
      return false
    }
    resolvedCanonicalEntityIds.add(event.targetId)
  }
  return resolvedCanonicalEntityIds.size === 1
}

/** Analytics audit metadata の non-empty string だけを返します。 */
function readAnalyticsAuditMetadataText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Relevant entity history が安全上限を超えた場合の fail-closed error を返します。 */
function createAnalyticsHistoryLimitExceededError() {
  return new AnalyticsError(
    413,
    'AnalyticsHistoryLimitExceeded',
    'Analytics history for the authorized Work Items exceeds the safe query limit. Narrow the report scope.',
  )
}

/**
 * Snapshot ACL 再検証では audit history/metric を再計算せず、current accessible Work Item
 * key、active readable Project allowlist、snapshot `asOf` から同じ permission scope hash
 * を作ります。
 */
async function readCurrentAnalyticsPermissionScopeHash(
  principal: WorkspacePrincipal,
  query: AnalyticsQueryInput,
  cache = new Map<string, ReturnType<typeof readAccessibleAnalyticsWorkItems>>(),
) {
  const normalized = normalizeAnalyticsQueryInput(query)
  const cacheKey = JSON.stringify({
    teamIds: normalized.filter.teamIds ?? null,
    projectIds: normalized.filter.projectIds ?? null,
    includeArchived: normalized.filter.includeArchived === true,
  })
  let accessible = cache.get(cacheKey)
  if (!accessible) {
    accessible = readAccessibleAnalyticsWorkItems(principal, normalized.filter)
    cache.set(cacheKey, accessible)
  }
  const current = await accessible
  return createAnalyticsPermissionScopeHash(
    current.workItems,
    Date.parse(normalized.asOf),
    current.authorizedProjectIds,
  )
}

/** Export selector を current ACL で再実行できる snapshot へ解決します。 */
async function resolveAnalyticsExportSnapshot(
  principal: WorkspacePrincipal,
  input: Record<string, unknown>,
) {
  const selectorCount = Number(input.query !== undefined) +
    Number(input.reportId !== undefined) +
    Number(input.snapshotId !== undefined)
  if (selectorCount !== 1) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsExport',
      'Analytics export requires exactly one query, reportId, or snapshotId.',
    )
  }
  if (input.query !== undefined) {
    return await executeAnalyticsQuery(principal, input.query)
  }
  if (input.reportId !== undefined) {
    const report = await requireAnalyticsReport(
      principal,
      readAnalyticsIdentifier(input.reportId, 'Analytics report ID'),
    )
    return await executeAnalyticsQuery(
      principal,
      createAnalyticsReportQuery(report, {}),
    )
  }

  const snapshotId = readAnalyticsIdentifier(input.snapshotId, 'Analytics snapshot ID')
  const stored = await workItemDependencies.analytics.getSnapshot(principal.directoryId, snapshotId)
  if (!stored) {
    throw new AnalyticsError(404, 'AnalyticsSnapshotNotFound', 'Analytics snapshot was not found.')
  }
  if (stored.reportId) {
    await requireAnalyticsReport(principal, stored.reportId)
  } else if (stored.createdByMemberKey !== principal.userKey) {
    throw new AnalyticsError(
      403,
      'AnalyticsSnapshotForbidden',
      'Analytics snapshot access is denied.',
    )
  }
  const currentPermissionScopeHash = await readCurrentAnalyticsPermissionScopeHash(
    principal,
    stored.query,
  )
  if (currentPermissionScopeHash !== stored.snapshot.permissionScopeHash) {
    throw new AnalyticsError(
      403,
      'AnalyticsSnapshotScopeChanged',
      'Analytics snapshot authorization scope has changed.',
    )
  }
  return stored.snapshot
}

/** Analytics export format を検証します。 */
function readAnalyticsExportFormat(value: unknown): 'csv' | 'pdf' {
  if (value === 'csv' || value === 'pdf') return value
  throw new AnalyticsError(
    400,
    'InvalidAnalyticsExport',
    'Analytics export format must be csv or pdf.',
  )
}

/** Current viewer が report definition 自体を参照できるか判定します。 */
function canReadAnalyticsReport(
  principal: WorkspacePrincipal,
  context: WorkspaceSearchContext,
  report: AnalyticsReport,
) {
  if (report.visibility === 'personal') {
    return report.ownerMemberKey === principal.userKey
  }
  if (report.visibility === 'shared') {
    return true
  }
  return report.visibility === 'team' &&
    typeof report.teamId === 'string' &&
    context.savedViewAccess.teamIds.has(report.teamId)
}

/** Report を取得し、current visibility policy を満たすことを保証します。 */
async function requireAnalyticsReport(
  principal: WorkspacePrincipal,
  reportId: string,
) {
  const report = await workItemDependencies.analytics.getReport(principal.directoryId, reportId)
  if (!report) {
    throw new AnalyticsError(404, 'AnalyticsReportNotFound', 'Analytics report was not found.')
  }
  const context = await createWorkspaceSearchContext(principal)
  if (!canReadAnalyticsReport(principal, context, report)) {
    throw new AnalyticsError(403, 'AnalyticsReportForbidden', 'Analytics report access is denied.')
  }
  return report
}

/** Existing report の visibility に応じた write role を要求します。 */
async function requireAnalyticsReportWrite(
  principal: WorkspacePrincipal,
  report: AnalyticsReport,
) {
  await requireAnalyticsVisibilityWrite(
    principal,
    report.visibility,
    report.teamId,
    report.ownerMemberKey,
  )
}

/** Personal/team/shared report の作成・更新・削除 policy を適用します。 */
async function requireAnalyticsVisibilityWrite(
  principal: WorkspacePrincipal,
  visibility: unknown,
  teamId: unknown,
  ownerMemberKey: string,
) {
  if (visibility === 'personal') {
    if (
      ownerMemberKey !== principal.userKey ||
      principal.enterprisePermissions !== undefined &&
        principal.enterpriseGrantedRoutePermissions?.includes('work-items.write') !== true
    ) {
      throw new AnalyticsError(
        403,
        'AnalyticsReportForbidden',
        'Only the personal report owner can change this report.',
      )
    }
    return
  }
  if (visibility === 'team') {
    const normalizedTeamId = readAnalyticsIdentifier(teamId, 'Analytics report Team ID')
    if (principal.enterprisePermissions !== undefined) {
      const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
        principal.directoryId,
        'ja',
      )
      if (!directory.teams.some((team) => team.id === normalizedTeamId)) {
        throw new ProjectDataError(
          404,
          'TeamNotFound',
          `Team "${normalizedTeamId}" was not found.`,
        )
      }
      if (
        hasEnterpriseWorkspacePermission(principal, 'teams.manage') ||
        principal.enterpriseTeamAccesses?.some((access) =>
          access.teamId === normalizedTeamId &&
          access.permissions.includes('teams.manage')
        )
      ) {
        return
      }
      throw new AnalyticsError(
        403,
        'AnalyticsReportForbidden',
        'Target Team management permission is required to change this report.',
      )
    }
    await requireTeamPermission(principal, normalizedTeamId, 'manager')
    return
  }
  if (visibility === 'shared') {
    if (principal.enterprisePermissions !== undefined) {
      if (hasEnterpriseWorkspacePermission(principal, 'workspace.manage')) return
      throw new AnalyticsError(
        403,
        'AnalyticsReportForbidden',
        'Workspace management permission is required to change this report.',
      )
    }
    requireWorkspaceAdministration(principal)
    return
  }
  throw new AnalyticsError(
    400,
    'InvalidAnalyticsReport',
    'Analytics report visibility is invalid.',
  )
}

/** Workspace resource そのものに Enterprise permission があるか判定します。 */
function hasEnterpriseWorkspacePermission(
  principal: WorkspacePrincipal,
  permission: EnterprisePermissionId,
) {
  return principal.enterpriseRouteAuthorizedAtResource === true &&
    principal.enterpriseAuthorizationResource?.kind === 'workspace' &&
    principal.enterprisePermissions?.includes(permission) === true
}

/** Analytics route identifier を path/storage keyに安全な形式へ制限します。 */
function readAnalyticsIdentifier(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
  ) {
    throw new AnalyticsError(400, 'InvalidAnalyticsInput', `${label} is invalid.`)
  }
  return value
}

/** Analytics report list の page size を API 上限内に制限します。 */
function readAnalyticsReportListLimit(value: string | undefined) {
  if (value === undefined) return 200
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsInput',
      'Analytics report list limit must be an integer between 1 and 200.',
    )
  }
  return parsed
}

/** Analytics report list の opaque cursor を空白なしの bounded token として返します。 */
function readAnalyticsReportListCursor(value: string | undefined) {
  if (value === undefined) return undefined
  const cursor = value.trim()
  if (!cursor || cursor.length > 16_384) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsInput',
      'Analytics report list cursor is invalid.',
    )
  }
  return cursor
}

/** Analytics snapshot list の opaque cursor を data read 前に検証します。 */
function readAnalyticsSnapshotListCursor(value: string | undefined) {
  if (value === undefined) return undefined
  const cursor = value.trim()
  if (
    !cursor ||
    cursor.length > 16_384 ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsInput',
      'Analytics snapshot list cursor is invalid.',
    )
  }
  return cursor
}

/** Report mutation の positive optimistic revision を検証します。 */
function readAnalyticsExpectedRevision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsReport',
      'Analytics expectedRevision must be a positive safe integer.',
    )
  }
  return Number(value)
}

/** Snapshot retry を同じ immutable record ID へ収束させます。 */
function createAnalyticsSnapshotId(
  workspaceId: string,
  report: AnalyticsReport,
  snapshot: AnalyticsSnapshot,
  memberKey: string,
  idempotencyKey: string | undefined,
) {
  const operationKey = idempotencyKey?.trim() || crypto.randomUUID()
  const digest = createHash('sha256')
    .update(JSON.stringify({
      workspaceId,
      reportId: report.id,
      reportRevision: report.revision,
      queryHash: snapshot.queryHash,
      memberKey,
      operationKey,
    }))
    .digest('hex')
  return `snapshot_${digest.slice(0, 48)}`
}

async function readAutomationJson(c: Context) {
  const value = await readJson<unknown>(c.req)
  if (!isRecord(value)) {
    throw new AutomationError(
      'invalid-input',
      'InvalidAutomationInput',
      'A JSON object request body is required.',
    )
  }
  return value
}

async function authenticateAutomationPrincipal(c: Context, manage = false) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    throw new AutomationError('unauthenticated', 'AutomationAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
  if (manage) requireWorkspaceAdministration(principal)
  return principal
}

function readRequiredInboundWebhookIdempotencyKey(c: Context) {
  const value = c.req.header('Idempotency-Key')?.trim()
  if (!value || value.length > 256) {
    throw new AutomationError(
      'invalid-input',
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
  const endpoint = await automationDependencies.inboundWebhooks.getInboundWebhookEndpoint(workspaceId, endpointId)
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
    const signingSecret = await automationDependencies.automationInboundWebhookSecrets.provision(secretReference)
    return {
      completed: await automationDependencies.inboundWebhooks.completeInboundWebhookProvisioning(provisioning),
      signingSecret,
    }
  } catch (error) {
    const current = await automationDependencies.inboundWebhooks.getInboundWebhookEndpoint(
      provisioning.endpoint.workspaceId,
      provisioning.endpoint.id,
    ).catch(() => undefined)
    if (current?.status === 'revoked') {
      await automationDependencies.automationInboundWebhookSecrets.delete(secretReference)
    }
    throw error
  }
}

function automationInboundWebhookNotFound() {
  return new AutomationError(
    'not-found',
    'AutomationInboundWebhookNotFound',
    'Inbound webhook endpoint was not found.',
  )
}

function automationInboundWebhookUnavailable() {
  return new AutomationError(
    'unavailable',
    'AutomationInboundWebhookUnavailable',
    'Inbound webhook service is unavailable.',
    true,
  )
}

function readAutomationPageLimit(value: string | undefined) {
  if (value === undefined) return undefined
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AutomationError('invalid-input', 'InvalidAutomationQuery', 'Automation page limit is invalid.')
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
  throw new AutomationError('invalid-input', 'InvalidAutomationQuery', 'Automation execution status is invalid.')
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
  const operation = await automationDependencies.bulkOperations.getBulkOperation(workspaceId, operationId)
  if (!operation) {
    throw new AutomationError('not-found', 'BulkOperationNotFound', 'Bulk operation was not found.')
  }
  return operation
}

/**
 * Restricts Bulk retry and undo operations to their initiating member.
 *
 * @param operation - Durable Bulk operation to authorize.
 * @param actorMemberKey - Current actor member key.
 */
export function requireBulkOperationOwner(operation: BulkOperation, actorMemberKey: string) {
  if (operation.actorMemberKey !== actorMemberKey) {
    throw new AutomationError('forbidden', 'BulkOperationForbidden', 'Bulk operation access is denied.')
  }
}

/**
 * Removes server-only undo snapshots from a Bulk operation response.
 *
 * @param operation - Durable Bulk operation to project.
 * @returns A response-safe copy of the operation.
 */
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
    throw new AutomationError('unavailable', 'AutomationAuditUnavailable', 'Audit outbox is not configured.', true)
  }
  const context = createApiMutationContext(c, principal, metadata)
  const event = createAuditEvent({
    context,
    eventType: 'form.submitted',
    entity: { type: 'automation-form', id: entityId },
    summary: 'Automation form was submitted.',
    metadata,
    expiresAt: calculateAuditExpiresAt(
      context.occurredAt,
      getConfiguredAuditRetentionDays(),
    ),
  })
  const auditEvents = workspaceDependencies.auditEvents
  if (!auditEvents.putEvent) {
    throw new AutomationError(
      'unavailable',
      'AutomationAuditUnavailable',
      'Audit outbox does not provide an immutable writer.',
      true,
    )
  }
  try {
    await auditEvents.putEvent(event)
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AutomationError(
        'conflict',
        'IdempotencyConflict',
        'Idempotency key was already used with different automation ingress input.',
      )
    }
    throw error
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
  const application = await automationDependencies.ruleTemplates.claimTemplateApplication(
    initialApplication,
    now,
    new Date(now.getTime() + AUTOMATION_TEMPLATE_APPLICATION_LEASE_MS).toISOString(),
  )
  if (!application) {
    const current = await automationDependencies.ruleTemplates.getTemplateApplication(
      initialApplication.workspaceId,
      initialApplication.id,
    )
    if (current?.status === 'succeeded') return current
    if (current) assertTemplateApplicationNotFailed(current)
    throw new AutomationError(
      'conflict',
      'AutomationTemplateApplicationInProgress',
      'Template application is already in progress. Retry with the same Idempotency-Key.',
      true,
    )
  }

  try {
    const template = await automationDependencies.ruleTemplates.getTemplateVersion(
      application.workspaceId,
      application.templateId,
      application.templateVersion,
    )
    if (!template || template.kind !== application.kind) {
      throw new AutomationError(
        'unavailable',
        'AutomationTemplateVersionUnavailable',
        'Pinned template version is unavailable.',
        true,
      )
    }
    if (application.kind === 'project') {
      const target = application.target
      if (template.kind !== 'project' || target.kind !== 'project') {
        throw new AutomationError('unavailable', 'AutomationTemplateApplicationInvalid', 'Project template application is invalid.')
      }
      const names = readLocalizedNames(template.payload)
      const result = {
        kind: 'project' as const,
        teamId: target.teamId,
        projectId: application.id,
        name: names.nameJa,
      }
      const response = await workspaceDependencies.projectDirectory.createProject(
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
        [automationDependencies.ruleTemplates.createTemplateApplicationCompletionMutation(application, result)],
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
      throw new AutomationError('unavailable', 'AutomationTemplateApplicationInvalid', 'Workflow template application is invalid.')
    }
    const target = application.target
    const resolved = target.scopeType === 'workspace'
      ? await workItemDependencies.workItemConfigurations.getWorkspaceConfiguration(application.workspaceId)
      : await workItemDependencies.workItemConfigurations.getTeamConfiguration(
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
      automationDependencies.ruleTemplates.createTemplateApplicationCompletionMutation(application, result),
    ]
    if (target.scopeType === 'workspace') {
      await workItemDependencies.workItemConfigurations.saveWorkspaceConfiguration(
        application.workspaceId,
        configuration,
        async () => {
          await validateWorkItemConfigurationReferences(application.workspaceId, configuration)
          await validateWorkItemConfigurationUsage(application.workspaceId, configuration)
        },
        completionTransactItems,
      )
    } else {
      await workItemDependencies.workItemConfigurations.saveTeamConfiguration(
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
    const current = await automationDependencies.ruleTemplates.getTemplateApplication(application.workspaceId, application.id)
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
    'conflict',
    application.errorCode ?? 'AutomationTemplateApplicationFailed',
    application.errorMessage ?? 'Template application previously failed.',
  )
}

async function requireCompletedTemplateApplication(application: AutomationTemplateApplication) {
  const completed = await automationDependencies.ruleTemplates.getTemplateApplication(application.workspaceId, application.id)
  if (completed?.status === 'succeeded') return completed
  throw new AutomationError(
    'unavailable',
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
    await automationDependencies.ruleTemplates.saveTemplateApplication({
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
  await automationDependencies.ruleTemplates.saveTemplateApplication(failed, application.revision)
}

function isTerminalTemplateApplicationError(
  error: unknown,
): error is AutomationError | WorkItemConfigurationError | ProjectDataError {
  if (error instanceof AutomationError) return error.status < 500 && !error.retryable
  return (error instanceof WorkItemConfigurationError || error instanceof ProjectDataError) &&
    error.status < 500
}

/**
 * Converts Planning failures into the stable Automation action error contract.
 *
 * @param error - Planning failure raised while preparing one bulk mutation.
 * @param requireScheduleConfirmation - Whether dependency-in-use must become the schedule confirmation contract.
 * @returns Equivalent Automation error with conflict and retryability preserved.
 */
function toBulkAutomationPlanningError(
  error: PlanningError,
  requireScheduleConfirmation = false,
): AutomationError {
  const requiresConfirmation = requireScheduleConfirmation &&
    error.code === 'PlanningWorkItemDependencyInUse'
  return new AutomationError(
    error.status === 409 ? 'conflict' : 'unavailable',
    requiresConfirmation ? 'WorkItemScheduleConfirmationRequired' : error.code,
    requiresConfirmation
      ? 'Preview and explicitly confirm schedule changes for Work Items with dependencies.'
      : error.message,
    error.status >= 500,
  )
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
    const event = await workspaceDependencies.auditEvents.getEvent(principal.directoryId, eventId)
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
      throw new AutomationError('invalid-input', 'BulkOperationTargetMissing', 'Bulk operation target is missing.')
    }
    const context = await requireTeamPermission(principal, item.teamId, 'member')
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
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
        'conflict',
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
      let authorizationSnapshot: WorkItemAuthorizationSnapshot | undefined
      if (action.archived) {
        try {
          authorizationSnapshot = await createDependencyFencedWorkItemAuthorizationSnapshot(
            principal,
            loaded.item.teamId,
            loaded.item.workItemId,
          )
        } catch (error) {
          if (error instanceof PlanningError) {
            throw toBulkAutomationPlanningError(error)
          }
          throw error
        }
      }
      body = {
        archivedAt: action.archived ? new Date().toISOString() : null,
        archivedBy: action.archived ? principal.userKey : null,
        expectedRevision: loaded.item.expectedRevision,
        ...(authorizationSnapshot ? { authorizationSnapshot } : {}),
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
          await workItemDependencies.workItemConfigurations.getTeamConfiguration(
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
    const changesAssignedProject =
      action.type !== 'archive' &&
      'assignedProjectId' in configuredBody &&
      readAssignedProjectId(configuredBody.assignedProjectId) !==
        loaded.detail.issue.assignedProjectId
    if (
      action.type !== 'archive' &&
      'schedule' in configuredBody &&
      configuredBody.schedule !== undefined &&
      stableDigestStringify(configuredBody.schedule) !==
        stableDigestStringify(loaded.detail.issue.schedule)
    ) {
      try {
        const authorizationSnapshot =
          await createDependencyFencedWorkItemAuthorizationSnapshot(
            principal,
            loaded.item.teamId,
            loaded.item.workItemId,
          )
        return {
          ...loaded,
          body: { ...configuredBody, authorizationSnapshot },
        }
      } catch (error) {
        if (error instanceof PlanningError) {
          throw toBulkAutomationPlanningError(error, true)
        }
        throw error
      }
    }
    if (changesAssignedProject) {
      try {
        const authorizationSnapshot =
          await createPlanningFencedWorkItemAuthorizationSnapshot(principal)
        return {
          ...loaded,
          body: { ...configuredBody, authorizationSnapshot },
        }
      } catch (error) {
        if (error instanceof PlanningError) {
          throw toBulkAutomationPlanningError(error)
        }
        throw error
      }
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
        response = await workItemDependencies.teamIssues.updateTeamIssue(
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
        throw new AutomationError('conflict', 'BulkUndoUnavailable', 'Bulk operation item cannot be undone.')
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
            await workItemDependencies.workItemConfigurations.getTeamConfiguration(
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
      const changesSchedule = 'schedule' in configuredBody &&
        configuredBody.schedule !== undefined &&
        stableDigestStringify(configuredBody.schedule) !==
          stableDigestStringify(loaded.detail.issue.schedule)
      const changesAssignedProject = 'assignedProjectId' in configuredBody &&
        readAssignedProjectId(configuredBody.assignedProjectId) !==
          loaded.detail.issue.assignedProjectId
      const restoresArchive = typeof configuredBody.archivedAt === 'string'
      let mutationBody = configuredBody
      if (changesSchedule || restoresArchive || changesAssignedProject) {
        try {
          mutationBody = {
            ...configuredBody,
            authorizationSnapshot:
              changesSchedule || restoresArchive
                ? await createDependencyFencedWorkItemAuthorizationSnapshot(
                    principal,
                    item.teamId,
                    item.workItemId,
                  )
                : await createPlanningFencedWorkItemAuthorizationSnapshot(principal),
          }
        } catch (error) {
          if (error instanceof PlanningError) {
            throw new AutomationError(
              error.status === 409 ? 'conflict' : 'unavailable',
              changesSchedule && error.code === 'PlanningWorkItemDependencyInUse'
                ? 'WorkItemScheduleConfirmationRequired'
                : error.code,
              changesSchedule && error.code === 'PlanningWorkItemDependencyInUse'
                ? 'Preview and explicitly confirm schedule changes for Work Items with dependencies.'
                : error.message,
              error.status >= 500,
            )
          }
          throw error
        }
      }
      let response: UpdateTeamIssueResponse
      try {
        response = await workItemDependencies.teamIssues.updateTeamIssue(
          principal.directoryId,
          item.teamId,
          item.workItemId,
          mutationBody,
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

/**
 * Creates a deterministic mutation key for one Bulk apply item.
 *
 * @param request - Canonical Bulk operation request.
 * @param itemIndex - Zero-based item index.
 * @param phase - Mutation phase bound to the key.
 * @param actorMemberKey - Member executing the mutation.
 * @returns A stable idempotency key.
 */
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
  'priority',
  'schedule',
  'title',
  'workflowStatusId',
])

/** Dependencies used while executing durable Automation actions. */
export interface AutomationActionExecutorDependencies {
  /** Provides Cognito user and system-administrator lookups. */
  cognito: AuthenticationDependencies['cognito']
  /** Provides Team and Project directory reads. */
  projectDirectory: WorkspaceDependencies['projectDirectory']
  /** Provides Workspace membership reads. */
  workspaceAccess: WorkspaceDependencies['workspaceAccess']
  /** Provides immutable mutation audit reads. */
  auditEvents: WorkspaceDependencies['auditEvents']
  /** Provides canonical Work Item persistence. */
  teamIssues: WorkItemDependencies['teamIssues']
  /** Provides Work Item workflow and relation configuration. */
  workItemConfigurations: WorkItemDependencies['workItemConfigurations']
  /** Provides unfiltered Planning dependency state for schedule mutation fencing. */
  planning: WorkItemDependencies['planning']
  /** Provides Work Item approval persistence. */
  fileProofing: WorkItemDependencies['fileProofing']
  /** Provides Workspace search projection persistence. */
  workspaceSearch: WorkItemDependencies['workspaceSearch']
  /** Enables synchronous Workspace search projection updates. */
  workspaceSearchProjectionEnabled: boolean
  /** Provides Automation template persistence. */
  automation: AutomationRuleTemplatePort
}

const ambientAutomationActionExecutorDependencies: AutomationActionExecutorDependencies = {
  get cognito() {
    return authenticationDependencies.cognito
  },
  get projectDirectory() {
    return workspaceDependencies.projectDirectory
  },
  get workspaceAccess() {
    return workspaceDependencies.workspaceAccess
  },
  get auditEvents() {
    return workspaceDependencies.auditEvents
  },
  get teamIssues() {
    return workItemDependencies.teamIssues
  },
  get workItemConfigurations() {
    return workItemDependencies.workItemConfigurations
  },
  get planning() {
    return workItemDependencies.planning
  },
  get fileProofing() {
    return workItemDependencies.fileProofing
  },
  get workspaceSearch() {
    return workItemDependencies.workspaceSearch
  },
  get workspaceSearchProjectionEnabled() {
    return workItemDependencies.workspaceSearchProjectionEnabled
  },
  get automation() {
    return automationDependencies.ruleTemplates
  },
}

/**
 * Creates the action executor used by the durable Automation engine.
 *
 * @param dependencies - Explicit Automation action ports; API routes use request-bound defaults.
 * @returns An executor for one Automation action at a time.
 */
export function createAutomationActionExecutor(
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
): AutomationActionExecutor {
  return {
    async execute(action, context) {
      switch (action.type) {
        case 'assign':
          await executeAutomationWorkItemUpdate(
            { assigneeUserId: action.assigneeMemberKey },
            context,
            dependencies,
          )
          return
        case 'move':
          await executeAutomationWorkItemUpdate(
            { assignedProjectId: action.targetProjectId },
            context,
            dependencies,
          )
          return
        case 'update':
          await executeAutomationWorkItemUpdate(action.patch, context, dependencies)
          return
        case 'create':
          await executeAutomationWorkItemCreate(action, context, dependencies)
          return
        case 'comment':
          await executeAutomationComment(action.body, context, dependencies)
          return
        case 'notify':
          await emitAutomationOutboxEvent(
            'automation.notification.requested',
            action.title,
            action.recipientMemberKeys,
            context,
            { body: action.body ?? '' },
            dependencies,
          )
          return
        case 'approval':
          await executeAutomationApproval(action, context, dependencies)
          return
        case 'webhook':
          await deliverAutomationWebhook(action, context)
      }
    },
  }
}

/**
 * Applies a validated Automation patch to one canonical Work Item.
 *
 * @param patch - Automation field values to apply.
 * @param context - Durable Automation execution context.
 * @param dependencies - Ports used by the update workflow.
 * @returns A promise that resolves after persistence and projection.
 */
async function executeAutomationWorkItemUpdate(
  patch: Record<string, AutomationValue>,
  context: AutomationActionExecutionContext,
  dependencies: AutomationActionExecutorDependencies,
) {
  const target = readAutomationWorkItemTarget(context.event)
  const detail = await dependencies.teamIssues.getTeamIssueDetail(
    context.execution.workspaceId,
    target.teamId,
    target.workItemId,
    { consistentIssueRead: true, eventLimit: 0 },
  )
  const unsafeFields = Object.keys(patch).filter((field) => !bulkEditableWorkItemFields.has(field))
  if (unsafeFields.length > 0) {
    throw new AutomationError(
      'invalid-input',
      'AutomationUpdateFieldUnsupported',
      `Automation cannot update fields: ${unsafeFields.join(', ')}.`,
    )
  }
  const body = {
    ...patch,
    expectedRevision: detail.issue.revision,
  } as UpdateTeamIssueRequestBody
  const team = await requireAutomationTeam(
    context.execution.workspaceId,
    target.teamId,
    dependencies,
  )
  const configuredBody = await prepareConfiguredUpdateWorkItem(
    context.execution.workspaceId,
    target.teamId,
    detail.issue,
    normalizeTeamIssueInput(body, team),
    await dependencies.workItemConfigurations.getTeamConfiguration(
      context.execution.workspaceId,
      target.teamId,
    ),
  )
  if ('assigneeUserId' in configuredBody) {
    await requireActiveWorkspaceAssignee(
      context.execution.workspaceId,
      readTeamIssueAssigneeUserId(configuredBody),
      dependencies,
    )
  }
  const changesSchedule =
    'schedule' in configuredBody &&
    configuredBody.schedule !== undefined &&
    stableDigestStringify(configuredBody.schedule) !==
      stableDigestStringify(detail.issue.schedule)
  const changesAssignedProject =
    'assignedProjectId' in configuredBody &&
    readAssignedProjectId(configuredBody.assignedProjectId) !== detail.issue.assignedProjectId
  const planningRevisionFence = changesSchedule
    ? await createAutomationSchedulePlanningRevisionFence(
        context.execution.workspaceId,
        target.teamId,
        target.workItemId,
        dependencies,
      )
    : changesAssignedProject
      ? await createAutomationPlanningRevisionFence(
          context.execution.workspaceId,
          dependencies,
        )
      : undefined
  const mutationContext = createAutomationMutationContext(context, patch)
  let updatedIssue: TeamIssueResponseItem
  try {
    const response = await dependencies.teamIssues.updateTeamIssue(
      context.execution.workspaceId,
      target.teamId,
      target.workItemId,
      {
        ...configuredBody,
        ...(planningRevisionFence ? { planningRevisionFence } : {}),
      },
      `automation:${context.execution.ruleId}`,
      mutationContext,
    )
    updatedIssue = response.issue
  } catch (error) {
    const current = await dependencies.teamIssues.getTeamIssueDetail(
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
        dependencies,
      )
    ) throw error
    updatedIssue = current.issue
  }
  await projectWorkItemSearchDocumentBestEffort(
    context.execution.workspaceId,
    updatedIssue,
    'automation Work Item update',
    undefined,
    dependencies,
  )
}

/**
 * Verifies that one Automation schedule update is isolated and captures its Planning fence.
 *
 * @param workspaceId - Workspace containing the target Work Item.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @param dependencies - Ports used by the Automation execution.
 * @returns Exact Planning revision that must still hold in the update transaction.
 */
async function createAutomationSchedulePlanningRevisionFence(
  workspaceId: string,
  teamId: string,
  workItemId: string,
  dependencies: AutomationActionExecutorDependencies,
) {
  const state = await dependencies.planning.getAuthorizationState(workspaceId)
  if (!Array.isArray(state.workItemDependencies)) {
    throw new AutomationError(
      'unavailable',
      'PlanningWorkItemDependencyStateUnavailable',
      'Work Item dependency state is unavailable for mutation validation.',
      true,
    )
  }
  try {
    requirePlanningWorkItemHasNoScheduleDependencies(
      state.workItemDependencies,
      teamId,
      workItemId,
    )
  } catch (error) {
    if (
      error instanceof PlanningError &&
      error.code === 'PlanningWorkItemDependencyInUse'
    ) {
      throw new AutomationError(
        'conflict',
        'WorkItemScheduleConfirmationRequired',
        'Preview and explicitly confirm schedule changes for Work Items with dependencies.',
      )
    }
    throw error
  }
  return { expectedRevision: state.revision }
}

/**
 * Captures the Planning revision that serializes an Automation Project move with archive.
 *
 * @param workspaceId - Workspace containing the target Work Item.
 * @param dependencies - Ports used by the Automation execution.
 * @returns Exact Planning revision that must still hold in the update transaction.
 */
async function createAutomationPlanningRevisionFence(
  workspaceId: string,
  dependencies: AutomationActionExecutorDependencies,
) {
  const state = await dependencies.planning.getAuthorizationState(workspaceId)
  return { expectedRevision: state.revision }
}

/**
 * Verifies that a recovered Automation update has its deterministic audit proof.
 *
 * @param context - Mutation audit context used by the original write.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Target Work Item identifier.
 * @param beforeRevision - Revision observed before the write.
 * @param afterRevision - Expected revision after the write.
 * @param dependencies - Ports used to read audit state.
 * @returns Whether the matching immutable audit event exists.
 */
async function hasAutomationMutationAuditProof(
  context: MutationAuditContext,
  teamId: string,
  workItemId: string,
  beforeRevision: number,
  afterRevision: number,
  dependencies: AutomationActionExecutorDependencies,
) {
  const entityId = createTeamIssueAuditEntityId(teamId, workItemId)
  const eventId = createAuditEventId(
    context,
    'work-item.updated',
    { type: 'work-item', id: entityId },
  )
  const event = await dependencies.auditEvents.getEvent(context.workspaceId, eventId)
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

/**
 * Creates one canonical Work Item from an Automation action.
 *
 * @param action - Work Item creation action.
 * @param context - Durable Automation execution context.
 * @param dependencies - Ports used by the creation workflow.
 * @returns A promise that resolves after persistence and projection.
 */
async function executeAutomationWorkItemCreate(
  action: Extract<AutomationAction, { type: 'create' }>,
  context: AutomationActionExecutionContext,
  dependencies: AutomationActionExecutorDependencies,
) {
  const templateVersion = action.templateVersion
  const template = action.templateId && templateVersion !== undefined && Number.isSafeInteger(templateVersion)
    ? await dependencies.automation.getTemplateVersion(
        context.execution.workspaceId,
        action.templateId,
        templateVersion,
      )
    : undefined
  if (action.templateId && (!template || !template.enabled || template.kind !== 'work-item')) {
    throw new AutomationError(
      'conflict',
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
    throw new AutomationError('invalid-input', 'AutomationTargetMissing', 'Create action requires a Team ID.')
  }
  const body: CreateTeamIssueRequestBody = {
    assignedProjectId: values.assignedProjectId,
    assigneeUserId: values.assigneeUserId,
    customFieldValues: values.customFieldValues,
    description: values.description,
    idempotencyResourceId: `${context.execution.id}_create_${context.actionIndex}`,
    priority: values.priority,
    schedule: values.schedule,
    title: values.title,
    workflowStatusId: values.workflowStatusId,
  }
  const team = await requireAutomationTeam(
    context.execution.workspaceId,
    teamId,
    dependencies,
  )
  const configuredBody = await prepareConfiguredCreateWorkItem(
    context.execution.workspaceId,
    teamId,
    normalizeTeamIssueInput(body, team),
    await dependencies.workItemConfigurations.getTeamConfiguration(
      context.execution.workspaceId,
      teamId,
    ),
  )
  const assignee = readTeamIssueAssigneeUserId(configuredBody)
  await requireActiveWorkspaceAssignee(
    context.execution.workspaceId,
    assignee,
    dependencies,
  )
  const response = await dependencies.teamIssues.createTeamIssue(
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
    dependencies,
  )
}

/**
 * Loads the active Team targeted by an Automation definition.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Target Team identifier.
 * @param dependencies - Ports used to read directory state.
 * @returns The active Team directory entry.
 */
async function requireAutomationTeam(
  workspaceId: string,
  teamId: string,
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
) {
  const directory = await dependencies.projectDirectory.getProjectDirectory(
    workspaceId,
    'en',
    true,
  )
  const team = directory.teams.find((candidate) => candidate.id === teamId)
  if (!team) {
    throw new AutomationError(
      'conflict',
      'AutomationTeamUnavailable',
      'The selected Work Item Team is unavailable.',
    )
  }
  return team
}

/**
 * Creates a durable Work Item approval from an Automation action.
 *
 * @param action - Approval action definition.
 * @param context - Durable Automation execution context.
 * @param dependencies - Ports used by the approval workflow.
 * @returns A promise that resolves after the approval is persisted.
 */
async function executeAutomationApproval(
  action: Extract<AutomationAction, { type: 'approval' }>,
  context: AutomationActionExecutionContext,
  dependencies: AutomationActionExecutorDependencies,
) {
  const target = readAutomationWorkItemTarget(context.event)
  const detail = await dependencies.teamIssues.getTeamIssueDetail(
    context.execution.workspaceId,
    target.teamId,
    target.workItemId,
    { consistentIssueRead: true, eventLimit: 0 },
  )
  const team = await requireAutomationTeam(
    context.execution.workspaceId,
    target.teamId,
    dependencies,
  )
  if (
    detail.issue.assignedProjectId &&
    !team.projects.some((project) => project.id === detail.issue.assignedProjectId)
  ) {
    throw new AutomationError(
      'conflict',
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
    dependencies,
  )
  if (action.completionStatusId) {
    await resolveFileApprovalCompletionTransition(
      context.execution.workspaceId,
      target.teamId,
      detail.issue,
      action.completionStatusId,
      dependencies,
    )
  }
  const executionStartedAtEpoch = Date.parse(context.execution.startedAt)
  if (!Number.isFinite(executionStartedAtEpoch)) {
    throw new AutomationError(
      'unavailable',
      'AutomationExecutionStateInvalid',
      'Automation execution start time is invalid.',
    )
  }
  const input = {
    reviewerMemberKeys,
    dueAt: new Date(executionStartedAtEpoch + action.dueInHours * 3_600_000).toISOString(),
    ...(action.completionStatusId ? { completionTransition: action.completionStatusId } : {}),
  }
  await dependencies.fileProofing.createWorkItemApproval(
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

/**
 * Appends one idempotent Automation comment to a Work Item.
 *
 * @param body - Validated comment body.
 * @param context - Durable Automation execution context.
 * @param dependencies - Ports used by the comment workflow.
 * @returns A promise that resolves after the comment is persisted.
 */
async function executeAutomationComment(
  body: string,
  context: AutomationActionExecutionContext,
  dependencies: AutomationActionExecutorDependencies,
) {
  const target = readAutomationWorkItemTarget(context.event)
  await requireAutomationTeam(
    context.execution.workspaceId,
    target.teamId,
    dependencies,
  )
  await dependencies.teamIssues.createTeamIssueComment(
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

/**
 * Appends an Automation notification or approval event to the audit outbox.
 *
 * @param eventType - Stable audit event type.
 * @param summary - Safe event summary.
 * @param recipientMemberKeys - Notification recipient member keys.
 * @param context - Durable Automation execution context.
 * @param metadata - Redacted action metadata.
 * @param dependencies - Ports used to append the event.
 * @returns A promise that resolves after the event is appended.
 */
async function emitAutomationOutboxEvent(
  eventType: string,
  summary: string,
  recipientMemberKeys: string[],
  context: AutomationActionExecutionContext,
  metadata: Record<string, AutomationValue>,
  dependencies: AutomationActionExecutorDependencies,
) {
  const tableName = getConfiguredAuditTableName()
  if (!tableName) {
    throw new AutomationError('unavailable', 'AutomationAuditUnavailable', 'Audit outbox is not configured.', true)
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
    expiresAt: calculateAuditExpiresAt(
      new Date().toISOString(),
      getConfiguredAuditRetentionDays(),
    ),
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
  const auditEvents = dependencies.auditEvents
  if (!auditEvents.putEvent) {
    throw new AutomationError(
      'unavailable',
      'AutomationAuditUnavailable',
      'Audit outbox does not provide an immutable writer.',
      true,
    )
  }
  try {
    await auditEvents.putEvent(event)
  } catch {
    throw new AutomationError(
      'unavailable',
      'AutomationAuditUnavailable',
      'Audit outbox write failed.',
      true,
    )
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
    throw new AutomationError('invalid-input', 'AutomationTargetMissing', 'Action requires a Work Item target.')
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
      resolveEnterpriseAuditActorKind(principal),
      principal.enterpriseBreakGlassActivationId,
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
  idempotencyKeyOverride?: string,
) {
  return createWorkspaceMutationContextForActor(
    c,
    principal.directoryId,
    principal.actorId,
    principal.userKey,
    body,
    idempotencyKeyOverride,
    resolveEnterpriseAuditActorKind(principal),
    principal.enterpriseBreakGlassActivationId,
  )
}

function resolveEnterpriseAuditActorKind(principal: ProjectPrincipal): AuditActorKind {
  if (principal.principalKind === 'service-account') return 'service'
  if (principal.principalKind === 'break-glass') return 'break-glass'
  return 'user'
}

function createWorkspaceMutationContextForActor(
  c: Context,
  workspaceId: string,
  actorId: string,
  displayName: string,
  body: unknown,
  idempotencyKeyOverride?: string,
  actorKind: AuditActorKind = 'user',
  correlationIdOverride?: string,
) {
  try {
    return createRequestMutationContext(
      c,
      workspaceId,
      actorId,
      displayName,
      body,
      idempotencyKeyOverride,
      actorKind,
      correlationIdOverride,
    )
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
  actorKind: AuditActorKind = 'user',
  correlationIdOverride?: string,
) {
  const idempotencyKey = idempotencyKeyOverride ??
    (c.req.header('Idempotency-Key')?.trim() || crypto.randomUUID())
  const correlationId = correlationIdOverride ?? c.req.header('X-Correlation-Id')?.trim()
  const path = new URL(c.req.url).pathname

  return createMutationAuditContext({
    workspaceId,
    actor: {
      id: actorId,
      kind: actorKind,
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




/**
 * Records rejected Enterprise Security mutations after the downstream response completes.
 *
 * @param c - Hono request context containing the response to inspect.
 * @param next - Downstream middleware dispatcher.
 * @returns A promise that resolves after best-effort audit recording.
 */
export async function auditRejectedEnterpriseSecurityMutation(
  c: Context,
  next: () => Promise<void>,
) {
  await next()
  if (
    c.req.method === 'GET' ||
    c.req.method === 'HEAD' ||
    c.res.status < 400
  ) {
    return
  }
  try {
    const tableName = getConfiguredAuditTableName()
    if (!tableName) return
    const token = readBearerAccessToken(c) ?? ''
    const scimWorkspaceId = c.req.path.match(/^\/api\/scim\/v2\/([^/]+)/u)?.[1]
    let workspaceId: string | undefined
    let actorId: string | undefined
    let actorKind: 'service' | 'user' = 'user'
    if (scimWorkspaceId) {
      workspaceId = decodeURIComponent(scimWorkspaceId)
      const credential = token
        ? await workspaceDependencies.enterpriseIdentity.scimAuthentication.authenticateScimToken(workspaceId, token)
        : undefined
      if (!credential) return
      actorId = credential.credentialId
      actorKind = 'service'
    } else if (token.startsWith('msa_')) {
      workspaceId = getEnv('MUKUROJI_WORKSPACE_DIRECTORY_ID') ??
        getEnv('MUKUROJI_PROJECT_DIRECTORY_ID')
      const account = workspaceId
        ? await workspaceDependencies.enterpriseIdentity.serviceAccountAuthentication.authenticateServiceAccountToken(
            workspaceId,
            token,
          )
        : undefined
      if (!workspaceId || !account) return
      actorId = account.accountId
      actorKind = 'service'
    } else {
      if (!token) return
      const principal = toProjectPrincipal(await authenticationDependencies.cognito.getUser(token), token)
      workspaceId = principal.directoryId
      actorId = principal.actorId
    }
    const responseBody = await c.res.clone().json().catch(() => undefined)
    const errorCode = isRecord(responseBody) && typeof responseBody.code === 'string'
      ? responseBody.code
      : 'EnterpriseSecurityRequestRejected'
    const requestId = c.req.header('X-Request-Id')?.trim() || crypto.randomUUID()
    const auditContext = createMutationAuditContext({
      workspaceId,
      actor: {
        id: actorId,
        kind: actorKind,
      },
      idempotencyKey: `rejected:${requestId}`,
      request: {
        method: c.req.method,
        path: c.req.path,
        body: {
          errorCode,
          status: c.res.status,
        },
      },
      source: {
        kind: 'api',
        requestId,
        method: c.req.method,
        route: c.req.path,
        ipAddress: resolveEnterpriseClientIp(c),
        userAgent: c.req.header('User-Agent'),
      },
    })
    const event = createAuditEvent({
      context: auditContext,
      eventType: 'enterprise-security.request-rejected',
      entity: { type: 'enterprise-security', id: c.req.path },
      summary: 'Enterprise security mutation was rejected.',
      metadata: {
        errorCode,
        status: c.res.status,
      },
      expiresAt: calculateAuditExpiresAt(
        auditContext.occurredAt,
        getConfiguredAuditRetentionDays(),
      ),
    })
    await workspaceDependencies.auditEvents.putEvent?.(event)
  } catch (error) {
    console.error('Failed to record rejected enterprise security audit event:', error)
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

async function recordWorkspaceAuditAccess(
  c: Context,
  principal: ProjectPrincipal,
  query: AuditEventQuery,
  exportAsNdjson: boolean,
  returnedEventCount: number,
  truncated: boolean,
) {
  if (!workspaceDependencies.auditEvents.putEvent) {
    throw new ProjectDataError(
      503,
      'AuditWriteUnavailable',
      'Audit access cannot proceed without an immutable audit writer.',
    )
  }
  const accessKind = exportAsNdjson ? 'exported' : 'viewed'
  const context = createApiMutationContext(c, principal, {
    auditAccess: accessKind,
    filters: {
      actorId: query.actorId,
      targetType: query.targetType,
      targetId: query.targetId,
      entityType: query.entityType,
      entityId: query.entityId,
      eventTypes: query.eventTypes,
      from: query.from,
      to: query.to,
      direction: query.direction,
      hasCursor: query.cursor !== undefined,
    },
  })
  await workspaceDependencies.auditEvents.putEvent(createAuditEvent({
    context,
    eventType: `audit.${accessKind}`,
    entity: {
      type: 'audit-log',
      id: principal.directoryId,
    },
    summary: exportAsNdjson ? 'Audit events were exported.' : 'Audit events were viewed.',
    metadata: {
      format: exportAsNdjson ? 'ndjson' : 'json',
      returnedEventCount,
      truncated,
      filtered: Boolean(
        query.actorId ||
        query.targetType ||
        query.targetId ||
        query.entityType ||
        query.entityId ||
        query.eventTypes?.length ||
        query.from ||
        query.to ||
        query.cursor
      ),
    },
    expiresAt: calculateAuditExpiresAt(
      context.occurredAt,
      getConfiguredAuditRetentionDays(),
    ),
  }))
}

async function handleWorkspaceAuditRequest(c: Context, exportAsNdjson: boolean) {
  const accessToken = readBearerAccessToken(c)

  if (!accessToken) {
    return c.json({ message: 'Bearer token is required.' }, 401)
  }

  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireSystemAdmin(principal)
    const query = readAuditEventQuery(c, principal.directoryId)

    if (!exportAsNdjson) {
      const page = await workspaceDependencies.auditEvents.query(query)
      await recordWorkspaceAuditAccess(
        c,
        principal,
        query,
        false,
        page.events.length,
        false,
      )
      return c.json(toAuditEventPageView(page))
    }

    const events = []
    let cursor = query.cursor

    do {
      const page = await workspaceDependencies.auditEvents.query({
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

    await recordWorkspaceAuditAccess(
      c,
      principal,
      query,
      true,
      events.length,
      events.length === 1_000 && Boolean(cursor),
    )
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

function requireEnterpriseCognitoSsoAppClientConfiguration() {
  const mainClientId = getEnv('COGNITO_CLIENT_ID')?.trim()
  const clientId = getEnv('COGNITO_SSO_CLIENT_ID')?.trim()
  const redirectUri = getEnv('COGNITO_SSO_REDIRECT_URI')?.trim()
  const identityProviderName = getEnv('COGNITO_ENTERPRISE_IDP_NAME')?.trim()
  if (
    !mainClientId ||
    !clientId ||
    clientId === mainClientId ||
    !redirectUri ||
    !identityProviderName
  ) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoSsoAppClientUnavailable',
      'A distinct Cognito enterprise SSO app client is not configured.',
    )
  }
  return { clientId, redirectUri, identityProviderName }
}

function requireEnterpriseSsoFederationConfiguration() {
  const cognitoDomain = getEnv('COGNITO_HOSTED_UI_DOMAIN')?.trim()
  const userPoolId = getEnv('COGNITO_USER_POOL_ID')?.trim()
  const stateSecret = getEnv('ENTERPRISE_SSO_STATE_SECRET')?.trim()
  const ssoClient = requireEnterpriseCognitoSsoAppClientConfiguration()
  if (
    !cognitoDomain ||
    !userPoolId ||
    !stateSecret
  ) {
    throw new EnterpriseSsoError(
      503,
      'EnterpriseSsoFederationUnavailable',
      'Cognito enterprise federation is not configured.',
    )
  }
  return {
    cognitoDomain: normalizeEnterpriseCognitoDomain(cognitoDomain),
    clientId: ssoClient.clientId,
    userPoolId,
    redirectUri: ssoClient.redirectUri,
    identityProviderName: ssoClient.identityProviderName,
    issuer: `https://cognito-idp.${getAwsRegion()}.amazonaws.com/${userPoolId}`,
    stateSecret,
  }
}

function requireEnterpriseCognitoProviderName() {
  const identityProviderName = getEnv('COGNITO_ENTERPRISE_IDP_NAME')?.trim()
  if (!identityProviderName) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoProviderUnavailable',
      'Cognito enterprise identity provider is not configured.',
    )
  }
  return identityProviderName
}

function normalizeEnterpriseCognitoDomain(value: string) {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError('Invalid Cognito domain.')
    }
    return url.origin
  } catch (error) {
    throw new EnterpriseSsoError(
      503,
      'EnterpriseSsoFederationUnavailable',
      'Cognito enterprise federation domain is invalid.',
      { cause: error },
    )
  }
}

function toEnterpriseSsoErrorResponse(c: Context, error: unknown) {
  const status = error instanceof EnterpriseSsoError
    ? error.status
    : error instanceof EnterpriseIdentityError
      ? error.status
    : error instanceof CognitoServiceError
      ? error.status
    : error instanceof WorkspaceAccessError
      ? error.status
      : 500
  if (status >= 500) console.error(error)
  c.status(
    status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 409 ||
      status === 429 ||
      status === 502 ||
      status === 503
      ? status
      : 500,
  )
  return c.json({
    code: error instanceof EnterpriseSsoError ||
      error instanceof EnterpriseIdentityError ||
      error instanceof CognitoServiceError ||
      error instanceof WorkspaceAccessError
      ? error.code
      : 'EnterpriseSsoUnavailable',
    message: error instanceof Error
      ? error.message
      : 'Enterprise SSO is unavailable.',
  })
}

function normalizeEnterpriseEmailDomain(email: string) {
  const atIndex = email.lastIndexOf('@')
  return atIndex > 0 ? email.slice(atIndex + 1).trim().toLowerCase() : ''
}

function requireEnterpriseExternalAccessAllowed(
  snapshot: EnterpriseIdentitySnapshot,
  email: string,
  role: WorkspaceRole,
  recoveryAccount = false,
) {
  const policy = snapshot.policy?.externalAccess
  if (!policy) return
  const domain = normalizeEnterpriseEmailDomain(email)
  const verifiedDomains = snapshot.domains.filter((candidate) =>
    candidate.status === 'verified'
  )
  const managedDomain = verifiedDomains.length === 0 || verifiedDomains.some((candidate) =>
    candidate.domain === domain
  )
  if (role === 'guest') {
    if (
      !policy.allowGuests ||
      policy.allowedGuestDomains.length > 0 &&
        !policy.allowedGuestDomains.includes(domain)
    ) {
      throw new WorkspaceAccessError(
        403,
        'EnterpriseGuestAccessDenied',
        'Workspace guest policy does not allow this account.',
      )
    }
    return
  }
  if (!managedDomain && !policy.allowExternalCollaborators && !recoveryAccount) {
    throw new WorkspaceAccessError(
      403,
      'EnterpriseExternalAccessDenied',
      'Workspace external collaborator policy does not allow this account.',
    )
  }
}

function readOptionalWorkspaceName(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Resolves the tenant-owned invitation default from authoritative Workspace state.
 *
 * @param principal - Current active Workspace administrator.
 * @returns The member or guest role configured by tenant administration.
 */
async function resolveTenantDefaultInvitationRole(
  principal: WorkspacePrincipal,
): Promise<'member' | 'guest'> {
  try {
    const activeMembers = await workspaceDependencies.workspaceAccess.listActiveMembers(
      principal.directoryId,
    )
    const owner = activeMembers.find((member) => member.role === 'owner')
    if (!owner) {
      throw new TenantAdministrationError(
        503,
        'TenantOwnerUnavailable',
        'The Workspace owner required for tenant initialization is unavailable.',
      )
    }
    const snapshot = await workspaceDependencies.tenantAdministration.ensureSnapshot(
      principal.directoryId,
      owner.memberKey,
      activeMembers.length,
    )
    return snapshot.profile.defaultPolicy.defaultMemberRole
  } catch (error) {
    if (error instanceof TenantAdministrationError) {
      throw new WorkspaceAccessError(
        error.status,
        error.code,
        error.message,
        { cause: error },
      )
    }
    throw error
  }
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
  verifiedAuthenticationMethods: readonly string[] = [],
) {
  if (!tokens.AccessToken) {
    throw new CognitoServiceError(
      502,
      'InvalidCognitoResponse',
      'Cognito did not return an access token.',
    )
  }

  if (
    requireAppDependencies().authentication.cognito instanceof FlociCognitoClient &&
    tokens.AccessToken.split('.').length !== 3
  ) {
    return {
      accessToken: tokens.AccessToken,
      idToken: tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
      tokenType: tokens.TokenType ?? 'Bearer',
    }
  }

  const user = await authenticationDependencies.cognito.getUser(tokens.AccessToken)
  const userKey = readUserAttribute(user, 'email') ?? user.Username

  if (userKey?.trim()) {
    const principal = toProjectPrincipal(user, tokens.AccessToken)
    const auditContext = requestAuditContext ?? createWorkspaceMutationContext(
      c,
      principal,
      requestBody,
    )
    await workspaceDependencies.workspaceAccess.reconcileAuthenticatedMember(principal.directoryId, {
      memberKey: principal.userKey,
      email: readUserAttribute(user, 'email') ?? principal.userKey,
      name: readUserAttribute(user, 'name'),
    }, auditContext)
    const claims = decodeJwtPayload<CognitoAccessTokenClaims>(tokens.AccessToken)
    const authenticatedAt = readNumericClaim(claims?.auth_time) ??
      readNumericClaim(claims?.iat) ??
      Math.floor(Date.now() / 1_000)
    const expiresAt = readNumericClaim(claims?.exp) ??
      Math.floor(Date.now() / 1_000) + (tokens.ExpiresIn ?? 3_600)
    const authenticationMethods = [
      ...new Set([
        ...readCognitoAuthenticationMethods(claims),
        ...verifiedAuthenticationMethods,
      ]),
    ]
    if (authenticationMethods.length > 0) {
      await workspaceDependencies.enterpriseSessionActivity.recordAuthenticationAssurance({
        workspaceId: principal.directoryId,
        sessionId: createHash('sha256').update(tokens.AccessToken).digest('base64url'),
        authenticationMethods,
        authenticatedAt,
        expiresAt,
      })
    }
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
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    requireWorkspaceAdministration(principal)
    const invitationId = readWorkspaceEmail(c.req.param('invitationId'))
    const auditContext = createWorkspaceMutationContext(
      c,
      principal,
      { action, invitationId },
    )
    const preparedInvitation = action === 'resend'
      ? await workspaceDependencies.workspaceAccess.prepareResend(
          principal.directoryId,
          principal.userKey,
          invitationId,
          undefined,
          auditContext,
        )
      : await workspaceDependencies.workspaceAccess.prepareReinvite(
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
      const invitation = await workspaceDependencies.workspaceAccess.markInvitationDelivery(
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
  const existingUser = await authenticationDependencies.cognito.findWorkspaceUser(state.invitation.email)
  const previousCognitoIdentityId = state.invitation.cognitoIdentityId
  state.invitation = await workspaceDependencies.workspaceAccess.markInvitationIdentityMutationStarted(
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
    state.invitation = await workspaceDependencies.workspaceAccess.markInvitationDirectoryClaimCleanupRequired(
      directoryId,
      state.invitation.id,
      state.invitation.version,
      cognitoIdentityId,
      cognitoUsername,
      auditContext,
    )
  }

  if (existingUser?.profile.status === 'FORCE_CHANGE_PASSWORD') {
    const result = await authenticationDependencies.cognito.provisionWorkspaceUser({
      directoryId,
      email: state.invitation.email,
      name: state.invitation.name,
      existingUser,
      beforeDirectoryClaimUpdate: markDirectoryClaimCleanupRequired,
    })
    await authenticationDependencies.cognito.resendWorkspaceUserInvitation(existingUser.profile.username)
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

  const result = await authenticationDependencies.cognito.provisionWorkspaceUser({
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
    await workspaceDependencies.workspaceAccess.markInvitationDelivery(directoryId, invitation.id, {
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

function createEnterpriseAuthenticationSessionId(accessToken: string) {
  return createHash('sha256').update(accessToken).digest('base64url')
}

async function getVerifiedEnterpriseAuthenticationMethods(
  workspaceId: string,
  authenticationSessionId: string,
) {
  try {
    return await workspaceDependencies.enterpriseSessionActivity.getAuthenticationMethods(
      workspaceId,
      authenticationSessionId,
    )
  } catch (error) {
    if (error instanceof EnterpriseSessionActivityError) {
      throw new WorkspaceAccessError(error.status, error.code, error.message, {
        cause: error,
      })
    }
    throw error
  }
}

/**
 * Resolves the commercial tenant feature required by one authenticated route.
 *
 * @param path - Canonical request path.
 * @returns The required feature, or undefined for core product routes.
 */
function resolveTenantFeatureForPath(path: string): TenantFeature | undefined {
  if (path.startsWith('/api/documents') || path.startsWith('/api/document-backlinks')) {
    return 'documents'
  }
  if (path.startsWith('/api/analytics')) return 'analytics'
  if (
    path.startsWith('/api/automation') ||
    path.startsWith('/api/recurring-work') ||
    path.startsWith('/api/bulk-operations')
  ) {
    return 'automation'
  }
  if (path.startsWith('/api/developer')) return 'developer-platform'
  if (
    path.startsWith('/api/enterprise/security/identity-provider') ||
    path.startsWith('/api/enterprise/security/domains') ||
    path.startsWith('/api/enterprise/security/group-mappings')
  ) {
    return 'sso'
  }
  if (
    path.startsWith('/api/scim/') ||
    path.startsWith('/api/enterprise/security/scim') ||
    path.startsWith('/api/enterprise/security/provisioning')
  ) {
    return 'scim'
  }
  return undefined
}

/** Maximum body retained while binding a metering receipt to one API request. */
const TENANT_METERING_BODY_MAX_BYTES = 10 * 1024 * 1024

/**
 * Executes one feature check or mutation-unit reservation.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param feature - Commercial feature required by the route.
 * @param method - Current HTTP request method.
 * @param idempotencyKey - Optional key used to deduplicate mutation metering.
 */
async function applyTenantFeaturePolicy(
  workspaceId: string,
  feature: TenantFeature,
  method: string,
  idempotencyKey?: string,
): Promise<void> {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await workspaceDependencies.tenantEntitlementEnforcement.assertFeature(
      workspaceId,
      feature,
    )
    return
  }
  await workspaceDependencies.tenantEntitlementEnforcement.reserveUsage(
    workspaceId,
    feature,
    1,
    idempotencyKey,
  )
}

/**
 * Applies feature entitlement and mutation metering for one authenticated request.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param context - Current request context, when authentication is route-bound.
 */
async function enforceTenantFeatureForRequest(
  workspaceId: string,
  context?: Context,
): Promise<void> {
  if (!context) return
  const feature = resolveTenantFeatureForPath(context.req.path)
  if (!feature) return
  let idempotencyKey: string | undefined
  try {
    idempotencyKey = await createTenantUsageIdempotencyScope(context)
  } catch (error) {
    throw toTenantEntitlementBoundaryError(error)
  }
  await enforceTenantFeatureForWorkspace(
    workspaceId,
    feature,
    context.req.method,
    idempotencyKey,
  )
}

/**
 * Binds a caller idempotency key to one concrete metered HTTP request.
 *
 * @param context - Current authenticated request context.
 * @returns A digest safe to persist as a second-stage tenant receipt input.
 */
async function createTenantUsageIdempotencyScope(
  context: Context,
): Promise<string | undefined> {
  const normalized = context.req.header('Idempotency-Key')?.trim()
  if (!normalized) return undefined
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (normalized.length > 256 || hasControlCharacter) {
    throw new TenantAdministrationError(
      400,
      'InvalidTenantIdempotencyKey',
      'Tenant idempotency key is invalid.',
    )
  }
  if (context.req.raw.bodyUsed) {
    throw new TenantAdministrationError(
      503,
      'TenantUsageIdempotencyUnavailable',
      'Tenant usage idempotency is unavailable for this request.',
    )
  }
  const contentLength = context.req.header('Content-Length')
  if (
    contentLength !== undefined &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > TENANT_METERING_BODY_MAX_BYTES
  ) {
    throw new TenantAdministrationError(
      413,
      'TenantMeteringBodyTooLarge',
      'The metered request body is too large.',
    )
  }
  const requestBodyDigest = createHash('sha256')
    .update(context.req.header('Content-Type') ?? '')
    .update('\0')
  const bodyReader = context.req.raw.clone().body?.getReader()
  let bodyBytes = 0
  if (bodyReader) {
    try {
      while (true) {
        const chunk = await bodyReader.read()
        if (chunk.done) break
        bodyBytes += chunk.value.byteLength
        if (bodyBytes > TENANT_METERING_BODY_MAX_BYTES) {
          await bodyReader.cancel().catch(() => undefined)
          throw new TenantAdministrationError(
            413,
            'TenantMeteringBodyTooLarge',
            'The metered request body is too large.',
          )
        }
        requestBodyDigest.update(chunk.value)
      }
    } finally {
      bodyReader.releaseLock()
    }
  }
  const url = new URL(context.req.url)
  const scopeDigest = createHash('sha256')
    .update(context.req.method.toUpperCase())
    .update('\0')
    .update(context.req.path)
    .update('\0')
    .update(url.search)
    .update('\0')
    .update(context.req.header('If-Match') ?? '')
    .update('\0')
    .update(normalized)
    .digest('hex')
  const requestDigest = requestBodyDigest.digest('hex')
  return `tenant-meter:v1:${scopeDigest}:${requestDigest}`
}

/**
 * Enforces one tenant feature and initializes legacy tenant state when necessary.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param feature - Commercial feature required by the operation.
 * @param method - HTTP method used to distinguish reads from metered mutations.
 * @param idempotencyKey - Optional key used to deduplicate mutation metering.
 */
async function enforceTenantFeatureForWorkspace(
  workspaceId: string,
  feature: TenantFeature,
  method: string,
  idempotencyKey?: string,
): Promise<void> {
  try {
    await applyTenantFeaturePolicy(workspaceId, feature, method, idempotencyKey)
  } catch (error) {
    if (
      !(error instanceof TenantAdministrationError) ||
      error.code !== 'TenantAdministrationNotInitialized'
    ) {
      throw toTenantEntitlementBoundaryError(error)
    }
    await initializeLegacyTenantAdministration(workspaceId)
    try {
      await applyTenantFeaturePolicy(workspaceId, feature, method, idempotencyKey)
    } catch (retryError) {
      throw toTenantEntitlementBoundaryError(retryError)
    }
  }
}

/** Initializes a legacy tenant once from the authoritative active membership table. */
async function initializeLegacyTenantAdministration(workspaceId: string): Promise<void> {
  const activeMembers = await workspaceDependencies.workspaceAccess.listActiveMembers(workspaceId)
  const owner = activeMembers.find((member) => member.role === 'owner')
  if (!owner) {
    throw toTenantEntitlementBoundaryError(new TenantAdministrationError(
      503,
      'TenantOwnerUnavailable',
      'The Workspace owner required for tenant initialization is unavailable.',
    ))
  }
  await workspaceDependencies.tenantAdministration.ensureSnapshot(
    workspaceId,
    owner.memberKey,
    activeMembers.length,
  )
}

/**
 * Converts tenant policy failures to the cross-route Workspace authorization shape.
 *
 * @param error - Tenant policy or infrastructure failure.
 * @returns A Workspace boundary error for tenant failures, otherwise the original error.
 */
function toTenantEntitlementBoundaryError(error: unknown): unknown {
  if (!(error instanceof TenantAdministrationError)) return error
  return new WorkspaceAccessError(
    error.status,
    error.code,
    error.message,
    { cause: error },
  )
}

async function authenticateWorkspacePrincipal(
  accessToken: string,
  user?: GetUserResponse,
  context?: Context,
  options: WorkspaceAuthenticationOptions = {},
): Promise<WorkspacePrincipal> {
  if (accessToken.startsWith('msa_')) {
    const principal = await authenticateEnterpriseServiceAccount(accessToken, context)
    await enforceActiveTenantForRequest(principal.directoryId, context)
    return principal
  }
  validateConfiguredCognitoAccessToken(accessToken)
  const principal = toProjectPrincipal(user ?? await authenticationDependencies.cognito.getUser(accessToken), accessToken)
  if (typeof authenticationDependencies.cognito.isSystemAdmin === 'function') {
    principal.isSystemAdmin = await authenticationDependencies.cognito.isSystemAdmin(principal.userKey)
  }
  const authenticationSessionId = createEnterpriseAuthenticationSessionId(accessToken)
  const workspaceMember = await workspaceDependencies.workspaceAccess.getActiveMember(
    principal.directoryId,
    principal.userKey,
  )

  if (!workspaceMember) {
    throw new WorkspaceAccessError(403, 'WorkspaceAccessDenied', 'Workspace access is denied.')
  }

  const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
  const recoveryAccount = snapshot.breakGlassAccounts.find((account) =>
    account.linkedMemberKey === principal.userKey && account.status === 'active'
  )
  const breakGlassActivation = await workspaceDependencies.enterpriseIdentity.read.getActiveBreakGlassActivation(
    principal.directoryId,
    principal.userKey,
    authenticationSessionId,
  )
  const principalKind = breakGlassActivation ? 'break-glass' : 'member'
  let verifiedAuthenticationMethods: string[] | undefined
  if (!options.breakGlassCandidate && principalKind !== 'break-glass') {
    try {
      await assertEnterpriseRuntimeCognitoProviders(
        snapshot,
        principal.userKey,
        workspaceMember.email,
      )
    } catch (error) {
      const status = error instanceof EnterpriseIdentityError && error.status >= 500
        ? 503
        : 403
      throw new WorkspaceAccessError(
        status,
        'EnterpriseCognitoProviderBindingInvalid',
        'Enterprise identity provider binding could not be verified.',
        { cause: error },
      )
    }

    const memberDomain = normalizeEnterpriseEmailDomain(workspaceMember.email)
    const enforcedSsoDomains = snapshot.domains.filter((domain) =>
      domain.status === 'verified' &&
      domain.enforceSso &&
      domain.domain === memberDomain
    )
    if (enforcedSsoDomains.length > 0) {
      const ssoClient = requireEnterpriseCognitoSsoAppClientConfiguration()
      const accessTokenClaims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
      verifiedAuthenticationMethods = await getVerifiedEnterpriseAuthenticationMethods(
        principal.directoryId,
        authenticationSessionId,
      )
      if (
        accessTokenClaims?.client_id !== ssoClient.clientId ||
        enforcedSsoDomains.some((domain) => {
          if (!domain.identityProviderId) return true
          const provider = snapshot.identityProviders.find((candidate) =>
            candidate.providerId === domain.identityProviderId
          )
          return !provider || !verifiedAuthenticationMethods?.includes(
            createEnterpriseSsoAuthenticationMethod(
              provider.providerId,
              provider.revision,
            ),
          )
        })
      ) {
        throw new WorkspaceAccessError(
          403,
          'EnterpriseSsoSessionRequired',
          'Single sign-on is required for this Workspace account.',
        )
      }
    }
  }
  const directoryPrincipal = resolveEnterpriseDirectoryPrincipal(
    snapshot,
    principal.userKey,
    principal.groups,
  )
  if (directoryPrincipal.deprovisioned) {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceDirectoryMemberDeprovisioned',
      'Workspace access was deprovisioned by the enterprise directory.',
    )
  }
  const memberDomain = normalizeEnterpriseEmailDomain(workspaceMember.email)
  const verifiedDomains = snapshot.domains.filter((domain) =>
    domain.status === 'verified'
  )
  const managedDomain = verifiedDomains.length === 0 || verifiedDomains.some((domain) =>
    domain.domain === memberDomain
  )
  const external = workspaceMember.role === 'guest' || !managedDomain
  requireEnterpriseExternalAccessAllowed(
    snapshot,
    workspaceMember.email,
    workspaceMember.role,
    recoveryAccount !== undefined,
  )
  const {
    compatibleGroupMappings,
    compatibleRoleAssignments,
    directoryGroupIds,
    directoryGroupMemberships,
  } = directoryPrincipal
  const requiredPermissions = context
    ? resolveRoutePermissions(
        context.req.method,
        context.req.path,
        enterpriseRoutePermissionRules,
      )
    : undefined
  const suppressLegacyWorkspaceRole = directoryPrincipal.directoryManaged ||
    compatibleRoleAssignments.some((assignment) =>
    (
      assignment.principalKind === 'member' && assignment.principalId === principal.userKey ||
      assignment.principalKind === 'directory-group' &&
        (
          assignment.source === 'directory-mapping' ||
          directoryGroupIds.includes(assignment.principalId)
        )
    )
  ) || compatibleGroupMappings.some((mapping) =>
    mapping.enabled
  )
  const enterprisePrincipal = {
    kind: principalKind,
    principalId: principal.userKey,
    directoryGroupIds,
    directoryGroupMemberships,
    workspaceRole: workspaceMember.role,
    includeWorkspaceRolePermissions: !suppressLegacyWorkspaceRole,
    ...(suppressLegacyWorkspaceRole
      ? { directPermissions: ['workspace.read' as const] }
      : {}),
    systemAdministrator: principal.isSystemAdmin,
    ...(external && principalKind !== 'break-glass'
      ? {
          permissionCeiling: snapshot.policy?.externalAccess.permissionCeiling ??
            ['workspace.read', 'members.read', 'teams.read', 'projects.read',
              'work-items.read', 'documents.read', 'files.read',
              'planning.read'] as EnterprisePermissionId[],
        }
      : {}),
  } satisfies EnterprisePrincipalContext
  const enterpriseAuthorizationEvaluation = {
    principal: enterprisePrincipal,
    snapshot,
    assignments: compatibleRoleAssignments,
    groupMappings: compatibleGroupMappings,
  } satisfies EnterpriseAuthorizationEvaluationSnapshot
  const defersToLegacyBusinessAuthorization =
    !suppressLegacyWorkspaceRole &&
    (!external || snapshot.policy === undefined) &&
    principalKind === 'member' &&
    !principal.isSystemAdmin &&
    context !== undefined &&
    shouldDeferEnterpriseContentAuthorization(context.req.path)
  const requestAccess: EnterpriseRequestAccess = options.breakGlassCandidate && recoveryAccount
    ? {
        allowed: true,
        resource: {
          workspaceId: principal.directoryId,
          kind: 'workspace' as const,
        },
        permissions: [] as EnterprisePermissionId[],
        grantedRoutePermissions: [] as EnterprisePermissionId[],
        authorizedAtResource: false,
        projectAccesses: [] as ProjectAccessEntry[],
        authorizedTeamIds: [] as string[],
        teamAccesses: [] as EnterpriseTeamAccess[],
      }
    : defersToLegacyBusinessAuthorization
      ? {
          allowed: true,
          resource: { workspaceId: principal.directoryId, kind: 'workspace' },
          permissions: [],
          grantedRoutePermissions: [],
          authorizedAtResource: false,
          projectAccesses: [],
          authorizedTeamIds: [],
          teamAccesses: [],
        }
    : await evaluateEnterpriseRequestAccess({
        workspaceId: principal.directoryId,
        context,
        requiredPermissions,
        ...enterpriseAuthorizationEvaluation,
      })
  if (!requestAccess.allowed) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'Enterprise permission is required for this operation.',
    )
  }
  if (context && !options.breakGlassCandidate) {
    const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
    const nowSeconds = Math.floor(Date.now() / 1000)
    const authenticatedAt = readNumericClaim(claims?.auth_time) ??
      readNumericClaim(claims?.iat) ??
      nowSeconds
    verifiedAuthenticationMethods ??= await getVerifiedEnterpriseAuthenticationMethods(
      principal.directoryId,
      authenticationSessionId,
    )
    const authenticationMethods = [
      ...new Set([
        ...readCognitoAuthenticationMethods(claims),
        ...verifiedAuthenticationMethods,
      ]),
    ]
    const validation = validateEnterpriseSession(snapshot.policy, {
      authenticatedAt,
      now: nowSeconds,
      authenticationMethods,
      clientIp: resolveEnterpriseClientIp(context),
      privileged: [
        requestAccess.grantedRoutePermission,
        ...(requiredPermissions ?? []),
      ].some((permission) =>
        permission === 'security.manage' ||
        permission === 'identity.manage' ||
        permission === 'members.manage' ||
        permission === 'service-accounts.manage' ||
        permission === 'audit.export'
      ),
      external,
      breakGlass: principalKind === 'break-glass',
    })
    if (!validation.valid) {
      throw new WorkspaceAccessError(
        403,
        resolveEnterpriseSessionErrorCode(validation.reason),
        'Current session does not satisfy the Workspace security policy.',
      )
    }
    if (snapshot.policy) {
      try {
        await workspaceDependencies.enterpriseSessionActivity.validateAndTouch({
          workspaceId: principal.directoryId,
          sessionId: authenticationSessionId,
          authenticatedAt,
          now: nowSeconds,
          idleTimeoutMinutes: snapshot.policy.idleTimeoutMinutes,
          sessionLifetimeMinutes: snapshot.policy.sessionLifetimeMinutes,
          authenticationMethods,
        })
      } catch (error) {
        if (error instanceof EnterpriseSessionActivityError) {
          throw new WorkspaceAccessError(error.status, error.code, error.message, {
            cause: error,
          })
        }
        throw error
      }
    }
  }

  await enforceActiveTenantForRequest(principal.directoryId, context)
  await enforceTenantFeatureForRequest(principal.directoryId, context)

  return {
    ...principal,
    principalKind,
    enterpriseAuthenticationSessionId: authenticationSessionId,
    ...(breakGlassActivation
      ? { enterpriseBreakGlassActivationId: breakGlassActivation.activationId }
      : {}),
    ...(defersToLegacyBusinessAuthorization
      ? {}
      : { enterprisePermissions: requestAccess.permissions }),
    enterpriseIdentityControlRevision:
      snapshot.controlRevision,
    enterpriseAuthorizationResource: requestAccess.resource,
    enterpriseGrantedRoutePermission: requestAccess.grantedRoutePermission,
    enterpriseGrantedRoutePermissions: requestAccess.grantedRoutePermissions,
    enterpriseRouteAuthorizedAtResource: requestAccess.authorizedAtResource,
    enterpriseProjectAccesses: requestAccess.projectAccesses,
    enterpriseAuthorizedTeamIds: requestAccess.authorizedTeamIds,
    enterpriseTeamAccesses: requestAccess.teamAccesses,
    enterpriseLegacyProjectAccessSuppressed: suppressLegacyWorkspaceRole,
    ...(defersToLegacyBusinessAuthorization
      ? {}
      : { enterpriseAuthorizationEvaluation }),
    workspaceMember,
    workspaceRole: workspaceMember.role,
    workspaceMemberStatus: workspaceMember.status,
  }
}

/**
 * Rejects normal authenticated API access after verified account closure.
 *
 * Tenant administration routes remain available for closure evidence and
 * idempotent verification reads; their mutation clients enforce closed state.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param context - Current route context, when authentication is route-bound.
 */
async function enforceActiveTenantForRequest(
  workspaceId: string,
  context?: Context,
): Promise<void> {
  if (!context || context.req.path.startsWith('/api/tenant/')) return
  try {
    await workspaceDependencies.tenantEntitlementEnforcement.assertActive(
      workspaceId,
    )
  } catch (error) {
    if (
      error instanceof TenantAdministrationError &&
      error.code === 'TenantAdministrationNotInitialized'
    ) {
      await initializeLegacyTenantAdministration(workspaceId)
      try {
        await workspaceDependencies.tenantEntitlementEnforcement.assertActive(
          workspaceId,
        )
        return
      } catch (retryError) {
        throw toTenantEntitlementBoundaryError(retryError)
      }
    }
    throw toTenantEntitlementBoundaryError(error)
  }
}

function resolveEnterpriseSessionErrorCode(
  reason: 'mfa-required' | 'session-expired' | 'reauthentication-required' | 'ip-denied' | undefined,
) {
  if (reason === 'mfa-required') return 'EnterpriseSessionMfaRequired'
  if (reason === 'session-expired') return 'EnterpriseSessionExpired'
  if (reason === 'reauthentication-required') {
    return 'EnterpriseSessionReauthenticationRequired'
  }
  if (reason === 'ip-denied') return 'EnterpriseSessionIpDenied'
  return 'EnterpriseSessionDenied'
}

const ENTERPRISE_SERVICE_ACCOUNT_SNAPSHOT_RETRY_LIMIT =
  3

async function readStableEnterpriseServiceAccountSnapshot(
  workspaceId: string,
  accessToken: string,
) {
  for (
    let attempt = 0;
    attempt <
      ENTERPRISE_SERVICE_ACCOUNT_SNAPSHOT_RETRY_LIMIT;
    attempt += 1
  ) {
    const before =
      await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    const account =
      await workspaceDependencies.enterpriseIdentity.serviceAccountAuthentication
        .authenticateServiceAccountToken(
          workspaceId,
          accessToken,
        )
    const after =
      await workspaceDependencies.enterpriseIdentity.read.getSnapshot(workspaceId)
    if (
      before.controlRevision ===
        after.controlRevision
    ) {
      return { account, snapshot: after }
    }
  }
  throw new WorkspaceAccessError(
    409,
    'EnterpriseServiceAccountAuthorizationChanged',
    'Service account authorization changed. Retry the request.',
  )
}

async function authenticateEnterpriseServiceAccount(
  accessToken: string,
  context?: Context,
): Promise<WorkspacePrincipal> {
  const workspaceId = getEnv('MUKUROJI_WORKSPACE_DIRECTORY_ID') ??
    getEnv('MUKUROJI_PROJECT_DIRECTORY_ID')
  if (!workspaceId) {
    throw new WorkspaceAccessError(
      503,
      'WorkspaceDirectoryUnavailable',
      'Workspace directory is not configured.',
    )
  }
  const clientIp = context ? resolveEnterpriseClientIp(context) : undefined
  const requiredPermissions = context
    ? resolveRoutePermissions(
        context.req.method,
        context.req.path,
        enterpriseRoutePermissionRules,
      )
    : undefined
  const authorizeCurrentServiceAccount =
    async () => {
      const { account, snapshot } =
        await readStableEnterpriseServiceAccountSnapshot(
          workspaceId,
          accessToken,
        )
      if (!account) {
        throw new WorkspaceAccessError(
          401,
          'WorkspaceServiceAccountInvalid',
          'Service account credential is invalid or revoked.',
        )
      }
      if (
        account.allowedSourceCidrs.length > 0 &&
        (
          !clientIp ||
          !account.allowedSourceCidrs.some(
            (cidr) =>
              ipMatchesCidr(clientIp, cidr),
          )
        )
      ) {
        throw new WorkspaceAccessError(
          403,
          'EnterpriseServiceAccountIpDenied',
          'Service account source IP is not allowed.',
        )
      }
      const serviceAccountPrincipal = {
        kind: 'service-account',
        principalId: account.accountId,
        directoryGroupIds: [],
        includeWorkspaceRolePermissions: false,
        directPermissions: [
          'service-accounts.use' as const,
        ],
      } satisfies EnterprisePrincipalContext
      const serviceAccountAssignments = [
        ...snapshot.roleAssignments,
        {
          workspaceId,
          assignmentId:
            `service-account-scope:${account.accountId}`,
          principalKind:
            'service-account' as const,
          principalId: account.accountId,
          roleId: account.roleId,
          scope: account.scope,
          source: 'system' as const,
        },
      ]
      const enterpriseAuthorizationEvaluation = {
        principal: serviceAccountPrincipal,
        snapshot,
        assignments:
          serviceAccountAssignments,
        groupMappings: snapshot.groupMappings,
      } satisfies EnterpriseAuthorizationEvaluationSnapshot
      const requestAccess =
        await evaluateEnterpriseRequestAccess({
          workspaceId,
          context,
          requiredPermissions,
          ...enterpriseAuthorizationEvaluation,
        })
      if (!requestAccess.allowed) {
        throw new WorkspaceAccessError(
          403,
          'WorkspacePermissionDenied',
          'Service account does not have permission for this operation.',
        )
      }
      if (context) {
        const validation =
          validateEnterpriseSession(
            snapshot.policy,
            {
              authenticatedAt:
                Math.floor(Date.now() / 1000),
              now: Math.floor(
                Date.now() / 1000,
              ),
              authenticationMethods: [
                'service-account',
                'mfa',
              ],
              clientIp,
              privileged: true,
              external: false,
              breakGlass: false,
            },
          )
        if (
          !validation.valid &&
          validation.reason === 'ip-denied'
        ) {
          throw new WorkspaceAccessError(
            403,
            'EnterpriseSessionIpDenied',
            'Service account source IP is not allowed.',
          )
        }
      }
      return {
        account,
        enterpriseAuthorizationEvaluation,
        requestAccess,
        snapshot,
      }
    }
  let authorization =
    await authorizeCurrentServiceAccount()
  const authenticatedAccount =
    authorization.account
  const serviceAccountAuditContext = context
    ? createRequestMutationContext(
        context,
        workspaceId,
        authenticatedAccount.accountId,
        authenticatedAccount.displayName,
        {
          accountId:
            authenticatedAccount.accountId,
          authenticated: true,
        },
        `service-account-auth:${crypto.randomUUID()}`,
        'service',
      )
    : createMutationAuditContext({
        workspaceId,
        actor: {
          id: authenticatedAccount.accountId,
          kind: 'service',
          displayName:
            authenticatedAccount.displayName,
        },
        idempotencyKey:
          `service-account-auth:${crypto.randomUUID()}`,
        request: {
          method: 'SERVICE_AUTH',
          path:
            `/enterprise/service-accounts/${authenticatedAccount.accountId}/authenticate`,
          body: {
            accountId:
              authenticatedAccount.accountId,
            authenticated: true,
          },
        },
        source: {
          kind: 'system',
          method: 'SERVICE_AUTH',
          route:
            '/enterprise/service-accounts/:accountId/authenticate',
        },
      })
  await workspaceDependencies.enterpriseIdentity.serviceAccountAuthentication.recordServiceAccountUse(
    workspaceId,
    authenticatedAccount.accountId,
    serviceAccountAuditContext,
  )
  authorization =
    await authorizeCurrentServiceAccount()
  const {
    account,
    enterpriseAuthorizationEvaluation,
    requestAccess,
    snapshot,
  } = authorization
  if (
    account.accountId !==
      authenticatedAccount.accountId
  ) {
    throw new WorkspaceAccessError(
      401,
      'WorkspaceServiceAccountInvalid',
      'Service account credential is invalid or revoked.',
    )
  }
  const workspaceMember = {
    id: account.accountId,
    memberKey: account.accountId,
    email: `${account.accountId}@service-account.invalid`,
    name: account.displayName,
    role: 'member',
    status: 'active',
    provisioningSource: 'directory',
    externalIdentityId: account.accountId,
    version: 1,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  } satisfies WorkspaceMember
  await enforceTenantFeatureForRequest(workspaceId, context)
  return {
    directoryId: workspaceId,
    userKey: account.accountId,
    actorId: account.accountId,
    isSystemAdmin: false,
    groups: [],
    principalKind: 'service-account',
    enterprisePermissions: requestAccess.permissions,
    enterpriseIdentityControlRevision:
      snapshot.controlRevision,
    enterpriseAuthorizationResource: requestAccess.resource,
    enterpriseGrantedRoutePermission: requestAccess.grantedRoutePermission,
    enterpriseGrantedRoutePermissions: requestAccess.grantedRoutePermissions,
    enterpriseRouteAuthorizedAtResource: requestAccess.authorizedAtResource,
    enterpriseProjectAccesses: requestAccess.projectAccesses,
    enterpriseAuthorizedTeamIds: requestAccess.authorizedTeamIds,
    enterpriseTeamAccesses: requestAccess.teamAccesses,
    enterpriseLegacyProjectAccessSuppressed: true,
    enterpriseAuthorizationEvaluation,
    workspaceMember,
    workspaceRole: 'member',
    workspaceMemberStatus: 'active',
  }
}

/**
 * Current HTTP request の enterprise authorization 評価入力です。
 */
type EnterpriseRequestAccessInput = {
  /** Resource が属する Workspace ID です。 */
  workspaceId: string
  /** Current HTTP request です。 */
  context?: Context
  /** Headless caller が server-side state から解決した authorization resource です。 */
  resource?: EnterpriseAuthorizationResource
  /** Headless collection 操作で Team/Project descendant scope を列挙するかどうかです。 */
  evaluateProjectScopes?: boolean
  /** Route rule が要求する primary/alternative permission です。 */
  requiredPermissions?: readonly EnterprisePermissionId[]
  /** Directory、guest ceiling、principal kind を解決済みの principal です。 */
  principal: EnterprisePrincipalContext
  /** Current authoritative enterprise state です。 */
  snapshot: EnterpriseIdentitySnapshot
  /** Provider binding と current membership に適合した role assignment です。 */
  assignments: EnterpriseIdentitySnapshot['roleAssignments']
  /** Provider binding と current membership に適合した group mapping です。 */
  groupMappings: EnterpriseIdentitySnapshot['groupMappings']
}

/**
 * Current HTTP request の enterprise authorization 評価結果です。
 */
type EnterpriseRequestAccess = {
  /** Primary または alternative permission で route を許可したかどうかです。 */
  allowed: boolean
  /** URL/body/canonical entity から解決した authorization resource です。 */
  resource: EnterpriseAuthorizationResource
  /** Current resource または絞り込み可能な Project 上で有効な permission です。 */
  permissions: EnterprisePermissionId[]
  /** Route を実際に許可した primary/alternative permission です。 */
  grantedRoutePermission?: EnterprisePermissionId
  /** Route 候補として少なくとも1つの scope で実際に許可された permission です。 */
  grantedRoutePermissions: EnterprisePermissionId[]
  /** URL/body/canonical entity の resource 自体で route を許可したかどうかです。 */
  authorizedAtResource: boolean
  /** Current route permission で読み書きできる Project と相当 role です。 */
  projectAccesses: ProjectAccessEntry[]
  /** Current route permission で独立して読み書きできる Team ID です。 */
  authorizedTeamIds: string[]
  /** Current route で Team ごとに有効な enterprise permission です。 */
  teamAccesses: EnterpriseTeamAccess[]
}

/**
 * Route permission を canonical resource と scoped collection の両方で評価します。
 *
 * @remarks
 * Team/Project scope の grant で collection endpoint を許可する場合、認可済み Team ID
 * と Project 一覧を principal に保持し、handler 側の response/query を同じ範囲へ絞り込みます。
 */
async function evaluateEnterpriseRequestAccess(
  input: EnterpriseRequestAccessInput,
): Promise<EnterpriseRequestAccess> {
  const resource = input.resource ?? await resolveEnterpriseAuthorizationResource(
    input.workspaceId,
    input.context,
  )
  if (!input.requiredPermissions || input.requiredPermissions.length === 0) {
    return {
      allowed: input.context === undefined,
      resource,
      permissions: input.principal.directPermissions ?? [],
      grantedRoutePermissions: [],
      authorizedAtResource: input.context === undefined,
      projectAccesses: [],
      authorizedTeamIds: [],
      teamAccesses: [],
    }
  }

  const evaluateResource = (candidateResource: EnterpriseAuthorizationResource) => {
    const decisions = input.requiredPermissions!.map((permission) => ({
      permission,
      access: evaluateEnterpriseAccess({
        permission,
        principal: input.principal,
        assignments: input.assignments,
        customRoles: input.snapshot.customRoles,
        groupMappings: input.groupMappings,
        resource: candidateResource,
      }),
    }))
    return {
      decisions,
      granted: decisions.find((decision) => decision.access.allowed),
    }
  }
  const direct = evaluateResource(resource)
  const grantedRoutePermissions = new Set<EnterprisePermissionId>()
  for (const decision of direct.decisions) {
    if (decision.access.allowed) grantedRoutePermissions.add(decision.permission)
  }
  const projectAccesses: ProjectAccessEntry[] = []
  const authorizedTeamIds = new Set<string>()
  const teamPermissionsById = new Map<string, Set<EnterprisePermissionId>>()
  const scopedPermissions = new Set<EnterprisePermissionId>()
  let scopedGrantedRoutePermission: EnterprisePermissionId | undefined
  const addTeamAccess = (
    teamId: string,
    permissions: readonly EnterprisePermissionId[],
  ) => {
    authorizedTeamIds.add(teamId)
    const teamPermissions = teamPermissionsById.get(teamId) ??
      new Set<EnterprisePermissionId>()
    for (const permission of permissions) teamPermissions.add(permission)
    teamPermissionsById.set(teamId, teamPermissions)
  }

  if (direct.granted && resource.kind === 'team' && resource.targetId) {
    addTeamAccess(resource.targetId, direct.granted.access.permissions)
  }

  if (
    input.evaluateProjectScopes === true ||
    (
      input.context &&
      shouldEvaluateEnterpriseProjectScopes(input.context.req.path, resource)
    )
  ) {
    const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(input.workspaceId, 'ja')
    const teams = directory.teams.filter((team) =>
      resource.kind === 'workspace' ||
      resource.kind === 'team' && resource.targetId === team.id ||
      resource.kind === 'project' && team.projects.some((project) =>
        resource.targetId === project.id
      )
    )
    if (resource.kind === 'workspace') {
      for (const team of teams) {
        const scoped = evaluateResource({
          workspaceId: input.workspaceId,
          kind: 'team',
          targetId: team.id,
        })
        for (const decision of scoped.decisions) {
          if (decision.access.allowed) grantedRoutePermissions.add(decision.permission)
        }
        if (!scoped.granted) continue
        scopedGrantedRoutePermission ??= scoped.granted.permission
        for (const permission of scoped.granted.access.permissions) {
          scopedPermissions.add(permission)
        }
        addTeamAccess(team.id, scoped.granted.access.permissions)
      }
    }
    const projects = teams.flatMap((team) =>
      team.projects
        .filter((project) => resource.kind !== 'project' || resource.targetId === project.id)
        .map((project) => ({
          projectId: project.id,
          teamId: team.id,
        }))
    )
    for (const project of projects) {
      const scoped = evaluateResource({
        workspaceId: input.workspaceId,
        kind: 'project',
        targetId: project.projectId,
        parentTeamId: project.teamId,
      })
      for (const decision of scoped.decisions) {
        if (decision.access.allowed) grantedRoutePermissions.add(decision.permission)
      }
      if (!scoped.granted) continue
      scopedGrantedRoutePermission ??= scoped.granted.permission
      for (const permission of scoped.granted.access.permissions) {
        scopedPermissions.add(permission)
      }
      projectAccesses.push({
        projectId: project.projectId,
        role: resolveEnterpriseProjectRole([scoped.granted.permission]),
        teamId: project.teamId,
      })
    }
  }

  const permissions = direct.granted
    ? direct.granted.access.permissions
    : [...scopedPermissions]
  return {
    allowed:
      direct.granted !== undefined ||
      authorizedTeamIds.size > 0 ||
      projectAccesses.length > 0,
    resource,
    permissions,
    grantedRoutePermission: direct.granted?.permission ?? scopedGrantedRoutePermission,
    grantedRoutePermissions: [...grantedRoutePermissions],
    authorizedAtResource: direct.granted !== undefined,
    projectAccesses,
    authorizedTeamIds: [...authorizedTeamIds],
    teamAccesses: [...teamPermissionsById].map(([teamId, permissions]) => ({
      teamId,
      permissions: [...permissions],
    })),
  }
}

/**
 * Team/Project scope の grant で安全に絞り込める resource-oriented route か判定します。
 */
function shouldEvaluateEnterpriseProjectScopes(
  path: string,
  resource: EnterpriseAuthorizationResource,
) {
  if (resource.kind === 'project') return true
  return /^\/api\/(?:analytics|approvals|bulk-operations|document-backlinks|documents|planning|projects|realtime\/tickets|teams|work-item-configuration|work-items)(?:\/|$)/u
    .test(path)
}

/**
 * Enterprise assignment がない既存ユーザーについて domain handler の legacy ACL を使うか判定します。
 */
function shouldDeferEnterpriseContentAuthorization(path: string) {
  return !path.startsWith('/api/enterprise/') &&
    path !== '/api/enterprise' &&
    !path.startsWith('/api/audit/') &&
    path !== '/api/audit' &&
    !path.startsWith('/api/workspace/') &&
    path !== '/api/workspace' &&
    !path.startsWith('/api/tenant/')
}

/**
 * Enterprise permission set を legacy handler が扱う Project role へ縮約します。
 */
function resolveEnterpriseProjectRole(
  permissions: readonly EnterprisePermissionId[],
): ProjectRole {
  if (permissions.some((permission) => permission.endsWith('.manage'))) {
    return 'manager'
  }
  if (
    permissions.some((permission) =>
      permission.endsWith('.write') || permission === 'files.approve'
    )
  ) {
    return 'member'
  }
  return 'viewer'
}

async function resolveEnterpriseAuthorizationResource(
  workspaceId: string,
  context: Context | undefined,
): Promise<EnterpriseAuthorizationResource> {
  const path = context?.req.path
  const issueMatch = path?.match(/\/teams\/([^/]+)\/issues\/([^/]+)/u)
  let teamId = issueMatch?.[1] ? decodeURIComponent(issueMatch[1]) : undefined
  let issueId = issueMatch?.[2] ? decodeURIComponent(issueMatch[2]) : undefined
  if (path === '/api/realtime/tickets' && context?.req.method === 'POST') {
    const body = await context.req.raw.clone().json().catch(() => undefined) as
      | Record<string, unknown>
      | undefined
    teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : undefined
    issueId = typeof body?.issueId === 'string' ? body.issueId.trim() : undefined
  }
  if (teamId && issueId) {
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
      workspaceId,
      teamId,
      issueId,
      { consistentIssueRead: true, eventLimit: 0 },
    )
    if (detail.issue.assignedProjectId) {
      return {
        workspaceId,
        kind: 'project',
        targetId: detail.issue.assignedProjectId,
        parentTeamId: teamId,
      }
    }
    return { workspaceId, kind: 'team', targetId: teamId }
  }
  const issueCollectionMatch = path?.match(/\/teams\/([^/]+)\/issues$/u)
  if (issueCollectionMatch?.[1] && context?.req.method === 'POST') {
    const issueTeamId = decodeURIComponent(issueCollectionMatch[1])
    const body = await context.req.raw.clone().json().catch(() => undefined)
    const assignedProjectId = isRecord(body) && typeof body.assignedProjectId === 'string'
      ? body.assignedProjectId.trim()
      : undefined
    if (assignedProjectId) {
      return {
        workspaceId,
        kind: 'project',
        targetId: assignedProjectId,
        parentTeamId: issueTeamId,
      }
    }
    return { workspaceId, kind: 'team', targetId: issueTeamId }
  }
  if (path?.startsWith('/api/planning/work-item-links/')) {
    const linkMatch = path.match(/\/work-item-links\/([^/]+)\/([^/]+)/u)
    const linkTeamId = linkMatch?.[1] ? decodeURIComponent(linkMatch[1]) : undefined
    const workItemId = linkMatch?.[2] ? decodeURIComponent(linkMatch[2]) : undefined
    if (linkTeamId && workItemId) {
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        workspaceId,
        linkTeamId,
        workItemId,
        { consistentIssueRead: true, eventLimit: 0 },
      )
      if (detail.issue.assignedProjectId) {
        return {
          workspaceId,
          kind: 'project',
          targetId: detail.issue.assignedProjectId,
          parentTeamId: linkTeamId,
        }
      }
      return { workspaceId, kind: 'team', targetId: linkTeamId }
    }
  }
  if (path?.startsWith('/api/planning/entities')) {
    const entityId = path.match(/\/planning\/entities\/([^/]+)/u)?.[1]
    if (entityId) {
      const authorizationState = await workItemDependencies.planning.getAuthorizationState(workspaceId)
      const entity = authorizationState.entities.find((candidate) =>
        candidate.id === decodeURIComponent(entityId)
      )
      if (entity?.projectId) {
        return {
          workspaceId,
          kind: 'project',
          targetId: entity.projectId,
          parentTeamId: entity.teamId,
        }
      }
      if (entity?.teamId) {
        return { workspaceId, kind: 'team', targetId: entity.teamId }
      }
    } else if (context?.req.method === 'POST') {
      const body = await context.req.raw.clone().json().catch(() => undefined)
      const planningProjectId = isRecord(body) && typeof body.projectId === 'string'
        ? body.projectId.trim()
        : undefined
      const planningTeamId = isRecord(body) && typeof body.teamId === 'string'
        ? body.teamId.trim()
        : undefined
      if (planningProjectId) {
        return {
          workspaceId,
          kind: 'project',
          targetId: planningProjectId,
          ...(planningTeamId ? { parentTeamId: planningTeamId } : {}),
        }
      }
      if (planningTeamId) {
        return { workspaceId, kind: 'team', targetId: planningTeamId }
      }
    }
  }
  const planningCycleId = path?.match(/\/api\/planning\/cycles\/([^/]+)/u)?.[1]
  if (planningCycleId) {
    const authorizationState = await workItemDependencies.planning.getAuthorizationState(workspaceId)
    const cycle = authorizationState.entities.find((candidate) =>
      candidate.id === decodeURIComponent(planningCycleId)
    )
    if (cycle?.projectId) {
      return {
        workspaceId,
        kind: 'project',
        targetId: cycle.projectId,
        parentTeamId: cycle.teamId,
      }
    }
    if (cycle?.teamId) {
      return { workspaceId, kind: 'team', targetId: cycle.teamId }
    }
  }
  if (path === '/api/projects/quick-access') {
    return { workspaceId, kind: 'workspace' as const }
  }
  const projectId = path?.match(/\/projects\/([^/]+)/u)?.[1]
  if (projectId) {
    const decodedProjectId = decodeURIComponent(projectId)
    const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja')
    const parentTeamId = directory.teams.find((team) =>
      team.projects.some((project) => project.id === decodedProjectId)
    )?.id
    return {
      workspaceId,
      kind: 'project' as const,
      targetId: decodedProjectId,
      parentTeamId,
    }
  }
  if (path === '/api/teams/projects') {
    return { workspaceId, kind: 'workspace' as const }
  }
  const pathTeamId = path?.match(/\/teams\/([^/]+)/u)?.[1]
  if (pathTeamId) {
    return {
      workspaceId,
      kind: 'team' as const,
      targetId: decodeURIComponent(pathTeamId),
    }
  }
  return { workspaceId, kind: 'workspace' as const }
}

function readNumericClaim(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : typeof value === 'string' && /^\d+$/u.test(value)
      ? Number(value)
      : undefined
}

function readAuthenticationMethods(claims: CognitoAccessTokenClaims | undefined) {
  const value = claims?.['cognito:amr'] ?? claims?.amr
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? value.split(/[\s,]+/u).filter(Boolean)
      : []
}

function readCognitoAuthenticationMethods(
  claims: CognitoAccessTokenClaims | undefined,
) {
  return readAuthenticationMethods(claims).filter((method) =>
    !isEnterpriseSsoAuthenticationMethod(method)
  )
}

function resolveEnterpriseClientIp(c: Context) {
  let transportSource: string | undefined
  try {
    transportSource = getConnInfo(c).remote.address
  } catch {
    transportSource = undefined
  }
  return resolveRequestClientKey(
    transportSource,
    c.req.header('X-Forwarded-For'),
    new Set(
      (getEnv('MUKUROJI_REQUEST_TRUSTED_PROXY_ADDRESSES') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )
}

async function requireEnterpriseSecurityPrincipal(
  c: Context,
): Promise<EnterpriseSecurityPrincipal> {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    throw new EnterpriseIdentityError(
      401,
      'EnterpriseAuthenticationRequired',
      'Bearer token is required.',
    )
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
  if (principal.enterprisePermissions === undefined) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'Enterprise permission is required for this operation.',
    )
  }
  return {
    ...principal,
    enterprisePermissions: principal.enterprisePermissions,
  }
}

function toEnterpriseIdentityErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof EnterpriseIdentityError)) {
    console.error(error)
    return c.json({
      code: 'EnterpriseIdentityUnavailable',
      message: 'Enterprise identity service is unavailable.',
    }, 503)
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 429 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  }, status)
}

function toEnterpriseIdentityBoundaryErrorResponse(c: Context, error: unknown) {
  if (error instanceof EnterpriseIdentityError) {
    return toEnterpriseIdentityErrorResponse(c, error)
  }
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(c, error)
  }
  if (error instanceof CognitoServiceError) {
    return toAuthErrorResponse(c, error)
  }
  if (error instanceof ProjectDataError || error instanceof PlanningError) {
    return toProjectDataErrorResponse(c, error)
  }
  console.error(error)
  return c.json({
    code: 'EnterpriseIdentityUnavailable',
    message: 'Enterprise identity service is unavailable.',
  }, 503)
}

function readEnterpriseIdentityProviderInput(
  workspaceId: string,
  body: Record<string, unknown> | undefined,
  existing: EnterpriseIdentityProvider | undefined,
): EnterpriseIdentityProvider {
  const nowIso = new Date().toISOString()
  const providerId = existing?.providerId ?? crypto.randomUUID()
  const status = 'draft'
  const displayName = readEnterpriseText(body?.displayName, 'Identity provider name')
  const cognitoProviderName = requireEnterpriseCognitoProviderName()
  const issuer = readEnterpriseText(body?.issuer, 'Identity provider issuer')
  const ssoUrl = readEnterpriseText(body?.ssoUrl, 'Identity provider SSO URL')
  if (body?.protocol === 'oidc') {
    const issuerUrl = new URL(issuer)
    return {
      workspaceId,
      providerId,
      kind: 'oidc',
      displayName,
      cognitoProviderName,
      status,
      revision: (existing?.revision ?? 0) + 1,
      issuer: issuerUrl.toString(),
      clientId: readEnterpriseText(body?.clientId, 'OIDC client ID'),
      authorizationEndpoint: new URL(ssoUrl).toString(),
      tokenEndpoint: new URL('/token', issuerUrl).toString(),
      jwksUri: new URL('/.well-known/jwks.json', issuerUrl).toString(),
      scopes: ['openid', 'email', 'profile'],
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    } satisfies EnterpriseIdentityProvider
  }
  return {
    workspaceId,
    providerId,
    kind: 'saml',
    displayName,
    cognitoProviderName,
    status,
    revision: (existing?.revision ?? 0) + 1,
    entityId: issuer,
    singleSignOnUrl: new URL(ssoUrl).toString(),
    metadataUrl: new URL(readEnterpriseText(body?.metadataUrl, 'SAML metadata URL')).toString(),
    certificateFingerprints: [],
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  } satisfies EnterpriseIdentityProvider
}

function enterpriseIdentityProviderMatchesInput(
  provider: EnterpriseIdentityProvider,
  body: Record<string, unknown> | undefined,
) {
  if (!body) return false
  if (
    provider.cognitoProviderName !== getEnv('COGNITO_ENTERPRISE_IDP_NAME')?.trim() ||
    body.protocol !== provider.kind ||
    typeof body.displayName !== 'string' ||
    body.displayName.trim() !== provider.displayName ||
    typeof body.issuer !== 'string' ||
    typeof body.ssoUrl !== 'string' ||
    typeof body.clientId !== 'string'
  ) return false
  try {
    if (provider.kind === 'oidc') {
      return new URL(body.issuer).toString() === provider.issuer &&
        new URL(body.ssoUrl).toString() === provider.authorizationEndpoint &&
        body.clientId.trim() === provider.clientId
    }
    return body.issuer.trim() === provider.entityId &&
      new URL(body.ssoUrl).toString() === provider.singleSignOnUrl &&
      typeof body.metadataUrl === 'string' &&
      new URL(body.metadataUrl).toString() === provider.metadataUrl
  } catch {
    return false
  }
}

/**
 * Validates Enterprise Identity provider metadata against its remote endpoints.
 *
 * @param provider - Normalized provider configuration to validate.
 * @returns The validated provider configuration.
 */
export async function testEnterpriseIdentityProviderConnection(
  provider: EnterpriseIdentityProvider,
): Promise<EnterpriseIdentityProvider> {
  try {
    assertEnterpriseCognitoProviderBinding(
      provider,
      requireEnterpriseCognitoProviderName(),
    )
    await assertEnterpriseCognitoFederationProvider(provider)
    if (provider.kind === 'oidc') {
      const issuer = provider.issuer.replace(/\/$/u, '')
      const discoveryUrl = new URL(`${issuer}/.well-known/openid-configuration`)
      const discovery = await fetchEnterpriseIdentityJson(discoveryUrl)
      const discoveredIssuer = readEnterpriseMetadataUrl(discovery.issuer, 'OIDC issuer')
      const authorizationEndpoint = readEnterpriseMetadataUrl(
        discovery.authorization_endpoint,
        'OIDC authorization endpoint',
      )
      const tokenEndpoint = readEnterpriseMetadataUrl(
        discovery.token_endpoint,
        'OIDC token endpoint',
      )
      const jwksUri = readEnterpriseMetadataUrl(discovery.jwks_uri, 'OIDC JWKS endpoint')
      await Promise.all([
        assertEnterpriseIdentityPublicUrl(discoveredIssuer),
        assertEnterpriseIdentityPublicUrl(authorizationEndpoint),
        assertEnterpriseIdentityPublicUrl(tokenEndpoint),
        assertEnterpriseIdentityPublicUrl(jwksUri),
      ])
      if (
        discoveredIssuer.toString().replace(/\/$/u, '') !== issuer ||
        authorizationEndpoint.toString() !== provider.authorizationEndpoint
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseOidcMetadataMismatch',
          'OIDC discovery metadata does not match the configured issuer or authorization URL.',
        )
      }
      const jwks = await fetchEnterpriseIdentityJson(jwksUri)
      if (
        !Array.isArray(jwks.keys) ||
        !jwks.keys.some((key) =>
          isRecord(key) &&
          typeof key.kty === 'string' &&
          (key.use === undefined || key.use === 'sig')
        )
      ) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseOidcSigningKeyMissing',
          'OIDC JWKS metadata does not contain a signing key.',
        )
      }
      return {
        ...provider,
        status: 'active',
        tokenEndpoint: tokenEndpoint.toString(),
        jwksUri: jwksUri.toString(),
        updatedAt: new Date().toISOString(),
        lastTestedAt: new Date().toISOString(),
      }
    }

    const metadataUrl = new URL(provider.metadataUrl)
    const metadata = await fetchEnterpriseIdentityText(metadataUrl, 'application/samlmetadata+xml')
    const entityDescriptor = metadata.match(
      /<(?:[A-Za-z0-9_-]+:)?EntityDescriptor\b[^>]*>/iu,
    )?.[0]
    const entityId = entityDescriptor
      ? readXmlAttribute(entityDescriptor, 'entityID')
      : undefined
    const ssoLocations = [...metadata.matchAll(
      /<(?:[A-Za-z0-9_-]+:)?SingleSignOnService\b[^>]*>/giu,
    )]
      .map((match) => readXmlAttribute(match[0], 'Location'))
      .filter((value): value is string => Boolean(value))
      .map((value) => new URL(decodeEnterpriseXml(value)).toString())
    await Promise.all(ssoLocations.map((location) =>
      assertEnterpriseIdentityPublicUrl(new URL(location))
    ))
    if (
      !entityId ||
      decodeEnterpriseXml(entityId) !== provider.entityId ||
      !ssoLocations.includes(provider.singleSignOnUrl)
    ) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseSamlMetadataMismatch',
        'SAML metadata does not match the configured entity ID or SSO URL.',
      )
    }
    const certificates = [...metadata.matchAll(
      /<(?:[A-Za-z0-9_-]+:)?X509Certificate\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?X509Certificate>/giu,
    )]
      .map((match) => match[1]?.replace(/\s+/gu, ''))
      .filter((value): value is string => Boolean(value))
      .map((value) => new X509Certificate(
        `-----BEGIN CERTIFICATE-----\n${value}\n-----END CERTIFICATE-----`,
      ))
    const now = Date.now()
    const validCertificates = certificates.filter((certificate) =>
      Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now
    )
    if (validCertificates.length === 0) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseSamlCertificateMissing',
        'SAML metadata does not contain a currently valid signing certificate.',
      )
    }
    return {
      ...provider,
      status: 'active',
      certificateFingerprints: [
        ...new Set(validCertificates.map((certificate) =>
          certificate.fingerprint256.replaceAll(':', '').toLowerCase()
        )),
      ],
      updatedAt: new Date().toISOString(),
      lastTestedAt: new Date().toISOString(),
    }
  } catch (error) {
    if (error instanceof EnterpriseIdentityError) throw error
    throw new EnterpriseIdentityError(
      502,
      'EnterpriseIdentityProviderTestFailed',
      'Identity provider metadata could not be verified.',
      true,
      { cause: error },
    )
  }
}

async function assertEnterpriseCognitoFederationProvider(
  provider: EnterpriseIdentityProvider,
  inspectionMode: EnterpriseCognitoInspectionMode = 'fresh',
) {
  if (!authenticationDependencies.cognito.describeEnterpriseIdentityProvider) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoProviderInspectionUnavailable',
      'Cognito federation provider inspection is unavailable.',
    )
  }
  let binding: EnterpriseCognitoFederationBinding
  try {
    const cacheKey = `${getEnv('COGNITO_USER_POOL_ID')?.trim() ?? ''}\0${
      provider.cognitoProviderName
    }`
    const loadBinding = () => authenticationDependencies.cognito.describeEnterpriseIdentityProvider!(
      provider.cognitoProviderName,
    )
    const cache = getEnterpriseCognitoFederationBindingCache()
    binding = inspectionMode === 'cached'
      ? await cache.read(cacheKey, loadBinding)
      : await cache.refresh(cacheKey, loadBinding)
  } catch (error) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseCognitoProviderNotFound',
      'The configured Cognito federation provider could not be verified.',
      false,
      { cause: error },
    )
  }
  assertEnterpriseCognitoFederationBinding(
    provider,
    requireEnterpriseCognitoProviderName(),
    binding,
  )
}

async function assertEnterpriseCognitoSsoAppClient(
  provider: EnterpriseIdentityProvider,
  inspectionMode: EnterpriseCognitoInspectionMode = 'fresh',
) {
  const configuration = requireEnterpriseCognitoSsoAppClientConfiguration()
  if (!authenticationDependencies.cognito.describeEnterpriseSsoAppClient) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoSsoAppClientInspectionUnavailable',
      'Cognito SSO app client inspection is unavailable.',
    )
  }
  let binding: EnterpriseCognitoSsoAppClientBinding
  try {
    const cacheKey = `${getEnv('COGNITO_USER_POOL_ID')?.trim() ?? ''}\0${
      configuration.clientId
    }`
    const loadBinding = () => authenticationDependencies.cognito.describeEnterpriseSsoAppClient!(
      configuration.clientId,
    )
    const cache = getEnterpriseCognitoSsoAppClientBindingCache()
    binding = inspectionMode === 'cached'
      ? await cache.read(cacheKey, loadBinding)
      : await cache.refresh(cacheKey, loadBinding)
  } catch (error) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoSsoAppClientUnavailable',
      'The configured Cognito SSO app client could not be verified.',
      true,
      { cause: error },
    )
  }
  const requiredScopes = new Set(['openid', 'email', 'profile'])
  const actualScopes = new Set(binding.allowedOAuthScopes)
  if (
    binding.clientId !== configuration.clientId ||
    binding.hasClientSecret ||
    !binding.allowedOAuthFlowsUserPoolClient ||
    binding.supportedIdentityProviders.length !== 1 ||
    binding.supportedIdentityProviders[0] !== provider.cognitoProviderName ||
    provider.cognitoProviderName !== configuration.identityProviderName ||
    binding.allowedOAuthFlows.length !== 1 ||
    binding.allowedOAuthFlows[0] !== 'code' ||
    binding.explicitAuthFlows.length !== 1 ||
    binding.explicitAuthFlows[0] !== 'ALLOW_REFRESH_TOKEN_AUTH' ||
    actualScopes.size !== requiredScopes.size ||
    [...requiredScopes].some((scope) => !actualScopes.has(scope)) ||
    binding.callbackUrls.length !== 1 ||
    binding.callbackUrls[0] !== configuration.redirectUri
  ) {
    throw new EnterpriseIdentityError(
      503,
      'EnterpriseCognitoSsoAppClientBindingInvalid',
      'Cognito SSO app client does not match the required enterprise federation contract.',
    )
  }
}

async function assertEnterpriseRuntimeCognitoProviders(
  snapshot: EnterpriseIdentitySnapshot,
  principalId: string,
  email: string,
) {
  const normalizedPrincipalId = principalId.trim().toLowerCase()
  const providerIds = new Set(
    snapshot.scimUsers
      .filter((user) =>
        user.active &&
        user.appliedVersion >= user.version &&
        user.linkedMemberKey?.trim().toLowerCase() === normalizedPrincipalId
      )
      .map((user) => user.identityProviderId),
  )
  const emailDomain = normalizeEnterpriseEmailDomain(email)
  for (const domain of snapshot.domains) {
    if (
      domain.status !== 'verified' ||
      !domain.enforceSso ||
      domain.domain !== emailDomain
    ) continue
    if (!domain.identityProviderId) {
      throw new EnterpriseIdentityError(
        503,
        'EnterpriseIdentityStateInvalid',
        'An enforced enterprise domain is missing its identity provider binding.',
      )
    }
    providerIds.add(domain.identityProviderId)
  }
  for (const providerId of providerIds) {
    const provider = snapshot.identityProviders.find((candidate) =>
      candidate.providerId === providerId
    )
    assertEnterpriseIdentityProviderReady(provider)
    await assertEnterpriseCognitoFederationProvider(provider, 'cached')
    await assertEnterpriseCognitoSsoAppClient(provider, 'cached')
  }
}

async function fetchEnterpriseIdentityJson(url: URL) {
  const text = await fetchEnterpriseIdentityText(url, 'application/json')
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseIdentityProviderMetadataInvalid',
      'Identity provider metadata must be a JSON object.',
    )
  }
  return parsed
}

async function fetchEnterpriseIdentityText(url: URL, accept: string) {
  const [address] = await assertEnterpriseIdentityPublicUrl(url)
  if (!address) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityProviderUrlPrivate',
      'Identity provider metadata URL did not resolve to a public address.',
    )
  }
  return new Promise<string>((resolve, reject) => {
    const request = requestHttps({
      hostname: address,
      port: url.port ? Number(url.port) : 443,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      headers: {
        Accept: accept,
        Host: url.host,
        'User-Agent': 'mukuroji-enterprise-identity-verifier/1',
      },
      rejectUnauthorized: true,
      timeout: 7_500,
    }, (response) => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new EnterpriseIdentityError(
          502,
          'EnterpriseIdentityProviderMetadataUnavailable',
          'Identity provider metadata endpoint did not return a successful response.',
          true,
        ))
        return
      }
      const contentLength = Number(response.headers['content-length'] ?? 0)
      if (contentLength > 1_048_576) {
        response.resume()
        reject(new EnterpriseIdentityError(
          409,
          'EnterpriseIdentityProviderMetadataTooLarge',
          'Identity provider metadata exceeds the one megabyte limit.',
        ))
        return
      }
      const chunks: Buffer[] = []
      let totalLength = 0
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalLength += buffer.length
        if (totalLength > 1_048_576) {
          response.destroy(new EnterpriseIdentityError(
            409,
            'EnterpriseIdentityProviderMetadataTooLarge',
            'Identity provider metadata exceeds the one megabyte limit.',
          ))
          return
        }
        chunks.push(buffer)
      })
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) {
          reject(new EnterpriseIdentityError(
            409,
            'EnterpriseIdentityProviderMetadataInvalid',
            'Identity provider metadata is empty.',
          ))
          return
        }
        resolve(text)
      })
    })
    request.on('timeout', () => request.destroy(new Error('Metadata request timed out.')))
    request.on('error', reject)
    request.end()
  })
}

async function assertEnterpriseIdentityPublicUrl(url: URL) {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.hostname.toLowerCase() === 'localhost' ||
    url.hostname.toLowerCase().endsWith('.local')
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityProviderUrlInvalid',
      'Identity provider metadata must use a public HTTPS URL.',
    )
  }
  const literalAddressFamily = isIP(url.hostname)
  const addresses = literalAddressFamily
    ? [url.hostname]
    : (await Promise.allSettled([
        resolve4(url.hostname),
        resolve6(url.hostname),
      ])).flatMap((resolution) =>
        resolution.status === 'fulfilled' ? resolution.value : []
      )
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isEnterprisePublicIpAddress(address))
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityProviderUrlPrivate',
      'Identity provider metadata URL must resolve only to public addresses.',
    )
  }
  return addresses
}

function isEnterprisePublicIpAddress(address: string) {
  const deniedRanges = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '::/128',
    '::1/128',
    '::ffff:0:0/96',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
  ] as const
  return !deniedRanges.some((cidr) => ipMatchesCidr(address, cidr))
}

function readEnterpriseMetadataUrl(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseIdentityProviderMetadataInvalid',
      `${label} is missing from identity provider metadata.`,
    )
  }
  const url = new URL(value)
  if (url.protocol !== 'https:') {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseIdentityProviderMetadataInvalid',
      `${label} must use HTTPS.`,
    )
  }
  return url
}

function readXmlAttribute(tag: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = tag.match(new RegExp(`${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'iu'))
  return match?.[2]
}

function decodeEnterpriseXml(value: string) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', '\'')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function readEnterpriseText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityInputInvalid',
      `${label} is required.`,
    )
  }
  return value.trim()
}

function readEnterpriseInteger(value: unknown, label: string, minimum: number) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityInputInvalid',
      `${label} must be an integer of at least ${minimum}.`,
    )
  }
  return value
}

function readEnterpriseStringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityInputInvalid',
      `${label} must be a string array.`,
    )
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))]
}

function readEnterpriseDomainArray(value: unknown, label: string) {
  const domains = readEnterpriseStringArray(value, label)
    .map((entry) => entry.toLowerCase().replace(/\.$/u, ''))
  if (domains.some((domain) =>
    domain.length > 253 ||
    !domain.includes('.') ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u.test(domain)
  )) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseGuestDomainInvalid',
      `${label} must contain valid DNS domain names.`,
    )
  }
  return [...new Set(domains)]
}

function validateEnterpriseIpAllowlist(ipAllowlist: string[]) {
  if (ipAllowlist.some((cidr) => {
    const address = cidr.split('/')[0]
    return !address || !ipMatchesCidr(address, cidr)
  })) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIpAllowlistInvalid',
      'IP allowlist must contain valid IPv4 or IPv6 CIDRs.',
    )
  }
}

function createEnterprisePolicyCallerImpact(
  c: Context,
  workspaceId: string,
  expectedVersion: number,
  ipAllowlist: string[],
) {
  const callerIp = resolveEnterpriseClientIp(c)
  const callerAllowed = ipAllowlist.length === 0 ||
    Boolean(callerIp && ipAllowlist.some((cidr) => ipMatchesCidr(callerIp, cidr)))
  const requiresConfirmation = !callerAllowed
  const confirmationToken = createHmac('sha256', getEnterpriseIdentityHashSecret())
    .update(JSON.stringify({
      workspaceId,
      expectedVersion,
      callerIp: callerIp ?? '',
      ipAllowlist: [...ipAllowlist].sort(),
    }))
    .digest('base64url')
  return {
    callerIp: callerIp ?? '',
    callerAllowed,
    requiresConfirmation,
    warnings: requiresConfirmation
      ? [
          callerIp
            ? `The current caller IP (${callerIp}) is not included in the new allowlist.`
            : 'The current caller IP could not be resolved from a trusted transport source.',
        ]
      : [],
    ...(requiresConfirmation ? { confirmationToken } : {}),
  }
}

function readEnterprisePermissions(value: unknown) {
  const values = readEnterpriseStringArray(value, 'Permissions')
  const permissions = values.filter((permission): permission is EnterprisePermissionId =>
    ENTERPRISE_PERMISSION_IDS.includes(permission as EnterprisePermissionId)
  )
  if (permissions.length !== values.length || permissions.length === 0) {
    throw new EnterpriseIdentityError(
      400,
      'EnterprisePermissionInvalid',
      'At least one recognized permission is required.',
    )
  }
  return permissions
}

function readEnterpriseRoleId(value: unknown) {
  const roleId = readEnterpriseText(value, 'Role ID')
  if (
    roleId !== 'workspace:owner' &&
    roleId !== 'workspace:admin' &&
    roleId !== 'workspace:member' &&
    roleId !== 'workspace:guest' &&
    roleId !== 'team:manager' &&
    roleId !== 'team:member' &&
    roleId !== 'project:manager' &&
    roleId !== 'project:member' &&
    roleId !== 'project:viewer' &&
    !roleId.startsWith('custom:')
  ) {
    throw new EnterpriseIdentityError(400, 'EnterpriseRoleInvalid', 'Role ID is invalid.')
  }
  return roleId as EnterpriseRoleId
}

function requireEnterpriseAssignableRole(
  snapshot: EnterpriseIdentitySnapshot,
  callerPermissions: readonly EnterprisePermissionId[],
  roleId: EnterpriseRoleId,
  scopeKind: 'workspace' | 'team' | 'project',
) {
  if (
    !canAssignEnterpriseRole(
      snapshot.customRoles,
      callerPermissions,
      roleId,
      scopeKind,
    )
  ) {
    throw new EnterpriseIdentityError(
      403,
      'EnterpriseRoleAssignmentDenied',
      'The selected role exceeds your effective permissions or is invalid for this scope.',
    )
  }
}

function requireEnterprisePermissionGrantCeiling(
  callerPermissions: readonly EnterprisePermissionId[],
  grantedPermissions: readonly EnterprisePermissionId[],
) {
  if (grantedPermissions.some((permission) => !callerPermissions.includes(permission))) {
    throw new EnterpriseIdentityError(
      403,
      'EnterprisePermissionGrantDenied',
      'A custom role cannot grant permissions that the current principal does not hold.',
    )
  }
}

async function requireEnterpriseMappingReferences(
  snapshot: EnterpriseIdentitySnapshot,
  workspaceId: string,
  identityProviderId: string,
  directoryGroupId: string,
  scopeKind: 'workspace' | 'team' | 'project',
  scopeTargetId: string | undefined,
) {
  const provider = snapshot.identityProviders.find((candidate) =>
    candidate.providerId === identityProviderId
  )
  assertEnterpriseIdentityProviderReady(provider)
  assertEnterpriseCognitoProviderBinding(
    provider,
    requireEnterpriseCognitoProviderName(),
  )
  await assertEnterpriseCognitoFederationProvider(provider)
  if (!snapshot.scimGroups.some((group) =>
    group.active &&
    group.identityProviderId === identityProviderId &&
    (group.groupId === directoryGroupId || group.externalId === directoryGroupId)
  )) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseDirectoryGroupNotFound',
      'An active provisioned directory group is required before creating a mapping.',
    )
  }
  if (scopeKind === 'workspace') return
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja')
  const exists = scopeKind === 'team'
    ? directory.teams.some((team) => team.id === scopeTargetId)
    : directory.teams.some((team) =>
        team.projects.some((project) => project.id === scopeTargetId)
      )
  if (!exists) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseMappingScopeNotFound',
      'The selected Team or Project does not belong to this Workspace.',
    )
  }
}

async function requireEnterpriseResourceScope(
  workspaceId: string,
  scopeKind: 'workspace' | 'team' | 'project',
  scopeTargetId: string | undefined,
) {
  if (scopeKind === 'workspace') return
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja')
  const exists = scopeKind === 'team'
    ? directory.teams.some((team) => team.id === scopeTargetId)
    : directory.teams.some((team) =>
        team.projects.some((project) => project.id === scopeTargetId)
      )
  if (!exists) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseResourceScopeNotFound',
      'The selected Team or Project does not belong to this Workspace.',
    )
  }
}

function createEnterpriseDomainVerificationValue(workspaceId: string, domain: string) {
  return `mukuroji-verification=${createHash('sha256')
    .update(`${getEnterpriseIdentityHashSecret()}\0${workspaceId}\0${domain}`)
    .digest('base64url')}`
}

function getEnterpriseIdentityHashSecret() {
  return getEnv('ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET') ??
    'local-enterprise-domain-verification-secret'
}

function createEnterpriseIdempotentResourceId(
  namespace: string,
  workspaceId: string,
  idempotencyKey: string,
) {
  return `${namespace}_${createHash('sha256')
    .update(`${workspaceId}\0${idempotencyKey}`)
    .digest('base64url')
    .slice(0, 22)}`
}

function isLocalEnterpriseDomainVerification() {
  return Boolean(getConfiguredDynamoDbEndpoint()) ||
    !getEnv('ENTERPRISE_IDENTITY_TABLE_NAME') ||
    getEnv('MUKUROJI_ENTERPRISE_SKIP_DOMAIN_DNS_VERIFICATION') === 'true'
}

function toEnterpriseDomainView(domain: EnterpriseVerifiedDomain) {
  return {
    id: domain.domainId,
    domain: domain.domain,
    status: domain.status === 'failed' ? 'conflict' : domain.status,
    verificationRecordName: domain.verificationRecordName,
    verifiedAt: domain.verifiedAt,
    version: domain.revision,
  }
}

function toEnterpriseRoleView(role: EnterpriseCustomRole, assignmentCount: number) {
  return {
    id: role.roleId,
    name: role.name,
    description: role.description ?? '',
    kind: 'custom' as const,
    permissionIds: role.permissions,
    guestAssignable: role.guestAssignable,
    assignmentCount,
    version: role.revision,
  }
}

function createEnterpriseRoleImpact(
  snapshot: EnterpriseIdentitySnapshot,
  role: EnterpriseCustomRole,
  permissionIds: EnterprisePermissionId[],
  guestAssignable: boolean,
  deleteRequested: boolean,
) {
  const assignments = snapshot.roleAssignments.filter((assignment) =>
    assignment.roleId === role.roleId
  )
  const mappings = snapshot.groupMappings.filter((mapping) =>
    mapping.roleId === role.roleId
  )
  const serviceAccounts = snapshot.serviceAccounts.filter((account) =>
    account.roleId === role.roleId && account.status === 'active'
  )
  const removedPermissionIds = deleteRequested
    ? [...role.permissions]
    : role.permissions.filter((permission) => !permissionIds.includes(permission))
  const blocking = deleteRequested &&
    assignments.length + mappings.length + serviceAccounts.length > 0
  const referenceFingerprint = createHash('sha256')
    .update(JSON.stringify({
      assignments: assignments.map((assignment) => assignment.assignmentId).sort(),
      mappings: mappings.map((mapping) => mapping.mappingId).sort(),
      serviceAccounts: serviceAccounts.map((account) => account.accountId).sort(),
    }))
    .digest('base64url')
  const confirmationToken = createHmac('sha256', getEnterpriseIdentityHashSecret())
    .update(JSON.stringify({
      workspaceId: snapshot.workspaceId,
      roleId: role.roleId,
      roleRevision: role.revision,
      deleteRequested,
      permissionIds: [...permissionIds].sort(),
      guestAssignable,
      referenceFingerprint,
    }))
    .digest('base64url')
  const warnings = [
    ...(removedPermissionIds.length > 0
      ? [`${removedPermissionIds.length} permission(s) will be removed immediately.`]
      : []),
    ...(assignments.length > 0
      ? [`${assignments.length} direct role assignment(s) are affected.`]
      : []),
    ...(mappings.length > 0
      ? [`${mappings.length} directory group mapping(s) are affected.`]
      : []),
    ...(serviceAccounts.length > 0
      ? [`${serviceAccounts.length} active service account(s) are affected.`]
      : []),
    ...(role.guestAssignable && !guestAssignable
      ? ['Guest assignments using this role will stop granting permissions.']
      : []),
  ]
  return {
    assignmentCount: assignments.length,
    mappingCount: mappings.length,
    serviceAccountCount: serviceAccounts.length,
    removedPermissionIds,
    blocking,
    warnings,
    ...(blocking ? {} : { confirmationToken }),
  }
}

function toEnterpriseProvisioningImpact(preview: EnterpriseProvisioningPreview) {
  const count = (entityType: 'user' | 'group', action: string) =>
    preview.changes.filter((change) =>
      change.entityType === entityType && change.action === action
    ).length
  return {
    previewId: preview.previewId,
    expiresAt: preview.expiresAt,
    counts: {
      usersCreated: count('user', 'create'),
      usersUpdated: count('user', 'update'),
      usersDeactivated: count('user', 'deactivate'),
      groupsCreated: count('group', 'create'),
      groupsUpdated: count('group', 'update'),
      sessionsRevoked: preview.changes.filter((change) =>
        change.entityType === 'session' && change.action === 'revoke'
      ).length,
    },
    warnings: preview.changes
      .filter((change) => change.blocking || change.action === 'deactivate')
      .map((change) => change.summary),
    blocking: preview.changes.some((change) => change.blocking),
    hasChanges: preview.changes.some((change) => change.action !== 'noop'),
  }
}

function resolveEnterpriseProvisioningFailureCode(error: unknown) {
  if (error instanceof WorkspaceAccessError || error instanceof EnterpriseIdentityError) {
    return error.code
  }
  if (error instanceof ProjectDataError) return error.code
  return 'ProvisioningApplyFailed'
}

async function resolveEnterpriseProtectedProvisioningMemberKeys(
  workspaceId: string,
  snapshot: EnterpriseIdentitySnapshot,
) {
  const members = await workspaceDependencies.workspaceAccess.listActiveMembers(workspaceId)
  const owners = members.filter((member) => member.role === 'owner')
  const protectedMemberKeys = new Set([
    ...owners.map((owner) => owner.memberKey),
    ...snapshot.breakGlassAccounts
      .filter((account) => account.status === 'active')
      .map((account) => account.linkedMemberKey),
  ])
  for (const user of snapshot.scimUsers) {
    if (user.active || !user.linkedMemberKey) continue
    try {
      await requireWorkspaceMemberHasNoManagedProjects(workspaceId, user.linkedMemberKey)
      await requireWorkspaceMemberHasNoOwnedPlanningEntities(workspaceId, user.linkedMemberKey)
    } catch (error) {
      if (
        error instanceof WorkspaceAccessError &&
        (
          error.code === 'WorkspaceMemberManagesProjects' ||
          error.code === 'WorkspaceMemberOwnsPlanningEntities'
        )
      ) {
        protectedMemberKeys.add(user.linkedMemberKey)
        continue
      }
      throw error
    }
  }
  return [...protectedMemberKeys]
}

function toEnterpriseServiceAccountView(
  account: EnterpriseServiceAccount,
  credentialExpiresAt?: string,
) {
  return {
    id: account.accountId,
    name: account.displayName,
    status: account.status === 'active' ? 'active' : 'revoked',
    roleId: account.roleId,
    scopeType: account.scope.kind,
    scopeId: account.scope.targetId,
    credentialLifetimeDays: account.credentialLifetimeDays,
    credentialExpiresAt: credentialExpiresAt ?? account.credentialExpiresAt,
    allowedSourceCidrs: account.allowedSourceCidrs,
    credentialGeneration: account.credentialGeneration,
    createdAt: account.createdAt,
    lastUsedAt: account.lastUsedAt,
    version: account.revision,
  }
}

function toEnterpriseBreakGlassView(account: EnterpriseBreakGlassAccount) {
  return {
    id: account.accountId,
    email: account.email,
    status: account.status,
    mfaConfigured: true,
    lastTestedAt: account.lastTestedAt,
    version: account.revision,
  }
}

function isEnterpriseSsoRecoveryAccountReady(
  snapshot: EnterpriseIdentitySnapshot,
  account: EnterpriseBreakGlassAccount,
) {
  const testedAt = Date.parse(account.lastTestedAt ?? '')
  const now = Date.now()
  return account.status === 'active' &&
    account.requireMfa &&
    Number.isFinite(Date.parse(account.mfaVerifiedAt)) &&
    Number.isFinite(testedAt) &&
    testedAt <= now &&
    now - testedAt <= 30 * 24 * 60 * 60_000 &&
    !snapshot.domains.some((domain) =>
      domain.status === 'verified' &&
      domain.domain === normalizeEnterpriseEmailDomain(account.email)
    )
}

function requireEnterpriseBreakGlassRecoveryDomainUnmanaged(
  snapshot: EnterpriseIdentitySnapshot,
  email: string,
) {
  if (snapshot.domains.some((domain) =>
    domain.status === 'verified' &&
    domain.domain === normalizeEnterpriseEmailDomain(email)
  )) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseBreakGlassRecoveryDomainManaged',
      'Break-glass recovery must use an account outside every managed domain.',
    )
  }
}

async function requireEnterpriseMfa(workspaceId: string, accessToken: string) {
  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  const sessionId = createHash('sha256').update(accessToken).digest('base64url')
  const verifiedMethods = await workspaceDependencies.enterpriseSessionActivity.getAuthenticationMethods(
    workspaceId,
    sessionId,
  )
  if (![...new Set([
    ...readCognitoAuthenticationMethods(claims),
    ...verifiedMethods,
  ])].some((method) => {
    const normalized = method.toLowerCase()
    return normalized.includes('mfa') ||
      normalized.includes('otp') ||
      normalized.includes('webauthn')
  })) {
    throw new EnterpriseIdentityError(
      403,
      'EnterpriseBreakGlassMfaRequired',
      'Break-glass activation requires a current MFA-authenticated session.',
    )
  }
}

function requireEnterpriseRecentAuthentication(accessToken: string, maximumAgeMinutes: number) {
  const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
  const authenticatedAt = readNumericClaim(claims?.auth_time) ??
    readNumericClaim(claims?.iat)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (
    authenticatedAt === undefined ||
    authenticatedAt > nowSeconds ||
    nowSeconds - authenticatedAt > maximumAgeMinutes * 60
  ) {
    throw new EnterpriseIdentityError(
      403,
      'EnterpriseBreakGlassReauthenticationRequired',
      'Break-glass activation requires recent authentication.',
    )
  }
}

async function applyEnterpriseProvisioningPlan(
  c: Context,
  run: EnterpriseProvisioningRun,
) {
  const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(run.workspaceId)
  const desiredGroupOverlays = run.changes
    .filter((change) => change.action !== 'noop' && change.entityType === 'group')
    .map((change) => {
      const group = snapshot.scimGroups.find((candidate) =>
        candidate.groupId === change.entityId &&
        candidate.version === change.desiredVersion
      )
      if (!group) {
        throw new EnterpriseIdentityError(
          409,
          'EnterpriseProvisioningPlanStale',
          'A SCIM group changed after this provisioning run was reviewed.',
        )
      }
      return group
    })
  for (const change of run.changes) {
    if (change.action === 'noop' || change.entityType !== 'user') continue
    const user = snapshot.scimUsers.find((candidate) =>
      candidate.userId === change.entityId &&
      candidate.version === change.desiredVersion
    )
    if (!user) {
      throw new EnterpriseIdentityError(
        409,
        'EnterpriseProvisioningPlanStale',
        'A SCIM user changed after this provisioning run was reviewed.',
      )
    }
    await applyEnterpriseScimUser(c, user, desiredGroupOverlays)
  }
  for (const group of desiredGroupOverlays) {
    await workspaceDependencies.enterpriseIdentity.scimDirectory.markScimGroupApplied(
      run.workspaceId,
      group.groupId,
      group.version,
      createEnterpriseScimMutationContext(
        c,
        run.workspaceId,
        group.identityProviderId,
        {
        runId: run.runId,
        groupId: group.groupId,
        desiredVersion: group.version,
        },
      ),
    )
  }
}

async function applyEnterpriseScimUser(
  c: Context,
  user: EnterpriseScimUser,
  desiredGroupOverlays: readonly EnterpriseScimGroup[] = [],
) {
  return await applyEnterpriseScimUserState(
    user,
    createEnterpriseScimMutationContext(
      c,
      user.workspaceId,
      user.identityProviderId,
      {
        externalId: user.externalId,
        userId: user.userId,
        active: user.active,
      },
    ),
    desiredGroupOverlays,
  )
}

async function applyEnterpriseScimUserState(
  user: EnterpriseScimUser,
  auditContext: MutationAuditContext,
  desiredGroupOverlays: readonly EnterpriseScimGroup[] = [],
) {
  const memberKey = user.linkedMemberKey ??
    user.emails[0]?.trim().toLowerCase() ??
    user.userName.trim().toLowerCase()
  const existing = await workspaceDependencies.workspaceAccess.getMember(user.workspaceId, memberKey)
  if (user.active) {
    const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(user.workspaceId)
    const workspaceRole = resolveEnterpriseScimWorkspaceRole(
      snapshot,
      user,
      desiredGroupOverlays,
    )
    requireEnterpriseExternalAccessAllowed(
      snapshot,
      user.emails[0] ?? user.userName,
      workspaceRole,
    )
    const expectedPlanningRevision =
      (await workItemDependencies.planning.getAuthorizationState(user.workspaceId)).revision
    const expectedDocumentAuthorizationRevision =
      existing?.status === 'active' &&
        existing.role !== 'guest' &&
        workspaceRole === 'guest'
        ? await requirePrivateDocumentManagerContinuity(
            {
              documents: workItemDependencies.documents,
              workspaceAccess: workspaceDependencies.workspaceAccess,
            },
            user.workspaceId,
            memberKey,
          )
        : undefined
    await workspaceDependencies.workspaceAccess.reconcileDirectoryMember?.(user.workspaceId, {
      memberKey,
      email: user.emails[0] ?? user.userName,
      name: user.displayName,
      role: workspaceRole,
      externalIdentityId: user.userId,
      expectedVersion: existing?.version,
      expectedPlanningRevision,
      ...(expectedDocumentAuthorizationRevision === undefined
        ? {}
        : { expectedDocumentAuthorizationRevision }),
    }, auditContext)
    await authenticationDependencies.cognito.enableWorkspaceUser?.(memberKey)
  } else if (existing) {
    await requireWorkspaceMemberHasNoManagedProjects(user.workspaceId, memberKey)
    const expectedPlanningRevision = await requireWorkspaceMemberHasNoOwnedPlanningEntities(
      user.workspaceId,
      memberKey,
    )
    const expectedDocumentAuthorizationRevision =
      await requirePrivateDocumentManagerContinuity(
        {
          documents: workItemDependencies.documents,
          workspaceAccess: workspaceDependencies.workspaceAccess,
        },
        user.workspaceId,
        memberKey,
      )
    await workspaceDependencies.workspaceAccess.deprovisionDirectoryMember?.(
      user.workspaceId,
      memberKey,
      {
        externalIdentityId: user.userId,
        expectedVersion: existing.version,
        expectedPlanningRevision,
        expectedDocumentAuthorizationRevision,
      },
      auditContext,
    )
    await authenticationDependencies.cognito.disableWorkspaceUser?.(memberKey)
    await authenticationDependencies.cognito.globallySignOutWorkspaceUser?.(memberKey)
  }
  await workspaceDependencies.enterpriseIdentity.scimDirectory.markScimUserApplied(
    user.workspaceId,
    user.userId,
    user.version,
    auditContext,
  )
}

async function requireEnterpriseScimDeprovisionAllowed(
  workspaceId: string,
  memberKey: string,
  snapshot: EnterpriseIdentitySnapshot,
) {
  const members = await workspaceDependencies.workspaceAccess.listActiveMembers(workspaceId)
  const member = members.find((candidate) => candidate.memberKey === memberKey)
  if (!member) return
  if (member.role === 'owner') {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseProvisioningProtectedOwner',
      'Downgrade or transfer this Workspace owner before directory deprovisioning.',
    )
  }
  if (snapshot.breakGlassAccounts.some((account) =>
    account.status === 'active' && account.linkedMemberKey === memberKey
  )) {
    throw new EnterpriseIdentityError(
      409,
      'EnterpriseProvisioningProtectedRecoveryAccount',
      'Replace the active break-glass recovery account before deprovisioning this member.',
    )
  }
  await requireWorkspaceMemberHasNoManagedProjects(workspaceId, memberKey)
  await requireWorkspaceMemberHasNoOwnedPlanningEntities(workspaceId, memberKey)
}

function resolveEnterpriseScimWorkspaceRole(
  snapshot: EnterpriseIdentitySnapshot,
  user: EnterpriseScimUser,
  desiredGroupOverlays: readonly EnterpriseScimGroup[] = [],
) {
  const desiredGroupsById = new Map(
    desiredGroupOverlays.map((group) => [group.groupId, group]),
  )
  const externalGroupIds = snapshot.scimGroups
    .map((group) => desiredGroupsById.get(group.groupId) ?? group)
    .filter((group) =>
      group.active &&
      (
        desiredGroupsById.has(group.groupId) ||
        group.appliedVersion >= group.version
      ) &&
      group.identityProviderId === user.identityProviderId &&
      group.memberUserIds.includes(user.userId)
    )
    .flatMap((group) => [group.groupId, group.externalId])
  const roles = snapshot.groupMappings
    .filter((mapping) =>
      mapping.enabled &&
      mapping.identityProviderId === user.identityProviderId &&
      mapping.scope.kind === 'workspace' &&
      externalGroupIds.includes(mapping.directoryGroupId)
    )
    .map((mapping) => mapping.roleId)
  if (roles.includes('workspace:guest')) return 'guest' as const
  return 'member' as const
}

async function requireEnterpriseScimWorkspace(c: Context) {
  const workspaceId = readEnterpriseText(c.req.param('workspaceId'), 'Workspace ID')
  const token = readBearerAccessToken(c)
  const authentication = token
    ? await workspaceDependencies.enterpriseIdentity.scimAuthentication.authenticateScimWorkspace(
        workspaceId,
        token,
      )
    : undefined
  if (!authentication) {
    throw new EnterpriseIdentityError(
      401,
      'EnterpriseScimAuthenticationFailed',
      'SCIM bearer credential is invalid or revoked.',
    )
  }
  const { credential, provider } = authentication
  assertEnterpriseIdentityProviderReady(provider)
  assertEnterpriseCognitoProviderBinding(
    provider,
    requireEnterpriseCognitoProviderName(),
  )
  await assertEnterpriseCognitoFederationProvider(provider, 'cached')
  await enforceTenantFeatureForRequest(workspaceId, c)
  return { workspaceId, credential }
}

/** 一つの SCIM mutation request に許可する decoded JSON byte 数です。 */
const SCIM_REQUEST_BODY_MAX_BYTES = 512 * 1024

/** 一つの SCIM PATCH request に許可する operation 数です。 */
const SCIM_PATCH_OPERATION_LIMIT = 100

/** SCIM equality filter に許可する UTF-8 byte 数です。 */
const SCIM_FILTER_MAX_BYTES = 512

async function readScimJson(c: Context) {
  const contentLength = c.req.header('Content-Length')
  if (contentLength !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPayloadInvalid',
        'SCIM Content-Length must be a non-negative integer.',
      )
    }
    const parsedContentLength = Number(contentLength)
    if (!Number.isSafeInteger(parsedContentLength)) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPayloadInvalid',
        'SCIM Content-Length is invalid.',
      )
    }
    if (parsedContentLength > SCIM_REQUEST_BODY_MAX_BYTES) {
      throwScimPayloadTooLarge()
    }
  }
  let bytes: ArrayBuffer
  try {
    bytes = await c.req.arrayBuffer()
  } catch {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimPayloadInvalid',
      'A valid SCIM JSON object request body is required.',
    )
  }
  if (bytes.byteLength > SCIM_REQUEST_BODY_MAX_BYTES) {
    throwScimPayloadTooLarge()
  }
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown
    if (!isRecord(value)) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPayloadInvalid',
        'A SCIM JSON object request body is required.',
      )
    }
    return value
  } catch (error) {
    if (error instanceof EnterpriseIdentityError) throw error
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimPayloadInvalid',
      'A valid SCIM JSON object request body is required.',
    )
  }
}

function throwScimPayloadTooLarge(): never {
  throw new EnterpriseIdentityError(
    413,
    'EnterpriseScimPayloadTooLarge',
    `SCIM request bodies cannot exceed ${
      SCIM_REQUEST_BODY_MAX_BYTES
    } bytes.`,
  )
}

function readEnterpriseScimUserInput(
  c: Context,
  workspaceId: string,
  identityProviderId: string,
  body: Record<string, unknown>,
  existing?: EnterpriseScimUser,
): EnterpriseScimUserInput {
  if (existing && existing.identityProviderId !== identityProviderId) {
    throw new EnterpriseIdentityError(
      404,
      'EnterpriseScimUserNotFound',
      'SCIM user was not found.',
    )
  }
  if (
    Array.isArray(body.emails) &&
    body.emails.length > ENTERPRISE_SCIM_USER_EMAIL_LIMIT
  ) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimUserEmailLimitExceeded',
      `A SCIM user can contain at most ${
        ENTERPRISE_SCIM_USER_EMAIL_LIMIT
      } email addresses.`,
    )
  }
  const hasEmails = Object.hasOwn(body, 'emails')
  if (hasEmails && !Array.isArray(body.emails)) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimEmailInvalid',
      'SCIM emails must be an array with at least one valid email.',
    )
  }
  const emails = hasEmails
    ? (body.emails as unknown[])
        .map((entry) => isRecord(entry) && typeof entry.value === 'string'
          ? readScimBoundedText(
            entry.value,
            'SCIM email',
            ENTERPRISE_SCIM_USER_IDENTIFIER_MAX_BYTES,
            false,
          )?.toLowerCase()
          : undefined)
        .filter((value): value is string => Boolean(value))
    : existing?.emails ?? []
  if (hasEmails && emails.length === 0) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimEmailInvalid',
      'SCIM user requires at least one valid email.',
    )
  }
  const userName = Object.hasOwn(body, 'userName')
    ? typeof body.userName === 'string' ? body.userName : undefined
    : existing?.userName
  if (!userName) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimUserInvalid',
      'SCIM userName is required.',
    )
  }
  const boundedUserName = readScimBoundedText(
    userName,
    'SCIM userName',
    ENTERPRISE_SCIM_USER_IDENTIFIER_MAX_BYTES,
  )
  const externalId = Object.hasOwn(body, 'externalId')
    ? typeof body.externalId === 'string' ? body.externalId : boundedUserName
    : existing?.externalId ?? boundedUserName
  const boundedExternalId = readScimBoundedText(
    externalId,
    'SCIM user externalId',
    ENTERPRISE_SCIM_EXTERNAL_ID_MAX_BYTES,
  )
  const displayName = Object.hasOwn(body, 'displayName')
    ? typeof body.displayName === 'string' ? body.displayName : undefined
    : Object.hasOwn(body, 'name')
      ? isRecord(body.name) && typeof body.name.formatted === 'string'
        ? body.name.formatted
        : undefined
      : existing?.displayName
  const boundedDisplayName = displayName === undefined
    ? undefined
    : readScimBoundedText(
      displayName,
      'SCIM user displayName',
      ENTERPRISE_SCIM_DISPLAY_NAME_MAX_BYTES,
      false,
    )
  return {
    workspaceId,
    userId: existing?.userId,
    externalId: boundedExternalId,
    identityProviderId,
    userName: boundedUserName,
    displayName: boundedDisplayName,
    emails: emails.length > 0 ? emails : [boundedUserName],
    active: body.active === undefined ? existing?.active ?? true : body.active === true,
    linkedMemberKey: existing?.linkedMemberKey ??
      (emails[0] ?? boundedUserName).trim().toLowerCase(),
    groupIds: existing?.groupIds ?? [],
    idempotencyKey: readScimIdempotencyKey(
      c,
      `user:${boundedExternalId}:${JSON.stringify(body)}`,
    ),
  }
}

function readEnterpriseScimGroupInput(
  c: Context,
  workspaceId: string,
  identityProviderId: string,
  body: Record<string, unknown>,
  existing?: EnterpriseScimGroup,
): EnterpriseScimGroupInput {
  if (existing && existing.identityProviderId !== identityProviderId) {
    throw new EnterpriseIdentityError(
      404,
      'EnterpriseScimGroupNotFound',
      'SCIM group was not found.',
    )
  }
  const displayName = Object.hasOwn(body, 'displayName')
    ? typeof body.displayName === 'string' ? body.displayName : undefined
    : existing?.displayName
  if (!displayName) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimGroupInvalid',
      'SCIM group displayName is required.',
    )
  }
  const boundedDisplayName = readScimBoundedText(
    displayName,
    'SCIM group displayName',
    ENTERPRISE_SCIM_DISPLAY_NAME_MAX_BYTES,
  )
  const externalId = Object.hasOwn(body, 'externalId')
    ? typeof body.externalId === 'string' ? body.externalId : boundedDisplayName
    : existing?.externalId ?? boundedDisplayName
  const boundedExternalId = readScimBoundedText(
    externalId,
    'SCIM group externalId',
    ENTERPRISE_SCIM_EXTERNAL_ID_MAX_BYTES,
  )
  if (
    Array.isArray(body.members) &&
    body.members.length > ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT
  ) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimGroupMemberLimitExceeded',
      `A SCIM group can contain at most ${
        ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT
      } members.`,
    )
  }
  const hasMembers = Object.hasOwn(body, 'members')
  if (hasMembers && !Array.isArray(body.members)) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimGroupMemberInvalid',
      'SCIM group members must be an array.',
    )
  }
  const memberUserIds = hasMembers
    ? (body.members as unknown[]).map(readScimGroupMemberId)
    : existing?.memberUserIds
  return {
    workspaceId,
    groupId: existing?.groupId,
    externalId: boundedExternalId,
    identityProviderId,
    displayName: boundedDisplayName,
    active: body.active === undefined ? existing?.active ?? true : body.active === true,
    memberUserIds,
    idempotencyKey: readScimIdempotencyKey(
      c,
      `group:${boundedExternalId}:${JSON.stringify(body)}`,
    ),
  }
}

function readScimBoundedText(
  value: string,
  label: string,
  maximumBytes: number,
  required = true,
) {
  const normalized = value.trim()
  if (
    (required && normalized.length === 0) ||
    Buffer.byteLength(normalized, 'utf8') > maximumBytes
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimTextLimitExceeded',
      `${label} must contain ${
        required ? 'between 1 and ' : 'at most '
      }${maximumBytes} UTF-8 bytes.`,
    )
  }
  return normalized
}

function readScimGroupMemberId(entry: unknown) {
  if (!isRecord(entry) || typeof entry.value !== 'string') {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimGroupMemberInvalid',
      'Every SCIM group member requires a string value.',
    )
  }
  const value = entry.value.trim()
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > ENTERPRISE_SCIM_MEMBER_ID_MAX_BYTES
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimGroupMemberInvalid',
      `SCIM member IDs must contain at most ${
        ENTERPRISE_SCIM_MEMBER_ID_MAX_BYTES
      } UTF-8 bytes.`,
    )
  }
  return value
}

function readScimResourceId(value: string, resourceType: 'user' | 'group') {
  return readScimBoundedText(
    value,
    `SCIM ${resourceType} ID`,
    ENTERPRISE_SCIM_RESOURCE_ID_MAX_BYTES,
  )
}

function readScimIdempotencyKey(c: Context, fallbackSeed: string) {
  const provided = c.req.header('Idempotency-Key')
  if (provided !== undefined && provided.trim().length > 0) {
    return readScimBoundedText(
      provided,
      'SCIM Idempotency-Key',
      ENTERPRISE_SCIM_IDEMPOTENCY_KEY_MAX_BYTES,
    )
  }
  return createHash('sha256').update(fallbackSeed).digest('hex')
}

function createEnterpriseScimMutationContext(
  c: Context,
  workspaceId: string,
  identityProviderId: string,
  body: unknown,
) {
  const bodyFingerprint = createHash('sha256')
    .update(JSON.stringify(body))
    .digest('hex')
  const requestIdempotencyKey =
    c.req.header('Idempotency-Key')?.trim() || bodyFingerprint
  return createRequestMutationContext(
    c,
    workspaceId,
    `scim-directory:${identityProviderId}`,
    `SCIM directory (${identityProviderId})`,
    body,
    `${requestIdempotencyKey}:${bodyFingerprint}`,
    'service',
  )
}

function toScimUserResource(user: EnterpriseScimUser) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: user.userId,
    externalId: user.externalId,
    userName: user.userName,
    displayName: user.displayName,
    active: user.active,
    emails: user.emails.map((value, index) => ({
      value,
      primary: index === 0,
      type: 'work',
    })),
    meta: {
      resourceType: 'User',
      created: user.createdAt,
      lastModified: user.updatedAt,
      version: `W/"${user.version}"`,
    },
  }
}

function toScimGroupResource(group: EnterpriseScimGroup) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: group.groupId,
    externalId: group.externalId,
    displayName: group.displayName,
    active: group.active,
    members: group.memberUserIds.map((value) => ({ value })),
    meta: {
      resourceType: 'Group',
      created: group.createdAt,
      lastModified: group.updatedAt,
      version: `W/"${group.version}"`,
    },
  }
}

function readScimEqualityFilter<
  Field extends 'externalId' | 'userName' | 'displayName',
>(
  filter: string | undefined,
  allowedFields: readonly Field[],
) {
  if (!filter) return {}
  if (Buffer.byteLength(filter, 'utf8') > SCIM_FILTER_MAX_BYTES) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimFilterInvalid',
      `SCIM filters cannot exceed ${SCIM_FILTER_MAX_BYTES} UTF-8 bytes.`,
    )
  }
  const match = filter.match(
    /^\s*(externalId|userName|displayName)\s+eq\s+"([^"]+)"\s*$/iu,
  )
  const canonicalField = match
    ? allowedFields.find((field) =>
      field.toLowerCase() === match[1]!.toLowerCase()
    )
    : undefined
  if (!match || !canonicalField) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimFilterInvalid',
      `Only ${allowedFields.join(', ')} equality filters are supported.`,
    )
  }
  return {
    filter: {
      field: canonicalField,
      value: match[2]!,
    },
  }
}

function readScimPagination(c: Context, maximumCount = 200) {
  const startIndex = readScimPaginationInteger(c.req.query('startIndex'), 1, 'startIndex')
  const requestedCount = readScimPaginationInteger(
    c.req.query('count'),
    Math.min(100, maximumCount),
    'count',
    true,
  )
  return {
    startIndex,
    count: Math.min(requestedCount, maximumCount),
  }
}

function readScimPaginationInteger(
  value: string | undefined,
  fallback: number,
  field: 'startIndex' | 'count',
  allowZero = false,
) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (allowZero ? 0 : 1)
  ) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseScimPaginationInvalid',
      `SCIM ${field} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`,
    )
  }
  return parsed
}

function applyScimPatch(
  body: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  if (!Array.isArray(body.Operations)) return { ...current, ...body }
  if (body.Operations.length > SCIM_PATCH_OPERATION_LIMIT) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimPatchOperationLimitExceeded',
      `A SCIM PATCH request can contain at most ${
        SCIM_PATCH_OPERATION_LIMIT
      } operations.`,
    )
  }
  const next = structuredClone(current)
  for (const operation of body.Operations) {
    if (!isRecord(operation) || typeof operation.op !== 'string') {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPatchInvalid',
        'Every SCIM PATCH operation requires an op value.',
      )
    }
    const op = operation.op.toLowerCase()
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPatchInvalid',
        'Only add, replace, and remove SCIM PATCH operations are supported.',
      )
    }
    if (!operation.path && isRecord(operation.value) && op !== 'remove') {
      Object.assign(next, operation.value)
      assertScimPatchArrayLimits(next)
      continue
    }
    if (typeof operation.path !== 'string') {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPatchInvalid',
        'SCIM PATCH operation path is required.',
      )
    }
    const filteredMembers = operation.path.match(
      /^members\[value\s+eq\s+"([^"]+)"\]$/iu,
    )
    if (filteredMembers) {
      if (op !== 'remove') {
        throw new EnterpriseIdentityError(
          400,
          'EnterpriseScimPatchInvalid',
          'Filtered member paths only support remove operations.',
        )
      }
      const filteredMemberId = readScimGroupMemberId({
        value: filteredMembers[1],
      })
      const members = Array.isArray(next.members) ? next.members : []
      next.members = members.filter((member) =>
        !isRecord(member) || member.value !== filteredMemberId
      )
      assertScimPatchArrayLimits(next)
      continue
    }
    if (operation.path.includes('[')) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPatchInvalid',
        'Only members[value eq "..."] filtered paths are supported.',
      )
    }
    const path = operation.path
    const canonicalPath = Object.keys(next).find((candidate) =>
      candidate.toLowerCase() === path.toLowerCase()
    )
    if (!canonicalPath) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseScimPatchInvalid',
        `Unsupported SCIM PATCH path: ${path}.`,
      )
    }
    const currentValue = next[canonicalPath]
    if (op === 'remove') {
      next[canonicalPath] = Array.isArray(currentValue) ? [] : null
    } else if (Array.isArray(currentValue)) {
      if (op === 'add') {
        const appendedValues = Array.isArray(operation.value)
          ? operation.value
          : [operation.value]
        if (appendedValues.some((value) => !isRecord(value))) {
          throw new EnterpriseIdentityError(
            400,
            'EnterpriseScimPatchInvalid',
            `SCIM PATCH ${canonicalPath} values must be complex objects.`,
          )
        }
        next[canonicalPath] = [...currentValue, ...appendedValues]
      } else {
        if (!Array.isArray(operation.value)) {
          throw new EnterpriseIdentityError(
            400,
            'EnterpriseScimPatchInvalid',
            `SCIM PATCH ${canonicalPath} replacement must be an array.`,
          )
        }
        next[canonicalPath] = operation.value
      }
    } else {
      next[canonicalPath] = operation.value
    }
    assertScimPatchArrayLimits(next)
  }
  return next
}

function assertScimPatchArrayLimits(value: Record<string, unknown>) {
  if (
    Array.isArray(value.members) &&
    value.members.length > ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT
  ) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimGroupMemberLimitExceeded',
      `A SCIM group can contain at most ${
        ENTERPRISE_SCIM_GROUP_MEMBER_LIMIT
      } members.`,
    )
  }
  if (
    Array.isArray(value.emails) &&
    value.emails.length > ENTERPRISE_SCIM_USER_EMAIL_LIMIT
  ) {
    throw new EnterpriseIdentityError(
      413,
      'EnterpriseScimUserEmailLimitExceeded',
      `A SCIM user can contain at most ${
        ENTERPRISE_SCIM_USER_EMAIL_LIMIT
      } email addresses.`,
    )
  }
}

function setScimEtag(c: Context, version: number) {
  c.header('ETag', `W/"${version}"`)
}

function requireScimIfMatch(c: Context, version: number) {
  const ifMatch = c.req.header('If-Match')?.trim()
  if (!ifMatch || ifMatch === '*') return
  if (ifMatch !== `W/"${version}"` && ifMatch !== `"${version}"`) {
    throw new EnterpriseIdentityError(
      412,
      'EnterpriseScimVersionConflict',
      'SCIM resource version changed. Reload and retry with the latest ETag.',
    )
  }
}

function toScimJson(c: Context, value: object) {
  c.header('Content-Type', 'application/scim+json')
  c.header('Cache-Control', 'no-store')
  return c.json(value)
}

function toScimErrorResponse(c: Context, error: unknown) {
  const status = error instanceof EnterpriseIdentityError
    ? error.status
    : error instanceof WorkspaceAccessError
      ? error.status
      : 500
  const message = error instanceof Error ? error.message : 'SCIM operation failed.'
  if (status >= 500) console.error(error)
  c.status(
    status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 409 ||
      status === 412 ||
      status === 413 ||
      status === 429 ||
      status === 503
      ? status
      : 500,
  )
  return toScimJson(c, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(status),
    detail: message,
  })
}

async function createDocumentApiPrincipal(
  accessToken: string,
  context: Context,
): Promise<DocumentApiPrincipal> {
  const principal = await authenticateWorkspacePrincipal(
    accessToken,
    undefined,
    context,
  )
  const {
    planningRevision,
    projectRoles,
  } = await readDocumentAuthorizationSnapshot(principal)

  return {
    workspaceId: principal.directoryId,
    memberKey: principal.userKey,
    displayName:
      principal.workspaceMember.name ??
      principal.workspaceMember.email ??
      principal.userKey,
    workspaceRole: principal.workspaceRole,
    isSystemAdmin: principal.isSystemAdmin,
    authorizationSnapshots: [{
      workspaceId: principal.directoryId,
      ...(principal.principalKind === 'service-account'
        ? {}
        : {
            workspaceMemberKey: principal.userKey,
            workspaceMemberVersion:
              principal.workspaceMember.version,
          }),
      planningRevision,
      ...(principal.enterprisePermissions === undefined ||
          principal.enterpriseIdentityControlRevision === undefined
        ? {}
        : {
            enterpriseControlRevision:
              principal.enterpriseIdentityControlRevision,
          }),
    } satisfies DocumentAuthorizationFenceSnapshot],
    projectRoles,
    ...createDocumentEnterpriseScopeBoundary(principal),
  }
}

async function readDocumentAuthorizationSnapshot(
  principal: WorkspacePrincipal,
) {
  for (
    let attempt = 0;
    attempt < DOCUMENT_AUTHORIZATION_SNAPSHOT_RETRY_LIMIT;
    attempt += 1
  ) {
    const planningRevision = await workItemDependencies.planning.getAuthorizationRevision(
      principal.directoryId,
    )
    const projectRoles = principal.enterprisePermissions === undefined
      ? await getCachedDocumentProjectRoles(
          principal.directoryId,
          principal.userKey,
          principal.workspaceMember.version,
          planningRevision,
        )
      : Object.fromEntries(
          (await getEffectiveProjectAccessList(principal))
            .flatMap(({ projectId, role }) =>
              role === undefined ? [] : [[projectId, role]]
            ),
        ) as Record<string, DocumentProjectRole>
    if (
      await workItemDependencies.planning.getAuthorizationRevision(
        principal.directoryId,
      ) === planningRevision
    ) {
      return { planningRevision, projectRoles }
    }
  }
  throw new DocumentError(
    409,
    'DocumentAuthorizationChanged',
    'Document authorization changed. Reload and try again.',
  )
}

function resolveEnterpriseDocumentRole(
  permissions: readonly EnterprisePermissionId[],
): DocumentProjectRole | undefined {
  if (permissions.includes('documents.manage')) return 'manager'
  if (permissions.includes('documents.write')) return 'member'
  if (permissions.includes('documents.read')) return 'viewer'
  return undefined
}

const enterpriseDocumentPermissionIds = [
  'documents.manage',
  'documents.write',
  'documents.read',
] as const satisfies readonly EnterprisePermissionId[]

/**
 * Current route と独立して評価した Enterprise Document scope です。
 */
type EnterpriseDocumentScopeAccess = {
  /** Project ごとに Document ACL の上限として使う role です。 */
  projectRoles: Record<string, DocumentProjectRole>
  /** Enterprise で許可されていない scope を deny する境界です。 */
  restrictToAuthorizedScopes: true
  /** Workspace scope の Document ACL 上限です。 */
  workspaceScopeRole?: DocumentProjectRole
}

/**
 * Search/notification 内の Document を専用 permission で再評価します。
 */
function resolveEnterpriseDocumentScopeAccess(
  principal: WorkspacePrincipal,
  directory: ProjectDirectoryResponse,
): EnterpriseDocumentScopeAccess | undefined {
  const evaluation =
    principal.enterpriseAuthorizationEvaluation
  if (!evaluation) return undefined

  const evaluateRole = (
    resource: EnterpriseAuthorizationResource,
  ) => resolveEnterpriseDocumentRole(
    enterpriseDocumentPermissionIds.filter((permission) =>
      evaluateEnterpriseAccess({
        permission,
        principal: evaluation.principal,
        assignments: evaluation.assignments,
        customRoles:
          evaluation.snapshot.customRoles,
        groupMappings: evaluation.groupMappings,
        resource,
      }).allowed
    ),
  )
  const workspaceScopeRole = evaluateRole({
    workspaceId: principal.directoryId,
    kind: 'workspace',
  })
  const projectRoles: Record<
    string,
    DocumentProjectRole
  > = {}
  for (const team of directory.teams) {
    for (const project of team.projects) {
      const role = evaluateRole({
        workspaceId: principal.directoryId,
        kind: 'project',
        targetId: project.id,
        parentTeamId: team.id,
      })
      if (!role) continue
      const currentRole = projectRoles[project.id]
      if (
        !currentRole ||
        projectRoleWeights[role] >
          projectRoleWeights[currentRole]
      ) {
        projectRoles[project.id] = role
      }
    }
  }
  return {
    projectRoles,
    restrictToAuthorizedScopes: true,
    ...(workspaceScopeRole
      ? { workspaceScopeRole }
      : {}),
  }
}

function createDocumentEnterpriseScopeBoundary(
  principal: WorkspacePrincipal,
): Pick<
  DocumentAccessContext,
  'restrictToAuthorizedScopes' | 'workspaceScopeRole'
> {
  if (principal.enterprisePermissions === undefined) return {}
  const workspaceScopeRole =
    principal.enterpriseRouteAuthorizedAtResource
      ? resolveEnterpriseDocumentRole(
          principal.enterprisePermissions,
        )
      : undefined
  return {
    restrictToAuthorizedScopes: true,
    ...(workspaceScopeRole === undefined
      ? {}
      : { workspaceScopeRole }),
  }
}

async function getCachedDocumentProjectRoles(
  workspaceId: string,
  memberKey: string,
  workspaceMemberVersion: number,
  planningRevision: number,
) {
  const dependencies = requireAppDependencies()
  let documentProjectRolesCache = documentProjectRolesCaches.get(dependencies)
  if (!documentProjectRolesCache) {
    documentProjectRolesCache = new Map()
    documentProjectRolesCaches.set(dependencies, documentProjectRolesCache)
  }
  const cacheKey = `${workspaceId}\0${memberKey}`
  const now = Date.now()
  const cached = documentProjectRolesCache.get(cacheKey)
  if (
    cached &&
    cached.expiresAt > now &&
    cached.workspaceMemberVersion === workspaceMemberVersion &&
    cached.planningRevision === planningRevision
  ) {
    return cached.value
  }
  if (cached) documentProjectRolesCache.delete(cacheKey)
  const value = workspaceDependencies.projectDirectory.getProjectAccessList(
    workspaceId,
    memberKey,
  ).then((projectAccesses) =>
    Object.fromEntries(
      projectAccesses.flatMap(({ projectId, role }) =>
        role === undefined ? [] : [[projectId, role]]
      ),
    ) as Record<string, DocumentProjectRole>
  ).catch((error: unknown) => {
    documentProjectRolesCache.delete(cacheKey)
    throw error
  })
  documentProjectRolesCache.set(cacheKey, {
    expiresAt: now + documentProjectRolesCacheTtlMs,
    workspaceMemberVersion,
    planningRevision,
    value,
  })
  return value
}

async function validateDocumentRelationTargets(
  principal: DocumentApiPrincipal,
  targets: readonly DocumentRelationTarget[],
) {
  const [directory, planningAuthorizationState] = await Promise.all([
    workspaceDependencies.projectDirectory.getProjectDirectory(
      principal.workspaceId,
      'ja',
      true,
    ),
    targets.some((target) => target.kind === 'goal')
      ? workItemDependencies.planning.getAuthorizationState(principal.workspaceId)
      : undefined,
  ])
  for (
    let offset = 0;
    offset < targets.length;
    offset += DOCUMENT_RELATION_TARGET_VALIDATION_CONCURRENCY
  ) {
    await Promise.all(targets.slice(
      offset,
      offset + DOCUMENT_RELATION_TARGET_VALIDATION_CONCURRENCY,
    ).map(async (target) => {
      if (target.kind === 'goal') {
        const entity = planningAuthorizationState?.entities.find(
          (candidate) =>
            candidate.id === target.goalId &&
            candidate.type === 'goal' &&
            candidate.archivedAt === undefined,
        )
        if (!entity) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Goal was not found.',
          )
        }
        const team = entity.teamId === undefined
          ? undefined
          : directory.teams.find((candidate) => candidate.id === entity.teamId)
        const projectTeam = entity.projectId === undefined
          ? undefined
          : directory.teams.find((candidate) =>
              (entity.teamId === undefined || candidate.id === entity.teamId) &&
              candidate.projects.some((project) => project.id === entity.projectId)
            )
        if (
          (entity.teamId !== undefined && team === undefined) ||
          (entity.projectId !== undefined && projectTeam === undefined)
        ) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Goal was not found.',
          )
        }
        const visible = principal.isSystemAdmin ||
          (entity.projectId !== undefined
            ? principal.projectRoles[entity.projectId] !== undefined
            : team !== undefined
              ? team.projects.some(
                  (project) => principal.projectRoles[project.id] !== undefined,
                )
              : true)
        if (!visible) {
          throw new DocumentError(
            403,
            'DocumentRelationTargetDenied',
            'The related Goal is not visible.',
          )
        }
        return
      }
      if (target.kind === 'project') {
        const exists = directory.teams.some((team) =>
          team.projects.some((project) =>
            project.id === target.projectId
          )
        )
        if (!exists) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Project was not found.',
          )
        }
        if (
          !principal.isSystemAdmin &&
          principal.projectRoles[target.projectId] === undefined
        ) {
          throw new DocumentError(
            403,
            'DocumentRelationTargetDenied',
            'The related Project is not visible.',
          )
        }
        return
      }
      const parsed = parseSearchWorkItemEntityId(target.workItemId)
      if (!parsed) {
        throw new DocumentError(
          400,
          'InvalidDocumentRelationTarget',
          'Work Item targets must use team/<teamId>/issue/<issueId>.',
        )
      }
      const team = directory.teams.find(
        (candidate) => candidate.id === parsed.teamId,
      )
      if (!team) {
        throw new DocumentError(
          400,
          'InvalidDocumentRelationTarget',
          'The related Team was not found.',
        )
      }
      if (
        !principal.isSystemAdmin &&
        !team.projects.some(
          (project) =>
            principal.projectRoles[project.id] !== undefined,
        )
      ) {
        throw new DocumentError(
          403,
          'DocumentRelationTargetDenied',
          'The related Work Item is not visible.',
        )
      }
      let detail: TeamIssueDetailResponse
      try {
        detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
          principal.workspaceId,
          parsed.teamId,
          parsed.issueId,
          { consistentIssueRead: true, eventLimit: 0 },
        )
      } catch (error) {
        if (isTeamIssueNotFoundError(error)) {
          throw new DocumentError(
            400,
            'InvalidDocumentRelationTarget',
            'The related Work Item was not found.',
          )
        }
        throw error
      }
      if (
        detail.issue.assignedProjectId &&
        !principal.isSystemAdmin &&
        principal.projectRoles[
          detail.issue.assignedProjectId
        ] === undefined
      ) {
        throw new DocumentError(
          403,
          'DocumentRelationTargetDenied',
          'The related Work Item is not visible.',
        )
      }
    }))
  }
  return planningAuthorizationState === undefined
    ? undefined
    : [{
        workspaceId: principal.workspaceId,
        planningRevision: planningAuthorizationState.revision,
      } satisfies DocumentAuthorizationFenceSnapshot]
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
    error.status === 413 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 503
    ? error.status
    : 502

  return c.json({ code: error.code, message: error.message }, status)
}

function toTenantAdministrationErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof TenantAdministrationError)) {
    console.error(error)
    return c.json({ message: 'Tenant administration is unavailable.' }, 502)
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 429 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
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
  if (error instanceof WorkItemScheduleError) {
    const status = error.status === 400 ||
        error.status === 403 ||
        error.status === 409 ||
        error.status === 413 ||
        error.status === 503
      ? error.status
      : 500
    return c.json({ code: error.code, message: error.message }, status)
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

/** Analytics domain/persistence error を公開可能な API response へ変換します。 */
function toAnalyticsErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(c, error)
  }
  if (error instanceof ProjectDataError || isTeamIssueNotFoundError(error)) {
    return toProjectDataErrorResponse(c, error)
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return c.json({ code: 'InvalidAnalyticsInput', message: error.message }, 400)
  }
  if (!(error instanceof AnalyticsError)) {
    console.error(error)
    return c.json(
      { code: 'AnalyticsUnavailable', message: 'Analytics data is unavailable.' },
      502,
    )
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
      error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 409 ||
      error.status === 413 ||
      error.status === 422 ||
      error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/** Converts time tracking domain failures to safe API responses. */
function toTimeTrackingErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) return toCognitoDirectoryErrorResponse(c, error)
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(c, error)
  if (error instanceof ProjectDataError || isTeamIssueNotFoundError(error)) {
    return toProjectDataErrorResponse(c, error)
  }
  if (!(error instanceof TimeTrackingError)) {
    console.error(error)
    return c.json({ code: 'TimeTrackingUnavailable', message: 'Time tracking is unavailable.' }, 502)
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 422 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/** Converts capacity-planning failures to safe API responses. */
function toCapacityPlanningErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) return toCognitoDirectoryErrorResponse(c, error)
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(c, error)
  if (error instanceof ProjectDataError || isTeamIssueNotFoundError(error)) {
    return toProjectDataErrorResponse(c, error)
  }
  if (!(error instanceof CapacityPlanningError)) {
    console.error(error)
    return c.json({ code: 'CapacityPlanningUnavailable', message: 'Capacity planning is unavailable.' }, 502)
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 422 ||
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
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
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
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
  if (principal.directoryId !== resolution.workspaceId) {
    throw new RequestIntakeError(404, 'RequestFormUnavailable', 'Request form is unavailable.')
  }
}

/**
 * Resolves a rate-limit client key from the transport source and trusted proxies.
 *
 * @param transportSource - Network peer observed by the server transport.
 * @param forwardedFor - Untrusted forwarded chain supplied by the request.
 * @param trustedProxyAddresses - Transport peers allowed to supply the forwarded chain.
 * @returns The trusted client source or a stable unavailable marker.
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
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja')
  const team = directory.teams.find((candidate) => candidate.id === target.teamId)
  if (!team) {
    throw new RequestIntakeError(400, 'InvalidRequestRouting', 'Request routing Team is inactive.')
  }
  if (target.projectId && !team.projects.some((project) => project.id === target.projectId)) {
    throw new RequestIntakeError(400, 'InvalidRequestRouting', 'Request routing Project is inactive.')
  }
  await requireActiveWorkspaceAssignee(workspaceId, target.assigneeUserId)
  const resolved = await workItemDependencies.workItemConfigurations.getTeamConfiguration(workspaceId, target.teamId)
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

/**
 * Authenticates a Team Triage request and enforces its live Team authorization.
 *
 * Triage can contain requester identity and private routing rationale, so Workspace
 * guests are denied even when they can view a related Project.
 *
 * @param context - Current Hono request context.
 * @param teamId - Team queue identifier from the route.
 * @param access - Minimum Triage access requested by the adapter.
 * @returns The authenticated Workspace and member identifiers.
 */
async function requireTriageTeamAccess(
  context: Context,
  teamId: string,
  access: TriageTeamAccess,
) {
  const accessToken = readBearerAccessToken(context)
  if (!accessToken) {
    throw new TriageError(401, 'TriageAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  if (principal.workspaceRole === 'guest') {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceRoleDenied',
      'Guest members cannot access the Team Triage queue.',
    )
  }
  let teamContext: TeamPermissionContext | undefined
  if (access === 'manage') {
    requireWorkspaceBusinessWrite(principal)
    if (
      principal.enterpriseRouteAuthorizedAtResource &&
      principal.enterprisePermissions !== undefined &&
      principal.enterpriseGrantedRoutePermissions?.includes('teams.manage') !== true
    ) {
      throw new WorkspaceAccessError(
        403,
        'WorkspacePermissionDenied',
        'Team management permission is required for Triage settings.',
      )
    }
    await requireTeamConfigurationAdministration(principal, teamId)
  } else {
    if (access === 'write') requireWorkspaceBusinessWrite(principal)
    teamContext = await requireTeamPermission(
      principal,
      teamId,
      access === 'write' ? 'member' : 'viewer',
    )
    if (isEnterpriseTriageTeamScope(principal, teamId)) {
      teamContext = await mergeTriageProjectAccesses(principal, teamContext)
    }
  }
  const visibleProjectIds = teamContext
    ? resolveRestrictedTriageProjectIds(
        principal,
        teamContext,
        access === 'write' ? 'member' : 'viewer',
      )
    : undefined
  const teamAccess = resolveEffectiveTriageTeamAccess(principal, teamContext, teamId, access)
  const writableProjectIds = resolveWritableTriageProjectIds(
    principal,
    teamContext,
    teamId,
    teamAccess,
  )
  return {
    workspaceId: principal.directoryId,
    userId: principal.userKey,
    auditActor: {
      id: principal.actorId,
      kind: resolveEnterpriseAuditActorKind(principal),
      displayName: principal.userKey,
    },
    ...(principal.enterpriseBreakGlassActivationId
      ? { auditCorrelationId: principal.enterpriseBreakGlassActivationId }
      : {}),
    teamAccess,
    ...(visibleProjectIds !== undefined ? { visibleProjectIds } : {}),
    ...(writableProjectIds !== undefined ? { writableProjectIds } : {}),
  }
}

/** Merges stronger Project-scoped Enterprise access into a Team-scoped read snapshot.
 *
 * Team-level Enterprise read grants synthesize viewer access for every active Project. A
 * principal may simultaneously hold a stronger Project role, so Triage must preserve that
 * narrower write authority without widening it to the whole Team.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Live Team context initially resolved for the route.
 * @returns The context with the strongest role retained for each Project in the Team.
 */
async function mergeTriageProjectAccesses(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
): Promise<TeamPermissionContext> {
  if (principal.isSystemAdmin || context.projectAccesses === undefined) return context
  const teamProjectIds = new Set(context.team.projects.map((project) => project.id))
  const roleByProjectId = new Map(
    context.projectAccesses.map((access) => [access.projectId, access.role] as const),
  )
  for (const access of await getEffectiveProjectAccessList(principal)) {
    if (!teamProjectIds.has(access.projectId) || access.role === undefined) continue
    const currentRole = roleByProjectId.get(access.projectId)
    if (
      currentRole === undefined ||
      projectRoleWeights[access.role] > projectRoleWeights[currentRole]
    ) {
      roleByProjectId.set(access.projectId, access.role)
    }
  }
  for (const project of context.team.projects) {
    const enterpriseRole = resolveTriageEnterpriseProjectRole(
      principal,
      context.team.id,
      project.id,
    )
    if (enterpriseRole === undefined) continue
    const currentRole = roleByProjectId.get(project.id)
    if (
      currentRole === undefined ||
      projectRoleWeights[enterpriseRole] > projectRoleWeights[currentRole]
    ) {
      roleByProjectId.set(project.id, enterpriseRole)
    }
  }
  return {
    ...context,
    projectAccesses: [...roleByProjectId].map(([projectId, role]) => ({ projectId, role })),
  }
}

/** Re-evaluates one Project's full Triage role from the authenticated Enterprise snapshot.
 *
 * The request-level Project list is intentionally derived from the GET route permission and can
 * therefore collapse a stronger write grant to viewer. Re-evaluating the write/manage permissions
 * against the same immutable authorization snapshot preserves the effective role without trusting
 * client state or performing a second directory read.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Parent Team for the Project resource.
 * @param projectId - Project whose Triage role is being projected.
 * @returns The strongest Enterprise Project role, or undefined when no Triage grant applies.
 */
function resolveTriageEnterpriseProjectRole(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
): ProjectRole | undefined {
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (!evaluation) return undefined
  const resource: EnterpriseAuthorizationResource = {
    workspaceId: principal.directoryId,
    kind: 'project',
    targetId: projectId,
    parentTeamId: teamId,
  }
  const allows = (permission: EnterprisePermissionId) =>
    evaluateEnterpriseAccess({
      permission,
      principal: evaluation.principal,
      assignments: evaluation.assignments,
      customRoles: evaluation.snapshot.customRoles,
      groupMappings: evaluation.groupMappings,
      resource,
    }).allowed
  if (allows('teams.write')) {
    return allows('teams.manage') ? 'manager' : 'member'
  }
  return allows('teams.read') ? 'viewer' : undefined
}

/**
 * Resolves the strongest live Team access without widening a read-only Project role.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Live Team and Project access context when the route reads entries.
 * @param teamId - Team whose access is being projected.
 * @param minimumAccess - Access already enforced for the current route.
 * @returns Strongest access that may be advertised in Triage response capabilities.
 */
function resolveEffectiveTriageTeamAccess(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext | undefined,
  teamId: string,
  minimumAccess: TriageTeamAccess,
): TriageTeamAccess {
  if (minimumAccess === 'manage' || principal.isSystemAdmin) return 'manage'
  let effectiveAccess = minimumAccess
  if (isEnterpriseTriageTeamScope(principal, teamId)) {
    const canWrite = principal.enterprisePermissions?.includes('teams.write') === true
    if (canWrite && principal.enterprisePermissions?.includes('teams.manage')) return 'manage'
    if (canWrite) effectiveAccess = 'write'
  }
  if (context?.projectAccesses?.some((entry) => entry.role === 'manager')) return 'manage'
  if (context?.projectAccesses?.some((entry) => entry.role === 'member')) return 'write'
  return effectiveAccess
}

/**
 * Resolves the Project subset for which entry mutations may truthfully be advertised.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Live Team and Project access context.
 * @param teamId - Team whose access is being projected.
 * @param teamAccess - Strongest resolved Team access.
 * @returns Writable Project IDs, an empty read-only set, or undefined for Team-wide write.
 */
function resolveWritableTriageProjectIds(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext | undefined,
  teamId: string,
  teamAccess: TriageTeamAccess,
): readonly string[] | undefined {
  if (teamAccess === 'read') return []
  if (
    principal.isSystemAdmin ||
    isEnterpriseTriageTeamScope(principal, teamId) &&
      principal.enterprisePermissions?.includes('teams.write') === true
  ) {
    return undefined
  }
  if (!context) return undefined
  return resolveRestrictedTriageProjectIds(principal, context, 'member')
}

/**
 * Returns whether current Enterprise authorization covers the routed Team itself.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team route identifier.
 * @returns Whether Team-wide Enterprise permissions are authoritative for this request.
 */
function isEnterpriseTriageTeamScope(
  principal: WorkspacePrincipal,
  teamId: string,
): boolean {
  return principal.enterpriseRouteAuthorizedAtResource === true &&
    (
      principal.enterpriseAuthorizationResource?.kind === 'workspace' ||
      principal.enterpriseAuthorizationResource?.kind === 'team' &&
        principal.enterpriseAuthorizationResource.targetId === teamId
    )
}

/**
 * Narrows a Team queue to the Projects for which the current principal has live access.
 *
 * A principal that can access every active Project receives full Team visibility, which
 * also permits unassigned entries. A partially scoped principal receives only explicit
 * Project IDs so unassigned or cross-Project source metadata is never disclosed.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Live Team directory and Project access snapshot.
 * @param minimumRole - Role required by the current Triage operation.
 * @returns Explicit visible Project IDs, or undefined for full Team visibility.
 */
function resolveRestrictedTriageProjectIds(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  minimumRole: ProjectRole,
): readonly string[] | undefined {
  if (principal.isSystemAdmin || context.projectAccesses === undefined) return undefined
  const visibleProjectIds = context.projectAccesses
    .filter((access) => projectAccessAllows(access, minimumRole))
    .map((access) => access.projectId)
  const activeProjectIds = new Set(context.team.projects.map((project) => project.id))
  if (
    activeProjectIds.size === visibleProjectIds.length &&
    visibleProjectIds.every((projectId) => activeProjectIds.has(projectId))
  ) {
    return undefined
  }
  return visibleProjectIds
}

/**
 * Validates live member and Project references used by one bulk Triage mutation.
 *
 * @param context - Authenticated Hono request context.
 * @param teamId - Team whose entries will be changed.
 * @param input - Strictly parsed bulk action.
 */
async function validateTriageBulkAction(
  context: Context,
  teamId: string,
  input: TriageBulkActionInput,
): Promise<void> {
  const principal = await authenticateTriagePrincipal(context)
  const configuration = await workItemDependencies.triage.getConfiguration(
    principal.directoryId,
    teamId,
  )
  if (!configuration.allowedBulkActions.includes(input.operation.action)) {
    throw new TriageError(
      409,
      'TriageBulkActionDisabled',
      'This bulk action is disabled by the current Team Triage configuration.',
    )
  }
  if (input.operation.action !== 'assign') return
  const teamContext = await requireTeamPermission(principal, teamId, 'member')
  if (input.operation.ownerUserId) {
    await requireActiveWorkspaceAssignee(
      principal.directoryId,
      input.operation.ownerUserId,
    )
  }
  if (input.operation.projectId) {
    requireAssignedProjectPermission(
      principal,
      teamContext,
      input.operation.projectId,
      'member',
    )
  }
}

/**
 * Replaces caller-asserted manual routing metadata with current Team settings.
 *
 * @param context - Authenticated Hono request context.
 * @param teamId - Team receiving the handoff.
 * @param input - Strictly parsed source content.
 * @returns A handoff carrying server-derived Project, owner, SLA, and retention values.
 */
async function prepareTriageManualHandoff(
  context: Context,
  teamId: string,
  input: CreateManualTriageEntryInput,
): Promise<CreateManualTriageEntryInput> {
  const principal = await authenticateTriagePrincipal(context)
  const teamContext = await requireTeamPermission(principal, teamId, 'member')
  const configuration = await workItemDependencies.triage.getConfiguration(
    principal.directoryId,
    teamId,
  )
  const searchableText = `${input.title}\n${input.body}`.toLocaleLowerCase('en-US')
  const rule = [...configuration.rules]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .find((candidate) =>
      candidate.enabled &&
      candidate.sourceKinds.includes('manual-handoff') &&
      (
        candidate.keywords.length === 0 ||
        candidate.keywords.some((keyword) =>
          searchableText.includes(keyword.toLocaleLowerCase('en-US'))
        )
      )
    )
  const projectId = rule?.projectId ?? input.projectId
  requireAssignedProjectPermission(principal, teamContext, projectId, 'member')
  const ownerStrategy = rule?.owner
  const ownerUserId = resolveConfiguredTriageOwner(configuration, ownerStrategy)
  const liveOwnerIds = ownerStrategy?.type === 'rotation'
    ? configuration.rotations.find((rotation) => rotation.id === ownerStrategy.rotationId)
      ?.memberUserIds ?? []
    : ownerUserId ? [ownerUserId] : []
  await Promise.all(liveOwnerIds.map(async (memberUserId) => {
    await requireActiveWorkspaceAssignee(principal.directoryId, memberUserId)
  }))
  const slaPolicy = configuration.slaPolicies.find((policy) =>
    policy.sourceKinds.includes('manual-handoff')
  )
  if (slaPolicy?.escalationOwnerUserId) {
    await requireActiveWorkspaceAssignee(
      principal.directoryId,
      slaPolicy.escalationOwnerUserId,
    )
  }
  const now = new Date()
  const slaDueAt = slaPolicy
    ? new Date(now.getTime() + slaPolicy.responseMinutes * 60_000)
    : undefined
  const escalationDueAt = slaDueAt && slaPolicy?.escalationMinutes !== undefined
    ? new Date(slaDueAt.getTime() + slaPolicy.escalationMinutes * 60_000)
    : undefined
  const retentionExpiresAt = new Date(now)
  retentionExpiresAt.setUTCDate(retentionExpiresAt.getUTCDate() + configuration.retentionDays)
  return {
    sourceId: input.sourceId,
    title: input.title,
    body: input.body,
    requesterDisplayName: input.requesterDisplayName,
    ...(input.requesterEmail ? { requesterEmail: input.requesterEmail } : {}),
    ...(projectId ? { projectId } : {}),
    routingReason: rule
      ? `Matched Team Triage routing rule "${rule.name}".`
      : 'No enabled Team Triage routing rule matched; the handoff remained in the selected Team.',
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(slaPolicy && slaDueAt
      ? {
          slaPolicyId: slaPolicy.id,
          slaDueAt: slaDueAt.toISOString(),
          ...(escalationDueAt ? { escalationDueAt: escalationDueAt.toISOString() } : {}),
        }
      : {}),
    retentionExpiresAt: retentionExpiresAt.toISOString(),
  }
}

/**
 * Resolves a fixed or rotation-backed owner from one current Team configuration.
 *
 * @param configuration - Current Team Triage configuration.
 * @param strategy - Matched routing rule owner strategy.
 * @returns The selected active-member candidate, or undefined for unowned routing.
 */
function resolveConfiguredTriageOwner(
  configuration: TriageConfiguration,
  strategy: TriageConfiguration['rules'][number]['owner'] | undefined,
): string | undefined {
  if (!strategy || strategy.type === 'unowned') return undefined
  if (strategy.type === 'fixed') return strategy.ownerUserId
  const rotation = configuration.rotations.find((candidate) =>
    candidate.id === strategy.rotationId
  )
  return rotation?.memberUserIds[rotation.nextIndex]
}

/**
 * Validates every live directory reference before Team Triage settings are persisted.
 *
 * @param context - Authenticated Hono request context.
 * @param teamId - Team owning the replacement configuration.
 * @param input - Strictly parsed replacement settings.
 */
async function validateTriageConfigurationReferences(
  context: Context,
  teamId: string,
  input: UpdateTriageConfigurationInput,
): Promise<void> {
  const principal = await authenticateTriagePrincipal(context)
  const teamContext = await requireTeamPermission(principal, teamId, 'manager')
  const memberUserIds = new Set<string>()
  for (const rotation of input.rotations) {
    for (const memberUserId of rotation.memberUserIds) memberUserIds.add(memberUserId)
  }
  for (const rule of input.rules) {
    if (rule.teamId !== teamId) {
      throw new TriageError(
        400,
        'InvalidTriageConfiguration',
        'A routing rule cannot target another Team.',
      )
    }
    requireAssignedProjectPermission(principal, teamContext, rule.projectId, 'manager')
    if (rule.owner.type === 'fixed') memberUserIds.add(rule.owner.ownerUserId)
  }
  for (const policy of input.slaPolicies) {
    if (policy.escalationOwnerUserId) memberUserIds.add(policy.escalationOwnerUserId)
  }
  await Promise.all([...memberUserIds].map(async (memberUserId) => {
    await requireActiveWorkspaceAssignee(principal.directoryId, memberUserId)
  }))
}

/**
 * Authenticates a Triage integration hook and denies Workspace guests.
 *
 * @param context - Current Hono request context.
 * @returns The live Workspace principal.
 */
async function authenticateTriagePrincipal(context: Context): Promise<WorkspacePrincipal> {
  const accessToken = readBearerAccessToken(context)
  if (!accessToken) {
    throw new TriageError(401, 'TriageAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  if (principal.workspaceRole === 'guest') {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceRoleDenied',
      'Guest members cannot mutate Team Triage.',
    )
  }
  return principal
}

/**
 * Enforces current Work Item scope before returning reverse Triage source links.
 *
 * @param context - Current Hono request context.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Canonical Work Item identifier.
 */
async function requireTriageWorkItemAccess(
  context: Context,
  teamId: string,
  workItemId: string,
): Promise<void> {
  const accessToken = readBearerAccessToken(context)
  if (!accessToken) {
    throw new TriageError(401, 'TriageAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  if (principal.workspaceRole === 'guest') {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceRoleDenied',
      'Guest members cannot access Triage source links.',
    )
  }
  await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
}

/**
 * Applies an authorized Triage action, intercepting Work Item-dependent operations.
 *
 * @param request - Validated Triage action request from the HTTP adapter.
 * @returns The replay-safe mutation receipt.
 */
async function applyTriageRouteAction(request: TriageRouterActionRequest) {
  const accessToken = readBearerAccessToken(request.context)
  if (!accessToken) {
    throw new TriageError(401, 'TriageAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(
    accessToken,
    undefined,
    request.context,
  )
  if (principal.directoryId !== request.workspaceId || principal.userKey !== request.actor.id) {
    throw new TriageError(404, 'TriageEntryNotFound', 'The triage entry was not found.')
  }
  const currentEntry = await workItemDependencies.triage.getEntryForMutation(
    request.workspaceId,
    request.teamId,
    request.entryId,
  )
  const currentTeamContext = await requireTeamPermission(principal, request.teamId, 'member')
  requireAssignedProjectPermission(
    principal,
    currentTeamContext,
    currentEntry.projectId,
    'member',
  )

  if (request.action.action === 'assign') {
    if (request.action.ownerUserId) {
      await requireActiveWorkspaceAssignee(request.workspaceId, request.action.ownerUserId)
    }
    if (request.action.projectId) {
      requireAssignedProjectPermission(
        principal,
        currentTeamContext,
        request.action.projectId,
        'member',
      )
    }
  }

  const action = request.action
  if (action.action === 'accept' && action.mode === 'create') {
    return await acceptTriageEntryAsNewWorkItem(principal, { ...request, action })
  }

  if (action.action === 'request-information') {
    return await requestTriageInformationFromSource(principal, { ...request, action })
  }

  if (
    currentEntry.source.kind === 'form' &&
    currentEntry.source.submissionId &&
    (action.action === 'assign' || action.action === 'decline')
  ) {
    const replay = await workItemDependencies.triage.getActionReceipt(
      request.workspaceId,
      request.entryId,
      request.idempotency,
    )
    if (replay) return replay
    const submission = await workItemDependencies.requestIntake.getSubmission(
      request.workspaceId,
      currentEntry.source.submissionId,
    )
    const contribution = createTriageActionTransactionItems({
      tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
      audit: {
        tableName: getConfiguredAuditTableName() ?? 'mukuroji-audit-events',
        retentionDays: getConfiguredAuditRetentionDays(),
      },
      entry: currentEntry,
      action,
      actorId: principal.userKey,
      now: new Date().toISOString(),
      idempotency: request.idempotency,
      auditContext: request.auditContext,
    })
    await workItemDependencies.requestIntake.applyAction(
      request.workspaceId,
      submission.id,
      { id: principal.userKey },
      action.action === 'assign'
        ? {
            action: 'assign',
            expectedRevision: submission.revision,
            assigneeUserId: action.ownerUserId,
          }
        : {
            action: 'reject',
            expectedRevision: submission.revision,
            reason: action.reason,
          },
      contribution.transactItems,
    )
    return { entry: contribution.entry, replayed: false }
  }

  if (action.action === 'duplicate' || action.action === 'accept' && action.mode === 'link') {
    const workItemId = action.action === 'duplicate'
      ? action.canonicalWorkItemId
      : action.workItemId
    const { detail } = await loadAuthorizedTeamIssue(
      principal,
      request.teamId,
      workItemId,
      'member',
    )
    if (currentEntry.source.kind === 'form' && currentEntry.source.submissionId) {
      const replay = await workItemDependencies.triage.getActionReceipt(
        request.workspaceId,
        request.entryId,
        request.idempotency,
      )
      if (replay) return replay
      const now = new Date().toISOString()
      const duplicateContext = action.action === 'duplicate'
        ? workItemDependencies.teamIssues.createTriageDuplicateContextTransactionItems?.({
            directoryId: request.workspaceId,
            teamId: detail.issue.teamId,
            workItemId: detail.issue.id,
            expectedWorkItemRevision: detail.issue.revision,
            actorUserId: principal.userKey,
            entry: currentEntry,
            mergedAt: now,
          })
        : undefined
      if (action.action === 'duplicate' && !duplicateContext) {
        throw new TriageError(
          503,
          'TriageDuplicateContextUnavailable',
          'Duplicate context preservation is unavailable.',
        )
      }
      const contribution = createTriageAcceptanceTransactionItems({
        tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
        entry: currentEntry,
        action,
        canonicalWorkItem: {
          teamId: detail.issue.teamId,
          workItemId: detail.issue.id,
          ...(detail.issue.assignedProjectId
            ? { projectId: detail.issue.assignedProjectId }
            : {}),
        },
        actorId: principal.userKey,
        now,
        idempotency: request.idempotency,
        ...(action.action === 'duplicate'
          ? {
              mergeReceipt: {
                canonicalWorkItemId: detail.issue.id,
                mergedSourceCount: 1,
                mergedCommentCount: duplicateContext?.snapshot.commentMetadataCount ?? 0,
                mergedAttachmentCount: duplicateContext?.snapshot.attachmentMetadataCount ?? 0,
                mergedWatcherCount: duplicateContext?.snapshot.watcherMetadataCount ?? 0,
                completedAt: now,
              },
            }
          : {}),
      })
      const submission = await workItemDependencies.requestIntake.getSubmission(
        request.workspaceId,
        currentEntry.source.submissionId,
      )
      await workItemDependencies.requestIntake.completeConversion(
        request.workspaceId,
        submission.id,
        { id: principal.userKey },
        {
          expectedRevision: submission.revision,
          workItem: {
            teamId: detail.issue.teamId,
            workItemId: detail.issue.id,
            ...(detail.issue.assignedProjectId
              ? { projectId: detail.issue.assignedProjectId }
              : {}),
          },
        },
        [
          ...(action.action === 'accept'
            ? [createWorkItemRevisionConditionCheck(
                getTeamIssuesTableName(),
                request.workspaceId,
                detail.issue.teamId,
                detail.issue.id,
                detail.issue.revision,
              )]
            : []),
          ...(duplicateContext?.transactItems ?? []),
          ...contribution.transactItems,
        ],
      )
      return { entry: contribution.entry, replayed: false }
    }
  }

  return await workItemDependencies.triage.applyAction(
    request.workspaceId,
    request.teamId,
    request.entryId,
    request.actor,
    request.action,
    request.idempotency,
    request.auditContext,
  )
}

/**
 * Applies a bounded bulk operation through the same source-aware path as single actions.
 *
 * @param request - Authorized bulk action request from the HTTP adapter.
 * @returns One independently classified result for every target.
 */
async function applyTriageBulkRouteAction(
  request: TriageRouterBulkActionRequest,
): Promise<TriageBulkActionResult> {
  const results: TriageBulkActionResult['results'] = []
  const preparedTargets = request.input.targets.map((target) => {
    const action = createTriageBulkTargetAction(target, request.input.operation)
    const idempotency = {
      key: createTriageBulkTargetIdempotencyKey(
        request.idempotencyKey,
        target.entryId,
      ),
      fingerprint: createTriageInputFingerprint({
        target,
        operation: request.input.operation,
      }),
    }
    const auditContext = request.createAuditContext(target.entryId, idempotency)
    return { action, auditContext, idempotency, target }
  })
  for (const { action, auditContext, idempotency, target } of preparedTargets) {
    try {
      const receipt = await applyTriageRouteAction({
        context: request.context,
        workspaceId: request.workspaceId,
        teamId: request.teamId,
        entryId: target.entryId,
        actor: request.actor,
        action,
        idempotency,
        auditContext,
      })
      results.push({ entryId: target.entryId, status: 'succeeded', entry: receipt.entry })
    } catch (error) {
      if (
        error instanceof TriageError && error.status === 409 ||
        error instanceof RequestIntakeError && error.status === 409
      ) {
        results.push({
          entryId: target.entryId,
          status: 'conflict',
          errorCode: error.code,
        })
        continue
      }
      results.push({
        entryId: target.entryId,
        status: 'failed',
        errorCode: error instanceof TriageError || error instanceof RequestIntakeError ||
            error instanceof ProjectDataError || error instanceof WorkspaceAccessError
          ? error.code
          : 'TriageBulkTargetFailed',
      })
    }
  }
  return { results }
}

/**
 * Expands one bulk operation into a revision-fenced single-entry action.
 *
 * @param target - Entry ID and revision viewed by the operator.
 * @param operation - Validated operation shared by the bulk request.
 * @returns The equivalent single-entry Triage action.
 */
function createTriageBulkTargetAction(
  target: TriageBulkActionInput['targets'][number],
  operation: TriageBulkActionInput['operation'],
): Exclude<TriageActionInput, { action: 'accept' | 'duplicate' | 'request-information' }> {
  if (operation.action === 'assign') {
    return {
      action: 'assign',
      expectedRevision: target.expectedRevision,
      ownerUserId: operation.ownerUserId,
      ...(operation.projectId === undefined ? {} : { projectId: operation.projectId }),
    }
  }
  if (operation.action === 'decline') {
    return {
      action: 'decline',
      expectedRevision: target.expectedRevision,
      reason: operation.reason,
    }
  }
  return {
    action: 'snooze',
    expectedRevision: target.expectedRevision,
    until: operation.until,
  }
}

/**
 * Delivers a Form-source information request and updates Triage in one transaction.
 *
 * Other source kinds fail closed until their production delivery adapter is composed;
 * the queue must never claim that a message was requested when no provider send occurred.
 *
 * @param principal - Current live-authorized Workspace principal.
 * @param request - Validated request-information action.
 * @returns The newly committed or replayed Triage receipt.
 */
async function requestTriageInformationFromSource(
  principal: WorkspacePrincipal,
  request: TriageRouterActionRequest & {
    action: Extract<TriageRouterActionRequest['action'], { action: 'request-information' }>
  },
) {
  const replay = await workItemDependencies.triage.getActionReceipt(
    request.workspaceId,
    request.entryId,
    request.idempotency,
  )
  if (replay) return replay
  const entry = await workItemDependencies.triage.getEntryForMutation(
    request.workspaceId,
    request.teamId,
    request.entryId,
  )
  if (entry.source.kind !== 'form' || !entry.source.submissionId) {
    throw new TriageError(
      409,
      'TriageReplyAdapterUnavailable',
      'The source reply adapter is unavailable for this entry.',
    )
  }
  const submission = await workItemDependencies.requestIntake.getSubmission(
    request.workspaceId,
    entry.source.submissionId,
  )
  const entryWithMessageCount = {
    ...entry,
    sourcePreview: {
      ...entry.sourcePreview,
      commentCount: entry.sourcePreview.commentCount + 1,
    },
  }
  const contribution = createTriageActionTransactionItems({
    tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
    audit: {
      tableName: getConfiguredAuditTableName() ?? 'mukuroji-audit-events',
      retentionDays: getConfiguredAuditRetentionDays(),
    },
    entry: entryWithMessageCount,
    action: request.action,
    actorId: principal.userKey,
    now: new Date().toISOString(),
    idempotency: request.idempotency,
    auditContext: request.auditContext,
  })
  await workItemDependencies.requestIntake.applyAction(
    request.workspaceId,
    submission.id,
    { id: principal.userKey },
    {
      action: 'request-more-info',
      expectedRevision: submission.revision,
      message: request.action.message,
    },
    contribution.transactItems,
  )
  return { entry: contribution.entry, replayed: false }
}

/**
 * Reads the deterministic Form Triage Entry when converting through the legacy Request route.
 *
 * Submissions created before Team Triage existed retain the previous conversion behavior;
 * every newer submission contributes its Triage acceptance to the Work Item transaction.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Work Item destination Team identifier.
 * @param entryId - Deterministic Form Triage Entry identifier.
 * @returns The canonical entry, or undefined for a pre-Triage legacy submission.
 */
async function readLegacyConversionTriageEntry(
  workspaceId: string,
  teamId: string,
  entryId: string,
) {
  try {
    return await workItemDependencies.triage.getEntryForMutation(
      workspaceId,
      teamId,
      entryId,
    )
  } catch (error) {
    if (error instanceof TriageError && error.status === 404) return undefined
    throw error
  }
}

/**
 * Repairs a legacy response-loss window where the Request pointer committed before Triage.
 *
 * Current combined writes cannot enter this state, but an older converted Request may be
 * retried after deployment. Same-Team pointers are linked idempotently; cross-Team legacy
 * pointers remain readable without fabricating a new association.
 *
 * @param context - Current Request conversion retry context.
 * @param principal - Authenticated Workspace administrator.
 * @param submission - Already converted Request submission.
 */
async function repairConvertedRequestTriageProjection(
  context: Context,
  principal: WorkspacePrincipal,
  submission: RequestSubmission,
): Promise<void> {
  if (!submission.workItem || submission.workItem.teamId !== submission.routingTarget.teamId) {
    return
  }
  const entry = await readLegacyConversionTriageEntry(
    principal.directoryId,
    submission.routingTarget.teamId,
    createFormTriageEntryId(submission.id),
  )
  if (!entry || entry.state === 'accepted' || entry.state === 'duplicate') return
  if (entry.state === 'declined') {
    throw new RequestIntakeError(
      409,
      'RequestTriageStateConflict',
      'The corresponding Triage entry was declined.',
    )
  }
  const action: TriageActionInput = {
    action: 'accept',
    mode: 'link',
    expectedRevision: entry.revision,
    workItemId: submission.workItem.workItemId,
  }
  const idempotency: TriageIdempotency = {
    key: context.req.header('Idempotency-Key')?.trim() ||
      `request-conversion-repair:${submission.id}:${submission.workItem.workItemId}`,
    fingerprint: createTriageInputFingerprint({
      workspaceId: principal.directoryId,
      teamId: entry.teamId,
      entryId: entry.id,
      action,
    }),
  }
  await workItemDependencies.triage.applyAction(
    principal.directoryId,
    entry.teamId,
    entry.id,
    { id: principal.userKey },
    action,
    idempotency,
    createApiMutationContext(
      context,
      principal,
      action,
      createTriageActionAuditIdempotencyKey(entry.id, idempotency),
    ),
  )
}

/** Atomic Triage contribution paired with one legacy Request action. */
type LegacyRequestTriageContribution =
  | {
      /** Indicates that the combined mutation was already committed. */
      replayed: true
    }
  | {
      /** Indicates that the caller must execute the returned contribution. */
      replayed: false
      /** Revision-fenced Triage writes appended to the Request transaction. */
      contribution: TriageTransactionContribution
    }

/**
 * Maps one legacy Request action to the canonical Form Triage state atomically.
 *
 * @param context - Current Request action context and idempotency header.
 * @param principal - Authenticated Workspace administrator.
 * @param submission - Strongly read Request submission.
 * @param entry - Strongly read deterministic Form Triage entry.
 * @param input - Non-conversion legacy Request action.
 * @returns A replay marker or unexecuted Triage transaction contribution.
 */
async function createLegacyRequestTriageContribution(
  context: Context,
  principal: WorkspacePrincipal,
  submission: RequestSubmission,
  entry: TriageEntry,
  input: Exclude<RequestSubmissionActionInput, { action: 'convert' }>,
): Promise<LegacyRequestTriageContribution> {
  let action: TriageActionInput
  let duplicateContext: TriageDuplicateContextTransactionContribution | undefined
  let duplicateMergedAt: string | undefined
  if (input.action === 'assign') {
    action = {
      action: 'assign',
      expectedRevision: entry.revision,
      ownerUserId: input.assigneeUserId,
    }
  } else if (input.action === 'request-more-info') {
    action = {
      action: 'request-information',
      expectedRevision: entry.revision,
      message: input.message,
    }
  } else if (input.action === 'reject') {
    action = {
      action: 'decline',
      expectedRevision: entry.revision,
      reason: input.reason,
    }
  } else {
    const duplicateTarget = await workItemDependencies.requestIntake.getSubmission(
      principal.directoryId,
      input.duplicateOfSubmissionId,
    )
    if (!duplicateTarget.workItem || duplicateTarget.workItem.teamId !== entry.teamId) {
      throw new RequestIntakeError(
        409,
        'RequestDuplicateCanonicalWorkItemRequired',
        'A Triage-backed duplicate must target a converted Request in the same Team.',
      )
    }
    const { detail } = await loadAuthorizedTeamIssue(
      principal,
      duplicateTarget.workItem.teamId,
      duplicateTarget.workItem.workItemId,
      'member',
    )
    action = {
      action: 'duplicate',
      expectedRevision: entry.revision,
      canonicalWorkItemId: duplicateTarget.workItem.workItemId,
    }
    const mergedAt = new Date().toISOString()
    duplicateMergedAt = mergedAt
    duplicateContext = workItemDependencies.teamIssues
      .createTriageDuplicateContextTransactionItems?.({
        directoryId: principal.directoryId,
        teamId: detail.issue.teamId,
        workItemId: detail.issue.id,
        expectedWorkItemRevision: detail.issue.revision,
        actorUserId: principal.userKey,
        entry,
        mergedAt,
      })
    if (!duplicateContext) {
      throw new RequestIntakeError(
        503,
        'RequestDuplicateContextUnavailable',
        'Duplicate context preservation is unavailable.',
      )
    }
  }
  const idempotency: TriageIdempotency = {
    key: context.req.header('Idempotency-Key')?.trim() ||
      `request-action:${submission.id}:${input.action}:${input.expectedRevision}`,
    fingerprint: createTriageInputFingerprint({
      workspaceId: principal.directoryId,
      actorId: principal.userKey,
      teamId: entry.teamId,
      entryId: entry.id,
      requestAction: input,
    }),
  }
  const replay = await workItemDependencies.triage.getActionReceipt(
    principal.directoryId,
    entry.id,
    idempotency,
  )
  if (replay) return { replayed: true }
  const tableName = getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local'
  if (action.action === 'duplicate') {
    const completedAt = duplicateMergedAt ?? new Date().toISOString()
    const triage = createTriageAcceptanceTransactionItems({
      tableName,
      entry,
      action,
      canonicalWorkItem: {
        teamId: entry.teamId,
        workItemId: action.canonicalWorkItemId,
      },
      actorId: principal.userKey,
      now: completedAt,
      idempotency,
      mergeReceipt: {
        canonicalWorkItemId: action.canonicalWorkItemId,
        mergedSourceCount: 1,
        mergedCommentCount: duplicateContext?.snapshot.commentMetadataCount ?? 0,
        mergedAttachmentCount: duplicateContext?.snapshot.attachmentMetadataCount ?? 0,
        mergedWatcherCount: duplicateContext?.snapshot.watcherMetadataCount ?? 0,
        completedAt,
      },
    })
    return {
      replayed: false,
      contribution: {
        entry: triage.entry,
        transactItems: [...(duplicateContext?.transactItems ?? []), ...triage.transactItems],
      },
    }
  }
  const entryForAction = action.action === 'request-information'
    ? {
        ...entry,
        sourcePreview: {
          ...entry.sourcePreview,
          commentCount: entry.sourcePreview.commentCount + 1,
        },
      }
    : entry
  return {
    replayed: false,
    contribution: createTriageActionTransactionItems({
      tableName,
      audit: {
        tableName: getConfiguredAuditTableName() ?? 'mukuroji-audit-events',
        retentionDays: getConfiguredAuditRetentionDays(),
      },
      entry: entryForAction,
      action,
      actorId: principal.userKey,
      now: new Date().toISOString(),
      idempotency,
      auditContext: createApiMutationContext(
        context,
        principal,
        input,
        createTriageActionAuditIdempotencyKey(entry.id, idempotency),
      ),
    }),
  }
}

/**
 * Derives the canonical Work Item ID used by every accept-create retry path.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param teamId - Destination Team identifier.
 * @param entryId - Source Triage Entry identifier.
 * @returns A Work Item adapter-compatible deterministic identifier.
 */
function createDeterministicTriageWorkItemId(
  workspaceId: string,
  teamId: string,
  entryId: string,
) {
  const digest = createHash('sha256')
    .update(`${workspaceId}\0${teamId}\0${entryId}`)
    .digest('hex')
  return `triage-${digest.slice(0, 48)}`
}

/**
 * Creates a canonical Work Item and accepts its Triage Entry in one transaction.
 *
 * A Form source also converts its Request submission in the same transaction. The
 * fingerprint-bound receipt is read first so a response-loss retry never creates a
 * second Work Item or repeats the source conversion.
 *
 * @param principal - Current live-authorized Workspace principal.
 * @param request - Validated accept-create action.
 * @returns The newly committed or replayed Triage receipt.
 */
async function acceptTriageEntryAsNewWorkItem(
  principal: WorkspacePrincipal,
  request: TriageRouterActionRequest & {
    action: Extract<TriageRouterActionRequest['action'], { action: 'accept'; mode: 'create' }>
  },
) {
  const replay = await workItemDependencies.triage.getActionReceipt(
    request.workspaceId,
    request.entryId,
    request.idempotency,
  )
  if (replay) return replay

  const entry = await workItemDependencies.triage.getEntryForMutation(
    request.workspaceId,
    request.teamId,
    request.entryId,
  )
  const submission = entry.source.kind === 'form' && entry.source.submissionId
    ? await workItemDependencies.requestIntake.getSubmission(
        request.workspaceId,
        entry.source.submissionId,
      )
    : undefined
  const formConversion = submission
    ? createRequestWorkItemInput(submission, {
        action: 'convert',
        expectedRevision: submission.revision,
        target: {
          teamId: request.teamId,
          ...(request.action.projectId ? { projectId: request.action.projectId } : {}),
        },
      })
    : undefined
  const teamContext = await requireTeamPermission(principal, request.teamId, 'member')
  const assignedProjectId = request.action.projectId ?? entry.projectId
  requireAssignedProjectPermission(
    principal,
    teamContext,
    assignedProjectId,
    'member',
  )
  const assigneeUserId = entry.ownerUserId ?? principal.userKey
  await requireActiveWorkspaceAssignee(request.workspaceId, assigneeUserId)

  const issueId = createDeterministicTriageWorkItemId(
    request.workspaceId,
    request.teamId,
    request.entryId,
  )
  const resolvedConfiguration = await workItemDependencies.workItemConfigurations
    .getTeamConfiguration(request.workspaceId, request.teamId)
  const normalized = normalizeTeamIssueInput({
    ...(formConversion?.input ?? {
      title: entry.sourcePreview.title,
      ...(entry.sourcePreview.body ? { description: entry.sourcePreview.body } : {}),
      schedule: createDefaultUnscheduledWorkItemSchedule(),
      priority: 'medium',
    }),
    assignedProjectId: assignedProjectId ?? null,
    assigneeUserId,
    idempotentIssueId: issueId,
    idempotentRequestDigest: request.idempotency.fingerprint,
  }, teamContext.team)
  const configured = await prepareConfiguredCreateWorkItem(
    request.workspaceId,
    request.teamId,
    normalized,
    resolvedConfiguration,
  )
  const acceptanceReferenceConditionChecks =
    await createTriageAcceptanceReferenceConditionChecks(
      request.workspaceId,
      request.teamId,
      assignedProjectId,
      assigneeUserId,
    )
  const guardedConfigured = {
    ...configured,
    authorizationConditionChecks: [
      ...(configured.authorizationConditionChecks ?? []),
      ...acceptanceReferenceConditionChecks,
    ],
  }
  const now = new Date().toISOString()
  const canonicalWorkItem = {
    teamId: request.teamId,
    workItemId: issueId,
    ...(assignedProjectId ? { projectId: assignedProjectId } : {}),
  }
  const acceptance = createTriageAcceptanceTransactionItems({
    tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
    entry,
    action: request.action,
    canonicalWorkItem,
    actorId: principal.userKey,
    now,
    idempotency: request.idempotency,
  })
  const created = await workItemDependencies.teamIssues.createTeamIssue(
    request.workspaceId,
    request.teamId,
    guardedConfigured,
    principal.userKey,
    createApiMutationContext(request.context, principal, {
      action: 'triage.accept',
      triageEntryId: request.entryId,
      teamId: request.teamId,
    }),
    submission
      ? {
          tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
          scopeKey: `WORKSPACE#${request.workspaceId}`,
          recordKey: `SUBMISSION#${submission.id}`,
          expectedRevision: submission.revision,
          actorId: principal.userKey,
          submissionId: submission.id,
          events: submission.events,
        }
      : undefined,
    {
      entryId: entry.id,
      occurredAt: now,
      transactItems: acceptance.transactItems,
    },
  )
  await projectWorkItemSearchDocumentBestEffort(
    request.workspaceId,
    created.issue,
    'Triage acceptance',
    [],
  )
  return { entry: acceptance.entry, replayed: false }
}

/** Converts Triage failures and existing application errors into the public API envelope. */
function toTriageErrorResponse(context: Context, error: unknown) {
  if (error instanceof CognitoServiceError) return toAuthErrorResponse(context, error)
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(context, error)
  if (error instanceof WorkItemConfigurationError) {
    return toWorkItemConfigurationErrorResponse(context, error)
  }
  if (error instanceof ProjectDataError || isTeamIssueNotFoundError(error)) {
    return toProjectDataErrorResponse(context, error)
  }
  if (error instanceof RequestIntakeError) {
    const status = error.status === 400 || error.status === 404 || error.status === 409 ||
        error.status === 413 || error.status === 422 || error.status === 429 ||
        error.status === 503
      ? error.status
      : 502
    return context.json({ code: error.code, message: error.message }, status)
  }
  if (!(error instanceof TriageError)) {
    console.error(error)
    return context.json(
      { code: 'TriageUnavailable', message: 'Team Triage is unavailable.' },
      503,
    )
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 || error.status === 401 || error.status === 403 ||
      error.status === 404 || error.status === 409 || error.status === 413 ||
      error.status === 422 || error.status === 429 || error.status === 503
    ? error.status
    : 502
  return context.json({ code: error.code, message: error.message }, status)
}

function requireSystemAdmin(principal: ProjectPrincipal) {
  if (
    principal.isSystemAdmin ||
    principal.enterprisePermissions?.includes('audit.read') ||
    principal.enterprisePermissions?.includes('audit.export')
  ) {
    return
  }

  throw new ProjectDataError(
    403,
    'ProjectAccessDenied',
    `User "${principal.userKey}" must be a system administrator.`,
  )
}

function requireWorkspaceBusinessWrite(principal: WorkspacePrincipal) {
  if (
    principal.workspaceRole !== 'guest' &&
    (
      !principal.enterprisePermissions ||
      principal.enterprisePermissions.some((permission) =>
        permission.endsWith('.write') ||
        permission.endsWith('.manage') ||
        permission === 'files.approve'
      )
    )
  ) {
    return
  }

  throw new WorkspaceAccessError(
    403,
    'WorkspaceRoleDenied',
    'Guest members have read-only Workspace access.',
  )
}

function requireWorkspaceAdministration(principal: WorkspacePrincipal) {
  if (principal.enterpriseRouteAuthorizedAtResource) {
    return
  }
  if (
    principal.enterprisePermissions === undefined &&
    (
      principal.workspaceRole === 'owner' ||
      principal.workspaceRole === 'admin'
    )
  ) {
    return
  }

  throw new WorkspaceAccessError(
    403,
    'WorkspaceRoleDenied',
    'Workspace owner or admin access is required.',
  )
}

/**
 * Restricts commercial entitlement changes to a server-verified system administrator.
 *
 * @param principal - Current authenticated Workspace principal.
 */
function requireTenantEntitlementAdministration(principal: WorkspacePrincipal) {
  if (principal.isSystemAdmin) return
  throw new TenantAdministrationError(
    403,
    'TenantEntitlementAdministrationRequired',
    'System administrator access is required to change tenant entitlements.',
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
  const owner = await workspaceDependencies.workspaceAccess.getActiveMember(principal.directoryId, memberKey)
  if (!owner) {
    throw new PlanningError(
      409,
      'PlanningOwnerInactive',
      'Planning owner must be an active Workspace member.',
    )
  }
}

/**
 * Validates one qualified Work Item endpoint before it is used for authorization.
 *
 * @param value - Untrusted endpoint object from a Planning request.
 * @param label - Human-readable endpoint role.
 * @returns Canonical Team and Work Item identifiers.
 */
function readPlanningWorkItemDependencyEndpoint(
  value: unknown,
  label: string,
): WorkItemDependencyEndpoint {
  if (!isRecord(value) || Object.keys(value).some((key) =>
    key !== 'teamId' && key !== 'workItemId'
  )) {
    throw new PlanningError(
      400,
      'InvalidPlanningInput',
      `${label} Work Item endpoint is invalid.`,
    )
  }
  return {
    teamId: readPlanningIdentifier(value.teamId, `${label} Team ID`),
    workItemId: readPlanningIdentifier(value.workItemId, `${label} Work Item ID`),
  }
}

/**
 * Requires Team and assigned-Project permission for one Work Item dependency endpoint.
 *
 * @param principal - Authenticated Workspace principal.
 * @param endpoint - Qualified Work Item endpoint.
 * @param minimumRole - Required role at both Team and assigned Project scopes.
 * @returns Strongly read authorized Work Item detail.
 */
async function requirePlanningWorkItemEndpointPermission(
  principal: WorkspacePrincipal,
  endpoint: WorkItemDependencyEndpoint,
  minimumRole: Extract<ProjectRole, 'viewer' | 'member' | 'manager'>,
) {
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation && !principal.isSystemAdmin) {
    const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
      principal.directoryId,
      'ja',
    )
    const team = directory.teams.find((candidate) => candidate.id === endpoint.teamId)
    if (!team) {
      throw new ProjectDataError(404, 'TeamNotFound', 'Schedule dependency Team was not found.')
    }
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      endpoint.teamId,
      endpoint.workItemId,
      { consistentIssueRead: true, eventLimit: 0 },
    )
    const assignedProjectId = detail.issue.assignedProjectId
    if (
      assignedProjectId &&
      !team.projects.some((project) => project.id === assignedProjectId)
    ) {
      throw new ProjectDataError(
        409,
        'PlanningWorkItemScopeMismatch',
        'Schedule dependency Work Item assignment does not match its owning Team.',
      )
    }
    const permission: EnterprisePermissionId = minimumRole === 'viewer'
      ? 'work-items.read'
      : minimumRole === 'member'
        ? 'work-items.write'
        : 'planning.manage'
    const allowed = evaluateEnterpriseAccess({
      permission,
      principal: evaluation.principal,
      assignments: evaluation.assignments,
      customRoles: evaluation.snapshot.customRoles,
      groupMappings: evaluation.groupMappings,
      resource: assignedProjectId
        ? {
            workspaceId: principal.directoryId,
            kind: 'project',
            targetId: assignedProjectId,
            parentTeamId: endpoint.teamId,
          }
        : {
            workspaceId: principal.directoryId,
            kind: 'team',
            targetId: endpoint.teamId,
          },
    }).allowed
    if (!allowed) {
      throw new ProjectDataError(
        403,
        'WorkItemScheduleDependencyAccessDenied',
        'Schedule dependency impact cannot be evaluated within the current access scope.',
      )
    }
    const role = minimumRole
    return {
      context: {
        team,
        directory,
        projectAccesses: assignedProjectId
          ? [{ projectId: assignedProjectId, teamId: endpoint.teamId, role }]
          : [],
      } satisfies TeamPermissionContext,
      detail,
    }
  }
  return loadAuthorizedTeamIssue(
    principal,
    endpoint.teamId,
    endpoint.workItemId,
    minimumRole,
  )
}

/**
 * Re-evaluates schedule permissions independently of the root route resource.
 *
 * @remarks
 * A schedule dependency graph may cross Team and Project boundaries. Enterprise route
 * authorization is intentionally bound to the root Work Item, so graph evaluation must derive a
 * separate principal from the authentication-time authoritative snapshot before checking each
 * server-owned endpoint.
 *
 * @param principal - Authenticated Workspace principal for the root schedule route.
 * @param minimumRole - Schedule permission required on every evaluated endpoint.
 * @returns Principal restricted to every currently authorized Team and Project for that permission.
 */
async function createWorkItemScheduleScopedPrincipal(
  principal: WorkspacePrincipal,
  minimumRole: Extract<ProjectRole, 'viewer' | 'member'>,
): Promise<WorkspacePrincipal> {
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (!evaluation || principal.isSystemAdmin) return principal

  const permission: EnterprisePermissionId = minimumRole === 'viewer'
    ? 'work-items.read'
    : 'work-items.write'
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
  )
  const evaluateResource = (resource: EnterpriseAuthorizationResource) =>
    evaluateEnterpriseAccess({
      permission,
      principal: evaluation.principal,
      assignments: evaluation.assignments,
      customRoles: evaluation.snapshot.customRoles,
      groupMappings: evaluation.groupMappings,
      resource,
    }).allowed
  const enterpriseProjectAccesses: ProjectAccessEntry[] = []
  const enterpriseAuthorizedTeamIds: string[] = []
  const enterpriseTeamAccesses: EnterpriseTeamAccess[] = []

  for (const team of directory.teams) {
    if (evaluateResource({
      workspaceId: principal.directoryId,
      kind: 'team',
      targetId: team.id,
    })) {
      enterpriseAuthorizedTeamIds.push(team.id)
      enterpriseTeamAccesses.push({ teamId: team.id, permissions: [permission] })
    }
    for (const project of team.projects) {
      if (!evaluateResource({
        workspaceId: principal.directoryId,
        kind: 'project',
        targetId: project.id,
        parentTeamId: team.id,
      })) {
        continue
      }
      enterpriseProjectAccesses.push({
        projectId: project.id,
        teamId: team.id,
        role: minimumRole,
      })
    }
  }

  return {
    ...principal,
    enterpriseProjectAccesses,
    enterpriseAuthorizedTeamIds,
    enterpriseTeamAccesses,
    enterpriseRouteAuthorizedAtResource: false,
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
  if (teamId && !projectId && principal.enterprisePermissions !== undefined) {
    const resource = principal.enterpriseAuthorizationResource
    if (
      !principal.enterpriseRouteAuthorizedAtResource ||
      !resource ||
      (
        resource.kind !== 'workspace' &&
        !(resource.kind === 'team' && resource.targetId === teamId)
      )
    ) {
      throw new PlanningError(
        403,
        'ProjectAccessDenied',
        'Enterprise Team permission is required for this Planning scope.',
      )
    }
    const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
    if (!directory.teams.some((team) => team.id === teamId)) {
      throw new PlanningError(404, 'TeamNotFound', 'Planning Team was not found.')
    }
    return
  }
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
  /** Document source of truth の ACL 評価に使う current viewer です。 */
  documentAccess: DocumentAccessContext
  /** Search result の current viewer scope です。 */
  searchAccess: WorkspaceSearchAccessScope
  /** Saved view の current viewer scope です。 */
  savedViewAccess: SavedViewAccessScope
}

async function createWorkspaceSearchContext(
  principal: WorkspacePrincipal,
): Promise<WorkspaceSearchContext> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja', true)
  const projectAccesses = principal.isSystemAdmin
    ? directory.teams.flatMap((team) => team.projects.map((project) => ({
        projectId: project.id,
        role: 'manager' as const,
      })))
    : await getEffectiveProjectAccessList(principal)
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
  const activeTeamIds = new Set(directory.teams.map((team) => team.id))
  for (const teamId of principal.enterpriseAuthorizedTeamIds ?? []) {
    if (activeTeamIds.has(teamId)) readableTeamIds.add(teamId)
  }
  const manageableTeamIds = new Set(
    directory.teams
      .filter((team) => team.projects.some((project) => manageableProjectIds.has(project.id)))
      .map((team) => team.id),
  )
  const projectRoles = Object.fromEntries(
    projectAccesses.flatMap(({ projectId, role }) =>
      role === undefined ? [] : [[projectId, role]]
    ),
  ) as Record<string, DocumentProjectRole>
  const enterpriseDocumentScopeAccess =
    resolveEnterpriseDocumentScopeAccess(
      principal,
      directory,
    )

  return {
    directory,
    documentAccess: {
      memberKey: principal.userKey,
      workspaceRole: principal.workspaceRole,
      isSystemAdmin: principal.isSystemAdmin,
      ...(enterpriseDocumentScopeAccess ?? {
        projectRoles,
        ...createDocumentEnterpriseScopeBoundary(
          principal,
        ),
      }),
    },
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
  documentSearchReadContext: ReturnType<
    typeof createDocumentSearchAccessReadContext
  >,
) {
  if (document.entityType === 'document') {
    if (
      document.sourceRevision === undefined ||
      document.updatedAt === undefined
    ) {
      return undefined
    }
    const currentAccess =
      await workItemDependencies.documents.resolveSearchAccess({
        workspaceId,
        documentId: document.entityId,
        access: context.documentAccess,
        expectedRevision:
          document.sourceRevision,
        expectedUpdatedAt:
          document.updatedAt,
        readContext:
          documentSearchReadContext,
      })
    if (currentAccess === undefined) {
      return undefined
    }
    const currentDocument = {
      ...document,
    }
    if (currentAccess.body.length > 0) {
      currentDocument.body =
        currentAccess.body
    } else {
      delete currentDocument.body
    }
    return {
      ...(currentAccess.scope.type === 'project'
        ? {
            projectId:
              currentAccess.scope.projectId,
          }
        : {}),
      permissionVerified: true,
      currentDocument,
    }
  }

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
      pending = workItemDependencies.teamIssues.getTeamIssueDetail(
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
      const relationPage = await workItemDependencies.workItemConfigurations.listRelations(
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
    const comment = await workItemDependencies.collaboration.getCommentSnapshot({
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
    principal.enterpriseRouteAuthorizedAtResource &&
    (
      principal.enterpriseAuthorizationResource?.kind === 'workspace' ||
      principal.enterpriseAuthorizationResource?.kind === 'team' &&
        principal.enterpriseAuthorizationResource.targetId === teamId
    )
  ) {
    return
  }
  if (principal.enterprisePermissions !== undefined) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'Enterprise permission is required for this Team operation.',
    )
  }
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
    workItemDependencies.teamIssues.getTeamIssueDetail(principal.directoryId, teamId, sourceWorkItemId, {
      consistentIssueRead: true,
      eventLimit: 0,
    }),
    workItemDependencies.teamIssues.getTeamIssueDetail(principal.directoryId, teamId, targetWorkItemId, {
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
        const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
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
  const managedProject = (await workspaceDependencies.projectDirectory.getProjectAccessList(directoryId, memberKey))
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
  const authorizationState = await workItemDependencies.planning.getAuthorizationState(directoryId)
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

/** Maximum dependency endpoints that leave room for archive, audit, and Planning actions. */
const PROJECT_ARCHIVE_DEPENDENCY_ENDPOINT_LIMIT = 96

/**
 * Verifies that a Team owns no active Planning scope or dependency endpoint.
 *
 * @param directoryId - Workspace whose Planning graph is checked.
 * @param teamId - Team being archived.
 * @returns Planning revision that must still hold in the archive transaction.
 */
async function requirePlanningTeamScopeIsUnused(directoryId: string, teamId: string) {
  const authorizationState = await workItemDependencies.planning.getAuthorizationState(directoryId)
  const scopedEntity = authorizationState.entities.find((entity) =>
    !entity.archivedAt && entity.teamId === teamId
  )
  const scopedLink = authorizationState.workItemLinks.find((link) => link.teamId === teamId)
  const scopedDependency = authorizationState.workItemDependencies.find((dependency) =>
    dependency.predecessor.teamId === teamId || dependency.successor.teamId === teamId
  )
  if (scopedEntity || scopedLink || scopedDependency) {
    throw new WorkspaceAccessError(
      409,
      'PlanningTeamScopeInUse',
      'Move or archive active Planning entities and remove Work Item links and dependencies before archiving this Team.',
    )
  }
  return authorizationState.revision
}

/**
 * Verifies that a Project owns no active Planning scope or dependency endpoint assignment.
 *
 * The returned Work Item revisions close the race between the canonical assignment reads and
 * the directory archive transaction. Planning's global revision separately serializes graph
 * mutations with the archive.
 *
 * @param directoryId - Workspace whose Planning graph and Work Items are checked.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project being archived.
 * @returns Planning and canonical Work Item revisions required by the archive transaction.
 */
async function requirePlanningProjectScopeIsUnused(
  directoryId: string,
  teamId: string,
  projectId: string,
) {
  const authorizationState = await workItemDependencies.planning.getAuthorizationState(directoryId)
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

  const endpointByKey = new Map<string, { teamId: string; workItemId: string }>()
  for (const dependency of authorizationState.workItemDependencies) {
    for (const endpoint of [dependency.predecessor, dependency.successor]) {
      if (endpoint.teamId !== teamId) continue
      endpointByKey.set(createWorkItemDependencyKey(endpoint), endpoint)
    }
  }
  const endpoints = [...endpointByKey.values()].sort((left, right) =>
    createWorkItemDependencyKey(left).localeCompare(createWorkItemDependencyKey(right))
  )
  if (endpoints.length > PROJECT_ARCHIVE_DEPENDENCY_ENDPOINT_LIMIT) {
    throw new WorkspaceAccessError(
      413,
      'PlanningProjectScopeDependencyLimitExceeded',
      'The Project has too many dependency endpoints to archive atomically.',
    )
  }

  const workItemRevisionGuards: ProjectArchiveWorkItemRevisionGuard[] = await Promise.all(
    endpoints.map(async (endpoint) => {
      let detail: TeamIssueDetailResponse
      try {
        detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
          directoryId,
          endpoint.teamId,
          endpoint.workItemId,
          { consistentIssueRead: true, eventLimit: 0 },
        )
      } catch (error) {
        if (!isTeamIssueNotFoundError(error)) throw error
        throw new WorkspaceAccessError(
          409,
          'PlanningProjectScopeInUse',
          'Remove unresolved Work Item dependencies before archiving this Project.',
        )
      }
      if (detail.issue.assignedProjectId === projectId) {
        throw new WorkspaceAccessError(
          409,
          'PlanningProjectScopeInUse',
          'Move dependency Work Items to another Project or remove their dependencies before archiving this Project.',
        )
      }
      return {
        teamId: endpoint.teamId,
        workItemId: endpoint.workItemId,
        expectedRevision: detail.issue.revision,
      }
    }),
  )
  return {
    expectedPlanningRevision: authorizationState.revision,
    workItemRevisionGuards,
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
  const categoryStatus = mapAutomationErrorStatus(error.category)
  const status = error.status === categoryStatus ? categoryStatus : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Maps a transport-neutral Automation error category to the HTTP API status.
 *
 * @param category - Stable Automation failure category.
 * @returns HTTP status exposed by the Automation inbound adapter.
 */
function mapAutomationErrorStatus(category: AutomationErrorCategory) {
  switch (category) {
    case 'invalid-input': return 400
    case 'unauthenticated': return 401
    case 'forbidden': return 403
    case 'not-found': return 404
    case 'conflict': return 409
    case 'payload-too-large': return 413
    case 'unsupported-media-type': return 415
    case 'unprocessable': return 422
    case 'locked': return 423
    case 'rate-limited': return 429
    case 'unavailable': return 503
  }
}

const currentAssigneeNotificationReasons = new Set([
  'assignee',
  'assignment',
  'due',
  'due-date-change',
  'overdue',
  'schedule-change',
  'status-change',
])

/** Notification が現在の担当者であることだけを配信理由にしているか判定します。 */
function requiresCurrentWorkItemAssignee(notification: NotificationItem) {
  return notification.reasons.length > 0 && notification.reasons.every(
    (reason) => currentAssigneeNotificationReasons.has(reason),
  )
}

/** Returns whether a Triage notification is meaningful only to the current owner. */
function requiresCurrentTriageOwner(notification: NotificationItem) {
  return notification.reasons.length > 0 && notification.reasons.every((reason) =>
    reason === 'assignee' || reason === 'assignment' || reason === 'due' ||
    reason === 'overdue' || reason === 'sla' || reason === 'triage-sla' ||
    reason === 'escalation' || reason === 'triage-assignment'
  )
}

async function createNotificationVisibilityFilter(
  principal: WorkspacePrincipal,
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja', true)
  const activeTeamIds = new Set(directory.teams.map((team) => team.id))
  const projectTeamIds = new Map<string, Set<string>>()
  for (const team of directory.teams) {
    for (const project of team.projects) {
      const teamIds = projectTeamIds.get(project.id) ?? new Set<string>()
      teamIds.add(team.id)
      projectTeamIds.set(project.id, teamIds)
    }
  }
  const projectAccesses = principal.isSystemAdmin
    ? [...projectTeamIds.keys()].map((projectId) => ({
        projectId,
        role: 'manager' as const,
      }))
    : await getEffectiveProjectAccessList(principal)
  const accessibleProjectIds = new Set(
    projectAccesses
      .filter((access) =>
        projectAccessAllows(access, 'viewer') &&
        projectTeamIds.has(access.projectId)
      )
      .map((access) => access.projectId),
  )
  const accessibleTeamIds = principal.isSystemAdmin
    ? activeTeamIds
    : new Set(
        [
          ...[...accessibleProjectIds]
            .flatMap((projectId) => [...(projectTeamIds.get(projectId) ?? [])]),
          ...(principal.enterpriseAuthorizedTeamIds ?? [])
            .filter((teamId) => activeTeamIds.has(teamId)),
        ],
      )
  const fullyAccessibleTeamIds = new Set(
    directory.teams
      .filter((team) =>
        principal.isSystemAdmin ||
        principal.enterpriseAuthorizedTeamIds?.includes(team.id) === true ||
        (
          team.projects.length > 0 &&
          team.projects.every((project) => accessibleProjectIds.has(project.id))
        )
      )
      .map((team) => team.id),
  )
  const workItemScopes = new Map<string, Promise<{
    assigneeMemberKey?: string
    exists: boolean
    projectId?: string
  }>>()
  const triageScopes = new Map<string, Promise<{
    /** Whether the canonical Triage Entry still exists in this Team. */
    exists: boolean
    /** Current owner used to suppress stale owner-only notifications. */
    ownerUserId?: string
    /** Current assigned Project used to re-evaluate the notification scope. */
    projectId?: string
    /** Current permission-safe title replacing historical source content. */
    title?: string
    /** Whether event summary content must be removed from the response. */
    restricted: boolean
  }>>()
  const enterpriseDocumentScopeAccess =
    resolveEnterpriseDocumentScopeAccess(
      principal,
      directory,
    )
  const documentAccess: DocumentAccessContext = {
    memberKey: principal.userKey,
    workspaceRole: principal.workspaceRole,
    isSystemAdmin: principal.isSystemAdmin,
    ...(enterpriseDocumentScopeAccess ?? {
      projectRoles: Object.fromEntries(
        projectAccesses.flatMap(({ projectId, role }) =>
          role === undefined ? [] : [[projectId, role]]
        ),
      ) as Record<string, DocumentProjectRole>,
      ...createDocumentEnterpriseScopeBoundary(
        principal,
      ),
    }),
  }
  const documentVisibilities = new Map<string, Promise<boolean>>()

  return async (notification: NotificationItem) => {
    if (notification.eventType.startsWith('document.')) {
      if (!notification.entityId) return false
      let visibility = documentVisibilities.get(notification.entityId)
      if (visibility === undefined) {
        visibility = workItemDependencies.documents.get({
          workspaceId: principal.directoryId,
          documentId: notification.entityId,
          access: documentAccess,
        }).then(() => true).catch((error: unknown) => {
          if (
            error instanceof DocumentError &&
            (error.status === 403 || error.status === 404)
          ) {
            return false
          }
          throw error
        })
        documentVisibilities.set(notification.entityId, visibility)
      }
      if (!await visibility) return false
    }
    if (notification.teamId && notification.triageEntryId) {
      const scopeKey = `${notification.teamId}\0${notification.triageEntryId}`
      let scope = triageScopes.get(scopeKey)
      if (!scope) {
        scope = workItemDependencies.triage.getEntry(
          principal.directoryId,
          notification.teamId,
          notification.triageEntryId,
        ).then((entry) => ({
          exists: true,
          ...(entry.ownerUserId ? { ownerUserId: entry.ownerUserId } : {}),
          ...(entry.projectId ? { projectId: entry.projectId } : {}),
          title: entry.permission.visibility === 'denied' ||
              entry.retention.redactedAt !== undefined
            ? 'Restricted source'
            : entry.sourcePreview.title,
          restricted: entry.permission.visibility !== 'full' ||
            entry.retention.redactedAt !== undefined,
        })).catch((error: unknown) => {
          if (error instanceof TriageError && error.status === 404) {
            return { exists: false, restricted: true }
          }
          throw error
        })
        triageScopes.set(scopeKey, scope)
      }
      const currentScope = await scope
      if (!currentScope.exists) return false
      if (currentScope.title) notification.title = currentScope.title
      if (currentScope.restricted) delete notification.summary
      if (
        !notification.issueId &&
        requiresCurrentTriageOwner(notification) &&
        (
          !currentScope.ownerUserId ||
          normalizeProjectMemberKey(currentScope.ownerUserId) !==
            normalizeProjectMemberKey(principal.userKey)
        )
      ) {
        return false
      }
      if (currentScope.projectId) {
        notification.projectId = currentScope.projectId
        if (
          projectTeamIds.get(currentScope.projectId)?.has(notification.teamId) !== true ||
          !accessibleProjectIds.has(currentScope.projectId)
        ) {
          return false
        }
      } else {
        delete notification.projectId
        if (!fullyAccessibleTeamIds.has(notification.teamId)) return false
      }
    }
    if (notification.teamId && notification.issueId) {
      const scopeKey = `${notification.teamId}\0${notification.issueId}`
      let scope = workItemScopes.get(scopeKey)
      if (!scope) {
        scope = workItemDependencies.teamIssues.getTeamIssueDetail(
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

  if (error.code === 'InvalidProjectQuickAccessInput') {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (error.code === 'InvalidWorkItemArchiveUpdate') {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (
    error.code.startsWith('InvalidWorkItemSchedule') ||
    error.code === 'WorkItemScheduleDurationMismatch'
  ) {
    return c.json({ code: error.code, message: error.message }, 400)
  }

  if (error.code === 'WorkItemListLimitExceeded') {
    return c.json({ code: error.code, message: error.message }, 413)
  }

  if (error.code === 'WorkItemScheduleCascadeLimitExceeded') {
    return c.json({ code: error.code, message: error.message }, 413)
  }

  if (error.code === 'PlanningProjectScopeDependencyLimitExceeded') {
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

  if (error.code === 'PlanningWorkItemScopeMismatch') {
    return c.json({ code: error.code, message: error.message }, 409)
  }

  if (
    error.code === 'WorkItemRelationGraphConflict' ||
    error.code === 'WorkItemScheduleDependencyConflict' ||
    error.code === 'WorkItemScheduleCascadeConflict' ||
    error.code === 'PlanningWorkItemArchived' ||
    error.code === 'WorkItemAuthorizationChanged'
  ) {
    return c.json({ code: error.code, message: error.message }, 409)
  }

  if (
    error.code === 'WorkItemScheduleCascadeUnavailable' ||
    error.code === 'WorkItemScheduleCascadeTransactionUnavailable'
  ) {
    console.error(error)
    return c.json({ code: error.code, message: error.message }, 503)
  }

  if (error.code === 'ProjectQuickAccessConflict') {
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
    error.code === 'InvalidProjectQuickAccess' ||
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

  if (error.code === 'WorkItemScheduleDependencyAccessDenied') {
    return c.json({
      code: error.code,
      message: 'Schedule dependency impact cannot be evaluated within the current access scope.',
    }, 403)
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

  const enterpriseProjectAccess = principal.enterpriseProjectAccesses?.find((access) =>
    access.projectId === projectId
  )
  if (
    enterpriseProjectAccess &&
    projectAccessAllows(enterpriseProjectAccess, minimumRole)
  ) {
    return
  }

  const projectAccess = principal.enterpriseLegacyProjectAccessSuppressed
    ? undefined
    : await workspaceDependencies.projectDirectory.getProjectAccess(
        principal.directoryId,
        projectId,
        principal.userKey,
      )
  if (
    !projectAccess ||
    !projectAccessAllows(projectAccess, minimumRole)
  ) {
    throw new ProjectDataError(
      403,
      'ProjectAccessDenied',
      `User "${principal.userKey}" with role "${projectAccess?.role ?? 'none'}" cannot access project "${projectId}".`,
    )
  }
}

async function getEffectiveProjectAccessList(principal: ProjectPrincipal) {
  const directAccesses = principal.enterpriseLegacyProjectAccessSuppressed
    ? []
    : await workspaceDependencies.projectDirectory.getProjectAccessList(
        principal.directoryId,
        principal.userKey,
      )
  const roleByProjectId = new Map(
    directAccesses.map((access) => [access.projectId, access.role] as const),
  )
  for (const enterpriseAccess of principal.enterpriseProjectAccesses ?? []) {
    const directRole = roleByProjectId.get(enterpriseAccess.projectId)
    const enterpriseRole = enterpriseAccess.role
    if (
      enterpriseRole &&
      (
        !directRole ||
        projectRoleWeights[enterpriseRole] > projectRoleWeights[directRole]
      )
    ) {
      roleByProjectId.set(enterpriseAccess.projectId, enterpriseRole)
    }
  }
  return [...roleByProjectId].map(([projectId, role]) => ({ projectId, role }))
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
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const team = directory.teams.find((candidate) => candidate.id === teamId)

  if (!team) {
    throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
  }

  if (principal.isSystemAdmin) {
    return { team, directory }
  }

  const enterprisePermission = minimumRole === 'manager'
    ? 'teams.manage'
    : minimumRole === 'member'
      ? 'teams.write'
      : 'teams.read'
  if (
    principal.enterpriseRouteAuthorizedAtResource &&
    (
      principal.enterpriseAuthorizationResource?.kind === 'workspace' ||
      principal.enterpriseAuthorizationResource?.kind === 'team' &&
        principal.enterpriseAuthorizationResource.targetId === teamId
    ) &&
    principal.enterprisePermissions?.includes(enterprisePermission)
  ) {
    const role = minimumRole === 'manager'
      ? 'manager'
      : minimumRole === 'member'
        ? 'member'
        : 'viewer'
    return {
      team,
      directory,
      projectAccesses: team.projects.map((project) => ({
        projectId: project.id,
        role,
      })),
    }
  }

  const teamProjectIds = new Set(team.projects.map((project) => project.id))
  const projectAccesses = (await getEffectiveProjectAccessList(principal))
    .filter((projectAccess) => teamProjectIds.has(projectAccess.projectId))

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

async function requireWebhookTeamPermission(
  principal: WorkspacePrincipal,
  teamId: string,
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
    true,
  )
  const team = directory.teams.find((candidate) => candidate.id === teamId)

  if (!team) {
    throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
  }

  const teamProjectIds = new Set(team.projects.map((project) => project.id))
  const [projectAccesses, enterpriseSnapshot] = await Promise.all([
    workspaceDependencies.projectDirectory.getProjectAccessList(
      principal.directoryId,
      principal.userKey,
    ),
    principal.enterpriseAuthorizationEvaluation?.snapshot ??
      workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId),
  ])
  const legacyReadAllowed = projectAccesses
    .filter((projectAccess) => teamProjectIds.has(projectAccess.projectId))
    .some((projectAccess) => projectAccessAllows(projectAccess, 'viewer'))
  const access = evaluateWebhookEnterpriseTeamAccess({
    snapshot: enterpriseSnapshot,
    memberKey: principal.userKey,
    memberEmail: principal.workspaceMember.email,
    workspaceRole: principal.workspaceRole,
    cognitoGroupIds: principal.groups,
    currentSystemAdministrator: principal.isSystemAdmin,
    activeWorkspaceMember: principal.workspaceMemberStatus === 'active',
    activeTeam: true,
    activeProject: true,
    legacyReadAllowed,
    teamId,
  })
  if (access.allowed) {
    return
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
  const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
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

/**
 * Resolves an approval completion transition against current workflow state.
 *
 * @param directoryId - Owning Workspace directory identifier.
 * @param teamId - Owning Team identifier.
 * @param workItem - Canonical Work Item being approved.
 * @param completionTransition - Requested target workflow status.
 * @param dependencies - Ports used to read workflow configuration.
 * @returns A transaction-ready completion transition snapshot.
 */
async function resolveFileApprovalCompletionTransition(
  directoryId: string,
  teamId: string,
  workItem: ReturnType<typeof requireCanonicalFileProofingWorkItem>,
  completionTransition: string,
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
) {
  try {
    const resolved = await dependencies.workItemConfigurations.getTeamConfiguration(
      directoryId,
      teamId,
    )
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
): Promise<FileApprovalCompletionTransition | undefined> {
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
      const member = await workspaceDependencies.workspaceAccess.getActiveMember(workspaceId, memberKey)

      if (!member) {
        throw new ProjectDataError(
          400,
          'InvalidCommentMention',
          `Mentioned Workspace member "${memberKey}" is not active.`,
        )
      }

      if (assignedProjectId) {
        const access = await workspaceDependencies.projectDirectory.getProjectAccess(
          workspaceId,
          assignedProjectId,
          memberKey,
        )

        if (
          (!access || !projectAccessAllows(access, 'viewer')) &&
          !(await authenticationDependencies.cognito.isSystemAdmin(memberKey))
        ) {
          throw new ProjectDataError(
            400,
            'InvalidCommentMention',
            `Mentioned Workspace member "${memberKey}" cannot view the assigned project.`,
          )
        }

        return
      }

      const canViewOwningTeam = (await workspaceDependencies.projectDirectory.getProjectAccessList(workspaceId, memberKey))
        .some((access) =>
          activeTeamProjectIds.has(access.projectId) && projectAccessAllows(access, 'viewer'),
        )

      if (!canViewOwningTeam && !(await authenticationDependencies.cognito.isSystemAdmin(memberKey))) {
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
  const workspaceMember = await workspaceDependencies.workspaceAccess.getMember(directoryId, member.id)

  try {
    const profile = await authenticationDependencies.cognito.getUserProfile(member.id)

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
    (await workspaceDependencies.workspaceAccess.listActiveMembers(directoryId)).map((member) => member.memberKey),
  )
  const users: CognitoUserProfile[] = []
  let paginationToken = input.paginationToken

  do {
    const response = await authenticationDependencies.cognito.listUsers({
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

/**
 * Requires an assignee to be an active Workspace member with a Cognito profile.
 *
 * @param directoryId - Owning Workspace directory identifier.
 * @param userId - Candidate assignee identifier.
 * @param dependencies - Ports used to read membership and identity state.
 * @returns The current Cognito profile.
 */
async function requireActiveWorkspaceAssignee(
  directoryId: string,
  userId: string,
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
) {
  const member = await dependencies.workspaceAccess.getActiveMember(directoryId, userId)

  if (!member) {
    throw new WorkspaceAccessError(
      409,
      'WorkspaceAssigneeInactive',
      'Only active Workspace members can be assigned.',
    )
  }

  return dependencies.cognito.getUserProfile(userId)
}

/** Returns the configured canonical Work Item table used by transaction fences. */
function getTeamIssuesTableName(): string {
  return getEnv('MUKUROJI_TEAM_ISSUES_TABLE') ??
    getEnv('TEAM_ISSUES_TABLE_NAME') ??
    'mukuroji-team-issues-local'
}

/** Builds commit-time Team, Project, and assignee fences for Triage acceptance.
 *
 * @param workspaceId - Owning Workspace directory identifier.
 * @param teamId - Team that must remain active through Work Item creation.
 * @param projectId - Optional Project that must remain active through commit.
 * @param assigneeUserId - Member that must remain active through commit.
 * @returns Directory and Workspace condition checks for the acceptance transaction.
 */
async function createTriageAcceptanceReferenceConditionChecks(
  workspaceId: string,
  teamId: string,
  projectId: string | undefined,
  assigneeUserId: string,
): Promise<NonNullable<TransactWriteCommandInput['TransactItems']>> {
  const createReferenceChecks = workspaceDependencies.projectDirectory.createActiveReferenceConditionChecks
  const createMemberCheck = workspaceDependencies.workspaceAccess.createActiveMemberConditionCheck
  if (!createReferenceChecks || !createMemberCheck) {
    throw new TriageError(
      503,
      'TriageAcceptanceReferenceUnavailable',
      'Acceptance reference fencing is unavailable.',
    )
  }
  let referenceChecks
  try {
    referenceChecks = await createReferenceChecks(workspaceId, teamId, projectId)
  } catch (error) {
    if (error instanceof ProjectDataError) {
      throw new TriageError(
        409,
        error.code === 'ProjectNotFound'
          ? 'TriageAcceptanceProjectUnavailable'
          : 'TriageAcceptanceTeamUnavailable',
        'The selected acceptance destination is no longer active.',
        { cause: error },
      )
    }
    throw error
  }
  const memberCheck = await createMemberCheck(workspaceId, assigneeUserId)
  if (!memberCheck) {
    throw new TriageError(
      409,
      'TriageAcceptanceOwnerUnavailable',
      'The selected acceptance owner is no longer active.',
    )
  }
  return [...referenceChecks, memberCheck]
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
    ? await workItemDependencies.fileProofing.getApprovalSummaries(scopes)
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
  if (!isWorkspaceSearchProjectionEnabled()) return
  try {
    await workItemDependencies.workspaceSearch.upsertDocument(createDocument())
  } catch (error) {
    console.error(`Workspace search projection failed after ${operation}.`, error)
  }
}

/**
 * Projects a Work Item and its current relation graph into Workspace Search.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param issue - Canonical Work Item snapshot.
 * @param operation - Safe operation label used for error logging.
 * @param relationIds - Optional preloaded relation identifiers.
 * @param dependencies - Ports and feature state used by the projection.
 * @returns A promise that resolves after best-effort projection.
 */
async function projectWorkItemSearchDocumentBestEffort(
  workspaceId: string,
  issue: TeamIssueResponseItem,
  operation: string,
  relationIds?: readonly string[],
  dependencies: AutomationActionExecutorDependencies =
    ambientAutomationActionExecutorDependencies,
) {
  if (!dependencies.workspaceSearchProjectionEnabled) return
  try {
    const currentRelationIds = relationIds ?? createWorkItemRelationIds(
      (await dependencies.workItemConfigurations.listRelations(
        workspaceId,
        issue.teamId,
        issue.id,
      )).relations,
      issue.id,
    )
    await dependencies.workspaceSearch.upsertDocument(
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
  if (!isWorkspaceSearchProjectionEnabled()) return
  try {
    const [detail, relationPage] = await Promise.all([
      workItemDependencies.teamIssues.getTeamIssueDetail(workspaceId, teamId, issueId, {
        consistentIssueRead: true,
        eventLimit: 0,
      }),
      workItemDependencies.workItemConfigurations.listRelations(workspaceId, teamId, issueId),
    ])
    await workItemDependencies.workspaceSearch.upsertDocument(createWorkItemSearchDocument(
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
  if (!isWorkspaceSearchProjectionEnabled()) return
  try {
    await workItemDependencies.workspaceSearch.deleteDocument(workspaceId, entityType, entityId)
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
  const summary = await workItemDependencies.fileProofing.getApprovalSummary({
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
  const storedIssues = await workItemDependencies.teamIssues.getTeamIssues(directoryId, context.team.id)

  return {
    teamId: context.team.id,
    issues: filterAccessibleTeamIssues(storedIssues.issues, principal, context),
  } satisfies TeamIssuesResponse
}

async function readCanonicalTeamIssuesForAggregate(
  directoryId: string,
  context: TeamPermissionContext,
  principal: ProjectPrincipal,
  includeArchived = false,
) {
  const clientReadLimit = createWorkItemListProbeLimit(WORK_ITEMS_PARTITION_SCAN_LIMIT)
  const storedIssues = await workItemDependencies.teamIssues.getTeamIssues(
    directoryId,
    context.team.id,
    { limit: clientReadLimit, consistentRead: true, includeArchived },
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
  includeArchived = false,
): Promise<WorkItemsResponse> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const projectAccesses = principal.isSystemAdmin
    ? undefined
    : await getEffectiveProjectAccessList(principal)
  const authorizedTeamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
  const contexts: TeamPermissionContext[] = directory.teams.flatMap((team) => {
    if (principal.isSystemAdmin) {
      return [{ team, directory } satisfies TeamPermissionContext]
    }

    const teamProjectIds = new Set(team.projects.map((project) => project.id))
    const teamProjectAccesses = (projectAccesses ?? []).filter((access) =>
      teamProjectIds.has(access.projectId)
    )
    if (
      !authorizedTeamIds.has(team.id) &&
      !teamProjectAccesses.some((access) => projectAccessAllows(access, 'viewer'))
    ) {
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
      includeArchived,
    )
    for (const workItem of response.issues) {
      addAggregateWorkItem(workItemsById, workItem)
    }
  }

  return { workItems: [...workItemsById.values()] }
}

/** Export を一つの Team/GSI Query に制限し、次 page の store continuation を返します。 */
async function readAccessibleWorkItemExportPage(
  principal: ProjectPrincipal,
  continuation: string | undefined,
  limit: number,
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const projectAccesses = principal.isSystemAdmin
    ? undefined
    : await getEffectiveProjectAccessList(principal)
  const contexts: TeamPermissionContext[] = directory.teams.flatMap((team) => {
    if (principal.isSystemAdmin) {
      return [{ team, directory } satisfies TeamPermissionContext]
    }
    const teamProjectIds = new Set(team.projects.map((project) => project.id))
    const teamProjectAccesses = (projectAccesses ?? []).filter((access) =>
      teamProjectIds.has(access.projectId) && projectAccessAllows(access, 'viewer')
    )
    return teamProjectAccesses.length > 0
      ? [{ team, directory, projectAccesses: teamProjectAccesses } satisfies TeamPermissionContext]
      : []
  })
  if (contexts.length === 0) return { items: [], hasMore: false }

  const teamSetDigest = createHash('sha256')
    .update(contexts.map((context) => context.team.id).join('\0'))
    .digest('base64url')
  const decoded = decodeWorkItemExportContinuation(
    continuation,
    teamSetDigest,
  )
  const teamIndex = decoded
    ? contexts.findIndex((context) => context.team.id === decoded.teamId)
    : 0
  if (teamIndex < 0) {
    throw new PublicApiServiceError(
      400,
      'invalid_request',
      'Export cursor no longer matches the accessible Team set.',
    )
  }
  const context = contexts[teamIndex]!
  const accessibleProjectIds = principal.isSystemAdmin
    ? undefined
    : (context.projectAccesses ?? []).map((access) => access.projectId)
  const page = await workItemDependencies.teamIssues.getPublicWorkItemPage(
    principal.directoryId,
    context.team.id,
    {
      limit,
      ...(decoded?.workItemCursor ? { cursor: decoded.workItemCursor } : {}),
      ...(accessibleProjectIds ? { accessibleProjectIds } : {}),
    },
  )
  const nextTeam = page.nextCursor ? context : contexts[teamIndex + 1]
  const nextContinuation = nextTeam
    ? encodeWorkItemExportContinuation({
        version: 1,
        teamId: nextTeam.team.id,
        teamSetDigest,
        ...(page.nextCursor ? { workItemCursor: page.nextCursor } : {}),
      })
    : undefined
  return {
    items: page.issues,
    hasMore: nextContinuation !== undefined,
    ...(nextContinuation ? { nextContinuation } : {}),
  }
}

function encodeWorkItemExportContinuation(value: WorkItemExportContinuation) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeWorkItemExportContinuation(
  value: string | undefined,
  teamSetDigest: string,
) {
  if (!value) return undefined
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<WorkItemExportContinuation>
    if (
      decoded.version !== 1 ||
      decoded.teamSetDigest !== teamSetDigest ||
      typeof decoded.teamId !== 'string' ||
      !decoded.teamId ||
      (decoded.workItemCursor !== undefined &&
        (typeof decoded.workItemCursor !== 'string' || !decoded.workItemCursor))
    ) {
      throw new TypeError('Invalid export continuation.')
    }
    return decoded as WorkItemExportContinuation
  } catch {
    throw new PublicApiServiceError(
      400,
      'invalid_request',
      'Export cursor is invalid.',
    )
  }
}

/**
 * Analytics filter の Team/Project scope を read 前に適用し、current ACL の canonical
 * Work Item を通常一覧とは独立した安全上限まで返します。
 */
async function readAccessibleAnalyticsWorkItems(
  principal: ProjectPrincipal,
  filter: AnalyticsQueryInput['filter'],
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
    true,
  )
  const filteredTeamIds = filter.teamIds === undefined
    ? undefined
    : new Set(filter.teamIds)
  const filteredProjectIds = filter.projectIds === undefined
    ? undefined
    : new Set(filter.projectIds)
  const projectAccesses = principal.isSystemAdmin
    ? undefined
    : await getEffectiveProjectAccessList(principal)
  const authorizedTeamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
  const activeProjectIds = new Set(directory.teams.flatMap((team) =>
    team.projects.map((project) => project.id)
  ))
  const readableProjectIds = principal.isSystemAdmin
    ? activeProjectIds
    : new Set(
        (projectAccesses ?? [])
          .filter((access) =>
            activeProjectIds.has(access.projectId) &&
            projectAccessAllows(access, 'viewer')
          )
          .map((access) => access.projectId),
      )
  const workItemsById = new Map<string, TeamIssueResponseItem>()
  const addWorkItem = (workItem: TeamIssueResponseItem) => {
    workItemsById.set(`${workItem.teamId}\0${workItem.id}`, workItem)
    if (workItemsById.size > ANALYTICS_WORK_ITEM_LIMIT) {
      throw new AnalyticsError(
        413,
        'AnalyticsWorkItemLimitExceeded',
        `Analytics query has more than ${ANALYTICS_WORK_ITEM_LIMIT} accessible Work Items. Narrow the report scope.`,
      )
    }
  }
  const readOptions: WorkItemListReadOptions = {
    limit: ANALYTICS_WORK_ITEM_PARTITION_SCAN_LIMIT + 1,
    consistentRead: true,
    includeArchived: true,
  }

  const selectedTeams = directory.teams.filter((team) => {
    if (filteredTeamIds !== undefined && !filteredTeamIds.has(team.id)) return false
    if (
      filteredProjectIds === undefined &&
      (principal.isSystemAdmin || authorizedTeamIds.has(team.id))
    ) {
      return true
    }
    return team.projects.some((project) => {
      return readableProjectIds.has(project.id) &&
        (filteredProjectIds === undefined || filteredProjectIds.has(project.id))
    })
  })
  assertAnalyticsPartitionCount(selectedTeams.length)
  for (const team of selectedTeams) {
    const response = await workItemDependencies.teamIssues.getTeamIssues(
      principal.directoryId,
      team.id,
      readOptions,
    )
    assertAnalyticsPartitionSize(response.issues, `Team "${team.id}"`)
    for (const workItem of response.issues) {
      if (
        workItem.teamId === team.id &&
        (
          workItem.assignedProjectId === undefined ||
          readableProjectIds.has(workItem.assignedProjectId)
        )
      ) {
        addWorkItem(workItem)
      }
    }
  }
  return {
    workItems: [...workItemsById.values()],
    authorizedProjectIds: readableProjectIds,
  }
}

/** Analytics data read が評価する partition 数を fail-closed 上限内に制限します。 */
function assertAnalyticsPartitionCount(count: number) {
  if (count > ANALYTICS_WORK_ITEM_PARTITION_COUNT_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsWorkItemLimitExceeded',
      `Analytics query spans more than ${ANALYTICS_WORK_ITEM_PARTITION_COUNT_LIMIT} data partitions. Narrow the report scope.`,
    )
  }
}

/** Analytics data read が一つの partition から部分結果を返さないよう probe 結果を検証します。 */
function assertAnalyticsPartitionSize(
  workItems: readonly TeamIssueResponseItem[],
  scope: string,
) {
  if (workItems.length > ANALYTICS_WORK_ITEM_PARTITION_SCAN_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsWorkItemLimitExceeded',
      `${scope} has more than ${ANALYTICS_WORK_ITEM_PARTITION_SCAN_LIMIT} Work Items. Narrow the report scope.`,
    )
  }
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
      schedule: workItem.schedule,
    } satisfies PlanningWorkItemSummary)),
  }
}

/**
 * Recomputes one schedule preview from stable Planning data and strongly read endpoint schedules.
 *
 * The unfiltered Planning authorization graph is used only to fail closed when any root-reachable
 * successor or incoming bound predecessor is outside the principal's visible Work Item state.
 * No hidden endpoint identity is returned in that failure.
 *
 * @param principal - Authenticated Workspace principal.
 * @param rootWorkItem - Strongly read direct Work Item.
 * @param operation - Validated direct schedule operation.
 * @param relationGraphRevision - Separately observed semantic relation graph revision.
 * @param semanticBlockerCount - Visible semantic blocker count used only for warnings.
 * @param endpointRole - Minimum role required on every evaluated endpoint.
 * @param expectedPlanningRevision - Optional preview revision required by confirmation.
 * @returns Server-authoritative preview plus every revision participating in recomputation.
 */
async function recomputeWorkItemScheduleDependencyPreview(
  principal: WorkspacePrincipal,
  rootWorkItem: TeamIssueResponseItem,
  operation: WorkItemScheduleOperation,
  relationGraphRevision: number,
  semanticBlockerCount: number,
  endpointRole: Extract<ProjectRole, 'viewer' | 'member'>,
  expectedPlanningRevision?: number,
) {
  const scopedPrincipal = await createWorkItemScheduleScopedPrincipal(principal, endpointRole)
  const planning = await readStableWorkItemSchedulePlanningSnapshot(scopedPrincipal)
  if (
    expectedPlanningRevision !== undefined &&
    planning.authorizationState.revision !== expectedPlanningRevision
  ) {
    throw new ProjectDataError(
      409,
      'PlanningRevisionConflict',
      'Planning changed. Reload and try again.',
    )
  }
  const rootEndpoint = {
    teamId: rootWorkItem.teamId,
    workItemId: rootWorkItem.id,
  } satisfies WorkItemDependencyEndpoint
  const dependencies = planning.authorizationState.workItemDependencies
  if (dependencies === undefined) {
    throw new WorkItemScheduleError(
      503,
      'WorkItemScheduleDependencyStateUnavailable',
      'Work Item dependency state is unavailable for schedule evaluation.',
    )
  }
  const evaluationEndpoints = collectWorkItemScheduleEvaluationEndpoints(
    rootEndpoint,
    dependencies,
  )
  const accessibleKeys = new Set(planning.workItemState.workItems.map((workItem) =>
    createWorkItemDependencyKey({ teamId: workItem.teamId, workItemId: workItem.id })
  ))
  accessibleKeys.add(createWorkItemDependencyKey(rootEndpoint))
  if (evaluationEndpoints.some((endpoint) =>
    !accessibleKeys.has(createWorkItemDependencyKey(endpoint))
  )) {
    throw new ProjectDataError(
      403,
      'WorkItemScheduleDependencyAccessDenied',
      'Schedule dependency impact cannot be evaluated within the current access scope.',
    )
  }
  if (evaluationEndpoints.length > WORK_ITEM_SCHEDULE_CASCADE_LIMIT) {
    throw new WorkItemScheduleError(
      413,
      'WorkItemScheduleCascadeLimitExceeded',
      `A schedule cascade cannot evaluate more than ${WORK_ITEM_SCHEDULE_CASCADE_LIMIT} Work Items.`,
    )
  }
  const rootKey = createWorkItemDependencyKey(rootEndpoint)
  const states = await Promise.all(evaluationEndpoints.map(async (endpoint) => {
    const key = createWorkItemDependencyKey(endpoint)
    const issue = key === rootKey
      ? rootWorkItem
      : (await requirePlanningWorkItemEndpointPermission(
          scopedPrincipal,
          endpoint,
          endpointRole,
        )).detail.issue
    if (issue.archivedAt) {
      throw new ProjectDataError(
        409,
        'PlanningWorkItemArchived',
        'Archived Work Items cannot participate in schedule dependency changes.',
      )
    }
    const milestoneIds = [...new Set(planning.snapshot.workItemLinks.flatMap((link) =>
      link.teamId === endpoint.teamId &&
        link.workItemId === endpoint.workItemId &&
        link.milestoneId
        ? [link.milestoneId]
        : []
    ))].sort()
    return {
      endpoint,
      revision: issue.revision,
      schedule: issue.schedule,
      ...(issue.assignedProjectId ? { projectId: issue.assignedProjectId } : {}),
      milestoneIds,
    } satisfies WorkItemDependencyScheduleState
  }))
  const root = states.find((state) => createWorkItemDependencyKey(state.endpoint) === rootKey)
  if (!root) {
    throw new ProjectDataError(
      403,
      'WorkItemScheduleDependencyAccessDenied',
      'Schedule dependency impact cannot be evaluated within the current access scope.',
    )
  }
  return {
    preview: previewWorkItemDependencyScheduleChange({
      root,
      operation,
      workItems: states,
      dependencies,
      planningRevision: planning.authorizationState.revision,
      relationGraphRevision,
      semanticBlockerCount,
    }),
    states,
  }
}

/**
 * Reads matching filtered and unfiltered Planning views at one global revision.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns Stable visible Work Item state, filtered snapshot, and unfiltered authorization state.
 */
async function readStableWorkItemSchedulePlanningSnapshot(
  principal: WorkspacePrincipal,
) {
  for (
    let attempt = 0;
    attempt < WORK_ITEM_SCHEDULE_SNAPSHOT_RETRY_LIMIT;
    attempt += 1
  ) {
    const authorizationState = await workItemDependencies.planning.getAuthorizationState(
      principal.directoryId,
    )
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = filterPlanningSnapshotForPrincipal(
      principal,
      await workItemDependencies.planning.get(principal.directoryId, workItemState),
    )
    const finalRevision = await workItemDependencies.planning.getAuthorizationRevision(
      principal.directoryId,
    )
    if (
      authorizationState.revision === snapshot.revision &&
      snapshot.revision === finalRevision
    ) {
      return { authorizationState, workItemState, snapshot }
    }
  }
  throw new ProjectDataError(
    409,
    'PlanningRevisionConflict',
    'Planning changed. Reload and try again.',
  )
}

/**
 * Reads a non-negative graph revision from an untrusted confirmation request.
 *
 * @param value - Candidate revision.
 * @param label - Human-readable graph kind.
 * @returns Validated non-negative safe integer.
 */
function readWorkItemScheduleGraphRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleConfirmation',
      `${label} is required.`,
    )
  }
  return value
}

/**
 * Reads and canonicalizes the complete Work Item revision snapshot returned by preview.
 *
 * @param value - Candidate revision snapshot from a confirmation request.
 * @returns Qualified revisions in deterministic endpoint order.
 */
function readWorkItemScheduleEvaluationRevisions(
  value: unknown,
): WorkItemScheduleEvaluationRevision[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > WORK_ITEM_SCHEDULE_CASCADE_LIMIT
  ) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleConfirmation',
      'Expected evaluated Work Item revisions are required.',
    )
  }
  const revisions = value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.teamId !== 'string' ||
      !entry.teamId.trim() ||
      typeof entry.workItemId !== 'string' ||
      !entry.workItemId.trim() ||
      typeof entry.expectedRevision !== 'number' ||
      !Number.isSafeInteger(entry.expectedRevision) ||
      entry.expectedRevision < 1
    ) {
      throw new WorkItemScheduleError(
        400,
        'InvalidWorkItemScheduleConfirmation',
        'Every evaluated Work Item revision must contain a Team ID, Work Item ID, and positive revision.',
      )
    }
    return {
      teamId: entry.teamId.trim(),
      workItemId: entry.workItemId.trim(),
      expectedRevision: entry.expectedRevision,
    } satisfies WorkItemScheduleEvaluationRevision
  }).sort(compareWorkItemScheduleEvaluationRevisions)
  const keys = revisions.map((revision) => createWorkItemDependencyKey(revision))
  if (new Set(keys).size !== keys.length) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleConfirmation',
      'Expected evaluated Work Item revisions must identify distinct Work Items.',
    )
  }
  return revisions
}

/**
 * Reads and canonicalizes the exact impact list returned by a schedule preview.
 *
 * @param value - Candidate impacts copied into a confirmation request.
 * @returns Canonical impacts in the preview's deterministic order.
 */
function readWorkItemScheduleImpacts(value: unknown): WorkItemScheduleImpact[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > WORK_ITEM_SCHEDULE_CASCADE_LIMIT
  ) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleConfirmation',
      'Expected schedule preview impacts are required.',
    )
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.teamId !== 'string' ||
      !entry.teamId.trim() ||
      typeof entry.workItemId !== 'string' ||
      !entry.workItemId.trim() ||
      (entry.kind !== 'direct' && entry.kind !== 'dependency') ||
      typeof entry.expectedRevision !== 'number' ||
      !Number.isSafeInteger(entry.expectedRevision) ||
      entry.expectedRevision < 1 ||
      typeof entry.dateDeltaDays !== 'number' ||
      !Number.isSafeInteger(entry.dateDeltaDays) ||
      (entry.dependencyId !== undefined &&
        (typeof entry.dependencyId !== 'string' || !entry.dependencyId.trim()))
    ) {
      throw new WorkItemScheduleError(
        400,
        'InvalidWorkItemScheduleConfirmation',
        'Every expected schedule impact must match the preview impact contract.',
      )
    }
    try {
      return {
        teamId: entry.teamId.trim(),
        workItemId: entry.workItemId.trim(),
        kind: entry.kind,
        expectedRevision: entry.expectedRevision,
        before: normalizeWorkItemSchedule(entry.before),
        after: normalizeWorkItemSchedule(entry.after),
        dateDeltaDays: entry.dateDeltaDays,
        ...(entry.dependencyId === undefined
          ? {}
          : { dependencyId: entry.dependencyId.trim() }),
      } satisfies WorkItemScheduleImpact
    } catch (error) {
      if (error instanceof WorkItemScheduleError) {
        throw new WorkItemScheduleError(
          400,
          'InvalidWorkItemScheduleConfirmation',
          'Expected schedule preview impacts contain an invalid schedule.',
        )
      }
      throw error
    }
  })
}

/**
 * Derives a Developer Platform-safe partition from an internal Workspace directory key.
 *
 * @param directoryId - Internal Workspace directory partition key.
 * @returns Stable opaque Developer Platform Workspace identifier.
 */
function createWorkItemScheduleIdempotencyWorkspaceId(directoryId: string): string {
  return `directory:${createHash('sha256').update(directoryId).digest('hex').slice(0, 48)}`
}

/**
 * Derives a user-scoped credential namespace without persisting the Cognito identity.
 *
 * @param directoryId - Internal Workspace directory partition key.
 * @param actorId - Immutable Cognito subject or username.
 * @returns Stable opaque user credential identifier.
 */
function createWorkItemScheduleIdempotencyUserId(
  directoryId: string,
  actorId: string,
): string {
  const digest = createHash('sha256')
    .update(`${directoryId}\0${actorId}`)
    .digest('hex')
    .slice(0, 48)
  return `user:${digest}`
}

/**
 * Validates the required user-provided key for one schedule confirmation.
 *
 * @param value - Raw `Idempotency-Key` header value.
 * @returns A trimmed key safe for the Developer Platform idempotency port.
 */
function readRequiredWorkItemScheduleIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? ''
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleIdempotencyKey',
      'Idempotency-Key must contain 1 to 256 characters without control characters.',
    )
  }
  return key
}

/**
 * Binds a schedule confirmation key to its exact HTTP method, path, and JSON body.
 *
 * @param method - Incoming HTTP method.
 * @param path - Canonical request path.
 * @param body - Parsed confirmation body.
 * @returns Stable SHA-256 request fingerprint.
 */
function createWorkItemScheduleConfirmationFingerprint(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${stableDigestStringify(body)}`)
    .digest('hex')
}

/**
 * Reserves a schedule confirmation and maps persistence failures to its stable API contract.
 *
 * @param request - User-scoped idempotency reservation identity.
 * @returns Reservation, in-progress, or completed replay decision.
 */
async function reserveWorkItemScheduleConfirmation(request: ReserveIdempotencyRequest) {
  try {
    return await developerPlatformDependencies.idempotency.reserveIdempotency(request)
  } catch (error) {
    if (error instanceof DeveloperPlatformError && error.code === 'IdempotencyKeyConflict') {
      throw new WorkItemScheduleError(
        409,
        'WorkItemScheduleIdempotencyConflict',
        'Idempotency-Key was already used for a different schedule confirmation.',
      )
    }
    throw new WorkItemScheduleError(
      503,
      'WorkItemScheduleIdempotencyUnavailable',
      'Schedule confirmation idempotency is unavailable.',
    )
  }
}

/**
 * Adapts the Work Item schedule confirmation use case to authenticated API dependencies.
 *
 * @param c - Current Hono request context used only for replay metadata and audit context.
 * @param principal - Authenticated Workspace principal.
 * @param context - Authorized Team and Project access snapshot for the root Work Item.
 * @param body - Parsed request body recorded in the immutable audit context.
 * @param command - Fully validated application command.
 * @returns Compact schedules committed or replayed by the confirmation use case.
 */
async function executeConfirmedWorkItemScheduleChange(
  c: Context,
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  body: Readonly<Record<string, unknown>>,
  command: ConfirmWorkItemScheduleChangeCommand,
) {
  return confirmWorkItemScheduleChange(command, {
    reserve: reserveWorkItemScheduleConfirmation,
    release: (request) =>
      developerPlatformDependencies.idempotency.releaseIdempotency(request),
    async replay(value, replayCommand) {
      const replay = readStoredWorkItemScheduleConfirmationResponse(
        value,
        replayCommand.teamId,
        replayCommand.workItemId,
      )
      await requireWorkItemScheduleConfirmationReplayAuthorization(
        principal,
        replay.authorizationEndpoints,
      )
      c.header('Idempotency-Replayed', 'true')
      return replay.response
    },
    async recompute(recomputeCommand) {
      const [detail, relationPage] = await Promise.all([
        workItemDependencies.teamIssues.getTeamIssueDetail(
          principal.directoryId,
          recomputeCommand.teamId,
          recomputeCommand.workItemId,
          { consistentIssueRead: true, eventLimit: 0 },
        ),
        workItemDependencies.workItemConfigurations.listRelations(
          principal.directoryId,
          recomputeCommand.teamId,
          recomputeCommand.workItemId,
        ),
      ])
      requireAssignedProjectPermission(
        principal,
        context,
        detail.issue.assignedProjectId,
        'member',
      )
      if (relationPage.graphRevision !== recomputeCommand.expectedRelationGraphRevision) {
        throw new ProjectDataError(
          409,
          'WorkItemRelationGraphConflict',
          'Work Item relations changed. Reload and try again.',
        )
      }
      const visibleRelations = await filterVisibleWorkItemRelations(
        principal,
        context,
        recomputeCommand.teamId,
        relationPage.relations,
      )
      const recomputed = await recomputeWorkItemScheduleDependencyPreview(
        principal,
        detail.issue,
        recomputeCommand.operation,
        relationPage.graphRevision,
        visibleRelations.filter((relation) =>
          relation.sourceWorkItemId === recomputeCommand.workItemId &&
          (relation.type === 'blocks' || relation.type === 'blockedBy')
        ).length,
        'member',
        recomputeCommand.expectedPlanningRevision,
      )
      return recomputed.preview
    },
    async persist(input) {
      const updateSchedules = workItemDependencies.teamIssues.updateTeamIssueSchedules
      if (!updateSchedules) {
        throw new ProjectDataError(
          503,
          'WorkItemScheduleCascadeUnavailable',
          'Atomic schedule cascade persistence is not configured.',
        )
      }
      const idempotencyTransaction =
        createWorkItemScheduleConfirmationIdempotencyTransaction(
          input.reservation.workspaceId,
          input.reservation,
          input.authorizationEndpoints,
        )
      if (!idempotencyTransaction) {
        throw new WorkItemScheduleError(
          503,
          'WorkItemScheduleIdempotencyUnavailable',
          'Durable schedule confirmation receipts are not configured.',
        )
      }
      const result = await updateSchedules.call(
        workItemDependencies.teamIssues,
        principal.directoryId,
        input.updates,
        input.guardedRevisions,
        principal.userKey,
        createApiMutationContext(c, principal, {
          teamId: command.teamId,
          issueId: command.workItemId,
          ...body,
        }),
        [createWorkItemRelationGraphRevisionConditionCheck(
          getWorkItemConfigurationTableName(),
          principal.directoryId,
          command.teamId,
          input.expectedRelationGraphRevision,
        )],
        createWorkItemAuthorizationSnapshot(
          principal,
          input.expectedPlanningRevision,
        ),
        idempotencyTransaction,
      )
      await Promise.all(result.issues.map((issue) =>
        projectWorkItemMutationSearchDocumentBestEffort(
          principal.directoryId,
          issue,
          'Work Item schedule dependency cascade',
        )
      ))
      return { workItems: result.confirmedSchedules }
    },
  })
}

/** Mutation represented by one durable Planning Work Item dependency receipt. */
type PlanningWorkItemDependencyReceiptOperation = 'create' | 'update' | 'delete'

/** Stable schema discriminator for compact Planning Work Item dependency receipts. */
const PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_SCHEMA =
  'planning-work-item-dependency-mutation'

/** Current compact Planning Work Item dependency receipt version. */
const PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_VERSION = 1

/**
 * Validates the required request key for one Planning Work Item dependency mutation.
 *
 * @param value - Raw `Idempotency-Key` header value.
 * @returns Trimmed key safe for the durable reservation port.
 */
function readRequiredPlanningWorkItemDependencyIdempotencyKey(
  value: string | undefined,
): string {
  const key = value?.trim() ?? ''
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new PlanningError(
      400,
      'InvalidPlanningWorkItemDependencyIdempotencyKey',
      'Idempotency-Key must contain 1 to 256 characters without control characters.',
    )
  }
  return key
}

/**
 * Creates the user-scoped reservation identity for one dependency mutation.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param idempotencyKey - Validated caller-provided request key.
 * @param method - Canonical HTTP method.
 * @param path - Canonical API path, including the dependency ID when present.
 * @param body - Parsed JSON body bound to the reservation.
 * @returns Reservation request bound to the user, method, path, and stable body digest.
 */
function createPlanningWorkItemDependencyReservationRequest(
  principal: WorkspacePrincipal,
  idempotencyKey: string,
  method: string,
  path: string,
  body: unknown,
): ReserveIdempotencyRequest {
  return {
    workspaceId: createWorkItemScheduleIdempotencyWorkspaceId(principal.directoryId),
    credentialId: createWorkItemScheduleIdempotencyUserId(
      principal.directoryId,
      principal.actorId,
    ),
    idempotencyKey,
    requestFingerprint: createPlanningWorkItemDependencyFingerprint(method, path, body),
  }
}

/**
 * Binds one dependency mutation to its exact method, canonical path, and stable JSON body.
 *
 * @param method - Incoming HTTP method.
 * @param path - Canonical API path.
 * @param body - Parsed request body.
 * @returns Stable SHA-256 request fingerprint.
 */
function createPlanningWorkItemDependencyFingerprint(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${stableDigestStringify(body)}`)
    .digest('hex')
}

/**
 * Reserves one dependency mutation and maps persistence failures to stable Planning errors.
 *
 * @param request - User-scoped reservation identity.
 * @returns Reservation, in-progress, or completed replay decision.
 */
async function reservePlanningWorkItemDependencyMutation(request: ReserveIdempotencyRequest) {
  try {
    return await developerPlatformDependencies.idempotency.reserveIdempotency(request)
  } catch (error) {
    if (error instanceof DeveloperPlatformError && error.code === 'IdempotencyKeyConflict') {
      throw new PlanningError(
        409,
        'PlanningWorkItemDependencyIdempotencyConflict',
        'Idempotency-Key was already used for a different Work Item dependency mutation.',
      )
    }
    throw planningWorkItemDependencyIdempotencyUnavailable()
  }
}

/** Creates the stable failure used when dependency idempotency persistence is unavailable. */
function planningWorkItemDependencyIdempotencyUnavailable(): PlanningError {
  return new PlanningError(
    503,
    'PlanningWorkItemDependencyIdempotencyUnavailable',
    'Work Item dependency idempotency is unavailable.',
  )
}

/**
 * Releases an incomplete dependency reservation without masking the route's original failure.
 *
 * @param request - Caller-owned incomplete reservation.
 */
async function releasePlanningWorkItemDependencyReservation(
  request: ReleaseIdempotencyRequest,
): Promise<void> {
  await developerPlatformDependencies.idempotency
    .releaseIdempotency(request)
    .catch(() => undefined)
}

/** Creates the stable failure used when a durable dependency replay receipt is malformed. */
function invalidStoredPlanningWorkItemDependencyMutationReceipt(): PlanningError {
  return new PlanningError(
    503,
    'InvalidStoredPlanningWorkItemDependencyMutationReceipt',
    'The stored Work Item dependency mutation receipt is invalid.',
  )
}

/**
 * Reads one identifier from an encrypted dependency receipt.
 *
 * @param value - Candidate identifier.
 * @returns Validated non-empty identifier.
 */
function readStoredPlanningWorkItemDependencyIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 256
  ) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return value
}

/**
 * Reads one exact qualified endpoint from an encrypted dependency receipt.
 *
 * @param value - Candidate endpoint.
 * @returns Validated detached endpoint.
 */
function readStoredPlanningWorkItemDependencyEndpoint(
  value: unknown,
): WorkItemDependencyEndpoint {
  if (!isRecord(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const endpoint = {
    teamId: readStoredPlanningWorkItemDependencyIdentifier(value.teamId),
    workItemId: readStoredPlanningWorkItemDependencyIdentifier(value.workItemId),
  }
  if (stableDigestStringify(endpoint) !== stableDigestStringify(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return endpoint
}

/**
 * Tests whether a receipt value is one canonical supported schedule date.
 *
 * @param value - Candidate date.
 * @returns Whether the value is a real `YYYY-MM-DD` date within supported years.
 */
function isStoredPlanningWorkItemDependencyDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number(value.slice(0, 4)) < WORK_ITEM_SCHEDULE_MIN_YEAR
  ) {
    return false
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Reads one exact dependency constraint from an encrypted receipt.
 *
 * @param value - Candidate constraint.
 * @returns Validated detached constraint.
 */
function readStoredPlanningWorkItemDependencyConstraint(
  value: unknown,
): ScheduleDependencyConstraint {
  if (
    !isRecord(value) ||
    (value.anchor !== 'start' && value.anchor !== 'finish') ||
    (value.kind !== 'on' && value.kind !== 'not-before' && value.kind !== 'not-after') ||
    !isStoredPlanningWorkItemDependencyDate(value.date)
  ) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const constraint: ScheduleDependencyConstraint = {
    anchor: value.anchor,
    kind: value.kind,
    date: value.date,
  }
  if (stableDigestStringify(constraint) !== stableDigestStringify(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return constraint
}

/**
 * Reads one canonical ISO timestamp from an encrypted dependency receipt.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readStoredPlanningWorkItemDependencyTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return value
}

/**
 * Reads one exact canonical dependency from an encrypted replay receipt.
 *
 * @param value - Candidate dependency.
 * @returns Validated detached dependency.
 */
function readStoredPlanningWorkItemDependency(
  value: unknown,
): WorkItemScheduleDependency {
  if (!isRecord(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const type = value.type
  if (
    type !== 'finish-to-start' &&
    type !== 'start-to-start' &&
    type !== 'finish-to-finish' &&
    type !== 'start-to-finish'
  ) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  if (
    typeof value.lagDays !== 'number' ||
    !Number.isSafeInteger(value.lagDays) ||
    Math.abs(value.lagDays) > WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS
  ) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const createdAt = readStoredPlanningWorkItemDependencyTimestamp(value.createdAt)
  const updatedAt = readStoredPlanningWorkItemDependencyTimestamp(value.updatedAt)
  if (updatedAt < createdAt) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const dependency: WorkItemScheduleDependency = {
    id: readStoredPlanningWorkItemDependencyIdentifier(value.id),
    predecessor: readStoredPlanningWorkItemDependencyEndpoint(value.predecessor),
    successor: readStoredPlanningWorkItemDependencyEndpoint(value.successor),
    type,
    lagDays: value.lagDays,
    ...(value.constraint === undefined
      ? {}
      : { constraint: readStoredPlanningWorkItemDependencyConstraint(value.constraint) }),
    createdAt,
    updatedAt,
  }
  if (stableDigestStringify(dependency) !== stableDigestStringify(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return dependency
}

/**
 * Resolves the original successful status for one dependency mutation operation.
 *
 * @param operation - Receipt operation.
 * @returns `201` for create and `200` for update or delete.
 */
function resolvePlanningWorkItemDependencyReceiptStatus(
  operation: PlanningWorkItemDependencyReceiptOperation,
): 200 | 201 {
  return operation === 'create' ? 201 : 200
}

/**
 * Strictly validates one compact dependency mutation replay receipt.
 *
 * @param value - Candidate Developer Platform replay response.
 * @param workspaceId - Opaque Workspace reservation identity expected by the route.
 * @param operation - Expected mutation operation.
 * @param dependencyId - Dependency identity bound to the canonical path or create body.
 * @returns Validated dependency, committed revision, and original response status.
 */
function readStoredPlanningWorkItemDependencyMutationReceipt(
  value: unknown,
  workspaceId: string,
  operation: PlanningWorkItemDependencyReceiptOperation,
  dependencyId: string,
) {
  if (!isRecord(value) || !isRecord(value.body)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const status = resolvePlanningWorkItemDependencyReceiptStatus(operation)
  const body = value.body
  const revision = body.revision
  if (
    body.schema !== PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_SCHEMA ||
    body.version !== PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_VERSION ||
    body.workspaceId !== workspaceId ||
    body.operation !== operation ||
    body.status !== status ||
    value.status !== status ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const dependency = readStoredPlanningWorkItemDependency(body.dependency)
  if (dependency.id !== dependencyId) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  const receipt = {
    schema: PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_SCHEMA,
    version: PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_VERSION,
    workspaceId,
    operation,
    dependency,
    revision,
    status,
  }
  if (stableDigestStringify({ status, body: receipt }) !== stableDigestStringify(value)) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  return { dependency, revision, status }
}

/**
 * Reauthorizes both stored endpoints and loads the current filtered Planning snapshot.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param dependency - Strictly validated stored dependency.
 * @param operation - Stored mutation operation.
 * @param committedRevision - Planning revision atomically committed with the receipt.
 * @returns Current Planning snapshot visible to the principal.
 */
async function readPlanningWorkItemDependencyReplaySnapshot(
  principal: WorkspacePrincipal,
  dependency: WorkItemScheduleDependency,
  operation: PlanningWorkItemDependencyReceiptOperation,
  committedRevision: number,
): Promise<PlanningSnapshot> {
  await Promise.all([
    requirePlanningWorkItemEndpointPermission(principal, dependency.predecessor, 'manager'),
    requirePlanningWorkItemEndpointPermission(principal, dependency.successor, 'manager'),
  ])
  const workItemState = await readPlanningWorkItemState(principal)
  const snapshot = await workItemDependencies.planning.get(principal.directoryId, workItemState)
  if (snapshot.revision < committedRevision) {
    throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
  }
  if (snapshot.revision === committedRevision) {
    const current = snapshot.workItemDependencies.find((candidate) =>
      candidate.id === dependency.id
    )
    const stateMatches = operation === 'delete'
      ? current === undefined
      : current !== undefined &&
        stableDigestStringify(current) === stableDigestStringify(dependency)
    if (!stateMatches) {
      throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
    }
  }
  return filterPlanningSnapshotForPrincipal(principal, snapshot)
}

/**
 * Copies exactly the canonical dependency fields allowed in a compact receipt.
 *
 * @param dependency - Domain-produced committed dependency.
 * @returns Detached receipt-safe dependency.
 */
function createPlanningWorkItemDependencyReceiptValue(
  dependency: WorkItemScheduleDependency,
): WorkItemScheduleDependency {
  return {
    id: dependency.id,
    predecessor: { ...dependency.predecessor },
    successor: { ...dependency.successor },
    type: dependency.type,
    lagDays: dependency.lagDays,
    ...(dependency.constraint === undefined
      ? {}
      : { constraint: { ...dependency.constraint } }),
    createdAt: dependency.createdAt,
    updatedAt: dependency.updatedAt,
  }
}

/**
 * Creates the atomic compact receipt contribution for one dependency mutation.
 *
 * @param workspaceId - Opaque Workspace reservation identity.
 * @param token - Reservation token owned by this request.
 * @param operation - Mutation operation persisted in the receipt.
 * @param dependencyId - Expected committed dependency identity.
 * @returns Planning transaction contribution, or undefined when persistence is unavailable.
 */
function createPlanningWorkItemDependencyIdempotencyTransaction(
  workspaceId: string,
  token: IdempotencyMutationToken,
  operation: PlanningWorkItemDependencyReceiptOperation,
  dependencyId: string,
): PlanningMutationTransaction | undefined {
  const prepare = developerPlatformDependencies.transactions
    .prepareIdempotencyCompletionTransactWrite
  if (!prepare) return undefined
  const status = resolvePlanningWorkItemDependencyReceiptStatus(operation)
  return {
    async prepare(result) {
      const expectedKind = operation === 'delete' ? 'delete' : 'upsert'
      if (
        result.kind !== expectedKind ||
        result.dependency.id !== dependencyId ||
        !Number.isSafeInteger(result.revision) ||
        result.revision < 1
      ) {
        throw invalidStoredPlanningWorkItemDependencyMutationReceipt()
      }
      const receipt = {
        schema: PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_SCHEMA,
        version: PLANNING_WORK_ITEM_DEPENDENCY_RECEIPT_VERSION,
        workspaceId,
        operation,
        dependency: createPlanningWorkItemDependencyReceiptValue(result.dependency),
        revision: result.revision,
        status,
      }
      return prepare.call(developerPlatformDependencies.transactions, {
        workspaceId,
        credentialId: token.credentialId,
        idempotencyKey: token.idempotencyKey,
        requestFingerprint: token.requestFingerprint,
        reservationId: token.reservationId,
        response: { status, body: receipt },
      })
    },
  }
}

/** Creates the stable failure used when a durable schedule replay receipt is malformed. */
function invalidStoredWorkItemScheduleConfirmationResponse(): WorkItemScheduleError {
  return new WorkItemScheduleError(
    503,
    'InvalidStoredWorkItemScheduleConfirmationResponse',
    'The stored schedule confirmation response is invalid.',
  )
}

/** Validated compact schedule replay receipt and its current-authorization fence. */
type StoredWorkItemScheduleConfirmation = {
  /** Exact public response committed by the original confirmation. */
  response: ConfirmWorkItemScheduleChangeResponse
  /** Every server-derived Work Item endpoint that influenced the original confirmation. */
  authorizationEndpoints: WorkItemScheduleEvaluationRevision[]
}

/**
 * Revalidates one compact schedule result stored in an encrypted replay receipt.
 *
 * @param value - Candidate compact result.
 * @returns Exact validated schedule result.
 */
function readStoredWorkItemScheduleConfirmationWorkItem(
  value: unknown,
): ConfirmedWorkItemSchedule {
  if (!isRecord(value)) {
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
  try {
    const id = readPlanningIdentifier(value.id, 'Stored Work Item ID')
    const teamId = readPlanningIdentifier(value.teamId, 'Stored Team ID')
    const revision = readWorkItemExpectedRevision(value.revision)
    const schedule = normalizeWorkItemSchedule(value.schedule)
    const dueDate = typeof value.dueDate === 'string' ? value.dueDate : ''
    const assignedProjectId = value.assignedProjectId === undefined
      ? undefined
      : readPlanningIdentifier(value.assignedProjectId, 'Stored Project ID')
    const item: ConfirmedWorkItemSchedule = {
      id,
      teamId,
      revision,
      schedule,
      dueDate,
      ...(assignedProjectId ? { assignedProjectId } : {}),
    }
    if (stableDigestStringify(item) !== stableDigestStringify(value)) {
      throw invalidStoredWorkItemScheduleConfirmationResponse()
    }
    if (dueDate !== deriveWorkItemScheduleDueDate(schedule)) {
      throw invalidStoredWorkItemScheduleConfirmationResponse()
    }
    return item
  } catch (error) {
    if (
      error instanceof WorkItemScheduleError &&
      error.code === 'InvalidStoredWorkItemScheduleConfirmationResponse'
    ) {
      throw error
    }
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
}

/**
 * Reads and cross-checks the exact response committed with a schedule cascade.
 *
 * @param value - Candidate Developer Platform replay payload.
 * @param rootTeamId - Team from the replay request path.
 * @param rootWorkItemId - Work Item from the replay request path.
 * @returns Exact successful response body and every endpoint that must be reauthorized.
 */
function readStoredWorkItemScheduleConfirmationResponse(
  value: unknown,
  rootTeamId: string,
  rootWorkItemId: string,
): StoredWorkItemScheduleConfirmation {
  if (!isRecord(value) || value.status !== 200 || !isRecord(value.body)) {
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
  if (
    !Array.isArray(value.body.workItems) ||
    value.body.workItems.length === 0 ||
    value.body.workItems.length > WORK_ITEM_SCHEDULE_CASCADE_LIMIT
  ) {
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
  const workItems = value.body.workItems.map((item) =>
    readStoredWorkItemScheduleConfirmationWorkItem(item)
  )
  let authorizationEndpoints: WorkItemScheduleEvaluationRevision[]
  try {
    authorizationEndpoints = readWorkItemScheduleEvaluationRevisions(
      value.body.authorizationEndpoints,
    )
  } catch {
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
  const response: ConfirmWorkItemScheduleChangeResponse = { workItems }
  const endpointKeys = workItems.map((item) => createWorkItemDependencyKey({
    teamId: item.teamId,
    workItemId: item.id,
  }))
  const authorizationRevisions = new Map(authorizationEndpoints.map((endpoint) => [
    createWorkItemDependencyKey(endpoint),
    endpoint.expectedRevision,
  ]))
  const root = workItems[0]
  if (
    root?.teamId !== rootTeamId ||
    root.id !== rootWorkItemId ||
    new Set(endpointKeys).size !== endpointKeys.length ||
    workItems.some((item) =>
      authorizationRevisions.get(createWorkItemDependencyKey({
        teamId: item.teamId,
        workItemId: item.id,
      })) !== item.revision - 1
    ) ||
    stableDigestStringify({
      status: 200,
      body: { workItems, authorizationEndpoints },
    }) !== stableDigestStringify(value)
  ) {
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
  return { response, authorizationEndpoints }
}

/**
 * Re-evaluates current write access for every endpoint contained in a replay receipt.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param authorizationEndpoints - Validated endpoints that influenced the stored confirmation.
 */
async function requireWorkItemScheduleConfirmationReplayAuthorization(
  principal: WorkspacePrincipal,
  authorizationEndpoints: readonly WorkItemScheduleEvaluationRevision[],
): Promise<void> {
  const scopedPrincipal = await createWorkItemScheduleScopedPrincipal(principal, 'member')
  for (const endpoint of authorizationEndpoints) {
    await requirePlanningWorkItemEndpointPermission(scopedPrincipal, {
      teamId: endpoint.teamId,
      workItemId: endpoint.workItemId,
    }, 'member')
  }
}

/**
 * Orders evaluated Work Item revisions by their qualified endpoint key.
 *
 * @param left - Left revision.
 * @param right - Right revision.
 * @returns Locale comparison result for deterministic ordering.
 */
function compareWorkItemScheduleEvaluationRevisions(
  left: WorkItemScheduleEvaluationRevision,
  right: WorkItemScheduleEvaluationRevision,
) {
  return createWorkItemDependencyKey(left).localeCompare(createWorkItemDependencyKey(right))
}

/**
 * Creates an unambiguous Team-owned Project scope key for authorization filtering.
 *
 * @param teamId - Canonical owner Team identifier.
 * @param projectId - Team-local Project identifier.
 * @returns Qualified key that does not collide across Teams.
 */
function createPlanningProjectScopeKey(teamId: string, projectId: string): string {
  return `${teamId}\0${projectId}`
}

/**
 * Removes Planning records outside the principal's current Team and Project scope.
 *
 * @param principal - Authenticated principal whose current access bounds the response.
 * @param snapshot - Complete Planning snapshot loaded from the canonical store.
 * @returns A detached snapshot containing only authorized Planning and Work Item records.
 */
function filterPlanningSnapshotForPrincipal(
  principal: ProjectPrincipal,
  snapshot: PlanningSnapshot,
): PlanningSnapshot {
  if (
    principal.isSystemAdmin ||
    principal.enterprisePermissions === undefined ||
    principal.enterpriseRouteAuthorizedAtResource &&
      principal.enterpriseAuthorizationResource?.kind === 'workspace'
  ) {
    return snapshot
  }

  const projectScopeKeys = new Set(
    (principal.enterpriseProjectAccesses ?? []).flatMap((access) =>
      access.teamId
        ? [createPlanningProjectScopeKey(access.teamId, access.projectId)]
        : []
    ),
  )
  const teamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
  const entities = snapshot.entities
    .filter((entity) => entity.projectId !== undefined
      ? entity.teamId !== undefined && projectScopeKeys.has(
          createPlanningProjectScopeKey(entity.teamId, entity.projectId),
        )
      : entity.teamId !== undefined && teamIds.has(entity.teamId))
  const entityIds = new Set(entities.map((entity) => entity.id))
  const scopedEntities = entities.map((entity) => (
    entity.parentId && !entityIds.has(entity.parentId)
      ? { ...entity, parentId: undefined }
      : entity
  ))
  const dependencies = snapshot.dependencies.filter((dependency) =>
    entityIds.has(dependency.predecessorId) && entityIds.has(dependency.successorId)
  )
  const workItems = snapshot.workItems.filter((workItem) =>
    workItem.projectId !== undefined
      ? projectScopeKeys.has(
          createPlanningProjectScopeKey(workItem.teamId, workItem.projectId),
        )
      : teamIds.has(workItem.teamId)
  )
  const workItemKeys = new Set(workItems.map((workItem) =>
    createWorkItemDependencyKey({ teamId: workItem.teamId, workItemId: workItem.id })
  ))
  const workItemDependencies = snapshot.workItemDependencies.filter((dependency) =>
    workItemKeys.has(createWorkItemDependencyKey(dependency.predecessor)) &&
    workItemKeys.has(createWorkItemDependencyKey(dependency.successor))
  )
  const workItemLinks = snapshot.workItemLinks
    .filter((link) => link.projectId !== undefined
      ? projectScopeKeys.has(
          createPlanningProjectScopeKey(link.teamId, link.projectId),
        )
      : teamIds.has(link.teamId))
    .filter((link) => workItemKeys.has(createWorkItemDependencyKey({
      teamId: link.teamId,
      workItemId: link.workItemId,
    })))
    .map((link) => ({
      ...link,
      ...(link.cycleId && entityIds.has(link.cycleId)
        ? {}
        : { cycleId: undefined }),
      ...(link.milestoneId && entityIds.has(link.milestoneId)
        ? {}
        : { milestoneId: undefined }),
      goalIds: link.goalIds.filter((goalId) => entityIds.has(goalId)),
    }))
  const criticalEntityIds = snapshot.criticalPath.entityIds.filter((entityId) =>
    entityIds.has(entityId)
  )
  const slackByEntityId = Object.fromEntries(
    Object.entries(snapshot.criticalPath.slackByEntityId)
      .filter(([entityId]) => entityIds.has(entityId)),
  )

  return {
    ...snapshot,
    entities: scopedEntities,
    dependencies,
    workItemDependencies,
    workItemLinks,
    workItems,
    criticalPath: {
      entityIds: criticalEntityIds,
      totalDurationDays: criticalEntityIds.length === snapshot.criticalPath.entityIds.length
        ? snapshot.criticalPath.totalDurationDays
        : 0,
      slackByEntityId,
    },
    workItemDependencySummary: createPlanningWorkItemDependencySummary(
      workItemDependencies,
      workItems,
      workItemLinks,
    ),
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
  return workItemDependencies.teamIssues.getProjectIssues(directoryId, projectId)
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
        profiles.set(userId, await authenticationDependencies.cognito.getUserProfile(userId))
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
        profiles.set(userId, await authenticationDependencies.cognito.getUserProfile(userId))
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














function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
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
  rejectDerivedWorkItemScheduleFields(input)
  if ('archivedAt' in input || 'archivedBy' in input) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemArchiveUpdate',
      'Work Item archive fields cannot be updated through this endpoint.',
    )
  }
  rejectWorkItemInternalFields(input, [
    'authorizationConditionChecks',
    'authorizationSnapshot',
    'configurationConditionChecks',
    'planningRevisionFence',
    'statusCategory',
    'workflowSchemaVersion',
  ])
}

/**
 * Rejects adapter-owned fields at an untrusted Work Item create boundary.
 *
 * @param input - Untrusted create body.
 */
function rejectInternalWorkItemCreateFields(input: unknown): void {
  rejectDerivedWorkItemScheduleFields(input)
  rejectWorkItemInternalFields(input, [
    'authorizationConditionChecks',
    'authorizationSnapshot',
    'configurationConditionChecks',
    'idempotencyResourceId',
    'idempotentIssueId',
    'idempotentRequestDigest',
    'statusCategory',
    'workflowSchemaVersion',
  ])
}

/**
 * Rejects named internal fields before normalization can spread an untrusted object.
 *
 * @param input - Untrusted Work Item body already narrowed to a record.
 * @param fields - Adapter-owned field names forbidden at the boundary.
 */
function rejectWorkItemInternalFields(
  input: unknown,
  fields: readonly string[],
): void {
  if (!isRecord(input)) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Work Item body must be an object.',
    )
  }
  const suppliedFields = fields.filter((field) => field in input)
  if (suppliedFields.length > 0) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      `Work Item body contains internal fields: ${suppliedFields.join(', ')}.`,
    )
  }
}

/**
 * Rejects the removed deadline mutation field at internal Work Item API boundaries.
 *
 * @param input - Untrusted create or update body.
 */
function rejectDerivedWorkItemScheduleFields(input: unknown): void {
  if (!isRecord(input)) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Work Item body must be an object.',
    )
  }
  if ('dueDate' in input) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemSchedule',
      'dueDate is derived from schedule and cannot be written directly.',
    )
  }
}

async function prepareConfiguredCreateWorkItem(
  directoryId: string,
  teamId: string,
  input: CreateTeamIssueRequestBody,
  resolved: ResolvedWorkItemConfiguration,
): Promise<CreateTeamIssueRequestBody> {
  const { quickCapture, ...inputWithoutQuickCapture } = input
  if (quickCapture !== undefined && typeof quickCapture !== 'boolean') {
    throw new WorkItemConfigurationError(
      400,
      'InvalidQuickCapture',
      'Quick capture must be a boolean.',
    )
  }
  const workflowStatus = resolveWorkflowStatus(
    resolved.configuration,
    input.workflowStatusId,
  )
  const isQuickCapture = quickCapture === true

  if (isQuickCapture && workflowStatus.statusCategory !== 'backlog') {
    throw new WorkItemConfigurationError(
      400,
      'InvalidQuickCaptureStatus',
      'Quick capture is only available in a backlog workflow status.',
    )
  }

  const projectId = readAssignedProjectId(input.assignedProjectId) ?? undefined
  const customFieldValues = normalizeCustomFieldValues(
    resolved.configuration,
    input.customFieldValues,
    { allowRequiredMissing: isQuickCapture, mode: 'create', projectId },
  )
  await requireActiveCustomFieldPeople(directoryId, resolved.configuration, customFieldValues, projectId)
  return {
    ...inputWithoutQuickCapture,
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
      allowRequiredMissing:
        currentWorkflowStatus.statusCategory === 'backlog' &&
        nextWorkflowStatus.statusCategory === 'backlog',
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
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(directoryId, 'ja')
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
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(directoryId, 'ja')
  const targetTeamIds = teamId
    ? [teamId]
    : directory.teams.map((team) => team.id)

  for (const targetTeamId of targetTeamIds) {
    if (!teamId) {
      const resolved = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
        directoryId,
        targetTeamId,
      )
      if (!resolved.inheritedFrom && resolved.configuration.scopeType === 'team') {
        continue
      }
    }

    const readLimit = createWorkItemListProbeLimit(WORK_ITEMS_PARTITION_SCAN_LIMIT)
    const response = await workItemDependencies.teamIssues.getTeamIssues(
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


function getWorkItemConfigurationTableName() {
  return getEnv('WORK_ITEM_CONFIGURATION_TABLE_NAME') ??
    'mukuroji-work-item-configuration-local'
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
  const ssoClientId = getEnv('COGNITO_SSO_CLIENT_ID')?.trim()

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
  const acceptedClientIds = new Set([clientId, ssoClientId].filter(
    (candidate): candidate is string => Boolean(candidate),
  ))

  if (
    !claims ||
    claims.token_use !== 'access' ||
    (expectedIssuer && tokenIssuer !== expectedIssuer) ||
    (acceptedClientIds.size > 0 &&
      (typeof claims.client_id !== 'string' || !acceptedClientIds.has(claims.client_id)))
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














function getAwsRegion() {
  return loadServerConfig().awsRegion
}

/**
 * Reads the configured browser origins accepted by CORS middleware.
 *
 * @returns Normalized allowed origins.
 */
export function getAllowedOrigins() {
  return loadServerConfig().allowedOrigins
}

function getCognitoEndpoint() {
  return loadServerConfig().cognitoEndpoint
}

function getEnv(name: string) {
  return loadServerConfig().environment[name]
}

/**
 * Reads the synchronous Workspace Search projection feature flag.
 *
 * @returns Whether request-time search projection is enabled.
 */
export function shouldEnableWorkspaceSearchProjection() {
  return loadServerConfig().workspaceSearchProjectionEnabled
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}



/**
 * Normalizes a Lambda HTTP event path to the canonical `/api` route prefix.
 *
 * @param event - API Gateway or Lambda Function URL event.
 * @returns The original event when canonical, or a copy with normalized paths.
 */
export function normalizeLambdaApiEvent(event: LambdaEvent): LambdaEvent {
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
  context: Context,
): Promise<DeveloperManagementPrincipal> {
  const accessToken = authorization.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim()
  if (!accessToken) {
    throw new PublicApiServiceError(
      401,
      'authentication_required',
      'A Cognito Bearer token is required.',
    )
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  const canAdminister = principal.isSystemAdmin ||
    (
      principal.enterprisePermissions !== undefined
        ? hasEnterpriseWorkspacePermission(principal, 'workspace.manage')
        : principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin'
    )
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

/**
 * Headless Developer Platform operation が current Enterprise RBAC に要求する権限と scope です。
 */
type DeveloperAuthorizationRequirement = {
  /** Operation が要求する Enterprise permission です。 */
  permission: EnterprisePermissionId
  /** Team scope が既知の場合の canonical Team ID です。 */
  teamId?: string
  /** Project scope が既知の場合の canonical Project ID です。 */
  projectId?: string
  /** Collection/Team operation で descendant Project grant を列挙するかどうかです。 */
  evaluateProjectScopes?: boolean
}

function resolveDeveloperAuthorizationResource(
  workspaceId: string,
  requirement: DeveloperAuthorizationRequirement,
): EnterpriseAuthorizationResource {
  if (requirement.projectId) {
    if (!requirement.teamId) {
      throw new TypeError('Developer Project authorization requires its owning Team ID.')
    }
    return {
      workspaceId,
      kind: 'project',
      targetId: requirement.projectId,
      parentTeamId: requirement.teamId,
    }
  }
  if (requirement.teamId) {
    return {
      workspaceId,
      kind: 'team',
      targetId: requirement.teamId,
    }
  }
  return { workspaceId, kind: 'workspace' }
}

async function resolveDeveloperCredentialPrincipal(
  credential: AuthenticatedDeveloperCredential,
  requirement: DeveloperAuthorizationRequirement,
): Promise<WorkspacePrincipal> {
  const member = await workspaceDependencies.workspaceAccess.getActiveMember(
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
  const currentCognitoGroups = await authenticationDependencies.cognito.getUserGroups(member.memberKey)
  const systemAdminGroups = new Set(getSystemAdminGroups())
  const isSystemAdmin = currentCognitoGroups.some((group) =>
    systemAdminGroups.has(group)
  )
  const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(credential.workspaceId)
  const directoryPrincipal = resolveEnterpriseDirectoryPrincipal(
    snapshot,
    member.memberKey,
    currentCognitoGroups,
  )
  if (directoryPrincipal.deprovisioned) {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceDirectoryMemberDeprovisioned',
      'Workspace access was deprovisioned by the enterprise directory.',
    )
  }
  const memberDomain = normalizeEnterpriseEmailDomain(member.email)
  const verifiedDomains = snapshot.domains.filter((domain) =>
    domain.status === 'verified'
  )
  const managedDomain = verifiedDomains.length === 0 || verifiedDomains.some((domain) =>
    domain.domain === memberDomain
  )
  const external = member.role === 'guest' || !managedDomain
  const recoveryAccount = snapshot.breakGlassAccounts.some((account) =>
    account.linkedMemberKey === member.memberKey && account.status === 'active'
  )
  requireEnterpriseExternalAccessAllowed(
    snapshot,
    member.email,
    member.role,
    recoveryAccount,
  )
  const {
    compatibleGroupMappings,
    compatibleRoleAssignments,
    directoryGroupIds,
    directoryGroupMemberships,
  } = directoryPrincipal
  const suppressLegacyWorkspaceRole = directoryPrincipal.directoryManaged ||
    compatibleRoleAssignments.some((assignment) =>
      assignment.principalKind === 'member' &&
        assignment.principalId === member.memberKey ||
      assignment.principalKind === 'directory-group' &&
        (
          assignment.source === 'directory-mapping' ||
          directoryGroupIds.includes(assignment.principalId)
        )
    ) ||
    compatibleGroupMappings.some((mapping) => mapping.enabled)
  const enterprisePrincipal = {
    kind: 'member',
    principalId: member.memberKey,
    directoryGroupIds,
    directoryGroupMemberships,
    workspaceRole: member.role,
    includeWorkspaceRolePermissions: !suppressLegacyWorkspaceRole,
    ...(suppressLegacyWorkspaceRole
      ? { directPermissions: ['workspace.read' as const] }
      : {}),
    systemAdministrator: isSystemAdmin,
    ...(external
      ? {
          permissionCeiling: snapshot.policy?.externalAccess.permissionCeiling ??
            ['workspace.read', 'members.read', 'teams.read', 'projects.read',
              'work-items.read', 'documents.read', 'files.read',
              'planning.read'] as EnterprisePermissionId[],
        }
      : {}),
  } satisfies EnterprisePrincipalContext
  const enterpriseAuthorizationEvaluation = {
    principal: enterprisePrincipal,
    snapshot,
    assignments: compatibleRoleAssignments,
    groupMappings: compatibleGroupMappings,
  } satisfies EnterpriseAuthorizationEvaluationSnapshot
  const resource = resolveDeveloperAuthorizationResource(
    credential.workspaceId,
    requirement,
  )
  const defersToLegacyBusinessAuthorization =
    !suppressLegacyWorkspaceRole &&
    (!external || snapshot.policy === undefined) &&
    !isSystemAdmin
  const requestAccess: EnterpriseRequestAccess = defersToLegacyBusinessAuthorization
    ? {
        allowed: true,
        resource,
        permissions: [],
        grantedRoutePermissions: [],
        authorizedAtResource: false,
        projectAccesses: [],
        authorizedTeamIds: [],
        teamAccesses: [],
      }
    : await evaluateEnterpriseRequestAccess({
        workspaceId: credential.workspaceId,
        resource,
        ...(requirement.evaluateProjectScopes === undefined
          ? {}
          : { evaluateProjectScopes: requirement.evaluateProjectScopes }),
        requiredPermissions: [requirement.permission],
        ...enterpriseAuthorizationEvaluation,
      })
  if (!requestAccess.allowed) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'Enterprise permission is required for this operation.',
    )
  }
  return {
    directoryId: credential.workspaceId,
    userKey: member.memberKey,
    actorId: member.id,
    isSystemAdmin,
    groups: currentCognitoGroups,
    principalKind: 'member',
    ...(defersToLegacyBusinessAuthorization
      ? {}
      : { enterprisePermissions: requestAccess.permissions }),
    enterpriseIdentityControlRevision: snapshot.controlRevision,
    enterpriseAuthorizationResource: requestAccess.resource,
    enterpriseGrantedRoutePermission: requestAccess.grantedRoutePermission,
    enterpriseGrantedRoutePermissions: requestAccess.grantedRoutePermissions,
    enterpriseRouteAuthorizedAtResource: requestAccess.authorizedAtResource,
    enterpriseProjectAccesses: requestAccess.projectAccesses,
    enterpriseAuthorizedTeamIds: requestAccess.authorizedTeamIds,
    enterpriseTeamAccesses: requestAccess.teamAccesses,
    enterpriseLegacyProjectAccessSuppressed: suppressLegacyWorkspaceRole,
    ...(defersToLegacyBusinessAuthorization
      ? {}
      : { enterpriseAuthorizationEvaluation }),
    workspaceMember: member,
    workspaceRole: member.role,
    workspaceMemberStatus: member.status,
  }
}

async function resolveDeveloperManagementPrincipal(
  principal: DeveloperManagementPrincipal,
  requirement: DeveloperAuthorizationRequirement,
): Promise<WorkspacePrincipal> {
  return resolveDeveloperCredentialPrincipal({
    kind: 'oauth-token',
    workspaceId: principal.workspaceId,
    credentialId: `session:${principal.userId}`,
    subjectUserId: principal.userId,
    scopes: [],
  }, requirement)
}

/**
 * Captures application-level authorization generations for a Work Item mutation.
 *
 * @param principal - Principal authorized against current Workspace state.
 * @param planningRevision - Planning authorization revision observed with the principal.
 * @returns A storage-agnostic authorization snapshot for the Work Item port.
 */
function createWorkItemAuthorizationSnapshot(
  principal: WorkspacePrincipal,
  planningRevision: number,
): WorkItemAuthorizationSnapshot {
  return {
    workspaceId: principal.directoryId,
    memberKey: principal.userKey,
    workspaceMemberVersion: principal.workspaceMember.version,
    planningRevision,
    ...(principal.enterpriseIdentityControlRevision === undefined
      ? {}
      : {
          enterpriseControlRevision:
            principal.enterpriseIdentityControlRevision,
        }),
  }
}

/**
 * Captures the Planning revision that serializes a Work Item Project assignment with archive.
 *
 * @param principal - Principal authorized to mutate the Work Item.
 * @returns Authorization snapshot bound to the current unfiltered Planning revision.
 */
async function createPlanningFencedWorkItemAuthorizationSnapshot(
  principal: WorkspacePrincipal,
): Promise<WorkItemAuthorizationSnapshot> {
  const planningState = await workItemDependencies.planning.getAuthorizationState(
    principal.directoryId,
  )
  return createWorkItemAuthorizationSnapshot(principal, planningState.revision)
}

/**
 * Validates that a Work Item has no incident schedule dependency and captures mutation fences.
 *
 * @param principal - Principal authorized to mutate the Work Item.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @returns Authorization snapshot bound to the exact unfiltered Planning revision checked.
 */
async function createDependencyFencedWorkItemAuthorizationSnapshot(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<WorkItemAuthorizationSnapshot> {
  const planningState = await workItemDependencies.planning.getAuthorizationState(
    principal.directoryId,
  )
  if (planningState.workItemDependencies === undefined) {
    throw new PlanningError(
      503,
      'PlanningWorkItemDependencyStateUnavailable',
      'Work Item dependency state is unavailable for mutation validation.',
    )
  }
  requirePlanningWorkItemHasNoScheduleDependencies(
    planningState.workItemDependencies,
    teamId,
    workItemId,
  )
  return createWorkItemAuthorizationSnapshot(principal, planningState.revision)
}

/**
 * Creates transaction checks for caller authorization sources outside the Planning graph.
 *
 * Planning META is intentionally excluded because the Planning client's own revision CAS already
 * fences it. Project ACL writes advance the active Workspace member version, while enterprise
 * role and assignment writes advance the optional CONTROL revision.
 *
 * @param principal - Principal whose endpoint-manager permissions were evaluated.
 * @returns Workspace member and optional enterprise CONTROL condition checks.
 */
function createPlanningCallerAuthorizationConditionChecks(
  principal: WorkspacePrincipal,
): PlanningCallerAuthorizationConditionCheck[] {
  const workspaceMemberCheck = {
    ConditionCheck: {
      TableName:
        getEnv('MUKUROJI_WORKSPACE_ACCESS_TABLE') ??
        getEnv('WORKSPACE_ACCESS_TABLE_NAME') ??
        'mukuroji-workspace-access-local',
      Key: {
        workspaceId: principal.directoryId,
        recordKey: `MEMBER#${normalizeProjectMemberKey(principal.userKey)}`,
      },
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
        ':expectedVersion': principal.workspaceMember.version,
      },
    },
  } satisfies PlanningCallerAuthorizationConditionCheck
  const enterpriseTableName = getEnv('ENTERPRISE_IDENTITY_TABLE_NAME')?.trim()
  const controlRevision = principal.enterpriseIdentityControlRevision
  if (!enterpriseTableName || controlRevision === undefined) return [workspaceMemberCheck]

  const expressionAttributeNames: Record<string, string> = {
    '#controlRevision': 'controlRevision',
    '#entryType': 'entryType',
  }
  if (controlRevision === 0) expressionAttributeNames['#scopeKey'] = 'scopeKey'
  const enterpriseControlCheck = {
    ConditionCheck: {
      TableName: enterpriseTableName,
      Key: {
        scopeKey: `WORKSPACE#${principal.directoryId}`,
        recordKey: 'CONTROL',
      },
      ConditionExpression: controlRevision === 0
        ? '(attribute_not_exists(#scopeKey) OR ' +
          '(#entryType = :controlEntryType AND #controlRevision = :expectedControlRevision))'
        : '#entryType = :controlEntryType AND #controlRevision = :expectedControlRevision',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: {
        ':controlEntryType': 'enterprise-identity-control',
        ':expectedControlRevision': controlRevision,
      },
    },
  } satisfies PlanningCallerAuthorizationConditionCheck
  return [workspaceMemberCheck, enterpriseControlCheck]
}

async function resolveStableWorkItemAuthorization<T>(
  workspaceId: string,
  resolvePrincipal: () => Promise<WorkspacePrincipal>,
  authorize: (principal: WorkspacePrincipal) => Promise<T>,
) {
  for (
    let attempt = 0;
    attempt < WORK_ITEM_AUTHORIZATION_SNAPSHOT_RETRY_LIMIT;
    attempt += 1
  ) {
    const planningRevision = await workItemDependencies.planning.getAuthorizationRevision(workspaceId)
    let authorization:
      | { ok: true; principal: WorkspacePrincipal; value: T }
      | { ok: false; error: unknown }
    try {
      const principal = await resolvePrincipal()
      authorization = {
        ok: true,
        principal,
        value: await authorize(principal),
      }
    } catch (error) {
      authorization = { ok: false, error }
    }
    if (await workItemDependencies.planning.getAuthorizationRevision(workspaceId) !== planningRevision) {
      continue
    }
    if (!authorization.ok) throw authorization.error
    return {
      principal: authorization.principal,
      value: authorization.value,
      authorizationSnapshot: createWorkItemAuthorizationSnapshot(
        authorization.principal,
        planningRevision,
      ),
    }
  }
  throw createWorkItemAuthorizationChangedError()
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
  if (!token || !developerPlatformDependencies.transactions.prepareIdempotencyCompletionTransactWrite) {
    return undefined
  }
  return {
    async prepare(response) {
      return developerPlatformDependencies.transactions.prepareIdempotencyCompletionTransactWrite?.({
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
 * Persists the adapter-produced compact schedule result as the exact replay response.
 *
 * @param workspaceId - Workspace that owns the idempotency reservation.
 * @param token - Reservation token bound to the confirmation request.
 * @param authorizationEndpoints - Server-derived endpoints that influenced the confirmation.
 * @returns Transaction contribution that stores the compact HTTP response.
 */
function createWorkItemScheduleConfirmationIdempotencyTransaction(
  workspaceId: string,
  token: IdempotencyMutationToken,
  authorizationEndpoints: readonly WorkItemScheduleEvaluationRevision[],
): WorkItemIdempotencyTransaction | undefined {
  const transaction = createWorkItemIdempotencyTransaction(workspaceId, token)
  if (!transaction) return undefined
  return {
    async prepare(response) {
      if (
        response.status !== 200 ||
        !isRecord(response.body) ||
        !Array.isArray(response.body.workItems)
      ) {
        throw new WorkItemScheduleError(
          503,
          'InvalidWorkItemScheduleCascadeReceipt',
          'The schedule cascade produced an invalid durable receipt.',
        )
      }
      return transaction.prepare({
        status: 200,
        body: {
          workItems: response.body.workItems,
          authorizationEndpoints,
        },
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
  authorizationSnapshot?: WorkItemAuthorizationSnapshot,
) {
  rejectInternalWorkItemCreateFields(input)
  requireWorkspaceBusinessWrite(principal)
  const permission = await requireTeamPermission(principal, teamId, 'member')
  const body = normalizeTeamIssueInput(input, permission.team)
  requireAssignedProjectPermission(
    principal,
    permission,
    readAssignedProjectId(body.assignedProjectId),
    'member',
  )
  const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
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
  const response = await workItemDependencies.teamIssues.createTeamIssue(
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
      authorizationSnapshot,
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

/**
 * Adapts request-bound canonical Work Item operations and authorization to the Public API port.
 *
 * @returns A Public API Work Item service backed by canonical application operations.
 */
export function createCanonicalPublicWorkItemService(): PublicWorkItemService {
  return {
    async list(credential, filters, continuation, limit) {
      const teamId = typeof filters.teamId === 'string' ? filters.teamId : ''
      if (!teamId) {
        throw new PublicApiServiceError(400, 'invalid_request', 'teamId is required.')
      }
      const assignedProjectId = typeof filters.assignedProjectId === 'string'
        ? filters.assignedProjectId
        : undefined
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.read',
        teamId,
        ...(assignedProjectId ? { projectId: assignedProjectId } : {}),
        evaluateProjectScopes: true,
      })
      const permission = await requireTeamPermission(principal, teamId, 'viewer')
      const accessibleProjectIds = principal.isSystemAdmin
        ? undefined
        : (permission.projectAccesses ?? [])
            .filter((access) => projectAccessAllows(access, 'viewer'))
            .map((access) => access.projectId)
      if (
        assignedProjectId &&
        accessibleProjectIds &&
        !accessibleProjectIds.includes(assignedProjectId)
      ) {
        return { items: [], hasMore: false }
      }
      const page = await workItemDependencies.teamIssues.getPublicWorkItemPage(
        principal.directoryId,
        teamId,
        {
          limit,
          ...(continuation ? { cursor: continuation } : {}),
          ...(assignedProjectId ? { assignedProjectId } : {}),
          ...(typeof filters.assigneeUserId === 'string'
            ? { assigneeUserId: filters.assigneeUserId }
            : {}),
          ...(typeof filters.workflowStatusId === 'string'
            ? { workflowStatusId: filters.workflowStatusId }
            : {}),
          ...(typeof filters.updatedAfter === 'string'
            ? { updatedAfter: filters.updatedAfter }
            : {}),
          ...(accessibleProjectIds ? { accessibleProjectIds } : {}),
        },
      )
      return {
        items: page.issues,
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor ? { nextContinuation: page.nextCursor } : {}),
      }
    },

    async get(credential, teamId, workItemId) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.read',
        teamId,
        evaluateProjectScopes: true,
      })
      return (await loadAuthorizedTeamIssue(
        principal,
        teamId,
        workItemId,
        'viewer',
      )).detail.issue
    },

    async authorizeCreate(credential, input) {
      const { teamId, ...workItemInput } = input
      rejectInternalWorkItemCreateFields(workItemInput)
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.write',
        teamId,
        ...(typeof workItemInput.assignedProjectId === 'string'
          ? { projectId: workItemInput.assignedProjectId }
          : {}),
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      const permission = await requireTeamPermission(principal, teamId, 'member')
      const body = normalizeTeamIssueInput(workItemInput, permission.team)
      requireAssignedProjectPermission(
        principal,
        permission,
        readAssignedProjectId(body.assignedProjectId),
        'member',
      )
    },

    async create(credential, input, context) {
      const { teamId, ...workItemInput } = input
      rejectInternalWorkItemCreateFields(workItemInput)
      const authorization = await resolveStableWorkItemAuthorization(
        credential.workspaceId,
        async () => await resolveDeveloperCredentialPrincipal(credential, {
          permission: 'work-items.write',
          teamId,
          ...(typeof workItemInput.assignedProjectId === 'string'
            ? { projectId: workItemInput.assignedProjectId }
            : {}),
          evaluateProjectScopes: true,
        }),
        async (principal) => {
          requireWorkspaceBusinessWrite(principal)
          const permission = await requireTeamPermission(principal, teamId, 'member')
          const body = normalizeTeamIssueInput(workItemInput, permission.team)
          requireAssignedProjectPermission(
            principal,
            permission,
            readAssignedProjectId(body.assignedProjectId),
            'member',
          )
        },
      )
      return createCanonicalPublicWorkItem(
        authorization.principal,
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
        authorization.authorizationSnapshot,
      )
    },

    async authorizeUpdate(credential, teamId, workItemId, input) {
      rejectInternalWorkItemUpdateFields(input)
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.write',
        teamId,
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      const permission = await requireTeamPermission(principal, teamId, 'member')
      const body = normalizeTeamIssueInput(input, permission.team)
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
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
    },

    async update(
      credential,
      teamId,
      workItemId,
      input,
      mutationContext,
      idempotency,
    ) {
      rejectInternalWorkItemUpdateFields(input)
      const authorization = await resolveStableWorkItemAuthorization(
        credential.workspaceId,
        async () => await resolveDeveloperCredentialPrincipal(credential, {
          permission: 'work-items.write',
          teamId,
          evaluateProjectScopes: true,
        }),
        async (principal) => {
          requireWorkspaceBusinessWrite(principal)
          const permission = await requireTeamPermission(principal, teamId, 'member')
          const body = normalizeTeamIssueInput(input, permission.team)
          const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
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
          const dependencyAuthorizationSnapshot =
            'schedule' in body &&
              body.schedule !== undefined &&
              stableDigestStringify(body.schedule) !==
                stableDigestStringify(detail.issue.schedule)
              ? await createDependencyFencedWorkItemAuthorizationSnapshot(
                  principal,
                  teamId,
                  workItemId,
                )
              : undefined
          return { body, detail, dependencyAuthorizationSnapshot }
        },
      )
      const { principal, authorizationSnapshot } = authorization
      const { body, detail, dependencyAuthorizationSnapshot } = authorization.value
      if (
        dependencyAuthorizationSnapshot &&
        dependencyAuthorizationSnapshot.planningRevision !==
          authorizationSnapshot.planningRevision
      ) {
        throw createWorkItemAuthorizationChangedError()
      }
      const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
      const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
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
      const response = await workItemDependencies.teamIssues.updateTeamIssue(
        principal.directoryId,
        teamId,
        workItemId,
        { ...configuredBody, expectedRevision, authorizationSnapshot },
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

    async authorizeDelete(credential, teamId, workItemId) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.write',
        teamId,
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      await requireTeamPermission(principal, teamId, 'member')
      const enterpriseEvaluation = principal.enterpriseAuthorizationEvaluation
      if (
        enterpriseEvaluation &&
        !evaluateEnterpriseAccess({
          permission: 'work-items.write',
          principal: enterpriseEvaluation.principal,
          assignments: enterpriseEvaluation.assignments,
          customRoles: enterpriseEvaluation.snapshot.customRoles,
          groupMappings: enterpriseEvaluation.groupMappings,
          resource: {
            workspaceId: principal.directoryId,
            kind: 'team',
            targetId: teamId,
          },
        }).allowed
      ) {
        throw new ProjectDataError(
          403,
          'ProjectAccessDenied',
          `User "${principal.userKey}" cannot prove current Team write access for deleted Work Item "${workItemId}".`,
        )
      }
    },

    async delete(
      credential,
      teamId,
      workItemId,
      expectedRevision,
      mutationContext,
      idempotency,
    ) {
      const authorization = await resolveStableWorkItemAuthorization(
        credential.workspaceId,
        async () => await resolveDeveloperCredentialPrincipal(credential, {
          permission: 'work-items.write',
          teamId,
          evaluateProjectScopes: true,
        }),
        async (principal) => {
          requireWorkspaceBusinessWrite(principal)
          await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
          return await createDependencyFencedWorkItemAuthorizationSnapshot(
            principal,
            teamId,
            workItemId,
          )
        },
      )
      const { principal, authorizationSnapshot } = authorization
      if (
        authorization.value.planningRevision !==
          authorizationSnapshot.planningRevision
      ) {
        throw createWorkItemAuthorizationChangedError()
      }
      const externalLinks = await developerPlatformDependencies.externalLinks.listExternalWorkItemLinks({
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
      if (!workItemDependencies.teamIssues.deleteTeamIssue) {
        throw new PublicApiServiceError(
          503,
          'temporarily_unavailable',
          'Canonical Work Item deletion is not configured.',
          true,
        )
      }
      const [externalLinkFence, documentBacklinkFence] = await Promise.all([
        developerPlatformDependencies.transactions.prepareWorkItemDeletionFenceTransactWrite?.({
          workspaceId: principal.directoryId,
          teamId,
          workItemId,
        }),
        workItemDependencies.documents.prepareWorkItemDeletionFenceTransactWrite({
          workspaceId: principal.directoryId,
          workItemId: `team/${teamId}/issue/${workItemId}`,
        }),
      ])
      const response = await workItemDependencies.teamIssues.deleteTeamIssue(
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
        [
          ...(externalLinkFence
            ? [{
                kind: 'external-links' as const,
                transactWriteItem: externalLinkFence.transactWriteItem,
              }]
            : []),
          {
            kind: 'document-backlinks',
            transactWriteItem: documentBacklinkFence.transactWriteItem,
          },
        ],
        undefined,
        authorizationSnapshot,
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
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: write ? 'work-items.write' : 'work-items.read',
        teamId,
        evaluateProjectScopes: true,
      })
      if (write) requireWorkspaceBusinessWrite(principal)
      await loadAuthorizedTeamIssue(
        principal,
        teamId,
        workItemId,
        write ? 'member' : 'viewer',
      )
    },

    async authorizeWebhookTeams(managementPrincipal, teamIds) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: 'workspace.manage',
      })
      requireWorkspaceBusinessWrite(principal)
      for (const teamId of teamIds) {
        await requireWebhookTeamPermission(principal, teamId)
      }
    },

    async dryRunImport(managementPrincipal, input) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: 'work-items.write',
        teamId: input.teamId,
        ...(input.assignedProjectId ? { projectId: input.assignedProjectId } : {}),
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      await requirePublicImportPermission(principal, input)
      return (await validatePublicImport(principal, input)).report
    },

    async commitImport(managementPrincipal, dryRunJobId, input, mutationContext) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: 'work-items.write',
        teamId: input.teamId,
        ...(input.assignedProjectId ? { projectId: input.assignedProjectId } : {}),
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      if (dryRunJobId) {
        const dryRunJob = (await developerPlatformDependencies.imports.listImportJobs(principal.directoryId))
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
      const job = await developerPlatformDependencies.imports.createImportJob({
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
          executions: developerPlatformDependencies.workItemImportExecutions,
          sources: developerPlatformDependencies.workItemImportSources,
          queue: developerPlatformDependencies.workItemImportQueue,
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
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: write ? 'work-items.write' : 'work-items.read',
        teamId: job.teamId,
        ...(job.assignedProjectId ? { projectId: job.assignedProjectId } : {}),
        evaluateProjectScopes: true,
      })
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
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: 'work-items.write',
        teamId: job.teamId,
        ...(job.assignedProjectId ? { projectId: job.assignedProjectId } : {}),
        evaluateProjectScopes: true,
      })
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
          executions: developerPlatformDependencies.workItemImportExecutions,
          sources: developerPlatformDependencies.workItemImportSources,
          jobs: createWorkItemImportJobLifecycle(),
          now: () => new Date(),
        },
      )
      return requireImportJob(principal.directoryId, job.id)
    },

    async export(managementPrincipal, _format, continuation, limit) {
      const principal = await resolveDeveloperManagementPrincipal(managementPrincipal, {
        permission: 'work-items.read',
        evaluateProjectScopes: true,
      })
      requireWorkspaceBusinessWrite(principal)
      return readAccessibleWorkItemExportPage(
        principal,
        continuation,
        limit,
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
        const principal = await resolveConnectorActorPrincipal(
          workspaceId,
          actorUserId,
          {
            permission: write ? 'work-items.write' : 'work-items.read',
            teamId,
            evaluateProjectScopes: true,
          },
        )
        if (write) requireWorkspaceBusinessWrite(principal)
        await loadAuthorizedTeamIssue(
          principal,
          teamId,
          workItemId,
          write ? 'member' : 'viewer',
        )
      } catch (error) {
        if (
          (
            error instanceof PublicApiServiceError ||
            error instanceof ProjectDataError ||
            error instanceof WorkspaceAccessError
          ) &&
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
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        workspaceId,
        teamId,
        workItemId,
        { consistentIssueRead: true, eventLimit: 0 },
      )
      return toConnectorWorkItemSnapshot(detail.issue)
    },

    async applyExternal(input) {
      const preauthorizedPrincipal = await resolveConnectorActorPrincipal(
        input.workspaceId,
        input.actorUserId,
        {
          permission: 'work-items.write',
          teamId: input.teamId,
          evaluateProjectScopes: true,
        },
      )
      requireWorkspaceBusinessWrite(preauthorizedPrincipal)
      await requireTeamPermission(preauthorizedPrincipal, input.teamId, 'member')
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
      const reservation = await developerPlatformDependencies.idempotency.reserveIdempotency(
        reservationRequest,
      )
      if (reservation.status === 'replay') {
        const replayPrincipal = await resolveConnectorActorPrincipal(
          input.workspaceId,
          input.actorUserId,
          {
            permission: 'work-items.write',
            teamId: input.teamId,
            evaluateProjectScopes: true,
          },
        )
        requireWorkspaceBusinessWrite(replayPrincipal)
        await loadAuthorizedTeamIssue(
          replayPrincipal,
          input.teamId,
          input.workItemId,
          'member',
        )
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
        const authorization = await resolveStableWorkItemAuthorization(
          input.workspaceId,
          async () => await resolveConnectorActorPrincipal(
            input.workspaceId,
            input.actorUserId,
            {
              permission: 'work-items.write',
              teamId: input.teamId,
              evaluateProjectScopes: true,
            },
          ),
          async (principal) => {
            requireWorkspaceBusinessWrite(principal)
            const permission = await requireTeamPermission(
              principal,
              input.teamId,
              'member',
            )
            const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
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
            return { detail, permission }
          },
        )
        const { principal, authorizationSnapshot } = authorization
        const { detail, permission } = authorization.value
        if (detail.issue.revision !== input.expectedRevision) {
          await developerPlatformDependencies.idempotency.releaseIdempotency(completionRequest)
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
        const configuration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
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
          developerPlatformDependencies.transactions.prepareIdempotencyCompletionTransactWrite
            ? {
                async prepare(response) {
                  return developerPlatformDependencies.transactions.prepareIdempotencyCompletionTransactWrite?.({
                    ...completionRequest,
                    response,
                  })
                },
              }
            : undefined
        const response = await workItemDependencies.teamIssues.updateTeamIssue(
          input.workspaceId,
          input.teamId,
          input.workItemId,
          { ...configuredBody, authorizationSnapshot },
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
        await developerPlatformDependencies.idempotency.completeIdempotency({
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
        await developerPlatformDependencies.idempotency
          .releaseIdempotency(completionRequest)
          .catch(() => undefined)
        if (error instanceof ProjectDataError && error.code === 'WorkItemRevisionConflict') {
          const latest = await workItemDependencies.teamIssues.getTeamIssueDetail(
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
        if (error instanceof ProjectDataError && error.code === 'WorkItemAuthorizationChanged') {
          throw new ConnectorRuntimeError(
            'ConnectorWorkItemAuthorizationChanged',
            'Work Item authorization changed during connector synchronization.',
            { retryable: true },
          )
        }
        throw error
      }
    },
  }
}

/** Connector actor の current Workspace membership を解決します。 */
function resolveConnectorActorPrincipal(
  workspaceId: string,
  actorUserId: string,
  requirement: DeveloperAuthorizationRequirement,
) {
  return resolveDeveloperCredentialPrincipal({
    kind: 'oauth-token',
    workspaceId,
    credentialId: `connector-actor:${createHash('sha256')
      .update(actorUserId)
      .digest('hex')
      .slice(0, 48)}`,
    subjectUserId: actorUserId,
    scopes: [],
  }, requirement)
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
      const principal = await resolveConnectorActorPrincipal(
        workspaceId,
        userId,
        { permission: 'workspace.manage' },
      )
      requireWorkspaceBusinessWrite(principal)
      if (
        principal.enterprisePermissions === undefined &&
        principal.workspaceRole !== 'owner' &&
        principal.workspaceRole !== 'admin'
      ) {
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
  const persistence = createDynamoDbConnectorSyncPersistenceFromEnvironment(environment)
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
    platform: createForwardingClient(() => ({
      readConnectorLifecycleSnapshot: (request) =>
        developerPlatformDependencies.connectors
          .readConnectorLifecycleSnapshot(request),
      readConnectorCredential: (request) =>
        developerPlatformDependencies.connectors.readConnectorCredential(request),
      updateConnectorStatus: (request) =>
        developerPlatformDependencies.connectors.updateConnectorStatus(request),
      recoverConnector: (request) =>
        developerPlatformDependencies.connectors.recoverConnector(request),
      claimConnectorCredentialRefresh: (request) =>
        developerPlatformDependencies.connectors
          .claimConnectorCredentialRefresh(request),
      releaseConnectorCredentialRefresh: (request) =>
        developerPlatformDependencies.connectors
          .releaseConnectorCredentialRefresh(request),
      listExternalWorkItemLinks: (request) =>
        developerPlatformDependencies.externalLinks
          .listExternalWorkItemLinks(request),
    })),
    registry,
    workItems: createCanonicalConnectorWorkItemGateway(),
    persistence,
    health,
    originSigningSecret,
    previousOriginSigningSecrets: readConnectorSyncOriginPreviousSigningSecrets(
      environment.CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON,
    ),
  })
  authorization = new ConnectorAuthorizationRuntime({
    platform: createForwardingClient(() => developerPlatformDependencies.connectors),
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

/**
 * Parses previous Connector origin signing secrets used during key rotation.
 *
 * @param value - Optional JSON array from configuration.
 * @returns Up to three validated previous secrets.
 */
export function readConnectorSyncOriginPreviousSigningSecrets(
  value: string | undefined,
) {
  if (!value?.trim()) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.length > 3) throw new TypeError()
    const secrets = parsed.map((secret) => {
      if (typeof secret !== 'string') throw new TypeError()
      return secret.trim()
    })
    if (secrets.some((secret) => Buffer.byteLength(secret, 'utf8') < 32)) {
      throw new TypeError()
    }
    return secrets
  } catch {
    throw new TypeError(
      'CONNECTOR_SYNC_ORIGIN_PREVIOUS_SIGNING_SECRETS_JSON must be a JSON array of up to three strings containing at least 32 bytes.',
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
      await loadConnectorRuntimeEnvironment(
        process.env,
        createSecretsManagerConnectorRuntimeSecretLoader(),
      ),
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

/**
 * Lazily loads the configured synchronization engine for Connector workers.
 *
 * @returns The configured Connector synchronization engine.
 */
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
  const configuration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
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
  const job = (await developerPlatformDependencies.imports.listImportJobs(workspaceId))
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
      await developerPlatformDependencies.imports.updateImportJob({
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
      await developerPlatformDependencies.imports.updateImportJob({
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
      await developerPlatformDependencies.imports.updateImportJob({
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
      await developerPlatformDependencies.imports.updateImportJob({
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
  }, {
    permission: 'work-items.write',
    teamId: execution.teamId,
    ...(execution.assignedProjectId
      ? { projectId: execution.assignedProjectId }
      : {}),
    evaluateProjectScopes: true,
  })
}

/**
 * Determines whether a Workspace role may manage Work Item imports.
 *
 * @param role - Current Workspace role.
 * @returns Whether import management is allowed.
 */
export function canManageWorkItemImports(role: WorkspaceRole) {
  return role === 'owner' || role === 'admin'
}

async function requireWorkItemImportExecutionAuthorization(
  principal: WorkspacePrincipal,
  execution: WorkItemImportExecution,
) {
  const enterpriseEvaluation = principal.enterpriseAuthorizationEvaluation
  const canManageImport = enterpriseEvaluation
    ? evaluateEnterpriseAccess({
        permission: 'workspace.manage',
        principal: enterpriseEvaluation.principal,
        assignments: enterpriseEvaluation.assignments,
        customRoles: enterpriseEvaluation.snapshot.customRoles,
        groupMappings: enterpriseEvaluation.groupMappings,
        resource: {
          workspaceId: principal.directoryId,
          kind: 'workspace',
        },
      }).allowed
    : canManageWorkItemImports(principal.workspaceRole)
  if (!canManageImport) {
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
}

async function authorizeWorkItemImportExecution(execution: WorkItemImportExecution) {
  try {
    const principal = await resolveWorkItemImportPrincipal(execution)
    await requireWorkItemImportExecutionAuthorization(principal, execution)
  } catch (error) {
    throw toWorkItemImportWorkerError(error)
  }
}

/**
 * Maps a Work Item import failure to retryable or terminal worker semantics.
 *
 * @param error - Unknown failure raised by a downstream port.
 * @returns The original retryable failure or a stable Work Item import error.
 */
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
      errorCode === 'WorkItemAuthorizationChanged' ||
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

/**
 * Creates application dependencies for the durable Work Item import worker.
 *
 * @returns Worker ports bound to the active dependency context.
 */
export function createWorkItemImportWorkerDependencies(): WorkItemImportWorkerDependencies {
  return {
    executions: developerPlatformDependencies.workItemImportExecutions,
    sources: developerPlatformDependencies.workItemImportSources,
    jobs: createWorkItemImportJobLifecycle(),
    authorize: authorizeWorkItemImportExecution,
    async assertTenantEnabled(execution) {
      try {
        await workspaceDependencies.tenantEntitlementEnforcement.assertFeature(
          execution.workspaceId,
          'developer-platform',
        )
      } catch (error) {
        if (
          error instanceof TenantAdministrationError &&
          error.code === 'TenantAdministrationNotInitialized'
        ) {
          await initializeLegacyTenantAdministration(execution.workspaceId)
          try {
            await workspaceDependencies.tenantEntitlementEnforcement.assertFeature(
              execution.workspaceId,
              'developer-platform',
            )
            return
          } catch (retryError) {
            if (
              retryError instanceof TenantAdministrationError &&
              retryError.code === 'TenantAdministrationNotInitialized'
            ) {
              throw new WorkItemImportError(
                'ImportTenantUnavailable',
                'Tenant administration is still initializing; the import can be retried.',
                true,
              )
            }
            if (
              retryError instanceof TenantAdministrationError &&
              (
                retryError.code === 'TenantFeatureNotEntitled' ||
                retryError.code === 'TenantClosing' ||
                retryError.code === 'TenantClosed'
              )
            ) {
              throw new WorkItemImportError(
                'ImportTenantUnavailable',
                'The tenant can no longer execute Developer Platform imports.',
              )
            }
            throw retryError
          }
        }
        if (
          error instanceof TenantAdministrationError &&
          (
            error.code === 'TenantFeatureNotEntitled' ||
            error.code === 'TenantClosing' ||
            error.code === 'TenantClosed'
          )
        ) {
          throw new WorkItemImportError(
            'ImportTenantUnavailable',
            'The tenant can no longer execute Developer Platform imports.',
          )
        }
        if (error instanceof TenantAdministrationError) {
          throw error
        }
        throw error
      }
    },
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
        const authorization = await resolveStableWorkItemAuthorization(
          request.execution.workspaceId,
          async () => await resolveWorkItemImportPrincipal(request.execution),
          async (principal) => {
            await requireWorkItemImportExecutionAuthorization(
              principal,
              request.execution,
            )
          },
        )
        await createCanonicalPublicWorkItem(
          authorization.principal,
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
          authorization.authorizationSnapshot,
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
    error instanceof DocumentError ||
    error instanceof CognitoServiceError
  ) {
    if (error.status >= 500) return undefined
    return { row, code: error.code, message: error.message }
  }
  return undefined
}

function matchesImportJobInput(
  job: ImportJob,
  input: PublicImportSourceInput,
) {
  return job.format === input.format &&
    job.teamId === input.teamId &&
    job.assignedProjectId === input.assignedProjectId &&
    JSON.stringify(job.mapping) === JSON.stringify(input.mapping)
}

/**
 * Creates an actor-scoped import row identity and payload digest.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param actorUserId - Importing actor identifier.
 * @param context - Public mutation idempotency context.
 * @param teamId - Target Team identifier.
 * @param input - Canonical Work Item creation input.
 * @returns Deterministic Work Item identity and request digest.
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
    await developerPlatformDependencies.imports.updateImportJob({
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
    error instanceof PlanningError ||
    error instanceof DocumentError ||
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
  return loadServerConfig().publicApiCursorSecret
}

if (!loadServerConfig().runtimeRole) {
  const publicApiDependencies: PublicApiDependencies = {
    apiKeys: createForwardingClient(() => developerPlatformDependencies.apiKeys),
    oauthCredentials: createForwardingClient(
      () => developerPlatformDependencies.oauthCredentials,
    ),
    webhookSubscriptions: createForwardingClient(
      () => developerPlatformDependencies.webhookSubscriptions,
    ),
    webhookDeliveries: createForwardingClient(
      () => developerPlatformDependencies.webhookDeliveries,
    ),
    connectors: createForwardingClient(() => developerPlatformDependencies.connectors),
    externalLinks: createForwardingClient(
      () => developerPlatformDependencies.externalLinks,
    ),
    imports: createForwardingClient(() => developerPlatformDependencies.imports),
    idempotency: createForwardingClient(
      () => developerPlatformDependencies.idempotency,
    ),
    rateLimits: createForwardingClient(() => developerPlatformDependencies.rateLimits),
    enforceEntitlement: async (workspaceId, method, idempotencyKey) => {
      await enforceTenantFeatureForWorkspace(
        workspaceId,
        'developer-platform',
        method,
        idempotencyKey,
      )
    },
    authenticateManagement: authenticateDeveloperManagement,
    workItems: createForwardingClient(() => developerPlatformDependencies.publicWorkItems),
    openApiDocument: PUBLIC_API_OPENAPI_DOCUMENT as unknown as Record<string, unknown>,
    get cursorSecret() {
      return getPublicApiCursorSecret()
    },
    queueWebhookDelivery,
    connectorAuthorization: lazyConnectorAuthorization,
    mapError: mapPublicApiAdapterError,
  }
  routeApp.route('/api', createPublicApiRouter(publicApiDependencies))
}

/**
 * Binds an explicit dependency context to an application operation outside an HTTP app.
 *
 * @param dependencies - Domain dependency graph owned by the operation.
 * @param operation - Operation to run inside the dependency context.
 * @returns The operation result.
 */
export function runWithAppDependencies<Result>(
  dependencies: AppDependencies,
  operation: () => Result,
): Result {
  return appDependencyRuntime.runWith(dependencies, operation)
}
