/** Analytics report、snapshot、metric response の現行 schema version です。 */
export const ANALYTICS_SCHEMA_VERSION = 1 as const

/** Analytics engine が計算できる標準 metric です。 */
export type AnalyticsMetricKey =
  | 'throughput'
  | 'cycle-time'
  | 'lead-time'
  | 'wip'
  | 'overdue'
  | 'scope-change'
  | 'velocity'
  | 'sla'

/** Analytics query が扱う inclusive な UTC instant range です。 */
export type AnalyticsDateRange = {
  /** Range の開始を表す ISO 8601 timestamp です。 */
  from: string
  /** Range の終了を表す ISO 8601 timestamp です。 */
  to: string
}

/** Analytics filter が custom field value に適用する条件です。 */
export type AnalyticsCustomFieldFilter = {
  /** Custom field definition の安定 ID です。 */
  fieldId: string
  /** Value に適用する比較方法です。 */
  operator:
    | 'equals'
    | 'not-equals'
    | 'contains'
    | 'greater-than'
    | 'greater-than-or-equal'
    | 'less-than'
    | 'less-than-or-equal'
    | 'is-empty'
    | 'is-not-empty'
  /** Empty 判定以外で比較する値です。 */
  value?: string | number | boolean | string[]
}

/**
 * Analytics fact と evidence に共通適用する filter です。
 *
 * @remarks
 * 現行 schema version では Project、assignee、status、custom field の state dimension は
 * query の `asOf` 時点で評価します。Event発生時点のdimensionではありません。
 */
export type AnalyticsFilter = {
  /** Event metric を評価する期間です。 */
  period: AnalyticsDateRange
  /** 対象 Team ID の許可一覧です。省略時は入力済みの全 Team を扱います。 */
  teamIds?: string[]
  /** 対象 Project ID の許可一覧です。省略時は入力済みの全 Project を扱います。 */
  projectIds?: string[]
  /** 対象 assignee user ID の許可一覧です。 */
  assigneeUserIds?: string[]
  /** 対象 workflow status category の許可一覧です。 */
  statusCategories?: string[]
  /** Custom field value に適用する条件一覧です。 */
  customFields?: AnalyticsCustomFieldFilter[]
  /** `asOf` 時点で archive 済みの Work Item を含めるかどうかです。 */
  includeArchived?: boolean
}

/** Widget result を分割する dimension です。 */
export type AnalyticsGroupBy =
  | {
      /** Calendar bucket または Work Item dimension です。 */
      dimension: 'day' | 'week' | 'month' | 'team' | 'project' | 'assignee' | 'status'
      /** Built-in dimension では custom field ID を指定しません。 */
      customFieldId?: never
    }
  | {
      /** Custom field value ごとに分割します。 */
      dimension: 'custom-field'
      /** Group key に利用する custom field definition ID です。 */
      customFieldId: string
    }

/** Report builder が配置する一つの widget です。 */
export type AnalyticsWidget = {
  /** Report 内で widget を識別する ID です。 */
  id: string
  /** Widget の表示形式です。 */
  type: 'metric' | 'chart' | 'table'
  /** Chart widget の可視化方法です。 */
  visualization?: 'line' | 'bar'
  /** Builder grid 上の widget size です。 */
  size?: 'small' | 'medium' | 'large'
  /** Widget の表示名です。 */
  title: string
  /** Widget が計算する標準 metric です。 */
  metric: AnalyticsMetricKey
  /** Result を任意の dimension で分割します。 */
  groupBy?: AnalyticsGroupBy
  /** SLA metric の達成判定に使う lead time 上限です。 */
  slaTargetHours?: number
}

