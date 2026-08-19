import { createHash, randomUUID } from 'node:crypto'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  SAVED_VIEW_SCHEMA_VERSION,
  SEARCH_SCHEMA_VERSION,
  TASK_VIEW_SCHEMA_VERSION,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  type CreateSavedWorkspaceViewInput,
  type CuratedContextItem,
  type CreateSavedTaskViewInput,
  type DocumentBlock,
  type DocumentDetail,
  type DocumentRelationTarget,
  type DuplicateSavedTaskViewInput,
  type SavedTaskView,
  type SavedTaskViewCapabilities,
  type SavedTaskViewDefaultSource,
  type SavedTaskViewsResponse,
  type SavedViewMigrationWarning,
  type SavedViewVisibility,
  type SavedWorkspaceView,
  type SavedWorkspaceViewsResponse,
  type SearchCustomFieldFilter,
  type SearchCustomFieldValue,
  type SearchEntityType,
  type SearchViewLayout,
  type TaskViewDefinition,
  type TaskViewDueDatePreset,
  type TaskViewFilters,
  type TaskViewLayout,
  type TaskViewMigrationSection,
  type TaskViewMigrationWarning,
  type TaskViewScope,
  type TaskViewSurface,
  type TaskViewWritableProjectScope,
  type UpdateSavedTaskViewInput,
  type WorkflowStatusCategory,
  type WorkItemPriority,
  type UpdateSavedWorkspaceViewInput,
  type WorkspaceSearchFilters,
  type WorkspaceSearchHighlight,
  type WorkspaceSearchResponse,
  type WorkspaceSearchResult,
} from '@mukuroji/contracts'
import {
  createDynamoDbClient as createConfiguredDynamoDbClient,
  createWorkspaceSearchWriterDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb as shouldBootstrapConfiguredLocalDynamoDb,
} from '../../infrastructure/aws/dynamodb-client'

/** Workspace search table の search document prefix です。 */
export const WORKSPACE_SEARCH_DOCUMENT_PREFIX = 'DOCUMENT#'

/** Workspace search table の saved view prefix です。 */
export const WORKSPACE_SAVED_VIEW_PREFIX = 'VIEW#'

/** Workspace search table の viewer preference prefix です。 */
export const WORKSPACE_SAVED_VIEW_PREFERENCE_PREFIX = 'PREFERENCE#'

/** Workspace search table の default view marker prefix です。 */
export const WORKSPACE_SAVED_VIEW_DEFAULT_PREFIX = 'DEFAULT#'

/** Workspace search table の汎用 task view prefix です。 */
export const WORKSPACE_TASK_VIEW_PREFIX = 'TASK_VIEW#'

/** Workspace search table の task view preference prefix です。 */
export const WORKSPACE_TASK_VIEW_PREFERENCE_PREFIX = 'TASK_VIEW_PREFERENCE#'

/** Workspace search table の task view default marker prefix です。 */
export const WORKSPACE_TASK_VIEW_DEFAULT_PREFIX = 'TASK_VIEW_DEFAULT#'

/** Workspace search table prefix for durable task view mutation receipts. */
const WORKSPACE_TASK_VIEW_MUTATION_RECEIPT_PREFIX = 'TASK_VIEW_MUTATION_RECEIPT#'

/** Workspace search table prefix for durable task view deletion tombstones. */
const WORKSPACE_TASK_VIEW_TOMBSTONE_PREFIX = 'TASK_VIEW_TOMBSTONE#'

/** Task view update/delete retries are replayable for 24 hours after commit. */
const TASK_VIEW_MUTATION_RECEIPT_TTL_SECONDS = 24 * 60 * 60

/** Search API が一 page で返す既定件数です。 */
export const WORKSPACE_SEARCH_DEFAULT_LIMIT = 30

/** Search API が一 page で返せる最大件数です。 */
export const WORKSPACE_SEARCH_MAX_LIMIT = 100

/** 一つの search page で評価する index row の最大件数です。 */
export const WORKSPACE_SEARCH_EVALUATION_LIMIT = 1_000

/** DynamoDB の一つの search document row に保存する本文の最大文字数です。 */
export const WORKSPACE_SEARCH_STORED_BODY_MAX_LENGTH = 20_000

/** Current scope を page 内で並列再検証する最大数です。 */
const WORKSPACE_SEARCH_SCOPE_CONCURRENCY = 10

/** Saved view 一覧が一 page で返す既定件数です。 */
export const SAVED_VIEW_DEFAULT_LIMIT = 50

/** Saved view 一覧が一 page で返せる最大件数です。 */
export const SAVED_VIEW_MAX_LIMIT = 100

/** Task view 一覧が一 page で返す既定件数です。 */
export const TASK_VIEW_DEFAULT_LIMIT = 50

/** Task view 一覧が一 page で返せる最大件数です。 */
export const TASK_VIEW_MAX_LIMIT = 100

/** 一回の read で lazy cleanup する orphan preference の最大数です。 */
const TASK_VIEW_ORPHAN_CLEANUP_LIMIT = 20

/** Shared task-view preference cleanup reads and deletes at most one bounded page at a time. */
const TASK_VIEW_PREFERENCE_CLEANUP_PAGE_SIZE = 100

/** Maximum UTF-8 size reserved for one normalized task view definition. */
const TASK_VIEW_DEFINITION_MAX_BYTES = 300_000

/** Discriminator used by durable task view deletion tombstones. */
const TASK_VIEW_TOMBSTONE_ENTRY_TYPE = 'task-view-tombstone'

/**
 * Workspace search index に保存する forward-compatible document です。
 */
export type WorkspaceSearchDocument = {
  /** Search document schema version です。 */
  schemaVersion: typeof SEARCH_SCHEMA_VERSION
  /** すべての application writer が束縛する canonical projection 内容の digest です。 */
  projectionDigest: string
  /** DynamoDB partition key である canonical Workspace ID です。 */
  workspaceId: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Single-table row discriminator です。 */
  entryType: 'search-document'
  /** Indexed entity の種別です。 */
  entityType: SearchEntityType
  /** Workspace 内で一意な canonical entity ID です。 */
  entityId: string
  /** Search result の主見出しです。 */
  title: string
  /** Search result の補助見出しです。 */
  subtitle?: string
  /** Keyword 検索対象の本文です。 */
  body?: string
  /** Entity を開く application-relative URL です。 */
  url: string
  /** Entity を所有する Team ID です。 */
  teamId?: string
  /** Entity の遂行先または所有 Project ID です。 */
  projectId?: string
  /** Comment、file、document が属する親 entity ID です。 */
  parentId?: string
  /** Entity の assignee user ID です。 */
  assigneeUserId?: string
  /** Entity の creator user ID です。 */
  creatorUserId?: string
  /** Entity の workflow status code です。 */
  status?: string
  /** Custom field value map です。 */
  customFields?: Record<string, SearchCustomFieldValue>
  /** Entity が持つ relation ID です。 */
  relationIds?: string[]
  /** Entity の期限日です。 */
  dueDate?: string
  /** Entity の作成日時です。 */
  createdAt?: string
  /** Entity の最終更新日時です。 */
  updatedAt?: string
  /** Canonical source と検索投影の同期を検証する revision です。 */
  sourceRevision?: number
}

/**
 * Search document を返す直前に再解決した current resource scope です。
 */
export type WorkspaceSearchResolvedScope = {
  /** Current Team ID です。 */
  teamId?: string
  /** Current Project ID です。 */
  projectId?: string
  /**
   * Team/Project scope だけでは表現できない resource ACL を source of truth で
   * 検証済みかどうかです。
   */
  permissionVerified?: boolean
  /** Source of truth から再構築した current search document です。 */
  currentDocument?: WorkspaceSearchDocument
}

/**
 * Search query が参照できる current RBAC scope です。
 */
export type WorkspaceSearchAccessScope = {
  /** Cursor を別 user へ流用させない stable viewer ID です。 */
  viewerUserId: string
  /** System administrator として全 active scope を参照できるかどうかです。 */
  isSystemAdmin: boolean
  /** Viewer role 以上を持つ current Project ID です。 */
  projectIds: ReadonlySet<string>
  /** Viewer role 以上を持つ current Team ID です。 */
  teamIds: ReadonlySet<string>
}

/**
 * Workspace search page を取得する client input です。
 */
export type WorkspaceSearchQueryInput = {
  /** Search 対象 Workspace ID です。 */
  workspaceId: string
  /** AND で適用する versioned filters です。 */
  filters?: WorkspaceSearchFilters
  /** 一 page の最大 result 数です。 */
  limit?: number
  /** 前 page が返した opaque cursor です。 */
  cursor?: string
  /** Current viewer の RBAC scope です。 */
  access: WorkspaceSearchAccessScope
  /** Indexed scope を source of truth から再解決する callback です。 */
  resolveCurrentScope?: (
    document: WorkspaceSearchDocument,
  ) => Promise<WorkspaceSearchResolvedScope | undefined>
}

/**
 * Saved view の visibility と mutation を判定する current access scope です。
 */
export type SavedViewAccessScope = {
  /** Current Workspace user ID です。 */
  viewerUserId: string
  /** System administrator かどうかです。 */
  isSystemAdmin: boolean
  /** Workspace 全体の共有 view を管理できるかどうかです。 */
  canManageSharedViews: boolean
  /** Guest 制限を通過して preference を含む mutation ができるかどうかです。 */
  canWrite: boolean
  /** Viewer role 以上で参照できる current Team ID です。 */
  teamIds: ReadonlySet<string>
  /** Manager role 以上で管理できる current Team ID です。 */
  manageableTeamIds: ReadonlySet<string>
  /** 現在存在する custom field ID です。未指定時は削除 migration を保留します。 */
  activeCustomFieldIds?: ReadonlySet<string>
}

/** Saved view 一覧を取得する input です。 */
export type ListSavedWorkspaceViewsInput = {
  /** Saved view を保持する Workspace ID です。 */
  workspaceId: string
  /** Current viewer access です。 */
  access: SavedViewAccessScope
  /** 一 page の最大 view 数です。 */
  limit?: number
  /** 前 page が返した opaque cursor です。 */
  cursor?: string
}

/** Saved view を作成する input です。 */
export type CreateSavedWorkspaceViewRequest = {
  /** Saved view を保持する Workspace ID です。 */
  workspaceId: string
  /** Current viewer access です。 */
  access: SavedViewAccessScope
  /** Ambiguous retry を同じ create 結果へ束縛する key です。 */
  idempotencyKey?: string
  /** API から検証する create payload です。 */
  input: CreateSavedWorkspaceViewInput
}

/** Saved view を更新する input です。 */
export type UpdateSavedWorkspaceViewRequest = {
  /** Saved view を保持する Workspace ID です。 */
  workspaceId: string
  /** 更新対象 view ID です。 */
  viewId: string
  /** Current viewer access です。 */
  access: SavedViewAccessScope
  /** API から検証する update payload です。 */
  input: UpdateSavedWorkspaceViewInput
}

/** Saved view を削除する input です。 */
export type DeleteSavedWorkspaceViewRequest = {
  /** Saved view を保持する Workspace ID です。 */
  workspaceId: string
  /** 削除対象 view ID です。 */
  viewId: string
  /** 読み込み時点の revision です。 */
  expectedRevision: number
  /** Current viewer access です。 */
  access: SavedViewAccessScope
}

/** Candidate relation references that require current-source authorization before disclosure. */
export type ResolveTaskViewRelationIdsInput = {
  /** Persisted relation identifiers being considered for the current response. */
  relationIds: readonly string[]
  /** Product surface that evaluates the relation filter. */
  surface: TaskViewSurface
  /** Resource scope that qualifies Team-local relation target identifiers. */
  scope: TaskViewScope
}

/** Task view の認可と read-time migration に使う current access scope です。 */
export type TaskViewAccessScope = {
  /** Current Workspace user ID です。 */
  viewerUserId: string
  /** System administrator かどうかです。 */
  isSystemAdmin: boolean
  /** Workspace 全体を対象とする task view scope を参照できるかどうかです。 */
  canAccessWorkspaceScope: boolean
  /** Workspace 全体を対象とする task view scope を更新できるかどうかです。 */
  canWriteWorkspaceScope: boolean
  /** Workspace 全体の shared task view を管理できるかどうかです。 */
  canManageSharedViews: boolean
  /** Preference を含む task view mutation が許可されるかどうかです。 */
  canWrite: boolean
  /** Current viewer が参照できる Team ID です。 */
  teamIds: ReadonlySet<string>
  /** Current viewer が task view scope を更新できる Team ID です。 */
  writableTeamIds: ReadonlySet<string>
  /** Current viewer が管理できる Team ID です。 */
  manageableTeamIds: ReadonlySet<string>
  /** Current viewer が参照できる Project ID です。 */
  projectIds: ReadonlySet<string>
  /** Current viewer が task view scope を更新できる Project ID です。 */
  writableProjectIds: ReadonlySet<string>
  /** Current viewer が参照できる `${teamId}\0${projectId}` 形式の Team-qualified Project key です。 */
  projectScopeKeys: ReadonlySet<string>
  /** Current viewer が更新できる `${teamId}\0${projectId}` 形式の Team-qualified Project key です。 */
  writableProjectScopeKeys: ReadonlySet<string>
  /** 現在存在する custom field ID です。未指定時は削除判定を保留します。 */
  activeCustomFieldIds?: ReadonlySet<string>
  /** Current viewer が値を参照できる custom field ID です。未指定時は active field をすべて許可します。 */
  readableCustomFieldIds?: ReadonlySet<string>
  /** 現在存在する `${teamId}\0${statusId}` 形式の Team-qualified workflow status key です。 */
  activeStatusIds?: ReadonlySet<string>
  /** Current viewer が layout で利用できる built-in field です。未指定時はすべて許可します。 */
  readableColumnIds?: ReadonlySet<string>
  /** Active actor identifiers whose filter references may be disclosed to the current viewer. */
  readableActorIds?: ReadonlySet<string>
  /** Static relation disclosure allowlist used when no current-source resolver is configured. */
  readableRelationIds?: ReadonlySet<string>
  /** Resolves relation references against current targets and current viewer authorization. */
  resolveReadableRelationIds?: (
    input: ResolveTaskViewRelationIdsInput,
  ) => Promise<ReadonlySet<string>>
}

/** Task view 一覧を surface と scope で取得する input です。 */
export type ListTaskViewsInput = {
  /** Task view を保持する Workspace ID です。 */
  workspaceId: string
  /** 取得対象 product surface です。省略時は全 surface を対象にします。 */
  surface?: TaskViewSurface
  /** 取得対象 resource scope です。省略時は参照可能な全 scope を対象にします。 */
  scope?: TaskViewScope
  /** Current viewer access です。 */
  access: TaskViewAccessScope
  /** 一 page の最大 view 数です。 */
  limit?: number
  /** 前 page が返した opaque cursor です。 */
  cursor?: string
}

/** Task view を ID 指定で取得する input です。 */
export type GetTaskViewRequest = {
  /** Task view を保持する Workspace ID です。 */
  workspaceId: string
  /** 取得対象 view ID です。 */
  viewId: string
  /** Current viewer access です。 */
  access: TaskViewAccessScope
}

/** Task view を作成する request です。 */
export type CreateTaskViewRequest = {
  /** Task view を保持する Workspace ID です。 */
  workspaceId: string
  /** Current viewer access です。 */
  access: TaskViewAccessScope
  /** Ambiguous retry を同じ create 結果へ束縛する key です。 */
  idempotencyKey?: string
  /** API boundary で受け取った create payload です。 */
  input: CreateSavedTaskViewInput
}

/** Task view を更新する request です。 */
export type UpdateTaskViewRequest = {
  /** Task view を保持する Workspace ID です。 */
  workspaceId: string
  /** 更新対象 view ID です。 */
  viewId: string
  /** Current viewer access です。 */
  access: TaskViewAccessScope
  /** Binds retries for 24 hours; replay rebuilds the authorized response from current view state. */
  idempotencyKey?: string
  /** API boundary で受け取った revision-guarded update payload です。 */
  input: UpdateSavedTaskViewInput
}

/** Task view を複製する request です。 */
export type DuplicateTaskViewRequest = {
  /** Task view を保持する Workspace ID です。 */
  workspaceId: string
  /** 複製元 view ID です。 */
  sourceViewId: string
  /** Current viewer access です。 */
  access: TaskViewAccessScope
  /** Ambiguous retry を同じ duplicate 結果へ束縛する key です。 */
  idempotencyKey?: string
  /** 複製先 metadata と preference の override です。 */
  input: DuplicateSavedTaskViewInput
}

/** Task view を削除する request です。 */
export type DeleteTaskViewRequest = {
  /** Task view を保持する Workspace ID です。 */
  workspaceId: string
  /** 削除対象 view ID です。 */
  viewId: string
  /** 読み込み時点の revision です。 */
  expectedRevision: number
  /** Current viewer access です。 */
  access: TaskViewAccessScope
  /** Binds ambiguous retries within 24 hours to the first committed delete result. */
  idempotencyKey?: string
}

/**
 * Workspace search と saved view で扱う stable domain error です。
 */
export class WorkspaceSearchError extends Error {
  /** HTTP response に変換する status code です。 */
  readonly status: number
  /** Client が分岐できる stable error code です。 */
  readonly code: string

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceSearchError'
    this.status = status
    this.code = code
  }
}

/** Conditional revision guard used by asynchronous source projections. */
export type WorkspaceSearchProjectionWriteOptions = {
  /** Only replace or remove a document whose stored source revision is not newer. */
  sourceRevision?: number
}

/** Canonical comment row used to fence one asynchronous Search projection. */
export type WorkspaceSearchCommentProjectionFence = {
  /** Collaboration table containing the canonical comment row. */
  sourceTableName: string
  /** Collaboration entity partition key containing the comment. */
  sourceEntityKey: string
  /** Canonical comment identifier used to derive the source sort key. */
  sourceCommentId: string
  /** Canonical comment version observed before the projection transaction. */
  sourceRevision: number
}

/** Marks persisted projection content that disagrees with its server-owned digest. */
class WorkspaceSearchProjectionDigestMismatchError extends WorkspaceSearchError {}

/**
 * API handler と backfill が利用する Workspace search client contract です。
 */
export type WorkspaceSearchClient = {
  /** Search document を idempotent に作成または置換します。 */
  upsertDocument(
    input: Parameters<typeof createWorkspaceSearchDocument>[0] | WorkspaceSearchDocument,
    options?: WorkspaceSearchProjectionWriteOptions,
  ): Promise<WorkspaceSearchDocument>
  /** Search document を entity key で削除します。 */
  deleteDocument(
    workspaceId: string,
    entityType: SearchEntityType,
    entityId: string,
    options?: WorkspaceSearchProjectionWriteOptions,
  ): Promise<void>
  /** Composite filter と current RBAC を適用して検索します。 */
  search(input: WorkspaceSearchQueryInput): Promise<WorkspaceSearchResponse>
  /** Current viewer が参照できる saved views を page 取得します。 */
  listSavedViews(input: ListSavedWorkspaceViewsInput): Promise<SavedWorkspaceViewsResponse>
  /** Saved view definition と viewer preference を作成します。 */
  createSavedView(input: CreateSavedWorkspaceViewRequest): Promise<SavedWorkspaceView>
  /** Saved view definition と viewer preference を更新します。 */
  updateSavedView(input: UpdateSavedWorkspaceViewRequest): Promise<SavedWorkspaceView>
  /** Saved view definition を revision 条件付きで削除します。 */
  deleteSavedView(input: DeleteSavedWorkspaceViewRequest): Promise<{ id: string; revision: number }>
  /**
   * Lists task views visible to the current viewer within optional surface and scope filters.
   *
   * @param input - Workspace, viewer access, filters, and cursor for the requested page.
   * @returns A permission-filtered cursor page of sanitized task views.
   */
  listTaskViews?(input: ListTaskViewsInput): Promise<SavedTaskViewsResponse>
  /**
   * Reads one task view by ID without disclosing inaccessible definitions.
   *
   * @param input - Workspace, stable view ID, and current viewer access.
   * @returns The sanitized task view with resolved current-viewer preference state.
   */
  getTaskView?(input: GetTaskViewRequest): Promise<SavedTaskView>
  /**
   * Creates a task view definition and the current viewer's initial preference.
   *
   * @param input - Authorized create input and optional idempotency key.
   * @returns The newly persisted task view in its current viewer representation.
   */
  createTaskView?(input: CreateTaskViewRequest): Promise<SavedTaskView>
  /**
   * Updates a task view definition or the current viewer's preference.
   *
   * @param input - Revision-guarded definition and preference changes.
   * @returns The updated and read-time-sanitized task view.
   */
  updateTaskView?(input: UpdateTaskViewRequest): Promise<SavedTaskView>
  /**
   * Duplicates one accessible task view into an independent lifecycle.
   *
   * @param input - Source view, destination metadata, and optional idempotency key.
   * @returns The independent duplicated task view.
   */
  duplicateTaskView?(input: DuplicateTaskViewRequest): Promise<SavedTaskView>
  /**
   * Deletes a task view definition under an optimistic revision guard.
   *
   * @param input - Authorized target ID and expected definition revision.
   * @returns The deleted view identity and acknowledged revision.
   */
  deleteTaskView?(input: DeleteTaskViewRequest): Promise<{ id: string; revision: number }>
}

/** Required application surface for the generic saved task view lifecycle. */
export type TaskViewClient = {
  /**
   * Lists task views visible in an optional surface and scope filter.
   *
   * @param input - Permission-aware list request.
   * @returns Cursor-paginated visible task views.
   */
  listTaskViews(input: ListTaskViewsInput): Promise<SavedTaskViewsResponse>
  /**
   * Reads one permission-safe task view by its stable ID.
   *
   * @param input - Workspace, view identity, and current access.
   * @returns The sanitized task view.
   */
  getTaskView(input: GetTaskViewRequest): Promise<SavedTaskView>
  /**
   * Creates one task view and its initial current-viewer preference.
   *
   * @param input - Authorized create request.
   * @returns The created task view.
   */
  createTaskView(input: CreateTaskViewRequest): Promise<SavedTaskView>
  /**
   * Updates one task view definition or current-viewer preference.
   *
   * @param input - Revision-guarded update request.
   * @returns The updated task view.
   */
  updateTaskView(input: UpdateTaskViewRequest): Promise<SavedTaskView>
  /**
   * Duplicates one accessible task view into an independent lifecycle.
   *
   * @param input - Source identity and destination metadata.
   * @returns The independent duplicate.
   */
  duplicateTaskView(input: DuplicateTaskViewRequest): Promise<SavedTaskView>
  /**
   * Deletes one task view under an optimistic revision guard.
   *
   * @param input - Authorized revision-bound delete request.
   * @returns Deleted view identity and acknowledged revision.
   */
  deleteTaskView(input: DeleteTaskViewRequest): Promise<{ id: string; revision: number }>
}

/** DynamoDB に保存する saved view definition row です。 */
type StoredSavedWorkspaceView = {
  /** 保存時の saved view schema version です。 */
  schemaVersion?: number
  /** DynamoDB partition key です。 */
  workspaceId: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Single-table row discriminator です。 */
  entryType: 'saved-view'
  /** Workspace 内で一意な view ID です。 */
  id: string
  /** View 表示名です。 */
  name: string
  /** View の補足説明です。 */
  description?: string
  /** View の共有範囲です。 */
  visibility: SavedViewVisibility
  /** View owner の user ID です。 */
  ownerUserId: string
  /** Create retry key を生値で残さず照合する hash です。 */
  createIdempotencyKeyHash?: string
  /** 同じ retry key で異なる payload を拒否する fingerprint です。 */
  createRequestFingerprint?: string
  /** Team view の共有先 Team ID です。 */
  teamId?: string
  /** 保存した search filters です。 */
  filters: WorkspaceSearchFilters
  /** 保存した表示 layout です。 */
  layout: SearchViewLayout
  /** Optimistic concurrency revision です。 */
  revision: number
  /** View 作成日時です。 */
  createdAt: string
  /** View 最終更新日時です。 */
  updatedAt: string
}

/** DynamoDB に保存する user 別 saved view preference row です。 */
type StoredSavedViewPreference = {
  /** 保存時の saved view schema version です。 */
  schemaVersion: typeof SAVED_VIEW_SCHEMA_VERSION
  /** DynamoDB partition key です。 */
  workspaceId: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Single-table row discriminator です。 */
  entryType: 'saved-view-preference'
  /** Preference 対象 view ID です。 */
  viewId: string
  /** Preference owner の user ID です。 */
  userId: string
  /** Favorite preference です。 */
  favorite: boolean
  /** Pin preference です。 */
  pinned: boolean
  /** Preference 最終更新日時です。 */
  updatedAt: string
}

/** DynamoDB に保存する user 別 default view marker です。 */
type StoredDefaultView = {
  /** 保存時の saved view schema version です。 */
  schemaVersion: typeof SAVED_VIEW_SCHEMA_VERSION
  /** DynamoDB partition key です。 */
  workspaceId: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Single-table row discriminator です。 */
  entryType: 'saved-view-default'
  /** Default marker owner の user ID です。 */
  userId: string
  /** Default に指定した view ID です。 */
  viewId: string
  /** Default marker 最終更新日時です。 */
  updatedAt: string
}

/** DynamoDB に保存する汎用 task view definition row です。 */
type StoredTaskView = {
  /** 保存時の task view schema version です。 */
  schemaVersion: typeof TASK_VIEW_SCHEMA_VERSION
  /** DynamoDB partition key です。 */
  workspaceId: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Single-table row discriminator です。 */
  entryType: 'task-view'
  /** Workspace 内で一意な task view ID です。 */
  id: string
  /** View 表示名です。 */
  name: string
  /** View の補足説明です。 */
  description?: string
  /** View の共有範囲です。 */
  visibility: SavedViewVisibility
  /** View owner の user ID です。 */
  ownerUserId: string
  /** Create retry key を生値で残さず照合する hash です。 */
  createIdempotencyKeyHash?: string
  /** 同じ retry key で異なる payload を拒否する fingerprint です。 */
  createRequestFingerprint?: string
  /** Team view の共有先 Team ID です。 */
  teamId?: string
  /** 保存した filter と layout definition です。 */
  definition: TaskViewDefinition
  /** Optimistic concurrency revision です。 */
  revision: number
  /** View 作成日時です。 */
  createdAt: string
  /** View 最終更新日時です。 */
  updatedAt: string
}

/** Durable deletion marker that prevents an idempotency key from reviving an old view lifecycle. */
type StoredTaskViewTombstone = {
  /** Schema version of the deleted task view. */
  schemaVersion: typeof TASK_VIEW_SCHEMA_VERSION
  /** DynamoDB partition key. */
  workspaceId: string
  /** DynamoDB sort key in the dedicated tombstone namespace. */
  recordKey: string
  /** Single-table row discriminator. */
  entryType: typeof TASK_VIEW_TOMBSTONE_ENTRY_TYPE
  /** Stable ID of the deleted view. */
  id: string
  /** Last acknowledged optimistic concurrency revision. */
  revision: number
  /** Create retry hash retained without the caller's raw key. */
  createIdempotencyKeyHash?: string
  /** Original create request fingerprint used to detect ambiguous retries. */
  createRequestFingerprint?: string
  /** Timestamp at which the view was deleted. */
  deletedAt: string
}

