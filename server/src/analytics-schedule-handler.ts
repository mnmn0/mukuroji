import { createHash } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  type AnalyticsQueryInput,
  type AnalyticsReport,
  type AnalyticsSnapshotRecord,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import {
  type AuditEventPage,
  type AuditEventQuery,
  type AuditEventV1,
  DynamoDbAuditEventsClient,
  getConfiguredDynamoDbEndpoint,
} from './audit'
import {
  AnalyticsError,
  type AnalyticsDeliveryReceipt,
  type AnalyticsRepository,
  calculateAnalyticsNextRunAt,
  createAnalyticsCsv,
  createAnalyticsPdf,
  createAnalyticsSnapshot,
  DynamoDbAnalyticsRepository,
} from './analytics'
import {
  DynamoDbProjectDirectoryClient,
  DynamoDbTeamIssuesClient,
} from './index'
import {
  DynamoDbWorkspaceAccessClient,
  type WorkspaceMember,
} from './workspace-access'

const ANALYTICS_SCHEDULE_PAGE_SIZE = 100
const ANALYTICS_SCHEDULE_MAX_PAGES = 100
const ANALYTICS_WORK_ITEM_PARTITION_COUNT_LIMIT = 100
const ANALYTICS_WORK_ITEM_LIMIT = 10_000
const ANALYTICS_WORK_ITEM_PARTITION_LIMIT = 10_000
const ANALYTICS_AUDIT_PAGE_SIZE = 100
const ANALYTICS_AUDIT_MAX_PAGES = 100

/** EventBridge schedule event のうち Analytics worker が利用する最小表現です。 */
export type AnalyticsScheduleEvent = {
  /** EventBridge が渡す schedule timestamp です。 */
  time?: string
}

/** Analytics schedule renderer が必要とする active directory team です。 */
type AnalyticsDirectoryTeam = {
  /** Team ID です。 */
  id: string
  /** Team 配下の active project です。 */
  projects: Array<{
    /** Project ID です。 */
    id: string
  }>
}

/** Analytics schedule renderer が必要とする directory response です。 */
type AnalyticsDirectoryResponse = {
  /** Active team 一覧です。 */
  teams: AnalyticsDirectoryTeam[]
}

/** Recipient の active project role です。 */
type AnalyticsProjectAccess = {
  /** Active project ID です。 */
  projectId: string
  /** Recipient に現在割り当てられた role です。 */
  role?: 'manager' | 'member' | 'viewer'
}

/** Recipient ごとの current ACL snapshot を読む directory client です。 */
export type AnalyticsScheduleDirectoryClient = {
  /** Active team/project directory を consistent read で返します。 */
  getProjectDirectory(
    workspaceId: string,
    locale: 'ja',
    consistentRead: boolean,
  ): Promise<AnalyticsDirectoryResponse>
  /** Recipient の current project role 一覧を返します。 */
  getProjectAccessList(
    workspaceId: string,
    recipientMemberKey: string,
  ): Promise<AnalyticsProjectAccess[]>
}

/** Recipient ごとの canonical Work Item を読む client です。 */
export type AnalyticsScheduleWorkItemsClient = {
  /** Team partition の canonical Work Item 一覧を返します。 */
  getTeamIssues(
    workspaceId: string,
    teamId: string,
    options: {
      /** Filter 前の probe 上限です。 */
      limit: number
      /** Current ACL 判定に使う強整合 read です。 */
      consistentRead: boolean
      /** Archived Work Item を含めるかどうかです。 */
      includeArchived: boolean
    },
  ): Promise<{
    /** 読み込んだ Team ID です。 */
    teamId: string
    /** Canonical Work Item 一覧です。 */
    issues: CanonicalWorkItem[]
  }>
  /** Project partition の canonical Work Item 一覧を返します。 */
  getProjectIssues(
    workspaceId: string,
    projectId: string,
    options: {
      /** Filter 前の probe 上限です。 */
      limit: number
      /** Current ACL 判定に使う強整合 read です。 */
      consistentRead: boolean
      /** Archived Work Item を含めるかどうかです。 */
      includeArchived: boolean
    },
  ): Promise<{
    /** 読み込んだ Project ID です。 */
    projectId: string
    /** Canonical Work Item 一覧です。 */
    issues: CanonicalWorkItem[]
  }>
}

/** Recipient の current Workspace membership を読む client です。 */
export type AnalyticsScheduleWorkspaceAccessClient = {
  /** Recipient が active member の場合だけ membership を返します。 */
  getActiveMember(
    workspaceId: string,
    recipientMemberKey: string,
  ): Promise<WorkspaceMember | undefined>
}

