import { createHash } from 'node:crypto'
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import {
  ANALYTICS_SCHEMA_VERSION,
  type AnalyticsCustomFieldFilter,
  type AnalyticsDateRange,
  type AnalyticsEvidenceInput,
  type AnalyticsEvidenceItem,
  type AnalyticsEvidenceResponse,
  type AnalyticsExportLocale,
  type AnalyticsFilter,
  type AnalyticsForecast,
  type AnalyticsGroup,
  type AnalyticsGroupBy,
  type AnalyticsMetricDefinition,
  type AnalyticsMetricKey,
  type AnalyticsQueryInput,
  type AnalyticsReport,
  type AnalyticsReportListResponse,
  type AnalyticsSchedule,
  type AnalyticsSeriesPoint,
  type AnalyticsSnapshot,
  type AnalyticsSnapshotRecord,
  type AnalyticsTableRow,
  type AnalyticsWidget,
  type AnalyticsWidgetResult,
  type CanonicalWorkItem,
  type CreateAnalyticsReportInput,
  type UpdateAnalyticsReportInput,
} from '@mukuroji/contracts'
import type { AuditEventV1, AuditFieldChange, AuditValue } from './audit'
import { analyticsPdfFont } from './analytics-pdf-font'

const REPORT_RECORD_PREFIX = 'REPORT#'
const SNAPSHOT_RECORD_PREFIX = 'SNAPSHOT#'
const SNAPSHOT_ID_RECORD_PREFIX = 'SNAPSHOT_ID#'
const DELIVERY_RECORD_PREFIX = 'DELIVERY#'
const DEFAULT_EVIDENCE_LIMIT = 50
const MAX_EVIDENCE_LIMIT = 200
const MAX_SNAPSHOT_LIST_LIMIT = 100
const MAX_STORAGE_CURSOR_LENGTH = 16_384
const MAX_DUE_CURSOR_BOUNDARY_LENGTH = 2_048
const MAX_REPORTS_PER_WORKSPACE = 1_000
const DEFAULT_SLA_TARGET_HOURS = 72
const MILLISECONDS_PER_HOUR = 60 * 60 * 1_000
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const ISO_INSTANT_PATTERN = /T.*(?:Z|[+-]\d{2}:\d{2})$/u
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u
const ROUTE_SAFE_REPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const localDateFormatterCache = new Map<string, Intl.DateTimeFormat>()
const PDF_LINES_PER_PAGE = 36
const PDF_JAPANESE_FONT_NAME =
  `${createPdfFontSubsetTag(analyticsPdfFont.bytes)}+NotoSansJP-Thin`
const ANALYTICS_EXPORT_MESSAGES = Object.freeze({
  en: Object.freeze({
    csvHeaders: Object.freeze([
      'Widget ID',
      'Metric key',
      'Metric',
      'Value',
      'Sample size',
      'Record type',
      'Dimension value',
      'Period from',
      'Period to',
      'Row ID',
      'Row label',
      'Team ID',
      'Work Item ID',
      'Project ID',
      'Occurred at',
    ]),
    recordTypes: Object.freeze({
      total: 'Total',
      group: 'Group',
      series: 'Series',
      tableRow: 'Table row',
    }),
    metricLabels: Object.freeze({
      throughput: 'Throughput',
      'cycle-time': 'Cycle time',
      'lead-time': 'Lead time',
      wip: 'Work in progress',
      overdue: 'Overdue',
      'scope-change': 'Scope change',
      velocity: 'Velocity',
      sla: 'SLA attainment',
    }),
    unitLabels: Object.freeze({
      count: 'items',
      hours: 'hours',
      'items-per-week': 'items/week',
      percent: '%',
    }),
    riskLabels: Object.freeze({
      unknown: 'Unknown',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
    }),
    asOf: 'As of',
    timeZone: 'Time zone',
    forecastP85: 'Forecast P85',
    risk: 'Risk',
    unavailable: 'N/A',
  }),
  ja: Object.freeze({
    csvHeaders: Object.freeze([
      'ウィジェットID',
      '指標キー',
      '指標',
      '値',
      'サンプル数',
      'レコード種別',
      'ディメンション値',
      '期間開始',
      '期間終了',
      '行ID',
      '行ラベル',
      'チームID',
      '作業項目ID',
      'プロジェクトID',
      '発生日時',
    ]),
    recordTypes: Object.freeze({
      total: '合計',
      group: 'グループ',
      series: '時系列',
      tableRow: 'テーブル行',
    }),
    metricLabels: Object.freeze({
      throughput: 'スループット',
      'cycle-time': 'サイクルタイム',
      'lead-time': 'リードタイム',
      wip: '進行中',
      overdue: '期限超過',
      'scope-change': 'スコープ変更',
      velocity: 'ベロシティ',
      sla: 'SLA達成率',
    }),
    unitLabels: Object.freeze({
      count: '件',
      hours: '時間',
      'items-per-week': '件/週',
      percent: '%',
    }),
    riskLabels: Object.freeze({
      unknown: '不明',
      low: '低',
      medium: '中',
      high: '高',
    }),
    asOf: '基準日時',
    timeZone: 'タイムゾーン',
    forecastP85: '予測 P85',
    risk: 'リスク',
    unavailable: '利用不可',
  }),
})

/** Analytics schedule GSI を分散する固定 shard 数です。 */
export const ANALYTICS_SCHEDULE_SHARD_COUNT = 16

/** Analytics schedule の due report query に使う既定 GSI 名です。 */
export const ANALYTICS_SCHEDULE_DUE_INDEX_NAME = 'ScheduleDueIndex'

/**
 * Workspace/report を ScheduleDueIndex の安定した shard へ割り当てます。
 *
 * @param workspaceId - Workspace ID です。
 * @param reportId - Analytics report ID です。
 * @returns `schedule-00` から `schedule-15` の shard key です。
 */
export function createAnalyticsScheduleShard(
  workspaceId: string,
  reportId: string,
) {
  const digest = createHash('sha256')
    .update(
      `${readIdentifier(workspaceId, 'Workspace ID')}\0${
        readIdentifier(reportId, 'Analytics report ID')
      }`,
    )
    .digest()
  return `schedule-${
    String(digest[0]! % ANALYTICS_SCHEDULE_SHARD_COUNT).padStart(2, '0')
  }`
}

/** Analytics domain と persistence の stable error です。 */
export class AnalyticsError extends Error {
  /** API response に変換する HTTP status です。 */
  readonly status: number
  /** Client と worker が分岐する stable error code です。 */
  readonly code: string

  /**
   * Analytics error を作成します。
   *
   * @param status - HTTP status です。
   * @param code - Stable error code です。
   * @param message - 安全に公開できる message です。
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AnalyticsError'
    this.status = status
    this.code = code
  }
}

/** Analytics engine へ渡す認可済み data と query です。 */
export type AnalyticsEngineInput = {
  /** Current viewer の認可を通過した canonical Work Item だけを渡します。 */
  workItems: readonly CanonicalWorkItem[]
  /** `workItems` と同じ認可 scope に絞った immutable event だけを渡します。 */
  events: readonly AuditEventV1[]
  /** Current viewer が参照できる Project ID の server-side allowlist です。 */
  authorizedProjectIds: ReadonlySet<string>
  /** Snapshot を再現する query です。 */
  query: AnalyticsQueryInput
}

/** Evidence engine へ渡す認可済み data と drill-down 条件です。 */
export type AnalyticsEvidenceEngineInput = {
  /** Current viewer の認可を通過した canonical Work Item だけを渡します。 */
  workItems: readonly CanonicalWorkItem[]
  /** `workItems` と同じ認可 scope に絞った immutable event だけを渡します。 */
  events: readonly AuditEventV1[]
  /** Current viewer が参照できる Project ID の server-side allowlist です。 */
  authorizedProjectIds: ReadonlySet<string>
  /** Scope-bound cursor を含む evidence query です。 */
  evidence: AnalyticsEvidenceInput
}

/** Scheduled delivery の idempotent receipt です。 */
export type AnalyticsDeliveryReceipt = {
  /** Receipt を所有する Workspace ID です。 */
  workspaceId: string
  /** 配信元 report ID です。 */
  reportId: string
  /** Schedule occurrence を一意に識別する key です。 */
  occurrenceKey: string
  /** 配信時に固定した report revision です。 */
  reportRevision: number
  /** 配信 artifact の形式です。 */
  format: 'csv' | 'pdf'
  /** 配信 snapshot ID です。 */
  snapshotId: string
  /** 配信対象 member key 一覧です。 */
  recipientMemberKeys: string[]
  /** Receipt 作成日時です。 */
  createdAt: string
}

/** Due report query の page です。 */
export type AnalyticsDueReportPage = {
  /** `asOf` 以前に実行期限を迎えた report です。 */
  reports: AnalyticsReport[]
  /** 返却済み report が due 集合から消えても継続できる exclusive keyset cursor です。 */
  nextCursor?: string
}

/** Delivery receipt の idempotent put result です。 */
export type AnalyticsDeliveryReceiptResult = {
  /** この呼び出しが新しい receipt を作成したかどうかです。 */
  created: boolean
  /** 作成済みまたは既存の receipt です。 */
  receipt: AnalyticsDeliveryReceipt
}

/** Analytics report と immutable snapshot を保存する repository です。 */
export type AnalyticsRepository = {
  /** Workspace report 一覧を返します。ACL は API 境界で別途適用します。 */
  listReports(workspaceId: string): Promise<AnalyticsReportListResponse>
  /** Workspace 内の report を返します。 */
  getReport(workspaceId: string, reportId: string): Promise<AnalyticsReport | undefined>
  /** 新しい report を revision 1 で保存します。 */
  createReport(
    workspaceId: string,
    ownerMemberKey: string,
    input: CreateAnalyticsReportInput,
  ): Promise<AnalyticsReport>
  /** Expected revision を満たす report を更新します。 */
  updateReport(
    workspaceId: string,
    reportId: string,
    input: UpdateAnalyticsReportInput,
  ): Promise<AnalyticsReport>
  /** Expected revision を満たす report を削除します。 */
  deleteReport(workspaceId: string, reportId: string, expectedRevision: number): Promise<void>
  /** Immutable snapshot を一度だけ保存します。 */
  putSnapshot(record: AnalyticsSnapshotRecord): Promise<AnalyticsSnapshotRecord>
  /** 保存済み immutable snapshot を返します。 */
  getSnapshot(workspaceId: string, snapshotId: string): Promise<AnalyticsSnapshotRecord | undefined>
  /** Report に紐づく最新の immutable snapshot を作成日時順で上限件数まで返します。 */
  listSnapshots(
    workspaceId: string,
    reportId: string,
    limit?: number,
  ): Promise<AnalyticsSnapshotRecord[]>
  /** 指定 shard で実行期限を迎えた schedule 付き report を keyset page で返します。 */
  listDueReports(
    scheduleShard: string,
    asOf: string,
    limit: number,
    cursor?: string,
  ): Promise<AnalyticsDueReportPage>
  /** Schedule occurrence ごとの delivery receipt を idempotent に保存します。 */
  putDeliveryReceipt(record: AnalyticsDeliveryReceipt): Promise<AnalyticsDeliveryReceiptResult>
}

/** DynamoDB Analytics repository の設定です。 */
export type DynamoDbAnalyticsRepositoryOptions = {
  /** Timestamp を生成する注入可能な clock です。 */
  now?: () => Date
  /** Schedule due query に使う GSI 名です。 */
  scheduleDueIndexName?: string
}

/** Metric key ごとの versioned calculation definition です。 */
export const ANALYTICS_METRIC_DEFINITIONS: Readonly<Record<
  AnalyticsMetricKey,
  AnalyticsMetricDefinition
>> = Object.freeze({
  throughput: Object.freeze({
    key: 'throughput',
    version: 1,
    label: 'Throughput',
    unit: 'count',
    description:
      'Counts Work Items whose effective completion occurred in the period. Reopened Items count only at their latest effective completion.',
  }),
  'cycle-time': Object.freeze({
    key: 'cycle-time',
    version: 1,
    label: 'Cycle time',
    unit: 'hours',
    description:
      'Averages elapsed hours from the latest transition into started work to the effective completion.',
  }),
  'lead-time': Object.freeze({
    key: 'lead-time',
    version: 1,
    label: 'Lead time',
    unit: 'hours',
    description:
      'Averages elapsed hours from Work Item creation to the effective completion.',
  }),
  wip: Object.freeze({
    key: 'wip',
    version: 1,
    label: 'Work in progress',
    unit: 'count',
    description: 'Counts Work Items in the started status category at the evaluated instant.',
  }),
  overdue: Object.freeze({
    key: 'overdue',
    version: 1,
    label: 'Overdue',
    unit: 'count',
    description:
      'Counts non-terminal Work Items whose date-only due date is before the evaluated local calendar date.',
  }),
  'scope-change': Object.freeze({
    key: 'scope-change',
    version: 1,
    label: 'Scope change',
    unit: 'count',
    description: 'Counts assigned Project changes recorded during the period.',
  }),
  velocity: Object.freeze({
    key: 'velocity',
    version: 1,
    label: 'Velocity',
    unit: 'items-per-week',
    description: 'Normalizes effective completions in the period to a seven-calendar-day rate.',
  }),
  sla: Object.freeze({
    key: 'sla',
    version: 1,
    label: 'SLA attainment',
    unit: 'percent',
    description:
      'Calculates the percentage of effectively completed Work Items whose lead time is within the configured target.',
  }),
})

/** Analytics engine が Work Item ごとに再構成する state です。 */
type AnalyticsWorkItemState = {
  /** Work Item ID です。 */
  id: string
  /** Owning Team ID です。 */
  teamId: string
  /** Display title です。 */
  title: string
  /** Assigned Project ID です。 */
  assignedProjectId?: string
  /** Assignee user ID です。 */
  assigneeUserId: string
  /** Workflow status category です。 */
  statusCategory: string
  /** Custom field values です。 */
  customFieldValues: Record<string, string | number | boolean | string[]>
  /** Date-only due date です。 */
  dueDate: string
  /** Work Item creation instant です。 */
  createdAt: string
  /** Work Item update instant です。 */
  updatedAt: string
  /** Archive instant です。 */
  archivedAt?: string
}

/** Status category の一つの immutable transition です。 */
type AnalyticsStatusTransition = {
  /** Transition event です。 */
  event: AuditEventV1
  /** Transition 前の category です。 */
  before?: string
  /** Transition 後の category です。 */
  after?: string
  /** Transition instant の epoch milliseconds です。 */
  occurredAt: number
}

/** Assigned Project の一つの immutable change です。 */
type AnalyticsScopeChange = {
  /** Change event です。 */
  event: AuditEventV1
  /** Change instant の epoch milliseconds です。 */
  occurredAt: number
  /** Change 前の Project ID です。 */
  before?: string
  /** Change 後の Project ID です。 */
  after?: string
}

/** Metric 計算用に再構成した Work Item fact です。 */
type AnalyticsWorkItemFact = {
  /** `asOf` 時点の state です。 */
  state: AnalyticsWorkItemState
  /** Work Item に対応する event です。 */
  events: AuditEventV1[]
  /** Creation instant の epoch milliseconds です。 */
  createdAt: number
  /** 有効な最終 completion instant です。 */
  completionAt?: number
  /** 有効な cycle time です。 */
  cycleHours?: number
  /** 有効な lead time です。 */
  leadHours?: number
  /** Period filter 前の Project scope changes です。 */
  scopeChanges: AnalyticsScopeChange[]
}

/** 正規化済み query と epoch boundary です。 */
type NormalizedAnalyticsQuery = {
  /** Clone 済み query です。 */
  query: AnalyticsQueryInput
  /** Period start epoch milliseconds です。 */
  periodFrom: number
  /** Period end epoch milliseconds です。 */
  periodTo: number
  /** As-of epoch milliseconds です。 */
  asOf: number
}

/** Metric の scalar result と evidence です。 */
type MetricComputation = {
  /** Metric scalar value です。 */
  value: number | null
  /** Scalar value の sample 数です。 */
  sampleSize: number
  /** Scalar value の根拠です。 */
  evidence: AnalyticsEvidenceItem[]
  /** 非致命的 warning です。 */
  warnings: string[]
}

/** Calendar chart の内部 bucket です。 */
type AnalyticsBucket = {
  /** Bucket start epoch milliseconds です。 */
  from: number
  /** Bucket end epoch milliseconds です。 */
  to: number
}

/** Evidence cursor の payload です。 */
type AnalyticsEvidenceCursorPayload = {
  /** Cursor schema version です。 */
  version: 1
  /** Filter と metric を束ねる scope hash です。 */
  scopeHash: string
  /** 次 page の zero-based offset です。 */
  offset: number
}

/** DynamoDB pagination cursor の payload です。 */
type AnalyticsStorageCursorPayload = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor を現在 query に束ねる hash です。 */
  scopeHash: string
  /** DynamoDB の opaque continuation key です。 */
  key: Record<string, unknown>
}

