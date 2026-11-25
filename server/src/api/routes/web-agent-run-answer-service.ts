import {
  AGENT_RUN_QUESTIONS_MAX_ITEMS,
  type AgentRunReport,
  type AgentRunReportAnswer,
  type AnswerAgentRunReportResponse,
  type WorkItemAgentRunQuestionsResponse,
} from '@mukuroji/contracts'
import type { MutationAuditContext } from '../../modules/audit/audit'
import {
  AgentRunError,
  createAgentRunIntegrityError,
  isAgentRunQuestionReport,
  toAgentRunReport,
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

/** Most report pages a lookup or a question list reads for one Work Item. */
const maximumReportPages = 20

/** Identity of one report within a Work Item. */
export type AgentRunReportReference = {
  /** Run the report belongs to. */
  runId: string
  /** Position of the report within its run. */
  sequence: number
}

/**
 * Reads a Work Item's reports newest first until a report matches, up to a fixed bound.
 *
 * @param principal - Caller.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @param match - Returns true for the wanted report.
 * @returns The first matching report, or undefined.
 */
async function findWorkItemReport(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  match: (report: StoredAgentRunReport) => boolean,
): Promise<StoredAgentRunReport | undefined> {
  let cursor: string | undefined
  for (let page = 0; page < maximumReportPages; page += 1) {
    const result = await workItemDependencies.agentRuns.listWorkItemReports(principal.directoryId, teamId, workItemId, cursor, reportPageSize)
    const found = result.reports.find(match)
    if (found) return found
    cursor = result.nextCursor
    if (cursor === undefined) return undefined
  }
  return undefined
}

/**
 * Reads one report of a Work Item.
 *
 * @param principal - Caller.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @param reference - Run and sequence of the report.
 * @returns The report.
 * @throws AgentRunError not_found when the Work Item has no such report.
 */
async function requireWorkItemReport(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  reference: AgentRunReportReference,
): Promise<StoredAgentRunReport> {
  const report = await findWorkItemReport(principal, teamId, workItemId,
    (candidate) => candidate.runId === reference.runId && candidate.sequence === reference.sequence)
  if (!report) throw new AgentRunError('not_found', 'The report was not found.')
  if (report.workItemId !== workItemId) throw createAgentRunIntegrityError()
  return report
}

/**
 * Explains why an answer is refused once the report has been read.
 *
 * @param report - Report as read.
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
 * Records a person's answer to a `blocker` or `handoff` report. The answer is saved on the report and
 * as a Work Item comment of the person in one transaction, with an audit event, so the discussion,
 * the Work Item history, and the audit log all show it. A report has at most one answer; a retry of
 * the same answer by the same member returns the saved answer.
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
  const report = await requireWorkItemReport(principal, teamId, workItemId, reference)
  const replay = recordedAnswer(report, principal, body)
  if (replay) return { report: toAgentRunReport(report) }
  const store = workItemDependencies.agentRuns
  const run = await store.getRun(principal.directoryId, teamId, report.runId)
  if (!run || run.workItemId !== workItemId) throw createAgentRunIntegrityError()
  const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, workItemId)
  const commentId = deriveAuditedCommentId(entityKey, auditContext)
  const answer: AgentRunReportAnswer = {
    body,
    answeredBy: principal.userKey,
    answeredAt: auditContext.occurredAt,
    commentId,
  }
  const auditPut = createAgentRunAuditPut(
    auditContext, run, 'answered', `A member answered a ${report.kind} report.`, AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM,
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
    const latest = await findWorkItemReport(principal, teamId, workItemId,
      (candidate) => candidate.runId === report.runId && candidate.sequence === report.sequence).catch(() => undefined)
    if (latest?.answer !== undefined && recordedAnswer(latest, principal, body)) return { report: toAgentRunReport(latest) }
    throw error
  }
  return { report: toAgentRunReport({ ...report, answer }) }
}

/**
 * Lists the newest `blocker` and `handoff` reports of a Work Item with their answers, for anyone who can
 * view the Work Item.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns Up to {@link AGENT_RUN_QUESTIONS_MAX_ITEMS} questions, newest first.
 */
export async function listWorkItemAgentRunQuestions(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<WorkItemAgentRunQuestionsResponse> {
  await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
  const items: AgentRunReport[] = []
  let cursor: string | undefined
  for (let page = 0; page < maximumReportPages; page += 1) {
    const result = await workItemDependencies.agentRuns.listWorkItemReports(principal.directoryId, teamId, workItemId, cursor, reportPageSize)
    for (const report of result.reports) {
      if (report.workItemId !== workItemId) throw createAgentRunIntegrityError()
      if (!isAgentRunQuestionReport(report)) continue
      if (items.length === AGENT_RUN_QUESTIONS_MAX_ITEMS) return { items, hasMore: true }
      items.push(toAgentRunReport(report))
    }
    cursor = result.nextCursor
    if (cursor === undefined) return { items, hasMore: false }
  }
  return { items, hasMore: true }
}
