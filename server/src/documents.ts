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
  DOCUMENT_OPERATION_BATCH_LIMIT,
  DOCUMENT_SCHEMA_VERSION,
  type ApplyDocumentOperationsInput,
  type ApplyDocumentOperationsResponse,
  type DocumentBlock,
  type DocumentCapabilities,
  type DocumentComment,
  type DocumentCommentAnchor,
  type DocumentCommentsResponse,
  type DocumentDetail,
  type DocumentKind,
  type DocumentMention,
  type DocumentNode,
  type DocumentOperation,
  type DocumentPermission,
  type DocumentPresence,
  type DocumentPresenceSelection,
  type DocumentPublicShare,
  type DocumentRelation,
  type DocumentRelationTarget,
  type DocumentScope,
  type DocumentTreeResponse,
  type DocumentVersion,
  type DocumentVersionsResponse,
  type PublicDocument,
  type WhiteboardConnector,
  type WhiteboardContent,
  type WhiteboardFrame,
  type WhiteboardObject,
} from '@mukuroji/contracts'
import {
  resolveDocumentCapabilities,
  type DocumentAccessSubject,
} from './document-access'
import {
  createAuditFieldChanges,
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  type MutationAuditContext,
} from './audit'
import {
  DOCUMENT_AUTHORIZATION_REVISION_KEY,
  createDocumentAuthorizationRevisionPut,
  type DocumentAuthorizationRevisionGuard,
} from './document-authorization'
import {
  createDocumentWorkspaceSearchBody,
} from './workspace-search'

/** DynamoDB item の 400 KB 上限に余裕を持たせた Document item 上限です。 */
export const DOCUMENT_MAX_ITEM_BYTES = 350_000

/** 一つの operation batch で受け付ける最大 operation 数です。 */
export const DOCUMENT_MAX_OPERATION_COUNT =
  DOCUMENT_OPERATION_BATCH_LIMIT

/** 一つの Document に保存できる rich text block 数です。 */
export const DOCUMENT_MAX_BLOCK_COUNT = 500

/** 一つの Whiteboard に保存できる object 数です。 */
export const DOCUMENT_MAX_WHITEBOARD_OBJECT_COUNT = 1_000

/** 一つの Whiteboard に保存できる connector 数です。 */
export const DOCUMENT_MAX_WHITEBOARD_CONNECTOR_COUNT = 2_000

/** 一つの Whiteboard に保存できる frame 数です。 */
export const DOCUMENT_MAX_WHITEBOARD_FRAME_COUNT = 250

/** Document tree が許可する最大の folder 深度です。 */
export const DOCUMENT_MAX_TREE_DEPTH = 32

/** Document comment 本文の最大文字数です。 */
export const DOCUMENT_COMMENT_MAX_LENGTH = 20_000

/** 一つの comment に保存できる mention 数です。 */
export const DOCUMENT_MENTION_MAX_COUNT = 20

/** Document comment 一覧で取得できる一 page の最大件数です。 */
export const DOCUMENT_COMMENT_MAX_PAGE_LIMIT = 100

/** Document backlink 一覧で取得できる一 page の最大件数です。 */
export const DOCUMENT_BACKLINK_MAX_PAGE_LIMIT = 50

/** Document public share token の既定 byte 数です。 */
export const DOCUMENT_PUBLIC_SHARE_TOKEN_BYTES = 32

/** Public share の最大有効日数です。 */
export const DOCUMENT_PUBLIC_SHARE_MAX_DAYS = 365

/** Full version snapshot を必ず作成する最大 revision 間隔です。 */
export const DOCUMENT_VERSION_SNAPSHOT_INTERVAL = 20

/** Full version snapshot を必ず作成する最大経過時間です。 */
export const DOCUMENT_VERSION_SNAPSHOT_MAX_AGE_MS =
  24 * 60 * 60 * 1_000

/** Version metadata/delta を保持する日数です。 */
export const DOCUMENT_VERSION_RETENTION_DAYS = 180

/** Operation idempotency receipt を保持する日数です。 */
export const DOCUMENT_OPERATION_RECEIPT_RETENTION_DAYS = 30

/**
 * 一つの Document から transactionally index できる backlink 数です。
 *
 * 最大深度 32 の Document で restore が全 target を差し替えても、current/version、
 * authorization lineage、backlink rows、target fence rowsを DynamoDB の 100 action
 * 上限内に収めるため 14 件に制限します。
 */
export const DOCUMENT_MAX_BACKLINK_COUNT = 14

/** Work Item backlink target fence の schema version です。 */
const DOCUMENT_BACKLINK_TARGET_FENCE_SCHEMA_VERSION = 1

/** Conditional retry を行う最大回数です。 */
const DOCUMENT_CONDITIONAL_RETRY_LIMIT = 6

/** Current row に保持する tombstone revision の最大件数です。 */
const DOCUMENT_ELEMENT_TOMBSTONE_LIMIT = 64

/** Current row に保持する tombstone revision の最大 UTF-8 byte 数です。 */
const DOCUMENT_ELEMENT_TOMBSTONE_MAX_BYTES = 32_000

/** 一つの text field に保存できる既定文字数です。 */
const DOCUMENT_MAX_TEXT_LENGTH = 50_000

/** Document title の最大文字数です。 */
const DOCUMENT_MAX_TITLE_LENGTH = 500

/** Presence list が返す active member の最大件数です。 */
const DOCUMENT_PRESENCE_MAX_VISIBLE = 100

/** Presence list 一回で評価する member lease の最大件数です。 */
const DOCUMENT_PRESENCE_EVALUATION_LIMIT = 1_000

/** Recent top-K 一回で source-of-truth 評価する最大候補数です。 */
const DOCUMENT_RECENT_EVALUATION_LIMIT = 1_000

/** Table block の最大 column 数です。 */
const DOCUMENT_MAX_TABLE_COLUMNS = 50

/** Table block の最大 row 数です。 */
const DOCUMENT_MAX_TABLE_ROWS = 200

/** DynamoDB TTL epoch を計算する一日の秒数です。 */
const SECONDS_PER_DAY = 24 * 60 * 60

/** Version revision を DynamoDB sort key に埋め込む幅です。 */
const DOCUMENT_VERSION_REVISION_WIDTH = 12

/** Canonical Whiteboard bounds が許可する field names です。 */
const WHITEBOARD_BOUND_FIELDS = new Set([
  'x',
  'y',
  'width',
  'height',
  'rotation',
])

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

/**
 * Document permission 解決に使う Workspace role です。
 */
export type DocumentWorkspaceRole = 'owner' | 'admin' | 'member' | 'guest'

/**
 * Document permission 解決に使う Project role です。
 */
export type DocumentProjectRole = 'manager' | 'member' | 'viewer'

/**
 * Document API が信頼済み認証層から受け取る actor snapshot です。
 */
export type DocumentAccessContext = {
  /** Workspace member の安定した key です。 */
  memberKey: string
  /** Workspace 全体で付与された role です。 */
  workspaceRole: DocumentWorkspaceRole
  /** Project scope Document に対する現在の Project role です。 */
  projectRole?: DocumentProjectRole
  /** Project ID ごとの現在の Project role です。 */
  projectRoles?: Readonly<Record<string, DocumentProjectRole>>
  /** Enterprise RBAC が許可した scope だけへ Document ACL を制限するかどうかです。 */
  restrictToAuthorizedScopes?: boolean
  /** Enterprise RBAC が Workspace scope で許可した最大 Document role です。 */
  workspaceScopeRole?: DocumentProjectRole
  /** Cognito group を現在確認済みの system administrator かどうかです。 */
  isSystemAdmin?: boolean
  /**
   * Workspace membership と Project role を包含する authorization generation です。
   *
   * Public share の作成 transaction で source-of-truth row を condition check
   * するため、共有可能な API principal は必ず設定します。
   */
  authorizationGuards?: readonly DocumentAuthorizationGenerationGuard[]
}

/**
 * 外部 authorization source の generation をDynamoDB transactionへ束縛します。
 */
export type DocumentAuthorizationGenerationGuard = {
  /** Authorization source row が保存されている DynamoDB table 名です。 */
  tableName: string
  /** Authorization source row の完全な primary key です。 */
  key: Readonly<
    Record<string, string | undefined>
  >
  /** 単調増加 generation を保持する属性名です。 */
  generationAttribute: string
  /** Principal 解決時に読み込んだ generation です。 */
  expectedGeneration: string | number
  /** Generation 0 の未初期化 source rowを許可するかどうかです。 */
  allowMissingWhenExpectedZero?: boolean
  /** Active status など同時に一致を要求する scalar attributes です。 */
  requiredAttributes?: Readonly<
    Record<string, string | number | boolean>
  >
}

/**
 * Document tree を取得する store input です。
 */
export type ListDocumentsRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 現在 viewer の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Workspace または Project の tree scope です。 */
  scope?: DocumentScope
  /** 指定 folder の直下だけを取得する場合の parent ID です。 */
  parentId?: string
  /** Archive 済み node を取得するかどうかです。 */
  archived?: boolean
  /** 一 page の最大 node 数です。 */
  limit?: number
  /** 前 page が返した opaque cursor です。 */
  cursor?: string
}

/**
 * 一つの Document detail を取得する store input です。
 */
export type GetDocumentRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 取得対象 Document ID です。 */
  documentId: string
  /** 現在 viewer の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Archive 済み Document の取得を許可するかどうかです。 */
  includeArchived?: boolean
}

/**
 * 一つの Workspace search request 内で compact ACL row reads を共有する context です。
 */
export type DocumentSearchAccessReadContext = {
  /**
   * Workspace/Document key ごとの raw DynamoDB row promise です。
   *
   * @internal
   */
  readonly rows: Map<
    string,
    Promise<Record<string, unknown> | undefined>
  >
}

/**
 * Workspace search request 単位の compact ACL read context を作成します。
 *
 * @returns 同じ request 内の候補と ancestor が共有する空の read cache です。
 */
