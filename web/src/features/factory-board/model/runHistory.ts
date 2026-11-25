import type { AgentRunHistoryEntry, AgentRunOutcome, AgentRunRuntime, TeamAgentRunHistoryResponse } from '@mukuroji/contracts'
import { escapeSpreadsheetCell } from '../../../shared/lib/spreadsheetCell'

/** Periods the Run history offers, in days. */
export const RUN_HISTORY_PERIOD_DAYS = [1, 7, 30, 90] as const

/** One offered Run history period. */
export type RunHistoryPeriodDays = (typeof RUN_HISTORY_PERIOD_DAYS)[number]

/** Period the Run history opens with. */
export const DEFAULT_RUN_HISTORY_PERIOD_DAYS: RunHistoryPeriodDays = 7

/** One row of the Run history across Teams. */
export type RunHistoryRow = AgentRunHistoryEntry & {
  /** Display name of the run's Team. */
  teamName: string
}

/** Runs of every requested Team, merged. */
export type RunHistory = {
  /** Runs, newest finish first. */
  rows: RunHistoryRow[]
  /** True when any Team left runs of the period out. */
  hasMore: boolean
}

/**
 * Builds the key of a Project inside its Team. Project IDs are unique only within a Team, so names and
 * filter choices are keyed by both IDs.
 *
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns Team-qualified Project key.
 */
export function runHistoryProjectKey(teamId: string, projectId: string): string {
  return JSON.stringify([teamId, projectId])
}

/**
 * Looks up the display name of a row's Project.
 *
 * @param row - Run history row.
 * @param projectNames - Project names by Team-qualified key.
 * @returns The name, the raw ID for an unknown Project, or empty text when the run has no Project.
 */
export function runHistoryProjectName(row: RunHistoryRow, projectNames: Readonly<Record<string, string>>): string {
  if (row.projectId === undefined) return ''
  return projectNames[runHistoryProjectKey(row.teamId, row.projectId)] ?? row.projectId
}

/** Column headings and value names the CSV uses. */
export type RunHistoryCsvLabels = {
  /** Column headings, in column order. */
  headings: {
    /** Finish time. */
    finishedAt: string
    /** Team. */
    team: string
    /** Work Item title. */
    workItem: string
    /** Work Item ID. */
    workItemId: string
    /** Project. */
    project: string
    /** Responsible member. */
    assignee: string
    /** Agent name. */
    agentName: string
    /** Runtime. */
    runtime: string
    /** Outcome. */
    outcome: string
    /** Start time. */
    startedAt: string
    /** Duration in minutes. */
    durationMinutes: string
    /** Run ID. */
    runId: string
  }
  /** Display names of outcomes. */
  outcomes: Record<AgentRunOutcome, string>
  /** Display names of runtimes. */
  runtimes: Record<AgentRunRuntime, string>
}

/**
 * Creates the UTC bounds of a period that ends now.
 *
 * @param days - Length of the period.
 * @param now - End of the period.
 * @returns ISO 8601 bounds, both inclusive.
 */
export function createRunHistoryPeriod(days: RunHistoryPeriodDays, now: Date): { from: string; to: string } {
  return { from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: now.toISOString() }
}

/**
 * Reads an offered period from a query value.
 *
 * @param value - Raw value.
 * @returns The period, or undefined when it is not offered.
 */
export function readRunHistoryPeriodDays(value: string | null): RunHistoryPeriodDays | undefined {
  return RUN_HISTORY_PERIOD_DAYS.find((days) => String(days) === value)
}

/**
 * Merges the histories of several Teams, newest finish first.
 *
 * @param histories - One response per Team.
 * @param teamNames - Display names by Team ID; the ID is shown for an unknown Team.
 * @returns Merged rows and whether any Team left runs out.
 */
export function mergeRunHistories(histories: readonly TeamAgentRunHistoryResponse[], teamNames: Readonly<Record<string, string>>): RunHistory {
  const rows = histories.flatMap((history) => history.runs.map((run) => ({ ...run, teamName: teamNames[history.teamId] ?? history.teamId })))
  rows.sort((left, right) => (right.finishedAt ?? '').localeCompare(left.finishedAt ?? '') || left.runId.localeCompare(right.runId))
  return { rows, hasMore: histories.some((history) => history.hasMore) }
}

/**
 * Minutes from start to finish of a run, rounded to one decimal.
 *
 * @param run - Finished run.
 * @returns Duration, or undefined when the run has no valid finish time.
 */
export function runDurationMinutes(run: Pick<AgentRunHistoryEntry, 'startedAt' | 'finishedAt'>): number | undefined {
  if (run.finishedAt === undefined) return undefined
  const milliseconds = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.round(milliseconds / 6_000) / 10 : undefined
}

/**
 * Quotes one CSV cell after escaping a leading formula character for spreadsheets.
 *
 * @param value - Cell text.
 * @returns The quoted cell.
 */
function toCsvCell(value: string): string {
  return `"${escapeSpreadsheetCell(value).replaceAll('"', '""')}"`
}

/**
 * Writes the Run history as CSV. Every cell is quoted and a leading formula character is escaped, so
 * a Work Item title cannot run as a spreadsheet formula.
 *
 * @param rows - Rows in display order.
 * @param labels - Headings and value names.
 * @param projectNames - Project names by Team-qualified key; the ID is written for an unknown Project.
 * @param memberNames - Member names by ID; the ID is written for an unknown member.
 * @returns CSV text with CRLF line endings.
 */
export function toRunHistoryCsv(
  rows: readonly RunHistoryRow[],
  labels: RunHistoryCsvLabels,
  projectNames: Readonly<Record<string, string>>,
  memberNames: Readonly<Record<string, string>>,
): string {
  const { headings } = labels
  const header = [
    headings.finishedAt, headings.team, headings.workItem, headings.workItemId, headings.project, headings.assignee,
    headings.agentName, headings.runtime, headings.outcome, headings.startedAt, headings.durationMinutes, headings.runId,
  ]
  const lines = rows.map((row) => [
    row.finishedAt ?? '',
    row.teamName,
    row.workItemTitle,
    row.workItemId,
    runHistoryProjectName(row, projectNames),
    memberNames[row.assigneeUserId] ?? row.assigneeUserId,
    row.agentName,
    labels.runtimes[row.runtime],
    row.outcome === undefined ? '' : labels.outcomes[row.outcome],
    row.startedAt,
    String(runDurationMinutes(row) ?? ''),
    row.runId,
  ])
  return `${[header, ...lines].map((cells) => cells.map(toCsvCell).join(',')).join('\r\n')}\r\n`
}
