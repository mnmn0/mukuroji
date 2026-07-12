import { createHash, randomUUID } from 'node:crypto'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  SAVED_VIEW_SCHEMA_VERSION,
  SEARCH_SCHEMA_VERSION,
  type CreateSavedWorkspaceViewInput,
  type SavedViewMigrationWarning,
  type SavedViewVisibility,
  type SavedWorkspaceView,
  type SavedWorkspaceViewsResponse,
  type SearchCustomFieldFilter,
  type SearchCustomFieldValue,
  type SearchEntityType,
  type SearchViewLayout,
  type UpdateSavedWorkspaceViewInput,
  type WorkspaceSearchFilters,
  type WorkspaceSearchHighlight,
  type WorkspaceSearchResponse,
  type WorkspaceSearchResult,
} from '@mukuroji/contracts'

/** Workspace search table の search document prefix です。 */
export const WORKSPACE_SEARCH_DOCUMENT_PREFIX = 'DOCUMENT#'

/** Workspace search table の saved view prefix です。 */
export const WORKSPACE_SAVED_VIEW_PREFIX = 'VIEW#'

/** Workspace search table の viewer preference prefix です。 */
export const WORKSPACE_SAVED_VIEW_PREFERENCE_PREFIX = 'PREFERENCE#'

/** Workspace search table の default view marker prefix です。 */
export const WORKSPACE_SAVED_VIEW_DEFAULT_PREFIX = 'DEFAULT#'

/** Search API が一 page で返す既定件数です。 */
export const WORKSPACE_SEARCH_DEFAULT_LIMIT = 30

/** Search API が一 page で返せる最大件数です。 */
export const WORKSPACE_SEARCH_MAX_LIMIT = 100

/** 一つの search page で評価する index row の最大件数です。 */
export const WORKSPACE_SEARCH_EVALUATION_LIMIT = 1_000

/** Current scope を page 内で並列再検証する最大数です。 */
const WORKSPACE_SEARCH_SCOPE_CONCURRENCY = 10

/** Saved view 一覧が一 page で返す既定件数です。 */
export const SAVED_VIEW_DEFAULT_LIMIT = 50

/** Saved view 一覧が一 page で返せる最大件数です。 */
export const SAVED_VIEW_MAX_LIMIT = 100

/**
 * Workspace search index に保存する forward-compatible document です。
 */
export type WorkspaceSearchDocument = {
  /** Search document schema version です。 */
  schemaVersion: typeof SEARCH_SCHEMA_VERSION
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
}

/**
 * Search document を返す直前に再解決した current resource scope です。
 */
