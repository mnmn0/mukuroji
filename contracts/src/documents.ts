/**
 * Document、Wiki、Whiteboard の canonical schema version です。
 */
export const DOCUMENT_SCHEMA_VERSION = 1 as const

/**
 * DynamoDB transaction headroom を保証する Document operation batch 上限です。
 */
export const DOCUMENT_OPERATION_BATCH_LIMIT = 4 as const

/**
 * Document tree に保存できる node 種別です。
 */
export type DocumentKind = 'folder' | 'page' | 'template' | 'whiteboard'

/**
 * Document が属する scope 種別です。
 */
export type DocumentScopeType = 'workspace' | 'project'

/**
 * Workspace 全体に属する Document scope です。
 */
export type WorkspaceDocumentScope = {
  /**
   * Workspace scope の discriminator です。
   */
  type: 'workspace'
}

/**
 * 一つの Project に属する Document scope です。
 */
export type ProjectDocumentScope = {
  /**
   * Project scope の discriminator です。
   */
  type: 'project'
  /**
   * Document を所有する Project ID です。
   */
  projectId: string
}

/**
 * Workspace または Project に属する Document scope です。
 */
export type DocumentScope = WorkspaceDocumentScope | ProjectDocumentScope

/**
 * Document permission の継承 mode です。
 */
export type DocumentPermissionMode = 'inherit' | 'private'

/**
 * Document member grant で付与できる role です。
 */
export type DocumentMemberGrantRole = 'viewer' | 'editor' | 'manager'

/**
 * 一人の Workspace member に付与した Document permission です。
 */
export type DocumentMemberGrant = {
  /**
   * Grant 対象の安定した Workspace member key です。
   */
  memberKey: string
  /**
   * Member に付与する Document role です。
   */
  role: DocumentMemberGrantRole
}

/**
 * 親 node または scope の permission を継承する設定です。
 */
export type InheritedDocumentPermission = {
  /**
   * Permission 継承を表す discriminator です。
   */
  mode: 'inherit'
  /**
   * 継承した permission に追加する member grants です。
   */
  memberGrants: DocumentMemberGrant[]
}

/**
 * 継承を停止して明示的な member grant だけを適用する private 設定です。
 */
export type PrivateDocumentPermission = {
  /**
   * Private permission を表す discriminator です。
   */
  mode: 'private'
  /**
   * Private Document を共有する member grants です。
   */
  memberGrants: DocumentMemberGrant[]
}

/**
 * Document node に保存する permission 設定です。
 */
export type DocumentPermission =
  | InheritedDocumentPermission
  | PrivateDocumentPermission

/**
 * Document API が現在 user に公開する操作権限です。
 */
export type DocumentCapabilities = {
  /**
   * Document を参照できるかどうかです。
   */
  canView: boolean
  /**
   * Title、content、tree position を編集できるかどうかです。
   */
  canEdit: boolean
  /**
   * Comment と mention を作成できるかどうかです。
   */
  canComment: boolean
  /**
   * Member または public link として共有できるかどうかです。
   */
  canShare: boolean
  /**
   * Inheritance と member grants を変更できるかどうかです。
   */
  canManagePermissions: boolean
  /**
   * Document を archive できるかどうかです。
   */
  canArchive: boolean
  /**
   * Archive 済み Document を restore できるかどうかです。
   */
  canRestore: boolean
  /**
   * Document content を export できるかどうかです。
   */
  canExport: boolean
}

/**
 * すべての rich text block が持つ共通 field です。
 */
export type DocumentBlockBase = {
  /**
   * Document 内で一意な block ID です。
   */
  id: string
}

/**
 * 通常の本文を保存する paragraph block です。
 */
export type DocumentParagraphBlock = DocumentBlockBase & {
  /**
   * Paragraph block の discriminator です。
   */
  type: 'paragraph'
  /**
   * Paragraph の plain text source です。
   */
  text: string
}

/**
 * Section heading を保存する block です。
 */
export type DocumentHeadingBlock = DocumentBlockBase & {
  /**
   * Heading block の discriminator です。
   */
  type: 'heading'
  /**
   * Heading の階層 level です。
   */
  level: 1 | 2 | 3
  /**
   * Heading の plain text source です。
   */
  text: string
}

/**
 * Table の一つの cell です。
 */
export type DocumentTableCell = {
  /**
   * Table 内で一意な cell ID です。
   */
  id: string
  /**
   * Cell の plain text source です。
   */
  text: string
}

/**
 * Table の一つの row です。
 */
export type DocumentTableRow = {
  /**
   * Table 内で一意な row ID です。
   */
  id: string
  /**
   * Column 順に並んだ cells です。
   */
  cells: DocumentTableCell[]
}

/**
 * 行列 data を保存する table block です。
 */
export type DocumentTableBlock = DocumentBlockBase & {
  /**
   * Table block の discriminator です。
   */
  type: 'table'
  /**
   * Column 順に並んだ header labels です。
   */
  columns: string[]
  /**
   * 表示順に並んだ table rows です。
   */
  rows: DocumentTableRow[]
}

/**
 * Source code を保存する block です。
 */
export type DocumentCodeBlock = DocumentBlockBase & {
  /**
   * Code block の discriminator です。
   */
  type: 'code'
  /**
   * Syntax highlight に使う language identifier です。
   */
  language?: string
  /**
   * Code block の source text です。
   */
  code: string
}

/**
 * Checklist block の一つの item です。
 */
export type DocumentChecklistItem = {
  /**
   * Checklist block 内で一意な item ID です。
   */
  id: string
  /**
   * Checklist item の表示 text です。
   */
  text: string
  /**
   * Item が完了しているかどうかです。
   */
  checked: boolean
  /**
   * Item に割り当てた Workspace member key です。
   */
  assigneeMemberKey?: string
}

/**
 * 複数の完了状態を保存する checklist block です。
 */
export type DocumentChecklistBlock = DocumentBlockBase & {
  /**
   * Checklist block の discriminator です。
   */
  type: 'checklist'
  /**
   * 表示順に並んだ checklist items です。
   */
  items: DocumentChecklistItem[]
}

/**
 * 外部または application 内 resource を埋め込む block です。
 */
