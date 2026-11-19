/** Outcome of a Team Issue update that the person declined before it was sent. */
export type CancelledTeamIssueUpdate = {
  /** Always `true`; nothing was saved. */
  readonly cancelled: true
}

/** The one cancelled outcome, returned when the person declines an update. */
export const CANCELLED_TEAM_ISSUE_UPDATE: CancelledTeamIssueUpdate = Object.freeze({ cancelled: true })

/**
 * Tells whether an update outcome means the person declined it, so nothing was saved.
 *
 * @param outcome - Value an update callback resolved with.
 * @returns Whether the update was cancelled.
 */
export function isCancelledTeamIssueUpdate(outcome: unknown): outcome is CancelledTeamIssueUpdate {
  return typeof outcome === 'object' && outcome !== null && 'cancelled' in outcome && outcome.cancelled === true
}
