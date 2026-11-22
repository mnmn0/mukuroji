import type { PlanningEntityActivityEvent } from '../api/entities'

/** Lifecycle change a Planning entity activity row describes. */
export type PlanningEntityActivityKind =
  | 'created'
  | 'duplicated'
  | 'updated'
  | 'moved'
  | 'archived'
  | 'restored'
  | 'other'

/** One side of a field change, ready to be formatted. */
export type PlanningEntityActivityValue =
  | {
    /** The field had no value on this side. */
    kind: 'empty'
  }
  | {
    /** The value names something the reader cannot see. */
    kind: 'redacted'
  }
  | {
    /** The recorded value. */
    kind: 'value'
    /** Recorded JSON value. */
    value: unknown
  }

/** One field change shown under an activity row. */
export type PlanningEntityActivityChangeView = {
  /** Dot-separated field path, such as `forecast.endDate`. */
  field: string
  /** Value before the change. */
  before: PlanningEntityActivityValue
  /** Value after the change. */
  after: PlanningEntityActivityValue
}

/** Who made an activity row's change. */
export type PlanningEntityActivityActor =
  | {
    /** A Workspace member. */
    kind: 'member'
    /** Workspace member key recorded with the change. */
    memberKey: string
  }
  | {
    /** A system process, service, or a change with no recorded member. */
    kind: 'system'
  }

/** One row of the Planning entity activity tab. */
export type PlanningEntityActivityRow = {
  /** Audit event ID, unique in the list. */
  eventId: string
  /** Lifecycle change of the row. */
  kind: PlanningEntityActivityKind
  /** ISO 8601 timestamp of the change. */
  occurredAt: string
  /** Who made the change. */
  actor: PlanningEntityActivityActor
  /** Server summary, used for an event kind the Web does not know. */
  summary?: string
  /** Field changes worth showing; empty for creation, archive and restore. */
  changes: PlanningEntityActivityChangeView[]
}

/** Kinds whose field changes are listed; creation lists every field, which is not a change. */
const kindsWithChanges = new Set<PlanningEntityActivityKind>(['updated', 'moved'])

/**
 * Fields the server derives from other data or that never change by themselves.
 * Listing them would repeat what the other changes or the row itself already say.
 */
const hiddenChangeFields = new Set([
  'id',
  'type',
  'progress',
  'rollupHealth',
  'linkedWorkItemCount',
  'archivedAt',
])

/** Display order of known fields; other fields follow in alphabetical order. */
const changeFieldOrder = [
  'title',
  'description',
  'ownerMemberKey',
  'status',
  'health',
  'risk',
  'progressMode',
  'manualProgress',
  'baseline.startDate',
  'baseline.endDate',
  'forecast.startDate',
  'forecast.endDate',
  'parentId',
  'teamId',
  'projectId',
  'cadence.count',
  'cadence.unit',
  'capacity',
  'carryOverPolicy',
  'automation.createNext',
  'automation.rolloverAtEnd',
  'nextCycleId',
  'goalFramework',
]

/** Marker the audit log stores in place of a value the reader may not see. */
const redactedValue = '[REDACTED]'

/**
 * Builds the rows of the activity tab from the activity events, newest first as the API returns them.
 *
 * @param events - Activity events of one Planning entity.
 * @returns One row per event, with the field changes worth showing.
 */
export function createPlanningEntityActivityRows(
  events: readonly PlanningEntityActivityEvent[],
): PlanningEntityActivityRow[] {
  const seen = new Set<string>()
  const rows: PlanningEntityActivityRow[] = []
  for (const event of events) {
    // A page boundary can repeat an event when new activity arrives while paging.
    if (seen.has(event.eventId)) continue
    seen.add(event.eventId)
    const kind = readActivityKind(event.action)
    rows.push({
      eventId: event.eventId,
      kind,
      occurredAt: event.occurredAt,
      actor: event.actor.kind === 'user' && event.actor.displayName
        ? { kind: 'member', memberKey: event.actor.displayName }
        : { kind: 'system' },
      ...(event.summary === undefined ? {} : { summary: event.summary }),
      changes: kindsWithChanges.has(kind) ? createChangeViews(event) : [],
    })
  }
  return rows
}

/**
 * Narrows an event action to a known activity kind.
 *
 * @param action - Action recorded by the event.
 * @returns The known kind, or `other`.
 */
function readActivityKind(action: string): PlanningEntityActivityKind {
  switch (action) {
    case 'created':
    case 'duplicated':
    case 'updated':
    case 'moved':
    case 'archived':
    case 'restored':
      return action
    default:
      return 'other'
  }
}

/**
 * Lists the shown field changes of one event in display order.
 *
 * @param event - Activity event with field changes.
 * @returns The visible changes.
 */
function createChangeViews(event: PlanningEntityActivityEvent): PlanningEntityActivityChangeView[] {
  return event.changes
    .filter((change) => !hiddenChangeFields.has(change.field))
    .map((change) => ({
      field: change.field,
      before: readActivityValue('before' in change, change.before),
      after: readActivityValue('after' in change, change.after),
    }))
    .sort((left, right) => compareChangeFields(left.field, right.field))
}

/**
 * Reads one side of a field change.
 *
 * @param present - Whether the change recorded this side.
 * @param value - Recorded value.
 * @returns The value, or the empty or redacted marker.
 */
function readActivityValue(present: boolean, value: unknown): PlanningEntityActivityValue {
  if (!present || value === undefined || value === null || value === '') return { kind: 'empty' }
  if (value === redactedValue) return { kind: 'redacted' }
  return { kind: 'value', value }
}

/**
 * Orders field paths by the display order, then alphabetically.
 *
 * @param left - First field path.
 * @param right - Second field path.
 * @returns A negative number when `left` comes first.
 */
function compareChangeFields(left: string, right: string) {
  const leftIndex = changeFieldOrder.indexOf(left)
  const rightIndex = changeFieldOrder.indexOf(right)
  if (leftIndex !== rightIndex) {
    if (leftIndex === -1) return 1
    if (rightIndex === -1) return -1
    return leftIndex - rightIndex
  }
  return left.localeCompare(right)
}
