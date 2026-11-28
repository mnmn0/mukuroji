import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import type { Locale } from '../../shared/i18n/i18n'
import {
  agentRunReportAnswerDraftKey,
  indexAgentRunReportsByComment,
  selectAgentRunReportLoadFailure,
  selectAgentRunReportsForWorkItem,
} from '../model/agentRunReportDisplay'
import { useAnswerAgentRunReport } from '../mutations/useAnswerAgentRunReport'
import { useWorkItemAgentRunReports } from '../queries/useWorkItemAgentRunReports'
import { useWorkItemArtifactStatuses } from '../queries/useWorkItemArtifactStatuses'
import type { AgentRunReportAnswerDraft } from './AgentRunReportAnswerForm'
import { AgentRunReportChips, AgentRunReportsLoadNotice } from './AgentRunReportChips'
import {
  createAgentRunArtifactStatusIncompleteNoticeLabels,
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
 * Unsent answers are kept per report here, so hiding the chips while the reports cannot be read
 * does not lose text typed in another report's form; a saved answer clears only its own draft.
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
  const statusIncompleteLabels = useMemo(() => createAgentRunArtifactStatusIncompleteNoticeLabels(locale), [locale])
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
  // A ref, not state: the forms own what they show, and typing must not render the conversation again.
  const drafts = useRef(new Map<string, AgentRunReportAnswerDraft>())
  const renderCommentDetails = useCallback((comment: { id: string }) => {
    const report = byComment.get(comment.id)
    if (!report) return null
    const draftKey = agentRunReportAnswerDraftKey(workItemId, report)
    return (
      <AgentRunReportChips
        answerDraft={drafts.current.get(draftKey)}
        artifactStatuses={statusByUrl}
        labels={labels}
        onAnswer={canAnswer && accessToken && teamId ? async (body) => {
          const result = await answer(report, body)
          // The answered report shows no form again, so its draft is dropped even if the form is gone.
          if (result === 'saved') drafts.current.delete(draftKey)
          return result
        } : undefined}
        onAnswerDraftChange={(draft) => {
          if (draft) drafts.current.set(draftKey, draft)
          else drafts.current.delete(draftKey)
        }}
        report={report}
      />
    )
  }, [accessToken, answer, byComment, canAnswer, labels, statusByUrl, teamId, workItemId])
  const failure = accessToken && teamId
    ? selectAgentRunReportLoadFailure({
      reportsFailed: Boolean(error),
      statusesFailed: Boolean(statusError),
      hasPullRequests,
      statusesIncomplete: statuses !== undefined && statusData?.incomplete === true,
    })
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
  } else if (failure === 'artifact-statuses-incomplete') {
    // The statuses that were read stay; the viewer is told some links were not checked.
    loadNotice = (
      <AgentRunReportsLoadNotice
        labels={statusIncompleteLabels}
        onRetry={() => { void refreshStatuses() }}
        testId="agent-run-artifact-status-incomplete-notice"
      />
    )
  }
  return { renderCommentDetails, loadNotice }
}