/** DynamoDB に保存する report row です。 */
type StoredAnalyticsReport = AnalyticsReport & {
  /** Row discriminator です。 */
  entryType: 'analytics-report'
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Enabled schedule の GSI partition です。 */
  scheduleShard?: string
  /** Enabled schedule の GSI sort key です。 */
  nextDeliveryAtRecordKey?: string
}

/** DynamoDB に保存する snapshot row です。 */
type StoredAnalyticsSnapshot = AnalyticsSnapshotRecord & {
  /** Row discriminator です。 */
  entryType: 'analytics-snapshot'
  /** DynamoDB sort key です。 */
  recordKey: string
}

/** DynamoDB で snapshot ID の Workspace 一意性を確保する claim row です。 */
type StoredAnalyticsSnapshotIdClaim = {
  /** Claim を所有する Workspace ID です。 */
  workspaceId: string
  /** Row discriminator です。 */
  entryType: 'analytics-snapshot-id'
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Workspace 内で一意な snapshot ID です。 */
  snapshotId: string
  /** Claim が参照する snapshot row の sort key です。 */
  snapshotRecordKey: string
}

/** DynamoDB に保存する delivery receipt row です。 */
type StoredAnalyticsDeliveryReceipt = AnalyticsDeliveryReceipt & {
  /** Row discriminator です。 */
  entryType: 'analytics-delivery'
  /** DynamoDB sort key です。 */
  recordKey: string
}

/**
 * Enabled schedule の GSI sort key を作成します。
 *
 * @param nextRunAt - Schedule の次回 UTC instant です。
 * @param workspaceId - Workspace ID です。
 * @param reportId - Report ID です。
 * @returns Lexicographically sortable schedule key です。
 */
export function createAnalyticsNextDeliveryAtRecordKey(
  nextRunAt: string,
  workspaceId: string,
  reportId: string,
) {
  return [
    normalizeIsoTimestamp(nextRunAt, 'Analytics next delivery time'),
    readIdentifier(workspaceId, 'Workspace ID'),
    readIdentifier(reportId, 'Report ID'),
  ].join('#')
}

/**
 * Delivery occurrence の DynamoDB record key を作成します。
 *
 * @param reportId - Report ID です。
 * @param occurrenceKey - Worker が決定した stable occurrence key です。
 * @returns Collision-resistant receipt record key です。
 */
export function createAnalyticsDeliveryRecordKey(reportId: string, occurrenceKey: string) {
  const normalizedReportId = readIdentifier(reportId, 'Report ID')
  const normalizedOccurrenceKey = readIdentifier(occurrenceKey, 'Analytics occurrence key')
  const digest = createHash('sha256').update(normalizedOccurrenceKey).digest('hex')
  return `${DELIVERY_RECORD_PREFIX}${normalizedReportId}#${digest}`
}

/**
 * Local wall-clock schedule から `after` より後の最初の UTC occurrence を計算します。
 *
 * @remarks
 * DST gap は同じ local date の最初の有効時刻へ繰り下げ、DST fold は `after`
 * より後の最初の occurrence を選びます。ただし `after` 自体が fold の一つの
 * occurrence の場合、同じ local date のもう一方は再実行せず次の recurrence へ進みます。
 * Monthly の存在しない日は月末へ丸めます。
 *
 * @param schedule - Frequency、local time、timezone を含む schedule です。
 * @param after - この UTC instant より厳密に後の occurrence を探します。
 * @returns 次回 occurrence の UTC ISO timestamp です。
 */
export function calculateAnalyticsNextRunAt(
  schedule: AnalyticsSchedule,
  after: string,
) {
  const normalizedSchedule = normalizeSchedule(schedule)
  const afterIso = normalizeIsoTimestamp(after, 'Analytics schedule cursor time')
  const afterMilliseconds = Date.parse(afterIso)
  const [hourText, minuteText] = normalizedSchedule.localTime.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const localAfter = localDatePartsAt(afterMilliseconds, normalizedSchedule.timeZone)
  const cursor = toPseudoUtcDate(localAfter.year, localAfter.month, localAfter.day)
  const afterIsScheduledOccurrence = isScheduleLocalDate(normalizedSchedule, cursor) &&
    resolveLocalScheduleInstants(
      localAfter.year,
      localAfter.month,
      localAfter.day,
      hour,
      minute,
      normalizedSchedule.timeZone,
    ).includes(afterMilliseconds)

  for (let offset = 0; offset < 800; offset += 1) {
    const candidateDate = new Date(cursor)
    candidateDate.setUTCDate(candidateDate.getUTCDate() + offset)
    if (!isScheduleLocalDate(normalizedSchedule, candidateDate)) continue
    if (offset === 0 && afterIsScheduledOccurrence) continue
    const candidates = resolveLocalScheduleInstants(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
      candidateDate.getUTCDate(),
      hour,
      minute,
      normalizedSchedule.timeZone,
    )
    const next = candidates.find((candidate) => candidate > afterMilliseconds)
    if (next !== undefined) return new Date(next).toISOString()
  }
  throw new AnalyticsError(
    500,
    'AnalyticsScheduleUnresolvable',
    'Analytics schedule did not produce a future occurrence.',
  )
}

/**
 * Filter binding 済み evidence cursor を作成します。
 *
 * @param scopeHash - Query/filter scope の deterministic hash です。
 * @param offset - 次 page の offset です。
 * @returns Opaque base64url cursor です。
 */
export function createAnalyticsEvidenceCursor(scopeHash: string, offset: number) {
  const normalizedScopeHash = readIdentifier(scopeHash, 'Analytics evidence scope hash')
  const normalizedOffset = readNonNegativeInteger(offset, 'Analytics evidence offset')
  const payload: AnalyticsEvidenceCursorPayload = {
    version: 1,
    scopeHash: normalizedScopeHash,
    offset: normalizedOffset,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Evidence cursor を decode し、現在 filter への binding を検証します。
 *
 * @param cursor - Client が返した opaque cursor です。
 * @param scopeHash - 現在 query の deterministic scope hash です。
 * @returns 次 page の offset です。
 */
export function parseAnalyticsEvidenceCursor(cursor: string, scopeHash: string) {
  const normalizedScopeHash = readIdentifier(scopeHash, 'Analytics evidence scope hash')
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(readIdentifier(cursor, 'Analytics evidence cursor'), 'base64url').toString('utf8'))
  } catch {
    throw invalid('AnalyticsEvidenceCursorInvalid', 'Analytics evidence cursor is invalid.')
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.scopeHash !== normalizedScopeHash ||
    typeof value.offset !== 'number' ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0
  ) {
    throw invalid('AnalyticsEvidenceCursorInvalid', 'Analytics evidence cursor does not match this query.')
  }
  return value.offset
}

/**
 * 認可済み Work Item/event から deterministic analytics snapshot を作成します。
 *
 * @remarks
 * この関数は権限を拡張しません。API handler は必ず current viewer が参照できる
 * Work Item と、それらに対応する event だけを渡してください。
 *
 * @param input - 認可済み data と query です。
 * @returns Query の `asOf` に固定した snapshot です。
 */
export function createAnalyticsSnapshot(input: AnalyticsEngineInput): AnalyticsSnapshot {
  const normalized = normalizeAnalyticsQuery(input.query)
  const authorizedProjectIds = normalizeAuthorizedProjectIds(input.authorizedProjectIds)
  const eventsByWorkItem = indexAuthorizedEvents(input.workItems, input.events)
  const facts = createFilteredFacts(
    input.workItems,
    eventsByWorkItem,
    normalized,
    authorizedProjectIds,
  )
  const widgets = normalized.query.widgets.map((widget) =>
    createWidgetResult(
      widget,
      facts,
      input.workItems,
      eventsByWorkItem,
      normalized,
      authorizedProjectIds,
    )
  )
  const evidenceCount = dedupeEvidence(
    normalized.query.widgets.flatMap((widget) =>
      calculateMetric(
        widget.metric,
        facts,
        normalized,
        normalized.periodFrom,
        normalized.periodTo,
        normalized.asOf,
        widget.slaTargetHours,
      ).evidence
    ),
  ).length
  const queryHash = hashCanonical(normalized.query)
  const permissionScopeHash = createAnalyticsPermissionScopeHash(
    input.workItems,
    normalized.asOf,
    authorizedProjectIds,
  )

  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    asOf: normalized.query.asOf,
    timeZone: normalized.query.timeZone,
    queryHash,
    permissionScopeHash,
    filter: structuredClone(normalized.query.filter),
    widgets,
    evidenceCount,
    forecast: createForecast(facts, normalized),
    generatedAt: normalized.query.asOf,
  }
}

/**
 * 認可済み data から metric evidence を cursor page で返します。
 *
 * @param input - 認可済み data と evidence query です。
 * @returns Stable order の evidence page です。
 */
export function queryAnalyticsEvidence(
  input: AnalyticsEvidenceEngineInput,
): AnalyticsEvidenceResponse {
  const query: AnalyticsQueryInput = {
    filter: input.evidence.filter,
    widgets: [{
      id: 'evidence',
      title: 'Evidence',
      type: 'table',
      metric: input.evidence.metric,
      ...(input.evidence.slaTargetHours === undefined
        ? {}
        : { slaTargetHours: input.evidence.slaTargetHours }),
    }],
    asOf: input.evidence.asOf,
    timeZone: input.evidence.timeZone,
  }
  const normalized = normalizeAnalyticsQuery(query)
  const authorizedProjectIds = normalizeAuthorizedProjectIds(input.authorizedProjectIds)
  const eventsByWorkItem = indexAuthorizedEvents(input.workItems, input.events)
  const facts = createFilteredFacts(
    input.workItems,
    eventsByWorkItem,
    normalized,
    authorizedProjectIds,
  )
  const computation = calculateMetric(
    input.evidence.metric,
    facts,
    normalized,
    normalized.periodFrom,
    normalized.periodTo,
    normalized.asOf,
    input.evidence.slaTargetHours,
  )
  const items = dedupeEvidence(computation.evidence)
    .sort(compareEvidence)
  const scopeHash = hashCanonical({
    metric: input.evidence.metric,
    filter: normalized.query.filter,
    asOf: normalized.query.asOf,
    timeZone: normalized.query.timeZone,
    slaTargetHours: input.evidence.slaTargetHours,
    permissionScopeHash: createAnalyticsPermissionScopeHash(
      input.workItems,
      normalized.asOf,
      authorizedProjectIds,
    ),
  })
  const offset = input.evidence.cursor
    ? parseAnalyticsEvidenceCursor(input.evidence.cursor, scopeHash)
    : 0
  const limit = input.evidence.limit === undefined
    ? DEFAULT_EVIDENCE_LIMIT
    : readPositiveInteger(input.evidence.limit, 'Analytics evidence limit', MAX_EVIDENCE_LIMIT)
  const page = items.slice(offset, offset + limit)
  const nextOffset = offset + page.length

  return {
    items: page,
    ...(nextOffset < items.length
      ? { nextCursor: createAnalyticsEvidenceCursor(scopeHash, nextOffset) }
      : {}),
  }
}

/**
 * Client locale を analytics export が対応する primary language へ正規化します。
 *
 * @param locale - 任意の locale tag です。
 * @returns `ja` / `ja-*` の場合は `ja`、それ以外は安全なfallbackである `en` です。
 */
export function normalizeAnalyticsExportLocale(
  locale: string | undefined,
): AnalyticsExportLocale {
  if (typeof locale !== 'string') return 'en'
  const primaryLanguage = locale.trim().replaceAll('_', '-').split('-', 1)[0]?.toLowerCase()
  return primaryLanguage === 'ja' ? 'ja' : 'en'
}

/**
 * Snapshot を fixed-column、formula-safe UTF-8 CSV text へ変換します。
 *
 * @param snapshot - Export 対象 snapshot です。
 * @param locale - Header と label に利用する locale tag です。未対応時は英語へfallbackします。
 * @returns CRLF 区切りの CSV text です。
 */
export function createAnalyticsCsv(snapshot: AnalyticsSnapshot, locale?: string) {
  const normalized = normalizeSnapshot(snapshot)
  const messages = ANALYTICS_EXPORT_MESSAGES[normalizeAnalyticsExportLocale(locale)]
  const rows: Array<Array<string | number | boolean | null | undefined>> = [
    [...messages.csvHeaders],
  ]
  for (const widget of normalized.widgets) {
    const metricLabel = messages.metricLabels[widget.metric]
    rows.push([
      widget.widgetId,
      widget.metric,
      metricLabel,
      widget.value,
      widget.sampleSize,
      messages.recordTypes.total,
      '',
      normalized.filter.period.from,
      normalized.filter.period.to,
      '',
      '',
      '',
      '',
      '',
      '',
    ])
    for (const group of widget.groups) {
      rows.push([
        widget.widgetId,
        widget.metric,
        metricLabel,
        group.value,
        group.sampleSize,
        messages.recordTypes.group,
        group.label,
        normalized.filter.period.from,
        normalized.filter.period.to,
        '',
        '',
        '',
        '',
        '',
        '',
      ])
    }
    for (const point of widget.series) {
      rows.push([
        widget.widgetId,
        widget.metric,
        metricLabel,
        point.value,
        point.sampleSize,
        messages.recordTypes.series,
        '',
        point.from,
        point.to,
        '',
        '',
        '',
        '',
        '',
        '',
      ])
    }
    for (const row of widget.rows) {
      rows.push([
        widget.widgetId,
        widget.metric,
        metricLabel,
        row.values.value,
        '',
        messages.recordTypes.tableRow,
        '',
        normalized.filter.period.from,
        normalized.filter.period.to,
        row.id,
        row.label,
        row.values.teamId,
        row.values.workItemId,
        row.values.projectId,
        row.values.occurredAt,
      ])
    }
  }
  return rows.map((row) => row.map(escapeCsvValue).join(',')).join('\r\n')
}

/**
 * Snapshot summary を localized、multi-page PDF document へ変換します。
 *
 * @param snapshot - Export 対象 snapshot です。
 * @param locale - Label に利用する locale tag です。未対応時は英語へfallbackします。
 * @returns `%PDF-1.4` から始まる PDF bytes です。
 */