export function createDocumentSearchAccessReadContext(
): DocumentSearchAccessReadContext {
  return {
    rows: new Map(),
  }
}

/**
 * Workspace search が compact ACL projection を検証する input です。
 */
export type ResolveDocumentSearchAccessRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 検索候補の Document ID です。 */
  documentId: string
  /** 現在 viewer の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Search index に保存された canonical revision です。 */
  expectedRevision: number
  /** Search index に保存された canonical updatedAt です。 */
  expectedUpdatedAt: string
  /** 同じ search request 内で candidate/ancestor reads を共有する context です。 */
  readContext?: DocumentSearchAccessReadContext
}

/**
 * Compact ACL projection で検証済みの検索 access です。
 */
export type ResolvedDocumentSearchAccess = {
  /** 現在の Workspace または Project scope です。 */
  scope: DocumentScope
  /** 検証した canonical Document revision です。 */
  revision: number
  /** 検証した canonical Document updatedAt です。 */
  updatedAt: string
  /** Canonical revision と同じ transaction で保存した省略なしの検索本文です。 */
  body: string
}

/**
 * 新しい Document を作成する store input です。
 */
export type CreateDocumentRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Mutation actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Document kind です。 */
  kind: DocumentKind
  /** Workspace または Project scope です。 */
  scope: DocumentScope
  /** Tree 上の親 folder ID です。 */
  parentId?: string
  /** Document の表示 title です。 */
  title: string
  /** 同じ親を持つ node 間の position です。 */
  position?: string
  /** Document の permission 設定です。 */
  permission?: DocumentPermission
  /** Page/template の初期 blocks です。 */
  blocks?: DocumentBlock[]
  /** Whiteboard の初期 content です。 */
  whiteboard?: WhiteboardContent
  /** 初期 domain relations です。 */
  relations?: DocumentRelation[]
  /** Relation target 検証を source revision へ束縛する transaction guards です。 */
  relationTargetAuthorizationGuards?: readonly DocumentAuthorizationGenerationGuard[]
  /** Template など作成元 Document の ACL snapshot を束縛する内部 transaction guards です。 */
  sourceAuthorizationGuards?: readonly DocumentAuthorizationGenerationGuard[]
  /** Client retry を同じ Document ID へ束縛する key です。 */
  idempotencyKey?: string
  /** Materialized content ではなく caller intent を束縛する内部 fingerprint です。 */
  idempotencyFingerprint?: string
  /**
   * Private ACL の member validation 前に読み込んだ authorization generation です。
   */
  expectedAuthorizationRevision?: number
}

/**
 * Document metadata を version 条件付きで更新する store input です。
 */
export type UpdateDocumentRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 更新対象 Document ID です。 */
  documentId: string
  /** Mutation actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /** 読み込み時点の Document revision です。 */
  expectedRevision: number
  /** 更新後の title です。 */
  title?: string
  /** 更新後の parent ID です。null で tree root へ移動します。 */
  parentId?: string | null
  /** 更新後の position です。 */
  position?: string
  /** 更新後の scope です。 */
  scope?: DocumentScope
  /** 更新後の permission 設定です。 */
  permission?: DocumentPermission
  /**
   * Private ACL の member validation 前に読み込んだ authorization generation です。
   */
  expectedAuthorizationRevision?: number
}

/**
 * Document operation batch を永続化する store input です。
 */
export type ApplyDocumentOperationsRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 更新対象 Document ID です。 */
  documentId: string
  /** Mutation actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Client が送信した atomic operation batch です。 */
  input: ApplyDocumentOperationsInput
  /** Relation target 検証を source revision へ束縛する transaction guards です。 */
  relationTargetAuthorizationGuards?: readonly DocumentAuthorizationGenerationGuard[]
  /**
   * API preflight で未確定として source validation した operation IDs です。
   */
  validatedPendingOperationIds?: readonly string[]
}

/**
 * API validation 前に operation receipts を解決した結果です。
 */
export type PrepareDocumentOperationsResponse =
  | {
      /** 全 operation が確定済みの場合に返す replay response です。 */
      replay: ApplyDocumentOperationsResponse
      /** Replay では pending input を返しません。 */
      pendingInput?: never
    }
  | {
      /** Pending operation がある場合は replay response を返しません。 */
      replay?: never
      /** Canonical/source validation を実行する未確定 operation だけの input です。 */
      pendingInput: ApplyDocumentOperationsInput
    }

/**
 * Document version history を取得する store input です。
 */
export type ListDocumentVersionsRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Version を取得する Document ID です。 */
  documentId: string
  /** 現在 viewer の認可 snapshot です。 */
  access: DocumentAccessContext
  /** 一 page の最大 version 数です。 */
  limit?: number
  /** 前 page が返した opaque cursor です。 */
  cursor?: string
}

/**
 * 過去 version を新しい revision として復元する store input です。
 */
export type RestoreDocumentVersionRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 復元対象 Document ID です。 */
  documentId: string
  /** 復元する version ID または decimal revision です。 */
  versionId: string
  /** 読み込み時点の current Document revision です。 */
  expectedRevision: number
  /** Mutation actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /**
   * Snapshot が再導入する relation / Whiteboard Work Item target を
   * current source of truth で検証します。
   */
  validateRelationTargets: (
    targets: readonly DocumentRelationTarget[],
  ) => Promise<
    | readonly DocumentAuthorizationGenerationGuard[]
    | void
  >
}

/**
 * Document favorite/recent preference を更新する store input です。
 */
export type UpdateDocumentPreferenceRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Preference 対象 Document ID です。 */
  documentId: string
  /** Preference owner の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Favorite を更新する場合の次状態です。 */
  favorite?: boolean
  /** Recent open を記録する場合の timestamp です。 */
  openedAt?: string
}

/**
 * Document preference mutation の永続化結果です。
 */
export type DocumentPreferenceResult = {
  /** Preference 対象 Document ID です。 */
  documentId: string
  /** 更新後の favorite 状態です。 */
  favorite: boolean
  /** 更新後の最終 open timestamp です。 */
  lastOpenedAt?: string
  /** Preference row の更新 timestamp です。 */
  updatedAt: string
  /** Viewer-specific preference を反映した Document node です。 */
  document: DocumentNode
}

/**
 * 現在 user の recent Document 一覧を取得する store input です。
 */
export type ListRecentDocumentsRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Preference owner の認可 snapshot です。 */
  access: DocumentAccessContext
  /** 返す最大 Document 数です。 */
  limit?: number
}

/**
 * Document archive/restore mutation の store input です。
 */
export type ChangeDocumentArchiveStateRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** 対象 Document ID です。 */
  documentId: string
  /** 読み込み時点の Document revision です。 */
  expectedRevision: number
  /** Mutation actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Restore 時に付け替える parent ID です。 */
  parentId?: string | null
  /** Relation target 検証を source revision へ束縛する transaction guards です。 */
  relationTargetAuthorizationGuards?: readonly DocumentAuthorizationGenerationGuard[]
}

/**
 * Template から新しい page を作成する store input です。
 */
export type InstantiateDocumentTemplateRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Source template Document ID です。 */
  templateId: string
  /** Mutation actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /** 作成する page の scope です。 */
  scope: DocumentScope
  /** 作成する page の親 folder ID です。 */
  parentId?: string
  /** 作成する page の title です。 */
  title?: string
  /** 作成する page の position です。 */
  position?: string
  /** 作成する page の permission 設定です。 */
  permission?: DocumentPermission
  /**
   * Private ACL の member validation 前に読み込んだ authorization generation です。
   */
  expectedAuthorizationRevision?: number
  /** Client retry を同じ page へ束縛する key です。 */
  idempotencyKey?: string
}

/**
 * Comment が指す Document 内 anchor です。
 */
export type StoredDocumentCommentAnchor = DocumentCommentAnchor

/**
 * Document comment の public snapshot です。
 */
export type StoredDocumentComment = DocumentComment

/**
 * Document comment 作成 input です。
 */
export type CreateDocumentCommentRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Comment 対象 Document ID です。 */
  documentId: string
  /** Mutation actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Plain text の本文です。 */
  body: string
  /** Reply 先 comment ID です。 */
  parentCommentId?: string
  /** 本文内の user mention ranges です。 */
  mentions?: DocumentMention[]
  /** Document 内の comment anchor です。 */
  anchor?: StoredDocumentCommentAnchor
  /** Ambiguous retry 用の comment ID です。 */
  commentId?: string
  /** Comment と同じ transaction で通知元 event を保存する audit context です。 */
  auditContext?: MutationAuditContext
}

/**
 * Document comment 一覧 input です。
 */
export type ListDocumentCommentsRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Comment を取得する Document ID です。 */
  documentId: string
  /** 現在 viewer の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Root comment とそれに属する replies を取得する場合の root ID です。 */
  rootCommentId?: string
  /** 一 page の最大 comment 数です。 */
  limit?: number
  /** 前 page が返した scope-bound opaque cursor です。 */
  cursor?: string
}

/**
 * Document comment resolve/reopen input です。
 */
export type ResolveDocumentCommentRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Comment が属する Document ID です。 */
  documentId: string
  /** Root comment ID です。 */
  commentId: string
  /** Mutation actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /** true で resolve、false で reopen します。 */
  resolved: boolean
}

/**
 * Document presence snapshot です。
 */
export type StoredDocumentPresence = DocumentPresence

/**
 * Document presence heartbeat input です。
 */
export type HeartbeatDocumentPresenceRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Presence 対象 Document ID です。 */
  documentId: string
  /** Presence actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Browser tab/editor instance ID です。 */
  clientId: string
  /** Collaborator の表示名です。 */
  displayName?: string
  /** Collaborator cursor の CSS color value です。 */
  color?: string
  /** Cursor/selection を表す contract selection です。 */
  selection?: DocumentPresenceSelection | null
  /** Lease の有効秒数です。 */
  ttlSeconds?: number
}

/**
 * Document presence leave/list input です。
 */
export type DocumentPresenceRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Presence 対象 Document ID です。 */
  documentId: string
  /** 現在 member の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Leave 対象の browser client ID です。 */
  clientId?: string
}