/** Analytics 用 immutable audit history を読む client です。 */
export type AnalyticsScheduleAuditClient = {
  /** Workspace timeline を cursor 付きで返します。 */
  query(input: AuditEventQuery): Promise<AuditEventPage>
}

/** Current ACL を適用する production renderer の依存です。 */
export type AnalyticsScheduleRendererDependencies = {
  /** Team/project directory の current state です。 */
  directory: AnalyticsScheduleDirectoryClient
  /** Canonical Work Item の current state です。 */
  workItems: AnalyticsScheduleWorkItemsClient
  /** Workspace membership の current state です。 */
  workspaceAccess: AnalyticsScheduleWorkspaceAccessClient
  /** Immutable audit history です。 */
  auditEvents: AnalyticsScheduleAuditClient
}

/** 一つの recipient snapshot を描画する入力です。 */
export type AnalyticsScheduleRenderInput = {
  /** Current revision を再取得済みの report です。 */
  report: AnalyticsReport
  /** Current ACL で再検証する recipient member key です。 */
  recipientMemberKey: string
  /** Snapshot の `asOf` に固定する schedule occurrence です。 */
  scheduledFor: string
  /** Current canonical state を巻き戻す future events まで読む上限です。 */
  historyReadAt: string
}

/** ID 付与前の recipient 固有 immutable snapshot です。 */
export type AnalyticsScheduleRenderedSnapshot = Omit<AnalyticsSnapshotRecord, 'id'>

/** Current ACL で snapshot を作り、非認可 recipient では undefined を返します。 */
export type AnalyticsScheduleRenderer = (
  input: AnalyticsScheduleRenderInput,
) => Promise<AnalyticsScheduleRenderedSnapshot | undefined>

/** In-app delivery artifact を副作用なく描画する入力です。 */
export type AnalyticsScheduleArtifactInput = {
  /** Immutable snapshot record です。 */
  snapshotRecord: AnalyticsSnapshotRecord
  /** Deterministic delivery receipt です。 */
  receipt: AnalyticsDeliveryReceipt
}

/**
 * CSV/PDF を検証する純粋 artifact renderer です。
 *
 * @remarks External message 送信や user-visible mutation を行ってはいけません。In-app delivery
 * の commit は immutable snapshot と receipt の durable put だけです。
 */
export type AnalyticsScheduleArtifactRenderer = (
  input: AnalyticsScheduleArtifactInput,
) => Promise<void>

/** Analytics schedule runner の dependency contract です。 */
export type AnalyticsScheduleDependencies = {
  /** Reports、snapshots、delivery receipts の durable store です。 */
  repository: AnalyticsRepository
  /** Recipient の current ACL を適用する snapshot renderer です。 */
  render: AnalyticsScheduleRenderer
  /** Durable write 前に artifact を検証する注入可能な純粋 renderer です。 */
  renderArtifact: AnalyticsScheduleArtifactRenderer
}

/** 一つの due report を処理した結果です。 */
export type AnalyticsScheduledReportResult = {
  /** Due report を実際に処理したかどうかです。 */
  processed: boolean
  /** Current ACL で snapshot を保存した recipient 数です。 */
  snapshotsStored: number
  /** 新規に確定した delivery receipt 数です。 */
  receiptsCreated: number
  /** Active membership または report visibility を満たさず skip した recipient 数です。 */
  skippedRecipients: number
}

/** 一回の schedule invocation の結果です。 */
export type AnalyticsScheduleResult = {
  /** Due index から評価した report 数です。 */
  dueReports: number
  /** Current revision の due occurrence を完了した report 数です。 */
  processedReports: number
  /** Current ACL で snapshot を保存した recipient 数です。 */
  snapshotsStored: number
  /** 新規に確定した delivery receipt 数です。 */
  receiptsCreated: number
  /** Current authorization で skip した recipient 数です。 */
  skippedRecipients: number
}