export type DocumentEmbedBlock = DocumentBlockBase & {
  /**
   * Embed block の discriminator です。
   */
  type: 'embed'
  /**
   * Embed 対象の absolute または application-relative URL です。
   */
  url: string
  /**
   * Embed card に表示する title です。
   */
  title?: string
  /**
   * Embed provider を識別する安全な code です。
   */
  provider?: string
}

/**
 * Diagram block が保存する source format です。
 */
export type DocumentDiagramFormat = 'mermaid' | 'text'

/**
 * Text source から diagram を描画する block です。
 */
export type DocumentDiagramBlock = DocumentBlockBase & {
  /**
   * Diagram block の discriminator です。
   */
  type: 'diagram'
  /**
   * Diagram source の format です。
   */
  format: DocumentDiagramFormat
  /**
   * Diagram の source text です。
   */
  source: string
}

/**
 * Document page または template に保存できる rich text block です。
 */
export type DocumentBlock =
  | DocumentParagraphBlock
  | DocumentHeadingBlock
  | DocumentTableBlock
  | DocumentCodeBlock
  | DocumentChecklistBlock
  | DocumentEmbedBlock
  | DocumentDiagramBlock

/**
 * Whiteboard canvas 上の座標です。
 */
export type WhiteboardPoint = {
  /**
   * Canvas 左端からの X 座標です。
   */
  x: number
  /**
   * Canvas 上端からの Y 座標です。
   */
  y: number
}

/**
 * Whiteboard object または frame の矩形領域です。
 */
export type WhiteboardBounds = WhiteboardPoint & {
  /**
   * 矩形の幅です。
   */
  width: number
  /**
   * 矩形の高さです。
   */
  height: number
  /**
   * 時計回りの回転角度です。
   */
  rotation?: number
}

/**
 * Whiteboard object の表示 style です。
 */
export type WhiteboardObjectStyle = {
  /**
   * Object 背景の CSS color value です。
   */
  fill?: string
  /**
   * Object 枠線の CSS color value です。
   */
  stroke?: string
  /**
   * Text の CSS color value です。
   */
  textColor?: string
}

/**
 * すべての Whiteboard object が持つ共通 field です。
 */
export type WhiteboardObjectBase = {
  /**
   * Whiteboard 内で一意な object ID です。
   */
  id: string
  /**
   * Object が占有する canvas 上の矩形です。
   */
  bounds: WhiteboardBounds
  /**
   * Object の重なり順です。
   */
  zIndex: number
  /**
   * Object の任意の表示 style です。
   */
  style?: WhiteboardObjectStyle
}

/**
 * 付箋として表示する Whiteboard object です。
 */
export type WhiteboardNoteObject = WhiteboardObjectBase & {
  /**
   * Note object の discriminator です。
   */
  type: 'note'
  /**
   * Note に表示する plain text です。
   */
  text: string
}

/**
 * Whiteboard に描画する shape の種類です。
 */
export type WhiteboardShapeKind =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'triangle'

/**
 * 幾何学 shape として表示する Whiteboard object です。
 */
export type WhiteboardShapeObject = WhiteboardObjectBase & {
  /**
   * Shape object の discriminator です。
   */
  type: 'shape'
  /**
   * 描画する shape の種類です。
   */
  shape: WhiteboardShapeKind
  /**
   * Shape 内に表示する plain text です。
   */
  text?: string
}

/**
 * 自由配置 text として表示する Whiteboard object です。
 */
export type WhiteboardTextObject = WhiteboardObjectBase & {
  /**
   * Text object の discriminator です。
   */
  type: 'text'
  /**
   * Canvas に表示する plain text です。
   */
  text: string
}

/**
 * Work Item の参照 card として表示する Whiteboard object です。
 */
export type WhiteboardWorkItemObject = WhiteboardObjectBase & {
  /**
   * Work Item object の discriminator です。
   */
  type: 'work-item'
  /**
   * 参照する Work Item ID です。
   */
  workItemId: string
}

/**
 * Whiteboard canvas に配置できる object です。
 */
export type WhiteboardObject =
  | WhiteboardNoteObject
  | WhiteboardShapeObject
  | WhiteboardTextObject
  | WhiteboardWorkItemObject

/**
 * Connector の接続先です。
 */
export type WhiteboardConnectorEndpoint = {
  /**
   * 接続する Whiteboard object ID です。
   */
  objectId: string
  /**
   * Object 上の明示的な接続位置です。
   */
  anchor?: 'top' | 'right' | 'bottom' | 'left' | 'center'
}

/**
 * 二つの Whiteboard object を結ぶ connector です。
 */
export type WhiteboardConnector = {
  /**
   * Whiteboard 内で一意な connector ID です。
   */
  id: string
  /**
   * Connector の始点です。
   */
  from: WhiteboardConnectorEndpoint
  /**
   * Connector の終点です。
   */
  to: WhiteboardConnectorEndpoint
  /**
   * Connector の線種です。
   */
  lineStyle?: 'solid' | 'dashed'
  /**
   * Connector に表示する label です。
   */
  label?: string
}

/**
 * Whiteboard objects を視覚的にグループ化する frame です。
 */
export type WhiteboardFrame = {
  /**
   * Whiteboard 内で一意な frame ID です。
   */
  id: string
  /**
   * Frame の表示名です。
   */
  title: string
  /**
   * Frame が占有する canvas 上の矩形です。
   */
  bounds: WhiteboardBounds
  /**
   * Frame に含める object IDs です。
   */
  objectIds: string[]
}

/**
 * Whiteboard Document が保持する canvas content です。
 */
export type WhiteboardContent = {
  /**
   * Canvas に配置された objects です。
   */
  objects: WhiteboardObject[]
  /**
   * Object 間を結ぶ connectors です。
   */
  connectors: WhiteboardConnector[]
  /**
   * Object をグループ化する frames です。
   */
  frames: WhiteboardFrame[]
}

/**
 * Document relation の起点が Document 全体であることを表します。
 */
export type DocumentRootRelationSource = {
  /**
   * Document 全体を表す discriminator です。
   */
  kind: 'document'
}

/**
 * Document relation の起点となる rich text block です。
 */