/**
 * Public share metadata です。
 */
export type StoredDocumentPublicShare = DocumentPublicShare

/**
 * Public share 作成 input です。
 */
export type CreateDocumentPublicShareRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Share 対象 Document ID です。 */
  documentId: string
  /** Mutation actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Share の有効期限 timestamp です。 */
  expiresAt: string
  /** Public viewer に Document export を許可するかどうかです。 */
  allowExport?: boolean
  /** Response loss 後も同じ share/token を復元する idempotency key です。 */
  idempotencyKey?: string
}

/**
 * Public share 作成時だけ raw token を含む response です。
 */
export type CreatedDocumentPublicShare = {
  /** 永続 share metadata です。 */
  share: StoredDocumentPublicShare
  /** 一度だけ caller に返す high-entropy bearer token です。 */
  token: string
}

/**
 * Public share list/revoke input です。
 */
export type DocumentPublicShareRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Share 対象 Document ID です。 */
  documentId: string
  /** Mutation/viewer actor の認可 snapshot です。 */
  access: DocumentAccessContext
  /** Revoke 対象 share ID です。 */
  shareId?: string
}

/**
 * Public token 解決結果です。
 */
export type ResolvedDocumentPublicShare = {
  /** Public viewer 用 Document snapshot です。 */
  document: DocumentDetail
  /** 有効な share metadata です。 */
  share: StoredDocumentPublicShare
}

/**
 * Backlink query input です。
 */
export type ListDocumentBacklinksRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Relation target 種別です。 */
  targetKind: 'work-item' | 'project' | 'goal'
  /** Relation target ID です。 */
  targetId: string
  /** 現在 viewer の認可 snapshot です。 */
  access: DocumentAccessContext
  /** 一 page で評価する backlink row の最大件数です。 */
  limit?: number
  /** 前 page が返した opaque cursor です。 */
  cursor?: string
}

/**
 * Permission-filtered backlink です。
 */
export type DocumentBacklink = {
  /** Backlink source Document ID です。 */
  documentId: string
  /** Backlink source Document title です。 */
  documentTitle: string
  /** Backlink を作成した relation です。 */
  relation: DocumentRelation
}

/**
 * Permission-filtered backlink page です。
 */
export type DocumentBacklinksResponse = {
  /** 現在 page で閲覧可能な backlinks です。 */
  backlinks: DocumentBacklink[]
  /** 次 page がある場合の opaque cursor です。 */
  nextCursor?: string
}

/**
 * Document export format です。
 */
export type DocumentExportFormat = 'markdown' | 'json' | 'svg'

/**
 * Document export renderer の出力です。
 */
export type RenderedDocumentExport = {
  /** Export format です。 */
  format: DocumentExportFormat
  /** HTTP response に設定する MIME type です。 */
  contentType: string
  /** Download 時の安全な file name です。 */
  fileName: string
  /** Render 済み UTF-8 text content です。 */
  content: string
}

/**
 * Authenticated Document export input です。
 */
export type ExportDocumentRequest = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Export 対象 Document ID です。 */
  documentId: string
  /** 現在 viewer の認可 snapshot です。 */
  access: DocumentAccessContext
  /** 出力 format です。 */
  format: DocumentExportFormat
}

/**
 * Element-level optimistic conflict の一件です。
 */
export type DocumentOperationConflictDetail = {
  /** Conflict した operation ID です。 */
  operationId: string
  /** Conflict 対象 element 種別です。 */
  elementType: 'block' | 'object' | 'connector' | 'frame' | 'relation'
  /** Conflict 対象 element ID です。 */
  elementId: string
  /** Element が最後に変更された revision です。 */
  updatedRevision: number
  /** Client が編集を開始した base revision です。 */
  baseRevision: number
}

/**
 * Pure operation reducer に渡す input です。
 */
export type ReduceDocumentOperationsInput = {
  /** Reducer 適用前の canonical Document snapshot です。 */
  document: DocumentDetail
  /** Element ごとの最終更新 revision map です。 */
  elementRevisions: Readonly<Record<string, number>>
  /** Tombstone compaction 後に許可する最古 base revision です。 */
  conflictFloorRevision?: number
  /** Client が編集を開始した revision です。 */
  baseRevision: number
  /** Batch 適用後に割り当てる revision です。 */
  nextRevision: number
  /** 順番どおり適用する operations です。 */
  operations: readonly DocumentOperation[]
}

/**
 * Pure operation reducer の結果です。
 */
export type ReduceDocumentOperationsResult = {
  /** Operations 適用後の canonical Document snapshot です。 */
  document: DocumentDetail
  /** 更新後の element revision map です。 */
  elementRevisions: Record<string, number>
  /** Batch 内で受理した operation IDs です。 */
  appliedOperationIds: string[]
}

/**
 * Documents domain/store が返す安定した error です。
 */
export class DocumentError extends Error {
  /** API response に対応する HTTP status code です。 */
  readonly status: number
  /** Client が分岐に使う安定した error code です。 */
  readonly code: string
  /** Conflict element などの安全な structured details です。 */
  readonly details?: unknown

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DocumentError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * DynamoDB に保存する current Document row です。
 */
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

/**
 * Element conflict 判定に使う operation target です。
 */
type DocumentOperationTarget = {
  /** Element revision map の key です。 */
  key: string
  /** Public conflict detail の element 種別です。 */
  elementType: DocumentOperationConflictDetail['elementType']
  /** Public conflict detail の element ID です。 */
  elementId: string
}

/**
 * Transaction commit に追加する relation diff です。
 */
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

/**
 * Workspace member の manager eligibility を変更する前に検証する Document snapshot です。
 */
export type DocumentManagerLifecycleSnapshot = {
  /** Snapshot と member mutation を直列化する Document ACL generation です。 */
  authorizationRevision: number
  /** 対象 member 以外に active/non-guest manager がいない最初の private Document ID です。 */
  blockingDocumentId?: string
}

/**
 * Work Item delete transaction 用の Document backlink fence request です。
 */
export type PrepareDocumentWorkItemDeletionFenceRequest = {
  /** Work Item を所有する Workspace ID です。 */
  workspaceId: string
  /** Document relation が参照する canonical Work Item target ID です。 */
  workItemId: string
}

/**
 * Work Item delete と backlink add を直列化する transaction item です。
 */
export type DocumentWorkItemDeletionFenceTransactWrite = {
  /** Backlink count が 0 の場合だけ durable tombstone を保存する transaction item です。 */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/**
 * Documents store の公開契約です。
 */
export interface DocumentClient {
  /** 現在の Document ACL generation を consistent read で返します。 */
  getAuthorizationRevision(workspaceId: string): Promise<number>
  /** Member downgrade 前に private Document の manager 継続性を検証します。 */
  getManagerLifecycleSnapshot(
    workspaceId: string,
    memberKey: string,
    eligibleManagerMemberKeys: readonly string[],
  ): Promise<DocumentManagerLifecycleSnapshot>
  /** Work Item delete transaction に Document backlink existence fence を追加します。 */
  prepareWorkItemDeletionFenceTransactWrite(
    request: PrepareDocumentWorkItemDeletionFenceRequest,
  ): Promise<DocumentWorkItemDeletionFenceTransactWrite>
  /** Permission-filtered Document tree を page 取得します。 */
  list(input: ListDocumentsRequest): Promise<DocumentTreeResponse>
  /** 一つの permission-filtered Document detail を取得します。 */
  get(input: GetDocumentRequest): Promise<DocumentDetail>
  /** Workspace search 候補を compact ACL projection で再検証します。 */
  resolveSearchAccess(
    input: ResolveDocumentSearchAccessRequest,
  ): Promise<ResolvedDocumentSearchAccess | undefined>
  /** 新しい Document と revision 1 snapshot を作成します。 */
  create(input: CreateDocumentRequest): Promise<DocumentDetail>
  /** Document metadata を revision 条件付きで更新します。 */
  update(input: UpdateDocumentRequest): Promise<DocumentDetail>
  /** Element-level operations を競合検出と idempotency 付きで適用します。 */
  applyOperations(input: ApplyDocumentOperationsRequest): Promise<ApplyDocumentOperationsResponse>
  /** API validation 前に operation receipts と未確定 operation を解決します。 */
  prepareOperations(
    input: ApplyDocumentOperationsRequest,
  ): Promise<PrepareDocumentOperationsResponse>
  /** Immutable version history を page 取得します。 */
  listVersions(input: ListDocumentVersionsRequest): Promise<DocumentVersionsResponse>
  /** 過去 version snapshot を新しい revision として復元します。 */
  restoreVersion(input: RestoreDocumentVersionRequest): Promise<DocumentDetail>
  /** Favorite または recent preference を保存します。 */
  updatePreference(input: UpdateDocumentPreferenceRequest): Promise<DocumentPreferenceResult>
  /** 現在 user の recent Documents を返します。 */
  listRecent(input: ListRecentDocumentsRequest): Promise<DocumentNode[]>
  /** Document を soft archive します。 */
  archive(input: ChangeDocumentArchiveStateRequest): Promise<DocumentDetail>
  /** Archive 済み Document を tree へ復元します。 */
  restoreArchived(input: ChangeDocumentArchiveStateRequest): Promise<DocumentDetail>
  /** Template snapshot から新しい page を作成します。 */
  instantiateTemplate(input: InstantiateDocumentTemplateRequest): Promise<DocumentDetail>
  /** Root comment または reply を作成します。 */
  createComment(input: CreateDocumentCommentRequest): Promise<StoredDocumentComment>
  /** Comment create の確定済み idempotent replay を検証して返します。 */
  getCommentCreateReplay(
    input: CreateDocumentCommentRequest,
  ): Promise<StoredDocumentComment | undefined>
  /** Document comments を page 取得します。 */
  listComments(input: ListDocumentCommentsRequest): Promise<DocumentCommentsResponse>
  /** Root comment を resolve または reopen します。 */
  resolveComment(input: ResolveDocumentCommentRequest): Promise<StoredDocumentComment>
  /** Presence lease を更新します。 */
  heartbeatPresence(input: HeartbeatDocumentPresenceRequest): Promise<void>
  /** Browser client の presence lease を削除します。 */
  leavePresence(input: DocumentPresenceRequest): Promise<void>
  /** 有効な presence leases を member ごとに返します。 */
  listPresence(input: DocumentPresenceRequest): Promise<StoredDocumentPresence[]>
  /** Expiring public link を作成し raw token を一度だけ返します。 */
  createPublicShare(input: CreateDocumentPublicShareRequest): Promise<CreatedDocumentPublicShare>
  /** Document の public shares を返します。 */
  listPublicShares(input: DocumentPublicShareRequest): Promise<StoredDocumentPublicShare[]>
  /** Public share を revoke します。 */
  revokePublicShare(input: DocumentPublicShareRequest): Promise<StoredDocumentPublicShare>
  /** Raw public token を有効な Document snapshot へ解決します。 */
  resolvePublicShare(token: string): Promise<ResolvedDocumentPublicShare>
  /** Domain target から permission-filtered backlinks を返します。 */
  listBacklinks(input: ListDocumentBacklinksRequest): Promise<DocumentBacklinksResponse>
  /** Document を安全な text format へ export します。 */
  exportDocument(input: ExportDocumentRequest): Promise<RenderedDocumentExport>
}

/**
 * Document operation batch を副作用なしで canonical snapshot へ適用します。
 *
 * Stale base revision でも、変更対象 element が base revision 以降に更新されて
 * いなければ現在 snapshot へ merge します。一件でも競合すると batch 全体を
 * 拒否し、入力 document は変更しません。
 */
export function reduceDocumentOperations(
  input: ReduceDocumentOperationsInput,
): ReduceDocumentOperationsResult {
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1) {
    throw new DocumentError(400, 'InvalidDocumentBaseRevision', 'baseRevision must be a positive integer.')
  }
  if (
    !Number.isSafeInteger(input.nextRevision) ||
    input.nextRevision <= input.document.revision
  ) {
    throw new DocumentError(400, 'InvalidDocumentRevision', 'nextRevision must be newer than the document revision.')
  }
  const conflictFloorRevision =
    input.conflictFloorRevision ?? 1
  if (
    !Number.isSafeInteger(conflictFloorRevision) ||
    conflictFloorRevision < 1
  ) {
    throw new DocumentError(
      500,
      'InvalidDocumentConflictFloor',
      'The stored operation conflict floor is invalid.',
    )
  }
  if (input.baseRevision < conflictFloorRevision) {
    throw new DocumentError(
      409,
      'DocumentOperationHistoryCompacted',
      'The operation base revision is older than retained conflict history.',
      {
        baseRevision: input.baseRevision,
        conflictFloorRevision,
      },
    )
  }
  if (
    !Array.isArray(input.operations) ||
    input.operations.length === 0 ||
    input.operations.length > DOCUMENT_MAX_OPERATION_COUNT
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentOperationCount',
      `operations must contain between 1 and ${DOCUMENT_MAX_OPERATION_COUNT} entries.`,
    )
  }

