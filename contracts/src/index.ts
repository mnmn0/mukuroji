export * from './automation'
export * from './enterprise-identity'

/**
 * 現在の canonical Work Item schema version です。
 */
export const WORK_ITEM_SCHEMA_VERSION = 1 as const

/**
 * Document、Wiki、Whiteboard の canonical schema version です。
 */
export const DOCUMENT_SCHEMA_VERSION = 1 as const

/**
 * DynamoDB transaction headroom を保証する Document operation batch 上限です。
 */
export const DOCUMENT_OPERATION_BATCH_LIMIT = 4 as const

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
 * Work Item configuration の現行 schema version です。
 */
export const WORK_ITEM_CONFIGURATION_SCHEMA_VERSION = 1 as const

/**
 * Work Item の進捗状態です。
 */
export type WorkItemStatus = 'in-progress' | 'review' | 'todo' | 'done'

/**
 * Work Item の優先度です。
 */
export type WorkItemPriority = 'high' | 'medium' | 'low'

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
 * Workflow status を横断集計するための標準 category です。
 */
export type WorkflowStatusCategory =
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled'

/**
 * Workflow に含まれる status の定義です。
 */
export type WorkflowStatusDefinition = {
  /** Workflow 内で status を識別する ID です。 */
  id: string
  /** UI に表示する status 名です。 */
  name: string
  /** List/report を横断して利用する標準 category です。 */
  category: WorkflowStatusCategory
  /** Workflow 内の表示順です。 */
  sortOrder: number
  /** UI 表示に利用できる色 token です。 */
  color?: string
}

/**
 * Workflow で許可する status transition です。
 */
export type WorkflowTransition = {
  /** 遷移元 status ID です。 */
  fromStatusId: string
  /** 遷移先 status ID です。 */
  toStatusId: string
}

/**
 * Work Item に適用する workflow 定義です。
 */
export type WorkflowDefinition = {
  /** Workflow を識別する ID です。 */
  id: string
  /** UI に表示する workflow 名です。 */
  name: string
  /** Work Item 作成時に適用する status ID です。 */
  initialStatusId: string
  /** Workflow で利用できる status 一覧です。 */
  statuses: WorkflowStatusDefinition[]
  /** Workflow で許可する transition 一覧です。 */
  transitions: WorkflowTransition[]
}

/**
 * Custom field が保存する値の種別です。
 */
export type CustomFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'multi-select'
  | 'person'
  | 'currency'
  | 'duration'
  | 'formula'

/**
 * Select 系 custom field の選択肢です。
 */
export type CustomFieldOption = {
  /** Definition 内で option を識別する ID です。 */
  id: string
  /** UI に表示する option 名です。 */
  name: string
  /** Option の表示順です。 */
  sortOrder: number
  /** UI 表示に利用できる色 token です。 */
  color?: string
}

/**
 * Custom field value に適用する validation rule です。
 */
export type CustomFieldValidation = {
  /** 数値 value の最小値です。 */
  min?: number
  /** 数値 value の最大値です。 */
  max?: number
  /** 文字列または配列 value の最小長です。 */
  minLength?: number
  /** 文字列または配列 value の最大長です。 */
  maxLength?: number
  /** Text value に適用する JavaScript regular expression source です。 */
  pattern?: string
}

/**
 * Duration custom field の保存単位です。
 */
export type CustomFieldDurationUnit = 'minutes' | 'hours' | 'days'

/**
 * Custom field に保存できる JSON value です。
 */
export type CustomFieldValue = string | number | boolean | string[]

/**
 * Work Item custom field の定義です。
 */