export function createAnalyticsPdf(snapshot: AnalyticsSnapshot, locale?: string) {
  const normalized = normalizeSnapshot(snapshot)
  const exportLocale = normalizeAnalyticsExportLocale(locale)
  const messages = ANALYTICS_EXPORT_MESSAGES[exportLocale]
  const lines = [
    'mukuroji analytics',
    `${messages.asOf}: ${normalized.asOf}`,
    `${messages.timeZone}: ${normalized.timeZone}`,
    ...normalized.widgets.map((widget) => {
      const value = widget.value === null ? messages.unavailable : String(widget.value)
      const unit = messages.unitLabels[widget.definition.unit]
      return `${messages.metricLabels[widget.metric]}: ${value} ${unit}`
    }),
    `${messages.forecastP85}: ${normalized.forecast.p85 ?? messages.unavailable}`,
    `${messages.risk}: ${messages.riskLabels[normalized.forecast.risk]}`,
  ]
  const pageLines = Array.from(
    { length: Math.ceil(lines.length / PDF_LINES_PER_PAGE) },
    (_, index) => lines.slice(
      index * PDF_LINES_PER_PAGE,
      (index + 1) * PDF_LINES_PER_PAGE,
    ),
  )
  const objects = ['', '']
  let fontObjectId: number
  if (exportLocale === 'ja') {
    const fontBytes = analyticsPdfFont.bytes.toString('latin1')
    const fontFileObjectId = objects.push(
      `<< /Length ${analyticsPdfFont.bytes.length} ` +
      `/Length1 ${analyticsPdfFont.bytes.length} >>\n` +
      `stream\n${fontBytes}\nendstream`,
    )
    const fontDescriptorObjectId = objects.push(
      `<< /Type /FontDescriptor /FontName /${PDF_JAPANESE_FONT_NAME} ` +
      '/Flags 32 /FontBBox [-44 -279 984 880] /ItalicAngle 0 ' +
      '/Ascent 880 /Descent -120 /CapHeight 733 /StemV 80 ' +
      `/FontFile2 ${fontFileObjectId} 0 R >>`,
    )
    const descendantFontObjectId = objects.push(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${PDF_JAPANESE_FONT_NAME} ` +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
      `/FontDescriptor ${fontDescriptorObjectId} 0 R /CIDToGIDMap /Identity ` +
      `/DW 1000 /W [1 [${analyticsPdfFont.asciiWidths.join(' ')}]] >>`,
    )
    const toUnicode = createAnalyticsPdfToUnicodeCMap()
    const toUnicodeObjectId = objects.push(
      `<< /Length ${Buffer.byteLength(toUnicode, 'latin1')} >>\n` +
      `stream\n${toUnicode}\nendstream`,
    )
    fontObjectId = objects.push(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${PDF_JAPANESE_FONT_NAME} ` +
      `/Encoding /Identity-H /DescendantFonts [${descendantFontObjectId} 0 R] ` +
      `/ToUnicode ${toUnicodeObjectId} 0 R >>`,
    )
  } else {
    fontObjectId = objects.push(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    )
  }
  const pageObjectIds: number[] = []
  for (const page of pageLines) {
    const content = createPdfPageContent(page, exportLocale)
    const contentObjectId = objects.push(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    )
    const pageObjectId = objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      `/Resources << /Font << /F1 ${fontObjectId} 0 R >> >> ` +
      `/Contents ${contentObjectId} 0 R >>`,
    )
    pageObjectIds.push(pageObjectId)
  }
  const documentLanguage = exportLocale === 'ja' ? 'ja-JP' : 'en-US'
  objects[0] = `<< /Type /Catalog /Pages 2 0 R /Lang (${documentLanguage}) >>`
  objects[1] = '<< /Type /Pages ' +
    `/Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] ` +
    `/Count ${pageObjectIds.length} >>`
  let source = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, 'latin1'))
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(source, 'latin1')
  source += `xref\n0 ${objects.length + 1}\n`
  source += '0000000000 65535 f \n'
  source += offsets.slice(1).map((offset) =>
    `${String(offset).padStart(10, '0')} 00000 n \n`
  ).join('')
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  source += `startxref\n${xrefOffset}\n%%EOF\n`
  return new Uint8Array(Buffer.from(source, 'latin1'))
}

function normalizeAnalyticsQuery(query: AnalyticsQueryInput): NormalizedAnalyticsQuery {
  if (!isRecord(query)) {
    throw invalid('AnalyticsQueryInvalid', 'Analytics query must be an object.')
  }
  const asOf = normalizeIsoTimestamp(query.asOf, 'Analytics as-of time')
  const timeZone = normalizeTimeZone(query.timeZone, 'Analytics time zone')
  const filter = normalizeFilter(query.filter)
  const widgets = normalizeWidgets(query.widgets)
  const periodFrom = Date.parse(filter.period.from)
  const asOfMilliseconds = Date.parse(asOf)
  if (periodFrom > asOfMilliseconds) {
    throw invalid(
      'AnalyticsPeriodAfterAsOf',
      'Analytics period cannot start after the as-of time.',
    )
  }
  const periodTo = Math.min(Date.parse(filter.period.to), asOfMilliseconds)
  filter.period.to = new Date(periodTo).toISOString()
  const forecastBaseline = query.forecastBaseline === undefined
    ? undefined
    : normalizeDateRange(query.forecastBaseline, 'Analytics forecast baseline')
  return {
    query: {
      filter,
      widgets,
      asOf,
      timeZone,
      ...(forecastBaseline === undefined ? {} : { forecastBaseline }),
    },
    periodFrom,
    periodTo,
    asOf: asOfMilliseconds,
  }
}

function normalizeFilter(filter: AnalyticsFilter): AnalyticsFilter {
  if (!isRecord(filter)) {
    throw invalid('AnalyticsFilterInvalid', 'Analytics filter must be an object.')
  }
  return {
    period: normalizeDateRange(filter.period, 'Analytics period'),
    ...normalizeIdentifierListProperty(filter.teamIds, 'Analytics Team IDs', 'teamIds'),
    ...normalizeIdentifierListProperty(filter.projectIds, 'Analytics Project IDs', 'projectIds'),
    ...normalizeIdentifierListProperty(
      filter.assigneeUserIds,
      'Analytics assignee user IDs',
      'assigneeUserIds',
    ),
    ...normalizeIdentifierListProperty(
      filter.statusCategories,
      'Analytics status categories',
      'statusCategories',
    ),
    ...(filter.customFields === undefined
      ? {}
      : { customFields: normalizeCustomFieldFilters(filter.customFields) }),
    ...(filter.includeArchived === undefined
      ? {}
      : { includeArchived: readBoolean(filter.includeArchived, 'Analytics includeArchived') }),
  }
}

function normalizeIdentifierListProperty(
  value: unknown,
  label: string,
  property: 'teamIds' | 'projectIds' | 'assigneeUserIds' | 'statusCategories',
): Partial<Pick<
  AnalyticsFilter,
  'teamIds' | 'projectIds' | 'assigneeUserIds' | 'statusCategories'
>> {
  if (value === undefined) return {}
  if (!Array.isArray(value)) {
    throw invalid('AnalyticsFilterInvalid', `${label} must be an array.`)
  }
  const values = [...new Set(value.map((item) => readIdentifier(item, label)))].sort()
  return { [property]: values }
}

function normalizeCustomFieldFilters(value: unknown): AnalyticsCustomFieldFilter[] {
  if (!Array.isArray(value)) {
    throw invalid('AnalyticsFilterInvalid', 'Analytics custom field filters must be an array.')
  }
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw invalid(
        'AnalyticsFilterInvalid',
        'Each Analytics custom field filter must be an object.',
      )
    }
    const operator = candidate.operator
    if (
      operator !== 'equals' &&
      operator !== 'not-equals' &&
      operator !== 'contains' &&
      operator !== 'greater-than' &&
      operator !== 'greater-than-or-equal' &&
      operator !== 'less-than' &&
      operator !== 'less-than-or-equal' &&
      operator !== 'is-empty' &&
      operator !== 'is-not-empty'
    ) {
      throw invalid(
        'AnalyticsFilterInvalid',
        'Analytics custom field filter operator is invalid.',
      )
    }
    const fieldId = readIdentifier(candidate.fieldId, 'Analytics custom field ID')
    if (operator !== 'is-empty' && operator !== 'is-not-empty' && candidate.value === undefined) {
      throw invalid(
        'AnalyticsFilterInvalid',
        'Analytics custom field filter value is required for this operator.',
      )
    }
    if (candidate.value !== undefined && !isCustomFieldFilterValue(candidate.value)) {
      throw invalid(
        'AnalyticsFilterInvalid',
        'Analytics custom field filter value is invalid.',
      )
    }
    return {
      fieldId,
      operator,
      ...(candidate.value === undefined ? {} : { value: structuredClone(candidate.value) }),
    }
  })
}

function normalizeWidgets(value: unknown): AnalyticsWidget[] {
  if (!Array.isArray(value)) {
    throw invalid('AnalyticsWidgetsInvalid', 'Analytics widgets must be an array.')
  }
  if (value.length > 50) {
    throw invalid('AnalyticsWidgetsInvalid', 'Analytics reports cannot contain more than 50 widgets.')
  }
  const ids = new Set<string>()
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw invalid('AnalyticsWidgetInvalid', 'Each Analytics widget must be an object.')
    }
    const id = readIdentifier(candidate.id, 'Analytics widget ID')
    if (ids.has(id)) {
      throw invalid('AnalyticsWidgetDuplicate', 'Analytics widget IDs must be unique.')
    }
    ids.add(id)
    const title = readText(candidate.title, 'Analytics widget title', 200)
    const type = candidate.type
    if (type !== 'metric' && type !== 'chart' && type !== 'table') {
      throw invalid('AnalyticsWidgetInvalid', 'Analytics widget type is invalid.')
    }
    const metric = readMetricKey(candidate.metric)
    const visualization = candidate.visualization
    if (visualization !== undefined && visualization !== 'line' && visualization !== 'bar') {
      throw invalid('AnalyticsWidgetInvalid', 'Analytics widget visualization is invalid.')
    }
    const size = candidate.size
    if (size !== undefined && size !== 'small' && size !== 'medium' && size !== 'large') {
      throw invalid('AnalyticsWidgetInvalid', 'Analytics widget size is invalid.')
    }
    const groupBy = candidate.groupBy === undefined
      ? undefined
      : normalizeGroupBy(candidate.groupBy)
    const slaTargetHours = candidate.slaTargetHours === undefined
      ? undefined
      : readPositiveNumber(candidate.slaTargetHours, 'Analytics SLA target hours')
    return {
      id,
      type,
      title,
      metric,
      ...(visualization === undefined ? {} : { visualization }),
      ...(size === undefined ? {} : { size }),
      ...(groupBy === undefined ? {} : { groupBy }),
      ...(slaTargetHours === undefined ? {} : { slaTargetHours }),
    }
  })
}

function normalizeGroupBy(value: unknown): AnalyticsGroupBy {
  if (!isRecord(value)) {
    throw invalid('AnalyticsGroupByInvalid', 'Analytics group-by must be an object.')
  }
  const dimension = value.dimension
  if (
    dimension !== 'day' &&
    dimension !== 'week' &&
    dimension !== 'month' &&
    dimension !== 'team' &&
    dimension !== 'project' &&
    dimension !== 'assignee' &&
    dimension !== 'status' &&
    dimension !== 'custom-field'
  ) {
    throw invalid('AnalyticsGroupByInvalid', 'Analytics group-by dimension is invalid.')
  }
  if (dimension === 'custom-field') {
    return {
      dimension,
      customFieldId: readIdentifier(value.customFieldId, 'Analytics custom field group ID'),
    }
  }
  return { dimension }
}

function normalizeDateRange(value: unknown, label: string): AnalyticsDateRange {
  if (!isRecord(value)) {
    throw invalid('AnalyticsDateRangeInvalid', `${label} must be an object.`)
  }
  const from = normalizeIsoTimestamp(value.from, `${label} start`)
  const to = normalizeIsoTimestamp(value.to, `${label} end`)
  if (Date.parse(from) > Date.parse(to)) {
    throw invalid('AnalyticsDateRangeInvalid', `${label} start cannot be after its end.`)
  }
  return { from, to }
}

function indexAuthorizedEvents(
  workItems: readonly CanonicalWorkItem[],
  events: readonly AuditEventV1[],
) {
  const byCanonicalEntityId = new Map<string, string>()
  const byRawId = new Map<string, string[]>()
  const result = new Map<string, AuditEventV1[]>()
  for (const item of workItems) {
    const key = workItemKey(item.teamId, item.id)
    const entityId = `team/${item.teamId}/issue/${item.id}`
    byCanonicalEntityId.set(entityId, key)
    const keys = byRawId.get(item.id) ?? []
    keys.push(key)
    byRawId.set(item.id, keys)
    result.set(key, [])
  }

  for (const event of events) {
    if (event.entityType !== 'work-item' || event.entity.type !== 'work-item') continue
    const canonicalCandidates = new Set<string>()
    const rawCandidates = new Set<string>()
    for (const eventEntityId of [event.entityId, event.entity.id]) {
      const canonical = byCanonicalEntityId.get(eventEntityId)
      if (canonical) canonicalCandidates.add(canonical)
      const raw = byRawId.get(eventEntityId)
      if (raw?.length === 1) rawCandidates.add(raw[0]!)
    }
    const metadataTeamId = readOptionalAuditString(event.metadata?.teamId)
    const metadataIssueId = readOptionalAuditString(
      event.metadata?.issueId ?? event.metadata?.workItemId,
    )
    const candidates = new Set(canonicalCandidates)
    if (metadataTeamId && metadataIssueId) {
      const metadataKey = workItemKey(metadataTeamId, metadataIssueId)
      if (result.has(metadataKey)) candidates.add(metadataKey)
      for (const rawCandidate of rawCandidates) {
        if (rawCandidate === metadataKey) candidates.add(rawCandidate)
      }
    } else {
      for (const rawCandidate of rawCandidates) candidates.add(rawCandidate)
    }
    if (candidates.size > 1) {
      throw invalid(
        'AnalyticsEventConflict',
        'Analytics event identity resolves to conflicting authorized Work Items.',
      )
    }
    for (const key of candidates) {
      result.get(key)?.push(event)
    }
  }

  for (const itemEvents of result.values()) {
    itemEvents.sort(compareAuditEvents)
    const unique = new Map<string, AuditEventV1>()
    for (const event of itemEvents) {
      const current = unique.get(event.eventId)
      if (current && canonicalJson(current) !== canonicalJson(event)) {
        throw invalid(
          'AnalyticsEventConflict',
          'Analytics event input contains conflicting payloads for one event ID.',
        )
      }
      if (!current) unique.set(event.eventId, event)
    }
    itemEvents.splice(0, itemEvents.length, ...unique.values())
  }
  return result
}

function createFilteredFacts(
  workItems: readonly CanonicalWorkItem[],
  eventsByWorkItem: ReadonlyMap<string, readonly AuditEventV1[]>,
  normalized: NormalizedAnalyticsQuery,
  authorizedProjectIds: ReadonlySet<string>,
) {
  const facts: AnalyticsWorkItemFact[] = []
  for (const item of workItems) {
    const events = eventsByWorkItem.get(workItemKey(item.teamId, item.id)) ?? []
    const fact = createFact(item, events, normalized.asOf)
    if (
      fact &&
      (
        fact.state.assignedProjectId === undefined ||
        authorizedProjectIds.has(fact.state.assignedProjectId)
      ) &&
      matchesAnalyticsFilter(fact.state, normalized.query.filter, normalized.asOf)
    ) {
      facts.push(fact)
    }
  }
  return facts.sort((left, right) =>
    left.state.teamId.localeCompare(right.state.teamId) ||
    left.state.id.localeCompare(right.state.id)
  )
}

function createFact(
  item: CanonicalWorkItem,
  events: readonly AuditEventV1[],
  asOf: number,
): AnalyticsWorkItemFact | undefined {
  const createdAt = Date.parse(item.createdAt)
  if (!Number.isFinite(createdAt) || createdAt > asOf) return undefined
  const state = createCurrentAnalyticsState(item)
  const laterEvents = events
    .filter((event) => Date.parse(event.occurredAt) > asOf)
    .sort((left, right) => compareAuditEvents(right, left))
  for (const event of laterEvents) {
    rewindStateChanges(state, event.changes)
  }
  if (Date.parse(state.createdAt) > asOf) return undefined

  const statusTransitions = events
    .flatMap((event) => createStatusTransitions(event))
    .filter((transition) => transition.occurredAt <= asOf)
    .sort((left, right) =>
      left.occurredAt - right.occurredAt ||
      left.event.eventId.localeCompare(right.event.eventId)
    )
  const scopeChanges = events
    .flatMap((event) => createScopeChanges(event))
    .filter((change) => change.occurredAt <= asOf)
    .sort((left, right) =>
      left.occurredAt - right.occurredAt ||
      left.event.eventId.localeCompare(right.event.eventId)
    )
  let completionAt: number | undefined
  let cycleHours: number | undefined
  let leadHours: number | undefined
  if (state.statusCategory === 'completed') {
    const completionTransitions = statusTransitions.filter(
      (transition) => transition.after === 'completed',
    )
    const completion = completionTransitions.at(-1)
    if (completion) {
      const effectiveCompletionAt = completion.occurredAt
      completionAt = effectiveCompletionAt
      leadHours = nonNegativeHours(effectiveCompletionAt - createdAt)
      const previousCompletionAt = completionTransitions.length > 1
        ? completionTransitions.at(-2)?.occurredAt
        : undefined
      const started = statusTransitions
        .filter((transition) =>
          transition.after === 'started' &&
          transition.occurredAt <= effectiveCompletionAt &&
          (previousCompletionAt === undefined || transition.occurredAt > previousCompletionAt)
        )
        .at(-1)
      if (started) {
        cycleHours = nonNegativeHours(effectiveCompletionAt - started.occurredAt)
      }
    }
  }
  return {
    state,
    events: [...events],
    createdAt,
    ...(completionAt === undefined ? {} : { completionAt }),
    ...(cycleHours === undefined ? {} : { cycleHours }),
    ...(leadHours === undefined ? {} : { leadHours }),
    scopeChanges,
  }
}

