import { createHash } from 'node:crypto'
import {
  FACTORY_BOARD_COMPLETED_WINDOW_HOURS,
  FACTORY_BOARD_MAX_ACTIVE_RUNS,
  FACTORY_BOARD_MAX_EVALUATED_FINISHED_RUNS,
  FACTORY_BOARD_MAX_EVALUATED_WORK_ITEMS,
  FACTORY_BOARD_REPORT_EXCERPT_MAX_LENGTH,
  classifyFactoryBoardItem,
  type AgentRunReport,
  type AgentRunView,
  type AgentSettings,
  type FactoryBoardItem,
  type FactoryBoardReportSummary,
  type TeamAgentRunBoardResponse,
  type WorkItemAgentRunReportsResponse,
  type WorkItemAgentRunsResponse,
} from '@mukuroji/contracts'
import {
  AgentRunError,
  createAgentRunIntegrityError,
  createAgentRunNotActiveError,
  createAgentRunReportCommentBody,
  finishAgentRun,
  assertAgentSettingsBriefLimits,
  readUpdateAgentSettingsRequest,
  toAgentRun,
  toAgentRunReport,
  type StoredAgentRun,
} from '../../modules/agent-runs'
import { isCognitoUserNotFoundError, type CognitoUserProfile } from '../../modules/authentication'
import {
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  type MutationAuditContext,
} from '../../modules/audit/audit'
import { createWorkItemCollaborationEntityKey } from '../../modules/collaboration'
import { ProjectDataError } from '../../modules/directory'
import { isTeamIssueNotFoundError, type TeamIssueResponseItem } from '../../modules/work-items'
import { createWorkItemRevisionConditionCheck } from '../../modules/work-items/adapter-out/dynamodb/work-item-client'
import {
  commitProgressFencedClose,
  createAgentRunAuditPut,
  mapInOrderWithConcurrency,
  retryProgressFencedClose,
  withVisibleProjectBriefs,
} from '../shared/agent-run-access'
import { authenticationDependencies, workItemDependencies } from '../shared/app-dependencies'
import {
  canAccessAssignedProject,
  canWorkspaceBusinessWrite,
  requireAssignedProjectPermission,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { getTeamIssuesTableName, loadAuthorizedTeamIssue } from '../shared/work-item-access'
import type { TeamPermissionContext } from '../shared/workspace-access'

/**
 * Checks whether the principal manages the Team.
 *
 * @param principal - Authorized principal.
 * @param teamId - Team ID.
 * @returns True for Team managers and system administrators.
 */
async function isTeamManager(principal: WorkspacePrincipal, teamId: string): Promise<boolean> {
  try {
    await requireTeamPermission(principal, teamId, 'manager')
    return true
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
}

/**
 * Checks the write access a release requires before {@link mayRelease} applies, so the history
 * never offers a release that {@link releaseWebAgentRun} would reject.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param assignedProjectId - Project the run's Work Item is assigned to.
 * @returns True when the viewer may write the Work Item.
 */
async function canWriteForRelease(
  principal: WorkspacePrincipal,
  teamId: string,
  assignedProjectId: string | undefined,
): Promise<boolean> {
  if (!canWorkspaceBusinessWrite(principal)) return false
  try {
    const context = await requireTeamPermission(principal, teamId, 'member')
    requireAssignedProjectPermission(principal, context, assignedProjectId, 'member')
    return true
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
}

/**
 * Reads the Team write access a release requires once for a whole board. The Project part of
 * {@link canWriteForRelease} is then checked per Work Item with the returned context.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @returns The viewer's member-level Team context, or undefined when the viewer cannot write.
 */
async function canWriteTeamForRelease(principal: WorkspacePrincipal, teamId: string): Promise<TeamPermissionContext | undefined> {
  if (!canWorkspaceBusinessWrite(principal)) return undefined
  try {
    return await requireTeamPermission(principal, teamId, 'member')
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return undefined
    throw error
  }
}

/**
 * Checks whether a member may release a run: a Team manager, the member who started it, or the
 * Work Item's current assignee, who is responsible for the work after a reassignment.
 *
 * @param run - Stored run.
 * @param principal - Viewer.
 * @param manager - Whether the viewer manages the Team.
 * @param workItemAssigneeUserId - Current assignee of the run's Work Item.
 * @returns True when the viewer may release the run.
 */
function mayRelease(run: StoredAgentRun, principal: WorkspacePrincipal, manager: boolean, workItemAssigneeUserId: string): boolean {
  return manager || run.assigneeUserId === principal.userKey || workItemAssigneeUserId === principal.userKey
}

/**
 * Projects a run for the Web application with the actions the viewer may take.
 *
 * @param run - Stored run.
 * @param canRelease - Whether the viewer may release the run while it is active.
 * @param now - Read time.
 * @returns Run view.
 */
function toAgentRunView(run: StoredAgentRun, canRelease: boolean, now: Date): AgentRunView {
  return { ...toAgentRun(run, now), canRelease: run.state === 'active' && canRelease }
}

/**
 * Lists a Work Item's newest runs with the release action each viewer may take. Store cursors,
 * which encode table keys, never leave the server.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @param limit - Number of runs from 1 to 100.
 * @returns Newest runs and whether older ones exist.
 */
export async function listWebWorkItemAgentRuns(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  limit: number,
): Promise<WorkItemAgentRunsResponse> {
  const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
  const page = await workItemDependencies.agentRuns.listWorkItemRuns(principal.directoryId, teamId, workItemId, undefined, limit)
  const [manager, writable] = await Promise.all([
    isTeamManager(principal, teamId),
    canWriteForRelease(principal, teamId, detail.issue.assignedProjectId),
  ])
  const now = new Date()
  return {
    items: page.runs.map((run) => toAgentRunView(
      run,
      writable && mayRelease(run, principal, manager, detail.issue.assigneeUserId),
      now,
    )),
    hasMore: page.nextCursor !== undefined,
  }
}

/**
 * Serialized size a page of reports may reach. One report holds at most about 200 KB, so a page
 * always fits the buffered Lambda response limit and still holds several reports.
 */
const maximumReportPageBytes = 1_000_000

/**
 * Lists a Work Item's newest structured reports for anyone who can see the Work Item. Store cursors
 * never leave the server. The page stops early once its serialized size reaches the byte budget.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @param limit - Number of reports from 1 to 100.
 * @returns Newest reports and whether older ones exist.
 */
export async function listWebWorkItemAgentRunReports(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  limit: number,
): Promise<WorkItemAgentRunReportsResponse> {
  await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
  const page = await workItemDependencies.agentRuns.listWorkItemReports(principal.directoryId, teamId, workItemId, undefined, limit)
  const items: AgentRunReport[] = []
  let bytes = 0
  for (const stored of page.reports) {
    const report = toAgentRunReport(stored)
    bytes += Buffer.byteLength(JSON.stringify(report))
    // The newest report is always returned, so a page is never empty while reports exist.
    if (items.length > 0 && bytes > maximumReportPageBytes) return { items, hasMore: true }
    items.push(report)
  }
  return { items, hasMore: page.nextCursor !== undefined }
}

/** Runs and Work Items the board reads per store request; the store and Work Item page maximum. */
const boardPageSize = 100

/** Concurrent per-Work Item reads while the board is assembled. */
const boardReadConcurrency = 10

/** Milliseconds in one hour. */
const millisecondsPerHour = 3_600_000

/**
 * Reads one Work Item strongly for the board, so a move to another Project, an archive, or a deletion
 * takes effect immediately.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns The Work Item, or undefined when it was deleted or archived.
 */
async function readBoardWorkItem(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<TeamIssueResponseItem | undefined> {
  try {
    const { issue } = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      teamId,
      workItemId,
      { consistentIssueRead: true, includeEvents: false },
    )
    return issue.archivedAt === undefined ? issue : undefined
  } catch (error) {
    if (isTeamIssueNotFoundError(error)) return undefined
    throw error
  }
}

/**
 * Reads a Team's active runs again from the run rows, because the lease index can still show a run
 * that just finished. Two active runs on one Work Item break the claim invariant and fail closed.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @returns Active runs by Work Item ID, in lease order, and whether more active runs exist.
 */
async function readBoardActiveRuns(
  principal: WorkspacePrincipal,
  teamId: string,
): Promise<{ runs: Map<string, StoredAgentRun>; hasMore: boolean }> {
  const store = workItemDependencies.agentRuns
  const page = await store.listActiveRuns(principal.directoryId, teamId, undefined, FACTORY_BOARD_MAX_ACTIVE_RUNS)
  const current = await mapInOrderWithConcurrency(page.runs, boardReadConcurrency, async (indexed) => {
    const run = await store.getRun(principal.directoryId, teamId, indexed.runId)
    if (run && run.workItemId !== indexed.workItemId) throw createAgentRunIntegrityError()
    return run?.state === 'active' ? run : undefined
  })
  const runs = new Map<string, StoredAgentRun>()
  for (const run of current) {
    if (!run) continue
    if (runs.has(run.workItemId)) throw createAgentRunIntegrityError()
    runs.set(run.workItemId, run)
  }
  return { runs, hasMore: page.nextCursor !== undefined }
}

/**
 * Collects the Work Items of runs that finished within the completed-lane window, and of every failed
 * run, which stays on the board without a time limit. The board then shows each Work Item by its
 * newest run. Finished runs are stored in run ID order, so at most
 * {@link FACTORY_BOARD_MAX_EVALUATED_FINISHED_RUNS} are evaluated.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param now - Board read time.
 * @returns Work Item IDs and whether finished runs were left unread.
 */
async function readRecentlyFinishedWorkItemIds(
  principal: WorkspacePrincipal,
  teamId: string,
  now: Date,
): Promise<{ workItemIds: string[]; hasMore: boolean }> {
  const since = now.getTime() - FACTORY_BOARD_COMPLETED_WINDOW_HOURS * millisecondsPerHour
  const workItemIds = new Set<string>()
  let evaluated = 0
  let cursor: string | undefined
  do {
    const limit = Math.min(boardPageSize, FACTORY_BOARD_MAX_EVALUATED_FINISHED_RUNS - evaluated)
    const page = await workItemDependencies.agentRuns.listFinishedRuns(principal.directoryId, teamId, cursor, limit)
    evaluated += limit
    for (const run of page.runs) {
      // A failure stays on the board without a time limit, so only other outcomes use the window.
      const recent = run.finishedAt !== undefined && Date.parse(run.finishedAt) >= since
      if (recent || run.outcome === 'failed') workItemIds.add(run.workItemId)
    }
    cursor = page.nextCursor
  } while (cursor !== undefined && evaluated < FACTORY_BOARD_MAX_EVALUATED_FINISHED_RUNS)
  return { workItemIds: [...workItemIds], hasMore: cursor !== undefined }
}

/**
 * Collects the `started` Work Items the viewer can see among the most recently updated ones. The
 * board reads each of them again strongly before it shows them.
 *
 * @param principal - Viewer.
 * @param permission - Viewer's Team permission context.
 * @param teamId - Team ID.
 * @returns Work Item IDs and whether Work Items were left unread.
 */
async function readStartedWorkItemIds(
  principal: WorkspacePrincipal,
  permission: TeamPermissionContext,
  teamId: string,
): Promise<{ workItemIds: string[]; hasMore: boolean }> {
  const workItemIds: string[] = []
  let evaluated = 0
  let cursor: string | undefined
  do {
    const limit = Math.min(boardPageSize, FACTORY_BOARD_MAX_EVALUATED_WORK_ITEMS - evaluated)
    const page = await workItemDependencies.teamIssues.getPublicWorkItemPage(principal.directoryId, teamId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    })
    evaluated += limit
    for (const issue of page.issues) {
      if (issue.statusCategory === 'started' && canAccessAssignedProject(principal, permission, issue.assignedProjectId, 'viewer')) {
        workItemIds.push(issue.id)
      }
    }
    cursor = page.nextCursor
  } while (cursor !== undefined && evaluated < FACTORY_BOARD_MAX_EVALUATED_WORK_ITEMS)
  return { workItemIds, hasMore: cursor !== undefined }
}

/**
 * Removes the agent label the server put in front of a report message and shortens the rest.
 *
 * @param body - Current comment body.
 * @param agentName - Agent name of the run.
 * @returns Excerpt, or undefined when nothing remains.
 */
function toReportExcerpt(body: string, agentName: string): string | undefined {
  const label = createAgentRunReportCommentBody(agentName, '')
  const message = (body.startsWith(label) ? body.slice(label.length) : body).trim()
  if (message === '') return undefined
  return [...message].slice(0, FACTORY_BOARD_REPORT_EXCERPT_MAX_LENGTH).join('')
}

/**
 * Summarizes the latest report of a run with the start of its comment. The comment is read at request
 * time, so an edited or deleted comment never shows its earlier text on the board.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param run - Run on the tile.
 * @returns Report summary, or undefined when the run has no report.
 */
async function readBoardReportSummary(
  principal: WorkspacePrincipal,
  teamId: string,
  run: StoredAgentRun,
): Promise<FactoryBoardReportSummary | undefined> {
  if (run.reportCount === 0) return undefined
  const page = await workItemDependencies.agentRuns.listWorkItemReports(principal.directoryId, teamId, run.workItemId, undefined, 1)
  const latest = page.reports[0]
  // The newest report of the Work Item belongs to its newest run whenever that run has reports.
  if (!latest || latest.runId !== run.runId) return undefined
  const report = toAgentRunReport(latest)
  const comment = await workItemDependencies.collaboration.getCommentSnapshot({
    entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, run.workItemId),
    commentId: report.commentId,
  })
  const excerpt = comment && comment.deletedAt === undefined ? toReportExcerpt(comment.bodyMarkdown, run.agentName) : undefined
  const verificationCounts = { passed: 0, failed: 0, skipped: 0 }
  for (const verification of report.verifications) verificationCounts[verification.status] += 1
  return {
    runId: report.runId,
    sequence: report.sequence,
    kind: report.kind,
    createdAt: report.createdAt,
    ...(excerpt === undefined ? {} : { excerpt }),
    verificationCounts,
    artifactCount: report.artifacts.length,
    ...(report.changedFileCount === undefined ? {} : { changedFileCount: report.changedFileCount }),
  }
}

/**
 * Reads the profiles of the members assigned to board Work Items, so the board can show names
 * instead of member IDs. A profile that is missing or fails to load is left out, and that member
 * keeps showing by ID; a profile lookup never fails the board.
 *
 * @param userIds - Assignee member IDs.
 * @returns Profiles by member ID.
 */
async function readBoardAssigneeProfiles(userIds: string[]): Promise<Map<string, CognitoUserProfile>> {
  const unique = [...new Set(userIds)]
  const profiles = await mapInOrderWithConcurrency(unique, boardReadConcurrency, async (userId) => {
    try {
      return await authenticationDependencies.cognito.getUserProfile(userId)
    } catch (error) {
      if (!isCognitoUserNotFoundError(error)) console.warn('Failed to read a Factory board assignee profile:', error)
      return undefined
    }
  })
  const byUserId = new Map<string, CognitoUserProfile>()
  unique.forEach((userId, index) => {
    const profile = profiles[index]
    if (profile) byUserId.set(userId, profile)
  })
  return byUserId
}

/**
 * Lists the Factory board of a Team for anyone who can view the Team: the Work Items of active runs,
 * of runs that finished within the completed-lane window, and the `started` Work Items among the most
 * recently updated ones, each with its active or newest run and that run's latest report. Only Work
 * Items the viewer can see and that belong to a lane are returned. Every source is read up to a fixed
 * bound and reports whether it stopped early; store cursors never leave the server.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @returns Board items and the bounds that were reached.
 */
export async function listWebTeamAgentRunBoard(
  principal: WorkspacePrincipal,
  teamId: string,
): Promise<TeamAgentRunBoardResponse> {
  const permission = await requireTeamPermission(principal, teamId, 'viewer')
  const now = new Date()
  const [active, finished, started, manager, writable] = await Promise.all([
    readBoardActiveRuns(principal, teamId),
    readRecentlyFinishedWorkItemIds(principal, teamId, now),
    readStartedWorkItemIds(principal, permission, teamId),
    isTeamManager(principal, teamId),
    canWriteTeamForRelease(principal, teamId),
  ])
  const workItemIds = [...new Set([...active.runs.keys(), ...finished.workItemIds, ...started.workItemIds])]
  const store = workItemDependencies.agentRuns
  const items = await mapInOrderWithConcurrency(workItemIds, boardReadConcurrency, async (workItemId) => {
    const workItem = await readBoardWorkItem(principal, teamId, workItemId)
    if (!workItem || !canAccessAssignedProject(principal, permission, workItem.assignedProjectId, 'viewer')) return undefined
    const run = active.runs.get(workItemId) ??
      (await store.listWorkItemRuns(principal.directoryId, teamId, workItemId, undefined, 1)).runs[0]
    const latestReport = run ? await readBoardReportSummary(principal, teamId, run) : undefined
    const canRelease = run !== undefined && writable !== undefined &&
      canAccessAssignedProject(principal, writable, workItem.assignedProjectId, 'member') &&
      mayRelease(run, principal, manager, workItem.assigneeUserId)
    const item: FactoryBoardItem = {
      workItem: {
        id: workItem.id,
        title: workItem.title,
        workflowStatusId: workItem.workflowStatusId,
        statusCategory: workItem.statusCategory,
        ...(workItem.assignedProjectId === undefined ? {} : { assignedProjectId: workItem.assignedProjectId }),
        assigneeUserId: workItem.assigneeUserId,
      },
      ...(run === undefined ? {} : { run: toAgentRunView(run, canRelease, now) }),
      ...(latestReport === undefined ? {} : { latestReport }),
    }
    return classifyFactoryBoardItem(item, now) === undefined ? undefined : item
  })
  const boardItems = items.flatMap((item) => item ? [item] : [])
  const profiles = await readBoardAssigneeProfiles(boardItems.map((item) => item.workItem.assigneeUserId))
  return {
    generatedAt: now.toISOString(),
    items: boardItems.map((item) => {
      const profile = profiles.get(item.workItem.assigneeUserId)
      if (!profile) return item
      return {
        ...item,
        workItem: {
          ...item.workItem,
          ...(profile.name === undefined || profile.name === '' ? {} : { assigneeName: profile.name }),
          assigneeEmail: profile.email,
        },
      }
    }),
    activeRunsHasMore: active.hasMore,
    finishedRunsHasMore: finished.hasMore,
    startedWorkItemsHasMore: started.hasMore,
  }
}

/**
 * Releases an active run for a Team manager, the member who started it, or the Work Item's current
 * assignee. When only the current assignment grants the authority, the release commits only while
 * the Work Item is still at the revision that was read.
 *
 * @param principal - Releasing member.
 * @param teamId - Team ID.
 * @param runId - Run ID.
 * @param auditContext - Audit context of the request.
 * @returns The released run; a repeated release returns it unchanged.
 */
export async function releaseWebAgentRun(
  principal: WorkspacePrincipal,
  teamId: string,
  runId: string,
  auditContext: MutationAuditContext,
): Promise<AgentRunView> {
  requireWorkspaceBusinessWrite(principal)
  const store = workItemDependencies.agentRuns
  // The returned run is built from the run as read, so a report or heartbeat that commits first
  // sends the release back to read the run again.
  return retryProgressFencedClose(async () => {
    const run = await store.getRun(principal.directoryId, teamId, runId)
    if (!run) throw new AgentRunError('not_found', 'Agent Run was not found.')
    const { detail } = await loadAuthorizedTeamIssue(principal, teamId, run.workItemId, 'member')
    const manager = await isTeamManager(principal, teamId)
    if (!mayRelease(run, principal, manager, detail.issue.assigneeUserId)) {
      throw new AgentRunError('forbidden', 'Only the Work Item assignee or a Team manager can release an Agent Run.')
    }
    const now = new Date()
    if (run.state !== 'active') {
      if (run.outcome === 'released') return toAgentRunView(run, true, now)
      throw createAgentRunNotActiveError()
    }
    const released = finishAgentRun(run, 'released', principal.userKey, now)
    const auditPut = createAgentRunAuditPut(auditContext, released, 'released', 'Agent Run was released by a member.')
    const closeItems = store.createCloseItems(released, undefined, true)
    const assignmentOnly = !manager && run.assigneeUserId !== principal.userKey
    const committed = await commitProgressFencedClose([
      ...closeItems,
      ...(assignmentOnly
        ? [createWorkItemRevisionConditionCheck(
            getTeamIssuesTableName(),
            principal.directoryId,
            teamId,
            run.workItemId,
            detail.issue.revision,
          )]
        : []),
      ...(auditPut ? [auditPut] : []),
    ], closeItems.length, run)
    return committed ? toAgentRunView(released, true, now) : undefined
  })
}

/**
 * Measures a brief for the audit trail without recording its text.
 *
 * @param brief - Brief, if any.
 * @returns UTF-8 size in bytes; `0` when there is none.
 */
function briefBytes(brief: string | undefined): number {
  return brief === undefined ? 0 : Buffer.byteLength(brief, 'utf8')
}

/**
 * Reads Team Agent settings for a Team the viewer can see.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @returns Current settings or the defaults.
 */
export async function getWebAgentSettings(principal: WorkspacePrincipal, teamId: string): Promise<AgentSettings> {
  const permission = await requireTeamPermission(principal, teamId, 'viewer')
  return withVisibleProjectBriefs(principal, permission, await workItemDependencies.agentRuns.getSettings(principal.directoryId, teamId))
}

/**
 * Saves Team Agent settings for a Team manager with revision CAS and an audit event. The body is
 * validated only after the caller is authorized.
 *
 * @param principal - Team manager.
 * @param teamId - Team ID.
 * @param body - Untrusted request body.
 * @param auditContext - Audit context of the request.
 * @returns Saved settings.
 */
export async function updateWebAgentSettings(
  principal: WorkspacePrincipal,
  teamId: string,
  body: unknown,
  auditContext: MutationAuditContext,
): Promise<AgentSettings> {
  requireWorkspaceBusinessWrite(principal)
  const permission = await requireTeamPermission(principal, teamId, 'manager')
  const requested = readUpdateAgentSettingsRequest(body)
  const store = workItemDependencies.agentRuns
  const before = await store.getSettings(principal.directoryId, teamId)
  // Briefs belong to the Team's Projects. A manager sees and edits only the briefs of Projects they
  // can view; the others are kept as saved, and briefs of Projects no longer in the Team are dropped.
  const teamProjectIds = new Set(permission.team.projects.map((project) => project.id))
  for (const projectId of Object.keys(requested.projectBriefs)) {
    if (!teamProjectIds.has(projectId)) {
      throw new AgentRunError('validation_failed', 'A Project brief must name a Project of the Team.', {
        pointer: `/projectBriefs/${projectId.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      })
    }
    requireAssignedProjectPermission(principal, permission, projectId, 'viewer')
  }
  const hiddenBriefs = Object.fromEntries(Object.entries(before.projectBriefs)
    .filter(([projectId]) => teamProjectIds.has(projectId) && !canAccessAssignedProject(principal, permission, projectId, 'viewer')))
  const update = {
    ...requested,
    projectBriefs: { ...requested.projectBriefs, ...hiddenBriefs },
    keptProjectIds: Object.keys(hiddenBriefs),
  }
  assertAgentSettingsBriefLimits(update)
  const now = new Date()
  const auditPut = createMutationAuditEventPut(getConfiguredAuditTableName(), auditContext, {
    directoryId: principal.directoryId,
    eventType: 'agent-settings.updated',
    entityType: 'agent-settings',
    entityId: `team/${teamId}/agent-settings`,
    action: 'updated',
    occurredAt: now.toISOString(),
    summary: 'Agent settings were updated.',
    changes: [
      { field: 'leaseMinutes', before: before.leaseMinutes, after: update.leaseMinutes },
      {
        field: 'allowTakeoverAfterLeaseExpiry',
        before: before.allowTakeoverAfterLeaseExpiry,
        after: update.allowTakeoverAfterLeaseExpiry,
      },
      { field: 'readyStatusIds', before: before.readyStatusIds.join(','), after: update.readyStatusIds.join(',') },
      { field: 'requireAcceptanceCriteria', before: before.requireAcceptanceCriteria, after: update.requireAcceptanceCriteria },
      { field: 'acceptanceCriteriaFieldId', before: before.acceptanceCriteriaFieldId ?? '', after: update.acceptanceCriteriaFieldId ?? '' },
      // Briefs are long user text, so the audit records only their size.
      { field: 'brief.bytes', before: briefBytes(before.brief), after: briefBytes(update.brief) },
      ...[...new Set([...Object.keys(before.projectBriefs), ...Object.keys(update.projectBriefs)])].map((projectId) => ({
        field: `projectBriefs.${projectId}.bytes`,
        before: briefBytes(Object.hasOwn(before.projectBriefs, projectId) ? before.projectBriefs[projectId] : undefined),
        after: briefBytes(Object.hasOwn(update.projectBriefs, projectId) ? update.projectBriefs[projectId] : undefined),
      })),
    ].filter((change) => change.before !== change.after),
    metadata: { adapter: 'agent-settings', teamId, beforeRevision: update.expectedRevision },
  })
  // A retry with the same Idempotency-Key replays the committed save instead of failing its revision check.
  const mutationKey = createHash('sha256')
    .update(`agent-settings\0${principal.userKey}\0${auditContext.idempotencyKeyHash}`)
    .digest('hex')
  const saved = await store.saveSettings(principal.directoryId, teamId, update, principal.userKey, now, mutationKey, auditPut ? [auditPut] : [])
  return withVisibleProjectBriefs(principal, permission, saved)
}
