import type { AgentRunReport } from '@mukuroji/contracts'
import { useCallback, useMemo, type ReactNode } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import type { Locale } from '../../shared/i18n/i18n'
import { answerAgentRunReport } from '../api/agentRuns'
import { WorkItemConfigurationApiError } from '../api/errors'
import { indexAgentRunReportsByComment, selectAgentRunReportsForWorkItem } from '../model/agentRunReportDisplay'
import { useWorkItemAgentRunReports } from '../queries/useWorkItemAgentRunReports'
import type { AgentRunReportAnswerResult } from './AgentRunReportAnswerForm'
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
  /** True when the viewer may comment, and so answer a blocker or hand-off. */
  canAnswer?: boolean
  /** Reads the conversation again after an answer, so the answer's comment appears. */
  onAnswered?: () => Promise<unknown>
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
 * a comment, with an answer form under a waiting blocker or hand-off for members who may comment. Comments without a report render nothing, so the conversation never waits on reports;
 * a failed read is shown as a separate notice with a retry action instead of as missing reports.
 *
 * @param input - Work Item, session, and locale.
 * @returns Comment renderer and loading notice.
 */
export function useAgentRunReportCommentDetails({
  accessToken,
  canAnswer = false,
  commentCount,
  locale,
  onAnswered,
  teamId,
  workItemId,
}: AgentRunReportCommentDetailsInput): AgentRunReportCommentDetails {
  const labels = useMemo(() => createAgentRunReportChipsLabels(locale), [locale])
  const noticeLabels = useMemo(() => createAgentRunReportsNoticeLabels(locale), [locale])
  const { data, error, mutate } = useWorkItemAgentRunReports(accessToken, teamId, workItemId, commentCount)
  // SWR keeps the last successful reports after a failed read; while the load notice says the
  // comments are shown without report details, no chips may claim otherwise.
  const reports = error ? undefined : data?.items
  const byComment = useMemo(
    () => indexAgentRunReportsByComment(selectAgentRunReportsForWorkItem(reports, { accessToken, teamId, workItemId })),
    [accessToken, reports, teamId, workItemId],
  )
  const mutationRunner = useMemo(() => createMutationRequestRunner(), [])
  const answer = useCallback(async (report: AgentRunReport, body: string): Promise<AgentRunReportAnswerResult> => {
    if (!accessToken || !teamId) return 'failed'
    try {
      await mutationRunner.run(
        `agent-run:answer:${teamId}:${report.runId}:${report.sequence}`,
        body,
        (context) => answerAgentRunReport(accessToken, teamId, report, body, context),
      )
    } catch (answerError) {
      if (answerError instanceof WorkItemConfigurationApiError && answerError.status === 409) {
        void mutate().catch(() => undefined)
        return 'conflict'
      }
      return 'failed'
    }
    // The answer is committed: a failed refresh must not report it as failed.
    void mutate().catch(() => undefined)
    void onAnswered?.().catch(() => undefined)
    return 'saved'
  }, [accessToken, mutate, mutationRunner, onAnswered, teamId])
  const renderCommentDetails = useCallback((comment: { id: string }) => {
    const report = byComment.get(comment.id)
    if (!report) return null
    return (
      <AgentRunReportChips
        labels={labels}
        onAnswer={canAnswer && accessToken && teamId ? (body) => answer(report, body) : undefined}
        report={report}
      />
    )
  }, [accessToken, answer, byComment, canAnswer, labels, teamId])
  return {
    renderCommentDetails,
    loadNotice: error && accessToken && teamId ? <AgentRunReportsLoadNotice labels={noticeLabels} onRetry={() => { void mutate() }} /> : null,
  }
}
