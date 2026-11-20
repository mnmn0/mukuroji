/** Outcome of a finished Team reminder settings save. */
export type TeamReminderSaveResult = 'saved' | 'conflict' | 'error'

/** Save state of one Team's reminder settings. */
export type TeamReminderSaveEntry = {
  /** Whether a save for this Team is running. */
  isSaving: boolean
  /** Outcome of the Team's last finished save. */
  result?: TeamReminderSaveResult
  /** Error of the Team's last failed save. */
  error?: unknown
}

/** Save state per Team ID, so a save that finishes after navigation stays with its own Team. */
export type TeamReminderSaveStates = Readonly<Record<string, TeamReminderSaveEntry>>

/**
 * Marks a Team's save as started and clears its previous outcome.
 *
 * @param states - Current save states.
 * @param teamId - Team being saved.
 * @returns Updated save states; other Teams are unchanged.
 */
export function startTeamReminderSave(states: TeamReminderSaveStates, teamId: string): TeamReminderSaveStates {
  return { ...states, [teamId]: { isSaving: true } }
}

/**
 * Records a Team's finished save.
 *
 * @param states - Current save states.
 * @param teamId - Team that was saved.
 * @param result - Outcome of the save.
 * @param error - Error of a failed save.
 * @returns Updated save states; other Teams are unchanged.
 */
export function finishTeamReminderSave(
  states: TeamReminderSaveStates,
  teamId: string,
  result: TeamReminderSaveResult,
  error?: unknown,
): TeamReminderSaveStates {
  return { ...states, [teamId]: { isSaving: false, result, ...(error === undefined ? {} : { error }) } }
}

/**
 * Reads the save state of the Team on screen.
 *
 * @param states - Current save states.
 * @param teamId - Team on screen, or undefined while the route resolves.
 * @returns That Team's state; idle when it has none.
 */
export function readTeamReminderSave(
  states: TeamReminderSaveStates,
  teamId: string | undefined,
): TeamReminderSaveEntry {
  return (teamId === undefined ? undefined : states[teamId]) ?? { isSaving: false }
}

/**
 * Lists every Team's save error for the expired-session check.
 *
 * An expired session affects the whole Workspace, so a save that failed for another Team still
 * reports it.
 *
 * @param states - Current save states.
 * @returns Save errors of all Teams.
 */
export function listTeamReminderSaveErrors(states: TeamReminderSaveStates): unknown[] {
  return Object.values(states).flatMap((entry) => entry.error === undefined ? [] : [entry.error])
}