function createCurrentAnalyticsState(item: CanonicalWorkItem): AnalyticsWorkItemState {
  return {
    id: item.id,
    teamId: item.teamId,
    title: item.title,
    ...(item.assignedProjectId === undefined
      ? {}
      : { assignedProjectId: item.assignedProjectId }),
    assigneeUserId: item.assigneeUserId,
    statusCategory: item.statusCategory,
    customFieldValues: structuredClone(item.customFieldValues),
    dueDate: item.dueDate,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.archivedAt === undefined ? {} : { archivedAt: item.archivedAt }),
  }
}

function rewindStateChanges(
  state: AnalyticsWorkItemState,
  changes: readonly AuditFieldChange[],
) {
  const hasCustomFieldChildChange = changes.some((change) =>
    normalizeAnalyticsFieldPath(change.field)?.startsWith('customFieldValues.') === true
  )
  for (const change of [...changes].reverse()) {
    if (
      normalizeAnalyticsFieldPath(change.field) === 'customFieldValues' &&
      change.before === undefined &&
      hasCustomFieldChildChange
    ) {
      continue
    }
    rewindStateChange(state, change)
  }
}

function rewindStateChange(state: AnalyticsWorkItemState, change: AuditFieldChange) {
  if (change.redacted) return
  const field = normalizeAnalyticsFieldPath(change.field)
  if (!field) return
  setAnalyticsStateField(state, field, change.before)
}

function normalizeAnalyticsFieldPath(field: string) {
  if (field === 'workflowStatusCategory' || field === 'workflow.category') {
    return 'statusCategory'
  }
  if (
    field === 'title' ||
    field === 'assignedProjectId' ||
    field === 'assigneeUserId' ||
    field === 'statusCategory' ||
    field === 'dueDate' ||
    field === 'createdAt' ||
    field === 'updatedAt' ||
    field === 'archivedAt' ||
    field === 'customFieldValues' ||
    field.startsWith('customFieldValues.')
  ) {
    return field
  }
  return undefined
}

function setAnalyticsStateField(
  state: AnalyticsWorkItemState,
  field: string,
  value: AuditValue | undefined,
) {
  if (field.startsWith('customFieldValues.')) {
    const fieldId = field.slice('customFieldValues.'.length)
    if (!fieldId) return
    if (value === undefined || value === null) {
      delete state.customFieldValues[fieldId]
    } else if (isCanonicalCustomFieldValue(value)) {
      state.customFieldValues[fieldId] = structuredClone(value)
    }
    return
  }
  if (field === 'customFieldValues') {
    state.customFieldValues = readCustomFieldValues(value)
    return
  }
  if (field === 'assignedProjectId' || field === 'archivedAt') {
    if (typeof value === 'string' && value.length > 0) {
      state[field] = value
    } else {
      delete state[field]
    }
    return
  }
  if (
    field === 'title' ||
    field === 'assigneeUserId' ||
    field === 'statusCategory' ||
    field === 'dueDate' ||
    field === 'createdAt' ||
    field === 'updatedAt'
  ) {
    if (typeof value === 'string') state[field] = value
  }
}

function createStatusTransitions(event: AuditEventV1): AnalyticsStatusTransition[] {
  const occurredAt = Date.parse(event.occurredAt)
  if (!Number.isFinite(occurredAt)) return []
  return event.changes.flatMap((change) => {
    if (change.redacted) return []
    if (normalizeAnalyticsFieldPath(change.field) !== 'statusCategory') return []
    const before = typeof change.before === 'string' ? change.before : undefined
    const after = typeof change.after === 'string' ? change.after : undefined
    if (before === after) return []
    return [{
      event,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      occurredAt,
    }]
  })
}

function createScopeChanges(event: AuditEventV1): AnalyticsScopeChange[] {
  const occurredAt = Date.parse(event.occurredAt)
  if (!Number.isFinite(occurredAt)) return []
  return event.changes.flatMap((change) => {
    if (change.redacted) return []
    if (normalizeAnalyticsFieldPath(change.field) !== 'assignedProjectId') return []
    const before = typeof change.before === 'string' ? change.before : undefined
    const after = typeof change.after === 'string' ? change.after : undefined
    if (before === after) return []
    return [{
      event,
      occurredAt,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    }]
  })
}

function matchesAnalyticsFilter(
  state: AnalyticsWorkItemState,
  filter: AnalyticsFilter,
  asOf: number,
) {
  if (!filter.includeArchived && state.archivedAt !== undefined) {
    const archivedAt = Date.parse(state.archivedAt)
    if (!Number.isFinite(archivedAt) || archivedAt <= asOf) return false
  }
  if (filter.teamIds && !filter.teamIds.includes(state.teamId)) return false
  if (
    filter.projectIds &&
    (state.assignedProjectId === undefined || !filter.projectIds.includes(state.assignedProjectId))
  ) return false
  if (filter.assigneeUserIds && !filter.assigneeUserIds.includes(state.assigneeUserId)) return false
  if (filter.statusCategories && !filter.statusCategories.includes(state.statusCategory)) return false
  return (filter.customFields ?? []).every((customFilter) =>
    matchesCustomFieldFilter(state.customFieldValues[customFilter.fieldId], customFilter)
  )
}

function matchesCustomFieldFilter(
  actual: string | number | boolean | string[] | undefined,
  filter: AnalyticsCustomFieldFilter,
) {
  const empty = actual === undefined || actual === '' || (Array.isArray(actual) && actual.length === 0)
  if (filter.operator === 'is-empty') return empty
  if (filter.operator === 'is-not-empty') return !empty
  if (filter.operator === 'equals') return customValuesEqual(actual, filter.value)
  if (filter.operator === 'not-equals') return !customValuesEqual(actual, filter.value)
  if (filter.operator === 'contains') {
    if (Array.isArray(actual)) {
      return Array.isArray(filter.value)
        ? filter.value.every((value) => actual.includes(value))
        : typeof filter.value === 'string' && actual.includes(filter.value)
    }
    return typeof actual === 'string' &&
      typeof filter.value === 'string' &&
      actual.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())
  }
  if (typeof actual !== 'number' || typeof filter.value !== 'number') return false
  if (filter.operator === 'greater-than') return actual > filter.value
  if (filter.operator === 'greater-than-or-equal') return actual >= filter.value
  if (filter.operator === 'less-than') return actual < filter.value
  return actual <= filter.value
}

function customValuesEqual(
  actual: string | number | boolean | string[] | undefined,
  expected: AnalyticsCustomFieldFilter['value'],
) {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length &&
      [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  }
  return actual === expected
}

function createWidgetResult(
  widget: AnalyticsWidget,
  facts: readonly AnalyticsWorkItemFact[],
  workItems: readonly CanonicalWorkItem[],
  eventsByWorkItem: ReadonlyMap<string, readonly AuditEventV1[]>,
  normalized: NormalizedAnalyticsQuery,
  authorizedProjectIds: ReadonlySet<string>,
): AnalyticsWidgetResult {
  const total = calculateMetric(
    widget.metric,
    facts,
    normalized,
    normalized.periodFrom,
    normalized.periodTo,
    normalized.asOf,
    widget.slaTargetHours,
  )
  const calendarGroup = widget.groupBy === undefined ||
    widget.groupBy.dimension === 'day' ||
    widget.groupBy.dimension === 'week' ||
    widget.groupBy.dimension === 'month'
  const series = widget.type === 'chart' && calendarGroup
    ? createMetricSeries(
        widget,
        workItems,
        eventsByWorkItem,
        normalized,
        authorizedProjectIds,
      )
    : []
  const groups = widget.groupBy === undefined
    ? []
    : createMetricGroups(
        widget,
        facts,
        workItems,
        eventsByWorkItem,
        normalized,
        authorizedProjectIds,
      )
  const evidence = dedupeEvidence(total.evidence).sort(compareEvidence)
  const rows: AnalyticsTableRow[] = widget.type === 'table'
    ? evidence.map((item) => ({
        id: item.id,
        label: item.title,
        values: {
          teamId: item.teamId,
          workItemId: item.workItemId,
          projectId: item.projectId ?? null,
          occurredAt: item.occurredAt,
          value: item.value ?? null,
        },
      }))
    : []
  return {
    widgetId: widget.id,
    metric: widget.metric,
    definition: ANALYTICS_METRIC_DEFINITIONS[widget.metric],
    value: total.value,
    sampleSize: total.sampleSize,
    series,
    groups,
    rows,
    warnings: total.warnings,
  }
}

function createMetricSeries(
  widget: AnalyticsWidget,
  workItems: readonly CanonicalWorkItem[],
  eventsByWorkItem: ReadonlyMap<string, readonly AuditEventV1[]>,
  normalized: NormalizedAnalyticsQuery,
  authorizedProjectIds: ReadonlySet<string>,
) {
  const granularity = widget.groupBy?.dimension === 'week' ||
      widget.groupBy?.dimension === 'month'
    ? widget.groupBy.dimension
    : 'day'
  const buckets = createCalendarBuckets(
    normalized.periodFrom,
    normalized.periodTo,
    normalized.query.timeZone,
    granularity,
  )
  return buckets.map((bucket): AnalyticsSeriesPoint => {
    const evaluationAt = Math.min(bucket.to, normalized.asOf)
    const bucketNormalized: NormalizedAnalyticsQuery = {
      query: {
        ...normalized.query,
        asOf: new Date(evaluationAt).toISOString(),
      },
      periodFrom: normalized.periodFrom,
      periodTo: normalized.periodTo,
      asOf: evaluationAt,
    }
    const bucketFacts = widget.metric === 'wip' || widget.metric === 'overdue'
      ? createFilteredFacts(
          workItems,
          eventsByWorkItem,
          bucketNormalized,
          authorizedProjectIds,
        )
      : createFilteredFacts(
          workItems,
          eventsByWorkItem,
          normalized,
          authorizedProjectIds,
        )
    const computation = calculateMetric(
      widget.metric,
      bucketFacts,
      bucketNormalized,
      bucket.from,
      bucket.to,
      evaluationAt,
      widget.slaTargetHours,
    )
    return {
      from: new Date(bucket.from).toISOString(),
      to: new Date(bucket.to).toISOString(),
      value: computation.value,
      sampleSize: computation.sampleSize,
    }
  })
}

function createMetricGroups(
  widget: AnalyticsWidget,
  facts: readonly AnalyticsWorkItemFact[],
  workItems: readonly CanonicalWorkItem[],
  eventsByWorkItem: ReadonlyMap<string, readonly AuditEventV1[]>,
  normalized: NormalizedAnalyticsQuery,
  authorizedProjectIds: ReadonlySet<string>,
) {
  const groupBy = widget.groupBy!
  if (
    groupBy.dimension === 'day' ||
    groupBy.dimension === 'week' ||
    groupBy.dimension === 'month'
  ) {
    return createCalendarBuckets(
      normalized.periodFrom,
      normalized.periodTo,
      normalized.query.timeZone,
      groupBy.dimension,
    ).map((bucket): AnalyticsGroup => {
      const evaluationAt = Math.min(bucket.to, normalized.asOf)
      const bucketNormalized: NormalizedAnalyticsQuery = {
        query: {
          ...normalized.query,
          asOf: new Date(evaluationAt).toISOString(),
        },
        periodFrom: normalized.periodFrom,
        periodTo: normalized.periodTo,
        asOf: evaluationAt,
      }
      const metricFacts = widget.metric === 'wip' || widget.metric === 'overdue'
        ? createFilteredFacts(
            workItems,
            eventsByWorkItem,
            bucketNormalized,
            authorizedProjectIds,
          )
        : facts
      const result = calculateMetric(
        widget.metric,
        metricFacts,
        bucketNormalized,
        bucket.from,
        bucket.to,
        evaluationAt,
        widget.slaTargetHours,
      )
      const label = localDateAt(bucket.from, normalized.query.timeZone)
      return {
        key: label,
        label,
        value: result.value,
        sampleSize: result.sampleSize,
      }
    })
  }
  const grouped = new Map<string, {
    label: string
    facts: AnalyticsWorkItemFact[]
  }>()
  for (const fact of facts) {
    const identity = analyticsGroupIdentity(fact.state, groupBy)
    const group = grouped.get(identity.key) ?? { label: identity.label, facts: [] }
    group.facts.push(fact)
    grouped.set(identity.key, group)
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]): AnalyticsGroup => {
      const result = calculateMetric(
        widget.metric,
        group.facts,
        normalized,
        normalized.periodFrom,
        normalized.periodTo,
        normalized.asOf,
        widget.slaTargetHours,
      )
      return {
        key,
        label: group.label,
        value: result.value,
        sampleSize: result.sampleSize,
      }
    })
}

function analyticsGroupIdentity(state: AnalyticsWorkItemState, groupBy: AnalyticsGroupBy) {
  if (groupBy.dimension === 'team') return { key: state.teamId, label: state.teamId }
  if (groupBy.dimension === 'project') {
    const value = state.assignedProjectId
    return value === undefined
      ? { key: '', label: 'Unassigned' }
      : { key: value, label: value }
  }
  if (groupBy.dimension === 'assignee') {
    return { key: state.assigneeUserId, label: state.assigneeUserId }
  }
  if (groupBy.dimension === 'status') {
    return { key: state.statusCategory, label: state.statusCategory }
  }
  if (groupBy.dimension === 'custom-field') {
    const value = state.customFieldValues[groupBy.customFieldId]
    if (value === undefined) return { key: 'unset', label: 'Unassigned' }
    if (Array.isArray(value)) {
      const normalized = [...new Set(value)].sort()
      return {
        key: `strings:${JSON.stringify(normalized)}`,
        label: normalized.join(', '),
      }
    }
    return {
      key: `${typeof value}:${JSON.stringify(value)}`,
      label: String(value),
    }
  }
  return { key: '', label: 'Unassigned' }
}

function calculateMetric(
  metric: AnalyticsMetricKey,
  facts: readonly AnalyticsWorkItemFact[],
  normalized: NormalizedAnalyticsQuery,
  from: number,
  to: number,
  evaluationAt: number,
  slaTargetHours = DEFAULT_SLA_TARGET_HOURS,
): MetricComputation {
  if (metric === 'throughput' || metric === 'velocity') {
    const completed = facts.filter((fact) =>
      fact.completionAt !== undefined &&
      fact.completionAt >= from &&
      fact.completionAt <= to
    )
    const count = completed.length
    const value = metric === 'throughput'
      ? count
      : roundMetric(
          count * 7 /
          Math.max(1, createCalendarBuckets(
            from,
            to,
            normalized.query.timeZone,
            'day',
          ).length),
        )
    return {
      value,
      sampleSize: count,
      evidence: completed.map((fact) =>
        createFactEvidence(fact, metric, fact.completionAt!, metric === 'velocity' ? 1 : undefined)
      ),
      warnings: count === 0 ? ['No effective completions were recorded in this period.'] : [],
    }
  }
  if (metric === 'cycle-time' || metric === 'lead-time') {
    const samples = facts.flatMap((fact) => {
      if (
        fact.completionAt === undefined ||
        fact.completionAt < from ||
        fact.completionAt > to
      ) return []
      const value = metric === 'cycle-time' ? fact.cycleHours : fact.leadHours
      return value === undefined ? [] : [{ fact, value }]
    })
    return {
      value: samples.length === 0
        ? null
        : roundMetric(samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length),
      sampleSize: samples.length,
      evidence: samples.map(({ fact, value }) =>
        createFactEvidence(fact, metric, fact.completionAt!, value)
      ),
      warnings: samples.length === 0
        ? [`No ${metric === 'cycle-time' ? 'cycle' : 'lead'} time samples are available.`]
        : [],
    }
  }
  if (metric === 'wip') {
    const samples = facts.filter((fact) =>
      fact.createdAt <= evaluationAt && fact.state.statusCategory === 'started'
    )
    return {
      value: samples.length,
      sampleSize: samples.length,
      evidence: samples.map((fact) => createFactEvidence(fact, metric, evaluationAt)),
      warnings: [],
    }
  }
  if (metric === 'overdue') {
    const evaluatedDate = localDateAt(evaluationAt, normalized.query.timeZone)
    const samples = facts.filter((fact) =>
      fact.createdAt <= evaluationAt &&
      fact.state.statusCategory !== 'completed' &&
      fact.state.statusCategory !== 'canceled' &&
      normalizeDateOnly(fact.state.dueDate) !== undefined &&
      normalizeDateOnly(fact.state.dueDate)! < evaluatedDate
    )
    const invalidDueDateCount = facts.filter((fact) =>
      fact.state.dueDate !== '' && normalizeDateOnly(fact.state.dueDate) === undefined
    ).length
    return {
      value: samples.length,
      sampleSize: samples.length,
      evidence: samples.map((fact) => createFactEvidence(fact, metric, evaluationAt)),
      warnings: invalidDueDateCount === 0
        ? []
        : [`${invalidDueDateCount} Work Item due date value(s) were invalid and excluded.`],
    }
  }
  if (metric === 'scope-change') {
    const samples = facts.flatMap((fact) =>
      fact.scopeChanges
        .filter((change) => change.occurredAt >= from && change.occurredAt <= to)
        .map((change) => ({ fact, change }))
    )
    return {
      value: samples.length,
      sampleSize: samples.length,
      evidence: samples.map(({ fact, change }) =>
        createFactEvidence(fact, metric, change.occurredAt, 1, change.event)
      ),
      warnings: samples.length === 0 ? ['No Project scope changes were recorded in this period.'] : [],
    }
  }
  const normalizedTarget = Number.isFinite(slaTargetHours) && slaTargetHours > 0
    ? slaTargetHours
    : DEFAULT_SLA_TARGET_HOURS
  const completed = facts.flatMap((fact) =>
    fact.completionAt !== undefined &&
    fact.completionAt >= from &&
    fact.completionAt <= to &&
    fact.leadHours !== undefined
      ? [{ fact, attained: fact.leadHours <= normalizedTarget }]
      : []
  )
  return {
    value: completed.length === 0
      ? null
      : roundMetric(
          completed.filter((sample) => sample.attained).length * 100 / completed.length,
        ),
    sampleSize: completed.length,
    evidence: completed.map(({ fact, attained }) =>
      createFactEvidence(fact, metric, fact.completionAt!, attained ? 1 : 0)
    ),
    warnings: completed.length === 0 ? ['No SLA samples are available.'] : [],
  }
}

