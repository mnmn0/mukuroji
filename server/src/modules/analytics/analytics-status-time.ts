import { NO_WORK_PHASE_GROUP_KEY } from '@mukuroji/contracts'
import { normalizeAnalyticsFieldPath, type AnalyticsHistoryEvent } from './analytics-work-item-history'

/** Milliseconds in one hour. */
const MILLISECONDS_PER_HOUR = 3_600_000

/**
 * Status categories whose time `status-time` counts: work that waits to start or is in progress.
 * Backlog, completed, and canceled time is left out, so a parked or finished Work Item does not
 * pile up hours.
 */
export const ANALYTICS_STATUS_TIME_CATEGORIES: ReadonlySet<string> = new Set(['unstarted', 'started'])

/** Warning of a `status-time` widget grouped by phase when the run cannot read the workflows. */
export const ANALYTICS_WORKFLOW_STATUSES_UNAVAILABLE_WARNING = 'Workflow statuses are not available for this run.'

/** One stretch of time a Work Item spent in one workflow status. */
export type AnalyticsStatusSegment = {
  /** Workflow status ID; empty when the history does not say which status it was. */
  statusId: string
  /** Status category during the stretch. */
  statusCategory: string
  /** Start in epoch milliseconds, inclusive. */
  from: number
  /** End in epoch milliseconds, exclusive. */
  to: number
}

/** Name and work phase of one workflow status, keyed by status ID within a Team. */
export type AnalyticsWorkflowStatusEntry = {
  /** Status display name. */
  name: string
  /** Work phase key (ADR 0115); absent when the status has none. */
  phaseKey?: string
}

/**
 * Workflow statuses of the Teams in a query, with the names the Workspace gave its phases. The API
 * reads them for queries with a `status-time` widget.
 */
export type AnalyticsWorkflowStatusCatalog = {
  /** Statuses keyed by Team ID, then status ID. */
  teams: ReadonlyMap<string, ReadonlyMap<string, AnalyticsWorkflowStatusEntry>>
  /** Workspace names of phases, keyed by phase key; a built-in phase without a name is absent. */
  phaseLabels: ReadonlyMap<string, string>
}

/** Current status ID and category while walking a Work Item's history backwards. */
type StatusCursor = {
  /** Workflow status ID, or empty when unknown. */
  statusId: string
  /** Status category. */
  statusCategory: string
}

/**
 * Reads the status change of one history event.
 *
 * @param event - History event.
 * @returns The status ID and category before and after, for the fields the event changed; undefined
 *   when the event changed neither or redacted them.
 */
function readStatusChange(event: AnalyticsHistoryEvent): {
  before: Partial<StatusCursor>
  after: Partial<StatusCursor>
} | undefined {
  const before: Partial<StatusCursor> = {}
  const after: Partial<StatusCursor> = {}
  let changed = false
  for (const change of event.changes) {
    if (change.redacted) continue
    const field = normalizeAnalyticsFieldPath(change.field)
    const key = field === 'workflowStatusId' ? 'statusId' : field === 'statusCategory' ? 'statusCategory' : undefined
    if (key === undefined) continue
    changed = true
    before[key] = typeof change.before === 'string' ? change.before : ''
    after[key] = typeof change.after === 'string' ? change.after : ''
  }
  return changed ? { before, after } : undefined
}

/**
 * Rebuilds the stretches of time a Work Item spent in each workflow status, from its creation until
 * `asOf`. It walks the status changes backwards from the state at `asOf`, so a Work Item without
 * changes after the period start needs no history at all.
 *
 * @param input - Work Item facts.
 * @param input.createdAt - Creation instant in epoch milliseconds.
 * @param input.statusId - Workflow status at `asOf`.
 * @param input.statusCategory - Status category at `asOf`.
 * @param input.events - Every history event of the Work Item, in any order.
 * @param input.asOf - Evaluation instant in epoch milliseconds.
 * @returns Stretches in time order; zero-length stretches are left out.
 */
