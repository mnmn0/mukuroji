import type { AnalyticsFilter, PlanningEntity } from '@mukuroji/contracts'
import {
  ANALYTICS_MILESTONE_TREND_FIELDS,
  AnalyticsError,
  type AnalyticsMilestoneChange,
  type AnalyticsMilestoneFieldChange,
  type AnalyticsMilestoneHistory,
} from '../../modules/analytics'
import type { AuditEventV1, AuditValue } from '../../modules/audit/audit'
import { evaluateEnterpriseAccess } from '../../modules/enterprise-identity'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import { filterPlanningSnapshotForPrincipal, withPlanningLegacyReadScope } from './planning-access'
import {
  PLANNING_ENTITY_AUDIT_ENTITY_TYPE,
  readPlanningEntityAuditScopes,
} from './planning-entity-audit'
import type { WorkspacePrincipal } from './project-access'

/** Maximum number of Milestones one Analytics query reads. */
export const ANALYTICS_MILESTONE_LIMIT = 100

/** Audit page size of one Milestone timeline query. */
const ANALYTICS_MILESTONE_AUDIT_PAGE_SIZE = 100

/** Maximum audit pages of one Milestone timeline. */
const ANALYTICS_MILESTONE_AUDIT_MAX_PAGES = 20

/** Maximum audit page queries across all Milestone timelines of one query. */
const ANALYTICS_MILESTONE_AUDIT_PAGE_QUERY_LIMIT = 500

/** Maximum audit events read across all Milestone timelines of one query. */
const ANALYTICS_MILESTONE_AUDIT_EVENT_LIMIT = 10_000

/** Time the audit entity index may lag behind a Planning write. */
const ANALYTICS_MILESTONE_AUDIT_LAG_MS = 5 * 60_000

/** Milestone timelines read at once. */
const ANALYTICS_MILESTONE_AUDIT_CONCURRENCY = 8

/** Attempts to read a Milestone history that covers the current Planning graph. */
const ANALYTICS_MILESTONE_READ_ATTEMPTS = 3

/** Scope recorded for an event whose scope metadata is malformed; it never matches a real scope. */
const ANALYTICS_MILESTONE_UNKNOWN_SCOPE = '\u0000unknown-scope'

/** Audit event type prefix of Planning entity changes. */
const PLANNING_ENTITY_AUDIT_EVENT_TYPE_PREFIX = 'planning-entity.'

/**
 * Reads the live Milestones of the Planning graph that the caller can read now.
 *
 * A legacy caller's graph is filtered with the current Planning ACL, the same rule as
 * `GET /api/planning`. Analytics routes authorize `work-items.read`, so an Enterprise caller's
 * scopes on the principal belong to that permission and are not used; `planning.read` is
 * evaluated at each Milestone's own Team, Project, or Workspace resource instead, and a missing
 * evaluation keeps none.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns The readable live Milestones.
 */
export async function readReadableAnalyticsMilestones(
  principal: WorkspacePrincipal,
): Promise<PlanningEntity[]> {
  // Only the entities are read; the Work Item state feeds progress, which the trend does not use.
  const planning = await workItemDependencies.planning.get(principal.directoryId, { workItems: [] })
  // The Enterprise scopes on the principal belong to `work-items.read`, so filtering with them
  // would intersect Planning access with unrelated Work Item grants; `planning.read` alone decides.
  const entities = principal.isSystemAdmin || principal.enterprisePermissions !== undefined
    ? planning.entities
    : filterPlanningSnapshotForPrincipal(await withPlanningLegacyReadScope(principal), planning)
      .entities
  return entities.filter((entity) =>
    entity.type === 'milestone' &&
    entity.archivedAt === undefined &&
    canReadPlanningScope(principal, entity)
  )
}

/**
 * Returns whether an Enterprise caller holds `planning.read` at a Planning entity's scope.
 *
 * Legacy callers are already bounded by their Project viewer access in the Planning filter.
 *
 * @param principal - Authenticated Workspace principal.
 * @param entity - Planning entity whose scope is checked.
 * @returns Whether the caller may read Planning records at the entity's scope.
 */
