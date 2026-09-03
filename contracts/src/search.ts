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
  | 'context-item'
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

/** Parts of a collision-safe Team-qualified Work Item Type filter key. */
export type SearchWorkItemTypeKeyParts = {
  /** Team that owns the Work Item Type. */
  teamId: string
  /** Stable Work Item Type identifier within the Team. */
  workItemTypeId: string
}

/**
 * Creates the canonical Team-qualified Work Item Type key used by Workspace Search.
 *
 * @param teamId - Team that owns the Work Item Type.
 * @param workItemTypeId - Stable Work Item Type identifier within the Team.
 * @returns Collision-safe filter key containing both identities.
 */
export function createSearchWorkItemTypeKey(
  teamId: string,
  workItemTypeId: string,
): string {
  return `${teamId}\0${workItemTypeId}`
}

/**
 * Reads a Team-qualified Work Item Type key without accepting malformed values.
 *
 * @param value - Candidate Search filter key.
 * @returns Parsed Team and Work Item Type identities, or undefined for an invalid key.
 */
export function readSearchWorkItemTypeKey(
  value: string,
): SearchWorkItemTypeKeyParts | undefined {
  const separatorIndex = value.indexOf('\0')
  if (
    separatorIndex <= 0 ||
    separatorIndex === value.length - 1 ||
    value.indexOf('\0', separatorIndex + 1) !== -1
  ) {
    return undefined
  }

  return {
    teamId: value.slice(0, separatorIndex),
    workItemTypeId: value.slice(separatorIndex + 1),
  }
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
  /**
   * Team-qualified Work Item Type keys (`teamId\0workItemTypeId`) の候補です。
   * Work Item 以外の entity には一致しません。
   */
  workItemTypeIds?: string[]
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
   * Work Item に適用された stable Work Item Type ID です。
   */
  workItemTypeId?: string
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
