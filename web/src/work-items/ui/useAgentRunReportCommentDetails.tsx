import { useCallback, useMemo, type ReactNode } from 'react'
import type { Locale } from '../../shared/i18n/i18n'
import { indexAgentRunReportsByComment, selectAgentRunReportsForWorkItem } from '../model/agentRunReportDisplay'
import { useWorkItemAgentRunReports } from '../queries/useWorkItemAgentRunReports'
import { AgentRunReportChips, AgentRunReportsLoadNotice } from './AgentRunReportChips'
import { createAgentRunReportChipsLabels, createAgentRunReportsNoticeLabels } from './agentRunReportLabels'

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

/** Report rendering for a Work Item's conversation. */
export type AgentRunReportCommentDetails = {
  /** Renders the chips of the report saved with a comment, or nothing. */
  renderCommentDetails: (comment: { id: string }) => ReactNode
  /** Notice with a retry action while the reports cannot be read, shown above the conversation. */
  loadNotice: ReactNode
}

/**
 * Reads a Work Item's reports and returns a renderer that shows the chips of the report saved with
 * a comment. Comments without a report render nothing, so the conversation never waits on reports;
 * a failed read is shown as a separate notice with a retry action instead of as missing reports.
 *
 * @param input - Work Item, session, and locale.
 * @returns Comment renderer and loading notice.
 */
export function useAgentRunReportCommentDetails({
  accessToken,
  commentCount,
  locale,
  teamId,
  workItemId,
}: AgentRunReportCommentDetailsInput): AgentRunReportCommentDetails {
  const labels = useMemo(() => createAgentRunReportChipsLabels(locale), [locale])
  const noticeLabels = useMemo(() => createAgentRunReportsNoticeLabels(locale), [locale])
  const { data, error, mutate } = useWorkItemAgentRunReports(accessToken, teamId, workItemId, commentCount)
  const byComment = useMemo(
    () => indexAgentRunReportsByComment(selectAgentRunReportsForWorkItem(data?.items, { accessToken, teamId, workItemId })),
    [accessToken, data, teamId, workItemId],
  )
  const renderCommentDetails = useCallback((comment: { id: string }) => {
    const report = byComment.get(comment.id)
    return report ? <AgentRunReportChips labels={labels} report={report} /> : null
  }, [byComment, labels])
  return {
    renderCommentDetails,
    loadNotice: error && accessToken && teamId ? <AgentRunReportsLoadNotice labels={noticeLabels} onRetry={() => { void mutate() }} /> : null,
  }
}
