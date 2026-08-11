import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import {
  gunzipSync,
  gzipSync,
} from 'node:zlib'
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
  DOCUMENT_SCHEMA_VERSION,
  type ApplyDocumentOperationsResponse,
  type DocumentBlock,
  type DocumentCapabilities,
  type DocumentCommentAnchor,
  type DocumentCommentsResponse,
  type DocumentDetail,
  type DocumentMention,
  type DocumentNode,
  type DocumentOperation,
  type DocumentPermission,
  type DocumentPresenceSelection,
  type DocumentRelation,
  type DocumentScope,
  type DocumentTreeResponse,
  type DocumentVersion,
  type DocumentVersionsResponse,
  type WhiteboardContent,
} from '@mukuroji/contracts'
import { PLANNING_STORAGE_SCHEMA_VERSION } from '../../../planning'
import {
  createDynamoDbClient as createConfiguredDynamoDbClient,
  createWorkspaceSearchWriterDynamoDbDocumentClient,
} from '../../../../infrastructure/aws/dynamodb-client'
import {
  throwIfWorkspaceSearchWriterFenceTerminalError,
} from '../../../../infrastructure/runtime/workspace-search-writer-fence-document-client'
import type {
  ApplyDocumentOperationsRequest,
  ChangeDocumentArchiveStateRequest,
  CreatedDocumentPublicShare,
  CreateDocumentCommentRequest,
  CreateDocumentPublicShareRequest,
  CreateDocumentRequest,
  DocumentAccessContext,
  DocumentAuthorizationFenceSnapshot,
  DocumentBacklink,
  DocumentBacklinksResponse,
  DocumentManagerLifecycleSnapshot,
  DocumentPreferenceResult,
  DocumentPresenceRequest,
  DocumentPublicShareRequest,
  DocumentSearchAccessReadContext,
  ExportDocumentRequest,
  GetDocumentRequest,
  HeartbeatDocumentPresenceRequest,
  InstantiateDocumentTemplateRequest,
  ListDocumentBacklinksRequest,
  ListDocumentCommentsRequest,
  ListDocumentVersionsRequest,
  ListDocumentsRequest,
  ListRecentDocumentsRequest,
  PrepareDocumentOperationsResponse,
  PrepareDocumentWorkItemDeletionFenceRequest,
  RenderedDocumentExport,
  ResolvedDocumentPublicShare,
  ResolvedDocumentSearchAccess,
  ResolveDocumentCommentRequest,
  ResolveDocumentSearchAccessRequest,
  RestoreDocumentVersionRequest,
  StoredDocumentComment,
  StoredDocumentPresence,
  StoredDocumentPublicShare,
  UpdateDocumentPreferenceRequest,
  UpdateDocumentRequest,
} from '../../document-types'
import type {
  DocumentApplicationClient,
} from '../../application/ports/document-ports'
import {
  collectDocumentRelationTargets,
  normalizeDocumentPermissionForActor,
  reduceDocumentOperations,
  renderDocumentProjectionExport,
  validateCanonicalDocumentWorkItemId,
  validateDocumentPermission,
  validateDocumentPayload,
  validateDocumentScope,
} from '../../domain/document-content'
import {
  DOCUMENT_BACKLINK_MAX_PAGE_LIMIT,
  DOCUMENT_COMMENT_MAX_LENGTH,
  DOCUMENT_COMMENT_MAX_PAGE_LIMIT,
  DOCUMENT_MAX_ITEM_BYTES,
  DOCUMENT_MAX_OPERATION_COUNT,
  DOCUMENT_MAX_TREE_DEPTH,
  DOCUMENT_MENTION_MAX_COUNT,
  DOCUMENT_OPERATION_RECEIPT_RETENTION_DAYS,
  DOCUMENT_PUBLIC_SHARE_MAX_DAYS,
  DOCUMENT_PUBLIC_SHARE_TOKEN_BYTES,
  DOCUMENT_VERSION_RETENTION_DAYS,
  DOCUMENT_VERSION_SNAPSHOT_INTERVAL,
  DOCUMENT_VERSION_SNAPSHOT_MAX_AGE_MS,
} from '../../domain/document-limits'
import { DocumentError } from '../../errors'
import {
  resolveDocumentCapabilities,
  type DocumentAccessSubject,
} from '../../domain/document-access'
import {
  createAuditFieldChanges,
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
} from '../../../audit'
import {
  DOCUMENT_AUTHORIZATION_REVISION_KEY,
  createDocumentAuthorizationRevisionPut,
  type DocumentAuthorizationRevisionGuard,
} from './document-authorization'
import {
  createDocumentWorkspaceSearchBody,
} from '../../../workspace-search'
import { loadServerConfig } from '../../../../infrastructure/config/server-config'

/** Work Item backlink target fence の schema version です。 */
const DOCUMENT_BACKLINK_TARGET_FENCE_SCHEMA_VERSION = 1

/** Conditional retry を行う最大回数です。 */
const DOCUMENT_CONDITIONAL_RETRY_LIMIT = 6

/** Current row に保持する tombstone revision の最大件数です。 */
const DOCUMENT_ELEMENT_TOMBSTONE_LIMIT = 64

/** Current row に保持する tombstone revision の最大 UTF-8 byte 数です。 */
const DOCUMENT_ELEMENT_TOMBSTONE_MAX_BYTES = 32_000

/** Document title の最大文字数です。 */
const DOCUMENT_MAX_TITLE_LENGTH = 500

/** Presence list が返す active member の最大件数です。 */
const DOCUMENT_PRESENCE_MAX_VISIBLE = 100

/** Presence list 一回で評価する member lease の最大件数です。 */
const DOCUMENT_PRESENCE_EVALUATION_LIMIT = 1_000

/** Recent top-K 一回で source-of-truth 評価する最大候補数です。 */
const DOCUMENT_RECENT_EVALUATION_LIMIT = 1_000

/** DynamoDB TTL epoch を計算する一日の秒数です。 */
const SECONDS_PER_DAY = 24 * 60 * 60

/** Version revision を DynamoDB sort key に埋め込む幅です。 */
const DOCUMENT_VERSION_REVISION_WIDTH = 12

/** 空の Whiteboard content です。 */
const EMPTY_WHITEBOARD_CONTENT: WhiteboardContent = {
  objects: [],
  connectors: [],
  frames: [],
}

/** Viewer 固有情報を保存 row へ混入させないための空 capability です。 */
const EMPTY_DOCUMENT_CAPABILITIES: DocumentCapabilities = {
  canView: false,
  canEdit: false,
  canComment: false,
  canShare: false,
  canManagePermissions: false,
  canArchive: false,
  canRestore: false,
  canExport: false,
}

type StoredDocumentItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** `DOCUMENT#<id>` 形式の sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document'
  /** Public Document ID です。 */
  documentId: string
  /** Conditional write に使う current revision です。 */
  revision: number
  /** Viewer 固有情報を除いた canonical snapshot です。 */
  document: DocumentDetail
  /** Element ごとの最終更新 revision です。 */
  elementRevisions: Record<string, number>
  /** Compacted tombstone より古い operation を拒否する revision floor です。 */
  operationConflictFloorRevision?: number
  /** Archive ごとに増加し、過去の public bearer token を永久失効させます。 */
  publicShareEpoch?: number
  /** 最後に full version snapshot を保存した revision です。 */
  lastVersionSnapshotRevision?: number
  /** 最後に full version snapshot を保存した ISO timestamp です。 */
  lastVersionSnapshotAt?: string
  /** Idempotent create retry key の hash です。 */
  createIdempotencyKeyHash?: string
  /** 同じ create retry key の payload fingerprint です。 */
  createRequestFingerprint?: string
}

/**
 * Workspace search の認可再検証に使う compact Document row です。
 */
type StoredDocumentSearchAccessItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** `SEARCH_ACCESS#<encodedDocumentId>` 形式の sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-search-access'
  /** Public Document ID です。 */
  documentId: string
  /** Tree 上の direct parent folder ID です。 */
  parentId?: string
  /** Workspace または Project scope です。 */
  scope: DocumentScope
  /** Access 判定に必要な canonical ACL です。 */
  permission: DocumentPermission
  /** Archive 済みの場合の timestamp です。 */
  archivedAt?: string
  /** Canonical Document revision です。 */
  revision: number
  /** Canonical Document updatedAt です。 */
  updatedAt: string
}

/**
 * Workspace search の current-source 全文照合に使う圧縮 body row です。
 */
type StoredDocumentSearchBodyItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** `SEARCH_BODY#<encodedDocumentId>` 形式の sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-search-body'
  /** Public Document ID です。 */
  documentId: string
  /** Body の圧縮方式です。 */
  bodyEncoding: 'gzip'
  /** UTF-8 全文を gzip 圧縮した DynamoDB binary です。 */
  bodyGzip: Uint8Array
  /** Canonical Document revision です。 */
  revision: number
  /** Canonical Document updatedAt です。 */
  updatedAt: string
}

/**
 * Workspace 内の tree topology mutation を直列化する revision row です。
 */
type StoredDocumentTreeRevisionItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** Tree revision 固定 sort key です。 */
  recordKey: 'DOCUMENT_TREE_REVISION'
  /** Row discriminator です。 */
  entryType: 'document-tree-revision'
  /** Topology mutation ごとに増加する revision です。 */
  revision: number
  /** 最後に topology を変更した timestamp です。 */
  updatedAt: string
}

/**
 * Workspace member lifecycle と Document ACL mutation を直列化する generation row です。
 */
type StoredDocumentAuthorizationRevisionItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** Authorization revision 固定 sort key です。 */
  recordKey: typeof DOCUMENT_AUTHORIZATION_REVISION_KEY
  /** Row discriminator です。 */
  entryType: 'document-authorization-revision'
  /** Private ACL mutation ごとに増加する revision です。 */
  revision: number
  /** 最後に ACL を変更した timestamp です。 */
  updatedAt: string
}

/**
 * Tree validation と commit の間に topology が変わっていないことを保証します。
 */
type DocumentTreeMutationGuard = {
  /** Validation 前に読み込んだ tree revision です。 */
  expectedRevision: number
  /** Guarded mutation の timestamp です。 */
  updatedAt: string
}

/**
 * 一つの read request 内で ancestor と preference reads を共有します。
 */
type DocumentProjectionContext = {
  /** Document ID ごとの ancestor row read promise です。 */
  documentRows: Map<
    string,
    Promise<StoredDocumentItem | undefined>
  >
  /** Member/Document ごとの preference read promise です。 */
  preferences: Map<
    string,
    Promise<StoredDocumentPreferenceItem | undefined>
  >
}

/**
 * Document mutation authorization を transactionへ束縛する lineage snapshot です。
 */
type DocumentAuthorizationSnapshot = {
  /** Capability 判定対象の current Document row です。 */
  documentRow: StoredDocumentItem
  /** 直近の親から root へ向かう ancestor rows です。 */
  ancestorRows: StoredDocumentItem[]
}

/** Physical DynamoDB row condition derived only inside the outbound adapter. */
type DynamoDbDocumentAuthorizationGuard = {
  /** DynamoDB table containing the authorization row. */
  tableName: string
  /** Complete primary key of the authorization row. */
  key: Readonly<Record<string, string | undefined>>
  /** Attribute containing the monotonic authorization generation. */
  generationAttribute: string
  /** Generation observed while authorizing the operation. */
  expectedGeneration: string | number
  /** Allows an absent row when the expected generation is zero. */
  allowMissingWhenExpectedZero?: boolean
  /** Additional scalar attributes that must remain unchanged. */
  requiredAttributes?: Readonly<Record<string, string | number | boolean>>
}

/** Internal create request that also fences the source template lineage. */
type CreateDocumentPersistenceRequest = CreateDocumentRequest & {
  /** Physical source-document guards created by this adapter. */
  sourceAuthorizationGuards?: readonly DynamoDbDocumentAuthorizationGuard[]
}

/**
 * 親 folder ごとに direct child を列挙する compact index row です。
 */
type StoredDocumentChildIndexItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** `DOCUMENT_CHILD#<parentId>#<documentId>` 形式の sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-child'
  /** Child Document ID です。 */
  documentId: string
  /** Direct parent folder ID です。 */
  parentId: string
  /** Access 判定に使う Document scope です。 */
  scope: DocumentScope
  /** Access 判定に使う canonical ACL です。 */
  permission: DocumentPermission
  /** Archive 済みの場合の timestamp です。 */
  archivedAt?: string
}

/**
 * DynamoDB に保存する immutable Document version metadata row です。
 */
type StoredDocumentVersionItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** `VERSION#<documentId>#<revision>` 形式の sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-version'
  /** Version metadata です。 */
  version: DocumentVersion
  /** DynamoDB TTL epoch seconds です。 */
  expiresAtEpoch: number
}

/**
 * DynamoDB に保存する immutable Document version snapshot row です。
 */
type StoredDocumentVersionSnapshotItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** `VERSION_SNAPSHOT#<documentId>#<revision>` 形式の sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-version-snapshot'
  /** Version metadata です。 */
  version: DocumentVersion
  /** Restorable canonical snapshot です。 */
  document: DocumentDetail
  /** Snapshot 時点の element revision map です。 */
  elementRevisions: Record<string, number>
  /** Delta retention より長く base snapshot を残す DynamoDB TTL epoch seconds です。 */
  expiresAtEpoch: number
}

/**
 * Full snapshot 間の revision を復元する compact delta row です。
 */
type StoredDocumentVersionDeltaItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** `VERSION_DELTA#<documentId>#<revision>` 形式の sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-version-delta'
  /** Delta が生成する version metadata です。 */
  version: DocumentVersion
  /** Delta 適用前の直前 revision です。 */
  baseRevision: number
  /** Operation mutation の場合に replay する canonical operations です。 */
  operations?: readonly DocumentOperation[]
  /** Metadata mutation の場合に置換する top-level fields です。 */
  changedFields?: Record<string, unknown>
  /** Metadata mutation の場合に削除する top-level field names です。 */
  removedFields?: string[]
  /** DynamoDB TTL epoch seconds です。 */
  expiresAtEpoch: number
}

/**
 * DynamoDB に保存する operation idempotency receipt です。
 */
type StoredOperationReceipt = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** Operation ID を含む sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-operation'
  /** Operation 対象 Document ID です。 */
  documentId: string
  /** Editor instance ID です。 */
  clientId: string
  /** Client-generated operation ID です。 */
  operationId: string
  /** Operation payload fingerprint です。 */
  fingerprint: string
  /** Operation を確定した Document revision です。 */
  revision: number
  /** Receipt 作成日時です。 */
  createdAt: string
  /** DynamoDB TTL epoch seconds です。 */
  expiresAtEpoch: number
}

/**
 * DynamoDB に保存する user preference row です。
 */
type StoredDocumentPreferenceItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** User/Document を識別する sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-preference'
  /** Preference owner の member key です。 */
  memberKey: string
  /** Preference 対象 Document ID です。 */
  documentId: string
  /** Preference の compare-and-swap revision です。 */
  preferenceRevision: number
  /** Favorite 状態です。 */
  favorite: boolean
  /** 最終 open timestamp です。 */
  lastOpenedAt?: string
  /** Preference 更新日時です。 */
  updatedAt: string
}

/**
 * DynamoDB に保存する user ごとの recent 順序 index row です。
 */
type StoredDocumentRecentItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** User/reverse timestamp/Document を識別する sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-recent'
  /** Recent owner の member key です。 */
  memberKey: string
  /** Recent 対象 Document ID です。 */
  documentId: string
  /** Favorite 状態の現在 snapshot です。 */
  favorite: boolean
  /** 最終 open timestamp です。 */
  lastOpenedAt: string
}

/**
 * DynamoDB に保存する Document comment row です。
 */
type StoredDocumentCommentItem = StoredDocumentComment & {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** Document/time/comment を識別する sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-comment'
}

/**
 * Comment ID から時系列 comment row を直接参照する receipt です。
 */
type StoredDocumentCommentReceiptItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** Document/comment ID を識別する deterministic sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-comment-receipt'
  /** Comment が属する Document ID です。 */
  documentId: string
  /** Public comment ID です。 */
  commentId: string
  /** 時系列 comment row の sort key です。 */
  commentRecordKey: string
  /** Idempotency conflict を判定する author key です。 */
  authorUserId: string
  /** Timestamp を除いた comment input fingerprint です。 */
  fingerprint: string
}

/**
 * DynamoDB に保存する Document presence lease です。
 */
type StoredDocumentPresenceItem = StoredDocumentPresence & {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** Document/client を識別する sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-presence'
  /** Presence 対象 Document ID です。 */
  documentId: string
  /** DynamoDB TTL epoch seconds です。 */
  expiresAtEpoch: number
}

/**
 * Workspace partition に保存する share metadata row です。
 */
type StoredDocumentShareItem = StoredDocumentPublicShare & {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** Document/share を識別する sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-share'
  /** Raw token を残さない SHA-256 digest です。 */
  tokenHash: string
  /** DynamoDB TTL epoch seconds です。 */
  expiresAtEpoch: number
  /** Public share create の idempotency key digest です。 */
  createIdempotencyKeyHash?: string
  /** 同じ key を異なる入力へ再利用させない fingerprint です。 */
  createRequestFingerprint?: string
  /** Share 作成時点の Document/ancestor archive epoch lineage です。 */
  documentShareEpochs: Record<string, number>
}

/**
 * Public token digest partition に保存する lookup row です。
 */
type StoredPublicLinkItem = {
  /** `PUBLIC#<tokenHash>` 形式の partition key です。 */
  workspaceId: string
  /** 固定 lookup sort key です。 */
  recordKey: 'LINK'
  /** Row discriminator です。 */
  entryType: 'document-public-link'
  /** Link 先 canonical Workspace ID です。 */
  targetWorkspaceId: string
  /** Link 先 Document ID です。 */
  documentId: string
  /** Link 先 share ID です。 */
  shareId: string
  /** Share expiry の ISO timestamp です。 */
  expiresAt: string
  /** Link 作成時点の Document/ancestor archive epoch lineage です。 */
  documentShareEpochs: Record<string, number>
  /** DynamoDB TTL epoch seconds です。 */
  expiresAtEpoch: number
}

/**
 * Backlink query 用の denormalized row です。
 */
type StoredDocumentBacklinkItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** Target/source/relation を識別する sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-backlink'
  /** Backlink source Document ID です。 */
  documentId: string
  /** Relation target 種別です。 */
  targetKind: 'work-item' | 'project' | 'goal'
  /** Relation target ID です。 */
  targetId: string
  /** Denormalized relation snapshot です。 */
  relation: DocumentRelation
}

/**
 * Work Item delete と Document backlink mutation を直列化する durable fence row です。
 */
type StoredDocumentBacklinkTargetFenceItem = {
  /** Canonical Workspace partition key です。 */
  workspaceId: string
  /** Work Item target を識別する sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'document-backlink-target-fence'
  /** Fence row schema version です。 */
  schemaVersion: 1
  /** Fence 対象 relation target 種別です。 */
  targetKind: 'work-item'
  /** Canonical Work Item target ID です。 */
  targetId: string
  /** Archive 済み Document を含む active backlink row 数です。 */
  activeBacklinkCount: number
  /** Backlink add/remove/delete fence を直列化する単調増加 version です。 */
  version: number
  /** Work Item deletion が確定した timestamp です。 */
  deletedAt?: string
}

/**
 * Tree list cursor の scope-bound payload です。
 */
type DocumentTreeCursor = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor discriminator です。 */
  kind: 'document-tree'
  /** Cursor を発行した Workspace ID です。 */
  workspaceId: string
  /** Query scope fingerprint です。 */
  queryFingerprint: string
  /** 最後に評価した DynamoDB sort key です。 */
  recordKey: string
}

/**
 * Version list cursor の scope-bound payload です。
 */
type DocumentVersionCursor = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor discriminator です。 */
  kind: 'document-versions'
  /** Cursor を発行した Workspace ID です。 */
  workspaceId: string
  /** Cursor を発行した Document ID です。 */
  documentId: string
  /** 最後に評価した DynamoDB sort key です。 */
  recordKey: string
}

/**
 * Comment list cursor の scope-bound payload です。
 */
type DocumentCommentCursor = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor discriminator です。 */
  kind: 'document-comments'
  /** Cursor を発行した Workspace ID です。 */
  workspaceId: string
  /** Cursor を発行した Document ID です。 */
  documentId: string
  /** Root thread filter を含む query fingerprint です。 */
  queryFingerprint: string
  /** 最後に評価した DynamoDB sort key です。 */
  recordKey: string
}

/**
 * Backlink list cursor の scope-bound payload です。
 */
type DocumentBacklinkCursor = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor discriminator です。 */
  kind: 'document-backlinks'
  /** Cursor を発行した Workspace ID です。 */
  workspaceId: string
  /** Cursor を発行した relation target 種別です。 */
  targetKind: ListDocumentBacklinksRequest['targetKind']
  /** Cursor を発行した relation target ID です。 */
  targetId: string
  /** 最後に評価した DynamoDB sort key です。 */
  recordKey: string
}

type DocumentRelationDiff = {
  /** 新規または更新された relations です。 */
  added: DocumentRelation[]
  /** 削除または置換された relations です。 */
  removed: DocumentRelation[]
}

/**
 * 一つの Work Item target に coalesce した backlink count 差分です。
 */
type WorkItemBacklinkTargetDelta = {
  /** Canonical Work Item target ID です。 */
  targetId: string
  /** Transaction が増減する backlink row 数です。 */
  delta: number
}