  const operationIds = new Set<string>()
  for (const operation of input.operations) {
    if (!isObjectLike(operation)) {
      throw invalidPayload('Every document operation must be an object.')
    }
    assertIdentifier(operation.operationId, 'operationId')
    if (operationIds.has(operation.operationId)) {
      throw new DocumentError(
        400,
        'DuplicateDocumentOperationId',
        `operationId "${operation.operationId}" appears more than once in the batch.`,
      )
    }
    operationIds.add(operation.operationId)
  }

  const conflicts: DocumentOperationConflictDetail[] = []
  for (const operation of input.operations) {
    for (const target of getOperationTargets(operation, input.document)) {
      const updatedRevision = input.elementRevisions[target.key] ?? 0
      if (updatedRevision > input.baseRevision) {
        conflicts.push({
          operationId: operation.operationId,
          elementType: target.elementType,
          elementId: target.elementId,
          updatedRevision,
          baseRevision: input.baseRevision,
        })
      }
    }
  }
  if (conflicts.length > 0) {
    throw new DocumentError(
      409,
      'DocumentOperationConflict',
      'One or more document elements changed after the supplied base revision.',
      { conflicts },
    )
  }

  const document = structuredClone(input.document)
  const elementRevisions = { ...input.elementRevisions }
  for (const operation of input.operations) {
    const targets = getOperationTargets(operation, document)
    applyDocumentOperation(document, operation)
    for (const target of targets) {
      elementRevisions[target.key] = input.nextRevision
    }
  }
  document.revision = input.nextRevision
  validateDocumentPayload(document)

  return {
    document,
    elementRevisions,
    appliedOperationIds: input.operations.map(({ operationId }) => operationId),
  }
}

/**
 * Canonical Document snapshot の shape、参照整合性、DynamoDB item size を検証します。
 */
export function validateDocumentPayload(document: DocumentDetail): void {
  if (!isRecord(document)) throw invalidPayload('Document must be an object.')
  assertIdentifier(document.id, 'document.id')
  assertText(document.title, 'document.title', DOCUMENT_MAX_TITLE_LENGTH, false)
  assertIdentifier(document.createdByUserId, 'document.createdByUserId')
  assertIdentifier(document.updatedByUserId, 'document.updatedByUserId')
  assertIsoTimestamp(document.createdAt, 'document.createdAt')
  assertIsoTimestamp(document.updatedAt, 'document.updatedAt')
  if (!Number.isSafeInteger(document.revision) || document.revision < 1) {
    throw new DocumentError(400, 'InvalidDocumentRevision', 'document.revision must be a positive integer.')
  }
  validateScope(document.scope)
  validatePermission(document.permission)
  if (document.parentId !== undefined) assertIdentifier(document.parentId, 'document.parentId')

  if (!Array.isArray(document.relations)) {
    throw invalidPayload('document.relations must be an array.')
  }
  const relationIds = new Set<string>()
  for (const relation of document.relations) {
    validateRelation(relation, document)
    assertUniqueId(relationIds, relation.id, 'relation')
  }

  if (document.kind === 'page' || document.kind === 'template') {
    if (!Array.isArray(document.blocks)) {
      throw invalidPayload('document.blocks must be an array.')
    }
    if (document.blocks.length > DOCUMENT_MAX_BLOCK_COUNT) {
      throw new DocumentError(
        413,
        'DocumentBlockLimitExceeded',
        `A document can contain at most ${DOCUMENT_MAX_BLOCK_COUNT} blocks.`,
      )
    }
    const blockIds = new Set<string>()
    for (const block of document.blocks) {
      validateBlock(block)
      assertUniqueId(blockIds, block.id, 'block')
    }
  } else if (document.kind === 'whiteboard') {
    validateWhiteboard(document.whiteboard)
  } else if (document.kind !== 'folder') {
    throw invalidPayload('document.kind is invalid.')
  }

  const itemBytes = Buffer.byteLength(JSON.stringify(document), 'utf8')
  if (itemBytes > DOCUMENT_MAX_ITEM_BYTES) {
    throw new DocumentError(
      413,
      'DocumentPayloadTooLarge',
      `The document payload is ${itemBytes} bytes; the limit is ${DOCUMENT_MAX_ITEM_BYTES} bytes.`,
      { itemBytes, maxItemBytes: DOCUMENT_MAX_ITEM_BYTES },
    )
  }
  const backlinkCount = document.relations.length +
    (document.kind === 'whiteboard'
      ? document.whiteboard.objects.filter(({ type }) => type === 'work-item').length
      : 0)
  if (backlinkCount > DOCUMENT_MAX_BACKLINK_COUNT) {
    throw new DocumentError(
      413,
      'DocumentBacklinkLimitExceeded',
      `A document can index at most ${DOCUMENT_MAX_BACKLINK_COUNT} backlinks.`,
    )
  }
}

/**
 * Canonical Document snapshot を Markdown、JSON、SVG の安全な text artifact へ描画します。
 */
export function renderDocumentExport(
  document: DocumentDetail,
  format: DocumentExportFormat,
): RenderedDocumentExport {
  validateDocumentPayload(document)
  return renderDocumentArtifact(
    document,
    format,
    document.id,
  )
}

/**
 * Public-safe Document projection を metadata を再導入せず text artifact へ描画します。
 */
export function renderPublicDocumentExport(
  document: PublicDocument,
  format: DocumentExportFormat,
): RenderedDocumentExport {
  return renderDocumentArtifact(
    document,
    format,
    'document',
  )
}

function renderDocumentArtifact(
  document: DocumentDetail | PublicDocument,
  format: DocumentExportFormat,
  fallbackFileName: string,
): RenderedDocumentExport {
  const safeBaseName = sanitizeFileName(
    document.title || fallbackFileName,
  )
  if (format === 'json') {
    return {
      format,
      contentType: 'application/json; charset=utf-8',
      fileName: `${safeBaseName}.json`,
      content: `${JSON.stringify(document, null, 2)}\n`,
    }
  }
  if (format === 'svg') {
    if (document.kind !== 'whiteboard') {
      throw new DocumentError(400, 'UnsupportedDocumentExport', 'SVG export is only available for whiteboards.')
    }
    return {
      format,
      contentType: 'image/svg+xml; charset=utf-8',
      fileName: `${safeBaseName}.svg`,
      content: renderWhiteboardSvg(document),
    }
  }
  if (document.kind !== 'page' && document.kind !== 'template') {
    throw new DocumentError(
      400,
      'UnsupportedDocumentExport',
      `${format.toUpperCase()} export is only available for pages and templates.`,
    )
  }
  if (format === 'markdown') {
    return {
      format,
      contentType: 'text/markdown; charset=utf-8',
      fileName: `${safeBaseName}.md`,
      content: renderMarkdown(document.title, document.blocks),
    }
  }
  throw new DocumentError(400, 'UnsupportedDocumentExport', `Unsupported export format: ${String(format)}.`)
}

