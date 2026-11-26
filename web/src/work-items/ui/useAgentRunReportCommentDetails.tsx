import { useCallback, useMemo, type ReactNode } from 'react'
import type { Locale } from '../../shared/i18n/i18n'
import {
  indexAgentRunReportsByComment,
  selectAgentRunReportLoadFailure,
  selectAgentRunReportsForWorkItem,
} from '../model/agentRunReportDisplay'
import { useAnswerAgentRunReport } from '../mutations/useAnswerAgentRunReport'
import { useWorkItemAgentRunReports } from '../queries/useWorkItemAgentRunReports'
import { useWorkItemArtifactStatuses } from '../queries/useWorkItemArtifactStatuses'
import { AgentRunReportChips, AgentRunReportsLoadNotice } from './AgentRunReportChips'
import {
  createAgentRunArtifactStatusNoticeLabels,
  createAgentRunReportChipsLabels,
  createAgentRunReportsNoticeLabels,
} from './agentRunReportLabels'

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
  /**
   * Notice with a retry action while the reports, or the status of their pull requests, cannot be
   * read, shown above the conversation.
   */
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
  const statusNoticeLabels = useMemo(() => createAgentRunArtifactStatusNoticeLabels(locale), [locale])
  const { data, error, mutate } = useWorkItemAgentRunReports(accessToken, teamId, workItemId, commentCount)
  // SWR keeps the last successful reports after a failed read; while the load notice says the
  // comments are shown without report details, no chips may claim otherwise.
  const reports = error ? undefined : data?.items
  const byComment = useMemo(
    () => indexAgentRunReportsByComment(selectAgentRunReportsForWorkItem(reports, { accessToken, teamId, workItemId })),
    [accessToken, reports, teamId, workItemId],
  )
  const hasPullRequests = reports?.some((report) => report.artifacts.some((artifact) => artifact.type === 'pull-request')) === true
  const { data: statusData, error: statusError, mutate: refreshStatuses } = useWorkItemArtifactStatuses(
    accessToken, teamId, workItemId, hasPullRequests ? reports?.length ?? 0 : 0,
  )
  // A failed status read shows the plain links again rather than statuses that may be stale.
  const statuses = statusError || statusData?.workItemId !== workItemId ? undefined : statusData.items
  const statusByUrl = useMemo(() => new Map(statuses?.map((status) => [status.url, status])), [statuses])
  const answer = useAnswerAgentRunReport({ accessToken, teamId, refreshReports: mutate, onAnswered })
  const renderCommentDetails = useCallback((comment: { id: string }) => {
    const report = byComment.get(comment.id)
    if (!report) return null
    return (
      <AgentRunReportChips
        artifactStatuses={statusByUrl}
        labels={labels}
        onAnswer={canAnswer && accessToken && teamId ? (body) => answer(report, body) : undefined}
        report={report}
      />
    )
  }, [accessToken, answer, byComment, canAnswer, labels, statusByUrl, teamId])
  const failure = accessToken && teamId
    ? selectAgentRunReportLoadFailure({ reportsFailed: Boolean(error), statusesFailed: Boolean(statusError), hasPullRequests })
    : undefined
  let loadNotice: ReactNode = null
  if (failure === 'reports') {
    loadNotice = <AgentRunReportsLoadNotice labels={noticeLabels} onRetry={() => { void mutate() }} />
  } else if (failure === 'artifact-statuses') {
    // The links stay as plain links, and the viewer is told why and may check again.
    loadNotice = (
      <AgentRunReportsLoadNotice
        labels={statusNoticeLabels}
        onRetry={() => { void refreshStatuses() }}
        testId="agent-run-artifact-status-load-notice"
      />
    )
  }
  return { renderCommentDetails, loadNotice }
}