/** DynamoDB transaction contribution used to fence Work Item deletion. */
export type DocumentWorkItemDeletionFenceTransactWrite = {
  /** Backlink count が 0 の場合だけ durable tombstone を保存する transaction item です。 */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/**
 * DynamoDB Documents client の dependency と runtime 設定です。
 */
export type DynamoDbDocumentsClientOptions = {
  /** DocumentsTable の物理 table name です。 */
  tableName?: string
  /** テストや既存 runtime から注入する DocumentClient です。 */
  documentClient?: DynamoDBDocumentClient
  /** Local table 自動作成に使う low-level client です。 */
  dynamoClient?: DynamoDBClient
  /** Local endpoint で table を自動作成するかどうかです。 */
  autoCreateLocal?: boolean
  /** Testable clock です。 */
  now?: () => Date
  /** Testable ID generator です。 */
  generateId?: () => string
  /** Idempotent public link token を導出する server-only secret です。 */
  publicShareTokenSecret?: string
  /** Mention notification の source event を保存する AuditEventsTable 名です。 */
  auditTableName?: string
}

/**
 * Single-table DynamoDB schema を使う Documents domain/store 実装です。
 */
export class DynamoDbDocumentsClient implements DocumentApplicationClient {
  /** DocumentsTable の物理 table name です。 */
  private readonly tableName: string
  /** DynamoDB document client です。 */
  private readonly client: DynamoDBDocumentClient
  /** Local table lifecycle 用 low-level DynamoDB client です。 */
  private readonly dynamoClient?: DynamoDBClient
  /** Local endpoint で table を作成するかどうかです。 */
  private readonly autoCreateLocal: boolean
  /** Mutation timestamp を生成する clock です。 */
  private readonly now: () => Date
  /** Public IDs を生成する function です。 */
  private readonly generateId: () => string
  /** Idempotent public link bearer token を導出する HMAC secret です。 */
  private readonly publicShareTokenSecret: string
  /** Document mention notification の source event を保存する table 名です。 */
  private readonly auditTableName?: string
  /** Opaque request tokens に紐づく compact ACL raw row read cache です。 */
  private readonly searchAccessRowsByContext = new WeakMap<
    DocumentSearchAccessReadContext,
    Map<
      string,
      Promise<Record<string, unknown> | undefined>
    >
  >()
  /** 同時初期化を一つへ束縛する promise です。 */
  private ensureTablePromise?: Promise<void>

  constructor(options: DynamoDbDocumentsClientOptions = {}) {
    this.tableName =
      options.tableName ??
      process.env.DOCUMENTS_TABLE_NAME ??
      process.env.MUKUROJI_DOCUMENTS_TABLE ??
      'mukuroji-documents-local'
    this.dynamoClient = options.dynamoClient ?? (
      options.documentClient === undefined
        ? createConfiguredDynamoDbClient()
        : undefined
    )
    this.client =
      options.documentClient ??
      createWorkspaceSearchWriterDynamoDbDocumentClient(
        this.dynamoClient ?? createConfiguredDynamoDbClient(),
      )
    this.autoCreateLocal =
      options.autoCreateLocal ??
      Boolean(
        process.env.DYNAMODB_ENDPOINT ??
          process.env.AWS_ENDPOINT_URL_DYNAMODB ??
          process.env.LOCALSTACK_HOSTNAME,
      )
    this.now = options.now ?? (() => new Date())
    this.generateId = options.generateId ?? randomUUID
    this.publicShareTokenSecret = resolvePublicShareTokenSecret(
      options.publicShareTokenSecret ??
        process.env.DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET,
    )
    this.auditTableName =
      options.auditTableName ??
      getConfiguredAuditTableName()
  }

  /** 現在の Document ACL generation を consistent read で返します。 */
  async getAuthorizationRevision(
    workspaceId: string,
  ): Promise<number> {
    await this.ensureTable()
    assertIdentifier(workspaceId, 'workspaceId')
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId,
          recordKey:
            DOCUMENT_AUTHORIZATION_REVISION_KEY,
        },
        ConsistentRead: true,
      }),
    )
    if (result.Item === undefined) return 0
    const item =
      result.Item as
        StoredDocumentAuthorizationRevisionItem
    if (
      item.entryType !==
        'document-authorization-revision' ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 1
    ) {
      throw new DocumentError(
        503,
        'InvalidDocumentAuthorizationRevision',
        'Document authorization data is invalid.',
      )
    }
    return item.revision
  }

  /** Member downgrade 前に private Document の manager 継続性を検証します。 */
  async getManagerLifecycleSnapshot(
    workspaceId: string,
    memberKey: string,
    eligibleManagerMemberKeys: readonly string[],
  ): Promise<DocumentManagerLifecycleSnapshot> {
    await this.ensureTable()
    assertIdentifier(workspaceId, 'workspaceId')
    assertIdentifier(memberKey, 'memberKey')
    const targetMemberKey =
      normalizeDocumentManagerMemberKey(memberKey)
    const eligibleManagers = new Set(
      eligibleManagerMemberKeys.map(
        normalizeDocumentManagerMemberKey,
      ),
    )

    for (
      let attempt = 0;
      attempt < DOCUMENT_CONDITIONAL_RETRY_LIMIT;
      attempt += 1
    ) {
      const authorizationRevision =
        await this.getAuthorizationRevision(workspaceId)
      let blockingDocumentId:
        | string
        | undefined
      let exclusiveStartKey:
        | Record<string, unknown>
        | undefined
      do {
        const result = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression:
              'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
            ExpressionAttributeValues: {
              ':workspaceId': workspaceId,
              ':prefix': 'SEARCH_ACCESS#',
            },
            ExclusiveStartKey: exclusiveStartKey,
            ConsistentRead: true,
          }),
        )
        for (const raw of result.Items ?? []) {
          const documentId =
            typeof raw.documentId === 'string'
              ? raw.documentId
              : undefined
          const row =
            documentId === undefined
              ? undefined
              : readDocumentSearchAccessItem(
                  raw,
                  workspaceId,
                  documentId,
                )
          if (row === undefined) {
            throw new DocumentError(
              503,
              'InvalidDocumentSearchAccessProjection',
              'Document authorization data is invalid.',
            )
          }
          const permission = row.permission
          if (permission.mode !== 'private') continue
          const managerKeys = permission.memberGrants
            .filter(({ role }) => role === 'manager')
            .map(({ memberKey: managerMemberKey }) =>
              normalizeDocumentManagerMemberKey(
                managerMemberKey,
              )
            )
          if (!managerKeys.includes(targetMemberKey)) {
            continue
          }
          const hasEligibleReplacement =
            managerKeys.some(
              (managerMemberKey) =>
                managerMemberKey !== targetMemberKey &&
                eligibleManagers.has(managerMemberKey),
            )
          if (!hasEligibleReplacement) {
            blockingDocumentId = row.documentId
            break
          }
        }
        if (blockingDocumentId !== undefined) {
          break
        }
        exclusiveStartKey =
          result.LastEvaluatedKey
      } while (exclusiveStartKey !== undefined)

      if (
        await this.getAuthorizationRevision(workspaceId) ===
          authorizationRevision
      ) {
        return {
          authorizationRevision,
          ...(blockingDocumentId === undefined
            ? {}
            : { blockingDocumentId }),
        }
      }
    }

    throw new DocumentError(
      409,
      'DocumentAuthorizationConflict',
      'Document permissions changed while validating the Workspace member.',
    )
  }

  /** Work Item delete transaction に Document backlink existence fence を追加します。 */
  async prepareWorkItemDeletionFenceTransactWrite(
    request: PrepareDocumentWorkItemDeletionFenceRequest,
  ): Promise<DocumentWorkItemDeletionFenceTransactWrite> {
    await this.ensureTable()
    assertIdentifier(request.workspaceId, 'workspaceId')
    validateCanonicalDocumentWorkItemId(
      request.workItemId,
      'workItemId',
    )
    const existing =
      await this.getWorkItemBacklinkTargetFence(
        request.workspaceId,
        request.workItemId,
      )
    if (existing === undefined) {
      const legacyBacklinkCount =
        await this.countStoredWorkItemBacklinks(
          request.workspaceId,
          request.workItemId,
        )
      if (legacyBacklinkCount > 0) {
        throw workItemDocumentBacklinkConflict(
          legacyBacklinkCount,
        )
      }
      return {
        transactWriteItem: {
          Put: {
            TableName: this.tableName,
            Item: createWorkItemBacklinkTargetFenceItem(
              request.workspaceId,
              request.workItemId,
              0,
              1,
              this.now().toISOString(),
            ),
            ConditionExpression:
              'attribute_not_exists(workspaceId)',
          },
        },
      }
    }
    if (existing.activeBacklinkCount > 0) {
      throw workItemDocumentBacklinkConflict(
        existing.activeBacklinkCount,
      )
    }
    return {
      transactWriteItem: {
        Put: {
          TableName: this.tableName,
          Item: {
            ...existing,
            version: existing.version + 1,
            deletedAt: this.now().toISOString(),
          } satisfies StoredDocumentBacklinkTargetFenceItem,
          ConditionExpression:
            '#entryType = :entryType AND ' +
            'schemaVersion = :schemaVersion AND ' +
            'targetKind = :targetKind AND targetId = :targetId AND ' +
            'activeBacklinkCount = :zero AND #version = :expectedVersion',
          ExpressionAttributeNames: {
            '#entryType': 'entryType',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':entryType':
              'document-backlink-target-fence',
            ':schemaVersion':
              DOCUMENT_BACKLINK_TARGET_FENCE_SCHEMA_VERSION,
            ':targetKind': 'work-item',
            ':targetId': request.workItemId,
            ':zero': 0,
            ':expectedVersion':
              existing.version,
          },
        },
      },
    }
  }

  /** Permission-filtered Document tree を page 取得します。 */
  async list(input: ListDocumentsRequest): Promise<DocumentTreeResponse> {
    await this.ensureTable()
    assertIdentifier(input.workspaceId, 'workspaceId')
    const limit = boundedLimit(input.limit, 100, 250)
    const queryFingerprint = fingerprint({
      scope: input.scope,
      parentId: input.parentId,
      archived: input.archived ?? false,
    })
    const cursor = input.cursor === undefined
      ? undefined
      : decodeTreeCursor(input.cursor, input.workspaceId, queryFingerprint)
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
      ExpressionAttributeValues: {
        ':workspaceId': input.workspaceId,
        ':prefix': 'DOCUMENT#',
      },
      ExclusiveStartKey: cursor === undefined
        ? undefined
        : { workspaceId: input.workspaceId, recordKey: cursor.recordKey },
      Limit: limit,
      ConsistentRead: true,
    }))
    const rows = (result.Items ?? []) as StoredDocumentItem[]
    const projectionContext: DocumentProjectionContext = {
      documentRows: new Map(
        rows.map((row) => [
          row.documentId,
          Promise.resolve(row),
        ]),
      ),
      preferences: new Map(),
    }
    const projectedNodes = await mapWithConcurrency(
      rows,
      8,
      async (row): Promise<DocumentNode | undefined> => {
        const document = row.document
        if (
          input.scope !== undefined &&
          !scopesEqual(document.scope, input.scope)
        ) {
          return undefined
        }
        if (
          input.parentId !== undefined &&
          document.parentId !== input.parentId
        ) {
          return undefined
        }
        if (
          (input.archived ?? false) !==
          Boolean(document.archivedAt)
        ) {
          return undefined
        }
        const ancestors = await this.loadAncestors(
          input.workspaceId,
          document,
          projectionContext,
        )
      if (
        !(input.archived ?? false) &&
          ancestors.some(
            (ancestor) =>
              ancestor.archivedAt !== undefined,
          )
      ) {
          return undefined
      }
        const projected = await this.projectDocument(
          input.workspaceId,
          document,
          input.access,
          projectionContext,
          ancestors,
        )
        return projected.capabilities.canView
          ? toDocumentNode(projected)
          : undefined
      },
    )
    const nodes = projectedNodes.filter(
      (node): node is DocumentNode =>
        node !== undefined,
    )
    const lastKey = result.LastEvaluatedKey?.recordKey
    return {
      nodes,
      nextCursor: typeof lastKey === 'string'
        ? encodeCursor({
            version: 1,
            kind: 'document-tree',
            workspaceId: input.workspaceId,
            queryFingerprint,
            recordKey: lastKey,
          } satisfies DocumentTreeCursor)
        : undefined,
    }
  }

  /** 一つの permission-filtered Document detail を取得します。 */
  async get(input: GetDocumentRequest): Promise<DocumentDetail> {
    await this.ensureTable()
    const row = await this.getDocumentRow(input.workspaceId, input.documentId)
    if (row === undefined || (!input.includeArchived && row.document.archivedAt !== undefined)) {
      throw documentNotFound()
    }
    const projectionContext: DocumentProjectionContext = {
      documentRows: new Map([
        [row.documentId, Promise.resolve(row)],
      ]),
      preferences: new Map(),
    }
    const ancestors = await this.loadAncestors(
      input.workspaceId,
      row.document,
      projectionContext,
    )
    if (ancestors.some((ancestor) => ancestor.archivedAt !== undefined)) {
      throw documentNotFound()
    }
    const document = await this.projectDocument(
      input.workspaceId,
      row.document,
      input.access,
      projectionContext,
      ancestors,
    )
    requireCapability(document.capabilities.canView, 'DocumentViewDenied')
    return document
  }

  /** Workspace search 候補を compact ACL projection で再検証します。 */
  async resolveSearchAccess(
    input: ResolveDocumentSearchAccessRequest,
  ): Promise<
    ResolvedDocumentSearchAccess | undefined
  > {
    await this.ensureTable()
    assertIdentifier(
      input.workspaceId,
      'workspaceId',
    )
    assertIdentifier(
      input.documentId,
      'documentId',
    )
    if (
      !Number.isSafeInteger(
        input.expectedRevision,
      ) ||
      input.expectedRevision < 1 ||
      typeof input.expectedUpdatedAt !==
        'string' ||
      !Number.isFinite(
        Date.parse(input.expectedUpdatedAt),
      )
    ) {
      return undefined
    }
    const row =
      await this.getDocumentSearchAccessRow(
        input.workspaceId,
        input.documentId,
        input.readContext,
      )
    if (
      row === undefined ||
      row.revision !==
        input.expectedRevision ||
      row.updatedAt !==
        input.expectedUpdatedAt ||
      row.archivedAt !== undefined
    ) {
      return undefined
    }

    const ancestors:
      StoredDocumentSearchAccessItem[] = []
    const seen = new Set([row.documentId])
    let parentId = row.parentId
    while (parentId !== undefined) {
      if (
        seen.has(parentId) ||
        ancestors.length >=
          DOCUMENT_MAX_TREE_DEPTH
      ) {
        return undefined
      }
      seen.add(parentId)
      const parent =
        await this.getDocumentSearchAccessRow(
          input.workspaceId,
          parentId,
          input.readContext,
        )
      if (
        parent === undefined ||
        parent.archivedAt !== undefined ||
        !scopesEqual(
          row.scope,
          parent.scope,
        )
      ) {
        return undefined
      }
      ancestors.push(parent)
      parentId = parent.parentId
    }

    const capabilities =
      this.resolveStoredDocumentCapabilities(
        row,
        input.access,
        ancestors,
      )
    if (!capabilities.canView) {
      return undefined
    }
    const bodyRow =
      await this.getDocumentSearchBodyRow(
        input.workspaceId,
        input.documentId,
      )
    if (
      bodyRow === undefined ||
      bodyRow.revision !== row.revision ||
      bodyRow.updatedAt !== row.updatedAt
    ) {
      return undefined
    }
    const body =
      decompressDocumentSearchBody(bodyRow)
    if (body === undefined) {
      return undefined
    }
    return {
      scope: structuredClone(row.scope),
      revision: row.revision,
      updatedAt: row.updatedAt,
      body,
    }
  }

  /** 新しい Document と revision 1 snapshot を作成します。 */
  async create(input: CreateDocumentRequest): Promise<DocumentDetail> {
    return this.createDocument(input)
  }

  /**
   * Persists a document with optional adapter-owned source lineage guards.
   *
   * @param input - Validated application request plus internal source guards.
   * @returns Created canonical document projection.
   */
  private async createDocument(
    input: CreateDocumentPersistenceRequest,
  ): Promise<DocumentDetail> {
    await this.ensureTable()
    if (
      !isRecord(input) ||
      !['folder', 'page', 'template', 'whiteboard'].includes(String(input.kind))
    ) {
      throw invalidPayload('Document create input is invalid.')
    }
    assertIdentifier(input.workspaceId, 'workspaceId')
    assertText(input.title, 'title', DOCUMENT_MAX_TITLE_LENGTH, false)
    validateDocumentScope(input.scope)
    requireScopeCreatePermission(input.scope, input.access)
    const treeMutationGuard =
      input.parentId === undefined
        ? undefined
        : await this.createTreeMutationGuard(input.workspaceId)
    let parentAuthorization:
      | DocumentAuthorizationSnapshot
      | undefined
    if (input.parentId !== undefined) {
      parentAuthorization =
        await this.validateParent(
        input.workspaceId,
        input.parentId,
        input.scope,
        input.access,
      )
    }
    const idempotencyHash = input.idempotencyKey === undefined
      ? undefined
      : sha256(input.idempotencyKey)
    const documentId = idempotencyHash === undefined
      ? this.generateId()
      : `doc_${idempotencyHash.slice(0, 32)}`
    const now = this.now().toISOString()
    const permission = normalizeDocumentPermissionForActor(
      input.permission ?? {
        mode: 'inherit',
        memberGrants: [],
      },
      input.access.memberKey,
    )
    const authorizationMutationGuard =
      permission.mode === 'private'
        ? await this.createAuthorizationMutationGuard(
            input.workspaceId,
            input.expectedAuthorizationRevision,
          )
        : undefined
    const mutationAuthorizationGuards =
      mergeAuthorizationGuards(
        input.workspaceId,
        input.access.authorizationSnapshots,
        input.relationTargetAuthorizationSnapshots,
        input.sourceAuthorizationGuards,
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [parentAuthorization],
        ),
      )
    const base = {
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      id: documentId,
      scope: structuredClone(input.scope),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      title: input.title.trim(),
      position: input.position ?? `${now}#${documentId}`,
      revision: 1,
      permission,
      relations: structuredClone(input.relations ?? []),
      favorite: false,
      capabilities: EMPTY_DOCUMENT_CAPABILITIES,
      createdByUserId: input.access.memberKey,
      updatedByUserId: input.access.memberKey,
      createdAt: now,
      updatedAt: now,
    }
    let document: DocumentDetail
    switch (input.kind) {
      case 'folder':
        document = { ...base, kind: 'folder', childCount: 0 }
        break
      case 'page':
        document = { ...base, kind: 'page', blocks: structuredClone(input.blocks ?? []) }
        break
      case 'template':
        document = { ...base, kind: 'template', blocks: structuredClone(input.blocks ?? []) }
        break
      case 'whiteboard':
        document = {
          ...base,
          kind: 'whiteboard',
          whiteboard: structuredClone(input.whiteboard ?? EMPTY_WHITEBOARD_CONTENT),
        }
    }
    validateDocumentPayload(document)
    const requestFingerprint =
      input.idempotencyFingerprint ??
      fingerprint({
        kind: input.kind,
        scope: input.scope,
        parentId: input.parentId,
        title: input.title,
        position: input.position,
        permission,
        blocks: input.blocks,
        whiteboard: input.whiteboard,
        relations: input.relations,
      })
    const row: StoredDocumentItem = {
      workspaceId: input.workspaceId,
      recordKey: documentKey(document.id),
      entryType: 'document',
      documentId: document.id,
      revision: document.revision,
      document,
      elementRevisions: initialElementRevisions(document, 1),
      operationConflictFloorRevision: 1,
      publicShareEpoch: 0,
      lastVersionSnapshotRevision: 1,
      lastVersionSnapshotAt: document.updatedAt,
      createIdempotencyKeyHash: idempotencyHash,
      createRequestFingerprint: requestFingerprint,
    }
    assertDynamoItemSize(row)
    const relationDiff: DocumentRelationDiff = {
      added: backlinkRelations(document),
      removed: [],
    }
    const backlinkMutationActions =
      await this.prepareBacklinkMutationActions(
        input.workspaceId,
        document.id,
        relationDiff,
      )
    const createActions: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: row,
          ConditionExpression: 'attribute_not_exists(workspaceId)',
        },
      },
      documentSearchAccessPut(
        this.tableName,
        input.workspaceId,
        document,
        true,
      ),
      documentSearchBodyPut(
        this.tableName,
        input.workspaceId,
        document,
        true,
      ),
      ...versionPutActions(
        this.tableName,
        createVersionItems(
          input.workspaceId,
          document,
          row.elementRevisions,
          'create',
        ),
      ),
      ...(document.parentId === undefined
        ? []
        : [
            documentChildIndexPut(
              this.tableName,
              input.workspaceId,
              document,
            ),
          ]),
      ...backlinkMutationActions,
      ...(treeMutationGuard === undefined
        ? []
        : [
            documentTreeRevisionPut(
              this.tableName,
              input.workspaceId,
              treeMutationGuard,
            ),
          ]),
      ...(authorizationMutationGuard === undefined
        ? []
        : [
            createDocumentAuthorizationRevisionPut(
              this.tableName,
              input.workspaceId,
              authorizationMutationGuard,
            ),
          ]),
      ...authorizationGuardConditionChecks(
        mutationAuthorizationGuards,
      ),
    ]
    assertTransactionSize(createActions)
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: createActions,
      }))
    } catch (error) {
      if (!isConditionalFailure(error)) throw normalizeDynamoError(error)
      if (
        !await this.authorizationGuardsMatch(
          mutationAuthorizationGuards,
        )
      ) {
        throw new DocumentError(
          409,
          'DocumentAuthorizationChanged',
          'Document authorization changed while creating the Document.',
        )
      }
      if (
        authorizationMutationGuard !== undefined &&
        await this.getAuthorizationRevision(
          input.workspaceId,
        ) !== authorizationMutationGuard.expectedRevision
      ) {
        throw new DocumentError(
          409,
          'DocumentAuthorizationConflict',
          'Document permissions changed concurrently.',
        )
      }
      if (
        treeMutationGuard !== undefined &&
        (await this.getDocumentTreeRevision(input.workspaceId)) !==
          treeMutationGuard.expectedRevision
      ) {
        throw new DocumentError(
          409,
          'DocumentTreeConflict',
          'The document tree changed concurrently.',
        )
      }
      const existing =
        await this.getDocumentRow(
          input.workspaceId,
          documentId,
        )
      if (idempotencyHash === undefined) {
        if (existing === undefined) {
          await this
            .throwIfAddedWorkItemTargetDeleted(
              input.workspaceId,
              relationDiff,
            )
        }
        throw new DocumentError(
          409,
          'DocumentCreateConflict',
          'The document could not be created concurrently.',
        )
      }
      if (existing === undefined) {
        await this
          .throwIfAddedWorkItemTargetDeleted(
            input.workspaceId,
            relationDiff,
          )
        throw new DocumentError(
          409,
          'DocumentCreateIdempotencyConflict',
          'The idempotency key has already been used with different input.',
        )
      }
      if (
        existing.createIdempotencyKeyHash !== idempotencyHash ||
        existing.createRequestFingerprint !== requestFingerprint
      ) {
        throw new DocumentError(
          409,
          'DocumentCreateIdempotencyConflict',
          'The idempotency key has already been used with different input.',
        )
      }
      const projected = await this.projectDocument(
        input.workspaceId,
        existing.document,
        input.access,
      )
      requireCapability(
        projected.capabilities.canView,
        'DocumentViewDenied',
      )
      return projected
    }
    return this.projectDocument(input.workspaceId, document, input.access)
  }

  /** Document metadata を revision 条件付きで更新します。 */
  async update(input: UpdateDocumentRequest): Promise<DocumentDetail> {
    await this.ensureTable()
    const authorization =
      await this.requireMutableDocument(
        input.workspaceId,
        input.documentId,
        input.access,
        'edit',
      )
    const row = authorization.documentRow
    const capabilities =
      this.resolveDocumentAuthorizationCapabilities(
        authorization,
        input.access,
      )
    requireExpectedRevision(row, input.expectedRevision)
    const normalizedPermission = input.permission === undefined
      ? undefined
      : normalizeDocumentPermissionForActor(input.permission, input.access.memberKey)
    if (input.scope !== undefined) validateDocumentScope(input.scope)
    if (input.permission !== undefined) {
      requireCapability(
        capabilities.canManagePermissions,
        'DocumentPermissionDenied',
      )
      validateDocumentPermission(normalizedPermission ?? input.permission)
    }
    const permissionAffectsAuthorization =
      normalizedPermission !== undefined &&
      stableStringify(normalizedPermission) !==
        stableStringify(row.document.permission) &&
      (
        normalizedPermission.mode === 'private' ||
        row.document.permission.mode === 'private'
      )
    const authorizationMutationGuard =
      permissionAffectsAuthorization
        ? await this.createAuthorizationMutationGuard(
            input.workspaceId,
            input.expectedAuthorizationRevision,
          )
        : undefined
    const nextScope = input.scope ?? row.document.scope
    const nextParentId = input.parentId === null
      ? undefined
      : input.parentId ?? row.document.parentId
    validateDocumentScope(nextScope)
    const scopeChanged = !scopesEqual(nextScope, row.document.scope)
    const parentChanged = nextParentId !== row.document.parentId
    const treeMutationGuard =
      scopeChanged || parentChanged
        ? await this.createTreeMutationGuard(input.workspaceId)
        : undefined
    if (scopeChanged || parentChanged) {
      requireCapability(
        capabilities.canManagePermissions,
        'DocumentTreePermissionDenied',
      )
      requireScopeManagePermission(nextScope, input.access)
    }
    let parentAuthorization:
      | DocumentAuthorizationSnapshot
      | undefined
    if (nextParentId !== undefined && (scopeChanged || parentChanged)) {
      parentAuthorization =
        await this.validateParent(
          input.workspaceId,
          nextParentId,
          nextScope,
          input.access,
          input.documentId,
          true,
        )
    }
    if (scopeChanged) {
      if (
        await this.hasDirectChildren(
          input.workspaceId,
          input.documentId,
        )
      ) {
        throw new DocumentError(
          409,
          'DocumentScopeHasChildren',
          'Move child documents before changing this document scope.',
        )
      }
    }
    const next = structuredClone(row.document)
    if (input.title !== undefined) {
      assertText(input.title, 'title', DOCUMENT_MAX_TITLE_LENGTH, false)
      next.title = input.title.trim()
    }
    if (input.position !== undefined) {
      assertText(input.position, 'position', 1_000, false)
      next.position = input.position
    }
    if (input.scope !== undefined) next.scope = structuredClone(input.scope)
    if (normalizedPermission !== undefined) next.permission = normalizedPermission
    if (input.parentId === null) delete next.parentId
    else if (input.parentId !== undefined) next.parentId = input.parentId
    incrementDocument(next, input.access.memberKey, this.now())
    validateDocumentPayload(next)
    const mutationAuthorizationGuards =
      mergeAuthorizationGuards(
        input.workspaceId,
        input.access.authorizationSnapshots,
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [
            authorization,
            parentAuthorization,
          ],
          [row.documentId],
        ),
      )
    await this.commitMutation(
      input.workspaceId,
      row,
      next,
      row.elementRevisions,
      'edit',
      undefined,
      treeMutationGuard,
      authorizationMutationGuard,
      mutationAuthorizationGuards,
    )
    return this.projectDocument(input.workspaceId, next, input.access)
  }

  /** API validation 前に operation receipts と未確定 operation を解決します。 */
  async prepareOperations(
    input: ApplyDocumentOperationsRequest,
  ): Promise<PrepareDocumentOperationsResponse> {
    await this.ensureTable()
    validateApplyOperationsRequest(input)
    const { documentRow: row } =
      await this.requireMutableDocument(
        input.workspaceId,
        input.documentId,
        input.access,
        'edit',
      )
    const receipts = await this.readOperationReceipts(input)
    if (receipts.pending.length > 0) {
      return {
        pendingInput: {
          ...input.input,
          operations: receipts.pending,
        },
      }
    }
    return {
      replay: createOperationReplayResponse(
        row,
        input.input.operations,
        receipts.accepted,
      ),
    }
  }

  /** Element-level operations を競合検出と idempotency 付きで適用します。 */
  async applyOperations(
    input: ApplyDocumentOperationsRequest,
  ): Promise<ApplyDocumentOperationsResponse> {
    await this.ensureTable()
    validateApplyOperationsRequest(input)
    for (let attempt = 0; attempt < DOCUMENT_CONDITIONAL_RETRY_LIMIT; attempt += 1) {
      const authorization =
        await this.requireMutableDocument(
          input.workspaceId,
          input.documentId,
          input.access,
          'edit',
        )
      const row = authorization.documentRow
      const mutationAuthorizationGuards =
        mergeAuthorizationGuards(
          input.workspaceId,
          input.access.authorizationSnapshots,
          input.relationTargetAuthorizationSnapshots,
          documentAuthorizationSnapshotGuards(
            this.tableName,
            input.workspaceId,
            [authorization],
            [row.documentId],
          ),
        )
      if (input.input.baseRevision > row.revision) {
        throw new DocumentError(
          409,
          'DocumentRevisionAhead',
          'baseRevision is newer than the current document revision.',
        )
      }
      const {
        pending,
        accepted: acceptedReceipts,
      } = await this.readOperationReceipts(input)
      if (
        input.validatedPendingOperationIds !==
          undefined
      ) {
        const validatedPendingOperationIds =
          new Set(
            input.validatedPendingOperationIds,
          )
        if (
          pending.some(
            ({ operationId }) =>
              !validatedPendingOperationIds.has(
                operationId,
              ),
          )
        ) {
          throw new DocumentError(
            409,
            'DocumentOperationPreflightChanged',
            'An operation receipt changed after validation. Retry the operation batch.',
          )
        }
      }
      if (pending.length === 0) {
        return createOperationReplayResponse(
          row,
          input.input.operations,
          acceptedReceipts,
        )
      }
      const conflictFloorRevision =
        row.operationConflictFloorRevision ?? 1
      const nextRevision = row.revision + 1
      const mutationTime = this.now()
      const reducerOperations = pending.map((operation): DocumentOperation => {
        if (operation.type !== 'upsert-relation') return operation
        return {
          ...operation,
          relation: {
            ...operation.relation,
            createdByUserId: input.access.memberKey,
            createdAt: mutationTime.toISOString(),
          },
        }
      })
      const reduced = reduceDocumentOperations({
        document: row.document,
        elementRevisions: row.elementRevisions,
        conflictFloorRevision,
        baseRevision: input.input.baseRevision,
        nextRevision,
        operations: reducerOperations,
      })
      const now = mutationTime
      reduced.document.updatedAt = now.toISOString()
      reduced.document.updatedByUserId = input.access.memberKey
      validateDocumentPayload(reduced.document)
      const compactedHistory = compactElementRevisionHistory(
        reduced.document,
        reduced.elementRevisions,
        conflictFloorRevision,
      )
      const createsVersionSnapshot =
        shouldCreateVersionSnapshot(
          row,
          reduced.document,
        )
      const nextRow: StoredDocumentItem = {
        ...row,
        revision: nextRevision,
        document: reduced.document,
        elementRevisions: compactedHistory.elementRevisions,
        operationConflictFloorRevision:
          compactedHistory.operationConflictFloorRevision,
        ...(createsVersionSnapshot
          ? {
              lastVersionSnapshotRevision:
                nextRevision,
              lastVersionSnapshotAt:
                reduced.document.updatedAt,
            }
          : {}),
      }
      const relationDiff = diffRelations(
        backlinkRelations(row.document),
        backlinkRelations(reduced.document),
      )
      const backlinkMutationActions =
        await this.prepareBacklinkMutationActions(
          input.workspaceId,
          input.documentId,
          relationDiff,
        )
      const receiptActions = pending.map((operation) => ({
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId: input.workspaceId,
            recordKey: operationKey(input.documentId, operation.operationId),
            entryType: 'document-operation',
            documentId: input.documentId,
            clientId: input.input.clientId,
            operationId: operation.operationId,
            fingerprint: fingerprint(operation),
            revision: nextRevision,
            createdAt: now.toISOString(),
            expiresAtEpoch:
              Math.floor(now.getTime() / 1_000) +
              DOCUMENT_OPERATION_RECEIPT_RETENTION_DAYS *
                SECONDS_PER_DAY,
          } satisfies StoredOperationReceipt,
          ConditionExpression:
            'attribute_not_exists(workspaceId) OR expiresAtEpoch <= :operationReceiptNowEpoch',
          ExpressionAttributeValues: {
            ':operationReceiptNowEpoch':
              Math.floor(now.getTime() / 1_000),
          },
        },
      }))
      const actions = [
        currentDocumentPut(this.tableName, nextRow, row.revision),
        documentSearchAccessPut(
          this.tableName,
          input.workspaceId,
          reduced.document,
        ),
        documentSearchBodyPut(
          this.tableName,
          input.workspaceId,
          reduced.document,
        ),
        ...versionPutActions(
          this.tableName,
          createVersionItems(
            input.workspaceId,
            reduced.document,
            compactedHistory.elementRevisions,
            'edit',
            undefined,
            {
              previousDocument: row.document,
              operations: reducerOperations,
              forceSnapshot:
                createsVersionSnapshot,
            },
          ),
        ),
        ...receiptActions,
        ...authorizationGuardConditionChecks(
          mutationAuthorizationGuards,
        ),
        ...backlinkMutationActions,
      ]
      assertTransactionSize(actions)
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: actions }))
        return {
          documentId: input.documentId,
          revision: nextRevision,
          appliedOperationIds: input.input.operations.map(({ operationId }) => operationId),
          updatedAt: reduced.document.updatedAt,
        }
      } catch (error) {
        const retryableTransactionConflict =
          isRetryableTransactionConflict(error)
        if (
          isConditionalFailure(error) ||
          retryableTransactionConflict
        ) {
          if (
            !await this.authorizationGuardsMatch(
              mutationAuthorizationGuards,
            )
          ) {
            throw new DocumentError(
              409,
              'DocumentAuthorizationChanged',
              'Document authorization changed while applying operations.',
            )
          }
          const latest =
            await this.getDocumentRow(
              input.workspaceId,
              input.documentId,
            )
          if (
            latest?.revision === row.revision
          ) {
            await this
              .throwIfAddedWorkItemTargetDeleted(
                input.workspaceId,
                relationDiff,
              )
          }
          if (
            attempt + 1 <
              DOCUMENT_CONDITIONAL_RETRY_LIMIT
          ) {
            continue
          }
          if (retryableTransactionConflict) {
            throw normalizeDynamoError(error)
          }
          throw new DocumentError(
            409,
            'DocumentConcurrentUpdate',
            'The document changed too frequently; retry the request.',
          )
        }
        throw normalizeDynamoError(error)
      }
    }
    throw new DocumentError(409, 'DocumentConcurrentUpdate', 'The document changed too frequently; retry the request.')
  }

  /** Immutable version history を page 取得します。 */
  async listVersions(input: ListDocumentVersionsRequest): Promise<DocumentVersionsResponse> {
    await this.ensureTable()
    await this.get({
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      access: input.access,
      includeArchived: true,
    })
    const limit = boundedLimit(input.limit, 50, 100)
    const cursor = input.cursor === undefined
      ? undefined
      : decodeVersionCursor(input.cursor, input.workspaceId, input.documentId)
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
      ExpressionAttributeValues: {
        ':workspaceId': input.workspaceId,
        ':prefix': `VERSION#${input.documentId}#`,
      },
      ExclusiveStartKey: cursor === undefined
        ? undefined
        : { workspaceId: input.workspaceId, recordKey: cursor.recordKey },
      Limit: limit,
      ScanIndexForward: false,
      ConsistentRead: true,
    }))
    const nowEpoch = Math.floor(
      this.now().getTime() / 1_000,
    )
    const versions = (result.Items ?? [])
      .map(
        (item) =>
          item as StoredDocumentVersionItem,
      )
      .filter(
        (item) =>
          item.expiresAtEpoch === undefined ||
          item.expiresAtEpoch > nowEpoch,
      )
      .map(({ version }) => version)
    const lastKey = result.LastEvaluatedKey?.recordKey
    return {
      versions,
      nextCursor: typeof lastKey === 'string'
        ? encodeCursor({
            version: 1,
            kind: 'document-versions',
            workspaceId: input.workspaceId,
            documentId: input.documentId,
            recordKey: lastKey,
          } satisfies DocumentVersionCursor)
        : undefined,
    }
  }

  /** 過去 version snapshot を新しい revision として復元します。 */
  async restoreVersion(input: RestoreDocumentVersionRequest): Promise<DocumentDetail> {
    await this.ensureTable()
    const authorization =
      await this.requireMutableDocument(
        input.workspaceId,
        input.documentId,
        input.access,
        'edit',
        true,
      )
    const row = authorization.documentRow
    requireExpectedRevision(row, input.expectedRevision)
    const versionItem = await this.findVersion(input.workspaceId, input.documentId, input.versionId)
    const restoredSnapshot = structuredClone(versionItem.document)
    const next = {
      ...restoredSnapshot,
      id: row.document.id,
      scope: structuredClone(row.document.scope),
      position: row.document.position,
      permission: structuredClone(row.document.permission),
      createdByUserId: row.document.createdByUserId,
      createdAt: row.document.createdAt,
      favorite: false,
      capabilities: EMPTY_DOCUMENT_CAPABILITIES,
    } as DocumentDetail
    if (row.document.parentId === undefined) delete next.parentId
    else next.parentId = row.document.parentId
    if (row.document.archivedAt === undefined) delete next.archivedAt
    else next.archivedAt = row.document.archivedAt
    delete next.lastOpenedAt
    next.revision = row.revision + 1
    next.updatedAt = this.now().toISOString()
    next.updatedByUserId = input.access.memberKey
    const relationTargetAuthorizationSnapshots =
      (
        await input.validateRelationTargets(
          collectDocumentRelationTargets(next),
        )
      ) ?? []
    let parentAuthorization:
      | DocumentAuthorizationSnapshot
      | undefined
    if (next.parentId !== undefined) {
      parentAuthorization =
        await this.validateParent(
          input.workspaceId,
          next.parentId,
          next.scope,
          input.access,
          next.id,
          false,
          false,
        )
    }
    const elementRevisions = restoredElementRevisions(
      row.document,
      next,
      row.elementRevisions,
      next.revision,
    )
    validateDocumentPayload(next)
    const mutationAuthorizationGuards =
      mergeAuthorizationGuards(
        input.workspaceId,
        input.access.authorizationSnapshots,
        authorizationSnapshotGuards(
          input.workspaceId,
          relationTargetAuthorizationSnapshots,
        ),
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [
            authorization,
            parentAuthorization,
          ],
          [row.documentId],
        ),
      )
    await this.commitMutation(
      input.workspaceId,
      row,
      next,
      elementRevisions,
      'restore',
      `Restored ${versionItem.version.id}`,
      undefined,
      undefined,
      mutationAuthorizationGuards,
    )
    return this.projectDocument(input.workspaceId, next, input.access)
  }

  /** Favorite または recent preference を保存します。 */
  async updatePreference(
    input: UpdateDocumentPreferenceRequest,
  ): Promise<DocumentPreferenceResult> {
    await this.ensureTable()
    const authorization =
      await this.requireDocumentCapabilityAuthorization(
        input.workspaceId,
        input.documentId,
        input.access,
        'canView',
        'DocumentViewDenied',
        true,
      )
    const document = await this.projectDocument(
      input.workspaceId,
      authorization.documentRow.document,
      input.access,
      undefined,
      authorization.ancestorRows.map(
        ({ document: ancestor }) =>
          ancestor,
      ),
    )
    if (input.openedAt !== undefined) {
      assertIsoTimestamp(input.openedAt, 'openedAt')
    }
    const mutationAuthorizationGuards =
      mergeAuthorizationGuards(
        input.workspaceId,
        input.access.authorizationSnapshots,
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [authorization],
        ),
      )
    for (
      let attempt = 0;
      attempt < DOCUMENT_CONDITIONAL_RETRY_LIMIT;
      attempt += 1
    ) {
      const existing = await this.getPreference(
        input.workspaceId,
        input.access.memberKey,
        input.documentId,
      )
      const now = this.now().toISOString()
      const openedAt = latestIsoTimestamp(
        input.openedAt,
        existing?.lastOpenedAt,
      )
      const item: StoredDocumentPreferenceItem = {
        workspaceId: input.workspaceId,
        recordKey: preferenceKey(
          input.access.memberKey,
          input.documentId,
        ),
        entryType: 'document-preference',
        memberKey: input.access.memberKey,
        documentId: input.documentId,
        preferenceRevision:
          (existing?.preferenceRevision ?? 0) + 1,
        favorite:
          input.favorite ?? existing?.favorite ?? false,
        lastOpenedAt: openedAt,
        updatedAt: now,
      }
      const recentItem: StoredDocumentRecentItem | undefined =
        openedAt === undefined
          ? undefined
          : {
              workspaceId: input.workspaceId,
              recordKey: recentKey(
                input.access.memberKey,
                openedAt,
                input.documentId,
              ),
              entryType: 'document-recent',
              memberKey: input.access.memberKey,
              documentId: input.documentId,
              favorite: item.favorite,
              lastOpenedAt: openedAt,
            }
      const actions: NonNullable<
        TransactWriteCommandInput['TransactItems']
      > = [
        {
          Put: {
            TableName: this.tableName,
            Item: item,
            ConditionExpression:
              existing === undefined
                ? 'attribute_not_exists(workspaceId)'
                : existing.preferenceRevision === undefined
                  ? 'attribute_not_exists(preferenceRevision)'
                  : 'preferenceRevision = :expectedPreferenceRevision',
            ...(existing?.preferenceRevision === undefined
              ? {}
              : {
                  ExpressionAttributeValues: {
                    ':expectedPreferenceRevision':
                      existing.preferenceRevision,
                  },
                }),
          },
        },
        ...(existing?.lastOpenedAt !== undefined &&
          existing.lastOpenedAt !== openedAt
          ? [{
              Delete: {
                TableName: this.tableName,
                Key: {
                  workspaceId: input.workspaceId,
                  recordKey: recentKey(
                    input.access.memberKey,
                    existing.lastOpenedAt,
                    input.documentId,
                  ),
                },
              },
            }]
          : []),
        ...(recentItem === undefined
          ? []
          : [{
              Put: {
                TableName: this.tableName,
                Item: recentItem,
              },
            }]),
        ...authorizationGuardConditionChecks(
          mutationAuthorizationGuards,
        ),
      ]
      assertTransactionSize(actions)
      try {
        await this.client.send(new TransactWriteCommand({
          TransactItems: actions,
        }))
        const node = toDocumentNode({
          ...document,
          favorite: item.favorite,
          ...(item.lastOpenedAt === undefined
            ? {}
            : { lastOpenedAt: item.lastOpenedAt }),
        })
        return {
          documentId: input.documentId,
          favorite: item.favorite,
          ...(item.lastOpenedAt === undefined
            ? {}
            : { lastOpenedAt: item.lastOpenedAt }),
          updatedAt: item.updatedAt,
          document: node,
        }
      } catch (error) {
        const retryableTransactionConflict =
          isRetryableTransactionConflict(error)
        if (
          isConditionalFailure(error) ||
          retryableTransactionConflict
        ) {
          if (
            !await this.authorizationGuardsMatch(
              mutationAuthorizationGuards,
            )
          ) {
            throw new DocumentError(
              409,
              'DocumentAuthorizationChanged',
              'Document authorization changed while updating the preference.',
            )
          }
          if (
            attempt + 1 <
              DOCUMENT_CONDITIONAL_RETRY_LIMIT
          ) {
            continue
          }
          if (retryableTransactionConflict) {
            throw normalizeDynamoError(error)
          }
          throw new DocumentError(
            409,
            'DocumentPreferenceConflict',
            'The document preference changed concurrently.',
          )
        }
        throw normalizeDynamoError(error)
      }
    }
    throw new DocumentError(
      409,
      'DocumentPreferenceConflict',
      'The document preference changed concurrently.',
    )
  }

  /** 現在 user の recent Documents を返します。 */
  async listRecent(input: ListRecentDocumentsRequest): Promise<DocumentNode[]> {
    await this.ensureTable()
    const limit = boundedLimit(input.limit, 20, 100)
    const nodes: DocumentNode[] = []
    const projectionContext: DocumentProjectionContext = {
      documentRows: new Map(),
      preferences: new Map(),
    }
    let evaluated = 0
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': input.workspaceId,
          ':prefix': recentPrefix(input.access.memberKey),
        },
        ExclusiveStartKey: exclusiveStartKey,
        Limit: Math.min(
          100,
          Math.max(limit * 2, 20),
          DOCUMENT_RECENT_EVALUATION_LIMIT - evaluated,
        ),
        ScanIndexForward: true,
        ConsistentRead: true,
      }))
      const recentItems = (result.Items ?? []) as
        StoredDocumentRecentItem[]
      evaluated += recentItems.length
      const projected = await mapWithConcurrency(
        recentItems,
        8,
        async (recent): Promise<DocumentNode | undefined> => {
          const row = await this.getCachedDocumentRow(
            input.workspaceId,
            recent.documentId,
            projectionContext,
          )
          if (
            row === undefined ||
            row.document.archivedAt !== undefined
          ) {
            return undefined
          }
          const ancestors = await this.loadAncestors(
            input.workspaceId,
            row.document,
            projectionContext,
          )
          if (
            ancestors.some(
              (ancestor) => ancestor.archivedAt !== undefined,
            )
          ) {
            return undefined
          }
          const document = await this.projectDocument(
            input.workspaceId,
            row.document,
            input.access,
            projectionContext,
            ancestors,
          )
          return document.capabilities.canView
            ? toDocumentNode({
                ...document,
                favorite: recent.favorite,
                lastOpenedAt: recent.lastOpenedAt,
              })
            : undefined
        },
      )
      for (const document of projected) {
        if (document !== undefined) nodes.push(document)
        if (nodes.length >= limit) break
      }
      exclusiveStartKey = result.LastEvaluatedKey
    } while (
      nodes.length < limit &&
      exclusiveStartKey !== undefined &&
      evaluated < DOCUMENT_RECENT_EVALUATION_LIMIT
    )
    return nodes
  }

  /** Document を soft archive します。 */
  async archive(input: ChangeDocumentArchiveStateRequest): Promise<DocumentDetail> {
    await this.ensureTable()
    const authorization =
      await this.requireDocumentCapabilityAuthorization(
        input.workspaceId,
        input.documentId,
        input.access,
        'canArchive',
        'DocumentArchiveDenied',
        true,
        false,
      )
    const row = authorization.documentRow
    requireExpectedRevision(row, input.expectedRevision)
    if (row.document.archivedAt !== undefined) {
      return this.projectDocument(
        input.workspaceId,
        row.document,
        input.access,
        undefined,
        authorization.ancestorRows.map(
          ({ document }) => document,
        ),
      )
    }
    const treeMutationGuard =
      row.document.kind === 'folder'
        ? await this.createTreeMutationGuard(input.workspaceId)
        : undefined
    const next = structuredClone(row.document)
    next.archivedAt = this.now().toISOString()
    incrementDocument(next, input.access.memberKey, this.now())
    await this.commitMutation(
      input.workspaceId,
      {
        ...row,
        publicShareEpoch:
          (row.publicShareEpoch ?? 0) + 1,
      },
      next,
      row.elementRevisions,
      'edit',
      'Archived document',
      treeMutationGuard,
      undefined,
      mergeAuthorizationGuards(
        input.workspaceId,
        input.access.authorizationSnapshots,
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [authorization],
          [row.documentId],
        ),
      ),
    )
    return this.projectDocument(input.workspaceId, next, input.access)
  }

  /** Archive 済み Document を tree へ復元します。 */
  async restoreArchived(input: ChangeDocumentArchiveStateRequest): Promise<DocumentDetail> {
    await this.ensureTable()
    const authorization =
      await this.requireDocumentCapabilityAuthorization(
        input.workspaceId,
        input.documentId,
        input.access,
        'canRestore',
        'DocumentRestoreDenied',
        true,
        false,
      )
    const row = authorization.documentRow
    requireExpectedRevision(row, input.expectedRevision)
    if (row.document.archivedAt === undefined) {
      return this.projectDocument(
        input.workspaceId,
        row.document,
        input.access,
        undefined,
        authorization.ancestorRows.map(
          ({ document }) => document,
        ),
      )
    }
    const next = structuredClone(row.document)
    delete next.archivedAt
    const requestedParentId = input.parentId === null
      ? undefined
      : input.parentId ?? row.document.parentId
    const parentChanged =
      requestedParentId !== row.document.parentId
    const treeMutationGuard =
      parentChanged || row.document.kind === 'folder'
        ? await this.createTreeMutationGuard(input.workspaceId)
        : undefined
    if (parentChanged) {
      requireScopeManagePermission(next.scope, input.access)
    }
    if (input.parentId === null) delete next.parentId
    else if (input.parentId !== undefined) next.parentId = input.parentId
    let parentAuthorization:
      | DocumentAuthorizationSnapshot
      | undefined
    if (next.parentId !== undefined) {
      parentAuthorization =
        await this.validateParent(
          input.workspaceId,
          next.parentId,
          next.scope,
          input.access,
          next.id,
          parentChanged,
          parentChanged,
        )
    }
    incrementDocument(next, input.access.memberKey, this.now())
    await this.commitMutation(
      input.workspaceId,
      row,
      next,
      row.elementRevisions,
      'restore',
      'Restored archived document',
      treeMutationGuard,
      undefined,
      mergeAuthorizationGuards(
        input.workspaceId,
        input.access.authorizationSnapshots,
        input.relationTargetAuthorizationSnapshots,
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [
            authorization,
            parentAuthorization,
          ],
          [row.documentId],
        ),
      ),
    )
    return this.projectDocument(input.workspaceId, next, input.access)
  }

  /** Template snapshot から新しい page を作成します。 */
  async instantiateTemplate(
    input: InstantiateDocumentTemplateRequest,
  ): Promise<DocumentDetail> {
    await this.ensureTable()
    const permission = normalizeDocumentPermissionForActor(
      input.permission ?? {
        mode: 'inherit',
        memberGrants: [],
      },
      input.access.memberKey,
    )
    const requestFingerprint = fingerprint({
      operation: 'instantiate-template',
      templateId: input.templateId,
      scope: input.scope,
      parentId: input.parentId,
      title: input.title,
      position: input.position,
      permission,
      actorMemberKey: input.access.memberKey,
    })
    if (input.idempotencyKey !== undefined) {
      assertText(input.idempotencyKey, 'idempotencyKey', 500, false)
      const idempotencyHash = sha256(input.idempotencyKey)
      const existing = await this.getDocumentRow(
        input.workspaceId,
        `doc_${idempotencyHash.slice(0, 32)}`,
      )
      if (existing !== undefined) {
        if (
          existing.createIdempotencyKeyHash !== idempotencyHash ||
          existing.createRequestFingerprint !== requestFingerprint
        ) {
          throw new DocumentError(
            409,
            'DocumentCreateIdempotencyConflict',
            'The idempotency key has already been used with different input.',
          )
        }
        const projected = await this.projectDocument(
          input.workspaceId,
          existing.document,
          input.access,
        )
        requireCapability(
          projected.capabilities.canView,
          'DocumentViewDenied',
        )
        return projected
      }
    }
    const templateAuthorization =
      await this.requireDocumentCapabilityAuthorization(
        input.workspaceId,
        input.templateId,
        input.access,
        'canView',
        'DocumentViewDenied',
      )
    const template =
      templateAuthorization.documentRow.document
    if (template.kind !== 'template') {
      throw new DocumentError(400, 'DocumentIsNotTemplate', 'The source document is not a template.')
    }
    const blocks = template.blocks.map((block) => ({
      ...structuredClone(block),
      id:
        input.idempotencyKey === undefined
          ? this.generateId()
          : createIdempotentTemplateBlockId(
              input.workspaceId,
              input.idempotencyKey,
              block.id,
            ),
    })) as DocumentBlock[]
    return this.createDocument({
      workspaceId: input.workspaceId,
      access: input.access,
      kind: 'page',
      scope: input.scope,
      parentId: input.parentId,
      title: input.title ?? template.title,
      position: input.position,
      permission,
      blocks,
      relations: [],
      sourceAuthorizationGuards:
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [templateAuthorization],
        ),
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: requestFingerprint,
      expectedAuthorizationRevision:
        input.expectedAuthorizationRevision,
    })
  }

  /** Comment create の確定済み idempotent replay を検証して返します。 */
  async getCommentCreateReplay(
    input: CreateDocumentCommentRequest,
  ): Promise<StoredDocumentComment | undefined> {
    await this.ensureTable()
    const document = await this.get({
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      access: input.access,
    })
    requireCapability(
      document.capabilities.canComment,
      'DocumentCommentDenied',
    )
    const normalized =
      normalizeCommentCreateRequest(input)
    if (normalized.id === undefined) return undefined
    return this.readCommentCreateReplay(
      input.workspaceId,
      input.documentId,
      normalized.id,
      input.access.memberKey,
      normalized.fingerprint,
    )
  }

  /** Root comment または reply を作成します。 */
  async createComment(
    input: CreateDocumentCommentRequest,
  ): Promise<StoredDocumentComment> {
    await this.ensureTable()
    const authorization =
      await this.requireDocumentCapabilityAuthorization(
        input.workspaceId,
        input.documentId,
        input.access,
        'canComment',
        'DocumentCommentDenied',
      )
    const document =
      authorization.documentRow.document
    const normalized = normalizeCommentCreateRequest(input)
    const id = normalized.id ?? this.generateId()
    if (normalized.id !== undefined) {
      const replay = await this.readCommentCreateReplay(
        input.workspaceId,
        input.documentId,
        normalized.id,
        input.access.memberKey,
        normalized.fingerprint,
      )
      if (replay !== undefined) return replay
    }
    const mentions = normalized.mentions
    const anchor = normalized.anchor
    validateCommentAnchor(anchor, document)
    let parentCommentId: string | undefined
    let storedParent: StoredDocumentCommentItem | undefined
    if (input.parentCommentId !== undefined) {
      storedParent = await this.findStoredComment(
        input.workspaceId,
        input.documentId,
        input.parentCommentId,
      )
      if (storedParent.parentCommentId !== undefined) {
        throw new DocumentError(400, 'InvalidDocumentCommentThread', 'Replies must reference a root comment.')
      }
      if (storedParent.resolved) {
        throw new DocumentError(
          409,
          'DocumentCommentThreadResolved',
          'Resolved comment threads cannot receive replies.',
        )
      }
      parentCommentId = storedParent.id
    }
    assertIdentifier(id, 'commentId')
    const now = this.now().toISOString()
    const comment: StoredDocumentComment = {
      id,
      documentId: input.documentId,
      ...(parentCommentId === undefined ? {} : { parentCommentId }),
      anchor,
      body: input.body,
      mentions,
      authorUserId: input.access.memberKey,
      resolved: false,
      createdAt: now,
      updatedAt: now,
    }
    const item: StoredDocumentCommentItem = {
      ...comment,
      workspaceId: input.workspaceId,
      recordKey: commentKey(input.documentId, now, id),
      entryType: 'document-comment',
    }
    const receipt: StoredDocumentCommentReceiptItem = {
      workspaceId: input.workspaceId,
      recordKey: commentReceiptKey(input.documentId, id),
      entryType: 'document-comment-receipt',
      documentId: input.documentId,
      commentId: id,
      commentRecordKey: item.recordKey,
      authorUserId: comment.authorUserId,
      fingerprint: normalized.id === undefined
        ? commentSemanticFingerprint(comment)
        : normalized.fingerprint,
    }
    const notificationCandidates = [
      ...new Set(
        mentions
          .map(({ userId }) => userId.trim().toLowerCase())
          .filter((memberKey) =>
            memberKey !== input.access.memberKey.trim().toLowerCase()
          ),
      ),
    ].map((memberKey) => ({
      memberKey,
      reason: 'mention',
    }))
    const auditPut = createMutationAuditEventPut(
      this.auditTableName,
      input.auditContext,
      {
        directoryId: input.workspaceId,
        eventType: parentCommentId === undefined
          ? 'document.comment.created'
          : 'document.comment.replied',
        entityType: 'document',
        entityId: input.documentId,
        target: {
          type: 'comment',
          id: `document/${input.documentId}/comment/${id}`,
        },
        action: parentCommentId === undefined ? 'commented' : 'replied',
        occurredAt: now,
        changes: createAuditFieldChanges(
          undefined,
          { body: input.body },
          ['body'],
          ['body'],
        ),
        summary: parentCommentId === undefined
          ? 'A document comment mentioned you.'
          : 'A document reply mentioned you.',
        metadata: {
          actorMemberKey: input.access.memberKey,
          commentId: id,
          ...(parentCommentId === undefined
            ? {}
            : { rootCommentId: parentCommentId }),
          deepLink:
            `/documents/${encodeURIComponent(input.documentId)}` +
            `?context=comments&commentId=${encodeURIComponent(id)}` +
            (parentCommentId === undefined
              ? ''
              : `&rootCommentId=${encodeURIComponent(parentCommentId)}`),
          notificationTitle: document.title,
          notificationCandidates,
        },
      },
    )
    const mutationAuthorizationGuards =
      mergeAuthorizationGuards(
        input.workspaceId,
        input.access.authorizationSnapshots,
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [authorization],
        ),
      )
    const actions: NonNullable<
      TransactWriteCommandInput['TransactItems']
    > = [
      ...(storedParent === undefined
        ? []
        : [{
            ConditionCheck: {
              TableName: this.tableName,
              Key: {
                workspaceId: input.workspaceId,
                recordKey: storedParent.recordKey,
              },
              ConditionExpression:
                'resolved = :unresolved AND updatedAt = :parentUpdatedAt',
              ExpressionAttributeValues: {
                ':unresolved': false,
                ':parentUpdatedAt': storedParent.updatedAt,
              },
            },
          }]),
      {
        Put: {
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(workspaceId)',
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: receipt,
          ConditionExpression: 'attribute_not_exists(workspaceId)',
        },
      },
      ...(auditPut === undefined ? [] : [auditPut]),
      ...authorizationGuardConditionChecks(
        mutationAuthorizationGuards,
      ),
    ]
    assertTransactionSize(actions)
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: actions,
      }))
      return comment
    } catch (error) {
      if (!isConditionalFailure(error)) {
        throw normalizeDynamoError(error)
      }
      if (
        !await this.authorizationGuardsMatch(
          mutationAuthorizationGuards,
        )
      ) {
        throw new DocumentError(
          409,
          'DocumentAuthorizationChanged',
          'Document authorization changed while creating the comment.',
        )
      }
      if (input.commentId !== undefined) {
        const replay = await this.readCommentCreateReplay(
          input.workspaceId,
          input.documentId,
          id,
          input.access.memberKey,
          receipt.fingerprint,
        )
        if (replay !== undefined) return replay
      }
      if (storedParent !== undefined) {
        const currentParent = await this.findStoredComment(
          input.workspaceId,
          input.documentId,
          storedParent.id,
        )
        if (currentParent.resolved) {
          throw new DocumentError(
            409,
            'DocumentCommentThreadResolved',
            'Resolved comment threads cannot receive replies.',
          )
        }
        if (currentParent.updatedAt !== storedParent.updatedAt) {
          throw new DocumentError(
            409,
            'DocumentCommentConflict',
            'The comment thread changed concurrently.',
          )
        }
      }
      throw new DocumentError(
        409,
        'DocumentCommentConflict',
        'The comment could not be created concurrently.',
      )
    }
  }

  private async readCommentCreateReplay(
    workspaceId: string,
    documentId: string,
    commentId: string,
    authorUserId: string,
    requestFingerprint: string,
  ): Promise<StoredDocumentComment | undefined> {
    const existingReceiptResult = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId,
          recordKey: commentReceiptKey(
            documentId,
            commentId,
          ),
        },
        ConsistentRead: true,
      }),
    )
    const existingReceipt = existingReceiptResult.Item as
      | StoredDocumentCommentReceiptItem
      | undefined
    if (existingReceipt === undefined) return undefined
    if (
      existingReceipt.documentId !== documentId ||
      existingReceipt.authorUserId !== authorUserId ||
      existingReceipt.fingerprint !== requestFingerprint
    ) {
      throw new DocumentError(
        409,
        'DocumentCommentIdempotencyConflict',
        'The comment ID has already been used with different input.',
      )
    }
    return stripCommentStorageFields(
      await this.getStoredCommentByRecordKey(
        workspaceId,
        existingReceipt.commentRecordKey,
      ),
    )
  }

  /** Document comments を page 取得します。 */
  async listComments(
    input: ListDocumentCommentsRequest,
  ): Promise<DocumentCommentsResponse> {
    await this.ensureTable()
    await this.get({
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      access: input.access,
      includeArchived: true,
    })
    if (input.rootCommentId !== undefined) {
      assertIdentifier(input.rootCommentId, 'rootCommentId')
    }
    const limit = boundedLimit(
      input.limit,
      50,
      DOCUMENT_COMMENT_MAX_PAGE_LIMIT,
    )
    const queryFingerprint = fingerprint({
      rootCommentId: input.rootCommentId,
    })
    const cursor = input.cursor === undefined
      ? undefined
      : decodeCommentCursor(
          input.cursor,
          input.workspaceId,
          input.documentId,
          queryFingerprint,
        )
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
      ExpressionAttributeValues: {
        ':workspaceId': input.workspaceId,
        ':prefix': `COMMENT#${encodeKeyPart(input.documentId)}#`,
      },
      ExclusiveStartKey: cursor === undefined
        ? undefined
        : { workspaceId: input.workspaceId, recordKey: cursor.recordKey },
      Limit: limit,
      ScanIndexForward: false,
      ConsistentRead: true,
    }))
    const comments = (result.Items ?? []).map(stripCommentStorageFields)
    const filteredComments = input.rootCommentId === undefined
      ? comments
      : comments.filter(
          (comment) =>
            comment.id === input.rootCommentId ||
            comment.parentCommentId === input.rootCommentId,
        )
    const lastKey = result.LastEvaluatedKey?.recordKey
    return {
      comments: filteredComments,
      nextCursor: typeof lastKey === 'string'
        ? encodeCursor({
            version: 1,
            kind: 'document-comments',
            workspaceId: input.workspaceId,
            documentId: input.documentId,
            queryFingerprint,
            recordKey: lastKey,
          } satisfies DocumentCommentCursor)
        : undefined,
    }
  }

  /** Root comment を resolve または reopen します。 */
  async resolveComment(
    input: ResolveDocumentCommentRequest,
  ): Promise<StoredDocumentComment> {
    await this.ensureTable()
    const authorization =
      await this.requireDocumentCapabilityAuthorization(
        input.workspaceId,
        input.documentId,
        input.access,
        'canComment',
        'DocumentCommentDenied',
        true,
      )
    const stored = await this.findStoredComment(
      input.workspaceId,
      input.documentId,
      input.commentId,
    )
    if (stored.parentCommentId !== undefined) {
      throw new DocumentError(400, 'InvalidDocumentCommentThread', 'Only root comments can be resolved.')
    }
    const now = this.now().toISOString()
    const next: StoredDocumentCommentItem = {
      ...stored,
      resolved: input.resolved,
      updatedAt: now,
      ...(input.resolved
        ? { resolvedAt: now, resolvedByUserId: input.access.memberKey }
        : { resolvedAt: undefined, resolvedByUserId: undefined }),
    }
    const mutationAuthorizationGuards =
      mergeAuthorizationGuards(
        input.workspaceId,
        input.access.authorizationSnapshots,
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [authorization],
        ),
      )
    const actions: NonNullable<
      TransactWriteCommandInput['TransactItems']
    > = [
      {
        Put: {
          TableName: this.tableName,
          Item: next,
          ConditionExpression: 'updatedAt = :updatedAt',
          ExpressionAttributeValues: {
            ':updatedAt': stored.updatedAt,
          },
        },
      },
      ...authorizationGuardConditionChecks(
        mutationAuthorizationGuards,
      ),
    ]
    assertTransactionSize(actions)
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: actions,
      }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        if (
          !await this.authorizationGuardsMatch(
            mutationAuthorizationGuards,
          )
        ) {
          throw new DocumentError(
            409,
            'DocumentAuthorizationChanged',
            'Document authorization changed while resolving the comment.',
          )
        }
        throw new DocumentError(409, 'DocumentCommentConflict', 'The comment changed concurrently.')
      }
      throw normalizeDynamoError(error)
    }
    return stripCommentStorageFields(next)
  }

  /** Presence lease を更新します。 */
  async heartbeatPresence(
    input: HeartbeatDocumentPresenceRequest,
  ): Promise<void> {
    await this.ensureTable()
    const authorization =
      await this.requireDocumentCapabilityAuthorization(
        input.workspaceId,
        input.documentId,
        input.access,
        'canView',
        'DocumentViewDenied',
      )
    const document =
      authorization.documentRow.document
    assertIdentifier(input.clientId, 'clientId')
    if (input.selection != null) {
      validatePresenceSelection(input.selection, document)
    }
    const ttlSeconds = Math.min(300, Math.max(15, input.ttlSeconds ?? 60))
    const now = this.now()
    const item: StoredDocumentPresenceItem = {
      workspaceId: input.workspaceId,
      recordKey: presenceKey(
        input.documentId,
        input.access.memberKey,
      ),
      entryType: 'document-presence',
      documentId: input.documentId,
      userId: input.access.memberKey,
      clientId: input.clientId,
      displayName: input.displayName ?? input.access.memberKey,
      color: input.color !== undefined && isSafeCssColor(input.color) ? input.color : '#64748b',
      ...(input.selection == null ? {} : { selection: structuredClone(input.selection) }),
      lastSeenAt: now.toISOString(),
      expiresAtEpoch: Math.floor(now.getTime() / 1_000) + ttlSeconds,
    }
    const mutationAuthorizationGuards =
      mergeAuthorizationGuards(
        input.workspaceId,
        input.access.authorizationSnapshots,
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [authorization],
        ),
      )
    const actions: NonNullable<
      TransactWriteCommandInput['TransactItems']
    > = [
      {
        Put: {
          TableName: this.tableName,
          Item: item,
          ConditionExpression:
            'attribute_not_exists(userId) OR userId = :userId',
          ExpressionAttributeValues: {
            ':userId': input.access.memberKey,
          },
        },
      },
      ...authorizationGuardConditionChecks(
        mutationAuthorizationGuards,
      ),
    ]
    assertTransactionSize(actions)
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: actions,
      }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        if (
          !await this.authorizationGuardsMatch(
            mutationAuthorizationGuards,
          )
        ) {
          throw new DocumentError(
            409,
            'DocumentAuthorizationChanged',
            'Document authorization changed while updating presence.',
          )
        }
        throw new DocumentError(
          409,
          'DocumentPresenceClientConflict',
          'The presence client ID is already in use.',
        )
      }
      throw normalizeDynamoError(error)
    }
  }

  /** Browser client の presence lease を削除します。 */
  async leavePresence(input: DocumentPresenceRequest): Promise<void> {
    await this.ensureTable()
    if (input.clientId === undefined) {
      throw new DocumentError(400, 'DocumentPresenceClientRequired', 'clientId is required.')
    }
    assertIdentifier(input.clientId, 'clientId')
    const authorization =
      await this.requireDocumentCapabilityAuthorization(
        input.workspaceId,
        input.documentId,
        input.access,
        'canView',
        'DocumentViewDenied',
      )
    const mutationAuthorizationGuards =
      mergeAuthorizationGuards(
        input.workspaceId,
        input.access.authorizationSnapshots,
        documentAuthorizationSnapshotGuards(
          this.tableName,
          input.workspaceId,
          [authorization],
        ),
      )
    const actions: NonNullable<
      TransactWriteCommandInput['TransactItems']
    > = [
      {
        Delete: {
          TableName: this.tableName,
          Key: {
            workspaceId: input.workspaceId,
            recordKey: presenceKey(
              input.documentId,
              input.access.memberKey,
            ),
          },
          ConditionExpression:
            'clientId = :clientId',
          ExpressionAttributeValues: {
            ':clientId': input.clientId,
          },
        },
      },
      ...authorizationGuardConditionChecks(
        mutationAuthorizationGuards,
      ),
    ]
    assertTransactionSize(actions)
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: actions,
      }))
    } catch (error) {
      if (!isConditionalFailure(error)) {
        throw normalizeDynamoError(error)
      }
      if (
        !await this.authorizationGuardsMatch(
          mutationAuthorizationGuards,
        )
      ) {
        throw new DocumentError(
          409,
          'DocumentAuthorizationChanged',
          'Document authorization changed while leaving presence.',
        )
      }
    }
  }

  /** 有効な presence leases を member ごとに返します。 */
  async listPresence(
    input: DocumentPresenceRequest,
  ): Promise<StoredDocumentPresence[]> {
    await this.ensureTable()
    await this.get({
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      access: input.access,
    })
    const nowEpoch = Math.floor(this.now().getTime() / 1_000)
    const presences: StoredDocumentPresence[] = []
    let exclusiveStartKey:
      | Record<string, unknown>
      | undefined
    let evaluated = 0
    while (
      presences.length <
        DOCUMENT_PRESENCE_MAX_VISIBLE &&
      evaluated <
        DOCUMENT_PRESENCE_EVALUATION_LIMIT
    ) {
      const limit = Math.min(
        250,
        DOCUMENT_PRESENCE_EVALUATION_LIMIT -
          evaluated,
      )
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
          ExpressionAttributeValues: {
            ':workspaceId': input.workspaceId,
            ':prefix': `PRESENCE#${encodeKeyPart(input.documentId)}#`,
          },
          ExclusiveStartKey: exclusiveStartKey,
          Limit: limit,
          ConsistentRead: true,
        }),
      )
      const items = (result.Items ?? []).map(
        (item) => item as StoredDocumentPresenceItem,
      )
      evaluated += items.length
      for (const item of items) {
        if (item.expiresAtEpoch <= nowEpoch) continue
        presences.push(stripPresenceStorageFields(item))
        if (
          presences.length >=
          DOCUMENT_PRESENCE_MAX_VISIBLE
        ) {
          break
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey
      if (exclusiveStartKey === undefined) break
    }
    return presences
  }

  /** Expiring public link を作成し raw token を一度だけ返します。 */
  async createPublicShare(
    input: CreateDocumentPublicShareRequest,
  ): Promise<CreatedDocumentPublicShare> {
    await this.ensureTable()
    const authorizationGuards =
      requireAuthorizationGuards(
        input.workspaceId,
        input.access,
      )
    const expiresAt = parseShareExpiry(input.expiresAt, this.now())
    if (input.idempotencyKey !== undefined) {
      assertText(input.idempotencyKey, 'idempotencyKey', 500, false)
    }
    const idempotencyHash = input.idempotencyKey === undefined
      ? undefined
      : sha256(input.idempotencyKey)
    const token = input.idempotencyKey === undefined
      ? randomBytes(DOCUMENT_PUBLIC_SHARE_TOKEN_BYTES).toString('base64url')
      : createIdempotentPublicShareToken(
          this.publicShareTokenSecret,
          input.workspaceId,
          input.idempotencyKey,
        )
    const tokenHash = sha256(token)
    const shareId = idempotencyHash === undefined
      ? this.generateId()
      : `share_${idempotencyHash.slice(0, 32)}`
    const now = this.now().toISOString()
    const requestFingerprint = fingerprint({
      documentId: input.documentId,
      expiresAt: expiresAt.toISOString(),
      allowExport: input.allowExport ?? false,
      createdByUserId: input.access.memberKey,
    })
    const share: StoredDocumentPublicShare = {
      type: 'public',
      id: shareId,
      documentId: input.documentId,
      role: 'viewer',
      expiresAt: expiresAt.toISOString(),
      allowExport: input.allowExport ?? false,
      createdByUserId: input.access.memberKey,
      createdAt: now,
    }
    const expiresAtEpoch = Math.floor(expiresAt.getTime() / 1_000)
    for (
      let attempt = 0;
      attempt <
        DOCUMENT_CONDITIONAL_RETRY_LIMIT;
      attempt += 1
    ) {
      const authorization =
        await this.requireShareAuthorization(
          input.workspaceId,
          input.documentId,
          input.access,
          false,
        )
      const documentShareEpochs =
        documentShareEpochLineage(
          authorization,
        )
      const shareItem: StoredDocumentShareItem = {
        ...share,
        workspaceId: input.workspaceId,
        recordKey: shareKey(
          input.documentId,
          shareId,
        ),
        entryType: 'document-share',
        tokenHash,
        expiresAtEpoch,
        documentShareEpochs,
        ...(idempotencyHash === undefined
          ? {}
          : {
              createIdempotencyKeyHash:
                idempotencyHash,
              createRequestFingerprint:
                requestFingerprint,
            }),
      }
      const linkItem: StoredPublicLinkItem = {
        workspaceId:
          publicPartitionKey(tokenHash),
        recordKey: 'LINK',
        entryType: 'document-public-link',
        targetWorkspaceId:
          input.workspaceId,
        documentId: input.documentId,
        shareId,
        expiresAt: share.expiresAt,
        documentShareEpochs,
        expiresAtEpoch,
      }
      const actions: NonNullable<
        TransactWriteCommandInput['TransactItems']
      > = [
          {
            Put: {
              TableName: this.tableName,
              Item: shareItem,
              ConditionExpression: 'attribute_not_exists(workspaceId)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: linkItem,
              ConditionExpression: 'attribute_not_exists(workspaceId)',
            },
          },
          ...documentAuthorizationConditionChecks(
            this.tableName,
            input.workspaceId,
            authorization,
          ),
          ...authorizationGuards.map(
            authorizationGuardConditionCheck,
          ),
        ]
      assertTransactionSize(actions)
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: actions,
          }),
        )
        return { share, token }
      } catch (error) {
        const retryableTransactionConflict =
          isRetryableTransactionConflict(error)
        if (
          !isConditionalFailure(error) &&
          !retryableTransactionConflict
        ) {
          throw normalizeDynamoError(error)
        }
        await this.verifyAuthorizationGuard(
          input.workspaceId,
          input.access,
        )
        const latestAuthorization =
          await this.requireShareAuthorization(
            input.workspaceId,
            input.documentId,
            input.access,
            false,
          )
        if (idempotencyHash !== undefined) {
          const existing =
            await this.client.send(
              new GetCommand({
                TableName: this.tableName,
                Key: {
                  workspaceId:
                    input.workspaceId,
                  recordKey: shareKey(
                    input.documentId,
                    shareId,
                  ),
                },
                ConsistentRead: true,
              }),
            )
          const stored = existing.Item === undefined
            ? undefined
            : readStoredDocumentShareItem(
                existing.Item,
                input.workspaceId,
                input.documentId,
                shareId,
              )
          if (
            stored !== undefined &&
            stored.createIdempotencyKeyHash ===
              idempotencyHash &&
            stored.createRequestFingerprint ===
              requestFingerprint &&
            stored.tokenHash === tokenHash &&
            stableStringify(
              stored.documentShareEpochs,
            ) ===
              stableStringify(
                documentShareEpochLineage(
                  latestAuthorization,
                ),
              )
          ) {
            return {
              share:
                stripShareStorageFields(
                  stored,
                ),
              token,
            }
          }
          if (stored !== undefined) {
            throw new DocumentError(
              409,
              'DocumentShareIdempotencyConflict',
              'The idempotency key has already been used with different input or before the document was archived.',
            )
          }
        }
        if (
          attempt + 1 <
            DOCUMENT_CONDITIONAL_RETRY_LIMIT
        ) {
          continue
        }
        if (retryableTransactionConflict) {
          throw normalizeDynamoError(error)
        }
        throw new DocumentError(
          409,
          'DocumentShareConcurrentUpdate',
          'Document authorization changed too frequently; retry the request.',
        )
      }
    }
    throw new DocumentError(
      409,
      'DocumentShareConcurrentUpdate',
      'Document authorization changed too frequently; retry the request.',
    )
  }

  /** Document の public shares を返します。 */
  async listPublicShares(
    input: DocumentPublicShareRequest,
  ): Promise<StoredDocumentPublicShare[]> {
    await this.ensureTable()
    await this.requireShareAuthorization(
      input.workspaceId,
      input.documentId,
      input.access,
      true,
    )
    const shares: StoredDocumentPublicShare[] = []
    let exclusiveStartKey:
      | Record<string, unknown>
      | undefined
    do {
      const result =
        await this.client.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
          ExpressionAttributeValues: {
            ':workspaceId': input.workspaceId,
            ':prefix': `SHARE#${encodeKeyPart(input.documentId)}#`,
          },
          ExclusiveStartKey: exclusiveStartKey,
          ConsistentRead: true,
        }))
      shares.push(
        ...(result.Items ?? []).map(
          (item) => stripShareStorageFields(
            readStoredDocumentShareItem(
              item,
              input.workspaceId,
              input.documentId,
            ),
          ),
        ),
      )
      exclusiveStartKey =
        result.LastEvaluatedKey
    } while (exclusiveStartKey !== undefined)
    return shares
  }

  /** Public share を revoke します。 */
  async revokePublicShare(
    input: DocumentPublicShareRequest,
  ): Promise<StoredDocumentPublicShare> {
    await this.ensureTable()
    if (input.shareId === undefined) {
      throw new DocumentError(400, 'DocumentShareIdRequired', 'shareId is required.')
    }
    const authorization =
      await this.requireShareAuthorization(
        input.workspaceId,
        input.documentId,
        input.access,
        true,
      )
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: input.workspaceId,
        recordKey: shareKey(input.documentId, input.shareId),
      },
      ConsistentRead: true,
    }))
    const stored = result.Item === undefined
      ? undefined
      : readStoredDocumentShareItem(
          result.Item,
          input.workspaceId,
          input.documentId,
          input.shareId,
        )
    if (stored === undefined) throw new DocumentError(404, 'DocumentShareNotFound', 'Public share was not found.')
    if (stored.revokedAt !== undefined) return stripShareStorageFields(stored)
    const next: StoredDocumentShareItem = {
      ...stored,
      revokedAt: this.now().toISOString(),
    }
    try {
      const actions: NonNullable<
        TransactWriteCommandInput['TransactItems']
      > = [
          {
            Put: {
              TableName: this.tableName,
              Item: next,
              ConditionExpression: 'attribute_not_exists(revokedAt)',
            },
          },
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                workspaceId: publicPartitionKey(stored.tokenHash),
                recordKey: 'LINK',
              },
            },
          },
          ...documentAuthorizationConditionChecks(
            this.tableName,
            input.workspaceId,
            authorization,
          ),
          ...(input.access.authorizationSnapshots === undefined
            ? []
            : authorizationSnapshotGuards(
                input.workspaceId,
                input.access.authorizationSnapshots,
              ).map((guard) =>
                  authorizationGuardConditionCheck(
                    guard,
                  ),
              )),
        ]
      assertTransactionSize(actions)
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: actions,
        }),
      )
    } catch (error) {
      if (isConditionalFailure(error)) {
        if (
          input.access.authorizationSnapshots !==
          undefined
        ) {
          await this.verifyAuthorizationGuard(
            input.workspaceId,
            input.access,
          )
        }
        await this.requireShareAuthorization(
          input.workspaceId,
          input.documentId,
          input.access,
          true,
        )
        const latest = await this.client.send(new GetCommand({
          TableName: this.tableName,
          Key: {
            workspaceId: input.workspaceId,
            recordKey: stored.recordKey,
          },
          ConsistentRead: true,
        }))
        const latestStored = latest.Item === undefined
          ? undefined
          : readStoredDocumentShareItem(
              latest.Item,
              input.workspaceId,
              input.documentId,
              input.shareId,
            )
        if (latestStored?.revokedAt !== undefined) {
          return stripShareStorageFields(
            latestStored,
          )
        }
        throw new DocumentError(
          409,
          'DocumentShareAuthorizationConflict',
          'Document authorization changed while revoking the public share.',
        )
      }
      throw normalizeDynamoError(error)
    }
    return stripShareStorageFields(next)
  }

  /** Raw public token を有効な Document snapshot へ解決します。 */
  async resolvePublicShare(token: string): Promise<ResolvedDocumentPublicShare> {
    await this.ensureTable()
    if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
      throw publicShareNotFound()
    }
    const tokenHash = sha256(token)
    const lookupResult = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: publicPartitionKey(tokenHash),
        recordKey: 'LINK',
      },
      ConsistentRead: true,
    }))
    const lookup = lookupResult.Item === undefined
      ? undefined
      : readStoredPublicLinkItem(
          lookupResult.Item,
          tokenHash,
          publicShareNotFound,
        )
    if (lookup === undefined || isExpired(lookup.expiresAt, this.now())) throw publicShareNotFound()
    const shareResult = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: lookup.targetWorkspaceId,
        recordKey: shareKey(lookup.documentId, lookup.shareId),
      },
      ConsistentRead: true,
    }))
    const storedShare = shareResult.Item === undefined
      ? undefined
      : readStoredDocumentShareItem(
          shareResult.Item,
          lookup.targetWorkspaceId,
          lookup.documentId,
          lookup.shareId,
          publicShareNotFound,
        )
    if (
      storedShare === undefined ||
      storedShare.tokenHash !== tokenHash ||
      storedShare.revokedAt !== undefined ||
      isExpired(storedShare.expiresAt, this.now())
    ) {
      throw publicShareNotFound()
    }
    const row = await this.getDocumentRow(lookup.targetWorkspaceId, lookup.documentId)
    if (
      row === undefined ||
      row.document.archivedAt !== undefined
    ) {
      throw publicShareNotFound()
    }
    const ancestorRows =
      await this.loadAncestorRows(
        lookup.targetWorkspaceId,
        row.document,
      )
    if (
      ancestorRows.some(
        ({ document }) =>
          document.archivedAt !== undefined,
      )
    ) {
      throw publicShareNotFound()
    }
    const currentShareEpochs =
      documentShareEpochLineage({
        documentRow: row,
        ancestorRows,
      })
    if (
      stableStringify(
        lookup.documentShareEpochs,
      ) !==
        stableStringify(currentShareEpochs) ||
      stableStringify(
        storedShare.documentShareEpochs,
      ) !==
        stableStringify(currentShareEpochs)
    ) {
      throw publicShareNotFound()
    }
    const document = structuredClone(row.document)
    document.permission = { mode: 'inherit', memberGrants: [] }
    document.favorite = false
    delete document.lastOpenedAt
    document.capabilities = {
      ...EMPTY_DOCUMENT_CAPABILITIES,
      canView: true,
      canExport: storedShare.allowExport,
    }
    return {
      workspaceId: lookup.targetWorkspaceId,
      document,
      share: stripShareStorageFields(storedShare),
    }
  }

  /** Domain target から permission-filtered backlinks を返します。 */
  async listBacklinks(
    input: ListDocumentBacklinksRequest,
  ): Promise<DocumentBacklinksResponse> {
    await this.ensureTable()
    assertIdentifier(input.targetId, 'targetId')
    const limit = boundedLimit(
      input.limit,
      20,
      DOCUMENT_BACKLINK_MAX_PAGE_LIMIT,
    )
    const cursor = input.cursor === undefined
      ? undefined
      : decodeBacklinkCursor(
          input.cursor,
          input.workspaceId,
          input.targetKind,
          input.targetId,
        )
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
      ExpressionAttributeValues: {
        ':workspaceId': input.workspaceId,
        ':prefix': backlinkPrefix(input.targetKind, input.targetId),
      },
      ExclusiveStartKey: cursor === undefined
        ? undefined
        : {
            workspaceId: input.workspaceId,
            recordKey: cursor.recordKey,
          },
      Limit: limit,
      ConsistentRead: true,
    }))
    const projected = await mapWithConcurrency(
      result.Items ?? [],
      8,
      async (raw): Promise<DocumentBacklink | undefined> => {
      const item = raw as StoredDocumentBacklinkItem
      const row = await this.getDocumentRow(input.workspaceId, item.documentId)
        if (
          row === undefined ||
          row.document.archivedAt !== undefined
        ) {
          return undefined
        }
        const ancestors = await this.loadAncestors(
          input.workspaceId,
          row.document,
        )
        if (
          ancestors.some(
            (ancestor) =>
              ancestor.archivedAt !== undefined,
          ) ||
          !this.resolveStoredDocumentCapabilities(
            row.document,
            input.access,
            ancestors,
          ).canView
        ) {
          return undefined
        }
        return {
          documentId: row.document.id,
          documentTitle: row.document.title,
          relation: item.relation,
        }
      },
    )
    const lastKey = result.LastEvaluatedKey?.recordKey
    return {
      backlinks: projected.filter(
        (backlink): backlink is DocumentBacklink =>
          backlink !== undefined,
      ),
      nextCursor: typeof lastKey === 'string'
        ? encodeCursor({
            version: 1,
            kind: 'document-backlinks',
            workspaceId: input.workspaceId,
            targetKind: input.targetKind,
            targetId: input.targetId,
            recordKey: lastKey,
          } satisfies DocumentBacklinkCursor)
        : undefined,
    }
  }

  /** Document を安全な text format へ export します。 */
  async exportDocument(input: ExportDocumentRequest): Promise<RenderedDocumentExport> {
    await this.ensureTable()
    const row = await this.getRequiredDocumentRow(
      input.workspaceId,
      input.documentId,
    )
    const projectionContext: DocumentProjectionContext = {
      documentRows: new Map([
        [row.documentId, Promise.resolve(row)],
      ]),
      preferences: new Map(),
    }
    const ancestors = await this.loadAncestors(
      input.workspaceId,
      row.document,
      projectionContext,
    )
    if (
      ancestors.some(
        (ancestor) =>
          ancestor.archivedAt !== undefined,
      )
    ) {
      throw documentNotFound()
    }
    const projected = await this.projectDocument(
      input.workspaceId,
      row.document,
      input.access,
      projectionContext,
      ancestors,
    )
    requireCapability(
      projected.capabilities.canExport,
      'DocumentExportDenied',
    )
    validateDocumentPayload(row.document)
    return renderDocumentProjectionExport(projected, input.format)
  }

  private async ensureTable(): Promise<void> {
    if (!this.autoCreateLocal || this.dynamoClient === undefined) return
    this.ensureTablePromise ??= this.ensureLocalTable()
    return this.ensureTablePromise
  }

  private async ensureLocalTable(): Promise<void> {
    if (this.dynamoClient === undefined) return
    try {
      await this.dynamoClient.send(new DescribeTableCommand({ TableName: this.tableName }))
      return
    } catch (error) {
      if (!isResourceNotFound(error)) throw error
    }
    try {
      await this.dynamoClient.send(new CreateTableCommand({
        TableName: this.tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'workspaceId', AttributeType: 'S' },
          { AttributeName: 'recordKey', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'workspaceId', KeyType: 'HASH' },
          { AttributeName: 'recordKey', KeyType: 'RANGE' },
        ],
      }))
    } catch (error) {
      if (!isResourceInUse(error)) throw error
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await this.dynamoClient.send(
        new DescribeTableCommand({ TableName: this.tableName }),
      )
      if ((result.Table as TableDescription | undefined)?.TableStatus === 'ACTIVE') return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new DocumentError(503, 'DocumentsTableUnavailable', 'The local DocumentsTable did not become active.')
  }

  private async getDocumentRow(
    workspaceId: string,
    documentId: string,
  ): Promise<StoredDocumentItem | undefined> {
    assertIdentifier(workspaceId, 'workspaceId')
    assertIdentifier(documentId, 'documentId')
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: documentKey(documentId) },
      ConsistentRead: true,
    }))
    return result.Item as StoredDocumentItem | undefined
  }

  private async getDocumentSearchAccessRow(
    workspaceId: string,
    documentId: string,
    context?: DocumentSearchAccessReadContext,
  ): Promise<
    StoredDocumentSearchAccessItem | undefined
  > {
    const cacheKey =
      `${workspaceId}\0${documentId}`
    let contextRows = context === undefined
      ? undefined
      : this.searchAccessRowsByContext.get(context)
    if (
      context !== undefined &&
      contextRows === undefined
    ) {
      contextRows = new Map()
      this.searchAccessRowsByContext.set(
        context,
        contextRows,
      )
    }
    let read = contextRows?.get(cacheKey)
    if (read === undefined) {
      read = this.client.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId,
          recordKey:
            documentSearchAccessKey(
              documentId,
            ),
        },
        ConsistentRead: true,
      })).then((result) => result.Item)
      contextRows?.set(cacheKey, read)
    }
    return readDocumentSearchAccessItem(
      await read,
      workspaceId,
      documentId,
    )
  }

  private async getDocumentSearchBodyRow(
    workspaceId: string,
    documentId: string,
  ): Promise<
    StoredDocumentSearchBodyItem | undefined
  > {
    const result =
      await this.client.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId,
          recordKey:
            documentSearchBodyKey(
              documentId,
            ),
        },
        ConsistentRead: true,
      }))
    return readDocumentSearchBodyItem(
      result.Item,
      workspaceId,
      documentId,
    )
  }

  private async getCachedDocumentRow(
    workspaceId: string,
    documentId: string,
    context?: DocumentProjectionContext,
  ): Promise<StoredDocumentItem | undefined> {
    const cached =
      context?.documentRows.get(documentId)
    if (cached !== undefined) return cached
    const read = this.getDocumentRow(
      workspaceId,
      documentId,
    )
    context?.documentRows.set(documentId, read)
    return read
  }

  private async getRequiredDocumentRow(
    workspaceId: string,
    documentId: string,
  ): Promise<StoredDocumentItem> {
    const row = await this.getDocumentRow(workspaceId, documentId)
    if (row === undefined) throw documentNotFound()
    return row
  }

  /** Capability 判定に使う current Document と ancestor rows を一度だけ読み込みます。 */
  private async loadDocumentAuthorizationSnapshot(
    workspaceId: string,
    documentId: string,
  ): Promise<DocumentAuthorizationSnapshot> {
    const documentRow =
      await this.getRequiredDocumentRow(
        workspaceId,
        documentId,
      )
    const ancestorRows =
      await this.loadAncestorRows(
        workspaceId,
        documentRow.document,
      )
    return {
      documentRow,
      ancestorRows,
    }
  }

  /** Capability 判定結果と、その判定に使った lineage snapshot を返します。 */
  private async requireDocumentCapabilityAuthorization(
    workspaceId: string,
    documentId: string,
    access: DocumentAccessContext,
    capability: keyof DocumentCapabilities,
    errorCode: string,
    includeArchivedDocument = false,
    rejectArchivedAncestors = true,
  ): Promise<DocumentAuthorizationSnapshot> {
    const authorization =
      await this.loadDocumentAuthorizationSnapshot(
        workspaceId,
        documentId,
      )
    if (
      !includeArchivedDocument &&
      authorization.documentRow.document
        .archivedAt !== undefined
    ) {
      throw documentNotFound()
    }
    if (
      rejectArchivedAncestors &&
      authorization.ancestorRows.some(
        ({ document }) =>
          document.archivedAt !== undefined,
      )
    ) {
      throw documentNotFound()
    }
    const capabilities =
      this.resolveDocumentAuthorizationCapabilities(
        authorization,
        access,
      )
    requireCapability(
      capabilities[capability],
      errorCode,
    )
    return authorization
  }

  /** Lineage snapshot から Document capabilities を解決します。 */
  private resolveDocumentAuthorizationCapabilities(
    authorization: DocumentAuthorizationSnapshot,
    access: DocumentAccessContext,
  ): DocumentCapabilities {
    return this.resolveStoredDocumentCapabilities(
      authorization.documentRow.document,
      access,
      authorization.ancestorRows.map(
        ({ document }) => document,
      ),
    )
  }

  private async requireMutableDocument(
    workspaceId: string,
    documentId: string,
    access: DocumentAccessContext,
    capability: 'edit' | 'archive',
    includeArchived = false,
  ): Promise<DocumentAuthorizationSnapshot> {
    return this.requireDocumentCapabilityAuthorization(
      workspaceId,
      documentId,
      access,
      capability === 'edit'
        ? 'canEdit'
        : 'canArchive',
      'DocumentEditDenied',
      includeArchived,
    )
  }

  private async requireShareAuthorization(
    workspaceId: string,
    documentId: string,
    access: DocumentAccessContext,
    allowArchived: boolean,
  ): Promise<DocumentAuthorizationSnapshot> {
    const documentRow =
      await this.getRequiredDocumentRow(
        workspaceId,
        documentId,
      )
    const ancestorRows =
      await this.loadAncestorRows(
        workspaceId,
        documentRow.document,
      )
    const hasArchivedDocument =
      documentRow.document.archivedAt !== undefined ||
      ancestorRows.some(
        ({ document }) =>
          document.archivedAt !== undefined,
      )
    if (hasArchivedDocument && !allowArchived) {
      throw documentNotFound()
    }
    const documentSubject =
      archivedNeutralAccessSubject(
        documentRow.document,
        allowArchived,
      )
    const ancestorSubjects =
      ancestorRows.map(({ document }) =>
        archivedNeutralAccessSubject(
          document,
          allowArchived,
        )
      )
    const capabilities =
      this.resolveStoredDocumentCapabilities(
        documentSubject,
        access,
        ancestorSubjects,
      )
    requireCapability(
      capabilities.canShare,
      'DocumentShareDenied',
    )
    return {
      documentRow,
      ancestorRows,
    }
  }

  private async verifyAuthorizationGuard(
    workspaceId: string,
    access: DocumentAccessContext,
  ): Promise<void> {
    const guards =
      requireAuthorizationGuards(workspaceId, access)
    if (
      !await this.authorizationGuardsMatch(
        guards,
      )
    ) {
      throw new DocumentError(
        409,
        'DocumentAuthorizationChanged',
        'Authorization changed while creating the public share; authenticate again and retry.',
      )
    }
  }

  private async authorizationGuardsMatch(
    input:
      | readonly DynamoDbDocumentAuthorizationGuard[]
      | undefined,
  ): Promise<boolean> {
    const guards = (input ?? []).map(
      validateAuthorizationGuard,
    )
    if (guards.length === 0) return true
    const results = await Promise.all(
      guards.map((guard) =>
        this.client.send(
          new GetCommand({
            TableName: guard.tableName,
            Key: { ...guard.key },
            ConsistentRead: true,
          }),
        )
      ),
    )
    return results.every(
      (result, index) =>
        authorizationGuardMatches(
          result.Item,
          guards[index]!,
        ),
    )
  }

  private async projectDocument(
    workspaceId: string,
    canonical: DocumentDetail,
    access: DocumentAccessContext,
    context?: DocumentProjectionContext,
    knownAncestors?: readonly DocumentDetail[],
  ): Promise<DocumentDetail> {
    const document = structuredClone(canonical)
    const ancestors =
      knownAncestors ??
      await this.loadAncestors(
        workspaceId,
        canonical,
        context,
      )
    document.capabilities = this.resolveStoredDocumentCapabilities(
      canonical,
      access,
      ancestors,
    )
    const archived = Boolean(document.archivedAt) ||
      ancestors.some((ancestor) => ancestor.archivedAt !== undefined)
    if (archived) {
      document.capabilities = {
        ...document.capabilities,
        canEdit: false,
        canComment: false,
        canShare: false,
        canManagePermissions: false,
        canArchive: false,
        canRestore: Boolean(document.archivedAt) && document.capabilities.canRestore,
      }
    }
    const canReadMemberGrants =
      document.capabilities.canManagePermissions ||
      document.capabilities.canRestore
    if (!canReadMemberGrants) {
      document.permission = {
        ...document.permission,
        memberGrants: [],
      }
    }
    const preference = await this.getPreference(
      workspaceId,
      access.memberKey,
      document.id,
      context,
    )
    document.favorite = preference?.favorite ?? false
    if (preference?.lastOpenedAt === undefined) delete document.lastOpenedAt
    else document.lastOpenedAt = preference.lastOpenedAt
    if (document.kind === 'folder') {
      document.childCount = await this.countVisibleChildren(
        workspaceId,
        document.id,
        access,
        [canonical, ...ancestors],
      )
    }
    return document
  }

  /** Canonical ACL と既読済み ancestor から capabilities を解決します。 */
  private resolveStoredDocumentCapabilities(
    document: DocumentAccessSubject,
    access: DocumentAccessContext,
    ancestors: readonly DocumentAccessSubject[],
  ): DocumentCapabilities {
    return resolveDocumentCapabilities({
      principal: {
        memberKey: access.memberKey,
        workspaceRole: access.workspaceRole,
        isSystemAdmin: access.isSystemAdmin ?? false,
      },
      document,
      ancestors,
      projectRole: document.scope.type === 'project'
        ? access.projectRoles?.[document.scope.projectId] ?? access.projectRole
        : undefined,
      restrictToAuthorizedScopes:
        access.restrictToAuthorizedScopes,
      workspaceScopeRole:
        access.workspaceScopeRole,
    })
  }

  /** 現在 viewer が直接参照できる active child 数を返します。 */
  private async countVisibleChildren(
    workspaceId: string,
    parentId: string,
    access: DocumentAccessContext,
    ancestors: readonly DocumentAccessSubject[],
  ): Promise<number> {
    if (
      ancestors.some(
        (ancestor) => ancestor.archivedAt !== undefined,
      )
    ) {
      return 0
    }
    let count = 0
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': documentChildPrefix(parentId),
        },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }))
      for (const raw of result.Items ?? []) {
        const child = raw as StoredDocumentChildIndexItem
        if (
          child.archivedAt === undefined &&
          this.resolveStoredDocumentCapabilities(
            child,
            access,
            ancestors,
          ).canView
        ) {
          count += 1
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey
    } while (exclusiveStartKey !== undefined)
    return count
  }

  private async loadAncestors(
    workspaceId: string,
    document: DocumentDetail,
    context?: DocumentProjectionContext,
  ): Promise<DocumentDetail[]> {
    const ancestors: DocumentDetail[] = []
    const seen = new Set([document.id])
    let parentId = document.parentId
    while (parentId !== undefined) {
      if (seen.has(parentId) || ancestors.length >= DOCUMENT_MAX_TREE_DEPTH) {
        throw new DocumentError(409, 'InvalidDocumentTree', 'The stored document tree contains a cycle or is too deep.')
      }
      seen.add(parentId)
      const parent =
        await this.getCachedDocumentRow(
          workspaceId,
          parentId,
          context,
        )
      if (parent === undefined) break
      ancestors.push(parent.document)
      parentId = parent.document.parentId
    }
    return ancestors
  }

  private async loadAncestorRows(
    workspaceId: string,
    document: DocumentDetail,
  ): Promise<StoredDocumentItem[]> {
    const ancestors: StoredDocumentItem[] = []
    const seen = new Set([document.id])
    let parentId = document.parentId
    while (parentId !== undefined) {
      if (
        seen.has(parentId) ||
        ancestors.length >=
          DOCUMENT_MAX_TREE_DEPTH
      ) {
        throw new DocumentError(
          409,
          'InvalidDocumentTree',
          'The stored document tree contains a cycle or is too deep.',
        )
      }
      seen.add(parentId)
      const parent =
        await this.getDocumentRow(
          workspaceId,
          parentId,
        )
      if (parent === undefined) break
      ancestors.push(parent)
      parentId = parent.document.parentId
    }
    return ancestors
  }

  private async hasArchivedAncestor(
    workspaceId: string,
    document: DocumentDetail,
  ): Promise<boolean> {
    return (await this.loadAncestors(workspaceId, document)).some(
      (ancestor) => ancestor.archivedAt !== undefined,
    )
  }

  private async validateParent(
    workspaceId: string,
    parentId: string,
    scope: DocumentScope,
    access: DocumentAccessContext,
    movingDocumentId?: string,
    requireManage = false,
    requireAccess = true,
  ): Promise<DocumentAuthorizationSnapshot> {
    assertIdentifier(parentId, 'parentId')
    if (parentId === movingDocumentId) {
      throw new DocumentError(409, 'DocumentTreeCycle', 'A document cannot be its own parent.')
    }
    const parent = await this.getDocumentRow(workspaceId, parentId)
    if (
      parent === undefined ||
      parent.document.kind !== 'folder' ||
      parent.document.archivedAt !== undefined
    ) {
      throw new DocumentError(400, 'InvalidDocumentParent', 'The parent must be an active folder.')
    }
    if (!scopesEqual(parent.document.scope, scope)) {
      throw new DocumentError(400, 'DocumentParentScopeMismatch', 'Parent and child scopes must match.')
    }
    const seen = new Set<string>(movingDocumentId === undefined ? [] : [movingDocumentId])
    const ancestorRows: StoredDocumentItem[] = []
    let current: StoredDocumentItem | undefined = parent
    for (let depth = 0; current !== undefined; depth += 1) {
      if (depth >= DOCUMENT_MAX_TREE_DEPTH || seen.has(current.documentId)) {
        throw new DocumentError(409, 'DocumentTreeCycle', 'The requested parent would create a cycle.')
      }
      seen.add(current.documentId)
      const nextParent: StoredDocumentItem | undefined =
        current.document.parentId === undefined
          ? undefined
          : await this.getDocumentRow(
              workspaceId,
              current.document.parentId,
            )
      if (nextParent !== undefined) {
        ancestorRows.push(nextParent)
      }
      current = nextParent
    }
    const authorization = {
      documentRow: parent,
      ancestorRows,
    }
    if (requireAccess) {
      const capabilities =
        this.resolveDocumentAuthorizationCapabilities(
          authorization,
          access,
        )
      requireCapability(
        requireManage
          ? capabilities.canManagePermissions
          : capabilities.canEdit,
        requireManage
          ? 'DocumentParentManageDenied'
          : 'DocumentParentEditDenied',
      )
    }
    return authorization
  }

  private async hasDirectChildren(
    workspaceId: string,
    parentId: string,
  ): Promise<boolean> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression:
        'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
      ExpressionAttributeValues: {
        ':workspaceId': workspaceId,
        ':prefix': documentChildPrefix(parentId),
      },
      Limit: 1,
      ConsistentRead: true,
    }))
    return (result.Items?.length ?? 0) > 0
  }

  private async getPreference(
    workspaceId: string,
    memberKey: string,
    documentId: string,
    context?: DocumentProjectionContext,
  ): Promise<StoredDocumentPreferenceItem | undefined> {
    const cacheKey = `${memberKey}\0${documentId}`
    const cached = context?.preferences.get(cacheKey)
    if (cached !== undefined) return cached
    const read = this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId,
        recordKey: preferenceKey(
          memberKey,
          documentId,
        ),
      },
      ConsistentRead: true,
    })).then(
      (result) =>
        result.Item as
          | StoredDocumentPreferenceItem
          | undefined,
    )
    context?.preferences.set(cacheKey, read)
    return read
  }

  private async readOperationReceipts(
    input: ApplyDocumentOperationsRequest,
  ): Promise<{
    pending: DocumentOperation[]
    accepted: StoredOperationReceipt[]
  }> {
    const pending: DocumentOperation[] = []
    const accepted: StoredOperationReceipt[] = []
    for (const operation of input.input.operations) {
      const operationFingerprint =
        fingerprint(operation)
      const receipt = await this.getOperationReceipt(
        input.workspaceId,
        input.documentId,
        operation.operationId,
      )
      if (receipt === undefined) {
        pending.push(operation)
        continue
      }
      if (
        receipt.fingerprint !==
          operationFingerprint ||
        receipt.clientId !== input.input.clientId
      ) {
        throw new DocumentError(
          409,
          'DocumentOperationIdempotencyConflict',
          `operationId "${operation.operationId}" was already used with different input.`,
        )
      }
      accepted.push(receipt)
    }
    return { pending, accepted }
  }

  private async getOperationReceipt(
    workspaceId: string,
    documentId: string,
    operationId: string,
  ): Promise<StoredOperationReceipt | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId,
        recordKey: operationKey(documentId, operationId),
      },
      ConsistentRead: true,
    }))
    const receipt = result.Item === undefined
      ? undefined
      : readStoredOperationReceipt(
          result.Item,
          workspaceId,
          documentId,
          operationId,
        )
    if (
      receipt !== undefined &&
      receipt.expiresAtEpoch !== undefined &&
      receipt.expiresAtEpoch <=
        Math.floor(this.now().getTime() / 1_000)
    ) {
      return undefined
    }
    return receipt
  }

  private async getDocumentTreeRevision(
    workspaceId: string,
  ): Promise<number> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId,
        recordKey: documentTreeRevisionKey(),
      },
      ConsistentRead: true,
    }))
    const item = result.Item as
      | StoredDocumentTreeRevisionItem
      | undefined
    return item?.revision ?? 0
  }

  private async createTreeMutationGuard(
    workspaceId: string,
  ): Promise<DocumentTreeMutationGuard> {
    return {
      expectedRevision:
        await this.getDocumentTreeRevision(workspaceId),
      updatedAt: this.now().toISOString(),
    }
  }

  private async createAuthorizationMutationGuard(
    workspaceId: string,
    expectedRevision?: number,
  ): Promise<DocumentAuthorizationRevisionGuard> {
    const revision =
      expectedRevision ??
      await this.getAuthorizationRevision(workspaceId)
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0
    ) {
      throw new DocumentError(
        400,
        'InvalidDocumentAuthorizationRevision',
        'Document authorization revision must be a non-negative safe integer.',
      )
    }
    return {
      expectedRevision: revision,
      updatedAt: this.now().toISOString(),
    }
  }

  private async findVersion(
    workspaceId: string,
    documentId: string,
    versionId: string,
  ): Promise<StoredDocumentVersionSnapshotItem> {
    const nowEpoch = Math.floor(
      this.now().getTime() / 1_000,
    )
    const numericRevision = parseVersionRevision(
      documentId,
      versionId,
    )
    let metadata:
      | StoredDocumentVersionItem
      | undefined
    if (numericRevision !== undefined) {
      const metadataResult =
        await this.client.send(new GetCommand({
          TableName: this.tableName,
          Key: {
            workspaceId,
            recordKey: versionKey(
              documentId,
              numericRevision,
            ),
          },
          ConsistentRead: true,
        }))
      metadata =
        metadataResult.Item as
          | StoredDocumentVersionItem
          | undefined
      if (
        metadata !== undefined &&
        metadata.expiresAtEpoch !== undefined &&
        metadata.expiresAtEpoch <= nowEpoch
      ) {
        metadata = undefined
      }
    }
    if (metadata === undefined) {
      let exclusiveStartKey:
        | Record<string, unknown>
        | undefined
      do {
        const result = await this.client.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
          ExpressionAttributeValues: {
            ':workspaceId': workspaceId,
            ':prefix': `VERSION#${documentId}#`,
          },
          ConsistentRead: true,
          ExclusiveStartKey: exclusiveStartKey,
        }))
        metadata = (result.Items ?? [])
          .map(
            (item) =>
              item as StoredDocumentVersionItem,
          )
          .find(
            (item) =>
              item.version.id === versionId &&
              (
                item.expiresAtEpoch === undefined ||
                item.expiresAtEpoch > nowEpoch
              ),
          )
        exclusiveStartKey =
          result.LastEvaluatedKey
      } while (
        metadata === undefined &&
        exclusiveStartKey !== undefined
      )
    }
    if (metadata === undefined) {
      throw new DocumentError(404, 'DocumentVersionNotFound', 'Document version was not found.')
    }
    const targetRevision = metadata.version.revision
    const exactSnapshotResult =
      await this.client.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId,
          recordKey: versionSnapshotKey(
            documentId,
            targetRevision,
          ),
        },
        ConsistentRead: true,
      }))
    const exactSnapshot =
      exactSnapshotResult.Item as
        | StoredDocumentVersionSnapshotItem
        | undefined
    if (
      exactSnapshot !== undefined &&
      (
        exactSnapshot.expiresAtEpoch === undefined ||
        exactSnapshot.expiresAtEpoch > nowEpoch
      )
    ) {
      return combineVersionSnapshot(
        metadata,
        exactSnapshot,
      )
    }
    const snapshotPrefix =
      `VERSION_SNAPSHOT#${encodeKeyPart(documentId)}#`
    const snapshotResult = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression:
        'workspaceId = :workspaceId AND recordKey BETWEEN :startKey AND :endKey',
      ExpressionAttributeValues: {
        ':workspaceId': workspaceId,
        ':startKey': snapshotPrefix,
        ':endKey': versionSnapshotKey(
          documentId,
          targetRevision,
        ),
      },
      ScanIndexForward: false,
      Limit: 1,
      ConsistentRead: true,
    }))
    const baseSnapshot =
      snapshotResult.Items?.[0] as
        | StoredDocumentVersionSnapshotItem
        | undefined
    if (
      baseSnapshot === undefined ||
      (
        baseSnapshot.expiresAtEpoch !== undefined &&
        baseSnapshot.expiresAtEpoch <= nowEpoch
      )
    ) {
      throw new DocumentError(404, 'DocumentVersionNotFound', 'Document version was not found.')
    }
    if (baseSnapshot.version.revision === targetRevision) {
      return combineVersionSnapshot(
        metadata,
        baseSnapshot,
      )
    }
    const deltas:
      StoredDocumentVersionDeltaItem[] =
        []
    let exclusiveStartKey:
      | Record<string, unknown>
      | undefined
    do {
      const deltaResult =
        await this.client.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            'workspaceId = :workspaceId AND recordKey BETWEEN :startKey AND :endKey',
          ExpressionAttributeValues: {
            ':workspaceId': workspaceId,
            ':startKey': versionDeltaKey(
              documentId,
              baseSnapshot.version.revision +
                1,
            ),
            ':endKey': versionDeltaKey(
              documentId,
              targetRevision,
            ),
          },
          ExclusiveStartKey:
            exclusiveStartKey,
          ScanIndexForward: true,
          ConsistentRead: true,
        }))
      deltas.push(
        ...(deltaResult.Items ?? []).map(
          (item) =>
            item as StoredDocumentVersionDeltaItem,
        ),
      )
      exclusiveStartKey =
        deltaResult.LastEvaluatedKey
    } while (exclusiveStartKey !== undefined)
    let reconstructed = structuredClone(
      baseSnapshot,
    )
    const retainedDeltas = deltas
      .filter(
        (item) =>
          item.expiresAtEpoch === undefined ||
          item.expiresAtEpoch > nowEpoch,
      )
      .sort(
        (left, right) =>
          left.version.revision -
          right.version.revision,
      )
    for (
      let revision =
        baseSnapshot.version.revision + 1;
      revision <= targetRevision;
      revision += 1
    ) {
      const delta = retainedDeltas.find(
        (candidate) =>
          candidate.version.revision === revision,
      )
      if (delta === undefined) {
        throw new DocumentError(
          404,
          'DocumentVersionNotFound',
          'Document version retention data is incomplete.',
        )
      }
      reconstructed =
        applyStoredVersionDelta(
          reconstructed,
          delta,
        )
    }
    return {
      ...reconstructed,
      recordKey: versionSnapshotKey(
        documentId,
        targetRevision,
      ),
      version: metadata.version,
      expiresAtEpoch: metadata.expiresAtEpoch,
    }
  }

  private async findStoredComment(
    workspaceId: string,
    documentId: string,
    commentId: string,
  ): Promise<StoredDocumentCommentItem> {
    const receiptResult = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId,
        recordKey: commentReceiptKey(documentId, commentId),
      },
      ConsistentRead: true,
    }))
    const receipt = receiptResult.Item as
      | StoredDocumentCommentReceiptItem
      | undefined
    if (receipt === undefined) {
      throw new DocumentError(404, 'DocumentCommentNotFound', 'Document comment was not found.')
    }
    return this.getStoredCommentByRecordKey(
      workspaceId,
      receipt.commentRecordKey,
    )
  }

  private async getStoredCommentByRecordKey(
    workspaceId: string,
    recordKey: string,
  ): Promise<StoredDocumentCommentItem> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey },
      ConsistentRead: true,
    }))
    if (result.Item === undefined) {
      throw new DocumentError(
        404,
        'DocumentCommentNotFound',
        'Document comment was not found.',
      )
    }
    return result.Item as StoredDocumentCommentItem
  }

  private async findComment(
    workspaceId: string,
    documentId: string,
    commentId: string,
  ): Promise<StoredDocumentComment> {
    return stripCommentStorageFields(
      await this.findStoredComment(workspaceId, documentId, commentId),
    )
  }

  private async getWorkItemBacklinkTargetFence(
    workspaceId: string,
    workItemId: string,
  ): Promise<
    StoredDocumentBacklinkTargetFenceItem | undefined
  > {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId,
          recordKey:
            workItemBacklinkTargetFenceKey(
              workItemId,
            ),
        },
        ConsistentRead: true,
      }),
    )
    return readWorkItemBacklinkTargetFenceItem(
      result.Item,
      workspaceId,
      workItemId,
    )
  }

  /**
   * Fence 導入前の backlink rows を consistent query で全 page 集計します。
   *
   * Fence row が存在しないだけで count 0 とみなさず、同じ fence key の
   * conditional Put と組み合わせて既存データを fail-closed に移行します。
   */
  private async countStoredWorkItemBacklinks(
    workspaceId: string,
    workItemId: string,
  ): Promise<number> {
    let count = 0
    let exclusiveStartKey:
      | Record<string, unknown>
      | undefined
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
          ExpressionAttributeValues: {
            ':workspaceId': workspaceId,
            ':prefix': backlinkPrefix(
              'work-item',
              workItemId,
            ),
          },
          ExclusiveStartKey: exclusiveStartKey,
          ConsistentRead: true,
        }),
      )
      for (const item of result.Items ?? []) {
        readStoredWorkItemBacklinkItem(
          item,
          workspaceId,
          workItemId,
        )
        count += 1
        if (!Number.isSafeInteger(count)) {
          throw invalidDocumentBacklinkTargetFence()
        }
      }
      exclusiveStartKey =
        result.LastEvaluatedKey
    } while (exclusiveStartKey !== undefined)
    return count
  }

  private async prepareBacklinkMutationActions(
    workspaceId: string,
    documentId: string,
    diff: DocumentRelationDiff,
  ): Promise<
    NonNullable<
      TransactWriteCommandInput['TransactItems']
    >
  > {
    const fenceActions =
      await mapWithConcurrency(
        coalesceWorkItemBacklinkTargetDeltas(
          diff,
        ),
        8,
        ({ targetId, delta }) =>
          this.prepareWorkItemBacklinkTargetDeltaAction(
            workspaceId,
            targetId,
            delta,
          ),
      )
    return [
      ...backlinkDiffActions(
        this.tableName,
        workspaceId,
        documentId,
        diff,
      ),
      ...fenceActions,
    ]
  }

  private async prepareWorkItemBacklinkTargetDeltaAction(
    workspaceId: string,
    workItemId: string,
    delta: number,
  ): Promise<
    NonNullable<
      TransactWriteCommandInput['TransactItems']
    >[number]
  > {
    const existing =
      await this.getWorkItemBacklinkTargetFence(
        workspaceId,
        workItemId,
      )
    if (existing === undefined) {
      const legacyBacklinkCount =
        await this.countStoredWorkItemBacklinks(
          workspaceId,
          workItemId,
        )
      const nextCount =
        legacyBacklinkCount + delta
      if (
        !Number.isSafeInteger(nextCount) ||
        nextCount < 0
      ) {
        throw invalidDocumentBacklinkTargetFence()
      }
      return {
        Put: {
          TableName: this.tableName,
          Item: createWorkItemBacklinkTargetFenceItem(
            workspaceId,
            workItemId,
            nextCount,
            1,
          ),
          ConditionExpression:
            'attribute_not_exists(workspaceId)',
        },
      }
    }
    if (
      delta > 0 &&
      existing.deletedAt !== undefined
    ) {
      throw documentRelationTargetDeleted()
    }
    const nextCount =
      existing.activeBacklinkCount + delta
    if (
      !Number.isSafeInteger(nextCount) ||
      nextCount < 0
    ) {
      throw invalidDocumentBacklinkTargetFence()
    }
    return {
      Put: {
        TableName: this.tableName,
        Item: createWorkItemBacklinkTargetFenceItem(
          workspaceId,
          workItemId,
          nextCount,
          existing.version + 1,
          existing.deletedAt,
        ),
        ConditionExpression:
          '#entryType = :entryType AND ' +
          'schemaVersion = :schemaVersion AND ' +
          'targetKind = :targetKind AND targetId = :targetId AND ' +
          'activeBacklinkCount = :expectedCount AND #version = :expectedVersion' +
          (delta > 0
            ? ' AND attribute_not_exists(deletedAt)'
            : ''),
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':entryType':
            'document-backlink-target-fence',
          ':schemaVersion':
            DOCUMENT_BACKLINK_TARGET_FENCE_SCHEMA_VERSION,
          ':targetKind': 'work-item',
          ':targetId': workItemId,
          ':expectedCount':
            existing.activeBacklinkCount,
          ':expectedVersion': existing.version,
        },
      },
    }
  }

  private async throwIfAddedWorkItemTargetDeleted(
    workspaceId: string,
    diff: DocumentRelationDiff,
  ): Promise<void> {
    const workItemIds = new Set<string>()
    for (const relation of diff.added) {
      if (
        relation.target.kind ===
          'work-item'
      ) {
        workItemIds.add(
          relation.target.workItemId,
        )
      }
    }
    const fences = await mapWithConcurrency(
      [...workItemIds],
      8,
      (workItemId) =>
        this.getWorkItemBacklinkTargetFence(
          workspaceId,
          workItemId,
        ),
    )
    if (
      fences.some(
        (fence) =>
          fence?.deletedAt !== undefined,
      )
    ) {
      throw documentRelationTargetDeleted()
    }
  }

  private async commitMutation(
    workspaceId: string,
    current: StoredDocumentItem,
    nextDocument: DocumentDetail,
    elementRevisions: Record<string, number>,
    reason: DocumentVersion['reason'],
    summary?: string,
    treeMutationGuard?: DocumentTreeMutationGuard,
    authorizationMutationGuard?: DocumentAuthorizationRevisionGuard,
    mutationAuthorizationGuards?: readonly DynamoDbDocumentAuthorizationGuard[],
  ): Promise<void> {
    const createsVersionSnapshot =
      reason === 'restore' ||
      shouldCreateVersionSnapshot(
        current,
        nextDocument,
      )
    const next: StoredDocumentItem = {
      ...current,
      revision: nextDocument.revision,
      document: nextDocument,
      ...compactElementRevisionHistory(
        nextDocument,
        elementRevisions,
        current.operationConflictFloorRevision ?? 1,
      ),
      ...(createsVersionSnapshot
        ? {
            lastVersionSnapshotRevision:
              nextDocument.revision,
            lastVersionSnapshotAt:
              nextDocument.updatedAt,
          }
        : {}),
    }
    const relationDiff = diffRelations(
      backlinkRelations(current.document),
      backlinkRelations(nextDocument),
    )
    const backlinkMutationActions =
      await this.prepareBacklinkMutationActions(
        workspaceId,
        current.documentId,
        relationDiff,
      )
    const actions: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      currentDocumentPut(this.tableName, next, current.revision),
      documentSearchAccessPut(
        this.tableName,
        workspaceId,
        nextDocument,
      ),
      documentSearchBodyPut(
        this.tableName,
        workspaceId,
        nextDocument,
      ),
      ...versionPutActions(
        this.tableName,
        createVersionItems(
          workspaceId,
          nextDocument,
          next.elementRevisions,
          reason,
          summary,
          {
            previousDocument: current.document,
            forceSnapshot:
              createsVersionSnapshot,
          },
        ),
      ),
      ...documentChildIndexMutationActions(
        this.tableName,
        workspaceId,
        current.document,
        nextDocument,
      ),
      ...backlinkMutationActions,
      ...(treeMutationGuard === undefined
        ? []
        : [
            documentTreeRevisionPut(
              this.tableName,
              workspaceId,
              treeMutationGuard,
            ),
          ]),
      ...(authorizationMutationGuard === undefined
        ? []
        : [
            createDocumentAuthorizationRevisionPut(
              this.tableName,
              workspaceId,
              authorizationMutationGuard,
            ),
          ]),
      ...authorizationGuardConditionChecks(
        mutationAuthorizationGuards,
      ),
    ]
    assertTransactionSize(actions)
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: actions,
      }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        if (
          !await this.authorizationGuardsMatch(
            mutationAuthorizationGuards,
          )
        ) {
          throw new DocumentError(
            409,
            'DocumentAuthorizationChanged',
            'Document authorization changed while committing the mutation.',
          )
        }
        if (
          authorizationMutationGuard !== undefined &&
          await this.getAuthorizationRevision(
            workspaceId,
          ) !==
            authorizationMutationGuard.expectedRevision
        ) {
          throw new DocumentError(
            409,
            'DocumentAuthorizationConflict',
            'Document permissions changed concurrently.',
          )
        }
        const latest =
          await this.getDocumentRow(
            workspaceId,
            current.documentId,
          )
        if (
          latest?.revision === current.revision
        ) {
          await this
            .throwIfAddedWorkItemTargetDeleted(
              workspaceId,
              relationDiff,
            )
        }
        throw new DocumentError(409, 'DocumentRevisionConflict', 'The document changed concurrently.')
      }
      throw normalizeDynamoError(error)
    }
  }
}