function getOperationTargets(
  operation: DocumentOperation,
  document: DocumentDetail,
): DocumentOperationTarget[] {
  switch (operation.type) {
    case 'insert-block':
      return [elementTarget('block', operation.block.id)]
    case 'update-block':
    case 'move-block':
      return [elementTarget('block', operation.blockId)]
    case 'delete-block':
      return [
        elementTarget('block', operation.blockId),
        ...document.relations
          .filter(
            ({ source }) =>
              source.kind === 'block' && source.blockId === operation.blockId,
          )
          .map(({ id }) => elementTarget('relation', id)),
      ]
    case 'insert-object':
      return [elementTarget('object', operation.object.id)]
    case 'update-object':
      return [elementTarget('object', operation.objectId)]
    case 'delete-object': {
      const targets = [elementTarget('object', operation.objectId)]
      if (document.kind !== 'whiteboard') return targets
      for (const connector of document.whiteboard.connectors) {
        if (
          connector.from.objectId === operation.objectId ||
          connector.to.objectId === operation.objectId
        ) {
          targets.push(elementTarget('connector', connector.id))
        }
      }
      for (const frame of document.whiteboard.frames) {
        if (frame.objectIds.includes(operation.objectId)) {
          targets.push(elementTarget('frame', frame.id))
        }
      }
      for (const relation of document.relations) {
        if (
          relation.source.kind === 'whiteboard-object' &&
          relation.source.objectId === operation.objectId
        ) {
          targets.push(elementTarget('relation', relation.id))
        }
      }
      return targets
    }
    case 'upsert-connector':
      return [elementTarget('connector', operation.connector.id)]
    case 'delete-connector':
      return [elementTarget('connector', operation.connectorId)]
    case 'upsert-frame':
      return [elementTarget('frame', operation.frame.id)]
    case 'delete-frame':
      return [elementTarget('frame', operation.frameId)]
    case 'upsert-relation':
      return [elementTarget('relation', operation.relation.id)]
    case 'delete-relation':
      return [elementTarget('relation', operation.relationId)]
    default:
      throw invalidPayload('Document operation type is invalid.')
  }
}

function elementTarget(
  elementType: DocumentOperationConflictDetail['elementType'],
  elementId: string,
): DocumentOperationTarget {
  return { key: `${elementType}:${elementId}`, elementType, elementId }
}

function applyDocumentOperation(document: DocumentDetail, operation: DocumentOperation): void {
  switch (operation.type) {
    case 'insert-block': {
      const blocks = requireBlocks(document)
      validateBlock(operation.block)
      assertIndex(operation.index, blocks.length, true)
      if (blocks.some(({ id }) => id === operation.block.id)) {
        throw new DocumentError(409, 'DocumentElementAlreadyExists', `Block "${operation.block.id}" already exists.`)
      }
      blocks.splice(operation.index, 0, structuredClone(operation.block))
      return
    }
    case 'update-block': {
      const blocks = requireBlocks(document)
      validateBlock(operation.block)
      if (operation.block.id !== operation.blockId) {
        throw new DocumentError(400, 'DocumentElementIdMismatch', 'block.id must match blockId.')
      }
      const index = findElementIndex(blocks, operation.blockId, 'block')
      blocks[index] = structuredClone(operation.block)
      return
    }
    case 'move-block': {
      const blocks = requireBlocks(document)
      assertIndex(operation.index, blocks.length, false)
      const index = findElementIndex(blocks, operation.blockId, 'block')
      const [block] = blocks.splice(index, 1)
      if (block === undefined) throw new DocumentError(404, 'DocumentElementNotFound', 'Block was not found.')
      blocks.splice(operation.index, 0, block)
      return
    }
    case 'delete-block': {
      const blocks = requireBlocks(document)
      const index = findElementIndex(blocks, operation.blockId, 'block')
      blocks.splice(index, 1)
      document.relations = document.relations.filter(
        ({ source }) => source.kind !== 'block' || source.blockId !== operation.blockId,
      )
      return
    }
    case 'insert-object': {
      const whiteboard = requireWhiteboard(document)
      validateWhiteboardObject(operation.object)
      if (whiteboard.objects.some(({ id }) => id === operation.object.id)) {
        throw new DocumentError(409, 'DocumentElementAlreadyExists', `Object "${operation.object.id}" already exists.`)
      }
      whiteboard.objects.push(structuredClone(operation.object))
      return
    }
    case 'update-object': {
      const whiteboard = requireWhiteboard(document)
      validateWhiteboardObject(operation.object)
      if (operation.object.id !== operation.objectId) {
        throw new DocumentError(400, 'DocumentElementIdMismatch', 'object.id must match objectId.')
      }
      const index = findElementIndex(whiteboard.objects, operation.objectId, 'object')
      whiteboard.objects[index] = structuredClone(operation.object)
      return
    }
    case 'delete-object': {
      const whiteboard = requireWhiteboard(document)
      const index = findElementIndex(whiteboard.objects, operation.objectId, 'object')
      whiteboard.objects.splice(index, 1)
      whiteboard.connectors = whiteboard.connectors.filter(
        ({ from, to }) => from.objectId !== operation.objectId && to.objectId !== operation.objectId,
      )
      whiteboard.frames = whiteboard.frames.map((frame) => ({
        ...frame,
        objectIds: frame.objectIds.filter((id) => id !== operation.objectId),
      }))
      document.relations = document.relations.filter(
        ({ source }) =>
          source.kind !== 'whiteboard-object' || source.objectId !== operation.objectId,
      )
      return
    }
    case 'upsert-connector': {
      const whiteboard = requireWhiteboard(document)
      validateConnector(operation.connector, new Set(whiteboard.objects.map(({ id }) => id)))
      upsertById(whiteboard.connectors, operation.connector)
      return
    }
    case 'delete-connector': {
      const whiteboard = requireWhiteboard(document)
      whiteboard.connectors.splice(
        findElementIndex(whiteboard.connectors, operation.connectorId, 'connector'),
        1,
      )
      return
    }
    case 'upsert-frame': {
      const whiteboard = requireWhiteboard(document)
      validateFrame(operation.frame, new Set(whiteboard.objects.map(({ id }) => id)))
      upsertById(whiteboard.frames, operation.frame)
      return
    }
    case 'delete-frame': {
      const whiteboard = requireWhiteboard(document)
      whiteboard.frames.splice(findElementIndex(whiteboard.frames, operation.frameId, 'frame'), 1)
      return
    }
    case 'upsert-relation':
      validateRelation(operation.relation, document)
      upsertById(document.relations, operation.relation)
      return
    case 'delete-relation':
      document.relations.splice(
        findElementIndex(document.relations, operation.relationId, 'relation'),
        1,
      )
      return
    default:
      throw invalidPayload('Document operation type is invalid.')
  }
}

function requireBlocks(document: DocumentDetail): DocumentBlock[] {
  if (document.kind !== 'page' && document.kind !== 'template') {
    throw new DocumentError(400, 'InvalidDocumentOperation', 'Block operations require a page or template.')
  }
  return document.blocks
}

function requireWhiteboard(document: DocumentDetail): WhiteboardContent {
  if (document.kind !== 'whiteboard') {
    throw new DocumentError(400, 'InvalidDocumentOperation', 'Whiteboard operations require a whiteboard.')
  }
  return document.whiteboard
}

function findElementIndex<T extends { id: string }>(
  values: readonly T[],
  id: string,
  type: string,
): number {
  assertIdentifier(id, `${type}Id`)
  const index = values.findIndex((value) => value.id === id)
  if (index < 0) {
    throw new DocumentError(404, 'DocumentElementNotFound', `${capitalize(type)} "${id}" was not found.`)
  }
  return index
}

function upsertById<T extends { id: string }>(values: T[], value: T): void {
  const index = values.findIndex(({ id }) => id === value.id)
  if (index < 0) values.push(structuredClone(value))
  else values[index] = structuredClone(value)
}

function validateScope(scope: DocumentScope): void {
  if (!isRecord(scope) || (scope.type !== 'workspace' && scope.type !== 'project')) {
    throw invalidPayload('Document scope is invalid.')
  }
  if (scope.type === 'project') assertIdentifier(scope.projectId, 'scope.projectId')
}

function validatePermission(
  permission: DocumentPermission,
  requirePrivateManager = true,
): void {
  if (!isRecord(permission) || (permission.mode !== 'inherit' && permission.mode !== 'private')) {
    throw new DocumentError(400, 'InvalidDocumentPermission', 'Document permission mode is invalid.')
  }
  if (!Array.isArray(permission.memberGrants)) {
    throw new DocumentError(400, 'InvalidDocumentPermission', 'Document member grants must be an array.')
  }
  const members = new Set<string>()
  for (const grant of permission.memberGrants) {
    if (!isRecord(grant)) {
      throw new DocumentError(400, 'InvalidDocumentPermission', 'Document member grant is invalid.')
    }
    assertIdentifier(grant.memberKey, 'permission.memberGrants.memberKey')
    if (grant.role !== 'viewer' && grant.role !== 'editor' && grant.role !== 'manager') {
      throw new DocumentError(400, 'InvalidDocumentPermission', 'Document grant role is invalid.')
    }
    assertUniqueId(members, grant.memberKey, 'member grant')
  }
  if (
    requirePrivateManager &&
    permission.mode === 'private' &&
    !permission.memberGrants.some(({ role }) => role === 'manager')
  ) {
    throw new DocumentError(
      400,
      'DocumentPrivateManagerRequired',
      'Private documents must retain at least one manager grant.',
    )
  }
}

function ensureManagerGrant(
  permission: DocumentPermission,
  memberKey: string,
): DocumentPermission {
  const memberGrants = permission.memberGrants.filter(
    (grant) => grant.memberKey !== memberKey,
  )
  return {
    ...structuredClone(permission),
    memberGrants: [
      ...memberGrants,
      { memberKey, role: 'manager' },
    ],
  }
}

