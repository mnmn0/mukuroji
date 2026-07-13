/**
 * 現在の canonical Work Item schema version です。
 */
export const WORK_ITEM_SCHEMA_VERSION = 1 as const

/**
 * Workspace search document と API response の schema version です。
 */
export const SEARCH_SCHEMA_VERSION = 1 as const

/**
 * Saved view definition の schema version です。
 */
export const SAVED_VIEW_SCHEMA_VERSION = 1 as const

/**
 * Workspace 横断検索で扱う entity 種別です。
 */
export type SearchEntityType =
  | 'work-item'
  | 'project'
  | 'team'
  | 'comment'
  | 'file'
  | 'document'

/**
 * Custom field filter の比較演算子です。
 */
export type SearchCustomFieldOperator =
  | 'equals'
  | 'not-equals'
  | 'contains'
  | 'greater-than'
  | 'greater-than-or-equal'
  | 'less-than'
  | 'less-than-or-equal'
  | 'is-empty'
  | 'is-not-empty'

/**
 * Search index に保存できる custom field value です。
 */
export type SearchCustomFieldValue = string | number | boolean | string[] | null

/**
 * 一つの custom field に適用する検索条件です。
 */
export type SearchCustomFieldFilter = {
  /**
   * Custom field definition の安定した ID です。
   */
  fieldId: string
  /**
   * Field value へ適用する比較演算子です。
   */
  operator: SearchCustomFieldOperator
  /**
   * Empty 判定以外の演算子が比較に使う値です。
   */
  value?: SearchCustomFieldValue
}

/**
 * Search result の日付を絞り込む field です。
 */
export type WorkspaceSearchDateField = 'createdAt' | 'updatedAt' | 'dueDate'

/**
 * Workspace search の inclusive date range です。
 */
export type WorkspaceSearchDateFilter = {
  /**
   * 範囲を適用する date field です。
   */
  field: WorkspaceSearchDateField
  /**
   * Inclusive lower bound の ISO 8601 日付または timestamp です。
   */
  from?: string
  /**
   * Inclusive upper bound の ISO 8601 日付または timestamp です。
   */
  to?: string
}

/**
 * Workspace 横断検索で組み合わせられる filter set です。
 */
export type WorkspaceSearchFilters = {
  /**
   * Title、body、補助表示文言を横断する keyword です。
   */
  keyword?: string
  /**
   * 取得対象の entity 種別です。
   */
  entityTypes?: SearchEntityType[]
  /**
   * Work Item の assignee user ID 候補です。
   */
  assigneeUserIds?: string[]
  /**
   * Entity の creator user ID 候補です。
   */
  creatorUserIds?: string[]
  /**
   * Workflow status code 候補です。
   */
  statuses?: string[]
  /**
   * Custom field に対する AND 条件です。
   */
  customFields?: SearchCustomFieldFilter[]
  /**
   * Entity が持つ必要がある relation ID 候補です。
   */
  relationIds?: string[]
  /**
   * 作成日、更新日、期限日の範囲です。
   */
  date?: WorkspaceSearchDateFilter
  /**
   * Project scope の候補です。
   */
  projectIds?: string[]
  /**
   * Team scope の候補です。
   */
  teamIds?: string[]
}

/**
 * Search highlight を構成する安全な text fragment です。
 */
export type WorkspaceSearchHighlightFragment = {
  /**
   * HTML を含まない原文 fragment です。
   */
  text: string
  /**
   * Keyword と一致した fragment かどうかです。
   */
  matched: boolean
}

/**
 * Search result の一つの field に対する highlight です。
 */
export type WorkspaceSearchHighlight = {
  /**
   * Highlight 対象 field です。
   */
  field: 'title' | 'body'
  /**
   * UI が安全に描画できる text fragment 一覧です。
   */
  fragments: WorkspaceSearchHighlightFragment[]
}

/**
 * Workspace 横断検索が返す entity summary です。
 */