export function createAnalyticsStatusSegments(input: {
  createdAt: number
  statusId: string
  statusCategory: string
  events: readonly AnalyticsHistoryEvent[]
  asOf: number
}): AnalyticsStatusSegment[] {
  const changes = input.events
    .map((event) => ({ occurredAt: Date.parse(event.occurredAt), eventId: event.eventId, change: readStatusChange(event) }))
    .filter((entry) =>
      entry.change !== undefined && Number.isFinite(entry.occurredAt) &&
      entry.occurredAt <= input.asOf && entry.occurredAt > input.createdAt
    )
    .sort((left, right) => right.occurredAt - left.occurredAt || right.eventId.localeCompare(left.eventId))
  const segments: AnalyticsStatusSegment[] = []
  let cursor: StatusCursor = { statusId: input.statusId, statusCategory: input.statusCategory }
  let boundary = input.asOf
  for (const { occurredAt, change } of changes) {
    if (change === undefined) continue
    if (occurredAt < boundary) segments.push({ ...cursor, from: occurredAt, to: boundary })
    boundary = Math.min(boundary, occurredAt)
    cursor = {
      statusId: change.before.statusId ?? cursor.statusId,
      statusCategory: change.before.statusCategory ?? cursor.statusCategory,
    }
  }
  if (input.createdAt < boundary) segments.push({ ...cursor, from: input.createdAt, to: boundary })
  return segments.reverse()
}

/**
 * Adds up the hours of counted stretches that overlap a window.
 *
 * @param segments - Stretches of one or more Work Items.
 * @param from - Window start in epoch milliseconds, inclusive.
 * @param to - Window end in epoch milliseconds, exclusive.
 * @returns Hours in `unstarted` and `started` statuses within the window.
 */
export function sumAnalyticsStatusHours(
  segments: readonly AnalyticsStatusSegment[],
  from: number,
  to: number,
): number {
  let milliseconds = 0
  for (const segment of segments) {
    if (!ANALYTICS_STATUS_TIME_CATEGORIES.has(segment.statusCategory)) continue
    milliseconds += Math.max(0, Math.min(segment.to, to) - Math.max(segment.from, from))
  }
  return milliseconds / MILLISECONDS_PER_HOUR
}

/** Hours of one status or phase group. */
export type AnalyticsStatusTimeGroup = {
  /** Status ID or phase key. */
  key: string
  /** Status name or phase label. */
  label: string
  /** Hours within the window. */
  hours: number
  /** Number of Work Items with time in the group. */
  workItemCount: number
}

/**
 * Splits counted hours by the workflow status or the work phase they were spent in.
 *
 * @param items - Stretches of each Work Item with its Team.
 * @param dimension - `status` groups by status ID, `phase` by the phase of the status.
 * @param catalog - Workflow statuses of the Teams; without it, statuses are labelled by ID.
 * @param from - Window start in epoch milliseconds, inclusive.
 * @param to - Window end in epoch milliseconds, exclusive.
 * @returns Groups with time, by key.
 */
export function groupAnalyticsStatusHours(
  items: readonly { teamId: string; segments: readonly AnalyticsStatusSegment[] }[],
  dimension: 'status' | 'phase',
  catalog: AnalyticsWorkflowStatusCatalog | undefined,
  from: number,
  to: number,
): AnalyticsStatusTimeGroup[] {
  const groups = new Map<string, { label: string; hours: number; workItems: number }>()
  for (const item of items) {
    const statuses = catalog?.teams.get(item.teamId)
    const perItem = new Map<string, { label: string; hours: number }>()
    for (const segment of item.segments) {
      const hours = sumAnalyticsStatusHours([segment], from, to)
      if (hours <= 0) continue
      const entry = statuses?.get(segment.statusId)
      const key = dimension === 'status'
        ? segment.statusId
        : entry?.phaseKey ?? NO_WORK_PHASE_GROUP_KEY
      const label = dimension === 'status'
        ? entry?.name ?? segment.statusId
        : catalog?.phaseLabels.get(key) ?? key
      const current = perItem.get(key) ?? { label, hours: 0 }
      current.hours += hours
      perItem.set(key, current)
    }
    for (const [key, value] of perItem) {
      const group = groups.get(key) ?? { label: value.label, hours: 0, workItems: 0 }
      group.hours += value.hours
      group.workItems += 1
      groups.set(key, group)
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => ({ key, label: group.label, hours: group.hours, workItemCount: group.workItems }))
}