export type CustomFieldDefinition = {
  /** Configuration 内で field を識別する ID です。 */
  id: string
  /** UI に表示する field 名です。 */
  name: string
  /** Field value の型です。 */
  type: CustomFieldType
  /** Field の表示順です。 */
  sortOrder: number
  /** Applicable Work Item で value を必須にするかどうかです。 */
  required: boolean
  /** Work Item 作成時に補完する既定値です。 */
  defaultValue?: CustomFieldValue
  /** Select 系 field で利用できる option 一覧です。 */
  options?: CustomFieldOption[]
  /** Field value に適用する validation rule です。 */
  validation?: CustomFieldValidation
  /** Field を適用する Project ID 一覧です。省略時は全 Project に適用します。 */
  projectIds?: string[]
  /** Currency value に適用する ISO 4217 currency code です。 */
  currencyCode?: string
  /** Duration value の保存単位です。 */
  durationUnit?: CustomFieldDurationUnit
  /** Formula field を評価する安全な算術式です。 */
  formulaExpression?: string
}

/**
 * Work Item configuration の永続化 scope です。
 */
export type WorkItemConfigurationScopeType = 'workspace' | 'team'

/**
 * Workspace または Team に保存する Work Item configuration です。
 */
export type WorkItemConfiguration = {
  /** Configuration を保存する scope 種別です。 */
  scopeType: WorkItemConfigurationScopeType
  /** Workspace ID または Team ID です。 */
  scopeId: string
  /** Configuration schema version です。 */
  schemaVersion: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  /** Optimistic concurrency に使う単調増加 revision です。 */
  revision: number
  /** Scope で利用する workflow です。 */
  workflow: WorkflowDefinition
  /** Scope で利用する custom field 一覧です。 */
  customFields: CustomFieldDefinition[]
  /** 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt?: string
}

/**
 * Team override、Workspace 継承、built-in default の解決結果です。
 */
export type ResolvedWorkItemConfiguration = {
  /** Work Item mutation の検証に利用する解決済み configuration です。 */
  configuration: WorkItemConfiguration
  /** Team configuration が無い場合に利用した継承元です。 */
  inheritedFrom?: 'workspace' | 'default'
}

/**
 * Work Item 間で管理できる relation 種別です。
 */
export type WorkItemRelationType =
  | 'parent'
  | 'child'
  | 'blocks'
  | 'blockedBy'
  | 'related'
  | 'duplicate'

/**
 * Work Item から別の Work Item への relation です。
 */
export type WorkItemRelation = {
  /** Relation の起点 Work Item ID です。 */
  sourceWorkItemId: string
  /** Relation の向きと意味です。 */
  type: WorkItemRelationType
  /** Relation の終点 Work Item ID です。 */
  targetWorkItemId: string
  /** Relation の作成日時です。 */
  createdAt?: string
}

/**
 * Relation 作成・削除 API の共通入力です。
 */
export type WorkItemRelationMutationInput = {
  /** 起点から見た relation 種別です。 */
  type: WorkItemRelationType
  /** Relation の終点 Work Item ID です。 */
  targetWorkItemId: string
  /** 読み込み時点の Team relation graph revision です。 */
  expectedGraphRevision: number
}

/**
 * Relation 作成・削除 API の response です。
 */
export type WorkItemRelationMutationResponse = {
  /** 起点 Work Item から見た relation です。 */
  relation: WorkItemRelation
  /** 終点 Work Item に保存する reciprocal relation です。 */
  reciprocalRelation: WorkItemRelation
  /** Mutation 後の Team relation graph revision です。 */
  graphRevision: number
}

/**
 * Work Item relation 一覧 API の response です。
 */
export type WorkItemRelationsResponse = {
  /** 起点 Work Item に保存された relation 一覧です。 */
  relations: WorkItemRelation[]
  /** 読み込み時点の Team relation graph revision です。 */
  graphRevision: number
}

/**
 * Canonical Work Item が共有する field です。
 */
type WorkItemBase = {
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
   * Reversible bulk archive を適用した ISO 8601 timestamp です。
   */
  archivedAt?: string
  /**
   * Archive mutation を実行した Workspace member key です。
   */
  archivedBy?: string
  /**
   * Work Item approval の現在状態を Workspace Inbox / report へ投影する集計です。
   */
  approvalSummary?: ApprovalSummary
}

/** DynamoDB に保存された canonical Work Item の API contract です。 */
export type CanonicalWorkItem = WorkItemBase & {
  /** API から取得した literal のタイトルです。 */
  title: string
  /** Canonical Work Item は表示文言 key を持ちません。 */
  titleKey?: never
  /** 担当者を参照する Workspace user ID です。 */
  assigneeUserId: string
  /** Work Item を作成した Workspace member key です。 */
  creatorMemberKey: string
  /** Request intake から作成された場合の source submission ID です。 */
  sourceRequestId?: string
  /** Canonical Work Item は legacy の担当者 literal を持ちません。 */
  assignee?: never
  /** Canonical Work Item は legacy の担当者表示文言 key を持ちません。 */
  assigneeKey?: never
  /** Canonical Work Item は旧固定 status を持ちません。 */
  status?: never
  /** Configuration workflow 内の status ID です。 */
  workflowStatusId: string
  /** List/report の横断集計に利用する標準 status category です。 */
  statusCategory: WorkflowStatusCategory
  /** Value を検証した workflow configuration schema version です。 */
  workflowSchemaVersion: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  /** Work Item に保存された custom field value です。 */
  customFieldValues: Record<string, CustomFieldValue>
  /** Relation Graph から同期した search/filter 用の派生 relation ID 一覧です。 */
  relationIds: string[]
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
  /** Canonical table を保存元とすることを表します。 */
  source: 'dynamodb'
}

/** Canonical Team/project/Workspace API と画面が共有する Work Item です。 */
export type WorkItem = CanonicalWorkItem

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
   * 作成時に適用する workflow status ID です。
   */
  workflowStatusId?: string
  /**
   * 作成時に保存する custom field value です。
   */
  customFieldValues?: Record<string, CustomFieldValue>
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
   * 変更後の workflow status ID です。
   */
  workflowStatusId?: string
  /**
   * Field ID ごとの変更値です。null は value の削除を表します。
   */
  customFieldValues?: Record<string, CustomFieldValue | null>
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
 * Request form、submission、thread、email ingestion の公開契約です。
 */
export * from './request-intake'

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
 * Approval が判断対象にする resource の種別です。
 */
export type ApprovalSubjectType = 'file-version' | 'work-item'

/**
 * Approval request を作成した主体の種別です。
 */
export type ApprovalRequesterKind = 'member' | 'service'

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
 * Approval request が判断対象にする resource です。
 */
type ApprovalSubject =
  | {
      /**
       * File version approval を示します。
       */
      subjectType: Extract<ApprovalSubjectType, 'file-version'>
      /**
       * 対象 File ID です。
       */
      fileId: string
      /**
       * 対象 version ID です。
       */
      versionId: string
    }
  | {
      /**
       * Work Item approval を示します。
       */
      subjectType: Extract<ApprovalSubjectType, 'work-item'>
      /**
       * Work Item subject では指定しません。
       */
      fileId?: never
      /**
       * Work Item subject では指定しません。
       */
      versionId?: never
    }

/**
 * Work Item 自体または特定 File version に対する approval request です。
 */
export type ApprovalRequest = ApprovalSubject & {
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
   * Requester が Workspace member か automation などの service かを示します。
   */
  requestedByKind: ApprovalRequesterKind
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

/** Planning domain の現行 schema version です。 */
export const PLANNING_SCHEMA_VERSION = 1 as const

/** Planning hierarchy に保存できる entity 種別です。 */
export type PlanningEntityType =
  | 'cycle'
  | 'milestone'
  | 'release'
  | 'phase'
  | 'goal'
  | 'initiative'
  | 'roadmap'
  | 'portfolio'

/** Planning entity の lifecycle status です。 */
export type PlanningEntityStatus =
  | 'proposed'
  | 'planned'
  | 'active'
  | 'paused'
  | 'completed'
  | 'canceled'

/** Planning entity の健全性です。 */
export type PlanningHealth = 'unknown' | 'on-track' | 'at-risk' | 'off-track'

/** Planning entity の risk level です。 */
export type PlanningRisk = 'none' | 'low' | 'medium' | 'high' | 'critical'

/** Planning entity の progress 算出方法です。 */
export type PlanningProgressMode = 'automatic' | 'manual'

/** Baseline / forecast で共有する inclusive な calendar date range です。 */
export type PlanningDateRange = {
  /** Range の開始日を表す `YYYY-MM-DD` です。 */
  startDate: string
  /** Range の終了日を表す `YYYY-MM-DD` です。 */
  endDate: string
}

/** Cycle を連続生成するときの cadence です。 */
export type PlanningCadence = {
  /** Cadence の calendar unit です。 */
  unit: 'week' | 'month'
  /** 1 cycle を構成する unit 数です。 */
  count: number
}

/** Cycle 終了時の未完了 Work Item の扱いです。 */
export type CycleCarryOverPolicy = 'move-incomplete' | 'keep-incomplete'

/** Goal / OKR hierarchy での entity の役割です。 */
export type PlanningGoalFramework = 'goal' | 'objective' | 'key-result'

/** Planning entity に追記する status update です。 */
export type PlanningStatusUpdate = {
  /** Entity 内で status update を識別する ID です。 */
  id: string
  /** Update 本文です。 */
  message: string
  /** Update を作成した Workspace member key です。 */
  authorMemberKey: string
  /** Update 時点で明示された health です。 */
  health?: PlanningHealth
  /** Update 時点で明示された risk です。 */
  risk?: PlanningRisk
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
}

/** Planning hierarchy に保存する versioned entity です。 */
export type PlanningEntity = {
  /** Workspace 内で entity を識別する ID です。 */
  id: string
  /** Entity の planning 種別です。 */
  type: PlanningEntityType
  /** UI に表示する title です。 */
  title: string
  /** Entity の説明です。UTF-8 で20 KBまでです。 */
  description?: string
  /** Hierarchy 上の親 entity ID です。 */
  parentId?: string
  /** Team scope の entity が参照する Team ID です。 */
  teamId?: string
  /** Project scope の entity が参照する Project ID です。 */
  projectId?: string
  /** Entity owner の Workspace member key です。 */
  ownerMemberKey: string
  /** Entity の lifecycle status です。 */
  status: PlanningEntityStatus
  /** Entity 自身に設定された health です。 */
  health: PlanningHealth
  /** 子孫を含めて算出した worst health です。 */
  rollupHealth: PlanningHealth
  /** Entity 自身に設定された risk level です。 */
  risk: PlanningRisk
  /** Progress の算出方法です。 */
  progressMode: PlanningProgressMode
  /** Manual mode で指定する 0 以上 100 以下の progress です。 */
  manualProgress?: number
  /** Read 時に算出した 0 以上 100 以下の progress です。 */
  progress: number
  /** Entity 直下または子孫から roll-up した一意な Work Item 件数です。 */
  linkedWorkItemCount: number
  /** 計画承認時点などに固定した baseline range です。 */
  baseline: PlanningDateRange
  /** 現在予測している forecast range です。 */
  forecast: PlanningDateRange
  /** Cycle の繰り返し間隔です。 */
  cadence?: PlanningCadence
  /** Cycle が保持できる Work Item 件数の非負整数です。 */
  capacity?: number
  /** Cycle rollover 時の未完了 Work Item policy です。 */
  carryOverPolicy?: CycleCarryOverPolicy
  /** Goal/OKR hierarchy 上の役割です。 */
  goalFramework?: PlanningGoalFramework
  /** 新しい順に最大32件保持する status update 一覧です。 */
  statusUpdates: PlanningStatusUpdate[]
  /** Soft archive した日時の ISO 8601 timestamp です。 */
  archivedAt?: string
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
}

/** Planning dependency の scheduling 制約です。 */
export type PlanningDependencyType =
  | 'finish-to-start'
  | 'start-to-start'
  | 'finish-to-finish'

/** Planning entity 間の directed dependency です。 */
export type PlanningDependency = {
  /** Workspace 内で dependency を識別する ID です。 */
  id: string
  /** Dependency の先行 entity ID です。 */
  predecessorId: string
  /** Dependency の後続 entity ID です。 */
  successorId: string
  /** Scheduling 制約の種別です。 */
  type: PlanningDependencyType
  /** 制約へ加算する calendar day 数です。 */
  lagDays: number
  /** 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
}

/** Planning entity と canonical Work Item の関連です。 */
export type PlanningWorkItemLink = {
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Team 内の Work Item ID です。 */
  workItemId: string
  /** Work Item の遂行先 Project ID です。 */
  projectId?: string
  /** Work Item が所属する Cycle ID です。 */
  cycleId?: string
  /** Work Item が寄与する Milestone ID です。 */
  milestoneId?: string
  /** Work Item が寄与する Goal / OKR entity ID 一覧です。 */
  goalIds: string[]
  /** Link 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
}

/** Roll-up と critical path に必要な canonical Work Item projection です。 */
export type PlanningWorkItemSummary = {
  /** Team 内の Work Item ID です。 */
  id: string
  /** Planning mutation の transaction condition に使う canonical revision です。 */
  revision: number
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Work Item title です。 */
  title: string
  /** Work Item の遂行先 Project ID です。 */
  projectId?: string
  /** Workflow を横断して利用する status category です。 */
  statusCategory: WorkflowStatusCategory
  /** Work Item 期限日です。 */
  dueDate: string
}

/** Planning snapshot から算出した critical path です。 */
export type PlanningCriticalPath = {
  /** Critical path 上の entity ID を先頭から並べた配列です。 */
  entityIds: string[]
  /** Critical path の合計 calendar day 数です。 */
  totalDurationDays: number
  /** Entity ID ごとの total slack day 数です。 */
  slackByEntityId: Record<string, number>
}

/** Planning API が返す Workspace 単位の整合した snapshot です。 */
export type PlanningSnapshot = {
  /** Snapshot schema version です。 */
  schemaVersion: typeof PLANNING_SCHEMA_VERSION
  /** Workspace planning graph の optimistic concurrency revision です。 */
  revision: number
  /** Archive 済みを含む planning entity 一覧です。 */
  entities: PlanningEntity[]
  /** Entity 間 dependency 一覧です。 */
  dependencies: PlanningDependency[]
  /** Planning entity と Work Item の link 一覧です。 */
  workItemLinks: PlanningWorkItemLink[]
  /** Roll-up に利用した Work Item projection 一覧です。 */
  workItems: PlanningWorkItemSummary[]
  /** Snapshot から算出した critical path です。 */
  criticalPath: PlanningCriticalPath
  /** 永続化済み graph の最終更新日時です。 */
  updatedAt?: string
}

/** Planning entity 作成 API の入力です。 */
export type CreatePlanningEntityInput = {
  /** 新しい entity ID です。 */
  id: string
  /** 新しい entity の種別です。 */
  type: PlanningEntityType
  /** 新しい entity の title です。 */
  title: string
  /** 新しい entity の説明です。 */
  description?: string
  /** Hierarchy 上の親 entity ID です。 */
  parentId?: string
  /** Team scope の Team ID です。 */
  teamId?: string
  /** Project scope の Project ID です。 */
  projectId?: string
  /** Owner の Workspace member key です。 */
  ownerMemberKey: string
  /** 初期 lifecycle status です。 */
  status: PlanningEntityStatus
  /** 初期 health です。 */
  health: PlanningHealth
  /** 初期 risk level です。 */
  risk: PlanningRisk
  /** Progress の算出方法です。 */
  progressMode: PlanningProgressMode
  /** Manual mode の progress です。 */
  manualProgress?: number
  /** Baseline range です。 */
  baseline: PlanningDateRange
  /** Forecast range です。 */
  forecast: PlanningDateRange
  /** Cycle cadence です。 */
  cadence?: PlanningCadence
  /** Cycle が保持できる Work Item 件数の非負整数です。 */
  capacity?: number
  /** Cycle rollover policy です。 */
  carryOverPolicy?: CycleCarryOverPolicy
  /** Goal/OKR hierarchy 上の役割です。 */
  goalFramework?: PlanningGoalFramework
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning entity に適用できる field patch です。 */
export type PlanningEntityPatch = {
  /** 変更後の title です。 */
  title?: string
  /** 変更後の20 KB以下の description です。null で削除します。 */
  description?: string | null
  /** 変更後の owner Workspace member key です。 */
  ownerMemberKey?: string
  /** 変更後の lifecycle status です。 */
  status?: PlanningEntityStatus
  /** 変更後の health です。 */
  health?: PlanningHealth
  /** 変更後の risk level です。 */
  risk?: PlanningRisk
  /** 変更後の progress mode です。 */
  progressMode?: PlanningProgressMode
  /** 変更後の manual progress です。null で削除します。 */
  manualProgress?: number | null
  /** 変更後の baseline range です。 */
  baseline?: PlanningDateRange
  /** 変更後の forecast range です。 */
  forecast?: PlanningDateRange
  /** 変更後の Cycle cadence です。 */
  cadence?: PlanningCadence
  /** 変更後の Work Item 件数単位の Cycle capacity です。 */
  capacity?: number
  /** 変更後の Cycle rollover policy です。 */
  carryOverPolicy?: CycleCarryOverPolicy
  /** 変更後の Goal/OKR hierarchy 上の役割です。 */
  goalFramework?: PlanningGoalFramework
}

/** Planning entity 更新 API の入力です。 */
export type UpdatePlanningEntityInput = {
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
  /** Entity に適用する field patch です。 */
  patch: PlanningEntityPatch
}

/** Planning dependency 作成 API の入力です。 */
export type CreatePlanningDependencyInput = {
  /** 新しい dependency ID です。 */
  id: string
  /** 先行 entity ID です。 */
  predecessorId: string
  /** 後続 entity ID です。 */
  successorId: string
  /** Scheduling 制約の種別です。 */
  type: PlanningDependencyType
  /** 制約へ加算する非負 calendar day 数です。 */
  lagDays: number
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** ID を path で指定する planning mutation の revision 入力です。 */
export type PlanningRevisionInput = {
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning Work Item link upsert API の入力です。 */
export type PlanningWorkItemLinkInput = {
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Team 内の Work Item ID です。 */
  workItemId: string
  /** Work Item の遂行先 Project ID です。 */
  projectId?: string
  /** Work Item が所属する Cycle ID です。 */
  cycleId?: string
  /** Work Item が寄与する Milestone ID です。 */
  milestoneId?: string
  /** Work Item が寄与する Goal / OKR entity ID 一覧です。 */
  goalIds: string[]
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning entity 複製 API の入力です。 */
export type DuplicatePlanningEntityInput = {
  /** 複製後の entity ID です。 */
  targetId: string
  /** 複製後に上書きする title です。 */
  title?: string
  /** 複製後の親 entity ID です。 */
  parentId?: string
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning entity と子孫 subtree を原子的に move する API の入力です。 */
export type MovePlanningEntityInput = {
  /** Move 後の親 entity ID です。省略時は root へ移動します。 */
  parentId?: string
  /** Entity と子孫へ適用する Move 後の Team scope です。 */
  teamId?: string
  /** Entity と子孫へ適用する Move 後の Project scope です。 */
  projectId?: string
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning entity status update 追加 API の入力です。 */
export type PlanningStatusUpdateInput = {
  /** 新しい status update ID です。 */
  id: string
  /** Status update 本文です。 */
  message: string
  /** Update と同時に設定する health です。 */
  health?: PlanningHealth
  /** Update と同時に設定する risk level です。 */
  risk?: PlanningRisk
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Cycle rollover API の入力です。 */
export type CycleRolloverInput = {
  /** 未完了 Work Item の移動先 Cycle ID です。一度に検証できる link は49件までです。 */
  targetCycleId: string
  /** 読み込み時点の planning graph revision です。 */
  expectedRevision: number
}

/** Planning mutation の共通 response です。 */
export type PlanningMutationResponse = {
  /** Mutation 後に roll-up と critical path を再計算した snapshot です。 */
  planning: PlanningSnapshot
  /** Cycle rollover で移動した Work Item ID 一覧です。 */
  movedWorkItemIds: string[]
  /** Cycle rollover で元 Cycle に残した Work Item ID 一覧です。 */
  retainedWorkItemIds: string[]
}

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

/**
 * Analytics report、snapshot、metric API の公開契約です。
 */
export * from './analytics'