/** DynamoDB に保存する viewer 別 task view preference row です。 */
type StoredTaskViewPreference = {
  /** 保存時の task view schema version です。 */
  schemaVersion: typeof TASK_VIEW_SCHEMA_VERSION
  /** DynamoDB partition key です。 */
  workspaceId: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Single-table row discriminator です。 */
  entryType: 'task-view-preference'
  /** Preference 対象 task view ID です。 */
  viewId: string
  /** Preference owner の user ID です。 */
  userId: string
  /** Favorite preference です。 */
  favorite: boolean
  /** Pin preference です。 */
  pinned: boolean
  /** Preference 最終更新日時です。 */
  updatedAt: string
}

/** Task view default marker の owner 種別です。 */
type StoredTaskViewDefaultOwner = 'personal' | 'team'

/** DynamoDB に保存する personal または Team task view default marker です。 */
type StoredTaskViewDefault = {
  /** 保存時の task view schema version です。 */
  schemaVersion: typeof TASK_VIEW_SCHEMA_VERSION
  /** DynamoDB partition key です。 */
  workspaceId: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Single-table row discriminator です。 */
  entryType: 'task-view-default'
  /** Personal または Team marker の所有種別です。 */
  ownerType: StoredTaskViewDefaultOwner
  /** Personal marker owner の user ID です。 */
  userId?: string
  /** Team marker owner の Team ID です。 */
  teamId?: string
  /** Marker が束縛される product surface です。 */
  surface: TaskViewSurface
  /** Marker が束縛される resource scope です。 */
  scope: TaskViewScope
  /** Default に指定した task view ID です。 */
  viewId: string
  /** Marker generation used to guard same-timestamp replacement races. */
  generation?: string
  /** Default marker 最終更新日時です。 */
  updatedAt: string
}

/** Supported mutation operations persisted in a durable task view receipt. */
type TaskViewMutationOperation = 'update' | 'delete'

/** Twenty-four-hour receipt committed atomically with one task view update or delete. */
type StoredTaskViewMutationReceipt = {
  /** Schema version shared with the task view lifecycle. */
  schemaVersion: typeof TASK_VIEW_SCHEMA_VERSION
  /** DynamoDB partition key. */
  workspaceId: string
  /** DynamoDB sort key derived from the operation-bound idempotency hash. */
  recordKey: string
  /** Single-table row discriminator. */
  entryType: 'task-view-mutation-receipt'
  /** Mutation whose committed result can be replayed. */
  operation: TaskViewMutationOperation
  /** Stable target task view identifier. */
  viewId: string
  /** Workspace actor that owns the idempotency key. */
  actorUserId: string
  /** Hash of the workspace-, actor-, operation-, target-, and key-bound identity. */
  idempotencyKeyHash: string
  /** Canonical normalized request fingerprint. */
  requestFingerprint: string
  /** Task view revision acknowledged by the committed mutation. */
  resultRevision: number
  /** Timestamp at which the mutation and receipt committed. */
  committedAt: string
  /** DynamoDB TTL epoch seconds exactly 24 hours after the commit timestamp. */
  expiresAt: number
}

/** 解決済み task view default です。 */
type ResolvedTaskViewDefault = {
  /** Effective task view default identifier. */
  viewId?: string
  /** Current viewer's personal default identifier. */
  personalViewId?: string
  /** Team default identifier for the resolved scope. */
  teamViewId?: string
  /** Source that supplied the effective default. */
  source: 'personal' | 'team' | 'built-in'
}

/** Search cursor の scope-bound payload です。 */
type SearchCursor = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor discriminator です。 */
  kind: 'search'
  /** Cursor を発行した Workspace ID です。 */
  workspaceId: string
  /** Cursor を発行した viewer user ID です。 */
  viewerUserId: string
  /** Cursor を束縛する canonical query hash です。 */
  queryFingerprint: string
  /** 最後に評価した DynamoDB record key です。 */
  recordKey: string
}

/** Saved view list cursor の scope-bound payload です。 */
type SavedViewCursor = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor discriminator です。 */
  kind: 'saved-views'
  /** Cursor を発行した Workspace ID です。 */
  workspaceId: string
  /** Cursor を発行した viewer user ID です。 */
  viewerUserId: string
  /** 最後に評価した DynamoDB record key です。 */
  recordKey: string
}

/** Task view list cursor の query-bound payload です。 */
type TaskViewCursor = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor discriminator です。 */
  kind: 'task-views'
  /** Cursor を発行した Workspace ID です。 */
  workspaceId: string
  /** Cursor を発行した viewer user ID です。 */
  viewerUserId: string
  /** Surface と scope に束縛する canonical query hash です。 */
  queryFingerprint: string
  /** 最後に評価した DynamoDB record key です。 */
  recordKey: string
}

const builtInLayoutFields = new Set([
  'id',
  'entityType',
  'type',
  'title',
  'subtitle',
  'teamId',
  'team',
  'projectId',
  'project',
  'assigneeUserId',
  'assignee',
  'creatorUserId',
  'creator',
  'status',
  'dueDate',
  'createdAt',
  'updatedAt',
  'priority',
  'relevance',
])

const taskViewBuiltInLayoutFields = new Set([
  ...builtInLayoutFields,
  'customFields',
  'identifier',
  'statusId',
  'startDate',
  'estimate',
  'progress',
  'parent',
  'labels',
  'relations',
  'watchers',
])

const searchEntityTypes = new Set<SearchEntityType>([
  'work-item',
  'project',
  'team',
  'comment',
  'context-item',
  'file',
  'document',
])

const savedViewVisibilities = new Set<SavedViewVisibility>(['personal', 'team', 'shared'])
const taskViewWorkflowCategories = new Set([
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
])
const taskViewPriorities = new Set(['high', 'medium', 'low'])
const taskViewDueDatePresets = new Set(['overdue', 'today', 'upcoming', 'no-date'])
const taskViewDisplayOptionKeys = [
  'showCompleted',
  'showArchived',
  'showSubItems',
  'showEmptyGroups',
  'wrapText',
  'showAssigneeAvatars',
] as const

/**
 * Entity type と canonical ID から search document record key を作成します。
 */
export function createWorkspaceSearchDocumentRecordKey(
  entityType: SearchEntityType,
  entityId: string,
) {
  return `${WORKSPACE_SEARCH_DOCUMENT_PREFIX}${requireSearchEntityType(entityType)}#${encodeKeyPart(requireText(entityId, 'Search entity ID'))}`
}

/**
 * Creates the stable Workspace Search entity ID for a Team Issue comment.
 *
 * @param teamId - Owning Team identifier.
 * @param issueId - Team-local Work Item identifier.
 * @param commentId - Canonical Collaboration comment identifier.
 * @returns The entity ID shared by comment upsert and delete projections.
 */
export function createCommentWorkspaceSearchEntityId(
  teamId: string,
  issueId: string,
  commentId: string,
) {
  return `team/${teamId}/issue/${issueId}/comment/${commentId}`
}

/** Saved view ID から definition record key を作成します。 */
export function createSavedWorkspaceViewRecordKey(viewId: string) {
  return `${WORKSPACE_SAVED_VIEW_PREFIX}${requireIdentifier(viewId, 'Saved view ID')}`
}

/**
 * Creates the canonical task view definition record key from a view ID.
 *
 * @param viewId - Workspace-unique task view identifier.
 * @returns Server-owned DynamoDB record key for the task view definition.
 */
export function createTaskViewRecordKey(viewId: string) {
  return `${WORKSPACE_TASK_VIEW_PREFIX}${requireIdentifier(viewId, 'Task view ID')}`
}

/**
 * Creates the canonical deletion tombstone record key from a task view ID.
 *
 * @param viewId - Workspace-unique task view identifier.
 * @returns Server-owned DynamoDB record key outside the live task view namespace.
 */
function createTaskViewTombstoneRecordKey(viewId: string) {
  return `${WORKSPACE_TASK_VIEW_TOMBSTONE_PREFIX}${requireIdentifier(
    viewId,
    'Task view ID',
  )}`
}

/**
 * Normalizes one search document into its DynamoDB persistence shape.
 *
 * @param input - Untrusted projection fields supplied by an application writer.
 * @returns A validated document with canonical keys and a server-owned digest.
 */
export function createWorkspaceSearchDocument(
  input: Omit<
    WorkspaceSearchDocument,
    'schemaVersion' | 'entryType' | 'projectionDigest' | 'recordKey'
  > & {
    /** Backfill が明示する場合の record key です。 */
    recordKey?: string
  },
): WorkspaceSearchDocument {
  const entityType = requireSearchEntityType(input.entityType)
  const entityId = requireText(input.entityId, 'Search entity ID')
  const workspaceId = requireText(input.workspaceId, 'Search Workspace ID')
  const expectedRecordKey = createWorkspaceSearchDocumentRecordKey(entityType, entityId)
  if (input.recordKey !== undefined && input.recordKey !== expectedRecordKey) {
    throw new WorkspaceSearchError(
      400,
      'InvalidSearchDocument',
      'Search document record key does not match its entity identity.',
    )
  }
  const document: Omit<WorkspaceSearchDocument, 'projectionDigest'> = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    workspaceId,
    recordKey: expectedRecordKey,
    entryType: 'search-document',
    entityType,
    entityId,
    title: requireText(input.title, 'Search document title', 500),
    url: requireRelativeUrl(input.url),
  }

  copyOptionalText(document, input, 'subtitle', 500)
  copyOptionalText(
    document,
    input,
    'body',
    WORKSPACE_SEARCH_STORED_BODY_MAX_LENGTH,
  )
  copyOptionalText(document, input, 'teamId', 256)
  copyOptionalText(document, input, 'projectId', 256)
  copyOptionalText(document, input, 'parentId', 1_024)
  copyOptionalText(document, input, 'assigneeUserId', 512)
  copyOptionalText(document, input, 'creatorUserId', 512)
  copyOptionalText(document, input, 'status', 256)
  copyOptionalText(document, input, 'createdAt', 128)
  copyOptionalText(document, input, 'updatedAt', 128)
  if (input.sourceRevision !== undefined) {
    if (
      !Number.isSafeInteger(input.sourceRevision) ||
      input.sourceRevision <= 0
    ) {
      throw new WorkspaceSearchError(
        400,
        'InvalidSearchDocument',
        'Search document source revision must be a positive integer.',
      )
    }
    document.sourceRevision =
      input.sourceRevision
  }
  const dueDate = optionalText(input.dueDate, 'Search document dueDate', 128)
  if (dueDate) {
    document.dueDate = entityType === 'work-item'
      ? requireCanonicalWorkItemSearchDate(dueDate)
      : canonicalizeSearchDate(dueDate)
  }

  if (input.customFields) {
    document.customFields = normalizeCustomFieldValues(input.customFields)
  }
  if (input.relationIds) {
    document.relationIds = normalizeStringList(input.relationIds, 'Search relation IDs', 100)
  }

  return {
    ...document,
    projectionDigest: createWorkspaceSearchProjectionDigest(document),
  }
}

/**
 * Creates the server-owned digest used by migration and live-writer CAS checks.
 *
 * Increment `digestVersion` and update pinned digest fixtures whenever the
 * canonicalization protocol changes.
 *
 * @param document - Fully normalized projection without its digest field.
 * @returns Lowercase SHA-256 digest of the versioned canonical projection.
 */
export function createWorkspaceSearchProjectionDigest(
  document: Readonly<Omit<WorkspaceSearchDocument, 'projectionDigest'>>,
): string {
  return createHash('sha256')
    .update(canonicalWorkspaceSearchProjectionValue({
      digestVersion: 1,
      document,
    }))
    .digest('hex')
}