function canReadPlanningScope(
  principal: WorkspacePrincipal,
  entity: Pick<PlanningEntity, 'teamId' | 'projectId'>,
) {
  if (principal.isSystemAdmin || principal.enterprisePermissions === undefined) return true
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation === undefined) return false
  if (entity.projectId !== undefined && entity.teamId === undefined) return false
  const resource = entity.projectId !== undefined && entity.teamId !== undefined
    ? {
        workspaceId: principal.directoryId,
        kind: 'project' as const,
        targetId: entity.projectId,
        parentTeamId: entity.teamId,
      }
    : entity.teamId !== undefined
      ? { workspaceId: principal.directoryId, kind: 'team' as const, targetId: entity.teamId }
      : { workspaceId: principal.directoryId, kind: 'workspace' as const }
  return evaluateEnterpriseAccess({
    permission: 'planning.read',
    principal: evaluation.principal,
    assignments: evaluation.assignments,
    customRoles: evaluation.snapshot.customRoles,
    groupMappings: evaluation.groupMappings,
    resource,
  }).allowed
}

/**
 * Lists the live Milestones the caller can read now and the report filter keeps.
 *
 * Team and Project filters apply to the Milestone's current scope; a Workspace-scoped Milestone
 * is kept only when neither filter is set. Milestones created after `asOf` are left out, so the
 * snapshot and its later permission check see the same set.
 *
 * @param principal - Authenticated Workspace principal.
 * @param filter - Normalized report filter.
 * @param asOf - Query `asOf` instant.
 * @param readable - Readable Milestones already read for this request; read when omitted.
 * @returns The Milestones, ordered by ID.
 * @throws AnalyticsError 413 when more than {@link ANALYTICS_MILESTONE_LIMIT} Milestones match.
 */
export async function readVisibleAnalyticsMilestones(
  principal: WorkspacePrincipal,
  filter: AnalyticsFilter,
  asOf: string,
  readable?: Promise<PlanningEntity[]>,
): Promise<PlanningEntity[]> {
  const asOfTime = Date.parse(asOf)
  const candidates = await (readable ?? readReadableAnalyticsMilestones(principal))
  const teamIds = filter.teamIds === undefined ? undefined : new Set(filter.teamIds)
  const projectIds = filter.projectIds === undefined ? undefined : new Set(filter.projectIds)
  const milestones = candidates.filter((entity) => {
    const createdAt = Date.parse(entity.createdAt)
    if (Number.isNaN(createdAt) || createdAt > asOfTime) return false
    if (teamIds && (entity.teamId === undefined || !teamIds.has(entity.teamId))) return false
    if (projectIds && (entity.projectId === undefined || !projectIds.has(entity.projectId))) {
      return false
    }
    return true
  }).sort((left, right) => left.id.localeCompare(right.id))
  if (milestones.length > ANALYTICS_MILESTONE_LIMIT) {
    throw new AnalyticsError(
      413,
      'AnalyticsMilestoneLimitExceeded',
      `Milestone trend reads at most ${ANALYTICS_MILESTONE_LIMIT} Milestones. Narrow the report to fewer Teams or Projects.`,
    )
  }
  return milestones
}

/**
 * Reads the Milestones the caller can read now with their recorded date history.
 *
 * The history is the Milestone's own `planning-entity` audit timeline up to the later of the read
 * time and `asOf`, read after the Planning graph so the current state is never newer than it.
 * The audit entity index is eventually consistent, so each history must cover the Milestone's
 * latest write and current forecast end date; otherwise both reads are retried a bounded number
 * of times within one shared read budget, and the request fails closed with `503`.
 *
 * @param principal - Authenticated Workspace principal.
 * @param filter - Normalized report filter.
 * @param asOf - Query `asOf` instant.
 * @returns Milestone histories for the Analytics engine.
 * @throws AnalyticsError 413 when the Milestones or their history exceed the query limits, or
 *   503 when the history does not catch up with the Planning graph.
 */
