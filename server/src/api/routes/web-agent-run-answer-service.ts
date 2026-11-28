import {
  AGENT_RUN_QUESTIONS_MAX_ITEMS,
  type AgentRunReport,
  type AgentRunReportAnswer,
  type AnswerAgentRunReportResponse,
} from '@mukuroji/contracts'
import type { MutationAuditContext } from '../../modules/audit/audit'
import {
  AgentRunError,
  createAgentRunIntegrityError,
  isAgentRunQuestionReport,
  toAgentRunReport,
  type StoredAgentRun,
  type StoredAgentRunReport,
} from '../../modules/agent-runs'
import {
  createProjectCollaborationEntityKey,
  createWorkItemCollaborationEntityKey,
  deriveAuditedCommentId,
} from '../../modules/collaboration'
import { createTeamIssueDeepLink } from '../../modules/work-items'
import { AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM, createAgentRunAuditPut } from '../shared/agent-run-access'
import { workItemDependencies } from '../shared/app-dependencies'
import {
  createCollaborationCommentAuthorizationConditionChecks,
  createTeamIssueAutomaticWatcherCandidates,
} from '../shared/collaboration-access'
import { createCommentSearchDocument } from '../shared/document-access'
import { requireWorkspaceBusinessWrite, type WorkspacePrincipal } from '../shared/project-access'
import { projectWorkspaceSearchDocumentBestEffort } from '../shared/search-access'
import { loadAuthorizedTeamIssue } from '../shared/work-item-access'

/** Reports one store page returns. */
const reportPageSize = 100

/** Most report pages a question list reads for one Work Item. */
const maximumReportPages = 20

/**
 * Most bytes of serialized questions one list returns. It stays well under the 2 MiB response limit of
 * the MCP client, which reads the list on every `get_task`, whatever the reports' artifact lists hold.
 */
const questionsResponseByteBudget = 1_000_000

/** Identity of one report within a Work Item. */
export type AgentRunReportReference = {
  /** Run the report belongs to. */
  runId: string
  /** Position of the report within its run. */
  sequence: number
}

/**
 * Reads one report of a Work Item and the run it belongs to. The report is read by its run, so it is
 * found however many reports the Work Item has.
 *
 * @param principal - Caller.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @param reference - Run and sequence of the report.
 * @returns The report and its run.
 * @throws AgentRunError not_found when the Work Item has no such report.
 */
async function requireWorkItemReport(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  reference: AgentRunReportReference,
): Promise<{ report: StoredAgentRunReport, run: StoredAgentRun }> {
  const store = workItemDependencies.agentRuns
  const run = await store.getRun(principal.directoryId, teamId, reference.runId)
  if (!run || run.workItemId !== workItemId) throw new AgentRunError('not_found', 'The report was not found.')
  const report = await store.getRunReport(run, reference.sequence)
  if (!report) throw new AgentRunError('not_found', 'The report was not found.')
  if (report.workItemId !== workItemId || report.runId !== run.runId || report.sequence !== reference.sequence) {
    throw createAgentRunIntegrityError()
  }
  return { report, run }
}

/**
 * Explains why an answer is refused once the report has been read.
 *
 * @param report - Report as read, with its answer as the answer comment now stands.
 * @param principal - Caller.
 * @param body - Requested answer text.
 * @returns The recorded answer when the same member already saved the same text, so a retried
 * request replays; undefined when the report can be answered.
 * @throws AgentRunError conflict when the report is not a question or another answer is recorded.
 */
function recordedAnswer(report: StoredAgentRunReport, principal: WorkspacePrincipal, body: string): AgentRunReportAnswer | undefined {
  if (!isAgentRunQuestionReport(report)) {
    throw new AgentRunError('conflict', 'Only blocker and handoff reports can be answered.', { reason: 'invalid_transition' })
  }
  if (report.answer === undefined) return undefined
  if (report.answer.answeredBy === principal.userKey && report.answer.body === body) return report.answer
  throw new AgentRunError('conflict', 'This report already has an answer. Read it before answering again.')
}

/**
 * Reads the answer of a report as its comment now stands. The comment carries the answer in the
 * discussion, so editing the comment changes the answer and deleting the comment withdraws it.
 *
 * @param entityKey - Collaboration entity key of the Work Item.
 * @param answer - Answer saved on the report.
 * @returns The answer with the comment's current text, or undefined when there is no answer or its
 * comment was deleted.
 */
async function readCurrentAnswer(entityKey: string, answer: AgentRunReportAnswer | undefined): Promise<AgentRunReportAnswer | undefined> {
  if (answer === undefined) return undefined
  const comment = await workItemDependencies.collaboration.getCommentSnapshot({ entityKey, commentId: answer.commentId })
  if (!comment || comment.deletedAt) return undefined
  return comment.bodyMarkdown === answer.body ? answer : { ...answer, body: comment.bodyMarkdown }
}

/**
 * Replaces the answer of a report with the one its comment now holds.
 *
 * @param report - Report as stored.
 * @param answer - Current answer, or undefined when it was withdrawn.
 * @returns The report with that answer.
 */