function createFactEvidence(
  fact: AnalyticsWorkItemFact,
  metric: AnalyticsMetricKey,
  occurredAt: number,
  value?: number,
  explicitEvent?: AuditEventV1,
): AnalyticsEvidenceItem {
  const event = explicitEvent ?? fact.events.find((candidate) =>
    Date.parse(candidate.occurredAt) === occurredAt &&
    (metric !== 'throughput' && metric !== 'cycle-time' &&
      metric !== 'lead-time' && metric !== 'velocity' && metric !== 'sla'
      ? true
      : createStatusTransitions(candidate).some((transition) => transition.after === 'completed'))
  )
  const occurredAtIso = new Date(occurredAt).toISOString()
  return {
    id: hashCanonical({
      metric,
      teamId: fact.state.teamId,
      workItemId: fact.state.id,
      occurredAt: occurredAtIso,
      eventId: event?.eventId,
    }),
    teamId: fact.state.teamId,
    workItemId: fact.state.id,
    ...(fact.state.assignedProjectId === undefined
      ? {}
      : { projectId: fact.state.assignedProjectId }),
    title: fact.state.title,
    ...(event === undefined ? {} : { eventId: event.eventId }),
    occurredAt: occurredAtIso,
    ...(value === undefined ? {} : { value: roundMetric(value) }),
  }
}

function createForecast(
  facts: readonly AnalyticsWorkItemFact[],
  normalized: NormalizedAnalyticsQuery,
): AnalyticsForecast {
  const completionTimes = facts.flatMap((fact) =>
    fact.completionAt !== undefined &&
    fact.completionAt >= normalized.periodFrom &&
    fact.completionAt <= normalized.periodTo
      ? [fact.completionAt]
      : []
  )
  const remainingWorkItems = facts.filter((fact) =>
    fact.state.statusCategory !== 'completed' && fact.state.statusCategory !== 'canceled'
  ).length
  const dailyBuckets = createCalendarBuckets(
    normalized.periodFrom,
    normalized.periodTo,
    normalized.query.timeZone,
    'day',
  )
  const dailyCompletionCounts = dailyBuckets.map((bucket) =>
    completionTimes.filter((completionAt) =>
      completionAt >= bucket.from && completionAt <= bucket.to
    ).length
  )
  const rawDailyThroughput = completionTimes.length / Math.max(1, dailyBuckets.length)
  const dailyThroughput = roundMetric(rawDailyThroughput)
  const confidence = roundMetric(Math.min(1, completionTimes.length / 20))
  const completionDayScenarios = completionTimes.length >= 2 && rawDailyThroughput > 0
    ? createEmpiricalCompletionDayScenarios(dailyCompletionCounts, remainingWorkItems)
    : []
  const completionDate = (quantile: number) => {
    const days = empiricalQuantile(completionDayScenarios, quantile)
    return days === undefined
      ? null
      : new Date(addLocalCalendarDays(
          normalized.asOf,
          days,
          normalized.query.timeZone,
        )).toISOString()
  }
  const p50 = completionDate(0.5)
  const p85 = completionDate(0.85)
  const p95 = completionDate(0.95)
  let risk: AnalyticsForecast['risk'] = 'unknown'
  if (normalized.query.forecastBaseline && p85) {
    const target = Date.parse(normalized.query.forecastBaseline.to)
    const drift = Date.parse(p85) - target
    risk = drift <= 0 ? 'low' : drift <= 7 * MILLISECONDS_PER_DAY ? 'medium' : 'high'
  }
  return {
    remainingWorkItems,
    sampleSize: completionTimes.length,
    dailyThroughput,
    p50,
    p85,
    p95,
    confidence,
    risk,
    ...(normalized.query.forecastBaseline === undefined
      ? {}
      : { baseline: structuredClone(normalized.query.forecastBaseline) }),
  }
}

function createEmpiricalCompletionDayScenarios(
  dailyCompletionCounts: readonly number[],
  remainingWorkItems: number,
) {
  const cycleThroughput = dailyCompletionCounts.reduce((sum, count) => sum + count, 0)
  if (dailyCompletionCounts.length === 0 || cycleThroughput <= 0) return []
  if (remainingWorkItems === 0) return dailyCompletionCounts.map(() => 0)

  return dailyCompletionCounts.map((_, startIndex) => {
    const completeCycles = Math.floor((remainingWorkItems - 1) / cycleThroughput)
    let outstanding = remainingWorkItems - completeCycles * cycleThroughput
    let elapsedDays = completeCycles * dailyCompletionCounts.length
    for (let offset = 0; offset < dailyCompletionCounts.length; offset += 1) {
      outstanding -= dailyCompletionCounts[
        (startIndex + offset) % dailyCompletionCounts.length
      ]!
      elapsedDays += 1
      if (outstanding <= 0) return elapsedDays
    }
    return elapsedDays
  })
}

function empiricalQuantile(values: readonly number[], quantile: number) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1)
  return sorted[Math.min(index, sorted.length - 1)]
}

function addLocalCalendarDays(timestamp: number, days: number, timeZone: string) {
  const local = localDatePartsAt(timestamp, timeZone)
  const target = toPseudoUtcDate(local.year, local.month, local.day)
  target.setUTCDate(target.getUTCDate() + days)
  const candidates = resolveLocalScheduleInstants(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    local.hour,
    local.minute,
    timeZone,
  )
  const candidate = candidates[0]
  if (candidate === undefined) {
    throw new AnalyticsError(
      500,
      'AnalyticsForecastUnresolvable',
      'Analytics forecast date could not be resolved in the report time zone.',
    )
  }
  return candidate +
    local.second * 1_000 +
    new Date(timestamp).getUTCMilliseconds()
}

function createCalendarBuckets(
  from: number,
  to: number,
  timeZone: string,
  granularity: 'day' | 'week' | 'month',
) {
  const firstLocal = localDatePartsAt(from, timeZone)
  let cursor = toPseudoUtcDate(firstLocal.year, firstLocal.month, firstLocal.day)
  if (granularity === 'week') {
    const weekday = cursor.getUTCDay()
    cursor.setUTCDate(cursor.getUTCDate() - ((weekday + 6) % 7))
  } else if (granularity === 'month') {
    cursor.setUTCDate(1)
  }
  const result: AnalyticsBucket[] = []
  while (true) {
    const next = new Date(cursor)
    if (granularity === 'day') next.setUTCDate(next.getUTCDate() + 1)
    if (granularity === 'week') next.setUTCDate(next.getUTCDate() + 7)
    if (granularity === 'month') next.setUTCMonth(next.getUTCMonth() + 1, 1)
    const bucketStart = zonedDateTimeToUtc(cursor, timeZone)
    const nextStart = zonedDateTimeToUtc(next, timeZone)
    if (bucketStart > to) break
    const clippedFrom = Math.max(from, bucketStart)
    const clippedTo = Math.min(to, nextStart - 1)
    if (clippedFrom <= clippedTo) result.push({ from: clippedFrom, to: clippedTo })
    cursor = next
  }
  return result
}

function localDateAt(timestamp: number, timeZone: string) {
  const parts = localDatePartsAt(timestamp, timeZone)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function localDatePartsAt(timestamp: number, timeZone: string) {
  let formatter = localDateFormatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    localDateFormatterCache.set(timeZone, formatter)
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(timestamp)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  }
}

function toPseudoUtcDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day))
}

function zonedDateTimeToUtc(localDate: Date, timeZone: string) {
  const desired = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
    0,
    0,
    0,
  )
  let candidate = desired
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const observed = localDatePartsAt(candidate, timeZone)
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    )
    candidate += desired - observedAsUtc
  }
  return candidate
}

function isScheduleLocalDate(schedule: AnalyticsSchedule, date: Date) {
  if (schedule.frequency === 'daily') return true
  if (schedule.frequency === 'weekly') return date.getUTCDay() === schedule.dayOfWeek
  const requestedDay = schedule.dayOfMonth!
  const lastDay = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    0,
  )).getUTCDate()
  return date.getUTCDate() === Math.min(requestedDay, lastDay)
}

function resolveLocalScheduleInstants(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0)
  let estimate = desired
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = localDatePartsAt(estimate, timeZone)
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    )
    estimate += desired - observedAsUtc
  }
  const exact = [
    -120, -90, -60, -30, 0, 30, 60, 90, 120,
  ].map((offsetMinutes) => estimate + offsetMinutes * 60_000)
    .filter((instant) => {
      const observed = localDatePartsAt(instant, timeZone)
      return Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        0,
      ) === desired
    })
  if (exact.length > 0) return [...new Set(exact)].sort((left, right) => left - right)

  let gapCandidate: { local: number; instant: number } | undefined
  const start = estimate - 3 * MILLISECONDS_PER_HOUR
  const end = estimate + 3 * MILLISECONDS_PER_HOUR
  for (let instant = start; instant <= end; instant += 60_000) {
    const observed = localDatePartsAt(instant, timeZone)
    const observedLocal = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      0,
    )
    if (
      observed.year === year &&
      observed.month === month &&
      observed.day === day &&
      observedLocal > desired &&
      (
        gapCandidate === undefined ||
        observedLocal < gapCandidate.local ||
        (observedLocal === gapCandidate.local && instant < gapCandidate.instant)
      )
    ) {
      gapCandidate = { local: observedLocal, instant }
    }
  }
  return gapCandidate === undefined ? [] : [gapCandidate.instant]
}

function dedupeEvidence(items: readonly AnalyticsEvidenceItem[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()]
}

function compareEvidence(left: AnalyticsEvidenceItem, right: AnalyticsEvidenceItem) {
  return right.occurredAt.localeCompare(left.occurredAt) ||
    left.teamId.localeCompare(right.teamId) ||
    left.workItemId.localeCompare(right.workItemId) ||
    left.id.localeCompare(right.id)
}

function normalizeSnapshot(snapshot: AnalyticsSnapshot) {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== ANALYTICS_SCHEMA_VERSION) {
    throw invalid('AnalyticsSnapshotInvalid', 'Analytics snapshot schema is invalid.')
  }
  normalizeIsoTimestamp(snapshot.asOf, 'Analytics snapshot as-of time')
  normalizeIsoTimestamp(snapshot.generatedAt, 'Analytics snapshot generated time')
  normalizeTimeZone(snapshot.timeZone, 'Analytics snapshot time zone')
  readIdentifier(snapshot.queryHash, 'Analytics snapshot query hash')
  readIdentifier(snapshot.permissionScopeHash, 'Analytics snapshot permission scope hash')
  normalizeFilter(snapshot.filter)
  if (!Array.isArray(snapshot.widgets) || !isRecord(snapshot.forecast)) {
    throw invalid('AnalyticsSnapshotInvalid', 'Analytics snapshot payload is invalid.')
  }
  return structuredClone(snapshot)
}

function escapeCsvValue(value: string | number | boolean | null | undefined) {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`
  if (/[",\r\n]/u.test(text)) text = `"${text.replaceAll('"', '""')}"`
  return text
}

function createPdfPageContent(
  lines: readonly string[],
  locale: AnalyticsExportLocale,
) {
  return [
    'BT',
    '/F1 12 Tf',
    '50 760 Td',
    ...lines.flatMap((line, index) => [
      ...(index === 0 ? [] : ['0 -18 Td']),
      `${createPdfTextOperand(line, locale)} Tj`,
    ]),
    'ET',
  ].join('\n')
}

function createPdfFontSubsetTag(fontBytes: Uint8Array) {
  const digestPrefix = createHash('sha256')
    .update(fontBytes)
    .digest()
    .readUInt32BE(0)
  let value = digestPrefix % (26 ** 6)
  let tag = ''
  for (let index = 0; index < 6; index += 1) {
    tag = String.fromCharCode(65 + (value % 26)) + tag
    value = Math.floor(value / 26)
  }
  return tag
}

function createPdfTextOperand(value: string, locale: AnalyticsExportLocale) {
  return locale === 'ja'
    ? `<${toAnalyticsPdfGlyphHex(value)}>`
    : `(${escapePdfText(toPdfAscii(value))})`
}

function toAnalyticsPdfGlyphHex(value: string) {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0)!
    if (codePoint >= 0x20 && codePoint <= 0x7E) {
      return (codePoint - 0x1F).toString(16).padStart(4, '0')
    }
    const japaneseIndex = analyticsPdfFont.japaneseGlyphs.indexOf(character)
    if (japaneseIndex < 0) {
      throw invalid(
        'AnalyticsPdfGlyphMissing',
        `Analytics PDF font does not contain the required character U+${toPdfHexCode(codePoint)}.`,
      )
    }
    const glyphId = japaneseIndex + 96
    return glyphId.toString(16).padStart(4, '0')
  }).join('').toUpperCase()
}