export type WorkspaceSearchResolvedScope = {
  /** Current Team ID です。 */
  teamId?: string
  /** Current Project ID です。 */
  projectId?: string
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

/**
 * API handler と backfill が利用する Workspace search client contract です。
 */
export type WorkspaceSearchClient = {
  /** Search document を idempotent に作成または置換します。 */
  upsertDocument(
    input: Parameters<typeof createWorkspaceSearchDocument>[0] | WorkspaceSearchDocument,
  ): Promise<WorkspaceSearchDocument>
  /** Search document を entity key で削除します。 */
  deleteDocument(
    workspaceId: string,
    entityType: SearchEntityType,
    entityId: string,
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

const searchEntityTypes = new Set<SearchEntityType>([
  'work-item',
  'project',
  'team',
  'comment',
  'file',
  'document',
])

const savedViewVisibilities = new Set<SavedViewVisibility>(['personal', 'team', 'shared'])

/**
 * Entity type と canonical ID から search document record key を作成します。
 */
export function createWorkspaceSearchDocumentRecordKey(
  entityType: SearchEntityType,
  entityId: string,
) {
  return `${WORKSPACE_SEARCH_DOCUMENT_PREFIX}${requireSearchEntityType(entityType)}#${encodeKeyPart(requireText(entityId, 'Search entity ID'))}`
}

/** Saved view ID から definition record key を作成します。 */
export function createSavedWorkspaceViewRecordKey(viewId: string) {
  return `${WORKSPACE_SAVED_VIEW_PREFIX}${requireIdentifier(viewId, 'Saved view ID')}`
}

/**
 * Search document input を DynamoDB 保存形式へ正規化します。
 */
export function createWorkspaceSearchDocument(
  input: Omit<WorkspaceSearchDocument, 'schemaVersion' | 'entryType' | 'recordKey'> & {
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
  const document: WorkspaceSearchDocument = {
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
  copyOptionalText(document, input, 'body', 20_000)
  copyOptionalText(document, input, 'teamId', 256)
  copyOptionalText(document, input, 'projectId', 256)
  copyOptionalText(document, input, 'parentId', 1_024)
  copyOptionalText(document, input, 'assigneeUserId', 512)
  copyOptionalText(document, input, 'creatorUserId', 512)
  copyOptionalText(document, input, 'status', 256)
  copyOptionalText(document, input, 'createdAt', 128)
  copyOptionalText(document, input, 'updatedAt', 128)
  const dueDate = optionalText(input.dueDate, 'Search document dueDate', 128)
  if (dueDate) document.dueDate = canonicalizeSearchDate(dueDate)

  if (input.customFields) {
    document.customFields = normalizeCustomFieldValues(input.customFields)
  }
  if (input.relationIds) {
    document.relationIds = normalizeStringList(input.relationIds, 'Search relation IDs', 100)
  }

  return document
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
  /** Comment の現在 Markdown 本文です。 */
  body: string
  /** Comment author の Workspace member key です。 */
  creatorUserId?: string
  /** Comment の作成日時です。 */
  createdAt?: string
  /** Comment の最終更新日時です。 */
  updatedAt?: string
}) {
  const parentId = `team/${input.teamId}/issue/${input.issueId}`
  const query = new URLSearchParams({ issueId: input.issueId, commentId: input.commentId })
  return createWorkspaceSearchDocument({
    workspaceId: input.workspaceId,
    entityType: 'comment',
    entityId: `${parentId}/comment/${input.commentId}`,
    title: createCommentSearchTitle(input.body),
    ...(input.creatorUserId ? { subtitle: input.creatorUserId } : {}),
    body: input.body,
    url: `/teams/${encodeURIComponent(input.teamId)}/issues?${query.toString()}`,
    teamId: input.teamId,
    parentId,
    ...(input.creatorUserId ? { creatorUserId: input.creatorUserId } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
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
    this.documentClient = documentClient ?? DynamoDBDocumentClient.from(dynamoDbClient, {
      marshallOptions: { removeUndefinedValues: true },
    })
    this.bootstrapLocalTable = bootstrapLocalTable
  }

  /** Search document を idempotent に作成または置換します。 */
  async upsertDocument(
    input: Parameters<typeof createWorkspaceSearchDocument>[0] | WorkspaceSearchDocument,
  ) {
    await this.ensureLocalTable()
    const document = createWorkspaceSearchDocument(input)
    await this.documentClient.send(new PutCommand({
      TableName: this.tableName,
      Item: document,
    }))
    return document
  }

  /** Search document を entity key で削除します。 */
  async deleteDocument(workspaceId: string, entityType: SearchEntityType, entityId: string) {
    await this.ensureLocalTable()
    await this.documentClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: requireText(workspaceId, 'Search Workspace ID'),
        recordKey: createWorkspaceSearchDocumentRecordKey(entityType, entityId),
      },
    }))
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
      const currentDocuments = await mapWithConcurrency(
        documentRows,
        WORKSPACE_SEARCH_SCOPE_CONCURRENCY,
        async ({ document: storedDocument }) => {
          if (!storedDocument) return undefined
          const resolvedScope = input.resolveCurrentScope
            ? await input.resolveCurrentScope(storedDocument)
            : {
                ...(storedDocument.teamId ? { teamId: storedDocument.teamId } : {}),
                ...(storedDocument.projectId ? { projectId: storedDocument.projectId } : {}),
              }
          if (!resolvedScope) return undefined
          const document = {
            ...(resolvedScope.currentDocument ?? storedDocument),
            teamId: resolvedScope.teamId,
            projectId: resolvedScope.projectId,
          }
          return canAccessWorkspaceSearchDocument(document, input.access) &&
              matchesWorkspaceSearchFilters(document, filters)
            ? document
            : undefined
        },
      )
      let processedDocumentCount = 0
      let lastProcessedRecordKey: string | undefined

      for (let index = 0; index < documentRows.length; index += 1) {
        const row = documentRows[index]
        if (!row) continue
        processedDocumentCount += 1
        evaluated += 1
        if (row.recordKey) lastProcessedRecordKey = row.recordKey
        const document = currentDocuments[index]
        if (!document) continue
        results.push(toWorkspaceSearchResult(document, filters.keyword))
        if (results.length >= limit) {
          reachedLimit = true
          break
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
      if (!createIdempotencyKeyHash || !isTransactionConditionalCheckFailed(error)) throw error
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

function normalizeWorkspaceSearchFilters(filters: WorkspaceSearchFilters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
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
    if (!['createdAt', 'updatedAt', 'dueDate'].includes(filters.date.field)) {
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
    normalized.date = { field: filters.date.field, ...(from ? { from } : {}), ...(to ? { to } : {}) }
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
    const haystack = normalizeSearchText([document.title, document.subtitle, document.body].filter(Boolean).join('\n'))
    if (!splitKeyword(filters.keyword).every((term) => haystack.includes(term))) return false
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
) {
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

function readWorkspaceSearchDocument(value: Record<string, unknown>) {
  if (value.schemaVersion !== SEARCH_SCHEMA_VERSION || value.entryType !== 'search-document') {
    throw new WorkspaceSearchError(503, 'InvalidSearchDocument', 'Search index contains an invalid document.')
  }
  try {
    return createWorkspaceSearchDocument(value as WorkspaceSearchDocument)
  } catch (error) {
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

function createSearchQueryFingerprint(filters: WorkspaceSearchFilters) {
  return createHash('sha256').update(canonicalValue(filters)).digest('base64url')
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

function encodeCursor(value: SearchCursor | SavedViewCursor) {
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
  source: WorkspaceSearchFilters,
  key: 'assigneeUserIds' | 'creatorUserIds' | 'statuses' | 'relationIds' | 'projectIds' | 'teamIds',
) {
  if (source[key]) target[key] = normalizeStringList(source[key] ?? [], `Search ${key}`, 100)
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

function invalidFilters(message: string): never {
  throw new WorkspaceSearchError(400, 'InvalidSearchFilters', message)
}

function invalidSavedView(message: string): never {
  throw new WorkspaceSearchError(400, 'InvalidSavedView', message)
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
  const endpoint = readEnvironment('DYNAMODB_ENDPOINT') ??
    readEnvironment('AWS_ENDPOINT_URL_DYNAMODB') ??
    readEnvironment('AWS_ENDPOINT_URL') ??
    (typeof Bun !== 'undefined' && !readEnvironment('AWS_LAMBDA_FUNCTION_NAME')
      ? 'http://localhost:4566'
      : undefined)
  return new DynamoDBClient({
    region: readEnvironment('AWS_REGION') ?? readEnvironment('AWS_DEFAULT_REGION') ?? 'us-east-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: readEnvironment('AWS_ACCESS_KEY_ID') ?? 'test',
            secretAccessKey: readEnvironment('AWS_SECRET_ACCESS_KEY') ?? 'test',
          },
        }
      : {}),
  })
}

function shouldBootstrapLocalTable() {
  return Boolean(
    readEnvironment('DYNAMODB_ENDPOINT') ||
    readEnvironment('AWS_ENDPOINT_URL_DYNAMODB') ||
    (typeof Bun !== 'undefined' && !readEnvironment('AWS_LAMBDA_FUNCTION_NAME')),
  )
}

function readEnvironment(name: string) {
  return typeof Bun !== 'undefined' ? Bun.env[name] : process.env[name]
}
