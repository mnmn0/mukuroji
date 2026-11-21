import type { SubmitWeeklyReportRequest, WeeklyReportNotes, WeeklyReportResponse } from '@mukuroji/contracts'
import { useCallback, useMemo, useRef, useState } from 'react'
import { createMutationFingerprint, createMutationRequestRunner } from '../../../shared/api/mutationHeaders'
import { saveWeeklyReportDraft, submitWeeklyReport } from '../api/weeklyReports'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import {
  selectWeeklyReportSubmission,
  weeklyReportSubmissionContent,
  type PendingWeeklyReportSubmission,
} from './pendingWeeklyReportSubmission'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/** Saves and submits the signed-in member's weekly report. */
export type WeeklyReportMutations = {
  /**
   * Saves the notes of the week without submitting.
   *
   * @param expectedRevision - Saved revision read before the change; 0 when nothing was saved.
   * @param notes - Notes to save.
   * @returns The saved report.
   */
  saveDraft: (expectedRevision: number, notes: WeeklyReportNotes) => Promise<WeeklyReportResponse>
  /**
   * Submits a new version of the week's report.
   *
   * @param input - Work Item references, time, notes, and the expected submission count.
   * @returns The report with the new version.
   */
  submit: (input: SubmitWeeklyReportRequest) => Promise<WeeklyReportResponse>
}

/**
 * Tells whether a failed request never reached the API, so a retry must reuse its Idempotency-Key.
 *
 * @param error - Thrown error.
 * @returns Whether the request context should be kept.
 */
function isUnreachable(error: unknown) {
  return error instanceof TimeTrackingApiError && error.status === 0
}

/**
 * Creates the save and submit actions of the member's report for one week. A retry of the same
 * input after a network failure reuses the Idempotency-Key, so a submission that reached the
 * server is not submitted twice. A submission whose result is unknown is retried as first sent,
 * even after a refresh read new counts, unless the member changed what it says. Every time
 * tracking query is refreshed after each attempt.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team the report belongs to.
 * @param memberKey - The member's own key, or undefined while unknown.
 * @param weekStart - First day of the week.
 * @returns The actions.
 */
export function useWeeklyReportMutations(
  accessToken: string | undefined,
  teamId: string,
  memberKey: string | undefined,
  weekStart: string,
): WeeklyReportMutations {
  const refresh = useRefreshTimeTrackingQueries()
  const [runner] = useState(() => createMutationRequestRunner())
  const pendingSubmission = useRef<PendingWeeklyReportSubmission | null>(null)

  /**
   * Returns the token and member key, or fails when signed out.
   *
   * @returns Token and member key.
   */
  const requireSession = useCallback(() => {
    if (!accessToken || !memberKey) throw new TimeTrackingApiError(401, 'Sign in again to save the weekly report.')
    return { token: accessToken, member: memberKey }
  }, [accessToken, memberKey])

  const saveDraft = useCallback(async (expectedRevision: number, notes: WeeklyReportNotes) => {
    const { token, member } = requireSession()
    const fingerprint = await createMutationFingerprint(String(expectedRevision), notes.issues, notes.reflection)
    try {
      return await runner.run(`draft:${teamId}:${weekStart}`, fingerprint, (context) =>
        saveWeeklyReportDraft(token, teamId, member, weekStart, { expectedRevision, notes }, context), isUnreachable)
    } finally {
      await refresh()
    }
  }, [refresh, requireSession, runner, teamId, weekStart])

  const submit = useCallback(async (input: SubmitWeeklyReportRequest) => {
    const { token, member } = requireSession()
    const scope = `submit:${teamId}:${weekStart}`
    const effective = selectWeeklyReportSubmission(pendingSubmission.current, scope, input)
    const fingerprint = await createMutationFingerprint(JSON.stringify(effective))
    try {
      const response = await runner.run(scope, fingerprint, (context) =>
        submitWeeklyReport(token, teamId, member, weekStart, effective, context), isUnreachable)
      pendingSubmission.current = null
      return response
    } catch (error) {
      pendingSubmission.current = isUnreachable(error)
        ? { scope, content: weeklyReportSubmissionContent(effective), input: effective }
        : null
      throw error
    } finally {
      await refresh()
    }
  }, [refresh, requireSession, runner, teamId, weekStart])

  return useMemo(() => ({ saveDraft, submit }), [saveDraft, submit])
}