function createAnalyticsPdfToUnicodeCMap() {
  const mappings = [
    ...Array.from({ length: 95 }, (_, index) => ({
      glyphId: index + 1,
      unicode: index + 0x20,
    })),
    ...[...analyticsPdfFont.japaneseGlyphs].map((character, index) => ({
      glyphId: index + 96,
      unicode: character.codePointAt(0)!,
    })),
  ]
  const mappingBlocks: string[] = []
  for (let offset = 0; offset < mappings.length; offset += 100) {
    const block = mappings.slice(offset, offset + 100)
    mappingBlocks.push(
      `${block.length} beginbfchar\n` +
      block.map(({ glyphId, unicode }) =>
        `<${toPdfHexCode(glyphId)}> <${toPdfHexCode(unicode)}>`
      ).join('\n') +
      '\nendbfchar',
    )
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /NotoSansJP-Analytics-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...mappingBlocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
}

function toPdfHexCode(value: number) {
  return value.toString(16).padStart(4, '0').toUpperCase()
}

function toPdfAscii(value: string) {
  return value.normalize('NFKD').replace(/[^\x20-\x7E]/gu, '?')
}

function escapePdfText(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function hashCanonical(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`
}

/** Test と local development 向けの in-memory Analytics repository です。 */
export class InMemoryAnalyticsRepository implements AnalyticsRepository {
  /** Workspace/report ごとの report definition です。 */
  private readonly reports = new Map<string, AnalyticsReport>()
  /** Workspace/snapshot ごとの immutable snapshot です。 */
  private readonly snapshots = new Map<string, AnalyticsSnapshotRecord>()
  /** Workspace/occurrence ごとの idempotent receipt です。 */
  private readonly receipts = new Map<string, AnalyticsDeliveryReceipt>()
  /** Timestamp を生成する clock です。 */
  private readonly now: () => Date

  /**
   * In-memory repository を作成します。
   *
   * @param now - Timestamp を生成する注入可能な clock です。
   */
  constructor(now: () => Date = () => new Date()) {
    this.now = now
  }

  /** Workspace report 一覧を返します。 */
  async listReports(workspaceId: string): Promise<AnalyticsReportListResponse> {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    return {
      reports: [...this.reports.values()]
        .filter((report) => report.workspaceId === normalizedWorkspaceId)
        .sort(compareReports)
        .map((report) => structuredClone(report)),
    }
  }

  /** Workspace 内の report を返します。 */
  async getReport(workspaceId: string, reportId: string) {
    const report = this.reports.get(reportMapKey(workspaceId, reportId))
    return report === undefined ? undefined : structuredClone(report)
  }

  /** 新しい report を revision 1 で保存します。 */
  async createReport(
    workspaceId: string,
    ownerMemberKey: string,
    input: CreateAnalyticsReportInput,
  ) {
    const report = createReportDefinition(workspaceId, ownerMemberKey, input, this.now())
    const key = reportMapKey(report.workspaceId, report.id)
    if (this.reports.has(key)) {
      throw conflict('AnalyticsReportAlreadyExists', 'Analytics report already exists.')
    }
    this.reports.set(key, structuredClone(report))
    return structuredClone(report)
  }

  /** Expected revision を満たす report を更新します。 */
  async updateReport(
    workspaceId: string,
    reportId: string,
    input: UpdateAnalyticsReportInput,
  ) {
    const key = reportMapKey(workspaceId, reportId)
    const current = this.reports.get(key)
    if (!current) throw reportNotFound()
    const updated = updateReportDefinition(current, input, this.now())
    this.reports.set(key, structuredClone(updated))
    return structuredClone(updated)
  }

  /** Expected revision を満たす report を削除します。 */
  async deleteReport(workspaceId: string, reportId: string, expectedRevision: number) {
    const key = reportMapKey(workspaceId, reportId)
    const current = this.reports.get(key)
    if (!current) throw reportNotFound()
    requireExpectedRevision(expectedRevision, current.revision)
    this.reports.delete(key)
  }

  /** Immutable snapshot を一度だけ保存します。 */
  async putSnapshot(record: AnalyticsSnapshotRecord) {
    const normalized = normalizeSnapshotRecord(record)
    const key = snapshotMapKey(normalized.workspaceId, normalized.id)
    const current = this.snapshots.get(key)
    if (current) {
      if (!snapshotsEquivalent(current, normalized)) throw snapshotConflict()
      return structuredClone(current)
    }
    this.snapshots.set(key, structuredClone(normalized))
    return structuredClone(normalized)
  }

  /** 保存済み immutable snapshot を返します。 */
  async getSnapshot(workspaceId: string, snapshotId: string) {
    const snapshot = this.snapshots.get(snapshotMapKey(workspaceId, snapshotId))
    return snapshot === undefined ? undefined : structuredClone(snapshot)
  }

  /** Report に紐づく最新の immutable snapshot を作成日時順で上限件数まで返します。 */
  async listSnapshots(
    workspaceId: string,
    reportId: string,
    limit = MAX_SNAPSHOT_LIST_LIMIT,
  ) {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const normalizedReportId = readIdentifier(reportId, 'Analytics report ID')
    const normalizedLimit = readPositiveInteger(
      limit,
      'Analytics snapshot list limit',
      MAX_SNAPSHOT_LIST_LIMIT,
    )
    return [...this.snapshots.values()]
      .filter((snapshot) =>
        snapshot.workspaceId === normalizedWorkspaceId &&
        snapshot.reportId === normalizedReportId
      )
      .sort(compareSnapshots)
      .slice(0, normalizedLimit)
      .map((snapshot) => structuredClone(snapshot))
  }

  /** 指定 shard で実行期限を迎えた schedule 付き report を keyset page で返します。 */
  async listDueReports(
    scheduleShard: string,
    asOf: string,
    limit: number,
    cursor?: string,
  ) {
    const normalizedScheduleShard = readAnalyticsScheduleShard(scheduleShard)
    const normalizedAsOf = normalizeIsoTimestamp(asOf, 'Analytics schedule as-of time')
    const normalizedLimit = readPositiveInteger(limit, 'Analytics schedule limit', 200)
    const scopeHash = hashCanonical({
      scheduleShard: normalizedScheduleShard,
      asOf: normalizedAsOf,
    })
    const exclusiveStartKey = cursor ? parseStorageCursor(cursor, scopeHash) : undefined
    const boundary = exclusiveStartKey === undefined
      ? undefined
      : readAnalyticsDueCursorBoundary(exclusiveStartKey)
    const candidates = [...this.reports.values()]
      .filter((report) =>
        report.schedule?.enabled === true &&
        report.schedule.nextRunAt !== undefined &&
        report.schedule.nextRunAt <= normalizedAsOf &&
        createAnalyticsScheduleShard(report.workspaceId, report.id) ===
          normalizedScheduleShard
      )
      .sort((left, right) =>
        createAnalyticsDueReportBoundary(left).localeCompare(
          createAnalyticsDueReportBoundary(right),
        )
      )
      .filter((report) =>
        boundary === undefined ||
        createAnalyticsDueReportBoundary(report) > boundary
      )
    const page = candidates.slice(0, normalizedLimit)
    const hasNextPage = candidates.length > page.length
    const lastReport = page.at(-1)
    return {
      reports: page.map((report) => structuredClone(report)),
      ...(hasNextPage && lastReport !== undefined
        ? {
            nextCursor: createStorageCursor(scopeHash, {
              nextDeliveryAtRecordKey: createAnalyticsDueReportBoundary(lastReport),
            }),
          }
        : {}),
    }
  }

  /** Schedule occurrence ごとの delivery receipt を idempotent に保存します。 */
  async putDeliveryReceipt(record: AnalyticsDeliveryReceipt) {
    const normalized = normalizeDeliveryReceipt(record)
    const key = deliveryMapKey(
      normalized.workspaceId,
      normalized.reportId,
      normalized.occurrenceKey,
    )
    const current = this.receipts.get(key)
    if (current) {
      if (!deliveryReceiptsEquivalent(current, normalized)) throw deliveryConflict()
      return { created: false, receipt: structuredClone(current) }
    }
    this.receipts.set(key, structuredClone(normalized))
    return { created: true, receipt: structuredClone(normalized) }
  }
}

/** DynamoDB の workspace partition に Analytics rows を保存する repository です。 */
export class DynamoDbAnalyticsRepository implements AnalyticsRepository {
  /** Analytics rows を保存する DynamoDB table 名です。 */
  private readonly tableName: string
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Timestamp を生成する clock です。 */
  private readonly now: () => Date
  /** Schedule due query に使う GSI 名です。 */
  private readonly scheduleDueIndexName: string

  /**
   * DynamoDB repository を作成します。
   *
   * @param tableName - Analytics table 名です。
   * @param documentClient - 設定済み DocumentClient です。
   * @param options - Clock と GSI 名の設定です。
   */
  constructor(
    tableName: string,
    documentClient: DynamoDBDocumentClient,
    options: DynamoDbAnalyticsRepositoryOptions = {},
  ) {
    this.tableName = readIdentifier(tableName, 'Analytics table name')
    this.documentClient = documentClient
    this.now = options.now ?? (() => new Date())
    this.scheduleDueIndexName =
      options.scheduleDueIndexName ?? ANALYTICS_SCHEDULE_DUE_INDEX_NAME
  }

  /** Workspace report 一覧を返します。 */
  async listReports(workspaceId: string): Promise<AnalyticsReportListResponse> {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const items = await this.queryWorkspacePrefix(
      normalizedWorkspaceId,
      REPORT_RECORD_PREFIX,
      MAX_REPORTS_PER_WORKSPACE,
    )
    return {
      reports: items
        .filter(isStoredAnalyticsReport)
        .map(readStoredReport)
        .sort(compareReports),
    }
  }

  /** Workspace 内の report を返します。 */
  async getReport(workspaceId: string, reportId: string) {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const normalizedReportId = readIdentifier(reportId, 'Analytics report ID')
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: normalizedWorkspaceId,
        recordKey: createReportRecordKey(normalizedReportId),
      },
      ConsistentRead: true,
    }))
    return response.Item === undefined ? undefined : readStoredReport(response.Item)
  }

  /** 新しい report を revision 1 で保存します。 */
  async createReport(
    workspaceId: string,
    ownerMemberKey: string,
    input: CreateAnalyticsReportInput,
  ) {
    const report = createReportDefinition(workspaceId, ownerMemberKey, input, this.now())
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: createStoredReport(report),
        ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
      }))
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) {
        throw conflict('AnalyticsReportAlreadyExists', 'Analytics report already exists.')
      }
      throw persistenceError(error)
    }
    return report
  }

  /** Expected revision を満たす report を更新します。 */
  async updateReport(
    workspaceId: string,
    reportId: string,
    input: UpdateAnalyticsReportInput,
  ) {
    const current = await this.getReport(workspaceId, reportId)
    if (!current) throw reportNotFound()
    const updated = updateReportDefinition(current, input, this.now())
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: createStoredReport(updated),
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': input.expectedRevision },
      }))
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) throw revisionConflict()
      throw persistenceError(error)
    }
    return updated
  }

  /** Expected revision を満たす report を削除します。 */
  async deleteReport(workspaceId: string, reportId: string, expectedRevision: number) {
    const current = await this.getReport(workspaceId, reportId)
    if (!current) throw reportNotFound()
    requireExpectedRevision(expectedRevision, current.revision)
    try {
      await this.documentClient.send(new DeleteCommand({
        TableName: this.tableName,
        Key: {
          workspaceId: current.workspaceId,
          recordKey: createReportRecordKey(current.id),
        },
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
      }))
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) throw revisionConflict()
      throw persistenceError(error)
    }
  }

  /** Immutable snapshot を一度だけ保存します。 */
  async putSnapshot(record: AnalyticsSnapshotRecord) {
    const normalized = normalizeSnapshotRecord(record)
    const item = createStoredSnapshot(normalized)
    const claim = createStoredSnapshotIdClaim(normalized)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [{
          Put: {
            TableName: this.tableName,
            Item: claim,
            ConditionExpression:
              'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
          },
        }, {
          Put: {
            TableName: this.tableName,
            Item: item,
            ConditionExpression:
              'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
          },
        }],
      }))
      return normalized
    } catch (error) {
      if (
        !isConditionalTransactionCancellation(error) &&
        !isNamedError(error, 'ConditionalCheckFailedException')
      ) throw persistenceError(error)
      const current = await this.getSnapshot(normalized.workspaceId, normalized.id)
      if (current && snapshotsEquivalent(current, normalized)) return current
      throw snapshotConflict()
    }
  }

  /** 保存済み immutable snapshot を返します。 */
  async getSnapshot(workspaceId: string, snapshotId: string) {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const normalizedSnapshotId = readIdentifier(snapshotId, 'Analytics snapshot ID')
    const claimResponse = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: normalizedWorkspaceId,
        recordKey: createSnapshotIdClaimRecordKey(normalizedSnapshotId),
      },
      ConsistentRead: true,
    }))
    if (claimResponse.Item !== undefined) {
      const claim = readStoredSnapshotIdClaim(claimResponse.Item)
      if (
        claim.workspaceId !== normalizedWorkspaceId ||
        claim.snapshotId !== normalizedSnapshotId
      ) {
        throw persistenceInvalid('Stored Analytics snapshot ID claim is inconsistent.')
      }
      const snapshotResponse = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId: normalizedWorkspaceId,
          recordKey: claim.snapshotRecordKey,
        },
        ConsistentRead: true,
      }))
      if (snapshotResponse.Item === undefined) {
        throw persistenceInvalid('Stored Analytics snapshot ID claim is orphaned.')
      }
      const snapshot = readStoredSnapshot(snapshotResponse.Item)
      if (snapshot.id !== normalizedSnapshotId) {
        throw persistenceInvalid('Stored Analytics snapshot ID claim target is inconsistent.')
      }
      if (createSnapshotRecordKey(snapshot) !== claim.snapshotRecordKey) {
        throw persistenceInvalid('Stored Analytics snapshot ID claim target key is inconsistent.')
      }
      return snapshot
    }
    return undefined
  }

  /** Report に紐づく最新の immutable snapshot をDB側で上限指定して返します。 */
  async listSnapshots(
    workspaceId: string,
    reportId: string,
    limit = MAX_SNAPSHOT_LIST_LIMIT,
  ) {
    const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
    const normalizedReportId = readIdentifier(reportId, 'Analytics report ID')
    const normalizedLimit = readPositiveInteger(
      limit,
      'Analytics snapshot list limit',
      MAX_SNAPSHOT_LIST_LIMIT,
    )
    const snapshots: AnalyticsSnapshotRecord[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
        ExpressionAttributeValues: {
          ':workspaceId': normalizedWorkspaceId,
          ':recordPrefix': createSnapshotReportPrefix(normalizedReportId),
        },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
        Limit: normalizedLimit - snapshots.length,
        ScanIndexForward: false,
      }))
      snapshots.push(
        ...(response.Items ?? [])
          .filter(isStoredAnalyticsSnapshot)
          .map(readStoredSnapshot),
      )
      exclusiveStartKey = response.LastEvaluatedKey
    } while (
      snapshots.length < normalizedLimit &&
      exclusiveStartKey !== undefined
    )
    return snapshots
  }

  /** 指定 shard で実行期限を迎えた schedule 付き report を keyset page で返します。 */
  async listDueReports(
    scheduleShard: string,
    asOf: string,
    limit: number,
    cursor?: string,
  ) {
    const normalizedScheduleShard = readAnalyticsScheduleShard(scheduleShard)
    const normalizedAsOf = normalizeIsoTimestamp(asOf, 'Analytics schedule as-of time')
    const normalizedLimit = readPositiveInteger(limit, 'Analytics schedule limit', 200)
    const scopeHash = hashCanonical({
      indexName: this.scheduleDueIndexName,
      scheduleShard: normalizedScheduleShard,
      asOf: normalizedAsOf,
    })
    const exclusiveStartKey = cursor ? parseStorageCursor(cursor, scopeHash) : undefined
    const response = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: this.scheduleDueIndexName,
      KeyConditionExpression:
        'scheduleShard = :scheduleShard AND nextDeliveryAtRecordKey <= :upperBound',
      ExpressionAttributeValues: {
        ':scheduleShard': normalizedScheduleShard,
        ':upperBound': `${normalizedAsOf}#\u{10FFFF}`,
      },
      ExclusiveStartKey: exclusiveStartKey,
      Limit: normalizedLimit,
      ScanIndexForward: true,
    }))
    return {
      reports: (response.Items ?? [])
        .filter(isStoredAnalyticsReport)
        .map(readStoredReport),
      ...(response.LastEvaluatedKey === undefined
        ? {}
        : { nextCursor: createStorageCursor(scopeHash, response.LastEvaluatedKey) }),
    }
  }

  /** Schedule occurrence ごとの delivery receipt を idempotent に保存します。 */
  async putDeliveryReceipt(record: AnalyticsDeliveryReceipt) {
    const normalized = normalizeDeliveryReceipt(record)
    const item = createStoredDeliveryReceipt(normalized)
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
      }))
      return { created: true, receipt: normalized }
    } catch (error) {
      if (!isNamedError(error, 'ConditionalCheckFailedException')) throw persistenceError(error)
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId: normalized.workspaceId,
          recordKey: item.recordKey,
        },
        ConsistentRead: true,
      }))
      const current = response.Item && isStoredAnalyticsDeliveryReceipt(response.Item)
        ? readStoredDeliveryReceipt(response.Item)
        : undefined
      if (current && deliveryReceiptsEquivalent(current, normalized)) {
        return { created: false, receipt: current }
      }
      throw deliveryConflict()
    }
  }

  /** Workspace partition の prefix rows を上限まで読み込みます。 */
  private async queryWorkspacePrefix(
    workspaceId: string,
    recordPrefix: string,
    maximum: number,
  ) {
    const items: Record<string, unknown>[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordPrefix': recordPrefix,
        },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }))
      items.push(...(response.Items ?? []))
      if (items.length > maximum) {
        throw new AnalyticsError(
          413,
          'AnalyticsReadLimitExceeded',
          'Analytics repository read limit exceeded.',
        )
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return items
  }
}

