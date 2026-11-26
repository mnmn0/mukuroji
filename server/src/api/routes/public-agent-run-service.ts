import {
  AGENT_RUN_SCHEMA_VERSION,
  DEFAULT_WORK_ITEM_TYPE_ID,
  hasWorkItemAcceptanceCriteria,
  type AgentRun,
  type ReportAgentRunResponse,
  type ResumeAgentRunResponse,
} from '@mukuroji/contracts'
import {
  AgentRunError,
  calculateLeaseExpiry,
  createActiveAgentRun,
  createAgentRunCommitConflictError,
  createAgentRunReportCommentBody,
  createAgentRunConflictError,
  createAgentRunForbiddenError,
  createAgentRunIntegrityError,
  createAgentRunNotActiveError,
  createAgentRunTakeoverDisabledError,
  describeHoldingRun,
  finishAgentRun,
  isAgentRunStalled,
  isClaimHeldBy,
  selectAgentRunFinishNotification,
  selectAgentRunReportNotification,
  toAgentRun,
  toAgentRunReport,
  type StoredAgentRun,
  type StoredAgentRunReport,
} from '../../modules/agent-runs'
import {
  CollaborationError,
  createProjectCollaborationEntityKey,
  createWorkItemCollaborationEntityKey,
  deriveAuditedCommentId,
} from '../../modules/collaboration'
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import type { PublicAgentRunService } from '../../modules/developer-platform/public-api'
import { ProjectDataError } from '../../modules/directory'
import { createTeamIssueDeepLink } from '../../modules/work-items'
import {
  createAuthorizationSnapshotConditionChecks,
  createWorkItemAuthorizationChangedError,
  createWorkItemRevisionConditionCheck,
  type WorkItemAuthorizationSnapshot,
} from '../../modules/work-items/adapter-out/dynamodb/work-item-client'
import { resolveWorkItemTypeWorkflow } from '../../modules/work-items/work-item-configuration'
import {
  AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM,
  commitProgressFencedClose,
  createAgentRunAuditPut,
  isAgentRunFenceConflict,
  mapInOrderWithConcurrency,
  retryProgressFencedClose,
  withVisibleProjectBriefs,
} from '../shared/agent-run-access'
import { workItemDependencies } from '../shared/app-dependencies'
import {
  createCollaborationCommentAuthorizationConditionChecks,
  createTeamIssueAutomaticWatcherCandidates,
} from '../shared/collaboration-access'
import { createCommentSearchDocument } from '../shared/document-access'
import { listWorkItemAgentRunQuestions } from './web-agent-run-answer-service'
import { projectWorkspaceSearchDocumentBestEffort } from '../shared/search-access'
import { resolveDeveloperCredentialPrincipal } from '../shared/developer-platform-access'
import {
  canAccessAssignedProject,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from '../shared/project-access'
import {
  createWorkItemIdempotencyTransaction,
  getTeamIssuesTableName,
  loadAuthorizedTeamIssue,
} from '../shared/work-item-access'
import { createMutationAuditContext } from '../../modules/audit/audit'
import { projectPublicWorkItem, resolveStableWorkItemAuthorization, updateCanonicalPublicWorkItem } from './public-api-routes'

/**
 * Checks whether the caller's access changed after an Agent Run mutation was authorized, so that a
 * transaction cancelled by an access guard is reported as a conflict rather than as retryable.
 *
 * @param current - Caller resolved again after the transaction was cancelled.
 * @param snapshot - Access observed when the mutation was authorized.
 * @returns True when the membership, Planning, Enterprise Identity, or OrgUnit structure revision
 * differs.
 */
async function hasAuthorizationChanged(current: WorkspacePrincipal, snapshot: WorkItemAuthorizationSnapshot): Promise<boolean> {
  return current.workspaceMember.version !== snapshot.workspaceMemberVersion ||
    current.enterpriseIdentityControlRevision !== snapshot.enterpriseControlRevision ||
    current.enterpriseOrgStructureRevision !== snapshot.orgStructureRevision ||
    await workItemDependencies.planning.getAuthorizationRevision(snapshot.workspaceId) !== snapshot.planningRevision
}

/**
 * Resolves the credential owner for an Agent Run read.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team ID.
 * @returns Authorized principal.
 */
async function resolveReader(credential: AuthenticatedDeveloperCredential, teamId: string): Promise<WorkspacePrincipal> {
  return resolveDeveloperCredentialPrincipal(credential, {
    permission: 'work-items.read',
    teamId,
    evaluateProjectScopes: true,
  })
}

/**
 * Resolves the credential owner for an Agent Run write.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team ID.
 * @returns Authorized principal with business write access.
 */
async function resolveWriter(credential: AuthenticatedDeveloperCredential, teamId: string): Promise<WorkspacePrincipal> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'work-items.write',
    teamId,
    evaluateProjectScopes: true,
  })
  requireWorkspaceBusinessWrite(principal)
  return principal
}

/**
 * Loads a run that exists in the Team.
 *
 * @param principal - Authorized principal.
 * @param teamId - Team ID.
 * @param runId - Run ID.
 * @returns The run.
 */
async function requireRun(principal: WorkspacePrincipal, teamId: string, runId: string): Promise<StoredAgentRun> {
  const run = await workItemDependencies.agentRuns.getRun(principal.directoryId, teamId, runId)
  if (!run) throw new AgentRunError('not_found', 'Agent Run was not found.')
  return run
}

/**
 * Loads the caller's own run after rechecking access to its Work Item and the instance that started it.
 *
 * @param principal - Authorized writer.
 * @param teamId - Team ID.
 * @param runId - Run ID.
 * @param instanceIdHash - Hash of the instance ID the caller sent.
 * @returns The run and the revision of its Work Item that was read.
 */
