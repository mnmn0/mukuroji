import type { SubmitWeeklyReportRequest } from '@mukuroji/contracts'

/** A submission whose result is unknown because its request never got a response. */
export type PendingWeeklyReportSubmission = {
  /** Team and week the submission was for. */
  scope: string
  /** Content of the submission, without the counts it expected. */
  content: string
  /** The input as first sent, retried unchanged so the server recognizes it. */
  input: SubmitWeeklyReportRequest
}

/**
 * Serializes what a submission says, leaving out the counts that change once a refresh reads a
 * version the lost request may already have stored.
 *
 * @param input - Submission input.
 * @returns A stable string of the content.
 */
export function weeklyReportSubmissionContent(input: SubmitWeeklyReportRequest) {
  return JSON.stringify([input.sections, input.time, input.indirectTime ?? [], input.totalMinutes, input.timeIsPartial, input.notes])
}

/**
 * Chooses the input to send. The same content after a lost response is the same submission, so
 * it is sent as first sent and the server answers with the version it may already have stored
 * instead of adding one. Changed content is a new submission with the counts just read.
 *
 * @param pending - Submission whose result is unknown, if any.
 * @param scope - Team and week of this submission.
 * @param input - Input built from what the member sees now.
 * @returns The input to send.
 */
export function selectWeeklyReportSubmission(
  pending: PendingWeeklyReportSubmission | null,
  scope: string,
  input: SubmitWeeklyReportRequest,
): SubmitWeeklyReportRequest {
  return pending?.scope === scope && pending.content === weeklyReportSubmissionContent(input) ? pending.input : input
}