export async function readAuthorizedAnalyticsMilestones(
  principal: WorkspacePrincipal,
  filter: AnalyticsFilter,
  asOf: string,
): Promise<AnalyticsMilestoneHistory[]> {
  // Retries share one read budget, so a query never reads more than the declared limits.
  const budget: MilestoneAuditReadBudget = { pageQueries: 0, events: 0 }
  for (let attempt = 0; attempt < ANALYTICS_MILESTONE_READ_ATTEMPTS; attempt += 1) {
    const milestones = await readVisibleAnalyticsMilestones(principal, filter, asOf)
    const readAt = Date.now()
    const historyReadAt = new Date(Math.max(readAt, Date.parse(asOf))).toISOString()
    const histories = await readMilestoneAuditHistories(
      principal.directoryId,
      milestones.map((milestone) => milestone.id),
      historyReadAt,
      budget,
    )
    const result = toMilestoneHistories(milestones, histories)
    if (result.every((milestone) => hasHistoryCoverage(milestone, readAt))) return result
  }
  throw new AnalyticsError(
    503,
    'AnalyticsReadBarrierUnavailable',
    'Milestone history changed while it was being read. Retry the request.',
  )
}

/**
 * Returns whether a Milestone's recorded history has caught up with its current state.
 *
 * Every own write of a Milestone records an event at its `updatedAt`, so a history whose latest
 * event is older than `updatedAt` is still behind, unless the write was an ancestor move, which
 * records no event of the Milestone. The audit index catches up within seconds, so a gap older
 * than {@link ANALYTICS_MILESTONE_AUDIT_LAG_MS} is taken as such a move. The latest recorded
 * forecast end date must also be the current one. A Milestone created before Planning audit has
 * no events and an old `updatedAt`; it is accepted, and the engine reports it with a warning.
 *
 * @param milestone - Milestone with its history.
 * @param readAt - Epoch milliseconds the history was read at.
 * @returns Whether the history covers the current state.
 */
function hasHistoryCoverage(milestone: AnalyticsMilestoneHistory, readAt: number) {
  const ordered = milestone.history
    .map((change) => ({ change, at: Date.parse(change.occurredAt) }))
    .sort((left, right) =>
      left.at - right.at || left.change.eventId.localeCompare(right.change.eventId)
    )
  const updatedAt = Date.parse(milestone.updatedAt)
  const latestAt = ordered.at(-1)?.at
  if (
    !Number.isNaN(updatedAt) &&
    (latestAt === undefined || latestAt < updatedAt) &&
    readAt - updatedAt < ANALYTICS_MILESTONE_AUDIT_LAG_MS
  ) {
    return false
  }
  const latestForecast = ordered.findLast((entry) =>
    entry.change.changes.some((fieldChange) => fieldChange.field === 'forecast.endDate')
  )?.change.changes.find((fieldChange) => fieldChange.field === 'forecast.endDate')
  return latestForecast === undefined || latestForecast.after === milestone.forecastEndDate
}

/** Audit reads one Milestone trend query has spent, shared across its retries. */
type MilestoneAuditReadBudget = {
  /** Audit page queries issued. */
  pageQueries: number
  /** Audit events read. */
  events: number
}

/**
 * Builds the engine input of each Milestone.
 *
 * @param milestones - Readable Milestones.
 * @param histories - Recorded changes keyed by Milestone ID.
 * @returns Milestone histories.
 */
function toMilestoneHistories(
  milestones: readonly PlanningEntity[],
  histories: ReadonlyMap<string, AnalyticsMilestoneChange[]>,
): AnalyticsMilestoneHistory[] {
  return milestones.map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    ...(milestone.teamId === undefined ? {} : { teamId: milestone.teamId }),
    ...(milestone.projectId === undefined ? {} : { projectId: milestone.projectId }),
    forecastEndDate: milestone.forecast.endDate,
    baselineEndDate: milestone.baseline.endDate,
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt,
    history: histories.get(milestone.id) ?? [],
  }))
}

/**
 * Reads the trend-relevant changes of each Milestone from its audit timeline.
 *
 * @param workspaceId - Workspace whose audit history is read.
 * @param entityIds - Milestone IDs.
 * @param historyReadAt - Inclusive upper bound of the history.
 * @param budget - Reads already spent by the query, updated in place.
 * @returns Changes of each Milestone, keyed by ID.
 * @throws AnalyticsError 413 when the page or event limits are exceeded.
 */