function createReportDefinition(
  workspaceId: string,
  ownerMemberKey: string,
  input: CreateAnalyticsReportInput,
  now: Date,
): AnalyticsReport {
  if (!isRecord(input)) {
    throw invalid('AnalyticsReportInvalid', 'Analytics report input must be an object.')
  }
  const timestamp = normalizeClockValue(now)
  const visibility = readVisibility(input.visibility)
  const teamId = input.teamId === undefined
    ? undefined
    : readIdentifier(input.teamId, 'Analytics report Team ID')
  validateVisibilityTeam(visibility, teamId)
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    id: readRouteSafeReportId(input.id),
    workspaceId: readIdentifier(workspaceId, 'Workspace ID'),
    name: readText(input.name, 'Analytics report name', 200),
    ...(input.description === undefined
      ? {}
      : { description: readText(input.description, 'Analytics report description', 4_000) }),
    visibility,
    ...(teamId === undefined ? {} : { teamId }),
    ownerMemberKey: readIdentifier(ownerMemberKey, 'Analytics report owner member key'),
    timeZone: normalizeTimeZone(input.timeZone, 'Analytics report time zone'),
    revision: 1,
    filter: normalizeFilter(input.filter),
    ...(input.forecastBaseline === undefined
      ? {}
      : {
          forecastBaseline: normalizeDateRange(
            input.forecastBaseline,
            'Analytics forecast baseline',
          ),
        }),
    widgets: normalizeWidgets(input.widgets),
    ...(input.schedule === undefined ? {} : { schedule: normalizeSchedule(input.schedule, now) }),
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function updateReportDefinition(
  current: AnalyticsReport,
  input: UpdateAnalyticsReportInput,
  now: Date,
): AnalyticsReport {
  if (!isRecord(input)) {
    throw invalid('AnalyticsReportInvalid', 'Analytics report update must be an object.')
  }
  requireExpectedRevision(input.expectedRevision, current.revision)
  const visibility = input.visibility === undefined
    ? current.visibility
    : readVisibility(input.visibility)
  const teamId = input.teamId === undefined
    ? current.teamId
    : input.teamId === null
      ? undefined
      : readIdentifier(input.teamId, 'Analytics report Team ID')
  validateVisibilityTeam(visibility, teamId)
  const description = input.description === undefined
    ? current.description
    : input.description === null
      ? undefined
      : readText(input.description, 'Analytics report description', 4_000)
  const schedule = input.schedule === undefined
    ? current.schedule
    : input.schedule === null
      ? undefined
      : normalizeSchedule(input.schedule, now)
  const forecastBaseline = input.forecastBaseline === undefined
    ? current.forecastBaseline
    : input.forecastBaseline === null
      ? undefined
      : normalizeDateRange(input.forecastBaseline, 'Analytics forecast baseline')
  return {
    ...structuredClone(current),
    name: input.name === undefined
      ? current.name
      : readText(input.name, 'Analytics report name', 200),
    ...(description === undefined ? { description: undefined } : { description }),
    visibility,
    ...(teamId === undefined ? { teamId: undefined } : { teamId }),
    timeZone: input.timeZone === undefined
      ? current.timeZone
      : normalizeTimeZone(input.timeZone, 'Analytics report time zone'),
    revision: current.revision + 1,
    filter: input.filter === undefined ? structuredClone(current.filter) : normalizeFilter(input.filter),
    ...(forecastBaseline === undefined
      ? { forecastBaseline: undefined }
      : { forecastBaseline }),
    widgets: input.widgets === undefined
      ? structuredClone(current.widgets)
      : normalizeWidgets(input.widgets),
    ...(schedule === undefined ? { schedule: undefined } : { schedule }),
    updatedAt: normalizeClockValue(now),
  }
}

function normalizeStoredReport(value: unknown): AnalyticsReport {
  if (!isRecord(value) || value.schemaVersion !== ANALYTICS_SCHEMA_VERSION) {
    throw persistenceInvalid('Stored Analytics report schema is invalid.')
  }
  const visibility = readVisibility(value.visibility)
  const teamId = value.teamId === undefined
    ? undefined
    : readIdentifier(value.teamId, 'Stored Analytics report Team ID')
  validateVisibilityTeam(visibility, teamId)
  const description = value.description === undefined
    ? undefined
    : readText(value.description, 'Stored Analytics report description', 4_000)
  const schedule = value.schedule === undefined
    ? undefined
    : normalizeSchedule(value.schedule, undefined, true)
  const forecastBaseline = value.forecastBaseline === undefined
    ? undefined
    : normalizeDateRange(value.forecastBaseline, 'Stored Analytics forecast baseline')
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    id: readIdentifier(value.id, 'Stored Analytics report ID'),
    workspaceId: readIdentifier(value.workspaceId, 'Stored Analytics Workspace ID'),
    name: readText(value.name, 'Stored Analytics report name', 200),
    ...(description === undefined ? {} : { description }),
    visibility,
    ...(teamId === undefined ? {} : { teamId }),
    ownerMemberKey: readIdentifier(
      value.ownerMemberKey,
      'Stored Analytics report owner member key',
    ),
    timeZone: normalizeTimeZone(value.timeZone, 'Stored Analytics report time zone'),
    revision: readPositiveInteger(value.revision, 'Stored Analytics report revision'),
    filter: normalizeFilter(value.filter as AnalyticsFilter),
    ...(forecastBaseline === undefined ? {} : { forecastBaseline }),
    widgets: normalizeWidgets(value.widgets),
    ...(schedule === undefined ? {} : { schedule }),
    createdAt: normalizeIsoTimestamp(value.createdAt, 'Stored Analytics report creation time'),
    updatedAt: normalizeIsoTimestamp(value.updatedAt, 'Stored Analytics report update time'),
  }
}

function normalizeSchedule(
  value: unknown,
  now?: Date,
  requireStoredNextRunAt = false,
): AnalyticsSchedule {
  if (!isRecord(value)) {
    throw invalid('AnalyticsScheduleInvalid', 'Analytics schedule must be an object.')
  }
  const frequency = value.frequency
  if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') {
    throw invalid('AnalyticsScheduleInvalid', 'Analytics schedule frequency is invalid.')
  }
  const localTime = readText(value.localTime, 'Analytics schedule local time', 5)
  if (!LOCAL_TIME_PATTERN.test(localTime)) {
    throw invalid('AnalyticsScheduleInvalid', 'Analytics schedule local time must use HH:mm.')
  }
  const dayOfWeek = value.dayOfWeek === undefined
    ? undefined
    : readIntegerInRange(value.dayOfWeek, 'Analytics schedule day of week', 0, 6)
  const dayOfMonth = value.dayOfMonth === undefined
    ? undefined
    : readIntegerInRange(value.dayOfMonth, 'Analytics schedule day of month', 1, 31)
  if (frequency === 'weekly' && dayOfWeek === undefined) {
    throw invalid('AnalyticsScheduleInvalid', 'Weekly Analytics schedule requires a day of week.')
  }
  if (frequency === 'monthly' && dayOfMonth === undefined) {
    throw invalid('AnalyticsScheduleInvalid', 'Monthly Analytics schedule requires a day of month.')
  }
  if (frequency !== 'weekly' && dayOfWeek !== undefined) {
    throw invalid(
      'AnalyticsScheduleInvalid',
      'Only weekly Analytics schedules can specify a day of week.',
    )
  }
  if (frequency !== 'monthly' && dayOfMonth !== undefined) {
    throw invalid(
      'AnalyticsScheduleInvalid',
      'Only monthly Analytics schedules can specify a day of month.',
    )
  }
  if (!Array.isArray(value.recipientMemberKeys)) {
    throw invalid(
      'AnalyticsScheduleInvalid',
      'Analytics schedule recipient member keys must be an array.',
    )
  }
  const recipientMemberKeys = [...new Set(value.recipientMemberKeys.map((candidate) =>
    readIdentifier(candidate, 'Analytics schedule recipient member key')
  ))].sort()
  if (recipientMemberKeys.length === 0) {
    throw invalid('AnalyticsScheduleInvalid', 'Analytics schedule requires a recipient.')
  }
  if (value.format !== 'csv' && value.format !== 'pdf') {
    throw invalid('AnalyticsScheduleInvalid', 'Analytics schedule format is invalid.')
  }
  const enabled = readBoolean(value.enabled, 'Analytics schedule enabled')
  let nextRunAt = value.nextRunAt === undefined
    ? undefined
    : normalizeIsoTimestamp(value.nextRunAt, 'Analytics schedule next run time')
  const schedule: AnalyticsSchedule = {
    enabled,
    frequency,
    timeZone: normalizeTimeZone(value.timeZone, 'Analytics schedule time zone'),
    localTime,
    ...(dayOfWeek === undefined ? {} : { dayOfWeek }),
    ...(dayOfMonth === undefined ? {} : { dayOfMonth }),
    recipientMemberKeys,
    format: value.format,
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
  }
  if (enabled && nextRunAt === undefined && now !== undefined) {
    nextRunAt = calculateAnalyticsNextRunAt(schedule, normalizeClockValue(now))
    schedule.nextRunAt = nextRunAt
  }
  if (enabled && nextRunAt === undefined && requireStoredNextRunAt) {
    throw persistenceInvalid('Stored enabled Analytics schedule is missing its next run time.')
  }
  if (!enabled) delete schedule.nextRunAt
  return schedule
}

function normalizeSnapshotRecord(record: AnalyticsSnapshotRecord): AnalyticsSnapshotRecord {
  if (!isRecord(record)) {
    throw invalid('AnalyticsSnapshotInvalid', 'Analytics snapshot record must be an object.')
  }
  const query = normalizeAnalyticsQuery(record.query as AnalyticsQueryInput).query
  const snapshot = normalizeSnapshot(record.snapshot as AnalyticsSnapshot)
  if (snapshot.queryHash !== hashCanonical(query)) {
    throw invalid(
      'AnalyticsSnapshotQueryMismatch',
      'Analytics snapshot query does not match its immutable record query.',
    )
  }
  if (snapshot.asOf !== query.asOf || snapshot.timeZone !== query.timeZone) {
    throw invalid(
      'AnalyticsSnapshotQueryMismatch',
      'Analytics snapshot time scope does not match its immutable record query.',
    )
  }
  validateSnapshotQueryAlignment(snapshot, query)
  const reportId = record.reportId === undefined
    ? undefined
    : readIdentifier(record.reportId, 'Analytics snapshot report ID')
  const reportRevision = record.reportRevision === undefined
    ? undefined
    : readPositiveInteger(record.reportRevision, 'Analytics snapshot report revision')
  if ((reportId === undefined) !== (reportRevision === undefined)) {
    throw invalid(
      'AnalyticsSnapshotInvalid',
      'Analytics snapshot report ID and revision must be specified together.',
    )
  }
  return {
    id: readIdentifier(record.id, 'Analytics snapshot ID'),
    workspaceId: readIdentifier(record.workspaceId, 'Analytics snapshot Workspace ID'),
    ...(reportId === undefined ? {} : { reportId }),
    ...(reportRevision === undefined ? {} : { reportRevision }),
    createdByMemberKey: readIdentifier(
      record.createdByMemberKey,
      'Analytics snapshot creator member key',
    ),
    createdAt: normalizeIsoTimestamp(record.createdAt, 'Analytics snapshot creation time'),
    query,
    snapshot,
  }
}

function validateSnapshotQueryAlignment(
  snapshot: AnalyticsSnapshot,
  query: AnalyticsQueryInput,
) {
  if (canonicalJson(snapshot.filter) !== canonicalJson(query.filter)) {
    throw invalid(
      'AnalyticsSnapshotQueryMismatch',
      'Analytics snapshot filter does not match its immutable record query.',
    )
  }
  if (snapshot.widgets.length !== query.widgets.length) {
    throw invalid(
      'AnalyticsSnapshotQueryMismatch',
      'Analytics snapshot widgets do not match its immutable record query.',
    )
  }
  for (const [index, widget] of query.widgets.entries()) {
    const result = snapshot.widgets[index]
    const calendarGroup = widget.groupBy === undefined ||
      widget.groupBy.dimension === 'day' ||
      widget.groupBy.dimension === 'week' ||
      widget.groupBy.dimension === 'month'
    const expectsSeries = widget.type === 'chart' && calendarGroup
    if (
      !isRecord(result) ||
      result.widgetId !== widget.id ||
      result.metric !== widget.metric ||
      !isRecord(result.definition) ||
      canonicalJson(result.definition) !==
        canonicalJson(ANALYTICS_METRIC_DEFINITIONS[widget.metric]) ||
      !Array.isArray(result.series) ||
      !Array.isArray(result.groups) ||
      !Array.isArray(result.rows) ||
      !Array.isArray(result.warnings) ||
      result.warnings.some((warning) => typeof warning !== 'string') ||
      (!expectsSeries && result.series.length > 0) ||
      (widget.groupBy === undefined && result.groups.length > 0) ||
      (widget.type !== 'table' && result.rows.length > 0)
    ) {
      throw invalid(
        'AnalyticsSnapshotQueryMismatch',
        'Analytics snapshot widget payload does not match its immutable record query.',
      )
    }
  }
  if (
    canonicalJson(snapshot.forecast.baseline) !==
      canonicalJson(query.forecastBaseline)
  ) {
    throw invalid(
      'AnalyticsSnapshotQueryMismatch',
      'Analytics snapshot forecast baseline does not match its immutable record query.',
    )
  }
}

function normalizeDeliveryReceipt(record: AnalyticsDeliveryReceipt): AnalyticsDeliveryReceipt {
  if (!isRecord(record)) {
    throw invalid('AnalyticsDeliveryInvalid', 'Analytics delivery receipt must be an object.')
  }
  if (record.format !== 'csv' && record.format !== 'pdf') {
    throw invalid('AnalyticsDeliveryInvalid', 'Analytics delivery format is invalid.')
  }
  if (!Array.isArray(record.recipientMemberKeys)) {
    throw invalid(
      'AnalyticsDeliveryInvalid',
      'Analytics delivery recipient member keys must be an array.',
    )
  }
  const recipientMemberKeys = [...new Set(record.recipientMemberKeys.map((candidate) =>
    readIdentifier(candidate, 'Analytics delivery recipient member key')
  ))].sort()
  if (recipientMemberKeys.length === 0) {
    throw invalid('AnalyticsDeliveryInvalid', 'Analytics delivery requires a recipient.')
  }
  return {
    workspaceId: readIdentifier(record.workspaceId, 'Analytics delivery Workspace ID'),
    reportId: readIdentifier(record.reportId, 'Analytics delivery report ID'),
    occurrenceKey: readIdentifier(record.occurrenceKey, 'Analytics delivery occurrence key'),
    reportRevision: readPositiveInteger(
      record.reportRevision,
      'Analytics delivery report revision',
    ),
    format: record.format,
    snapshotId: readIdentifier(record.snapshotId, 'Analytics delivery snapshot ID'),
    recipientMemberKeys,
    createdAt: normalizeIsoTimestamp(record.createdAt, 'Analytics delivery creation time'),
  }
}

function createStoredReport(report: AnalyticsReport): StoredAnalyticsReport {
  const scheduled = report.schedule?.enabled === true && report.schedule.nextRunAt !== undefined
  return {
    ...structuredClone(report),
    entryType: 'analytics-report',
    recordKey: createReportRecordKey(report.id),
    ...(scheduled
      ? { scheduleShard: createAnalyticsScheduleShard(report.workspaceId, report.id) }
      : {}),
    ...(scheduled
      ? {
          nextDeliveryAtRecordKey: createAnalyticsNextDeliveryAtRecordKey(
            report.schedule!.nextRunAt!,
            report.workspaceId,
            report.id,
          ),
        }
      : {}),
  }
}

function createStoredSnapshot(record: AnalyticsSnapshotRecord): StoredAnalyticsSnapshot {
  return {
    ...structuredClone(record),
    entryType: 'analytics-snapshot',
    recordKey: createSnapshotRecordKey(record),
  }
}

function createStoredSnapshotIdClaim(
  record: AnalyticsSnapshotRecord,
): StoredAnalyticsSnapshotIdClaim {
  return {
    workspaceId: record.workspaceId,
    entryType: 'analytics-snapshot-id',
    recordKey: createSnapshotIdClaimRecordKey(record.id),
    snapshotId: record.id,
    snapshotRecordKey: createSnapshotRecordKey(record),
  }
}

function createStoredDeliveryReceipt(
  receipt: AnalyticsDeliveryReceipt,
): StoredAnalyticsDeliveryReceipt {
  return {
    ...structuredClone(receipt),
    entryType: 'analytics-delivery',
    recordKey: createAnalyticsDeliveryRecordKey(receipt.reportId, receipt.occurrenceKey),
  }
}

function readStoredReport(value: Record<string, unknown>) {
  if (!isStoredAnalyticsReport(value)) {
    throw persistenceInvalid('Stored Analytics report row is invalid.')
  }
  return normalizeStoredReport(value)
}

