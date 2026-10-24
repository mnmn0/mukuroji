import { useCallback, useMemo, type ReactNode } from 'react'
import type { Locale } from '../../shared/i18n/i18n'
import { indexAgentRunReportsByComment } from '../model/agentRunReportDisplay'
import { useWorkItemAgentRunReports } from '../queries/useWorkItemAgentRunReports'
import { AgentRunReportChips } from './AgentRunReportChips'
import { createAgentRunReportChipsLabels } from './agentRunReportLabels'

/** Inputs of the hook that adds report chips to a Work Item's comments. */
export type AgentRunReportCommentDetailsInput = {
  /** Session access token; no reports are read without it. */
  accessToken?: string
  /** Team that owns the Work Item; no reports are read without it. */
  teamId?: string
  /** Work Item ID. */
  workItemId: string
  /** Number of comments currently shown, so new reports are read with new comments. */
  commentCount: number
  /** Display locale. */
  locale: Locale
}

/**
 * Reads a Work Item's reports and returns a renderer that shows the chips of the report saved with
 * a comment. Comments without a report, and every comment while reports are loading or failed to
 * load, render nothing, so the conversation never waits on reports.
 *
 * @param input - Work Item, session, and locale.
 * @returns Renderer for one comment.
 */
export function useAgentRunReportCommentDetails({
  accessToken,
  commentCount,
  locale,
  teamId,
  workItemId,
}: AgentRunReportCommentDetailsInput): (comment: { id: string }) => ReactNode {
  const labels = useMemo(() => createAgentRunReportChipsLabels(locale), [locale])
  const { data } = useWorkItemAgentRunReports(accessToken, teamId, workItemId, commentCount)
  const byComment = useMemo(() => indexAgentRunReportsByComment(data?.items ?? []), [data])
  return useCallback((comment: { id: string }) => {
    const report = byComment.get(comment.id)
    return report ? <AgentRunReportChips labels={labels} report={report} /> : null
  }, [byComment, labels])
}
