import { createHash } from 'node:crypto'
import type {
  AgentRunView,
  AgentSettings,
  WorkItemAgentRunReportsResponse,
  WorkItemAgentRunsResponse,
} from '@mukuroji/contracts'
import {
  AgentRunError,
  createAgentRunNotActiveError,
  finishAgentRun,
  readUpdateAgentSettingsRequest,
  toAgentRun,
  toAgentRunReport,
  type StoredAgentRun,
} from '../../modules/agent-runs'
import {
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  type MutationAuditContext,
} from '../../modules/audit/audit'
import { ProjectDataError } from '../../modules/directory'
import { createWorkItemRevisionConditionCheck } from '../../modules/work-items/adapter-out/dynamodb/work-item-client'
import {
  commitProgressFencedClose,
  createAgentRunAuditPut,
  retryProgressFencedClose,
} from '../shared/agent-run-access'
import { workItemDependencies } from '../shared/app-dependencies'
import {
  canWorkspaceBusinessWrite,
  requireAssignedProjectPermission,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { getTeamIssuesTableName, loadAuthorizedTeamIssue } from '../shared/work-item-access'

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
 * Lists a Work Item's newest structured reports for anyone who can see the Work Item. Store cursors
 * never leave the server.
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
  return { items: page.reports.map(toAgentRunReport), hasMore: page.nextCursor !== undefined }
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
 * Reads Team Agent settings for a Team the viewer can see.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @returns Current settings or the defaults.
 */
export async function getWebAgentSettings(principal: WorkspacePrincipal, teamId: string): Promise<AgentSettings> {
  await requireTeamPermission(principal, teamId, 'viewer')
  return workItemDependencies.agentRuns.getSettings(principal.directoryId, teamId)
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
  await requireTeamPermission(principal, teamId, 'manager')
  const update = readUpdateAgentSettingsRequest(body)
  const store = workItemDependencies.agentRuns
  const before = await store.getSettings(principal.directoryId, teamId)
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
    ].filter((change) => change.before !== change.after),
    metadata: { adapter: 'agent-settings', teamId, beforeRevision: update.expectedRevision },
  })
  // A retry with the same Idempotency-Key replays the committed save instead of failing its revision check.
  const mutationKey = createHash('sha256')
    .update(`agent-settings\0${principal.userKey}\0${auditContext.idempotencyKeyHash}`)
    .digest('hex')
  return store.saveSettings(principal.directoryId, teamId, update, principal.userKey, now, mutationKey, auditPut ? [auditPut] : [])
}
