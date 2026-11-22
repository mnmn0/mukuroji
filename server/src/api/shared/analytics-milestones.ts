import type { AnalyticsFilter, PlanningEntity } from '@mukuroji/contracts'
import {
  ANALYTICS_MILESTONE_TREND_FIELDS,
  AnalyticsError,
  type AnalyticsMilestoneChange,
  type AnalyticsMilestoneFieldChange,
  type AnalyticsMilestoneHistory,
} from '../../modules/analytics'
import type { AuditEventV1, AuditValue } from '../../modules/audit/audit'
import { workItemDependencies, workspaceDependencies } from './app-dependencies'
import { filterPlanningSnapshotForPrincipal, withPlanningLegacyReadScope } from './planning-access'
import { PLANNING_ENTITY_AUDIT_ENTITY_TYPE } from './planning-entity-audit'
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

/** Milestone timelines read at once. */
const ANALYTICS_MILESTONE_AUDIT_CONCURRENCY = 8

/** Audit event type prefix of Planning entity changes. */
const PLANNING_ENTITY_AUDIT_EVENT_TYPE_PREFIX = 'planning-entity.'

/**
 * Reads the live Milestones of the Planning graph that the caller can read now.
 *
 * The graph is filtered with the caller's current Planning ACL, the same rule as
 * `GET /api/planning`.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns The readable live Milestones.
 */
export async function readReadableAnalyticsMilestones(
  principal: WorkspacePrincipal,
): Promise<PlanningEntity[]> {
  // Only the entities are read; the Work Item state feeds progress, which the trend does not use.
  const snapshot = filterPlanningSnapshotForPrincipal(
    await withPlanningLegacyReadScope(principal),
    await workItemDependencies.planning.get(principal.directoryId, { workItems: [] }),
  )
  return snapshot.entities.filter((entity) =>
    entity.type === 'milestone' && entity.archivedAt === undefined
  )
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
 *
 * @param principal - Authenticated Workspace principal.
 * @param filter - Normalized report filter.
 * @param asOf - Query `asOf` instant.
 * @returns Milestone histories for the Analytics engine.
 * @throws AnalyticsError 413 when the Milestones or their history exceed the query limits.
 */
export async function readAuthorizedAnalyticsMilestones(
  principal: WorkspacePrincipal,
  filter: AnalyticsFilter,
  asOf: string,
): Promise<AnalyticsMilestoneHistory[]> {
  const milestones = await readVisibleAnalyticsMilestones(principal, filter, asOf)
  const historyReadAt = new Date(Math.max(Date.now(), Date.parse(asOf))).toISOString()
  const histories = await readMilestoneAuditHistories(
    principal.directoryId,
    milestones.map((milestone) => milestone.id),
    historyReadAt,
  )
  return milestones.map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    ...(milestone.teamId === undefined ? {} : { teamId: milestone.teamId }),
    ...(milestone.projectId === undefined ? {} : { projectId: milestone.projectId }),
    forecastEndDate: milestone.forecast.endDate,
    baselineEndDate: milestone.baseline.endDate,
    createdAt: milestone.createdAt,
    history: histories.get(milestone.id) ?? [],
  }))
}

/**
 * Reads the trend-relevant changes of each Milestone from its audit timeline.
 *
 * @param workspaceId - Workspace whose audit history is read.
 * @param entityIds - Milestone IDs.
 * @param historyReadAt - Inclusive upper bound of the history.
 * @returns Changes of each Milestone, keyed by ID.
 * @throws AnalyticsError 413 when the page or event limits are exceeded.
 */
async function readMilestoneAuditHistories(
  workspaceId: string,
  entityIds: readonly string[],
  historyReadAt: string,
) {
  const histories = new Map<string, AnalyticsMilestoneChange[]>()
  let nextIndex = 0
  let pageQueryCount = 0
  let eventCount = 0
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
            pageQueryCount >= ANALYTICS_MILESTONE_AUDIT_PAGE_QUERY_LIMIT
          ) {
            throw createMilestoneHistoryLimitError()
          }
          pageQueryCount += 1
          pageCount += 1
          const page = await workspaceDependencies.auditEvents.query({
            workspaceId,
            entityType: PLANNING_ENTITY_AUDIT_ENTITY_TYPE,
            entityId,
            to: historyReadAt,
            limit: ANALYTICS_MILESTONE_AUDIT_PAGE_SIZE,
            cursor,
            direction: 'ascending',
          })
          eventCount += page.events.length
          if (eventCount > ANALYTICS_MILESTONE_AUDIT_EVENT_LIMIT) {
            throw createMilestoneHistoryLimitError()
          }
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
 * @returns The change, or `undefined` when the event is not this entity's Planning change or
 *   changes none of the read fields.
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
  return changes.length === 0
    ? undefined
    : { eventId: event.eventId, occurredAt: event.occurredAt, changes }
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
