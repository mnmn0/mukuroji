import type { AgentRunReport } from '@mukuroji/contracts'
import { useCallback, useMemo } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { answerAgentRunReport } from '../api/agentRuns'
import { WorkItemConfigurationApiError } from '../api/errors'

/** Outcome of answering a report, as the answer form shows it. */
export type AgentRunReportAnswerResult = 'saved' | 'conflict' | 'failed'

/** Inputs of the answer mutation. */
export type AnswerAgentRunReportInput = {
  /** Session access token; nothing is sent without it. */
  accessToken?: string
  /** Team that owns the Work Item; nothing is sent without it. */
  teamId?: string
  /** Reads the Work Item's reports again, so the answer or a newer answer appears. */
  refreshReports: () => Promise<unknown>
  /** Reads the conversation again after an answer, so the answer's comment appears. */
  onAnswered?: () => Promise<unknown>
}

/**
 * Answers a `blocker` or `handoff` report. A retry of the same answer reuses the request's idempotency
 * key, a conflict reads the reports again so the saved answer appears, and a saved answer refreshes the
 * reports and the conversation without letting a failed refresh report the answer as failed.
 *
 * @param input - Session, Team, and the refresh actions.
 * @returns Function that answers one report and resolves to the outcome.
 */
export function useAnswerAgentRunReport({
  accessToken,
  onAnswered,
  refreshReports,
  teamId,
}: AnswerAgentRunReportInput): (report: AgentRunReport, body: string) => Promise<AgentRunReportAnswerResult> {
  const mutationRunner = useMemo(() => createMutationRequestRunner(), [])
  return useCallback(async (report: AgentRunReport, body: string): Promise<AgentRunReportAnswerResult> => {
    if (!accessToken || !teamId) return 'failed'
    try {
      await mutationRunner.run(
        `agent-run:answer:${teamId}:${report.runId}:${report.sequence}`,
        body,
        (context) => answerAgentRunReport(accessToken, teamId, report, body, context),
      )
    } catch (answerError) {
      if (answerError instanceof WorkItemConfigurationApiError && answerError.status === 409) {
        void refreshReports().catch(() => undefined)
        return 'conflict'
      }
      return 'failed'
    }
    // The answer is committed: a failed refresh must not report it as failed.
    void refreshReports().catch(() => undefined)
    void onAnswered?.().catch(() => undefined)
    return 'saved'
  }, [accessToken, mutationRunner, onAnswered, refreshReports, teamId])
}