const configuredDynamoDbEndpoint = getConfiguredDynamoDbEndpoint()
const dynamoDbClient = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(configuredDynamoDbEndpoint ? { endpoint: configuredDynamoDbEndpoint } : {}),
})
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})
const analyticsRepository = new DynamoDbAnalyticsRepository(
  process.env.ANALYTICS_TABLE_NAME ?? 'mukuroji-analytics',
  documentClient,
  {
    scheduleDueIndexName:
      process.env.ANALYTICS_SCHEDULE_INDEX_NAME ?? 'ScheduleDueIndex',
  },
)
const analyticsRenderer = createAnalyticsScheduleRenderer({
  directory: new DynamoDbProjectDirectoryClient(),
  workItems: new DynamoDbTeamIssuesClient(),
  workspaceAccess: new DynamoDbWorkspaceAccessClient(),
  auditEvents: new DynamoDbAuditEventsClient(
    documentClient,
    process.env.AUDIT_EVENTS_TABLE_NAME ?? 'mukuroji-audit-events',
    {},
    dynamoDbClient,
    Boolean(configuredDynamoDbEndpoint),
  ),
})

/** EventBridge timestamp を検証し、処理判定用の wall-clock 時刻を返します。 */
export function resolveAnalyticsScheduleProcessingTime(
  event: AnalyticsScheduleEvent,
  wallClock = new Date(),
) {
  if (event.time && Number.isNaN(Date.parse(event.time))) {
    throw new AnalyticsError(
      400,
      'AnalyticsScheduleTimeInvalid',
      'Analytics schedule time is invalid.',
    )
  }
  if (Number.isNaN(wallClock.getTime())) {
    throw new AnalyticsError(
      400,
      'AnalyticsScheduleTimeInvalid',
      'Analytics schedule processing time is invalid.',
    )
  }
  return wallClock
}

/** EventBridge から due Analytics reports を処理します。 */
export async function handler(event: AnalyticsScheduleEvent = {}) {
  const now = resolveAnalyticsScheduleProcessingTime(event)
  return await processAnalyticsSchedule(now, {
    repository: analyticsRepository,
    render: analyticsRenderer,
    renderArtifact: renderInAppAnalyticsArtifact,
  })
}