/** 保存済み report の定期 snapshot 配信設定です。 */
export type AnalyticsSchedule = {
  /** Schedule を実行するかどうかです。 */
  enabled: boolean
  /** Schedule の繰り返し頻度です。 */
  frequency: 'daily' | 'weekly' | 'monthly'
  /** Local wall-clock を解釈する IANA timezone ID です。 */
  timeZone: string
  /** 配信時刻を表す `HH:mm` です。 */
  localTime: string
  /** Weekly schedule の曜日です。0 は日曜日です。 */
  dayOfWeek?: number
  /** Monthly schedule の日です。 */
  dayOfMonth?: number
  /** Delivery を受け取る Workspace member key 一覧です。 */
  recipientMemberKeys: string[]
  /** Delivery artifact の形式です。 */
  format: 'csv' | 'pdf'
  /** 次に実行する UTC instant です。 */
  nextRunAt?: string
}

/** 保存・共有できる analytics report definition です。 */
export type AnalyticsReport = {
  /** Report schema version です。 */
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION
  /** Workspace 内の report ID です。 */
  id: string
  /** Report を所有する Workspace ID です。 */
  workspaceId: string
  /** Report の表示名です。 */
  name: string
  /** Report の説明です。 */
  description?: string
  /** Report の共有範囲です。 */
  visibility: 'personal' | 'team' | 'shared'
  /** Team visibility が参照する Team ID です。 */
  teamId?: string
  /** Report を作成した Workspace member key です。 */
  ownerMemberKey: string
  /** Report の期間 bucket と date-only field を解釈する IANA timezone です。 */
  timeZone: string
  /** Optimistic concurrency revision です。 */
  revision: number
  /** 全 widget に適用する filter です。 */
  filter: AnalyticsFilter
  /** Forecast risk と比較する保存済み baseline です。 */
  forecastBaseline?: AnalyticsDateRange
  /** Builder で並べる widget 一覧です。 */
  widgets: AnalyticsWidget[]
  /** 任意の定期配信設定です。 */
  schedule?: AnalyticsSchedule
  /** Report 作成日時です。 */
  createdAt: string
  /** Report 最終更新日時です。 */
  updatedAt: string
}

/** Analytics report 一覧 API の response です。 */
export type AnalyticsReportListResponse = {
  /** Caller が認可済みの report 一覧です。 */
  reports: AnalyticsReport[]
  /** 続きがある場合の Workspace-bound opaque cursor です。 */
  nextCursor?: string
}

/** Analytics report 作成 API の入力です。 */
export type CreateAnalyticsReportInput = {
  /** Workspace 内で一意な route-safe ID です。`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` に従います。 */
  id: string
  /** Report の表示名です。 */
  name: string
  /** Report の説明です。 */
  description?: string
  /** Report の共有範囲です。 */
  visibility: 'personal' | 'team' | 'shared'
  /** Team visibility が参照する Team ID です。 */
  teamId?: string
  /** Report の期間 bucket と date-only field を解釈する IANA timezone です。 */
  timeZone: string
  /** 全 widget に適用する filter です。 */
  filter: AnalyticsFilter
  /** Forecast risk と比較する保存済み baseline です。 */
  forecastBaseline?: AnalyticsDateRange
  /** Builder で保存する widget 一覧です。 */
  widgets: AnalyticsWidget[]
  /** 任意の定期配信設定です。 */
  schedule?: AnalyticsSchedule
}

/** Analytics report 更新 API の入力です。 */
export type UpdateAnalyticsReportInput = {
  /** 読み込み時点の report revision です。 */
  expectedRevision: number
  /** 変更後の表示名です。 */
  name?: string
  /** 変更後の説明です。null で削除します。 */
  description?: string | null
  /** 変更後の共有範囲です。 */
  visibility?: 'personal' | 'team' | 'shared'
  /** 変更後の Team ID です。null で削除します。 */
  teamId?: string | null
  /** 変更後の IANA timezone です。 */
  timeZone?: string
  /** 変更後の filter です。 */
  filter?: AnalyticsFilter
  /** 変更後の forecast baseline です。null で削除します。 */
  forecastBaseline?: AnalyticsDateRange | null
  /** 変更後の widget 一覧です。 */
  widgets?: AnalyticsWidget[]
  /** 変更後の schedule です。null で削除します。 */
  schedule?: AnalyticsSchedule | null
}