export type DocumentBlockRelationSource = {
  /**
   * Rich text block を表す discriminator です。
   */
  kind: 'block'
  /**
   * Relation を持つ block ID です。
   */
  blockId: string
}

/**
 * Document relation の起点となる Whiteboard object です。
 */
export type DocumentWhiteboardObjectRelationSource = {
  /**
   * Whiteboard object を表す discriminator です。
   */
  kind: 'whiteboard-object'
  /**
   * Relation を持つ Whiteboard object ID です。
   */
  objectId: string
}

/**
 * Relation を配置する Document 内の起点です。
 */
export type DocumentRelationSource =
  | DocumentRootRelationSource
  | DocumentBlockRelationSource
  | DocumentWhiteboardObjectRelationSource

/**
 * Work Item を参照する Document relation target です。
 */
export type WorkItemDocumentRelationTarget = {
  /**
   * Work Item relation の discriminator です。
   */
  kind: 'work-item'
  /**
   * 参照する Work Item ID です。
   */
  workItemId: string
}

/**
 * Project を参照する Document relation target です。
 */
export type ProjectDocumentRelationTarget = {
  /**
   * Project relation の discriminator です。
   */
  kind: 'project'
  /**
   * 参照する Project ID です。
   */
  projectId: string
}

/**
 * Goal を参照する Document relation target です。
 */
export type GoalDocumentRelationTarget = {
  /**
   * Goal relation の discriminator です。
   */
  kind: 'goal'
  /**
   * 参照する Goal ID です。
   */
  goalId: string
}

/**
 * Document から参照できる relation target です。
 */
export type DocumentRelationTarget =
  | WorkItemDocumentRelationTarget
  | ProjectDocumentRelationTarget
  | GoalDocumentRelationTarget

/**
 * Document と domain entity の明示的な relation です。
 */
export type DocumentRelation = {
  /**
   * Document 内で一意な relation ID です。
   */
  id: string
  /**
   * Relation を配置した Document 内の起点です。
   */
  source: DocumentRelationSource
  /**
   * Relation の参照先です。
   */
  target: DocumentRelationTarget
  /**
   * Relation を作成した Workspace user ID です。
   */
  createdByUserId: string
  /**
   * Relation の作成日時です。
   */
  createdAt: string
}

/**
 * Document API の tree summary node です。
 */
export type DocumentNode = {
  /**
   * Canonical Document schema version です。
   */
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION
  /**
   * Workspace 内で一意な Document ID です。
   */
  id: string
  /**
   * Folder、page、template、whiteboard の kind です。
   */
  kind: DocumentKind
  /**
   * Document の Workspace または Project scope です。
   */
  scope: DocumentScope
  /**
   * Tree 上の親 folder ID です。
   */
  parentId?: string
  /**
   * Tree node の表示 title です。
   */
  title: string
  /**
   * 同じ親を持つ node 間の並び順です。
   */
  position: string
  /**
   * Optimistic concurrency に使う単調増加 revision です。
   */
  revision: number
  /**
   * 現在 user が favorite にしているかどうかです。
   */
  favorite: boolean
  /**
   * 現在 user が最後に開いた日時です。
   */
  lastOpenedAt?: string
  /**
   * Archive 済みの場合の archive 日時です。
   */
  archivedAt?: string
  /**
   * 現在 user に許可された操作です。
   */
  capabilities: DocumentCapabilities
  /**
   * Folder 直下の非 archive child 数です。
   */
  childCount: number
  /**
   * Document を作成した Workspace user ID です。
   */
  createdByUserId: string
  /**
   * Document を最後に更新した Workspace user ID です。
   */
  updatedByUserId: string
  /**
   * Document の作成日時です。
   */
  createdAt: string
  /**
   * Document の最終更新日時です。
   */
  updatedAt: string
}

/**
 * Document detail の全 kind に共通する metadata です。
 */
export type DocumentDetailBase = {
  /**
   * Canonical Document schema version です。
   */
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION
  /**
   * Workspace 内で一意な Document ID です。
   */
  id: string
  /**
   * Document の Workspace または Project scope です。
   */
  scope: DocumentScope
  /**
   * Tree 上の親 folder ID です。
   */
  parentId?: string
  /**
   * Document の表示 title です。
   */
  title: string
  /**
   * 同じ親を持つ node 間の並び順です。
   */
  position: string
  /**
   * Optimistic concurrency に使う単調増加 revision です。
   */
  revision: number
  /**
   * Document の permission 設定です。
   */
  permission: DocumentPermission
  /**
   * Document が持つ domain relations です。
   */
  relations: DocumentRelation[]
  /**
   * 現在 user が favorite にしているかどうかです。
   */
  favorite: boolean
  /**
   * 現在 user が最後に開いた日時です。
   */
  lastOpenedAt?: string
  /**
   * Archive 済みの場合の archive 日時です。
   */
  archivedAt?: string
  /**
   * 現在 user に許可された操作です。
   */
  capabilities: DocumentCapabilities
  /**
   * Document を作成した Workspace user ID です。
   */
  createdByUserId: string
  /**
   * Document を最後に更新した Workspace user ID です。
   */
  updatedByUserId: string
  /**
   * Document の作成日時です。
   */
  createdAt: string
  /**
   * Document の最終更新日時です。
   */
  updatedAt: string
}

/**
 * Child container として使う folder Document detail です。
 */
export type FolderDocumentDetail = DocumentDetailBase & {
  /**
   * Folder detail の discriminator です。
   */
  kind: 'folder'
  /**
   * Folder 直下の非 archive child 数です。
   */
  childCount: number
}

/**
 * Rich text content を持つ page Document detail です。
 */
export type PageDocumentDetail = DocumentDetailBase & {
  /**
   * Page detail の discriminator です。
   */
  kind: 'page'
  /**
   * 表示順に並んだ rich text blocks です。
   */
  blocks: DocumentBlock[]
}

/**
 * Page 作成時の source として使う template Document detail です。
 */
export type TemplateDocumentDetail = DocumentDetailBase & {
  /**
   * Template detail の discriminator です。
   */
  kind: 'template'
  /**
   * Template が提供する rich text blocks です。
   */
  blocks: DocumentBlock[]
}

/**
 * Infinite canvas content を持つ whiteboard Document detail です。
 */
