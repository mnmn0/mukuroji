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