function normalizeDocumentManagerMemberKey(
  memberKey: string,
): string {
  assertIdentifier(memberKey, 'memberKey')
  return memberKey.trim().toLowerCase()
}

function assertIdentifier(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 500 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new DocumentError(400, 'InvalidDocumentIdentifier', `${field} is invalid.`)
  }
}

function assertText(
  value: string,
  field: string,
  maxLength: number,
  allowEmpty: boolean,
): void {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentText',
      `${field} must ${allowEmpty ? '' : 'not be empty and '}contain at most ${maxLength} characters.`,
    )
  }
}

/**
 * Checks whether a collaborator color can be stored and rendered safely.
 *
 * @param value - CSS color candidate.
 * @returns Whether the value uses an accepted safe color syntax.
 */
function isSafeCssColor(value: string): boolean {
  return (
    /^#[\da-f]{3,8}$/iu.test(value) ||
    /^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)$/iu.test(value) ||
    /^(?:transparent|black|white|red|green|blue|gray|grey|yellow|orange|purple|pink|teal|navy)$/iu.test(value)
  )
}


function assertIsoTimestamp(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new DocumentError(400, 'InvalidDocumentTimestamp', `${field} must be an ISO-8601 timestamp.`)
  }
}

function latestIsoTimestamp(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return left >= right ? left : right
}