export type WhiteboardDocumentDetail = DocumentDetailBase & {
  /**
   * Whiteboard detail の discriminator です。
   */
  kind: 'whiteboard'
  /**
   * Whiteboard の objects、connectors、frames です。
   */
  whiteboard: WhiteboardContent
}

/**
 * Kind ごとの content を含む canonical Document detail です。
 */
export type DocumentDetail =
  | FolderDocumentDetail
  | PageDocumentDetail
  | TemplateDocumentDetail
  | WhiteboardDocumentDetail

/**
 * Public share で公開してよい checklist item です。
 */
export type PublicDocumentChecklistItem = {
  /**
   * Checklist block 内で一意な item ID です。
   */
  id: string
  /**
   * Checklist item の表示 text です。
   */
  text: string
  /**
   * Item が完了しているかどうかです。
   */
  checked: boolean
}

/**
 * Workspace member assignment を除いた public checklist block です。
 */
export type PublicDocumentChecklistBlock = DocumentBlockBase & {
  /**
   * Checklist block の discriminator です。
   */
  type: 'checklist'
  /**
   * Public viewer に表示する checklist items です。
   */
  items: PublicDocumentChecklistItem[]
}

/**
 * Workspace member metadata を含まない public rich text block です。
 */
export type PublicDocumentBlock =
  | DocumentParagraphBlock
  | DocumentHeadingBlock
  | DocumentTableBlock
  | DocumentCodeBlock
  | PublicDocumentChecklistBlock
  | DocumentEmbedBlock
  | DocumentDiagramBlock

/**
 * Work Item target ID を除いた public Whiteboard card です。
 */
export type PublicWhiteboardWorkItemObject = WhiteboardObjectBase & {
  /**
   * Work Item card の discriminator です。
   */
  type: 'work-item'
}

/**
 * Workspace relation metadata を含まない public Whiteboard object です。
 */
export type PublicWhiteboardObject =
  | WhiteboardNoteObject
  | WhiteboardShapeObject
  | WhiteboardTextObject
  | PublicWhiteboardWorkItemObject

/**
 * Workspace relation metadata を含まない public Whiteboard content です。
 */
export type PublicWhiteboardContent = {
  /**
   * Public canvas に配置された objects です。
   */
  objects: PublicWhiteboardObject[]
  /**
   * Public objects 間を結ぶ connectors です。
   */
  connectors: WhiteboardConnector[]
  /**
   * Public objects をグループ化する frames です。
   */
  frames: WhiteboardFrame[]
}

/**
 * Public share で公開してよい Document metadata です。
 */
export type PublicDocumentBase = {
  /**
   * Public viewer に表示する Document title です。
   */
  title: string
  /**
   * Public viewer に表示する最終更新日時です。
   */
  updatedAt: string
}

/**
 * Public share から参照する folder です。
 */
export type PublicFolderDocument = PublicDocumentBase & {
  /**
   * Folder の discriminator です。
   */
  kind: 'folder'
}

/**
 * Public share から参照する page または template です。
 */
export type PublicRichTextDocument = PublicDocumentBase & {
  /**
   * Rich text Document の discriminator です。
   */
  kind: 'page' | 'template'
  /**
   * Public viewer に描画する rich text blocks です。
   */
  blocks: PublicDocumentBlock[]
}

/**
 * Public share から参照する Whiteboard です。
 */
export type PublicWhiteboardDocument = PublicDocumentBase & {
  /**
   * Whiteboard の discriminator です。
   */
  kind: 'whiteboard'
  /**
   * Public viewer に描画する Whiteboard content です。
   */
  whiteboard: PublicWhiteboardContent
}

/**
 * ACL や Workspace member metadata を含まない public Document projection です。
 */
export type PublicDocument =
  | PublicFolderDocument
  | PublicRichTextDocument
  | PublicWhiteboardDocument

/**
 * Public share token で Document を取得した response です。
 */
export type PublicDocumentResponse = {
  /**
   * Public viewer に公開してよい kind-specific Document projection です。
   */
  document: PublicDocument
  /**
   * Public viewer が token 経由で export できるかどうかです。
   */
  allowExport: boolean
}

/**
 * Document tree 一覧 API の cursor page です。
 */
export type DocumentTreeResponse = {
  /**
   * 現在 page の permission-filtered tree nodes です。
   */
  nodes: DocumentNode[]
  /**
   * 次 page を取得する scope-bound opaque cursor です。
   */
  nextCursor?: string
}

/**
 * Document detail API の response です。
 */
export type DocumentDetailResponse = {
  /**
   * 取得した kind-specific Document detail です。
   */
  document: DocumentDetail
}

/**
 * Document relations 一覧 API の response です。
 */
export type DocumentRelationsResponse = {
  /**
   * Document に紐付く relations です。
   */
  relations: DocumentRelation[]
}

/**
 * Idempotent な Document operation が持つ共通 field です。
 */
export type DocumentOperationBase = {
  /**
   * Client が生成する operation 単位の一意な ID です。
   */
  operationId: string
}

/**
 * Rich text Document に block を追加する operation です。
 */
export type InsertDocumentBlockOperation = DocumentOperationBase & {
  /**
   * Block 追加 operation の discriminator です。
   */
  type: 'insert-block'
  /**
   * 追加する kind-specific block です。
   */
  block: DocumentBlock
  /**
   * 追加先の zero-based index です。
   */
  index: number
}

/**
 * Rich text Document の block 全体を置き換える operation です。
 */
export type UpdateDocumentBlockOperation = DocumentOperationBase & {
  /**
   * Block 更新 operation の discriminator です。
   */
  type: 'update-block'
  /**
   * 置き換える既存 block ID です。
   */
  blockId: string
  /**
   * 更新後の kind-specific block です。
   */
  block: DocumentBlock
}

/**
 * Rich text Document の block を並べ替える operation です。
 */
export type MoveDocumentBlockOperation = DocumentOperationBase & {
  /**
   * Block 移動 operation の discriminator です。
   */
  type: 'move-block'
  /**
   * 移動する block ID です。
   */
  blockId: string
  /**
   * 移動後の zero-based index です。
   */
  index: number
}

/**
 * Rich text Document から block を削除する operation です。
 */
