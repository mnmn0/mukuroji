import { createHash } from 'node:crypto'
import {
  type AnalyticsQueryInput,
  type AnalyticsReport,
  type AnalyticsSnapshot,
  type AnalyticsSnapshotListResponse,
  type AnalyticsSnapshotRecord,
  type CreateAnalyticsReportInput,
  type CanonicalWorkItem,
  type UpdateAnalyticsReportInput,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import {
  createAnalyticsRouter,
  type AnalyticsExportFile,
} from '../../modules/analytics/adapter-in/http/analytics-router'
import { createDashboardRouter } from '../../modules/analytics/adapter-in/http/dashboard-router'
import type { DashboardSummaryResponse } from '../../modules/analytics'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError, type ProjectAccessEntry } from '../../modules/directory'
import { type AuditEventV1 } from '../../modules/audit/audit'
import {
  createTeamIssueAuditEntityId,
  isTeamIssueNotFoundError,
  type TeamIssueResponseItem,
  type WorkItemListReadOptions,
} from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  AnalyticsError,
  createAnalyticsCsv,
  createAnalyticsPermissionScopeHash,
  createAnalyticsPdf,
  createAnalyticsSnapshot,
  createAnalyticsSnapshotListCursor,
  normalizeAnalyticsEvidenceInput,
  normalizeAnalyticsExportLocale,
  normalizeAnalyticsQueryInput,
  queryAnalyticsEvidence,
} from '../../modules/analytics/analytics'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import { readBearerAccessToken, readJson, toAuthErrorResponse } from '../shared/http'
import {
  getEffectiveProjectAccessList,
  hasEnterpriseWorkspacePermission,
  type ProjectPrincipal,
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { createWorkspaceSearchContext, type WorkspaceSearchContext } from '../shared/search-access'
import { isRecord } from '../shared/value-guards'
import { projectAccessAllows, toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

/** Analytics が一つの entity query で読む audit event page size です。 */
const ANALYTICS_AUDIT_PAGE_SIZE = 100

/** Analytics が一つの canonical Work Item entity で読む最大 audit page 数です。 */
const ANALYTICS_AUDIT_MAX_PAGES = 100

/** Analytics が認可済み Work Item 全体で評価する最大 audit event 数です。 */
const ANALYTICS_AUDIT_EVENT_LIMIT =
  ANALYTICS_AUDIT_PAGE_SIZE * ANALYTICS_AUDIT_MAX_PAGES

/** Entity-scoped audit query を並列実行する最大 worker 数です。 */
const ANALYTICS_AUDIT_QUERY_CONCURRENCY = 8

/** API timeout 内に収めるため、一度にqueryするcanonical Work Item entityの最大数です。 */
const ANALYTICS_AUDIT_ENTITY_QUERY_LIMIT = 500

/** 全 canonical entity の pagination を通じて実行する audit page query の最大数です。 */
const ANALYTICS_AUDIT_PAGE_QUERY_LIMIT = 500

/** Analytics が filter/ACL 適用後に一度に評価する Work Item の最大数です。 */
const ANALYTICS_WORK_ITEM_LIMIT = 10_000

/** Analytics が一度に読む Team または Project partition の最大数です。 */
const ANALYTICS_WORK_ITEM_PARTITION_COUNT_LIMIT = 100

/** Analytics が一つの Team または Project partition で評価する最大 item 数です。 */
const ANALYTICS_WORK_ITEM_PARTITION_SCAN_LIMIT = 10_000

/** Canonical Work Item と audit history を揃える最大 read barrier 試行回数です。 */
const ANALYTICS_READ_BARRIER_MAX_ATTEMPTS = 3

/** Analytics snapshot 一覧で一度に返す current ACL 検証済み record の最大数です。 */
const ANALYTICS_SNAPSHOT_LIST_LIMIT = 100

/** Analytics snapshot 一覧の一 response で current ACL を検査する最大保存 record 数です。 */
const ANALYTICS_SNAPSHOT_ACL_INSPECTION_LIMIT = 1_000

/** Analytics snapshot 一覧の一 response で直列実行するrepository readの最大数です。 */
const ANALYTICS_SNAPSHOT_REPOSITORY_PAGE_LIMIT = 10

/** Analytics route の JSON object body を検証します。 */
async function readAnalyticsJson(c: Context): Promise<Record<string, unknown>> {
  const value = await readJson<unknown>(c.req)
  if (!isRecord(value)) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsInput',
      'A JSON object request body is required.',
    )
  }
  return value
}

/** Executes an ad-hoc or saved Analytics query for the authenticated principal. */
async function executeAnalyticsHttpQuery(
  principal: WorkspacePrincipal,
  input: Record<string, unknown>,
) {
  const query = await resolveAnalyticsQuery(principal, input)
  return await executeAnalyticsQuery(principal, query)
}

/** Executes an Analytics evidence request for the authenticated principal. */
async function executeAnalyticsHttpEvidence(
  principal: WorkspacePrincipal,
  input: Record<string, unknown>,
) {
  return await executeAnalyticsEvidenceQuery(principal, input)
}