/** Team source を runtime/backfill 共通の search document へ変換します。 */
export function createTeamWorkspaceSearchDocument(input: {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Canonical Team ID です。 */
  teamId: string
  /** Team の現在表示名です。 */
  title: string
  /** Team の補助表示名です。 */
  subtitle?: string
  /** Team row を作成した user ID です。 */
  creatorUserId?: string
  /** Team row の作成日時です。 */
  createdAt?: string
  /** Team row の最終更新日時です。 */
  updatedAt?: string
}) {
  return createWorkspaceSearchDocument({
    workspaceId: input.workspaceId,
    entityType: 'team',
    entityId: `team/${input.teamId}`,
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    url: `/teams/${encodeURIComponent(input.teamId)}/overview`,
    teamId: input.teamId,
    ...(input.creatorUserId ? { creatorUserId: input.creatorUserId } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  })
}

/** Project source を runtime/backfill 共通の search document へ変換します。 */
export function createProjectWorkspaceSearchDocument(input: {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Project owner の Team ID です。 */
  teamId: string
  /** Canonical Project ID です。 */
  projectId: string
  /** Project の現在表示名です。 */
  title: string
  /** Project の補助表示名です。 */
  subtitle?: string
  /** Project row を作成した user ID です。 */
  creatorUserId?: string
  /** Project row の作成日時です。 */
  createdAt?: string
  /** Project row の最終更新日時です。 */
  updatedAt?: string
}) {
  const query = new URLSearchParams({ teamId: input.teamId })
  return createWorkspaceSearchDocument({
    workspaceId: input.workspaceId,
    entityType: 'project',
    entityId: `team/${input.teamId}/project/${input.projectId}`,
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    url: `/projects/${encodeURIComponent(input.projectId)}/issues?${query.toString()}`,
    teamId: input.teamId,
    projectId: input.projectId,
    ...(input.creatorUserId ? { creatorUserId: input.creatorUserId } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  })
}

/**
 * Canonical Document / Whiteboard source を permission-aware search document へ変換します。
 *
 * @param workspaceId - Document を保持する canonical Workspace ID です。
 * @param document - Source of truth から取得した Document detail です。
 * @returns Workspace search index に保存する正規化済み document です。
 */
export function createDocumentWorkspaceSearchDocument(
  workspaceId: string,
  document: DocumentDetail,
) {
  const body = createDocumentWorkspaceSearchBody(document).slice(
    0,
    WORKSPACE_SEARCH_STORED_BODY_MAX_LENGTH,
  )
  return createDocumentWorkspaceSearchProjection(
    workspaceId,
    document,
    body,
  )
}

/**
 * Canonical Document の全文を current-source 検索用の一時 projection へ変換します。
 *
 * Search table に永続化する projection は
 * {@link createDocumentWorkspaceSearchDocument} を使います。この関数が返す全文本文は
 * source-of-truth ACL の検証後に memory 上で照合し、Search table へは保存しません。
 * Documents store は canonical mutation と同時に同じ本文を圧縮 projection へ保存します。
 *
 * @param workspaceId - Document を保持する canonical Workspace ID です。
 * @param document - ACL 検証済みの current Document detail です。
 * @returns Document 最大 payload の本文を省略しない検索用 document です。
 */
export function createDocumentWorkspaceSearchSourceDocument(
  workspaceId: string,
  document: DocumentDetail,
) {
  const body = createDocumentWorkspaceSearchBody(document)
  const storedProjection = createDocumentWorkspaceSearchProjection(
    workspaceId,
    document,
    body.slice(0, WORKSPACE_SEARCH_STORED_BODY_MAX_LENGTH),
  )
  return body
    ? { ...storedProjection, body }
    : storedProjection
}

/**
 * Canonical Document から省略しない Workspace search 本文を生成します。
 *
 * @param document - Source of truth の Document detail です。
 * @returns Rich text または Whiteboard text を連結した全文検索本文です。
 */
export function createDocumentWorkspaceSearchBody(
  document: DocumentDetail,
): string {
  return createDocumentSearchBody(document)
}

function createDocumentWorkspaceSearchProjection(
  workspaceId: string,
  document: DocumentDetail,
  body: string,
) {
  const relationIds = createDocumentSearchRelationIds(document)

  return createWorkspaceSearchDocument({
    workspaceId,
    entityType: 'document',
    entityId: document.id,
    title: document.title,
    subtitle: document.kind,
    ...(body ? { body } : {}),
    url: `/documents/${encodeURIComponent(document.id)}`,
    ...(document.scope.type === 'project'
      ? { projectId: document.scope.projectId }
      : {}),
    creatorUserId: document.createdByUserId,
    status: document.archivedAt ? 'archived' : 'active',
    customFields: {
      documentKind: document.kind,
      permissionMode: document.permission.mode,
    },
    ...(relationIds.length > 0 ? { relationIds } : {}),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    sourceRevision: document.revision,
  })
}

/** Canonical Work Item source を runtime/backfill 共通の search document へ変換します。 */
export function createWorkItemWorkspaceSearchDocument(input: {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Work Item owner の Team ID です。 */
  teamId: string
  /** Team 内の Work Item ID です。 */
  issueId: string
  /** Work Item の現在タイトルです。 */
  title: string
  /** Work Item の現在説明です。 */
  body?: string
  /** Work Item の現在 assigned Project ID です。 */
  projectId?: string
  /** Work Item の現在 assignee user ID です。 */
  assigneeUserId?: string
  /** Work Item の creator user ID です。 */
  creatorUserId?: string
  /** Work Item の現在 status です。 */
  status?: string
  /** Work Item の custom field values です。 */
  customFields?: Record<string, SearchCustomFieldValue>
  /** Work Item の relation IDs です。 */
  relationIds?: string[]
  /** Work Item の現在 due date です。 */
  dueDate?: string
  /** Work Item の作成日時です。 */
  createdAt?: string
  /** Work Item の最終更新日時です。 */
  updatedAt?: string
}) {
  const entityId = `team/${input.teamId}/issue/${input.issueId}`
  const query = new URLSearchParams({
    ...(input.projectId ? { teamId: input.teamId } : {}),
    issueId: input.issueId,
  })
  return createWorkspaceSearchDocument({
    workspaceId: input.workspaceId,
    entityType: 'work-item',
    entityId,
    title: input.title,
    subtitle: input.issueId,
    ...(input.body ? { body: input.body } : {}),
    url: input.projectId
      ? `/projects/${encodeURIComponent(input.projectId)}/issues?${query.toString()}`
      : `/teams/${encodeURIComponent(input.teamId)}/issues?${query.toString()}`,
    teamId: input.teamId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.assigneeUserId ? { assigneeUserId: input.assigneeUserId } : {}),
    ...(input.creatorUserId ? { creatorUserId: input.creatorUserId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.customFields ? { customFields: input.customFields } : {}),
    ...(input.relationIds ? { relationIds: input.relationIds } : {}),
    ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  })
}

function createDocumentSearchBody(document: DocumentDetail) {
  if (document.kind === 'page' || document.kind === 'template') {
    return document.blocks.map(createDocumentBlockSearchText).filter(Boolean).join('\n')
  }

  if (document.kind === 'whiteboard') {
    return [
      ...document.whiteboard.objects.map((object) => {
        if (object.type === 'work-item') return object.workItemId
        return object.text ?? ''
      }),
      ...document.whiteboard.connectors.map((connector) => connector.label ?? ''),
      ...document.whiteboard.frames.map((frame) => frame.title),
    ].filter(Boolean).join('\n')
  }

  return ''
}

function createDocumentBlockSearchText(block: DocumentBlock) {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return block.text
    case 'table':
      return [
        block.columns.join('\t'),
        ...block.rows.map((row) => row.cells.map((cell) => cell.text).join('\t')),
      ].join('\n')
    case 'code':
      return block.code
    case 'checklist':
      return block.items.map((item) => item.text).join('\n')
    case 'embed':
      return [block.title, block.provider, block.url].filter(Boolean).join('\n')
    case 'diagram':
      return block.source
  }
}

function createDocumentSearchRelationIds(document: DocumentDetail) {
  const relationIds = new Set(
    document.relations.map((relation) => createDocumentRelationTargetId(relation.target)),
  )

  if (document.kind === 'whiteboard') {
    for (const object of document.whiteboard.objects) {
      if (object.type === 'work-item') {
        relationIds.add(`work-item:${object.workItemId}`)
      }
    }
  }

  return [...relationIds].sort()
}

function createDocumentRelationTargetId(target: DocumentRelationTarget) {
  if (target.kind === 'work-item') return `work-item:${target.workItemId}`
  if (target.kind === 'project') return `project:${target.projectId}`
  return `goal:${target.goalId}`
}

/** Collaboration comment source を runtime/backfill 共通の search document へ変換します。 */
export function createCommentWorkspaceSearchDocument(input: {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Parent Work Item owner の Team ID です。 */
  teamId: string
  /** Parent Work Item ID です。 */
  issueId: string
  /** Canonical Comment ID です。 */
  commentId: string
  /** Root thread identifier that contains the comment. */
  rootCommentId?: string
  /** Comment の現在 Markdown 本文です。 */
  body: string
  /** Comment author の Workspace member key です。 */
  creatorUserId?: string
  /** Comment の作成日時です。 */
  createdAt?: string
  /** Comment の最終更新日時です。 */
  updatedAt?: string
  /** Canonical comment version used to order asynchronous projections. */
  sourceRevision?: number
}) {
  const parentId = `team/${input.teamId}/issue/${input.issueId}`
  const body = input.body.slice(0, WORKSPACE_SEARCH_STORED_BODY_MAX_LENGTH)
  const query = new URLSearchParams({
    issueId: input.issueId,
    commentId: input.commentId,
    rootCommentId: input.rootCommentId ?? input.commentId,
  })
  return createWorkspaceSearchDocument({
    workspaceId: input.workspaceId,
    entityType: 'comment',
    entityId: createCommentWorkspaceSearchEntityId(input.teamId, input.issueId, input.commentId),
    title: createCommentSearchTitle(body),
    ...(input.creatorUserId ? { subtitle: input.creatorUserId } : {}),
    body,
    url: `/teams/${encodeURIComponent(input.teamId)}/issues?${query.toString()}`,
    teamId: input.teamId,
    parentId,
    ...(input.creatorUserId ? { creatorUserId: input.creatorUserId } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {}),
  })
}

/** Converts a curated context item into a runtime/backfill Search document. */
export function createCuratedContextItemWorkspaceSearchDocument(input: {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Current canonical curated context item snapshot. */
  item: CuratedContextItem
  /** Current assigned Project identifier for the parent Work Item. */
  projectId?: string
}) {
  const parentId = `team/${input.item.teamId}/issue/${input.item.workItemId}`
  const query = new URLSearchParams({
    teamId: input.item.teamId,
    issueId: input.item.workItemId,
    contextItemId: input.item.id,
  })
  return createWorkspaceSearchDocument({
    workspaceId: input.workspaceId,
    entityType: 'context-item',
    entityId: `${parentId}/context-item/${input.item.id}`,
    title: input.item.title,
    subtitle: input.item.kind,
    body: input.item.body,
    url: input.projectId
      ? `/projects/${encodeURIComponent(input.projectId)}/issues?${query.toString()}`
      : `/teams/${encodeURIComponent(input.item.teamId)}/issues?${query.toString()}`,
    teamId: input.item.teamId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    parentId,
    creatorUserId: input.item.createdBy.id,
    status: input.item.state,
    createdAt: input.item.createdAt,
    updatedAt: input.item.updatedAt,
    sourceRevision: input.item.revision,
  })
}

/**
 * DynamoDB-backed Workspace search と saved view client です。
 */
export class DynamoDbWorkspaceSearchClient {
  /** Workspace search single-table 名です。 */
  private readonly tableName: string
  /** DynamoDB document client です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Local table bootstrap 用 low-level client です。 */
  private readonly dynamoDbClient: DynamoDBClient
  /** Local table がない場合に作成するかどうかです。 */
  private readonly bootstrapLocalTable: boolean
  /** Local table 初期化を client instance 内で共有する promise です。 */
  private localTableInitialization?: Promise<void>

  constructor(
    tableName = readEnvironment('WORKSPACE_SEARCH_TABLE_NAME') ??
      readEnvironment('MUKUROJI_WORKSPACE_SEARCH_TABLE') ??
      'mukuroji-workspace-search-local',
    documentClient?: DynamoDBDocumentClient,
    dynamoDbClient = createDynamoDbClient(),
    bootstrapLocalTable = documentClient === undefined && shouldBootstrapLocalTable(),
  ) {
    this.tableName = requireText(tableName, 'Workspace search table name')
    this.dynamoDbClient = dynamoDbClient
    this.documentClient = documentClient ??
      createWorkspaceSearchWriterDynamoDbDocumentClient(dynamoDbClient)
    this.bootstrapLocalTable = bootstrapLocalTable
  }

  /** Search document を idempotent に作成または置換します。 */
  async upsertDocument(
    input: Parameters<typeof createWorkspaceSearchDocument>[0] | WorkspaceSearchDocument,
    options?: WorkspaceSearchProjectionWriteOptions,
  ) {
    await this.ensureLocalTable()
    const document = createWorkspaceSearchDocument(input)
    const sourceRevision = normalizeProjectionSourceRevision(options?.sourceRevision)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [{
          Put: {
            TableName: this.tableName,
            Item: document,
            ...(sourceRevision === undefined
              ? {}
              : {
                  ConditionExpression:
                    'attribute_not_exists(#recordKey) OR attribute_not_exists(#sourceRevision) OR ' +
                    '#sourceRevision <= :sourceRevision',
                  ExpressionAttributeNames: {
                    '#recordKey': 'recordKey',
                    '#sourceRevision': 'sourceRevision',
                  },
                  ExpressionAttributeValues: { ':sourceRevision': sourceRevision },
                }),
          },
        }],
      }))
    } catch (error) {
      if (sourceRevision === undefined || !isTransactionConditionalCheckFailed(error)) {
        throw error
      }
    }
    return document
  }

  /**
   * Upserts a comment projection while atomically fencing it to the current
   * non-deleted canonical comment version.
   *
   * @param input - Search document to persist.
   * @param fence - Canonical Collaboration row and version observed by the caller.
   * @returns Whether the source was still current, or an existing newer projection was retained.
   */
  async upsertDocumentWithCommentSourceFence(
    input: Parameters<typeof createWorkspaceSearchDocument>[0] | WorkspaceSearchDocument,
    fence: WorkspaceSearchCommentProjectionFence,
  ): Promise<'projected' | 'source-changed'> {
    await this.ensureLocalTable()
    const document = createWorkspaceSearchDocument(input)
    const sourceRevision = normalizeProjectionSourceRevision(fence.sourceRevision)
    if (document.sourceRevision !== sourceRevision) {
      throw new WorkspaceSearchError(
        409,
        'InvalidSearchProjectionRevision',
        'Search comment projection revision does not match its source fence.',
      )
    }

    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: requireText(fence.sourceTableName, 'Search projection source table name'),
              Key: {
                entityKey: requireText(fence.sourceEntityKey, 'Search projection source entity key'),
                recordKey: `COMMENT#${requireText(fence.sourceCommentId, 'Search projection source comment ID')}`,
              },
              ConditionExpression:
                'attribute_exists(entityKey) AND attribute_exists(recordKey) AND ' +
                'attribute_not_exists(deletedAt) AND #version = :sourceRevision',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':sourceRevision': sourceRevision },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: document,
              ConditionExpression:
                'attribute_not_exists(#recordKey) OR attribute_not_exists(#sourceRevision) OR ' +
                '#sourceRevision <= :sourceRevision',
              ExpressionAttributeNames: {
                '#recordKey': 'recordKey',
                '#sourceRevision': 'sourceRevision',
              },
              ExpressionAttributeValues: { ':sourceRevision': sourceRevision },
            },
          },
        ],
      }))
      return 'projected'
    } catch (error) {
      if (isTransactionConditionalCheckFailedAt(error, 0)) {
        return 'source-changed'
      }
      if (isTransactionConditionalCheckFailedAt(error, 1)) {
        return 'projected'
      }
      throw error
    }
  }

  /** Search document を entity key で削除します。 */
  async deleteDocument(
    workspaceId: string,
    entityType: SearchEntityType,
    entityId: string,
    options?: WorkspaceSearchProjectionWriteOptions,
  ) {
    await this.ensureLocalTable()
    const sourceRevision = normalizeProjectionSourceRevision(options?.sourceRevision)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [{
          Delete: {
            TableName: this.tableName,
            Key: {
              workspaceId: requireText(workspaceId, 'Search Workspace ID'),
              recordKey: createWorkspaceSearchDocumentRecordKey(
                entityType,
                entityId,
              ),
            },
            ...(sourceRevision === undefined
              ? {}
              : {
                  ConditionExpression:
                    'attribute_not_exists(#sourceRevision) OR #sourceRevision <= :sourceRevision',
                  ExpressionAttributeNames: { '#sourceRevision': 'sourceRevision' },
                  ExpressionAttributeValues: { ':sourceRevision': sourceRevision },
                }),
          },
        }],
      }))
    } catch (error) {
      if (sourceRevision === undefined || !isTransactionConditionalCheckFailed(error)) {
        throw error
      }
    }
  }

  /** Composite filter、current RBAC、cursor pagination を適用して検索します。 */
  async search(input: WorkspaceSearchQueryInput): Promise<WorkspaceSearchResponse> {
    await this.ensureLocalTable()
    const workspaceId = requireText(input.workspaceId, 'Search Workspace ID')
    const viewerUserId = requireText(input.access.viewerUserId, 'Search viewer user ID')
    const filters = normalizeWorkspaceSearchFilters(input.filters ?? {})
    const limit = normalizeLimit(input.limit, WORKSPACE_SEARCH_DEFAULT_LIMIT, WORKSPACE_SEARCH_MAX_LIMIT)
    const queryFingerprint = createSearchQueryFingerprint(filters)
    const cursor = decodeSearchCursor(
      input.cursor,
      workspaceId,
      viewerUserId,
      queryFingerprint,
    )
    const results: WorkspaceSearchResult[] = []
    let exclusiveStartKey = cursor
      ? { workspaceId, recordKey: cursor.recordKey }
      : undefined
    let evaluated = 0
    let nextRecordKey: string | undefined
    let reachedLimit = false

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': WORKSPACE_SEARCH_DOCUMENT_PREFIX,
        },
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: true,
        Limit: Math.min(100, WORKSPACE_SEARCH_EVALUATION_LIMIT - evaluated),
      }))
      const documentRows = (response.Items ?? []).map((item) => ({
        document: readWorkspaceSearchDocumentSafely(item),
        recordKey: typeof item.recordKey === 'string' ? item.recordKey : undefined,
      }))
      let processedDocumentCount = 0
      let lastProcessedRecordKey: string | undefined

      for (
        let offset = 0;
        offset < documentRows.length && !reachedLimit;
        offset += WORKSPACE_SEARCH_SCOPE_CONCURRENCY
      ) {
        const batch = documentRows.slice(
          offset,
          offset + WORKSPACE_SEARCH_SCOPE_CONCURRENCY,
        )
        const currentDocuments = await mapWithConcurrency(
          batch,
          WORKSPACE_SEARCH_SCOPE_CONCURRENCY,
          async ({ document: storedDocument }) => {
            if (
              !storedDocument ||
              !matchesImmutableWorkspaceSearchFilters(
                storedDocument,
                filters,
              )
            ) {
              return undefined
            }
            const resolvedScope = input.resolveCurrentScope
              ? await input.resolveCurrentScope(storedDocument)
              : {
                  ...(storedDocument.teamId ? { teamId: storedDocument.teamId } : {}),
                  ...(storedDocument.projectId ? { projectId: storedDocument.projectId } : {}),
                }
            if (!resolvedScope) return undefined
            const document = applyResolvedWorkspaceSearchScope(
              resolvedScope.currentDocument ?? storedDocument,
              resolvedScope,
            )
            return canAccessWorkspaceSearchDocument(
              document,
              input.access,
              resolvedScope.permissionVerified === true,
            ) &&
                matchesWorkspaceSearchFilters(document, filters)
              ? document
              : undefined
          },
        )
        for (let index = 0; index < batch.length; index += 1) {
          const row = batch[index]
          if (!row) continue
          processedDocumentCount += 1
          evaluated += 1
          if (row.recordKey) lastProcessedRecordKey = row.recordKey
          const document = currentDocuments[index]
          if (!document) continue
          results.push(
            toWorkspaceSearchResult(
              document,
              filters.keyword,
            ),
          )
          if (results.length >= limit) {
            reachedLimit = true
            break
          }
        }
      }

      const responseLastRecordKey = typeof response.LastEvaluatedKey?.recordKey === 'string'
        ? response.LastEvaluatedKey.recordKey
        : undefined
      if (reachedLimit) {
        const hasUnprocessedRows = processedDocumentCount < documentRows.length || Boolean(responseLastRecordKey)
        nextRecordKey = hasUnprocessedRows ? lastProcessedRecordKey : undefined
        break
      }
      nextRecordKey = responseLastRecordKey
      exclusiveStartKey = response.LastEvaluatedKey as typeof exclusiveStartKey
    } while (
      results.length < limit &&
      nextRecordKey &&
      evaluated < WORKSPACE_SEARCH_EVALUATION_LIMIT
    )

    return {
      schemaVersion: SEARCH_SCHEMA_VERSION,
      results,
      ...(nextRecordKey
        ? {
            nextCursor: encodeCursor({
              version: 1,
              kind: 'search',
              workspaceId,
              viewerUserId,
              queryFingerprint,
              recordKey: nextRecordKey,
            } satisfies SearchCursor),
          }
        : {}),
    }
  }

  /** Current viewer が参照できる saved views を page 取得します。 */
  async listSavedViews(
    input: ListSavedWorkspaceViewsInput,
  ): Promise<SavedWorkspaceViewsResponse> {
    await this.ensureLocalTable()
    const workspaceId = requireText(input.workspaceId, 'Saved view Workspace ID')
    const viewerUserId = requireText(input.access.viewerUserId, 'Saved view viewer ID')
    const limit = normalizeLimit(input.limit, SAVED_VIEW_DEFAULT_LIMIT, SAVED_VIEW_MAX_LIMIT)
    const cursor = decodeSavedViewCursor(input.cursor, workspaceId, viewerUserId)
    const views: StoredSavedWorkspaceView[] = []
    let exclusiveStartKey = cursor
      ? { workspaceId, recordKey: cursor.recordKey }
      : undefined
    let nextRecordKey: string | undefined

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': WORKSPACE_SAVED_VIEW_PREFIX,
        },
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: true,
        Limit: limit,
      }))
      const items = response.Items ?? []
      for (const [itemIndex, item] of items.entries()) {
        const view = readStoredSavedWorkspaceView(item)
        if (canReadSavedView(view, input.access)) {
          views.push(view)
          if (views.length >= limit) {
            nextRecordKey = itemIndex < items.length - 1 || response.LastEvaluatedKey
              ? view.recordKey
              : undefined
            break
          }
        }
      }
      if (views.length < limit) {
        nextRecordKey = typeof response.LastEvaluatedKey?.recordKey === 'string'
          ? response.LastEvaluatedKey.recordKey
          : undefined
      }
      exclusiveStartKey = response.LastEvaluatedKey as typeof exclusiveStartKey
    } while (views.length < limit && nextRecordKey)

    const [preferences, defaultView] = await Promise.all([
      this.listViewerPreferences(workspaceId, viewerUserId),
      this.getDefaultView(workspaceId, viewerUserId),
    ])
    const preferenceByViewId = new Map(preferences.map((preference) => [preference.viewId, preference]))

    return {
      views: views.map((view) => toSavedWorkspaceView(
        view,
        preferenceByViewId.get(view.id),
        defaultView?.viewId === view.id,
        input.access,
        input.access.activeCustomFieldIds,
      )),
      ...(nextRecordKey
        ? {
            nextCursor: encodeCursor({
              version: 1,
              kind: 'saved-views',
              workspaceId,
              viewerUserId,
              recordKey: nextRecordKey,
            } satisfies SavedViewCursor),
          }
        : {}),
    }
  }

  /** Saved view definition と current viewer preference を作成します。 */
  async createSavedView(request: CreateSavedWorkspaceViewRequest) {
    await this.ensureLocalTable()
    requireSavedViewWriteAccess(request.access)
    const workspaceId = requireText(request.workspaceId, 'Saved view Workspace ID')
    const ownerUserId = requireText(request.access.viewerUserId, 'Saved view owner ID')
    const normalized = normalizeCreateSavedViewInput(request.input)
    requireCanCreateSavedView(normalized.visibility, normalized.teamId, request.access)
    const idempotencyKey = request.idempotencyKey === undefined
      ? undefined
      : requireText(request.idempotencyKey, 'Saved view idempotency key', 256)
    const createIdempotencyKeyHash = idempotencyKey
      ? createSavedViewIdempotencyHash(workspaceId, ownerUserId, idempotencyKey)
      : undefined
    const createRequestFingerprint = createIdempotencyKeyHash
      ? createHash('sha256').update(canonicalValue(normalized)).digest('base64url')
      : undefined
    const id = createIdempotencyKeyHash ?? randomUUID()
    const now = new Date().toISOString()
    const stored: StoredSavedWorkspaceView = {
      schemaVersion: SAVED_VIEW_SCHEMA_VERSION,
      workspaceId,
      recordKey: createSavedWorkspaceViewRecordKey(id),
      entryType: 'saved-view',
      id,
      name: normalized.name,
      ...(normalized.description ? { description: normalized.description } : {}),
      visibility: normalized.visibility,
      ownerUserId,
      ...(createIdempotencyKeyHash ? { createIdempotencyKeyHash } : {}),
      ...(createRequestFingerprint ? { createRequestFingerprint } : {}),
      ...(normalized.teamId ? { teamId: normalized.teamId } : {}),
      filters: normalized.filters,
      layout: normalized.layout,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    const preference = createStoredSavedViewPreference(
      workspaceId,
      ownerUserId,
      id,
      normalized.favorite ?? false,
      normalized.pinned ?? false,
      now,
    )
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: stored,
          ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        },
      },
      { Put: { TableName: this.tableName, Item: preference } },
    ]
    if (normalized.isDefault) {
      transactItems.push({
        Put: {
          TableName: this.tableName,
          Item: createStoredDefaultView(workspaceId, ownerUserId, id, now),
        },
      })
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      if (
        !createIdempotencyKeyHash ||
        !idempotencyKey ||
        !createRequestFingerprint ||
        !isTransactionConditionalCheckFailed(error)
      ) throw error
      const replay = await this.getRequiredSavedView(workspaceId, id)
      if (
        replay.ownerUserId !== ownerUserId ||
        replay.createIdempotencyKeyHash !== createIdempotencyKeyHash ||
        replay.createRequestFingerprint !== createRequestFingerprint
      ) {
        throw new WorkspaceSearchError(
          409,
          'SavedViewIdempotencyConflict',
          'Idempotency key was already used for another saved view request.',
        )
      }
      const [replayPreference, replayDefault] = await Promise.all([
        this.getViewerPreference(workspaceId, ownerUserId, id),
        this.getDefaultView(workspaceId, ownerUserId),
      ])
      return toSavedWorkspaceView(
        replay,
        replayPreference,
        replayDefault?.viewId === id,
        request.access,
        request.access.activeCustomFieldIds,
      )
    }
    return toSavedWorkspaceView(
      stored,
      preference,
      normalized.isDefault ?? false,
      request.access,
      request.access.activeCustomFieldIds,
    )
  }

  /** Saved view definition と current viewer preference を更新します。 */
  async updateSavedView(request: UpdateSavedWorkspaceViewRequest) {
    await this.ensureLocalTable()
    requireSavedViewWriteAccess(request.access)
    const workspaceId = requireText(request.workspaceId, 'Saved view Workspace ID')
    const viewId = requireIdentifier(request.viewId, 'Saved view ID')
    const current = await this.getRequiredSavedView(workspaceId, viewId)
    if (!canReadSavedView(current, request.access)) {
      throw new WorkspaceSearchError(404, 'SavedViewNotFound', 'Saved view was not found.')
    }
    const input = normalizeUpdateSavedViewInput(request.input)
    if (current.revision !== input.expectedRevision) {
      throw createSavedViewRevisionConflict()
    }
    const hasDefinitionChange = hasSavedViewDefinitionChange(input)
    const now = new Date().toISOString()
    const [existingPreference, existingDefaultView] = await Promise.all([
      this.getViewerPreference(workspaceId, request.access.viewerUserId, viewId),
      this.getDefaultView(workspaceId, request.access.viewerUserId),
    ])
    const preference = createStoredSavedViewPreference(
      workspaceId,
      request.access.viewerUserId,
      viewId,
      input.favorite ?? existingPreference?.favorite ?? false,
      input.pinned ?? existingPreference?.pinned ?? false,
      now,
    )
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = []
    let stored = current

    if (hasDefinitionChange) {
      requireCanEditSavedView(current, request.access)
      const visibility = input.visibility ?? current.visibility
      const teamId = input.teamId === null ? undefined : input.teamId ?? current.teamId
      validateVisibilityTeam(visibility, teamId)
      requireCanCreateSavedView(visibility, teamId, request.access)
      const names: Record<string, string> = {
        '#revision': 'revision',
        '#updatedAt': 'updatedAt',
      }
      const values: Record<string, unknown> = {
        ':expectedRevision': current.revision,
        ':nextRevision': current.revision + 1,
        ':updatedAt': now,
      }
      const sets = ['#revision = :nextRevision', '#updatedAt = :updatedAt']
      const removes: string[] = []
      addSavedViewUpdateExpression(input, names, values, sets, removes)
      transactItems.push({
        Update: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: current.recordKey },
          UpdateExpression: [
            `SET ${sets.join(', ')}`,
            removes.length ? `REMOVE ${removes.join(', ')}` : undefined,
          ].filter(Boolean).join(' '),
          ConditionExpression: '#revision = :expectedRevision',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      })
      stored = {
        ...current,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined
          ? {}
          : input.description === null
            ? { description: undefined }
            : { description: input.description }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        ...(input.teamId === undefined
          ? {}
          : input.teamId === null
            ? { teamId: undefined }
            : { teamId: input.teamId }),
        ...(input.filters === undefined ? {} : { filters: input.filters }),
        ...(input.layout === undefined ? {} : { layout: input.layout }),
        revision: current.revision + 1,
        updatedAt: now,
      }
    } else {
      transactItems.push({
        ConditionCheck: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: current.recordKey },
          ConditionExpression: '#revision = :expectedRevision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':expectedRevision': current.revision },
        },
      })
    }

    transactItems.push(createSavedViewPreferenceUpdateTransactionItem(
      this.tableName,
      preference,
      input.favorite,
      input.pinned,
    ))
    let isDefault = existingDefaultView?.viewId === viewId
    if (input.isDefault === true) {
      transactItems.push({
        Put: {
          TableName: this.tableName,
          Item: createStoredDefaultView(
            workspaceId,
            request.access.viewerUserId,
            viewId,
            now,
          ),
        },
      })
      isDefault = true
    } else if (input.isDefault === false) {
      transactItems.push(createDefaultViewGuardTransactionItem(
        this.tableName,
        workspaceId,
        request.access.viewerUserId,
        viewId,
        existingDefaultView,
      ))
      isDefault = false
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      if (isTransactionConditionalCheckFailed(error)) {
        throw createSavedViewRevisionConflict()
      }
      throw error
    }
    return toSavedWorkspaceView(
      stored,
      preference,
      isDefault,
      request.access,
      request.access.activeCustomFieldIds,
    )
  }

  /** Saved view definition を revision 条件付きで削除します。 */
  async deleteSavedView(request: DeleteSavedWorkspaceViewRequest) {
    await this.ensureLocalTable()
    requireSavedViewWriteAccess(request.access)
    const workspaceId = requireText(request.workspaceId, 'Saved view Workspace ID')
    const viewId = requireIdentifier(request.viewId, 'Saved view ID')
    const expectedRevision = requirePositiveInteger(request.expectedRevision, 'Saved view revision')
    const current = await this.getRequiredSavedView(workspaceId, viewId)
    if (!canReadSavedView(current, request.access)) {
      throw new WorkspaceSearchError(404, 'SavedViewNotFound', 'Saved view was not found.')
    }
    requireCanEditSavedView(current, request.access)
    const defaultView = await this.getDefaultView(workspaceId, request.access.viewerUserId)
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: current.recordKey },
          ConditionExpression: '#revision = :expectedRevision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
        },
      },
      {
        Delete: {
          TableName: this.tableName,
          Key: {
            workspaceId,
            recordKey: createSavedViewPreferenceRecordKey(request.access.viewerUserId, viewId),
          },
        },
      },
    ]
    transactItems.push(createDefaultViewGuardTransactionItem(
      this.tableName,
      workspaceId,
      request.access.viewerUserId,
      viewId,
      defaultView,
    ))
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      if (isTransactionConditionalCheckFailed(error)) {
        throw createSavedViewRevisionConflict()
      }
      throw error
    }
    return { id: viewId, revision: expectedRevision }
  }

  /**
   * Lists task views visible to the current viewer within optional surface and scope filters.
   *
   * @param input - Workspace, viewer access, filters, and cursor for the requested page.
   * @returns A permission-filtered cursor page of sanitized task views.
   */
  async listTaskViews(input: ListTaskViewsInput): Promise<SavedTaskViewsResponse> {
    await this.ensureLocalTable()
    const workspaceId = requireText(input.workspaceId, 'Task view Workspace ID')
    const viewerUserId = requireText(input.access.viewerUserId, 'Task view viewer ID')
    const surface = input.surface === undefined
      ? undefined
      : requireTaskViewSurface(input.surface)
    const scope = input.scope === undefined ? undefined : normalizeTaskViewScope(input.scope)
    if (surface && scope) validateTaskViewSurfaceScope(surface, scope)
    if (scope && !canAccessTaskViewScope(scope, input.access)) {
      throw new WorkspaceSearchError(403, 'TaskViewAccessDenied', 'Task view scope access is denied.')
    }
    const limit = normalizeLimit(input.limit, TASK_VIEW_DEFAULT_LIMIT, TASK_VIEW_MAX_LIMIT)
    const queryFingerprint = createTaskViewListFingerprint(surface, scope)
    const cursor = decodeTaskViewCursor(
      input.cursor,
      workspaceId,
      viewerUserId,
      queryFingerprint,
    )
    const views: StoredTaskView[] = []
    let exclusiveStartKey = cursor
      ? { workspaceId, recordKey: cursor.recordKey }
      : undefined
    let nextRecordKey: string | undefined

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': WORKSPACE_TASK_VIEW_PREFIX,
        },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: true,
        Limit: limit,
      }))
      const items = response.Items ?? []
      let lastProcessedRecordKey: string | undefined
      for (const [itemIndex, item] of items.entries()) {
        const view = readStoredTaskView(item)
        lastProcessedRecordKey = view.recordKey
        if (
          matchesTaskViewListFilter(view, surface, scope) &&
          canReadTaskView(view, input.access)
        ) {
          views.push(view)
          if (views.length >= limit) {
            nextRecordKey = itemIndex < items.length - 1 || response.LastEvaluatedKey
              ? lastProcessedRecordKey
              : undefined
            break
          }
        }
      }
      if (views.length < limit) {
        nextRecordKey = typeof response.LastEvaluatedKey?.recordKey === 'string'
          ? response.LastEvaluatedKey.recordKey
          : undefined
      }
      exclusiveStartKey = typeof response.LastEvaluatedKey?.recordKey === 'string'
        ? { workspaceId, recordKey: response.LastEvaluatedKey.recordKey }
        : undefined
    } while (views.length < limit && nextRecordKey)

    const retainedPreferences = (await mapWithConcurrency(
      views,
      TASK_VIEW_ORPHAN_CLEANUP_LIMIT,
      (view) => this.getTaskViewPreference(workspaceId, viewerUserId, view.id),
    )).filter((preference) => preference !== undefined)
    const preferenceByViewId = new Map(
      retainedPreferences.map((preference) => [preference.viewId, preference]),
    )
    const defaultByContext = new Map<string, Promise<ResolvedTaskViewDefault>>()
    const responseViews = await mapWithConcurrency(views, 1, async (view) => {
      const contextKey = createTaskViewContextKey(view.definition.surface, view.definition.scope)
      let resolvedDefault = defaultByContext.get(contextKey)
      if (!resolvedDefault) {
        resolvedDefault = this.resolveTaskViewDefault(
          workspaceId,
          view.definition.surface,
          view.definition.scope,
          input.access,
        )
        defaultByContext.set(contextKey, resolvedDefault)
      }
      return toSavedTaskView(
        view,
        preferenceByViewId.get(view.id),
        await resolvedDefault,
        input.access,
      )
    })

    return {
      capabilities: createTaskViewListCapabilities(surface, scope, input.access),
      views: responseViews,
      ...(nextRecordKey
        ? {
            nextCursor: encodeCursor({
              version: 1,
              kind: 'task-views',
              workspaceId,
              viewerUserId,
              queryFingerprint,
              recordKey: nextRecordKey,
            } satisfies TaskViewCursor),
          }
        : {}),
    }
  }

  /**
   * Reads one task view by ID without disclosing inaccessible definitions.
   *
   * @param request - Workspace, stable view ID, and current viewer access.
   * @returns The sanitized task view with resolved current-viewer preference state.
   */
  async getTaskView(request: GetTaskViewRequest): Promise<SavedTaskView> {
    await this.ensureLocalTable()
    const workspaceId = requireText(request.workspaceId, 'Task view Workspace ID')
    const viewId = requireIdentifier(request.viewId, 'Task view ID')
    const viewerUserId = requireText(request.access.viewerUserId, 'Task view viewer ID')
    const stored = await this.getTaskViewIfPresent(workspaceId, viewId)
    if (!stored) {
      await this.cleanupMissingTaskViewState(workspaceId, viewerUserId, viewId)
      throw createTaskViewNotFound()
    }
    if (!canReadTaskView(stored, request.access)) {
      throw createTaskViewNotFound()
    }
    const [preference, resolvedDefault] = await Promise.all([
      this.getTaskViewPreference(workspaceId, viewerUserId, viewId),
      this.resolveTaskViewDefault(
        workspaceId,
        stored.definition.surface,
        stored.definition.scope,
        request.access,
      ),
    ])
    return toSavedTaskView(stored, preference, resolvedDefault, request.access)
  }

  /**
   * Creates a task view definition and the current viewer's initial preference.
   *
   * @param request - Authorized create input and optional idempotency key.
   * @returns The newly persisted task view in its current viewer representation.
   */
  async createTaskView(request: CreateTaskViewRequest): Promise<SavedTaskView> {
    return this.createTaskViewWithFingerprint(request)
  }

  /**
   * Creates a task view while allowing another operation to bind retries to its stable request.
   *
   * @param request - Authorized create input and optional idempotency key.
   * @param requestFingerprintInput - Stable operation input used instead of the derived view body.
   * @returns The newly persisted or idempotently replayed task view.
   */
  private async createTaskViewWithFingerprint(
    request: CreateTaskViewRequest,
    requestFingerprintInput?: unknown,
  ): Promise<SavedTaskView> {
    await this.ensureLocalTable()
    requireTaskViewWriteAccess(request.access)
    const workspaceId = requireText(request.workspaceId, 'Task view Workspace ID')
    const ownerUserId = requireText(request.access.viewerUserId, 'Task view owner ID')
    const normalized = normalizeCreateTaskViewInput(request.input)
    requireCanCreateTaskView(
      normalized.visibility,
      normalized.teamId,
      normalized.definition,
      request.access,
    )
    requireCanSetTaskViewDefault(
      normalized.defaultSource,
      normalized.visibility,
      normalized.teamId,
      normalized.definition,
      request.access,
    )
    const idempotencyKey = request.idempotencyKey === undefined
      ? undefined
      : requireText(request.idempotencyKey, 'Task view idempotency key', 256)
    const createIdempotencyKeyHash = idempotencyKey
      ? createTaskViewIdempotencyHash(workspaceId, ownerUserId, idempotencyKey)
      : undefined
    const createRequestFingerprint = createIdempotencyKeyHash
      ? createTaskViewRequestFingerprint(requestFingerprintInput ?? normalized)
      : undefined
    const id = createIdempotencyKeyHash ?? randomUUID()
    const now = new Date().toISOString()
    const stored: StoredTaskView = {
      schemaVersion: TASK_VIEW_SCHEMA_VERSION,
      workspaceId,
      recordKey: createTaskViewRecordKey(id),
      entryType: 'task-view',
      id,
      name: normalized.name,
      ...(normalized.description ? { description: normalized.description } : {}),
      visibility: normalized.visibility,
      ownerUserId,
      ...(createIdempotencyKeyHash ? { createIdempotencyKeyHash } : {}),
      ...(createRequestFingerprint ? { createRequestFingerprint } : {}),
      ...(normalized.teamId ? { teamId: normalized.teamId } : {}),
      definition: normalized.definition,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    const preference = createStoredTaskViewPreference(
      workspaceId,
      ownerUserId,
      id,
      normalized.favorite ?? false,
      normalized.pinned ?? false,
      now,
    )
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: stored,
          ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        },
      },
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: {
            workspaceId,
            recordKey: createTaskViewTombstoneRecordKey(id),
          },
          ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        },
      },
      { Put: { TableName: this.tableName, Item: preference } },
    ]
    if (normalized.defaultSource) {
      transactItems.push({
        Put: {
          TableName: this.tableName,
          Item: createStoredTaskViewDefault(
            workspaceId,
            normalized.defaultSource,
            ownerUserId,
            normalized.teamId,
            normalized.definition.surface,
            normalized.definition.scope,
            id,
            now,
          ),
        },
      })
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      if (
        !createIdempotencyKeyHash ||
        !idempotencyKey ||
        !createRequestFingerprint ||
        !isTransactionConditionalCheckFailed(error)
      ) throw error
      const replay = await this.getTaskViewIdempotencyReplay(
        workspaceId,
        ownerUserId,
        idempotencyKey,
        createRequestFingerprint,
        request.access,
      )
      if (replay) return replay
      throw error
    }
    const resolvedDefault = await this.resolveTaskViewDefault(
      workspaceId,
      stored.definition.surface,
      stored.definition.scope,
      request.access,
    )
    return toSavedTaskView(stored, preference, resolvedDefault, request.access)
  }

  /**
   * Updates a task view definition or the current viewer's preference.
   *
   * @param request - Revision-guarded definition and preference changes.
   * @returns The updated and read-time-sanitized task view.
   */
  async updateTaskView(request: UpdateTaskViewRequest): Promise<SavedTaskView> {
    await this.ensureLocalTable()
    requireTaskViewWriteAccess(request.access)
    const workspaceId = requireText(request.workspaceId, 'Task view Workspace ID')
    const viewId = requireIdentifier(request.viewId, 'Task view ID')
    const actorUserId = requireText(request.access.viewerUserId, 'Task view actor ID')
    const input = normalizeUpdateTaskViewInput(request.input)
    const idempotencyKey = request.idempotencyKey === undefined
      ? undefined
      : requireText(request.idempotencyKey, 'Task view idempotency key', 256)
    const idempotencyKeyHash = idempotencyKey
      ? createTaskViewMutationIdempotencyHash(
          workspaceId,
          actorUserId,
          'update',
          viewId,
          idempotencyKey,
        )
      : undefined
    const requestFingerprint = idempotencyKeyHash
      ? createTaskViewRequestFingerprint({ operation: 'update-task-view', viewId, input })
      : undefined
    if (idempotencyKeyHash && requestFingerprint) {
      const replay = await this.getTaskViewMutationReplayReceipt(
        workspaceId,
        'update',
        viewId,
        actorUserId,
        idempotencyKeyHash,
        requestFingerprint,
      )
      if (replay) return this.getTaskView({ workspaceId, viewId, access: request.access })
    }
    const current = await this.getRequiredTaskView(workspaceId, viewId)
    if (!canReadTaskView(current, request.access)) throw createTaskViewNotFound()
    requireTaskViewScopeWriteAccess(current.definition.scope, request.access)
    if (current.revision !== input.expectedRevision) throw createTaskViewRevisionConflict()
    const hasDefinitionChange = hasTaskViewDefinitionChange(input)
    const now = new Date().toISOString()
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = []
    let stored = current
    const visibility = input.visibility ?? current.visibility
    const teamId = input.teamId === null ? undefined : input.teamId ?? current.teamId
    const definition = input.definition ?? current.definition
    const defaultContextChanged =
      visibility !== current.visibility ||
      teamId !== current.teamId ||
      definition.surface !== current.definition.surface ||
      !taskViewScopesEqual(definition.scope, current.definition.scope)
    const [existingPreference, previousPersonalDefault, previousTeamDefault] = await Promise.all([
      this.getTaskViewPreference(workspaceId, actorUserId, viewId),
      defaultContextChanged
        ? this.getTaskViewDefault(
            workspaceId,
            'personal',
            actorUserId,
            undefined,
            current.definition.surface,
            current.definition.scope,
          )
        : Promise.resolve(undefined),
      defaultContextChanged && current.teamId
        ? this.getTaskViewDefault(
            workspaceId,
            'team',
            actorUserId,
            current.teamId,
            current.definition.surface,
            current.definition.scope,
          )
        : Promise.resolve(undefined),
    ])
    const preference = createStoredTaskViewPreference(
      workspaceId,
      actorUserId,
      viewId,
      input.favorite ?? existingPreference?.favorite ?? false,
      input.pinned ?? existingPreference?.pinned ?? false,
      now,
    )

    if (hasDefinitionChange) {
      requireCanEditTaskView(current, request.access)
      requireCanCreateTaskView(visibility, teamId, definition, request.access)
      const names: Record<string, string> = {
        '#entryType': 'entryType',
        '#revision': 'revision',
        '#updatedAt': 'updatedAt',
      }
      const values: Record<string, unknown> = {
        ':entryType': 'task-view',
        ':expectedRevision': current.revision,
        ':nextRevision': current.revision + 1,
        ':updatedAt': now,
      }
      const sets = ['#revision = :nextRevision', '#updatedAt = :updatedAt']
      const removes: string[] = []
      addTaskViewUpdateExpression(input, names, values, sets, removes)
      transactItems.push({
        Update: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: current.recordKey },
          UpdateExpression: [
            `SET ${sets.join(', ')}`,
            removes.length ? `REMOVE ${removes.join(', ')}` : undefined,
          ].filter(Boolean).join(' '),
          ConditionExpression: '#revision = :expectedRevision AND #entryType = :entryType',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      })
      stored = {
        ...current,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined
          ? {}
          : input.description === null
            ? { description: undefined }
            : { description: input.description }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        ...(input.teamId === undefined
          ? {}
          : input.teamId === null
            ? { teamId: undefined }
            : { teamId: input.teamId }),
        ...(input.definition === undefined ? {} : { definition: input.definition }),
        revision: current.revision + 1,
        updatedAt: now,
      }
    } else {
      transactItems.push({
        ConditionCheck: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: current.recordKey },
          ConditionExpression: '#revision = :expectedRevision AND #entryType = :entryType',
          ExpressionAttributeNames: { '#revision': 'revision', '#entryType': 'entryType' },
          ExpressionAttributeValues: {
            ':expectedRevision': current.revision,
            ':entryType': 'task-view',
          },
        },
      })
    }

    transactItems.push(createTaskViewPreferenceUpdateTransactionItem(
      this.tableName,
      preference,
      input.favorite,
      input.pinned,
    ))
    const nextDefaultRecordKey = input.defaultSource === 'personal' ||
        input.defaultSource === 'team'
      ? createTaskViewDefaultRecordKey(
          input.defaultSource,
          actorUserId,
          teamId,
          definition.surface,
          definition.scope,
        )
      : undefined
    const previousDefaultRecordKeysToDelete = new Set<string>()
    for (const previousDefault of [previousPersonalDefault, previousTeamDefault]) {
      if (
        previousDefault?.viewId === viewId &&
        previousDefault.recordKey !== nextDefaultRecordKey
      ) {
        transactItems.push(createTaskViewDefaultGuardTransactionItem(
          this.tableName,
          workspaceId,
          previousDefault.ownerType,
          actorUserId,
          previousDefault.teamId,
          previousDefault.surface,
          previousDefault.scope,
          viewId,
          previousDefault,
        ))
        previousDefaultRecordKeysToDelete.add(previousDefault.recordKey)
      }
    }
    if (input.defaultSource === 'personal' || input.defaultSource === 'team') {
      requireCanSetTaskViewDefault(
        input.defaultSource,
        visibility,
        teamId,
        definition,
        request.access,
      )
      transactItems.push({
        Put: {
          TableName: this.tableName,
          Item: createStoredTaskViewDefault(
            workspaceId,
            input.defaultSource,
            request.access.viewerUserId,
            teamId,
            definition.surface,
            definition.scope,
            viewId,
            now,
          ),
        },
      })
    } else if (input.defaultSource === null || input.clearDefaultSource !== undefined) {
      const [personalDefault, teamDefault] = await Promise.all([
        this.getTaskViewDefault(
          workspaceId,
          'personal',
          request.access.viewerUserId,
          undefined,
          definition.surface,
          definition.scope,
        ),
        teamId
          ? this.getTaskViewDefault(
              workspaceId,
              'team',
              request.access.viewerUserId,
              teamId,
              definition.surface,
              definition.scope,
            )
          : Promise.resolve(undefined),
      ])
      const sourceToClear = input.clearDefaultSource ?? (
        personalDefault?.viewId === viewId ? 'personal' : 'team'
      )
      if (
        sourceToClear === 'team' &&
        (!teamId ||
          (!request.access.isSystemAdmin && !request.access.manageableTeamIds.has(teamId)))
      ) {
        throw new WorkspaceSearchError(
          403,
          'TaskViewAccessDenied',
          'Team task view default management is denied.',
        )
      }
      if (
        sourceToClear === 'personal' &&
        personalDefault?.viewId === viewId &&
        !previousDefaultRecordKeysToDelete.has(personalDefault.recordKey)
      ) {
        transactItems.push(createTaskViewDefaultGuardTransactionItem(
          this.tableName,
          workspaceId,
          'personal',
          request.access.viewerUserId,
          undefined,
          definition.surface,
          definition.scope,
          viewId,
          personalDefault,
        ))
      } else if (
        sourceToClear === 'team' &&
        teamId &&
        teamDefault?.viewId === viewId &&
        !previousDefaultRecordKeysToDelete.has(teamDefault.recordKey) &&
        (request.access.isSystemAdmin || request.access.manageableTeamIds.has(teamId))
      ) {
        transactItems.push(createTaskViewDefaultGuardTransactionItem(
          this.tableName,
          workspaceId,
          'team',
          request.access.viewerUserId,
          teamId,
          definition.surface,
          definition.scope,
          viewId,
          teamDefault,
        ))
      }
    }

    const mutationReceipt = idempotencyKeyHash && requestFingerprint
      ? createStoredTaskViewMutationReceipt(
          workspaceId,
          'update',
          viewId,
          actorUserId,
          idempotencyKeyHash,
          requestFingerprint,
          stored.revision,
          now,
        )
      : undefined
    if (mutationReceipt) {
      transactItems.push(createTaskViewMutationReceiptTransactionItem(
        this.tableName,
        mutationReceipt,
      ))
    }

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      if (isTransactionConditionalCheckFailed(error)) {
        if (idempotencyKeyHash && requestFingerprint) {
          const replay = await this.getTaskViewMutationReplayReceipt(
            workspaceId,
            'update',
            viewId,
            actorUserId,
            idempotencyKeyHash,
            requestFingerprint,
          )
          if (replay) return this.getTaskView({ workspaceId, viewId, access: request.access })
        }
        throw createTaskViewRevisionConflict()
      }
      throw error
    }
    const resolvedDefault = await this.resolveTaskViewDefault(
      workspaceId,
      stored.definition.surface,
      stored.definition.scope,
      request.access,
    )
    return toSavedTaskView(stored, preference, resolvedDefault, request.access)
  }

  /**
   * Duplicates one accessible task view into an independent lifecycle.
   *
   * @param request - Source view, destination metadata, and optional idempotency key.
   * @returns The independent duplicated task view.
   */
  async duplicateTaskView(request: DuplicateTaskViewRequest): Promise<SavedTaskView> {
    await this.ensureLocalTable()
    requireTaskViewWriteAccess(request.access)
    const workspaceId = requireText(request.workspaceId, 'Task view Workspace ID')
    const sourceViewId = requireIdentifier(request.sourceViewId, 'Task view source ID')
    const input = normalizeDuplicateTaskViewInput(request.input)
    const ownerUserId = requireText(request.access.viewerUserId, 'Task view owner ID')
    const duplicateFingerprintInput = {
      operation: 'duplicate-task-view',
      sourceViewId,
      input,
    }
    const idempotencyKey = request.idempotencyKey === undefined
      ? undefined
      : createHash('sha256')
          .update(`duplicate\0${sourceViewId}\0${requireText(
            request.idempotencyKey,
            'Task view idempotency key',
            256,
          )}`)
          .digest('base64url')
    if (idempotencyKey) {
      const replay = await this.getTaskViewIdempotencyReplay(
        workspaceId,
        ownerUserId,
        idempotencyKey,
        createTaskViewRequestFingerprint(duplicateFingerprintInput),
        request.access,
      )
      if (replay) return replay
    }
    const source = await this.getTaskView({
      workspaceId,
      viewId: sourceViewId,
      access: request.access,
    })
    requireTaskViewScopeWriteAccess(source.definition.scope, request.access)
    const visibility = input.visibility ?? source.visibility
    const teamId = visibility === 'team'
      ? input.teamId === null ? undefined : input.teamId ?? source.teamId
      : input.teamId === undefined || input.teamId === null ? undefined : input.teamId
    const description = input.description === undefined
      ? source.description
      : input.description ?? undefined
    return this.createTaskViewWithFingerprint({
      workspaceId,
      access: request.access,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      input: {
        name: input.name ?? createTaskViewCopyName(source.name),
        ...(description ? { description } : {}),
        visibility,
        ...(teamId ? { teamId } : {}),
        definition: source.definition,
        ...(input.favorite === undefined ? {} : { favorite: input.favorite }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
        ...(input.defaultSource === undefined ? {} : { defaultSource: input.defaultSource }),
      },
    }, duplicateFingerprintInput)
  }

  /**
   * Deletes a task view definition under an optimistic revision guard.
   *
   * @param request - Authorized target ID and expected definition revision.
   * @returns The deleted view identity and acknowledged revision.
   */
  async deleteTaskView(request: DeleteTaskViewRequest) {
    await this.ensureLocalTable()
    requireTaskViewWriteAccess(request.access)
    const workspaceId = requireText(request.workspaceId, 'Task view Workspace ID')
    const viewId = requireIdentifier(request.viewId, 'Task view ID')
    const actorUserId = requireText(request.access.viewerUserId, 'Task view actor ID')
    const expectedRevision = requirePositiveInteger(request.expectedRevision, 'Task view revision')
    const idempotencyKey = request.idempotencyKey === undefined
      ? undefined
      : requireText(request.idempotencyKey, 'Task view idempotency key', 256)
    const idempotencyKeyHash = idempotencyKey
      ? createTaskViewMutationIdempotencyHash(
          workspaceId,
          actorUserId,
          'delete',
          viewId,
          idempotencyKey,
        )
      : undefined
    const requestFingerprint = idempotencyKeyHash
      ? createTaskViewRequestFingerprint({
          operation: 'delete-task-view',
          viewId,
          expectedRevision,
        })
      : undefined
    if (idempotencyKeyHash && requestFingerprint) {
      const replay = await this.getTaskViewMutationReplayReceipt(
        workspaceId,
        'delete',
        viewId,
        actorUserId,
        idempotencyKeyHash,
        requestFingerprint,
      )
      if (replay) return { id: replay.viewId, revision: replay.resultRevision }
    }
    const current = await this.getRequiredTaskView(workspaceId, viewId)
    if (!canReadTaskView(current, request.access)) throw createTaskViewNotFound()
    requireCanEditTaskView(current, request.access)
    const context = current.definition
    const tombstone: StoredTaskViewTombstone = {
      schemaVersion: TASK_VIEW_SCHEMA_VERSION,
      workspaceId,
      recordKey: createTaskViewTombstoneRecordKey(current.id),
      entryType: TASK_VIEW_TOMBSTONE_ENTRY_TYPE,
      id: current.id,
      revision: current.revision,
      ...(current.createIdempotencyKeyHash
        ? { createIdempotencyKeyHash: current.createIdempotencyKeyHash }
        : {}),
      ...(current.createRequestFingerprint
        ? { createRequestFingerprint: current.createRequestFingerprint }
        : {}),
      deletedAt: new Date().toISOString(),
    }
    const [personalDefault, teamDefault] = await Promise.all([
      this.getTaskViewDefault(
        workspaceId,
        'personal',
        request.access.viewerUserId,
        undefined,
        context.surface,
        context.scope,
      ),
      current.teamId
        ? this.getTaskViewDefault(
            workspaceId,
            'team',
            request.access.viewerUserId,
            current.teamId,
            context.surface,
            context.scope,
          )
        : Promise.resolve(undefined),
    ])
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: current.recordKey },
          ConditionExpression: '#revision = :expectedRevision AND #entryType = :entryType',
          ExpressionAttributeNames: { '#revision': 'revision', '#entryType': 'entryType' },
          ExpressionAttributeValues: {
            ':expectedRevision': expectedRevision,
            ':entryType': 'task-view',
          },
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: tombstone,
          ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        },
      },
      {
        Delete: {
          TableName: this.tableName,
          Key: {
            workspaceId,
            recordKey: createTaskViewPreferenceRecordKey(
              request.access.viewerUserId,
              viewId,
            ),
          },
        },
      },
      createTaskViewDefaultGuardTransactionItem(
        this.tableName,
        workspaceId,
        'personal',
        request.access.viewerUserId,
        undefined,
        context.surface,
        context.scope,
        viewId,
        personalDefault,
      ),
    ]
    if (
      current.teamId &&
      (request.access.isSystemAdmin || request.access.manageableTeamIds.has(current.teamId))
    ) {
      transactItems.push(createTaskViewDefaultGuardTransactionItem(
        this.tableName,
        workspaceId,
        'team',
        request.access.viewerUserId,
        current.teamId,
        context.surface,
        context.scope,
        viewId,
        teamDefault,
      ))
    }
    if (idempotencyKeyHash && requestFingerprint) {
      transactItems.push(createTaskViewMutationReceiptTransactionItem(
        this.tableName,
        createStoredTaskViewMutationReceipt(
          workspaceId,
          'delete',
          viewId,
          actorUserId,
          idempotencyKeyHash,
          requestFingerprint,
          expectedRevision,
          tombstone.deletedAt,
        ),
      ))
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      if (isTransactionConditionalCheckFailed(error)) {
        if (idempotencyKeyHash && requestFingerprint) {
          const replay = await this.getTaskViewMutationReplayReceipt(
            workspaceId,
            'delete',
            viewId,
            actorUserId,
            idempotencyKeyHash,
            requestFingerprint,
          )
          if (replay) return { id: replay.viewId, revision: replay.resultRevision }
        }
        throw createTaskViewRevisionConflict()
      }
      throw error
    }
    try {
      await this.cleanupTaskViewPreferences(workspaceId, viewId)
    } catch (error) {
      // The live row, tombstone, and optional receipt are already committed. Keep the
      // acknowledged delete result stable when this best-effort cleanup is unavailable.
      console.error('Task view preference cleanup failed after deletion commit.', {
        error,
        viewId,
        workspaceId,
      })
    }
    return { id: viewId, revision: expectedRevision }
  }

  /** Local DynamoDB 用 search table を必要に応じて作成します。 */
  private async ensureLocalTable() {
    if (!this.bootstrapLocalTable) {
      return
    }
    this.localTableInitialization ??= ensureLocalWorkspaceSearchTable(
      this.tableName,
      this.dynamoDbClient,
    ).catch((error) => {
      this.localTableInitialization = undefined
      throw error
    })
    await this.localTableInitialization
  }

  private async getRequiredSavedView(workspaceId: string, viewId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: createSavedWorkspaceViewRecordKey(viewId) },
      ConsistentRead: true,
    }))
    if (!response.Item) {
      throw new WorkspaceSearchError(404, 'SavedViewNotFound', 'Saved view was not found.')
    }
    return readStoredSavedWorkspaceView(response.Item)
  }

  private async listViewerPreferences(workspaceId: string, userId: string) {
    const prefix = createSavedViewPreferencePrefix(userId)
    const preferences: StoredSavedViewPreference[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':workspaceId': workspaceId, ':prefix': prefix },
        ExclusiveStartKey: exclusiveStartKey,
      }))
      preferences.push(...(response.Items ?? []).map(readStoredSavedViewPreference))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return preferences
  }

  private async getViewerPreference(workspaceId: string, userId: string, viewId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: createSavedViewPreferenceRecordKey(userId, viewId) },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredSavedViewPreference(response.Item) : undefined
  }

  private async getDefaultView(workspaceId: string, userId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: createSavedViewDefaultRecordKey(userId) },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredDefaultView(response.Item) : undefined
  }

  /** Strongly reads a live task view definition when one exists. */
  private async getTaskViewIfPresent(workspaceId: string, viewId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: createTaskViewRecordKey(viewId) },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredTaskView(response.Item) : undefined
  }

  /** Strongly reads a task view deletion tombstone when one exists. */
  private async getTaskViewTombstoneIfPresent(workspaceId: string, viewId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: createTaskViewTombstoneRecordKey(viewId) },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredTaskViewTombstone(response.Item) : undefined
  }

  /**
   * Strongly reads and validates a task view mutation receipt when one exists.
   *
   * @param workspaceId - Workspace that owns the receipt.
   * @param idempotencyKeyHash - Operation-bound receipt identity hash.
   * @returns The durable receipt, or undefined when the caller key is unused.
   */
  private async getTaskViewMutationReceipt(
    workspaceId: string,
    idempotencyKeyHash: string,
  ) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId,
        recordKey: createTaskViewMutationReceiptRecordKey(idempotencyKeyHash),
      },
      ConsistentRead: true,
    }))
    if (!response.Item) return undefined
    const receipt = readStoredTaskViewMutationReceipt(response.Item)
    return receipt.expiresAt > Math.floor(Date.now() / 1_000) ? receipt : undefined
  }

  /**
   * Resolves a receipt only when it exactly matches the current normalized request.
   *
   * @param workspaceId - Workspace that owns the receipt.
   * @param operation - Current mutation operation.
   * @param viewId - Current target task view ID.
   * @param actorUserId - Current actor that owns the caller key.
   * @param idempotencyKeyHash - Operation-bound receipt identity hash.
   * @param requestFingerprint - Current normalized request fingerprint.
   * @returns The matching receipt, or undefined when the caller key is unused.
   */
  private async getTaskViewMutationReplayReceipt(
    workspaceId: string,
    operation: TaskViewMutationOperation,
    viewId: string,
    actorUserId: string,
    idempotencyKeyHash: string,
    requestFingerprint: string,
  ) {
    const receipt = await this.getTaskViewMutationReceipt(workspaceId, idempotencyKeyHash)
    if (!receipt) return undefined
    if (
      receipt.workspaceId !== workspaceId ||
      receipt.operation !== operation ||
      receipt.viewId !== viewId ||
      receipt.actorUserId !== actorUserId ||
      receipt.idempotencyKeyHash !== idempotencyKeyHash ||
      receipt.requestFingerprint !== requestFingerprint
    ) {
      throw createTaskViewIdempotencyConflict()
    }
    return receipt
  }

  /**
   * Resolves an idempotent create retry without re-evaluating mutable source state.
   *
   * @param workspaceId - Workspace that owns the idempotent operation.
   * @param ownerUserId - User that owns the idempotency key.
   * @param idempotencyKey - Validated operation-specific idempotency key.
   * @param requestFingerprint - Stable request fingerprint expected on the persisted lifecycle.
   * @param access - Current viewer access used to shape the replay response.
   * @returns The prior live result, or undefined when the key has not been used.
   */
  private async getTaskViewIdempotencyReplay(
    workspaceId: string,
    ownerUserId: string,
    idempotencyKey: string,
    requestFingerprint: string,
    access: TaskViewAccessScope,
  ) {
    const idempotencyHash = createTaskViewIdempotencyHash(
      workspaceId,
      ownerUserId,
      idempotencyKey,
    )
    const liveView = await this.getTaskViewIfPresent(workspaceId, idempotencyHash)
    if (liveView) {
      if (
        liveView.createIdempotencyKeyHash !== idempotencyHash ||
        liveView.createRequestFingerprint !== requestFingerprint ||
        liveView.ownerUserId !== ownerUserId
      ) {
        throw createTaskViewIdempotencyConflict()
      }
      try {
        return await this.getTaskView({ workspaceId, viewId: liveView.id, access })
      } catch (error) {
        if (
          !(error instanceof WorkspaceSearchError) ||
          error.code !== 'TaskViewNotFound'
        ) {
          throw error
        }
        await this.rejectDeletedTaskViewIdempotencyReplay(
          workspaceId,
          idempotencyHash,
          requestFingerprint,
        )
        throw error
      }
    }
    await this.rejectDeletedTaskViewIdempotencyReplay(
      workspaceId,
      idempotencyHash,
      requestFingerprint,
    )
    return undefined
  }

  /** Rejects a create replay when its deterministic lifecycle has been deleted. */
  private async rejectDeletedTaskViewIdempotencyReplay(
    workspaceId: string,
    idempotencyHash: string,
    requestFingerprint: string,
  ) {
    const tombstone = await this.getTaskViewTombstoneIfPresent(
      workspaceId,
      idempotencyHash,
    )
    if (!tombstone) return
    if (
      tombstone.createIdempotencyKeyHash !== idempotencyHash ||
      tombstone.createRequestFingerprint !== requestFingerprint
    ) {
      throw createTaskViewIdempotencyConflict()
    }
    throw new WorkspaceSearchError(
      409,
      'TaskViewIdempotencyConflict',
      'Idempotent task view result was deleted and cannot be recreated.',
    )
  }

  /** Strongly reads a required task view definition or throws the stable not-found error. */
  private async getRequiredTaskView(workspaceId: string, viewId: string) {
    const stored = await this.getTaskViewIfPresent(workspaceId, viewId)
    if (!stored) throw createTaskViewNotFound()
    return stored
  }

  /** Strongly reads one task view preference for the current viewer. */
  private async getTaskViewPreference(workspaceId: string, userId: string, viewId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: createTaskViewPreferenceRecordKey(userId, viewId) },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredTaskViewPreference(response.Item) : undefined
  }

  /** Removes every viewer preference for a deleted task view in bounded DynamoDB pages. */
  private async cleanupTaskViewPreferences(workspaceId: string, viewId: string) {
    const preferencePrefix = `${WORKSPACE_TASK_VIEW_PREFERENCE_PREFIX}`
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        FilterExpression: '#entryType = :entryType AND #viewId = :viewId',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#viewId': 'viewId',
        },
        ExpressionAttributeValues: {
          ':entryType': 'task-view-preference',
          ':viewId': viewId,
          ':workspaceId': workspaceId,
          ':prefix': preferencePrefix,
        },
        ExclusiveStartKey: exclusiveStartKey,
        Limit: TASK_VIEW_PREFERENCE_CLEANUP_PAGE_SIZE,
      }))
      const preferenceKeys = (response.Items ?? [])
        .filter((item) => isRecordValue(item) &&
          item.entryType === 'task-view-preference' &&
          item.viewId === viewId &&
          typeof item.recordKey === 'string')
        .map((item) => ({
          workspaceId,
          recordKey: String(item.recordKey),
        }))
      if (preferenceKeys.length > 0) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: preferenceKeys.map((key) => ({
            Delete: {
              TableName: this.tableName,
              Key: key,
            },
          })),
        }))
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
  }

  /** Strongly reads one personal or Team default marker. */
  private async getTaskViewDefault(
    workspaceId: string,
    ownerType: StoredTaskViewDefaultOwner,
    userId: string,
    teamId: string | undefined,
    surface: TaskViewSurface,
    scope: TaskViewScope,
  ) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId,
        recordKey: createTaskViewDefaultRecordKey(
          ownerType,
          userId,
          teamId,
          surface,
          scope,
        ),
      },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredTaskViewDefault(response.Item) : undefined
  }

  /** Reads every page of personal default markers owned by one viewer. */
  private async listPersonalTaskViewDefaults(workspaceId: string, userId: string) {
    const prefix = createTaskViewDefaultOwnerPrefix('personal', userId, undefined)
    const defaults: StoredTaskViewDefault[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':workspaceId': workspaceId, ':prefix': prefix },
        ExclusiveStartKey: exclusiveStartKey,
      }))
      defaults.push(...(response.Items ?? []).map(readStoredTaskViewDefault))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return defaults
  }

  /** Resolves the effective task view default with personal precedence over Team. */
  private async resolveTaskViewDefault(
    workspaceId: string,
    surface: TaskViewSurface,
    scope: TaskViewScope,
    access: TaskViewAccessScope,
  ): Promise<ResolvedTaskViewDefault> {
    let personalViewId: string | undefined
    const personalDefault = await this.getTaskViewDefault(
      workspaceId,
      'personal',
      access.viewerUserId,
      undefined,
      surface,
      scope,
    )
    if (personalDefault) {
      const target = await this.getTaskViewIfPresent(workspaceId, personalDefault.viewId)
      if (
        target &&
        matchesTaskViewContext(target, surface, scope) &&
        canReadTaskView(target, access)
      ) {
        personalViewId = target.id
      } else {
        await this.cleanupTaskViewDefaultMarker(personalDefault)
      }
    }

    let teamViewId: string | undefined
    const teamId = getTaskViewScopeTeamId(scope)
    if (teamId && access.teamIds.has(teamId)) {
      const teamDefault = await this.getTaskViewDefault(
        workspaceId,
        'team',
        access.viewerUserId,
        teamId,
        surface,
        scope,
      )
      if (teamDefault) {
        const target = await this.getTaskViewIfPresent(workspaceId, teamDefault.viewId)
        if (
          target &&
          target.visibility === 'team' &&
          target.teamId === teamId &&
          matchesTaskViewContext(target, surface, scope) &&
          canReadTaskView(target, access)
        ) {
          teamViewId = target.id
        } else {
          await this.cleanupTaskViewDefaultMarker(teamDefault)
        }
      }
    }
    if (personalViewId) {
      return {
        viewId: personalViewId,
        personalViewId,
        ...(teamViewId ? { teamViewId } : {}),
        source: 'personal',
      }
    }
    if (teamViewId) return { viewId: teamViewId, teamViewId, source: 'team' }
    return { source: 'built-in' }
  }

  /** Removes viewer preference and personal default state for a confirmed missing task view. */
  private async cleanupMissingTaskViewState(
    workspaceId: string,
    userId: string,
    viewId: string,
  ) {
    const [preference, defaults] = await Promise.all([
      this.getTaskViewPreference(workspaceId, userId, viewId),
      this.listPersonalTaskViewDefaults(workspaceId, userId),
    ])
    const matchingDefaults = defaults
      .filter((marker) => marker.viewId === viewId)
      .slice(0, TASK_VIEW_ORPHAN_CLEANUP_LIMIT)
    if (!preference && !matchingDefaults.length) return
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: createTaskViewRecordKey(viewId) },
          ConditionExpression: 'attribute_not_exists(#recordKey)',
          ExpressionAttributeNames: {
            '#recordKey': 'recordKey',
          },
        },
      },
      ...(preference
        ? [{
            Delete: {
              TableName: this.tableName,
              Key: { workspaceId, recordKey: createTaskViewPreferenceRecordKey(userId, viewId) },
            },
          }]
        : []),
      ...matchingDefaults.map((marker) => ({
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: marker.recordKey },
          ConditionExpression: '#viewId = :viewId',
          ExpressionAttributeNames: { '#viewId': 'viewId' },
          ExpressionAttributeValues: { ':viewId': viewId },
        },
      })),
    ]
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw error
    }
  }

  /** Lazily removes one stale default marker only when its observed generation is unchanged. */
  private async cleanupTaskViewDefaultMarker(marker: StoredTaskViewDefault) {
    const generationCondition = createTaskViewDefaultGenerationCondition(marker)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [{
          Delete: {
            TableName: this.tableName,
            Key: { workspaceId: marker.workspaceId, recordKey: marker.recordKey },
            ConditionExpression: `#viewId = :viewId AND ${generationCondition.expression}`,
            ExpressionAttributeNames: {
              '#viewId': 'viewId',
              ...generationCondition.names,
            },
            ExpressionAttributeValues: {
              ':viewId': marker.viewId,
              ...generationCondition.values,
            },
          },
        }],
      }))
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw error
    }
  }

}

