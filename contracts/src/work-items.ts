/**
 * 現在の canonical Work Item schema version です。
 */
export const WORK_ITEM_SCHEMA_VERSION = 1 as const

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
 * Work Item custom field に保存できる JSON value です。
 */
export type CustomFieldValue = string | number | boolean | string[]

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