/** Generates a CSV or PDF Analytics export for the authenticated principal. */
async function createAnalyticsHttpExport(
  principal: WorkspacePrincipal,
  input: Record<string, unknown>,
): Promise<AnalyticsExportFile> {
  const format = readAnalyticsExportFormat(input.format)
  const locale = normalizeAnalyticsExportLocale(
    typeof input.locale === 'string' ? input.locale : undefined,
  )
  const snapshot = await resolveAnalyticsExportSnapshot(principal, input)
  return format === 'csv'
    ? {
        body: createAnalyticsCsv(snapshot, locale),
        extension: format,
        contentType: 'text/csv; charset=utf-8',
      }
    : {
        body: createAnalyticsPdf(snapshot, locale),
        extension: format,
        contentType: 'application/pdf',
      }
}

/** Lists Analytics reports visible to the authenticated principal. */
async function listAnalyticsHttpReports(
  principal: WorkspacePrincipal,
  limit: string | undefined,
  cursor: string | undefined,
) {
  const context = await createWorkspaceSearchContext(principal)
  const response = await workItemDependencies.analytics.listReports(
    principal.directoryId,
    readAnalyticsReportListLimit(limit),
    readAnalyticsReportListCursor(cursor),
  )
  return {
    reports: response.reports.filter((report) =>
      canReadAnalyticsReport(principal, context, report)
    ),
    ...(response.nextCursor === undefined
      ? {}
      : { nextCursor: response.nextCursor }),
  }
}

/** Creates an Analytics report after applying visibility authorization. */
async function createAnalyticsHttpReport(
  principal: WorkspacePrincipal,
  input: Record<string, unknown>,
) {
  requireWorkspaceBusinessWrite(principal)
  const normalized = sanitizePublicAnalyticsReportCreateInput(input)
  await requireAnalyticsVisibilityWrite(
    principal,
    normalized.visibility,
    normalized.teamId,
    principal.userKey,
  )
  return await workItemDependencies.analytics.createReport(
    principal.directoryId,
    principal.userKey,
    normalized,
  )
}

/** Updates an Analytics report after authorization and revision checks. */
async function updateAnalyticsHttpReport(
  principal: WorkspacePrincipal,
  reportIdValue: string,
  input: Record<string, unknown>,
) {
  requireWorkspaceBusinessWrite(principal)
  const reportId = readAnalyticsIdentifier(reportIdValue, 'Analytics report ID')
  const current = await requireAnalyticsReport(principal, reportId)
  await requireAnalyticsReportWrite(principal, current)
  const normalized = sanitizePublicAnalyticsReportUpdateInput(input, current)
  await requireAnalyticsVisibilityWrite(
    principal,
    normalized.visibility ?? current.visibility,
    normalized.teamId === null ? undefined : normalized.teamId ?? current.teamId,
    current.ownerMemberKey,
  )
  return await workItemDependencies.analytics.updateReport(principal.directoryId, reportId, normalized)
}

/** Deletes an Analytics report after authorization and revision checks. */
async function deleteAnalyticsHttpReport(
  principal: WorkspacePrincipal,
  reportIdValue: string,
  input: Record<string, unknown>,
) {
  requireWorkspaceBusinessWrite(principal)
  const reportId = readAnalyticsIdentifier(reportIdValue, 'Analytics report ID')
  const current = await requireAnalyticsReport(principal, reportId)
  await requireAnalyticsReportWrite(principal, current)
  const expectedRevision = readAnalyticsExpectedRevision(input.expectedRevision)
  await workItemDependencies.analytics.deleteReport(principal.directoryId, reportId, expectedRevision)
}

/** Lists report snapshots that remain visible under the current ACL. */
async function listAnalyticsHttpSnapshots(
  principal: WorkspacePrincipal,
  reportIdValue: string,
  cursor: string | undefined,
) {
  const reportId = readAnalyticsIdentifier(reportIdValue, 'Analytics report ID')
  const report = await requireAnalyticsReport(principal, reportId)
  const visibleSnapshots: AnalyticsSnapshotRecord[] = []
  const scopeCache = new Map<
    string,
    ReturnType<typeof readAccessibleAnalyticsWorkItems>
  >()
  const permissionScopeHashCache = new Map<string, Promise<string>>()
  const seenCursors = new Set<string>()
  let inspectedCount = 0
  let repositoryPageCount = 0
  let nextCursor = readAnalyticsSnapshotListCursor(cursor)
  if (nextCursor !== undefined) seenCursors.add(nextCursor)
  do {
    const pageCursor = nextCursor
    const page = await workItemDependencies.analytics.listSnapshots(
      principal.directoryId,
      report.id,
      Math.min(
        ANALYTICS_SNAPSHOT_LIST_LIMIT,
        ANALYTICS_SNAPSHOT_ACL_INSPECTION_LIMIT - inspectedCount,
      ),
      pageCursor,
    )
    repositoryPageCount += 1
    let resumeCursor = page.nextCursor
    for (const [recordIndex, record] of page.snapshots.entries()) {
      inspectedCount += 1
      const queryCacheKey = record.snapshot.queryHash
      let pendingPermissionScopeHash = permissionScopeHashCache.get(queryCacheKey)
      if (!pendingPermissionScopeHash) {
        pendingPermissionScopeHash = readCurrentAnalyticsPermissionScopeHash(
          principal,
          record.query,
          scopeCache,
        )
        permissionScopeHashCache.set(queryCacheKey, pendingPermissionScopeHash)
      }
      const currentPermissionScopeHash = await pendingPermissionScopeHash
      if (currentPermissionScopeHash === record.snapshot.permissionScopeHash) {
        visibleSnapshots.push(record)
        if (visibleSnapshots.length === ANALYTICS_SNAPSHOT_LIST_LIMIT) {
          resumeCursor = recordIndex < page.snapshots.length - 1
            ? createAnalyticsSnapshotListCursor(
                principal.directoryId,
                report.id,
                record,
              )
            : page.nextCursor
          break
        }
      }
    }
    nextCursor = resumeCursor
    if (
      nextCursor !== undefined &&
      (
        page.snapshots.length === 0 ||
        nextCursor === pageCursor ||
        seenCursors.has(nextCursor)
      )
    ) {
      throw new AnalyticsError(
        500,
        'AnalyticsSnapshotPaginationInvalid',
        'Analytics snapshot pagination did not make progress.',
      )
    }
    if (nextCursor !== undefined) seenCursors.add(nextCursor)
  } while (
    visibleSnapshots.length < ANALYTICS_SNAPSHOT_LIST_LIMIT &&
    inspectedCount < ANALYTICS_SNAPSHOT_ACL_INSPECTION_LIMIT &&
    repositoryPageCount < ANALYTICS_SNAPSHOT_REPOSITORY_PAGE_LIMIT &&
    nextCursor !== undefined
  )
  return {
    snapshots: visibleSnapshots,
    inspectedCount,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  } satisfies AnalyticsSnapshotListResponse
}