function retentionEpoch(
  createdAt: string,
  retentionDays: number,
): number {
  return (
    Math.floor(Date.parse(createdAt) / 1_000) +
    retentionDays * SECONDS_PER_DAY
  )
}


function validateMentions(body: string, mentions: readonly DocumentMention[]): void {
  if (!Array.isArray(mentions)) throw invalidPayload('Comment mentions must be an array.')
  if (mentions.length > DOCUMENT_MENTION_MAX_COUNT) {
    throw new DocumentError(400, 'DocumentMentionLimitExceeded', 'The comment contains too many mentions.')
  }
  const ranges = [...mentions].sort((a, b) => a.offset - b.offset)
  let previousEnd = -1
  for (const mention of ranges) {
    if (!isObjectLike(mention)) throw invalidPayload('Comment mention is invalid.')
    assertIdentifier(mention.userId, 'mentions[].userId')
    if (
      !Number.isSafeInteger(mention.offset) ||
      !Number.isSafeInteger(mention.length) ||
      mention.offset < 0 ||
      mention.length <= 0 ||
      mention.offset + mention.length > body.length ||
      mention.offset < previousEnd
    ) {
      throw new DocumentError(400, 'InvalidDocumentMention', 'Mention ranges must be valid and non-overlapping.')
    }
    previousEnd = mention.offset + mention.length
  }
}