function normalizePermissionForActor(
  permission: DocumentPermission,
  memberKey: string,
): DocumentPermission {
  validatePermission(permission, false)
  const normalized = permission.mode === 'private'
    ? ensureManagerGrant(permission, memberKey)
    : structuredClone(permission)
  validatePermission(normalized)
  return normalized
}

function validateBlock(block: DocumentBlock): void {
  if (
    !isRecord(block) ||
    !['paragraph', 'heading', 'table', 'code', 'checklist', 'embed', 'diagram']
      .includes(String(block.type))
  ) {
    throw invalidPayload('Document block is invalid.')
  }
  assertIdentifier(block.id, 'block.id')
  switch (block.type) {
    case 'paragraph':
      assertText(block.text, 'block.text', DOCUMENT_MAX_TEXT_LENGTH, true)
      return
    case 'heading':
      assertText(block.text, 'block.text', DOCUMENT_MAX_TEXT_LENGTH, true)
      if (![1, 2, 3].includes(block.level)) {
        throw new DocumentError(400, 'InvalidDocumentBlock', 'Heading level must be 1, 2, or 3.')
      }
      return
    case 'table':
      if (!Array.isArray(block.columns) || !Array.isArray(block.rows)) {
        throw invalidPayload('Table columns and rows must be arrays.')
      }
      if (block.columns.length > DOCUMENT_MAX_TABLE_COLUMNS) {
        throw new DocumentError(413, 'DocumentTableLimitExceeded', 'Table column limit exceeded.')
      }
      if (block.rows.length > DOCUMENT_MAX_TABLE_ROWS) {
        throw new DocumentError(413, 'DocumentTableLimitExceeded', 'Table row limit exceeded.')
      }
      block.columns.forEach((column) =>
        assertText(column, 'block.columns[]', DOCUMENT_MAX_TEXT_LENGTH, true),
      )
      for (const row of block.rows) {
        if (!isRecord(row) || !Array.isArray(row.cells)) {
          throw invalidPayload('Table row is invalid.')
        }
        assertIdentifier(row.id, 'block.rows[].id')
        if (row.cells.length !== block.columns.length) {
          throw new DocumentError(400, 'InvalidDocumentTable', 'Every table row must match the column count.')
        }
        for (const cell of row.cells) {
          if (!isRecord(cell)) throw invalidPayload('Table cell is invalid.')
          assertIdentifier(cell.id, 'block.rows[].cells[].id')
          assertText(cell.text, 'block.rows[].cells[].text', DOCUMENT_MAX_TEXT_LENGTH, true)
        }
      }
      return
    case 'code':
      assertText(block.code, 'block.code', DOCUMENT_MAX_TEXT_LENGTH, true)
      if (block.language !== undefined) {
        assertCodeFenceInfoString(
          block.language,
          'block.language',
        )
      }
      return
    case 'checklist': {
      if (!Array.isArray(block.items)) {
        throw invalidPayload('Checklist items must be an array.')
      }
      const itemIds = new Set<string>()
      for (const item of block.items) {
        if (!isRecord(item)) throw invalidPayload('Checklist item is invalid.')
        assertIdentifier(item.id, 'block.items[].id')
        assertUniqueId(itemIds, item.id, 'checklist item')
        assertText(item.text, 'block.items[].text', DOCUMENT_MAX_TEXT_LENGTH, true)
        if (typeof item.checked !== 'boolean') {
          throw new DocumentError(
            400,
            'InvalidDocumentBlock',
            'Checklist item checked must be a boolean.',
          )
        }
        if (item.assigneeMemberKey !== undefined) {
          assertIdentifier(item.assigneeMemberKey, 'block.items[].assigneeMemberKey')
        }
      }
      return
    }
    case 'embed':
      assertSafeUrl(block.url, 'block.url')
      if (block.title !== undefined) assertText(block.title, 'block.title', DOCUMENT_MAX_TITLE_LENGTH, true)
      if (block.provider !== undefined) assertText(block.provider, 'block.provider', 100, true)
      return
    case 'diagram':
      if (block.format !== 'mermaid' && block.format !== 'text') {
        throw new DocumentError(
          400,
          'InvalidDocumentBlock',
          'Diagram format must be mermaid or text.',
        )
      }
      assertText(block.source, 'block.source', DOCUMENT_MAX_TEXT_LENGTH, true)
      return
    default:
      throw invalidPayload('Document block type is invalid.')
  }
}

function validateWhiteboard(whiteboard: WhiteboardContent): void {
  if (
    !isRecord(whiteboard) ||
    !Array.isArray(whiteboard.objects) ||
    !Array.isArray(whiteboard.connectors) ||
    !Array.isArray(whiteboard.frames)
  ) {
    throw invalidPayload('Whiteboard content is invalid.')
  }
  if (whiteboard.objects.length > DOCUMENT_MAX_WHITEBOARD_OBJECT_COUNT) {
    throw new DocumentError(413, 'WhiteboardObjectLimitExceeded', 'Whiteboard object limit exceeded.')
  }
  if (whiteboard.connectors.length > DOCUMENT_MAX_WHITEBOARD_CONNECTOR_COUNT) {
    throw new DocumentError(413, 'WhiteboardConnectorLimitExceeded', 'Whiteboard connector limit exceeded.')
  }
  if (whiteboard.frames.length > DOCUMENT_MAX_WHITEBOARD_FRAME_COUNT) {
    throw new DocumentError(413, 'WhiteboardFrameLimitExceeded', 'Whiteboard frame limit exceeded.')
  }
  const objectIds = new Set<string>()
  for (const object of whiteboard.objects) {
    validateWhiteboardObject(object)
    assertUniqueId(objectIds, object.id, 'whiteboard object')
  }
  const connectorIds = new Set<string>()
  for (const connector of whiteboard.connectors) {
    validateConnector(connector, objectIds)
    assertUniqueId(connectorIds, connector.id, 'whiteboard connector')
  }
  const frameIds = new Set<string>()
  for (const frame of whiteboard.frames) {
    validateFrame(frame, objectIds)
    assertUniqueId(frameIds, frame.id, 'whiteboard frame')
  }
}

function validateWhiteboardObject(object: WhiteboardObject): void {
  if (
    !isRecord(object) ||
    !['note', 'shape', 'text', 'work-item'].includes(String(object.type))
  ) {
    throw invalidPayload('Whiteboard object is invalid.')
  }
  assertIdentifier(object.id, 'whiteboard.object.id')
  validateBounds(object.bounds)
  if (!Number.isSafeInteger(object.zIndex)) {
    throw new DocumentError(400, 'InvalidWhiteboardObject', 'Whiteboard object zIndex must be an integer.')
  }
  if (object.type === 'note' || object.type === 'text') {
    assertText(object.text, 'whiteboard.object.text', DOCUMENT_MAX_TEXT_LENGTH, true)
  } else if (object.type === 'shape') {
    if (
      object.shape !== 'rectangle' &&
      object.shape !== 'ellipse' &&
      object.shape !== 'diamond' &&
      object.shape !== 'triangle'
    ) {
      throw new DocumentError(
        400,
        'InvalidWhiteboardObject',
        'Whiteboard shape is invalid.',
      )
    }
    if (object.text !== undefined) {
      assertText(
        object.text,
        'whiteboard.object.text',
        DOCUMENT_MAX_TEXT_LENGTH,
        true,
      )
    }
  } else if (object.type === 'work-item') {
    assertCanonicalWorkItemId(
      object.workItemId,
      'whiteboard.object.workItemId',
    )
  }
  if (object.style !== undefined && !isRecord(object.style)) {
    throw invalidPayload('Whiteboard object style is invalid.')
  }
  if (object.style !== undefined) {
    for (const color of [object.style.fill, object.style.stroke, object.style.textColor]) {
      if (color !== undefined && !isSafeCssColor(color)) {
        throw new DocumentError(400, 'InvalidWhiteboardColor', 'Whiteboard colors must use a safe CSS color value.')
      }
    }
  }
}

function validateConnector(connector: WhiteboardConnector, objectIds: ReadonlySet<string>): void {
  if (
    !isRecord(connector) ||
    !isRecord(connector.from) ||
    !isRecord(connector.to)
  ) {
    throw invalidPayload('Whiteboard connector is invalid.')
  }
  assertIdentifier(connector.id, 'whiteboard.connector.id')
  for (const endpoint of [connector.from, connector.to]) {
    assertIdentifier(endpoint.objectId, 'whiteboard.connector.objectId')
    if (
      endpoint.anchor !== undefined &&
      endpoint.anchor !== 'top' &&
      endpoint.anchor !== 'right' &&
      endpoint.anchor !== 'bottom' &&
      endpoint.anchor !== 'left' &&
      endpoint.anchor !== 'center'
    ) {
      throw new DocumentError(
        400,
        'InvalidWhiteboardConnector',
        'Whiteboard connector anchor is invalid.',
      )
    }
    if (!objectIds.has(endpoint.objectId)) {
      throw new DocumentError(
        400,
        'InvalidWhiteboardReference',
        `Connector "${connector.id}" references a missing object.`,
      )
    }
  }
  if (connector.label !== undefined) {
    assertText(connector.label, 'whiteboard.connector.label', DOCUMENT_MAX_TEXT_LENGTH, true)
  }
  if (
    connector.lineStyle !== undefined &&
    connector.lineStyle !== 'solid' &&
    connector.lineStyle !== 'dashed'
  ) {
    throw new DocumentError(
      400,
      'InvalidWhiteboardConnector',
      'Whiteboard connector lineStyle is invalid.',
    )
  }
}

function validateFrame(frame: WhiteboardFrame, objectIds: ReadonlySet<string>): void {
  if (!isRecord(frame) || !Array.isArray(frame.objectIds)) {
    throw invalidPayload('Whiteboard frame is invalid.')
  }
  assertIdentifier(frame.id, 'whiteboard.frame.id')
  assertText(frame.title, 'whiteboard.frame.title', DOCUMENT_MAX_TITLE_LENGTH, true)
  validateBounds(frame.bounds)
  const members = new Set<string>()
  for (const objectId of frame.objectIds) {
    assertIdentifier(objectId, 'whiteboard.frame.objectIds[]')
    if (!objectIds.has(objectId)) {
      throw new DocumentError(
        400,
        'InvalidWhiteboardReference',
        `Frame "${frame.id}" references a missing object.`,
      )
    }
    assertUniqueId(members, objectId, 'frame object')
  }
}

