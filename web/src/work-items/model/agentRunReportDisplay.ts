import type { AgentRunArtifact, AgentRunReport, AgentRunReportKind } from '@mukuroji/contracts'

/** Longest artifact text shown before it is shortened. */
const maximumArtifactTextLength = 48

/** Work Item and session the shown reports must belong to. */
export type AgentRunReportScope = {
  /** Session access token; no reports are shown without it. */
  accessToken?: string
  /** Team that owns the Work Item; no reports are shown without it. */
  teamId?: string
  /** Work Item ID. */
  workItemId: string
}

/**
 * Keeps only the reports of the Work Item on screen. The query keeps earlier data while a new read
 * runs, so data read for another Work Item or before a sign-out must never be shown here.
 *
 * @param reports - Reports from the query, if any.
 * @param scope - Session and Work Item on screen.
 * @returns Reports of that Work Item, or none without a session.
 */
export function selectAgentRunReportsForWorkItem(
  reports: readonly AgentRunReport[] | undefined,
  { accessToken, teamId, workItemId }: AgentRunReportScope,
): AgentRunReport[] {
  if (!accessToken || !teamId || !reports) return []
  return reports.filter((report) => report.teamId === teamId && report.workItemId === workItemId)
}

/**
 * Indexes reports by the comment they were saved with. Each comment carries at most one report;
 * the first one listed (the newest) wins if the server ever returned more.
 *
 * @param reports - Reports, newest first.
 * @returns Reports keyed by comment ID.
 */
export function indexAgentRunReportsByComment(reports: readonly AgentRunReport[]): ReadonlyMap<string, AgentRunReport> {
  const byComment = new Map<string, AgentRunReport>()
  for (const report of reports) {
    if (!byComment.has(report.commentId)) byComment.set(report.commentId, report)
  }
  return byComment
}

/**
 * Tells whether a report kind asks a person to decide.
 *
 * @param kind - Report kind.
 * @returns True for blockers and hand-offs.
 */
export function isAgentRunReportAwaitingDecision(kind: AgentRunReportKind): boolean {
  return kind === 'blocker' || kind === 'handoff'
}

/**
 * Chooses the text of an artifact link: its label, or the URL without the scheme, shortened.
 *
 * @param artifact - Artifact link.
 * @returns Display text.
 */
export function readAgentRunArtifactText(artifact: AgentRunArtifact): string {
  const text = artifact.label ?? artifact.url.replace(/^https:\/\//, '')
  return text.length > maximumArtifactTextLength ? `${text.slice(0, maximumArtifactTextLength - 1)}…` : text
}

/**
 * Which read failed, so the conversation says why details are missing. `artifact-statuses-incomplete`
 * means the status read succeeded but stopped before every reported pull request was listed.
 */
export type AgentRunReportLoadFailure = 'reports' | 'artifact-statuses' | 'artifact-statuses-incomplete'

/**
 * Chooses the load notice of a Work Item's conversation. A failed report read hides every chip,
 * so it wins; a failed or incomplete status read only matters when a report lists a pull request.
 *
 * @param state - Which reads failed, and whether a report lists a pull request.
 * @returns The failure to show, or undefined when nothing failed.
 */
export function selectAgentRunReportLoadFailure(state: {
  /** The reports could not be read. */
  reportsFailed: boolean
  /** The pull request statuses could not be read. */
  statusesFailed: boolean
  /** A shown report lists a pull request. */
  hasPullRequests: boolean
  /** The status read stopped before every reported pull request was listed. */
  statusesIncomplete?: boolean
}): AgentRunReportLoadFailure | undefined {
  if (state.reportsFailed) return 'reports'
  if (!state.hasPullRequests) return undefined
  if (state.statusesFailed) return 'artifact-statuses'
  if (state.statusesIncomplete) return 'artifact-statuses-incomplete'
  return undefined
}

/**
 * Identifies a report's answer draft, so drafts of different Work Items and reports never mix.
 *
 * @param workItemId - Work Item shown.
 * @param report - Report the draft answers.
 * @returns Draft key.
 */
export function agentRunReportAnswerDraftKey(workItemId: string, report: Pick<AgentRunReport, 'runId' | 'sequence'>): string {
  return JSON.stringify([workItemId, report.runId, report.sequence])
}