function commentSemanticFingerprint(comment: StoredDocumentComment): string {
  return fingerprint({
    id: comment.id,
    documentId: comment.documentId,
    parentCommentId: comment.parentCommentId,
    anchor: comment.anchor,
    body: comment.body,
    mentions: comment.mentions,
    authorUserId: comment.authorUserId,
  })
}

function normalizeCommentCreateRequest(
  input: CreateDocumentCommentRequest,
) {
  assertText(
    input.body,
    'body',
    DOCUMENT_COMMENT_MAX_LENGTH,
    false,
  )
  const mentions = structuredClone(input.mentions ?? [])
  validateMentions(input.body, mentions)
  const anchor: DocumentCommentAnchor = structuredClone(
    input.anchor ?? { type: 'document' },
  )
  if (input.parentCommentId !== undefined) {
    assertIdentifier(
      input.parentCommentId,
      'parentCommentId',
    )
  }
  if (input.commentId !== undefined) {
    assertIdentifier(input.commentId, 'commentId')
  }
  return {
    id: input.commentId,
    mentions,
    anchor,
    fingerprint: fingerprint({
      id: input.commentId,
      documentId: input.documentId,
      parentCommentId: input.parentCommentId,
      anchor,
      body: input.body,
      mentions,
      authorUserId: input.access.memberKey,
    }),
  }
}