/**
 * Saved view から削除済み custom field 参照を除外します。
 */
export function migrateSavedWorkspaceView(
  view: SavedWorkspaceView,
  activeCustomFieldIds?: ReadonlySet<string>,
): SavedWorkspaceView {
  if (!activeCustomFieldIds) {
    return view
  }
  const warnings: SavedViewMigrationWarning[] = []
  const filters = {
    ...view.filters,
    customFields: view.filters.customFields?.filter((filter) => {
      if (activeCustomFieldIds.has(filter.fieldId)) {
        return true
      }
      warnings.push({ code: 'deleted-custom-field', fieldId: filter.fieldId, section: 'filter' })
      return false
    }),
  }
  const layout = {
    ...view.layout,
    sort: view.layout.sort.filter((sort) => retainLayoutField(
      sort.field,
      activeCustomFieldIds,
      warnings,
      'sort',
    )),
    columns: view.layout.columns.filter((column) => retainLayoutField(
      column,
      activeCustomFieldIds,
      warnings,
      'column',
    )),
    ...(view.layout.groupBy && retainLayoutField(
      view.layout.groupBy,
      activeCustomFieldIds,
      warnings,
      'group',
    )
      ? { groupBy: view.layout.groupBy }
      : { groupBy: undefined }),
  }
  return {
    ...view,
    filters,
    layout,
    ...(warnings.length ? { migrationWarnings: dedupeMigrationWarnings(warnings) } : {}),
  }
}