export type DeleteDocumentBlockOperation = DocumentOperationBase & {
  /**
   * Block 削除 operation の discriminator です。
   */
  type: 'delete-block'
  /**
   * 削除する block ID です。
   */
  blockId: string
}

/**
 * Whiteboard に object を追加する operation です。
 */
export type InsertWhiteboardObjectOperation = DocumentOperationBase & {
  /**
   * Object 追加 operation の discriminator です。
   */
  type: 'insert-object'
  /**
   * 追加する kind-specific Whiteboard object です。
   */
  object: WhiteboardObject
}

/**
 * Whiteboard object 全体を置き換える operation です。
 */
export type UpdateWhiteboardObjectOperation = DocumentOperationBase & {
  /**
   * Object 更新 operation の discriminator です。
   */
  type: 'update-object'
  /**
   * 置き換える既存 object ID です。
   */
  objectId: string
  /**
   * 更新後の kind-specific Whiteboard object です。
   */
  object: WhiteboardObject
}

/**
 * Whiteboard から object を削除する operation です。
 */
export type DeleteWhiteboardObjectOperation = DocumentOperationBase & {
  /**
   * Object 削除 operation の discriminator です。
   */
  type: 'delete-object'
  /**
   * 削除する object ID です。
   */
  objectId: string
}

/**
 * Whiteboard connector を追加または置き換える operation です。
 */
export type UpsertWhiteboardConnectorOperation = DocumentOperationBase & {
  /**
   * Connector upsert operation の discriminator です。
   */
  type: 'upsert-connector'
  /**
   * 保存する connector です。
   */
  connector: WhiteboardConnector
}

/**
 * Whiteboard connector を削除する operation です。
 */
export type DeleteWhiteboardConnectorOperation = DocumentOperationBase & {
  /**
   * Connector 削除 operation の discriminator です。
   */
  type: 'delete-connector'
  /**
   * 削除する connector ID です。
   */
  connectorId: string
}

/**
 * Whiteboard frame を追加または置き換える operation です。
 */
export type UpsertWhiteboardFrameOperation = DocumentOperationBase & {
  /**
   * Frame upsert operation の discriminator です。
   */
  type: 'upsert-frame'
  /**
   * 保存する frame です。
   */
  frame: WhiteboardFrame
}

/**
 * Whiteboard frame を削除する operation です。
 */
export type DeleteWhiteboardFrameOperation = DocumentOperationBase & {
  /**
   * Frame 削除 operation の discriminator です。
   */
  type: 'delete-frame'
  /**
   * 削除する frame ID です。
   */
  frameId: string
}

/**
 * Document relation を追加または置き換える operation です。
 */
export type UpsertDocumentRelationOperation = DocumentOperationBase & {
  /**
   * Relation upsert operation の discriminator です。
   */
  type: 'upsert-relation'
  /**
   * 保存する Document relation です。
   */
  relation: DocumentRelation
}

/**
 * Document relation を削除する operation です。
 */
export type DeleteDocumentRelationOperation = DocumentOperationBase & {
  /**
   * Relation 削除 operation の discriminator です。
   */
  type: 'delete-relation'
  /**
   * 削除する relation ID です。
   */
  relationId: string
}

/**
 * Block、Whiteboard object、connector、frame、relation 単位の operation です。
 */
export type DocumentOperation =
  | InsertDocumentBlockOperation
  | UpdateDocumentBlockOperation
  | MoveDocumentBlockOperation
  | DeleteDocumentBlockOperation
  | InsertWhiteboardObjectOperation
  | UpdateWhiteboardObjectOperation
  | DeleteWhiteboardObjectOperation
  | UpsertWhiteboardConnectorOperation
  | DeleteWhiteboardConnectorOperation
  | UpsertWhiteboardFrameOperation
  | DeleteWhiteboardFrameOperation
  | UpsertDocumentRelationOperation
  | DeleteDocumentRelationOperation

/**
 * Document operations を optimistic concurrency 付きで一括適用する入力です。
 */
export type ApplyDocumentOperationsInput = {
  /**
   * Client が編集を開始した時点の Document revision です。
   */
  baseRevision: number
  /**
   * Editor instance を識別する client ID です。
   */
  clientId: string
  /**
   * 順番どおり atomic に適用する idempotent operations です。
   */
  operations: DocumentOperation[]
}

/**
 * Document operations の一括適用結果です。
 */
export type ApplyDocumentOperationsResponse = {
  /**
   * 更新した Document ID です。
   */
  documentId: string
  /**
   * Operations 適用後の Document revision です。
   */
  revision: number
  /**
   * Idempotency 判定後に受理済みとなった operation IDs です。
   */
  appliedOperationIds: string[]
  /**
   * Document の更新日時です。
   */
  updatedAt: string
}

/**
 * Document version が作成された理由です。
 */
export type DocumentVersionReason = 'create' | 'edit' | 'restore' | 'auto-save'

/**
 * Document history に表示する immutable version metadata です。
 */
export type DocumentVersion = {
  /**
   * Canonical Document schema version です。
   */
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION
  /**
   * Document 内で一意な version ID です。
   */
  id: string
  /**
   * Version が属する Document ID です。
   */
  documentId: string
  /**
   * Snapshot を作成した Document revision です。
   */
  revision: number
  /**
   * Snapshot の Document kind です。
   */
  kind: DocumentKind
  /**
   * Version history に表示する Document title です。
   */
  title: string
  /**
   * Version を作成した理由です。
   */
  reason: DocumentVersionReason
  /**
   * Version の変更概要です。
   */
  summary?: string
  /**
   * Version を作成した Workspace user ID です。
   */
  createdByUserId: string
  /**
   * Version の作成日時です。
   */
  createdAt: string
}

/**
 * Immutable version と復元可能な snapshot の組です。
 */
export type DocumentVersionDetail = {
  /**
   * Version history に表示する metadata です。
   */
  version: DocumentVersion
  /**
   * Version 作成時点の canonical Document snapshot です。
   */
  document: DocumentDetail
}

/**
 * Document version history API の cursor page です。
 */
export type DocumentVersionsResponse = {
  /**
   * 新しい順に並んだ version metadata です。
   */
  versions: DocumentVersion[]
  /**
   * 次 page を取得する scope-bound opaque cursor です。
   */
  nextCursor?: string
}