function withAnswer(report: StoredAgentRunReport, answer: AgentRunReportAnswer | undefined): StoredAgentRunReport {
  const { answer: _stored, ...rest } = report
  return answer === undefined ? rest : { ...rest, answer }
}

/**
 * Reads a report's answer as its comment now stands, so every report read shows an edited answer's
 * text and no answer once its comment is deleted.
 *
 * @param directoryId - Workspace ID.
 * @param report - Report as stored.
 * @returns The report with its current answer.
 */
export async function withCurrentAnswer(directoryId: string, report: StoredAgentRunReport): Promise<StoredAgentRunReport> {
  if (report.answer === undefined) return report
  const entityKey = createWorkItemCollaborationEntityKey(directoryId, report.teamId, report.workItemId)
  return withAnswer(report, await readCurrentAnswer(entityKey, report.answer))
}

/**
 * Records a person's answer to a `blocker` or `handoff` report. The answer is saved on the report and
 * as a Work Item comment of the person in one transaction, with an audit event, so the discussion,
 * the Work Item history, and the audit log all show it. A report has at most one answer; a retry of
 * the same answer by the same member returns the saved answer. Editing the answer comment changes the
 * answer, and deleting it withdraws the answer so the report can be answered again.
 *
 * @param principal - Member who answers.
 * @param teamId - Team ID.
 * @param workItemId - Work Item the report belongs to.
 * @param reference - Run and sequence of the report.
 * @param body - Validated answer text.
 * @param auditContext - Audit context of the request.
 * @returns The answered report.
 */
export async function answerWebAgentRunReport(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  reference: AgentRunReportReference,
  body: string,
  auditContext: MutationAuditContext,
): Promise<AnswerAgentRunReportResponse> {
  requireWorkspaceBusinessWrite(principal)
  const { context: permissionContext, detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
  const { report, run } = await requireWorkItemReport(principal, teamId, workItemId, reference)
  const store = workItemDependencies.agentRuns
  const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, workItemId)
  const commentId = deriveAuditedCommentId(entityKey, auditContext)
  const current = withAnswer(report, await readCurrentAnswer(entityKey, report.answer))
  // A retry of the request that saved the answer replays it as its comment now stands, edited or deleted.
  if (report.answer?.commentId === commentId) return { report: toAgentRunReport(current) }
  const replay = recordedAnswer(current, principal, body)
  if (replay) return { report: toAgentRunReport(current) }
  const answer: AgentRunReportAnswer = {
    body,
    answeredBy: principal.userKey,
    answeredAt: auditContext.occurredAt,
    commentId,
  }
  const auditPut = createAgentRunAuditPut(
    auditContext, run, 'answered', `A member answered a ${report.kind} report.`, undefined, AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM,
  )
  const projectId = detail.issue.assignedProjectId
  const authorizationConditionChecks = await createCollaborationCommentAuthorizationConditionChecks(
    principal, permissionContext, teamId, projectId,
  )
  try {
    const comment = await workItemDependencies.collaboration.createComment({
      workspaceId: principal.directoryId,
      teamId,
      issueId: workItemId,
      workItemTitle: detail.issue.title,
      entityKey,
      projectId,
      projectEntityKey: projectId ? createProjectCollaborationEntityKey(principal.directoryId, projectId) : undefined,
      assigneeMemberKey: detail.issue.assigneeUserId,
      actorMemberKey: principal.userKey,
      bodyMarkdown: body,
      mentionMemberKeys: [],
      automaticWatcherCandidates: createTeamIssueAutomaticWatcherCandidates(detail.issue),
      deepLink: createTeamIssueDeepLink(teamId, workItemId),
      authorizationConditionChecks,
      coWrites: [
        ...store.createReportAnswerItems(report, answer),
        ...(auditPut ? [auditPut] : []),
      ],
      auditContext,
    })
    if (comment.id !== commentId) throw createAgentRunIntegrityError()
    await projectWorkspaceSearchDocumentBestEffort(() => createCommentSearchDocument(
      principal.directoryId, teamId, detail.issue, comment,
    ), 'Agent Run report answer comment creation')
  } catch (error) {
    // A concurrent answer fails the report condition; it is reported as a conflict, or replayed when it
    // is this member's same answer.
    // The answer is read as its comment now stands, so a withdrawn answer with the same text is not replayed.
    const stored = await store.getRunReport(run, report.sequence).catch(() => undefined)
    const latest = stored && await withCurrentAnswer(principal.directoryId, stored).catch(() => undefined)
    if (latest?.answer !== undefined && recordedAnswer(latest, principal, body)) return { report: toAgentRunReport(latest) }
    throw error
  }
  return { report: toAgentRunReport({ ...report, answer }) }
}

/** Where a question list continues: a report store page and how many of its reports were read. */
type QuestionContinuation = {
  /** Store cursor of the page to read next, or undefined for the newest page. */
  cursor?: string
  /** Reports at the start of that page that an earlier list already went through. */
  skip: number
}

