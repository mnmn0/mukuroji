import type { MyTimesheetSubmitEntry, MyTimesheetSubmitResult, MyTimesheetSubmitTeamResult } from '@mukuroji/contracts'

/** Ports the cross-Team timesheet submission uses. */
export type SubmitMyTimesheetPorts = {
  /**
   * Submits named entries of one Team at the revisions given.
   *
   * @param teamId - Team the entries are stored in.
   * @param entries - Entries of that Team to submit.
   * @returns Submitted count and the entries that could not be submitted.
   */
  submitTeamEntries: (
    teamId: string,
    entries: readonly MyTimesheetSubmitEntry[],
  ) => Promise<{ count: number; failedEntryIds: string[] }>
}

/** Input of the cross-Team timesheet submission. */
export type SubmitMyTimesheetInput = {
  /** Entries the member named, already validated and without duplicates. */
  entries: readonly MyTimesheetSubmitEntry[]
  /** Teams where the member may submit time. */
  permittedTeamIds: ReadonlySet<string>
}

/**
 * Submits the member's named entries Team by Team and combines the outcome.
 *
 * Teams are processed in the order they first appear. An entry in a Team the member cannot submit
 * to fails without a request. A Team that cannot be processed at all, for example after the member
 * lost access to one of its Projects, reports every entry it was sent as failed and does not stop
 * the other Teams.
 *
 * @param ports - Per-Team submission.
 * @param input - Named entries and the Teams the member may submit to.
 * @returns Totals, failed entries, and per-Team results.
 */
export async function submitMyTimesheet(
  ports: SubmitMyTimesheetPorts,
  input: SubmitMyTimesheetInput,
): Promise<MyTimesheetSubmitResult> {
  const teams: MyTimesheetSubmitTeamResult[] = []
  for (const teamId of new Set(input.entries.map((entry) => entry.teamId))) {
    const entries = input.entries.filter((entry) => entry.teamId === teamId)
    const allFailed = { teamId, count: 0, failedEntryIds: entries.map((entry) => entry.entryId), failed: true }
    if (!input.permittedTeamIds.has(teamId)) {
      teams.push(allFailed)
      continue
    }
    try {
      const { count, failedEntryIds } = await ports.submitTeamEntries(teamId, entries)
      teams.push({ teamId, count, failedEntryIds })
    } catch {
      teams.push(allFailed)
    }
  }
  const failedEntryIds = teams.flatMap((team) => team.failedEntryIds)
  return {
    count: teams.reduce((total, team) => total + team.count, 0),
    failedEntryIds,
    partialFailure: failedEntryIds.length > 0 || teams.some((team) => team.failed === true),
    teams,
  }
}