export type WorkspaceSearchResult = {
  /**
   * Workspace 内の entity ID です。
   */
  id: string
  /**
   * Result の entity 種別です。
   */
  entityType: SearchEntityType
  /**
   * Result の主見出しです。
   */
  title: string
  /**
   * Project 名などの補助見出しです。
   */
  subtitle?: string
  /**
   * Comment や document の本文 preview です。
   */
  body?: string
  /**
   * Entity を開く application-relative URL です。
   */
  url: string
  /**
   * Entity を所有する Team ID です。
   */
  teamId?: string
  /**
   * Entity の遂行先または所有 Project ID です。
   */
  projectId?: string
  /**
   * Comment、file、document が属する親 entity ID です。
   */
  parentId?: string
  /**
   * Entity の assignee user ID です。
   */
  assigneeUserId?: string
  /**
   * Entity の creator user ID です。
   */
  creatorUserId?: string
  /**
   * Entity の workflow status code です。
   */
  status?: string
  /**
   * Entity の custom field value map です。
   */
  customFields?: Record<string, SearchCustomFieldValue>
  /**
   * Entity の期限日です。
   */
  dueDate?: string
  /**
   * Entity の作成日時です。
   */
  createdAt?: string
  /**
   * Entity の最終更新日時です。
   */
  updatedAt?: string
  /**
   * Keyword と一致した安全な text fragments です。
   */
  highlights: WorkspaceSearchHighlight[]
}

/**
 * Cursor pagination された Workspace search response です。
 */
export type WorkspaceSearchResponse = {
  /**
   * Search response の schema version です。
   */
  schemaVersion: typeof SEARCH_SCHEMA_VERSION
  /**
   * 現在 page の permission-filtered result です。
   */
  results: WorkspaceSearchResult[]
  /**
   * 次 page を取得する scope-bound opaque cursor です。
   */
  nextCursor?: string
}

/**
 * Saved view が再現する表示 mode です。
 */
export type SearchViewLayoutMode = 'table' | 'board' | 'calendar' | 'timeline'

/**
 * Saved view の sort direction です。
 */
export type SearchViewSortDirection = 'asc' | 'desc'

/**
 * Saved view が保持する sort rule です。
 */
export type SearchViewSort = {
  /**
   * Built-in field または `custom:<field ID>` 形式の custom field です。
   */
  field: string
  /**
   * Sort direction です。
   */
  direction: SearchViewSortDirection
}

/**
 * Search result view の再現可能な layout 設定です。
 */
export type SearchViewLayout = {
  /**
   * Table、board、calendar、timeline の表示 mode です。
   */
  mode: SearchViewLayoutMode
  /**
   * 優先順に適用する sort rule です。
   */
  sort: SearchViewSort[]
  /**
   * Grouping に使う built-in field または custom field ID です。
   */
  groupBy?: string
  /**
   * 表示順に並んだ built-in field または custom field ID です。
   */
  columns: string[]
}

/**
 * Saved view の共有範囲です。
 */
export type SavedViewVisibility = 'personal' | 'team' | 'shared'

/**
 * Saved query migration で除外した参照の warning です。
 */
export type SavedViewMigrationWarning = {
  /**
   * Warning を安定して識別する code です。
   */
  code: 'deleted-custom-field'
  /**
   * 削除済みと判定した custom field ID です。
   */
  fieldId: string
  /**
   * Field 参照を除外した view section です。
   */
  section: 'filter' | 'sort' | 'group' | 'column'
}

/**
 * API が返す保存済み Workspace view です。
 */
export type SavedWorkspaceView = {
  /**
   * Saved view row の schema version です。
   */
  schemaVersion: typeof SAVED_VIEW_SCHEMA_VERSION
  /**
   * Workspace 内で一意な saved view ID です。
   */
  id: string
  /**
   * View の表示名です。
   */
  name: string
  /**
   * View の補足説明です。
   */
  description?: string
  /**
   * Personal、Team、Workspace shared の共有範囲です。
   */
  visibility: SavedViewVisibility
  /**
   * View を作成した Workspace user ID です。
   */
  ownerUserId: string
  /**
   * Team view の共有先 Team ID です。
   */
  teamId?: string
  /**
   * Search API と共有する versioned filter set です。
   */
  filters: WorkspaceSearchFilters
  /**
   * View mode、sort、group、column の layout です。
   */
  layout: SearchViewLayout
  /**
   * Optimistic concurrency に使う単調増加 revision です。
   */
  revision: number
  /**
   * 現在 user が view definition を編集または削除できるかどうかです。
   */
  canEdit: boolean
  /**
   * 現在 user が favorite にしているかどうかです。
   */
  favorite: boolean
  /**
   * 現在 user が pin しているかどうかです。
   */
  pinned: boolean
  /**
   * 現在 user の default view かどうかです。
   */
  isDefault: boolean
  /**
   * View の作成日時です。
   */
  createdAt: string
  /**
   * View の最終更新日時です。
   */
  updatedAt: string
  /**
   * 削除済み custom field 参照を除外した migration warning です。
   */
  migrationWarnings?: SavedViewMigrationWarning[]
}