/**
 * Document version detail API の response です。
 */
export type DocumentVersionResponse = {
  /**
   * Version metadata と canonical snapshot です。
   */
  version: DocumentVersionDetail
}

/**
 * Comment body 内の Workspace user mention です。
 */
export type DocumentMention = {
  /**
   * Mention した Workspace user ID です。
   */
  userId: string
  /**
   * Comment body 内の UTF-16 offset です。
   */
  offset: number
  /**
   * Mention 表示 text の UTF-16 length です。
   */
  length: number
}

/**
 * Document 全体を指す comment anchor です。
 */
export type DocumentRootCommentAnchor = {
  /**
   * Document 全体を指す anchor discriminator です。
   */
  type: 'document'
}

/**
 * Rich text block 全体を指す comment anchor です。
 */
export type DocumentBlockCommentAnchor = {
  /**
   * Block 全体を指す anchor discriminator です。
   */
  type: 'block'
  /**
   * Comment 対象の block ID です。
   */
  blockId: string
}

/**
 * Rich text block 内の text range を指す comment anchor です。
 */
export type DocumentTextCommentAnchor = {
  /**
   * Text range を指す anchor discriminator です。
   */
  type: 'text'
  /**
   * Comment 対象の block ID です。
   */
  blockId: string
  /**
   * Text range の inclusive UTF-16 start offset です。
   */
  start: number
  /**
   * Text range の exclusive UTF-16 end offset です。
   */
  end: number
}

/**
 * Whiteboard object を指す comment anchor です。
 */
export type WhiteboardObjectCommentAnchor = {
  /**
   * Whiteboard object を指す anchor discriminator です。
   */
  type: 'whiteboard-object'
  /**
   * Comment 対象の Whiteboard object ID です。
   */
  objectId: string
}

/**
 * Document comment を content 上へ紐付ける anchor です。
 */
export type DocumentCommentAnchor =
  | DocumentRootCommentAnchor
  | DocumentBlockCommentAnchor
  | DocumentTextCommentAnchor
  | WhiteboardObjectCommentAnchor

/**
 * Document 上の comment または thread reply です。
 */
export type DocumentComment = {
  /**
   * Document 内で一意な comment ID です。
   */
  id: string
  /**
   * Comment が属する Document ID です。
   */
  documentId: string
  /**
   * Reply の場合に参照する root comment ID です。
   */
  parentCommentId?: string
  /**
   * Comment を配置した content anchor です。
   */
  anchor: DocumentCommentAnchor
  /**
   * Comment の plain text body です。
   */
  body: string
  /**
   * Comment body に含まれる user mentions です。
   */
  mentions: DocumentMention[]
  /**
   * Comment を投稿した Workspace user ID です。
   */
  authorUserId: string
  /**
   * Thread が解決済みかどうかです。
   */
  resolved: boolean
  /**
   * Thread を解決した Workspace user ID です。
   */
  resolvedByUserId?: string
  /**
   * Thread の解決日時です。
   */
  resolvedAt?: string
  /**
   * Comment の作成日時です。
   */
  createdAt: string
  /**
   * Comment の最終更新日時です。
   */
  updatedAt: string
}

/**
 * Document comment を作成する入力です。
 */
export type CreateDocumentCommentInput = {
  /**
   * Reply の場合に参照する root comment ID です。
   */
  parentCommentId?: string
  /**
   * Comment を配置する content anchor です。
   */
  anchor: DocumentCommentAnchor
  /**
   * Comment の plain text body です。
   */
  body: string
  /**
   * Comment body に含める user mentions です。
   */
  mentions: DocumentMention[]
}

/**
 * Document comment の body または解決状態を更新する入力です。
 */
export type UpdateDocumentCommentInput = {
  /**
   * 更新後の plain text body です。
   */
  body?: string
  /**
   * 更新後の user mentions です。
   */
  mentions?: DocumentMention[]
  /**
   * Thread を解決済みにするかどうかです。
   */
  resolved?: boolean
}

/**
 * Document comment mutation の response です。
 */
export type DocumentCommentResponse = {
  /**
   * 作成または更新した comment です。
   */
  comment: DocumentComment
}

/**
 * Document comments API の cursor page です。
 */
export type DocumentCommentsResponse = {
  /**
   * Anchor と thread 順に並んだ comments です。
   */
  comments: DocumentComment[]
  /**
   * 次 page を取得する scope-bound opaque cursor です。
   */
  nextCursor?: string
}

/**
 * Rich text editor 上の presence selection です。
 */
export type DocumentTextPresenceSelection = {
  /**
   * Rich text selection の discriminator です。
   */
  type: 'text'
  /**
   * Cursor または selection がある block ID です。
   */
  blockId: string
  /**
   * Selection の anchor UTF-16 offset です。
   */
  anchorOffset: number
  /**
   * Selection の focus UTF-16 offset です。
   */
  focusOffset: number
}

/**
 * Whiteboard editor 上の presence selection です。
 */
export type WhiteboardPresenceSelection = {
  /**
   * Whiteboard selection の discriminator です。
   */
  type: 'whiteboard'
  /**
   * 現在選択している object IDs です。
   */
  objectIds: string[]
  /**
   * 現在の pointer 座標です。
   */
  pointer?: WhiteboardPoint
}

/**
 * Document editor 上で共有する collaborator selection です。
 */
export type DocumentPresenceSelection =
  | DocumentTextPresenceSelection
  | WhiteboardPresenceSelection

/**
 * Document を現在開いている collaborator の ephemeral presence です。
 */
export type DocumentPresence = {
  /**
   * Presence が属する Document ID です。
   */
  documentId: string
  /**
   * Collaborator の Workspace user ID です。
   */
  userId: string
  /**
   * Editor instance を識別する client ID です。
   */
  clientId: string
  /**
   * Collaborator の表示名です。
   */
  displayName: string
  /**
   * Collaborator cursor に使う CSS color value です。
   */
  color: string
  /**
   * Collaborator が現在選択している content です。
   */
  selection?: DocumentPresenceSelection
  /**
   * Presence heartbeat の最終受信日時です。
   */
  lastSeenAt: string
}