/** Metric の再現可能な定義です。 */
export type AnalyticsMetricDefinition = {
  /** Metric key です。 */
  key: AnalyticsMetricKey
  /** Definition contract version です。 */
  version: number
  /** Metric の表示名です。 */
  label: string
  /** Metric value の単位です。 */
  unit: 'count' | 'hours' | 'items-per-week' | 'percent'
  /** Metric 算出規則の短い説明です。 */
  description: string
}

/** Chart の一つの calendar bucket です。 */
export type AnalyticsSeriesPoint = {
  /** Bucket の開始 UTC instant です。 */
  from: string
  /** Bucket の終了 UTC instant です。 */
  to: string
  /** Bucket の metric value です。算出不能時は null です。 */
  value: number | null
  /** Value の根拠となった sample 数です。 */
  sampleSize: number
}

/** Dimension ごとに分割した metric value です。 */
export type AnalyticsGroup = {
  /** Stable dimension key です。 */
  key: string
  /** UI に表示できる dimension label です。 */
  label: string
  /** Group の metric value です。 */
  value: number | null
  /** Group の sample 数です。 */
  sampleSize: number
}

/** Table widget の一つの evidence 集計行です。 */
export type AnalyticsTableRow = {
  /** Row の安定 ID です。 */
  id: string
  /** Row の表示名です。 */
  label: string
  /** Column ID ごとの JSON-safe value です。 */
  values: Record<string, string | number | boolean | null>
}

/** 一つの widget を計算した結果です。 */
export type AnalyticsWidgetResult = {
  /** 元 widget の ID です。 */
  widgetId: string
  /** 計算した metric です。 */
  metric: AnalyticsMetricKey
  /** Metric definition です。 */
  definition: AnalyticsMetricDefinition
  /** Widget 全体の value です。 */
  value: number | null
  /** Value の sample 数です。 */
  sampleSize: number
  /** Calendar bucket series です。 */
  series: AnalyticsSeriesPoint[]
  /** Dimension group 一覧です。 */
  groups: AnalyticsGroup[]
  /** Table 表示用の行一覧です。 */
  rows: AnalyticsTableRow[]
  /** 履歴不足などの非致命的な注意事項です。 */
  warnings: string[]
}

/**
 * Baseline と historical daily throughput の deterministic empirical scenario から
 * 計算した forecast です。
 */
export type AnalyticsForecast = {
  /** Forecast が対象にした未完了 Work Item 数です。 */
  remainingWorkItems: number
  /** Historical sample 数です。 */
  sampleSize: number
  /** Historical throughput の1日平均です。 */
  dailyThroughput: number
  /** Historical daily sequence の開始offset scenarioにおける50 percentile完了instantです。 */
  p50: string | null
  /** Historical daily sequence の開始offset scenarioにおける85 percentile完了instantです。 */
  p85: string | null
  /** Historical daily sequence の開始offset scenarioにおける95 percentile完了instantです。 */
  p95: string | null
  /** 0..1 の data confidence です。 */
  confidence: number
  /** Baseline と p85 の比較から得た risk です。 */
  risk: 'unknown' | 'low' | 'medium' | 'high'
  /** 比較対象の baseline です。 */
  baseline?: AnalyticsDateRange
}

/** 同じ query input から再現できる analytics snapshot です。 */
export type AnalyticsSnapshot = {
  /** Snapshot schema version です。 */
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION
  /** Current state を評価した UTC instant です。 */
  asOf: string
  /** Calendar bucket と date-only field を解釈した IANA timezone です。 */
  timeZone: string
  /** Filter と widget 定義を束ねる deterministic hash です。 */
  queryHash: string
  /** Snapshot 作成時に認可済みだった Work Item key 集合の deterministic hash です。 */
  permissionScopeHash: string
  /** 適用済み filter です。 */
  filter: AnalyticsFilter
  /** Widget result 一覧です。 */
  widgets: AnalyticsWidgetResult[]
  /** Metric drill-down で辿れる evidence 件数です。 */
  evidenceCount: number
  /** Baseline と実績から得た forecast です。 */
  forecast: AnalyticsForecast
  /** Snapshot を生成した UTC instant です。 */
  generatedAt: string
}