/**
 * Saved view 一覧 API の cursor page です。
 */
export type SavedWorkspaceViewsResponse = {
  /**
   * 現在 user が参照できる saved views です。
   */
  views: SavedWorkspaceView[]
  /**
   * 次 page を取得する scope-bound opaque cursor です。
   */
  nextCursor?: string
}

/**
 * Saved Workspace view を作成する入力です。
 */
export type CreateSavedWorkspaceViewInput = {
  /**
   * View の表示名です。
   */
  name: string
  /**
   * View の補足説明です。
   */
  description?: string
  /**
   * View の共有範囲です。
   */
  visibility: SavedViewVisibility
  /**
   * Team view の共有先 Team ID です。
   */
  teamId?: string
  /**
   * 保存する Workspace search filter です。
   */
  filters: WorkspaceSearchFilters
  /**
   * 保存する view layout です。
   */
  layout: SearchViewLayout
  /**
   * 作成と同時に現在 user の favorite にするかどうかです。
   */
  favorite?: boolean
  /**
   * 作成と同時に現在 userの pin 対象にするかどうかです。
   */
  pinned?: boolean
  /**
   * 作成と同時に現在 user の default view にするかどうかです。
   */
  isDefault?: boolean
}

/**
 * Saved Workspace view と現在 user の preference を更新する入力です。
 */
export type UpdateSavedWorkspaceViewInput = {
  /**
   * 読み込み時点の saved view revision です。
   */
  expectedRevision: number
  /**
   * 更新後の view 表示名です。
   */
  name?: string
  /**
   * 更新後の補足説明です。null で削除します。
   */
  description?: string | null
  /**
   * 更新後の共有範囲です。
   */
  visibility?: SavedViewVisibility
  /**
   * 更新後の共有先 Team ID です。null で解除します。
   */
  teamId?: string | null
  /**
   * 更新後の Workspace search filter です。
   */
  filters?: WorkspaceSearchFilters
  /**
   * 更新後の view layout です。
   */
  layout?: SearchViewLayout
  /**
   * 現在 user の favorite preference です。
   */
  favorite?: boolean
  /**
   * 現在 user の pin preference です。
   */
  pinned?: boolean
  /**
   * 現在 user の default preference です。
   */
  isDefault?: boolean
}

/**
 * Work Item の進捗状態です。
 */
export type WorkItemStatus = 'in-progress' | 'review' | 'todo' | 'done'

/**
 * Work Item の優先度です。
 */
export type WorkItemPriority = 'high' | 'medium' | 'low'

/**
 * Work Item の保存元です。
 */
export type WorkItemSource = 'dynamodb' | 'legacy'

/**
 * Work Item に関連する approval の集計です。
 */
export type ApprovalSummary = {
  /**
   * 判断待ち approval 件数です。
   */
  pendingCount: number
  /**
   * 期限を過ぎた判断待ち approval 件数です。
   */
  overdueCount: number
  /**
   * 承認済み approval 件数です。
   */
  approvedCount: number
  /**
   * 却下済み approval 件数です。
   */
  rejectedCount: number
  /**
   * 変更要求中 approval 件数です。
   */
  changesRequestedCount: number
  /**
   * 判断待ち approval の最も近い期限です。
   */
  nextDueAt?: string
}

/**
 * Team が所有する canonical Work Item の API contract です。
 *
 * @typeParam TTitleKey - legacy seed の表示文言を解決する key の型です。
 */
export type WorkItem<TTitleKey extends string = string> = {
  /**
   * contract の schema version です。
   */
  schemaVersion: typeof WORK_ITEM_SCHEMA_VERSION
  /**
   * optimistic concurrency に使う単調増加 revision です。
   */
  revision: number
  /**
   * Work Item を識別する ID です。
   */
  id: string
  /**
   * Work Item を所有する Team ID です。
   */
  teamId: string
  /**
   * Work Item の遂行先として割り当てられた Project ID です。
   */
  assignedProjectId?: string
  /**
   * API から取得した literal のタイトルです。
   */
  title?: string
  /**
   * legacy seed のタイトルを解決する表示文言 key です。
   */
  titleKey?: TTitleKey
  /**
   * Work Item の詳細説明です。
   */
  description?: string
  /**
   * 担当者を参照する Workspace user ID です。
   */
  assigneeUserId?: string
  /**
   * 担当者のメールアドレスです。
   */
  assigneeEmail?: string
  /**
   * 担当者の表示名です。
   */
  assigneeName?: string
  /**
   * legacy row に保存された担当者の literal 表示名です。
   */
  assignee?: string
  /**
   * legacy seed の担当者名を解決する表示文言 key です。
   */
  assigneeKey?: TTitleKey
  /**
   * Work Item の進捗状態です。
   */
  status: WorkItemStatus
  /**
   * Work Item の期限日です。
   */
  dueDate: string
  /**
   * Work Item の優先度です。
   */
  priority: WorkItemPriority
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt?: string
  /**
   * 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt?: string
  /**
   * File approval の現在状態を Workspace Inbox / report へ投影する集計です。
   */
  approvalSummary?: ApprovalSummary
  /**
   * canonical table または legacy compatibility adapter の保存元です。
   */
  source: WorkItemSource
}