/** Creates an immutable report snapshot under the current ACL. */
async function createAnalyticsHttpSnapshot(
  principal: WorkspacePrincipal,
  reportIdValue: string,
  input: Record<string, unknown>,
  idempotencyKey: string | undefined,
) {
  requireWorkspaceBusinessWrite(principal)
  const reportId = readAnalyticsIdentifier(reportIdValue, 'Analytics report ID')
  const report = await requireAnalyticsReport(principal, reportId)
  await requireAnalyticsReportWrite(principal, report)
  const query = createAnalyticsReportQuery(report, input)
  const snapshot = await executeAnalyticsQuery(principal, query)
  const createdAt = new Date().toISOString()
  return await workItemDependencies.analytics.putSnapshot({
    id: createAnalyticsSnapshotId(
      principal.directoryId,
      report,
      snapshot,
      principal.userKey,
      idempotencyKey,
    ),
    workspaceId: principal.directoryId,
    reportId: report.id,
    reportRevision: report.revision,
    createdByMemberKey: principal.userKey,
    createdAt,
    query: structuredClone(query),
    snapshot,
  })
}

/** Public create input から server-owned schedule cursor を除外します。 */
function sanitizePublicAnalyticsReportCreateInput(
  body: Record<string, unknown>,
): CreateAnalyticsReportInput {
  return {
    ...body,
    ...(body.schedule === undefined
      ? {}
      : { schedule: stripAnalyticsScheduleCursor(body.schedule) }),
  } as unknown as CreateAnalyticsReportInput
}

/**
 * Public update input の schedule cursor を除外し、設定が不変なら current cursor を保持します。
 */
function sanitizePublicAnalyticsReportUpdateInput(
  body: Record<string, unknown>,
  current: AnalyticsReport,
): UpdateAnalyticsReportInput {
  if (!isRecord(body.schedule)) {
    return body as unknown as UpdateAnalyticsReportInput
  }
  const schedule = stripAnalyticsScheduleCursor(body.schedule)
  const currentSchedule = current.schedule
  return {
    ...body,
    schedule: currentSchedule !== undefined &&
        analyticsScheduleConfigurationKey(schedule) ===
          analyticsScheduleConfigurationKey(currentSchedule)
      ? structuredClone(currentSchedule)
      : schedule,
  } as unknown as UpdateAnalyticsReportInput
}

/** Client-controlled `nextRunAt` を schedule configuration から除きます。 */
function stripAnalyticsScheduleCursor(value: unknown) {
  if (!isRecord(value)) return value
  const { nextRunAt: _clientNextRunAt, ...schedule } = value
  return schedule
}

/** Schedule cursor を除いた semantic configuration の比較 key を返します。 */
function analyticsScheduleConfigurationKey(value: unknown) {
  if (!isRecord(value)) return JSON.stringify(value)
  const recipients = Array.isArray(value.recipientMemberKeys) &&
      value.recipientMemberKeys.every((recipient) => typeof recipient === 'string')
    ? [...new Set(value.recipientMemberKeys)].sort()
    : value.recipientMemberKeys
  return JSON.stringify({
    enabled: value.enabled,
    frequency: value.frequency,
    timeZone: value.timeZone,
    localTime: value.localTime,
    dayOfWeek: value.dayOfWeek,
    dayOfMonth: value.dayOfMonth,
    recipientMemberKeys: recipients,
    format: value.format,
  })
}

/** Ad-hoc input または saved report ID から実行 query を解決します。 */
async function resolveAnalyticsQuery(
  principal: WorkspacePrincipal,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (body.reportId === undefined) {
    return body
  }
  const reportId = readAnalyticsIdentifier(body.reportId, 'Analytics report ID')
  const report = await requireAnalyticsReport(principal, reportId)
  return createAnalyticsReportQuery(report, body)
}