async function requireOwnRun(
  principal: WorkspacePrincipal,
  teamId: string,
  runId: string,
  instanceIdHash: string,
): Promise<{
  /** Caller's run. */
  run: StoredAgentRun
  /** Current assignee of the run's Work Item. */
  workItemAssigneeUserId: string
  /** Current Project of the run's Work Item. */
  workItemProjectId: string | undefined
  /** Revision of the run's Work Item that was read. */
  workItemRevision: number
}> {
  const run = await requireRun(principal, teamId, runId)
  if (run.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
  const { detail } = await loadAuthorizedTeamIssue(principal, teamId, run.workItemId, 'member')
  if (run.instanceIdHash !== instanceIdHash) {
    // Another instance of the same user must not keep alive or close a run it did not start.
    if (run.state !== 'active') throw createAgentRunNotActiveError()
    throw createAgentRunConflictError(describeHoldingRun(run, new Date()))
  }
  return {
    run,
    workItemAssigneeUserId: detail.issue.assigneeUserId,
    workItemProjectId: detail.issue.assignedProjectId,
    workItemRevision: detail.issue.revision,
  }
}

/**
 * Rejects a Work Item outside the Project the caller restricted its request to.
 *
 * @param workItemProjectId - Current Project of the Work Item.
 * @param assignedProjectId - Project the caller sent, if any.
 */
function requireRequestedProject(workItemProjectId: string | undefined, assignedProjectId: string | undefined): void {
  if (assignedProjectId !== undefined && workItemProjectId !== assignedProjectId) {
    throw new AgentRunError('forbidden', 'Work Item is outside the requested Project.')
  }
}

/**
 * Strongly reads the run that claims a Work Item.
 *
 * A finish, release, or take over can commit between the claim read and the run read, so a claim
 * whose run is no longer active is read once more; only a claim that still names it is inconsistent.
 *
 * @param principal - Authorized reader.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns The claiming active run, or undefined when no run claims the Work Item.
 */
async function readClaimedRun(principal: WorkspacePrincipal, teamId: string, workItemId: string): Promise<StoredAgentRun | undefined> {
  const store = workItemDependencies.agentRuns
  let previousRunId: string | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claim = await store.getClaim(principal.directoryId, teamId, workItemId)
    if (!claim) return undefined
    const run = await store.getRun(principal.directoryId, teamId, claim.runId)
    if (run?.state === 'active' && run.workItemId === workItemId) {
      // An active run must be the holder the claim records; a mismatch is not a race.
      if (!isClaimHeldBy(claim, run)) break
      return run
    }
    if (claim.runId === previousRunId) break
    previousRunId = claim.runId
  }
  throw createAgentRunIntegrityError()
}

/**
 * Explains why a take over found the stalled run or its claim changed, by re-reading the run.
 *
 * @param principal - Authorized principal.
 * @param teamId - Team ID.
 * @param runId - Run being taken over.
 * @returns Not active when the run closed first, a conflict when it renewed its lease, and an
 * integrity error when a still stalled run no longer holds its claim.
 */
async function explainTakeOverMiss(principal: WorkspacePrincipal, teamId: string, runId: string): Promise<AgentRunError> {
  // A finish, release, or other take over may have closed the run, or a heartbeat renewed it.
  const latest = await workItemDependencies.agentRuns.getRun(principal.directoryId, teamId, runId)
  const readAt = new Date()
  if (latest?.state !== 'active') return createAgentRunNotActiveError()
  if (!isAgentRunStalled(latest, readAt)) return createAgentRunConflictError(describeHoldingRun(latest, readAt), '/instanceId')
  // A claim is closed together with its run, so a stalled run that does not hold its claim is inconsistent.
  return createAgentRunIntegrityError()
}

/**
 * Explains why a report's transaction failed, by re-reading the run.
 *
 * @param principal - Authorized principal.
 * @param teamId - Team ID.
 * @param run - Run as read before the report.
 * @param assignedProjectId - Project the caller restricted the report to, when it sent one.
 * @param error - Error the comment write raised.
 * @returns Not active when the run closed or changed hands, a retryable conflict when another
 * report or a heartbeat of the run committed first, an integrity error when the active run lost its claim,
 * a permission error when the Work Item was reassigned or left the requested Project, and the original
 * error otherwise.
 */
async function explainReportFailure(
  principal: WorkspacePrincipal,
  teamId: string,
  run: StoredAgentRun,
  assignedProjectId: string | undefined,
  error: unknown,
): Promise<unknown> {
  if (!(error instanceof CollaborationError) || error.status !== 409) return error
  const store = workItemDependencies.agentRuns
  const latest = await store.getRun(principal.directoryId, teamId, run.runId)
  if (latest?.state !== 'active' || latest.instanceIdHash !== run.instanceIdHash) return createAgentRunNotActiveError()
  // Retrying with the same key renumbers the report after the one that committed first, or renews the
  // lease from a time after the heartbeat that won.
  if (latest.reportCount !== run.reportCount || latest.lastHeartbeatAt !== run.lastHeartbeatAt) return createAgentRunCommitConflictError()
  const claim = await store.getClaim(principal.directoryId, teamId, run.workItemId)
  if (!isClaimHeldBy(claim, latest)) return createAgentRunIntegrityError()
  // The comment write conditions on the Work Item's assignee and Project, which may have changed since the read.
  const { detail } = await loadAuthorizedTeamIssue(principal, teamId, run.workItemId, 'member')
  if (detail.issue.assigneeUserId !== principal.userKey) return createAgentRunForbiddenError()
  if (assignedProjectId !== undefined && detail.issue.assignedProjectId !== assignedProjectId) {
    return new AgentRunError('forbidden', 'Work Item is outside the requested Project.')
  }
  return error
}

/**
 * Reports that another run holds a Work Item, failing closed when the claim is inconsistent.
 *
 * @param principal - Authorized principal.
 * @param teamId - Team ID.
 * @param runId - Holding run named by the claim.
 * @param now - Read time.
 * @returns Conflict error.
 */
async function createHolderConflict(principal: WorkspacePrincipal, teamId: string, runId: string, now: Date): Promise<AgentRunError> {
  const holder = await workItemDependencies.agentRuns.getRun(principal.directoryId, teamId, runId)
  if (!holder || holder.state !== 'active') return createAgentRunIntegrityError()
  return createAgentRunConflictError(describeHoldingRun(holder, now))
}

/**
 * Rejects a new run while the Team has stopped accepting them. The run's settings revision check
 * also fails the commit if a manager turns the switch off meanwhile.
 *
 * @param settings - Team Agent settings read for the run.
 * @param settings.acceptNewRuns - Whether the Team accepts new runs.
 * @throws AgentRunError conflict with reason `not_ready` while the Team does not accept new runs.
 */