/**
 * canonical Work Item 作成 API の入力です。
 */
export type CreateWorkItemInput = {
  /**
   * Work Item のタイトルです。
   */
  title: string
  /**
   * Work Item の詳細説明です。
   */
  description?: string
  /**
   * 遂行先 Project ID です。
   */
  assignedProjectId?: string
  /**
   * 担当者を参照する Workspace user ID です。
   */
  assigneeUserId: string
  /**
   * Work Item の進捗状態です。
   */
  status: WorkItemStatus
  /**
   * Work Item の期限日です。
   */
  dueDate: string
  /**
   * Work Item の優先度です。
   */
  priority: WorkItemPriority
}

/**
 * canonical Work Item に適用できる変更内容です。
 */
export type WorkItemPatch = {
  /**
   * 変更後のタイトルです。
   */
  title?: string
  /**
   * 変更後の詳細説明です。
   */
  description?: string
  /**
   * 変更後の遂行先 Project ID です。null で未割り当てに戻します。
   */
  assignedProjectId?: string | null
  /**
   * 変更後の担当者 ID です。
   */
  assigneeUserId?: string
  /**
   * 変更後の進捗状態です。
   */
  status?: WorkItemStatus
  /**
   * 変更後の期限日です。
   */
  dueDate?: string
  /**
   * 変更後の優先度です。
   */
  priority?: WorkItemPriority
}

/**
 * optimistic concurrency を伴う canonical Work Item 更新 API の入力です。
 */
export type UpdateWorkItemInput = WorkItemPatch & {
  /**
   * 読み込み時点の Work Item revision です。
   */
  expectedRevision: number
}

/**
 * File を関連付ける resource 種別です。
 */
export type FileAttachmentTargetType = 'work-item' | 'comment' | 'project'

/**
 * Object scan と利用可否をまとめた状態です。
 */
export type FileScanStatus = 'pending' | 'scanning' | 'available' | 'blocked' | 'failed'

/**
 * Browser で位置付き preview を提供できる media 種別です。
 */
export type FilePreviewKind = 'image' | 'pdf' | 'video' | 'none'

/**
 * File version の API 表現です。
 */
export type FileVersion = {
  /**
   * File version ID です。
   */
  id: string
  /**
   * 同一 File 内で単調増加する version 番号です。
   */
  number: number
  /**
   * 利用者へ表示する file 名です。
   */
  fileName: string
  /**
   * Upload 時に検証した media type です。
   */
  contentType: string
  /**
   * Object の byte 数です。
   */
  sizeBytes: number
  /**
   * Object scan の現在状態です。
   */
  scanStatus: FileScanStatus
  /**
   * Browser preview の種別です。
   */
  previewKind: FilePreviewKind
  /**
   * Version を作成した Workspace member key です。
   */
  createdByMemberKey: string
  /**
   * Version 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * S3 upload を検証した日時です。
   */
  verifiedAt?: string
}

/**
 * File 単位で現在 user に許可された操作です。
 */
export type FileAttachmentCapabilities = {
  /**
   * Clean な version の download URL を発行できるかどうかです。
   */
  canDownload: boolean
  /**
   * 新しい version を upload できるかどうかです。
   */
  canUploadVersion: boolean
  /**
   * File を soft delete できるかどうかです。
   */
  canDelete: boolean
  /**
   * Version に位置付き annotation を追加できるかどうかです。
   */
  canAnnotate: boolean
  /**
   * Version の approval を依頼できるかどうかです。
   */
  canRequestApproval: boolean
}

/**
 * Work Item、comment、project に関連付けた File です。
 */