/** Saved report の definition を client override から保護して query にします。 */
function createAnalyticsReportQuery(
  report: AnalyticsReport,
  overrides: Record<string, unknown>,
): AnalyticsQueryInput {
  const asOf = typeof overrides.asOf === 'string' && overrides.asOf.trim()
    ? overrides.asOf
    : new Date().toISOString()
  return {
    filter: structuredClone(report.filter),
    widgets: structuredClone(report.widgets),
    asOf,
    timeZone: report.timeZone,
    ...(report.forecastBaseline === undefined
      ? {}
      : { forecastBaseline: structuredClone(report.forecastBaseline) }),
  }
}

/** Query を事前検証し、current ACL の Work Item/event だけで snapshot を作ります。 */
async function executeAnalyticsQuery(
  principal: WorkspacePrincipal,
  query: unknown,
): Promise<AnalyticsSnapshot> {
  const normalizedQuery = normalizeAnalyticsQueryInput(query)
  const authorized = await readAuthorizedAnalyticsData(
    principal,
    normalizedQuery.filter,
    normalizedQuery.asOf,
  )
  return createAnalyticsSnapshot({ ...authorized, query: normalizedQuery })
}

/** Evidence query を事前検証し、current ACL の Work Item/event だけで再実行します。 */
async function executeAnalyticsEvidenceQuery(
  principal: WorkspacePrincipal,
  evidence: unknown,
) {
  const normalizedEvidence = normalizeAnalyticsEvidenceInput(evidence)
  const authorized = await readAuthorizedAnalyticsData(
    principal,
    normalizedEvidence.filter,
    normalizedEvidence.asOf,
  )
  return queryAnalyticsEvidence({ ...authorized, evidence: normalizedEvidence })
}

/**
 * Analytics engine へ渡す前に current Work Item ACL を確定し、対応eventだけを残します。
 */
async function readAuthorizedAnalyticsData(
  principal: WorkspacePrincipal,
  filter: AnalyticsQueryInput['filter'],
  asOf: string,
) {
  let accessible = await readAccessibleAnalyticsWorkItems(
    principal,
    filter,
  )
  const historyReadAt = new Date(
    Math.max(Date.now(), Date.parse(asOf)),
  ).toISOString()
  assertAnalyticsWorkItemsAtCutoff(accessible.workItems, historyReadAt)

  for (
    let attempt = 0;
    attempt < ANALYTICS_READ_BARRIER_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const events = await readAuthorizedAnalyticsAuditEvents(
      principal.directoryId,
      accessible.workItems,
      historyReadAt,
    )
    const verified = await readAccessibleAnalyticsWorkItems(
      principal,
      filter,
    )
    assertAnalyticsWorkItemsAtCutoff(verified.workItems, historyReadAt)

    if (
      createAnalyticsAccessibleDataFingerprint(accessible) ===
        createAnalyticsAccessibleDataFingerprint(verified) &&
      hasAnalyticsLatestAuditCoverage(verified.workItems, events)
    ) {
      return {
        workItems: verified.workItems,
        events,
        authorizedProjectIds: verified.authorizedProjectIds,
      }
    }
    accessible = verified
  }

  throw createAnalyticsReadBarrierError()
}

/** Canonical state が audit cutoff 以下であることを fail-closed に検証します。 */
function assertAnalyticsWorkItemsAtCutoff(
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
    throw createAnalyticsReadBarrierError()
  }
}

/** ACL allowlist と canonical Work Item 集合の順序非依存 fingerprint を返します。 */
function createAnalyticsAccessibleDataFingerprint(
  accessible: Awaited<ReturnType<typeof readAccessibleAnalyticsWorkItems>>,
) {
  const digest = createHash('sha256')
  for (const projectId of [...accessible.authorizedProjectIds].sort()) {
    digest.update(`project:${projectId}\0`)
  }
  const workItems = [...accessible.workItems].sort((left, right) =>
    createTeamIssueAuditEntityId(left.teamId, left.id).localeCompare(
      createTeamIssueAuditEntityId(right.teamId, right.id),
    )
  )
  for (const workItem of workItems) {
    digest.update(stableAnalyticsApiStringify(workItem))
    digest.update('\0')
  }
  return digest.digest('hex')
}