/** Due reports を page 上限まで走査し、個別失敗を集約して retry させます。 */
export async function processAnalyticsSchedule(
  now: Date,
  dependencies: AnalyticsScheduleDependencies,
): Promise<AnalyticsScheduleResult> {
  if (Number.isNaN(now.getTime())) {
    throw new AnalyticsError(
      400,
      'AnalyticsScheduleTimeInvalid',
      'Analytics schedule processing time is invalid.',
    )
  }

  const aggregate: AnalyticsScheduleResult = {
    dueReports: 0,
    processedReports: 0,
    snapshotsStored: 0,
    receiptsCreated: 0,
    skippedRecipients: 0,
  }
  const failures: unknown[] = []
  let cursor: string | undefined
  let pageCount = 0

  do {
    if (pageCount >= ANALYTICS_SCHEDULE_MAX_PAGES) {
      throw new AnalyticsError(
        413,
        'AnalyticsScheduleLimitExceeded',
        'Analytics schedule due reports exceed the safe processing limit.',
      )
    }
    const page = await dependencies.repository.listDueReports(
      now.toISOString(),
      ANALYTICS_SCHEDULE_PAGE_SIZE,
      cursor,
    )
    pageCount += 1
    aggregate.dueReports += page.reports.length
    const results = await Promise.allSettled(
      page.reports.map(async (report) =>
        await processDueAnalyticsReport(report, now, dependencies)
      ),
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(result.reason)
        continue
      }
      aggregate.processedReports += Number(result.value.processed)
      aggregate.snapshotsStored += result.value.snapshotsStored
      aggregate.receiptsCreated += result.value.receiptsCreated
      aggregate.skippedRecipients += result.value.skippedRecipients
    }
    cursor = page.nextCursor
  } while (cursor)

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} analytics schedule reports failed.`,
    )
  }
  return aggregate
}

/** 一つの current report occurrence を recipient ごとに配信し、CAS で次回へ進めます。 */
export async function processDueAnalyticsReport(
  indexedReport: AnalyticsReport,
  now: Date,
  dependencies: AnalyticsScheduleDependencies,
): Promise<AnalyticsScheduledReportResult> {
  const current = await dependencies.repository.getReport(
    indexedReport.workspaceId,
    indexedReport.id,
  )
  const schedule = current?.schedule
  if (
    !current ||
    schedule?.enabled !== true ||
    !schedule.nextRunAt ||
    schedule.nextRunAt > now.toISOString()
  ) {
    return emptyScheduledReportResult()
  }

  const scheduledFor = schedule.nextRunAt
  const result: AnalyticsScheduledReportResult = {
    processed: true,
    snapshotsStored: 0,
    receiptsCreated: 0,
    skippedRecipients: 0,
  }

  for (const recipientMemberKey of schedule.recipientMemberKeys) {
    const rendered = await dependencies.render({
      report: current,
      recipientMemberKey,
      scheduledFor,
      historyReadAt: now.toISOString(),
    })
    if (!rendered) {
      result.skippedRecipients += 1
      continue
    }

    const snapshotRecord: AnalyticsSnapshotRecord = {
      id: createScheduledAnalyticsSnapshotId(
        current,
        scheduledFor,
        rendered.snapshot.queryHash,
        rendered.snapshot.permissionScopeHash,
      ),
      ...rendered,
      createdByMemberKey: current.ownerMemberKey,
    }
    const receipt: AnalyticsDeliveryReceipt = {
      workspaceId: current.workspaceId,
      reportId: current.id,
      occurrenceKey: createAnalyticsScheduleOccurrenceKey(
        scheduledFor,
        recipientMemberKey,
      ),
      reportRevision: current.revision,
      format: schedule.format,
      snapshotId: snapshotRecord.id,
      recipientMemberKeys: [recipientMemberKey],
      createdAt: scheduledFor,
    }
    await dependencies.renderArtifact({ snapshotRecord, receipt })
    await dependencies.repository.putSnapshot(snapshotRecord)
    result.snapshotsStored += 1
    const receiptResult = await dependencies.repository.putDeliveryReceipt(receipt)
    if (receiptResult.created) {
      result.receiptsCreated += 1
    }
  }

  const nextRunAt = getNextAnalyticsScheduleOccurrence(current, scheduledFor)
  try {
    await dependencies.repository.updateReport(current.workspaceId, current.id, {
      expectedRevision: current.revision,
      schedule: {
        ...schedule,
        nextRunAt,
      },
    })
  } catch (error) {
    if (!(error instanceof AnalyticsError) || error.code !== 'AnalyticsRevisionConflict') {
      throw error
    }
    await advanceRacedAnalyticsScheduleOccurrence(
      current.workspaceId,
      current.id,
      scheduledFor,
      dependencies.repository,
    )
  }

  return result
}

/**
 * Delivery 後の無関係な report edit race では current revision を再取得して bounded CAS
 * し、schedule cursor 自体が変更済みならその mutation を尊重して no-op にします。
 */
async function advanceRacedAnalyticsScheduleOccurrence(
  workspaceId: string,
  reportId: string,
  scheduledFor: string,
  repository: AnalyticsRepository,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raced = await repository.getReport(workspaceId, reportId)
    if (
      !raced?.schedule?.enabled ||
      raced.schedule.nextRunAt === undefined ||
      raced.schedule.nextRunAt !== scheduledFor
    ) {
      return
    }
    try {
      await repository.updateReport(workspaceId, reportId, {
        expectedRevision: raced.revision,
        schedule: {
          ...raced.schedule,
          nextRunAt: getNextAnalyticsScheduleOccurrence(raced, scheduledFor),
        },
      })
      return
    } catch (error) {
      if (!(error instanceof AnalyticsError) || error.code !== 'AnalyticsRevisionConflict') {
        throw error
      }
    }
  }
  throw new AnalyticsError(
    409,
    'AnalyticsRevisionConflict',
    'Analytics report kept changing while its schedule occurrence was advanced.',
  )
}

/** Production の current ACL renderer を作成します。 */
export function createAnalyticsScheduleRenderer(
  dependencies: AnalyticsScheduleRendererDependencies,
): AnalyticsScheduleRenderer {
  return async ({ report, recipientMemberKey, scheduledFor, historyReadAt }) => {
    const member = await dependencies.workspaceAccess.getActiveMember(
      report.workspaceId,
      recipientMemberKey,
    )
    if (!member) return undefined

    const [directory, projectAccesses] = await Promise.all([
      dependencies.directory.getProjectDirectory(report.workspaceId, 'ja', true),
      dependencies.directory.getProjectAccessList(report.workspaceId, recipientMemberKey),
    ])
    const activeProjectIds = new Set(directory.teams.flatMap((team) =>
      team.projects.map((project) => project.id)
    ))
    const readableProjectIds = new Set(
      projectAccesses
        .filter((access) =>
          activeProjectIds.has(access.projectId) &&
          access.role !== undefined
        )
        .map((access) => access.projectId),
    )
    const readableTeamIds = new Set(
      directory.teams
        .filter((team) => team.projects.some((project) =>
          readableProjectIds.has(project.id)
        ))
        .map((team) => team.id),
    )
    if (!canRecipientReadAnalyticsReport(
      report,
      recipientMemberKey,
      readableTeamIds,
    )) {
      return undefined
    }

    const workItems = await readRecipientWorkItems(
      report,
      directory,
      readableProjectIds,
      dependencies.workItems,
    )
    const events = await readRecipientAuditEvents(
      report.workspaceId,
      historyReadAt,
      workItems,
      dependencies.auditEvents,
    )
    const query: AnalyticsQueryInput = {
      filter: structuredClone(report.filter),
      widgets: structuredClone(report.widgets),
      asOf: scheduledFor,
      timeZone: report.timeZone,
      ...(report.forecastBaseline === undefined
        ? {}
        : { forecastBaseline: structuredClone(report.forecastBaseline) }),
    }
    const snapshot = createAnalyticsSnapshot({
      workItems,
      events,
      query,
      authorizedProjectIds: readableProjectIds,
    })
    return {
      workspaceId: report.workspaceId,
      reportId: report.id,
      reportRevision: report.revision,
      createdByMemberKey: report.ownerMemberKey,
      createdAt: scheduledFor,
      query,
      snapshot,
    }
  }
}

/** Snapshot/receipt を in-app artifact として確定し、export renderer も検証します。 */
export async function renderInAppAnalyticsArtifact(
  input: AnalyticsScheduleArtifactInput,
) {
  if (input.receipt.format === 'csv') {
    createAnalyticsCsv(input.snapshotRecord.snapshot)
    return
  }
  createAnalyticsPdf(input.snapshotRecord.snapshot)
}

/** Report visibility と current Team access から recipient の read 可否を判定します。 */
export function canRecipientReadAnalyticsReport(
  report: AnalyticsReport,
  recipientMemberKey: string,
  readableTeamIds: ReadonlySet<string>,
) {
  if (report.visibility === 'personal') {
    return report.ownerMemberKey === recipientMemberKey
  }
  if (report.visibility === 'shared') {
    return true
  }
  return report.visibility === 'team' &&
    report.teamId !== undefined &&
    readableTeamIds.has(report.teamId)
}

/** Current project ACL を適用した canonical Work Item 集合を fail-closed で返します。 */
async function readRecipientWorkItems(
  report: AnalyticsReport,
  directory: AnalyticsDirectoryResponse,
  readableProjectIds: ReadonlySet<string>,
  client: AnalyticsScheduleWorkItemsClient,
) {
  const filteredTeamIds = report.filter.teamIds === undefined
    ? undefined
    : new Set(report.filter.teamIds)
  const filteredProjectIds = report.filter.projectIds === undefined
    ? undefined
    : new Set(report.filter.projectIds)
  const readOptions = {
    limit: ANALYTICS_WORK_ITEM_PARTITION_LIMIT + 1,
    consistentRead: true,
    includeArchived: true,
  }
  const workItems = new Map<string, CanonicalWorkItem>()
  const addWorkItem = (workItem: CanonicalWorkItem) => {
    workItems.set(`${workItem.teamId}\0${workItem.id}`, workItem)
    if (workItems.size > ANALYTICS_WORK_ITEM_LIMIT) {
      throw new AnalyticsError(
        413,
        'AnalyticsWorkItemLimitExceeded',
        'Analytics recipient has more Work Items than the safe processing limit.',
      )
    }
  }

  const teams = directory.teams.filter((team) => {
    if (filteredTeamIds !== undefined && !filteredTeamIds.has(team.id)) return false
    return team.projects.some((project) => {
      return readableProjectIds.has(project.id) &&
        (filteredProjectIds === undefined || filteredProjectIds.has(project.id))
    })
  })
  assertAnalyticsSchedulePartitionCount(teams.length)
  for (const team of teams) {
    const response = await client.getTeamIssues(
      report.workspaceId,
      team.id,
      readOptions,
    )
    assertAnalyticsSchedulePartitionSize(response.issues, `Team "${team.id}"`)
    for (const workItem of response.issues) {
      if (
        workItem.teamId === team.id &&
        (
          workItem.assignedProjectId === undefined ||
          readableProjectIds.has(workItem.assignedProjectId)
        )
      ) {
        addWorkItem(workItem)
      }
    }
  }
  return [...workItems.values()]
}

/** Schedule renderer が一度に読む partition 数を fail-closed 上限内に制限します。 */
function assertAnalyticsSchedulePartitionCount(count: number) {
  if (count > ANALYTICS_WORK_ITEM_PARTITION_COUNT_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsWorkItemLimitExceeded',
      'Analytics recipient spans more data partitions than the safe processing limit.',
    )
  }
}

/** Schedule renderer が一つの partition から部分結果を返さないよう probe を検証します。 */
function assertAnalyticsSchedulePartitionSize(
  workItems: readonly CanonicalWorkItem[],
  scope: string,
) {
  if (workItems.length > ANALYTICS_WORK_ITEM_PARTITION_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsWorkItemLimitExceeded',
      `${scope} exceeds the safe Analytics Work Item partition limit.`,
    )
  }
}

/** Current Work Item entity ID 集合に完全一致する immutable events だけを返します。 */
async function readRecipientAuditEvents(
  workspaceId: string,
  historyReadAt: string,
  workItems: readonly CanonicalWorkItem[],
  client: AnalyticsScheduleAuditClient,
) {
  const accessibleEntityIds = new Set(
    workItems.map((workItem) =>
      createAnalyticsWorkItemEntityId(workItem.teamId, workItem.id)
    ),
  )
  const events: AuditEventV1[] = []
  let cursor: string | undefined
  let pageCount = 0

  do {
    if (pageCount >= ANALYTICS_AUDIT_MAX_PAGES) {
      throw new AnalyticsError(
        413,
        'AnalyticsHistoryLimitExceeded',
        'Analytics history exceeds the safe schedule processing limit.',
      )
    }
    const page = await client.query({
      workspaceId,
      entityType: 'work-item',
      to: historyReadAt,
      limit: ANALYTICS_AUDIT_PAGE_SIZE,
      cursor,
      direction: 'ascending',
    })
    pageCount += 1
    events.push(...page.events.filter((event) =>
      event.entityType === 'work-item' &&
      accessibleEntityIds.has(event.entityId)
    ))
    cursor = page.nextCursor
  } while (cursor)

  return events
}

/** Schedule occurrence/report revision/query/scope に決定的な共有 snapshot ID を返します。 */
function createScheduledAnalyticsSnapshotId(
  report: AnalyticsReport,
  scheduledFor: string,
  queryHash: string,
  permissionScopeHash: string,
) {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      workspaceId: report.workspaceId,
      reportId: report.id,
      reportRevision: report.revision,
      scheduledFor,
      queryHash,
      permissionScopeHash,
    }))
    .digest('hex')
  return `scheduled_${digest.slice(0, 48)}`
}

/** Recipient ごとの deterministic occurrence receipt key を返します。 */
function createAnalyticsScheduleOccurrenceKey(
  scheduledFor: string,
  recipientMemberKey: string,
) {
  const recipientHash = createHash('sha256')
    .update(recipientMemberKey)
    .digest('hex')
    .slice(0, 24)
  return `${scheduledFor}#${recipientHash}`
}