/**
 * Creates the canonical Team-qualified key used by task view status allowlists.
 *
 * @param teamId - Team that owns the workflow status.
 * @param statusId - Stable workflow status identifier within the Team.
 * @returns Collision-safe allowlist key for the Team and status pair.
 */
export function createTaskViewStatusKey(teamId: string, statusId: string) {
  return `${requireText(teamId, 'Task view status Team ID')}\0${requireText(
    statusId,
    'Task view status ID',
  )}`
}

/**
 * Creates the canonical Team-qualified key used by task view Project scopes.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Stable Project identifier within the Team.
 * @returns Collision-safe authorization key for the Team and Project pair.
 */
export function createTaskViewProjectScopeKey(teamId: string, projectId: string) {
  return `${requireText(teamId, 'Task view Project Team ID')}\0${requireText(
    projectId,
    'Task view Project ID',
  )}`
}

/**
 * Removes stale or permission-restricted references from a task view at read time.
 *
 * @param definition - Persisted task view definition to sanitize.
 * @param access - Current access and current-source reference resolver.
 * @returns A permission-safe definition together with stable migration warnings.
 */
async function sanitizeTaskViewDefinition(
  definition: TaskViewDefinition,
  access: TaskViewAccessScope,
) {
  const warnings: TaskViewMigrationWarning[] = []
  const readableRelationIds =
    definition.filters.relationIds === undefined ||
      access.resolveReadableRelationIds === undefined
      ? access.readableRelationIds
      : await access.resolveReadableRelationIds({
          relationIds: [...definition.filters.relationIds],
          surface: definition.surface,
          scope: definition.scope,
        })
  const filters: TaskViewFilters = {
    ...definition.filters,
    ...(definition.filters.teamIds === undefined
      ? {}
      : {
          teamIds: definition.filters.teamIds.filter((teamId) => {
            if (access.teamIds.has(teamId)) return true
            addTaskViewMigrationWarning(warnings, 'permission-redacted', 'filter', 'removed')
            return false
          }),
        }),
    ...(definition.filters.projectIds === undefined
      ? {}
      : {
          projectIds: definition.filters.projectIds.filter((projectId) => {
            if (canReadTaskViewProjectFilter(projectId, definition.scope, access)) return true
            addTaskViewMigrationWarning(warnings, 'permission-redacted', 'filter', 'removed')
            return false
          }),
        }),
    ...(definition.filters.assigneeUserIds === undefined
      ? {}
      : {
          assigneeUserIds: retainTaskViewReferenceIds(
            definition.filters.assigneeUserIds,
            access.readableActorIds,
            warnings,
          ),
        }),
    ...(definition.filters.creatorUserIds === undefined
      ? {}
      : {
          creatorUserIds: retainTaskViewReferenceIds(
            definition.filters.creatorUserIds,
            access.readableActorIds,
            warnings,
          ),
        }),
    ...(definition.filters.relationIds === undefined
      ? {}
      : {
          relationIds: retainTaskViewReferenceIds(
            definition.filters.relationIds,
            readableRelationIds,
            warnings,
          ),
        }),
    ...(definition.filters.customFields === undefined
      ? {}
      : {
          customFields: definition.filters.customFields.filter((filter) =>
            retainTaskViewCustomField(filter.fieldId, access, warnings, 'filter')
          ),
        }),
    ...(definition.filters.statuses === undefined
      ? {}
      : {
          statuses: definition.filters.statuses.filter((statusId) => {
            if (isTaskViewLegacyStatusActive(statusId, definition, access)) return true
            addTaskViewMigrationWarning(
              warnings,
              'deleted-workflow-status',
              'filter',
              'removed',
            )
            return false
          }),
        }),
    ...(definition.filters.workflowStatuses === undefined
      ? {}
      : {
          workflowStatuses: definition.filters.workflowStatuses.filter((status) => {
            if (!access.teamIds.has(status.teamId)) {
              addTaskViewMigrationWarning(warnings, 'permission-redacted', 'filter', 'removed')
              return false
            }
            if (
              !access.activeStatusIds ||
              access.activeStatusIds.has(createTaskViewStatusKey(status.teamId, status.statusId))
            ) {
              return true
            }
            addTaskViewMigrationWarning(
              warnings,
              'deleted-workflow-status',
              'filter',
              'removed',
            )
            return false
          }),
        }),
  }
  const group = definition.layout.group && retainTaskViewLayoutField(
    definition.layout.group.field,
    access,
    warnings,
    'group',
    false,
  )
    ? definition.layout.group
    : undefined
  const subgroup = definition.layout.subgroup && retainTaskViewLayoutField(
    definition.layout.subgroup.field,
    access,
    warnings,
    'subgroup',
    false,
  )
    ? definition.layout.subgroup
    : undefined
  const sort = definition.layout.sort.filter((rule) => retainTaskViewLayoutField(
    rule.field,
    access,
    warnings,
    'sort',
    false,
  ))
  let columns = definition.layout.columns.filter((column) => retainTaskViewLayoutField(
    column.field,
    access,
    warnings,
    'column',
    true,
  ))
  if (!columns.length && isReadableTaskViewBuiltInField('title', access, true)) {
    columns = [{ field: 'title' }]
    addTaskViewMigrationWarning(warnings, 'invalid-layout', 'column', 'reset-to-default')
  }
  return {
    definition: {
      ...definition,
      filters,
      layout: {
        ...definition.layout,
        ...(group ? { group } : { group: undefined }),
        ...(subgroup ? { subgroup } : { subgroup: undefined }),
        sort,
        columns,
      },
    },
    warnings: dedupeTaskViewMigrationWarnings(warnings),
  }
}

/** Removes opaque filter references that are not present in the current disclosure allowlist. */
function retainTaskViewReferenceIds(
  referenceIds: readonly string[],
  readableIds: ReadonlySet<string> | undefined,
  warnings: TaskViewMigrationWarning[],
): string[] {
  if (!readableIds) return [...referenceIds]
  return referenceIds.filter((referenceId) => {
    if (readableIds.has(referenceId)) return true
    addTaskViewMigrationWarning(warnings, 'permission-redacted', 'filter', 'removed')
    return false
  })
}

/**
 * Checks a Project filter against either a globally unique ID or the definition's Team context.
 *
 * @param projectId - Bare Project identifier stored by the shared search filter contract.
 * @param scope - Task-view scope that may safely qualify the Project's owner Team.
 * @param access - Current viewer's bare and Team-qualified Project allowlists.
 * @returns Whether the filter can be retained without confusing duplicate Project IDs.
 */
function canReadTaskViewProjectFilter(
  projectId: string,
  scope: TaskViewScope,
  access: TaskViewAccessScope,
): boolean {
  if (access.projectIds.has(projectId)) return true
  const teamId = getTaskViewScopeTeamId(scope)
  return teamId !== undefined && access.projectScopeKeys.has(
    createTaskViewProjectScopeKey(teamId, projectId),
  )
}

/** Returns whether one custom field still exists and remains readable. */
function retainTaskViewCustomField(
  fieldId: string,
  access: TaskViewAccessScope,
  warnings: TaskViewMigrationWarning[],
  section: TaskViewMigrationSection,
) {
  if (access.activeCustomFieldIds && !access.activeCustomFieldIds.has(fieldId)) {
    addTaskViewMigrationWarning(warnings, 'deleted-custom-field', section, 'removed')
    return false
  }
  if (access.readableCustomFieldIds && !access.readableCustomFieldIds.has(fieldId)) {
    addTaskViewMigrationWarning(warnings, 'permission-redacted', section, 'removed')
    return false
  }
  return true
}

/** Returns whether one persisted group, sort, or column field is still usable. */
function retainTaskViewLayoutField(
  field: string,
  access: TaskViewAccessScope,
  warnings: TaskViewMigrationWarning[],
  section: TaskViewMigrationSection,
  enforceColumnPermission: boolean,
) {
  if (field === 'customFields' && !enforceColumnPermission) {
    addTaskViewMigrationWarning(warnings, 'invalid-layout', section, 'removed')
    return false
  }
  if (field.startsWith('custom:')) {
    const fieldId = field.slice('custom:'.length)
    if (!fieldId) {
      addTaskViewMigrationWarning(warnings, 'invalid-layout', section, 'removed')
      return false
    }
    return retainTaskViewCustomField(fieldId, access, warnings, section)
  }
  if (!taskViewBuiltInLayoutFields.has(field)) {
    addTaskViewMigrationWarning(warnings, 'invalid-layout', section, 'removed')
    return false
  }
  if (enforceColumnPermission && !isReadableTaskViewBuiltInField(field, access, true)) {
    addTaskViewMigrationWarning(warnings, 'permission-redacted', section, 'removed')
    return false
  }
  return true
}

/** Returns whether a built-in layout field is readable in the current capability set. */
function isReadableTaskViewBuiltInField(
  field: string,
  access: TaskViewAccessScope,
  enforcePermission: boolean,
) {
  return !enforcePermission || !access.readableColumnIds || access.readableColumnIds.has(field)
}

/** Returns whether a legacy unqualified status still exists in any relevant Team workflow. */
function isTaskViewLegacyStatusActive(
  statusId: string,
  definition: TaskViewDefinition,
  access: TaskViewAccessScope,
) {
  if (!access.activeStatusIds) return true
  const teamIds = new Set<string>()
  const scopeTeamId = getTaskViewScopeTeamId(definition.scope)
  if (scopeTeamId) teamIds.add(scopeTeamId)
  for (const teamId of definition.filters.teamIds ?? []) {
    if (access.teamIds.has(teamId)) teamIds.add(teamId)
  }
  if (!teamIds.size) {
    for (const teamId of access.teamIds) teamIds.add(teamId)
  }
  if (teamIds.size) {
    return [...teamIds].some((teamId) =>
      access.activeStatusIds?.has(createTaskViewStatusKey(teamId, statusId))
    )
  }
  const suffix = `\0${statusId}`
  return [...access.activeStatusIds].some((key) => key.endsWith(suffix))
}

/** Appends one deterministic migration warning without exposing an unreadable identifier. */
function addTaskViewMigrationWarning(
  warnings: TaskViewMigrationWarning[],
  code: TaskViewMigrationWarning['code'],
  section: TaskViewMigrationWarning['section'],
  fallback: TaskViewMigrationWarning['fallback'],
) {
  warnings.push({ code, section, fallback })
}

/** Deduplicates task view migration warnings while preserving their first occurrence order. */
function dedupeTaskViewMigrationWarnings(warnings: TaskViewMigrationWarning[]) {
  return [...new Map(warnings.map((warning) => [
    `${warning.code}\0${warning.section}\0${warning.fallback}\0${warning.referenceId ?? ''}`,
    warning,
  ])).values()]
}