function validateBounds(bounds: WhiteboardObject['bounds']): void {
  if (!isRecord(bounds)) throw invalidPayload('Whiteboard bounds are invalid.')
  if (
    Object.keys(bounds).some(
      (field) =>
        !WHITEBOARD_BOUND_FIELDS.has(field),
    )
  ) {
    throw new DocumentError(
      400,
      'InvalidWhiteboardBounds',
      'Whiteboard bounds contain an unsupported field.',
    )
  }
  for (const name of ['x', 'y', 'width', 'height'] as const) {
    const value = bounds[name]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new DocumentError(400, 'InvalidWhiteboardBounds', `${name} must be a finite number.`)
    }
  }
  if (
    bounds.rotation !== undefined &&
    (
      typeof bounds.rotation !== 'number' ||
      !Number.isFinite(bounds.rotation)
    )
  ) {
    throw new DocumentError(
      400,
      'InvalidWhiteboardBounds',
      'rotation must be a finite number.',
    )
  }
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new DocumentError(400, 'InvalidWhiteboardBounds', 'Whiteboard width and height must be positive.')
  }
}

function validateRelation(relation: DocumentRelation, document: DocumentDetail): void {
  if (
    !isRecord(relation) ||
    !isRecord(relation.source) ||
    !isRecord(relation.target) ||
    !['document', 'block', 'whiteboard-object'].includes(String(relation.source.kind)) ||
    !['work-item', 'project', 'goal'].includes(String(relation.target.kind))
  ) {
    throw invalidPayload('Document relation is invalid.')
  }
  assertIdentifier(relation.id, 'relation.id')
  if (relation.id.startsWith('system:whiteboard-work-item:')) {
    throw new DocumentError(
      400,
      'InvalidDocumentRelation',
      'The relation ID uses a reserved namespace.',
    )
  }
  assertIdentifier(relation.createdByUserId, 'relation.createdByUserId')
  assertIsoTimestamp(relation.createdAt, 'relation.createdAt')
  if (relation.source.kind === 'block') {
    const blockId = relation.source.blockId
    const blocks = document.kind === 'page' || document.kind === 'template' ? document.blocks : []
    if (!blocks.some(({ id }) => id === blockId)) {
      throw new DocumentError(400, 'InvalidDocumentRelation', 'Relation references a missing block.')
    }
  } else if (relation.source.kind === 'whiteboard-object') {
    const objectId = relation.source.objectId
    const objects = document.kind === 'whiteboard' ? document.whiteboard.objects : []
    if (!objects.some(({ id }) => id === objectId)) {
      throw new DocumentError(400, 'InvalidDocumentRelation', 'Relation references a missing whiteboard object.')
    }
  }
  if (relation.target.kind === 'work-item') {
    assertCanonicalWorkItemId(
      relation.target.workItemId,
      'relation.target.id',
    )
  } else {
    assertIdentifier(relationTargetId(relation), 'relation.target.id')
  }
}

function assertCanonicalWorkItemId(
  value: string,
  fieldName: string,
): void {
  assertIdentifier(value, fieldName)
  const parts = value.split('/')
  if (
    parts.length !== 4 ||
    parts[0] !== 'team' ||
    !parts[1] ||
    parts[2] !== 'issue' ||
    !parts[3]
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentRelationTarget',
      `${fieldName} must use team/<teamId>/issue/<issueId>.`,
    )
  }
}

function renderMarkdown(title: string, blocks: readonly DocumentBlock[]): string {
  const parts = [`# ${escapeMarkdownText(title)}`]
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
        parts.push(escapeMarkdownText(block.text))
        break
      case 'heading':
        parts.push(`${'#'.repeat(block.level + 1)} ${escapeMarkdownText(block.text)}`)
        break
      case 'table': {
        parts.push(
          `| ${block.columns.map(escapeMarkdownTableCell).join(' | ')} |`,
          `| ${block.columns.map(() => '---').join(' | ')} |`,
          ...block.rows.map(
            (row) => `| ${row.cells.map(({ text }) => escapeMarkdownTableCell(text)).join(' | ')} |`,
          ),
        )
        break
      }
      case 'code':
        parts.push(
          renderMarkdownCodeFence(
            block.code,
            block.language,
          ),
        )
        break
      case 'checklist':
        parts.push(
          block.items
            .map((item) => `- [${item.checked ? 'x' : ' '}] ${escapeMarkdownText(item.text)}`)
            .join('\n'),
        )
        break
      case 'embed':
        parts.push(`[${escapeMarkdownText(block.title ?? block.url)}](${escapeMarkdownUrl(block.url)})`)
        break
      case 'diagram':
        parts.push(
          renderMarkdownCodeFence(
            block.source,
            block.format,
          ),
        )
    }
  }
  return `${parts.join('\n\n')}\n`
}

function renderMarkdownCodeFence(
  source: string,
  infoString?: string,
): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...source.matchAll(/`+/gu)].map(
      ([run]) => run.length,
    ),
  )
  const fence = '`'.repeat(
    Math.max(3, longestBacktickRun + 1),
  )
  const safeInfoString =
    infoString !== undefined &&
      isSafeCodeFenceInfoString(infoString)
      ? infoString
      : ''
  return `${fence}${safeInfoString}\n${source}\n${fence}`
}

function renderWhiteboardSvg(
  document:
    | Extract<DocumentDetail, { kind: 'whiteboard' }>
    | Extract<PublicDocument, { kind: 'whiteboard' }>,
): string {
  const bounds = [
    ...document.whiteboard.objects.map((object) => object.bounds),
    ...document.whiteboard.frames.map((frame) => frame.bounds),
  ]
  const xValues = bounds.flatMap((value) => [value.x, value.x + value.width])
  const yValues = bounds.flatMap((value) => [value.y, value.y + value.height])
  const minX = xValues.length > 0 ? Math.min(...xValues) : 0
  const minY = yValues.length > 0 ? Math.min(...yValues) : 0
  const maxX = xValues.length > 0 ? Math.max(...xValues) : 1024
  const maxY = yValues.length > 0 ? Math.max(...yValues) : 768
  const objectMap = new Map(document.whiteboard.objects.map((object) => [object.id, object]))
  const connectors = document.whiteboard.connectors.map((connector) => {
    const from = objectMap.get(connector.from.objectId)
    const to = objectMap.get(connector.to.objectId)
    if (from === undefined || to === undefined) return ''
    const fromX = from.bounds.x + from.bounds.width / 2
    const fromY = from.bounds.y + from.bounds.height / 2
    const toX = to.bounds.x + to.bounds.width / 2
    const toY = to.bounds.y + to.bounds.height / 2
    return `<g><line x1="${fromX}" y1="${fromY}" x2="${toX}" y2="${toY}" stroke="#64748b"${connector.lineStyle === 'dashed' ? ' stroke-dasharray="8 6"' : ''}/>${connector.label ? `<text x="${(fromX + toX) / 2}" y="${(fromY + toY) / 2}" text-anchor="middle">${escapeXml(connector.label)}</text>` : ''}</g>`
  }).join('')
  const frames = document.whiteboard.frames.map((frame) =>
    `<g><rect x="${frame.bounds.x}" y="${frame.bounds.y}" width="${frame.bounds.width}" height="${frame.bounds.height}" fill="none" stroke="#94a3b8" stroke-dasharray="6 4"/><text x="${frame.bounds.x + 8}" y="${frame.bounds.y + 20}">${escapeXml(frame.title)}</text></g>`,
  ).join('')
  const objects = [...document.whiteboard.objects].sort((a, b) => a.zIndex - b.zIndex).map((object) => {
    const fill = safeSvgColor(object.style?.fill, object.type === 'note' ? '#fef08a' : '#ffffff')
    const stroke = safeSvgColor(object.style?.stroke, '#334155')
    const textColor = safeSvgColor(object.style?.textColor, '#0f172a')
    const transform = object.bounds.rotation
      ? ` transform="rotate(${object.bounds.rotation} ${object.bounds.x + object.bounds.width / 2} ${object.bounds.y + object.bounds.height / 2})"`
      : ''
    const shape = object.type === 'shape' && object.shape === 'ellipse'
      ? `<ellipse cx="${object.bounds.x + object.bounds.width / 2}" cy="${object.bounds.y + object.bounds.height / 2}" rx="${object.bounds.width / 2}" ry="${object.bounds.height / 2}" fill="${fill}" stroke="${stroke}"/>`
      : `<rect x="${object.bounds.x}" y="${object.bounds.y}" width="${object.bounds.width}" height="${object.bounds.height}" rx="${object.type === 'note' ? 6 : 2}" fill="${fill}" stroke="${stroke}"/>`
    const label = object.type === 'work-item'
      ? 'workItemId' in object
        ? `Work item: ${object.workItemId}`
        : 'Work item'
      : object.type === 'shape'
        ? object.text ?? ''
        : object.text
    return `<g${transform}>${shape}<text x="${object.bounds.x + 10}" y="${object.bounds.y + 24}" fill="${textColor}">${escapeXml(label)}</text></g>`
  }).join('')
  const width = Math.max(1, maxX - minX + 40)
  const height = Math.max(1, maxY - minY + 40)
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(document.title)}" viewBox="${minX - 20} ${minY - 20} ${width} ${height}"><rect x="${minX - 20}" y="${minY - 20}" width="${width}" height="${height}" fill="#ffffff"/>${frames}${connectors}${objects}</svg>\n`
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
export class DynamoDbDocumentsClient implements DocumentClient {
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
  /** 同時初期化を一つへ束縛する promise です。 */
  private ensureTablePromise?: Promise<void>