function readStoredSnapshot(value: Record<string, unknown>) {
  if (!isStoredAnalyticsSnapshot(value)) {
    throw persistenceInvalid('Stored Analytics snapshot row is invalid.')
  }
  return normalizeSnapshotRecord(value as AnalyticsSnapshotRecord)
}

function readStoredSnapshotIdClaim(value: Record<string, unknown>) {
  if (!isStoredAnalyticsSnapshotIdClaim(value)) {
    throw persistenceInvalid('Stored Analytics snapshot ID claim row is invalid.')
  }
  const workspaceId = readIdentifier(
    value.workspaceId,
    'Stored Analytics snapshot claim Workspace ID',
  )
  const snapshotId = readIdentifier(
    value.snapshotId,
    'Stored Analytics snapshot claim snapshot ID',
  )
  if (
    value.recordKey !== createSnapshotIdClaimRecordKey(snapshotId) ||
    !value.snapshotRecordKey.startsWith(SNAPSHOT_RECORD_PREFIX)
  ) {
    throw persistenceInvalid('Stored Analytics snapshot ID claim row is inconsistent.')
  }
  return {
    workspaceId,
    entryType: 'analytics-snapshot-id' as const,
    recordKey: value.recordKey,
    snapshotId,
    snapshotRecordKey: value.snapshotRecordKey,
  }
}

function readStoredDeliveryReceipt(value: Record<string, unknown>) {
  if (!isStoredAnalyticsDeliveryReceipt(value)) {
    throw persistenceInvalid('Stored Analytics delivery row is invalid.')
  }
  return normalizeDeliveryReceipt(value as AnalyticsDeliveryReceipt)
}

function isStoredAnalyticsReport(value: unknown): value is StoredAnalyticsReport {
  return isRecord(value) &&
    value.entryType === 'analytics-report' &&
    typeof value.recordKey === 'string'
}

function isStoredAnalyticsSnapshot(value: unknown): value is StoredAnalyticsSnapshot {
  return isRecord(value) &&
    value.entryType === 'analytics-snapshot' &&
    typeof value.recordKey === 'string'
}

function isStoredAnalyticsSnapshotIdClaim(
  value: unknown,
): value is StoredAnalyticsSnapshotIdClaim {
  return isRecord(value) &&
    value.entryType === 'analytics-snapshot-id' &&
    typeof value.workspaceId === 'string' &&
    typeof value.recordKey === 'string' &&
    typeof value.snapshotId === 'string' &&
    typeof value.snapshotRecordKey === 'string'
}

function isStoredAnalyticsDeliveryReceipt(
  value: unknown,
): value is StoredAnalyticsDeliveryReceipt {
  return isRecord(value) &&
    value.entryType === 'analytics-delivery' &&
    typeof value.recordKey === 'string'
}

function createReportRecordKey(reportId: string) {
  return `${REPORT_RECORD_PREFIX}${encodeURIComponent(readIdentifier(reportId, 'Analytics report ID'))}`
}

function createSnapshotReportPrefix(reportId: string) {
  return `${SNAPSHOT_RECORD_PREFIX}${encodeURIComponent(
    readIdentifier(reportId, 'Analytics report ID'),
  )}#`
}

function createSnapshotIdClaimRecordKey(snapshotId: string) {
  return `${SNAPSHOT_ID_RECORD_PREFIX}${encodeURIComponent(
    readIdentifier(snapshotId, 'Analytics snapshot ID'),
  )}`
}

function createSnapshotRecordKey(record: AnalyticsSnapshotRecord) {
  const reportPart = record.reportId === undefined ? '~adhoc' : encodeURIComponent(record.reportId)
  const createdAt = new Date(
    normalizeIsoTimestamp(record.createdAt, 'Analytics snapshot creation time'),
  ).toISOString()
  return `${
    SNAPSHOT_RECORD_PREFIX
  }${reportPart}#${createdAt}#${encodeURIComponent(record.id)}`
}

/** Schedule shard key を既知の有限 partition 集合へ正規化します。 */
function readAnalyticsScheduleShard(value: unknown) {
  const shard = readIdentifier(value, 'Analytics schedule shard')
  const index = Number(shard.slice('schedule-'.length))
  if (
    !shard.startsWith('schedule-') ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= ANALYTICS_SCHEDULE_SHARD_COUNT ||
    shard !== `schedule-${String(index).padStart(2, '0')}`
  ) {
    throw invalid(
      'AnalyticsScheduleShardInvalid',
      'Analytics schedule shard is invalid.',
    )
  }
  return shard
}

/** In-memory due page の exclusive boundary を report から返します。 */
function createAnalyticsDueReportBoundary(report: AnalyticsReport) {
  if (report.schedule?.nextRunAt === undefined) {
    throw persistenceInvalid('Due Analytics report is missing its next run time.')
  }
  return createAnalyticsNextDeliveryAtRecordKey(
    report.schedule.nextRunAt,
    report.workspaceId,
    report.id,
  )
}

/** In-memory due cursor の exclusive boundary を検証して返します。 */
function readAnalyticsDueCursorBoundary(key: Record<string, unknown>) {
  const boundary = key.nextDeliveryAtRecordKey
  if (
    typeof boundary !== 'string' ||
    boundary.length === 0 ||
    boundary.length > MAX_DUE_CURSOR_BOUNDARY_LENGTH ||
    hasAnalyticsControlCharacter(boundary)
  ) {
    throw invalid(
      'AnalyticsCursorInvalid',
      'Analytics continuation cursor is invalid.',
    )
  }
  return boundary
}

function createStorageCursor(scopeHash: string, key: Record<string, unknown>) {
  const payload: AnalyticsStorageCursorPayload = {
    version: 1,
    scopeHash,
    key,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function parseStorageCursor(cursor: string, scopeHash: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      Buffer.from(readAnalyticsStorageCursor(cursor), 'base64url').toString('utf8'),
    )
  } catch {
    throw invalid('AnalyticsCursorInvalid', 'Analytics continuation cursor is invalid.')
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    parsed.scopeHash !== scopeHash ||
    !isRecord(parsed.key)
  ) {
    throw invalid(
      'AnalyticsCursorInvalid',
      'Analytics continuation cursor does not match this query.',
    )
  }
  return parsed.key
}

/** Base64url storage cursor を専用の安全上限で検証します。 */
function readAnalyticsStorageCursor(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_STORAGE_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw invalid(
      'AnalyticsCursorInvalid',
      'Analytics continuation cursor is invalid.',
    )
  }
  return value
}

/** Cursor text に ASCII control character が含まれるかを返します。 */
function hasAnalyticsControlCharacter(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || codePoint === 127
  })
}

function normalizeIsoTimestamp(value: unknown, label: string) {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) {
    throw invalid(
      'AnalyticsTimestampInvalid',
      `${label} must be an ISO 8601 timestamp with Z or an explicit UTC offset.`,
    )
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw invalid(
      'AnalyticsTimestampInvalid',
      `${label} must be an ISO 8601 timestamp with Z or an explicit UTC offset.`,
    )
  }
  return new Date(timestamp).toISOString()
}

function normalizeTimeZone(value: unknown, label: string) {
  const timeZone = readIdentifier(value, label)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
  } catch {
    throw invalid('AnalyticsTimeZoneInvalid', `${label} must be a valid IANA time zone.`)
  }
  return timeZone
}

function normalizeDateOnly(value: string) {
  const normalized = value.replaceAll('/', '-')
  if (!ISO_DATE_PATTERN.test(normalized)) return undefined
  const [yearText, monthText, dayText] = normalized.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) return undefined
  return normalized
}

function normalizeClockValue(value: Date) {
  const timestamp = value.getTime()
  if (!Number.isFinite(timestamp)) {
    throw new AnalyticsError(
      500,
      'AnalyticsClockInvalid',
      'Analytics clock returned an invalid timestamp.',
    )
  }
  return value.toISOString()
}

function readIdentifier(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 512 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 31 || codePoint === 127
    })
  ) {
    throw invalid('AnalyticsIdentifierInvalid', `${label} is invalid.`)
  }
  return value.trim()
}

function readRouteSafeReportId(value: unknown) {
  if (typeof value !== 'string' || !ROUTE_SAFE_REPORT_ID_PATTERN.test(value)) {
    throw invalid(
      'AnalyticsReportIdInvalid',
      'Analytics report ID must be a route-safe identifier of at most 128 characters.',
    )
  }
  return value
}

function readText(value: unknown, label: string, maximumLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
    throw invalid('AnalyticsTextInvalid', `${label} is invalid.`)
  }
  return value.trim()
}

function readBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') {
    throw invalid('AnalyticsValueInvalid', `${label} must be a boolean.`)
  }
  return value
}

function readPositiveNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalid('AnalyticsValueInvalid', `${label} must be a positive number.`)
  }
  return value
}

function readPositiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw invalid('AnalyticsValueInvalid', `${label} must be a positive integer.`)
  }
  return value
}

function readNonNegativeInteger(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid('AnalyticsValueInvalid', `${label} must be a non-negative integer.`)
  }
  return value
}

function readIntegerInRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalid(
      'AnalyticsValueInvalid',
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    )
  }
  return value
}

function readMetricKey(value: unknown): AnalyticsMetricKey {
  if (
    value === 'throughput' ||
    value === 'cycle-time' ||
    value === 'lead-time' ||
    value === 'wip' ||
    value === 'overdue' ||
    value === 'scope-change' ||
    value === 'velocity' ||
    value === 'sla'
  ) return value
  throw invalid('AnalyticsMetricInvalid', 'Analytics metric key is invalid.')
}

function readVisibility(value: unknown): AnalyticsReport['visibility'] {
  if (value === 'personal' || value === 'team' || value === 'shared') return value
  throw invalid('AnalyticsVisibilityInvalid', 'Analytics report visibility is invalid.')
}

function validateVisibilityTeam(
  visibility: AnalyticsReport['visibility'],
  teamId: string | undefined,
) {
  if (visibility === 'team' && teamId === undefined) {
    throw invalid('AnalyticsVisibilityInvalid', 'Team reports require a Team ID.')
  }
  if (visibility !== 'team' && teamId !== undefined) {
    throw invalid(
      'AnalyticsVisibilityInvalid',
      'Only Team reports can specify a Team ID.',
    )
  }
}

function requireExpectedRevision(expected: unknown, current: number) {
  const revision = readPositiveInteger(expected, 'Expected Analytics report revision')
  if (revision !== current) throw revisionConflict()
}

function readOptionalAuditString(value: AuditValue | undefined) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readCustomFieldValues(value: AuditValue | undefined) {
  if (!isRecord(value)) return {}
  const result: Record<string, string | number | boolean | string[]> = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (isCanonicalCustomFieldValue(candidate)) {
      result[key] = structuredClone(candidate)
    }
  }
  return result
}

function isCanonicalCustomFieldValue(
  value: unknown,
): value is string | number | boolean | string[] {
  return typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

function isCustomFieldFilterValue(
  value: unknown,
): value is string | number | boolean | string[] {
  return isCanonicalCustomFieldValue(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workItemKey(teamId: string, workItemId: string) {
  return `${teamId}\u0000${workItemId}`
}

/**
 * Work Item scope と current Project allowlist を固定する permission hash を返します。
 *
 * @param workItems - Current ACL reader が返した canonical Work Item です。
 * @param asOf - Scope に含める Work Item の作成時刻上限です。
 * @param authorizedProjectIds - Current viewer が参照できる Project ID です。
 * @returns Snapshot/evidence cursor の認可 scope hash です。
 */
export function createAnalyticsPermissionScopeHash(
  workItems: readonly CanonicalWorkItem[],
  asOf: number,
  authorizedProjectIds: ReadonlySet<string>,
) {
  if (!Number.isFinite(asOf)) {
    throw invalid('AnalyticsPermissionScopeInvalid', 'Analytics permission scope as-of time is invalid.')
  }
  const normalizedProjectIds = [...normalizeAuthorizedProjectIds(authorizedProjectIds)].sort()
  return hashCanonical(
    {
      authorizedProjectIds: normalizedProjectIds,
      workItemKeys: [...new Set(
        workItems
          .filter((item) => {
            const createdAt = Date.parse(item.createdAt)
            return Number.isFinite(createdAt) && createdAt <= asOf
          })
          .map((item) => workItemKey(item.teamId, item.id)),
      )].sort(),
    },
  )
}

function normalizeAuthorizedProjectIds(authorizedProjectIds: ReadonlySet<string>) {
  if (
    authorizedProjectIds === undefined ||
    authorizedProjectIds === null ||
    typeof authorizedProjectIds[Symbol.iterator] !== 'function'
  ) {
    throw invalid(
      'AnalyticsPermissionScopeInvalid',
      'Analytics authorized Project IDs must be a set.',
    )
  }
  return new Set(
    [...authorizedProjectIds].map((projectId) =>
      readIdentifier(projectId, 'Analytics authorized Project ID')
    ),
  )
}

function reportMapKey(workspaceId: string, reportId: string) {
  return `${readIdentifier(workspaceId, 'Workspace ID')}\u0000${readIdentifier(
    reportId,
    'Analytics report ID',
  )}`
}

function snapshotMapKey(workspaceId: string, snapshotId: string) {
  return `${readIdentifier(workspaceId, 'Workspace ID')}\u0000${readIdentifier(
    snapshotId,
    'Analytics snapshot ID',
  )}`
}

function deliveryMapKey(workspaceId: string, reportId: string, occurrenceKey: string) {
  return `${readIdentifier(workspaceId, 'Workspace ID')}\u0000${createAnalyticsDeliveryRecordKey(
    reportId,
    occurrenceKey,
  )}`
}

function compareAuditEvents(left: AuditEventV1, right: AuditEventV1) {
  return left.occurredAt.localeCompare(right.occurredAt) ||
    left.eventId.localeCompare(right.eventId)
}

function compareReports(left: AnalyticsReport, right: AnalyticsReport) {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
}

function compareSnapshots(left: AnalyticsSnapshotRecord, right: AnalyticsSnapshotRecord) {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
}

function snapshotsEquivalent(
  left: AnalyticsSnapshotRecord,
  right: AnalyticsSnapshotRecord,
) {
  const { createdAt: _leftCreatedAt, ...leftPayload } = left
  const { createdAt: _rightCreatedAt, ...rightPayload } = right
  return canonicalJson(leftPayload) === canonicalJson(rightPayload)
}

function deliveryReceiptsEquivalent(
  left: AnalyticsDeliveryReceipt,
  right: AnalyticsDeliveryReceipt,
) {
  const { createdAt: _leftCreatedAt, ...leftPayload } = left
  const { createdAt: _rightCreatedAt, ...rightPayload } = right
  return canonicalJson(leftPayload) === canonicalJson(rightPayload)
}

function nonNegativeHours(milliseconds: number) {
  return roundMetric(Math.max(0, milliseconds) / MILLISECONDS_PER_HOUR)
}

function roundMetric(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.round((value + Number.EPSILON) * 1_000) / 1_000
}

function invalid(code: string, message: string) {
  return new AnalyticsError(400, code, message)
}

function conflict(code: string, message: string) {
  return new AnalyticsError(409, code, message)
}

function revisionConflict() {
  return conflict(
    'AnalyticsRevisionConflict',
    'Analytics report changed. Reload and try again.',
  )
}

function snapshotConflict() {
  return conflict(
    'AnalyticsSnapshotConflict',
    'Analytics snapshot ID already belongs to a different immutable payload.',
  )
}

function deliveryConflict() {
  return conflict(
    'AnalyticsDeliveryConflict',
    'Analytics delivery occurrence already belongs to a different immutable receipt.',
  )
}

function reportNotFound() {
  return new AnalyticsError(404, 'AnalyticsReportNotFound', 'Analytics report was not found.')
}

function persistenceInvalid(message: string) {
  return new AnalyticsError(500, 'AnalyticsPersistenceInvalid', message)
}

function persistenceError(error: unknown) {
  if (error instanceof AnalyticsError) return error
  return new AnalyticsError(
    500,
    'AnalyticsPersistenceUnavailable',
    'Analytics persistence is unavailable.',
  )
}

function isNamedError(error: unknown, name: string) {
  return isRecord(error) && error.name === name
}

function isConditionalTransactionCancellation(error: unknown) {
  if (!isRecord(error) || error.name !== 'TransactionCanceledException') return false
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons)) return false
  let hasConditionalFailure = false
  for (const reason of reasons) {
    if (!isRecord(reason)) return false
    if (reason.Code === 'ConditionalCheckFailed') {
      hasConditionalFailure = true
      continue
    }
    if (reason.Code !== 'None') return false
  }
  return hasConditionalFailure
}
