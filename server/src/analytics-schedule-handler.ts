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
  ANALYTICS_SCHEDULE_RECIPIENT_LIMIT,
  ANALYTICS_SCHEDULE_SHARD_COUNT,
  AnalyticsError,
  type AnalyticsDeliveryReceipt,
  type AnalyticsDueReportReference,
  type AnalyticsRepository,
  calculateAnalyticsNextRunAt,
  createAnalyticsCsv,
  createAnalyticsPdf,
  createAnalyticsSnapshot,
  DynamoDbAnalyticsRepository,
} from './analytics'
import {
  AwsCognitoClient,
  CognitoServiceError,
  DynamoDbProjectDirectoryClient,
  DynamoDbTeamIssuesClient,
} from './index'
import {
  DynamoDbWorkspaceAccessClient,
  type WorkspaceMember,
} from './workspace-access'

const ANALYTICS_SCHEDULE_PAGE_SIZE = 100
const ANALYTICS_SCHEDULE_MAX_PAGES = 100
const ANALYTICS_SCHEDULE_WORKER_COUNT = 4
const ANALYTICS_SCHEDULE_READ_BARRIER_MAX_ATTEMPTS = 3
const ANALYTICS_WORK_ITEM_PARTITION_COUNT_LIMIT = 100
const ANALYTICS_WORK_ITEM_LIMIT = 10_000
const ANALYTICS_WORK_ITEM_PARTITION_LIMIT = 10_000
const ANALYTICS_AUDIT_PAGE_SIZE = 100
const ANALYTICS_AUDIT_MAX_PAGES = 100
const ANALYTICS_AUDIT_PAGE_QUERY_LIMIT = 500
const ANALYTICS_AUDIT_EVENT_LIMIT =
  ANALYTICS_AUDIT_PAGE_SIZE * ANALYTICS_AUDIT_MAX_PAGES
const ANALYTICS_AUDIT_QUERY_CONCURRENCY = 4
const ANALYTICS_AUDIT_IDENTITY_QUERY_LIMIT = 500

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