/** Object key の列挙順に依存しない canonical JSON 文字列を返します。 */
function stableAnalyticsApiStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableAnalyticsApiStringify).join(',')}]`
  }
  if (!isRecord(value)) {
    return JSON.stringify(value) ?? 'undefined'
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${stableAnalyticsApiStringify(entry)}`
    )
    .join(',')}}`
}

/**
 * Checks that every current canonical revision requiring history coverage has a matching event.
 *
 * @param workItems Current canonical Work Items selected for the request.
 * @param events Canonical audit events read for those Work Items.
 * @returns True when every relevant Work Item has its latest revision covered.
 */
function hasAnalyticsLatestAuditCoverage(
  workItems: readonly CanonicalWorkItem[],
  events: readonly AuditEventV1[],
) {
  return workItems.every((workItem) => {
    if (workItem.revision <= 1) return true
    const canonicalEntityId = createTeamIssueAuditEntityId(
      workItem.teamId,
      workItem.id,
    )
    const updatedAt = Date.parse(workItem.updatedAt)
    return events.some((event) =>
      Date.parse(event.occurredAt) === updatedAt &&
      isAnalyticsLatestWorkItemUpdate(event, workItem, canonicalEntityId) &&
      isCanonicalAnalyticsAuditEvent(event, canonicalEntityId)
    )
  })
}

/**
 * Checks whether an event represents the latest canonical Work Item revision.
 *
 * @param event Candidate audit event.
 * @param workItem Current canonical Work Item.
 * @param canonicalEntityId Expected canonical entity ID.
 * @returns True when event identity, metadata, revision, and action all match.
 */
function isAnalyticsLatestWorkItemUpdate(
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
    event.targetId !== canonicalEntityId
  ) {
    return false
  }
  const metadataTeamId = readAnalyticsAuditMetadataText(event.metadata?.teamId)
  const metadataIssueId = readAnalyticsAuditMetadataText(event.metadata?.issueId)
  return event.metadata?.adapter === 'canonical-work-item' &&
    event.metadata.afterRevision === workItem.revision &&
    metadataTeamId === workItem.teamId &&
    metadataIssueId === workItem.id
}

/** Creates the retryable error returned when bounded canonical/audit reads do not converge. */
function createAnalyticsReadBarrierError() {
  return new AnalyticsError(
    503,
    'AnalyticsReadBarrierUnavailable',
    'Analytics data changed while its audit history was being read. Retry the request.',
  )
}

/**
 * Reads only canonical Work Item entities selected by the current ACL from the entity GSI.
 *
 * @param workspaceId Workspace whose audit history is being read.
 * @param workItems ACL-filtered canonical Work Items.
 * @param historyReadAt Exclusive upper bound for the history query.
 * @returns Canonical audit events read from the authorized entity timelines.
 * @throws When the query or event limits are exceeded, or an audit query fails.
 */
async function readAuthorizedAnalyticsAuditEvents(
  workspaceId: string,
  workItems: readonly TeamIssueResponseItem[],
  historyReadAt: string,
) {
  const entityIds = [...new Set(workItems.map((workItem) =>
    createTeamIssueAuditEntityId(workItem.teamId, workItem.id)
  ))].sort()
  if (entityIds.length > ANALYTICS_AUDIT_ENTITY_QUERY_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsHistoryLimitExceeded',
      `Analytics history requires more than ${ANALYTICS_AUDIT_ENTITY_QUERY_LIMIT} entity timeline queries. Narrow the report scope.`,
    )
  }
  const events: AuditEventV1[] = []
  let nextEntityIndex = 0
  let pageQueryCount = 0
  let readEventCount = 0
  let failure: unknown
  const workerCount = Math.min(ANALYTICS_AUDIT_QUERY_CONCURRENCY, entityIds.length)

  /** Reads the next assigned canonical entity timeline and accumulates its events. */
  const readNextEntity = async () => {
    while (failure === undefined) {
      const entityIndex = nextEntityIndex
      nextEntityIndex += 1
      const entityId = entityIds[entityIndex]
      if (!entityId) return

      try {
        let cursor: string | undefined
        let pageCount = 0
        do {
          if (
            pageCount >= ANALYTICS_AUDIT_MAX_PAGES ||
            pageQueryCount >= ANALYTICS_AUDIT_PAGE_QUERY_LIMIT
          ) {
            throw createAnalyticsHistoryLimitExceededError()
          }
          pageQueryCount += 1
          const page = await workspaceDependencies.auditEvents.query({
            workspaceId,
            entityType: 'work-item',
            entityId,
            to: historyReadAt,
            limit: ANALYTICS_AUDIT_PAGE_SIZE,
            cursor,
            direction: 'ascending',
          })
          pageCount += 1
          readEventCount += page.events.length
          if (readEventCount > ANALYTICS_AUDIT_EVENT_LIMIT) {
            throw createAnalyticsHistoryLimitExceededError()
          }
          for (const event of page.events) {
            if (!isCanonicalAnalyticsAuditEvent(event, entityId)) continue

            events.push(event)
            if (events.length > ANALYTICS_AUDIT_EVENT_LIMIT) {
              throw createAnalyticsHistoryLimitExceededError()
            }
          }
          cursor = page.nextCursor
        } while (cursor)
      } catch (error) {
        failure ??= error
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, readNextEntity))
  if (failure !== undefined) throw failure
  return events
}

/**
 * Checks that an entity-scoped query result matches the requested canonical Work Item entity.
 *
 * @param event Candidate audit event.
 * @param canonicalEntityId Entity ID used by the query.
 * @returns True when both persisted entity IDs exactly match the query identity.
 */
function isCanonicalAnalyticsAuditEvent(
  event: AuditEventV1,
  canonicalEntityId: string,
) {
  return event.entityType === 'work-item' &&
    event.entity.type === 'work-item' &&
    event.entityId === canonicalEntityId &&
    event.entity.id === canonicalEntityId
}

/** Returns a trimmed non-empty Analytics audit metadata string. */
function readAnalyticsAuditMetadataText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Relevant entity history が安全上限を超えた場合の fail-closed error を返します。 */
function createAnalyticsHistoryLimitExceededError() {
  return new AnalyticsError(
    413,
    'AnalyticsHistoryLimitExceeded',
    'Analytics history for the authorized Work Items exceeds the safe query limit. Narrow the report scope.',
  )
}

/**
 * Snapshot ACL 再検証では audit history/metric を再計算せず、current accessible Work Item
 * key、active readable Project allowlist、snapshot `asOf` から同じ permission scope hash
 * を作ります。
 */
async function readCurrentAnalyticsPermissionScopeHash(
  principal: WorkspacePrincipal,
  query: AnalyticsQueryInput,
  cache = new Map<string, ReturnType<typeof readAccessibleAnalyticsWorkItems>>(),
) {
  const normalized = normalizeAnalyticsQueryInput(query)
  const cacheKey = JSON.stringify({
    teamIds: normalized.filter.teamIds ?? null,
    projectIds: normalized.filter.projectIds ?? null,
    includeArchived: normalized.filter.includeArchived === true,
  })
  let accessible = cache.get(cacheKey)
  if (!accessible) {
    accessible = readAccessibleAnalyticsWorkItems(principal, normalized.filter)
    cache.set(cacheKey, accessible)
  }
  const current = await accessible
  return createAnalyticsPermissionScopeHash(
    current.workItems,
    Date.parse(normalized.asOf),
    current.authorizedProjectIds,
  )
}

/** Export selector を current ACL で再実行できる snapshot へ解決します。 */
async function resolveAnalyticsExportSnapshot(
  principal: WorkspacePrincipal,
  input: Record<string, unknown>,
) {
  const selectorCount = Number(input.query !== undefined) +
    Number(input.reportId !== undefined) +
    Number(input.snapshotId !== undefined)
  if (selectorCount !== 1) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsExport',
      'Analytics export requires exactly one query, reportId, or snapshotId.',
    )
  }
  if (input.query !== undefined) {
    return await executeAnalyticsQuery(principal, input.query)
  }
  if (input.reportId !== undefined) {
    const report = await requireAnalyticsReport(
      principal,
      readAnalyticsIdentifier(input.reportId, 'Analytics report ID'),
    )
    return await executeAnalyticsQuery(
      principal,
      createAnalyticsReportQuery(report, {}),
    )
  }

  const snapshotId = readAnalyticsIdentifier(input.snapshotId, 'Analytics snapshot ID')
  const stored = await workItemDependencies.analytics.getSnapshot(principal.directoryId, snapshotId)
  if (!stored) {
    throw new AnalyticsError(404, 'AnalyticsSnapshotNotFound', 'Analytics snapshot was not found.')
  }
  if (stored.reportId) {
    await requireAnalyticsReport(principal, stored.reportId)
  } else if (stored.createdByMemberKey !== principal.userKey) {
    throw new AnalyticsError(
      403,
      'AnalyticsSnapshotForbidden',
      'Analytics snapshot access is denied.',
    )
  }
  const currentPermissionScopeHash = await readCurrentAnalyticsPermissionScopeHash(
    principal,
    stored.query,
  )
  if (currentPermissionScopeHash !== stored.snapshot.permissionScopeHash) {
    throw new AnalyticsError(
      403,
      'AnalyticsSnapshotScopeChanged',
      'Analytics snapshot authorization scope has changed.',
    )
  }
  return stored.snapshot
}

/** Analytics export format を検証します。 */
function readAnalyticsExportFormat(value: unknown): 'csv' | 'pdf' {
  if (value === 'csv' || value === 'pdf') return value
  throw new AnalyticsError(
    400,
    'InvalidAnalyticsExport',
    'Analytics export format must be csv or pdf.',
  )
}

/** Current viewer が report definition 自体を参照できるか判定します。 */
function canReadAnalyticsReport(
  principal: WorkspacePrincipal,
  context: WorkspaceSearchContext,
  report: AnalyticsReport,
) {
  if (report.visibility === 'personal') {
    return report.ownerMemberKey === principal.userKey
  }
  if (report.visibility === 'shared') {
    return true
  }
  return report.visibility === 'team' &&
    typeof report.teamId === 'string' &&
    context.savedViewAccess.teamIds.has(report.teamId)
}

/** Report を取得し、current visibility policy を満たすことを保証します。 */
async function requireAnalyticsReport(
  principal: WorkspacePrincipal,
  reportId: string,
) {
  const report = await workItemDependencies.analytics.getReport(principal.directoryId, reportId)
  if (!report) {
    throw new AnalyticsError(404, 'AnalyticsReportNotFound', 'Analytics report was not found.')
  }
  const context = await createWorkspaceSearchContext(principal)
  if (!canReadAnalyticsReport(principal, context, report)) {
    throw new AnalyticsError(403, 'AnalyticsReportForbidden', 'Analytics report access is denied.')
  }
  return report
}

/** Existing report の visibility に応じた write role を要求します。 */
async function requireAnalyticsReportWrite(
  principal: WorkspacePrincipal,
  report: AnalyticsReport,
) {
  await requireAnalyticsVisibilityWrite(
    principal,
    report.visibility,
    report.teamId,
    report.ownerMemberKey,
  )
}

/** Personal/team/shared report の作成・更新・削除 policy を適用します。 */
async function requireAnalyticsVisibilityWrite(
  principal: WorkspacePrincipal,
  visibility: unknown,
  teamId: unknown,
  ownerMemberKey: string,
) {
  if (visibility === 'personal') {
    if (
      ownerMemberKey !== principal.userKey ||
      principal.enterprisePermissions !== undefined &&
        principal.enterpriseGrantedRoutePermissions?.includes('work-items.write') !== true
    ) {
      throw new AnalyticsError(
        403,
        'AnalyticsReportForbidden',
        'Only the personal report owner can change this report.',
      )
    }
    return
  }
  if (visibility === 'team') {
    const normalizedTeamId = readAnalyticsIdentifier(teamId, 'Analytics report Team ID')
    if (principal.enterprisePermissions !== undefined) {
      const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
        principal.directoryId,
        'ja',
      )
      if (!directory.teams.some((team) => team.id === normalizedTeamId)) {
        throw new ProjectDataError(
          404,
          'TeamNotFound',
          `Team "${normalizedTeamId}" was not found.`,
        )
      }
      if (
        hasEnterpriseWorkspacePermission(principal, 'teams.manage') ||
        principal.enterpriseTeamAccesses?.some((access) =>
          access.teamId === normalizedTeamId &&
          access.permissions.includes('teams.manage')
        )
      ) {
        return
      }
      throw new AnalyticsError(
        403,
        'AnalyticsReportForbidden',
        'Target Team management permission is required to change this report.',
      )
    }
    await requireTeamPermission(principal, normalizedTeamId, 'manager')
    return
  }
  if (visibility === 'shared') {
    if (principal.enterprisePermissions !== undefined) {
      if (hasEnterpriseWorkspacePermission(principal, 'workspace.manage')) return
      throw new AnalyticsError(
        403,
        'AnalyticsReportForbidden',
        'Workspace management permission is required to change this report.',
      )
    }
    requireWorkspaceAdministration(principal)
    return
  }
  throw new AnalyticsError(
    400,
    'InvalidAnalyticsReport',
    'Analytics report visibility is invalid.',
  )
}

/** Analytics route identifier を path/storage keyに安全な形式へ制限します。 */
function readAnalyticsIdentifier(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
  ) {
    throw new AnalyticsError(400, 'InvalidAnalyticsInput', `${label} is invalid.`)
  }
  return value
}

/** Analytics report list の page size を API 上限内に制限します。 */
function readAnalyticsReportListLimit(value: string | undefined) {
  if (value === undefined) return 200
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsInput',
      'Analytics report list limit must be an integer between 1 and 200.',
    )
  }
  return parsed
}

/** Analytics report list の opaque cursor を空白なしの bounded token として返します。 */
function readAnalyticsReportListCursor(value: string | undefined) {
  if (value === undefined) return undefined
  const cursor = value.trim()
  if (!cursor || cursor.length > 16_384) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsInput',
      'Analytics report list cursor is invalid.',
    )
  }
  return cursor
}

/** Analytics snapshot list の opaque cursor を data read 前に検証します。 */
function readAnalyticsSnapshotListCursor(value: string | undefined) {
  if (value === undefined) return undefined
  const cursor = value.trim()
  if (
    !cursor ||
    cursor.length > 16_384 ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsInput',
      'Analytics snapshot list cursor is invalid.',
    )
  }
  return cursor
}

/** Report mutation の positive optimistic revision を検証します。 */
function readAnalyticsExpectedRevision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AnalyticsError(
      400,
      'InvalidAnalyticsReport',
      'Analytics expectedRevision must be a positive safe integer.',
    )
  }
  return Number(value)
}

/** Snapshot retry を同じ immutable record ID へ収束させます。 */
function createAnalyticsSnapshotId(
  workspaceId: string,
  report: AnalyticsReport,
  snapshot: AnalyticsSnapshot,
  memberKey: string,
  idempotencyKey: string | undefined,
) {
  const operationKey = idempotencyKey?.trim() || crypto.randomUUID()
  const digest = createHash('sha256')
    .update(JSON.stringify({
      workspaceId,
      reportId: report.id,
      reportRevision: report.revision,
      queryHash: snapshot.queryHash,
      memberKey,
      operationKey,
    }))
    .digest('hex')
  return `snapshot_${digest.slice(0, 48)}`
}

/** Analytics domain/persistence error を公開可能な API response へ変換します。 */
function toAnalyticsErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(c, error)
  }
  if (error instanceof WorkspaceAccessError) {
    return toWorkspaceAccessErrorResponse(c, error)
  }
  if (error instanceof ProjectDataError || isTeamIssueNotFoundError(error)) {
    return toProjectDataErrorResponse(c, error)
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return c.json({ code: 'InvalidAnalyticsInput', message: error.message }, 400)
  }
  if (!(error instanceof AnalyticsError)) {
    console.error(error)
    return c.json(
      { code: 'AnalyticsUnavailable', message: 'Analytics data is unavailable.' },
      502,
    )
  }
  if (error.status >= 500) {
    console.error(error)
  }
  const status = error.status === 400 ||
      error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 409 ||
      error.status === 413 ||
      error.status === 422 ||
      error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Analytics filter の Team/Project scope を read 前に適用し、current ACL の canonical
 * Work Item を通常一覧とは独立した安全上限まで返します。
 */
async function readAccessibleAnalyticsWorkItems(
  principal: ProjectPrincipal,
  filter: AnalyticsQueryInput['filter'],
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
    true,
  )
  const filteredTeamIds = filter.teamIds === undefined
    ? undefined
    : new Set(filter.teamIds)
  const filteredProjectIds = filter.projectIds === undefined
    ? undefined
    : new Set(filter.projectIds)
  const projectAccesses = principal.isSystemAdmin
    ? undefined
    : await getEffectiveProjectAccessList(principal)
  const authorizedTeamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
  const activeProjectIds = new Set(directory.teams.flatMap((team) =>
    team.projects.map((project) => project.id)
  ))
  const readableProjectIds = principal.isSystemAdmin
    ? activeProjectIds
    : new Set(
        (projectAccesses ?? [])
          .filter((access) =>
            activeProjectIds.has(access.projectId) &&
            projectAccessAllows(access, 'viewer')
          )
          .map((access) => access.projectId),
      )
  const workItemsById = new Map<string, TeamIssueResponseItem>()
  const addWorkItem = (workItem: TeamIssueResponseItem) => {
    workItemsById.set(`${workItem.teamId}\0${workItem.id}`, workItem)
    if (workItemsById.size > ANALYTICS_WORK_ITEM_LIMIT) {
      throw new AnalyticsError(
        413,
        'AnalyticsWorkItemLimitExceeded',
        `Analytics query has more than ${ANALYTICS_WORK_ITEM_LIMIT} accessible Work Items. Narrow the report scope.`,
      )
    }
  }
  const readOptions: WorkItemListReadOptions = {
    limit: ANALYTICS_WORK_ITEM_PARTITION_SCAN_LIMIT + 1,
    consistentRead: true,
    includeArchived: true,
  }

  const selectedTeams = directory.teams.filter((team) => {
    if (filteredTeamIds !== undefined && !filteredTeamIds.has(team.id)) return false
    if (
      filteredProjectIds === undefined &&
      (principal.isSystemAdmin || authorizedTeamIds.has(team.id))
    ) {
      return true
    }
    return team.projects.some((project) => {
      return readableProjectIds.has(project.id) &&
        (filteredProjectIds === undefined || filteredProjectIds.has(project.id))
    })
  })
  assertAnalyticsPartitionCount(selectedTeams.length)
  for (const team of selectedTeams) {
    const response = await workItemDependencies.teamIssues.getTeamIssues(
      principal.directoryId,
      team.id,
      readOptions,
    )
    assertAnalyticsPartitionSize(response.issues, `Team "${team.id}"`)
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
  return {
    workItems: [...workItemsById.values()],
    authorizedProjectIds: readableProjectIds,
  }
}

/** Analytics data read が評価する partition 数を fail-closed 上限内に制限します。 */
function assertAnalyticsPartitionCount(count: number) {
  if (count > ANALYTICS_WORK_ITEM_PARTITION_COUNT_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsWorkItemLimitExceeded',
      `Analytics query spans more than ${ANALYTICS_WORK_ITEM_PARTITION_COUNT_LIMIT} data partitions. Narrow the report scope.`,
    )
  }
}

/** Analytics data read が一つの partition から部分結果を返さないよう probe 結果を検証します。 */
function assertAnalyticsPartitionSize(
  workItems: readonly TeamIssueResponseItem[],
  scope: string,
) {
  if (workItems.length > ANALYTICS_WORK_ITEM_PARTITION_SCAN_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsWorkItemLimitExceeded',
      `${scope} has more than ${ANALYTICS_WORK_ITEM_PARTITION_SCAN_LIMIT} Work Items. Narrow the report scope.`,
    )
  }
}

/**
 * Registers the analytics HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerAnalyticsRoutes(routeApp: Hono): void {
  /**
   * DynamoDB に保存されたダッシュボード集計値を返す endpoint です。
   *
   * @remarks
   * `Authorization: Bearer <accessToken>` header を要求し、Cognito で token を検証してから
   * DynamoDB の集計 item を読みます。React から Lambda/API Gateway 経由で呼ぶ想定の読み取り API です。
   */
  routeApp.route('/', createDashboardRouter<
    WorkspacePrincipal,
    ProjectAccessEntry,
    DashboardSummaryResponse
  >({
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    getProjectAccesses: getEffectiveProjectAccessList,
    getSummary: (workspaceId, access) => workspaceDependencies.dashboardSummary.getSummary(workspaceId, access),
    isAuthenticationError: (error) => error instanceof CognitoServiceError,
    mapAuthenticationError: toAuthErrorResponse,
    mapProjectDataError: toProjectDataErrorResponse,
  }))

  routeApp.route('/', createAnalyticsRouter({
    readBearerAccessToken,
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    readJson: readAnalyticsJson,
    executeQuery: executeAnalyticsHttpQuery,
    executeEvidence: executeAnalyticsHttpEvidence,
    createExport: createAnalyticsHttpExport,
    listReports: listAnalyticsHttpReports,
    createReport: createAnalyticsHttpReport,
    updateReport: updateAnalyticsHttpReport,
    deleteReport: deleteAnalyticsHttpReport,
    listSnapshots: listAnalyticsHttpSnapshots,
    createSnapshot: createAnalyticsHttpSnapshot,
    mapError: toAnalyticsErrorResponse,
  }))
}
