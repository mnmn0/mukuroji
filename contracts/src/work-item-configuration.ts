import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type CustomFieldValue,
  type WorkflowDefinition,
} from './work-items'

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