/**
 * 現在 client の Document presence を更新する入力です。
 */
export type UpdateDocumentPresenceInput = {
  /**
   * Editor instance を識別する client ID です。
   */
  clientId: string
  /**
   * 現在選択している content です。null で selection を解除します。
   */
  selection?: DocumentPresenceSelection | null
}

/**
 * Document collaborators の presence response です。
 */
export type DocumentPresenceResponse = {
  /**
   * TTL 内の active collaborator presences です。
   */
  presences: DocumentPresence[]
}

/**
 * 現在 user の Document favorite preference を更新する入力です。
 */
export type SetDocumentFavoriteInput = {
  /**
   * 更新後の favorite 状態です。
   */
  favorite: boolean
}

/**
 * Document favorite preference の更新結果です。
 */
export type SetDocumentFavoriteResponse = {
  /**
   * Preference を更新した Document ID です。
   */
  documentId: string
  /**
   * 更新後の favorite 状態です。
   */
  favorite: boolean
  /**
   * Preference row の更新日時です。
   */
  updatedAt: string
}

/**
 * 現在 user が最近開いた Document です。
 */
export type RecentDocument = {
  /**
   * Permission-filtered Document summary です。
   */
  document: DocumentNode
  /**
   * 現在 user が最後に Document を開いた日時です。
   */
  openedAt: string
}

/**
 * 現在 user の recent Documents response です。
 */
export type RecentDocumentsResponse = {
  /**
   * 最終閲覧日時の新しい順に並んだ Documents です。
   */
  documents: RecentDocument[]
  /**
   * 次 page を取得する Workspace-bound opaque cursor です。
   */
  nextCursor?: string
}

/**
 * Document を archive する入力です。
 */
export type ArchiveDocumentInput = {
  /**
   * Archive 対象を読み込んだ時点の Document revision です。
   */
  expectedRevision: number
}

/**
 * Document archive の response です。
 */
export type ArchiveDocumentResponse = {
  /**
   * Archive 後の Document summary です。
   */
  document: DocumentNode
}

/**
 * Archive 済み Document を tree に復元する入力です。
 */
export type RestoreArchivedDocumentInput = {
  /**
   * Restore 対象を読み込んだ時点の Document revision です。
   */
  expectedRevision: number
  /**
   * 元の親が利用できない場合の復元先 folder ID です。
   */
  parentId?: string
}

/**
 * Archived Document restore の response です。
 */
export type RestoreArchivedDocumentResponse = {
  /**
   * Restore 後の Document summary です。
   */
  document: DocumentNode
}

/**
 * Member へ共有した Document access です。
 */
export type DocumentMemberShare = {
  /**
   * Member share の discriminator です。
   */
  type: 'member'
  /**
   * 共有先 member と role の grant です。
   */
  grant: DocumentMemberGrant
}

/**
 * Expiring public link による Document share です。
 */
export type DocumentPublicShare = {
  /**
   * Public share の discriminator です。
   */
  type: 'public'
  /**
   * Document 内で一意な public share ID です。
   */
  id: string
  /**
   * 共有対象の Document ID です。
   */
  documentId: string
  /**
   * Public link で許可する read-only role です。
   */
  role: 'viewer'
  /**
   * Public link が無効になる日時です。
   */
  expiresAt: string
  /**
   * Public viewer に Document export を許可するかどうかです。
   */
  allowExport: boolean
  /**
   * Public share を作成した Workspace user ID です。
   */
  createdByUserId: string
  /**
   * Public share の作成日時です。
   */
  createdAt: string
  /**
   * Revoke 済みの場合の revoke 日時です。
   */
  revokedAt?: string
}

/**
 * Workspace member へ Document を共有する入力です。
 */
export type CreateMemberDocumentShareInput = {
  /**
   * Member share の discriminator です。
   */
  type: 'member'
  /**
   * 共有先 Workspace member key です。
   */
  memberKey: string
  /**
   * Member に付与する viewer、editor、manager role です。
   */
  role: DocumentMemberGrantRole
}

/**
 * Expiring public link で Document を共有する入力です。
 */
export type CreatePublicDocumentShareInput = {
  /**
   * Public share の discriminator です。
   */
  type: 'public'
  /**
   * Public link が無効になる日時です。
   */
  expiresAt: string
  /**
   * Public viewer に Document export を許可するかどうかです。
   */
  allowExport?: boolean
}

/**
 * Member または public link で Document を共有する入力です。
 */
export type CreateDocumentShareInput =
  | CreateMemberDocumentShareInput
  | CreatePublicDocumentShareInput

/**
 * Member share を作成した response です。
 */
export type CreateMemberDocumentShareResponse = {
  /**
   * Member share response の discriminator です。
   */
  type: 'member'
  /**
   * 作成した member share です。
   */
  share: DocumentMemberShare
}

/**
 * Public share を作成した response です。
 */
export type CreatePublicDocumentShareResponse = {
  /**
   * Public share response の discriminator です。
   */
  type: 'public'
  /**
   * 作成した public share metadata です。
   */
  share: DocumentPublicShare
  /**
   * Expiry まで利用できる public URL です。
   */
  url: string
}

/**
 * Document share 作成 API の response です。
 */
export type CreateDocumentShareResponse =
  | CreateMemberDocumentShareResponse
  | CreatePublicDocumentShareResponse

/**
 * Document share 一覧 API の response です。
 */
export type DocumentSharesResponse = {
  /**
   * 現在有効または revoke 済みの member shares です。
   */
  memberShares: DocumentMemberShare[]
  /**
   * 現在有効または revoke 済みの public shares です。
   */
  publicShares: DocumentPublicShare[]
}

/**
 * Member share を revoke する入力です。
 */
export type RevokeMemberDocumentShareInput = {
  /**
   * Member share revoke の discriminator です。
   */
  type: 'member'
  /**
   * Revoke する member key です。
   */
  memberKey: string
}

/**
 * Public share を revoke する入力です。
 */
export type RevokePublicDocumentShareInput = {
  /**
   * Public share revoke の discriminator です。
   */
  type: 'public'
  /**
   * Revoke する public share ID です。
   */
  publicShareId: string
}

/**
 * Member または public Document share を revoke する入力です。
 */