function validateCommentAnchor(
  anchor: DocumentCommentAnchor,
  document: DocumentDetail,
): void {
  if (
    !isRecord(anchor) ||
    !['document', 'block', 'text', 'whiteboard-object'].includes(String(anchor.type))
  ) {
    throw invalidPayload('Document comment anchor is invalid.')
  }
  if (anchor.type === 'document') return
  if (anchor.type === 'block' || anchor.type === 'text') {
    const blocks = document.kind === 'page' || document.kind === 'template' ? document.blocks : []
    const block = blocks.find(({ id }) => id === anchor.blockId)
    if (block === undefined) {
      throw new DocumentError(400, 'InvalidDocumentCommentAnchor', 'Comment anchor block was not found.')
    }
    if (anchor.type === 'text') {
      const textLength = blockTextLength(block)
      if (
        !Number.isSafeInteger(anchor.start) ||
        !Number.isSafeInteger(anchor.end) ||
        anchor.start < 0 ||
        anchor.end <= anchor.start ||
        anchor.end > textLength
      ) {
        throw new DocumentError(400, 'InvalidDocumentCommentAnchor', 'Comment text range is invalid.')
      }
    }
    return
  }
  const objects = document.kind === 'whiteboard' ? document.whiteboard.objects : []
  if (!objects.some(({ id }) => id === anchor.objectId)) {
    throw new DocumentError(400, 'InvalidDocumentCommentAnchor', 'Comment anchor object was not found.')
  }
}

function validatePresenceSelection(
  selection: DocumentPresenceSelection,
  document: DocumentDetail,
): void {
  if (!isRecord(selection) || (selection.type !== 'text' && selection.type !== 'whiteboard')) {
    throw invalidPayload('Document presence selection is invalid.')
  }
    if (selection.type === 'text') {
    if (document.kind !== 'page' && document.kind !== 'template') {
      throw invalidPayload('Text presence requires a page or template.')
    }
    assertIdentifier(selection.blockId, 'selection.blockId')
    const block = document.blocks.find(({ id }) => id === selection.blockId)
    if (block === undefined) {
      throw invalidPayload('Presence selection references a missing block.')
    }
    if (
      !Number.isSafeInteger(selection.anchorOffset) ||
      !Number.isSafeInteger(selection.focusOffset) ||
      selection.anchorOffset < 0 ||
      selection.focusOffset < 0 ||
      selection.anchorOffset > blockTextLength(block) ||
      selection.focusOffset > blockTextLength(block)
    ) {
      throw invalidPayload('Presence text offsets must be non-negative integers.')
    }
    return
  }
  if (document.kind !== 'whiteboard' || !Array.isArray(selection.objectIds)) {
    throw invalidPayload('Whiteboard presence selection is invalid.')
  }
  const objectIds = new Set(document.whiteboard.objects.map(({ id }) => id))
  for (const objectId of selection.objectIds) {
    assertIdentifier(objectId, 'selection.objectIds[]')
    if (!objectIds.has(objectId)) {
      throw invalidPayload('Presence selection references a missing whiteboard object.')
    }
  }
  if (selection.pointer !== undefined) {
    if (
      !isRecord(selection.pointer) ||
      typeof selection.pointer.x !== 'number' ||
      !Number.isFinite(selection.pointer.x) ||
      typeof selection.pointer.y !== 'number' ||
      !Number.isFinite(selection.pointer.y)
    ) {
      throw invalidPayload('Presence pointer must contain finite coordinates.')
    }
  }
}

function blockTextLength(block: DocumentBlock): number {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return block.text.length
    case 'table':
      return block.rows.reduce(
        (length, row) =>
          length + row.cells.reduce((rowLength, cell) => rowLength + cell.text.length, 0),
        0,
      )
    case 'code':
      return block.code.length
    case 'checklist':
      return block.items.reduce((length, item) => length + item.text.length, 0)
    case 'embed':
      return (block.title ?? block.url).length
    case 'diagram':
      return block.source.length
  }
}

function fingerprint(value: unknown): string {
  return sha256(stableStringify(value))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function createIdempotentPublicShareToken(
  secret: string,
  workspaceId: string,
  idempotencyKey: string,
) {
  return createHmac('sha256', secret)
    .update('mukuroji-public-share\0')
    .update(workspaceId)
    .update('\0')
    .update(idempotencyKey)
    .digest('base64url')
}

function resolvePublicShareTokenSecret(configuredSecret?: string) {
  if (configuredSecret === undefined) {
    return randomBytes(DOCUMENT_PUBLIC_SHARE_TOKEN_BYTES).toString(
      'base64url',
    )
  }
  const secret = configuredSecret.trim()
  if (Buffer.byteLength(secret, 'utf8') < DOCUMENT_PUBLIC_SHARE_TOKEN_BYTES) {
    throw new Error(
      `DOCUMENT_PUBLIC_SHARE_TOKEN_SECRET must contain at least ${DOCUMENT_PUBLIC_SHARE_TOKEN_BYTES} UTF-8 bytes.`,
    )
  }
  return secret
}

function createIdempotentTemplateBlockId(
  workspaceId: string,
  idempotencyKey: string,
  sourceBlockId: string,
) {
  return `block_${sha256(
    `mukuroji-template-block\0${workspaceId}\0${idempotencyKey}\0${sourceBlockId}`,
  ).slice(0, 32)}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

function encodeKeyPart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function documentKey(documentId: string): string {
  return `DOCUMENT#${documentId}`
}

function documentSearchAccessKey(
  documentId: string,
): string {
  return `SEARCH_ACCESS#${encodeKeyPart(documentId)}`
}

function documentSearchBodyKey(
  documentId: string,
): string {
  return `SEARCH_BODY#${encodeKeyPart(documentId)}`
}

function documentTreeRevisionKey(): 'DOCUMENT_TREE_REVISION' {
  return 'DOCUMENT_TREE_REVISION'
}

function documentChildPrefix(parentId: string): string {
  return `DOCUMENT_CHILD#${encodeKeyPart(parentId)}#`
}

function documentChildKey(
  parentId: string,
  documentId: string,
): string {
  return `${documentChildPrefix(parentId)}${encodeKeyPart(documentId)}`
}

function versionKey(documentId: string, revision: number): string {
  return `VERSION#${documentId}#${revision.toString().padStart(DOCUMENT_VERSION_REVISION_WIDTH, '0')}`
}

function operationKey(documentId: string, operationId: string): string {
  return `OPERATION#${encodeKeyPart(documentId)}#${encodeKeyPart(operationId)}`
}

function preferenceKey(memberKey: string, documentId: string): string {
  return `PREFERENCE#${encodeKeyPart(memberKey)}#${encodeKeyPart(documentId)}`
}

function recentPrefix(memberKey: string): string {
  return `RECENT#${encodeKeyPart(memberKey)}#`
}

function recentKey(
  memberKey: string,
  openedAt: string,
  documentId: string,
) {
  const reverseTimestamp = (
    9_999_999_999_999 - Date.parse(openedAt)
  ).toString().padStart(13, '0')
  return `${recentPrefix(memberKey)}${reverseTimestamp}#${encodeKeyPart(documentId)}`
}


function commentKey(documentId: string, createdAt: string, commentId: string): string {
  return `COMMENT#${encodeKeyPart(documentId)}#${createdAt}#${encodeKeyPart(commentId)}`
}

function commentReceiptKey(documentId: string, commentId: string): string {
  return `COMMENT_ID#${encodeKeyPart(documentId)}#${encodeKeyPart(commentId)}`
}

function presenceKey(documentId: string, memberKey: string): string {
  return `PRESENCE#${encodeKeyPart(documentId)}#${encodeKeyPart(memberKey)}`
}

function shareKey(documentId: string, shareId: string): string {
  return `SHARE#${encodeKeyPart(documentId)}#${encodeKeyPart(shareId)}`
}

function publicPartitionKey(tokenHash: string): string {
  return `PUBLIC#${tokenHash}`
}

function backlinkPrefix(
  targetKind: StoredDocumentBacklinkItem['targetKind'],
  targetId: string,
): string {
  return `BACKLINK#${targetKind}#${encodeKeyPart(targetId)}#`
}

function workItemBacklinkTargetFenceKey(
  workItemId: string,
): string {
  return `BACKLINK_TARGET_FENCE#work-item#${encodeKeyPart(workItemId)}`
}

function backlinkKey(documentId: string, relation: DocumentRelation): string {
  const targetKind = relation.target.kind
  return `${backlinkPrefix(targetKind, relationTargetId(relation))}${encodeKeyPart(documentId)}#${encodeKeyPart(relation.id)}`
}

function relationTargetId(relation: DocumentRelation): string {
  switch (relation.target.kind) {
    case 'work-item':
      return relation.target.workItemId
    case 'project':
      return relation.target.projectId
    case 'goal':
      return relation.target.goalId
  }
}

function initialElementRevisions(
  document: DocumentDetail,
  revision: number,
): Record<string, number> {
  const revisions: Record<string, number> = {}
  if (document.kind === 'page' || document.kind === 'template') {
    for (const block of document.blocks) revisions[`block:${block.id}`] = revision
  } else if (document.kind === 'whiteboard') {
    for (const object of document.whiteboard.objects) revisions[`object:${object.id}`] = revision
    for (const connector of document.whiteboard.connectors) {
      revisions[`connector:${connector.id}`] = revision
    }
    for (const frame of document.whiteboard.frames) revisions[`frame:${frame.id}`] = revision
  }
  for (const relation of document.relations) revisions[`relation:${relation.id}`] = revision
  return revisions
}

function restoredElementRevisions(
  current: DocumentDetail,
  restored: DocumentDetail,
  existing: Readonly<Record<string, number>>,
  revision: number,
): Record<string, number> {
  const revisions = { ...existing }
  const changedKeys = new Set([
    ...Object.keys(initialElementRevisions(current, current.revision)),
    ...Object.keys(initialElementRevisions(restored, revision)),
  ])
  for (const key of changedKeys) revisions[key] = revision
  return revisions
}

/**
 * Tombstone compaction 後の bounded element revision history です。
 */
type CompactedElementRevisionHistory = {
  /** Live element と保持中 tombstone の revision map です。 */
  elementRevisions: Record<string, number>
  /** これより古い base revision を fail-closed で拒否する floor です。 */
  operationConflictFloorRevision: number
}

function compactElementRevisionHistory(
  document: DocumentDetail,
  elementRevisions: Readonly<Record<string, number>>,
  currentConflictFloorRevision: number,
): CompactedElementRevisionHistory {
  const liveRevisionDefaults = initialElementRevisions(
    document,
    document.revision,
  )
  const liveKeys = new Set(Object.keys(liveRevisionDefaults))
  const tombstones = Object.entries(elementRevisions).filter(
    ([key]) => !liveKeys.has(key),
  )
  if (
    tombstones.length <= DOCUMENT_ELEMENT_TOMBSTONE_LIMIT &&
    Buffer.byteLength(JSON.stringify(tombstones), 'utf8') <=
      DOCUMENT_ELEMENT_TOMBSTONE_MAX_BYTES
  ) {
    return {
      elementRevisions: { ...elementRevisions },
      operationConflictFloorRevision:
        currentConflictFloorRevision,
    }
  }

  const compacted: Record<string, number> = {}
  for (const [key, defaultRevision] of Object.entries(
    liveRevisionDefaults,
  )) {
    compacted[key] =
      elementRevisions[key] ?? defaultRevision
  }
  return {
    elementRevisions: compacted,
    operationConflictFloorRevision: Math.max(
      currentConflictFloorRevision,
      document.revision,
    ),
  }
}

function shouldCreateVersionSnapshot(
  current: StoredDocumentItem,
  nextDocument: DocumentDetail,
): boolean {
  if (
    current.lastVersionSnapshotRevision === undefined ||
    current.lastVersionSnapshotAt === undefined
  ) {
    return true
  }
  return (
    nextDocument.revision -
      current.lastVersionSnapshotRevision >=
      DOCUMENT_VERSION_SNAPSHOT_INTERVAL ||
    Date.parse(nextDocument.updatedAt) -
      Date.parse(current.lastVersionSnapshotAt) >=
      DOCUMENT_VERSION_SNAPSHOT_MAX_AGE_MS
  )
}

/**
 * Version row を full snapshot または compact delta として保存する設定です。
 */
type CreateVersionItemsOptions = {
  /** Delta の直前にある canonical snapshot です。 */
  previousDocument?: DocumentDetail
  /** Operation mutation を再構築する canonical operation batch です。 */
  operations?: readonly DocumentOperation[]
  /** Revision/time interval にかかわらず full snapshot を保存します。 */
  forceSnapshot?: boolean
}

/**
 * 一つの version mutation が transactionへ追加する rows です。
 */
type CreatedVersionItems = {
  /** Version list 用の compact metadata row です。 */
  metadata: StoredDocumentVersionItem
  /** 定期 compaction point となる full snapshot row です。 */
  snapshot?: StoredDocumentVersionSnapshotItem
  /** Full snapshot 間を復元する compact delta row です。 */
  delta?: StoredDocumentVersionDeltaItem
}

function createVersionItems(
  workspaceId: string,
  document: DocumentDetail,
  elementRevisions: Record<string, number>,
  reason: DocumentVersion['reason'],
  summary?: string,
  options: CreateVersionItemsOptions = {},
): CreatedVersionItems {
  const version: DocumentVersion = {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: `${document.id}:${document.revision}`,
    documentId: document.id,
    revision: document.revision,
    kind: document.kind,
    title: document.title,
    reason,
    ...(summary === undefined ? {} : { summary }),
    createdByUserId: document.updatedByUserId,
    createdAt: document.updatedAt,
  }
  const expiresAtEpoch =
    retentionEpoch(
      document.updatedAt,
      DOCUMENT_VERSION_RETENTION_DAYS,
    )
  const metadata: StoredDocumentVersionItem = {
    workspaceId,
    recordKey: versionKey(document.id, document.revision),
    entryType: 'document-version',
    version,
    expiresAtEpoch,
  }
  if (
    options.forceSnapshot === true ||
    options.previousDocument === undefined
  ) {
    return {
      metadata,
      snapshot: {
        workspaceId,
        recordKey: versionSnapshotKey(document.id, document.revision),
        entryType: 'document-version-snapshot',
        version,
        document: structuredClone(document),
        elementRevisions: { ...elementRevisions },
        expiresAtEpoch:
          expiresAtEpoch +
          Math.ceil(
            DOCUMENT_VERSION_SNAPSHOT_MAX_AGE_MS /
              1_000,
          ),
      },
    }
  }
  const changedFields: Record<string, unknown> = {}
  const removedFields: string[] = []
  const operationManagedFields = new Set(
    options.operations === undefined
      ? []
      : ['blocks', 'whiteboard', 'relations'],
  )
  for (const [field, value] of Object.entries(document)) {
    if (
      field === 'revision' ||
      operationManagedFields.has(field)
    ) {
      continue
    }
    const previousValue =
      (options.previousDocument as unknown as Record<
        string,
        unknown
      >)[field]
    if (
      stableStringify(previousValue) !==
      stableStringify(value)
    ) {
      changedFields[field] = structuredClone(value)
    }
  }
  for (const field of Object.keys(options.previousDocument)) {
    if (
      field !== 'revision' &&
      !operationManagedFields.has(field) &&
      !(field in document)
    ) {
      removedFields.push(field)
    }
  }
  return {
    metadata,
    delta: {
      workspaceId,
      recordKey: versionDeltaKey(
        document.id,
        document.revision,
      ),
      entryType: 'document-version-delta',
      version,
      baseRevision: options.previousDocument.revision,
      ...(options.operations === undefined
        ? {}
        : {
            operations: structuredClone(
              options.operations,
            ),
          }),
      ...(Object.keys(changedFields).length === 0
        ? {}
        : { changedFields }),
      ...(removedFields.length === 0
        ? {}
        : { removedFields }),
      expiresAtEpoch,
    },
  }
}

function validateApplyOperationsRequest(
  input: ApplyDocumentOperationsRequest,
): void {
  if (
    !isRecord(input) ||
    !isRecord(input.input) ||
    !Array.isArray(input.input.operations)
  ) {
    throw invalidPayload(
      'Document operations input is invalid.',
    )
  }
  if (
    input.validatedPendingOperationIds !==
      undefined &&
    (
      !Array.isArray(
        input.validatedPendingOperationIds,
      ) ||
      new Set(
        input.validatedPendingOperationIds,
      ).size !==
        input.validatedPendingOperationIds.length ||
      input.validatedPendingOperationIds.some(
        (operationId) =>
          typeof operationId !== 'string' ||
          !input.input.operations.some(
            (operation) =>
              operation.operationId ===
                operationId,
          ),
      )
    )
  ) {
    throw invalidPayload(
      'Validated pending operation IDs are invalid.',
    )
  }
  assertIdentifier(input.input.clientId, 'clientId')
  if (
    input.input.operations.length === 0 ||
    input.input.operations.length >
      DOCUMENT_MAX_OPERATION_COUNT
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentOperationCount',
      'The operation count is invalid.',
    )
  }
}