export type FileAttachment = {
  /**
   * File ID です。
   */
  id: string
  /**
   * File の表示名です。
   */
  name: string
  /**
   * File を関連付けた resource 種別です。
   */
  targetType: FileAttachmentTargetType
  /**
   * Work Item、comment、project の公開 ID です。
   */
  targetId: string
  /**
   * 保存済み version 数です。
   */
  versionCount: number
  /**
   * 新しい順に並べた version 一覧です。
   */
  versions: FileVersion[]
  /**
   * 現在の version です。
   */
  currentVersion: FileVersion
  /**
   * File 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * File 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * Soft delete された日時です。
   */
  deletedAt?: string
  /**
   * 認証済み Workspace guest への read が明示的に許可されているかどうかです。
   */
  guestAccess?: boolean
  /**
   * Retention 後に物理削除できる日時です。
   */
  retentionUntil?: string
  /**
   * 現在 user に許可された操作です。
   */
  capabilities: FileAttachmentCapabilities
}

/**
 * Preview 上の annotation 位置です。
 */
export type AnnotationAnchor = {
  /**
   * Anchor を解釈する preview 種別です。
   */
  kind: 'image' | 'pdf' | 'video'
  /**
   * Image/PDF 幅に対する 0..1 の X 座標です。
   */
  x?: number
  /**
   * Image/PDF 高さに対する 0..1 の Y 座標です。
   */
  y?: number
  /**
   * PDF の 1 始まり page 番号です。
   */
  pageNumber?: number
  /**
   * Video 内の millisecond 単位の位置です。
   */
  timecodeMs?: number
}

/**
 * Annotation 単位で現在 user に許可された操作です。
 */
export type FileAnnotationCapabilities = {
  /**
   * Annotation を resolve できるかどうかです。
   */
  canResolve: boolean
}

/**
 * File version preview 上の位置付き review comment です。
 */
export type FileAnnotation = {
  /**
   * Annotation ID です。
   */
  id: string
  /**
   * 対象 File ID です。
   */
  fileId: string
  /**
   * 対象 version ID です。
   */
  versionId: string
  /**
   * Preview 上の位置です。
   */
  anchor: AnnotationAnchor
  /**
   * Markdown source の review comment です。
   */
  bodyMarkdown: string
  /**
   * 作成者の Workspace member key です。
   */
  authorMemberKey: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * Resolve された日時です。
   */
  resolvedAt?: string
  /**
   * 現在 user に許可された操作です。
   */
  capabilities: FileAnnotationCapabilities
}

/**
 * Reviewer 個人の判断状態です。
 */
export type ApprovalReviewerStatus = 'pending' | 'approved' | 'rejected' | 'changes-requested'

/**
 * Approval request 全体の状態です。
 */
export type ApprovalRequestStatus = ApprovalReviewerStatus | 'cancelled'

/**
 * Approval reviewer の現在状態です。
 */
export type ApprovalReviewer = {
  /**
   * Reviewer の Workspace member key です。
   */
  memberKey: string
  /**
   * Reviewer の判断状態です。
   */
  status: ApprovalReviewerStatus
  /**
   * 最後に判断した日時です。
   */
  decidedAt?: string
  /**
   * 判断時に添えた comment です。
   */
  comment?: string
}

/**
 * Approval 単位で現在 user に許可された操作です。
 */
export type ApprovalCapabilities = {
  /**
   * 現在 user が reviewer decision を保存できるかどうかです。
   */
  canDecide: boolean
  /**
   * Approval request を cancel できるかどうかです。
   */
  canCancel: boolean
}

/**
 * 特定 File version に対する approval request です。
 */
export type ApprovalRequest = {
  /**
   * Approval ID です。
   */
  id: string
  /**
   * Reviewer Inbox から遷移する Team ID です。
   */
  teamId?: string
  /**
   * Reviewer Inbox から遷移する Work Item ID です。
   */
  issueId?: string
  /**
   * 現在の認可を再検証する assigned Project ID です。
   */
  projectId?: string
  /**
   * Optimistic concurrency に使う revision です。
   */
  revision: number
  /**
   * 対象 File ID です。
   */
  fileId: string
  /**
   * 対象 version ID です。
   */
  versionId: string
  /**
   * Approval 全体の状態です。
   */
  status: ApprovalRequestStatus
  /**
   * Reviewer と個別判断です。
   */
  reviewers: ApprovalReviewer[]
  /**
   * 判断期限の ISO 8601 timestamp です。
   */
  dueAt: string
  /**
   * Request 作成者の Workspace member key です。
   */
  requestedByMemberKey: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * Approval 完了日時です。
   */
  completedAt?: string
  /**
   * 現在 user に許可された操作です。
   */
  capabilities: ApprovalCapabilities
}
