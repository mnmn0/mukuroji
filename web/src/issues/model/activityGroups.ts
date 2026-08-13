import type { TeamIssueActivityEvent } from '../api'

/**
 * One user-visible activity entry that remains outside a collapsed system group.
 */
export type IssueActivityEntry = {
  /** Stable entry discriminator. */
  kind: 'event'
  /** Activity event rendered by the entry. */
  event: TeamIssueActivityEvent
}

/**
 * Consecutive system changes collapsed into one disclosure row.
 */
export type IssueSystemActivityGroup = {
  /** Stable group discriminator. */
  kind: 'system-group'
  /** Stable ID derived from the first event in the group. */
  id: string
  /** Consecutive system events represented by the group. */
  events: TeamIssueActivityEvent[]
}

/**
 * One renderable activity ledger item.
 */
export type IssueActivityGroup = IssueActivityEntry | IssueSystemActivityGroup

/**
 * Groups consecutive system changes while preserving every user event as a distinct row.
 *
 * The complete loaded event array is regrouped on every page merge, so matching system changes
 * at an opaque cursor boundary collapse into the same disclosure.
 *
 * @param events - Activity events in their server-provided ledger order.
 * @returns Renderable activity rows and consecutive system groups.
 */
export function groupIssueActivity(
  events: readonly TeamIssueActivityEvent[],
): IssueActivityGroup[] {
  const groups: IssueActivityGroup[] = []

  for (const event of events) {
    if (!isSystemActivityEvent(event)) {
      groups.push({ event, kind: 'event' })
      continue
    }

    const previous = groups.at(-1)

    if (previous?.kind === 'system-group') {
      previous.events.push(event)
      continue
    }

    groups.push({
      events: [event],
      id: createSystemGroupId([event]),
      kind: 'system-group',
    })
  }

  return groups
}

/**
 * Determines whether an activity event is a mechanical Work Item change.
 *
 * @param event - Candidate activity event.
 * @returns Whether the event should be eligible for consecutive grouping.
 */
export function isSystemActivityEvent(event: TeamIssueActivityEvent): boolean {
  const actor = event.actorUserId.toLowerCase()
  const metadata = event.metadata
  const explicitlySystem =
    metadata?.actorKind === 'system' || metadata?.systemChange === true

  return (
    explicitlySystem ||
    actor === 'system' ||
    actor.startsWith('system:')
  )
}

/**
 * Creates a stable disclosure ID from the first event ID.
 *
 * @param events - Non-empty consecutive system events.
 * @returns Stable DOM-safe group identifier.
 */
function createSystemGroupId(events: readonly TeamIssueActivityEvent[]): string {
  const first = events[0]
  return `system-${first?.eventId ?? 'unknown'}`
}
