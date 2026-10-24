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