/** Immutable snapshot の保存 record です。 */
export type AnalyticsSnapshotRecord = {
  /** Workspace 内で一意な snapshot ID です。 */
  id: string
  /** Snapshot を所有する Workspace ID です。 */
  workspaceId: string
  /** 元 report ID です。 */
  reportId?: string
  /** Snapshot に固定した元 report revision です。 */
  reportRevision?: number
  /** Snapshot を作成した member key です。 */
  createdByMemberKey: string
  /** Snapshot 作成日時です。 */
  createdAt: string
  /** Snapshot を再実行して現在の permission scope を検証する完全な query です。 */
  query: AnalyticsQueryInput
  /** Immutable analytics payload です。 */
  snapshot: AnalyticsSnapshot
}

/** Current ACL で再検証した immutable snapshot 一覧 API の response です。 */
export type AnalyticsSnapshotListResponse = {
  /** Caller の current permission scope と一致した snapshot record です。 */
  snapshots: AnalyticsSnapshotRecord[]
  /** この response でcurrent ACLを検査した保存済みrecord数です。0以上1,000以下です。 */
  inspectedCount: number
  /** 検査上限または返却上限に達し、保存済み record が残る場合の scope-bound cursor です。 */
  nextCursor?: string
}

/** Metric から辿る Work Item/event evidence です。 */
export type AnalyticsEvidenceItem = {
  /** Evidence を識別する stable ID です。 */
  id: string
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Work Item ID です。 */
  workItemId: string
  /** Evidence 時点または current state の Project ID です。 */
  projectId?: string
  /** Work Item title です。 */
  title: string
  /** 根拠 event ID です。 */
  eventId?: string
  /** Evidence の UTC timestamp です。 */
  occurredAt: string
  /** Evidence が寄与した metric value です。 */
  value?: number
}

/** Scope-bound cursor 付き evidence response です。 */
export type AnalyticsEvidenceResponse = {
  /** Current caller が認可済みの evidence 一覧です。 */
  items: AnalyticsEvidenceItem[]
  /** 続きがある場合の opaque cursor です。 */
  nextCursor?: string
}

/** Analytics snapshot 計算 API の入力です。 */
export type AnalyticsQueryInput = {
  /** Fact と event に適用する filter です。 */
  filter: AnalyticsFilter
  /** 計算する widget 一覧です。 */
  widgets: AnalyticsWidget[]
  /** State と event の上限 UTC instant です。 */
  asOf: string
  /** Calendar bucket を解釈する IANA timezone です。 */
  timeZone: string
  /** Forecast risk と比較する baseline です。 */
  forecastBaseline?: AnalyticsDateRange
}

/** Analytics drill-down API の入力です。 */
export type AnalyticsEvidenceInput = {
  /** Drill-down する metric です。 */
  metric: AnalyticsMetricKey
  /** Fact と event に適用する filter です。 */
  filter: AnalyticsFilter
  /** State と event の上限 UTC instant です。 */
  asOf: string
  /** Calendar date を解釈する IANA timezone です。 */
  timeZone: string
  /** SLA evidence の達成判定時間です。 */
  slaTargetHours?: number
  /** 一度に返す最大件数です。 */
  limit?: number
  /** 前 page の scope-bound opaque cursor です。 */
  cursor?: string
}

/** Analytics export が label と header に利用する対応 locale です。 */
export type AnalyticsExportLocale = 'en' | 'ja'

/** Analytics export API の入力です。 */
export type AnalyticsExportInput = {
  /** 保存済み snapshot を出力する場合の ID です。 */
  snapshotId?: string
  /** 保存済み report を実行して出力する場合の ID です。 */
  reportId?: string
  /** Ad-hoc query を出力する場合の入力です。 */
  query?: AnalyticsQueryInput
  /** Artifact の形式です。 */
  format: 'csv' | 'pdf'
  /**
   * Export header、metric、unit、risk label に利用する locale です。
   * `ja` / `ja-*` は日本語、`en` / `en-*` は英語へ正規化し、省略時と未対応値は英語へfallbackします。
   */
  locale?: string
}