function createOperationReplayResponse(
  row: StoredDocumentItem,
  operations: readonly DocumentOperation[],
  receipts: readonly StoredOperationReceipt[],
): ApplyDocumentOperationsResponse {
  const revision = Math.max(
    ...receipts.map((receipt) => receipt.revision),
  )
  const updatedAt =
    receipts
      .map((receipt) => receipt.createdAt)
      .sort()
      .at(-1) ??
    row.document.updatedAt
  return {
    documentId: row.documentId,
    revision,
    appliedOperationIds: operations.map(
      ({ operationId }) => operationId,
    ),
    updatedAt,
  }
}

function currentDocumentPut(
  tableName: string,
  item: StoredDocumentItem,
  expectedRevision: number,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  assertDynamoItemSize(item)
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'revision = :expectedRevision',
      ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
    },
  }
}

function documentSearchAccessPut(
  tableName: string,
  workspaceId: string,
  document: DocumentDetail,
  requireAbsent = false,
): NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number] {
  const item:
    StoredDocumentSearchAccessItem = {
      workspaceId,
      recordKey:
        documentSearchAccessKey(
          document.id,
        ),
      entryType: 'document-search-access',
      documentId: document.id,
      ...(document.parentId === undefined
        ? {}
        : { parentId: document.parentId }),
      scope: structuredClone(document.scope),
      permission: structuredClone(
        document.permission,
      ),
      ...(document.archivedAt === undefined
        ? {}
        : {
            archivedAt:
              document.archivedAt,
          }),
      revision: document.revision,
      updatedAt: document.updatedAt,
    }
  assertDynamoItemSize(item)
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ...(requireAbsent
        ? {
            ConditionExpression:
              'attribute_not_exists(workspaceId)',
          }
        : {}),
    },
  }
}

function documentSearchBodyPut(
  tableName: string,
  workspaceId: string,
  document: DocumentDetail,
  requireAbsent = false,
): NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number] {
  const item:
    StoredDocumentSearchBodyItem = {
      workspaceId,
      recordKey:
        documentSearchBodyKey(
          document.id,
        ),
      entryType: 'document-search-body',
      documentId: document.id,
      bodyEncoding: 'gzip',
      bodyGzip: gzipSync(
        createDocumentWorkspaceSearchBody(
          document,
        ),
      ),
      revision: document.revision,
      updatedAt: document.updatedAt,
    }
  assertDocumentSearchBodyItemSize(item)
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ...(requireAbsent
        ? {
            ConditionExpression:
              'attribute_not_exists(workspaceId)',
          }
        : {}),
    },
  }
}

function readDocumentSearchAccessItem(
  value: Record<string, unknown> | undefined,
  workspaceId: string,
  documentId: string,
): StoredDocumentSearchAccessItem | undefined {
  if (
    !isRecord(value) ||
    value.workspaceId !== workspaceId ||
    value.recordKey !==
      documentSearchAccessKey(documentId) ||
    value.entryType !==
      'document-search-access' ||
    value.documentId !== documentId ||
    (
      value.parentId !== undefined &&
      (
        typeof value.parentId !== 'string' ||
        value.parentId.length === 0
      )
    ) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(
      Date.parse(value.updatedAt),
    ) ||
    (
      value.archivedAt !== undefined &&
      (
        typeof value.archivedAt !== 'string' ||
        !Number.isFinite(
          Date.parse(value.archivedAt),
        )
      )
    )
  ) {
    return undefined
  }
  try {
    validateDocumentScope(
      value.scope as DocumentScope,
    )
    validateDocumentPermission(
      value.permission as DocumentPermission,
    )
  } catch {
    return undefined
  }
  return value as StoredDocumentSearchAccessItem
}

function readDocumentSearchBodyItem(
  value: Record<string, unknown> | undefined,
  workspaceId: string,
  documentId: string,
): StoredDocumentSearchBodyItem | undefined {
  if (
    !isRecord(value) ||
    value.workspaceId !== workspaceId ||
    value.recordKey !==
      documentSearchBodyKey(documentId) ||
    value.entryType !==
      'document-search-body' ||
    value.documentId !== documentId ||
    value.bodyEncoding !== 'gzip' ||
    !(value.bodyGzip instanceof Uint8Array) ||
    value.bodyGzip.byteLength === 0 ||
    value.bodyGzip.byteLength > 380_000 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(
      Date.parse(value.updatedAt),
    )
  ) {
    return undefined
  }
  return value as StoredDocumentSearchBodyItem
}

function decompressDocumentSearchBody(
  item: StoredDocumentSearchBodyItem,
): string | undefined {
  try {
    const bytes = gunzipSync(
      item.bodyGzip,
      {
        maxOutputLength:
          DOCUMENT_MAX_ITEM_BYTES,
      },
    )
    const body = bytes.toString('utf8')
    return Buffer.from(body, 'utf8').equals(bytes)
      ? body
      : undefined
  } catch {
    return undefined
  }
}

function archivedNeutralAccessSubject(
  document: DocumentAccessSubject,
  ignoreArchived: boolean,
): DocumentAccessSubject {
  return {
    scope: structuredClone(document.scope),
    permission: structuredClone(
      document.permission,
    ),
    ...(
      ignoreArchived ||
      document.archivedAt === undefined
        ? {}
        : { archivedAt: document.archivedAt }
    ),
  }
}

/**
 * Converts application-level authorization snapshots into physical DynamoDB guards.
 *
 * @param workspaceId - Workspace that owns the pending mutation.
 * @param snapshots - Semantic generations observed during authorization.
 * @returns Validated physical row guards owned by this adapter.
 */
function authorizationSnapshotGuards(
  workspaceId: string,
  snapshots:
    | readonly DocumentAuthorizationFenceSnapshot[]
    | undefined,
): readonly DynamoDbDocumentAuthorizationGuard[] {
  const environment = loadServerConfig().environment
  const enterpriseTableName =
    environment.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  return (snapshots ?? []).flatMap((snapshot) => {
    if (!isRecord(snapshot)) {
      throw new DocumentError(
        500,
        'InvalidDocumentAuthorizationSnapshot',
        'The authorization generation snapshot is invalid.',
      )
    }
    const memberKeyPresent =
      snapshot.workspaceMemberKey !== undefined
    const memberVersionPresent =
      snapshot.workspaceMemberVersion !== undefined
    if (
      snapshot.workspaceId !== workspaceId ||
      memberKeyPresent !== memberVersionPresent ||
      (
        snapshot.workspaceMemberKey !== undefined &&
        (
          typeof snapshot.workspaceMemberKey !== 'string' ||
          snapshot.workspaceMemberKey.trim().length === 0
        )
      ) ||
      isInvalidAuthorizationGeneration(
        snapshot.workspaceMemberVersion,
      ) ||
      isInvalidAuthorizationGeneration(snapshot.planningRevision) ||
      isInvalidAuthorizationGeneration(
        snapshot.enterpriseControlRevision,
      ) ||
      (
        !memberKeyPresent &&
        snapshot.planningRevision === undefined &&
        snapshot.enterpriseControlRevision === undefined
      )
    ) {
      throw new DocumentError(
        500,
        'InvalidDocumentAuthorizationSnapshot',
        'The authorization generation snapshot is invalid.',
      )
    }
    const guards: DynamoDbDocumentAuthorizationGuard[] = []
    if (
      snapshot.workspaceMemberKey !== undefined &&
      snapshot.workspaceMemberVersion !== undefined
    ) {
      guards.push({
        tableName:
          environment.MUKUROJI_WORKSPACE_ACCESS_TABLE ??
          environment.WORKSPACE_ACCESS_TABLE_NAME ??
          'mukuroji-workspace-access-local',
        key: {
          workspaceId,
          recordKey:
            `MEMBER#${normalizeDocumentManagerMemberKey(
              snapshot.workspaceMemberKey,
            )}`,
        },
        generationAttribute: 'version',
        expectedGeneration:
          snapshot.workspaceMemberVersion,
        requiredAttributes: {
          entryType: 'workspace-member',
          status: 'active',
        },
      })
    }
    if (snapshot.planningRevision !== undefined) {
      guards.push({
        tableName:
          environment.PLANNING_TABLE_NAME ??
          'mukuroji-planning-local',
        key: {
          workspaceId: `FENCE#${workspaceId}`,
          recordKey: 'META',
        },
        generationAttribute: 'revision',
        expectedGeneration: snapshot.planningRevision,
        requiredAttributes: {
          entryType: 'planning-meta',
          schemaVersion: PLANNING_STORAGE_SCHEMA_VERSION,
        },
        ...(snapshot.planningRevision === 0
          ? { allowMissingWhenExpectedZero: true }
          : {}),
      })
    }
    if (
      enterpriseTableName &&
      snapshot.enterpriseControlRevision !== undefined
    ) {
      guards.push({
        tableName: enterpriseTableName,
        key: {
          scopeKey: `WORKSPACE#${workspaceId}`,
          recordKey: 'CONTROL',
        },
        generationAttribute: 'controlRevision',
        expectedGeneration:
          snapshot.enterpriseControlRevision,
        requiredAttributes: {
          entryType: 'enterprise-identity-control',
        },
        ...(snapshot.enterpriseControlRevision === 0
          ? { allowMissingWhenExpectedZero: true }
          : {}),
      })
    }
    return guards
  })
}

/**
 * Checks whether an optional authorization generation cannot be persisted safely.
 *
 * @param value - Candidate authorization generation.
 * @returns `true` when the supplied value is not a non-negative safe integer.
 */
function isInvalidAuthorizationGeneration(
  value: unknown,
): boolean {
  return value !== undefined &&
    (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    )
}

function requireAuthorizationGuards(
  workspaceId: string,
  access: DocumentAccessContext,
): readonly DynamoDbDocumentAuthorizationGuard[] {
  if (
    access.authorizationSnapshots === undefined ||
    access.authorizationSnapshots.length === 0
  ) {
    throw new DocumentError(
      503,
      'DocumentAuthorizationGuardRequired',
      'Public share creation requires a current authorization generation.',
    )
  }
  return authorizationSnapshotGuards(
    workspaceId,
    access.authorizationSnapshots,
  )
}

function authorizationGuardConditionChecks(
  guards:
    | readonly DynamoDbDocumentAuthorizationGuard[]
    | undefined,
): NonNullable<
  TransactWriteCommandInput['TransactItems']
> {
  return (guards ?? []).map((guard) =>
    authorizationGuardConditionCheck(
      validateAuthorizationGuard(guard),
    )
  )
}

function mergeAuthorizationGuards(
  workspaceId: string,
  ...groups: Array<
    | readonly (
      | DocumentAuthorizationFenceSnapshot
      | DynamoDbDocumentAuthorizationGuard
    )[]
    | undefined
  >
): readonly DynamoDbDocumentAuthorizationGuard[] {
  const merged = new Map<
    string,
    DynamoDbDocumentAuthorizationGuard
  >()
  for (const group of groups) {
    for (const candidate of group ?? []) {
      const guards = 'tableName' in candidate
        ? [validateAuthorizationGuard(candidate)]
        : authorizationSnapshotGuards(
            workspaceId,
            [candidate],
          )
      for (const guard of guards) {
        const key =
          `${guard.tableName}\0${stableStringify(
            guard.key,
          )}`
        const existing = merged.get(key)
        if (
          existing !== undefined &&
          stableStringify(existing) !==
            stableStringify(guard)
        ) {
          throw new DocumentError(
            409,
            'DocumentAuthorizationChanged',
            'Authorization changed while validating the Document mutation.',
          )
        }
        merged.set(key, guard)
      }
    }
  }
  return [...merged.values()]
}

function documentAuthorizationSnapshotGuards(
  tableName: string,
  workspaceId: string,
  snapshots: readonly (
    | DocumentAuthorizationSnapshot
    | undefined
  )[],
  excludedDocumentIds: readonly string[] = [],
): readonly DynamoDbDocumentAuthorizationGuard[] {
  const excluded = new Set(excludedDocumentIds)
  return snapshots.flatMap(
    (snapshot) =>
      snapshot === undefined
        ? []
        : [
            snapshot.documentRow,
            ...snapshot.ancestorRows,
          ],
  )
    .filter(
      ({ documentId }) =>
        !excluded.has(documentId),
    )
    .map((row) => ({
      tableName,
      key: {
        workspaceId,
        recordKey: documentKey(
          row.documentId,
        ),
      },
      generationAttribute: 'revision',
      expectedGeneration: row.revision,
      requiredAttributes: {
        entryType: 'document',
        documentId: row.documentId,
      },
    }))
}

function validateAuthorizationGuard(
  guard: DynamoDbDocumentAuthorizationGuard,
): DynamoDbDocumentAuthorizationGuard {
  if (
    !isRecord(guard) ||
    typeof guard.tableName !== 'string' ||
    !/^[A-Za-z0-9_.-]{3,255}$/u.test(
      guard.tableName,
    ) ||
    !isRecord(guard.key) ||
    Object.keys(guard.key).length === 0 ||
    Object.values(guard.key).some(
      (value) =>
        typeof value !== 'string' ||
        value.length === 0,
    ) ||
    typeof guard.generationAttribute !==
      'string' ||
    !/^[A-Za-z][A-Za-z0-9_]*$/u.test(
      guard.generationAttribute,
    ) ||
    (
      typeof guard.expectedGeneration !==
        'string' &&
      (
        typeof guard.expectedGeneration !==
          'number' ||
        !Number.isSafeInteger(
          guard.expectedGeneration,
        )
      )
    ) ||
    (
      typeof guard.expectedGeneration ===
        'string' &&
      guard.expectedGeneration.length === 0
    ) ||
    (
      guard.allowMissingWhenExpectedZero !==
        undefined &&
      (
        guard.allowMissingWhenExpectedZero !==
          true ||
        guard.expectedGeneration !== 0
      )
    ) ||
    (
      guard.requiredAttributes !== undefined &&
      (
        !isRecord(
          guard.requiredAttributes,
        ) ||
        Object.entries(
          guard.requiredAttributes,
        ).some(
          ([attribute, value]) =>
            !/^[A-Za-z][A-Za-z0-9_]*$/u.test(
              attribute,
            ) ||
            attribute ===
              guard.generationAttribute ||
            (
              typeof value !== 'string' &&
              typeof value !== 'number' &&
              typeof value !== 'boolean'
            ) ||
            (
              typeof value === 'number' &&
              !Number.isFinite(value)
            )
        )
      )
    )
  ) {
    throw new DocumentError(
      500,
      'InvalidDocumentAuthorizationGuard',
      'The authorization generation guard is invalid.',
    )
  }
  return guard
}

function authorizationGuardExpectedAttributes(
  guard: DynamoDbDocumentAuthorizationGuard,
): Record<string, string | number | boolean> {
  return {
    [guard.generationAttribute]:
      guard.expectedGeneration,
    ...guard.requiredAttributes,
  }
}

function authorizationGuardMatches(
  item: Record<string, unknown> | undefined,
  guard: DynamoDbDocumentAuthorizationGuard,
): boolean {
  if (item === undefined) {
    return (
      guard.allowMissingWhenExpectedZero ===
        true &&
      guard.expectedGeneration === 0
    )
  }
  return Object.entries(
    authorizationGuardExpectedAttributes(guard),
  ).every(
    ([attribute, expected]) =>
      item[attribute] === expected,
  )
}

function authorizationGuardConditionCheck(
  guard: DynamoDbDocumentAuthorizationGuard,
): NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number] {
  const expectedAttributes =
    authorizationGuardExpectedAttributes(guard)
  const entries = Object.entries(
    expectedAttributes,
  ).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  const expressionAttributeNames =
    Object.fromEntries(
      entries.map(([attribute], index) => [
        `#authorization${index}`,
        attribute,
      ]),
    )
  const expressionAttributeValues =
    Object.fromEntries(
      entries.map(([, value], index) => [
        `:authorization${index}`,
        value,
      ]),
    )
  const expectedExpression = entries
    .map(
      (_entry, index) =>
        `#authorization${index} = :authorization${index}`,
    )
    .join(' AND ')
  const missingKeyAttribute =
    Object.keys(guard.key).sort()[0]
  if (
    guard.allowMissingWhenExpectedZero ===
      true &&
    missingKeyAttribute !== undefined
  ) {
    expressionAttributeNames
      ['#authorizationKey'] =
        missingKeyAttribute
  }
  return {
    ConditionCheck: {
      TableName: guard.tableName,
      Key: { ...guard.key },
      ConditionExpression:
        guard.allowMissingWhenExpectedZero ===
          true
          ? `(attribute_not_exists(#authorizationKey) OR (${expectedExpression}))`
          : expectedExpression,
      ExpressionAttributeNames:
        expressionAttributeNames,
      ExpressionAttributeValues:
        expressionAttributeValues,
    },
  }
}

function documentAuthorizationConditionChecks(
  tableName: string,
  workspaceId: string,
  authorization: DocumentAuthorizationSnapshot,
): NonNullable<
  TransactWriteCommandInput['TransactItems']
> {
  return [
    authorization.documentRow,
    ...authorization.ancestorRows,
  ].map((row) => ({
    ConditionCheck: {
      TableName: tableName,
      Key: {
        workspaceId,
        recordKey: documentKey(
          row.documentId,
        ),
      },
      ConditionExpression:
        'revision = :expectedRevision',
      ExpressionAttributeValues: {
        ':expectedRevision': row.revision,
      },
    },
  }))
}

function documentShareEpochLineage(
  authorization: DocumentAuthorizationSnapshot,
): Record<string, number> {
  return Object.fromEntries(
    [
      authorization.documentRow,
      ...authorization.ancestorRows,
    ].map((row) => [
      row.documentId,
      row.publicShareEpoch ?? 0,
    ]),
  )
}

function documentChildIndexPut(
  tableName: string,
  workspaceId: string,
  document: DocumentDetail,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  if (document.parentId === undefined) {
    throw new DocumentError(
      500,
      'DocumentChildIndexInvalid',
      'A child index row requires a parent document.',
    )
  }
  const item: StoredDocumentChildIndexItem = {
    workspaceId,
    recordKey: documentChildKey(
      document.parentId,
      document.id,
    ),
    entryType: 'document-child',
    documentId: document.id,
    parentId: document.parentId,
    scope: structuredClone(document.scope),
    permission: structuredClone(document.permission),
    ...(document.archivedAt === undefined
      ? {}
      : { archivedAt: document.archivedAt }),
  }
  assertDynamoItemSize(item)
  return {
    Put: {
      TableName: tableName,
      Item: item,
    },
  }
}

function documentChildIndexMutationActions(
  tableName: string,
  workspaceId: string,
  current: DocumentDetail,
  next: DocumentDetail,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const actions: NonNullable<
    TransactWriteCommandInput['TransactItems']
  > = []
  if (
    current.parentId !== undefined &&
    current.parentId !== next.parentId
  ) {
    actions.push({
      Delete: {
        TableName: tableName,
        Key: {
          workspaceId,
          recordKey: documentChildKey(
            current.parentId,
            current.id,
          ),
        },
      },
    })
  }
  if (next.parentId !== undefined) {
    actions.push(
      documentChildIndexPut(
        tableName,
        workspaceId,
        next,
      ),
    )
  }
  return actions
}

function documentTreeRevisionPut(
  tableName: string,
  workspaceId: string,
  guard: DocumentTreeMutationGuard,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const item: StoredDocumentTreeRevisionItem = {
    workspaceId,
    recordKey: documentTreeRevisionKey(),
    entryType: 'document-tree-revision',
    revision: guard.expectedRevision + 1,
    updatedAt: guard.updatedAt,
  }
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression:
        guard.expectedRevision === 0
          ? 'attribute_not_exists(workspaceId)'
          : 'revision = :expectedRevision',
      ...(guard.expectedRevision === 0
        ? {}
        : {
            ExpressionAttributeValues: {
              ':expectedRevision': guard.expectedRevision,
            },
          }),
    },
  }
}

function versionPutActions(
  tableName: string,
  items: CreatedVersionItems,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const rows = [
    items.metadata,
    items.snapshot,
    items.delta,
  ].filter(
    (
      item,
    ): item is
      | StoredDocumentVersionItem
      | StoredDocumentVersionSnapshotItem
      | StoredDocumentVersionDeltaItem =>
      item !== undefined,
  )
  for (const row of rows) assertDynamoItemSize(row)
  return rows.map((item) => ({
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression:
        'attribute_not_exists(workspaceId)',
    },
  }))
}

function versionSnapshotKey(documentId: string, revision: number): string {
  return `VERSION_SNAPSHOT#${encodeKeyPart(documentId)}#${revision
    .toString()
    .padStart(DOCUMENT_VERSION_REVISION_WIDTH, '0')}`
}

function versionDeltaKey(
  documentId: string,
  revision: number,
): string {
  return `VERSION_DELTA#${encodeKeyPart(documentId)}#${revision
    .toString()
    .padStart(DOCUMENT_VERSION_REVISION_WIDTH, '0')}`
}

function parseVersionRevision(
  documentId: string,
  versionId: string,
): number | undefined {
  const canonicalPrefix = `${documentId}:`
  const revisionText = versionId.startsWith(canonicalPrefix)
    ? versionId.slice(canonicalPrefix.length)
    : versionId
  if (!/^\d+$/u.test(revisionText)) return undefined
  const revision = Number(revisionText)
  return Number.isSafeInteger(revision) && revision >= 1
    ? revision
    : undefined
}

function combineVersionSnapshot(
  metadata: StoredDocumentVersionItem,
  snapshot: StoredDocumentVersionSnapshotItem,
): StoredDocumentVersionSnapshotItem {
  if (
    metadata.version.id !== snapshot.version.id ||
    metadata.version.documentId !== snapshot.version.documentId
  ) {
    throw new DocumentError(
      500,
      'DocumentVersionCorrupt',
      'Document version metadata and snapshot do not match.',
    )
  }
  return {
    ...snapshot,
    version: metadata.version,
  }
}

function applyStoredVersionDelta(
  base: StoredDocumentVersionSnapshotItem,
  delta: StoredDocumentVersionDeltaItem,
): StoredDocumentVersionSnapshotItem {
  if (
    delta.baseRevision !== base.document.revision ||
    delta.version.documentId !==
      base.document.id ||
    delta.version.revision !==
      delta.baseRevision + 1
  ) {
    throw new DocumentError(
      500,
      'DocumentVersionCorrupt',
      'Document version delta chain is invalid.',
    )
  }
  let document = structuredClone(base.document)
  let elementRevisions = {
    ...base.elementRevisions,
  }
  if (delta.operations !== undefined) {
    const reduced = reduceDocumentOperations({
      document,
      elementRevisions,
      baseRevision: document.revision,
      nextRevision: delta.version.revision,
      operations: delta.operations,
    })
    document = reduced.document
    elementRevisions =
      reduced.elementRevisions
  } else {
    document.revision =
      delta.version.revision
  }
  const mutableDocument =
    document as unknown as Record<string, unknown>
  for (
    const [field, value] of Object.entries(
      delta.changedFields ?? {},
    )
  ) {
    mutableDocument[field] =
      structuredClone(value)
  }
  for (const field of delta.removedFields ?? []) {
    delete mutableDocument[field]
  }
  document.revision = delta.version.revision
  validateDocumentPayload(document)
  return {
    workspaceId: delta.workspaceId,
    recordKey: versionSnapshotKey(
      document.id,
      document.revision,
    ),
    entryType: 'document-version-snapshot',
    version: delta.version,
    document,
    elementRevisions,
    expiresAtEpoch: delta.expiresAtEpoch,
  }
}