  constructor(options: DynamoDbDocumentsClientOptions = {}) {
    this.tableName =
      options.tableName ??
      process.env.DOCUMENTS_TABLE_NAME ??
      process.env.MUKUROJI_DOCUMENTS_TABLE ??
      'mukuroji-documents-local'
    this.dynamoClient = options.dynamoClient ?? (
      options.documentClient === undefined ? new DynamoDBClient({}) : undefined
    )
    this.client =
      options.documentClient ??
      DynamoDBDocumentClient.from(this.dynamoClient ?? new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      })
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
    assertCanonicalWorkItemId(
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
    await this.ensureTable()
    if (
      !isRecord(input) ||
      !['folder', 'page', 'template', 'whiteboard'].includes(String(input.kind))
    ) {
      throw invalidPayload('Document create input is invalid.')
    }
    assertIdentifier(input.workspaceId, 'workspaceId')
    assertText(input.title, 'title', DOCUMENT_MAX_TITLE_LENGTH, false)
    validateScope(input.scope)
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
    const permission = normalizePermissionForActor(
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
        input.access.authorizationGuards,
        input.relationTargetAuthorizationGuards,
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
      : normalizePermissionForActor(input.permission, input.access.memberKey)
    if (input.scope !== undefined) validateScope(input.scope)
    if (input.permission !== undefined) {
      requireCapability(
        capabilities.canManagePermissions,
        'DocumentPermissionDenied',
      )
      validatePermission(normalizedPermission ?? input.permission)
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
    validateScope(nextScope)
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
        input.access.authorizationGuards,
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
          input.access.authorizationGuards,
          input.relationTargetAuthorizationGuards,
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
        if (isConditionalFailure(error)) {
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
    const relationTargetAuthorizationGuards =
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
        input.access.authorizationGuards,
        relationTargetAuthorizationGuards,
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
        input.access.authorizationGuards,
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
        if (isConditionalFailure(error)) {
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
        input.access.authorizationGuards,
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
        input.access.authorizationGuards,
        input.relationTargetAuthorizationGuards,
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
    const permission = normalizePermissionForActor(
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
    return this.create({
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
        input.access.authorizationGuards,
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
        input.access.authorizationGuards,
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
        input.access.authorizationGuards,
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
        input.access.authorizationGuards,
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
      requireAuthorizationGuards(input.access)
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
        if (!isConditionalFailure(error)) {
          throw normalizeDynamoError(error)
        }
        await this.verifyAuthorizationGuard(
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
          const stored = existing.Item as
            | StoredDocumentShareItem
            | undefined
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
          stripShareStorageFields,
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
    const stored = result.Item as StoredDocumentShareItem | undefined
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
          ...(input.access.authorizationGuards === undefined
            ? []
            : input.access.authorizationGuards.map(
                (guard) =>
                  authorizationGuardConditionCheck(
                    validateAuthorizationGuard(
                      guard,
                    ),
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
          input.access.authorizationGuards !==
          undefined
        ) {
          await this.verifyAuthorizationGuard(
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
        if (
          latest.Item !== undefined &&
          (
            latest.Item as StoredDocumentShareItem
          ).revokedAt !== undefined
        ) {
          return stripShareStorageFields(
            latest.Item,
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
    const lookup = lookupResult.Item as StoredPublicLinkItem | undefined
    if (lookup === undefined || isExpired(lookup.expiresAt, this.now())) throw publicShareNotFound()
    const shareResult = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: lookup.targetWorkspaceId,
        recordKey: shareKey(lookup.documentId, lookup.shareId),
      },
      ConsistentRead: true,
    }))
    const storedShare = shareResult.Item as StoredDocumentShareItem | undefined
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
    return renderDocumentArtifact(
      projected,
      input.format,
      projected.id,
    )
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
    let read = context?.rows.get(cacheKey)
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
      context?.rows.set(cacheKey, read)
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
    access: DocumentAccessContext,
  ): Promise<void> {
    const guards =
      requireAuthorizationGuards(access)
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
      | readonly DocumentAuthorizationGenerationGuard[]
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
    const receipt =
      result.Item as
        | StoredOperationReceipt
        | undefined
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
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': `VERSION#${documentId}#`,
        },
        ConsistentRead: true,
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
    mutationAuthorizationGuards?: readonly DocumentAuthorizationGenerationGuard[],
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

function assertCodeFenceInfoString(
  value: string,
  field: string,
): void {
  if (
    typeof value !== 'string' ||
    !isSafeCodeFenceInfoString(value)
  ) {
    throw new DocumentError(
      400,
      'InvalidDocumentCodeLanguage',
      `${field} must be a single safe language identifier.`,
    )
  }
}

function isSafeCodeFenceInfoString(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,99}$/u.test(value)
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

function assertUniqueId(values: Set<string>, id: string, type: string): void {
  if (values.has(id)) {
    throw new DocumentError(400, 'DuplicateDocumentElementId', `Duplicate ${type} ID "${id}".`)
  }
  values.add(id)
}

function assertIndex(index: number, length: number, allowEnd: boolean): void {
  const maximum = allowEnd ? length : Math.max(0, length - 1)
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
    throw new DocumentError(400, 'InvalidDocumentElementIndex', 'The element index is out of range.')
  }
}

function assertSafeUrl(value: string, field: string): void {
  assertText(value, field, 4_096, false)
  if (value.startsWith('/')) return
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsafe scheme')
  } catch {
    throw new DocumentError(400, 'InvalidDocumentUrl', `${field} must be an HTTP(S) or application-relative URL.`)
  }
}

function isSafeCssColor(value: string): boolean {
  return (
    /^#[\da-f]{3,8}$/iu.test(value) ||
    /^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)$/iu.test(value) ||
    /^(?:transparent|black|white|red|green|blue|gray|grey|yellow|orange|purple|pink|teal|navy)$/iu.test(value)
  )
}

function safeSvgColor(value: string | undefined, fallback: string): string {
  return value !== undefined && isSafeCssColor(value) ? escapeXml(value) : fallback
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/gu, '\\$1')
}

function escapeMarkdownTableCell(value: string): string {
  return escapeMarkdownText(value).replaceAll('|', '\\|').replace(/\r?\n/gu, '<br>')
}

function escapeMarkdownUrl(value: string): string {
  return encodeURI(value).replaceAll('(', '%28').replaceAll(')', '%29')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function sanitizeFileName(value: string): string {
  const safe = value
    .normalize('NFKC')
    .replace(/[/\\?%*:|"<>.\p{Cc}]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120)
  return safe.length > 0 ? safe : 'document'
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`
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

/**
 * Document snapshot が参照する外部 domain target を列挙します。
 */
export function collectDocumentRelationTargets(
  document: DocumentDetail,
): DocumentRelationTarget[] {
  return [
    ...document.relations.map(({ target }) =>
      structuredClone(target)
    ),
    ...(document.kind === 'whiteboard'
      ? document.whiteboard.objects.flatMap((object) =>
          object.type === 'work-item'
            ? [{
                kind: 'work-item' as const,
                workItemId: object.workItemId,
              }]
            : []
        )
      : []),
  ]
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
    validateScope(
      value.scope as DocumentScope,
    )
    validatePermission(
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

function requireAuthorizationGuards(
  access: DocumentAccessContext,
): readonly DocumentAuthorizationGenerationGuard[] {
  if (
    access.authorizationGuards === undefined ||
    access.authorizationGuards.length === 0
  ) {
    throw new DocumentError(
      503,
      'DocumentAuthorizationGuardRequired',
      'Public share creation requires a current authorization generation.',
    )
  }
  return access.authorizationGuards.map(
    validateAuthorizationGuard,
  )
}

function authorizationGuardConditionChecks(
  guards:
    | readonly DocumentAuthorizationGenerationGuard[]
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
  ...groups: Array<
    | readonly DocumentAuthorizationGenerationGuard[]
    | undefined
  >
): readonly DocumentAuthorizationGenerationGuard[] {
  const merged = new Map<
    string,
    DocumentAuthorizationGenerationGuard
  >()
  for (const group of groups) {
    for (const candidate of group ?? []) {
      const guard =
        validateAuthorizationGuard(candidate)
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
): readonly DocumentAuthorizationGenerationGuard[] {
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
  guard: DocumentAuthorizationGenerationGuard,
): DocumentAuthorizationGenerationGuard {
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
  guard: DocumentAuthorizationGenerationGuard,
): Record<string, string | number | boolean> {
  return {
    [guard.generationAttribute]:
      guard.expectedGeneration,
    ...guard.requiredAttributes,
  }
}

function authorizationGuardMatches(
  item: Record<string, unknown> | undefined,
  guard: DocumentAuthorizationGenerationGuard,
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
  guard: DocumentAuthorizationGenerationGuard,
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
  if (actions.length > 100) {
    throw new DocumentError(
      413,
      'DocumentTransactionTooLarge',
      'The document mutation creates too many transactional writes.',
      { actionCount: actions.length, maxActionCount: 100 },
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

function stripShareStorageFields(item: Record<string, unknown>): StoredDocumentPublicShare {
  const {
    workspaceId: _workspaceId,
    recordKey: _recordKey,
    entryType: _entryType,
    tokenHash: _tokenHash,
    expiresAtEpoch: _expiresAtEpoch,
    documentShareEpochs: _documentShareEpochs,
    createIdempotencyKeyHash: _createIdempotencyKeyHash,
    createRequestFingerprint: _createRequestFingerprint,
    ...share
  } = item
  return share as StoredDocumentPublicShare
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

function isResourceNotFound(error: unknown): boolean {
  return isRecord(error) && error.name === 'ResourceNotFoundException'
}

function isResourceInUse(error: unknown): boolean {
  return isRecord(error) && error.name === 'ResourceInUseException'
}

function normalizeDynamoError(error: unknown): Error {
  if (error instanceof DocumentError) return error
  return new DocumentError(
    503,
    'DocumentsStoreError',
    'The documents store request failed.',
    undefined,
    { cause: error },
  )
}
