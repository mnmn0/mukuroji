/**
 * Work Item configuration の現行 schema version です。
 */
export const WORK_ITEM_CONFIGURATION_SCHEMA_VERSION = 1 as const

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
  /** Built-in fields a Work Item must have before it enters this status; absent means none. */
  requiredFields?: import('./work-item-workflow-rules').WorkflowStatusRequiredField[]
  /** Custom fields a Work Item must have before it enters this status; absent means none. */
  requiredCustomFieldIds?: string[]
}

/**
 * Workflow で許可する status transition です。
 */
export type WorkflowTransition = {
  /** 遷移元 status ID です。 */
  fromStatusId: string
  /** 遷移先 status ID です。 */
  toStatusId: string
  /**
   * Roles that may run the transition; absent or empty lets anyone who can update the Work Item run it.
   * A restricted transition is run only by a person, never by an automation or a developer credential.
   */
  allowedActorRoles?: import('./work-item-workflow-rules').WorkflowTransitionActorRole[]
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
  /** Scope で利用する追加 workflow 一覧です。省略時は `workflow` のみを利用します。 */
  workflows?: WorkflowDefinition[]
  /** Scope で利用する custom field 一覧です。 */
  customFields: CustomFieldDefinition[]
  /** Scope で利用する Work Item Type 一覧です。省略時は built-in type を利用します。 */
  workItemTypes?: import('./work-item-types').WorkItemTypeDefinition[]
  /** Job roles contributors can be planned against; absent when the scope defines none. */
  jobRoles?: import('./work-item-contributors').WorkItemJobRoleDefinition[]
  /** How Work Item progress percentages are derived; absent means `status-category`. */
  progressMode?: import('./work-item-effort').WorkItemProgressMode
  /**
   * What happens when a parent is completed while a child is still open; absent means `warn`.
   */
  parentCompletionPolicy?: WorkItemParentCompletionPolicy
  /**
   * Conditions a Work Item must meet before it moves into the `completed` category; absent leaves
   * completion unchanged.
   */
  completionGate?: import('./work-item-completion-gate').WorkItemCompletionGatePolicy
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
 * How a Team treats completing a parent Work Item whose children are not all completed or canceled.
 *
 * - `warn`: the Web asks for confirmation; the server allows the change.
 * - `reject`: the server rejects the change with `409 WorkItemOpenChildren`.
 */
export type WorkItemParentCompletionPolicy = 'warn' | 'reject'

/** Parent completion policies in the order settings screens present them. */
export const WORK_ITEM_PARENT_COMPLETION_POLICIES: readonly WorkItemParentCompletionPolicy[] = [
  'warn',
  'reject',
]

/** Parent completion policy used when a Work Item configuration does not choose one. */
export const DEFAULT_WORK_ITEM_PARENT_COMPLETION_POLICY: WorkItemParentCompletionPolicy = 'warn'

/**
 * Returns whether a value is a supported parent completion policy.
 *
 * @param value - Candidate value.
 * @returns Whether it names one of {@link WORK_ITEM_PARENT_COMPLETION_POLICIES}.
 */
export function isWorkItemParentCompletionPolicy(
  value: unknown,
): value is WorkItemParentCompletionPolicy {
  return value === 'warn' || value === 'reject'
}