/** Local DynamoDB に workspace search table を作成します。 */
export async function ensureLocalWorkspaceSearchTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
) {
  const normalizedTableName = requireText(tableName, 'Workspace search table name')
  try {
    const described = await dynamoDbClient.send(new DescribeTableCommand({
      TableName: normalizedTableName,
    }))
    if (!isWorkspaceSearchTableDescription(described.Table)) {
      throw new Error(`Local DynamoDB table "${normalizedTableName}" does not match the expected schema.`)
    }
    if (described.Table?.TableStatus === 'ACTIVE') return
    await waitForWorkspaceSearchTable(normalizedTableName, dynamoDbClient)
    return
  } catch (error) {
    if (!isResourceNotFound(error)) {
      throw error
    }
  }
  try {
    await dynamoDbClient.send(new CreateTableCommand({
      TableName: normalizedTableName,
      AttributeDefinitions: [
        { AttributeName: 'workspaceId', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'workspaceId', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }))
  } catch (error) {
    if (!isResourceInUse(error)) {
      throw error
    }
  }
  await waitForWorkspaceSearchTable(normalizedTableName, dynamoDbClient)
}

async function waitForWorkspaceSearchTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await dynamoDbClient.send(new DescribeTableCommand({ TableName: tableName }))
    if (response.Table?.TableStatus === 'ACTIVE') {
      if (!isWorkspaceSearchTableDescription(response.Table)) {
        throw new Error(`Local DynamoDB table "${tableName}" does not match the expected schema.`)
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Local DynamoDB table "${tableName}" did not become active.`)
}

function normalizeWorkspaceSearchFilters(filters: unknown) {
  if (!isRecordValue(filters)) {
    return invalidFilters('Search filters must be an object.')
  }
  const normalized: WorkspaceSearchFilters = {}
  const keyword = optionalText(filters.keyword, 'Search keyword', 256)
  if (keyword) normalized.keyword = keyword
  if (filters.entityTypes) {
    if (!Array.isArray(filters.entityTypes) || filters.entityTypes.length > searchEntityTypes.size) {
      return invalidFilters('Search entity types are invalid.')
    }
    normalized.entityTypes = [...new Set(filters.entityTypes.map(requireSearchEntityType))]
  }
  copyFilterStringList(normalized, filters, 'assigneeUserIds')
  copyFilterStringList(normalized, filters, 'creatorUserIds')
  copyFilterStringList(normalized, filters, 'statuses')
  copyFilterStringList(normalized, filters, 'relationIds')
  copyFilterStringList(normalized, filters, 'projectIds')
  copyFilterStringList(normalized, filters, 'teamIds')
  if (filters.customFields) {
    if (!Array.isArray(filters.customFields) || filters.customFields.length > 50) {
      throw new WorkspaceSearchError(400, 'InvalidSearchFilters', 'Custom field filters are invalid.')
    }
    normalized.customFields = filters.customFields.map(normalizeCustomFieldFilter)
  }
  if (filters.date) {
    if (!isRecordValue(filters.date)) {
      throw new WorkspaceSearchError(400, 'InvalidSearchFilters', 'Search date field is invalid.')
    }
    const field = filters.date.field
    if (field !== 'createdAt' && field !== 'updatedAt' && field !== 'dueDate') {
      throw new WorkspaceSearchError(400, 'InvalidSearchFilters', 'Search date field is invalid.')
    }
    const from = optionalText(filters.date.from, 'Search date lower bound', 128)
    const to = optionalText(filters.date.to, 'Search date upper bound', 128)
    if (!from && !to) {
      throw new WorkspaceSearchError(400, 'InvalidSearchFilters', 'Search date range is empty.')
    }
    if (from && to && from > to) {
      throw new WorkspaceSearchError(400, 'InvalidSearchFilters', 'Search date range is reversed.')
    }
    normalized.date = { field, ...(from ? { from } : {}), ...(to ? { to } : {}) }
  }
  return normalized
}

function matchesWorkspaceSearchFilters(
  document: WorkspaceSearchDocument,
  filters: WorkspaceSearchFilters,
) {
  if (filters.entityTypes?.length && !filters.entityTypes.includes(document.entityType)) return false
  if (filters.assigneeUserIds?.length && (!document.assigneeUserId || !filters.assigneeUserIds.includes(document.assigneeUserId))) return false
  if (filters.creatorUserIds?.length && (!document.creatorUserId || !filters.creatorUserIds.includes(document.creatorUserId))) return false
  if (filters.statuses?.length && (!document.status || !filters.statuses.includes(document.status))) return false
  if (filters.projectIds?.length && (!document.projectId || !filters.projectIds.includes(document.projectId))) return false
  if (filters.teamIds?.length && (!document.teamId || !filters.teamIds.includes(document.teamId))) return false
  if (filters.relationIds?.length && !filters.relationIds.every((relationId) => document.relationIds?.includes(relationId))) return false
  if (filters.customFields?.length && !filters.customFields.every((filter) => matchesCustomFieldFilter(document.customFields?.[filter.fieldId], filter))) return false
  if (filters.date) {
    const value = document[filters.date.field]
    if (!value || !matchesSearchDateRange(value, filters.date.from, filters.date.to)) return false
  }
  if (filters.keyword) {
    const haystack = normalizeSearchText([
      document.entityId,
      document.title,
      document.subtitle,
      document.body,
    ].filter(Boolean).join('\n'))
    if (!splitKeyword(filters.keyword).every((term) => haystack.includes(term))) return false
  }
  return true
}

function matchesImmutableWorkspaceSearchFilters(
  document: WorkspaceSearchDocument,
  filters: WorkspaceSearchFilters,
) {
  if (
    filters.entityTypes?.length &&
    !filters.entityTypes.includes(
      document.entityType,
    )
  ) {
    return false
  }
  if (
    filters.creatorUserIds?.length &&
    (
      !document.creatorUserId ||
      !filters.creatorUserIds.includes(
        document.creatorUserId,
      )
    )
  ) {
    return false
  }
  if (
    filters.date?.field === 'createdAt'
  ) {
    return Boolean(
      document.createdAt &&
      matchesSearchDateRange(
        document.createdAt,
        filters.date.from,
        filters.date.to,
      ),
    )
  }
  return true
}

function matchesCustomFieldFilter(
  value: SearchCustomFieldValue | undefined,
  filter: SearchCustomFieldFilter,
) {
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
  if (filter.operator === 'is-empty') return empty
  if (filter.operator === 'is-not-empty') return !empty
  if (empty) return false
  if (filter.operator === 'equals') return canonicalValue(value) === canonicalValue(filter.value)
  if (filter.operator === 'not-equals') return canonicalValue(value) !== canonicalValue(filter.value)
  if (filter.operator === 'contains') {
    if (Array.isArray(value)) return Array.isArray(filter.value)
      ? filter.value.every((candidate) => value.includes(candidate))
      : typeof filter.value === 'string' && value.includes(filter.value)
    return typeof value === 'string' && typeof filter.value === 'string' && normalizeSearchText(value).includes(normalizeSearchText(filter.value))
  }
  if (typeof value !== 'number' || typeof filter.value !== 'number') return false
  if (filter.operator === 'greater-than') return value > filter.value
  if (filter.operator === 'greater-than-or-equal') return value >= filter.value
  if (filter.operator === 'less-than') return value < filter.value
  return value <= filter.value
}

function canAccessWorkspaceSearchDocument(
  document: WorkspaceSearchDocument,
  access: WorkspaceSearchAccessScope,
  permissionVerified = false,
) {
  if (document.entityType === 'document') return permissionVerified
  if (access.isSystemAdmin) return true
  if (document.entityType === 'project') {
    return Boolean(document.projectId && access.projectIds.has(document.projectId))
  }
  if (document.entityType === 'team') {
    return Boolean(document.teamId && access.teamIds.has(document.teamId))
  }
  if (document.projectId) return access.projectIds.has(document.projectId)
  if (document.teamId) return access.teamIds.has(document.teamId)
  return false
}

/**
 * Replaces indexed Team/Project ownership with the source-of-truth scope.
 *
 * @param document - Current or indexed search document to scope.
 * @param resolvedScope - Scope resolved from the canonical Work Item.
 * @returns A document whose ownership fields cannot retain stale index values.
 */
function applyResolvedWorkspaceSearchScope(
  document: WorkspaceSearchDocument,
  resolvedScope: WorkspaceSearchResolvedScope,
): WorkspaceSearchDocument {
  const scopedDocument = { ...document }
  if (resolvedScope.teamId) {
    scopedDocument.teamId = resolvedScope.teamId
  } else {
    delete scopedDocument.teamId
  }
  if (resolvedScope.projectId) {
    scopedDocument.projectId = resolvedScope.projectId
  } else {
    delete scopedDocument.projectId
  }
  return scopedDocument
}

function toWorkspaceSearchResult(
  document: WorkspaceSearchDocument,
  keyword: string | undefined,
): WorkspaceSearchResult {
  const body = createSearchBodyPreview(document.body, keyword)
  const displayDocument = body === document.body ? document : { ...document, body }
  const result: WorkspaceSearchResult = {
    id: document.entityId,
    entityType: document.entityType,
    title: document.title,
    url: document.url,
    highlights: createHighlights(displayDocument, keyword),
  }
  copyOptionalResultFields(result, displayDocument)
  return result
}

function createSearchBodyPreview(body: string | undefined, keyword: string | undefined) {
  if (!body || body.length <= 500) return body
  const firstTerm = keyword?.trim().split(/\s+/u).find(Boolean)
  const matchIndex = firstTerm
    ? body.toLocaleLowerCase().indexOf(firstTerm.toLocaleLowerCase())
    : -1
  const start = Math.max(0, matchIndex < 0 ? 0 : matchIndex - 160)
  const end = Math.min(body.length, start + 500)
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
}

function createHighlights(document: WorkspaceSearchDocument, keyword?: string) {
  if (!keyword) return []
  const terms = keyword.trim().split(/\s+/u).filter(Boolean)
  const highlights: WorkspaceSearchHighlight[] = []
  for (const [field, text] of [['title', document.title], ['body', document.body]] as const) {
    if (!text) continue
    const fragments = createHighlightFragments(text, terms)
    if (fragments.some((fragment) => fragment.matched)) highlights.push({ field, fragments })
  }
  return highlights
}

function createHighlightFragments(text: string, terms: string[]) {
  const ranges: Array<{ start: number; end: number }> = []
  const lower = text.toLocaleLowerCase()
  for (const term of terms) {
    const needle = term.toLocaleLowerCase()
    if (!needle) continue
    let from = 0
    while (from < lower.length) {
      const index = lower.indexOf(needle, from)
      if (index < 0) break
      ranges.push({ start: index, end: index + needle.length })
      from = index + Math.max(1, needle.length)
    }
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  if (!merged.length) return [{ text, matched: false }]
  const fragments: Array<{ text: string; matched: boolean }> = []
  let offset = 0
  for (const range of merged) {
    if (range.start > offset) fragments.push({ text: text.slice(offset, range.start), matched: false })
    fragments.push({ text: text.slice(range.start, range.end), matched: true })
    offset = range.end
  }
  if (offset < text.length) fragments.push({ text: text.slice(offset), matched: false })
  return fragments
}

function toSavedWorkspaceView(
  stored: StoredSavedWorkspaceView,
  preference: StoredSavedViewPreference | undefined,
  isDefault: boolean,
  access: SavedViewAccessScope,
  activeCustomFieldIds?: ReadonlySet<string>,
) {
  const view: SavedWorkspaceView = {
    schemaVersion: SAVED_VIEW_SCHEMA_VERSION,
    id: stored.id,
    name: stored.name,
    ...(stored.description ? { description: stored.description } : {}),
    visibility: stored.visibility,
    ownerUserId: stored.ownerUserId,
    ...(stored.teamId ? { teamId: stored.teamId } : {}),
    filters: normalizeWorkspaceSearchFilters(stored.filters),
    layout: normalizeSearchViewLayout(stored.layout),
    revision: stored.revision,
    canEdit: access.canWrite && canEditSavedViewDefinition(stored, access),
    favorite: preference?.favorite ?? false,
    pinned: preference?.pinned ?? false,
    isDefault,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  }
  return migrateSavedWorkspaceView(view, activeCustomFieldIds)
}

/** Converts one stored task view into the permission-safe API representation. */
async function toSavedTaskView(
  stored: StoredTaskView,
  preference: StoredTaskViewPreference | undefined,
  resolvedDefault: ResolvedTaskViewDefault,
  access: TaskViewAccessScope,
): Promise<SavedTaskView> {
  const sanitized = await sanitizeTaskViewDefinition(stored.definition, access)
  const isDefault = resolvedDefault.viewId === stored.id
  const isPersonalDefault = resolvedDefault.personalViewId === stored.id
  const isTeamDefault = resolvedDefault.teamViewId === stored.id
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    id: stored.id,
    name: stored.name,
    ...(stored.description ? { description: stored.description } : {}),
    visibility: stored.visibility,
    ownerUserId: stored.ownerUserId,
    ...(stored.teamId ? { teamId: stored.teamId } : {}),
    definition: sanitized.definition,
    revision: stored.revision,
    canEdit: access.canWrite && canEditTaskViewDefinition(stored, access),
    preference: {
      favorite: preference?.favorite ?? false,
      pinned: preference?.pinned ?? false,
      isDefault,
      isPersonalDefault,
      isTeamDefault,
      ...(isDefault ? { defaultSource: resolvedDefault.source } : {}),
    },
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    ...(sanitized.warnings.length ? { migrationWarnings: sanitized.warnings } : {}),
  }
}

/** Returns whether the current viewer may discover and evaluate a stored task view. */
function canReadTaskView(view: StoredTaskView, access: TaskViewAccessScope) {
  if (!canAccessTaskViewScope(view.definition.scope, access)) return false
  if (view.visibility === 'personal') return view.ownerUserId === access.viewerUserId
  if (view.visibility === 'shared') return true
  return Boolean(view.teamId && access.teamIds.has(view.teamId))
}

/** Returns whether the current viewer may evaluate a task view resource scope. */
function canAccessTaskViewScope(scope: TaskViewScope, access: TaskViewAccessScope) {
  if (scope.kind === 'workspace') return access.canAccessWorkspaceScope
  if (scope.kind === 'viewer') return true
  if (scope.kind === 'team') return access.teamIds.has(scope.teamId)
  return scope.teamId
    ? access.projectScopeKeys.has(createTaskViewProjectScopeKey(scope.teamId, scope.projectId))
    : access.projectIds.has(scope.projectId)
}

/** Returns whether the current viewer may mutate a task view in one resource scope. */
function canWriteTaskViewScope(scope: TaskViewScope, access: TaskViewAccessScope) {
  if (scope.kind === 'workspace') return access.canWriteWorkspaceScope
  if (scope.kind === 'viewer') return access.canWrite
  if (scope.kind === 'team') return access.writableTeamIds.has(scope.teamId)
  return scope.teamId
    ? access.writableProjectScopeKeys.has(
        createTaskViewProjectScopeKey(scope.teamId, scope.projectId),
      )
    : access.writableProjectIds.has(scope.projectId)
}

/**
 * Creates Saved View lifecycle and Work Item mutation capabilities for an exact list query.
 *
 * @param surface - Validated product surface filter, when supplied.
 * @param scope - Validated resource scope filter, when supplied.
 * @param access - Current viewer read and write authorization.
 * @returns Server-authoritative capabilities that never infer write access from list rows.
 */
function createTaskViewListCapabilities(
  surface: TaskViewSurface | undefined,
  scope: TaskViewScope | undefined,
  access: TaskViewAccessScope,
): SavedTaskViewCapabilities {
  if (!surface || !scope) {
    return {
      canWrite: false,
      canManageSharedViews: false,
      canSetTeamDefault: false,
      writableTeamIds: [],
      writableProjectScopes: [],
    }
  }
  const canWrite = access.canWrite && canWriteTaskViewScope(scope, access)
  const scopeTeamId = getTaskViewScopeTeamId(scope)
  const candidateTeamIds = scopeTeamId ? [scopeTeamId] : [...access.writableTeamIds]
  const writableTeamIds = candidateTeamIds
    .filter((teamId) =>
      access.teamIds.has(teamId) && access.writableTeamIds.has(teamId)
    )
    .sort()
  return {
    canWrite,
    canManageSharedViews: canWrite && access.canManageSharedViews,
    canSetTeamDefault: Boolean(
      canWrite && scopeTeamId && access.manageableTeamIds.has(scopeTeamId),
    ),
    writableTeamIds,
    writableProjectScopes: createTaskViewListWritableProjectScopes(scope, access),
  }
}

/**
 * Returns authoritative Team-qualified Project write scopes inside one exact task-view scope.
 *
 * @param scope - Exact resource scope requested by the current list operation.
 * @param access - Current viewer read and write authorization.
 * @returns Deterministically ordered readable Project scopes with Work Item write access.
 */
function createTaskViewListWritableProjectScopes(
  scope: TaskViewScope,
  access: TaskViewAccessScope,
): TaskViewWritableProjectScope[] {
  if (
    scope.kind === 'project' &&
    scope.teamId === undefined &&
    !access.writableProjectIds.has(scope.projectId)
  ) {
    return []
  }
  return [...access.writableProjectScopeKeys]
    .filter((scopeKey) => access.projectScopeKeys.has(scopeKey))
    .flatMap((scopeKey) => {
      const writableScope = parseTaskViewProjectScopeKey(scopeKey)
      if (!writableScope || !taskViewWritableProjectScopeMatches(scope, writableScope)) {
        return []
      }
      return [writableScope]
    })
    .sort(compareTaskViewWritableProjectScopes)
}

/**
 * Parses one internal Team-qualified Project authorization key without trusting malformed data.
 *
 * @param scopeKey - Candidate `${teamId}\0${projectId}` authorization key.
 * @returns Structured Project scope, or undefined when the key is malformed.
 */
function parseTaskViewProjectScopeKey(
  scopeKey: string,
): TaskViewWritableProjectScope | undefined {
  const separatorIndex = scopeKey.indexOf('\0')
  if (
    separatorIndex <= 0 ||
    separatorIndex === scopeKey.length - 1 ||
    scopeKey.indexOf('\0', separatorIndex + 1) !== -1
  ) {
    return undefined
  }
  return {
    teamId: scopeKey.slice(0, separatorIndex),
    projectId: scopeKey.slice(separatorIndex + 1),
  }
}

/**
 * Checks whether one writable Project belongs to the exact task-view resource scope.
 *
 * @param scope - Exact resource scope requested by the current list operation.
 * @param writableScope - Team-qualified Project scope from current authorization.
 * @returns Whether the Project capability may be disclosed for the requested scope.
 */
function taskViewWritableProjectScopeMatches(
  scope: TaskViewScope,
  writableScope: TaskViewWritableProjectScope,
): boolean {
  if (scope.kind === 'workspace' || scope.kind === 'viewer') return true
  if (scope.kind === 'team') return scope.teamId === writableScope.teamId
  return scope.projectId === writableScope.projectId && (
    scope.teamId === undefined || scope.teamId === writableScope.teamId
  )
}

/**
 * Orders Team-qualified Project capabilities for deterministic API responses.
 *
 * @param left - First writable Project scope.
 * @param right - Second writable Project scope.
 * @returns Negative, zero, or positive ordering value.
 */
function compareTaskViewWritableProjectScopes(
  left: TaskViewWritableProjectScope,
  right: TaskViewWritableProjectScope,
): number {
  const teamOrder = left.teamId.localeCompare(right.teamId)
  return teamOrder || left.projectId.localeCompare(right.projectId)
}

/** Requires mutation authority for one concrete task view resource scope. */
function requireTaskViewScopeWriteAccess(
  scope: TaskViewScope,
  access: TaskViewAccessScope,
) {
  if (canWriteTaskViewScope(scope, access)) return
  throw new WorkspaceSearchError(
    403,
    'TaskViewAccessDenied',
    'Task view scope mutation is denied.',
  )
}

/** Requires permission to create a task view with the requested visibility and scope. */
function requireCanCreateTaskView(
  visibility: SavedViewVisibility,
  teamId: string | undefined,
  definition: TaskViewDefinition,
  access: TaskViewAccessScope,
) {
  validateVisibilityTeam(visibility, teamId)
  if (!canAccessTaskViewScope(definition.scope, access)) {
    throw new WorkspaceSearchError(403, 'TaskViewAccessDenied', 'Task view scope access is denied.')
  }
  requireTaskViewScopeWriteAccess(definition.scope, access)
  const scopeTeamId = getTaskViewScopeTeamId(definition.scope)
  if (visibility === 'team' && scopeTeamId && teamId !== scopeTeamId) {
    throw new WorkspaceSearchError(
      403,
      'TaskViewAccessDenied',
      'Task view audience must match its Team-qualified scope.',
    )
  }
  if (visibility === 'personal') return
  if (visibility === 'shared') {
    if (access.isSystemAdmin || access.canManageSharedViews) return
    throw new WorkspaceSearchError(403, 'TaskViewAccessDenied', 'Shared task view management is denied.')
  }
  if (teamId && access.writableTeamIds.has(teamId)) return
  throw new WorkspaceSearchError(403, 'TaskViewAccessDenied', 'Team task view access is denied.')
}

/** Requires authority to assign a personal or Team default marker. */
function requireCanSetTaskViewDefault(
  defaultSource: SavedTaskViewDefaultSource | undefined,
  visibility: SavedViewVisibility,
  teamId: string | undefined,
  definition: TaskViewDefinition,
  access: TaskViewAccessScope,
) {
  if (!defaultSource || defaultSource === 'personal') return
  const scopeTeamId = getTaskViewScopeTeamId(definition.scope)
  if (
    visibility !== 'team' ||
    !teamId ||
    scopeTeamId !== teamId ||
    (!access.isSystemAdmin && !access.manageableTeamIds.has(teamId))
  ) {
    throw new WorkspaceSearchError(
      403,
      'TaskViewAccessDenied',
      'Team default task view management is denied.',
    )
  }
}

/** Requires definition edit or delete authority for one stored task view. */
function requireCanEditTaskView(view: StoredTaskView, access: TaskViewAccessScope) {
  if (canEditTaskViewDefinition(view, access)) return
  throw new WorkspaceSearchError(403, 'TaskViewAccessDenied', 'Task view management is denied.')
}

/** Returns whether the current viewer may edit a stored task view definition. */
function canEditTaskViewDefinition(view: StoredTaskView, access: TaskViewAccessScope) {
  if (!canWriteTaskViewScope(view.definition.scope, access)) return false
  if (
    view.visibility === 'team' &&
    (!view.teamId || !access.writableTeamIds.has(view.teamId))
  ) return false
  if (view.ownerUserId === access.viewerUserId || access.isSystemAdmin) return true
  if (view.visibility === 'shared' && access.canManageSharedViews) return true
  return Boolean(
    view.visibility === 'team' &&
    view.teamId &&
    access.manageableTeamIds.has(view.teamId),
  )
}

/** Requires mutation access for task view definitions or viewer preferences. */
function requireTaskViewWriteAccess(access: TaskViewAccessScope) {
  if (!access.canWrite) {
    throw new WorkspaceSearchError(403, 'TaskViewAccessDenied', 'Task view mutations are denied.')
  }
}

/** Returns whether a stored task view matches one exact surface and scope context. */
function matchesTaskViewContext(
  view: StoredTaskView,
  surface: TaskViewSurface,
  scope: TaskViewScope,
) {
  return view.definition.surface === surface && taskViewScopesEqual(view.definition.scope, scope)
}

/** Applies optional list filters without broadening the persisted view context. */
function matchesTaskViewListFilter(
  view: StoredTaskView,
  surface: TaskViewSurface | undefined,
  scope: TaskViewScope | undefined,
) {
  return (!surface || view.definition.surface === surface) &&
    (!scope || taskViewScopesEqual(view.definition.scope, scope))
}

function canReadSavedView(view: StoredSavedWorkspaceView, access: SavedViewAccessScope) {
  if (view.visibility === 'personal') return view.ownerUserId === access.viewerUserId
  if (view.visibility === 'shared') return true
  return Boolean(view.teamId && access.teamIds.has(view.teamId))
}

function requireCanCreateSavedView(
  visibility: SavedViewVisibility,
  teamId: string | undefined,
  access: SavedViewAccessScope,
) {
  if (visibility === 'personal') return
  if (visibility === 'shared') {
    if (access.isSystemAdmin || access.canManageSharedViews) return
    throw new WorkspaceSearchError(403, 'SavedViewAccessDenied', 'Shared saved view management is denied.')
  }
  if (teamId && access.teamIds.has(teamId)) return
  throw new WorkspaceSearchError(403, 'SavedViewAccessDenied', 'Team saved view access is denied.')
}

function requireCanEditSavedView(view: StoredSavedWorkspaceView, access: SavedViewAccessScope) {
  if (canEditSavedViewDefinition(view, access)) return
  throw new WorkspaceSearchError(403, 'SavedViewAccessDenied', 'Saved view management is denied.')
}

function canEditSavedViewDefinition(
  view: StoredSavedWorkspaceView,
  access: SavedViewAccessScope,
) {
  if (view.ownerUserId === access.viewerUserId || access.isSystemAdmin) return true
  if (view.visibility === 'shared' && access.canManageSharedViews) return true
  return Boolean(
    view.visibility === 'team' &&
    view.teamId &&
    access.manageableTeamIds.has(view.teamId),
  )
}

function requireSavedViewWriteAccess(access: SavedViewAccessScope) {
  if (!access.canWrite) {
    throw new WorkspaceSearchError(403, 'SavedViewAccessDenied', 'Saved view mutations are denied.')
  }
}

function normalizeCreateSavedViewInput(input: CreateSavedWorkspaceViewInput) {
  if (!input || typeof input !== 'object') {
    throw new WorkspaceSearchError(400, 'InvalidSavedView', 'Saved view input is required.')
  }
  const visibility = requireSavedViewVisibility(input.visibility)
  const teamId = optionalText(input.teamId, 'Saved view Team ID', 256)
  validateVisibilityTeam(visibility, teamId)
  return {
    name: requireText(input.name, 'Saved view name', 120),
    description: optionalText(input.description, 'Saved view description', 1_000),
    visibility,
    teamId,
    filters: normalizeWorkspaceSearchFilters(input.filters ?? {}),
    layout: normalizeSearchViewLayout(input.layout),
    favorite: optionalBoolean(input.favorite, 'Saved view favorite'),
    pinned: optionalBoolean(input.pinned, 'Saved view pinned'),
    isDefault: optionalBoolean(input.isDefault, 'Saved view default'),
  }
}

function normalizeUpdateSavedViewInput(input: UpdateSavedWorkspaceViewInput) {
  if (!input || typeof input !== 'object') {
    throw new WorkspaceSearchError(400, 'InvalidSavedView', 'Saved view update is required.')
  }
  return {
    expectedRevision: requirePositiveInteger(input.expectedRevision, 'Saved view revision'),
    ...(input.name === undefined ? {} : { name: requireText(input.name, 'Saved view name', 120) }),
    ...(input.description === undefined
      ? {}
      : { description: input.description === null ? null : optionalText(input.description, 'Saved view description', 1_000) ?? null }),
    ...(input.visibility === undefined ? {} : { visibility: requireSavedViewVisibility(input.visibility) }),
    ...(input.teamId === undefined
      ? {}
      : { teamId: input.teamId === null ? null : optionalText(input.teamId, 'Saved view Team ID', 256) ?? null }),
    ...(input.filters === undefined ? {} : { filters: normalizeWorkspaceSearchFilters(input.filters) }),
    ...(input.layout === undefined ? {} : { layout: normalizeSearchViewLayout(input.layout) }),
    ...(input.favorite === undefined ? {} : { favorite: optionalBoolean(input.favorite, 'Saved view favorite') as boolean }),
    ...(input.pinned === undefined ? {} : { pinned: optionalBoolean(input.pinned, 'Saved view pinned') as boolean }),
    ...(input.isDefault === undefined ? {} : { isDefault: optionalBoolean(input.isDefault, 'Saved view default') as boolean }),
  }
}

function normalizeSearchViewLayout(layout: SearchViewLayout) {
  if (!layout || typeof layout !== 'object' || !['table', 'board', 'calendar', 'timeline'].includes(layout.mode)) {
    throw new WorkspaceSearchError(400, 'InvalidSavedView', 'Saved view layout mode is invalid.')
  }
  if (!Array.isArray(layout.sort) || layout.sort.length > 10) {
    throw new WorkspaceSearchError(400, 'InvalidSavedView', 'Saved view sort is invalid.')
  }
  if (!Array.isArray(layout.columns) || layout.columns.length > 100) {
    throw new WorkspaceSearchError(400, 'InvalidSavedView', 'Saved view columns are invalid.')
  }
  return {
    mode: layout.mode,
    sort: layout.sort.map((sort) => {
      if (!sort || typeof sort !== 'object' || Array.isArray(sort)) {
        return invalidSavedView('Saved view sort rule is invalid.')
      }
      return {
        field: requireText(sort.field, 'Saved view sort field', 256),
        direction: sort.direction === 'asc' || sort.direction === 'desc'
          ? sort.direction
          : invalidSavedView('Saved view sort direction is invalid.'),
      }
    }),
    ...(optionalText(layout.groupBy, 'Saved view group field', 256) ? { groupBy: layout.groupBy } : {}),
    columns: normalizeStringList(layout.columns, 'Saved view columns', 100),
  } satisfies SearchViewLayout
}

/** Validates and normalizes a task view create payload. */
function normalizeCreateTaskViewInput(input: CreateSavedTaskViewInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalidTaskView('Task view input is required.')
  }
  const visibility = requireSavedViewVisibility(input.visibility)
  const teamId = optionalText(input.teamId, 'Task view Team ID', 256)
  validateVisibilityTeam(visibility, teamId)
  const definition = normalizeTaskViewDefinition(input.definition)
  requireTaskViewDefinitionSize(definition)
  return {
    name: requireText(input.name, 'Task view name', 120),
    description: optionalText(input.description, 'Task view description', 1_000),
    visibility,
    teamId,
    definition,
    favorite: optionalBoolean(input.favorite, 'Task view favorite'),
    pinned: optionalBoolean(input.pinned, 'Task view pinned'),
    defaultSource: input.defaultSource === undefined
      ? undefined
      : requireSavedTaskViewDefaultSource(input.defaultSource),
  }
}

/** Validates and normalizes a revision-guarded task view update payload. */
function normalizeUpdateTaskViewInput(input: UpdateSavedTaskViewInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalidTaskView('Task view update is required.')
  }
  if (input.defaultSource !== undefined && input.clearDefaultSource !== undefined) {
    return invalidTaskView('Task view default assignment and clearing are mutually exclusive.')
  }
  const definition = input.definition === undefined
    ? undefined
    : normalizeTaskViewDefinition(input.definition)
  if (definition) requireTaskViewDefinitionSize(definition)
  return {
    expectedRevision: requirePositiveInteger(input.expectedRevision, 'Task view revision'),
    ...(input.name === undefined
      ? {}
      : { name: requireText(input.name, 'Task view name', 120) }),
    ...(input.description === undefined
      ? {}
      : {
          description: input.description === null
            ? null
            : optionalText(input.description, 'Task view description', 1_000) ?? null,
        }),
    ...(input.visibility === undefined
      ? {}
      : { visibility: requireSavedViewVisibility(input.visibility) }),
    ...(input.teamId === undefined
      ? {}
      : {
          teamId: input.teamId === null
            ? null
            : optionalText(input.teamId, 'Task view Team ID', 256) ?? null,
        }),
    ...(definition === undefined ? {} : { definition }),
    ...(input.favorite === undefined
      ? {}
      : { favorite: requireBoolean(input.favorite, 'Task view favorite') }),
    ...(input.pinned === undefined
      ? {}
      : { pinned: requireBoolean(input.pinned, 'Task view pinned') }),
    ...(input.defaultSource === undefined
      ? {}
      : {
          defaultSource: input.defaultSource === null
            ? null
            : requireSavedTaskViewDefaultSource(input.defaultSource),
        }),
    ...(input.clearDefaultSource === undefined
      ? {}
      : { clearDefaultSource: requireSavedTaskViewDefaultSource(input.clearDefaultSource) }),
  }
}

/** Rejects definitions that cannot fit safely within the single-table DynamoDB item budget. */
function requireTaskViewDefinitionSize(definition: TaskViewDefinition): void {
  if (Buffer.byteLength(canonicalValue(definition), 'utf8') > TASK_VIEW_DEFINITION_MAX_BYTES) {
    invalidTaskView('Task view definition is too large.')
  }
}

/** Validates and normalizes task view duplicate metadata. */
function normalizeDuplicateTaskViewInput(input: DuplicateSavedTaskViewInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalidTaskView('Task view duplicate input is required.')
  }
  return {
    ...(input.name === undefined
      ? {}
      : { name: requireText(input.name, 'Task view name', 120) }),
    ...(input.description === undefined
      ? {}
      : {
          description: input.description === null
            ? null
            : optionalText(input.description, 'Task view description', 1_000) ?? null,
        }),
    ...(input.visibility === undefined
      ? {}
      : { visibility: requireSavedViewVisibility(input.visibility) }),
    ...(input.teamId === undefined
      ? {}
      : {
          teamId: input.teamId === null
            ? null
            : optionalText(input.teamId, 'Task view Team ID', 256) ?? null,
        }),
    ...(input.favorite === undefined
      ? {}
      : { favorite: requireBoolean(input.favorite, 'Task view favorite') }),
    ...(input.pinned === undefined
      ? {}
      : { pinned: requireBoolean(input.pinned, 'Task view pinned') }),
    ...(input.defaultSource === undefined
      ? {}
      : { defaultSource: requireSavedTaskViewDefaultSource(input.defaultSource) }),
  }
}

/** Derives a bounded copy label when duplicate input omits an explicit name. */
function createTaskViewCopyName(sourceName: string) {
  const suffix = ' copy'
  return `${sourceName.slice(0, 120 - suffix.length)}${suffix}`
}

/** Validates a complete task view definition and returns its canonical representation. */
function normalizeTaskViewDefinition(definition: unknown): TaskViewDefinition {
  if (!isRecordValue(definition)) {
    return invalidTaskView('Task view definition is required.')
  }
  const surface = requireTaskViewSurface(definition.surface)
  const scope = normalizeTaskViewScope(definition.scope)
  validateTaskViewSurfaceScope(surface, scope)
  return {
    surface,
    scope,
    filters: normalizeTaskViewFilters(definition.filters),
    layout: normalizeTaskViewLayout(definition.layout),
  }
}

/** Validates the resource scope used by a task view definition or list filter. */
function normalizeTaskViewScope(scope: unknown): TaskViewScope {
  if (!isRecordValue(scope)) {
    return invalidTaskView('Task view scope is invalid.')
  }
  if (scope.kind === 'workspace') return { kind: 'workspace' }
  if (scope.kind === 'viewer') return { kind: 'viewer' }
  if (scope.kind === 'team') {
    return { kind: 'team', teamId: requireText(scope.teamId, 'Task view scope Team ID', 256) }
  }
  if (scope.kind === 'project') {
    const teamId = optionalText(scope.teamId, 'Task view scope Team ID', 256)
    return {
      kind: 'project',
      projectId: requireText(scope.projectId, 'Task view scope Project ID', 256),
      ...(teamId ? { teamId } : {}),
    }
  }
  return invalidTaskView('Task view scope is invalid.')
}

/** Enforces the canonical product surface to resource scope mapping. */
function validateTaskViewSurfaceScope(surface: TaskViewSurface, scope: TaskViewScope) {
  const valid = surface === 'workspace-search'
    ? scope.kind === 'workspace'
    : surface === 'project'
      ? scope.kind === 'project'
      : surface === 'team'
        ? scope.kind === 'team'
        : surface === 'my-tasks' || surface === 'focus'
          ? scope.kind === 'viewer'
          : false
  if (!valid) invalidTaskView('Task view surface and scope do not match.')
}

/** Validates filters shared by all task surfaces. */
function normalizeTaskViewFilters(filters: unknown): TaskViewFilters {
  if (!isRecordValue(filters)) {
    return invalidTaskView('Task view filters are invalid.')
  }
  const base = normalizeWorkspaceSearchFilters(filters)
  const workflowStatuses = filters.workflowStatuses === undefined
    ? undefined
    : normalizeTaskViewWorkflowStatuses(filters.workflowStatuses)
  const workflowCategories = filters.workflowCategories === undefined
    ? undefined
    : normalizeTaskViewEnumList(
        filters.workflowCategories,
        isTaskViewWorkflowCategory,
        'Task view workflow categories',
      )
  const priorities = filters.priorities === undefined
    ? undefined
    : normalizeTaskViewEnumList(filters.priorities, isTaskViewPriority, 'Task view priorities')
  const dueDatePreset = filters.dueDatePreset === undefined
    ? undefined
    : requireTaskViewDueDatePreset(filters.dueDatePreset)
  return {
    ...base,
    ...(workflowStatuses ? { workflowStatuses } : {}),
    ...(workflowCategories ? { workflowCategories } : {}),
    ...(priorities ? { priorities } : {}),
    ...(dueDatePreset ? { dueDatePreset } : {}),
    ...(filters.includeArchived === undefined
      ? {}
      : { includeArchived: requireBoolean(filters.includeArchived, 'Task view include archived') }),
  }
}

/** Validates and deduplicates Team-qualified workflow status filters. */
function normalizeTaskViewWorkflowStatuses(
  values: unknown,
): NonNullable<TaskViewFilters['workflowStatuses']> {
  if (!Array.isArray(values) || values.length > 100) {
    return invalidTaskView('Task view workflow statuses are invalid.')
  }
  const normalized = values.map((value) => {
    if (!isRecordValue(value)) {
      return invalidTaskView('Task view workflow status is invalid.')
    }
    return {
      teamId: requireText(value.teamId, 'Task view workflow status Team ID', 256),
      statusId: requireText(value.statusId, 'Task view workflow status ID', 256),
    }
  })
  return [...new Map(normalized.map((value) => [createTaskViewStatusKey(
    value.teamId,
    value.statusId,
  ), value])).values()]
}

/** Validates and deduplicates a bounded string enum list. */
function normalizeTaskViewEnumList<TValue extends string>(
  values: unknown,
  isAllowed: (value: string) => value is TValue,
  label: string,
): TValue[] {
  if (!Array.isArray(values) || values.length > 100) invalidTaskView(`${label} are invalid.`)
  const normalized: TValue[] = []
  for (const value of values) {
    if (typeof value !== 'string' || !isAllowed(value)) invalidTaskView(`${label} are invalid.`)
    normalized.push(value)
  }
  return [...new Set(normalized)]
}

/** Validates a complete task view layout. */
function normalizeTaskViewLayout(layout: unknown): TaskViewLayout {
  if (!isRecordValue(layout)) {
    return invalidTaskView('Task view layout is invalid.')
  }
  const mode = requireTaskViewLayoutMode(layout.mode)
  if (!Array.isArray(layout.sort) || layout.sort.length > 10) {
    invalidTaskView('Task view sort is invalid.')
  }
  if (!Array.isArray(layout.columns) || layout.columns.length > 100) {
    invalidTaskView('Task view columns are invalid.')
  }
  const group = layout.group === undefined
    ? undefined
    : normalizeTaskViewGrouping(layout.group, 'Task view group')
  const subgroup = layout.subgroup === undefined
    ? undefined
    : normalizeTaskViewGrouping(layout.subgroup, 'Task view subgroup')
  const sort = layout.sort.map((rule) => normalizeTaskViewGrouping(rule, 'Task view sort'))
  const columns = layout.columns.map((column) => {
    if (!isRecordValue(column)) {
      return invalidTaskView('Task view column is invalid.')
    }
    const width = column.width === undefined
      ? undefined
      : requireTaskViewColumnWidth(column.width)
    const pin = column.pin === undefined ? undefined : requireTaskViewColumnPin(column.pin)
    return {
      field: requireText(column.field, 'Task view column field', 256),
      ...(width === undefined ? {} : { width }),
      ...(pin === undefined ? {} : { pin }),
    }
  })
  const density = requireTaskViewDensity(layout.density)
  return {
    mode,
    ...(group ? { group } : {}),
    ...(subgroup ? { subgroup } : {}),
    sort,
    columns,
    density,
    displayOptions: normalizeTaskViewDisplayOptions(layout.displayOptions),
  }
}

/** Validates one grouping or sort field and direction. */
function normalizeTaskViewGrouping(
  value: unknown,
  label: string,
): NonNullable<TaskViewLayout['group']> {
  if (!isRecordValue(value)) {
    return invalidTaskView(`${label} is invalid.`)
  }
  const direction = requireTaskViewSortDirection(value.direction, label)
  return {
    field: requireText(value.field, `${label} field`, 256),
    direction,
  }
}

/** Validates the bounded persisted width of one task view column. */
function requireTaskViewColumnWidth(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 40 || value > 2_000) {
    return invalidTaskView('Task view column width is invalid.')
  }
  return value
}

/** Validates every supported task view display option. */
function normalizeTaskViewDisplayOptions(options: unknown) {
  if (!isRecordValue(options)) {
    return invalidTaskView('Task view display options are invalid.')
  }
  const normalized: TaskViewLayout['displayOptions'] = {}
  for (const key of taskViewDisplayOptionKeys) {
    if (options[key] !== undefined) normalized[key] = requireBoolean(options[key], `Task view ${key}`)
  }
  return normalized
}

/** Reads one supported task view surface from an untrusted boundary. */
function requireTaskViewSurface(value: unknown): TaskViewSurface {
  if (
    value === 'workspace-search' ||
    value === 'project' ||
    value === 'team' ||
    value === 'my-tasks' ||
    value === 'focus' ||
    value === 'triage'
  ) return value
  return invalidTaskView('Task view surface is invalid.')
}

/** Reads one supported task view layout mode. */
function requireTaskViewLayoutMode(value: unknown): TaskViewLayout['mode'] {
  if (
    value === 'table' ||
    value === 'board' ||
    value === 'list' ||
    value === 'gantt' ||
    value === 'calendar' ||
    value === 'timeline'
  ) return value
  return invalidTaskView('Task view layout mode is invalid.')
}

/** Reads one supported task view density. */
function requireTaskViewDensity(value: unknown): TaskViewLayout['density'] {
  if (value === 'compact' || value === 'comfortable' || value === 'spacious') return value
  return invalidTaskView('Task view density is invalid.')
}

/** Reads one supported task view column pin. */
function requireTaskViewColumnPin(value: unknown): NonNullable<TaskViewLayout['columns'][number]['pin']> {
  if (value === 'start' || value === 'end') return value
  return invalidTaskView('Task view column pin is invalid.')
}

/** Reads one supported task view sort direction. */
function requireTaskViewSortDirection(
  value: unknown,
  label: string,
): TaskViewLayout['sort'][number]['direction'] {
  if (value === 'asc' || value === 'desc') return value
  return invalidTaskView(`${label} direction is invalid.`)
}

/** Reads one mutable default source from an untrusted boundary. */
function requireSavedTaskViewDefaultSource(value: unknown): SavedTaskViewDefaultSource {
  if (value === 'personal' || value === 'team') return value
  return invalidTaskView('Task view default source is invalid.')
}

/**
 * Reads one strict current or legacy Workspace Search projection.
 *
 * Legacy rows may omit `projectionDigest`; when present, the digest must match
 * the complete normalized projection or the read fails closed.
 *
 * @param value - Untrusted persisted projection fields.
 * @returns Fully normalized document with its server-owned current digest.
 */
export function readWorkspaceSearchDocument(
  value: Record<string, unknown>,
): WorkspaceSearchDocument {
  if (value.schemaVersion !== SEARCH_SCHEMA_VERSION || value.entryType !== 'search-document') {
    throw new WorkspaceSearchError(503, 'InvalidSearchDocument', 'Search index contains an invalid document.')
  }
  try {
    const document = createWorkspaceSearchDocument(value as WorkspaceSearchDocument)
    if (
      value.projectionDigest !== undefined
      && value.projectionDigest !== document.projectionDigest
    ) {
      throw new WorkspaceSearchProjectionDigestMismatchError(
        503,
        'InvalidSearchDocument',
        'Search index projection digest is invalid.',
      )
    }
    return document
  } catch (error) {
    if (error instanceof WorkspaceSearchProjectionDigestMismatchError) {
      throw error
    }
    throw new WorkspaceSearchError(
      503,
      'InvalidSearchDocument',
      'Search index contains an invalid document.',
      { cause: error },
    )
  }
}

function readWorkspaceSearchDocumentSafely(value: Record<string, unknown>) {
  try {
    return readWorkspaceSearchDocument(value)
  } catch (error) {
    if (error instanceof WorkspaceSearchProjectionDigestMismatchError) {
      throw error
    }
    console.error('Workspace search skipped an invalid index document.', error)
    return undefined
  }
}

function readStoredSavedWorkspaceView(value: Record<string, unknown>) {
  if (
    value.entryType !== 'saved-view' ||
    (value.schemaVersion !== undefined && value.schemaVersion !== 0 && value.schemaVersion !== SAVED_VIEW_SCHEMA_VERSION)
  ) {
    throw new WorkspaceSearchError(503, 'InvalidSavedView', 'Saved view data is invalid.')
  }
  try {
    const input = value as StoredSavedWorkspaceView
    const legacyLayout = input.layout ?? {
      mode: 'table',
      sort: [],
      columns: ['title'],
    } satisfies SearchViewLayout
    const id = requireIdentifier(input.id, 'Saved view ID')
    const visibility = requireSavedViewVisibility(input.visibility)
    const teamId = optionalText(input.teamId, 'Saved view Team ID', 256)
    const description = optionalText(input.description, 'Saved view description', 1_000)
    validateVisibilityTeam(visibility, teamId)
    if (input.recordKey !== createSavedWorkspaceViewRecordKey(id)) {
      invalidSavedView('Saved view record key does not match its ID.')
    }
    return {
      ...input,
      schemaVersion: SAVED_VIEW_SCHEMA_VERSION,
      workspaceId: requireText(input.workspaceId, 'Saved view Workspace ID'),
      recordKey: input.recordKey,
      id,
      name: requireText(input.name, 'Saved view name', 120),
      ...(description ? { description } : { description: undefined }),
      visibility,
      ownerUserId: requireText(input.ownerUserId, 'Saved view owner ID'),
      ...(teamId ? { teamId } : {}),
      filters: normalizeWorkspaceSearchFilters(input.filters ?? {}),
      layout: normalizeSearchViewLayout(legacyLayout),
      revision: requirePositiveInteger(input.revision ?? 1, 'Saved view revision'),
      createdAt: requireText(input.createdAt, 'Saved view createdAt', 128),
      updatedAt: requireText(input.updatedAt, 'Saved view updatedAt', 128),
    } satisfies StoredSavedWorkspaceView
  } catch (error) {
    if (error instanceof WorkspaceSearchError && error.status === 503) throw error
    throw new WorkspaceSearchError(503, 'InvalidSavedView', 'Saved view data is invalid.', {
      cause: error,
    })
  }
}

function readStoredSavedViewPreference(value: Record<string, unknown>) {
  if (
    value.entryType !== 'saved-view-preference' ||
    value.schemaVersion !== SAVED_VIEW_SCHEMA_VERSION ||
    typeof value.workspaceId !== 'string' ||
    typeof value.recordKey !== 'string' ||
    typeof value.viewId !== 'string' ||
    typeof value.userId !== 'string' ||
    typeof value.favorite !== 'boolean' ||
    typeof value.pinned !== 'boolean' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new WorkspaceSearchError(503, 'InvalidSavedView', 'Saved view preference is invalid.')
  }
  return value as StoredSavedViewPreference
}

function readStoredDefaultView(value: Record<string, unknown>) {
  if (
    value.entryType !== 'saved-view-default' ||
    value.schemaVersion !== SAVED_VIEW_SCHEMA_VERSION ||
    typeof value.workspaceId !== 'string' ||
    typeof value.recordKey !== 'string' ||
    typeof value.userId !== 'string' ||
    typeof value.viewId !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new WorkspaceSearchError(503, 'InvalidSavedView', 'Default saved view marker is invalid.')
  }
  return value as StoredDefaultView
}

/** Reads and validates one durable task view deletion tombstone. */
function readStoredTaskViewTombstone(value: Record<string, unknown>): StoredTaskViewTombstone {
  if (
    value.entryType !== TASK_VIEW_TOMBSTONE_ENTRY_TYPE ||
    value.schemaVersion !== TASK_VIEW_SCHEMA_VERSION ||
    typeof value.workspaceId !== 'string' ||
    typeof value.recordKey !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.deletedAt !== 'string'
  ) {
    throw invalidStoredTaskView()
  }
  try {
    const id = requireIdentifier(value.id, 'Task view ID')
    const createIdempotencyKeyHash = optionalText(
      value.createIdempotencyKeyHash,
      'Task view idempotency hash',
      256,
    )
    const createRequestFingerprint = optionalText(
      value.createRequestFingerprint,
      'Task view request fingerprint',
      256,
    )
    if (value.recordKey !== createTaskViewTombstoneRecordKey(id)) {
      throw invalidStoredTaskView()
    }
    return {
      schemaVersion: TASK_VIEW_SCHEMA_VERSION,
      workspaceId: requireText(value.workspaceId, 'Task view Workspace ID'),
      recordKey: value.recordKey,
      entryType: TASK_VIEW_TOMBSTONE_ENTRY_TYPE,
      id,
      revision: requirePositiveInteger(value.revision, 'Task view revision'),
      ...(createIdempotencyKeyHash ? { createIdempotencyKeyHash } : {}),
      ...(createRequestFingerprint ? { createRequestFingerprint } : {}),
      deletedAt: requireText(value.deletedAt, 'Task view deletedAt', 128),
    }
  } catch (error) {
    if (error instanceof WorkspaceSearchError && error.status === 503) throw error
    throw new WorkspaceSearchError(503, 'InvalidTaskView', 'Task view data is invalid.', {
      cause: error,
    })
  }
}

/** Reads and validates one persisted task view definition row. */
function readStoredTaskView(value: Record<string, unknown>): StoredTaskView {
  if (
    value.entryType !== 'task-view' ||
    value.schemaVersion !== TASK_VIEW_SCHEMA_VERSION ||
    typeof value.workspaceId !== 'string' ||
    typeof value.recordKey !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.ownerUserId !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw invalidStoredTaskView()
  }
  try {
    const id = requireIdentifier(value.id, 'Task view ID')
    const visibility = requireSavedViewVisibility(value.visibility)
    const teamId = optionalText(value.teamId, 'Task view Team ID', 256)
    const description = optionalText(value.description, 'Task view description', 1_000)
    const createIdempotencyKeyHash = optionalText(
      value.createIdempotencyKeyHash,
      'Task view idempotency hash',
      256,
    )
    const createRequestFingerprint = optionalText(
      value.createRequestFingerprint,
      'Task view request fingerprint',
      256,
    )
    validateVisibilityTeam(visibility, teamId)
    if (value.recordKey !== createTaskViewRecordKey(id)) {
      return invalidTaskView('Task view record key does not match its ID.')
    }
    return {
      schemaVersion: TASK_VIEW_SCHEMA_VERSION,
      workspaceId: requireText(value.workspaceId, 'Task view Workspace ID'),
      recordKey: value.recordKey,
      entryType: 'task-view',
      id,
      name: requireText(value.name, 'Task view name', 120),
      ...(description ? { description } : {}),
      visibility,
      ownerUserId: requireText(value.ownerUserId, 'Task view owner ID'),
      ...(createIdempotencyKeyHash ? { createIdempotencyKeyHash } : {}),
      ...(createRequestFingerprint ? { createRequestFingerprint } : {}),
      ...(teamId ? { teamId } : {}),
      definition: normalizeTaskViewDefinition(value.definition),
      revision: requirePositiveInteger(value.revision, 'Task view revision'),
      createdAt: requireText(value.createdAt, 'Task view createdAt', 128),
      updatedAt: requireText(value.updatedAt, 'Task view updatedAt', 128),
    }
  } catch (error) {
    if (error instanceof WorkspaceSearchError && error.status === 503) throw error
    throw new WorkspaceSearchError(503, 'InvalidTaskView', 'Task view data is invalid.', {
      cause: error,
    })
  }
}

/** Reads and validates one persisted viewer task view preference row. */
function readStoredTaskViewPreference(value: Record<string, unknown>): StoredTaskViewPreference {
  if (
    value.entryType !== 'task-view-preference' ||
    value.schemaVersion !== TASK_VIEW_SCHEMA_VERSION ||
    typeof value.workspaceId !== 'string' ||
    typeof value.recordKey !== 'string' ||
    typeof value.viewId !== 'string' ||
    typeof value.userId !== 'string' ||
    typeof value.favorite !== 'boolean' ||
    typeof value.pinned !== 'boolean' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw invalidStoredTaskView()
  }
  try {
    if (value.recordKey !== createTaskViewPreferenceRecordKey(value.userId, value.viewId)) {
      throw invalidStoredTaskView()
    }
  } catch (error) {
    if (error instanceof WorkspaceSearchError && error.status === 503) throw error
    throw new WorkspaceSearchError(503, 'InvalidTaskView', 'Task view data is invalid.', {
      cause: error,
    })
  }
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    workspaceId: value.workspaceId,
    recordKey: value.recordKey,
    entryType: 'task-view-preference',
    viewId: value.viewId,
    userId: value.userId,
    favorite: value.favorite,
    pinned: value.pinned,
    updatedAt: value.updatedAt,
  }
}

/** Reads and validates one persisted personal or Team default marker. */
function readStoredTaskViewDefault(value: Record<string, unknown>): StoredTaskViewDefault {
  if (
    value.entryType !== 'task-view-default' ||
    value.schemaVersion !== TASK_VIEW_SCHEMA_VERSION ||
    typeof value.workspaceId !== 'string' ||
    typeof value.recordKey !== 'string' ||
    (value.ownerType !== 'personal' && value.ownerType !== 'team') ||
    typeof value.viewId !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw invalidStoredTaskView()
  }
  try {
    const surface = requireStoredTaskViewSurface(value.surface)
    const scope = readStoredTaskViewScope(value.scope)
    const userId = optionalStoredText(value.userId)
    const teamId = optionalStoredText(value.teamId)
    const generation = value.generation === undefined
      ? undefined
      : requireIdentifier(value.generation, 'Task view default generation')
    const viewId = requireIdentifier(value.viewId, 'Task view default view ID')
    if (
      (value.ownerType === 'personal' && (!userId || teamId)) ||
      (value.ownerType === 'team' && (!teamId || userId)) ||
      value.recordKey !== createTaskViewDefaultRecordKey(
        value.ownerType,
        userId ?? '',
        teamId,
        surface,
        scope,
      )
    ) {
      throw invalidStoredTaskView()
    }
    return {
      schemaVersion: TASK_VIEW_SCHEMA_VERSION,
      workspaceId: requireText(value.workspaceId, 'Task view default Workspace ID'),
      recordKey: value.recordKey,
      entryType: 'task-view-default',
      ownerType: value.ownerType,
      ...(userId ? { userId } : {}),
      ...(teamId ? { teamId } : {}),
      surface,
      scope,
      viewId,
      ...(generation ? { generation } : {}),
      updatedAt: requireText(value.updatedAt, 'Task view default updatedAt', 128),
    }
  } catch (error) {
    if (error instanceof WorkspaceSearchError && error.status === 503) throw error
    throw new WorkspaceSearchError(503, 'InvalidTaskView', 'Task view data is invalid.', {
      cause: error,
    })
  }
}

/** Reads and validates one durable task view mutation receipt. */
function readStoredTaskViewMutationReceipt(
  value: Record<string, unknown>,
): StoredTaskViewMutationReceipt {
  if (
    value.entryType !== 'task-view-mutation-receipt' ||
    value.schemaVersion !== TASK_VIEW_SCHEMA_VERSION ||
    typeof value.workspaceId !== 'string' ||
    typeof value.recordKey !== 'string' ||
    (value.operation !== 'update' && value.operation !== 'delete') ||
    typeof value.viewId !== 'string' ||
    typeof value.actorUserId !== 'string' ||
    typeof value.idempotencyKeyHash !== 'string' ||
    typeof value.requestFingerprint !== 'string' ||
    typeof value.resultRevision !== 'number' ||
    typeof value.committedAt !== 'string' ||
    typeof value.expiresAt !== 'number'
  ) {
    throw invalidStoredTaskView()
  }
  try {
    const idempotencyKeyHash = requireText(
      value.idempotencyKeyHash,
      'Task view mutation idempotency hash',
      256,
    )
    const requestFingerprint = requireText(
      value.requestFingerprint,
      'Task view mutation request fingerprint',
      256,
    )
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(idempotencyKeyHash) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(requestFingerprint) ||
      value.recordKey !== createTaskViewMutationReceiptRecordKey(idempotencyKeyHash)
    ) {
      throw invalidStoredTaskView()
    }
    const committedAt = requireText(
      value.committedAt,
      'Task view mutation committedAt',
      128,
    )
    const expiresAt = requirePositiveInteger(
      value.expiresAt,
      'Task view mutation expiresAt',
    )
    if (expiresAt !== createTaskViewMutationReceiptExpiresAt(committedAt)) {
      throw invalidStoredTaskView()
    }
    return {
      schemaVersion: TASK_VIEW_SCHEMA_VERSION,
      workspaceId: requireText(value.workspaceId, 'Task view mutation Workspace ID'),
      recordKey: value.recordKey,
      entryType: 'task-view-mutation-receipt',
      operation: value.operation,
      viewId: requireIdentifier(value.viewId, 'Task view mutation view ID'),
      actorUserId: requireText(value.actorUserId, 'Task view mutation actor ID'),
      idempotencyKeyHash,
      requestFingerprint,
      resultRevision: requirePositiveInteger(
        value.resultRevision,
        'Task view mutation result revision',
      ),
      committedAt,
      expiresAt,
    }
  } catch (error) {
    if (error instanceof WorkspaceSearchError && error.status === 503) throw error
    throw new WorkspaceSearchError(503, 'InvalidTaskView', 'Task view data is invalid.', {
      cause: error,
    })
  }
}

function createSearchQueryFingerprint(filters: WorkspaceSearchFilters) {
  return createHash('sha256').update(canonicalValue(filters)).digest('base64url')
}

/** Creates the query fingerprint that binds task view cursors to surface and scope filters. */
function createTaskViewListFingerprint(
  surface: TaskViewSurface | undefined,
  scope: TaskViewScope | undefined,
) {
  return createHash('sha256').update(canonicalValue({ surface, scope })).digest('base64url')
}

function decodeSearchCursor(
  value: string | undefined,
  workspaceId: string,
  viewerUserId: string,
  queryFingerprint: string,
) {
  if (!value) return undefined
  const cursor = decodeCursor(value)
  if (
    cursor.kind !== 'search' ||
    cursor.workspaceId !== workspaceId ||
    cursor.viewerUserId !== viewerUserId ||
    cursor.queryFingerprint !== queryFingerprint ||
    typeof cursor.recordKey !== 'string' ||
    !cursor.recordKey.startsWith(WORKSPACE_SEARCH_DOCUMENT_PREFIX)
  ) {
    throw new WorkspaceSearchError(400, 'InvalidSearchCursor', 'Search cursor is invalid for this query.')
  }
  return cursor as SearchCursor
}

function decodeSavedViewCursor(value: string | undefined, workspaceId: string, viewerUserId: string) {
  if (!value) return undefined
  const cursor = decodeCursor(value)
  if (
    cursor.kind !== 'saved-views' ||
    cursor.workspaceId !== workspaceId ||
    cursor.viewerUserId !== viewerUserId ||
    typeof cursor.recordKey !== 'string' ||
    !cursor.recordKey.startsWith(WORKSPACE_SAVED_VIEW_PREFIX)
  ) {
    throw new WorkspaceSearchError(400, 'InvalidSavedViewCursor', 'Saved view cursor is invalid.')
  }
  return cursor as SavedViewCursor
}

/** Decodes and verifies a task view cursor against its viewer and list filter. */
function decodeTaskViewCursor(
  value: string | undefined,
  workspaceId: string,
  viewerUserId: string,
  queryFingerprint: string,
) {
  if (!value) return undefined
  const cursor = decodeCursor(value)
  if (
    cursor.kind !== 'task-views' ||
    cursor.workspaceId !== workspaceId ||
    cursor.viewerUserId !== viewerUserId ||
    cursor.queryFingerprint !== queryFingerprint ||
    typeof cursor.recordKey !== 'string' ||
    !cursor.recordKey.startsWith(WORKSPACE_TASK_VIEW_PREFIX)
  ) {
    throw new WorkspaceSearchError(400, 'InvalidTaskViewCursor', 'Task view cursor is invalid.')
  }
  return {
    version: 1,
    kind: 'task-views',
    workspaceId,
    viewerUserId,
    queryFingerprint,
    recordKey: cursor.recordKey,
  } satisfies TaskViewCursor
}

function encodeCursor(value: SearchCursor | SavedViewCursor | TaskViewCursor) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (parsed.version !== 1) throw new TypeError('Unsupported cursor version.')
    return parsed
  } catch (error) {
    throw new WorkspaceSearchError(400, 'InvalidSearchCursor', 'Cursor is invalid.', { cause: error })
  }
}

function createSavedViewPreferencePrefix(userId: string) {
  return `${WORKSPACE_SAVED_VIEW_PREFERENCE_PREFIX}${encodeKeyPart(requireText(userId, 'Saved view user ID'))}#`
}

function createSavedViewPreferenceRecordKey(userId: string, viewId: string) {
  return `${createSavedViewPreferencePrefix(userId)}${requireIdentifier(viewId, 'Saved view ID')}`
}

function createSavedViewDefaultRecordKey(userId: string) {
  return `${WORKSPACE_SAVED_VIEW_DEFAULT_PREFIX}${encodeKeyPart(requireText(userId, 'Saved view user ID'))}`
}

/** Creates the canonical prefix for one task view default marker owner. */
function createTaskViewDefaultOwnerPrefix(
  ownerType: StoredTaskViewDefaultOwner,
  userId: string,
  teamId: string | undefined,
) {
  const ownerId = ownerType === 'personal'
    ? requireText(userId, 'Task view default user ID')
    : requireText(teamId, 'Task view default Team ID')
  return `${WORKSPACE_TASK_VIEW_DEFAULT_PREFIX}${ownerType.toUpperCase()}#${encodeKeyPart(ownerId)}#`
}

/** Creates the canonical default marker key for one owner and task view context. */
function createTaskViewDefaultRecordKey(
  ownerType: StoredTaskViewDefaultOwner,
  userId: string,
  teamId: string | undefined,
  surface: TaskViewSurface,
  scope: TaskViewScope,
) {
  const contextHash = createHash('sha256')
    .update(createTaskViewContextKey(surface, scope))
    .digest('base64url')
  return `${createTaskViewDefaultOwnerPrefix(ownerType, userId, teamId)}${contextHash}`
}

/** Creates the canonical prefix for one viewer's task view preferences. */
function createTaskViewPreferencePrefix(userId: string) {
  return `${WORKSPACE_TASK_VIEW_PREFERENCE_PREFIX}${encodeKeyPart(
    requireText(userId, 'Task view user ID'),
  )}#`
}

/** Creates the canonical task view preference key for one viewer and view. */
function createTaskViewPreferenceRecordKey(userId: string, viewId: string) {
  return `${createTaskViewPreferencePrefix(userId)}${requireIdentifier(viewId, 'Task view ID')}`
}

/** Creates the operation-bound deterministic task view ID for idempotent create retries. */
function createTaskViewIdempotencyHash(
  workspaceId: string,
  ownerUserId: string,
  idempotencyKey: string,
) {
  return createHash('sha256')
    .update(`task-view-create\0${workspaceId}\0${ownerUserId}\0${idempotencyKey}`)
    .digest('base64url')
}

/**
 * Creates an operation-bound hash for one task view mutation idempotency key.
 *
 * @param workspaceId - Workspace that owns the mutation.
 * @param actorUserId - Current actor that owns the caller key.
 * @param operation - Mutation operation bound to the key.
 * @param viewId - Stable target task view ID.
 * @param idempotencyKey - Validated caller-provided key.
 * @returns A collision-resistant hash that does not persist the raw key.
 */
function createTaskViewMutationIdempotencyHash(
  workspaceId: string,
  actorUserId: string,
  operation: TaskViewMutationOperation,
  viewId: string,
  idempotencyKey: string,
) {
  return createHash('sha256')
    .update(
      `task-view-mutation:v1\0${workspaceId}\0${actorUserId}\0${operation}\0${viewId}\0${idempotencyKey}`,
    )
    .digest('base64url')
}

/**
 * Creates the single-table record key for a task view mutation receipt.
 *
 * @param idempotencyKeyHash - Operation-bound caller-key hash.
 * @returns Canonical receipt sort key.
 */
function createTaskViewMutationReceiptRecordKey(idempotencyKeyHash: string) {
  return `${WORKSPACE_TASK_VIEW_MUTATION_RECEIPT_PREFIX}${requireText(
    idempotencyKeyHash,
    'Task view mutation idempotency hash',
    256,
  )}`
}

/** Creates a stable fingerprint for one idempotent task view operation payload. */
function createTaskViewRequestFingerprint(input: unknown) {
  return createHash('sha256').update(canonicalValue(input)).digest('base64url')
}

/**
 * Calculates the application replay deadline and DynamoDB TTL for a mutation receipt.
 *
 * @param committedAt - ISO timestamp at which the mutation transaction commits.
 * @returns Epoch seconds exactly 24 hours after the commit timestamp.
 */
function createTaskViewMutationReceiptExpiresAt(committedAt: string) {
  const committedAtMilliseconds = Date.parse(committedAt)
  if (!Number.isFinite(committedAtMilliseconds)) {
    throw invalidTaskView('Task view mutation committedAt is invalid.')
  }
  return Math.floor(committedAtMilliseconds / 1_000) +
    TASK_VIEW_MUTATION_RECEIPT_TTL_SECONDS
}

/**
 * Creates a durable receipt committed atomically with one task view mutation.
 *
 * @param workspaceId - Workspace that owns the mutation.
 * @param operation - Mutation operation to replay.
 * @param viewId - Stable target task view ID.
 * @param actorUserId - Current actor that owns the idempotency key.
 * @param idempotencyKeyHash - Operation-bound caller-key hash.
 * @param requestFingerprint - Canonical normalized request fingerprint.
 * @param resultRevision - Revision acknowledged by the mutation.
 * @param committedAt - Mutation commit timestamp.
 * @returns A validated receipt row ready for a transactional put.
 */
function createStoredTaskViewMutationReceipt(
  workspaceId: string,
  operation: TaskViewMutationOperation,
  viewId: string,
  actorUserId: string,
  idempotencyKeyHash: string,
  requestFingerprint: string,
  resultRevision: number,
  committedAt: string,
): StoredTaskViewMutationReceipt {
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    workspaceId,
    recordKey: createTaskViewMutationReceiptRecordKey(idempotencyKeyHash),
    entryType: 'task-view-mutation-receipt',
    operation,
    viewId,
    actorUserId,
    idempotencyKeyHash,
    requestFingerprint,
    resultRevision,
    committedAt,
    expiresAt: createTaskViewMutationReceiptExpiresAt(committedAt),
  }
}

/**
 * Creates a transactional write for one unexpired task view mutation receipt.
 *
 * @param tableName - Workspace Search table name.
 * @param receipt - Receipt committed with the domain mutation.
 * @returns A conditional transactional put that overwrites only an expired receipt.
 */
function createTaskViewMutationReceiptTransactionItem(
  tableName: string,
  receipt: StoredTaskViewMutationReceipt,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  return {
    Put: {
      TableName: tableName,
      Item: receipt,
      ConditionExpression: 'attribute_not_exists(#workspaceId) OR #expiresAt <= :issuedAt',
      ExpressionAttributeNames: {
        '#workspaceId': 'workspaceId',
        '#expiresAt': 'expiresAt',
      },
      ExpressionAttributeValues: {
        ':issuedAt': receipt.expiresAt - TASK_VIEW_MUTATION_RECEIPT_TTL_SECONDS,
      },
    },
  }
}

/** Creates one persisted viewer preference row for a task view. */
function createStoredTaskViewPreference(
  workspaceId: string,
  userId: string,
  viewId: string,
  favorite: boolean,
  pinned: boolean,
  updatedAt: string,
): StoredTaskViewPreference {
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    workspaceId,
    recordKey: createTaskViewPreferenceRecordKey(userId, viewId),
    entryType: 'task-view-preference',
    viewId,
    userId,
    favorite,
    pinned,
    updatedAt,
  }
}

/** Creates one persisted personal or Team default marker. */
function createStoredTaskViewDefault(
  workspaceId: string,
  ownerType: StoredTaskViewDefaultOwner,
  userId: string,
  teamId: string | undefined,
  surface: TaskViewSurface,
  scope: TaskViewScope,
  viewId: string,
  updatedAt: string,
): StoredTaskViewDefault {
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    workspaceId,
    recordKey: createTaskViewDefaultRecordKey(
      ownerType,
      userId,
      teamId,
      surface,
      scope,
    ),
    entryType: 'task-view-default',
    ownerType,
    ...(ownerType === 'personal'
      ? { userId: requireText(userId, 'Task view default user ID') }
      : { teamId: requireText(teamId, 'Task view default Team ID') }),
    surface,
    scope,
    viewId: requireIdentifier(viewId, 'Task view ID'),
    generation: randomUUID(),
    updatedAt,
  }
}