/** One page of questions with the internal continuation the Public API signs into its cursor. */
export type AgentRunQuestionPage = {
  /** Questions, newest first. */
  items: AgentRunReport[]
  /** True when older questions may exist. */
  hasMore: boolean
  /** Internal continuation, present exactly when `hasMore` is true. */
  nextContinuation?: string
}

/**
 * Encodes where a question list continues.
 *
 * @param continuation - Store page and reports already read in it.
 * @returns Opaque continuation.
 */
function encodeQuestionContinuation(continuation: QuestionContinuation): string {
  return Buffer.from(JSON.stringify(continuation)).toString('base64url')
}

/**
 * Reads where a question list continues. The Public API signs the continuation, so a value that does
 * not parse is an integrity error rather than caller input.
 *
 * @param value - Opaque continuation, or undefined for the newest questions.
 * @returns Store page and reports already read in it.
 */
function decodeQuestionContinuation(value: string | undefined): QuestionContinuation {
  if (value === undefined) return { skip: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw createAgentRunIntegrityError()
  }
  if (typeof parsed !== 'object' || parsed === null) throw createAgentRunIntegrityError()
  const cursor: unknown = Reflect.get(parsed, 'cursor')
  const skip: unknown = Reflect.get(parsed, 'skip')
  if ((cursor !== undefined && typeof cursor !== 'string') || typeof skip !== 'number'
    || !Number.isInteger(skip) || skip < 0 || skip >= reportPageSize) {
    throw createAgentRunIntegrityError()
  }
  return cursor === undefined ? { skip } : { cursor, skip }
}

/**
 * Lists a Work Item's `blocker` and `handoff` reports with their answers, newest first, for anyone who
 * can view the Work Item. Each answer is read as its comment now stands: an edited comment gives the
 * edited text, and a deleted one leaves the report unanswered. One list stops at a number of
 * questions, a byte budget, or a number of report pages, and returns where to continue, so every
 * question can be reached however many other reports came after it.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @param continuation - Continuation from the previous list, or undefined for the newest questions.
 * @param limit - Most questions to return, at most {@link AGENT_RUN_QUESTIONS_MAX_ITEMS}.
 * @returns Questions within the byte budget; `hasMore` and `nextContinuation` when older questions
 * may exist.
 */
export async function listWorkItemAgentRunQuestions(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  continuation?: string,
  limit: number = AGENT_RUN_QUESTIONS_MAX_ITEMS,
): Promise<AgentRunQuestionPage> {
  await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
  const maximumItems = Math.max(1, Math.min(limit, AGENT_RUN_QUESTIONS_MAX_ITEMS))
  const items: AgentRunReport[] = []
  let bytes = 0
  let { cursor, skip } = decodeQuestionContinuation(continuation)
  /**
   * Ends the list before a report of the current page. A page after a store cursor starts at a fixed
   * report, so an offset into it stays put. The newest page has no such start, and reports that
   * arrive later would shift an offset, so the list is anchored after the last report it went
   * through: the store cursor after that report, read again here and checked against it.
   *
   * @param pageCursor - Store cursor of the current page.
   * @param position - Position of the first report left for the next list.
   * @param pageReports - Reports of the current page.
   * @returns The page with its continuation.
   */
  const stopAt = async (
    pageCursor: string | undefined,
    position: number,
    pageReports: readonly StoredAgentRunReport[],
  ): Promise<AgentRunQuestionPage> => {
    let next: QuestionContinuation = pageCursor === undefined ? { skip: position } : { cursor: pageCursor, skip: position }
    const last = pageReports[position - 1]
    if (pageCursor === undefined && last !== undefined) {
      const head = await workItemDependencies.agentRuns.listWorkItemReports(principal.directoryId, teamId, workItemId, undefined, position)
      const anchor = head.reports.at(-1)
      if (head.nextCursor !== undefined && anchor?.runId === last.runId && anchor.sequence === last.sequence) {
        next = { cursor: head.nextCursor, skip: 0 }
      }
    }
    return { items, hasMore: true, nextContinuation: encodeQuestionContinuation(next) }
  }
  for (let page = 0; page < maximumReportPages; page += 1) {
    const result = await workItemDependencies.agentRuns.listWorkItemReports(principal.directoryId, teamId, workItemId, cursor, reportPageSize)
    for (const [position, report] of result.reports.entries()) {
      if (position < skip) continue
      if (report.workItemId !== workItemId) throw createAgentRunIntegrityError()
      if (!isAgentRunQuestionReport(report)) continue
      if (items.length === maximumItems) return await stopAt(cursor, position, result.reports)
      const item = toAgentRunReport(await withCurrentAnswer(principal.directoryId, report))
      const itemBytes = Buffer.byteLength(JSON.stringify(item))
      // The first question of a list is always returned; later ones stop at the byte budget.
      if (items.length > 0 && bytes + itemBytes > questionsResponseByteBudget) return await stopAt(cursor, position, result.reports)
      bytes += itemBytes
      items.push(item)
    }
    skip = 0
    cursor = result.nextCursor
    if (cursor === undefined) return { items, hasMore: false }
  }
  // The read budget ran out; the next list starts at the next report page.
  return await stopAt(cursor, 0, [])
}