/** Recipient の current Cognito system administrator membership を読む client です。 */
export type AnalyticsScheduleSystemAdminClient = {
  /** 現在いずれかの system administrator group に所属するかを返します。 */
  isSystemAdmin(userId: string): Promise<boolean>
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
  /** Cognito system administrator group の current state です。 */
  systemAdmin: AnalyticsScheduleSystemAdminClient
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
const cognito = new AwsCognitoClient()
const analyticsRenderer = createAnalyticsScheduleRenderer({
  directory: new DynamoDbProjectDirectoryClient(),
  workItems: new DynamoDbTeamIssuesClient(),
  workspaceAccess: new DynamoDbWorkspaceAccessClient(),
  systemAdmin: {
    async isSystemAdmin(userId) {
      try {
        return await cognito.isSystemAdmin(userId)
      } catch (error) {
        if (
          error instanceof CognitoServiceError &&
          error.code === 'UserNotFoundException'
        ) {
          return false
        }
        throw error
      }
    },
  },
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
  let pageCount = 0
  const shardStates = Array.from(
    { length: ANALYTICS_SCHEDULE_SHARD_COUNT },
    (_, shardIndex) => ({
      scheduleShard: `schedule-${String(shardIndex).padStart(2, '0')}`,
      active: true,
      cursor: undefined as string | undefined,
    }),
  )

  while (shardStates.some((state) => state.active)) {
    const activeStates = shardStates.filter((state) => state.active)
    const pages = await Promise.all(activeStates.map(async (state) => ({
      state,
      page: await dependencies.repository.listDueReports(
        state.scheduleShard,
        now.toISOString(),
        ANALYTICS_SCHEDULE_PAGE_SIZE,
        state.cursor,
      ),
    })))
    const traversedPageCount = pages.filter(({ page }) =>
      page.reports.length > 0 || page.nextCursor !== undefined
    ).length
    if (pageCount + traversedPageCount > ANALYTICS_SCHEDULE_MAX_PAGES) {
      throw new AnalyticsError(
        413,
        'AnalyticsScheduleLimitExceeded',
        'Analytics schedule due reports exceed the safe processing limit.',
      )
    }
    pageCount += traversedPageCount
    const reports = pages.flatMap(({ page }) => page.reports)
    aggregate.dueReports += reports.length
    const results = await processAnalyticsScheduleReportBatch(
      reports,
      now,
      dependencies,
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
    for (const { state, page } of pages) {
      state.cursor = page.nextCursor
      state.active = page.nextCursor !== undefined
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} analytics schedule reports failed.`,
    )
  }
  return aggregate
}

/** Due report page を固定数 worker で処理し、各 report の成否をすべて保持します。 */
async function processAnalyticsScheduleReportBatch(
  reports: readonly AnalyticsDueReportReference[],
  now: Date,
  dependencies: AnalyticsScheduleDependencies,
): Promise<PromiseSettledResult<AnalyticsScheduledReportResult>[]> {
  const results: PromiseSettledResult<AnalyticsScheduledReportResult>[] = []
  let nextReportIndex = 0
  const processNextReport = async () => {
    while (nextReportIndex < reports.length) {
      const reportIndex = nextReportIndex
      nextReportIndex += 1
      const report = reports[reportIndex]
      if (!report) continue

      try {
        results[reportIndex] = {
          status: 'fulfilled',
          value: await processDueAnalyticsReport(report, now, dependencies),
        }
      } catch (reason) {
        results[reportIndex] = { status: 'rejected', reason }
      }
    }
  }
  const workerCount = Math.min(ANALYTICS_SCHEDULE_WORKER_COUNT, reports.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => await processNextReport()),
  )
  return results
}

/** 一つの current report occurrence を recipient ごとに配信し、CAS で次回へ進めます。 */
export async function processDueAnalyticsReport(
  indexedReport: AnalyticsDueReportReference,
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
  if (schedule.recipientMemberKeys.length > ANALYTICS_SCHEDULE_RECIPIENT_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsScheduleRecipientLimitExceeded',
      'Analytics schedule recipients exceed the safe processing limit.',
    )
  }
  const result: AnalyticsScheduledReportResult = {
    processed: true,
    snapshotsStored: 0,
    receiptsCreated: 0,
    skippedRecipients: 0,
  }

  for (const recipientMemberKey of schedule.recipientMemberKeys) {
    const occurrenceKey = createAnalyticsScheduleOccurrenceKey(
      current,
      scheduledFor,
      recipientMemberKey,
    )
    if (
      await hasCompletedAnalyticsScheduleDelivery(
        current,
        scheduledFor,
        recipientMemberKey,
        occurrenceKey,
        dependencies.repository,
      )
    ) {
      continue
    }
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
      occurrenceKey,
      reportRevision: current.revision,
      format: schedule.format,
      snapshotId: snapshotRecord.id,
      recipientMemberKeys: [recipientMemberKey],
      createdAt: scheduledFor,
    }
    await dependencies.renderArtifact({ snapshotRecord, receipt })
    await dependencies.repository.putSnapshot(snapshotRecord)
    result.snapshotsStored += 1
    try {
      const receiptResult = await dependencies.repository.putDeliveryReceipt(receipt)
      if (receiptResult.created) {
        result.receiptsCreated += 1
      }
    } catch (error) {
      if (
        error instanceof AnalyticsError &&
        error.code === 'AnalyticsDeliveryConflict' &&
        await hasCompletedAnalyticsScheduleDelivery(
          current,
          scheduledFor,
          recipientMemberKey,
          occurrenceKey,
          dependencies.repository,
        )
      ) {
        continue
      }
      throw error
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
      current,
      scheduledFor,
      dependencies.repository,
    )
  }

  return result
}

/**
 * Delivery 後の無関係な report edit race だけを current revision で bounded CAS します。
 *
 * @remarks Semantic configuration または schedule cursor が変更済みなら、新 definition
 * を次の invocation が同じ occurrence で処理できるよう no-op にします。
 */
async function advanceRacedAnalyticsScheduleOccurrence(
  deliveredReport: AnalyticsReport,
  scheduledFor: string,
  repository: AnalyticsRepository,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raced = await repository.getReport(
      deliveredReport.workspaceId,
      deliveredReport.id,
    )
    if (
      !raced?.schedule?.enabled ||
      raced.schedule.nextRunAt === undefined ||
      raced.schedule.nextRunAt !== scheduledFor
    ) {
      return
    }
    if (
      createAnalyticsDeliveryDefinitionHash(raced) !==
        createAnalyticsDeliveryDefinitionHash(deliveredReport)
    ) {
      return
    }
    try {
      await repository.updateReport(
        deliveredReport.workspaceId,
        deliveredReport.id,
        {
          expectedRevision: raced.revision,
          schedule: {
            ...raced.schedule,
            nextRunAt: getNextAnalyticsScheduleOccurrence(raced, scheduledFor),
          },
        },
      )
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
    const initialAuthorization = await readAnalyticsScheduleAuthorization(
      report,
      recipientMemberKey,
      dependencies,
    )
    if (!initialAuthorization) return undefined

    const authorized = await readRecipientAuthorizedData(
      report,
      initialAuthorization.directory,
      initialAuthorization.readableProjectIds,
      dependencies.workItems,
      historyReadAt,
      dependencies.auditEvents,
    )
    const currentAuthorization = await readAnalyticsScheduleAuthorization(
      report,
      recipientMemberKey,
      dependencies,
    )
    if (!currentAuthorization) return undefined
    if (
      currentAuthorization.fingerprint !==
        initialAuthorization.fingerprint
    ) {
      throw createAnalyticsScheduleReadBarrierError(
        'Analytics recipient authorization changed while history was read.',
      )
    }
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
      ...authorized,
      query,
      authorizedProjectIds: currentAuthorization.readableProjectIds,
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

/** Recipient のcurrent membership、directory、Project ACL、system-admin scopeを返します。 */
async function readAnalyticsScheduleAuthorization(
  report: AnalyticsReport,
  recipientMemberKey: string,
  dependencies: AnalyticsScheduleRendererDependencies,
) {
  const member = await dependencies.workspaceAccess.getActiveMember(
    report.workspaceId,
    recipientMemberKey,
  )
  if (!member) return undefined

  const [directory, isSystemAdmin] = await Promise.all([
    dependencies.directory.getProjectDirectory(report.workspaceId, 'ja', true),
    dependencies.systemAdmin.isSystemAdmin(member.email),
  ])
  const activeProjectIds = new Set(directory.teams.flatMap((team) =>
    team.projects.map((project) => project.id)
  ))
  const projectAccesses = isSystemAdmin
    ? []
    : await dependencies.directory.getProjectAccessList(
        report.workspaceId,
        recipientMemberKey,
      )
  const readableProjectIds = isSystemAdmin
    ? activeProjectIds
    : new Set(
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

  const normalizedDirectory = directory.teams
    .map((team) => ({
      id: team.id,
      projectIds: team.projects.map((project) => project.id).sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const fingerprint = createHash('sha256')
    .update(stableAnalyticsScheduleStringify({
      isSystemAdmin,
      memberKey: member.memberKey,
      directory: normalizedDirectory,
      readableProjectIds: [...readableProjectIds].sort(),
      readableTeamIds: [...readableTeamIds].sort(),
    }))
    .digest('hex')
  return {
    directory,
    readableProjectIds,
    fingerprint,
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

/**
 * Canonical Work Item と cutoff 以下の audit events を read barrier で揃えて返します。
 *
 * @remarks
 * Strong read の前後で canonical state が変わった場合は同じ cutoff でもう一度読み直します。
 * Cutoff より新しい state は対応 event を安全に読めないため、invocation 全体を再試行させます。
 */
async function readRecipientAuthorizedData(
  report: AnalyticsReport,
  directory: AnalyticsDirectoryResponse,
  readableProjectIds: ReadonlySet<string>,
  workItemsClient: AnalyticsScheduleWorkItemsClient,
  historyReadAt: string,
  auditClient: AnalyticsScheduleAuditClient,
) {
  let workItems = await readRecipientWorkItems(
    report,
    directory,
    readableProjectIds,
    workItemsClient,
  )
  assertAnalyticsScheduleWorkItemsAtCutoff(workItems, historyReadAt)

  for (
    let attempt = 0;
    attempt < ANALYTICS_SCHEDULE_READ_BARRIER_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const events = await readRecipientAuditEvents(
      report.workspaceId,
      historyReadAt,
      workItems,
      auditClient,
    )
    const verifiedWorkItems = await readRecipientWorkItems(
      report,
      directory,
      readableProjectIds,
      workItemsClient,
    )
    assertAnalyticsScheduleWorkItemsAtCutoff(verifiedWorkItems, historyReadAt)

    if (
      createAnalyticsScheduleWorkItemsFingerprint(workItems) ===
        createAnalyticsScheduleWorkItemsFingerprint(verifiedWorkItems)
    ) {
      assertAnalyticsScheduleAuditCoverage(
        verifiedWorkItems,
        events,
      )
      return { workItems: verifiedWorkItems, events }
    }
    workItems = verifiedWorkItems
  }

  throw createAnalyticsScheduleReadBarrierError(
    'Canonical Work Items kept changing while Analytics history was read.',
  )
}

/** Canonical state が audit cutoff 以下であることを fail-closed に検証します。 */
function assertAnalyticsScheduleWorkItemsAtCutoff(
  workItems: readonly CanonicalWorkItem[],
  historyReadAt: string,
) {
  const cutoff = Date.parse(historyReadAt)
  if (
    Number.isNaN(cutoff) ||
    workItems.some((workItem) => {
      const updatedAt = Date.parse(workItem.updatedAt)
      return Number.isNaN(updatedAt) || updatedAt > cutoff
    })
  ) {
    throw createAnalyticsScheduleReadBarrierError(
      'Canonical Work Items are newer than the Analytics history cutoff.',
    )
  }
}

/**
 * 更新済みcanonical stateのlatest audit eventがentity GSIに到達済みか検証します。
 */
function assertAnalyticsScheduleAuditCoverage(
  workItems: readonly CanonicalWorkItem[],
  events: readonly AuditEventV1[],
) {
  for (const workItem of workItems) {
    if (workItem.revision <= 1) continue
    const updatedAt = Date.parse(workItem.updatedAt)
    const canonicalEntityId = createAnalyticsWorkItemEntityId(
      workItem.teamId,
      workItem.id,
    )
    const authorizedRawIdByCanonicalEntityId = new Map([
      [canonicalEntityId, workItem.id],
    ])
    const covered = events.some((event) =>
      Date.parse(event.occurredAt) === updatedAt &&
      isAnalyticsScheduleLatestWorkItemUpdate(
        event,
        workItem,
        canonicalEntityId,
      ) &&
      (
        isCanonicalAnalyticsScheduleEvent(event, canonicalEntityId) ||
        isAuthorizedLegacyAnalyticsScheduleEvent(
          event,
          workItem.id,
          authorizedRawIdByCanonicalEntityId,
        )
      )
    )
    if (!covered) {
      throw createAnalyticsScheduleReadBarrierError(
        'Analytics audit history has not reached the latest canonical Work Item state.',
      )
    }
  }
}

/** Event が latest canonical Work Item revision を生成したupdateかを検証します。 */
function isAnalyticsScheduleLatestWorkItemUpdate(
  event: AuditEventV1,
  workItem: CanonicalWorkItem,
  canonicalEntityId: string,
) {
  if (
    event.eventType !== 'work-item.updated' ||
    event.action !== 'updated' ||
    event.targetType !== 'work-item' ||
    event.target.type !== 'work-item' ||
    event.targetId !== event.target.id ||
    (
      event.targetId !== canonicalEntityId &&
      event.targetId !== workItem.id
    )
  ) {
    return false
  }

  const metadataTeamId = readAnalyticsScheduleMetadataText(
    event.metadata?.teamId,
  )
  const metadataIssueId = readAnalyticsScheduleMetadataText(
    event.metadata?.issueId,
  )
  const metadataWorkItemId = readAnalyticsScheduleMetadataText(
    event.metadata?.workItemId,
  )
  return event.metadata?.adapter === 'canonical-work-item' &&
    event.metadata.afterRevision === workItem.revision &&
    metadataTeamId === workItem.teamId &&
    (metadataIssueId ?? metadataWorkItemId) === workItem.id &&
    (
      metadataIssueId === undefined ||
      metadataWorkItemId === undefined ||
      metadataIssueId === metadataWorkItemId
    )
}

/** Canonical Work Item 集合の順序非依存 fingerprint を返します。 */
function createAnalyticsScheduleWorkItemsFingerprint(
  workItems: readonly CanonicalWorkItem[],
) {
  const digest = createHash('sha256')
  const ordered = [...workItems].sort((left, right) => {
    const leftKey = `${left.teamId}\0${left.id}`
    const rightKey = `${right.teamId}\0${right.id}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  for (const workItem of ordered) {
    digest.update(stableAnalyticsScheduleStringify(workItem))
    digest.update('\0')
  }
  return digest.digest('hex')
}

/** Object key の列挙順に依存しない canonical JSON 文字列を返します。 */
function stableAnalyticsScheduleStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableAnalyticsScheduleStringify).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${stableAnalyticsScheduleStringify(entry)}`
    )
  return `{${entries.join(',')}}`
}

/** Lambda の次回 invocation で安全な cutoff を取り直す retryable error を返します。 */
function createAnalyticsScheduleReadBarrierError(message: string) {
  return new AnalyticsError(
    503,
    'AnalyticsScheduleReadBarrierUnavailable',
    message,
  )
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

/**
 * Current Work Item identity ごとの entity timeline から immutable events を返します。
 *
 * @remarks
 * Legacy raw ID timeline は metadata または canonical target が current authorized Work Item
 * に一致する場合だけ採用し、Team を跨ぐ同名 ID の event を fail-closed に除外します。
 */
async function readRecipientAuditEvents(
  workspaceId: string,
  historyReadAt: string,
  workItems: readonly CanonicalWorkItem[],
  client: AnalyticsScheduleAuditClient,
) {
  const authorizedRawIdByCanonicalEntityId = new Map(workItems.map((workItem) => [
    createAnalyticsWorkItemEntityId(workItem.teamId, workItem.id),
    workItem.id,
  ]))
  const authorizedCanonicalEntityIds = new Set(
    authorizedRawIdByCanonicalEntityId.keys(),
  )
  const identities = [
    ...[...authorizedCanonicalEntityIds].sort().map((entityId) => ({
      entityId,
      legacyRawId: false,
    })),
    ...[...new Set(workItems.map((workItem) => workItem.id))]
      .sort()
      .map((entityId) => ({ entityId, legacyRawId: true })),
  ]
  if (identities.length > ANALYTICS_AUDIT_IDENTITY_QUERY_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsHistoryLimitExceeded',
      `Analytics history requires more than ${ANALYTICS_AUDIT_IDENTITY_QUERY_LIMIT} entity timeline queries. Narrow the report scope.`,
    )
  }
  const events: AuditEventV1[] = []
  let nextIdentityIndex = 0
  let pageQueryCount = 0
  let readEventCount = 0
  let failure: unknown
  const workerCount = Math.min(
    ANALYTICS_AUDIT_QUERY_CONCURRENCY,
    identities.length,
  )
  const readNextIdentity = async () => {
    while (failure === undefined) {
      const identityIndex = nextIdentityIndex
      nextIdentityIndex += 1
      const identity = identities[identityIndex]
      if (!identity) return

      try {
        let cursor: string | undefined
        let pageCount = 0
        do {
          if (
            pageCount >= ANALYTICS_AUDIT_MAX_PAGES ||
            pageQueryCount >= ANALYTICS_AUDIT_PAGE_QUERY_LIMIT
          ) {
            throw createAnalyticsScheduleHistoryLimitError()
          }
          pageQueryCount += 1
          const page = await client.query({
            workspaceId,
            entityType: 'work-item',
            entityId: identity.entityId,
            to: historyReadAt,
            limit: ANALYTICS_AUDIT_PAGE_SIZE,
            cursor,
            direction: 'ascending',
          })
          pageCount += 1
          readEventCount += page.events.length
          if (readEventCount > ANALYTICS_AUDIT_EVENT_LIMIT) {
            throw createAnalyticsScheduleHistoryLimitError()
          }
          for (const event of page.events) {
            const authorized = identity.legacyRawId
              ? isAuthorizedLegacyAnalyticsScheduleEvent(
                  event,
                  identity.entityId,
                  authorizedRawIdByCanonicalEntityId,
                )
              : isCanonicalAnalyticsScheduleEvent(event, identity.entityId)
            if (!authorized) continue

            events.push(event)
            if (events.length > ANALYTICS_AUDIT_EVENT_LIMIT) {
              throw createAnalyticsScheduleHistoryLimitError()
            }
          }
          cursor = page.nextCursor
        } while (cursor)
      } catch (error) {
        failure ??= error
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, readNextIdentity))
  if (failure !== undefined) throw failure
  return events
}

/** Canonical entity timeline のeventがquery identityと一致するかを検証します。 */
function isCanonicalAnalyticsScheduleEvent(
  event: AuditEventV1,
  canonicalEntityId: string,
) {
  return event.entityType === 'work-item' &&
    event.entity.type === 'work-item' &&
    event.entityId === canonicalEntityId &&
    event.entity.id === canonicalEntityId
}

/** Legacy raw-ID event が current authorized Work Item へ安全に解決できるかを判定します。 */
function isAuthorizedLegacyAnalyticsScheduleEvent(
  event: AuditEventV1,
  rawWorkItemId: string,
  authorizedRawIdByCanonicalEntityId: ReadonlyMap<string, string>,
) {
  if (
    event.entityType !== 'work-item' ||
    event.entity.type !== 'work-item'
  ) {
    return false
  }
  if (
    event.entityId !== rawWorkItemId ||
    event.entity.id !== rawWorkItemId
  ) {
    return false
  }
  if (
    event.targetType !== 'work-item' ||
    event.target.type !== 'work-item' ||
    event.targetId !== event.target.id
  ) {
    return false
  }

  const metadataTeamValue = event.metadata?.teamId
  const metadataIssueValue = event.metadata?.issueId
  const metadataWorkItemValue = event.metadata?.workItemId
  const metadataTeamId = readAnalyticsScheduleMetadataText(metadataTeamValue)
  const metadataIssueId = readAnalyticsScheduleMetadataText(metadataIssueValue)
  const metadataWorkItemId = readAnalyticsScheduleMetadataText(
    metadataWorkItemValue,
  )
  if (
    (metadataTeamValue !== undefined && metadataTeamId === undefined) ||
    (metadataIssueValue !== undefined && metadataIssueId === undefined) ||
    (
      metadataWorkItemValue !== undefined &&
      metadataWorkItemId === undefined
    )
  ) {
    return false
  }
  if (
    metadataIssueId !== undefined &&
    metadataWorkItemId !== undefined &&
    metadataIssueId !== metadataWorkItemId
  ) {
    return false
  }
  const metadataRawId = metadataIssueId ?? metadataWorkItemId
  if (metadataRawId !== undefined && metadataRawId !== rawWorkItemId) {
    return false
  }

  const resolvedCanonicalEntityIds = new Set<string>()
  if (metadataTeamId !== undefined) {
    const canonicalEntityId = createAnalyticsWorkItemEntityId(
      metadataTeamId,
      metadataRawId ?? rawWorkItemId,
    )
    if (
      authorizedRawIdByCanonicalEntityId.get(canonicalEntityId) !==
        rawWorkItemId
    ) {
      return false
    }
    resolvedCanonicalEntityIds.add(canonicalEntityId)
  }

  if (event.targetId !== rawWorkItemId) {
    if (
      authorizedRawIdByCanonicalEntityId.get(event.targetId) !==
        rawWorkItemId
    ) {
      return false
    }
    resolvedCanonicalEntityIds.add(event.targetId)
  }
  return resolvedCanonicalEntityIds.size === 1
}

/** Analytics audit metadata の non-empty string だけを返します。 */
function readAnalyticsScheduleMetadataText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Relevant entity history が安全上限を超えた場合の fail-closed error を返します。 */
function createAnalyticsScheduleHistoryLimitError() {
  return new AnalyticsError(
    413,
    'AnalyticsHistoryLimitExceeded',
    'Analytics history for the authorized Work Items exceeds the safe schedule processing limit.',
  )
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

/** Report revision に依存しない delivery semantic configuration hash を返します。 */
function createAnalyticsDeliveryDefinitionHash(report: AnalyticsReport) {
  const schedule = report.schedule
  return createHash('sha256')
    .update(stableAnalyticsScheduleStringify({
      schemaVersion: report.schemaVersion,
      workspaceId: report.workspaceId,
      reportId: report.id,
      ownerMemberKey: report.ownerMemberKey,
      visibility: report.visibility,
      teamId: report.teamId,
      timeZone: report.timeZone,
      filter: report.filter,
      forecastBaseline: report.forecastBaseline,
      widgets: report.widgets,
      schedule: schedule === undefined
        ? undefined
        : {
            enabled: schedule.enabled,
            frequency: schedule.frequency,
            timeZone: schedule.timeZone,
            localTime: schedule.localTime,
            dayOfWeek: schedule.dayOfWeek,
            dayOfMonth: schedule.dayOfMonth,
            recipientMemberKeys: schedule.recipientMemberKeys,
            format: schedule.format,
          },
    }))
    .digest('hex')
}

/** Recipient ごとの deterministic occurrence receipt key を返します。 */
function createAnalyticsScheduleOccurrenceKey(
  report: AnalyticsReport,
  scheduledFor: string,
  recipientMemberKey: string,
) {
  const definitionHash = createAnalyticsDeliveryDefinitionHash(report).slice(0, 32)
  const recipientHash = createHash('sha256')
    .update(recipientMemberKey)
    .digest('hex')
    .slice(0, 24)
  return `${scheduledFor}#${definitionHash}#${recipientHash}`
}

/** Durable receipt と snapshot が recipient の完了 checkpoint を構成するか検証します。 */
async function hasCompletedAnalyticsScheduleDelivery(
  report: AnalyticsReport,
  scheduledFor: string,
  recipientMemberKey: string,
  occurrenceKey: string,
  repository: AnalyticsRepository,
) {
  const receipt = await repository.getDeliveryReceipt(
    report.workspaceId,
    report.id,
    occurrenceKey,
  )
  if (receipt === undefined) return false
  if (
    receipt.workspaceId !== report.workspaceId ||
    receipt.reportId !== report.id ||
    receipt.occurrenceKey !== occurrenceKey ||
    receipt.createdAt !== scheduledFor ||
    receipt.recipientMemberKeys.length !== 1 ||
    receipt.recipientMemberKeys[0] !== recipientMemberKey
  ) {
    throw analyticsDeliveryCheckpointConflict()
  }
  const snapshot = await repository.getSnapshot(
    receipt.workspaceId,
    receipt.snapshotId,
  )
  if (
    snapshot === undefined ||
    snapshot.workspaceId !== receipt.workspaceId ||
    snapshot.reportId !== receipt.reportId ||
    snapshot.id !== receipt.snapshotId ||
    snapshot.reportRevision !== receipt.reportRevision ||
    snapshot.createdAt !== scheduledFor ||
    snapshot.query.asOf !== scheduledFor
  ) {
    throw analyticsDeliveryCheckpointConflict()
  }
  return true
}

/** 不整合な durable delivery checkpoint を fail-closed で拒否します。 */
function analyticsDeliveryCheckpointConflict() {
  return new AnalyticsError(
    409,
    'AnalyticsDeliveryConflict',
    'Analytics delivery checkpoint does not match its immutable occurrence.',
  )
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