/** Creates an atomic partial viewer preference update for a task view. */
function createTaskViewPreferenceUpdateTransactionItem(
  tableName: string,
  preference: StoredTaskViewPreference,
  favorite: boolean | undefined,
  pinned: boolean | undefined,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const favoriteValue = favorite === undefined
    ? 'if_not_exists(#favorite, :false)'
    : ':favorite'
  const pinnedValue = pinned === undefined
    ? 'if_not_exists(#pinned, :false)'
    : ':pinned'
  return {
    Update: {
      TableName: tableName,
      Key: { workspaceId: preference.workspaceId, recordKey: preference.recordKey },
      UpdateExpression:
        'SET #schemaVersion = :schemaVersion, #entryType = :entryType, ' +
        '#viewId = :viewId, #userId = :userId, ' +
        `#favorite = ${favoriteValue}, #pinned = ${pinnedValue}, #updatedAt = :updatedAt`,
      ExpressionAttributeNames: {
        '#schemaVersion': 'schemaVersion',
        '#entryType': 'entryType',
        '#viewId': 'viewId',
        '#userId': 'userId',
        '#favorite': 'favorite',
        '#pinned': 'pinned',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':schemaVersion': TASK_VIEW_SCHEMA_VERSION,
        ':entryType': 'task-view-preference',
        ':viewId': preference.viewId,
        ':userId': preference.userId,
        ':false': false,
        ...(favorite === undefined ? {} : { ':favorite': favorite }),
        ...(pinned === undefined ? {} : { ':pinned': pinned }),
        ':updatedAt': preference.updatedAt,
      },
    },
  }
}

