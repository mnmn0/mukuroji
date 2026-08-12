import type {
  ApplyDocumentOperationsInput,
  ApplyDocumentOperationsResponse,
  DocumentBlock,
  DocumentComment,
  DocumentCommentAnchor,
  DocumentDetail,
  DocumentKind,
  DocumentMention,
  DocumentNode,
  DocumentOperation,
  DocumentPermission,
  DocumentPresence,
  DocumentPresenceSelection,
  DocumentPublicShare,
  DocumentRelation,
  DocumentRelationTarget,
  DocumentScope,
  WhiteboardContent,
} from '@mukuroji/contracts'
import type { MutationAuditContext } from '../audit'
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
  authorizationSnapshots?: readonly DocumentAuthorizationFenceSnapshot[]
}

/**
 * Authorization generations observed before a Documents mutation.
 */
export type DocumentAuthorizationFenceSnapshot = {
  /** Canonical Workspace ID that owns every observed generation. */
  workspaceId: string
  /** Active Workspace member key observed during authentication. */
  workspaceMemberKey?: string
  /** Workspace membership version observed during authentication. */
  workspaceMemberVersion?: number
  /** Planning authorization revision observed during authorization. */
  planningRevision?: number
  /** Enterprise Identity control revision observed during authorization. */
  enterpriseControlRevision?: number
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

/** Private marker that prevents transport layers from inspecting adapter caches. */
const documentSearchAccessReadContextMarker: unique symbol =
  Symbol('DocumentSearchAccessReadContext')

/**
 * 一つの Workspace search request 内で compact ACL reads を共有する opaque token です。
 */
export type DocumentSearchAccessReadContext = {
  /** Transport-invisible marker owned by the Documents application boundary. */
  readonly [documentSearchAccessReadContextMarker]: true
}

/**
 * Workspace search request 単位の compact ACL read context を作成します。
 *
 * @returns 同じ request 内の候補と ancestor が共有する opaque token です。
 */
export function createDocumentSearchAccessReadContext(
): DocumentSearchAccessReadContext {
  return {
    [documentSearchAccessReadContextMarker]: true,
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
  relationTargetAuthorizationSnapshots?: readonly DocumentAuthorizationFenceSnapshot[]
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
  relationTargetAuthorizationSnapshots?: readonly DocumentAuthorizationFenceSnapshot[]
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
    | readonly DocumentAuthorizationFenceSnapshot[]
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
  relationTargetAuthorizationSnapshots?: readonly DocumentAuthorizationFenceSnapshot[]
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
  /** Canonical Workspace ID resolved from the opaque public token. */
  workspaceId: string
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
 * Current private-document manager continuity snapshot.
 */
export type DocumentManagerLifecycleSnapshot = {
  /** Authorization revision read with the snapshot. */
  authorizationRevision: number
  /** First private document that would lose its final manager. */
  blockingDocumentId?: string
}

/**
 * Request for a Work Item deletion fence backed by document backlinks.
 */
export type PrepareDocumentWorkItemDeletionFenceRequest = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Canonical Work Item ID. */
  workItemId: string
}