function requireAcceptingNewRuns(settings: { acceptNewRuns: boolean }): void {
  if (settings.acceptNewRuns) return
  throw new AgentRunError(
    'conflict',
    'The Team has stopped accepting new Agent Runs. Ask a Team manager before starting work.',
    { reason: 'not_ready', pointer: '/acceptNewRuns' },
  )
}

/**
 * Rejects a resume that the Work Item or the Team's settings do not allow: the caller must be the
 * assignee, the Work Item must be in a started status the Team marks as resumable, and it must still
 * be at the revision the caller read.
 *
 * @param principal - Authorized writer.
 * @param issue - Work Item as read.
 * @param issue.assigneeUserId - Member responsible for the Work Item.
 * @param issue.statusCategory - Category of the Work Item's status.
 * @param issue.workflowStatusId - The Work Item's status.
 * @param issue.revision - Revision that was read.
 * @param expectedRevision - Revision the caller read before deciding to resume.
 * @param resumableStatusIds - Started statuses the Team allows resuming from; empty means any.
 */
function requireResumable(
  principal: WorkspacePrincipal,
  issue: {
    /** Member responsible for the Work Item. */
    assigneeUserId: string
    /** Category of the Work Item's status. */
    statusCategory: string
    /** The Work Item's status. */
    workflowStatusId?: string
    /** Revision that was read. */
    revision: number
  },
  expectedRevision: number,
  resumableStatusIds: readonly string[],
): void {
  if (issue.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
  if (issue.statusCategory !== 'started') {
    throw new AgentRunError(
      'conflict',
      'An Agent Run resumes only a started Work Item. Start it from a Ready status instead.',
      { reason: 'invalid_transition' },
    )
  }
  if (resumableStatusIds.length > 0 && !resumableStatusIds.includes(issue.workflowStatusId ?? '')) {
    throw new AgentRunError(
      'conflict',
      'The Work Item is not in a status the Team marks as resumable by agents.',
      { reason: 'not_resumable' },
    )
  }
  if (issue.revision !== expectedRevision) {
    throw new ProjectDataError(409, 'WorkItemRevisionConflict', 'Work Item revision does not match the expected revision.')
  }
}

/**
 * Chooses the start time of a run that follows another on the same Work Item (a start, resume, or take
 * over): now, but always after that run, so that a clock behind that run's still lists the new run first
 * in the history. Only the start time
 * moves; the heartbeat and lease keep this server's time, so the run's own reports and heartbeats are
 * not refused.
 *
 * @param previous - Run the new run follows, if any.
 * @param now - This server's time.
 * @returns Start time of the new run.
 */
function resumeStartedAt(previous: StoredAgentRun | undefined, now: Date): string {
  if (previous === undefined) return now.toISOString()
  return new Date(Math.max(now.getTime(), Date.parse(previous.startedAt) + 1)).toISOString()
}

/** Concurrent reads per run listing page. */
const listReadConcurrency = 10

/**
 * Reads the Project a Work Item is assigned to from the committed Work Item, so a move to another
 * Project or a deletion takes effect immediately.
 *
 * @param principal - Authorized reader.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns The assigned Project, undefined when unassigned, or null when the Work Item was deleted.
 */
async function readAssignedProjectId(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<string | undefined | null> {
  try {
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      teamId,
      workItemId,
      { consistentIssueRead: true, includeEvents: false },
    )
    return detail.issue.assignedProjectId
  } catch (error) {
    // A deleted Work Item's runs are no longer visible to anyone.
    if (error instanceof ProjectDataError && error.status === 404) return null
    throw error
  }
}

/**
 * Creates the Public API Agent Run service backed by canonical Work Items and the Agent Run store.
 *
 * @returns Agent Run service.
 */
export function createCanonicalPublicAgentRunService(): PublicAgentRunService {
  return {
    /** Rechecks that the caller can still write the Work Item before a start receipt replays. */
    async authorizeStart(credential, teamId, workItemId) {
      const principal = await resolveWriter(credential, teamId)
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
    },

    /** Moves the Work Item to started and claims it in one transaction. */
    async start(credential, teamId, workItemId, input, context, idempotency) {
      let started: StoredAgentRun | undefined
      let startedAt = new Date()
      const { issue } = await updateCanonicalPublicWorkItem(
        credential,
        teamId,
        workItemId,
        { expectedRevision: input.expectedRevision, workflowStatusId: input.workflowStatusId },
        context,
        idempotency,
        {
          auditRequest: {
            method: 'POST',
            path: `/api/v1/work-items/${encodeURIComponent(workItemId)}/agent-runs`,
            query: { teamId },
            body: {
              expectedRevision: input.expectedRevision,
              workflowStatusId: input.workflowStatusId,
              runtime: input.runtime,
              agentName: input.agentName,
            },
          },
          extension: {
            async prepare({ principal, issue: current, resolvedConfiguration, auditContext, now }) {
              if (current.revision !== input.expectedRevision) {
                throw new ProjectDataError(409, 'WorkItemRevisionConflict', 'Work Item revision does not match the expected revision.')
              }
              if (current.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
              const workflow = resolveWorkItemTypeWorkflow(
                resolvedConfiguration.configuration,
                current.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
              )
              const target = workflow.statuses.find((status) => status.id === input.workflowStatusId)
              if (
                (current.statusCategory !== 'backlog' && current.statusCategory !== 'unstarted') ||
                target?.category !== 'started'
              ) {
                throw new AgentRunError(
                  'conflict',
                  'An Agent Run starts only from a backlog or unstarted status into a started status.',
                  { reason: 'invalid_transition', pointer: '/workflowStatusId' },
                )
              }
              const store = workItemDependencies.agentRuns
              const claim = await store.getClaim(principal.directoryId, teamId, workItemId)
              if (claim) throw await createHolderConflict(principal, teamId, claim.runId, now)
              const settings = await store.getSettings(principal.directoryId, teamId)
              // The settings revision check below also fails the start if the switch or Ready statuses change meanwhile.
              requireAcceptingNewRuns(settings)
              if (settings.readyStatusIds.length > 0 && !settings.readyStatusIds.includes(current.workflowStatusId ?? '')) {
                throw new AgentRunError(
                  'conflict',
                  'The Work Item is not in a status the Team marks as ready for agents.',
                  { reason: 'not_ready', pointer: '/workflowStatusId' },
                )
              }
              if (settings.requireAcceptanceCriteria && !hasWorkItemAcceptanceCriteria(current, settings.acceptanceCriteriaFieldId)) {
                throw new AgentRunError(
                  'conflict',
                  'The Team requires acceptance criteria before agents start, and this Work Item has none.',
                  { reason: 'not_ready', pointer: '/acceptanceCriteria' },
                )
              }
              // A run that started on a server whose clock was ahead must still sort before this one, so the
              // history and the latest-run record agree on which run came last. The Work Item revision check
              // fails this start if another run starts meanwhile.
              const latestRunId = await store.getLatestRunId(principal.directoryId, teamId, workItemId)
              const previous = latestRunId === undefined
                ? undefined
                : await store.getRun(principal.directoryId, teamId, latestRunId)
              const created = createActiveAgentRun({
                directoryId: principal.directoryId,
                teamId,
                workItemId,
                assigneeUserId: principal.userKey,
                start: input,
                credentialId: credential.credentialId,
                startRevision: current.revision + 1,
                leaseMinutes: settings.leaseMinutes,
                now,
              })
              const run = { ...created, startedAt: resumeStartedAt(previous, now) }
              started = run
              startedAt = now
              const auditPut = createAgentRunAuditPut(
                auditContext, run, 'started', 'Agent Run started.', AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM,
              )
              return {
                transactItems: [
                  ...store.createStartItems(run),
                  // The lease length is fixed for the run, so settings saved meanwhile must not be missed.
                  store.createSettingsRevisionCheck(principal.directoryId, teamId, settings.revision),
                  ...(auditPut ? [auditPut] : []),
                ],
                createReceipt: (workItem) => ({ status: 201, body: { run: toAgentRun(run, now), workItem } }),
                async classifyFailure(error) {
                  if (!isAgentRunFenceConflict(error)) return error
                  const latest = await store.getClaim(principal.directoryId, teamId, workItemId)
                  if (latest) return createHolderConflict(principal, teamId, latest.runId, new Date())
                  const latestSettings = await store.getSettings(principal.directoryId, teamId)
                  if (!latestSettings.acceptNewRuns) {
                    return new AgentRunError(
                      'conflict',
                      'The Team has stopped accepting new Agent Runs. Ask a Team manager before starting work.',
                      { reason: 'not_ready', pointer: '/acceptNewRuns' },
                    )
                  }
                  if (latestSettings.revision !== settings.revision) {
                    return new AgentRunError('conflict', 'Agent settings changed during the request. Retry the start.')
                  }
                  return new AgentRunError('conflict', 'The Agent Run claim changed during the request. Reload the task and retry.')
                },
              }
            },
          },
        },
      )
      if (!started) throw new Error('The Agent Run start transaction committed without a run.')
      return { run: toAgentRun(started, startedAt), workItem: projectPublicWorkItem(issue) }
    },

    /** Lists a Work Item's questions for an agent, with the answers people recorded. */
    async listWorkItemQuestions(credential, teamId, workItemId) {
      const principal = await resolveReader(credential, teamId)
      return listWorkItemAgentRunQuestions(principal, teamId, workItemId)
    },

    /** Lists one Work Item's runs after checking that the caller can see it. */
    async listWorkItemRuns(credential, teamId, workItemId, continuation, limit) {
      const principal = await resolveReader(credential, teamId)
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
      const page = await workItemDependencies.agentRuns.listWorkItemRuns(principal.directoryId, teamId, workItemId, continuation, limit)
      const now = new Date()
      return {
        items: page.runs.map((run) => toAgentRun(run, now)),
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextContinuation: page.nextCursor }),
      }
    },

    /** Lists a Team's runs, keeping only runs whose Work Item the caller can see. */
    async list(credential, teamId, filters, continuation, limit) {
      const principal = await resolveReader(credential, teamId)
      const permission = await requireTeamPermission(principal, teamId, 'viewer')
      const store = workItemDependencies.agentRuns
      const now = new Date()
      if (filters.workItemId !== undefined) {
        // The claim row is read strongly, so a run started moments ago is found before the index has it.
        const assignedProjectId = await readAssignedProjectId(principal, teamId, filters.workItemId)
        if (assignedProjectId === null || !canAccessAssignedProject(principal, permission, assignedProjectId, 'viewer')) {
          return { items: [], hasMore: false }
        }
        const run = await readClaimedRun(principal, teamId, filters.workItemId)
        const matches = run !== undefined &&
          (filters.instanceIdHash === undefined || run.instanceIdHash === filters.instanceIdHash) &&
          (filters.assigneeUserId === undefined || run.assigneeUserId === filters.assigneeUserId)
        return { items: matches ? [toAgentRun(run, now)] : [], hasMore: false }
      }
      const page = filters.state === 'active'
        ? await store.listActiveRuns(principal.directoryId, teamId, continuation, limit)
        : await store.listFinishedRuns(principal.directoryId, teamId, continuation, limit)
      const candidates = page.runs.filter((run) =>
        (filters.instanceIdHash === undefined || run.instanceIdHash === filters.instanceIdHash) &&
        (filters.assigneeUserId === undefined || run.assigneeUserId === filters.assigneeUserId))
      const visible = await mapInOrderWithConcurrency(candidates, listReadConcurrency, async (indexed) => {
        // The indexes can still show a run's state from before it closed, so the run is read again.
        const [run, assignedProjectId] = await Promise.all([
          store.getRun(principal.directoryId, teamId, indexed.runId),
          readAssignedProjectId(principal, teamId, indexed.workItemId),
        ])
        if (!run || run.state !== filters.state || assignedProjectId === null) return undefined
        return canAccessAssignedProject(principal, permission, assignedProjectId, 'viewer') ? run : undefined
      })
      const items: AgentRun[] = visible.flatMap((run) => run ? [toAgentRun(run, now)] : [])
      return {
        items,
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextContinuation: page.nextCursor }),
      }
    },

    /** Reads one run after checking that the caller can see its Work Item. */
    async get(credential, teamId, runId) {
      const principal = await resolveReader(credential, teamId)
      const run = await requireRun(principal, teamId, runId)
      await loadAuthorizedTeamIssue(principal, teamId, run.workItemId, 'viewer')
      return toAgentRun(run, new Date())
    },

    /** Extends the caller's own lease. */
    async heartbeat(credential, teamId, runId, instanceIdHash) {
      const principal = await resolveWriter(credential, teamId)
      const { run, workItemAssigneeUserId, workItemRevision } = await requireOwnRun(principal, teamId, runId, instanceIdHash)
      if (run.state !== 'active') throw createAgentRunNotActiveError()
      // A member who is no longer responsible for the Work Item cannot keep its claim alive; finishing stays allowed.
      if (workItemAssigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
      const now = new Date()
      return toAgentRun(await workItemDependencies.agentRuns.heartbeat(run, instanceIdHash, now, [
        createWorkItemRevisionConditionCheck(getTeamIssuesTableName(), principal.directoryId, teamId, run.workItemId, workItemRevision),
      ]), now)
    },

    /** Rechecks ownership before a finish receipt replays. */
    async authorizeFinish(credential, teamId, runId, instanceIdHash) {
      const principal = await resolveWriter(credential, teamId)
      await requireOwnRun(principal, teamId, runId, instanceIdHash)
    },

    /** Closes the caller's own run and removes its claim. */
    async finish(credential, teamId, runId, { outcome, instanceIdHash }, context, idempotency) {
      const principal = await resolveWriter(credential, teamId)
      // The response and receipt are built from the run as read, so a report or heartbeat that
      // commits first sends the close back to read the run again.
      return retryProgressFencedClose(async () => {
        const { run, workItemRevision, workItemProjectId } = await requireOwnRun(principal, teamId, runId, instanceIdHash)
        const now = new Date()
        if (run.state !== 'active') {
          if (run.outcome === outcome && run.finishedBy === 'agent') return toAgentRun(run, now)
          throw createAgentRunNotActiveError()
        }
        const finished = finishAgentRun(run, outcome, 'agent', now)
        const notification = selectAgentRunFinishNotification(
          await workItemDependencies.agentRuns.getSettings(principal.directoryId, teamId), outcome, workItemProjectId,
        )
        const auditContext = createMutationAuditContext({
          workspaceId: principal.directoryId,
          actor: { id: principal.actorId, kind: 'user', displayName: principal.userKey },
          idempotencyKey: context.idempotencyKey,
          ...(context.correlationId ? { correlationId: context.correlationId } : {}),
          request: {
            method: 'POST',
            path: `/api/v1/agent-runs/${encodeURIComponent(runId)}/finish`,
            // The instance ID is a bearer-like secret of the agent; only the outcome is audited.
            body: { outcome },
          },
          source: {
            kind: 'api',
            requestId: context.requestId,
            method: 'POST',
            route: `/api/v1/agent-runs/${encodeURIComponent(runId)}/finish`,
          },
        })
        const response = toAgentRun(finished, now)
        const auditPut = createAgentRunAuditPut(
          auditContext, finished, 'finished', `Agent Run finished as ${outcome}.`, undefined, notification,
        )
        const receipt = await createWorkItemIdempotencyTransaction(principal.directoryId, idempotency)
          ?.prepare({ status: 200, body: response })
        const store = workItemDependencies.agentRuns
        const closeItems = store.createCloseItems(finished, instanceIdHash, true)
        const committed = await commitProgressFencedClose([
          ...closeItems,
          // The finish was authorized against this Work Item state; a concurrent move out of the
          // credential's scope must win.
          createWorkItemRevisionConditionCheck(getTeamIssuesTableName(), principal.directoryId, teamId, run.workItemId, workItemRevision),
          ...(auditPut ? [auditPut] : []),
          ...(receipt ? [receipt.transactWriteItem] : []),
        ], closeItems.length, run)
        return committed ? response : undefined
      })
    },

    /** Rechecks ownership and the requested Project before a report receipt replays. */
    async authorizeReport(credential, teamId, runId, instanceIdHash, assignedProjectId) {
      const principal = await resolveWriter(credential, teamId)
      const { workItemProjectId } = await requireOwnRun(principal, teamId, runId, instanceIdHash)
      requireRequestedProject(workItemProjectId, assignedProjectId)
    },

    /** Saves a structured report, its comment, and the run's renewed lease in one transaction. */
    async report(credential, teamId, runId, input, context, idempotency, assignedProjectId) {
      const principal = await resolveWriter(credential, teamId)
      const run = await requireRun(principal, teamId, runId)
      if (run.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
      const { context: permissionContext, detail } = await loadAuthorizedTeamIssue(principal, teamId, run.workItemId, 'member')
      if (run.instanceIdHash !== input.instanceIdHash) {
        if (run.state !== 'active') throw createAgentRunNotActiveError()
        throw createAgentRunConflictError(describeHoldingRun(run, new Date()), '/instanceId')
      }
      if (run.state !== 'active') throw createAgentRunNotActiveError()
      // Like heartbeats, reports cannot keep alive a run whose Work Item now belongs to someone else.
      if (detail.issue.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
      // The comment write conditions on the Work Item's current Project, so a later move also fails it.
      requireRequestedProject(detail.issue.assignedProjectId, assignedProjectId)
      const store = workItemDependencies.agentRuns
      const claim = await store.getClaim(principal.directoryId, teamId, run.workItemId)
      if (!isClaimHeldBy(claim, run)) {
        const latest = await store.getRun(principal.directoryId, teamId, runId)
        if (latest?.state !== 'active') throw createAgentRunNotActiveError()
        throw createAgentRunIntegrityError()
      }
      const now = new Date()
      const createdAt = now.toISOString()
      const path = `/api/v1/agent-runs/${encodeURIComponent(runId)}/reports`
      const auditContext = createMutationAuditContext({
        workspaceId: principal.directoryId,
        actor: { id: principal.actorId, kind: 'user', displayName: principal.userKey },
        idempotencyKey: context.idempotencyKey,
        ...(context.correlationId ? { correlationId: context.correlationId } : {}),
        occurredAt: createdAt,
        request: {
          method: 'POST',
          path,
          query: { teamId },
          // The instance ID is a bearer-like secret of the agent and is never audited.
          body: {
            kind: input.kind,
            message: input.message,
            verifications: input.verifications,
            artifacts: input.artifacts,
            ...(input.changedFileCount === undefined ? {} : { changedFileCount: input.changedFileCount }),
          },
        },
        source: { kind: 'api', requestId: context.requestId, method: 'POST', route: path },
      })
      const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, run.workItemId)
      const commentId = deriveAuditedCommentId(entityKey, auditContext)
      const report: StoredAgentRunReport = {
        schemaVersion: AGENT_RUN_SCHEMA_VERSION,
        runId,
        directoryId: principal.directoryId,
        teamId,
        workItemId: run.workItemId,
        sequence: run.reportCount + 1,
        kind: input.kind,
        commentId,
        verifications: input.verifications,
        artifacts: input.artifacts,
        ...(input.changedFileCount === undefined ? {} : { changedFileCount: input.changedFileCount }),
        createdAt,
        createdBy: principal.userKey,
      }
      const reported: StoredAgentRun = {
        ...run,
        reportCount: report.sequence,
        lastReportKind: report.kind,
        lastReportAt: createdAt,
        lastHeartbeatAt: createdAt,
        leaseExpiresAt: calculateLeaseExpiry(now, run.leaseMinutes),
      }
      const body = createAgentRunReportCommentBody(run.agentName, input.message)
      const response: ReportAgentRunResponse = {
        report: toAgentRunReport(report),
        comment: { id: commentId, actorUserId: principal.userKey, body, createdAt },
        run: toAgentRun(reported, now),
      }
      const notification = selectAgentRunReportNotification(
        await store.getSettings(principal.directoryId, teamId), report.kind, detail.issue.assignedProjectId,
      )
      const auditPut = createAgentRunAuditPut(
        auditContext,
        reported,
        'reported',
        `Agent Run saved a ${report.kind} report.`,
        AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM,
        notification,
      )
      const receipt = await createWorkItemIdempotencyTransaction(principal.directoryId, idempotency)
        ?.prepare({ status: 201, body: response })
      const projectId = detail.issue.assignedProjectId
      const authorizationConditionChecks = await createCollaborationCommentAuthorizationConditionChecks(
        principal, permissionContext, teamId, projectId,
      )
      const comment = await workItemDependencies.collaboration.createComment({
        workspaceId: principal.directoryId,
        teamId,
        issueId: run.workItemId,
        workItemTitle: detail.issue.title,
        entityKey,
        projectId,
        projectEntityKey: projectId ? createProjectCollaborationEntityKey(principal.directoryId, projectId) : undefined,
        assigneeMemberKey: detail.issue.assigneeUserId,
        actorMemberKey: principal.userKey,
        bodyMarkdown: body,
        mentionMemberKeys: [],
        automaticWatcherCandidates: createTeamIssueAutomaticWatcherCandidates(detail.issue),
        deepLink: createTeamIssueDeepLink(teamId, run.workItemId),
        authorizationConditionChecks,
        coWrites: [
          ...store.createReportItems(run, report, now),
          ...(auditPut ? [auditPut] : []),
          ...(receipt ? [receipt.transactWriteItem] : []),
        ],
        auditContext,
      }).catch(async (error: unknown) => {
        throw await explainReportFailure(principal, teamId, run, assignedProjectId, error)
      })
      if (comment.id !== commentId || comment.createdAt !== createdAt) throw createAgentRunIntegrityError()
      await projectWorkspaceSearchDocumentBestEffort(() => createCommentSearchDocument(
        principal.directoryId, teamId, detail.issue, comment,
      ), 'Agent Run report comment creation')
      return response
    },

    /** Rechecks permissions before a take over receipt replays. */
    async authorizeTakeOver(credential, teamId, workItemId) {
      const principal = await resolveWriter(credential, teamId)
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
    },

    /** Supersedes a stalled run of another instance and claims the Work Item for the caller in one transaction. */
    async takeOver(credential, teamId, workItemId, runId, input, context, idempotency) {
      // Like a start or a resume, the take over commits only while the member, Team, and Project access
      // it was authorized with is unchanged.
      const authorization = await resolveStableWorkItemAuthorization(
        credential.workspaceId,
        async () => await resolveWriter(credential, teamId),
        async (principal) => (await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')).detail,
      )
      const { principal, authorizationSnapshot } = authorization
      const detail = authorization.value
      if (detail.issue.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
      const store = workItemDependencies.agentRuns
      const settings = await store.getSettings(principal.directoryId, teamId)
      // A Team that stopped accepting runs reports that first, even when take over is also disabled.
      requireAcceptingNewRuns(settings)
      if (!settings.allowTakeoverAfterLeaseExpiry) throw createAgentRunTakeoverDisabledError()
      if (detail.issue.statusCategory !== 'started') {
        throw new AgentRunError('conflict', 'Only a run on a started Work Item can be taken over. Ask a person to release it.', {
          reason: 'invalid_transition',
        })
      }
      const run = await requireRun(principal, teamId, runId)
      if (run.workItemId !== workItemId || run.state !== 'active') throw createAgentRunNotActiveError()
      // Only another instance of the same member may take over; other members' runs need a person to release them.
      if (run.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
      if (run.instanceIdHash === input.instanceIdHash) {
        throw new AgentRunError('conflict', 'This instance already holds the run. Continue it instead of taking it over.', {
          reason: 'agent_run_conflict', pointer: '/instanceId',
        })
      }
      const now = new Date()
      if (!isAgentRunStalled(run, now)) throw createAgentRunConflictError(describeHoldingRun(run, now), '/instanceId')
      const claim = await store.getClaim(principal.directoryId, teamId, workItemId)
      if (!isClaimHeldBy(claim, run)) throw await explainTakeOverMiss(principal, teamId, runId)
      const superseded = finishAgentRun(run, 'superseded', principal.userKey, now)
      const created = createActiveAgentRun({
        directoryId: principal.directoryId,
        teamId,
        workItemId,
        assigneeUserId: principal.userKey,
        start: input,
        credentialId: credential.credentialId,
        startRevision: detail.issue.revision,
        leaseMinutes: settings.leaseMinutes,
        now,
      })
      // Like a resume, only the history position moves after the stalled run; the lease keeps this clock.
      const successor = { ...created, startedAt: resumeStartedAt(run, now) }
      const path = `/api/v1/work-items/${encodeURIComponent(workItemId)}/agent-runs/${encodeURIComponent(runId)}/take-over`
      const auditContext = createMutationAuditContext({
        workspaceId: principal.directoryId,
        actor: { id: principal.actorId, kind: 'user', displayName: principal.userKey },
        idempotencyKey: context.idempotencyKey,
        ...(context.correlationId ? { correlationId: context.correlationId } : {}),
        // The instance ID is a bearer-like secret of the agent; only its runtime and name are audited.
        request: { method: 'POST', path, body: { runtime: input.runtime, agentName: input.agentName } },
        source: { kind: 'api', requestId: context.requestId, method: 'POST', route: path },
      })
      const response = { run: toAgentRun(successor, now), supersededRun: toAgentRun(superseded, now) }
      const supersededAudit = createAgentRunAuditPut(auditContext, superseded, 'taken-over', 'Agent Run was taken over by another instance.')
      const startedAudit = createAgentRunAuditPut(
        auditContext, successor, 'started', 'Agent Run took over a stalled run.', AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM,
      )
      const receipt = await createWorkItemIdempotencyTransaction(principal.directoryId, idempotency)
        ?.prepare({ status: 201, body: response })
      const takeOverItems = store.createTakeOverItems(superseded, successor)
      try {
        await store.commit([
          ...takeOverItems,
          // The take over was authorized against this assignment and these settings.
          createWorkItemRevisionConditionCheck(getTeamIssuesTableName(), principal.directoryId, teamId, workItemId, detail.issue.revision),
          store.createSettingsRevisionCheck(principal.directoryId, teamId, settings.revision),
          // The caller's membership and Team and Project access must not have changed since authorization.
          ...createAuthorizationSnapshotConditionChecks(authorizationSnapshot),
          ...(supersededAudit ? [supersededAudit] : []),
          ...(startedAudit ? [startedAudit] : []),
          ...(receipt ? [receipt.transactWriteItem] : []),
        ], 2)
      } catch (error) {
        if (!(error instanceof AgentRunError)) throw error
        if (error.reason === 'agent_run_not_active') throw await explainTakeOverMiss(principal, teamId, runId)
        if (error.category !== 'temporarily_unavailable') throw error
        // A guard failed: report what changed instead of a retryable failure. Access is resolved again
        // first, so a caller who lost access meanwhile gets the same answer as on a new request.
        const current = await resolveWriter(credential, teamId)
        const latest = await loadAuthorizedTeamIssue(current, teamId, workItemId, 'member')
        if (latest.detail.issue.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
        if (latest.detail.issue.statusCategory !== 'started') {
          throw new AgentRunError('conflict', 'Only a run on a started Work Item can be taken over. Ask a person to release it.', {
            reason: 'invalid_transition',
          })
        }
        if (latest.detail.issue.revision !== detail.issue.revision) {
          throw new AgentRunError('conflict', 'The Work Item changed during the request. Reload it and retry the take over.')
        }
        const latestSettings = await store.getSettings(principal.directoryId, teamId)
        requireAcceptingNewRuns(latestSettings)
        if (!latestSettings.allowTakeoverAfterLeaseExpiry) throw createAgentRunTakeoverDisabledError()
        if (latestSettings.revision !== settings.revision) {
          throw new AgentRunError('conflict', 'Agent settings changed during the request. Retry the take over.')
        }
        if (await hasAuthorizationChanged(current, authorizationSnapshot)) throw createWorkItemAuthorizationChangedError()
        throw error
      }
      return response
    },

    /** Rechecks permissions before a resume receipt replays. */
    async authorizeResume(credential, teamId, workItemId) {
      const principal = await resolveWriter(credential, teamId)
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
    },

    /**
     * Starts a new run of the assignee on a started Work Item that no run claims, linked to the Work
     * Item's newest earlier run. The Work Item itself does not change.
     */
    async resume(credential, teamId, workItemId, input, context, idempotency) {
      // Like a start, the resume commits only while the member, Team, and Project access it was
      // authorized with is unchanged.
      const authorization = await resolveStableWorkItemAuthorization(
        credential.workspaceId,
        async () => await resolveWriter(credential, teamId),
        async (principal) => (await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')).detail,
      )
      const { principal, authorizationSnapshot } = authorization
      const detail = authorization.value
      const store = workItemDependencies.agentRuns
      const settings = await store.getSettings(principal.directoryId, teamId)
      requireAcceptingNewRuns(settings)
      requireResumable(principal, detail.issue, input.expectedRevision, settings.resumableStatusIds)
      // A run that finished just after its claim was read has released the claim, so that is not a conflict.
      const holder = await readClaimedRun(principal, teamId, workItemId)
      if (holder) throw createAgentRunConflictError(describeHoldingRun(holder, new Date()), '/instanceId')
      // The newest run is read strongly, and the resume commits only while it is still the newest, so the
      // link names the run that really came last. A Work Item whose runs all predate that record falls back
      // to the history index, which is settled for runs that old.
      const latestRunId = await store.getLatestRunId(principal.directoryId, teamId, workItemId)
      const previous = latestRunId === undefined
        ? (await store.listWorkItemRuns(principal.directoryId, teamId, workItemId, undefined, 1)).runs[0]
        : await store.getRun(principal.directoryId, teamId, latestRunId)
      if (latestRunId !== undefined && previous?.workItemId !== workItemId) throw createAgentRunIntegrityError()
      if (previous?.state === 'active') throw createAgentRunConflictError(describeHoldingRun(previous, new Date()), '/instanceId')
      if (input.expectedPreviousRunId !== undefined && previous?.runId !== input.expectedPreviousRunId) {
        // The agent chose to resume after a particular run, such as a paused one it was offered; a run that
        // came after it may have ended in a way that needs a person, so the agent must look again.
        throw new AgentRunError('conflict', 'Another run came after the run you expected to resume from. Reload the task and its runs before resuming.')
      }
      const now = new Date()
      const created = createActiveAgentRun({
        directoryId: principal.directoryId,
        teamId,
        workItemId,
        assigneeUserId: principal.userKey,
        start: input,
        credentialId: credential.credentialId,
        startRevision: detail.issue.revision,
        leaseMinutes: settings.leaseMinutes,
        now,
        ...(previous === undefined ? {} : { resumedFromRunId: previous.runId }),
      })
      // The new run starts after the run it resumes, so the history, ordered by start time, lists it first.
      const run = { ...created, startedAt: resumeStartedAt(previous, now) }
      const path = `/api/v1/work-items/${encodeURIComponent(workItemId)}/agent-runs/resume`
      const auditContext = createMutationAuditContext({
        workspaceId: principal.directoryId,
        actor: { id: principal.actorId, kind: 'user', displayName: principal.userKey },
        idempotencyKey: context.idempotencyKey,
        ...(context.correlationId ? { correlationId: context.correlationId } : {}),
        // The instance ID is a bearer-like secret of the agent; only its runtime and name are audited.
        request: {
          method: 'POST',
          path,
          query: { teamId },
          body: { expectedRevision: input.expectedRevision, runtime: input.runtime, agentName: input.agentName },
        },
        source: { kind: 'api', requestId: context.requestId, method: 'POST', route: path },
      })
      const response: ResumeAgentRunResponse = {
        run: toAgentRun(run, now),
        ...(previous === undefined ? {} : { resumedFromRun: toAgentRun(previous, now) }),
      }
      const auditPut = createAgentRunAuditPut(
        auditContext,
        run,
        'resumed',
        previous === undefined
          ? 'Agent Run resumed a started Work Item that had no earlier run.'
          : `Agent Run resumed after run ${previous.runId} finished as ${previous.outcome ?? 'unknown'}.`,
      )
      const receipt = await createWorkItemIdempotencyTransaction(principal.directoryId, idempotency)
        ?.prepare({ status: 201, body: response })
      const startItems = store.createStartItems(run, { runId: latestRunId })
      try {
        await store.commit([
          ...startItems,
          // The resume was authorized against this status, assignment, and these settings.
          createWorkItemRevisionConditionCheck(getTeamIssuesTableName(), principal.directoryId, teamId, workItemId, detail.issue.revision),
          store.createSettingsRevisionCheck(principal.directoryId, teamId, settings.revision),
          // The caller's membership and Team and Project access must not have changed since authorization.
          ...createAuthorizationSnapshotConditionChecks(authorizationSnapshot),
          ...(auditPut ? [auditPut] : []),
          ...(receipt ? [receipt.transactWriteItem] : []),
        ], 2)
      } catch (error) {
        if (!(error instanceof AgentRunError)) throw error
        if (error.reason === 'agent_run_not_active') {
          // The claim put failed: another start, resume, or take over claimed the Work Item first.
          // A holder that finished meanwhile leaves no claim; that is reported as a change to reload.
          const holder = await readClaimedRun(principal, teamId, workItemId)
          if (holder) throw createAgentRunConflictError(describeHoldingRun(holder, new Date()), '/instanceId')
          throw new AgentRunError('conflict', 'The Agent Run claim changed during the request. Reload the task and retry.')
        }
        if (error.category !== 'temporarily_unavailable') throw error
        // A guard failed: report what changed instead of a retryable failure. Access is resolved again
        // first, so a caller who lost access meanwhile gets the same answer as on a new request.
        const current = await resolveWriter(credential, teamId)
        const latest = await loadAuthorizedTeamIssue(current, teamId, workItemId, 'member')
        const latestSettings = await store.getSettings(principal.directoryId, teamId)
        requireAcceptingNewRuns(latestSettings)
        // A change of assignee, status, or revision is reported as such.
        requireResumable(principal, latest.detail.issue, detail.issue.revision, latestSettings.resumableStatusIds)
        if (latestSettings.revision !== settings.revision) {
          throw new AgentRunError('conflict', 'Agent settings changed during the request. Retry the resume.')
        }
        if (await store.getLatestRunId(principal.directoryId, teamId, workItemId) !== latestRunId) {
          throw new AgentRunError('conflict', 'Another run started on the Work Item during the request. Reload the task and retry.')
        }
        if (await hasAuthorizationChanged(current, authorizationSnapshot)) throw createWorkItemAuthorizationChangedError()
        throw error
      }
      return response
    },

    /** Reads the run-governing Agent settings for a Team the caller can see. */
    async getSettings(credential, teamId) {
      const principal = await resolveReader(credential, teamId)
      await requireTeamPermission(principal, teamId, 'viewer')
      const settings = await workItemDependencies.agentRuns.getSettings(principal.directoryId, teamId)
      return {
        schemaVersion: settings.schemaVersion,
        teamId: settings.teamId,
        revision: settings.revision,
        leaseMinutes: settings.leaseMinutes,
        allowTakeoverAfterLeaseExpiry: settings.allowTakeoverAfterLeaseExpiry,
        ...(settings.updatedAt === undefined ? {} : { updatedAt: settings.updatedAt }),
        ...(settings.updatedBy === undefined ? {} : { updatedBy: settings.updatedBy }),
      }
    },

    /** Reads the Ready statuses and briefs for a Team the caller can see, keeping only visible Project briefs. */
    async getContext(credential, teamId) {
      const principal = await resolveReader(credential, teamId)
      const permission = await requireTeamPermission(principal, teamId, 'viewer')
      const settings = withVisibleProjectBriefs(
        principal, permission, await workItemDependencies.agentRuns.getSettings(principal.directoryId, teamId),
      )
      return {
        schemaVersion: settings.schemaVersion,
        teamId: settings.teamId,
        revision: settings.revision,
        acceptNewRuns: settings.acceptNewRuns,
        readyStatusIds: settings.readyStatusIds,
        resumableStatusIds: settings.resumableStatusIds,
        requireAcceptanceCriteria: settings.requireAcceptanceCriteria,
        ...(settings.acceptanceCriteriaFieldId === undefined ? {} : { acceptanceCriteriaFieldId: settings.acceptanceCriteriaFieldId }),
        ...(settings.brief === undefined ? {} : { brief: settings.brief }),
        projectBriefs: settings.projectBriefs,
      }
    },
  }
}
