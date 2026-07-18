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
   * File approval の現在状態を Workspace Inbox / report へ投影する集計です。
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
 * Public API と developer platform の共有 contract です。
 */
export * from './developer-platform'

/**
 * Public API の OpenAPI 3.1 document です。
 */
export * from './openapi'