/** Analytics schedule を recurring helper へ変換し、次の UTC occurrence を返します。 */
function getNextAnalyticsScheduleOccurrence(
  report: AnalyticsReport,
  scheduledFor: string,
) {
  const schedule = report.schedule
  if (!schedule) {
    throw new AnalyticsError(
      409,
      'AnalyticsScheduleInvalid',
      'Analytics report schedule is unavailable.',
    )
  }
  const completedLocalDate = analyticsLocalDateKey(scheduledFor, schedule.timeZone)
  let cursor = scheduledFor
  for (let candidateIndex = 0; candidateIndex < 3; candidateIndex += 1) {
    const candidate = calculateAnalyticsNextRunAt(schedule, cursor)
    if (analyticsLocalDateKey(candidate, schedule.timeZone) !== completedLocalDate) {
      return candidate
    }
    cursor = candidate
  }
  throw new AnalyticsError(
    500,
    'AnalyticsScheduleUnresolvable',
    'Analytics schedule repeated the same local delivery date.',
  )
}

/** UTC instant が属する schedule timezone の local date key を返します。 */
function analyticsLocalDateKey(timestamp: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const values = new Map(parts.map((part) => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
}

/** Audit event が利用する canonical Work Item entity ID を返します。 */
function createAnalyticsWorkItemEntityId(teamId: string, workItemId: string) {
  return `team/${teamId}/issue/${workItemId}`
}

/** Stale due-index row の no-op result です。 */
function emptyScheduledReportResult(): AnalyticsScheduledReportResult {
  return {
    processed: false,
    snapshotsStored: 0,
    receiptsCreated: 0,
    skippedRecipients: 0,
  }
}