async function readMilestoneAuditHistories(
  workspaceId: string,
  entityIds: readonly string[],
  historyReadAt: string,
  budget: MilestoneAuditReadBudget,
) {
  const histories = new Map<string, AnalyticsMilestoneChange[]>()
  let nextIndex = 0
  let failure: unknown

  /** Reads the next assigned Milestone timeline. */
  const readNext = async () => {
    while (failure === undefined) {
      const entityId = entityIds[nextIndex]
      nextIndex += 1
      if (entityId === undefined) return
      try {
        const changes: AnalyticsMilestoneChange[] = []
        let cursor: string | undefined
        let pageCount = 0
        do {
          if (
            pageCount >= ANALYTICS_MILESTONE_AUDIT_MAX_PAGES ||
            budget.pageQueries >= ANALYTICS_MILESTONE_AUDIT_PAGE_QUERY_LIMIT
          ) {
            throw createMilestoneHistoryLimitError()
          }
          // Reserve the page's events before the read, so parallel reads never pass the limit.
          const reserved = Math.min(
            ANALYTICS_MILESTONE_AUDIT_PAGE_SIZE,
            ANALYTICS_MILESTONE_AUDIT_EVENT_LIMIT - budget.events,
          )
          if (reserved <= 0) throw createMilestoneHistoryLimitError()
          budget.pageQueries += 1
          budget.events += reserved
          pageCount += 1
          const page = await workspaceDependencies.auditEvents.query({
            workspaceId,
            entityType: PLANNING_ENTITY_AUDIT_ENTITY_TYPE,
            entityId,
            to: historyReadAt,
            limit: reserved,
            cursor,
            direction: 'ascending',
          })
          if (page.events.length > reserved) throw createMilestoneHistoryLimitError()
          budget.events -= reserved - page.events.length
          for (const event of page.events) {
            const change = toMilestoneChange(event, entityId)
            if (change) changes.push(change)
          }
          cursor = page.nextCursor
        } while (cursor)
        histories.set(entityId, changes)
      } catch (error) {
        failure ??= error
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(ANALYTICS_MILESTONE_AUDIT_CONCURRENCY, entityIds.length) },
    readNext,
  ))
  if (failure !== undefined) throw failure
  return histories
}

/**
 * Reduces one audit event to the Milestone fields the trend reads.
 *
 * @param event - Audit event from the entity timeline.
 * @param entityId - Milestone ID the timeline was queried for.
 * @returns The change with the scope the event recorded, or `undefined` when the event is not
 *   this entity's Planning change.
 */
function toMilestoneChange(
  event: AuditEventV1,
  entityId: string,
): AnalyticsMilestoneChange | undefined {
  if (
    event.entityType !== PLANNING_ENTITY_AUDIT_ENTITY_TYPE ||
    event.entity.type !== PLANNING_ENTITY_AUDIT_ENTITY_TYPE ||
    event.entityId !== entityId ||
    event.entity.id !== entityId ||
    !event.eventType.startsWith(PLANNING_ENTITY_AUDIT_EVENT_TYPE_PREFIX)
  ) {
    return undefined
  }
  const changes = event.changes.flatMap((change): AnalyticsMilestoneFieldChange[] => {
    const field = ANALYTICS_MILESTONE_TREND_FIELDS.find((candidate) => candidate === change.field)
    if (field === undefined || change.redacted === true) return []
    const before = readText(change.before)
    const after = readText(change.after)
    return [{
      field,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    }]
  })
  // Each event records the scope the Milestone had when it was written. An ancestor move changes
  // that scope without an event of the Milestone, so the recorded scope of every event is kept,
  // and dates written while the Milestone sat in another scope stay hidden after it returns.
  const scopes = readPlanningEntityAuditScopes(event)
  const scope = scopes?.[0]
  for (const field of ['teamId', 'projectId'] as const) {
    if (changes.some((change) => change.field === field)) continue
    const value = scope === undefined ? ANALYTICS_MILESTONE_UNKNOWN_SCOPE : scope[field]
    changes.push(value === undefined ? { field } : { field, before: value, after: value })
  }
  return { eventId: event.eventId, occurredAt: event.occurredAt, changes }
}

/**
 * Returns an audit value when it is text.
 *
 * @param value - Audit value.
 * @returns The text, or `undefined`.
 */
function readText(value: AuditValue | undefined) {
  return typeof value === 'string' ? value : undefined
}

/**
 * Creates the error returned when Milestone history exceeds the safe query limit.
 *
 * @returns The 413 error.
 */
function createMilestoneHistoryLimitError() {
  return new AnalyticsError(
    413,
    'AnalyticsHistoryLimitExceeded',
    'Milestone history exceeds the safe query limit. Narrow the report scope.',
  )
}