export type RevokeDocumentShareInput =
  | RevokeMemberDocumentShareInput
  | RevokePublicDocumentShareInput

/**
 * Document share revoke の response です。
 */
export type RevokeDocumentShareResponse = {
  /**
   * Share を revoke した Document ID です。
   */
  documentId: string
  /**
   * Revoke の完了日時です。
   */
  revokedAt: string
}

/**
 * Document 作成入力の全 kind に共通する metadata です。
 */
export type CreateDocumentInputBase = {
  /**
   * Document の Workspace または Project scope です。
   */
  scope: DocumentScope
  /**
   * Tree 上の親 folder ID です。
   */
  parentId?: string
  /**
   * Document の表示 title です。
   */
  title: string
  /**
   * 同じ親を持つ node 間の初期 position です。
   */
  position?: string
  /**
   * Document の初期 permission 設定です。
   */
  permission?: DocumentPermission
}

/**
 * Folder Document を作成する入力です。
 */
export type CreateFolderDocumentInput = CreateDocumentInputBase & {
  /**
   * Folder 作成入力の discriminator です。
   */
  kind: 'folder'
}

/**
 * Page Document を作成する入力です。
 */
export type CreatePageDocumentInput = CreateDocumentInputBase & {
  /**
   * Page 作成入力の discriminator です。
   */
  kind: 'page'
  /**
   * Page の初期 rich text blocks です。
   */
  blocks: DocumentBlock[]
  /**
   * 初期 content を複製する template Document ID です。
   */
  templateId?: string
}

/**
 * Template Document を作成する入力です。
 */
export type CreateTemplateDocumentInput = CreateDocumentInputBase & {
  /**
   * Template 作成入力の discriminator です。
   */
  kind: 'template'
  /**
   * Template の初期 rich text blocks です。
   */
  blocks: DocumentBlock[]
}

/**
 * Whiteboard Document を作成する入力です。
 */
export type CreateWhiteboardDocumentInput = CreateDocumentInputBase & {
  /**
   * Whiteboard 作成入力の discriminator です。
   */
  kind: 'whiteboard'
  /**
   * Whiteboard の初期 canvas content です。
   */
  whiteboard: WhiteboardContent
}

/**
 * Kind-specific な canonical Document 作成入力です。
 */
export type CreateDocumentInput =
  | CreateFolderDocumentInput
  | CreatePageDocumentInput
  | CreateTemplateDocumentInput
  | CreateWhiteboardDocumentInput

/**
 * Document 作成 API の response です。
 */
export type CreateDocumentResponse = {
  /**
   * 作成した kind-specific Document detail です。
   */
  document: DocumentDetail
}

/**
 * Document metadata と permission を更新する入力です。
 */
export type UpdateDocumentInput = {
  /**
   * 読み込み時点の Document revision です。
   */
  expectedRevision: number
  /**
   * 更新後の表示 title です。
   */
  title?: string
  /**
   * 更新後の Workspace または Project scope です。
   */
  scope?: DocumentScope
  /**
   * 更新後の親 folder ID です。null で root に移動します。
   */
  parentId?: string | null
  /**
   * 更新後の sibling position です。
   */
  position?: string
  /**
   * 更新後の permission 設定です。
   */
  permission?: DocumentPermission
}

/**
 * Document metadata 更新 API の response です。
 */
export type UpdateDocumentResponse = {
  /**
   * 更新後の kind-specific Document detail です。
   */
  document: DocumentDetail
}

/**
 * 過去の version から Document content を復元する入力です。
 */
export type RestoreDocumentVersionInput = {
  /**
   * 復元する immutable version ID です。
   */
  versionId: string
  /**
   * Restore 開始時点の Document revision です。
   */
  expectedRevision: number
}

/**
 * Document version restore の response です。
 */
export type RestoreDocumentVersionResponse = {
  /**
   * Restore 後の kind-specific Document detail です。
   */
  document: DocumentDetail
  /**
   * 復元元の immutable version ID です。
   */
  restoredFromVersionId: string
}

/**
 * Document export が生成できる format です。
 */
export type DocumentExportFormat = 'markdown' | 'json' | 'svg'

/**
 * Page または template を Markdown として export する入力です。
 */
export type MarkdownDocumentExportInput = {
  /**
   * Markdown export の discriminator です。
   */
  format: 'markdown'
}

/**
 * 任意の Document を canonical JSON として export する入力です。
 */
export type JsonDocumentExportInput = {
  /**
   * JSON export の discriminator です。
   */
  format: 'json'
}

/**
 * Whiteboard を SVG image として export する入力です。
 */
export type SvgDocumentExportInput = {
  /**
   * SVG export の discriminator です。
   */
  format: 'svg'
}

/**
 * Format-specific な Document export 入力です。
 */
export type ExportDocumentInput =
  | MarkdownDocumentExportInput
  | JsonDocumentExportInput
  | SvgDocumentExportInput

/**
 * 小さい export artifact を response body で返す結果です。
 */
export type InlineDocumentExportResponse = {
  /**
   * Inline delivery の discriminator です。
   */
  delivery: 'inline'
  /**
   * 生成した artifact の format です。
   */
  format: DocumentExportFormat
  /**
   * 生成した artifact の MIME type です。
   */
  mimeType: string
  /**
   * Download 時に使う file name です。
   */
  fileName: string
  /**
   * UTF-8 text として表現した artifact content です。
   */
  content: string
}

/**
 * 大きい export artifact を期限付き URL で返す結果です。
 */
export type DownloadDocumentExportResponse = {
  /**
   * Download delivery の discriminator です。
   */
  delivery: 'download'
  /**
   * 生成した artifact の format です。
   */
  format: DocumentExportFormat
  /**
   * 生成した artifact の MIME type です。
   */
  mimeType: string
  /**
   * Download 時に使う file name です。
   */
  fileName: string
  /**
   * Artifact を取得する署名付き URL です。
   */
  url: string
  /**
   * 署名付き URL が無効になる日時です。
   */
  expiresAt: string
}

/**
 * Document export API の delivery-specific response です。
 */
export type ExportDocumentResponse =
  | InlineDocumentExportResponse
  | DownloadDocumentExportResponse