/** Guards or removes a default marker only when its observed target is unchanged. */
function createTaskViewDefaultGuardTransactionItem(
  tableName: string,
  workspaceId: string,
  ownerType: StoredTaskViewDefaultOwner,
  userId: string,
  teamId: string | undefined,
  surface: TaskViewSurface,
  scope: TaskViewScope,
  viewId: string,
  currentDefault: StoredTaskViewDefault | undefined,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const key = {
    workspaceId,
    recordKey: createTaskViewDefaultRecordKey(
      ownerType,
      userId,
      teamId,
      surface,
      scope,
    ),
  }
  const generationCondition = currentDefault
    ? createTaskViewDefaultGenerationCondition(currentDefault)
    : undefined
  if (currentDefault?.viewId === viewId) {
    if (!generationCondition) throw invalidStoredTaskView()
    return {
      Delete: {
        TableName: tableName,
        Key: key,
        ConditionExpression: `#viewId = :viewId AND ${generationCondition.expression}`,
        ExpressionAttributeNames: {
          '#viewId': 'viewId',
          ...generationCondition.names,
        },
        ExpressionAttributeValues: {
          ':viewId': viewId,
          ...generationCondition.values,
        },
      },
    }
  }
  if (currentDefault) {
    if (!generationCondition) throw invalidStoredTaskView()
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: key,
        ConditionExpression:
          `#viewId = :expectedDefaultViewId AND ${generationCondition.expression}`,
        ExpressionAttributeNames: {
          '#viewId': 'viewId',
          ...generationCondition.names,
        },
        ExpressionAttributeValues: {
          ':expectedDefaultViewId': currentDefault.viewId,
          ...generationCondition.values,
        },
      },
    }
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: key,
      ConditionExpression: 'attribute_not_exists(#viewId)',
      ExpressionAttributeNames: { '#viewId': 'viewId' },
    },
  }
}

/**
 * Creates a marker-generation condition with a legacy timestamp fallback.
 *
 * @param marker - Persisted marker generation observed by the current operation.
 * @returns DynamoDB condition fragments that reject a replacement marker.
 */
function createTaskViewDefaultGenerationCondition(marker: StoredTaskViewDefault) {
  if (marker.generation) {
    const names: Record<string, string> = { '#generation': 'generation' }
    const values: Record<string, unknown> = { ':generation': marker.generation }
    return { expression: '#generation = :generation', names, values }
  }
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' }
  const values: Record<string, unknown> = { ':updatedAt': marker.updatedAt }
  return { expression: '#updatedAt = :updatedAt', names, values }
}

function createSavedViewIdempotencyHash(
  workspaceId: string,
  ownerUserId: string,
  idempotencyKey: string,
) {
  return createHash('sha256')
    .update(`${workspaceId}\0${ownerUserId}\0${idempotencyKey}`)
    .digest('base64url')
}

/** Viewer 固有の favorite / pin preference row を組み立てます。 */
function createStoredSavedViewPreference(
  workspaceId: string,
  userId: string,
  viewId: string,
  favorite: boolean,
  pinned: boolean,
  updatedAt: string,
): StoredSavedViewPreference {
  return {
    schemaVersion: SAVED_VIEW_SCHEMA_VERSION,
    workspaceId,
    recordKey: createSavedViewPreferenceRecordKey(userId, viewId),
    entryType: 'saved-view-preference',
    viewId,
    userId,
    favorite,
    pinned,
    updatedAt,
  }
}

/**
 * Viewer preference の指定された field だけを atomic に更新します。
 */
function createSavedViewPreferenceUpdateTransactionItem(
  tableName: string,
  preference: StoredSavedViewPreference,
  favorite: boolean | undefined,
  pinned: boolean | undefined,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const favoriteValue = favorite === undefined
    ? 'if_not_exists(#favorite, :false)'
    : ':favorite'
  const pinnedValue = pinned === undefined
    ? 'if_not_exists(#pinned, :false)'
    : ':pinned'
  return {
    Update: {
      TableName: tableName,
      Key: {
        workspaceId: preference.workspaceId,
        recordKey: preference.recordKey,
      },
      UpdateExpression:
        'SET #schemaVersion = :schemaVersion, #entryType = :entryType, ' +
        '#viewId = :viewId, #userId = :userId, ' +
        `#favorite = ${favoriteValue}, #pinned = ${pinnedValue}, #updatedAt = :updatedAt`,
      ExpressionAttributeNames: {
        '#schemaVersion': 'schemaVersion',
        '#entryType': 'entryType',
        '#viewId': 'viewId',
        '#userId': 'userId',
        '#favorite': 'favorite',
        '#pinned': 'pinned',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':schemaVersion': SAVED_VIEW_SCHEMA_VERSION,
        ':entryType': 'saved-view-preference',
        ':viewId': preference.viewId,
        ':userId': preference.userId,
        ':false': false,
        ...(favorite === undefined ? {} : { ':favorite': favorite }),
        ...(pinned === undefined ? {} : { ':pinned': pinned }),
        ':updatedAt': preference.updatedAt,
      },
    },
  }
}

/** Viewer 固有の default view marker row を組み立てます。 */
function createStoredDefaultView(
  workspaceId: string,
  userId: string,
  viewId: string,
  updatedAt: string,
): StoredDefaultView {
  return {
    schemaVersion: SAVED_VIEW_SCHEMA_VERSION,
    workspaceId,
    recordKey: createSavedViewDefaultRecordKey(userId),
    entryType: 'saved-view-default',
    userId,
    viewId,
    updatedAt,
  }
}

/**
 * 対象 view が default ではない状態を transaction 内で保証します。
 */
function createDefaultViewGuardTransactionItem(
  tableName: string,
  workspaceId: string,
  userId: string,
  viewId: string,
  currentDefaultView: StoredDefaultView | undefined,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const key = {
    workspaceId,
    recordKey: createSavedViewDefaultRecordKey(userId),
  }
  if (currentDefaultView?.viewId === viewId) {
    return {
      Delete: {
        TableName: tableName,
        Key: key,
        ConditionExpression: '#viewId = :viewId',
        ExpressionAttributeNames: { '#viewId': 'viewId' },
        ExpressionAttributeValues: { ':viewId': viewId },
      },
    }
  }
  if (currentDefaultView) {
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: key,
        ConditionExpression: '#viewId = :expectedDefaultViewId',
        ExpressionAttributeNames: { '#viewId': 'viewId' },
        ExpressionAttributeValues: { ':expectedDefaultViewId': currentDefaultView.viewId },
      },
    }
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: key,
      ConditionExpression: 'attribute_not_exists(#viewId)',
      ExpressionAttributeNames: { '#viewId': 'viewId' },
    },
  }
}

function retainLayoutField(
  field: string,
  activeCustomFieldIds: ReadonlySet<string>,
  warnings: SavedViewMigrationWarning[],
  section: SavedViewMigrationWarning['section'],
) {
  if (builtInLayoutFields.has(field)) return true
  const fieldId = field.startsWith('custom:') ? field.slice('custom:'.length) : field
  if (activeCustomFieldIds.has(fieldId)) return true
  warnings.push({ code: 'deleted-custom-field', fieldId, section })
  return false
}

function dedupeMigrationWarnings(warnings: SavedViewMigrationWarning[]) {
  return [...new Map(warnings.map((warning) => [
    `${warning.fieldId}\0${warning.section}`,
    warning,
  ])).values()]
}

function normalizeCustomFieldFilter(filter: SearchCustomFieldFilter) {
  if (!filter || typeof filter !== 'object') invalidFilters('Custom field filter is invalid.')
  const operators = new Set([
    'equals', 'not-equals', 'contains', 'greater-than', 'greater-than-or-equal',
    'less-than', 'less-than-or-equal', 'is-empty', 'is-not-empty',
  ])
  if (!operators.has(filter.operator)) invalidFilters('Custom field filter operator is invalid.')
  if (!['is-empty', 'is-not-empty'].includes(filter.operator) && filter.value === undefined) {
    invalidFilters('Custom field filter value is required.')
  }
  return {
    fieldId: requireText(filter.fieldId, 'Custom field ID', 256),
    operator: filter.operator,
    ...(filter.value === undefined ? {} : { value: normalizeCustomFieldValue(filter.value) }),
  } satisfies SearchCustomFieldFilter
}

function normalizeCustomFieldValues(values: Record<string, SearchCustomFieldValue>) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return invalidFilters('Search custom field values are invalid.')
  }
  const entries = Object.entries(values)
  if (entries.length > 100) invalidFilters('Search custom field values are too large.')
  return Object.fromEntries(entries.map(([fieldId, value]) => [
    requireText(fieldId, 'Custom field ID', 256),
    normalizeCustomFieldValue(value),
  ]))
}

function normalizeCustomFieldValue(value: SearchCustomFieldValue) {
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    if (value.length > 20_000) return invalidFilters('Custom field value is too large.')
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalidFilters('Custom field number is invalid.')
    return value
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return normalizeStringList(value, 'Custom field list', 100)
  }
  return invalidFilters('Custom field value is invalid.')
}

function normalizeStringList(values: unknown[], label: string, maxItems: number) {
  if (!Array.isArray(values) || values.length > maxItems) invalidFilters(`${label} is invalid.`)
  return [...new Set(values.map((value) => requireText(value, label, 512)))]
}

function copyFilterStringList(
  target: WorkspaceSearchFilters,
  source: Record<string, unknown>,
  key: 'assigneeUserIds' | 'creatorUserIds' | 'statuses' | 'relationIds' | 'projectIds' | 'teamIds',
) {
  const value = source[key]
  if (value !== undefined) {
    if (!Array.isArray(value)) invalidFilters(`Search ${key} is invalid.`)
    target[key] = normalizeStringList(value, `Search ${key}`, 100)
  }
}

function normalizeSearchText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
}

function createCommentSearchTitle(body: string) {
  const firstLine = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
  return (firstLine ?? 'Comment').slice(0, 160)
}

function canonicalizeSearchDate(value: string) {
  const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2})(.*)$/u)
  return match ? `${match[1]}-${match[2]}-${match[3]}${match[4]}` : value
}

/**
 * Validates the strict ISO calendar date projected from a canonical Work Item.
 *
 * @param value - Candidate Work Item search due date.
 * @returns The unchanged canonical date.
 */
function requireCanonicalWorkItemSearchDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  const year = Number(match?.[1])
  const month = Number(match?.[2])
  const day = Number(match?.[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    !match ||
    year < WORK_ITEM_SCHEDULE_MIN_YEAR ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new WorkspaceSearchError(
      400,
      'InvalidSearchDocument',
      'Work Item search dueDate must be a real ISO date in YYYY-MM-DD format.',
    )
  }
  return value
}

function matchesSearchDateRange(value: string, from?: string, to?: string) {
  const fromComparable = from?.length === 10 ? value.slice(0, 10) : value
  const toComparable = to?.length === 10 ? value.slice(0, 10) : value
  return (!from || fromComparable >= from) && (!to || toComparable <= to)
}

function splitKeyword(value: string) {
  return normalizeSearchText(value).split(' ').filter(Boolean)
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Serializes one normalized projection value with locale-independent key order.
 *
 * @param value - JSON-compatible normalized projection value.
 * @returns Canonical JSON text used only by the projection digest protocol.
 */
function canonicalWorkspaceSearchProjectionValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalWorkspaceSearchProjectionValue).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const properties = Object.entries(value)
      .sort(([left], [right]) =>
        compareWorkspaceSearchProjectionKeys(left, right)
      )
      .map(([key, item]) =>
        `${JSON.stringify(key)}:${canonicalWorkspaceSearchProjectionValue(item)}`
      )
    return `{${properties.join(',')}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new WorkspaceSearchError(
      500,
      'InvalidSearchDocument',
      'Search projection contains an unsupported value.',
    )
  }
  return serialized
}

/**
 * Orders projection keys by UTF-8 bytes with a code-unit tie-breaker.
 *
 * @param left - First projection key.
 * @param right - Second projection key.
 * @returns A negative, zero, or positive comparison result.
 */
function compareWorkspaceSearchProjectionKeys(
  left: string,
  right: string,
): number {
  const utf8Comparison = Buffer.compare(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8'),
  )
  if (utf8Comparison !== 0 || left === right) {
    return utf8Comparison
  }
  return left < right ? -1 : 1
}

function addSavedViewUpdateExpression(
  input: ReturnType<typeof normalizeUpdateSavedViewInput>,
  names: Record<string, string>,
  values: Record<string, unknown>,
  sets: string[],
  removes: string[],
) {
  for (const field of ['name', 'visibility', 'filters', 'layout'] as const) {
    if (input[field] === undefined) continue
    names[`#${field}`] = field
    values[`:${field}`] = input[field]
    sets.push(`#${field} = :${field}`)
  }
  for (const field of ['description', 'teamId'] as const) {
    if (input[field] === undefined) continue
    names[`#${field}`] = field
    if (input[field] === null) removes.push(`#${field}`)
    else {
      values[`:${field}`] = input[field]
      sets.push(`#${field} = :${field}`)
    }
  }
}

function hasSavedViewDefinitionChange(input: ReturnType<typeof normalizeUpdateSavedViewInput>) {
  return ['name', 'description', 'visibility', 'teamId', 'filters', 'layout']
    .some((field) => field in input)
}

/** Adds only present task view definition fields to a DynamoDB update expression. */
function addTaskViewUpdateExpression(
  input: ReturnType<typeof normalizeUpdateTaskViewInput>,
  names: Record<string, string>,
  values: Record<string, unknown>,
  sets: string[],
  removes: string[],
) {
  for (const field of ['name', 'visibility', 'definition'] as const) {
    if (input[field] === undefined) continue
    names[`#${field}`] = field
    values[`:${field}`] = input[field]
    sets.push(`#${field} = :${field}`)
  }
  for (const field of ['description', 'teamId'] as const) {
    if (input[field] === undefined) continue
    names[`#${field}`] = field
    if (input[field] === null) removes.push(`#${field}`)
    else {
      values[`:${field}`] = input[field]
      sets.push(`#${field} = :${field}`)
    }
  }
}

/** Returns whether an update changes shared task view definition metadata. */
function hasTaskViewDefinitionChange(input: ReturnType<typeof normalizeUpdateTaskViewInput>) {
  return ['name', 'description', 'visibility', 'teamId', 'definition']
    .some((field) => field in input)
}

function validateVisibilityTeam(visibility: SavedViewVisibility, teamId?: string) {
  if (visibility === 'team' && !teamId) invalidSavedView('Team saved views require a Team ID.')
  if (visibility !== 'team' && teamId) invalidSavedView('Only Team saved views can contain a Team ID.')
}

function requireSavedViewVisibility(value: unknown): SavedViewVisibility {
  if (typeof value !== 'string' || !savedViewVisibilities.has(value as SavedViewVisibility)) {
    return invalidSavedView('Saved view visibility is invalid.')
  }
  return value as SavedViewVisibility
}

function requireSearchEntityType(value: unknown): SearchEntityType {
  if (typeof value !== 'string' || !searchEntityTypes.has(value as SearchEntityType)) {
    throw new WorkspaceSearchError(400, 'InvalidSearchDocument', 'Search entity type is invalid.')
  }
  return value as SearchEntityType
}

function copyOptionalText<
  TTarget extends Record<string, unknown>,
  TSource extends Record<string, unknown>,
  TKey extends keyof TTarget & keyof TSource & string,
>(target: TTarget, source: TSource, key: TKey, maxLength: number) {
  const value = optionalText(source[key], `Search document ${key}`, maxLength)
  if (value) target[key] = value as TTarget[TKey]
}

function copyOptionalResultFields(result: WorkspaceSearchResult, document: WorkspaceSearchDocument) {
  for (const key of [
    'subtitle', 'body', 'teamId', 'projectId', 'parentId', 'assigneeUserId',
    'creatorUserId', 'status', 'dueDate', 'createdAt', 'updatedAt',
  ] as const) {
    const value = document[key]
    if (value !== undefined) result[key] = value
  }
  if (document.customFields) {
    result.customFields = document.customFields
  }
}

function requireRelativeUrl(value: unknown) {
  const url = requireText(value, 'Search document URL', 2_048)
  if (!url.startsWith('/') || url.startsWith('//')) {
    throw new WorkspaceSearchError(400, 'InvalidSearchDocument', 'Search document URL must be application-relative.')
  }
  return url
}

function requireText(value: unknown, label: string, maxLength = 1_024) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new WorkspaceSearchError(400, 'InvalidWorkspaceSearch', `${label} is invalid.`)
  }
  return value.trim()
}

function optionalText(value: unknown, label: string, maxLength = 1_024) {
  if (value === undefined || value === null || value === '') return undefined
  return requireText(value, label, maxLength)
}

function requireIdentifier(value: unknown, label: string) {
  const identifier = requireText(value, label, 256)
  if (!/^[A-Za-z0-9._:@+-]+$/u.test(identifier)) {
    throw new WorkspaceSearchError(400, 'InvalidWorkspaceSearch', `${label} is invalid.`)
  }
  return identifier
}

function optionalBoolean(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') invalidSavedView(`${label} is invalid.`)
  return value as boolean
}

/** Reads one required boolean without coercion. */
function requireBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') invalidTaskView(`${label} is invalid.`)
  return value
}

function requirePositiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new WorkspaceSearchError(400, 'InvalidSavedView', `${label} must be a positive integer.`)
  }
  return value as number
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new WorkspaceSearchError(400, 'InvalidSearchLimit', `Limit must be between 1 and ${maximum}.`)
  }
  return value
}

/** 入力順を維持しながら bounded concurrency で非同期変換します。 */
async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const output: TOutput[] = []
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), values.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      output[index] = await mapper(values[index] as TInput, index)
    }
  })
  await Promise.all(workers)
  return output
}

/** Returns whether an unknown value is a non-array object record. */
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Creates a stable context key for one task view surface and resource scope. */
function createTaskViewContextKey(surface: TaskViewSurface, scope: TaskViewScope) {
  return `${surface}\0${canonicalValue(scope)}`
}

/** Compares two normalized task view scopes by their canonical structural value. */
function taskViewScopesEqual(left: TaskViewScope, right: TaskViewScope) {
  return canonicalValue(left) === canonicalValue(right)
}

/** Returns the Team that owns a Team-qualified task view scope when one exists. */
function getTaskViewScopeTeamId(scope: TaskViewScope) {
  if (scope.kind === 'team') return scope.teamId
  if (scope.kind === 'project') return scope.teamId
  return undefined
}

/** Returns whether a string is one supported workflow category. */
function isTaskViewWorkflowCategory(value: string): value is WorkflowStatusCategory {
  return taskViewWorkflowCategories.has(value)
}

/** Returns whether a string is one supported Work Item priority. */
function isTaskViewPriority(value: string): value is WorkItemPriority {
  return taskViewPriorities.has(value)
}

/** Reads one supported relative due-date preset. */
function requireTaskViewDueDatePreset(value: unknown): TaskViewDueDatePreset {
  if (typeof value === 'string' && taskViewDueDatePresets.has(value)) {
    if (value === 'overdue' || value === 'today' || value === 'upcoming' || value === 'no-date') {
      return value
    }
  }
  return invalidTaskView('Task view due date preset is invalid.')
}

/** Reads a persisted task view surface without converting storage corruption into user input. */
function requireStoredTaskViewSurface(value: unknown): TaskViewSurface {
  try {
    return requireTaskViewSurface(value)
  } catch (error) {
    throw new WorkspaceSearchError(503, 'InvalidTaskView', 'Task view data is invalid.', {
      cause: error,
    })
  }
}

/** Reads a persisted task view scope without accepting an unknown discriminator. */
function readStoredTaskViewScope(value: unknown): TaskViewScope {
  try {
    return normalizeTaskViewScope(value)
  } catch (error) {
    throw new WorkspaceSearchError(503, 'InvalidTaskView', 'Task view data is invalid.', {
      cause: error,
    })
  }
}

/** Reads an optional persisted text field without accepting empty values. */
function optionalStoredText(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw invalidStoredTaskView()
}

function encodeKeyPart(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function createSavedViewRevisionConflict() {
  return new WorkspaceSearchError(
    409,
    'SavedViewRevisionConflict',
    'Saved view changed. Reload and try again.',
  )
}

/** Creates the stable optimistic-concurrency conflict for task view mutations. */
function createTaskViewRevisionConflict() {
  return new WorkspaceSearchError(
    409,
    'TaskViewRevisionConflict',
    'Task view changed. Reload and try again.',
  )
}

/** Creates the stable conflict returned when an idempotency key is reused ambiguously. */
function createTaskViewIdempotencyConflict() {
  return new WorkspaceSearchError(
    409,
    'TaskViewIdempotencyConflict',
    'Idempotency key was already used for another task view request.',
  )
}

/** Creates a non-disclosing task view not-found error. */
function createTaskViewNotFound() {
  return new WorkspaceSearchError(404, 'TaskViewNotFound', 'Task view was not found.')
}

function invalidFilters(message: string): never {
  throw new WorkspaceSearchError(400, 'InvalidSearchFilters', message)
}

function invalidSavedView(message: string): never {
  throw new WorkspaceSearchError(400, 'InvalidSavedView', message)
}

/** Throws a stable task view input validation error. */
function invalidTaskView(message: string): never {
  throw new WorkspaceSearchError(400, 'InvalidTaskView', message)
}

/** Creates a stable error for malformed persisted task view state. */
function invalidStoredTaskView() {
  return new WorkspaceSearchError(503, 'InvalidTaskView', 'Task view data is invalid.')
}

/** Validates the optional source revision used by an asynchronous projection guard. */
function normalizeProjectionSourceRevision(value: number | undefined) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkspaceSearchError(
      400,
      'InvalidSearchProjectionRevision',
      'Search projection source revision must be a positive integer.',
    )
  }
  return value
}

function isTransactionConditionalCheckFailed(error: unknown) {
  if (!(error instanceof Error)) return false
  if (error.name === 'ConditionalCheckFailedException') return true
  if (error.name !== 'TransactionCanceledException') return false
  const reasons = (error as Error & {
    CancellationReasons?: Array<{ Code?: string }>
  }).CancellationReasons
  return reasons?.some((reason) => reason.Code === 'ConditionalCheckFailed') ??
    error.message.includes('ConditionalCheckFailed')
}

/** Returns whether one transaction item failed its conditional guard. */
function isTransactionConditionalCheckFailedAt(error: unknown, index: number) {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') {
    return false
  }
  if (!isRecordValue(error)) return false
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons)) return false
  const reason = reasons[index]
  return isRecordValue(reason) && reason.Code === 'ConditionalCheckFailed'
}

function isResourceNotFound(error: unknown) {
  return error instanceof Error && error.name === 'ResourceNotFoundException'
}

function isResourceInUse(error: unknown) {
  return error instanceof Error && error.name === 'ResourceInUseException'
}

function isWorkspaceSearchTableDescription(table: TableDescription | undefined) {
  return table?.KeySchema?.some((key) => key.AttributeName === 'workspaceId' && key.KeyType === 'HASH') &&
    table.KeySchema.some((key) => key.AttributeName === 'recordKey' && key.KeyType === 'RANGE')
}

function createDynamoDbClient() {
  return createConfiguredDynamoDbClient()
}

function shouldBootstrapLocalTable() {
  return shouldBootstrapConfiguredLocalDynamoDb()
}

function readEnvironment(name: string) {
  return typeof Bun !== 'undefined' ? Bun.env[name] : process.env[name]
}