function backlinkPutActions(
  tableName: string,
  workspaceId: string,
  documentId: string,
  relations: readonly DocumentRelation[],
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  return relations.map((relation) => ({
    Put: {
      TableName: tableName,
      Item: {
        workspaceId,
        recordKey: backlinkKey(documentId, relation),
        entryType: 'document-backlink',
        documentId,
        targetKind: relation.target.kind,
        targetId: relationTargetId(relation),
        relation,
      } satisfies StoredDocumentBacklinkItem,
    },
  }))
}

function coalesceWorkItemBacklinkTargetDeltas(
  diff: DocumentRelationDiff,
): WorkItemBacklinkTargetDelta[] {
  const deltas = new Map<string, number>()
  for (const relation of diff.removed) {
    if (relation.target.kind !== 'work-item') {
      continue
    }
    deltas.set(
      relation.target.workItemId,
      (deltas.get(
        relation.target.workItemId,
      ) ?? 0) - 1,
    )
  }
  for (const relation of diff.added) {
    if (relation.target.kind !== 'work-item') {
      continue
    }
    deltas.set(
      relation.target.workItemId,
      (deltas.get(
        relation.target.workItemId,
      ) ?? 0) + 1,
    )
  }
  return [...deltas]
    .filter(([, delta]) => delta !== 0)
    .map(([targetId, delta]) => ({
      targetId,
      delta,
    }))
}

function createWorkItemBacklinkTargetFenceItem(
  workspaceId: string,
  workItemId: string,
  activeBacklinkCount: number,
  version: number,
  deletedAt?: string,
): StoredDocumentBacklinkTargetFenceItem {
  return {
    workspaceId,
    recordKey:
      workItemBacklinkTargetFenceKey(
        workItemId,
      ),
    entryType:
      'document-backlink-target-fence',
    schemaVersion:
      DOCUMENT_BACKLINK_TARGET_FENCE_SCHEMA_VERSION,
    targetKind: 'work-item',
    targetId: workItemId,
    activeBacklinkCount,
    version,
    ...(deletedAt === undefined
      ? {}
      : { deletedAt }),
  }
}

function readWorkItemBacklinkTargetFenceItem(
  value: unknown,
  workspaceId: string,
  workItemId: string,
): StoredDocumentBacklinkTargetFenceItem | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    value.workspaceId !== workspaceId ||
    value.recordKey !==
      workItemBacklinkTargetFenceKey(
        workItemId,
      ) ||
    value.entryType !==
      'document-backlink-target-fence' ||
    value.schemaVersion !==
      DOCUMENT_BACKLINK_TARGET_FENCE_SCHEMA_VERSION ||
    value.targetKind !== 'work-item' ||
    value.targetId !== workItemId ||
    !Number.isSafeInteger(
      value.activeBacklinkCount,
    ) ||
    Number(value.activeBacklinkCount) < 0 ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    (
      value.deletedAt !== undefined &&
      (
        typeof value.deletedAt !== 'string' ||
        !Number.isFinite(
          Date.parse(value.deletedAt),
        )
      )
    )
  ) {
    throw invalidDocumentBacklinkTargetFence()
  }
  return value as
    StoredDocumentBacklinkTargetFenceItem
}

function readStoredWorkItemBacklinkItem(
  value: unknown,
  workspaceId: string,
  workItemId: string,
): void {
  if (
    !isRecord(value) ||
    value.workspaceId !== workspaceId ||
    typeof value.recordKey !== 'string' ||
    !value.recordKey.startsWith(
      backlinkPrefix(
        'work-item',
        workItemId,
      ),
    ) ||
    value.entryType !== 'document-backlink' ||
    typeof value.documentId !== 'string' ||
    value.targetKind !== 'work-item' ||
    value.targetId !== workItemId ||
    !isRecord(value.relation) ||
    typeof value.relation.id !== 'string' ||
    !isRecord(value.relation.target) ||
    value.relation.target.kind !==
      'work-item' ||
    value.relation.target.workItemId !==
      workItemId
  ) {
    throw invalidDocumentBacklinkTargetFence()
  }
}

function invalidDocumentBacklinkTargetFence(): DocumentError {
  return new DocumentError(
    503,
    'InvalidDocumentBacklinkTargetFence',
    'Document backlink target fence data is invalid.',
  )
}

function documentRelationTargetDeleted(): DocumentError {
  return new DocumentError(
    409,
    'DocumentRelationTargetDeleted',
    'The related Work Item has been deleted.',
  )
}

function workItemDocumentBacklinkConflict(
  activeBacklinkCount: number,
): DocumentError {
  return new DocumentError(
    409,
    'WorkItemDocumentBacklinkConflict',
    'Unlink all Documents before deleting this Work Item.',
    { activeBacklinkCount },
  )
}

function backlinkRelations(document: DocumentDetail): DocumentRelation[] {
  if (document.kind !== 'whiteboard') return document.relations
  const workItemRelations: DocumentRelation[] = document.whiteboard.objects
    .filter((object) => object.type === 'work-item')
    .map((object) => ({
      id: `system:whiteboard-work-item:${object.id}`,
      source: { kind: 'whiteboard-object', objectId: object.id },
      target: { kind: 'work-item', workItemId: object.workItemId },
      createdByUserId: document.createdByUserId,
      createdAt: document.createdAt,
    }))
  return [...document.relations, ...workItemRelations]
}

function diffRelations(
  previous: readonly DocumentRelation[],
  next: readonly DocumentRelation[],
): DocumentRelationDiff {
  const previousById = new Map(previous.map((relation) => [relation.id, relation]))
  const nextById = new Map(next.map((relation) => [relation.id, relation]))
  const removed = previous.filter((relation) => {
    const replacement = nextById.get(relation.id)
    return replacement === undefined || fingerprint(replacement) !== fingerprint(relation)
  })
  const added = next.filter((relation) => {
    const existing = previousById.get(relation.id)
    return existing === undefined || fingerprint(existing) !== fingerprint(relation)
  })
  return { added, removed }
}

function backlinkDiffActions(
  tableName: string,
  workspaceId: string,
  documentId: string,
  diff: DocumentRelationDiff,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const addedKeys = new Set(diff.added.map((relation) => backlinkKey(documentId, relation)))
  return [
    ...diff.removed
      .filter((relation) => !addedKeys.has(backlinkKey(documentId, relation)))
      .map((relation) => ({
        Delete: {
          TableName: tableName,
          Key: { workspaceId, recordKey: backlinkKey(documentId, relation) },
        },
      })),
    ...backlinkPutActions(tableName, workspaceId, documentId, diff.added),
  ]
}

function assertDynamoItemSize(item: unknown): void {
  const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
  if (itemBytes > 380_000) {
    throw new DocumentError(
      413,
      'DocumentDynamoItemTooLarge',
      'The document cannot fit safely within the DynamoDB 400 KB item limit.',
      { itemBytes, maxItemBytes: 380_000 },
    )
  }
}

function assertDocumentSearchBodyItemSize(
  item: StoredDocumentSearchBodyItem,
): void {
  const itemBytes =
    item.bodyGzip.byteLength +
    Buffer.byteLength(
      JSON.stringify({
        ...item,
        bodyGzip: undefined,
      }),
      'utf8',
    )
  if (itemBytes > 380_000) {
    throw new DocumentError(
      413,
      'DocumentDynamoItemTooLarge',
      'The compressed Document search body cannot fit safely within the DynamoDB 400 KB item limit.',
      {
        itemBytes,
        maxItemBytes: 380_000,
      },
    )
  }
}

function assertTransactionSize(
  actions: NonNullable<TransactWriteCommandInput['TransactItems']>,
): void {
  if (actions.length > 99) {
    throw new DocumentError(
      413,
      'DocumentTransactionTooLarge',
      'The document mutation creates too many transactional writes.',
      { actionCount: actions.length, maxActionCount: 99 },
    )
  }
}

function requireExpectedRevision(
  row: StoredDocumentItem,
  expectedRevision: number,
): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new DocumentError(400, 'InvalidDocumentRevision', 'expectedRevision must be a positive integer.')
  }
  if (row.revision !== expectedRevision) {
    throw new DocumentError(
      409,
      'DocumentRevisionConflict',
      'The document changed after it was read.',
      { expectedRevision, actualRevision: row.revision },
    )
  }
}

function incrementDocument(
  document: DocumentDetail,
  memberKey: string,
  now: Date,
): void {
  document.revision += 1
  document.updatedByUserId = memberKey
  document.updatedAt = now.toISOString()
}

function scopesEqual(left: DocumentScope, right: DocumentScope): boolean {
  return left.type === right.type &&
    (left.type === 'workspace' ||
      (right.type === 'project' && left.projectId === right.projectId))
}

function requireScopeCreatePermission(
  scope: DocumentScope,
  access: DocumentAccessContext,
): void {
  if (access.isSystemAdmin) return
  if (access.restrictToAuthorizedScopes) {
    const role = scope.type === 'workspace'
      ? access.workspaceScopeRole
      : access.projectRoles?.[scope.projectId] ??
        access.projectRole
    if (
      access.workspaceRole !== 'guest' &&
      (role === 'manager' || role === 'member')
    ) {
      return
    }
    throw new DocumentError(
      403,
      'DocumentCreateDenied',
      'Project or Workspace edit access is required.',
    )
  }
  if (access.workspaceRole === 'owner' || access.workspaceRole === 'admin') return
  if (access.workspaceRole === 'guest') {
    throw new DocumentError(403, 'DocumentCreateDenied', 'Guests cannot create documents.')
  }
  if (scope.type === 'workspace') return
  const role = access.projectRoles?.[scope.projectId] ?? access.projectRole
  if (role !== 'manager' && role !== 'member') {
    throw new DocumentError(403, 'DocumentCreateDenied', 'Project edit access is required.')
  }
}

function requireScopeManagePermission(
  scope: DocumentScope,
  access: DocumentAccessContext,
): void {
  if (access.isSystemAdmin) return
  if (access.restrictToAuthorizedScopes) {
    const role = scope.type === 'workspace'
      ? access.workspaceScopeRole
      : access.projectRoles?.[scope.projectId] ??
        access.projectRole
    if (role === 'manager') return
    throw new DocumentError(
      403,
      'DocumentDestinationScopeDenied',
      'Destination scope manager access is required to move this document.',
    )
  }
  if (
    access.workspaceRole === 'owner' ||
    access.workspaceRole === 'admin'
  ) {
    return
  }
  if (
    scope.type === 'project' &&
    (access.projectRoles?.[scope.projectId] ?? access.projectRole) === 'manager'
  ) {
    return
  }
  throw new DocumentError(
    403,
    'DocumentDestinationScopeDenied',
    'Destination scope manager access is required to move this document.',
  )
}

function requireCapability(allowed: boolean, code: string): void {
  if (!allowed) throw new DocumentError(403, code, 'You do not have permission to perform this action.')
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new DocumentError(400, 'InvalidDocumentPageLimit', `limit must be between 1 and ${maximum}.`)
  }
  return value
}

function toDocumentNode(document: DocumentDetail): DocumentNode {
  return {
    schemaVersion: document.schemaVersion,
    id: document.id,
    kind: document.kind,
    scope: structuredClone(document.scope),
    ...(document.parentId === undefined ? {} : { parentId: document.parentId }),
    title: document.title,
    position: document.position,
    revision: document.revision,
    favorite: document.favorite,
    ...(document.lastOpenedAt === undefined ? {} : { lastOpenedAt: document.lastOpenedAt }),
    ...(document.archivedAt === undefined ? {} : { archivedAt: document.archivedAt }),
    capabilities: structuredClone(document.capabilities),
    childCount: document.kind === 'folder' ? document.childCount : 0,
    createdByUserId: document.createdByUserId,
    updatedByUserId: document.updatedByUserId,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }
}

function encodeCursor(
  value:
    | DocumentTreeCursor
    | DocumentVersionCursor
    | DocumentCommentCursor
    | DocumentBacklinkCursor,
): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value: string): unknown {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new DocumentError(400, 'InvalidDocumentCursor', 'The cursor is invalid.')
  }
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) {
      throw new Error('Cursor is not canonical base64url.')
    }
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new DocumentError(400, 'InvalidDocumentCursor', 'The cursor is invalid.')
  }
}

function decodeTreeCursor(
  value: string,
  workspaceId: string,
  queryFingerprint: string,
): DocumentTreeCursor {
  const cursor = decodeCursor(value)
  if (
    !isRecord(cursor) ||
    cursor.version !== 1 ||
    cursor.kind !== 'document-tree' ||
    cursor.workspaceId !== workspaceId ||
    cursor.queryFingerprint !== queryFingerprint ||
    typeof cursor.recordKey !== 'string'
  ) {
    throw new DocumentError(400, 'InvalidDocumentCursor', 'The cursor does not match this query.')
  }
  return cursor as DocumentTreeCursor
}

function decodeVersionCursor(
  value: string,
  workspaceId: string,
  documentId: string,
): DocumentVersionCursor {
  const cursor = decodeCursor(value)
  if (
    !isRecord(cursor) ||
    cursor.version !== 1 ||
    cursor.kind !== 'document-versions' ||
    cursor.workspaceId !== workspaceId ||
    cursor.documentId !== documentId ||
    typeof cursor.recordKey !== 'string'
  ) {
    throw new DocumentError(400, 'InvalidDocumentCursor', 'The cursor does not match this version query.')
  }
  return cursor as DocumentVersionCursor
}

function decodeCommentCursor(
  value: string,
  workspaceId: string,
  documentId: string,
  queryFingerprint: string,
): DocumentCommentCursor {
  const cursor = decodeCursor(value)
  if (
    !isRecord(cursor) ||
    cursor.version !== 1 ||
    cursor.kind !== 'document-comments' ||
    cursor.workspaceId !== workspaceId ||
    cursor.documentId !== documentId ||
    cursor.queryFingerprint !== queryFingerprint ||
    typeof cursor.recordKey !== 'string' ||
    !cursor.recordKey.startsWith(`COMMENT#${encodeKeyPart(documentId)}#`)
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentCursor',
      'The cursor does not match this comment query.',
    )
  }
  return cursor as DocumentCommentCursor
}

function decodeBacklinkCursor(
  value: string,
  workspaceId: string,
  targetKind: ListDocumentBacklinksRequest['targetKind'],
  targetId: string,
): DocumentBacklinkCursor {
  const cursor = decodeCursor(value)
  if (
    !isRecord(cursor) ||
    cursor.version !== 1 ||
    cursor.kind !== 'document-backlinks' ||
    cursor.workspaceId !== workspaceId ||
    cursor.targetKind !== targetKind ||
    cursor.targetId !== targetId ||
    typeof cursor.recordKey !== 'string' ||
    !cursor.recordKey.startsWith(
      backlinkPrefix(targetKind, targetId),
    )
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentCursor',
      'The cursor does not match this backlink query.',
    )
  }
  return cursor as DocumentBacklinkCursor
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const output: Output[] = []
  let nextIndex = 0
  const workers = Array.from(
    {
      length: Math.min(
        Math.max(1, concurrency),
        values.length,
      ),
    },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        const value = values[index]
        if (value !== undefined) {
          output[index] = await mapper(value, index)
        }
      }
    },
  )
  await Promise.all(workers)
  return output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isObjectLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripCommentStorageFields(item: Record<string, unknown>): StoredDocumentComment {
  const {
    workspaceId: _workspaceId,
    recordKey: _recordKey,
    entryType: _entryType,
    ...comment
  } = item
  return comment as StoredDocumentComment
}

function stripPresenceStorageFields(item: StoredDocumentPresenceItem): StoredDocumentPresence {
  const {
    workspaceId: _workspaceId,
    recordKey: _recordKey,
    entryType: _entryType,
    expiresAtEpoch: _expiresAtEpoch,
    ...presence
  } = item
  return presence
}

/**
 * Validates and constructs one durable operation receipt.
 *
 * @param value - Raw DynamoDB item.
 * @param workspaceId - Expected Workspace partition.
 * @param documentId - Expected Document owner.
 * @param operationId - Expected client operation ID.
 * @returns A validated receipt that is safe for idempotency decisions.
 */
function readStoredOperationReceipt(
  value: unknown,
  workspaceId: string,
  documentId: string,
  operationId: string,
): StoredOperationReceipt {
  if (
    !isRecord(value) ||
    value.workspaceId !== workspaceId ||
    value.recordKey !== operationKey(documentId, operationId) ||
    value.entryType !== 'document-operation' ||
    value.documentId !== documentId ||
    typeof value.clientId !== 'string' ||
    value.operationId !== operationId ||
    typeof value.fingerprint !== 'string' ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.expiresAtEpoch !== 'number' ||
    !Number.isSafeInteger(value.expiresAtEpoch) ||
    value.expiresAtEpoch < 0
  ) {
    throw invalidStoredDocumentData()
  }
  return {
    workspaceId,
    recordKey: value.recordKey,
    entryType: 'document-operation',
    documentId,
    clientId: value.clientId,
    operationId,
    fingerprint: value.fingerprint,
    revision: value.revision,
    createdAt: value.createdAt,
    expiresAtEpoch: value.expiresAtEpoch,
  }
}

/**
 * Validates and constructs one stored public-share row.
 *
 * @param value - Raw DynamoDB item.
 * @param workspaceId - Expected Workspace partition when known.
 * @param documentId - Expected Document ID when known.
 * @param shareId - Expected share ID when known.
 * @param invalid - Error factory used for invalid or cross-boundary data.
 * @returns A validated public-share storage item.
 */
function readStoredDocumentShareItem(
  value: unknown,
  workspaceId?: string,
  documentId?: string,
  shareId?: string,
  invalid: () => DocumentError = invalidStoredDocumentData,
): StoredDocumentShareItem {
  if (!isRecord(value)) throw invalid()
  const epochs = readDocumentShareEpochs(
    value.documentShareEpochs,
    invalid,
  )
  const idempotencyKeyPresent =
    value.createIdempotencyKeyHash !== undefined
  const fingerprintPresent =
    value.createRequestFingerprint !== undefined
  if (
    typeof value.workspaceId !== 'string' ||
    (workspaceId !== undefined && value.workspaceId !== workspaceId) ||
    value.entryType !== 'document-share' ||
    value.type !== 'public' ||
    typeof value.id !== 'string' ||
    (shareId !== undefined && value.id !== shareId) ||
    typeof value.documentId !== 'string' ||
    (documentId !== undefined && value.documentId !== documentId) ||
    value.recordKey !== shareKey(value.documentId, value.id) ||
    value.role !== 'viewer' ||
    !isCanonicalIsoTimestamp(value.expiresAt) ||
    typeof value.allowExport !== 'boolean' ||
    typeof value.createdByUserId !== 'string' ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    (
      value.revokedAt !== undefined &&
      !isCanonicalIsoTimestamp(value.revokedAt)
    ) ||
    typeof value.tokenHash !== 'string' ||
    !/^[\da-f]{64}$/u.test(value.tokenHash) ||
    typeof value.expiresAtEpoch !== 'number' ||
    !Number.isSafeInteger(value.expiresAtEpoch) ||
    value.expiresAtEpoch < 0 ||
    idempotencyKeyPresent !== fingerprintPresent ||
    (
      value.createIdempotencyKeyHash !== undefined &&
      typeof value.createIdempotencyKeyHash !== 'string'
    ) ||
    (
      value.createRequestFingerprint !== undefined &&
      typeof value.createRequestFingerprint !== 'string'
    )
  ) {
    throw invalid()
  }
  return {
    workspaceId: value.workspaceId,
    recordKey: value.recordKey,
    entryType: 'document-share',
    type: 'public',
    id: value.id,
    documentId: value.documentId,
    role: 'viewer',
    expiresAt: value.expiresAt,
    allowExport: value.allowExport,
    createdByUserId: value.createdByUserId,
    createdAt: value.createdAt,
    ...(value.revokedAt === undefined
      ? {}
      : { revokedAt: value.revokedAt }),
    tokenHash: value.tokenHash,
    expiresAtEpoch: value.expiresAtEpoch,
    documentShareEpochs: epochs,
    ...(value.createIdempotencyKeyHash === undefined
      ? {}
      : {
          createIdempotencyKeyHash:
            value.createIdempotencyKeyHash,
          createRequestFingerprint:
            value.createRequestFingerprint,
        }),
  }
}

/**
 * Validates and constructs one public-token lookup row.
 *
 * @param value - Raw DynamoDB item.
 * @param tokenHash - Digest derived from the presented bearer token.
 * @param invalid - Error factory used to hide malformed public lookup data.
 * @returns A validated public-token lookup item.
 */
function readStoredPublicLinkItem(
  value: unknown,
  tokenHash: string,
  invalid: () => DocumentError = invalidStoredDocumentData,
): StoredPublicLinkItem {
  if (!isRecord(value)) throw invalid()
  const epochs = readDocumentShareEpochs(
    value.documentShareEpochs,
    invalid,
  )
  if (
    value.workspaceId !== publicPartitionKey(tokenHash) ||
    value.recordKey !== 'LINK' ||
    value.entryType !== 'document-public-link' ||
    typeof value.targetWorkspaceId !== 'string' ||
    typeof value.documentId !== 'string' ||
    typeof value.shareId !== 'string' ||
    !isCanonicalIsoTimestamp(value.expiresAt) ||
    typeof value.expiresAtEpoch !== 'number' ||
    !Number.isSafeInteger(value.expiresAtEpoch) ||
    value.expiresAtEpoch < 0
  ) {
    throw invalid()
  }
  return {
    workspaceId: value.workspaceId,
    recordKey: 'LINK',
    entryType: 'document-public-link',
    targetWorkspaceId: value.targetWorkspaceId,
    documentId: value.documentId,
    shareId: value.shareId,
    expiresAt: value.expiresAt,
    documentShareEpochs: epochs,
    expiresAtEpoch: value.expiresAtEpoch,
  }
}

/**
 * Validates the archive-epoch lineage embedded in public-share rows.
 *
 * @param value - Raw lineage map.
 * @param invalid - Error factory for invalid lineage data.
 * @returns A newly constructed lineage map.
 */
function readDocumentShareEpochs(
  value: unknown,
  invalid: () => DocumentError,
): Record<string, number> {
  if (!isRecord(value)) throw invalid()
  const epochs: Record<string, number> = {}
  for (const [documentId, epoch] of Object.entries(value)) {
    if (
      documentId.length === 0 ||
      typeof epoch !== 'number' ||
      !Number.isSafeInteger(epoch) ||
      epoch < 0
    ) {
      throw invalid()
    }
    epochs[documentId] = epoch
  }
  return epochs
}

/**
 * Checks an exact canonical ISO-8601 timestamp without throwing an HTTP input error.
 *
 * @param value - Timestamp candidate read from storage.
 * @returns Whether the value is a canonical ISO timestamp.
 */
function isCanonicalIsoTimestamp(
  value: unknown,
): value is string {
  return typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
}

/** Returns the stable storage-corruption error used by trusted reads. */
function invalidStoredDocumentData(): DocumentError {
  return new DocumentError(
    503,
    'InvalidStoredDocumentData',
    'Stored Document data is invalid.',
  )
}

/**
 * Removes adapter-only fields from a validated public-share item.
 *
 * @param item - Validated public-share storage item.
 * @returns Public share metadata safe for application consumers.
 */
function stripShareStorageFields(
  item: StoredDocumentShareItem,
): StoredDocumentPublicShare {
  return {
    type: 'public',
    id: item.id,
    documentId: item.documentId,
    role: 'viewer',
    expiresAt: item.expiresAt,
    allowExport: item.allowExport,
    createdByUserId: item.createdByUserId,
    createdAt: item.createdAt,
    ...(item.revokedAt === undefined
      ? {}
      : { revokedAt: item.revokedAt }),
  }
}

function parseShareExpiry(value: string, now: Date): Date {
  assertIsoTimestamp(value, 'expiresAt')
  const expiry = new Date(value)
  if (expiry.getTime() <= now.getTime()) {
    throw new DocumentError(400, 'InvalidDocumentShareExpiry', 'Public share expiry must be in the future.')
  }
  const maximum = now.getTime() + DOCUMENT_PUBLIC_SHARE_MAX_DAYS * 86_400_000
  if (expiry.getTime() > maximum) {
    throw new DocumentError(
      400,
      'InvalidDocumentShareExpiry',
      `Public share expiry cannot exceed ${DOCUMENT_PUBLIC_SHARE_MAX_DAYS} days.`,
    )
  }
  return expiry
}

function isExpired(value: string, now: Date): boolean {
  const expiry = Date.parse(value)
  return !Number.isFinite(expiry) || expiry <= now.getTime()
}

function documentNotFound(): DocumentError {
  return new DocumentError(404, 'DocumentNotFound', 'Document was not found.')
}

function invalidPayload(message: string): DocumentError {
  return new DocumentError(400, 'InvalidDocumentPayload', message)
}

function publicShareNotFound(): DocumentError {
  return new DocumentError(404, 'DocumentPublicShareNotFound', 'Public share was not found or has expired.')
}

function isConditionalFailure(error: unknown): boolean {
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : ''
  if (name === 'ConditionalCheckFailedException') return true
  if (name !== 'TransactionCanceledException' || !isRecord(error)) return false
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons) || reasons.length === 0) return false
  const codes = reasons.map((reason) =>
    isRecord(reason) && typeof reason.Code === 'string'
      ? reason.Code
      : undefined
  )
  const failures = codes.filter((code) => code !== 'None')
  return codes.every((code) => typeof code === 'string') &&
    failures.length > 0 &&
    failures.every((code) => code === 'ConditionalCheckFailed')
}

/**
 * Retry loop が安全に再実行できる DynamoDB transaction conflict か判定します。
 *
 * `None` は未失敗 action として、`ConditionalCheckFailed` は次の attempt で再評価
 * できる既知の競合として許可します。validation、throughput、unknown code が混在する
 * cancellation は storage failure のまま fail closed にします。
 */
function isRetryableTransactionConflict(error: unknown): boolean {
  if (
    !isRecord(error) ||
    error.name !== 'TransactionCanceledException'
  ) {
    return false
  }
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return false
  }
  const codes = reasons.map((reason) =>
    isRecord(reason) && typeof reason.Code === 'string'
      ? reason.Code
      : undefined
  )
  const failures = codes.filter((code) => code !== 'None')
  return codes.every((code) => typeof code === 'string') &&
    failures.includes('TransactionConflict') &&
    failures.every((code) =>
      code === 'ConditionalCheckFailed' ||
      code === 'TransactionConflict'
    )
}

function isResourceNotFound(error: unknown): boolean {
  return isRecord(error) && error.name === 'ResourceNotFoundException'
}

function isResourceInUse(error: unknown): boolean {
  return isRecord(error) && error.name === 'ResourceInUseException'
}

function normalizeDynamoError(error: unknown): Error {
  throwIfWorkspaceSearchWriterFenceTerminalError(error)
  if (error instanceof DocumentError) return error
  return new DocumentError(
    503,
    'DocumentsStoreError',
    'The documents store request failed.',
    undefined,
    { cause: error },
  )
}
